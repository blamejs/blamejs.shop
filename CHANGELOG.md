# Changelog

One entry per released tag, grouped by minor. Latest first.

Pre-1.0 the surface is intentionally evolving — every release may
change something operators depend on. Read each entry before
upgrading across more than a few patches at a time.

## v0.0.x

- v0.0.1 (2026-05-19) — **Foundation.** Project scaffold for blamejs.shop — vendored blamejs framework + the release pipeline disciplines (structured release-notes generator, smoke-gated CHANGELOG rebuild, SLSA L3 provenance, Sigstore-keyless SBOM signatures, PQC sidecar signing). No feature surface yet; subsequent releases extend by composing the vendored blamejs primitives. **Added:** *Project skeleton* — Initial repository layout: `lib/vendor/` for the vendored blamejs tree, `scripts/` for the release-pipeline helpers (generator, consolidator, sha3-digest, sign-release-artifact, generate-release-signing-key, vendor-update.sh), `test/smoke.js` orchestrator, `test/layer-0-primitives/codebase-patterns.test.js` discipline gate, `release-notes/` JSON source of truth, plus the standard operator-facing artifacts (README, SECURITY, CHANGELOG, LICENSE). · *Vendor toolchain for blamejs* — `scripts/vendor-update.sh blamejs <tag>` shallow-clones the requested release tag from `github.com/blamejs/blamejs` into `lib/vendor/blamejs/` and updates `lib/vendor/MANIFEST.json` with the version + bundled-at date. The script's `--check` mode is wired into the smoke gate so drift between the vendored copy and the latest published blamejs release fails pre-push. · *Release pipeline disciplines* — Carries the same release flow blamejs runs: structured `release-notes/v<X>.json` generator with leak-vocabulary validation, consolidator that rolls non-current minors into `v<minor>.x.json`, `CHANGELOG.md` rebuilt end-to-end from the JSON tree, smoke gates on both `--check` modes so any drift between the JSONs and the markdown fails pre-push. **References:** [blamejs framework](https://github.com/blamejs/blamejs)
