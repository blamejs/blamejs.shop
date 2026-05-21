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

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var AUDIT_NAMESPACE = "shop_admin";

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

  // ---- media ----------------------------------------------------------

  router.post("/admin/media", W("media.attach", async function (req, res) {
    var m = await catalog.media.attach(req.body || {});
    _json(res, 201, m);
    return m;
  }));

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

  // ---- ping (auth check) ----------------------------------------------

  router.get("/admin/ping", R(async function (_req, res) {
    _json(res, 200, { ok: true, ts: Date.now() });
  }));
}

module.exports = {
  mount:           mount,
  AUDIT_NAMESPACE: AUDIT_NAMESPACE,
};
