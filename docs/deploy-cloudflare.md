# Deploy on Cloudflare

This document is the operator-facing recipe for deploying `blamejs.shop`
on Cloudflare Containers, fronted by a Cloudflare Worker, with D1 as
the application database, R2 for assets, KV for sessions, and a
Durable Object class for hot-SKU inventory serialization.

## Topology

```
                  ┌────────────────────────────────┐
                  │   zone: blamejs.shop           │
                  └────────────────────────────────┘
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       │                          │                          │
 ┌─────▼─────┐              ┌─────▼─────┐              ┌─────▼─────┐
 │  Worker   │              │     R2    │              │     KV    │
 │  edge     │              │  assets   │              │ sessions  │
 │  router   │              └───────────┘              └───────────┘
 └─────┬─────┘
       │   service binding
 ┌─────▼─────┐    ┌───────────────────┐
 │ Container │◄───┤ Durable Object    │
 │ (Node LTS)│    │ InventoryLock     │
 │ blamejs   │    └───────────────────┘
 │  .shop    │
 └─────┬─────┘    ┌───────────────────┐
       └─────────►│   D1 (via Worker  │
                  │   service bridge) │
                  └───────────────────┘
```

The container never holds a D1 API token. SQL goes
container → Worker (over service binding) → D1, authenticated by a
shared secret header. Inbound Stripe webhooks are signature-verified
at the Worker edge before forwarding to the container. Static assets
under `/assets/` are served directly from R2 without a container hop.

## One-time setup

```bash
# Authenticate wrangler. Run once per workstation.
npx wrangler login

# Create the Cloudflare resources. Each command prints an id/name —
# paste each one into `wrangler.toml` where the PLACEHOLDER tokens
# live, OR set them via `wrangler.toml` overrides in a per-env file.
npx wrangler d1 create blamejs-shop
npx wrangler r2 bucket create blamejs-shop-assets
npx wrangler kv namespace create SESSIONS

# Set Worker secrets. These never appear in wrangler.toml.
#   STRIPE_WEBHOOK_SECRET  — `whsec_…` from the Stripe dashboard
#   D1_BRIDGE_SECRET       — operator-generated random 32 bytes,
#                            shared between the Worker and the
#                            container (the container reads it
#                            from its own env var of the same name)
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put D1_BRIDGE_SECRET
```

Generate the bridge secret locally and reuse the same value for both
the Worker secret and the container env:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > .bridge-secret
npx wrangler secret put D1_BRIDGE_SECRET < .bridge-secret
# Then set the container env D1_BRIDGE_SECRET to the same value
# (see "Container env" below). Wipe the file:  rm .bridge-secret
```

## Apply database migrations

Application schema lives under `migrations-d1/`. Apply it before the
first deploy:

```bash
npx wrangler d1 migrations apply blamejs-shop --remote
```

The shipped migration set:

| File                                      | What                                                              |
|-------------------------------------------|-------------------------------------------------------------------|
| `0001_catalog.sql`                        | products, variants, prices, inventory, media                      |
| `0002_cart.sql`                           | carts, cart_lines (partial-unique active-cart-per-session)        |
| `0003_order.sql`                          | orders, order_lines, order_transitions (FSM audit log)            |
| `0004_shop_config.sql`                    | shop_config (operator-tunable runtime config)                     |
| `0005_webhooks.sql`                       | webhook subscriptions + deliveries (signed fan-out)               |
| `0006_customers.sql`                      | customers + passkey_credentials                                   |
| `0008_inventory_thresholds.sql`           | low-stock alert thresholds + alerts                               |
| `0009_subscriptions.sql`                  | subscription_plans + subscriptions (Stripe-mirrored)              |
| `0010_newsletter_signups.sql`             | newsletter signups with hash-based dedup                          |

Numbering is monotonically increasing; gaps (e.g. no `0007`) reflect
reservations that landed in a different release and are intentional.
Never renumber an applied migration.

## Seed demo content (optional)

To populate the four reference products (Operator Tee, Edge Reader v1,
Operator License, Starter Bundle) with their brand-coloured SVG hero
images, run the seed scripts against the remote D1 instance:

```bash
npx wrangler d1 execute blamejs-shop --remote \
  --file=scripts/seed-sample-products.sql
npx wrangler d1 execute blamejs-shop --remote \
  --file=scripts/seed-sample-product-media.sql
