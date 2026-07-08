import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateDts } from "../scripts/generate-dts.js";

// The committed declarations are generated from the veneer registry; adding
// an instruction without regenerating (`npm run types`) fails here.

test("index.d.ts matches the veneer registry", () => {
  const committed = readFileSync(new URL("../index.d.ts", import.meta.url), "utf8");
  assert.equal(
    committed,
    generateDts(),
    "index.d.ts is stale — run `npm run types` and commit the result",
  );
});

test("generated declarations cover every namespace and stay well-formed", () => {
  const dts = generateDts();
  for (const ns of ["s32", "u64", "f64", "bool", "funcref", "s8x16", "u32x4", "f64x2", "m64x2"]) {
    assert.ok(dts.includes(`export const ${ns}: Ns_${ns};`), `missing namespace export ${ns}`);
  }
  for (const member of ["trunc_sat", "extadd_pairwise", "load_lane(", "shuffle(", "bitselect(", "q15mulr_sat("]) {
    assert.ok(dts.includes(member), `missing member ${member}`);
  }
  // cheap structural sanity: braces balance
  const opens = (dts.match(/{/g) ?? []).length;
  const closes = (dts.match(/}/g) ?? []).length;
  assert.equal(opens, closes, "unbalanced braces in generated .d.ts");
});
