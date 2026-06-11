"use strict";
/**
 * admin — bearer-token gate + a sampling of routes against
 * in-memory primitives.
 *
 * The admin routes are mostly pass-throughs to already-tested
 * primitives (catalog / order / payment). The layer-1 test pins:
 *
 *   - bearer token validation (401 on missing / wrong / right)
 *   - constant-time compare (length-mismatch path)
 *   - one create + one update + one transition end-to-end against
 *     in-memory SQLite (so the wiring shape is exercised)
 *   - 400 on TypeError from a primitive (input shape rejection
 *     surfaces as RFC 9457 problem details)
 *   - factory validates token length
 */

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

var REVIEW_MIGS = ["0001_catalog.sql", "0011_reviews.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

var RETURN_MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0023_returns.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

// Orders + shop_config — the print-document masthead reads shop.name /
// shop.contact_email from shop_config.
var DOC_CONFIG_MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

// Orders + shipments + the three fulfillment-ops tables: pick lists,
// shipping labels, split-shipment plans.
var FULFILLMENT_MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0021_shipments.sql",
  "0051_shipping_labels.sql",
  "0096_split_shipments.sql",
  "0118_pick_lists.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery(migs) {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  (migs || MIGS).forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _fakeRouter() {
  var routes = {};
  function _add(method, path, handler) {
    routes[method + " " + path] = handler;
  }
  return {
    get:    function (p, h) { _add("GET",    p, h); },
    post:   function (p, h) { _add("POST",   p, h); },
    put:    function (p, h) { _add("PUT",    p, h); },
    patch:  function (p, h) { _add("PATCH",  p, h); },
    delete: function (p, h) { _add("DELETE", p, h); },
    use:    function () {},
    _routes: routes,
    _call: async function (method, path, opts) {
      opts = opts || {};
      var handler = routes[method + " " + path];
      if (!handler) {
        // Try matching against parameterized route patterns
        // (`/admin/products/:id`). Fill `params` automatically.
        var prefix = method + " ";
        var matched = Object.keys(routes).filter(function (k) { return k.indexOf(prefix) === 0; })
          .map(function (k) { return { key: k, pattern: k.slice(prefix.length) }; });
        for (var i = 0; i < matched.length; i += 1) {
          var pat = matched[i].pattern;
          if (pat.indexOf(":") === -1) continue;
          var partsP = pat.split("/");
          var partsU = path.split("/");
          if (partsP.length !== partsU.length) continue;
          var ok = true;
          var resolvedParams = Object.assign({}, opts.params || {});
          for (var j = 0; j < partsP.length; j += 1) {
            if (partsP[j].charAt(0) === ":") { resolvedParams[partsP[j].slice(1)] = partsU[j]; }
            else if (partsP[j] !== partsU[j])  { ok = false; break; }
          }
          if (ok) {
            handler = routes[matched[i].key];
            opts.params = resolvedParams;
            break;
          }
        }
      }
      if (!handler) throw new Error("no route registered: " + method + " " + path);
      var req = {
        headers: opts.headers || {},
        body:    opts.body    || null,
        params:  opts.params  || {},
        url:     opts.url     || path,
      };
      // The framework's multipart body-parser sets req.files; the fake
      // router lets a test pass the parsed-file shape directly so the
      // media file-upload route can be exercised without a live socket.
      if (opts.files) req.files = opts.files;
      var sent = { status: 0, body: null, headers: {} };
      var res = {
        // Node's res interface uses `res.statusCode = N`; framework
        // adapters expose `res.status(N)` as well. Track both.
        set statusCode(v) { sent.status = v; },
        get statusCode()  { return sent.status; },
        status: function (s) { sent.status = s; return this; },
        setHeader: function (k, v) { sent.headers[k.toLowerCase()] = v; },
        end: function (b) { sent.body = b == null ? "" : String(b); },
      };
      await handler(req, res);
      return sent;
    },
  };
}

var TOKEN = "test_token_abcdefghijklmnopqrstuvwxyz_32chars";

async function _bearerGate() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order });

  // No token → 401
  var r1 = await router._call("GET", "/admin/ping", {});
  check("no auth → 401", r1.status === 401);

  // Wrong token (same length) → 401
  var wrong = "x".repeat(TOKEN.length);
  var r2 = await router._call("GET", "/admin/ping", { headers: { authorization: "Bearer " + wrong } });
  check("wrong same-length → 401", r2.status === 401);

  // Wrong token (different length) → 401 (length-mismatch short-circuit)
  var r3 = await router._call("GET", "/admin/ping", { headers: { authorization: "Bearer short" } });
  check("wrong different-length → 401", r3.status === 401);

  // Right token → 200
  var r4 = await router._call("GET", "/admin/ping", { headers: { authorization: "Bearer " + TOKEN } });
  check("right token → 200", r4.status === 200);
  check("ping returns ok",     /"ok":true/.test(r4.body));

  // Lowercase "bearer " also accepted
  var r5 = await router._call("GET", "/admin/ping", { headers: { authorization: "bearer " + TOKEN } });
  check("lowercase bearer accepted", r5.status === 200);
}

async function _productCRUD() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order });

  var auth = { authorization: "Bearer " + TOKEN };

  // Create
  var r1 = await router._call("POST", "/admin/products", {
    headers: auth,
    body:    { slug: "admin-test", title: "AdminTest", status: "active" },
  });
  check("create returns 201", r1.status === 201);
  var p = JSON.parse(r1.body);
  check("create returned product", p.slug === "admin-test" && p.title === "AdminTest");

  // Update
  var r2 = await router._call("PATCH", "/admin/products/" + p.id, {
    headers: auth, params: { id: p.id },
    body:    { title: "AdminTest 2" },
  });
  check("update returns 200",  r2.status === 200);
  check("update changes title", JSON.parse(r2.body).title === "AdminTest 2");

  // Archive
  var r3 = await router._call("POST", "/admin/products/" + p.id + "/archive", {
    headers: auth, params: { id: p.id },
  });
  check("archive returns 200",  r3.status === 200);
  check("archive flips status", JSON.parse(r3.body).status === "archived");

  // Bad input → 400 problem-details
  var r4 = await router._call("POST", "/admin/products", {
    headers: auth,
    body:    { slug: "Bad Slug Spaces", title: "X" },
  });
  check("TypeError → 400", r4.status === 400);
  check("400 is problem-details JSON", /application\/problem\+json|problems\/bad-request/.test(r4.body) || /"status":400/.test(r4.body));
}

