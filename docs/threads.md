# Threads and atomics

[← Manual index](index.md) · *WebAssembly proposal: threads (phase 4,
shipped everywhere relevant — Node ≥ 16, all modern browsers; browsers
additionally require cross-origin isolation for `SharedArrayBuffer`).*

Shared linear memories plus sequentially-consistent atomic operations:
multiple instances (one per thread) address the same bytes, and the atomic
family makes that safe — reads/writes that can't tear, read-modify-writes
that never lose updates, and futex-style `wait`/`notify` for blocking
coordination.

## Shared memories

`mod.memory({ min, max, shared: true })` — a shared memory **requires**
`max` (eagerly checked). On the JS side it surfaces as a
`SharedArrayBuffer`; to span threads, create one `WebAssembly.Memory` with
`shared: true`, [import it](module.md#imports-and-exports) into an instance
per worker, and hand the memory object across `worker_threads` /
`postMessage` boundaries.

## Atomic accesses

The `atomic_` family lives on the integer namespaces beside the
[ordinary loads/stores](memory.md#loads-and-stores), with the same
`(mem, addr, …)` shape. Two differences: alignment must be natural (the
`align` option is rejected — `{ offset }` still works), and misaligned
addresses trap at run time.

- `t.atomic_load(mem, addr)` / `t.atomic_store(mem, addr, v)` — full width,
  both signednesses. Sized forms are zero-extending and therefore
  unsigned-only (`u32.atomic_load8`, `u64.atomic_store32`, …), following the
  [sized-load signedness rule](memory.md#loads-and-stores).
- RMW — `atomic_add`, `atomic_sub`, `atomic_and`, `atomic_or`, `atomic_xor`,
  `atomic_xchg` — each returns the **old** value; sized unsigned variants
  append the width (`u32.atomic_add16`).
- `t.atomic_cmpxchg(mem, addr, expected, replacement)` — swaps only when the
  cell holds `expected`; always returns the old value.

```js
import { Module, s32, u32 } from "wasmloom";

const mod = new Module();
const mem = mod.memory({ min: 1, max: 1, shared: true }).export("mem");
// a classic spinlock over cell 0
mod.function([], []).export("lock").body(($) => {
  const spin = $.label();
  $.gotoIf(u32.ne(u32.atomic_cmpxchg(mem, s32.const(0), u32.const(0), u32.const(1)), u32.const(0)), spin);
  $.return();
});
mod.function([], []).export("unlock").body(($) => {
  u32.atomic_store(mem, s32.const(0), u32.const(0));
  $.return();
});
const { instance } = await WebAssembly.instantiate(mod.emit());
instance.exports.lock();
if (new Uint32Array(instance.exports.mem.buffer)[0] !== 1) throw new Error("unexpected");
instance.exports.unlock();
```

## wait, notify, fence

Blocking coordination lives on the [memory handle](memory.md), beside the
bulk family:

- `mem.wait32(addr, expected, timeoutNs)` / `mem.wait64(…)` — block while
  the cell holds `expected`; `u32` result: 0 woken, 1 value mismatch,
  2 timed out. Negative timeout waits forever. (Engines forbid blocking on
  some threads — browser main threads — where wait traps.)
- `mem.notify(addr, count)` — wake up to `count` waiters; returns the number
  woken as `u32`.
- `$.fence()` — a bare statement ordering memory effects without touching
  memory, beside [`$.unreachable`](control-flow.md#returning-and-trapping).

Atomics also validate and run on unshared memories (single-threaded
programs can share code paths with threaded ones).

## See also

- [Memory](memory.md) — the plain access family and bulk operations;
  [multiple memories](multi-memory.md) compose with shared ones.
- The test suite's contention test — two workers, one counter, 400k atomic
  increments, exact result — is the executable version of this page's claims
  (`test/atomics.test.js`).
