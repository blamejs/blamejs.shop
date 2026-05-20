# blamejs.shop

Open-source framework built on [blamejs](https://github.com/blamejs/blamejs). Vendored stack, zero npm runtime deps, PQC-first crypto, security-on by default.

## Requirements

- Node.js LTS (>= 24.14.1)

## Install

```
git clone https://github.com/blamejs/blamejs.shop.git
cd blamejs.shop
bash scripts/vendor-update.sh blamejs latest
node test/smoke.js
```

## What ships

*(populate as primitives land — same convention as blamejs's `README.md`)*

## Vendoring blamejs

`blamejs.shop` vendors blamejs as a shallow git clone of the release tag
into `lib/vendor/blamejs/`. Refresh:

```
bash scripts/vendor-update.sh blamejs <tag>
bash scripts/vendor-update.sh blamejs latest
bash scripts/vendor-update.sh --check    # CI gate: fails on drift
bash scripts/vendor-update.sh --diff     # show changelog vendored vs latest
```

The vendored tree is read-only; hand-edits are forbidden. The
`vendor-hand-edit` codebase-patterns detector blocks deep-imports
into vendored internals. Need a feature blamejs doesn't ship?
File the issue upstream OR extend in this repo by composing the
existing surface.

## Security

See [`SECURITY.md`](SECURITY.md) for the verification recipe (SLSA L3
provenance + Sigstore-keyless SBOM signatures + SHA-256 + SHA3-512 +
ML-DSA-65 release-signing).

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
