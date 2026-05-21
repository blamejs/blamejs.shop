"use strict";
/**
 * @module shop.admin
 * @title  Admin API — bearer-token-gated CRUD over the shop primitives
 *
 * @intro
 *   v1 ships a single-bearer-token admin surface — operators set
 *   `ADMIN_API_KEY` as a Worker secret and use it as the bearer for
 *   every `/admin/*` route. This is the v1-defensible minimum: it
 *   doesn't require a registration ceremony, doesn't need browser
 *   JavaScript, and the operator already has a CLI-friendly trust
 *   root (the secret is in the same vault as every other deploy
 *   credential).
 *
 *   The full passkey-enrolled multi-admin surface (composed on
 *   `b.auth.passkey` + `b.auth.stepUp` + `b.permissions` + b.apiKey's
 *   sealed-storage / scope / rate-limit model) lands in v1.x once the
 *   admin UI also lands. The two are paired because passkey enrolment
 *   requires WebAuthn ceremonies that only make sense from a browser.
 *
 *   Bearer comparison uses `b.crypto.timingSafeEqual` so a side-channel
 *   timing attack can't recover the token byte-by-byte. The token is
 *   never logged — when a request fails auth the response is `401`
 *   with no detail.
 *
 *   Every mutating route writes an audit row via the shop's audit
 *   sink (currently `b.audit.emit` with `action: \"shop.admin.<verb>\"`,
 *   namespace `shop.admin`). Once `b.audit.registerNamespace` is wired
 *   into the boot flow, the namespace is registered there; until then
 *   we register it lazily inside the admin module.
 */

var pricing = require("./pricing");

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var AUDIT_NAMESPACE = "shop_admin";

// Conservative content-type → file-extension map for the upload route.
// Unknown types fall back to no extension; the R2 object metadata still
// carries the full content-type so the asset serves correctly either
// way. Operator can override by passing a key with extension via the
// raw `catalog.media.attach` route.
var _CT_TO_EXT = {
  "image/png":     "png",
  "image/jpeg":    "jpg",
  "image/jpg":     "jpg",
  "image/webp":    "webp",
  "image/gif":     "gif",
  "image/avif":    "avif",
  "image/svg+xml": "svg",
  "video/mp4":     "mp4",
  "video/webm":    "webm",
  "application/pdf": "pdf",
};
function _extFromContentType(ct) {
  if (typeof ct !== "string") return "";
  return _CT_TO_EXT[ct.toLowerCase()] || "";
}

// ---- shared helpers -----------------------------------------------------

function _parseEpochMs(str, label) {
  if (str == null) return null;
  var n = parseInt(str, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== String(str)) {
    throw new TypeError("admin: " + label + " must be an epoch-millisecond integer");
  }
  return n;
}

function _parseLimit(str, label, max, fallback) {
  if (str == null) return fallback;
  var n = parseInt(str, 10);
  if (!Number.isFinite(n) || n < 1 || n > max || String(n) !== String(str)) {
    throw new TypeError("admin: " + label + " must be an integer in [1, " + max + "]");
  }
  return n;
}

// ---- HTML escape + dashboard layout ------------------------------------

var HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
function _htmlEscape(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESCAPE_MAP[c]; });
}

// ---- bearer auth --------------------------------------------------------

function _readBearer(req) {
  if (!req || !req.headers) return null;
  var h = req.headers.authorization || req.headers.Authorization;
  if (!h || typeof h !== "string") return null;
  if (h.slice(0, 7).toLowerCase() !== "bearer ") return null;
  return h.slice(7).trim();
}

function _authOk(token, expected) {
  if (typeof token !== "string" || typeof expected !== "string") return false;
  if (token.length !== expected.length) return false;
  return _b().crypto.timingSafeEqual(token, expected);
}

function _problem(res, status, code, detail) {
  return _b().problemDetails.send(res, {
    type:   "/problems/" + code,
    title:  code.replace(/-/g, " "),
    status: status,
    detail: detail || code,
  });
}

function _wrap(handler, opts) {
  // Every admin handler routes through this wrapper: bearer-token
  // gate, error-to-problem-details translation, audit write on the
  // mutating ops. `opts.audit` is the audit action name; omit for
  // read-only routes.
  return async function (req, res) {
    var token = _readBearer(req);
    if (!_authOk(token, opts.expectedToken)) return _problem(res, 401, "unauthorized");
    try {
      var result = await handler(req, res);
      if (opts.audit && result && result !== false) {
        try {
          _b().audit.emit({
            action:   AUDIT_NAMESPACE + "." + opts.audit,
            outcome:  "success",
            metadata: { id: result.id || null },
          });
        } catch (_e) { /* drop-silent — audit sink failure must not fail the write */ }
      }
      return result;
    } catch (e) {
      if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
      return _problem(res, 500, "internal-error", (e && e.message) || String(e));
    }
  };
}

