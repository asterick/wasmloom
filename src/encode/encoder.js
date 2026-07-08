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
};

const EXPORT_KIND = { func: 0, table: 1, memory: 2, global: 3 };

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

  // Element segments: user segments in declaration order, then (if any
  // function was ref.func'd) one hidden declarative segment satisfying the
  // spec's declaration requirement.
  const elemSegments = [...module.elemSegments];
  if (module.refFunctions.size > 0) {
    elemSegments.push({ declarative: true, items: [...module.refFunctions], active: null });
  }
  elemSegments.forEach((seg, i) => (seg.index = i));
  for (const seg of elemSegments) {
    if (seg.active?.offset.kind === "global") {
      const ref = seg.active.offset.variable;
      if (!ref.importInfo || ref.mutable) {
        fail(".at(): an offset variable must be an imported immutable module variable");
      }
    }
  }

  const importedGlobals = module.variables.filter((g) => g.importInfo);
  const definedGlobals = module.variables.filter((g) => !g.importInfo);
  [...importedGlobals, ...definedGlobals].forEach((g, i) => (g.index = i));

  module.dataSegments.forEach((seg, i) => (seg.index = i));
  for (const seg of module.dataSegments) {
    if (seg.active?.offset.kind === "global") {
      const ref = seg.active.offset.variable;
      if (!ref.importInfo || ref.mutable) {
        fail(".at(): an offset variable must be an imported immutable module variable");
      }
    }
  }

  for (const g of module.variables) {
    if (!g.mutable && g.setCount > 0) {
      fail(`module variable ${g.describe()}: immutable but written by .set()`);
    }
    if (!g.importInfo && g.init.kind === "global") {
      const ref = g.init.variable;
      if (!ref.importInfo || ref.mutable) {
        fail("mod.variable init: an initializer may only reference an imported immutable variable");
      }
    }
  }

  // Intern function signatures.
  const typeIndices = new Map();
  const typeList = [];
  const internType = (params, results) => {
    const key = typeKey(params, results);
    if (!typeIndices.has(key)) {
      typeIndices.set(key, typeList.length);
      typeList.push({ params, results });
    }
    return typeIndices.get(key);
  };
  for (const f of [...importedFns, ...definedFns]) {
    f.typeIndex = internType(f.params, f.results);
  }
  for (const ft of module.funcTypes) {
    ft.typeIndex = internType(ft.params, ft.results);
  }

  // Compile all defined bodies before writing anything. Compilation mutates
  // per-node state (temp assignment), so it runs once per function and is
  // cached — emit() must be repeatable and byte-stable.
  const bodies = definedFns.map((f) => (f.compiled ??= compileFunction(f)));

  const w = new ByteWriter();
  w.bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  w.section(SECTION.type, (s) => {
    s.vec(typeList, (sw, t) => {
      sw.u8(OPS.functype);
      sw.vec(t.params, (x, p) => x.u8(p.code));
      sw.vec(t.results, (x, r) => x.u8(r.code));
    });
  });

  const imports = [
    ...importedFns.map((f) => ({ info: f.importInfo, write: (s) => s.u8(0x00).u32(f.typeIndex) })),
    ...importedTables.map((t) => ({
      info: t.importInfo,
      write: (s) => { s.u8(0x01).u8(t.elemType.code); writeLimits(s, t.limits); },
    })),
    ...importedMems.map((m) => ({
      info: m.importInfo,
      write: (s) => { s.u8(0x02); writeLimits(s, m.limits); },
    })),
    ...importedGlobals.map((g) => ({
      info: g.importInfo,
      write: (s) => s.u8(0x03).u8(g.type.code).u8(g.mutable ? 1 : 0),
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
      sw.u8(t.elemType.code);
      writeLimits(sw, t.limits);
    });
  });

  w.section(SECTION.memory, (s) => {
    if (definedMems.length === 0) return;
    s.vec(definedMems, (sw, m) => writeLimits(sw, m.limits));
  });

  w.section(SECTION.global, (s) => {
    if (definedGlobals.length === 0) return;
    s.vec(definedGlobals, (sw, g) => {
      sw.u8(g.type.code).u8(g.mutable ? 1 : 0);
      if (g.init.kind === "global") {
        sw.u8(OPS.global_get).u32(g.init.variable.index);
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
      writeBody(bw, body);
      sw.u32(bw.len).bytes(bw.toBytes());
    });
  });

  w.section(SECTION.data, (s) => {
    if (module.dataSegments.length === 0) return;
    s.vec(module.dataSegments, (sw, seg) => {
      if (seg.active) {
        sw.u8(0x00);
        writeConstOffset(sw, seg.active.offset);
      } else {
        sw.u8(0x01);
      }
      sw.u32(seg.bytes.length).bytes(seg.bytes);
    });
  });

  return w.toBytes();
}

