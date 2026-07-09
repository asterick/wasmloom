# wasmloom — Handoff

State snapshot for picking this project back up. Last updated: 2026-07-08.

## What this is

A JavaScript library for generating WebAssembly binaries via expression
builders — no external toolchain, `mod.emit()` → `Uint8Array`. The whole
Wasm 2.0 surface is implemented, **including fixed-width SIMD**, plus
multiple memories, extended constant expressions, tail calls, typed
function references, and exception handling from wasm 3.0. 257 tests, all
passing (`npm test`,
Node ≥ 18 — the wasm 3.0 features need a newer engine, Node ≥ 22 in
practice; zero dependencies).

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
                 ─► reduce (passes/reduce.js: irreducible CFGs lowered by
                     node splitting; selector + br_table dispatch loop
                     once duplication exceeds a block budget)
                 ─► liveness + slot coloring (passes/liveness.js, slots.js:
                     locals share slots across disjoint live ranges,
                     pooled by wasm storage type)
                 ─► relooper (passes/relooper.js: Ramsey's "Beyond
                     Relooper"; expects reducible input — reduce runs first.
                     Region-recursive: try bodies/handlers are islands
                     relooped as sub-graphs; flow-view CFG (exceptional
                     edges) drives liveness/slots, structural view drives
                     reduce/reloop — see cfg.js successors vs
                     structuralSuccessors)
                 ─► encoder (encode/encoder.js + leb.js: sections, LEB128;
                     peepholes: set+get → local.tee, fresh-slot zero-init
                     elision in the entry prefix — never loops, never params)