async function _orderTransition() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order });

  // Seed an order in pending
  var p = await catalog.products.create({ slug: "ord", title: "OrdTest", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "ORD-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sid,
    currency:          "USD",
    subtotal_minor:    5998,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 5998,
    ship_to:           { country: "US" },
    lines: [{
      variant_id: v.id, sku: "ORD-1", qty: 2,
      unit_amount_minor: 2999, unit_currency: "USD",
    }],
  });

  var r = await router._call("POST", "/admin/orders/" + o.id + "/transition", {
    headers: { authorization: "Bearer " + TOKEN },
    params:  { id: o.id },
    body:    { event: "mark_paid", reason: "manual" },
  });
  check("transition returns 200", r.status === 200);
  check("transition fires the FSM", JSON.parse(r.body).status === "paid");

  // Illegal transition → 400
  var r2 = await router._call("POST", "/admin/orders/" + o.id + "/transition", {
    headers: { authorization: "Bearer " + TOKEN },
    params:  { id: o.id },
    body:    { event: "teleport" },
  });
  check("illegal transition → 4xx/5xx", r2.status >= 400);
}

async function _reviewModeration() {
  var query   = _makeQuery(REVIEW_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var reviews = bShop.reviews.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order, reviews: reviews });

  var auth = { authorization: "Bearer " + TOKEN };

  // Two products so the cross-product queue is genuinely exercised.
  var pA = await catalog.products.create({ slug: "rev-a", title: "RevA", status: "active" });
  var pB = await catalog.products.create({ slug: "rev-b", title: "RevB", status: "active" });
  var cust = bShop.framework.uuid.v7();

  // Three pending reviews across both products, one already published.
  var s1 = await reviews.submit({ product_id: pA.id, customer_id: cust, rating: 5, title: "A1" });
  var s2 = await reviews.submit({ product_id: pB.id, customer_id: cust, rating: 4, title: "B1" });
  var s3 = await reviews.submit({ product_id: pA.id, customer_id: cust, rating: 3, title: "A2" });
  await reviews.publish(s3.id); // s3 becomes published — must NOT appear in pending queue

  // List defaults to pending, spans every product, excludes published.
  var rList = await router._call("GET", "/admin/reviews", { headers: auth });
  check("review list returns 200", rList.status === 200);
  var page = JSON.parse(rList.body);
  var listedIds = page.rows.map(function (r) { return r.id; });
  check("pending queue spans both products", listedIds.indexOf(s1.id) !== -1 && listedIds.indexOf(s2.id) !== -1);
  check("pending queue omits published", listedIds.indexOf(s3.id) === -1);
  check("pending queue is pending-only", page.rows.every(function (r) { return r.status === "pending"; }));

  // Explicit status filter narrows to published.
  var rPub = await router._call("GET", "/admin/reviews", { headers: auth, url: "/admin/reviews?status=published" });
  check("published filter returns 200", rPub.status === 200);
  var pubPage = JSON.parse(rPub.body);
  check("published filter returns only published", pubPage.rows.length === 1 && pubPage.rows[0].id === s3.id);

  // GET single review.
  var rGet = await router._call("GET", "/admin/reviews/" + s1.id, { headers: auth, params: { id: s1.id } });
  check("review get returns 200", rGet.status === 200);
  check("review get returns the row", JSON.parse(rGet.body).id === s1.id);

  // GET missing review → 404.
  var missingId = bShop.framework.uuid.v7();
  var rGetMiss = await router._call("GET", "/admin/reviews/" + missingId, { headers: auth, params: { id: missingId } });
  check("review get missing → 404", rGetMiss.status === 404);

  // Publish flips status.
  var rPublish = await router._call("POST", "/admin/reviews/" + s1.id + "/publish", {
    headers: auth, params: { id: s1.id },
  });
  check("review publish returns 200", rPublish.status === 200);
  check("review publish flips status", JSON.parse(rPublish.body).status === "published");

  // Publish missing id → 404 (REVIEW_NOT_FOUND mapped).
  var rPubMiss = await router._call("POST", "/admin/reviews/" + missingId + "/publish", {
    headers: auth, params: { id: missingId },
  });
  check("review publish missing → 404", rPubMiss.status === 404);

  // Reject sets rejected + records reason.
  var rReject = await router._call("POST", "/admin/reviews/" + s2.id + "/reject", {
    headers: auth, params: { id: s2.id }, body: { reason: "spam" },
  });
  check("review reject returns 200", rReject.status === 200);
  check("review reject flips status", JSON.parse(rReject.body).status === "rejected");

  // Reject missing id → 404.
  var rRejMiss = await router._call("POST", "/admin/reviews/" + missingId + "/reject", {
    headers: auth, params: { id: missingId }, body: { reason: "x" },
  });
  check("review reject missing → 404", rRejMiss.status === 404);

  // Auth still gates the route, content-negotiated: no bearer + no cookie
  // on a GET serves the sign-in form (browsers), not data (the JSON API
  // needs the bearer, exercised above).
  var rNoAuth = await router._call("GET", "/admin/reviews", {});
  check("review list unauth → sign-in form", rNoAuth.status === 200 && /Admin API key/.test(rNoAuth.body || ""));
}

async function _reviewsAbsent() {
  var query   = _makeQuery(REVIEW_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  // No reviews dep → routes must not mount.
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order });

  check("reviews-absent: list route not mounted", !router._routes["GET /admin/reviews"]);
  check("reviews-absent: publish route not mounted", !router._routes["POST /admin/reviews/:id/publish"]);
  check("reviews-absent: reject route not mounted", !router._routes["POST /admin/reviews/:id/reject"]);

  var auth = { authorization: "Bearer " + TOKEN };
  var threw = false;
  try {
    await router._call("GET", "/admin/reviews", { headers: auth });
  } catch (_e) { threw = true; }
  check("reviews-absent: calling the route throws (unregistered)", threw);
}

// Seed one order so the return_authorizations.order_id FK has a
// target. Mirrors the seed in returns.test.js.
async function _seedReturnOrder(query) {
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var p = await catalog.products.create({ slug: "rma-test", title: "RmaTest", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "RMA-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 4999 });
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sid,
    currency:          "USD",
    subtotal_minor:    9998,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 9998,
    ship_to:           { country: "US" },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               2,
      unit_amount_minor: 4999,
      unit_currency:     "USD",
    }],
  });
  return { order: o, variant: v };
}

function _rmaInput(seed) {
  return {
    order_id: seed.order.id,
    reason:   "defective",
    lines:    [{ sku: seed.variant.sku, qty: 1 }],
  };
}

