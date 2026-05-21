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

### Platform

- **Cloudflare deploy topology** — `Dockerfile` (multi-stage Node LTS, non-root, tini PID 1, vendor refresh + smoke run as build stages), `wrangler.toml` (Container + Worker + D1 + R2 + KV + Durable Objects), `worker/index.js` (edge router: health, asset pass-through, Stripe webhook signature pre-verification, D1 service-binding bridge, container forward, cold-start retry).
- **`b.externalDb` adapter for Cloudflare D1** (`lib/externaldb-d1.js`) — service-binding + REST-API modes, normalized result envelope, AbortController timeouts, jittered retry on transient errors.
- **`InventoryLock` Durable Object** — per-SKU serialization point so concurrent checkouts across container replicas can't oversell.
- **`docs/deploy-cloudflare.md`** — operator deploy recipe end-to-end.

### Commerce primitives

Every primitive is composed on the vendored blamejs surface — no npm runtime deps anywhere.

| Module | What |
|---|---|
| **`lib/catalog.js`** | Products / variants / prices (versioned, multi-currency) / inventory / media. v7 UUID PKs, `b.guardUuid` + `b.guardMime` validation, `b.safeSql` column allowlist, `b.pagination` HMAC-tagged cursors. |
| **`lib/cart.js`** | Anonymous + authenticated carts. Price snapshot at add-time. Partial-unique active-cart-per-session constraint. `merge(from, to)` on login sums qty on variant collision. |
| **`lib/pricing.js`** | Pure-function money math — `lineTotal`, `subtotal`, `totals`, `format`. Multi-currency refused, banker's-style rounding, locale-aware via `Intl.NumberFormat`. |
| **`lib/tax.js`** | Operator-table adapter. Country / state / postal_prefix → rate_bps. Most-specific-first match, banker's rounding. Pluggable adapter shape for future Stripe Tax / TaxJar / Avalara. |
| **`lib/shipping.js`** | Operator-table adapter. Services with zones (flat or per-gram + base + min/max), free-over-threshold, `digital_only` flag. |
| **`lib/payment.js`** | Stripe adapter — verify webhook (HMAC-SHA256 via upstream `b.webhook.verify` alg `hmac-sha256-stripe`), create / retrieve / confirm / cancel PaymentIntent, refund. No `stripe` npm dep — outbound through `b.httpClient` (SSRF-gated, retried, circuit-broken). |
| **`lib/order.js`** | FSM-driven post-checkout record via upstream `b.fsm`. States: pending → paid → fulfilling → shipped → delivered (+ refunded / cancelled). Every transition appends to `order_transitions`. |
| **`lib/checkout.js`** | Orchestrator. `quote()` returns priced quote; `confirm()` creates PaymentIntent + persists order in pending; `handleStripeEvent()` verifies webhook + fires the FSM transition (idempotent on re-delivery). |
| **`lib/email.js`** | Transactional templates — order receipt, ship notification, refund confirmation. Strict `{{var}}` renderer with HTML escape + refusal of unknown / unused placeholders. Composed on `b.mail` (DKIM/SPF/DMARC/BIMI upstream). |
| **`lib/storefront.js`** | Server-rendered HTML — home (product grid), product detail, cart (editable lines), checkout shipping form, Stripe Elements pay page, order confirmation. Default theme uses the `blamejs.shop` brand identity (R2-served logo, `#191919` ink + `#fa4f09` accent palette, Montserrat + Inter typography). |
| **`lib/admin.js`** | Bearer-token-gated CRUD over catalog + orders + refunds + bulk CSV import. Token compared via `b.crypto.timingSafeEqual`. Errors as RFC 9457 problem documents via `b.problemDetails`. Audit emission on every mutation. |
| **`lib/catalog-import.js`** | Bulk CSV import — `POST /admin/catalog/import` accepts a `text/csv` body, parses via `b.csv`, content-safety-filters every cell through `b.guardCsv` (formula-injection / bidi / control / dangerous-function denylist), validates exact header order, de-dupes rows by `product_slug`, returns per-row errors without aborting. Default 1 MiB / 10000 rows caps. |

### Migrations applied to D1

- `migrations-d1/0001_catalog.sql` — products, variants, prices, inventory, media
- `migrations-d1/0002_cart.sql` — carts, cart_lines (partial-unique active-cart-per-session)
- `migrations-d1/0003_order.sql` — orders, order_lines, order_transitions (FSM audit log)

### Tests

14 layer-1 test suites all running against in-memory `node:sqlite` loaded from the live migrations. Schema CHECK / UNIQUE / FK constraints exercised end-to-end.

## Operator quick-start

```
# 1. Provision CF resources
npx wrangler login
npx wrangler d1 create blamejs-shop
npx wrangler r2 bucket create blamejs-shop-assets
npx wrangler kv namespace create SESSIONS
# (paste returned ids into wrangler.toml)

# 2. Set secrets
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" \
  | npx wrangler secret put D1_BRIDGE_SECRET
# Repeat for: VAULT_PASSPHRASE, AUDIT_PASSPHRASE, AUDIT_SIGNING_PASSPHRASE,
#             BACKUP_PASSPHRASE, KEYCHAIN_PASSPHRASE, ADMIN_API_KEY
# Stripe (optional — enables checkout):
#   STRIPE_API_KEY (sk_test_… or sk_live_…)
#   STRIPE_WEBHOOK_SECRET (whsec_…)
#   STRIPE_PUBLISHABLE_KEY (pk_test_… or pk_live_…)

# 3. Apply database migrations
npx wrangler d1 migrations apply blamejs-shop --remote

# 4. Deploy
npx wrangler deploy

# 5. Seed a product via the admin API
curl -X POST https://<your-worker>.workers.dev/admin/products \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"first","title":"First product","status":"active"}'
```

See [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md) for the full deploy recipe.

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
