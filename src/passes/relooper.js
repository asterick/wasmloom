import { fail } from "../errors.js";

/**
 * Reconstruct structured control flow (block/loop/if/br/br_if/br_table) from
 * the CFG, following the dominator-tree approach of Ramsey's "Beyond
 * Relooper". Irreducible graphs are detected and rejected for now.
 *
 * Output: a tree of items — linear instrs (from linearize) plus
 *   { op: 'block'|'loop', body: [...] }
 *   { op: 'if', then: [...], else: [...] }
 *   { op: 'br'|'br_if', depth }
 *   { op: 'br_table', targets: number[], defaultDepth: number }
 *   { op: 'return' } | { op: 'unreachable' }
 */
export function reloop(builder, cfg, code) {
  const { rpo, rpoIndex, preds, idom, dominates } = cfg;

  const isLoopHeader = new Map();
  const isMerge = new Map();
  const switchTargets = new Set();

  for (const b of rpo) {
    if (b.term.kind === "switch") {
      for (const t of [...b.term.targets, b.term.defaultTarget]) switchTargets.add(t);
    }
  }

  for (const b of rpo) {
    let backEdges = 0;
    let forwardIn = 0;
    for (const p of preds.get(b)) {
      if (rpoIndex.get(p) >= rpoIndex.get(b)) {
        backEdges++;
        if (!dominates(b, p)) {
          fail(
            `function ${builder.handle.debugName()}: irreducible control flow (a goto jumps into ` +
            `the middle of a loop from outside it) — not yet supported`,
          );
        }
      } else {
        forwardIn++;
      }
    }
    isLoopHeader.set(b, backEdges > 0);
    // br_table targets must always be addressable by depth, so force a frame.
    isMerge.set(b, forwardIn >= 2 || switchTargets.has(b));
  }

  const domChildren = new Map(rpo.map((b) => [b, []]));
  for (const b of rpo) {
    if (b !== rpo[0]) domChildren.get(idom.get(b)).push(b);
  }

  function brDepth(target, ctx) {
    for (let i = 0; i < ctx.length; i++) {
      if (ctx[i] === target) return i;
    }
    return null;
  }

  function doTree(x, ctx) {
    const mergeChildren = domChildren
      .get(x)
      .filter((c) => isMerge.get(c))
      .sort((a, b) => rpoIndex.get(a) - rpoIndex.get(b));
    if (isLoopHeader.get(x)) {
      return [{ op: "loop", body: nodeWithin(x, mergeChildren, [x, ...ctx]) }];
    }
    return nodeWithin(x, mergeChildren, ctx);
  }

  function nodeWithin(x, mergeChildren, ctx) {
    if (mergeChildren.length > 0) {
      const last = mergeChildren[mergeChildren.length - 1];
      const inner = nodeWithin(x, mergeChildren.slice(0, -1), [last, ...ctx]);
      return [{ op: "block", body: inner }, ...doTree(last, ctx)];
    }
    return [...code.get(x), ...transfer(x, ctx)];
  }

  /**
   * Branch to target: br if it has a frame on the context, else place it
   * inline. Merge nodes always have a frame; loop headers with a single
   * forward predecessor are placed inline (doTree adds their loop wrapper).
   */
  function goOrPlace(target, ctx) {
    const depth = brDepth(target, ctx);
    if (depth !== null) return [{ op: "br", depth }];
    if (isMerge.get(target)) {
      fail("internal: relooper cannot place a merge block inline");
    }
    return doTree(target, ctx);
  }

  function transfer(x, ctx) {
    const t = x.term;
    switch (t.kind) {
      case "return":
        return [{ op: "return" }];
      case "unreachable":
        return [{ op: "unreachable" }];
      case "jump":
        return goOrPlace(t.target, ctx);
      case "branch": {
        // Condition value was pushed at the end of the block's code.
        const trueDepth = brDepth(t.ifTrue, ctx);
        if (trueDepth !== null) {
          return [{ op: "br_if", depth: trueDepth }, ...goOrPlace(t.ifFalse, ctx)];
        }
        const armCtx = [null, ...ctx]; // if-frame shifts depths but is never a target
        return [{
          op: "if",
          then: goOrPlace(t.ifTrue, armCtx),
          else: goOrPlace(t.ifFalse, armCtx),
        }];
      }
      case "switch": {
        const depthOf = (target) => {
          const d = brDepth(target, ctx);
          if (d === null) fail("internal: relooper switch target has no frame");
          return d;
        };
        return [{
          op: "br_table",
          targets: t.targets.map(depthOf),
          defaultDepth: depthOf(t.defaultTarget),
        }];
      }
      default:
        fail(`internal: unknown terminator ${t.kind}`);
    }
  }

  return doTree(rpo[0], []);
}
