"use strict";
/**
 * @module shop.orderEscalation
 * @title  Order escalation — operator workflow for routing orders
 *         that need manual attention.
 *
 * @intro
 *   A rule names a condition bag (any subset of total / country /
 *   prior-order count / fraud-score / refund-pending /
 *   payment-method-kind). When `evaluateOrder` is handed an order
 *   snapshot, every active rule whose entire condition bag matches
 *   fires; the caller composes `evaluateOrder` with
 *   `recordEscalation` (typically one per matched rule) so the
 *   primitive doesn't double-write when the orchestrator wants a
 *   dry-run preview.
 *
 *   On `recordEscalation`, the primitive:
 *     1. Inserts an `order_escalations` row with `status='open'`.
 *     2. Stamps every `auto_tags` entry on the order via the
 *        operator-supplied `orderTags.applyTag(order_id, tag)` stub.
 *     3. Dispatches the rule's `notification_template` through the
 *        operator-supplied `notifications.enqueue(...)` stub when
 *        both the template and the `assigned_operator` are present.
 *
 *   The 3-state FSM on the escalation row is:
 *     open  →  resolved          (resolveEscalation)
 *     open  →  false_positive    (markAsFalsePositive)
 *
 *   Re-resolving / re-flagging a non-open row is refused with
 *   `not in open state` — operators reopen by issuing a fresh
 *   escalation (this primitive is not a ticket tracker).
 *
 *   Composes:
 *     - b.guardUuid  — UUID-shape validation
 *     - b.uuid.v7    — escalation row id
 *
 *   Storage:
 *     - `order_escalation_rules` + `order_escalations`
 *       (migration `0144_order_escalation.sql`).
 *
 * @primitive orderEscalation
 * @related    fraudScreen, orderNotes, notifications
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN              = 80;
var MAX_TAG_COUNT             = 16;
var MAX_TAG_LEN               = 64;
var MAX_NOTES_LEN             = 4000;
var MAX_RESOLUTION_LEN        = 1000;
var MAX_FALSE_POSITIVE_LEN    = 1000;
var MAX_TEMPLATE_LEN          = 128;
var MAX_COUNTRY_COUNT         = 250;       // every UN country + change
var MAX_PAYMENT_KIND_COUNT    = 32;
var MAX_PAYMENT_KIND_LEN      = 32;
var MAX_LIST_LIMIT            = 200;

var SLUG_RE             = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var COUNTRY_RE          = /^[A-Z]{2}$/;
var PAYMENT_KIND_RE     = /^[a-z0-9][a-z0-9_-]{0,31}$/;
var TAG_RE              = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}$/;
var TEMPLATE_RE         = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CONTROL_BYTE_RE     = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

var SEVERITIES          = Object.freeze(["info", "warning", "critical"]);
var SEVERITY_RANK       = Object.freeze({ info: 0, warning: 1, critical: 2 });
var STATUSES            = Object.freeze(["open", "resolved", "false_positive"]);

var ALLOWED_CONDITION_KEYS = Object.freeze([
  "total_minor_min",
  "country_in",
  "prior_orders_max",
  "fraud_score_min",
  "refund_pending",
  "payment_method_kind_in",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "conditions",
  "severity",
  "assigned_operator",
  "auto_tags",
  "notification_template",
]);

var b = require("./vendor/blamejs");

// ---- monotonic clock ----------------------------------------------------
//
// Hot-path writes mint `created_at` / `updated_at` / `occurred_at` from a
// monotonically-strictly-increasing clock. Two writes inside the same
// millisecond bump the second by +1 ms so the (severity, occurred_at)
// keyset on `idx_order_escalations_open_severity` stays a strict total
// order — operator-console "newest first" never collapses two rows into
// the same tie that the SQL ORDER BY can't break.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError(
      "orderEscalation: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " +
      MAX_SLUG_LEN + " chars)"
    );
  }
  return s;
}

function _severity(s) {
  if (typeof s !== "string" || SEVERITIES.indexOf(s) === -1) {
    throw new TypeError("orderEscalation: severity must be one of " + SEVERITIES.join(", "));
  }
  return s;
}

function _uuidOrNull(v, label) {
  if (v == null) return null;
  try { return b.guardUuid.sanitize(v, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("orderEscalation: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _uuid(v, label) {
  try { return b.guardUuid.sanitize(v, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("orderEscalation: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _intMin(v, label, min) {
  if (!Number.isInteger(v) || v < min) {
    throw new TypeError(
      "orderEscalation: " + label + " must be an integer >= " + min
    );
  }
  return v;
}

function _intRange(v, label, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new TypeError(
      "orderEscalation: " + label + " must be an integer in [" + min + ", " + max + "]"
    );
  }
  return v;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("orderEscalation: " + label + " must be a boolean");
  }
  return v;
}

function _country(s) {
  if (typeof s !== "string" || !COUNTRY_RE.test(s)) {
    throw new TypeError(
      "orderEscalation: country_in entries must be ISO-3166 alpha-2 (uppercase, 2 letters)"
    );
  }
  return s;
}

function _countryIn(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError("orderEscalation: country_in must be an array of ISO-3166 alpha-2 strings");
  }
  if (!arr.length) {
    throw new TypeError("orderEscalation: country_in must be non-empty when provided");
  }
  if (arr.length > MAX_COUNTRY_COUNT) {
    throw new TypeError("orderEscalation: country_in length " + arr.length + " exceeds cap " + MAX_COUNTRY_COUNT);
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var c = _country(arr[i]);
    if (seen[c]) {
      throw new TypeError("orderEscalation: country_in contains duplicate " + JSON.stringify(c));
    }
    seen[c] = true;
    out.push(c);
  }
  return out;
}

function _paymentKind(s) {
  if (typeof s !== "string" || !PAYMENT_KIND_RE.test(s)) {
    throw new TypeError(
      "orderEscalation: payment_method_kind_in entries must match /^[a-z0-9][a-z0-9_-]*$/ (<= " +
      MAX_PAYMENT_KIND_LEN + " chars)"
    );
  }
  return s;
}

function _paymentKindIn(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError(
      "orderEscalation: payment_method_kind_in must be an array of payment-kind strings"
    );
  }
  if (!arr.length) {
    throw new TypeError("orderEscalation: payment_method_kind_in must be non-empty when provided");
  }
  if (arr.length > MAX_PAYMENT_KIND_COUNT) {
    throw new TypeError(
      "orderEscalation: payment_method_kind_in length " + arr.length +
      " exceeds cap " + MAX_PAYMENT_KIND_COUNT
    );
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var k = _paymentKind(arr[i]);
    if (seen[k]) {
      throw new TypeError("orderEscalation: payment_method_kind_in contains duplicate " + JSON.stringify(k));
    }
    seen[k] = true;
    out.push(k);
  }
  return out;
}

function _conditions(v) {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(
      "orderEscalation: conditions must be an object with optional keys " +
      ALLOWED_CONDITION_KEYS.join(", ")
    );
  }
  var keys = Object.keys(v);
  var out = {};
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (ALLOWED_CONDITION_KEYS.indexOf(k) === -1) {
      throw new TypeError(
        "orderEscalation: conditions unknown key " + JSON.stringify(k) +
        " (allowed: " + ALLOWED_CONDITION_KEYS.join(", ") + ")"
      );
    }
    if (k === "total_minor_min") {
      out[k] = _intMin(v[k], "conditions.total_minor_min", 0);
    } else if (k === "country_in") {
      out[k] = _countryIn(v[k]);
    } else if (k === "prior_orders_max") {
      out[k] = _intMin(v[k], "conditions.prior_orders_max", 0);
    } else if (k === "fraud_score_min") {
      out[k] = _intRange(v[k], "conditions.fraud_score_min", 0, 100);
    } else if (k === "refund_pending") {
      out[k] = _bool(v[k], "conditions.refund_pending");
    } else /* payment_method_kind_in */ {
      out[k] = _paymentKindIn(v[k]);
    }
  }
  if (!Object.keys(out).length) {
    throw new TypeError(
      "orderEscalation: conditions must include at least one of " +
      ALLOWED_CONDITION_KEYS.join(", ")
    );
  }
  return out;
}

