import { fail } from "../errors.js";
import { ByteWriter } from "./leb.js";
import { OPS } from "../optable.js";
import { typeKey } from "../types.js";
import { analyzeCfg } from "../passes/dominators.js";
import { linearize } from "../passes/linearize.js";
import { makeReducible } from "../passes/reduce.js";
import { computeLiveness } from "../passes/liveness.js";
import { allocateSlots } from "../passes/slots.js";
import { reloop } from "../passes/relooper.js";
import { structuralSuccessors } from "../cfg.js";
import { forEachConstRef } from "../expr.js";

const SECTION = {
  type: 1,
  import: 2,
  function: 3,
  table: 4,
  memory: 5,
  global: 6,
  export: 7,
  start: 8,
  elem: 9,
  code: 10,
  data: 11,
  dataCount: 12,
  tag: 13,
};

const EXPORT_KIND = { func: 0, table: 1, memory: 2, global: 3, tag: 4 };

/** Assemble the whole module into binary wasm bytes. */
export function encodeModule(module) {
  // Assign indices: imports first (declaration order), then definitions.
  const importedFns = module.functions.filter((f) => f.importInfo);
  const definedFns = module.functions.filter((f) => !f.importInfo);
  for (const f of definedFns) {
    if (!f.builderData) {
      fail(`function ${f.debugName()}: declared but never given a body or import`);
    }
  }
  [...importedFns, ...definedFns].forEach((f, i) => (f.index = i));

  const importedMems = module.memories.filter((m) => m.importInfo);
  const definedMems = module.memories.filter((m) => !m.importInfo);
  [...importedMems, ...definedMems].forEach((m, i) => (m.index = i));

  const importedTables = module.tables.filter((t) => t.importInfo);
  const definedTables = module.tables.filter((t) => !t.importInfo);
  [...importedTables, ...definedTables].forEach((t, i) => (t.index = i));

  const importedTags = module.tags.filter((t) => t.importInfo);
  const definedTags = module.tags.filter((t) => !t.importInfo);
  [...importedTags, ...definedTags].forEach((t, i) => (t.index = i));

  // Element segments: user segments in declaration order, then (if any
  // function was ref.func'd) one hidden declarative segment satisfying the
  // spec's declaration requirement.
  const elemSegments = [...module.elemSegments];
  if (module.refFunctions.size > 0) {
    elemSegments.push({ declarative: true, items: [...module.refFunctions], active: null });
  }
  elemSegments.forEach((seg, i) => (seg.index = i));

  // Constant expressions may read any immutable module variable (wasm 3.0:
  // imported or previously declared); mutability is an emit-time fact because
  // .immutable() chains after declaration.
  const offsetRefs = (offset) => {
    const refs = [];
    if (offset.kind === "global") refs.push(offset.variable);
    else if (offset.kind === "constexpr") forEachConstRef(offset.node, (r) => refs.push(r));
    return refs;
  };
  for (const seg of elemSegments) {
    if (!seg.active) continue;
    for (const ref of offsetRefs(seg.active.offset)) {
      if (ref.mutable) fail(".at(): an offset may only read immutable module variables");
    }
  }

  const importedGlobals = module.variables.filter((g) => g.importInfo);
  const definedGlobals = module.variables.filter((g) => !g.importInfo);
  [...importedGlobals, ...definedGlobals].forEach((g, i) => (g.index = i));

  module.dataSegments.forEach((seg, i) => (seg.index = i));
  for (const seg of module.dataSegments) {
    if (!seg.active) continue;
    for (const ref of offsetRefs(seg.active.offset)) {
      if (ref.mutable) fail(".at(): an offset may only read immutable module variables");
    }
  }

  for (const g of module.variables) {
    if (!g.mutable && g.setCount > 0) {
      fail(`module variable ${g.describe()}: immutable but written by .set()`);
    }
    if (g.importInfo) continue;
    // wasm requires init refs to precede the global being defined; declaration
    // order guarantees it here (an init can only mention already-created
    // handles), so only mutability needs checking.
    const refs = g.init.kind === "global" ? [g.init.variable]
      : g.init.kind === "constexpr" ? offsetRefs(g.init) : [];
    for (const ref of refs) {
      if (ref.mutable) {
        fail("mod.variable init: an initializer may only read immutable module variables");
      }
    }
  }

  // Compile all defined bodies before writing anything. Compilation mutates
  // per-node state (temp assignment), so it runs once per function and is
  // cached — emit() must be repeatable and byte-stable. Compiling first also
  // surfaces the handler-payload block types that the type section interns.
  const bodies = definedFns.map((f) => (f.compiled ??= compileFunction(f)));

  // ---- The unified type space: function signatures + GC struct/array types.
  // Entries reference each other (fields, params, supertypes); iso-recursive
  // wasm demands referenced-first ordering with cycles fused into rec groups,
  // so we build the reference graph, take SCCs, and emit in completion order.
  const funcEntries = new Map(); // typeKey → { kind: "func", params, results, index }
  const internType = (params, results) => {
    const key = typeKey(params, results);
    let e = funcEntries.get(key);
    if (!e) {
      e = { kind: "func", params, results, index: -1 };
      funcEntries.set(key, e);
    }
    return e;
  };
  const pendingIndex = [];
  for (const f of [...importedFns, ...definedFns]) {
    pendingIndex.push([f, internType(f.params, f.results)]);
  }
  for (const ft of module.funcTypes) {
    pendingIndex.push([ft, internType(ft.params, ft.results)]);
  }
  for (const t of [...importedTags, ...definedTags]) {
    pendingIndex.push([t, internType(t.params, [])]);
  }
  // Multi-value catch payloads need [] -> payload block types.
  for (const body of bodies) {
    forEachTryItem(body.tree, (item) => {
      for (const h of item.handlers) {
        if (h.payloadTypes.length > 1 || (h.payloadTypes.length === 1 && h.payloadTypes[0].heapType)) {
          internType([], h.payloadTypes);
        }
      }
    });
  }
  for (const g of module.gcTypes) {
    if (g.handleKind === "structtype" && !g.fieldsSpec) {
      fail("a struct type was declared but never given .fields()");
    }
    if (g.handleKind === "arraytype" && !g.elemSpec) {
      fail("an array type was declared but never given .element()");
    }
  }
  const nodeOfHandle = (h) =>
    h.handleKind === "functype" ? internType(h.params, h.results) : h;
  const refTypesOf = (n) => {
    const out = [];
    const add = (t) => {
      if (t && !t.packed && t.heapType) out.push(nodeOfHandle(t.heapType));
    };
    if (n.kind === "func") {
      n.params.forEach(add);
      n.results.forEach(add);
    } else if (n.handleKind === "structtype") {
      n.fieldsSpec.forEach((f) => add(f.storage));
      if (n.superType) out.push(n.superType);
    } else {
      add(n.elemSpec.storage);
    }
    return out;
  };
  // force-intern signatures referenced from GC fields, then snapshot
  for (const g of module.gcTypes) refTypesOf(g);
  const typeNodes = [...funcEntries.values(), ...module.gcTypes];
  // Iso-recursive wasm canonicalizes same-shaped singleton types together —
  // two identical structs in separate rec groups would BE one type, making
  // sibling casts truthy. Position inside a shared rec group keeps declared
  // types nominally distinct, so all GC types (plus any signatures that
  // transitively reference them) share one group; pure signatures stay bare
  // singletons and keep their structural interop.
  const touchesGC = new Set(module.gcTypes);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of typeNodes) {
      if (touchesGC.has(n)) continue;
      if (refTypesOf(n).some((r) => touchesGC.has(r))) {
        touchesGC.add(n);
        grew = true;
      }
    }
  }
  const bareFuncs = typeNodes.filter((n) => n.kind === "func" && !touchesGC.has(n));
  const gcGroup = [
    ...module.gcTypes, // declaration order: supertypes precede subtypes
    ...typeNodes.filter((n) => n.kind === "func" && touchesGC.has(n)),
  ];
  const typeGroups = [...bareFuncs.map((n) => [n]), ...(gcGroup.length ? [gcGroup] : [])];
  let nextTypeIndex = 0;
  for (const group of typeGroups) {
    for (const n of group) {
      if (n.kind === "func") n.index = nextTypeIndex++;
      else n.typeIndex = nextTypeIndex++;
    }
  }
  for (const [o, e] of pendingIndex) o.typeIndex = e.index;
  const blockTypeIndex = (types) => funcEntries.get(typeKey([], types)).index;
  const extendedSet = new Set(module.gcTypes.map((g) => g.superType).filter(Boolean));

  const w = new ByteWriter();
  w.bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  w.section(SECTION.type, (s) => {
    s.u32(typeGroups.length); // vec of rectypes (a bare type is a singleton)
    for (const group of typeGroups) {
      if (group.length > 1) {
        s.u8(0x4e).u32(group.length);
      }
      for (const n of group) writeSubType(s, n, extendedSet);
    }
  });

  const imports = [
    ...importedFns.map((f) => ({ info: f.importInfo, write: (s) => s.u8(0x00).u32(f.typeIndex) })),
    ...importedTables.map((t) => ({
      info: t.importInfo,
      write: (s) => { s.u8(0x01); writeValType(s, t.elemType); writeLimits(s, t.limits); },
    })),
    ...importedMems.map((m) => ({
      info: m.importInfo,
      write: (s) => { s.u8(0x02); writeLimits(s, m.limits); },
    })),
    ...importedTags.map((t) => ({
      info: t.importInfo,
      write: (s) => s.u8(0x04).u8(0x00).u32(t.typeIndex),
    })),
    ...importedGlobals.map((g) => ({
      info: g.importInfo,
      write: (s) => { s.u8(0x03); writeValType(s, g.type); s.u8(g.mutable ? 1 : 0); },
    })),
  ];

  w.section(SECTION.import, (s) => {
    if (imports.length === 0) return;
    s.vec(imports, (sw, imp) => {
      sw.name(imp.info.module).name(imp.info.name);
      imp.write(sw);
    });
  });

  w.section(SECTION.function, (s) => {
    if (definedFns.length === 0) return;
    s.vec(definedFns, (sw, f) => sw.u32(f.typeIndex));
  });

  w.section(SECTION.table, (s) => {
    if (definedTables.length === 0) return;
    s.vec(definedTables, (sw, t) => {
      writeValType(sw, t.elemType);
      writeLimits(sw, t.limits);
    });
  });

  w.section(SECTION.memory, (s) => {
    if (definedMems.length === 0) return;
    s.vec(definedMems, (sw, m) => writeLimits(sw, m.limits));
  });

  // The tag section sits between memory and global despite its id (13).
  w.section(SECTION.tag, (s) => {
    if (definedTags.length === 0) return;
    s.vec(definedTags, (sw, t) => sw.u8(0x00).u32(t.typeIndex));
  });

  w.section(SECTION.global, (s) => {
    if (definedGlobals.length === 0) return;
    s.vec(definedGlobals, (sw, g) => {
      writeValType(sw, g.type);
      sw.u8(g.mutable ? 1 : 0);
      if (g.init.kind === "global") {
        sw.u8(OPS.global_get).u32(g.init.variable.index);
      } else if (g.init.kind === "constexpr") {
        writeConstExpr(sw, g.init.node);
      } else {
        writeConst(sw, g.init.node);
      }
      sw.u8(OPS.end);
    });
  });

  w.section(SECTION.export, (s) => {
    if (module.exports.length === 0) return;
    s.vec(module.exports, (sw, e) => {
      sw.name(e.name).u8(EXPORT_KIND[e.kind]).u32(e.handle.index);
    });
  });

  if (module.startFunction) {
    w.section(SECTION.start, (s) => s.u32(module.startFunction.index));
  }

  w.section(SECTION.elem, (s) => {
    if (elemSegments.length === 0) return;
    s.vec(elemSegments, writeElemSegment);
  });

  // The data-count section must precede code so memory.init/data.drop validate.
  if (module.dataSegments.length > 0) {
    w.section(SECTION.dataCount, (s) => s.u32(module.dataSegments.length));
  }

  w.section(SECTION.code, (s) => {
    if (bodies.length === 0) return;
    s.vec(bodies, (sw, body) => {
      const bw = new ByteWriter();
      writeBody(bw, body, blockTypeIndex);
      sw.u32(bw.len).bytes(bw.toBytes());
    });
  });

  w.section(SECTION.data, (s) => {
    if (module.dataSegments.length === 0) return;
    s.vec(module.dataSegments, (sw, seg) => {
      if (seg.active) {
        if (seg.active.mem.index !== 0) sw.u8(0x02).u32(seg.active.mem.index);
        else sw.u8(0x00);
        writeConstOffset(sw, seg.active.offset);
      } else {
        sw.u8(0x01);
      }
      sw.u32(seg.bytes.length).bytes(seg.bytes);
    });
  });

  // The name section is a custom section and must follow the data section.
  if (module.names) {
    writeNameSection(w, module, {
      fns: [...importedFns, ...definedFns],
      tables: [...importedTables, ...definedTables],
      mems: [...importedMems, ...definedMems],
      globals: [...importedGlobals, ...definedGlobals],
      elems: elemSegments,
    });
  }

  return w.toBytes();
}

