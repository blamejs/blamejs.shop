import { Container } from "@cloudflare/containers";
import b from "./b.js";
// Asset integrity + version manifest (built by scripts/generate-asset-manifest.js,
// bundled into the Worker). The edge renders read the release version + the
// default-theme SRI digests from here — the Worker has no filesystem to hash
// assets at request time, so without this it fell back to a `0.0.0` cache-
// buster and emitted no integrity attribute.
import assetManifest from "./asset-manifest.json";
import { renderHome }    from "./render/home.js";
import { renderProduct } from "./render/product.js";
import { renderSearch }  from "./render/search.js";
import {
  renderPrivacy,
  renderTerms,
  renderNotFound,
  renderInternalError,
} from "./render/policy.js";
import { renderFeed } from "./render/feed.js";
import { renderSitemap } from "./render/sitemap.js";
import { renderBlogList, renderBlogArticle } from "./render/blog.js";
import { renderStorefrontPage } from "./render/pages.js";
import { renderCart } from "./render/cart.js";
import { minifyHtml as _minify, assetUrl as _assetUrl, PWA_DEFAULT_MANIFEST, PWA_DEFAULT_SW } from "./render/_lib.js";
import {
  listActiveProducts,
  listActiveCollections,
  getProductBySlug,
  searchFacetableProducts,
  loadSearchFacets,
  loadSearchSynonymVocab,
  listVariantsWithPrices,
  listInventoryForSkus,
  listMediaForProduct,
  getReviewSummary,
  listPublishedReviews,
  listProductQaThreads,
  getWishlistCount,
  recentBlogArticles,
  listActiveProductSlugs,
  listActiveCollectionSlugs,
  listActiveCategorySlugs,
  listPublishedPageSlugs,
  listPublishedBlogSlugs,
  listBlogArticles,
  getBlogArticleBySlug,
  getPublishedPageBySlug,
  getBundlesForProduct,
  getQtyBreaksForSku,
  listRelatedProducts,
  getOpenPreorderForSku,
} from "./data/catalog.js";
import {
  computeFacets,
  applyFilters,
  rewriteQuery,
} from "./data/search-faceting.js";
import {
  loadSearchRanking,
  applyRanking,
  projectForRanking,
  normalizeRankingQuery,
} from "./data/search-ranking.js";
import { hasCurrencyCookie } from "./data/currency.js";
import { resolveAnnouncement } from "./data/announcement.js";
import { resolvePromoBanners } from "./data/promo-banners.js";
import { resolveSidebarWidgets } from "./data/sidebar-widgets.js";

// Cloudflare Worker — edge router for blamejs.shop.
//
// Responsibilities (in routing order):
//
//   1. /_/health                  — inline 200 (no container hop).
//   2. <ASSET_PREFIX>*            — pass-through to the R2 bucket
//                                   with long-cache headers.
//   3. Storefront read routes     — /, /search, /products/:slug render
//      (when EDGE_RENDER=on)        at the edge: D1 query via the bound
//                                   binding + pure-JS HTML render. No
//                                   container hop. Gated by env so
//                                   operators can roll back.
//   4. <STRIPE_WEBHOOK_PATH>      — verify the Stripe-shape HMAC
//                                   signature at the edge before
//                                   forwarding to the container; an
//                                   unsigned or replayed delivery
//                                   never reaches origin.
//   5. <D1_BRIDGE_PATH>           — SQL bridge consumed by the
//                                   container's externalDb D1
//                                   adapter. Authenticates the
//                                   caller with the
//                                   D1_BRIDGE_SECRET header (defense
//                                   in depth: the binding is
//                                   service-only, but a stolen
//                                   compatibility_flag or
//                                   misconfiguration shouldn't leak
//                                   raw SQL execution).
//   6. <R2_BRIDGE_PATH>           — media upload bridge consumed by
//                                   the container's r2Bridge adapter.
//                                   Same shared-secret header as the
//                                   D1 bridge; the body is binary, the
//                                   object key + content-type ride in
//                                   request headers. The Worker writes
//                                   to the R2 binding so the container
//                                   never holds an R2 API token.
//   7. everything else            — forward to the container via the
//                                   SHOP service binding.
//
// Commerce business logic still lives in the container for routes
// that mutate state (cart writes, checkout, admin, webhooks). The
// edge handles the read-only storefront render so visitors get HTML
// in ~50ms instead of waiting for the container to wake up.

const ASSET_CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";
const ASSET_CACHE_CONTROL_DEFAULT   = "public, max-age=300";

// ---- helpers --------------------------------------------------------------

function _json(obj, status, headers) {
  const init = { status: status || 200, headers: { "content-type": "application/json; charset=utf-8" } };
  if (headers) for (const k in headers) init.headers[k] = headers[k];
  return new Response(JSON.stringify(obj), init);
}

function _text(s, status) {
  return new Response(s, { status: status || 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// Redact known sensitive shapes before emitting to Worker logs. The
// Worker logs flow into Cloudflare's logging pipeline (tail / Logpush /
// dashboard) — anything emitted here may persist on Cloudflare-side
// storage. Redaction targets:
//   - Bearer tokens / x-d1-bridge-secret headers
//   - Stripe-Signature header values (t=...,v1=...)
//   - JWT-like dotted tri-segment tokens
//   - long hex strings (>=32 chars) — webhook secrets, HMAC sigs, IDs
//   - shop_sid / shop_auth cookie pairs
// Inputs that aren't strings pass through coerced to string; null/
// undefined become the empty string so log calls stay total.
function _redact(s) {
  if (s == null) return "";
  let out = typeof s === "string" ? s : String(s);
  // Authorization: Bearer <token>
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, "$1<redacted>");
  // Stripe-Signature header value
  out = out.replace(/\bt=\d+\s*,\s*v1=[a-f0-9]+(?:\s*,\s*v\d+=[a-f0-9]+)*/gi, "<redacted-stripe-signature>");
  // JWT-like tri-segment dotted token
  out = out.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-jwt>");
  // shop_sid / shop_auth cookie value (anything until ; or end). The `\b`
  // anchors the name match so it also covers the `__Host-`-prefixed
  // production form (`__Host-shop_sid=` / `__Host-shop_auth=`): the hyphen
  // is a word boundary, so the value is redacted while the prefix is kept.
  out = out.replace(/\b(shop_sid|shop_auth)=[^;\s]+/gi, "$1=<redacted>");
  // Bridge / admin secret headers (key=value style, common log shape)
  out = out.replace(/\b(x-d1-bridge-secret|x-admin-api-key|d1_bridge_secret|admin_api_key|stripe_webhook_secret|stripe_api_key)\s*[:=]\s*\S+/gi, "$1=<redacted>");
  // Long hex / base64-ish run — webhook secrets, HMAC sigs, opaque tokens
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, "<redacted-hex>");
  out = out.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted-token>");
  // Compose `b.redact.redact` on top so the framework's catalog of
  // sensitive value shapes (PEM blocks, AWS access keys, credit-card
  // numbers, SSNs, connection strings, etc.) runs after the shop-
  // specific patterns. The shop layer catches header / cookie /
  // bridge-secret shapes b.redact doesn't ship; b.redact covers the
  // generic credential shapes the shop layer doesn't enumerate.
  return b.redact.redact(out);
}

function _timingSafeEqual(x, y) {
  try {
    return b.crypto.timingSafeEqual(x, y);
  } catch (_e) {
    return false;
  }
}

// Stripe webhook signature: `t=<unix>,v1=<hex-hmac-sha256(timestamp + "." + body)>`
// Composes the framework's hardened Stripe verifier (`b.webhook.verify`,
// alg "hmac-sha256-stripe") rather than re-parsing the header here: it
// applies the header-size + v1-hex anti-DoS caps, a tolerance floor
// (refuses < 30 s), constant-time hex compare, and matches across
// every v1 signature in the header. The tolerance window defaults to
// 5 minutes; outside it the delivery is refused (replay defense).
// `b.webhook.verify` throws a `WebhookError` on any failure; the edge
// only needs ok/reason for its log line, so the throw is mapped to a
// `{ ok: false, reason }` shape — the container re-verifies
// authoritatively (defense in depth). The body is read once and reused
// — Request bodies are single-shot.
async function _verifyStripeSignature(rawBody, header, secret, toleranceSeconds) {
  if (!header || !secret) return { ok: false, reason: "missing-signature-or-secret" };
  try {
    await b.webhook.verify({
      alg:         "hmac-sha256-stripe",
      secret:      secret,
      header:      header,
      body:        rawBody,
      toleranceMs: b.constants.TIME.seconds(toleranceSeconds || 300),
    });
    return { ok: true };
  } catch (e) {
    // WebhookError carries a stable `code` (e.g. webhook/stale-timestamp,
    // webhook/bad-signature); fall back to a generic reason otherwise.
    return { ok: false, reason: (e && e.code) || "signature-invalid" };
  }
}

// ---- Durable Object: InventoryLock ----------------------------------------
//
// Serializes "check stock, hold-if-available" against a single SKU
// across all container replicas. The DO instance is keyed by SKU so
// contention is per-SKU, not global. The actual stock row lives in D1;
// the DO is the serialization point.
//
// Status: OPTIONAL serialization aid, not the primary oversell defense.
// The container places + settles stock holds directly with atomic
// conditional `UPDATE`s on the `inventory` row (see catalog.inventory
// `hold` / `decrement` / `release`, driven by checkout.confirm + the
// order FSM). Because each guard is a single check-and-set SQL
// statement, the conditional write itself serializes concurrent
// checkouts — so the buy path is oversell-safe on the single replica
// the container runs today WITHOUT routing through this DO. The DO is
// retained for a future multi-replica topology where an operator wants
// an explicit per-SKU queue in front of the shelf; nothing calls it on
// the default path. Its `/decrement` route places a HOLD (increments
// stock_held), matching the container's hold semantics.
export class InventoryLock {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/decrement" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.sku !== "string" || !Number.isInteger(body.qty) || body.qty <= 0) {
        return _json({ ok: false, error: "INVALID_REQUEST" }, 400);
      }
      // Single-DO-instance serialization — concurrent calls queue.
      return await this.state.blockConcurrencyWhile(async () => {
        const row = await this.env.DB.prepare(
          "SELECT stock_on_hand, stock_held, low_stock_threshold FROM inventory WHERE sku = ?1",
        ).bind(body.sku).first();
        if (!row) return _json({ ok: false, error: "UNKNOWN_SKU" }, 404);
        const available = row.stock_on_hand - row.stock_held;
        if (available < body.qty) return _json({ ok: false, error: "INSUFFICIENT_STOCK", available }, 409);
        await this.env.DB.prepare(
          "UPDATE inventory SET stock_held = stock_held + ?1, updated_at = ?2 WHERE sku = ?3",
        ).bind(body.qty, Date.now(), body.sku).run();
        // After-decrement low-stock check. If post-decrement available
        // is strictly below the configured threshold, POST to the
        // container's alert endpoint. The container holds the alerts
        // primitive (writes the row + fans out webhooks + logs); the
        // DO is the serialization point, not the alert sink. Fire-
        // and-forget — alert delivery must not gate the stock hold.
        const postAvailable = available - body.qty;
        if (row.low_stock_threshold != null && postAvailable < row.low_stock_threshold) {
          this._postLowStockAlert(body.sku, postAvailable, row.low_stock_threshold);
        }
        return _json({ ok: true, held: body.qty });
      });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.sku !== "string" || !Number.isInteger(body.qty) || body.qty <= 0) {
        return _json({ ok: false, error: "INVALID_REQUEST" }, 400);
      }
      return await this.state.blockConcurrencyWhile(async () => {
        await this.env.DB.prepare(
          "UPDATE inventory SET stock_held = MAX(0, stock_held - ?1), updated_at = ?2 WHERE sku = ?3",
        ).bind(body.qty, Date.now(), body.sku).run();
        return _json({ ok: true });
      });
    }
    return _json({ ok: false, error: "UNKNOWN_ROUTE" }, 404);
  }

  // Fire-and-forget POST to the container's low-stock alert endpoint.
  // Uses the SHOP service binding directly (not the public hostname)
  // so the request never leaves the Cloudflare network. The shared
  // `D1_BRIDGE_SECRET` authenticates the call — same trust root as
  // the SQL bridge, since both flow Worker → container.
  _postLowStockAlert(sku, available, threshold) {
    try {
      const url = new URL("/_/low-stock-alert", "http://shop.container");
      const req = new Request(url.toString(), {
        method: "POST",
        headers: {
          "content-type":          "application/json; charset=utf-8",
          "x-d1-bridge-secret":    this.env.D1_BRIDGE_SECRET || "",
        },
        body: JSON.stringify({ sku, available, threshold }),
      });
      const container = _shopContainer(this.env);
      // Don't await — the decrement caller already got its response.
      container.fetch(req).catch(() => { /* drop-silent — alert delivery is best-effort */ });
    } catch (_e) { /* drop-silent — alert delivery is best-effort */ }
  }
}

