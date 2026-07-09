import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, funcref, WasmEmitError } from "../src/index.js";

// Extended constant expressions (wasm 3.0): add/sub/mul on the integer
// namespaces, built OUTSIDE a body, compose into module-variable inits and
// data/element offsets. Inside a body the same constructors stay runtime ops.

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("global init arithmetic over an imported base", async () => {
  const mod = new Module();
  const base = mod.variable(s32).import("env", "base").immutable();
  mod.variable(s32, s32.mul(s32.add(base, s32.const(4)), s32.const(3))).immutable().export("derived");
  mod.variable(s32, s32.sub(base, s32.const(100))).immutable().export("below");
  const { exports } = await instantiate(mod, {
    env: { base: new WebAssembly.Global({ value: "i32" }, 10) },
  });
  assert.equal(exports.derived.value, 42);
  assert.equal(exports.below.value, -90);
});

test("preceding defined immutable globals are referenceable (wasm 3.0)", async () => {
  const mod = new Module();
  const a = mod.variable(s32, 7).immutable();
  const b = mod.variable(s32, s32.add(a, s32.const(1))).immutable();
  mod.variable(s32, s32.mul(a, b)).immutable().export("product"); // 7 * 8
  const { exports } = await instantiate(mod);
  assert.equal(exports.product.value, 56);
});

test("64-bit chains take BigInts and value-exact promotion lifts small consts", async () => {
  const mod = new Module();
  const big = mod.variable(u64, 2n ** 40n).immutable();
  // s32.const-style plain number promotes into the u64 slot (value-exact)
  mod.variable(u64, u64.add(u64.mul(big, u64.const(4n)), u64.const(2))).immutable().export("v");
  const { exports } = await instantiate(mod);
  assert.equal(exports.v.value, 2n ** 42n + 2n);
});

test("data and element offsets accept constant arithmetic", async () => {
  const mod = new Module();
  const base = mod.variable(u32).import("env", "base").immutable();
  const mem = mod.memory({ min: 1 }).export("mem");
  mod.data(new Uint8Array([0xaa, 0xbb])).at(mem, u32.add(base, u32.const(2)));

  const tbl = mod.table(funcref, { min: 8 });
  const f = mod.function([], [s32]).body(($) => $.return(s32.const(99)));
  mod.elem([f]).at(tbl, u32.mul(base, u32.const(2)));
  const sig = mod.funcType([], [s32]);
  mod.function([s32], [s32]).export("call").body((i, $) => {
    $.return(tbl.call(sig, u32.cast(i)));
  });

  const { exports } = await instantiate(mod, {
    env: { base: new WebAssembly.Global({ value: "i32" }, 3) },
  });
  assert.deepEqual([...new Uint8Array(exports.mem.buffer).slice(5, 7)], [0xaa, 0xbb]);
  assert.equal(exports.call(6), 99); // elem landed at base*2
});

test("const-capable constructors are runtime ops inside a body (unchanged)", async () => {
  const mod = new Module();
  const g = mod.variable(s32, 5).immutable();
  mod.function([s32], [s32]).export("f").body((x, $) => {
    $.return(s32.add(s32.mul(x, s32.const(2)), g)); // ordinary codegen
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(10), 25);
});

test("const-expr trees built outside a body may be reused inside one", async () => {
  const mod = new Module();
  const base = mod.variable(s32, 30).immutable();
  const expr = s32.add(base, s32.const(12)); // built outside any body
  mod.variable(s32, expr).immutable().export("init");
  mod.function([], [s32]).export("f").body(($) => $.return(expr)); // global.get + add at runtime
  const { exports } = await instantiate(mod);
  assert.equal(exports.init.value, 42);
  assert.equal(exports.f(), 42);
});

test("constant-expression operand and type errors are eager", () => {
  const mod = new Module();
  const base = mod.variable(s32, 1).immutable();
  const base64 = mod.variable(s64, 1n).immutable();
  throws(() => s32.add(base, 5), /constant expression/); // raw numbers must be wrapped
  throws(() => s32.add(base, s64.const(1n)), /expected s32, got s64/);
  throws(() => s32.add(base64, s32.const(1)), /expected s32, got s64/);
  throws(() => u32.add(base, u32.const(1)), /expected u32, got s32/); // signedness barrier holds
  const other = new Module().variable(s32, 1).immutable();
  throws(() => mod.variable(s32, s32.add(other, s32.const(1))), /different module/);
});

test("mutable references in constant expressions fail at emit", () => {
  const mod = new Module();
  const m = mod.variable(s32, 1); // mutable
  mod.variable(s32, s32.add(m, s32.const(1)));
  throws(() => mod.emit(), /immutable module variables/);
});
