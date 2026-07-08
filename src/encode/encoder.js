import { fail } from "../errors.js";
import { ByteWriter } from "./leb.js";
import { OPS } from "../optable.js";
import { typeKey } from "../types.js";
import { analyzeCfg } from "../passes/dominators.js";
import { linearize } from "../passes/linearize.js";
import { computeLiveness } from "../passes/liveness.js";
import { allocateSlots } from "../passes/slots.js";
import { reloop } from "../passes/relooper.js";

const SECTION = {
  type: 1,
  import: 2,
  function: 3,
  memory: 5,
  global: 6,
  export: 7,
  start: 8,
  code: 10,
};

const EXPORT_KIND = { func: 0, memory: 2, global: 3 };

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

  const importedGlobals = module.variables.filter((g) => g.importInfo);
  const definedGlobals = module.variables.filter((g) => !g.importInfo);
  [...importedGlobals, ...definedGlobals].forEach((g, i) => (g.index = i));

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

  // Compile all defined bodies before writing anything.
  const bodies = definedFns.map((f) => compileFunction(f));

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

  w.section(SECTION.code, (s) => {
    if (bodies.length === 0) return;
    s.vec(bodies, (sw, body) => {
      const bw = new ByteWriter();
      writeBody(bw, body);
      sw.u32(bw.len).bytes(bw.toBytes());
    });
  });

  return w.toBytes();
}

/** Run the full pipeline for one defined function. */
function compileFunction(fn) {
  const builder = fn.builderData;
  const cfg = analyzeCfg(builder.entry);
  const code = linearize(builder, cfg);
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
  switch (node.type.name) {
    case "i32": s.u8(OPS.i32_const).s32(node.value); break;
    case "i64": s.u8(OPS.i64_const).s64(node.value); break;
    case "f32": s.u8(OPS.f32_const).f32(node.value); break;
    case "f64": s.u8(OPS.f64_const).f64(node.value); break;
    default: fail(`internal: cannot encode const of ${node.type.name}`);
  }
}

function writeBody(w, { tree, slotOf, localsDecl }) {
  w.vec(localsDecl, (s, d) => s.u32(d.count).u8(d.type.code));
  writeSeq(w, tree, slotOf);
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
      w.bytes(item.entry.op);
      if (item.entry.mem) w.u32(item.memarg.align).u32(item.memarg.offset);
      break;
    case "call": w.u8(OPS.call).u32(item.fn.index); break;
    case "drop": w.u8(OPS.drop); break;
    default: fail(`internal: cannot encode item ${item.op ?? item.k}`);
  }
}
