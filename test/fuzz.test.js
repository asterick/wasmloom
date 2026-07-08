import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, bool } from "../src/index.js";

// Differential fuzzing of the relooper/liveness pipeline: generate random
// label/goto/branch/switch programs, run them through a trivial JS
// interpreter of the same CFG, and compare against the compiled wasm.
// Irreducible programs are lowered by the reduce pass, so every seed runs.

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

function genProgram(rand) {
  const n = 3 + randInt(rand, 6);
  const blocks = [];
  for (let i = 0; i < n; i++) {
    let term;
    const r = randInt(rand, 10);
    if (r < 3) term = { kind: "jump", to: randInt(rand, n) };
    else if (r < 7) term = { kind: "branch", t: randInt(rand, n), f: randInt(rand, n) };
    else if (r < 9) {
      const count = 2 + randInt(rand, 2);
      term = { kind: "switch", targets: Array.from({ length: count }, () => randInt(rand, n)) };
    } else term = { kind: "return" };
    blocks.push({ mul: 1 + randInt(rand, 7), add: randInt(rand, 100), term });
  }
  return blocks;
}

function interpret(blocks, x) {
  x |= 0;
  let steps = 0;
  let i = 0;
  for (;;) {
    const blk = blocks[i];
    x = (Math.imul(x, blk.mul) + blk.add) | 0;
    if (++steps > 200) return x;
    const t = blk.term;
    if (t.kind === "jump") i = t.to;
    else if (t.kind === "branch") i = (x & 1) !== 0 ? t.t : t.f;
    else if (t.kind === "switch") i = t.targets[(x >>> 0) % t.targets.length];
    else return x;
  }
}

function build(blocks) {
  const mod = new Module();
  mod.function([s32], [s32]).export("run").body((x, $) => {
    const steps = $.variable(s32);
    const labels = blocks.map(() => $.label.ahead());
    const exit = $.label.ahead();
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      labels[i].here();
      x.set(s32.add(s32.mul(x, s32.const(blk.mul)), s32.const(blk.add)));
      steps.set(s32.add(steps, s32.const(1)));
      $.gotoIf(s32.gt(steps, s32.const(200)), exit);
      const t = blk.term;
      if (t.kind === "jump") $.goto(labels[t.to]);
      else if (t.kind === "branch") {
        $.gotoIf(bool.of(s32.and(x, s32.const(1))), labels[t.t]);
        $.goto(labels[t.f]);
      } else if (t.kind === "switch") {
        $.switch(
          u32.rem(u32.cast(x), u32.const(t.targets.length)),
          t.targets.map((j) => labels[j]),
          labels[t.targets[0]], // unsigned rem keeps the index in range; default is unreachable
        );
      } else $.return(x);
    }
    exit.here();
    $.return(x);
  });
  return mod;
}

test("random CFGs: compiled wasm matches a reference interpreter", async () => {
  const INPUTS = [0, 1, 7, -3, 12345, 999999];
  for (let seed = 1; seed <= 60; seed++) {
    const blocks = genProgram(mulberry32(seed * 0x9e3779b9));
    let bytes;
    try {
      bytes = build(blocks).emit();
    } catch (e) {
      e.message = `seed ${seed}: ${e.message}`;
      throw e;
    }
    assert.ok(WebAssembly.validate(bytes), `seed ${seed}: emitted module failed validation`);
    const { instance } = await WebAssembly.instantiate(bytes);
    for (const input of INPUTS) {
      assert.equal(
        instance.exports.run(input),
        interpret(blocks, input),
        `seed ${seed}, input ${input}`,
      );
    }
  }
});
