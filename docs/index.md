# wasmloom Reference Manual

wasmloom weaves WebAssembly binaries from JavaScript expression builders —
`mod.emit()` returns a `Uint8Array` ready for `WebAssembly.instantiate`, with
no external toolchain and zero dependencies. Every builder call is
type-checked eagerly at the call site, and the emitted bytes are verified
against V8 by 270+ tests including three differential fuzzers and ~25k-case
per-instruction sweeps.

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
mod.function([s32], [s32]).export("square").body((x, $) => {
  $.return(s32.mul(x, x));
});

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.square(9) !== 81) throw new Error("unexpected");
```

## Manual

**Getting started**

- [Getting started](getting-started.md) — install, first module, running the output.
- [The Module](module.md) — `Module` options (`debug`, `permissive`, `tailCalls`),
  module variables, imports/exports, `emit()`.
- [Errors and debugging](errors.md) — eager validation, `WasmLoomError`, `debug` traces.

**Core reference (WebAssembly 2.0)**

- [Types and promotion](types.md) — signedness-first scalars, `bool`, casts,
  safe value-exact promotion, permissive mode.
- [Expressions and evaluation order](expressions.md) — the expression model,
  single-use vs multi-use, variables as values.
- [Control flow](control-flow.md) — labels and gotos, `$.if`/`$.while` sugar,
  `$.switch`, irreducible control flow.
- [Functions](functions.md) — declaration, bodies, calls, multi-value results,
  `fn.ref()`, signatures.
- [Memory](memory.md) — loads/stores, bulk operations, data segments.
- [Tables and references](tables.md) — `funcref`/`externref`, `call_indirect`,
  element segments.

**WebAssembly proposals** (each implemented in full; each a separate section)

- [Fixed-width SIMD](simd.md) — ten signedness-carrying lane namespaces over
  `v128`, dedicated mask types.
- [Multiple memories](multi-memory.md) — any number of memories; cross-memory copy.
- [Tail calls](tail-calls.md) — implicit `return_call` from `$.return(f.call(…))`.
- [Extended constant expressions](extended-const.md) — arithmetic in globals'
  initializers and segment offsets.
- [Typed function references](typed-funcref.md) — `sig.ref`/`sig.refNull`,
  `call_ref`, typed tables.
- [Exception handling](exceptions.md) — tags, `$.throw`, `$.try` handler
  chains, `exnref` rethrow.
- [Garbage collection](gc.md) — struct/array heap types, subtyping and
  casts, `i31ref`, host interop.
- [Threads and atomics](threads.md) — shared memories, the atomic family,
  `wait`/`notify`, `fence`.

**Tooling**

- [TypeScript declarations](typescript.md) — the generated `index.d.ts` and what
  it enforces.

## Feature and engine matrix

wasmloom itself runs anywhere with ES modules (Node ≥ 18). What the *emitted
module* requires depends on the features it uses:

| Feature | Spec status | Needs (approx.) | Manual section |
|---|---|---|---|
| Core + SIMD | WebAssembly 2.0 | any modern engine | core sections, [SIMD](simd.md) |
| Multiple memories | wasm 3.0 | Node ≥ 22, Chrome ≥ 120, Firefox ≥ 125 | [Multiple memories](multi-memory.md) |
| Tail calls | wasm 3.0 | Node ≥ 20, Chrome ≥ 112, Firefox ≥ 121 | [Tail calls](tail-calls.md) — emitted by default; [opt out](module.md#tailcalls) |
| Extended const | wasm 3.0 | Node ≥ 20, Chrome ≥ 114, Firefox ≥ 112 | [Extended const](extended-const.md) — only if used |
| Typed func refs | wasm 3.0 | Node ≥ 22, Chrome ≥ 119, Firefox ≥ 120 | [Typed function references](typed-funcref.md) — only if used |
| Exceptions | wasm 3.0 | Node ≥ 24, Chrome ≥ 131, Firefox ≥ 131 | [Exception handling](exceptions.md) — only if used |
| GC | wasm 3.0 | Node ≥ 22, Chrome ≥ 119, Firefox ≥ 120 | [Garbage collection](gc.md) — only if used |
| Threads/atomics | phase 4 | any modern engine | [Threads and atomics](threads.md) — only if used |

Every complete example in this manual is executed by the test suite
(`test/docs-examples.test.js`) — if it's on these pages, it runs.
