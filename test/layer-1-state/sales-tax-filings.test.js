"use strict";
/**
 * sales-tax-filings — periodic remittance preparation primitive. The
 * operator opens a filing for (jurisdiction, kind, period), the
 * primitive aggregates orders that landed in the window into a
 * snapshot, the operator records the submission + payment, optionally
 * marks the row amended.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0184
 * (sales_tax_filings) + the project's orders schema (0003_order.sql).
 * The orders schema is loaded so the aggregation can be exercised
 * end-to-end without a mock.
 *
 * Coverage:
 *   - defineFilingPeriod: persists a row in draft, refuses bad input
 *     shape, refuses a duplicate (jurisdiction, kind, period_start)
 *   - computeFiling: aggregates orders by jurisdiction window, splits
 *     gross / taxable / exempt revenue, computes tax_owed from rates,
 *     produces per-rate breakdown
 *   - recordSubmission: FSM moves computed -> submitted, requires
 *     submission_ref + submitted_by
 *   - recordPayment: FSM moves submitted -> paid, captures
 *     payment_minor + payment_ref
 *   - markAmended: FSM moves computed / submitted / paid -> amended,
 *     captures reason
 *   - upcomingDue: returns rows in (draft|computed|submitted) status
 *     with due_date inside the horizon window
 *   - auditReportForJurisdiction: pulls filings intersecting [from,to]
 *     with cross-filing totals
 *   - validation surface: every entry point refuses bad input
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var salesTaxFilings  = require("../../lib/sales-tax-filings");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG_FILINGS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0184_sales_tax_filings.sql");
var MIG_ORDERS  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0003_order.sql");
var MIG_ORDERS_PROVIDER = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0950_orders_payment_provider.sql");
var MIG_ORDERS_CAPTURE  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0951_orders_paypal_capture_id.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  // The orders schema references a `carts` table via FK; stub a
  // minimal stand-in so order inserts succeed without pulling in the
  // whole cart migration.
  db.prepare("CREATE TABLE carts (id TEXT NOT NULL PRIMARY KEY)").run();
  _splitSchema(nodeFs.readFileSync(MIG_ORDERS,  "utf8")).forEach(function (s) { db.prepare(s).run(); });
  _splitSchema(nodeFs.readFileSync(MIG_ORDERS_PROVIDER, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  _splitSchema(nodeFs.readFileSync(MIG_ORDERS_CAPTURE,  "utf8")).forEach(function (s) { db.prepare(s).run(); });
  _splitSchema(nodeFs.readFileSync(MIG_FILINGS, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  // Stub tax_rates so the rate-resolution path in computeFiling can
  // be exercised without dragging in another migration file.
  db.prepare(
    "CREATE TABLE tax_rates (" +
    "  id TEXT NOT NULL PRIMARY KEY," +
    "  jurisdiction TEXT NOT NULL," +
    "  category TEXT," +
    "  rate_bps INTEGER NOT NULL," +
    "  effective_from INTEGER NOT NULL," +
    "  effective_until INTEGER," +
    "  archived_at INTEGER" +
    ")"
  ).run();
  return {
    db:    db,
    query: async function (sql, params) {
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
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// Insert a synthetic order row directly. Bypassing lib/order.js keeps
// this test focused on the filing primitive's aggregation contract
// rather than on the order-FSM machinery (which has its own suite).
function _insertOrder(db, opts) {
  var id        = _uuid();
  var cartId    = opts.cart_id    || _uuid();
  var sessionId = opts.session_id || _uuid();
  var custId    = opts.customer_id || null;
  // Ensure the carts row exists so the FK passes.
  db.prepare("INSERT OR IGNORE INTO carts (id) VALUES (?)").run(cartId);
  db.prepare(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id, cartId, custId, sessionId, opts.status || "paid",
    opts.currency || "USD",
    opts.subtotal_minor, 0, opts.tax_minor || 0, 0,
    (opts.subtotal_minor + (opts.tax_minor || 0)),
    null,
    JSON.stringify(opts.ship_to || { country: "US", region: "CA" }),
    opts.created_at, opts.created_at,
  );
  return id;
}

function _insertRate(db, j, rateBps, from, until) {
  db.prepare(
    "INSERT INTO tax_rates (id, jurisdiction, category, rate_bps, " +
    "effective_from, effective_until, archived_at) " +
    "VALUES (?, ?, NULL, ?, ?, ?, NULL)"
  ).run(_uuid(), j, rateBps, from, until == null ? null : until);
}

function _factory(taxExemptApi) {
  var h = _makeQuery();
  var stf = salesTaxFilings.create({
    query:     h.query,
    taxRates:  {},   // truthy enables rate query; rate rows themselves are inserted via _insertRate
    taxExempt: taxExemptApi || null,
  });
  return { db: h.db, query: h.query, stf: stf };
}

// ---- 1. defineFilingPeriod shape ----------------------------------------

async function _defineFilingPeriodShape() {
  var f = _factory();
  var jan = Date.UTC(2026, 0, 1);
  var feb = Date.UTC(2026, 1, 1);
  var due = Date.UTC(2026, 1, 20);

  var filing = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: jan,
    period_end:   feb,
    due_date:     due,
  });
  check("defineFilingPeriod returns id",       typeof filing.id === "string" && filing.id.length === 36);
  check("defineFilingPeriod jurisdiction",     filing.jurisdiction === "US-CA");
  check("defineFilingPeriod kind",             filing.kind === "monthly");
  check("defineFilingPeriod status draft",     filing.status === "draft");
  check("defineFilingPeriod period_start set", filing.period_start === jan);
  check("defineFilingPeriod period_end set",   filing.period_end === feb);
  check("defineFilingPeriod due_date set",     filing.due_date === due);
  check("defineFilingPeriod gross zero",       filing.gross_revenue_minor === 0);
  check("defineFilingPeriod tax_owed zero",    filing.tax_owed_minor === 0);
  check("defineFilingPeriod created_at set",   typeof filing.created_at === "number");
  check("defineFilingPeriod breakdown empty",  typeof filing.by_rate_breakdown === "object"
                                                && Object.keys(filing.by_rate_breakdown).length === 0);

  // Duplicate (jurisdiction, kind, period_start) refused.
  await assert.rejects(
    f.stf.defineFilingPeriod({
      jurisdiction: "US-CA",
      kind:         "monthly",
      period_start: jan,
      period_end:   feb,
      due_date:     due,
    }),
    function (err) { return err && err.code === "SALES_TAX_FILING_DUPLICATE"; },
  );

  // Different kind for same start is fine (an operator can file the
  // same window as both monthly + annual for sanity reconciliation).
  var annual = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "annual",
    period_start: jan,
    period_end:   Date.UTC(2027, 0, 1),
    due_date:     Date.UTC(2027, 2, 15),
  });
  check("defineFilingPeriod annual kind ok", annual.kind === "annual");

  // Different jurisdiction for same period is fine.
  var ny = await f.stf.defineFilingPeriod({
    jurisdiction: "US-NY",
    kind:         "monthly",
    period_start: jan,
    period_end:   feb,
    due_date:     due,
  });
  check("defineFilingPeriod different juris ok", ny.jurisdiction === "US-NY");

  // getFiling round-trips.
  var fetched = await f.stf.getFiling(filing.id);
  check("getFiling round-trip", fetched.id === filing.id);
  check("getFiling status",     fetched.status === "draft");
}

// ---- 2. computeFiling aggregates orders ---------------------------------

async function _computeFilingAggregates() {
  var f = _factory();
  var jan = Date.UTC(2026, 0, 1);
  var feb = Date.UTC(2026, 1, 1);
  var due = Date.UTC(2026, 1, 20);

  // Seed a 7.25% (725 bps) rate effective for the whole window.
  _insertRate(f.db, "US-CA", 725, jan - 1000, null);

  // Three taxable orders inside window, one exempt-jurisdiction order
  // outside the window, one shipping to a different jurisdiction, one
  // cancelled order (excluded). Numbers chosen so the aggregation is
  // easy to verify by hand.
  var insideMid = jan + (10 * 24 * 60 * 60 * 1000);

  _insertOrder(f.db, { subtotal_minor: 10000, tax_minor: 725,  created_at: jan + 1000 });
  _insertOrder(f.db, { subtotal_minor: 20000, tax_minor: 1450, created_at: insideMid });
  _insertOrder(f.db, { subtotal_minor: 30000, tax_minor: 2175, created_at: feb - 1000 });

  // Outside window — created before jan
  _insertOrder(f.db, { subtotal_minor: 99000, tax_minor: 7000, created_at: jan - 5000 });

  // Different jurisdiction
  _insertOrder(f.db, {
    subtotal_minor: 50000, tax_minor: 4000,
    created_at: insideMid,
    ship_to: { country: "US", region: "NY" },
  });

  // Cancelled — excluded from filing aggregation
  _insertOrder(f.db, {
    subtotal_minor: 12345, tax_minor: 999,
    created_at: insideMid, status: "cancelled",
  });

  var filing = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: jan,
    period_end:   feb,
    due_date:     due,
  });

  var computed = await f.stf.computeFiling({ filing_id: filing.id });
  check("computeFiling status moves to computed",  computed.status === "computed");
  check("computeFiling computed_at set",            typeof computed.computed_at === "number");
  check("computeFiling gross_revenue",              computed.gross_revenue_minor === 60000);
  check("computeFiling taxable_revenue",            computed.taxable_revenue_minor === 60000);
  check("computeFiling exempt_revenue zero",        computed.exempt_revenue_minor === 0);
  check("computeFiling tax_collected",              computed.tax_collected_minor === 4350);
  // Owed: 60000 * 0.0725 = 4350 (banker's-rounded integer)
  check("computeFiling tax_owed matches collected", computed.tax_owed_minor === 4350);
  check("computeFiling breakdown has rate bucket",  computed.by_rate_breakdown["725"]
                                                     && computed.by_rate_breakdown["725"].order_count === 3);
  check("computeFiling breakdown taxable",          computed.by_rate_breakdown["725"].taxable_minor === 60000);
  check("computeFiling breakdown tax",              computed.by_rate_breakdown["725"].tax_minor === 4350);

  // Recompute pre-submit allowed — overwrites snapshot in place.
  var recomputed = await f.stf.computeFiling({ filing_id: filing.id });
  check("computeFiling recompute keeps status", recomputed.status === "computed");
  check("computeFiling recompute same gross",   recomputed.gross_revenue_minor === 60000);
}

// ---- 3. computeFiling honors tax exemptions -----------------------------

async function _computeFilingExempt() {
  // Wire a stub taxExempt that flags one customer as exempt.
  var exemptId = _uuid();
  var taxExemptApi = {
    isExempt: async function (input) {
      return input.customer_id === exemptId && input.jurisdiction === "US-CA";
    },
  };
  var f = _factory(taxExemptApi);
  var jan = Date.UTC(2026, 0, 1);
  var feb = Date.UTC(2026, 1, 1);
  var due = Date.UTC(2026, 1, 20);
  _insertRate(f.db, "US-CA", 725, jan - 1000, null);

  // Taxable order
  _insertOrder(f.db, {
    subtotal_minor: 10000, tax_minor: 725,
    created_at: jan + 1000,
    customer_id: _uuid(),
  });
  // Exempt order — same window, exempt customer
  _insertOrder(f.db, {
    subtotal_minor: 50000, tax_minor: 0,
    created_at: jan + 2000,
    customer_id: exemptId,
  });

  var filing = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: jan,
    period_end:   feb,
    due_date:     due,
  });
  var computed = await f.stf.computeFiling({ filing_id: filing.id });
  check("exempt: gross sums all orders",    computed.gross_revenue_minor === 60000);
  check("exempt: taxable excludes exempt",  computed.taxable_revenue_minor === 10000);
  check("exempt: exempt bucket carries it", computed.exempt_revenue_minor === 50000);
  check("exempt: collected unchanged",      computed.tax_collected_minor === 725);
  // Owed = 10000 * 7.25% = 725
  check("exempt: tax_owed only on taxable", computed.tax_owed_minor === 725);
  check("exempt: __exempt__ bucket set",    computed.by_rate_breakdown.__exempt__
                                             && computed.by_rate_breakdown.__exempt__.order_count === 1);
  check("exempt: rate bucket taxable only", computed.by_rate_breakdown["725"]
                                             && computed.by_rate_breakdown["725"].order_count === 1
                                             && computed.by_rate_breakdown["725"].taxable_minor === 10000);
}

// ---- 4. FSM transitions: submit / pay / amend ---------------------------

async function _fsmTransitions() {
  var f = _factory();
  var jan = Date.UTC(2026, 0, 1);
  var feb = Date.UTC(2026, 1, 1);
  var due = Date.UTC(2026, 1, 20);
  _insertRate(f.db, "US-CA", 725, jan - 1000, null);
  _insertOrder(f.db, { subtotal_minor: 10000, tax_minor: 725, created_at: jan + 1000 });

  var filing = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: jan,
    period_end:   feb,
    due_date:     due,
  });

  // submit refused from draft (must compute first).
  await assert.rejects(
    f.stf.recordSubmission({
      filing_id:      filing.id,
      submission_ref: "DR-001",
      submitted_by:   "ops@example.com",
    }),
    function (err) { return err && err.code === "SALES_TAX_FILING_BAD_TRANSITION"; },
  );

  await f.stf.computeFiling({ filing_id: filing.id });

  var submitted = await f.stf.recordSubmission({
    filing_id:      filing.id,
    submission_ref: "DR-2026-CA-001",
    submitted_by:   "ops@example.com",
    submitted_at:   jan + (40 * 24 * 60 * 60 * 1000),
  });
  check("recordSubmission status submitted", submitted.status === "submitted");
  check("recordSubmission ref persisted",    submitted.submission_ref === "DR-2026-CA-001");
  check("recordSubmission submitted_by set", submitted.submitted_by === "ops@example.com");
  check("recordSubmission submitted_at set", submitted.submitted_at === jan + (40 * 24 * 60 * 60 * 1000));

  // pay refused before submit-flow lands (already submitted, so paying is allowed)
  var paid = await f.stf.recordPayment({
    filing_id:     filing.id,
    payment_minor: 725,
    payment_ref:   "ACH-789",
  });
  check("recordPayment status paid",        paid.status === "paid");
  check("recordPayment amount set",         paid.payment_minor === 725);
  check("recordPayment payment_ref set",    paid.payment_ref === "ACH-789");
  check("recordPayment paid_at set",        typeof paid.paid_at === "number");

  // Second payment attempt refused (already paid; amend first).
  await assert.rejects(
    f.stf.recordPayment({ filing_id: filing.id, payment_minor: 100, payment_ref: "ACH-OOPS" }),
    function (err) { return err && err.code === "SALES_TAX_FILING_BAD_TRANSITION"; },
  );

  // Amend from paid.
  var amended = await f.stf.markAmended({
    filing_id: filing.id,
    reason:    "Picked up two late-arriving orders that should have been in this window.",
  });
  check("markAmended status amended",        amended.status === "amended");
  check("markAmended reason persisted",      /late-arriving/.test(amended.amended_reason));
  check("markAmended amended_at set",        typeof amended.amended_at === "number");
  check("markAmended preserves snapshot",    amended.gross_revenue_minor === 10000);
  check("markAmended preserves payment",     amended.payment_minor === 725);

  // No further transitions from amended.
  await assert.rejects(
    f.stf.markAmended({ filing_id: filing.id, reason: "again" }),
    function (err) { return err && err.code === "SALES_TAX_FILING_BAD_TRANSITION"; },
  );

  // Amend directly from computed (no submit yet) is allowed.
  var feb2 = Date.UTC(2026, 2, 1);
  var mar  = Date.UTC(2026, 3, 1);
  var due2 = Date.UTC(2026, 3, 20);
  var f2filing = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: feb2,
    period_end:   mar,
    due_date:     due2,
  });
  await f.stf.computeFiling({ filing_id: f2filing.id });
  var earlyAmend = await f.stf.markAmended({
    filing_id: f2filing.id,
    reason:    "Withdrew before submission — wrong period boundary.",
  });
  check("markAmended from computed", earlyAmend.status === "amended");

  // Unknown filing id returns NOT_FOUND.
  await assert.rejects(
    f.stf.computeFiling({ filing_id: _uuid() }),
    function (err) { return err && err.code === "SALES_TAX_FILING_NOT_FOUND"; },
  );
}

// ---- 5. upcomingDue window ----------------------------------------------

async function _upcomingDueWindow() {
  var f = _factory();
  // Use three periods whose period_end already lands in the past
  // relative to the synthetic `nowTs` below so the (due_date >=
  // period_end) schema invariant holds AND the three due_date offsets
  // partition cleanly into the 7d / 30d / 200d horizons under test.
  var oct = Date.UTC(2025, 9, 1);
  var nov = Date.UTC(2025, 10, 1);
  var dec = Date.UTC(2025, 11, 1);
  var jan = Date.UTC(2026, 0, 1);

  // `now` is Jan 15, 2026 — every period above has already closed.
  var nowTs = Date.UTC(2026, 0, 15);
  var dueSoon = nowTs + (5  * 24 * 60 * 60 * 1000);
  var dueMid  = nowTs + (20 * 24 * 60 * 60 * 1000);
  var dueFar  = nowTs + (100 * 24 * 60 * 60 * 1000);

  var fSoon = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: oct,
    period_end:   nov,
    due_date:     dueSoon,
  });
  var fMid = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: nov,
    period_end:   dec,
    due_date:     dueMid,
  });
  await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: dec,
    period_end:   jan,
    due_date:     dueFar,
  });

  // Within 7-day horizon: only fSoon
  var soon = await f.stf.upcomingDue({ days_ahead: 7, now: nowTs });
  check("upcomingDue 7d window count",     soon.length === 1);
  check("upcomingDue 7d window contains soonest", soon[0].id === fSoon.id);

  // Within 30-day horizon: fSoon + fMid, ordered ASC by due_date.
  var mid = await f.stf.upcomingDue({ days_ahead: 30, now: nowTs });
  check("upcomingDue 30d window count",    mid.length === 2);
  check("upcomingDue 30d window order",    mid[0].id === fSoon.id && mid[1].id === fMid.id);

  // 200-day horizon: all three.
  var all = await f.stf.upcomingDue({ days_ahead: 200, now: nowTs });
  check("upcomingDue 200d window all",     all.length === 3);

  // Submitted filings still surface if not yet paid.
  await f.stf.computeFiling({ filing_id: fSoon.id });
  await f.stf.recordSubmission({
    filing_id:      fSoon.id,
    submission_ref: "DR-EARLY",
    submitted_by:   "ops@example.com",
  });
  var afterSubmit = await f.stf.upcomingDue({ days_ahead: 7, now: nowTs });
  check("upcomingDue includes submitted",  afterSubmit.length === 1
                                            && afterSubmit[0].id === fSoon.id);

  // Paid filings drop off.
  await f.stf.recordPayment({
    filing_id:     fSoon.id,
    payment_minor: 0,
    payment_ref:   "ACH-PAID",
  });
  var afterPay = await f.stf.upcomingDue({ days_ahead: 7, now: nowTs });
  check("upcomingDue excludes paid",       afterPay.length === 0);
}

// ---- 6. listFilings + auditReportForJurisdiction ------------------------

async function _listAndAudit() {
  var f = _factory();
  var jan = Date.UTC(2026, 0, 1);
  var feb = Date.UTC(2026, 1, 1);
  var mar = Date.UTC(2026, 2, 1);
  var apr = Date.UTC(2026, 3, 1);
  _insertRate(f.db, "US-CA", 725, jan - 1000, null);
  _insertOrder(f.db, { subtotal_minor: 10000, tax_minor: 725, created_at: jan + 1000 });
  _insertOrder(f.db, { subtotal_minor: 20000, tax_minor: 1450, created_at: feb + 1000 });

  var jan_feb = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: jan,
    period_end:   feb,
    due_date:     feb + (20 * 24 * 60 * 60 * 1000),
  });
  var feb_mar = await f.stf.defineFilingPeriod({
    jurisdiction: "US-CA",
    kind:         "monthly",
    period_start: feb,
    period_end:   mar,
    due_date:     mar + (20 * 24 * 60 * 60 * 1000),
  });
  await f.stf.defineFilingPeriod({
    jurisdiction: "US-NY",
    kind:         "monthly",
    period_start: jan,
    period_end:   feb,
    due_date:     feb + (20 * 24 * 60 * 60 * 1000),
  });

  await f.stf.computeFiling({ filing_id: jan_feb.id });
  await f.stf.computeFiling({ filing_id: feb_mar.id });

  // listFilings without filters returns all three (ordered by due_date ASC)
  var all = await f.stf.listFilings();
  check("listFilings all count", all.length === 3);

  // jurisdiction filter
  var caOnly = await f.stf.listFilings({ jurisdiction: "US-CA" });
  check("listFilings US-CA only", caOnly.length === 2);
  check("listFilings US-CA all CA", caOnly.every(function (r) { return r.jurisdiction === "US-CA"; }));

  // status filter
  var draftOnly = await f.stf.listFilings({ status: "draft" });
  check("listFilings draft only", draftOnly.length === 1
                                   && draftOnly[0].jurisdiction === "US-NY");

  var computedOnly = await f.stf.listFilings({ status: "computed" });
  check("listFilings computed count", computedOnly.length === 2);

  // auditReportForJurisdiction: window covering both CA filings.
  var audit = await f.stf.auditReportForJurisdiction({
    jurisdiction: "US-CA",
    from:         jan,
    to:           apr,
  });
  check("audit jurisdiction set",                 audit.jurisdiction === "US-CA");
  check("audit filing_count",                     audit.filing_count === 2);
  check("audit total_gross",                      audit.total_gross_revenue_minor === 30000);
  check("audit total_collected",                  audit.total_tax_collected_minor === 2175);
  check("audit total_taxable",                    audit.total_taxable_revenue_minor === 30000);
  check("audit filings ordered ASC by period",    audit.filings[0].period_start === jan
                                                   && audit.filings[1].period_start === feb);

  // Narrow window: only the first CA filing intersects.
  var narrow = await f.stf.auditReportForJurisdiction({
    jurisdiction: "US-CA",
    from:         jan,
    to:           feb,
  });
  check("audit narrow window count", narrow.filing_count === 1);
}

// ---- 7. validation surface ---------------------------------------------

async function _validationSurface() {
  var f = _factory();

  // defineFilingPeriod
  await assert.rejects(f.stf.defineFilingPeriod(),                                       /input object required/);
  await assert.rejects(f.stf.defineFilingPeriod({}),                                     /jurisdiction/);
  await assert.rejects(f.stf.defineFilingPeriod({ jurisdiction: "us-ca" }),              /jurisdiction/);
  await assert.rejects(f.stf.defineFilingPeriod({ jurisdiction: "US-CA", kind: "weekly" }), /kind/);
  await assert.rejects(f.stf.defineFilingPeriod({
    jurisdiction: "US-CA", kind: "monthly", period_start: -1,
  }), /period_start/);
  await assert.rejects(f.stf.defineFilingPeriod({
    jurisdiction: "US-CA", kind: "monthly", period_start: 100, period_end: 50, due_date: 200,
  }), /period_end must be > period_start/);
  await assert.rejects(f.stf.defineFilingPeriod({
    jurisdiction: "US-CA", kind: "monthly", period_start: 100, period_end: 200, due_date: 150,
  }), /due_date must be >= period_end/);

  // computeFiling
  await assert.rejects(f.stf.computeFiling(),                                            /input object required/);
  await assert.rejects(f.stf.computeFiling({ filing_id: "not-a-uuid" }),                 /filing_id/);

  // recordSubmission
  await assert.rejects(f.stf.recordSubmission(),                                         /input object required/);
  await assert.rejects(f.stf.recordSubmission({ filing_id: _uuid() }),                   /submission_ref/);
  await assert.rejects(f.stf.recordSubmission({
    filing_id: _uuid(), submission_ref: "ok",
  }), /submitted_by/);

  // recordPayment
  await assert.rejects(f.stf.recordPayment(),                                            /input object required/);
  await assert.rejects(f.stf.recordPayment({ filing_id: _uuid() }),                      /payment_minor/);
  await assert.rejects(f.stf.recordPayment({
    filing_id: _uuid(), payment_minor: -1, payment_ref: "x",
  }), /payment_minor/);
  await assert.rejects(f.stf.recordPayment({
    filing_id: _uuid(), payment_minor: 100,
  }), /payment_ref/);

  // markAmended
  await assert.rejects(f.stf.markAmended(),                                              /input object required/);
  await assert.rejects(f.stf.markAmended({ filing_id: _uuid() }),                        /reason/);
  await assert.rejects(f.stf.markAmended({ filing_id: _uuid(), reason: "" }),            /reason/);

  // getFiling
  await assert.rejects(f.stf.getFiling("not-a-uuid"),                                    /filing_id/);

  // listFilings
  await assert.rejects(f.stf.listFilings({ jurisdiction: "bogus" }),                     /jurisdiction/);
  await assert.rejects(f.stf.listFilings({ status:       "bogus" }),                     /status/);
  await assert.rejects(f.stf.listFilings({ limit:        0 }),                           /limit/);

  // auditReportForJurisdiction
  await assert.rejects(f.stf.auditReportForJurisdiction(),                               /input object required/);
  await assert.rejects(f.stf.auditReportForJurisdiction({
    jurisdiction: "US-CA", from: 100, to: 50,
  }), /to must be > from/);

  // upcomingDue
  await assert.rejects(f.stf.upcomingDue(),                                              /input object required/);
  await assert.rejects(f.stf.upcomingDue({ days_ahead: 0 }),                             /days_ahead/);
  await assert.rejects(f.stf.upcomingDue({ days_ahead: 99999 }),                         /days_ahead/);
}

// ---- 8. exported constants ---------------------------------------------

async function _exportedConstants() {
  check("KINDS exported",     Array.isArray(salesTaxFilings.KINDS)
                              && salesTaxFilings.KINDS.indexOf("monthly")   !== -1
                              && salesTaxFilings.KINDS.indexOf("quarterly") !== -1
                              && salesTaxFilings.KINDS.indexOf("annual")    !== -1);
  check("STATUSES exported",  Array.isArray(salesTaxFilings.STATUSES)
                              && salesTaxFilings.STATUSES.indexOf("draft")     !== -1
                              && salesTaxFilings.STATUSES.indexOf("computed")  !== -1
                              && salesTaxFilings.STATUSES.indexOf("submitted") !== -1
                              && salesTaxFilings.STATUSES.indexOf("paid")      !== -1
                              && salesTaxFilings.STATUSES.indexOf("amended")   !== -1);
  check("JURISDICTION_RE exported", salesTaxFilings.JURISDICTION_RE instanceof RegExp);

  var inst = salesTaxFilings.create({ query: _makeQuery().query });
  check("instance exposes KINDS",    inst.KINDS.length === salesTaxFilings.KINDS.length);
  check("instance exposes STATUSES", inst.STATUSES.length === salesTaxFilings.STATUSES.length);
}

async function run() {
  await _defineFilingPeriodShape();
  await _computeFilingAggregates();
  await _computeFilingExempt();
  await _fsmTransitions();
  await _upcomingDueWindow();
  await _listAndAudit();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("sales-tax-filings: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
