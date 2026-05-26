# blamejs.shop

[![npm](https://img.shields.io/npm/v/%40blamejs%2Fblamejs-shop?logo=npm&label=%40blamejs%2Fblamejs-shop)](https://www.npmjs.com/package/@blamejs/blamejs-shop)
&nbsp;
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
&nbsp;
[![SLSA Level 3](https://slsa.dev/images/gh-badge-level3.svg)](https://slsa.dev)

Open-source ecommerce framework built on [blamejs](https://github.com/blamejs/blamejs). Vendored stack, zero npm runtime deps, PQC-first crypto, security-on by default.

Homepage: **https://blamejs.shop**

## Requirements

- Node.js LTS (>= 24.14.1)
- For a deployable shop: a Cloudflare account (Workers, Containers, D1, R2, KV, Durable Objects). Local development works without it via `node:sqlite`.

## Install

```bash
npm install @blamejs/blamejs-shop
```

```js
var bShop = require("@blamejs/blamejs-shop");
var b     = bShop.framework;                // the vendored blamejs
var d1    = bShop.externaldbD1;             // Cloudflare D1 adapter
var cat   = bShop.catalog.create({ query }); // catalog primitive
```

Or clone for development:

```bash
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
| **`lib/payment.js`** | Payment adapters — **Stripe** (verify webhook HMAC-SHA256 via upstream `b.webhook.verify`, create / retrieve / confirm / cancel PaymentIntent, refund, register / list payment-method domains for Apple/Google Pay) and **PayPal** (`adapter: "paypal"` — OAuth2 client-credentials token, create / capture / get / refund Orders v2, webhook verify via PayPal's verify-webhook-signature API). No `stripe` / `paypal` npm dep — outbound through `b.httpClient` (SSRF-gated, retried, circuit-broken). |
| **`lib/order.js`** | FSM-driven post-checkout record via upstream `b.fsm`. States: pending → paid → fulfilling → shipped → delivered (+ refunded / cancelled). Every transition appends to `order_transitions`. |
| **`lib/checkout.js`** | Orchestrator. `quote()` returns priced quote; `confirm()` creates a Stripe PaymentIntent + persists order pending; `handleStripeEvent()` verifies webhook + fires the FSM transition. PayPal path: `createPaypalOrder()` opens a PayPal order + persists pending, `capturePaypalOrder()` captures → paid, `handlePaypalEvent()` is the webhook backstop. All idempotent on re-delivery. |
| **`lib/email.js`** | Transactional templates — order receipt, ship notification, refund confirmation. Strict `{{var}}` renderer with HTML escape + refusal of unknown / unused placeholders. Composed on `b.mail` (DKIM/SPF/DMARC/BIMI upstream). |
| **`lib/storefront.js`** | Server-rendered HTML — utility bar + sticky header + dark hero with code-preview card + primitives marquee + featured-product callout + collections grid + framework feature band + designed catalog grid + newsletter band + four-column footer. Designed surfaces also for PDP, cart, checkout, pay, order, account login / register / dashboard, search results, `/admin` API landing, 404. Image-bearing cards on the home + search grids pull from `catalog.media`. The default theme stylesheet is external (R2-served `themes/default/assets/css/main.css`) and CSP-compliant; the typeface (Inter / Inter Tight) is self-hosted from `themes/default/assets/fonts`, so no page loads a cross-origin font. Operators override by uploading a replacement at the same key, by passing `opts.theme_css` to renderers, or by registering a named theme through the `theme` primitive. |
| **`lib/customers.js`** | Customer accounts — passkey (WebAuthn) + **Sign in with Google / Apple** (OIDC). Email is stored hash-only (`b.crypto.namespaceHash` namespace `customer-email`); the raw address never lands in D1. Passkey credentials carry CBOR-encoded public keys, transport hints, and SHA3-512-fingerprinted attestation. `signInWithOIDC` keys federated accounts on the provider `(provider, subject)` and links an existing account only on a provider-verified email (never on an unverified one). `mintAppleClientSecret` produces Apple's required ES256 client-secret JWT from a Services-ID `.p8` key (the one classical signature the protocol mandates; the PQC default doesn't apply to an external IdP's wire format). Account routes (`/account/login`, `/account/register`, `/account`, `/account/login/google`, `/account/login/apple`) ship as designed cards on the storefront. |
| **`lib/reviews.js`** | Operator-moderated product ratings. Submission requires a signed-in customer **and** a verified purchase — `/products/:slug/review` confirms a completed order for the product (via `order.hasPurchasedProduct`) before accepting, re-checked on POST; reviews land `pending`. Author identity is hash-only (`b.crypto.namespaceHash`); the raw email is never stored. The PDP renders the average, per-star distribution, and published reviews with `AggregateRating` JSON-LD. `/admin/reviews` is the moderation queue (`listByStatus` → publish / reject). |
| **`lib/wishlist.js`** | Per-customer saved products. The PDP renders a login-gated "Save to wishlist" toggle and a "N shoppers saved this" social-proof count; `/account/wishlist` lists saved items (remove + reopen, orphan-tolerant when a product is archived). `POST /wishlist/toggle` is idempotent (`INSERT OR IGNORE`) and redirects to the canonical product slug or a safe same-origin `return_to`. UUID-shape-validated ids, `b.pagination` HMAC cursors. |
| **`lib/save-for-later.js`** | Per-customer cart holding list. Each cart line gets a login-gated "Save for later" control (`POST /cart/lines/:id/save` → `moveFromCart`); `/account/saved` lists items with Move-to-cart / Remove. `moveToCart` reprices to the current catalog price and stock-gates (out-of-stock + non-backorderable is refused). Composes `catalog.inventory` + `catalog.prices` + `catalog.variants`. |
| **`lib/addresses.js`** | Per-customer address book at `/account/addresses` — add / edit / set default shipping or billing / remove. One-default-per-role invariant (promoting clears the prior). Every by-id route confirms the address belongs to the signed-in customer before acting (a guessed id returns 404). `b.guardUuid` ids, 2-char ISO country. |
| **`lib/returns.js`** | Self-serve RMAs. Customer requests a return against their own order at `/account/orders/:id/return` (items + reason, ownership-checked, lines built from the order's own records) and tracks status at `/account/returns`. Operators work `/admin/returns` — approve (refund amount) / mark received / refund / reject — over the pending → approved → received → refunded FSM; illegal transitions are 409, bad ids 404. |
| **`lib/loyalty.js`** + **`lib/loyalty-earn-rules.js`** + **`lib/loyalty-redemption.js`** | Customer rewards. `loyalty` owns the points balance, lifetime total, tier (bronze → platinum on operator-tunable thresholds), and an audited transaction ledger. `loyalty-earn-rules` defines how points are minted (per-dollar-spent, per-order, signup, birthday, …) keyed to lifecycle events; `loyalty-redemption` is the reward catalog customers spend points against. Customers see all of it at `/account/loyalty` — balance + tier, the earn rules in plain language, the reward catalog with a one-click Redeem, past redemptions, and the paginated earn/redeem ledger (login-gated). Paid orders award points automatically: the order FSM's paid transition fans out to the earn rules fire-and-forget, deduped on the order id so a re-delivered payment webhook never double-credits. At checkout a signed-in customer can spend points for a credit against the order total — valued by the redemption ratio (100 points = $1 default), capped at the order's worth and the balance, debited once behind a balance-guarded SQL decrement, stacking with any gift-card credit; surplus points stay in the balance. |
| **`lib/referrals.js`** + **`lib/referral-leaderboard.js`** | Refer-a-friend with two-sided rewards. `referrals` issues each customer an 8-character code (32-glyph confusion-resistant alphabet via `b.crypto.generateBytes`) and tracks each referred friend through the funnel (invited → visited → joined → converted); referred emails are stored hash-only (`b.crypto.namespaceHash`), never plaintext. `referral-leaderboard` sits on top for top-referrer rankings + operator-tunable tier bonuses. Customers see all of it at `/account/referrals` — their code, an absolute shareable link, the friends they've referred (funnel stage + dates, no personal data), and an in-account leaderboard (rank + initials only). A public `/r/<code>` landing captures an inbound referral into a short-lived sealed first-party cookie (first-touch), which attributes the new customer to the referrer when they sign up by passkey / Google / Apple — self-referral and double-attribution guarded. When a referred customer's first order reaches paid, the order FSM's paid transition marks that referral converted and bumps the referrer's count fire-and-forget, deduped on the order id so a re-delivered webhook never double-counts; guest orders and a customer's later orders don't qualify. Issuing the payout itself (gift card / store credit / loyalty points) is an explicit operator action via the referrals reward API, so the reward instrument and any fraud review stay the operator's. |
| **`lib/recently-viewed.js`** | Signed-in customer browse history. A product-page visit records the view server-side against the customer's account (drop-silent — never blocks the page); `/account/recently-viewed` lists them newest-first as a grid with a Clear-history control. De-duped + capped per customer, archived products drop out, login-gated. Guest/session history is opt-in (a client beacon) and not shipped — the lib's `forSession` + `merge` support it. |
| **`lib/recommendations.js`** | Product-recommendation engine. Operator-curated override pins first (`setOverride` — "when viewing A, show B", kind-scoped + weight-ordered), then a signal-based fallback: co-purchase (products bought in the same orders), category-popular, and in-stock-random filler. `recommendForProduct` / `recommendForCart` / `recommendForCustomer` / `recommendForCategory` each return renderable picks (active + in-stock, source product excluded). The order confirmation page (`/orders/:id`) renders a "Customers also bought" rail from it — best-effort, anchored on the order's items, excluding what was just bought. |
| **`lib/collections.js`** | Curated + smart product groupings. `GET /collections` lists the shop's active collections; `GET /collections/:slug` renders the grid — manual collections list hand-picked members, smart collections evaluate stored rules against the active catalog and apply the collection's sort strategy. Each product resolves fresh, so archived products drop out. Public, no sign-in; a bad or unknown slug is a 404 (never a 500). Linked from the footer on every page. |
| **`lib/category-navigation.js`** | Hierarchical category tree surfaced as public browse pages. `GET /categories` lists the active top-level categories as a card grid; `GET /categories/:slug` renders one category — its title and optional description, a breadcrumb chain from the catalog root down to the current category, an optional hero image, and a grid of the category's direct child sub-categories. Each page reads fresh against the active tree, so archived / unpublished categories drop out of every surface. Public, no sign-in; an unknown, archived, or malformed slug is a 404 (never a 500), and a category with no children renders a graceful empty state. Linked from the footer on every page. The tree itself (define / move / reorder / archive, with cycle defense bounded by `MAX_TREE_DEPTH`) is operator-managed through the primitive's write API. |
| **`lib/subscriptions.js`** | Stripe-backed recurring billing — `subscription_plans` (interval / amount / trial) + `subscriptions` (mirrors Stripe's object byte-for-byte). `subscriptions.create` POSTs to Stripe via the payment dep, then persists the returned object locally. `handleStripeEvent` replays `customer.subscription.*` events into the local row so the shop has an authoritative view without round-tripping. Customers view + cancel their own subscriptions at `/account/subscriptions` (ownership-checked; cancel mounts when the payment handle is wired). |
| **`lib/giftcards.js`** | Prepaid bearer gift cards. `issue({ amount_minor, currency })` generates a 16-char code (32-glyph alphabet, no ambiguous letters) via `b.crypto.generateBytes`, stores only its `namespaceHash` digest + a 4-char hint, and returns the plaintext code once. `balance(code)` / `lookup(code)` resolve a code to its live balance (constant-time hash compare); `redeem({ code, order_id, amount_minor })` decrements the balance with an atomic `balance >= amount` SQL guard so concurrent spends can't overdraw. Redeemed at checkout as a credit against the order grand total: the amount due drops by the applied balance (never below zero), the order still records the full total it owed, and the debit is recorded once per order — a card that fully covers the order is marked paid with no Stripe charge. Customers check a balance at `GET /gift-cards`; the page is not a code-existence oracle (unknown / malformed / expired all return the same generic not-found). |
| **`lib/gift-card-ledger.js`** | Append-only credit / debit / expire history per gift card, with a denormalized `balance_after_minor` snapshot for O(1) balance reads. `credit` / `debit` / `expire` write one row each; `history(id)` paginates a card's transactions; `transactionsForOrder(id)` lists a card's movements for one order. The audit trail behind the admin gift-card ledger console; overdraft is refused at the primitive layer. |
| **`lib/newsletter.js`** | Operator-collected email broadcast list — `signup({ email, source })` composes `b.guardEmail` for shape validation, `b.crypto.namespaceHash` for the dedup key, and `INSERT OR IGNORE` for idempotency. Storefront POST `/newsletter` route renders a designed thank-you card with separate copy for the `new` vs `dedup` branches. |
| **`lib/admin.js`** | Bearer-token-gated CRUD over catalog + orders + refunds + bulk CSV import + subscription plans + review moderation + return moderation. Token compared via `b.crypto.timingSafeEqual`. Errors as RFC 9457 problem documents via `b.problemDetails`. Audit emission on every mutation. Also serves a **browser admin console**: sign in at `/admin` by pasting the API key (sealed `shop_admin` session cookie, SameSite=Strict, /admin-scoped), with a persistent nav across every signed-in page. A guided **setup wizard** at `/admin/setup` writes shop identity to config; **Products** (`/admin/products`) browses the catalog and creates / archives / restores; **Inventory** (`/admin/inventory`) lists stock per SKU (on-hand / held / available) with a low-stock filter, restocks, sets per-SKU thresholds, and tracks new SKUs; **Orders** (`/admin/orders`) lists recent orders with status filters, opens an order's items, totals, and shipping address, and drives the lifecycle (mark paid → fulfil → ship → deliver, cancel — Refund goes through the payment provider) through the order FSM; **Customers** (`/admin/customers`) is a read-only roster, newest first — display name, short id, join date, sign-in method (passkey count + linked OAuth providers), and order count, with the count and sign-in methods resolved by bounded aggregate queries so a page of customers costs no per-row trips (email addresses aren't stored in the clear, so they're not shown); **Returns** (`/admin/returns`) is the RMA moderation queue — filter by status, open a request's items and reason, and approve (with refund amount) → mark received → refund, or reject with a reason, over the return FSM; **Reviews** (`/admin/reviews`) is the review moderation queue — filter by status and publish, reject (with a reason), or take down each submission inline; **Subscriptions** (`/admin/subscription-plans`) is the recurring-offer catalog — filter active / archived, create a plan (Stripe price id, interval, amount, trial), and archive one, with archiving terminal because the mirrored Stripe price can go stale; **Collections** (`/admin/collections`) manages manual + smart product collections — filter active / archived, create a collection (manual or smart with a starter rule), and per collection edit title / description / sort strategy, manage manual members (add by product id, remove, reorder) or edit a smart collection's rule set with a live preview of the products the rules currently match, and archive; **Gift cards** (`/admin/gift-cards`) is the gift-card ledger — list issued cards (masked code, original + remaining balance, status, issued date) filtered by lifecycle status, issue a new card (the bearer code shown once, right after creation), and open a card to see its full credit / debit / expire ledger; **Webhooks** (`/admin/webhooks`) registers outbound endpoints (https:// only) with a one-time signing-secret reveal, enables / disables / deletes them, and opens an endpoint's delivery feed to retry a failed delivery — the signing secret is shown once on create and never in the list, and order transitions fan out signed deliveries to subscribed endpoints. The Customers, Returns, Reviews, Subscriptions, Collections, Gift cards, and Webhooks links appear only when those primitives are wired. Each console path content-negotiates: a bearer-token client still gets the JSON API unchanged, a signed-in browser gets HTML. Reachable by the cookie or the bearer token. The console's styling is an external, integrity-pinned stylesheet (`themes/default/assets/css/admin.css`) with the same self-hosted typeface — no inline styles and no third-party font host, so it renders correctly under the strict `style-src 'self'` / `font-src 'self'` CSP that governs the route. |
| **`lib/catalog-import.js`** | Bulk CSV import — `POST /admin/catalog/import` accepts a `text/csv` body, parses via `b.csv`, content-safety-filters every cell through `b.guardCsv` (formula-injection / bidi / control / dangerous-function denylist), validates exact header order, de-dupes rows by `product_slug`, returns per-row errors without aborting. Default 1 MiB / 10000 rows caps. |
| **`lib/theme.js`** | File-backed templates with fallback chain. Operators register a named theme under `<themesDir>/<name>/*.html` and the storefront dispatches every renderer through it. `assetUrl(path)` resolves to `/assets/themes/<name>/<path>`. The shipped `default` theme is the fallback. |

### Migrations applied to D1

- `migrations-d1/0001_catalog.sql` — products, variants, prices, inventory, media
- `migrations-d1/0002_cart.sql` — carts, cart_lines (partial-unique active-cart-per-session)
- `migrations-d1/0003_order.sql` — orders, order_lines, order_transitions (FSM audit log)
- `migrations-d1/0004_shop_config.sql` — shop_config (operator-tunable runtime config)
- `migrations-d1/0005_webhooks.sql` — webhooks subscriptions + deliveries (signed fan-out)
- `migrations-d1/0006_customers.sql` — customers + passkey_credentials
- `migrations-d1/0008_inventory_thresholds.sql` — low-stock alert thresholds + alerts
- `migrations-d1/0009_subscriptions.sql` — subscription_plans + subscriptions (Stripe-mirrored)
- `migrations-d1/0013_giftcards.sql` — gift cards (hashed bearer code + balance snapshot) + redemptions
- `migrations-d1/0081_gift_card_ledger.sql` — append-only gift-card credit/debit/expire ledger
- `migrations-d1/0010_newsletter_signups.sql` — email signups with hash-based dedup
- `migrations-d1/0011_reviews.sql` — operator-moderated product reviews (hash-only author identity)
- `migrations-d1/0012_wishlist.sql` — per-customer saved products (unique customer + product + variant)
- `migrations-d1/0041_save_for_later.sql` — per-customer cart holding list (price snapshot + source line)
- `migrations-d1/0026_customer_addresses.sql` — per-customer address book (default shipping/billing flags)
- `migrations-d1/0023_returns.sql` — return authorizations + lines (RMA lifecycle FSM)
- `migrations-d1/0205_customer_oauth_identities.sql` — federated sign-in identities (provider + subject, verified-email gating)
- `migrations-d1/0206_orders_email_hash.sql` — queryable buyer-email hash on orders (guest-order reconciliation key)
- `migrations-d1/0043_collections.sql` — manual + smart product collections (members + rules + sort strategy)
- `migrations-d1/0050_recently_viewed.sql` — per-customer / per-session product browse history (dedup + per-subject cap)
- `migrations-d1/0105_recommendations.sql` — operator-curated recommendation overrides (kind-scoped, weight-ordered)
- `migrations-d1/0022_loyalty.sql` — loyalty accounts (balance + lifetime + tier) + audited points transactions
- `migrations-d1/0085_loyalty_redemptions.sql` — reward catalog + per-redemption records (FSM: active → consumed / expired / cancelled)
- `migrations-d1/0163_loyalty_earn_rules.sql` — per-event earn rules + dedup-keyed award log
- `migrations-d1/0025_referrals.sql` — referral codes (one active per customer) + invitation funnel (hash-only referred email)
- `migrations-d1/0182_referral_leaderboard.sql` — referral tier thresholds (singleton config) + tiered-bonus payout log
- `migrations-d1/0201_category_navigation.sql` — hierarchical category tree (self-referential parent_slug, sibling position, soft-delete tombstone)

### Demo seed

```bash
wrangler d1 execute blamejs-shop --remote --file=scripts/seed-sample-products.sql
wrangler d1 execute blamejs-shop --remote --file=scripts/seed-sample-product-media.sql
```

Lands four demo products (Operator Tee, Edge Reader v1, Operator License, Starter Bundle) with brand-coloured SVG hero images under `scripts/sample-product-images/`. Idempotent — re-running is a no-op via `INSERT OR IGNORE`.

### Tests

19+ layer-1 test suites running against in-memory `node:sqlite` loaded from the live migrations. Layer-2 integration test boots the full HTTP server on a 127.0.0.1 ephemeral port and exercises the complete browse → PDP → add-to-cart → cart-update → cart-remove flow. Schema CHECK / UNIQUE / FK constraints exercised end-to-end.

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
#    (replace the host with your own worker route or custom domain;
#    the reference deploy lives at https://blamejs.shop)
curl -X POST https://your-shop.example.com/admin/products \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"first","title":"First product","status":"active"}'
```

See [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md) for the full deploy recipe.

## Optional integrations — what to set to enable each

Every third-party integration is **off by default** and lights up only when you
supply its credentials. Nothing here phones home or is enabled without your
keys; the storefront runs fully (browse, cart, accounts) with none of them. Set
the values as deployment secrets (`wrangler secret put …`) or environment
variables. A signed-in operator can see the live on/off status of each at
**`/admin/integrations`**. See [`.env.example`](.env.example) for the full list.

| Integration | What it enables | Set this | Notes |
|-------------|-----------------|----------|-------|
| **Admin console** | The bearer-token JSON API + the `/admin` browser console (sign-in, setup wizard, dashboard). | `ADMIN_API_KEY` (≥ 16 chars — use 32 random bytes) | Sign in at `/admin` by pasting the key. Without it the admin surface doesn't mount. |
| **Card checkout (Stripe)** | Checkout + the Payment Element on the pay page; refunds; subscription billing. | `STRIPE_API_KEY` (`sk_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `STRIPE_PUBLISHABLE_KEY` (`pk_…`) | Point your Stripe webhook at `/api/webhooks/stripe`. Without these the shop stays browsable but checkout doesn't mount. |
| **Apple Pay & Google Pay** | One-tap wallet buttons (Express Checkout Element) on the pay page. | Stripe (above) **+** register each web domain: `POST /admin/payment-method-domains {"domain_name":"shop.example.com"}` | Stripe performs Apple merchant validation and hosts the association file — **no Apple Developer account needed**. Apex, `www`, and each subdomain register separately; a live-mode registration also covers sandbox. |
| **Sign in with Google** | A *Continue with Google* button on `/account/login` (OIDC). | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SHOP_ORIGIN` (e.g. `https://shop.example.com`) | Create a Google Cloud **OAuth 2.0 Web** client; add `<SHOP_ORIGIN>/account/auth/google/callback` as an Authorized redirect URI; consent-screen scopes `openid email profile`. The button appears only when all three are set. |
| **Sign in with Apple** | A *Continue with Apple* button on `/account/login` (OIDC). | `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_CLIENT_ID` (your **Services ID**), `APPLE_PRIVATE_KEY` (the `.p8` key contents), `SHOP_ORIGIN` | Needs an **Apple Developer Program** membership. Create a Services ID, enable Sign in with Apple, add `<SHOP_ORIGIN>/account/auth/apple/callback` as a Return URL, and create a Sign-in-with-Apple key (`.p8`). The shop mints Apple's ES256 client secret from the key at boot (re-minted each deploy, inside Apple's 6-month window). The button appears only when all five are set. |
| **PayPal checkout** | A native PayPal button on `/checkout` (PayPal Orders v2 — create / approve / capture), distinct from PayPal-through-Stripe. | `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` (a PayPal REST app), `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV` (`sandbox`\|`live`); Stripe checkout must also be live | The shop exchanges the OAuth2 token and creates / captures orders server-side; the button drives `/checkout/paypal/create` + `/checkout/paypal/capture`. Point a PayPal webhook at `/api/webhooks/paypal` (verified through PayPal's API). Allow `www.paypal.com` in your CSP `script-src` / `frame-src` (as you would `js.stripe.com`). |

**Planned / not available:**

- **Shop Pay / "Sign in with Shop"** — **not available** to a self-hosted,
  non-Shopify store: the credentials only issue from a Shopify Admin and payment
  flows through Shopify Payments. There is no path to enable it here.

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