/**
 * The debug name an entity carries into the name section: an explicit
 * .name() wins, then the export name, then "module.name" for imports.
 */
function debugNameOf(h) {
  return h.nameStr ?? h.exportName ?? (h.importInfo ? `${h.importInfo.module}.${h.importInfo.name}` : null);
}

/**
 * Custom "name" section (module 0, functions 1, tables 5, memories 6,
 * globals 7, element segments 8, data segments 9). Local names (2) are
 * deliberately absent: locals share wasm slots across disjoint live ranges,
 * so one slot has no single name.
 */
function writeNameSection(w, module, { fns, tables, mems, globals, elems }) {
  const spaces = [
    [1, fns], [5, tables], [6, mems], [7, globals], [8, elems], [9, module.dataSegments],
    [11, module.tags],
  ];
  const anyNamed = module.moduleName || spaces.some(([, list]) => list.some((h) => debugNameOf(h) !== null));
  if (!anyNamed) return;
  w.section(0, (s) => {
    s.name("name");
    if (module.moduleName) s.section(0, (ss) => ss.name(module.moduleName));
    for (const [id, list] of spaces) {
      const entries = list.filter((h) => debugNameOf(h) !== null); // index order
      if (entries.length === 0) continue;
      s.section(id, (ss) => ss.vec(entries, (sw, h) => sw.u32(h.index).name(debugNameOf(h))));
    }
  });
}

