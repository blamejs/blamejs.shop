"use strict";
/**
 * @module shop.consentLedger
 * @title  Consent ledger — append-only per-customer record of every
 *         consent decision for GDPR / ePrivacy / CCPA audit.
 *
 * @intro
 *   Per-customer historical record of every consent grant /
 *   withdrawal across the nine categories that map to a supervisory-
 *   authority audit: cookie functional / analytics / marketing /
 *   preferences, marketing email, marketing SMS, third-party data
 *   sharing (partners + analytics), and a catch-all data_processing
 *   bucket for purposes that don't fit the eight category-specific
 *   kinds. Distinct from `cookieConsent`, which stores per-SESSION
 *   decisions keyed by a hashed session id — that primitive is the
 *   browser-side gate; this primitive is the durable audit trail.
 *
 *   GDPR art. 7(1) requires the controller "be able to demonstrate
 *   that the data subject has consented to processing of his or her
 *   personal data." consentLedger is that demonstration: every
 *   decision a customer makes lands as a new row; the table is
 *   append-only from the primitive surface; the current effective
 *   state is the latest row by `occurred_at`. A Subject Access
 *   Request (`auditExport`) returns every row for one customer
 *   newest-first in CSV or JSON. A supervisory-authority sweep
 *   (`bulkExportByJurisdiction`) returns every row in a country
 *   over a closed time window. The compliance summary
 *   (`summarizeForCompliance`) returns aggregate granted /
 *   withdrawn counts per (consent_kind, source) across the window
 *   so the operator can answer "how many EU buyers opted into
 *   marketing email last quarter" without exposing per-row PII.
 *
 *   Withdrawal is non-destructive. `recordConsentChange` with
 *   `state: "withdrawn"` writes a NEW row; the prior granted row
 *   survives so the timeline reads as a sequence rather than a
 *   silent revocation. Operators never DELETE / UPDATE rows in
 *   this table — the primitive surface only exposes INSERT.
 *
 *   `consent_kind` is one of the nine listed under
 *   `CONSENT_KINDS`. `state` is `granted` or `withdrawn`. `source`
 *   identifies how the decision arrived (signup_form,
 *   preference_center, cookie_banner, customer_support,
 *   system_default, data_subject_request). `jurisdiction` is an
 *   optional ISO-3166-1 alpha-2 uppercase country code; the
 *   bulk-export and compliance-summary paths filter on it.
 *   `evidence_ref` is an operator-supplied opaque string pointing
 *   at the row that proves the decision (form-submission id,
 *   support-ticket id, audit-log row id) — the ledger doesn't
 *   resolve it.
 *
 *   Composes:
 *     - `b.guardUuid.sanitize` — strict UUID validation on
 *                                customer_id.
 *     - `b.uuid.v7`            — row id, lexicographically
 *                                sortable for tie-break on
 *                                occurred_at.
 *     - `b.csv.stringify`      — RFC 4180 CSV emission for
 *                                `auditExport({ format: "csv" })`
 *                                and `bulkExportByJurisdiction`.
 *
 *   Monotonic per-process clock: two writes in the same
 *   millisecond would tie on `occurred_at` and make the "latest
 *   state per kind" read ambiguous. `_now` bumps to `prior + 1` on
 *   collision so the per-customer timeline carries a strict
 *   ordering even on a fast runner.
 *
 *   Surface:
 *     - recordConsentChange({ customer_id, consent_kind, state,
 *                             source, jurisdiction?, evidence_ref? })
 *         → the persisted row.
 *     - currentStateForCustomer(customer_id)
 *         → object mapping each consent_kind that has at least
 *         one row to its latest { state, source, jurisdiction,
 *         evidence_ref, occurred_at }. Kinds with no rows are
 *         omitted (the caller decides the default — typically
 *         "withdrawn" / "not given").
 *     - historyForCustomer(customer_id)
 *         → array of every row for the customer, newest first.
 *     - auditExport({ customer_id, format })
 *         → SAR-ready dump. `format` is `"csv"` or `"json"`.
 *     - bulkExportByJurisdiction({ jurisdiction, from, to,
 *                                   format? })
 *         → every row whose jurisdiction matches the requested
 *         code, occurred_at in [from, to). Default format CSV.
 *     - summarizeForCompliance({ from, to, jurisdiction? })
 *         → per-(consent_kind, source) granted / withdrawn
 *         counts across the window. Operator-facing aggregate
 *         that doesn't expose row-level customer_ids.
 *
 *   Storage: `consent_ledger` (migration
 *     `0185_consent_ledger.sql`).
 *
 * @primitive consentLedger
 * @related   b.guardUuid, b.uuid.v7, b.csv, shop.cookieConsent
 */

