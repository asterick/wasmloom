import { fail } from "./errors.js";
import { checkValType, exnref } from "./types.js";
import { resolveInt32, resolveBool, defaultInit, atomicFence } from "./expr.js";
import { isRef } from "./types.js";
import { Block, Label, successors } from "./cfg.js";
import { makeNode, resolveOperand, describeNode } from "./node.js";
import { Variable } from "./variable.js";

/** A virtual local — a register before slot allocation. */
export class VLocal {
  constructor(type, kind, index) {
    this.type = type;
    this.kind = kind; // 'param' | 'var' | 'temp'
    this.index = index; // param index for params; creation order otherwise
    this.slot = -1; // assigned by the slots pass
  }
}

/** Per-function build state: records the CFG as builder callbacks run. */
export class FunctionBuilder {
  constructor(module, handle) {
    this.module = module;
    this.handle = handle;
    this.blocks = [];
    this.currentRegion = null; // innermost try/handler region being recorded
    this.entry = this.newBlock();
    this.current = this.entry;
    this.nodes = [];
    this.labels = [];
    this.vlocals = [];
    this.paramCount = 0;
    this.pendingChain = null;
    this.$ = makeDollar(this);
  }

  newBlock() {
    const b = new Block();
    b.region = this.currentRegion;
    this.blocks.push(b);
    return b;
  }

  newVLocal(type, kind) {
    const v = new VLocal(type, kind, kind === "param" ? this.paramCount++ : this.vlocals.length);
    this.vlocals.push(v);
    return v;
  }

  /** Record an expression node's creation position (no flush — see DESIGN.md). */
  markNode(node) {
    this.nodes.push(node);
    node.mark = { block: this.current, index: this.current.items.length };
    this.current.items.push({ kind: "mark", node });
  }

  /** Record an anchored statement. Finalizes any pending if-chain first. */
  recordStmt(node) {
    this.flush();
    this.nodes.push(node);
    node.stmtBlock = this.current;
    this.current.items.push({ kind: "stmt", node });
  }

  /** Terminate the current block; statements after a terminator land in a fresh (unreachable) block. */
  terminate(term) {
    if (this.current.term) {
      // already terminated (unreachable code region) — retarget into the fresh block
      this.current = this.newBlock();
    }
    this.current.term = term;
    this.current = this.newBlock();
  }

  /** Finalize a pending if- or try-chain interrupted by the next statement. */
  flush() {
    const chain = this.pendingChain;
    if (chain) {
      this.pendingChain = null;
      chain._finalizeWithoutElse();
    }
  }

  /** Island rule: labels and gotos may not cross a try/handler boundary. */
  checkRegion(label, what) {
    if (label.block.region !== this.currentRegion) {
      fail(
        `${what}: the label is in a different try/handler region — control flow may not cross ` +
        `a try boundary (communicate through variables, or leave with $.return / $.throw)`,
        label,
      );
    }
  }

  checkLabel(label, what) {
    if (!(label instanceof Label)) fail(`${what}: expected a label`);
    if (label.builder !== this) fail(`${what}: label belongs to a different function body`, label);
    return label;
  }

  placeLabel(label) {
    this.flush();
    this.checkRegion(label, "label.here()");
    label.placed = true;
    this.terminate({ kind: "jump", target: label.block });
    this.current = label.block;
  }