```

- `src/types.js` — `ValType`s. Public types (`s32`/`u32`/`s64`/`u64`/`f32`/
  `f64`/`bool`/`funcref`/`externref`, plus ten SIMD lane views
  `s8x16`…`f64x2` and four mask types `m8x16`…`m64x2` over `v128`) carry a
  `wasmType` storage pointer; the pipeline only ever looks at storage.
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
- **SIMD discipline**: lane namespaces follow signedness; comparisons
  produce mask types (`m*`), `bitselect` demands a shape-matched mask,
  masks are neither data nor conditions; v128 views have NO promotions —
  `cast` (free retype, any view → any view) is the only bridge. v128 can't
  cross the JS boundary, so its sweep runs through linear memory
  (`test/simd-sweep.test.js`).
- **Invariants**: `emit()` is repeatable and byte-stable (compiled bodies
  are cached on the handle); `debug: true` output is byte-identical;
  zero-result ops auto-anchor as statements; unconsumed call results are
  eager errors.

## Test suite map (`test/*.test.js`)

- `optable-sweep` — every public scalar constructor overload executed
  against an independent JS reference (~16k cases), plus a coverage check
  that every optable entry is reachable. New instructions MUST be
  registered in `VENEER_OPS` or this fails.
- `simd-sweep` — the SIMD analog (~9k cases): every vector overload runs
  against a lane-wise JS reference, operands routed through linear memory
  (v128 can't cross the JS boundary). Register vector veneer ops before the
  `vec`-flag marking loop in expr.js so both sweeps stay partitioned.
- `fuzz` (CFG/relooper), `expr-fuzz` (expression semantics), and
  `module-fuzz` (cross-function call graphs: direct/indirect/call_ref
  dispatch, multi-value spills, tail conversion, globals — vs a JS
  interpreter with fuel-bounded recursion) — the three differential
  fuzzers; extend these before hand-writing many cases.
- `perf-canary` — emit-time bounds for a 3000-function module and a
  thousands-of-blocks function (5s each, ~10× dev-machine time). Caught
  quadratic liveness on day one; if one trips, something real regressed.
- `memory-sweep` — all load/store variants vs DataView; bulk-op semantics.
- `simd` — behavioral: masks end-to-end, shape-barrier errors, casts,
  v128 variables/globals, lane memory ops, shuffle/swizzle.
- `exceptions` — EH: payload/clause-order/catchAll, unwinding through
  calls, exnref stash + rethrow identity, JS interop both directions,
  island-rule and chain eager errors, tail suppression under try. Runtime-
  gated (final-spec EH needs Node ≥ 24); byte-stability included.
- `typedref` — typed function references: call_ref through params/globals/
  locals/tables, interning identity, promotion directions, the .of bridge
  and null traps, nullable-slot lowering, return_call_ref by depth.
- `constexpr` — extended constant expressions: init/offset arithmetic,
  preceding-global refs, promotion of const operands, eager and emit-time
  error paths. Tail calls live in `control`: IMPLICIT — `$.return(f.call())`
  converts via a linearize peephole (passes/linearize.js rewriteTailCall);
  proven by millions-of-frames recursion (direct/bound/mutual/indirect/
  multi-value) plus non-conversion safety cases.
- `irreducible` — crafted multi-entry loops: br_table into a loop, temps
  across split copies, nesting, a complete switch web that deterministically
  exhausts the split budget and exercises the dispatch-loop fallback, and
  byte-determinism across builds.
- Feature files: `basic`, `control`, `module`, `semantics`, `memory`,
  `tables`, `signedness`, `bool`, `select`, `promotion`, `modes`,
  `errors` (~35 eager-error paths), `binary` (section-level asserts and
  peephole byte checks), `slots-stress`, `limits` (depth canaries), `leb`,
  `dts` (generated declarations staleness), `names` (name-section
  bytes, auto-derivation and overrides, stack-trace names), `docs-examples`
  (every manual example executes; cross-links checked).

## Queue (in priority order)

The active queue is empty — the wasm 2.0 surface, lowering, and polish are
done. Remaining items are pinned:

1. **Pinned (do not do unless asked)**: raw custom-section passthrough
   (`mod.customSection(name, bytes)`) — see DESIGN.md's "Pinned" section.
   (The name section itself shipped: auto-derived + `.name()` overrides.)

## Working conventions

- Repo: github.com/asterick/wasmloom (private). Commit style: imperative
  summary + body, Claude co-author trailer.
- **main is protected — never commit to it directly.** Two repo rulesets:
  "pr-and-review" (PR required, 1 code-owner review — CODEOWNERS:
  @asterick — no force pushes/deletion; repo ADMINS may merge a PR without
  review via PR-mode bypass) and "ci-green" (test 22.x/24.x + types must
  pass — no bypass, binds admins too). Direct pushes are blocked for
  everyone including admins. Workflow: branch, push, `gh pr create`, hand
  to Bryon — he can merge without approval; anyone else needs his review.
- `index.d.ts` is GENERATED (`npm run types`, scripts/generate-dts.js) from
  `VENEER_OPS` + a hand-maintained skeleton; `test/dts.test.js` fails when
  stale. After touching the veneer, regenerate and commit both. Typecheck
  changes to the generator with `npx -p typescript tsc --noEmit --strict
  index.d.ts` (not part of `npm test` — no dev dependencies).
- After every ratified design decision: update DESIGN.md (decisions table
  + relevant section) in the same commit as the implementation.
- **README.md AND docs/ are always maintained** (Bryon's standing rule): any
  change to the user-facing surface — features, flags, coverage, engine
  requirements — updates README and the reference manual in the same commit,
  BEFORE anything is pushed. The manual is enforceable: every complete
  example in docs/*.md executes in test/docs-examples.test.js and all
  cross-links (pages + anchors) are checked — `npm test` fails on stale
  examples or broken links. docs/ is one page per wasm proposal plus core
  reference pages; GitHub Pages serves it from the /docs folder.
- CI: .github/workflows/ci.yml — npm test on Node 22/24 plus a dts
  staleness + tsc --strict typecheck job.
- Tests are the oracle: every feature lands with behavioral round-trip
  tests through V8 (`WebAssembly.validate` + instantiate + assert results),
  eager-error tests, and — where machinery is touched — fuzzer/sweep
  extensions.
