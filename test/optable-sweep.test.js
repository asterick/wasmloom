import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, f32, f64, bool } from "../src/index.js";
import { OPTABLE } from "../src/optable.js";
import { VENEER_OPS } from "../src/expr.js";

// Executes EVERY public instruction constructor (each overload of every
// veneer op) against an independent JS reference implementation of the spec
// instruction it should select, over boundary-heavy input vectors, including
// expected traps. This catches wrong opcode bytes, swapped operands, wrong
// signatures, AND wrong signedness-variant selection.

const NS = { s32, u32, s64, u64, f32, f64, bool };
const TRAP = Symbol("trap");
const F = Math.fround;
const U32 = (x) => x >>> 0;
const I64 = (x) => BigInt.asIntN(64, x);
const U64 = (x) => BigInt.asUintN(64, x);
const b = (x) => (x ? 1 : 0);
const dv = new DataView(new ArrayBuffer(8));

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

function popcnt32(x) {
  x = U32(x);
  let c = 0;
  while (x) { c += x & 1; x >>>= 1; }
  return c;
}
function clz64(u) {
  for (let i = 63n; i >= 0n; i--) if ((u >> i) & 1n) return Number(63n - i);
  return 64;
}
function ctz64(u) {
  if (u === 0n) return 64;
  let c = 0;
  while (((u >> BigInt(c)) & 1n) === 0n) c++;
  return c;
}
function popcnt64(u) {
  let c = 0;
  while (u) { c += Number(u & 1n); u >>= 1n; }
  return c;
}
function truncI32(x, lo, hi) {
  if (!Number.isFinite(x)) return TRAP;
  const t = Math.trunc(x);
  if (t < lo || t > hi) return TRAP;
  return t | 0;
}
function satI32(x, lo, hi) {
  if (Number.isNaN(x)) return 0;
  return Math.min(Math.max(Math.trunc(x), lo), hi) | 0;
}
function truncI64(x, signed) {
  if (!Number.isFinite(x)) return TRAP;
  const big = BigInt(Math.trunc(x));
  if (signed ? big < I64_MIN || big > I64_MAX : big < 0n || big > U64_MAX) return TRAP;
  return I64(big);
}
function satI64(x, signed) {
  const min = signed ? I64_MIN : 0n;
  const max = signed ? I64_MAX : U64_MAX;
  if (Number.isNaN(x)) return 0n;
  let big;
  if (x === Infinity) big = max;
  else if (x === -Infinity) big = min;
  else {
    big = BigInt(Math.trunc(x));
    if (big < min) big = min;
    if (big > max) big = max;
  }
  return I64(big);
}
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
function copysign(a, mag) {
  const m = Math.abs(a);
  return mag < 0 || Object.is(mag, -0) ? -m : m;
}

const fb = (op) => (a, c) => F(op(F(a), F(c))); // f32 binary
const fu = (op) => (a) => F(op(F(a))); // f32 unary
const cmp32 = (op) => (a, c) => b(op(F(a), F(c)));
const rot32 = (dir) => (a, c) => {
  const r = c & 31;
  return dir === "l" ? ((a << r) | (a >>> (32 - r))) | 0 : ((a >>> r) | (a << (32 - r))) | 0;
};