  /** End-of-body bookkeeping and eager whole-body checks. */
  finalize() {
    this.flush();
    for (const label of this.labels) {
      if (label.referenced && !label.placed) {
        fail(`function ${this.handle.debugName()}: a label is jumped to but never placed`, label);
      }
    }
    // Auto-terminate: reachable fall-off is an implicit return for [] results, an error otherwise.
    const reachable = this.computeReachable();
    for (const block of this.blocks) {
      if (block.term === null && reachable.has(block)) {
        if (block.region) {
          block.term = { kind: "jump", target: block.region.join };
        } else if (this.handle.results.length === 0) {
          block.term = { kind: "return", values: [] };
        } else {
          fail(`function ${this.handle.debugName()}: control can reach the end of the body without returning a value`);
        }
      }
    }
    // Unconsumed effectful values: a call whose result(s) nothing uses is an
    // error. For multi-value calls, reading any element of the tuple counts.
    const readVLocals = new Set();
    for (const node of this.nodes) {
      if (node.kind === "read" && node.variable.scope === "function") {
        readVLocals.add(node.variable.vlocal);
      }
    }
    for (const node of this.nodes) {
      if ((node.kind !== "call" && node.kind !== "call_indirect") || node.results.length === 0) continue;
      const consumed = node.spillTemps
        ? node.spillTemps.some((t) => readVLocals.has(t))
        : node.consumers.length > 0;
      if (!consumed) {
        fail(
          `function ${this.handle.debugName()}: result of ${describeNode(node)} is never used — ` +
          `discard it explicitly with $.drop() (or destructure at least one element of a tuple)`,
          node,
        );
      }
    }
  }

  computeReachable() {
    const seen = new Set([this.entry]);
    const work = [this.entry];
    while (work.length) {
      for (const s of successors(work.pop())) {
        if (!seen.has(s)) {
          seen.add(s);
          work.push(s);
        }
      }
    }
    return seen;
  }
}

/** Chainable $.try(fn).catch(tag, fn).catchRef(tag, fn).catchAll(fn).catchAllRef(fn). */
class TryChain {
  constructor(builder, $, region) {
    this.b = builder;
    this.$ = $;
    this.region = region;
    this.state = "open";
  }

  _addHandler(what, tag, ref, cb) {
    // validate first — a rejected clause must not finalize the chain
    if (this.state === "flushed" || this.b.pendingChain !== this) {
      fail(`${what}: this try-chain was finalized by an intervening statement`);
    }
    const b = this.b;
    if (typeof cb !== "function") fail(`${what}: expected a handler callback`);
    if (tag !== null) {
      if (tag?.handleKind !== "tag") fail(`${what}: expected a tag handle (mod.tag)`);
      if (tag.module !== b.module) fail(`${what}: tag belongs to a different module`);
      if (this.region.handlers.some((h) => h.tag === tag)) {
        fail(`${what}: duplicate catch for this tag — the first matching clause already wins`);
      }
    }
    if (this.region.handlers.some((h) => h.tag === null)) {
      fail(`${what}: unreachable — a .catchAll clause already catches everything`);
    }
    this.b.pendingChain = null;
    const params = tag ? tag.params : [];
    const handlerRegion = { kind: "handler", parent: this.region.parent, join: this.region.join, entry: null, handlers: [] };
    b.currentRegion = handlerRegion;
    const entry = b.newBlock();
    handlerRegion.entry = entry;
    const paramVars = params.map(
      (t) => new Variable("function", t, { builder: b, vlocal: b.newVLocal(t, "var") }),
    );
    const exnVar = ref
      ? new Variable("function", exnref, { builder: b, vlocal: b.newVLocal(exnref, "var") })
      : null;
    // catch pushes p0..pn-1 (+exnref on top for the _ref forms); sets pop in reverse
    entry.handlerPops = [
      ...(ref ? [exnVar.vlocal] : []),
      ...params.map((_, i) => paramVars[params.length - 1 - i].vlocal),
    ];
    b.current = entry;
    try {
      cb(...paramVars, ...(ref ? [exnVar] : []), b.$);
      b.flush();
    } finally {
      b.currentRegion = this.region.parent;
    }
    if (b.current.term === null) b.current.term = { kind: "jump", target: this.region.join };
    b.current = this.region.join;
    this.region.handlers.push({
      tag: tag ?? null,
      ref,
      entry,
      payloadTypes: [...params, ...(ref ? [exnref] : [])],
    });
    b.pendingChain = this;
    return this;
  }

  catch(tag, cb) {
    return this._addHandler("$.try().catch()", tag, false, cb);
  }

  catchRef(tag, cb) {
    return this._addHandler("$.try().catchRef()", tag, true, cb);
  }

  catchAll(cb) {
    return this._addHandler("$.try().catchAll()", null, false, cb);
  }

  catchAllRef(cb) {
    return this._addHandler("$.try().catchAllRef()", null, true, cb);
  }