// ---- factory ------------------------------------------------------------

function mount(router, deps) {
  if (!router || typeof router.post !== "function") throw new TypeError("admin.mount: router with .post() required");
  if (!deps || !deps.catalog || !deps.order)        throw new TypeError("admin.mount: deps.catalog + deps.order required");
  var expectedToken = deps.token;
  if (typeof expectedToken !== "string" || expectedToken.length < 16) {
    throw new TypeError("admin.mount: deps.token must be a string ≥ 16 chars (use a 32-byte random secret)");
  }
  var catalog  = deps.catalog;
  var order    = deps.order;
  var payment  = deps.payment || null;     // refund endpoints disabled when absent
  var checkout = deps.checkout || null;
  var r2       = deps.r2_bridge || null;   // media-upload endpoint disabled when absent
  var assetPrefix = typeof deps.asset_prefix === "string" ? deps.asset_prefix : "/assets/";

  try { _b().audit.registerNamespace(AUDIT_NAMESPACE); } catch (_e) { /* idempotent */ }

  var W = function (auditAction, h) {
    return _wrap(h, { expectedToken: expectedToken, audit: auditAction });
  };
  var R = function (h) {
    return _wrap(h, { expectedToken: expectedToken });
  };

  function _json(res, status, obj) {
    res.status(status);
    if (res.setHeader) res.setHeader("content-type", "application/json; charset=utf-8");
    var body = JSON.stringify(obj);
    if (res.end) res.end(body); else res.send(body);
  }

  // ---- products -------------------------------------------------------

  router.post("/admin/products", W("product.create", async function (req, res) {
    var p = await catalog.products.create(req.body || {});
    _json(res, 201, p);
    return p;
  }));

  router.get("/admin/products", R(async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var status = url && url.searchParams.get("status");
    var cursor = url && url.searchParams.get("cursor");
    var limitS = url && url.searchParams.get("limit");
    var limit  = limitS == null ? 50 : parseInt(limitS, 10);
    var page = await catalog.products.list({ status: status || undefined, cursor: cursor || undefined, limit: limit });
    _json(res, 200, page);
  }));

  router.get("/admin/products/:id", R(async function (req, res) {
    var p = await catalog.products.get(req.params.id);
    if (!p) return _problem(res, 404, "product-not-found");
    _json(res, 200, p);
  }));

  router.patch("/admin/products/:id", W("product.update", async function (req, res) {
    var p = await catalog.products.update(req.params.id, req.body || {});
    if (!p) return _problem(res, 404, "product-not-found");
    _json(res, 200, p);
    return p;
  }));

  router.post("/admin/products/:id/archive", W("product.archive", async function (req, res) {
    var p = await catalog.products.archive(req.params.id);
    if (!p) return _problem(res, 404, "product-not-found");
    _json(res, 200, p);
    return p;
  }));

  router.post("/admin/products/:id/restore", W("product.restore", async function (req, res) {
    var p = await catalog.products.restore(req.params.id);
    if (!p) return _problem(res, 404, "product-not-found");
    _json(res, 200, p);
    return p;
  }));

  // ---- variants -------------------------------------------------------

  router.post("/admin/products/:id/variants", W("variant.create", async function (req, res) {
    var v = await catalog.variants.create(req.params.id, req.body || {});
    _json(res, 201, v);
    return v;
  }));

  router.patch("/admin/variants/:id", W("variant.update", async function (req, res) {
    var v = await catalog.variants.update(req.params.id, req.body || {});
    if (!v) return _problem(res, 404, "variant-not-found");
    _json(res, 200, v);
    return v;
  }));

  router.delete("/admin/variants/:id", W("variant.delete", async function (req, res) {
    var ok = await catalog.variants.delete(req.params.id);
    if (!ok) return _problem(res, 404, "variant-not-found");
    _json(res, 200, { ok: true });
    return { id: req.params.id };
  }));

  // ---- prices ---------------------------------------------------------

  router.post("/admin/variants/:id/prices", W("price.set", async function (req, res) {
    var p = await catalog.prices.set(req.params.id, req.body || {});
    _json(res, 201, p);
    return p;
  }));

  router.get("/admin/variants/:id/prices", R(async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var currency = url && url.searchParams.get("currency");
    if (!currency) return _problem(res, 400, "missing-currency", "?currency=USD required");
    var hist = await catalog.prices.history(req.params.id, currency);
    _json(res, 200, { history: hist });
  }));

  // ---- inventory ------------------------------------------------------

  router.post("/admin/inventory", W("inventory.create", async function (req, res) {
    var body = req.body || {};
    if (!body.sku) throw new TypeError("admin.inventory.create: body.sku required");
    var inv = await catalog.inventory.create(body.sku, body);
    _json(res, 201, inv);
    return Object.assign({ id: body.sku }, inv);
  }));

  router.post("/admin/inventory/:sku/restock", W("inventory.restock", async function (req, res) {
    var qty = parseInt((req.body || {}).qty, 10);
    if (!Number.isFinite(qty)) throw new TypeError("admin.inventory.restock: body.qty required (integer)");
    var inv = await catalog.inventory.restock(req.params.sku, qty);
    if (!inv) return _problem(res, 404, "inventory-not-found");
    _json(res, 200, inv);
    return Object.assign({ id: req.params.sku }, inv);
  }));

  // Per-SKU low-stock threshold. Body `{ threshold }` — null clears.
  router.patch("/admin/inventory/:sku/threshold", W("inventory.set_threshold", async function (req, res) {
    var body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, "threshold")) {
      throw new TypeError("admin.inventory.set_threshold: body.threshold required (integer ≥ 0 or null)");
    }
    var threshold = body.threshold;
    if (threshold !== null && !Number.isInteger(threshold)) {
      throw new TypeError("admin.inventory.set_threshold: threshold must be a non-negative integer or null");
    }
    var inv = await catalog.inventory.setThreshold(req.params.sku, threshold);
    if (!inv) return _problem(res, 404, "inventory-not-found");
    _json(res, 200, inv);
    return Object.assign({ id: req.params.sku }, inv);
  }));

  // Recent low-stock alerts. Defaults to 100 newest by fired_at DESC.
  // Optional `?sku=` narrows to a single SKU's history; `?limit=` +
  // `?offset=` page through older alerts.
  var inventoryAlerts = deps.inventoryAlerts || null;
  if (inventoryAlerts) {
    router.get("/admin/inventory/alerts", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var sku    = url && url.searchParams.get("sku");
      var limitS = url && url.searchParams.get("limit");
      var offsetS = url && url.searchParams.get("offset");
      var limit  = limitS == null ? 100 : parseInt(limitS, 10);
      var offset = offsetS == null ? 0   : parseInt(offsetS, 10);
      if (!Number.isFinite(limit))  throw new TypeError("admin.inventory.alerts: limit must be an integer");
      if (!Number.isFinite(offset)) throw new TypeError("admin.inventory.alerts: offset must be a non-negative integer");
      var rows = await inventoryAlerts.list({
        sku:    sku || undefined,
        limit:  limit,
        offset: offset,
      });
      _json(res, 200, { rows: rows });
    }));
  }

  // ---- media ----------------------------------------------------------

  router.post("/admin/media", W("media.attach", async function (req, res) {
    var m = await catalog.media.attach(req.body || {});
    _json(res, 201, m);
    return m;
  }));

  // --- media upload (r2 bridge) ---------------------------------------
  // POST /admin/media/upload — fetches `source_url` via b.httpClient
  // (SSRF gate + size cap), uploads to R2 through the bridge, then
  // records the media row. Endpoint is omitted entirely when no
  // r2_bridge is wired (operator hasn't set D1_BRIDGE_URL +
  // D1_BRIDGE_SECRET).
  if (r2) {
    router.post("/admin/media/upload", W("media.upload", async function (req, res) {
      var body = req.body || {};
      if (typeof body.source_url !== "string" || !body.source_url.length) {
        throw new TypeError("admin.media.upload: body.source_url required");
      }
      if (!body.product_id && !body.variant_id) {
        throw new TypeError("admin.media.upload: one of product_id / variant_id required");
      }
      if (typeof body.content_type !== "string" || !body.content_type.length) {
        throw new TypeError("admin.media.upload: body.content_type required");
      }
      if (!/^[\w.+\-]+\/[\w.+\-]+/.test(body.content_type)) {
        throw new TypeError("admin.media.upload: body.content_type must match `type/subtype`");
      }
      // Fetch the source bytes. The framework's httpClient runs every
      // outbound through the SSRF gate, so a `source_url` pointing at
      // a cloud-metadata IP (169.254.169.254) / RFC 1918 host can't
      // smuggle internal data into the bucket.
      var fetched;
      try {
        fetched = await _b().httpClient.request({
          method:    "GET",
          url:       body.source_url,
          timeoutMs: 20000,
          headers:   { "accept": body.content_type + ",*/*;q=0.5" },
        });
      } catch (e) {
        return _problem(res, 502, "source-fetch-failed", (e && e.message) || String(e));
      }
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        return _problem(res, 502, "source-fetch-status",
          "source_url returned HTTP " + fetched.statusCode);
      }
      var fetchedCT = String(fetched.headers && (fetched.headers["content-type"] || fetched.headers["Content-Type"]) || "");
      // Loose match — the declared content_type must be a prefix of
      // (or equal to) the server's content-type up to parameters. So
      // `image/png` accepts `image/png; charset=binary` but refuses
      // `application/zip` smuggled past the operator's intent.
      var declared = body.content_type.split(";")[0].trim().toLowerCase();
      var served   = fetchedCT.split(";")[0].trim().toLowerCase();
      if (served && declared !== served) {
        return _problem(res, 422, "content-type-mismatch",
          "source_url served `" + served + "` but operator declared `" + declared + "`");
      }
      var buf = fetched.body && Buffer.isBuffer(fetched.body) ? fetched.body
              : Buffer.from(fetched.body || "");
      if (buf.length === 0) {
        return _problem(res, 422, "source-empty", "source_url returned an empty body");
      }
      // Generate the R2 key. The extension is inferred from the
      // declared content-type so the operator can preview the asset
      // without a content-disposition round-trip.
      var ext = _extFromContentType(declared);
      var id  = _b().uuid.v7();
      var key = "media/" + id + (ext ? "." + ext : "");
      try {
        await r2.put(key, buf, body.content_type);
      } catch (e) {
        return _problem(res, 502, "r2-upload-failed", (e && e.message) || String(e));
      }
      var m;
      try {
        m = await catalog.media.attach({
          product_id:   body.product_id || undefined,
          variant_id:   body.variant_id || undefined,
          r2_key:       key,
          content_type: body.content_type,
          width:        body.width    || 0,
          height:       body.height   || 0,
          position:     body.position || 0,
          alt_text:     body.alt_text || "",
        });
      } catch (e) {
        // The R2 write succeeded but the DB row didn't land — surface
        // the orphan key so the operator can reconcile or re-attach.
        var problem = e instanceof TypeError ? 400 : 500;
        return _problem(res, problem, "media-attach-failed",
          (e && e.message || String(e)) + " (orphan r2_key=" + key + ")");
      }
      // Expose the public asset URL alongside the media row so the
      // admin UI can preview without an extra round-trip.
      var rec = Object.assign({}, m, { asset_url: assetPrefix + key });
      _json(res, 201, rec);
      return rec;
    }));
  }

  router.delete("/admin/media/:id", W("media.delete", async function (req, res) {
    var ok = await catalog.media.delete(req.params.id);
    if (!ok) return _problem(res, 404, "media-not-found");
    _json(res, 200, { ok: true });
    return { id: req.params.id };
  }));

  // ---- orders ---------------------------------------------------------

  router.get("/admin/orders/:id", R(async function (req, res) {
    var o = await order.get(req.params.id);
    if (!o) return _problem(res, 404, "order-not-found");
    _json(res, 200, o);
  }));

  router.post("/admin/orders/:id/transition", W("order.transition", async function (req, res) {
    var body = req.body || {};
    if (!body.event) throw new TypeError("admin.order.transition: body.event required");
    var o = await order.transition(req.params.id, body.event, { reason: body.reason, metadata: body.metadata });
    _json(res, 200, o);
    return o;
  }));

  // ---- refunds --------------------------------------------------------

  if (payment) {
    router.post("/admin/orders/:id/refund", W("order.refund", async function (req, res) {
      var o = await order.get(req.params.id);
      if (!o) return _problem(res, 404, "order-not-found");
      if (!o.payment_intent_id) return _problem(res, 422, "no-payment-intent", "Order has no linked payment intent");
      var body = req.body || {};
      var refundIdempotencyKey = "refund:" + o.id + ":" + (body.idempotency_suffix || _b().uuid.v7());
      var refund;
      try {
        refund = await payment.refund({
          payment_intent: o.payment_intent_id,
          amount_minor:   body.amount_minor || undefined,
          reason:         body.reason || undefined,
          metadata:       { order_id: o.id },
        }, refundIdempotencyKey);
      } catch (e) {
        return _problem(res, 502, "stripe-refund-failed", (e && e.message) || String(e));
      }
      try {
        await order.transition(o.id, "refund", {
          reason:   "admin:refund:" + (body.reason || "requested_by_customer"),
          metadata: { stripe_refund_id: refund.id, amount_minor: refund.amount },
        });
      } catch (_e) { /* refund succeeded at Stripe; transition refusal logged, surface to operator via re-fetch */ }
      var updated = await order.get(o.id);
      _json(res, 200, { refund: refund, order: updated });
      return { id: o.id };
    }));
  }

  // ---- config ---------------------------------------------------------

  var config = deps.config || null;
  if (config) {
    router.get("/admin/config", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var prefix = url && url.searchParams.get("prefix");
      var rows = await config.list(prefix || null);
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/config/:key", R(async function (req, res) {
      var v = await config.getFresh(req.params.key);
      if (v === null) return _problem(res, 404, "config-not-found");
      _json(res, 200, { key: req.params.key, value: v });
    }));

    router.put("/admin/config/:key", W("config.put", async function (req, res) {
      var body = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(body, "value")) {
        throw new TypeError("admin.config.put: body.value required");
      }
      var r = await config.put(req.params.key, body.value);
      _json(res, 200, r);
      return { id: req.params.key };
    }));

    router.delete("/admin/config/:key", W("config.delete", async function (req, res) {
      var ok = await config.delete(req.params.key);
      if (!ok) return _problem(res, 404, "config-not-found");
      _json(res, 200, { ok: true });
      return { id: req.params.key };
    }));
  }

  // ---- webhooks -------------------------------------------------------

  var webhooks = deps.webhooks || null;
  if (webhooks) {
    router.post("/admin/webhooks", W("webhook.create", async function (req, res) {
      var body = req.body || {};
      var ep = await webhooks.endpoints.create({ url: body.url, events: body.events });
      _json(res, 201, ep);
      return ep;
    }));

    router.get("/admin/webhooks", R(async function (_req, res) {
      var rows = await webhooks.endpoints.list();
      _json(res, 200, { rows: rows });
    }));

    router.patch("/admin/webhooks/:id", W("webhook.update", async function (req, res) {
      var ep = await webhooks.endpoints.update(req.params.id, req.body || {});
      if (!ep) return _problem(res, 404, "webhook-not-found");
      _json(res, 200, ep);
      return ep;
    }));

    router.delete("/admin/webhooks/:id", W("webhook.delete", async function (req, res) {
      var ok = await webhooks.endpoints.delete(req.params.id);
      if (!ok) return _problem(res, 404, "webhook-not-found");
      _json(res, 200, { ok: true });
      return { id: req.params.id };
    }));

    router.get("/admin/webhooks/:id/deliveries", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var limitS = url && url.searchParams.get("limit");
      var limit  = limitS == null ? 50 : parseInt(limitS, 10);
      var rows = await webhooks.deliveries.list(req.params.id, { limit: limit });
      _json(res, 200, { rows: rows });
    }));

    router.post("/admin/webhooks/deliveries/:id/retry", W("webhook.retry", async function (req, res) {
      var d = await webhooks.deliveries.retry(req.params.id);
      if (!d) return _problem(res, 404, "delivery-not-found");
      _json(res, 200, d);
      return { id: req.params.id };
    }));
  }

  // ---- analytics ------------------------------------------------------

  var analytics = deps.analytics || null;
  if (analytics) {
    function _parseWindow(url) {
      var since = _parseEpochMs(url && url.searchParams.get("since"), "since");
      var until = _parseEpochMs(url && url.searchParams.get("until"), "until");
      var w = {};
      if (since != null) w.since = since;
      if (until != null) w.until = until;
      return w;
    }

    router.get("/admin/analytics/summary", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var summary = await analytics.summary(_parseWindow(url));
      _json(res, 200, summary);
    }));

    router.get("/admin/analytics/revenue-by-day", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var rows = await analytics.revenueByDay(_parseWindow(url));
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/analytics/top-skus", R(async function (req, res) {
      var url   = req.url ? new URL(req.url, "http://localhost") : null;
      var w     = _parseWindow(url);
      w.limit   = _parseLimit(url && url.searchParams.get("limit"), "limit", 100, 10);
      var rows  = await analytics.topSKUs(w);
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/analytics/recent-orders", R(async function (req, res) {
      var url  = req.url ? new URL(req.url, "http://localhost") : null;
      var lim  = _parseLimit(url && url.searchParams.get("limit"), "limit", 100, 20);
      var rows = await analytics.recentOrders({ limit: lim });
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/dashboard", R(async function (req, res) {
      var url     = req.url ? new URL(req.url, "http://localhost") : null;
      var w       = _parseWindow(url);
      var summary = await analytics.summary(w);
      var byDay   = await analytics.revenueByDay(w);
      var top     = await analytics.topSKUs(Object.assign({}, w, { limit: 10 }));
      var recent  = await analytics.recentOrders({ limit: 20 });
      var html    = renderDashboard({
        summary:    summary,
        by_day:     byDay,
        top_skus:   top,
        recent:     recent,
        shop_name:  (deps.shop_name || "blamejs.shop"),
      });
      res.status(200);
      if (res.setHeader) res.setHeader("content-type", "text/html; charset=utf-8");
      if (res.end) res.end(html); else res.send(html);
    }));
  }

  // ---- ping (auth check) ----------------------------------------------

  router.get("/admin/ping", R(async function (_req, res) {
    _json(res, 200, { ok: true, ts: Date.now() });
  }));
}

