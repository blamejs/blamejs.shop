import { Container, getContainer } from "@cloudflare/containers";
import b from "./b.js";
import { renderHome }    from "./render/home.js";
import { renderProduct } from "./render/product.js";
import { renderSearch }  from "./render/search.js";
import {
  renderPrivacy,
  renderTerms,
  renderNotFound,
  renderInternalError,
  renderNewsletterThanks,
  renderNewsletterError,
} from "./render/policy.js";
import { renderFeed } from "./render/feed.js";
import { renderSitemap } from "./render/sitemap.js";
import { renderBlogList, renderBlogArticle } from "./render/blog.js";
import { renderCart } from "./render/cart.js";
import { minifyHtml as _minify } from "./render/_lib.js";
import {
  listActiveProducts,
  getProductBySlug,
  searchProducts,
  listVariantsWithPrices,
  listMediaForProduct,
  recentBlogArticles,
  listActiveProductSlugs,
  listPublishedBlogSlugs,
  listBlogArticles,
  getBlogArticleBySlug,
} from "./data/catalog.js";

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
  // shop_sid / shop_auth cookie value (anything until ; or end)
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
// Tolerance window defaults to 5 minutes; outside that window the
// delivery is refused (replay defense). The body is read once and
// reused — Request bodies are single-shot.
async function _verifyStripeSignature(rawBody, header, secret, toleranceSeconds) {
  if (!header || !secret) return { ok: false, reason: "missing-signature-or-secret" };
  const parts = header.split(",").map((p) => p.trim());
  let ts = null;
  const sigs = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === "t") ts = parseInt(v, 10);
    else if (k === "v1") sigs.push(v);
  }
  if (!ts || !isFinite(ts)) return { ok: false, reason: "no-timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (toleranceSeconds || 300)) return { ok: false, reason: "timestamp-outside-tolerance" };
  if (sigs.length === 0) return { ok: false, reason: "no-v1-signature" };

  const expected = await b.crypto.hmacSha256(secret, ts + "." + rawBody);
  for (const got of sigs) {
    if (_timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature-mismatch" };
}

// ---- Durable Object: InventoryLock ----------------------------------------
//
// Serializes "check stock, decrement-if-available" against a single
// SKU across all container replicas. The DO instance is keyed by SKU
// so contention is per-SKU, not global. The actual stock row lives
// in D1; the DO is the serialization point.
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
      const container = getContainer(this.env.SHOP, "singleton");
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
      ADMIN_API_KEY:                     env.ADMIN_API_KEY             || "",
    };
  }

  onStart()  { console.log("ShopContainer started"); }                            // allow:console-direct — Workers have no framework observability sink; console.* auto-routes to wrangler tail / Logpush
  onStop()   { console.log("ShopContainer stopped"); }                            // allow:console-direct — Workers have no framework observability sink; console.* auto-routes to wrangler tail / Logpush
  onError(e) { console.error("ShopContainer error:", _redact(e && e.stack || e)); } // allow:console-direct — Workers have no framework observability sink; console.* auto-routes to wrangler tail / Logpush
}

// ---- Worker entrypoint ----------------------------------------------------