var CONSENT_KINDS = Object.freeze([
  "cookies_functional",
  "cookies_analytics",
  "cookies_marketing",
  "cookies_preferences",
  "marketing_email",
  "marketing_sms",
  "data_sharing_partners",
  "data_sharing_analytics",
  "data_processing",
]);

var STATES = Object.freeze(["granted", "withdrawn"]);

var SOURCES = Object.freeze([
  "signup_form",
  "preference_center",
  "cookie_banner",
  "customer_support",
  "system_default",
  "data_subject_request",
]);

var EXPORT_FORMATS = Object.freeze(["csv", "json"]);

var JURISDICTION_RE       = /^[A-Z]{2}$/;
var EVIDENCE_REF_MAX_LEN  = 256;
var EVIDENCE_REF_RE       = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

var CSV_COLUMNS = Object.freeze([
  "id",
  "customer_id",
  "consent_kind",
  "state",
  "source",
  "lawful_basis",
  "jurisdiction",
  "evidence_ref",
  "occurred_at",
]);

var b = require("./vendor/blamejs");

// The GDPR Art. 6(1) lawful bases, sourced from the framework's
// consent primitive so this ledger's vocabulary tracks the
// primitive's ground truth instead of re-listing the six strings.
var LAWFUL_BASES = b.consent.LAWFUL_BASES;

// Every consent kind this ledger records is consent-gated: cookies
// are non-essential under ePrivacy Art. 5(3) (the strictly-necessary
// set lives in cookieConsent, never here), marketing email / SMS rest
// on Art. 6(1)(a), and third-party data sharing is not a contract
// necessity. data_processing is the opt-in catch-all — contract /
// legal-obligation processing is recorded by the domain table that
// owns it, not by this opt-in ledger. So each kind maps to "consent".
// A caller may still pass an explicit, validated lawful_basis to
// override the default for a row that genuinely rests on another basis.
var KIND_TO_LAWFUL_BASIS = Object.freeze({
  cookies_functional:     "consent",
  cookies_analytics:      "consent",
  cookies_marketing:      "consent",
  cookies_preferences:    "consent",
  marketing_email:        "consent",
  marketing_sms:          "consent",
  data_sharing_partners:  "consent",
  data_sharing_analytics: "consent",
  data_processing:        "consent",
});

// ---- monotonic clock ----------------------------------------------------
//
// Operator-driven writes can land in the same millisecond on fast
// machines. Bumping by 1ms on a tie keeps the per-customer timeline
// strictly increasing so the "latest state per kind" read returns
// the row the caller actually issued last.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _customerId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError(
      "consentLedger: customer_id — " + (e && e.message || "invalid UUID")
    );
  }
}

