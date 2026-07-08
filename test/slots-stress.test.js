import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, i32, i64, f64 } from "../src/index.js";

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
  mod.function([i32], [i32]).export("fib").body((n, $) => {
    const a = $.variable(i32, 0);
    const b = $.variable(i32, 1);
    const t = $.variable(i32);
    $.while(i32.gt_s(n, i32.const(0)), ($) => {
      t.set(i32.add(a, b));
      a.set(b);
      b.set(t);
      n.set(i32.sub(n, i32.const(1)));
    });
    $.return(a);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.fib(10), 55);
  assert.equal(exports.fib(30), 832040);
});

test("staggered overlapping lifetimes match a JS reference", async () => {
  const mod = new Module();
  mod.function([i32, i32], [i32]).export("f").body((a, b, $) => {
    const t1 = $.variable(i32);
    t1.set(i32.mul(a, b));
    const t2 = $.variable(i32);
    t2.set(i32.add(a, t1));
    const t3 = $.variable(i32);
    t3.set(i32.sub(t1, b)); // t1's last use
    const t4 = $.variable(i32);
    t4.set(i32.mul(t2, t3));
    $.return(i32.add(t4, t2));
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
  mod.function([i32, i32], [i32]).export("f").body((a, b, $) => {
    // Plenty of temp pressure that must not clobber the params.
    const junk = $.variable(i32);
    for (let i = 1; i <= 8; i++) {
      const v = $.variable(i32, i);
      junk.set(i32.add(junk, i32.mul(v, v)));
    }
    $.drop(junk);
    $.return(i32.sub(a, b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(100, 42), 58);
});

test("mixed-type pools allocate independently", async () => {
  const mod = new Module();
  mod.function([i32], [i64]).export("f").body((n, $) => {
    const ci = $.variable(i32);
    const acc64 = $.variable(i64);
    const accf = $.variable(f64);
    $.while(i32.lt_s(ci, n), ($) => {
      acc64.set(i64.add(acc64, i64.extend_i32_s(ci)));
      accf.set(f64.add(accf, f64.const(0.5)));
      ci.set(i32.add(ci, i32.const(1)));
    });
    // fold the f64 accumulator in so it can't be dead-coded away
    $.return(i64.add(acc64, i64.trunc_sat_f64_s(accf)));
  });
  const { exports } = await instantiate(mod);
  // sum 0..9 = 45, plus trunc(10 * 0.5) = 5
  assert.equal(exports.f(10), 50n);
});

test("200 simultaneously-live locals (multi-byte local indices)", async () => {
  const COUNT = 200;
  const mod = new Module();
  mod.function([], [i32]).export("sum").body(($) => {
    const vars = [];
    for (let i = 0; i < COUNT; i++) vars.push($.variable(i32, i * 3));
    const acc = $.variable(i32);
    for (const v of vars) acc.set(i32.add(acc, v));
    $.return(acc);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sum(), (3 * COUNT * (COUNT - 1)) / 2);
});
