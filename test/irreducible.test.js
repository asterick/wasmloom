import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, u32, bool } from "../src/index.js";

// Behavioral coverage for the reduce pass (passes/reduce.js): irreducible
// CFGs are lowered by node splitting, with a dispatch-loop fallback once
// splitting exceeds the block budget. The CFG fuzzer exercises this
// statistically; these are the crafted shapes.

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("br_table into the middle of a loop: three-entry cycle", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("f").body((sel, x, $) => {
    const l0 = $.label.ahead();
    const l1 = $.label.ahead();
    const l2 = $.label.ahead();
    $.switch(u32.rem(u32.cast(sel), u32.const(3)), [l0, l1, l2], l0);
    l0.here();
    x.set(s32.add(x, s32.const(1)));
    l1.here();
    x.set(s32.add(x, s32.const(10)));
    l2.here();
    x.set(s32.add(x, s32.const(100)));
    $.gotoIf(s32.lt(x, s32.const(500)), l0);
    $.return(x);
  });

  const ref = (sel, x) => {
    x |= 0;
    let i = (sel >>> 0) % 3;
    for (;;) {
      if (i === 0) x = (x + 1) | 0;
      if (i <= 1) x = (x + 10) | 0;
      x = (x + 100) | 0;
      if (x >= 500) return x;
      i = 0;
    }
  };

  const { exports } = await instantiate(mod);
  for (const sel of [0, 1, 2, 5, -1]) {
    for (const x of [0, 3, 499, 500, -50]) {
      assert.equal(exports.f(sel, x), ref(sel, x), `sel ${sel}, x ${x}`);
    }
  }
});

test("multi-use temp defined before a split region is seen by both copies", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("f").body((a, b, $) => {
    const k = s32.mul(a, s32.const(3)); // multi-use: evaluated once, up front
    const p = $.label.ahead();
    const q = $.label.ahead();
    $.gotoIf(bool.of(b), q); // q is the loop's second entry — its region splits
    p.here();
    a.set(s32.add(a, k));
    q.here();
    a.set(s32.add(a, k));
    $.gotoIf(s32.lt(a, s32.const(100)), p);
    $.return(a);
  });

  const ref = (a, b) => {
    a |= 0;
    const k = Math.imul(a, 3);
    let at = b !== 0 ? "q" : "p";
    for (;;) {
      if (at === "p") a = (a + k) | 0;
      a = (a + k) | 0;
      if (a >= 100) return a;
      at = "p";
    }
  };

  const { exports } = await instantiate(mod);
  for (const a of [1, 7, 40, 99]) {
    for (const b of [0, 1]) {
      assert.equal(exports.f(a, b), ref(a, b), `a ${a}, b ${b}`);
    }
  }
});

test("two-entry loop nested inside a counted outer loop", async () => {
  const mod = new Module();
  mod.function([s32, s32], [s32]).export("f").body((n, x, $) => {
    const outer = $.label();
    const a = $.label.ahead();
    const b = $.label.ahead();
    $.gotoIf(bool.of(s32.and(x, s32.const(1))), b);
    a.here();
    x.set(s32.add(x, s32.const(1)));
    b.here();
    x.set(s32.add(x, s32.const(2)));
    $.gotoIf(s32.lt(x, s32.const(20)), a);
    n.set(s32.sub(n, s32.const(1)));
    $.gotoIf(s32.gt(n, s32.const(0)), outer);
    $.return(x);
  });

  const ref = (n, x) => {
    n |= 0;
    x |= 0;
    do {
      let at = (x & 1) !== 0 ? "b" : "a";
      for (;;) {
        if (at === "a") x = (x + 1) | 0;
        x = (x + 2) | 0;
        if (x >= 20) break;
        at = "a";
      }
      n = (n - 1) | 0;
    } while (n > 0);
    return x;
  };

  const { exports } = await instantiate(mod);
  for (const n of [1, 3]) {
    for (const x of [0, 1, 19, 25]) {
      assert.equal(exports.f(n, x), ref(n, x), `n ${n}, x ${x}`);
    }
  }
});

// A complete switch web: every node br_tables to every other, the classic
// exponential case for node splitting. Splitting cascades until the block
// budget is spent, so this deterministically exercises the dispatch-loop
// fallback as well.
test("complete switch web: cascaded splitting falls back to the dispatch loop", async () => {
  const N = 8;
  const mod = new Module();
  mod.function([s32], [s32]).export("run").body((x, $) => {
    const steps = $.variable(s32);
    const labels = Array.from({ length: N }, () => $.label.ahead());
    const exit = $.label.ahead();
    $.switch(u32.rem(u32.cast(x), u32.const(N)), labels, labels[0]);
    for (let i = 0; i < N; i++) {
      labels[i].here();
      x.set(s32.add(s32.mul(x, s32.const((i % 5) + 1)), s32.const(i * 13 + 7)));
      steps.set(s32.add(steps, s32.const(1)));
      $.gotoIf(s32.gt(steps, s32.const(50)), exit);
      $.switch(u32.rem(u32.cast(x), u32.const(N)), labels, labels[0]);
    }
    exit.here();
    $.return(x);
  });

  const ref = (x) => {
    x |= 0;
    let steps = 0;
    for (;;) {
      const i = (x >>> 0) % N;
      x = (Math.imul(x, (i % 5) + 1) + (i * 13 + 7)) | 0;
      if (++steps > 50) return x;
    }
  };

  const { exports } = await instantiate(mod);
  for (const x of [0, 1, 7, -3, 12345, 999999, -987654]) {
    assert.equal(exports.run(x), ref(x), `input ${x}`);
  }
});

test("irreducible lowering is deterministic: identical bytes across builds", () => {
  const build = () => {
    const mod = new Module();
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
    return mod.emit();
  };
  assert.deepEqual(build(), build());
});
