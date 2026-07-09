import { fail } from "./errors.js";
import { checkTypeList, checkValType } from "./types.js";
import { pushBuilder, popBuilder, requireBuilder } from "./context.js";
import { makeNode, resolveOperand, Node } from "./node.js";
import { Variable } from "./variable.js";
import { FunctionBuilder } from "./builder.js";
import { encodeModule } from "./encode/encoder.js";
import { MEMORY_OPS, TABLE_OPS, promoteConst, defaultInit, resolveInt32, forEachConstRef, attachTypedRefs } from "./expr.js";
import { funcref, externref, isRef, isVec, typeKey } from "./types.js";
import { attachGCRefs, attachStructOps, attachArrayOps } from "./expr.js";

function checkDebugName(s) {
  if (typeof s !== "string" || s.length === 0) fail(".name(): expected a non-empty string");
  return s;
}

/** Handle for a declared function. Declare first; attach `.body()` or `.import()` later. */
export class FunctionHandle {
  constructor(module, params, results) {
    this.handleKind = "function";
    this.module = module;
    this.params = params;
    this.results = results;
    this.importInfo = null;
    this.builderData = null;
    this.exportName = null;
    this.index = -1; // assigned at emit
  }

  debugName() {
    if (this.exportName) return `"${this.exportName}"`;
    if (this.importInfo) return `"${this.importInfo.module}.${this.importInfo.name}"`;
    return `#${this.module.functions.indexOf(this)}`;
  }

  /** Define the body: cb receives one handle per parameter, then `$`. */
  body(cb) {
    if (this.importInfo) fail(`function ${this.debugName()}: an imported function cannot have a body`);
    if (this.builderData) fail(`function ${this.debugName()}: body is already defined`);
    if (typeof cb !== "function") fail(".body(): expected a callback");
    if (cb.length > this.params.length + 1) {
      fail(
        `function ${this.debugName()}: body callback declares ${cb.length} parameters, ` +
        `but the function has only ${this.params.length} param(s) plus $`,
      );
    }
    const b = new FunctionBuilder(this.module, this);
    const paramHandles = this.params.map(
      (t) => new Variable("function", t, { builder: b, vlocal: b.newVLocal(t, "param"), isParam: true }),
    );
    pushBuilder(b);
    try {
      cb(...paramHandles, b.$);
    } finally {
      popBuilder();
    }
    b.finalize();
    this.builderData = b;
    return this;
  }

  /** Mark the implementation as externally supplied. */
  import(moduleName, name) {
    if (this.builderData) fail(`function ${this.debugName()}: a function with a body cannot be imported`);
    if (this.importInfo) fail(`function ${this.debugName()}: already imported`);
    if (typeof moduleName !== "string" || typeof name !== "string") {
      fail(".import(module, name): both arguments must be strings");
    }
    this.importInfo = { module: moduleName, name };
    return this;
  }

  /** Export under the given name. Chainable; aliases allowed. */
  export(name) {
    this.module._addExport(name, this, "func");
    this.exportName ??= name;
    return this;
  }

  /** Debug name for the name section (overrides the export/import-derived one). */
  name(s) {
    this.nameStr = checkDebugName(s);
    return this;
  }

  /**
   * A funcref to this function — a constant expression, valid outside bodies
   * (e.g. in global initializers, table.set, elem-free contexts). The spec's
   * ref.func declaration requirement is satisfied automatically via a hidden
   * declarative element segment.
   */
  ref() {
    this.module.refFunctions.add(this);
    // ref.func produces the precise non-null type; upcasts to funcref or the
    // nullable form are value-exact promotions at the point of use.
    const t = this.type.ref;
    return makeNode("reffunc", { type: t, results: [t], func: this });
  }

  /** This function's signature as an interned funcType handle. */
  get type() {
    return this.module._internFuncType(this.params, this.results);
  }

