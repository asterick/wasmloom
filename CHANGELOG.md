# Changelog

## 0.1.0 — 2026-07-08

First release. wasmloom weaves WebAssembly binaries from JavaScript
expression builders — no toolchain, zero dependencies, strict eagerly-checked
type discipline, generated TypeScript declarations.

### Coverage

- The complete **WebAssembly 2.0** surface: numerics, multi-value, bulk
  memory, reference types and tables, sign-extension, nontrapping
  conversions, and fixed-width **SIMD** (236 instructions; ten
  signedness-carrying lane namespaces, dedicated mask types).
- All six **wasm 3.0** features: multiple memories, extended constant
  expressions, implicit tail calls (`$.return(f.call(…))` → `return_call`;
  opt out with `tailCalls: false`), typed function references
  (`sig.ref`/`sig.refNull`, `call_ref`, typed tables), exception handling
  (tags, `$.throw`, `$.try` handler chains, `exnref` rethrow), and garbage
  collection (named-field structs, arrays, declared subtyping, checked
  casts, `i31ref`, extern↔any).
- **Threads and atomics**: shared memories, the full atomic family with
  old-value RMW and `cmpxchg`, `wait`/`notify` futexes, `fence`.
- **Name section** emitted by default (auto-derived from exports/imports,
  `.name()` overrides) — stack traces name your functions.

### Guarantees

- Eager validation: the builder call that creates a mistake throws it.
- `emit()` is repeatable and byte-stable; `debug: true` never changes bytes.
- Arbitrary `goto` control flow, including irreducible loops (lowered by
  node splitting with a dispatch fallback).
- 278 tests: behavioral round-trips through V8, three differential fuzzers,
  ~25k-case per-instruction sweeps, real `worker_threads` concurrency, and
  every example in the [reference manual](docs/index.md) executed in CI.

Emitting runs on Node ≥ 18 / any modern browser; emitted modules' engine
floors are per-feature — see the manual's feature matrix.
