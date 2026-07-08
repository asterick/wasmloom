# wasmemit — Handoff

State snapshot for picking this project back up. Last updated: 2026-07-08.

## What this is

A JavaScript library for generating WebAssembly binaries via expression
builders — no external toolchain, `mod.emit()` → `Uint8Array`. The whole
Wasm 2.0 surface is implemented **except SIMD**. 166 tests, all passing
(`npm test`, Node ≥ 18, zero dependencies).

**`DESIGN.md` is the contract.** Every API shape in it was explicitly
ratified in planning discussions with Bryon. Do not implement new
outward-facing API (including anything in its *Deferred* section) without
proposing concrete options and getting his sign-off first; his taste runs
to few concepts unified by context/owner, fluent chained attributes on
handles, symbols over nested callbacks, and strict type barriers with
explicit bridges.

## Architecture in one pass

```
builder callbacks ─► CFG of basic blocks (typed nodes, virtual locals)
                 ─► dominators (passes/dominators.js: RPO + CHK idoms)
                 ─► linearize (passes/linearize.js: multi-use → temps,
                     dominance checks, flat stack-form per block)
                 ─► liveness + slot coloring (passes/liveness.js, slots.js:
                     locals share slots across disjoint live ranges,
                     pooled by wasm storage type)
                 ─► relooper (passes/relooper.js: Ramsey's "Beyond
                     Relooper"; irreducible CFGs detected and REJECTED)
                 ─► encoder (encode/encoder.js + leb.js: sections, LEB128)
```

- `src/types.js` — `ValType`s. Public types (`s32`/`u32`/`s64`/`u64`/`f32`/
  `f64`/`bool`/`funcref`/`externref`) carry a `wasmType` storage pointer;
  the pipeline only ever looks at storage.
- `src/optable.js` — the single data-driven instruction table, spec-shaped
  (`i32.div_s`). Adding an instruction here is one line; encoding and
  constructors follow.
- `src/expr.js` — the veneer: generates public constructors from the
  optable (`u32.div` → `i32.div_u`; operand-driven conversions), consts,
  casts, `bool`, refs, select, `MEMORY_OPS`/`TABLE_OPS` (handle-method
  implementations), the coercion hook (default safe promotion +
  opt-in permissive), and `VENEER_OPS` — the registry the sweep test uses.
- `src/node.js` / `src/variable.js` / `src/cfg.js` / `src/builder.js` —
  expression nodes, variable handles, blocks/labels, the `$` statement
  context (labels, goto/gotoIf/switch, if/elseIf/else + while sugar).
- `src/module.js` — `Module` and every handle: functions (body/import/
  export/call/ref), variables, memory, tables, funcTypes, data/elem
  segments, start.

## Semantics that must not drift (all pinned by tests)

- **Evaluation order**: single-use expressions inline at consumption;
  multi-use evaluate once at their creation point (auto-bound to a temp);
  creation must dominate all uses. `test/expr-fuzz.test.js` differentially
  fuzzes exactly this.
- **Type barriers**: signedness in the type (`u32.div` selects `_u`);
  comparisons produce `bool`; conditions require `bool` (`bool.of(x)` is
  the bridge); mixed signedness errors; **safe value-exact promotion is
  default** (operands lift into the namespace type: s32/u32/bool→s64,
  f32/s32/u32/bool→f64, …; never lossy/narrowing). `permissive: true` is
  the only flag-gated leniency and appears ONLY in `test/modes.test.js` —
  never make it ambient in tests.
- **Invariants**: `emit()` is repeatable and byte-stable (compiled bodies
  are cached on the handle); `debug: true` output is byte-identical;
  zero-result ops auto-anchor as statements; unconsumed call results are
  eager errors.

## Test suite map (`test/*.test.js`)

- `optable-sweep` — every public constructor overload executed against an
  independent JS reference (~16k cases), plus a coverage check that every
  optable entry is reachable. New instructions MUST be registered in
  `VENEER_OPS` or this fails.
- `fuzz` (CFG/relooper) and `expr-fuzz` (expression semantics) — the two
  differential fuzzers; extend these before hand-writing many cases.
- `memory-sweep` — all load/store variants vs DataView; bulk-op semantics.
- Feature files: `basic`, `control`, `module`, `semantics`, `memory`,
  `tables`, `signedness`, `bool`, `select`, `promotion`, `modes`,
  `errors` (~35 eager-error paths), `binary` (section-level asserts),
  `slots-stress`, `limits` (depth canaries), `leb`.

## Queue (in priority order)

1. **Irreducible control-flow lowering** — engineering, no design session
   needed. relooper currently `fail()`s on multi-entry loops; implement
   node-splitting (+ dispatch-loop fallback). Payoff: the CFG fuzzer's
   skipped irreducible seeds (~40%) become live differential coverage —
   remove the skip in `test/fuzz.test.js` when done.
2. **SIMD (`v128`)** — needs a short design session first (open question:
   do lane namespaces follow signedness, e.g. `s8x16`/`u8x16`?). Then
   mechanical: optable entries + veneer registration + sweep references.
3. **Polish (no design needed)**: `local.tee` peephole (set+get pairs),
   drop synthetic zero-init when a slot is provably fresh, generated
   `.d.ts` from JSDoc.
4. **Pinned (do not do unless asked)**: custom sections / name section —
   see DESIGN.md's "Pinned" section.

## Working conventions

- Repo: github.com/asterick/wasmemit (private), branch `main`, commit
  style: imperative summary + body, Claude co-author trailer.
- After every ratified design decision: update DESIGN.md (decisions table
  + relevant section) in the same commit as the implementation.
- Tests are the oracle: every feature lands with behavioral round-trip
  tests through V8 (`WebAssembly.validate` + instantiate + assert results),
  eager-error tests, and — where machinery is touched — fuzzer/sweep
  extensions.