const REFS = {
  // i32 comparisons
  "i32.eqz": (a) => b(a === 0),
  "i32.eq": (a, c) => b(a === c),
  "i32.ne": (a, c) => b(a !== c),
  "i32.lt_s": (a, c) => b(a < c),
  "i32.lt_u": (a, c) => b(U32(a) < U32(c)),
  "i32.gt_s": (a, c) => b(a > c),
  "i32.gt_u": (a, c) => b(U32(a) > U32(c)),
  "i32.le_s": (a, c) => b(a <= c),
  "i32.le_u": (a, c) => b(U32(a) <= U32(c)),
  "i32.ge_s": (a, c) => b(a >= c),
  "i32.ge_u": (a, c) => b(U32(a) >= U32(c)),
  // i64 comparisons
  "i64.eqz": (a) => b(a === 0n),
  "i64.eq": (a, c) => b(a === c),
  "i64.ne": (a, c) => b(a !== c),
  "i64.lt_s": (a, c) => b(a < c),
  "i64.lt_u": (a, c) => b(U64(a) < U64(c)),
  "i64.gt_s": (a, c) => b(a > c),
  "i64.gt_u": (a, c) => b(U64(a) > U64(c)),
  "i64.le_s": (a, c) => b(a <= c),
  "i64.le_u": (a, c) => b(U64(a) <= U64(c)),
  "i64.ge_s": (a, c) => b(a >= c),
  "i64.ge_u": (a, c) => b(U64(a) >= U64(c)),
  // f32 comparisons
  "f32.eq": cmp32((a, c) => a === c),
  "f32.ne": cmp32((a, c) => a !== c),
  "f32.lt": cmp32((a, c) => a < c),
  "f32.gt": cmp32((a, c) => a > c),
  "f32.le": cmp32((a, c) => a <= c),
  "f32.ge": cmp32((a, c) => a >= c),
  // f64 comparisons
  "f64.eq": (a, c) => b(a === c),
  "f64.ne": (a, c) => b(a !== c),
  "f64.lt": (a, c) => b(a < c),
  "f64.gt": (a, c) => b(a > c),
  "f64.le": (a, c) => b(a <= c),
  "f64.ge": (a, c) => b(a >= c),
  // i32 arithmetic
  "i32.clz": (a) => Math.clz32(U32(a)),
  "i32.ctz": (a) => (a === 0 ? 32 : 31 - Math.clz32(U32(a & -a))),
  "i32.popcnt": popcnt32,
  "i32.add": (a, c) => (a + c) | 0,
  "i32.sub": (a, c) => (a - c) | 0,
  "i32.mul": (a, c) => Math.imul(a, c),
  "i32.div_s": (a, c) => (c === 0 || (a === -0x80000000 && c === -1) ? TRAP : (a / c) | 0),
  "i32.div_u": (a, c) => (c === 0 ? TRAP : (U32(a) / U32(c)) | 0),
  "i32.rem_s": (a, c) => (c === 0 ? TRAP : (a % c) | 0),
  "i32.rem_u": (a, c) => (c === 0 ? TRAP : (U32(a) % U32(c)) | 0),
  "i32.and": (a, c) => a & c,
  "i32.or": (a, c) => a | c,
  "i32.xor": (a, c) => a ^ c,
  "i32.shl": (a, c) => (a << (c & 31)) | 0,
  "i32.shr_s": (a, c) => a >> (c & 31),
  "i32.shr_u": (a, c) => (a >>> (c & 31)) | 0,
  "i32.rotl": rot32("l"),
  "i32.rotr": rot32("r"),
  // i64 arithmetic
  "i64.clz": (a) => BigInt(clz64(U64(a))),
  "i64.ctz": (a) => BigInt(ctz64(U64(a))),
  "i64.popcnt": (a) => BigInt(popcnt64(U64(a))),
  "i64.add": (a, c) => I64(a + c),
  "i64.sub": (a, c) => I64(a - c),
  "i64.mul": (a, c) => I64(a * c),
  "i64.div_s": (a, c) => (c === 0n || (a === I64_MIN && c === -1n) ? TRAP : I64(a / c)),
  "i64.div_u": (a, c) => (c === 0n ? TRAP : I64(U64(a) / U64(c))),
  "i64.rem_s": (a, c) => (c === 0n ? TRAP : I64(a % c)),
  "i64.rem_u": (a, c) => (c === 0n ? TRAP : I64(U64(a) % U64(c))),
  "i64.and": (a, c) => I64(a & c),
  "i64.or": (a, c) => I64(a | c),
  "i64.xor": (a, c) => I64(a ^ c),
  "i64.shl": (a, c) => I64(a << (c & 63n)),
  "i64.shr_s": (a, c) => I64(a >> (c & 63n)),
  "i64.shr_u": (a, c) => I64(U64(a) >> (c & 63n)),
  "i64.rotl": (a, c) => {
    const r = c & 63n;
    const u = U64(a);
    return I64(U64(u << r) | (u >> ((64n - r) & 63n)));
  },
  "i64.rotr": (a, c) => {
    const r = c & 63n;
    const u = U64(a);
    return I64((u >> r) | U64(u << ((64n - r) & 63n)));
  },
  // f32 arithmetic
  "f32.abs": fu(Math.abs),
  "f32.neg": fu((x) => -x),
  "f32.ceil": fu(Math.ceil),
  "f32.floor": fu(Math.floor),
  "f32.trunc": fu(Math.trunc),
  "f32.nearest": fu(nearest),
  "f32.sqrt": fu(Math.sqrt),
  "f32.add": fb((x, y) => x + y),
  "f32.sub": fb((x, y) => x - y),
  "f32.mul": fb((x, y) => x * y),
  "f32.div": fb((x, y) => x / y),
  "f32.min": fb(Math.min),
  "f32.max": fb(Math.max),
  "f32.copysign": fb(copysign),
  // f64 arithmetic
  "f64.abs": Math.abs,
  "f64.neg": (a) => -a,
  "f64.ceil": Math.ceil,
  "f64.floor": Math.floor,
  "f64.trunc": Math.trunc,
  "f64.nearest": nearest,
  "f64.sqrt": Math.sqrt,
  "f64.add": (a, c) => a + c,
  "f64.sub": (a, c) => a - c,
  "f64.mul": (a, c) => a * c,
  "f64.div": (a, c) => a / c,
  "f64.min": Math.min,
  "f64.max": Math.max,
  "f64.copysign": copysign,
  // conversions
  "i32.wrap_i64": (a) => Number(BigInt.asIntN(32, a)),
  "i32.trunc_f32_s": (a) => truncI32(F(a), -0x80000000, 0x7fffffff),
  "i32.trunc_f32_u": (a) => truncI32(F(a), 0, 0xffffffff),
  "i32.trunc_f64_s": (a) => truncI32(a, -0x80000000, 0x7fffffff),
  "i32.trunc_f64_u": (a) => truncI32(a, 0, 0xffffffff),
  "i64.extend_i32_s": (a) => BigInt(a),
  "i64.extend_i32_u": (a) => BigInt(U32(a)),
  "i64.trunc_f32_s": (a) => truncI64(F(a), true),
  "i64.trunc_f32_u": (a) => truncI64(F(a), false),
  "i64.trunc_f64_s": (a) => truncI64(a, true),
  "i64.trunc_f64_u": (a) => truncI64(a, false),
  "f32.convert_i32_s": (a) => F(a),
  "f32.convert_i32_u": (a) => F(U32(a)),
  "f32.convert_i64_s": (a) => F(Number(a)),
  "f32.convert_i64_u": (a) => F(Number(U64(a))),
  "f32.demote_f64": (a) => F(a),
  "f64.convert_i32_s": (a) => a,
  "f64.convert_i32_u": (a) => U32(a),
  "f64.convert_i64_s": (a) => Number(a),
  "f64.convert_i64_u": (a) => Number(U64(a)),
  "f64.promote_f32": (a) => F(a),
  "i32.reinterpret_f32": (a) => { dv.setFloat32(0, F(a), true); return dv.getInt32(0, true); },
  "i64.reinterpret_f64": (a) => { dv.setFloat64(0, a, true); return dv.getBigInt64(0, true); },
  "f32.reinterpret_i32": (a) => { dv.setInt32(0, a, true); return dv.getFloat32(0, true); },
  "f64.reinterpret_i64": (a) => { dv.setBigInt64(0, a, true); return dv.getFloat64(0, true); },
  // sign extension
  "i32.extend8_s": (a) => (a << 24) >> 24,
  "i32.extend16_s": (a) => (a << 16) >> 16,
  "i64.extend8_s": (a) => BigInt.asIntN(8, a),
  "i64.extend16_s": (a) => BigInt.asIntN(16, a),
  "i64.extend32_s": (a) => BigInt.asIntN(32, a),
  // non-trapping conversions
  "i32.trunc_sat_f32_s": (a) => satI32(F(a), -0x80000000, 0x7fffffff),
  "i32.trunc_sat_f32_u": (a) => satI32(F(a), 0, 0xffffffff),
  "i32.trunc_sat_f64_s": (a) => satI32(a, -0x80000000, 0x7fffffff),
  "i32.trunc_sat_f64_u": (a) => satI32(a, 0, 0xffffffff),
  "i64.trunc_sat_f32_s": (a) => satI64(F(a), true),
  "i64.trunc_sat_f32_u": (a) => satI64(F(a), false),
  "i64.trunc_sat_f64_s": (a) => satI64(a, true),
  "i64.trunc_sat_f64_u": (a) => satI64(a, false),
};

