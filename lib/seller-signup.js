"use strict";
/**
 * @module shop.sellerSignup
 * @title  Seller signup — marketplace seller onboarding funnel
 *
 * @intro
 *   The inbound application-to-vendor pipeline. A prospective
 *   seller submits an application; the operator (or an internal
 *   KYC/AML team) requests supporting documents, the applicant
 *   uploads them, the operator either approves (the primitive
 *   composes `vendors.registerVendor` to mint the real vendor
 *   row), rejects (terminal, reason captured), or requests
 *   revisions (re-opens for additional docs).
 *
 *   Distinct from `vendors` (the registry of suppliers the
 *   operator drop-ships from — the OUTPUT of this primitive on a
 *   happy approval path) and from `customer_roles` (which models
 *   B2B account hierarchy inside a single customer entity — a
 *   distinct relationship class, not a vendor pipeline).
 *
 *   FSM:
 *
 *     submitted -> docs_pending           (requestDocument)
 *     docs_pending -> in_review           (every requested doc uploaded)
 *     in_review -> approved               (approveApplication, terminal,
 *                                          composes vendors.registerVendor)
 *     in_review -> revisions_requested    (requestRevisions)
 *     revisions_requested -> docs_pending (auto on first new
 *                                          requestDocument while in this
 *                                          state)
 *     submitted | docs_pending | in_review | revisions_requested ->
 *       rejected                          (rejectApplication, terminal)
 *
 *     (approved and rejected are terminal — no transitions out.)
 *
 *   Composes:
 *     - vendors                — composed at approveApplication time
 *                                to mint the real vendor row.
 *                                Injected as `opts.vendors`.
 *                                Required at approve time; absent at
 *                                construction means submit / doc /
 *                                reject / revisions all still work,
 *                                but approveApplication refuses.
 *     - b.crypto.namespaceHash — contact_email / contact_phone /
 *                                tax_id are hashed under three
 *                                distinct namespaces so the raw
 *                                values never land on disk
 *     - b.guardEmail           — strict-profile validate + sanitize
 *                                on contact_email
 *     - b.uuid.v7              — application + document PKs
 *                                (sortable; B-tree locality so the
 *                                operator inbox keyset-paginates
 *                                without a second index)
 *
 *   Surface:
 *     submitApplication({ business_name, contact_email,
 *                         contact_phone, business_address,
 *                         tax_id_kind, tax_id_value, category_focus,
 *                         expected_monthly_volume_minor, currency,
 *                         references_json? })
 *     requestDocument({ application_id, doc_kind, instructions })
 *     recordDocumentUploaded({ application_id, doc_kind, sha3_512,
 *                              byte_size, mime_type })
 *     approveApplication({ application_id, approved_by, vendor_slug })
 *     rejectApplication({ application_id, reason, rejected_by })
 *     requestRevisions({ application_id, fields, instructions })
 *     getApplication(id) / listApplications({ status?, cursor? })
 *     documentsForApplication(application_id)
 *
 *   Storage: `migrations-d1/0146_seller_signup.sql` — two tables,
 *   `seller_applications` + `seller_application_documents`. ON
 *   DELETE CASCADE drops the docs when the application row is
 *   hard-deleted (the primitive only soft-transitions; hard-
 *   delete is an operator-side privacy-erasure migration concern).
 *
 * @primitive sellerSignup
 * @related   shop.vendors, shop.customerRoles, b.crypto, b.guardEmail, b.uuid
 */

var MAX_BUSINESS_NAME_LEN     = 200;
var MAX_PHONE_LEN             = 32;
var MAX_TAX_ID_LEN            = 64;
var MAX_ADDRESS_JSON_LEN      = 4096;
var MAX_CATEGORY_FOCUS_LEN    = 4096;
var MAX_REFERENCES_JSON_LEN   = 8192;
var MAX_INSTRUCTIONS_LEN      = 2000;
var MAX_REJECT_REASON_LEN     = 1000;
var MAX_OPERATOR_ID_LEN       = 256;
var MAX_MIME_TYPE_LEN         = 128;
var MAX_FIELDS_LEN            = 32;
var MAX_FIELD_NAME_LEN        = 64;
var MAX_LIST_LIMIT            = 200;
var MAX_VOLUME_MINOR          = 100000000000; // 1e11 sanity cap
var MAX_BYTE_SIZE             = 5368709120;   // 5 GiB sanity cap per doc

var EMAIL_NAMESPACE           = "seller-signup-email";
var PHONE_NAMESPACE           = "seller-signup-phone";
var TAX_ID_NAMESPACE          = "seller-signup-tax-id";

var TAX_ID_KINDS = Object.freeze([
  "us_ssn", "us_ein", "eu_vat", "uk_utr", "au_abn", "ca_bn", "other",
]);

var DOC_KINDS = Object.freeze([
  "w9", "w8ben", "id", "business_license", "utility_bill",
  "insurance", "bank_statement", "other",
]);

