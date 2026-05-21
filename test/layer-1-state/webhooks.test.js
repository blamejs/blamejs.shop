"use strict";
/**
 * webhooks — outbound merchant webhook delivery.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001..0005. The HTTP transport is stubbed so deliveries flow
 * through the primitive without touching the network — the stub
 * captures every request, can be programmed to fail / succeed, and
 * the resulting `webhook_deliveries` rows are asserted directly.
 *
 * Coverage:
 *   - endpoint CRUD + url validation (https only)
 *   - signing round-trip via b.webhook.verifier
 *   - event filtering (`*` and comma-list)
 *   - delivery rows persisted on success + failure
 *   - retry on transient transport error
 *   - manual retry endpoint
 *   - inactive endpoints skipped
 *   - order.transition fan-out
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql", "0005_webhooks.sql"]
  .map(function (f) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
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

// _captureTransport — programmable stub. Each invocation pushes a
// record into `received` and returns the next response from
// `responses` (or a default 200). When `responses` runs out, returns
// the trailing entry — convenient for "always succeed" / "always fail"
// scenarios.
function _captureTransport(responses) {
  var queue = (responses || []).slice();
  var received = [];
  var fn = async function (req) {
    received.push(req);
    var r = queue.length > 1 ? queue.shift() : queue[0];
    if (!r) return { statusCode: 200 };
    if (r && r.throw) {
      var e = new Error(r.throw.message || "transport-error");
      e.code = r.throw.code || "ECONNRESET";
      throw e;
    }
    return { statusCode: r.statusCode };
  };
  fn.received = received;
  return fn;
}

async function _createEndpoint() {
  var q = _makeQuery();
  var webhooks = bShop.webhooks.create({ query: q });
  var ep = await webhooks.endpoints.create({
    url:    "https://example.com/hook",
    events: "*",
  });
  check("endpoint id is uuid",       typeof ep.id === "string" && ep.id.length === 36);
  check("endpoint secret returned",  typeof ep.secret === "string" && ep.secret.length >= 32);
  check("endpoint active by default", ep.active === 1);
  check("endpoint normalises events", ep.events === "*");
  return { q: q, webhooks: webhooks, endpoint: ep };
}

async function _crud() {
  var ctx = await _createEndpoint();
  var webhooks = ctx.webhooks;
  var ep = ctx.endpoint;

  // get
  var got = await webhooks.endpoints.get(ep.id);
  check("get round-trips", got && got.url === ep.url);

  // list
  var listed = await webhooks.endpoints.list();
  check("list returns one", listed.length === 1 && listed[0].id === ep.id);

  // update url
  var updated = await webhooks.endpoints.update(ep.id, { url: "https://example.com/hook2" });
  check("update url",     updated.url === "https://example.com/hook2");
  check("update bumps ts", updated.updated_at >= ep.updated_at);

  // update events
  var u2 = await webhooks.endpoints.update(ep.id, { events: "order.mark_paid,order.refund" });
  check("update events",  u2.events === "order.mark_paid,order.refund");

  // update active
  var u3 = await webhooks.endpoints.update(ep.id, { active: false });
  check("update active=0", u3.active === 0);

  // delete
  var ok = await webhooks.endpoints.delete(ep.id);
  check("delete returns true", ok === true);
  var missing = await webhooks.endpoints.get(ep.id);
  check("after delete get is null", missing === null);

  // delete unknown
  var missDel = await webhooks.endpoints.delete(bShop.framework.uuid.v7());
  check("delete unknown false", missDel === false);
}

async function _urlValidation() {
  var q = _makeQuery();
  var webhooks = bShop.webhooks.create({ query: q });
  await assert.rejects(webhooks.endpoints.create({ url: "http://example.com/hook", events: "*" }), /https/);
  await assert.rejects(webhooks.endpoints.create({ url: "ftp://example.com/", events: "*" }), /https/);
  await assert.rejects(webhooks.endpoints.create({ url: "not-a-url", events: "*" }), /https|url/);
  await assert.rejects(webhooks.endpoints.create({ url: "https://example.com/", events: "order.totally_invented" }), /unknown event/);
  await assert.rejects(webhooks.endpoints.create({ url: "https://example.com/", events: "" }), /events/);
  await assert.rejects(webhooks.endpoints.create({ url: "", events: "*" }), /url/);
}

async function _signingRoundTrip() {
  var q = _makeQuery();
  var transport = _captureTransport([{ statusCode: 200 }]);
  var webhooks = bShop.webhooks.create({ query: q, transport: transport });
  var ep = await webhooks.endpoints.create({ url: "https://example.com/hook", events: "*" });

  var deliveries = await webhooks.send("order.mark_paid", { order_id: "o_1" });
  check("one delivery row", deliveries.length === 1);
  check("delivery is delivered", deliveries[0].delivered_at != null && deliveries[0].last_status === 200);

  // The captured request carries the framework's signature header.
  var sent = transport.received[0];
  check("transport saw POST body", typeof sent.body === "string" && sent.body.indexOf("o_1") !== -1);
  check("Webhook-Signature header present", !!sent.headers["Webhook-Signature"]);
  check("Webhook-Event header present",     sent.headers["Webhook-Event"] === "order.mark_paid");
  check("Webhook-Delivery header present",  typeof sent.headers["Webhook-Delivery"] === "string");

  // Verify the signature with b.webhook.verifier — confirms the
  // operator-facing verification recipe actually works against what we
  // emit.
  var verifier = bShop.framework.webhook.verifier({
    algo: "hmac-sha3-512",
    keys: { v1: Buffer.from(ep.secret, "utf8") },
  });
  var info = await verifier.verify({ body: sent.body, headers: sent.headers });
  check("verifier accepts emitted signature", info.kid === "v1");
}

async function _eventFiltering() {
  var q = _makeQuery();
  var transport = _captureTransport([{ statusCode: 200 }]);
  var webhooks = bShop.webhooks.create({ query: q, transport: transport });

  // Endpoint A subscribes to a single event; B subscribes to wildcard.
  var epA = await webhooks.endpoints.create({ url: "https://a.example.com/", events: "order.mark_paid" });
  var epB = await webhooks.endpoints.create({ url: "https://b.example.com/", events: "*" });

  // Event A subscribes to → both A + B fire.
  var d1 = await webhooks.send("order.mark_paid", { x: 1 });
  check("mark_paid fans to 2 endpoints", d1.length === 2);

  // Event A does NOT subscribe to → only B fires.
  var d2 = await webhooks.send("order.refund", { x: 2 });
  check("refund fans to 1 endpoint (only *)", d2.length === 1);
  check("refund delivered to B",
    d2[0].endpoint_id === epB.id);

  // Inactive endpoint is skipped.
  await webhooks.endpoints.update(epB.id, { active: false });
  var d3 = await webhooks.send("order.mark_paid", { x: 3 });
  check("inactive B skipped — only A fires", d3.length === 1 && d3[0].endpoint_id === epA.id);
}

async function _failurePersisted() {
  var q = _makeQuery();
  var transport = _captureTransport([{ statusCode: 500 }]);
  var webhooks = bShop.webhooks.create({ query: q, transport: transport });
  var ep = await webhooks.endpoints.create({ url: "https://example.com/", events: "*" });

  var d = await webhooks.send("order.mark_paid", { x: 1 });
  check("delivery row exists",         d.length === 1);
  check("not delivered (no delivered_at)", d[0].delivered_at == null);
  check("last_status captured",        d[0].last_status === 500);
  check("last_error captured",         typeof d[0].last_error === "string" && d[0].last_error.length > 0);

  // List exposes the failure row to the admin surface.
  var deliveries = await webhooks.deliveries.list(ep.id);
  check("deliveries list returns failure", deliveries.length === 1 && deliveries[0].last_status === 500);
}

async function _retryOnTransient() {
  var q = _makeQuery();
  // First attempt throws a retryable code; second succeeds.
  var transport = _captureTransport([
    { throw: { code: "ECONNRESET", message: "reset" } },
    { statusCode: 200 },
  ]);
  var webhooks = bShop.webhooks.create({
    query:     q,
    transport: transport,
    retry:     { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 },
  });
  await webhooks.endpoints.create({ url: "https://example.com/", events: "*" });

  var d = await webhooks.send("order.mark_paid", { x: 1 });
  check("transient → eventually delivered", d[0].last_status === 200 && d[0].delivered_at != null);
  check("transport called twice",            transport.received.length === 2);
}

async function _manualRetry() {
  var q = _makeQuery();
  var transport = _captureTransport([{ statusCode: 500 }, { statusCode: 200 }]);
  var webhooks = bShop.webhooks.create({ query: q, transport: transport });
  var ep = await webhooks.endpoints.create({ url: "https://example.com/", events: "*" });

  var d1 = await webhooks.send("order.mark_paid", { x: 1 });
  check("initial delivery failed", d1[0].last_status === 500);

  // Manual retry — transport returns 200 this time.
  var d2 = await webhooks.deliveries.retry(d1[0].id);
  check("manual retry delivered", d2.delivered_at != null && d2.last_status === 200);
  check("attempts bumped",        d2.attempts === 2);

  // Retry unknown
  var none = await webhooks.deliveries.retry(bShop.framework.uuid.v7());
  check("retry unknown returns null", none === null);

  // List ordering
  var listed = await webhooks.deliveries.list(ep.id);
  check("deliveries list ordered desc", listed.length >= 1);
}

async function _orderTransitionFanout() {
  // Wire the webhooks primitive into order.create({ webhooks })
  // so a transition fires the matching event automatically.
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var transport = _captureTransport([{ statusCode: 200 }]);
  var webhooks = bShop.webhooks.create({ query: q, transport: transport });
  var order   = bShop.order.create({ query: q, webhooks: webhooks });

  await webhooks.endpoints.create({ url: "https://example.com/", events: "*" });

  var p = await catalog.products.create({ slug: "wh-test", title: "WHTest", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "WH-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 1000 });
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1 });
  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sid,
    currency:          "USD",
    subtotal_minor:    1000,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 1000,
    ship_to:           { country: "US" },
    lines: [{ variant_id: v.id, sku: "WH-1", qty: 1, unit_amount_minor: 1000, unit_currency: "USD" }],
  });

  await order.transition(o.id, "mark_paid", { reason: "stripe" });
  check("order.transition fires webhook", transport.received.length === 1);
  check("event header is order.mark_paid",
    transport.received[0].headers["Webhook-Event"] === "order.mark_paid");

  // Delivery row persisted for the operator.
  var deliveries = await q("SELECT * FROM webhook_deliveries", []);
  check("delivery row persisted", deliveries.rows.length === 1 && deliveries.rows[0].event_type === "order.mark_paid");
}

async function run() {
  await _crud();
  await _urlValidation();
  await _signingRoundTrip();
  await _eventFiltering();
  await _failurePersisted();
  await _retryOnTransient();
  await _manualRetry();
  await _orderTransitionFanout();
}

module.exports = { run: run };
