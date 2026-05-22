import { Container, getContainer } from "@cloudflare/containers";

// Cloudflare Worker — edge router for blamejs.shop.
//
// Responsibilities (in routing order):
//
//   1. /_/health                  — inline 200 (no container hop).
//   2. <ASSET_PREFIX>*            — pass-through to the R2 bucket
//                                   with long-cache headers.
//   3. <STRIPE_WEBHOOK_PATH>      — verify the Stripe-shape HMAC
//                                   signature at the edge before
//                                   forwarding to the container; an
//                                   unsigned or replayed delivery
//                                   never reaches origin.
//   4. <D1_BRIDGE_PATH>           — SQL bridge consumed by the
//                                   container's externalDb D1
//                                   adapter. Authenticates the
//                                   caller with the
//                                   D1_BRIDGE_SECRET header (defense
//                                   in depth: the binding is
//                                   service-only, but a stolen
//                                   compatibility_flag or
//                                   misconfiguration shouldn't leak
//                                   raw SQL execution).
//   5. <R2_BRIDGE_PATH>           — media upload bridge consumed by
//                                   the container's r2Bridge adapter.
//                                   Same shared-secret header as the
//                                   D1 bridge; the body is binary, the
//                                   object key + content-type ride in
//                                   request headers. The Worker writes
//                                   to the R2 binding so the container
//                                   never holds an R2 API token.
//   6. everything else            — forward to the container via the
//                                   SHOP service binding.
//
// No commerce / business logic lives here. The Worker is a thin
// routing + edge-policy layer; the container holds the framework.

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

function _timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(ts + "." + rawBody),
  );
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

  onStart()  { console.log("ShopContainer started"); }
  onStop()   { console.log("ShopContainer stopped"); }
  onError(e) { console.error("ShopContainer error:", e && e.stack || e); }
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

    // 3. Stripe webhook — verify at the edge before forwarding. The
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

    // 4. D1 bridge — the container's externalDb D1 adapter calls this
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

    // 5. R2 upload bridge — the container's r2Bridge adapter calls
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

    // 6. Low-stock alert callback — invoked by the InventoryLock DO
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

    // 6. Everything else — forward to the container.
    return _forwardToContainer(request, env);
  },
};

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
  // First attempt is immediate; remaining slots double until we
  // cover a realistic Node + blamejs cold-start window (~60s).
  // CF firecracker provisioning + image pull + Node + blamejs init
  // can exceed 30s under load. The doubled budget eats one extra
  // worker invocation but keeps the warming-up fallback rare.
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
    return new Response(_warmingHtml(), {
      status:  503,
      headers: {
        "content-type":  "text/html; charset=utf-8",
        "retry-after":   "8",
        "cache-control": "no-store",
      },
    });
  }
  return res;
}

function _warmingHtml() {
  return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>Warming up — blamejs.shop</title>"
    + "<link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/logo.png\">"
    + "<meta http-equiv=\"refresh\" content=\"8\">"
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
    + "<p><span class=\"dot\"></span>This page will refresh automatically once the server is ready.</p>"
    + "<div class=\"meta\">First request after an idle period. Subsequent requests will be fast.</div>"
    + "</main></body></html>";
}
