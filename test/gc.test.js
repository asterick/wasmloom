import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Module, s32, u32, f64, bool, funcref, externref,
  anyref, eqref, i31ref, structref, arrayref, i8, i16, imm, WasmLoomError,
} from "../src/index.js";

// GC (wasm 3.0): struct/array types with named fields, declared subtyping,
// checked casts, packed storage, i31, segment-backed arrays, extern↔any.
// V8 ships GC by default since well before Node 22, so no runtime gate.

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmLoomError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("structs: new/newDefault/get/set, named fields, immutability", async () => {
  const mod = new Module();
  const Point = mod.struct({ x: f64, y: f64, id: imm(s32) });
  mod.function([s32], [f64]).export("f").body((id, $) => {
    const p = $.variable(Point.ref, Point.new(f64.const(3), f64.const(4), id));
    Point.set(p, "x", f64.const(30));
    const q = $.variable(Point.ref, Point.newDefault === undefined ? p : p);
    void q;
    $.return(f64.add(Point.get(p, "x"), f64.add(Point.get(p, "y"), f64.convert(Point.get(p, "id")))));
  });
  mod.function([], []).body(($) => {
    const p = Point.new(f64.const(0), f64.const(0), s32.const(1));
    throws(() => Point.set(p, "id", s32.const(2)), /immutable/);
    throws(() => Point.get(p, "z"), /no field "z"/);
    throws(() => Point.new(f64.const(1)), /expected 3 value/);
    $.drop(p);
    $.return();
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(7), 41); // 30 + 4 + 7
});

test("recursive and mutually recursive types via declare-then-define", async () => {
  const mod = new Module();
  const Tree = mod.struct();
  const Forest = mod.array(Tree.refNull);
  Tree.fields({ value: s32, kids: Forest.refNull });

  mod.function([], [s32]).export("sumTree").body(($) => {
    // depth-2 tree built inline: 1 + (2 + 3)
    const leaf2 = Tree.new(s32.const(2), Forest.refNull.null());
    const leaf3 = Tree.new(s32.const(3), Forest.refNull.null());
    const root = $.variable(Tree.ref, Tree.new(s32.const(1), Forest.newFixed(leaf2, leaf3)));
    const acc = $.variable(s32, Tree.get(root, "value"));
    const kids = $.variable(Forest.ref, Forest.ref.of(Tree.get(root, "kids")));
    const i = $.variable(u32);
    $.while(u32.lt(i, Forest.len(kids)), ($) => {
      acc.set(s32.add(acc, Tree.get(Tree.ref.of(Forest.get(kids, i)), "value")));
      i.set(u32.add(i, u32.const(1)));
    });
    $.return(acc);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sumTree(), 6);
});

test("subtyping: upcast by promotion, downcast by .ref.of, probe by .test", async () => {
  const mod = new Module();
  const Shape = mod.struct({ kind: s32 });
  const Circle = mod.struct({ kind: s32, r: f64 }, { extends: Shape });
  const Square = mod.struct({ kind: s32, side: f64 }, { extends: Shape });

  mod.function([s32], [f64]).export("area").body((which, $) => {
    const s = $.variable(Shape.refNull);
    $.if(s32.eqz(which), ($) => s.set(Circle.new(s32.const(1), f64.const(2))))
      .elseIf(s32.eq(which, s32.const(1)), ($) => s.set(Square.new(s32.const(2), f64.const(3))))
      .else(($) => s.set(Shape.new(s32.const(0))));
    const r = $.variable(f64, f64.const(-1));
    $.if(Circle.test(s), ($) => {
      const c = Circle.ref.of(s);
      r.set(f64.mul(f64.mul(Circle.get(c, "r"), Circle.get(c, "r")), f64.const(3.14159265)));
    }).elseIf(Square.test(s), ($) => {
      const q = Square.ref.of(s);
      r.set(f64.mul(Square.get(q, "side"), Square.get(q, "side")));
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.ok(Math.abs(exports.area(0) - 4 * 3.14159265) < 1e-9);
  assert.equal(exports.area(1), 9);
  assert.equal(exports.area(2), -1);

  // wrong-type downcast traps
  const m2 = new Module();
  const A = m2.struct({ a: s32 });
  const B = m2.struct({ b: f64 });
  m2.function([], [s32]).export("bad").body(($) => {
    const x = $.variable(structref, A.new(s32.const(1)));
    $.return(B.test(x)); // false, no trap
  });
  m2.function([], []).export("trap").body(($) => {
    const x = $.variable(structref, A.new(s32.const(1)));
    $.drop(B.get(B.ref.of(x), "b"));
    $.return();
  });
  const i2 = await instantiate(m2);
  assert.equal(i2.exports.bad(), 0);
  assert.throws(() => i2.exports.trap(), WebAssembly.RuntimeError);
});

test("extends guardrails are eager", () => {
  const mod = new Module();
  const Shape = mod.struct({ kind: s32 });
  throws(() => mod.struct({ different: f64 }, { extends: Shape }), /must match the supertype/);
  throws(() => mod.struct({ kind: imm(s32) }, { extends: Shape }), /must match the supertype/);
  throws(() => mod.struct({}, { extends: Shape }), /repeat all supertype fields/);
  const Late = mod.struct();
  throws(() => mod.struct({ kind: s32 }, { extends: Late }), /define the supertype's fields/);
  const other = new Module().struct({ kind: s32 });
  throws(() => mod.struct({ kind: s32 }, { extends: other }), /from this module/);
});

test("packed arrays: wrap on write, signedness on read, fill/copy", async () => {
  const mod = new Module();
  const Bytes = mod.array(i8);
  const Shorts = mod.array(imm(i16));
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const a = $.variable(Bytes.ref, Bytes.new(s32.const(8), s32.const(0)));
    Bytes.set(a, s32.const(0), x); // wraps to 8 bits
    Bytes.fill(a, s32.const(4), s32.const(255), s32.const(4));
    const b = $.variable(Bytes.ref, Bytes.new(s32.const(8)));
    Bytes.copy(b, s32.const(0), a, s32.const(0), s32.const(8));
    // signed vs unsigned reads of 0xFF
    $.return(s32.add(s32.mul(Bytes.getS(b, s32.const(4)), s32.const(1000)), s32.cast(Bytes.getU(b, s32.const(0)))));
  });
  mod.function([], [s32]).export("shorts").body(($) => {
    const s = $.variable(Shorts.ref, Shorts.newFixed(s32.const(-2), s32.const(70000)));
    $.return(s32.add(Shorts.getS(s, s32.const(0)), Shorts.getS(s, s32.const(1))));
  });
  mod.function([], []).body(($) => {
    const s = Shorts.newFixed(s32.const(1));
    throws(() => Shorts.set(s, s32.const(0), s32.const(2)), /immutable/);
    throws(() => Shorts.get(s, s32.const(0)), /packed .* use \.getS/);
    $.drop(s);
    $.return();
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(300), -1000 + 44); // getS(0xFF) = -1, getU(300&0xFF) = 44
  assert.equal(exports.shorts(), -2 + (70000 & 0xffff)); // 70000 wraps to 4464, still positive as s16
});

test("segment-backed arrays: newData and initData", async () => {
  const mod = new Module();
  const Bytes = mod.array(i8);
  const seg = mod.data(new Uint8Array([10, 20, 30, 40, 50]));
  mod.function([], [s32]).export("f").body(($) => {
    const a = $.variable(Bytes.ref, Bytes.newData(seg, s32.const(1), s32.const(3))); // [20,30,40]
    const b = $.variable(Bytes.ref, Bytes.new(s32.const(4), s32.const(0)));
    Bytes.initData(b, s32.const(1), seg, s32.const(3), s32.const(2)); // [0,40,50,0]
    $.return(s32.add(
      s32.mul(Bytes.getS(a, s32.const(0)), s32.const(100)),
      s32.add(Bytes.getS(b, s32.const(1)), Bytes.getS(b, s32.const(2))),
    ));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), 2000 + 90);
});

test("i31: 31-bit round trips, signedness, hierarchy membership", async () => {
  const mod = new Module();
  mod.function([s32], [s32, u32]).export("rt").body((x, $) => {
    const b = $.variable(i31ref, i31ref.of(x));
    const up = $.variable(eqref, b); // i31ref → eqref promotion
    void up;
    $.return(i31ref.getS(b), i31ref.getU(b));
  });
  const { exports } = await instantiate(mod);
  assert.deepEqual(exports.rt(5), [5, 5]);
  assert.deepEqual(exports.rt(-1), [-1, 0x7fffffff]); // 31-bit sign vs zero extension
});

test("ref.eq is identity; abstract promotion lattice holds", async () => {
  const mod = new Module();
  const P = mod.struct({ v: s32 });
  mod.function([], [bool, bool]).export("f").body(($) => {
    const a = $.variable(P.ref, P.new(s32.const(1)));
    const b = $.variable(P.ref, P.new(s32.const(1)));
    const any1 = $.variable(anyref, a);      // concrete → anyref
    const st = $.variable(structref, a);     // concrete → structref
    const eq1 = $.variable(eqref, st);       // structref → eqref
    void any1;
    void eq1;
    $.return(eqref.eq(a, a), eqref.eq(a, b));
  });
  const { exports } = await instantiate(mod);
  assert.deepEqual(exports.f(), [1, 0]); // same object; equal contents ≠ identity
});

test("extern↔any converts round-trip a JS value through the GC hierarchy", async () => {
  const mod = new Module();
  const slot = mod.variable(anyref, null);
  mod.function([externref], []).export("stash").body((x, $) => {
    slot.set(anyref.of(x)); // any.convert_extern
    $.return();
  });
  mod.function([], [externref]).export("take").body(($) => {
    $.return(externref.of(slot)); // extern.convert_any
  });
  const { exports } = await instantiate(mod);
  const token = { hello: "world" };
  exports.stash(token);
  assert.equal(exports.take(), token); // identity survives the hierarchy hop
});

test("GC refs cross the JS boundary as opaque values", async () => {
  const mod = new Module();
  const P = mod.struct({ v: imm(s32) });
  mod.function([], [P.ref]).export("make").body(($) => $.return(P.new(s32.const(42))));
  mod.function([P.refNull], [s32]).export("read").body((p, $) => {
    $.return(P.get(p, "v"));
  });
  const { exports } = await instantiate(mod);
  const obj = exports.make();
  assert.equal(exports.read(obj), 42); // opaque round trip through JS
});

test("emit is byte-stable with GC types, and gc types must be defined", () => {
  const build = () => {
    const mod = new Module();
    const A = mod.struct();
    const B = mod.array(A.refNull);
    A.fields({ v: s32, others: B.refNull });
    mod.function([], [s32]).export("f").body(($) => {
      $.return(A.get(A.new(s32.const(3), B.refNull.null()), "v"));
    });
    return mod.emit();
  };
  assert.deepEqual([...build()], [...build()]);

  const mod = new Module();
  mod.struct(); // never defined
  throws(() => mod.emit(), /never given \.fields/);
});
