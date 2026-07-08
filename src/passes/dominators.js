import { successors } from "../cfg.js";

/**
 * Reachability, reverse postorder, predecessors, and immediate dominators
 * (Cooper–Harvey–Kennedy) for a function's CFG.
 */
export function analyzeCfg(entry) {
  // Postorder DFS (iterative), then reverse.
  const seen = new Set([entry]);
  const post = [];
  const stack = [{ block: entry, i: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const succs = successors(frame.block);
    if (frame.i < succs.length) {
      const s = succs[frame.i++];
      if (!seen.has(s)) {
        seen.add(s);
        stack.push({ block: s, i: 0 });
      }
    } else {
      post.push(frame.block);
      stack.pop();
    }
  }
  const rpo = post.reverse();
  const rpoIndex = new Map(rpo.map((b, i) => [b, i]));

  const preds = new Map(rpo.map((b) => [b, []]));
  for (const b of rpo) {
    for (const s of successors(b)) {
      if (rpoIndex.has(s)) preds.get(s).push(b);
    }
  }

  // Cooper–Harvey–Kennedy immediate dominators.
  const idom = new Map([[entry, entry]]);
  const intersect = (a, b) => {
    while (a !== b) {
      while (rpoIndex.get(a) > rpoIndex.get(b)) a = idom.get(a);
      while (rpoIndex.get(b) > rpoIndex.get(a)) b = idom.get(b);
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === entry) continue;
      let candidate = null;
      for (const p of preds.get(b)) {
        if (!idom.has(p)) continue;
        candidate = candidate === null ? p : intersect(candidate, p);
      }
      if (candidate !== null && idom.get(b) !== candidate) {
        idom.set(b, candidate);
        changed = true;
      }
    }
  }

  const dominates = (a, b) => {
    for (;;) {
      if (a === b) return true;
      const next = idom.get(b);
      if (next === undefined || next === b) return false;
      b = next;
    }
  };

  return { reachable: seen, rpo, rpoIndex, preds, idom, dominates };
}
