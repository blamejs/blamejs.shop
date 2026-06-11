"use strict";
/**
 * Return-shipping labels — end-to-end HTTP integration of the OPERATOR
 * surface: the admin console issues a prepaid return label against an
 * approved return and posts carrier tracking updates, and those writes
 * are the same rows the customer return-status page reads.
 *
 * Wired over ONE in-memory `node:sqlite` DB loaded from the live
 * migrations (returns + return_labels), with BOTH the admin console
 * (admin.mount) and the customer storefront (storefront.mount) mounted on
 * the same app against the same DB — so a label the operator issues on
 * /admin/returns/:id is the same row the shopper downloads on
 * /account/returns/:id/label. This closes the loop the customer-view test
 * sets up by hand: here the operator action itself produces the label.
 *
 * Asserts:
 *   - the admin return detail for an APPROVED return offers an Issue-label
 *     form (and a non-approved return does not);
 *   - issuing with valid input persists the label, re-renders the detail
 *     with the carrier + tracking + timeline, AND the customer can now see
 *     and download it on the storefront (the cross-surface check);
 *   - issuing on a NON-approved return is a clean 4xx and writes nothing;
 *   - bad input (missing tracking, a non-https label_url) is a clean 4xx
 *     and writes nothing;
 *   - a mark-shipped tracking update appends an event the customer timeline
 *     renders, and the legal next actions advance with the FSM;
 *   - an action against an unknown / malformed RETURN id 404s (not 400 —
 *     the coded-error ordering), never a 500;
 *   - no body leaks a raw error / stack on any path.
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

var TOKEN = "admin-token-0123456789abcdef-test"; // ≥ 16 chars

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql",
            "0004_shop_config.sql", "0023_returns.sql", "0052_return_labels.sql"]
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

// Seed a paid order with one line for `customerId`. Returns the order id +
// the order_line id.
async function _seedOrder(query, customerId, variantId, sku) {
  var now = Date.now();
  var cartId = b.uuid.v7(); var orderId = b.uuid.v7(); var lineId = b.uuid.v7();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 2999, 0, 0, 0, 2999, NULL, '{}', ?5, ?5)",
    [orderId, cartId, customerId, b.uuid.v7(), now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 2999, 'USD', 2999)",
    [lineId, orderId, variantId, sku],
  );
  return { orderId: orderId, lineId: lineId };
}

function _noLeak(body) {
  body = body || "";
  return body.indexOf("at Object.") === -1 &&
         body.indexOf("TypeError") === -1 &&
         body.indexOf("    at ") === -1;
}

async function _run() {
  var query        = _makeQuery();
  var catalog      = bShop.catalog.create({ query: query });
  var cart         = bShop.cart.create({ query: query, catalog: catalog });
  var order        = bShop.order.create({ query: query, cursorSecret: "arl-order" });
  var config       = bShop.config.create({ query: query });
  var customers     = bShop.customers.create({ query: query });
  var returns      = bShop.returns.create({ query: query, cursorSecret: "arl-returns" });
  var returnLabels = bShop.returnLabels.create({ query: query, returns: returns });

  var product = await catalog.products.create({ slug: "tee", title: "Tee", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "TEE-L", options: { size: "L" } });

  var buyer  = b.uuid.v7();
  var seeded = await _seedOrder(query, buyer, variant.id, variant.sku);

  // An APPROVED return — issueLabel accepts only this status.
  var approvedReq = await returns.request({
    order_id: seeded.orderId, customer_id: buyer, reason: "defective",
    lines: [{ order_line_id: seeded.lineId, sku: variant.sku, qty: 1 }],
  });
  var approvedId = approvedReq.id;
  await returns.approve(approvedId, { refund_amount_minor: 2999, refund_currency: "USD", operator_notes: "ok" });

  // A second return left PENDING — issuing a label on it must be refused.
  var pendingReq = await returns.request({
    order_id: seeded.orderId, customer_id: buyer, reason: "no-longer-needed",
    lines: [{ order_line_id: seeded.lineId, sku: variant.sku, qty: 1 }],
  });
  var pendingId = pendingReq.id;

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-arl-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        returns: returns, returnLabels: returnLabels, shop_name: "Audit Shop",
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers, config: config,
        returns: returns, returnLabels: returnLabels, shop_name: "Audit Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  var CARRIER_URL = "https://labels.example.com/return-zzz999.pdf";
  var TRACKING    = "9400111202509000000111";

  try {
    // ---- operator signs in --------------------------------------------
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login -> 303",                  login.status === 303);

    // ---- approved return detail offers the Issue-label form -----------
    var detail0 = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId, jar: jar });
    check("approved detail -> 200",              detail0.status === 200);
    check("approved detail offers Issue label",  detail0.body.indexOf("Issue return label") !== -1);
    check("approved detail has a label_url field", detail0.body.indexOf("name=\"label_url\"") !== -1);
    check("detail0 leaks no raw error",          _noLeak(detail0.body));

    // A pending return shows no issue-label form (issueLabel would refuse).
    var pendingDetail = await helpers.httpRequest({ port: port, path: "/admin/returns/" + pendingId, jar: jar });
    check("pending detail -> 200",               pendingDetail.status === 200);
    check("pending detail has no issue form",     pendingDetail.body.indexOf("Issue return label") === -1);
    check("pending detail explains the gate",     pendingDetail.body.indexOf("once this return is approved") !== -1);

    // ---- bad input is a clean 4xx, nothing issued ---------------------
    // Missing tracking number.
    var badMissing = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label",
      method: "POST", jar: jar, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: CARRIER_URL, cost_minor: "795", currency: "USD",
      } });
    check("missing-tracking issue -> 303 err",   badMissing.status === 303 && (badMissing.headers.location || "").indexOf("err=1") !== -1);
    check("nothing issued after bad input",      (await returnLabels.labelForReturn(approvedId)) == null);

    // A non-https label_url is refused by the primitive's b.safeUrl gate.
    var badUrl = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label",
      method: "POST", jar: jar, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: "http://labels.example.com/x.pdf", tracking_number: TRACKING, cost_minor: "795", currency: "USD",
      } });
    check("non-https label_url -> 303 err",      badUrl.status === 303 && (badUrl.headers.location || "").indexOf("err=1") !== -1);
    check("nothing issued after non-https url",  (await returnLabels.labelForReturn(approvedId)) == null);

    // The bearer JSON path surfaces a clean 4xx (not a 5xx) for the same.
    var badUrlApi = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label",
      method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: "javascript:alert(1)", tracking_number: TRACKING, cost_minor: "795", currency: "USD",
      } });
    check("API non-https label_url -> 4xx",      badUrlApi.status >= 400 && badUrlApi.status < 500);
    check("API bad-url leaks no raw error",      _noLeak(badUrlApi.body));

    // ---- issuing on a NON-approved return is refused, nothing issued --
    var refused = await helpers.httpRequest({ port: port, path: "/admin/returns/" + pendingId + "/label",
      method: "POST", jar: jar, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: CARRIER_URL, tracking_number: TRACKING, cost_minor: "795", currency: "USD",
      } });
    check("non-approved issue -> 303 err",       refused.status === 303 && (refused.headers.location || "").indexOf("err=1") !== -1);
    check("nothing issued on non-approved",      (await returnLabels.labelForReturn(pendingId)) == null);

    // The bearer JSON path maps the refusal to a 409 conflict (a coded
    // RETURN_LABEL_ISSUE_REFUSED), not a 400/404/500.
    var refusedApi = await helpers.httpRequest({ port: port, path: "/admin/returns/" + pendingId + "/label",
      method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: CARRIER_URL, tracking_number: TRACKING, cost_minor: "795", currency: "USD",
      } });
    check("non-approved issue API -> 409",       refusedApi.status === 409);
    check("non-approved API leaks no raw error", _noLeak(refusedApi.body));

    // ---- coded-error ordering: a missing / malformed RETURN id 404s ---
    // The label-issue route forwards the id to issueLabel, whose
    // RETURN_NOT_FOUND is a *coded TypeError*; the classifier must map it to
    // 404 BEFORE the generic TypeError→400 branch.
    var unknownId = "00000000-0000-7000-8000-000000000000";
    var missingApi = await helpers.httpRequest({ port: port, path: "/admin/returns/" + unknownId + "/label",
      method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: CARRIER_URL, tracking_number: TRACKING, cost_minor: "795", currency: "USD",
      } });
    check("unknown-return issue API -> 404",     missingApi.status === 404);
    check("unknown-return is NOT 400",           missingApi.status !== 400);
    check("unknown-return API leaks no error",   _noLeak(missingApi.body));

    // A malformed (non-uuid) id is a 400 bad-request (a bare-shape TypeError,
    // no code) — distinct from the well-formed-but-missing 404 above.
    var malformedApi = await helpers.httpRequest({ port: port, path: "/admin/returns/not-a-uuid/label",
      method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: CARRIER_URL, tracking_number: TRACKING, cost_minor: "795", currency: "USD",
      } });
    check("malformed-id issue API -> 400",       malformedApi.status === 400);
    check("malformed-id is not a 500",           malformedApi.status !== 500);

    // A mark-* action against an unknown return 404s (labelForReturn finds
    // nothing); against a malformed id it's a 404 too (the route's own miss).
    var markMissing = await helpers.httpRequest({ port: port, path: "/admin/returns/" + unknownId + "/label/shipped",
      method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {} });
    check("mark on unknown return -> 404",       markMissing.status === 404);
    check("mark-missing leaks no raw error",     _noLeak(markMissing.body));

    // ---- VALID issuance persists + closes the loop --------------------
    var issued = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label",
      method: "POST", jar: jar, form: {
        carrier: "USPS", service_level: "Ground Advantage", weight_grams: "340",
        label_url: CARRIER_URL, tracking_number: TRACKING, cost_minor: "795", currency: "USD",
      } });
    check("valid issue -> 303 moved",            issued.status === 303 && (issued.headers.location || "").indexOf("moved=1") !== -1);

    var persisted = await returnLabels.labelForReturn(approvedId);
    check("label persisted",                     !!persisted && persisted.tracking_number === TRACKING);
    check("label stored the carrier url",        persisted && persisted.label_url === CARRIER_URL);
    check("label starts in issued status",       persisted && persisted.status === "issued");

    // The admin detail now shows the label + the carrier/tracking + the
    // issue event timeline + the legal next actions (no more issue form).
    var detail1 = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId, jar: jar });
    check("issued detail shows the carrier",     detail1.body.indexOf("USPS") !== -1);
    check("issued detail shows the tracking",    detail1.body.indexOf(TRACKING) !== -1);
    check("issued detail shows the timeline",    detail1.body.indexOf("Label issued") !== -1);
    check("issued detail offers Mark shipped",   detail1.body.indexOf("Mark shipped") !== -1);
    check("issued detail drops the issue form",  detail1.body.indexOf("Issue return label") === -1);
    check("issued detail leaks no raw error",    _noLeak(detail1.body));

    // CROSS-SURFACE: the customer can now see + download the operator's label.
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    var custDetail = await helpers.httpRequest({ port: port, path: "/account/returns/" + approvedId, jar: buyerJar });
    check("customer return detail -> 200",       custDetail.status === 200);
    check("customer sees the carrier",           custDetail.body.indexOf("USPS") !== -1);
    check("customer sees the tracking",          custDetail.body.indexOf(TRACKING) !== -1);
    check("customer offered a download link",    custDetail.body.indexOf("/account/returns/" + approvedId + "/label") !== -1);

    var custDl = await helpers.httpRequest({ port: port, path: "/account/returns/" + approvedId + "/label", jar: buyerJar });
    check("customer download -> 302",            custDl.status === 302);
    check("customer download hits the carrier",  (custDl.headers["location"] || "") === CARRIER_URL);

    // ---- a tracking update appends an event the customer timeline shows -
    var shipped = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label/shipped",
      method: "POST", jar: jar, form: {} });
    check("mark-shipped -> 303 moved",           shipped.status === 303 && (shipped.headers.location || "").indexOf("moved=1") !== -1);
    check("label now shipped",                   (await returnLabels.labelForReturn(approvedId)).status === "shipped");

    // The shipped label's next legal actions advance with the FSM.
    var detail2 = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId, jar: jar });
    check("shipped detail offers transit scan",  detail2.body.indexOf("Add transit scan") !== -1);
    check("shipped detail offers Mark delivered", detail2.body.indexOf("Mark delivered") !== -1);
    check("shipped detail drops Mark shipped",   detail2.body.indexOf(">Mark shipped<") === -1);

    // An in-transit scan with a location appends a located event.
    var transit = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label/in-transit",
      method: "POST", jar: jar, form: { location: "LAX hub" } });
    check("mark-in-transit -> 303 moved",        transit.status === 303 && (transit.headers.location || "").indexOf("moved=1") !== -1);

    // The customer timeline now reflects both operator updates.
    var custDetail2 = await helpers.httpRequest({ port: port, path: "/account/returns/" + approvedId, jar: buyerJar });
    check("customer timeline shows shipped",      custDetail2.body.indexOf("Parcel dropped off") !== -1);
    check("customer timeline shows in transit",   custDetail2.body.indexOf("In transit") !== -1);
    check("customer timeline shows the location", custDetail2.body.indexOf("LAX hub") !== -1);
    check("customer status now in transit",       custDetail2.body.indexOf("On its way back") !== -1);
    check("customer detail leaks no raw error",   _noLeak(custDetail2.body));

    // ---- an illegal tracking transition is refused (notice, no change) -
    // mark-shipped from in_transit is not a legal FSM hop.
    var illegal = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label/shipped",
      method: "POST", jar: jar, form: {} });
    check("illegal transition -> 303 err",       illegal.status === 303 && (illegal.headers.location || "").indexOf("err=1") !== -1);
    check("label status unchanged after refusal", (await returnLabels.labelForReturn(approvedId)).status === "in_transit");

    // The bearer path maps that FSM refusal to a 409 (a coded
    // RETURN_LABEL_TRANSITION_REFUSED), not a 400/500.
    var illegalApi = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label/shipped",
      method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {} });
    check("illegal transition API -> 409",       illegalApi.status === 409);
    check("illegal transition API leaks no error", _noLeak(illegalApi.body));

    // ---- mark-delivered completes the leg + flips the RMA to received --
    var delivered = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label/delivered",
      method: "POST", jar: jar, form: {} });
    check("mark-delivered -> 303 moved",         delivered.status === 303 && (delivered.headers.location || "").indexOf("moved=1") !== -1);
    check("label now delivered",                 (await returnLabels.labelForReturn(approvedId)).status === "delivered");
    // delivered is the integration boundary — the RMA flips to received.
    check("RMA flipped to received on delivery", (await returns.get(approvedId)).status === "received");

    // The delivered label is terminal — no further tracking actions.
    var detail3 = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId, jar: jar });
    check("delivered label is terminal",          detail3.body.indexOf("final state — no further tracking") !== -1);

    // ---- auth gate: an anon issue POST never reaches the primitive -----
    var anonIssue = await helpers.httpRequest({ port: port, path: "/admin/returns/" + approvedId + "/label",
      method: "POST", form: { carrier: "X" } });
    check("anon issue does not 2xx",             anonIssue.status >= 300);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };

// Allow direct invocation.
if (require.main === module) {
  _run().then(function () {
    console.log("OK — admin-return-label-issuance (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — admin-return-label-issuance: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
