"use strict";
/**
 * @module shop.wishlistDigest
 * @title  Weekly / monthly wishlist digest emails — rollup summaries
 *         with stock changes + price drops since the last send.
 *
 * @intro
 *   Distinct from `wishlistAlerts` (event-driven "this SKU just dropped
 *   20%"); the digest is a periodic rollup the operator authors as a
 *   weekly or monthly cadence + customers opt into per-cadence. The
 *   shape:
 *
 *     var wd = b.shop.wishlistDigest.create({
 *       query:               q,
 *       wishlist:            wishlistPrimitive,
 *       catalog:             catalogPrimitive,
 *       email:               emailPrimitive,
 *       emailSuppressions:   suppPrimitive,           // optional
 *     });
 *
 *     // Operator defines the cadence once.
 *     await wd.defineSchedule({
 *       slug:        "weekly-monday-9am",
 *       frequency:   "weekly",
 *       day_of_week: 1,                 // Mon = 1 (0..6, Sun = 0)
 *       time_local:  "09:00",
 *       timezone:    "Europe/London",
 *     });
 *
 *     // Customer-portal opt-in. `next_dispatch_at` is computed from
 *     // the schedule's frequency / day-of-week|month / time_local /
 *     // timezone — pure JS via `Intl.DateTimeFormat`, no offset math.
 *     await wd.enrollCustomer({
 *       customer_id:   customerId,
 *       schedule_slug: "weekly-monday-9am",
 *     });
 *
 *     // Scheduler tick — operator wires this to a cron / Workers
 *     // Cron Trigger. Pulls every active enrollment whose
 *     // next_dispatch_at is due, composes + dispatches the digest,
 *     // stamps a `wishlist_digest_sent` row, advances next_dispatch_at
 *     // by one period.
 *     await wd.dispatchTick({ now: Date.now() });
 *
 *   Verbs:
 *     defineSchedule  — register / replace a cadence. Per-slug
 *       uniqueness; redefining the active row patches it in place. The
 *       frequency-specific shape rules are enforced at the SQL CHECK
 *       constraint AND the JS validator (defense-in-depth so a hand-
 *       UPDATE'd row that violates the CHECK fails at insert, and a
 *       bad caller fails at the verb boundary with a typed error).
 *
 *     enrollCustomer  — opt a customer in. Refuses if the schedule is
 *       archived. Re-enrolling the same (customer, schedule) pair is a
 *       no-op when active, a re-activate when paused, and refused when
 *       cancelled (operators reauthor by calling resumeEnrollment +
 *       the dispatcher picks up the fresh next_dispatch_at).
 *
 *     dispatchTick    — pull every active enrollment whose
 *       next_dispatch_at <= now, compose the digest via composeDigest,
 *       send via the injected `email.sendWishlistDigest` handle, stamp
 *       a sent ledger row, advance next_dispatch_at by one period. The
 *       suppressions dep (when wired) short-circuits sends to addresses
 *       on the suppress list — the row is still ledger'd with
 *       item_count = 0 so the cadence stays on rails, but no email
 *       fires (and the operator's metrics show the suppression rate).
 *
 *     recordDigestSent — terminal marker for async mailer hooks. The
 *       synchronous path through dispatchTick stamps the ledger inline;
 *       this verb is for deferred mailer ACKs (the operator-supplied
 *       mailer returns immediately + records the actual send out-of-
 *       band — e.g. an AWS SES async callback or a Mailchimp transactional
 *       webhook).
 *
 *     pauseEnrollment / resumeEnrollment — temporary opt-out. Pausing
 *       captures a `paused_reason` (operator audit trail, customer-
 *       facing "you paused because: X"); resuming recomputes
 *       next_dispatch_at from the current wall clock + the schedule.
 *
 *     enrollmentsForCustomer — customer-portal read. Newest-first
 *       across all statuses; the customer's account page shows each
 *       subscription with its next-dispatch ETA.
 *
 *     metricsForSchedule — operator dashboard rollup — count of
 *       digests sent + sum of item_counts in a window for one slug.
 *
 *     composeDigest({ customer_id }) — returns the digest body
 *       (HTML + text) for the customer's wishlist as it stands NOW.
 *       Pure-read; no DB writes. Wired into dispatchTick + exposed
 *       directly so the operator can preview the next digest from the
 *       admin UI without firing the email.
 *
 *   Composition:
 *     - b.uuid.v7    — enrollment + sent-ledger row ids
 *     - b.guardUuid  — customer_id sanitization
 *     - wishlist     — listForCustomer to drive composeDigest
 *     - catalog      — products.get + prices.current for the digest
 *                      lines; price changes since the last send drive
 *                      the "price drops" section
 *     - email        — sendWishlistDigest({ customer_email, lines, ... })
 *     - emailSuppressions (optional) — isSuppressed short-circuit
 *
 *   Monotonic clock: a per-factory monotonic timestamp guarantees that
 *   two enrollments / sent-ledger rows written inside the same wall-
 *   clock millisecond carry strictly-increasing values; the dispatcher's
 *   batch read returns deterministic order without depending on
 *   secondary tiebreakers.
 *
 * @primitive wishlistDigest
 * @related   shop.wishlist, shop.catalog, shop.email, shop.wishlistAlerts
 */

var b = require("./vendor/blamejs");
var pricing = require("./pricing");

var C = b.constants;

// ---- constants ----------------------------------------------------------

var FREQUENCIES         = Object.freeze(["weekly", "monthly"]);
var STATUSES            = Object.freeze(["active", "paused", "cancelled"]);

