# wasmemit — Design

Generate WebAssembly modules from JavaScript using expression builders. No external
toolchain; emits binary `.wasm` bytes directly.

## Decisions (agreed)

| Area | Decision |
|---|---|
| API style | Hybrid: expression objects for values, statement context (`$`) for effects/control flow |
| Output | Binary `.wasm` bytes (`Uint8Array`) |
| Spec target | Wasm 2.0 baseline: multi-value, bulk memory, reference types, sign-extension, nontrapping conversions, fixed-width SIMD — plus multiple memories, extended constant expressions, and tail calls from wasm 3.0 |
| Validation | Eager — type errors throw at the builder call that caused them |
| Declarations | Handles: declare first, attach bodies later (forward decls, mutual recursion) |
| Imports | Chained on the same declaration: `.import(module, name)` — exactly one of body/init or import |
| Control flow | Labels are atomic symbols placed at creation; `goto` / `gotoIf` / `switch` by reference |
| Sugar | Chained `$.if(c, fn).elseIf(c, fn).else(fn)` and `$.while(c, fn)`, desugaring to labels |
| Block values | Conditional values flow through locals (plus `select`); no typed-block results |
| Expression reuse | Auto-bound to hidden locals; local slots reused when live ranges end |
| IR | CFG of basic blocks from day one; relooper reconstructs structure at emit |
| Variables | One concept: `mod.variable()` / `$.variable()` — owner decides global vs local. The handle *is* a value expression; writes are `handle.set(v)` |
| Integer types | Signedness is first-class: `s32`/`u32`/`s64`/`u64` (lowering to wasm i32/i64); floats `f32`/`f64` |
| Booleans | `bool` is first-class (storage i32, values provably 0/1): comparisons/`eqz` produce it, conditions require it, `bool.of(x)` tests integers, `s32.cast`/`u32.cast` bridge out at zero cost |
| Op naming | Suffix-less names select the `.wat` variant by namespace (`u32.div` emits `i32.div_u`); conversions are operand-driven (`f64.convert(x)` picks by x's type); `t.cast(x)` retypes across signedness at zero cost |
| Zero-result ops | Auto-anchor as statements at their creation point (`u32.store(...)` is a statement) |
| 64-bit immediates | BigInt always; plain numbers only when `Number.isSafeInteger`, else throw |
| Consts | Range-checked per namespace: `s32.const` in [-2^31, 2^31), `u32.const` in [0, 2^32), etc.; `f32.const` rounds |
| Safe promotion | Default behavior: operands lift value-exactly into an op's namespace type (s32/u32/bool→s64, u32/bool→u64, f32/s32/u32/bool→f64, bool→s32/u32/f32) — the namespace names the target explicitly, so nothing implicit is guarded. Lossy/narrowing always errors |
| Permissive mode | `permissive: true` (opt-in, never default in tests) — bit-level leniency within a storage width: integer conditions, mixed signedness retypes, integers in bool positions get a real ≠0 test |
| Tail calls | Implicit: `$.return(f.call(…))` (also indirect and multi-value spreads) emits `return_call` whenever the returned values are exactly the results of a call evaluated last. The rule is exact, not heuristic — evaluation-order semantics make a single-use returned call always evaluate at the return, and spill/binding writes are dead there. Anything that breaks the pattern (intervening effects after a spilled call, promotion around the result, a second consumer) stays a plain call. No explicit form; `tailCalls: false` on the Module opts out (full stack traces, no wasm 3.0 requirement from this feature) |
| Const expressions | `add`/`sub`/`mul` on the integer namespaces double as wasm 3.0 extended constant expressions when built outside a body — one concept, context decides. Operands: consts, immutable module variables (imported or previously declared — the handle-first API makes forward refs unconstructible), nested const ops. Usable as inits and data/element offsets, and reusable inside bodies as ordinary code |
| SIMD lanes | Lane namespaces follow signedness: `s8x16`/`u8x16`/`s16x8`/`u16x8`/`s32x4`/`u32x4`/`s64x2`/`u64x2`/`f32x4`/`f64x2`, all views over one v128 storage. Suffix-less names select variants (`u8x16.shr` → `i8x16.shr_u`); widening/narrowing families follow the namespace (`s32x4.extend_low(s16x8)`) |
| SIMD masks | Comparisons produce dedicated mask types (`m8x16`/`m16x8`/`m32x4`/`m64x2`) — the SIMD analog of `bool`. `bitselect` requires a shape-matched mask; `any_true`/`all_true` (→ `bool`) and `bitmask` (→ `u32`) live on masks. Masks are not data and not conditions |
| SIMD v128 ops | Lane-agnostic instructions (bitwise, `bitselect`, plain load/store) appear on every integer lane namespace and mask — no bare `v128` type in the public API. Every v128 view retypes into any other via zero-cost `cast` (the universal bridge; there is no wasm instruction to select). Floats keep the scalar discipline: no bitwise ops without casting to an integer view |
| Diagnostics | `new Module({ debug: true })` captures creation stack traces for emit-time errors |
| Types | Plain JS with JSDoc annotations; `index.d.ts` is generated from the veneer registry (`npm run types` — tsc can't see the dynamically attached constructors), typed end-to-end: param tuples infer body-callback `Var`s, operand slots accept exactly the safe promotions, masks/shapes are barriers in TS too |
| Testing | Round-trip: instantiate output with V8 (`node --test`), assert executed results |

## Public API sketch

```js
import { Module, s32, u32, s64, u64, f32, f64 } from "wasmemit";

const mod = new Module();

// An import is a declaration whose implementation is externally supplied.
const log = mod.function([s32], []).import("env", "log");

// Declare now, define later. Module-level attributes chain fluently.
const odd  = mod.function([s32], [s32]).export("odd");
const even = mod.function([s32], [s32]).export("even");

const mem = mod.memory({ min: 1 }).export("memory");
const counter = mod.variable(s32, 0).export("counter");

// Sugar for the common cases…
odd.body((n, $) => {
  $.if(s32.eqz(n), $ => {
    $.return(s32.const(0));
  }).else($ => {
    $.return(even.call(s32.sub(n, s32.const(1))));
  });
});

// …labels for everything else (see Labels below).
even.body((n, $) => {
  $.if(s32.eqz(n), $ => {
    $.return(s32.const(1));
  }).else($ => {
    $.return(odd.call(s32.sub(n, s32.const(1))));
  });
});

const bytes = mod.emit();   // Uint8Array; throws if any handle lacks a body
```

### Labels and control flow

Labels are first-class atomic symbols. `$.label()` **marks the current position**
in the instruction stream and returns the symbol — one line for the common
backward-jump case. Forward targets are declared with `$.label.ahead()` and
pinned later with `.here()` (exactly once; `emit()` errors on any target never
placed).

```js
sum.body((n, $) => {
  const acc  = $.variable(s32, s32.const(0));
  const exit = $.label.ahead();

  const top = $.label();               // loop head, placed here
  $.gotoIf(s32.eqz(n), exit);
  acc.set(s32.add(acc, n));
  n.set(s32.sub(n, s32.const(1)));
  $.goto(top);

  exit.here();
  $.return(acc);
});
```

- `$.goto(label)`, `$.gotoIf(cond, label)` — unconditional/conditional jumps.
- `$.switch(index, [l0, l1, …], defaultLabel)` — dense dispatch, lowers to `br_table`.
- **Tail calls are implicit**: `$.return(f.call(…))`, `$.return(...f.call(…))`
  (multi-value), and `$.return(tbl.call(sig, i, …))` lower to
  `return_call`/`return_call_indirect` — the callee replaces the frame, so
  deep self/mutual recursion runs in constant stack. The rule: the returned
  values are exactly the results of a call evaluated last. Single-use calls
  always qualify (they evaluate at the return); a result bound to a variable
  and immediately returned also converts (the write is dead at a return). A
  spilled multi-value call with effectful statements before the return, or a
  result that needs promotion, stays a plain call. Emitting a tail call makes
  the module require a wasm 3.0 engine; `new Module({ tailCalls: false })`
  opts out (real frames — full stack traces — and no 3.0 requirement).
- **Labels are function-scoped, not closure-scoped.** The sugar callbacks are
  just recording devices over a flat CFG, so `.here()` may be called inside
  any nested `$.if`/`$.while` callback of the same body — placement lands
  wherever the instruction stream currently is, and jumping into a
  conditional arm from outside it is legal (the target simply becomes a merge
  point). The one guardrail: placement (like `goto`) must happen while the
  label's own `.body()` callback is running — escaping a label to another
  function's body or past body completion is an eager error.
- Arbitrary jumps may produce **irreducible** control flow; the emit pipeline
  lowers it before the relooper runs (node splitting, dispatch-loop fallback
  for pathological cases).

Structured sugar desugars to labels in the CFG:

```js
$.if(cond, $ => {
  // then
}).elseIf(other, $ => {
  // else-if — chainable any number of times
}).else($ => {
  // else
});

$.while(s32.gt(n, s32.const(0)), $ => {
  acc.set(s32.add(acc, n));
  n.set(s32.sub(n, s32.const(1)));
});
```

`$.if(...)` returns a chainable object accepting `.elseIf(cond, fn)` repeatedly
and `.else(fn)` as terminator. Since jumps are symbolic, values never flow out
of blocks — conditional values are written to locals in each arm, or use
`select` for the cheap two-operand case.

### Module entities

- `mod.function(params, results)` returns a **function handle** immediately.
  `.export(name)`, `.import(module, name)`, `.body(fn)` chain; `.call(...)` is
  valid before the body exists. The body callback receives one expression node
  per parameter, then `$` last.
- Same handle pattern throughout: `mod.memory()`, `mod.variable()`,
  `mod.table()`, `mod.data()`, `mod.elem()`, `mod.start(fn)`.
- Function types are interned/deduplicated into the type section automatically.
- Loads/stores take the memory handle explicitly (`s32.load(mem, addr, {offset,
  align})`) so multi-memory bolts on later without an API break — see *Memory*.

### Variables, imports, exports

- **One variable concept** — the owner infers the wasm storage class:
  `mod.variable(type, init?)` emits as a global, `$.variable(type, init?)` as
  a local. Handles behave identically (direct-use read, `.set(v)` write).
  Variables are mutable by default and zero-initialized by default, everywhere.
- Module variables accept the extra chained attributes: `.export(name)`,
  `.import(module, name)`, and `.immutable()` (after which `.set()` throws
  eagerly; immutability is what makes an imported variable legal inside other
  initializer expressions). `.immutable()` on a function-scoped variable is an
  eager error — wasm locals are always mutable.
- A module variable's `init` accepts a plain JS value (auto-wrapped in the
  right `t.const`, same strictness rules) or an expression node validated
  against wasm's constant-expression grammar (`t.const`, `ref.null`,
  `ref.func`, reads of imported immutable variables) — `s32.add(...)` as an
  init throws at the `mod.variable()` call. Function-scoped `init` is
  unrestricted: it desugars to a `.set()` at the declaration point.
