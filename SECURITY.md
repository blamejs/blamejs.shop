# Security policy

## Supported versions

Pre-1.0 — only the latest tagged release is supported. Operators
upgrade across breaking changes; deprecation warnings ship at least
one minor before removal.

## Reporting

Report security issues privately via [GitHub Security Advisories](https://github.com/blamejs/blamejs.shop/security/advisories/new) — do NOT open a public issue for a vulnerability.

Acknowledgement within 72 hours; remediation timeline scales with
severity per the standard CVD playbook (24h critical / 7d high / 30d
medium / 90d low). CVE assignment via the GHSA flow.

## Verifying release authenticity

Every release ships with FOUR independent trust roots, each verifiable
without trusting any of the others:

### 1. Signed commit + signed tag

Commits and tags are SSH-signed. Verify against the published key:

```
curl -fsSL https://github.com/<maintainer>.keys > /tmp/maintainer.keys
# Write a local `allowed_signers` file binding the key to the
# maintainer email + `git` namespace, then:
git tag -v vX.Y.Z
```

Expected: `Good "git" signature`. The maintainer SSH-signing-key
fingerprint is published at the bottom of this file.

### 2. SLSA L3 provenance

Every GitHub Release ships `<tarball>.intoto.jsonl` produced by
`slsa-framework/slsa-github-generator` (commit-SHA-pinned). Verify
the npm tarball against the attestation:

```
slsa-verifier verify-artifact <tarball> \
  --provenance-path <tarball>.intoto.jsonl \
  --source-uri github.com/blamejs/blamejs.shop \
  --source-tag vX.Y.Z
```

### 3. Sigstore-keyless SBOM signatures

Both SBOMs (`sbom.cdx.json` + `sbom.vendored.cdx.json`) ship with
`.sigstore` bundles signed via OIDC + Fulcio + Rekor (no
long-lived keys). Verify:

```
cosign verify-blob sbom.cdx.json \
  --bundle sbom.cdx.json.sigstore \
  --certificate-identity-regexp 'https://github.com/blamejs/blamejs\.shop/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

### 4. Byte digests + ML-DSA-65 signature (PQC-first)

The release tarball ships with three digest / signature sidecars
covering its exact bytes:

- `<tarball>.sha256` — conventional checksum (`sha256sum -c`)
- `<tarball>.sha3-512` — SHA3-512 digest (`openssl dgst -sha3-512`)
- `<tarball>.mldsa.sig` — ML-DSA-65 signature (FIPS 204) over the
  tarball bytes, verifiable with the vendored noble-post-quantum
  primitive

The ML-DSA-65 public key is committed at `keys/release-pqc-pub.json`.
Its SHA3-512 fingerprint is published below (this file is itself
commit-signed, so the fingerprint is verifiable out-of-band against
the signed git history).

```
# Verify the PQC sig sidecar (no Sigstore dependency)
node -e "
  var b = require('./lib/vendor/blamejs');
  var fs = require('node:fs');
  var pub = JSON.parse(fs.readFileSync('keys/release-pqc-pub.json', 'utf8')).publicKey;
  var sig = fs.readFileSync(process.argv[1]);
  var msg = fs.readFileSync(process.argv[2]);
  var pubBytes = Buffer.from(pub, 'base64url');
  if (!b.pqcSoftware.ml_dsa_65.verify(sig, msg, pubBytes)) process.exit(1);
" <tarball>.mldsa.sig <tarball>
```

## Public keys + fingerprints

| Purpose                           | Algorithm  | Fingerprint               |
|-----------------------------------|------------|---------------------------|
| Maintainer commit/tag signing key | SSH-ED25519 | `SHA256:5oF/XWhFpMde9TRfEX2GAHiApAq/MXOS4vti5zQbD7g` (cross-check against `https://github.com/<maintainer>.keys` — see below) |
| Release-signing public key        | ML-DSA-65 (FIPS 204) | `d40e1e2b06a2509271cc3cf76bd34c63d2fbb093f42e1e1f6b349288900ec044509ca183b3d735cda003d80eb6cf5d80fd9181ad897889e1c1f701d61b7902c9` (SHA3-512 of `keys/release-pqc-pub.json#publicKey`) |

To populate the maintainer SSH fingerprint:
```
ssh-keygen -lf <(curl -fsSL https://github.com/<maintainer>.keys)
```

To populate the ML-DSA-65 fingerprint:
```
node -e "
  var b = require('./lib/vendor/blamejs');
  var fs = require('node:fs');
  var pub = JSON.parse(fs.readFileSync('keys/release-pqc-pub.json', 'utf8')).publicKey;
  process.stdout.write(JSON.parse(fs.readFileSync('keys/release-pqc-pub.json', 'utf8')).fingerprint_sha3_512);
"
```

## Application checklist

- **D1 bridge secret.** When deploying on Cloudflare, the container
  reaches D1 through a Worker service binding. The bridge is gated by
  a shared-secret header (`X-D1-Bridge-Secret`) so the route only
  accepts SQL from the bound container even if the binding is
  accidentally exposed. Generate ≥ 32 bytes of OS randomness and set
  the value identically on the Worker (`wrangler secret put
  D1_BRIDGE_SECRET`) and the container env. Rotate quarterly or after
  any Worker-credential compromise.
- **Stripe webhook signature.** Inbound `POST` to
  `/api/webhooks/stripe` is signature-verified at the Worker edge
  (HMAC-SHA256 over `<timestamp>.<body>`, 5-minute tolerance window)
  before forwarding to the container. The container re-verifies the
  same signature defense-in-depth via `b.webhook.verify` (alg
  `hmac-sha256-stripe`) inside `lib/payment.js` before any FSM
  transition runs. An unsigned or out-of-window delivery never
  touches origin resources.
- **Worker → Container trust boundary.** The Worker treats the
  container as untrusted-for-D1: it never proxies arbitrary headers
  into D1, only the explicit `sql` + `params` from the bridge body.
  The container treats the Worker as untrusted-for-customer-data: it
  re-validates every input from forwarded requests against the
  framework's `b.guard*` primitives.
- **Vault passphrase at boot.** `VAULT_PASSPHRASE` is read from
  `wrangler secret`, never logged, and used once to unseal the
  framework's at-rest key material. Operators MUST rotate the
  passphrase via `b.vault.rotate` after any container image rebuild
  that changed a vendored crypto dependency.
- **Reviews are purchase-gated and operator-moderated.** A review can
  only be submitted by a signed-in customer who has a completed order
  for that product; the route confirms the purchase before accepting
  and re-checks it on the POST, so a direct request can't plant a
  review for a product the account never bought. Submissions land in a
  `pending` state and never reach the storefront until an operator
  publishes them through `/admin/reviews`. The author identity is
  stored hash-only (`b.crypto.namespaceHash`) — the raw email is never
  persisted.
- **Product Q&A is operator-moderated user-generated content.** A
  customer question is stored `pending` and never reaches the product
  page until an operator approves it through `/admin/questions`;
  customer-submitted answers are not accepted from the storefront at
  all — only the operator posts the authoritative answer, and it too
  lands `pending` until approved. So neither an unmoderated question nor
  an unmoderated reply can ever surface publicly. Author identity is the
  customer id (verified against the customers primitive) or a hash-only
  email — the raw address is never persisted.
- **Gift-card codes are bearer secrets, stored hash-only.** A gift
  card's plaintext code is shown exactly once at issuance and never
  persisted — only its `namespaceHash` digest plus a 4-character hint
  for operator support lookups. Balance, lookup, and redeem hash the
  submitted code and compare in constant time, so the store can't leak
  a code even from a full database dump. The customer balance page
  (`/gift-cards`) is not a code-existence oracle: unknown, malformed,
  expired, voided, and fully-redeemed codes all return the same generic
  "couldn't find a balance" so it can't be used to probe valid codes.
  Redemption decrements with an atomic `balance >= amount` SQL guard
  keyed on the order id, so concurrent or replayed checkouts can never
  overdraw a card or apply more than the remaining balance.
- **Loyalty points are account-scoped money — earned and spent under
  the same double-spend discipline.** The `/account/loyalty` page and
  the redeem actions are login-gated and read the customer id from the
  sealed session cookie, never from request input, so a customer only
  ever sees and spends their own balance. Points earned on a paid order
  are awarded fire-and-forget off the request path and deduped on the
  order id (`loyalty_earn_log`'s `(rule, customer, event-ref)` UNIQUE),
  so a re-delivered payment webhook can't double-credit. Spending points
  — redeeming a reward or applying a checkout credit — debits through
  the same atomic `balance >= points` SQL guard, so concurrent or
  replayed requests can't overdraw. A checkout credit is capped at both
  the order total and the live balance (a request for more than either
  is refused, not silently clamped to a windfall), and a guest cart
  with no account can't redeem at all.
- **Referral rewards are fraud-guarded — no self-referral, no
  double-attribution, no double-reward.** The `/r/<code>` landing only
  sets the attribution cookie for a live, active code and never reveals
  whether a guessed code exists (unknown / malformed / disabled all
  redirect home identically). A new account is attributed to the
  referrer named in the sealed cookie, with a self-referral guard so a
  code can never refer its own owner, and each customer is attributed
  only once (first-touch); an existing customer signing back in is never
  re-attributed. The reward fires only when a referred customer's first
  order reaches paid, rides the order's paid transition fire-and-forget,
  and is recorded once per order so a re-delivered payment webhook can't
  double-reward — guest orders and later orders don't qualify. Referred
  emails are stored hash-only (`b.crypto.namespaceHash`), and the
  account leaderboard exposes rank plus initials only, never an email or
  account id.
- **Privileged actions are recorded and reviewable.** Every mutating
  admin action and every catalog-API error is appended to a
  tamper-evident, hash-chained audit log (the framework's `b.audit`
  surface — append-only, verified at boot). Operators review it at
  `/admin/audit`: a read-only activity log filterable by outcome
  (success / failure / denied) and paginated. Opening the log is itself
  recorded (an `audit.read` row), so reviewing the audit trail leaves
  its own forensic mark.
- **Email deliverability — SPF / DKIM / DMARC + one-click unsubscribe.**
  Transactional and broadcast mail is composed on `b.mail`, which signs
  each message with DKIM, but the receiving server still rejects or
  spam-folders mail whose envelope DNS isn't published. Publish all
  three records for the From: domain:
    - **SPF:** a TXT record on the sending domain authorizing the
      service that emits the envelope (e.g. `v=spf1
      include:<your-relay> -all`). `b.mail` signs the body but does not
      control the envelope sender, so SPF must name whatever relay
      actually delivers.
    - **DKIM:** `b.mail.dkim` generates the `DKIM-Signature` header;
      publish the matching public key as a TXT record at
      `<selector>._domainkey.<domain>`. The selector is the one
      configured for the signing key.
    - **DMARC:** publish `_dmarc.<domain>` with at least
      `v=DMARC1; p=quarantine; rua=mailto:<aggregate-report-mailbox>`.
      Align the SPF and DKIM domains with the From: domain so DMARC
      passes; raise to `p=reject` once aggregate reports are clean.
    - **One-click unsubscribe (RFC 8058):** the broadcast path emits
      `List-Unsubscribe` plus `List-Unsubscribe-Post:
      List-Unsubscribe=One-Click` (composed on `b.guardListUnsubscribe`).
      Keep the unsubscribe endpoint reachable from the public origin —
      mailbox providers fetch it directly, and an unreachable endpoint
      hurts sender reputation.
- **Database backup & recovery.** Two layers protect the live D1
  database:
    - **D1 Time Travel (always on).** Cloudflare retains a rolling
      30-day point-in-time history of the database with no setup.
      Recover with `wrangler d1 time-travel restore blamejs-shop
      --timestamp <ISO-8601>` (or `--bookmark <id>`); inspect the
      current bookmark with `wrangler d1 time-travel info blamejs-shop`.
    - **Scheduled logical export.** `node scripts/d1-export.js --to-r2`
      (or `npm run d1-export -- --to-r2`) produces a full `.sql` dump of
      the live database and uploads it to the private `backups/` key in
      the assets R2 bucket. Schedule it from the operator's own
      cron / CI on whatever cadence the retention policy requires; it is
      not wired into the deploy. The dump bears all customer data —
      treat the R2 `backups/` prefix as sensitive. It is NOT on the
      Worker's served asset path (the Worker serves only
      `/assets/themes/...` and `brand/`), so a backup object is never
      web-reachable.
- **Supply-chain integrity — vendored bytes are verified on every
  build.** `lib/vendor/MANIFEST.json` pins a per-file SHA-256 of the
  entire vendored blamejs tree. The smoke gate (run in CI on every
  push/PR and inside the container image build) recomputes each file's
  digest and compares it against the manifest via the framework's own
  `b.configDrift.verifyVendorIntegrity`, so a hand-edit to any vendored
  source — or a vendor refresh that skipped re-stamping — fails the
  build before it can ship. Refresh + re-stamp is a single command
  (`scripts/vendor-update.sh blamejs <tag>`).
