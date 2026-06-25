"use strict";
/**
 * affiliates — partner program with attribution + commission events.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0057.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/affiliates.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - registerAffiliate happy path (id / code shape / email hashing /
 *     defaults) + refusal classes (missing input, bad enums, oversize,
 *     control bytes, zero-width)
 *   - commission math per kind (percent_bps floor, amount_per_order,
 *     amount_per_signup) + idempotency on (order_id, affiliate_id)
 *   - attribution_window_days expiry — visit just inside the window
 *     resolves; one just outside drops to null
 *   - recordVisit dedup within the calendar-minute window; refusals
 *     on unknown / paused affiliate
 *   - commissionsForAffiliate cursor pagination + tamper refusal +
 *     status_filter + from/to range
 *   - FSM transitions: pending -> paid + pending -> voided + every
 *     refused edge from non-pending states
 *   - payoutsDue: threshold sum + sort + active/voided isolation
 *   - topAffiliates: ranking in window + voided exclusion + limit
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop      = require("../../lib");
var affiliates = require("../../lib/affiliates");
var helpers    = require("../helpers");
var check      = helpers.check;
var assert     = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0057_affiliates.sql"
);

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
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

function _setup() {
  var query = _makeQuery();
  var aff   = affiliates.create({
    query:        query,
    cursorSecret: "affiliates-test-secret",
  });
  return { query: query, affiliates: aff };
}

function _validRegister(overrides) {
  return Object.assign({
    name:                    "Acme Partners",
    email:                   "partner@example.com",
    payout_method:           "paypal",
    payout_address:          "partner@example.com",
    commission_kind:         "percent_bps",
    commission_value:        1500,
    attribution_window_days: 30,
  }, overrides || {});
}

async function _registerHappyPath() {
  var ctx = _setup();
  var a = await ctx.affiliates.registerAffiliate(_validRegister());
  check("register returns 36-char uuid id",      typeof a.id === "string" && a.id.length === 36);
  check("register stamps code length 8",         typeof a.code === "string" && a.code.length === 8);
  check("register code in alphabet",             /^[A-HJ-NP-Z2-9]{8}$/.test(a.code));
  check("register stamps active=1",              Number(a.active) === 1);
  check("register stores name",                  a.name === "Acme Partners");
  check("register hashes email (hex sha3-512)",  typeof a.email_hash === "string" && /^[0-9a-f]{128}$/.test(a.email_hash));
  check("register does NOT store raw email",     Object.keys(a).indexOf("email") === -1);
  check("register stores normalised email",      a.email_normalised === "partner@example.com");
  check("register persists commission_kind",     a.commission_kind === "percent_bps");
  check("register persists commission_value",    Number(a.commission_value) === 1500);
  check("register persists attribution_window",  Number(a.attribution_window_days) === 30);
  check("register opens with paused_at=null",    a.paused_at == null);
  check("register stamps created_at",            typeof a.created_at === "number");

  // Email casing normalised on hash key.
  var a2 = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "OTHER@Example.COM",
    name:  "Other Partner",
  }));
  check("register normalises email casing",      a2.email_normalised === "other@example.com");

  // byCode resolves the public handle (case + dash forgiving).
  var byCode = await ctx.affiliates.affiliateByCode(a.code.toLowerCase().slice(0, 4) + "-" + a.code.toLowerCase().slice(4));
  check("affiliateByCode resolves canonicalised", byCode && byCode.id === a.id);

  // get by id.
  var got = await ctx.affiliates.getAffiliate(a.id);
  check("getAffiliate resolves by id",            got && got.id === a.id);

  // listAffiliates default returns both; active_only also returns
  // both since neither is paused yet.
  var listed = await ctx.affiliates.listAffiliates();
  check("listAffiliates returns all",             listed.length === 2);
  var listedActive = await ctx.affiliates.listAffiliates({ active_only: true });
  check("listAffiliates active_only matches",     listedActive.length === 2);
}

async function _registerRefusals() {
  var ctx = _setup();
  await assert.rejects(ctx.affiliates.registerAffiliate(),                                       /input object required/);
  // missing name
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ name: "" })),           /name/);
  // missing/bad email
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ email: "" })),          /email/);
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ email: "not-email" })), /email/);
  // bad payout_method
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ payout_method: "btc" })),  /payout_method/);
  // missing payout_address
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ payout_address: "" })),    /payout_address/);
  // bad commission_kind
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ commission_kind: "wat" })), /commission_kind/);
  // bad commission_value (negative)
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ commission_value: -1 })),   /commission_value/);
  // percent_bps over 10000
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ commission_value: 10001 })), /commission_value/);
  // attribution_window_days zero / oversize / non-integer
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ attribution_window_days: 0 })),  /attribution_window_days/);
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ attribution_window_days: 999 })), /attribution_window_days/);
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ attribution_window_days: 1.5 })), /attribution_window_days/);
  // control byte in name
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({ name: "bad\x01name" })), /name/);
  // zero-width in name
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({
    name: "bad" + String.fromCharCode(0x200B) + "name",
  })), /zero-width/);
  // oversize name
  await assert.rejects(ctx.affiliates.registerAffiliate(_validRegister({
    name: "x".repeat(201),
  })), /name/);
}

async function _commissionMath() {
  var ctx = _setup();
  // Three affiliates, one per commission_kind.
  var pctAff = await ctx.affiliates.registerAffiliate(_validRegister({
    email:           "pct@example.com",
    commission_kind: "percent_bps",
    commission_value: 1250, // 12.5%
  }));
  var flatOrderAff = await ctx.affiliates.registerAffiliate(_validRegister({
    email:           "flat-o@example.com",
    commission_kind: "amount_per_order_minor",
    commission_value: 500, // $5.00 minor
  }));
  var flatSignupAff = await ctx.affiliates.registerAffiliate(_validRegister({
    email:           "flat-s@example.com",
    commission_kind: "amount_per_signup_minor",
    commission_value: 1000, // $10.00 minor
  }));

  // percent_bps math — order_total 10000 minor, 12.5% -> 1250.
  var c1 = await ctx.affiliates.recordCommissionEvent({
    order_id:          _validUUID(),
    affiliate_id:      pctAff.id,
    order_total_minor: 10000,
    currency:          "USD",
  });
  check("percent_bps commission_minor exact",    Number(c1.commission_minor) === 1250);
  check("percent_bps preserves order_total",     Number(c1.order_total_minor) === 10000);
  check("percent_bps status starts pending",     c1.status === "pending");
  check("percent_bps stores currency",           c1.currency === "USD");

  // percent_bps floor — 12345 minor * 1250 / 10000 = 1543.125 -> 1543.
  var c2 = await ctx.affiliates.recordCommissionEvent({
    order_id:          _validUUID(),
    affiliate_id:      pctAff.id,
    order_total_minor: 12345,
    currency:          "USD",
  });
  check("percent_bps floors sub-cent dust",      Number(c2.commission_minor) === 1543);

  // amount_per_order_minor — flat $5 regardless of total.
  var c3 = await ctx.affiliates.recordCommissionEvent({
    order_id:          _validUUID(),
    affiliate_id:      flatOrderAff.id,
    order_total_minor: 99999,
    currency:          "USD",
  });
  check("amount_per_order_minor returns flat",   Number(c3.commission_minor) === 500);

  // amount_per_signup_minor — flat $10 regardless of total.
  var c4 = await ctx.affiliates.recordCommissionEvent({
    order_id:          _validUUID(),
    affiliate_id:      flatSignupAff.id,
    order_total_minor: 1, // tiny order; signup payout still fires
    currency:          "USD",
  });
  check("amount_per_signup_minor returns flat",  Number(c4.commission_minor) === 1000);

  // Idempotency on (order_id, affiliate_id) — second call for the
  // same pair returns the existing row.
  var dupeOrder = _validUUID();
  var first = await ctx.affiliates.recordCommissionEvent({
    order_id:          dupeOrder,
    affiliate_id:      pctAff.id,
    order_total_minor: 5000,
    currency:          "USD",
  });
  var second = await ctx.affiliates.recordCommissionEvent({
    order_id:          dupeOrder,
    affiliate_id:      pctAff.id,
    order_total_minor: 5000,
    currency:          "USD",
  });
  check("recordCommissionEvent idempotent on (order_id, affiliate_id)",
    first.id === second.id);

  // Concurrent recordCommissionEvent for the SAME (order_id, affiliate_id):
  // both pre-reads miss the racing insert, both INSERT, and the loser hits the
  // UNIQUE constraint. It must converge on the committed row rather than
  // throwing an unhandled error — exactly one commission row lands.
  var raceOrder = _validUUID();
  var both = await Promise.allSettled([
    ctx.affiliates.recordCommissionEvent({ order_id: raceOrder, affiliate_id: pctAff.id, order_total_minor: 5000, currency: "USD" }),
    ctx.affiliates.recordCommissionEvent({ order_id: raceOrder, affiliate_id: pctAff.id, order_total_minor: 5000, currency: "USD" }),
  ]);
  check("concurrent recordCommissionEvent: both resolve (no unhandled UNIQUE throw)",
    both[0].status === "fulfilled" && both[1].status === "fulfilled");
  check("concurrent recordCommissionEvent: both converge on the same row",
    both[0].value && both[1].value && both[0].value.id === both[1].value.id);
  var raceCount = (await ctx.query("SELECT COUNT(*) AS c FROM affiliate_commissions WHERE order_id = ?1", [raceOrder])).rows[0].c;
  check("concurrent recordCommissionEvent: exactly one commission row", Number(raceCount) === 1);

  // order_total_minor = 0 yields commission_minor 0 (percent_bps).
  var c5 = await ctx.affiliates.recordCommissionEvent({
    order_id:          _validUUID(),
    affiliate_id:      pctAff.id,
    order_total_minor: 0,
    currency:          "USD",
  });
  check("percent_bps on zero-total -> zero commission", Number(c5.commission_minor) === 0);

  // Refusals.
  await assert.rejects(ctx.affiliates.recordCommissionEvent(),                                /input object required/);
  await assert.rejects(ctx.affiliates.recordCommissionEvent({
    order_id: "bad", affiliate_id: pctAff.id, order_total_minor: 100, currency: "USD",
  }), /order_id/);
  await assert.rejects(ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: _validUUID(), order_total_minor: 100, currency: "USD",
  }), /affiliate not found/);
  await assert.rejects(ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: pctAff.id, order_total_minor: -1, currency: "USD",
  }), /order_total_minor/);
  await assert.rejects(ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: pctAff.id, order_total_minor: 100, currency: "usd",
  }), /currency/);
}

async function _attributionWindowExpiry() {
  var ctx = _setup();
  // 7-day window.
  var aff = await ctx.affiliates.registerAffiliate(_validRegister({
    email:                   "win@example.com",
    attribution_window_days: 7,
  }));
  var sessionId = "session-" + bShop.framework.uuid.v7();

  // Stamp a visit 6 days ago — should resolve.
  var sixDaysAgo = Date.now() - 6 * 24 * 3600 * 1000;
  await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: sessionId,
    occurred_at:        sixDaysAgo,
  });
  var attr = await ctx.affiliates.attributionForSession(sessionId);
  check("attribution within window resolves",   attr && attr.affiliate_id === aff.id);
  check("attribution carries code",             attr.code === aff.code);
  check("attribution active flag true",         attr.active === true);

  // Now a session whose only visit is 8 days ago — outside the
  // 7-day window. Build a fresh session id so the previous visit
  // doesn't interfere.
  var staleSession = "stale-" + bShop.framework.uuid.v7();
  var eightDaysAgo = Date.now() - 8 * 24 * 3600 * 1000;
  await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: staleSession,
    occurred_at:        eightDaysAgo,
  });
  var stale = await ctx.affiliates.attributionForSession(staleSession);
  check("attribution outside window drops",     stale === null);

  // Edge — exactly at the window boundary resolves (inclusive).
  var boundarySession = "boundary-" + bShop.framework.uuid.v7();
  var now = Date.now();
  var sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: boundarySession,
    occurred_at:        sevenDaysAgo,
  });
  var boundary = await ctx.affiliates.attributionForSession(boundarySession, { now: now });
  check("attribution at window boundary resolves", boundary && boundary.affiliate_id === aff.id);

  // Unknown session resolves to null.
  var unknown = await ctx.affiliates.attributionForSession("never-visited-" + _validUUID());
  check("attribution for unknown session -> null", unknown === null);

  // Refusals.
  await assert.rejects(ctx.affiliates.attributionForSession(""),       /visitor_session_id/);
  await assert.rejects(ctx.affiliates.attributionForSession("ok", { now: -1 }), /now/);
}

async function _recordVisitDedupAndRefusals() {
  var ctx = _setup();
  var aff = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "v@example.com",
  }));
  var sessionId = "dedup-" + bShop.framework.uuid.v7();
  var t0 = Date.now();

  var first = await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: sessionId,
    occurred_at:        t0,
    referrer:           "https://blog.example.com/review",
  });
  check("first visit status=new",                first.status === "new");
  check("first visit returns affiliate_id",      first.affiliate_id === aff.id);

  // Same minute -> dedup.
  var same = await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: sessionId,
    occurred_at:        t0 + 30000,
  });
  check("repeat within minute -> dedup",         same.status === "dedup");
  check("dedup returns prior visit id",          same.id === first.id);

  // Two minutes later -> new row.
  var later = await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: sessionId,
    occurred_at:        t0 + 120000,
  });
  check("repeat after minute window -> new",     later.status === "new");
  check("new visit has distinct id",             later.id !== first.id);

  // Different session, same code -> not deduped.
  var otherSession = await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: "other-" + bShop.framework.uuid.v7(),
    occurred_at:        t0,
  });
  check("different session -> new row",          otherSession.status === "new");

  // Unknown code refused.
  await assert.rejects(ctx.affiliates.recordVisit({
    code: "ZZZZZZZZ", visitor_session_id: sessionId,
  }), /not recognized/);

  // Bad code shape refused.
  await assert.rejects(ctx.affiliates.recordVisit({
    code: "bad", visitor_session_id: sessionId,
  }), /code/);

  // Missing input refused.
  await assert.rejects(ctx.affiliates.recordVisit(),                              /input object required/);
  await assert.rejects(ctx.affiliates.recordVisit({ code: aff.code }),            /visitor_session_id/);
  await assert.rejects(ctx.affiliates.recordVisit({
    code: aff.code, visitor_session_id: "bad\x01session",
  }), /control/);

  // Paused affiliate refuses new visits but historical attribution
  // still resolves.
  await ctx.affiliates.pauseAffiliate(aff.id, { reason: "kyc-pending" });
  await assert.rejects(ctx.affiliates.recordVisit({
    code: aff.code, visitor_session_id: "post-pause-" + _validUUID(),
  }), /paused/);
  // Reinstate and the visit goes through again.
  await ctx.affiliates.reinstateAffiliate(aff.id);
  var afterReinstate = await ctx.affiliates.recordVisit({
    code:               aff.code,
    visitor_session_id: "post-reinstate-" + _validUUID(),
  });
  check("post-reinstate visit accepted",         afterReinstate.status === "new");
}

async function _commissionsForAffiliateCursor() {
  var ctx = _setup();
  var aff = await ctx.affiliates.registerAffiliate(_validRegister({
    email:           "csr@example.com",
    commission_kind: "amount_per_order_minor",
    commission_value: 100,
  }));
  var other = await ctx.affiliates.registerAffiliate(_validRegister({
    email:           "other@example.com",
    commission_kind: "amount_per_order_minor",
    commission_value: 100,
  }));

  // 5 commissions for `aff` with distinct occurred_at stamps.
  var base = Date.now() - 1000000;
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var c = await ctx.affiliates.recordCommissionEvent({
      order_id:          _validUUID(),
      affiliate_id:      aff.id,
      order_total_minor: 1000 + i,
      currency:          "USD",
      occurred_at:       base + i * 1000,
    });
    ids.push(c.id);
  }
  // One commission for the other affiliate — must not leak.
  await ctx.affiliates.recordCommissionEvent({
    order_id:          _validUUID(),
    affiliate_id:      other.id,
    order_total_minor: 999,
    currency:          "USD",
    occurred_at:       base,
  });

  // All in one shot.
  var all = await ctx.affiliates.commissionsForAffiliate({ affiliate_id: aff.id });
  check("commissionsForAffiliate returns all 5",          all.rows.length === 5);
  check("commissionsForAffiliate excludes other affiliates",
    all.rows.every(function (r) { return ids.indexOf(r.id) !== -1; }));

  // Paginate at limit=2.
  var p1 = await ctx.affiliates.commissionsForAffiliate({ affiliate_id: aff.id, limit: 2 });
  check("page1 returns 2",                                p1.rows.length === 2);
  check("page1 has cursor",                               typeof p1.next_cursor === "string" && p1.next_cursor.length > 0);
  var p2 = await ctx.affiliates.commissionsForAffiliate({ affiliate_id: aff.id, limit: 2, cursor: p1.next_cursor });
  check("page2 returns 2",                                p2.rows.length === 2);
  var p3 = await ctx.affiliates.commissionsForAffiliate({ affiliate_id: aff.id, limit: 2, cursor: p2.next_cursor });
  check("page3 returns last 1",                           p3.rows.length === 1);
  check("page3 no cursor",                                p3.next_cursor === null);
  // Disjoint pages.
  var seen = {};
  p1.rows.concat(p2.rows, p3.rows).forEach(function (r) { seen[r.id] = (seen[r.id] || 0) + 1; });
  check("paginated coverage disjoint",
    Object.keys(seen).length === 5 && Object.keys(seen).every(function (k) { return seen[k] === 1; }));

  // Tampered cursor refused.
  await assert.rejects(ctx.affiliates.commissionsForAffiliate({
    affiliate_id: aff.id, cursor: p1.next_cursor + "x",
  }), /cursor/);

  // status_filter narrows.
  await ctx.affiliates.markCommissionPaid({
    commission_event_id: ids[0],
    paid_at:             Date.now(),
    payout_reference:    "wire-ref-001",
  });
  var pending = await ctx.affiliates.commissionsForAffiliate({
    affiliate_id: aff.id, status_filter: "pending",
  });
  check("status_filter='pending' narrows",                pending.rows.length === 4);
  var paid = await ctx.affiliates.commissionsForAffiliate({
    affiliate_id: aff.id, status_filter: "paid",
  });
  check("status_filter='paid' narrows",                   paid.rows.length === 1 && paid.rows[0].id === ids[0]);

  // from/to range narrows.
  var ranged = await ctx.affiliates.commissionsForAffiliate({
    affiliate_id: aff.id, from: base + 2000, to: base + 4000,
  });
  check("from/to range narrows to 3 rows",                ranged.rows.length === 3);

  // Bad limit + status_filter refused.
  await assert.rejects(ctx.affiliates.commissionsForAffiliate({ affiliate_id: aff.id, limit: 0 }),
    /limit/);
  await assert.rejects(ctx.affiliates.commissionsForAffiliate({ affiliate_id: aff.id, status_filter: "bogus" }),
    /status_filter/);
}

async function _fsmTransitions() {
  var ctx = _setup();
  var aff = await ctx.affiliates.registerAffiliate(_validRegister({
    email:           "fsm@example.com",
    commission_kind: "amount_per_order_minor",
    commission_value: 200,
  }));

  // Two commissions — one we'll pay, one we'll void, one we'll
  // keep pending for the refusal class.
  var cPay = await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: aff.id, order_total_minor: 1000, currency: "USD",
  });
  var cVoid = await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: aff.id, order_total_minor: 1000, currency: "USD",
  });
  var cKeep = await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: aff.id, order_total_minor: 1000, currency: "USD",
  });

  // pending -> paid.
  var paidAt = Date.now();
  var paid = await ctx.affiliates.markCommissionPaid({
    commission_event_id: cPay.id,
    paid_at:             paidAt,
    payout_reference:    "PR-0001",
  });
  check("pending -> paid",                       paid.status === "paid");
  check("paid stamps paid_at",                   Number(paid.paid_at) === paidAt);
  check("paid stamps payout_reference",          paid.payout_reference === "PR-0001");

  // Double-pay refused.
  await assert.rejects(ctx.affiliates.markCommissionPaid({
    commission_event_id: cPay.id, paid_at: paidAt, payout_reference: "PR-0002",
  }), /refused/);

  // pending -> voided.
  var voided = await ctx.affiliates.markCommissionVoided({
    commission_event_id: cVoid.id,
    reason:              "customer-refund",
  });
  check("pending -> voided",                     voided.status === "voided");
  check("voided stamps voided_at",               typeof voided.voided_at === "number");
  check("voided stamps reason",                  voided.void_reason === "customer-refund");

  // paid -> voided refused.
  await assert.rejects(ctx.affiliates.markCommissionVoided({
    commission_event_id: cPay.id, reason: "clawback",
  }), /refused/);
  // voided -> paid refused.
  await assert.rejects(ctx.affiliates.markCommissionPaid({
    commission_event_id: cVoid.id, paid_at: paidAt, payout_reference: "PR-X",
  }), /refused/);
  // voided -> voided refused.
  await assert.rejects(ctx.affiliates.markCommissionVoided({
    commission_event_id: cVoid.id, reason: "double-void",
  }), /refused/);

  // Refusal classes.
  await assert.rejects(ctx.affiliates.markCommissionPaid({
    commission_event_id: _validUUID(), paid_at: paidAt, payout_reference: "PR-Y",
  }), /not found/);
  await assert.rejects(ctx.affiliates.markCommissionPaid({
    commission_event_id: cKeep.id, paid_at: -1, payout_reference: "PR-Z",
  }), /paid_at/);
  await assert.rejects(ctx.affiliates.markCommissionPaid({
    commission_event_id: cKeep.id, paid_at: paidAt, payout_reference: "",
  }), /payout_reference/);
  await assert.rejects(ctx.affiliates.markCommissionVoided({
    commission_event_id: cKeep.id,
  }), /reason/);
  await assert.rejects(ctx.affiliates.markCommissionVoided({
    commission_event_id: cKeep.id, reason: "",
  }), /reason/);
}

async function _payoutsDueAggregate() {
  var ctx = _setup();
  // Three affiliates: a (big), b (small), c (paid-already), d (voided).
  var a = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "a@example.com",
    commission_kind: "amount_per_order_minor", commission_value: 500,
  }));
  var b = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "b@example.com",
    commission_kind: "amount_per_order_minor", commission_value: 100,
  }));
  var c = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "c@example.com",
    commission_kind: "amount_per_order_minor", commission_value: 700,
  }));

  var now = Date.now();
  // a: 3 pending commissions totaling 1500.
  for (var i = 0; i < 3; i += 1) {
    await ctx.affiliates.recordCommissionEvent({
      order_id: _validUUID(), affiliate_id: a.id, order_total_minor: 5000, currency: "USD",
      occurred_at: now - 10000,
    });
  }
  // b: 1 pending commission of 100 (below threshold).
  await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: b.id, order_total_minor: 5000, currency: "USD",
    occurred_at: now - 10000,
  });
  // c: 1 commission marked paid (excluded from pending bucket).
  var cRow = await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: c.id, order_total_minor: 5000, currency: "USD",
    occurred_at: now - 10000,
  });
  await ctx.affiliates.markCommissionPaid({
    commission_event_id: cRow.id, paid_at: now, payout_reference: "PR-C",
  });
  // also a voided row on c — excluded too.
  var cVoid = await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: c.id, order_total_minor: 5000, currency: "USD",
    occurred_at: now - 10000,
  });
  await ctx.affiliates.markCommissionVoided({
    commission_event_id: cVoid.id, reason: "refund",
  });
  // a commission after as_of — must not count.
  await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: a.id, order_total_minor: 5000, currency: "USD",
    occurred_at: now + 100000,
  });

  // Threshold 1000 — only `a` qualifies.
  var due = await ctx.affiliates.payoutsDue({ as_of: now, min_payout_minor: 1000 });
  check("payoutsDue threshold 1000 returns 1",            due.length === 1);
  check("payoutsDue returns affiliate a",                 due[0].affiliate_id === a.id);
  check("payoutsDue sums pending_minor",                  due[0].pending_minor === 1500);
  check("payoutsDue counts commissions",                  due[0].commission_count === 3);

  // Threshold 0 — `a` + `b` qualify, sorted by pending_minor DESC.
  var due0 = await ctx.affiliates.payoutsDue({ as_of: now, min_payout_minor: 0 });
  check("payoutsDue threshold 0 returns 2",               due0.length === 2);
  check("payoutsDue sorted DESC",                         due0[0].affiliate_id === a.id && due0[1].affiliate_id === b.id);

  // Threshold above max -> empty.
  var due99 = await ctx.affiliates.payoutsDue({ as_of: now, min_payout_minor: 9999999 });
  check("payoutsDue above threshold empty",               due99.length === 0);

  // Refusals.
  await assert.rejects(ctx.affiliates.payoutsDue(),                                 /input object required/);
  await assert.rejects(ctx.affiliates.payoutsDue({ as_of: "x", min_payout_minor: 0 }), /as_of/);
  await assert.rejects(ctx.affiliates.payoutsDue({ as_of: 0, min_payout_minor: -1 }), /min_payout_minor/);
}

async function _topAffiliatesRanking() {
  var ctx = _setup();
  var a = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "ta@example.com",
    commission_kind: "amount_per_order_minor", commission_value: 100,
  }));
  var b = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "tb@example.com",
    commission_kind: "amount_per_order_minor", commission_value: 100,
  }));
  var c = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "tc@example.com",
    commission_kind: "amount_per_order_minor", commission_value: 100,
  }));

  var base = Date.now() - 1000000;
  // a: 3 commissions = 300.
  for (var i = 0; i < 3; i += 1) {
    await ctx.affiliates.recordCommissionEvent({
      order_id: _validUUID(), affiliate_id: a.id, order_total_minor: 1000, currency: "USD",
      occurred_at: base + i * 1000,
    });
  }
  // b: 5 commissions = 500, but two voided -> 300 effective.
  var bIds = [];
  for (var j = 0; j < 5; j += 1) {
    var bRow = await ctx.affiliates.recordCommissionEvent({
      order_id: _validUUID(), affiliate_id: b.id, order_total_minor: 1000, currency: "USD",
      occurred_at: base + j * 1000,
    });
    bIds.push(bRow.id);
  }
  await ctx.affiliates.markCommissionVoided({ commission_event_id: bIds[0], reason: "r" });
  await ctx.affiliates.markCommissionVoided({ commission_event_id: bIds[1], reason: "r" });

  // c: 1 commission but outside the window — excluded.
  await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: c.id, order_total_minor: 1000, currency: "USD",
    occurred_at: base - 1000000,
  });

  // c: 1 commission inside the window worth 100.
  await ctx.affiliates.recordCommissionEvent({
    order_id: _validUUID(), affiliate_id: c.id, order_total_minor: 1000, currency: "USD",
    occurred_at: base + 500,
  });

  var top = await ctx.affiliates.topAffiliates({
    from:  base - 1,
    to:    base + 10000,
    limit: 5,
  });
  check("topAffiliates returns 3 entries",                top.length === 3);
  // a and b tie at 300; a < b in uuid sort? not predictable. Just
  // assert the top two are tied at 300 and the third is c at 100.
  check("topAffiliates ranking — top tier at 300",        top[0].total_minor === 300 && top[1].total_minor === 300);
  check("topAffiliates ranking — third at 100",           top[2].total_minor === 100 && top[2].affiliate_id === c.id);

  // limit caps the list.
  var top1 = await ctx.affiliates.topAffiliates({ from: base - 1, to: base + 10000, limit: 1 });
  check("topAffiliates limit=1 returns 1",                top1.length === 1);

  // Window entirely before any commission -> empty.
  var topEmpty = await ctx.affiliates.topAffiliates({ from: 0, to: 1 });
  check("topAffiliates empty window -> []",               topEmpty.length === 0);

  // Refusals.
  await assert.rejects(ctx.affiliates.topAffiliates(),                            /input object required/);
  await assert.rejects(ctx.affiliates.topAffiliates({ from: 5, to: 1 }),          /from must be <= to/);
  await assert.rejects(ctx.affiliates.topAffiliates({ from: 0, to: 1, limit: 0 }), /limit/);
}

async function _updateAndPauseLifecycle() {
  var ctx = _setup();
  var aff = await ctx.affiliates.registerAffiliate(_validRegister({
    email: "lifecycle@example.com",
    commission_value: 1000,
  }));

  // Patch the name + commission_value.
  var patched = await ctx.affiliates.updateAffiliate(aff.id, {
    name:             "Renamed Partner",
    commission_value: 2000,
  });
  check("updateAffiliate patches name",          patched.name === "Renamed Partner");
  check("updateAffiliate patches value",         Number(patched.commission_value) === 2000);
  check("updateAffiliate preserves code",        patched.code === aff.code);
  check("updateAffiliate preserves email_hash",  patched.email_hash === aff.email_hash);
  check("updateAffiliate bumps updated_at",      Number(patched.updated_at) >= Number(aff.updated_at));

  // Switching commission_kind also re-validates commission_value
  // against the new kind's caps. percent_bps over 10000 refused.
  await assert.rejects(ctx.affiliates.updateAffiliate(aff.id, {
    commission_kind: "percent_bps", commission_value: 50000,
  }), /commission_value/);

  // Switching to percent_bps with a valid bps works.
  var asPct = await ctx.affiliates.updateAffiliate(aff.id, {
    commission_kind: "percent_bps", commission_value: 500,
  });
  check("updateAffiliate switches kind",         asPct.commission_kind === "percent_bps");
  check("updateAffiliate switches value",        Number(asPct.commission_value) === 500);

  // Unknown columns refused.
  await assert.rejects(ctx.affiliates.updateAffiliate(aff.id, { code: "newcode!" }),       /not updatable/);
  await assert.rejects(ctx.affiliates.updateAffiliate(aff.id, { email_hash: "xxx" }),      /not updatable/);

  // Empty patch refused.
  await assert.rejects(ctx.affiliates.updateAffiliate(aff.id, {}),                          /at least one column/);

  // Unknown affiliate -> null.
  var noop = await ctx.affiliates.updateAffiliate(_validUUID(), { name: "x" });
  check("updateAffiliate unknown -> null",       noop === null);

  // Pause + reinstate.
  var paused = await ctx.affiliates.pauseAffiliate(aff.id, { reason: "manual-review" });
  check("pauseAffiliate sets active=0",          Number(paused.active) === 0);
  check("pauseAffiliate stamps paused_at",       typeof paused.paused_at === "number");
  check("pauseAffiliate stores reason",          paused.paused_reason === "manual-review");

  var listActiveOnly = await ctx.affiliates.listAffiliates({ active_only: true });
  check("paused affiliate hidden from active_only", listActiveOnly.every(function (r) { return r.id !== aff.id; }));

  var reinstated = await ctx.affiliates.reinstateAffiliate(aff.id);
  check("reinstateAffiliate sets active=1",      Number(reinstated.active) === 1);
  check("reinstateAffiliate clears paused_at",   reinstated.paused_at == null);
  check("reinstateAffiliate clears reason",      reinstated.paused_reason == null);

  // pause / reinstate on unknown -> null.
  var nullPause = await ctx.affiliates.pauseAffiliate(_validUUID());
  check("pauseAffiliate unknown -> null",        nullPause === null);
  var nullReinstate = await ctx.affiliates.reinstateAffiliate(_validUUID());
  check("reinstateAffiliate unknown -> null",    nullReinstate === null);
}

// Prod-redaction regression for the registerAffiliate code retry loop. A code
// collision surfaces in production as a bare "HTTP 500" (the D1 service-binding
// redacts the SQLite "UNIQUE constraint failed" text), so the old
// indexOf("UNIQUE") gate would have re-thrown instead of regenerating. The
// first generated code is held PERMANENTLY taken (every INSERT of it is
// redacted-rejected and the re-read confirms it), so registration can only
// succeed by REGENERATING a different code — proving the retry fires AND does
// not re-use the collided code.
async function _registerAffiliateRetriesUnderRedactedCollision() {
  var base = _makeQuery();
  var firstCode = null;
  var q = async function (sql, params) {
    if (/INSERT INTO affiliates /.test(sql)) {
      if (firstCode === null) firstCode = params[1];               // code column
      if (params[1] === firstCode) throw new Error("HTTP 500");    // the winner holds it; redacted, no "UNIQUE"
    }
    if (firstCode !== null && /SELECT id FROM affiliates WHERE code = /.test(sql) && params[0] === firstCode) {
      return { rows: [{ id: "winner" }] };                         // the re-read confirms the clash
    }
    return base(sql, params);
  };
  var aff = affiliates.create({ query: q, cursorSecret: "affiliates-test-secret" });
  var a = await aff.registerAffiliate(_validRegister());
  check("redacted-collision: registerAffiliate resolves with a regenerated code (retry fired despite the bare HTTP 500)",
    typeof a.code === "string" && a.code.length > 0 && a.code !== firstCode);
}

async function run() {
  await _registerHappyPath();
  await _registerAffiliateRetriesUnderRedactedCollision();
  await _registerRefusals();
  await _commissionMath();
  await _attributionWindowExpiry();
  await _recordVisitDedupAndRefusals();
  await _commissionsForAffiliateCursor();
  await _fsmTransitions();
  await _payoutsDueAggregate();
  await _topAffiliatesRanking();
  await _updateAndPauseLifecycle();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/affiliates.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - affiliates (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
