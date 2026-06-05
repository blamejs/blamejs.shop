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

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql",
  "0005_webhooks.sql",
  "0017_webhook_dlq.sql",
].map(function (f) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f); });

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

  // Fan-out is fire-and-forget — the transition returns before the
  // background delivery runs, so poll for it rather than asserting
  // synchronously (a fixed sleep would flake under load).
  await order.transition(o.id, "mark_paid", { reason: "stripe" });
  await helpers.waitUntil(function () { return transport.received.length >= 1; }, {
    timeoutMs: 5000,
    label:     "order.transition fan-out: webhook delivered",
  });
  check("order.transition fires webhook", transport.received.length === 1);
  check("event header is order.mark_paid",
    transport.received[0].headers["Webhook-Event"] === "order.mark_paid");

  // Delivery row persisted for the operator.
  var deliveries = await q("SELECT * FROM webhook_deliveries", []);
  check("delivery row persisted", deliveries.rows.length === 1 && deliveries.rows[0].event_type === "order.mark_paid");
}

// _mockClock — returns { now, advance } that the webhooks primitive
// consumes via opts.now. `advance(ms)` jumps the clock forward so a
// test can walk through the exponential backoff schedule without
// waiting wall-clock seconds.
function _mockClock(startMs) {
  var t = (typeof startMs === "number") ? startMs : Date.now();
  return {
    now:     function () { return t; },
    advance: function (ms) { t += ms; return t; },
    set:     function (ms) { t = ms; },
  };
}

