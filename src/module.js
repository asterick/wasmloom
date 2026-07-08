import { fail } from "./errors.js";
import { checkTypeList, checkValType } from "./types.js";
import { pushBuilder, popBuilder, requireBuilder } from "./context.js";
import { makeNode, resolveOperand, Node } from "./node.js";
import { Variable } from "./variable.js";
import { FunctionBuilder } from "./builder.js";
import { encodeModule } from "./encode/encoder.js";
import "./expr.js"; // ensure instruction constructors are attached to the type namespaces

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
  /** @param {{debug?: boolean}} [opts] debug captures creation stack traces for emit-time errors */
  constructor(opts = {}) {
    this.debug = opts.debug ?? false;
    this.functions = [];
    this.variables = [];
    this.memories = [];
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
  if (typeof init === "number" || typeof init === "bigint") {
    return { kind: "const", node: type.const(init) };
  }
  if (init instanceof Node) {
    if (init.kind !== "const") {
      fail(`mod.variable init: must be a constant expression (${type.name}.const, or an imported immutable variable)`);
    }
    if (init.type !== type) fail(`mod.variable init: expected ${type.name}, got ${init.type.name}`);
    return { kind: "const", node: init };
  }
  if (init?.handleKind === "variable" && init.scope === "module") {
    if (init.type !== type) fail(`mod.variable init: expected ${type.name}, got ${init.type.name}`);
    return { kind: "global", variable: init };
  }
  fail("mod.variable init: expected a JS value, a t.const expression, or a module variable handle");
}