/** Run the full pipeline for one defined function. */
function compileFunction(fn) {
  const builder = fn.builderData;
  let cfg = analyzeCfg(builder.entry); // flow view: exceptional edges included
  const code = linearize(builder, cfg);
  // Irreducibility is region-local (gotos cannot cross try boundaries), so
  // reduction runs per region on the structural graphs.
  for (const { entry } of regionEntries(cfg)) {
    const succ = (b) => structuralSuccessors(b).filter((x) => x.region === entry.region);
    makeReducible(builder, analyzeCfg(entry, succ), code, entry, succ);
  }
  cfg = analyzeCfg(builder.entry); // recompute: reduction may add blocks
  const liveOut = computeLiveness(code, cfg);
  const { slotOf, localsDecl } = allocateSlots(builder, code, liveOut, cfg);
  const tree = reloop(builder, code);
  elideFreshZeroInits(tree, slotOf);
  return { tree, slotOf, localsDecl };
}

/** Every structural graph root: the function entry plus each region's entries. */
function regionEntries(flowCfg) {
  const out = [{ entry: flowCfg.rpo[0] }];
  for (const b of flowCfg.rpo) {
    if (b.term?.kind === "try") {
      out.push({ entry: b.term.region.entry });
      for (const h of b.term.region.handlers) out.push({ entry: h.entry });
    }
  }
  return out;
}

