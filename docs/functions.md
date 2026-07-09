# Functions

[← Manual index](index.md)

## Declaring

`mod.function(params, results)` returns a handle immediately — bodies attach
later, which makes forward declarations and mutual recursion natural:

```js
import { Module, s32, bool } from "wasmloom";

const mod = new Module();
const isOdd = mod.function([s32], [bool]).export("isOdd");
const isEven = mod.function([s32], [bool]).export("isEven");

isOdd.body((n, $) => {
  $.if(s32.eqz(n), ($) => $.return(bool.const(false)));
  $.return(isEven.call(s32.sub(n, s32.const(1))));
});
isEven.body((n, $) => {
  $.if(s32.eqz(n), ($) => $.return(bool.const(true)));
  $.return(isOdd.call(s32.sub(n, s32.const(1))));
});

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.isOdd(7) !== 1 || instance.exports.isEven(7) !== 0) {
  throw new Error("unexpected");
}
```

(Those recursive returns are also [tail calls](tail-calls.md) — automatically.)

Instead of `(params, results)` you may pass a signature handle:
`mod.function(sig)` where `sig = mod.funcType(params, results)`.

- `.body((...params, $) => { ... })` — one variable handle per parameter,
  then the [statement context](control-flow.md). Exactly one body or import
  per function; a declared function with neither fails at `emit()`.
- `.import("module", "name")` / `.export("name")` — see
  [The Module](module.md#imports-and-exports).

## Calling

`fn.call(...args)` type-checks arity and argument types eagerly
([promotion](types.md#safe-value-exact-promotion-default) applies). The
return shape follows the result count:

- **0 results** — the call is a statement; just call it.
- **1 result** — an expression node,
  [evaluated by the usual rules](expressions.md).
- **n results** — the call executes immediately and returns an array of
  variable handles for destructuring:

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const divmod = mod.function([s32, s32], [s32, s32]).body((a, b, $) => {
  $.return(s32.div(a, b), s32.rem(a, b));
});
mod.function([s32, s32], [s32]).export("f").body((a, b, $) => {
  const [q, r] = divmod.call(a, b);
  $.return(s32.add(s32.mul(q, s32.const(100)), r));
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.f(47, 10) !== 407) throw new Error("unexpected");
```

Unconsumed single results are eager errors — `$.drop(...)` if intentional.

## Signatures: `mod.funcType`

`mod.funcType(params, results)` declares a reusable signature handle used by
[`tbl.call` (call_indirect)](tables.md#call_indirect) and
[typed function references](typed-funcref.md). Signatures are **interned**:
identical shapes return the same handle, and `fn.type` retrieves the handle
for any function's own signature.

## Function references

`fn.ref()` produces a reference *value* — precisely typed as a non-null
reference to `fn`'s signature, usable in `funcref` positions
[by promotion](typed-funcref.md#promotion). Store them in
[tables](tables.md), [module variables](module.md#module-variables-wasm-globals),
or pass them around and invoke with
[`sig.call`](typed-funcref.md#calling-through-a-reference-call_ref).

## Start function

`mod.start(fn)` designates a `[] -> []` function to run automatically at
instantiation — useful with [data segments](memory.md#data-segments) for
setup that must precede any export call.