- **Imports build on the forward-decl syntax**: every entity is declared the
  same way, and `.import(module, name)` marks its implementation as externally
  supplied. `emit()` requires each function to have exactly one of `.body()`
  or `.import()`; both or neither is an error (likewise `init`/`.import()` on
  module variables).

  ```js
  const log  = mod.function([s32], []).import("env", "log");   // log.call(x)
  const heap = mod.memory({ min: 1 }).import("env", "memory"); // s32.load(heap, …)
  const base = mod.variable(s32).import("env", "base").immutable();
  ```

- The binary format puts imports at the low indices of each index space, but
  indices are assigned at `emit()` — declaration order is unconstrained; the
  emitter sorts imports first. Assignment is deterministic: imports in
  declaration order, then definitions in declaration order.
- `.export(name)` chains on every exportable handle and returns it. Multiple
  exports of one entity (aliases) are fine; re-exporting an import is fine
  (`mod.function(...).import("env", "log").export("log")`). A duplicate export
  *name* is an eager error at the second `.export()` call.

### Expressions

- **Expression namespaces are the types** (`s32`, `u32`, `s64`, `u64`, `f32`,
  `f64`) and hold instruction constructors: `s32.add(a, b)`, `f64.const(1.5)`,
  `fn.call(...)`. Each returns a node with a known result type — checked
  eagerly, no implicit conversions.