var SLUG_RE             = /^[a-z0-9][a-z0-9._-]{0,127}$/;
var TIME_LOCAL_RE       = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
var MAX_PAUSE_REASON    = 1024;
var MAX_BATCH_SIZE      = 500;
var DEFAULT_BATCH_SIZE  = 100;
var MAX_LIMIT           = 500;
var DEFAULT_LIMIT       = 50;
var MAX_DIGEST_LINES    = 200;

var DAY_MS              = C.TIME.days(1);

// ---- html escape (local; vendored blamejs's _htmlEscape is private to
// the mail primitive). Same rules — five named entities, no tag/attr
// context awareness because we only embed in text nodes / hrefs that
// we control directly.
function _htmlEscape(s) { return b.template.escapeHtml(s); }

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("wishlistDigest: " + (label || "slug") +
      " must match /^[a-z0-9][a-z0-9._-]*$/ (lowercase alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _frequency(s) {
  if (typeof s !== "string" || FREQUENCIES.indexOf(s) === -1) {
    throw new TypeError("wishlistDigest: frequency must be one of " + FREQUENCIES.join(", "));
  }
  return s;
}

function _dayOfWeek(n) {
  if (!Number.isInteger(n) || n < 0 || n > 6) {
    throw new TypeError("wishlistDigest: day_of_week must be an integer in [0, 6] (Sun = 0)");
  }
  return n;
}

function _dayOfMonth(n) {
  if (!Number.isInteger(n) || n < 1 || n > 28) {
    throw new TypeError("wishlistDigest: day_of_month must be an integer in [1, 28] " +
      "(capped at 28 so February doesn't skip the send)");
  }
  return n;
}

function _timeLocal(s) {
  if (typeof s !== "string" || !TIME_LOCAL_RE.test(s)) {
    throw new TypeError("wishlistDigest: time_local must be HH:MM (24-hour clock, e.g. 09:00 or 18:30)");
  }
  return s;
}

function _timezone(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("wishlistDigest: timezone must be a non-empty IANA timezone name (e.g. Europe/London)");
  }
  try {
    // Probe via Intl — throws RangeError on unknown zones. The framework
    // doesn't ship a vendored zone catalog; node ships the ICU bundle.
    new Intl.DateTimeFormat("en-US", { timeZone: s });
  } catch (_e) {
    throw new TypeError("wishlistDigest: timezone is not a known IANA timezone (got " + JSON.stringify(s) + ")");
  }
  return s;
}

function _customerId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("wishlistDigest: customer_id — " + (e && e.message || "invalid UUID"));
  }
}

function _enrollmentId(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("wishlistDigest: " + (label || "enrollment_id") + " must be a non-empty string");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("wishlistDigest: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _optionalEpochMs(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("wishlistDigest: batch_size must be an integer in [1, " + MAX_BATCH_SIZE + "]");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("wishlistDigest: limit must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _pauseReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("wishlistDigest: reason must be a non-empty string");
  }
  if (s.length > MAX_PAUSE_REASON) {
    throw new TypeError("wishlistDigest: reason must be <= " + MAX_PAUSE_REASON + " characters");
  }
  return s;
}

function _itemCount(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("wishlistDigest: item_count must be a non-negative integer");
  }
  return n;
}

// ---- timezone-aware calendar math ---------------------------------------
//
// Same posture as business-hours.js — Intl handles DST automatically, no
// manual offset math. The dispatcher needs the next wall-clock instant
// matching the schedule (weekly_dow, monthly_dom, time_local) AFTER a
// given anchor epoch. The algorithm:
//
//   1. Format the anchor in the schedule's timezone -> {y, m, d, hh, mm, weekday}.
//   2. Roll forward day-by-day to the next matching weekday / day_of_month.
//   3. If the candidate day === anchor day AND time_local <= anchor wall
//      time, roll forward one more period (weekly = +7d, monthly = next
//      month's day_of_month).
//   4. Resolve the (YYYY-MM-DD, HH:MM, tz) tuple back to an epoch via
//      the wall-clock-to-epoch refinement loop.

function _wallClockIn(tz, epochMs) {
  var fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
    weekday:  "short",
  });
  var parts = fmt.formatToParts(new Date(epochMs));
  var out = { y: 0, m: 0, d: 0, hh: 0, mm: 0, weekday: 0 };
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i];
    if (p.type === "year")    out.y  = Number(p.value);
    if (p.type === "month")   out.m  = Number(p.value);
    if (p.type === "day")     out.d  = Number(p.value);
    if (p.type === "hour") {
      var hh = Number(p.value);
      out.hh = hh === 24 ? 0 : hh;
    }
    if (p.type === "minute")  out.mm = Number(p.value);
    if (p.type === "weekday") {
      var map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      out.weekday = map[p.value] != null ? map[p.value] : 0;
    }
  }
  return out;
}

function _pad2(n) { return n < 10 ? "0" + n : String(n); }

function _addCalendarDays(ymd, n) {
  var ts = Date.UTC(ymd.y, ymd.m - 1, ymd.d) + n * DAY_MS;
  var dt = new Date(ts);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function _weekdayOfYMD(ymd) {
  var ts = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
  return new Date(ts).getUTCDay();
}

// Resolve a (YYYY-MM-DD, HH:MM, IANA tz) tuple back to an epoch-ms via
// the same two-pass refinement business-hours.js uses (handles DST
// transitions where the first guess lands on the wrong side of the
// fold).
function _wallClockToEpochMs(tz, ymd, hh, mm) {
  var guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hh, mm);
  for (var pass = 0; pass < 2; pass += 1) {
    var wall = _wallClockIn(tz, guess);
    var actualUtcOfWall = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm);
    var desiredUtcOfWall = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hh, mm);
    var delta = desiredUtcOfWall - actualUtcOfWall;
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}