```

Both files use `INSERT OR IGNORE`, so re-running them is a no-op —
safe to wire into a post-deploy hook if the shop is meant to ship
with the demo catalog visible.

## Container env

The container reads its own env vars at boot. The runtime injects
`D1_BRIDGE_URL` automatically when the Worker is bound as a service;
the operator sets the bridge secret + any application-level secrets:

| Variable              | Source            | Notes                                             |
| --------------------- | ----------------- | ------------------------------------------------- |
| `PORT`                | platform-managed  | Cloudflare Containers sets this — don't override. |
| `DATA_DIR`            | `wrangler.toml`   | Per-instance volatile dir. `./data` is fine.      |
| `VAULT_PASSPHRASE`    | `wrangler secret` | Required. Unlocks the vault **and** the audit-signing keypair (the entry point bridges it to `BLAMEJS_VAULT_PASSPHRASE` and derives a domain-separated `BLAMEJS_AUDIT_SIGNING_PASSPHRASE`). Without it the container can't unlock its wrapped keys, has no TTY to prompt, and crash-loops — taking every write route (add-to-cart, checkout, account, admin) down while edge-rendered reads still work. |
| `D1_BRIDGE_URL`       | platform-injected | URL of the bound Worker. Don't hand-set.          |
| `D1_BRIDGE_SECRET`    | `wrangler secret` | Must match the Worker's binding of the same name. |
| `D1_BRIDGE_PATH`      | optional          | Override (default `/_/db/query`).                 |
| `STRIPE_API_KEY`      | `wrangler secret` | Outbound calls; webhooks live in the Worker.      |

## Deploy

```bash
npx wrangler deploy
```

This builds the Dockerfile, pushes the container image to
Cloudflare's registry, and updates the Worker. The first deploy can
take a few minutes for the image build; subsequent deploys are fast
because Cloudflare caches the vendored layer.

## Wire a custom domain

The first deploy publishes the Worker on a
`<worker>.<subdomain>.workers.dev` URL. For a production shop, bind
the Worker to your own zone so requests resolve directly under your
brand domain (the reference deploy lives at <https://blamejs.shop>):

1. Add the zone to Cloudflare. From the dashboard: **Websites → Add
   a site →** enter the apex (e.g. `your-shop.example.com` or the
   bare apex `example.com`), pick the Free plan, and update your
   registrar's nameservers to the two Cloudflare assigns.
2. Bind the Worker to the route. From the Worker page in the
   dashboard: **Settings → Domains & Routes → Add → Custom Domain**,
   select the zone, and enter the hostname you want
   (`shop.example.com`, or the apex `example.com`). Cloudflare
   provisions the edge cert and DNS automatically and routes every
   matching request to the Worker.
3. Alternatively, declare the route in `wrangler.toml` and redeploy:
   ```toml
   routes = [
     { pattern = "your-shop.example.com", custom_domain = true }
   ]
   ```
   `wrangler deploy` reconciles the route on next push.
4. Verify TLS once DNS has propagated:
   ```bash
   curl -fsSL https://your-shop.example.com/_/health
   openssl s_client -connect your-shop.example.com:443 -servername your-shop.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -issuer -subject -dates
   ```

The `Verify` commands below use `https://blamejs.shop` as a stand-in
— substitute your own bound hostname.

## Verify

```bash
# Edge health (Worker only — short-circuits before container hop).
curl -fsSL https://blamejs.shop/_/health

# Container health (also goes through Worker → container).
curl -fsSL "https://blamejs.shop/_/health?fromContainer=1"

# Static asset cache headers.
curl -I https://blamejs.shop/assets/logo.png

# Confirm Stripe webhook edge-verifies (signed POST returns 200;
# unsigned POST returns 400).
curl -fsS -X POST https://blamejs.shop/api/webhooks/stripe -d '{}' && echo "this should not happen"
```

## Local development

`wrangler dev` boots a local Worker + Container preview against the
remote D1/R2/KV bindings:

```bash
npx wrangler dev --remote
```

For an offline workflow, run the container directly (no Worker, no
D1) — useful for the placeholder home route and the smoke gate:

```bash
docker build -t blamejs-shop:local .
docker run --rm -p 8080:8080 -e VAULT_PASSPHRASE="dev-only" blamejs-shop:local
curl -fsSL http://127.0.0.1:8080/_/health
```

## Rollback

Each deploy publishes a new Worker version with an immutable id. To
roll back:

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

The container image registry retains prior tags; the rollback points
the binding at the previous container image automatically.