  /**
   * Call this function at the current position. Valid before the body exists.
   * 0 results → anchored statement; 1 result → expression node;
   * n results → spilled tuple of variable handles for destructuring.
   */
  call(...args) {
    const what = `call to ${this.debugName()}`;
    const b = requireBuilder(what);
    if (b.module !== this.module) fail(`${what}: function belongs to a different module`);
    if (args.length !== this.params.length) {
      fail(`${what}: expected ${this.params.length} argument(s), got ${args.length}`);
    }
    const operands = this.params.map((t, i) => resolveOperand(args[i], t, `${what} argument ${i + 1}`));
    const anchor = this.results.length !== 1;
    const node = makeNode("call", { results: this.results, func: this, operands }, { anchor });
    if (this.results.length === 0) return undefined;
    if (this.results.length === 1) return node;
    node.spillTemps = this.results.map((t) => b.newVLocal(t, "temp"));
    return this.results.map(
      (t, i) => new Variable("function", t, { builder: b, vlocal: node.spillTemps[i] }),
    );
  }
}

/** Handle for a linear memory. Limits are in 64KiB pages. */
export class MemoryHandle {
  constructor(module, limits) {
    this.handleKind = "memory";
    this.module = module;
    this.limits = limits;
    this.importInfo = null;
    this.exportName = null;
    this.index = -1;
  }

  /** Current size in pages — a u32 expression. */
  size() {
    return MEMORY_OPS.size(this);
  }

  /** Grow by `delta` pages; u32 expression yielding the old size, or 2^32-1 on failure. */
  grow(delta) {
    return MEMORY_OPS.grow(this, delta);
  }

  /** Fill `len` bytes at `dst` with the byte `value`. Statement. */
  fill(dst, value, len) {
    MEMORY_OPS.fill(this, dst, value, len);
  }

  /** Copy `len` bytes from `src` to `dst`. `opts.from` names another source memory. Statement. */
  copy(dst, src, len, opts) {
    MEMORY_OPS.copy(this, dst, src, len, opts);
  }

  /** Copy `len` bytes from a passive data segment (at `src`) to `dst`. Statement. */
  init(seg, dst, src, len) {
    MEMORY_OPS.init(this, seg, dst, src, len);
  }

  /** Wake up to `count` waiters at `addr` — a u32 expression (woken count). */
  notify(addr, count) {
    return MEMORY_OPS.notify(this, addr, count);
  }

  /** Block until notified at `addr`, if it holds `expected` (i32). u32 result: 0 woken, 1 mismatch, 2 timeout. */
  wait32(addr, expected, timeoutNs) {
    return MEMORY_OPS.wait(this, "wait32", addr, expected, timeoutNs);
  }

  /** 64-bit variant of wait32 (expected is s64). */
  wait64(addr, expected, timeoutNs) {
    return MEMORY_OPS.wait(this, "wait64", addr, expected, timeoutNs);
  }

  import(moduleName, name) {
    if (this.importInfo) fail(".import(): memory is already imported");
    if (typeof moduleName !== "string" || typeof name !== "string") {
      fail(".import(module, name): both arguments must be strings");
    }
    this.importInfo = { module: moduleName, name };
    return this;
  }

  export(name) {
    this.module._addExport(name, this, "memory");
    this.exportName ??= name;
    return this;
  }

  /** Debug name for the name section (overrides the export/import-derived one). */
  name(s) {
    this.nameStr = checkDebugName(s);
    return this;
  }
}

/**
 * A reusable function signature, interned into the type section — one handle
 * per distinct signature per module (so `fn.ref()` and a user-declared
 * signature agree on the typed reference types `sig.ref`/`sig.refNull`).
 */
export class FuncTypeHandle {
  constructor(module, params, results, id) {
    this.handleKind = "functype";
    this.module = module;
    this.params = params;
    this.results = results;
    this.typeIndex = -1; // assigned at emit
    attachTypedRefs(this, id);
  }

  /** call_ref: call through a typed reference of this signature (traps on null). */
  call(ref, ...args) {
    const what = "sig.call()";
    const b = requireBuilder(what);
    if (this.module !== b.module) fail(`${what}: signature belongs to a different module`);
    if (args.length !== this.params.length) {
      fail(`${what}: signature expects ${this.params.length} argument(s), got ${args.length}`);
    }
    const operands = this.params.map((t, i) => resolveOperand(args[i], t, `${what} argument ${i + 1}`));
    const r = resolveOperand(ref, null, `${what} reference`);
    if (r.type !== this.ref && r.type !== this.refNull) {
      fail(`${what}: expected a ${this.ref.name} or ${this.refNull.name}, got ${r.type.name}`);
    }
    operands.push(r); // args, then the reference, on the stack
    const anchor = this.results.length !== 1;
    const node = makeNode(
      "call_ref",
      { results: this.results, funcType: this, operands, display: what },
      { anchor },
    );
    if (this.results.length === 0) return undefined;
    if (this.results.length === 1) return node;
    node.spillTemps = this.results.map((t) => b.newVLocal(t, "temp"));
    return this.results.map(
      (t, i) => new Variable("function", t, { builder: b, vlocal: node.spillTemps[i] }),
    );
  }
}

