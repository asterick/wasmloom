import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, f32, f64 } from "../src/index.js";

// Systematic execution of every load/store variant on every namespace against
// a DataView reference, plus bulk-op semantics the smoke tests don't reach.

const PATTERN = [0x01, 0x80, 0xff, 0x7f, 0x00, 0xab, 0x40, 0xc3, 0x12, 0xef, 0x9a, 0x55, 0xfe, 0x08, 0xb1, 0x63];

const LOADS = [
  // [type, op, reference(dv, addr)]
  [s32, "load", (dv, a) => dv.getInt32(a, true)],
  [u32, "load", (dv, a) => dv.getInt32(a, true)], // full width: same bits, JS sees signed
  [s32, "load8", (dv, a) => dv.getInt8(a)],
  [u32, "load8", (dv, a) => dv.getUint8(a)],
  [s32, "load16", (dv, a) => dv.getInt16(a, true)],
  [u32, "load16", (dv, a) => dv.getUint16(a, true)],
  [s64, "load", (dv, a) => dv.getBigInt64(a, true)],
  [u64, "load", (dv, a) => dv.getBigInt64(a, true)],
  [s64, "load8", (dv, a) => BigInt(dv.getInt8(a))],
  [u64, "load8", (dv, a) => BigInt(dv.getUint8(a))],
  [s64, "load16", (dv, a) => BigInt(dv.getInt16(a, true))],
  [u64, "load16", (dv, a) => BigInt(dv.getUint16(a, true))],
  [s64, "load32", (dv, a) => BigInt(dv.getInt32(a, true))],
  [u64, "load32", (dv, a) => BigInt(dv.getUint32(a, true))],
  [f32, "load", (dv, a) => dv.getFloat32(a, true)],
  [f64, "load", (dv, a) => dv.getFloat64(a, true)],
];

const STORES = [
  // [type, op, width(bytes), reference(dv, addr, value)]
  [s32, "store", 4, (dv, a, v) => dv.setInt32(a, v, true)],
  [u32, "store", 4, (dv, a, v) => dv.setInt32(a, v, true)],
  [s32, "store8", 1, (dv, a, v) => dv.setUint8(a, v & 0xff)],
  [u32, "store8", 1, (dv, a, v) => dv.setUint8(a, v & 0xff)],
  [s32, "store16", 2, (dv, a, v) => dv.setUint16(a, v & 0xffff, true)],
  [u32, "store16", 2, (dv, a, v) => dv.setUint16(a, v & 0xffff, true)],
  [s64, "store", 8, (dv, a, v) => dv.setBigInt64(a, v, true)],
  [u64, "store", 8, (dv, a, v) => dv.setBigInt64(a, v, true)],
  [s64, "store8", 1, (dv, a, v) => dv.setUint8(a, Number(v & 0xffn))],
  [u64, "store16", 2, (dv, a, v) => dv.setUint16(a, Number(v & 0xffffn), true)],
  [s64, "store32", 4, (dv, a, v) => dv.setUint32(a, Number(v & 0xffffffffn), true)],
  [f32, "store", 4, (dv, a, v) => dv.setFloat32(a, v, true)],
  [f64, "store", 8, (dv, a, v) => dv.setFloat64(a, v, true)],
];

test("every load variant matches a DataView reference at several addresses/offsets", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  for (const [T, op] of LOADS) {
    mod.function([s32], [T]).export(`${T.name}.${op}`).body((a, $) => {
      $.return(T[op](mem, a));
    });
    mod.function([s32], [T]).export(`${T.name}.${op}+3`).body((a, $) => {
      $.return(T[op](mem, a, { offset: 3 }));
    });
    mod.function([s32], [T]).export(`${T.name}.${op}~1`).body((a, $) => {
      $.return(T[op](mem, a, { align: 1 })); // minimal alignment is always legal
    });
  }
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  new Uint8Array(instance.exports.memory.buffer).set(PATTERN, 0);
  const dv = new DataView(instance.exports.memory.buffer);

  let cases = 0;
  for (const [T, op, ref] of LOADS) {
    for (const addr of [0, 1, 2, 3, 5]) {
      const label = `${T.name}.${op}(${addr})`;
      assert.equal(instance.exports[`${T.name}.${op}`](addr), ref(dv, addr), label);
      assert.equal(instance.exports[`${T.name}.${op}+3`](addr), ref(dv, addr + 3), `${label} offset 3`);
      assert.equal(instance.exports[`${T.name}.${op}~1`](addr), ref(dv, addr), `${label} align 1`);
      cases += 3;
    }
  }
  assert.ok(cases >= 240, `ran ${cases} load cases`);
});

