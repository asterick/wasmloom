import { fail } from "./errors.js";
import { checkTypeList, checkValType } from "./types.js";
import { pushBuilder, popBuilder, requireBuilder } from "./context.js";
import { makeNode, resolveOperand, Node } from "./node.js";
import { Variable } from "./variable.js";
import { FunctionBuilder } from "./builder.js";
import { encodeModule } from "./encode/encoder.js";
import { MEMORY_OPS, promoteConst } from "./expr.js";

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

  /** Copy `len` bytes from `src` to `dst` within this memory. Statement. */
  copy(dst, src, len) {
    MEMORY_OPS.copy(this, dst, src, len);
  }

  /** Copy `len` bytes from a passive data segment (at `src`) to `dst`. Statement. */
  init(seg, dst, src, len) {
    MEMORY_OPS.init(this, seg, dst, src, len);
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
    this.active = { mem, offset: resolveDataOffset(offset) };
    return this;
  }

  /** data.drop — release the segment's contents at runtime. Statement. */
  drop() {
    MEMORY_OPS.dropData(this);
  }
}

function resolveDataOffset(offset) {
  if (typeof offset === "number") {
    if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) {
      fail(".at(): offset must be an integer in [0, 2^32)");
    }
    return { kind: "int", value: offset };
  }
  if (offset instanceof Node && offset.kind === "const" && offset.type.wasmType.name === "i32") {
    return { kind: "const", node: offset };
  }
  if (offset?.handleKind === "variable" && offset.scope === "module" && offset.type.wasmType.name === "i32") {
    return { kind: "global", variable: offset }; // must be imported immutable — checked at emit
  }
  fail(".at(): offset must be an integer, an s32/u32 const, or an imported immutable module variable");
}

function checkLimits(limits, what) {
  const MAX_PAGES = 65536;
  if (limits === null || typeof limits !== "object") fail(`${what}: expected { min, max? }`);
  const { min, max } = limits;
  if (!Number.isInteger(min) || min < 0 || min > MAX_PAGES) {
    fail(`${what}: min must be an integer page count in [0, ${MAX_PAGES}]`);
  }
  if (max !== undefined) {
    if (!Number.isInteger(max) || max < min || max > MAX_PAGES) {
      fail(`${what}: max must be an integer page count in [min, ${MAX_PAGES}]`);
    }
  }
  return { min, max };
}

/** A WebAssembly module under construction. */
export class Module {
  /**
   * Safe value-exact promotion is always on: operands lift into an op's
   * namespace type when they fit exactly (s32→s64, u32→s64/u64, f32→f64,
   * s32/u32→f64, bool→anything numeric). Lossy or narrowing moves are errors.
   *
   * @param {{debug?: boolean, permissive?: boolean}} [opts]
   *  - debug: capture creation stack traces for emit-time errors
   *  - permissive: bit-level leniency within a storage width — conditions
   *    accept integers (non-zero is true), integer positions accept the
   *    opposite signedness, bool positions test integers for ≠0
   */
  constructor(opts = {}) {
    this.debug = opts.debug ?? false;
    this.permissive = opts.permissive ?? false;
    this.functions = [];
    this.variables = [];
    this.memories = [];
    this.dataSegments = [];
    this.exports = [];
    this.exportNames = new Set();
    this.startFunction = null;
  }

  /** Declare a function. Attach `.body()`, `.import()`, `.export()` on the returned handle. */
  function(params, results) {
    const p = checkTypeList(params, "mod.function params");
    const r = checkTypeList(results, "mod.function results");
    const handle = new FunctionHandle(this, p, r);
    this.functions.push(handle);
    return handle;
  }

  /** Declare a module-scoped variable (a wasm global). Mutable and zero-initialized by default. */
  variable(type, init) {
    checkValType(type, "mod.variable");
    const initExplicit = init !== undefined;
    const resolved = resolveModuleInit(type, init);
    const handle = new Variable("module", type, { module: this, init: resolved, initExplicit });
    this.variables.push(handle);
    return handle;
  }

  /** Declare a linear memory. Limits in 64KiB pages. At most one per module. */
  memory(limits) {
    if (this.memories.length > 0) fail("mod.memory: a module may declare at most one memory");
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
function resolveModuleInit(type, init) {
  if (init === undefined) return { kind: "const", node: type.const(type.zero) };
  if (typeof init === "number" || typeof init === "bigint" || typeof init === "boolean") {
    return { kind: "const", node: type.const(init) };
  }
  if (init instanceof Node) {
    if (init.kind !== "const") {
      fail(`mod.variable init: must be a constant expression (${type.name}.const, or an imported immutable variable)`);
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