async function _returnModeration() {
  var query   = _makeQuery(RETURN_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var returns = bShop.returns.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order, returns: returns });

  var auth = { authorization: "Bearer " + TOKEN };
  var seed = await _seedReturnOrder(query);

  // Three pending RMAs; one is approved so the pending queue must
  // exclude it.
  var r1 = await returns.request(_rmaInput(seed));
  var r2 = await returns.request(_rmaInput(seed));
  var r3 = await returns.request(_rmaInput(seed));
  await returns.approve(r3.id, { refund_amount_minor: 4999, refund_currency: "USD" });

  // Queue defaults to pending, spans all orders, excludes approved.
  var rList = await router._call("GET", "/admin/returns", { headers: auth });
  check("returns list returns 200", rList.status === 200);
  var page = JSON.parse(rList.body);
  var listedIds = page.rows.map(function (r) { return r.id; });
  check("pending queue includes pending RMAs", listedIds.indexOf(r1.id) !== -1 && listedIds.indexOf(r2.id) !== -1);
  check("pending queue omits approved",        listedIds.indexOf(r3.id) === -1);
  check("pending queue is pending-only",       page.rows.every(function (r) { return r.status === "pending"; }));

  // Explicit status filter narrows to approved.
  var rApproved = await router._call("GET", "/admin/returns", { headers: auth, url: "/admin/returns?status=approved" });
  check("approved filter returns 200", rApproved.status === 200);
  var apprPage = JSON.parse(rApproved.body);
  check("approved filter returns only approved", apprPage.rows.length === 1 && apprPage.rows[0].id === r3.id);

  // Invalid status query → 400 (status validator throws TypeError).
  var rBadStatus = await router._call("GET", "/admin/returns", { headers: auth, url: "/admin/returns?status=bogus" });
  check("invalid status → 400", rBadStatus.status === 400);

  // GET single RMA.
  var rGet = await router._call("GET", "/admin/returns/" + r1.id, { headers: auth, params: { id: r1.id } });
  check("returns get returns 200", rGet.status === 200);
  check("returns get returns the row", JSON.parse(rGet.body).id === r1.id);
  check("returns get hydrates lines", Array.isArray(JSON.parse(rGet.body).lines));

  // GET missing RMA → 404.
  var missingId = bShop.framework.uuid.v7();
  var rGetMiss = await router._call("GET", "/admin/returns/" + missingId, { headers: auth, params: { id: missingId } });
  check("returns get missing → 404", rGetMiss.status === 404);

  // GET non-UUID id → 4xx, never 500 (defensive request-shape reader).
  var rGetBad = await router._call("GET", "/admin/returns/not-a-uuid", { headers: auth, params: { id: "not-a-uuid" } });
  check("returns get bad-id → 4xx not 500", rGetBad.status >= 400 && rGetBad.status < 500);

  // approve → received → refund happy path through the endpoints.
  var rApprove = await router._call("POST", "/admin/returns/" + r1.id + "/approve", {
    headers: auth, params: { id: r1.id },
    body:    { refund_amount_minor: 4999, refund_currency: "USD", operator_notes: "QA confirms" },
  });
  check("approve returns 200", rApprove.status === 200);
  check("approve flips status", JSON.parse(rApprove.body).status === "approved");
  check("approve sets refund amount", JSON.parse(rApprove.body).refund_amount_minor === 4999);

  var rReceived = await router._call("POST", "/admin/returns/" + r1.id + "/received", {
    headers: auth, params: { id: r1.id }, body: { operator_notes: "package back" },
  });
  check("received returns 200", rReceived.status === 200);
  check("received flips status", JSON.parse(rReceived.body).status === "received");

  var rRefund = await router._call("POST", "/admin/returns/" + r1.id + "/refund", {
    headers: auth, params: { id: r1.id }, body: { operator_notes: "refunded via stripe" },
  });
  check("refund returns 200", rRefund.status === 200);
  check("refund flips status", JSON.parse(rRefund.body).status === "refunded");

  // reject the second RMA (pending → rejected).
  var rReject = await router._call("POST", "/admin/returns/" + r2.id + "/reject", {
    headers: auth, params: { id: r2.id }, body: { rejected_reason: "outside 30-day window" },
  });
  check("reject returns 200", rReject.status === 200);
  check("reject flips status", JSON.parse(rReject.body).status === "rejected");

  // Invalid transition: refund-from-pending → 4xx, never 500. Seed a
  // fresh pending RMA so the transition is genuinely illegal.
  var r4 = await returns.request(_rmaInput(seed));
  var rBadTrans = await router._call("POST", "/admin/returns/" + r4.id + "/refund", {
    headers: auth, params: { id: r4.id }, body: {},
  });
  check("illegal transition → 4xx not 500", rBadTrans.status >= 400 && rBadTrans.status < 500);

  // approve missing required field: refund_amount_minor absent → 400.
  var rApproveBad = await router._call("POST", "/admin/returns/" + r4.id + "/approve", {
    headers: auth, params: { id: r4.id }, body: {},
  });
  check("approve missing refund_amount_minor → 400", rApproveBad.status === 400);

  // reject without rejected_reason → 400 (missing required field).
  var rRejectBad = await router._call("POST", "/admin/returns/" + r4.id + "/reject", {
    headers: auth, params: { id: r4.id }, body: {},
  });
  check("reject without rejected_reason → 400", rRejectBad.status === 400);

  // Transition against a missing RMA → 404.
  var rApproveMiss = await router._call("POST", "/admin/returns/" + missingId + "/approve", {
    headers: auth, params: { id: missingId }, body: { refund_amount_minor: 100 },
  });
  check("approve missing RMA → 404", rApproveMiss.status === 404);

  // Non-UUID id on a transition → 4xx, never 500.
  var rApproveBadId = await router._call("POST", "/admin/returns/not-a-uuid/approve", {
    headers: auth, params: { id: "not-a-uuid" }, body: { refund_amount_minor: 100 },
  });
  check("approve bad-id → 4xx not 500", rApproveBadId.status >= 400 && rApproveBadId.status < 500);

  // Auth gates every route, content-negotiated like products/orders: the
  // JSON API needs the bearer (exercised above); a request without it
  // isn't served data — a browser GET gets the sign-in form, a write
  // bounces to /admin. (A token client that omits the header therefore
  // sees the form rather than a 401, matching the other console screens.)
  var rNoAuth = await router._call("GET", "/admin/returns", {});
  check("returns list unauth → sign-in form", rNoAuth.status === 200 && /Admin API key/.test(rNoAuth.body || ""));
  var rNoAuthApprove = await router._call("POST", "/admin/returns/" + r1.id + "/approve", { params: { id: r1.id }, body: {} });
  check("returns approve unauth → /admin redirect", rNoAuthApprove.status === 303);
}

