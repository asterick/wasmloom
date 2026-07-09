import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, u64, f32, f64, bool, WasmEmitError } from "../src/index.js";

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

test("type mismatch throws at the call site", () => {
  const mod = new Module();
  mod.function([f64], [s32]).body((x, $) => {
    throws(() => s32.add(x, s32.const(1)), /s32\.add operand 1: expected s32, got f64/);
    $.return(s32.const(0));
  });
});

test("no implicit wrapping of JS numbers", () => {
  const mod = new Module();
  mod.function([], [s32]).body(($) => {
    throws(() => s32.add(s32.const(1), 2), /expected an expression.*s32\.const\(2\)/s);
    $.return(s32.const(0));
  });
});

test("constant range validation", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    throws(() => s32.const(2 ** 31), /outside/);
    throws(() => s32.const(0xffffffff), /outside/); // unsigned spellings need u32
    throws(() => u32.const(-1), /outside/);
    throws(() => s32.const(1.5), /integer/);
    throws(() => s64.const(2 ** 53), /safe integer/);
    throws(() => s64.const(2n ** 63n), /outside/);
    throws(() => u64.const(2n ** 64n), /outside/);
    throws(() => f32.const("1"), /number/);
    u64.const(2n ** 64n - 1n); // max unsigned ok
    u32.const(0xffffffff); // ...on the unsigned namespaces
    s32.const(-0x80000000); // signed min ok
  });
});

test("arity mismatches", () => {
  const mod = new Module();
  const f = mod.function([s32, s32], [s32]).import("env", "f");
  mod.function([], []).body(($) => {
    throws(() => f.call(s32.const(1)), /expected 2 argument\(s\), got 1/);
    throws(() => $.return(s32.const(1)), /returns 0 value\(s\), got 1/);
  });
});

test("unconsumed call result is an error at body completion", () => {
  const mod = new Module();
  const f = mod.function([], [s32]).import("env", "f");
  throws(
    () => mod.function([], []).body(($) => { f.call(); }),
    /never used.*\$\.drop/s,
  );
});

test("function that can fall off the end without returning", () => {
  const mod = new Module();
  throws(
    () => mod.function([], [s32]).body(($) => {}),
    /without returning/,
  );
});

test("missing body detected at emit", () => {
  const mod = new Module();
  mod.function([], []);
  throws(() => mod.emit(), /never given a body or import/);
});

test("body and import are mutually exclusive", () => {
  const mod = new Module();
  throws(() => mod.function([], []).import("a", "b").body(() => {}), /imported function cannot have a body/);
  throws(() => mod.function([], []).body(($) => {}).import("a", "b"), /cannot be imported/);
});

test("unplaced label detected at body completion", () => {
  const mod = new Module();
  throws(
    () => mod.function([], []).body(($) => {
      const l = $.label.ahead();
      $.goto(l);
    }),
    /jumped to but never placed/,
  );
});

test("label placed twice", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    const l = $.label.ahead();
    l.here();
    throws(() => l.here(), /already placed/);
  });
});

test("immutable variable rejects set", () => {
  const mod = new Module();
  const v = mod.variable(s32, 5).immutable();
  mod.function([], []).body(($) => {
    throws(() => v.set(s32.const(1)), /immutable/);
  });
});

test("immutable() rejected on function-scoped variables", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    const v = $.variable(s32);
    throws(() => v.immutable(), /locals are always mutable/);
  });
});

test("duplicate export name", () => {
  const mod = new Module();
  mod.function([], []).body(() => {}).export("x");
  throws(() => mod.variable(s32).export("x"), /duplicate export name/);
});

test("module variable init must be a constant expression", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    throws(() => mod.variable(s32, s32.add(s32.const(1), s32.const(2))), /constant expression/);
  });
  // Referencing another variable is validated at emit (its .import()/.immutable()
  // may legally chain after this declaration).
  const mutable = mod.variable(s32, 1);
  mod.variable(s32, mutable);
  throws(() => mod.emit(), /imported immutable/);
});

test("imported variable cannot have an initializer", () => {
  const mod = new Module();
  throws(() => mod.variable(s32, 5).import("env", "x"), /cannot have an initializer/);
});

test("cross-function expression use", () => {
  const mod = new Module();
  let leaked;
  mod.function([], []).body(($) => { leaked = s32.const(1); leaked = s32.add(leaked, leaked); $.drop(leaked); });
  throws(
    () => mod.function([], [s32]).body(($) => { $.return(leaked); }),
    /different function body/,
  );
});

