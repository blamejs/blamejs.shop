"use strict";
/**
 * @module shop.refundPolicy
 * @title  Refund-policy primitive — operator-authored eligibility rules
 *         that decide whether a refund request qualifies BEFORE the RMA
 *         workflow opens.
 *
 * @intro
 *   A refund-policy row answers one question:
 *
 *     "A customer is requesting a refund on order O. Given the order's
 *      lines, the customer's status, the calendar gap between purchase
 *      and request, and whether the customer presented a receipt —
 *      does one of my active policies say yes, and if so what shape of
 *      refund is on the table?"
 *
 *   Distinct from `returns` (which owns the RMA finite-state machine
 *   once a refund has been accepted as eligible) and from `payment`
 *   (which executes the money movement once an RMA reaches `refund`).
 *   The refund-policy primitive is the upstream gate that says yes or
 *   no, and — when yes — names the policy that governs, the kind of
 *   refund permitted, the cap, and the restocking fee.
 *
 *   Surface:
 *
 *     - `definePolicy({ slug, title, applies_to, refund_window_days,
 *                       exclusions?, refund_kind, partial_refund_bps?,
 *                       restocking_fee_minor?, requires_receipt,
 *                       customer_status_in?, priority? })`
 *         Create a new policy. `applies_to` is one of
 *         `all` / `category` / `vendor` / `sku` / `tag`.
 *         `refund_kind` is one of `full` / `partial` /
 *         `store_credit_only` / `no_refund`. `partial` requires
 *         `partial_refund_bps` in [1, 9999]; the other kinds refuse
 *         it. `requires_receipt` is a boolean. `exclusions` is an
 *         object of optional arrays
 *         `{ categories?, vendors?, skus?, tags? }`; entries are
 *         tight-format strings.
 *
 *     - `evaluate({ order_id, order_total_minor, line_categories,
 *                   line_vendors, line_skus, line_tags, customer_id?,
 *                   customer_status?, order_date, request_date,
 *                   has_receipt })`
 *         Walks active policies in (priority DESC, created_at ASC,
 *         slug ASC) order. Returns
 *         `{ eligible: bool, applied_policy?: slug, refund_kind,
 *            max_refund_minor, restocking_fee_minor, reasons: [...] }`.
 *         When no policy applies, returns
 *         `{ eligible: false, refund_kind: 'no_refund',
 *            max_refund_minor: 0, restocking_fee_minor: 0,
 *            reasons: ['no_policy_matched'] }` — the conservative
 *         default is "we don't refund unless an operator authored a
 *         policy that says we do."
 *
 *     - `auditEvaluation({ order_id, evaluation, verdict })`
 *         Records the evaluation receipt to `refund_policy_audit`.
 *         The caller composes `evaluate` + `auditEvaluation` so the
 *         primitive doesn't double-write when an integrator wants a
 *         dry-run preview. Receipts are append-only by convention.
 *
 *     - `getPolicy(slug)` / `listPolicies({ active_only?, limit? })` /
 *       `updatePolicy(slug, patch)` / `archivePolicy(slug)` /
 *       `listAudit({ order_id, limit? })`.
 *
 *   Storage:
 *     - `refund_policies` + `refund_policy_audit` (migration
 *       `0090_refund_policy.sql`).
 *
 * @primitive refundPolicy
 * @related    returns, payment, operatorAuditLog
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN          = 80;
var MAX_TITLE_LEN         = 200;
var MAX_EXCLUSION_ENTRIES = 256;
var MAX_EXCLUSION_LEN     = 128;
var MAX_STATUS_ENTRIES    = 32;
var MAX_STATUS_LEN        = 64;
var MAX_WINDOW_DAYS       = 36500;          // ~100 years; refuses absurd values
var MAX_PRIORITY          = 1000000;
var MAX_LIST_LIMIT        = 200;
var b = require("./vendor/blamejs");
var MS_PER_DAY            = b.constants.TIME.days(1);

// Slug shape matches coupon-stacking / promo-banners / customer-segments
// convention — alnum + hyphen + underscore + dot, leading char alnum,
// capped length.
var SLUG_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// Exclusion entries are operator-author SKU / category / vendor / tag
// strings; tight enough to refuse control bytes + whitespace, loose
// enough to admit the shapes the catalog / order primitives emit.
var EXCLUSION_RE     = /^[A-Za-z0-9][A-Za-z0-9._\-:/]{0,127}$/;
var STATUS_RE        = /^[a-z0-9][a-z0-9_-]{0,63}$/;

var APPLIES_TO       = Object.freeze(["all", "category", "vendor", "sku", "tag"]);
var REFUND_KINDS     = Object.freeze(["full", "partial", "store_credit_only", "no_refund"]);
var AUDIT_DECISIONS  = Object.freeze(["eligible", "denied", "no_policy"]);

var EXCLUSION_AXES   = Object.freeze(["categories", "vendors", "skus", "tags"]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "applies_to",
  "refund_window_days",
  "exclusions",
  "refund_kind",
  "partial_refund_bps",
  "restocking_fee_minor",
  "requires_receipt",
  "customer_status_in",
  "active",
  "priority",
]);

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("refundPolicy: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("refundPolicy: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("refundPolicy: title must not contain control bytes");
  }
  return s;
}

function _appliesTo(s) {
  if (typeof s !== "string" || APPLIES_TO.indexOf(s) === -1) {
    throw new TypeError("refundPolicy: applies_to must be one of " + APPLIES_TO.join(", "));
  }
  return s;
}

function _refundKind(s) {
  if (typeof s !== "string" || REFUND_KINDS.indexOf(s) === -1) {
    throw new TypeError("refundPolicy: refund_kind must be one of " + REFUND_KINDS.join(", "));
  }
  return s;
}

function _windowDays(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_WINDOW_DAYS) {
    throw new TypeError("refundPolicy: refund_window_days must be an integer in [0, " + MAX_WINDOW_DAYS + "]");
  }
  return n;
}

function _bps(n) {
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    throw new TypeError("refundPolicy: partial_refund_bps must be an integer in [1, 9999] (use refund_kind 'full' for 100% and 'no_refund' for 0%)");
  }
  return n;
}

function _restockingFee(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("refundPolicy: restocking_fee_minor must be a non-negative integer");
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("refundPolicy: " + label + " must be a boolean");
  }
  return v;
}

function _priority(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) {
    throw new TypeError("refundPolicy: priority must be an integer in [0, " + MAX_PRIORITY + "]");
  }
  return n;
}

function _exclusionEntry(s, axisLabel) {
  if (typeof s !== "string" || !EXCLUSION_RE.test(s)) {
    throw new TypeError("refundPolicy: exclusions." + axisLabel + " entries must match /^[A-Za-z0-9][A-Za-z0-9._\\-:/]*$/ (<= " + MAX_EXCLUSION_LEN + " chars)");
  }
  return s;
}

function _exclusionAxis(arr, axisLabel) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("refundPolicy: exclusions." + axisLabel + " must be an array of strings");
  }
  if (arr.length > MAX_EXCLUSION_ENTRIES) {
    throw new TypeError("refundPolicy: exclusions." + axisLabel + " length " + arr.length + " exceeds cap " + MAX_EXCLUSION_ENTRIES);
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var v = _exclusionEntry(arr[i], axisLabel);
    if (seen[v]) {
      throw new TypeError("refundPolicy: exclusions." + axisLabel + " contains duplicate " + JSON.stringify(v));
    }
    seen[v] = true;
    out.push(v);
  }
  return out;
}

function _exclusions(v) {
  if (v == null) return { categories: [], vendors: [], skus: [], tags: [] };
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("refundPolicy: exclusions must be an object with optional axes " + EXCLUSION_AXES.join(", "));
  }
  var keys = Object.keys(v);
  for (var i = 0; i < keys.length; i += 1) {
    if (EXCLUSION_AXES.indexOf(keys[i]) === -1) {
      throw new TypeError("refundPolicy: exclusions unknown axis " + JSON.stringify(keys[i]) +
                          " (allowed: " + JSON.stringify(EXCLUSION_AXES) + ")");
    }
  }
  return {
    categories: _exclusionAxis(v.categories, "categories"),
    vendors:    _exclusionAxis(v.vendors,    "vendors"),
    skus:       _exclusionAxis(v.skus,       "skus"),
    tags:       _exclusionAxis(v.tags,       "tags"),
  };
}

function _statusEntry(s) {
  if (typeof s !== "string" || !STATUS_RE.test(s)) {
    throw new TypeError("refundPolicy: customer_status_in entries must match /^[a-z0-9][a-z0-9_-]*$/ (<= " + MAX_STATUS_LEN + " chars)");
  }
  return s;
}

function _customerStatusIn(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    throw new TypeError("refundPolicy: customer_status_in must be an array of status strings");
  }
  if (v.length > MAX_STATUS_ENTRIES) {
    throw new TypeError("refundPolicy: customer_status_in length " + v.length + " exceeds cap " + MAX_STATUS_ENTRIES);
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < v.length; i += 1) {
    var s = _statusEntry(v[i]);
    if (seen[s]) {
      throw new TypeError("refundPolicy: customer_status_in contains duplicate " + JSON.stringify(s));
    }
    seen[s] = true;
    out.push(s);
  }
  return out;
}

// Refund-kind / partial_refund_bps cross-check. `partial` requires the
// bps; every other kind refuses it. Centralised so definePolicy and
// updatePolicy share the same gate.
function _crossCheckRefundKind(kind, bps) {
  if (kind === "partial") {
    if (bps == null) {
      throw new TypeError("refundPolicy: refund_kind 'partial' requires partial_refund_bps");
    }
    return _bps(bps);
  }
  if (bps != null) {
    throw new TypeError("refundPolicy: partial_refund_bps is only valid when refund_kind is 'partial'");
  }
  return null;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _safeParseObject(s, fallback) {
  if (s == null) return fallback;
  try {
    var parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch (_e) {
    return fallback;
  }
}

function _safeParseArray(s) {
  if (s == null) return [];
  try {
    var parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (_e) {
    return [];
  }
}

function _hydrateRow(r) {
  if (!r) return null;
  var excRaw = _safeParseObject(r.exclusions_json, {});
  return {
    slug:                  r.slug,
    title:                 r.title,
    applies_to:            r.applies_to,
    refund_window_days:    Number(r.refund_window_days),
    exclusions: {
      categories: Array.isArray(excRaw.categories) ? excRaw.categories : [],
      vendors:    Array.isArray(excRaw.vendors)    ? excRaw.vendors    : [],
      skus:       Array.isArray(excRaw.skus)       ? excRaw.skus       : [],
      tags:       Array.isArray(excRaw.tags)       ? excRaw.tags       : [],
    },
    refund_kind:           r.refund_kind,
    partial_refund_bps:    r.partial_refund_bps == null ? null : Number(r.partial_refund_bps),
    restocking_fee_minor:  Number(r.restocking_fee_minor),
    requires_receipt:      r.requires_receipt === 1 || r.requires_receipt === true,
    customer_status_in:    _safeParseArray(r.customer_status_in_json),
    active:                r.active === 1 || r.active === true,
    priority:              Number(r.priority),
    archived_at:           r.archived_at == null ? null : Number(r.archived_at),
    created_at:            Number(r.created_at),
    updated_at:            Number(r.updated_at),
  };
}

// ---- evaluate input readers --------------------------------------------

function _readStringArray(arr, label) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("refundPolicy.evaluate: " + label + " must be an array of strings when provided");
  }
  for (var i = 0; i < arr.length; i += 1) {
    if (typeof arr[i] !== "string") {
      throw new TypeError("refundPolicy.evaluate: " + label + "[" + i + "] must be a string");
    }
  }
  return arr;
}

function _readEpoch(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("refundPolicy.evaluate: " + label + " must be a positive integer epoch-ms");
  }
  return n;
}

// Calendar-day delta between two epoch-ms timestamps, computed against
// UTC midnight boundaries so a request made one second after midnight
// on day N+W is exactly W days from a purchase made one second before
// midnight on day N. This matches the operator-intuitive "days
// since" semantics; a wall-clock millisecond delta would surface
// boundary surprises around timezone-naive operator inputs.
function _calendarDaysBetween(fromMs, toMs) {
  var fromMidnight = Math.floor(fromMs / MS_PER_DAY);
  var toMidnight   = Math.floor(toMs / MS_PER_DAY);
  return toMidnight - fromMidnight;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // ---- definePolicy --------------------------------------------------

  async function definePolicy(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundPolicy.definePolicy: input object required");
    }
    var slug              = _slug(input.slug);
    var title             = _title(input.title);
    var appliesTo         = _appliesTo(input.applies_to);
    var refundWindowDays  = _windowDays(input.refund_window_days);
    var exclusions        = _exclusions(input.exclusions);
    var refundKind        = _refundKind(input.refund_kind);
    var partialBps        = _crossCheckRefundKind(refundKind, input.partial_refund_bps);
    var restockingFee     = input.restocking_fee_minor == null ? 0 : _restockingFee(input.restocking_fee_minor);
    var requiresReceipt   = _bool(input.requires_receipt, "requires_receipt");
    var customerStatusIn  = _customerStatusIn(input.customer_status_in);
    var priority          = input.priority == null ? 0 : _priority(input.priority);

    // Refuse redefine — same posture as coupon-stacking. Operators
    // mutate an existing slug through updatePolicy; a blind INSERT
    // would clobber created_at and is rarely what the operator wants.
    var existing = (await query(
      "SELECT slug FROM refund_policies WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("refundPolicy.definePolicy: slug " + JSON.stringify(slug) + " already exists - use updatePolicy");
    }

    var ts = _now();
    await query(
      "INSERT INTO refund_policies (slug, title, applies_to, refund_window_days, exclusions_json, " +
      "refund_kind, partial_refund_bps, restocking_fee_minor, requires_receipt, " +
      "customer_status_in_json, active, priority, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, NULL, ?12, ?12)",
      [
        slug,
        title,
        appliesTo,
        refundWindowDays,
        JSON.stringify(exclusions),
        refundKind,
        partialBps,
        restockingFee,
        requiresReceipt ? 1 : 0,
        JSON.stringify(customerStatusIn),
        priority,
        ts,
      ],
    );
    return await getPolicy(slug);
  }

  // ---- getPolicy / listPolicies --------------------------------------

  async function getPolicy(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM refund_policies WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function listPolicies(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("refundPolicy.listPolicies: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("refundPolicy.listPolicies: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql, params;
    if (activeOnly) {
      sql    = "SELECT * FROM refund_policies WHERE active = 1 AND archived_at IS NULL " +
               "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql    = "SELECT * FROM refund_policies " +
               "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRow(rows[i]));
    return out;
  }

  // ---- updatePolicy --------------------------------------------------

  async function updatePolicy(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("refundPolicy.updatePolicy: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("refundPolicy.updatePolicy: patch must include at least one column");
    }
    var current = await getPolicy(slug);
    if (!current) {
      throw new TypeError("refundPolicy.updatePolicy: slug " + JSON.stringify(slug) + " not found");
    }

    // refund_kind + partial_refund_bps cross-check requires both
    // post-patch values together. Resolve the prospective end state
    // first so a patch that mutates only one of the two doesn't drift
    // into an inconsistent shape.
    var nextKind = Object.prototype.hasOwnProperty.call(patch, "refund_kind")
      ? _refundKind(patch.refund_kind) : current.refund_kind;
    var nextBpsRaw = Object.prototype.hasOwnProperty.call(patch, "partial_refund_bps")
      ? patch.partial_refund_bps : current.partial_refund_bps;
    var resolvedBps = _crossCheckRefundKind(nextKind, nextBpsRaw);

    var sets   = [];
    var params = [];
    var idx    = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("refundPolicy.updatePolicy: unsupported column " + JSON.stringify(col));
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
      } else if (col === "applies_to") {
        sets.push("applies_to = ?" + idx);
        params.push(_appliesTo(patch[col]));
      } else if (col === "refund_window_days") {
        sets.push("refund_window_days = ?" + idx);
        params.push(_windowDays(patch[col]));
      } else if (col === "exclusions") {
        sets.push("exclusions_json = ?" + idx);
        params.push(JSON.stringify(_exclusions(patch[col])));
      } else if (col === "refund_kind") {
        sets.push("refund_kind = ?" + idx);
        params.push(nextKind);
      } else if (col === "partial_refund_bps") {
        sets.push("partial_refund_bps = ?" + idx);
        params.push(resolvedBps);
      } else if (col === "restocking_fee_minor") {
        sets.push("restocking_fee_minor = ?" + idx);
        params.push(_restockingFee(patch[col]));
      } else if (col === "requires_receipt") {
        sets.push("requires_receipt = ?" + idx);
        params.push(_bool(patch[col], "requires_receipt") ? 1 : 0);
      } else if (col === "customer_status_in") {
        sets.push("customer_status_in_json = ?" + idx);
        params.push(JSON.stringify(_customerStatusIn(patch[col])));
      } else if (col === "active") {
        sets.push("active = ?" + idx);
        params.push(_bool(patch[col], "active") ? 1 : 0);
      } else /* priority */ {
        sets.push("priority = ?" + idx);
        params.push(_priority(patch[col]));
      }
      idx += 1;
    }

    // If refund_kind changed but partial_refund_bps wasn't in the patch,
    // the SQL above hasn't reset the bps column to the resolved value
    // — force the write so a kind change from 'partial' to 'full'
    // clears the now-orphaned bps, and a change from 'full' to
    // 'partial' surfaces the explicit-bps requirement.
    var patchHasKind = Object.prototype.hasOwnProperty.call(patch, "refund_kind");
    var patchHasBps  = Object.prototype.hasOwnProperty.call(patch, "partial_refund_bps");
    if (patchHasKind && !patchHasBps) {
      sets.push("partial_refund_bps = ?" + idx);
      params.push(resolvedBps);
      idx += 1;
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE refund_policies SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("refundPolicy.updatePolicy: slug " + JSON.stringify(slug) + " not found");
    }
    return await getPolicy(slug);
  }

  // ---- archivePolicy -------------------------------------------------

  async function archivePolicy(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE refund_policies SET archived_at = ?1, active = 0, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getPolicy(slug);
      if (!existing) {
        throw new TypeError("refundPolicy.archivePolicy: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — return existing row idempotently so an
      // "archive sweep" doesn't have to special-case a slug a coworker
      // archived first.
      return existing;
    }
    return await getPolicy(slug);
  }

  // ---- evaluate ------------------------------------------------------

  // Walks active, non-archived policies in (priority DESC, created_at
  // ASC, slug ASC) order, applying each policy's preconditions
  // (customer_status_in, refund_window_days, requires_receipt) and
  // scope gate (applies_to + exclusions). The first policy that
  // accepts the request governs the verdict.
  //
  // Returns `{ eligible, applied_policy?, refund_kind,
  //            max_refund_minor, restocking_fee_minor, reasons }`.
  //
  // `reasons` always carries at least one entry — successful
  // evaluations report `policy_matched` plus any soft-warnings (e.g.
  // `restocking_fee_applied`); refusals report every gate that
  // rejected the request from the highest-priority candidate (or
  // `no_policy_matched` when no policy was active).
  async function evaluate(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundPolicy.evaluate: input object required");
    }
    if (typeof input.order_id !== "string" || !input.order_id.length) {
      throw new TypeError("refundPolicy.evaluate: order_id must be a non-empty string");
    }
    if (!Number.isInteger(input.order_total_minor) || input.order_total_minor < 0) {
      throw new TypeError("refundPolicy.evaluate: order_total_minor must be a non-negative integer");
    }
    var lineCategories = _readStringArray(input.line_categories, "line_categories");
    var lineVendors    = _readStringArray(input.line_vendors,    "line_vendors");
    var lineSkus       = _readStringArray(input.line_skus,       "line_skus");
    var lineTags       = _readStringArray(input.line_tags,       "line_tags");
    var orderDate      = _readEpoch(input.order_date,   "order_date");
    var requestDate    = _readEpoch(input.request_date, "request_date");
    if (requestDate < orderDate) {
      throw new TypeError("refundPolicy.evaluate: request_date must be >= order_date");
    }
    if (typeof input.has_receipt !== "boolean") {
      throw new TypeError("refundPolicy.evaluate: has_receipt must be a boolean");
    }
    var customerStatus = null;
    if (input.customer_status != null) {
      if (typeof input.customer_status !== "string" || !input.customer_status.length) {
        throw new TypeError("refundPolicy.evaluate: customer_status must be a non-empty string when provided");
      }
      customerStatus = input.customer_status;
    }
    if (input.customer_id != null) {
      if (typeof input.customer_id !== "string" || !input.customer_id.length) {
        throw new TypeError("refundPolicy.evaluate: customer_id must be a non-empty string when provided");
      }
    }

    var daysSincePurchase = _calendarDaysBetween(orderDate, requestDate);

    var rows = (await query(
      "SELECT * FROM refund_policies WHERE active = 1 AND archived_at IS NULL " +
      "ORDER BY priority DESC, created_at ASC, slug ASC",
      [],
    )).rows;

    // No policies active — conservative default.
    if (rows.length === 0) {
      return {
        eligible:             false,
        applied_policy:       null,
        refund_kind:          "no_refund",
        max_refund_minor:     0,
        restocking_fee_minor: 0,
        reasons:              ["no_policy_matched"],
      };
    }

    // Walk policies. Track the first policy whose `applies_to` scope
    // matches; that policy's refusal reasons are the verdict reasons
    // when no policy accepts. A policy whose scope doesn't match the
    // order at all is silently skipped (it's authored for a
    // different lane).
    var firstCandidate = null;
    var firstReasons   = null;

    for (var i = 0; i < rows.length; i += 1) {
      var p = _hydrateRow(rows[i]);

      // Scope gate. `applies_to: all` matches every order; the other
      // four axes require at least one line whose attribute is NOT
      // in the matching exclusion list (i.e. there's something
      // refundable left after exclusions collapse the line set).
      var scopeOk = false;
      var refundableCount;
      if (p.applies_to === "all") {
        // The "all" lane still respects the four exclusion axes —
        // the operator may author a policy that scopes to "all
        // orders" but excludes a specific category.
        refundableCount = _countRefundableLines(
          lineCategories, lineVendors, lineSkus, lineTags, p.exclusions,
        );
        scopeOk = true;                                   // policy is in scope; exclusions may still drop every line
      } else if (p.applies_to === "category") {
        scopeOk = _anyLineMatchesAxis(lineCategories, p.exclusions.categories) !== "all_excluded"
               && lineCategories.length > 0;
        refundableCount = _countRefundableLines(
          lineCategories, lineVendors, lineSkus, lineTags, p.exclusions,
        );
      } else if (p.applies_to === "vendor") {
        scopeOk = _anyLineMatchesAxis(lineVendors, p.exclusions.vendors) !== "all_excluded"
               && lineVendors.length > 0;
        refundableCount = _countRefundableLines(
          lineCategories, lineVendors, lineSkus, lineTags, p.exclusions,
        );
      } else if (p.applies_to === "sku") {
        scopeOk = _anyLineMatchesAxis(lineSkus, p.exclusions.skus) !== "all_excluded"
               && lineSkus.length > 0;
        refundableCount = _countRefundableLines(
          lineCategories, lineVendors, lineSkus, lineTags, p.exclusions,
        );
      } else /* tag */ {
        scopeOk = _anyLineMatchesAxis(lineTags, p.exclusions.tags) !== "all_excluded"
               && lineTags.length > 0;
        refundableCount = _countRefundableLines(
          lineCategories, lineVendors, lineSkus, lineTags, p.exclusions,
        );
      }
      if (!scopeOk) {
        // Policy scope doesn't match this order — silently skip; the
        // operator wrote this policy for a different lane.
        continue;
      }

      var reasons = [];

      if (p.customer_status_in.length > 0) {
        if (customerStatus == null || p.customer_status_in.indexOf(customerStatus) === -1) {
          reasons.push("customer_status_mismatch");
        }
      }
      if (daysSincePurchase > p.refund_window_days) {
        reasons.push("outside_refund_window");
      }
      if (p.requires_receipt && !input.has_receipt) {
        reasons.push("receipt_required");
      }
      if (refundableCount === 0) {
        reasons.push("all_lines_excluded");
      }

      if (reasons.length === 0) {
        // Policy accepts. Compute the refund shape.
        var maxRefundMinor;
        if (p.refund_kind === "full" || p.refund_kind === "store_credit_only") {
          maxRefundMinor = input.order_total_minor;
        } else if (p.refund_kind === "partial") {
          // floor(total * bps / 10000) — integer math, no float
          // drift. The bps gate (1..9999) guarantees the result is
          // strictly less than the order total.
          maxRefundMinor = Math.floor((input.order_total_minor * p.partial_refund_bps) / 10000);
        } else /* no_refund */ {
          maxRefundMinor = 0;
        }
        // Restocking fee is deducted from the cap; clamped at zero
        // so a fee larger than the cap surfaces as "no money refunded"
        // rather than a negative number.
        var afterFee = Math.max(0, maxRefundMinor - p.restocking_fee_minor);
        var acceptReasons = ["policy_matched"];
        if (p.refund_kind === "no_refund") {
          // Successful match against a `no_refund` policy is a
          // definitive negative answer; the policy applied, the
          // verdict is "no money." The caller still gets the
          // applied_policy slug so the customer-facing message can
          // cite which rule governs.
          return {
            eligible:             false,
            applied_policy:       p.slug,
            refund_kind:          "no_refund",
            max_refund_minor:     0,
            restocking_fee_minor: 0,
            reasons:              ["policy_matched", "refund_kind_no_refund"],
          };
        }
        if (p.restocking_fee_minor > 0) acceptReasons.push("restocking_fee_applied");
        return {
          eligible:             afterFee > 0,
          applied_policy:       p.slug,
          refund_kind:          p.refund_kind,
          max_refund_minor:     afterFee,
          restocking_fee_minor: p.restocking_fee_minor,
          reasons:              acceptReasons.concat(afterFee === 0 ? ["restocking_fee_exceeds_refund"] : []),
        };
      }

      if (firstCandidate == null) {
        firstCandidate = p;
        firstReasons   = reasons;
      }
      // Otherwise: a lower-priority policy might still accept the
      // request; keep walking.
    }

    // No policy accepted. Surface the highest-priority candidate's
    // refusal reasons when one was in scope; otherwise the catch-all
    // `no_policy_matched`.
    if (firstCandidate) {
      return {
        eligible:             false,
        applied_policy:       firstCandidate.slug,
        refund_kind:          "no_refund",
        max_refund_minor:     0,
        restocking_fee_minor: 0,
        reasons:              firstReasons,
      };
    }
    return {
      eligible:             false,
      applied_policy:       null,
      refund_kind:          "no_refund",
      max_refund_minor:     0,
      restocking_fee_minor: 0,
      reasons:              ["no_policy_matched"],
    };
  }

  // ---- auditEvaluation ----------------------------------------------

  // Append-only audit-log write. Caller composes evaluate +
  // auditEvaluation so a dry-run preview doesn't double-write. The
  // `decision` column is the bucketed verdict for operator dashboard
  // filters; the full evaluation payload + result lives in
  // `evaluation_json` so a compliance review reconstructs exactly
  // what the primitive knew at the time.
  async function auditEvaluation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundPolicy.auditEvaluation: input object required");
    }
    if (typeof input.order_id !== "string" || !input.order_id.length) {
      throw new TypeError("refundPolicy.auditEvaluation: order_id must be a non-empty string");
    }
    if (!input.evaluation || typeof input.evaluation !== "object") {
      throw new TypeError("refundPolicy.auditEvaluation: evaluation object required");
    }
    if (!input.verdict || typeof input.verdict !== "object") {
      throw new TypeError("refundPolicy.auditEvaluation: verdict object required");
    }
    var decision;
    if (input.verdict.eligible === true) decision = "eligible";
    else if (input.verdict.applied_policy) decision = "denied";
    else decision = "no_policy";
    if (AUDIT_DECISIONS.indexOf(decision) === -1) {
      throw new TypeError("refundPolicy.auditEvaluation: derived decision " + JSON.stringify(decision) +
                          " not in " + JSON.stringify(AUDIT_DECISIONS));
    }
    var appliedSlug = null;
    if (input.verdict.applied_policy != null) {
      appliedSlug = _slug(input.verdict.applied_policy);
    }
    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO refund_policy_audit (id, order_id, evaluation_json, decision, applied_slug, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        id,
        input.order_id,
        JSON.stringify({ evaluation: input.evaluation, verdict: input.verdict }),
        decision,
        appliedSlug,
        ts,
      ],
    );
    return { id: id, order_id: input.order_id, decision: decision, applied_slug: appliedSlug, occurred_at: ts };
  }

  async function listAudit(listOpts) {
    listOpts = listOpts || {};
    if (typeof listOpts.order_id !== "string" || !listOpts.order_id.length) {
      throw new TypeError("refundPolicy.listAudit: order_id must be a non-empty string");
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("refundPolicy.listAudit: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var rows = (await query(
      "SELECT * FROM refund_policy_audit WHERE order_id = ?1 " +
      "ORDER BY occurred_at DESC, id DESC LIMIT ?2",
      [listOpts.order_id, limit],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var payload;
      try { payload = JSON.parse(r.evaluation_json); } catch (_e) { payload = null; }
      out.push({
        id:           r.id,
        order_id:     r.order_id,
        decision:     r.decision,
        applied_slug: r.applied_slug == null ? null : r.applied_slug,
        occurred_at:  Number(r.occurred_at),
        payload:      payload,
      });
    }
    return out;
  }

  return {
    definePolicy:    definePolicy,
    getPolicy:       getPolicy,
    listPolicies:    listPolicies,
    updatePolicy:    updatePolicy,
    archivePolicy:   archivePolicy,
    evaluate:        evaluate,
    auditEvaluation: auditEvaluation,
    listAudit:       listAudit,
  };
}

