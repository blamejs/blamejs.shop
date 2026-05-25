"use strict";
/**
 * @module shop.emailWarmup
 * @title  Email warmup — gradual SMTP IP / domain warmup schedules
 *
 * @intro
 *   Operator brings up a new sending IP or sending domain — direct
 *   high-volume traffic at it on day one and the mailbox providers
 *   bucket the sender as "cold" or worse, "snowshoe spammer". The
 *   industry workaround is a multi-week ramp: a handful of sends on
 *   day one, a few hundred on day two, low thousands by week's end,
 *   tens of thousands by week three. `emailWarmup` owns the schedule
 *   + the per-day gate.
 *
 *   The two sibling marketing surfaces — `emailCampaigns` (operator-
 *   scheduled bulk sends) and `dunning` (subscription past-due
 *   reminders) — consult `canSend({ slug, count_planned })` before
 *   each batch. The gate answers in one shape:
 *
 *     { ok, sends_used_today, daily_target, remaining }
 *
 *   `ok` is true iff the schedule is active, the calendar day is
 *   within the ramp window (`day_index` ≤ `daily_targets.length`),
 *   and `sends_used_today + count_planned ≤ daily_target`. When ok is
 *   false the caller defers — queue the message for tomorrow, page
 *   the operator, or fall back to a non-warming sender — but the
 *   primitive doesn't itself queue. After a successful batch the
 *   caller invokes `recordSends({ slug, count })` to bump the
 *   ledger; subsequent `canSend` calls reflect the new total.
 *
 *   Composition:
 *
 *     var warmup = bShop.emailWarmup.create({ query: q });
 *
 *     await warmup.defineSchedule({
 *       slug:                   "release-ip-2026",
 *       sender_domain:          "release.shop.example",
 *       sender_ip:              "192.0.2.42",                      // optional
 *       start_date:             "2026-05-22",
 *       daily_targets:          [50, 100, 250, 500, 1000, 2000, 4000,
 *                                8000, 16000, 32000, 50000, 50000],
 *       status_check_threshold: 200,                                // 2.0% bps
 *     });
 *
 *     var verdict = await warmup.canSend({
 *       slug:           "release-ip-2026",
 *       count_planned:  40,
 *     });
 *     if (!verdict.ok) defer();
 *     else send40Messages();
 *     await warmup.recordSends({ slug: "release-ip-2026", count: 40 });
 *
 *     // FSM transitions:
 *     await warmup.pauseSchedule({
 *       slug:    "release-ip-2026",
 *       reason:  "bounce spike — investigating",
 *     });
 *     await warmup.resumeSchedule({ slug: "release-ip-2026" });
 *     await warmup.archiveSchedule("release-ip-2026");
 *
 *     // Listings + per-day rollup:
 *     await warmup.listSchedules({ active_only: true });
 *     await warmup.metricsForSchedule("release-ip-2026");
 *
 *   Day-index math:
 *     The schedule's `start_date` is the operator's chosen Day 1.
 *     `currentDay(slug, now?)` returns the 1-based ordinal computed
 *     from UTC midnight diff between `start_date` and `now`:
 *
 *       day_index = floor((now_utc_midnight - start_utc_midnight) / 1d) + 1
 *
 *     Day 1 starts at the UTC midnight of `start_date`. A `now` that
 *     falls before `start_date` returns 0 (schedule hasn't begun);
 *     a `now` that falls beyond the ramp returns `length + 1`
 *     ("ramp complete"). `canSend` refuses sends in both of those
 *     out-of-window cases — pre-ramp is "not yet"; post-ramp is "the
 *     gate has retired, the operator should archive or graduate the
 *     sender to non-warming".
 *
 *   Storage:
 *     - email_warmup_schedules + email_warmup_daily_sends
 *       (migration 0116_email_warmup.sql).
 *
 *   Bounce + complaint rate is reported by `metricsForSchedule` per
 *   day; the gate (auto-pause when threshold is breached) is operator
 *   policy outside this primitive — same posture as fraud-screen +
 *   refund-policy.
 *
 * @primitive emailWarmup
 * @related   emailCampaigns, dunning, b.uuid.v7
 */

