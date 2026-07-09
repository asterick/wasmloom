import { fail } from "./errors.js";

/**
 * A value type. Public integer types carry signedness (s32/u32/s64/u64) and
 * lower to a wasm storage type (i32/i64); floats are their own storage type.
 * Instances double as instruction namespaces (`s32.add`, `f64.const`, …) —
 * constructors are attached by expr.js.
 */
export class ValType {
  /**
   * @param {string} name user-facing name
   * @param {number} code binary type code of the storage type
   * @param {number|bigint} zero zero value for default initialization
   * @param {ValType} [wasmType] storage type (defaults to self)
   */
  constructor(name, code, zero, wasmType = null) {
    this.name = name;
    this.code = code;
    this.zero = zero;
    this.wasmType = wasmType ?? this;
  }

  toString() {
    return this.name;
  }
}

// Storage types (internal — the wasm view).
export const i32 = new ValType("i32", 0x7f, 0);
export const i64 = new ValType("i64", 0x7e, 0n);
export const v128 = new ValType("v128", 0x7b, null);

// Public types.
export const f32 = new ValType("f32", 0x7d, 0);
export const f64 = new ValType("f64", 0x7c, 0);
export const s32 = new ValType("s32", 0x7f, 0, i32);
export const u32 = new ValType("u32", 0x7f, 0, i32);
export const s64 = new ValType("s64", 0x7e, 0n, i64);
export const u64 = new ValType("u64", 0x7e, 0n, i64);
export const bool = new ValType("bool", 0x7f, false, i32);

// Vector lane views over v128 storage. Lane namespaces carry signedness like
// the scalar types; a lane type's `lanes`/`laneBits` drive immediates and
// range checks in expr.js. Masks (m*) are what comparisons produce: each lane
// all-ones or all-zeros. All v128 views retype into each other via `cast`.
function vec(name, lanes) {
  const t = new ValType(name, 0x7b, null, v128);
  t.lanes = lanes;
  t.laneBits = 128 / lanes;
  return t;
}
export const s8x16 = vec("s8x16", 16);
export const u8x16 = vec("u8x16", 16);
export const s16x8 = vec("s16x8", 8);
export const u16x8 = vec("u16x8", 8);
export const s32x4 = vec("s32x4", 4);
export const u32x4 = vec("u32x4", 4);
export const s64x2 = vec("s64x2", 2);
export const u64x2 = vec("u64x2", 2);
export const f32x4 = vec("f32x4", 4);
export const f64x2 = vec("f64x2", 2);
export const m8x16 = vec("m8x16", 16);
export const m16x8 = vec("m16x8", 8);
export const m32x4 = vec("m32x4", 4);
export const m64x2 = vec("m64x2", 2);

// Reference types (their own storage; null is the zero value).
export const funcref = new ValType("funcref", 0x70, null);
export const externref = new ValType("externref", 0x6f, null);
export const exnref = new ValType("exnref", 0x69, null); // a caught exception (wasm 3.0 EH)

/**
 * Typed function references (wasm 3.0): `(ref $sig)` / `(ref null $sig)`,
 * created per funcType handle. `heapType` points back at the handle — the
 * encoder writes code + the handle's interned type index. Non-null types
 * have no default value; their local slots are lowered to the nullable twin
 * with ref.as_non_null on read (see the encoder).
 */
export function makeTypedRefs(sig, id) {
  const ref = new ValType(`(ref fn#${id})`, 0x64, null);
  const refNull = new ValType(`(ref null fn#${id})`, 0x63, null);
  for (const t of [ref, refNull]) {
    t.heapType = sig;
    t.wasmType = t;
  }
  ref.nonNull = true;
  ref.nullableTwin = refNull;
  ref.noDefault = true;
  return { ref, refNull };
}

/** Storage types in canonical local-pool order (typed refs pool dynamically). */
export const valtypes = [i32, i64, f32, f64, v128, funcref, externref, exnref];

export function isRef(t) {
  return t === funcref || t === externref || t === exnref || t.heapType !== undefined;
}

export function isVec(t) {
  return t.wasmType === v128;
}

/** @returns {ValType} */
export function checkValType(x, what) {
  if (!(x instanceof ValType) || x === i32 || x === i64 || x === v128) {
    fail(`${what}: expected a value type (s32, u32, s64, u64, f32, f64, bool, a v128 lane/mask type, funcref, externref), got ${describe(x)}`);
  }
  return x;
}

export function checkTypeList(list, what) {
  if (!Array.isArray(list)) fail(`${what}: expected an array of value types`);
  return list.map((t, i) => checkValType(t, `${what}[${i}]`));
}

/**
 * Canonical interning key for a function signature — by storage type, since
 * signedness is a builder-level discipline invisible to the wasm type section.
 */
export function typeKey(params, results) {
  const st = (t) => t.wasmType.name;
  return `${params.map(st).join(",")}->${results.map(st).join(",")}`;
}

function describe(x) {
  if (x === null) return "null";
  if (typeof x === "object" || typeof x === "function") return x.constructor?.name ?? typeof x;
  return `${typeof x} ${String(x)}`;
}