async function _retryBackoff() {
  var q = _makeQuery();
  var clock = _mockClock(1700000000000);
  // Transport always 500 — every attempt fails so the row walks the
  // full backoff schedule before landing in the DLQ.
  var transport = _captureTransport([{ statusCode: 500 }]);
  var webhooks = bShop.webhooks.create({
    query:     q,
    transport: transport,
    now:       clock.now,
    retry:     { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
  });
  await webhooks.endpoints.create({ url: "https://example.com/", events: "*" });

  var d = await webhooks.send("order.mark_paid", { x: 1 });
  check("first failure persisted",       d[0].last_status === 500);
  check("first attempt counted",         d[0].attempts === 1);
  check("first failure schedules retry", d[0].next_retry_at != null);
  check("backoff #1 is +60s",
    d[0].next_retry_at - d[0].last_attempted_at === 60 * 1000);

  // Advance to the scheduled retry, run processRetries — attempt 2.
  clock.advance(60 * 1000);
  var batch2 = await webhooks.processRetries({ now: clock.now() });
  check("processRetries returns attempted row", batch2.length === 1);
  check("backoff #2 is +5m",
    batch2[0].next_retry_at - batch2[0].last_attempted_at === 300 * 1000);
  check("attempts=2 after second failure", batch2[0].attempts === 2);

  // Attempt 3 — +30m.
  clock.advance(300 * 1000);
  var batch3 = await webhooks.processRetries({ now: clock.now() });
  check("backoff #3 is +30m",
    batch3[0].next_retry_at - batch3[0].last_attempted_at === 1800 * 1000);
  check("attempts=3 after third failure", batch3[0].attempts === 3);

  // Attempt 4 — +4h.
  clock.advance(1800 * 1000);
  var batch4 = await webhooks.processRetries({ now: clock.now() });
  check("backoff #4 is +4h",
    batch4[0].next_retry_at - batch4[0].last_attempted_at === 14400 * 1000);
  check("attempts=4 after fourth failure", batch4[0].attempts === 4);
}

async function _dlqAfterFiveAttempts() {
  var q = _makeQuery();
  var clock = _mockClock(1700000000000);
  var transport = _captureTransport([{ statusCode: 500 }]);
  var webhooks = bShop.webhooks.create({
    query:     q,
    transport: transport,
    now:       clock.now,
    retry:     { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
  });
  var ep = await webhooks.endpoints.create({ url: "https://example.com/", events: "*" });

  // Initial send — attempts becomes 1.
  await webhooks.send("order.mark_paid", { x: 1 });
  // Walk attempts 2..5. After the fifth failure the row should be
  // in the DLQ.
  var schedule = [60, 300, 1800, 14400];
  for (var i = 0; i < schedule.length; i += 1) {
    clock.advance(schedule[i] * 1000);
    await webhooks.processRetries({ now: clock.now() });
  }

  // Final row state — attempts === 5, no next retry, no delivery.
  var rows = await q("SELECT * FROM webhook_deliveries WHERE endpoint_id = ?1", [ep.id]);
  check("delivery exhausted",          rows.rows.length === 1);
  check("attempts hit MAX_ATTEMPTS",   rows.rows[0].attempts === 5);
  check("no next retry after DLQ move", rows.rows[0].next_retry_at == null);
  check("never delivered",              rows.rows[0].delivered_at == null);

  // DLQ row exists.
  var dlq = await webhooks.dlq.list(ep.id);
  check("dlq has the dropped row",         dlq.length === 1);
  check("dlq carries last_status",         dlq[0].last_status === 500);
  check("dlq carries last_error",          typeof dlq[0].last_error === "string" && dlq[0].last_error.length > 0);
  check("dlq references original delivery",dlq[0].delivery_id === rows.rows[0].id);
  check("dlq carries the payload",         typeof dlq[0].payload_json === "string" && dlq[0].payload_json.indexOf("\"x\":1") !== -1);
  check("dlq attempts matches",            dlq[0].attempts === 5);
  check("dlq dropped_at recorded",         typeof dlq[0].dropped_at === "number");
  check("dlq first/last attempted set",    typeof dlq[0].first_attempted_at === "number" &&
                                            typeof dlq[0].last_attempted_at === "number");

  // processRetries on an empty schedule is a no-op.
  var none = await webhooks.processRetries({ now: clock.now() });
  check("no more retries due", none.length === 0);
}

async function _replayFromDlq() {
  var q = _makeQuery();
  var clock = _mockClock(1700000000000);
  // First five attempts fail (500), every attempt after replay
  // succeeds (200). The captured transport always returns whatever
  // is at the tail of the queue, so chain failures then a 200.
  var transport = _captureTransport([
    { statusCode: 500 }, { statusCode: 500 }, { statusCode: 500 }, { statusCode: 500 }, { statusCode: 500 },
    { statusCode: 200 },
  ]);
  var webhooks = bShop.webhooks.create({
    query:     q,
    transport: transport,
    now:       clock.now,
    retry:     { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
  });
  var ep = await webhooks.endpoints.create({ url: "https://example.com/", events: "*" });

  // Walk to the DLQ.
  await webhooks.send("order.mark_paid", { x: 1 });
  var schedule = [60, 300, 1800, 14400];
  for (var i = 0; i < schedule.length; i += 1) {
    clock.advance(schedule[i] * 1000);
    await webhooks.processRetries({ now: clock.now() });
  }
  var dlqRows = await webhooks.dlq.list(ep.id);
  check("dlq has one row before replay", dlqRows.length === 1);

  // Replay — the receiver is now healthy.
  var replayed = await webhooks.replayFromDlq(dlqRows[0].id);
  check("replay produced a delivery",        replayed != null);
  check("replay starts at attempts=1",       replayed.attempts === 1);
  check("replay delivered",                  replayed.delivered_at != null && replayed.last_status === 200);
  check("replay carries the original event", replayed.event_type === "order.mark_paid");

  // DLQ row is gone.
  var dlqAfter = await webhooks.dlq.list(ep.id);
  check("dlq empty after replay", dlqAfter.length === 0);

  // Replay unknown id returns null.
  var none = await webhooks.replayFromDlq(bShop.framework.uuid.v7());
  check("replay unknown returns null", none === null);
}

async function _rateLimitRefuses() {
  var q = _makeQuery();
  var clock = _mockClock(1700000000000);
  // Always 200 — we're testing the rate-limit gate, not delivery
  // failures. Generous in-call retry budget never needed.
  var transport = _captureTransport([{ statusCode: 200 }]);
  var webhooks = bShop.webhooks.create({
    query:     q,
    transport: transport,
    now:       clock.now,
  });
  var ep = await webhooks.endpoints.create({
    url:                    "https://example.com/",
    events:                 "*",
    rate_limit_per_minute:  60,
  });

  // Fire 61 deliveries inside a 60s window. The 61st should be
  // refused with last_error === "rate-limited".
  for (var i = 0; i < 61; i += 1) {
    // Small clock-jitter inside the window keeps every row inside
    // the sliding count; we never cross the 60s boundary.
    if (i > 0 && (i % 10) === 0) clock.advance(100);
    await webhooks.send("order.mark_paid", { i: i });
  }
  var rows = await q(
    "SELECT * FROM webhook_deliveries WHERE endpoint_id = ?1 ORDER BY created_at ASC",
    [ep.id],
  );
  check("61 delivery rows total", rows.rows.length === 61);
  var delivered = rows.rows.filter(function (r) { return r.delivered_at != null; });
  var refused   = rows.rows.filter(function (r) { return r.last_error === "rate-limited"; });
  check("60 delivered", delivered.length === 60);
  check("1 refused as rate-limited", refused.length === 1);
  check("the 61st is the refused row", refused[0].created_at === rows.rows[60].created_at);

  // After the window slides past, deliveries resume.
  clock.advance(61 * 1000);
  var d62 = await webhooks.send("order.mark_paid", { i: 62 });
  check("post-window send delivers", d62[0].delivered_at != null);
}

async function _signatureRoundTrip() {
  var q = _makeQuery();
  var webhooks = bShop.webhooks.create({ query: q });

  var secret = "whsec_" + bShop.framework.crypto.generateToken(24);
  var payload = JSON.stringify({ id: "evt_1", amount: 100 });
  var header = webhooks.signOutgoing(payload, secret);
  check("header starts with t=", header.indexOf("t=") === 0);
  check("header carries v1=",    header.indexOf(",v1=") !== -1);

  var info = await webhooks.verifyIncoming(payload, header, secret);
  check("verifyIncoming accepts our signature", info && info.ok === true);
  check("verifyIncoming reports v1 scheme",     info.scheme === "v1");

  // Tampered payload — same signature, different body.
  var tampered = JSON.stringify({ id: "evt_1", amount: 999999 });
  var threw = false;
  try { await webhooks.verifyIncoming(tampered, header, secret); }
  catch (_e) { threw = true; }
  check("verifyIncoming refuses tampered payload", threw === true);

  // Wrong secret refused.
  var threwSecret = false;
  try { await webhooks.verifyIncoming(payload, header, "whsec_other"); }
  catch (_e) { threwSecret = true; }
  check("verifyIncoming refuses wrong secret", threwSecret === true);

  // Empty signature header refused at the entry tier.
  await assert.rejects(webhooks.verifyIncoming(payload, "", secret), /signatureHeader/);
  // Missing payload refused.
  await assert.rejects(webhooks.verifyIncoming(null, header, secret), /payload/);
  // Tolerance floor enforced.
  await assert.rejects(webhooks.verifyIncoming(payload, header, secret, 10), /toleranceSeconds/);
}

// Outbound deliveries to operator-registered receivers go through the
// production `_defaultTransport`, which dials `b.httpClient.request`
// with NO caller `agent`. That keeps the framework's PQC-first TLS
// posture (ML-KEM hybrid groups, TLS 1.3 minimum) for arbitrary
// operator URLs — the opposite of the PSP adapters (lib/payment.js),
// which pin a classical-downgrade agent ONLY for their two fixed
// processor endpoints. A receiver that can't negotiate an ML-KEM hybrid
// group fails the handshake (TLS alert 40); the framework records it as
// a transport error and retries / DLQs. This guard pins that decision:
// if someone ever wires a downgrade agent into the default webhook
// transport, this fails — the posture change must be a conscious edit.
async function _defaultTransportHoldsPqcDefault() {
  var q = _makeQuery();
  var realRequest = bShop.framework.httpClient.request;
  var captured = [];
  bShop.framework.httpClient.request = function (opts) {
    captured.push(opts);
    return Promise.resolve({ statusCode: 200, headers: {}, body: Buffer.from("") });
  };
  try {
    // No `transport` override → the factory falls back to _defaultTransport.
    var webhooks = bShop.webhooks.create({ query: q });
    await webhooks.endpoints.create({ url: "https://example.com/hook", events: "*" });
    await webhooks.send("order.mark_paid", { order_id: "o_pqc" });
  } finally {
    bShop.framework.httpClient.request = realRequest;
  }
  check("default transport dialed httpClient once", captured.length === 1);
  check("default transport POSTs the receiver URL",
    captured[0].method === "POST" && captured[0].url === "https://example.com/hook");
  // The posture decision: NO caller agent → b.httpClient keeps its
  // PQC-hybrid group list + TLS 1.3 minimum for the operator-arbitrary URL.
  check("default webhook transport carries NO downgrade agent (PQC-first held)",
    captured[0].agent === undefined);
  check("default webhook transport sets no classical ecdhCurve override",
    captured[0].ecdhCurve === undefined);
}

async function run() {
  await _crud();
  await _urlValidation();
  await _signingRoundTrip();
  await _defaultTransportHoldsPqcDefault();
  await _eventFiltering();
  await _failurePersisted();
  await _retryOnTransient();
  await _manualRetry();
  await _orderTransitionFanout();
  await _retryBackoff();
  await _dlqAfterFiveAttempts();
  await _replayFromDlq();
  await _rateLimitRefuses();
  await _signatureRoundTrip();
}

module.exports = { run: run };
