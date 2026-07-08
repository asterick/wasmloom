import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, i32, i64, f64 } from "../src/index.js";

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("imported function is callable", async () => {
  const mod = new Module();
  const log = mod.function([i32], []).import("env", "log");
  const double = mod.function([i32], [i32]).import("env", "double");
  mod.function([i32], [i32]).export("run").body((x, $) => {
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
  mod.function([i32], [i32]).import("env", "id").export("id");
  const { exports } = await instantiate(mod, { env: { id: (v) => v } });
  assert.equal(exports.id(7), 7);
});

test("module variables: init, mutation, export", async () => {
  const mod = new Module();
  const counter = mod.variable(i32, 10).export("counter");
  mod.function([], [i32]).export("bump").body(($) => {
    counter.set(i32.add(counter, i32.const(1)));
    $.return(counter);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.counter.value, 10);
  assert.equal(exports.bump(), 11);
  assert.equal(exports.bump(), 12);
  assert.equal(exports.counter.value, 12);
});

test("module variable zero-init default and i64", async () => {
  const mod = new Module();
  const acc = mod.variable(i64).export("acc");
  mod.function([i64], []).export("add").body((v, $) => {
    acc.set(i64.add(acc, v));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.acc.value, 0n);
  exports.add(5n);
  assert.equal(exports.acc.value, 5n);
});

test("imported immutable variable used in another initializer", async () => {
  const mod = new Module();
  const base = mod.variable(i32).import("env", "base").immutable();
  const derived = mod.variable(i32, base).export("derived");
  mod.function([], [i32]).export("get").body(($) => {
    $.return(i32.add(base, derived));
  });
  const { exports } = await instantiate(mod, {
    env: { base: new WebAssembly.Global({ value: "i32" }, 100) },
  });
  assert.equal(exports.get(), 200);
});

test("memory: store and load round-trip", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([i32, i32], []).export("poke").body((addr, val, $) => {
    i32.store(mem, addr, val);
  });
  mod.function([i32], [i32]).export("peek").body((addr, $) => {
    $.return(i32.load(mem, addr));
  });
  mod.function([i32], [f64]).export("peekf").body((addr, $) => {
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
  mod.function([i32], [i32]).export("peek").body((addr, $) => {
    $.return(i32.load(mem, addr));
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  new DataView(memory.buffer).setInt32(0, 1234, true);
  const { exports } = await instantiate(mod, { env: { memory } });
  assert.equal(exports.peek(0), 1234);
});

test("start function runs at instantiation", async () => {
  const mod = new Module();
  const flag = mod.variable(i32).export("flag");
  const init = mod.function([], []).body(($) => {
    flag.set(i32.const(99));
  });
  mod.start(init);
  const { exports } = await instantiate(mod);
  assert.equal(exports.flag.value, 99);
});

test("multi-value results destructure", async () => {
  const mod = new Module();
  const divmod = mod.function([i32, i32], [i32, i32]).export("divmod").body((a, b, $) => {
    $.return(i32.div_s(a, b), i32.rem_s(a, b));
  });
  mod.function([i32, i32], [i32]).export("recombine").body((a, b, $) => {
    const [q, r] = divmod.call(a, b);
    $.return(i32.add(i32.mul(q, b), r));
  });
  const { exports } = await instantiate(mod);
  assert.deepEqual(exports.divmod(17, 5), [3, 2]);
  assert.equal(exports.recombine(17, 5), 17);
});

test("export aliases", async () => {
  const mod = new Module();
  mod.function([], [i32]).export("a").export("b").body(($) => {
    $.return(i32.const(1));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.a(), 1);
  assert.equal(exports.b(), 1);
});

test("declaration order is unconstrained (imports emitted first)", async () => {
  const mod = new Module();
  // defined before the import is declared
  const f = mod.function([], [i32]).export("f");
  const ext = mod.function([], [i32]).import("env", "ext");
  f.body(($) => {
    $.return(i32.add(ext.call(), i32.const(1)));
  });
  const { exports } = await instantiate(mod, { env: { ext: () => 10 } });
  assert.equal(exports.f(), 11);
});
