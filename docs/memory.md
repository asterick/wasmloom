# Memory

[← Manual index](index.md)

`mod.memory({ min, max? })` declares a linear memory (limits in 64 KiB
pages). Loads and stores take the memory handle explicitly, so code reads the
same whether a module has one memory or [several](multi-memory.md).

```js
import { Module, s32, u32 } from "wasmemit";

const mod = new Module();
const mem = mod.memory({ min: 1 }).export("mem");
mod.function([s32, s32], []).export("put").body((addr, v, $) => {
  s32.store(mem, addr, v);
  $.return();
});
mod.function([s32], [u32]).export("getByte").body((addr, $) => {
  $.return(u32.load8(mem, addr)); // zero-extends: signedness from the type
});
const { instance } = await WebAssembly.instantiate(mod.emit());
instance.exports.put(4, -1);
if (instance.exports.getByte(4) !== 255) throw new Error("unexpected");
```

## Loads and stores

On every numeric namespace ([SIMD forms](simd.md#memory) included):

- `t.load(mem, addr, opts?)` / `t.store(mem, addr, value, opts?)` — full width.
- Sized integer variants: `load8`/`load16` (+ `load32` on 64-bit types) and
  `store8`/`store16` (+ `store32`). **Extension signedness comes from the
  type** — `u32.load8` zero-extends, `s32.load8` sign-extends; stores
  truncate and exist on both signednesses.
- `opts`: `{ offset }` (constant byte offset ≥ 0) and `{ align }` (power of
  two ≤ the access size; defaults to the natural alignment).
- Addresses accept either 32-bit signedness (and `bool`).

## Bulk operations (on the memory handle)

- `mem.size()` → `u32` pages; `mem.grow(delta)` → `u32` old size, or 2³²−1 on
  failure (an expression — consume or `$.drop` it).
- `mem.fill(dst, byteValue, len)` — statement.
- `mem.copy(dst, src, len, opts?)` — statement; `opts.from` copies from
  [another memory](multi-memory.md#cross-memory-copy).
- `mem.init(seg, dst, srcOffset, len)` / `seg.drop()` — copy from / release a
  passive data segment.

## Data segments

`mod.data(bytes)` (a `Uint8Array` or `ArrayBuffer`, copied at declaration)
returns a segment handle. Segments are **passive** by default — runtime
material for `mem.init`. Chain `.at(mem, offset)` to make one **active**
(copied into `mem` at instantiation). The offset is an integer, an
`s32`/`u32` const, an imported immutable module variable, or
[constant arithmetic](extended-const.md#segment-offsets) over those:

```js
import { Module, s32 } from "wasmemit";

const mod = new Module();
const mem = mod.memory({ min: 1 }).export("mem");
mod.data(new Uint8Array([104, 105])).at(mem, 16); // "hi", copied at instantiation
const table9 = mod.data(new Uint8Array(Array.from({ length: 10 }, (_, i) => i * 9)));

mod.function([], []).export("setup").body(($) => {
  mem.init(table9, s32.const(32), s32.const(0), s32.const(10));
  table9.drop();
  $.return();
});

const { instance } = await WebAssembly.instantiate(mod.emit());
const bytes = new Uint8Array(instance.exports.mem.buffer);
if (bytes[16] !== 104 || bytes[17] !== 105) throw new Error("active segment missing");
instance.exports.setup();
if (bytes[32 + 7] !== 63) throw new Error("init missing");
```

The data-count section is emitted automatically whenever segments exist.

## See also

- [Multiple memories](multi-memory.md) — any number of memories,
  cross-memory copy, index encoding.
- [SIMD memory operations](simd.md#memory) — `v128` loads/stores, lane and
  splat/zero-extending forms.
