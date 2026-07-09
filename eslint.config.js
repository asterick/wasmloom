// Flat ESLint config — self-contained (no imports), run via pinned npx in
// CI and `npm run lint`; the repo keeps zero dependencies, dev included.
const nodeGlobals = Object.fromEntries(
  [
    "console", "process", "setTimeout", "setInterval", "clearTimeout",
    "performance", "URL", "TextDecoder", "TextEncoder",
    "WebAssembly", "SharedArrayBuffer", "Atomics",
  ].map((g) => [g, "readonly"]),
);

export default [
  {
    files: ["src/**/*.js", "test/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      // correctness — the classes of defect the manual repo audit found
      "no-unused-vars": ["error", { argsIgnorePattern: "^_|^\\$\$", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-compare-neg-zero": "error",
      "no-cond-assign": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-self-assign": "error",
      "no-unsafe-negation": "error",
      "valid-typeof": "error",
      "use-isnan": "error",
      "eqeqeq": ["error", "smart"],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `$` is deliberately re-bound by every nested body callback
      "no-shadow": ["error", { allow: ["$"] }],
      "no-console": "off", // tests and the perf canary report via console
    },
  },
];