// NaN payload bits are not portably observable across the JS boundary, and
// NaN's sign bit is unspecified for host-supplied NaN — skip those few cases.
REFS["select.select"] = (cond, a, c) => (cond !== 0 ? a : c);
REFS["bool.of"] = (x) => (typeof x === "bigint" ? (x !== 0n ? 1 : 0) : (x !== 0 ? 1 : 0));
REFS["f32.select"] = (cond, a, c) => F(cond !== 0 ? a : c);

const SKIP = {
  "i32.reinterpret_f32": (a) => Number.isNaN(a),
  "i64.reinterpret_f64": (a) => Number.isNaN(a),
  "f32.copysign": (a, c) => Number.isNaN(c),
  "f64.copysign": (a, c) => Number.isNaN(c),
};

const VECTORS = {
  i32: [0, 1, -1, 2, -5, 31, 32, 0x7fffffff, -0x80000000, 0xdeadbeef | 0],
  i64: [0n, 1n, -1n, 2n, -5n, 63n, 64n, I64_MAX, I64_MIN, 0x0123456789abcdefn],
  f32: [0, -0, 1, -1, 0.5, -2.5, 3.5, 100.75, 1e30, -1e30, Infinity, -Infinity, NaN],
  f64: [0, -0, 1, -1, 0.5, -2.5, 3.5, 100.75, 1e30, -1e30, Infinity, -Infinity, NaN],
};

