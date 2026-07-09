import { fail } from "./errors.js";
import { OPTABLE } from "./optable.js";
import {
  i32 as I32, i64 as I64, f32, f64, s32, u32, s64, u64, bool, funcref, externref, exnref, isRef, isVec,
  makeTypedRefs,
  s8x16, u8x16, s16x8, u16x8, s32x4, u32x4, s64x2, u64x2, f32x4, f64x2, m8x16, m16x8, m32x4, m64x2,
} from "./types.js";
import { makeNode, resolveOperand, setCoercion } from "./node.js";
import { requireBuilder, currentBuilder } from "./context.js";

// Signedness lives in the public type (s32/u32/s64/u64); the optable stays
// spec-shaped (i32.div_s, …). This module maps each public constructor to the
// spec instruction it selects: suffix-less names (`u32.div` → i32.div_u) and
// operand-driven conversions (`f64.convert(x)` picks by x's type).

const ENTRIES = new Map(OPTABLE.map((e) => [`${e.ns}.${e.name}`, e]));
function entryOf(key) {
  const e = ENTRIES.get(key);
  if (!e) throw new Error(`internal: no optable entry ${key}`);
  return e;
}

/**
 * Registry of every public instruction constructor: one item per overload.
 * { ns, name, params: ValType[], results: ValType[], entry, mem? }
 * The opcode sweep test iterates this to verify variant selection.
 */
export const VENEER_OPS = [];

const U32_MAX = 0xffffffff;

// --- operand helpers ---------------------------------------------------------

/**
 * Any 32-bit integer — used where wasm is sign-agnostic by position.
 * bool is accepted too (0/1 fits exactly; safe promotion is the default).
 */
export function resolveInt32(x, what) {
  const v = resolveOperand(x, null, what);
  if (v.type.wasmType !== I32) {
    fail(`${what}: expected a 32-bit integer (s32 or u32), got ${v.type.name}`);
  }
  return v;
}

/** Zero-cost retype (same storage bits, new builder-level type). */
function retype(v, target) {
  return makeNode("cast", { type: target, results: [target], operands: [v], display: "implicit cast" });
}

/** Real ≠0 test (eqz twice — no constant needed). */
function truthiness(v, display) {
  const eqzEntry = entryOf(v.type.wasmType === I32 ? "i32.eqz" : "i64.eqz");
  const isZero = makeNode("op", { results: [bool], entry: eqzEntry, operands: [v], display });
  return makeNode("op", { results: [bool], entry: entryOf("i32.eqz"), operands: [isZero], display });
}

/**
 * Conditions are strictly bool — comparisons produce it; bool.of(x) tests
 * integers. Under permissive mode integers are accepted: 32-bit ones retype
 * for free (the consuming br_if/select already tests non-zero), 64-bit ones
 * insert a real ≠0 test.
 */
export function resolveBool(x, what) {
  const v = resolveOperand(x, null, what);
  if (v.type === bool) return v;
  const b = requireBuilder(what);
  if (b.module.permissive) {
    if (v.type.wasmType === I32 && v.type !== bool) return retype(v, bool);
    if (v.type.wasmType === I64) return truthiness(v, "implicit bool.of");
  }
  fail(`${what}: expected bool (comparisons produce bool; use bool.of(x) to test an integer), got ${v.type.name}`);
}

// --- constants ---------------------------------------------------------------

function defIntConst(type, lo, hi, wrapBase) {
  type.const = function (v) {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      fail(`${type.name}.const: expected an integer, got ${typeof v === "number" ? v : typeof v}`);
    }
    if (v < lo || v > hi) fail(`${type.name}.const: ${v} is outside [${lo}, ${hi}]`);
    const signed = v > 0x7fffffff ? v - wrapBase : v;
    return makeNode("const", { type, results: [type], value: signed });
  };
}

function defBigConst(type, lo, hi, wrapBase) {
  type.const = function (v) {
    let big;
    if (typeof v === "bigint") big = v;
    else if (typeof v === "number" && Number.isSafeInteger(v)) big = BigInt(v);
    else {
      fail(`${type.name}.const: expected a BigInt or safe integer, got ${typeof v === "number" ? v : typeof v}`);
    }
    if (big < lo || big > hi) fail(`${type.name}.const: ${big} is outside [${lo}, ${hi}]`);
    const signed = big > 0x7fffffffffffffffn ? big - wrapBase : big;
    return makeNode("const", { type, results: [type], value: signed });
  };
}

defIntConst(s32, -0x80000000, 0x7fffffff, 0);
defIntConst(u32, 0, U32_MAX, 0x100000000);
defBigConst(s64, -(2n ** 63n), 2n ** 63n - 1n, 0n);
defBigConst(u64, 0n, 2n ** 64n - 1n, 2n ** 64n);

f32.const = function (v) {
  if (typeof v !== "number") fail(`f32.const: expected a number, got ${typeof v}`);
  return makeNode("const", { type: f32, results: [f32], value: v });
};
f64.const = function (v) {
  if (typeof v !== "number") fail(`f64.const: expected a number, got ${typeof v}`);
  return makeNode("const", { type: f64, results: [f64], value: v });
};

bool.const = function (v) {
  if (typeof v !== "boolean") {
    fail(`bool.const: expected true or false, got ${typeof v === "number" ? v : typeof v}`);
  }
  return makeNode("const", { type: bool, results: [bool], value: v ? 1 : 0 });
};

// --- casts (zero-cost retype between signednesses of the same width) ----------

function defCast(target, froms) {
  target.cast = function (x) {
    const what = `${target.name}.cast`;
    const v = resolveOperand(x, null, what);
    if (!froms.includes(v.type)) {
      fail(`${what}: expected ${froms.map((f) => f.name).join(" or ")}, got ${v.type.name}`);
    }
    return makeNode("cast", { type: target, results: [target], operands: [v], display: what });
  };
}
// bool → s32/u32 is sound for free (values are provably 0/1); there is no
// int → bool cast — use bool.of(x) or a comparison.
defCast(s32, [u32, bool]);
defCast(u32, [s32, bool]);
defCast(s64, [u64]);
defCast(u64, [s64]);

// --- constructor generation ----------------------------------------------------

const ANY32 = Symbol("any 32-bit integer");

function defOp(nsType, name, entry, params, results) {
  const display = `${nsType.name}.${name}`;
  if (entry.mem) {
    nsType[name] = makeMemConstructor(entry, params, results, display);
  } else {
    nsType[name] = function (...args) {
      if (args.length !== params.length) {
        fail(`${display}: expected ${params.length} operand(s), got ${args.length}`);
      }
      const operands = params.map((t, idx) =>
        t === ANY32
          ? resolveInt32(args[idx], `${display} operand ${idx + 1}`)
          : resolveOperand(args[idx], t, `${display} operand ${idx + 1}`),
      );
      return makeNode(
        "op",
        { results, entry, operands, display },
        { anchor: results.length === 0 },
      );
    };
  }
  VENEER_OPS.push({
    ns: nsType.name,
    name,
    params: params.map((p) => (p === ANY32 ? s32 : p)),
    any32: params.some((p) => p === ANY32) ? params.map((p) => p === ANY32) : undefined,
    results,
    entry,
    mem: entry.mem,
  });
}

/** Operand-driven overloads: one name, variant selected by the operand's type. */
function defConversion(nsType, name, overloads) {
  const display = `${nsType.name}.${name}`;
  nsType[name] = function (x) {
    const v = resolveOperand(x, null, display);
    const match = overloads.find((o) => o.from === v.type);
    if (!match) {
      const accepted = overloads.map((o) => o.from.name).join(" or ");
      fail(`${display}: expected ${accepted}, got ${v.type.name}`);
    }
    return makeNode("op", { results: [nsType], entry: match.entry, operands: [v], display });
  };
  for (const o of overloads) {
    VENEER_OPS.push({ ns: nsType.name, name, params: [o.from], results: [nsType], entry: o.entry });
  }
}

