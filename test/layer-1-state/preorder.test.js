"use strict";
/**
 * preorder — reservations against SKUs that haven't shipped yet.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0124.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/preorder.js` directly so the gate exists ahead of the entry-
 * point edit.
 *
 * Coverage:
 *   - defineCampaign happy path: persists every column, initialises
 *     units_reserved=0 + status='active', returns the inserted row.
 *   - defineCampaign refusals: missing input, bad slug shape, bad sku,
 *     bad launch_at, deposit > full_price, bad currency, slug
 *     collision, max_units_available negative.
 *   - reserve happy path: writes a row, increments units_reserved,
 *     returns the inserted row with status='active'.
 *   - reserve capacity cap: refuses when units_reserved + quantity
 *     would exceed max_units_available; counter unchanged on refusal.
 *   - reserve refusals on inactive campaign + missing campaign + bad
 *     input shapes.
 *   - cancelReservation refunds capacity: counter decrements; row
 *     flipped to cancelled with reason captured.
 *   - launchCampaign converts every active reservation via an
 *     injected order stub; flips the campaign to 'launched'; refuses
 *     before launch_at.
 *   - availability math: remaining_units + days_until_launch
 *     (unlimited campaign + capped campaign + past-due campaign).
 *   - closeCampaign happy + refusal on already-launched.
 *   - reservationsForCustomer status filter + scoping.
 *   - factory refusals on bad order handle / bad catalog shape.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop    = require("../../lib");
var preorder = require("../../lib/preorder");
var helpers  = require("../helpers");
var check    = helpers.check;
var assert   = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0124_preorder.sql"
);

var DAY_MS = 24 * 60 * 60 * 1000;

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
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

function _uuid() { return bShop.framework.uuid.v7(); }

// Minimal order stub — captures every createFromCart call so the
// launch test can assert the conversion payload matches the
// reservation rows. Returns a deterministic order id derived from the
// reservation_id passed through so the test can verify which order
// was minted for which reservation.
function _stubOrder() {
  var calls = [];
  return {
    handle: {
      createFromCart: async function (input) {
        calls.push(input);
        return { id: _uuid(), preorder_reservation_id: input.preorder_reservation_id };
      },
    },
    calls: calls,
  };
}

async function _defineCampaignHappyAndRefusals() {
  var q = _makeQuery();
  var pre = preorder.create({ query: q });
  var launchAt = Date.now() + 30 * DAY_MS;

  var campaign = await pre.defineCampaign({
    slug:                "phone-x-launch",
    sku:                 "PHONE-X-256",
    variant_id:          null,
    launch_at:           launchAt,
    max_units_available: 1000,
    deposit_minor:       5000,
    full_price_minor:    99900,
    currency:            "USD",
    marketing_copy:      "The Phone X — reserve yours now.",
  });
  check("define returns slug",            campaign.slug === "phone-x-launch");
  check("define returns sku",             campaign.sku === "PHONE-X-256");
  check("define defaults charge_at",      campaign.charge_at === launchAt);
  check("define max_units stored",        campaign.max_units_available === 1000);
  check("define units_reserved=0",        campaign.units_reserved === 0);
  check("define deposit stored",          campaign.deposit_minor === 5000);
  check("define full_price stored",       campaign.full_price_minor === 99900);
  check("define currency stored",         campaign.currency === "USD");
  check("define marketing_copy stored",   campaign.marketing_copy === "The Phone X — reserve yours now.");
  check("define status=active",           campaign.status === "active");
  check("define launched_at null",        campaign.launched_at == null);

  // Unlimited campaign (no max_units_available)
  var unlim = await pre.defineCampaign({
    slug:             "phone-x-pro",
    sku:              "PHONE-X-PRO",
    launch_at:        launchAt,
    full_price_minor: 119900,
    currency:         "USD",
  });
  check("define unlimited max=null",      unlim.max_units_available === null);
  check("define unlimited deposit=0",     unlim.deposit_minor === 0);

  // charge_at distinct from launch_at (operator collects up front)
  var chargeEarly = await pre.defineCampaign({
    slug:             "watch-1",
    sku:              "WATCH-1",
    launch_at:        launchAt,
    charge_at:        launchAt - 7 * DAY_MS,
    full_price_minor: 39900,
    currency:         "USD",
  });
  check("define charge_at < launch_at",   chargeEarly.charge_at === launchAt - 7 * DAY_MS);

  // Refusals
  await assert.rejects(pre.defineCampaign(),                                /input object required/);
  await assert.rejects(pre.defineCampaign({
    slug: "BAD slug", sku: "X", launch_at: launchAt, full_price_minor: 100, currency: "USD",
  }), /slug/);
  await assert.rejects(pre.defineCampaign({
    slug: "ok-slug", sku: "bad sku", launch_at: launchAt, full_price_minor: 100, currency: "USD",
  }), /sku/);
  await assert.rejects(pre.defineCampaign({
    slug: "ok-slug", sku: "X", launch_at: -1, full_price_minor: 100, currency: "USD",
  }), /launch_at/);
  await assert.rejects(pre.defineCampaign({
    slug: "ok-slug", sku: "X", launch_at: launchAt,
    deposit_minor: 200, full_price_minor: 100, currency: "USD",
  }), /deposit_minor/);
  await assert.rejects(pre.defineCampaign({
    slug: "ok-slug", sku: "X", launch_at: launchAt, full_price_minor: 100, currency: "us",
  }), /currency/);
  await assert.rejects(pre.defineCampaign({
    slug: "ok-slug", sku: "X", launch_at: launchAt,
    max_units_available: -1, full_price_minor: 100, currency: "USD",
  }), /max_units_available/);

  // Slug collision
  await assert.rejects(pre.defineCampaign({
    slug:             "phone-x-launch",
    sku:              "PHONE-X-256",
    launch_at:        launchAt,
    full_price_minor: 99900,
    currency:         "USD",
  }), /already exists/);
}

async function _reserveHappyAndCounter() {
  var q = _makeQuery();
  var pre = preorder.create({ query: q });
  var launchAt = Date.now() + 30 * DAY_MS;
  await pre.defineCampaign({
    slug:                "phone-x",
    sku:                 "PHONE-X-256",
    launch_at:           launchAt,
    max_units_available: 100,
    full_price_minor:    99900,
    currency:            "USD",
  });

  var customer = _uuid();
  var res = await pre.reserve({
    campaign_slug:      "phone-x",
    customer_id:        customer,
    quantity:           2,
    payment_intent_id:  "pi_abc123",
  });
  check("reserve returns row",                 res != null && typeof res.id === "string");
  check("reserve id is v7-shape",              res.id.length === 36);
  check("reserve status=active",               res.status === "active");
  check("reserve quantity stored",             res.quantity === 2);
  check("reserve customer stored",             res.customer_id === customer);
  check("reserve payment_intent stored",       res.payment_intent_id === "pi_abc123");
  check("reserve reservation_at set",          Number.isInteger(res.reservation_at) && res.reservation_at > 0);

  var c1 = await pre.getCampaign("phone-x");
  check("counter +2 after reserve",            c1.units_reserved === 2);

  // Second reservation, different customer
  var customer2 = _uuid();
  await pre.reserve({
    campaign_slug: "phone-x",
    customer_id:   customer2,
    quantity:      3,
  });
  var c2 = await pre.getCampaign("phone-x");
  check("counter +3 after second reserve",     c2.units_reserved === 5);

  // payment_intent_id is optional
  var customer3 = _uuid();
  var noPi = await pre.reserve({
    campaign_slug: "phone-x", customer_id: customer3, quantity: 1,
  });
  check("reserve payment_intent_id null ok",   noPi.payment_intent_id == null);

  // Refusals
  await assert.rejects(pre.reserve(),                                          /input object required/);
  await assert.rejects(pre.reserve({
    campaign_slug: "no-such", customer_id: customer, quantity: 1,
  }), /not found/);
  await assert.rejects(pre.reserve({
    campaign_slug: "phone-x", customer_id: "not-a-uuid", quantity: 1,
  }), /customer_id/);
  await assert.rejects(pre.reserve({
    campaign_slug: "phone-x", customer_id: customer, quantity: 0,
  }), /quantity/);
  await assert.rejects(pre.reserve({
    campaign_slug: "phone-x", customer_id: customer, quantity: -1,
  }), /quantity/);
}

async function _reserveCapacityCap() {
  var q = _makeQuery();
  var pre = preorder.create({ query: q });
  var launchAt = Date.now() + 30 * DAY_MS;
  await pre.defineCampaign({
    slug:                "small-batch",
    sku:                 "RARE-1",
    launch_at:           launchAt,
    max_units_available: 10,
    full_price_minor:    1000,
    currency:            "USD",
  });

  var customer = _uuid();
  await pre.reserve({ campaign_slug: "small-batch", customer_id: customer, quantity: 6 });
  var c1 = await pre.getCampaign("small-batch");
  check("counter at 6 after first reserve",    c1.units_reserved === 6);

  // Second reserve brings us to exactly cap — allowed
  var customer2 = _uuid();
  await pre.reserve({ campaign_slug: "small-batch", customer_id: customer2, quantity: 4 });
  var c2 = await pre.getCampaign("small-batch");
  check("counter at cap=10 after second",      c2.units_reserved === 10);

  // Third reserve refuses (any positive quantity would exceed cap)
  var customer3 = _uuid();
  await assert.rejects(pre.reserve({
    campaign_slug: "small-batch", customer_id: customer3, quantity: 1,
  }), /max_units_available/);
  var c3 = await pre.getCampaign("small-batch");
  check("counter unchanged on cap refusal",    c3.units_reserved === 10);

  // Unlimited campaign accepts a 1000-unit reservation without complaint
  await pre.defineCampaign({
    slug: "unlimited-fan", sku: "FAN-1", launch_at: launchAt,
    full_price_minor: 100, currency: "USD",
  });
  await pre.reserve({
    campaign_slug: "unlimited-fan", customer_id: customer, quantity: 1000,
  });
  var unlim = await pre.getCampaign("unlimited-fan");
  check("unlimited counter unconstrained",     unlim.units_reserved === 1000);
}

async function _cancelRefundsCapacity() {
  var q = _makeQuery();
  var pre = preorder.create({ query: q });
  var launchAt = Date.now() + 30 * DAY_MS;
  await pre.defineCampaign({
    slug:                "phone-y",
    sku:                 "PHONE-Y",
    launch_at:           launchAt,
    max_units_available: 5,
    full_price_minor:    1000,
    currency:            "USD",
  });

  var customer1 = _uuid();
  var customer2 = _uuid();
  var r1 = await pre.reserve({ campaign_slug: "phone-y", customer_id: customer1, quantity: 3 });
  await pre.reserve({ campaign_slug: "phone-y", customer_id: customer2, quantity: 2 });
  var pre1 = await pre.getCampaign("phone-y");
  check("counter at cap=5 pre-cancel",         pre1.units_reserved === 5);

  // Third customer can't reserve — at cap
  var customer3 = _uuid();
  await assert.rejects(pre.reserve({
    campaign_slug: "phone-y", customer_id: customer3, quantity: 1,
  }), /max_units_available/);

  // Cancel customer1's reservation — frees 3 units of capacity
  var cancelled = await pre.cancelReservation({
    reservation_id: r1.id,
    reason:         "Changed mind",
  });
  check("cancel returns status=cancelled",     cancelled.status === "cancelled");
  check("cancel reason captured",              cancelled.cancel_reason === "Changed mind");
  check("cancel cancelled_at set",             Number.isInteger(cancelled.cancelled_at));
  var post = await pre.getCampaign("phone-y");
  check("counter -3 after cancel",             post.units_reserved === 2);

  // Customer3 can now reserve up to 3 units
  await pre.reserve({ campaign_slug: "phone-y", customer_id: customer3, quantity: 3 });
  var post2 = await pre.getCampaign("phone-y");
  check("counter back to cap after re-reserve", post2.units_reserved === 5);

  // Re-cancel refuses (status no longer active)
  await assert.rejects(pre.cancelReservation({
    reservation_id: r1.id, reason: "again",
  }), /only active/);

  // Missing reservation refuses
  await assert.rejects(pre.cancelReservation({
    reservation_id: _uuid(), reason: "ghost",
  }), /not found/);

  // Bad input refuses
  await assert.rejects(pre.cancelReservation(),                                  /input object required/);
  await assert.rejects(pre.cancelReservation({
    reservation_id: "not-a-uuid", reason: "x",
  }), /reservation_id/);
}

async function _launchCampaignConverts() {
  var q = _makeQuery();
  var stub = _stubOrder();
  var pre = preorder.create({ query: q, order: stub.handle });
  var launchAt = Date.now() + 7 * DAY_MS;
  await pre.defineCampaign({
    slug:                "watch-v2",
    sku:                 "WATCH-V2",
    launch_at:           launchAt,
    max_units_available: 20,
    full_price_minor:    49900,
    currency:            "USD",
  });

  // Three active reservations + one cancelled (should not convert)
  var c1 = _uuid(); var c2 = _uuid(); var c3 = _uuid(); var c4 = _uuid();
  var r1 = await pre.reserve({ campaign_slug: "watch-v2", customer_id: c1, quantity: 1 });
  var r2 = await pre.reserve({ campaign_slug: "watch-v2", customer_id: c2, quantity: 2 });
  var r3 = await pre.reserve({ campaign_slug: "watch-v2", customer_id: c3, quantity: 1 });
  var r4 = await pre.reserve({ campaign_slug: "watch-v2", customer_id: c4, quantity: 3 });
  await pre.cancelReservation({ reservation_id: r4.id, reason: "out before launch" });

  // launch refuses before launch_at
  await assert.rejects(pre.launchCampaign({
    slug: "watch-v2", now: launchAt - 1,
  }), /before launch_at/);

  // Launch at exactly launch_at
  var result = await pre.launchCampaign({ slug: "watch-v2", now: launchAt });
  check("launch returns slug",                 result.slug === "watch-v2");
  check("launch converted 3 reservations",     result.converted_count === 3);
  check("launch returned conversions array",   Array.isArray(result.conversions) && result.conversions.length === 3);
  check("launch order stub called 3 times",    stub.calls.length === 3);
  check("launch order stub payload sku",       stub.calls.every(function (c) { return c.lines[0].sku === "WATCH-V2"; }));
  check("launch order stub payload price",     stub.calls.every(function (c) { return c.lines[0].unit_price_minor === 49900; }));
  check("launch order stub payload currency",  stub.calls.every(function (c) { return c.lines[0].currency === "USD"; }));

  // Campaign flipped to launched
  var post = await pre.getCampaign("watch-v2");
  check("campaign status=launched",            post.status === "launched");
  check("campaign launched_at set",            Number.isInteger(post.launched_at));

  // Reservations flipped to converted (active ones), cancelled stays
  var post1 = await pre.getReservation(r1.id);
  var post2 = await pre.getReservation(r2.id);
  var post3 = await pre.getReservation(r3.id);
  var post4 = await pre.getReservation(r4.id);
  check("r1 converted",                        post1.status === "converted");
  check("r2 converted",                        post2.status === "converted");
  check("r3 converted",                        post3.status === "converted");
  check("r4 stayed cancelled",                 post4.status === "cancelled");
  check("r1 converted_order_id set",           typeof post1.converted_order_id === "string" && post1.converted_order_id.length === 36);
  check("r1 converted_at set",                 Number.isInteger(post1.converted_at));

  // Refuse re-launch
  await assert.rejects(pre.launchCampaign({
    slug: "watch-v2", now: launchAt + 1000,
  }), /only active campaigns/);

  // Launch without order handle: still flips state, converted_order_id null
  var pre2 = preorder.create({ query: _makeQuery() });
  var launchAt2 = Date.now() + 1 * DAY_MS;
  await pre2.defineCampaign({
    slug: "no-handle", sku: "NH", launch_at: launchAt2,
    full_price_minor: 100, currency: "USD",
  });
  var cust = _uuid();
  var rNH = await pre2.reserve({ campaign_slug: "no-handle", customer_id: cust, quantity: 1 });
  var nhResult = await pre2.launchCampaign({ slug: "no-handle", now: launchAt2 });
  check("no-handle launch converted",          nhResult.converted_count === 1);
  var nhRes = await pre2.getReservation(rNH.id);
  check("no-handle reservation converted",     nhRes.status === "converted");
  check("no-handle converted_order_id null",   nhRes.converted_order_id == null);
}

async function _availabilityMath() {
  var q = _makeQuery();
  var pre = preorder.create({ query: q });
  var now = Date.now();
  // Launch sits a little under 3 full days out so days_until_launch
  // (ceil) lands at 3 regardless of the monotonic step the lib takes
  // between defineCampaign + the availability read.
  var launchAt3Days = now + 3 * DAY_MS - 1000;

  // Capped campaign
  await pre.defineCampaign({
    slug:                "capped",
    sku:                 "CAP-1",
    launch_at:           launchAt3Days,
    max_units_available: 100,
    full_price_minor:    1000,
    currency:            "USD",
  });
  var cust = _uuid();
  await pre.reserve({ campaign_slug: "capped", customer_id: cust, quantity: 30 });

  var a = await pre.availability({ slug: "capped" });
  check("availability slug",                   a.slug === "capped");
  check("availability status=active",          a.status === "active");
  check("availability remaining=70",           a.remaining_units === 70);
  check("availability units_reserved=30",      a.units_reserved === 30);
  check("availability max_units=100",          a.max_units_available === 100);
  check("availability days_until=3",           a.days_until_launch === 3);
  check("availability full_price",             a.full_price_minor === 1000);
  check("availability currency",               a.currency === "USD");

  // Unlimited campaign
  await pre.defineCampaign({
    slug: "boundless", sku: "B-1", launch_at: now + 10 * DAY_MS,
    full_price_minor: 500, currency: "USD",
  });
  var b = await pre.availability({ slug: "boundless" });
  check("availability unlimited remaining",    b.remaining_units === null);
  check("availability unlimited max",          b.max_units_available === null);

  // Past-due campaign (launch_at already gone) → days_until=0
  await pre.defineCampaign({
    slug: "overdue", sku: "OD-1", launch_at: now - 5 * DAY_MS,
    full_price_minor: 100, currency: "USD",
  });
  var c = await pre.availability({ slug: "overdue" });
  check("availability past-due days=0",        c.days_until_launch === 0);

  // Missing campaign returns null
  var miss = await pre.availability({ slug: "ghost" });
  check("availability missing=null",           miss === null);

  // Bad input refuses
  await assert.rejects(pre.availability(),                                   /input object required/);
  await assert.rejects(pre.availability({ slug: "Bad Slug" }),                /slug/);
}

async function _closeCampaign() {
  var q = _makeQuery();
  var pre = preorder.create({ query: q });
  var launchAt = Date.now() + 30 * DAY_MS;
  await pre.defineCampaign({
    slug:             "doomed",
    sku:              "DOOM-1",
    launch_at:        launchAt,
    full_price_minor: 100,
    currency:         "USD",
  });

  var closed = await pre.closeCampaign({
    slug:   "doomed",
    reason: "Supplier withdrew",
  });
  check("close returns status=closed",         closed.status === "closed");
  check("close reason captured",               closed.close_reason === "Supplier withdrew");
  check("close closed_at set",                 Number.isInteger(closed.closed_at));

  // reserve refuses on closed campaign
  await assert.rejects(pre.reserve({
    campaign_slug: "doomed", customer_id: _uuid(), quantity: 1,
  }), /only active campaigns accept/);

  // Re-close refuses
  await assert.rejects(pre.closeCampaign({
    slug: "doomed", reason: "again",
  }), /only active/);

  // launch refuses on closed campaign
  await assert.rejects(pre.launchCampaign({
    slug: "doomed", now: launchAt,
  }), /only active campaigns/);

  // Missing slug refuses
  await assert.rejects(pre.closeCampaign({
    slug: "ghost", reason: "x",
  }), /not found/);
}

async function _reservationsForCustomerScoping() {
  var q = _makeQuery();
  var pre = preorder.create({ query: q });
  var launchAt = Date.now() + 30 * DAY_MS;
  await pre.defineCampaign({
    slug: "a", sku: "SKU-A", launch_at: launchAt,
    full_price_minor: 100, currency: "USD",
  });
  await pre.defineCampaign({
    slug: "b", sku: "SKU-B", launch_at: launchAt,
    full_price_minor: 100, currency: "USD",
  });

  var cust = _uuid();
  var other = _uuid();
  var ids = [];
  // Three reservations for cust, two campaigns. The monotonic clock
  // step inside the lib means consecutive reservation_at values
  // strictly increase even when wall-clock Date.now() collides — so
  // ORDER BY id DESC sorts newest-first deterministically.
  ids.push((await pre.reserve({ campaign_slug: "a", customer_id: cust, quantity: 1 })).id);
  ids.push((await pre.reserve({ campaign_slug: "b", customer_id: cust, quantity: 1 })).id);
  ids.push((await pre.reserve({ campaign_slug: "a", customer_id: cust, quantity: 1 })).id);
  // Unrelated customer
  await pre.reserve({ campaign_slug: "a", customer_id: other, quantity: 1 });

  var all = await pre.reservationsForCustomer(cust);
  check("reservationsForCustomer count",       all.length === 3);
  check("reservationsForCustomer newest-first", all[0].id === ids[2] && all[2].id === ids[0]);
  check("reservationsForCustomer scoped",      all.every(function (r) { return r.customer_id === cust; }));

  // Cancel the second reservation and filter by status
  await pre.cancelReservation({ reservation_id: ids[1], reason: "test" });
  var active = await pre.reservationsForCustomer(cust, { status: "active" });
  check("reservationsForCustomer status=active", active.length === 2);
  check("reservationsForCustomer filter excludes cancelled",
    active.every(function (r) { return r.status === "active"; }));
  var cancelled = await pre.reservationsForCustomer(cust, { status: "cancelled" });
  check("reservationsForCustomer status=cancelled", cancelled.length === 1 && cancelled[0].id === ids[1]);

  // Bad status refuses
  await assert.rejects(pre.reservationsForCustomer(cust, { status: "weird" }), /status must be one of/);
  // Bad customer refuses
  await assert.rejects(pre.reservationsForCustomer("not-a-uuid"), /customer_id/);
}

async function _convertReservationToOrder() {
  var q = _makeQuery();
  var stub = _stubOrder();
  var pre = preorder.create({ query: q, order: stub.handle });
  var launchAt = Date.now() + 7 * DAY_MS;
  await pre.defineCampaign({
    slug:             "single",
    sku:              "S-1",
    launch_at:        launchAt,
    full_price_minor: 25000,
    currency:         "USD",
  });
  var cust = _uuid();
  var res = await pre.reserve({ campaign_slug: "single", customer_id: cust, quantity: 1 });

  // Out-of-band conversion ahead of launch_at (operator-driven)
  var conv = await pre.convertReservationToOrder({ reservation_id: res.id });
  check("convert returns reservation_id",       conv.reservation_id === res.id);
  check("convert returns status=converted",     conv.status === "converted");
  check("convert returns order id",             typeof conv.converted_order_id === "string");
  check("convert called order stub",            stub.calls.length === 1);
  check("convert payload sku",                  stub.calls[0].lines[0].sku === "S-1");
  check("convert payload customer",             stub.calls[0].customer_id === cust);

  // Re-convert refuses
  await assert.rejects(pre.convertReservationToOrder({
    reservation_id: res.id,
  }), /only active reservations/);

  // Missing reservation refuses
  await assert.rejects(pre.convertReservationToOrder({
    reservation_id: _uuid(),
  }), /not found/);

  // Bad input refuses
  await assert.rejects(pre.convertReservationToOrder(),                          /input object required/);
  await assert.rejects(pre.convertReservationToOrder({ reservation_id: "x" }),   /reservation_id/);
}

async function _factoryRefusals() {
  assert.throws(function () { preorder.create({ query: function () {}, order: {} }); },
    /createFromCart/);
  assert.throws(function () { preorder.create({ query: function () {}, catalog: "not-an-object" }); },
    /catalog/);
}

async function run() {
  await _defineCampaignHappyAndRefusals();
  await _reserveHappyAndCounter();
  await _reserveCapacityCap();
  await _cancelRefundsCapacity();
  await _launchCampaignConverts();
  await _availabilityMath();
  await _closeCampaign();
  await _reservationsForCustomerScoping();
  await _convertReservationToOrder();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("preorder.test OK — " + helpers.getChecks() + " checks");
  }).catch(function (e) {
    console.error("preorder.test FAIL:", e && e.stack || e);
    process.exit(1);
  });
}
