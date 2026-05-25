"use strict";
/**
 * @module shop.businessHours
 * @title  Business hours — operator-defined open/close windows per
 *         location or tenant
 *
 * @intro
 *   The storefront, support-routing layer, and "we're closed" banner
 *   all ask the same three questions of an operator-authored schedule:
 *
 *     - "Are we open right now?" (`isOpenAt`)
 *     - "If not, when do we re-open?" (`nextOpenAt`)
 *     - "If yes, when do we close?" (`nextCloseAt`)
 *
 *   A schedule has three layered parts:
 *
 *     1. `weekly_hours` — base array of `{ day, open, close }` entries.
 *        `day` is 0..6 with Sun=0; `open` / `close` are `HH:MM` 24-hour
 *        strings in the schedule's IANA `timezone`. Days absent from
 *        the array are closed by default. Multiple entries for the
 *        same day are allowed (split shift — open mornings + evenings,
 *        closed at lunch).
 *
 *     2. Holidays — full-day closures attached to a specific calendar
 *        date (YYYY-MM-DD in the schedule's timezone). Suppress the
 *        regular weekly_hours for that weekday. Authored once a year.
 *
 *     3. Exceptions — per-date overrides that adjust open/close for a
 *        specific day without removing it (early-close for a private
 *        event, late-open after maintenance, fully-closed one-off).
 *        When `closed = true` the day is treated as closed regardless;
 *        otherwise non-null `open` / `close` columns REPLACE the
 *        weekly_hours window for that date (null inherits the base).
 *
 *   All date math is calendar-day-deterministic against the schedule's
 *   IANA timezone via `Intl.DateTimeFormat` — no manual offset
 *   bookkeeping, no DST drift. The `when` input is epoch-ms; the
 *   `nextOpenAt` / `nextCloseAt` return epoch-ms so the caller can
 *   format for any locale without re-doing the timezone math.
 *
 *   Monotonic clock pattern: every primitive that reads "now" accepts
 *   an injectable `when` (epoch-ms) so tests can pin a moment without
 *   stubbing the global clock; live callers omit `when` and the
 *   primitive falls back to `Date.now()`.
 *
 *   Composes:
 *     - Pure JS + `Intl.DateTimeFormat` for tz-correct calendar math.
 *       No blamejs primitives are required for this module — the
 *       storage layer is the same query-injection shape every shop
 *       primitive uses (`opts.query` -> framework `externalDb.query`).
 *
 *   Surface:
 *     defineSchedule({ slug, timezone, weekly_hours, holidays?, exceptions? })
 *     isOpenAt({ slug, when? })
 *     nextOpenAt({ slug, when? })
 *     nextCloseAt({ slug, when? })
 *     weekSummary({ slug })
 *     addException({ slug, date, open?, close?, closed? })
 *     removeException({ slug, date })
 *     addHoliday({ slug, date, name })
 *     listSchedules({ include_archived? })
 *     archiveSchedule(slug)
 *
 *   Storage:
 *     - `business_hour_schedules` + `business_hour_exceptions`
 *       (migration `0127_business_hours.sql`).
 *
 * @primitive businessHours
 * @related   shop.deliveryEstimate
 */

var b = require("./vendor/blamejs");
var C = b.constants;

var MAX_SLUG_LEN     = 64;
var SLUG_RE          = /^[a-z0-9][a-z0-9_-]{0,63}$/;

var TZ_RE            = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/;

var HHMM_RE          = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

var YMD_RE           = /^\d{4}-\d{2}-\d{2}$/;

var MAX_WEEKLY_HOURS = 64;       // 7 days x 8 split-shifts each is more than any real schedule needs
var MAX_NAME_LEN     = 200;

var DAY_MS           = C.TIME.days(1);
var SEARCH_DAYS      = 366 * 2;  // worst-case "find next open" walk — 2 calendar years of closures

// ---- validators ---------------------------------------------------------

function _hasControlByte(s) {
  for (var i = 0; i < s.length; i += 1) {
    var cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) return true;
  }
  return false;
}

function _slug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("businessHours: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("businessHours: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "businessHours: slug must match /^[a-z0-9][a-z0-9_-]{0,63}$/ — " +
      "lowercase alphanumerics with `_`/`-`, must not start with separator"
    );
  }
  return s;
}