/** Run the full pipeline for one defined function. */
function compileFunction(fn) {
  const builder = fn.builderData;
  let cfg = analyzeCfg(builder.entry);
  const code = linearize(builder, cfg);
  // Multi-use dominance was checked against the CFG as written; lowering
  // irreducible flow (splitting/dispatch) preserves execution order, so
  // everything downstream runs on the rewritten graph.
  cfg = makeReducible(builder, cfg, code);
  const liveOut = computeLiveness(builder.blocks, code, cfg);
  const { slotOf, localsDecl } = allocateSlots(builder, code, liveOut, cfg);
  const tree = reloop(builder, cfg, code);
  return { tree, slotOf, localsDecl };
}

function writeLimits(s, limits) {
  if (limits.max !== undefined) s.u8(0x01).u32(limits.min).u32(limits.max);
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
      s.u8(OPS.ref_null).u8(node.type.code);
      break;
    default: fail(`internal: cannot encode const of ${node.type.name}`);
  }
}

/** Constant offset expression for active data/element segments. */
function writeConstOffset(s, off) {
  if (off.kind === "int") {
    const signed = off.value > 0x7fffffff ? off.value - 0x100000000 : off.value;
    s.u8(OPS.i32_const).s32(signed);
  } else if (off.kind === "global") {
    s.u8(OPS.global_get).u32(off.variable.index);
  } else {
    writeConst(s, off.node);
  }
  s.u8(OPS.end);
}

/** One element segment, picking the tightest encoding flavor. */
function writeElemSegment(s, seg) {
  const exprForm = seg.items.some((f) => f === null);
  const funcVec = () => s.vec(seg.items, (sw, f) => sw.u32(f.index));
  const exprVec = () =>
    s.vec(seg.items, (sw, f) => {
      if (f) sw.u8(OPS.ref_func).u32(f.index);
      else sw.u8(OPS.ref_null).u8(0x70);
      sw.u8(OPS.end);
    });
  if (seg.declarative) {
    s.u32(3).u8(0x00);
    funcVec();
  } else if (seg.active) {
    const t = seg.active.table;
    if (t.index === 0 && !exprForm) {
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

function writeBody(w, { tree, slotOf, localsDecl }) {
  w.vec(localsDecl, (s, d) => s.u32(d.count).u8(d.type.code));
  writeSeq(w, tree, slotOf);
  // Every CFG block ends in an explicit transfer, so control never actually
  // falls off the end — but when the last item is structured (if/loop/block),
  // the validator still types the fallthrough. Cap it as unreachable.
  const last = tree[tree.length - 1];
  const diverges = last && ["return", "unreachable", "br", "br_table"].includes(last.op);
  if (!diverges) w.u8(OPS.unreachable);
  w.u8(OPS.end);
}

function writeSeq(w, items, slotOf) {
  for (const item of items) writeItem(w, item, slotOf);
}

function writeItem(w, item, slotOf) {
  switch (item.op ?? item.k) {
    // structured / control
    case "block":
      w.u8(OPS.block).u8(OPS.blocktype_empty);
      writeSeq(w, item.body, slotOf);
      w.u8(OPS.end);
      break;
    case "loop":
      w.u8(OPS.loop).u8(OPS.blocktype_empty);
      writeSeq(w, item.body, slotOf);
      w.u8(OPS.end);
      break;
    case "if":
      w.u8(OPS.if).u8(OPS.blocktype_empty);
      writeSeq(w, item.then, slotOf);
      if (item.else.length > 0) {
        w.u8(OPS.else);
        writeSeq(w, item.else, slotOf);
      }
      w.u8(OPS.end);
      break;
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
    case "get": w.u8(OPS.local_get).u32(slotOf.get(item.v)); break;
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
        w.u32(item.memarg.align).u32(item.memarg.offset);
      } else {
        switch (item.entry.imm) {
          case "mem": w.u32(0); break; // single memory: index 0
          case "mem+mem": w.u32(0).u32(0); break;
          case "data": w.u32(item.segment.index); break;
          case "data+mem": w.u32(item.segment.index).u32(0); break;
          case "table": w.u32(item.table.index); break;
          case "table+table": w.u32(item.table.index).u32(item.srcTable.index); break;
          case "elem": w.u32(item.segment.index); break;
          case "elem+table": w.u32(item.segment.index).u32(item.table.index); break;
          case "shuffle": w.bytes(item.lanes); break; // 16 lane indices
          default: break; // no immediates
        }
      }
      // laneidx immediate follows the memarg on lane loads/stores
      if (item.entry.lane !== undefined) w.u8(item.lane);
      break;
    case "call": w.u8(OPS.call).u32(item.fn.index); break;
    case "call_indirect": w.u8(OPS.call_indirect).u32(item.type.typeIndex).u32(item.table.index); break;
    case "reffunc": w.u8(OPS.ref_func).u32(item.fn.index); break;
    case "drop": w.u8(OPS.drop); break;
    default: fail(`internal: cannot encode item ${item.op ?? item.k}`);
  }
}