  _finalizeWithoutElse() {
    this.state = "flushed";
  }
}

/** Chainable $.if(cond, fn).elseIf(cond, fn).else(fn). */
class IfChain {
  constructor(builder, $) {
    this.b = builder;
    this.$ = $;
    this.endBlock = builder.newBlock();
    this.state = "open"; // 'open' | 'closed' | 'flushed'
  }

  _runArm(cb) {
    cb(this.$);
    this.b.flush();
    if (this.b.current.term === null) {
      this.b.terminate({ kind: "jump", target: this.endBlock });
    }
  }

  _branchInto(cond, what) {
    const c = resolveBool(cond, `${what} condition`);
    const thenBlock = this.b.newBlock();
    const elseBlock = this.b.newBlock();
    c.consumers.push({ block: this.b.current });
    this.b.current.term = { kind: "branch", cond: c, ifTrue: thenBlock, ifFalse: elseBlock };
    return { thenBlock, elseBlock };
  }

  elseIf(cond, cb) {
    this._reopen(".elseIf()");
    const { thenBlock, elseBlock } = this._branchInto(cond, "$.if().elseIf()");
    this.b.current = thenBlock;
    this._runArm(cb);
    this.b.current = elseBlock;
    this.b.pendingChain = this;
    return this;
  }

  else(cb) {
    this._reopen(".else()");
    this._runArm(cb);
    this.state = "closed";
    this.b.current = this.endBlock;
  }

  _reopen(what) {
    if (this.state === "closed") fail(`${what}: this if-chain already has an .else()`);
    if (this.state === "flushed" || this.b.pendingChain !== this) {
      fail(`${what}: this if-chain was finalized by an intervening statement`);
    }
    this.b.pendingChain = null;
  }

  _finalizeWithoutElse() {
    this.state = "flushed";
    if (this.b.current.term === null) {
      this.b.current.term = { kind: "jump", target: this.endBlock };
    }
    this.b.current = this.endBlock;
  }
}