function checkMemArgs(mem, opts, entry, what) {
  const b = requireBuilder(what);
  if (mem?.handleKind !== "memory") fail(`${what}: first argument must be a memory handle`);
  if (mem.module !== b.module) fail(`${what}: memory belongs to a different module`);
  const align = opts.align ?? entry.size;
  if (!Number.isInteger(align) || align <= 0 || (align & (align - 1)) !== 0 || align > entry.size) {
    fail(`${what}: align must be a power of two ≤ ${entry.size} (bytes), got ${align}`);
  }
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > U32_MAX) {
    fail(`${what}: offset must be an integer in [0, 2^32), got ${offset}`);
  }
  return { align: Math.log2(align), offset };
}

function makeMemConstructor(entry, params, results, display) {
  if (entry.mem === "load") {
    return function (mem, addr, opts = {}) {
      const memarg = checkMemArgs(mem, opts, entry, display);
      const a = resolveInt32(addr, `${display} address`);
      return makeNode("op", { results, entry, operands: [a], mem, memarg, display });
    };
  }
  return function (mem, addr, value, opts = {}) {
    const memarg = checkMemArgs(mem, opts, entry, display);
    const a = resolveInt32(addr, `${display} address`);
    const v = resolveOperand(value, params[1], `${display} value`);
    return makeNode("op", { results, entry, operands: [a, v], mem, memarg, display }, { anchor: true });
  };
}

// --- integer namespaces --------------------------------------------------------

function buildIntNamespace(T, st, signed) {
  const sfx = signed ? "_s" : "_u";
  const e = (name) => entryOf(`${st}.${name}`);

  // Sign-agnostic
  for (const name of ["add", "sub", "mul", "and", "or", "xor", "shl", "rotl", "rotr"]) {
    defOp(T, name, e(name), [T, T], [T]);
  }
  for (const name of ["clz", "ctz", "popcnt"]) defOp(T, name, e(name), [T], [T]);
  defOp(T, "eqz", e("eqz"), [T], [bool]);
  defOp(T, "eq", e("eq"), [T, T], [bool]);
  defOp(T, "ne", e("ne"), [T, T], [bool]);

  // Signedness-selected (the suffix comes from the namespace)
  for (const name of ["div", "rem", "shr"]) defOp(T, name, e(name + sfx), [T, T], [T]);
  for (const name of ["lt", "gt", "le", "ge"]) defOp(T, name, e(name + sfx), [T, T], [bool]);

  // In-place sign extension is inherently signed
  if (signed) {
    defOp(T, "extend8", e("extend8_s"), [T], [T]);
    defOp(T, "extend16", e("extend16_s"), [T], [T]);
    if (st === "i64") defOp(T, "extend32", e("extend32_s"), [T], [T]);
  }

  // Memory — extension signedness of sized loads comes from the type;
  // stores are sign-agnostic and exist on both namespaces.
  defOp(T, "load", e("load"), [ANY32], [T]);
  defOp(T, "store", e("store"), [ANY32, T], []);
  defOp(T, "load8", e(`load8${sfx}`), [ANY32], [T]);
  defOp(T, "load16", e(`load16${sfx}`), [ANY32], [T]);
  defOp(T, "store8", e("store8"), [ANY32, T], []);
  defOp(T, "store16", e("store16"), [ANY32, T], []);
  if (st === "i64") {
    defOp(T, "load32", e(`load32${sfx}`), [ANY32], [T]);
    defOp(T, "store32", e("store32"), [ANY32, T], []);
  }

  // Conversions (operand-driven)
  if (st === "i32") {
    defConversion(T, "wrap", [
      { from: s64, entry: entryOf("i32.wrap_i64") },
      { from: u64, entry: entryOf("i32.wrap_i64") },
    ]);
    defConversion(T, "trunc", [
      { from: f32, entry: entryOf(`i32.trunc_f32${sfx}`) },
      { from: f64, entry: entryOf(`i32.trunc_f64${sfx}`) },
    ]);
    defConversion(T, "trunc_sat", [
      { from: f32, entry: entryOf(`i32.trunc_sat_f32${sfx}`) },
      { from: f64, entry: entryOf(`i32.trunc_sat_f64${sfx}`) },
    ]);
    defConversion(T, "reinterpret", [{ from: f32, entry: entryOf("i32.reinterpret_f32") }]);
  } else {
    defConversion(T, "extend", [
      { from: signed ? s32 : u32, entry: entryOf(`i64.extend_i32${sfx}`) },
    ]);
    defConversion(T, "trunc", [
      { from: f32, entry: entryOf(`i64.trunc_f32${sfx}`) },
      { from: f64, entry: entryOf(`i64.trunc_f64${sfx}`) },
    ]);
    defConversion(T, "trunc_sat", [
      { from: f32, entry: entryOf(`i64.trunc_sat_f32${sfx}`) },
      { from: f64, entry: entryOf(`i64.trunc_sat_f64${sfx}`) },
    ]);
    defConversion(T, "reinterpret", [{ from: f64, entry: entryOf("i64.reinterpret_f64") }]);
  }
}

buildIntNamespace(s32, "i32", true);
buildIntNamespace(u32, "i32", false);
buildIntNamespace(s64, "i64", true);
buildIntNamespace(u64, "i64", false);

// --- extended constant expressions (wasm 3.0) ----------------------------------
// Outside any function body, add/sub/mul on the integer namespaces build
// constant-expression trees: operands are consts, immutable module variables,
// or other constant expressions — usable as module-variable inits and
// data/element offsets. Inside a body the same constructors are ordinary
// runtime ops (one concept, context decides).

function resolveConstOperand(x, T, what) {
  if (x?.handleKind === "variable" && x.scope === "module") {
    if (x.type !== T) fail(`${what}: expected ${T.name}, got ${x.type.name}`);
    return makeNode("globalref", { type: T, results: [T], variable: x });
  }
  if (x && (x.kind === "constop" || x.kind === "const")) {
    if (x.type !== T) {
      const lifted = x.kind === "const" ? promoteConst(x, T) : null;
      if (lifted) return lifted;
      fail(`${what}: expected ${T.name}, got ${x.type.name}`);
    }
    return x;
  }
  fail(
    `${what}: outside a function body this is a constant expression — operands must be ` +
    `${T.name}.const values, immutable module variables, or other constant add/sub/mul`,
  );
}

function defConstCapable(T, name) {
  const runtime = T[name];
  const entry = entryOf(`${T.wasmType.name}.${name}`);
  T[name] = function (a, c) {
    if (currentBuilder()) return runtime(a, c);
    const what = `${T.name}.${name}`;
    if (arguments.length !== 2) fail(`${what}: expected 2 operand(s), got ${arguments.length}`);
    const operands = [a, c].map((x, i) => resolveConstOperand(x, T, `${what} operand ${i + 1}`));
    return makeNode("constop", { type: T, results: [T], entry, operands });
  };
}
for (const T of [s32, u32, s64, u64]) {
  for (const name of ["add", "sub", "mul"]) defConstCapable(T, name);
}

/** Walk a constant-expression tree, calling fn on every module variable it reads. */
export function forEachConstRef(node, fn) {
  if (node.kind === "globalref") fn(node.variable);
  else if (node.kind === "constop") for (const o of node.operands) forEachConstRef(o, fn);
}

// --- float namespaces ------------------------------------------------------------

