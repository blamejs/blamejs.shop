"use strict";
/**
 * cartRecoveryPass — end-to-end abandoned-cart recovery orchestration.
 *
 * Drives the real scanner (cart-abandonment) + nurture FSM
 * (cart-recovery) + consent gate (consent-ledger) through one
 * `runPass()` tick against an in-memory node:sqlite loaded from the
 * shipping migrations (0001 catalog, 0002 cart, 0031 abandonment,
 * 0171 recovery, 0185 consent-ledger).
 *
 * Coverage:
 *   - detection picks the right abandoned carts: enrols an idle
 *     logged-in cart, EXCLUDES a too-recent cart, a guest cart (no
 *     customer_id), and an opted-out customer
 *   - one recovery email per cart, addressed via the resolver, with a
 *     cart link
 *   - idempotent across ticks: re-running the pass does not enrol the
 *     same cart twice and does not re-send a step already sent
 *   - opt-out respected: a `withdrawn` marketing_email consent row
 *     keeps the customer out of the sequence (no enrolment, no send)
 *   - no deliverable address → skipped, not enrolled
 *   - gate: with no email primitive / no resolver the pass no-ops
 *     cleanly (enabled:false), without scanning
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0004_shop_config.sql",
  "0028_email_suppressions.sql",
  "0031_cart_abandonment_runs.sql",
  "0171_cart_recovery.sql",
  "0185_consent_ledger.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

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
  function query(sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return Promise.resolve({
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      });
    }
    var rows = stmt.all.apply(stmt, params || []);
    return Promise.resolve({ rows: rows, rowCount: rows.length });
  }
  query.raw = db;
  return query;
}

var HOUR = 60 * 60 * 1000;

// A v4-shaped UUID the strict guardUuid gate accepts.
function _uuid(seed) {
  var hex = String(seed).replace(/[^0-9a-f]/gi, "").toLowerCase();
  while (hex.length < 32) hex = hex + "0";
  hex = hex.slice(0, 32);
  var v = hex.slice(0, 12) + "4" + hex.slice(13, 16) + "8" + hex.slice(17);
  return (
    v.slice(0, 8) + "-" + v.slice(8, 12) + "-" + v.slice(12, 16) + "-" +
    v.slice(16, 20) + "-" + v.slice(20, 32)
  );
}

function _newSessionId(seed) {
  return "sess_" + String(seed).padEnd(12, "x").slice(0, 12);
}

async function _setupCatalog(catalog) {
  var p = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", status: "active" });
  var v1 = await catalog.variants.create(p.id, { sku: "WDG-PRO-A" });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2999 });
  return { v1: v1 };
}

// Seed an idle cart with a line, optionally owned by a customer, then
// backdate it past the idle threshold so the scanner detects it.
async function _seedIdleCart(query, cart, variant, opts) {
  opts = opts || {};
  var sid = _newSessionId(opts.seed || Math.random().toString(36).slice(2));
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: variant.id, qty: 1 });
  if (opts.customer_id) {
    await cart.setCustomer(c.id, opts.customer_id);
  }
  var idleSince = Date.now() - (opts.hoursIdle == null ? 6 : opts.hoursIdle) * HOUR;
  await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [idleSince, c.id]);
  await query("UPDATE cart_lines SET added_at = ?1, updated_at = ?1 WHERE cart_id = ?2", [idleSince, c.id]);
  return { id: c.id, session_id: sid };
}

// Build a fully-wired pass with mock email + resolver. The resolver
// maps customer_id → a synthetic address; `null` customers (guests)
// never reach it.
function _buildPass(query, opts) {
  opts = opts || {};
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var consentLedger = bShop.consentLedger.create({ query: query });

  var sends = [];
  var mockEmail = opts.noEmail ? null : {
    sendAbandonedCartReminder: async function (input) {
      sends.push(input);
      return { ok: true };
    },
  };

  var emailToCustomer = opts.emailToCustomer || {};   // customer_id → address | null
  var resolver = opts.noResolver ? null : function (candidate) {
    var addr = Object.prototype.hasOwnProperty.call(emailToCustomer, candidate.customer_id)
      ? emailToCustomer[candidate.customer_id]
      : (candidate.customer_id + "@example.com");
    return Promise.resolve(addr);
  };

  var pass = bShop.cartRecoveryPass.create({
    cartAbandonment: bShop.cartAbandonment.create({ query: query, cart: cart }),
    cartRecovery:    bShop.cartRecovery.create({
      query:             query,
      email:             mockEmail,
      emailSuppressions: bShop.emailSuppressions.create({ query: query }),
    }),
    config:        bShop.config.create({ query: query }),
    consentLedger: consentLedger,
    cartUrlBase:   "https://shop.example/cart",
    resolveEmail:  resolver,
  });

  return {
    catalog:       catalog,
    cart:          cart,
    consentLedger: consentLedger,
    pass:          pass,
    sends:         sends,
  };
}

// ---- scenarios ----------------------------------------------------------

async function _enrolsAndSendsForEligibleCarts() {
  var query = _makeQuery();
  var custA = _uuid("a1");
  var custB = _uuid("b2");
  var custOut = _uuid("c3");

  var ctx = _buildPass(query, {});
  var fix = await _setupCatalog(ctx.catalog);

  // Eligible: two idle logged-in carts with consent on file.
  var cartA = await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "ca", hoursIdle: 6, customer_id: custA });
  var cartB = await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "cb", hoursIdle: 8, customer_id: custB });

  // EXCLUDED — guest cart (no customer_id): no recoverable address.
  await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "cg", hoursIdle: 6 });

  // EXCLUDED — too recent (< 4h default threshold).
  await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "cf", hoursIdle: 1, customer_id: _uuid("d4") });

  // EXCLUDED — opted out (withdrawn marketing consent).
  var cartOut = await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "co", hoursIdle: 6, customer_id: custOut });
  await ctx.consentLedger.recordConsentChange({
    customer_id:  custOut,
    consent_kind: "marketing_email",
    state:        "withdrawn",
    source:       "preference_center",
  });

  var now = Date.now();
  var r = await ctx.pass.runPass({ now: now });

  check("pass enabled", r.enabled === true && r.ok === true);
  check("default threshold 4h", r.after_hours === 4);
  // 4 detected (A, B, guest, opted-out) — every idle cart WITH lines
  // past the 4h threshold. The too-recent cart (1h idle) is below the
  // threshold so the scanner never reaches it. Eligibility filtering
  // (guest / opt-out) happens AFTER detection, at enrol time.
  check("detected the 4 carts past threshold", r.detected === 4);
  check("enrolled exactly 2 eligible carts", r.enrolled === 2);
  check("guest cart skipped (no customer)", r.skipped_no_customer === 1);
  check("opted-out cart skipped", r.skipped_opt_out === 1);

  // One email per enrolled cart's first step (the +1h reminder fires
  // immediately because enrolled_at + 1h... no — the first step is
  // scheduled at enrolled_at + offset, so the same-tick dispatch sends
  // nothing yet). Advance a tick to fire step 0.
  check("no send on the enrol tick (step 0 scheduled +1h)", ctx.sends.length === 0);

  // Tick again 1h later → step 0 dispatches for both enrolled carts.
  var r2 = await ctx.pass.runPass({ now: now + HOUR + 1000 });
  check("second tick dispatched 2 step-0 emails", r2.dispatched === 2);
  check("email primitive called once per enrolled cart", ctx.sends.length === 2);
  check("recovery email carries a cart link",
    ctx.sends[0].cart_url.indexOf("https://shop.example/cart/") === 0);

  // The enrolled carts are A and B (not the guest / recent / opted-out).
  var addrs = ctx.sends.map(function (s) { return s.customer_email; }).sort();
  check("emails addressed to the two eligible customers",
    addrs[0] === custA + "@example.com" && addrs[1] === custB + "@example.com");

  void cartA; void cartB; void cartOut;
}

async function _idempotentAcrossTicks() {
  var query = _makeQuery();
  var custA = _uuid("e5");

  var ctx = _buildPass(query, {});
  var fix = await _setupCatalog(ctx.catalog);
  await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "ci", hoursIdle: 6, customer_id: custA });

  var now = Date.now();

  // First pass — enrols the cart.
  var r1 = await ctx.pass.runPass({ now: now });
  check("first pass enrols 1", r1.enrolled === 1);

  // Second pass at the same logical time — the scanner is window-
  // idempotent (cart already detected this window) AND the detection
  // is already marked sent, so NO re-enrolment.
  var r2 = await ctx.pass.runPass({ now: now + 1000 });
  check("second pass enrols 0 (no re-detect / re-enrol)", r2.enrolled === 0);

  // Fire step 0 once.
  var r3 = await ctx.pass.runPass({ now: now + HOUR + 1000 });
  check("step 0 dispatched once", r3.dispatched === 1);
  check("exactly one send for the cart so far", ctx.sends.length === 1);

  // Re-tick at the same logical time — step already sent, FSM advanced
  // past it, so no second send for step 0.
  var r4 = await ctx.pass.runPass({ now: now + HOUR + 2000 });
  check("no double-send for step 0", r4.dispatched === 0);
  check("still exactly one send", ctx.sends.length === 1);
}

async function _noDeliverableAddressSkips() {
  var query = _makeQuery();
  var custA = _uuid("f6");

  var emailToCustomer = {};
  emailToCustomer[custA] = null;   // resolver returns null → no address

  var ctx = _buildPass(query, { emailToCustomer: emailToCustomer });
  var fix = await _setupCatalog(ctx.catalog);
  await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "cn", hoursIdle: 6, customer_id: custA });

  var r = await ctx.pass.runPass({ now: Date.now() });
  check("no-address cart not enrolled", r.enrolled === 0);
  check("no-address cart counted skipped", r.skipped_no_email === 1);
  check("no email sent", ctx.sends.length === 0);
}

async function _optOutRespectedNoEnrolment() {
  var query = _makeQuery();
  var custA = _uuid("a7");

  var ctx = _buildPass(query, {});
  var fix = await _setupCatalog(ctx.catalog);
  await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "cv", hoursIdle: 6, customer_id: custA });

  // Grant then later withdraw — latest decision wins (withdrawn).
  await ctx.consentLedger.recordConsentChange({
    customer_id:  custA,
    consent_kind: "marketing_email",
    state:        "granted",
    source:       "signup_form",
  });
  await ctx.consentLedger.recordConsentChange({
    customer_id:  custA,
    consent_kind: "marketing_email",
    state:        "withdrawn",
    source:       "preference_center",
  });

  var r = await ctx.pass.runPass({ now: Date.now() });
  check("withdrawn-consent cart not enrolled", r.enrolled === 0);
  check("withdrawn-consent cart counted opt-out", r.skipped_opt_out === 1);
  check("no email sent to opted-out customer", ctx.sends.length === 0);
}

async function _grantedConsentStillEnrols() {
  var query = _makeQuery();
  var custA = _uuid("b8");

  var ctx = _buildPass(query, {});
  var fix = await _setupCatalog(ctx.catalog);
  await _seedIdleCart(query, ctx.cart, fix.v1, { seed: "cp", hoursIdle: 6, customer_id: custA });

  await ctx.consentLedger.recordConsentChange({
    customer_id:  custA,
    consent_kind: "marketing_email",
    state:        "granted",
    source:       "signup_form",
  });

  var r = await ctx.pass.runPass({ now: Date.now() });
  check("granted-consent cart enrols", r.enrolled === 1);
  check("granted-consent cart not counted opt-out", r.skipped_opt_out === 0);
}

async function _gateNoOpsWhenUnconfigured() {
  // No email primitive wired → the pass must no-op cleanly without
  // scanning. An eligible idle cart is present; the gate fires before
  // the scan so the cart is never touched.
  var query1 = _makeQuery();
  var ctxNoEmail = _buildPass(query1, { noEmail: true });
  var fix = await _setupCatalog(ctxNoEmail.catalog);
  await _seedIdleCart(query1, ctxNoEmail.cart, fix.v1, {
    seed: "cx", hoursIdle: 6, customer_id: _uuid("c9"),
  });

  var r1 = await ctxNoEmail.pass.runPass({ now: Date.now() });
  check("no-email gate: enabled=false", r1.enabled === false);
  check("no-email gate: ok=true (clean no-op)", r1.ok === true);
  check("no-email gate: did not scan (no detected count)", r1.detected === undefined);
  // Belt-and-suspenders: the inert pass wrote no abandonment run row.
  var runs = (await query1("SELECT COUNT(*) AS n FROM cart_abandonment_runs")).rows[0];
  check("no-email gate: no scan run row written", Number(runs.n) === 0);

  // No resolver wired → same inert no-op.
  var query2 = _makeQuery();
  var ctxNoResolver = _buildPass(query2, { noResolver: true });
  var r2 = await ctxNoResolver.pass.runPass({ now: Date.now() });
  check("no-resolver gate: enabled=false", r2.enabled === false);
  check("no-resolver gate: ok=true", r2.ok === true);
}

async function _badThresholdConfigThrowsAtBoundary() {
  // An out-of-range stored threshold is an operator config error —
  // the config-read boundary throws. The pass catches it (drop-silent)
  // and reports ok:false rather than crashing the cron.
  var query = _makeQuery();
  var ctx = _buildPass(query, {});
  await _setupCatalog(ctx.catalog);
  var cfg = bShop.config.create({ query: query });
  await cfg.put("shop.cart_recovery_after_hours", 0);   // below MIN (1)

  var r = await ctx.pass.runPass({ now: Date.now() });
  check("bad threshold → ok:false (caught, not thrown)", r.ok === false);
  check("bad threshold → error mentions the key",
    typeof r.error === "string" && r.error.indexOf("cart_recovery_after_hours") !== -1);
  check("bad threshold → pass did not throw out of runPass", true);
}

async function run() {
  await _enrolsAndSendsForEligibleCarts();
  await _idempotentAcrossTicks();
  await _noDeliverableAddressSkips();
  await _optOutRespectedNoEnrolment();
  await _grantedConsentStillEnrols();
  await _gateNoOpsWhenUnconfigured();
  await _badThresholdConfigThrowsAtBoundary();
}

module.exports = { run: run };

if (require.main === module) {
  void bShop;
  run().then(function () {
    process.stdout.write("cart-recovery-pass.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("cart-recovery-pass.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
