# Exception handling

[← Manual index](index.md) · *WebAssembly proposal: exception handling with
exnref (wasm 3.0). Emitted modules need Node ≥ 24 / Chrome ≥ 131 — only when
a module uses tags or try.*

Typed, zero-cost-until-thrown exceptions: **tags** declare an exception's
payload signature, `$.throw` raises one, and `$.try` chains handlers that
receive the payload as typed variables. Uncaught exceptions unwind through
wasm frames and surface to JavaScript as `WebAssembly.Exception`; JS code can
throw them *into* wasm through imported tags.

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const oops = mod.tag([s32, s32]).export("oops"); // payload: code, detail

mod.function([s32, s32], [s32]).export("safeDiv").body((n, d, $) => {
  const r = $.variable(s32);
  $.try(($) => {
    $.if(s32.eqz(d), ($) => $.throw(oops, n, s32.const(7)));
    r.set(s32.div(n, d));
  }).catch(oops, (code, detail, $) => {
    r.set(s32.add(s32.mul(code, s32.const(-1)), detail));
  }).catchAll(($) => {
    r.set(s32.const(-999)); // any other exception — including ones thrown by JS imports
  });
  $.return(r);
});

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.safeDiv(10, 2) !== 5) throw new Error("unexpected");
if (instance.exports.safeDiv(3, 0) !== 4) throw new Error("unexpected"); // caught: -3 + 7
```

## Tags

`mod.tag([types])` declares a tag — a module-level entity with the usual
chains: [`.import()`/`.export()`](module.md#imports-and-exports),
[`.name()`](errors.md#named-stack-traces). Tag *identity* is what catches
match on, so two modules interoperate by sharing one tag (export it from one,
import it into the other — or create it in JS with `new WebAssembly.Tag`).

## Throwing and catching

- `$.throw(tag, ...args)` — a terminator, like `$.return`; arguments check
  against the tag's payload types
  ([promotion](types.md#safe-value-exact-promotion-default) applies). Legal
  anywhere — an uncaught throw unwinds out of the export.
- `$.try(body)` returns a chain: `.catch(tag, (payload..., $) => {})`,
  `.catchAll(($) => {})`, and the `Ref` variants below. The **first matching
  clause wins**; clauses after a `.catchAll` are eager errors, as are
  duplicate catches for one tag. Handlers run *outside* the protection (a
  throw inside a handler propagates outward) and fall through to the code
  after the try.
- Exceptions unwind through any depth of [calls](functions.md) to the nearest
  matching handler.

## Rethrow: exnref

`.catchRef(tag, (payload..., exn, $) => {})` and `.catchAllRef((exn, $) => {})`
additionally hand the in-flight exception as an `exnref` — a first-class
value you can store in [variables](expressions.md#variables) — and
`$.throwRef(exn)` rethrows it with identity and payload intact:

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const oops = mod.tag([s32]);
const cleanups = mod.variable(s32).export("cleanups");
const risky = mod.function([], []);
risky.body(($) => $.throw(oops, s32.const(13)));

mod.function([], [s32]).export("f").body(($) => {
  const r = $.variable(s32);
  $.try(($) => {
    $.try(($) => risky.call())
      .catchAllRef((exn, $) => {
        cleanups.set(s32.add(cleanups, s32.const(1))); // run cleanup…
        $.throwRef(exn); // …then rethrow the ORIGINAL exception
      });
  }).catch(oops, (v, $) => {
    r.set(v); // still sees tag + payload: identity survived
  });
  $.return(r);
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.f() !== 13 || instance.exports.cleanups.value !== 1) {
  throw new Error("unexpected");
}
```

## Try regions are control-flow islands

Inside a try body or handler, all the structured sugar works — `$.if`,
`$.while`, nested `$.try`, `$.variable` — and `$.return` / `$.throw` leave
freely. What may **not** cross the boundary is a
[label or goto](control-flow.md): jumping into or out of a protected region
is an eager error suggesting restructuring. Variables are function-scoped and
cross freely — declare outside, write inside, read after.

Two consequences worth knowing:

- [Implicit tail calls](tail-calls.md) are **suppressed inside try bodies**:
  `$.return(f.call())` under a try keeps the plain call, because a tail call
  would replace the frame and silently escape the protection.
- JavaScript exceptions thrown by [imported functions](functions.md) are
  catchable — by tag via an imported `WebAssembly.Tag`, or wholesale with
  `.catchAll`.

## See also

- [Errors and debugging](errors.md) — build-time errors vs. runtime traps vs.
  exceptions; [named stack traces](errors.md#named-stack-traces) name tags too.
- [The Module](module.md) — tags in the entity list.
