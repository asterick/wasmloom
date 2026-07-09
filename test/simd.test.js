import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Module, s32, u32, s64, f32, bool,
  s8x16, u8x16, s16x8, s32x4, u32x4, s64x2, u64x2, f32x4, f64x2, m32x4,
} from "../src/index.js";

// Behavioral SIMD coverage: masks as first-class compare results, shape
// barriers, casts, lane access, memory round trips, v128 variables/globals.
// The exhaustive per-instruction check lives in simd-sweep.test.js.

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("compare → mask → bitselect: branchless lane clamp", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("mem");
  // clamp each s32 lane to at most 100: mask = v > 100; r = bitselect(100s, v, mask)
  mod.function([], []).export("run").body(($) => {
    const v = s32x4.load(mem, s32.const(0));
    const limit = s32x4.const([100, 100, 100, 100]);
    const over = s32x4.gt(v, limit);
    s32x4.store(mem, s32.const(16), s32x4.bitselect(limit, v, over));
  });
  const { exports } = await instantiate(mod);
  const words = new Int32Array(exports.mem.buffer);
  words.set([5, 500, -7, 101], 0);
  exports.run();
  assert.deepEqual([...words.slice(4, 8)], [5, 100, -7, 100]);
});

test("mask ops: any_true/all_true produce bool, bitmask produces u32", async () => {
  const mod = new Module();
  mod.function([s32, s32, s32, s32], [u32, bool, bool]).export("f").body((a, b, c, d, $) => {
    const v = s32x4.replace(s32x4.replace(s32x4.replace(s32x4.splat(a), 1, b), 2, c), 3, d);
    const m = s32x4.lt(v, s32x4.const([0, 0, 0, 0]));
    $.return(m32x4.bitmask(m), m32x4.any_true(m), m32x4.all_true(m));
  });
  const { exports } = await instantiate(mod);
  assert.deepEqual(exports.f(-1, 2, -3, 4), [0b0101, 1, 0]);
  assert.deepEqual(exports.f(1, 2, 3, 4), [0, 0, 0]);
  assert.deepEqual(exports.f(-1, -2, -3, -4), [0b1111, 1, 1]);
});

