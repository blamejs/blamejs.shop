"use strict";
/**
 * @module shop.loyaltyEarnRules
 * @title  Loyalty earn rules — per-action point-earning configuration
 *
 * @intro
 *   Distinct from `loyalty` (which records the running points balance
 *   and the audited transaction trail) and from `tierBenefits` (which
 *   configures perks unlocked at each tier). This primitive defines
 *   HOW points are earned — operators publish rules keyed by an event
 *   `trigger` and the application calls `awardForEvent` at the
 *   appropriate lifecycle moment.
 *
 *   Triggers (closed enum):
 *     - per_dollar_spent          — N points per $1 of order subtotal
 *     - per_purchase              — flat N points per completed order
 *     - per_review                — N points per review submitted
 *     - per_referral_redeemed     — N points per referred friend's
 *                                   first order completing
 *     - birthday                  — N points on the customer's birthday
 *     - signup_bonus              — N points on account creation
 *     - first_purchase            — N points on the first completed order
 *     - abandoned_cart_recovered  — N points when a recovered cart converts
 *
 *   Composition:
 *
 *     var rules = bShop.loyaltyEarnRules.create({
 *       query:    q,
 *       loyalty:  loy,    // optional — awardForEvent composes loy.earn
 *     });
 *
 *     await rules.defineRule({
 *       slug:                "spend-1pt-per-dollar",
 *       trigger:             "per_dollar_spent",
 *       points_per_unit:     1,
 *       max_per_event:       5000,
 *       customer_status_in:  ["active", "vip"],
 *     });
 *
 *     await rules.awardForEvent({
 *       trigger:           "per_dollar_spent",
 *       customer_id:       customerId,
 *       dollars_spent:     42,
 *       trigger_event_ref: "order:" + orderId,
 *       customer_status:   "active",
 *     });
 *
 *   `evaluateForEvent` is the dry-run companion to `awardForEvent`. It
 *   returns the same `{ points, reason }` shape but does NOT touch the
 *   audit log or the loyalty ledger — operators preview an award at
 *   checkout (so the customer sees "you'll earn 42 points") without
 *   committing.
 *
 *   `applyBatch` runs multiple awards in a single call. Each (rule,
 *   event) pair flows through the same validate -> evaluate -> award
 *   path; per-pair failures are collected into a `failed[]` array
 *   rather than failing the whole batch (operators commonly run nightly
 *   sweeps that span thousands of events — a malformed row shouldn't
 *   block the rest).
 *
 *   Per-event dedup: the (rule_slug, customer_id, trigger_event_ref)
 *   UNIQUE on `loyalty_earn_log` collapses retried inserts onto one
 *   row so a webhook retry doesn't double-award.
 *
 *   Composes:
 *     - `b.uuid.v7`     — audit-log row ids (lexicographic + monotonic)
 *     - `b.guardUuid`   — strict UUID gate on every customer_id
 *     - `loyalty`       — optional; when wired, `awardForEvent` composes
 *                         `loyalty.earn` so the points land in the
 *                         customer's balance + the loyalty audit trail
 *                         in one call.
 *
 *   Storage: `migrations-d1/0163_loyalty_earn_rules.sql` —
 *     `loyalty_earn_rules` + `loyalty_earn_log`.
 *
 * @primitive loyaltyEarnRules
 * @related   loyalty, tierBenefits, b.uuid.v7, b.guardUuid
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var TRIGGERS = Object.freeze([
  "per_dollar_spent",
  "per_purchase",
  "per_review",
  "per_referral_redeemed",
  "birthday",
  "signup_bonus",
  "first_purchase",
  "abandoned_cart_recovered",
]);

// Triggers that scale points by a caller-supplied unit count.
// per_dollar_spent multiplies points_per_unit by the order's dollar
// subtotal; every other trigger awards a flat points_per_unit.
var UNIT_TRIGGERS = Object.freeze({
  per_dollar_spent: "dollars_spent",
});

var SLUG_RE              = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
var TRIGGER_REF_RE       = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var STATUS_RE            = /^[a-z][a-z0-9_-]{0,31}$/;

var MAX_STATUS_LIST      = 16;
var MAX_POINTS_PER_UNIT  = 1000000;       // 1M cap on a single multiplier
var MAX_MAX_PER_EVENT    = 1000000000;    // 1B cap on a per-event ceiling

var DEFAULT_LIST_LIMIT   = 50;
var MAX_LIST_LIMIT       = 500;

// ---- monotonic clock ----------------------------------------------------
//
// Awards land in `loyalty_earn_log` keyed by `occurred_at`. The metrics
// rollup window scans by (rule_slug, occurred_at >= from AND <= to);
// two awards in the same millisecond would tie on the sort key and the
// `applyBatch` path issues many awards in a tight loop. The strict-
// monotonic clock guarantees distinct timestamps per call so ordering
// is deterministic without a tiebreaker column.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("loyaltyEarnRules: " + (label || "slug") +
                        " must be lowercase alnum + dash, no leading/trailing dash, 1..100 chars");
  }
  return s;
}

function _trigger(s) {
  if (typeof s !== "string" || TRIGGERS.indexOf(s) < 0) {
    throw new TypeError("loyaltyEarnRules: trigger must be one of " + TRIGGERS.join(", "));
  }
  return s;
}

function _pointsPerUnit(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > MAX_POINTS_PER_UNIT) {
    throw new TypeError("loyaltyEarnRules: points_per_unit must be a positive integer <= " +
                        MAX_POINTS_PER_UNIT);
  }
  return n;
}

function _maxPerEvent(n) {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > MAX_MAX_PER_EVENT) {
    throw new TypeError("loyaltyEarnRules: max_per_event must be a positive integer <= " +
                        MAX_MAX_PER_EVENT + " (or omitted)");
  }
  return n;
}

function _customerStatusIn(arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) {
    throw new TypeError("loyaltyEarnRules: customer_status_in must be an array of status strings");
  }
  if (arr.length === 0) {
    throw new TypeError("loyaltyEarnRules: customer_status_in must be non-empty when provided");
  }
  if (arr.length > MAX_STATUS_LIST) {
    throw new TypeError("loyaltyEarnRules: customer_status_in must contain <= " +
                        MAX_STATUS_LIST + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var s = arr[i];
    if (typeof s !== "string" || !STATUS_RE.test(s)) {
      throw new TypeError("loyaltyEarnRules: customer_status_in[" + i +
                          "] must be lowercase alnum / underscore / dash, 1..32 chars");
    }
    if (seen[s]) {
      throw new TypeError("loyaltyEarnRules: customer_status_in[" + i +
                          "] duplicates a previous entry");
    }
    seen[s] = true;
    out.push(s);
  }
  return out;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("loyaltyEarnRules: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _triggerEventRef(s) {
  if (typeof s !== "string" || !TRIGGER_REF_RE.test(s)) {
    throw new TypeError("loyaltyEarnRules: trigger_event_ref must match /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ (1..128 chars)");
  }
  return s;
}

function _statusOpt(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !STATUS_RE.test(s)) {
    throw new TypeError("loyaltyEarnRules: customer_status must be lowercase alnum / underscore / dash, 1..32 chars");
  }
  return s;
}

function _epochOpt(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("loyaltyEarnRules: " + label + " must be a non-negative integer (ms epoch) or null");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("loyaltyEarnRules: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("loyaltyEarnRules: " + label + " must be a boolean");
  }
  return v;
}

// Pure compute — given a rule row + an event context, return the
// (points, reason) tuple WITHOUT touching storage. Exported via
// evaluateForEvent + reused inside awardForEvent so the math is
// single-sourced.
function _computePoints(rule, ctx) {
  var unitField = UNIT_TRIGGERS[rule.trigger];
  var units = 1;
  if (unitField != null) {
    var raw = ctx[unitField];
    if (typeof raw !== "number" || !isFinite(raw) || raw < 0) {
      return { points: 0, reason: unitField + " must be a non-negative finite number for trigger " + rule.trigger };
    }
    units = Math.floor(raw);
    if (units <= 0) {
      return { points: 0, reason: unitField + " floored to zero" };
    }
  }
  var raw_points = rule.points_per_unit * units;
  if (rule.max_per_event != null && raw_points > rule.max_per_event) {
    return {
      points:  rule.max_per_event,
      reason:  "capped at max_per_event=" + rule.max_per_event +
               " (uncapped would have been " + raw_points + ")",
      capped:  true,
    };
  }
  return { points: raw_points, reason: "trigger=" + rule.trigger + " units=" + units, capped: false };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional loyalty handle — when wired, awardForEvent calls
  // loyalty.earn so the points land in the customer's balance + the
  // loyalty transaction audit trail in one go. Absent, the primitive
  // still writes the loyalty_earn_log breadcrumb but the operator is
  // responsible for posting to the ledger separately.
  var loyaltyHandle = opts.loyalty || null;

  // ---- internal helpers -----------------------------------------------

  function _decodeRule(row) {
    if (!row) return null;
    var statusList = null;
    if (row.customer_status_in_json) {
      try { statusList = JSON.parse(row.customer_status_in_json); }
      catch (_e) { statusList = null; }
    }
    return {
      slug:                 row.slug,
      trigger:              row.trigger,
      points_per_unit:      Number(row.points_per_unit),
      max_per_event:        row.max_per_event == null ? null : Number(row.max_per_event),
      customer_status_in:   statusList,
      active:               Number(row.active) === 1,
      archived_at:          row.archived_at == null ? null : Number(row.archived_at),
      created_at:           Number(row.created_at),
      updated_at:           Number(row.updated_at),
    };
  }

  async function _ruleRow(slug) {
    var r = await query("SELECT * FROM loyalty_earn_rules WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  // Status gate. If the rule restricts to a status list, the event's
  // customer_status MUST appear in the list. NULL list means no
  // restriction. Returns null when the event passes, or a reason
  // string when it's filtered out.
  function _statusFilter(rule, ctx) {
    if (rule.customer_status_in == null) return null;
    var status = ctx.customer_status;
    if (status == null || rule.customer_status_in.indexOf(status) < 0) {
      return "customer_status=" + JSON.stringify(status) +
             " not in [" + rule.customer_status_in.join(", ") + "]";
    }
    return null;
  }

  // ---- defineRule -----------------------------------------------------

  async function defineRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyEarnRules.defineRule: input object required");
    }
    var slug             = _slug(input.slug, "slug");
    var trigger          = _trigger(input.trigger);
    var pointsPerUnit    = _pointsPerUnit(input.points_per_unit);
    var maxPerEvent      = _maxPerEvent(input.max_per_event);
    var customerStatusIn = _customerStatusIn(input.customer_status_in);
    var active           = input.active == null ? true : _bool(input.active, "active");

    var existing = await _ruleRow(slug);
    var ts = _now();
    if (existing) {
      if (existing.archived_at != null) {
        throw new TypeError("loyaltyEarnRules.defineRule: rule " + JSON.stringify(slug) + " is archived");
      }
      await query(
        "UPDATE loyalty_earn_rules " +
        "SET trigger = ?1, points_per_unit = ?2, max_per_event = ?3, " +
        "customer_status_in_json = ?4, active = ?5, updated_at = ?6 " +
        "WHERE slug = ?7",
        [trigger, pointsPerUnit, maxPerEvent,
         customerStatusIn == null ? null : JSON.stringify(customerStatusIn),
         active ? 1 : 0, ts, slug],
      );
    } else {
      await query(
        "INSERT INTO loyalty_earn_rules " +
        "(slug, trigger, points_per_unit, max_per_event, customer_status_in_json, " +
        " active, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
        [slug, trigger, pointsPerUnit, maxPerEvent,
         customerStatusIn == null ? null : JSON.stringify(customerStatusIn),
         active ? 1 : 0, ts],
      );
    }
    return _decodeRule(await _ruleRow(slug));
  }

  // ---- getRule / listRules --------------------------------------------

  async function getRule(slug) {
    _slug(slug, "slug");
    return _decodeRule(await _ruleRow(slug));
  }

  async function listRules(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = listOpts.active_only == null ? false : _bool(listOpts.active_only, "active_only");
    var limit      = _limit(listOpts.limit);
    var sql    = "SELECT * FROM loyalty_earn_rules";
    var params = [];
    var idx    = 1;
    var where  = [];
    if (activeOnly) {
      where.push("active = ?" + idx); params.push(1); idx += 1;
      where.push("archived_at IS NULL");
    }
    if (listOpts.trigger != null) {
      where.push("trigger = ?" + idx); params.push(_trigger(listOpts.trigger)); idx += 1;
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY slug ASC LIMIT ?" + idx;
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeRule(r.rows[i]));
    return out;
  }

  // ---- updateRule -----------------------------------------------------

  async function updateRule(slug, patch) {
    _slug(slug, "slug");
    if (!patch || typeof patch !== "object") {
      throw new TypeError("loyaltyEarnRules.updateRule: patch object required");
    }
    var existing = await _ruleRow(slug);
    if (!existing) return null;
    if (existing.archived_at != null) {
      throw new TypeError("loyaltyEarnRules.updateRule: rule " + JSON.stringify(slug) + " is archived");
    }
    var decoded = _decodeRule(existing);

    var nextPoints = decoded.points_per_unit;
    if (Object.prototype.hasOwnProperty.call(patch, "points_per_unit")) {
      nextPoints = _pointsPerUnit(patch.points_per_unit);
    }
    var nextMax = decoded.max_per_event;
    if (Object.prototype.hasOwnProperty.call(patch, "max_per_event")) {
      nextMax = _maxPerEvent(patch.max_per_event);
    }
    var nextStatus = decoded.customer_status_in;
    if (Object.prototype.hasOwnProperty.call(patch, "customer_status_in")) {
      nextStatus = _customerStatusIn(patch.customer_status_in);
    }
    var nextActive = decoded.active;
    if (Object.prototype.hasOwnProperty.call(patch, "active")) {
      nextActive = _bool(patch.active, "active");
    }
    // trigger is immutable on update — operators that need a different
    // trigger archive the rule and define a new one. Otherwise the
    // metricsForRule history straddles two semantically distinct
    // event spaces and the rollup becomes a lie.
    if (Object.prototype.hasOwnProperty.call(patch, "trigger") && patch.trigger !== decoded.trigger) {
      throw new TypeError("loyaltyEarnRules.updateRule: trigger is immutable — archive + define a new rule instead");
    }

    var ts = _now();
    await query(
      "UPDATE loyalty_earn_rules SET points_per_unit = ?1, max_per_event = ?2, " +
      "customer_status_in_json = ?3, active = ?4, updated_at = ?5 WHERE slug = ?6",
      [nextPoints, nextMax,
       nextStatus == null ? null : JSON.stringify(nextStatus),
       nextActive ? 1 : 0, ts, slug],
    );
    return _decodeRule(await _ruleRow(slug));
  }

  // ---- archiveRule ----------------------------------------------------

  async function archiveRule(slug) {
    _slug(slug, "slug");
    var ts = _now();
    var r = await query(
      "UPDATE loyalty_earn_rules SET archived_at = ?1, active = 0, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await _ruleRow(slug);
      if (!existing) return null;
      return _decodeRule(existing);
    }
    return _decodeRule(await _ruleRow(slug));
  }

  // ---- evaluateForEvent (dry-run) -------------------------------------

  async function evaluateForEvent(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyEarnRules.evaluateForEvent: input object required");
    }
    var trigger = _trigger(input.trigger);
    _uuid(input.customer_id, "customer_id");
    _statusOpt(input.customer_status);

    // The slug-targeted path lets operators preview a single named
    // rule even when several rules share the same trigger. Absent a
    // slug, every active matching-trigger rule is evaluated; the
    // primitive returns each rule's verdict (eligible / skipped /
    // capped) so the operator-facing UI can render a per-rule
    // breakdown.
    var rules;
    if (input.slug != null) {
      var slug = _slug(input.slug, "slug");
      var r = await _ruleRow(slug);
      rules = r ? [r] : [];
    } else {
      var r2 = await query(
        "SELECT * FROM loyalty_earn_rules WHERE trigger = ?1 AND active = 1 AND archived_at IS NULL " +
        "ORDER BY slug ASC",
        [trigger],
      );
      rules = r2.rows;
    }

    var verdicts = [];
    var totalPoints = 0;
    for (var i = 0; i < rules.length; i += 1) {
      var rule = _decodeRule(rules[i]);
      if (rule.trigger !== trigger) {
        verdicts.push({ slug: rule.slug, eligible: false, points: 0,
                        reason: "rule.trigger=" + rule.trigger + " != requested " + trigger });
        continue;
      }
      if (!rule.active || rule.archived_at != null) {
        verdicts.push({ slug: rule.slug, eligible: false, points: 0,
                        reason: "rule is inactive or archived" });
        continue;
      }
      var statusReason = _statusFilter(rule, input);
      if (statusReason) {
        verdicts.push({ slug: rule.slug, eligible: false, points: 0, reason: statusReason });
        continue;
      }
      var calc = _computePoints(rule, input);
      if (calc.points <= 0) {
        verdicts.push({ slug: rule.slug, eligible: false, points: 0, reason: calc.reason });
        continue;
      }
      verdicts.push({
        slug:     rule.slug,
        eligible: true,
        points:   calc.points,
        reason:   calc.reason,
        capped:   !!calc.capped,
      });
      totalPoints += calc.points;
    }

    return {
      trigger:      trigger,
      customer_id:  input.customer_id,
      total_points: totalPoints,
      verdicts:     verdicts,
    };
  }

  // ---- awardForEvent --------------------------------------------------

  async function awardForEvent(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyEarnRules.awardForEvent: input object required");
    }
    var trigger          = _trigger(input.trigger);
    var customerId       = _uuid(input.customer_id, "customer_id");
    var triggerEventRef  = _triggerEventRef(input.trigger_event_ref);
    _statusOpt(input.customer_status);

    var rules;
    if (input.slug != null) {
      var slug = _slug(input.slug, "slug");
      var r = await _ruleRow(slug);
      rules = r ? [r] : [];
    } else {
      var r2 = await query(
        "SELECT * FROM loyalty_earn_rules WHERE trigger = ?1 AND active = 1 AND archived_at IS NULL " +
        "ORDER BY slug ASC",
        [trigger],
      );
      rules = r2.rows;
    }

    var awarded   = [];
    var skipped   = [];
    var totalPts  = 0;
    for (var i = 0; i < rules.length; i += 1) {
      var rule = _decodeRule(rules[i]);
      if (rule.trigger !== trigger) {
        skipped.push({ slug: rule.slug, reason: "rule.trigger != requested trigger" });
        continue;
      }
      if (!rule.active || rule.archived_at != null) {
        skipped.push({ slug: rule.slug, reason: "rule is inactive or archived" });
        continue;
      }
      var statusReason = _statusFilter(rule, input);
      if (statusReason) {
        skipped.push({ slug: rule.slug, reason: statusReason });
        continue;
      }
      var calc = _computePoints(rule, input);
      if (calc.points <= 0) {
        skipped.push({ slug: rule.slug, reason: calc.reason });
        continue;
      }

      // Dedup at the storage layer: the UNIQUE (rule_slug,
      // customer_id, trigger_event_ref) collapses a retried award
      // onto the existing row. SQLite's INSERT OR IGNORE is the
      // cheapest portable shape — when 0 rows change we surface the
      // dedup as a skipped reason rather than a hard error so a
      // webhook retry produces a consistent observable result.
      var logId = b.uuid.v7();
      var ts    = _now();
      var ins = await query(
        "INSERT OR IGNORE INTO loyalty_earn_log " +
        "(id, rule_slug, customer_id, points_awarded, trigger_event_ref, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [logId, rule.slug, customerId, calc.points, triggerEventRef, ts],
      );
      if (Number(ins.rowCount || 0) === 0) {
        skipped.push({
          slug:   rule.slug,
          reason: "duplicate trigger_event_ref — already awarded for this event",
        });
        continue;
      }

      // Compose loyalty.earn when wired. Source is derived from the
      // trigger name — loyalty's source validator demands lowercase
      // alnum + `._-`, which the trigger enum already satisfies.
      if (loyaltyHandle && typeof loyaltyHandle.earn === "function") {
        try {
          await loyaltyHandle.earn({
            customer_id: customerId,
            points:      calc.points,
            source:      "earn-rule." + rule.slug,
            notes:       "trigger=" + trigger + " ref=" + triggerEventRef,
          });
        } catch (err) {
          // Loyalty ledger failed AFTER the audit log wrote. Roll
          // the audit row back so the next retry isn't dedup-skipped
          // against a row that never made it to the ledger. The
          // operator-facing failure carries the underlying loyalty
          // error so debugging hits the root cause not the audit
          // breadcrumb.
          await query(
            "DELETE FROM loyalty_earn_log WHERE id = ?1",
            [logId],
          );
          throw err;
        }
      }

      awarded.push({
        log_id:             logId,
        slug:               rule.slug,
        points:             calc.points,
        capped:             !!calc.capped,
        trigger_event_ref:  triggerEventRef,
        occurred_at:        ts,
      });
      totalPts += calc.points;
    }

    return {
      trigger:      trigger,
      customer_id:  customerId,
      total_points: totalPts,
      awarded:      awarded,
      skipped:      skipped,
    };
  }

  // ---- reverseForEvent ------------------------------------------------

  // Reverse every award booked for one (customer, event) — the
  // counterpart to awardForEvent on an order's cancel / refund edge. A
  // paid order awards points; if that order later dies the points must
  // come back off the balance or a buy-then-refund mints free rewards.
  //
  // The earn-log `reversed_at` claim IS the idempotency guard: the
  // `UPDATE ... WHERE reversed_at IS NULL` serializes a concurrent
  // double-fire (a re-delivered webhook, or the stale-order reaper
  // racing a refund) so the points are clawed back exactly once. A
  // never-awarded event (a guest order, or one that never reached paid)
  // claims zero rows and is a natural no-op — no paid-state precondition
  // needed. Returns { reversed_points, clawed_points }: reversed_points
  // is what the awards totalled; clawed_points is what actually came off
  // the balance (floored at zero — a customer may have already spent the
  // points, and the balance can't go negative).
  async function reverseForEvent(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyEarnRules.reverseForEvent: input object required");
    }
    var customerId      = _uuid(input.customer_id, "customer_id");
    var triggerEventRef = _triggerEventRef(input.trigger_event_ref);

    // Atomic claim across every rule that awarded for this event. The
    // unreversed predicate is the serialization point — a row claimed
    // here can't be claimed by a racing reversal, and an already-reversed
    // (or never-awarded) event claims nothing.
    var ts = _now();
    var claim = await query(
      "UPDATE loyalty_earn_log SET reversed_at = ?1 " +
      "WHERE customer_id = ?2 AND trigger_event_ref = ?3 AND reversed_at IS NULL",
      [ts, customerId, triggerEventRef],
    );
    if (Number(claim.rowCount || 0) === 0) {
      return { reversed_points: 0, clawed_points: 0 };
    }

    // Sum exactly the rows this call claimed (reversed_at === ts pins them
    // to this reversal, not an earlier one against the same event).
    var sumRow = (await query(
      "SELECT COALESCE(SUM(points_awarded), 0) AS earned FROM loyalty_earn_log " +
      "WHERE customer_id = ?1 AND trigger_event_ref = ?2 AND reversed_at = ?3",
      [customerId, triggerEventRef, ts],
    )).rows[0] || { earned: 0 };
    var earned = Number(sumRow.earned || 0);

    // Claw the earned points back off the running balance, floored at
    // zero. loyalty.adjust refuses an underflow by THROWING an Error with
    // code LOYALTY_INSUFFICIENT_BALANCE; a concurrent spend can shrink the
    // balance between our read and the adjust, so on that refusal we
    // re-read and retry against the smaller balance (≤3 attempts). The
    // non-negative guard inside adjust makes the race safe — the worst
    // case is we claw less, never below zero, never negative. Lifetime is
    // not decremented (adjust's stance — tier never downgrades
    // retroactively). Skip the adjust entirely when there's nothing to
    // claw (adjust requires a non-zero delta).
    var clawed = 0;
    if (loyaltyHandle && typeof loyaltyHandle.adjust === "function"
        && typeof loyaltyHandle.balance === "function" && earned > 0) {
      for (var attempt = 0; attempt < 3; attempt += 1) {
        var bal = await loyaltyHandle.balance(customerId);
        var claw = Math.min(earned, Number((bal && bal.balance) || 0));
        if (claw <= 0) break;
        try {
          await loyaltyHandle.adjust({
            customer_id: customerId,
            points:      -claw,
            source:      "earn-reversal",
            notes:       "reversed ref=" + triggerEventRef,
          });
          clawed = claw;
          break;
        } catch (err) {
          // A concurrent spend drained the balance below `claw` between
          // the read and the adjust. Re-read and retry against the new,
          // smaller balance. Any other failure propagates.
          if (!(err && err.code === "LOYALTY_INSUFFICIENT_BALANCE")) throw err;
        }
      }
    }

    return { reversed_points: earned, clawed_points: clawed };
  }

  // ---- metricsForRule -------------------------------------------------

  async function metricsForRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyEarnRules.metricsForRule: input object required");
    }
    var slug = _slug(input.slug, "slug");
    var from = _epochOpt(input.from, "from");
    var to   = _epochOpt(input.to,   "to");
    if (from != null && to != null && from > to) {
      throw new TypeError("loyaltyEarnRules.metricsForRule: from must be <= to");
    }
    var ruleRow = await _ruleRow(slug);
    if (!ruleRow) return null;

    var sql = "SELECT COUNT(*) AS award_count, COUNT(DISTINCT customer_id) AS unique_customers, " +
              "COALESCE(SUM(points_awarded), 0) AS total_points, " +
              "MIN(occurred_at) AS first_award, MAX(occurred_at) AS last_award " +
              "FROM loyalty_earn_log WHERE rule_slug = ?1";
    var params = [slug];
    var idx = 2;
    if (from != null) { sql += " AND occurred_at >= ?" + idx; params.push(from); idx += 1; }
    if (to   != null) { sql += " AND occurred_at <= ?" + idx; params.push(to);   idx += 1; }

    var r = await query(sql, params);
    var row = r.rows[0] || { award_count: 0, unique_customers: 0, total_points: 0,
                              first_award: null, last_award: null };
    return {
      slug:              slug,
      trigger:           ruleRow.trigger,
      from:              from,
      to:                to,
      award_count:       Number(row.award_count || 0),
      unique_customers:  Number(row.unique_customers || 0),
      total_points:      Number(row.total_points || 0),
      first_award:       row.first_award == null ? null : Number(row.first_award),
      last_award:        row.last_award  == null ? null : Number(row.last_award),
    };
  }

  // ---- applyBatch -----------------------------------------------------

  async function applyBatch(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyEarnRules.applyBatch: input object required");
    }
    if (!Array.isArray(input.events) || input.events.length === 0) {
      throw new TypeError("loyaltyEarnRules.applyBatch: events must be a non-empty array");
    }
    if (input.events.length > 10000) {
      throw new TypeError("loyaltyEarnRules.applyBatch: events.length must be <= 10000");
    }
    // `rules` is an optional advisory hint — when supplied, the batch
    // restricts to those rule slugs by passing through the per-event
    // `slug` field. The primary path uses the per-event `slug` (when
    // present) or `trigger` (when absent).
    var ruleFilter = null;
    if (input.rules != null) {
      if (!Array.isArray(input.rules)) {
        throw new TypeError("loyaltyEarnRules.applyBatch: rules must be an array of slugs when provided");
      }
      ruleFilter = Object.create(null);
      for (var ri = 0; ri < input.rules.length; ri += 1) {
        ruleFilter[_slug(input.rules[ri], "rules[" + ri + "]")] = true;
      }
    }

    var awarded = [];
    var skipped = [];
    var failed  = [];
    var totalPts = 0;

    for (var i = 0; i < input.events.length; i += 1) {
      var ev = input.events[i];
      if (!ev || typeof ev !== "object") {
        failed.push({ index: i, reason: "event must be an object" });
        continue;
      }
      if (ruleFilter != null && ev.slug != null && !ruleFilter[ev.slug]) {
        skipped.push({ index: i, slug: ev.slug, reason: "slug not in rules filter" });
        continue;
      }
      try {
        var result = await awardForEvent(ev);
        for (var a = 0; a < result.awarded.length; a += 1) {
          awarded.push({ index: i, award: result.awarded[a] });
          totalPts += result.awarded[a].points;
        }
        for (var s = 0; s < result.skipped.length; s += 1) {
          skipped.push({ index: i, slug: result.skipped[s].slug, reason: result.skipped[s].reason });
        }
      } catch (err) {
        failed.push({ index: i, reason: err && err.message ? err.message : String(err) });
      }
    }

    return {
      total_events:  input.events.length,
      total_points:  totalPts,
      awarded:       awarded,
      skipped:       skipped,
      failed:        failed,
    };
  }

  return {
    TRIGGERS:               TRIGGERS.slice(),
    UNIT_TRIGGERS:          Object.assign({}, UNIT_TRIGGERS),
    MAX_POINTS_PER_UNIT:    MAX_POINTS_PER_UNIT,
    MAX_MAX_PER_EVENT:      MAX_MAX_PER_EVENT,
    MAX_STATUS_LIST:        MAX_STATUS_LIST,

    defineRule:        defineRule,
    getRule:           getRule,
    listRules:         listRules,
    updateRule:        updateRule,
    archiveRule:       archiveRule,
    evaluateForEvent:  evaluateForEvent,
    awardForEvent:     awardForEvent,
    reverseForEvent:   reverseForEvent,
    metricsForRule:    metricsForRule,
    applyBatch:        applyBatch,
  };
}

module.exports = {
  create:                create,
  TRIGGERS:              TRIGGERS,
  UNIT_TRIGGERS:         UNIT_TRIGGERS,
  MAX_POINTS_PER_UNIT:   MAX_POINTS_PER_UNIT,
  MAX_MAX_PER_EVENT:     MAX_MAX_PER_EVENT,
  MAX_STATUS_LIST:       MAX_STATUS_LIST,
};
