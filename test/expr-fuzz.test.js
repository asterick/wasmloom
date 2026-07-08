import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32 } from "../src/index.js";

// Differential fuzzing of the expression machinery: random s32 expression
// DAGs with shared subexpressions, interleaved with writes to a mutable
// global, compared against a reference interpreter that implements the
// DOCUMENTED evaluation-order rules (single-use inlines at consumption,
// multi-use evaluates at its creation point). Because the programs read and
// write a global between expression creations, any deviation in evaluation
// timing, temp materialization, or slot allocation changes the answer.

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

const OPS = {
  add: (a, b) => (a + b) | 0,
  sub: (a, b) => (a - b) | 0,
  mul: Math.imul,
  and: (a, b) => a & b,
  or: (a, b) => a | b,
  xor: (a, b) => a ^ b,
  shl: (a, b) => (a << (b & 31)) | 0,
};
const OP_NAMES = Object.keys(OPS);

/** A program is pure data, interpreted twice: into the builder and in JS. */
function genProgram(rand) {
  const nodes = []; // { op, a, b } — operand sources
  const steps = []; // { kind: 'node', i } | { kind: 'set', src }
  const src = () => {
    const r = rand();
    if (nodes.length && r < 0.45) return { t: "node", i: randInt(rand, nodes.length) };
    if (r < 0.6) return { t: "g" };
    if (r < 0.75) return { t: rand() < 0.5 ? "p0" : "p1" };
    return { t: "const", v: randInt(rand, 200) - 100 };
  };
  const stepCount = 15 + randInt(rand, 20);
  for (let i = 0; i < stepCount; i++) {
    if (rand() < 0.65 || nodes.length === 0) {
      nodes.push({ op: OP_NAMES[randInt(rand, OP_NAMES.length)], a: src(), b: src() });
      steps.push({ kind: "node", i: nodes.length - 1 });
    } else {
      steps.push({ kind: "set", src: src() });
    }
  }
  return { nodes, steps, fin: { a: src(), b: src() } };
}

function build(prog) {
  const mod = new Module();
  const g = mod.variable(s32).export("g");
  mod.function([s32, s32], [s32]).export("run").body((p0, p1, $) => {
    const made = [];
    const lift = (d) =>
      d.t === "const" ? s32.const(d.v)
      : d.t === "p0" ? p0
      : d.t === "p1" ? p1
      : d.t === "g" ? g
      : made[d.i];
    for (const st of prog.steps) {
      if (st.kind === "node") {
        const n = prog.nodes[st.i];
        made[st.i] = s32[n.op](lift(n.a), lift(n.b));
      } else {
        g.set(lift(st.src));
      }
    }
    $.return(s32.add(s32.add(lift(prog.fin.a), lift(prog.fin.b)), g));
  });
  return mod;
}

/**
 * Live use counts, mirroring the builder: references from transitively-dead
 * nodes don't count (a pure node nothing consumes is dropped entirely).
 */
function liveUses(prog) {
  const live = new Set();
  const visit = (d) => {
    if (d.t === "node" && !live.has(d.i)) {
      live.add(d.i);
      const n = prog.nodes[d.i];
      visit(n.a);
      visit(n.b);
    }
  };
  for (const st of prog.steps) if (st.kind === "set") visit(st.src);
  visit(prog.fin.a);
  visit(prog.fin.b);

  const uses = new Array(prog.nodes.length).fill(0);
  const count = (d) => {
    if (d.t === "node") uses[d.i]++;
  };
  for (const st of prog.steps) if (st.kind === "set") count(st.src);
  prog.nodes.forEach((n, i) => {
    if (live.has(i)) {
      count(n.a);
      count(n.b);
    }
  });
  count(prog.fin.a);
  count(prog.fin.b);
  return uses;
}

/** Reference interpreter for the documented evaluation-order semantics. */
function interpret(prog, x0, x1) {
  const uses = liveUses(prog);
  let g = 0;
  const captured = [];
  const evalSrc = (d) =>
    d.t === "const" ? d.v | 0
    : d.t === "p0" ? x0 | 0
    : d.t === "p1" ? x1 | 0
    : d.t === "g" ? g
    : evalNode(d.i);
  const evalNode = (i) => (uses[i] > 1 ? captured[i] : compute(i));
  const compute = (i) => {
    const n = prog.nodes[i];
    const a = evalSrc(n.a);
    const b = evalSrc(n.b);
    return OPS[n.op](a, b);
  };
  for (const st of prog.steps) {
    if (st.kind === "node") {
      // multi-use evaluates at its creation point
      if (uses[st.i] > 1) captured[st.i] = compute(st.i);
    } else {
      g = evalSrc(st.src);
    }
  }
  const fa = evalSrc(prog.fin.a);
  const fb = evalSrc(prog.fin.b);
  const result = (((fa + fb) | 0) + g) | 0;
  return { result, g };
}

test("random expression DAGs: builder semantics match the reference", async () => {
  const INPUTS = [[0, 0], [1, 2], [-5, 7], [123456, -789]];
  for (let seed = 1; seed <= 50; seed++) {
    const prog = genProgram(mulberry32(seed * 0x85ebca6b));
    const bytes = build(prog).emit();
    assert.ok(WebAssembly.validate(bytes), `seed ${seed}: validation failed`);
    const { instance } = await WebAssembly.instantiate(bytes);
    for (const [x0, x1] of INPUTS) {
      instance.exports.g.value = 0;
      const expected = interpret(prog, x0, x1);
      const actual = instance.exports.run(x0, x1);
      assert.equal(actual, expected.result, `seed ${seed}, inputs (${x0}, ${x1}): result`);
      assert.equal(instance.exports.g.value, expected.g, `seed ${seed}, inputs (${x0}, ${x1}): final g`);
    }
  }
});
