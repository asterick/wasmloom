import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u8x16 } from "../src/index.js";
import { VENEER_OPS } from "../src/expr.js";

// SIMD analog of optable-sweep: every vector constructor overload executes
// against an independent lane-wise JS reference. v128 cannot cross the JS
// boundary, so operands travel through linear memory: JS writes pattern bytes
// into fixed slots, the wasm function loads them, applies exactly one
// instruction, and stores/returns the result.
//
// Memory layout: vec operands at 0/16/32, vec results at 64, lane-memory
// scratch at 80. Scalar operands are function parameters.

const OPS = VENEER_OPS.filter((v) => v.vec);

// --- shapes and lane access ----------------------------------------------------

function sh(t) {
  const m = t && /^([sufm])(\d+)x(\d+)$/.exec(t.name);
  return m ? { kind: m[1], bits: +m[2], lanes: +m[3] } : null;
}

function readLanes(shape, bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const out = [];
  for (let i = 0; i < shape.lanes; i++) out.push(readLane(shape, dv, i));
  return out;
}
function readLane(shape, dv, i) {
  const { kind, bits } = shape;
  const u = kind === "u" || kind === "m";
  switch (bits) {
    case 8: return u ? dv.getUint8(i) : dv.getInt8(i);
    case 16: return u ? dv.getUint16(2 * i, true) : dv.getInt16(2 * i, true);
    case 32:
      if (kind === "f") return dv.getFloat32(4 * i, true);
      return u ? dv.getUint32(4 * i, true) : dv.getInt32(4 * i, true);
    case 64:
      if (kind === "f") return dv.getFloat64(8 * i, true);
      return u ? dv.getBigUint64(8 * i, true) : dv.getBigInt64(8 * i, true);
  }
}
function writeLanes(shape, lanes) {
  const bytes = new Uint8Array(16);
  const dv = new DataView(bytes.buffer);
  lanes.forEach((v, i) => {
    const { kind, bits } = shape;
    if (kind === "f") {
      if (bits === 32) dv.setFloat32(4 * i, v, true);
      else dv.setFloat64(8 * i, v, true);
    } else if (bits === 8) dv.setUint8(i, Number(BigInt.asUintN(8, BigInt(v))));
    else if (bits === 16) dv.setUint16(2 * i, Number(BigInt.asUintN(16, BigInt(v))), true);
    else if (bits === 32) dv.setUint32(4 * i, Number(BigInt.asUintN(32, BigInt(v))), true);
    else dv.setBigUint64(8 * i, BigInt.asUintN(64, BigInt(v)), true);
  });
  return bytes;
}

// --- lane arithmetic helpers (value domain follows the shape's signedness) -----

const wrap = (shape, x) => {
  const { kind, bits } = shape;
  const bx = typeof x === "bigint" ? x : BigInt(Math.trunc(x));
  if (bits === 64) return kind === "u" || kind === "m" ? BigInt.asUintN(64, bx) : BigInt.asIntN(64, bx);
  const u = Number(BigInt.asUintN(bits, bx));
  return kind === "u" || kind === "m" ? u : u >= 2 ** (bits - 1) ? u - 2 ** bits : u;
};
const allOnes = (shape) => (shape.bits === 64 ? 0xffffffffffffffffn : 2 ** shape.bits - 1);
const laneMin = (shape) =>
  shape.kind === "u" ? (shape.bits === 64 ? 0n : 0) : shape.bits === 64 ? -(2n ** 63n) : -(2 ** (shape.bits - 1));
const laneMax = (shape) => {
  if (shape.kind === "u") return shape.bits === 64 ? 2n ** 64n - 1n : 2 ** shape.bits - 1;
  return shape.bits === 64 ? 2n ** 63n - 1n : 2 ** (shape.bits - 1) - 1;
};
const clampLane = (shape, x) => {
  const lo = laneMin(shape);
  const hi = laneMax(shape);
  return x < lo ? lo : x > hi ? hi : x;
};
const F = Math.fround;
const fr = (shape, x) => (shape.bits === 32 ? F(x) : x);

