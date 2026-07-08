import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, i32, i64, f32, f64, WasmEmitError } from "../src/index.js";

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmEmitError && re.test(e.message));

test("type mismatch throws at the call site", () => {
  const mod = new Module();
  mod.function([f64], [i32]).body((x, $) => {
    throws(() => i32.add(x, i32.const(1)), /i32\.add operand 1: expected i32, got f64/);
    $.return(i32.const(0));
  });
});

test("no implicit wrapping of JS numbers", () => {
  const mod = new Module();
  mod.function([], [i32]).body(($) => {
    throws(() => i32.add(i32.const(1), 2), /expected an expression.*i32\.const\(2\)/s);
    $.return(i32.const(0));
  });
});

test("constant range validation", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    throws(() => i32.const(2 ** 32), /outside/);
    throws(() => i32.const(1.5), /integer/);
    throws(() => i64.const(2 ** 53), /safe integer/);
    throws(() => i64.const(2n ** 64n), /outside/);
    throws(() => f32.const("1"), /number/);
    i64.const(2n ** 64n - 1n); // max unsigned ok
    i32.const(0xffffffff); // unsigned spelling ok
  });
});

test("arity mismatches", () => {
  const mod = new Module();
  const f = mod.function([i32, i32], [i32]).import("env", "f");
  mod.function([], []).body(($) => {
    throws(() => f.call(i32.const(1)), /expected 2 argument\(s\), got 1/);
    throws(() => $.return(i32.const(1)), /returns 0 value\(s\), got 1/);
  });
});

test("unconsumed call result is an error at body completion", () => {
  const mod = new Module();
  const f = mod.function([], [i32]).import("env", "f");
  throws(
    () => mod.function([], []).body(($) => { f.call(); }),
    /never used.*\$\.drop/s,
  );
});

test("function that can fall off the end without returning", () => {
  const mod = new Module();
  throws(
    () => mod.function([], [i32]).body(($) => {}),
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
  const v = mod.variable(i32, 5).immutable();
  mod.function([], []).body(($) => {
    throws(() => v.set(i32.const(1)), /immutable/);
  });
});

test("immutable() rejected on function-scoped variables", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    const v = $.variable(i32);
    throws(() => v.immutable(), /locals are always mutable/);
  });
});

test("duplicate export name", () => {
  const mod = new Module();
  mod.function([], []).body(() => {}).export("x");
  throws(() => mod.variable(i32).export("x"), /duplicate export name/);
});

test("module variable init must be a constant expression", () => {
  const mod = new Module();
  mod.function([], []).body(($) => {
    throws(() => mod.variable(i32, i32.add(i32.const(1), i32.const(2))), /constant expression/);
  });
  // Referencing another variable is validated at emit (its .import()/.immutable()
  // may legally chain after this declaration).
  const mutable = mod.variable(i32, 1);
  mod.variable(i32, mutable);
  throws(() => mod.emit(), /imported immutable/);
});

test("imported variable cannot have an initializer", () => {
  const mod = new Module();
  throws(() => mod.variable(i32, 5).import("env", "x"), /cannot have an initializer/);
});

test("cross-function expression use", () => {
  const mod = new Module();
  let leaked;
  mod.function([], []).body(($) => { leaked = i32.const(1); leaked = i32.add(leaked, leaked); $.drop(leaked); });
  throws(
    () => mod.function([], [i32]).body(($) => { $.return(leaked); }),
    /different function body/,
  );
});

test("expressions require an active body", () => {
  throws(() => i32.add(i32.const(1), i32.const(2)), /no active function body/);
});

test("elseIf after an intervening statement", () => {
  const mod = new Module();
  mod.function([i32], []).body((x, $) => {
    const chain = $.if(x, () => {});
    $.drop(i32.const(1));
    throws(() => chain.elseIf(x, () => {}), /finalized by an intervening statement/);
  });
});

test("else called twice", () => {
  const mod = new Module();
  mod.function([i32], []).body((x, $) => {
    const chain = $.if(x, () => {});
    chain.else(() => {});
    throws(() => chain.else(() => {}), /already has an \.else/);
  });
});

test("second memory rejected", () => {
  const mod = new Module();
  mod.memory({ min: 1 });
  throws(() => mod.memory({ min: 1 }), /at most one memory/);
});

test("start function signature checked", () => {
  const mod = new Module();
  const f = mod.function([i32], []).import("env", "f");
  throws(() => mod.start(f), /no parameters and no results/);
});

test("non-dominating multi-use is rejected at emit", () => {
  const mod = new Module();
  const next = mod.function([], [i32]).import("env", "next");
  mod.function([i32], [i32]).export("f").body((c, $) => {
    let x;
    $.if(c, () => { x = next.call(); $.drop(x); });
    $.return(x); // second use outside the arm that created it
  });
  throws(() => mod.emit(), /does not dominate all uses/);
});

test("debug mode includes creation site in errors", () => {
  const mod = new Module({ debug: true });
  const f = mod.function([], [i32]).import("env", "f");
  try {
    mod.function([], []).body(($) => { f.call(); });
    assert.fail("expected a WasmEmitError");
  } catch (e) {
    assert.ok(e instanceof WasmEmitError);
    assert.match(e.message, /Created at:/);
    assert.match(e.message, /errors\.test\.js/);
  }
});
