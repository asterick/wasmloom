import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The manual's examples are executable documentation: every fenced ```js
// block in docs/*.md that imports from "wasmloom" is a complete program and
// runs here (against the local source). Examples signal failure by throwing —
// they contain their own assertions. Fragments simply don't import.

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));
const srcUrl = new URL("../src/index.js", import.meta.url).href;

// Final-spec exception handling postdates Node 22's V8 — EH examples skip
// on engines without it (same gate as test/exceptions.test.js).
const supportsEH =
  typeof WebAssembly.Tag === "function" &&
  WebAssembly.validate(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 4, 1, 96, 0, 0,
    3, 2, 1, 0,
    13, 3, 1, 0, 0,
    10, 6, 1, 4, 0, 8, 0, 11,
  ]));

function examplesOf(file) {
  const text = readFileSync(docsDir + file, "utf8");
  const blocks = [...text.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.filter((b) => b.includes('from "wasmloom"'));
}

const pages = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
let total = 0;

for (const page of pages) {
  const examples = examplesOf(page);
  total += examples.length;
  test(`docs examples run: ${page} (${examples.length})`, () => {
    for (const [i, source] of examples.entries()) {
      if (!supportsEH && source.includes(".tag(")) continue; // EH example on an old engine
      const code = source.replaceAll('"wasmloom"', JSON.stringify(srcUrl));
      try {
        execFileSync(process.execPath, ["--input-type=module", "-e", code], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        const detail = e.stderr?.toString().split("\n").slice(0, 6).join("\n");
        assert.fail(`${page} example #${i + 1} failed:\n${detail}\n--- source ---\n${source}`);
      }
    }
  });
}

test("the manual has a real number of executable examples", () => {
  assert.ok(total >= 20, `only ${total} executable examples across docs/`);
});

// Cross-links are part of the manual's contract: every relative link must
// name an existing page, and every #anchor must match a heading in it.
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[`*()]/g, "")
    .replace(/[^a-z0-9_\- ]/g, "")
    .trim()
    .replace(/ +/g, "-");
}

test("docs cross-links resolve (files and anchors)", () => {
  const anchors = new Map();
  for (const page of pages) {
    const text = readFileSync(docsDir + page, "utf8");
    const heads = [...text.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1]));
    anchors.set(page, new Set(heads));
  }
  const broken = [];
  for (const page of pages) {
    const text = readFileSync(docsDir + page, "utf8");
    for (const [, target] of text.matchAll(/\]\(([a-z0-9-]+\.md(?:#[^)]+)?)\)/g)) {
      const [file, anchor] = target.split("#");
      if (!anchors.has(file)) broken.push(`${page}: missing page ${target}`);
      else if (anchor && !anchors.get(file).has(anchor)) broken.push(`${page}: missing anchor ${target}`);
    }
    for (const [, anchor] of text.matchAll(/\]\(#([^)]+)\)/g)) {
      if (!anchors.get(page).has(anchor)) broken.push(`${page}: missing local anchor #${anchor}`);
    }
  }
  assert.deepEqual(broken, []);
});
