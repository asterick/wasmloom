# Tail calls

[← Manual index](index.md) · *WebAssembly proposal: tail calls (wasm 3.0).
Emitted by default whenever a return is in tail position — opt out with
[`tailCalls: false`](module.md#tailcalls). Needs Node ≥ 20 / Chrome ≥ 112.*

Tail calls are **implicit**: returning a call's results directly emits
`return_call` (or `return_call_indirect` / `return_call_ref`), replacing the
current frame instead of growing the stack. Deep self- or mutual recursion
runs in constant space — no trampoline, no explicit form to remember.

```js
import { Module, s64 } from "wasmemit";

const mod = new Module();
const sum = mod.function([s64, s64], [s64]);
sum.body((n, acc, $) => {
  $.if(s64.eq(n, s64.const(0n)), ($) => $.return(acc));
  $.return(sum.call(s64.sub(n, s64.const(1n)), s64.add(acc, n))); // → return_call
});
mod.function([s64], [s64]).export("sum").body((n, $) => {
  $.return(sum.call(n, s64.const(0n)));
});

const { instance } = await WebAssembly.instantiate(mod.emit());
// ten million frames — impossible without frame replacement
if (instance.exports.sum(10_000_000n) !== 50000005000000n) throw new Error("unexpected");
```

## The rule

`$.return` performs a tail call when **the returned values are exactly the
results of a call evaluated last**. Because of wasmemit's
[evaluation-order semantics](expressions.md) this is a precise property, not
a heuristic. Concretely, all of these convert:

- `$.return(f.call(x))` — a single-use call always evaluates at the return.
- `$.return(...pair.call(x))` — multi-value results, spread straight through.
- `$.return(tbl.call(sig, i, x))` —
  [call_indirect](tables.md#call_indirect) form.
- `$.return(sig.call(r, x))` —
  [call_ref](typed-funcref.md#calling-through-a-reference-call_ref) form.
- `r.set(f.call(x)); $.return(r)` — the write is dead at a return, so binding
  first doesn't cost the conversion.

And these correctly do **not** (the call must keep its ordering):

- a result that needs [promotion](types.md#safe-value-exact-promotion-default)
  (`$.return(s64.add(k, f_returning_s32.call(x)))` — the convert runs after
  the call);
- a multi-value call with an effectful statement between it and the return;
- a call whose result is also consumed elsewhere.

The callee's results must equal the caller's — guaranteed by construction
here, since the return type-checks the values anyway.

## Mutual and indirect recursion

State machines fall out naturally — each state is a function, transitions are
returns of calls:

```js
import { Module, s32 } from "wasmemit";

const mod = new Module();
const even = mod.function([s32], [s32]);
const odd = mod.function([s32], [s32]);
even.body((n, $) => {
  $.if(s32.eqz(n), ($) => $.return(s32.const(1)));
  $.return(odd.call(s32.sub(n, s32.const(1))));
});
odd.body((n, $) => {
  $.if(s32.eqz(n), ($) => $.return(s32.const(0)));
  $.return(even.call(s32.sub(n, s32.const(1))));
});
mod.function([s32], [s32]).export("isEven").body((n, $) => $.return(even.call(n)));

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.isEven(1_000_000) !== 1) throw new Error("unexpected");
```

## Trade-offs and the opt-out

Converted frames vanish: stack traces through tail calls are shorter, and any
module containing one requires a wasm 3.0 engine.
[`new Module({ tailCalls: false })`](module.md#tailcalls) restores plain
calls globally — same results, real frames, and stack exhaustion at depth.