function parseFieldSpec(spec, what) {
  let mutable = true;
  let t = spec;
  if (t && t.__imm !== undefined) {
    mutable = false;
    t = t.__imm;
  }
  if (t && t.packed) return { storage: t, mutable };
  checkValType(t, what);
  return { storage: t, mutable };
}

/** A GC struct type: named, ordered fields; optional declared supertype. */
export class StructTypeHandle {
  constructor(module, id) {
    this.handleKind = "structtype";
    this.module = module;
    this.fieldsSpec = null;
    this.fieldIndex = null;
    this.superType = null;
    this.typeIndex = -1;
    attachGCRefs(this, `struct#${id}`);
  }

  /** Attach fields (declare-then-define enables recursive types). */
  fields(spec, opts = {}) {
    if (this.fieldsSpec) fail(".fields(): this struct's fields are already defined");
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      fail(".fields(): expected an object of { name: type } fields (order is field order)");
    }
    const names = Object.keys(spec);
    const parsed = names.map((name) => ({ name, ...parseFieldSpec(spec[name], `struct field "${name}"`) }));
    if (opts.extends !== undefined) {
      const base = opts.extends;
      if (base?.handleKind !== "structtype" || base.module !== this.module) {
        fail(".fields(): `extends` must be a struct type from this module");
      }
      if (base === this) fail(".fields(): a struct cannot extend itself");
      if (!base.fieldsSpec) fail(".fields(): define the supertype's fields before extending it");
      if (parsed.length < base.fieldsSpec.length) {
        fail(".fields(): a subtype must repeat all supertype fields first");
      }
      base.fieldsSpec.forEach((bf, i) => {
        const cf = parsed[i];
        if (cf.name !== bf.name || cf.storage !== bf.storage || cf.mutable !== bf.mutable) {
          fail(`.fields(): field ${i} ("${cf.name}") must match the supertype's ("${bf.name}": ${bf.storage.name}${bf.mutable ? "" : ", immutable"})`);
        }
      });
      this.superType = base;
    }
    this.fieldsSpec = parsed;
    this.fieldIndex = new Map(parsed.map((f, i) => [f.name, i]));
    attachStructOps(this);
    return this;
  }
}

/** A GC array type: one element storage type + mutability. */
export class ArrayTypeHandle {
  constructor(module, id) {
    this.handleKind = "arraytype";
    this.module = module;
    this.elemSpec = null;
    this.typeIndex = -1;
    attachGCRefs(this, `array#${id}`);
  }

  element(spec) {
    if (this.elemSpec) fail(".element(): this array's element type is already defined");
    this.elemSpec = parseFieldSpec(spec, "array element");
    attachArrayOps(this);
    return this;
  }
}

/** An exception tag: a typed signature for thrown values (wasm 3.0 EH). */
export class TagHandle {
  constructor(module, params) {
    this.handleKind = "tag";
    this.module = module;
    this.params = params;
    this.importInfo = null;
    this.exportName = null;
    this.index = -1; // assigned at emit
  }

  import(moduleName, name) {
    if (this.importInfo) fail(".import(): tag is already imported");
    if (typeof moduleName !== "string" || typeof name !== "string") {
      fail(".import(module, name): both arguments must be strings");
    }
    this.importInfo = { module: moduleName, name };
    return this;
  }

  export(name) {
    this.module._addExport(name, this, "tag");
    this.exportName ??= name;
    return this;
  }

  /** Debug name for the name section (overrides the export/import-derived one). */
  name(s) {
    this.nameStr = checkDebugName(s);
    return this;
  }
}

/** Handle for a table. Element type funcref or externref; limits in elements. */
export class TableHandle {
  constructor(module, elemType, limits) {
    this.handleKind = "table";
    this.module = module;
    this.elemType = elemType;
    this.limits = limits;
    this.importInfo = null;
    this.exportName = null;
    this.index = -1;
  }

  /** Read entry `index` — a ref expression of the table's element type. */
  get(index) {
    return TABLE_OPS.get(this, index);
  }

