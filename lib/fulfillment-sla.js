"use strict";
/**
 * @module shop.fulfillmentSLA
 * @title  Fulfillment SLA — per-order shipping + delivery deadlines
 *
 * @intro
 *   Operators commit to service levels — "standard ships in 48h",
 *   "same-day if placed before 2pm local", "overnight delivers within
 *   24h" — and need to know which orders are breaching that
 *   commitment, by how much, and which policies are the worst
 *   offenders. This primitive owns the policy catalog, the per-order
 *   deadline computation, the breach log, and the on-time-rate /
 *   forecast reads that drive the operator's SLA dashboard.
 *
 *   The shape:
 *
 *     var sla = bShop.fulfillmentSLA.create({
 *       query:         q,
 *       order:         ord,    // optional — lookups when wired
 *       notifications: notif,  // optional — recordBreach fan-out
 *     });
 *
 *     await sla.definePolicy({
 *       slug:                 "std-48",
 *       priority:             "standard",
 *       ship_within_hours:    24,
 *       deliver_within_hours: 48,
 *     });
 *
 *     await sla.definePolicy({
 *       slug:                 "same-day-2pm",
 *       priority:             "same_day",
 *       ship_within_hours:    8,
 *       deliver_within_hours: 24,
 *       cutoff_local_time:    "14:00",
 *       timezone:             "America/Los_Angeles",
 *     });
 *
 *     var ev = await sla.evaluateOrder({
 *       order_id: o,
 *       order_snapshot: { priority: "standard", placed_at: t0 },
 *     });
 *     // { ship_by, deliver_by, hours_to_ship, hours_to_deliver,
 *     //   slack_hours, policy_slug, priority }
 *
 *     await sla.recordBreach({
 *       order_id:    o,
 *       breach_type: "ship",
 *       hours_over:  6.5,
 *     });
 *
 *     await sla.currentBreaches({ severity: "critical" });
 *     await sla.breachesForOrder(o);
 *     await sla.metricsForPolicy({ slug, from, to });
 *     await sla.topBreachingPolicies({ from, to, limit: 5 });
 *     await sla.forecastImpact({ open_orders: [...] });
 *
 *   Policy lookup keys off `priority` — the order snapshot's `priority`
 *   selects the matching active policy. If multiple policies share a
 *   priority (operator A/B-tests two same-day SLAs), the most recently
 *   updated active one wins; that pick is reflected in `policy_slug`
 *   on the evaluation result so the operator can audit which policy
 *   actually drove the deadline.
 *
 *   Deadline math is anchored on `placed_at`, not on a chained-off
 *   ship_by. A handoff slip never silently extends the delivery
 *   commitment.
 *
 *   `cutoff_local_time` (HH:MM) + `timezone` (IANA) define a same-day
 *   cutoff. Orders placed AT or BEFORE the local cutoff use placed_at
 *   as the clock-start; orders placed AFTER roll forward to the next
 *   day's 00:00 local. Same-day / expedited policies typically set the
 *   cutoff; standard / overnight typically don't. Both fields are NULL
 *   for always-on policies; the cutoff math is skipped and placed_at is
 *   the clock start.
 *
 *   Breach severity buckets (derived at insert time so dashboards don't
 *   recompute per fetch):
 *     - minor    — hours_over <  24
 *     - major    — 24 <= hours_over < 72
 *     - critical — hours_over >= 72
 *
 *   Composition:
 *     - b.guardUuid — order_id is UUID-shape validated at the entry
 *       point.
 *     - b.uuid.v7  — breach row PKs (sortable; the breach log read
 *       sorts by id desc as a tiebreaker after recorded_at).
 *     - notifications.enqueue — when wired, every recordBreach enqueues
 *       an operator alert keyed on the policy + severity. The dispatch
 *       is drop-silent inside try/catch so a notifications outage never
 *       refuses a breach record.
 *     - order.get — when wired, evaluateOrder accepts an `order_id`
 *       alone (no snapshot) and resolves the priority + placed_at
 *       through the order primitive; storefronts that pass a snapshot
 *       skip the lookup.
 *
 *   Monotonic clock: operator-driven calls (definePolicy followed by
 *   evaluateOrder in the same millisecond) need strictly-increasing
 *   timestamps so a sort-by-updated_at returns the rows in issue
 *   order. _now() bumps by 1ms on ties.
 *
 * @related   b.uuid, b.guardUuid, order, notifications
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN     = 64;
var MAX_LIST_LIMIT   = 500;
var DEFAULT_LIMIT    = 100;
var MAX_HOURS        = 24 * 365;   // one-year ceiling — anything longer is operator error
var MIN_HOURS        = 0.0001;     // sub-second-granularity guard against zero / negative

var PRIORITIES = Object.freeze(["standard", "expedited", "overnight", "same_day"]);
var BREACH_TYPES = Object.freeze(["ship", "deliver"]);
var SEVERITIES = Object.freeze(["minor", "major", "critical"]);

var SLUG_RE              = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var CUTOFF_RE            = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
var TIMEZONE_RE          = /^[A-Za-z][A-Za-z0-9+_\-/]{0,63}$/;

var MS_PER_HOUR          = C.TIME.hours(1);
var MS_PER_DAY           = 24 * MS_PER_HOUR;

var SEVERITY_MINOR_MAX   = 24;
var SEVERITY_MAJOR_MAX   = 72;

// ---- monotonic clock ----------------------------------------------------
//
// Operator-driven calls land in the same millisecond on fast machines
// (definePolicy followed by evaluateOrder in a test, for instance).
// Bumping by 1ms on a tie keeps the timeline strictly increasing so a
// sort-by-updated_at read returns rows in the order they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _orderId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("fulfillment-sla: order_id — " + (e && e.message || "invalid UUID"));
  }
}

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("fulfillment-sla: " + (label || "slug") +
      " must match /^[a-z0-9][a-z0-9._-]*$/ (≤ " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _priority(s) {
  if (PRIORITIES.indexOf(s) === -1) {
    throw new TypeError("fulfillment-sla: priority must be one of " +
      PRIORITIES.join(", ") + ", got " + JSON.stringify(s));
  }
}

function _breachType(s) {
  if (BREACH_TYPES.indexOf(s) === -1) {
    throw new TypeError("fulfillment-sla: breach_type must be one of " +
      BREACH_TYPES.join(", ") + ", got " + JSON.stringify(s));
  }
}

function _severity(s) {
  if (SEVERITIES.indexOf(s) === -1) {
    throw new TypeError("fulfillment-sla: severity must be one of " +
      SEVERITIES.join(", ") + ", got " + JSON.stringify(s));
  }
}

function _hours(n, label) {
  if (typeof n !== "number" || !isFinite(n) || n < MIN_HOURS || n > MAX_HOURS) {
    throw new TypeError("fulfillment-sla: " + label +
      " must be a finite number in (" + MIN_HOURS + ", " + MAX_HOURS + "]");
  }
}

function _hoursOver(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0 || n > MAX_HOURS) {
    throw new TypeError("fulfillment-sla: hours_over must be a non-negative finite number ≤ " + MAX_HOURS);
  }
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("fulfillment-sla: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _cutoffLocalTime(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !CUTOFF_RE.test(s)) {
    throw new TypeError("fulfillment-sla: cutoff_local_time must be HH:MM (24h), got " + JSON.stringify(s));
  }
  return s;
}

function _timezone(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !TIMEZONE_RE.test(s)) {
    throw new TypeError("fulfillment-sla: timezone must be an IANA-shape name (alnum + + _ - /), got " + JSON.stringify(s));
  }
  // Validate the zone is actually recognised by the runtime — an
  // operator that misspells "Americ/Los_Angeles" gets the typo caught
  // at definePolicy time rather than at evaluateOrder time. Skipped
  // when the zone is the special "UTC" alias which every runtime
  // supports.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
  } catch (_e) {
    throw new TypeError("fulfillment-sla: timezone " + JSON.stringify(s) +
      " is not recognised by the runtime ICU data");
  }
  return s;
}

function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("fulfillment-sla: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}

// ---- helpers -----------------------------------------------------------

function _severityFor(hoursOver) {
  if (hoursOver < SEVERITY_MINOR_MAX) return "minor";
  if (hoursOver < SEVERITY_MAJOR_MAX) return "major";
  return "critical";
}

// Compute the clock-start for SLA math given the order's placed_at, the
// optional cutoff (HH:MM local), and the IANA timezone. Orders placed
// at or before the cutoff anchor on placed_at directly; orders placed
// AFTER the cutoff roll forward to the next local-day's 00:00. Returns
// epoch ms.
//
// The Intl-based local-time parse is exact (no floating-point drift)
// because the runtime's ICU is the same source of truth used to render
// the operator's dashboard.
function _clockStart(placedAt, cutoffLocalTime, timezone) {
  if (cutoffLocalTime == null || timezone == null) return placedAt;

  var parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(placedAt));
  var byType = {};
  for (var i = 0; i < parts.length; i += 1) {
    byType[parts[i].type] = parts[i].value;
  }
  var localHour   = Number(byType.hour);
  var localMinute = Number(byType.minute);
  var cutoffParts = cutoffLocalTime.split(":");
  var cutoffHour   = Number(cutoffParts[0]);
  var cutoffMinute = Number(cutoffParts[1]);

  var localTotalMin   = localHour * 60 + localMinute;
  var cutoffTotalMin  = cutoffHour * 60 + cutoffMinute;

  if (localTotalMin <= cutoffTotalMin) {
    // Placed before/at the cutoff — same-day clock-start at placed_at.
    return placedAt;
  }

  // Placed after — roll forward to next local day's 00:00.
  // Strategy: add 24h to placed_at, then "snap" to local-midnight by
  // subtracting the local time-of-day for that rolled-forward moment.
  var nextDayMs = placedAt + MS_PER_DAY;
  var nextParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(nextDayMs));
  var nextByType = {};
  for (var j = 0; j < nextParts.length; j += 1) {
    nextByType[nextParts[j].type] = nextParts[j].value;
  }
  var nextHour   = Number(nextByType.hour);
  var nextMinute = Number(nextByType.minute);
  var nextSecond = Number(nextByType.second);
  // allow:raw-time-literal — converts a runtime-computed local time-of-day (h/m/s) to ms; not a fixed duration C.TIME can express
  var localOffsetMs = (nextHour * 3600 + nextMinute * 60 + nextSecond) * 1000;
  return nextDayMs - localOffsetMs;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // order is optional — when wired, evaluateOrder accepts an `order_id`
  // alone and resolves priority + placed_at through `order.get`.
  // Storefronts that already hold a snapshot skip the lookup.
  var orderPrim = opts.order || null;
  if (orderPrim && typeof orderPrim.get !== "function") {
    throw new TypeError("fulfillment-sla.create: opts.order must expose a get(order_id) method");
  }

  // notifications is optional — recordBreach fan-out. Drop-silent on
  // outage so a notifications failure never refuses a breach record.
  var notifications = opts.notifications || null;
  if (notifications && typeof notifications.enqueue !== "function") {
    throw new TypeError("fulfillment-sla.create: opts.notifications must expose an enqueue(input) method");
  }

  // Look up the active policy for a priority. Most-recently-updated
  // active row wins when multiple policies share a priority (operator
  // A/B-testing).
  async function _policyForPriority(priority) {
    var r = await query(
      "SELECT * FROM fulfillment_sla_policies " +
      "WHERE priority = ?1 AND archived_at IS NULL " +
      "ORDER BY updated_at DESC, slug ASC LIMIT 1",
      [priority],
    );
    return r.rows[0] || null;
  }

  async function _policyBySlug(slug) {
    var r = await query("SELECT * FROM fulfillment_sla_policies WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  // Resolve the (priority, placed_at) pair from a caller-supplied
  // snapshot OR via the wired `order.get` handle. The snapshot always
  // wins when present so storefronts that already hold the order
  // don't pay for a second read.
  async function _resolveSnapshot(input) {
    if (input.order_snapshot && typeof input.order_snapshot === "object") {
      _priority(input.order_snapshot.priority);
      _epochMs(input.order_snapshot.placed_at, "order_snapshot.placed_at");
      return {
        priority:  input.order_snapshot.priority,
        placed_at: input.order_snapshot.placed_at,
      };
    }
    if (!orderPrim) {
      throw new TypeError("fulfillment-sla.evaluateOrder: order_snapshot required when no order handle is wired");
    }
    var row = await orderPrim.get(input.order_id);
    if (!row) {
      throw new TypeError("fulfillment-sla.evaluateOrder: order " + input.order_id + " not found via order.get");
    }
    _priority(row.priority);
    _epochMs(row.placed_at, "order.placed_at");
    return { priority: row.priority, placed_at: row.placed_at };
  }

  return {
    // Upsert a per-priority policy. Re-defining the same slug updates
    // the deadline fields + cutoff in place; `archived_at` is cleared
    // so a re-define un-archives a previously-archived policy.
    definePolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("fulfillment-sla.definePolicy: input object required");
      }
      var slug = _slug(input.slug, "slug");
      _priority(input.priority);
      _hours(input.ship_within_hours,    "ship_within_hours");
      _hours(input.deliver_within_hours, "deliver_within_hours");
      if (input.deliver_within_hours < input.ship_within_hours) {
        throw new TypeError("fulfillment-sla.definePolicy: deliver_within_hours must be >= ship_within_hours");
      }
      var cutoff = _cutoffLocalTime(input.cutoff_local_time);
      var tz     = _timezone(input.timezone);
      // Both-or-neither: cutoff requires a timezone (otherwise the
      // interpretation is ambiguous); a bare timezone with no cutoff
      // is meaningless. Refuse the half-configured form at define-time.
      if ((cutoff == null) !== (tz == null)) {
        throw new TypeError("fulfillment-sla.definePolicy: cutoff_local_time and timezone must both be set or both be omitted");
      }
      var ts = _now();
      var existing = await _policyBySlug(slug);
      if (existing) {
        await query(
          "UPDATE fulfillment_sla_policies SET priority = ?1, ship_within_hours = ?2, " +
          "deliver_within_hours = ?3, cutoff_local_time = ?4, timezone = ?5, " +
          "archived_at = NULL, updated_at = ?6 WHERE slug = ?7",
          [input.priority, input.ship_within_hours, input.deliver_within_hours,
            cutoff, tz, ts, slug],
        );
      } else {
        await query(
          "INSERT INTO fulfillment_sla_policies (slug, priority, ship_within_hours, " +
          "deliver_within_hours, cutoff_local_time, timezone, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
          [slug, input.priority, input.ship_within_hours, input.deliver_within_hours,
            cutoff, tz, ts],
        );
      }
      return await _policyBySlug(slug);
    },

    // Soft-delete a policy. Historical breaches still resolve their
    // policy_slug; future evaluateOrder calls won't pick the archived
    // row.
    archivePolicy: async function (slug) {
      _slug(slug, "slug");
      var ts = _now();
      var r = await query(
        "UPDATE fulfillment_sla_policies SET archived_at = ?1, updated_at = ?1 " +
        "WHERE slug = ?2 AND archived_at IS NULL",
        [ts, slug],
      );
      if (r.rowCount === 0) return null;
      return await _policyBySlug(slug);
    },

    getPolicy: async function (slug) {
      _slug(slug, "slug");
      return await _policyBySlug(slug);
    },

    listPolicies: async function (listOpts) {
      listOpts = listOpts || {};
      var includeArchived = listOpts.include_archived === true;
      var sql, params;
      if (includeArchived) {
        sql = "SELECT * FROM fulfillment_sla_policies ORDER BY priority ASC, updated_at DESC";
        params = [];
      } else {
        sql = "SELECT * FROM fulfillment_sla_policies WHERE archived_at IS NULL " +
              "ORDER BY priority ASC, updated_at DESC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    // Pure read — computes the SLA-derived deadlines for one order
    // without writing anything. Caller can pass `order_snapshot` to
    // skip the order.get round-trip; otherwise the wired order handle
    // is required.
    //
    // Returns:
    //   {
    //     ship_by, deliver_by,           // epoch ms deadlines
    //     hours_to_ship, hours_to_deliver, // policy values (mirrored)
    //     slack_hours,                   // until the EARLIEST deadline
    //                                    // — negative means breached
    //     clock_start_at,                // epoch ms (cutoff-adjusted)
    //     policy_slug, priority,
    //   }
    //
    // No policy for the priority → returns { status: "no_policy",
    // priority } so the caller can surface "operator hasn't defined
    // an SLA for expedited yet" without an exception.
    evaluateOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("fulfillment-sla.evaluateOrder: input object required");
      }
      var orderId = _orderId(input.order_id);
      var snap = await _resolveSnapshot(input);
      var policy = await _policyForPriority(snap.priority);
      if (!policy) {
        return { status: "no_policy", order_id: orderId, priority: snap.priority };
      }
      var clockStart = _clockStart(snap.placed_at, policy.cutoff_local_time, policy.timezone);
      var shipBy    = clockStart + policy.ship_within_hours    * MS_PER_HOUR;
      var deliverBy = clockStart + policy.deliver_within_hours * MS_PER_HOUR;
      // Slack measured against the EARLIEST deadline so the caller's
      // dashboard "next due" column is correct regardless of which
      // half of the SLA is the binding one. A negative slack means
      // the order has already breached at least one deadline.
      var earliestDeadline = Math.min(shipBy, deliverBy);
      var slackHours = (earliestDeadline - _now()) / MS_PER_HOUR;
      return {
        status:              "evaluated",
        order_id:            orderId,
        priority:            snap.priority,
        policy_slug:         policy.slug,
        placed_at:           snap.placed_at,
        clock_start_at:      clockStart,
        ship_by:             shipBy,
        deliver_by:          deliverBy,
        hours_to_ship:       policy.ship_within_hours,
        hours_to_deliver:    policy.deliver_within_hours,
        slack_hours:         slackHours,
      };
    },

    // Append a breach row. Severity is derived from hours_over at
    // insert time. When `notifications` is wired, every breach
    // enqueues an operator alert; failure to enqueue is drop-silent
    // so a notifications outage never refuses the breach record.
    //
    // Caller passes `policy_slug` to bind the breach to a specific
    // policy; absent, the priority lookup re-resolves the active
    // policy. Refuses when no policy matches (a breach can't exist
    // without a policy to breach against).
    recordBreach: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("fulfillment-sla.recordBreach: input object required");
      }
      var orderId = _orderId(input.order_id);
      _breachType(input.breach_type);
      _hoursOver(input.hours_over);
      var policy = null;
      if (input.policy_slug != null) {
        _slug(input.policy_slug, "policy_slug");
        policy = await _policyBySlug(input.policy_slug);
        if (!policy) {
          throw new TypeError("fulfillment-sla.recordBreach: policy_slug " +
            JSON.stringify(input.policy_slug) + " not found");
        }
      } else if (input.priority != null) {
        _priority(input.priority);
        policy = await _policyForPriority(input.priority);
        if (!policy) {
          throw new TypeError("fulfillment-sla.recordBreach: no active policy for priority " +
            JSON.stringify(input.priority));
        }
      } else {
        throw new TypeError("fulfillment-sla.recordBreach: policy_slug or priority required");
      }
      var severity = _severityFor(input.hours_over);
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO fulfillment_sla_breaches (id, order_id, policy_slug, breach_type, " +
        "hours_over, severity, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, orderId, policy.slug, input.breach_type, input.hours_over, severity, ts],
      );
      if (notifications) {
        try {
          await notifications.enqueue({
            recipient_id: orderId,
            channel:      "sla-breach",
            event_type:   "sla_breach_recorded",
            title:        "SLA breach (" + severity + ")",
            body:         "",
            payload: {
              order_id:    orderId,
              policy_slug: policy.slug,
              breach_type: input.breach_type,
              hours_over:  input.hours_over,
              severity:    severity,
            },
            scheduled_at: ts,
          });
        } catch (_e) { /* drop-silent — notifications outage must not refuse the breach record */ }
      }
      return {
        id:           id,
        order_id:     orderId,
        policy_slug:  policy.slug,
        breach_type:  input.breach_type,
        hours_over:   input.hours_over,
        severity:     severity,
        recorded_at:  ts,
      };
    },

    // Newest first. Severity filter is optional — absent returns all
    // current breaches across the catalog, capped by `limit`
    // (default 100, max 500).
    currentBreaches: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? DEFAULT_LIMIT : listOpts.limit;
      _limit(limit);
      var sql, params;
      if (listOpts.severity != null) {
        _severity(listOpts.severity);
        sql = "SELECT * FROM fulfillment_sla_breaches WHERE severity = ?1 " +
              "ORDER BY recorded_at DESC, id DESC LIMIT ?2";
        params = [listOpts.severity, limit];
      } else {
        sql = "SELECT * FROM fulfillment_sla_breaches " +
              "ORDER BY recorded_at DESC, id DESC LIMIT ?1";
        params = [limit];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    breachesForOrder: async function (orderId) {
      var id = _orderId(orderId);
      var r = await query(
        "SELECT * FROM fulfillment_sla_breaches WHERE order_id = ?1 " +
        "ORDER BY recorded_at DESC, id DESC",
        [id],
      );
      return r.rows;
    },

    // On-time rate + lateness aggregate for one policy over [from, to].
    // The breach log only contains breaches (by construction); the
    // on-time count is supplied by the caller via `total_orders`
    // (e.g. derived from the order primitive). Absent total_orders,
    // the on_time_rate is reported as null with a note so the operator
    // dashboard can fall back to showing breach counts alone.
    metricsForPolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("fulfillment-sla.metricsForPolicy: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var from = input.from; _epochMs(from, "from");
      var to   = input.to;   _epochMs(to,   "to");
      if (from > to) {
        throw new TypeError("fulfillment-sla.metricsForPolicy: from must be <= to");
      }
      var totalOrders = null;
      if (input.total_orders != null) {
        if (!Number.isInteger(input.total_orders) || input.total_orders < 0) {
          throw new TypeError("fulfillment-sla.metricsForPolicy: total_orders must be a non-negative integer or null");
        }
        totalOrders = input.total_orders;
      }
      // Aggregate breach counts + average lateness — one SQL pass
      // grouped by severity so dashboards can render the breakdown
      // without a second round-trip.
      var r = await query(
        "SELECT severity, COUNT(*) AS n, SUM(hours_over) AS sum_hours, " +
        "MAX(hours_over) AS max_hours FROM fulfillment_sla_breaches " +
        "WHERE policy_slug = ?1 AND recorded_at >= ?2 AND recorded_at <= ?3 " +
        "GROUP BY severity",
        [slug, from, to],
      );
      var bySev = { minor: 0, major: 0, critical: 0 };
      var sumHours = 0;
      var maxHours = 0;
      var totalBreaches = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        bySev[row.severity] = Number(row.n);
        sumHours += Number(row.sum_hours) || 0;
        if (Number(row.max_hours) > maxHours) maxHours = Number(row.max_hours);
        totalBreaches += Number(row.n);
      }
      var avgLateness = totalBreaches === 0 ? 0 : sumHours / totalBreaches;
      var onTimeRate = null;
      if (totalOrders != null && totalOrders > 0) {
        // Each breach corresponds to one order failing one deadline.
        // An order with two breach rows (ship + deliver) counts as
        // one breaching order — dedup by order_id for the on-time
        // rate denominator.
        var dedupQuery = await query(
          "SELECT COUNT(DISTINCT order_id) AS n FROM fulfillment_sla_breaches " +
          "WHERE policy_slug = ?1 AND recorded_at >= ?2 AND recorded_at <= ?3",
          [slug, from, to],
        );
        var breachingOrders = Number(dedupQuery.rows[0].n) || 0;
        var onTime = Math.max(0, totalOrders - breachingOrders);
        onTimeRate = totalOrders === 0 ? 0 : onTime / totalOrders;
      }
      return {
        policy_slug:        slug,
        from:               from,
        to:                 to,
        total_breaches:     totalBreaches,
        by_severity:        bySev,
        average_lateness_hours: avgLateness,
        worst_lateness_hours:   maxHours,
        on_time_rate:       onTimeRate,
        total_orders:       totalOrders,
      };
    },

    // Top N policies by breach count over [from, to]. Returns one row
    // per policy_slug with the count + average lateness so the
    // operator's "worst offenders" view ranks without a per-policy
    // metricsForPolicy fan-out.
    topBreachingPolicies: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("fulfillment-sla.topBreachingPolicies: input object required");
      }
      var from = input.from; _epochMs(from, "from");
      var to   = input.to;   _epochMs(to,   "to");
      if (from > to) {
        throw new TypeError("fulfillment-sla.topBreachingPolicies: from must be <= to");
      }
      var limit = input.limit == null ? DEFAULT_LIMIT : input.limit;
      _limit(limit);
      var r = await query(
        "SELECT policy_slug, COUNT(*) AS breach_count, AVG(hours_over) AS avg_hours_over, " +
        "MAX(hours_over) AS worst_hours_over FROM fulfillment_sla_breaches " +
        "WHERE recorded_at >= ?1 AND recorded_at <= ?2 " +
        "GROUP BY policy_slug ORDER BY breach_count DESC, policy_slug ASC LIMIT ?3",
        [from, to, limit],
      );
      return r.rows.map(function (row) {
        return {
          policy_slug:        row.policy_slug,
          breach_count:       Number(row.breach_count),
          average_lateness_hours: Number(row.avg_hours_over) || 0,
          worst_lateness_hours:   Number(row.worst_hours_over) || 0,
        };
      });
    },

    // Predicts which OPEN orders will breach. Caller supplies the
    // open-order snapshots (no read against an external order primitive
    // because the caller often holds an in-process page of open orders
    // already). For each snapshot we re-evaluate the SLA against
    // `now`, classify into:
    //   - already_breached  (negative slack)
    //   - at_risk           (slack < at_risk_hours, default 6)
    //   - on_track          (slack >= at_risk_hours)
    //   - no_policy         (no active policy for the priority)
    // Returns a per-bucket breakdown + the per-order detail.
    forecastImpact: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("fulfillment-sla.forecastImpact: input object required");
      }
      if (!Array.isArray(input.open_orders)) {
        throw new TypeError("fulfillment-sla.forecastImpact: open_orders must be an array");
      }
      var atRiskHours = input.at_risk_hours == null ? 6 : input.at_risk_hours;
      if (typeof atRiskHours !== "number" || !isFinite(atRiskHours) || atRiskHours < 0) {
        throw new TypeError("fulfillment-sla.forecastImpact: at_risk_hours must be a non-negative finite number");
      }
      var buckets = { already_breached: [], at_risk: [], on_track: [], no_policy: [] };
      for (var i = 0; i < input.open_orders.length; i += 1) {
        var snap = input.open_orders[i];
        if (!snap || typeof snap !== "object") {
          throw new TypeError("fulfillment-sla.forecastImpact: open_orders[" + i + "] must be an object");
        }
        var orderId = _orderId(snap.order_id);
        _priority(snap.priority);
        _epochMs(snap.placed_at, "open_orders[" + i + "].placed_at");
        var policy = await _policyForPriority(snap.priority);
        if (!policy) {
          buckets.no_policy.push({ order_id: orderId, priority: snap.priority });
          continue;
        }
        var clockStart = _clockStart(snap.placed_at, policy.cutoff_local_time, policy.timezone);
        var shipBy    = clockStart + policy.ship_within_hours    * MS_PER_HOUR;
        var deliverBy = clockStart + policy.deliver_within_hours * MS_PER_HOUR;
        var earliest = Math.min(shipBy, deliverBy);
        var slack = (earliest - _now()) / MS_PER_HOUR;
        var detail = {
          order_id:     orderId,
          priority:     snap.priority,
          policy_slug:  policy.slug,
          ship_by:      shipBy,
          deliver_by:   deliverBy,
          slack_hours:  slack,
        };
        if (slack < 0) {
          buckets.already_breached.push(detail);
        } else if (slack < atRiskHours) {
          buckets.at_risk.push(detail);
        } else {
          buckets.on_track.push(detail);
        }
      }
      return {
        already_breached_count: buckets.already_breached.length,
        at_risk_count:          buckets.at_risk.length,
        on_track_count:         buckets.on_track.length,
        no_policy_count:        buckets.no_policy.length,
        at_risk_hours:          atRiskHours,
        already_breached:       buckets.already_breached,
        at_risk:                buckets.at_risk,
        on_track:               buckets.on_track,
        no_policy:              buckets.no_policy,
      };
    },
  };
}

module.exports = {
  create:         create,
  PRIORITIES:     PRIORITIES.slice(),
  BREACH_TYPES:   BREACH_TYPES.slice(),
  SEVERITIES:     SEVERITIES.slice(),
  MAX_SLUG_LEN:   MAX_SLUG_LEN,
  MAX_LIST_LIMIT: MAX_LIST_LIMIT,
  DEFAULT_LIMIT:  DEFAULT_LIMIT,
};
