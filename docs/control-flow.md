# Control flow

[← Manual index](index.md)

Control flow is built on **symbolic labels** over a flat control-flow graph.
The structured forms (`$.if`, `$.while`) are sugar that desugars to labels —
they're recording devices, not scopes. Internally everything lowers through
dominator analysis and a relooper back to structured wasm
(`block`/`loop`/`if`/`br_table`).

## Labels and gotos

- `$.label()` — create a label placed *here*.
- `$.label.ahead()` — create a forward label; place it later with `.here()`
  (exactly once, inside the same function body).
- `$.goto(label)` — unconditional jump.
- `$.gotoIf(cond, label)` — conditional jump; `cond` must be
  [`bool`](types.md#bool-is-a-barrier).
- `$.switch(index, [l0, l1, …], defaultLabel)` — dense dispatch on a 32-bit
  index, lowering to `br_table`.

```js
import { Module, s32 } from "wasmemit";

const mod = new Module();
mod.function([s32], [s32]).export("sum").body((n, $) => {
  const acc = $.variable(s32);
  const exit = $.label.ahead();
  const top = $.label();
  $.gotoIf(s32.eqz(n), exit);
  acc.set(s32.add(acc, n));
  n.set(s32.sub(n, s32.const(1)));
  $.goto(top);
  exit.here();
  $.return(acc);
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.sum(10) !== 55) throw new Error("unexpected");
```

Labels are **function-scoped, not callback-scoped**: `.here()` may be called
inside a nested `$.if`/`$.while` callback, and jumping into a conditional arm
from outside it is legal — the target simply becomes a merge point.

### Irreducible control flow just works

Arbitrary gotos can produce loops with multiple entry points — control flow
no structured language can express directly. wasmemit lowers it automatically
(node splitting, with a dispatch-loop fallback for pathological shapes)
rather than rejecting it:

```js
import { Module, s32, bool } from "wasmemit";

const mod = new Module();
// a loop entered at two different points, depending on the argument
mod.function([s32], [s32]).export("f").body((x, $) => {
  const a = $.label.ahead();
  const b = $.label.ahead();
  $.gotoIf(bool.of(x), b);
  a.here();
  x.set(s32.add(x, s32.const(1)));
  b.here();
  $.gotoIf(s32.lt(x, s32.const(10)), a);
  $.return(x);
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.f(0) !== 10 || instance.exports.f(42) !== 42) throw new Error("unexpected");
```

## Structured sugar

`$.if(cond, body)` returns a chain accepting any number of
`.elseIf(cond, body)` and a final `.else(body)`; `$.while(cond, body)` loops.
Each callback receives a fresh `$` (same function, same labels in scope):

```js
import { Module, s32, bool } from "wasmemit";

const mod = new Module();
mod.function([s32], [s32]).export("collatzSteps").body((n, $) => {
  const steps = $.variable(s32);
  $.while(s32.gt(n, s32.const(1)), ($) => {
    $.if(bool.of(s32.and(n, s32.const(1))), ($) => {
      n.set(s32.add(s32.mul(n, s32.const(3)), s32.const(1)));
    }).else(($) => {
      n.set(s32.div(n, s32.const(2)));
    });
    steps.set(s32.add(steps, s32.const(1)));
  });
  $.return(steps);
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.collatzSteps(6) !== 8) throw new Error("unexpected");
```

Arms may `$.return` directly, and a chain is finalized by the next statement —
calling `.elseIf` after unrelated statements is an eager error.

For a branch**less** conditional *value*, use `t.select(cond, a, b)`
([Types](types.md)) — note both arms always evaluate.

## Returning and trapping

- `$.return(...values)` — arity and types checked against the function's
  results (with [promotion](types.md#safe-value-exact-promotion-default)).
  Returning a call's results directly emits a **tail call** — see
  [Tail calls](tail-calls.md).
- `$.unreachable()` — emits `unreachable`; executing it traps.
- `$.drop(value)` — evaluate and discard.
