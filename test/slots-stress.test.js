import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, s64, f64 } from "../src/index.js";

// Slot allocation must never share a slot between overlapping live ranges —
// these tests compute values that a wrong-sharing bug would corrupt.

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("loop-carried variables must not share slots (fibonacci)", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("fib").body((n, $) => {
    const a = $.variable(s32, 0);
    const b = $.variable(s32, 1);
    const t = $.variable(s32);
    $.while(s32.gt(n, s32.const(0)), ($) => {
      t.set(s32.add(a, b));
      a.set(b);
      b.set(t);
      n.set(s32.sub(n, s32.const(1)));
    });
    $.return(a);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.fib(10), 55);
  assert.equal(exports.fib(30), 832040);
});

test("staggered overlapping lifetimes match a JS reference", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("f").body((a, b, $) => {
    const t1 = $.variable(s32);
    t1.set(s32.mul(a, b));
    const t2 = $.variable(s32);
    t2.set(s32.add(a, t1));
    const t3 = $.variable(s32);
    t3.set(s32.sub(t1, b)); // t1's last use
    const t4 = $.variable(s32);
    t4.set(s32.mul(t2, t3));
    $.return(s32.add(t4, t2));
  });
  const ref = (a, b) => {
    const t1 = Math.imul(a, b);
    const t2 = (a + t1) | 0;
    const t3 = (t1 - b) | 0;
    const t4 = Math.imul(t2, t3);
    return (t4 + t2) | 0;
  };
  const { exports } = await instantiate(mod);
  for (const [a, b] of [[3, 4], [-7, 11], [12345, -678], [0x7fffffff, 3]]) {
    assert.equal(exports.f(a, b), ref(a, b), `f(${a}, ${b})`);
  }
});

test("params survive temp-heavy bodies", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("f").body((a, b, $) => {
    // Plenty of temp pressure that must not clobber the params.
    const junk = $.variable(s32);
    for (let i = 1; i <= 8; i++) {
      const v = $.variable(s32, i);
      junk.set(s32.add(junk, s32.mul(v, v)));
    }
    $.drop(junk);
    $.return(s32.sub(a, b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(100, 42), 58);
});

test("mixed-type pools allocate independently", async () => {
  const mod = new Module();
  mod.function([s32], [s64]).export("f").body((n, $) => {
    const ci = $.variable(s32);
    const acc64 = $.variable(s64);
    const accf = $.variable(f64);
    $.while(s32.lt(ci, n), ($) => {
      acc64.set(s64.add(acc64, s64.extend(ci)));
      accf.set(f64.add(accf, f64.const(0.5)));
      ci.set(s32.add(ci, s32.const(1)));
    });
    // fold the f64 accumulator in so it can't be dead-coded away
    $.return(s64.add(acc64, s64.trunc_sat(accf)));
  });
  const { exports } = await instantiate(mod);
  // sum 0..9 = 45, plus trunc(10 * 0.5) = 5
  assert.equal(exports.f(10), 50n);
});

test("200 simultaneously-live locals (multi-byte local indices)", async () => {
  const COUNT = 200;
  const mod = new Module();
  mod.function([], [s32]).export("sum").body(($) => {
    const vars = [];
    for (let i = 0; i < COUNT; i++) vars.push($.variable(s32, i * 3));
    const acc = $.variable(s32);
    for (const v of vars) acc.set(s32.add(acc, v));
    $.return(acc);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sum(), (3 * COUNT * (COUNT - 1)) / 2);
});