function buildFloatNamespace(T, st) {
  const e = (name) => entryOf(`${st}.${name}`);
  for (const name of ["abs", "neg", "ceil", "floor", "trunc", "nearest", "sqrt"]) {
    defOp(T, name, e(name), [T], [T]);
  }
  for (const name of ["add", "sub", "mul", "div", "min", "max", "copysign"]) {
    defOp(T, name, e(name), [T, T], [T]);
  }
  for (const name of ["eq", "ne", "lt", "gt", "le", "ge"]) {
    defOp(T, name, e(name), [T, T], [bool]);
  }
  defOp(T, "load", e("load"), [ANY32], [T]);
  defOp(T, "store", e("store"), [ANY32, T], []);

  const iw = (width, s) => entryOf(`${st}.convert_i${width}_${s}`);
  defConversion(T, "convert", [
    { from: s32, entry: iw(32, "s") },
    { from: u32, entry: iw(32, "u") },
    { from: s64, entry: iw(64, "s") },
    { from: u64, entry: iw(64, "u") },
  ]);
  if (st === "f32") {
    defConversion(T, "demote", [{ from: f64, entry: entryOf("f32.demote_f64") }]);
    defConversion(T, "reinterpret", [
      { from: s32, entry: entryOf("f32.reinterpret_i32") },
      { from: u32, entry: entryOf("f32.reinterpret_i32") },
    ]);
  } else {
    defConversion(T, "promote", [{ from: f32, entry: entryOf("f64.promote_f32") }]);
    defConversion(T, "reinterpret", [
      { from: s64, entry: entryOf("f64.reinterpret_i64") },
      { from: u64, entry: entryOf("f64.reinterpret_i64") },
    ]);
  }
}

buildFloatNamespace(f32, "f32");
buildFloatNamespace(f64, "f64");

// --- bool: logic over 0/1, strict conditions ----------------------------------
// Like select, these are values: NOT short-circuiting — both sides always
// evaluate. Use $.if for guarded evaluation.

defOp(bool, "and", entryOf("i32.and"), [bool, bool], [bool]);
defOp(bool, "or", entryOf("i32.or"), [bool, bool], [bool]);
defOp(bool, "xor", entryOf("i32.xor"), [bool, bool], [bool]);
defOp(bool, "not", entryOf("i32.eqz"), [bool], [bool]);

/** Truthiness: bool.of(x) means "x ≠ 0" for any integer type. */
bool.of = function (x) {
  const v = resolveOperand(x, null, "bool.of");
  if (v.type === bool || (v.type.wasmType !== I32 && v.type.wasmType !== I64)) {
    fail(`bool.of: expected an integer (s32/u32/s64/u64), got ${v.type.name}`);
  }
  return truthiness(v, "bool.of");
};
for (const [from, key] of [[s32, "i32.eqz"], [u32, "i32.eqz"], [s64, "i64.eqz"], [u64, "i64.eqz"]]) {
  VENEER_OPS.push({ ns: "bool", name: "of", params: [from], results: [bool], entry: entryOf(key) });
}

// --- references ----------------------------------------------------------------
// wasm 2.0 gives references almost no operations: null, is_null, select, and
// storage in variables/params/results/tables. No equality, no casts, never in
// linear memory, and neither promotion nor permissive mode touches them.

function buildRefNamespace(T) {
  /** Null reference — a constant expression, valid in initializers. */
  T.null = () => makeNode("const", { type: T, results: [T], value: null });
  T.is_null = (x) => {
    const what = `${T.name}.is_null`;
    const v = resolveOperand(x, T, what);
    return makeNode("op", { results: [bool], entry: entryOf("ref.is_null"), operands: [v], display: what });
  };
  VENEER_OPS.push({ ns: T.name, name: "is_null", params: [T], results: [bool], entry: entryOf("ref.is_null"), mem: "ref" });
}
buildRefNamespace(funcref);
buildRefNamespace(externref);
buildRefNamespace(exnref);

/**
 * Typed function references (wasm 3.0): build `sig.ref` / `sig.refNull` for a
 * funcType handle. The nullable side carries `null()`/`is_null` like funcref;
 * `sig.ref.of(x)` is the checked nullable→non-null bridge (ref.as_non_null,
 * traps on null). Upcasts — ref→refNull of the same signature, and any typed
 * ref→funcref — are value-exact promotions; there is no downcast.
 */
export function attachTypedRefs(sig, id) {
  const { ref, refNull } = makeTypedRefs(sig, `fn#${id}`);
  refNull.null = () => makeNode("const", { type: refNull, results: [refNull], value: null });
  refNull.is_null = (x) => {
    const what = `${refNull.name}.is_null`;
    const v = resolveOperand(x, refNull, what);
    return makeNode("op", { results: [bool], entry: entryOf("ref.is_null"), operands: [v], display: what });
  };
  ref.of = (x) => {
    const what = `${ref.name}.of`;
    const v = resolveOperand(x, refNull, what); // non-null promotes in; the check is then a no-op
    return makeNode("op", { results: [ref], entry: entryOf("ref.as_non_null"), operands: [v], display: what });
  };
  sig.ref = ref;
  sig.refNull = refNull;
}
VENEER_OPS.push({ ns: "ref", name: "as_non_null", params: [funcref], results: [funcref], entry: entryOf("ref.as_non_null"), mem: "ref" });

/** Zero-initialization value for a type: null for references, zero otherwise. */
export function defaultInit(type) {
  if (type.noDefault) {
    fail(`a ${type.name} variable has no default value (non-null references) — give it an initializer`);
  }
  if (isVec(type)) return makeNode("const", { type, results: [type], value: new Uint8Array(16) });
  return isRef(type) ? type.null() : type.const(type.zero);
}

// --- select: branchless ternary, typed by namespace ---------------------------
// NOTE: both arms are ALWAYS evaluated (select is not short-circuiting — that's
// its point: no branch). Use $.if when an arm has effects that must be guarded.

const SELECT_ENTRY = entryOf("select.select");

function defSelect(T) {
  const display = `${T.name}.select`;
  T.select = function (cond, ifTrue, ifFalse) {
    const c = resolveBool(cond, `${display} condition`);
    const a = resolveOperand(ifTrue, T, `${display} first arm`);
    const b = resolveOperand(ifFalse, T, `${display} second arm`);
    // wasm stack order: val1, val2, cond; reference arms need the typed encoding
    return makeNode("op", {
      results: [T],
      entry: SELECT_ENTRY,
      operands: [a, b, c],
      display,
      selectType: isRef(T) ? T : undefined,
    });
  };
  // params in constructor order (cond first) for the sweep
  VENEER_OPS.push({ ns: T.name, name: "select", params: [bool, T, T], results: [T], entry: SELECT_ENTRY, mem: isRef(T) ? "ref" : undefined });
}
for (const T of [bool, s32, u32, s64, u64, f32, f64, funcref, externref]) defSelect(T);

// --- SIMD: lane namespaces over v128 -------------------------------------------
// Lane namespaces carry signedness like the scalar types (s8x16.gt → i8x16.gt_s);
// comparisons produce mask types (m8x16 … m64x2), bitselect requires a
// shape-matched mask, and all v128 views retype into each other via `cast`.
// v128 never crosses the JS boundary and has no promotions — barriers are
// crossed only by explicit `cast`/conversions.

const VEC_TYPES = [s8x16, u8x16, s16x8, u16x8, s32x4, u32x4, s64x2, u64x2, f32x4, f64x2, m8x16, m16x8, m32x4, m64x2];
const MASK_BY_LANES = new Map([[16, m8x16], [8, m16x8], [4, m32x4], [2, m64x2]]);
const LANE_SCALAR = new Map([
  [s8x16, s32], [u8x16, u32], [s16x8, s32], [u16x8, u32],
  [s32x4, s32], [u32x4, u32], [s64x2, s64], [u64x2, u64],
  [f32x4, f32], [f64x2, f64],
]);
const V = (n) => entryOf(`v128.${n}`);
const VEC_VENEER_START = VENEER_OPS.length;

