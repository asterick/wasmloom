import { fail } from "../errors.js";
import { describeNode } from "../node.js";

/**
 * Resolve multi-use expressions to temps (evaluated at their creation point,
 * per DESIGN.md), verify dominance, and lower each reachable block to a flat
 * stack-machine instruction list.
 *
 * Instruction forms:
 *   { k: 'const', type, value }
 *   { k: 'get'|'set', v: VLocal }
 *   { k: 'gget'|'gset', g: Variable(module) }
 *   { k: 'op', entry, memarg? }
 *   { k: 'call', fn }
 *   { k: 'drop' }
 */
/**
 * Tail calls are implicit: `$.return(f.call(…))` (and the indirect and
 * multi-value forms) lowers to return_call when the returned values are
 * exactly the results of a call evaluated last. Structurally, the emitted
 * suffix is then [call, set t.., get t..] with the sets mirroring the gets —
 * the spill of a multi-result call, or a single-use binding. Those writes are
 * dead at a return (the block has no successors), so dropping them and the
 * call itself leaves the arguments on the stack for the tail call. Anything
 * that breaks the pattern — an intervening statement, a promotion around the
 * result, a second consumer — correctly leaves the call in place.
 */
function rewriteTailCall(block, out) {
  const t = block.term;
  let i = out.length;
  const gets = [];
  while (i > 0 && out[i - 1].k === "get") gets.push(out[--i]);
  const sets = [];
  while (i > 0 && out[i - 1].k === "set") sets.push(out[--i]);
  if (gets.length !== sets.length) return;
  const call = i > 0 ? out[i - 1] : null;
  if (!call || (call.k !== "call" && call.k !== "call_indirect" && call.k !== "call_ref")) return;
  const results = call.k === "call" ? call.fn.results.length : call.type.results.length;
  if (gets.length > 0 && results !== gets.length) return;
  if (t.values.length !== results) return;
  // spill order: set t(n-1)..t(0), then get t(0)..t(n-1) — collected
  // back-to-front the arrays are each other's reverse when they mirror
  for (let j = 0; j < sets.length; j++) {
    if (sets[j].v !== gets[gets.length - 1 - j].v) return;
  }
  out.length = i - 1; // drop the call and the dead spill writes/reads
  block.term = call.k === "call" ? { kind: "returnCall", func: call.fn }
    : call.k === "call_ref" ? { kind: "returnCallRef", funcType: call.type }
    : { kind: "returnCallIndirect", funcType: call.type, table: call.table };
}

