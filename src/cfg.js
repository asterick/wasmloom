import { fail } from "./errors.js";
import { currentBuilder } from "./context.js";

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

/**
 * FLOW successors: every edge execution can take, including exceptional
 * ones — a block protected by try regions may transfer to any enclosing
 * handler mid-block. Used by reachability, dominance (multi-use checks),
 * liveness, and slot coloring.
 */
export function successors(block) {
  const out = [];
  const t = block.term;
  switch (t?.kind) {
    case "jump": out.push(t.target); break;
    case "branch": out.push(t.ifTrue, t.ifFalse); break;
    case "switch": out.push(...t.targets, t.defaultTarget); break;
    case "try": out.push(t.region.entry, ...t.region.handlers.map((h) => h.entry), t.region.join); break;
    default: break; // return / throw / throwRef / unreachable
  }
  // exceptional edges: any enclosing try's handlers may receive control
  for (let r = block.region; r; r = r.parent) {
    if (r.kind === "try") out.push(...r.handlers.map((h) => h.entry));
  }
  return out;
}

/**
 * STRUCTURAL successors: the region-local shape the relooper reconstructs.
 * A try is opaque (its regions compile recursively); exceptional edges and
 * region-crossing exits (jumps to the region's join) don't participate.
 */
export function structuralSuccessors(block) {
  const t = block.term;
  const same = (b) => b.region === block.region;
  switch (t?.kind) {
    case "jump": return same(t.target) ? [t.target] : [];
    case "branch": return [t.ifTrue, t.ifFalse].filter(same);
    case "switch": return [...t.targets, t.defaultTarget].filter(same);
    case "try": return same(t.region.join) ? [t.region.join] : [];
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

  /**
   * Pin a forward-declared label at the current position. Exactly once.
   * Labels are function-scoped, not closure-scoped: placement may happen
   * inside any nested `$.if`/`$.while` callback of the same body, but never
   * from another function's body or after this body has completed.
   */
  here() {
    if (this.placed) fail("label.here(): label is already placed", this);
    if (currentBuilder() !== this.builder) {
      fail(
        "label.here(): label belongs to a function body that is not currently being built — " +
        "labels must be placed while their own .body() callback is running",
        this,
      );
    }
    this.builder.placeLabel(this);
    return this;
  }
}