// ---- scope helpers ------------------------------------------------------

// Returns "all_excluded" when every entry in `axisLines` appears in
// `excluded`; "some_match" when at least one entry survives; and a
// trivial pass-through ("no_lines") when `axisLines` is empty. The
// scope gate uses this to skip a policy whose `applies_to` axis has
// no overlap with the order at all.
function _anyLineMatchesAxis(axisLines, excluded) {
  if (!axisLines.length) return "no_lines";
  var excSet = Object.create(null);
  for (var i = 0; i < excluded.length; i += 1) excSet[excluded[i]] = true;
  for (var j = 0; j < axisLines.length; j += 1) {
    if (!excSet[axisLines[j]]) return "some_match";
  }
  return "all_excluded";
}

// Count lines that survive exclusion across all four axes. A line is
// represented by its position across the four parallel arrays (the
// evaluator treats every axis as line-positional — `line_categories[0]`,
// `line_vendors[0]`, `line_skus[0]`, `line_tags[0]` describe the same
// line). When the axes are uneven (some lines missing a tag, etc.),
// the missing slot is treated as "not excluded" — the operator who
// authors a tag-exclusion list doesn't want a missing-tag line to
// get accidentally caught by an empty-string match.
function _countRefundableLines(cats, vendors, skus, tags, exc) {
  var n = Math.max(cats.length, vendors.length, skus.length, tags.length);
  if (n === 0) return 0;
  var catsSet    = _toSet(exc.categories);
  var vendorsSet = _toSet(exc.vendors);
  var skusSet    = _toSet(exc.skus);
  var tagsSet    = _toSet(exc.tags);
  var refundable = 0;
  for (var i = 0; i < n; i += 1) {
    if (cats[i]    != null && catsSet[cats[i]])       continue;
    if (vendors[i] != null && vendorsSet[vendors[i]]) continue;
    if (skus[i]    != null && skusSet[skus[i]])       continue;
    if (tags[i]    != null && tagsSet[tags[i]])       continue;
    refundable += 1;
  }
  return refundable;
}

function _toSet(arr) {
  var s = Object.create(null);
  for (var i = 0; i < arr.length; i += 1) s[arr[i]] = true;
  return s;
}

module.exports = {
  create:                 create,
  APPLIES_TO:             APPLIES_TO,
  REFUND_KINDS:           REFUND_KINDS,
  AUDIT_DECISIONS:        AUDIT_DECISIONS,
  EXCLUSION_AXES:         EXCLUSION_AXES,
  ALLOWED_PATCH_COLUMNS:  ALLOWED_PATCH_COLUMNS,
  MAX_EXCLUSION_ENTRIES:  MAX_EXCLUSION_ENTRIES,
  MAX_STATUS_ENTRIES:     MAX_STATUS_ENTRIES,
  MAX_WINDOW_DAYS:        MAX_WINDOW_DAYS,
};
