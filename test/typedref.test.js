import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, f64, bool, funcref, WasmEmitError } from "../src/index.js";

// Typed function references (wasm 3.0): sig.ref / sig.refNull types,
// precise fn.ref() with promotion upcasts, call_ref via sig.call, the
// sig.ref.of() null-check bridge, and typed-ref tables.

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("call_ref through a non-null parameter", async () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32]);
  const dbl = mod.function([s32], [s32]).body((x, $) => $.return(s32.mul(x, s32.const(2))));
  const apply = mod.function([sig.ref, s32], [s32]);
  apply.body((f, x, $) => $.return(sig.call(f, x)));
  mod.function([s32], [s32]).export("go").body((x, $) => {
    $.return(apply.call(dbl.ref(), x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.go(21), 42);
});

test("signatures intern: fn.type is the user's handle, ref types agree", () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32]);
  const again = mod.funcType([s32], [s32]);
  const fn = mod.function([s32], [s32]).body((x, $) => $.return(x));
  assert.equal(sig, again);
  assert.equal(fn.type, sig);
  assert.equal(fn.type.ref, sig.ref);
  // distinct shapes stay distinct
  assert.notEqual(mod.funcType([s32], []).ref, sig.ref);
});

test("nullable globals, the .of bridge, and the null trap", async () => {
  const mod = new Module();
  const sig = mod.funcType([], [s32]);
  const seven = mod.function([], [s32]).body(($) => $.return(s32.const(7)));
  const cb = mod.variable(sig.refNull, null).export("cb");
  mod.function([], [bool]).export("empty").body(($) => $.return(sig.refNull.is_null(cb)));
  mod.function([], []).export("arm").body(($) => {
    cb.set(seven.ref()); // (ref $sig) → (ref null $sig) promotion
    $.return();
  });
  mod.function([], [s32]).export("fire").body(($) => {
    $.return(sig.call(sig.ref.of(cb))); // ref.as_non_null, traps on null
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.empty(), 1);
  assert.throws(() => exports.fire(), WebAssembly.RuntimeError); // null
  exports.arm();
  assert.equal(exports.empty(), 0);
  assert.equal(exports.fire(), 7);
});

test("non-null variables demand an initializer; nullable-slot lowering round-trips", async () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32]);
  const inc = mod.function([s32], [s32]).body((x, $) => $.return(s32.add(x, s32.const(1))));
  mod.function([], []).body(($) => {
    throws(() => $.variable(sig.ref), /no default value/);
    $.return();
  });
  // a non-null local read several times (slot is nullable + as_non_null reads)
  mod.function([s32], [s32]).export("thrice").body((x, $) => {
    const f = $.variable(sig.ref, inc.ref());
    $.return(sig.call(f, sig.call(f, sig.call(f, x))));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.thrice(0), 3);
});

test("typed-ref table: elem segment, tbl.get feeding call_ref", async () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32]);
  const dbl = mod.function([s32], [s32]).body((x, $) => $.return(s32.mul(x, s32.const(2))));
  const neg = mod.function([s32], [s32]).body((x, $) => $.return(s32.sub(s32.const(0), x)));
  const vt = mod.table(sig.refNull, { min: 4 });
  mod.elem([dbl, null, neg]).at(vt, 1);
  mod.function([s32, s32], [s32]).export("dispatch").body((i, x, $) => {
    $.return(sig.call(vt.get(i), x)); // (ref null $sig) accepted; traps on null
  });
  mod.function([s32], []).export("fill").body((i, $) => {
    vt.set(i, dbl.ref());
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.dispatch(1, 21), 42);
  assert.equal(exports.dispatch(3, 21), -21);
  assert.throws(() => exports.dispatch(2, 1), WebAssembly.RuntimeError); // null hole
  exports.fill(0);
  assert.equal(exports.dispatch(0, 8), 16);
});

test("tail position: $.return(sig.call(...)) emits return_call_ref", async () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32]);
  const step = mod.function([s32], [s32]);
  const self = mod.variable(sig.refNull, null);
  step.body((n, $) => {
    $.if(s32.eqz(n), ($) => $.return(s32.const(9)));
    $.return(sig.call(sig.ref.of(self), s32.sub(n, s32.const(1))));
  });
  mod.function([s32], [s32]).export("f").body((n, $) => {
    self.set(step.ref());
    $.return(step.call(n));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(1_000_000), 9); // constant stack through call_ref
});

test("multi-value call_ref destructures through spills", async () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32, f64]);
  const split = mod.function([s32], [s32, f64]).body((x, $) => {
    $.return(s32.mul(x, s32.const(2)), f64.convert(x));
  });
  mod.function([s32], [f64]).export("f").body((x, $) => {
    const [a, b] = sig.call(split.ref(), x);
    $.return(f64.add(f64.convert(a), b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(10), 30);
});

test("promotion goes up, never down or across", async () => {
  const mod = new Module();
  const sigI = mod.funcType([s32], [s32]);
  const sigV = mod.funcType([], []);
  const fn = mod.function([s32], [s32]).body((x, $) => $.return(x));
  const fr = mod.variable(funcref, fn.ref()).immutable(); // typed → funcref (init upcast)
  const nul = mod.variable(sigI.refNull, fn.ref());       // typed → nullable (init upcast)
  void fr;
  void nul;
  mod.function([funcref, sigI.ref], []).body((plain, typed, $) => {
    throws(() => sigI.call(plain, s32.const(1)), /expected a \(ref/); // no downcast
    throws(() => sigV.call(typed), /expected a \(ref/); // no cross-signature
    throws(() => sigV.ref.of(typed), /expected \(ref null fn#\d+\), got/); // bridge is per-signature
    $.drop(funcref.select(bool.const(true), typed, plain)); // typed → funcref promotes
    $.return();
  });
  const { exports } = await instantiate(mod);
  void exports;
});

test("typed-table guardrails: signature match, non-null tables rejected", () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32]);
  const other = mod.function([], []).body(() => {});
  throws(() => mod.table(sig.ref, { min: 1 }), /no default value|use sig\.refNull/);
  const vt = mod.table(sig.refNull, { min: 2 });
  throws(() => mod.elem([other]).at(vt, 0), /does not have this table's signature/);
});
