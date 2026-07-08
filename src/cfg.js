import { fail } from "./errors.js";

let nextBlockId = 1;

/**
 * A basic block. `items` is the recorded stream:
 *   { kind: 'mark', node } — expression creation position
 *   { kind: 'stmt', node } — anchored statement (store, set, drop, void call, …)
 * `term` is the terminator:
 *   { kind: 'jump', target }
 *   { kind: 'branch', cond, ifTrue, ifFalse }
 *   { kind: 'switch', index, targets, defaultTarget }
 *   { kind: 'return', values }
 *   { kind: 'unreachable' }
 */
export class Block {
  constructor() {
    this.id = nextBlockId++;
    this.items = [];
    this.term = null;
  }
}

/** Successor blocks of a terminated block. */
export function successors(block) {
  const t = block.term;
  switch (t?.kind) {
    case "jump": return [t.target];
    case "branch": return [t.ifTrue, t.ifFalse];
    case "switch": return [...t.targets, t.defaultTarget];
    default: return [];
  }
}

/**
 * A symbolic jump target. `$.label()` creates one placed at the current
 * position; `$.label.ahead()` creates one placed later via `.here()`.
 */
export class Label {
  constructor(builder, placed) {
    this.builder = builder;
    this.block = builder.newBlock();
    this.placed = placed;
    this.referenced = false;
    if (builder.module.debug) this.trace = new Error().stack;
  }

  /** Pin a forward-declared label at the current position. Exactly once. */
  here() {
    if (this.placed) fail("label.here(): label is already placed", this);
    this.builder.placeLabel(this);
    return this;
  }
}
