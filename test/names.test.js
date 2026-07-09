import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, funcref, WasmLoomError } from "../src/index.js";

// The name section: auto-derived debug names (export name, else
// "module.name" for imports), .name("str") overrides, names:false opt-out.

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmLoomError && re.test(e.message));

/** Minimal name-section reader: returns { module, maps: { subsectionId: Map(idx → name) } }. */
function readNames(bytes) {
  let i = 8;
  const u32 = () => {
    let v = 0, shift = 0, b;
    do { b = bytes[i++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return v >>> 0;
  };
  const str = () => {
    const len = u32();
    const s = new TextDecoder().decode(bytes.slice(i, i + len));
    i += len;
    return s;
  };
  while (i < bytes.length) {
    const id = bytes[i++];
    const size = u32();
    const end = i + size;
    if (id !== 0) { i = end; continue; }
    if (str() !== "name") { i = end; continue; }
    const out = { module: null, maps: {} };
    while (i < end) {
      const sub = bytes[i++];
      const subSize = u32();
      const subEnd = i + subSize;
      if (sub === 0) { out.module = str(); i = subEnd; continue; }
      const m = new Map();
      const count = u32();
      for (let k = 0; k < count; k++) m.set(u32(), str());
      out.maps[sub] = m;
      i = subEnd;
    }
    return out;
  }
  return null;
}

test("names auto-derive from exports and imports; .name() overrides", () => {
  const mod = new Module().name("codec");
  const log = mod.function([s32], []).import("env", "log");
  void log;
  mod.function([], []).export("run").body(($) => $.return());
  const secret = mod.function([], []).name("tightLoop");
  secret.body(($) => $.return());
  const renamed = mod.function([], []).export("publicName").name("privateName");
  renamed.body(($) => $.return());
  const anonymous = mod.function([], []).body(($) => $.return());
  void anonymous;

  const names = readNames(mod.emit());
  assert.equal(names.module, "codec");
  const fns = names.maps[1];
  assert.equal(fns.get(0), "env.log"); // import-derived
  assert.equal(fns.get(1), "run"); // export-derived
  assert.equal(fns.get(2), "tightLoop"); // explicit, unexported
  assert.equal(fns.get(3), "privateName"); // .name() beats export
  assert.equal(fns.has(4), false); // anonymous stays anonymous
});

test("memories, tables, globals, and segments are nameable", () => {
  const mod = new Module();
  mod.memory({ min: 1 }).name("heap");
  const tbl = mod.table(funcref, { min: 2 }).name("vtable");
  mod.variable(s32, 7).immutable().export("answer");
  const f = mod.function([], []).body(($) => $.return());
  mod.elem([f]).at(tbl, 0).name("vinit");
  mod.data(new Uint8Array([1])).name("blob");

  const names = readNames(mod.emit());
  assert.equal(names.maps[5].get(0), "vtable");
  assert.equal(names.maps[6].get(0), "heap");
  assert.equal(names.maps[7].get(0), "answer"); // export-derived global
  assert.equal(names.maps[8].get(0), "vinit");
  assert.equal(names.maps[9].get(0), "blob");
});

test("engines use function names in stack traces", async () => {
  const mod = new Module();
  const boom = mod.function([], []).name("kaboom");
  boom.body(($) => $.unreachable());
  mod.function([], []).export("go").body(($) => {
    boom.call();
    $.return();
  });
  const { instance } = await WebAssembly.instantiate(mod.emit());
  let stack = "";
  try {
    instance.exports.go();
  } catch (e) {
    stack = e.stack;
  }
  assert.ok(/kaboom/.test(stack), `expected 'kaboom' in:\n${stack}`);
});

test("names: false strips the section entirely", () => {
  const mod = new Module({ names: false }).name("codec");
  mod.function([], []).export("run").name("alias").body(($) => $.return());
  assert.equal(readNames(mod.emit()), null);
});

test("no name section when nothing is named", () => {
  const mod = new Module();
  mod.function([], []).body(($) => $.return()); // never exported or named
  assert.equal(readNames(mod.emit()), null);
});

test("name validation is eager; locals reject names", () => {
  const mod = new Module();
  throws(() => mod.function([], []).name(""), /non-empty string/);
  throws(() => mod.name(42), /non-empty string/);
  mod.function([], []).body(($) => {
    throws(() => $.variable(s32).name("x"), /locals share wasm slots/);
    $.return();
  });
});
