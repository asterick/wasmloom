# Fixed-width SIMD

[← Manual index](index.md) · *WebAssembly proposal: fixed-width 128-bit SIMD
(part of the 2.0 spec; supported by every modern engine).*

The full 236-instruction `v128` surface, expressed through wasmloom's
[signedness-first discipline](types.md) extended lane-wise. All SIMD types
share one 128-bit storage; each is a *view* declaring lane width and
signedness.

| lanes | signed | unsigned | float | mask |
|---|---|---|---|---|
| 16 × 8-bit | `s8x16` | `u8x16` | — | `m8x16` |
| 8 × 16-bit | `s16x8` | `u16x8` | — | `m16x8` |
| 4 × 32-bit | `s32x4` | `u32x4` | `f32x4` | `m32x4` |
| 2 × 64-bit | `s64x2` | `u64x2` | `f64x2` | `m64x2` |

As with scalars, the namespace picks the instruction: `u8x16.shr` emits
`i8x16.shr_u`, `s8x16.extract` sign-extends where `u8x16.extract`
zero-extends, and the widening families follow the namespace
(`u32x4.extend_low` takes a `u16x8`).

```js
import { Module, s32, s32x4 } from "wasmloom";

const mod = new Module();
const mem = mod.memory({ min: 1 }).export("mem");
// clamp four lanes to ≤ limit, branchlessly
mod.function([s32], []).export("clamp4").body((limit, $) => {
  const v = s32x4.load(mem, s32.const(0));
  const lim = s32x4.splat(limit);
  s32x4.store(mem, s32.const(0), s32x4.bitselect(lim, v, s32x4.gt(v, lim)));
  $.return();
});
const { instance } = await WebAssembly.instantiate(mod.emit());
const words = new Int32Array(instance.exports.mem.buffer);
words.set([5, 500, -7, 101]);
instance.exports.clamp4(100);
if (String(words.slice(0, 4)) !== "5,100,-7,100") throw new Error("unexpected");
```

## Masks are the SIMD `bool`

Lane comparisons (`eq`/`ne`/`lt`/`gt`/`le`/`ge`) produce **mask types**
(`m8x16`…`m64x2`) — each lane all-ones or all-zeros — mirroring how scalar
comparisons produce [`bool`](types.md#bool-is-a-barrier). Masks are neither
data nor conditions:

- `T.bitselect(a, b, mask)` requires a **shape-matched** mask
  (`f32x4.bitselect` wants `m32x4`).
- `m.any_true(x)` / `m.all_true(x)` → `bool` — the bridges into
  [control flow](control-flow.md).
- `m.bitmask(x)` → `u32` — one bit per lane.
- Masks compose with `and`/`or`/`xor`/`not`/`andnot`.

```js
import { Module, f32, bool, f32x4, m32x4 } from "wasmloom";

const mod = new Module();
mod.function([f32, f32], [bool]).export("allInRange").body((lo, hi, $) => {
  const v = f32x4.const([1, 2, 3, 4]);
  const ok = m32x4.and(f32x4.ge(v, f32x4.splat(lo)), f32x4.le(v, f32x4.splat(hi)));
  $.return(m32x4.all_true(ok));
});
const { instance } = await WebAssembly.instantiate(mod.emit());
if (instance.exports.allInRange(0, 5) !== 1) throw new Error("unexpected");
if (instance.exports.allInRange(2, 5) !== 0) throw new Error("unexpected");
```

## Casts are the only bridge

Every v128 view retypes into every other with `cast` — free, since
reinterpretation is a no-op at the storage level: `u32x4.cast(mask)` turns a
mask into data, `f32x4.cast(bits)` re-views integer lanes as floats.
[Promotion](types.md#safe-value-exact-promotion-default) deliberately never
touches vectors: no lane shape is value-exact in another.

## Constructing and inspecting

- `T.const([...lanes])` — range-checked per lane signedness; `BigInt` for
  64-bit lanes; masks have no consts (make one by comparing).
- `T.splat(scalar)` — all lanes from the matching scalar type.
- `T.extract(v, lane)` / `T.replace(v, lane, scalar)` — lane index is a
  JS-number immediate, range-checked eagerly.
- `s8x16.shuffle(a, b, [...16 indices 0–31])` — byte shuffle across two
  vectors (immediate pattern); `swizzle(a, indices)` — dynamic byte select.

## Arithmetic families

Beyond lane-wise `add`/`sub`/`mul`(16-bit+)/`neg`/`abs`(signed)/`min`/`max`
(≤32-bit)/`shl`/`shr` and float `div`/`sqrt`/rounding/`pmin`/`pmax`:
saturating `add_sat`/`sub_sat` (8/16-bit), `avgr` (unsigned 8/16),
`q15mulr_sat` (`s16x8`), `dot` (`s32x4` ← two `s16x8`), `popcnt` (8-bit),
and the widening families `extend_low/high`, `extadd_pairwise`,
`extmul_low/high`, `narrow` (saturating), plus conversions
`trunc_sat`/`trunc_sat_zero`, `convert`/`convert_low`,
`demote_zero`/`promote_low`.

## Memory

All ten data namespaces load and store through
[memory handles](memory.md): `load`/`store` (full 16 bytes), `load_splat`,
`load_zero` (32/64-bit lanes), widening loads (`s16x8.load8x8`,
`s32x4.load16x4`, `s64x2.load32x2` — signedness from the namespace), and
`load_lane`/`store_lane` with a lane immediate. All take the usual
`{ offset, align }` options.

## The JS boundary

`v128` values cannot cross into JavaScript — exported/imported signatures
must stay scalar. Move vectors through [linear memory](memory.md) (that's
also how wasmloom's own 9k-case SIMD sweep verifies every instruction).
[Variables](expressions.md#variables) and
[module variables](module.md#module-variables-wasm-globals) hold vectors
fine (`mod.variable(s32x4, [1, 2, 3, 4])`).