async function _returnsAbsent() {
  var query   = _makeQuery(RETURN_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  // No returns dep → routes must not mount.
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order });

  check("returns-absent: list route not mounted",     !router._routes["GET /admin/returns"]);
  check("returns-absent: get route not mounted",       !router._routes["GET /admin/returns/:id"]);
  check("returns-absent: approve route not mounted",   !router._routes["POST /admin/returns/:id/approve"]);
  check("returns-absent: received route not mounted",  !router._routes["POST /admin/returns/:id/received"]);
  check("returns-absent: refund route not mounted",    !router._routes["POST /admin/returns/:id/refund"]);
  check("returns-absent: reject route not mounted",    !router._routes["POST /admin/returns/:id/reject"]);

  var auth = { authorization: "Bearer " + TOKEN };
  var threw = false;
  try {
    await router._call("GET", "/admin/returns", { headers: auth });
  } catch (_e) { threw = true; }
  check("returns-absent: calling the route throws (unregistered)", threw);
}

// Seed one order from a (price, qty) pair so the reporting + document
// tests have real orders/order_lines rows to aggregate + render. Returns
// the created order. Reuses the catalog/cart/order primitives the rest of
// the suite stands up.
async function _seedOrder(query, opts) {
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var slug = opts.slug;
  var p = await catalog.products.create({ slug: slug, title: slug, status: "active" });
  var v = await catalog.variants.create(p.id, { sku: opts.sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: opts.unit });
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: opts.qty });
  var lineTotal = opts.unit * opts.qty;
  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sid,
    currency:          "USD",
    subtotal_minor:    lineTotal,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: lineTotal,
    ship_to:           { country: "US", name: "Pat Buyer", line1: "1 Test St", city: "Townsville", region: "CA", postal_code: "90210" },
    lines: [{
      variant_id: v.id, sku: opts.sku, qty: opts.qty,
      unit_amount_minor: opts.unit, unit_currency: "USD",
    }],
  });
  return o;
}

async function _salesReport() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var salesReports = bShop.salesReports.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order, salesReports: salesReports });

  var auth = { authorization: "Bearer " + TOKEN };

  // Reports nav item is always present.
  check("reports route mounted", !!router._routes["GET /admin/reports"]);

  // Three orders: two stay (paid), one is refunded.
  //   A: 2 × 1500 = 3000   (kept)
  //   B: 1 × 4000 = 4000   (kept)
  //   C: 3 × 1000 = 3000   (refunded)
  var oA = await _seedOrder(query, { slug: "rep-a", sku: "REP-A", unit: 1500, qty: 2 });
  var oB = await _seedOrder(query, { slug: "rep-b", sku: "REP-B", unit: 4000, qty: 1 });
  var oC = await _seedOrder(query, { slug: "rep-c", sku: "REP-C", unit: 1000, qty: 3 });
  await order.transition(oA.id, "mark_paid");
  await order.transition(oB.id, "mark_paid");
  await order.transition(oC.id, "mark_paid");
  await order.transition(oC.id, "refund");

  // Wide window so every seeded order's updated_at falls inside (the
  // primitive caps the span at one year, so anchor it on now).
  var win = "?from=" + (Date.now() - 90 * 86400000) + "&to=" + (Date.now() + 86400000);

  var rRep = await router._call("GET", "/admin/reports", { headers: auth, url: "/admin/reports" + win });
  check("report returns 200", rRep.status === 200);
  var report = JSON.parse(rRep.body);

  // Gross counts every non-cancelled order (3000 + 4000 + 3000 = 10000).
  // Net adds the kept orders and SUBTRACTS the refunded order's grand total
  // (3000 + 4000 - 3000 = 4000) — the primitive's documented policy.
  // Refunds total the refunded grand totals (3000).
  check("report gross revenue", report.gross_revenue_minor === 10000);
  check("report net revenue",   report.net_revenue_minor === 4000);
  check("report refunds",       report.refund_total_minor === 3000);
  check("report order count",   report.order_count === 3);

  // AOV is over the non-cancelled, non-refunded orders (A + B): (3000 +
  // 4000) / 2 = 3500.
  check("report AOV", report.aov_minor === 3500);

  // Refund rate: 1 refunded of 3 orders = 3333 bps.
  check("report refund rate bps", report.refund_rate_bps === 3333);

  // Funnel: all 3 reached paid; 1 refunded; none shipped/delivered.
  check("report funnel paid",     report.by_status.paid === 3);
  check("report funnel refunded", report.by_status.refunded === 1);
  check("report funnel fulfilled", report.by_status.fulfilled === 0);

  // Top products excludes the refunded order's SKU; B leads by revenue.
  var topSkus = report.top_products.map(function (r) { return r.sku; });
  check("top products excludes refunded SKU", topSkus.indexOf("REP-C") === -1);
  check("top products includes kept SKUs", topSkus.indexOf("REP-A") !== -1 && topSkus.indexOf("REP-B") !== -1);
  check("top products ranks by revenue", report.top_products[0].sku === "REP-B");

  // CSV export — header + one data row per (day, currency) bucket. All
  // three kept-or-refunded orders land in the same UTC day here, so the
  // by-day series collapses to a single row.
  var rCsv = await router._call("GET", "/admin/reports", { headers: auth, url: "/admin/reports" + win + "&format=csv" });
  check("csv returns 200", rCsv.status === 200);
  check("csv content-type", /text\/csv/.test(rCsv.headers["content-type"] || ""));
  var csvLines = rCsv.body.replace(/\n$/, "").split("\n");
  check("csv has a header row", csvLines[0] === "date,currency,order_count,gross_revenue_minor,net_revenue_minor,refund_total_minor");
  check("csv has at least one data row", csvLines.length >= 2);
  check("csv data row carries the gross total", /,10000,/.test(rCsv.body));

  // Empty window (no orders in range) → an empty-but-valid report, never a
  // crash. Pick a window far in the past.
  var rEmpty = await router._call("GET", "/admin/reports", { headers: auth, url: "/admin/reports?from=1000&to=2000" });
  check("empty-window report returns 200", rEmpty.status === 200);
  var empty = JSON.parse(rEmpty.body);
  check("empty-window gross is zero", empty.gross_revenue_minor === 0);
  check("empty-window order count is zero", empty.order_count === 0);

  // Malformed range → 400 problem-details (config/entry tier).
  var rBad = await router._call("GET", "/admin/reports", { headers: auth, url: "/admin/reports?from=abc" });
  check("malformed range → 400", rBad.status === 400);

  // Reports route still mounts (and renders an unconfigured notice) when the
  // salesReports primitive is absent — the nav link is always present.
  var router2 = _fakeRouter();
  bShop.admin.mount(router2, { token: TOKEN, catalog: catalog, order: order });
  check("reports route mounts without salesReports", !!router2._routes["GET /admin/reports"]);
  var rUnconf = await router2._call("GET", "/admin/reports", { headers: auth });
  check("unconfigured reports → 503", rUnconf.status === 503);
}

