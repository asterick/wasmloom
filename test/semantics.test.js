import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, i32 } from "../src/index.js";

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("multi-use expression evaluates once (auto-bound)", async () => {
  const mod = new Module();
  const next = mod.function([], [i32]).import("env", "next");
  mod.function([], [i32]).export("f").body(($) => {
    const x = next.call();
    $.return(i32.add(x, x)); // one call, value used twice
  });
  let calls = 0;
  const { exports } = await instantiate(mod, { env: { next: () => { calls++; return 5; } } });
  assert.equal(exports.f(), 10);
  assert.equal(calls, 1);
});

test("multi-use evaluates at creation point, not first use", async () => {
  const mod = new Module();
  const g = mod.variable(i32, 1);
  mod.function([], [i32]).export("f").body(($) => {
    const snapshot = i32.add(g, i32.const(0)); // reads g = 1 here
    g.set(i32.const(42));
    // snapshot used twice → evaluated at creation, before the set above
    $.return(i32.add(snapshot, snapshot));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), 2);
});

test("single-use expression inlines at consumption", async () => {
  const mod = new Module();
  const g = mod.variable(i32, 1);
  mod.function([], [i32]).export("f").body(($) => {
    const late = i32.add(g, i32.const(0)); // single use → evaluated at $.return below
    g.set(i32.const(42));
    $.return(late); // sees g = 42
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), 42);
});

test("$.while condition re-evaluates every iteration", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("count").body((n, $) => {
    const steps = $.variable(i32);
    $.while(i32.gt_s(n, i32.const(0)), ($) => {
      n.set(i32.sub(n, i32.const(1)));
      steps.set(i32.add(steps, i32.const(1)));
    });
    $.return(steps);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.count(5), 5);
});

test("$.drop discards a call result", async () => {
  const mod = new Module();
  const next = mod.function([], [i32]).import("env", "next");
  mod.function([], []).export("f").body(($) => {
    $.drop(next.call());
  });
  let calls = 0;
  const { exports } = await instantiate(mod, { env: { next: () => ++calls } });
  exports.f();
  assert.equal(calls, 1);
});

test("locals with disjoint live ranges share a slot", () => {
  const mod = new Module();
  mod.function([], [i32]).export("f").body(($) => {
    const a = $.variable(i32, 1);
    const sum = $.variable(i32);
    sum.set(i32.add(sum, a)); // a's last use
    const b = $.variable(i32, 2); // may reuse a's slot
    sum.set(i32.add(sum, b));
    $.return(sum);
  });
  const bytes = mod.emit();
  // Parse the code section's locals declaration: expect fewer than 3 i32 locals.
  const totalLocals = countLocals(bytes);
  assert.ok(totalLocals <= 2, `expected slot sharing to use ≤ 2 locals, got ${totalLocals}`);
});

function countLocals(bytes) {
  // Minimal scan: find the code section (id 10), first body, sum local counts.
  let i = 8;
  const u32 = () => {
    let v = 0, shift = 0, b;
    do { b = bytes[i++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return v >>> 0;
  };
  while (i < bytes.length) {
    const id = bytes[i++];
    const size = u32();
    if (id !== 10) { i += size; continue; }
    u32(); // body count
    u32(); // body size
    const groups = u32();
    let total = 0;
    for (let g = 0; g < groups; g++) {
      total += u32();
      i++; // type byte
    }
    return total;
  }
  throw new Error("no code section found");
}
