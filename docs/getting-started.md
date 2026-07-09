# Getting started

[← Manual index](index.md)

## Install

```sh
npm install wasmemit
```

wasmemit is a single ES module with zero dependencies. Emitting works on
Node ≥ 18 and in any browser; the emitted module's engine requirements depend
on [which features it uses](index.md#feature-and-engine-matrix).

## A first module

Everything starts from a `Module`. Functions are declared with parameter and
result type lists, given bodies via a callback, and wired to the outside world
with chained `.import()` / `.export()`:

```js
import { Module, s32 } from "wasmemit";

const mod = new Module();

// an import: (module "env") (name "log"), signature (s32) -> ()
const log = mod.function([s32], []).import("env", "log");

mod.function([s32], [s32]).export("fact").body((n, $) => {
  const acc = $.variable(s32, 1);
  $.while(s32.gt(n, s32.const(1)), ($) => {
    acc.set(s32.mul(acc, n));
    n.set(s32.sub(n, s32.const(1)));
  });
  log.call(acc);
  $.return(acc);
});

const bytes = mod.emit(); // Uint8Array — a complete .wasm binary

const logged = [];
const { instance } = await WebAssembly.instantiate(bytes, {
  env: { log: (v) => logged.push(v) },
});
if (instance.exports.fact(5) !== 120 || logged[0] !== 120) throw new Error("unexpected");
```

The body callback receives one handle per parameter, then `$` — the
[statement context](control-flow.md) carrying labels, control flow, local
variables, and `return`. Parameters are ordinary [variables](expressions.md#variables):
read them by using them as values, write them with `.set(value)`.

Note what did *not* happen: no text format, no separate validation step, no
toolchain. `s32.mul(acc, n)` type-checked the moment it ran — a mistake like
`s32.mul(acc, f64.const(1))` throws immediately, at that line, not at emit
time ([Errors and debugging](errors.md)).

## Reading the type names

wasmemit's types put signedness first: `s32`/`u32`/`s64`/`u64` are *views* of
wasm's `i32`/`i64`, and the view picks the instruction — `u32.div` emits
`i32.div_u`, `s32.div` emits `i32.div_s`. Comparisons produce a first-class
`bool`, and conditions require it. The full rules, including which operand
types lift automatically into which slots, are in
[Types and promotion](types.md).

## Emitting

`mod.emit()` is repeatable and byte-stable — call it as many times as you
like, cache the result, hash it, snapshot it. Declarations may continue after
an emit (a later `emit()` includes them), but each function's compiled body is
cached after its first emit.

## Where to next

- The [Module page](module.md) covers module-level state: options like
  [`tailCalls`](module.md#tailcalls) and [`permissive`](module.md#permissive),
  module variables (wasm globals), memories, tables, and the start function.
- Each wasm proposal has [its own section](index.md#manual) — they compose
  with everything here.