async function _orderDocuments() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var printReceipts = bShop.printReceipts.create({ order: order });
  var packingSlips  = bShop.packingSlips.create({ order: order });
  var router  = _fakeRouter();
  bShop.admin.mount(router, {
    token: TOKEN, catalog: catalog, order: order,
    printReceipts: printReceipts, packingSlips: packingSlips,
  });

  var auth = { authorization: "Bearer " + TOKEN };

  check("receipt route mounted",      !!router._routes["GET /admin/orders/:id/receipt"]);
  check("packing-slip route mounted", !!router._routes["GET /admin/orders/:id/packing-slip"]);

  var o = await _seedOrder(query, { slug: "doc-1", sku: "DOC-1", unit: 2500, qty: 2 });

  // Receipt renders the order's line + totals as a complete HTML document.
  var rRcpt = await router._call("GET", "/admin/orders/" + o.id + "/receipt", {
    headers: auth, params: { id: o.id },
  });
  check("receipt returns 200", rRcpt.status === 200);
  check("receipt is an HTML document", /<!doctype html>/i.test(rRcpt.body));
  check("receipt carries the SKU", rRcpt.body.indexOf("DOC-1") !== -1);
  check("receipt carries the order id", rRcpt.body.indexOf(o.id) !== -1);
  // Grand total 2 × 2500 = 5000 → "50.00 USD".
  check("receipt carries the grand total", rRcpt.body.indexOf("50.00 USD") !== -1);
  check("receipt has print CSS", /@page/.test(rRcpt.body));

  // Packing slip renders the order contents (no payment data) with a
  // scan-to-verify barcode.
  var rSlip = await router._call("GET", "/admin/orders/" + o.id + "/packing-slip", {
    headers: auth, params: { id: o.id },
  });
  check("packing-slip returns 200", rSlip.status === 200);
  check("packing-slip is an HTML document", /<!doctype html>/i.test(rSlip.body));
  check("packing-slip carries the SKU", rSlip.body.indexOf("DOC-1") !== -1);
  check("packing-slip carries the ship-to name", rSlip.body.indexOf("Pat Buyer") !== -1);
  check("packing-slip has a barcode", /<svg/.test(rSlip.body));

  // Unknown (well-formed) order id → 404, not 500.
  var missingId = bShop.framework.uuid.v7();
  var rMiss = await router._call("GET", "/admin/orders/" + missingId + "/receipt", {
    headers: auth, params: { id: missingId },
  });
  check("missing-order receipt → 404", rMiss.status === 404);

  // Malformed order id → 404 (swallows only the TypeError from the id
  // reader), never a 500.
  var rBadId = await router._call("GET", "/admin/orders/not-a-uuid/receipt", {
    headers: auth, params: { id: "not-a-uuid" },
  });
  check("malformed-id receipt → 404", rBadId.status === 404);
  var rBadSlip = await router._call("GET", "/admin/orders/not-a-uuid/packing-slip", {
    headers: auth, params: { id: "not-a-uuid" },
  });
  check("malformed-id packing-slip → 404", rBadSlip.status === 404);

  // Document routes stay unmounted when the render primitives are absent.
  var router2 = _fakeRouter();
  bShop.admin.mount(router2, { token: TOKEN, catalog: catalog, order: order });
  check("receipt route unmounted without printReceipts", !router2._routes["GET /admin/orders/:id/receipt"]);
  check("packing-slip route unmounted without packingSlips", !router2._routes["GET /admin/orders/:id/packing-slip"]);

  // With shop_config wired, the receipt carries the shop name + contact
  // masthead (read from shop.name / shop.contact_email).
  var configMigQuery = _makeQuery(DOC_CONFIG_MIGS);
  var catalog3 = bShop.catalog.create({ query: configMigQuery });
  var order3   = bShop.order.create({ query: configMigQuery });
  var config3  = bShop.config.create({ query: configMigQuery });
  await config3.put("shop.name", "Acme Goods");
  await config3.put("shop.contact_email", "help@acme.example");
  var printReceipts3 = bShop.printReceipts.create({ order: order3 });
  var router3 = _fakeRouter();
  bShop.admin.mount(router3, {
    token: TOKEN, catalog: catalog3, order: order3,
    printReceipts: printReceipts3, config: config3,
  });
  var o3 = await _seedOrder(configMigQuery, { slug: "doc-cfg", sku: "DOC-CFG", unit: 1000, qty: 1 });
  var rCfg = await router3._call("GET", "/admin/orders/" + o3.id + "/receipt", {
    headers: auth, params: { id: o3.id },
  });
  check("receipt with config returns 200", rCfg.status === 200);
  check("receipt carries the shop name", rCfg.body.indexOf("Acme Goods") !== -1);
  check("receipt carries the shop contact", rCfg.body.indexOf("help@acme.example") !== -1);
}

async function _factoryValidation() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  assert.throws(function () { bShop.admin.mount(router, {}); },                                                  /catalog \+ deps.order/);
  assert.throws(function () { bShop.admin.mount(router, { catalog: catalog, order: order }); },                  /deps\.token/);
  assert.throws(function () { bShop.admin.mount(router, { catalog: catalog, order: order, token: "short" }); },   /deps\.token/);
}

// A 1x1 PNG (valid magic bytes + IHDR + IDAT) — small enough to inline,
// real enough for b.fileType.detect to classify as image/png.
var TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000a49444154789c6360000002000100ffff", "hex");
// GIF89a header — sniffs as image/gif, used to drive the
// declared-vs-detected mismatch path (uploaded as image/png).
var TINY_GIF = Buffer.from("474946383961", "hex");

// Write a buffer to a fresh tmp file and return the multipart-file shape
// the framework body-parser produces (field / filename / mimeType / path
// / size / hash). The file-upload route reads file.path back off disk.
function _fileFixture(buf, mimeType, filename) {
  var p = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-admin-upload-")), filename || "upload.bin");
  nodeFs.writeFileSync(p, buf);
  return { field: "file", filename: filename || "upload.bin", mimeType: mimeType, path: p, size: buf.length, hash: "" };
}

