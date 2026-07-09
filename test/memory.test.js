import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, s64x2, WasmEmitError } from "../src/index.js";

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("sized loads: extension signedness comes from the type", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([s32, s32], []).export("poke8").body((addr, v, $) => {
    s32.store8(mem, addr, v);
  });
  mod.function([s32], [s32]).export("s8").body((a, $) => $.return(s32.load8(mem, a)));
  mod.function([s32], [u32]).export("u8").body((a, $) => $.return(u32.load8(mem, a)));
  mod.function([s32], [s32]).export("s16").body((a, $) => $.return(s32.load16(mem, a)));
  mod.function([s32], [u32]).export("u16").body((a, $) => $.return(u32.load16(mem, a)));
  mod.function([s32], [s64]).export("s64_8").body((a, $) => $.return(s64.load8(mem, a)));
  mod.function([s32], [u64]).export("u64_32").body((a, $) => $.return(u64.load32(mem, a)));

  const { exports } = await instantiate(mod);
  exports.poke8(0, 0xff);
  exports.poke8(1, 0xff);
  exports.poke8(2, 0xff);
  exports.poke8(3, 0xff);
  assert.equal(exports.s8(0), -1);
  assert.equal(exports.u8(0), 255);
  assert.equal(exports.s16(0), -1);
  assert.equal(exports.u16(0), 0xffff);
  assert.equal(exports.s64_8(0), -1n);
  assert.equal(exports.u64_32(0), 0xffffffffn);
});

test("sized stores truncate", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([s32], []).export("f").body((v, $) => {
    s32.store(mem, s32.const(0), s32.const(0)); // clear word
    s32.store8(mem, s32.const(0), v);
  });
  mod.function([s64], []).export("g").body((v, $) => {
    s64.store32(mem, s32.const(8), v);
  });
  const { exports } = await instantiate(mod);
  exports.f(0x1234);
  const dv = new DataView(exports.memory.buffer);
  assert.equal(dv.getUint32(0, true), 0x34); // only the low byte
  exports.g(0x1_2345_6789n);
  assert.equal(dv.getUint32(8, true), 0x23456789);
});

test("mem.size() and mem.grow()", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1, max: 2 }).export("memory");
  mod.function([], [u32]).export("size").body(($) => $.return(mem.size()));
  mod.function([u32], [u32]).export("grow").body((d, $) => $.return(mem.grow(d)));
  const { exports } = await instantiate(mod);
  assert.equal(exports.size(), 1);
  assert.equal(exports.grow(1), 1); // old size
  assert.equal(exports.size(), 2);
  assert.equal(exports.grow(1), -1); // failure: u32 max, signed at the JS boundary
});

test("mem.fill() and mem.copy()", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.function([], []).export("run").body(($) => {
    mem.fill(s32.const(0), s32.const(0xab), s32.const(4));
    mem.copy(s32.const(8), s32.const(0), s32.const(4));
  });
  const { exports } = await instantiate(mod);
  exports.run();
  const dv = new DataView(exports.memory.buffer);
  assert.equal(dv.getUint32(0, true), 0xabababab);
  assert.equal(dv.getUint32(8, true), 0xabababab);
});

test("active data segment copied at instantiation", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.data(new Uint8Array([1, 2, 3, 4])).at(mem, 16);
  const { exports } = await instantiate(mod);
  assert.deepEqual([...new Uint8Array(exports.memory.buffer, 16, 4)], [1, 2, 3, 4]);
});

test("active segment offset from an imported immutable variable", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  const base = mod.variable(u32).import("env", "base").immutable();
  mod.data(new Uint8Array([9, 8, 7])).at(mem, base);
  const { exports } = await instantiate(mod, {
    env: { base: new WebAssembly.Global({ value: "i32" }, 32) },
  });
  assert.deepEqual([...new Uint8Array(exports.memory.buffer, 32, 3)], [9, 8, 7]);
});

test("passive segment: mem.init and seg.drop", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  const seg = mod.data(new Uint8Array([10, 20, 30, 40]));
  mod.function([s32], []).export("load").body((dst, $) => {
    mem.init(seg, dst, s32.const(1), s32.const(2)); // bytes [20, 30]
  });
  mod.function([], []).export("release").body(($) => {
    seg.drop();
  });
  const { exports } = await instantiate(mod);
  exports.load(4);
  assert.deepEqual([...new Uint8Array(exports.memory.buffer, 4, 2)], [20, 30]);
  exports.release();
  assert.throws(() => exports.load(8), WebAssembly.RuntimeError); // dropped → traps
});