var APPLICATION_STATUSES = Object.freeze([
  "submitted", "docs_pending", "in_review", "revisions_requested",
  "approved", "rejected", "withdrawn",
]);

var DOCUMENT_STATUSES = Object.freeze([
  "requested", "uploaded", "accepted", "rejected",
]);

var TERMINAL_APPLICATION_STATUSES = Object.freeze([
  "approved", "rejected", "withdrawn",
]);

var PHONE_RE                  = /^\+?[1-9]\d{1,14}$/;
var TAX_ID_RE                 = /^[A-Za-z0-9][A-Za-z0-9 .\-_/]{0,63}$/;
var FIELD_NAME_RE             = /^[a-z][a-z0-9_]{0,63}$/;
var SHA3_512_RE               = /^[0-9a-f]{128}$/;
var MIME_RE                   = /^[A-Za-z0-9!#$&^_.+\-]{1,127}\/[A-Za-z0-9!#$&^_.+\-]{1,127}$/;

// Control bytes + zero-width / direction-override family — matches
// the shape vendors / purchase-orders use. Operator-rendered fields
// refuse these to keep downstream dashboards / KYC printouts safe
// from header-injection + visual-spoofing attacks.
var CONTROL_BYTE_RE           = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var b = require("./index").framework;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("seller-signup: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _businessName(s) {
  if (typeof s !== "string") {
    throw new TypeError("seller-signup: business_name must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("seller-signup: business_name must be non-empty after trim");
  }
  if (s.length > MAX_BUSINESS_NAME_LEN) {
    throw new TypeError("seller-signup: business_name must be <= " + MAX_BUSINESS_NAME_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("seller-signup: business_name contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("seller-signup: business_name contains zero-width / direction-override bytes");
  }
  return s;
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("seller-signup: contact_email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("seller-signup: contact_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("seller-signup: contact_email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e2) {
    throw new TypeError("seller-signup: contact_email — " + (e2 && e2.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _phone(value) {
  if (typeof value !== "string" || !value.length) {
    throw new TypeError("seller-signup: contact_phone must be a non-empty string");
  }
  var trimmed = value.trim();
  if (!trimmed.length) {
    throw new TypeError("seller-signup: contact_phone must be non-empty after trim");
  }
  if (trimmed.length > MAX_PHONE_LEN) {
    throw new TypeError("seller-signup: contact_phone must be <= " + MAX_PHONE_LEN + " characters");
  }
  if (!PHONE_RE.test(trimmed)) {
    throw new TypeError("seller-signup: contact_phone must match E.164-ish shape (^\\+?[1-9]\\d{1,14}$)");
  }
  return trimmed;
}

function _businessAddress(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("seller-signup: business_address must be a plain object");
  }
  var encoded;
  try { encoded = JSON.stringify(value); }
  catch (_e) {
    throw new TypeError("seller-signup: business_address must be JSON-serialisable");
  }
  if (encoded.length > MAX_ADDRESS_JSON_LEN) {
    throw new TypeError("seller-signup: business_address JSON must be <= " + MAX_ADDRESS_JSON_LEN + " characters serialised");
  }
  if (CONTROL_BYTE_RE.test(encoded) || ZERO_WIDTH_RE.test(encoded)) {
    throw new TypeError("seller-signup: business_address contains control / zero-width bytes");
  }
  return encoded;
}

function _taxIdKind(s) {
  if (typeof s !== "string" || TAX_ID_KINDS.indexOf(s) === -1) {
    throw new TypeError("seller-signup: tax_id_kind must be one of " + TAX_ID_KINDS.join(", "));
  }
  return s;
}

function _taxIdValue(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("seller-signup: tax_id_value must be a non-empty string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("seller-signup: tax_id_value must be non-empty after trim");
  }
  if (trimmed.length > MAX_TAX_ID_LEN) {
    throw new TypeError("seller-signup: tax_id_value must be <= " + MAX_TAX_ID_LEN + " characters");
  }
  if (!TAX_ID_RE.test(trimmed)) {
    throw new TypeError("seller-signup: tax_id_value must match /^[A-Za-z0-9][A-Za-z0-9 .\\-_/]*$/");
  }
  return trimmed;
}

function _categoryFocus(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("seller-signup: category_focus must be a non-empty array");
  }
  if (value.length === 0) {
    throw new TypeError("seller-signup: category_focus must contain at least one category");
  }
  for (var i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== "string" || !value[i].length) {
      throw new TypeError("seller-signup: category_focus[" + i + "] must be a non-empty string");
    }
    if (CONTROL_BYTE_RE.test(value[i]) || ZERO_WIDTH_RE.test(value[i])) {
      throw new TypeError("seller-signup: category_focus[" + i + "] contains control / zero-width bytes");
    }
  }
  var encoded;
  try { encoded = JSON.stringify(value); }
  catch (_e) {
    throw new TypeError("seller-signup: category_focus must be JSON-serialisable");
  }
  if (encoded.length > MAX_CATEGORY_FOCUS_LEN) {
    throw new TypeError("seller-signup: category_focus JSON must be <= " + MAX_CATEGORY_FOCUS_LEN + " characters serialised");
  }
  return encoded;
}

function _volumeMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("seller-signup: expected_monthly_volume_minor must be a non-negative integer");
  }
  if (n > MAX_VOLUME_MINOR) {
    throw new TypeError("seller-signup: expected_monthly_volume_minor must be <= " + MAX_VOLUME_MINOR);
  }
  return n;
}

function _currency(s) {
  if (typeof s !== "string" || !/^[A-Z]{3}$/.test(s)) {
    throw new TypeError("seller-signup: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _referencesJson(value) {
  if (value == null) return null;
  if (typeof value !== "object") {
    throw new TypeError("seller-signup: references_json must be an object / array or null");
  }
  var encoded;
  try { encoded = JSON.stringify(value); }
  catch (_e) {
    throw new TypeError("seller-signup: references_json must be JSON-serialisable");
  }
  if (encoded.length > MAX_REFERENCES_JSON_LEN) {
    throw new TypeError("seller-signup: references_json must be <= " + MAX_REFERENCES_JSON_LEN + " characters serialised");
  }
  if (CONTROL_BYTE_RE.test(encoded) || ZERO_WIDTH_RE.test(encoded)) {
    throw new TypeError("seller-signup: references_json contains control / zero-width bytes");
  }
  return encoded;
}

function _docKind(s) {
  if (typeof s !== "string" || DOC_KINDS.indexOf(s) === -1) {
    throw new TypeError("seller-signup: doc_kind must be one of " + DOC_KINDS.join(", "));
  }
  return s;
}

function _instructions(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("seller-signup: instructions must be a non-empty string");
  }
  if (s.length > MAX_INSTRUCTIONS_LEN) {
    throw new TypeError("seller-signup: instructions must be <= " + MAX_INSTRUCTIONS_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s.replace(/[\t\n\r]/g, ""))) {
    throw new TypeError("seller-signup: instructions contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("seller-signup: instructions contains zero-width / direction-override bytes");
  }
  return s;
}

function _rejectReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("seller-signup: reason must be a non-empty string");
  }
  if (s.length > MAX_REJECT_REASON_LEN) {
    throw new TypeError("seller-signup: reason must be <= " + MAX_REJECT_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s.replace(/[\t\n\r]/g, ""))) {
    throw new TypeError("seller-signup: reason contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("seller-signup: reason contains zero-width / direction-override bytes");
  }
  return s;
}

function _operatorId(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("seller-signup: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_OPERATOR_ID_LEN) {
    throw new TypeError("seller-signup: " + label + " must be <= " + MAX_OPERATOR_ID_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("seller-signup: " + label + " contains control / zero-width bytes");
  }
  return s;
}

function _sha3_512(s) {
  if (typeof s !== "string") {
    throw new TypeError("seller-signup: sha3_512 must be a string");
  }
  if (!SHA3_512_RE.test(s)) {
    throw new TypeError("seller-signup: sha3_512 must be 128 lowercase hex characters");
  }
  return s;
}

function _byteSize(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("seller-signup: byte_size must be a positive integer");
  }
  if (n > MAX_BYTE_SIZE) {
    throw new TypeError("seller-signup: byte_size must be <= " + MAX_BYTE_SIZE);
  }
  return n;
}

function _mimeType(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("seller-signup: mime_type must be a non-empty string");
  }
  if (s.length > MAX_MIME_TYPE_LEN) {
    throw new TypeError("seller-signup: mime_type must be <= " + MAX_MIME_TYPE_LEN + " characters");
  }
  if (!MIME_RE.test(s)) {
    throw new TypeError("seller-signup: mime_type must match RFC-6838 type/subtype shape");
  }
  return s;
}

function _fieldsArray(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("seller-signup: fields must be a non-empty array");
  }
  if (value.length === 0) {
    throw new TypeError("seller-signup: fields must contain at least one entry");
  }
  if (value.length > MAX_FIELDS_LEN) {
    throw new TypeError("seller-signup: fields must contain <= " + MAX_FIELDS_LEN + " entries");
  }
  var seen = Object.create(null);
  for (var i = 0; i < value.length; i += 1) {
    var f = value[i];
    if (typeof f !== "string" || !f.length) {
      throw new TypeError("seller-signup: fields[" + i + "] must be a non-empty string");
    }
    if (f.length > MAX_FIELD_NAME_LEN) {
      throw new TypeError("seller-signup: fields[" + i + "] must be <= " + MAX_FIELD_NAME_LEN + " characters");
    }
    if (!FIELD_NAME_RE.test(f)) {
      throw new TypeError("seller-signup: fields[" + i + "] must match /^[a-z][a-z0-9_]*$/");
    }
    if (seen[f]) {
      throw new TypeError("seller-signup: fields contains duplicate " + JSON.stringify(f));
    }
    seen[f] = true;
  }
  return value.slice();
}

function _applicationStatus(s) {
  if (typeof s !== "string" || APPLICATION_STATUSES.indexOf(s) === -1) {
    throw new TypeError("seller-signup: status must be one of " + APPLICATION_STATUSES.join(", "));
  }
  return s;
}

function _listLimit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("seller-signup: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

// Monotonic clock — guarantees each subsequent call returns a
// strictly greater integer even when the wall clock resolution
// can't keep up (Windows / fast CI runners). Application + document
// rows depend on created_at ordering for the operator inbox sort;
// any duplicate timestamp would force a tie-break on the secondary
// (id) column, which is fine for correctness but produces test
// flakes where a sub-millisecond write-then-list reads the rows in
// an unexpected order.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- row hydration ------------------------------------------------------

function _hydrateApplication(row) {
  if (!row) return null;
  return {
    id:                              row.id,
    business_name:                   row.business_name,
    contact_email_hash:              row.contact_email_hash,
    contact_email_normalised:        row.contact_email_normalised,
    contact_phone_hash:              row.contact_phone_hash,
    contact_phone_normalised:        row.contact_phone_normalised,
    business_address:                JSON.parse(row.business_address_json),
    tax_id_kind:                     row.tax_id_kind,
    tax_id_hash:                     row.tax_id_hash,
    tax_id_normalised_last4:         row.tax_id_normalised_last4,
    category_focus:                  JSON.parse(row.category_focus_json),
    expected_monthly_volume_minor:   Number(row.expected_monthly_volume_minor),
    currency:                        row.currency,
    references_json:                 row.references_json == null ? null : JSON.parse(row.references_json),
    status:                          row.status,
    approved_at:                     row.approved_at == null ? null : Number(row.approved_at),
    approved_by:                     row.approved_by == null ? null : row.approved_by,
    rejected_at:                     row.rejected_at == null ? null : Number(row.rejected_at),
    rejected_by:                     row.rejected_by == null ? null : row.rejected_by,
    reject_reason:                   row.reject_reason == null ? null : row.reject_reason,
    vendor_slug:                     row.vendor_slug == null ? null : row.vendor_slug,
    created_at:                      Number(row.created_at),
    updated_at:                      Number(row.updated_at),
  };
}

function _hydrateDocument(row) {
  if (!row) return null;
  return {
    id:              row.id,
    application_id:  row.application_id,
    doc_kind:        row.doc_kind,
    status:          row.status,
    instructions:    row.instructions,
    sha3_512:        row.sha3_512 == null ? null : row.sha3_512,
    byte_size:       row.byte_size == null ? null : Number(row.byte_size),
    mime_type:       row.mime_type == null ? null : row.mime_type,
    uploaded_at:     row.uploaded_at == null ? null : Number(row.uploaded_at),
    accepted_at:     row.accepted_at == null ? null : Number(row.accepted_at),
    rejected_at:     row.rejected_at == null ? null : Number(row.rejected_at),
    reject_reason:   row.reject_reason == null ? null : row.reject_reason,
    created_at:      Number(row.created_at),
    updated_at:      Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // The vendors handle is optional at construction. approveApplication
  // requires it — when absent the approve verb refuses with a typed
  // error. Submit / requestDocument / recordDocumentUploaded /
  // rejectApplication / requestRevisions all work without it.
  var vendorsHandle = opts.vendors || null;
  if (vendorsHandle && typeof vendorsHandle.registerVendor !== "function") {
    throw new TypeError("seller-signup.create: opts.vendors must expose registerVendor when provided");
  }

  function _hashEmail(canonical) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, canonical);
  }
  function _hashPhone(normalized) {
    return b.crypto.namespaceHash(PHONE_NAMESPACE, normalized);
  }
  function _hashTaxId(normalized) {
    return b.crypto.namespaceHash(TAX_ID_NAMESPACE, normalized);
  }

  async function _getApplicationRaw(id) {
    var r = await query("SELECT * FROM seller_applications WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getDocumentRaw(id) {
    var r = await query("SELECT * FROM seller_application_documents WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // Compute the next application status after a doc event. When
  // every document is at status='uploaded' (or 'accepted'), the
  // application advances to 'in_review'. While any doc is still
  // 'requested', the application sits at 'docs_pending'.
  async function _statusAfterDocChange(applicationId, priorStatus) {
    if (priorStatus === "approved" || priorStatus === "rejected" || priorStatus === "withdrawn") {
      return priorStatus;
    }
    var docs = (await query(
      "SELECT status FROM seller_application_documents WHERE application_id = ?1",
      [applicationId],
    )).rows;
    if (docs.length === 0) {
      return "submitted";
    }
    var anyRequested = false;
    for (var i = 0; i < docs.length; i += 1) {
      if (docs[i].status === "requested") {
        anyRequested = true;
        break;
      }
    }
    if (anyRequested) return "docs_pending";
    return "in_review";
  }

  return {
    EMAIL_NAMESPACE:             EMAIL_NAMESPACE,
    PHONE_NAMESPACE:             PHONE_NAMESPACE,
    TAX_ID_NAMESPACE:            TAX_ID_NAMESPACE,
    TAX_ID_KINDS:                TAX_ID_KINDS.slice(),
    DOC_KINDS:                   DOC_KINDS.slice(),
    APPLICATION_STATUSES:        APPLICATION_STATUSES.slice(),
    DOCUMENT_STATUSES:           DOCUMENT_STATUSES.slice(),
    TERMINAL_APPLICATION_STATUSES: TERMINAL_APPLICATION_STATUSES.slice(),
    MAX_BUSINESS_NAME_LEN:       MAX_BUSINESS_NAME_LEN,
    MAX_PHONE_LEN:               MAX_PHONE_LEN,
    MAX_TAX_ID_LEN:              MAX_TAX_ID_LEN,
    MAX_ADDRESS_JSON_LEN:        MAX_ADDRESS_JSON_LEN,
    MAX_CATEGORY_FOCUS_LEN:      MAX_CATEGORY_FOCUS_LEN,
    MAX_REFERENCES_JSON_LEN:     MAX_REFERENCES_JSON_LEN,
    MAX_INSTRUCTIONS_LEN:        MAX_INSTRUCTIONS_LEN,
    MAX_REJECT_REASON_LEN:       MAX_REJECT_REASON_LEN,
    MAX_OPERATOR_ID_LEN:         MAX_OPERATOR_ID_LEN,
    MAX_MIME_TYPE_LEN:           MAX_MIME_TYPE_LEN,
    MAX_FIELDS_LEN:              MAX_FIELDS_LEN,
    MAX_FIELD_NAME_LEN:          MAX_FIELD_NAME_LEN,
    MAX_LIST_LIMIT:              MAX_LIST_LIMIT,
    MAX_VOLUME_MINOR:            MAX_VOLUME_MINOR,
    MAX_BYTE_SIZE:               MAX_BYTE_SIZE,

    // Capture an inbound application. Email / phone / tax_id are
    // hashed via namespaceHash so the raw values never land on disk.
    // The application opens at status='submitted' and waits for the
    // operator to call requestDocument; the docs cascade then walks
    // it through docs_pending -> in_review -> approved | rejected.
    submitApplication: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("seller-signup.submitApplication: input object required");
      }
      var businessName    = _businessName(input.business_name);
      var emailNorm       = _normalizeEmail(input.contact_email);
      var emailHash       = _hashEmail(emailNorm);
      var phoneNorm       = _phone(input.contact_phone);
      var phoneHash       = _hashPhone(phoneNorm);
      var addressJson     = _businessAddress(input.business_address);
      var taxIdKind       = _taxIdKind(input.tax_id_kind);
      var taxIdValue      = _taxIdValue(input.tax_id_value);
      var taxIdNormalized = taxIdValue.replace(/\s+/g, "").toUpperCase();
      var taxIdHash       = _hashTaxId(taxIdNormalized);
      var taxIdLast4      = taxIdNormalized.slice(-4);
      var categoryFocus   = _categoryFocus(input.category_focus);
      var volume          = _volumeMinor(input.expected_monthly_volume_minor);
      var currency        = _currency(input.currency);
      var referencesJson  = _referencesJson(input.references_json);

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO seller_applications " +
        "(id, business_name, contact_email_hash, contact_email_normalised, " +
        " contact_phone_hash, contact_phone_normalised, business_address_json, " +
        " tax_id_kind, tax_id_hash, tax_id_normalised_last4, category_focus_json, " +
        " expected_monthly_volume_minor, currency, references_json, status, " +
        " approved_at, approved_by, rejected_at, rejected_by, reject_reason, " +
        " vendor_slug, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, " +
        " 'submitted', NULL, NULL, NULL, NULL, NULL, NULL, ?15, ?15)",
        [
          id, businessName, emailHash, emailNorm, phoneHash, phoneNorm,
          addressJson, taxIdKind, taxIdHash, taxIdLast4, categoryFocus,
          volume, currency, referencesJson, ts,
        ],
      );
      return _hydrateApplication(await _getApplicationRaw(id));
    },

    // Operator requests a supporting document. The document row
    // lands at status='requested'; the applicant later uploads via
    // recordDocumentUploaded. Multiple distinct doc_kinds may be
    // requested at once. Re-requesting the same doc_kind WHILE the
    // prior request is still open ('requested') refuses — the
    // operator should wait for the upload or escalate via
    // rejectApplication; re-requesting AFTER an upload is the
    // requestRevisions flow.
    requestDocument: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("seller-signup.requestDocument: input object required");
      }
      var applicationId = _uuid(input.application_id, "application_id");
      var docKind       = _docKind(input.doc_kind);
      var instructions  = _instructions(input.instructions);

      var app = await _getApplicationRaw(applicationId);
      if (!app) {
        var miss = new Error("seller-signup.requestDocument: application not found");
        miss.code = "APPLICATION_NOT_FOUND";
        throw miss;
      }
      if (TERMINAL_APPLICATION_STATUSES.indexOf(app.status) !== -1) {
        var term = new Error(
          "seller-signup.requestDocument: refused — application is " + app.status + " (terminal)"
        );
        term.code = "APPLICATION_TERMINAL";
        throw term;
      }

      var open = await query(
        "SELECT id FROM seller_application_documents " +
        "WHERE application_id = ?1 AND doc_kind = ?2 AND status = 'requested'",
        [applicationId, docKind],
      );
      if (open.rows.length) {
        var dup = new Error(
          "seller-signup.requestDocument: refused — doc_kind " + JSON.stringify(docKind) +
          " already has an open request on this application"
        );
        dup.code = "DOCUMENT_REQUEST_OPEN";
        throw dup;
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO seller_application_documents " +
        "(id, application_id, doc_kind, status, instructions, sha3_512, byte_size, " +
        " mime_type, uploaded_at, accepted_at, rejected_at, reject_reason, " +
        " created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, 'requested', ?4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?5, ?5)",
        [id, applicationId, docKind, instructions, ts],
      );

      // Advance application FSM to docs_pending if it was submitted
      // or revisions_requested (the operator can transition into
      // docs_pending by requesting any document).
      var nextStatus = await _statusAfterDocChange(applicationId, app.status);
      if (nextStatus !== app.status) {
        await query(
          "UPDATE seller_applications SET status = ?1, updated_at = ?2 WHERE id = ?3",
          [nextStatus, ts, applicationId],
        );
      } else {
        await query(
          "UPDATE seller_applications SET updated_at = ?1 WHERE id = ?2",
          [ts, applicationId],
        );
      }

      return _hydrateDocument(await _getDocumentRaw(id));
    },

    // Applicant uploads the doc. Status moves from requested ->
    // uploaded; sha3_512 + byte_size + mime_type are captured.
    // Refuses when the doc isn't at status='requested' (idempotent
    // hazard — a retry would clobber the original upload's
    // sha3_512 + byte_size + mime_type). Application FSM advances
    // to in_review when this was the last outstanding requested doc.
    recordDocumentUploaded: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("seller-signup.recordDocumentUploaded: input object required");
      }
      var applicationId = _uuid(input.application_id, "application_id");
      var docKind       = _docKind(input.doc_kind);
      var sha3          = _sha3_512(input.sha3_512);
      var byteSize      = _byteSize(input.byte_size);
      var mimeType      = _mimeType(input.mime_type);

      var app = await _getApplicationRaw(applicationId);
      if (!app) {
        var miss = new Error("seller-signup.recordDocumentUploaded: application not found");
        miss.code = "APPLICATION_NOT_FOUND";
        throw miss;
      }
      if (TERMINAL_APPLICATION_STATUSES.indexOf(app.status) !== -1) {
        var term = new Error(
          "seller-signup.recordDocumentUploaded: refused — application is " + app.status + " (terminal)"
        );
        term.code = "APPLICATION_TERMINAL";
        throw term;
      }

      // Find the open request for (application, doc_kind).
      var open = await query(
        "SELECT * FROM seller_application_documents " +
        "WHERE application_id = ?1 AND doc_kind = ?2 AND status = 'requested' " +
        "ORDER BY created_at DESC LIMIT 1",
        [applicationId, docKind],
      );
      if (!open.rows.length) {
        var noOpen = new Error(
          "seller-signup.recordDocumentUploaded: refused — no open request for doc_kind " +
          JSON.stringify(docKind) + " on this application"
        );
        noOpen.code = "NO_OPEN_REQUEST";
        throw noOpen;
      }

      var ts = _now();
      await query(
        "UPDATE seller_application_documents " +
        "SET status = 'uploaded', sha3_512 = ?1, byte_size = ?2, mime_type = ?3, " +
        "    uploaded_at = ?4, updated_at = ?4 " +
        "WHERE id = ?5",
        [sha3, byteSize, mimeType, ts, open.rows[0].id],
      );

      var nextStatus = await _statusAfterDocChange(applicationId, app.status);
      if (nextStatus !== app.status) {
        await query(
          "UPDATE seller_applications SET status = ?1, updated_at = ?2 WHERE id = ?3",
          [nextStatus, ts, applicationId],
        );
      } else {
        await query(
          "UPDATE seller_applications SET updated_at = ?1 WHERE id = ?2",
          [ts, applicationId],
        );
      }
      return _hydrateDocument(await _getDocumentRaw(open.rows[0].id));
    },

    // Operator approves the application. Composes
    // vendors.registerVendor to mint the real vendor row, then
    // transitions the application to approved with the resulting
    // vendor_slug captured. Refuses if the application is already
    // terminal, if any document is still 'requested', or if no
    // vendors handle was wired at construction. The vendor's
    // contact_email + contact_phone + address are filled from the
    // application's normalised columns; commission_split_bps +
    // payout_method + payout_address are operator decisions
    // captured separately (the operator passes them via the
    // vendor_slug call chain, but the v1 surface assumes operator-
    // sane defaults — caller supplies vendor_slug here, the
    // primitive registers with payout_method='bank_transfer' +
    // commission_split_bps=7000 and the operator updates via
    // vendors.updateVendor afterwards).
    approveApplication: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("seller-signup.approveApplication: input object required");
      }
      var applicationId = _uuid(input.application_id, "application_id");
      var approvedBy    = _operatorId(input.approved_by, "approved_by");
      if (typeof input.vendor_slug !== "string" || !input.vendor_slug.length) {
        throw new TypeError("seller-signup.approveApplication: vendor_slug must be a non-empty string");
      }
      var vendorSlug    = input.vendor_slug;

      if (!vendorsHandle) {
        var noVendors = new Error(
          "seller-signup.approveApplication: refused — opts.vendors was not wired at construction; " +
          "the approve verb composes vendors.registerVendor and cannot run without it"
        );
        noVendors.code = "VENDORS_HANDLE_MISSING";
        throw noVendors;
      }

      var app = await _getApplicationRaw(applicationId);
      if (!app) {
        var miss = new Error("seller-signup.approveApplication: application not found");
        miss.code = "APPLICATION_NOT_FOUND";
        throw miss;
      }
      if (TERMINAL_APPLICATION_STATUSES.indexOf(app.status) !== -1) {
        var term = new Error(
          "seller-signup.approveApplication: refused — application is " + app.status + " (terminal)"
        );
        term.code = "APPLICATION_TERMINAL";
        throw term;
      }
      if (app.status !== "in_review") {
        var notReady = new Error(
          "seller-signup.approveApplication: refused — application is " + app.status +
          "; approve requires status='in_review' (all requested documents uploaded)"
        );
        notReady.code = "APPLICATION_NOT_READY";
        throw notReady;
      }

      // Compose vendors.registerVendor — the operator-facing v1
      // defaults a fresh marketplace seller to bank_transfer payout +
      // 70% commission split; the operator tunes both via
      // vendors.updateVendor after approval.
      var vendor;
      try {
        vendor = await vendorsHandle.registerVendor({
          slug:                 vendorSlug,
          name:                 app.business_name,
          contact_email:        app.contact_email_normalised,
          contact_phone:        app.contact_phone_normalised,
          address:              JSON.parse(app.business_address_json),
          payout_method:        "bank_transfer",
          payout_address:       "pending-operator-update",
          commission_split_bps: 7000,
          status:               "active",
        });
      } catch (e) {
        // Surface the vendors error with our typed-code wrapper so
        // operators can distinguish a vendors-layer refusal from an
        // application-layer refusal.
        var wrapped = new Error(
          "seller-signup.approveApplication: vendors.registerVendor refused — " +
          (e && e.message || "unknown")
        );
        wrapped.code = "VENDORS_REGISTER_REFUSED";
        wrapped.cause = e;
        throw wrapped;
      }

      var ts = _now();
      await query(
        "UPDATE seller_applications " +
        "SET status = 'approved', approved_at = ?1, approved_by = ?2, " +
        "    vendor_slug = ?3, updated_at = ?1 " +
        "WHERE id = ?4",
        [ts, approvedBy, vendor.slug, applicationId],
      );

      return {
        application: _hydrateApplication(await _getApplicationRaw(applicationId)),
        vendor:      vendor,
      };
    },

    // Operator rejects the application. Terminal — no transitions
    // out. The reason is captured for audit. Open document requests
    // are NOT auto-closed (they remain at status='requested') so
    // the audit trail records what was asked for; downstream
    // operator-side erasure flows handle physical cleanup.
    rejectApplication: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("seller-signup.rejectApplication: input object required");
      }
      var applicationId = _uuid(input.application_id, "application_id");
      var reason        = _rejectReason(input.reason);
      var rejectedBy    = _operatorId(input.rejected_by, "rejected_by");

      var app = await _getApplicationRaw(applicationId);
      if (!app) {
        var miss = new Error("seller-signup.rejectApplication: application not found");
        miss.code = "APPLICATION_NOT_FOUND";
        throw miss;
      }
      if (TERMINAL_APPLICATION_STATUSES.indexOf(app.status) !== -1) {
        var term = new Error(
          "seller-signup.rejectApplication: refused — application is " + app.status + " (terminal)"
        );
        term.code = "APPLICATION_TERMINAL";
        throw term;
      }

      var ts = _now();
      await query(
        "UPDATE seller_applications " +
        "SET status = 'rejected', rejected_at = ?1, rejected_by = ?2, " +
        "    reject_reason = ?3, updated_at = ?1 " +
        "WHERE id = ?4",
        [ts, rejectedBy, reason, applicationId],
      );
      return _hydrateApplication(await _getApplicationRaw(applicationId));
    },

    // Operator asks the applicant to refile something. Re-opens the
    // application for additional doc cycles: transitions status to
    // 'revisions_requested'; the operator follows up with one or
    // more requestDocument calls that cascade the application back
    // into 'docs_pending'. `fields` is the list of operator-facing
    // field names the applicant needs to revise (rendered in the
    // applicant's revision UI); `instructions` is a free-text
    // explanation. Refuses on terminal statuses.
    requestRevisions: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("seller-signup.requestRevisions: input object required");
      }
      var applicationId = _uuid(input.application_id, "application_id");
      var fields        = _fieldsArray(input.fields);
      var instructions  = _instructions(input.instructions);

      var app = await _getApplicationRaw(applicationId);
      if (!app) {
        var miss = new Error("seller-signup.requestRevisions: application not found");
        miss.code = "APPLICATION_NOT_FOUND";
        throw miss;
      }
      if (TERMINAL_APPLICATION_STATUSES.indexOf(app.status) !== -1) {
        var term = new Error(
          "seller-signup.requestRevisions: refused — application is " + app.status + " (terminal)"
        );
        term.code = "APPLICATION_TERMINAL";
        throw term;
      }

      var ts = _now();
      await query(
        "UPDATE seller_applications SET status = 'revisions_requested', updated_at = ?1 WHERE id = ?2",
        [ts, applicationId],
      );
      return {
        application: _hydrateApplication(await _getApplicationRaw(applicationId)),
        fields:      fields,
        instructions: instructions,
      };
    },

    getApplication: async function (id) {
      var applicationId = _uuid(id, "id");
      return _hydrateApplication(await _getApplicationRaw(applicationId));
    },

    // Operator inbox list. Optionally filter by status. Cursor is
    // a millisecond epoch — list rows older than the cursor.
    // Mirrors the shape used by loyalty-redemption / customer-notes.
    listApplications: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _listLimit(limit);

      var sql = "SELECT * FROM seller_applications";
      var params = [];
      var where = [];
      if (listOpts.status != null) {
        var status = _applicationStatus(listOpts.status);
        where.push("status = ?" + (params.length + 1));
        params.push(status);
      }
      if (listOpts.cursor != null) {
        if (!Number.isInteger(listOpts.cursor) || listOpts.cursor < 0) {
          throw new TypeError("seller-signup.listApplications: cursor must be a non-negative integer (ms epoch)");
        }
        where.push("created_at < ?" + (params.length + 1));
        params.push(listOpts.cursor);
      }
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY created_at DESC, id DESC LIMIT ?" + (params.length + 1);
      params.push(limit);

      var rows = (await query(sql, params)).rows;
      var hydrated = rows.map(_hydrateApplication);
      var nextCursor = hydrated.length === limit ? hydrated[hydrated.length - 1].created_at : null;
      return { rows: hydrated, next_cursor: nextCursor };
    },

    documentsForApplication: async function (applicationId) {
      var id = _uuid(applicationId, "application_id");
      var r = await query(
        "SELECT * FROM seller_application_documents WHERE application_id = ?1 " +
        "ORDER BY created_at ASC, id ASC",
        [id],
      );
      return r.rows.map(_hydrateDocument);
    },
  };
}