// ---- Durable Object: ShopContainer ----------------------------------------
//
// Cloudflare Containers exposes the running container instance as a
// Durable Object class. The `Container` base class from
// @cloudflare/containers handles lifecycle (start + readiness wait +
// idle sleep + auto-restart) and HTTP forwarding (port routing,
// scheme rewrite, header passthrough); we only have to declare
// defaults + dynamic env vars and let the base class do the rest.
//
// Env vars passed to the container come from Worker secrets — they
// live only in Cloudflare's vault, never in the image, never in DO
// state. The container's externalDb D1 adapter calls back to this
// Worker over the public hostname; the shared bridge secret
// authenticates that call.
export class ShopContainer extends Container {
  defaultPort = 8080;
  // Idle window before the container is allowed to sleep. The
  // Node + blamejs cold-start budget is ~15-25s on CF Containers,
  // so a short sleepAfter (e.g. 30s) makes nearly every visitor
  // eat the boot cost. 15m keeps the working set warm across
  // normal browsing patterns while still releasing the slot when
  // the shop is genuinely idle.
  sleepAfter  = "15m";

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      PORT:                              "8080",
      NODE_ENV:                          "production",
      // blamejs reads each passphrase from a `BLAMEJS_*` env var; we
      // store them in CF under the shorter operator-facing name (no
      // `BLAMEJS_` prefix) and rename on the way through.
      BLAMEJS_VAULT_PASSPHRASE:          env.VAULT_PASSPHRASE          || "",
      BLAMEJS_AUDIT_PASSPHRASE:          env.AUDIT_PASSPHRASE          || "",
      BLAMEJS_AUDIT_SIGNING_PASSPHRASE:  env.AUDIT_SIGNING_PASSPHRASE  || "",
      BLAMEJS_BACKUP_PASSPHRASE:         env.BACKUP_PASSPHRASE         || "",
      BLAMEJS_KEYCHAIN_PASSPHRASE:       env.KEYCHAIN_PASSPHRASE       || "",
      D1_BRIDGE_URL:                     env.D1_BRIDGE_URL             || "",
      D1_BRIDGE_SECRET:                  env.D1_BRIDGE_SECRET          || "",
      D1_BRIDGE_PATH:                    env.D1_BRIDGE_PATH            || "/_/db/query",
      R2_BRIDGE_PATH:                    env.R2_BRIDGE_PATH            || "/_/r2/put",
      STRIPE_API_KEY:                    env.STRIPE_API_KEY            || "",
      STRIPE_WEBHOOK_SECRET:             env.STRIPE_WEBHOOK_SECRET     || "",
      STRIPE_PUBLISHABLE_KEY:            env.STRIPE_PUBLISHABLE_KEY    || "",
      APPLE_PAY_DOMAIN_ASSOCIATION:      env.APPLE_PAY_DOMAIN_ASSOCIATION || "",
      ADMIN_API_KEY:                     env.ADMIN_API_KEY             || "",
    };
  }

  onStart()  { console.log("ShopContainer started"); }                            // allow:console-direct — Workers have no framework observability sink; console.* auto-routes to wrangler tail / Logpush
  onStop(p)  { console.log("ShopContainer stopped", JSON.stringify({ exitCode: p && p.exitCode, reason: p && p.reason })); } // allow:console-direct — surfaces the container's exit code/reason (137=OOM-kill, 1=throw, 0=clean) into wrangler tail for boot-crash diagnosis
  onError(e) { console.error("ShopContainer error:", _redact(e && e.stack || e)); } // allow:console-direct — Workers have no framework observability sink; console.* auto-routes to wrangler tail / Logpush

  // The container's secure boot (vault unlock + an O(N) audit-chain verify
  // over the D1-backed chain) routinely exceeds the SDK's ~8s default
  // port-ready window on a cold start, so CF was killing the container
  // before it bound :8080 ("crashed while checking for ports") — a
  // self-inflicted crash-loop on every wake. Widen the window so a
  // slow-but-valid boot is allowed to finish + bind the port. Applies to
  // the base containerFetch path too (it calls this.startAndWaitForPorts).
  startAndWaitForPorts(ports, cancellationOptions, startOptions) {
    return super.startAndWaitForPorts(
      ports,
      Object.assign({ portReadyTimeoutMS: 120000 }, cancellationOptions),
      startOptions,
    );
  }
}

// ---- Worker entrypoint ----------------------------------------------------