async function _mediaFileUpload() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var prod    = await catalog.products.create({ slug: "upload-target", title: "Upload Target", status: "active" });

  // Mock r2_bridge: records every put, returns the bridge's success shape.
  var puts = [];
  var r2Mock = {
    put: async function (key, body, contentType) {
      puts.push({ key: key, size: body.length, contentType: contentType });
      return { ok: true, key: key, size: body.length };
    },
  };

  var router = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order, r2_bridge: r2Mock, asset_prefix: "/assets/" });
  var auth = { authorization: "Bearer " + TOKEN };
  var P = "/admin/products/" + prod.id + "/media/upload-file";

  // Happy path: a valid PNG attaches the media row + stores to R2.
  var okFile = _fileFixture(TINY_PNG, "image/png", "hero.png");
  var ok = await router._call("POST", P, { headers: auth, files: [okFile], params: { id: prod.id }, body: { alt_text: "Hero" } });
  check("file upload returns 201",            ok.status === 201);
  var rec = JSON.parse(ok.body);
  check("file upload stored to R2",           puts.length === 1 && /^media\/.*\.png$/.test(puts[0].key));
  check("file upload put used declared CT",   puts[0].contentType === "image/png");
  check("file upload attached media row",     rec.r2_key === puts[0].key && rec.content_type === "image/png");
  check("file upload exposed asset_url",      rec.asset_url === "/assets/" + puts[0].key);
  check("file upload kept alt text",          rec.alt_text === "Hero");
  var mediaRows = await catalog.media.listForProduct(prod.id);
  check("file upload media persisted",        mediaRows.length === 1 && mediaRows[0].r2_key === puts[0].key);

  // Disallowed content-type → 415, nothing stored.
  var pdfFile = _fileFixture(Buffer.from("%PDF-1.4\n"), "application/pdf", "doc.pdf");
  var badType = await router._call("POST", P, { headers: auth, files: [pdfFile], params: { id: prod.id }, body: {} });
  check("disallowed type → 415",              badType.status === 415);
  check("disallowed type stored nothing",     puts.length === 1);

  // Content-type / magic-byte mismatch: GIF bytes labelled image/png → 422.
  var mismatch = _fileFixture(TINY_GIF, "image/png", "fake.png");
  var mm = await router._call("POST", P, { headers: auth, files: [mismatch], params: { id: prod.id }, body: {} });
  check("CT/magic mismatch → 422",            mm.status === 422);
  check("mismatch stored nothing",            puts.length === 1);

  // Oversized file (size header beyond the 10 MiB media cap) → 413. Use a
  // small on-disk buffer but an inflated size field so the cap trips on the
  // declared size before the bytes are read back.
  var bigFile = _fileFixture(TINY_PNG, "image/png", "big.png");
  bigFile.size = bShop.framework.constants.BYTES.mib(11);
  var big = await router._call("POST", P, { headers: auth, files: [bigFile], params: { id: prod.id }, body: {} });
  check("oversized file → 413",               big.status === 413);
  check("oversized stored nothing",           puts.length === 1);

  // No file part → 400.
  var noFile = await router._call("POST", P, { headers: auth, files: [], params: { id: prod.id }, body: {} });
  check("missing file → 400",                 noFile.status === 400);

  // No product/variant target (JSON API route, no path id) → 400.
  var noTarget = await router._call("POST", "/admin/media/upload-file", { headers: auth, files: [_fileFixture(TINY_PNG, "image/png", "x.png")], body: {} });
  check("missing target → 400",               noTarget.status === 400);

  // SVG: text body (no magic bytes) is accepted on the declared type — the
  // mismatch cross-check is skipped, matching the upload-from-URL flow.
  var svgFile = _fileFixture(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), "image/svg+xml", "icon.svg");
  var svg = await router._call("POST", P, { headers: auth, files: [svgFile], params: { id: prod.id }, body: {} });
  check("svg upload accepted (201)",          svg.status === 201);
  check("svg stored as .svg key",             puts.length === 2 && /\.svg$/.test(puts[1].key));

  // Bearer JSON API route with explicit product_id field works too.
  var apiFile = _fileFixture(TINY_PNG, "image/png", "api.png");
  var api = await router._call("POST", "/admin/media/upload-file", { headers: auth, files: [apiFile], body: { product_id: prod.id } });
  check("API file upload returns 201",        api.status === 201);
}

async function _mediaFileUploadAbsent() {
  // No r2_bridge dep → the file-upload routes must not mount.
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order });

  check("no-bridge: api file route absent",     !router._routes["POST /admin/media/upload-file"]);
  check("no-bridge: product file route absent", !router._routes["POST /admin/products/:id/media/upload-file"]);
  // The URL-upload routes are equally gated on the bridge.
  check("no-bridge: api url route absent",      !router._routes["POST /admin/media/upload"]);
}

// ---- fulfillment ops (pick lists / shipping labels / split shipments) ----

// Seed a paid order with two lines so the fulfillment primitives have
// real order_lines + an eligible-state order to fold into a worksheet /
// split / shipment. Returns the hydrated order.
async function _seedPaidOrder(query, catalog, cart, order, slug) {
  var p = await catalog.products.create({ slug: slug, title: slug, status: "active" });
  var v1 = await catalog.variants.create(p.id, { sku: slug + "-A" });
  var v2 = await catalog.variants.create(p.id, { sku: slug + "-B" });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 1000 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 2000 });
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v1.id, qty: 2 });
  await cart.addLine(c.id, { variant_id: v2.id, qty: 1 });
  var o = await order.createFromCart({
    cart_id: c.id, session_id: sid, currency: "USD",
    subtotal_minor: 4000, discount_minor: 0, tax_minor: 0, shipping_minor: 0,
    grand_total_minor: 4000, ship_to: { country: "US" },
    lines: [
      { variant_id: v1.id, sku: slug + "-A", qty: 2, unit_amount_minor: 1000, unit_currency: "USD" },
      { variant_id: v2.id, sku: slug + "-B", qty: 1, unit_amount_minor: 2000, unit_currency: "USD" },
    ],
  });
  await order.transition(o.id, "mark_paid", { reason: "test" });
  return await order.get(o.id);
}