/**
 * Wasm zero-initializes locals, so a synthetic `const 0; set s` in the
 * function's straight-line entry prefix is redundant when slot `s` has not
 * been written yet. Descends through `block` wrappers only — a `loop`
 * header's code re-runs on the back edge, where a reset is semantic — and
 * stops at the first structured/control item. Never touches param slots
 * (they hold arguments, not zero).
 */
function elideFreshZeroInits(tree, slotOf) {
  let seq = tree;
  while (seq[0]?.op === "block") seq = seq[0].body;
  const written = new Set();
  const LINEAR = new Set(["const", "get", "set", "gget", "gset", "op", "call", "call_indirect", "call_ref", "reffunc", "drop"]);
  for (let i = 0; i < seq.length; i++) {
    const item = seq[i];
    if (!LINEAR.has(item.op ?? item.k)) break;
    if (item.k !== "set") continue;
    const slot = slotOf.get(item.v);
    const prev = seq[i - 1];
    if (
      item.v.kind !== "param" &&
      !written.has(slot) &&
      prev?.k === "const" &&
      isZeroConst(prev)
    ) {
      seq.splice(i - 1, 2);
      i -= 2;
      continue; // the slot stays fresh — a later redundant re-init elides too
    }
    written.add(slot);
  }
}

function isZeroConst(item) {
  switch (item.type.wasmType.name) {
    case "i32": case "f32": case "f64": return Object.is(item.value, 0);
    case "i64": return item.value === 0n;
    case "v128": return item.value.every((b) => b === 0);
    case "funcref": case "externref": return item.value === null;
    default: return false;
  }
}

