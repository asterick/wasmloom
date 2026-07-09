# Expressions and evaluation order

[← Manual index](index.md)

Builder calls create **expression nodes**: `s32.add(a, b)` returns a node you
can pass into other constructors. Nothing "runs" in JavaScript — the tree you
build becomes wasm instructions. Two rules govern *when* an expression's value
is computed in the emitted code, and they're pinned by a differential fuzzer:

1. **Single-use expressions evaluate at their point of consumption.** Building
   a node and using it once later is free — it inlines where it's consumed.
2. **Multi-use expressions evaluate once, at their creation point.** Using a
   node twice auto-binds it to a hidden local: the value is computed where you
   *created* it and re-read at each use. Consequently the creation point must
   dominate every use — creating a value inside an `$.if` arm and using it
   after the arm is an eager error telling you to bind it to a variable
   yourself.

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const noisy = mod.function([], [s32]).import("env", "tick");

mod.function([], [s32]).export("twice").body(($) => {
  const t = noisy.call();          // multi-use ⇒ evaluated ONCE, here
  $.return(s32.add(t, t));
});

let n = 0;
const { instance } = await WebAssembly.instantiate(mod.emit(), {
  env: { tick: () => ++n },
});
if (instance.exports.twice() !== 2) throw new Error("tick ran twice?"); // 1 + 1
```

## Statements

Zero-result operations — stores, `mem.fill`, `v.set(...)`, calls to functions
with no results — **auto-anchor as statements** at their creation point; you
just call them. Expressions with results must be consumed: an unused call
result is an eager error (drop it explicitly with `$.drop(value)` if
discarding is intended).

## Variables

- `$.variable(type, init?)` — a function-local (wasm local). Zero/null
  initialized unless given an init; non-null reference types
  [require one](typed-funcref.md#non-null-variables).
- `mod.variable(type, init?)` — a module variable (wasm global); see
  [The Module](module.md#module-variables-wasm-globals).

A variable handle **is** an expression of its type — reading is just using
it. Reads follow the same two evaluation rules as any expression, which makes
the interaction with writes worth internalizing: a *single-use* expression
containing a read inlines at its consumption point, so it sees writes made in
between.

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
mod.function([s32], [s32]).export("f").body((x, $) => {
  const v = $.variable(s32, 10);
  const late = s32.mul(v, x); // single-use: evaluates at the return...
  v.set(s32.const(100));
  $.return(s32.add(late, v)); // ...AFTER the set: 100*x + 100
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.f(2) !== 300) throw new Error("unexpected"); // 200 + 100
```

To capture a value *at a moment in time* — before later writes — bind it to
a variable at that moment; the initializer is a statement and executes right
there:

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
mod.function([s32], [s32]).export("f").body((x, $) => {
  const v = $.variable(s32, 10);
  const before = $.variable(s32, s32.mul(v, x)); // captured NOW: 10*x
  v.set(s32.const(100));
  $.return(s32.add(before, v)); // 10*x + 100
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.f(2) !== 120) throw new Error("unexpected"); // 20 + 100
```

(Multi-use expressions capture implicitly for the same reason — rule 2
evaluates them at creation. But when the timing of a read matters, the
explicit `$.variable` binding says so in the source. Prefer obvious.)

## Scope rules

Expressions and labels belong to the function body being built. Leaking a
node out of one `body()` callback and consuming it in another is an eager
error ("belongs to a different function body"), as is mixing modules'
handles. Constants and [constant expressions](extended-const.md) are the
exception — they're position-independent and may be built outside any body.