test("data segment bytes are copied at declaration", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  const src = new Uint8Array([5, 5, 5]);
  mod.data(src).at(mem, 0);
  src[0] = 99; // must not affect the module
  const { exports } = await instantiate(mod);
  assert.equal(new Uint8Array(exports.memory.buffer)[0], 5);
});

test("ArrayBuffer input accepted", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  const buf = new ArrayBuffer(2);
  new Uint8Array(buf).set([7, 11]);
  mod.data(buf).at(mem, 0);
  const { exports } = await instantiate(mod);
  assert.deepEqual([...new Uint8Array(exports.memory.buffer, 0, 2)], [7, 11]);
});

test("data segment input validation", () => {
  const mod = new Module();
  throws(() => mod.data("hello"), /Uint8Array or ArrayBuffer/);
  throws(() => mod.data([1, 2, 3]), /Uint8Array or ArrayBuffer/);
  throws(() => mod.data(null), /Uint8Array or ArrayBuffer/);
});

test("data segment misuse errors", () => {
  const modA = new Module();
  const memA = modA.memory({ min: 1 });
  const segA = modA.data(new Uint8Array([1]));

  throws(() => segA.at(memA, -1), /offset/);
  segA.at(memA, 0);
  throws(() => segA.at(memA, 4), /already active/);

  const modB = new Module();
  const memB = modB.memory({ min: 1 });
  throws(() => modB.data(new Uint8Array([1])).at(memA, 0), /from this module/);
  const segB = modB.data(new Uint8Array([1]));
  modA.function([], []).body(($) => {
    throws(() => memA.init(segB, s32.const(0), s32.const(0), s32.const(1)), /different module/);
    throws(() => segB.drop(), /different module/);
  });
  void memB;
});

test("offset variable must be immutable (checked at emit)", () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 });
  const local = mod.variable(u32, 8); // mutable — .immutable() never chained
  mod.data(new Uint8Array([1])).at(mem, local);
  throws(() => mod.emit(), /immutable module variables/);
});

test("bulk ops from another module's handle are rejected", () => {
  const modA = new Module();
  const memA = modA.memory({ min: 1 });
  const modB = new Module();
  modB.function([], []).body(($) => {
    throws(() => memA.fill(s32.const(0), s32.const(0), s32.const(1)), /different module/);
    throws(() => memA.size(), /different module/);
  });
});

test("multiple data segments get distinct indices", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.data(new Uint8Array([1, 1])).at(mem, 0); // active, index 0
  const segA = mod.data(new Uint8Array([2, 2])); // passive, index 1
  mod.data(new Uint8Array([3, 3])).at(mem, 4); // active, index 2
  const segB = mod.data(new Uint8Array([4, 4])); // passive, index 3
  mod.function([], []).export("f").body(($) => {
    mem.init(segB, s32.const(8), s32.const(0), s32.const(2)); // must hit segment 3, not 1
    mem.init(segA, s32.const(12), s32.const(0), s32.const(2));
  });
  const { exports } = await instantiate(mod);
  exports.f();
  const bytes = new Uint8Array(exports.memory.buffer);
  assert.deepEqual([...bytes.slice(0, 2)], [1, 1]);
  assert.deepEqual([...bytes.slice(4, 6)], [3, 3]);
  assert.deepEqual([...bytes.slice(8, 10)], [4, 4]);
  assert.deepEqual([...bytes.slice(12, 14)], [2, 2]);
});

test("active offset as a const expression node", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.data(new Uint8Array([7, 7])).at(mem, u32.const(24));
  const { exports } = await instantiate(mod);
  assert.deepEqual([...new Uint8Array(exports.memory.buffer, 24, 2)], [7, 7]);
});

test("empty data segments are legal", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 }).export("memory");
  mod.data(new Uint8Array(0)).at(mem, 0);
  const seg = mod.data(new Uint8Array(0));
  mod.function([], []).export("f").body(($) => {
    mem.init(seg, s32.const(0), s32.const(0), s32.const(0));
    seg.drop();
  });
  const { exports } = await instantiate(mod);
  exports.f();
});

test("an active segment that does not fit fails at instantiation", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 });
  mod.data(new Uint8Array(16)).at(mem, 65528); // spills past the single page
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "still a valid module — failure is at instantiation");
  await assert.rejects(WebAssembly.instantiate(bytes), WebAssembly.RuntimeError);
});