// ---- constants ----------------------------------------------------------

var b = require("./vendor/blamejs");

var C = b.constants;

var MAX_SLUG_LEN          = 80;
var MAX_DAILY_TARGETS     = 365;          // a year of ramp ceiling — operator schedule, not framework
var MAX_DAILY_TARGET      = 10000000;     // 10M sends in one day — well above any reasonable IP ceiling
var MAX_THRESHOLD_BPS     = 10000;        // 100.0% in basis points
var MAX_REASON_LEN        = 280;
var MAX_LIST_LIMIT        = 500;
var MAX_DOMAIN_LEN        = 253;          // DNS hostname cap
var MAX_IP_LEN            = 45;           // IPv6 max textual length
var MS_PER_DAY            = C.TIME.days(1);

var SLUG_RE          = /^[a-z0-9][a-z0-9._-]{0,79}$/;
// Lowercase domain — IDN punycode + alnum + hyphen + dot, ending in a
// 2+ alpha TLD. Same shape as tenants.DOMAIN_RE so the two primitives
// agree on what a sender domain looks like.
var DOMAIN_RE        = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
// IPv4 dotted-quad or IPv6 textual. Loose enough to admit every
// legitimate sender IP; strict enough to refuse arbitrary strings
// passed where an IP belongs.
var IPV4_RE          = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
var IPV6_RE          = /^[0-9a-f:]+$/;
var ISO_DATE_RE      = /^\d{4}-\d{2}-\d{2}$/;

var CONTROL_BYTE_RE  = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE    = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_STATUSES = Object.freeze(["active", "paused", "archived"]);

// FSM transition graph. Archived is terminal — no outbound edges.
var TRANSITIONS = Object.freeze({
  active:   { pause: "paused",   resume: null,     archive: "archived" },
  paused:   { pause: null,       resume: "active", archive: "archived" },
  archived: { pause: null,       resume: null,     archive: null      },
});

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("emailWarmup: " + (label || "slug") +
      " must match /^[a-z0-9][a-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _senderDomain(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_DOMAIN_LEN) {
    throw new TypeError("emailWarmup: sender_domain must be a non-empty string <= " + MAX_DOMAIN_LEN + " chars");
  }
  var lower = s.toLowerCase();
  if (!DOMAIN_RE.test(lower)) {
    throw new TypeError("emailWarmup: sender_domain must be a lowercase DNS hostname");
  }
  return lower;
}

function _senderIp(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_IP_LEN) {
    throw new TypeError("emailWarmup: sender_ip must be a non-empty string <= " + MAX_IP_LEN + " chars when provided");
  }
  var lower = s.toLowerCase();
  if (IPV4_RE.test(lower)) return lower;
  if (IPV6_RE.test(lower) && lower.indexOf(":") !== -1) return lower;
  throw new TypeError("emailWarmup: sender_ip must be a valid IPv4 dotted-quad or IPv6 textual form");
}

function _isoDate(s, label) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) {
    throw new TypeError("emailWarmup: " + label + " must be an ISO YYYY-MM-DD date string");
  }
  // Use Date.UTC to refuse impossible calendar dates (2026-02-31, etc.).
  var parts = s.split("-");
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  var ts = Date.UTC(y, m - 1, d);
  var back = new Date(ts);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new TypeError("emailWarmup: " + label + " is not a valid calendar date");
  }
  return s;
}

function _dailyTargets(arr) {
  if (!Array.isArray(arr) || !arr.length) {
    throw new TypeError("emailWarmup: daily_targets must be a non-empty array of positive integers");
  }
  if (arr.length > MAX_DAILY_TARGETS) {
    throw new TypeError("emailWarmup: daily_targets must be <= " + MAX_DAILY_TARGETS + " entries");
  }
  for (var i = 0; i < arr.length; i += 1) {
    var n = arr[i];
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY_TARGET) {
      throw new TypeError("emailWarmup: daily_targets[" + i + "] must be an integer in [1, " + MAX_DAILY_TARGET + "]");
    }
  }
  // Defensive clone so the caller can't mutate the persisted ramp
  // after defineSchedule returns.
  return arr.slice();
}

