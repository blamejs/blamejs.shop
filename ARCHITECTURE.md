# Architecture

## Stack

```
┌──────────────────────────────────────────────────────────────────┐
│  blamejs.shop application code (lib/, server.js, scripts/)       │
├──────────────────────────────────────────────────────────────────┤
│  blamejs framework (vendored)                                    │
│  lib/vendor/blamejs/                                             │
│  ├─ lib/                  ← Node primitives                      │
│  └─ lib/vendor/           ← blamejs's own vendored deps          │
│     ├─ noble-ciphers.cjs                                         │
│     ├─ noble-post-quantum.cjs                                    │
│     ├─ pki.cjs                                                   │
│     ├─ simplewebauthn-server.cjs                                 │
│     └─ ...                                                       │
├──────────────────────────────────────────────────────────────────┤
│  Node.js LTS (>= 24.18.0) — built-in crypto, fs, http2, etc.     │
└──────────────────────────────────────────────────────────────────┘
```

The application layer has **zero npm runtime dependencies**. Every
crypto / identity / DB / web-server primitive comes from the
vendored blamejs surface. blamejs in turn vendors every server-side
crypto / identity dep it consumes (noble-ciphers, noble-post-quantum,
SimpleWebAuthn, the Peculiar PKI stack, etc.) so the entire
dependency tree below this file is a fixed set of CJS bundles + Node
built-ins.

## Why vendor blamejs at all

Three reasons:

1. **Supply-chain immutability.** blamejs is shallow-cloned at a
   specific release tag and frozen at `lib/vendor/blamejs/`. The tag
   is recorded in `lib/vendor/MANIFEST.json`. Upgrades go through
   `scripts/vendor-update.sh blamejs <tag>` — a single chokepoint
   the operator audits.
2. **PQC-first defaults.** blamejs ships its security defaults on
   (CSRF / origin / bot-guard / sealed storage / encrypted session /
   fetch-metadata / cookie prefixes / DoH / Trusted Types). Pulling
   it via npm at install time would invite a transient dep-tree to
   sneak in; vendoring keeps the boot surface deterministic.
3. **Audit transparency.** The vendored tree carries its OWN
   `MANIFEST.json` at `lib/vendor/blamejs/lib/vendor/MANIFEST.json`
   listing every transitive dep blamejs bundles. Operators
   running Trivy / Grype / OSV-Scanner see the full chain without
   needing a node_modules tree.

## Vendor refresh flow

```
bash scripts/vendor-update.sh --check        # CI gate (read-only)
bash scripts/vendor-update.sh --diff         # show changelog drift
bash scripts/vendor-update.sh blamejs latest # pull the latest GH release tag
bash scripts/vendor-update.sh blamejs vX.Y.Z # pin to a specific tag
```

`--check` is wired into the smoke gate — drift between
`lib/vendor/MANIFEST.json` and the latest published blamejs release
fails pre-push. CI re-vendors fresh on every run (the workflow
calls `vendor-update.sh blamejs latest`), so the published tarball
captures the framework version that CI exercised.

## Composition pattern

Application code composes blamejs primitives; it does not subclass /
patch / extend them in place. Forbidden:

```js
// ✗ Deep-import bypasses the MANIFEST + breaks vendor refresh
var sign = require("./lib/vendor/blamejs/lib/audit-sign.js");
```

Required:

```js
// ✓ Top-level require; the entry point handles internals
var b = require("./lib/vendor/blamejs");
var sig = b.audit.sign(...);
```

The `vendor-hand-edit` codebase-patterns detector at
`test/layer-0-primitives/codebase-patterns.test.js` blocks the
forbidden shape.

## Release pipeline

Every release ships with four independently-verifiable trust roots —
see `SECURITY.md` for the operator-side verification recipes:

1. **Signed commit + signed tag** (SSH-Ed25519 maintainer key)
2. **SLSA L3 provenance** (`*.intoto.jsonl` via
   `slsa-framework/slsa-github-generator`, SHA-pinned)
3. **Sigstore-keyless SBOM signatures** (`*.sigstore` via cosign)
4. **PQC byte signatures** (`.sha256` + `.sha3-512` digests +
   `.mldsa.sig` via the vendored noble-post-quantum primitive)

The PQC sidecar skips gracefully when the operator hasn't yet
completed the one-time `generate-release-signing-key.js` setup;
every other root still ships.

## Test pyramid

```
Layer 0  test/layer-0-primitives/         pure primitives + static gates
Layer 1  test/layer-1-state/              state-bearing (db, vault, session)
Layer 2  test/layer-2-integration/        operator-facing surface
```

The smoke orchestrator (`test/smoke.js`) walks the layers in order,
fails fast, and persists every line of stdout/stderr to
`.test-output/smoke.log` via synchronous fd writes — so a fatal
failure mid-run still leaves a readable log on disk.

The Layer 0 catalog at
`test/layer-0-primitives/codebase-patterns.test.js` is the single
source of truth for "we already swept this class of bug once and
don't want it to drift back in." Every Codex finding on a PR adds a
detector in the same commit as the fix.
