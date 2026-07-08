import { fail } from "./errors.js";
import { OPTABLE } from "./optable.js";
import { i32 as I32, f32, f64, s32, u32, s64, u64 } from "./types.js";
import { makeNode, resolveOperand } from "./node.js";
import { requireBuilder } from "./context.js";

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

/** Any 32-bit integer (s32 or u32) — used where wasm is sign-agnostic by position. */
export function resolveInt32(x, what) {
  const v = resolveOperand(x, null, what);
  if (v.type.wasmType !== I32) {
    fail(`${what}: expected a 32-bit integer (s32 or u32), got ${v.type.name}`);
  }
  return v;
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

// --- casts (zero-cost retype between signednesses of the same width) ----------

function defCast(target, from) {
  target.cast = function (x) {
    const what = `${target.name}.cast`;
    const v = resolveOperand(x, null, what);
    if (v.type !== from) fail(`${what}: expected ${from.name}, got ${v.type.name}`);
    return makeNode("cast", { type: target, results: [target], operands: [v], display: what });
  };
}
defCast(s32, u32);
defCast(u32, s32);
defCast(s64, u64);
defCast(u64, s64);

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
  defOp(T, "eqz", e("eqz"), [T], [s32]);
  defOp(T, "eq", e("eq"), [T, T], [s32]);
  defOp(T, "ne", e("ne"), [T, T], [s32]);

  // Signedness-selected (the suffix comes from the namespace)
  for (const name of ["div", "rem", "shr"]) defOp(T, name, e(name + sfx), [T, T], [T]);
  for (const name of ["lt", "gt", "le", "ge"]) defOp(T, name, e(name + sfx), [T, T], [s32]);

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
    defOp(T, name, e(name), [T, T], [s32]);
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

// --- select: branchless ternary, typed by namespace ---------------------------
// NOTE: both arms are ALWAYS evaluated (select is not short-circuiting — that's
// its point: no branch). Use $.if when an arm has effects that must be guarded.

const SELECT_ENTRY = entryOf("select.select");

function defSelect(T) {
  const display = `${T.name}.select`;
  T.select = function (cond, ifTrue, ifFalse) {
    const c = resolveInt32(cond, `${display} condition`);
    const a = resolveOperand(ifTrue, T, `${display} first arm`);
    const b = resolveOperand(ifFalse, T, `${display} second arm`);
    // wasm stack order: val1, val2, cond
    return makeNode("op", { results: [T], entry: SELECT_ENTRY, operands: [a, b, c], display });
  };
  // params in constructor order (cond first) for the sweep
  VENEER_OPS.push({ ns: T.name, name: "select", params: [s32, T, T], results: [T], entry: SELECT_ENTRY });
}
for (const T of [s32, u32, s64, u64, f32, f64]) defSelect(T);

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
  copy(mem, dst, src, len) {
    checkMemHandle(mem, "mem.copy()");
    const operands = [
      resolveInt32(dst, "mem.copy() destination"),
      resolveInt32(src, "mem.copy() source"),
      resolveInt32(len, "mem.copy() length"),
    ];
    makeNode("op", { results: [], entry: bulk("copy"), operands, mem, display: "mem.copy()" }, { anchor: true });
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

// Register the handle-method instructions for sweep coverage (mem: "bulk"
// marks them as not directly constructible from a namespace).
for (const [ns, name, params, results] of [
  ["memory", "size", [], [u32]],
  ["memory", "grow", [u32], [u32]],
  ["memory", "fill", [u32, u32, u32], []],
  ["memory", "copy", [u32, u32, u32], []],
  ["memory", "init", [u32, u32, u32], []],
  ["data", "drop", [], []],
]) {
  VENEER_OPS.push({ ns, name, params, results, entry: entryOf(`${ns}.${name}`), mem: "bulk" });
}

export { s32, u32, s64, u64, f32, f64 };
