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
| Maintainer commit/tag signing key | SSH-ED25519 | *(populate on first signed tag — see below)* |
| Release-signing public key        | ML-DSA-65  | *(populate after running `scripts/generate-release-signing-key.js`)* |

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

*(populate as primitives land — same convention as blamejs's `SECURITY.md`)*