async function _pickListConsole() {
  var query   = _makeQuery(FULFILLMENT_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var orderTracking = bShop.orderTracking.create({ query: query, order: order });
  var pickLists = bShop.pickLists.create({ query: query, order: order, orderTracking: orderTracking });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order, orderTracking: orderTracking, pickLists: pickLists });
  var auth = { authorization: "Bearer " + TOKEN };

  var o = await _seedPaidOrder(query, catalog, cart, order, "pick");

  // Generate a pick list from the one eligible order at a location.
  var gen = await router._call("POST", "/admin/pick-lists", {
    headers: auth, body: { location_code: "WH-EAST", order_ids: [o.id], sort_by: "sku" },
  });
  check("pick-list generate → 201", gen.status === 201);
  var list = JSON.parse(gen.body);
  check("pick-list has both line skus", list.lines.length === 2);

  // Detail page renders the worksheet.
  var detail = await router._call("GET", "/admin/pick-lists/" + list.id, { headers: auth, params: { id: list.id } });
  check("pick-list detail → 200", detail.status === 200);
  check("pick-list detail returns the list", JSON.parse(detail.body).id === list.id);

  // Print view renders an HTML document.
  var print = await router._call("GET", "/admin/pick-lists/" + list.id + "/print", { headers: auth, params: { id: list.id } });
  check("pick-list print → 200", print.status === 200);
  check("pick-list print is a worksheet doc", /pick list/i.test(print.body) && /<table/.test(print.body));

  // Confirm both lines as picked.
  for (var i = 0; i < list.lines.length; i += 1) {
    var ln = list.lines[i];
    var pick = await router._call("POST", "/admin/pick-lists/" + list.id + "/lines/" + ln.id + "/pick", {
      headers: auth, params: { id: list.id, lineId: ln.id },
      body: { picker_id: "alice", actual_quantity: String(ln.expected_quantity) },
    });
    check("pick-list confirm line → 200", pick.status === 200);
  }
  // After both confirms the list is in_progress with every line settled.
  var after = JSON.parse((await router._call("GET", "/admin/pick-lists/" + list.id, { headers: auth, params: { id: list.id } })).body);
  check("pick-list line confirmed", after.lines.every(function (l) { return l.actual_quantity != null; }));

  // Complete → fans out one shipment for the parent order.
  var done = await router._call("POST", "/admin/pick-lists/" + list.id + "/complete", {
    headers: auth, params: { id: list.id },
  });
  check("pick-list complete → 200", done.status === 200);
  var completed = JSON.parse(done.body);
  check("pick-list complete creates a shipment", completed.shipments && completed.shipments.length === 1);
  check("pick-list status is complete", completed.status === "complete");

  // Bad id → 404 (swallow TypeError only).
  var missing = bShop.framework.uuid.v7();
  var nf = await router._call("GET", "/admin/pick-lists/" + missing, { headers: auth, params: { id: missing } });
  check("pick-list missing → 404", nf.status === 404);

  // Empty pick list — generate against an isolated environment with no
  // eligible orders → 400 (the primitive refuses "no eligible orders").
  var emptyQuery = _makeQuery(FULFILLMENT_MIGS);
  var emptyOrder = bShop.order.create({ query: emptyQuery });
  var emptyOt = bShop.orderTracking.create({ query: emptyQuery, order: emptyOrder });
  var emptyPick = bShop.pickLists.create({ query: emptyQuery, order: emptyOrder, orderTracking: emptyOt });
  var emptyRouter = _fakeRouter();
  bShop.admin.mount(emptyRouter, { token: TOKEN, catalog: bShop.catalog.create({ query: emptyQuery }), order: emptyOrder, orderTracking: emptyOt, pickLists: emptyPick });
  var empty = await emptyRouter._call("POST", "/admin/pick-lists", {
    headers: auth, body: { location_code: "WH-WEST" },
  });
  check("pick-list empty-batch → 400", empty.status === 400);

  // Missing location_code → 400.
  var noLoc = await router._call("POST", "/admin/pick-lists", { headers: auth, body: {} });
  check("pick-list missing location → 400", noLoc.status === 400);

  // Unauthenticated browser GET → sign-in form (content negotiation), not
  // worksheet data.
  var unauth = await router._call("GET", "/admin/pick-lists", {});
  check("pick-lists unauth → sign-in form", unauth.status === 200 && /Admin API key/.test(unauth.body || ""));

  // Route-gating: no pickLists dep → routes absent.
  var router2 = _fakeRouter();
  bShop.admin.mount(router2, { token: TOKEN, catalog: catalog, order: order });
  check("pick-lists absent: list route not mounted", !router2._routes["GET /admin/pick-lists"]);
  check("pick-lists absent: generate route not mounted", !router2._routes["POST /admin/pick-lists"]);
}

async function _shippingLabelConsole() {
  var query   = _makeQuery(FULFILLMENT_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var orderTracking = bShop.orderTracking.create({ query: query, order: order });
  var shippingLabels = bShop.shippingLabels.create({ query: query });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order, orderTracking: orderTracking, shippingLabels: shippingLabels });
  var auth = { authorization: "Bearer " + TOKEN };

  var o = await _seedPaidOrder(query, catalog, cart, order, "label");
  var ship = await orderTracking.createShipment({ order_id: o.id, carrier: "ups", tracking_number: "1Z-PRE" });

  // Record a carrier-minted label against the shipment (request + purchase
  // composed in one POST). Cost is integer minor units.
  var rec = await router._call("POST", "/admin/orders/" + o.id + "/shipments/" + ship.id + "/labels", {
    headers: auth, params: { id: o.id, shipmentId: ship.id },
    body: {
      carrier: "ups", service_level: "Ground", package_type: "parcel",
      weight_grams: "500", length_mm: "300", width_mm: "200", height_mm: "100",
      tracking_number: "1Z999AA10123456784",
      label_url: "https://labels.example.com/abc.pdf",
      cost_minor: "650", currency: "usd", purchased_via: "manual",
    },
  });
  check("label record → 201", rec.status === 201);
  var label = JSON.parse(rec.body);
  check("label is purchased", label.status === "purchased");
  check("label currency upcased", label.currency === "USD");
  check("label cost is integer minor units", label.cost_minor === 650);

  // The recorded label is now retrievable for the shipment — the data the
  // order-detail label panel reads. (The bearer path returns the order
  // JSON; the HTML panel renders the same labelsForShipment data, which
  // is asserted here against the primitive directly.)
  var onShip = await shippingLabels.labelsForShipment(ship.id);
  check("label persisted on shipment", onShip.length === 1 && onShip[0].tracking_number === "1Z999AA10123456784");

  // Mark used → purchased → used.
  var used = await router._call("POST", "/admin/orders/" + o.id + "/labels/" + label.id + "/used", {
    headers: auth, params: { id: o.id, labelId: label.id },
  });
  check("label mark-used → 200", used.status === 200);
  check("label is used", JSON.parse(used.body).status === "used");

  // Label for a non-numeric cost (parseInt would truncate "6.5abc") → 400.
  var bad = await router._call("POST", "/admin/orders/" + o.id + "/shipments/" + ship.id + "/labels", {
    headers: auth, params: { id: o.id, shipmentId: ship.id },
    body: {
      carrier: "ups", service_level: "Ground", package_type: "parcel",
      weight_grams: "500", length_mm: "300", width_mm: "200", height_mm: "100",
      tracking_number: "1Z-X", label_url: "https://labels.example.com/x.pdf",
      cost_minor: "6.5abc", currency: "USD", purchased_via: "manual",
    },
  });
  check("label bad cost → 400", bad.status === 400);

  // Label against a missing shipment → 400 (TypeError from the primitive).
  var missShip = bShop.framework.uuid.v7();
  var nf = await router._call("POST", "/admin/orders/" + o.id + "/shipments/" + missShip + "/labels", {
    headers: auth, params: { id: o.id, shipmentId: missShip },
    body: {
      carrier: "ups", service_level: "Ground", package_type: "parcel",
      weight_grams: "500", length_mm: "300", width_mm: "200", height_mm: "100",
      tracking_number: "1Z-Y", label_url: "https://labels.example.com/y.pdf",
      cost_minor: "650", currency: "USD", purchased_via: "manual",
    },
  });
  check("label missing shipment → 400", nf.status === 400);

  // Route-gating: no shippingLabels dep → label routes absent.
  var router2 = _fakeRouter();
  bShop.admin.mount(router2, { token: TOKEN, catalog: catalog, order: order, orderTracking: orderTracking });
  check("labels absent: record route not mounted", !router2._routes["POST /admin/orders/:id/shipments/:shipmentId/labels"]);
}

