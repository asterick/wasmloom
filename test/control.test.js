import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, s64, funcref, bool } from "../src/index.js";

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("labels and gotos: sum 1..n", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("sum").body((n, $) => {
    const acc = $.variable(s32);
    const exit = $.label.ahead();

    const top = $.label();
    $.gotoIf(s32.eqz(n), exit);
    acc.set(s32.add(acc, n));
    n.set(s32.sub(n, s32.const(1)));
    $.goto(top);

    exit.here();
    $.return(acc);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sum(10), 55);
  assert.equal(exports.sum(0), 0);
  assert.equal(exports.sum(1), 1);
});

test("$.if / .elseIf / .else chain", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("sign").body((x, $) => {
    const r = $.variable(s32);
    $.if(s32.lt(x, s32.const(0)), ($) => {
      r.set(s32.const(-1));
    }).elseIf(s32.gt(x, s32.const(0)), ($) => {
      r.set(s32.const(1));
    }).else(($) => {
      r.set(s32.const(0));
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sign(-5), -1);
  assert.equal(exports.sign(7), 1);
  assert.equal(exports.sign(0), 0);
});

test("$.if without else", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("clamp").body((x, $) => {
    $.if(s32.gt(x, s32.const(100)), ($) => {
      x.set(s32.const(100));
    });
    $.return(x);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.clamp(50), 50);
  assert.equal(exports.clamp(500), 100);
});

test("$.if arms may return directly", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("abs").body((x, $) => {
    $.if(s32.lt(x, s32.const(0)), ($) => {
      $.return(s32.sub(s32.const(0), x));
    });
    $.return(x);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.abs(-9), 9);
  assert.equal(exports.abs(9), 9);
});

test("$.while: factorial", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("fact").body((n, $) => {
    const acc = $.variable(s32, 1);
    $.while(s32.gt(n, s32.const(1)), ($) => {
      acc.set(s32.mul(acc, n));
      n.set(s32.sub(n, s32.const(1)));
    });
    $.return(acc);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.fact(5), 120);
  assert.equal(exports.fact(0), 1);
});

test("nested while loops", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("tri").body((n, $) => {
    const total = $.variable(s32);
    const i = $.variable(s32, 1);
    $.while(s32.le(i, n), ($) => {
      const j = $.variable(s32, 1);
      $.while(s32.le(j, i), ($) => {
        total.set(s32.add(total, s32.const(1)));
        j.set(s32.add(j, s32.const(1)));
      });
      i.set(s32.add(i, s32.const(1)));
    });
    $.return(total);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.tri(4), 10);
});

test("mutual recursion via forward declarations", async () => {
  const mod = new Module();
  const odd = mod.function([s32], [s32]).export("odd");
  const even = mod.function([s32], [s32]).export("even");

  odd.body((n, $) => {
    $.if(s32.eqz(n), ($) => {
      $.return(s32.const(0));
    }).else(($) => {
      $.return(even.call(s32.sub(n, s32.const(1))));
    });
  });
  even.body((n, $) => {
    $.if(s32.eqz(n), ($) => {
      $.return(s32.const(1));
    }).else(($) => {
      $.return(odd.call(s32.sub(n, s32.const(1))));
    });
  });

  const { exports } = await instantiate(mod);
  assert.equal(exports.odd(7), 1);
  assert.equal(exports.odd(8), 0);
  assert.equal(exports.even(8), 1);
});

test("$.switch dispatches over labels", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("pick").body((x, $) => {
    const done = $.label.ahead();
    const r = $.variable(s32);
    const c0 = $.label.ahead();
    const c1 = $.label.ahead();
    const dflt = $.label.ahead();
    $.switch(x, [c0, c1], dflt);
    c0.here();
    r.set(s32.const(100));
    $.goto(done);
    c1.here();
    r.set(s32.const(200));
    $.goto(done);
    dflt.here();
    r.set(s32.const(-1));
    done.here();
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.pick(0), 100);
  assert.equal(exports.pick(1), 200);
  assert.equal(exports.pick(9), -1);
});

test("goto skipping forward over code", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const skip = $.label.ahead();
    $.gotoIf(bool.of(x), skip);
    $.return(s32.const(11));
    skip.here();
    $.return(s32.const(22));
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(0), 11);
  assert.equal(exports.f(1), 22);
});

test("$.unreachable traps", async () => {
  const mod = new Module();
  mod.function([], []).export("boom").body(($) => {
    $.unreachable();
  });
  const { exports } = await instantiate(mod);
  assert.throws(() => exports.boom(), WebAssembly.RuntimeError);
});

test("irreducible control flow: a two-entry loop compiles and runs", async () => {
  const mod = new Module();
  // A loop with two entries: entry jumps into B directly, while A falls into
  // B and B jumps back to A. Lowered by node splitting in the reduce pass.
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const a = $.label.ahead();
    const b = $.label.ahead();
    $.gotoIf(bool.of(x), b);
    a.here();
    x.set(s32.add(x, s32.const(1)));
    b.here();
    $.gotoIf(s32.lt(x, s32.const(10)), a);
    $.return(x);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(0), 10); // enters at A, increments to 10
  assert.equal(exports.f(5), 10); // enters at B, loops back through A
  assert.equal(exports.f(42), 42); // enters at B, exits immediately
});

