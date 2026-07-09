import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, bool } from "../src/index.js";

// Emit-time regression canaries. Not benchmarks — the bounds are ~10× a
// developer machine so CI never flakes; what they catch is an accidental
// O(n²) (or worse) slipping into the pipeline. If one trips, something
// real happened — the deep case sat at 10.5s (quadratic liveness) the day
// this file was written.

function ms(fn) {
  const t0 = process.hrtime.bigint();
  const result = fn();
  return { result, took: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test("wide module: thousands of small functions emit in linear-ish time", () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 });
  const fns = [];
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const prev = fns[i - 1];
    fns.push(mod.function([s32, s32], [s32]).body((a, b, $) => {
      const t = $.variable(s32, s32.add(s32.mul(a, s32.const((i % 7) + 1)), b));
      $.if(s32.gt(t, s32.const(1000)), ($) => {
        s32.store(mem, s32.const((i % 64) * 4), t);
        $.return(s32.load(mem, s32.const((i % 64) * 4)));
      });
      if (prev) $.return(prev.call(t, a));
      $.return(t);
    }));
  }
  fns[N - 1].export("run");

  const { result: bytes, took } = ms(() => mod.emit());
  assert.ok(WebAssembly.validate(bytes), "wide module failed validation");
  assert.ok(took < 5_000, `emitting ${N} functions took ${took.toFixed(0)}ms (canary: 5s)`);
  console.log(`wide: ${N} functions, ${(bytes.length / 1024).toFixed(0)} KiB, emit ${took.toFixed(0)}ms`);
});

test("deep function: thousands of blocks and hundreds of locals emit in bounded time", () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const vars = Array.from({ length: 300 }, (_, i) => $.variable(s32, i));
    // ~2500 sequential conditionals -> thousands of CFG blocks through
    // dominators, liveness, slot coloring, and the relooper
    for (let i = 0; i < 2500; i++) {
      const v = vars[i % vars.length];
      $.if(bool.of(s32.and(x, s32.const(1 << (i % 31)))), ($) => {
        v.set(s32.add(v, s32.const(i % 100)));
      });
    }
    // and a loop nest reading them back
    const sum = $.variable(s32);
    const i = $.variable(u32);
    $.while(u32.lt(i, u32.const(300)), ($) => {
      sum.set(s32.add(sum, vars[0]));
      i.set(u32.add(i, u32.const(1)));
    });
    $.return(sum);
  });

  const { result: bytes, took } = ms(() => mod.emit());
  assert.ok(WebAssembly.validate(bytes), "deep module failed validation");
  assert.ok(took < 5_000, `deep function took ${took.toFixed(0)}ms to emit (canary: 5s)`);
  console.log(`deep: ${(bytes.length / 1024).toFixed(0)} KiB, emit ${took.toFixed(0)}ms`);
});