function _tags(arr) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("orderEscalation: auto_tags must be an array of tag strings");
  }
  if (arr.length > MAX_TAG_COUNT) {
    throw new TypeError("orderEscalation: auto_tags length " + arr.length + " exceeds cap " + MAX_TAG_COUNT);
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var t = arr[i];
    if (typeof t !== "string" || !TAG_RE.test(t)) {
      throw new TypeError(
        "orderEscalation: auto_tags[" + i + "] must match /^[A-Za-z0-9][A-Za-z0-9._:\\-]*$/ (<= " +
        MAX_TAG_LEN + " chars)"
      );
    }
    if (seen[t]) {
      throw new TypeError("orderEscalation: auto_tags contains duplicate " + JSON.stringify(t));
    }
    seen[t] = true;
    out.push(t);
  }
  return out;
}

function _template(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !TEMPLATE_RE.test(s)) {
    throw new TypeError(
      "orderEscalation: notification_template must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " +
      MAX_TEMPLATE_LEN + " chars)"
    );
  }
  return s;
}

function _freeText(v, label, max) {
  if (v == null) return null;
  if (typeof v !== "string") {
    throw new TypeError("orderEscalation: " + label + " must be a string when provided");
  }
  if (!v.length) {
    throw new TypeError("orderEscalation: " + label + " must be non-empty when provided");
  }
  if (v.length > max) {
    throw new TypeError("orderEscalation: " + label + " must be <= " + max + " characters");
  }
  if (CONTROL_BYTE_RE.test(v)) {
    throw new TypeError("orderEscalation: " + label + " must not contain control bytes");
  }
  return v;
}

