import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, f32, f64, WasmEmitError } from "../src/index.js";

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("the namespace selects the signedness variant", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("sdiv").body((a, b, $) => {
    $.return(s32.div(a, b));
  });
  mod.function([u32, u32], [u32]).export("udiv").body((a, b, $) => {
    $.return(u32.div(a, b));
  });
  mod.function([s32], [s32]).export("sshr").body((a, $) => {
    $.return(s32.shr(a, s32.const(1)));
  });
  mod.function([u32], [u32]).export("ushr").body((a, $) => {
    $.return(u32.shr(a, u32.const(1)));
  });
  mod.function([s32], [s32]).export("sneg").body((a, $) => {
    $.return(s32.lt(a, s32.const(0)));
  });
  mod.function([u32], [s32]).export("uneg").body((a, $) => {
    $.return(u32.lt(a, u32.const(0)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sdiv(-7, 2), -3);
  assert.equal(exports.udiv(-7, 2), ((2 ** 32 - 7) / 2) | 0);
  assert.equal(exports.sshr(-8), -4);
  assert.equal(exports.ushr(-8), (2 ** 32 - 8) / 2);
  assert.equal(exports.sneg(-1), 1); // -1 < 0 signed
  assert.equal(exports.uneg(-1), 0); // 0xFFFFFFFF is huge unsigned
});

test("mixed signedness is an eager error; cast is the explicit bridge", async () => {
  const mod = new Module();
  mod.function([s32, u32], [u32]).export("f").body((a, b, $) => {
    throws(() => s32.add(a, b), /expected s32, got u32/);
    throws(() => u32.add(a, b), /expected u32, got s32/);
    throws(() => u32.cast(b), /expected s32, got u32/); // already u32
    throws(() => s64.cast(a), /expected u64, got s32/); // width mismatch
    $.return(u32.add(u32.cast(a), b));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(3, 4), 7);
});

test("cast is zero-cost bit identity", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("roundtrip").body((x, $) => {
    $.return(s32.cast(u32.cast(x)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.roundtrip(-123456), -123456);
  assert.equal(exports.roundtrip(0x7fffffff), 0x7fffffff);
});

test("operand-driven conversion dispatch", async () => {
  const mod = new Module();
  mod.function([s32], [f64]).export("sconv").body((x, $) => {
    $.return(f64.convert(x)); // f64.convert_i32_s
  });
  mod.function([s32], [f64]).export("uconv").body((x, $) => {
    $.return(f64.convert(u32.cast(x))); // f64.convert_i32_u
  });
  mod.function([f32], [f64]).export("promote").body((x, $) => {
    $.return(f64.promote(x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sconv(-1), -1);
  assert.equal(exports.uconv(-1), 4294967295);
  assert.equal(exports.promote(1.5), 1.5);
});

test("widening carries the signedness of the source", async () => {
  const mod = new Module();
  mod.function([s32], [s64]).export("sext").body((x, $) => {
    $.return(s64.extend(x));
  });
  mod.function([s32], [u64]).export("zext").body((x, $) => {
    $.return(u64.extend(u32.cast(x)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sext(-1), -1n);
  assert.equal(exports.zext(-1), 4294967295n);
});

test("wrap accepts either 64-bit signedness", async () => {
  const mod = new Module();
  mod.function([s64], [s32]).export("w").body((x, $) => {
    $.return(s32.wrap(x));
  });
  mod.function([u64], [u32]).export("wu").body((x, $) => {
    $.return(u32.wrap(x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.w(0x1_ffff_fff6n), -10);
  assert.equal(exports.wu(0x1_0000_0001n), 1);
});

test("comparisons produce s32 regardless of operand namespace", async () => {
  const mod = new Module();
  mod.function([u32, u32], [s32]).export("f").body((a, b, $) => {
    // u32 comparison result feeds s32 arithmetic without a cast
    $.return(s32.add(u32.lt(a, b), u32.gt(a, b)));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(1, 2), 1);
  assert.equal(exports.f(2, 2), 0);
});

test("conditions and addresses accept either 32-bit signedness", async () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 });
  mod.function([u32], [s32]).export("f").body((x, $) => {
    const r = $.variable(s32);
    u32.store(mem, x, x); // u32 address
    $.if(x, ($) => {
      // u32 condition
      r.set(s32.const(1));
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(4), 1);
  assert.equal(exports.f(0), 0);
});

test("s64/u64 conditions are rejected (wasm conditions are 32-bit)", () => {
  const mod = new Module();
  mod.function([s64], []).body((x, $) => {
    throws(() => $.if(x, () => {}), /expected a 32-bit integer.*got s64/);
    $.drop(s64.eqz(x)); // the explicit spelling — eqz/comparisons produce s32
  });
});

test("f32 namespace trunc is float truncation, not conversion", async () => {
  const mod = new Module();
  mod.function([f32], [f32]).export("t").body((x, $) => {
    $.return(f32.trunc(x));
  });
  mod.function([f32], [s32]).export("ti").body((x, $) => {
    $.return(s32.trunc(x));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.t(-2.75), -2);
  assert.equal(exports.ti(-2.75), -2);
});