function _tz(s, label) {
  if (typeof s !== "string" || !TZ_RE.test(s)) {
    throw new TypeError(
      "businessHours: " + label + " must be an IANA timezone name (Area/City)"
    );
  }
  // Semantic gate — Intl throws on an unknown zone (typo at config
  // time surfaces loud).
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
  } catch (_e) {
    throw new TypeError(
      "businessHours: " + label + " is not a known IANA timezone (got " + JSON.stringify(s) + ")"
    );
  }
  return s;
}

function _hhmm(s, label) {
  if (typeof s !== "string" || !HHMM_RE.test(s)) {
    throw new TypeError(
      "businessHours: " + label + " must be a HH:MM 24-hour string (got " + JSON.stringify(s) + ")"
    );
  }
  return s;
}

function _day(n, label) {
  if (!Number.isInteger(n) || n < 0 || n > 6) {
    throw new TypeError("businessHours: " + label + " must be an integer 0..6 (Sun=0)");
  }
  return n;
}

function _ymd(s, label) {
  if (typeof s !== "string" || !YMD_RE.test(s)) {
    throw new TypeError("businessHours: " + label + " must be a YYYY-MM-DD string");
  }
  var y  = Number(s.slice(0, 4));
  var mo = Number(s.slice(5, 7));
  var d  = Number(s.slice(8, 10));
  // Round-trip via Date.UTC — refuses Feb 30, month 13, etc.
  var ts = Date.UTC(y, mo - 1, d);
  var dt = new Date(ts);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== (mo - 1) || dt.getUTCDate() !== d) {
    throw new TypeError("businessHours: " + label + " — not a real calendar date");
  }
  return s;
}

function _name(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("businessHours: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError("businessHours: " + label + " must be <= " + MAX_NAME_LEN + " characters");
  }
  if (_hasControlByte(s)) {
    throw new TypeError("businessHours: " + label + " must not contain control characters");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n)) {
    throw new TypeError("businessHours: " + label + " must be an integer epoch-ms");
  }
  return n;
}

// Convert HH:MM into minutes-since-midnight (0..1439). 24:00 is NOT
// accepted as an alias for midnight — operators use 23:59 if they
// want "open until the very end of the day" and the lookup paths
// treat close-after-open as a normal window. Closed-day = absent
// row, not zero-length window.
function _hhmmToMinutes(s) {
  var hh = Number(s.slice(0, 2));
  var mm = Number(s.slice(3, 5));
  return hh * 60 + mm;
}

// Validate one weekly-hours row. Refuses close <= open (zero-length
// or inverted windows). Operators with overnight-open hours (bar
// 18:00 -> 02:00) author the row as two entries: day N 18:00-23:59
// and day N+1 00:00-02:00. Cross-midnight windows are intentionally
// not a single-row concept — the storefront banner has to know which
// calendar day owns "right now" and the two-row form makes that
// unambiguous.
function _weeklyHourEntry(row, label) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("businessHours: " + label + " must be an object {day, open, close}");
  }
  var day   = _day(row.day, label + ".day");
  var open  = _hhmm(row.open, label + ".open");
  var close = _hhmm(row.close, label + ".close");
  var openM  = _hhmmToMinutes(open);
  var closeM = _hhmmToMinutes(close);
  if (closeM <= openM) {
    throw new TypeError(
      "businessHours: " + label + " — close must be strictly after open " +
      "(got " + JSON.stringify(open) + " -> " + JSON.stringify(close) + "). " +
      "Author overnight-open windows as two adjacent-day entries"
    );
  }
  return { day: day, open: open, close: close };
}

function _weeklyHours(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError("businessHours: weekly_hours must be an array");
  }
  if (arr.length > MAX_WEEKLY_HOURS) {
    throw new TypeError("businessHours: weekly_hours must be <= " + MAX_WEEKLY_HOURS + " entries");
  }
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    out.push(_weeklyHourEntry(arr[i], "weekly_hours[" + i + "]"));
  }
  // Refuse overlapping windows on the same day — operator either
  // authored a typo or expected merge semantics; neither is safe to
  // assume silently.
  var byDay = {};
  for (var j = 0; j < out.length; j += 1) {
    var e = out[j];
    if (!byDay[e.day]) byDay[e.day] = [];
    byDay[e.day].push(e);
  }
  for (var d = 0; d < 7; d += 1) {
    var rows = byDay[d];
    if (!rows || rows.length < 2) continue;
    rows.sort(function (a, b) { return _hhmmToMinutes(a.open) - _hhmmToMinutes(b.open); });
    for (var k = 1; k < rows.length; k += 1) {
      var prevClose = _hhmmToMinutes(rows[k - 1].close);
      var thisOpen  = _hhmmToMinutes(rows[k].open);
      if (thisOpen < prevClose) {
        throw new TypeError(
          "businessHours: weekly_hours — overlapping windows on day " + d +
          " (" + rows[k - 1].open + "-" + rows[k - 1].close + " and " +
          rows[k].open + "-" + rows[k].close + ")"
        );
      }
    }
  }
  return out;
}

