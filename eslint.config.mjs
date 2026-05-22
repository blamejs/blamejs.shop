// ESLint config for blamejs.shop.
//
// Posture: catch bug-class problems (undefined references, unused
// variables, redeclarations, equality slips, control-flow issues).
// Don't enforce style ("var" vs "const", arrow-vs-function, etc.) —
// the codebase has settled conventions documented in CLAUDE.md that
// ESLint shouldn't second-guess.
//
// Target: Node 24 LTS, CommonJS modules, ES2024 syntax. Vendored
// dependencies under `lib/vendor/` and any other build/test scratch
// directories are excluded.
//
// Standalone (no @eslint/js / globals npm dependency) so this lints
// cleanly via `npx eslint@latest --max-warnings 0 .` without resolving
// extra peer deps. Mirrors the framework's own ESLint posture.

const NODE_GLOBALS = {
  // CommonJS module system
  module:           "readonly",
  require:          "readonly",
  exports:          "writable",
  __dirname:        "readonly",
  __filename:       "readonly",
  // Node runtime
  process:          "readonly",
  Buffer:           "readonly",
  global:           "readonly",
  globalThis:       "readonly",
  console:          "readonly",
  setTimeout:       "readonly",
  setInterval:      "readonly",
  setImmediate:     "readonly",
  clearTimeout:     "readonly",
  clearInterval:    "readonly",
  clearImmediate:   "readonly",
  queueMicrotask:   "readonly",
  performance:      "readonly",
  structuredClone:  "readonly",
  // Web-platform APIs that Node 24 ships
  fetch:            "readonly",
  crypto:           "readonly",
  URL:              "readonly",
  URLSearchParams:  "readonly",
  TextEncoder:      "readonly",
  TextDecoder:      "readonly",
  AbortController:  "readonly",
  AbortSignal:      "readonly",
  Event:            "readonly",
  EventTarget:      "readonly",
  MessageChannel:   "readonly",
  MessagePort:      "readonly",
  ReadableStream:   "readonly",
  WritableStream:   "readonly",
  TransformStream:  "readonly",
  Blob:             "readonly",
  File:             "readonly",
  FormData:         "readonly",
  Headers:          "readonly",
  Request:          "readonly",
  Response:         "readonly",
  // Modern intrinsics
  BigInt:           "readonly",
  Atomics:          "readonly",
  SharedArrayBuffer:"readonly",
  WeakRef:          "readonly",
  FinalizationRegistry: "readonly",
};

const WORKER_GLOBALS = {
  // Cloudflare Workers runtime — superset of the standard Web APIs
  // with platform-specific extras (DurableObjectState, ExecutionContext,
  // etc.) introduced via type, not free identifiers, so the Web set
  // above is the binding surface ESLint needs.
  ...NODE_GLOBALS,
  caches:           "readonly",
  addEventListener: "readonly",
  removeEventListener: "readonly",
  dispatchEvent:    "readonly",
};

const COMMON_RULES = {
  // Bug-class rules
  "no-undef":                  "error",
  "no-redeclare":              "error",
  "no-const-assign":           "error",
  "no-delete-var":             "error",
  "no-shadow-restricted-names":"error",
  "no-global-assign":          "error",
  "no-import-assign":          "error",
  "no-func-assign":            "error",
  "no-class-assign":           "error",
  "no-this-before-super":      "error",
  "no-ex-assign":              "error",
  "no-cond-assign":            ["error", "except-parens"],
  "no-self-assign":            "error",
  "no-self-compare":           "error",
  "no-unreachable":            "error",
  "no-unsafe-finally":         "error",
  "no-unsafe-negation":        "error",
  "no-unsafe-optional-chaining": "error",
  "no-fallthrough":            "error",
  "no-async-promise-executor": "error",
  "use-isnan":                 "error",
  "valid-typeof":              "error",
  "getter-return":             "error",
  "no-compare-neg-zero":       "error",
  "no-constant-condition":     ["error", { checkLoops: false }],
  "no-constant-binary-expression": "error",
  "no-dupe-keys":              "error",
  "no-dupe-args":              "error",
  "no-dupe-else-if":           "error",
  "no-duplicate-case":         "error",
  "no-sparse-arrays":          "error",
  "no-invalid-regexp":         "error",
  "no-misleading-character-class": "error",
  "no-regex-spaces":           "error",
  "no-useless-backreference":  "error",
  "no-irregular-whitespace":   "error",
  "no-octal":                  "error",
  "no-debugger":               "error",
  // Strict equality — `null` allowed for the `== null` / `!= null`
  // null-or-undefined idiom; everything else must use `===` / `!==`.
  "eqeqeq":                    ["error", "always", { null: "ignore" }],
  "no-throw-literal":          "error",
  "default-case":              "error",
  "no-loss-of-precision":      "error",

  // Hygiene rules — code clarity, dead-code removal.
  "no-unused-vars":            ["error", {
    args:                      "none",
    varsIgnorePattern:         "^_",
    caughtErrors:              "all",
    caughtErrorsIgnorePattern: "^_",
    destructuredArrayIgnorePattern: "^_",
  }],
  "no-empty":                  ["error", { allowEmptyCatch: true }],
  "no-extra-boolean-cast":     "error",
  "no-unused-expressions":     ["error", { allowShortCircuit: true, allowTernary: true }],
  "no-unused-private-class-members": "error",

  // The following are intentionally OFF — they're stylistic / safe
  // patterns this codebase relies on, not bug-class signals:
  //
  //  * `no-useless-escape` — every storefront template string embeds
  //    `\"` for attribute quoting; the redundant escape is faithful
  //    to the JSON-derived form and grep-able by the renderers.
  //  * `no-promise-executor-return` — the `await new Promise((r) =>
  //    setTimeout(r, n))` idiom returns the timer id from the
  //    executor; harmless.
  //  * `no-prototype-builtins` — caller controls every shape that
  //    reaches `Object.prototype.hasOwnProperty.call(...)`; the
  //    rule's defense (untrusted-input prototype confusion) is
  //    handled at the validation primitives.
  //  * `no-control-regex` — the framework's input-shape regexes
  //    explicitly refuse control bytes; the rule treats the refusal
  //    as a smell.
  //  * `no-unused-vars` — relaxed to ignore underscore-prefixed
  //    names + destructured `_` placeholders (already configured
  //    above); the rule itself stays on.
  "no-useless-escape":         "off",
  "no-promise-executor-return":"off",
  "no-prototype-builtins":     "off",
  "no-control-regex":          "off",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "lib/vendor/**",
      "**/data/**",
      "**/.git/**",
      ".test-output/**",
      ".scratch/**",
      ".extract-staging/**",
      ".template/**",
      ".wrangler/**",
      ".playwright-mcp/**",
      ".claude/**",
    ],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType:  "commonjs",
      globals:     NODE_GLOBALS,
    },
    rules: COMMON_RULES,
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType:  "module",
      globals:     NODE_GLOBALS,
    },
    rules: COMMON_RULES,
  },
  // Cloudflare Worker entrypoint — ES module, Workers runtime globals.
  {
    files: ["worker/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType:  "module",
      globals:     WORKER_GLOBALS,
    },
    rules: COMMON_RULES,
  },
];
