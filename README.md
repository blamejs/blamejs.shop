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

- **Cloudflare deploy topology** — `Dockerfile` (multi-stage Node LTS,
  non-root, tini PID 1, vendor refresh + smoke run as build stages),
  `wrangler.toml` (Container + Worker + D1 + R2 + KV + Durable
  Objects), `worker/index.js` (edge router: health, asset
  pass-through, Stripe webhook signature pre-verification, D1
  service-binding bridge, container forward).
- **`b.externalDb` adapter for Cloudflare D1** — `lib/externaldb-d1.js`
  ships the `{ connect, query, close, dialect }` shape `b.externalDb`
  consumes. Service-binding mode (container → Worker → D1, no D1 API
  token in the container) and REST-API mode (direct
  `api.cloudflare.com/.../d1/database/<id>/query`). Normalized
  `{ rows, rowCount, lastRowId }` result envelope, jittered retry on
  transient errors, AbortController-backed query timeouts.
- **InventoryLock Durable Object** — per-SKU serialization point for
  stock decrement / release, so concurrent checkouts across
  container replicas can't oversell.
- **`docs/deploy-cloudflare.md`** — operator deploy recipe end-to-end.

Commerce primitives (catalog, cart, checkout, payment, order,
inventory, tax, shipping, refund, admin, storefront theming) land in
subsequent releases.

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
