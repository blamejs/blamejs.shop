"use strict";
/**
 * Returns refund — a malformed rma id must classify as 400 (bad request),
 * the SAME status its approve/received/reject siblings return for the same
 * id, not a self-contradictory 404 whose body is a "not a valid UUID"
 * message.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * returns), seeds a pending RMA, then drives the four sibling actions with
 * a malformed id ("zzz"):
 *
 *   - approve / received / reject  → 400 (unchanged baseline)
 *   - refund                       → 400 (the fix — was 404)
 *
 * A WELL-FORMED but nonexistent rma id still yields 404 from refund (a
 * genuine missing record), and the refund still works on the real id once
 * the RMA is in a refundable state.
 *
 * Network: zero.
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

var TOKEN = "admin-token-0123456789abcdef-refstatus";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
            "0004_shop_config.sql", "0023_returns.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _seedReturn(query, returns) {
  var now = Date.now();
  var cartId = b.uuid.v7(), orderId = b.uuid.v7(), lineId = b.uuid.v7();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, b.uuid.v7(), now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, " +
    "customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 5998, 0, 0, 0, 5998, NULL, '{}', NULL, ?4, ?4)",
    [orderId, cartId, b.uuid.v7(), now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, 'WIDGET-1', 1, 5998, 'USD', 5998)",
    [lineId, orderId, b.uuid.v7()],
  );
  var rma = await returns.request({
    order_id: orderId, reason: "defective",
    customer_notes: "Arrived cracked.",
    lines: [{ sku: "WIDGET-1", qty: 1, order_line_id: lineId }],
  });
  return { orderId: orderId, rmaId: rma.id };
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "refstatus" });
  var config  = bShop.config.create({ query: query });
  var returns = bShop.returns.create({ query: query, cursorSecret: "refstatus-rma" });

  var seeded = await _seedReturn(query, returns);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-refstatus-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, returns: returns, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

  function _post(action, id, body) {
    return helpers.httpRequest({
      port: port, path: "/admin/returns/" + id + "/" + action, method: "POST",
      headers: bearer, body: JSON.stringify(body || {}),
    });
  }

  try {
    // ---- malformed id "zzz": every action classifies it as 400 ----
    var approve = await _post("approve",  "zzz");
    var received = await _post("received", "zzz");
    var reject  = await _post("reject",   "zzz");
    var refund  = await _post("refund",   "zzz");
    check("approve(zzz) → 400",  approve.status === 400);
    check("received(zzz) → 400", received.status === 400);
    check("reject(zzz) → 400",   reject.status === 400);
    // The fix: refund now agrees with its siblings (was 404).
    check("refund(zzz) → 400 (was 404)", refund.status === 400);

    // The refund 400 body must NOT carry a self-contradictory not-found
    // shape — it's a bad request, classified the same as the siblings.
    check("refund(zzz) body not a 'return-not-found' problem",
      refund.body.indexOf("return-not-found") === -1);

    // ---- well-formed but nonexistent rma id still → 404 from refund ----
    var ghostId = b.uuid.v7();   // valid UUID, no such RMA row
    var ghost = await _post("refund", ghostId);
    check("refund(<valid-but-missing>) → 404", ghost.status === 404);
    check("ghost 404 is a return-not-found problem", ghost.body.indexOf("return-not-found") !== -1);

    // ---- the real id still walks approve → received → refund (record-only) ----
    var realApprove = await _post("approve", seeded.rmaId, { refund_amount_minor: 5998, refund_currency: "USD" });
    check("approve(real) → 200", realApprove.status === 200);
    var realReceived = await _post("received", seeded.rmaId);
    check("received(real) → 200", realReceived.status === 200);
    var realRefund = await _post("refund", seeded.rmaId);
    check("refund(real) → 200", realRefund.status === 200);
    var refunded = JSON.parse(realRefund.body);
    check("refund(real) moved the RMA to refunded", refunded.status === "refunded");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
