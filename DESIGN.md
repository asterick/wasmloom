# wasmemit — Design

Generate WebAssembly modules from JavaScript using expression builders. No external
toolchain; emits binary `.wasm` bytes directly.

## Decisions (agreed)

| Area | Decision |
|---|---|
| API style | Hybrid: expression objects for values, statement context (`$`) for effects/control flow |
| Output | Binary `.wasm` bytes (`Uint8Array`) |
| Spec target | Wasm 2.0 baseline: multi-value, bulk memory, reference types, sign-extension, nontrapping conversions |
| Validation | Eager — type errors throw at the builder call that caused them |
| Declarations | Handles: declare first, attach bodies later (forward decls, mutual recursion) |
| Control flow | Labels are atomic symbols placed at creation; `goto` / `gotoIf` / `switch` by reference |
| Sugar | Chained `$.if(c, fn).elseIf(c, fn).else(fn)` and `$.while(c, fn)`, desugaring to labels |
| Block values | Conditional values flow through locals (plus `select`); no typed-block results |
| Expression reuse | Auto-bound to hidden locals; local slots reused when live ranges end |
| IR | CFG of basic blocks from day one; relooper reconstructs structure at emit |
| i64 immediates | BigInt always; plain numbers only when `Number.isSafeInteger`, else throw |
| Diagnostics | `new Module({ debug: true })` captures creation stack traces for emit-time errors |
| Types | Plain JS with JSDoc annotations |
| Testing | Round-trip: instantiate output with V8 (`node --test`), assert executed results |

## Public API sketch

```js
import { Module, i32, i64, f32, f64 } from "wasmemit";

const mod = new Module();

// Imports are handles too — callable like any function.
const log = mod.importFunction("env", "log", [i32], []);

// Declare now, define later. Module-level attributes chain fluently.
const odd  = mod.function([i32], [i32]).export("odd");
const even = mod.function([i32], [i32]).export("even");

const mem = mod.memory({ min: 1 }).export("memory");
const counter = mod.global(i32, { mutable: true, init: 0 });

// Sugar for the common cases…
odd.body((n, $) => {
  $.if(i32.eqz(n), $ => {
    $.return(i32.const(0));
  }).else($ => {
    $.return(even.call(i32.sub(n, i32.const(1))));
  });
});

// …labels for everything else (see Labels below).
even.body((n, $) => {
  $.if(i32.eqz(n), $ => {
    $.return(i32.const(1));
  }).else($ => {
    $.return(odd.call(i32.sub(n, i32.const(1))));
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
  const acc  = $.local(i32, i32.const(0));
  const exit = $.label.ahead();

  const top = $.label();               // loop head, placed here
  $.gotoIf(i32.eqz(n), exit);
  acc.set(i32.add(acc, n));
  n.set(i32.sub(n, i32.const(1)));
  $.goto(top);

  exit.here();
  $.return(acc);
});
```

- `$.goto(label)`, `$.gotoIf(cond, label)` — unconditional/conditional jumps.
- `$.switch(index, [l0, l1, …], defaultLabel)` — dense dispatch, lowers to `br_table`.
- Arbitrary jumps may produce **irreducible** control flow; the relooper must
  handle it in v1 (node splitting, dispatch-loop fallback for pathological cases).

Structured sugar desugars to labels in the CFG:

```js
$.if(cond, $ => {
  // then
}).elseIf(other, $ => {
  // else-if — chainable any number of times
}).else($ => {
  // else
});

$.while(i32.gt_s(n, i32.const(0)), $ => {
  acc.set(i32.add(acc, n));
  n.set(i32.sub(n, i32.const(1)));
});
```

`$.if(...)` returns a chainable object accepting `.elseIf(cond, fn)` repeatedly
and `.else(fn)` as terminator. Since jumps are symbolic, values never flow out
of blocks — conditional values are written to locals in each arm, or use
`select` for the cheap two-operand case.

### Module entities

- `mod.function(params, results)` returns a **function handle** immediately.
  `.export(name)`, `.body(fn)` chain; `.call(...)` is valid before the body exists.
  The body callback receives one expression node per parameter, then `$` last.
- Same handle pattern throughout: `mod.memory()`, `mod.global()`, `mod.table()`,
  `mod.data()`, `mod.elem()`, `mod.start(fn)`, `mod.importFunction/importMemory/
  importGlobal/importTable(...)`.
- Function types are interned/deduplicated into the type section automatically.
- Loads/stores take the memory handle explicitly (`i32.load(mem, addr, {offset,
  align})`) so multi-memory bolts on later without an API break.

### Expressions

- **Expression namespaces** (`i32`, `i64`, `f32`, `f64`, `ref`…) hold
  value-producing constructors: `i32.add(a, b)`, `f64.const(1.5)`, `fn.call(...)`.
  Each returns a node with a known result type — checked eagerly, no implicit
  conversions (mirroring wasm; conversions are explicit instructions).
- `i64` immediates accept BigInt always, and plain numbers only when
  `Number.isSafeInteger(n)` — anything else throws.

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
5. An effectful node (call, store) never consumed by a statement is a build
   error at body completion — not a silent no-op.

### Diagnostics

`new Module({ debug: true })` captures a JS stack trace at every node/label
creation, so emit-time errors (unplaced label, non-dominated use, unconsumed
effect) point at the user's source line. Off by default — zero cost otherwise.

## Compilation pipeline

```
builder callbacks ──► CFG of basic blocks (typed instructions, virtual locals)
                 ──► dominator tree (multi-use checks) + liveness analysis
                 ──► local slot allocation (slots shared across disjoint live ranges, per type)
                 ──► relooper (CFG → structured block/loop/if/br_table; handles irreducible CFGs)
                 ──► encoder (sections, LEB128) ──► Uint8Array
```

- Locals are non-SSA virtual registers in the CFG; liveness drives slot sharing.
- Relooper follows the dominator-tree approach of Ramsey's *Beyond Relooper*
  (as used in wasm-tools), with node splitting / dispatch fallback for
  irreducible graphs.
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
6. Irreducible-CFG handling, `$.switch`, remaining Wasm 2.0 surface.