test("multiple memories: loads/stores route to the right memory", async () => {
  const mod = new Module();
  const a = mod.memory({ min: 1 }).export("a");
  const b = mod.memory({ min: 1 }).export("b");
  mod.function([s32], []).export("run").body((x, $) => {
    s32.store(a, s32.const(0), x);
    s32.store(b, s32.const(0), s32.mul(x, s32.const(2)));
    s32.store(b, s32.const(4), s32.load(a, s32.const(0), { offset: 0 }));
    $.return();
  });
  const { exports } = await instantiate(mod);
  exports.run(21);
  assert.equal(new Int32Array(exports.a.buffer)[0], 21);
  assert.deepEqual([...new Int32Array(exports.b.buffer).slice(0, 2)], [42, 21]);
});

test("multiple memories: imported memory takes index 0, defined follows", async () => {
  const mod = new Module();
  const imp = mod.memory({ min: 1 }).import("env", "m");
  const own = mod.memory({ min: 1 }).export("own");
  mod.function([], [u32, u32]).export("sizes").body(($) => {
    $.drop(own.grow(s32.const(2)));
    $.return(imp.size(), own.size());
  });
  const imported = new WebAssembly.Memory({ initial: 3 });
  const { exports } = await instantiate(mod, { env: { m: imported } });
  assert.deepEqual(exports.sizes(), [3, 3]); // own grew 1 → 3
});

test("multiple memories: cross-memory copy via opts.from, both directions", async () => {
  const mod = new Module();
  const a = mod.memory({ min: 1 }).export("a");
  const b = mod.memory({ min: 1 }).export("b");
  mod.function([], []).export("run").body(($) => {
    a.fill(s32.const(0), s32.const(7), s32.const(4));
    b.copy(s32.const(8), s32.const(0), s32.const(4), { from: a }); // a → b
    b.fill(s32.const(0), s32.const(9), s32.const(2));
    a.copy(s32.const(16), s32.const(0), s32.const(2), { from: b }); // b → a
    a.copy(s32.const(20), s32.const(16), s32.const(2)); // within a (default)
    $.return();
  });
  const { exports } = await instantiate(mod);
  exports.run();
  const bytesA = new Uint8Array(exports.a.buffer);
  const bytesB = new Uint8Array(exports.b.buffer);
  assert.deepEqual([...bytesB.slice(8, 12)], [7, 7, 7, 7]);
  assert.deepEqual([...bytesA.slice(16, 22)], [9, 9, 0, 0, 9, 9]);
});

test("multiple memories: active and passive segments target the right memory", async () => {
  const mod = new Module();
  mod.memory({ min: 1 }); // memory 0, untouched
  const b = mod.memory({ min: 1 }).export("b");
  mod.data(new Uint8Array([1, 2, 3])).at(b, 4); // active into memory 1
  const seg = mod.data(new Uint8Array([9, 8, 7, 6]));
  mod.function([], []).export("run").body(($) => {
    b.init(seg, s32.const(16), s32.const(1), s32.const(3));
    $.return();
  });
  const { exports } = await instantiate(mod);
  exports.run();
  const bytes = new Uint8Array(exports.b.buffer);
  assert.deepEqual([...bytes.slice(4, 7)], [1, 2, 3]);
  assert.deepEqual([...bytes.slice(16, 19)], [8, 7, 6]);
});

test("multiple memories: v128 and sized accesses use the flagged memarg", async () => {
  const mod = new Module();
  mod.memory({ min: 1 });
  const b = mod.memory({ min: 1 }).export("b");
  mod.function([s64], []).export("run").body((x, $) => {
    s64.store(b, s32.const(0), x);
    s64.store(b, s32.const(8), s64.load32(b, s32.const(0), { align: 2 }));
    u64.store(b, s32.const(16), u64.load8(b, s32.const(3)));
    s64x2.store(b, s32.const(32), s64x2.add(s64x2.load(b, s32.const(0)), s64x2.splat(s64.const(1))));
    $.return();
  });
  const { exports } = await instantiate(mod);
  exports.run(-2n);
  const dv = new DataView(exports.b.buffer);
  assert.equal(dv.getBigInt64(8, true), -2n); // low 32 bits sign-extended
  assert.equal(dv.getBigUint64(16, true), 0xffn);
  assert.equal(dv.getBigInt64(32, true), -1n); // v128 lane 0: -2 + 1
  assert.equal(dv.getBigInt64(40, true), -1n); // lane 1: -2 + 1
});