// Compute the next wall-clock instant strictly AFTER `anchorEpoch` that
// matches the schedule's (frequency, day_of_week|day_of_month, time_local)
// in its timezone.
function _nextDispatchAt(schedule, anchorEpoch) {
  var tz = schedule.timezone;
  var hh = Number(schedule.time_local.slice(0, 2));
  var mm = Number(schedule.time_local.slice(3, 5));

  var anchorWall = _wallClockIn(tz, anchorEpoch);
  var candidate  = { y: anchorWall.y, m: anchorWall.m, d: anchorWall.d };

  if (schedule.frequency === "weekly") {
    // Roll forward 0..6 days to land on the target weekday.
    var targetDow = schedule.day_of_week;
    var rolls = 0;
    while (_weekdayOfYMD(candidate) !== targetDow && rolls < 8) {
      candidate = _addCalendarDays(candidate, 1);
      rolls += 1;
    }
    // If candidate is the same day as the anchor wall, and the local
    // time has already passed today, roll forward one week.
    var sameDay = (candidate.y === anchorWall.y) &&
                  (candidate.m === anchorWall.m) &&
                  (candidate.d === anchorWall.d);
    if (sameDay) {
      var pastToday = (anchorWall.hh > hh) ||
                      (anchorWall.hh === hh && anchorWall.mm >= mm);
      if (pastToday) candidate = _addCalendarDays(candidate, 7);
    }
  } else {
    // monthly — find the next month-instance of day_of_month at or
    // after the anchor. If the anchor day is before day_of_month, the
    // current month wins; else roll to next month's day_of_month.
    var dom = schedule.day_of_month;
    if (anchorWall.d < dom) {
      candidate = { y: anchorWall.y, m: anchorWall.m, d: dom };
    } else if (anchorWall.d === dom) {
      // Same day — if time has already passed, roll to next month;
      // else fire today.
      var pastTodayM = (anchorWall.hh > hh) ||
                       (anchorWall.hh === hh && anchorWall.mm >= mm);
      if (pastTodayM) {
        // Date.UTC interprets month 0-based; passing the 1-based
        // `anchorWall.m` rolls forward exactly one month.
        var rolledTs = Date.UTC(anchorWall.y, anchorWall.m, dom);
        var rolledDt = new Date(rolledTs);
        candidate = {
          y: rolledDt.getUTCFullYear(),
          m: rolledDt.getUTCMonth() + 1,
          d: dom,
        };
      } else {
        candidate = { y: anchorWall.y, m: anchorWall.m, d: dom };
      }
    } else {
      // Anchor day is after day_of_month — next month.
      var rolledTs2 = Date.UTC(anchorWall.y, anchorWall.m, dom);
      var rolledDt2 = new Date(rolledTs2);
      candidate = {
        y: rolledDt2.getUTCFullYear(),
        m: rolledDt2.getUTCMonth() + 1,
        d: dom,
      };
    }
  }

  return _wallClockToEpochMs(tz, candidate, hh, mm);
}

