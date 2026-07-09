import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, funcref } from "../src/index.js";

// Differential fuzzing ACROSS functions: random call graphs composing direct
// calls, call_indirect through a funcref table, call_ref through a typed
// table, multi-value calls with spilled destructuring, tail and non-tail
// return positions, and mutable globals — compared against a plain JS
// interpreter of the same program. Recursion is bounded by a fuel global
// (mirrored on both sides), so every program terminates by construction.

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rand, n) => Math.floor(rand() * n);

// Modes: how a main function continues after its local arithmetic.
const NONE = 0, DIRECT = 1, INDIRECT = 2, REF = 3, PAIR = 4;

function genProgram(rand) {
  const n = 3 + randInt(rand, 4); // main functions, sig (s32,s32)->s32
  const pairs = 2;                // pair functions, sig (s32,s32)->(s32,s32)
  const fns = Array.from({ length: n }, (_, i) => ({
    mul: 1 + randInt(rand, 7),
    add: randInt(rand, 100),
    xor: randInt(rand, 256),
    mode: randInt(rand, 5),
    callee: randInt(rand, n),
    pair: randInt(rand, pairs),
    tail: randInt(rand, 2) === 0,
    comb: randInt(rand, 50),
    i,
  }));
  const pairFns = Array.from({ length: pairs }, (_, j) => ({
    add: randInt(rand, 100),
    tail: randInt(rand, 2) === 0,
    other: randInt(rand, pairs),
    j,
  }));
  return { n, fns, pairFns };
}

function build({ n, fns, pairFns }) {
  const mod = new Module();
  const sig = mod.funcType([s32, s32], [s32]);
  const fuel = mod.variable(s32).export("fuel");
  const acc = mod.variable(s32).export("acc");

  const mains = fns.map(() => mod.function(sig));
  const pairHs = pairFns.map(() => mod.function([s32, s32], [s32, s32]));
  const tbl = mod.table(funcref, { min: n });
  const vt = mod.table(sig.refNull, { min: n });
  mod.elem(mains).at(tbl, 0);
  mod.elem(mains).at(vt, 0);

  fns.forEach((f, i) => {
    mains[i].export(`f${i}`).body((a, b, $) => {
      const t = $.variable(s32, s32.add(s32.mul(a, s32.const(f.mul)), s32.add(b, s32.const(f.add))));
      $.if(s32.le(fuel, s32.const(0)), ($) => $.return(s32.xor(t, s32.const(f.i))));
      fuel.set(s32.sub(fuel, s32.const(1)));

      const args = () => [s32.sub(t, b), s32.xor(a, s32.const(f.xor))];
      const finish = (callExpr) => {
        if (f.tail) {
          $.return(callExpr()); // tail position: return_call / _indirect / _ref
        } else {
          acc.set(s32.add(acc, t)); // an effect the call must not reorder past
          $.return(s32.add(callExpr(), s32.const(f.comb)));
        }
      };

      switch (f.mode) {
        case NONE:
          $.return(t);
          break;
        case DIRECT:
          finish(() => mains[f.callee].call(...args()));
          break;
        case INDIRECT:
          finish(() => tbl.call(sig, u32.rem(u32.cast(t), u32.const(n)), ...args()));
          break;
        case REF:
          finish(() => sig.call(vt.get(u32.rem(u32.cast(s32.shr(t, s32.const(1))), u32.const(n))), ...args()));
          break;
        case PAIR: {
          const [x, y] = pairHs[f.pair].call(...args()); // spilled destructuring
          acc.set(s32.xor(acc, x));
          $.return(s32.add(x, s32.mul(y, s32.const(3))));
          break;
        }
      }
    });
  });

  pairFns.forEach((p, j) => {
    pairHs[j].body((a, b, $) => {
      $.if(s32.le(fuel, s32.const(0)), ($) => {
        $.return(s32.xor(a, s32.const(p.j)), s32.add(b, s32.const(p.add)));
      });
      fuel.set(s32.sub(fuel, s32.const(1)));
      if (p.tail) {
        $.return(...pairHs[p.other].call(b, a)); // multi-value tail call
      } else {
        const [x, y] = pairHs[p.other].call(b, a);
        $.return(s32.add(x, s32.const(1)), y);
      }
    });
  });

  return mod;
}

/** The same program in plain JavaScript. State (fuel/acc) lives in `st`. */
function makeInterp({ n, fns, pairFns }, st) {
  function main(i, a, b) {
    a |= 0; b |= 0;
    const f = fns[i];
    const t = (Math.imul(a, f.mul) + ((b + f.add) | 0)) | 0;
    if (st.fuel <= 0) return (t ^ f.i) | 0;
    st.fuel = (st.fuel - 1) | 0;
    const args = [(t - b) | 0, (a ^ f.xor) | 0];
    const run = {
      [DIRECT]: () => main(f.callee, ...args),
      [INDIRECT]: () => main((t >>> 0) % n, ...args),
      [REF]: () => main((((t >> 1) >>> 0) % n) | 0, ...args),
    }[f.mode];
    switch (f.mode) {
      case NONE:
        return t;
      case PAIR: {
        const [x, y] = pair(f.pair, ...args);
        st.acc = (st.acc ^ x) | 0;
        return (x + Math.imul(y, 3)) | 0;
      }
      default:
        if (f.tail) return run();
        st.acc = (st.acc + t) | 0;
        return (run() + f.comb) | 0;
    }
  }
  function pair(j, a, b) {
    a |= 0; b |= 0;
    const p = pairFns[j];
    if (st.fuel <= 0) return [(a ^ p.j) | 0, (b + p.add) | 0];
    st.fuel = (st.fuel - 1) | 0;
    const inner = pair(p.other, b, a);
    if (p.tail) return inner;
    return [(inner[0] + 1) | 0, inner[1]];
  }
  return main;
}

test("random call graphs: wasm matches a reference interpreter", async () => {
  const INPUTS = [[0, 0], [1, 2], [-5, 7], [12345, -99]];
  const FUELS = [0, 3, 64];
  for (let seed = 1; seed <= 30; seed++) {
    const prog = genProgram(mulberry32(seed * 0x9e3779b9));
    let bytes;
    try {
      bytes = build(prog).emit();
    } catch (e) {
      e.message = `seed ${seed}: ${e.message}`;
      throw e;
    }
    assert.ok(WebAssembly.validate(bytes), `seed ${seed}: module failed validation`);
    const { instance } = await WebAssembly.instantiate(bytes);
    for (let entry = 0; entry < prog.n; entry++) {
      for (const [a, b] of INPUTS) {
        for (const startFuel of FUELS) {
          instance.exports.fuel.value = startFuel;
          instance.exports.acc.value = 0;
          const st = { fuel: startFuel, acc: 0 };
          const expected = makeInterp(prog, st)(entry, a, b);
          const actual = instance.exports[`f${entry}`](a, b);
          const label = `seed ${seed} f${entry}(${a},${b}) fuel=${startFuel}`;
          assert.equal(actual, expected, label);
          assert.equal(instance.exports.acc.value, st.acc, `${label}: acc`);
          assert.equal(instance.exports.fuel.value, st.fuel, `${label}: fuel`);
        }
      }
    }
  }
});