function makeDollar(b) {
  const label = () => {
    const l = new Label(b, true);
    b.labels.push(l);
    b.placeLabel(l);
    return l;
  };
  label.ahead = () => {
    const l = new Label(b, false);
    b.labels.push(l);
    return l;
  };

  const $ = {
    label,

    /** Declare a function-scoped variable (a wasm local). Zero-initialized unless given an init. */
    variable(type, init) {
      checkValType(type, "$.variable");
      const vlocal = b.newVLocal(type, "var");
      const handle = new Variable("function", type, { builder: b, vlocal });
      handle.set(init === undefined ? defaultInit(type) : wrapInit(type, init));
      return handle;
    },

    goto(target) {
      b.flush();
      const l = b.checkLabel(target, "$.goto");
      b.checkRegion(l, "$.goto");
      l.referenced = true;
      b.terminate({ kind: "jump", target: l.block });
    },

    gotoIf(cond, target) {
      b.flush();
      const l = b.checkLabel(target, "$.gotoIf");
      b.checkRegion(l, "$.gotoIf");
      l.referenced = true;
      const c = resolveBool(cond, "$.gotoIf condition");
      c.consumers.push({ block: b.current });
      const fallthrough = b.newBlock();
      b.current.term = { kind: "branch", cond: c, ifTrue: l.block, ifFalse: fallthrough };
      b.current = fallthrough;
    },

    switch(index, targets, defaultTarget) {
      b.flush();
      if (!Array.isArray(targets)) fail("$.switch: targets must be an array of labels");
      const ts = targets.map((t, i) => b.checkLabel(t, `$.switch target ${i}`));
      const d = b.checkLabel(defaultTarget, "$.switch default");
      for (const l of [...ts, d]) b.checkRegion(l, "$.switch");
      for (const l of [...ts, d]) l.referenced = true;
      const idx = resolveInt32(index, "$.switch index");
      idx.consumers.push({ block: b.current });
      b.current.term = {
        kind: "switch",
        index: idx,
        targets: ts.map((l) => l.block),
        defaultTarget: d.block,
      };
      b.current = b.newBlock();
    },

    return(...values) {
      b.flush();
      const expected = b.handle.results;
      if (values.length !== expected.length) {
        fail(`$.return: function returns ${expected.length} value(s), got ${values.length}`);
      }
      const resolved = values.map((v, i) => resolveOperand(v, expected[i], `$.return value ${i + 1}`));
      for (const r of resolved) r.consumers.push({ block: b.current });
      b.terminate({ kind: "return", values: resolved });
    },

    /** Throw an exception with the tag's payload. A terminator, like $.return. */
    throw(tag, ...args) {
      b.flush();
      if (tag?.handleKind !== "tag") fail("$.throw: expected a tag handle (mod.tag)");
      if (tag.module !== b.module) fail("$.throw: tag belongs to a different module");
      if (args.length !== tag.params.length) {
        fail(`$.throw: tag expects ${tag.params.length} value(s), got ${args.length}`);
      }
      const resolved = args.map((v, i) => resolveOperand(v, tag.params[i], `$.throw value ${i + 1}`));
      for (const r of resolved) r.consumers.push({ block: b.current });
      b.terminate({ kind: "throw", tag, args: resolved });
    },

    /** Rethrow a caught exception (exnref), preserving its identity. */
    throwRef(exn) {
      b.flush();
      const v = resolveOperand(exn, exnref, "$.throwRef");
      v.consumers.push({ block: b.current });
      b.terminate({ kind: "throwRef", value: v });
    },

    /**
     * Protected region: exceptions thrown inside route to the chained
     * handlers (first matching clause wins), which fall through to the code
     * after the try. Bodies and handlers are control-flow islands — gotos
     * may not cross their boundary; variables, $.return, and $.throw may.
     */
    try(cb) {
      b.flush();
      if (typeof cb !== "function") fail("$.try: expected a body callback");
      const parent = b.currentRegion;
      const join = b.newBlock();
      const region = { kind: "try", parent, join, entry: null, handlers: [] };
      if (b.current.term) b.current = b.newBlock();
      b.current.term = { kind: "try", region };
      b.currentRegion = region;
      region.entry = b.newBlock();
      b.current = region.entry;
      try {
        cb(b.$);
        b.flush();
      } finally {
        b.currentRegion = parent;
      }
      if (b.current.term === null) b.current.term = { kind: "jump", target: join };
      b.current = join;
      const chain = new TryChain(b, b.$, region);
      b.pendingChain = chain;
      return chain;
    },

    drop(value) {
      const v = resolveOperand(value, null, "$.drop");
      makeNode("drop", { operands: [v] }, { anchor: true });
    },

    /** atomic.fence — order memory effects without touching memory. */
    fence() {
      b.flush();
      atomicFence();
    },

    unreachable() {
      b.flush();
      b.terminate({ kind: "unreachable" });
    },

    if(cond, cb) {
      b.flush();
      const chain = new IfChain(b, $);
      const { thenBlock, elseBlock } = chain._branchInto(cond, "$.if");
      b.current = thenBlock;
      chain._runArm(cb);
      b.current = elseBlock;
      b.pendingChain = chain;
      return chain;
    },

    while(cond, cb) {
      // Note: cond is a single-use expression consumed at the loop head, so it
      // re-evaluates every iteration (see DESIGN.md evaluation-order rules).
      b.flush();
      const top = b.newBlock();
      const body = b.newBlock();
      const exit = b.newBlock();
      b.terminate({ kind: "jump", target: top });
      b.current = top;
      const c = resolveBool(cond, "$.while condition");
      c.consumers.push({ block: top });
      top.term = { kind: "branch", cond: c, ifTrue: body, ifFalse: exit };
      b.current = body;
      cb($);
      b.flush();
      if (b.current.term === null) {
        b.terminate({ kind: "jump", target: top });
      }
      b.current = exit;
    },
  };
  return $;
}

function wrapInit(type, init) {
  if (typeof init === "number" || typeof init === "bigint" || typeof init === "boolean") {
    return type.const(init);
  }
  if (init === null && isRef(type)) return type.null();
  return init;
}
