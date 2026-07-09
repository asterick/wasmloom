import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { Module, s32, u32, s64, u64, WasmLoomError } from "../src/index.js";

// Threads and atomics: shared memories, the 0xFE atomic family (loads,
// stores, RMW returning old values, cmpxchg), wait/notify, fence.

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmLoomError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("shared memory exports a SharedArrayBuffer; shared requires max", async () => {
  const mod = new Module();
  mod.memory({ min: 1, max: 4, shared: true }).export("mem");
  mod.function([], []).export("noop").body(($) => $.return());
  const { exports } = await instantiate(mod);
  assert.ok(exports.mem.buffer instanceof SharedArrayBuffer);
  throws(() => new Module().memory({ min: 1, shared: true }), /shared memory requires a max/);
});

test("RMW family returns old values; JS Atomics agrees on final state", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1, max: 1, shared: true }).export("mem");
  const ops = ["add", "sub", "and", "or", "xor", "xchg"];
  for (const op of ops) {
    mod.function([s32, u32], [u32]).export(op).body((a, v, $) => {
      $.return(u32[`atomic_${op}`](mem, a, v));
    });
    mod.function([s32, u64], [u64]).export(`${op}64`).body((a, v, $) => {
      $.return(u64[`atomic_${op}`](mem, a, v));
    });
  }
  const { exports } = await instantiate(mod);
  const view = new Uint32Array(exports.mem.buffer);
  const jsOp = {
    add: (a, b) => a + b, sub: (a, b) => a - b, and: (a, b) => a & b,
    or: (a, b) => a | b, xor: (a, b) => a ^ b, xchg: (_, b) => b,
  };
  for (const op of ops) {
    view[0] = 0x0f0f3355;
    const old = exports[op](0, 0x00ff00aa);
    assert.equal(old >>> 0, 0x0f0f3355, `${op} old value`);
    assert.equal(view[0], (jsOp[op](0x0f0f3355, 0x00ff00aa) & 0xffffffff) >>> 0, `${op} final`);
    // 64-bit flavor
    const v64 = new BigUint64Array(exports.mem.buffer);
    v64[2] = 0x1122334455667788n;
    const old64 = exports[`${op}64`](16, 0x00000000ffffffffn);
    assert.equal(old64, 0x1122334455667788n, `${op}64 old value`);
  }
});

test("cmpxchg: hit swaps, miss leaves and reports", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1, max: 1, shared: true }).export("mem");
  mod.function([s32, u32, u32], [u32]).export("cas").body((a, e, r, $) => {
    $.return(u32.atomic_cmpxchg(mem, a, e, r));
  });
  mod.function([s32, u32, u32], [u32]).export("cas16").body((a, e, r, $) => {
    $.return(u32.atomic_cmpxchg16(mem, a, e, r));
  });
  const { exports } = await instantiate(mod);
  const view = new Uint32Array(exports.mem.buffer);
  view[0] = 42;
  assert.equal(exports.cas(0, 42, 99), 42); // hit: returns old
  assert.equal(view[0], 99);
  assert.equal(exports.cas(0, 42, 7), 99); // miss: returns current
  assert.equal(view[0], 99); // unchanged
  new Uint16Array(exports.mem.buffer)[4] = 5;
  assert.equal(exports.cas16(8, 5, 6), 5);
  assert.equal(new Uint16Array(exports.mem.buffer)[4], 6);
});

test("sized atomics zero-extend; alignment is enforced eagerly and at runtime", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1, max: 1, shared: true }).export("mem");
  mod.function([s32], [u64]).export("l8").body((a, $) => $.return(u64.atomic_load8(mem, a)));
  mod.function([s32, u32], []).export("s16").body((a, v, $) => {
    u32.atomic_store16(mem, a, v);
    $.fence();
    $.return();
  });
  mod.function([s32], [u32]).export("l32").body((a, $) => $.return(u32.atomic_load(mem, a)));
  mod.function([], []).body(($) => {
    throws(() => u32.atomic_load(mem, s32.const(0), { align: 1 }), /natural alignment/);
    $.return();
  });
  const { exports } = await instantiate(mod);
  new Uint8Array(exports.mem.buffer)[3] = 0xff;
  assert.equal(exports.l8(3), 0xffn);
  exports.s16(8, 0x1234abcd); // wraps to 16 bits
  assert.equal(new Uint16Array(exports.mem.buffer)[4], 0xabcd);
  assert.throws(() => exports.l32(2), WebAssembly.RuntimeError); // misaligned traps
});