test("every store variant matches a DataView reference", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  for (const [T, op] of STORES) {
    mod.function([s32, T], []).export(`${T.name}.${op}`).body((a, v, $) => {
      T[op](mem, a, v);
    });
  }
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  const actual = new Uint8Array(instance.exports.memory.buffer);
  const mirror = new Uint8Array(64);
  const mdv = new DataView(mirror.buffer);

  const VALUES = {
    i32: [0, -1, 0x12345678, -0x70605040, 0xffff, 128],
    i64: [0n, -1n, 0x0123456789abcdefn, -0x7060504030201000n, 0xffffn, 200n],
    f32: [0, 1.5, -255.25, 1e30],
    f64: [0, -2.5, Math.PI, 1e300],
  };
  let cases = 0;
  for (const [T, op, width, ref] of STORES) {
    for (const v of VALUES[T.wasmType.name]) {
      for (const addr of [0, 3]) {
        actual.fill(0, 0, 32);
        mirror.fill(0, 0, 32);
        instance.exports[`${T.name}.${op}`](addr, v);
        ref(mdv, addr, v);
        assert.deepEqual(
          [...actual.slice(0, 16)],
          [...mirror.slice(0, 16)],
          `${T.name}.${op}(${addr}, ${v}) [width ${width}]`,
        );
        cases++;
      }
    }
  }
  assert.ok(cases >= 100, `ran ${cases} store cases`);
});

test("mem.copy has memmove semantics for overlapping ranges", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([s32, s32, s32], []).export("copy").body((d, s, n, $) => {
    mem.copy(d, s, n);
  });
  const { instance } = await WebAssembly.instantiate(mod.emit());
  const bytes = new Uint8Array(instance.exports.memory.buffer);

  // forward overlap (dst > src)
  bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  instance.exports.copy(2, 0, 6);
  assert.deepEqual([...bytes.slice(0, 8)], [1, 2, 1, 2, 3, 4, 5, 6]);

  // backward overlap (dst < src)
  bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  instance.exports.copy(0, 2, 6);
  assert.deepEqual([...bytes.slice(0, 8)], [3, 4, 5, 6, 7, 8, 7, 8]);
});

test("zero-length bulk ops are legal even at the memory boundary", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  const seg = mod.data(new Uint8Array([1, 2, 3]));
  mod.function([], []).export("f").body(($) => {
    const end = s32.const(65536);
    mem.fill(end, s32.const(0), s32.const(0));
    mem.copy(end, end, s32.const(0));
    mem.init(seg, end, s32.const(3), s32.const(0)); // src == segment length, len 0
  });
  const { instance } = await WebAssembly.instantiate(mod.emit());
  instance.exports.f(); // must not trap
});

test("bulk ops trap out of bounds", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  const seg = mod.data(new Uint8Array([1, 2, 3]));
  mod.function([s32, s32, s32], []).export("fill").body((d, v, n, $) => mem.fill(d, v, n));
  mod.function([s32, s32, s32], []).export("copy").body((d, s, n, $) => mem.copy(d, s, n));
  mod.function([s32, s32, s32], []).export("init").body((d, s, n, $) => mem.init(seg, d, s, n));
  const { instance } = await WebAssembly.instantiate(mod.emit());
  assert.throws(() => instance.exports.fill(65530, 0xff, 10), WebAssembly.RuntimeError);
  assert.throws(() => instance.exports.copy(0, 65530, 10), WebAssembly.RuntimeError);
  assert.throws(() => instance.exports.copy(65530, 0, 10), WebAssembly.RuntimeError);
  assert.throws(() => instance.exports.init(0, 1, 3), WebAssembly.RuntimeError); // past segment end
  assert.throws(() => instance.exports.init(65535, 0, 2), WebAssembly.RuntimeError);
});
