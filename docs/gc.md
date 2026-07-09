# Garbage collection

[← Manual index](index.md) · *WebAssembly proposal: garbage collection
(wasm 3.0). Needs Node ≥ 22 / Chrome ≥ 119 — only when a module declares GC
types.*

Engine-managed heap objects: **struct** types with named, ordered fields and
**array** types, declared as module entities with the familiar handle shape —
`.ref`/`.refNull` types like [signatures](typed-funcref.md), operations owned
by the type handle. Fields are mutable by default; wrap one in `imm(type)` to
lock it, and use `i8`/`i16` for packed storage.

```js
import { Module, s32, f64, imm } from "wasmloom";

const mod = new Module();
const Point = mod.struct({ x: f64, y: f64, id: imm(s32) });

mod.function([s32], [f64]).export("f").body((id, $) => {
  const p = $.variable(Point.ref, Point.new(f64.const(3), f64.const(4), id));
  Point.set(p, "x", f64.const(30));
  $.return(f64.add(Point.get(p, "x"), Point.get(p, "y")));
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.f(7) !== 34) throw new Error("unexpected");
```

`Struct.new(...)` takes values in field order; `.get`/`.set` go by name
(eagerly validated; writes to `imm` fields are eager errors). Packed fields
read via `.getS`/`.getU` — [signedness discipline](types.md), lane-style.

## Arrays

`mod.array(elementSpec)` — `new(len, init?)` (init optional when the element
is defaultable), `newFixed(...values)`, `get`/`getS`/`getU`, `set`, `len`,
`fill`, `copy`, and the segment-backed forms `newData(seg, off, len)` /
`initData(a, dstOff, seg, srcOff, len)` for materializing byte tables from
[data segments](memory.md#data-segments) without per-element stores.

## Recursion: declare, then define

Self- and mutually-referential types use the same declare-then-define pattern
as [function bodies](functions.md#declaring); recursion groups are emitted
automatically:

```js
import { Module, s32, bool } from "wasmloom";

const mod = new Module();
const Node = mod.struct();
Node.fields({ value: s32, next: Node.refNull });

mod.function([], [s32]).export("sum").body(($) => {
  const list = $.variable(Node.refNull, Node.new(s32.const(1), Node.new(s32.const(2), Node.refNull.null())));
  const acc = $.variable(s32);
  $.while(bool.not(Node.refNull.is_null(list)), ($) => {
    const n = $.variable(Node.ref, Node.ref.of(list));
    acc.set(s32.add(acc, Node.get(n, "value")));
    list.set(Node.get(n, "next"));
  });
  $.return(acc);
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.sum() !== 3) throw new Error("unexpected");
```

One identity subtlety handled for you: wasm's type identity is structural
(iso-recursive), which would silently unify same-shaped types declared
separately. wasmloom emits all GC types in one shared recursion group, so
**declared types stay nominally distinct** — a `Circle.test` never matches a
same-shaped `Square`. (Corollary: type identity is per-module; two modules
sharing GC values should get their types from imports/exports of functions
that produce them.)

## Subtyping and casts

`mod.struct(fields, { extends: Base })` declares a supertype (the fields must
repeat the base's exactly, then extend — eagerly checked). Upcasts are
[promotions](types.md#safe-value-exact-promotion-default): a `Circle.ref`
flows into `Shape.refNull`, `structref`, `eqref`, or `anyref` slots freely.
Coming back down is explicit, in the house vocabulary:

- `T.test(x)` → [`bool`](types.md#bool-is-a-barrier) — non-trapping probe (`ref.test`);
- `T.ref.of(x)` / `T.refNull.of(x)` — checked, **trapping** downcast
  (`ref.cast`), same pricing as every `.of` bridge.

The abstract layer — `anyref` ⊃ `eqref` ⊃ `structref`/`arrayref`/`i31ref` —
ships as ordinary types (variables, params, globals), each with
`null()`/`is_null`. `eqref.eq(a, b)` compares reference **identity**.

## i31 and the host boundary

- `i31ref.of(x)` boxes the low 31 bits of an integer without allocating;
  `i31ref.getS`/`getU` unbox with the usual signedness split.
- `anyref.of(externAlias)` / `externref.of(gcValue)` convert between the
  host's [externref](tables.md) world and the GC hierarchy — identity
  preserved both ways.
- GC references cross into JavaScript as opaque values: hand them out and
  take them back, and export accessor functions for inspection.

## See also

- [Typed function references](typed-funcref.md) — the sibling `func`
  hierarchy; both share the handle-owned `.ref`/`.refNull` pattern.
- [Types and promotion](types.md) — where the upcast lattice lives.