  /** Write entry `index`. Statement. */
  set(index, value) {
    TABLE_OPS.set(this, index, value);
  }

  /** Current size in elements — a u32 expression. */
  size() {
    return TABLE_OPS.size(this);
  }

  /** Grow by `delta` entries filled with `init` (default null); u32: old size, or 2^32-1 on failure. */
  grow(delta, init) {
    return TABLE_OPS.grow(this, delta, init);
  }

  /** Fill `len` entries from `start` with `value`. Statement. */
  fill(start, value, len) {
    TABLE_OPS.fill(this, start, value, len);
  }

  /** Copy `len` entries from `src` to `dst`; `{ from }` selects another source table. Statement. */
  copy(dst, src, len, opts) {
    TABLE_OPS.copy(this, dst, src, len, opts);
  }

  /** Copy `len` entries from a passive element segment (at `src`) to `dst`. Statement. */
  init(seg, dst, src, len) {
    TABLE_OPS.init(this, seg, dst, src, len);
  }

  /**
   * call_indirect through this table: the callee at `index` is checked at
   * runtime against `type` (a mod.funcType handle), trapping on OOB, null,
   * or signature mismatch. Results follow fn.call's rules.
   */
  call(type, index, ...args) {
    const what = "tbl.call()";
    const b = requireBuilder(what);
    if (b.module !== this.module) fail(`${what}: table belongs to a different module`);
    if (this.elemType !== funcref) {
      fail(`${what}: call_indirect requires a funcref table, this one holds ${this.elemType.name}`);
    }
    if (type?.handleKind !== "functype") fail(`${what}: expected a mod.funcType handle as the signature`);
    if (type.module !== this.module) fail(`${what}: signature belongs to a different module`);
    if (args.length !== type.params.length) {
      fail(`${what}: signature expects ${type.params.length} argument(s), got ${args.length}`);
    }
    const operands = type.params.map((t, i) => resolveOperand(args[i], t, `${what} argument ${i + 1}`));
    operands.push(resolveInt32(index, `${what} index`)); // args, then index, on the stack
    const anchor = type.results.length !== 1;
    const node = makeNode(
      "call_indirect",
      { results: type.results, funcType: type, table: this, operands, display: what },
      { anchor },
    );
    if (type.results.length === 0) return undefined;
    if (type.results.length === 1) return node;
    node.spillTemps = type.results.map((t) => b.newVLocal(t, "temp"));
    return type.results.map(
      (t, i) => new Variable("function", t, { builder: b, vlocal: node.spillTemps[i] }),
    );
  }

  import(moduleName, name) {
    if (this.importInfo) fail(".import(): table is already imported");
    if (typeof moduleName !== "string" || typeof name !== "string") {
      fail(".import(module, name): both arguments must be strings");
    }
    this.importInfo = { module: moduleName, name };
    return this;
  }

  export(name) {
    this.module._addExport(name, this, "table");
    this.exportName ??= name;
    return this;
  }

  /** Debug name for the name section (overrides the export/import-derived one). */
  name(s) {
    this.nameStr = checkDebugName(s);
    return this;
  }
}

/**
 * An element segment (funcref entries: function handles or null). Passive by
 * default (copied via `tbl.init`); `.at(table, offset)` makes it active.
 */
export class ElemSegment {
  constructor(module, items) {
    this.handleKind = "elem";
    this.module = module;
    this.items = items;
    this.active = null; // { table, offset }
    this.declarative = false;
    this.index = -1;
  }

  /** Pin as active: copied into `table` at `offset` when the module instantiates. */
  at(table, offset) {
    if (this.active) fail(".at(): element segment is already active");
    if (table?.handleKind !== "table" || table.module !== this.module) {
      fail(".at(): expected a table handle from this module");
    }
    const et = table.elemType;
    if (et !== funcref && !et.heapType) {
      fail(".at(): element segments hold function references — the table must be funcref- or sig.refNull-typed");
    }
    if (et.heapType) {
      for (const f of this.items) {
        if (f !== null && f.type !== et.heapType) {
          fail(`.at(): ${f.debugName()} does not have this table's signature (${et.name})`);
        }
      }
    }
    this.active = { table, offset: resolveDataOffset(this.module, offset) };
    return this;
  }

