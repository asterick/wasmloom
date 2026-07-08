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

// Public types.
export const f32 = new ValType("f32", 0x7d, 0);
export const f64 = new ValType("f64", 0x7c, 0);
export const s32 = new ValType("s32", 0x7f, 0, i32);
export const u32 = new ValType("u32", 0x7f, 0, i32);
export const s64 = new ValType("s64", 0x7e, 0n, i64);
export const u64 = new ValType("u64", 0x7e, 0n, i64);
export const bool = new ValType("bool", 0x7f, false, i32);

/** Storage types in canonical local-pool order. */
export const valtypes = [i32, i64, f32, f64];

/** @returns {ValType} */
export function checkValType(x, what) {
  if (!(x instanceof ValType) || x === i32 || x === i64) {
    fail(`${what}: expected a value type (s32, u32, s64, u64, f32, f64, bool), got ${describe(x)}`);
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