async function _splitShipmentConsole() {
  var query   = _makeQuery(FULFILLMENT_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var orderTracking = bShop.orderTracking.create({ query: query, order: order });
  var splitShipments = bShop.splitShipments.create({ query: query, order: order, orderTracking: orderTracking });
  var router  = _fakeRouter();
  bShop.admin.mount(router, { token: TOKEN, catalog: catalog, order: order, orderTracking: orderTracking, splitShipments: splitShipments });
  var auth = { authorization: "Bearer " + TOKEN };

  var o = await _seedPaidOrder(query, catalog, cart, order, "split");
  var lineA = o.lines[0]; // qty 2
  var lineB = o.lines[1]; // qty 1

  // Plan a manual split: line A (full qty 2) ships now in parcel 1, line B
  // (qty 1) ships later in parcel 2 — partial then remainder. The browser
  // form posts parcel_<id> + qty_<id> pairs.
  var planBody = {};
  planBody["parcel_" + lineA.id] = "1"; planBody["qty_" + lineA.id] = String(lineA.qty);
  planBody["parcel_" + lineB.id] = "2"; planBody["qty_" + lineB.id] = String(lineB.qty);
  var plan = await router._call("POST", "/admin/orders/" + o.id + "/split/plan", {
    headers: auth, params: { id: o.id }, body: planBody,
  });
  check("split plan → 201", plan.status === 201);
  var planned = JSON.parse(plan.body);
  check("split plan has two parcels", planned.shipments.length === 2);
  check("split plan is proposed", planned.status === "proposed");

  // Execute the plan → one shipment per parcel.
  var exec = await router._call("POST", "/admin/orders/" + o.id + "/split/" + planned.id + "/execute", {
    headers: auth, params: { id: o.id, planId: planned.id },
  });
  check("split execute → 200", exec.status === 200);
  var executed = JSON.parse(exec.body);
  check("split executed creates two shipments", executed.shipment_ids.length === 2);
  check("split plan is executed", executed.status === "executed");

  // Both parcels are now shipments on the order; the order FSM stays
  // honest — it's still `paid`/`fulfilling`, not auto-advanced.
  var shipRows = await orderTracking.listForOrder(o.id);
  check("split produced two order shipments", shipRows.length === 2);
  var fresh = await order.get(o.id);
  check("order FSM not auto-advanced by split", fresh.status === "paid");

  // A plan that drops a line (zero qty on lineB, only parcel 1) violates
  // the conservation check → 400.
  var o2 = await _seedPaidOrder(query, catalog, cart, order, "split2");
  var dropBody = {};
  dropBody["parcel_" + o2.lines[0].id] = "1"; dropBody["qty_" + o2.lines[0].id] = String(o2.lines[0].qty);
  // lineB omitted entirely → unconsumed qty.
  var bad = await router._call("POST", "/admin/orders/" + o2.id + "/split/plan", {
    headers: auth, params: { id: o2.id }, body: dropBody,
  });
  check("split with unconsumed line → 400", bad.status === 400);

  // Split with zero items (empty parcel assignment) → 400.
  var empty = await router._call("POST", "/admin/orders/" + o2.id + "/split/plan", {
    headers: auth, params: { id: o2.id }, body: {},
  });
  check("split zero items → 400", empty.status === 400);

  // Cancel a proposed plan.
  var o3 = await _seedPaidOrder(query, catalog, cart, order, "split3");
  var cBody = {};
  cBody["parcel_" + o3.lines[0].id] = "1"; cBody["qty_" + o3.lines[0].id] = String(o3.lines[0].qty);
  cBody["parcel_" + o3.lines[1].id] = "1"; cBody["qty_" + o3.lines[1].id] = String(o3.lines[1].qty);
  var p3 = JSON.parse((await router._call("POST", "/admin/orders/" + o3.id + "/split/plan", {
    headers: auth, params: { id: o3.id }, body: cBody,
  })).body);
  var cancel = await router._call("POST", "/admin/orders/" + o3.id + "/split/" + p3.id + "/cancel", {
    headers: auth, params: { id: o3.id, planId: p3.id },
  });
  check("split cancel → 200", cancel.status === 200);
  check("split plan is cancelled", JSON.parse(cancel.body).status === "cancelled");

  // Bad order id on plan → 400 (TypeError swallowed).
  var nf = await router._call("POST", "/admin/orders/not-a-uuid/split/plan", {
    headers: auth, params: { id: "not-a-uuid" }, body: { manualPlan: [{ lines: [{ line_id: lineA.id, qty: 2 }] }] },
  });
  check("split bad order id → 400", nf.status === 400);

  // Route-gating: no splitShipments dep → split routes absent.
  var router2 = _fakeRouter();
  bShop.admin.mount(router2, { token: TOKEN, catalog: catalog, order: order, orderTracking: orderTracking });
  check("split absent: plan route not mounted", !router2._routes["POST /admin/orders/:id/split/plan"]);
}

async function run() {
  await _bearerGate();
  await _productCRUD();
  await _orderTransition();
  await _reviewModeration();
  await _reviewsAbsent();
  await _returnModeration();
  await _returnsAbsent();
  await _mediaFileUpload();
  await _mediaFileUploadAbsent();
  await _salesReport();
  await _orderDocuments();
  await _pickListConsole();
  await _shippingLabelConsole();
  await _splitShipmentConsole();
  await _factoryValidation();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("admin: " + helpers.getChecks() + " checks passed\n");
  }).catch(function (e) {
    process.stderr.write((e && e.stack || String(e)) + "\n");
    process.exit(1);
  });
}
