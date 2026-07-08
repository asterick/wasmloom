# wasmemit

A JavaScript module for generating WebAssembly modules using expression builders.
Emits valid `.wasm` binaries directly, with no external toolchain.

See [DESIGN.md](DESIGN.md) for the full design contract.

## Example

```js
import { Module, i32 } from "wasmemit";

const mod = new Module();
const log = mod.function([i32], []).import("env", "log");

mod.function([i32], [i32]).export("fact").body((n, $) => {
  const acc = $.variable(i32, 1);
  $.while(i32.gt_s(n, i32.const(1)), ($) => {
    acc.set(i32.mul(acc, n));
    n.set(i32.sub(n, i32.const(1)));
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

Working: functions (declare/body/import/export, forward decls, mutual
recursion), the full Wasm 2.0 numeric instruction set, module and function
variables (globals/locals with slot reuse), auto-bound multi-use expressions,
multi-value returns with destructuring, basic memory load/store, start
function, `$.switch`, `$.unreachable`, debug-mode creation traces.

Not yet (see the deferred list in DESIGN.md — API to be designed first):
tables/`call_indirect`, reference types, data segments and sized memory ops,
SIMD, `select`, custom sections. Irreducible control flow is detected and
rejected rather than lowered.

## Development

```sh
npm test
```

## License

MIT