function defVecConst(T) {
  const { lanes, laneBits } = T;
  const signed = T.name[0] === "s";
  const float = T.name[0] === "f";
  T.const = function (vals) {
    if (!Array.isArray(vals) || vals.length !== lanes) {
      fail(`${T.name}.const: expected an array of ${lanes} lane values`);
    }
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    vals.forEach((v, i) => {
      const what = `${T.name}.const lane ${i}`;
      if (float) {
        if (typeof v !== "number") fail(`${what}: expected a number, got ${typeof v}`);
        if (laneBits === 32) view.setFloat32(i * 4, v, true);
        else view.setFloat64(i * 8, v, true);
      } else if (laneBits === 64) {
        let big;
        if (typeof v === "bigint") big = v;
        else if (typeof v === "number" && Number.isSafeInteger(v)) big = BigInt(v);
        else fail(`${what}: expected a BigInt or safe integer, got ${typeof v === "number" ? v : typeof v}`);
        const [lo, hi] = signed ? [-(2n ** 63n), 2n ** 63n - 1n] : [0n, 2n ** 64n - 1n];
        if (big < lo || big > hi) fail(`${what}: ${big} is outside [${lo}, ${hi}]`);
        view.setBigUint64(i * 8, BigInt.asUintN(64, big), true);
      } else {
        if (typeof v !== "number" || !Number.isInteger(v)) {
          fail(`${what}: expected an integer, got ${typeof v === "number" ? v : typeof v}`);
        }
        const [lo, hi] = signed
          ? [-(2 ** (laneBits - 1)), 2 ** (laneBits - 1) - 1]
          : [0, 2 ** laneBits - 1];
        if (v < lo || v > hi) fail(`${what}: ${v} is outside [${lo}, ${hi}]`);
        if (laneBits === 8) view.setUint8(i, v & 0xff);
        else if (laneBits === 16) view.setUint16(i * 2, v & 0xffff, true);
        else view.setUint32(i * 4, v >>> 0, true);
      }
    });
    return makeNode("const", { type: T, results: [T], value: bytes });
  };
}

function checkLaneIndex(lane, count, what) {
  if (!Number.isInteger(lane) || lane < 0 || lane >= count) {
    fail(`${what}: lane index must be an integer in [0, ${count}), got ${lane}`);
  }
}

function defExtract(T, entry, scalar) {
  const display = `${T.name}.extract`;
  T.extract = function (x, lane) {
    const v = resolveOperand(x, T, `${display} operand`);
    checkLaneIndex(lane, T.lanes, display);
    return makeNode("op", { results: [scalar], entry, operands: [v], lane, display });
  };
  VENEER_OPS.push({ ns: T.name, name: "extract", params: [T], results: [scalar], entry, laneCount: T.lanes });
}

function defReplace(T, entry, scalar) {
  const display = `${T.name}.replace`;
  T.replace = function (x, lane, value) {
    const v = resolveOperand(x, T, `${display} operand`);
    checkLaneIndex(lane, T.lanes, display);
    const s = resolveOperand(value, scalar, `${display} value`);
    return makeNode("op", { results: [T], entry, operands: [v, s], lane, display });
  };
  VENEER_OPS.push({ ns: T.name, name: "replace", params: [T, scalar], results: [T], entry, laneCount: T.lanes });
}

function defShuffle(T) {
  const entry = entryOf("i8x16.shuffle");
  const display = `${T.name}.shuffle`;
  T.shuffle = function (a, b, lanes) {
    const va = resolveOperand(a, T, `${display} first operand`);
    const vb = resolveOperand(b, T, `${display} second operand`);
    if (!Array.isArray(lanes) || lanes.length !== 16) {
      fail(`${display}: expected an array of 16 lane indices`);
    }
    for (const l of lanes) {
      if (!Number.isInteger(l) || l < 0 || l > 31) {
        fail(`${display}: lane indices select from both operands' 32 bytes — each must be in [0, 32), got ${l}`);
      }
    }
    return makeNode("op", { results: [T], entry, operands: [va, vb], lanes: Uint8Array.from(lanes), display });
  };
  VENEER_OPS.push({ ns: T.name, name: "shuffle", params: [T, T], results: [T], entry, shuffle: true });
}

function defLaneMem(T, name, entry) {
  const display = `${T.name}.${name}`;
  const isLoad = entry.mem === "load";
  T[name] = function (mem, addr, value, lane, opts = {}) {
    const memarg = checkMemArgs(mem, opts, entry, display);
    const a = resolveInt32(addr, `${display} address`);
    const v = resolveOperand(value, T, `${display} vector`);
    checkLaneIndex(lane, T.lanes, display);
    return makeNode(
      "op",
      { results: isLoad ? [T] : [], entry, operands: [a, v], mem, memarg, lane, display },
      { anchor: !isLoad },
    );
  };
  VENEER_OPS.push({
    ns: T.name, name, params: [T], results: isLoad ? [T] : [], entry, mem: entry.mem, laneCount: T.lanes,
  });
}

function buildVecBitwise(T) {
  defOp(T, "and", V("and"), [T, T], [T]);
  defOp(T, "or", V("or"), [T, T], [T]);
  defOp(T, "xor", V("xor"), [T, T], [T]);
  defOp(T, "andnot", V("andnot"), [T, T], [T]);
  defOp(T, "not", V("not"), [T], [T]);
}

function buildVecMem(T) {
  defOp(T, "load", V("load"), [ANY32], [T]);
  defOp(T, "store", V("store"), [ANY32, T], []);
  defOp(T, "load_splat", V(`load${T.laneBits}_splat`), [ANY32], [T]);
  if (T.laneBits >= 32) defOp(T, "load_zero", V(`load${T.laneBits}_zero`), [ANY32], [T]);
  defLaneMem(T, "load_lane", V(`load${T.laneBits}_lane`));
  defLaneMem(T, "store_lane", V(`store${T.laneBits}_lane`));
}

// Half-width source type for the widening families (extend/extmul/extadd),
// following the namespace's signedness.
const HALF = new Map([
  [s16x8, s8x16], [u16x8, u8x16],
  [s32x4, s16x8], [u32x4, u16x8],
  [s64x2, s32x4], [u64x2, u32x4],
]);