// Advance an existing next_dispatch_at by one period (called on
// successful send). Different from _nextDispatchAt: this one snaps to
// "exactly one period after the previous next_dispatch_at" so the
// cadence stays on its target weekday / day-of-month even if the
// dispatcher tick fired late.
function _advanceByOnePeriod(schedule, currentNext) {
  // The previous next_dispatch_at IS already aligned to the schedule.
  // Adding (frequency-dependent) period and re-resolving keeps the
  // wall-clock time / weekday / day-of-month invariant.
  var tz = schedule.timezone;
  var hh = Number(schedule.time_local.slice(0, 2));
  var mm = Number(schedule.time_local.slice(3, 5));
  var wall = _wallClockIn(tz, currentNext);
  var ymd;
  if (schedule.frequency === "weekly") {
    ymd = _addCalendarDays({ y: wall.y, m: wall.m, d: wall.d }, 7);
  } else {
    var rolledTs = Date.UTC(wall.y, wall.m, schedule.day_of_month);   // m (1-based) used unmodified rolls forward exactly one month
    var rolledDt = new Date(rolledTs);
    ymd = {
      y: rolledDt.getUTCFullYear(),
      m: rolledDt.getUTCMonth() + 1,
      d: schedule.day_of_month,
    };
  }
  return _wallClockToEpochMs(tz, ymd, hh, mm);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Required composed handles. `wishlist`, `catalog`, `email` are
  // structural — composeDigest + dispatchTick can't function without
  // them. `emailSuppressions` is optional; when wired the dispatcher
  // short-circuits sends to suppressed addresses.
  var wishlist = opts.wishlist;
  if (!wishlist || typeof wishlist.listForCustomer !== "function") {
    throw new TypeError("wishlistDigest.create: opts.wishlist must expose listForCustomer (the wishlist primitive)");
  }
  var catalog = opts.catalog;
  if (!catalog
      || !catalog.products || typeof catalog.products.get !== "function"
      || !catalog.prices   || typeof catalog.prices.current !== "function") {
    throw new TypeError(
      "wishlistDigest.create: opts.catalog must expose products.get + prices.current (the catalog primitive)"
    );
  }
  var email = opts.email;
  if (!email || typeof email.sendWishlistDigest !== "function") {
    throw new TypeError("wishlistDigest.create: opts.email must expose sendWishlistDigest");
  }
  var emailSuppressions = opts.emailSuppressions || null;
  if (emailSuppressions && typeof emailSuppressions.isSuppressed !== "function") {
    throw new TypeError("wishlistDigest.create: opts.emailSuppressions must expose isSuppressed when wired");
  }

  // Default currency + optional per-customer resolver — mirror the
  // wishlist-alerts posture so a multi-currency operator can inject a
  // per-customer override at construction time.
  var defaultCurrency = typeof opts.defaultCurrency === "string" && /^[A-Z]{3}$/.test(opts.defaultCurrency)
    ? opts.defaultCurrency
    : "USD";
  var currencyForCustomer = typeof opts.currencyForCustomer === "function" ? opts.currencyForCustomer : null;

  // Resolve the customer's email address. Composed once at factory
  // time so dispatchTick can short-circuit when the operator hasn't
  // wired the resolver.
  var emailForCustomer = typeof opts.emailForCustomer === "function" ? opts.emailForCustomer : null;

  // ---- per-factory monotonic clock ---------------------------------
  //
  // Two sent-ledger rows / enrollments inside the same wall-clock
  // millisecond tie on (next_dispatch_at, id) — the dispatcher's
  // batch read would return non-deterministic order. Monotonic step
  // guarantees strict-increase.
  var _lastTs = 0;
  function _now(epochOpt) {
    var wall = epochOpt != null ? epochOpt : Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- internal shapers --------------------------------------------

  function _shapeSchedule(row) {
    if (!row) return null;
    return {
      slug:         row.slug,
      frequency:    row.frequency,
      day_of_week:  row.day_of_week == null  ? null : Number(row.day_of_week),
      day_of_month: row.day_of_month == null ? null : Number(row.day_of_month),
      time_local:   row.time_local,
      timezone:     row.timezone,
      archived_at:  row.archived_at == null ? null : Number(row.archived_at),
      created_at:   Number(row.created_at),
      updated_at:   Number(row.updated_at),
    };
  }

  function _shapeEnrollment(row) {
    if (!row) return null;
    return {
      id:                row.id,
      customer_id:       row.customer_id,
      schedule_slug:     row.schedule_slug,
      status:            row.status,
      next_dispatch_at:  Number(row.next_dispatch_at),
      paused_reason:     row.paused_reason || null,
      paused_at:         row.paused_at    == null ? null : Number(row.paused_at),
      cancelled_at:      row.cancelled_at == null ? null : Number(row.cancelled_at),
      created_at:        Number(row.created_at),
    };
  }

  function _shapeSent(row) {
    if (!row) return null;
    return {
      id:             row.id,
      enrollment_id:  row.enrollment_id,
      item_count:     Number(row.item_count),
      sent_at:        Number(row.sent_at),
    };
  }

  async function _getScheduleBySlug(slug) {
    var r = await query(
      "SELECT * FROM wishlist_digest_schedules WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function _getEnrollmentById(id) {
    var r = await query(
      "SELECT * FROM wishlist_digest_enrollments WHERE id = ?1 LIMIT 1",
      [id],
    );
    return r.rows[0] || null;
  }

  async function _getEnrollmentByPair(customerId, scheduleSlug) {
    var r = await query(
      "SELECT * FROM wishlist_digest_enrollments WHERE customer_id = ?1 AND schedule_slug = ?2 LIMIT 1",
      [customerId, scheduleSlug],
    );
    return r.rows[0] || null;
  }

  async function _resolveCurrency(customerId) {
    if (currencyForCustomer) {
      try {
        var c = await currencyForCustomer(customerId);
        if (typeof c === "string" && /^[A-Z]{3}$/.test(c)) return c;
      } catch (_e) {
        // drop-silent — fall back to the primitive-wide default
      }
    }
    return defaultCurrency;
  }

  // ---- defineSchedule ----------------------------------------------

  async function defineSchedule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistDigest.defineSchedule: input object required");
    }
    var slug      = _slug(input.slug, "slug");
    var frequency = _frequency(input.frequency);
    var timeLocal = _timeLocal(input.time_local);
    var timezone  = _timezone(input.timezone);

    var dayOfWeek  = null;
    var dayOfMonth = null;
    if (frequency === "weekly") {
      if (input.day_of_week == null) {
        throw new TypeError("wishlistDigest.defineSchedule: day_of_week required when frequency = weekly");
      }
      if (input.day_of_month != null) {
        throw new TypeError("wishlistDigest.defineSchedule: day_of_month must be null when frequency = weekly");
      }
      dayOfWeek = _dayOfWeek(input.day_of_week);
    } else {
      if (input.day_of_month == null) {
        throw new TypeError("wishlistDigest.defineSchedule: day_of_month required when frequency = monthly");
      }
      if (input.day_of_week != null) {
        throw new TypeError("wishlistDigest.defineSchedule: day_of_week must be null when frequency = monthly");
      }
      dayOfMonth = _dayOfMonth(input.day_of_month);
    }

    var existing = await _getScheduleBySlug(slug);
    var ts = _now();
    if (existing) {
      if (existing.archived_at != null) {
        throw new TypeError("wishlistDigest.defineSchedule: schedule " + JSON.stringify(slug) +
          " is archived — operators reauthor by archiving + a fresh slug");
      }
      await query(
        "UPDATE wishlist_digest_schedules SET frequency = ?1, day_of_week = ?2, day_of_month = ?3, " +
        "time_local = ?4, timezone = ?5, updated_at = ?6 WHERE slug = ?7",
        [frequency, dayOfWeek, dayOfMonth, timeLocal, timezone, ts, slug],
      );
    } else {
      await query(
        "INSERT INTO wishlist_digest_schedules " +
        "(slug, frequency, day_of_week, day_of_month, time_local, timezone, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
        [slug, frequency, dayOfWeek, dayOfMonth, timeLocal, timezone, ts],
      );
    }
    return _shapeSchedule(await _getScheduleBySlug(slug));
  }

  async function getSchedule(slug) {
    _slug(slug, "slug");
    return _shapeSchedule(await _getScheduleBySlug(slug));
  }

  // List the defined schedules, newest-first by created_at. With
  // `active_only` (default) only non-archived schedules are returned —
  // the customer-portal toggle renders a digest opt-in per LIVE schedule
  // slug; the admin console passes `active_only: false` to show archived
  // rows too. Pure read; no writes.
  async function listSchedules(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = listOpts.active_only !== false;
    var sql = "SELECT * FROM wishlist_digest_schedules ";
    if (activeOnly) sql += "WHERE archived_at IS NULL ";
    sql += "ORDER BY created_at DESC, slug ASC LIMIT ?1";
    var r = await query(sql, [MAX_LIMIT]);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_shapeSchedule(r.rows[i]));
    return out;
  }

  // ---- enrollCustomer ----------------------------------------------

  async function enrollCustomer(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistDigest.enrollCustomer: input object required");
    }
    var customerId   = _customerId(input.customer_id);
    var scheduleSlug = _slug(input.schedule_slug, "schedule_slug");
    var nowOpt       = _optionalEpochMs(input.now, "now");

    var scheduleRow = await _getScheduleBySlug(scheduleSlug);
    if (!scheduleRow) {
      throw new TypeError("wishlistDigest.enrollCustomer: schedule " + JSON.stringify(scheduleSlug) +
        " not found — call defineSchedule first");
    }
    if (scheduleRow.archived_at != null) {
      throw new TypeError("wishlistDigest.enrollCustomer: schedule " + JSON.stringify(scheduleSlug) + " is archived");
    }
    var schedule = _shapeSchedule(scheduleRow);

    var anchor = nowOpt != null ? nowOpt : _now();
    var nextDispatchAt = _nextDispatchAt(schedule, anchor);

    var existing = await _getEnrollmentByPair(customerId, scheduleSlug);
    if (existing) {
      if (existing.status === "cancelled") {
        throw new TypeError("wishlistDigest.enrollCustomer: enrollment is cancelled — " +
          "resumeEnrollment is refused on cancelled rows; operators reauthor only via a fresh customer signal");
      }
      // Already active or paused — refresh next_dispatch_at and unset
      // pause state. An operator re-issuing enrollCustomer for a paused
      // row is effectively resuming, so honour that without forcing a
      // separate resume call.
      await query(
        "UPDATE wishlist_digest_enrollments SET status = 'active', next_dispatch_at = ?1, " +
        "paused_reason = NULL, paused_at = NULL WHERE id = ?2",
        [nextDispatchAt, existing.id],
      );
      return _shapeEnrollment(await _getEnrollmentById(existing.id));
    }

    var id = b.uuid.v7();
    var createdAt = _now();
    await query(
      "INSERT INTO wishlist_digest_enrollments " +
      "(id, customer_id, schedule_slug, status, next_dispatch_at, paused_reason, paused_at, cancelled_at, created_at) " +
      "VALUES (?1, ?2, ?3, 'active', ?4, NULL, NULL, NULL, ?5)",
      [id, customerId, scheduleSlug, nextDispatchAt, createdAt],
    );
    return _shapeEnrollment(await _getEnrollmentById(id));
  }

  // ---- pause / resume / enrollment reads ---------------------------

  async function pauseEnrollment(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistDigest.pauseEnrollment: input object required");
    }
    var enrollmentId = _enrollmentId(input.enrollment_id);
    var reason       = _pauseReason(input.reason);

    var existing = await _getEnrollmentById(enrollmentId);
    if (!existing) {
      throw new TypeError("wishlistDigest.pauseEnrollment: enrollment_id " +
        JSON.stringify(enrollmentId) + " not found");
    }
    if (existing.status === "cancelled") {
      throw new TypeError("wishlistDigest.pauseEnrollment: enrollment is cancelled — cannot pause");
    }
    if (existing.status === "paused") {
      return _shapeEnrollment(existing);
    }
    var ts = _now();
    await query(
      "UPDATE wishlist_digest_enrollments SET status = 'paused', paused_reason = ?1, paused_at = ?2 " +
      "WHERE id = ?3",
      [reason, ts, enrollmentId],
    );
    return _shapeEnrollment(await _getEnrollmentById(enrollmentId));
  }

  async function resumeEnrollment(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistDigest.resumeEnrollment: input object required");
    }
    var enrollmentId = _enrollmentId(input.enrollment_id);
    var nowOpt       = _optionalEpochMs(input.now, "now");

    var existing = await _getEnrollmentById(enrollmentId);
    if (!existing) {
      throw new TypeError("wishlistDigest.resumeEnrollment: enrollment_id " +
        JSON.stringify(enrollmentId) + " not found");
    }
    if (existing.status === "cancelled") {
      throw new TypeError("wishlistDigest.resumeEnrollment: enrollment is cancelled — cannot resume");
    }
    if (existing.status === "active") {
      return _shapeEnrollment(existing);
    }
    var scheduleRow = await _getScheduleBySlug(existing.schedule_slug);
    if (!scheduleRow || scheduleRow.archived_at != null) {
      throw new TypeError("wishlistDigest.resumeEnrollment: parent schedule is missing or archived");
    }
    var anchor = nowOpt != null ? nowOpt : _now();
    var nextDispatchAt = _nextDispatchAt(_shapeSchedule(scheduleRow), anchor);
    await query(
      "UPDATE wishlist_digest_enrollments SET status = 'active', next_dispatch_at = ?1, " +
      "paused_reason = NULL, paused_at = NULL WHERE id = ?2",
      [nextDispatchAt, enrollmentId],
    );
    return _shapeEnrollment(await _getEnrollmentById(enrollmentId));
  }

  async function enrollmentsForCustomer(customerId) {
    var cid = _customerId(customerId);
    var r = await query(
      "SELECT * FROM wishlist_digest_enrollments WHERE customer_id = ?1 " +
      "ORDER BY created_at DESC, id DESC LIMIT ?2",
      [cid, MAX_LIMIT],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_shapeEnrollment(r.rows[i]));
    return out;
  }

  // ---- composeDigest ------------------------------------------------
  //
  // Pure-read shape: walks the customer's wishlist via the composed
  // wishlist primitive, resolves each entry through catalog.products.get
  // + catalog.prices.current, and renders an HTML + text body. The
  // dispatcher uses this for the actual send; an operator can call it
  // directly to preview the next digest.

  async function composeDigest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistDigest.composeDigest: input object required");
    }
    var customerId = _customerId(input.customer_id);
    var currency   = await _resolveCurrency(customerId);

    var list = await wishlist.listForCustomer(customerId, { limit: MAX_DIGEST_LINES });
    var rows = (list && list.rows) || [];

    var lines = [];
    for (var i = 0; i < rows.length; i += 1) {
      var entry = rows[i];
      var product = null;
      try { product = await catalog.products.get(entry.product_id); }
      catch (_e) { product = null; }
      var title = (product && typeof product.title === "string" && product.title.length)
        ? product.title
        : entry.product_id;

      var price = null;
      if (entry.variant_id) {
        try { price = await catalog.prices.current(entry.variant_id, currency); }
        catch (_e2) { price = null; }
      }
      var priceStr = "—";
      if (price && typeof price.amount_minor === "number") {
        try {
          priceStr = pricing.format(price.amount_minor, price.currency || currency);
        } catch (_efmt) { priceStr = "—"; }
      }

      // Stock change — best-effort. The catalog dep doesn't guarantee
      // an inventory handle; when absent, the digest omits the stock
      // marker and the operator's email template gets a plain price.
      var inStock = null;
      if (catalog.inventory && typeof catalog.inventory.get === "function") {
        try {
          var inv = await catalog.inventory.get(entry.variant_id || entry.product_id);
          if (inv) {
            var avail = Number(inv.stock_on_hand || 0) - Number(inv.stock_held || 0);
            inStock = avail > 0;
          }
        } catch (_e3) { /* drop-silent — stock is cosmetic */ }
      }

      lines.push({
        product_id:  entry.product_id,
        variant_id:  entry.variant_id || null,
        title:       title,
        price:       priceStr,
        in_stock:    inStock,
        product_url: "/products/" + entry.product_id,
      });
    }

    // Render the HTML + text bodies. Operator-customisable rendering
    // lives in the email primitive's `sendWishlistDigest` handle; the
    // body returned here is a default the dispatcher hands the mailer
    // as a fallback (and the admin-preview shows verbatim).
    var htmlBody = "<h1>Your wishlist this period</h1>";
    var textBody = "Your wishlist this period\n=========================\n";
    if (lines.length === 0) {
      htmlBody += "<p>No items in your wishlist right now.</p>";
      textBody += "\nNo items in your wishlist right now.\n";
    } else {
      htmlBody += "<ul>";
      for (var j = 0; j < lines.length; j += 1) {
        var ln = lines[j];
        var stockBadge = ln.in_stock === true  ? " (in stock)"
                       : ln.in_stock === false ? " (out of stock)"
                       :                          "";
        htmlBody += "<li><a href=\"" + _htmlEscape(ln.product_url) + "\">" +
                    _htmlEscape(ln.title) + "</a> — " +
                    _htmlEscape(ln.price) + _htmlEscape(stockBadge) + "</li>";
        textBody += "- " + ln.title + " — " + ln.price + stockBadge + "\n  " + ln.product_url + "\n";
      }
      htmlBody += "</ul>";
    }

    return {
      customer_id: customerId,
      currency:    currency,
      item_count:  lines.length,
      lines:       lines,
      html:        htmlBody,
      text:        textBody,
    };
  }

  // ---- dispatchTick ------------------------------------------------

  async function dispatchTick(input) {
    input = input || {};
    var now       = input.now == null ? _now() : _epochMs(input.now, "now");
    var batchSize = _batchSize(input.batch_size);

    var due = await query(
      "SELECT * FROM wishlist_digest_enrollments " +
      "WHERE status = 'active' AND next_dispatch_at <= ?1 " +
      "ORDER BY next_dispatch_at ASC, id ASC LIMIT ?2",
      [now, batchSize],
    );

    var dispatched = [];
    var skipped = 0;
    var skippedBy = { schedule_missing: 0, no_email: 0, suppressed: 0, email_dispatch_failed: 0 };

    for (var i = 0; i < due.rows.length; i += 1) {
      var enrollment = due.rows[i];
      var scheduleRow = await _getScheduleBySlug(enrollment.schedule_slug);
      if (!scheduleRow || scheduleRow.archived_at != null) {
        // Schedule archived after enrollment — pause the enrollment so
        // the dispatcher stops re-walking it; the operator's metrics
        // show paused enrollments separately from active ones. A pause
        // (not cancel) so a future resume can re-arm if the operator
        // restores the schedule.
        var pauseTs = _now();
        await query(
          "UPDATE wishlist_digest_enrollments SET status = 'paused', " +
          "paused_reason = 'schedule-archived-or-missing', paused_at = ?1 WHERE id = ?2",
          [pauseTs, enrollment.id],
        );
        skipped += 1; skippedBy.schedule_missing += 1;
        continue;
      }
      var schedule = _shapeSchedule(scheduleRow);

      // ---- ATOMIC CLAIM ------------------------------------------------
      //
      // The send + sent-ledger INSERT below are an EXACTLY-ONCE side
      // effect. Two concurrent ticks both read this row from their own
      // snapshot SELECT, both pass the JS checks, and — without a claim —
      // both would email the customer and both would ledger a sent row.
      // SQLite/D1 serializes writers, so a conditional UPDATE that
      // advances the cursor on the OBSERVED next_dispatch_at IS the claim:
      // exactly one tick flips next_dispatch_at away from `observedNext`,
      // and only the winner (rowCount === 1) runs the side effect. The
      // loser (rowCount === 0) lost the race — skip silently (no email,
      // no ledger row). The new cursor matches what the post-send advance
      // used to write, so a single sequential caller is unaffected.
      var observedNext = Number(enrollment.next_dispatch_at);
      // Advance the cadence one period past the claimed next_dispatch_at.
      // A STALE enrollment (cron was down / enrolled long ago) sits many
      // periods in the past; one period still doesn't clear `now`, so the
      // next tick would re-fire — a flood. When one period still doesn't
      // clear `now`, snap straight to the next occurrence strictly after
      // `now`. The catch-up costs at most ONE digest, never a storm.
      var nextDispatchAt = _advanceByOnePeriod(schedule, observedNext);
      if (nextDispatchAt <= now) {
        nextDispatchAt = _nextDispatchAt(schedule, now);
      }
      var claim = await query(
        "UPDATE wishlist_digest_enrollments SET next_dispatch_at = ?1 " +
        "WHERE id = ?2 AND status = 'active' AND next_dispatch_at = ?3",
        [nextDispatchAt, enrollment.id, observedNext],
      );
      if (!b.sql.casWon(claim).won) {
        // Another tick already claimed this period — don't double-send.
        continue;
      }

      // Un-claim helper. The claim advanced next_dispatch_at before we
      // knew whether the send would succeed; a TRANSIENT failure (compose
      // threw, no email yet, mailer down) must leave the row due again so
      // a future tick re-attempts — exactly the pre-claim behavior. Roll
      // the cursor back to observedNext, guarded on the value we claimed
      // so a concurrent winner's advance is never clobbered.
      var _unclaim = async function () {
        // Roll the cursor to a value DISTINCT from the one this tick
        // observed (observedNext + 1ms), NOT back to the exact observed
        // value: a concurrent overlapping tick that read the same cursor
        // is waiting to claim `next_dispatch_at = observedNext`, and
        // restoring the exact value would let it match and re-send the
        // digest in the same overlap. observedNext+1 stays due, so a LATER
        // tick re-attempts (deferred, not re-fired in this overlap); the
        // guard on the claimed value means a concurrent winner's advance
        // is never clobbered.
        await query(
          "UPDATE wishlist_digest_enrollments SET next_dispatch_at = ?1 " +
          "WHERE id = ?2 AND next_dispatch_at = ?3",
          [observedNext + 1, enrollment.id, nextDispatchAt],
        );
      };

      // Compose the digest body. composeDigest does its own reads
      // against wishlist + catalog; failures inside it bubble up here
      // and the dispatcher logs the row as skipped so a flapping
      // catalog read doesn't poison the rest of the batch.
      var digest = null;
      try { digest = await composeDigest({ customer_id: enrollment.customer_id }); }
      catch (_e) {
        await _unclaim();
        skipped += 1; skippedBy.email_dispatch_failed += 1;
        continue;
      }

      // Resolve the customer's email. Absent → skipped no_email; the
      // enrollment stays active so a future tick (after the operator
      // wires emailForCustomer or backfills the customer's email) re-
      // attempts.
      var customerEmail = null;
      if (emailForCustomer) {
        try { customerEmail = await emailForCustomer(enrollment.customer_id); }
        catch (_e2) { customerEmail = null; }
      }
      if (typeof customerEmail !== "string" || !customerEmail.length) {
        await _unclaim();
        skipped += 1; skippedBy.no_email += 1;
        continue;
      }

      // Suppressions short-circuit. When wired, an address on the
      // suppress list ledgers a row with item_count = 0 + advances
      // next_dispatch_at, so the cadence stays on rails but no email
      // fires (operator's metrics still surface the customer as
      // "enrolled but suppressed").
      var isSuppressed = false;
      if (emailSuppressions) {
        try {
          var supView = await emailSuppressions.isSuppressed({
            email: customerEmail,
            scope: "marketing",
          });
          isSuppressed = !!(supView && supView.suppressed === true);
        } catch (_e3) { isSuppressed = false; }
      }

      var sentItemCount = isSuppressed ? 0 : digest.item_count;
      if (!isSuppressed) {
        try {
          await email.sendWishlistDigest({
            customer_email: customerEmail,
            schedule_slug:  enrollment.schedule_slug,
            currency:       digest.currency,
            item_count:     digest.item_count,
            lines:          digest.lines,
            html:           digest.html,
            text:           digest.text,
          });
        } catch (_e4) {
          await _unclaim();
          skipped += 1; skippedBy.email_dispatch_failed += 1;
          continue;
        }
      } else {
        skipped += 1; skippedBy.suppressed += 1;
        // Still ledger + advance — the cadence stays on rails, but the
        // attempt isn't counted as a successful send.
      }

      // Ledger the sent row (both branches — suppressed cadence stays on
      // rails so the customer sees their next-dispatch-ETA roll forward).
      // The cadence advance already happened in the atomic claim above,
      // so reaching here means this tick won the race and is the sole
      // writer of this period's ledger row + side effect.
      var sentId = b.uuid.v7();
      var sentAt = _now(now);
      await query(
        "INSERT INTO wishlist_digest_sent (id, enrollment_id, item_count, sent_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [sentId, enrollment.id, sentItemCount, sentAt],
      );
      if (!isSuppressed) {
        dispatched.push({
          id:               sentId,
          enrollment_id:    enrollment.id,
          item_count:       sentItemCount,
          sent_at:          sentAt,
          suppressed:       false,
          next_dispatch_at: nextDispatchAt,
        });
      }
    }

    return {
      dispatched: dispatched,
      sent:       dispatched.length,
      skipped:    skipped,
      skipped_by: skippedBy,
    };
  }

  // ---- recordDigestSent --------------------------------------------

  async function recordDigestSent(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistDigest.recordDigestSent: input object required");
    }
    var enrollmentId = _enrollmentId(input.enrollment_id);
    var itemCount    = _itemCount(input.item_count);
    var sentAtOpt    = _optionalEpochMs(input.sent_at, "sent_at");

    var existing = await _getEnrollmentById(enrollmentId);
    if (!existing) {
      throw new TypeError("wishlistDigest.recordDigestSent: enrollment_id " +
        JSON.stringify(enrollmentId) + " not found");
    }

    var sentAt = sentAtOpt != null ? _now(sentAtOpt) : _now();
    var sentId = b.uuid.v7();
    await query(
      "INSERT INTO wishlist_digest_sent (id, enrollment_id, item_count, sent_at) " +
      "VALUES (?1, ?2, ?3, ?4)",
      [sentId, enrollmentId, itemCount, sentAt],
    );

    // Advance the cadence — recordDigestSent is the terminal marker
    // for a successful send regardless of which path (sync via
    // dispatchTick / async via mailer callback) produced the row.
    var scheduleRow = await _getScheduleBySlug(existing.schedule_slug);
    if (scheduleRow && scheduleRow.archived_at == null) {
      var schedule = _shapeSchedule(scheduleRow);
      var nextDispatchAt = _advanceByOnePeriod(schedule, Number(existing.next_dispatch_at));
      await query(
        "UPDATE wishlist_digest_enrollments SET next_dispatch_at = ?1 WHERE id = ?2",
        [nextDispatchAt, enrollmentId],
      );
    }

    var r = await query("SELECT * FROM wishlist_digest_sent WHERE id = ?1 LIMIT 1", [sentId]);
    return _shapeSent(r.rows[0]);
  }

  // ---- metricsForSchedule ------------------------------------------

  async function metricsForSchedule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistDigest.metricsForSchedule: input object required");
    }
    var slug = _slug(input.slug, "slug");
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (to < from) {
      throw new TypeError("wishlistDigest.metricsForSchedule: to must be >= from");
    }
    var r = await query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(item_count), 0) AS items " +
      "FROM wishlist_digest_sent s " +
      "JOIN wishlist_digest_enrollments e ON e.id = s.enrollment_id " +
      "WHERE e.schedule_slug = ?1 AND s.sent_at >= ?2 AND s.sent_at <= ?3",
      [slug, from, to],
    );
    var row = r.rows[0] || {};
    return {
      slug:          slug,
      from:          from,
      to:            to,
      sent_count:    Number(row.n || 0),
      total_items:   Number(row.items || 0),
    };
  }

  return {
    FREQUENCIES:           FREQUENCIES,
    STATUSES:              STATUSES,

    defineSchedule:        defineSchedule,
    getSchedule:           getSchedule,
    listSchedules:         listSchedules,
    enrollCustomer:        enrollCustomer,
    pauseEnrollment:       pauseEnrollment,
    resumeEnrollment:      resumeEnrollment,
    enrollmentsForCustomer:enrollmentsForCustomer,
    composeDigest:         composeDigest,
    dispatchTick:          dispatchTick,
    recordDigestSent:      recordDigestSent,
    metricsForSchedule:    metricsForSchedule,
  };
}