test("expressions require an active body", () => {
  throws(() => s32.add(s32.const(1), s32.const(2)), /no active function body/);
});

test("elseIf after an intervening statement", () => {
  const mod = new Module();
  mod.function([s32], []).body((x, $) => {
    const chain = $.if(bool.of(x), () => {});
    $.drop(s32.const(1));
    throws(() => chain.elseIf(bool.of(x), () => {}), /finalized by an intervening statement/);
  });
});

test("else called twice", () => {
  const mod = new Module();
  mod.function([s32], []).body((x, $) => {
    const chain = $.if(bool.of(x), () => {});
    chain.else(() => {});
    throws(() => chain.else(() => {}), /already has an \.else/);
  });
});

test("mem.copy `from` must be a memory handle from this module", () => {
  const mod = new Module();
  const a = mod.memory({ min: 1 });
  const other = new Module().memory({ min: 1 });
  mod.function([], []).body(($) => {
    throws(
      () => a.copy(s32.const(0), s32.const(0), s32.const(1), { from: other }),
      /`from` must be a memory handle from this module/,
    );
    $.return();
  });
});

test("start function signature checked", () => {
  const mod = new Module();
  const f = mod.function([s32], []).import("env", "f");
  throws(() => mod.start(f), /no parameters and no results/);
});

test("non-dominating multi-use is rejected at emit", () => {
  const mod = new Module();
  const next = mod.function([], [s32]).import("env", "next");
  mod.function([s32], [s32]).export("f").body((c, $) => {
    let x;
    $.if(bool.of(c), () => { x = next.call(); $.drop(x); });
    $.return(x); // second use outside the arm that created it
  });
  throws(() => mod.emit(), /does not dominate all uses/);
});

test("debug mode includes creation site in errors", () => {
  const mod = new Module({ debug: true });
  const f = mod.function([], [s32]).import("env", "f");
  try {
    mod.function([], []).body(($) => { f.call(); });
    assert.fail("expected a WasmEmitError");
  } catch (e) {
    assert.ok(e instanceof WasmEmitError);
    assert.match(e.message, /Created at:/);
    assert.match(e.message, /errors\.test\.js/);
  }
});

test("memory align/offset validation", () => {
  const mod = new Module();
  const mem = mod.memory({ min: 1 });
  mod.function([s32], []).body((addr, $) => {
    throws(() => s32.load(mem, addr, { align: 3 }), /power of two/);
    throws(() => s32.load(mem, addr, { align: 8 }), /power of two ≤ 4/);
    throws(() => s64.load(mem, addr, { align: 16 }), /power of two ≤ 8/);
    throws(() => s32.load(mem, addr, { offset: -1 }), /offset/);
    throws(() => s32.load(mem, addr, { offset: 2 ** 32 }), /offset/);
    s32.store(mem, addr, s32.load(mem, addr, { align: 1 })); // sub-natural align is legal
  });
});

test("memory handle from another module is rejected", () => {
  const modA = new Module();
  const memA = modA.memory({ min: 1 });
  const modB = new Module();
  modB.function([s32], [s32]).body((addr, $) => {
    throws(() => s32.load(memA, addr), /different module/);
    $.return(addr);
  });
});

test("calling a function from another module is rejected", () => {
  const modA = new Module();
  const fnA = modA.function([], []).import("env", "f");
  const modB = new Module();
  modB.function([], []).body(($) => {
    throws(() => fnA.call(), /different module/);
  });
});

test("start function must belong to the module", () => {
  const modA = new Module();
  const fnA = modA.function([], []).import("env", "f");
  const modB = new Module();
  throws(() => modB.start(fnA), /from this module/);
});

test("body callback declaring more parameters than the signature", () => {
  const mod = new Module();
  throws(
    () => mod.function([s32], [s32]).body((a, b, $) => $.return(a)),
    /declares 3 parameters.*1 param\(s\)/s,
  );
});

test("unconsumed multi-value call result is an error", () => {
  const mod = new Module();
  const divmod = mod.function([s32, s32], [s32, s32]).import("env", "divmod");
  throws(
    () => mod.function([], []).body(($) => {
      divmod.call(s32.const(7), s32.const(2)); // tuple ignored entirely
    }),
    /never used/,
  );
  // ...but consuming any element of the tuple is fine.
  mod.function([], []).body(($) => {
    const [q] = divmod.call(s32.const(7), s32.const(2));
    $.drop(q);
  });
});