function writeStorageType(s, storage) {
  if (storage.packed) s.u8(storage.packed === 8 ? 0x78 : 0x77);
  else writeValType(s, storage);
}

/** One subtype entry: sub/sub-final wrapper when a hierarchy is declared. */
function writeSubType(s, n, extendedSet) {
  if (n.kind === "func") {
    s.u8(OPS.functype);
    s.vec(n.params, (x, p) => writeValType(x, p));
    s.vec(n.results, (x, r) => writeValType(x, r));
    return;
  }
  const isExtended = extendedSet.has(n);
  const supers = n.superType ? [n.superType] : [];
  if (isExtended || supers.length > 0) {
    s.u8(isExtended ? 0x50 : 0x4f); // sub (open) vs sub final
    s.u32(supers.length);
    for (const sup of supers) s.u32(sup.typeIndex);
  }
  if (n.handleKind === "structtype") {
    s.u8(0x5f);
    s.vec(n.fieldsSpec, (sw, f) => {
      writeStorageType(sw, f.storage);
      sw.u8(f.mutable ? 1 : 0);
    });
  } else {
    s.u8(0x5e);
    writeStorageType(s, n.elemSpec.storage);
    s.u8(n.elemSpec.mutable ? 1 : 0);
  }
}

/** A value type: one byte, or ref/refnull code + interned type index. */
function writeValType(s, t) {
  s.u8(t.code);
  if (t.heapType) s.s32(t.heapType.typeIndex);
}

/** Non-param locals of non-null ref type live in nullable slots. */
function needsNonNullAssert(vlocal) {
  return vlocal.type.nonNull === true && vlocal.kind !== "param";
}

function writeLimits(s, limits) {
  if (limits.shared) s.u8(0x03).u32(limits.min).u32(limits.max);
  else if (limits.max !== undefined) s.u8(0x01).u32(limits.min).u32(limits.max);
  else s.u8(0x00).u32(limits.min);
}

