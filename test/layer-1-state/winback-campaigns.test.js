"use strict";
/**
 * winbackCampaigns — re-engagement sequences for lapsed customers
 * with audience scan, escalating coupon-bearing steps, dispatcher,
 * and recovery metrics.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0003 (orders), 0006 (customers), and 0196 (winback). The orders
 * + customers schemas are needed so `scanForLapsedCustomers` can
 * walk paid orders to compute the lapse window.
 *
 * Coverage:
 *   - defineCampaign: stores campaign + steps; redefine bumps
 *     updated_at; refusals on bad slug, non-positive lapse_days_min,
 *     max < min, bad coupon_kind, bad audience_filter key,
 *     percent > 100
 *   - scanForLapsedCustomers: returns candidates whose last paid
 *     order is in the lapse window, skips already-enrolled, applies
 *     audience filter (lifetime_orders_min, currency_in)
 *   - enrollCustomer: schedules next_step_at at created_at +
 *     steps[0].delay_days * 24h; idempotent at (campaign, customer)
 *   - dispatchTick: advances through each step, writes deliveries,
 *     lands exhausted after last step, idempotent at (enrollment,
 *     step)
 *   - dispatchTick + suppressions gate cancels enrollment
 *   - dispatchTick + coupons mint records coupon_code
 *   - markRecovered halts sequence + records order_id; idempotent;
 *     rewrites exhausted; refuses on cancelled
 *   - cancelEnrollment pulls out of dispatch queue
 *   - recordStepDelivery direct-record path
 *   - metricsForCampaign: counts + recovery_rate + per-step
 *     deliveries + avg_time_to_purchase
 *
 * The monotonic-clock seam is exercised by passing explicit `now`
 * values to every state-mutating call so the test's row timestamps
 * are deterministic.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var winbackCampaigns = require("../../lib/winback-campaigns");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_WINBACK   = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0196_winback_campaigns.sql"
);
var MIG_ORDERS    = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0003_order.sql"
);
var MIG_ORDERS_PROVIDER = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0228_orders_payment_provider.sql"
);
var MIG_ORDERS_CAPTURE = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0229_orders_paypal_capture_id.sql"
);
var MIG_CUSTOMERS = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0006_customers.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // Foreign keys are off so we don't have to materialize the carts
  // table (orders FK -> carts) just to populate test order rows.
  // The winback primitive's own FK between deliveries → enrollments
  // is exercised by the CASCADE delete path; we don't drop
  // enrollments mid-test.
  db.prepare("PRAGMA foreign_keys = OFF").run();
  var schemas = [MIG_CUSTOMERS, MIG_ORDERS, MIG_ORDERS_PROVIDER, MIG_ORDERS_CAPTURE, MIG_WINBACK];
  for (var i = 0; i < schemas.length; i += 1) {
    var statements = _splitSchema(nodeFs.readFileSync(schemas[i], "utf8"));
    for (var s = 0; s < statements.length; s += 1) {
      db.prepare(statements[s]).run();
    }
  }
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _factory(deps) {
  var query = _makeQuery();
  return {
    query:   query,
    winback: winbackCampaigns.create({
      query:             query,
      order:             (deps && deps.order)             || null,
      customerSegments:  (deps && deps.customerSegments)  || null,
      email:             (deps && deps.email)             || null,
      emailSuppressions: (deps && deps.emailSuppressions) || null,
      coupons:           (deps && deps.coupons)           || null,
    }),
  };
}

// Deterministic clock — bumps on every read.
function _clock(start) {
  var t = start || 1700000000000;
  return function () { t += 1; return t; };
}

// Stable UUIDs (v4-shape) so guardUuid strict accepts them. The
// seed string maps each non-hex character to its hex char code so
// distinct-looking labels ("r1" vs "rl1") produce distinct UUIDs.
function _uuid(seed) {
  var src = String(seed);
  var hex = "";
  for (var i = 0; i < src.length; i += 1) {
    var ch = src.charAt(i);
    if (/[0-9a-f]/i.test(ch)) {
      hex += ch.toLowerCase();
    } else {
      // Two-hex-char encoding of the char code keeps "r1" / "rl1"
      // distinct after the strip.
      var code = src.charCodeAt(i).toString(16);
      hex += code.length === 1 ? "0" + code : code;
    }
  }
  while (hex.length < 32) hex = hex + "0";
  hex = hex.slice(0, 32);
  var v = hex.slice(0, 12) + "4" + hex.slice(13, 16) + "8" + hex.slice(17);
  return (
    v.slice(0, 8) + "-" +
    v.slice(8, 12) + "-" +
    v.slice(12, 16) + "-" +
    v.slice(16, 20) + "-" +
    v.slice(20, 32)
  );
}

var DAY = 24 * 60 * 60 * 1000;

// Insert a paid order row so scanForLapsedCustomers can find it.
async function _seedOrder(query, opts) {
  var orderId    = opts.order_id    || _uuid("o" + opts.customer_id.slice(0, 6) + opts.created_at);
  var cartId     = opts.cart_id     || _uuid("c" + opts.customer_id.slice(0, 6) + opts.created_at);
  var sessionId  = opts.session_id  || _uuid("s" + opts.customer_id.slice(0, 6) + opts.created_at);
  var status     = opts.status      || "paid";
  var currency   = opts.currency    || "USD";
  var grandMinor = opts.grand_total_minor == null ? 10000 : opts.grand_total_minor;
  var shipTo     = opts.ship_to_json || JSON.stringify({ country: opts.country || "US" });
  await query(
    "INSERT INTO orders " +
    "(id, cart_id, customer_id, session_id, status, currency, " +
    " subtotal_minor, discount_minor, tax_minor, shipping_minor, " +
    " grand_total_minor, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, ?7, ?8, ?9, ?9)",
    [orderId, cartId, opts.customer_id, sessionId, status, currency, grandMinor, shipTo, opts.created_at],
  );
  return orderId;
}

// ---- tests --------------------------------------------------------------

async function _defineCampaignHappy() {
  var f = _factory();
  var tick = _clock();

  var c = await f.winback.defineCampaign({
    slug:           "we-miss-you",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0,  template_slug: "wb_hello"  },
      { delay_days: 7,  template_slug: "wb_10pct", coupon_kind: "percent", coupon_value: 10 },
      { delay_days: 14, template_slug: "wb_20pct", coupon_kind: "percent", coupon_value: 20 },
    ],
    audience_filter: { lifetime_orders_min: 2, country_in: ["US", "CA"] },
    now: tick(),
  });
  check("defineCampaign returns row", c && c.slug === "we-miss-you");
  check("defineCampaign stores lapse_days_min", c.lapse_days_min === 60);
  check("defineCampaign lapse_days_max null when unset", c.lapse_days_max === null);
  check("defineCampaign stores 3 steps", c.steps.length === 3);
  check("defineCampaign step 1 has coupon",
    c.steps[1].coupon_kind === "percent" && c.steps[1].coupon_value === 10);
  check("defineCampaign step 0 has no coupon",
    c.steps[0].coupon_kind === null && c.steps[0].coupon_value === null);
  check("defineCampaign audience_filter preserved",
    c.audience_filter.lifetime_orders_min === 2 &&
    JSON.stringify(c.audience_filter.country_in) === '["US","CA"]');
  check("defineCampaign not archived", c.archived_at === null);

  // Redefine — bumps updated_at.
  var c2 = await f.winback.defineCampaign({
    slug:           "we-miss-you",
    lapse_days_min: 90,
    lapse_days_max: 365,
    steps: [
      { delay_days: 0, template_slug: "wb_new" },
    ],
    now: tick(),
  });
  check("redefine bumps lapse_days_min", c2.lapse_days_min === 90);
  check("redefine sets lapse_days_max", c2.lapse_days_max === 365);
  check("redefine collapses steps", c2.steps.length === 1);
  check("redefine bumps updated_at", c2.updated_at > c.updated_at);

  // Refusals.
  await assert.rejects(
    f.winback.defineCampaign({
      slug:  "Bad-Slug",
      lapse_days_min: 60,
      steps: [{ delay_days: 0, template_slug: "x" }],
      now:   tick(),
    }),
    /slug must match/
  );
  await assert.rejects(
    f.winback.defineCampaign({
      slug:           "bad-lapse",
      lapse_days_min: 0,
      steps:          [{ delay_days: 0, template_slug: "x" }],
      now:            tick(),
    }),
    /lapse_days_min must be a positive integer/
  );
  await assert.rejects(
    f.winback.defineCampaign({
      slug:           "bad-range",
      lapse_days_min: 90,
      lapse_days_max: 60,
      steps:          [{ delay_days: 0, template_slug: "x" }],
      now:            tick(),
    }),
    /lapse_days_max .* must be >= lapse_days_min/
  );
  await assert.rejects(
    f.winback.defineCampaign({
      slug:           "bad-coupon-kind",
      lapse_days_min: 60,
      steps:          [{ delay_days: 0, template_slug: "x", coupon_kind: "weird", coupon_value: 1 }],
      now:            tick(),
    }),
    /coupon_kind must be one of/
  );
  await assert.rejects(
    f.winback.defineCampaign({
      slug:           "bad-pct",
      lapse_days_min: 60,
      steps:          [{ delay_days: 0, template_slug: "x", coupon_kind: "percent", coupon_value: 200 }],
      now:            tick(),
    }),
    /<= 100/
  );
  await assert.rejects(
    f.winback.defineCampaign({
      slug:           "bad-audience",
      lapse_days_min: 60,
      steps:          [{ delay_days: 0, template_slug: "x" }],
      audience_filter: { not_a_key: 1 },
      now:            tick(),
    }),
    /audience_filter key 'not_a_key' is not recognized/
  );
  await assert.rejects(
    f.winback.defineCampaign({
      slug:           "empty-steps",
      lapse_days_min: 60,
      steps:          [],
      now:            tick(),
    }),
    /non-empty array/
  );
}

async function _scanForLapsedCustomers() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();
  var nowAsOf = t0 + 1000 * DAY;   // pretend we're far in the future

  await f.winback.defineCampaign({
    slug:           "scan-basic",
    lapse_days_min: 60,
    lapse_days_max: 180,
    steps:          [{ delay_days: 0, template_slug: "wb_hi" }],
    now:            t0,
  });

  // Customer A — last order 90d ago → in window.
  var custA = _uuid("ca");
  await _seedOrder(f.query, {
    customer_id: custA,
    created_at:  nowAsOf - 90 * DAY,
  });

  // Customer B — last order 30d ago → too recent, skip.
  var custB = _uuid("cb");
  await _seedOrder(f.query, {
    customer_id: custB,
    created_at:  nowAsOf - 30 * DAY,
  });

  // Customer C — last order 200d ago → past max, skip.
  var custC = _uuid("cc");
  await _seedOrder(f.query, {
    customer_id: custC,
    created_at:  nowAsOf - 200 * DAY,
  });

  // Customer D — last order 100d ago → in window.
  var custD = _uuid("cd");
  await _seedOrder(f.query, {
    customer_id: custD,
    created_at:  nowAsOf - 100 * DAY,
  });

  // Customer E — refunded order, in-window date → skip (status gate).
  var custE = _uuid("ce");
  await _seedOrder(f.query, {
    customer_id: custE,
    created_at:  nowAsOf - 90 * DAY,
    status:      "refunded",
  });

  var candidates = await f.winback.scanForLapsedCustomers({ as_of: nowAsOf });
  check("scan returns 2 in-window candidates", candidates.length === 2);
  var slugs = candidates.map(function (x) { return x.customer_id; }).sort();
  check("scan candidates are A + D",
    JSON.stringify(slugs) === JSON.stringify([custA, custD].sort()));
  check("scan candidates carry last_order_at",
    candidates[0].last_order_at != null);
  check("scan candidates carry lifetime_orders=1",
    candidates[0].lifetime_orders === 1);

  // Audience filter — lifetime_orders_min: 2 narrows further.
  await f.winback.defineCampaign({
    slug:           "scan-vip",
    lapse_days_min: 60,
    steps:          [{ delay_days: 0, template_slug: "wb_vip" }],
    audience_filter: { lifetime_orders_min: 2 },
    now:            tick(),
  });
  // Give customer A a second paid order so they qualify as VIP.
  await _seedOrder(f.query, {
    customer_id: custA,
    created_at:  nowAsOf - 95 * DAY,
  });
  var vipCandidates = await f.winback.scanForLapsedCustomers({ as_of: nowAsOf });
  var vipForScanVip = vipCandidates.filter(function (x) { return x.campaign_slug === "scan-vip"; });
  check("audience filter narrows to customers with >= 2 orders",
    vipForScanVip.length === 1 && vipForScanVip[0].customer_id === custA);

  // currency_in audience — only EUR-currency last orders qualify.
  await f.winback.defineCampaign({
    slug:           "scan-eur",
    lapse_days_min: 60,
    steps:          [{ delay_days: 0, template_slug: "wb_eur" }],
    audience_filter: { currency_in: ["EUR"] },
    now:            tick(),
  });
  // Make customer D's last order EUR.
  await f.query(
    "UPDATE orders SET currency = 'EUR' WHERE customer_id = ?1",
    [custD],
  );
  var eurCandidates = await f.winback.scanForLapsedCustomers({ as_of: nowAsOf });
  var eurForScan = eurCandidates.filter(function (x) { return x.campaign_slug === "scan-eur"; });
  check("currency_in audience filter narrows to EUR customers",
    eurForScan.length === 1 && eurForScan[0].customer_id === custD);

  // Enroll one + re-scan: it should drop off.
  await f.winback.enrollCustomer({
    campaign_slug: "scan-basic",
    customer_id:   custA,
    now:           nowAsOf,
  });
  var afterEnroll = await f.winback.scanForLapsedCustomers({ as_of: nowAsOf });
  var aInBasic = afterEnroll.filter(function (x) {
    return x.campaign_slug === "scan-basic" && x.customer_id === custA;
  });
  check("scan skips already-enrolled customer for the same campaign",
    aInBasic.length === 0);
}

async function _enrollCustomerSchedulesNextStep() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "enroll-test",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0,  template_slug: "wb_hi" },
      { delay_days: 7,  template_slug: "wb_7d", coupon_kind: "percent", coupon_value: 10 },
      { delay_days: 14, template_slug: "wb_14d", coupon_kind: "percent", coupon_value: 20 },
    ],
    now: t0,
  });

  var customerId = _uuid("e1");
  var t1 = tick();
  var enr = await f.winback.enrollCustomer({
    campaign_slug: "enroll-test",
    customer_id:   customerId,
    now:           t1,
  });
  check("enrollCustomer returns row", enr && enr.id);
  check("enrollCustomer status=active", enr.status === "active");
  check("enrollCustomer current_step_index=0", enr.current_step_index === 0);
  check("enrollCustomer next_step_at = created_at + 0d",
    enr.next_step_at === t1);
  check("enrollCustomer stores customer_id", enr.customer_id === customerId);

  // Idempotent on re-enroll.
  var enr2 = await f.winback.enrollCustomer({
    campaign_slug: "enroll-test",
    customer_id:   customerId,
    now:           tick(),
  });
  check("re-enroll returns same enrollment id", enr2.id === enr.id);
  check("re-enroll keeps original created_at", enr2.created_at === enr.created_at);

  // Refuse unknown campaign.
  await assert.rejects(
    f.winback.enrollCustomer({
      campaign_slug: "never-defined",
      customer_id:   _uuid("ff"),
      now:           tick(),
    }),
    /not found/
  );

  // Refuse missing customer_id.
  await assert.rejects(
    f.winback.enrollCustomer({
      campaign_slug: "enroll-test",
      now:           tick(),
    }),
    /customer_id/
  );

  // Refuse archived campaign.
  await f.winback.defineCampaign({
    slug:           "to-archive",
    lapse_days_min: 60,
    steps:          [{ delay_days: 0, template_slug: "x" }],
    now:            tick(),
  });
  await f.winback.archiveCampaign("to-archive", { now: tick() });
  await assert.rejects(
    f.winback.enrollCustomer({
      campaign_slug: "to-archive",
      customer_id:   _uuid("aa"),
      now:           tick(),
    }),
    /archived/
  );
}

async function _dispatchTickAdvancesSteps() {
  // Mock email captures every send + returns OK.
  var sends = [];
  var mockEmail = {
    send: async function (input) {
      sends.push(input);
      return { ok: true };
    },
  };
  var f = _factory({ email: mockEmail });
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "advance",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0, template_slug: "wb_hi"  },
      { delay_days: 7, template_slug: "wb_7d"  },
      { delay_days: 7, template_slug: "wb_14d" }, // cumulative 14d
    ],
    now: t0,
  });

  var customerId = _uuid("a1");
  var createdAt = t0 + 100;
  var enr = await f.winback.enrollCustomer({
    campaign_slug: "advance",
    customer_id:   customerId,
    now:           createdAt,
  });
  check("enrollment scheduled at +0d",
    enr.next_step_at === createdAt);

  var resolver = async function () { return "buyer@example.com"; };

  // First tick — at created_at (step 0 due).
  var r0 = await f.winback.dispatchTick({
    now:          createdAt,
    resolveEmail: resolver,
  });
  check("tick at created_at dispatches step 0", r0.dispatched === 1);
  check("step 0 has step_index=0", r0.rows[0].step_index === 0);
  check("email send happened for step 0", sends.length === 1);
  check("email template_slug = wb_hi", sends[0].template_slug === "wb_hi");

  var afterStep0 = await f.winback.getEnrollment(enr.id);
  check("FSM advanced to step 1", afterStep0.current_step_index === 1);
  check("next_step_at pinned to created_at + 7d",
    afterStep0.next_step_at === createdAt + 7 * DAY);
  check("status still active mid-sequence", afterStep0.status === "active");

  // Second tick — too early.
  var r0a = await f.winback.dispatchTick({
    now:          createdAt + 3 * DAY,
    resolveEmail: resolver,
  });
  check("early tick dispatches nothing", r0a.dispatched === 0);

  // Third tick — at +7d.
  var r1 = await f.winback.dispatchTick({
    now:          createdAt + 7 * DAY,
    resolveEmail: resolver,
  });
  check("tick @ +7d dispatches step 1", r1.dispatched === 1 && r1.rows[0].step_index === 1);

  var afterStep1 = await f.winback.getEnrollment(enr.id);
  check("FSM advanced to step 2", afterStep1.current_step_index === 2);
  check("next_step_at pinned to created_at + 14d",
    afterStep1.next_step_at === createdAt + 14 * DAY);

  // Fourth tick — last step at +14d.
  var r2 = await f.winback.dispatchTick({
    now:          createdAt + 14 * DAY,
    resolveEmail: resolver,
  });
  check("tick @ +14d dispatches step 2", r2.dispatched === 1 && r2.rows[0].step_index === 2);

  var afterLast = await f.winback.getEnrollment(enr.id);
  check("FSM lands `exhausted` after last step", afterLast.status === "exhausted");
  check("current_step_index advanced past last step",
    afterLast.current_step_index === 3);
  check("next_step_at NULL after exhaustion",
    afterLast.next_step_at === null);

  // Fifth tick — nothing due.
  var r3 = await f.winback.dispatchTick({
    now:          createdAt + 30 * DAY,
    resolveEmail: resolver,
  });
  check("tick after exhaustion dispatches nothing", r3.dispatched === 0);

  // deliveriesForEnrollment returns 3 rows oldest-first.
  var log = await f.winback.deliveriesForEnrollment(enr.id);
  check("deliveriesForEnrollment returns 3 rows", log.length === 3);
  check("delivery log step_index 0/1/2",
    log[0].step_index === 0 && log[1].step_index === 1 && log[2].step_index === 2);
}

async function _dispatchTickSuppressionCancels() {
  var sends = [];
  var mockEmail = {
    send: async function (input) { sends.push(input); return { ok: true }; },
  };
  var mockSuppressions = {
    isSuppressed: async function (input) {
      if (input.email === "blocked@example.com") {
        return { suppressed: true, suppression_type: "complaint" };
      }
      return { suppressed: false };
    },
  };
  var f = _factory({
    email:             mockEmail,
    emailSuppressions: mockSuppressions,
  });
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "supp-test",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0, template_slug: "wb_hi" },
      { delay_days: 7, template_slug: "wb_7d" },
    ],
    now: t0,
  });

  var customerId = _uuid("b1");
  var createdAt = t0 + 100;
  var enr = await f.winback.enrollCustomer({
    campaign_slug: "supp-test",
    customer_id:   customerId,
    now:           createdAt,
  });

  var r = await f.winback.dispatchTick({
    now:          createdAt,
    resolveEmail: async function () { return "blocked@example.com"; },
  });
  check("suppression tick dispatches nothing (cancel path)",
    r.dispatched === 0);
  check("no email send happened for suppressed", sends.length === 0);

  var post = await f.winback.getEnrollment(enr.id);
  check("suppressed enrollment cancelled", post.status === "cancelled");
  check("cancelled_reason recorded", post.cancelled_reason === "complaint");
  check("next_step_at cleared on cancel", post.next_step_at === null);
}

async function _dispatchTickSuppressionFailsClosed() {
  // A suppression-list OUTAGE (isSuppressed throws) must fail CLOSED — the
  // win-back send is cancelled rather than emailing an address that may
  // have opted out while the suppression store is unreachable.
  var sends = [];
  var mockEmail = {
    send: async function (input) { sends.push(input); return { ok: true }; },
  };
  var mockSuppressions = {
    isSuppressed: async function () { throw new Error("suppression store unavailable"); },
  };
  var f = _factory({
    email:             mockEmail,
    emailSuppressions: mockSuppressions,
  });
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "supp-outage",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0, template_slug: "wb_hi" },
      { delay_days: 7, template_slug: "wb_7d" },
    ],
    now: t0,
  });

  var customerId = _uuid("c1");
  var createdAt = t0 + 100;
  var enr = await f.winback.enrollCustomer({
    campaign_slug: "supp-outage",
    customer_id:   customerId,
    now:           createdAt,
  });

  var r = await f.winback.dispatchTick({
    now:          createdAt,
    resolveEmail: async function () { return "maybe-opted-out@example.com"; },
  });
  check("suppression-outage tick dispatches nothing (fail-closed)", r.dispatched === 0);
  check("no email sent when the suppression check is unavailable", sends.length === 0);

  var post = await f.winback.getEnrollment(enr.id);
  check("fail-closed enrollment cancelled", post.status === "cancelled");
  check("fail-closed cancel reason recorded", post.cancelled_reason === "suppression-check-unavailable");
}

async function _dispatchTickMintsCoupon() {
  var mintedCodes = [];
  var mockCoupons = {
    mint: async function (input) {
      var code = "WB-" + input.kind + "-" + input.value + "-" + mintedCodes.length;
      mintedCodes.push({ kind: input.kind, value: input.value, code: code });
      return { code: code };
    },
  };
  var f = _factory({ coupons: mockCoupons });
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "coup-test",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0, template_slug: "wb_hi" }, // no coupon
      { delay_days: 7, template_slug: "wb_15", coupon_kind: "percent", coupon_value: 15 },
    ],
    now: t0,
  });

  var customerId = _uuid("c1");
  var createdAt = t0 + 100;
  var enr = await f.winback.enrollCustomer({
    campaign_slug: "coup-test",
    customer_id:   customerId,
    now:           createdAt,
  });

  // Step 0 — no coupon.
  var r0 = await f.winback.dispatchTick({ now: createdAt });
  check("step 0 dispatched", r0.dispatched === 1);
  check("step 0 has no coupon", r0.rows[0].coupon_code === null);
  check("no coupons minted for step 0", mintedCodes.length === 0);

  // Step 1 — 15% off.
  var r1 = await f.winback.dispatchTick({ now: createdAt + 7 * DAY });
  check("step 1 dispatched", r1.dispatched === 1);
  check("step 1 coupon code recorded",
    typeof r1.rows[0].coupon_code === "string" && r1.rows[0].coupon_code.length > 0);
  check("coupons.mint called once", mintedCodes.length === 1);
  check("minted with kind=percent value=15",
    mintedCodes[0].kind === "percent" && mintedCodes[0].value === 15);

  var log = await f.winback.deliveriesForEnrollment(enr.id);
  check("delivery log carries coupon_code on step 1",
    log[1].coupon_code === mintedCodes[0].code);
  check("delivery log step 0 has null coupon",
    log[0].coupon_code === null);
}

async function _markRecoveredHaltsSequence() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "recov",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0, template_slug: "wb_hi" },
      { delay_days: 7, template_slug: "wb_7d" },
    ],
    now: t0,
  });

  var customerId = _uuid("r1");
  var createdAt = t0 + 100;
  var enr = await f.winback.enrollCustomer({
    campaign_slug: "recov",
    customer_id:   customerId,
    now:           createdAt,
  });

  // Step 0 fires.
  await f.winback.dispatchTick({ now: createdAt });

  // Customer pays.
  var orderId = _uuid("0d1");
  var rec = await f.winback.markRecovered({
    enrollment_id: enr.id,
    order_id:      orderId,
    recovered_at:  createdAt + 2 * DAY,
  });
  check("markRecovered returns changed=true", rec.changed === true);
  check("markRecovered status=recovered", rec.status === "recovered");

  var post = await f.winback.getEnrollment(enr.id);
  check("enrollment terminal=recovered", post.status === "recovered");
  check("recovered_order_id persisted", post.recovered_order_id === orderId);
  check("next_step_at cleared", post.next_step_at === null);

  // Dispatcher does not re-touch a recovered enrollment.
  var afterTick = await f.winback.dispatchTick({ now: createdAt + 30 * DAY });
  check("dispatcher skips recovered enrollment", afterTick.dispatched === 0);

  // Idempotent re-call.
  var rec2 = await f.winback.markRecovered({
    enrollment_id: enr.id,
    order_id:      _uuid("0d2"),
    recovered_at:  createdAt + 5 * DAY,
  });
  check("markRecovered idempotent changed=false", rec2.changed === false);
  var post2 = await f.winback.getEnrollment(enr.id);
  check("idempotent re-call keeps first order_id",
    post2.recovered_order_id === orderId);

  // markRecovered rewrites exhausted → recovered (late-arriving order).
  var customerLate = _uuid("rl1");
  var lateCreated = createdAt + 100;
  var enrLate = await f.winback.enrollCustomer({
    campaign_slug: "recov",
    customer_id:   customerLate,
    now:           lateCreated,
  });
  await f.winback.dispatchTick({ now: lateCreated });
  await f.winback.dispatchTick({ now: lateCreated + 7 * DAY });
  var lateMid = await f.winback.getEnrollment(enrLate.id);
  check("late enrollment exhausted after all steps", lateMid.status === "exhausted");
  await f.winback.markRecovered({
    enrollment_id: enrLate.id,
    order_id:      _uuid("01a"),
    recovered_at:  lateCreated + 10 * DAY,
  });
  var lateFinal = await f.winback.getEnrollment(enrLate.id);
  check("recovered trumps exhausted", lateFinal.status === "recovered");

  // markRecovered on cancelled refuses.
  var enrCx = await f.winback.enrollCustomer({
    campaign_slug: "recov",
    customer_id:   _uuid("rcx"),
    now:           tick(),
  });
  await f.winback.cancelEnrollment({
    enrollment_id: enrCx.id,
    reason:        "operator cancelled",
    cancelled_at:  tick(),
  });
  await assert.rejects(
    f.winback.markRecovered({
      enrollment_id: enrCx.id,
      order_id:      _uuid("0c0"),
    }),
    /cancelled/
  );
}

async function _recordStepDeliveryAndCancel() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "direct",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0, template_slug: "wb_hi" },
      { delay_days: 7, template_slug: "wb_7d" },
    ],
    now: t0,
  });

  var enr = await f.winback.enrollCustomer({
    campaign_slug: "direct",
    customer_id:   _uuid("d1"),
    now:           tick(),
  });

  var rs = await f.winback.recordStepDelivery({
    enrollment_id: enr.id,
    step_index:    0,
    delivered_at:  tick(),
    coupon_code:   "MANUAL-1",
  });
  check("recordStepDelivery changed=true", rs.changed === true);
  check("recordStepDelivery advances to step 1", rs.next_step_index === 1);

  var post = await f.winback.getEnrollment(enr.id);
  check("recordStepDelivery advances enrollment", post.current_step_index === 1);

  var log = await f.winback.deliveriesForEnrollment(enr.id);
  check("recordStepDelivery wrote 1 delivery", log.length === 1);
  check("recordStepDelivery coupon_code persisted",
    log[0].coupon_code === "MANUAL-1");

  // step_index mismatch refuses.
  await assert.rejects(
    f.winback.recordStepDelivery({
      enrollment_id: enr.id,
      step_index:    0,
      delivered_at:  tick(),
    }),
    /does not match/
  );

  // Last step → exhausted.
  await f.winback.recordStepDelivery({
    enrollment_id: enr.id,
    step_index:    1,
    delivered_at:  tick(),
  });
  var done = await f.winback.getEnrollment(enr.id);
  check("recordStepDelivery on last step → exhausted", done.status === "exhausted");

  // cancelEnrollment pulls a separate enrollment out.
  var enr2 = await f.winback.enrollCustomer({
    campaign_slug: "direct",
    customer_id:   _uuid("d2"),
    now:           tick(),
  });
  var cx = await f.winback.cancelEnrollment({
    enrollment_id: enr2.id,
    reason:        "operator cancelled — feedback survey",
    cancelled_at:  tick(),
  });
  check("cancelEnrollment changed=true", cx.changed === true);
  check("cancelEnrollment status=cancelled", cx.status === "cancelled");
  var post2 = await f.winback.getEnrollment(enr2.id);
  check("cancelled enrollment has no next_step_at", post2.next_step_at === null);
  check("cancelled_reason recorded",
    post2.cancelled_reason === "operator cancelled — feedback survey");

  // Re-cancel is no-op.
  var noop = await f.winback.cancelEnrollment({
    enrollment_id: enr2.id,
    reason:        "again",
    cancelled_at:  tick(),
  });
  check("re-cancel is no-op", noop.changed === false);
}

async function _metricsForCampaign() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.winback.defineCampaign({
    slug:           "metrics",
    lapse_days_min: 60,
    steps: [
      { delay_days: 0, template_slug: "wb_hi" },
      { delay_days: 7, template_slug: "wb_7d" },
    ],
    now: t0,
  });

  // Enroll 5 customers staggered by 1ms.
  var enrollments = [];
  for (var i = 0; i < 5; i += 1) {
    var enr = await f.winback.enrollCustomer({
      campaign_slug: "metrics",
      customer_id:   _uuid("m" + i),
      now:           t0 + 100 + i,
    });
    enrollments.push(enr);
  }

  // Dispatch step 0 for all 5.
  await f.winback.dispatchTick({ now: t0 + 200 });

  // Recover 2 of them at different times to exercise avg_time_to_purchase.
  await f.winback.markRecovered({
    enrollment_id: enrollments[0].id,
    order_id:      _uuid("o0"),
    recovered_at:  t0 + 100 + 1 * DAY,    // 1 day after enroll
  });
  await f.winback.markRecovered({
    enrollment_id: enrollments[1].id,
    order_id:      _uuid("o1"),
    recovered_at:  t0 + 100 + 1 + 3 * DAY, // 3 days after enroll
  });

  // Cancel 1.
  await f.winback.cancelEnrollment({
    enrollment_id: enrollments[2].id,
    reason:        "manual",
    cancelled_at:  t0 + 200,
  });

  // Finish the remaining 2 (step 1 fires → exhausted).
  await f.winback.dispatchTick({ now: t0 + 100 + 5 + 7 * DAY });

  var from = t0;
  var to   = t0 + 30 * DAY;
  var m = await f.winback.metricsForCampaign({ slug: "metrics", from: from, to: to });
  check("metrics total=5", m.total === 5);
  check("metrics recovered=2", m.counts.recovered === 2);
  check("metrics exhausted=2", m.counts.exhausted === 2);
  check("metrics cancelled=1", m.counts.cancelled === 1);
  check("metrics active=0", m.counts.active === 0);
  check("metrics recovery_rate=0.4",
    Math.abs(m.recovery_rate - 0.4) < 1e-9);
  // avg_time_to_purchase ≈ (1d + 3d) / 2 = 2d (in ms)
  check("metrics avg_time_to_purchase is positive",
    m.avg_time_to_purchase_ms > 0);
  check("metrics avg_time_to_purchase ≈ 2d",
    Math.abs(m.avg_time_to_purchase_ms - 2 * DAY) < 1000);
  // Step 0 delivered 5 times; step 1 delivered for the 2 not-yet-terminal
  // enrollments before they marked recovered or cancelled — actually only
  // the 2 that weren't terminal: enrollments[3] and [4].
  check("per-step deliveries step 0 = 5",
    m.per_step_deliveries["0"] === 5);
  check("per-step deliveries step 1 = 2",
    m.per_step_deliveries["1"] === 2);
  check("total_deliveries = 7", m.total_deliveries === 7);

  // Zero-row campaign returns recovery_rate=0 (not NaN).
  await f.winback.defineCampaign({
    slug:           "empty-metrics",
    lapse_days_min: 60,
    steps:          [{ delay_days: 0, template_slug: "wb_e" }],
    now:            tick(),
  });
  var mEmpty = await f.winback.metricsForCampaign({
    slug: "empty-metrics",
    from: from,
    to:   to,
  });
  check("empty metrics total=0", mEmpty.total === 0);
  check("empty metrics recovery_rate=0", mEmpty.recovery_rate === 0);
  check("empty metrics avg_time_to_purchase=0",
    mEmpty.avg_time_to_purchase_ms === 0);

  // Unknown campaign refuses.
  await assert.rejects(
    f.winback.metricsForCampaign({
      slug: "never-defined",
      from: from,
      to:   to,
    }),
    /not found/
  );

  // from > to refuses.
  await assert.rejects(
    f.winback.metricsForCampaign({
      slug: "metrics",
      from: to,
      to:   from,
    }),
    /to .* must be >= from/
  );
}

async function run() {
  await _defineCampaignHappy();
  await _scanForLapsedCustomers();
  await _enrollCustomerSchedulesNextStep();
  await _dispatchTickAdvancesSteps();
  await _dispatchTickSuppressionCancels();
  await _dispatchTickSuppressionFailsClosed();
  await _dispatchTickMintsCoupon();
  await _markRecoveredHaltsSequence();
  await _recordStepDeliveryAndCancel();
  await _metricsForCampaign();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7, guardUuid)
  // wires before the first test runs.
  void bShop;
  run().then(function () {
    process.stdout.write("winback-campaigns.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("winback-campaigns.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