- **Signedness lives in the type, not the instruction name.** Suffix-less
  constructors select the `.wat` variant from the namespace: `u32.div` emits
  `i32.div_u`, `s64.shr` emits `i64.shr_s`; sign-agnostic ops (`add`, `and`,
  `eq`, …) appear on both namespaces and emit identical code. Conversions are
  **operand-driven**: `f64.convert(x)` picks `convert_i32_s/u`/`convert_i64_s/u`
  from x's type; likewise `trunc`/`trunc_sat`/`extend`/`wrap`/`reinterpret`/
  `demote`/`promote`. Mixing signedness is an eager error; `u32.cast(x)` /
  `s32.cast(x)` (and 64-bit twins) retype across signedness at zero cost.
- **`bool` is the truth type** (storage i32, values provably 0/1).
  Comparisons and `eqz` produce `bool`; conditions (`$.if`, `$.gotoIf`,
  `$.while`, `select`) require it — an integer condition is an eager error,
  with `bool.of(x)` ("x ≠ 0", any integer type) as the explicit truthiness
  test. The namespace carries `and`/`or`/`xor`/`not` (values — both sides
  always evaluate, like `select`), `bool.const(true|false)` (JS booleans
  only), and `bool.select`. `s32.cast(b)`/`u32.cast(b)` bridge out at zero
  cost (sound: values are 0/1); there is deliberately no int → bool cast.
  `$.switch` indices and memory addresses accept either 32-bit signedness
  (indices, not truth values) but never `bool`.
