import { fail } from "./errors.js";

/**
 * A WebAssembly value type. Instances double as the instruction namespaces
 * (`i32.add`, `f64.const`, …) — constructors are attached by expr.js.
 */
export class ValType {
  /**
   * @param {string} name .wat name
   * @param {number} code binary type code
   * @param {number|bigint} zero zero value for default initialization
   */
  constructor(name, code, zero) {
    this.name = name;
    this.code = code;
    this.zero = zero;
  }

  toString() {
    return this.name;
  }
}

export const i32 = new ValType("i32", 0x7f, 0);
export const i64 = new ValType("i64", 0x7e, 0n);
export const f32 = new ValType("f32", 0x7d, 0);
export const f64 = new ValType("f64", 0x7c, 0);

/** All value types, in canonical local-pool order. */
export const valtypes = [i32, i64, f32, f64];

/** @returns {ValType} */
export function checkValType(x, what) {
  if (!(x instanceof ValType)) {
    fail(`${what}: expected a value type (i32, i64, f32, f64), got ${describe(x)}`);
  }
  return x;
}

export function checkTypeList(list, what) {
  if (!Array.isArray(list)) fail(`${what}: expected an array of value types`);
  return list.map((t, i) => checkValType(t, `${what}[${i}]`));
}

/** Canonical interning key for a function signature. */
export function typeKey(params, results) {
  return `${params.map((t) => t.name).join(",")}->${results.map((t) => t.name).join(",")}`;
}

function describe(x) {
  if (x === null) return "null";
  if (typeof x === "object" || typeof x === "function") return x.constructor?.name ?? typeof x;
  return `${typeof x} ${String(x)}`;
}
