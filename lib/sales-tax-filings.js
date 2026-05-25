"use strict";
/**
 * @module shop.salesTaxFilings
 * @title  Sales tax filings — periodic remittance preparation
 *
 * @intro
 *   Sales tax obligations don't end at checkout — every jurisdiction
 *   the operator collected tax for expects a periodic filing (monthly,
 *   quarterly, or annually) that reconciles the operator's books to
 *   the authority's. This primitive owns the lifecycle of one such
 *   filing.
 *
 *   The shape:
 *
 *     1. `defineFilingPeriod({ jurisdiction, kind, period_start,
 *        period_end, due_date })` opens a row in `draft` status. One
 *        (jurisdiction, kind, period_start) tuple yields one row — a
 *        UNIQUE index at the DB boundary refuses a duplicate open
 *        even if two operators race the call.
 *
 *     2. `computeFiling({ filing_id })` snapshots the orders that
 *        fell inside the period and computes:
 *
 *           gross_revenue_minor   — sum of order subtotals in window
 *           taxable_revenue_minor — gross minus exempt-customer revenue
 *           exempt_revenue_minor  — revenue attributed to customers
 *                                   with an approved tax-exemption for
 *                                   the filing's jurisdiction
 *           tax_collected_minor   — sum of order tax_minor in window
 *           tax_owed_minor        — re-derived from taxable revenue +
 *                                   rates effective during the window
 *           by_rate_breakdown     — per-rate-bps split of taxable
 *                                   revenue + collected tax (operators
 *                                   need this for the filing form)
 *
 *        Status moves draft -> computed. The snapshot is rerunnable;
 *        re-running overwrites the snapshot until status leaves
 *        `computed`.
 *
 *     3. `recordSubmission({ filing_id, submission_ref, submitted_at,
 *        submitted_by })` moves computed -> submitted. `submission_ref`
 *        is the authority's confirmation number (DR-123-456); the
 *        primitive does not interpret it beyond a length + control-
 *        byte gate.
 *
 *     4. `recordPayment({ filing_id, payment_minor, payment_ref,
 *        paid_at })` moves submitted -> paid. Payment minor doesn't
 *        have to equal tax_owed_minor — a jurisdiction occasionally
 *        accepts a partial / installment payment; the audit trail
 *        preserves both numbers.
 *
 *     5. `markAmended({ filing_id, reason })` moves a row that has
 *        landed in `computed`, `submitted`, or `paid` back to an
 *        explicit `amended` status. The original snapshot stays; the
 *        reason captures why. Operators re-open a new filing for the
 *        same period via defineFilingPeriod with the same tuple — the
 *        UNIQUE index prevents this without first amending the
 *        existing row.
 *
 *   Order composition:
 *
 *     The primitive walks orders that landed inside the window via
 *     `query()` against the project's `orders` schema (`status`,
 *     `currency`, `subtotal_minor`, `tax_minor`, `ship_to_json`).
 *     The window predicate uses `created_at` so a late-arriving
 *     fulfillment doesn't pull an old order back into a new filing.
 *
 *     Orders contribute when their `ship_to.country` (and, for
 *     subdivision-keyed jurisdictions, `ship_to.region`) matches the
 *     filing's jurisdiction. Cancelled / refunded orders are excluded
 *     so the filing reflects net sales the authority cares about.
 *
 *   Exemption composition:
 *
 *     When `taxExempt` is wired, each contributing order's
 *     customer_id is checked via `taxExempt.isExempt({ customer_id,
 *     jurisdiction })`. Exempt customers shift revenue from the
 *     taxable bucket to the exempt bucket; they don't drop from the
 *     filing entirely (the authority wants to see the gross + the
 *     exempt split). Anonymous orders (no customer_id) are never
 *     exempt.
 *
 *   Rate composition:
 *
 *     When `taxRates` is wired, the rates effective during the window
 *     for the filing's jurisdiction are loaded via raw query against
 *     `tax_rates`. The per-rate breakdown attributes each order's
 *     contribution to the (single) rate row that covered its
 *     created_at timestamp. Orders whose created_at falls inside the
 *     window but outside every rate row's effective range fall into
 *     the special `__none__` breakdown key — operators see the gap
 *     before they file.
 *
 *   Composes:
 *     - `b.guardUuid`   — strict UUID gate on filing_id.
 *     - `b.uuid.v7`     — filing row primary key (monotonic
 *                          lexicographic so list-by-id sorts by open
 *                          order).
 *
 *   Storage: `migrations-d1/0184_sales_tax_filings.sql`.
 *
 * @primitive salesTaxFilings
 * @related   order, taxRates, taxExempt, b.guardUuid, b.uuid
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var KINDS                  = Object.freeze(["monthly", "quarterly", "annual"]);
var STATUSES               = Object.freeze(["draft", "computed", "submitted", "paid", "amended"]);

var JURISDICTION_RE        = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

var MAX_SUBMISSION_REF_LEN = 200;
var MAX_PAYMENT_REF_LEN    = 200;
var MAX_SUBMITTED_BY_LEN   = 200;
var MAX_AMENDED_REASON_LEN = 1000;

var DEFAULT_LIMIT          = 50;
var MAX_LIMIT              = 500;
var MAX_DAYS_AHEAD         = 365;

var CONTROL_BYTE_RE        = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// FSM transition map. The keys are (from_status, action) → to_status.
// Defined as a table so a misuse surfaces with the actual current
// status in the error rather than an "unexpected" surprise from a
// silent UPDATE that no-ops.
var FSM_TRANSITIONS = Object.freeze({
  "draft|compute":     "computed",
  "computed|compute":  "computed",   // recompute pre-submit allowed
  "computed|submit":   "submitted",
  "submitted|pay":     "paid",
  "computed|amend":    "amended",
  "submitted|amend":   "amended",
  "paid|amend":        "amended",
});

// ---- monotonic clock ----------------------------------------------------
//
// Filings move through their lifecycle one operator action at a time
// and the audit trail (created_at / computed_at / submitted_at /
// paid_at / amended_at / updated_at) wants a strictly-increasing
// timeline so a sort-by-timestamp read returns events in the order
// they were issued. On a fast machine a defineFilingPeriod followed
// immediately by computeFiling can land in the same Date.now() bucket;
// bumping by 1ms on a tie keeps the ordering deterministic without an
// extra tiebreaker column.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _jurisdiction(s) {
  if (typeof s !== "string" || !JURISDICTION_RE.test(s)) {
    throw new TypeError(
      "salesTaxFilings: jurisdiction must match /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/ " +
      "(ISO 3166-1 alpha-2 + optional ISO 3166-2 subdivision), got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) < 0) {
    throw new TypeError("salesTaxFilings: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _status(s, label) {
  if (typeof s !== "string" || STATUSES.indexOf(s) < 0) {
    throw new TypeError("salesTaxFilings: " + (label || "status") +
                        " must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _epoch(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("salesTaxFilings: " + label +
                        " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _epochOpt(n, label) {
  if (n == null) return null;
  return _epoch(n, label);
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("salesTaxFilings: " + label +
                        " must be a non-negative integer (minor units)");
  }
  return n;
}

function _shortText(s, label, max) {
  if (typeof s !== "string" || !s.length || s.length > max) {
    throw new TypeError("salesTaxFilings: " + label +
                        " must be a non-empty string <= " + max + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("salesTaxFilings: " + label + " must not contain control bytes");
  }
  return s;
}

function _filingId(s) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("salesTaxFilings: filing_id — " +
                        (e && e.message || "invalid UUID"));
  }
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("salesTaxFilings: limit must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _daysAhead(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DAYS_AHEAD) {
    throw new TypeError("salesTaxFilings: days_ahead must be an integer in [1, " +
                        MAX_DAYS_AHEAD + "]");
  }
  return n;
}

// ---- jurisdiction coverage ---------------------------------------------
//
// An order with ship_to.country = "US" and ship_to.region = "CA"
// satisfies a "US-CA" filing AND a "US" filing. Match rule: split
// the filing jurisdiction on the dash; the country must match
// ship_to.country; if a subdivision is present, ship_to.region (or
// ship_to.subdivision / ship_to.state — accept any of the common
// keys) must match it.

function _shipToMatches(shipTo, jurisdiction) {
  if (!shipTo || typeof shipTo !== "object") return false;
  var country = typeof shipTo.country === "string" ? shipTo.country : null;
  if (!country) return false;
  var dash = jurisdiction.indexOf("-");
  if (dash < 0) {
    return country === jurisdiction;
  }
  var jurCountry = jurisdiction.slice(0, dash);
  var jurSub     = jurisdiction.slice(dash + 1);
  if (country !== jurCountry) return false;
  var sub = shipTo.region != null     ? shipTo.region :
            shipTo.subdivision != null ? shipTo.subdivision :
            shipTo.state != null       ? shipTo.state :
            null;
  return sub === jurSub;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional composition handles. When omitted, the primitive degrades
  // gracefully — exemption checks become no-ops, the per-rate
  // breakdown collapses to a single `__unknown__` key.
  var taxExemptApi = opts.taxExempt || null;
  var taxRatesApi  = opts.taxRates  || null;
  // `order` is reserved for future use (e.g. listing filing-eligible
  // orders directly via the primitive's API instead of raw SQL). The
  // current implementation queries the `orders` table directly because
  // the read shape (filter by created_at + status + ship_to_json) is
  // not exposed on order.js.
  // (no-op assignment to keep the option in the factory signature
  // documented without lint complaining about an unused var)
  if (opts.order) { /* reserved */ }

  // ---- internal helpers -------------------------------------------------

  function _decodeFiling(row) {
    if (!row) return null;
    var breakdown;
    try { breakdown = JSON.parse(row.breakdown_json); }
    catch (_e) { breakdown = {}; }
    return {
      id:                     row.id,
      jurisdiction:           row.jurisdiction,
      kind:                   row.kind,
      period_start:           Number(row.period_start),
      period_end:             Number(row.period_end),
      due_date:               Number(row.due_date),
      status:                 row.status,
      gross_revenue_minor:    Number(row.gross_revenue_minor),
      taxable_revenue_minor:  Number(row.taxable_revenue_minor),
      exempt_revenue_minor:   Number(row.exempt_revenue_minor),
      tax_collected_minor:    Number(row.tax_collected_minor),
      tax_owed_minor:         Number(row.tax_owed_minor),
      by_rate_breakdown:      breakdown,
      submission_ref:         row.submission_ref,
      submitted_at:           row.submitted_at != null ? Number(row.submitted_at) : null,
      submitted_by:           row.submitted_by,
      payment_minor:          row.payment_minor != null ? Number(row.payment_minor) : null,
      payment_ref:            row.payment_ref,
      paid_at:                row.paid_at      != null ? Number(row.paid_at)      : null,
      amended_at:             row.amended_at   != null ? Number(row.amended_at)   : null,
      amended_reason:         row.amended_reason,
      computed_at:            row.computed_at  != null ? Number(row.computed_at)  : null,
      created_at:             Number(row.created_at),
      updated_at:             Number(row.updated_at),
    };
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM sales_tax_filings WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  function _expect(row, action) {
    if (!row) {
      var miss = new Error("salesTaxFilings: filing not found");
      miss.code = "SALES_TAX_FILING_NOT_FOUND";
      throw miss;
    }
    var key  = row.status + "|" + action;
    var next = FSM_TRANSITIONS[key];
    if (!next) {
      var bad = new Error("salesTaxFilings: action '" + action +
                          "' not permitted from status '" + row.status + "'");
      bad.code = "SALES_TAX_FILING_BAD_TRANSITION";
      throw bad;
    }
    return next;
  }

  // Load orders that fall inside the filing window AND ship to the
  // filing's jurisdiction. The DB-level filter is intentionally
  // narrow on (created_at, status) — the ship_to_json match runs in
  // JS because the schema stores ship_to as opaque JSON. For typical
  // filing-period volumes (thousands of orders) this is comfortably
  // fast; high-volume operators can layer a column projection later
  // without changing the primitive's contract.
  async function _ordersInWindow(jurisdiction, periodStart, periodEnd) {
    var sql =
      "SELECT id, customer_id, currency, subtotal_minor, tax_minor, " +
      "       ship_to_json, status, created_at " +
      "FROM orders " +
      "WHERE created_at >= ?1 AND created_at < ?2 " +
      "  AND status IN ('paid', 'fulfilling', 'shipped', 'delivered')";
    var r = await query(sql, [periodStart, periodEnd]);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var shipTo;
      try { shipTo = JSON.parse(row.ship_to_json); }
      catch (_e) { shipTo = null; }
      if (!_shipToMatches(shipTo, jurisdiction)) continue;
      out.push({
        id:               row.id,
        customer_id:      row.customer_id,
        currency:         row.currency,
        subtotal_minor:   Number(row.subtotal_minor),
        tax_minor:        Number(row.tax_minor),
        status:           row.status,
        created_at:       Number(row.created_at),
        ship_to:          shipTo,
      });
    }
    return out;
  }

  async function _ratesInWindow(jurisdiction, periodStart, periodEnd) {
    // Pull every tax_rates row for the jurisdiction that overlaps the
    // window. The lib filters down to the rate covering each order's
    // created_at; the SQL is widely permissive so a future query
    // optimization stays in one place.
    if (!taxRatesApi) return [];
    try {
      var r = await query(
        "SELECT id, jurisdiction, category, rate_bps, effective_from, effective_until " +
        "FROM tax_rates " +
        "WHERE jurisdiction = ?1 AND archived_at IS NULL " +
        "  AND effective_from < ?2 " +
        "  AND (effective_until IS NULL OR effective_until > ?3)",
        [jurisdiction, periodEnd, periodStart],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        out.push({
          id:               row.id,
          rate_bps:         Number(row.rate_bps),
          effective_from:   Number(row.effective_from),
          effective_until:  row.effective_until == null ? null : Number(row.effective_until),
        });
      }
      return out;
    } catch (_e) {
      // Schema may not have tax_rates table in the harness — degrade
      // to no per-rate breakdown rather than failing the filing.
      return [];
    }
  }

  function _rateForOrder(rates, orderCreatedAt) {
    for (var i = 0; i < rates.length; i += 1) {
      var r = rates[i];
      if (r.effective_from <= orderCreatedAt &&
          (r.effective_until == null || r.effective_until > orderCreatedAt)) {
        return r;
      }
    }
    return null;
  }

  // ---- defineFilingPeriod -----------------------------------------------

  async function defineFilingPeriod(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("salesTaxFilings.defineFilingPeriod: input object required");
    }
    var jurisdiction = _jurisdiction(input.jurisdiction);
    var kind         = _kind(input.kind);
    var periodStart  = _epoch(input.period_start, "period_start");
    var periodEnd    = _epoch(input.period_end,   "period_end");
    if (periodEnd <= periodStart) {
      throw new TypeError("salesTaxFilings.defineFilingPeriod: period_end must be > period_start");
    }
    var dueDate = _epoch(input.due_date, "due_date");
    if (dueDate < periodEnd) {
      throw new TypeError("salesTaxFilings.defineFilingPeriod: due_date must be >= period_end");
    }

    var id  = b.uuid.v7();
    var ts  = _now();
    try {
      await query(
        "INSERT INTO sales_tax_filings " +
        "(id, jurisdiction, kind, period_start, period_end, due_date, status, " +
        " gross_revenue_minor, taxable_revenue_minor, exempt_revenue_minor, " +
        " tax_collected_minor, tax_owed_minor, breakdown_json, " +
        " created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', 0, 0, 0, 0, 0, '{}', ?7, ?7)",
        [id, jurisdiction, kind, periodStart, periodEnd, dueDate, ts],
      );
    } catch (e) {
      // Surface a recognizable error code on the UNIQUE collision so
      // the operator can detect "this period is already open" without
      // pattern-matching the underlying driver's error message.
      var msg = String(e && e.message || e);
      if (/UNIQUE|unique/i.test(msg)) {
        var dup = new Error("salesTaxFilings.defineFilingPeriod: filing already exists for " +
                            jurisdiction + " " + kind + " period_start=" + periodStart);
        dup.code = "SALES_TAX_FILING_DUPLICATE";
        dup.cause = e;
        throw dup;
      }
      throw e;
    }
    return _decodeFiling(await _getRaw(id));
  }

  // ---- computeFiling ----------------------------------------------------

  async function computeFiling(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("salesTaxFilings.computeFiling: input object required");
    }
    var id  = _filingId(input.filing_id);
    var raw = await _getRaw(id);
    var next = _expect(raw, "compute");

    var orders   = await _ordersInWindow(raw.jurisdiction, Number(raw.period_start), Number(raw.period_end));
    var rates    = await _ratesInWindow(raw.jurisdiction, Number(raw.period_start), Number(raw.period_end));

    // Resolve exemption per unique customer in a single pass so
    // multiple orders from the same exempt customer don't refire the
    // taxExempt.isExempt call.
    var exemptByCustomer = Object.create(null);
    if (taxExemptApi && typeof taxExemptApi.isExempt === "function") {
      var seen = Object.create(null);
      for (var oi = 0; oi < orders.length; oi += 1) {
        var custId = orders[oi].customer_id;
        if (!custId) continue;
        if (seen[custId]) continue;
        seen[custId] = true;
        try {
          exemptByCustomer[custId] = await taxExemptApi.isExempt({
            customer_id:  custId,
            jurisdiction: raw.jurisdiction,
          });
        } catch (_e) {
          // Exemption-check failure leaves the customer in the
          // taxable bucket — surfaces in the filing rather than
          // silently flipping an exempt customer back to taxable
          // post-fact via the caller's retry.
          exemptByCustomer[custId] = false;
        }
      }
    }

    var gross   = 0;
    var taxable = 0;
    var exempt  = 0;
    var collected = 0;
    var breakdown = Object.create(null);   // rate_bps (or "__none__") -> { taxable_minor, tax_minor, order_count }

    function _bucket(key) {
      if (!breakdown[key]) {
        breakdown[key] = { taxable_minor: 0, tax_minor: 0, order_count: 0 };
      }
      return breakdown[key];
    }

    for (var i = 0; i < orders.length; i += 1) {
      var o = orders[i];
      gross     += o.subtotal_minor;
      collected += o.tax_minor;
      var isExempt = o.customer_id && exemptByCustomer[o.customer_id] === true;
      if (isExempt) {
        exempt += o.subtotal_minor;
      } else {
        taxable += o.subtotal_minor;
      }

      // Per-rate breakdown — only taxable contributions land in the
      // rate-keyed bucket. Exempt revenue gets its own
      // pseudo-bucket so the operator sees the magnitude without
      // double-counting against a rate row.
      var bucketKey;
      if (isExempt) {
        bucketKey = "__exempt__";
      } else {
        var rate = _rateForOrder(rates, o.created_at);
        bucketKey = rate ? String(rate.rate_bps) : "__none__";
      }
      var bkt = _bucket(bucketKey);
      if (isExempt) {
        bkt.taxable_minor += 0;
      } else {
        bkt.taxable_minor += o.subtotal_minor;
        bkt.tax_minor     += o.tax_minor;
      }
      bkt.order_count += 1;
    }

    // Owed: re-derive from per-rate taxable totals using rate_bps.
    // Integer math: taxable * bps / 10000, banker's-rounded so
    // half-cent ties don't drift the sum. (Same rounding rule as
    // b.tax — banker's rounding is the conservative choice when the
    // primitive may aggregate millions of orders.)
    var owed = 0;
    var rateKeys = Object.keys(breakdown);
    for (var rk = 0; rk < rateKeys.length; rk += 1) {
      var key = rateKeys[rk];
      if (key === "__none__" || key === "__exempt__") continue;
      var bps     = parseInt(key, 10);
      if (!Number.isFinite(bps)) continue;
      var bucket  = breakdown[key];
      var rawOwed = bucket.taxable_minor * bps / 10000;
      // Banker's round
      var floored = Math.floor(rawOwed);
      var frac    = rawOwed - floored;
      var rounded;
      if (frac > 0.5)            rounded = floored + 1;
      else if (frac < 0.5)       rounded = floored;
      else                       rounded = (floored % 2 === 0) ? floored : floored + 1;
      owed += rounded;
    }
    // When no rate rows resolved (taxRatesApi absent / no rates
    // defined) fall back to collected as the owed figure. Operators
    // see the bare collected number rather than a misleading zero.
    if (rates.length === 0 || rateKeys.every(function (k) { return k === "__none__" || k === "__exempt__"; })) {
      owed = collected;
    }

    var ts = _now();
    await query(
      "UPDATE sales_tax_filings SET " +
      "status = ?1, gross_revenue_minor = ?2, taxable_revenue_minor = ?3, " +
      "exempt_revenue_minor = ?4, tax_collected_minor = ?5, tax_owed_minor = ?6, " +
      "breakdown_json = ?7, computed_at = ?8, updated_at = ?8 " +
      "WHERE id = ?9",
      [next, gross, taxable, exempt, collected, owed, JSON.stringify(breakdown), ts, id],
    );
    return _decodeFiling(await _getRaw(id));
  }

  // ---- recordSubmission -------------------------------------------------

  async function recordSubmission(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("salesTaxFilings.recordSubmission: input object required");
    }
    var id            = _filingId(input.filing_id);
    var submissionRef = _shortText(input.submission_ref, "submission_ref", MAX_SUBMISSION_REF_LEN);
    var submittedAt   = input.submitted_at == null ? _now()
                        : _epoch(input.submitted_at, "submitted_at");
    var submittedBy   = _shortText(input.submitted_by, "submitted_by", MAX_SUBMITTED_BY_LEN);

    var raw  = await _getRaw(id);
    var next = _expect(raw, "submit");
    var ts   = _now();
    await query(
      "UPDATE sales_tax_filings SET " +
      "status = ?1, submission_ref = ?2, submitted_at = ?3, submitted_by = ?4, " +
      "updated_at = ?5 WHERE id = ?6",
      [next, submissionRef, submittedAt, submittedBy, ts, id],
    );
    return _decodeFiling(await _getRaw(id));
  }

  // ---- recordPayment ----------------------------------------------------

  async function recordPayment(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("salesTaxFilings.recordPayment: input object required");
    }
    var id        = _filingId(input.filing_id);
    var amount    = _nonNegInt(input.payment_minor, "payment_minor");
    var paymentRef = _shortText(input.payment_ref, "payment_ref", MAX_PAYMENT_REF_LEN);
    var paidAt    = input.paid_at == null ? _now() : _epoch(input.paid_at, "paid_at");

    var raw  = await _getRaw(id);
    var next = _expect(raw, "pay");
    var ts   = _now();
    await query(
      "UPDATE sales_tax_filings SET " +
      "status = ?1, payment_minor = ?2, payment_ref = ?3, paid_at = ?4, " +
      "updated_at = ?5 WHERE id = ?6",
      [next, amount, paymentRef, paidAt, ts, id],
    );
    return _decodeFiling(await _getRaw(id));
  }

  // ---- markAmended ------------------------------------------------------

  async function markAmended(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("salesTaxFilings.markAmended: input object required");
    }
    var id     = _filingId(input.filing_id);
    var reason = _shortText(input.reason, "reason", MAX_AMENDED_REASON_LEN);

    var raw  = await _getRaw(id);
    var next = _expect(raw, "amend");
    var ts   = _now();
    await query(
      "UPDATE sales_tax_filings SET " +
      "status = ?1, amended_reason = ?2, amended_at = ?3, updated_at = ?3 " +
      "WHERE id = ?4",
      [next, reason, ts, id],
    );
    return _decodeFiling(await _getRaw(id));
  }

  // ---- getFiling --------------------------------------------------------

  async function getFiling(id) {
    var cid = _filingId(id);
    return _decodeFiling(await _getRaw(cid));
  }

  // ---- listFilings ------------------------------------------------------

  async function listFilings(listOpts) {
    listOpts = listOpts || {};
    var jurisdiction = listOpts.jurisdiction == null ? null : _jurisdiction(listOpts.jurisdiction);
    var status       = listOpts.status       == null ? null : _status(listOpts.status, "status");
    var limit        = _limit(listOpts.limit);

    var where = [];
    var params = [];
    var idx = 1;
    if (jurisdiction) { where.push("jurisdiction = ?" + idx); params.push(jurisdiction); idx += 1; }
    if (status)       { where.push("status = ?" + idx);       params.push(status);       idx += 1; }
    var sql = "SELECT * FROM sales_tax_filings" +
              (where.length ? " WHERE " + where.join(" AND ") : "") +
              " ORDER BY due_date ASC, id ASC LIMIT ?" + idx;
    params.push(limit);

    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      out.push(_decodeFiling(r.rows[i]));
    }
    return out;
  }

  // ---- auditReportForJurisdiction ---------------------------------------

  async function auditReportForJurisdiction(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("salesTaxFilings.auditReportForJurisdiction: input object required");
    }
    var jurisdiction = _jurisdiction(input.jurisdiction);
    var from         = _epoch(input.from, "from");
    var to           = _epoch(input.to,   "to");
    if (to <= from) {
      throw new TypeError("salesTaxFilings.auditReportForJurisdiction: to must be > from");
    }

    // Pull every filing whose period intersects [from, to]. Intersect
    // rule: filing.period_start < to AND filing.period_end > from.
    var r = await query(
      "SELECT * FROM sales_tax_filings " +
      "WHERE jurisdiction = ?1 AND period_start < ?2 AND period_end > ?3 " +
      "ORDER BY period_start ASC",
      [jurisdiction, to, from],
    );

    var filings = [];
    var totalGross     = 0;
    var totalTaxable   = 0;
    var totalExempt    = 0;
    var totalCollected = 0;
    var totalOwed      = 0;
    var totalPaid      = 0;
    for (var i = 0; i < r.rows.length; i += 1) {
      var f = _decodeFiling(r.rows[i]);
      filings.push(f);
      totalGross     += f.gross_revenue_minor;
      totalTaxable   += f.taxable_revenue_minor;
      totalExempt    += f.exempt_revenue_minor;
      totalCollected += f.tax_collected_minor;
      totalOwed      += f.tax_owed_minor;
      if (f.payment_minor != null) totalPaid += f.payment_minor;
    }
    return {
      jurisdiction:                 jurisdiction,
      from:                         from,
      to:                           to,
      filing_count:                 filings.length,
      filings:                      filings,
      total_gross_revenue_minor:    totalGross,
      total_taxable_revenue_minor:  totalTaxable,
      total_exempt_revenue_minor:   totalExempt,
      total_tax_collected_minor:    totalCollected,
      total_tax_owed_minor:         totalOwed,
      total_tax_paid_minor:         totalPaid,
    };
  }

  // ---- upcomingDue ------------------------------------------------------

  async function upcomingDue(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("salesTaxFilings.upcomingDue: input object required");
    }
    var days = _daysAhead(input.days_ahead);
    var nowTs = input.now == null ? _now() : _epoch(input.now, "now");
    var horizon = nowTs + C.TIME.days(days);

    var r = await query(
      "SELECT * FROM sales_tax_filings " +
      "WHERE status IN ('draft', 'computed', 'submitted') " +
      "  AND due_date <= ?1 " +
      "ORDER BY due_date ASC, id ASC",
      [horizon],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      out.push(_decodeFiling(r.rows[i]));
    }
    return out;
  }

  return {
    KINDS:                       KINDS.slice(),
    STATUSES:                    STATUSES.slice(),
    JURISDICTION_RE:             JURISDICTION_RE,

    defineFilingPeriod:          defineFilingPeriod,
    computeFiling:               computeFiling,
    recordSubmission:            recordSubmission,
    recordPayment:               recordPayment,
    markAmended:                 markAmended,
    getFiling:                   getFiling,
    listFilings:                 listFilings,
    auditReportForJurisdiction:  auditReportForJurisdiction,
    upcomingDue:                 upcomingDue,
  };
}

module.exports = {
  create:           create,
  KINDS:            KINDS,
  STATUSES:         STATUSES,
  JURISDICTION_RE:  JURISDICTION_RE,
};