test("wait/notify: mismatch and timeout codes without blocking", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1, max: 1, shared: true }).export("mem");
  mod.function([s32, s32, s64], [u32]).export("wait32").body((a, e, t, $) => {
    $.return(mem.wait32(a, e, t));
  });
  mod.function([s32], [u32]).export("notify").body((a, $) => {
    $.return(mem.notify(a, u32.const(1)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.wait32(0, 12345, 0n), 1); // memory holds 0, not 12345 → mismatch
  assert.equal(exports.wait32(0, 0, 1000n), 2); // matches, 1µs timeout → timed out
  assert.equal(exports.notify(0), 0); // nobody waiting
});

test("two workers hammer one counter: atomic increments never lose updates", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1, max: 1, shared: true }).import("env", "mem");
  mod.function([s32], []).export("bump").body((n, $) => {
    const i = $.variable(s32);
    $.while(s32.lt(i, n), ($) => {
      $.drop(u32.atomic_add(mem, s32.const(0), u32.const(1)));
      i.set(s32.add(i, s32.const(1)));
    });
    $.return();
  });
  const bytes = mod.emit();
  const shared = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const N = 200_000;

  const workerSrc = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { bytes, shared, n } = workerData;
    WebAssembly.instantiate(bytes, { env: { mem: shared } }).then(({ instance }) => {
      instance.exports.bump(n);
      parentPort.postMessage("done");
    });
  `;
  const run = () =>
    new Promise((resolve, reject) => {
      const w = new Worker(workerSrc, { eval: true, workerData: { bytes, shared, n: N } });
      w.on("message", resolve);
      w.on("error", reject);
    });
  await Promise.all([run(), run()]);
  assert.equal(new Uint32Array(shared.buffer)[0], 2 * N);
});

test("wait blocks a worker until wasm notify wakes it", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1, max: 1, shared: true }).import("env", "mem");
  mod.function([], [u32]).export("waitForGo").body(($) => {
    // wait while [0] == 0, forever; store result code at [4]
    $.return(mem.wait32(s32.const(0), s32.const(0), s64.const(-1n)));
  });
  mod.function([], [u32]).export("go").body(($) => {
    u32.atomic_store(mem, s32.const(0), u32.const(1));
    $.return(mem.notify(s32.const(0), u32.const(10)));
  });
  const bytes = mod.emit();
  const shared = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });

  const workerSrc = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { bytes, shared } = workerData;
    WebAssembly.instantiate(bytes, { env: { mem: shared } }).then(({ instance }) => {
      parentPort.postMessage(instance.exports.waitForGo()); // blocks in wasm
    });
  `;
  const woken = new Promise((resolve, reject) => {
    const w = new Worker(workerSrc, { eval: true, workerData: { bytes, shared } });
    w.on("message", resolve);
    w.on("error", reject);
  });
  const { instance } = await WebAssembly.instantiate(bytes, { env: { mem: shared } });
  // give the worker a moment to reach the wait, then release it
  await new Promise((r) => setTimeout(r, 100));
  const wokenCount = instance.exports.go();
  assert.equal(await woken, 0); // 0 = woken by notify
  assert.ok(wokenCount <= 1);
});

test("atomics validate and run on unshared memory too", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("mem"); // not shared
  mod.function([s32, u32], [u32]).export("add").body((a, v, $) => {
    $.return(u32.atomic_add(mem, a, v));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.add(0, 9), 0);
  assert.equal(new Uint32Array(exports.mem.buffer)[0], 9);
});
