import { valtypes } from "../types.js";

/**
 * Allocate wasm local slots for virtual locals. Params keep their declared
 * slots; all other vlocals are packed per type via interference-graph
 * coloring, so locals with disjoint live ranges share a slot.
 *
 * Returns { slotOf: Map<VLocal, number>, localsDecl: Array<{type, count}> }.
 */
export function allocateSlots(builder, code, liveOut, cfg) {
  const params = builder.vlocals.filter((v) => v.kind === "param");
  const others = builder.vlocals.filter((v) => v.kind !== "param");

  // Interference: at each def, the defined vlocal conflicts with everything
  // else live at that point. Pooling is by wasm storage type — s32 and u32
  // share the i32 pool (signedness is a builder-level fiction). Non-null
  // typed references pool with their nullable twin: the slot is declared
  // nullable and reads re-assert non-null (see the encoder).
  const st = (v) => {
    const t = v.type;
    if (t.heapType) return t.nonNull ? t.nullableTwin : t;
    return t.wasmType;
  };
  const adj = new Map(others.map((v) => [v, new Set()]));
  const interfere = (a, b) => {
    if (a === b || st(a) !== st(b)) return;
    if (a.kind !== "param") adj.get(a).add(b);
    if (b.kind !== "param") adj.get(b).add(a);
  };

  for (const block of builder.blocks) {
    if (!cfg.reachable.has(block)) continue;
    const live = new Set(liveOut.get(block));
    const instrs = code.get(block);
    for (let i = instrs.length - 1; i >= 0; i--) {
      const instr = instrs[i];
      if (instr.k === "set") {
        for (const other of live) interfere(instr.v, other);
        live.delete(instr.v);
      } else if (instr.k === "get") {
        live.add(instr.v);
      }
    }
  }

  // Greedy coloring per type, in creation order. Params occupy fixed colors
  // below zero-indexed pools and never receive new colors. Typed-reference
  // pools are created on first use, after the static storage types.
  const colorOf = new Map();
  const poolSize = new Map(valtypes.map((t) => [t, 0]));
  for (const v of others) {
    const taken = new Set();
    for (const n of adj.get(v)) {
      if (n.kind === "param") taken.add(`p${n.index}`);
      else if (colorOf.has(n)) taken.add(colorOf.get(n));
    }
    let c = 0;
    while (taken.has(c)) c++;
    colorOf.set(v, c);
    if (c + 1 > (poolSize.get(st(v)) ?? 0)) poolSize.set(st(v), c + 1);
  }

  // Map colors to final slot numbers: params first, then per-type pools.
  const paramCount = params.length;
  const poolBase = new Map();
  let base = paramCount;
  const localsDecl = [];
  for (const t of poolSize.keys()) {
    const n = poolSize.get(t);
    if (n > 0) {
      poolBase.set(t, base);
      localsDecl.push({ type: t, count: n });
      base += n;
    }
  }

  const slotOf = new Map();
  for (const v of params) slotOf.set(v, v.index);
  for (const v of others) slotOf.set(v, poolBase.get(st(v)) + colorOf.get(v));
  return { slotOf, localsDecl };
}
