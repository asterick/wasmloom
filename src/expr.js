import { fail } from "./errors.js";
import { OPTABLE } from "./optable.js";
import { i32, i64, f32, f64 } from "./types.js";
import { makeNode, resolveOperand } from "./node.js";
import { requireBuilder } from "./context.js";

const NS = { i32, i64, f32, f64 };

// --- constants -------------------------------------------------------------

const I32_MIN = -0x80000000;
const U32_MAX = 0xffffffff;
const I64_MIN = -(2n ** 63n);
const U64_MAX = 2n ** 64n - 1n;

i32.const = function (v) {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    fail(`i32.const: expected an integer, got ${typeof v === "number" ? v : typeof v}`);
  }
  if (v < I32_MIN || v > U32_MAX) {
    fail(`i32.const: ${v} is outside [-2^31, 2^32)`);
  }
  const signed = v > 0x7fffffff ? v - 0x100000000 : v;
  return makeNode("const", { type: i32, results: [i32], value: signed });
};

i64.const = function (v) {
  let b;
  if (typeof v === "bigint") b = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) b = BigInt(v);
  else {
    fail(`i64.const: expected a BigInt or safe integer, got ${typeof v === "number" ? v : typeof v}`);
  }
  if (b < I64_MIN || b > U64_MAX) fail(`i64.const: ${b} is outside [-2^63, 2^64)`);
  const signed = b > 0x7fffffffffffffffn ? b - 0x10000000000000000n : b;
  return makeNode("const", { type: i64, results: [i64], value: signed });
};

f32.const = function (v) {
  if (typeof v !== "number") fail(`f32.const: expected a number, got ${typeof v}`);
  return makeNode("const", { type: f32, results: [f32], value: v });
};

f64.const = function (v) {
  if (typeof v !== "number") fail(`f64.const: expected a number, got ${typeof v}`);
  return makeNode("const", { type: f64, results: [f64], value: v });
};

// --- table-driven instruction constructors ----------------------------------

function resolveTypes(names) {
  return names.map((n) => NS[n]);
}

function makeOpConstructor(entry) {
  const params = resolveTypes(entry.params);
  const results = resolveTypes(entry.results);
  const what = `${entry.ns}.${entry.name}`;

  if (entry.mem) return makeMemConstructor(entry, params, results, what);

  return function (...args) {
    if (args.length !== params.length) {
      fail(`${what}: expected ${params.length} operand(s), got ${args.length}`);
    }
    const operands = params.map((t, idx) => resolveOperand(args[idx], t, `${what} operand ${idx + 1}`));
    return makeNode(
      "op",
      { results, entry, operands },
      { anchor: results.length === 0 },
    );
  };
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

function makeMemConstructor(entry, params, results, what) {
  if (entry.mem === "load") {
    return function (mem, addr, opts = {}) {
      const memarg = checkMemArgs(mem, opts, entry, what);
      const a = resolveOperand(addr, i32, `${what} address`);
      return makeNode("op", { results, entry, operands: [a], mem, memarg });
    };
  }
  return function (mem, addr, value, opts = {}) {
    const memarg = checkMemArgs(mem, opts, entry, what);
    const a = resolveOperand(addr, i32, `${what} address`);
    const v = resolveOperand(value, params[1], `${what} value`);
    return makeNode("op", { results, entry, operands: [a, v], mem, memarg }, { anchor: true });
  };
}

for (const entry of OPTABLE) {
  NS[entry.ns][entry.name] = makeOpConstructor(entry);
}

export { i32, i64, f32, f64 };
