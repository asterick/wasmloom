import { test } from "node:test";
import assert from "node:assert/strict";
import { Module, s32, s64, bool, exnref, WasmLoomError } from "../src/index.js";

// Exception handling (wasm 3.0): tags, $.throw/$.throwRef, and the
// $.try().catch/.catchRef/.catchAll/.catchAllRef chain. Final-spec EH
// (try_table/exnref) postdates Node 22's V8, so everything runtime-gates.

const supportsEH =
  typeof WebAssembly.Tag === "function" &&
  WebAssembly.validate(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 4, 1, 96, 0, 0,
    3, 2, 1, 0,
    13, 3, 1, 0, 0,
    10, 6, 1, 4, 0, 8, 0, 11, // body: throw 0
  ]));
const opts = { skip: !supportsEH && "engine lacks wasm 3.0 exception handling" };

const throws = (fn, re) => assert.throws(fn, (e) => e instanceof WasmLoomError && re.test(e.message));

async function instantiate(mod, imports = {}) {
  const bytes = mod.emit();
  assert.ok(WebAssembly.validate(bytes), "emitted module failed WebAssembly.validate");
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

test("throw/catch: payload delivery, clause order, catchAll", opts, async () => {
  const mod = new Module();
  const oops = mod.tag([s32, s32]);
  const minor = mod.tag([]);
  mod.function([s32, s32], [s32]).export("f").body((n, d, $) => {
    const r = $.variable(s32);
    $.try(($) => {
      $.if(s32.eqz(d), ($) => $.throw(oops, n, s32.const(7)));
      $.if(s32.lt(d, s32.const(0)), ($) => $.throw(minor));
      r.set(s32.div(n, d));
    }).catch(oops, (code, detail, $) => {
      r.set(s32.add(s32.mul(code, s32.const(-1)), detail));
    }).catchAll(($) => {
      r.set(s32.const(-999));
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(10, 2), 5); // no throw
  assert.equal(exports.f(3, 0), 4); // oops(3, 7) → -3 + 7
  assert.equal(exports.f(3, -1), -999); // minor → catchAll
});

test("exceptions unwind through calls to the nearest matching handler", opts, async () => {
  const mod = new Module();
  const err = mod.tag([s32]);
  const boom = mod.function([s32], []);
  boom.body((x, $) => $.throw(err, s32.mul(x, s32.const(2))));
  const middle = mod.function([s32], []).body((x, $) => {
    boom.call(x);
    $.return();
  });
  mod.function([s32], [s32]).export("f").body((x, $) => {
    const r = $.variable(s32);
    $.try(($) => {
      middle.call(x);
      r.set(s32.const(0));
    }).catch(err, (v, $) => {
      r.set(v);
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(21), 42); // unwound two frames
});

test("catchRef + throwRef preserve exception identity through rethrow", opts, async () => {
  const mod = new Module();
  const oops = mod.tag([s32, s32]);
  const cleanups = mod.variable(s32).export("cleanups");
  const inner = mod.function([], []);
  inner.body(($) => $.throw(oops, s32.const(5), s32.const(6)));
  mod.function([], [s32]).export("f").body(($) => {
    const r = $.variable(s32);
    $.try(($) => {
      $.try(($) => {
        inner.call();
      }).catchAllRef((exn, $) => {
        cleanups.set(s32.add(cleanups, s32.const(1)));
        $.throwRef(exn); // rethrow: outer catch still sees tag + payload
      });
      r.set(s32.const(0));
    }).catch(oops, (a, b, $) => {
      r.set(s32.add(a, b));
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), 11);
  assert.equal(exports.cleanups.value, 1);
});

test("exnref is a variable type; caught exceptions can be stashed and rethrown later", opts, async () => {
  const mod = new Module();
  const err = mod.tag([s32]);
  mod.function([], [s32]).export("f").body(($) => {
    const stash = $.variable(exnref);
    const r = $.variable(s32);
    $.try(($) => $.throw(err, s32.const(9)))
      .catchRef(err, (v, exn, $) => {
        r.set(v);
        stash.set(exn);
      });
    $.try(($) => $.throwRef(stash)) // rethrow the stashed exception
      .catch(err, (v, $) => {
        r.set(s32.add(r, s32.mul(v, s32.const(10))));
      });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), 99); // 9 + 9*10
});

test("full sugar inside try bodies; variables cross the boundary", opts, async () => {
  const mod = new Module();
  const stop = mod.tag([]);
  mod.function([s32], [s32]).export("sumUntil").body((n, $) => {
    const acc = $.variable(s32);
    $.try(($) => {
      const i = $.variable(s32, 1);
      $.while(bool.const(true), ($) => {
        acc.set(s32.add(acc, i));
        $.if(s32.ge(i, n), ($) => $.throw(stop));
        i.set(s32.add(i, s32.const(1)));
      });
    }).catch(stop, ($) => {
      acc.set(s32.add(acc, s32.const(1000)));
    });
    $.return(acc);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.sumUntil(4), 1010);
});

test("throw arguments take safe promotion", opts, async () => {
  const mod = new Module();
  const big = mod.tag([s64]);
  mod.function([s32], [s64]).export("f").body((x, $) => {
    const r = $.variable(s64);
    $.try(($) => $.throw(big, x)) // s32 lifts into the s64 payload slot
      .catch(big, (v, $) => r.set(v));
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(-7), -7n);
});

test("uncaught exceptions surface to JS; JS exceptions enter via imported tags", opts, async () => {
  const mod = new Module();
  const werr = mod.tag([s32]).export("werr");
  const jsTag = mod.tag([s32]).import("env", "jsTag");
  const poke = mod.function([], []).import("env", "poke");
  mod.function([], []).export("boom").body(($) => $.throw(werr, s32.const(41)));
  mod.function([], [s32]).export("guarded").body(($) => {
    const r = $.variable(s32);
    $.try(($) => {
      poke.call(); // JS throws a WebAssembly.Exception with jsTag
      r.set(s32.const(0));
    }).catch(jsTag, (v, $) => {
      r.set(v);
    });
    $.return(r);
  });

  const tag = new WebAssembly.Tag({ parameters: ["i32"] });
  const { exports } = await instantiate(mod, {
    env: {
      jsTag: tag,
      poke: () => { throw new WebAssembly.Exception(tag, [123]); },
    },
  });
  assert.equal(exports.guarded(), 123);
  try {
    exports.boom();
    assert.fail("expected a WebAssembly.Exception");
  } catch (e) {
    assert.ok(e instanceof WebAssembly.Exception);
    assert.ok(e.is(exports.werr));
    assert.equal(e.getArg(exports.werr, 0), 41);
  }
});

test("island rule: gotos and labels may not cross try boundaries", () => {
  const mod = new Module();
  const t = mod.tag([]);
  void t;
  mod.function([], []).body(($) => {
    const outer = $.label.ahead();
    $.try(($) => {
      throws(() => $.goto(outer), /may not cross/);
      const inner = $.label.ahead();
      void inner;
    });
    outer.here();
    $.return();
  });
  mod.function([], []).body(($) => {
    let leakedInner;
    $.try(($) => {
      leakedInner = $.label.ahead();
      void $;
    });
    throws(() => $.goto(leakedInner), /may not cross/);
    throws(() => leakedInner.here(), /may not cross/);
    $.return();
  });
});

test("chain guardrails: clause order, duplicates, finalization", () => {
  const mod = new Module();
  const a = mod.tag([]);
  const b = mod.tag([]);
  mod.function([], []).body(($) => {
    const chain = $.try(($) => {}).catch(a, ($) => {});
    throws(() => chain.catch(a, ($) => {}), /duplicate catch/);
    chain.catchAll(($) => {});
    throws(() => chain.catch(b, ($) => {}), /unreachable/);
    $.return();
  });
  mod.function([], []).body(($) => {
    const chain = $.try(($) => {});
    $.drop(s32.const(1)); // intervening statement finalizes the chain
    throws(() => chain.catchAll(($) => {}), /finalized by an intervening statement/);
    $.return();
  });
  throws(() => new Module().tag([s32]) && mod.function([], []).body(($) => {
    $.throw(new Module().tag([]), );
  }), /different module/);
});

test("tail conversion is suppressed inside try — the callee stays protected", opts, async () => {
  const mod = new Module();
  const err = mod.tag([s32]);
  const thrower = mod.function([], [s32]);
  thrower.body(($) => $.throw(err, s32.const(13)));
  mod.function([], [s32]).export("f").body(($) => {
    const r = $.variable(s32);
    $.try(($) => {
      $.return(thrower.call()); // if this tail-converted, the catch would miss
    }).catch(err, (v, $) => {
      r.set(v);
    });
    $.return(r);
  });
  const { exports } = await instantiate(mod);
  assert.equal(exports.f(), 13);
});

test("emit is byte-stable with exception constructs", opts, () => {
  const build = () => {
    const mod = new Module();
    const t = mod.tag([s32]);
    mod.function([], [s32]).export("f").body(($) => {
      const r = $.variable(s32);
      $.try(($) => $.throw(t, s32.const(1)))
        .catch(t, (v, $) => r.set(v))
        .catchAll(($) => r.set(s32.const(2)));
      $.return(r);
    });
    return mod.emit();
  };
  assert.deepEqual([...build()], [...build()]);
});