- **`T.select(cond, ifTrue, ifFalse)`** — branchless ternary, typed by
  namespace, condition-first like `cond ? a : b`. Both arms are **always
  evaluated** (that's the point: no branch); use `$.if` when an arm has
  effects that must be guarded.
- **JS boundary caveat**: signedness is a build-time discipline. The engine
  sees only i32/i64, so a `u32` result reads back signed in JS
  (`0xFFFFFFFF` arrives as `-1`).
- A variable handle (or param — params are just pre-declared variables)
  **is itself a value expression** — using it anywhere reads it at that point
  (reads are unlimited and cheap); writes are `handle.set(value)`.
- **Zero-result instructions are statements**: constructors whose instruction
  produces no value (`s32.store`, `memory.copy`, a call to a `[] -> []`
  function) append to the current block at the point they're called —
  consistent with the creation-point rule below. `$` stays small: variables,
  labels, control flow, `$.return`, `$.drop`.
- Immediates are strict and range-checked per namespace: `s32.const` accepts
  `[-2^31, 2^31)`, `u32.const` accepts `[0, 2^32)` (unsigned spellings like
  `0xFFFFFFFF` go through `u32`); the 64-bit namespaces accept BigInt always
  and plain numbers only when `Number.isSafeInteger(n)`; `f32.const` rounds
  doubles to float32 (unavoidable).

### Memory

- `mod.memory({ min, max? })` — limits in 64KiB pages; a module may declare
  any number of memories (wasm 3.0 multi-memory; imported memories index
  first). `.import()`/`.export()` chain as usual.
- Loads/stores take the memory handle explicitly, so multiple memories need
  no new API — the handle routes every access, and memory 0 keeps the
  classic (unflagged) encoding. **Sized variants get their extension
  signedness from the type**:
  `u32.load8` zero-extends, `s32.load16` sign-extends, `s64.load32`/`u64.load32`
  likewise; stores (`store8/16/32`) truncate and are sign-agnostic (on both
  namespaces). `{offset, align}` immediates are optional — align defaults to
  the access width (bytes, power of two ≤ natural).
- **Bulk operations live on the memory handle**: `mem.size()` and
  `mem.grow(delta)` are `u32` expressions (grow yields the old size, or
  2³²−1 on failure); `mem.fill(dst, byte, len)` and `mem.copy(dst, src, len)`
  are statements. `mem.copy(dst, src, len, { from })` copies from another
  memory (mirroring `tbl.copy`; the receiver is the destination). Addresses,
  counts, and byte values accept either 32-bit signedness.
- **Data segments are passive by default**: `mod.data(bytes)` takes a
  `Uint8Array`/`ArrayBuffer` (copied at declaration — later mutation of the
  source does not affect the module) and returns a handle. Chaining
  `.at(mem, offset)` pins it active (copied at instantiation); `offset` is an
  integer, an `s32`/`u32` const, or an imported immutable module variable.
  Passive segments are used at runtime via `mem.init(seg, dst, src, len)` and
  released with `seg.drop()` (both statements). The data-count section is
  emitted automatically whenever segments exist.

### SIMD (v128 lane namespaces)

Ten lane views and four mask types over one 128-bit storage; the full
scalar discipline extends lane-wise. Signedness lives in the namespace
(`u16x8.shr` → `i16x8.shr_u`, `s8x16.extract` sign-extends), comparisons
produce masks, and `cast` retypes any v128 view into any other for free.

```js
import { s32x4, f32x4, m32x4, u8x16 } from "wasmemit";

const v = s32x4.load(mem, addr);                  // lane types load/store directly
const clamped = s32x4.bitselect(limit, v, s32x4.gt(v, limit)); // mask-typed select
$.if(m32x4.any_true(s32x4.lt(v, s32x4.const([0, 0, 0, 0]))), ($) => { /* … */ });
const bytes = u8x16.cast(v);                      // zero-cost view change
```

- `t.const([...lanes])` range-checks per lane signedness (BigInt for 64-bit
  lanes); `splat`/`extract`/`replace` use the matching scalar type; lane
  indices and `shuffle` patterns are immediates, range-checked eagerly.
- Memory: `load`/`store`, `load_splat`, `load_zero` (32/64-bit lanes), wide
  loads (`s16x8.load8x8`, `s32x4.load16x4`, `s64x2.load32x2`), and
  `load_lane`/`store_lane` — all with the scalar `{align, offset}` options.
- Widening families are operand-driven and signedness-consistent:
  `narrow` (saturating, takes signed sources), `extend_low/high`,
  `extadd_pairwise`, `extmul_low/high`, `trunc_sat`/`trunc_sat_zero`,
  `convert`/`convert_low`, `demote_zero`/`promote_low`, `s32x4.dot`.
- Module and local variables hold vectors (`mod.variable(s32x4, [1, 2, 3, 4])`
  accepts lane arrays); v128 never crosses the JS boundary, so exported
  signatures must stay scalar.

### References and tables

- **`funcref` and `externref` are value types** (null is their zero-init).
  wasm 2.0 gives references almost no operations, and the namespaces reflect
  that: `T.null()` (a const-expr, valid in initializers), `T.is_null(x)` →
  `bool`, and `T.select` (emitting the typed-select encoding). No equality,
  no casts, never in linear memory; promotion and permissive mode ignore
  them entirely.
- **`fn.ref()`** turns any function handle (defined or imported) into a
  first-class `funcref` — also a const-expr, so `mod.variable(funcref,
  fn.ref())` works. The spec's ref.func declaration requirement is satisfied
  by an auto-generated hidden declarative element segment.
- **Tables**: `mod.table(elemType, { min, max? })` — funcref or externref,
  limits in elements, multiple tables allowed, `.import()`/`.export()` chain.
  Handle methods mirror memory: `get`/`set`, `size()`/`grow(delta, init =
  null)` (u32), `fill(start, ref, len)`, `copy(dst, src, len, { from? })`
  (cross-table via the options bag; element types must match), and
  `init(seg, …)`. Indices are sign-agnostic 32-bit positions.
- **Indirect calls**: `mod.funcType(params, results)` declares a reusable
  signature (interned into the type section); `tbl.call(type, index,
  ...args)` performs `call_indirect` with eager arg checking and fn.call's
  result rules (0 → statement, 1 → node, n → tuple). Runtime traps on
  OOB/null/signature mismatch are wasm's own. A funcType is also accepted by
  `mod.function(type)` so signature families are single-sourced.
- **Element segments mirror data segments**: `mod.elem([f, null, g])` (items:
  function handles or null) is passive by default; `.at(table, offset)` pins
  it active (funcref tables only); `tbl.init(seg, dst, src, len)` and
  `seg.drop()` at runtime. The encoding flavor (plain/expression vector,
  table index, declarative) is chosen automatically.

### Safe promotion (default) and permissive mode

- **Safe promotion is core semantics, not a mode.** The consuming op's
  namespace explicitly names the target type, and only value-exact lifts
  exist, so there is nothing implicit to guard: `f64.add(xf32, ys32)` lifts
  both exactly; `s64.mul(a64, b_s32)` sign-extends; `u64.add(a, b_u32)`
  zero-extends; `bool` lifts as 0/1 into anything numeric (which also makes
  `bool` valid in address/index positions). Applies uniformly to operands,
  call arguments, `$.return`, `.set()`, select arms, and store values.
  Constant initializers promote at build time (the result is still a plain
  `t.const`, so const-expr rules hold). Never lossy, never narrowing:
  `s64`/`u64` → `f64` (53-bit mantissa), `s32` → `f32` (24-bit), `u32` ↔
  `s32`, float → int, and int → bool all stay errors.
- **`permissive: true`** (opt-in per Module; the test suite stays strict
  except dedicated mode tests) — bit-level leniency *within* a storage
  width: conditions accept integers ("non-zero is true": 32-bit retypes for
  free, 64-bit inserts a real ≠0 test); integer positions accept the
  opposite signedness via zero-cost retype; `bool` operand positions accept
  integers by inserting a ≠0 test — never a bit-reinterpretation, so
  `bool.and(flag, 2)` means `flag && (2 ≠ 0)`. Constants stay range-strict;
  floats never coerce; cross-width stays promotion's (value-exact) domain.

### Evaluation-order semantics

Expression nodes are *recorded*, not emitted, as the body callback runs:

1. **Single-use** expressions inline at their point of consumption, in operand
   order — exactly the wasm stack discipline.
2. **Multi-use** expressions evaluate **once, at their creation point** (their
   position in statement order), auto-bound to a local; each use reads the local.
3. If a creation point does not dominate some use (checked on the CFG's
   dominator tree — now essential given arbitrary gotos), that's a build error.
4. **Multi-value** call results spill to locals immediately and destructure:
   `const [q, r] = divmod.call(a, b)`.
5. Zero-result nodes are statements (anchored at creation, rule 2's point).
   An effectful node **with** results (e.g. a call returning a value) that is
   never consumed is a build error at body completion — discard explicitly
   with `$.drop(...)`. Never a silent no-op.

### Diagnostics

`new Module({ debug: true })` captures a JS stack trace at every node/label
creation, so emit-time errors (unplaced label, non-dominated use, unconsumed
effect) point at the user's source line. Off by default — zero cost otherwise.

## Deferred — API not yet designed (DO NOT IMPLEMENT)

The following are recognized but **must not be implemented until the API is
discussed and locked down** in a future planning session. Nothing in the core
may assume a shape for these beyond what's noted here.

- Already out of spec scope (no design needed yet): GC types, exception
  handling, threads/atomics, tail calls, multi-memory, memory64.

## Pinned — might revisit later

Deemed unnecessary for now; not queued, not planned. Reopen only if a
concrete need appears.

- **Custom sections** — name section emission (possibly tied to `debug`),
  raw `mod.customSection(name, bytes)` passthrough, `.name()` attribute.

## Compilation pipeline

```
builder callbacks ──► CFG of basic blocks (typed instructions, virtual locals)
                 ──► dominator tree (multi-use checks) + liveness analysis
                 ──► local slot allocation (slots shared across disjoint live ranges, per type)
                 ──► relooper (CFG → structured block/loop/if/br_table; handles irreducible CFGs)
                 ──► encoder (sections, LEB128) ──► Uint8Array
```

- Locals are non-SSA virtual registers in the CFG; liveness drives slot sharing.
- Two encoder peepholes: `set s; get s` (same slot) collapses to `local.tee`,
  and a synthetic zero-init in the straight-line entry prefix is elided when
  its slot is provably fresh (wasm zero-initializes locals; loop-body inits
  and params are never touched).
- Relooper follows the dominator-tree approach of Ramsey's *Beyond Relooper*
  (as used in wasm-tools); a pre-pass lowers irreducible graphs by node
  splitting, falling back to a selector + `br_table` dispatch loop once
  duplication exceeds a block budget.
- Instructions are described by a single data-driven opcode table (name,
  immediates, signature, encoding) that generates both the expression
  constructors and the encoder — one place to add an instruction.
- Eager validation lives in the builder layer; whole-module checks (missing
  bodies, unplaced labels, foreign handles, limits) happen at `emit()`.

## Testing

- Every feature test builds a module, `WebAssembly.instantiate()`s the emitted
  bytes in Node, and asserts on executed results — the engine is the oracle.
- Error-path tests assert that invalid builder usage throws eagerly with
  useful messages.
- (Optional later: wabt.js dev-dependency for readable `.wat` diffs when
  debugging encoder issues.)

## Source layout

```
src/
  index.js          public exports
  types.js          value types, function-type interning
  module.js         Module + entity handles (function/memory/global/table/import)
  builder.js        statement context ($), labels, if/while sugar
  expr.js           expression nodes + generated instruction constructors
  optable.js        data-driven opcode/instruction metadata
  cfg.js            basic blocks, CFG construction
  passes/
    dominators.js
    liveness.js
    slots.js        local slot allocation
    relooper.js     CFG → structured control flow
  encode/
    leb.js          LEB128 / byte writer
    encoder.js      section emission
test/
```

## Implementation order

1. `encode/` + `optable.js` — byte-level foundation, unit-testable.
2. `types.js`, `module.js` — entities, interning, empty-module emit.
3. Straight-line bodies: expressions, locals, `$.return` — first end-to-end
   "emit and run an add function" test.
4. Labels/goto + relooper (reducible cases), then `$.if`/`$.while` sugar.
5. Liveness + slot allocation, auto-binding, dominance checks.
6. Irreducible-CFG handling, `$.switch`, `$.unreachable`.
7. Deferred items — each only after its API is designed and agreed
   (see *Deferred* above).
