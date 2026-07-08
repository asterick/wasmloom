import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter } from "../src/encode/leb.js";

function bytesOf(fn) {
  const w = new ByteWriter();
  fn(w);
  return [...w.toBytes()];
}

test("u32 LEB128", () => {
  assert.deepEqual(bytesOf((w) => w.u32(0)), [0x00]);
  assert.deepEqual(bytesOf((w) => w.u32(127)), [0x7f]);
  assert.deepEqual(bytesOf((w) => w.u32(128)), [0x80, 0x01]);
  assert.deepEqual(bytesOf((w) => w.u32(624485)), [0xe5, 0x8e, 0x26]);
  assert.deepEqual(bytesOf((w) => w.u32(0xffffffff)), [0xff, 0xff, 0xff, 0xff, 0x0f]);
});

test("s32 LEB128", () => {
  assert.deepEqual(bytesOf((w) => w.s32(0)), [0x00]);
  assert.deepEqual(bytesOf((w) => w.s32(-1)), [0x7f]);
  assert.deepEqual(bytesOf((w) => w.s32(63)), [0x3f]);
  assert.deepEqual(bytesOf((w) => w.s32(64)), [0xc0, 0x00]);
  assert.deepEqual(bytesOf((w) => w.s32(-64)), [0x40]);
  assert.deepEqual(bytesOf((w) => w.s32(-65)), [0xbf, 0x7f]);
  assert.deepEqual(bytesOf((w) => w.s32(-123456)), [0xc0, 0xbb, 0x78]);
  assert.deepEqual(bytesOf((w) => w.s32(-2147483648)), [0x80, 0x80, 0x80, 0x80, 0x78]);
});

test("s64 LEB128", () => {
  assert.deepEqual(bytesOf((w) => w.s64(0n)), [0x00]);
  assert.deepEqual(bytesOf((w) => w.s64(-1n)), [0x7f]);
  assert.deepEqual(bytesOf((w) => w.s64(2n ** 62n)), [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0xc0, 0x00]);
  assert.deepEqual(bytesOf((w) => w.s64(-(2n ** 63n))), [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f]);
});

test("floats little-endian", () => {
  assert.deepEqual(bytesOf((w) => w.f64(1.0)), [0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
  assert.deepEqual(bytesOf((w) => w.f32(1.0)), [0, 0, 0x80, 0x3f]);
});

test("name encoding", () => {
  assert.deepEqual(bytesOf((w) => w.name("ab")), [0x02, 0x61, 0x62]);
});

test("section wrapper skips empty payloads", () => {
  assert.deepEqual(bytesOf((w) => w.section(1, () => {})), []);
  assert.deepEqual(bytesOf((w) => w.section(1, (s) => s.u8(7))), [0x01, 0x01, 0x07]);
});
