import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32 } from "../src/index.js";

// Reconnaissance tests: the pipeline recurses over expression trees and
// placed-block chains, so extreme depth is bounded by the JS stack. These pin
// a comfortable supported depth; if a change makes them stack-overflow, the
// recursion needs to become explicit.

test("50000-deep expression chains compile and run", async () => {
  const DEPTH = 50000;
  const mod = new Module();
  mod.function([s32], [s32]).export("f").body((x, $) => {
    let e = x;
    for (let i = 0; i < DEPTH; i++) e = s32.add(e, s32.const(1));
    $.return(e);
  });
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  assert.equal(instance.exports.f(0), DEPTH);
});

test("1000 sequentially-placed labels compile and run", async () => {
  const COUNT = 1000;
  const mod = new Module();
  mod.function([], [s32]).export("f").body(($) => {
    const acc = $.variable(s32);
    for (let i = 0; i < COUNT; i++) {
      $.label(); // each placement ends a block and starts a new one
      acc.set(s32.add(acc, s32.const(1)));
    }
    $.return(acc);
  });
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  assert.equal(instance.exports.f(), COUNT);
});