// ---- dashboard renderer -------------------------------------------------
//
// Server-rendered HTML dashboard for `GET /admin/dashboard`. Reads
// the four analytics aggregates and lays them out in a single page
// matching the storefront's brand palette (#191919 ink, #fa4f09
// accent, Montserrat headlines). No client-side JS — the SVG sparkline
// is rendered server-side from the revenue-by-day rows.

var DASHBOARD_LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <meta name=\"robots\" content=\"noindex,nofollow\">\n" +
  "  <title>Admin dashboard — {{shop_name}}</title>\n" +
  "  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n" +
  "  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n" +
  "  <link href=\"https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&family=Inter:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n" +
  "  <style>\n" +
  "    :root { --ink:#191919; --ink-2:#414141; --mute:#727272; --hair:#d9d9d9; --paper:#ffffff; --bg:#fafafa; --accent:#fa4f09; --accent-d:#d8410a; }\n" +
  "    * { box-sizing: border-box; }\n" +
  "    html, body { margin:0; padding:0; background:var(--bg); }\n" +
  "    body { font-family:'Inter',ui-sans-serif,system-ui,sans-serif; color:var(--ink); font-size:15px; line-height:1.55; }\n" +
  "    h1, h2, h3 { font-family:'Montserrat',sans-serif; font-weight:700; letter-spacing:-0.01em; margin:0 0 .65rem; }\n" +
  "    .admin-header { background:var(--ink); color:var(--paper); border-bottom:3px solid var(--accent); }\n" +
  "    .admin-header__inner { max-width:80rem; margin:0 auto; padding:1.2rem 1.5rem; display:flex; align-items:center; justify-content:space-between; }\n" +
  "    .admin-header h1 { color:var(--paper); font-size:1.1rem; margin:0; font-weight:600; letter-spacing:.02em; text-transform:uppercase; }\n" +
  "    .admin-header .brand-accent { color:var(--accent); }\n" +
  "    main { max-width:80rem; margin:0 auto; padding:2.5rem 1.5rem 5rem; }\n" +
  "    section { margin-bottom:2.5rem; }\n" +
  "    section h2 { font-size:1.1rem; text-transform:uppercase; letter-spacing:.05em; color:var(--mute); font-weight:600; margin-bottom:1rem; }\n" +
  "    .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(12rem, 1fr)); gap:1rem; }\n" +
  "    .stat-card { background:var(--paper); border:1px solid var(--hair); border-radius:8px; padding:1.25rem 1.4rem; }\n" +
  "    .stat-card .label { font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; color:var(--mute); font-weight:600; }\n" +
  "    .stat-card .value { font-family:'Montserrat',sans-serif; font-weight:700; font-size:1.8rem; color:var(--ink); margin-top:.35rem; line-height:1.1; }\n" +
  "    .stat-card .value.accent { color:var(--accent); }\n" +
  "    .panel { background:var(--paper); border:1px solid var(--hair); border-radius:8px; padding:1.5rem; }\n" +
  "    .two-col { display:grid; grid-template-columns: 2fr 1fr; gap:1.5rem; align-items:start; }\n" +
  "    @media (max-width: 56rem) { .two-col { grid-template-columns: 1fr; } }\n" +
  "    table { width:100%; border-collapse:collapse; font-size:.9rem; }\n" +
  "    thead th { text-align:left; padding:.65rem .75rem; border-bottom:2px solid var(--ink); font-family:'Montserrat',sans-serif; font-weight:600; font-size:.72rem; letter-spacing:.05em; text-transform:uppercase; color:var(--mute); }\n" +
  "    tbody td { padding:.65rem .75rem; border-bottom:1px solid var(--hair); }\n" +
  "    tbody tr:last-child td { border-bottom:none; }\n" +
  "    td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }\n" +
  "    .status-pill { display:inline-block; padding:.15rem .55rem; border-radius:999px; font-size:.72rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; background:var(--bg); color:var(--ink-2); border:1px solid var(--hair); }\n" +
  "    .status-pill.paid, .status-pill.fulfilling, .status-pill.shipped, .status-pill.delivered { background:#e9f5ec; color:#1f6b3a; border-color:#bfe1c9; }\n" +
  "    .status-pill.refunded { background:#fff1eb; color:var(--accent-d); border-color:#f6c5af; }\n" +
  "    .status-pill.cancelled { background:#f4f4f4; color:var(--mute); }\n" +
  "    .status-pill.pending { background:#fff8e1; color:#7a5d0f; border-color:#f1e1a8; }\n" +
  "    .spark { width:100%; height:8rem; background:var(--bg); border:1px solid var(--hair); border-radius:6px; padding:.5rem; }\n" +
  "    .spark svg { display:block; width:100%; height:100%; }\n" +
  "    .empty { color:var(--mute); font-style:italic; padding:1rem 0; text-align:center; }\n" +
  "    .meta { color:var(--mute); font-size:.85rem; margin-bottom:1rem; }\n" +
  "    .order-id { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.78rem; color:var(--ink-2); }\n" +
  "  </style>\n" +
  "</head>\n" +
  "<body>\n" +
  "  <header class=\"admin-header\">\n" +
  "    <div class=\"admin-header__inner\">\n" +
  "      <h1>{{shop_name}} <span class=\"brand-accent\">/ admin</span></h1>\n" +
  "      <span style=\"font-size:.8rem; color:var(--mute);\">{{window_label}}</span>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <main>{{body}}</main>\n" +
  "</body>\n" +
  "</html>\n";

