# Errors and debugging

[← Manual index](index.md)

wasmloom validates **eagerly**: the builder call that creates a mistake is
the one that throws, as a `WasmLoomError` naming the operation, what it
expected, and what it got. There is no separate "validate" step to run and no
invalid intermediate state to debug — if your builder code finished running,
the module structure is sound.

```js
import { Module, s32, f64, WasmLoomError } from "wasmloom";

const mod = new Module();
let caught = null;
mod.function([s32], [s32]).body((x, $) => {
  try {
    s32.add(x, f64.const(1)); // lossy f64 → s32 never lifts
  } catch (e) {
    caught = e;
  }
  $.return(x);
});
if (!(caught instanceof WasmLoomError)) throw new Error("expected an eager error");
if (!/expected s32, got f64/.test(caught.message)) throw new Error(caught.message);
```

Typical eager errors: type mismatches beyond
[promotion](types.md#safe-value-exact-promotion-default), non-`bool`
[conditions](types.md#bool-is-a-barrier), wrong arity, out-of-range constants
and [lane indices](simd.md#constructing-and-inspecting), unconsumed call
results, handles from [another module or body](expressions.md#scope-rules),
writes to immutable variables, invalid
[constant expressions](extended-const.md).

## Emit-time errors

A few facts only exist once the whole module is known; these throw from
[`emit()`](module.md#emit): a declared function never given a body or import,
a forward label never placed, a
[constant expression reading a mutable variable](extended-const.md#what-may-appear-in-a-constant-expression)
(mutability can chain after use), a multi-use expression whose
[creation point doesn't dominate a use](expressions.md).

## `debug: true`

Emit-time errors name entities, but pointing at *your* source line requires
knowing where a node was created —
[`new Module({ debug: true })`](module.md#debug) captures a stack trace at
every node/label creation and attaches it to emit-time failures. It's off by
default (trace capture costs time during building, none at emit) and never
changes the output bytes.

## Named stack traces

Engines read the emitted **name section** for wasm frames, and wasmloom
fills it automatically: every function (and memory, table, module variable,
segment, and the module itself) carries a debug name derived from its export
name — or `"module.name"` for imports — with a chained `.name("str")`
override for anything internal:

```js
import { Module } from "wasmloom";

const mod = new Module().name("codec");
const inner = mod.function([], []).name("tightLoop");
inner.body(($) => $.unreachable());
mod.function([], []).export("run").body(($) => {
  inner.call();
  $.return();
});
const { instance } = await WebAssembly.instantiate(mod.emit());
let stack = "";
try { instance.exports.run(); } catch (e) { stack = e.stack; }
if (!/tightLoop/.test(stack)) throw new Error(stack); // named frame, not wasm-function[1]
```

[`new Module({ names: false })`](module.md#names) strips the section for
size-sensitive builds. Local names are deliberately not emitted — locals
share wasm slots across disjoint live ranges, so a slot has no single name.
(One subtlety when reading traces: [tail calls](tail-calls.md) replace
frames, so callers in tail position won't appear.)

## Runtime traps

Traps are the engine's, not wasmloom's: division by zero, out-of-bounds
access, `call_indirect` signature mismatches,
[null function references](typed-funcref.md#promotion), `$.unreachable()`.
They surface as `WebAssembly.RuntimeError` when the export is called. What
wasmloom guarantees is that its *output validates* — the emitted bytes are
checked against V8 across the entire test suite, including every example in
this manual.
