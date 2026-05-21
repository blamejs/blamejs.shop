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
//   5. everything else            — forward to the container via the
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
          "SELECT stock_on_hand, stock_held FROM inventory WHERE sku = ?1",
        ).bind(body.sku).first();
        if (!row) return _json({ ok: false, error: "UNKNOWN_SKU" }, 404);
        const available = row.stock_on_hand - row.stock_held;
        if (available < body.qty) return _json({ ok: false, error: "INSUFFICIENT_STOCK", available }, 409);
        await this.env.DB.prepare(
          "UPDATE inventory SET stock_held = stock_held + ?1, updated_at = ?2 WHERE sku = ?3",
        ).bind(body.qty, Date.now(), body.sku).run();
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
  sleepAfter  = "30s";

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
      STRIPE_API_KEY:                    env.STRIPE_API_KEY            || "",
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

    // 5. Everything else — forward to the container.
    return _forwardToContainer(request, env);
  },
};

function _forwardToContainer(request, env) {
  // Single logical container instance for now ("singleton"). The
  // Container base class' getContainer() handles routing, auto-start,
  // readiness wait, and scheme rewrite. When shopper-scoped affinity
  // becomes useful (e.g. per-cart DO sessions), swap the name for a
  // cart-bound identifier.
  return getContainer(env.SHOP, "singleton").fetch(request);
}