// Top-level `run()` for direct invocation — exercises the primitive's
// factory shape against an in-memory query stub so the smoke caller
// can confirm the module loads + the factory composes without touching
// a remote D1 or a migration file. The stub is minimal; it covers the
// defineSchedule happy path.
async function run() {
  var schedules = {};
  var q = async function (sql, params) {
    params = params || [];
    var verb = sql.replace(/^\s+/, "").split(/\s+/)[0].toUpperCase();
    if (verb === "SELECT" && /FROM wishlist_digest_schedules/.test(sql)) {
      var s = schedules[params[0]];
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }
    if (verb === "INSERT" && /wishlist_digest_schedules/.test(sql)) {
      schedules[params[0]] = {
        slug:         params[0],
        frequency:    params[1],
        day_of_week:  params[2],
        day_of_month: params[3],
        time_local:   params[4],
        timezone:     params[5],
        archived_at:  null,
        created_at:   params[6],
        updated_at:   params[6],
      };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  var stubWishlist = { listForCustomer: async function () { return { rows: [], nextCursor: null }; } };
  var stubCatalog  = {
    products:  { get: async function () { return null; } },
    prices:    { current: async function () { return null; } },
  };
  var stubEmail    = { sendWishlistDigest: async function () { return { ok: true }; } };
  var wd = create({
    query:    q,
    wishlist: stubWishlist,
    catalog:  stubCatalog,
    email:    stubEmail,
  });
  await wd.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "09:00",
    timezone:    "UTC",
  });
  return { ok: true };
}

module.exports = {
  create:       create,
  run:          run,
  FREQUENCIES:  FREQUENCIES,
  STATUSES:     STATUSES,
};
