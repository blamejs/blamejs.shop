# Contributing

`blamejs.shop` is an open-source ecommerce framework built on a
vendored copy of [blamejs](https://github.com/blamejs/blamejs).
The package is published as `@blamejs/blamejs-shop`; the reference
deploy runs at <https://blamejs.shop>.

## Local setup

```bash
git clone https://github.com/blamejs/blamejs.shop.git
cd blamejs.shop
bash scripts/vendor-update.sh blamejs latest
node test/smoke.js
```

The vendor step is mandatory on a fresh clone — the framework that
backs `blamejs.shop` lives at `lib/vendor/blamejs/`, populated by the
shallow git clone the script runs. Without it, `require("./lib")`
throws `MODULE_NOT_FOUND` with a pointer at the vendor script.

The smoke gate (`node test/smoke.js`) runs the full layer-0 +
layer-1 + layer-2 suite against an in-memory `node:sqlite` loaded
from the live `migrations-d1/*.sql` files. It needs no Cloudflare
credentials — everything runs offline.

## Repository layout

| Path                                   | What lives here                                                         |
|----------------------------------------|-------------------------------------------------------------------------|
| `lib/`                                 | Framework primitives (`catalog.js`, `cart.js`, `payment.js`, …)         |
| `lib/vendor/blamejs/`                  | Vendored blamejs tree — read-only, refreshed only via the vendor script |
| `worker/`                              | Cloudflare Worker (edge router, D1 service bridge)                      |
| `server.js`                            | Node entry point (the container)                                        |
| `migrations-d1/`                       | Numbered D1 migration SQL                                               |
| `themes/default/`                      | Shipped storefront theme assets                                         |
| `scripts/`                             | Release / vendor / SBOM scripts (operator-driven, not runtime deps)     |
| `release-notes/v<X>.<Y>.<Z>.json`      | Structured source of truth for each release                             |
| `test/layer-0-primitives/`             | Detectors that scan the codebase itself (codebase-patterns, etc.)       |
| `test/layer-1-<domain>/`               | Unit-style suites against `node:sqlite` + the live migrations           |
| `test/layer-2-integration/`            | Full HTTP server boot on a 127.0.0.1 ephemeral port                     |
| `test/helpers/`                        | Shared test helpers — reuse before rolling your own                     |

## What lands where

| Change shape                       | Path                                                                             |
|------------------------------------|----------------------------------------------------------------------------------|
| New primitive / new module         | `lib/<concern>.js`                                                               |
| New test                           | `test/layer-N-<name>/<thing>.test.js`                                            |
| New release-notes entry            | `release-notes/v<X>.<Y>.<Z>.json`                                                |
| New codebase-patterns detector     | `test/layer-0-primitives/codebase-patterns.test.js` (add to `KNOWN_ANTIPATTERNS`)|
| New release script                 | `scripts/<name>.js` or `scripts/<name>.sh`                                       |
| Vendor refresh                     | `bash scripts/vendor-update.sh blamejs <tag>` (never hand-edit `lib/vendor/`)    |

## Coding rules

These are inherited from blamejs's own discipline. They're enforced
by `test/layer-0-primitives/codebase-patterns.test.js` — adding new
detectors there is how you keep the rules from drifting.

- **Zero npm runtime deps.** blamejs is vendored under
  `lib/vendor/blamejs/`; everything else is Node built-ins. Dev
  tooling (eslint, gitleaks, docker images) is fine — never ships in
  the published tarball.
- **CommonJS / `var` / no TypeScript / no transpilation.** Runs on
  Node LTS as-shipped. Every transpilation step is a supply-chain
  hop.
- **Compose blamejs primitives — don't reinvent.** Reach for
  `b.guard*`, `b.crypto.*`, `b.safeSql`, `b.pagination`,
  `b.problemDetails`, `b.httpClient`, `b.webhook.verify`,
  `b.fsm`, `b.csv`, `b.mail` and friends before writing new code.
  The `b.*` surface is the contract.
- **PQC-first crypto.** Every signature / key-agreement / digest /
  KDF / password-hash choice goes through the vendored blamejs's
  primitives (ML-KEM-1024, ML-DSA-65, XChaCha20-Poly1305, SHAKE256,
  SHA3-512, HKDF-SHA3-512, Argon2id). No AES-GCM / SHA-256 /
  classical-only ECDH as application defaults.
- **Security defaults are not opt-in.** CSRF / origin / bot-guard /
  sealed storage / encrypted session / fetch-metadata / cookie
  prefixes / DoH / Trusted Types are wired into the request
  lifecycle by composing blamejs middleware, not behind config
  flags.
- **Backend validates, frontend displays.** No duplicate validation
  shipped to the client.
- **Server-rendered first.** HTML is the contract; client JS is
  opt-in islands.
- **The vendored blamejs tree is read-only.** The `vendor-hand-edit`
  detector blocks deep-imports into `lib/vendor/blamejs/`. Need a
  feature blamejs doesn't ship? File the issue upstream OR extend in
  this repo by composing the existing surface — never patch
  `lib/vendor/blamejs/` in place.
- **Add to existing files that own the domain.** Don't create new
  modules unless it's a genuinely new domain.
- **Never weaken security middleware to fix broken callers.** Fix
  the callers.
- **Never add `NODE_ENV=test` bypasses to skip encryption / auth.**
  Tests exercise the production code path.

## Testing

```bash
# Full gate (what CI runs).
node test/smoke.js

# Layer-1: unit-style suites against in-memory node:sqlite.
node test/layer-1-catalog/<suite>.test.js

# Layer-2: full HTTP server boot + browser-style flow.
node test/layer-2-integration/<suite>.test.js

# Layer-0: codebase-itself detectors (anti-pattern scans).
node test/layer-0-primitives/codebase-patterns.test.js
```

Test waits use `helpers.waitUntil(predicate, opts)` — never
`await new Promise(r => setTimeout(r, N))`. The
`test-promise-settimeout-sleep` detector enforces this; a fixed
sleep is the canonical source of "passes alone, fails under load"
flakiness.

Before writing a fresh fixture, scan `test/helpers/` — the helpers
land first when a primitive ships, so the helper you need probably
already exists.

## Release flow

The release flow is operator-driven (humans run it; CI gates each
step). Patches (`0.0.x`) are the default — minor bumps require an
explicit decision.

```bash
# 1. Bump version
#    Edit package.json — patch unless explicitly chosen as minor.

# 2. Author the release-notes JSON for this version.
#    release-notes/v<X>.<Y>.<Z>.json — see release-notes/_schema.md
#    or an existing entry for the shape.

# 3. Rebuild CHANGELOG.md from the JSON tree.
node scripts/generate-changelog-entry.js --rebuild

# 4. Static gates (cheapest first).
npx eslint@latest --max-warnings 0 .
node test/layer-0-primitives/codebase-patterns.test.js
node scripts/generate-changelog-entry.js --check
node scripts/consolidate-release-notes.js --check
bash scripts/vendor-update.sh --check

# 5. Smoke
node test/smoke.js

# 6. Commit on a release branch.
git checkout -b release/vX.Y.Z
git add -A && git commit -s -m "0.X.Y — short operator-facing summary"
git log -1 --pretty='%h %G? %GS'    # must print "<sha> G <email>"

# 7. Push the release branch + open a PR against main.
git push -u origin release/vX.Y.Z
gh pr create --base main --head release/vX.Y.Z \
  --title "0.X.Y — short operator-facing summary" \
  --body "<test plan + summary>"
gh pr checks --watch

# 8. Admin-merge the PR (squash) once CI is green and any
#    review threads are resolved. The PR is merged by a
#    repository admin; non-admins do not self-merge.
gh pr merge --squash --delete-branch

# 9. Tag the merged commit on main + push the tag.
git checkout main && git pull origin main
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
git tag -v vX.Y.Z   # must print "Good "git" signature"

# 10. Watch the publish workflow.
gh run watch "$(gh run list --workflow=npm-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh release view vX.Y.Z --json assets --jq '.assets | map(.name)'
```

The publish workflow produces, for every release:

- `blamejs-shop-X.Y.Z.tgz` (the npm tarball, also pushed to npm with
  `--provenance`)
- `blamejs-shop-X.Y.Z.tgz.sha256` + `.sha3-512` (byte digests)
- `blamejs-shop-X.Y.Z.intoto.jsonl` (SLSA L3 provenance)
- `sbom.cdx.json` + `sbom.cdx.json.sigstore` (npm-tree SBOM,
  Sigstore-keyless cosign bundle)
- `sbom.vendored.cdx.json` + `sbom.vendored.cdx.json.sigstore`
  (the vendored-blamejs SBOM, separately signed)
- `blamejs-shop-X.Y.Z.tgz.mldsa.sig` (ML-DSA-65 PQC signature, when
  the `RELEASE_PQC_SIGNING_KEY` secret is configured)

See `SECURITY.md` for the verification recipe.

## Discussions, issues, PRs

- Open an issue first for any change that adds operator-facing
  surface (new primitive, breaking change, new compliance posture).
  Small bug fixes can skip straight to a PR.
- Every PR description includes a **Test plan** — checkbox list of
  the gates you ran locally (`eslint`, `smoke`,
  `codebase-patterns`, `gitleaks`).
- PR titles describe the change in operator-facing voice. Operators
  upgrading the framework read these; they don't share the
  contributor's internal vocabulary. Skip phase / pass / batch /
  tier / sweep / group numbering and any AI-tooling attribution.

## Reporting security issues

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/blamejs/blamejs.shop/security/advisories/new) — never open a public issue. See [`SECURITY.md`](SECURITY.md) for the full policy, the supply-chain verification recipe, and the application checklist.
