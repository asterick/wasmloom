import { fail } from "../errors.js";
import { s32 } from "../types.js";
import { structuralSuccessors } from "../cfg.js";
import { analyzeCfg } from "./dominators.js";

/**
 * Lower irreducible control flow to a reducible CFG so the relooper's
 * dominator-tree algorithm applies (DESIGN.md: node splitting, with a
 * dispatch-loop fallback for pathological cases).
 *
 * Runs after linearize: blocks are flat instruction lists in `code`, so a
 * split copy shares its original's instruction array and only the terminator
 * is remapped. Both fixes preserve execution order exactly — every run of the
 * new CFG executes the same instruction sequence as the old one — so temps,
 * liveness, and slot sharing computed downstream stay sound.
 *
 * Each round finds one multi-entry loop (an SCC of the loop forest with two
 * or more entry blocks) and fixes it:
 *   - node splitting: duplicate the part of the loop reachable from the
 *     secondary entries without passing through the chosen header; outside
 *     edges are steered into the copies, leaving the header as sole entry.
 *   - dispatch loop: when splitting would exceed the block budget, route
 *     every edge into an entry through a trampoline that sets a selector
 *     local and jumps to a shared br_table dispatcher.
 * Splitting can expose smaller multi-entry cycles among the copies; the loop
 * re-analyzes and fixes those too, falling back to dispatch once the budget
 * is spent. Split rounds each add at least one block and dispatch rounds fix
 * strictly nested regions, so the process converges.
 */
export function makeReducible(builder, cfg, code, entry, succ) {
  const budget = builder.blocks.length * 3 + 32;
  let selector = null;

  for (let rounds = 0; ; rounds++) {
    // Reducible iff every retreating edge is a true back edge (target
    // dominates source) — same test the relooper used to reject on.
    let irreducible = false;
    outer: for (const b of cfg.rpo) {
      for (const p of cfg.preds.get(b)) {
        if (cfg.rpoIndex.get(p) >= cfg.rpoIndex.get(b) && !cfg.dominates(b, p)) {
          irreducible = true;
          break outer;
        }
      }
    }
    if (!irreducible) return cfg;
    if (rounds > 1000) {
      fail("internal: irreducibility lowering did not converge");
    }

    const found = findMultiEntryLoop(cfg.rpo, cfg.preds, cfg.rpoIndex, succ);
    if (!found) fail("internal: retreating edge without a multi-entry loop");
    const { scc, entries } = found;

    // Header: the entry with the most outside in-edges keeps its position;
    // everything reachable from the other entries is the split region.
    let header = entries[0];
    let best = -1;
    for (const e of entries) {
      const n = cfg.preds.get(e).filter((p) => !scc.has(p)).length;
      if (n > best) {
        best = n;
        header = e;
      }
    }
    const region = new Set();
    const work = entries.filter((e) => e !== header);
    for (const e of work) region.add(e);
    while (work.length) {
      for (const s of succ(work.pop())) {
        if (scc.has(s) && s !== header && !region.has(s)) {
          region.add(s);
          work.push(s);
        }
      }
    }

    if (builder.blocks.length + region.size <= budget) {
      splitRegion(builder, cfg, code, scc, region, succ);
    } else {
      selector ??= builder.newVLocal(s32, "temp");
      dispatchLoop(builder, cfg, code, scc, entries, selector);
    }
    cfg = analyzeCfg(entry, succ);
  }
}

/** New terminator with every target block remapped through `map`. */
function retargetTerm(term, map) {
  switch (term.kind) {
    case "jump":
      return { ...term, target: map(term.target) };
    case "branch":
      return { ...term, ifTrue: map(term.ifTrue), ifFalse: map(term.ifFalse) };
    case "switch":
      return { ...term, targets: term.targets.map(map), defaultTarget: map(term.defaultTarget) };
    default:
      return term;
  }
}

/**
 * Walk the loop forest (SCCs, recursively peeling each loop's header) and
 * return the first loop with more than one entry: { scc: Set, entries: [] }.
 * `nodes` is the current subgraph in RPO order; `preds` is whole-graph, so a
 * peeled header counts as an outside edge for the loops nested under it.
 */