module.exports = {
  create:                        create,
  EMAIL_NAMESPACE:               EMAIL_NAMESPACE,
  PHONE_NAMESPACE:               PHONE_NAMESPACE,
  TAX_ID_NAMESPACE:              TAX_ID_NAMESPACE,
  TAX_ID_KINDS:                  TAX_ID_KINDS.slice(),
  DOC_KINDS:                     DOC_KINDS.slice(),
  APPLICATION_STATUSES:          APPLICATION_STATUSES.slice(),
  DOCUMENT_STATUSES:             DOCUMENT_STATUSES.slice(),
  TERMINAL_APPLICATION_STATUSES: TERMINAL_APPLICATION_STATUSES.slice(),
  MAX_BUSINESS_NAME_LEN:         MAX_BUSINESS_NAME_LEN,
  MAX_PHONE_LEN:                 MAX_PHONE_LEN,
  MAX_TAX_ID_LEN:                MAX_TAX_ID_LEN,
  MAX_ADDRESS_JSON_LEN:          MAX_ADDRESS_JSON_LEN,
  MAX_CATEGORY_FOCUS_LEN:        MAX_CATEGORY_FOCUS_LEN,
  MAX_REFERENCES_JSON_LEN:       MAX_REFERENCES_JSON_LEN,
  MAX_INSTRUCTIONS_LEN:          MAX_INSTRUCTIONS_LEN,
  MAX_REJECT_REASON_LEN:         MAX_REJECT_REASON_LEN,
  MAX_OPERATOR_ID_LEN:           MAX_OPERATOR_ID_LEN,
  MAX_MIME_TYPE_LEN:             MAX_MIME_TYPE_LEN,
  MAX_FIELDS_LEN:                MAX_FIELDS_LEN,
  MAX_FIELD_NAME_LEN:            MAX_FIELD_NAME_LEN,
  MAX_LIST_LIMIT:                MAX_LIST_LIMIT,
  MAX_VOLUME_MINOR:              MAX_VOLUME_MINOR,
  MAX_BYTE_SIZE:                 MAX_BYTE_SIZE,
};