  /** elem.drop — release the segment's contents at runtime. Statement. */
  drop() {
    TABLE_OPS.dropElem(this);
  }

  /** Debug name for the name section. */
  name(s) {
    this.nameStr = checkDebugName(s);
    return this;
  }
}

/**
 * A data segment. Passive by default (copied at runtime via `mem.init`);
 * chaining `.at(mem, offset)` makes it active (copied at instantiation).
 */
export class DataSegment {
  constructor(module, bytes) {
    this.handleKind = "data";
    this.module = module;
    this.bytes = bytes;
    this.active = null; // { mem, offset: {kind: 'int'|'const'|'global', ...} }
    this.index = -1;
  }

  /** Pin as active: copied into `mem` at `offset` when the module instantiates. */
  at(mem, offset) {
    if (this.active) fail(".at(): data segment is already active");
    if (mem?.handleKind !== "memory" || mem.module !== this.module) {
      fail(".at(): expected a memory handle from this module");
    }
    this.active = { mem, offset: resolveDataOffset(this.module, offset) };
    return this;
  }

  /** data.drop — release the segment's contents at runtime. Statement. */
  drop() {
    MEMORY_OPS.dropData(this);
  }

  /** Debug name for the name section. */
  name(s) {
    this.nameStr = checkDebugName(s);
    return this;
  }
}

function resolveDataOffset(module, offset) {
  if (typeof offset === "number") {
    if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) {
      fail(".at(): offset must be an integer in [0, 2^32)");
    }
    return { kind: "int", value: offset };
  }
  if (offset instanceof Node && offset.kind === "const" && offset.type.wasmType.name === "i32") {
    return { kind: "const", node: offset };
  }
  if (offset instanceof Node && offset.kind === "constop" && offset.type.wasmType.name === "i32") {
    forEachConstRef(offset, (ref) => {
      if (ref.module !== module) fail(".at(): offset expression reads a variable from a different module");
    });
    return { kind: "constexpr", node: offset };
  }
  if (offset?.handleKind === "variable" && offset.scope === "module" && offset.type.wasmType.name === "i32") {
    return { kind: "global", variable: offset }; // must be immutable — checked at emit
  }
  fail(".at(): offset must be an integer, an s32/u32 const, constant add/sub/mul, or an immutable module variable");
}

function checkLimits(limits, what) {
  const MAX_PAGES = 65536;
  if (limits === null || typeof limits !== "object") fail(`${what}: expected { min, max? }`);
  const { min, max, shared } = limits;
  if (shared !== undefined && typeof shared !== "boolean") fail(`${what}: shared must be a boolean`);
  if (shared && max === undefined) fail(`${what}: a shared memory requires a max`);
  if (!Number.isInteger(min) || min < 0 || min > MAX_PAGES) {
    fail(`${what}: min must be an integer page count in [0, ${MAX_PAGES}]`);
  }
  if (max !== undefined) {
    if (!Number.isInteger(max) || max < min || max > MAX_PAGES) {
      fail(`${what}: max must be an integer page count in [min, ${MAX_PAGES}]`);
    }
  }
  return shared ? { min, max, shared: true } : { min, max };
}

/** A WebAssembly module under construction. */
export class Module {
  /**
   * Safe value-exact promotion is always on: operands lift into an op's
   * namespace type when they fit exactly (s32→s64, u32→s64/u64, f32→f64,
   * s32/u32→f64, bool→anything numeric). Lossy or narrowing moves are errors.
   *
   * @param {{debug?: boolean, permissive?: boolean, tailCalls?: boolean, names?: boolean}} [opts]
   *  - debug: capture creation stack traces for emit-time errors
   *  - permissive: bit-level leniency within a storage width — conditions
   *    accept integers (non-zero is true), integer positions accept the
   *    opposite signedness, bool positions test integers for ≠0
   *  - tailCalls: default true — $.return of a call emits return_call.
   *    Set false to keep plain calls (full stack traces; no wasm 3.0
   *    engine requirement from this feature)
   *  - names: default true — emit a name section: entities auto-derive
   *    debug names from their export (or "module.name" import) and
   *    .name("str") overrides. Set false to strip names entirely
   */
  constructor(opts = {}) {
    this.debug = opts.debug ?? false;
    this.permissive = opts.permissive ?? false;
    this.tailCalls = opts.tailCalls ?? true;
    this.names = opts.names ?? true;
    this.moduleName = null;
    this.functions = [];
    this.variables = [];
    this.memories = [];
    this.tables = [];
    this.funcTypes = [];
    this.dataSegments = [];
    this.elemSegments = [];
    this.refFunctions = new Set(); // ref.func'd — auto-declared at emit
    this.tags = [];
    this.gcTypes = [];
    this._funcTypesByKey = new Map(); // signature interning (typed refs need one handle per shape)
    this.exports = [];
    this.exportNames = new Set();
    this.startFunction = null;
  }

