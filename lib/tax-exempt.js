"use strict";
/**
 * @module shop.taxExempt
 * @title  Tax-exemption certificates — B2B / non-profit operator workflow
 *
 * @intro
 *   Buyers who hold a resale / non-profit / government / agricultural /
 *   manufacturer / direct-pay / foreign-diplomat exemption submit a
 *   certificate; an operator reviews the uploaded scan against the
 *   buyer-declared certificate number and approves or rejects the
 *   submission. Approved + non-expired certificates suppress tax at
 *   checkout for the matching jurisdiction.
 *
 *   The `certificate_number` is operator-display sensitive data: the
 *   operator needs to read it back from the row to verify against the
 *   uploaded scan. Dedup runs against the SHA3-512 namespaceHash of
 *   the uppercase-trimmed number — repeat submissions of the same
 *   cert by the same customer for the same jurisdiction collapse to a
 *   single row via the UNIQUE(customer_id, jurisdiction,
 *   certificate_number_hash) index.
 *
 *   Lifecycle:
 *     submit          → status='pending-review'
 *     approve         → 'pending-review'         → 'approved'
 *     reject          → 'pending-review'         → 'rejected'
 *     revoke          → 'approved'               → 'revoked'
 *     expireScan(now) → 'approved' && now>=exp   → 'expired'
 *
 *   `isExempt({ customer_id, jurisdiction })` is the fast-path
 *   checkout helper — exact jurisdiction match wins; failing that, a
 *   regional certificate (e.g. 'US' covering 'US-CA') matches; failing
 *   that, false. VIES live-check for EU VAT IDs is out of scope here
 *   — that lives on `tax.applyReverseCharge`.
 *
 *   Composition:
 *     var te = bShop.taxExempt.create({ query: q });
 *     var s  = await te.submit({
 *       customer_id:        custId,
 *       certificate_type:   "resale",
 *       jurisdiction:       "US-CA",
 *       certificate_number: "SR-CA-12345678",
 *       legal_name:         "Acme Industrial Supply LLC",
 *       issued_at:          Date.now(),
 *     });
 *     await te.approve(s.id, { reviewed_by: "ops@example.com" });
 *     var exempt = await te.isExempt({ customer_id: custId, jurisdiction: "US-CA" });
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var CERT_NUMBER_NAMESPACE = "tax-cert-number";

var CERT_TYPES = [
  "resale", "nonprofit", "government", "agricultural",
  "manufacturer", "direct-pay", "foreign-diplomat", "other",
];

var STATUSES = ["pending-review", "approved", "rejected", "expired", "revoked"];

// Jurisdiction format: an ISO 3166-1 alpha-2 region (e.g. "US", "EU",
// "CA") optionally followed by a "-" and 1-3 alphanumeric subdivision
// chars. Examples that match: "US", "US-CA", "CA-ON", "EU-DE",
// "GB-ENG". Examples refused: lowercase, four-char top-level,
// punctuation other than the single dash.
var JURISDICTION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

// Operator-display cert number — printable ASCII, 4-64 chars. We
// canonicalize (trim + uppercase) before hashing so casings collapse
// for dedup, but persist the operator-typed form so they can verify
// against the scan.
var CERT_NUMBER_RE   = /^[\x20-\x7E]+$/;
var CERT_NUMBER_MIN  = 4;
var CERT_NUMBER_MAX  = 64;

var LEGAL_NAME_MAX   = 256;
var NOTES_MAX        = 4096;
var REJECTION_MAX    = 512;
var R2_KEY_MAX       = 512;
var REVIEWER_MAX     = 256;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("taxExempt: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _certType(t) {
  if (typeof t !== "string" || CERT_TYPES.indexOf(t) === -1) {
    throw new TypeError("taxExempt: certificate_type must be one of " + CERT_TYPES.join(", "));
  }
  return t;
}

function _jurisdiction(j) {
  if (typeof j !== "string" || !JURISDICTION_RE.test(j)) {
    throw new TypeError(
      "taxExempt: jurisdiction must match /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/ " +
      "(e.g. 'US', 'US-CA', 'EU-DE'), got " + JSON.stringify(j)
    );
  }
  return j;
}

function _certNumber(n) {
  if (typeof n !== "string") {
    throw new TypeError("taxExempt: certificate_number must be a string");
  }
  var trimmed = n.trim();
  if (trimmed.length < CERT_NUMBER_MIN || trimmed.length > CERT_NUMBER_MAX) {
    throw new TypeError(
      "taxExempt: certificate_number must be " + CERT_NUMBER_MIN + "-" +
      CERT_NUMBER_MAX + " printable-ASCII chars (post-trim)"
    );
  }
  if (!CERT_NUMBER_RE.test(trimmed)) {
    throw new TypeError("taxExempt: certificate_number must be printable ASCII (no control bytes)");
  }
  return trimmed;
}

function _legalName(s) {
  if (typeof s !== "string") {
    throw new TypeError("taxExempt: legal_name must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("taxExempt: legal_name must be non-empty after trim");
  }
  if (trimmed.length > LEGAL_NAME_MAX) {
    throw new TypeError("taxExempt: legal_name must be <=" + LEGAL_NAME_MAX + " chars");
  }
  // Refuse control bytes (CR/LF/NUL/etc.) — operator-facing UIs and
  // log lines render the legal_name verbatim; embedded newlines would
  // be a log-injection vector. Single-line field; no whitespace
  // beyond a single inner space run.
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new TypeError("taxExempt: legal_name must not contain control bytes");
  }
  return trimmed;
}

function _epochMs(n, label, opts) {
  opts = opts || {};
  if (n == null && opts.optional) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("taxExempt: " + label + " must be a positive integer epoch-ms" + (opts.optional ? " or null" : ""));
  }
  return n;
}

function _shortString(s, label, max) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("taxExempt: " + label + " must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("taxExempt: " + label + " must be non-empty when provided");
  }
  if (trimmed.length > max) {
    throw new TypeError("taxExempt: " + label + " must be <=" + max + " chars");
  }
  if (/[\x00-\x08\x0B-\x1F\x7F]/.test(trimmed)) {
    throw new TypeError("taxExempt: " + label + " must not contain control bytes");
  }
  return trimmed;
}

function _notes(s) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("taxExempt: notes must be a string");
  }
  if (s.length > NOTES_MAX) {
    throw new TypeError("taxExempt: notes must be <=" + NOTES_MAX + " chars");
  }
  if (/[\x00-\x08\x0E-\x1F\x7F]/.test(s)) {
    // Permit \t (0x09), \n (0x0A), \r (0x0D), \v (0x0B), \f (0x0C)?
    // Operators paste structured notes; keep \t \n \r \v \f, refuse
    // NUL + most C0 controls + DEL.
    throw new TypeError("taxExempt: notes must not contain disallowed control bytes");
  }
  return s;
}

function _hashCertNumber(canonical) {
  return _b().crypto.namespaceHash(CERT_NUMBER_NAMESPACE, canonical);
}

function _canonicalCertNumber(n) {
  return n.trim().toUpperCase();
}

function _now() { return Date.now(); }

// Region match: an exact match wins, otherwise the region prefix of a
// hyphenated jurisdiction matches a region-only certificate. So a
// 'US' certificate covers 'US-CA', 'US-NY', etc. A 'US-CA' certificate
// does NOT cover 'US-NY' (state-specific certificates are scoped).
function _coversJurisdiction(certJurisdiction, queryJurisdiction) {
  if (certJurisdiction === queryJurisdiction) return true;
  // Region-cert covers subdivisions when the query starts with
  // `${cert}-`. e.g. cert='US' covers query='US-CA'.
  if (queryJurisdiction.indexOf(certJurisdiction + "-") === 0) return true;
  return false;
}

function _activeRowQuery(includeJurisdictionFilter) {
  // "Active" = approved AND (expires_at IS NULL OR expires_at > now).
  // Note: lazily-transitioned rows are caught by `.expireScan(now)`
  // — but we ALSO filter on expires_at at read time so a slow
  // scheduler doesn't honor a stale-approved row at checkout.
  var sql =
    "SELECT * FROM tax_exempt_certificates " +
    "WHERE customer_id = ?1 AND status = 'approved' " +
    "  AND (expires_at IS NULL OR expires_at > ?2)";
  if (includeJurisdictionFilter) sql += " AND jurisdiction = ?3";
  sql += " ORDER BY issued_at DESC";
  return sql;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  async function _getRow(id) {
    var r = await query(
      "SELECT * FROM tax_exempt_certificates WHERE id = ?1",
      [id],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  return {
    CERT_NUMBER_NAMESPACE: CERT_NUMBER_NAMESPACE,
    CERT_TYPES:            CERT_TYPES,
    STATUSES:              STATUSES,

    submit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxExempt.submit: input object required");
      }
      var customerId       = _uuid(input.customer_id, "customer_id");
      var certificateType  = _certType(input.certificate_type);
      var jurisdiction     = _jurisdiction(input.jurisdiction);
      var certificateNum   = _certNumber(input.certificate_number);
      var legalName        = _legalName(input.legal_name);
      var issuedAt         = _epochMs(input.issued_at, "issued_at");
      var expiresAt        = _epochMs(input.expires_at, "expires_at", { optional: true });
      var documentR2Key    = _shortString(input.document_r2_key, "document_r2_key", R2_KEY_MAX);
      var notes            = _notes(input.notes);

      if (expiresAt != null && expiresAt <= issuedAt) {
        throw new TypeError("taxExempt.submit: expires_at must be > issued_at when provided");
      }

      var canonical = _canonicalCertNumber(certificateNum);
      var hash      = _hashCertNumber(canonical);

      // Idempotent on (customer_id, jurisdiction, certificate_number_hash).
      // If a row already exists, return its current state without a
      // status change — re-submitting an already-approved certificate
      // must not re-open it for review.
      var existing = await query(
        "SELECT id, status FROM tax_exempt_certificates " +
        "WHERE customer_id = ?1 AND jurisdiction = ?2 AND certificate_number_hash = ?3",
        [customerId, jurisdiction, hash],
      );
      if (existing.rows.length) {
        return { id: existing.rows[0].id, status: existing.rows[0].status };
      }

      var id = _b().uuid.v7();
      var ts = _now();

      await query(
        "INSERT INTO tax_exempt_certificates (" +
        "  id, customer_id, certificate_type, jurisdiction, certificate_number, certificate_number_hash, " +
        "  legal_name, issued_at, expires_at, status, document_r2_key, notes, created_at, updated_at" +
        ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending-review', ?10, ?11, ?12, ?12)",
        [
          id, customerId, certificateType, jurisdiction, certificateNum, hash,
          legalName, issuedAt, expiresAt, documentR2Key, notes, ts,
        ],
      );

      return { id: id, status: "pending-review" };
    },

    approve: async function (certId, input) {
      _uuid(certId, "cert_id");
      if (!input || typeof input !== "object") {
        throw new TypeError("taxExempt.approve: input object required");
      }
      var reviewedBy = _shortString(input.reviewed_by, "reviewed_by", REVIEWER_MAX);
      if (!reviewedBy) {
        throw new TypeError("taxExempt.approve: reviewed_by is required");
      }
      var notes = _notes(input.notes);

      var row = await _getRow(certId);
      if (!row) return null;
      if (row.status !== "pending-review") {
        var e = new Error("taxExempt.approve: certificate is " + row.status + ", only 'pending-review' may be approved");
        e.code = "TAXEXEMPT_INVALID_TRANSITION";
        throw e;
      }
      var ts = _now();
      // Preserve operator-supplied notes when the submitter left
      // their own — append rather than overwrite.
      var mergedNotes = row.notes && notes
        ? (row.notes + "\n---\n" + notes)
        : (notes || row.notes || "");

      await query(
        "UPDATE tax_exempt_certificates SET status = 'approved', " +
        "  reviewed_at = ?1, reviewed_by = ?2, notes = ?3, updated_at = ?1 " +
        "WHERE id = ?4 AND status = 'pending-review'",
        [ts, reviewedBy, mergedNotes, certId],
      );
      return await _getRow(certId);
    },

    reject: async function (certId, input) {
      _uuid(certId, "cert_id");
      if (!input || typeof input !== "object") {
        throw new TypeError("taxExempt.reject: input object required");
      }
      var rejectionReason = _shortString(input.rejection_reason, "rejection_reason", REJECTION_MAX);
      if (!rejectionReason) {
        throw new TypeError("taxExempt.reject: rejection_reason is required");
      }
      var reviewedBy = _shortString(input.reviewed_by, "reviewed_by", REVIEWER_MAX);
      if (!reviewedBy) {
        throw new TypeError("taxExempt.reject: reviewed_by is required");
      }
      var notes = _notes(input.notes);

      var row = await _getRow(certId);
      if (!row) return null;
      if (row.status !== "pending-review") {
        var e = new Error("taxExempt.reject: certificate is " + row.status + ", only 'pending-review' may be rejected");
        e.code = "TAXEXEMPT_INVALID_TRANSITION";
        throw e;
      }
      var ts = _now();
      var mergedNotes = row.notes && notes
        ? (row.notes + "\n---\n" + notes)
        : (notes || row.notes || "");

      await query(
        "UPDATE tax_exempt_certificates SET status = 'rejected', " +
        "  reviewed_at = ?1, reviewed_by = ?2, rejection_reason = ?3, notes = ?4, updated_at = ?1 " +
        "WHERE id = ?5 AND status = 'pending-review'",
        [ts, reviewedBy, rejectionReason, mergedNotes, certId],
      );
      return await _getRow(certId);
    },

    revoke: async function (certId, input) {
      _uuid(certId, "cert_id");
      if (!input || typeof input !== "object") {
        throw new TypeError("taxExempt.revoke: input object required");
      }
      var reviewedBy = _shortString(input.reviewed_by, "reviewed_by", REVIEWER_MAX);
      if (!reviewedBy) {
        throw new TypeError("taxExempt.revoke: reviewed_by is required");
      }
      var reason = _shortString(input.reason, "reason", REJECTION_MAX);
      if (!reason) {
        throw new TypeError("taxExempt.revoke: reason is required");
      }

      var row = await _getRow(certId);
      if (!row) return null;
      if (row.status !== "approved") {
        var e = new Error("taxExempt.revoke: certificate is " + row.status + ", only 'approved' may be revoked");
        e.code = "TAXEXEMPT_INVALID_TRANSITION";
        throw e;
      }
      var ts = _now();
      // Revocation reason lands in `rejection_reason` (the row's
      // catch-all "why is this no longer honored" field) plus a notes
      // line tagged 'revoked:' so the operator can distinguish review
      // rejection from post-approval revocation in the audit trail.
      var revokeNote = "revoked: " + reason;
      var mergedNotes = row.notes
        ? (row.notes + "\n---\n" + revokeNote)
        : revokeNote;

      await query(
        "UPDATE tax_exempt_certificates SET status = 'revoked', " +
        "  reviewed_at = ?1, reviewed_by = ?2, rejection_reason = ?3, notes = ?4, updated_at = ?1 " +
        "WHERE id = ?5 AND status = 'approved'",
        [ts, reviewedBy, reason, mergedNotes, certId],
      );
      return await _getRow(certId);
    },

    expireScan: async function (ts) {
      var now = ts == null ? _now() : _epochMs(ts, "ts");
      var r = await query(
        "UPDATE tax_exempt_certificates SET status = 'expired', updated_at = ?1 " +
        "WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?1",
        [now],
      );
      return r.rowCount;
    },

    get: async function (certId) {
      _uuid(certId, "cert_id");
      return await _getRow(certId);
    },

    activeForCustomer: async function (customerId, opts2) {
      _uuid(customerId, "customer_id");
      opts2 = opts2 || {};
      var now = _now();
      if (opts2.jurisdiction != null) {
        var j = _jurisdiction(opts2.jurisdiction);
        // Match exact jurisdiction OR the region-only ancestor
        // (e.g. query 'US-CA' returns rows with jurisdiction 'US-CA'
        // or 'US'). The query splits by the dash; a hyphen-free
        // jurisdiction has no region ancestor to widen against.
        var dash = j.indexOf("-");
        var region = dash > 0 ? j.slice(0, dash) : null;
        if (region) {
          var r = await query(
            "SELECT * FROM tax_exempt_certificates " +
            "WHERE customer_id = ?1 AND status = 'approved' " +
            "  AND (expires_at IS NULL OR expires_at > ?2) " +
            "  AND (jurisdiction = ?3 OR jurisdiction = ?4) " +
            "ORDER BY issued_at DESC",
            [customerId, now, j, region],
          );
          return r.rows;
        }
        var r2 = await query(_activeRowQuery(true), [customerId, now, j]);
        return r2.rows;
      }
      var rAll = await query(_activeRowQuery(false), [customerId, now]);
      return rAll.rows;
    },

    listPendingReview: async function (opts2) {
      opts2 = opts2 || {};
      var limit = 100;
      if (opts2.limit != null) {
        if (!Number.isInteger(opts2.limit) || opts2.limit <= 0 || opts2.limit > 1000) {
          throw new TypeError("taxExempt.listPendingReview: limit must be an integer 1..1000");
        }
        limit = opts2.limit;
      }
      var r = await query(
        "SELECT * FROM tax_exempt_certificates WHERE status = 'pending-review' " +
        "ORDER BY created_at ASC LIMIT ?1",
        [limit],
      );
      return r.rows;
    },

    isExempt: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxExempt.isExempt: input object required");
      }
      var customerId   = _uuid(input.customer_id, "customer_id");
      var jurisdiction = _jurisdiction(input.jurisdiction);
      var now = _now();

      // Two-row read: exact match OR region-only ancestor. The
      // SQL filter trims the result set; final coverage check uses
      // `_coversJurisdiction` so the rule lives in one place.
      var dash = jurisdiction.indexOf("-");
      var region = dash > 0 ? jurisdiction.slice(0, dash) : null;
      var r;
      if (region) {
        r = await query(
          "SELECT jurisdiction FROM tax_exempt_certificates " +
          "WHERE customer_id = ?1 AND status = 'approved' " +
          "  AND (expires_at IS NULL OR expires_at > ?2) " +
          "  AND (jurisdiction = ?3 OR jurisdiction = ?4) " +
          "LIMIT 1",
          [customerId, now, jurisdiction, region],
        );
      } else {
        r = await query(
          "SELECT jurisdiction FROM tax_exempt_certificates " +
          "WHERE customer_id = ?1 AND status = 'approved' " +
          "  AND (expires_at IS NULL OR expires_at > ?2) " +
          "  AND jurisdiction = ?3 " +
          "LIMIT 1",
          [customerId, now, jurisdiction],
        );
      }
      if (!r.rows.length) return false;
      // Belt-and-braces: re-check the coverage rule in JS so any
      // future SQL refactor that widens the WHERE accidentally is
      // still gated by the canonical rule.
      return _coversJurisdiction(r.rows[0].jurisdiction, jurisdiction);
    },
  };
}

module.exports = {
  create:                create,
  CERT_NUMBER_NAMESPACE: CERT_NUMBER_NAMESPACE,
  CERT_TYPES:            CERT_TYPES,
  STATUSES:              STATUSES,
};
