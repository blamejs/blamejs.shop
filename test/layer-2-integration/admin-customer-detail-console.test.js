"use strict";
/**
 * Customer detail console — the per-customer operator screen at
 * /admin/customers/:id, the action surface the roster (read-only list) never
 * had. Boots one b.createApp with admin.mount (token + catalog + order +
 * config + customers + storeCredit + customerNotes + customerSegments) over an
 * in-memory node:sqlite DB loaded from the live migrations.
 *
 * Exercises the consolidated per-customer surfaces from the console:
 *   - GET /admin/customers/:id renders the customer's identity + their recent
 *     orders (linked to the order page), HTML + bearer JSON, and the auth gate
 *   - STORE CREDIT: grant with a reason -> the balance changes and a ledger row
 *     records the reason; deduct with a reason; the bad paths (missing reason /
 *     non-integer amount / over-deduction) are clean 4xx/409 with NO change and
 *     no raw-error leak; the over-deduction is a 409 (route refuses before any
 *     write)
 *   - CUSTOMER NOTES: add a note -> it appears in the list; a blank body is a
 *     clean 4xx with nothing written
 *   - SEGMENTS: read-only membership reflects a recompute (the primitive has no
 *     per-customer manual assign — membership is rule-derived)
 *   - an unknown / malformed customer id -> a clean 404
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

var TOKEN = "admin-token-0123456789abcdef-custdetail";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql", "0006_customers.sql", "0205_customer_oauth_identities.sql",
  "0094_store_credit.sql", "0134_customer_notes.sql", "0049_customer_segments.sql",
  "0022_loyalty.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
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

function _post(port, path, jar, form, extraHeaders) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST", jar: jar, form: form,
    headers: extraHeaders || undefined,
  });
}

// A minimal valid order for a customer — createFromCart needs a cart_id +
// session_id (UUID-shaped), one line, totals, and a ship_to with a country.
// The orders FK references carts(id), so seed the cart row first.
async function _seedOrder(query, order, customerId) {
  var cartId = b.uuid.v7();
  var sessionId = b.uuid.v7();
  var now = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionId, customerId, now, now + 86400000],
  );
  return order.createFromCart({
    cart_id:           cartId,
    session_id:        sessionId,
    customer_id:       customerId,
    lines:             [{ variant_id: b.uuid.v7(), sku: "SKU-1", qty: 1, unit_amount_minor: 1000 }],
    currency:          "USD",
    subtotal_minor:    1000,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 1000,
    ship_to:           { country: "US" },
  });
}

async function _run() {
  var query            = _makeQuery();
  var catalog          = bShop.catalog.create({ query: query });
  var order            = bShop.order.create({ query: query, cursorSecret: "cust-detail-order" });
  var config           = bShop.config.create({ query: query });
  var customers        = bShop.customers.create({ query: query, cursorSecret: "cust-detail-customers" });
  var storeCredit      = bShop.storeCredit.create({ query: query });
  var customerNotes    = bShop.customerNotes.create({ query: query, cursorSecret: "cust-detail-notes" });
  var customerSegments = bShop.customerSegments.create({ query: query, cursorSecret: "cust-detail-segments" });
  var loyalty          = bShop.loyalty.create({ query: query });

  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Anderson" });
  // Two orders so the detail screen's recent-orders panel renders linked rows.
  var ord1 = await _seedOrder(query, order, alice.id);
  await _seedOrder(query, order, alice.id);
  await loyalty.ensureAccount(alice.id);

  // A segment Alice qualifies for after a recompute — proves read-only
  // membership reflects the rule-derived cache (the primitive has no manual
  // per-customer assign).
  await customerSegments.defineSegment({
    slug: "any-buyer", title: "Any buyer", rules: { lifetime_orders_min: 1 },
  });
  await customerSegments.recompute({ slugs: ["any-buyer"] });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-cust-detail-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        customers: customers, storeCredit: storeCredit, customerNotes: customerNotes,
        customerSegments: customerSegments, loyalty: loyalty,
      });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var base = "/admin/customers/" + encodeURIComponent(alice.id);

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- detail: record + recent orders --------------------------------
    var roster = await helpers.httpRequest({ port: port, path: "/admin/customers", jar: jar });
    check("roster links to the detail",         roster.body.indexOf(base) !== -1);

    var detail = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail then 200",                    detail.status === 200);
    check("detail shows the customer name",     detail.body.indexOf("Alice Anderson") !== -1);
    check("detail shows the customer id",       detail.body.indexOf(alice.id) !== -1);
    check("detail links a recent order",        detail.body.indexOf("/admin/orders/" + encodeURIComponent(ord1.id)) !== -1);
    check("detail shows the store-credit panel", detail.body.indexOf("Store credit") !== -1 && detail.body.indexOf("/store-credit\"") !== -1);
    check("detail shows the notes panel",       detail.body.indexOf(">Notes<") !== -1 && detail.body.indexOf("/notes\"") !== -1);
    check("detail shows segment membership",    detail.body.indexOf("Any buyer") !== -1);
    check("detail shows the loyalty panel",     detail.body.indexOf(">Loyalty<") !== -1);

    var detailApi = await helpers.httpRequest({ port: port, path: base, headers: bearer });
    check("detail API JSON",                    (detailApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var detailJson = JSON.parse(detailApi.body);
    check("detail API carries the customer",    detailJson.customer.id === alice.id);
    check("detail API carries recent orders",   Array.isArray(detailJson.recent_orders) && detailJson.recent_orders.length === 2);
    check("detail API omits raw email",         detailJson.customer.email == null && typeof detailJson.customer.email_hash === "string");

    // ---- store credit: grant with a reason -----------------------------
    var balBefore = await storeCredit.balance(alice.id);
    check("credit starts at zero",              balBefore.balance_minor === 0);
    var grant = await _post(port, base + "/store-credit", jar, {
      direction: "grant", amount_minor: "2500", reason: "goodwill for the late delivery",
    });
    check("grant then 303",                     grant.status === 303);
    check("grant redirects saved",              (grant.headers.location || "").indexOf("saved=1") !== -1);
    var balAfterGrant = await storeCredit.balance(alice.id);
    check("grant credited 2500 minor",          balAfterGrant.balance_minor === 2500);

    // The grant is recorded in the ledger WITH the reason in source_ref.
    var hist = await storeCredit.history({ customer_id: alice.id, limit: 10 });
    var creditRow = hist.rows.filter(function (h) { return h.kind === "credit"; })[0];
    check("ledger recorded the credit",         !!creditRow && creditRow.amount_minor === 2500);
    check("ledger row carries the reason",      creditRow.source_ref === "goodwill for the late delivery");
    check("ledger row source is goodwill",      creditRow.source === "goodwill");
    var detailAfterGrant = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail shows the new balance",       detailAfterGrant.body.indexOf("$25.00") !== -1);
    check("detail shows the reason in ledger",  detailAfterGrant.body.indexOf("goodwill for the late delivery") !== -1);

    // ---- store credit: deduct with a reason ----------------------------
    var deduct = await _post(port, base + "/store-credit", jar, {
      direction: "deduct", amount_minor: "1000", reason: "correcting an over-credit",
    });
    check("deduct then 303",                    deduct.status === 303);
    var balAfterDeduct = await storeCredit.balance(alice.id);
    check("deduct removed 1000 minor",          balAfterDeduct.balance_minor === 1500);
    var histAfterDeduct = await storeCredit.history({ customer_id: alice.id, limit: 10 });
    var expireRow = histAfterDeduct.rows.filter(function (h) { return h.kind === "expire"; })[0];
    check("deduct recorded an expire row",      !!expireRow && expireRow.amount_minor === 1000);
    check("deduct row carries the reason",      expireRow.source_ref === "correcting an over-credit");

    // ---- bad store-credit writes: clean 4xx, no change -----------------
    // (1) missing reason.
    var noReason = await _post(port, base + "/store-credit", jar, {
      direction: "grant", amount_minor: "500",
    });
    check("missing reason then 303 redirect",   noReason.status === 303);
    check("missing reason surfaces err",        (noReason.headers.location || "").indexOf("credit_err=") !== -1);
    check("missing reason: no balance change",  (await storeCredit.balance(alice.id)).balance_minor === 1500);

    // (2) non-integer amount.
    var badAmount = await _post(port, base + "/store-credit", jar, {
      direction: "grant", amount_minor: "12.5", reason: "x",
    });
    check("non-integer amount redirect err",    badAmount.status === 303 && (badAmount.headers.location || "").indexOf("credit_err=") !== -1);
    check("non-integer amount: no change",      (await storeCredit.balance(alice.id)).balance_minor === 1500);

    // (3) over-deduction (balance 1500, deduct 9999) -> 409 on the JSON path,
    // clean redirect-with-error on the browser path, NO change either way.
    var overApi = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ direction: "deduct", amount_minor: 9999, reason: "too much" }),
    });
    check("over-deduction API then 409",        overApi.status === 409);
    check("over-deduction API no change",       (await storeCredit.balance(alice.id)).balance_minor === 1500);
    var overHtml = await _post(port, base + "/store-credit", jar, {
      direction: "deduct", amount_minor: "9999", reason: "too much",
    });
    check("over-deduction HTML redirect err",   overHtml.status === 303 && (overHtml.headers.location || "").indexOf("credit_err=") !== -1);
    check("over-deduction HTML no change",       (await storeCredit.balance(alice.id)).balance_minor === 1500);

    // No bad path leaked a raw primitive/SQL string into the redirect target.
    [noReason, badAmount, overHtml].forEach(function (resp, idx) {
      var loc = resp.headers.location || "";
      check("bad credit #" + idx + " leaks no SQL", loc.indexOf("SQLITE") === -1 && loc.indexOf("constraint") === -1);
      check("bad credit #" + idx + " leaks no internal prefix", loc.indexOf("storeCredit") === -1 && loc.indexOf("admin.") === -1);
    });

    // ---- bearer JSON: a grant on the API path --------------------------
    var apiGrant = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ direction: "grant", amount_minor: 700, reason: "api goodwill" }),
    });
    check("bearer grant 200 JSON",              apiGrant.status === 200);
    check("bearer grant applied",               (await storeCredit.balance(alice.id)).balance_minor === 2200);
    var apiNoReason = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ direction: "grant", amount_minor: 700 }),
    });
    check("bearer grant missing reason then 400", apiNoReason.status === 400);
    check("bearer missing reason: no change",   (await storeCredit.balance(alice.id)).balance_minor === 2200);

    // ---- customer notes: add a note ------------------------------------
    var addNote = await _post(port, base + "/notes", jar, {
      kind: "preference", body: "VIP — comp shipping where possible",
    });
    check("add note then 303",                  addNote.status === 303);
    var notesAfter = await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10 });
    check("note persisted",                     notesAfter.rows.length === 1 && notesAfter.rows[0].body === "VIP — comp shipping where possible");
    check("note author is operator",            notesAfter.rows[0].author === "operator");
    var detailAfterNote = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail lists the new note",          detailAfterNote.body.indexOf("VIP — comp shipping where possible") !== -1);

    // A blank-body note is a clean 4xx with nothing written.
    var blankNote = await _post(port, base + "/notes", jar, { kind: "general", body: "" });
    check("blank note redirect err",            blankNote.status === 303 && (blankNote.headers.location || "").indexOf("note_err=") !== -1);
    check("blank note: still one note",         (await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10 })).rows.length === 1);

    // ---- unknown / malformed customer id -> clean 404 ------------------
    var unknownId = b.uuid.v7();
    var unknown = await helpers.httpRequest({ port: port, path: "/admin/customers/" + unknownId, jar: jar });
    check("unknown id then 404",                unknown.status === 404);
    check("unknown id shows not-found",         unknown.body.indexOf("Customer not found") !== -1);
    var unknownApi = await helpers.httpRequest({ port: port, path: "/admin/customers/" + unknownId, headers: bearer });
    check("unknown id API then 404",            unknownApi.status === 404);
    var malformed = await helpers.httpRequest({ port: port, path: "/admin/customers/not-a-uuid", jar: jar });
    check("malformed id then 404 (not 500)",    malformed.status === 404);
    var malformedGrant = await _post(port, "/admin/customers/not-a-uuid/store-credit", jar, {
      direction: "grant", amount_minor: "500", reason: "x",
    });
    check("malformed id write then 404 (not 500)", malformedGrant.status === 404);

    // ---- auth gate -----------------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: base });
    check("anon detail → login form",           anon.body.indexOf("Admin API key") !== -1);
    check("anon detail does not leak the name", anon.body.indexOf("Alice Anderson") === -1);
    var anonGrant = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      form: { direction: "grant", amount_minor: "500", reason: "x" },
    });
    check("anon grant does not 5xx",            anonGrant.status < 500);
    check("anon grant did not apply",           (await storeCredit.balance(alice.id)).balance_minor === 2200);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
