import { successors } from "../cfg.js";

/**
 * Backward liveness dataflow over virtual locals (reachable blocks only).
 * Returns liveOut: Map<Block, Set<VLocal>>.
 */
export function computeLiveness(code, cfg) {
  // Iterate in RPO and walk it backwards below: postorder visits successors
  // before predecessors, so backward flow converges in a couple of passes.
  // (Creation order looks similar but interleaves merge blocks BEFORE their
  // arms — under it, liveness crawls one conditional per pass: quadratic.)
  const live = cfg.rpo;

  // Per-block gen (upward-exposed uses) and kill (defs).
  const gen = new Map();
  const kill = new Map();
  for (const block of live) {
    const g = new Set();
    const k = new Set();
    for (const instr of code.get(block)) {
      if (instr.k === "get") {
        if (!k.has(instr.v)) g.add(instr.v);
      } else if (instr.k === "set") {
        k.add(instr.v);
      }
    }
    gen.set(block, g);
    kill.set(block, k);
  }

  const liveIn = new Map(live.map((b) => [b, new Set()]));
  const liveOut = new Map(live.map((b) => [b, new Set()]));

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = live.length - 1; i >= 0; i--) {
      const block = live[i];
      const out = liveOut.get(block);
      for (const s of successors(block)) {
        for (const v of liveIn.get(s)) {
          if (!out.has(v)) { out.add(v); changed = true; }
        }
      }
      const inn = liveIn.get(block);
      const k = kill.get(block);
      for (const v of gen.get(block)) {
        if (!inn.has(v)) { inn.add(v); changed = true; }
      }
      for (const v of out) {
        if (!k.has(v) && !inn.has(v)) { inn.add(v); changed = true; }
      }
    }
  }
  return liveOut;
}