function findMultiEntryLoop(nodes, preds, rpoIndex, succ) {
  const inSubgraph = new Set(nodes);
  for (const scc of stronglyConnected(nodes, inSubgraph, succ)) {
    const members = [...scc].sort((a, b) => rpoIndex.get(a) - rpoIndex.get(b));
    if (members.length === 1 && !succ(members[0]).includes(members[0])) continue;
    const entries = members.filter((b) => preds.get(b).some((p) => !scc.has(p)));
    if (entries.length > 1) return { scc, entries };
    // Single entry (or none: the loop contains the function entry, which has
    // no preds and is entered by fiat) — peel the header, look inside.
    const header = entries[0] ?? members[0];
    const inner = members.filter((b) => b !== header);
    if (inner.length > 0) {
      const found = findMultiEntryLoop(inner, preds, rpoIndex, succ);
      if (found) return found;
    }
  }
  return null;
}

/** Tarjan's SCC over the subgraph induced by `inSubgraph`, iteratively. */
function stronglyConnected(order, inSubgraph, succ) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  for (const root of order) {
    if (index.has(root)) continue;
    const frames = [{ block: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const f = frames[frames.length - 1];
      const succs = succ(f.block).filter((s) => inSubgraph.has(s));
      if (f.i < succs.length) {
        const s = succs[f.i++];
        if (!index.has(s)) {
          index.set(s, counter);
          low.set(s, counter++);
          stack.push(s);
          onStack.add(s);
          frames.push({ block: s, i: 0 });
        } else if (onStack.has(s)) {
          low.set(f.block, Math.min(low.get(f.block), index.get(s)));
        }
      } else {
        frames.pop();
        if (frames.length > 0) {
          const p = frames[frames.length - 1].block;
          low.set(p, Math.min(low.get(p), low.get(f.block)));
        }
        if (low.get(f.block) === index.get(f.block)) {
          const scc = new Set();
          for (;;) {
            const b = stack.pop();
            onStack.delete(b);
            scc.add(b);
            if (b === f.block) break;
          }
          sccs.push(scc);
        }
      }
    }
  }
  return sccs;
}

/**
 * Duplicate `region` (the loop minus everything only reachable through the
 * header) and steer edges from outside the loop into the copies. The
 * originals then have no outside predecessors, so the header is the loop's
 * only entry. Copies share their original's instruction array.
 */
function splitRegion(builder, cfg, code, scc, region, succ) {
  void succ;
  const copies = new Map();
  for (const b of region) {
    const c = builder.newBlock();
    c.region = b.region; // copies stay in their try/handler region
    code.set(c, code.get(b));
    copies.set(b, c);
  }
  const toCopy = (t) => copies.get(t) ?? t;
  for (const [b, c] of copies) {
    c.term = retargetTerm(b.term, toCopy);
  }
  for (const [b, c] of copies) {
    for (const p of cfg.preds.get(b)) {
      if (!scc.has(p)) {
        p.term = retargetTerm(p.term, (t) => (t === b ? c : t));
      }
    }
  }
}

/**
 * Give the loop a single entry: a dispatcher that br_tables on a selector
 * local. Every edge into an entry is routed through a trampoline that sets
 * the selector; the entries then have the dispatcher as their only
 * predecessor, and it dominates the whole loop.
 *
 * Each entry gets separate trampolines for edges from outside the loop and
 * for back edges from inside it. A shared one would sit on the cycle while
 * also having outside predecessors — a fresh second entry, recreating the
 * irreducibility the dispatcher exists to remove.
 */
function dispatchLoop(builder, cfg, code, scc, entries, selector) {
  const dispatch = builder.newBlock();
  dispatch.region = entries[0].region; // stays inside the try/handler region
  code.set(dispatch, [{ k: "get", v: selector }]);
  dispatch.term = {
    kind: "switch",
    index: null, // operand already pushed by the code above
    targets: entries.slice(0, -1),
    defaultTarget: entries[entries.length - 1],
  };
  entries.forEach((e, i) => {
    const trampolines = new Map(); // false: from outside the loop, true: from inside
    for (const p of cfg.preds.get(e)) {
      const inside = scc.has(p);
      let tramp = trampolines.get(inside);
      if (!tramp) {
        tramp = builder.newBlock();
        tramp.region = e.region;
        code.set(tramp, [{ k: "const", type: s32, value: i }, { k: "set", v: selector }]);
        tramp.term = { kind: "jump", target: dispatch };
        trampolines.set(inside, tramp);
      }
      p.term = retargetTerm(p.term, (t) => (t === e ? tramp : t));
    }
  });
}
