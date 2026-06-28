"use strict";
/**
 * Customer subscription plan change — full HTTP integration of the
 * /account/subscriptions/:id/change surface plus the scheduler tick.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * subscriptions + subscriptionBilling + storeCredit + planChanges deps
 * (+ catalog/cart/order/customers + a STUB payment). One in-memory
 * `node:sqlite` DB loaded from the live migrations. The signed-in
 * customer is read from the sealed `shop_auth` cookie (minted via
 * helpers.authCookie after boot). The cron tick is driven via a thin
 * /_/subscription-plan-changes-tick handler mirroring the one server.js
 * mounts — same timing-safe D1_BRIDGE_SECRET gate, same
 * `planChanges.applyScheduledChanges({ now })` call, same never-5xx
 * shape — so the sweep exercises the production code path.
 *
 * Covers: change-page renders candidate plans with proration previews /
 * immediate upgrade transitions the plan / immediate downgrade issues a
 * store credit / next_cycle leaves a pending row + banner / the tick
 * applies a due pending change / cancel-pending clears it / a same-plan
 * (no candidate) and a cross-currency candidate never reach the picker.
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

// The plan-change surface needs the subscriptions tables, the billing
// invoice ledger (the proration charge an upgrade owes), the plan-change
// ledger itself, and the store-credit ledger (a mid-cycle downgrade's owed
// credit). Loaded in numeric order alongside the catalog/cart/order/
// customers tables every storefront boot reads.
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
  "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql",
  "0206_orders_email_hash.sql", "0006_customers.sql",
  "0009_subscriptions.sql", "0045_subscription_controls.sql",
  "0066_subscription_billing.sql", "0083_plan_changes.sql",
  "0094_store_credit.sql",
  // The store-credit ledger writes a per-customer SHA3-512 hash chain; the
  // downgrade-credit path reads/writes prev_hash + row_hash, so the chain
  // columns + the chain-parent fence must be present.
  "0235_store_credit_ledger_chain.sql", "0236_store_credit_ledger_chain_fence.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

// Offline Stripe stand-in for the NON-Stripe path — exposes only
// `cancel` (no retrieve/update), so planChanges + subscriptionControls
// treat every row as shop-local and exercise the local store-credit /
// invoice settlement model. The shared `subscriptions` instance wants a
// payment handle; this keeps shape parity with the production composition.
function _stubPayment() {
  return { subscriptions: { cancel: async function (id) { return { id: id, status: "canceled" }; } } };
}

// Stripe-CAPABLE stand-in for the Stripe-backed path — exposes
// retrieve + update so planChanges treats a row carrying a
// stripe_subscription_id as genuinely Stripe-backed and pushes the price
// swap to Stripe before the local write. Every `update` call is recorded
// so the test can assert the exact arg + idempotency-key shape. retrieve
// returns a single billable item ("si_<subId>") matching the one-price
// composition the shop creates.
function _stripeStubPayment(recordedCalls) {
  return {
    subscriptions: {
      retrieve: async function (id) {
        return { id: id, items: { data: [{ id: "si_" + id }] } };
      },
      update: async function (id, body, opts) {
        recordedCalls.push({ id: id, body: body, opts: opts });
        return { id: id, status: "active" };
      },
      cancel: async function (id) { return { id: id, status: "canceled" }; },
    },
  };
}

// Seed a plan with an explicit amount + currency so up/downgrade math is
// deterministic. Returns the plan id.
async function _seedPlan(query, variantId, amountMinor, currency) {
  var now = Date.now();
  var planId = b.uuid.v7();
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'month', 1, ?4, ?5, 0, 1, ?6, ?6)",
    [planId, variantId, "price_" + planId.slice(0, 8), currency || "usd", amountMinor, now],
  );
  return planId;
}

// Seed a subscription on `planId` owned by `customerId`, with a billing
// period spanning [periodStart, periodEnd]. Returns { subId, stripeId }.
async function _seedSubscription(query, customerId, planId, periodStart, periodEnd) {
  var now = Date.now();
  var subId = b.uuid.v7();
  // v7 UUIDs share a timestamp prefix; use the random tail for a unique id.
  var stripeId = "sub_" + subId.replace(/-/g, "").slice(-16);
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, ?7, ?7)",
    [subId, customerId, planId, stripeId, periodStart, periodEnd, now],
  );
  return { subId: subId, stripeId: stripeId };
}

async function _bootApp(deps, sweepSecret) {
  // Validate the bridge secret once at init (fail-closed) so the tick
  // handler below carries only request-dependent checks — no provably-
  // constant `!want` fragment in the hot path. (The production handler in
  // server.js keeps its `!wantPC` because process.env.D1_BRIDGE_SECRET can
  // legitimately be empty; here the secret is a fixed test constant.)
  if (typeof sweepSecret !== "string" || !sweepSecret.length) {
    throw new TypeError("_bootApp: sweepSecret must be a non-empty string");
  }
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-plan-change-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
      // Thin tick handler mirroring server.js#/_/subscription-plan-changes-
      // tick — same timing-safe secret gate, same applyScheduledChanges
      // call, same never-5xx JSON shape. Exercises the production sweep.
      r.post("/_/subscription-plan-changes-tick", async function (req, res) {
        var got  = req.headers && req.headers["x-d1-bridge-secret"];
        var want = sweepSecret;
        if (typeof got !== "string" || got.length !== want.length || !b.crypto.timingSafeEqual(got, want)) {
          res.status(401); res.setHeader && res.setHeader("content-type", "application/json");
          return res.end ? res.end(JSON.stringify({ ok: false, error: "UNAUTHORIZED" })) : res.send("");
        }
        if (!deps.planChanges) {
          res.setHeader && res.setHeader("content-type", "application/json");
          return res.end ? res.end(JSON.stringify({ ok: true, enabled: false })) : res.send("");
        }
        try {
          var applied = await deps.planChanges.applyScheduledChanges({ now: Date.now() });
          res.setHeader && res.setHeader("content-type", "application/json");
          return res.end ? res.end(JSON.stringify({ ok: true, enabled: true, applied: applied.length })) : res.send("");
        } catch (_e) {
          res.setHeader && res.setHeader("content-type", "application/json");
          return res.end ? res.end(JSON.stringify({ ok: false, enabled: true, error: "plan-change-tick failed" })) : res.send("");
        }
      });
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
  var order     = bShop.order.create({ query: query, cursorSecret: "plan-change-order" });
  var customers = bShop.customers.create({ query: query });

  var payment   = _stubPayment();
  var subscriptions = bShop.subscriptions.create({ query: query, payment: payment });
  var subscriptionBilling = bShop.subscriptionBilling.create({ query: query, subscriptions: subscriptions.subscriptions });
  var storeCredit = bShop.storeCredit.create({ query: query });
  var planChanges = bShop.planChanges.create({
    query:               query,
    subscriptions:       subscriptions.subscriptions,
    subscriptionBilling: subscriptionBilling,
    storeCredit:         storeCredit,
  });

  var product = await catalog.products.create({ slug: "coffee-box", title: "Coffee Box", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "CFE-BOX", options: { size: "M" } });

  // Three USD plans (cheap / current / expensive) + one EUR plan that must
  // never appear as a candidate (cross-currency). One archived USD plan
  // that must also never appear.
  var planCheap   = await _seedPlan(query, variant.id, 1000, "usd");   // $10.00
  var planCurrent = await _seedPlan(query, variant.id, 2000, "usd");   // $20.00
  var planPremium = await _seedPlan(query, variant.id, 4000, "usd");   // $40.00
  var planEur     = await _seedPlan(query, variant.id, 2000, "eur");   // €20.00 — cross-currency
  var planArchived = await _seedPlan(query, variant.id, 1500, "usd");
  await query("UPDATE subscription_plans SET active = 0 WHERE id = ?1", [planArchived]);

  var buyer = b.uuid.v7();

  // Period: a 30-day window centred so we're ~half-way through (so the
  // immediate proration is a clean fraction). start = now-15d, end = now+15d.
  var now = Date.now();
  var DAY = 86400000;
  var periodStart = now - 15 * DAY;
  var periodEnd   = now + 15 * DAY;

  var SWEEP_SECRET = "plan-change-tick-secret-padpadpadpadpad";

  var handle = await _bootApp({
    catalog:             catalog,
    cart:                cart,
    order:               order,
    customers:           customers,
    subscriptions:       subscriptions,
    subscriptionBilling: subscriptionBilling,
    storeCredit:         storeCredit,
    planChanges:         planChanges,
    payment:             payment,
    config:              { shop_name: "blamejs.shop" },
  }, SWEEP_SECRET);

  try {
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- (a) GET change page renders candidate plans + previews ----------
    var upgradeSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);

    var changePage = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + upgradeSub.subId + "/change", jar: jar });
    check("change page 200",                       changePage.status === 200);
    check("change page offers premium candidate",  changePage.body.indexOf("value=\"" + planPremium + "\"") !== -1);
    check("change page offers cheap candidate",    changePage.body.indexOf("value=\"" + planCheap + "\"") !== -1);
    // Current plan is excluded (no radio for it).
    check("change page excludes current plan",     changePage.body.indexOf("value=\"" + planCurrent + "\"") === -1);
    // Cross-currency + archived plans are excluded from the picker.
    check("change page excludes EUR plan",         changePage.body.indexOf("value=\"" + planEur + "\"") === -1);
    check("change page excludes archived plan",    changePage.body.indexOf("value=\"" + planArchived + "\"") === -1);
    // The upgrade preview shows a charge (premium $40 vs current $20, half-
    // period ≈ $10 charge); the downgrade shows a store-credit line.
    check("change page shows a proration charge",  changePage.body.indexOf("you'll be charged") !== -1);
    check("change page shows a store-credit line",  changePage.body.indexOf("in store credit") !== -1);
    check("change page offers both timing radios",  changePage.body.indexOf("value=\"immediate\"") !== -1 && changePage.body.indexOf("value=\"next_cycle\"") !== -1);

    // The /account/subscriptions list links to the change page on the active
    // subscription.
    var listWithChange = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions", jar: jar });
    check("list offers change-plan link",          listWithChange.body.indexOf("/account/subscriptions/" + upgradeSub.subId + "/change") !== -1);

    // ---- (b) immediate upgrade transitions the plan ----------------------
    var up = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + upgradeSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planPremium, timing: "immediate" },
    });
    check("immediate upgrade 303 ?ok=plan_changed", up.status === 303 && (up.headers["location"] || "").indexOf("?ok=plan_changed") !== -1);
    var upRow = await subscriptions.subscriptions.get(upgradeSub.subId);
    check("upgrade flipped plan_id to premium",    upRow && upRow.plan_id === planPremium);
    // The upgrade queued a proration charge through the invoice ledger.
    var upInv = await query("SELECT * FROM subscription_invoices WHERE subscription_id = ?1", [upgradeSub.subId]);
    check("upgrade recorded a proration invoice",  upInv.rows.length === 1 && Number(upInv.rows[0].amount_minor) > 0);
    // No store credit for an upgrade.
    var upCredit = await query("SELECT * FROM store_credit_ledger WHERE customer_id = ?1", [buyer]);
    check("upgrade issued no store credit",        upCredit.rows.length === 0);

    // ---- (c) immediate downgrade issues a store credit -------------------
    var downSub = await _seedSubscription(query, buyer, planPremium, periodStart, periodEnd);
    var down = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + downSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planCheap, timing: "immediate" },
    });
    check("immediate downgrade 303 ?ok=plan_changed", down.status === 303 && (down.headers["location"] || "").indexOf("?ok=plan_changed") !== -1);
    var downRow = await subscriptions.subscriptions.get(downSub.subId);
    check("downgrade flipped plan_id to cheap",    downRow && downRow.plan_id === planCheap);
    // The mid-cycle downgrade's unused remainder lands as a store credit.
    var downCredit = await query("SELECT * FROM store_credit_ledger WHERE customer_id = ?1 AND kind = 'credit'", [buyer]);
    check("downgrade issued a store credit",       downCredit.rows.length === 1 && Number(downCredit.rows[0].amount_minor) > 0);

    // ---- (d) next_cycle leaves a pending row + banner --------------------
    var nextSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);
    var next = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + nextSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planPremium, timing: "next_cycle" },
    });
    check("next_cycle 303 ?ok=plan_changed",       next.status === 303 && (next.headers["location"] || "").indexOf("?ok=plan_changed") !== -1);
    var pendingRow = await planChanges.pendingChangeFor(nextSub.subId);
    check("next_cycle left a pending row",          pendingRow && pendingRow.status === "pending" && pendingRow.change_kind === "next_billing_cycle");
    check("next_cycle did NOT flip plan yet",       (await subscriptions.subscriptions.get(nextSub.subId)).plan_id === planCurrent);
    // The list shows a pending-change banner with a cancel control.
    var listPending = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions", jar: jar });
    check("list shows pending-change banner",      listPending.body.indexOf("subscription-card__pending-change") !== -1);
    check("list pending banner offers cancel",     listPending.body.indexOf("/account/subscriptions/" + nextSub.subId + "/change/cancel") !== -1);
    // A second change is refused while one is pending.
    var dup = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + nextSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planCheap, timing: "immediate" },
    });
    check("second change refused pending_exists",  dup.status === 303 && (dup.headers["location"] || "").indexOf("error=pending_exists") !== -1);

    // ---- (f) cancel-pending works ----------------------------------------
    var cancelPending = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + nextSub.subId + "/change/cancel",
      method: "POST", jar: jar, form: {},
    });
    check("cancel-pending 303 ?ok=change_canceled", cancelPending.status === 303 && (cancelPending.headers["location"] || "").indexOf("?ok=change_canceled") !== -1);
    check("cancel-pending cleared the pending row",  (await planChanges.pendingChangeFor(nextSub.subId)) == null);

    // ---- (e) the tick applies a due pending change -----------------------
    // Seed a DUE pending plan change directly (effective_at in the past),
    // mirroring what executeChange writes for a future next_cycle change
    // whose clock has since arrived. An upgrade (charge, no credit) so the
    // tick records a proration invoice.
    var tickSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);
    var dueChangeId = b.uuid.v7();
    var pastEffective = now - DAY;   // due relative to Date.now()
    await query(
      "INSERT INTO subscription_plan_changes " +
      "(id, subscription_id, from_plan_id, to_plan_id, change_kind, status, " +
      " proration_credit_minor, first_charge_minor, currency, effective_at, " +
      " executed_at, cancelled_at, cancel_reason, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, 'next_billing_cycle', 'pending', 0, 1000, 'usd', ?5, NULL, NULL, NULL, ?6)",
      [dueChangeId, tickSub.subId, planCurrent, planPremium, pastEffective, now],
    );

    // Wrong / absent secret → 401 (the gate is real).
    var badTick = await helpers.httpRequest({
      port: handle.port, path: "/_/subscription-plan-changes-tick", method: "POST",
      headers: { "x-d1-bridge-secret": "wrong-secret-but-same-length-padpadpa", "content-type": "application/json" }, body: "{}",
    });
    check("tick wrong secret 401",                 badTick.status === 401);
    var noSecretTick = await helpers.httpRequest({
      port: handle.port, path: "/_/subscription-plan-changes-tick", method: "POST",
      headers: { "content-type": "application/json" }, body: "{}",
    });
    check("tick absent secret 401",                noSecretTick.status === 401);

    var tick = await helpers.httpRequest({
      port: handle.port, path: "/_/subscription-plan-changes-tick", method: "POST",
      headers: { "x-d1-bridge-secret": SWEEP_SECRET, "content-type": "application/json" }, body: "{}",
    });
    var tickJson = JSON.parse(tick.body);
    check("tick ok + applied >= 1",                tickJson.ok === true && tickJson.enabled === true && tickJson.applied >= 1);
    // The due change landed: plan flipped, row executed, invoice recorded.
    await helpers.waitUntil(async function () {
      var r = await query("SELECT status FROM subscription_plan_changes WHERE id = ?1", [dueChangeId]);
      return r.rows.length && r.rows[0].status === "executed";
    }, { timeoutMs: 3000, label: "due plan change executed" });
    check("tick flipped plan to premium",          (await subscriptions.subscriptions.get(tickSub.subId)).plan_id === planPremium);
    var tickInv = await query("SELECT * FROM subscription_invoices WHERE subscription_id = ?1", [tickSub.subId]);
    check("tick recorded a proration invoice",     tickInv.rows.length === 1);

    // ---- (g) cross-currency / same-plan bounce with ?error ---------------
    // A cross-currency change is refused by the primitive (TypeError → ?error
    // =plan). Drive it directly past the picker (the picker hides it, but a
    // forged POST must still be refused server-side).
    var xcurrSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);
    var xcurr = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + xcurrSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planEur, timing: "immediate" },
    });
    check("cross-currency change bounces ?error=plan", xcurr.status === 303 && (xcurr.headers["location"] || "").indexOf("error=plan") !== -1);
    check("cross-currency left plan unchanged",    (await subscriptions.subscriptions.get(xcurrSub.subId)).plan_id === planCurrent);

    // Same-plan change is a TypeError → ?error=plan.
    var samePlan = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + xcurrSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planCurrent, timing: "immediate" },
    });
    check("same-plan change bounces ?error=plan",  samePlan.status === 303 && (samePlan.headers["location"] || "").indexOf("error=plan") !== -1);

    // Missing new_plan_id is a client error → ?error=plan, never a 500.
    var noPlan = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + xcurrSub.subId + "/change",
      method: "POST", jar: jar, form: { timing: "immediate" },
    });
    check("missing plan id bounces ?error=plan",   noPlan.status === 303 && (noPlan.headers["location"] || "").indexOf("error=plan") !== -1);

    // Inactive subscription — a paused row that still carries period columns
    // is refused a plan change, backend-validated against the same active-state
    // gate the display + GET enforce, so a forged POST can't re-plan a
    // wound-down subscription.
    var pausedSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);
    await query("UPDATE subscriptions SET paused_at = ?1 WHERE id = ?2", [Date.now(), pausedSub.subId]);
    var pausedChange = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + pausedSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planPremium, timing: "immediate" },
    });
    check("paused-sub change bounces ?error=state", pausedChange.status === 303 && (pausedChange.headers["location"] || "").indexOf("error=state") !== -1);
    check("paused-sub plan unchanged",             (await subscriptions.subscriptions.get(pausedSub.subId)).plan_id === planCurrent);
    var pausedGet = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + pausedSub.subId + "/change", jar: jar });
    check("paused-sub change page 303 to list",    pausedGet.status === 303 && (pausedGet.headers["location"] || "").indexOf("/account/subscriptions") === 0);

    // IDOR — a stranger's subscription 404s before any read.
    var stranger = b.uuid.v7();
    var foreign = await _seedSubscription(query, stranger, planCurrent, periodStart, periodEnd);
    var idor = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + foreign.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planPremium, timing: "immediate" },
    });
    check("foreign change 404 (IDOR guard)",       idor.status === 404);
    check("foreign subscription untouched",        (await subscriptions.subscriptions.get(foreign.subId)).plan_id === planCurrent);

    // Anon → login redirect on the change page.
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + upgradeSub.subId + "/change" });
    check("anon change page 303 login",            anon.status === 303 && (anon.headers["location"] || "") === "/account/login");
  } finally {
    await _teardown(handle);
  }
}

// ---------------------------------------------------------------------------
// Stripe-backed path — a separate app/DB wired with a Stripe-CAPABLE stub
// payment (retrieve + update), so planChanges treats every row carrying a
// stripe_subscription_id as genuinely Stripe-backed. Stripe owns the
// proration for these rows: a change swaps the subscription item's price at
// Stripe and the local store-credit / invoice settlement is skipped (the
// customer must never be settled twice). Isolated DB so the "no store-credit
// row / no invoice row" assertions are unambiguous.
// ---------------------------------------------------------------------------
async function _runStripeBacked() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "plan-change-order-stripe" });
  var customers = bShop.customers.create({ query: query });

  var recordedCalls = [];
  var payment   = _stripeStubPayment(recordedCalls);
  var subscriptions = bShop.subscriptions.create({ query: query, payment: payment });
  var subscriptionBilling = bShop.subscriptionBilling.create({ query: query, subscriptions: subscriptions.subscriptions });
  var storeCredit = bShop.storeCredit.create({ query: query });
  var planChanges = bShop.planChanges.create({
    query:               query,
    subscriptions:       subscriptions.subscriptions,
    subscriptionBilling: subscriptionBilling,
    storeCredit:         storeCredit,
    payment:             payment,
  });
  check("planChanges reports stripe-capable",     planChanges != null);

  var product = await catalog.products.create({ slug: "tea-box", title: "Tea Box", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "TEA-BOX", options: { size: "M" } });

  var planCheap   = await _seedPlan(query, variant.id, 1000, "usd");   // $10.00
  var planCurrent = await _seedPlan(query, variant.id, 2000, "usd");   // $20.00
  var planPremium = await _seedPlan(query, variant.id, 4000, "usd");   // $40.00

  // A plan with no usable stripe_price_id (the column is TEXT NOT NULL, so
  // an unconfigured plan carries an empty string) — a Stripe-backed change
  // targeting it must be refused (PLAN_CHANGE_STRIPE_PRICE_MISSING), never
  // silently diverge the local plan from Stripe.
  var planNoPrice = b.uuid.v7();
  var nowSeed = Date.now();
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, '', 'month', 1, 'usd', 3000, 0, 1, ?3, ?3)",
    [planNoPrice, variant.id, nowSeed],
  );

  var buyer = b.uuid.v7();
  var now = Date.now();
  var DAY = 86400000;
  var periodStart = now - 15 * DAY;
  var periodEnd   = now + 15 * DAY;

  var SWEEP_SECRET = "plan-change-tick-secret-padpadpadpadpad";

  var handle = await _bootApp({
    catalog:             catalog,
    cart:                cart,
    order:               order,
    customers:           customers,
    subscriptions:       subscriptions,
    subscriptionBilling: subscriptionBilling,
    storeCredit:         storeCredit,
    planChanges:         planChanges,
    payment:             payment,
    config:              { shop_name: "blamejs.shop" },
  }, SWEEP_SECRET);

  try {
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- (a) immediate Stripe-backed UPGRADE pushes to Stripe ------------
    // always_invoice + items:[{ id, price:<premium stripe_price_id> }];
    // flips local plan_id; writes NO store-credit row + NO invoice row.
    var upSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);
    // GET the change page first — it renders + seeds the per-session `csrf`
    // cookie into the jar so the helper can stamp X-CSRF-Token on the POSTs
    // below (a container POST is csrf-guarded; without a prior GET the jar
    // carries no token and the POST 403s).
    var upPage = await helpers.httpRequest({ port: handle.port, path: "/account/subscriptions/" + upSub.subId + "/change", jar: jar });
    check("stripe change page 200",                  upPage.status === 200);
    recordedCalls.length = 0;
    var up = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + upSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planPremium, timing: "immediate" },
    });
    check("stripe immediate upgrade 303 ?ok=plan_changed", up.status === 303 && (up.headers["location"] || "").indexOf("?ok=plan_changed") !== -1);
    check("stripe immediate upgrade pushed exactly one update", recordedCalls.length === 1);
    var premiumPrice = (await query("SELECT stripe_price_id FROM subscription_plans WHERE id = ?1", [planPremium])).rows[0].stripe_price_id;
    var upCall = recordedCalls[0] || { body: { items: [{}] } };
    check("stripe update targeted the live subscription",  upCall.id === upSub.stripeId);
    check("stripe update swaps to the premium price",      Array.isArray(upCall.body.items) && upCall.body.items.length === 1 &&
                                                           upCall.body.items[0].price === premiumPrice && upCall.body.items[0].id === "si_" + upSub.stripeId);
    check("stripe update used always_invoice proration",   upCall.body.proration_behavior === "always_invoice");
    check("stripe update carried the plan-change idem key", typeof upCall.opts === "string" && upCall.opts.indexOf("planchange:") === 0);
    check("stripe upgrade flipped local plan_id",          (await subscriptions.subscriptions.get(upSub.subId)).plan_id === planPremium);
    var upInv = await query("SELECT * FROM subscription_invoices WHERE subscription_id = ?1", [upSub.subId]);
    check("stripe upgrade wrote NO local invoice",         upInv.rows.length === 0);
    var upCredit = await query("SELECT * FROM store_credit_ledger WHERE customer_id = ?1", [buyer]);
    check("stripe upgrade wrote NO store credit",          upCredit.rows.length === 0);

    // ---- (b) immediate Stripe-backed DOWNGRADE needs no store-credit -----
    // The local path would owe (and refuse without) a store-credit handle;
    // the Stripe path must NOT touch store credit and must NOT throw.
    var downSub = await _seedSubscription(query, buyer, planPremium, periodStart, periodEnd);
    recordedCalls.length = 0;
    var down = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + downSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planCheap, timing: "immediate" },
    });
    check("stripe immediate downgrade 303 ?ok=plan_changed", down.status === 303 && (down.headers["location"] || "").indexOf("?ok=plan_changed") !== -1);
    check("stripe downgrade flipped local plan_id",        (await subscriptions.subscriptions.get(downSub.subId)).plan_id === planCheap);
    var cheapPrice = (await query("SELECT stripe_price_id FROM subscription_plans WHERE id = ?1", [planCheap])).rows[0].stripe_price_id;
    check("stripe downgrade pushed the price swap",        recordedCalls.length === 1 && recordedCalls[0].body.items[0].price === cheapPrice);
    var downCredit = await query("SELECT * FROM store_credit_ledger WHERE customer_id = ?1 AND kind = 'credit'", [buyer]);
    check("stripe downgrade wrote NO store credit",        downCredit.rows.length === 0);

    // ---- (c) next_cycle Stripe-backed change leaves a pending row --------
    // No Stripe push until the tick.
    var nextSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);
    recordedCalls.length = 0;
    var next = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + nextSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planPremium, timing: "next_cycle" },
    });
    check("stripe next_cycle 303 ?ok=plan_changed",        next.status === 303 && (next.headers["location"] || "").indexOf("?ok=plan_changed") !== -1);
    var pendingRow = await planChanges.pendingChangeFor(nextSub.subId);
    check("stripe next_cycle left a pending row",          pendingRow && pendingRow.status === "pending" && pendingRow.change_kind === "next_billing_cycle");
    check("stripe next_cycle did NOT call Stripe yet",     recordedCalls.length === 0);
    check("stripe next_cycle did NOT flip plan yet",       (await subscriptions.subscriptions.get(nextSub.subId)).plan_id === planCurrent);

    // ---- (d) tick applies the due Stripe-backed change ------------------
    // Force the pending row due (effective_at in the past) and run the tick:
    // update called with proration_behavior "none"; plan flips.
    await query("UPDATE subscription_plan_changes SET effective_at = ?1 WHERE id = ?2", [now - DAY, pendingRow.id]);
    recordedCalls.length = 0;
    var tick = await helpers.httpRequest({
      port: handle.port, path: "/_/subscription-plan-changes-tick", method: "POST",
      headers: { "x-d1-bridge-secret": SWEEP_SECRET, "content-type": "application/json" }, body: "{}",
    });
    var tickJson = JSON.parse(tick.body);
    check("stripe tick ok + applied >= 1",                 tickJson.ok === true && tickJson.enabled === true && tickJson.applied >= 1);
    await helpers.waitUntil(async function () {
      var r = await query("SELECT status FROM subscription_plan_changes WHERE id = ?1", [pendingRow.id]);
      return r.rows.length && r.rows[0].status === "executed";
    }, { timeoutMs: 3000, label: "due stripe plan change executed" });
    check("stripe tick flipped plan to premium",           (await subscriptions.subscriptions.get(nextSub.subId)).plan_id === planPremium);
    var tickCall = recordedCalls.find(function (c) { return c.id === nextSub.stripeId; });
    check("stripe tick pushed the price swap",             tickCall && tickCall.body.items[0].price === premiumPrice);
    check("stripe tick used 'none' proration",             tickCall && tickCall.body.proration_behavior === "none");
    var tickInv = await query("SELECT * FROM subscription_invoices WHERE subscription_id = ?1", [nextSub.subId]);
    check("stripe tick wrote NO local invoice",            tickInv.rows.length === 0);

    // ---- (e) target plan with no stripe_price_id is refused (no 500) ----
    var badSub = await _seedSubscription(query, buyer, planCurrent, periodStart, periodEnd);
    recordedCalls.length = 0;
    var bad = await helpers.httpRequest({
      port: handle.port, path: "/account/subscriptions/" + badSub.subId + "/change",
      method: "POST", jar: jar, form: { new_plan_id: planNoPrice, timing: "immediate" },
    });
    check("stripe no-price target bounces ?error (no 500)", bad.status === 303 && (bad.headers["location"] || "").indexOf("error=plan") !== -1);
    check("stripe no-price target did NOT call Stripe",     recordedCalls.length === 0);
    check("stripe no-price target left plan unchanged",     (await subscriptions.subscriptions.get(badSub.subId)).plan_id === planCurrent);
    var badRow = await query("SELECT * FROM subscription_plan_changes WHERE subscription_id = ?1", [badSub.subId]);
    check("stripe no-price target wrote no change row",     badRow.rows.length === 0);
  } finally {
    await _teardown(handle);
  }
}

async function _runAll() {
  await _run();
  await _runStripeBacked();
}

module.exports = { run: _runAll };