function writeConst(s, node) {
  if (node.kind === "reffunc") {
    s.u8(OPS.ref_func).u32(node.func.index);
    return;
  }
  switch (node.type.wasmType.name) {
    case "i32": s.u8(OPS.i32_const).s32(node.value); break;
    case "i64": s.u8(OPS.i64_const).s64(node.value); break;
    case "f32": s.u8(OPS.f32_const).f32(node.value); break;
    case "f64": s.u8(OPS.f64_const).f64(node.value); break;
    case "v128": s.bytes(OPS.v128_const).bytes(node.value); break; // value: 16 bytes LE
    case "funcref":
    case "externref":
    case "exnref":
    case "anyref":
    case "eqref":
    case "i31ref":
    case "structref":
    case "arrayref":
      s.u8(OPS.ref_null).u8(node.type.code);
      break;
    default:
      if (node.type.heapType) { // typed ref.null: heap type is the type index
        s.u8(OPS.ref_null).s32(node.type.heapType.typeIndex);
        break;
      }
      fail(`internal: cannot encode const of ${node.type.name}`);
  }
}

/** Constant offset expression for active data/element segments. */
function writeConstOffset(s, off) {
  if (off.kind === "int") {
    const signed = off.value > 0x7fffffff ? off.value - 0x100000000 : off.value;
    s.u8(OPS.i32_const).s32(signed);
  } else if (off.kind === "global") {
    s.u8(OPS.global_get).u32(off.variable.index);
  } else if (off.kind === "constexpr") {
    writeConstExpr(s, off.node);
  } else {
    writeConst(s, off.node);
  }
  s.u8(OPS.end);
}

/** Extended constant expression: consts, global reads, and add/sub/mul trees. */
function writeConstExpr(s, node) {
  switch (node.kind) {
    case "globalref":
      s.u8(OPS.global_get).u32(node.variable.index);
      break;
    case "constop":
      for (const o of node.operands) writeConstExpr(s, o);
      s.bytes(node.entry.op);
      break;
    default:
      writeConst(s, node);
  }
}

/** One element segment, picking the tightest encoding flavor. */
function writeElemSegment(s, seg) {
  const typed = seg.active?.table.elemType.heapType;
  const exprForm = seg.items.some((f) => f === null);
  const funcVec = () => s.vec(seg.items, (sw, f) => sw.u32(f.index));
  const exprVec = () =>
    s.vec(seg.items, (sw, f) => {
      if (f) sw.u8(OPS.ref_func).u32(f.index);
      else if (typed) sw.u8(OPS.ref_null).s32(typed.typeIndex);
      else sw.u8(OPS.ref_null).u8(0x70);
      sw.u8(OPS.end);
    });
  if (seg.declarative) {
    s.u32(3).u8(0x00);
    funcVec();
  } else if (seg.active) {
    const t = seg.active.table;
    if (typed) {
      // typed tables always take the explicit-reftype expression form
      s.u32(6).u32(t.index);
      writeConstOffset(s, seg.active.offset);
      writeValType(s, t.elemType);
      exprVec();
    } else if (t.index === 0 && !exprForm) {
      s.u32(0);
      writeConstOffset(s, seg.active.offset);
      funcVec();
    } else if (!exprForm) {
      s.u32(2).u32(t.index);
      writeConstOffset(s, seg.active.offset);
      s.u8(0x00);
      funcVec();
    } else if (t.index === 0) {
      s.u32(4);
      writeConstOffset(s, seg.active.offset);
      exprVec();
    } else {
      s.u32(6).u32(t.index);
      writeConstOffset(s, seg.active.offset);
      s.u8(0x70);
      exprVec();
    }
  } else if (!exprForm) {
    s.u32(1).u8(0x00);
    funcVec();
  } else {
    s.u32(5).u8(0x70);
    exprVec();
  }
}

function writeBody(w, { tree, slotOf, localsDecl }, btIndex) {
  w.vec(localsDecl, (s, d) => { s.u32(d.count); writeValType(s, d.type); });
  writeSeq(w, tree, slotOf, btIndex);
  // Every CFG block ends in an explicit transfer, so control never actually
  // falls off the end — but when the last item is structured (if/loop/block),
  // the validator still types the fallthrough. Cap it as unreachable.
  const last = tree[tree.length - 1];
  const diverges = last &&
    ["return", "unreachable", "br", "br_table", "return_call", "return_call_indirect", "return_call_ref", "throw", "throw_ref"]
      .includes(last.op);
  if (!diverges) w.u8(OPS.unreachable);
  w.u8(OPS.end);
}

