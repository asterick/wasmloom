# The Module

[← Manual index](index.md)

`Module` is the root of everything: entity declarations hang off it, and
`emit()` assembles the binary. Declaration order is index order within each
entity space (imports always index before definitions, per the wasm spec).

```js
import { Module, s32 } from "wasmloom";

const mod = new Module({ debug: true });
const answer = mod.variable(s32, 42).immutable().export("answer");
mod.function([], [s32]).export("get").body(($) => $.return(answer));

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.get() !== 42 || instance.exports.answer.value !== 42) {
  throw new Error("unexpected");
}
```

## Module options

`new Module(opts?)` accepts three flags. Each is a deliberate, documented
deviation from the defaults — none are needed for ordinary use.

### `debug`

`{ debug: true }` captures a JavaScript stack trace at every expression,
label, and node creation, so *emit-time* errors (an unplaced label, a
non-dominated expression use) point at the line of your builder code that
created the offending thing. Zero cost when off; the emitted bytes are
**byte-identical** either way. See [Errors and debugging](errors.md).

### `permissive`

`{ permissive: true }` opts into bit-level leniency *within a storage width*:
integer conditions (non-zero is true), mixed-signedness operands retype
freely, and integers in `bool` positions get a real ≠0 test. The strict
defaults — and exactly what this flag relaxes — are specified in
[Types and promotion](types.md#permissive-mode).

### `tailCalls`

Default **true**: `$.return(f.call(…))` emits `return_call`, making the
emitted module require a wasm 3.0 engine. Set `{ tailCalls: false }` to keep
plain calls — full stack traces, no 3.0 requirement from this feature. The
conversion rule lives in [Tail calls](tail-calls.md).

### `names`

Default **true**: the module emits a name section — every entity's debug
name auto-derives from its export name (or `"module.name"` for imports),
`.name("str")` chains override, and `mod.name("str")` names the module
itself. Engines use these in stack traces and disassembly. Set
`{ names: false }` to strip the section. See
[Named stack traces](errors.md#named-stack-traces).

## Module variables (wasm globals)

`mod.variable(type, init?)` declares a global. Mutable by default;
`.immutable()` chains to lock it (eagerly rejecting any earlier `.set()`).
The handle **is** a value expression — use it anywhere a value of its type
goes — and writes go through `.set(value)` inside function bodies.

Initializers follow wasm's constant-expression grammar:

- a JS value — `mod.variable(s32, 10)`, `mod.variable(u64, 2n ** 40n)`,
  `mod.variable(bool, true)`, a lane array for [SIMD types](simd.md)
  (`mod.variable(s32x4, [1, 2, 3, 4])`), `null` for reference types;
- a `t.const(...)` expression, or `fn.ref()` for
  [function references](typed-funcref.md);
- another **immutable** module variable (imported or declared earlier);
- constant arithmetic over the above — see
  [Extended constant expressions](extended-const.md).

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const base = mod.variable(s32).import("env", "base").immutable();
const scaled = mod.variable(s32, s32.mul(base, s32.const(3))).immutable().export("scaled");
void scaled;

const { instance } = await WebAssembly.instantiate(mod.emit(), {
  env: { base: new WebAssembly.Global({ value: "i32" }, 14) },
});
if (instance.exports.scaled.value !== 42) throw new Error("unexpected");
```

## Imports and exports

Every importable entity — functions, memories, tables, module variables —
takes `.import(moduleName, name)`, chained on the declaration. An entity is
either imported or defined, never both (an imported variable can't have an
initializer; an imported function can't have a body).

`.export(name)` works on the same handles, any number of entities, one export
name each (duplicates are eager errors). Exporting doesn't change how the
entity is used internally.

## Other module-level entities

- **Functions and signatures** — [Functions](functions.md);
  `mod.funcType(params, results)` declares a reusable signature for
  [`call_indirect`](tables.md#call_indirect) and
  [typed references](typed-funcref.md). Signatures are interned: identical
  shapes return the same handle.
- **Memories** — [Memory](memory.md); more than one via
  [Multiple memories](multi-memory.md).
- **Tables and element segments** — [Tables and references](tables.md).
- **Data segments** — [Memory](memory.md#data-segments).
- **Exception tags** — `mod.tag([types])`; see
  [Exception handling](exceptions.md#tags).
- **GC struct/array types** — `mod.struct(...)` / `mod.array(...)`; see
  [Garbage collection](gc.md).
- **Start function** — `mod.start(fn)` designates a `[] -> []` function to run
  at instantiation.

## `emit()`

Returns the complete binary as a `Uint8Array`. Repeatable and byte-stable:
compiled bodies are cached per function, and the encoding is fully
deterministic (the `debug` flag does not change the output). Whole-module
checks that can't be eager — a declared function never given a body, an
unplaced forward label, a mutable variable read by a constant expression —
throw here.