function buildVecIntNamespace(T, shape, signed) {
  const sfx = signed ? "_s" : "_u";
  const e = (n) => entryOf(`${shape}.${n}`);
  const M = MASK_BY_LANES.get(T.lanes);
  const scalar = LANE_SCALAR.get(T);
  const bits = T.laneBits;

  defVecConst(T);
  defOp(T, "splat", e("splat"), [scalar], [T]);
  defExtract(T, e(bits <= 16 ? `extract_lane${sfx}` : "extract_lane"), scalar);
  defReplace(T, e("replace_lane"), scalar);

  defOp(T, "eq", e("eq"), [T, T], [M]);
  defOp(T, "ne", e("ne"), [T, T], [M]);
  if (bits < 64 || signed) {
    // wasm has no unsigned 64-lane ordering — u64x2 gets only eq/ne
    for (const n of ["lt", "gt", "le", "ge"]) defOp(T, n, e(n + sfx), [T, T], [M]);
  }

  defOp(T, "add", e("add"), [T, T], [T]);
  defOp(T, "sub", e("sub"), [T, T], [T]);
  defOp(T, "neg", e("neg"), [T], [T]);
  if (bits >= 16) defOp(T, "mul", e("mul"), [T, T], [T]);
  if (signed) defOp(T, "abs", e("abs"), [T], [T]);
  defOp(T, "shl", e("shl"), [T, ANY32], [T]);
  defOp(T, "shr", e(`shr${sfx}`), [T, ANY32], [T]);
  buildVecBitwise(T);
  defOp(T, "bitselect", V("bitselect"), [T, T, M], [T]);
  if (bits <= 16) {
    defOp(T, "add_sat", e(`add_sat${sfx}`), [T, T], [T]);
    defOp(T, "sub_sat", e(`sub_sat${sfx}`), [T, T], [T]);
  }
  if (bits <= 32) {
    defOp(T, "min", e(`min${sfx}`), [T, T], [T]);
    defOp(T, "max", e(`max${sfx}`), [T, T], [T]);
  }
  if (bits <= 16 && !signed) defOp(T, "avgr", e("avgr_u"), [T, T], [T]);
  if (bits === 8) {
    defOp(T, "popcnt", e("popcnt"), [T], [T]);
    defOp(T, "swizzle", e("swizzle"), [T, T], [T]);
    defShuffle(T);
  }
  if (T === s16x8) defOp(T, "q15mulr_sat", e("q15mulr_sat_s"), [T, T], [T]);
  if (T === s32x4) defOp(T, "dot", e("dot_i16x8_s"), [s16x8, s16x8], [T]);

  const src = HALF.get(T);
  if (src) {
    const srcShape = `i${src.laneBits}x${src.lanes}`;
    defOp(T, "extend_low", e(`extend_low_${srcShape}${sfx}`), [src], [T]);
    defOp(T, "extend_high", e(`extend_high_${srcShape}${sfx}`), [src], [T]);
    defOp(T, "extmul_low", e(`extmul_low_${srcShape}${sfx}`), [src, src], [T]);
    defOp(T, "extmul_high", e(`extmul_high_${srcShape}${sfx}`), [src, src], [T]);
    if (bits <= 32) defOp(T, "extadd_pairwise", e(`extadd_pairwise_${srcShape}${sfx}`), [src], [T]);
    defOp(T, `load${bits / 2}x${T.lanes}`, V(`load${bits / 2}x${T.lanes}${sfx}`), [ANY32], [T]);
  }
  if (bits <= 16) {
    // narrow saturates SIGNED wider lanes; the namespace picks the treatment
    const wideSrc = bits === 8 ? s16x8 : s32x4;
    defOp(T, "narrow", e(`narrow_i${bits * 2}x${T.lanes / 2}${sfx}`), [wideSrc, wideSrc], [T]);
  }
  if (T === s32x4 || T === u32x4) {
    defConversion(T, "trunc_sat", [{ from: f32x4, entry: e(`trunc_sat_f32x4${sfx}`) }]);
    defConversion(T, "trunc_sat_zero", [{ from: f64x2, entry: e(`trunc_sat_f64x2${sfx}_zero`) }]);
  }
  buildVecMem(T);
}

function buildVecFloatNamespace(T, shape) {
  const e = (n) => entryOf(`${shape}.${n}`);
  const M = MASK_BY_LANES.get(T.lanes);
  const scalar = LANE_SCALAR.get(T);

  defVecConst(T);
  defOp(T, "splat", e("splat"), [scalar], [T]);
  defExtract(T, e("extract_lane"), scalar);
  defReplace(T, e("replace_lane"), scalar);
  for (const n of ["eq", "ne", "lt", "gt", "le", "ge"]) defOp(T, n, e(n), [T, T], [M]);
  for (const n of ["abs", "neg", "sqrt", "ceil", "floor", "trunc", "nearest"]) defOp(T, n, e(n), [T], [T]);
  for (const n of ["add", "sub", "mul", "div", "min", "max", "pmin", "pmax"]) defOp(T, n, e(n), [T, T], [T]);
  defOp(T, "bitselect", V("bitselect"), [T, T, M], [T]);
  if (T === f32x4) {
    defConversion(T, "convert", [
      { from: s32x4, entry: e("convert_i32x4_s") },
      { from: u32x4, entry: e("convert_i32x4_u") },
    ]);
    defConversion(T, "demote_zero", [{ from: f64x2, entry: e("demote_f64x2_zero") }]);
  } else {
    defConversion(T, "convert_low", [
      { from: s32x4, entry: e("convert_low_i32x4_s") },
      { from: u32x4, entry: e("convert_low_i32x4_u") },
    ]);
    defConversion(T, "promote_low", [{ from: f32x4, entry: e("promote_low_f32x4") }]);
  }
  buildVecMem(T);
}

function buildMaskNamespace(M, shape) {
  buildVecBitwise(M);
  defOp(M, "any_true", V("any_true"), [M], [bool]);
  defOp(M, "all_true", entryOf(`${shape}.all_true`), [M], [bool]);
  defOp(M, "bitmask", entryOf(`${shape}.bitmask`), [M], [u32]);
}

buildVecIntNamespace(s8x16, "i8x16", true);
buildVecIntNamespace(u8x16, "i8x16", false);
buildVecIntNamespace(s16x8, "i16x8", true);
buildVecIntNamespace(u16x8, "i16x8", false);
buildVecIntNamespace(s32x4, "i32x4", true);
buildVecIntNamespace(u32x4, "i32x4", false);
buildVecIntNamespace(s64x2, "i64x2", true);
buildVecIntNamespace(u64x2, "i64x2", false);
buildVecFloatNamespace(f32x4, "f32x4");
buildVecFloatNamespace(f64x2, "f64x2");
buildMaskNamespace(m8x16, "i8x16");
buildMaskNamespace(m16x8, "i16x8");
buildMaskNamespace(m32x4, "i32x4");
buildMaskNamespace(m64x2, "i64x2");

// Every v128 view retypes into every other at zero cost — reinterpretation
// is free at the storage level (there is no wasm instruction to select).
for (const T of VEC_TYPES) defCast(T, VEC_TYPES.filter((x) => x !== T));

// Vector constructors can't round-trip scalars across the JS boundary; the
// dedicated SIMD sweep exercises them through linear memory instead.
for (let i = VEC_VENEER_START; i < VENEER_OPS.length; i++) VENEER_OPS[i].vec = true;

// --- bulk memory operations (surfaced as methods on the memory/data handles) --

function checkMemHandle(mem, what) {
  const b = requireBuilder(what);
  if (mem?.handleKind !== "memory") fail(`${what}: expected a memory handle`);
  if (mem.module !== b.module) fail(`${what}: memory belongs to a different module`);
  return b;
}

function checkSegHandle(seg, module, what) {
  if (seg?.handleKind !== "data") fail(`${what}: expected a data segment handle`);
  if (seg.module !== module) fail(`${what}: data segment belongs to a different module`);
}

const bulk = (name) => entryOf(`memory.${name}`);

/** Implementations behind MemoryHandle/DataSegment methods (module.js delegates here). */
export const MEMORY_OPS = {
  size(mem) {
    checkMemHandle(mem, "mem.size()");
    return makeNode("op", { results: [u32], entry: bulk("size"), operands: [], mem, display: "mem.size()" });
  },
  grow(mem, delta) {
    checkMemHandle(mem, "mem.grow()");
    const d = resolveInt32(delta, "mem.grow() delta");
    return makeNode("op", { results: [u32], entry: bulk("grow"), operands: [d], mem, display: "mem.grow()" });
  },
  fill(mem, dst, value, len) {
    checkMemHandle(mem, "mem.fill()");
    const operands = [
      resolveInt32(dst, "mem.fill() destination"),
      resolveInt32(value, "mem.fill() byte value"),
      resolveInt32(len, "mem.fill() length"),
    ];
    makeNode("op", { results: [], entry: bulk("fill"), operands, mem, display: "mem.fill()" }, { anchor: true });
  },
  copy(mem, dst, src, len, opts = {}) {
    checkMemHandle(mem, "mem.copy()");
    const from = opts.from ?? mem;
    if (from.handleKind !== "memory" || from.module !== mem.module) {
      fail("mem.copy(): `from` must be a memory handle from this module");
    }
    const operands = [
      resolveInt32(dst, "mem.copy() destination"),
      resolveInt32(src, "mem.copy() source"),
      resolveInt32(len, "mem.copy() length"),
    ];
    makeNode(
      "op",
      { results: [], entry: bulk("copy"), operands, mem, srcMem: from, display: "mem.copy()" },
      { anchor: true },
    );
  },
  init(mem, seg, dst, src, len) {
    const b = checkMemHandle(mem, "mem.init()");
    checkSegHandle(seg, b.module, "mem.init()");
    const operands = [
      resolveInt32(dst, "mem.init() destination"),
      resolveInt32(src, "mem.init() source offset"),
      resolveInt32(len, "mem.init() length"),
    ];
    makeNode(
      "op",
      { results: [], entry: bulk("init"), operands, mem, segment: seg, display: "mem.init()" },
      { anchor: true },
    );
  },
  dropData(seg) {
    const b = requireBuilder("seg.drop()");
    checkSegHandle(seg, b.module, "seg.drop()");
    makeNode(
      "op",
      { results: [], entry: entryOf("data.drop"), operands: [], segment: seg, display: "seg.drop()" },
      { anchor: true },
    );
  },
};