function writeSeq(w, items, slotOf, btIndex) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const next = items[i + 1];
    // Peephole: `set s; get s` (same slot) is exactly local.tee.
    if (item.k === "set" && next?.k === "get" && slotOf.get(item.v) === slotOf.get(next.v)) {
      w.u8(OPS.local_tee).u32(slotOf.get(item.v));
      if (needsNonNullAssert(next.v)) w.u8(OPS.ref_as_non_null);
      i++;
      continue;
    }
    writeItem(w, item, slotOf, btIndex);
  }
}

/** Recursively visit try_construct items in a relooper tree. */
function forEachTryItem(items, fn) {
  for (const item of items) {
    switch (item.op) {
      case "block":
      case "loop":
        forEachTryItem(item.body, fn);
        break;
      case "if":
        forEachTryItem(item.then, fn);
        forEachTryItem(item.else, fn);
        break;
      case "try_construct":
        fn(item);
        forEachTryItem(item.body, fn);
        for (const h of item.handlers) forEachTryItem(h.tree, fn);
        break;
      default:
        break;
    }
  }
}

/** Catch-target block type: empty, a single valtype, or an interned [] -> payload. */
function writeBlockType(w, types, btIndex) {
  if (types.length === 0) w.u8(OPS.blocktype_empty);
  else if (types.length === 1 && !types[0].heapType) w.u8(types[0].code);
  else w.s32(btIndex(types));
}