function _consentKind(s) {
  if (typeof s !== "string" || CONSENT_KINDS.indexOf(s) === -1) {
    throw new TypeError(
      "consentLedger: consent_kind must be one of " + CONSENT_KINDS.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _state(s) {
  if (typeof s !== "string" || STATES.indexOf(s) === -1) {
    throw new TypeError(
      "consentLedger: state must be one of " + STATES.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _source(s) {
  if (typeof s !== "string" || SOURCES.indexOf(s) === -1) {
    throw new TypeError(
      "consentLedger: source must be one of " + SOURCES.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _lawfulBasis(s) {
  if (typeof s !== "string" || LAWFUL_BASES.indexOf(s) === -1) {
    throw new TypeError(
      "consentLedger: lawful_basis must be one of " + LAWFUL_BASES.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _optJurisdiction(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("consentLedger: jurisdiction must be a string");
  }
  if (!JURISDICTION_RE.test(s)) {
    throw new TypeError(
      "consentLedger: jurisdiction must be ISO-3166-1 alpha-2 uppercase (e.g. 'DE', 'US'), " +
      "got " + JSON.stringify(s)
    );
  }
  return s;
}

function _reqJurisdiction(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("consentLedger: jurisdiction required (non-empty string)");
  }
  if (!JURISDICTION_RE.test(s)) {
    throw new TypeError(
      "consentLedger: jurisdiction must be ISO-3166-1 alpha-2 uppercase (e.g. 'DE', 'US'), " +
      "got " + JSON.stringify(s)
    );
  }
  return s;
}

function _optEvidenceRef(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("consentLedger: evidence_ref must be a string");
  }
  if (s.length > EVIDENCE_REF_MAX_LEN) {
    throw new TypeError(
      "consentLedger: evidence_ref must be <= " + EVIDENCE_REF_MAX_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("consentLedger: evidence_ref must not contain control bytes");
  }
  if (!EVIDENCE_REF_RE.test(s)) {
    throw new TypeError(
      "consentLedger: evidence_ref must match /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/"
    );
  }
  return s;
}

function _format(s) {
  if (typeof s !== "string" || EXPORT_FORMATS.indexOf(s) === -1) {
    throw new TypeError(
      "consentLedger: format must be one of " + EXPORT_FORMATS.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _tsBound(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "consentLedger: " + label + " must be a non-negative integer (ms epoch)"
    );
  }
  return n;
}

function _windowBounds(from, to, label) {
  _tsBound(from, label + ".from");
  _tsBound(to,   label + ".to");
  if (to <= from) {
    throw new TypeError(
      "consentLedger." + label + ": to must be > from"
    );
  }
}

// ---- row hydration ------------------------------------------------------

function _rowToRecord(row) {
  if (!row) return null;
  return {
    id:            row.id,
    customer_id:   row.customer_id,
    consent_kind:  row.consent_kind,
    state:         row.state,
    source:        row.source,
    lawful_basis:  row.lawful_basis == null ? null : row.lawful_basis,
    jurisdiction:  row.jurisdiction == null ? null : row.jurisdiction,
    evidence_ref:  row.evidence_ref == null ? null : row.evidence_ref,
    occurred_at:   Number(row.occurred_at),
  };
}

// ---- CSV emission -------------------------------------------------------
//
// Compose `b.csv.stringify` so the audit / bulk-export output is RFC
// 4180-shaped (quoting only on delimiter / quote / CR / LF). Header
// row is always emitted so a downstream auditor can ingest the file
// without external column metadata.

function _toCsv(rows) {
  return b.csv.stringify(rows, {
    columns: CSV_COLUMNS.slice(),
    header:  true,
    eol:     "\n",
  });
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Append-only INSERT. The row is persisted with a fresh UUIDv7 id
  // (lexicographically sortable, tie-breaks occurred_at ordering on
  // the per-customer history walk). The customer_id is validated as
  // a strict UUID — any non-UUID identifier is refused at the door
  // so a typo can't quietly land an orphan row.
  async function recordConsentChange(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("consentLedger.recordConsentChange: input object required");
    }
    var customerId   = _customerId(input.customer_id);
    var consentKind  = _consentKind(input.consent_kind);
    var state        = _state(input.state);
    var source       = _source(input.source);
    var jurisdiction = _optJurisdiction(input.jurisdiction);
    var evidenceRef  = _optEvidenceRef(input.evidence_ref);
    // Lawful basis defaults from the kind (every kind here is
    // consent-gated; the basis is state-agnostic so a withdrawal row
    // carries the same basis as its grant). An explicit lawful_basis is
    // validated and overrides the default for a row that rests on a
    // different Art. 6 basis.
    var lawfulBasis  = input.lawful_basis == null
      ? KIND_TO_LAWFUL_BASIS[consentKind]
      : _lawfulBasis(input.lawful_basis);

    var id = b.uuid.v7();
    var ts = _now();

    await query(
      "INSERT INTO consent_ledger " +
      "(id, customer_id, consent_kind, state, source, lawful_basis, jurisdiction, evidence_ref, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      [id, customerId, consentKind, state, source, lawfulBasis, jurisdiction, evidenceRef, ts],
    );

    return {
      id:            id,
      customer_id:   customerId,
      consent_kind:  consentKind,
      state:         state,
      source:        source,
      lawful_basis:  lawfulBasis,
      jurisdiction:  jurisdiction,
      evidence_ref:  evidenceRef,
      occurred_at:   ts,
    };
  }

  // Latest decision per consent_kind for this customer. Returns an
  // object keyed by consent_kind; kinds with no row are omitted so
  // the caller can decide what "no record" means (a missing
  // marketing_email row typically reads as "not opted in").
  async function currentStateForCustomer(customerId) {
    customerId = _customerId(customerId);
    var r = await query(
      "SELECT * FROM consent_ledger " +
      "WHERE customer_id = ?1 " +
      "ORDER BY occurred_at ASC, id ASC",
      [customerId],
    );
    var out = {};
    for (var i = 0; i < r.rows.length; i += 1) {
      var rec = _rowToRecord(r.rows[i]);
      // Later rows overwrite earlier ones for the same kind — ASC
      // order means the last write wins, which is exactly the
      // "latest state" semantics.
      out[rec.consent_kind] = {
        state:        rec.state,
        source:       rec.source,
        jurisdiction: rec.jurisdiction,
        evidence_ref: rec.evidence_ref,
        occurred_at:  rec.occurred_at,
      };
    }
    return out;
  }

  // Newest-first row dump for one customer. Used by the SAR audit
  // export path AND by an operator-facing "buyer's consent history"
  // UI under /admin/customers/:id.
  async function historyForCustomer(customerId) {
    customerId = _customerId(customerId);
    var r = await query(
      "SELECT * FROM consent_ledger " +
      "WHERE customer_id = ?1 " +
      "ORDER BY occurred_at DESC, id DESC",
      [customerId],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      out.push(_rowToRecord(r.rows[i]));
    }
    return out;
  }

  // SAR export — the buyer (or their authorised representative)
  // requests every row of consent activity. CSV is the supervisory-
  // authority-friendly default; JSON is the structured shape an
  // operator's portal can render in-page.
  async function auditExport(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("consentLedger.auditExport: input object required");
    }
    var customerId = _customerId(input.customer_id);
    var format     = _format(input.format);
    var rows       = await historyForCustomer(customerId);
    if (format === "json") {
      return { format: "json", rows: rows };
    }
    return { format: "csv", body: _toCsv(rows) };
  }

  // Supervisory-authority sweep. The operator's DPO receives a
  // request from a country's data-protection authority asking for
  // every consent decision recorded for that jurisdiction in a time
  // window. The default output is CSV (it's what the regulator will
  // ingest); JSON is available for downstream tooling.
  async function bulkExportByJurisdiction(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("consentLedger.bulkExportByJurisdiction: input object required");
    }
    var jurisdiction = _reqJurisdiction(input.jurisdiction);
    _windowBounds(input.from, input.to, "bulkExportByJurisdiction");
    var format = input.format == null ? "csv" : _format(input.format);

    var r = await query(
      "SELECT * FROM consent_ledger " +
      "WHERE jurisdiction = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 " +
      "ORDER BY occurred_at ASC, id ASC",
      [jurisdiction, input.from, input.to],
    );
    var rows = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      rows.push(_rowToRecord(r.rows[i]));
    }
    if (format === "json") {
      return { format: "json", jurisdiction: jurisdiction, rows: rows };
    }
    return { format: "csv", jurisdiction: jurisdiction, body: _toCsv(rows) };
  }

  // Operator-facing aggregate over a closed window. Returns one
  // entry per (consent_kind, source) tuple with granted /
  // withdrawn counts. The summary doesn't expose row-level
  // customer_ids — it's the shape a quarterly compliance review
  // consumes ("how many marketing_email opt-ins were recorded
  // through preference_center last quarter"). Jurisdiction filter
  // is optional; omitting it summarises every jurisdiction.
  async function summarizeForCompliance(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("consentLedger.summarizeForCompliance: input object required");
    }
    _windowBounds(input.from, input.to, "summarizeForCompliance");
    var jurisdiction = input.jurisdiction == null
      ? null
      : _reqJurisdiction(input.jurisdiction);

    var sql, params;
    if (jurisdiction == null) {
      sql =
        "SELECT consent_kind, source, state, COUNT(*) AS n " +
        "FROM consent_ledger " +
        "WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
        "GROUP BY consent_kind, source, state " +
        "ORDER BY consent_kind ASC, source ASC, state ASC";
      params = [input.from, input.to];
    } else {
      sql =
        "SELECT consent_kind, source, state, COUNT(*) AS n " +
        "FROM consent_ledger " +
        "WHERE occurred_at >= ?1 AND occurred_at < ?2 AND jurisdiction = ?3 " +
        "GROUP BY consent_kind, source, state " +
        "ORDER BY consent_kind ASC, source ASC, state ASC";
      params = [input.from, input.to, jurisdiction];
    }
    var r = await query(sql, params);

    // Collapse into a stable nested map keyed by consent_kind ->
    // source -> { granted, withdrawn, total }. Tuples with no
    // observations are omitted (operators reading the summary
    // shouldn't infer "zero" from "absent" without thinking).
    var summary = {};
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var kind = row.consent_kind;
      var src  = row.source;
      var st   = row.state;
      var n    = Number(row.n) || 0;
      if (!summary[kind])              summary[kind] = {};
      if (!summary[kind][src])         summary[kind][src] = { granted: 0, withdrawn: 0, total: 0 };
      summary[kind][src][st] = (summary[kind][src][st] || 0) + n;
      summary[kind][src].total += n;
    }

    return {
      from:         input.from,
      to:           input.to,
      jurisdiction: jurisdiction,
      summary:      summary,
    };
  }

  return {
    CONSENT_KINDS:               CONSENT_KINDS,
    STATES:                      STATES,
    SOURCES:                     SOURCES,
    EXPORT_FORMATS:              EXPORT_FORMATS,
    CSV_COLUMNS:                 CSV_COLUMNS,
    EVIDENCE_REF_MAX_LEN:        EVIDENCE_REF_MAX_LEN,

    recordConsentChange:         recordConsentChange,
    currentStateForCustomer:     currentStateForCustomer,
    historyForCustomer:          historyForCustomer,
    auditExport:                 auditExport,
    bulkExportByJurisdiction:    bulkExportByJurisdiction,
    summarizeForCompliance:      summarizeForCompliance,
  };
}

module.exports = {
  create:                  create,
  CONSENT_KINDS:           CONSENT_KINDS,
  STATES:                  STATES,
  SOURCES:                 SOURCES,
  EXPORT_FORMATS:          EXPORT_FORMATS,
  CSV_COLUMNS:             CSV_COLUMNS,
  EVIDENCE_REF_MAX_LEN:    EVIDENCE_REF_MAX_LEN,
};
