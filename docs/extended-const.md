# Extended constant expressions

[← Manual index](index.md) · *WebAssembly proposal: extended constant
expressions (wasm 3.0). Needs Node ≥ 20 / Chrome ≥ 114 — only when a module
actually uses constant arithmetic.*

wasm restricts [global initializers](module.md#module-variables-wasm-globals)
and [segment offsets](memory.md#data-segments) to *constant expressions*.
This proposal adds integer `add`/`sub`/`mul` to that grammar — enough to
derive layouts from an imported base at instantiation time.

In wasmemit, the same constructors do double duty — **context decides**:
inside a function body, `s32.add` is the ordinary runtime op; outside any
body, it builds a constant expression. Operands there must be constants,
**immutable** module variables, or other constant expressions
([promotion](types.md#safe-value-exact-promotion-default) lifts small consts
as usual):

```js
import { Module, s32, u32 } from "wasmemit";

const mod = new Module();
const base = mod.variable(s32).import("env", "base").immutable();

// (base + 4) * 3, computed by the engine at instantiation
const derived = mod.variable(s32, s32.mul(s32.add(base, s32.const(4)), s32.const(3)))
  .immutable()
  .export("derived");
void derived;
void u32;

const { instance } = await WebAssembly.instantiate(mod.emit(), {
  env: { base: new WebAssembly.Global({ value: "i32" }, 10) },
});
if (instance.exports.derived.value !== 42) throw new Error("unexpected");
```

## What may appear in a constant expression

- `t.const(...)` for the integer types (`s32`/`u32`/`s64`/`u64`);
- **immutable** module variables — imported *or* declared earlier (the
  wasm 3.0 relaxation; mutability is checked at `emit()`, since
  `.immutable()` chains after declaration);
- nested constant `add`/`sub`/`mul`;
- and, orthogonally, the forms wasm always allowed: plain consts, `fn.ref()`
  ([function references](typed-funcref.md)), `null`.

Anything else — floats, division, runtime values, another module's handles —
is an eager error. There's no folding: the expression tree is emitted as-is
and evaluated by the engine.

## Segment offsets

The same trees serve as `.at()` offsets for
[data segments](memory.md#data-segments) and
[element segments](tables.md#element-segments) — the classic use is carving a
region relative to an imported allocation base:

```js
import { Module, u32 } from "wasmemit";

const mod = new Module();
const base = mod.variable(u32).import("env", "base").immutable();
const mem = mod.memory({ min: 1 }).export("mem");
mod.data(new Uint8Array([0xaa, 0xbb])).at(mem, u32.add(base, u32.const(2)));

const { instance } = await WebAssembly.instantiate(mod.emit(), {
  env: { base: new WebAssembly.Global({ value: "i32" }, 3) },
});
const bytes = new Uint8Array(instance.exports.mem.buffer);
if (bytes[5] !== 0xaa || bytes[6] !== 0xbb) throw new Error("unexpected");
```

## Reuse inside bodies

A constant tree built outside a body remains an ordinary expression — using
it inside a body simply emits `global.get`s and arithmetic
([evaluated by the usual rules](expressions.md)). One definition of a layout
constant can serve both the data segment placement and the code that
addresses it.
