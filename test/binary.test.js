import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, i32, i64 } from "../src/index.js";

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
  mod.function([i32, i32], [i32]).body((a, b, $) => $.return(i32.add(a, b)));
  mod.function([i32, i32], [i32]).body((a, b, $) => $.return(i32.sub(a, b)));
  const sections = parseSections(mod.emit());
  assert.equal(leadingU32(sections.get(1)), 1, "expected exactly one interned type");

  // A new signature after an emit() adds a second entry on the next emit.
  mod.function([i64], [i64]).body((x, $) => $.return(x));
  const again = parseSections(mod.emit());
  assert.equal(leadingU32(again.get(1)), 2);
});

test("emit() is repeatable and byte-stable", () => {
  const mod = new Module();
  const g = mod.variable(i32, 5);
  const helper = mod.function([i32], [i32]).body((x, $) => $.return(i32.mul(x, x)));
  mod.function([i32], [i32]).export("f").body((x, $) => {
    // multi-use expression → temp allocation path (the old repeatability bug)
    const shared = i32.add(helper.call(x), g);
    $.if(i32.gt_s(shared, i32.const(10)), ($) => {
      $.return(shared);
    });
    $.return(i32.sub(i32.const(0), shared));
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
  mod.variable(i32).import("env", "g");
  mod.function([], []).body(() => {});
  mod.variable(i32, 1);
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
    fns.push(mod.function([], [i32]).body(($) => $.return(i32.const(i))));
  }
  // Call the last one (index > 127) through an exported wrapper.
  mod.function([], [i32]).export("last").body(($) => {
    $.return(fns[139].call());
  });
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  assert.equal(instance.exports.last(), 139);
});
