import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, bool, funcref, externref, WasmLoomError } from "../src/index.js";

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmLoomError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("vtable dispatch: elem segment + call_indirect", async () => {
  const mod = new Module();
  const binop = mod.funcType([s32, s32], [s32]);
  const add = mod.function(binop).body((a, b, $) => $.return(s32.add(a, b)));
  const sub = mod.function(binop).body((a, b, $) => $.return(s32.sub(a, b)));
  const mul = mod.function(binop).body((a, b, $) => $.return(s32.mul(a, b)));
  const tbl = mod.table(funcref, { min: 3 });
  mod.elem([add, sub, mul]).at(tbl, 0);
  mod.function([s32, s32, s32], [s32]).export("dispatch").body((op, a, b, $) => {
    $.return(tbl.call(binop, op, a, b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.dispatch(0, 10, 4), 14);
  assert.equal(exports.dispatch(1, 10, 4), 6);
  assert.equal(exports.dispatch(2, 10, 4), 40);
  assert.throws(() => exports.dispatch(9, 1, 1), WebAssembly.RuntimeError); // OOB
});

test("call_indirect traps on signature mismatch and null entries", async () => {
  const mod = new Module();
  const unary = mod.funcType([s32], [s32]);
  const nullary = mod.funcType([], [s32]);
  const inc = mod.function(unary).body((x, $) => $.return(s32.add(x, s32.const(1))));
  const tbl = mod.table(funcref, { min: 2 });
  mod.elem([inc, null]).at(tbl, 0); // slot 1 stays null
  mod.function([s32], [s32]).export("callUnary").body((i, $) => {
    $.return(tbl.call(unary, i, s32.const(41)));
  });
  mod.function([s32], [s32]).export("callNullary").body((i, $) => {
    $.return(tbl.call(nullary, i));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.callUnary(0), 42);
  assert.throws(() => exports.callUnary(1), WebAssembly.RuntimeError); // null entry
  assert.throws(() => exports.callNullary(0), WebAssembly.RuntimeError); // wrong signature
});

test("tbl.get / tbl.set rewire dispatch at runtime", async () => {
  const mod = new Module();
  const thunk = mod.funcType([], [s32]);
  const one = mod.function(thunk).body(($) => $.return(s32.const(1)));
  const two = mod.function(thunk).body(($) => $.return(s32.const(2)));
  const tbl = mod.table(funcref, { min: 2 });
  mod.elem([one, two]).at(tbl, 0);
  mod.function([], []).export("swap").body(($) => {
    const t = $.variable(funcref, tbl.get(s32.const(0)));
    tbl.set(s32.const(0), tbl.get(s32.const(1)));
    tbl.set(s32.const(1), t);
  });
  mod.function([s32], [s32]).export("call").body((i, $) => {
    $.return(tbl.call(thunk, i));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.call(0), 1);
  exports.swap();
  assert.equal(exports.call(0), 2);
  assert.equal(exports.call(1), 1);
});

test("tbl.size / grow / fill", async () => {
  const mod = new Module();
  const thunk = mod.funcType([], [s32]);
  const f = mod.function(thunk).body(($) => $.return(s32.const(7)));
  const tbl = mod.table(funcref, { min: 1, max: 4 });
  mod.function([], [u32]).export("size").body(($) => $.return(tbl.size()));
  mod.function([], [u32]).export("growNull").body(($) => $.return(tbl.grow(u32.const(1))));
  mod.function([], [u32]).export("growF").body(($) => $.return(tbl.grow(u32.const(1), f.ref())));
  mod.function([s32], [bool]).export("isNull").body((i, $) => {
    $.return(funcref.is_null(tbl.get(i)));
  });
  mod.function([s32, s32], []).export("fill").body((start, len, $) => {
    tbl.fill(start, f.ref(), len);
  });
  mod.function([s32], [s32]).export("call").body((i, $) => $.return(tbl.call(thunk, i)));
  const { exports } = await instantiate(mod);
  assert.equal(exports.size(), 1);
  assert.equal(exports.growNull(), 1); // old size
  assert.equal(exports.growF(), 2);
  assert.equal(exports.size(), 3);
  assert.equal(exports.isNull(1), 1); // grown with null
  assert.equal(exports.isNull(2), 0); // grown with f
  assert.equal(exports.call(2), 7);
  exports.fill(0, 2);
  assert.equal(exports.isNull(0), 0);
  assert.equal(exports.call(1), 7);
  assert.equal(exports.growF(), 3);
  assert.equal(exports.growF(), -1); // beyond max: u32 max, signed at the JS boundary
});

test("passive elem segments: init, drop, and copy (same and cross table)", async () => {
  const mod = new Module();
  const thunk = mod.funcType([], [s32]);
  const a = mod.function(thunk).body(($) => $.return(s32.const(10)));
  const b = mod.function(thunk).body(($) => $.return(s32.const(20)));
  const seg = mod.elem([a, b]);
  const t1 = mod.table(funcref, { min: 4 });
  const t2 = mod.table(funcref, { min: 4 });
  mod.function([], []).export("load").body(($) => {
    t1.init(seg, s32.const(0), s32.const(0), s32.const(2));
  });
  mod.function([], []).export("release").body(($) => {
    seg.drop();
  });
  mod.function([], []).export("shuffle").body(($) => {
    t1.copy(s32.const(2), s32.const(0), s32.const(2)); // within t1
    t2.copy(s32.const(0), s32.const(2), s32.const(2), { from: t1 }); // t1 → t2
  });
  mod.function([s32], [s32]).export("c1").body((i, $) => $.return(t1.call(thunk, i)));
  mod.function([s32], [s32]).export("c2").body((i, $) => $.return(t2.call(thunk, i)));
  const { exports } = await instantiate(mod);
  exports.load();
  assert.equal(exports.c1(0), 10);
  assert.equal(exports.c1(1), 20);
  exports.shuffle();
  assert.equal(exports.c1(2), 10);
  assert.equal(exports.c2(0), 10);
  assert.equal(exports.c2(1), 20);
  exports.release();
  assert.throws(() => exports.load(), WebAssembly.RuntimeError); // dropped
});

test("funcref globals and variables; fn.ref() is a constant expression", async () => {
  const mod = new Module();
  const thunk = mod.funcType([], [s32]);
  const f = mod.function(thunk).body(($) => $.return(s32.const(5)));
  const g = mod.function(thunk).body(($) => $.return(s32.const(6)));
  const hot = mod.variable(funcref, f.ref()).export("hot"); // ref.func in a global init
  const empty = mod.variable(funcref).export("empty"); // zero-init: null
  const tbl = mod.table(funcref, { min: 1 });
  mod.function([], []).export("upgrade").body(($) => {
    hot.set(g.ref());
  });
  mod.function([], [s32]).export("callHot").body(($) => {
    tbl.set(s32.const(0), hot);
    $.return(tbl.call(thunk, s32.const(0)));
  });
  mod.function([], [bool]).export("emptyIsNull").body(($) => {
    $.return(funcref.is_null(empty));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.emptyIsNull(), 1);
  assert.equal(exports.callHot(), 5);
  exports.upgrade();
  assert.equal(exports.callHot(), 6);
});

test("ref.func with no other mention auto-declares (hidden declarative segment)", async () => {
  const mod = new Module();
  // `secret` is not exported, not in any user elem segment — only ref.func'd.
  const secret = mod.function([], [s32]).body(($) => $.return(s32.const(99)));
  const thunk = mod.funcType([], [s32]);
  const tbl = mod.table(funcref, { min: 1 });
  mod.function([], [s32]).export("f").body(($) => {
    tbl.set(s32.const(0), secret.ref()); // ref.func inside a body
    $.return(tbl.call(thunk, s32.const(0)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), 99);
});

test("externref: host values round-trip, tables, null checks, typed select", async () => {
  const mod = new Module();
  const tbl = mod.table(externref, { min: 2 }).export("tbl");
  const slot = mod.variable(externref).export("slot");
  mod.function([externref], []).export("keep").body((v, $) => {
    slot.set(v);
    tbl.set(s32.const(0), v);
  });
  mod.function([externref], [externref]).export("echo").body((v, $) => {
    $.return(v);
  });
  mod.function([], [externref]).export("read").body(($) => {
    $.return(tbl.get(s32.const(0)));
  });
  mod.function([externref, externref, s32], [externref]).export("pick").body((a, b, c, $) => {
    $.return(externref.select(bool.of(c), a, b)); // typed select encoding
  });
  mod.function([externref], [bool]).export("isNull").body((v, $) => {
    $.return(externref.is_null(v));
  });
  const { exports } = await instantiate(mod);
  const obj = { hello: "world" };
  assert.equal(exports.echo(obj), obj);
  exports.keep(obj);
  assert.equal(exports.read(), obj);
  assert.equal(exports.slot.value, obj);
  assert.equal(exports.pick(obj, null, 1), obj);
  assert.equal(exports.pick(obj, null, 0), null);
  assert.equal(exports.isNull(null), 1);
  assert.equal(exports.isNull(obj), 0);
});

test("imported and exported tables", async () => {
  const modA = new Module();
  const thunkA = modA.funcType([], [s32]);
  const fa = modA.function(thunkA).body(($) => $.return(s32.const(77)));
  const shared = modA.table(funcref, { min: 1 }).export("tbl");
  modA.function([], []).export("install").body(($) => {
    shared.set(s32.const(0), fa.ref());
  });
  const a = await instantiate(modA);
  a.exports.install();

  const modB = new Module();
  const thunkB = modB.funcType([], [s32]);
  const imported = modB.table(funcref, { min: 1 }).import("env", "tbl");
  modB.function([], [s32]).export("callThrough").body(($) => {
    $.return(imported.call(thunkB, s32.const(0)));
  });
  const b = await instantiate(modB, { env: { tbl: a.exports.tbl } });
  assert.equal(b.exports.callThrough(), 77);
});

test("funcType unifies declaration and dispatch; multi-value indirect calls", async () => {
  const mod = new Module();
  const splitter = mod.funcType([s32], [s32, s32]);
  const halve = mod.function(splitter).body((x, $) => {
    $.return(s32.div(x, s32.const(2)), s32.rem(x, s32.const(2)));
  });
  const tbl = mod.table(funcref, { min: 1 });
  mod.elem([halve]).at(tbl, 0);
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const [q, r] = tbl.call(splitter, s32.const(0), x);
    $.return(s32.add(s32.mul(q, s32.const(10)), r));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(17), 81); // 8*10 + 1
});

test("reference guardrails", async () => {
  const modA = new Module();
  const tblA = modA.table(funcref, { min: 1 });
  const sigA = modA.funcType([], []);
  void tblA;
  void sigA;

  const mod = new Module();
  const etbl = mod.table(externref, { min: 1 });
  const ftbl = mod.table(funcref, { min: 1 });
  const sig = mod.funcType([], []);
  const f = mod.function([], []).body(() => {});
  throws(() => mod.elem([f]).at(etbl, 0), /funcref- or sig\.refNull-typed/);
  throws(() => mod.table(s32, { min: 1 }), /funcref, externref, or a typed reference/);
  mod.function([funcref, externref, s32], []).body((fr, er, x, $) => {
    throws(() => etbl.call(sig, s32.const(0)), /requires a funcref table/);
    throws(() => tblA.call(sig, s32.const(0)), /different module/);
    throws(() => ftbl.call(sigA, s32.const(0)), /different module/);
    throws(() => ftbl.copy(x, x, x, { from: etbl }), /element types must match/);
    throws(() => s32.add(x, fr), /expected s32, got funcref/); // refs never lift
    throws(() => funcref.is_null(er), /expected funcref, got externref/);
    throws(() => externref.select(bool.of(x), er, fr), /expected externref, got funcref/);
    throws(() => $.if(fr, () => {}), /expected bool.*got funcref/);
    throws(() => bool.of(fr), /expected an integer/);
  });
  // default zero-init for ref variables is null (checked behaviorally above);
  // and a function reference never lifts into an externref variable
  throws(() => mod.variable(funcref, null).immutable() && mod.variable(externref, f.ref()), /expected externref, got \(ref/);
});
