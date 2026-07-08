import { fail } from "./errors.js";
import { requireBuilder } from "./context.js";
import { makeNode, resolveOperand } from "./node.js";

/**
 * A variable handle — the owner decides the wasm storage class:
 * module-scoped variables emit as globals, function-scoped as locals.
 * The handle itself is usable anywhere an expression is expected (each use
 * reads the variable at that point); writes go through `.set(value)`.
 */
export class Variable {
  /**
   * @param {'module'|'function'} scope
   * @param {import('./types.js').ValType} type
   * @param {object} opts { module } or { builder, vlocal, isParam }
   */
  constructor(scope, type, opts) {
    this.handleKind = "variable";
    this.scope = scope;
    this.type = type;
    this.mutable = true;
    if (scope === "module") {
      this.module = opts.module;
      this.init = opts.init; // resolved const-expr spec
      this.initExplicit = opts.initExplicit ?? false;
      this.importInfo = null;
      this.setCount = 0;
      this.index = -1; // assigned at emit
    } else {
      this.builder = opts.builder;
      this.vlocal = opts.vlocal;
      this.isParam = opts.isParam ?? false;
    }
  }

  describe() {
    if (this.scope === "module") {
      const name = this.exportName ?? (this.importInfo && `${this.importInfo.module}.${this.importInfo.name}`);
      return `module variable${name ? ` "${name}"` : ""} (${this.type.name})`;
    }
    return `${this.isParam ? "parameter" : "variable"} (${this.type.name})`;
  }

  /** @returns {import('./node.js').Node} a fresh read node at the current position */
  _read() {
    const b = requireBuilder(`read of ${this.describe()}`);
    if (this.scope === "function" && this.builder !== b) {
      fail(`read of ${this.describe()}: variable belongs to a different function body`);
    }
    if (this.scope === "module" && this.module !== b.module) {
      fail(`read of ${this.describe()}: variable belongs to a different module`);
    }
    return makeNode("read", { type: this.type, results: [this.type], variable: this });
  }

  /** Write the variable at the current position. */
  set(value) {
    const what = `set of ${this.describe()}`;
    if (!this.mutable) fail(`${what}: variable is immutable`);
    const b = requireBuilder(what);
    if (this.scope === "function" && this.builder !== b) {
      fail(`${what}: variable belongs to a different function body`);
    }
    if (this.scope === "module") {
      if (this.module !== b.module) fail(`${what}: variable belongs to a different module`);
      this.setCount++;
    }
    const v = resolveOperand(value, this.type, what);
    makeNode("set", { variable: this, operands: [v] }, { anchor: true });
    return this;
  }

  /** Module variables only: mark immutable. Eagerly rejects later .set(). */
  immutable() {
    if (this.scope !== "module") {
      fail("immutable(): wasm locals are always mutable — only module variables may be immutable");
    }
    if (this.setCount > 0) fail("immutable(): variable has already been written");
    this.mutable = false;
    return this;
  }

  /** Module variables only: mark as imported (externally supplied). */
  import(moduleName, name) {
    if (this.scope !== "module") fail(".import(): only module variables can be imported");
    if (this.importInfo) fail(".import(): variable is already imported");
    if (this.initExplicit) fail(".import(): an imported variable cannot have an initializer");
    if (typeof moduleName !== "string" || typeof name !== "string") {
      fail(".import(module, name): both arguments must be strings");
    }
    this.importInfo = { module: moduleName, name };
    return this;
  }

  /** Module variables only: export under the given name. Chainable; aliases allowed. */
  export(name) {
    if (this.scope !== "module") fail(".export(): only module variables can be exported");
    this.module._addExport(name, this, "global");
    this.exportName ??= name;
    return this;
  }
}
