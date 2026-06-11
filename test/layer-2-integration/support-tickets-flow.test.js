"use strict";
/**
 * Support tickets — end-to-end HTTP integration of the customer intake
 * (/account/support) + the operator queue (/admin/support), wired over
 * ONE in-memory `node:sqlite` DB so a ticket a shopper raises is visible
 * to the operator the same request.
 *
 * Boots a single real `b.createApp` mounting BOTH the storefront and the
 * admin console against the shared store. As the signed-in customer it
 * raises a ticket, then asserts:
 *
 *   - the ticket appears in the customer's own list AND in the admin queue
 *     (and in the unassigned-triage view);
 *   - the operator replies + the customer sees the reply on their ticket;
 *   - the operator assigns the ticket + transitions it to resolved, and
 *     the ticket leaves the unassigned view;
 *   - a DIFFERENT signed-in customer cannot see the ticket (404) nor reply
 *     to it (404) — the IDOR / ownership defense;
 *   - a reply to a CLOSED ticket is refused (409, no append);
 *   - empty subject / body on intake is a clean 400 re-render, no leak.
 *
 * Every state-changing POST goes through the real double-submit CSRF gate
 * (the cookie jar captures the token and echoes it as X-CSRF-Token).
 * Statuses are asserted clean — no raw-error / stack leak in any body.
 *
 * Network: zero — every request lands on 127.0.0.1.
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

var TOKEN = "admin-token-0123456789abcdef-test"; // >= 16 chars

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql",
            "0004_shop_config.sql", "0047_support_tickets.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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

// The ticket id round-trips on the create redirect's Location:
// /account/support/<id>?ok=1 — pull it back out.
function _ticketIdFromLocation(loc) {
  var m = /\/account\/support\/([^?]+)/.exec(loc || "");
  return m ? decodeURIComponent(m[1]) : null;
}

function _noLeak(body) {
  body = body || "";
  return body.indexOf("at Object.") === -1 &&
         body.indexOf("TypeError") === -1 &&
         body.indexOf("    at ") === -1;
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "support-order" });
  var config    = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query });
  var supportTickets = bShop.supportTickets.create({ query: query, cursorSecret: "support-flow" });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-support-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        supportTickets: supportTickets, shop_name: "Support Shop",
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        supportTickets: supportTickets, shop_name: "Support Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // GET the intake form first — issues the double-submit CSRF cookie
    // into the jar so the subsequent POSTs carry a matching token (the
    // helper echoes the captured `csrf` cookie as X-CSRF-Token).
    var newForm = await helpers.httpRequest({ port: port, path: "/account/support/new", jar: buyerJar });
    check("new-ticket form -> 200",             newForm.status === 200);
    check("new-ticket form renders",            newForm.body.indexOf("Raise a support ticket") !== -1);

    // ---- bad input on intake -> clean 400 re-render, no leak ----------
    var badCreate = await helpers.httpRequest({
      port: port, path: "/account/support", method: "POST", jar: buyerJar,
      form: { customer_email: "buyer@example.com", subject: "  ", body: "", category: "other" },
    });
    check("empty subject/body -> 400",          badCreate.status === 400);
    check("bad intake re-renders the form",     badCreate.body.indexOf("Raise a support ticket") !== -1);
    check("bad intake leaks no raw error",      _noLeak(badCreate.body));
    // WCAG 3.3.1/3.3.3 — the rejected subject field is marked + wired (the
    // whitespace subject is the first field the validator rejects).
    check("bad intake -> subject aria-invalid",  badCreate.body.indexOf("aria-invalid=\"true\"") !== -1);
    check("bad intake -> subject error span",    badCreate.body.indexOf("id=\"support-err-subject\"") !== -1 && badCreate.body.indexOf("aria-describedby=\"support-err-subject\"") !== -1);
    check("clean new-ticket form no aria-invalid", newForm.body.indexOf("aria-invalid") === -1);

    // ---- raise a ticket as the signed-in customer ---------------------
    var created = await helpers.httpRequest({
      port: port, path: "/account/support", method: "POST", jar: buyerJar,
      form: {
        customer_email: "buyer@example.com",
        subject:        "Where is my order?",
        body:           "I placed an order three days ago and there's still no tracking.",
        category:       "order_issue",
      },
    });
    check("raise ticket -> 303",                created.status === 303);
    var ticketId = _ticketIdFromLocation(created.headers["location"]);
    check("create redirect carries ticket id",  !!ticketId);

    // The ticket is stamped with the SESSION customer id (pinned, not
    // read off the form).
    var persisted = await supportTickets.get(ticketId);
    check("ticket pinned to session customer",  persisted.customer_id === buyer);
    check("ticket starts in 'new'",             persisted.status === "new");

    // ---- it appears in the customer's own list ------------------------
    var custList = await helpers.httpRequest({ port: port, path: "/account/support", jar: buyerJar });
    check("customer list -> 200",               custList.status === 200);
    check("customer list shows the ticket",     custList.body.indexOf("Where is my order?") !== -1);

    // ---- and in the admin queue (HTML + JSON) + the unassigned view ---
    var adminJar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: adminJar });
    check("admin login -> 303",                 login.status === 303);

    var queueHtml = await helpers.httpRequest({ port: port, path: "/admin/support", jar: adminJar });
    check("admin queue -> 200",                 queueHtml.status === 200);
    check("admin queue shows the ticket",       queueHtml.body.indexOf("Where is my order?") !== -1);
    check("admin queue has status chips",       queueHtml.body.indexOf("order-filters") !== -1);

    var queueApi = await helpers.httpRequest({ port: port, path: "/admin/support", headers: bearer });
    check("admin queue API is JSON",            (queueApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var queueRows = JSON.parse(queueApi.body).rows;
    check("admin queue API lists the ticket",   queueRows.some(function (t) { return t.id === ticketId; }));

    var unassignedApi = await helpers.httpRequest({ port: port, path: "/admin/support?status=unassigned", headers: bearer });
    check("unassigned view lists the ticket",   JSON.parse(unassignedApi.body).rows.some(function (t) { return t.id === ticketId; }));

    // ---- IDOR: a different customer can't see or reply ----------------
    var strangerJar = helpers.cookieJar();
    strangerJar.capture({ "set-cookie": [helpers.authCookie(b, stranger)] });

    var foreignView = await helpers.httpRequest({ port: port, path: "/account/support/" + ticketId, jar: strangerJar });
    check("foreign ticket view -> 404",         foreignView.status === 404);
    check("foreign view leaks no raw error",    _noLeak(foreignView.body));

    var foreignReply = await helpers.httpRequest({
      port: port, path: "/account/support/" + ticketId + "/reply", method: "POST", jar: strangerJar,
      form: { body: "let me into this ticket" },
    });
    check("foreign reply -> 404",               foreignReply.status === 404);
    var afterForeign = await supportTickets.thread(ticketId);
    check("foreign reply appended nothing",     afterForeign.messages.length === 1);

    // ---- the owner can read the thread --------------------------------
    var ownerView = await helpers.httpRequest({ port: port, path: "/account/support/" + ticketId, jar: buyerJar });
    check("owner ticket view -> 200",           ownerView.status === 200);
    check("owner view shows the opening body",  ownerView.body.indexOf("three days ago") !== -1);

    // ---- operator replies; the customer sees it -----------------------
    var opReply = await helpers.httpRequest({
      port: port, path: "/admin/support/" + ticketId + "/reply", method: "POST", jar: adminJar,
      form: { body: "Thanks — your tracking number is on the way." },
    });
    check("operator reply -> 303",              opReply.status === 303);
    var afterOpReply = await supportTickets.get(ticketId);
    check("operator reply flips -> in_progress", afterOpReply.status === "in_progress");

    var ownerSees = await helpers.httpRequest({ port: port, path: "/account/support/" + ticketId, jar: buyerJar });
    check("customer sees the operator reply",   ownerSees.body.indexOf("tracking number is on the way") !== -1);

    // An operator INTERNAL note is never shown to the customer.
    var internalNote = await helpers.httpRequest({
      port: port, path: "/admin/support/" + ticketId + "/reply", method: "POST", jar: adminJar,
      form: { body: "VIP flag — escalate if it slips.", internal: "1" },
    });
    check("operator internal note -> 303",      internalNote.status === 303);
    var ownerAfterInternal = await helpers.httpRequest({ port: port, path: "/account/support/" + ticketId, jar: buyerJar });
    check("internal note hidden from customer", ownerAfterInternal.body.indexOf("VIP flag") === -1);

    // ---- operator assigns + transitions to resolved -------------------
    var operatorId = b.uuid.v7();
    var assign = await helpers.httpRequest({
      port: port, path: "/admin/support/" + ticketId + "/assign", method: "POST", jar: adminJar,
      form: { operator_id: operatorId },
    });
    check("assign -> 303",                       assign.status === 303);
    var assigned = await supportTickets.get(ticketId);
    check("assign set the operator",             assigned.assigned_operator_id === operatorId);

    // Assigned -> drops out of the unassigned view.
    var unassignedAfter = await helpers.httpRequest({ port: port, path: "/admin/support?status=unassigned", headers: bearer });
    check("assigned ticket leaves unassigned",   !JSON.parse(unassignedAfter.body).rows.some(function (t) { return t.id === ticketId; }));

    var resolve = await helpers.httpRequest({
      port: port, path: "/admin/support/" + ticketId + "/resolved", method: "POST", jar: adminJar,
      form: {},
    });
    check("transition to resolved -> 303",       resolve.status === 303);
    var resolved = await supportTickets.get(ticketId);
    check("ticket is resolved",                  resolved.status === "resolved");

    // ---- close the ticket; a customer reply is refused (409) ----------
    var close = await helpers.httpRequest({
      port: port, path: "/admin/support/" + ticketId + "/closed", method: "POST", jar: adminJar,
      form: {},
    });
    check("transition to closed -> 303",         close.status === 303);
    var closed = await supportTickets.get(ticketId);
    check("ticket is closed",                    closed.status === "closed");

    var replyClosed = await helpers.httpRequest({
      port: port, path: "/account/support/" + ticketId + "/reply", method: "POST", jar: buyerJar,
      form: { body: "are you still there?" },
    });
    check("reply to closed ticket -> 409",       replyClosed.status === 409);
    check("closed-reply leaks no raw error",     _noLeak(replyClosed.body));
    var afterClosedReply = await supportTickets.thread(ticketId);
    // 2 customer/operator-visible + 1 internal = 3 messages; the refused
    // closed reply appended nothing.
    check("closed reply appended nothing",       afterClosedReply.messages.length === 3);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };

// Allow direct invocation.
if (require.main === module) {
  _run().then(function () {
    console.log("OK — support-tickets-flow (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — support-tickets-flow: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
