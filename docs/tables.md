# Tables and references

[← Manual index](index.md)

wasm 2.0's reference types are deliberately opaque: `funcref` (a function
reference) and `externref` (an embedder value). They live in variables,
parameters, results, and tables — never in linear memory — and support only
`null`, `is_null`, `select`, and table storage. Neither
[promotion](types.md#safe-value-exact-promotion-default) nor
[permissive mode](module.md#permissive) touches them.
(wasm 3.0 adds precisely-typed function references —
[their own section](typed-funcref.md).)

- `funcref.null()` / `externref.null()` — null constants (valid in
  [initializers](module.md#module-variables-wasm-globals)).
- `funcref.is_null(x)` / `externref.is_null(x)` → [`bool`](types.md).
- `fn.ref()` — a reference to a declared function
  ([Functions](functions.md#function-references)).

## Tables

`mod.table(elemType, { min, max? })` declares a table of `funcref`,
`externref`, or a [typed reference](typed-funcref.md#typed-tables). Handles
chain `.import()`/`.export()` like everything else. Operations:

- `tbl.get(index)` / `tbl.set(index, value)`
- `tbl.size()` → `u32`; `tbl.grow(delta, init?)` → `u32` old size or 2³²−1
  (init defaults to null)
- `tbl.fill(start, value, len)`,
  `tbl.copy(dst, src, len, opts?)` (`opts.from`: another table, same element
  type), `tbl.init(seg, dst, srcOffset, len)`, `seg.drop()`

## call_indirect

`tbl.call(sig, index, ...args)` calls through a `funcref` table with a
[signature handle](functions.md#signatures-modfunctype) — the classic
dynamic-dispatch primitive. The engine checks the callee's signature at run
time and traps on mismatch or null. (Typed-reference tables
[skip that check](typed-funcref.md#typed-tables).)

```js
import { Module, s32, funcref } from "wasmloom";

const mod = new Module();
const sig = mod.funcType([s32], [s32]);
const dbl = mod.function([s32], [s32]).body((x, $) => $.return(s32.mul(x, s32.const(2))));
const neg = mod.function([s32], [s32]).body((x, $) => $.return(s32.sub(s32.const(0), x)));

const tbl = mod.table(funcref, { min: 2 });
mod.elem([dbl, neg]).at(tbl, 0);

mod.function([s32, s32], [s32]).export("dispatch").body((i, x, $) => {
  $.return(tbl.call(sig, i, x)); // indices take either 32-bit signedness
});

const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.dispatch(0, 21) !== 42) throw new Error("unexpected");
if (instance.exports.dispatch(1, 21) !== -21) throw new Error("unexpected");
```

## Element segments

`mod.elem([fn, null, ...])` declares a segment of function handles (`null`
for holes). Passive by default (used via `tbl.init`); `.at(table, offset)`
makes it active. Offsets follow the same
[constant-expression grammar](extended-const.md#segment-offsets) as data
segments. Functions referenced by `fn.ref()` anywhere are automatically
covered by a hidden declarative segment, as the spec requires.

## Runtime interop

At the JS boundary, `funcref` values surface as exported-function objects (or
`null`), and `externref` as arbitrary JS values. Both cross freely through
exported/imported function signatures, imported globals, and exported tables.
