import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, bool, WasmEmitError } from "../src/index.js";

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("logical combinators", async () => {
  const mod = new Module();
  mod.function([s32, s32, s32], [bool]).export("between").body((lo, x, hi, $) => {
    $.return(bool.and(s32.le(lo, x), s32.le(x, hi)));
  });
  mod.function([s32], [bool]).export("outside").body((x, $) => {
    $.return(bool.or(s32.lt(x, s32.const(0)), s32.gt(x, s32.const(100))));
  });
  mod.function([s32, s32], [bool]).export("differs").body((a, b, $) => {
    $.return(bool.xor(s32.lt(a, b), s32.lt(b, a)));
  });
  mod.function([s32], [bool]).export("isZero").body((x, $) => {
    $.return(bool.not(bool.of(x)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.between(0, 5, 10), 1);
  assert.equal(exports.between(0, 50, 10), 0);
  assert.equal(exports.outside(-1), 1);
  assert.equal(exports.outside(50), 0);
  assert.equal(exports.differs(1, 2), 1);
  assert.equal(exports.differs(2, 2), 0);
  assert.equal(exports.isZero(0), 1);
  assert.equal(exports.isZero(7), 0);
});

test("bool.of tests all integer widths", async () => {
  const mod = new Module();
  mod.function([s32], [bool]).export("t32").body((x, $) => $.return(bool.of(x)));
  mod.function([s64], [bool]).export("t64").body((x, $) => $.return(bool.of(x)));
  const { exports } = await instantiate(mod);
  assert.equal(exports.t32(0), 0);
  assert.equal(exports.t32(-5), 1);
  assert.equal(exports.t64(0n), 0);
  assert.equal(exports.t64(1n << 40n), 1);
});

test("bool variables, params, and constants", async () => {
  const mod = new Module();
  const armed = mod.variable(bool).export("armed"); // defaults false
  mod.function([bool], [bool]).export("toggle").body((v, $) => {
    armed.set(bool.xor(armed, v));
    $.return(armed);
  });
  mod.function([], [bool]).export("truth").body(($) => $.return(bool.const(true)));
  const { exports } = await instantiate(mod);
  assert.equal(exports.armed.value, 0);
  assert.equal(exports.truth(), 1);
  assert.equal(exports.toggle(1), 1);
  assert.equal(exports.toggle(1), 0);
});

test("bool.select and bool as a select arm type", async () => {
  const mod = new Module();
  mod.function([s32, s32], [bool]).export("f").body((a, b, $) => {
    // pick between two bools, branchlessly
    $.return(bool.select(s32.lt(a, b), s32.eqz(a), s32.eqz(b)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(0, 1), 1); // a<b → eqz(a) → true
  assert.equal(exports.f(5, 1), 0); // !(a<b) → eqz(b=1) → false
});

test("bool → integer is a zero-cost cast; there is no int → bool cast", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("count").body((a, b, $) => {
    $.return(s32.add(s32.cast(s32.lt(a, b)), s32.cast(s32.eq(a, b))));
  });
  mod.function([u32], [u32]).export("flag").body((x, $) => {
    $.return(u32.cast(bool.of(x)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.count(1, 2), 1);
  assert.equal(exports.count(2, 2), 1);
  assert.equal(exports.count(3, 2), 0);
  assert.equal(exports.flag(123), 1);
});

test("the bool barrier is strict", () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 });
  mod.function([s32, bool], []).body((x, flag, $) => {
    throws(() => s32.add(x, flag), /expected s32, got bool/); // bool is not an integer
    throws(() => bool.and(flag, x), /expected bool, got s32/); // ints are not bools
    throws(() => bool.of(flag), /expected an integer.*got bool/); // already a bool
    throws(() => s32.load(mem, flag), /expected a 32-bit integer.*got bool/); // not an address
    throws(() => bool.const(1), /expected true or false/);
    assert.equal(typeof bool.cast, "undefined"); // no int → bool cast exists
  });
});
