import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, i32 } from "../src/index.js";

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("labels and gotos: sum 1..n", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("sum").body((n, $) => {
    const acc = $.variable(i32);
    const exit = $.label.ahead();

    const top = $.label();
    $.gotoIf(i32.eqz(n), exit);
    acc.set(i32.add(acc, n));
    n.set(i32.sub(n, i32.const(1)));
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
  mod.function([i32], [i32]).export("sign").body((x, $) => {
    const r = $.variable(i32);
    $.if(i32.lt_s(x, i32.const(0)), ($) => {
      r.set(i32.const(-1));
    }).elseIf(i32.gt_s(x, i32.const(0)), ($) => {
      r.set(i32.const(1));
    }).else(($) => {
      r.set(i32.const(0));
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
  mod.function([i32], [i32]).export("clamp").body((x, $) => {
    $.if(i32.gt_s(x, i32.const(100)), ($) => {
      x.set(i32.const(100));
    });
    $.return(x);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.clamp(50), 50);
  assert.equal(exports.clamp(500), 100);
});

test("$.if arms may return directly", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("abs").body((x, $) => {
    $.if(i32.lt_s(x, i32.const(0)), ($) => {
      $.return(i32.sub(i32.const(0), x));
    });
    $.return(x);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.abs(-9), 9);
  assert.equal(exports.abs(9), 9);
});

test("$.while: factorial", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("fact").body((n, $) => {
    const acc = $.variable(i32, 1);
    $.while(i32.gt_s(n, i32.const(1)), ($) => {
      acc.set(i32.mul(acc, n));
      n.set(i32.sub(n, i32.const(1)));
    });
    $.return(acc);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.fact(5), 120);
  assert.equal(exports.fact(0), 1);
});

test("nested while loops", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("tri").body((n, $) => {
    const total = $.variable(i32);
    const i = $.variable(i32, 1);
    $.while(i32.le_s(i, n), ($) => {
      const j = $.variable(i32, 1);
      $.while(i32.le_s(j, i), ($) => {
        total.set(i32.add(total, i32.const(1)));
        j.set(i32.add(j, i32.const(1)));
      });
      i.set(i32.add(i, i32.const(1)));
    });
    $.return(total);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.tri(4), 10);
});

test("mutual recursion via forward declarations", async () => {
  const mod = new Module();
  const odd = mod.function([i32], [i32]).export("odd");
  const even = mod.function([i32], [i32]).export("even");

  odd.body((n, $) => {
    $.if(i32.eqz(n), ($) => {
      $.return(i32.const(0));
    }).else(($) => {
      $.return(even.call(i32.sub(n, i32.const(1))));
    });
  });
  even.body((n, $) => {
    $.if(i32.eqz(n), ($) => {
      $.return(i32.const(1));
    }).else(($) => {
      $.return(odd.call(i32.sub(n, i32.const(1))));
    });
  });

  const { exports } = await instantiate(mod);
  assert.equal(exports.odd(7), 1);
  assert.equal(exports.odd(8), 0);
  assert.equal(exports.even(8), 1);
});

test("$.switch dispatches over labels", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("pick").body((x, $) => {
    const done = $.label.ahead();
    const r = $.variable(i32);
    const c0 = $.label.ahead();
    const c1 = $.label.ahead();
    const dflt = $.label.ahead();
    $.switch(x, [c0, c1], dflt);
    c0.here();
    r.set(i32.const(100));
    $.goto(done);
    c1.here();
    r.set(i32.const(200));
    $.goto(done);
    dflt.here();
    r.set(i32.const(-1));
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
  mod.function([i32], [i32]).export("f").body((x, $) => {
    const skip = $.label.ahead();
    $.gotoIf(x, skip);
    $.return(i32.const(11));
    skip.here();
    $.return(i32.const(22));
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

test("irreducible control flow is detected and rejected", () => {
  const mod = new Module();
  // A loop with two entries: entry jumps into B directly, while A falls into
  // B and B jumps back to A.
  mod.function([i32], [i32]).export("f").body((x, $) => {
    const a = $.label.ahead();
    const b = $.label.ahead();
    $.gotoIf(x, b);
    a.here();
    x.set(i32.add(x, i32.const(1)));
    b.here();
    $.gotoIf(i32.lt_s(x, i32.const(10)), a);
    $.return(x);
  });
  assert.throws(() => mod.emit(), /irreducible/);
});

test("collatz: loops, chains, and calls combined", async () => {
  const mod = new Module();
  mod.function([i32], [i32]).export("collatz").body((n, $) => {
    const steps = $.variable(i32);
    $.while(i32.gt_s(n, i32.const(1)), ($) => {
      $.if(i32.and(n, i32.const(1)), ($) => {
        n.set(i32.add(i32.mul(n, i32.const(3)), i32.const(1)));
      }).else(($) => {
        n.set(i32.div_s(n, i32.const(2)));
      });
      steps.set(i32.add(steps, i32.const(1)));
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
  mod.function([i32], [i32]).export("f").body((x, $) => {
    const r = $.variable(i32);
    const inside = $.label.ahead();
    $.gotoIf(i32.eq(x, i32.const(2)), inside);
    $.if(i32.eq(x, i32.const(1)), ($) => {
      r.set(i32.const(10));
      inside.here(); // placed inside the arm; jumped to from outside it
      r.set(i32.add(r, i32.const(1)));
    }).else(($) => {
      r.set(i32.const(99));
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
