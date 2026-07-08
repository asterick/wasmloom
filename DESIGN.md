# wasmemit — Design

Generate WebAssembly modules from JavaScript using expression builders. No external
toolchain; emits binary `.wasm` bytes directly.

## Decisions (agreed)

| Area | Decision |
|---|---|
| API style | Hybrid: expression objects for values, statement context (`$`) for control flow |
| Output | Binary `.wasm` bytes (`Uint8Array`) |
| Spec target | Wasm 2.0 baseline: multi-value, bulk memory, reference types, sign-extension |
| Validation | Eager — type errors throw at the builder call that caused them |
| Declarations | Handles: declare first, attach bodies later (forward decls, mutual recursion) |
| Expression reuse | Auto-bound to hidden locals; local slots reused when live ranges end |
| IR | CFG of basic blocks from day one; structured constructs are sugar over the CFG |
| Future | Labels / `goto` / `switch` lower through the same relooper pass |
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

odd.body((n, $) => {
  $.if(i32.eqz(n), $ => $.return(i32.const(0)));
  $.return(even.call(i32.sub(n, i32.const(1))));
});

even.body((n, $) => {
  $.if(i32.eqz(n), $ => $.return(i32.const(1)));
  $.return(odd.call(i32.sub(n, i32.const(1))));
});

const bytes = mod.emit();   // Uint8Array; throws if any handle lacks a body
```

- `mod.function(params, results)` returns a **function handle** immediately.
  `.export(name)`, `.body(fn)` chain. `.call(...)` is valid before the body exists.
- The body callback receives one expression node per parameter, then `$`
  (the statement context) last.
- Other module entities follow the same handle pattern: `mod.memory()`,
  `mod.global()`, `mod.table()`, `mod.data()`, `mod.elem()`, `mod.start(fn)`,
  `mod.importFunction/importMemory/importGlobal/importTable(...)`.
- Function types are interned/deduplicated into the type section automatically.

### Expressions and statements

- **Expression namespaces** (`i32`, `i64`, `f32`, `f64`, `ref`, `mem`…) hold
  value-producing constructors: `i32.add(a, b)`, `f64.const(1.5)`,
  `i32.load(mem, addr, { offset, align })`, `fn.call(...)`, `global.get()`.
  Each returns an expression node with a known result type — checked eagerly.
- **Statement context `$`** anchors effects and control flow:
  `$.local(type, init?)`, `$.set(target, value)` / `local.set(value)`,
  `$.if(cond, then, else?)`, `$.loop(fn)`, `$.block(fn)`, `$.br(target, cond?)`,
  `$.return(...values)`, `$.call(fn, ...)` (result-discarding), `$.drop(v)`,
  `$.store(...)`, `$.unreachable()`.
- Control-flow callbacks receive a fresh `$` scoped to that region, plus a
  handle for branching (`loop.continue()`, `block.break()` style — exact names TBD).

### Evaluation-order semantics (important)

Expression nodes are *recorded*, not emitted, as the body callback runs. The rules:

1. **Single-use** expressions are inlined at their point of consumption, in
   operand order — exactly the wasm stack discipline.
2. **Multi-use** expressions are evaluated **once, at their creation point**
   (the position in statement order where the constructor was called), stored
   in an auto-allocated local, and each use reads that local. Creation point
   dominates all later uses in straight-line builder code, so this is always safe.
3. If a multi-use expression's creation point does **not** dominate some use
   (e.g. created inside one branch of an `$.if`, used after it), that's a build
   error with a message pointing at the offending use.
4. **Multi-value** expressions (calls returning >1 result) are spilled to
   locals immediately; the node acts as a tuple you can index or destructure:
   `const [q, r] = divmod.call(a, b)`.

Consequence: side effects (calls, stores) that are never consumed by a
statement never execute — creating an expression and dropping it on the floor
is a build error (unconsumed effectful node at body completion), not a silent no-op.

## Compilation pipeline

```
builder callbacks ──► CFG of basic blocks (typed instructions, virtual locals)
                 ──► liveness analysis
                 ──► local slot allocation (reuse slots with disjoint live ranges, per type)
                 ──► relooper/stackifier (CFG → structured block/loop/if/br_table)
                 ──► encoder (sections, LEB128) ──► Uint8Array
```

- Structured builder constructs (`$.if`, `$.loop`) desugar into CFG edges at
  build time; the relooper reconstructs structure at emit time. This makes
  future `$.label()` / `$.goto()` / `$.switch()` pure front-end additions.
- Eager validation happens in the builder layer (operand/result types, arity);
  whole-module checks (missing bodies, dangling handles from another Module,
  memory limits) happen at `emit()`.
- Instructions are described by a single data-driven opcode table (name,
  immediates, signature, encoding) that generates both the expression
  constructors and the encoder — one place to add an instruction.

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
  builder.js        statement context ($), scope tracking
  expr.js           expression nodes + generated instruction constructors
  optable.js        data-driven opcode/instruction metadata
  cfg.js            basic blocks, CFG construction
  passes/
    liveness.js
    slots.js        local slot allocation
    relooper.js     CFG → structured control flow
  encode/
    leb.js          LEB128 / byte writer
    encoder.js      section emission
test/
```

## Open questions

- Exact naming for branch targets inside `$.loop`/`$.block` callbacks.
- Whether params should get the same auto-bind treatment (params are already
  locals, so `n` used twice is naturally fine — likely yes, trivially).
- How much of reference types to surface initially (`funcref`/`externref`,
  `ref.null`, `ref.func`, `table.get/set`) vs. stub.