  /**
   * Declare a function. Attach `.body()`, `.import()`, `.export()` on the
   * returned handle. Accepts either (params, results) arrays or a single
   * mod.funcType handle.
   */
  function(paramsOrType, results) {
    let p, r;
    if (paramsOrType?.handleKind === "functype") {
      if (paramsOrType.module !== this) fail("mod.function: funcType belongs to a different module");
      if (results !== undefined) fail("mod.function: pass either a funcType or (params, results), not both");
      p = paramsOrType.params;
      r = paramsOrType.results;
    } else {
      p = checkTypeList(paramsOrType, "mod.function params");
      r = checkTypeList(results, "mod.function results");
    }
    const handle = new FunctionHandle(this, p, r);
    this.functions.push(handle);
    return handle;
  }

  /**
   * Declare a reusable function signature (for call_indirect, call_ref, and
   * mod.function). Interned: identical signatures return the same handle.
   */
  funcType(params, results) {
    return this._internFuncType(
      checkTypeList(params, "mod.funcType params"),
      checkTypeList(results, "mod.funcType results"),
    );
  }

  _internFuncType(params, results) {
    const key = typeKey(params, results);
    let handle = this._funcTypesByKey.get(key);
    if (!handle) {
      handle = new FuncTypeHandle(this, params, results, this.funcTypes.length);
      this._funcTypesByKey.set(key, handle);
      this.funcTypes.push(handle);
    }
    return handle;
  }

  /** Declare a table of funcref or externref elements. Limits in elements. */
  table(elemType, limits) {
    if (elemType !== funcref && elemType !== externref && !elemType?.heapType) {
      fail("mod.table: element type must be funcref, externref, or a typed reference (sig.refNull)");
    }
    if (elemType?.nonNull) {
      fail("mod.table: non-null element types have no default value — use sig.refNull");
    }
    if (limits === null || typeof limits !== "object") fail("mod.table: expected { min, max? }");
    const { min, max } = limits;
    if (!Number.isInteger(min) || min < 0) fail("mod.table: min must be a non-negative integer");
    if (max !== undefined && (!Number.isInteger(max) || max < min)) {
      fail("mod.table: max must be an integer ≥ min");
    }
    const handle = new TableHandle(this, elemType, { min, max });
    this.tables.push(handle);
    return handle;
  }

  /**
   * Declare an element segment: an array of function handles (or null).
   * Passive unless `.at(table, offset)` chains.
   */
  elem(items) {
    if (!Array.isArray(items)) fail("mod.elem: expected an array of function handles (or null)");
    for (const f of items) {
      if (f === null) continue;
      if (f?.handleKind !== "function" || f.module !== this) {
        fail("mod.elem: items must be function handles from this module, or null");
      }
    }
    const handle = new ElemSegment(this, [...items]);
    this.elemSegments.push(handle);
    return handle;
  }

  /** Declare a module-scoped variable (a wasm global). Mutable and zero-initialized by default. */
  variable(type, init) {
    checkValType(type, "mod.variable");
    const initExplicit = init !== undefined;
    const resolved = resolveModuleInit(this, type, init);
    const handle = new Variable("module", type, { module: this, init: resolved, initExplicit });
    this.variables.push(handle);
    return handle;
  }

  /** Declare a GC struct type. Omit fields and call .fields() later for recursion. */
  struct(fields, opts) {
    const handle = new StructTypeHandle(this, this.gcTypes.length);
    this.gcTypes.push(handle);
    if (fields !== undefined) handle.fields(fields, opts);
    return handle;
  }

  /** Declare a GC array type. Omit the element and call .element() later. */
  array(element) {
    const handle = new ArrayTypeHandle(this, this.gcTypes.length);
    this.gcTypes.push(handle);
    if (element !== undefined) handle.element(element);
    return handle;
  }

