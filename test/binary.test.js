import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, s64, f32, f64 } from "../src/index.js";

// Targeted binary-level assertions (not golden snapshots): section structure
// facts that behavioral round-trips can't see.

function parseSections(bytes) {
  let i = 8;
  const u32 = () => {
    let v = 0;
    let shift = 0;
    let b;
    do {
      b = bytes[i++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v >>> 0;
  };
  const sections = new Map();
  while (i < bytes.length) {
    const id = bytes[i++];
    const size = u32();
    sections.set(id, bytes.slice(i, i + size));
    i += size;
  }
  return sections;
}

function leadingU32(payload) {
  let v = 0;
  let shift = 0;
  let i = 0;
  let b;
  do {
    b = payload[i++];
    v |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return v >>> 0;
}

test("identical signatures intern to one type entry", () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).body((a, b, $) => $.return(s32.add(a, b)));
  mod.function([s32, s32], [s32]).body((a, b, $) => $.return(s32.sub(a, b)));
  const sections = parseSections(mod.emit());
  assert.equal(leadingU32(sections.get(1)), 1, "expected exactly one interned type");

  // A new signature after an emit() adds a second entry on the next emit.
  mod.function([s64], [s64]).body((x, $) => $.return(x));
  const again = parseSections(mod.emit());
  assert.equal(leadingU32(again.get(1)), 2);
});

test("emit() is repeatable and byte-stable", () => {
  const mod = new Module();
  const g = mod.variable(s32, 5);
  const helper = mod.function([s32], [s32]).body((x, $) => $.return(s32.mul(x, x)));
  mod.function([s32], [s32]).export("f").body((x, $) => {
    // multi-use expression → temp allocation path (the old repeatability bug)
    const shared = s32.add(helper.call(x), g);
    $.if(s32.gt(shared, s32.const(10)), ($) => {
      $.return(shared);
    });
    $.return(s32.sub(s32.const(0), shared));
  });
  const first = [...mod.emit()];
  const second = [...mod.emit()];
  const third = [...mod.emit()];
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("mixed import kinds land in one import section, defined entities separate", () => {
  const mod = new Module();
  mod.function([], []).import("env", "f");
  mod.memory({ min: 1 }).import("env", "m");
  mod.variable(s32).import("env", "g");
  mod.function([], []).body(() => {});
  mod.variable(s32, 1);
  const sections = parseSections(mod.emit());
  assert.equal(leadingU32(sections.get(2)), 3, "three imports");
  assert.equal(leadingU32(sections.get(3)), 1, "one defined function");
  assert.equal(leadingU32(sections.get(6)), 1, "one defined global");
  assert.ok(!sections.has(5), "no memory section when the only memory is imported");
});

test("function indices above 127 encode correctly (multi-byte LEB)", async () => {
  const mod = new Module();
  const fns = [];
  for (let i = 0; i < 140; i++) {
    fns.push(mod.function([], [s32]).body(($) => $.return(s32.const(i))));
  }
  // Call the last one (index > 127) through an exported wrapper.
  mod.function([], [s32]).export("last").body(($) => {
    $.return(fns[139].call());
  });
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  assert.equal(instance.exports.last(), 139);
});

// A module exercising most of the surface at once, for whole-pipeline invariants.
function kitchenSink(opts) {
  const mod = new Module(opts);
  const mem = mod.memory({ min: 1 }).export("memory");
  const g = mod.variable(s64, -5).export("g");
  const seg = mod.data(new Uint8Array([1, 2, 3, 4]));
  mod.data(new Uint8Array([9, 9])).at(mem, 32);
  const helper = mod.function([s32], [s32, s32]).body((x, $) => {
    $.return(s32.add(x, s32.const(1)), s32.mul(x, x));
  });
  mod.function([s32, f32], [f64]).export("f").body((n, x, $) => {
    const acc = $.variable(f64);
    const [a, b] = helper.call(n);
    const shared = s32.add(a, b); // multi-use → temp
    mem.init(seg, s32.const(0), s32.const(0), s32.const(4));
    s32.store8(mem, s32.const(8), shared);
    g.set(shared); // promotion s32→s64
    $.while(s32.gt(n, s32.const(0)), ($) => {
      acc.set(f64.add(acc, x)); // promotion f32→f64
      n.set(s32.sub(n, s32.const(1)));
    });
    const done = $.label.ahead();
    $.gotoIf(f64.gt(acc, f64.const(100)), done);
    acc.set(f64.add(acc, shared));
    done.here();
    $.return(f64.select(s32.eqz(n), acc, f64.const(-1)));
  });
  return mod;
}

test("debug mode emits byte-identical output", () => {
  assert.deepEqual([...kitchenSink({ debug: true }).emit()], [...kitchenSink({}).emit()]);
});

test("emit() stays byte-stable across the full feature surface", async () => {
  const mod = kitchenSink({});
  const first = [...mod.emit()];
  assert.deepEqual([...mod.emit()], first);
  assert.deepEqual([...mod.emit()], first);
  // and the module actually runs
  const { instance } = await WebAssembly.instantiate(mod.emit());
  // helper(4) → (5, 16); shared = 21; loop adds 0.5 four times → acc = 2;
  // acc += shared → 23; n == 0 → select takes acc
  assert.equal(instance.exports.f(4, 0.5), 23);
  assert.equal(instance.exports.g.value, 21n);
});