function _renderTemplate(template, vars) {
  // Strict substitution — every {{key}} must be present in vars.
  // Mirrors the email/storefront renderers but local so admin doesn't
  // reach across module boundaries for an HTML escape function.
  var seen = {};
  var out = template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, function (_m, k) {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) {
      throw new Error("admin: dashboard template references unknown variable {{" + k + "}}");
    }
    seen[k] = true;
    return _htmlEscape(vars[k]);
  });
  Object.keys(vars).forEach(function (k) {
    if (!seen[k]) throw new Error("admin: dashboard template did not reference variable " + JSON.stringify(k));
  });
  return out;
}

function _sparkSvg(byDay, currency) {
  // SVG sparkline rendered server-side from revenue-by-day rows of
  // the dashboard's primary currency. Returns an empty placeholder
  // when no data is in-window.
  var pts = byDay.filter(function (r) { return r.currency === currency; });
  if (pts.length === 0) {
    return "<div class=\"empty\">No revenue in this window.</div>";
  }
  var max = 1;
  for (var i = 0; i < pts.length; i += 1) if (pts[i].revenue_minor > max) max = pts[i].revenue_minor;
  var W = 800, H = 120, P = 6;
  var path = pts.map(function (p, i) {
    var x = pts.length === 1 ? (W / 2) : P + (i * ((W - 2 * P) / (pts.length - 1)));
    var y = H - P - ((p.revenue_minor / max) * (H - 2 * P));
    return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  return "<div class=\"spark\"><svg viewBox=\"0 0 " + W + " " + H + "\" preserveAspectRatio=\"none\" aria-label=\"Revenue by day sparkline\">" +
         "<path d=\"" + path + "\" fill=\"none\" stroke=\"#fa4f09\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>" +
         "</svg></div>";
}

function renderDashboard(opts) {
  if (!opts) throw new TypeError("admin.renderDashboard: opts required");
  var summary  = opts.summary  || { currency: "USD", total_orders: 0, total_revenue_minor: 0, by_status: {} };
  // Operators with multi-currency catalogs receive an array of
  // per-currency rows from analytics.summary. Pick the first (most-
  // touched alphabetically) as the headline, surface the rest below.
  var primary, others;
  if (Array.isArray(summary)) {
    primary = summary[0];
    others  = summary.slice(1);
  } else {
    primary = summary;
    others  = [];
  }
  var byStatus = primary.by_status || {};

  // ---- stat cards
  var stats = "" +
    _statCard("Orders",         String(primary.total_orders),                                       false) +
    _statCard("Revenue (net)",  pricing.format(primary.total_revenue_minor, primary.currency),     true) +
    _statCard("Paid",           String(byStatus.paid || 0),                                        false) +
    _statCard("Fulfilling",     String(byStatus.fulfilling || 0),                                  false) +
    _statCard("Shipped",        String(byStatus.shipped || 0),                                     false) +
    _statCard("Delivered",      String(byStatus.delivered || 0),                                   false) +
    _statCard("Refunded",       String(byStatus.refunded || 0),                                    false) +
    _statCard("Cancelled",      String(byStatus.cancelled || 0),                                   false);

  var statsBlock =
    "<section><h2>Window summary ({{currency_label}})</h2><div class=\"stat-grid\">RAW_STATS</div></section>"
    .replace("{{currency_label}}", _htmlEscape(primary.currency))
    .replace("RAW_STATS", stats);

  // Multi-currency callout for operators with multiple currencies in
  // the same window.
  var otherCurrencies = "";
  if (others.length) {
    var rows = others.map(function (r) {
      return "<tr><td>" + _htmlEscape(r.currency) + "</td><td class=\"num\">" + _htmlEscape(String(r.total_orders)) + "</td><td class=\"num\">" + _htmlEscape(pricing.format(r.total_revenue_minor, r.currency)) + "</td></tr>";
    }).join("");
    otherCurrencies =
      "<section><h2>Other currencies in window</h2><div class=\"panel\">" +
      "<table><thead><tr><th>Currency</th><th class=\"num\">Orders</th><th class=\"num\">Revenue</th></tr></thead><tbody>" + rows + "</tbody></table>" +
      "</div></section>";
  }

  // ---- revenue sparkline
  var spark =
    "<section><h2>Revenue by day</h2><div class=\"panel\">" +
    _sparkSvg(opts.by_day || [], primary.currency) +
    "</div></section>";

  // ---- top SKUs + recent orders in a two-column layout
  var topSkus = opts.top_skus || [];
  var topRows = topSkus.length
    ? topSkus.map(function (r) {
        return "<tr><td>" + _htmlEscape(r.sku) + "</td><td class=\"num\">" + _htmlEscape(String(r.units_sold)) + "</td><td class=\"num\">" + _htmlEscape(pricing.format(r.revenue_minor, r.currency)) + "</td></tr>";
      }).join("")
    : "<tr><td colspan=\"3\" class=\"empty\">No sales in this window.</td></tr>";

  var recent = opts.recent || [];
  var recentRows = recent.length
    ? recent.map(function (o) {
        var statusClass = _htmlEscape(o.status);
        return "<tr>" +
          "<td><span class=\"order-id\">" + _htmlEscape(o.id.slice(0, 8)) + "</span></td>" +
          "<td><span class=\"status-pill " + statusClass + "\">" + _htmlEscape(o.status) + "</span></td>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(o.grand_total_minor, o.currency)) + "</td>" +
          "</tr>";
      }).join("")
    : "<tr><td colspan=\"3\" class=\"empty\">No orders yet.</td></tr>";

  var twoCol =
    "<section><h2>Catalog + activity</h2><div class=\"two-col\">" +
    "  <div class=\"panel\">" +
    "    <h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Top SKUs by units sold</h3>" +
    "    <table><thead><tr><th>SKU</th><th class=\"num\">Units</th><th class=\"num\">Revenue</th></tr></thead><tbody>" + topRows + "</tbody></table>" +
    "  </div>" +
    "  <div class=\"panel\">" +
    "    <h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Recent orders</h3>" +
    "    <table><thead><tr><th>Order</th><th>Status</th><th class=\"num\">Total</th></tr></thead><tbody>" + recentRows + "</tbody></table>" +
    "  </div>" +
    "</div></section>";

  var body = statsBlock + otherCurrencies + spark + twoCol;

  var html = _renderTemplate(DASHBOARD_LAYOUT, {
    shop_name:    opts.shop_name || "blamejs.shop",
    window_label: "Window: last 30 days (operator-tunable via ?since=&until=)",
    body:         "RAW_BODY",
  }).replace("RAW_BODY", body);
  return html;
}

function _statCard(label, value, accent) {
  return "<div class=\"stat-card\"><div class=\"label\">" + _htmlEscape(label) + "</div>" +
         "<div class=\"value" + (accent ? " accent" : "") + "\">" + _htmlEscape(value) + "</div></div>";
}

module.exports = {
  mount:           mount,
  AUDIT_NAMESPACE: AUDIT_NAMESPACE,
  renderDashboard: renderDashboard,
};