test("mask conditions must bridge through bool, and masks compose bitwise", async () => {
  const mod = new Module();
  mod.function([f32, f32], [bool]).export("inRange").body((lo, hi, $) => {
    const v = f32x4.const([1, 2, 3, 4]);
    const above = f32x4.ge(v, f32x4.splat(lo));
    const below = f32x4.le(v, f32x4.splat(hi));
    $.return(m32x4.all_true(m32x4.and(above, below)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.inRange(0, 5), 1);
  assert.equal(exports.inRange(2, 5), 0);
});

test("casts bridge lane views and masks; arithmetic on a mask view works after cast", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const v = s32x4.splat(x);
    const m = s32x4.eq(v, s32x4.const([7, 7, 7, 7])); // all-ones lanes when x=7
    const asInt = u32x4.cast(m);
    // all-ones is 0xffffffff = -1 signed: sum via extract after cast to s32x4
    const s = s32x4.cast(asInt);
    $.return(s32.add(s32x4.extract(s, 0), s32x4.extract(s, 3)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(7), -2);
  assert.equal(exports.f(8), 0);
});

test("64-bit lanes: BigInt consts, splat/extract round trip", async () => {
  const mod = new Module();
  mod.function([s64], [s64]).export("f").body((x, $) => {
    const v = s64x2.replace(s64x2.const([-(2n ** 62n), 5n]), 1, x);
    $.return(s64.add(s64x2.extract(v, 0), s64x2.extract(v, 1)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(2n ** 62n), 0n);
  assert.equal(exports.f(10n), -(2n ** 62n) + 10n);
});

test("v128 module variable: const init, mutation, byte-exactness", async () => {
  const mod = new Module();
  const acc = mod.variable(s32x4, [1, 2, 3, 4]);
  const mem = mod.memory({ min: 1 }).export("mem");
  mod.function([], []).export("step").body(($) => {
    acc.set(s32x4.add(acc, s32x4.const([10, 20, 30, 40])));
    s32x4.store(mem, s32.const(0), acc);
  });
  const { exports } = await instantiate(mod);
  exports.step();
  exports.step();
  assert.deepEqual([...new Int32Array(exports.mem.buffer).slice(0, 4)], [21, 42, 63, 84]);
});

test("v128 local variables share slots and default to zero", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("mem");
  mod.function([], []).export("run").body(($) => {
    const a = $.variable(f64x2); // default zero-initialized
    const b = $.variable(s8x16);
    b.set(s8x16.add(s8x16.splat(s32.const(3)), s8x16.cast(a)));
    s8x16.store(mem, s32.const(0), b);
  });
  const { exports } = await instantiate(mod);
  exports.run();
  assert.ok([...new Uint8Array(exports.mem.buffer).slice(0, 16)].every((x) => x === 3));
});

test("shuffle and swizzle move bytes as specified", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("mem");
  mod.function([], []).export("run").body(($) => {
    const a = u8x16.load(mem, s32.const(0));
    const b = u8x16.load(mem, s32.const(16));
    u8x16.store(mem, s32.const(32), u8x16.shuffle(a, b, [0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23]));
    u8x16.store(mem, s32.const(48), u8x16.swizzle(a, b));
  });
  const { exports } = await instantiate(mod);
  const bytes = new Uint8Array(exports.mem.buffer);
  bytes.set(Array.from({ length: 16 }, (_, i) => 100 + i), 0);
  bytes.set([15, 0, 3, 200, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 16);
  exports.run();
  assert.deepEqual([...bytes.slice(32, 40)], [100, 15, 101, 0, 102, 3, 103, 200]);
  assert.deepEqual([...bytes.slice(48, 52)], [115, 100, 103, 0]); // index 200 → 0
});

test("lane memory ops: load_lane/store_lane/load_zero/load_splat/load8x8", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("mem");
  mod.function([], []).export("run").body(($) => {
    const wide = s16x8.load8x8(mem, s32.const(0)); // 8 signed bytes → 8×i16
    s16x8.store(mem, s32.const(16), wide);
    const v = u32x4.load_zero(mem, s32.const(0));
    u32x4.store(mem, s32.const(32), u32x4.load_lane(mem, s32.const(4), v, 3));
    f32x4.store(mem, s32.const(48), f32x4.load_splat(mem, s32.const(8)));
    s64x2.store_lane(mem, s32.const(64), s64x2.load(mem, s32.const(16)), 0);
  });
  const { exports } = await instantiate(mod);
  const bytes = new Uint8Array(exports.mem.buffer);
  const dv = new DataView(exports.mem.buffer);
  bytes.set([1, 0xff, 2, 0xfe, 3, 4, 5, 6], 0);
  dv.setFloat32(8, 2.5, true);
  exports.run();
  const shorts = new Int16Array(exports.mem.buffer, 16, 8);
  assert.deepEqual([...shorts], [1, -1, 2, -2, 3, 4, 5, 6]);
  const words = new Uint32Array(exports.mem.buffer, 32, 4);
  assert.equal(words[0], dv.getUint32(0, true)); // load_zero lane 0
  assert.equal(words[1], 0);
  assert.equal(words[3], dv.getUint32(4, true)); // load_lane replaced lane 3
  assert.equal(dv.getFloat32(48, true), 2.5);
  assert.equal(dv.getFloat32(60, true), 2.5);
  assert.equal(dv.getBigInt64(64, true), dv.getBigInt64(16, true)); // store_lane 0
});

test("SIMD eager errors: shape barriers, mask discipline, lane ranges", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    const a = s32x4.const([1, 2, 3, 4]);
    const b = f32x4.const([1, 2, 3, 4]);
    const m = s32x4.eq(a, a); // m32x4
    const m8 = s8x16.eq(s8x16.splat(s32.const(0)), s8x16.splat(s32.const(0)));

    assert.throws(() => s32x4.add(a, b), /expected s32x4/); // no cross-shape promotion
    assert.throws(() => s32x4.add(a, m), /expected s32x4/); // masks are not data
    assert.throws(() => s32x4.bitselect(a, a, m8), /expected m32x4/); // shape-matched masks
    assert.throws(() => s32x4.bitselect(a, a, a), /expected m32x4/);
    assert.throws(() => $.if(m, () => {}), /expected bool/); // masks are not conditions
    assert.throws(() => s32x4.extract(a, 4), /lane index/);
    assert.throws(() => s32x4.extract(a, -1), /lane index/);
    assert.throws(() => s64x2.replace(s64x2.splat(s64.const(0n)), 2, s64.const(1n)), /lane index/);
    assert.throws(() => s8x16.const([1, 2, 3]), /expected an array of 16/);
    assert.throws(() => s8x16.const(Array(16).fill(128)), /outside/);
    assert.throws(() => u8x16.const(Array(16).fill(-1)), /outside/);
    assert.throws(() => u8x16.shuffle(u8x16.cast(a), u8x16.cast(a), Array(16).fill(32)), /\[0, 32\)/);
    assert.throws(() => u8x16.shuffle(u8x16.cast(a), u8x16.cast(a), [0]), /16 lane indices/);
    assert.throws(() => s32x4.splat(s32.const(1), 2), /expected 1 operand/);
    // unsigned 64-lane ordering does not exist in wasm
    assert.equal(u64x2.lt, undefined);
    $.return();
  });
});
