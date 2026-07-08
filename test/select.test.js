import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, f64, bool, WasmEmitError } from "../src/index.js";

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("select as branchless max/min", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("max").body((a, b, $) => {
    $.return(s32.select(s32.gt(a, b), a, b));
  });
  mod.function([u32, u32], [u32]).export("umin").body((a, b, $) => {
    $.return(u32.select(u32.lt(a, b), a, b));
  });
  mod.function([f64, f64], [f64]).export("fmax").body((a, b, $) => {
    $.return(f64.select(f64.gt(a, b), a, b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.max(3, 7), 7);
  assert.equal(exports.max(-1, -9), -1);
  assert.equal(exports.umin(-1, 1), 1); // 0xFFFFFFFF is huge unsigned
  assert.equal(exports.fmax(2.5, 1.5), 2.5);
});

test("select works on s64 with a bool-typed condition parameter", async () => {
  const mod = new Module();
  mod.function([bool, s64, s64], [s64]).export("pick").body((c, a, b, $) => {
    $.return(s64.select(c, a, b)); // c is a bool param
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.pick(1, 10n, 20n), 10n);
  assert.equal(exports.pick(0, 10n, 20n), 20n);
});

test("select evaluates BOTH arms (not short-circuiting)", async () => {
  const mod = new Module();
  const probeA = mod.function([], [s32]).import("env", "a");
  const probeB = mod.function([], [s32]).import("env", "b");
  mod.function([s32], [s32]).export("f").body((c, $) => {
    $.return(s32.select(bool.of(c), probeA.call(), probeB.call()));
  });
  const calls = [];
  const { exports } = await instantiate(mod, {
    env: { a: () => (calls.push("a"), 1), b: () => (calls.push("b"), 2) },
  });
  assert.equal(exports.f(1), 1);
  assert.deepEqual(calls, ["a", "b"]); // both ran, in operand order
});

test("select arms must match the namespace; condition must be bool", () => {
  const mod = new Module();
  mod.function([s32, u32], []).body((a, b, $) => {
    throws(() => s32.select(s32.eqz(a), a, b), /second arm: expected s32, got u32/);
    throws(() => f64.select(s32.eqz(a), a, a), /first arm: expected f64, got s32/);
    throws(() => s32.select(a, a, a), /condition: expected bool.*got s32/);
  });
});