function _thresholdBps(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_THRESHOLD_BPS) {
    throw new TypeError("emailWarmup: status_check_threshold must be an integer in [0, " + MAX_THRESHOLD_BPS + "] (basis points)");
  }
  return n;
}

function _posInt(n, label) {
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError("emailWarmup: " + label + " must be a positive integer");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("emailWarmup: " + label + " must be a non-negative integer");
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("emailWarmup: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailWarmup: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("emailWarmup: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("emailWarmup: reason contains control / zero-width bytes");
  }
  return s;
}

// ---- date math ----------------------------------------------------------

function _isoFromMs(ms) {
  var d = new Date(ms);
  var y = d.getUTCFullYear();
  var m = d.getUTCMonth() + 1;
  var dd = d.getUTCDate();
  var mm = m < 10 ? "0" + m : String(m);
  var dds = dd < 10 ? "0" + dd : String(dd);
  return y + "-" + mm + "-" + dds;
}

function _midnightUtcMs(iso) {
  var parts = iso.split("-");
  return Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

// Day-index from start_date + now. Day 1 starts at UTC midnight of
// start_date. Returns 0 when now is before start_date; returns
// (targets.length + 1) when now is beyond the last day of the ramp.
function _computeDayIndex(startIso, nowMs) {
  var startMs   = _midnightUtcMs(startIso);
  var nowMidIso = _isoFromMs(nowMs);
  var nowMidMs  = _midnightUtcMs(nowMidIso);
  if (nowMidMs < startMs) return 0;
  var diffDays = Math.floor((nowMidMs - startMs) / MS_PER_DAY);
  return diffDays + 1;
}

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  var targets;
  try { targets = JSON.parse(r.daily_targets_json); }
  catch (_e) { targets = []; }
  return {
    slug:                    r.slug,
    sender_domain:           r.sender_domain,
    sender_ip:               r.sender_ip == null ? null : r.sender_ip,
    start_date:              r.start_date,
    daily_targets:           targets,
    status_check_threshold:  Number(r.status_check_threshold),
    status:                  r.status,
    paused_reason:           r.paused_reason == null ? null : r.paused_reason,
    paused_at:               r.paused_at   == null ? null : Number(r.paused_at),
    archived_at:             r.archived_at == null ? null : Number(r.archived_at),
    created_at:              Number(r.created_at),
    updated_at:              Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var nowFn = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };

  async function _getRow(slug) {
    var r = await query(
      "SELECT * FROM email_warmup_schedules WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function _getDailyRow(slug, isoDate) {
    var r = await query(
      "SELECT * FROM email_warmup_daily_sends " +
      "WHERE schedule_slug = ?1 AND occurred_date = ?2 LIMIT 1",
      [slug, isoDate],
    );
    return r.rows[0] || null;
  }

  // -- defineSchedule ----------------------------------------------------

  async function defineSchedule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailWarmup.defineSchedule: input object required");
    }
    var slug          = _slug(input.slug);
    var senderDomain  = _senderDomain(input.sender_domain);
    var senderIp      = _senderIp(input.sender_ip == null ? null : input.sender_ip);
    var startDate     = _isoDate(input.start_date, "start_date");
    var dailyTargets  = _dailyTargets(input.daily_targets);
    var threshold     = _thresholdBps(input.status_check_threshold);

    var existing = await _getRow(slug);
    if (existing) {
      throw new TypeError(
        "emailWarmup.defineSchedule: slug " + JSON.stringify(slug) +
        " already exists in status " + JSON.stringify(existing.status) +
        " — archive the existing schedule and pick a new slug"
      );
    }

    var ts = nowFn();
    await query(
      "INSERT INTO email_warmup_schedules " +
      "(slug, sender_domain, sender_ip, start_date, daily_targets_json, " +
      "status_check_threshold, status, paused_reason, paused_at, archived_at, " +
      "created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', NULL, NULL, NULL, ?7, ?7)",
      [slug, senderDomain, senderIp, startDate, JSON.stringify(dailyTargets), threshold, ts],
    );
    return _hydrateRow(await _getRow(slug));
  }

  // -- canSend -----------------------------------------------------------

  // Returns the per-day gate verdict for a planned batch. Shape:
  //
  //   {
  //     ok:                bool,
  //     sends_used_today:  int,    // count already recorded today
  //     daily_target:      int,    // 0 when out-of-window
  //     remaining:         int,    // 0 when ok=false
  //     day_index:         int,    // 0 = pre-ramp; > length = post-ramp
  //     reason:            string, // 'ok' | 'pre_ramp' | 'post_ramp' |
  //                                // 'paused' | 'archived' | 'over_cap' |
  //                                // 'unknown_schedule'
  //   }
  //
  // The caller treats `ok=false` as "defer / use a fallback sender";
  // the `reason` lets operators observe WHY the gate refused.
  async function canSend(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailWarmup.canSend: input object required");
    }
    _slug(input.slug);
    var planned = input.count_planned == null ? 1 : _posInt(input.count_planned, "count_planned");
    var nowMs   = input.now == null ? nowFn() : _epochMs(input.now, "now");

    var row = await _getRow(input.slug);
    if (!row) {
      return {
        ok:               false,
        sends_used_today: 0,
        daily_target:     0,
        remaining:        0,
        day_index:        0,
        reason:           "unknown_schedule",
      };
    }
    if (row.status === "paused") {
      return {
        ok:               false,
        sends_used_today: 0,
        daily_target:     0,
        remaining:        0,
        day_index:        0,
        reason:           "paused",
      };
    }
    if (row.status === "archived") {
      return {
        ok:               false,
        sends_used_today: 0,
        daily_target:     0,
        remaining:        0,
        day_index:        0,
        reason:           "archived",
      };
    }

    var targets   = JSON.parse(row.daily_targets_json);
    var dayIndex  = _computeDayIndex(row.start_date, nowMs);
    if (dayIndex <= 0) {
      return {
        ok:               false,
        sends_used_today: 0,
        daily_target:     0,
        remaining:        0,
        day_index:        dayIndex,
        reason:           "pre_ramp",
      };
    }
    if (dayIndex > targets.length) {
      return {
        ok:               false,
        sends_used_today: 0,
        daily_target:     0,
        remaining:        0,
        day_index:        dayIndex,
        reason:           "post_ramp",
      };
    }

    var target   = targets[dayIndex - 1];
    var todayIso = _isoFromMs(nowMs);
    var daily    = await _getDailyRow(input.slug, todayIso);
    var used     = daily ? Number(daily.sends_count) : 0;
    var remaining = target - used;
    if (remaining < 0) remaining = 0;

    if (used + planned > target) {
      return {
        ok:               false,
        sends_used_today: used,
        daily_target:     target,
        remaining:        remaining,
        day_index:        dayIndex,
        reason:           "over_cap",
      };
    }
    return {
      ok:               true,
      sends_used_today: used,
      daily_target:     target,
      remaining:        remaining,
      day_index:        dayIndex,
      reason:           "ok",
    };
  }

  // -- recordSends -------------------------------------------------------

  // Upsert the per-day send count. Refuses on unknown / paused /
  // archived schedule because recording sends against a non-active
  // ramp is a caller bug (the caller should have observed `canSend`
  // returning ok=false and not actually sent). The function is the
  // hot-path bookkeeping companion to canSend — but it still THROWS
  // on bad inputs (config-time / entry-point tier, not observability-
  // sink tier) so a typo'd slug surfaces immediately.
  async function recordSends(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailWarmup.recordSends: input object required");
    }
    _slug(input.slug);
    var count    = _posInt(input.count, "count");
    var occurred = input.occurred_at == null ? nowFn() : _epochMs(input.occurred_at, "occurred_at");

    var row = await _getRow(input.slug);
    if (!row) {
      throw new TypeError("emailWarmup.recordSends: slug " + JSON.stringify(input.slug) + " not found");
    }
    if (row.status !== "active") {
      throw new TypeError(
        "emailWarmup.recordSends: cannot record sends against a schedule in status " +
        JSON.stringify(row.status)
      );
    }

    var iso       = _isoFromMs(occurred);
    var dayIndex  = _computeDayIndex(row.start_date, occurred);
    if (dayIndex <= 0) {
      throw new TypeError("emailWarmup.recordSends: occurred_at is before start_date for slug " + JSON.stringify(input.slug));
    }
    var ts = nowFn();
    var existing = await _getDailyRow(input.slug, iso);
    if (existing) {
      await query(
        "UPDATE email_warmup_daily_sends SET sends_count = sends_count + ?1, " +
        "updated_at = ?2 WHERE id = ?3",
        [count, ts, existing.id],
      );
    } else {
      var id = b.uuid.v7();
      await query(
        "INSERT INTO email_warmup_daily_sends " +
        "(id, schedule_slug, day_index, sends_count, bounce_count, complaint_count, " +
        "occurred_date, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?6, ?6)",
        [id, input.slug, dayIndex, count, iso, ts],
      );
    }
    var post = await _getDailyRow(input.slug, iso);
    return {
      slug:           input.slug,
      day_index:      dayIndex,
      sends_count:    Number(post.sends_count),
      occurred_date:  iso,
    };
  }

  // -- recordEngagement --------------------------------------------------

  // Operator-routed ESP feedback — bumps the per-day bounce or
  // complaint counter that drives metricsForSchedule. Drop-silent on
  // unknown schedule because this runs on the inbound ESP webhook
  // path; throwing here would crash the request that observed the
  // bounce. Bad shape (negative count, bad event_type) still throws —
  // those are operator-bug shapes, not race / unknown-row shapes.
  async function recordEngagement(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailWarmup.recordEngagement: input object required");
    }
    _slug(input.slug);
    if (input.event_type !== "bounce" && input.event_type !== "complaint") {
      throw new TypeError("emailWarmup.recordEngagement: event_type must be one of 'bounce', 'complaint'");
    }
    var count    = input.count == null ? 1 : _posInt(input.count, "count");
    var occurred = input.occurred_at == null ? nowFn() : _epochMs(input.occurred_at, "occurred_at");

    var row = await _getRow(input.slug);
    if (!row) {
      // Drop-silent on unknown schedule — ESP webhook arriving for a
      // schedule that was archived between send and feedback.
      return { recorded: false, reason: "unknown_schedule" };
    }

    var iso      = _isoFromMs(occurred);
    var dayIndex = _computeDayIndex(row.start_date, occurred);
    if (dayIndex <= 0) {
      return { recorded: false, reason: "pre_ramp" };
    }
    var ts = nowFn();
    var col = input.event_type === "bounce" ? "bounce_count" : "complaint_count";
    var existing = await _getDailyRow(input.slug, iso);
    if (existing) {
      await query(
        "UPDATE email_warmup_daily_sends SET " + col + " = " + col + " + ?1, " +
        "updated_at = ?2 WHERE id = ?3",
        [count, ts, existing.id],
      );
    } else {
      var id = b.uuid.v7();
      var bounce    = input.event_type === "bounce" ? count : 0;
      var complaint = input.event_type === "complaint" ? count : 0;
      await query(
        "INSERT INTO email_warmup_daily_sends " +
        "(id, schedule_slug, day_index, sends_count, bounce_count, complaint_count, " +
        "occurred_date, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?7)",
        [id, input.slug, dayIndex, bounce, complaint, iso, ts],
      );
    }
    return { recorded: true, slug: input.slug, day_index: dayIndex, event_type: input.event_type };
  }

  // -- currentDay --------------------------------------------------------

  async function currentDay(slug, atMs) {
    _slug(slug);
    var nowMs = atMs == null ? nowFn() : _epochMs(atMs, "now");
    var row = await _getRow(slug);
    if (!row) {
      throw new TypeError("emailWarmup.currentDay: slug " + JSON.stringify(slug) + " not found");
    }
    var targets  = JSON.parse(row.daily_targets_json);
    var dayIndex = _computeDayIndex(row.start_date, nowMs);
    var status;
    if (dayIndex <= 0) status = "pre_ramp";
    else if (dayIndex > targets.length) status = "post_ramp";
    else status = "in_ramp";
    return {
      slug:          slug,
      day_index:     dayIndex,
      ramp_length:   targets.length,
      daily_target:  status === "in_ramp" ? targets[dayIndex - 1] : 0,
      status:        status,
    };
  }

  // -- FSM transitions ---------------------------------------------------

  async function _transition(slug, event, reason) {
    _slug(slug);
    var existing = await _getRow(slug);
    if (!existing) {
      throw new TypeError("emailWarmup." + event + ": slug " + JSON.stringify(slug) + " not found");
    }
    var allowed = TRANSITIONS[existing.status];
    var next    = allowed && allowed[event];
    if (!next) {
      throw new TypeError("emailWarmup." + event + ": cannot " + event +
        " a schedule in status " + JSON.stringify(existing.status));
    }
    var ts = nowFn();
    var sets   = ["status = ?1", "updated_at = ?2"];
    var params = [next, ts];
    var idx    = 3;
    if (next === "paused") {
      sets.push("paused_at = ?" + idx); params.push(ts); idx += 1;
      sets.push("paused_reason = ?" + idx); params.push(reason); idx += 1;
    } else if (next === "active") {
      // Resume clears the paused_at / paused_reason so the columns
      // reflect the most recent pause window only.
      sets.push("paused_at = NULL");
      sets.push("paused_reason = NULL");
    } else if (next === "archived") {
      sets.push("archived_at = ?" + idx); params.push(ts); idx += 1;
    }
    params.push(slug);
    await query(
      "UPDATE email_warmup_schedules SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    return _hydrateRow(await _getRow(slug));
  }

  async function pauseSchedule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailWarmup.pauseSchedule: input object required");
    }
    _slug(input.slug);
    var reason = _reason(input.reason);
    return await _transition(input.slug, "pause", reason);
  }

  async function resumeSchedule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailWarmup.resumeSchedule: input object required");
    }
    _slug(input.slug);
    return await _transition(input.slug, "resume", null);
  }

  async function archiveSchedule(slug) {
    _slug(slug);
    return await _transition(slug, "archive", null);
  }

  // -- listSchedules / getSchedule ---------------------------------------

  async function getSchedule(slug) {
    _slug(slug);
    return _hydrateRow(await _getRow(slug));
  }

  async function listSchedules(listOpts) {
    listOpts = listOpts || {};
    var limit = MAX_LIST_LIMIT;
    if (listOpts.limit != null) {
      limit = _posInt(listOpts.limit, "limit");
      if (limit > MAX_LIST_LIMIT) {
        throw new TypeError("emailWarmup.listSchedules: limit must be <= " + MAX_LIST_LIMIT);
      }
    }
    var sql, params;
    if (listOpts.active_only) {
      sql = "SELECT * FROM email_warmup_schedules WHERE status = 'active' " +
            "ORDER BY created_at DESC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql = "SELECT * FROM email_warmup_schedules " +
            "ORDER BY created_at DESC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRow(rows[i]));
    return out;
  }

  // -- metricsForSchedule -----------------------------------------------

  // Per-day rollup of sends + bounce rate + complaint rate. Bounce
  // rate / complaint rate are basis points (out of 10000), computed
  // from (count / sends_count); a day with zero sends returns rate=0
  // (no divide-by-zero). The `threshold_breached` flag is true when
  // either rate exceeds `status_check_threshold` — the operator
  // dashboard uses this to surface days that warrant review. The
  // primitive doesn't auto-pause; that's operator policy.
  async function metricsForSchedule(slug) {
    _slug(slug);
    var row = await _getRow(slug);
    if (!row) {
      throw new TypeError("emailWarmup.metricsForSchedule: slug " + JSON.stringify(slug) + " not found");
    }
    var rows = (await query(
      "SELECT day_index, sends_count, bounce_count, complaint_count, occurred_date " +
      "FROM email_warmup_daily_sends " +
      "WHERE schedule_slug = ?1 " +
      "ORDER BY day_index ASC, occurred_date ASC",
      [slug],
    )).rows;
    var threshold = Number(row.status_check_threshold);
    var targets   = JSON.parse(row.daily_targets_json);
    var days = [];
    var totalSends = 0;
    var totalBounces = 0;
    var totalComplaints = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var d         = rows[i];
      var sends     = Number(d.sends_count);
      var bounces   = Number(d.bounce_count);
      var complaints = Number(d.complaint_count);
      var bounceBps    = sends > 0 ? Math.floor((bounces * 10000) / sends) : 0;
      var complaintBps = sends > 0 ? Math.floor((complaints * 10000) / sends) : 0;
      var breached     = bounceBps > threshold || complaintBps > threshold;
      var dayIndex     = Number(d.day_index);
      var target       = dayIndex >= 1 && dayIndex <= targets.length ? targets[dayIndex - 1] : 0;
      days.push({
        day_index:           dayIndex,
        occurred_date:       d.occurred_date,
        sends_count:         sends,
        daily_target:        target,
        bounce_count:        bounces,
        complaint_count:     complaints,
        bounce_rate_bps:     bounceBps,
        complaint_rate_bps:  complaintBps,
        threshold_breached:  breached,
      });
      totalSends += sends;
      totalBounces += bounces;
      totalComplaints += complaints;
    }
    return {
      slug:                    slug,
      status:                  row.status,
      sender_domain:           row.sender_domain,
      sender_ip:               row.sender_ip == null ? null : row.sender_ip,
      start_date:              row.start_date,
      ramp_length:             targets.length,
      status_check_threshold:  threshold,
      total_sends:             totalSends,
      total_bounces:           totalBounces,
      total_complaints:        totalComplaints,
      days:                    days,
    };
  }

  return {
    MAX_SLUG_LEN:        MAX_SLUG_LEN,
    MAX_DAILY_TARGETS:   MAX_DAILY_TARGETS,
    MAX_DAILY_TARGET:    MAX_DAILY_TARGET,
    MAX_THRESHOLD_BPS:   MAX_THRESHOLD_BPS,
    ALLOWED_STATUSES:    ALLOWED_STATUSES,
    TRANSITIONS:         TRANSITIONS,

    defineSchedule:      defineSchedule,
    canSend:             canSend,
    recordSends:         recordSends,
    recordEngagement:    recordEngagement,
    currentDay:          currentDay,
    pauseSchedule:       pauseSchedule,
    resumeSchedule:      resumeSchedule,
    archiveSchedule:     archiveSchedule,
    listSchedules:       listSchedules,
    getSchedule:         getSchedule,
    metricsForSchedule:  metricsForSchedule,
  };
}

module.exports = {
  create:              create,
  MAX_SLUG_LEN:        MAX_SLUG_LEN,
  MAX_DAILY_TARGETS:   MAX_DAILY_TARGETS,
  MAX_DAILY_TARGET:    MAX_DAILY_TARGET,
  MAX_THRESHOLD_BPS:   MAX_THRESHOLD_BPS,
  ALLOWED_STATUSES:    ALLOWED_STATUSES,
  TRANSITIONS:         TRANSITIONS,
  _computeDayIndex:    _computeDayIndex,    // exposed for tests
  _isoFromMs:          _isoFromMs,          // exposed for tests
};
