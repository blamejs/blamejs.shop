"use strict";
/**
 * Order visibility console — the timeline panel, partial-refund UI, and the
 * operator inbox on the admin order surface (/admin/orders/:id + /admin/inbox).
 * Boots one b.createApp with admin.mount over an in-memory node:sqlite DB
 * loaded from the live migrations.
 *
 * Exercises:
 *   - TIMELINE: GET /admin/orders/:id renders a chronological event feed
 *     (FSM transitions + customer-service notes) only when the orderTimeline
 *     primitive is wired; a note body carrying an XSS payload is ESCAPED.
 *   - PARTIAL REFUND: the order detail renders the Refunds panel with a
 *     decimal-amount form capped at the remaining balance; a partial slice
 *     records a refund row WITHOUT clearing the FSM state and shrinks the
 *     refundable balance; a slice that exactly clears the balance drives the
 *     terminal `refunded` state. Amounts are parsed through b.money (exact
 *     minor units, no float).
 *   - OVER-REFUND: a slice larger than the remaining balance is REFUSED
 *     (422 on the JSON API; a clean operator notice on the HTML path) with
 *     NOTHING sent to the payment provider — the race/over-refund guard.
 *   - RACE: a double-submit of the same partial slice reuses one provider
 *     refund (idempotency key) rather than refunding twice.
 *   - INBOX: a role-broadcast message surfaces on /admin/inbox with a navbar
 *     unread badge; mark-read clears the badge; archive drops it from the feed.
 *   - AUTH: the anon path falls to the login form, never leaking detail.
 *
 * Network: zero — every request lands on 127.0.0.1; the payment provider is a
 * local fake that records its calls.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-ordervis";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql", "0037_order_notes.sql", "0175_operator_inbox.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  var q = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  q._db = db;
  return q;
}

function _post(port, path, jar, form) {
  return helpers.httpRequest({ port: port, path: path, method: "POST", jar: jar, form: form });
}

// A paid order WITH a captured payment intent — the partial-refund path
// gates on payment_intent_id. Grand total 5998 minor (USD).
async function _seedPaidOrder(query) {
  var now = Date.now();
  var cartId = b.uuid.v7(), orderId = b.uuid.v7(), lineId = b.uuid.v7();
  var intent = "pi_test_" + orderId;
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, b.uuid.v7(), now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, " +
    "customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 5998, 0, 0, 0, 5998, ?4, '{\"country\":\"US\"}', NULL, ?5, ?5)",
    [orderId, cartId, b.uuid.v7(), intent, now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, 'WIDGET-1', 1, 5998, 'USD', 5998)",
    [lineId, orderId, b.uuid.v7()],
  );
  // An FSM init + mark_paid transition so the timeline has events to show.
  await query(
    "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
    "VALUES (?1, ?2, '__init__', 'pending', 'create', NULL, '{}', ?3)",
    [b.uuid.v7(), orderId, now - 2000],
  );
  await query(
    "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
    "VALUES (?1, ?2, 'pending', 'paid', 'mark_paid', 'stripe_succeeded', '{}', ?3)",
    [b.uuid.v7(), orderId, now - 1000],
  );
  return { orderId: orderId, intent: intent };
}

async function _run() {
  var query         = _makeQuery();
  var catalog       = bShop.catalog.create({ query: query });
  var order         = bShop.order.create({ query: query, cursorSecret: "ovis-order" });
  var config        = bShop.config.create({ query: query });
  var orderNotes    = bShop.orderNotes.create({ query: query, cursorSecret: "ovis-notes" });
  var orderTimeline = bShop.orderTimeline.create({ query: query, order: order, orderNotes: orderNotes });
  var operatorInbox = bShop.operatorInbox.create({ query: query, cursorSecret: "ovis-inbox" });

  // Fake payment provider — records each refund call so the over-refund
  // guard (no call) and the idempotency reuse are observable.
  var refundCalls = [];
  var payment = {
    refund: async function (input, idem) {
      refundCalls.push({ input: input, idem: idem });
      return { id: "re_" + refundCalls.length, amount: input.amount_minor };
    },
  };

  var seeded = await _seedPaidOrder(query);
  var base = "/admin/orders/" + encodeURIComponent(seeded.orderId);

  // A customer-service note so the timeline has a note event to render (and
  // an XSS payload to prove escape-by-default).
  var XSS = "<script>alert('tl-xss')</script>";
  await orderNotes.add({ order_id: seeded.orderId, author: "operator", visibility: "internal", body: XSS });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-ordervis-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        orderNotes: orderNotes, orderTimeline: orderTimeline, operatorInbox: operatorInbox, payment: payment,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- timeline panel ------------------------------------------------
    var detail = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("order detail then 200",               detail.status === 200);
    check("detail shows the Timeline panel",     detail.body.indexOf(">Timeline<") !== -1);
    check("timeline shows the paid event",       detail.body.indexOf("Payment received") !== -1);
    check("timeline shows the placed event",     detail.body.indexOf("Order placed") !== -1);
    check("timeline shows the internal note event", detail.body.indexOf("Internal note") !== -1);
    // XSS: the note body is escaped at render.
    check("timeline xss: no live <script>",      detail.body.indexOf("<script>alert('tl-xss')") === -1);
    check("timeline xss: entity-escaped",        detail.body.indexOf("&lt;script&gt;alert(") !== -1);

    // ---- refund panel renders the partial form -------------------------
    check("detail shows the Refunds panel",      detail.body.indexOf(">Refunds<") !== -1);
    check("refunds panel states the total",      detail.body.indexOf("Order total") !== -1);
    check("refunds form posts to /refund/partial", detail.body.indexOf(base + "/refund/partial\"") !== -1);

    // ---- over-refund is refused, NOTHING sent to the provider ----------
    var beforeCount = refundCalls.length;
    var over = await _post(port, base + "/refund/partial", jar, { amount: "100.00" });
    check("over-refund (HTML) redirect with err", over.status === 303 && (over.headers.location || "").indexOf("refund_err=") !== -1);
    check("over-refund did NOT call the provider", refundCalls.length === beforeCount);
    check("over-refund left the order paid",       (await order.get(seeded.orderId)).status === "paid");
    // Bearer JSON: an over-refund is a clean 422.
    var overApi = await helpers.httpRequest({
      port: port, path: base + "/refund/partial", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount: "999.99" }),
    });
    check("over-refund (bearer) then 422",       overApi.status === 422);
    check("over-refund (bearer) no provider call", refundCalls.length === beforeCount);

    // A non-numeric / bad-shape amount is a clean 400 (bearer), no call.
    var badApi = await helpers.httpRequest({
      port: port, path: base + "/refund/partial", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount: "abc" }),
    });
    check("bad amount (bearer) then 400",        badApi.status === 400);
    check("bad amount no provider call",          refundCalls.length === beforeCount);

    // ---- a partial slice records a refund WITHOUT clearing the state ---
    var partial = await _post(port, base + "/refund/partial", jar, { amount: "10.00" });
    check("partial refund then 303",             partial.status === 303);
    check("partial redirects refunded=1",        (partial.headers.location || "").indexOf("refunded=1") !== -1);
    check("partial called the provider once",    refundCalls.length === beforeCount + 1);
    check("partial provider amount is 1000 minor (exact)", refundCalls[refundCalls.length - 1].input.amount_minor === 1000);
    check("partial left the order paid (not refunded)", (await order.get(seeded.orderId)).status === "paid");
    check("partial recorded 1000 in the ledger",  (await order.refundedTotalMinor(seeded.orderId)) === 1000);

    // The detail now shows the running refunded total + a smaller balance.
    var afterPartial = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail reflects refunded $10.00",     afterPartial.body.indexOf("refunded $10.00") !== -1);
    check("detail reflects refundable $49.98",   afterPartial.body.indexOf("refundable $49.98") !== -1);

    // ---- idempotency key tracks the ledger ----------------------------
    // The provider idempotency key folds in the refunded-total SEEN at the
    // time of the slice: two submits that read the SAME prior total (a
    // double-click before the first records) derive the SAME key, so the
    // provider collapses them onto one charge — the over-refund / double-
    // refund guard. Conversely, two slices issued AFTER the ledger advanced
    // carry different prior-totals, hence different keys (genuinely distinct
    // refunds). The key shape is `refund:<order>:partial:<prior>:<amount>`.
    var keyCount = refundCalls.length;
    await _post(port, base + "/refund/partial", jar, { amount: "5.00" });   // prior total 1000
    await _post(port, base + "/refund/partial", jar, { amount: "5.00" });   // prior total 1500 (first recorded)
    var keyA = refundCalls[keyCount].idem;
    var keyB = refundCalls[keyCount + 1].idem;
    check("idempotency key encodes the prior-total",  /:partial:1000:500$/.test(keyA));
    check("a slice after the ledger advanced re-keys", /:partial:1500:500$/.test(keyB) && keyA !== keyB);
    check("a same-prior-total resubmit would re-use the key",
      ("refund:" + seeded.orderId + ":partial:1000:500") === keyA);

    // ---- a slice that clears the balance drives terminal refunded ------
    // Remaining now = 5998 - 1000 - 500 - 500 = 3998 minor = $39.98.
    var remaining = 5998 - (await order.refundedTotalMinor(seeded.orderId));
    check("remaining is 3998",                   remaining === 3998);
    var clearDecimal = (remaining / 100).toFixed(2);
    var final = await _post(port, base + "/refund/partial", jar, { amount: clearDecimal });
    check("balance-clearing refund then 303",    final.status === 303);
    check("balance-clearing drove terminal refunded", (await order.get(seeded.orderId)).status === "refunded");
    check("fully refunded total equals grand total", (await order.refundedTotalMinor(seeded.orderId)) === 5998);
    var fullyRefunded = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail says nothing remains to refund", fullyRefunded.body.indexOf("nothing remains to refund") !== -1);

    // ---- operator inbox + navbar badge ---------------------------------
    // Enqueue a role broadcast (as the new-order ping does) and confirm it
    // surfaces on /admin/inbox with a navbar unread badge.
    var msg = await operatorInbox.enqueueMessage({
      role: "fulfillment", kind: "order_paid", severity: "info",
      subject: "New order — $59.98", body: "Order " + seeded.orderId.slice(0, 8) + " was paid.",
    });
    var inbox = await helpers.httpRequest({ port: port, path: "/admin/inbox", jar: jar });
    check("inbox then 200",                      inbox.status === 200);
    check("inbox lists the message subject",     inbox.body.indexOf("New order — $59.98") !== -1);
    check("inbox shows mark-read action",        inbox.body.indexOf("/admin/inbox/" + encodeURIComponent(msg.id) + "/read") !== -1);
    // The navbar badge (rendered on every authed page) shows the unread count.
    var anyPage = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("navbar shows the unread badge",       anyPage.body.indexOf("nav-badge") !== -1);

    // Mark read clears the badge.
    var read = await _post(port, "/admin/inbox/" + encodeURIComponent(msg.id) + "/read", jar, {});
    check("mark-read then 303",                  read.status === 303);
    check("inbox unread count now zero",         (await operatorInbox.unreadCountForRole({ role: "fulfillment" })) === 0);
    var afterRead = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("navbar badge gone once read",         afterRead.body.indexOf("nav-badge") === -1);

    // Archive drops it from the active feed.
    var archive = await _post(port, "/admin/inbox/" + encodeURIComponent(msg.id) + "/archive", jar, {});
    check("archive then 303",                    archive.status === 303);
    var inboxAfter = await helpers.httpRequest({ port: port, path: "/admin/inbox", jar: jar });
    check("archived message gone from feed",     inboxAfter.body.indexOf("New order — $59.98") === -1);
    var inboxArchived = await helpers.httpRequest({ port: port, path: "/admin/inbox?archived=1", jar: jar });
    check("include-archived surfaces it",        inboxArchived.body.indexOf("New order — $59.98") !== -1);

    // A mark-read on an unknown id is a clean notice, never a 500.
    var unknown = await _post(port, "/admin/inbox/" + b.uuid.v7() + "/read", jar, {});
    check("unknown inbox id redirect err",       unknown.status === 303 && (unknown.headers.location || "").indexOf("err=1") !== -1);

    // ---- auth gate -----------------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: base });
    check("anon order detail → login form",      anon.body.indexOf("Admin API key") !== -1);
    var anonInbox = await helpers.httpRequest({ port: port, path: "/admin/inbox" });
    check("anon inbox → login form",             anonInbox.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
