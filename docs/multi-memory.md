# Multiple memories

[← Manual index](index.md) · *WebAssembly proposal: multi-memory (wasm 3.0).
Emitted modules need Node ≥ 22 / Chrome ≥ 120 / Firefox ≥ 125 — only when a module actually
declares more than one memory.*

Declare as many memories as you like — because every wasmloom
[load/store takes its memory handle explicitly](memory.md), multi-memory adds
**no new API**. The handle routes each access; imported memories index before
defined ones, and single-memory modules encode byte-identically to how they
always did.

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const heap = mod.memory({ min: 1 }).export("heap");
const scratch = mod.memory({ min: 1 }).export("scratch");

mod.function([s32], []).export("run").body((x, $) => {
  s32.store(heap, s32.const(0), x);
  s32.store(scratch, s32.const(0), s32.mul(x, s32.const(2)));
  $.return();
});

const { instance } = await WebAssembly.instantiate(mod.emit());
instance.exports.run(21);
if (new Int32Array(instance.exports.heap.buffer)[0] !== 21) throw new Error("unexpected");
if (new Int32Array(instance.exports.scratch.buffer)[0] !== 42) throw new Error("unexpected");
```

Everything memory-shaped is per-handle: [SIMD accesses](simd.md#memory),
[bulk operations](memory.md#bulk-operations-on-the-memory-handle), sizes and
grows, and [data segments](memory.md#data-segments) — `.at(scratch, 16)`
targets whichever memory you name.

## Cross-memory copy

`mem.copy` gains an option, mirroring `tbl.copy`: the receiver is the
**destination**, `opts.from` names the source memory.

```js
import { Module, s32 } from "wasmloom";

const mod = new Module();
const a = mod.memory({ min: 1 }).export("a");
const b = mod.memory({ min: 1 }).export("b");
mod.function([], []).export("stage").body(($) => {
  a.fill(s32.const(0), s32.const(7), s32.const(4));
  b.copy(s32.const(64), s32.const(0), s32.const(4), { from: a }); // a → b
  $.return();
});
const { instance } = await WebAssembly.instantiate(mod.emit());
instance.exports.stage();
const bytes = new Uint8Array(instance.exports.b.buffer);
if (String(bytes.slice(64, 68)) !== "7,7,7,7") throw new Error("unexpected");
```

Handles are module-scoped as always — passing another module's memory (as an
operand or as `from`) is an eager error.

## Encoding notes

Memory 0 keeps the classic unflagged encodings. Nonzero indices use the
flag-bit `memarg` form on loads/stores, explicit index immediates on
`size`/`grow`/`fill`/`init`, destination+source pairs on `copy`, and the
explicit-memory-index flavor for active data segments — all invisible at the
API level.