// --- table operations (surfaced as methods on the table/elem handles) ---------

function checkTableHandle(tbl, what) {
  const b = requireBuilder(what);
  if (tbl?.handleKind !== "table") fail(`${what}: expected a table handle`);
  if (tbl.module !== b.module) fail(`${what}: table belongs to a different module`);
  return b;
}

function checkElemHandle(seg, module, what) {
  if (seg?.handleKind !== "elem") fail(`${what}: expected an element segment handle`);
  if (seg.module !== module) fail(`${what}: element segment belongs to a different module`);
}

const tblOp = (name) => entryOf(`table.${name}`);

/** Implementations behind TableHandle/ElemSegment methods (module.js delegates here). */
export const TABLE_OPS = {
  get(tbl, index) {
    checkTableHandle(tbl, "tbl.get()");
    const i = resolveInt32(index, "tbl.get() index");
    return makeNode("op", { results: [tbl.elemType], entry: tblOp("get"), operands: [i], table: tbl, display: "tbl.get()" });
  },
  set(tbl, index, value) {
    checkTableHandle(tbl, "tbl.set()");
    const i = resolveInt32(index, "tbl.set() index");
    const v = resolveOperand(value, tbl.elemType, "tbl.set() value");
    makeNode("op", { results: [], entry: tblOp("set"), operands: [i, v], table: tbl, display: "tbl.set()" }, { anchor: true });
  },
  size(tbl) {
    checkTableHandle(tbl, "tbl.size()");
    return makeNode("op", { results: [u32], entry: tblOp("size"), operands: [], table: tbl, display: "tbl.size()" });
  },
  grow(tbl, delta, init) {
    checkTableHandle(tbl, "tbl.grow()");
    const d = resolveInt32(delta, "tbl.grow() delta");
    const v = init === undefined ? tbl.elemType.null() : resolveOperand(init, tbl.elemType, "tbl.grow() init");
    // wasm stack order: init value, then delta
    return makeNode("op", { results: [u32], entry: tblOp("grow"), operands: [v, d], table: tbl, display: "tbl.grow()" });
  },
  fill(tbl, start, value, len) {
    checkTableHandle(tbl, "tbl.fill()");
    const operands = [
      resolveInt32(start, "tbl.fill() start"),
      resolveOperand(value, tbl.elemType, "tbl.fill() value"),
      resolveInt32(len, "tbl.fill() length"),
    ];
    makeNode("op", { results: [], entry: tblOp("fill"), operands, table: tbl, display: "tbl.fill()" }, { anchor: true });
  },
  copy(tbl, dst, src, len, opts = {}) {
    checkTableHandle(tbl, "tbl.copy()");
    const from = opts.from ?? tbl;
    if (from.handleKind !== "table" || from.module !== tbl.module) {
      fail("tbl.copy(): `from` must be a table handle from this module");
    }
    if (from.elemType !== tbl.elemType) {
      fail(`tbl.copy(): element types must match (${tbl.elemType.name} vs ${from.elemType.name})`);
    }
    const operands = [
      resolveInt32(dst, "tbl.copy() destination"),
      resolveInt32(src, "tbl.copy() source"),
      resolveInt32(len, "tbl.copy() length"),
    ];
    makeNode("op", { results: [], entry: tblOp("copy"), operands, table: tbl, srcTable: from, display: "tbl.copy()" }, { anchor: true });
  },
  init(tbl, seg, dst, src, len) {
    const b = checkTableHandle(tbl, "tbl.init()");
    checkElemHandle(seg, b.module, "tbl.init()");
    if (tbl.elemType !== funcref) fail("tbl.init(): element segments hold funcref — the table must be funcref-typed");
    const operands = [
      resolveInt32(dst, "tbl.init() destination"),
      resolveInt32(src, "tbl.init() source offset"),
      resolveInt32(len, "tbl.init() length"),
    ];
    makeNode(
      "op",
      { results: [], entry: tblOp("init"), operands, table: tbl, segment: seg, display: "tbl.init()" },
      { anchor: true },
    );
  },
  dropElem(seg) {
    const b = requireBuilder("seg.drop()");
    checkElemHandle(seg, b.module, "seg.drop()");
    makeNode(
      "op",
      { results: [], entry: entryOf("elem.drop"), operands: [], segment: seg, display: "seg.drop()" },
      { anchor: true },
    );
  },
};

// Register the handle-method instructions for sweep coverage (a truthy `mem`
// marks them as not directly constructible/executable from a namespace).
for (const [ns, name, params, results] of [
  ["memory", "size", [], [u32]],
  ["memory", "grow", [u32], [u32]],
  ["memory", "fill", [u32, u32, u32], []],
  ["memory", "copy", [u32, u32, u32], []],
  ["memory", "init", [u32, u32, u32], []],
  ["data", "drop", [], []],
  ["table", "get", [u32], [funcref]],
  ["table", "set", [u32, funcref], []],
  ["table", "size", [], [u32]],
  ["table", "grow", [funcref, u32], [u32]],
  ["table", "fill", [u32, funcref, u32], []],
  ["table", "copy", [u32, u32, u32], []],
  ["table", "init", [u32, u32, u32], []],
  ["elem", "drop", [], []],
]) {
  VENEER_OPS.push({ ns, name, params, results, entry: entryOf(`${ns}.${name}`), mem: "bulk" });
}

// --- coercion ---------------------------------------------------------------
// Safe promotion is DEFAULT behavior: since the consuming op's namespace
// explicitly names the target type, any operand whose value fits it exactly
// lifts in — there is nothing implicit to guard. Lossy or narrowing moves
// (s64→f64, s32→f32, u32→s32, float→int, int→bool) always stay errors.
// `permissive` (per-Module flag) additionally allows bit-level reinterpretation
// within a storage width — that DOES change meaning, so it's opt-in.

const INTS = new Set([s32, u32, s64, u64]);

/** expected type → (operand type → conversion spec) — value-exact only */
const PROMOTIONS = new Map([
  [s64, new Map([[s32, "i64.extend_i32_s"], [u32, "i64.extend_i32_u"], [bool, "i64.extend_i32_u"]])],
  [u64, new Map([[u32, "i64.extend_i32_u"], [bool, "i64.extend_i32_u"]])],
  [s32, new Map([[bool, "retype"]])],
  [u32, new Map([[bool, "retype"]])],
  [f64, new Map([
    [f32, "f64.promote_f32"],
    [s32, "f64.convert_i32_s"],
    [u32, "f64.convert_i32_u"],
    [bool, "f64.convert_i32_u"],
  ])],
  [f32, new Map([[bool, "f32.convert_i32_u"]])],
]);

