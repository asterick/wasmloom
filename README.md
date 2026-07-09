# wasmloom

Weave WebAssembly binaries from JavaScript expression builders. Emits valid
`.wasm` directly — no external toolchain, zero dependencies — with strict,
eagerly-checked type discipline. Ships generated TypeScript declarations.

**[Reference manual](docs/index.md)** — a multipage manual with tested
examples, one section per WebAssembly proposal (also served via GitHub
Pages). [DESIGN.md](DESIGN.md) is the design contract.

## Example

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
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

const { instance } = await WebAssembly.instantiate(mod.emit(), {
  env: { log: (v) => console.log(v) },
});
instance.exports.fact(5); // logs 120
```

Control flow is built on symbolic labels (`$.label()`, `$.label.ahead()`,
`$.goto`, `$.gotoIf`, `$.switch`) with `$.if(...).elseIf(...).else(...)` and
`$.while` as sugar — including irreducible flow, which is lowered by node
splitting (with a dispatch-loop fallback) rather than rejected. Internally
everything lowers through a CFG → liveness → slot allocation → relooper →
encoder pipeline; expressions are type-checked eagerly at the builder call
that creates them.

## Coverage

The full **WebAssembly 2.0** surface — numerics, multi-value, bulk memory,
reference types and tables, sign-extension, nontrapping conversions, and
fixed-width **SIMD** — plus, from **wasm 3.0** (Node ≥ 22 to run):

- **Multiple memories** — declare any number; every load/store already takes
  its memory handle, and `mem.copy(dst, src, len, { from })` copies across.
- **Tail calls** — implicit: `$.return(f.call(…))` (and the indirect and
  multi-value forms) emits `return_call`, so deep self/mutual recursion runs
  in constant stack. Opt out with `new Module({ tailCalls: false })`.
- **Extended constant expressions** — `add`/`sub`/`mul` built outside a body
  compose immutable globals into initializers and data/element offsets:
  `mod.variable(s32, s32.add(base, s32.const(16)))`.
- **Typed function references** — every signature handle carries `sig.ref`
  (non-null) and `sig.refNull` types; `fn.ref()` is precisely typed and
  upcasts by promotion; `sig.call(ref, …)` emits `call_ref` (no table, no
  runtime signature check), tail-calling in return position. Tables of
  `sig.refNull` make checked-free vtables: `sig.call(vt.get(i), x)`.
  `sig.ref.of(x)` is the trapping nullable→non-null bridge.
- **Exception handling** — `mod.tag([types])` declares typed exceptions;
  `$.throw(tag, …)` raises, `$.try(body).catch(tag, (payload…, $) => {})`
  chains handlers (plus `catchAll` and `exnref`-carrying `Ref` variants for
  identity-preserving `$.throwRef` rethrow). Uncaught exceptions surface to
  JS as `WebAssembly.Exception`; JS exceptions enter through imported tags.

## Type discipline

Signedness is first-class: `s32`/`u32`/`s64`/`u64` select the right wasm
instruction variant (`u32.div` emits `i32.div_u`), conversions dispatch on
their operand's type (`f64.convert(x)`), and `u32.cast(x)`/`s32.cast(x)`
retype across signedness at zero cost. Mixed-sign arithmetic is an eager
build error. Truth is first-class too: comparisons produce `bool`,
conditions require it (`bool.of(x)` tests integers), and `bool` carries
`and`/`or`/`xor`/`not`. Safe value-exact promotion is default behavior —
operands lift into an op's explicitly-named namespace type when they fit
exactly (`f64.add(xf32, ys32)`, `s64.mul(a, b_s32)`, bool as 0/1) while
lossy or narrowing moves always error. `new Module({ permissive: true })`
additionally opts into same-width sign mixing and integer truthiness.

SIMD extends the same discipline lane-wise: ten signedness-carrying lane
namespaces (`s8x16`…`f64x2`) over one `v128` storage, comparisons produce
dedicated mask types (`m8x16`…`m64x2`) that `bitselect` and `all_true` /
`any_true` / `bitmask` require, and `cast` retypes any v128 view into any
other for free.

Emitted modules carry a **name section** by default — exports name their
entities automatically, `.name("str")` overrides, `names: false` opts out —
so stack traces read `at encrypt`, not `at wasm-function[13]`.

The generated `index.d.ts` encodes all of it: parameter tuples infer the
body callback's variable types, operand slots accept exactly the safe
promotions, and shape/signedness barriers reject in TypeScript just as they
throw at build time.

## Development

```sh
npm test        # 200+ tests: behavioral round-trips through V8, two
                # differential fuzzers, per-instruction sweeps (~25k cases)
npm run types   # regenerate index.d.ts from the veneer registry
```

Emitting runs on Node ≥ 18; the test suite exercises wasm 3.0 features and
needs Node ≥ 22. `emit()` is repeatable and byte-stable; `debug: true`
captures creation stack traces for emit-time errors at zero steady-state
cost.

## License

MIT