function nearest(x) {
  if (!Number.isFinite(x) || Number.isInteger(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  let r;
  if (d < 0.5) r = f;
  else if (d > 0.5) r = f + 1;
  else r = f % 2 === 0 ? f : f + 1;
  return r === 0 && x < 0 ? -0 : r;
}
function satToI32Range(x, lo, hi) {
  if (Number.isNaN(x)) return 0;
  return Math.min(Math.max(Math.trunc(x), lo), hi);
}

// --- reference implementations, dispatched by veneer name -----------------------

// Bitwise ops work in the unsigned lane domain regardless of shape.
const bitU = (shape, x) => (shape.bits === 64 ? BigInt.asUintN(64, x) : Number(BigInt.asUintN(shape.bits, BigInt(x))));
const bitOp = (shape, fn) => (A, B) => {
  const ones = allOnes(shape);
  return A.map((a, i) => wrap(shape, shape.bits === 64
    ? fn(bitU(shape, a), B ? bitU(shape, B[i]) : undefined, ones)
    : fn(bitU(shape, a), B ? bitU(shape, B[i]) : undefined, ones)));
};

function reference(v, unit) {
  const ns = v.ns;
  const name = v.name;
  const out = v.results[0] ? sh(v.results[0]) : null;
  const p0 = v.params[0] ? sh(v.params[0]) : null;
  const T = sh({ name: ns }) ?? out ?? p0; // namespace shape (null for none — never here)
  const mask = (cond) => (cond ? allOnes(out) : out.bits === 64 ? 0n : 0);
  const big = (x) => BigInt(x);

  const laneOf = (s) => (T.kind === "f" ? fr(T, s) : wrap(T, s));
  switch (name) {
    case "splat": return (s) => Array(T.lanes).fill(laneOf(s));
    case "extract": return (A) => A[unit.lane];
    case "replace": return (A, s) => A.map((x, i) => (i === unit.lane ? laneOf(s) : x));
    case "eq": return (A, B) => A.map((a, i) => mask(a === B[i]));
    case "ne": return (A, B) => A.map((a, i) => mask(a !== B[i]));
    case "lt": return (A, B) => A.map((a, i) => mask(a < B[i]));
    case "gt": return (A, B) => A.map((a, i) => mask(a > B[i]));
    case "le": return (A, B) => A.map((a, i) => mask(a <= B[i]));
    case "ge": return (A, B) => A.map((a, i) => mask(a >= B[i]));
    case "add":
      if (T.kind === "f") return (A, B) => A.map((a, i) => fr(T, a + B[i]));
      return (A, B) => A.map((a, i) => wrap(T, T.bits === 64 ? a + B[i] : a + B[i]));
    case "sub":
      if (T.kind === "f") return (A, B) => A.map((a, i) => fr(T, a - B[i]));
      return (A, B) => A.map((a, i) => wrap(T, a - B[i]));
    case "mul":
      if (T.kind === "f") return (A, B) => A.map((a, i) => fr(T, a * B[i]));
      if (T.bits === 64) return (A, B) => A.map((a, i) => wrap(T, a * B[i]));
      if (T.bits === 32) return (A, B) => A.map((a, i) => wrap(T, Math.imul(a, B[i])));
      return (A, B) => A.map((a, i) => wrap(T, a * B[i]));
    case "neg":
      if (T.kind === "f") return (A) => A.map((a) => -a);
      return (A) => A.map((a) => wrap(T, -a));
    case "abs":
      if (T.kind === "f") return (A) => A.map(Math.abs);
      return (A) => A.map((a) => wrap(T, a < 0 ? -a : a));
    case "shl": return (A, c) => {
      const r = BigInt(c & (T.bits - 1));
      return A.map((a) => wrap(T, BigInt(a) << r));
    };
    case "shr": return (A, c) => {
      const r = T.bits === 64 ? big(c) & 63n : c & (T.bits - 1);
      if (T.bits === 64) return A.map((a) => wrap(T, a >> r));
      return A.map((a) => wrap(T, Math.floor(a / 2 ** r)));
    };
    case "and": return bitOp(out, (a, b) => (out.bits === 64 ? a & b : (a & b) >>> 0));
    case "or": return bitOp(out, (a, b) => (out.bits === 64 ? a | b : (a | b) >>> 0));
    case "xor": return bitOp(out, (a, b) => (out.bits === 64 ? a ^ b : (a ^ b) >>> 0));
    case "andnot": return bitOp(out, (a, b, ones) => (out.bits === 64 ? a & (b ^ ones) : (a & (~b >>> 0)) >>> 0));
    case "not": return bitOp(out, (a, _b, ones) => (out.bits === 64 ? a ^ ones : (~a >>> 0)));
    case "bitselect": {
      const m = sh(v.params[2]);
      return (A, B, M) => A.map((a, i) => {
        if (T.bits === 64) {
          const ua = BigInt.asUintN(64, T.kind === "f" ? f64Bits(a) : big(a));
          const ub = BigInt.asUintN(64, T.kind === "f" ? f64Bits(B[i]) : big(B[i]));
          const um = BigInt.asUintN(64, big(M[i]));
          const r = (ua & um) | (ub & ~um & allOnes(m));
          return T.kind === "f" ? bitsF64(r) : wrap(T, r);
        }
        const ua = T.kind === "f" ? f32Bits(a) : Number(BigInt.asUintN(T.bits, big(a)));
        const ub = T.kind === "f" ? f32Bits(B[i]) : Number(BigInt.asUintN(T.bits, big(B[i])));
        const um = M[i];
        const r = ((ua & um) | (ub & ~um)) >>> 0 & Number(allOnes(m));
        return T.kind === "f" ? bitsF32(r) : wrap(T, r);
      });
    }
    case "add_sat": return (A, B) => A.map((a, i) => clampLane(T, a + B[i]));
    case "sub_sat": return (A, B) => A.map((a, i) => clampLane(T, a - B[i]));
    case "min":
      if (T.kind === "f") return (A, B) => A.map((a, i) => fr(T, Math.min(a, B[i])));
      return (A, B) => A.map((a, i) => (a < B[i] ? a : B[i]));
    case "max":
      if (T.kind === "f") return (A, B) => A.map((a, i) => fr(T, Math.max(a, B[i])));
      return (A, B) => A.map((a, i) => (a > B[i] ? a : B[i]));
    case "pmin": return (A, B) => A.map((a, i) => (B[i] < a ? B[i] : a));
    case "pmax": return (A, B) => A.map((a, i) => (a < B[i] ? B[i] : a));
    case "avgr": return (A, B) => A.map((a, i) => Math.floor((a + B[i] + 1) / 2));
    case "popcnt": return (A) => A.map((a) => {
      let x = a & 0xff;
      let c = 0;
      while (x) { c += x & 1; x >>= 1; }
      return c;
    });
    case "q15mulr_sat": return (A, B) => A.map((a, i) => clampLane(T, (a * B[i] + 0x4000) >> 15));
    case "dot": return (A, B) => [0, 1, 2, 3].map((i) => (Math.imul(A[2 * i], B[2 * i]) + Math.imul(A[2 * i + 1], B[2 * i + 1])) | 0);
    case "swizzle": return (A, S) => S.map((s) => {
      const idx = s & 0xff; // byte index is unsigned regardless of namespace
      return idx < 16 ? A[idx] : 0;
    });
    case "shuffle": return (A, B) => unit.shuffleImm.map((s) => (s < 16 ? A[s] : B[s - 16]));
    case "narrow": return (A, B) => [...A, ...B].map((x) => clampLane(out, x));
    case "extend_low": return (A) => A.slice(0, out.lanes).map((x) => (out.bits === 64 ? big(x) : x));
    case "extend_high": return (A) => A.slice(out.lanes).map((x) => (out.bits === 64 ? big(x) : x));
    case "extmul_low": return (A, B) =>
      A.slice(0, out.lanes).map((a, i) => (out.bits === 64 ? big(a) * big(B[i]) : a * B[i]));
    case "extmul_high": return (A, B) =>
      A.slice(out.lanes).map((a, i) => (out.bits === 64 ? big(a) * big(B.slice(out.lanes)[i]) : a * B.slice(out.lanes)[i]));
    case "extadd_pairwise": return (A) => Array.from({ length: out.lanes }, (_, i) => A[2 * i] + A[2 * i + 1]);
    case "trunc_sat": return (A) => A.map((a) => Number(BigInt.asIntN(32, BigInt(satToI32Range(F(a), Number(laneMin(out)), Number(laneMax(out))))))
    );
    case "trunc_sat_zero": return (A) => [
      ...A.map((a) => satToI32Range(a, Number(laneMin(out)), Number(laneMax(out)))),
      0, 0,
    ].map((x) => wrap(out, x));
    case "convert": return (A) => A.map((a) => F(a));
    case "convert_low": return (A) => [A[0], A[1]];
    case "demote_zero": return (A) => [F(A[0]), F(A[1]), 0, 0];
    case "promote_low": return (A) => [A[0], A[1]];
    case "sqrt": return (A) => A.map((a) => fr(T, Math.sqrt(a)));
    case "ceil": return (A) => A.map((a) => fr(T, Math.ceil(a)));
    case "floor": return (A) => A.map((a) => fr(T, Math.floor(a)));
    case "trunc": return (A) => A.map((a) => fr(T, Math.trunc(a)));
    case "nearest": return (A) => A.map((a) => fr(T, nearest(a)));
    case "div": return (A, B) => A.map((a, i) => fr(T, a / B[i]));
    case "any_true": return (A) => (A.some((a) => a !== 0 && a !== 0n) ? 1 : 0);
    case "all_true": return (A) => (A.every((a) => a !== 0 && a !== 0n) ? 1 : 0);
    case "bitmask": return (A) => A.reduce((acc, a, i) => {
      const signBit = p0.bits === 64 ? a >= 2n ** 63n : a >= 2 ** (p0.bits - 1);
      return acc | (signBit ? 1 << i : 0);
    }, 0);
    // memory family — extra input: `memBytes` scratch written by the driver
    case "load": return (memBytes) => readLanes(T, memBytes);
    case "load_splat": return (memBytes) => {
      const lane = readLane(T, new DataView(memBytes.buffer, memBytes.byteOffset), 0);
      return Array(T.lanes).fill(lane);
    };
    case "load_zero": return (memBytes) => {
      const dv = new DataView(memBytes.buffer, memBytes.byteOffset);
      const zero = T.kind === "f" ? 0 : T.bits === 64 ? 0n : 0;
      return Array.from({ length: T.lanes }, (_, i) => (i === 0 ? readLane(T, dv, 0) : zero));
    };
    case "load_lane": return (A, memBytes) => {
      const dv = new DataView(memBytes.buffer, memBytes.byteOffset);
      return A.map((a, i) => (i === unit.lane ? readLane(T, dv, 0) : a));
    };
    case "store": return (A) => A;
    case "store_lane": return (A) => {
      // only the lane's bytes are written; driver zeroes the slot first
      const lanes = Array(T.lanes).fill(T.kind === "f" ? 0 : T.bits === 64 ? 0n : 0);
      lanes[0] = A[unit.lane];
      return lanes;
    };
    default: {
      // wide loads: load8x8 / load16x4 / load32x2 — signedness from namespace
      const m = /^load(\d+)x(\d+)$/.exec(name);
      if (m) {
        const srcShape = { kind: T.kind, bits: +m[1], lanes: +m[2] };
        return (memBytes) => {
          const dv = new DataView(memBytes.buffer, memBytes.byteOffset);
          return Array.from({ length: T.lanes }, (_, i) => {
            const x = readLane(srcShape, dv, i);
            return T.bits === 64 ? BigInt(x) : x;
          });
        };
      }
      return null;
    }
  }
}

const bitsDv = new DataView(new ArrayBuffer(8));
function f32Bits(x) { bitsDv.setFloat32(0, x, true); return bitsDv.getUint32(0, true); }
function bitsF32(u) { bitsDv.setUint32(0, u >>> 0, true); return bitsDv.getFloat32(0, true); }
function f64Bits(x) { bitsDv.setFloat64(0, x, true); return bitsDv.getBigUint64(0, true); }
function bitsF64(u) { bitsDv.setBigUint64(0, u, true); return bitsDv.getFloat64(0, true); }

// --- input patterns --------------------------------------------------------------

const BYTE_PATTERNS = [
  new Uint8Array(16),
  Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  Uint8Array.from([0x80, 0x7f, 0xff, 0x01, 0x00, 0xfe, 0x40, 0xc0, 0xaa, 0x55, 0x10, 0xef, 0x02, 0x9d, 0x33, 0x66]),
  Uint8Array.from({ length: 16 }, (_, i) => (i * 73 + 41) & 0xff),
  Uint8Array.from({ length: 16 }, (_, i) => (255 - i * 17) & 0xff),
];
const F32_PATTERNS = [
  [0, -0, Infinity, NaN],
  [1, -1, 0.5, -2.5],
  [3.5, 1e30, -1e30, -Infinity],
  [100.75, -0.5, 7, -3.25],
  [2 ** 31, -(2 ** 31) - 4096, 2 ** 32, -1.5], // trunc_sat boundaries
].map((l) => writeLanes({ kind: "f", bits: 32, lanes: 4 }, l));
const F64_PATTERNS = [
  [0, NaN],
  [-0, Infinity],
  [1.5, -2.5],
  [1e300, -7.75],
  [2147483647.5, -2147483648.5], // trunc_sat boundaries
  [4294967295.75, -1],
].map((l) => writeLanes({ kind: "f", bits: 64, lanes: 2 }, l));

function maskPatterns(shape) {
  const ones = allOnes(shape);
  const zero = shape.bits === 64 ? 0n : 0;
  const alt = Array.from({ length: shape.lanes }, (_, i) => (i % 2 ? ones : zero));
  const one = Array.from({ length: shape.lanes }, (_, i) => (i === shape.lanes - 1 ? ones : zero));
  return [
    writeLanes(shape, Array(shape.lanes).fill(zero)),
    writeLanes(shape, Array(shape.lanes).fill(ones)),
    writeLanes(shape, alt),
    writeLanes(shape, one),
  ];
}

function patternsFor(t) {
  const shape = sh(t);
  if (shape.kind === "f") return shape.bits === 32 ? F32_PATTERNS : F64_PATTERNS;
  if (shape.kind === "m") return maskPatterns(shape);
  return BYTE_PATTERNS;
}

function scalarValuesFor(v, t) {
  if (v.name === "shl" || v.name === "shr") {
    const bits = sh({ name: v.ns }).bits;
    return [0, 1, bits - 1, bits, 2 * bits + 3];
  }
  switch (t.name) {
    case "s64": case "u64": return [0n, 1n, -1n, 2n ** 63n - 1n, -(2n ** 63n)];
    case "f32": case "f64": return [0, -0, 1.5, -2.5, NaN, Infinity];
    default: return [0, 1, -1, 0x7fffffff, -0x80000000, 0x5abc];
  }
}

// --- build one wasm function per unit, then drive them ---------------------------

const NS_BY_NAME = new Map(OPS.map((v) => [v.ns, null]));
import * as api from "../src/index.js";
for (const key of NS_BY_NAME.keys()) NS_BY_NAME.set(key, api[key]);

test("every SIMD constructor selects and executes its spec instruction", async () => {
  // Expand items into units (lane-immediate ops sample several lanes).
  const units = [];
  for (const v of OPS) {
    const T = NS_BY_NAME.get(v.ns);
    assert.ok(T, `unknown vector namespace ${v.ns}`);
    if (v.shuffle) {
      units.push({ v, shuffleImm: Array.from({ length: 16 }, (_, i) => 15 - i) });
      units.push({ v, shuffleImm: Array.from({ length: 16 }, (_, i) => (i % 2 ? 16 + (i >> 1) : i >> 1)) });
    } else if (v.laneCount) {
      for (const lane of new Set([0, v.laneCount >> 1, v.laneCount - 1])) units.push({ v, lane });
    } else {
      units.push({ v });
    }
  }
  units.forEach((u, i) => (u.fname = `u${i}`));

  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("mem");
  const loadSlot = (P, off) =>
    P === u8x16 ? u8x16.load(mem, s32.const(off)) : P.cast(u8x16.load(mem, s32.const(off)));
  const storeResult = (r, type) =>
    u8x16.store(mem, s32.const(64), type === u8x16 ? r : u8x16.cast(r));

  for (const u of units) {
    const v = u.v;
    const T = NS_BY_NAME.get(v.ns);
    const isVecParam = (p) => sh(p) !== null;
    // Memory ops take their address as a built-in constant, not a parameter.
    const scalarTypes = v.mem ? [] : v.params.filter((p) => !isVecParam(p));
    mod.function(scalarTypes, v.results.filter((r) => !sh(r))).export(u.fname).body((...args) => {
      const $ = args.pop();
      let r;
      if (v.mem) {
        if (v.laneCount) {
          // load_lane/store_lane: vector at slot 0, memory scratch at 80/64
          const vec = loadSlot(v.params[0], 0);
          if (v.mem === "load") r = T[v.name](mem, s32.const(80), vec, u.lane);
          else T[v.name](mem, s32.const(64), vec, u.lane);
        } else if (v.mem === "store") {
          T.store(mem, s32.const(64), loadSlot(v.params[1] ?? T, 0));
        } else {
          r = T[v.name](mem, s32.const(80));
        }
      } else if (u.shuffleImm) {
        r = T.shuffle(loadSlot(v.params[0], 0), loadSlot(v.params[1], 16), u.shuffleImm);
      } else if (v.name === "extract") {
        r = T.extract(loadSlot(v.params[0], 0), u.lane);
      } else if (v.name === "replace") {
        r = T.replace(loadSlot(v.params[0], 0), u.lane, args[0]);
      } else {
        let slot = 0;
        let scalarIdx = 0;
        const operands = v.params.map((p) => (isVecParam(p) ? loadSlot(p, (slot += 16) - 16) : args[scalarIdx++]));
        r = T[v.name](...operands);
      }
      if (r === undefined) $.return();
      else if (sh(v.results[0])) { storeResult(r, v.results[0]); $.return(); }
      else $.return(r);
    });
  }

  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "SIMD sweep module failed validation");
  const { instance } = await WebAssembly.instantiate(bytes);
  const memBytes = new Uint8Array(instance.exports.mem.buffer);

  let cases = 0;
  for (const u of units) {
    const v = u.v;
    const ref = reference(v, u);
    assert.ok(ref, `missing SIMD reference for ${v.ns}.${v.name}`);
    const fn = instance.exports[u.fname];
    const label = `${v.ns}.${v.name}${u.lane !== undefined ? ` lane ${u.lane}` : ""} [${v.entry.ns}.${v.entry.name}]`;

    const vecParams = v.params.filter((p) => sh(p));
    const scalarParams = v.mem ? [] : v.params.filter((p) => !sh(p));
    // For memory loads (no vec params) the scratch region is the input.
    const memInput = v.mem === "load" && !v.laneCount;
    const laneMemInput = v.mem === "load" && !!v.laneCount;

    const vecSets = vecParams.map((p) => patternsFor(p));
    const scalarSets = scalarParams.map((p) => scalarValuesFor(v, p));
    const extraSets = memInput || laneMemInput ? [BYTE_PATTERNS] : [];

    let combos = [[]];
    for (const set of [...vecSets, ...scalarSets, ...extraSets]) {
      combos = combos.flatMap((prefix) => set.map((x) => [...prefix, x]));
    }

    for (const combo of combos) {
      const vecArgs = combo.slice(0, vecParams.length);
      const scalarArgs = combo.slice(vecParams.length, vecParams.length + scalarParams.length);
      const extra = combo[vecParams.length + scalarParams.length];

      vecArgs.forEach((bytes16, i) => memBytes.set(bytes16, i * 16));
      memBytes.fill(0, 64, 96);
      if (extra) memBytes.set(extra, 80);

      const refVecArgs = vecArgs.map((bytes16, i) => readLanes(sh(vecParams[i]), bytes16));
      let expected;
      if (memInput) expected = ref(extra);
      else if (laneMemInput) expected = ref(refVecArgs[0], extra);
      else expected = ref(...refVecArgs, ...scalarArgs);

      const actual = fn(...scalarArgs);
      cases++;

      // Stores have no results — their observable output is the slot at 64.
      const outShape = sh(v.results[0]) ?? (v.mem === "store" ? sh({ name: v.ns }) : null);
      if (outShape) {
        const got = readLanes(outShape, memBytes.subarray(64, 80));
        const want = expected.map((x) => (outShape.kind === "f" ? x : wrap(outShape, x)));
        for (let i = 0; i < outShape.lanes; i++) {
          const ok = (typeof got[i] === "number" && Number.isNaN(got[i]) && Number.isNaN(want[i])) || Object.is(got[i], want[i]);
          assert.ok(ok, `${label} lane ${i}: expected ${want[i]}, got ${got[i]} (inputs ${combo.map(String).join(" | ")})`);
        }
      } else {
        const want = expected;
        let got = actual;
        const rt = v.results[0];
        if (rt && rt.name[0] === "u" && typeof got === "number") got = got >>> 0;
        if (rt && rt.name[0] === "u" && typeof got === "bigint") got = BigInt.asUintN(64, got);
        const ok = (typeof got === "number" && Number.isNaN(got) && Number.isNaN(want)) || Object.is(got, want) || got === want;
        assert.ok(ok, `${label}: expected ${want}, got ${got} (inputs ${combo.map(String).join(" | ")})`);
      }
    }
  }
  assert.ok(cases > 8000, `SIMD sweep only ran ${cases} cases`);
});