setCoercion((v, expected, builder) => {
  // Typed function reference upcasts are subtyping — value-exact, zero-cost.
  if (expected === funcref && v.type.heapType?.handleKind === "functype") return retype(v, funcref);
  if (expected.heapType && !expected.nonNull && v.type.nullableTwin === expected) {
    return retype(v, expected);
  }
  // GC upcasts: concrete refs lift through declared supertypes and into the
  // abstract hierarchy (structref/arrayref → eqref → anyref; i31ref too).
  {
    const vh = v.type.heapType;
    const gcKind = vh && vh.handleKind !== "functype" ? vh.handleKind : null;
    const isGCAbs = (t) => t.gcAbstract === true;
    if (isGCAbs(expected)) {
      const name = expected.name;
      const ok =
        (name === "anyref" && (gcKind || isGCAbs(v.type))) ||
        (name === "eqref" && (gcKind || v.type.name === "i31ref" || v.type.name === "structref" || v.type.name === "arrayref")) ||
        (name === "structref" && gcKind === "structtype") ||
        (name === "arrayref" && gcKind === "arraytype");
      if (ok && v.type !== expected && v.type.name !== "anyref") return retype(v, expected);
    }
    // concrete target: walk the declared supertype chain
    const eh = expected.heapType;
    if (eh && eh.handleKind === "structtype" && gcKind === "structtype") {
      for (let t = vh.superType; t; t = t.superType) {
        if (t === eh) {
          // subtype ref lifts into supertype slots; non-null only into ref
          if (!expected.nonNull || v.type.nonNull) return retype(v, expected);
          break;
        }
      }
    }
  }
  const spec = PROMOTIONS.get(expected)?.get(v.type);
  if (spec === "retype") return retype(v, expected);
  if (spec) {
    return makeNode("op", { results: [expected], entry: entryOf(spec), operands: [v], display: "promotion" });
  }
  if (builder.module.permissive) {
    // Same storage width, integer targets: a free retype.
    if (INTS.has(expected) && expected.wasmType === v.type.wasmType) {
      return retype(v, expected);
    }
    // Integer where a bool is expected: a real ≠0 test.
    if (expected === bool && INTS.has(v.type)) {
      return truthiness(v, "implicit bool.of");
    }
  }
  return null;
});

/**
 * Build-time promotion for constant expressions (global initializers): the
 * value converts at build time, so the result is still a plain t.const.
 * Returns a fresh const node of `target`, or null when not value-exact.
 */
export function promoteConst(node, target) {
  if (node.kind !== "const") return null;
  if (!PROMOTIONS.get(target)?.has(node.type)) return null;
  let v = node.value;
  if (node.type === u32 && v < 0) v += 0x100000000; // stored sign-normalized
  if (node.type === f32) v = Math.fround(v);
  if (target === s64 || target === u64) return target.const(BigInt(v));
  return target.const(v);
}

export { anyref, eqref, i31ref, structref, arrayref, i8, i16, imm } from "./types.js";
export {
  s32, u32, s64, u64, f32, f64, bool, funcref, externref, exnref,
  s8x16, u8x16, s16x8, u16x8, s32x4, u32x4, s64x2, u64x2, f32x4, f64x2, m8x16, m16x8, m32x4, m64x2,
};

// --- GC: structs, arrays, casts, i31, extern↔any (wasm 3.0) -------------------
// Struct/array type handles own their operations (attached below) and their
// reference types, mirroring funcType handles. `.ref.of(x)` is the TRAPPING
// downcast (ref.cast) and `.test(x)` the bool probe — upcasts, as everywhere,
// are value-exact promotions.

import { anyref, eqref, i31ref, structref, arrayref } from "./types.js";
const gcE = (k) => entryOf(k);

/** Is `t` a reference in the any-hierarchy (castable/testable)? */
function inAnyHierarchy(t) {
  return t.gcAbstract === true || (t.heapType !== undefined && t.heapType.handleKind !== "functype");
}

function resolveAnyRef(x, what) {
  const v = resolveOperand(x, null, what);
  if (!inAnyHierarchy(v.type)) {
    fail(`${what}: expected a GC reference (struct/array/i31/any hierarchy), got ${v.type.name}`);
  }
  return v;
}

/** .ref / .refNull for a struct or array handle: cast-flavored bridges. */
export function attachGCRefs(handle, label) {
  const { ref, refNull } = makeTypedRefs(handle, label);
  refNull.null = () => makeNode("const", { type: refNull, results: [refNull], value: null });
  refNull.is_null = (x) => {
    const what = `${refNull.name}.is_null`;
    const v = resolveOperand(x, refNull, what);
    return makeNode("op", { results: [bool], entry: gcE("ref.is_null"), operands: [v], display: what });
  };
  ref.of = (x) => {
    const what = `${ref.name}.of`;
    const v = resolveAnyRef(x, what);
    return makeNode("op", { results: [ref], entry: gcE("ref.cast"), operands: [v], gcType: handle, display: what });
  };
  refNull.of = (x) => {
    const what = `${refNull.name}.of`;
    const v = resolveAnyRef(x, what);
    return makeNode("op", { results: [refNull], entry: gcE("ref.cast_null"), operands: [v], gcType: handle, display: what });
  };
  handle.ref = ref;
  handle.refNull = refNull;
  handle.test = (x) => {
    const what = `${label}.test`;
    const v = resolveAnyRef(x, what);
    return makeNode("op", { results: [bool], entry: gcE("ref.test_null"), operands: [v], gcType: handle, display: what });
  };
}

const fieldValueType = (f) => (f.storage.packed ? null : f.storage);

/** Operand for a field/element: packed storage takes any 32-bit integer. */
function resolveStorage(x, storage, what) {
  return storage.packed ? resolveInt32(x, what) : resolveOperand(x, storage, what);
}

function storageDefaultable(storage) {
  if (storage.packed) return true;
  return !storage.noDefault && !(storage.heapType && storage.nonNull) && storage.nonNull !== true;
}

export function attachStructOps(T) {
  const label = T.ref.name.slice(5, -1); // "(ref struct#k)" → struct#k
  const fieldOf = (name, what) => {
    const f = T.fieldIndex.get(name);
    if (f === undefined) fail(`${what}: no field "${name}" on ${label}`);
    return f;
  };
  T.new = (...args) => {
    const what = `${label}.new`;
    const fs = T.fieldsSpec;
    if (args.length !== fs.length) fail(`${what}: expected ${fs.length} value(s) (${fs.map((f) => f.name).join(", ")}), got ${args.length}`);
    const operands = fs.map((f, i) => resolveStorage(args[i], f.storage, `${what} field "${f.name}"`));
    return makeNode("op", { results: [T.ref], entry: gcE("struct.new"), operands, gcType: T, display: what });
  };
  T.newDefault = () => {
    const what = `${label}.newDefault`;
    const bad = T.fieldsSpec.find((f) => !storageDefaultable(f.storage));
    if (bad) fail(`${what}: field "${bad.name}" (${bad.storage.name}) has no default value`);
    return makeNode("op", { results: [T.ref], entry: gcE("struct.new_default"), operands: [], gcType: T, display: what });
  };
  const getWith = (name, entryKey, resultOf, packedOnly) => (x, fieldName) => {
    const what = `${label}.${name}`;
    const i = fieldOf(fieldName, what);
    const f = T.fieldsSpec[i];
    if (packedOnly && !f.storage.packed) fail(`${what}: field "${fieldName}" is not packed — use .get()`);
    if (!packedOnly && f.storage.packed) fail(`${what}: field "${fieldName}" is packed (${f.storage.name}) — use .getS() or .getU()`);
    const v = resolveOperand(x, null, what);
    if (v.type !== T.ref && v.type !== T.refNull) fail(`${what}: expected a ${T.refNull.name}, got ${v.type.name}`);
    return makeNode("op", { results: [resultOf(f)], entry: gcE(entryKey), operands: [v], gcType: T, fieldIndex: i, display: what });
  };
  T.get = getWith("get", "struct.get", (f) => f.storage, false);
  T.getS = getWith("getS", "struct.get_s", () => s32, true);
  T.getU = getWith("getU", "struct.get_u", () => u32, true);
  T.set = (x, fieldName, value) => {
    const what = `${label}.set`;
    const i = fieldOf(fieldName, what);
    const f = T.fieldsSpec[i];
    if (!f.mutable) fail(`${what}: field "${fieldName}" is immutable`);
    const v = resolveOperand(x, null, what);
    if (v.type !== T.ref && v.type !== T.refNull) fail(`${what}: expected a ${T.refNull.name}, got ${v.type.name}`);
    const val = resolveStorage(value, f.storage, `${what} value`);
    makeNode("op", { results: [], entry: gcE("struct.set"), operands: [v, val], gcType: T, fieldIndex: i, display: what }, { anchor: true });
  };
}

