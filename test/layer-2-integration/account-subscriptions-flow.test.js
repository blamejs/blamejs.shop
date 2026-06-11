"use strict";
/**
 * Customer subscription self-management — full HTTP integration of the
 * /account/subscriptions surface.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * subscriptions + catalog/cart/order/customers deps + a STUB payment
 * (whose `subscriptions.cancel` returns a canceled object, so cancel
 * works offline). One in-memory `node:sqlite` DB loaded from the live
 * migrations. The signed-in customer is read from the sealed `shop_auth`
 * cookie (minted via helpers.authCookie after boot). Two subscriptions
 * are seeded directly: one owned by the buyer, one by a stranger. Covers
 * list-shows-only-own / cancel-transitions-own / IDOR-refuses-foreign /
 * anon-redirects-to-login.
 *
 * Network: zero — every request lands on 127.0.0.1; payment is a stub.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql", "0006_customers.sql", "0009_subscriptions.sql", "0045_subscription_controls.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
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

// Offline Stripe stand-in. `subscriptions.cancel` echoes a canceled
// subscription object in Stripe's shape so the primitive's cancel path
// runs without a network hop. Records the id it was asked to cancel so
// the test can assert it's never called for the foreign subscription.
function _stubPayment(state) {
  return {
    subscriptions: {
      cancel: async function (stripeId, opts, _idemKey) {
        state.canceled.push(stripeId);
        return {
          id:                   stripeId,
          status:               "canceled",
          cancel_at_period_end: opts && opts.at_period_end ? true : false,
          // allow:raw-time-literal — Stripe sends unix SECONDS; a fixed
          // demo period end echoed back to exercise the cancel path.
          current_period_start: 1700000000,
          current_period_end:   1700604800,
        };
      },
    },
  };
}

// Seed a subscription (+ a plan it links to) owned by `customerId`.
// Returns the local subscription id + the stripe id it carries.
async function _seedSubscription(query, customerId, variantId, status) {
  var now = Date.now();
  var planId = b.uuid.v7();
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'month', 1, 'usd', 1999, 0, 1, ?4, ?4)",
    [planId, variantId, "price_" + planId.slice(0, 8), now],
  );
  var subId = b.uuid.v7();
  // v7 UUIDs share a timestamp prefix, so a leading slice can collide;
  // use the random tail for a unique stripe id.
  var stripeId = "sub_" + subId.replace(/-/g, "").slice(-16);
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)",
    [subId, customerId, planId, stripeId, status || "active", now, now + 2592000000, now],
  );
  return { subId: subId, stripeId: stripeId, planId: planId };
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-subs-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "subs-flow-order" });
  var customers = bShop.customers.create({ query: query });

  var stubState = { canceled: [] };
  var payment   = _stubPayment(stubState);
  var subscriptions = bShop.subscriptions.create({ query: query, payment: payment });
  var subscriptionControls = bShop.subscriptionControls.create({
    query:         query,
    subscriptions: subscriptions.subscriptions,
  });

  var product = await catalog.products.create({ slug: "coffee-box", title: "Coffee Box", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "CFE-BOX", options: { size: "M" } });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  var owned    = await _seedSubscription(query, buyer, variant.id, "active");
  var foreign  = await _seedSubscription(query, stranger, variant.id, "active");

  var handle = await _bootApp({
    catalog:              catalog,
    cart:                 cart,
    order:                order,
    customers:            customers,
    subscriptions:        subscriptions,
    subscriptionControls: subscriptionControls,
    payment:              payment,
    config:               { shop_name: "blamejs.shop" },
  });

  try {
    // A cookie jar (not a bare cookie header) so the double-submit CSRF
    // cookie the server sets on the first authenticated GET is captured and
    // replayed: helpers.httpRequest echoes it as X-CSRF-Token on the POSTs
    // below, exercising the real CSRF gate end-to-end (no bypass).
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // Anon → login.
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions" });
    check("anon subscriptions then 303 login",   anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    // List shows only the buyer's own subscription, never the stranger's.
    var list = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions", jar: jar });
    check("subscriptions page then 200",          list.status === 200);
    check("list shows the active status pill",    list.body.indexOf("subscription-status--active") !== -1);
    check("list shows the plan price",            list.body.indexOf("$19.99") !== -1);
    check("list shows a cancel control",          list.body.indexOf("/account/subscriptions/" + owned.subId + "/cancel") !== -1);
    check("list hides the foreign subscription",  list.body.indexOf("/account/subscriptions/" + foreign.subId + "/cancel") === -1);

    // ---- self-manage controls (pause / resume / skip / qty / freq /
    // reactivate) — exercised on a dedicated subscription so the cancel
    // flow below stays independent. The list offers each state-gated
    // control; each POST composes the matching subscriptionControls
    // method, writes the audit ledger, and PRG-redirects with ?ok / ?error.
    var mgmt = await _seedSubscription(query, buyer, variant.id, "active");

    // Active row exposes pause + skip + quantity + frequency controls.
    var mgmtList = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions", jar: jar });
    check("list offers pause control",            mgmtList.body.indexOf("/account/subscriptions/" + mgmt.subId + "/pause") !== -1);
    check("list offers skip control",             mgmtList.body.indexOf("/account/subscriptions/" + mgmt.subId + "/skip") !== -1);
    check("list offers quantity control",         mgmtList.body.indexOf("/account/subscriptions/" + mgmt.subId + "/quantity") !== -1);
    check("list offers frequency control",        mgmtList.body.indexOf("/account/subscriptions/" + mgmt.subId + "/frequency") !== -1);

    function _post(suffix, form) {
      return helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + mgmt.subId + suffix, method: "POST", jar: jar, form: form || {} });
    }

    // Skip next shipment → 303 ?ok=skipped + a ledger row.
    var skipRes = await _post("/skip");
    check("skip then 303 ?ok=skipped",            skipRes.status === 303 && (skipRes.headers["location"] || "").indexOf("?ok=skipped") !== -1);

    // Change quantity (happy path) → 303 ?ok=quantity + the row updates.
    var qtyRes = await _post("/quantity", { quantity: "3" });
    check("quantity then 303 ?ok=quantity",       qtyRes.status === 303 && (qtyRes.headers["location"] || "").indexOf("?ok=quantity") !== -1);
    var qtyRow = await subscriptions.subscriptions.get(mgmt.subId);
    check("quantity persisted on the row",        qtyRow && Number(qtyRow.quantity) === 3);

    // Rejected bad input — quantity 0 → 303 ?error=quantity, row unchanged.
    var badQty = await _post("/quantity", { quantity: "0" });
    check("bad quantity then 303 ?error=quantity", badQty.status === 303 && (badQty.headers["location"] || "").indexOf("?error=quantity") !== -1);
    var badQtyRow = await subscriptions.subscriptions.get(mgmt.subId);
    check("bad quantity left the row untouched",   badQtyRow && Number(badQtyRow.quantity) === 3);

    // Rejected bad input — frequency outside the enum → 303 ?error=frequency.
    var badFreq = await _post("/frequency", { frequency: "fortnightly" });
    check("bad frequency then 303 ?error=frequency", badFreq.status === 303 && (badFreq.headers["location"] || "").indexOf("?error=frequency") !== -1);

    // Change frequency (happy path) → 303 ?ok=frequency + the row updates.
    var freqRes = await _post("/frequency", { frequency: "quarterly" });
    check("frequency then 303 ?ok=frequency",     freqRes.status === 303 && (freqRes.headers["location"] || "").indexOf("?ok=frequency") !== -1);
    var freqRow = await subscriptions.subscriptions.get(mgmt.subId);
    check("frequency persisted on the row",       freqRow && freqRow.frequency === "quarterly");

    // Pause is confirm-gated: GET renders the confirm page, POST pauses.
    var pauseConfirm = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + mgmt.subId + "/pause", jar: jar });
    check("pause confirm page then 200",          pauseConfirm.status === 200 && pauseConfirm.body.indexOf("Pause subscription") !== -1);
    var pauseRes = await _post("/pause");
    check("pause then 303 ?ok=paused",            pauseRes.status === 303 && (pauseRes.headers["location"] || "").indexOf("?ok=paused") !== -1);
    var pausedRow = await subscriptions.subscriptions.get(mgmt.subId);
    check("pause stamped paused_at",              pausedRow && pausedRow.paused_at != null);

    // Paused row swaps the pause control for a resume control.
    var pausedList = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions", jar: jar });
    check("paused list offers resume control",    pausedList.body.indexOf("/account/subscriptions/" + mgmt.subId + "/resume") !== -1);
    check("paused list hides pause control",       pausedList.body.indexOf("/account/subscriptions/" + mgmt.subId + "/pause") === -1);

    // Resume → 303 ?ok=resumed + the row clears paused_at.
    var resumeRes = await _post("/resume");
    check("resume then 303 ?ok=resumed",          resumeRes.status === 303 && (resumeRes.headers["location"] || "").indexOf("?ok=resumed") !== -1);
    var resumedRow = await subscriptions.subscriptions.get(mgmt.subId);
    check("resume cleared paused_at",             resumedRow && resumedRow.paused_at == null);

    // Reactivate path — cancel the mgmt row through the controls primitive
    // (immediate, so cancelled_at lands now, inside the grace window), then
    // reactivate it via the self-manage route.
    await subscriptionControls.cancel({ subscription_id: mgmt.subId, reason: "test cancel for reactivate", actor: { actor_type: "operator", actor_id: null }, immediate: true });
    var cancelledList = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions", jar: jar });
    check("cancelled list offers reactivate control", cancelledList.body.indexOf("/account/subscriptions/" + mgmt.subId + "/reactivate") !== -1);
    var reactRes = await _post("/reactivate");
    check("reactivate then 303 ?ok=reactivated",  reactRes.status === 303 && (reactRes.headers["location"] || "").indexOf("?ok=reactivated") !== -1);
    var reactRow = await subscriptions.subscriptions.get(mgmt.subId);
    check("reactivate cleared cancelled_at",      reactRow && reactRow.cancelled_at == null);

    // The self-manage ledger captured the customer-initiated events.
    var ledger = await subscriptionControls.historyForSubscription(mgmt.subId);
    check("self-manage ledger recorded events",   ledger.length >= 6);
    check("ledger newest event is reactivate",    ledger[0].event === "reactivate");

    // IDOR guard on a self-manage route — pausing the stranger's row 404s.
    var foreignPause = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + foreign.subId + "/pause", method: "POST", jar: jar, form: {} });
    check("foreign pause then 404 (IDOR guard)",  foreignPause.status === 404);

    // IDOR guard — cancel of the stranger's subscription is refused (404)
    // and the stub's cancel is NEVER reached for the foreign stripe id.
    var idor = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + foreign.subId + "/cancel", method: "POST", jar: jar, form: {} });
    check("foreign cancel then 404 (IDOR guard)", idor.status === 404);
    check("foreign stripe id never canceled",     stubState.canceled.indexOf(foreign.stripeId) === -1);
    var foreignRow = await subscriptions.subscriptions.get(foreign.subId);
    check("foreign subscription untouched",       foreignRow && foreignRow.status === "active");

    // Malformed id → 404, not 500.
    var malformed = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/not-a-uuid/cancel", method: "POST", jar: jar, form: {} });
    check("malformed cancel id then 404",         malformed.status === 404);

    // Cancel the buyer's own subscription → 303 + transitioned to canceled.
    var ok = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + owned.subId + "/cancel", method: "POST", jar: jar, form: {} });
    check("own cancel then 303 /account/subscriptions", ok.status === 303 && (ok.headers["location"] || "").indexOf("/account/subscriptions") === 0);
    check("own stripe id was canceled",           stubState.canceled.indexOf(owned.stripeId) !== -1);
    var ownedRow = await subscriptions.subscriptions.get(owned.subId);
    check("own subscription now canceled",        ownedRow && ownedRow.status === "canceled");

    // Re-list — the now-canceled subscription shows the canceled pill and
    // no longer offers a cancel control.
    var after = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions", jar: jar });
    check("list shows canceled status pill",      after.body.indexOf("subscription-status--canceled") !== -1);
    check("canceled row hides cancel control",    after.body.indexOf("/account/subscriptions/" + owned.subId + "/cancel") === -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
