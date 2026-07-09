# Types and promotion

[← Manual index](index.md)

wasm has four numeric storage types (`i32`, `i64`, `f32`, `f64`) and leaves
signedness to each instruction. wasmemit inverts that: **signedness lives in
the type**, and the type picks the instruction.

| wasmemit type | wasm storage | notes |
|---|---|---|
| `s32`, `u32` | `i32` | signed/unsigned 32-bit views |
| `s64`, `u64` | `i64` | signed/unsigned 64-bit views; JS side is `BigInt` |
| `f32`, `f64` | `f32`, `f64` | floats |
| `bool` | `i32` | first-class truth: values provably 0/1 |
| `funcref`, `externref` | — | [references](tables.md); typed forms in [Typed function references](typed-funcref.md) |
| `s8x16` … `m64x2` | `v128` | [SIMD lanes and masks](simd.md) |

Types double as **instruction namespaces**: `s32.add`, `u32.div`, `f64.sqrt`,
`s64.load(mem, addr)`. Suffix-less names select the right wasm variant —
`u32.div` emits `i32.div_u`, `s32.shr` emits `i32.shr_s`, `u32.load8` emits
`i32.load8_u`. Conversions dispatch on their operand: `f64.convert(x)` picks
`f64.convert_i32_s`, `_i32_u`, `_i64_s`, or `_i64_u` from `x`'s type.

## Constants

- `s32.const(v)` / `u32.const(v)` — integers, range-checked per signedness
  (`s32`: [−2³¹, 2³¹), `u32`: [0, 2³²)).
- `s64.const(v)` / `u64.const(v)` — `BigInt` always; plain numbers accepted
  only when `Number.isSafeInteger`.
- `f32.const(v)` / `f64.const(v)` — any number; `f32` rounds to float32.
- `bool.const(true | false)`.

## `bool` is a barrier

Comparisons (`eq`, `ne`, `lt`, `gt`, `le`, `ge`, `eqz`) produce `bool`.
Conditions — `$.if`, `$.gotoIf`, `$.while`, `select` — **require** `bool`.
The bridge from integers is explicit: `bool.of(x)` means "x ≠ 0". `bool`
carries its own logic (`and`/`or`/`xor`/`not`); like `select`, these are
values, not short-circuiting control flow.

```js
import { Module, s32, bool } from "wasmemit";

const mod = new Module();
mod.function([s32, s32], [s32]).export("both").body((a, b, $) => {
  // "both non-zero": bool.of bridges each integer, bool.and combines
  $.return(s32.select(bool.and(bool.of(a), bool.of(b)), s32.const(1), s32.const(0)));
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.both(2, 3) !== 1 || instance.exports.both(2, 0) !== 0) {
  throw new Error("unexpected");
}
```

## Safe value-exact promotion (default)

Operands lift automatically into an op's namespace type when the value fits
**exactly** — the namespace names the target explicitly, so nothing implicit
is being guessed:

| target | accepts (besides itself) |
|---|---|
| `s64` | `s32`, `u32`, `bool` |
| `u64` | `u32`, `bool` |
| `f64` | `f32`, `s32`, `u32`, `bool` |
| `f32` | `bool` |
| `s32`, `u32` | `bool` |

So `f64.add(x_f32, y_s32)` and `s64.mul(a_s64, b_s32)` just work. Lossy or
narrowing moves (`s64`→`f64`, `s32`→`f32`, `u32`→`s32`, float→int) are always
errors — reach for the explicit conversions (`trunc`, `trunc_sat`, `wrap`,
`demote`, `convert`) or casts. The same mechanism models reference upcasts in
[Typed function references](typed-funcref.md#promotion), and does **not**
apply to [SIMD types](simd.md#casts-are-the-only-bridge).

## Casts: zero-cost retypes

`t.cast(x)` re-views the same bits as another type of the same storage width —
no instruction is emitted:

- `s32.cast(u32 | bool)`, `u32.cast(s32 | bool)`, `s64.cast(u64)`, `u64.cast(s64)`.
- Every [v128 view casts to every other](simd.md#casts-are-the-only-bridge).
- There is deliberately no int→`bool` cast (values wouldn't be provably 0/1);
  use `bool.of`.

## Conversions (real instructions)

Each numeric namespace carries operand-driven conversions: `wrap` (64→32),
`extend` (32→64, signedness from the namespace), `trunc` / `trunc_sat`
(float→int, trapping / saturating), `convert` (int→float), `demote` /
`promote` (float widths), `reinterpret` (bitwise across int/float), and
in-place sign extension `extend8`/`extend16`/`extend32`.

## Permissive mode

`new Module({ permissive: true })` ([Module options](module.md#permissive))
relaxes two barriers *within a storage width*: integer conditions get an
implicit ≠0 test, and mixed-signedness operands retype freely. It never
crosses widths, never touches references or SIMD, and is intentionally not
the default — the strict barriers catch real bugs.