function writeItem(w, item, slotOf, btIndex) {
  switch (item.op ?? item.k) {
    // structured / control
    case "block":
      w.u8(OPS.block).u8(OPS.blocktype_empty);
      writeSeq(w, item.body, slotOf, btIndex);
      w.u8(OPS.end);
      break;
    case "loop":
      w.u8(OPS.loop).u8(OPS.blocktype_empty);
      writeSeq(w, item.body, slotOf, btIndex);
      w.u8(OPS.end);
      break;
    case "if":
      w.u8(OPS.if).u8(OPS.blocktype_empty);
      writeSeq(w, item.then, slotOf, btIndex);
      if (item.else.length > 0) {
        w.u8(OPS.else);
        writeSeq(w, item.else, slotOf, btIndex);
      }
      w.u8(OPS.end);
      break;
    case "try_construct": {
      // block $join { block $h(H-1) { … block $h0 {
      //   try_table (catch → $h0..$h(H-1)) BODY end; br $join
      // } handler0; br $join } … } handler(H-1) } — falls into $join.
      const H = item.handlers.length;
      w.u8(OPS.block).u8(OPS.blocktype_empty); // $join
      for (let j = H - 1; j >= 0; j--) {
        w.u8(OPS.block);
        writeBlockType(w, item.handlers[j].payloadTypes, btIndex);
      }
      w.u8(OPS.try_table).u8(OPS.blocktype_empty);
      w.u32(H);
      item.handlers.forEach((h, j) => {
        w.u8(h.tag === null ? (h.ref ? 0x03 : 0x02) : (h.ref ? 0x01 : 0x00));
        if (h.tag !== null) w.u32(h.tag.index);
        w.u32(j); // catch labels resolve outside try_table: j = $h_j
      });
      writeSeq(w, item.body, slotOf, btIndex);
      w.u8(OPS.end); // try_table
      w.u8(OPS.br).u32(H); // normal completion → $join
      item.handlers.forEach((h, j) => {
        w.u8(OPS.end); // $h_j — payload now on the stack
        writeSeq(w, h.tree, slotOf, btIndex);
        if (j < H - 1) w.u8(OPS.br).u32(H - 1 - j); // → $join
      });
      w.u8(OPS.end); // $join
      break;
    }
    case "throw": w.u8(OPS.throw).u32(item.tag.index); break;
    case "throw_ref": w.u8(OPS.throw_ref); break;
    case "br": w.u8(OPS.br).u32(item.depth); break;
    case "br_if": w.u8(OPS.br_if).u32(item.depth); break;
    case "br_table":
      w.u8(OPS.br_table);
      w.vec(item.targets, (s, d) => s.u32(d));
      w.u32(item.defaultDepth);
      break;
    case "return": w.u8(OPS.return); break;
    case "unreachable": w.u8(OPS.unreachable); break;
    // linear instrs
    case "const": writeConst(w, item); break;
    case "get":
      w.u8(OPS.local_get).u32(slotOf.get(item.v));
      // Non-null ref slots are declared nullable (wasm's structural
      // definite-assignment rules don't fit relooped output); reads
      // re-assert non-null. Params keep their true type — no assert.
      if (needsNonNullAssert(item.v)) w.u8(OPS.ref_as_non_null);
      break;
    case "set": w.u8(OPS.local_set).u32(slotOf.get(item.v)); break;
    case "gget": w.u8(OPS.global_get).u32(item.g.index); break;
    case "gset": w.u8(OPS.global_set).u32(item.g.index); break;
    case "op":
      if (item.entry.select && item.selectType) {
        // typed select — required when the arms are references
        w.u8(OPS.select_typed).u32(1).u8(item.selectType.code);
        break;
      }
      w.bytes(item.entry.op);
      if (item.entry.mem) {
        // Nonzero memory: bit 6 of the align field flags an explicit index
        // (memory 0 keeps the classic form, byte-identical to before).
        if (item.mem.index !== 0) w.u32(item.memarg.align | 0x40).u32(item.mem.index);
        else w.u32(item.memarg.align);
        w.u32(item.memarg.offset);
      } else {
        switch (item.entry.imm) {
          case "mem": w.u32(item.mem.index); break;
          case "mem+mem": w.u32(item.mem.index).u32(item.srcMem.index); break;
          case "data": w.u32(item.segment.index); break;
          case "data+mem": w.u32(item.segment.index).u32(item.mem.index); break;
          case "table": w.u32(item.table.index); break;
          case "table+table": w.u32(item.table.index).u32(item.srcTable.index); break;
          case "elem": w.u32(item.segment.index); break;
          case "elem+table": w.u32(item.segment.index).u32(item.table.index); break;
          case "shuffle": w.bytes(item.lanes); break; // 16 lane indices
          case "gcType": w.u32(item.gcType.typeIndex); break;
          case "gcType+field": w.u32(item.gcType.typeIndex).u32(item.fieldIndex); break;
          case "gcType+len": w.u32(item.gcType.typeIndex).u32(item.count); break;
          case "gcType+data": w.u32(item.gcType.typeIndex).u32(item.segment.index); break;
          case "gcType2": w.u32(item.gcType.typeIndex).u32(item.srcGcType.typeIndex); break;
          case "heapType": w.s32(item.gcType.typeIndex); break;
          case "fence": w.u8(0x00); break;
          default: break; // no immediates
        }
      }
      // laneidx immediate follows the memarg on lane loads/stores
      if (item.entry.lane !== undefined) w.u8(item.lane);
      break;
    case "call": w.u8(OPS.call).u32(item.fn.index); break;
    case "call_indirect": w.u8(OPS.call_indirect).u32(item.type.typeIndex).u32(item.table.index); break;
    case "call_ref": w.u8(OPS.call_ref).u32(item.type.typeIndex); break;
    case "return_call": w.u8(OPS.return_call).u32(item.fn.index); break;
    case "return_call_indirect": w.u8(OPS.return_call_indirect).u32(item.type.typeIndex).u32(item.table.index); break;
    case "return_call_ref": w.u8(OPS.return_call_ref).u32(item.type.typeIndex); break;
    case "reffunc": w.u8(OPS.ref_func).u32(item.fn.index); break;
    case "drop": w.u8(OPS.drop); break;
    default: fail(`internal: cannot encode item ${item.op ?? item.k}`);
  }
}
