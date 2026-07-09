import { fail } from "../errors.js";
import { structuralSuccessors } from "../cfg.js";
import { analyzeCfg } from "./dominators.js";

/**
 * Reconstruct structured control flow (block/loop/if/br/br_if/br_table) from
 * the CFG, following the dominator-tree approach of Ramsey's "Beyond
 * Relooper". Expects a reducible graph — the reduce pass runs first.
 *
 * Output: a tree of items — linear instrs (from linearize) plus
 *   { op: 'block'|'loop', body: [...] }
 *   { op: 'if', then: [...], else: [...] }
 *   { op: 'br'|'br_if', depth }
 *   { op: 'br_table', targets: number[], defaultDepth: number }
 *   { op: 'return' } | { op: 'unreachable' }
 */
export function reloop(builder, code) {
  return reloopGraph(builder, code, builder.entry, []);
}

/**
 * Reloop one region-local structural graph. `baseCtx` seats enclosing frames
 * the encoder will materialize around this tree (a try body sees its join at
 * the try_table frame; each handler sees it through the handler-block
 * ladder), so brDepth resolves region exits without knowing the nesting.
 */
function reloopGraph(builder, code, entry, baseCtx) {
  const graphRegion = entry.region;
  const cfg = analyzeCfg(entry, (b) => structuralSuccessors(b).filter((x) => x.region === graphRegion));
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
            `internal: function ${builder.handle.debugName()}: relooper received an ` +
            `irreducible CFG after the reduce pass`,
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
      case "throw":
        return [{ op: "throw", tag: t.tag }];
      case "throwRef":
        return [{ op: "throw_ref" }];
      case "try": {
        const region = t.region;
        const H = region.handlers.length;
        // body: br 0 (= the try_table frame) exits to the funnel br after it
        const body = reloopGraph(builder, code, region.entry, [region.join]);
        const handlers = region.handlers.map((h, j) => {
          // handler j (0 innermost) sits H-1-j blocks inside the join wrapper
          const pads = Array.from({ length: H - 1 - j }, () => ({ pad: true }));
          return { tag: h.tag, ref: h.ref, payloadTypes: h.payloadTypes, tree: reloopGraph(builder, code, h.entry, [...pads, region.join]) };
        });
        return [{ op: "try_construct", handlers, body }, ...goOrPlace(region.join, ctx)];
      }
      case "returnCall":
        return [{ op: "return_call", fn: t.func }];
      case "returnCallRef":
        return [{ op: "return_call_ref", type: t.funcType }];
      case "returnCallIndirect":
        return [{ op: "return_call_indirect", type: t.funcType, table: t.table }];
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

  return doTree(rpo[0], baseCtx);
}
