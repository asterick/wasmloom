# TypeScript declarations

[← Manual index](index.md)

wasmemit ships `index.d.ts`, and it is **generated from the same registry the
test sweeps execute** (`npm run types`), so it can't drift from the
implementation — a test fails if it's stale, and CI typechecks it under
`tsc --strict`. It's not a loose façade; the library's semantics are encoded:

**Parameter tuples infer body-callback types.** Declaring
`mod.function([s32, f64], [s64])` types the body callback as
`(a: Var<"s32">, b: Var<"f64">, $: Ctx<[s64]>) => void` — and `$.return`
checks against the result tuple, `fn.call(...)` against the params, with
multi-value calls destructuring to typed variable tuples.

**Operand slots accept exactly the safe promotions.** Every position typed
`Into<"s64">` accepts `s64 | s32 | u32 | bool` expressions — the
[promotion table](types.md#safe-value-exact-promotion-default), verbatim.
`u32` into an `s32` slot is a compile error, as it is at build time.

**Barriers are compile errors.** Conditions demand `Expr<"bool">`.
[SIMD masks](simd.md#masks-are-the-simd-bool) are branded distinct from lane
data, and `bitselect` requires the shape-matched mask.
[Typed function references](typed-funcref.md#in-the-type-declarations) brand
per signature: nullable positions accept non-null references (structurally —
`false` is assignable to `boolean`), `funcref` positions accept any typed
ref, and downcasts or cross-signature `sig.call`s don't compile.

## Practical notes

- Types flow best when signatures are written inline
  (`mod.function([s32, s32], [s32])`) — the tuple literal is what powers
  inference.
- The declarations describe the *builder*; they can't see through dynamic
  indices or runtime values, so table indices, lane immediates out of range,
  and cross-module handles remain build-time (eager) errors rather than
  compile-time ones. See [Errors and debugging](errors.md).
- Regenerate with `npm run types` after modifying the veneer if you're
  working on wasmemit itself; `test/dts.test.js` enforces freshness.
