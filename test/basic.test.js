import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, i32, i64, f32, f64 } from "../src/index.js";

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
  mod.function([i32, i32], [i32]).export("add").body((a, b, $) => {
    $.return(i32.add(a, b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.add(2, 3), 5);
  assert.equal(exports.add(-1, 1), 0);
});

test("all four value types round-trip", async () => {
  const mod = new Module();
  mod.function([i64, i64], [i64]).export("mul64").body((a, b, $) => {
    $.return(i64.mul(a, b));
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
  mod.function([], [i32]).export("umax").body(($) => {
    $.return(i32.const(0xffffffff));
  });
  mod.function([], [i64]).export("big").body(($) => {
    $.return(i64.const(2n ** 63n - 1n));
  });
  mod.function([], [f64]).export("pi").body(($) => {
    $.return(f64.const(Math.PI));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.umax(), -1); // 0xFFFFFFFF as signed i32
  assert.equal(exports.big(), 2n ** 63n - 1n);
  assert.equal(exports.pi(), Math.PI);
});

test("conversions", async () => {
  const mod = new Module();
  mod.function([f64], [i32]).export("sat").body((x, $) => {
    $.return(i32.trunc_sat_f64_s(x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sat(3.7), 3);
  assert.equal(exports.sat(NaN), 0);
  assert.equal(exports.sat(1e300), 2147483647);
});

test("parameters are mutable variables", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("inc").body((n, $) => {
    n.set(i32.add(n, i32.const(1)));
    $.return(n);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.inc(41), 42);
});
