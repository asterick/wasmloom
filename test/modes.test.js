import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, f32, f64, bool, WasmEmitError } from "../src/index.js";

// The ONLY test file that opts into permissive/promote. Everything else runs
// strict by design — these modes must never become the ambient default.

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

// --- permissive: bit-level leniency -------------------------------------------

test("permissive: integers are accepted as conditions", async () => {
  const mod = new Module({ permissive: true });
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const r = $.variable(s32);
    $.if(x, ($) => r.set(s32.const(1))); // non-zero is true, no bool.of
    $.return(r);
  });
  mod.function([s64], [s32]).export("g").body((x, $) => {
    const steps = $.variable(s32);
    $.while(x, ($) => {
      // 64-bit conditions insert a real ≠0 test
      x.set(s64.sub(x, s64.const(1)));
      steps.set(s32.add(steps, s32.const(1)));
    });
    $.return(steps);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(7), 1);
  assert.equal(exports.f(0), 0);
  assert.equal(exports.g(3n), 3);
});

test("permissive: mixed signedness retypes freely, same width only", async () => {
  const mod = new Module({ permissive: true });
  mod.function([s32, u32], [s32]).export("f").body((a, b, $) => {
    $.return(s32.add(a, b)); // u32 operand retypes into s32.add
  });
  mod.function([s64, u64], [u64]).export("g").body((a, b, $) => {
    $.return(u64.add(a, b));
  });
  mod.function([s64, s32], []).body((a, b, $) => {
    throws(() => s64.add(a, b), /expected s64, got s32/); // cross-width still explicit
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(3, 4), 7);
  assert.equal(exports.g(-1n, 2n), 1n);
});

test("permissive: bool flows into integer ops; integers into bool ops test ≠0", async () => {
  const mod = new Module({ permissive: true });
  mod.function([s32, s32], [s32]).export("count").body((a, b, $) => {
    $.return(s32.add(s32.lt(a, b), s32.eq(a, b))); // bool retypes into add
  });
  mod.function([bool, s32], [bool]).export("both").body((flag, x, $) => {
    // x is TESTED (≠0), not bitwise-anded: both(true, 2) must be 1, not 0
    $.return(bool.and(flag, x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.count(1, 2), 1);
  assert.equal(exports.both(1, 2), 1);
  assert.equal(exports.both(1, 0), 0);
});

test("permissive: select condition takes an integer; addresses take bool", async () => {
  const mod = new Module({ permissive: true });
  const mem = mod.memory({ min: 1 });
  mod.function([s32, s32, s32], [s32]).export("pick").body((c, a, b, $) => {
    $.return(s32.select(c, a, b));
  });
  mod.function([bool], [s32]).export("addr").body((flag, $) => {
    s32.store(mem, flag, s32.const(42)); // bool as address: 0 or 1
    $.return(s32.load(mem, flag));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.pick(9, 1, 2), 1);
  assert.equal(exports.pick(0, 1, 2), 2);
  assert.equal(exports.addr(1), 42);
});

test("permissive: constants and floats stay strict", () => {
  const mod = new Module({ permissive: true });
  mod.function([f64, s32], []).body((x, n, $) => {
    throws(() => s32.const(0xffffffff), /outside/);
    throws(() => bool.const(1), /true or false/);
    throws(() => f64.add(x, n), /expected f64, got s32/); // no float coercion
    throws(() => $.if(x, () => {}), /expected bool/); // floats aren't truthy either
  });
});

// --- promote: value-exact lifting ----------------------------------------------

test("promote: operands lift into the namespace type when exact", async () => {
  const mod = new Module({ promote: true });
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

test("promote: bool lifts as 0/1 into any numeric namespace", async () => {
  const mod = new Module({ promote: true });
  mod.function([s32, s32], [f64]).export("f").body((a, b, $) => {
    $.return(f64.add(f64.const(0.5), s32.lt(a, b))); // bool → f64
  });
  mod.function([s32, s32], [s64]).export("g").body((a, b, $) => {
    $.return(s64.add(s64.const(10n), s32.lt(a, b))); // bool → s64
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(1, 2), 1.5);
  assert.equal(exports.f(2, 1), 0.5);
  assert.equal(exports.g(1, 2), 11n);
});

test("promote: return values and call arguments lift too", async () => {
  const mod = new Module({ promote: true });
  const helper = mod.function([f64], [f64]).import("env", "h");
  mod.function([s32], [f64]).export("f").body((n, $) => {
    $.drop(helper.call(n)); // s32 arg lifts to f64 param
    $.return(n); // s32 lifts into the f64 result
  });
  const { exports } = await instantiate(mod, { env: { h: (v) => v } });
  assert.equal(exports.f(21), 21);
});

test("promote: only value-exact lifts — everything lossy stays an error", () => {
  const mod = new Module({ promote: true });
  mod.function([s64, u64, f64, s32, u32], []).body((a64, b64, x, n, u, $) => {
    throws(() => f64.add(x, a64), /expected f64, got s64/); // 53-bit mantissa
    throws(() => f64.add(x, b64), /expected f64, got u64/);
    throws(() => f32.add(f32.const(0), n), /expected f32, got s32/); // 24-bit mantissa
    throws(() => u64.add(b64, n), /expected u64, got s32/); // negative values don't fit
    throws(() => s32.add(n, u), /expected s32, got u32/); // not value-exact (that's permissive)
    throws(() => u32.add(u, n), /expected u32, got s32/);
    throws(() => s32.add(n, a64), /expected s32, got s64/); // narrowing
    throws(() => $.if(n, () => {}), /expected bool/); // truthiness is permissive's domain
  });
});

test("modes compose; strict remains the default", async () => {
  const both = new Module({ permissive: true, promote: true });
  both.function([s32, u32, f32], [f64]).export("f").body((a, b, x, $) => {
    const mixed = s32.add(a, b); // permissive retype
    $.return(f64.mul(x, mixed)); // promote lift
  });
  const { exports } = await instantiate(both);
  assert.equal(exports.f(2, 3, 1.5), 7.5);

  const strict = new Module();
  strict.function([s32, u32], []).body((a, b, $) => {
    throws(() => s32.add(a, b), /expected s32, got u32/);
    throws(() => $.if(a, () => {}), /expected bool/);
  });
});
