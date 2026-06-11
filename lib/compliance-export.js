"use strict";
/**
 * @module shop.complianceExport
 * @title  Subject-access-request export + deletion for GDPR / CCPA /
 *         LGPD (and operator-declared "other" jurisdictions)
 *
 * @intro
 *   A customer (or operator acting on the customer's behalf) files
 *   a privacy request: "give me a copy of everything you hold on
 *   me" (export) or "erase everything you hold on me" (deletion).
 *   The primitive owns the request lifecycle + composes per-domain
 *   readers (customers, order, order-notes, subscriptions,
 *   addresses, payment-methods, support-tickets, loyalty, reviews,
 *   consent ledger, wishlist, surveys, recently-viewed, suggestion
 *   box, save-for-later, store credit) to assemble the bundle —
 *   every table that keys a row by the customer, so the export holds
 *   the whole record, not just the order/identity core.
 *   Delivery (email / signed URL / secure
 *   download portal) is the operator worker's concern — this
 *   primitive returns the bundle as structured JSON and stamps
 *   the lifecycle row when the worker confirms dispatch.
 *
 *   Distinct from `orderExport`. That primitive answers "operator
 *   dump of orders in date range D for accounting." This one
 *   answers "customer C invoked their right under law L."
 *
 *   Surface:
 *
 *     - requestExport({ customer_id, requested_by, jurisdiction,
 *                       scope: 'full' | 'orders_only' | 'identity_only' })
 *         Files an export request. Returns the persisted row.
 *
 *     - requestDeletion({ customer_id, requested_by, reason })
 *         Files a deletion request. `reason` is operator-authored
 *         prose (capped) — most jurisdictions require a stated basis.
 *
 *     - getRequest(request_id) / listRequests({ status?, jurisdiction?, limit? })
 *
 *     - fulfillRequest({ request_id })
 *         For an export, walks every injected reader and assembles
 *         the bundle JSON. The status flips received -> processing
 *         -> fulfilled and the row's `fulfilled_at` stamps. Returns
 *         the bundle.
 *
 *     - dispatchExport({ request_id, delivery_method, delivery_address })
 *         Stamps fulfilled -> delivered with the channel + address.
 *         The operator worker calls this after handoff.
 *
 *     - processDeletion({ request_id, dry_run? })
 *         For a deletion, returns the affected-row counts per table.
 *         `dry_run: true` reports the counts without executing the
 *         deletes — the operator dashboard previews the blast radius
 *         before the customer's irreversible erasure call. `dry_run:
 *         false` (the default) executes the deletes and flips
 *         received/processing -> fulfilled.
 *
 *     - dismissRequest({ request_id, dismiss_reason })
 *         Closes a request without fulfilling (identity verification
 *         failed, jurisdiction out of scope, duplicate).
 *
 *     - auditForCustomer(customer_id)
 *         Full history of export + deletion requests for a customer.
 *         The compliance receipt the operator presents when a
 *         supervisory authority asks "what did you do when customer C
 *         filed their SAR?"
 *
 *   Injected-reader contract:
 *
 *     Each injected primitive (customers / order / subscriptions /
 *     addresses / paymentMethods / supportTickets / loyalty /
 *     orderNotes) must expose either a `forCustomerExport(customer_id)`
 *     method that returns an array (or object) of redaction-clean
 *     data, or a `forCustomerDeletion(customer_id)` method that
 *     executes the per-domain deletion + returns
 *     `{ table, deleted: <integer> }`. When neither method is present
 *     on an injected primitive, the section is skipped (the bundle
 *     reports the section as absent rather than throwing) — this lets
 *     operators wire compliance-export against partial domain
 *     coverage during incremental rollout.
 *
 *   Scope semantics on export:
 *
 *     - `full`           — every injected reader contributes (identity,
 *                          orders, subscriptions, addresses, payment
 *                          methods, support tickets, loyalty, reviews,
 *                          consent ledger, wishlist, surveys,
 *                          recently-viewed, suggestion box,
 *                          save-for-later, store credit).
 *     - `orders_only`    — only `order` + `orderNotes` contribute;
 *                          identity / loyalty / subscriptions /
 *                          addresses / payment methods / support
 *                          tickets are omitted.
 *     - `identity_only`  — only `customers` + `addresses` contribute;
 *                          everything else omitted. The "I just want
 *                          to see what profile data you hold"
 *                          variant.
 *
 *   Composition:
 *     - b.uuid.v7      — request row PK
 *     - b.guardUuid    — customer_id / request_id strict UUID
 *
 * @primitive complianceExport
 * @related    customers, order, orderNotes, subscriptions, addresses,
 *             paymentMethods, supportTickets, loyalty, reviews,
 *             consentLedger, wishlist, customerSurveys, recentlyViewed,
 *             suggestionBox, saveForLater, storeCredit, orderExport
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var REQUEST_KINDS  = Object.freeze(["export", "deletion"]);
var JURISDICTIONS  = Object.freeze(["gdpr", "ccpa", "lgpd", "other"]);
var SCOPES         = Object.freeze(["full", "orders_only", "identity_only"]);
var STATUSES       = Object.freeze([
  "received", "processing", "fulfilled", "delivered", "dismissed",
]);

// Statutory response window per jurisdiction — the clock a supervisory
// authority measures the controller against once a subject files the
// request. The deadline is `requested_at + days`. GDPR Art. 12(3): one
// month from receipt (encoded as 30 days — the controller-defensible
// reading; extendable by two further months for complex requests, which an
// operator records out of band). CCPA Cal. Civ. Code §1798.130(a)(2): 45
// days (one 45-day extension permitted). LGPD Art. 19 §II / §3: 15 days for
// the full declaration. `other` carries no statutory clock — the operator's
// own SLA governs, so no deadline is surfaced rather than inventing one.
//
// This is the DSR-response analogue of b.breach.deadline (which encodes the
// US-state breach-NOTIFICATION statutes — a different clock with different
// citations); a subject-access response window has no entry in that
// registry, so the per-jurisdiction window lives here keyed to the same
// jurisdiction vocabulary the request rows already carry.
var DSR_RESPONSE_WINDOW = Object.freeze({
  gdpr: Object.freeze({ days: 30, statute: "GDPR Art. 12(3) (one month from receipt)" }),
  ccpa: Object.freeze({ days: 45, statute: "Cal. Civ. Code §1798.130(a)(2)" }),
  lgpd: Object.freeze({ days: 15, statute: "LGPD Art. 19 §II" }),
  other: null,   // operator SLA governs — no statutory clock to surface
});

var MS_PER_DAY = b.constants.TIME.days(1);

// Compute the statutory response deadline for a DSR request. Returns null
// for a jurisdiction with no statutory clock (`other`) or a non-finite
// requested-at. The shape mirrors b.breach.deadline.forStates entries —
// `{ jurisdiction, days, due_by, statute }` — so a future operator clock
// (b.breach.deadline.createClock-style escalation) can adapt it without a
// reshape.
function _statutoryDeadline(jurisdiction, requestedAtMs) {
  var win = DSR_RESPONSE_WINDOW[jurisdiction];
  if (!win) return null;
  if (typeof requestedAtMs !== "number" || !isFinite(requestedAtMs)) return null;
  return {
    jurisdiction: jurisdiction,
    days:         win.days,
    due_by:       requestedAtMs + (win.days * MS_PER_DAY),
    statute:      win.statute,
  };
}

var MAX_REASON_LEN          = 4000;
var MAX_DISMISS_REASON_LEN  = 4000;
var MAX_DELIVERY_METHOD_LEN = 64;
var MAX_DELIVERY_ADDR_LEN   = 1000;
var MAX_REQUESTED_BY_LEN    = 200;
var MAX_LIST_LIMIT          = 200;
var DEFAULT_LIST_LIMIT      = 50;

// Operator-authored prose lands in reason / dismiss_reason and
// replays into compliance review screens. Same control-byte +
// zero-width refusal posture the sibling primitives carry.
var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE   = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// Scope -> which injected readers contribute on export. Keeps the
// fulfillRequest logic a single lookup instead of nested if-else.
//
// `full` enumerates every domain that keys a row by the customer
// (directly via customer_id, or via a per-customer hash) so a
// subject-access export holds everything the controller stores about
// the person — not just the order / identity core. A domain that
// isn't wired (or whose reader is absent) is reported in
// `sections_absent`, so an unexported table is always visible in the
// bundle manifest rather than silently dropped.
var SCOPE_SECTIONS = Object.freeze({
  full: Object.freeze([
    "customers", "addresses", "order", "orderNotes",
    "subscriptions", "paymentMethods", "supportTickets", "loyalty",
    "reviews", "consentLedger", "wishlist", "surveys", "recentlyViewed",
    // Customer-authored feedback (ideas + complaints, keyed by id or a
    // hashed email), the save-for-later holdover list, and the store-
    // credit wallet ledger — each keys a row by the customer, so a
    // subject-access export holds them too.
    "suggestionBox", "saveForLater", "storeCredit",
  ]),
  orders_only: Object.freeze(["order", "orderNotes"]),
  identity_only: Object.freeze(["customers", "addresses"]),
});

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("complianceExport: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _kind(s) {
  if (typeof s !== "string" || REQUEST_KINDS.indexOf(s) === -1) {
    throw new TypeError("complianceExport: request_kind must be one of " + REQUEST_KINDS.join(", "));
  }
  return s;
}

function _jurisdiction(s) {
  if (typeof s !== "string" || JURISDICTIONS.indexOf(s) === -1) {
    throw new TypeError("complianceExport: jurisdiction must be one of " + JURISDICTIONS.join(", "));
  }
  return s;
}

function _scope(s) {
  if (typeof s !== "string" || SCOPES.indexOf(s) === -1) {
    throw new TypeError("complianceExport: scope must be one of " + SCOPES.join(", "));
  }
  return s;
}

function _status(s, label) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("complianceExport: " + label + " must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _requestedBy(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REQUESTED_BY_LEN) {
    throw new TypeError("complianceExport: requested_by must be a non-empty string <= " + MAX_REQUESTED_BY_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("complianceExport: requested_by must not contain control bytes or zero-width characters");
  }
  return s;
}

function _prose(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("complianceExport: " + label + " must be a non-empty string <= " + maxLen + " chars");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("complianceExport: " + label + " must not contain control bytes or zero-width characters");
  }
  return s;
}

function _deliveryMethod(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_DELIVERY_METHOD_LEN) {
    throw new TypeError("complianceExport: delivery_method must be a non-empty string <= " + MAX_DELIVERY_METHOD_LEN + " chars");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) {
    throw new TypeError("complianceExport: delivery_method must match /^[a-z0-9][a-z0-9_-]*$/");
  }
  return s;
}

function _deliveryAddress(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_DELIVERY_ADDR_LEN) {
    throw new TypeError("complianceExport: delivery_address must be a non-empty string <= " + MAX_DELIVERY_ADDR_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("complianceExport: delivery_address must not contain control bytes or zero-width characters");
  }
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("complianceExport: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _now() { return Date.now(); }

// Classify a reader's returned section for the completeness manifest.
// A section is "empty" when the reader is wired but holds nothing for
// this customer: null, an empty array, or an object whose own values
// are all themselves empty (e.g. `{ balance: 0, history: [] }`). Any
// other shape (a non-empty array, an object carrying a row, a scalar)
// counts as "exported". The distinction lets the auditor tell "we hold
// nothing here" apart from "this is real PII we exported".
function _isEmptySection(section) {
  if (section == null) return true;
  if (Array.isArray(section)) return section.length === 0;
  if (typeof section === "object") {
    var keys = Object.keys(section);
    if (keys.length === 0) return true;
    for (var i = 0; i < keys.length; i += 1) {
      if (!_isEmptySection(section[keys[i]])) return false;
    }
    return true;
  }
  // A scalar (string / number / boolean) is real exported data.
  return false;
}

// ---- row hydration ------------------------------------------------------

function _hydrate(r) {
  if (!r) return null;
  var requestedAt = Number(r.requested_at);
  return {
    id:               r.id,
    customer_id:      r.customer_id,
    request_kind:     r.request_kind,
    jurisdiction:     r.jurisdiction,
    scope:            r.scope == null ? null : r.scope,
    status:           r.status,
    requested_by:     r.requested_by,
    requested_at:     requestedAt,
    fulfilled_at:     r.fulfilled_at == null ? null : Number(r.fulfilled_at),
    delivered_at:     r.delivered_at == null ? null : Number(r.delivered_at),
    dismiss_reason:   r.dismiss_reason == null ? null : r.dismiss_reason,
    delivery_method:  r.delivery_method == null ? null : r.delivery_method,
    delivery_address: r.delivery_address == null ? null : r.delivery_address,
    reason:           r.reason == null ? null : r.reason,
    // Derived: the statutory response deadline the supervisory authority
    // measures against (computed from jurisdiction + requested_at, never
    // persisted — so it always reflects the current registry). Null for a
    // jurisdiction with no statutory clock. The admin DSR console surfaces
    // `due_by` so an operator sees the wall before it elapses.
    statutory_deadline: _statutoryDeadline(r.jurisdiction, requestedAt),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Injected readers — every one is optional. The bundle assembler
  // skips a section whose reader isn't wired; the deletion executor
  // skips a domain whose deletion-handler isn't wired. This lets an
  // operator stand the primitive up against partial domain coverage
  // during an incremental compliance rollout — the law-firm review
  // gate is "did you read what you have access to," not "did you
  // wire every primitive blamejs.shop ships."
  var injectedReaders = {
    customers:      opts.customers      || null,
    order:          opts.order          || null,
    orderNotes:     opts.orderNotes     || null,
    subscriptions:  opts.subscriptions  || null,
    addresses:      opts.addresses      || null,
    paymentMethods: opts.paymentMethods || null,
    supportTickets: opts.supportTickets || null,
    loyalty:        opts.loyalty        || null,
    reviews:        opts.reviews        || null,
    consentLedger:  opts.consentLedger  || null,
    wishlist:       opts.wishlist       || null,
    surveys:        opts.surveys        || null,
    recentlyViewed: opts.recentlyViewed || null,
    suggestionBox:  opts.suggestionBox  || null,
    saveForLater:   opts.saveForLater   || null,
    storeCredit:    opts.storeCredit    || null,
  };

  // ---- requestExport -------------------------------------------------

  async function requestExport(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("complianceExport.requestExport: input object required");
    }
    var customerId  = _uuid(input.customer_id,  "customer_id");
    var requestedBy = _requestedBy(input.requested_by);
    var jurisdiction = _jurisdiction(input.jurisdiction);
    var scope        = _scope(input.scope);

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO compliance_requests " +
      "(id, customer_id, request_kind, jurisdiction, scope, status, " +
      " requested_by, requested_at) " +
      "VALUES (?1, ?2, 'export', ?3, ?4, 'received', ?5, ?6)",
      [id, customerId, jurisdiction, scope, requestedBy, ts],
    );
    return await getRequest(id);
  }

  // ---- requestDeletion -----------------------------------------------

  async function requestDeletion(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("complianceExport.requestDeletion: input object required");
    }
    var customerId  = _uuid(input.customer_id,  "customer_id");
    var requestedBy = _requestedBy(input.requested_by);
    var jurisdiction = _jurisdiction(input.jurisdiction);
    var reason       = _prose(input.reason, "reason", MAX_REASON_LEN);

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO compliance_requests " +
      "(id, customer_id, request_kind, jurisdiction, scope, status, " +
      " requested_by, requested_at, reason) " +
      "VALUES (?1, ?2, 'deletion', ?3, NULL, 'received', ?4, ?5, ?6)",
      [id, customerId, jurisdiction, requestedBy, ts, reason],
    );
    return await getRequest(id);
  }

  // ---- getRequest / listRequests -------------------------------------

  async function getRequest(requestId) {
    _uuid(requestId, "request_id");
    var r = (await query(
      "SELECT * FROM compliance_requests WHERE id = ?1 LIMIT 1",
      [requestId],
    )).rows[0];
    return _hydrate(r);
  }

  async function listRequests(listOpts) {
    listOpts = listOpts || {};
    var status = null;
    if (listOpts.status != null) status = _status(listOpts.status, "status filter");
    var jurisdiction = null;
    if (listOpts.jurisdiction != null) jurisdiction = _jurisdiction(listOpts.jurisdiction);
    var limit = _limit(listOpts.limit);

    var sql = "SELECT * FROM compliance_requests";
    var clauses = [];
    var params  = [];
    var i = 1;
    if (status != null)       { clauses.push("status = ?" + i);       params.push(status);       i += 1; }
    if (jurisdiction != null) { clauses.push("jurisdiction = ?" + i); params.push(jurisdiction); i += 1; }
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY requested_at DESC, id DESC LIMIT ?" + i;
    params.push(limit);

    var rows = (await query(sql, params)).rows;
    var out  = [];
    for (var j = 0; j < rows.length; j += 1) out.push(_hydrate(rows[j]));
    return out;
  }

  // ---- fulfillRequest (export) ---------------------------------------

  // Walks the scope's section list, calling each injected reader's
  // `forCustomerExport(customer_id)` method. A reader that's not
  // injected, or doesn't implement the method, is reported in the
  // bundle's `sections_absent` array — the consumer can see exactly
  // which domains were available at fulfillment time so a downstream
  // audit knows the bundle isn't surreptitiously incomplete.
  async function fulfillRequest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("complianceExport.fulfillRequest: input object required");
    }
    var requestId = _uuid(input.request_id, "request_id");
    var row = await getRequest(requestId);
    if (!row) {
      throw new TypeError("complianceExport.fulfillRequest: request " + JSON.stringify(requestId) + " not found");
    }
    if (row.request_kind !== "export") {
      throw new TypeError("complianceExport.fulfillRequest: request " + JSON.stringify(requestId) +
        " is " + JSON.stringify(row.request_kind) + " — use processDeletion for deletion requests");
    }
    if (row.status !== "received" && row.status !== "processing") {
      throw new TypeError("complianceExport.fulfillRequest: request " + JSON.stringify(requestId) +
        " is in status " + JSON.stringify(row.status) + " — fulfillment requires received or processing");
    }

    // Flip received -> processing first so a concurrent caller can
    // see the fulfillment is in flight. We don't gate on a CAS here
    // (the test in-memory adapter doesn't expose one) — the
    // operator's external queue is the single-flight coordinator.
    if (row.status === "received") {
      await query(
        "UPDATE compliance_requests SET status = 'processing' WHERE id = ?1",
        [requestId],
      );
    }

    var sections        = SCOPE_SECTIONS[row.scope] || SCOPE_SECTIONS.full;
    var bundle          = {};
    var sectionsPresent = [];
    var sectionsAbsent  = [];
    // Per-section completeness manifest. Every scope section lands here
    // with an explicit status — "exported" (reader wired + returned
    // data), "empty" (reader wired but the customer has no rows here),
    // or "absent" (no reader wired at fulfillment time). An auditor (or
    // the data subject) reads this to confirm the bundle isn't
    // surreptitiously incomplete: an unexported table is visible as
    // `absent`, never silently dropped.
    var manifest = [];

    for (var s = 0; s < sections.length; s += 1) {
      var sectionName = sections[s];
      var reader      = injectedReaders[sectionName];
      if (!reader || typeof reader.forCustomerExport !== "function") {
        sectionsAbsent.push(sectionName);
        manifest.push({ section: sectionName, status: "absent" });
        continue;
      }
      // The reader returns whatever shape it owns (array of rows,
      // single object, nested structure). The bundle assembler
      // doesn't reshape it — the per-domain primitive is the
      // authoritative author of its own export shape.
      var section = await reader.forCustomerExport(row.customer_id);
      bundle[sectionName] = section == null ? null : section;
      sectionsPresent.push(sectionName);
      manifest.push({ section: sectionName, status: _isEmptySection(section) ? "empty" : "exported" });
    }

    var fulfilledAt = _now();
    await query(
      "UPDATE compliance_requests SET status = 'fulfilled', fulfilled_at = ?1 WHERE id = ?2",
      [fulfilledAt, requestId],
    );

    return {
      request_id:       requestId,
      customer_id:      row.customer_id,
      jurisdiction:     row.jurisdiction,
      scope:            row.scope,
      fulfilled_at:     fulfilledAt,
      sections_present: sectionsPresent,
      sections_absent:  sectionsAbsent,
      manifest:         manifest,
      data:             bundle,
    };
  }

  // ---- dispatchExport ------------------------------------------------

  async function dispatchExport(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("complianceExport.dispatchExport: input object required");
    }
    var requestId       = _uuid(input.request_id, "request_id");
    var deliveryMethod  = _deliveryMethod(input.delivery_method);
    var deliveryAddress = _deliveryAddress(input.delivery_address);

    var row = await getRequest(requestId);
    if (!row) {
      throw new TypeError("complianceExport.dispatchExport: request " + JSON.stringify(requestId) + " not found");
    }
    if (row.request_kind !== "export") {
      throw new TypeError("complianceExport.dispatchExport: request " + JSON.stringify(requestId) +
        " is " + JSON.stringify(row.request_kind) + " — only export requests can be dispatched");
    }
    if (row.status !== "fulfilled") {
      throw new TypeError("complianceExport.dispatchExport: request " + JSON.stringify(requestId) +
        " is in status " + JSON.stringify(row.status) + " — dispatch requires fulfilled");
    }
    var ts = _now();
    await query(
      "UPDATE compliance_requests SET status = 'delivered', delivered_at = ?1, " +
      "delivery_method = ?2, delivery_address = ?3 WHERE id = ?4",
      [ts, deliveryMethod, deliveryAddress, requestId],
    );
    return await getRequest(requestId);
  }

  // ---- processDeletion -----------------------------------------------

  // Walks every injected reader that exposes `forCustomerDeletion`.
  // Each handler returns `{ table, deleted: <integer> }` describing
  // the per-domain effect. `dry_run: true` (operator preview) calls
  // each reader's `forCustomerDeletionPreview(customer_id)` method
  // if present — otherwise the handler is asked to count without
  // deleting via a `forCustomerDeletion(customer_id, { dry_run: true })`
  // hint. The primitive's contract: a reader that supports deletion
  // MUST honor `dry_run` (no side effects when set) — refusing is the
  // primitive's only safety net against an operator who clicked
  // "preview" and got an irreversible erasure.
  async function processDeletion(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("complianceExport.processDeletion: input object required");
    }
    var requestId = _uuid(input.request_id, "request_id");
    var dryRun = false;
    if (input.dry_run != null) {
      if (typeof input.dry_run !== "boolean") {
        throw new TypeError("complianceExport.processDeletion: dry_run must be a boolean when provided");
      }
      dryRun = input.dry_run;
    }
    var row = await getRequest(requestId);
    if (!row) {
      throw new TypeError("complianceExport.processDeletion: request " + JSON.stringify(requestId) + " not found");
    }
    if (row.request_kind !== "deletion") {
      throw new TypeError("complianceExport.processDeletion: request " + JSON.stringify(requestId) +
        " is " + JSON.stringify(row.request_kind) + " — use fulfillRequest for export requests");
    }
    if (row.status !== "received" && row.status !== "processing") {
      throw new TypeError("complianceExport.processDeletion: request " + JSON.stringify(requestId) +
        " is in status " + JSON.stringify(row.status) + " — deletion requires received or processing");
    }

    // Flip received -> processing for the wet-run path; dry-runs
    // never mutate the lifecycle row (they're preview-only).
    if (!dryRun && row.status === "received") {
      await query(
        "UPDATE compliance_requests SET status = 'processing' WHERE id = ?1",
        [requestId],
      );
    }

    var domainOrder = [
      "recentlyViewed", "wishlist", "saveForLater", "suggestionBox",
      "surveys", "reviews", "consentLedger",
      "supportTickets", "orderNotes", "order", "subscriptions",
      "paymentMethods", "loyalty", "storeCredit", "addresses", "customers",
    ];
    var perDomain     = [];
    var domainsAbsent = [];

    for (var i = 0; i < domainOrder.length; i += 1) {
      var name   = domainOrder[i];
      var reader = injectedReaders[name];
      if (!reader || typeof reader.forCustomerDeletion !== "function") {
        domainsAbsent.push(name);
        continue;
      }
      var effect = await reader.forCustomerDeletion(row.customer_id, { dry_run: dryRun });
      if (!effect || typeof effect !== "object") {
        throw new TypeError("complianceExport.processDeletion: reader " + JSON.stringify(name) +
          ".forCustomerDeletion returned non-object — must return { table, deleted }");
      }
      perDomain.push({
        domain:  name,
        table:   effect.table  == null ? name : effect.table,
        deleted: effect.deleted == null ? 0    : Number(effect.deleted),
      });
    }

    if (!dryRun) {
      var ts = _now();
      await query(
        "UPDATE compliance_requests SET status = 'fulfilled', fulfilled_at = ?1 WHERE id = ?2",
        [ts, requestId],
      );
    }

    return {
      request_id:      requestId,
      customer_id:     row.customer_id,
      dry_run:         dryRun,
      domains:         perDomain,
      domains_absent:  domainsAbsent,
      total_affected:  perDomain.reduce(function (acc, d) { return acc + d.deleted; }, 0),
    };
  }

  // ---- dismissRequest ------------------------------------------------

  async function dismissRequest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("complianceExport.dismissRequest: input object required");
    }
    var requestId     = _uuid(input.request_id, "request_id");
    var dismissReason = _prose(input.dismiss_reason, "dismiss_reason", MAX_DISMISS_REASON_LEN);
    var row = await getRequest(requestId);
    if (!row) {
      throw new TypeError("complianceExport.dismissRequest: request " + JSON.stringify(requestId) + " not found");
    }
    // Refuse dismiss of an already-delivered export — operators
    // wanting to "retract" a delivered bundle file a separate
    // incident; dismiss is for not-yet-fulfilled flows.
    if (row.status === "delivered" || row.status === "dismissed") {
      throw new TypeError("complianceExport.dismissRequest: request " + JSON.stringify(requestId) +
        " is in terminal status " + JSON.stringify(row.status) + " — dismiss refused");
    }
    await query(
      "UPDATE compliance_requests SET status = 'dismissed', dismiss_reason = ?1 WHERE id = ?2",
      [dismissReason, requestId],
    );
    return await getRequest(requestId);
  }

  // ---- auditForCustomer ----------------------------------------------

  async function auditForCustomer(customerId) {
    var cid = _uuid(customerId, "customer_id");
    var rows = (await query(
      "SELECT * FROM compliance_requests WHERE customer_id = ?1 " +
      "ORDER BY requested_at DESC, id DESC LIMIT ?2",
      [cid, MAX_LIST_LIMIT],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrate(rows[i]));
    return out;
  }

  return {
    requestExport:     requestExport,
    requestDeletion:   requestDeletion,
    getRequest:        getRequest,
    listRequests:      listRequests,
    fulfillRequest:    fulfillRequest,
    dispatchExport:    dispatchExport,
    processDeletion:   processDeletion,
    dismissRequest:    dismissRequest,
    auditForCustomer:  auditForCustomer,
  };
}

module.exports = {
  create:               create,
  REQUEST_KINDS:        REQUEST_KINDS,
  JURISDICTIONS:        JURISDICTIONS,
  SCOPES:               SCOPES,
  STATUSES:             STATUSES,
  SCOPE_SECTIONS:       SCOPE_SECTIONS,
  // DSR statutory response-window registry + the per-request deadline
  // calculator (the console reads the calculator's `due_by`; tests pin the
  // per-jurisdiction windows).
  DSR_RESPONSE_WINDOW:  DSR_RESPONSE_WINDOW,
  statutoryDeadline:    _statutoryDeadline,
};