// Top-level Worker exception catcher. An uncaught exception in the
// fetch handler propagates to Cloudflare's runtime, which serves the
// generic 1101 "Worker threw exception" page — visitors see a
// cf-branded error referencing wrangler tail. The wrap converts
// every escape into a clean 500 served with the framework's security
// headers + a sane Retry-After. Logs to `console.error` so wrangler
// tail / Logpush still capture the underlying cause.
async function _withTopLevelCatch(request, env, ctx, inner) {
  try {
    return await inner(request, env, ctx);
  } catch (e) {
    console.error("worker top-level exception:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
    return new Response(_warmingHtml(request.url, 8), {
      status:  503,
      headers: _withSecurityHeaders({
        "content-type":  "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after":   "10",
      }),
    });
  }
}

// Worker→container internal cron / event endpoints. Every one is fired
// machine-to-machine from this worker's own `scheduled()` handler (and the
// InventoryLock DO), each carrying the shared `x-d1-bridge-secret` header.
// The container ALSO validates that secret first thing in each handler, so a
// worker-side pre-check is defense-in-depth: it refuses a forged
// publicly-reachable POST at the edge before any container resource is
// touched. The check FAILS OPEN when `D1_BRIDGE_SECRET` is unconfigured on
// the worker (same stance as the existing /_/low-stock-alert gate) so a
// deploy that hasn't wired the secret yet still forwards rather than 401-ing
// every cron — the worker's own fires always carry the header, so a
// configured deploy never self-blocks. `/_/health` + `/_/version` are NOT in
// this set (handled earlier, no secret — the HEALTHCHECK probe is
// browser-shaped by contract); `/_/db/query`, `/_/r2/put`, and
// `/_/low-stock-alert` carry their own gates and return before the
// fall-through, so listing them here would be dead-but-harmless — they're
// omitted to keep this the exact set of fall-through cron paths.
var _INTERNAL_CRON_PATHS = {
  "/_/cart-recovery-tick":    true,
  "/_/stock-alert-sweep":     true,
  "/_/wishlist-alerts-sweep": true,
  "/_/wishlist-digest-sweep": true,
  "/_/stale-order-reap":      true,
  "/_/quote-expiry-tick":     true,
  "/_/customer-portal-expire": true,
  "/_/campaign-send-tick":    true,
  "/_/winback-send-tick":     true,
  "/_/webhook-retry-tick":    true,
};

export default {
  async fetch(request, env, ctx) {
    return _withTopLevelCatch(request, env, ctx, async function (request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Health probe — short-circuit before any binding lookup.
    if (pathname === (env.HEALTH_PATH || "/_/health")) {
      return _json({ ok: true, edge: true });
    }

    // Operator-friendly deploy-verification probe. No auth — purely
    // diagnostic, surfaces only build/version hints (no secrets). The
    // worker SHA is sourced from env.WORKER_VERSION (set at deploy
    // time by the wrangler build, otherwise "unknown"); the container
    // image hint comes from env.CONTAINER_IMAGE_HINT.
    if (pathname === "/_/version" && (request.method === "GET" || request.method === "HEAD")) {
      return _json({
        worker:          env.WORKER_VERSION || "unknown",
        container_image: env.CONTAINER_IMAGE_HINT || "unknown",
        time:            new Date().toISOString(),
      });
    }

    // 2. Static assets — pass through to R2 with cache headers.
    const assetPrefix = env.ASSET_PREFIX || "/assets/";
    if (pathname.startsWith(assetPrefix)) {
      const key = pathname.slice(assetPrefix.length);
      if (!key || key.indexOf("..") !== -1) return _text("Not Found", 404);
      const obj = await env.ASSETS.get(key);
      if (!obj) return _text("Not Found", 404);
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      // Fingerprinted assets (`name.<hash>.ext`) are immutable; the
      // theme renderer rewrites <link>/<script> to fingerprinted
      // names so a long cache is safe.
      const fingerprinted = /\.[a-f0-9]{8,}\.[a-z0-9]+$/.test(key);
      headers.set("cache-control", fingerprinted ? ASSET_CACHE_CONTROL_IMMUTABLE : ASSET_CACHE_CONTROL_DEFAULT);
      _hardenAssetResponse(headers);
      return new Response(obj.body, { headers });
    }

    // 2b. /robots.txt edge fallback — crawlers must always get a
    //     clean answer even while the container is cold-starting,
    //     otherwise they index the warming page (noindex, but still
    //     noisy). An R2-uploaded robots.txt under <ASSET_PREFIX>
    //     would have already won above; this only catches the bare
    //     `/robots.txt` request when no asset overrides it. The
    //     Disallow set matches the container's robots.txt so the edge
    //     and container agree on which session/operator routes stay
    //     out of the crawl. Operators who want a richer per-bot policy
    //     define rules via robotsConfig (served by the container) or
    //     upload a robots.txt into R2.
    if (pathname === "/robots.txt" && (request.method === "GET" || request.method === "HEAD")) {
      const robotsOrigin = url.origin;
      return new Response(
        "User-agent: *\nAllow: /\n" +
        "Disallow: /admin\nDisallow: /cart\nDisallow: /checkout\n" +
        "Disallow: /pay/\nDisallow: /orders/\nDisallow: /account\n" +
        "Sitemap: " + robotsOrigin + "/sitemap.xml\n",
        {
          status:  200,
          headers: {
            "content-type":  "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }

    // 2c. Static policy + doc pages — served entirely from the edge,
    //     no container hop and no D1 read. Cached aggressively at the
    //     visitor's browser + Cloudflare's zone cache (24h) since the
    //     content only changes on a code push.
    if ((request.method === "GET" || request.method === "HEAD")) {
      if (pathname === "/privacy") {
        return _staticHtml(renderPrivacy(Object.assign({
          shopName: env.SHOP_NAME    || "blamejs.shop",
          version:  env.WORKER_VERSION || "0.0.0",
          canonicalUrl: url.origin + url.pathname,
        }, _localeRenderOpts(env, url))), request.method, env, request);
      }
      if (pathname === "/terms") {
        return _staticHtml(renderTerms(Object.assign({
          shopName: env.SHOP_NAME    || "blamejs.shop",
          version:  env.WORKER_VERSION || "0.0.0",
          canonicalUrl: url.origin + url.pathname,
        }, _localeRenderOpts(env, url))), request.method, env, request);
      }
      if (pathname === "/SECURITY.md") {
        return Response.redirect("https://github.com/blamejs/blamejs.shop/blob/main/SECURITY.md", 302);
      }
      if (pathname === "/CHANGELOG.md") {
        return Response.redirect("https://github.com/blamejs/blamejs.shop/blob/main/CHANGELOG.md", 302);
      }
      if (pathname === "/sitemap.xml") {
        try {
          // Each read is independently missing-table-resilient at the data
          // layer (an unmigrated table → empty rows), so a partial schema
          // drops those URLs rather than 503-ing the whole sitemap.
          const [products, collections, categories, pages, blogPosts] = await Promise.all([
            listActiveProductSlugs(env.DB),
            listActiveCollectionSlugs(env.DB),
            listActiveCategorySlugs(env.DB),
            listPublishedPageSlugs(env.DB),
            listPublishedBlogSlugs(env.DB),
          ]);
          const origin = b.safeUrl.parse(env.D1_BRIDGE_URL || "https://blamejs.shop").href.replace(/\/$/, "");
          const xml = renderSitemap({
            origin:      origin,
            products:    products.rows,
            collections: collections.rows,
            categories:  categories.rows,
            pages:       pages.rows,
            blogPosts:   blogPosts.rows,
          });
          return new Response(xml, {
            status:  200,
            headers: _withSecurityHeaders({
              "content-type":  "application/xml; charset=utf-8",
              "cache-control": "public, max-age=600, s-maxage=3600",
            }),
          });
        } catch (e) {
          console.error("sitemap.xml render failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
          return new Response("Sitemap temporarily unavailable", {
            status:  503,
            headers: _withSecurityHeaders({
              "content-type":  "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "retry-after":   "60",
            }),
          });
        }
      }
      if (pathname === "/manifest.webmanifest") {
        // The edge serves the SHIPPED DEFAULT manifest — byte-identical to
        // the container's default fallback (a parity test pins them). The
        // edge can't read the DB-backed pwaManifest override; an operator
        // customization rides the container render path. This keeps the
        // `<link rel="manifest">` in every cached layout from 404-ing.
        if (request.method === "HEAD") {
          return new Response(null, {
            status:  200,
            headers: _withSecurityHeaders({
              "content-type":  "application/manifest+json; charset=utf-8",
              "cache-control": "public, max-age=3600",
            }),
          });
        }
        return new Response(PWA_DEFAULT_MANIFEST, {
          status:  200,
          headers: _withSecurityHeaders({
            "content-type":  "application/manifest+json; charset=utf-8",
            "cache-control": "public, max-age=3600",
          }),
        });
      }
      if (pathname === "/sw.js") {
        // The shipped default service worker (pass-through navigation
        // fallback) — byte-identical to the container default. Served
        // same-origin under the strict `script-src 'self'` CSP.
        if (request.method === "HEAD") {
          return new Response(null, {
            status:  200,
            headers: _withSecurityHeaders({
              "content-type":  "text/javascript; charset=utf-8",
              "cache-control": "public, max-age=3600",
            }),
          });
        }
        return new Response(PWA_DEFAULT_SW, {
          status:  200,
          headers: _withSecurityHeaders({
            "content-type":  "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=3600",
          }),
        });
      }
      if (pathname === "/.well-known/security.txt") {
        // RFC 9116 §2.5 — every line ends with CRLF; the Expires
        // field is a year out so crawlers don't repeatedly refetch.
        // Contact email is the operator-configurable owner; the
        // GitHub-issues fallback gives a public reporting path.
        const expires = new Date(Date.now() + b.constants.TIME.days(365)).toISOString();
        const body =
          "Contact: mailto:security@blamejs.shop\r\n" +
          "Contact: https://github.com/blamejs/blamejs.shop/security/advisories/new\r\n" +
          "Expires: " + expires + "\r\n" +
          "Encryption: https://github.com/blamejs/blamejs.shop/blob/main/SECURITY.md\r\n" +
          "Policy: https://github.com/blamejs/blamejs.shop/blob/main/SECURITY.md\r\n" +
          "Preferred-Languages: en\r\n";
        return new Response(body, {
          status:  200,
          headers: _withSecurityHeaders({
            "content-type":  "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600, s-maxage=86400", // allow:raw-time-literal — HTTP Cache-Control directive seconds in a header string, not a duration expression
          }),
        });
      }
      if (pathname === "/.well-known/apple-developer-merchantid-domain-association") {
        // Apple Pay (via the Stripe Express Checkout Element) only renders
        // once Apple has verified the domain, and it verifies by crawling
        // this exact path — which lands on the edge, not the container. The
        // file's bytes are Stripe-provided (download from the Stripe
        // dashboard / docs.stripe.com/apple-pay); the operator stores them
        // verbatim in the APPLE_PAY_DOMAIN_ASSOCIATION binding. We serve
        // them unchanged as text/plain: Apple's crawl rejects any wrapping
        // or redirect, so no transform, no HTML shell, no trailing newline
        // added. Unset → 404 (the documented fail-open posture: the Apple
        // Pay button simply does not appear, every other payment method is
        // unaffected). Cached short so a freshly-pasted association
        // propagates without a redeploy.
        const assoc = env.APPLE_PAY_DOMAIN_ASSOCIATION || "";
        if (!assoc) {
          return new Response("Not Found", {
            status:  404,
            headers: _withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }),
          });
        }
        if (request.method === "HEAD") {
          return new Response(null, {
            status:  200,
            headers: _withSecurityHeaders({
              "content-type":  "text/plain; charset=utf-8",
              "cache-control": "public, max-age=300", // allow:raw-time-literal — HTTP Cache-Control directive seconds in a header string, not a duration expression
            }),
          });
        }
        return new Response(assoc, {
          status:  200,
          headers: _withSecurityHeaders({
            "content-type":  "text/plain; charset=utf-8",
            "cache-control": "public, max-age=300", // allow:raw-time-literal — HTTP Cache-Control directive seconds in a header string, not a duration expression
          }),
        });
      }
      if (pathname === "/feed.xml") {
        try {
          const page = await recentBlogArticles(env.DB, { limit: 20 });
          // Origin comes from the operator-configured bound env var so
          // an attacker-controlled `Host:` header can't surface in the
          // feed's `<link>` / `<guid>` elements (which downstream
          // readers fetch unattended). `b.safeUrl.parse` validates the
          // shape + scheme-allowlist (refuses javascript: / file: /
          // data:) and returns the normalized URL string; strip any
          // trailing slash so the origin concatenates cleanly with
          // per-article paths.
          const normalized = b.safeUrl.parse(env.D1_BRIDGE_URL || "https://blamejs.shop");
          const origin = normalized.href.replace(/\/$/, "");
          const xml = renderFeed({
            shopName: env.SHOP_NAME || "blamejs.shop",
            origin:   origin,
            articles: page.rows,
          });
          return new Response(xml, {
            status:  200,
            headers: _withSecurityHeaders({
              "content-type":  "application/rss+xml; charset=utf-8",
              "cache-control": "public, max-age=600, s-maxage=3600",
            }),
          });
        } catch (e) {
          console.error("feed.xml render failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
          // RSS readers consuming /feed.xml expect XML on success and
          // tolerate plain-text on failure (most retry with backoff).
          // The HTML 500 page would be misleading for a feed consumer,
          // so this stays text — but stays explicit (no container
          // pass-through).
          return new Response("Feed temporarily unavailable", {
            status:  503,
            headers: _withSecurityHeaders({
              "content-type":  "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "retry-after":   "60",
            }),
          });
        }
      }
    }

    // 2d. POST /newsletter — falls through to the container. The
    //     edge can't compose `b.crypto.namespaceHash` (SHA3-512 via
    //     `node:crypto.createHash` isn't in the set the Workers
    //     `nodejs_compat` runtime exposes — `Error: Digest method
    //     not supported`), and using a Web-Crypto-API SHA-256
    //     fallback would silently diverge from the container's
    //     SHA3-512 `email_hash` values, breaking the unsubscribe
    //     lookup. The ~200ms per-submit container hop is paid back
    //     by a consistent hash across substrates.

    // 3. Storefront read routes — render at the edge when enabled.
    //    Gated by env.EDGE_RENDER so it can be rolled back per-deploy
    //    without a re-push. Unauthenticated GETs are served from
    //    caches.default with a short TTL + stale-while-revalidate so
    //    repeat visitors get ~10-30ms TTFB. Requests carrying any
    //    session cookie (shop_sid / shop_auth) skip the cache —
    //    per-session content stays correct.
    if (env.EDGE_RENDER === "on" && (request.method === "GET" || request.method === "HEAD")) {
      const edgeResponse = await _edgeRenderCached(request, env, url, ctx);
      if (edgeResponse) return edgeResponse;
    }

    // 4. Stripe webhook — verify at the edge before forwarding. The
    //    container also verifies (defense in depth), but the edge
    //    pre-check rejects unsigned + replayed deliveries before any
    //    container resource is touched.
    if (pathname === (env.STRIPE_WEBHOOK_PATH || "/api/webhooks/stripe") && request.method === "POST") {
      if (!env.STRIPE_WEBHOOK_SECRET) return _json({ ok: false, error: "STRIPE_NOT_CONFIGURED" }, 503);
      const rawBody = await request.text();
      const header = request.headers.get("stripe-signature");
      const verified = await _verifyStripeSignature(rawBody, header, env.STRIPE_WEBHOOK_SECRET, 300);
      if (!verified.ok) return _json({ ok: false, error: "SIGNATURE_INVALID", reason: verified.reason }, 400);
      // Re-wrap the body for the container forward; the original
      // Request body was consumed by .text().
      const forwarded = new Request(request.url, {
        method:  "POST",
        headers: request.headers,
        body:    rawBody,
      });
      return _forwardToContainer(forwarded, env);
    }

    // 5. D1 bridge — the container's externalDb D1 adapter calls this
    //    to execute SQL. The bridge enforces a shared-secret header
    //    so a misconfigured route never accepts SQL from anywhere
    //    other than the bound container.
    const bridgePath = env.D1_BRIDGE_PATH || "/_/db/query";
    if (pathname === bridgePath && request.method === "POST") {
      const secret = request.headers.get("x-d1-bridge-secret");
      if (!env.D1_BRIDGE_SECRET || !_timingSafeEqual(secret || "", env.D1_BRIDGE_SECRET)) {
        return _json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }
      const body = await request.json().catch(() => null);
      if (!body || typeof body.sql !== "string") {
        return _json({ ok: false, error: "INVALID_REQUEST" }, 400);
      }
      try {
        const stmt = env.DB.prepare(body.sql);
        const bound = Array.isArray(body.params) && body.params.length ? stmt.bind(...body.params) : stmt;
        if (body.mode === "run") {
          const r = await bound.run();
          return _json({ ok: true, rows: [], rowCount: r.meta && r.meta.changes || 0, lastRowId: r.meta && r.meta.last_row_id || null });
        }
        const r = await bound.all();
        const rows = (r.results || []);
        return _json({ ok: true, rows: rows, rowCount: rows.length });
      } catch (e) {
        console.error("d1-bridge query failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        return _json({ ok: false, error: "QUERY_FAILED" }, 500);
      }
    }

    // 6. R2 upload bridge — the container's r2Bridge adapter calls
    //    this to stream media bytes to the bound R2 bucket. Same
    //    shared-secret gate as the D1 bridge; the key + content-type
    //    ride in request headers so the body stays a clean binary
    //    stream. The key shape is re-validated here so a compromised
    //    secret can't write arbitrary paths into the bucket.
    var r2Path = env.R2_BRIDGE_PATH || "/_/r2/put";
    if (pathname === r2Path && request.method === "POST") {
      var r2Secret = request.headers.get("x-d1-bridge-secret");
      if (!env.D1_BRIDGE_SECRET || !_timingSafeEqual(r2Secret || "", env.D1_BRIDGE_SECRET)) {
        return _json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }
      if (!env.ASSETS) {
        return _json({ ok: false, error: "R2_NOT_BOUND" }, 503);
      }
      var key = request.headers.get("x-r2-key");
      var contentType = request.headers.get("x-r2-content-type");
      if (!key || key.length > 1024 || key.charAt(0) === "/" || key.indexOf("..") !== -1) {
        return _json({ ok: false, error: "INVALID_KEY" }, 400);
      }
      if (!contentType || contentType.length > 255 ||
          !/^[\w.+\-]+\/[\w.+\-]+(?:\s*;\s*[\w.+\-]+=[\w.+\-"]+)*$/.test(contentType)) {
        return _json({ ok: false, error: "INVALID_CONTENT_TYPE" }, 400);
      }
      try {
        var body = await request.arrayBuffer();
        if (!body || body.byteLength === 0) {
          return _json({ ok: false, error: "EMPTY_BODY" }, 400);
        }
        await env.ASSETS.put(key, body, { httpMetadata: { contentType: contentType } });
        return _json({ ok: true, key: key, size: body.byteLength });
      } catch (e) {
        console.error("r2-bridge put failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        return _json({ ok: false, error: "PUT_FAILED" }, 500);
      }
    }

    // 7. Low-stock alert callback — invoked by the InventoryLock DO
    //    after a decrement that crosses the configured threshold.
    //    Gated by the same shared secret as the D1 bridge so a
    //    publicly-reachable URL can't fabricate an alert. The
    //    container handles the actual fan-out (alert row + webhooks
    //    + log line) via the inventory-alerts primitive.
    if (pathname === "/_/low-stock-alert" && request.method === "POST") {
      const lowStockSecret = request.headers.get("x-d1-bridge-secret");
      if (!env.D1_BRIDGE_SECRET || !_timingSafeEqual(lowStockSecret || "", env.D1_BRIDGE_SECRET)) {
        return _json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }
      return _forwardToContainer(request, env);
    }

    // 7b. Worker→container cron / event POSTs — shared-secret pre-check
    //     before the fall-through forward (defense-in-depth; the container
    //     re-validates the secret in each handler). When D1_BRIDGE_SECRET is
    //     configured, a missing / wrong header is refused HERE at the edge so
    //     a forged public POST never reaches the container; when it's
    //     unconfigured the check fails open and forwards, matching the
    //     /_/low-stock-alert gate above. The worker's own scheduled() fires
    //     always carry the header, so a configured deploy never blocks its
    //     own cron — the bot-guard-403'd-cron failure mode does not recur
    //     (this gate runs at the edge, never the container bot-guard).
    if (request.method === "POST" &&
        Object.prototype.hasOwnProperty.call(_INTERNAL_CRON_PATHS, pathname)) {
      if (env.D1_BRIDGE_SECRET) {
        const cronSecret = request.headers.get("x-d1-bridge-secret");
        if (!_timingSafeEqual(cronSecret || "", env.D1_BRIDGE_SECRET)) {
          return _json({ ok: false, error: "UNAUTHORIZED" }, 401);
        }
      }
      return _forwardToContainer(request, env);
    }

    // 8. Everything else — forward to the container.
    return _forwardToContainer(request, env);
    });
  },

  // Cron-triggered cache warmer. The wrangler.toml `[triggers]`
  // schedule fires this every minute; the handler GETs each
  // storefront read route with a browser-shaped header set so the
  // edge-render path runs and the result lands in caches.default at
  // each PoP the warmer reaches. The cache TTL is 60s so a once-a-
  // minute warm keeps every active PoP populated across the gap.
  // Auth-cookie-bearing visitors still bypass the cache (per-session
  // content stays correct) — only the unauthenticated default
  // fetches get warmed.
  async scheduled(_event, env, ctx) {
    // Abandoned-cart recovery tick — runs on every cron fire regardless
    // of EDGE_RENDER. POSTs the container's internal `/_/cart-recovery-tick`
    // over the SHOP service binding (never leaves the Cloudflare network),
    // authenticated with the shared D1_BRIDGE_SECRET header — same trust
    // root as the SQL / R2 bridges. The container handler runs one
    // bounded, drop-silent pass: scan idle carts, enrol the eligible
    // ones, dispatch due nurture steps. The pass no-ops cleanly when no
    // mailer is configured, so this is a cheap call on an unconfigured
    // deploy. Fire-and-forget under ctx.waitUntil so a slow pass never
    // blocks the cron; errors surface in the pass's own JSON summary (the
    // handler never 5xxes).
    if (env.D1_BRIDGE_SECRET) {
      ctx.waitUntil((async function () {
        try {
          var url = new URL("/_/cart-recovery-tick", "http://shop.container");
          var req = new Request(url.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          var container = _shopContainer(env);
          await container.fetch(req);
        } catch (e) {
          console.error("cart-recovery-tick failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Back-in-stock sweep — a SECOND, independent ctx.waitUntil (NOT nested
      // in the cart-recovery one) so a slow stock sweep never blocks cart
      // recovery and vice-versa. POSTs the container's /_/stock-alert-sweep
      // over the SHOP service binding with the shared D1_BRIDGE_SECRET header.
      // The cron fires every minute; the container handler self-gates cadence
      // (it only scans periodically), so this is a cheap call most ticks.
      ctx.waitUntil((async function () {
        try {
          var sweepUrl = new URL("/_/stock-alert-sweep", "http://shop.container");
          var sweepReq = new Request(sweepUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          var sweepContainer = _shopContainer(env);
          await sweepContainer.fetch(sweepReq);
        } catch (e) {
          console.error("stock-alert-sweep failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Wishlist alert sweep — event-driven "saved item dropped / restocked"
      // emails. A SEPARATE ctx.waitUntil so a slow sweep never blocks the
      // others. The container handler self-gates cadence (one real sweep
      // every few hours), so this is a cheap call most ticks. Inert
      // (enabled:false) on a deploy with no mailer.
      ctx.waitUntil((async function () {
        try {
          var wlaUrl = new URL("/_/wishlist-alerts-sweep", "http://shop.container");
          var wlaReq = new Request(wlaUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(wlaReq);
        } catch (e) {
          console.error("wishlist-alerts-sweep failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Wishlist digest sweep — the periodic rollup. dispatchTick self-
      // limits via next_dispatch_at <= now, so a minute-fire only picks up
      // due enrollments (cheap). SEPARATE ctx.waitUntil; inert without a
      // mailer.
      ctx.waitUntil((async function () {
        try {
          var wldUrl = new URL("/_/wishlist-digest-sweep", "http://shop.container");
          var wldReq = new Request(wldUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(wldReq);
        } catch (e) {
          console.error("wishlist-digest-sweep failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Stale-pending-order reaper — cancels pending orders older than the
      // TTL so their reserved stock holds release (an abandoned payment sheet
      // / expired PaymentIntent otherwise strands the hold forever). One
      // bounded reap pass per fire; SEPARATE ctx.waitUntil so a slow reap
      // never blocks the other ticks.
      ctx.waitUntil((async function () {
        try {
          var reapUrl = new URL("/_/stale-order-reap", "http://shop.container");
          var reapReq = new Request(reapUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(reapReq);
        } catch (e) {
          console.error("stale-order-reap failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Quote-expiry sweep — transitions responded B2B quotes whose
      // valid_until has elapsed to `expired`, so the operator console's
      // expired filter reflects the real lifecycle. One bounded, idempotent
      // pass per fire (per-row conditional UPDATE in the container — an
      // overlapping tick or a concurrent accept/reprice can't double-
      // transition). SEPARATE ctx.waitUntil so a slow sweep never blocks
      // the other ticks; a quiet table is a cheap read.
      ctx.waitUntil((async function () {
        try {
          var qeUrl = new URL("/_/quote-expiry-tick", "http://shop.container");
          var qeReq = new Request(qeUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(qeReq);
        } catch (e) {
          console.error("quote-expiry-tick failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Subscription plan-change scheduler — lands every pending plan change
      // whose effective clock has arrived (a customer's queued next-billing-
      // cycle upgrade/downgrade). POSTs the container's /_/subscription-plan-
      // changes-tick over the SHOP service binding with the shared
      // D1_BRIDGE_SECRET header. One bounded, idempotent pass per fire (the
      // container's per-row CAS claim means an overlapping tick can't double-
      // apply); inert (enabled:false) on a deploy without subscriptions/store-
      // credit composed. SEPARATE ctx.waitUntil so a slow sweep never blocks
      // the other ticks; a quiet table is a cheap read.
      ctx.waitUntil((async function () {
        try {
          var pcUrl = new URL("/_/subscription-plan-changes-tick", "http://shop.container");
          var pcReq = new Request(pcUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(pcReq);
        } catch (e) {
          console.error("subscription-plan-changes-tick failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Customer-portal magic-link expiry — flips stale issued tokens to
      // expired so the FSM audit column stays durable. Cheap bounded
      // UPDATE; SEPARATE ctx.waitUntil.
      ctx.waitUntil((async function () {
        try {
          var cpUrl = new URL("/_/customer-portal-expire", "http://shop.container");
          var cpReq = new Request(cpUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(cpReq);
        } catch (e) {
          console.error("customer-portal-expire failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Email-campaign broadcast tick — drains campaigns due for send (and
      // any parked mid-audience by a rate-budget pause) as consent-gated,
      // one-click-unsubscribable broadcasts. SEPARATE ctx.waitUntil so a
      // slow drain never blocks the others. The container handler self-
      // limits per pass via the send-rate window; inert without a mailer /
      // deliverable-address source.
      ctx.waitUntil((async function () {
        try {
          var csUrl = new URL("/_/campaign-send-tick", "http://shop.container");
          var csReq = new Request(csUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(csReq);
        } catch (e) {
          console.error("campaign-send-tick failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Win-back send tick — drains lapsed-customer re-engagement
      // sequences: scan the order history for customers gone quiet, enroll
      // the eligible, and send the due step as a marketing-consent + email-
      // suppression-gated message (an unsubscribed / marketing-withdrawn
      // lapsed customer is never emailed). SEPARATE ctx.waitUntil so a slow
      // pass never blocks the others. The container handler self-limits per
      // pass via the per-step next_step_at gate; inert without a mailer /
      // deliverable-address source.
      ctx.waitUntil((async function () {
        try {
          var wbUrl = new URL("/_/winback-send-tick", "http://shop.container");
          var wbReq = new Request(wbUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(wbReq);
        } catch (e) {
          console.error("winback-send-tick failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());

      // Outbound-webhook retry tick — re-attempts deliveries whose backoff has
      // come due, walking each toward success or the DLQ. SEPARATE ctx.waitUntil
      // so a slow retry pass never blocks the other crons (and vice versa). The
      // container handler claims each row atomically and never 5xxes.
      ctx.waitUntil((async function () {
        try {
          var whUrl = new URL("/_/webhook-retry-tick", "http://shop.container");
          var whReq = new Request(whUrl.toString(), {
            method:  "POST",
            headers: {
              "content-type":       "application/json; charset=utf-8",
              "x-d1-bridge-secret": env.D1_BRIDGE_SECRET || "",
            },
            body: "{}",
          });
          await _shopContainer(env).fetch(whReq);
        } catch (e) {
          console.error("webhook-retry-tick failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
        }
      })());
    }

    if (env.EDGE_RENDER !== "on") return;
    var routes = ["/", "/search"];
    var headers = {
      "user-agent":                "blamejs-shop cache-warmer (cron)",
      "accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language":           "en-US,en;q=0.9",
      "sec-fetch-mode":            "navigate",
      "sec-fetch-site":            "none",
      "sec-fetch-dest":            "document",
      "sec-fetch-user":            "?1",
      "upgrade-insecure-requests": "1",
    };
    // `b.safeUrl.parse` validates the operator-configured origin
    // against the HTTPS-only allowlist (refuses javascript: / file: /
    // data:) before the cron fires its warm requests. The normalized
    // return carries a trailing slash; strip it so the per-route
    // path concatenates cleanly.
    var origin = b.safeUrl.parse(env.D1_BRIDGE_URL || "https://blamejs.shop").href.replace(/\/$/, "");
    for (var i = 0; i < routes.length; i += 1) {
      ctx.waitUntil(
        fetch(origin + routes[i], { method: "GET", headers: headers })
          .catch(function (e) { console.error("cache-warmer " + routes[i] + " failed:", _redact(e && e.stack || e)); })  // allow:console-direct — Worker substrate; console.* IS the observability sink
      );
    }
  },
};

// ---- edge cache wrapper ---------------------------------------------------
//
// Wraps the edge-render router with a caches.default lookup. Cache
// keys are the full request URL; only unauthenticated requests
// (no shop_sid / shop_auth cookie) are eligible — per-session
// content would otherwise leak across visitors. Cached responses
// carry `cache-control: public, max-age=60, stale-while-revalidate=300`
// so the edge keeps serving stale HTML while a background revalidate
// fetches fresh data. /search is keyed including the `?q=` query so
// distinct searches don't collide; /search with no `q` parameter
// shares its cache entry with all other no-query visitors.

const CACHE_TTL_SECONDS = 60;
const CACHE_SWR_SECONDS = 300;

// Tracking query parameters that don't affect rendered output but
// would otherwise force distinct cache entries per referral source.
// Stripped from the cache key only — the original request URL stays
// intact so the rendered output (and any analytics that read the
// query) still sees the unmodified value.
var TRACKING_PARAMS_RE = /^(?:utm_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|mc_eid$|mc_cid$|_ga$|igshid$|ref$|fb_action_|trk_|yclid$)/i;

function _hasSessionCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  if (cookieHeader.length === 0) return false;
  // `b.cookies.parseSafe` handles the framework's parse rules
  // (token-grammar, length cap, duplicate-key resolution) without
  // throwing on bad input. The presence check inspects the
  // returned `jar` for either session cookie. Both names are checked
  // in their prefix-hardened (`__Host-`) and bare forms: the container
  // emits the `__Host-`-prefixed name over https (production) and the
  // bare name only over plain http (dev), so the edge must treat the
  // prefixed name as session-bearing too — otherwise a logged-in
  // visitor's per-session page could land in the shared edge cache.
  const parsed = b.cookies.parseSafe(cookieHeader);
  const has = function (name) {
    return Object.prototype.hasOwnProperty.call(parsed.jar, name);
  };
  return has("__Host-shop_sid")  || has("shop_sid") ||
         has("__Host-shop_auth") || has("shop_auth");
}

// Accept-Language tags in q-sorted order (primary preference first),
// lower-cased. A garbage / oversized header yields an empty list. Mirrors
// the container resolver's parser so the edge bypass decision and the
// container's actual resolution agree on which tag wins.
function _edgeAcceptLanguageTags(header) {
  if (typeof header !== "string" || !header.length || header.length > 4096) return [];
  // b.requestHelpers.parseQualityList is the RFC 9110 §12.5 parser, and the
  // container resolver reads the same header through it — which is what makes
  // "the edge and the container agree on which tag wins" true rather than
  // aspirational. Two copies of this loop had already drifted apart.
  //
  // It also settles two things the copies got wrong. `q=0` is an explicit
  // "not acceptable", so a tag carrying it is dropped rather than ranked last
  // — the old lists kept it and could serve a locale the visitor had ruled
  // out. And the `q` parameter name is case-insensitive: a header spelling it
  // `Q=0.9` was read as having no q at all here, so it ranked as 1 and won,
  // while the container read it correctly and chose differently.
  return b.requestHelpers.parseQualityList(header)
    .filter(function (e) { return e.value !== "*" && e.q > 0; })
    .map(function (e) { return { tag: e.value, q: e.q }; });
}

// True when a first-time visitor (no cookie, no `?lang=`) sends an
// `Accept-Language` whose top supported preference is a NON-default locale.
// Such a visitor must reach the container resolver (which honors
// Accept-Language per the documented order) rather than be served — and
// have cached — the default-locale edge render. The edge can't run the full
// resolver, but `SHOP_LOCALES` (the supported list) + `SHOP_DEFAULT_LOCALE`
// are enough to make the bypass decision with the SAME match rule the
// container uses (direct hit, then primary-subtag). A single-locale shop
// (no `SHOP_LOCALES`, or only the default) has nothing else to serve, so it
// never bypasses and keeps full edge caching for every Accept-Language.
function _acceptLanguageWantsNonDefault(request, env) {
  var supported = String((env && env.SHOP_LOCALES) || "")
    .split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (supported.length < 2) return false;
  var defPrimary = String((env && env.SHOP_DEFAULT_LOCALE) || "en").toLowerCase().split("-")[0];
  var tags = _edgeAcceptLanguageTags(request.headers.get("accept-language") || "");
  for (var i = 0; i < tags.length; i += 1) {
    var t = tags[i].tag;
    var matched = supported.indexOf(t) !== -1 ? t : null;
    if (!matched) { var p = t.split("-")[0]; if (supported.indexOf(p) !== -1) matched = p; }
    // First supported match wins (the container takes the same one). Bypass
    // only when it's a different language than the default — an `en-GB`
    // preference against an `en` default still serves the cached default.
    if (matched) return matched.split("-")[0] !== defPrimary;
  }
  return false;
}

// A request carries an explicit or implied locale choice when it has a
// `shop_locale` cookie, a `?lang=` query param, or an `Accept-Language`
// that resolves to a supported non-default locale. The edge serves only
// the storefront's DEFAULT locale (the cached output keys on URL, which
// can't vary by cookie/header); a locale-choosing request is forwarded to
// the container, which resolves + renders the chosen locale (with operator
// chrome overrides + the full set of pages). Treating it like a session
// cookie — bypassing the edge cache + the edge render — keeps the
// edge/container locale resolution from diverging and prevents one
// visitor's cached `de` page from leaking to a no-cookie visitor.
function _hasLocaleChoice(request, url, env) {
  if (url && url.searchParams && url.searchParams.has("lang")) return true;
  const cookieHeader = request.headers.get("cookie") || "";
  if (cookieHeader.length) {
    const parsed = b.cookies.parseSafe(cookieHeader);
    if (Object.prototype.hasOwnProperty.call(parsed.jar, "shop_locale")) return true;
  }
  return _acceptLanguageWantsNonDefault(request, env);
}

// Build a cache-key URL by removing tracking parameters from the
// request URL's query string. Two visitors arriving at `/` with
// different `utm_source` values now share the same cache entry.
function _cacheKeyUrl(originalUrl) {
  var u = new URL(originalUrl);
  var stripped = false;
  var keys = [];
  u.searchParams.forEach(function (_v, k) { keys.push(k); });
  for (var i = 0; i < keys.length; i += 1) {
    if (TRACKING_PARAMS_RE.test(keys[i])) {
      u.searchParams.delete(keys[i]);
      stripped = true;
    }
  }
  return stripped ? u.toString() : originalUrl;
}

async function _edgeRenderCached(request, env, url, ctx) {
  // Session-bound OR locale-choosing requests skip the cache: the cache
  // keys on URL only, so a per-session or per-locale response must never
  // be cached (it would leak to other visitors). Locale-choosing
  // requests additionally fall through `_edgeRender` to the container.
  if (_hasSessionCookie(request) || _hasLocaleChoice(request, url, env)) {
    return await _edgeRender(request, env, url);
  }
  // A visitor who chose a display currency carries the sealed `shop_ccy`
  // cookie. The edge can't unseal it (the vault keychain lives in the
  // container), so a converted page must come from the container — AND the
  // page must never land in the URL-keyed shared cache, or a EUR visitor's
  // page would be served to the next USD visitor at the same URL. Treat the
  // cookie as cache-disqualifying + fall through to the container.
  if (hasCurrencyCookie(request)) {
    return null;
  }
  const cache = caches.default;
  const cacheKey = new Request(_cacheKeyUrl(request.url), { method: "GET", headers: request.headers });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-edge-cache", "hit");
    return new Response(cached.body, { status: cached.status, headers: headers });
  }
  const fresh = await _edgeRender(request, env, url);
  if (!fresh) return null;
  if (fresh.status === 200) {
    const cacheableHeaders = new Headers(fresh.headers);
    cacheableHeaders.set(
      "cache-control",
      "public, max-age=" + CACHE_TTL_SECONDS + ", stale-while-revalidate=" + CACHE_SWR_SECONDS,
    );
    const cacheableBody = await fresh.clone().arrayBuffer();
    const cacheable = new Response(cacheableBody, { status: 200, headers: cacheableHeaders });
    ctx.waitUntil(cache.put(cacheKey, cacheable));
    const userHeaders = new Headers(fresh.headers);
    userHeaders.set("x-edge-cache", "miss");
    return new Response(cacheableBody, { status: 200, headers: userHeaders });
  }
  return fresh;
}

// ---- edge-render router ---------------------------------------------------
//
// Storefront read-side render at the edge. The Worker holds a direct
// D1 binding (`env.DB`) and bundles pure-JS renderers under
// worker/render/, so it can serve a complete HTML document without
// ever touching the container. The container retains the write-side
// surface (POST /cart/lines, /checkout, /admin) and any route that
// needs the sealed-session crypto stack.
//
// Returns a Response when the request matched a storefront route;
// returns null when the path is not an edge-served route, in which
// case the caller falls through to the container forward. Every
// storefront read route renders at the edge regardless of session
// state — the nav cart badge renders server-side at a placeholder
// count and a small client island corrects it from `/cart/count`
// (a container route that unseals `shop_sid`), so a carted visitor
// gets the fast cached render AND an accurate badge. The container
// retains `/cart` (the real cart page needs the sealed session).
async function _edgeRender(request, env, url) {
  const version  = env.WORKER_VERSION || assetManifest.version;
  const shopName = env.SHOP_NAME      || "blamejs.shop";
  const path     = url.pathname;

  // A request that's choosing a locale (cookie or ?lang=) is forwarded
  // to the container, which renders the chosen locale's chrome (with
  // operator overrides + the switcher) for every page. The edge only
  // ever serves the default-locale chrome, so handing these off keeps
  // the two substrates' resolution from diverging.
  if (_hasLocaleChoice(request, url, env)) return null;

  if (path === "/") {
    return await _edgeHome(request, env, url, version, shopName);
  }
  if (path === "/search") {
    return await _edgeSearch(request, env, url, version, shopName);
  }
  if (path.startsWith("/products/") && path.length > "/products/".length) {
    const slug = decodeURIComponent(path.slice("/products/".length));
    // A product slug is a single path segment. Sub-paths like
    // /products/:slug/review are container routes (the verified-buyer
    // review form + submit) — fall through to container forwarding
    // rather than 404-ing them as a bogus slug at the edge.
    if (slug.indexOf("/") !== -1) return null;
    return await _edgeProduct(request, env, url, version, shopName, slug);
  }
  if (path === "/cart") {
    // Guests (no session cookie) see the empty-cart render straight
    // from the edge — no container hop, no sealed-session decrypt.
    // Visitors with a `shop_sid` / `shop_auth` cookie fall through
    // to the container path which has the framework's vault keychain
    // and can decrypt the session to look up the real cart row.
    if (_hasSessionCookie(request)) return null;
    return await _edgeCartEmpty(request, env, version, shopName);
  }
  if (path === "/blog") {
    return await _edgeBlogList(request, env, url, version, shopName);
  }
  if (path.startsWith("/blog/") && path.length > "/blog/".length) {
    const slug = decodeURIComponent(path.slice("/blog/".length));
    return await _edgeBlogArticle(request, env, url, version, shopName, slug);
  }
  if (path.startsWith("/pages/") && path.length > "/pages/".length) {
    const slug = decodeURIComponent(path.slice("/pages/".length));
    // A page slug is a single path segment. A sub-path under a page slug
    // isn't a content page — fall through to the container rather than
    // 404-ing it here.
    if (slug.indexOf("/") !== -1) return null;
    return await _edgePage(request, env, url, version, shopName, slug);
  }
  return null;
}

// Edge 5xx renderer. The edge handler's responsibility is to either
// serve the rendered content or report failure cleanly — never
// silently escalate to the container, because (a) the container
// runs the same primitive surface and won't fix a render-side bug,
// (b) the visitor experience of "fallback to a different backend
// after the edge fell over" is worse than a clean error page, and
// (c) the escalation hides the bug from observability. Logging
// stays explicit so Cloudflare tail / Logpush still sees the cause.
function _edgeError(route, e, request, env, version, shopName) {
  console.error("edge render " + route + " failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
  const html = renderInternalError({
    shopName: shopName,
    version:  version,
  });
  return new Response(request.method === "HEAD" ? null : html, {
    status:  500,
    headers: _withSecurityHeaders({
      "content-type":  "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

async function _edgeCartEmpty(request, env, version, shopName) {
  try {
    const html = renderCart(Object.assign({
      lines:         [],
      totals:        { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
      productLookup: {},
      shopName:      shopName,
      cartCount:     0,
      version:       version,
      defaultLocale: env.SHOP_DEFAULT_LOCALE || "en",
      announcement:  await resolveAnnouncement(env.DB, {}),
      promoBanners:  await resolvePromoBanners(env.DB, {}),
      sidebarWidgets: await resolveSidebarWidgets(env.DB, { page_key: "cart" }),
      sidebarPageKey: "cart",
    }, _currencyRenderOpts(env, { pathname: "/cart" })));
    // /cart is a session-bound surface even when the guest cart is
    // empty — crawlers indexing it dilute search results with
    // empty-state pages and produce stale "Your cart is empty"
    // snippets in SERPs. The `x-robots-tag: noindex,nofollow` header
    // set below is the indexing defense; the edge + container
    // robots.txt also `Disallow: /cart` to match.
    const headers = _withSecurityHeaders({
      "content-type":  "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag":  "noindex, nofollow",
      "link":          _earlyHintsLink(env || {}),
    });
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: headers });
    return new Response(_minify(html), { status: 200, headers: headers });
  } catch (e) {
    return _edgeError("/cart", e, request, env, version, shopName);
  }
}

const BLOG_PAGE_SIZE = 12;

// Read the 1-based `?page=N` index page off the request URL. A missing,
// non-integer, or sub-1 value reads as page 1 (the canonical first page).
// Defensive request-shape reader — returns the safe default for any
// garbage rather than 500-ing, matching how /search + /collections treat a
// bad pagination param.
function _blogPageParam(url) {
  const raw = url && url.searchParams ? url.searchParams.get("page") : null;
  if (raw == null || !/^[0-9]{1,9}$/.test(raw)) return 1;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : 1;
}

async function _edgeBlogList(request, env, _url, version, shopName) {
  try {
    const page   = _blogPageParam(_url);
    const offset = (page - 1) * BLOG_PAGE_SIZE;
    // Peek one row past the page so the pager advertises a Next link only
    // when a real next page exists — never a phantom one that renders empty
    // (the blog data layer exposes no total). The peeked row is sliced off
    // before render.
    const result  = await listBlogArticles(env.DB, { limit: BLOG_PAGE_SIZE + 1, offset: offset });
    const hasNext = result.rows.length > BLOG_PAGE_SIZE;
    const rows    = hasNext ? result.rows.slice(0, BLOG_PAGE_SIZE) : result.rows;
    const html = renderBlogList(Object.assign({
      articles: rows,
      shopName: shopName,
      version:  version,
      page:     page,
      hasNext:  hasNext,
      canonicalUrl: _url.origin + _url.pathname,
      announcement: await resolveAnnouncement(env.DB, {}),
    }, _localeRenderOpts(env, _url)));
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/blog", e, request, env, version, shopName);
  }
}

async function _edgeBlogArticle(request, env, _url, version, shopName, slug) {
  try {
    const article = await getBlogArticleBySlug(env.DB, slug);
    if (!article) {
      const html = renderNotFound({
        what:     "blog post",
        shopName: shopName,
        version:  version,
      });
      return new Response(request.method === "HEAD" ? null : html, {
        status:  404,
        headers: _withSecurityHeaders({
          "content-type":  "text/html; charset=utf-8",
          "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
        }),
      });
    }
    const html = renderBlogArticle(Object.assign({
      article:  article,
      shopName: shopName,
      version:  version,
      canonicalUrl: _url.origin + _url.pathname,
      announcement: await resolveAnnouncement(env.DB, {}),
    }, _localeRenderOpts(env, _url)));
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/blog/:slug", e, request, env, version, shopName);
  }
}

// Storefront CMS page at /pages/:slug. Reads ONLY published rows
// (getPublishedPageBySlug filters on status='published'), so a draft /
// archived / unknown slug renders the same 404 as a missing product —
// staged and retired copy stays off the public storefront. The 404 is
// cacheable (short TTL) so a crawler doesn't hammer the origin on a bad
// link, while staying short enough that a freshly-published page appears
// quickly.
async function _edgePage(request, env, _url, version, shopName, slug) {
  try {
    const page = await getPublishedPageBySlug(env.DB, slug);
    if (!page) {
      const html = renderNotFound({
        what:     "page",
        shopName: shopName,
        version:  version,
      });
      return new Response(request.method === "HEAD" ? null : html, {
        status:  404,
        headers: _withSecurityHeaders({
          "content-type":  "text/html; charset=utf-8",
          "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
        }),
      });
    }
    const html = renderStorefrontPage(Object.assign({
      page:     page,
      shopName: shopName,
      version:  version,
      canonicalUrl: _url.origin + _url.pathname,
      announcement: await resolveAnnouncement(env.DB, {}),
    }, _localeRenderOpts(env, _url)));
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/pages/:slug", e, request, env, version, shopName);
  }
}

// Operator's display-currency allow-list for the footer switcher, read
// from SHOP_CURRENCIES (comma-separated, base first). The edge serves the
// switcher in its base state to anonymous cache-eligible visitors — the
// converted display itself comes from the container once the visitor has
// chosen a currency (the sealed `shop_ccy` cookie disqualifies the edge
// cache + falls through). `currencyRenderOpts` returns the markup fields
// the renderers thread into their footer; an empty list (single-currency
// store) yields no switcher.
function _currencyOptions(env) {
  var base = (env.SHOP_BASE_CURRENCY || "USD").toUpperCase();
  var raw  = (env.SHOP_CURRENCIES || base);
  var list = String(raw).split(",")
    .map(function (s) { return s.trim().toUpperCase(); })
    .filter(function (s) { return /^[A-Z]{3}$/.test(s); });
  if (list.indexOf(base) === -1) list.unshift(base);
  return { base: base, options: list };
}

function _currencyRenderOpts(env, url) {
  var c = _currencyOptions(env);
  if (c.options.length < 2) return {};
  return {
    currencyOptions:    c.options,
    currencySelected:   c.base,
    currencyRedirectTo: (url && url.pathname) || "/",
  };
}

// Absolute canonical + og:url for an edge-rendered page. `canonicalUrl`
// is origin + path (query stripped — the canonical names the page, not a
// filtered/sorted view); `ogUrl` keeps the query so a share of a filtered
// listing unfurls to that exact view. Origin comes from the live request
// URL so the value matches the host the visitor reached.
function _canonicalRenderOpts(url) {
  if (!url || typeof url.origin !== "string") return { canonicalUrl: "", ogUrl: "" };
  return {
    canonicalUrl: url.origin + url.pathname,
    ogUrl:        url.origin + url.pathname + (url.search || ""),
  };
}

// Locale render opts for the edge `<html lang/dir>` localization + the
// hreflang alternates. The edge serves the storefront's DEFAULT locale
// only, so `defaultLocale` drives `<html lang>`; hreflang is emitted only
// for a URL-shaped policy (`SHOP_LOCALE_STRATEGY` = url_prefix / subdomain)
// with a supported list of two or more locales. `host` + `path` come from
// the live request URL so the alternates carry the host the visitor
// reached. A non-URL strategy / single-locale store yields no hreflang
// (the renderers' `alternateLinks` returns "" for those inputs).
function _localeRenderOpts(env, url) {
  var supported = String((env && env.SHOP_LOCALES) || "")
    .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    defaultLocale:    (env && env.SHOP_DEFAULT_LOCALE) || "en",
    supportedLocales: supported,
    localeStrategy:   (env && env.SHOP_LOCALE_STRATEGY) || null,
    host:             (url && typeof url.host === "string") ? url.host : null,
    path:             (url && typeof url.pathname === "string") ? url.pathname : null,
  };
}

async function _edgeHome(request, env, _url, version, shopName) {
  try {
    const page = await listActiveProducts(env.DB, { limit: 24, currency: "USD" });
    const ann = await resolveAnnouncement(env.DB, {});
    const promos = await resolvePromoBanners(env.DB, {});
    // Featured-collections band data — active collections, newest-curated
    // first, capped at 6. Best-effort: a band read failure degrades to no
    // band, never blocking the cached home page. The band drops itself when
    // the list is empty. Cache-safe: operator-curated, identical for all.
    let collections = [];
    try { collections = await listActiveCollections(env.DB, { limit: 6 }); }
    catch (_e) { collections = []; }
    // Operator-curated right-rail widgets for the home page (guest audience —
    // the edge serves cacheable anonymous reads). Best-effort: a read failure
    // degrades to no rail. Byte-identical to the container's home rail.
    const sidebarWidgets = await resolveSidebarWidgets(env.DB, { page_key: "home" });
    const html = renderHome(Object.assign({
      products:  page.rows,
      collections: collections,
      shopName:  shopName,
      cartCount: 0,
      version:   version,
      announcement: ann,
      promoBanners: promos,
      sidebarWidgets: sidebarWidgets,
      sidebarPageKey: "home",
      // The edge serves the storefront's default locale; any explicit
      // locale choice bypasses the edge to the container.
      defaultLocale: env.SHOP_DEFAULT_LOCALE || "en",
    }, _localeRenderOpts(env, _url), _canonicalRenderOpts(_url), _currencyRenderOpts(env, _url)));
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/", e, request, env, version, shopName);
  }
}

// Hard caps mirroring `lib/search-facets.js`'s applied-filter
// validators so a hostile / stale URL can't blow the in-memory facet
// walk. Garbage values and unknown facet keys are dropped rather than
// refused: a shopper who lands on a link with a removed-facet param
// still gets a clean results page.
var SEARCH_MAX_FACET_KEYS    = 32;
var SEARCH_MAX_FACET_VALUES  = 64;
var SEARCH_MAX_VALUE_LEN     = 256;
// The codepoints a facet VALUE may not carry. The container screens the same
// parameter through lib/text-guard.js `hasCodepointThreat(v, { singleLine })`,
// which this must match exactly: a value one substrate keeps and the other
// drops means the same URL paints different filter chrome depending on whether
// the page came off the edge cache. text-guard is CommonJS and cannot be
// imported here, so both sides compose b.codepointClass instead, and
// search-faceting-parity compares the two accept/reject sets codepoint by
// codepoint rather than trusting them to be spelled alike.
//
// C0 + DEL + the two line separators, then the catalog's bidi class — which is
// the overrides, the isolates AND the direction marks.
//
// The marks belong here even though the container's shared screen permits them
// in prose. A facet value is machine-plain: it is matched against the facet
// values the operator defined, so an invisible character in one can only ever
// make a chip read as a value nobody selected. The container's facet parser
// takes the same position by not passing `bidiMarks: "allow"`, and the parity
// test compares the two across the whole plane.
var SEARCH_CONTROL_BYTE_RE   = new RegExp(
  "[" + b.codepointClass.charClass([[0x0000, 0x001F], 0x007F, [0x2028, 0x2029]]) + "]" +
  "|" + b.codepointClass.BIDI_RE.source
);

// The fixed search page size — mirrors lib/storefront.js SEARCH_PAGE_SIZE
// so the edge and container page the result grid identically.
var SEARCH_PAGE_SIZE = 24;

// 1-based `?page=N` results page off a parsed URL. Missing / non-integer /
// sub-1 reads as page 1; the upper bound is clamped against the real page
// count by `_clampSearchPage` once the total is known. Mirrors the
// container's `_parsePageParam`.
function _parseSearchPage(url) {
  if (!url || !url.searchParams) return 1;
  var raw = url.searchParams.get("page");
  if (raw == null) return 1;
  if (!/^[0-9]{1,9}$/.test(raw)) return 1;
  var n = parseInt(raw, 10);
  return n >= 1 ? n : 1;
}

// Clamp a 1-based page to [1, lastPage]. A `?page` past the end serves the
// last page rather than an empty grid. Mirrors the container's `_clampPage`.
function _clampSearchPage(page, total, pageSize) {
  var size = pageSize > 0 ? pageSize : SEARCH_PAGE_SIZE;
  var lastPage = Math.max(1, Math.ceil(total / size));
  if (page < 1) return 1;
  if (page > lastPage) return lastPage;
  return page;
}

// Parse `?key=value` repeats into the `{ facetKey: [value, ...] }`
// shape the faceting module consumes, keeping only keys that match a
// loaded facet definition and values that survive the length / control-
// byte guards. `facets` is the loaded definition list.
function _parseAppliedFilters(searchParams, facets) {
  var known = {};
  for (var i = 0; i < facets.length; i += 1) known[facets[i].key] = true;
  var out = {};
  var keyCount = 0;
  searchParams.forEach(function (rawVal, rawKey) {
    if (rawKey === "q") return;
    if (!Object.prototype.hasOwnProperty.call(known, rawKey)) return;
    if (typeof rawVal !== "string") return;
    if (!rawVal.length || rawVal.length > SEARCH_MAX_VALUE_LEN) return;
    if (SEARCH_CONTROL_BYTE_RE.test(rawVal)) return;
    if (!Object.prototype.hasOwnProperty.call(out, rawKey)) {
      if (keyCount >= SEARCH_MAX_FACET_KEYS) return;
      out[rawKey] = [];
      keyCount += 1;
    }
    var arr = out[rawKey];
    if (arr.length >= SEARCH_MAX_FACET_VALUES) return;
    if (arr.indexOf(rawVal) !== -1) return;
    arr.push(rawVal);
  });
  return out;
}

async function _edgeSearch(request, env, url, version, shopName) {
  try {
    const qRaw = url.searchParams.get("q") || "";
    const q    = qRaw.length > 200 ? qRaw.slice(0, 200) : qRaw;
    let products    = [];
    let facets      = [];
    let filters     = {};
    let correctedQ  = "";
    let totalCount  = 0;
    let page        = _parseSearchPage(url);
    if (q.trim().length > 0) {
      // Synonym + typo rewrite expands the typed query into the
      // canonical term plus operator-curated expansions BEFORE the
      // product query runs, so "tee" matches "t-shirt".
      const vocab   = await loadSearchSynonymVocab(env.DB);
      const rewrite = rewriteQuery(q, vocab);
      correctedQ = rewrite.canonical;
      const terms = [];
      if (rewrite.canonical.length) terms.push(rewrite.canonical);
      for (let i = 0; i < rewrite.expansions.length; i += 1) terms.push(rewrite.expansions[i]);
      // Fall back to the raw query when rewrite produced nothing
      // (e.g. an all-stopword query) so search never silently drops
      // to empty on a non-empty input.
      if (!terms.length) terms.push(q.trim());

      const facetDefs = await loadSearchFacets(env.DB);
      filters = _parseAppliedFilters(url.searchParams, facetDefs);

      const universe = await searchFacetableProducts(env.DB, { terms: terms, currency: "USD" });
      // Counts reflect the full match set with the focal facet left
      // open; the result grid is the set narrowed by every filter. The
      // narrowed set's full length is the REAL total (drives the honest
      // result-count copy + the page count); the grid is the windowed
      // page, so products past the first page are reachable via `?page=N`
      // rather than discarded at 24.
      facets   = computeFacets(facetDefs, universe.rows, filters);
      let matched = applyFilters(facetDefs, universe.rows, filters);
      // Operator-tunable rerank — applied to the matched set BEFORE the page
      // slice so pins + weights reorder across ALL pages, identical to the
      // container's `_rerankUniverse` (which ranks the full universe before
      // faceting windows it). Faceting preserves input order, so ranking the
      // post-filter matched set yields the same relative order as the
      // container's rank-then-filter; the `search-ranking-parity` test pins
      // the two. NEVER-500: ranking is supplementary to search — a missing
      // table, no active weight set, or any throw degrades to the un-ranked
      // matched order rather than failing the page. Edge-cache coherence: the
      // ranking config is read fresh on every cache MISS, so an operator
      // weight/pin change is visible within the same max-age=60 /
      // stale-while-revalidate=300 window every other edge config change uses.
      try {
        const ranking = await loadSearchRanking(env.DB, normalizeRankingQuery(q));
        const projected = projectForRanking(matched);
        const ranked = applyRanking(ranking.weights, ranking.pins, projected);
        if (Array.isArray(ranked) && ranked.length === matched.length) matched = ranked;
      } catch (_rankErr) {
        // Un-ranked fallback — search still serves the default order.
      }
      totalCount = matched.length;
      page = _clampSearchPage(page, totalCount, SEARCH_PAGE_SIZE);
      products = matched.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE);
    }
    const html = renderSearch(Object.assign({
      q:              q,
      products:       products,
      facets:         facets,
      filters:        filters,
      correctedQuery: correctedQ,
      total:          totalCount,
      page:           page,
      pageSize:       SEARCH_PAGE_SIZE,
      shopName:       shopName,
      cartCount:      0,
      version:        version,
      defaultLocale:  env.SHOP_DEFAULT_LOCALE || "en",
      announcement:   await resolveAnnouncement(env.DB, {}),
      promoBanners:   await resolvePromoBanners(env.DB, {}),
      sidebarWidgets: await resolveSidebarWidgets(env.DB, { page_key: "search" }),
      sidebarPageKey: "search",
    }, _localeRenderOpts(env, url), _canonicalRenderOpts(url), _currencyRenderOpts(env, url)));
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/search", e, request, env, version, shopName);
  }
}

async function _edgeProduct(request, env, url, version, shopName, slug) {
  try {
    const product = await getProductBySlug(env.DB, slug);
    if (!product) {
      // Render the edge 404 inline — no container hop. Cached briefly
      // so a crawler hitting many stale slugs doesn't re-render each
      // one, but with `must-revalidate` so the answer flips back to
      // a real page the moment the product is reinstated.
      const html = renderNotFound({
        what:     "product",
        shopName: shopName,
        version:  version,
      });
      return new Response(request.method === "HEAD" ? null : html, {
        status:  404,
        headers: _withSecurityHeaders({
          "content-type":  "text/html; charset=utf-8",
          "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
        }),
      });
    }
    const [variantsWithPrices, media, reviewSummary, reviewList, qaThreads, wishlistCount] = await Promise.all([
      listVariantsWithPrices(env.DB, product.id, "USD"),
      listMediaForProduct(env.DB, product.id),
      getReviewSummary(env.DB, product.id),
      listPublishedReviews(env.DB, product.id, 10),
      listProductQaThreads(env.DB, product.id, 20),
      getWishlistCount(env.DB, product.id),
    ]);
    const variants = [];
    const prices = {};
    for (let i = 0; i < variantsWithPrices.rows.length; i += 1) {
      const r = variantsWithPrices.rows[i];
      variants.push({
        id:                r.id,
        product_id:        r.product_id,
        sku:               r.sku,
        title:             r.title,
        options_json:      r.options_json,
        weight_grams:      r.weight_grams,
        requires_shipping: r.requires_shipping,
        position:          r.position,
        created_at:        r.created_at,
        updated_at:        r.updated_at,
      });
      if (r.price_amount_minor != null) {
        prices[r.id] = {
          id:           r.price_id,
          variant_id:   r.id,
          amount_minor: r.price_amount_minor,
          currency:     r.price_currency,
        };
      }
    }
    // "Write a review" CTA → the container's auth-gated form route,
    // which enforces login + the verified-purchase gate. encodeURIComponent
    // keeps the slug safe inside the href attribute.
    const reviewForm = '<a class="btn-secondary reviews__cta" href="/products/'
      + encodeURIComponent(product.slug) + '/review">Write a review</a>';
    // "Ask a question" CTA → the container's auth-gated form route,
    // which enforces login. encodeURIComponent keeps the slug safe
    // inside the href attribute.
    const qaForm = '<a class="btn-secondary reviews__cta" href="/products/'
      + encodeURIComponent(product.slug) + '/question">Ask a question</a>';
    // Bundle offers + the quantity-break table for the first variant.
    // Both price server-side from the live D1 catalog (the edge mirror
    // of the container's server-authoritative resolution) and both
    // degrade to empty on a missing-table read so the PDP renders.
    const variantSkus = variants.map(function (v) { return v.sku; });
    const firstVariant = variants[0] || null;
    const firstPrice = firstVariant ? prices[firstVariant.id] : null;
    // Inventory map for the truthful availability badge + JSON-LD, the
    // edge mirror of the container's per-SKU `inventory.get` loop. A SKU
    // with no row is absent → the renderer reads it as available.
    // "You may also like" picks — same-collection siblings in a
    // deterministic order, the edge mirror of the container's
    // lib/storefront.js#_relatedProductsFor. Priced in base USD here; the
    // renderer's `fmt` applies any active display-currency conversion, so
    // the rail tracks the visitor's chosen currency identically to the
    // buy-box prices.
    const [bundleOffers, qtyBreaks, inventory, related, preorderCampaign] = await Promise.all([
      getBundlesForProduct(env.DB, variantSkus, "USD"),
      firstVariant && firstPrice
        ? getQtyBreaksForSku(env.DB, firstVariant.sku, firstPrice.amount_minor, firstPrice.currency, b.money)
        : Promise.resolve([]),
      listInventoryForSkus(env.DB, variantSkus),
      listRelatedProducts(env.DB, product.id, "USD", 4),
      // Pre-order campaign for the lead SKU — when OPEN, the renderer swaps the
      // add-to-cart buy box for the reservation CTA (release date + remaining).
      // One indexed read on the live D1; null (no campaign / no table) renders
      // the standard buy box. Resolved here so the edge + container PDP agree.
      firstVariant ? getOpenPreorderForSku(env.DB, firstVariant.sku) : Promise.resolve(null),
    ]);
    const html = renderProduct(Object.assign({
      product:       product,
      variants:      variants,
      prices:        prices,
      media:         media.rows,
      inventory:     inventory,
      reviewSummary: reviewSummary,
      reviews:       reviewList.rows,
      reviewForm:    reviewForm,
      qaQuestions:   qaThreads.rows,
      qaForm:        qaForm,
      bundleOffers:  bundleOffers,
      qtyBreaks:     qtyBreaks,
      wishlistCount: wishlistCount,
      related:       related.rows,
      preorderCampaign: preorderCampaign,
      preorderNotice:   url && url.searchParams ? url.searchParams.get("preorder") : null,
      announcement:  await resolveAnnouncement(env.DB, {}),
      promoBanners:  await resolvePromoBanners(env.DB, {}),
      sidebarWidgets: await resolveSidebarWidgets(env.DB, { page_key: "product" }),
      sidebarPageKey: "product",
      shopName:      shopName,
      cartCount:     0,
      version:       version,
      defaultLocale: env.SHOP_DEFAULT_LOCALE || "en",
    }, _localeRenderOpts(env, url), _canonicalRenderOpts(url), _currencyRenderOpts(env, url)));
    // Hero-image preload — the PDP's LCP element is almost always the
    // first media row's image. Preloading it via Link rel=preload
    // tells Cloudflare's Early Hints to include the asset URL in the
    // HTTP/103 frame, so the browser starts the image fetch before
    // the HTML body finishes streaming. Skips when the product has
    // no media (the placeholder letter-mark fallback renders without
    // a network fetch).
    const heroPreload = media.rows.length > 0
      ? [{ href: "/assets/" + media.rows[0].r2_key, as: "image" }]
      : [];
    return _html(html, request.method, env, heroPreload);
  } catch (e) {
    return _edgeError("/products/:slug", e, request, env, version, shopName);
  }
}

// Canonical security headers the container's middleware adds via
// the framework's `b.middleware.securityHeaders` pipeline. Edge
// responses must carry the same set so the security posture is
// uniform across paths regardless of which substrate serves them.
// CSP / Permissions-Policy / Referrer-Policy / X-Frame-Options /
// X-Content-Type-Options / Cross-Origin-*-Policy headers ship on
// every HTML response from the Worker, matching the framework's
// posture documented at `lib/vendor/blamejs/lib/middleware/
// security-headers.js#DEFAULT_*`.
//
// No Document-Policy header is emitted here, and the container
// suppresses the vendored default's copy (lib/security-middleware.js
// securityHeadersOpts → documentPolicy:false) so the two substrates
// stay consistent. The vendored default's tokens (document-write,
// unsized-media, oversized-images) are not recognized by current
// browsers — they only produce "Unrecognized document policy feature
// name" console warnings and enforce nothing.
//
// The CSP below is nonce-free here (script-src 'self'); the container
// renders a per-request nonce. Either way, Cloudflare Web Analytics is
// incompatible with this policy: enabling it for the zone makes the CDN
// auto-inject an inline loader for static.cloudflareinsights.com that
// carries no nonce and is not 'self', so the strict script-src refuses
// it (the console shows two CSP errors per page). The fix is to leave it
// OFF for this zone rather than add 'unsafe-inline' / a beacon host to
// script-src — the shop injects no beacon, so there is nothing in-repo
// to nonce. Keep Web Analytics disabled in the Cloudflare dashboard.
var _SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self'; " +
    "img-src 'self' data:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "fenced-frame-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "object-src 'none'; " +
    "require-trusted-types-for 'script'; " +
    "trusted-types 'allow-duplicates' default;",
  "cross-origin-opener-policy":   "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster":          "?1",
  // Must list the SAME directives as the container's vendored
  // DEFAULT_PERMISSIONS (lib/vendor/blamejs/lib/middleware/
  // security-headers.js) — the two substrates serve one origin, and a
  // shorter edge list silently weakens pages the edge happens to serve.
  // A parity test diffs this string against the vendored list, so a
  // vendor refresh that grows the denylist fails the gate here instead
  // of drifting. The edge never hosts passkey or payment ceremonies, so
  // every directive stays deny-all; the container relaxes per-route.
  "permissions-policy":
    "accelerometer=(), ambient-light-sensor=(), autoplay=(), camera=(), " +
    "display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), " +
    "gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), " +
    "picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), " +
    "sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=(), " +
    "interest-cohort=(), attribution-reporting=(), bluetooth=(), hid=(), " +
    "serial=(), idle-detection=(), local-fonts=(), compute-pressure=(), " +
    "window-management=(), private-state-token-issuance=(), " +
    "private-state-token-redemption=(), storage-access=(), browsing-topics=(), " +
    "private-aggregation=(), controlled-frame=(), captured-surface-control=(), " +
    "identity-credentials-get=(), attribution-reporting-cross-site=(), " +
    "publickey-credentials-create=(), join-ad-interest-group=(), " +
    "run-ad-auction=(), shared-storage=(), shared-storage-select-url=(), " +
    "smartcard=(), all-screens-capture=(), deferred-fetch=()",
  // `same-origin`, not `no-referrer`: under no-referrer, browsers opaque
  // the Origin header to "null" on same-origin navigational form POSTs,
  // which the container's CSRF origin pre-check refuses before the token
  // is read — 403-ing checkout and every account/admin form submit.
  // `same-origin` keeps the external posture identical (no referrer ever
  // leaves the site) while restoring a real Origin on same-origin POSTs.
  // Must match the container (lib/security-middleware.js
  // securityHeadersOpts → referrerPolicy) so edge-served pages don't
  // re-break the forms they host.
  "referrer-policy":          "same-origin",
  "x-content-type-options":   "nosniff",
  "x-dns-prefetch-control":   "off",
  "x-frame-options":          "DENY",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
};

function _withSecurityHeaders(base) {
  var out = Object.assign({}, _SECURITY_HEADERS);
  if (base) {
    var keys = Object.keys(base);
    for (var i = 0; i < keys.length; i += 1) out[keys[i]] = base[keys[i]];
  }
  return out;
}

// Stamp the protective response headers onto an R2-served asset. R2
// stores arbitrary operator-supplied bytes (the media upload path writes
// whatever the operator attaches), so the bytes leave the bucket with a
// content-type the operator declared, not one the edge verified — without
// these headers a browser can MIME-sniff a mis-typed upload into something
// it will execute, and one origin's assets can be embedded cross-site.
//
//   X-Content-Type-Options: nosniff      — pin the declared content-type;
//     no sniffing a `text/plain` upload into `text/html` or a script.
//   Cross-Origin-Resource-Policy: same-origin — the storefront references
//     every asset same-origin (`/assets/…` on its own pages), so a
//     same-origin policy is the tightest value that renders the site;
//     it stops other origins from embedding the bucket's bytes.
//
// SVG is the sharp edge: `image/svg+xml` opened by DIRECT navigation runs
// embedded script in the document's own origin even though the upload path
// sanitizes it before storage. Sandbox a directly-navigated SVG with a CSP
// that allows only inline styles (so `<img src=…svg>` still paints the
// vector) and nothing else — no script, no fetch, no plugin. The
// `cross-origin-resource-policy` already shipped above covers the embed
// case; this closes the run-on-direct-navigation case behind the
// container-side sanitizer (defence in depth).
function _hardenAssetResponse(headers) {
  // The edge owns the asset security posture, not operator-set R2 object
  // metadata — set unconditionally so a stored header can't weaken it.
  headers.set("x-content-type-options", "nosniff");
  headers.set("cross-origin-resource-policy", "same-origin");
  var ct = String(headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (ct === "image/svg+xml") {
    headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  return headers;
}

// Link `rel=preload` for the critical theme stylesheet. Cloudflare
// promotes Link headers on 200 responses to HTTP/103 Early Hints
// frames automatically — repeat visitors see the stylesheet fetch
// start before the HTML body arrives, accelerating First Contentful
// Paint and Largest Contentful Paint. The single preload covers the
// theme bundle every page references; per-route preloads (hero
// images, etc.) compose by appending to the same header.
function _earlyHintsLink(env, extras) {
  // Same fingerprinted URL the document stylesheet `<link>` emits (the
  // renderers resolve `css/main.css` to its content-fingerprinted path via
  // the shared manifest helper), so the HTTP/103 preload target matches what
  // the page actually requests — a divergent URL would make the browser
  // fetch the stylesheet twice.
  // No `crossorigin` — the preload target is same-origin and the
  // matching `<link rel="stylesheet">` tag has no `crossorigin`
  // either. Adding `crossorigin` to the preload makes the browser
  // treat it as a CORS request; the stylesheet load (without the
  // attribute) doesn't match credentials mode, the preload sits
  // unused, and devtools warns "request credentials mode does not
  // match. Consider taking a look at crossorigin attribute".
  var base    = "<" + _assetUrl("css/main.css") + ">; rel=preload; as=style";
  if (!Array.isArray(extras) || extras.length === 0) return base;
  // Per-route preload merge — every extra entry is `{ href, as }`.
  // Cloudflare auto-promotes the comma-separated Link header to
  // multiple HTTP/103 Early Hints entries.
  var addl = extras.map(function (e) {
    if (!e || typeof e.href !== "string" || typeof e.as !== "string") return "";
    return "<" + e.href + ">; rel=preload; as=" + e.as;
  }).filter(Boolean).join(", ");
  return addl.length ? base + ", " + addl : base;
}

function _html(body, method, env, preloads) {
  const headers = _withSecurityHeaders({
    "content-type":  "text/html; charset=utf-8",
    "cache-control": "no-store",
    "link":          _earlyHintsLink(env || {}, preloads),
  });
  if (method === "HEAD") return new Response(null, { status: 200, headers: headers });
  return new Response(_minify(body), { status: 200, headers: headers });
}

// Static pages — content changes only on code push, so the browser
// + Cloudflare zone cache can hold them for 24h. `must-revalidate`
// ensures the cache re-checks once expiry hits instead of serving
// indefinitely-stale content.
function _staticHtml(body, method, env, request) {
  // Browsers revalidate after an hour; Cloudflare's zone cache holds
  // for 24h. Splitting `max-age` from `s-maxage` lets the edge
  // amortize the render across the whole zone while keeping each
  // visitor's browser honest about checking for changes. The ETag
  // turns the hourly revalidate into a 304 Not Modified when the
  // rendered bytes haven't changed — saves the body bytes on every
  // repeat visit.
  const minified = _minify(body);
  // FNV-1a over the minified bytes — fast, no allocations, good
  // enough as a content-stable ETag (collision irrelevant since the
  // attacker-controlled input space at this surface is empty —
  // operators control policy text, not visitors).
  let hash = 2166136261;
  for (let i = 0; i < minified.length; i += 1) {
    hash ^= minified.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const etag = "\"" + (hash >>> 0).toString(16) + "\"";
  const ifNone = request && request.headers.get("if-none-match");
  if (ifNone && ifNone === etag) {
    return new Response(null, { status: 304, headers: _withSecurityHeaders({ "etag": etag }) });
  }
  const headers = _withSecurityHeaders({
    "content-type":  "text/html; charset=utf-8",
    "cache-control": "public, max-age=3600, s-maxage=86400, must-revalidate", // allow:raw-time-literal — HTTP Cache-Control directive seconds in a header string, not a duration expression
    "link":          _earlyHintsLink(env || {}),
    "etag":          etag,
  });
  if (method === "HEAD") return new Response(null, { status: 200, headers: headers });
  return new Response(minified, { status: 200, headers: headers });
}


// Resolve the single container instance, pinned to a region via the
// Durable Object `locationHint` so the container co-locates with the D1
// primary (US-East / `enam`). The boot's secure-boot runs a per-row audit
// verify over the D1 bridge; if the container is placed far from D1 every
// round-trip crosses the continent and the cold-start blows CF's port
// readiness window. A DO is created in the colo of first access and never
// moves, so the region is baked into the name — changing `SHOP_CONTAINER_REGION`
// mints a fresh DO in the new colo. The container is stateless (D1/R2/KV are
// external), so re-placing it loses no data. `getContainer()` from the SDK
// does not accept a locationHint, hence the explicit idFromName + get.
function _shopContainer(env) {
  var region = (env && env.SHOP_CONTAINER_REGION) || "enam";
  return env.SHOP.get(env.SHOP.idFromName("singleton-" + region), { locationHint: region });
}

async function _forwardToContainer(request, env) {
  // Single logical container instance for now ("singleton"). The
  // Container base class' getContainer() handles routing, auto-start,
  // readiness wait, and scheme rewrite. Cold-start races can surface
  // as 500 "Failed to start container" / 503 "no Container instance"
  // because the SDK's default port-wait is ~8s and a fresh Node +
  // blamejs boot under provisioning load can exceed that. We retry
  // up to 4 times with exponential backoff (2s, 4s, 8s, 16s —
  // total ~30s patience for the cold-start window). If those
  // retries still fail and the request is a navigation, the
  // visitor gets a designed "warming up" page that auto-refreshes
  // instead of the raw SDK error string. POST bodies buffer once
  // and re-serve on each retry; GET / HEAD have no body and clone
  // cheaply.
  const container = _shopContainer(env);
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const buffered = hasBody ? await request.arrayBuffer() : null;
  function _attemptRequest() {
    // `redirect: "manual"` is essential: the storefront's POST
    // handlers (cart/lines, cart/lines/<id>/update, cart/lines/<id>/
    // remove, newsletter, checkout-submit) all reply with 303 + a
    // `Location: /cart` (or similar) AND a `Set-Cookie: shop_sid=...`
    // on the same response. The default `redirect: "follow"` makes
    // the Workers runtime fetch the redirect target internally,
    // dropping the `Set-Cookie` header on the auto-followed GET —
    // so the final response surfaces an empty cart (the session
    // cookie never reached the visitor's browser). Manual handling
    // returns the 303 verbatim; the browser's UA handles the
    // redirect and carries the cookie forward.
    if (!hasBody) {
      return new Request(request, { redirect: "manual" });
    }
    return new Request(request.url, {
      method:   request.method,
      headers:  request.headers,
      body:     buffered.slice(0),
      redirect: "manual",
    });
  }
  function _isColdStartFailure(bodyPreview) {
    return bodyPreview.startsWith("Failed to start container") ||
           bodyPreview.indexOf("There is no Container instance") !== -1 ||
           bodyPreview.indexOf("The container is not running") !== -1;
  }
  // First attempt is immediate; remaining slots double until the
  // cumulative wait covers a realistic Node + blamejs cold-start
  // window. The documented standard-2 cold-start is ~30s; firecracker
  // provisioning + image pull + Node + blamejs init can hit the
  // upper bound under provisioning load. Cumulative budget below:
  //   attempt 1: t=0
  //   attempt 2: t=2s
  //   attempt 3: t=6s
  //   attempt 4: t=14s
  //   attempt 5: t=30s   (covers the documented window)
  //   attempt 6: t=60s   (slack for image-pull contention)
  // Six attempts is the smallest schedule that (a) probes inside the
  // first 2s (most warm hits), (b) lands an attempt at the documented
  // cold-start boundary (30s), and (c) reserves one slot beyond it.
  // Trimming the trailing 30s slot would push the visitor to the
  // warming page even on a textbook cold start.
  const backoffMs = [0, 2000, 4000, 8000, 16000, 30000];
  let res = null;
  let lastWasColdStart = false;
  for (let i = 0; i < backoffMs.length; i += 1) {
    if (backoffMs[i] > 0) await new Promise((r) => setTimeout(r, backoffMs[i]));
    res = await container.fetch(_attemptRequest());
    if (res.status !== 500 && res.status !== 503) return res;
    const peek = res.clone();
    const bodyPreview = (await peek.text()).slice(0, 128);
    lastWasColdStart = _isColdStartFailure(bodyPreview);
    if (!lastWasColdStart) return res;   // legitimate 5xx
  }
  // Retries exhausted on a cold-start failure — give the visitor a
  // designed "warming up" page that auto-refreshes instead of the
  // raw SDK error string.
  if (lastWasColdStart && (method === "GET" || method === "HEAD")) {
    // Real-browser navigations get a faster refresh; XHR/fetch clients
    // get the slower 8s cadence (they shouldn't be hammering retries).
    const fetchMode = request.headers.get("sec-fetch-mode") || "";
    const isNavigate = fetchMode === "navigate";
    const refreshSeconds = isNavigate ? 5 : 8;
    return new Response(_warmingHtml(request.url, refreshSeconds), {
      status:  503,
      headers: _withSecurityHeaders({
        "content-type":  "text/html; charset=utf-8",
        "retry-after":   String(refreshSeconds),
        "cache-control": "no-store",
      }),
    });
  }
  return res;
}

function _warmingHtml(canonicalUrl, refreshSeconds) {
  const refresh = (refreshSeconds === 5 || refreshSeconds === 8) ? refreshSeconds : 8;
  // HTML-escape the canonical URL — the inbound URL is attacker-
  // controlled (any path the visitor types), so injecting it raw
  // into an href would be an XSS vector.
  const safeCanonical = b.template.escapeHtml(canonicalUrl || "https://blamejs.shop/");
  return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>Warming up — blamejs.shop</title>"
    + "<link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/logo.png\">"
    + "<link rel=\"canonical\" href=\"" + safeCanonical + "\">"
    + "<meta name=\"robots\" content=\"noindex, nofollow\">"
    + "<meta http-equiv=\"refresh\" content=\"" + refresh + "\">"
    + "<style>"
    + ":root{--ink:#191919;--mute:#5e5e5e;--accent:#fa4f09;--bg:#fafafa;--paper:#fff;--hair:#e6e6e6;}"
    + "*{box-sizing:border-box}html,body{margin:0;padding:0}"
    + "body{font:16px/1.6 'Inter',system-ui,sans-serif;color:var(--ink);background:var(--bg);"
    + "min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}"
    + ".card{max-width:32rem;background:var(--paper);border:1px solid var(--hair);"
    + "border-radius:14px;padding:2.5rem;text-align:center;box-shadow:0 24px 48px -20px rgba(25,25,25,.18)}"
    + ".brand{display:flex;align-items:center;justify-content:center;gap:.6rem;margin-bottom:1.25rem}"
    + ".brand img{width:36px;height:36px;border-radius:8px}"
    + ".brand span{font:600 1.125rem 'Montserrat',system-ui,sans-serif;letter-spacing:-0.01em}"
    + "h1{font:700 1.5rem 'Montserrat',system-ui,sans-serif;margin:0 0 .75rem;letter-spacing:-0.01em}"
    + ".accent{color:var(--accent)}"
    + "p{margin:0 0 1.25rem;color:var(--mute)}"
    + ".dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);"
    + "margin-right:.5rem;animation:pulse 1.2s ease-in-out infinite}"
    + "@keyframes pulse{0%,100%{opacity:.35;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}"
    + ".meta{font-size:.8125rem;color:var(--mute);margin-top:1.5rem;padding-top:1.25rem;"
    + "border-top:1px solid var(--hair)}"
    + "</style></head><body>"
    + "<main class=\"card\">"
    + "<div class=\"brand\"><img src=\"/assets/brand/logo.png\" alt=\"\"><span>blamejs.shop</span></div>"
    + "<h1>Warming up the <span class=\"accent\">shop</span>&hellip;</h1>"
    + "<p aria-live=\"polite\" role=\"status\">"
    + "<span class=\"dot\" aria-hidden=\"true\"></span>"
    + "Warming up the shop — this page will refresh automatically once the server is ready."
    + "</p>"
    + "<div class=\"meta\">First request after an idle period. Subsequent requests will be fast.</div>"
    + "</main></body></html>";
}