function _now() { return Date.now(); }

// ---- timezone-aware calendar math ---------------------------------------

// Decompose an epoch-ms into {y, m, d, hh, mm, weekday(0..6 Sun=0)}
// at the requested IANA timezone. Intl handles DST automatically —
// March / November transitions produce the wall-clock parts an
// operator authored against, no manual offset math.
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
      // Intl's "h23" hourCycle emits 0..23 but some locales emit "24"
      // at midnight; normalize defensively.
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

// Pad helpers
function _pad2(n) { return n < 10 ? "0" + n : String(n); }

// Format {y, m, d} as YYYY-MM-DD.
function _ymdString(parts) {
  return String(parts.y) + "-" + _pad2(parts.m) + "-" + _pad2(parts.d);
}

// Add `n` calendar days to {y, m, d}. UTC arithmetic — month / year
// roll over naturally without DST entanglement (this walks calendar
// days, not wall-clock spans).
function _addCalendarDays(parts, n) {
  var ts = Date.UTC(parts.y, parts.m - 1, parts.d) + n * DAY_MS;
  var dt = new Date(ts);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

// Weekday (Sun=0..Sat=6) of a {y, m, d} calendar date — uses Date.UTC
// so the result is timezone-independent (a calendar date has a fixed
// weekday regardless of the viewer's zone).
function _weekdayOfYMD(parts) {
  var ts = Date.UTC(parts.y, parts.m - 1, parts.d);
  return new Date(ts).getUTCDay();
}

// Resolve a (YYYY-MM-DD, HH:MM, IANA tz) tuple back to an epoch-ms.
// The challenge: `Date.UTC` doesn't know about DST. We need an epoch
// that, when re-formatted in `tz`, produces the requested wall clock.
//
// Algorithm: assume the local time is UTC, then ask Intl what wall
// clock that epoch maps to in `tz`, then correct by the delta. Two
// passes converge in every real case (the second iteration handles
// the rare DST-transition fold where the first guess landed on the
// wrong side of the boundary).
function _wallClockToEpochMs(tz, ymd, hhmm) {
  var y = Number(ymd.slice(0, 4));
  var mo = Number(ymd.slice(5, 7));
  var d  = Number(ymd.slice(8, 10));
  var hh = Number(hhmm.slice(0, 2));
  var mm = Number(hhmm.slice(3, 5));
  // First guess: treat the input as UTC.
  var guess = Date.UTC(y, mo - 1, d, hh, mm);
  // Two refinement passes — DST transitions need at most one re-walk;
  // a second pass is a no-op cheap safety.
  for (var pass = 0; pass < 2; pass += 1) {
    var wall = _wallClockIn(tz, guess);
    var wallMs = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm);
    var requestedMs = Date.UTC(y, mo - 1, d, hh, mm);
    var delta = requestedMs - wallMs;
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  function _hydrateSchedule(row) {
    if (!row) return null;
    var weekly = [];
    try { weekly = JSON.parse(row.weekly_hours_json || "[]"); }
    catch (_e) { weekly = []; /* drop-silent — by design; stored shape is primitive-owned */ }
    return {
      slug:          row.slug,
      timezone:      row.timezone,
      weekly_hours:  weekly,
      archived_at:   row.archived_at == null ? null : Number(row.archived_at),
      created_at:    Number(row.created_at),
      updated_at:    Number(row.updated_at),
    };
  }

  function _hydrateException(row) {
    return {
      date:       row.date,
      open:       row.open == null ? null : row.open,
      close:      row.close == null ? null : row.close,
      closed:     Number(row.closed) === 1,
      kind:       row.kind,
      name:       row.name == null ? null : row.name,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  async function _getScheduleRaw(slug) {
    var r = await query(
      "SELECT * FROM business_hour_schedules WHERE slug = ?1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function _getExceptionsByDate(slug) {
    var r = await query(
      "SELECT * FROM business_hour_exceptions WHERE schedule_slug = ?1",
      [slug],
    );
    var byDate = {};
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      byDate[row.date] = _hydrateException(row);
    }
    return byDate;
  }

  // Build the list of `{open, close}` windows that apply on a given
  // calendar date for the schedule. Returns `[]` for closed days. The
  // override layering is: exception (with closed=true OR explicit
  // open/close) > holiday > weekly_hours. Exceptions with one-side
  // null inherit the other side from weekly_hours.
  function _windowsForDate(schedule, ymd, overrides) {
    var override = overrides[ymd];
    if (override && override.kind === "holiday") return [];
    if (override && override.kind === "exception" && override.closed) return [];

    var weekday = _weekdayOfYMD({
      y: Number(ymd.slice(0, 4)),
      m: Number(ymd.slice(5, 7)),
      d: Number(ymd.slice(8, 10)),
    });
    var base = [];
    for (var i = 0; i < schedule.weekly_hours.length; i += 1) {
      if (schedule.weekly_hours[i].day === weekday) {
        base.push({
          open:  schedule.weekly_hours[i].open,
          close: schedule.weekly_hours[i].close,
        });
      }
    }

    if (!override || override.kind !== "exception") return base;

    // Exception with explicit open/close — REPLACES the weekly_hours
    // for this date. A null side inherits from the first weekly entry
    // for the same weekday (most common: "close early today" leaves
    // `open` null + sets `close` to 15:00).
    var inheritedOpen  = base.length ? base[0].open  : null;
    var inheritedClose = base.length ? base[0].close : null;
    var openFinal  = override.open  != null ? override.open  : inheritedOpen;
    var closeFinal = override.close != null ? override.close : inheritedClose;
    if (openFinal == null || closeFinal == null) {
      // The operator authored an exception with one side null and no
      // matching weekly_hours to inherit from — interpret as closed
      // (no usable window). Drop-silent — the schedule renderer shows
      // the unbalanced override; the lookup just refuses to serve a
      // half-built window.
      return [];
    }
    return [{ open: openFinal, close: closeFinal }];
  }

  return {
    SLUG_RE:           SLUG_RE,
    TZ_RE:             TZ_RE,
    HHMM_RE:           HHMM_RE,
    YMD_RE:            YMD_RE,
    MAX_WEEKLY_HOURS:  MAX_WEEKLY_HOURS,

    // Register a schedule. Holidays + exceptions can be supplied
    // inline; both go into `business_hour_exceptions` (the table
    // doesn't distinguish — the `kind` column does).
    //
    // Re-calling with the same slug refuses — the audit trail is
    // threaded by slug, mutations route through `addException` /
    // `removeException` / `addHoliday` / `archiveSchedule` instead.
    defineSchedule: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.defineSchedule: input object required");
      }
      var slug         = _slug(input.slug);
      var timezone     = _tz(input.timezone, "timezone");
      var weeklyHours  = _weeklyHours(input.weekly_hours || []);

      var holidays = input.holidays == null ? [] : input.holidays;
      if (!Array.isArray(holidays)) {
        throw new TypeError("businessHours.defineSchedule: holidays must be an array");
      }
      var exceptions = input.exceptions == null ? [] : input.exceptions;
      if (!Array.isArray(exceptions)) {
        throw new TypeError("businessHours.defineSchedule: exceptions must be an array");
      }

      // Validate every holiday + exception up-front so a malformed
      // entry doesn't leave a half-defined schedule on disk.
      var validatedHolidays = [];
      var seenDates = {};
      for (var i = 0; i < holidays.length; i += 1) {
        var h = holidays[i];
        if (!h || typeof h !== "object") {
          throw new TypeError("businessHours.defineSchedule: holidays[" + i + "] must be an object {date, name}");
        }
        var hDate = _ymd(h.date, "holidays[" + i + "].date");
        var hName = _name(h.name, "holidays[" + i + "].name");
        if (seenDates[hDate]) {
          throw new TypeError(
            "businessHours.defineSchedule: holidays[" + i + "] duplicates date " + hDate
          );
        }
        seenDates[hDate] = true;
        validatedHolidays.push({ date: hDate, name: hName });
      }
      var validatedExceptions = [];
      for (var j = 0; j < exceptions.length; j += 1) {
        var e = exceptions[j];
        if (!e || typeof e !== "object") {
          throw new TypeError("businessHours.defineSchedule: exceptions[" + j + "] must be an object");
        }
        var eDate = _ymd(e.date, "exceptions[" + j + "].date");
        if (seenDates[eDate]) {
          throw new TypeError(
            "businessHours.defineSchedule: exceptions[" + j + "] duplicates date " + eDate
          );
        }
        seenDates[eDate] = true;
        var eOpen  = e.open  == null ? null : _hhmm(e.open,  "exceptions[" + j + "].open");
        var eClose = e.close == null ? null : _hhmm(e.close, "exceptions[" + j + "].close");
        var eClosed = e.closed === true;
        if (eOpen && eClose && _hhmmToMinutes(eClose) <= _hhmmToMinutes(eOpen)) {
          throw new TypeError(
            "businessHours.defineSchedule: exceptions[" + j + "] — close must be strictly after open"
          );
        }
        if (!eClosed && eOpen == null && eClose == null) {
          throw new TypeError(
            "businessHours.defineSchedule: exceptions[" + j + "] — must set closed=true OR at least one of open/close"
          );
        }
        validatedExceptions.push({
          date: eDate, open: eOpen, close: eClose, closed: eClosed,
        });
      }

      var existing = await _getScheduleRaw(slug);
      if (existing) {
        var err = new Error(
          "businessHours.defineSchedule: refused — schedule '" + slug + "' already exists" +
          (existing.archived_at != null ? " (archived)" : "") +
          ". Mutations route through addException / addHoliday / archiveSchedule"
        );
        err.code = "BUSINESS_HOURS_SCHEDULE_EXISTS";
        throw err;
      }

      var ts = _now();
      await query(
        "INSERT INTO business_hour_schedules " +
        "(slug, timezone, weekly_hours_json, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
        [slug, timezone, JSON.stringify(weeklyHours), ts],
      );
      for (var p = 0; p < validatedHolidays.length; p += 1) {
        var vh = validatedHolidays[p];
        await query(
          "INSERT INTO business_hour_exceptions " +
          "(schedule_slug, date, open, close, closed, kind, name, created_at, updated_at) " +
          "VALUES (?1, ?2, NULL, NULL, 1, 'holiday', ?3, ?4, ?4)",
          [slug, vh.date, vh.name, ts],
        );
      }
      for (var q = 0; q < validatedExceptions.length; q += 1) {
        var ve = validatedExceptions[q];
        await query(
          "INSERT INTO business_hour_exceptions " +
          "(schedule_slug, date, open, close, closed, kind, name, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 'exception', NULL, ?6, ?6)",
          [slug, ve.date, ve.open, ve.close, ve.closed ? 1 : 0, ts],
        );
      }

      return await this.getSchedule(slug);
    },

    // Read one. Returns `null` when no such schedule exists; archived
    // schedules ARE returned (audit dashboards want them). The lookup
    // paths (`isOpenAt` etc.) filter archived rows themselves.
    getSchedule: async function (slug) {
      var s   = _slug(slug);
      var raw = await _getScheduleRaw(s);
      if (!raw) return null;
      var hydrated = _hydrateSchedule(raw);
      var byDate   = await _getExceptionsByDate(s);
      var holidays   = [];
      var exceptions = [];
      var dates = Object.keys(byDate).sort();
      for (var i = 0; i < dates.length; i += 1) {
        var ex = byDate[dates[i]];
        if (ex.kind === "holiday") holidays.push({ date: ex.date, name: ex.name });
        else                       exceptions.push({
          date: ex.date, open: ex.open, close: ex.close, closed: ex.closed,
        });
      }
      hydrated.holidays   = holidays;
      hydrated.exceptions = exceptions;
      return hydrated;
    },

    // List schedules. Default returns every non-archived schedule;
    // `include_archived: true` includes archived rows for an audit
    // dashboard. Slug ASC ordering for determinism.
    listSchedules: async function (listOpts) {
      listOpts = listOpts || {};
      var includeArchived = listOpts.include_archived === true;
      var sql = "SELECT * FROM business_hour_schedules";
      if (!includeArchived) sql += " WHERE archived_at IS NULL";
      sql += " ORDER BY slug ASC";
      var r = await query(sql, []);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateSchedule(r.rows[i]));
      return out;
    },

    // Soft-delete — stamps archived_at. The row stays on disk for
    // audit; archived schedules drop out of `isOpenAt` / `nextOpenAt`
    // / `nextCloseAt` / `weekSummary` lookups. Idempotent.
    archiveSchedule: async function (slug) {
      var s = _slug(slug);
      var current = await _getScheduleRaw(s);
      if (!current) return null;
      if (current.archived_at != null) return await this.getSchedule(s);
      var ts = _now();
      await query(
        "UPDATE business_hour_schedules SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [ts, s],
      );
      return await this.getSchedule(s);
    },

    // Add or replace a holiday on a date. Upsert semantics — re-
    // calling on the same date REPLACES the prior holiday name (and
    // converts an exception row to a holiday row if needed). Archived
    // schedules refuse all mutations.
    addHoliday: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.addHoliday: input object required");
      }
      var slug = _slug(input.slug);
      var date = _ymd(input.date, "date");
      var name = _name(input.name, "name");
      var current = await _getScheduleRaw(slug);
      if (!current) return null;
      if (current.archived_at != null) {
        var refused = new Error("businessHours.addHoliday: refused — schedule is archived");
        refused.code = "BUSINESS_HOURS_SCHEDULE_ARCHIVED";
        throw refused;
      }
      var ts = _now();
      // Idempotent upsert — DELETE then INSERT keeps the AUTOINCREMENT
      // ID monotonic and avoids relying on UPSERT semantics that vary
      // across D1 driver versions.
      await query(
        "DELETE FROM business_hour_exceptions WHERE schedule_slug = ?1 AND date = ?2",
        [slug, date],
      );
      await query(
        "INSERT INTO business_hour_exceptions " +
        "(schedule_slug, date, open, close, closed, kind, name, created_at, updated_at) " +
        "VALUES (?1, ?2, NULL, NULL, 1, 'holiday', ?3, ?4, ?4)",
        [slug, date, name, ts],
      );
      await query(
        "UPDATE business_hour_schedules SET updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return await this.getSchedule(slug);
    },

    // Add or replace an exception on a date. Either `closed: true` OR
    // at least one of (`open`, `close`) must be supplied. A null side
    // inherits from the weekly_hours at lookup time. Upsert semantics.
    addException: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.addException: input object required");
      }
      var slug   = _slug(input.slug);
      var date   = _ymd(input.date, "date");
      var open   = input.open  == null ? null : _hhmm(input.open,  "open");
      var close  = input.close == null ? null : _hhmm(input.close, "close");
      var closed = input.closed === true;
      if (open && close && _hhmmToMinutes(close) <= _hhmmToMinutes(open)) {
        throw new TypeError(
          "businessHours.addException: close must be strictly after open"
        );
      }
      if (!closed && open == null && close == null) {
        throw new TypeError(
          "businessHours.addException: must set closed=true OR at least one of open/close"
        );
      }
      var current = await _getScheduleRaw(slug);
      if (!current) return null;
      if (current.archived_at != null) {
        var refused = new Error("businessHours.addException: refused — schedule is archived");
        refused.code = "BUSINESS_HOURS_SCHEDULE_ARCHIVED";
        throw refused;
      }
      var ts = _now();
      await query(
        "DELETE FROM business_hour_exceptions WHERE schedule_slug = ?1 AND date = ?2",
        [slug, date],
      );
      await query(
        "INSERT INTO business_hour_exceptions " +
        "(schedule_slug, date, open, close, closed, kind, name, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'exception', NULL, ?6, ?6)",
        [slug, date, open, close, closed ? 1 : 0, ts],
      );
      await query(
        "UPDATE business_hour_schedules SET updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return await this.getSchedule(slug);
    },

    // Remove ANY override (holiday or exception) on a specific date.
    // Returns the refreshed schedule, or `null` when the schedule
    // doesn't exist. Idempotent — removing a date that had no
    // override is a no-op that still bumps `updated_at` so the audit
    // trail records the operator action.
    removeException: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.removeException: input object required");
      }
      var slug = _slug(input.slug);
      var date = _ymd(input.date, "date");
      var current = await _getScheduleRaw(slug);
      if (!current) return null;
      if (current.archived_at != null) {
        var refused = new Error("businessHours.removeException: refused — schedule is archived");
        refused.code = "BUSINESS_HOURS_SCHEDULE_ARCHIVED";
        throw refused;
      }
      var ts = _now();
      await query(
        "DELETE FROM business_hour_exceptions WHERE schedule_slug = ?1 AND date = ?2",
        [slug, date],
      );
      await query(
        "UPDATE business_hour_schedules SET updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return await this.getSchedule(slug);
    },

    // Snapshot of the weekly rhythm, day-by-day. Returns an array of
    // length 7 (Sun=0..Sat=6); each entry carries the list of windows
    // for that weekday in `HH:MM-HH:MM` form, or `[]` for closed.
    // Holidays + exceptions are NOT applied here — `weekSummary` is
    // the "what's the operator's nominal weekly schedule" view; the
    // banner UI fetches it once and renders "Open Mon-Fri 09:00-17:00,
    // closed Sat/Sun." Use `isOpenAt` / `nextOpenAt` for the
    // exception-aware live state.
    weekSummary: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.weekSummary: input object required");
      }
      var slug = _slug(input.slug);
      var schedule = await this.getSchedule(slug);
      if (!schedule) return null;
      var byDay = [[], [], [], [], [], [], []];
      for (var i = 0; i < schedule.weekly_hours.length; i += 1) {
        var w = schedule.weekly_hours[i];
        byDay[w.day].push({ open: w.open, close: w.close });
      }
      for (var d = 0; d < 7; d += 1) {
        byDay[d].sort(function (a, b) { return _hhmmToMinutes(a.open) - _hhmmToMinutes(b.open); });
      }
      return {
        slug:     schedule.slug,
        timezone: schedule.timezone,
        days:     byDay,
      };
    },

    // Is the schedule currently open at `when` (epoch-ms; defaults to
    // `Date.now()` — the monotonic clock pattern lets tests pin a
    // moment without stubbing the global clock).
    isOpenAt: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.isOpenAt: input object required");
      }
      var slug = _slug(input.slug);
      var when = input.when == null ? _now() : _epochMs(input.when, "when");

      var schedule = await this.getSchedule(slug);
      if (!schedule || schedule.archived_at != null) return false;

      var wall = _wallClockIn(schedule.timezone, when);
      var ymd  = _ymdString(wall);
      var overrides = {};
      var i;
      for (i = 0; i < (schedule.holidays || []).length; i += 1) {
        overrides[schedule.holidays[i].date] = {
          kind: "holiday", name: schedule.holidays[i].name,
        };
      }
      for (i = 0; i < (schedule.exceptions || []).length; i += 1) {
        var ex = schedule.exceptions[i];
        overrides[ex.date] = {
          kind: "exception", open: ex.open, close: ex.close, closed: ex.closed,
        };
      }
      var windows = _windowsForDate(schedule, ymd, overrides);
      var nowMinutes = wall.hh * 60 + wall.mm;
      for (i = 0; i < windows.length; i += 1) {
        var openM  = _hhmmToMinutes(windows[i].open);
        var closeM = _hhmmToMinutes(windows[i].close);
        if (nowMinutes >= openM && nowMinutes < closeM) return true;
      }
      return false;
    },

    // Next open-moment at or after `when`. Returns `{ at, date,
    // open }` where `at` is the epoch-ms of the opening transition,
    // `date` is the YYYY-MM-DD in the schedule's timezone, and `open`
    // is the HH:MM. Returns `null` when no opening is found within
    // SEARCH_DAYS (operator authored a fully-closed schedule, or the
    // far horizon is closed by accumulated overrides — the lookup
    // exits gracefully rather than walking forever).
    //
    // If `when` itself falls inside an open window, returns `when`'s
    // own opening for that window (so the caller can treat "open now"
    // as "the open transition was at <today 09:00>").
    nextOpenAt: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.nextOpenAt: input object required");
      }
      var slug = _slug(input.slug);
      var when = input.when == null ? _now() : _epochMs(input.when, "when");

      var schedule = await this.getSchedule(slug);
      if (!schedule || schedule.archived_at != null) return null;

      var overrides = {};
      var i;
      for (i = 0; i < (schedule.holidays || []).length; i += 1) {
        overrides[schedule.holidays[i].date] = {
          kind: "holiday", name: schedule.holidays[i].name,
        };
      }
      for (i = 0; i < (schedule.exceptions || []).length; i += 1) {
        var ex = schedule.exceptions[i];
        overrides[ex.date] = {
          kind: "exception", open: ex.open, close: ex.close, closed: ex.closed,
        };
      }

      var wall = _wallClockIn(schedule.timezone, when);
      var cur = { y: wall.y, m: wall.m, d: wall.d };
      var nowMinutes = wall.hh * 60 + wall.mm;
      for (var day = 0; day < SEARCH_DAYS; day += 1) {
        var ymd = _ymdString(cur);
        var windows = _windowsForDate(schedule, ymd, overrides);
        // Sort windows by open ASC so split-shift schedules return the
        // earliest still-future opening of the day.
        windows.sort(function (a, b) { return _hhmmToMinutes(a.open) - _hhmmToMinutes(b.open); });
        for (i = 0; i < windows.length; i += 1) {
          var openM  = _hhmmToMinutes(windows[i].open);
          var closeM = _hhmmToMinutes(windows[i].close);
          if (day === 0) {
            // Already open inside this window — return this window's
            // open transition (callers building "we're open until X"
            // banners pair this with `nextCloseAt`).
            if (nowMinutes >= openM && nowMinutes < closeM) {
              return {
                at:   _wallClockToEpochMs(schedule.timezone, ymd, windows[i].open),
                date: ymd,
                open: windows[i].open,
              };
            }
            // Open later today — return this future opening.
            if (openM > nowMinutes) {
              return {
                at:   _wallClockToEpochMs(schedule.timezone, ymd, windows[i].open),
                date: ymd,
                open: windows[i].open,
              };
            }
          } else {
            return {
              at:   _wallClockToEpochMs(schedule.timezone, ymd, windows[i].open),
              date: ymd,
              open: windows[i].open,
            };
          }
        }
        cur = _addCalendarDays(cur, 1);
      }
      return null;
    },

    // Next close-moment AT or after `when`. Returns `{ at, date,
    // close }` for the close transition of the currently-open window
    // OR (when closed) the close of the next opening. Returns `null`
    // when no opening is found within SEARCH_DAYS.
    nextCloseAt: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("businessHours.nextCloseAt: input object required");
      }
      var slug = _slug(input.slug);
      var when = input.when == null ? _now() : _epochMs(input.when, "when");

      var schedule = await this.getSchedule(slug);
      if (!schedule || schedule.archived_at != null) return null;

      var overrides = {};
      var i;
      for (i = 0; i < (schedule.holidays || []).length; i += 1) {
        overrides[schedule.holidays[i].date] = {
          kind: "holiday", name: schedule.holidays[i].name,
        };
      }
      for (i = 0; i < (schedule.exceptions || []).length; i += 1) {
        var ex = schedule.exceptions[i];
        overrides[ex.date] = {
          kind: "exception", open: ex.open, close: ex.close, closed: ex.closed,
        };
      }

      var wall = _wallClockIn(schedule.timezone, when);
      var cur = { y: wall.y, m: wall.m, d: wall.d };
      var nowMinutes = wall.hh * 60 + wall.mm;
      for (var day = 0; day < SEARCH_DAYS; day += 1) {
        var ymd = _ymdString(cur);
        var windows = _windowsForDate(schedule, ymd, overrides);
        windows.sort(function (a, b) { return _hhmmToMinutes(a.open) - _hhmmToMinutes(b.open); });
        for (i = 0; i < windows.length; i += 1) {
          var openM  = _hhmmToMinutes(windows[i].open);
          var closeM = _hhmmToMinutes(windows[i].close);
          if (day === 0) {
            // Inside this window — return its close.
            if (nowMinutes >= openM && nowMinutes < closeM) {
              return {
                at:    _wallClockToEpochMs(schedule.timezone, ymd, windows[i].close),
                date:  ymd,
                close: windows[i].close,
              };
            }
            // Before this window — return its close (when caller is
            // about to be open, the next close is THIS window's close).
            if (openM > nowMinutes) {
              return {
                at:    _wallClockToEpochMs(schedule.timezone, ymd, windows[i].close),
                date:  ymd,
                close: windows[i].close,
              };
            }
          } else {
            return {
              at:    _wallClockToEpochMs(schedule.timezone, ymd, windows[i].close),
              date:  ymd,
              close: windows[i].close,
            };
          }
        }
        cur = _addCalendarDays(cur, 1);
      }
      return null;
    },
  };
}

module.exports = {
  create:            create,
  SLUG_RE:           SLUG_RE,
  TZ_RE:             TZ_RE,
  HHMM_RE:           HHMM_RE,
  YMD_RE:            YMD_RE,
  MAX_WEEKLY_HOURS:  MAX_WEEKLY_HOURS,
};
