# wasmemit

A JavaScript module for generating WebAssembly modules using expression builders.
Emits valid `.wasm` binaries directly, with no external toolchain.

See [DESIGN.md](DESIGN.md) for the full design contract.

## Example

```js
import { Module, s32 } from "wasmemit";

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
`$.while` as sugar. Internally everything lowers through a CFG → liveness →
slot allocation → relooper → encoder pipeline; expressions are type-checked
eagerly at the builder call that creates them.

## Status

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

Working: functions (declare/body/import/export, forward decls, mutual
recursion), the full Wasm 2.0 numeric instruction set, module and function
variables (globals/locals with slot reuse), auto-bound multi-use expressions,
multi-value returns with destructuring, the full memory surface (sized
loads/stores, mem.size/grow/fill/copy, active and passive data segments
with mem.init/seg.drop), start function, `T.select`, `$.switch`, `$.unreachable`, debug-mode creation traces.

Not yet (see the deferred list in DESIGN.md — API to be designed first):
tables/`call_indirect`, reference types, SIMD, custom sections. Irreducible control flow is detected and
rejected rather than lowered.

## Development

```sh
npm test
```

## License

MIT
