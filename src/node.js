import { fail } from "./errors.js";
import { currentBuilder, requireBuilder } from "./context.js";

let nextId = 1;

/**
 * An expression node. Kinds:
 *  - const: { type, value }
 *  - read:  { type, variable }
 *  - op:    { type, results, entry, operands, mem?, memarg? }
 *  - call:  { type, results, func, operands, spillTemps? }
 *  - set:   { variable, operands: [value] }
 *  - drop:  { operands: [value] }
 */
export class Node {
  constructor(kind, fields) {
    this.kind = kind;
    this.id = nextId++;
    this.type = null;
    this.results = [];
    this.operands = [];
    /** @type {Array<Node | {block: object}>} everything that consumes this node's value */
    this.consumers = [];
    this.owner = null;
    this.mark = null; // { block, index } creation position
    this.stmtBlock = null; // set when recorded as a statement
    this.temp = null; // virtual local assigned when multi-use
    Object.assign(this, fields);
    if (this.results.length === 1) this.type = this.results[0];
  }
}

export function describeNode(n) {
  switch (n.kind) {
    case "const": return `${n.type.name}.const ${n.value}`;
    case "read": return `read of ${n.variable.describe()}`;
    case "op": return n.display ?? `${n.entry.ns}.${n.entry.name}`;
    case "cast": return n.display ?? "cast";
    case "reffunc": return `ref to ${n.func.debugName()}`;
    case "call": return `call to ${n.func.debugName()}`;
    case "call_indirect": return n.display ?? "indirect call";
    case "set": return `set of ${n.variable.describe()}`;
    case "drop": return "drop";
    default: return n.kind;
  }
}

/**
 * Create a node inside the active builder. Const nodes are exempt: they are
 * pure leaves, emitted per use, and may be built outside any body.
 * @param {{anchor?: boolean}} [opts] anchor=true records the node as a statement
 */
export function makeNode(kind, fields, opts = {}) {
  const n = new Node(kind, fields);
  // Pure leaves (constants, ref.func) are emitted per use and may be built
  // outside any body (they're constant expressions).
  if (kind === "const" || kind === "reffunc") {
    const b = currentBuilder();
    if (b?.module.debug) n.trace = new Error().stack;
    return n;
  }
  const b = requireBuilder(describeNode(n));
  n.owner = b;
  if (b.module.debug) n.trace = new Error().stack;
  for (const operand of n.operands) operand.consumers.push(n);
  if (opts.anchor) b.recordStmt(n);
  else b.markNode(n);
  return n;
}

/**
 * Coercion hook, registered by expr.js: given (node, expectedType, builder),
 * return a replacement node under permissive/promote modes, or null.
 */
let coerce = null;
export function setCoercion(fn) {
  coerce = fn;
}

/**
 * Coerce an operand (Node or variable handle) into a single-value Node of the
 * expected type, with eager validation. Under permissive/promote modes a
 * mismatch may be repaired by the registered coercion hook instead of failing.
 * @returns {Node}
 */
export function resolveOperand(x, expectedType, what) {
  let n = x;
  if (n != null && n.handleKind === "variable") n = n._read();
  if (!(n instanceof Node)) {
    let hint = "";
    if (typeof x === "number" || typeof x === "bigint") {
      hint = ` — wrap it explicitly, e.g. ${expectedType ? expectedType.name : "s32"}.const(${x})`;
    }
    fail(`${what}: expected an expression, got ${typeof x}${hint}`);
  }
  if (n.results.length !== 1) {
    fail(`${what}: expression produces ${n.results.length} values where exactly 1 is expected`, n);
  }
  const b = requireBuilder(what);
  if (n.owner && n.owner !== b) {
    fail(`${what}: expression belongs to a different function body`, n);
  }
  if (expectedType && n.type !== expectedType) {
    const lifted = coerce?.(n, expectedType, b);
    if (lifted) return lifted;
    fail(`${what}: expected ${expectedType.name}, got ${n.type.name}`, n);
  }
  return n;
}