  /** Declare an exception tag with the given payload types (wasm 3.0 EH). */
  tag(params) {
    const handle = new TagHandle(this, checkTypeList(params, "mod.tag params"));
    this.tags.push(handle);
    return handle;
  }

  /** Declare a linear memory. Limits in 64KiB pages. */
  memory(limits) {
    const handle = new MemoryHandle(this, checkLimits(limits, "mod.memory"));
    this.memories.push(handle);
    return handle;
  }

  /**
   * Declare a data segment from raw bytes (copied now — later mutation of the
   * source does not affect the module). Passive unless `.at(mem, offset)` chains.
   * @param {Uint8Array|ArrayBuffer} bytes
   */
  data(bytes) {
    let copy;
    if (bytes instanceof Uint8Array) copy = bytes.slice();
    else if (bytes instanceof ArrayBuffer) copy = new Uint8Array(bytes.slice(0));
    else fail("mod.data: expected a Uint8Array or ArrayBuffer");
    const handle = new DataSegment(this, copy);
    this.dataSegments.push(handle);
    return handle;
  }

  /** Designate the start function (must be [] -> []). */
  start(fn) {
    if (fn?.handleKind !== "function" || fn.module !== this) {
      fail("mod.start: expected a function handle from this module");
    }
    if (fn.params.length || fn.results.length) {
      fail("mod.start: the start function must have no parameters and no results");
    }
    if (this.startFunction) fail("mod.start: a start function is already set");
    this.startFunction = fn;
    return this;
  }

  /** Module debug name for the name section. */
  name(s) {
    if (typeof s !== "string" || s.length === 0) fail("mod.name(): expected a non-empty string");
    this.moduleName = s;
    return this;
  }

  /** Emit the module as binary wasm bytes. Repeatable. */
  emit() {
    return encodeModule(this);
  }

  _addExport(name, handle, kind) {
    if (typeof name !== "string" || name.length === 0) fail(".export(): name must be a non-empty string");
    if (this.exportNames.has(name)) fail(`.export(): duplicate export name "${name}"`);
    this.exportNames.add(name);
    this.exports.push({ name, handle, kind });
  }
}

/**
 * Validate a module-variable initializer against wasm's constant-expression
 * grammar: a JS value, a t.const node, or an (imported immutable) module
 * variable handle. Checked further at emit.
 */
function resolveModuleInit(module, type, init) {
  if (init === undefined) return { kind: "const", node: defaultInit(type) };
  if (init === null && isRef(type)) return { kind: "const", node: type.null() };
  if (typeof init === "number" || typeof init === "bigint" || typeof init === "boolean") {
    return { kind: "const", node: type.const(init) };
  }
  if (Array.isArray(init) && isVec(type) && type.const) {
    return { kind: "const", node: type.const(init) }; // lane values, like scalar JS inits
  }
  if (init instanceof Node) {
    if (init.kind === "reffunc") {
      // upcasts (precise ref → its nullable form or funcref) are value-exact
      const upcast = type === funcref || (type.heapType && init.type.nullableTwin === type);
      if (init.type !== type && !upcast) {
        fail(`mod.variable init: expected ${type.name}, got ${init.type.name}`);
      }
      return { kind: "const", node: init };
    }
    if (init.kind === "constop") {
      if (init.type !== type) fail(`mod.variable init: expected ${type.name}, got ${init.type.name}`);
      forEachConstRef(init, (ref) => {
        if (ref.module !== module) fail("mod.variable init: expression reads a variable from a different module");
      });
      return { kind: "constexpr", node: init };
    }
    if (init.kind !== "const") {
      fail(`mod.variable init: must be a constant expression (${type.name}.const, constant add/sub/mul, or an immutable module variable)`);
    }
    if (init.type !== type) {
      // Constant promotion happens at build time — the result is still a t.const.
      const lifted = promoteConst(init, type);
      if (lifted) return { kind: "const", node: lifted };
      fail(`mod.variable init: expected ${type.name}, got ${init.type.name}`);
    }
    return { kind: "const", node: init };
  }
  if (init?.handleKind === "variable" && init.scope === "module") {
    if (init.type !== type) fail(`mod.variable init: expected ${type.name}, got ${init.type.name}`);
    return { kind: "global", variable: init };
  }
  fail("mod.variable init: expected a JS value, a t.const expression, or a module variable handle");
}
