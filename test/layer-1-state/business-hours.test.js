"use strict";
/**
 * businessHours — operator-defined open/close windows per location
 * or tenant.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0127_business_hours.sql`.
 *
 * Coverage:
 *   - defineSchedule shape + duplicate-slug refusal
 *   - isOpenAt across weekly_hours (boundary minute, closed day)
 *   - isOpenAt honors holiday + exception overrides
 *   - nextOpenAt skips holidays + closures (and rolls weekend->Monday)
 *   - nextCloseAt returns the current window's close when inside it
 *   - weekSummary returns the nominal weekly rhythm
 *   - addException / addHoliday / removeException / archiveSchedule
 *   - DST-aware: a Europe/London schedule's 09:00 open transition
 *     produces consistent wall-clock results either side of the
 *     spring-forward + fall-back transitions
 *   - factory + input validation refusals
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var businessHours = require("../../lib/business-hours");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0127_business_hours.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Build an epoch-ms from (YYYY-MM-DD, HH:MM, IANA tz). Mirrors the
// internal _wallClockToEpochMs algorithm so the test can pin "Wednesday
// 10:00 in New York" without re-implementing tz math.
function _wallMs(tz, ymd, hhmm) {
  var y  = Number(ymd.slice(0, 4));
  var mo = Number(ymd.slice(5, 7));
  var d  = Number(ymd.slice(8, 10));
  var hh = Number(hhmm.slice(0, 2));
  var mm = Number(hhmm.slice(3, 5));
  var guess = Date.UTC(y, mo - 1, d, hh, mm);
  for (var pass = 0; pass < 2; pass += 1) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    var parts = fmt.formatToParts(new Date(guess));
    var py = 0, pmo = 0, pd = 0, ph = 0, pm = 0;
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].type === "year")   py  = Number(parts[i].value);
      if (parts[i].type === "month")  pmo = Number(parts[i].value);
      if (parts[i].type === "day")    pd  = Number(parts[i].value);
      if (parts[i].type === "hour") {
        var h = Number(parts[i].value);
        ph = h === 24 ? 0 : h;
      }
      if (parts[i].type === "minute") pm  = Number(parts[i].value);
    }
    var have = Date.UTC(py, pmo - 1, pd, ph, pm);
    var want = Date.UTC(y, mo - 1, d, hh, mm);
    var delta = want - have;
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}

// ---- defineSchedule + isOpenAt across weekly hours ---------------------

async function _defineAndIsOpen() {
  var q  = _makeQuery();
  var bh = businessHours.create({ query: q });

  // Mon-Fri 09:00-17:00 in New York. Sat/Sun closed by absence.
  var sched = await bh.defineSchedule({
    slug:         "nyc-store",
    timezone:     "America/New_York",
    weekly_hours: [
      { day: 1, open: "09:00", close: "17:00" },
      { day: 2, open: "09:00", close: "17:00" },
      { day: 3, open: "09:00", close: "17:00" },
      { day: 4, open: "09:00", close: "17:00" },
      { day: 5, open: "09:00", close: "17:00" },
    ],
  });
  check("defineSchedule slug",                sched.slug === "nyc-store");
  check("defineSchedule timezone",            sched.timezone === "America/New_York");
  check("defineSchedule weekly len",          sched.weekly_hours.length === 5);
  check("defineSchedule archived_at null",    sched.archived_at === null);
  check("defineSchedule holidays empty",      sched.holidays.length === 0);
  check("defineSchedule exceptions empty",    sched.exceptions.length === 0);

  // Wednesday 2024-03-13 10:00 New York — inside the 09:00-17:00 window.
  var insideWed = _wallMs("America/New_York", "2024-03-13", "10:00");
  check("Wed 10:00 NY -> open",
        (await bh.isOpenAt({ slug: "nyc-store", when: insideWed })) === true);

  // Wednesday 2024-03-13 17:00 — close boundary (exclusive).
  var atCloseWed = _wallMs("America/New_York", "2024-03-13", "17:00");
  check("Wed 17:00 NY -> closed (exclusive)",
        (await bh.isOpenAt({ slug: "nyc-store", when: atCloseWed })) === false);

  // Wednesday 2024-03-13 09:00 — open boundary (inclusive).
  var atOpenWed = _wallMs("America/New_York", "2024-03-13", "09:00");
  check("Wed 09:00 NY -> open (inclusive)",
        (await bh.isOpenAt({ slug: "nyc-store", when: atOpenWed })) === true);

  // Wednesday 2024-03-13 08:59 — before open.
  var beforeOpen = _wallMs("America/New_York", "2024-03-13", "08:59");
  check("Wed 08:59 NY -> closed",
        (await bh.isOpenAt({ slug: "nyc-store", when: beforeOpen })) === false);

  // Sunday 2024-03-17 10:00 — closed (no weekly entry for day 0).
  var sun = _wallMs("America/New_York", "2024-03-17", "10:00");
  check("Sun 10:00 NY -> closed",
        (await bh.isOpenAt({ slug: "nyc-store", when: sun })) === false);

  // Duplicate-slug refusal.
  await assert.rejects(bh.defineSchedule({
    slug: "nyc-store", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "10:00", close: "18:00" }],
  }), /already exists/);
}

// ---- holiday + exception override regular hours -----------------------

async function _holidayAndException() {
  var q  = _makeQuery();
  var bh = businessHours.create({ query: q });

  await bh.defineSchedule({
    slug:         "store",
    timezone:     "America/New_York",
    weekly_hours: [
      { day: 1, open: "09:00", close: "17:00" },
      { day: 2, open: "09:00", close: "17:00" },
      { day: 3, open: "09:00", close: "17:00" },
      { day: 4, open: "09:00", close: "17:00" },
      { day: 5, open: "09:00", close: "17:00" },
    ],
    holidays: [
      { date: "2024-12-25", name: "Christmas Day" },
    ],
    exceptions: [
      // Early close on Wed 2024-12-24 -> 13:00 instead of 17:00.
      { date: "2024-12-24", close: "13:00" },
    ],
  });

  // 2024-12-25 was a Wednesday — normally open. Holiday suppresses it.
  var xmas10 = _wallMs("America/New_York", "2024-12-25", "10:00");
  check("Christmas 10:00 -> closed (holiday)",
        (await bh.isOpenAt({ slug: "store", when: xmas10 })) === false);

  // 2024-12-24 (Tue) early-close at 13:00 — 12:30 still open, 13:30 closed.
  var eveOpen   = _wallMs("America/New_York", "2024-12-24", "12:30");
  var eveClosed = _wallMs("America/New_York", "2024-12-24", "13:30");
  check("Christmas Eve 12:30 -> open",
        (await bh.isOpenAt({ slug: "store", when: eveOpen  })) === true);
  check("Christmas Eve 13:30 -> closed (exception)",
        (await bh.isOpenAt({ slug: "store", when: eveClosed })) === false);

  // Other Wednesdays still open at 14:00 (the exception is single-date).
  var normalWedAfter = _wallMs("America/New_York", "2024-12-18", "14:00");
  check("Normal Wed 14:00 -> open",
        (await bh.isOpenAt({ slug: "store", when: normalWedAfter })) === true);

  // Round-trip: getSchedule returns holidays + exceptions.
  var loaded = await bh.getSchedule("store");
  check("getSchedule holidays len",        loaded.holidays.length === 1);
  check("getSchedule holiday name",        loaded.holidays[0].name === "Christmas Day");
  check("getSchedule exceptions len",      loaded.exceptions.length === 1);
  check("getSchedule exception date",      loaded.exceptions[0].date === "2024-12-24");
  check("getSchedule exception close",     loaded.exceptions[0].close === "13:00");
  check("getSchedule exception open null", loaded.exceptions[0].open === null);
  check("getSchedule exception not closed", loaded.exceptions[0].closed === false);
}

// ---- nextOpenAt skips holidays + weekend, rolls to next business day ---

async function _nextOpenAtSkipsClosures() {
  var q  = _makeQuery();
  var bh = businessHours.create({ query: q });

  await bh.defineSchedule({
    slug:         "store",
    timezone:     "America/New_York",
    weekly_hours: [
      { day: 1, open: "09:00", close: "17:00" },
      { day: 2, open: "09:00", close: "17:00" },
      { day: 3, open: "09:00", close: "17:00" },
      { day: 4, open: "09:00", close: "17:00" },
      { day: 5, open: "09:00", close: "17:00" },
    ],
    holidays: [
      { date: "2024-07-04", name: "Independence Day" }, // Thursday
    ],
  });

  // Asked late Friday after close -> next open is Monday 09:00.
  // 2024-06-28 was a Friday.
  var friAfterClose = _wallMs("America/New_York", "2024-06-28", "18:00");
  var nextMon = await bh.nextOpenAt({ slug: "store", when: friAfterClose });
  check("nextOpenAt Fri evening -> Mon date",       nextMon.date === "2024-07-01");
  check("nextOpenAt Fri evening -> Mon open",       nextMon.open === "09:00");
  // The returned `at` is epoch-ms; re-formatting it in NY must produce
  // 2024-07-01 09:00 — DST-correct boundary, no manual offset math.
  var expectedMonMs = _wallMs("America/New_York", "2024-07-01", "09:00");
  check("nextOpenAt Mon at == expected ms",         nextMon.at === expectedMonMs);

  // Asked Wed 2024-07-03 evening, the next business day is Thursday
  // 2024-07-04 which is a holiday — must skip to Friday 2024-07-05.
  var wedEve = _wallMs("America/New_York", "2024-07-03", "18:00");
  var skipHol = await bh.nextOpenAt({ slug: "store", when: wedEve });
  check("nextOpenAt skips holiday -> Fri date",     skipHol.date === "2024-07-05");
  check("nextOpenAt skips holiday -> Fri open",     skipHol.open === "09:00");

  // Asked Wed 2024-07-03 10:00 (already open) -> returns THIS window's
  // 09:00 open.
  var insideWindow = _wallMs("America/New_York", "2024-07-03", "10:00");
  var sameDayOpen = await bh.nextOpenAt({ slug: "store", when: insideWindow });
  check("nextOpenAt inside window returns today",   sameDayOpen.date === "2024-07-03");
  check("nextOpenAt inside window open 09:00",      sameDayOpen.open === "09:00");

  // nextCloseAt inside the open window returns today's 17:00.
  var nc = await bh.nextCloseAt({ slug: "store", when: insideWindow });
  check("nextCloseAt inside window today",          nc.date === "2024-07-03");
  check("nextCloseAt inside window close 17:00",    nc.close === "17:00");

  // nextCloseAt called before open -> today's 17:00 (the close of the
  // soon-to-be-open window).
  var preOpen = _wallMs("America/New_York", "2024-07-03", "07:00");
  var ncPre = await bh.nextCloseAt({ slug: "store", when: preOpen });
  check("nextCloseAt pre-open today close",         ncPre.date === "2024-07-03");
  check("nextCloseAt pre-open close 17:00",         ncPre.close === "17:00");
}

// ---- DST-aware: crossing spring-forward + fall-back -------------------

async function _dstAware() {
  var q  = _makeQuery();
  var bh = businessHours.create({ query: q });

  // London office 09:00-17:00 Mon-Fri. 2024 UK DST transitions:
  //   Spring forward: 2024-03-31 (Sun) at 01:00 -> 02:00
  //   Fall back:      2024-10-27 (Sun) at 02:00 -> 01:00
  await bh.defineSchedule({
    slug:         "london",
    timezone:     "Europe/London",
    weekly_hours: [
      { day: 1, open: "09:00", close: "17:00" },
      { day: 2, open: "09:00", close: "17:00" },
      { day: 3, open: "09:00", close: "17:00" },
      { day: 4, open: "09:00", close: "17:00" },
      { day: 5, open: "09:00", close: "17:00" },
    ],
  });

  // 1) Friday 2024-03-29 (BEFORE DST, still GMT) — open 10:00.
  var preDstWed = _wallMs("Europe/London", "2024-03-29", "10:00");
  check("London Fri 10:00 pre-DST -> open",
        (await bh.isOpenAt({ slug: "london", when: preDstWed })) === true);

  // 2) Monday 2024-04-01 (AFTER spring-forward, now BST) — open 10:00.
  //    The wall-clock semantics must survive the transition.
  var postDstMon = _wallMs("Europe/London", "2024-04-01", "10:00");
  check("London Mon 10:00 post-spring -> open",
        (await bh.isOpenAt({ slug: "london", when: postDstMon })) === true);

  // 3) nextOpenAt across the spring-forward transition. Asked late
  //    Friday 2024-03-29 (GMT) evening -> next open is Monday
  //    2024-04-01 09:00 (BST). The epoch-ms returned must format as
  //    09:00 London on that date, NOT 08:00 (which would be the bug
  //    a naive +offset-arithmetic implementation produces).
  var friEve = _wallMs("Europe/London", "2024-03-29", "18:00");
  var nMon = await bh.nextOpenAt({ slug: "london", when: friEve });
  check("DST spring: nextOpenAt date",           nMon.date === "2024-04-01");
  check("DST spring: nextOpenAt open 09:00",     nMon.open === "09:00");
  var expectedSpringMs = _wallMs("Europe/London", "2024-04-01", "09:00");
  check("DST spring: nextOpenAt at == BST 09:00", nMon.at === expectedSpringMs);

  // 4) nextOpenAt across the fall-back transition. Asked Friday
  //    2024-10-25 evening (BST) -> next open is Monday 2024-10-28
  //    09:00 (now GMT, the day AFTER fall-back).
  var friEveFall = _wallMs("Europe/London", "2024-10-25", "18:00");
  var nFallMon = await bh.nextOpenAt({ slug: "london", when: friEveFall });
  check("DST fall: nextOpenAt date",             nFallMon.date === "2024-10-28");
  check("DST fall: nextOpenAt open 09:00",       nFallMon.open === "09:00");
  var expectedFallMs = _wallMs("Europe/London", "2024-10-28", "09:00");
  check("DST fall: nextOpenAt at == GMT 09:00",  nFallMon.at === expectedFallMs);

  // 5) The two same-named (09:00) openings on opposite sides of the
  //    spring transition must NOT have the same epoch difference per
  //    naive +24h math — DST-correct arithmetic produces 24h-1h = 23h
  //    elapsed between Sun midnight and Mon midnight across spring-
  //    forward. Sanity-check the underlying _wallMs helper (and by
  //    extension the primitive that uses the same algorithm).
  var sunSpring = _wallMs("Europe/London", "2024-03-31", "00:00");
  var monSpring = _wallMs("Europe/London", "2024-04-01", "00:00");
  check("DST spring: Sun->Mon == 23h (spring-forward)",
        (monSpring - sunSpring) === 23 * 60 * 60 * 1000);
}

// ---- weekSummary + addException / addHoliday / removeException --------

async function _weekSummaryAndMutations() {
  var q  = _makeQuery();
  var bh = businessHours.create({ query: q });

  await bh.defineSchedule({
    slug:         "cafe",
    timezone:     "America/Los_Angeles",
    weekly_hours: [
      // Split shift Monday: 07:00-11:00 + 17:00-21:00 (breakfast +
      // dinner), single window other days.
      { day: 1, open: "07:00", close: "11:00" },
      { day: 1, open: "17:00", close: "21:00" },
      { day: 2, open: "07:00", close: "21:00" },
      { day: 3, open: "07:00", close: "21:00" },
    ],
  });

  var summary = await bh.weekSummary({ slug: "cafe" });
  check("weekSummary slug",                 summary.slug === "cafe");
  check("weekSummary tz",                   summary.timezone === "America/Los_Angeles");
  check("weekSummary day 0 closed",         summary.days[0].length === 0);
  check("weekSummary day 1 split-shift",    summary.days[1].length === 2);
  check("weekSummary day 1 first open",     summary.days[1][0].open === "07:00");
  check("weekSummary day 1 first close",    summary.days[1][0].close === "11:00");
  check("weekSummary day 1 second open",    summary.days[1][1].open === "17:00");
  check("weekSummary day 2 single",         summary.days[2].length === 1);
  check("weekSummary day 6 closed",         summary.days[6].length === 0);

  // Split-shift isOpenAt: Monday LA 12:00 should be CLOSED (between
  // shifts), 09:00 OPEN (morning), 18:00 OPEN (evening).
  var lunchClosed = _wallMs("America/Los_Angeles", "2024-04-01", "12:00"); // Mon
  var brkfst      = _wallMs("America/Los_Angeles", "2024-04-01", "09:00");
  var dinner      = _wallMs("America/Los_Angeles", "2024-04-01", "18:00");
  check("split shift lunch -> closed",      (await bh.isOpenAt({ slug: "cafe", when: lunchClosed })) === false);
  check("split shift breakfast -> open",    (await bh.isOpenAt({ slug: "cafe", when: brkfst      })) === true);
  check("split shift dinner -> open",       (await bh.isOpenAt({ slug: "cafe", when: dinner      })) === true);

  // addException: close Tue 2024-04-02 entirely for a private event.
  await bh.addException({ slug: "cafe", date: "2024-04-02", closed: true });
  var tueClosed = _wallMs("America/Los_Angeles", "2024-04-02", "12:00");
  check("addException closed:true -> closed",
        (await bh.isOpenAt({ slug: "cafe", when: tueClosed })) === false);

  // addHoliday: 2024-04-03 (Wed) becomes a holiday.
  await bh.addHoliday({ slug: "cafe", date: "2024-04-03", name: "Spring Break" });
  var wedHol = _wallMs("America/Los_Angeles", "2024-04-03", "10:00");
  check("addHoliday -> closed",
        (await bh.isOpenAt({ slug: "cafe", when: wedHol })) === false);
  var afterAdd = await bh.getSchedule("cafe");
  check("getSchedule sees added holiday",   afterAdd.holidays.length === 1);
  check("getSchedule holiday name",         afterAdd.holidays[0].name === "Spring Break");
  check("getSchedule sees added exception", afterAdd.exceptions.length === 1);
  check("getSchedule exception closed",     afterAdd.exceptions[0].closed === true);

  // addHoliday is idempotent / replace — second call replaces the name.
  await bh.addHoliday({ slug: "cafe", date: "2024-04-03", name: "Spring Break (renamed)" });
  var afterRename = await bh.getSchedule("cafe");
  check("addHoliday replace renames",       afterRename.holidays[0].name === "Spring Break (renamed)");

  // addException replaces holiday on the same date (and vice versa).
  await bh.addException({ slug: "cafe", date: "2024-04-03", close: "12:00" });
  var afterReplace = await bh.getSchedule("cafe");
  check("addException replaces holiday: holidays empty",   afterReplace.holidays.length === 0);
  check("addException replaces holiday: exceptions has",   afterReplace.exceptions.length === 2);

  // removeException removes ANY override on a date.
  await bh.removeException({ slug: "cafe", date: "2024-04-03" });
  var afterRemove = await bh.getSchedule("cafe");
  // 2024-04-03 override is gone (only the Tue closed exception remains).
  var exceptionDates = afterRemove.exceptions.map(function (e) { return e.date; });
  check("removeException drops the override",
        exceptionDates.indexOf("2024-04-03") === -1);
  check("removeException keeps others",                    exceptionDates.indexOf("2024-04-02") !== -1);

  // listSchedules
  var listed = await bh.listSchedules();
  check("listSchedules returns 1",                         listed.length === 1);
  check("listSchedules slug",                              listed[0].slug === "cafe");

  // archiveSchedule
  var archived = await bh.archiveSchedule("cafe");
  check("archiveSchedule stamps archived_at",              archived.archived_at != null);

  // Archived schedule reads as closed via isOpenAt regardless of when.
  var laterCheck = _wallMs("America/Los_Angeles", "2024-04-01", "09:00");
  check("archived schedule -> isOpenAt false",
        (await bh.isOpenAt({ slug: "cafe", when: laterCheck })) === false);
  check("archived schedule -> nextOpenAt null",
        (await bh.nextOpenAt({ slug: "cafe", when: laterCheck })) === null);
  check("archived schedule -> nextCloseAt null",
        (await bh.nextCloseAt({ slug: "cafe", when: laterCheck })) === null);

  // listSchedules default excludes archived.
  var defaultList = await bh.listSchedules();
  check("listSchedules default excludes archived",          defaultList.length === 0);
  var archivedList = await bh.listSchedules({ include_archived: true });
  check("listSchedules include_archived sees it",           archivedList.length === 1);

  // archiveSchedule is idempotent.
  var archAgain = await bh.archiveSchedule("cafe");
  check("archiveSchedule idempotent archived_at",          archAgain.archived_at === archived.archived_at);

  // archived schedule refuses mutations.
  await assert.rejects(bh.addHoliday({ slug: "cafe", date: "2024-12-25", name: "X" }),
                       /archived/);
  await assert.rejects(bh.addException({ slug: "cafe", date: "2024-12-25", closed: true }),
                       /archived/);
  await assert.rejects(bh.removeException({ slug: "cafe", date: "2024-12-25" }),
                       /archived/);

  // Missing schedule returns null (not a throw).
  check("addHoliday missing -> null",
        (await bh.addHoliday({ slug: "nope", date: "2024-12-25", name: "X" })) === null);
  check("addException missing -> null",
        (await bh.addException({ slug: "nope", date: "2024-12-25", closed: true })) === null);
  check("removeException missing -> null",
        (await bh.removeException({ slug: "nope", date: "2024-12-25" })) === null);
  check("archiveSchedule missing -> null",
        (await bh.archiveSchedule("nope")) === null);
  check("getSchedule missing -> null",
        (await bh.getSchedule("nope")) === null);
  check("weekSummary missing -> null",
        (await bh.weekSummary({ slug: "nope" })) === null);
}

// ---- factory + input validation refusals ------------------------------

async function _factoryAndInputRefusals() {
  var q  = _makeQuery();
  var bh = businessHours.create({ query: q });
  check("factory returns surface",          typeof bh.defineSchedule === "function");
  check("factory exposes SLUG_RE",          bh.SLUG_RE instanceof RegExp);
  check("factory exposes TZ_RE",            bh.TZ_RE instanceof RegExp);
  check("factory exposes HHMM_RE",          bh.HHMM_RE instanceof RegExp);
  check("factory exposes YMD_RE",           bh.YMD_RE instanceof RegExp);
  check("factory exposes MAX_WEEKLY_HOURS", bh.MAX_WEEKLY_HOURS === businessHours.MAX_WEEKLY_HOURS);

  // Factory zero-args still constructs (lazy framework lookup at call
  // time, not at construction time).
  var bh0 = businessHours.create();
  check("factory zero-args constructs",     typeof bh0.defineSchedule === "function");

  // defineSchedule refusals.
  await assert.rejects(bh.defineSchedule(), /input object required/);
  await assert.rejects(bh.defineSchedule({
    slug: "BAD SLUG", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "09:00", close: "17:00" }],
  }), /slug/);
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "Not/A_Zone",
    weekly_hours: [{ day: 1, open: "09:00", close: "17:00" }],
  }), /timezone/);
  // Bad timezone shape (missing area/city).
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "UTC",
    weekly_hours: [{ day: 1, open: "09:00", close: "17:00" }],
  }), /timezone/);
  // Bad day.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 7, open: "09:00", close: "17:00" }],
  }), /day/);
  // Bad HH:MM.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "9:00", close: "17:00" }],
  }), /open/);
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "09:00", close: "25:00" }],
  }), /close/);
  // close <= open.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "17:00", close: "17:00" }],
  }), /close must be strictly after open/);
  // Overlapping windows same day.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [
      { day: 1, open: "09:00", close: "12:00" },
      { day: 1, open: "11:00", close: "13:00" },
    ],
  }), /overlapping/);
  // Bad holiday date.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "09:00", close: "17:00" }],
    holidays: [{ date: "2024-13-01", name: "X" }],
  }), /date/);
  // Duplicate holiday date.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "09:00", close: "17:00" }],
    holidays: [
      { date: "2024-12-25", name: "Christmas" },
      { date: "2024-12-25", name: "Christmas (dup)" },
    ],
  }), /duplicate/);
  // Exception with neither closed nor open/close.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "09:00", close: "17:00" }],
    exceptions: [{ date: "2024-12-26" }],
  }), /must set closed=true OR/);
  // Exception close <= open.
  await assert.rejects(bh.defineSchedule({
    slug: "ok", timezone: "America/New_York",
    weekly_hours: [{ day: 1, open: "09:00", close: "17:00" }],
    exceptions: [{ date: "2024-12-26", open: "15:00", close: "12:00" }],
  }), /close must be strictly after open/);

  // isOpenAt / nextOpenAt / nextCloseAt input refusals.
  await assert.rejects(bh.isOpenAt(),                                   /input object required/);
  await assert.rejects(bh.isOpenAt({ slug: "BAD" }),                    /slug/);
  await assert.rejects(bh.isOpenAt({ slug: "ok", when: 1.5 }),          /when/);
  await assert.rejects(bh.nextOpenAt(),                                 /input object required/);
  await assert.rejects(bh.nextCloseAt(),                                /input object required/);

  // addException / addHoliday refusals.
  await assert.rejects(bh.addException(),                               /input object required/);
  await assert.rejects(bh.addException({ slug: "ok" }),                 /date/);
  await assert.rejects(bh.addException({ slug: "ok", date: "2024-01-01" }),
                       /must set closed=true OR/);
  await assert.rejects(bh.addHoliday(),                                 /input object required/);
  await assert.rejects(bh.addHoliday({ slug: "ok", date: "bad" }),      /date/);
  await assert.rejects(bh.addHoliday({ slug: "ok", date: "2024-01-01" }),
                       /name/);

  // removeException / archiveSchedule refusals.
  await assert.rejects(bh.removeException(),                            /input object required/);
  await assert.rejects(bh.removeException({ slug: "ok" }),              /date/);
  await assert.rejects(bh.archiveSchedule("BAD"),                       /slug/);

  // getSchedule slug validation.
  await assert.rejects(bh.getSchedule("BAD"),                           /slug/);
  await assert.rejects(bh.getSchedule(""),                              /slug/);

  // weekSummary refusals.
  await assert.rejects(bh.weekSummary(),                                /input object required/);
}

async function run() {
  await _defineAndIsOpen();
  await _holidayAndException();
  await _nextOpenAtSkipsClosures();
  await _dstAware();
  await _weekSummaryAndMutations();
  await _factoryAndInputRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - business-hours (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - business-hours: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