export default {
  async fetch(request, env, ctx) {
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
      return new Response(obj.body, { headers });
    }

    // 2b. /robots.txt edge fallback — crawlers must always get a
    //     clean answer even while the container is cold-starting,
    //     otherwise they index the warming page (noindex, but still
    //     noisy). An R2-uploaded robots.txt under <ASSET_PREFIX>
    //     would have already won above; this only catches the bare
    //     `/robots.txt` request when no asset overrides it. The
    //     response is intentionally minimal — operators who want a
    //     richer policy upload one into R2.
    if (pathname === "/robots.txt" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(
        "User-agent: *\nAllow: /\nSitemap: https://blamejs.shop/sitemap.xml\n",
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
        return _staticHtml(renderPrivacy({
          shopName: env.SHOP_NAME    || "blamejs.shop",
          version:  env.WORKER_VERSION || "0.0.0",
        }), request.method, env);
      }
      if (pathname === "/terms") {
        return _staticHtml(renderTerms({
          shopName: env.SHOP_NAME    || "blamejs.shop",
          version:  env.WORKER_VERSION || "0.0.0",
        }), request.method, env);
      }
      if (pathname === "/SECURITY.md") {
        return Response.redirect("https://github.com/blamejs/blamejs.shop/blob/main/SECURITY.md", 302);
      }
      if (pathname === "/CHANGELOG.md") {
        return Response.redirect("https://github.com/blamejs/blamejs.shop/blob/main/CHANGELOG.md", 302);
      }
      if (pathname === "/sitemap.xml") {
        try {
          const [products, blogPosts] = await Promise.all([
            listActiveProductSlugs(env.DB),
            listPublishedBlogSlugs(env.DB),
          ]);
          const origin = b.safeUrl.parse(env.D1_BRIDGE_URL || "https://blamejs.shop").replace(/\/$/, "");
          const xml = renderSitemap({
            origin:    origin,
            products:  products.rows,
            blogPosts: blogPosts.rows,
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
      if (pathname === "/.well-known/security.txt") {
        // RFC 9116 §2.5 — every line ends with CRLF; the Expires
        // field is a year out so crawlers don't repeatedly refetch.
        // Contact email is the operator-configurable owner; the
        // GitHub-issues fallback gives a public reporting path.
        const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
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
            "cache-control": "public, max-age=3600, s-maxage=86400",
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
          const origin = normalized.replace(/\/$/, "");
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

    // 2d. POST /newsletter — edge-served form submit. The footer's
    //     signup form is on every page; cutting the container hop on
    //     the most-touched POST eliminates ~200ms per submit.
    //     Defense: Sec-Fetch-Site (browsers send `same-origin` for
    //     same-site forms; absent on legacy clients but no widespread
    //     bot traffic carries SameSite cookies anyway). Email gates
    //     through b.guardEmail.validateAddress; email_hash composed
    //     via b.crypto.namespaceHash so the raw address never lands
    //     in plaintext storage.
    if (pathname === "/newsletter" && request.method === "POST" && env.EDGE_RENDER === "on") {
      return await _edgeNewsletter(request, env);
    }

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
        return _json({ ok: false, error: "QUERY_FAILED", message: (e && e.message) || String(e) }, 500);
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
        return _json({ ok: false, error: "PUT_FAILED", message: (e && e.message) || String(e) }, 500);
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

    // 8. Everything else — forward to the container.
    return _forwardToContainer(request, env);
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
    var origin = b.safeUrl.parse(env.D1_BRIDGE_URL || "https://blamejs.shop").replace(/\/$/, "");
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
  // returned `jar` for either session cookie.
  const parsed = b.cookies.parseSafe(cookieHeader);
  return Object.prototype.hasOwnProperty.call(parsed.jar, "shop_sid") ||
         Object.prototype.hasOwnProperty.call(parsed.jar, "shop_auth");
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
  if (_hasSessionCookie(request)) {
    return await _edgeRender(request, env, url);
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
// case the caller falls through to the container forward. The cart
// count display is intentionally fixed at zero for now — surfacing
// the real count requires reading the sealed `shop_sid` cookie, which
// depends on the vault primitive landing in the Worker bundle.
async function _edgeRender(request, env, url) {
  const version  = env.WORKER_VERSION || "0.0.0";
  const shopName = env.SHOP_NAME      || "blamejs.shop";
  const path     = url.pathname;

  if (path === "/") {
    return await _edgeHome(request, env, url, version, shopName);
  }
  if (path === "/search") {
    return await _edgeSearch(request, env, url, version, shopName);
  }
  if (path.startsWith("/products/") && path.length > "/products/".length) {
    const slug = decodeURIComponent(path.slice("/products/".length));
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

async function _edgeNewsletter(request, env) {
  const shopName = env.SHOP_NAME      || "blamejs.shop";
  const version  = env.WORKER_VERSION || "0.0.0";
  try {
    // Sec-Fetch-Site gate. Browsers send this for every fetch since
    // 2020; same-origin / same-site / none are all legitimate (the
    // last covers same-window navigation and bookmarks). Cross-site
    // POSTs are refused — they smell like CSRF / form-driven SSRF.
    // The absence of the header (legacy browser) falls through —
    // we don't want to break submissions from older clients, and the
    // cookie SameSite=Lax defense covers that gap.
    const sfs = request.headers.get("sec-fetch-site") || "";
    if (sfs && sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none") {
      return new Response("Refused: cross-site POST", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    // Form body — application/x-www-form-urlencoded only. JSON
    // submissions aren't part of the storefront form's shape and
    // get refused at the boundary so future operator-facing JSON
    // POSTs can't accidentally reach this handler.
    const ct = (request.headers.get("content-type") || "").split(";")[0].trim();
    if (ct !== "application/x-www-form-urlencoded") {
      return new Response("Refused: unsupported content-type", { status: 415, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const raw   = await request.text();
    const form  = new URLSearchParams(raw);
    const email = (form.get("email") || "").trim();

    // Validate via b.guardEmail (RFC 5322 single-address with header-
    // injection defense). The framework's validator throws a typed
    // GuardEmailError on bad shape; we render the operator-facing
    // error page on every failure mode without leaking the validator's
    // internal code string.
    try {
      b.guardEmail.validateAddress(email);
    } catch (_e) {
      const html = renderNewsletterError({ shopName: shopName, version: version });
      return new Response(html, { status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    // Normalize for storage. Lowercase + trim (already trimmed). The
    // hash is namespaceHash'd so the raw address never lands on disk;
    // the normalized form survives so unsubscribe + dedup can read
    // back what the operator typed.
    const normalized = email.toLowerCase();
    const emailHash  = b.crypto.namespaceHash("newsletter-signup", normalized);
    const now        = Date.now();
    const id         = b.uuid.v7();

    // Idempotent insert. The unique constraint on `email_hash` means
    // a returning visitor's submit lands on the conflict path; the
    // detection of which path ran (new vs existing) is the row-count
    // delta from the run() meta.
    const r = await env.DB
      .prepare(
        "INSERT INTO newsletter_signups (id, email_hash, email_normalized, source, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(email_hash) DO NOTHING"
      )
      .bind(id, emailHash, normalized, "storefront-footer", now)
      .run();
    const inserted = r && r.meta && r.meta.changes > 0;

    const html = renderNewsletterThanks({
      result:   inserted ? "new" : "existing",
      shopName: shopName,
      version:  version,
    });
    return new Response(html, {
      status:  200,
      headers: _withSecurityHeaders({
        "content-type":  "text/html; charset=utf-8",
        "cache-control": "no-store",
      }),
    });
  } catch (e) {
    console.error("edge POST /newsletter failed:", _redact(e && e.stack || e));  // allow:console-direct — Worker substrate; console.* IS the observability sink
    const html = renderInternalError({ shopName: shopName, version: version });
    return new Response(html, { status: 500, headers: _withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }) });
  }
}

async function _edgeCartEmpty(request, env, version, shopName) {
  try {
    const html = renderCart({
      lines:         [],
      totals:        { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
      productLookup: {},
      shopName:      shopName,
      cartCount:     0,
      version:       version,
    });
    // /cart is a session-bound surface even when the guest cart is
    // empty — crawlers indexing it dilute search results with
    // empty-state pages and produce stale "Your cart is empty"
    // snippets in SERPs. The robots-tag header tells well-behaved
    // crawlers to skip indexing; robots.txt also Disallows the
    // route as belt-and-suspenders.
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

async function _edgeBlogList(request, env, _url, version, shopName) {
  try {
    const page = await listBlogArticles(env.DB, { limit: 12 });
    const html = renderBlogList({
      articles: page.rows,
      shopName: shopName,
      version:  version,
    });
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
      return new Response(html, {
        status:  404,
        headers: _withSecurityHeaders({
          "content-type":  "text/html; charset=utf-8",
          "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
        }),
      });
    }
    const html = renderBlogArticle({
      article:  article,
      shopName: shopName,
      version:  version,
    });
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/blog/:slug", e, request, env, version, shopName);
  }
}

async function _edgeHome(request, env, _url, version, shopName) {
  try {
    const page = await listActiveProducts(env.DB, { limit: 24, currency: "USD" });
    const html = renderHome({
      products:  page.rows,
      shopName:  shopName,
      cartCount: 0,
      version:   version,
    });
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/", e, request, env, version, shopName);
  }
}

async function _edgeSearch(request, env, url, version, shopName) {
  try {
    const qRaw = url.searchParams.get("q") || "";
    const q    = qRaw.length > 200 ? qRaw.slice(0, 200) : qRaw;
    let products = [];
    if (q.trim().length > 0) {
      const page = await searchProducts(env.DB, { q: q, limit: 24, currency: "USD" });
      products = page.rows;
    }
    const html = renderSearch({
      q:         q,
      products:  products,
      shopName:  shopName,
      cartCount: 0,
      version:   version,
    });
    return _html(html, request.method, env);
  } catch (e) {
    return _edgeError("/search", e, request, env, version, shopName);
  }
}

async function _edgeProduct(request, env, _url, version, shopName, slug) {
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
      return new Response(html, {
        status:  404,
        headers: _withSecurityHeaders({
          "content-type":  "text/html; charset=utf-8",
          "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
        }),
      });
    }
    const [variantsWithPrices, media] = await Promise.all([
      listVariantsWithPrices(env.DB, product.id, "USD"),
      listMediaForProduct(env.DB, product.id),
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
    const html = renderProduct({
      product:   product,
      variants:  variants,
      prices:    prices,
      media:     media.rows,
      shopName:  shopName,
      cartCount: 0,
      version:   version,
    });
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
    "identity-credentials-get=()",
  "referrer-policy":          "no-referrer",
  "x-content-type-options":   "nosniff",
  "x-dns-prefetch-control":   "off",
  "x-frame-options":          "DENY",
  "strict-transport-security": "max-age=15552000; includeSubDomains; preload",
};

function _withSecurityHeaders(base) {
  var out = Object.assign({}, _SECURITY_HEADERS);
  if (base) {
    var keys = Object.keys(base);
    for (var i = 0; i < keys.length; i += 1) out[keys[i]] = base[keys[i]];
  }
  return out;
}

// Link `rel=preload` for the critical theme stylesheet. Cloudflare
// promotes Link headers on 200 responses to HTTP/103 Early Hints
// frames automatically — repeat visitors see the stylesheet fetch
// start before the HTML body arrives, accelerating First Contentful
// Paint and Largest Contentful Paint. The single preload covers the
// theme bundle every page references; per-route preloads (hero
// images, etc.) compose by appending to the same header.
function _earlyHintsLink(env, extras) {
  var version = env.WORKER_VERSION || "0.0.0";
  var base    = "</assets/themes/default/css/main.css?v=" + version + ">; rel=preload; as=style; crossorigin";
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
function _staticHtml(body, method, env) {
  // Browsers revalidate after an hour; Cloudflare's zone cache holds
  // for 24h. Splitting `max-age` from `s-maxage` lets the edge
  // amortize the render across the whole zone while keeping each
  // visitor's browser honest about checking for changes.
  const headers = _withSecurityHeaders({
    "content-type":  "text/html; charset=utf-8",
    "cache-control": "public, max-age=3600, s-maxage=86400, must-revalidate",
    "link":          _earlyHintsLink(env || {}),
  });
  if (method === "HEAD") return new Response(null, { status: 200, headers: headers });
  return new Response(_minify(body), { status: 200, headers: headers });
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
  const container = getContainer(env.SHOP, "singleton");
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const buffered = hasBody ? await request.arrayBuffer() : null;
  function _attemptRequest() {
    if (!hasBody) return new Request(request, {});
    return new Request(request.url, {
      method:  request.method,
      headers: request.headers,
      body:    buffered.slice(0),
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