function combos(params) {
  let acc = [[]];
  for (const p of params) {
    const next = [];
    for (const prefix of acc) for (const v of VECTORS[p]) next.push([...prefix, v]);
    acc = next;
  }
  return acc;
}

function same(actual, expected) {
  if (typeof actual === "number" && Number.isNaN(actual) && Number.isNaN(expected)) return true;
  return Object.is(actual, expected);
}

test("every public constructor selects and executes its spec instruction", async () => {
  const items = VENEER_OPS.filter((v) => !v.mem);
  const mod = new Module();
  const nameOf = (v) => `${v.ns}.${v.name}(${v.params.map((p) => p.name).join(",")})`;
  for (const v of items) {
    mod.function(v.params, v.results)
      .export(nameOf(v))
      .body((...args) => {
        const $ = args.pop();
        $.return(NS[v.ns][v.name](...args));
      });
  }
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "sweep module failed validation");
  const { instance } = await WebAssembly.instantiate(bytes);

  let cases = 0;
  for (const v of items) {
    const specKey = `${v.entry.ns}.${v.entry.name}`;
    const ref = REFS[`${v.ns}.${v.name}`] ?? REFS[specKey];
    assert.ok(ref, `missing reference implementation for ${specKey} — add one to this sweep`);
    const fn = instance.exports[nameOf(v)];
    const vectors = combos(v.params.map((p) => p.wasmType.name));
    for (const args of vectors) {
      if (SKIP[specKey]?.(...args)) continue;
      const label = `${nameOf(v)} [${specKey}] (${args.map(String).join(", ")})`;
      const expected = ref(...args);
      if (expected === TRAP) {
        assert.throws(() => fn(...args), WebAssembly.RuntimeError, `${label} should trap`);
      } else {
        const actual = fn(...args);
        assert.ok(same(actual, expected), `${label}: expected ${expected}, got ${actual}`);
      }
      cases++;
    }
  }
  assert.ok(cases > 5000, `sweep only ran ${cases} cases`);
});

test("every optable entry is reachable through some public constructor", () => {
  const covered = new Set(VENEER_OPS.map((v) => `${v.entry.ns}.${v.entry.name}`));
  for (const e of OPTABLE) {
    assert.ok(covered.has(`${e.ns}.${e.name}`), `optable entry ${e.ns}.${e.name} is orphaned`);
  }
});