test("collatz: loops, chains, and calls combined", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("collatz").body((n, $) => {
    const steps = $.variable(s32);
    $.while(s32.gt(n, s32.const(1)), ($) => {
      $.if(bool.of(s32.and(n, s32.const(1))), ($) => {
        n.set(s32.add(s32.mul(n, s32.const(3)), s32.const(1)));
      }).else(($) => {
        n.set(s32.div(n, s32.const(2)));
      });
      steps.set(s32.add(steps, s32.const(1)));
    });
    $.return(steps);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.collatz(1), 0);
  assert.equal(exports.collatz(6), 8);
  assert.equal(exports.collatz(27), 111);
});

test("label placed inside a sugar callback (labels are function-scoped)", async () => {
  const mod = new Module();
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const r = $.variable(s32);
    const inside = $.label.ahead();
    $.gotoIf(s32.eq(x, s32.const(2)), inside);
    $.if(s32.eq(x, s32.const(1)), ($) => {
      r.set(s32.const(10));
      inside.here(); // placed inside the arm; jumped to from outside it
      r.set(s32.add(r, s32.const(1)));
    }).else(($) => {
      r.set(s32.const(99));
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(1), 11); // through the whole arm
  assert.equal(exports.f(2), 1); // jumped past the first set
  assert.equal(exports.f(0), 99); // else arm
});

test("label cannot be placed inside another function's body", () => {
  const mod = new Module();
  let leaked;
  mod.function([], []).body(($) => {
    leaked = $.label.ahead();
    $.goto(leaked); // reference it so the unplaced check doesn't fire first
    leaked.here();
  });
  mod.function([], []).body(($) => {
    assert.throws(() => $.label.ahead() && leaked.here(), /already placed/);
  });
});

test("label cannot be placed after its body completes", () => {
  const mod = new Module();
  let escaped;
  mod.function([], []).body(($) => {
    escaped = $.label.ahead();
    // intentionally never placed inside; also never referenced
  });
  assert.throws(() => escaped.here(), /not currently being built/);
});

test("unplaced label from a foreign body cannot be placed there either", () => {
  const mod = new Module();
  let escaped;
  mod.function([], []).body(($) => {
    escaped = $.label.ahead();
  });
  mod.function([], []).body(($) => {
    assert.throws(() => escaped.here(), /not currently being built/);
  });
});

test("tail calls: deep accumulator recursion reuses the frame", async () => {
  const mod = new Module();
  const sum = mod.function([s32, s32], [s32]);
  sum.body((n, acc, $) => {
    $.if(s32.eqz(n), ($) => $.return(acc));
    $.returnCall(sum, s32.sub(n, s32.const(1)), s32.add(acc, n));
  });
  mod.function([s32], [s32]).export("sum").body((n, $) => {
    $.returnCall(sum, n, s32.const(0));
  });
  const { exports } = await instantiate(mod);
  // ten million frames would overflow any real stack without return_call
  assert.equal(exports.sum(10_000_000), ((10_000_001 * 5_000_000) % 2 ** 32) | 0);
  assert.equal(exports.sum(3), 6);
});

test("tail calls: mutual recursion (even/odd)", async () => {
  const mod = new Module();
  const even = mod.function([s32], [s32]);
  const odd = mod.function([s32], [s32]);
  even.body((n, $) => {
    $.if(s32.eqz(n), ($) => $.return(s32.const(1)));
    $.returnCall(odd, s32.sub(n, s32.const(1)));
  });
  odd.body((n, $) => {
    $.if(s32.eqz(n), ($) => $.return(s32.const(0)));
    $.returnCall(even, s32.sub(n, s32.const(1)));
  });
  mod.function([s32], [s32]).export("even").body((n, $) => $.returnCall(even, n));
  const { exports } = await instantiate(mod);
  assert.equal(exports.even(1_000_000), 1);
  assert.equal(exports.even(1_000_001), 0);
});

test("tail calls: indirect through a table", async () => {
  const mod = new Module();
  const sig = mod.funcType([s32], [s32]);
  const dbl = mod.function([s32], [s32]).body((x, $) => $.return(s32.mul(x, s32.const(2))));
  const neg = mod.function([s32], [s32]).body((x, $) => $.return(s32.sub(s32.const(0), x)));
  const tbl = mod.table(funcref, { min: 2 });
  mod.elem([dbl, neg]).at(tbl, 0);
  mod.function([s32, s32], [s32]).export("dispatch").body((i, x, $) => {
    $.returnCall(tbl, sig, u32.cast(i), x);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.dispatch(0, 21), 42);
  assert.equal(exports.dispatch(1, 21), -21);
});

test("tail calls: eager errors for mismatched results, args, and handles", () => {
  const mod = new Module();
  const wrongResults = mod.function([], [s64]).body(($) => $.return(s64.const(0n)));
  const callee = mod.function([s32], [s32]).body((x, $) => $.return(x));
  mod.function([s32], [s32]).body((x, $) => {
    assert.throws(() => $.returnCall(wrongResults), /must exactly match this function's results/);
    assert.throws(() => $.returnCall(callee), /expects 1 argument/);
    assert.throws(() => $.returnCall(callee, s64.const(1n)), /expected s32, got s64/);
    assert.throws(() => $.returnCall({}), /expected a function handle/);
    $.return(x);
  });
});
