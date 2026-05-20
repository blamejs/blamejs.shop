# Contributing

## Local setup

```
git clone https://github.com/blamejs/blamejs.shop.git
cd blamejs.shop
bash scripts/vendor-update.sh blamejs latest
node test/smoke.js
```

The vendor step is mandatory on a fresh clone — the framework that
backs blamejs.shop lives at `lib/vendor/blamejs/`, populated by the
shallow git clone the script runs. Without it, `require("./lib")`
throws a `MODULE_NOT_FOUND` with a pointer at the vendor script.

## What lands where

| Change shape                       | Path                                       |
|------------------------------------|--------------------------------------------|
| New primitive / new module         | `lib/<concern>.js`                         |
| New test                           | `test/layer-N-<name>/<thing>.test.js`      |
| New release-notes entry            | `release-notes/v<X>.<Y>.<Z>.json`          |
| New codebase-patterns detector     | `test/layer-0-primitives/codebase-patterns.test.js` (add to `KNOWN_ANTIPATTERNS`) |
| New release script                 | `scripts/<name>.js` or `scripts/<name>.sh` |
| Vendor refresh                     | `bash scripts/vendor-update.sh blamejs <tag>` (never hand-edit `lib/vendor/`) |

## Release flow

The release flow is operator-driven (humans run it; CI gates each
step):

```
# 1. Bump package.json
# 2. Author release-notes/v<X>.<Y>.<Z>.json
node scripts/generate-changelog-entry.js --rebuild
npx eslint@latest --max-warnings 0 .
node test/layer-0-primitives/codebase-patterns.test.js
node scripts/generate-changelog-entry.js --check
node scripts/consolidate-release-notes.js --check
bash scripts/vendor-update.sh --check
node test/smoke.js

# 3. Commit on a release branch
git checkout -b release/vX.Y.Z
git add -A && git commit -m "<operator-facing headline>"
git push -u origin release/vX.Y.Z

# 4. Open + merge PR (after CI green + Codex threads resolved)
# 5. Tag on main
git checkout main && git pull
git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z

# 6. Watch the publish workflow + verify the GH release + npm publish
gh run watch "$(gh run list --workflow=npm-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

## Coding rules

- **Zero npm runtime deps.** blamejs is vendored; everything else is
  Node built-ins. Dev tooling (eslint, gitleaks, docker images) is
  fine — never ships.
- **PQC-first crypto.** Compose blamejs primitives; don't reach for
  classical defaults.
- **Backend validates.** Frontend displays.
- **CommonJS / `var` / no TypeScript / no transpilation.**
- **Tests use `helpers.waitUntil`, not `setTimeout(r, N)`.** The
  `test-promise-settimeout-sleep` detector enforces this.
- **The vendored blamejs tree is read-only.** The `vendor-hand-edit`
  detector forbids deep-imports into `lib/vendor/blamejs/`.

## Discussions, issues, PRs

- Open an issue first for any change that adds operator-facing
  surface (new primitive, breaking change, new compliance posture).
  Small bug fixes can skip straight to a PR.
- Every PR description includes a **Test plan** — checkbox list of
  the gates you ran locally (`eslint`, `smoke`, `codebase-patterns`,
  `gitleaks`).
- PR titles describe the change in operator-facing voice. No
  internal vocabulary (phase / sweep / tier / batch / group /
  slice numbering), no AI-tooling attribution.

## Reporting security issues

Use [GitHub Security Advisories](https://github.com/blamejs/blamejs.shop/security/advisories/new) — never open a public issue for a vulnerability. See `SECURITY.md` for the full policy.
