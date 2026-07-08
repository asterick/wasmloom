import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, f32, f64 } from "../src/index.js";

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("empty module emits and instantiates", async () => {
  const mod = new Module();
  const instance = await instantiate(mod);
  assert.ok(instance);
});

test("add function end-to-end", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("add").body((a, b, $) => {
    $.return(s32.add(a, b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.add(2, 3), 5);
  assert.equal(exports.add(-1, 1), 0);
});

test("all four value types round-trip", async () => {
  const mod = new Module();
  mod.function([s64, s64], [s64]).export("mul64").body((a, b, $) => {
    $.return(s64.mul(a, b));
  });
  mod.function([f32, f32], [f32]).export("addf").body((a, b, $) => {
    $.return(f32.add(a, b));
  });
  mod.function([f64], [f64]).export("sqrt").body((x, $) => {
    $.return(f64.sqrt(x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.mul64(3000000000n, 4n), 12000000000n);
  assert.equal(exports.addf(1.5, 2.25), 3.75);
  assert.equal(exports.sqrt(9), 3);
});

test("constants including edge values", async () => {
  const mod = new Module();
  mod.function([], [u32]).export("umax").body(($) => {
    $.return(u32.const(0xffffffff));
  });
  mod.function([], [s64]).export("big").body(($) => {
    $.return(s64.const(2n ** 63n - 1n));
  });
  mod.function([], [f64]).export("pi").body(($) => {
    $.return(f64.const(Math.PI));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.umax(), -1); // u32 max reads back signed at the JS boundary
  assert.equal(exports.big(), 2n ** 63n - 1n);
  assert.equal(exports.pi(), Math.PI);
});

test("conversions", async () => {
  const mod = new Module();
  mod.function([f64], [s32]).export("sat").body((x, $) => {
    $.return(s32.trunc_sat(x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sat(3.7), 3);
  assert.equal(exports.sat(NaN), 0);
  assert.equal(exports.sat(1e300), 2147483647);
});

test("parameters are mutable variables", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("inc").body((n, $) => {
    n.set(s32.add(n, s32.const(1)));
    $.return(n);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.inc(41), 42);
});
