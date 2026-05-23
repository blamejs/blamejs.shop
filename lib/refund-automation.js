"use strict";
/**
 * @module shop.refundAutomation
 * @title  Refund-automation primitive — auto-refund eligibility +
 *         execution rules. Composes `refundPolicy` (eligibility),
 *         `returns` (RMA), and `payment` (refund call) without
 *         owning their responsibilities.
 *
 * @intro
 *   `refundPolicy` (migration 0090) answers the upstream question
 *   "is a refund permitted at all?" — operator-authored rules that
 *   decide whether a customer-initiated refund request qualifies
 *   under the storefront's published policy. This primitive answers
 *   the narrower follow-on question: "is this specific refund
 *   request safe to issue WITHOUT operator review?"
 *
 *   When a refund request meets every auto-eligibility gate —
 *   inside the per-request amount cap, under the per-customer
 *   annual cap, optionally low-risk per the injected
 *   `customerRiskProfile` handle, reason and currency in the
 *   operator-authored sets — the primitive issues the refund
 *   through the composed `payment.refund` call without operator
 *   intervention. Otherwise the request falls through to
 *   `manual_review` and waits for a human.
 *
 *   Composition:
 *
 *     var ra = bShop.refundAutomation.create({
 *       query:                q,
 *       refundPolicy:         rp,    // optional — upstream eligibility
 *       returns:              rmas,  // optional — RMA cross-check
 *       payment:              pay,   // optional — for executeAutoRefund
 *       customerRiskProfile:  risk,  // optional — required if any rule
 *                                    //            has requires_low_risk
 *     });
 *
 *     await ra.defineAutoRule({
 *       slug:                          "small-customer-requests",
 *       max_amount_minor:              5000,             // $50.00 USD
 *       max_refunds_per_customer_year: 3,
 *       requires_low_risk:             true,
 *       eligible_reasons:              ["requested_by_customer"],
 *       currency_in_set:               ["USD"],
 *     });
 *
 *     var verdict = await ra.evaluateForRefundRequest({
 *       order_id:            orderId,
 *       customer_id:         customerId,
 *       request_amount_minor: 1500,
 *       reason:              "requested_by_customer",
 *     });
 *     // -> { eligible: true,  applied_rule: "small-customer-requests",
 *     //      max_refund_minor: 5000, requires_manual_review: false,
 *     //      reasons: ["rule_matched"] }
 *
 *     if (verdict.eligible) {
 *       await ra.executeAutoRefund({
 *         order_id:     orderId,
 *         customer_id:  customerId,
 *         amount_minor: 1500,
 *         reason:       "requested_by_customer",
 *       });
 *     } else if (verdict.requires_manual_review) {
 *       // surface in the operator review queue; later resolved via
 *       await ra.markManualOverride({
 *         order_id:    orderId,
 *         decision:    "auto_approved",   // or "declined"
 *         operator_id: opId,
 *         reason:      "approved by manager — long-standing customer",
 *       });
 *     }
 *
 *   Currency: the rule's `currency_in_set` is operator-asserted; the
 *   primitive doesn't peek at the order's actual billing currency
 *   (that crosses into the `payment` primitive's domain). Callers
 *   pre-filter rules at evaluation time by passing requests whose
 *   currency is already known — typically the storefront layer
 *   resolves the order's currency before opening the refund flow.
 *   When `currency_in_set` is empty the rule applies to any
 *   currency.
 *
 *   Surface:
 *     - defineAutoRule({ slug, max_amount_minor,
 *                        max_refunds_per_customer_year,
 *                        requires_low_risk, eligible_reasons,
 *                        currency_in_set, priority? })
 *     - evaluateForRefundRequest({ order_id, customer_id,
 *                                  request_amount_minor, reason,
 *                                  currency? }) -> verdict
 *     - executeAutoRefund({ order_id, customer_id, amount_minor,
 *                           reason, payment_intent? })
 *     - markManualOverride({ order_id, decision, operator_id, reason })
 *     - metricsForRule({ slug, from, to })
 *     - listRules({ active_only?, limit? })
 *     - updateRule(slug, patch)
 *     - archiveRule(slug)
 *
 *   Storage:
 *     - refund_automation_rules + refund_automation_decisions
 *       (migration 0143_refund_automation.sql).
 *
 *   Monotonic clock: a per-factory monotonic timestamp ensures that
 *   two decisions written against the same order in the same
 *   millisecond carry strictly-increasing `decided_at` values. The
 *   `(order_id, decided_at DESC)` index then returns the latest
 *   decision unambiguously.
 *
 * @primitive refundAutomation
 * @related    refundPolicy, returns, payment, customerRiskProfile,
 *             operatorAuditLog
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN              = 80;
var MAX_REASON_LEN            = 280;
var MAX_OPERATOR_ID_LEN       = 128;
var MAX_EXTERNAL_ID_LEN       = 128;
var MAX_AMOUNT_MINOR          = 1000000000;     // $10,000,000.00 — sane upper cap
var MAX_REFUNDS_PER_YEAR_CAP  = 100000;
var MAX_PRIORITY              = 1000000;
var MAX_LIST_LIMIT            = 200;
var MAX_REASONS_PER_RULE      = 32;
var MAX_CURRENCIES_PER_RULE   = 32;
var MS_PER_YEAR               = 365 * 24 * 60 * 60 * 1000;

// Slug shape matches coupon-stacking / refund-policy convention.
var SLUG_RE       = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// Reason strings are operator-authored or processor-supplied. Keep
// loose enough to admit Stripe's documented set (lowercase + under-
// scores) plus customer-facing prose; refuse control bytes outright.
var REASON_RE     = /^[A-Za-z0-9][A-Za-z0-9 _.,'\-]{0,279}$/;
// Currency code shape — three uppercase letters (ISO 4217 alpha).
var CURRENCY_RE   = /^[A-Z]{3}$/;
// Operator id matches the customer / operator handle shape used by
// other admin-side primitives; alnum + hyphen / underscore / dot.
var OPERATOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

var DECISIONS = Object.freeze(["auto_approved", "manual_review", "declined"]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "max_amount_minor",
  "max_refunds_per_customer_year",
  "requires_low_risk",
  "eligible_reasons",
  "currency_in_set",
  "priority",
  "active",
]);

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("refundAutomation: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _amountMinor(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_AMOUNT_MINOR) {
    throw new TypeError("refundAutomation: " + label + " must be a positive integer in [1, " + MAX_AMOUNT_MINOR + "]");
  }
  return n;
}

function _maxRefundsPerYear(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_REFUNDS_PER_YEAR_CAP) {
    throw new TypeError("refundAutomation: max_refunds_per_customer_year must be an integer in [1, " + MAX_REFUNDS_PER_YEAR_CAP + "]");
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("refundAutomation: " + label + " must be a boolean");
  }
  return v;
}

function _priority(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) {
    throw new TypeError("refundAutomation: priority must be an integer in [0, " + MAX_PRIORITY + "]");
  }
  return n;
}

function _reasonEntry(s) {
  if (typeof s !== "string" || !REASON_RE.test(s)) {
    throw new TypeError("refundAutomation: eligible_reasons entries must match /^[A-Za-z0-9][A-Za-z0-9 _.,'\\-]*$/ (<= " + MAX_REASON_LEN + " chars)");
  }
  return s;
}

function _eligibleReasons(arr) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("refundAutomation: eligible_reasons must be an array of strings (empty array means 'any reason')");
  }
  if (arr.length > MAX_REASONS_PER_RULE) {
    throw new TypeError("refundAutomation: eligible_reasons length " + arr.length + " exceeds cap " + MAX_REASONS_PER_RULE);
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var r = _reasonEntry(arr[i]);
    if (seen[r]) {
      throw new TypeError("refundAutomation: eligible_reasons contains duplicate " + JSON.stringify(r));
    }
    seen[r] = true;
    out.push(r);
  }
  return out;
}

function _currencyEntry(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("refundAutomation: currency_in_set entries must be 3-letter ISO-4217 alpha codes (e.g. 'USD', 'EUR')");
  }
  return s;
}

function _currencyInSet(arr) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("refundAutomation: currency_in_set must be an array of ISO-4217 codes (empty array means 'any currency')");
  }
  if (arr.length > MAX_CURRENCIES_PER_RULE) {
    throw new TypeError("refundAutomation: currency_in_set length " + arr.length + " exceeds cap " + MAX_CURRENCIES_PER_RULE);
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var c = _currencyEntry(arr[i]);
    if (seen[c]) {
      throw new TypeError("refundAutomation: currency_in_set contains duplicate " + JSON.stringify(c));
    }
    seen[c] = true;
    out.push(c);
  }
  return out;
}

function _reasonValue(s, label) {
  if (typeof s !== "string" || !REASON_RE.test(s)) {
    throw new TypeError("refundAutomation: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9 _.,'\\-]*$/ (<= " + MAX_REASON_LEN + " chars)");
  }
  return s;
}

function _orderId(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_EXTERNAL_ID_LEN) {
    throw new TypeError("refundAutomation: order_id must be a non-empty string <= " + MAX_EXTERNAL_ID_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("refundAutomation: order_id must not contain control bytes");
  }
  return s;
}

function _customerId(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_EXTERNAL_ID_LEN) {
    throw new TypeError("refundAutomation: customer_id must be a non-empty string <= " + MAX_EXTERNAL_ID_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("refundAutomation: customer_id must not contain control bytes");
  }
  return s;
}

function _operatorId(s) {
  if (typeof s !== "string" || !OPERATOR_ID_RE.test(s)) {
    throw new TypeError("refundAutomation: operator_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_OPERATOR_ID_LEN + " chars)");
  }
  return s;
}

function _decision(s) {
  if (typeof s !== "string" || DECISIONS.indexOf(s) === -1) {
    throw new TypeError("refundAutomation: decision must be one of " + DECISIONS.join(", "));
  }
  return s;
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("refundAutomation: " + label + " must be a non-negative integer epoch-ms");
  }
  return n;
}

function _currencyOpt(s) {
  if (s == null) return null;
  return _currencyEntry(s);
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

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

function _hydrateRule(r) {
  if (!r) return null;
  return {
    slug:                          r.slug,
    max_amount_minor:              Number(r.max_amount_minor),
    max_refunds_per_customer_year: Number(r.max_refunds_per_customer_year),
    requires_low_risk:             r.requires_low_risk === 1 || r.requires_low_risk === true,
    eligible_reasons:              _safeParseArray(r.eligible_reasons_json),
    currency_in_set:               _safeParseArray(r.currency_in_set_json),
    priority:                      Number(r.priority),
    active:                        r.active === 1 || r.active === true,
    archived_at:                   r.archived_at == null ? null : Number(r.archived_at),
    created_at:                    Number(r.created_at),
    updated_at:                    Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional composed handles. All four are stubbable; the primitive
  // composes them when present and refuses gracefully when a rule
  // requires a capability the operator hasn't wired (e.g.
  // requires_low_risk without an injected customerRiskProfile).
  var refundPolicyHandle  = opts.refundPolicy        || null;
  var returnsHandle       = opts.returns             || null;
  var paymentHandle       = opts.payment             || null;
  var riskProfileHandle   = opts.customerRiskProfile || null;

  // Per-factory monotonic clock. Two decisions written against the
  // same order in the same wall-clock millisecond would otherwise
  // tie on `decided_at` and make the
  // `(order_id, decided_at DESC)` index ambiguous. Forward-leap when
  // the wall clock outpaces the counter; otherwise bump by 1ms so
  // the sequence is strictly increasing per primitive instance.
  var _lastEventTs = 0;
  function _monotonicTs() {
    var wall = _now();
    if (wall > _lastEventTs) _lastEventTs = wall;
    else                     _lastEventTs += 1;
    return _lastEventTs;
  }

  // ---- defineAutoRule -----------------------------------------------

  async function defineAutoRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundAutomation.defineAutoRule: input object required");
    }
    var slug            = _slug(input.slug);
    var maxAmt          = _amountMinor(input.max_amount_minor, "max_amount_minor");
    var maxPerYear      = _maxRefundsPerYear(input.max_refunds_per_customer_year);
    var requiresLowRisk = _bool(input.requires_low_risk, "requires_low_risk");
    var reasons         = _eligibleReasons(input.eligible_reasons);
    var currencies      = _currencyInSet(input.currency_in_set);
    var priority        = input.priority == null ? 0 : _priority(input.priority);

    // Refuse redefine — same posture as refundPolicy / coupon-stacking.
    var existing = (await query(
      "SELECT slug FROM refund_automation_rules WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("refundAutomation.defineAutoRule: slug " + JSON.stringify(slug) + " already exists - use updateRule");
    }

    var ts = _monotonicTs();
    await query(
      "INSERT INTO refund_automation_rules (slug, max_amount_minor, max_refunds_per_customer_year, " +
      "requires_low_risk, eligible_reasons_json, currency_in_set_json, priority, active, " +
      "archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, ?8, ?8)",
      [
        slug,
        maxAmt,
        maxPerYear,
        requiresLowRisk ? 1 : 0,
        JSON.stringify(reasons),
        JSON.stringify(currencies),
        priority,
        ts,
      ],
    );
    return await _getRule(slug);
  }

  // ---- getRule / listRules / updateRule / archiveRule ---------------

  async function _getRule(slug) {
    var r = (await query(
      "SELECT * FROM refund_automation_rules WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRule(r);
  }

  async function listRules(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("refundAutomation.listRules: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("refundAutomation.listRules: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql;
    if (activeOnly) {
      sql = "SELECT * FROM refund_automation_rules WHERE active = 1 AND archived_at IS NULL " +
            "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
    } else {
      sql = "SELECT * FROM refund_automation_rules " +
            "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
    }
    var rows = (await query(sql, [limit])).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRule(rows[i]));
    return out;
  }

  async function updateRule(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("refundAutomation.updateRule: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("refundAutomation.updateRule: patch must include at least one column");
    }
    var current = await _getRule(slug);
    if (!current) {
      throw new TypeError("refundAutomation.updateRule: slug " + JSON.stringify(slug) + " not found");
    }
    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("refundAutomation.updateRule: unsupported column " + JSON.stringify(col));
      }
      if (col === "max_amount_minor") {
        sets.push("max_amount_minor = ?" + idx);
        params.push(_amountMinor(patch[col], "max_amount_minor"));
      } else if (col === "max_refunds_per_customer_year") {
        sets.push("max_refunds_per_customer_year = ?" + idx);
        params.push(_maxRefundsPerYear(patch[col]));
      } else if (col === "requires_low_risk") {
        sets.push("requires_low_risk = ?" + idx);
        params.push(_bool(patch[col], "requires_low_risk") ? 1 : 0);
      } else if (col === "eligible_reasons") {
        sets.push("eligible_reasons_json = ?" + idx);
        params.push(JSON.stringify(_eligibleReasons(patch[col])));
      } else if (col === "currency_in_set") {
        sets.push("currency_in_set_json = ?" + idx);
        params.push(JSON.stringify(_currencyInSet(patch[col])));
      } else if (col === "priority") {
        sets.push("priority = ?" + idx);
        params.push(_priority(patch[col]));
      } else /* active */ {
        sets.push("active = ?" + idx);
        params.push(_bool(patch[col], "active") ? 1 : 0);
      }
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_monotonicTs());
    idx += 1;
    params.push(slug);
    var r = await query(
      "UPDATE refund_automation_rules SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("refundAutomation.updateRule: slug " + JSON.stringify(slug) + " not found");
    }
    return await _getRule(slug);
  }

  async function archiveRule(slug) {
    _slug(slug);
    var ts = _monotonicTs();
    var r = await query(
      "UPDATE refund_automation_rules SET archived_at = ?1, active = 0, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await _getRule(slug);
      if (!existing) {
        throw new TypeError("refundAutomation.archiveRule: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — return existing row idempotently.
      return existing;
    }
    return await _getRule(slug);
  }

  // ---- evaluateForRefundRequest -------------------------------------
  //
  // Walks active, non-archived rules in (priority DESC, created_at
  // ASC, slug ASC) order. The first rule whose every gate accepts
  // governs the verdict; falling out of every rule's gates surfaces
  // as `manual_review` (not `declined` — the primitive's job is to
  // route, not refuse: a human decides whether the operator wants
  // to issue the refund anyway).
  async function evaluateForRefundRequest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundAutomation.evaluateForRefundRequest: input object required");
    }
    // order_id is validated for shape only — evaluate is a pure
    // read against rules + the customer's prior-decision count. The
    // order_id makes it into the audit row at executeAutoRefund /
    // markManualOverride time.
    _orderId(input.order_id);
    var customerId = _customerId(input.customer_id);
    var requestAmt = _amountMinor(input.request_amount_minor, "request_amount_minor");
    var reason     = _reasonValue(input.reason, "reason");
    var currency   = _currencyOpt(input.currency);

    var rows = (await query(
      "SELECT * FROM refund_automation_rules WHERE active = 1 AND archived_at IS NULL " +
      "ORDER BY priority DESC, created_at ASC, slug ASC",
      [],
    )).rows;

    if (rows.length === 0) {
      return {
        eligible:               false,
        applied_rule:           null,
        max_refund_minor:       0,
        requires_manual_review: true,
        reasons:                ["no_rule_matched"],
      };
    }

    var firstCandidate = null;
    var firstReasons   = null;

    for (var i = 0; i < rows.length; i += 1) {
      var rule = _hydrateRule(rows[i]);
      var reasons = [];

      // Per-request amount cap.
      if (requestAmt > rule.max_amount_minor) {
        reasons.push("amount_exceeds_rule_cap");
      }
      // Reason gate. Empty set means "any reason qualifies."
      if (rule.eligible_reasons.length > 0 && rule.eligible_reasons.indexOf(reason) === -1) {
        reasons.push("reason_not_eligible");
      }
      // Currency gate. Empty set means "any currency." A request
      // without a currency argument can't satisfy a currency-gated
      // rule.
      if (rule.currency_in_set.length > 0) {
        if (currency == null) {
          reasons.push("currency_missing");
        } else if (rule.currency_in_set.indexOf(currency) === -1) {
          reasons.push("currency_not_eligible");
        }
      }
      // Per-customer annual cap. Counts prior auto_approved
      // decisions for this customer within the trailing 365 days.
      // The cap is "would this request push the count past the
      // cap?" — a customer at max_refunds-1 still qualifies.
      var since = _now() - MS_PER_YEAR;
      var prior = (await query(
        "SELECT COUNT(*) AS n FROM refund_automation_decisions " +
        "WHERE customer_id = ?1 AND decision = 'auto_approved' AND decided_at >= ?2",
        [customerId, since],
      )).rows[0];
      var priorCount = prior == null ? 0 : Number(prior.n || 0);
      if (priorCount >= rule.max_refunds_per_customer_year) {
        reasons.push("customer_year_cap_exceeded");
      }
      // Low-risk gate. When the rule requires it, the injected
      // customerRiskProfile handle must report a low band. Absent
      // the handle the gate refuses (missing signal is a manual-
      // review signal, not a free pass).
      if (rule.requires_low_risk) {
        if (!riskProfileHandle || typeof riskProfileHandle.bandFor !== "function") {
          reasons.push("risk_profile_unavailable");
        } else {
          var band;
          try {
            band = await riskProfileHandle.bandFor(customerId);
          } catch (_e) {
            band = null;
          }
          if (band !== "low") {
            reasons.push("customer_not_low_risk");
          }
        }
      }

      if (reasons.length === 0) {
        return {
          eligible:               true,
          applied_rule:           rule.slug,
          max_refund_minor:       rule.max_amount_minor,
          requires_manual_review: false,
          reasons:                ["rule_matched"],
        };
      }

      if (firstCandidate == null) {
        firstCandidate = rule;
        firstReasons   = reasons;
      }
      // Otherwise: a lower-priority rule may still accept; keep walking.
    }

    return {
      eligible:               false,
      applied_rule:           firstCandidate ? firstCandidate.slug : null,
      max_refund_minor:       0,
      requires_manual_review: true,
      reasons:                firstReasons || ["no_rule_matched"],
    };
  }

  // ---- executeAutoRefund --------------------------------------------
  //
  // Re-evaluates eligibility (a stale verdict the caller is holding
  // from minutes ago might no longer apply if the customer just
  // crossed the annual cap), writes the auto_approved audit row,
  // and composes payment.refund when a handle is wired. The audit
  // row writes BEFORE the payment call so a payment-call failure
  // doesn't lose the operator-visible decision; payment failures
  // surface as a thrown error to the caller, who is responsible
  // for unwinding via markManualOverride or operator escalation.
  async function executeAutoRefund(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundAutomation.executeAutoRefund: input object required");
    }
    var orderId    = _orderId(input.order_id);
    var customerId = _customerId(input.customer_id);
    var amount     = _amountMinor(input.amount_minor, "amount_minor");
    var reason     = _reasonValue(input.reason, "reason");
    var paymentIntent = null;
    if (input.payment_intent != null) {
      if (typeof input.payment_intent !== "string" || !input.payment_intent.length) {
        throw new TypeError("refundAutomation.executeAutoRefund: payment_intent must be a non-empty string when provided");
      }
      paymentIntent = input.payment_intent;
    }

    var verdict = await evaluateForRefundRequest({
      order_id:             orderId,
      customer_id:          customerId,
      request_amount_minor: amount,
      reason:               reason,
      currency:             input.currency,
    });
    if (!verdict.eligible) {
      throw new TypeError("refundAutomation.executeAutoRefund: request did not pass auto-eligibility — reasons: " +
                          verdict.reasons.join(", "));
    }

    var id = _b().uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO refund_automation_decisions (id, order_id, customer_id, applied_rule, decision, " +
      "amount_minor, reason, decided_at) VALUES (?1, ?2, ?3, ?4, 'auto_approved', ?5, ?6, ?7)",
      [id, orderId, customerId, verdict.applied_rule, amount, reason, ts],
    );

    // Compose payment.refund when wired. The handle's exact shape
    // mirrors the framework's payment primitive (`{ payment_intent,
    // amount_minor, reason, metadata }`). Absent a handle the
    // primitive still records the decision so the operator can
    // drive the actual refund out-of-band.
    var paymentResult = null;
    if (paymentHandle && typeof paymentHandle.refund === "function") {
      var refundInput = {
        amount_minor: amount,
        reason:       reason,
        metadata:     { order_id: orderId, customer_id: customerId, applied_rule: verdict.applied_rule },
      };
      if (paymentIntent != null) refundInput.payment_intent = paymentIntent;
      paymentResult = await paymentHandle.refund(refundInput);
    }

    return {
      id:             id,
      order_id:       orderId,
      customer_id:    customerId,
      applied_rule:   verdict.applied_rule,
      decision:       "auto_approved",
      amount_minor:   amount,
      reason:         reason,
      decided_at:     ts,
      payment_result: paymentResult,
    };
  }

  // ---- markManualOverride -------------------------------------------
  //
  // Records the operator's decision on a request that fell through to
  // manual review. Writes a fresh decision row keyed by order_id so
  // the dashboard sees the latest verdict. The `applied_rule` column
  // is left NULL — the manual override didn't apply a rule.
  async function markManualOverride(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundAutomation.markManualOverride: input object required");
    }
    var orderId    = _orderId(input.order_id);
    var decision   = _decision(input.decision);
    var operatorId = _operatorId(input.operator_id);
    var reason     = _reasonValue(input.reason, "reason");

    // Look up the most-recent decision for this order to pull the
    // customer_id forward. The manual override is keyed by order;
    // the customer is whoever the request was originally filed for.
    var prior = (await query(
      "SELECT customer_id FROM refund_automation_decisions " +
      "WHERE order_id = ?1 ORDER BY decided_at DESC LIMIT 1",
      [orderId],
    )).rows[0];
    if (!prior) {
      throw new TypeError("refundAutomation.markManualOverride: order_id " + JSON.stringify(orderId) +
                          " has no prior decision row — call evaluateForRefundRequest first so the request is recorded");
    }
    var customerId = prior.customer_id;

    var id = _b().uuid.v7();
    var ts = _monotonicTs();
    // The reason column carries `<operator_id>: <reason>` so the
    // audit log shows who approved / declined without a separate
    // operator_id column on the decisions table (that level of
    // structured operator-id auditing lives in operator_audit_events).
    var auditedReason = operatorId + ": " + reason;
    if (auditedReason.length > MAX_REASON_LEN) {
      auditedReason = auditedReason.slice(0, MAX_REASON_LEN);
    }
    await query(
      "INSERT INTO refund_automation_decisions (id, order_id, customer_id, applied_rule, decision, " +
      "amount_minor, reason, decided_at) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?6)",
      [id, orderId, customerId, decision, auditedReason, ts],
    );
    return {
      id:           id,
      order_id:     orderId,
      customer_id:  customerId,
      applied_rule: null,
      decision:     decision,
      amount_minor: null,
      reason:       auditedReason,
      decided_at:   ts,
    };
  }

  // ---- metricsForRule -----------------------------------------------
  //
  // Aggregates over the [from, to] window. Returns counts by
  // decision bucket + total refunded amount for auto_approved rows.
  async function metricsForRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("refundAutomation.metricsForRule: input object required");
    }
    var slug = _slug(input.slug);
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (from > to) {
      throw new TypeError("refundAutomation.metricsForRule: from must be <= to");
    }
    var rows = (await query(
      "SELECT decision, amount_minor FROM refund_automation_decisions " +
      "WHERE applied_rule = ?1 AND decided_at >= ?2 AND decided_at <= ?3",
      [slug, from, to],
    )).rows;
    var autoCount   = 0;
    var manualCount = 0;
    var declinedCount = 0;
    var totalRefundedMinor = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      if (r.decision === "auto_approved") {
        autoCount += 1;
        if (r.amount_minor != null) totalRefundedMinor += Number(r.amount_minor);
      } else if (r.decision === "manual_review") {
        manualCount += 1;
      } else if (r.decision === "declined") {
        declinedCount += 1;
      }
    }
    return {
      slug:                  slug,
      from:                  from,
      to:                    to,
      auto_approved_count:   autoCount,
      manual_review_count:   manualCount,
      declined_count:        declinedCount,
      total_refunded_minor:  totalRefundedMinor,
    };
  }

  // Internal cross-references so the unused-handle defensive reads
  // are explicit. refundPolicy + returns aren't currently composed in
  // the v1 surface — they're held for forward compatibility (a future
  // gate will compose refundPolicy.evaluate as an upstream eligibility
  // pre-check, and returns will let us cross-check that an RMA
  // actually exists before issuing the refund). Keeping the handles
  // in the factory keeps the operator-facing wiring stable across
  // those additions.
  void refundPolicyHandle;
  void returnsHandle;

  return {
    defineAutoRule:           defineAutoRule,
    evaluateForRefundRequest: evaluateForRefundRequest,
    executeAutoRefund:        executeAutoRefund,
    markManualOverride:       markManualOverride,
    metricsForRule:           metricsForRule,
    listRules:                listRules,
    updateRule:               updateRule,
    archiveRule:              archiveRule,
  };
}

module.exports = {
  create:                create,
  DECISIONS:             DECISIONS,
  ALLOWED_PATCH_COLUMNS: ALLOWED_PATCH_COLUMNS,
  MAX_AMOUNT_MINOR:      MAX_AMOUNT_MINOR,
  MAX_REASONS_PER_RULE:  MAX_REASONS_PER_RULE,
  MAX_CURRENCIES_PER_RULE: MAX_CURRENCIES_PER_RULE,
};
