"use strict";
/**
 * @module shop.taxRemittance
 * @title  Tax remittance — per-jurisdiction payment tracking +
 *         filing reconciliation
 *
 * @intro
 *   `salesTaxFilings` owns the lifecycle of a filing (open period,
 *   compute snapshot, record submission, record nominal payment).
 *   This primitive owns the lifecycle of the actual money — the
 *   bank-side artifact that proves the operator paid the authority
 *   the amount the filing said they owed. The two surfaces are
 *   deliberately separate:
 *
 *     * A filing carries the operator's view of what's owed (taxable
 *       revenue + per-rate breakdown + due date). It's a tax-form-
 *       shaped object.
 *     * A remittance carries the bank's view of what cleared (which
 *       payment method, which reference number, when it settled). It's
 *       a ledger-shaped object.
 *
 *   Operators reconcile the two via `reconcileWithFiling({
 *   remittance_id })` — the read sums every non-voided remittance for
 *   the filing and reports the variance against the filing's
 *   `tax_owed_minor`. Variance > 0 means the operator's still on the
 *   hook; variance < 0 means the authority owes a refund or applied
 *   the overage to the next period.
 *
 *   API:
 *
 *     - `recordRemittance({ filing_id, jurisdiction, amount_minor,
 *        currency, payment_method, payment_ref, paid_at })`
 *        Inserts a row in `paid` status. payment_method is one of
 *        bank_transfer / credit_card / ach / wire / check. Returns
 *        the decoded row.
 *     - `getRemittance(id)` — by-id lookup; returns null on miss.
 *     - `remittancesForJurisdiction({ jurisdiction, from, to })` —
 *        every row whose paid_at falls in [from, to), ordered by
 *        paid_at DESC. Voided rows included so the operator sees
 *        them.
 *     - `unpaidObligations({ as_of, jurisdiction? })` — every filing
 *        whose status is submitted (or paid via the salesTaxFilings
 *        primitive, but where the actual remittance sum is short of
 *        tax_owed_minor) and whose due_date <= as_of. Requires the
 *        `salesTaxFilings` API to be wired so the read can compare
 *        owed vs. actually-remitted.
 *     - `lateRemittances({ as_of, days_late_min })` — rows where
 *        paid_at - filing.due_date >= days_late_min * 86_400_000.
 *        Requires salesTaxFilings to resolve due dates.
 *     - `reconcileWithFiling({ remittance_id })` — looks up the
 *        remittance's filing, sums every non-voided remittance for
 *        it, returns `{ filing_id, owed_minor, paid_minor,
 *        variance_minor }`. variance > 0 = underpaid; < 0 = overpaid;
 *        == 0 = settled exactly.
 *     - `metricsForJurisdiction({ jurisdiction, from, to })` —
 *        rollup over the window: total_paid_minor, total_penalty_minor,
 *        remittance_count, voided_count, on_time_count, late_count,
 *        on_time_rate (on_time / (on_time + late) — 1.0 when no late
 *        remittances). On-time = paid_at <= filing.due_date.
 *     - `markVoided({ remittance_id, reason })` — flips status to
 *        voided, stamps voided_at + void_reason. Idempotent on
 *        already-voided.
 *     - `recordPenalty({ remittance_id, penalty_minor, reason })` —
 *        attaches a penalty after the authority assesses one. Amends
 *        the same row (rather than opening a sibling) so the per-row
 *        metrics read sees one canonical artifact per payment.
 *
 *   Composes:
 *     - `b.guardUuid` — strict UUID gate on every id input.
 *     - `b.uuid.v7`  — primary key for tax_remittances. Monotonic
 *                       lexicographic so list-by-id sorts in issue
 *                       order without a secondary timestamp column.
 *     - `salesTaxFilings` (optional handle) — used by
 *       `unpaidObligations`, `lateRemittances`, `reconcileWithFiling`,
 *       and `metricsForJurisdiction` to resolve due dates + owed
 *       totals. The primitive degrades gracefully when the handle is
 *       absent: reads that need it surface a clear error code; reads
 *       that don't (recordRemittance, getRemittance,
 *       remittancesForJurisdiction, markVoided, recordPenalty) keep
 *       working.
 *
 *   Storage: `migrations-d1/0204_tax_remittance.sql`.
 *
 * @primitive taxRemittance
 * @related   salesTaxFilings, b.guardUuid, b.uuid
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}
var C = _b().constants;

// ---- constants ----------------------------------------------------------

var PAYMENT_METHODS         = Object.freeze([
  "bank_transfer", "credit_card", "ach", "wire", "check",
]);
var STATUSES                = Object.freeze(["paid", "voided"]);

var JURISDICTION_RE         = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
var CURRENCY_RE             = /^[A-Z]{3}$/;

var MAX_PAYMENT_REF_LEN     = 200;
var MAX_VOID_REASON_LEN     = 1000;
var MAX_PENALTY_REASON_LEN  = 1000;

var DEFAULT_DAYS_LATE_MIN   = 1;
var MAX_DAYS_LATE_MIN       = 3650;            // ~10 years
var MS_PER_DAY              = C.TIME.days(1);

var CONTROL_BYTE_RE         = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// ---- monotonic clock ----------------------------------------------------
//
// Remittance rows carry `paid_at` (provided by the caller from the
// bank's settlement timestamp) AND `created_at` (the audit stamp for
// when the operator recorded the row). On a fast machine a sequence
// of `recordRemittance` calls — e.g. an operator batch-recording the
// month's remittances — can land in the same Date.now() bucket. A
// strict-monotonic clock guarantees the audit trail's
// `created_at` values are strictly increasing so list-by-creation
// reads return rows in the order they were issued, without an extra
// tiebreaker column.

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
      "taxRemittance: jurisdiction must match /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/ " +
      "(ISO 3166-1 alpha-2 + optional ISO 3166-2 subdivision), got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("taxRemittance: currency must be a 3-letter ISO 4217 code (e.g. USD)");
  }
  return s;
}

function _paymentMethod(s) {
  if (typeof s !== "string" || PAYMENT_METHODS.indexOf(s) < 0) {
    throw new TypeError("taxRemittance: payment_method must be one of " + PAYMENT_METHODS.join(", "));
  }
  return s;
}

function _epoch(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("taxRemittance: " + label + " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("taxRemittance: " + label + " must be a positive integer (minor units)");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("taxRemittance: " + label + " must be a non-negative integer (minor units)");
  }
  return n;
}

function _shortText(s, label, max) {
  if (typeof s !== "string" || !s.length || s.length > max) {
    throw new TypeError("taxRemittance: " + label +
                        " must be a non-empty string <= " + max + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("taxRemittance: " + label + " must not contain control bytes");
  }
  return s;
}

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("taxRemittance: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _daysLateMin(n) {
  if (n == null) return DEFAULT_DAYS_LATE_MIN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_DAYS_LATE_MIN) {
    throw new TypeError("taxRemittance: days_late_min must be an integer in [0, " +
                        MAX_DAYS_LATE_MIN + "]");
  }
  return n;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Optional composition handle. `salesTaxFilings` is required for any
  // read that needs to resolve filing.tax_owed_minor / filing.due_date
  // (reconcileWithFiling, unpaidObligations, lateRemittances,
  // metricsForJurisdiction). When absent, those reads surface a clear
  // error rather than returning misleading partial data.
  var filingsApi = null;
  if (opts.salesTaxFilings != null) {
    if (!opts.salesTaxFilings || typeof opts.salesTaxFilings.getFiling !== "function") {
      throw new TypeError("taxRemittance: salesTaxFilings handle must expose getFiling()");
    }
    filingsApi = opts.salesTaxFilings;
  }

  function _requireFilings(label) {
    if (!filingsApi) {
      var e = new Error("taxRemittance." + label + ": salesTaxFilings must be wired");
      e.code = "TAX_REMITTANCE_FILINGS_NOT_WIRED";
      throw e;
    }
    return filingsApi;
  }

  function _decodeRemittance(row) {
    if (!row) return null;
    return {
      id:             row.id,
      filing_id:      row.filing_id,
      jurisdiction:   row.jurisdiction,
      amount_minor:   Number(row.amount_minor),
      currency:       row.currency,
      payment_method: row.payment_method,
      payment_ref:    row.payment_ref,
      paid_at:        Number(row.paid_at),
      status:         row.status,
      voided_at:      row.voided_at != null ? Number(row.voided_at) : null,
      void_reason:    row.void_reason,
      penalty_minor:  row.penalty_minor != null ? Number(row.penalty_minor) : null,
      penalty_reason: row.penalty_reason,
      created_at:     Number(row.created_at),
    };
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM tax_remittances WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // ---- recordRemittance -------------------------------------------------

  async function recordRemittance(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.recordRemittance: input object required");
    }
    var filingId   = _uuid(input.filing_id, "filing_id");
    var jur        = _jurisdiction(input.jurisdiction);
    var amount     = _positiveInt(input.amount_minor, "amount_minor");
    var currency   = _currency(input.currency);
    var method     = _paymentMethod(input.payment_method);
    var paymentRef = _shortText(input.payment_ref, "payment_ref", MAX_PAYMENT_REF_LEN);
    var paidAt     = _epoch(input.paid_at, "paid_at");

    var id  = _b().uuid.v7();
    var ts  = _now();
    await query(
      "INSERT INTO tax_remittances " +
      "(id, filing_id, jurisdiction, amount_minor, currency, payment_method, payment_ref, " +
      " paid_at, status, voided_at, void_reason, penalty_minor, penalty_reason, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'paid', NULL, NULL, NULL, NULL, ?9)",
      [id, filingId, jur, amount, currency, method, paymentRef, paidAt, ts],
    );
    return _decodeRemittance(await _getRaw(id));
  }

  // ---- getRemittance ----------------------------------------------------

  async function getRemittance(id) {
    var cid = _uuid(id, "id");
    return _decodeRemittance(await _getRaw(cid));
  }

  // ---- remittancesForJurisdiction ---------------------------------------

  async function remittancesForJurisdiction(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.remittancesForJurisdiction: input object required");
    }
    var jur  = _jurisdiction(input.jurisdiction);
    var from = _epoch(input.from, "from");
    var to   = _epoch(input.to,   "to");
    if (to <= from) {
      throw new TypeError("taxRemittance.remittancesForJurisdiction: to must be > from");
    }
    var r = await query(
      "SELECT * FROM tax_remittances " +
      "WHERE jurisdiction = ?1 AND paid_at >= ?2 AND paid_at < ?3 " +
      "ORDER BY paid_at DESC, id DESC",
      [jur, from, to],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      out.push(_decodeRemittance(r.rows[i]));
    }
    return out;
  }

  // ---- _sumPaidForFiling ------------------------------------------------
  //
  // Sum every non-voided remittance for the filing. Used by
  // reconcileWithFiling and unpaidObligations.

  async function _sumPaidForFiling(filingId) {
    var r = await query(
      "SELECT amount_minor FROM tax_remittances " +
      "WHERE filing_id = ?1 AND status = 'paid'",
      [filingId],
    );
    var total = 0;
    for (var i = 0; i < r.rows.length; i += 1) {
      total += Number(r.rows[i].amount_minor);
    }
    return total;
  }

  // ---- reconcileWithFiling ----------------------------------------------

  async function reconcileWithFiling(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.reconcileWithFiling: input object required");
    }
    var api = _requireFilings("reconcileWithFiling");
    var rid = _uuid(input.remittance_id, "remittance_id");
    var row = await _getRaw(rid);
    if (!row) {
      var miss = new Error("taxRemittance.reconcileWithFiling: remittance not found");
      miss.code = "TAX_REMITTANCE_NOT_FOUND";
      throw miss;
    }
    var filing = await api.getFiling(row.filing_id);
    if (!filing) {
      var noFiling = new Error("taxRemittance.reconcileWithFiling: filing not found");
      noFiling.code = "TAX_REMITTANCE_FILING_NOT_FOUND";
      throw noFiling;
    }
    var owed = Number(filing.tax_owed_minor || 0);
    var paid = await _sumPaidForFiling(row.filing_id);
    return {
      remittance_id:   rid,
      filing_id:       row.filing_id,
      jurisdiction:    row.jurisdiction,
      owed_minor:      owed,
      paid_minor:      paid,
      variance_minor:  owed - paid,
    };
  }

  // ---- unpaidObligations ------------------------------------------------
  //
  // Sweep every filing whose due_date <= as_of and whose sum of
  // non-voided remittances is short of tax_owed_minor. Requires the
  // salesTaxFilings API to be wired; without it, the operator has no
  // owed-side number to compare against.

  async function unpaidObligations(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.unpaidObligations: input object required");
    }
    var api  = _requireFilings("unpaidObligations");
    var asOf = _epoch(input.as_of, "as_of");
    var jur  = input.jurisdiction == null ? null : _jurisdiction(input.jurisdiction);

    // The filings primitive doesn't expose a "list by due_date <= X"
    // read directly — `upcomingDue` covers near-future windows, and
    // `listFilings` covers status filters. Compose listFilings here
    // and post-filter by due_date so the read works against the
    // primitive's contract rather than a private SQL join.
    var filings = [];
    if (typeof api.listFilings === "function") {
      var page = await api.listFilings({
        jurisdiction: jur || undefined,
        limit:        500,
      });
      for (var i = 0; i < page.length; i += 1) {
        if (Number(page[i].due_date) <= asOf) filings.push(page[i]);
      }
    } else {
      // The handle is partial — fall back to upcomingDue + an
      // explicit horizon. listFilings is the canonical read; this
      // branch keeps the primitive working against a slimmed-down
      // handle in tests.
      var rows = await api.upcomingDue({ days_ahead: 365, now: asOf });
      for (var j = 0; j < rows.length; j += 1) {
        if (jur && rows[j].jurisdiction !== jur) continue;
        if (Number(rows[j].due_date) <= asOf) filings.push(rows[j]);
      }
    }

    var out = [];
    for (var k = 0; k < filings.length; k += 1) {
      var f = filings[k];
      var owed = Number(f.tax_owed_minor || 0);
      // Filings still in draft have no owed number yet; skip — the
      // operator hasn't run computeFiling on them.
      if (f.status === "draft") continue;
      var paid = await _sumPaidForFiling(f.id);
      if (paid >= owed) continue;
      out.push({
        filing_id:       f.id,
        jurisdiction:    f.jurisdiction,
        due_date:        Number(f.due_date),
        owed_minor:      owed,
        paid_minor:      paid,
        variance_minor:  owed - paid,
        status:          f.status,
      });
    }
    // Operator-facing sort: most-overdue first.
    out.sort(function (a, b) { return a.due_date - b.due_date; });
    return out;
  }

  // ---- lateRemittances --------------------------------------------------

  async function lateRemittances(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.lateRemittances: input object required");
    }
    var api          = _requireFilings("lateRemittances");
    var asOf         = _epoch(input.as_of, "as_of");
    var daysLateMin  = _daysLateMin(input.days_late_min);
    var thresholdMs  = daysLateMin * MS_PER_DAY;

    // Every non-voided remittance up to as_of.
    var r = await query(
      "SELECT * FROM tax_remittances " +
      "WHERE status = 'paid' AND paid_at <= ?1 " +
      "ORDER BY paid_at ASC, id ASC",
      [asOf],
    );

    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var filing;
      try { filing = await api.getFiling(row.filing_id); }
      catch (_e) { filing = null; }
      if (!filing) continue;
      var dueDate = Number(filing.due_date);
      var paidAt  = Number(row.paid_at);
      if (paidAt - dueDate < thresholdMs) continue;
      var dec = _decodeRemittance(row);
      dec.due_date     = dueDate;
      dec.days_late    = Math.floor((paidAt - dueDate) / MS_PER_DAY);
      out.push(dec);
    }
    return out;
  }

  // ---- metricsForJurisdiction -------------------------------------------

  async function metricsForJurisdiction(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.metricsForJurisdiction: input object required");
    }
    var api  = _requireFilings("metricsForJurisdiction");
    var jur  = _jurisdiction(input.jurisdiction);
    var from = _epoch(input.from, "from");
    var to   = _epoch(input.to,   "to");
    if (to <= from) {
      throw new TypeError("taxRemittance.metricsForJurisdiction: to must be > from");
    }

    var r = await query(
      "SELECT * FROM tax_remittances " +
      "WHERE jurisdiction = ?1 AND paid_at >= ?2 AND paid_at < ?3",
      [jur, from, to],
    );

    var totalPaid    = 0;
    var totalPenalty = 0;
    var remCount     = 0;
    var voidedCount  = 0;
    var onTime       = 0;
    var late         = 0;
    var filingCache  = Object.create(null);

    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      remCount += 1;
      if (row.status === "voided") {
        voidedCount += 1;
        continue;
      }
      totalPaid += Number(row.amount_minor);
      if (row.penalty_minor != null) totalPenalty += Number(row.penalty_minor);

      // Resolve due date per filing — cache so multiple installments
      // against the same filing don't refire the lookup.
      var filing = filingCache[row.filing_id];
      if (filing === undefined) {
        try { filing = await api.getFiling(row.filing_id); }
        catch (_e) { filing = null; }
        filingCache[row.filing_id] = filing;
      }
      if (!filing) continue;
      var dueDate = Number(filing.due_date);
      if (Number(row.paid_at) <= dueDate) onTime += 1;
      else                                 late   += 1;
    }

    var rateBase = onTime + late;
    var onTimeRate = rateBase === 0 ? 1 : onTime / rateBase;

    return {
      jurisdiction:        jur,
      from:                from,
      to:                  to,
      remittance_count:    remCount,
      voided_count:        voidedCount,
      total_paid_minor:    totalPaid,
      total_penalty_minor: totalPenalty,
      on_time_count:       onTime,
      late_count:          late,
      on_time_rate:        Math.round(onTimeRate * 10000) / 10000,
    };
  }

  // ---- markVoided -------------------------------------------------------

  async function markVoided(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.markVoided: input object required");
    }
    var id     = _uuid(input.remittance_id, "remittance_id");
    var reason = _shortText(input.reason, "reason", MAX_VOID_REASON_LEN);

    var existing = await _getRaw(id);
    if (!existing) {
      var miss = new Error("taxRemittance.markVoided: remittance not found");
      miss.code = "TAX_REMITTANCE_NOT_FOUND";
      throw miss;
    }
    if (existing.status === "voided") {
      // Idempotent — return the row as-is so a retry doesn't surface
      // as a failure.
      return _decodeRemittance(existing);
    }
    var ts = _now();
    await query(
      "UPDATE tax_remittances SET status = 'voided', voided_at = ?1, void_reason = ?2 " +
      "WHERE id = ?3",
      [ts, reason, id],
    );
    return _decodeRemittance(await _getRaw(id));
  }

  // ---- recordPenalty ----------------------------------------------------

  async function recordPenalty(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("taxRemittance.recordPenalty: input object required");
    }
    var id      = _uuid(input.remittance_id, "remittance_id");
    var penalty = _nonNegInt(input.penalty_minor, "penalty_minor");
    var reason  = _shortText(input.reason, "reason", MAX_PENALTY_REASON_LEN);

    var existing = await _getRaw(id);
    if (!existing) {
      var miss = new Error("taxRemittance.recordPenalty: remittance not found");
      miss.code = "TAX_REMITTANCE_NOT_FOUND";
      throw miss;
    }
    if (existing.status === "voided") {
      var bad = new Error("taxRemittance.recordPenalty: cannot attach penalty to voided remittance");
      bad.code = "TAX_REMITTANCE_VOIDED";
      throw bad;
    }
    await query(
      "UPDATE tax_remittances SET penalty_minor = ?1, penalty_reason = ?2 WHERE id = ?3",
      [penalty, reason, id],
    );
    return _decodeRemittance(await _getRaw(id));
  }

  return {
    PAYMENT_METHODS:            PAYMENT_METHODS.slice(),
    STATUSES:                   STATUSES.slice(),
    JURISDICTION_RE:            JURISDICTION_RE,
    CURRENCY_RE:                CURRENCY_RE,

    recordRemittance:           recordRemittance,
    getRemittance:              getRemittance,
    remittancesForJurisdiction: remittancesForJurisdiction,
    unpaidObligations:          unpaidObligations,
    lateRemittances:            lateRemittances,
    reconcileWithFiling:        reconcileWithFiling,
    metricsForJurisdiction:     metricsForJurisdiction,
    markVoided:                 markVoided,
    recordPenalty:              recordPenalty,
  };
}

module.exports = {
  create:           create,
  PAYMENT_METHODS:  PAYMENT_METHODS,
  STATUSES:         STATUSES,
  JURISDICTION_RE:  JURISDICTION_RE,
  CURRENCY_RE:      CURRENCY_RE,
};