function _severityMin(s) {
  if (s == null) return null;
  _severity(s);                                      // type / enum gate
  return SEVERITY_RANK[s];
}

function _limit(n) {
  if (n == null) return 50;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("orderEscalation: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

// ---- order-snapshot readers --------------------------------------------

function _readSnapshot(snap) {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    throw new TypeError("orderEscalation.evaluateOrder: order_snapshot must be an object");
  }
  var out = {};
  if (snap.total_minor != null) {
    if (!Number.isInteger(snap.total_minor) || snap.total_minor < 0) {
      throw new TypeError("orderEscalation.evaluateOrder: order_snapshot.total_minor must be a non-negative integer");
    }
    out.total_minor = snap.total_minor;
  }
  if (snap.country != null) {
    if (typeof snap.country !== "string" || !COUNTRY_RE.test(snap.country)) {
      throw new TypeError("orderEscalation.evaluateOrder: order_snapshot.country must be ISO-3166 alpha-2");
    }
    out.country = snap.country;
  }
  if (snap.prior_orders != null) {
    if (!Number.isInteger(snap.prior_orders) || snap.prior_orders < 0) {
      throw new TypeError("orderEscalation.evaluateOrder: order_snapshot.prior_orders must be a non-negative integer");
    }
    out.prior_orders = snap.prior_orders;
  }
  if (snap.fraud_score != null) {
    if (!Number.isInteger(snap.fraud_score) || snap.fraud_score < 0 || snap.fraud_score > 100) {
      throw new TypeError("orderEscalation.evaluateOrder: order_snapshot.fraud_score must be an integer in [0, 100]");
    }
    out.fraud_score = snap.fraud_score;
  }
  if (snap.refund_pending != null) {
    if (typeof snap.refund_pending !== "boolean") {
      throw new TypeError("orderEscalation.evaluateOrder: order_snapshot.refund_pending must be a boolean");
    }
    out.refund_pending = snap.refund_pending;
  }
  if (snap.payment_method_kind != null) {
    if (typeof snap.payment_method_kind !== "string" || !PAYMENT_KIND_RE.test(snap.payment_method_kind)) {
      throw new TypeError(
        "orderEscalation.evaluateOrder: order_snapshot.payment_method_kind must match " +
        "/^[a-z0-9][a-z0-9_-]*$/"
      );
    }
    out.payment_method_kind = snap.payment_method_kind;
  }
  return out;
}

// ---- condition matching -------------------------------------------------
//
// A rule fires when every condition in its bag matches the snapshot.
// A condition that references a dimension the snapshot omits never
// matches — the orchestrator is expected to populate every dimension
// the rule set actually addresses.

function _matchesRule(conditions, snap) {
  if (Object.prototype.hasOwnProperty.call(conditions, "total_minor_min")) {
    if (snap.total_minor == null) return false;
    if (snap.total_minor < conditions.total_minor_min) return false;
  }
  if (Object.prototype.hasOwnProperty.call(conditions, "country_in")) {
    if (snap.country == null) return false;
    if (conditions.country_in.indexOf(snap.country) === -1) return false;
  }
  if (Object.prototype.hasOwnProperty.call(conditions, "prior_orders_max")) {
    if (snap.prior_orders == null) return false;
    if (snap.prior_orders > conditions.prior_orders_max) return false;
  }
  if (Object.prototype.hasOwnProperty.call(conditions, "fraud_score_min")) {
    if (snap.fraud_score == null) return false;
    if (snap.fraud_score < conditions.fraud_score_min) return false;
  }
  if (Object.prototype.hasOwnProperty.call(conditions, "refund_pending")) {
    if (snap.refund_pending == null) return false;
    if (snap.refund_pending !== conditions.refund_pending) return false;
  }
  if (Object.prototype.hasOwnProperty.call(conditions, "payment_method_kind_in")) {
    if (snap.payment_method_kind == null) return false;
    if (conditions.payment_method_kind_in.indexOf(snap.payment_method_kind) === -1) return false;
  }
  return true;
}

// ---- row hydration ------------------------------------------------------

function _safeParseObject(s, fallback) {
  if (s == null) return fallback;
  try {
    var parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch (_e) { return fallback; }
}

function _safeParseArray(s) {
  if (s == null) return [];
  try {
    var parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (_e) { return []; }
}

function _hydrateRule(r) {
  if (!r) return null;
  return {
    slug:                  r.slug,
    conditions:            _safeParseObject(r.conditions_json, {}),
    severity:              r.severity,
    assigned_operator:     r.assigned_operator == null ? null : r.assigned_operator,
    auto_tags:             _safeParseArray(r.auto_tags_json),
    notification_template: r.notification_template == null ? null : r.notification_template,
    archived_at:           r.archived_at == null ? null : Number(r.archived_at),
    created_at:            Number(r.created_at),
    updated_at:            Number(r.updated_at),
  };
}

function _hydrateEscalation(r) {
  if (!r) return null;
  return {
    id:                r.id,
    order_id:          r.order_id,
    rule_slug:         r.rule_slug,
    severity:          r.severity,
    assigned_operator: r.assigned_operator == null ? null : r.assigned_operator,
    notes:             r.notes == null ? null : r.notes,
    status:            r.status,
    resolution:        r.resolution == null ? null : r.resolution,
    resolved_at:       r.resolved_at == null ? null : Number(r.resolved_at),
    occurred_at:       Number(r.occurred_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional side-effect hooks. Both are stubs in the test path; the
  // operator wires the real `notifications` + `orderTags` primitives
  // from the framework capture in production. Missing hooks are tolerated — the
  // primitive falls back to a no-op so `recordEscalation` still
  // returns a usable row even when only the FSM state is needed.
  var notifications = opts.notifications || null;
  var orderTags     = opts.orderTags     || null;

  // ---- defineRule -----------------------------------------------------

  async function defineRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderEscalation.defineRule: input object required");
    }
    var slug              = _slug(input.slug);
    var conditions        = _conditions(input.conditions);
    var severity          = _severity(input.severity);
    var assignedOperator  = _uuidOrNull(input.assigned_operator, "assigned_operator");
    var autoTags          = _tags(input.auto_tags);
    var template          = _template(input.notification_template);

    var existing = (await query(
      "SELECT slug FROM order_escalation_rules WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError(
        "orderEscalation.defineRule: slug " + JSON.stringify(slug) +
        " already exists - use updateRule"
      );
    }

    var ts = _now();
    await query(
      "INSERT INTO order_escalation_rules " +
      "(slug, conditions_json, severity, assigned_operator, auto_tags_json, " +
      "notification_template, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
      [
        slug,
        JSON.stringify(conditions),
        severity,
        assignedOperator,
        JSON.stringify(autoTags),
        template,
        ts,
      ],
    );
    return await _getRule(slug);
  }

  async function _getRule(slug) {
    var row = (await query(
      "SELECT * FROM order_escalation_rules WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRule(row);
  }

  // ---- listRules / updateRule / archiveRule --------------------------

  async function listRules(listOpts) {
    listOpts = listOpts || {};
    var includeArchived = false;
    if (listOpts.include_archived != null) {
      includeArchived = _bool(listOpts.include_archived, "include_archived");
    }
    var limit = _limit(listOpts.limit);
    var sql, params;
    if (includeArchived) {
      sql    = "SELECT * FROM order_escalation_rules " +
               "ORDER BY archived_at IS NULL DESC, severity DESC, created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql    = "SELECT * FROM order_escalation_rules WHERE archived_at IS NULL " +
               "ORDER BY severity DESC, created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRule(rows[i]));
    return out;
  }

  async function updateRule(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("orderEscalation.updateRule: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("orderEscalation.updateRule: patch must include at least one column");
    }
    var current = await _getRule(slug);
    if (!current) {
      throw new TypeError("orderEscalation.updateRule: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("orderEscalation.updateRule: unsupported column " + JSON.stringify(col));
      }
      if (col === "conditions") {
        sets.push("conditions_json = ?" + idx);
        params.push(JSON.stringify(_conditions(patch[col])));
      } else if (col === "severity") {
        sets.push("severity = ?" + idx);
        params.push(_severity(patch[col]));
      } else if (col === "assigned_operator") {
        sets.push("assigned_operator = ?" + idx);
        params.push(_uuidOrNull(patch[col], "assigned_operator"));
      } else if (col === "auto_tags") {
        sets.push("auto_tags_json = ?" + idx);
        params.push(JSON.stringify(_tags(patch[col])));
      } else /* notification_template */ {
        sets.push("notification_template = ?" + idx);
        params.push(_template(patch[col]));
      }
      idx += 1;
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE order_escalation_rules SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("orderEscalation.updateRule: slug " + JSON.stringify(slug) + " not found");
    }
    return await _getRule(slug);
  }

  async function archiveRule(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE order_escalation_rules SET archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      // Either missing or already archived. Re-fetch to disambiguate.
      var existing = await _getRule(slug);
      if (!existing) {
        throw new TypeError("orderEscalation.archiveRule: slug " + JSON.stringify(slug) + " not found");
      }
      return existing;
    }
    return await _getRule(slug);
  }

  // ---- evaluateOrder -------------------------------------------------

  async function evaluateOrder(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderEscalation.evaluateOrder: input object required");
    }
    var orderId = _uuid(input.order_id, "order_id");
    var snap    = _readSnapshot(input.order_snapshot);

    var rows = (await query(
      "SELECT * FROM order_escalation_rules WHERE archived_at IS NULL " +
      "ORDER BY severity DESC, created_at ASC, slug ASC",
      [],
    )).rows;

    var matchedRules = [];
    var tagsApplied = [];
    var seenTags = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var rule = _hydrateRule(rows[i]);
      if (!_matchesRule(rule.conditions, snap)) continue;
      matchedRules.push(rule);
      for (var j = 0; j < rule.auto_tags.length; j += 1) {
        if (!seenTags[rule.auto_tags[j]]) {
          seenTags[rule.auto_tags[j]] = true;
          tagsApplied.push(rule.auto_tags[j]);
        }
      }
    }
    return { order_id: orderId, matched_rules: matchedRules, tags_applied: tagsApplied };
  }

  // ---- recordEscalation ----------------------------------------------

  async function recordEscalation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderEscalation.recordEscalation: input object required");
    }
    var orderId          = _uuid(input.order_id, "order_id");
    var ruleSlug         = _slug(input.rule_slug);
    var severity         = _severity(input.severity);
    var assignedOperator = _uuidOrNull(input.assigned_operator, "assigned_operator");
    var notes            = _freeText(input.notes, "notes", MAX_NOTES_LEN);

    var rule = await _getRule(ruleSlug);
    if (!rule) {
      throw new TypeError(
        "orderEscalation.recordEscalation: rule_slug " + JSON.stringify(ruleSlug) + " not found"
      );
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO order_escalations " +
      "(id, order_id, rule_slug, severity, assigned_operator, notes, status, " +
      "resolution, resolved_at, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', NULL, NULL, ?7)",
      [id, orderId, ruleSlug, severity, assignedOperator, notes, ts],
    );

    // Apply auto-tags via the operator-supplied hook. Each call is
    // wrapped so a single tag failure doesn't abort the escalation —
    // the row is the source of truth for "we noticed this order",
    // tag application is a best-effort downstream side-effect.
    var taggedApplied = [];
    var taggedFailed  = [];
    if (orderTags && typeof orderTags.applyTag === "function") {
      for (var t = 0; t < rule.auto_tags.length; t += 1) {
        var tag = rule.auto_tags[t];
        try {
          await orderTags.applyTag(orderId, tag);
          taggedApplied.push(tag);
        } catch (e) {
          taggedFailed.push({ tag: tag, error: e && e.message || "applyTag failed" });
        }
      }
    }

    // Dispatch notification — only when the rule named a template AND
    // an operator is assigned (the recipient surface this primitive
    // knows about). A template without an assignee is a no-op; the
    // operator dashboard surfaces the unassigned escalation directly
    // via `openEscalations`.
    var notified = false;
    if (notifications && typeof notifications.enqueue === "function"
        && rule.notification_template && assignedOperator) {
      try {
        await notifications.enqueue({
          recipient_id: assignedOperator,
          event_type:   "order_escalation",
          channel:      "in-app",
          template:     rule.notification_template,
          payload:      {
            escalation_id: id,
            order_id:      orderId,
            rule_slug:     ruleSlug,
            severity:      severity,
          },
        });
        notified = true;
      } catch (_eN) {
        // Surface the dispatch failure in the return shape; the
        // escalation row itself stays committed.
        notified = false;
      }
    }

    var escalation = await _getEscalation(id);
    return {
      escalation:    escalation,
      tags_applied:  taggedApplied,
      tags_failed:   taggedFailed,
      notified:      notified,
    };
  }

  async function _getEscalation(id) {
    var row = (await query(
      "SELECT * FROM order_escalations WHERE id = ?1 LIMIT 1",
      [id],
    )).rows[0];
    return _hydrateEscalation(row);
  }

  // ---- FSM transitions ----------------------------------------------

  async function resolveEscalation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderEscalation.resolveEscalation: input object required");
    }
    var id         = _uuid(input.escalation_id, "escalation_id");
    var resolution = _freeText(input.resolution, "resolution", MAX_RESOLUTION_LEN);
    if (resolution == null) {
      throw new TypeError("orderEscalation.resolveEscalation: resolution required");
    }
    var current = await _getEscalation(id);
    if (!current) {
      throw new TypeError("orderEscalation.resolveEscalation: escalation " + id + " not found");
    }
    if (current.status !== "open") {
      throw new TypeError(
        "orderEscalation.resolveEscalation: escalation " + id +
        " not in open state (current: " + current.status + ")"
      );
    }
    var ts = _now();
    await query(
      "UPDATE order_escalations SET status = 'resolved', resolution = ?1, resolved_at = ?2 " +
      "WHERE id = ?3 AND status = 'open'",
      [resolution, ts, id],
    );
    return await _getEscalation(id);
  }

  async function markAsFalsePositive(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderEscalation.markAsFalsePositive: input object required");
    }
    var id     = _uuid(input.escalation_id, "escalation_id");
    var reason = _freeText(input.reason, "reason", MAX_FALSE_POSITIVE_LEN);
    if (reason == null) {
      throw new TypeError("orderEscalation.markAsFalsePositive: reason required");
    }
    var current = await _getEscalation(id);
    if (!current) {
      throw new TypeError("orderEscalation.markAsFalsePositive: escalation " + id + " not found");
    }
    if (current.status !== "open") {
      throw new TypeError(
        "orderEscalation.markAsFalsePositive: escalation " + id +
        " not in open state (current: " + current.status + ")"
      );
    }
    var ts = _now();
    await query(
      "UPDATE order_escalations SET status = 'false_positive', resolution = ?1, resolved_at = ?2 " +
      "WHERE id = ?3 AND status = 'open'",
      [reason, ts, id],
    );
    return await _getEscalation(id);
  }

  // ---- read paths ---------------------------------------------------

  async function openEscalations(listOpts) {
    listOpts = listOpts || {};
    var operatorId   = listOpts.operator_id == null ? null : _uuid(listOpts.operator_id, "operator_id");
    var severityMin  = _severityMin(listOpts.severity_min);

    var where  = ["status = 'open'"];
    var params = [];
    var idx    = 1;
    if (operatorId != null) {
      where.push("assigned_operator = ?" + idx);
      params.push(operatorId);
      idx += 1;
    }
    // severity_min is enforced in JS rather than SQL so the
    // operator-readable enum stays the source of truth (SQLite can't
    // sort the textual severity column by the desired rank without an
    // index expression the migration would have to maintain).
    var rows = (await query(
      "SELECT * FROM order_escalations WHERE " + where.join(" AND ") +
      " ORDER BY occurred_at DESC",
      params,
    )).rows;

    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var hyd = _hydrateEscalation(rows[i]);
      if (severityMin != null && SEVERITY_RANK[hyd.severity] < severityMin) continue;
      out.push(hyd);
    }
    return out;
  }

  async function escalationsForOrder(orderId) {
    orderId = _uuid(orderId, "order_id");
    var rows = (await query(
      "SELECT * FROM order_escalations WHERE order_id = ?1 ORDER BY occurred_at DESC",
      [orderId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateEscalation(rows[i]));
    return out;
  }

  async function metricsForRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderEscalation.metricsForRule: input object required");
    }
    var slug = _slug(input.slug);
    if (!Number.isInteger(input.from) || input.from < 0) {
      throw new TypeError("orderEscalation.metricsForRule: from must be a non-negative integer epoch-ms");
    }
    if (!Number.isInteger(input.to) || input.to < input.from) {
      throw new TypeError("orderEscalation.metricsForRule: to must be a non-negative integer epoch-ms >= from");
    }
    var rows = (await query(
      "SELECT status, COUNT(*) AS n FROM order_escalations " +
      "WHERE rule_slug = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
      "GROUP BY status",
      [slug, input.from, input.to],
    )).rows;
    var counts = { open: 0, resolved: 0, false_positive: 0 };
    for (var i = 0; i < rows.length; i += 1) {
      var k = rows[i].status;
      if (counts[k] != null) counts[k] = Number(rows[i].n);
    }
    var fired   = counts.open + counts.resolved + counts.false_positive;
    var closed  = counts.resolved + counts.false_positive;
    var fpRateBps = closed === 0 ? 0 : Math.round((counts.false_positive / closed) * 10000);
    return {
      slug:              slug,
      from:              input.from,
      to:                input.to,
      fired:             fired,
      open:              counts.open,
      resolved:          counts.resolved,
      false_positive:    counts.false_positive,
      false_positive_bps: fpRateBps,
    };
  }

  return {
    SEVERITIES:                SEVERITIES.slice(),
    STATUSES:                  STATUSES.slice(),
    ALLOWED_CONDITION_KEYS:    ALLOWED_CONDITION_KEYS.slice(),
    MAX_TAG_COUNT:             MAX_TAG_COUNT,
    MAX_TAG_LEN:               MAX_TAG_LEN,
    MAX_NOTES_LEN:             MAX_NOTES_LEN,
    MAX_RESOLUTION_LEN:        MAX_RESOLUTION_LEN,
    MAX_LIST_LIMIT:            MAX_LIST_LIMIT,

    defineRule:                defineRule,
    listRules:                 listRules,
    updateRule:                updateRule,
    archiveRule:                archiveRule,
    evaluateOrder:             evaluateOrder,
    recordEscalation:          recordEscalation,
    resolveEscalation:         resolveEscalation,
    markAsFalsePositive:       markAsFalsePositive,
    openEscalations:           openEscalations,
    escalationsForOrder:       escalationsForOrder,
    metricsForRule:            metricsForRule,
  };
}

module.exports = {
  create:                    create,
  SEVERITIES:                SEVERITIES.slice(),
  STATUSES:                  STATUSES.slice(),
  ALLOWED_CONDITION_KEYS:    ALLOWED_CONDITION_KEYS.slice(),
  MAX_TAG_COUNT:             MAX_TAG_COUNT,
  MAX_TAG_LEN:               MAX_TAG_LEN,
  MAX_NOTES_LEN:             MAX_NOTES_LEN,
  MAX_RESOLUTION_LEN:        MAX_RESOLUTION_LEN,
  MAX_LIST_LIMIT:            MAX_LIST_LIMIT,
};
