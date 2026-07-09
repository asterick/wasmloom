# Typed function references

[← Manual index](index.md) · *WebAssembly proposal: typed function references
(wasm 3.0). Needs Node ≥ 22 / Chrome ≥ 119 / Firefox ≥ 120 — only when a module uses the
typed forms.*

Where [`funcref`](tables.md) is "some function", a typed reference is "a
function of *this* signature" — callable directly with `call_ref`: no table,
no runtime signature check, and for the non-null form not even a null check.
First-class functions, callbacks, and vtables at full speed.

## The types live on the signature

Every [signature handle](functions.md#signatures-modfunctype) carries two
types, usable anywhere a type goes (params, results,
[variables](expressions.md#variables), [tables](#typed-tables)):

- `sig.ref` — `(ref $sig)`, **non-null**;
- `sig.refNull` — `(ref null $sig)`, with `sig.refNull.null()` and
  `sig.refNull.is_null(x)` like `funcref`.

Signatures are interned per module — `mod.funcType([s32], [s32])` twice, or
`fn.type` on a matching function, all name the *same* handle, so the typed
reference types agree everywhere.

## Calling through a reference: call_ref

`sig.call(ref, ...args)` accepts either ref form (the nullable one traps on
null at run time):

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const sig = mod.funcType([s32], [s32]);
const dbl = mod.function([s32], [s32]).body((x, $) => $.return(s32.mul(x, s32.const(2))));

const apply = mod.function([sig.ref, s32], [s32]); // non-null parameter
apply.body((f, x, $) => $.return(sig.call(f, x))); // call_ref — and a tail call

mod.function([s32], [s32]).export("go").body((x, $) => {
  $.return(apply.call(dbl.ref(), x));
});

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.go(21) !== 42) throw new Error("unexpected");
```

`$.return(sig.call(…))` emits `return_call_ref` —
[tail calls](tail-calls.md) apply to every call form.

## Promotion

`fn.ref()` produces the **precise** non-null type, and wasm's upcast
subtyping is modeled as
[value-exact promotion](types.md#safe-value-exact-promotion-default):
`(ref $sig)` lifts into `(ref null $sig)` and into `funcref` slots
automatically — so typed refs drop into existing
[`funcref` tables and variables](tables.md) unchanged. There are **no
downcasts**: `funcref` → typed requires the GC proposal's casts, which
wasmloom doesn't target. Going nullable → non-null is a *checked* bridge,
priced like [`bool.of`](types.md#bool-is-a-barrier):

- `sig.ref.of(x)` — asserts non-null (`ref.as_non_null`), trapping on null.

```js
import { Module, s32, bool } from "wasmloom";

const mod = new Module();
const sig = mod.funcType([], [s32]);
const seven = mod.function([], [s32]).body(($) => $.return(s32.const(7)));

const cb = mod.variable(sig.refNull, null); // nullable callback slot
mod.function([], []).export("arm").body(($) => {
  cb.set(seven.ref()); // (ref $sig) → (ref null $sig): promotion
  $.return();
});
mod.function([], [bool]).export("armed").body(($) => {
  $.return(bool.not(sig.refNull.is_null(cb)));
});
mod.function([], [s32]).export("fire").body(($) => {
  $.return(sig.call(sig.ref.of(cb))); // traps if not armed
});

const { instance } = await WebAssembly.instantiate(mod.emit());
let trapped = false;
try { instance.exports.fire(); } catch { trapped = true; }
if (!trapped || instance.exports.armed() !== 0) throw new Error("unexpected");
instance.exports.arm();
if (instance.exports.armed() !== 1 || instance.exports.fire() !== 7) throw new Error("unexpected");
```

## Typed tables

`mod.table(sig.refNull, limits)` declares a table whose elements are known to
have `sig`'s shape — `tbl.get` returns the typed ref, and `sig.call(vt.get(i), …)`
dispatches with **no runtime signature check** (only the null check).
[Element segments](tables.md#element-segments) into typed tables verify each
function's signature at declaration. Non-null *tables* are rejected (they'd
have no default value) — use `sig.refNull`.

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const sig = mod.funcType([s32], [s32]);
const dbl = mod.function([s32], [s32]).body((x, $) => $.return(s32.mul(x, s32.const(2))));
const neg = mod.function([s32], [s32]).body((x, $) => $.return(s32.sub(s32.const(0), x)));

const vt = mod.table(sig.refNull, { min: 2 });
mod.elem([dbl, neg]).at(vt, 0);
mod.function([s32, s32], [s32]).export("dispatch").body((i, x, $) => {
  $.return(sig.call(vt.get(i), x)); // faster than call_indirect: no type check
});

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.dispatch(0, 21) !== 42) throw new Error("unexpected");
if (instance.exports.dispatch(1, 21) !== -21) throw new Error("unexpected");
```

## Non-null variables

A non-null type has no default value, so `$.variable(sig.ref)` and
`mod.variable(sig.ref)` **require initializers** (`fn.ref()` is a valid
constant one). Under the hood, non-null *locals* are stored in nullable slots
and re-asserted on read — invisible semantically; parameters, results, and
module variables carry true non-null types. Nullable variables default to
null as usual.

## In the type declarations

The [generated TypeScript](typescript.md) brands each signature's ref types:
nullable slots accept non-null values, `funcref` slots accept any typed ref,
and downcasts or cross-signature calls are compile errors — the same lattice
the builder enforces at run time.