export function linearize(builder, cfg) {
  const { reachable, dominates } = cfg;

  // Anchor: the block where a node's value is actually evaluated/consumed.
  const anchorMemo = new Map();
  function anchorOf(node) {
    if (anchorMemo.has(node)) return anchorMemo.get(node);
    let result = null;
    if (node.stmtBlock) result = reachable.has(node.stmtBlock) ? node.stmtBlock : null;
    else if (node.temp) result = reachable.has(node.mark.block) ? node.mark.block : null;
    else {
      for (const c of node.consumers) {
        const block = c.block ?? anchorOf(c);
        if (block) { result = block; break; }
      }
    }
    anchorMemo.set(node, result);
    return result;
  }

  // Assign temps to multi-use nodes, consumers before operands (reverse creation order).
  for (let i = builder.nodes.length - 1; i >= 0; i--) {
    const node = builder.nodes[i];
    if (node.stmtBlock || node.kind === "const") continue;
    const liveConsumers = node.consumers.filter((c) => (c.block ?? anchorOf(c)) !== null);
    if (liveConsumers.length > 1) {
      node.temp = builder.newVLocal(node.type, "temp");
    }
  }

  // Dominance checks: a multi-use node's creation point must dominate every use.
  for (const node of builder.nodes) {
    if (!node.temp) continue;
    const markBlock = node.mark.block;
    if (!reachable.has(markBlock)) {
      fail(`${describeNode(node)}: expression is created in unreachable code but used elsewhere`, node);
    }
    for (const c of node.consumers) {
      const useBlock = c.block ?? anchorOf(c);
      if (useBlock && !dominates(markBlock, useBlock)) {
        fail(
          `${describeNode(node)}: expression is used in more than one place, but its creation point ` +
          `does not dominate all uses (e.g. created inside a conditional arm, used after it) — ` +
          `bind it to a variable explicitly`,
          node,
        );
      }
    }
  }

  const code = new Map();
  for (const block of builder.blocks) {
    if (!reachable.has(block)) continue;
    const out = [];
    // Explicit two-phase stack — expression chains can be arbitrarily deep,
    // so this must not recurse (see limits.test.js).
    const emitTree = (root, materializing = false) => {
      const stack = [{ node: root, enter: true, materializing }];
      while (stack.length > 0) {
        const frame = stack.pop();
        const node = frame.node;
        if (frame.enter) {
          if (node.temp && !frame.materializing) {
            out.push({ k: "get", v: node.temp });
            continue;
          }
          switch (node.kind) {
            case "const":
              out.push({ k: "const", type: node.type, value: node.value });
              break;
            case "read": {
              const v = node.variable;
              out.push(v.scope === "module" ? { k: "gget", g: v } : { k: "get", v: v.vlocal });
              break;
            }
            case "globalref":
              // constant-expression tree used in a body: a plain global read
              if (node.variable.module !== builder.module) {
                fail(`${describeNode(node)}: variable belongs to a different module`, node);
              }
              out.push({ k: "gget", g: node.variable });
              break;
            case "reffunc":
              out.push({ k: "reffunc", fn: node.func });
              break;
            case "constop":
            case "op":
            case "call":
            case "call_indirect":
            case "call_ref":
            case "set":
            case "drop":
            case "cast":
              stack.push({ node, enter: false });
              for (let i = node.operands.length - 1; i >= 0; i--) {
                stack.push({ node: node.operands[i], enter: true });
              }
              break;
            default:
              fail(`internal: cannot linearize node kind ${node.kind}`);
          }
        } else {
          switch (node.kind) {
            case "constop":
            case "op":
              out.push({
                k: "op",
                entry: node.entry,
                memarg: node.memarg,
                mem: node.mem,
                srcMem: node.srcMem,
                segment: node.segment,
                table: node.table,
                srcTable: node.srcTable,
                selectType: node.selectType,
                lane: node.lane,
                lanes: node.lanes,
              });
              break;
            case "call":
            case "call_indirect":
            case "call_ref":
              if (node.kind === "call") out.push({ k: "call", fn: node.func });
              else if (node.kind === "call_ref") out.push({ k: "call_ref", type: node.funcType });
              else out.push({ k: "call_indirect", type: node.funcType, table: node.table });
              if (node.spillTemps) {
                for (let i = node.spillTemps.length - 1; i >= 0; i--) {
                  out.push({ k: "set", v: node.spillTemps[i] });
                }
              }
              break;
            case "set": {
              const v = node.variable;
              out.push(v.scope === "module" ? { k: "gset", g: v } : { k: "set", v: v.vlocal });
              break;
            }
            case "drop":
              out.push({ k: "drop" });
              break;
            case "cast":
              break; // zero-cost retype — same bits, no instruction
          }
        }
      }
    };

    for (const item of block.items) {
      if (item.kind === "mark") {
        const node = item.node;
        if (node.temp && node.mark.block === block) {
          emitTree(node, true);
          out.push({ k: "set", v: node.temp });
        }
      } else {
        emitTree(item.node);
      }
    }
    // Terminator operands are pushed last.
    const t = block.term;
    if (t.kind === "branch") emitTree(t.cond);
    else if (t.kind === "switch") emitTree(t.index);
    else if (t.kind === "return") {
      for (const v of t.values) emitTree(v);
      if (builder.module.tailCalls) rewriteTailCall(block, out);
    }
    code.set(block, out);
  }
  return code;
}
