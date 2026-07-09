import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, f32, f64, bool, WasmLoomError } from "../src/index.js";

// Safe value-exact promotion is DEFAULT behavior — the consuming op's
// namespace explicitly names the target, and only lossless lifts exist, so
// nothing here uses any flag.

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmLoomError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("operands lift into the namespace type when exact", async () => {
  const mod = new Module();
  mod.function([f32, s32], [f64]).export("mixed").body((x, n, $) => {
    $.return(f64.add(x, n)); // f32→f64 exact, s32→f64 exact
  });
  mod.function([s64, s32], [s64]).export("sext").body((a, b, $) => {
    $.return(s64.mul(a, b)); // s32 sign-extends in
  });
  mod.function([u64, u32], [u64]).export("zext").body((a, b, $) => {
    $.return(u64.add(a, b)); // u32 zero-extends in
  });
  mod.function([u32], [s64]).export("u2s").body((x, $) => {
    $.return(s64.add(s64.const(0), x)); // u32 fits s64 exactly
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.mixed(0.5, -3), -2.5);
  assert.equal(exports.sext(1n << 40n, -2), -(1n << 41n));
  assert.equal(exports.zext(1n, -1), 4294967296n); // 0xFFFFFFFF zero-extended
  assert.equal(exports.u2s(-1), 4294967295n);
});

test("bool lifts as 0/1 into any numeric namespace", async () => {
  const mod = new Module();
  mod.function([s32, s32], [f64]).export("f").body((a, b, $) => {
    $.return(f64.add(f64.const(0.5), s32.lt(a, b))); // bool → f64
  });
  mod.function([s32, s32], [s32]).export("count").body((a, b, $) => {
    $.return(s32.add(s32.lt(a, b), s32.eq(a, b))); // bool → s32, no casts needed
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(1, 2), 1.5);
  assert.equal(exports.f(2, 1), 0.5);
  assert.equal(exports.count(1, 2), 1);
  assert.equal(exports.count(2, 2), 1);
});

test("return values, call arguments, and .set() lift too", async () => {
  const mod = new Module();
  const g = mod.variable(f64).export("g");
  const helper = mod.function([f64], [f64]).import("env", "h");
  mod.function([s32], [f64]).export("f").body((n, $) => {
    g.set(n); // s32 lifts into an f64 variable
    $.drop(helper.call(n)); // s32 arg lifts to f64 param
    $.return(n); // s32 lifts into the f64 result
  });
  const { exports } = await instantiate(mod, { env: { h: (v) => v } });
  assert.equal(exports.f(21), 21);
  assert.equal(exports.g.value, 21);
});

test("constant initializers promote at build time (still const-exprs)", async () => {
  const mod = new Module();
  mod.variable(f64, f32.const(0.5)).export("a");
  mod.variable(s64, s32.const(-1)).export("b");
  mod.variable(f64, u32.const(0xffffffff)).export("c"); // unsigned value, exactly
  mod.variable(u64, u32.const(0xffffffff)).export("d");
  const { exports } = await instantiate(mod);
  assert.equal(exports.a.value, 0.5);
  assert.equal(exports.b.value, -1n);
  assert.equal(exports.c.value, 4294967295);
  assert.equal(exports.d.value, 4294967295n);
});

test("a multi-use source promoted in two places still evaluates once", async () => {
  const mod = new Module();
  const probe = mod.function([], [s32]).import("env", "probe");
  mod.function([], [f64]).export("f").body(($) => {
    const x = probe.call(); // s32, multi-use
    $.return(f64.add(x, x)); // each use lifts through its own conversion
  });
  let calls = 0;
  const { instance } = await WebAssembly.instantiate(mod.emit(), {
    env: { probe: () => (calls++, 7) },
  });
  assert.equal(instance.exports.f(), 14);
  assert.equal(calls, 1);
});

test("memory value positions and select arms lift", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([s32, s32], [f64]).export("f").body((a, b, $) => {
    f64.store(mem, s32.const(0), s32.lt(a, b)); // bool → f64 store value
    s64.store(mem, s32.const(8), a); // s32 → s64 store value
    $.return(f64.select(s32.lt(a, b), a, f64.const(-1))); // s32 arm lifts
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(1, 2), 1);
  const dv = new DataView(exports.memory.buffer);
  assert.equal(dv.getFloat64(0, true), 1);
  assert.equal(dv.getBigInt64(8, true), 1n);
});

test("only value-exact lifts — everything lossy stays an error", () => {
  const mod = new Module();
  mod.function([s64, u64, f64, s32, u32], []).body((a64, b64, x, n, u, $) => {
    throws(() => f64.add(x, a64), /expected f64, got s64/); // 53-bit mantissa
    throws(() => f64.add(x, b64), /expected f64, got u64/);
    throws(() => f32.add(f32.const(0), n), /expected f32, got s32/); // 24-bit mantissa
    throws(() => u64.add(b64, n), /expected u64, got s32/); // negative values don't fit
    throws(() => s32.add(n, u), /expected s32, got u32/); // not value-exact (that's permissive)
    throws(() => u32.add(u, n), /expected u32, got s32/);
    throws(() => s32.add(n, a64), /expected s32, got s64/); // narrowing
    throws(() => $.if(n, () => {}), /expected bool/); // truthiness is not a promotion
    throws(() => mod.variable(f64, s64.const(1n)), /expected f64, got s64/); // inits too
  });
});
