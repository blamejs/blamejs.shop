"use strict";
/**
 * Win-back lapsed-customer campaign console + send-tick.
 *
 * Boots b.createApp with admin.mount wired to the winbackCampaigns
 * primitive composed the way server.js composes it: a coupon-minter
 * (over autoDiscount), a marketing mailer adapter, an email-suppression
 * gate, and a CONSENT-GATED address resolver (a lapsed customer who
 * withdrew marketing_email consent — or sits on the suppression list —
 * is never emailed). The test drives the authoring → list → activate
 * lifecycle through the browser cookie surface + the bearer JSON
 * contract, then fires the send tick and asserts the design center:
 *
 *   - operator creates a campaign -> appears in /admin/winback; the
 *     bearer list + detail JSON expose it; pause then activate toggles
 *     the archive flag through the console
 *   - a tick scans the order history, enrolls a lapsed customer, sends
 *     step 1 through the gated mailer, mints the step's coupon via the
 *     autoDiscount-backed minter, and records a delivery row
 *   - a SUPPRESSED customer and a MARKETING-WITHDRAWN customer are NOT
 *     emailed (the compliance invariant — CAN-SPAM / GDPR)
 *   - a second tick does NOT re-send step 1 (idempotent: UNIQUE
 *     (enrollment, step) + the conditional FSM advance)
 *
 * The mailer is a capture stub (records every send); network: zero. The
 * monotonic-clock seam is pinned by passing explicit `now` to the tick.
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

var TOKEN = "admin-token-0123456789abcdef-test";
var DAY_MS = 24 * 60 * 60 * 1000;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql",
  "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql",
  "0004_shop_config.sql", "0006_customers.sql",
  "0028_email_suppressions.sql",
  "0107_auto_discount.sql", "0209_auto_discount_unlock_code.sql", "0231_auto_discount_application_unique.sql",
  "0185_consent_ledger.sql", "0232_consent_ledger_lawful_basis.sql",
  "0196_winback_campaigns.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeDb() {
  var db = new DatabaseSync(":memory:");
  // FKs off — we seed order rows without materializing the carts table
  // they reference. The winback FKs (deliveries → enrollments) are not
  // exercised against a drop here.
  db.prepare("PRAGMA foreign_keys = OFF").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return db;
}
function _query(db) {
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

async function _run() {
  var db    = _makeDb();
  var query = _query(db);

  var catalog       = bShop.catalog.create({ query: query });
  var order         = bShop.order.create({ query: query, cursorSecret: "winback-console-order" });
  var config        = bShop.config.create({ query: query });
  var autoDiscount  = bShop.autoDiscount.create({ query: query });
  var suppressions  = bShop.emailSuppressions.create({ query: query, cursorSecret: "winback-suppress-cursor-secret-test-value" });
  var consentLedger = bShop.consentLedger.create({ query: query });

  // Three lapsed customers, all with a paid order ~90 days ago:
  //   amy   — consented, reachable      -> SHOULD receive step 1
  //   bea   — marketing-withdrawn       -> MUST NOT receive
  //   cleo  — email-suppressed          -> MUST NOT receive
  var now = Date.now();
  var lapsedAt = now - 90 * DAY_MS;
  var amy  = "0000000a-0000-7000-8000-00000000aa01";
  var bea  = "0000000a-0000-7000-8000-00000000bb02";
  var cleo = "0000000a-0000-7000-8000-00000000cc03";

  async function _seedCustomer(id, email) {
    var hash = b.crypto.namespaceHash("customer-email", email);
    await query(
      "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      [id, hash, email.split("@")[0], now],
    );
  }
  async function _seedPaidOrder(customerId, createdAt) {
    var id = b.uuid.v7();
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
      " subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
      " ship_to_json, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 5000, 0, 0, 0, 5000, ?5, ?6, ?6)",
      [id, b.uuid.v7(), customerId, "sess-" + customerId, JSON.stringify({ country: "US" }), createdAt],
    );
  }
  await _seedCustomer(amy,  "amy@example.com");
  await _seedCustomer(bea,  "bea@example.com");
  await _seedCustomer(cleo, "cleo@example.com");
  await _seedPaidOrder(amy,  lapsedAt);
  await _seedPaidOrder(bea,  lapsedAt);
  await _seedPaidOrder(cleo, lapsedAt);

  // bea withdrew marketing_email consent (the durable per-customer
  // decision the unsubscribe path records).
  await consentLedger.recordConsentChange({
    customer_id: bea, consent_kind: "marketing_email", state: "withdrawn", source: "preference_center",
  });
  // cleo sits on the marketing suppression list.
  await suppressions.add({ email: "cleo@example.com", suppression_type: "unsubscribe", scope: "marketing", reason: "opted out" });

  // ---- compose the winback handle exactly like server.js -------------
  // Coupon-minter over autoDiscount (single-use, per-customer unlock code).
  var minted = [];
  var couponMinter = {
    mint: async function (mintInput) {
      var kind = mintInput.kind, value = mintInput.value;
      var code = "WB" + b.uuid.v7().replace(/-/g, "").slice(0, 10).toUpperCase();
      var ruleValue;
      if (kind === "percent")            ruleValue = { kind: "percent_off", basis_points: value * 100 };
      else if (kind === "fixed")         ruleValue = { kind: "amount_off_total", minor: value };
      else if (kind === "free_shipping") ruleValue = { kind: "free_shipping" };
      else return null;
      await autoDiscount.defineRule({
        slug: "winback-" + code.toLowerCase(), title: "Win-back offer",
        trigger: { kind: "cart_total_min", min_minor: 1 }, value: ruleValue,
        unlock_code: code, max_redemptions_total: 1, max_redemptions_per_customer: 1,
      });
      minted.push(code);
      return { code: code, customer_id: mintInput.customer_id };
    },
  };

  // Marketing mailer adapter — captures every send.
  var sent = [];
  var mailer = {
    send: async function (msg) { sent.push(msg); return { ok: true, id: "m" + sent.length }; },
  };

  // CONSENT-GATED resolver — the compliance chokepoint. A test address
  // book stands in for the operator's plaintext lookup; the resolver
  // returns an address ONLY when marketing_email is not withdrawn. The
  // suppression list is the SECOND gate (applied by the primitive after
  // the resolver returns), so an unsubscribed OR suppressed lapsed
  // customer is double-gated out.
  var addressBook = {};
  addressBook[amy]  = "amy@example.com";
  addressBook[bea]  = "bea@example.com";
  addressBook[cleo] = "cleo@example.com";
  var resolveEmail = function (enrollment) {
    if (!enrollment || !enrollment.customer_id) return Promise.resolve(null);
    var addr = addressBook[enrollment.customer_id] || null;
    if (!addr) return Promise.resolve(null);
    return consentLedger.currentStateForCustomer(enrollment.customer_id).then(function (state) {
      var marketing = state && state.marketing_email;
      if (marketing && marketing.state === "withdrawn") return null;
      return addr;
    }).catch(function () { return null; });
  };

  var winback = bShop.winbackCampaigns.create({
    query: query, email: mailer, emailSuppressions: suppressions, coupons: couponMinter,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-winback-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        winback: winback,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- nav + empty state --------------------------------------------
    var emptyList = await helpers.httpRequest({ port: port, path: "/admin/winback", jar: jar });
    check("winback list then 200",          emptyList.status === 200);
    check("nav links to winback",            emptyList.body.indexOf("href=\"/admin/winback\"") !== -1);
    check("empty state shown",               emptyList.body.indexOf("No win-back campaigns yet") !== -1);

    // ---- new-campaign form --------------------------------------------
    var newForm = await helpers.httpRequest({ port: port, path: "/admin/winback/new", jar: jar });
    check("new form then 200",               newForm.status === 200);
    check("new form posts to /admin/winback", newForm.body.indexOf("action=\"/admin/winback\"") !== -1);

    // ---- create a campaign with escalating coupon-bearing steps -------
    var create = await helpers.httpRequest({
      port: port, path: "/admin/winback", method: "POST", jar: jar,
      form: {
        slug: "we-miss-you", lapse_days_min: "60",
        steps: "0 | wb-hello\n7 | wb-ten | percent | 10\n14 | wb-twenty | percent | 20",
      },
    });
    check("create then 303",                 create.status === 303);
    check("create redirects ?saved",         (create.headers.location || "").indexOf("saved=1") !== -1);
    var persisted = await winback.getCampaign("we-miss-you");
    check("campaign persisted",              !!persisted && persisted.steps.length === 3);
    check("step 2 carries a 10% coupon",     persisted.steps[1].coupon_kind === "percent" && persisted.steps[1].coupon_value === 10);

    var list = await helpers.httpRequest({ port: port, path: "/admin/winback", jar: jar });
    check("list shows the campaign slug",    list.body.indexOf("we-miss-you") !== -1);
    check("list shows it as active",         list.body.indexOf(">active</span>") !== -1);

    // ---- bearer JSON contract -----------------------------------------
    var listJson = await helpers.httpRequest({ port: port, path: "/admin/winback", headers: bearer });
    var lj = JSON.parse(listJson.body);
    check("bearer list exposes the campaign", lj.campaigns && lj.campaigns.length === 1 && lj.campaigns[0].slug === "we-miss-you");
    var detailJson = await helpers.httpRequest({ port: port, path: "/admin/winback/we-miss-you", headers: bearer });
    var dj = JSON.parse(detailJson.body);
    check("bearer detail exposes metrics",    dj.metrics && dj.metrics.total === 0);
    check("bearer detail exposes delivery log (empty)", Array.isArray(dj.recent_deliveries) && dj.recent_deliveries.length === 0);

    // ---- pause then activate through the console ----------------------
    var pause = await helpers.httpRequest({ port: port, path: "/admin/winback/we-miss-you/pause", method: "POST", jar: jar, form: {} });
    check("pause then 303",                  pause.status === 303);
    check("campaign archived after pause",   (await winback.getCampaign("we-miss-you")).archived_at != null);
    var activate = await helpers.httpRequest({ port: port, path: "/admin/winback/we-miss-you/activate", method: "POST", jar: jar, form: {} });
    check("activate then 303",               activate.status === 303);
    check("campaign active after activate",  (await winback.getCampaign("we-miss-you")).archived_at == null);

    // ---- THE TICK: scan + enroll + send step 1 + mint coupon + log ----
    // lapse_days_min is 60; the three customers lapsed ~90 days ago, so
    // all qualify. The consent-gated resolver + suppression gate must let
    // ONLY amy through; bea (withdrawn) + cleo (suppressed) are gated out.
    sent.length = 0;
    minted.length = 0;
    var tick1 = await winback.runTick({ now: now, resolveEmail: resolveEmail });
    check("tick enrolled all 3 lapsed customers", tick1.enrolled === 3);
    // amy + bea advance their FSM + write a delivery row (the dispatcher
    // walks the sequence regardless of whether the send fired); cleo is
    // dropped from the dispatch when the suppression gate hits — her
    // enrollment is cancelled (her preference applies to every future
    // step), so she is NOT counted in the dispatched set.
    check("tick dispatched 2 steps (amy + bea; cleo suppressed-cancelled)", tick1.dispatched === 2);

    var recipients = sent.map(function (m) { return m.to; });
    check("amy (consented) WAS emailed",          recipients.indexOf("amy@example.com") !== -1);
    check("bea (marketing-withdrawn) was NOT emailed", recipients.indexOf("bea@example.com") === -1);
    check("cleo (suppressed) was NOT emailed",    recipients.indexOf("cleo@example.com") === -1);
    check("exactly one recipient was emailed",    sent.length === 1);

    // cleo's enrollment was cancelled by the suppression gate — she
    // leaves the sequence entirely (no future step will be attempted).
    var cleoEnr = (await query("SELECT * FROM winback_enrollments WHERE customer_id = ?1", [cleo])).rows[0];
    check("cleo (suppressed) enrollment cancelled", cleoEnr && cleoEnr.status === "cancelled");

    // Step 1 (delay 0, slug wb-hello) carries NO coupon, so nothing minted
    // on step 1. Advance amy to step 2 (the 10% step) to prove the mint.
    check("step 1 minted no coupon (wb-hello has none)", minted.length === 0);

    // amy's enrollment exists + advanced to step index 1; a delivery row
    // for step 0 was recorded.
    var amyEnrRows = (await query(
      "SELECT * FROM winback_enrollments WHERE customer_id = ?1 AND campaign_slug = ?2",
      [amy, "we-miss-you"],
    )).rows;
    check("amy enrolled once",                amyEnrRows.length === 1);
    var amyEnr = amyEnrRows[0];
    check("amy advanced to step index 1",     Number(amyEnr.current_step_index) === 1);
    var amyDeliveries = await winback.deliveriesForEnrollment(amyEnr.id);
    check("amy has one step-0 delivery row",  amyDeliveries.length === 1 && amyDeliveries[0].step_index === 0);

    // bea/cleo were gated out of the SEND but still advanced the FSM +
    // logged a delivery row (the dispatcher walks the FSM regardless so
    // the sequence doesn't wedge on a gated recipient). They simply got
    // no mail.
    var beaEnr = (await query("SELECT * FROM winback_enrollments WHERE customer_id = ?1", [bea])).rows[0];
    check("bea enrolled + advanced (no mail)", Number(beaEnr.current_step_index) === 1);

    // ---- second tick: amy reaches the 10% step at now + 7d ------------
    // next_step_at for step 1 is created_at + 7d; advance the clock past
    // it so the dispatcher fires step 2 and the coupon mints.
    sent.length = 0;
    minted.length = 0;
    var tick2 = await winback.runTick({ now: now + 8 * DAY_MS, resolveEmail: resolveEmail });
    check("second tick dispatched the 7-day step", tick2.dispatched >= 1);
    var sentTo2 = sent.map(function (m) { return m.to; });
    check("amy received the 10% step",        sentTo2.indexOf("amy@example.com") !== -1);
    check("the 10% step minted a coupon",     minted.length >= 1);
    var amyDeliveries2 = await winback.deliveriesForEnrollment(amyEnr.id);
    var step1Delivery = amyDeliveries2.filter(function (d) { return d.step_index === 1; })[0];
    check("amy's step-1 delivery carries the minted coupon code",
      !!step1Delivery && typeof step1Delivery.coupon_code === "string" && step1Delivery.coupon_code.indexOf("WB") === 0);
    // The minted code is a real, single-use autoDiscount rule.
    var mintedRule = await autoDiscount.ruleForCode(step1Delivery.coupon_code);
    check("minted code resolves to a single-use autoDiscount rule",
      !!mintedRule && mintedRule.max_redemptions_per_customer === 1);

    // ---- IDEMPOTENCY: re-running the SAME tick re-sends nothing -------
    // Re-fire at the same clock as tick2 — amy is now at step 2 with a
    // future next_step_at, so the (enrollment, step-1) pair is already
    // delivered and the conditional FSM advance + UNIQUE delivery index
    // refuse a second send of that step.
    sent.length = 0;
    minted.length = 0;
    var tick2Again = await winback.runTick({ now: now + 8 * DAY_MS, resolveEmail: resolveEmail });
    check("idempotent re-tick dispatches nothing",  tick2Again.dispatched === 0);
    check("idempotent re-tick sends no mail",        sent.length === 0);
    check("idempotent re-tick mints no coupon",      minted.length === 0);
    var amyDeliveries3 = await winback.deliveriesForEnrollment(amyEnr.id);
    var step1Rows = amyDeliveries3.filter(function (d) { return d.step_index === 1; });
    check("amy still has exactly ONE step-1 delivery row (no duplicate)", step1Rows.length === 1);

    // ---- IDEMPOTENCY: re-enroll is refused -----------------------------
    // A re-scan at the original clock must NOT create a second enrollment
    // for amy (UNIQUE customer+campaign + the existing-row return).
    var reScan = await winback.runTick({ now: now, resolveEmail: resolveEmail });
    check("re-scan enrolls nobody new",       reScan.enrolled === 0);
    var amyEnrAfter = (await query("SELECT COUNT(*) AS n FROM winback_enrollments WHERE customer_id = ?1 AND campaign_slug = ?2", [amy, "we-miss-you"])).rows[0];
    check("amy still enrolled exactly once",  Number(amyEnrAfter.n) === 1);

    // ---- detail screen renders metrics + the delivery log -------------
    var detailHtml = await helpers.httpRequest({ port: port, path: "/admin/winback/we-miss-you", jar: jar });
    check("detail then 200",                  detailHtml.status === 200);
    check("detail shows recovery metrics",    detailHtml.body.indexOf("Recovery") !== -1);
    check("detail shows the delivery log",    detailHtml.body.indexOf("Recent deliveries") !== -1);
    check("detail renders amy's customer id in the log", detailHtml.body.indexOf(amy) !== -1);

    // ---- bad create -> clean 4xx, no partial write --------------------
    var badCreate = await helpers.httpRequest({
      port: port, path: "/admin/winback", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "no-steps", lapse_days_min: 30, steps: [] }),
    });
    check("empty-steps create then 4xx",      badCreate.status >= 400 && badCreate.status < 500);
    check("bad create body has no stack frame", !/\n\s+at\s+\S+\s*\(/.test(badCreate.body));
    check("bad create wrote nothing",         !(await winback.getCampaign("no-steps")));

    // ---- unknown slug -> 404; anon -> sign-in form --------------------
    var missing = await helpers.httpRequest({ port: port, path: "/admin/winback/no-such", headers: bearer });
    check("unknown slug detail then 404",     missing.status === 404);
    var anon = await helpers.httpRequest({ port: port, path: "/admin/winback" });
    check("anon winback -> sign-in form",     anon.status === 200 && anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };

if (require.main === module) {
  _run().then(function () {
    process.stdout.write("admin-winback-console: " + helpers.getChecks() + " checks passed\n");
  }).catch(function (e) { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
}
