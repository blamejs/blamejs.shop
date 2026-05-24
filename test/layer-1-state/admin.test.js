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
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

var REVIEW_MIGS = ["0001_catalog.sql", "0011_reviews.sql"].map(function (f) {
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

  // Auth still gates the new routes.
  var rNoAuth = await router._call("GET", "/admin/reviews", {});
  check("review list requires auth", rNoAuth.status === 401);
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

async function _factoryValidation() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query });
  var router  = _fakeRouter();
  assert.throws(function () { bShop.admin.mount(router, {}); },                                                  /catalog \+ deps.order/);
  assert.throws(function () { bShop.admin.mount(router, { catalog: catalog, order: order }); },                  /deps\.token/);
  assert.throws(function () { bShop.admin.mount(router, { catalog: catalog, order: order, token: "short" }); },   /deps\.token/);
}

async function run() {
  await _bearerGate();
  await _productCRUD();
  await _orderTransition();
  await _reviewModeration();
  await _reviewsAbsent();
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
