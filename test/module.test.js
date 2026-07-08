import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, s64, u64, f64 } from "../src/index.js";

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("imported function is callable", async () => {
  const mod = new Module();
  const log = mod.function([s32], []).import("env", "log");
  const double = mod.function([s32], [s32]).import("env", "double");
  mod.function([s32], [s32]).export("run").body((x, $) => {
    log.call(x); // zero results → statement
    $.return(double.call(x));
  });

  const seen = [];
  const { exports } = await instantiate(mod, {
    env: { log: (v) => seen.push(v), double: (v) => v * 2 },
  });
  assert.equal(exports.run(21), 42);
  assert.deepEqual(seen, [21]);
});

test("re-exporting an import", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).import("env", "id").export("id");
  const { exports } = await instantiate(mod, { env: { id: (v) => v } });
  assert.equal(exports.id(7), 7);
});

test("module variables: init, mutation, export", async () => {
  const mod = new Module();
  const counter = mod.variable(s32, 10).export("counter");
  mod.function([], [s32]).export("bump").body(($) => {
    counter.set(s32.add(counter, s32.const(1)));
    $.return(counter);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.counter.value, 10);
  assert.equal(exports.bump(), 11);
  assert.equal(exports.bump(), 12);
  assert.equal(exports.counter.value, 12);
});

test("module variable zero-init default and s64", async () => {
  const mod = new Module();
  const acc = mod.variable(s64).export("acc");
  mod.function([s64], []).export("add").body((v, $) => {
    acc.set(s64.add(acc, v));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.acc.value, 0n);
  exports.add(5n);
  assert.equal(exports.acc.value, 5n);
});

test("imported immutable variable used in another initializer", async () => {
  const mod = new Module();
  const base = mod.variable(s32).import("env", "base").immutable();
  const derived = mod.variable(s32, base).export("derived");
  mod.function([], [s32]).export("get").body(($) => {
    $.return(s32.add(base, derived));
  });
  const { exports } = await instantiate(mod, {
    env: { base: new WebAssembly.Global({ value: "i32" }, 100) }, // JS API name
  });
  assert.equal(exports.get(), 200);
});

test("memory: store and load round-trip", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([s32, s32], []).export("poke").body((addr, val, $) => {
    s32.store(mem, addr, val);
  });
  mod.function([s32], [s32]).export("peek").body((addr, $) => {
    $.return(s32.load(mem, addr));
  });
  mod.function([s32], [f64]).export("peekf").body((addr, $) => {
    $.return(f64.load(mem, addr, { offset: 8 }));
  });
  const { exports } = await instantiate(mod);
  exports.poke(4, 0xdeadbeef | 0);
  assert.equal(exports.peek(4), 0xdeadbeef | 0);
  new DataView(exports.memory.buffer).setFloat64(16, 2.5, true);
  assert.equal(exports.peekf(8), 2.5);
});

test("imported memory", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).import("env", "memory");
  mod.function([s32], [s32]).export("peek").body((addr, $) => {
    $.return(s32.load(mem, addr));
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  new DataView(memory.buffer).setInt32(0, 1234, true);
  const { exports } = await instantiate(mod, { env: { memory } });
  assert.equal(exports.peek(0), 1234);
});

test("start function runs at instantiation", async () => {
  const mod = new Module();
  const flag = mod.variable(s32).export("flag");
  const init = mod.function([], []).body(($) => {
    flag.set(s32.const(99));
  });
  mod.start(init);
  const { exports } = await instantiate(mod);
  assert.equal(exports.flag.value, 99);
});

test("multi-value results destructure", async () => {
  const mod = new Module();
  const divmod = mod.function([s32, s32], [s32, s32]).export("divmod").body((a, b, $) => {
    $.return(s32.div(a, b), s32.rem(a, b));
  });
  mod.function([s32, s32], [s32]).export("recombine").body((a, b, $) => {
    const [q, r] = divmod.call(a, b);
    $.return(s32.add(s32.mul(q, b), r));
  });
  const { exports } = await instantiate(mod);
  assert.deepEqual(exports.divmod(17, 5), [3, 2]);
  assert.equal(exports.recombine(17, 5), 17);
});

test("export aliases", async () => {
  const mod = new Module();
  mod.function([], [s32]).export("a").export("b").body(($) => {
    $.return(s32.const(1));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.a(), 1);
  assert.equal(exports.b(), 1);
});

test("declaration order is unconstrained (imports emitted first)", async () => {
  const mod = new Module();
  // defined before the import is declared
  const f = mod.function([], [s32]).export("f");
  const ext = mod.function([], [s32]).import("env", "ext");
  f.body(($) => {
    $.return(s32.add(ext.call(), s32.const(1)));
  });
  const { exports } = await instantiate(mod, { env: { ext: () => 10 } });
  assert.equal(exports.f(), 11);
});

test("an imported function can be the start function", async () => {
  const mod = new Module();
  const init = mod.function([], []).import("env", "init");
  mod.start(init);
  let ran = 0;
  await instantiate(mod, { env: { init: () => ran++ } });
  assert.equal(ran, 1);
});

test("f32.const rounds doubles to float32", async () => {
  const mod = new Module();
  const { f32 } = await import("../src/index.js");
  mod.function([], [f32]).export("f").body(($) => {
    $.return(f32.const(0.1));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), Math.fround(0.1));
  assert.notEqual(exports.f(), 0.1);
});

test("u64 max reads back as signed at the JS boundary", async () => {
  const mod = new Module();
  mod.function([], [u64]).export("f").body(($) => {
    $.return(u64.const(2n ** 64n - 1n));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), -1n);
});

test("load/store offsets are applied", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([s32, s32], []).export("poke").body((addr, val, $) => {
    s32.store(mem, addr, val, { offset: 65500 });
  });
  mod.function([s32], [s32]).export("peek").body((addr, $) => {
    $.return(s32.load(mem, addr, { offset: 65500 }));
  });
  const { exports } = await instantiate(mod);
  exports.poke(0, 777);
  assert.equal(exports.peek(0), 777);
  assert.equal(new DataView(exports.memory.buffer).getInt32(65500, true), 777);
  // out-of-page-bounds traps
  assert.throws(() => exports.poke(100, 1), WebAssembly.RuntimeError);
});
