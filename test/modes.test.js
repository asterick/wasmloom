import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, f32, f64, bool, WasmLoomError } from "../src/index.js";

// The ONLY test file that opts into permissive mode. Everything else runs
// strict by design — the flag must never become the ambient default.
// (Safe value-exact promotion is default behavior — see promotion.test.js.)

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmLoomError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

// --- permissive: bit-level leniency -------------------------------------------

test("permissive: integers are accepted as conditions", async () => {
  const mod = new Module({ permissive: true });
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const r = $.variable(s32);
    $.if(x, ($) => r.set(s32.const(1))); // non-zero is true, no bool.of
    $.return(r);
  });
  mod.function([s64], [s32]).export("g").body((x, $) => {
    const steps = $.variable(s32);
    $.while(x, ($) => {
      // 64-bit conditions insert a real ≠0 test
      x.set(s64.sub(x, s64.const(1)));
      steps.set(s32.add(steps, s32.const(1)));
    });
    $.return(steps);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(7), 1);
  assert.equal(exports.f(0), 0);
  assert.equal(exports.g(3n), 3);
});

test("permissive: mixed signedness retypes freely, same width only", async () => {
  const mod = new Module({ permissive: true });
  mod.function([s32, u32], [s32]).export("f").body((a, b, $) => {
    $.return(s32.add(a, b)); // u32 operand retypes into s32.add
  });
  mod.function([s64, u64], [u64]).export("g").body((a, b, $) => {
    $.return(u64.add(a, b));
  });
  mod.function([s32, s64], []).body((a, b, $) => {
    throws(() => s32.add(a, b), /expected s32, got s64/); // narrowing: never allowed in any mode
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(3, 4), 7);
  assert.equal(exports.g(-1n, 2n), 1n);
});

test("permissive: bool flows into integer ops; integers into bool ops test ≠0", async () => {
  const mod = new Module({ permissive: true });
  mod.function([s32, s32], [s32]).export("count").body((a, b, $) => {
    $.return(s32.add(s32.lt(a, b), s32.eq(a, b))); // bool retypes into add
  });
  mod.function([bool, s32], [bool]).export("both").body((flag, x, $) => {
    // x is TESTED (≠0), not bitwise-anded: both(true, 2) must be 1, not 0
    $.return(bool.and(flag, x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.count(1, 2), 1);
  assert.equal(exports.both(1, 2), 1);
  assert.equal(exports.both(1, 0), 0);
});

test("permissive: select condition takes an integer; addresses take bool", async () => {
  const mod = new Module({ permissive: true });
  const mem = mod.memory({ min: 1 });
  mod.function([s32, s32, s32], [s32]).export("pick").body((c, a, b, $) => {
    $.return(s32.select(c, a, b));
  });
  mod.function([bool], [s32]).export("addr").body((flag, $) => {
    s32.store(mem, flag, s32.const(42)); // bool as address: 0 or 1
    $.return(s32.load(mem, flag));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.pick(9, 1, 2), 1);
  assert.equal(exports.pick(0, 1, 2), 2);
  assert.equal(exports.addr(1), 42);
});

test("permissive: constants stay strict; floats are never truthy", () => {
  const mod = new Module({ permissive: true });
  mod.function([f64, s64], []).body((x, big, $) => {
    throws(() => s32.const(0xffffffff), /outside/);
    throws(() => bool.const(1), /true or false/);
    throws(() => f64.add(x, big), /expected f64, got s64/); // not value-exact even here
    throws(() => $.if(x, () => {}), /expected bool/); // floats aren't truthy either
  });
});

test("permissive composes with default promotion; strict remains the default", async () => {
  const mod = new Module({ permissive: true });
  mod.function([s32, u32, f32], [f64]).export("f").body((a, b, x, $) => {
    const mixed = s32.add(a, b); // permissive retype
    $.return(f64.mul(x, mixed)); // safe promotion (always on)
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(2, 3, 1.5), 7.5);

  const strict = new Module();
  strict.function([s32, u32], []).body((a, b, $) => {
    throws(() => s32.add(a, b), /expected s32, got u32/);
    throws(() => $.if(a, () => {}), /expected bool/);
  });
});

// --- tailCalls: false — keep plain calls ---------------------------------------

test("tailCalls: false keeps $.return(f.call()) a plain call", async () => {
  const build = (opts) => {
    const mod = new Module(opts);
    const down = mod.function([s32], [s32]);
    down.body((n, $) => {
      $.if(s32.eqz(n), ($) => $.return(s32.const(1)));
      $.return(down.call(s32.sub(n, s32.const(1))));
    });
    mod.function([s32], [s32]).export("f").body((n, $) => $.return(down.call(n)));
    return mod;
  };

  const plain = await instantiate(build({ tailCalls: false }));
  const tail = await instantiate(build({}));
  // identical shallow behavior…
  assert.equal(plain.exports.f(100), 1);
  assert.equal(tail.exports.f(100), 1);
  // …but only the default completes deep recursion; the flag restores real
  // frames, which exhaust the stack (RangeError, not a wasm trap)
  assert.equal(tail.exports.f(5_000_000), 1);
  assert.throws(() => plain.exports.f(5_000_000), RangeError);
  // and the emitted bytes genuinely differ
  assert.notDeepEqual([...build({ tailCalls: false }).emit()], [...build({}).emit()]);
});