export function attachArrayOps(T) {
  const label = T.ref.name.slice(5, -1);
  const self = (x, what) => {
    const v = resolveOperand(x, null, what);
    if (v.type !== T.ref && v.type !== T.refNull) fail(`${what}: expected a ${T.refNull.name}, got ${v.type.name}`);
    return v;
  };
  const elem = () => T.elemSpec;
  T.new = (len, init) => {
    const what = `${label}.new`;
    const n = resolveInt32(len, `${what} length`);
    if (init === undefined) {
      if (!storageDefaultable(elem().storage)) fail(`${what}: ${elem().storage.name} elements have no default — pass an initial value`);
      return makeNode("op", { results: [T.ref], entry: gcE("array.new_default"), operands: [n], gcType: T, display: what });
    }
    const v = resolveStorage(init, elem().storage, `${what} init`);
    return makeNode("op", { results: [T.ref], entry: gcE("array.new"), operands: [v, n], gcType: T, display: what });
  };
  T.newFixed = (...vals) => {
    const what = `${label}.newFixed`;
    const operands = vals.map((x, i) => resolveStorage(x, elem().storage, `${what} element ${i}`));
    return makeNode("op", { results: [T.ref], entry: gcE("array.new_fixed"), operands, gcType: T, count: vals.length, display: what });
  };
  T.newData = (seg, offset, len) => {
    const what = `${label}.newData`;
    if (seg?.handleKind !== "data") fail(`${what}: expected a data segment handle`);
    if (seg.module !== T.module) fail(`${what}: data segment belongs to a different module`);
    if (!elem().storage.packed && elem().storage.heapType) fail(`${what}: reference elements cannot come from data segments`);
    const operands = [resolveInt32(offset, `${what} offset`), resolveInt32(len, `${what} length`)];
    return makeNode("op", { results: [T.ref], entry: gcE("array.new_data"), operands, gcType: T, segment: seg, display: what });
  };
  const getWith = (name, entryKey, result, packedOnly) => (x, index) => {
    const what = `${label}.${name}`;
    if (packedOnly && !elem().storage.packed) fail(`${what}: elements are not packed — use .get()`);
    if (!packedOnly && elem().storage.packed) fail(`${what}: elements are packed (${elem().storage.name}) — use .getS() or .getU()`);
    const a = self(x, what);
    const i = resolveInt32(index, `${what} index`);
    return makeNode("op", { results: [result ?? elem().storage], entry: gcE(entryKey), operands: [a, i], gcType: T, display: what });
  };
  T.get = getWith("get", "array.get", null, false);
  T.getS = getWith("getS", "array.get_s", s32, true);
  T.getU = getWith("getU", "array.get_u", u32, true);
  T.set = (x, index, value) => {
    const what = `${label}.set`;
    if (!elem().mutable) fail(`${what}: elements are immutable`);
    const a = self(x, what);
    const i = resolveInt32(index, `${what} index`);
    const v = resolveStorage(value, elem().storage, `${what} value`);
    makeNode("op", { results: [], entry: gcE("array.set"), operands: [a, i, v], gcType: T, display: what }, { anchor: true });
  };
  T.len = (x) => {
    const what = `${label}.len`;
    return makeNode("op", { results: [u32], entry: gcE("array.len"), operands: [self(x, what)], display: what });
  };
  T.fill = (x, offset, value, len) => {
    const what = `${label}.fill`;
    if (!elem().mutable) fail(`${what}: elements are immutable`);
    const operands = [self(x, what), resolveInt32(offset, `${what} offset`), resolveStorage(value, elem().storage, `${what} value`), resolveInt32(len, `${what} length`)];
    makeNode("op", { results: [], entry: gcE("array.fill"), operands, gcType: T, display: what }, { anchor: true });
  };
  T.copy = (dst, dstOff, src, srcOff, len) => {
    const what = `${label}.copy`;
    if (!elem().mutable) fail(`${what}: elements are immutable`);
    const operands = [self(dst, what), resolveInt32(dstOff, `${what} destination offset`), self(src, `${what} source`), resolveInt32(srcOff, `${what} source offset`), resolveInt32(len, `${what} length`)];
    makeNode("op", { results: [], entry: gcE("array.copy"), operands, gcType: T, srcGcType: T, display: what }, { anchor: true });
  };
  T.initData = (x, dstOff, seg, srcOff, len) => {
    const what = `${label}.initData`;
    if (!elem().mutable) fail(`${what}: elements are immutable`);
    if (seg?.handleKind !== "data") fail(`${what}: expected a data segment handle`);
    if (seg.module !== T.module) fail(`${what}: data segment belongs to a different module`);
    const operands = [self(x, what), resolveInt32(dstOff, `${what} destination offset`), resolveInt32(srcOff, `${what} source offset`), resolveInt32(len, `${what} length`)];
    makeNode("op", { results: [], entry: gcE("array.init_data"), operands, gcType: T, segment: seg, display: what }, { anchor: true });
  };
}

// abstract namespaces: null/is_null on all five; eq on eqref; i31; converts
for (const A of [anyref, eqref, i31ref, structref, arrayref]) {
  A.null = () => makeNode("const", { type: A, results: [A], value: null });
  A.is_null = (x) => {
    const what = `${A.name}.is_null`;
    const v = resolveOperand(x, A, what);
    return makeNode("op", { results: [bool], entry: gcE("ref.is_null"), operands: [v], display: what });
  };
}

/** Reference identity over the eq hierarchy (structs, arrays, i31). */
eqref.eq = (a, b) => {
  const what = "eqref.eq";
  const ra = resolveOperand(a, eqref, what);
  const rb = resolveOperand(b, eqref, what);
  return makeNode("op", { results: [bool], entry: gcE("ref.eq"), operands: [ra, rb], display: what });
};

/** Unboxed 31-bit integer in the reference hierarchy. `of` keeps the LOW 31 bits. */
i31ref.of = (x) => {
  const v = resolveInt32(x, "i31ref.of");
  return makeNode("op", { results: [i31ref], entry: gcE("ref.i31"), operands: [v], display: "i31ref.of" });
};
i31ref.getS = (x) => {
  const v = resolveOperand(x, i31ref, "i31ref.getS");
  return makeNode("op", { results: [s32], entry: gcE("i31.get_s"), operands: [v], display: "i31ref.getS" });
};
i31ref.getU = (x) => {
  const v = resolveOperand(x, i31ref, "i31ref.getU");
  return makeNode("op", { results: [u32], entry: gcE("i31.get_u"), operands: [v], display: "i31ref.getU" });
};

/** Host boundary: bring an externref into the any-hierarchy, and back. */
anyref.of = (x) => {
  const v = resolveOperand(x, externref, "anyref.of");
  return makeNode("op", { results: [anyref], entry: gcE("any.convert_extern"), operands: [v], display: "anyref.of" });
};
externref.of = (x) => {
  const v = resolveAnyRef(x, "externref.of");
  return makeNode("op", { results: [externref], entry: gcE("extern.convert_any"), operands: [v], display: "externref.of" });
};

// sweep bookkeeping: GC ops are exercised through handle/typed harnesses
for (const e of OPTABLE) {
  if ((e.op[0] === 0xfb && e.op.length === 2) || (e.ns === "ref" && e.name === "eq")) {
    VENEER_OPS.push({ ns: e.ns, name: e.name, params: [], results: [], entry: e, mem: "gc" });
  }
}
