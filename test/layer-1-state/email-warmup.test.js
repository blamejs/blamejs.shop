"use strict";
/**
 * emailWarmup — gradual SMTP IP / domain warmup schedules.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0116_email_warmup.sql alone — the primitive has no FKs into the
 * rest of the schema, so the test runs against a minimal in-memory
 * database with just the two warmup tables.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/email-warmup.js` directly so the gate exists ahead of the
 * entry-point edit (same posture as experiments.test.js + email-
 * campaigns.test.js).
 *
 * Coverage:
 *   - defineSchedule happy path persists every field; rejects duplicate
 *   - defineSchedule refusals: bad slug / domain / ip / start_date /
 *     daily_targets shapes / threshold
 *   - currentDay math: pre-ramp returns 0, in-ramp returns 1..length,
 *     post-ramp returns length+1
 *   - canSend within daily cap returns ok=true; over cap returns
 *     ok=false with reason='over_cap'
 *   - canSend respects paused / archived / unknown / pre_ramp /
 *     post_ramp states
 *   - recordSends accumulates same-day, creates row first time
 *   - recordSends refuses against paused / archived schedule
 *   - recordEngagement bumps bounce + complaint counts
 *   - pause/resume/archive FSM happy path + invalid-edge refusals
 *   - listSchedules({ active_only })
 *   - metricsForSchedule rolls up per-day sends + rates + threshold
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var emailWarmup = require("../../lib/email-warmup");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0116_email_warmup.sql");

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

// Fixed clock helper — the warmup primitive's date math is sensitive
// to UTC midnight boundaries, so the gate runs against a frozen clock
// derived from a known ISO date. `setDay(n)` advances the clock to
// (start_date + n days) at noon UTC so canSend / recordSends land
// firmly inside the schedule-day-N window.
function _clock(startIso) {
  var startMs = Date.UTC(
    parseInt(startIso.slice(0, 4), 10),
    parseInt(startIso.slice(5, 7), 10) - 1,
    parseInt(startIso.slice(8, 10), 10),
  );
  var nowMs = startMs + 12 * 60 * 60 * 1000;     // noon UTC on day 1
  return {
    now: function () { return nowMs; },
    setDay: function (n) { nowMs = startMs + (n - 1) * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000; },
    setMs:  function (ms) { nowMs = ms; },
    startMs: startMs,
  };
}

function _setup(startIso) {
  var clock = _clock(startIso || "2026-05-22");
  var query = _makeQuery();
  var wu    = emailWarmup.create({ query: query, now: clock.now });
  return { query: query, clock: clock, wu: wu };
}

function _validInput(over) {
  over = over || {};
  var base = {
    slug:                   "release-ip-2026",
    sender_domain:          "release.shop.example",
    sender_ip:              "192.0.2.42",
    start_date:             "2026-05-22",
    daily_targets:          [50, 100, 250, 500, 1000, 2000, 4000],
    status_check_threshold: 200,
  };
  var k;
  for (k in over) {
    if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
  }
  return base;
}

// ---- defineSchedule happy + refusals ----------------------------------

async function _defineHappyPath() {
  var ctx = _setup();
  var rv  = await ctx.wu.defineSchedule(_validInput());
  check("define returns slug",                   rv.slug === "release-ip-2026");
  check("define returns sender_domain lower",    rv.sender_domain === "release.shop.example");
  check("define returns sender_ip",              rv.sender_ip === "192.0.2.42");
  check("define returns start_date",             rv.start_date === "2026-05-22");
  check("define returns daily_targets array",    Array.isArray(rv.daily_targets) && rv.daily_targets.length === 7);
  check("define daily_targets[0] === 50",        rv.daily_targets[0] === 50);
  check("define threshold = 200",                rv.status_check_threshold === 200);
  check("define status 'active'",                rv.status === "active");
  check("define paused_at null",                  rv.paused_at === null);
  check("define paused_reason null",              rv.paused_reason === null);
  check("define archived_at null",                rv.archived_at === null);
  check("define created_at populated",            Number.isInteger(rv.created_at) && rv.created_at > 0);
  check("define updated_at == created_at",        rv.updated_at === rv.created_at);

  // getSchedule reflects.
  var got = await ctx.wu.getSchedule("release-ip-2026");
  check("getSchedule returns row",               got && got.slug === "release-ip-2026");
  check("getSchedule miss returns null",         (await ctx.wu.getSchedule("never-defined")) === null);

  // Domain is lowercased on the way in.
  var ctx2 = _setup();
  var domainCased = await ctx2.wu.defineSchedule(_validInput({
    slug:          "case-test",
    sender_domain: "RELEASE.Shop.EXAMPLE",
  }));
  check("define lowercases domain",              domainCased.sender_domain === "release.shop.example");

  // Optional sender_ip — null is allowed (pooled IP range).
  var ctx3 = _setup();
  var ipless = await ctx3.wu.defineSchedule(_validInput({
    slug:      "no-ip",
    sender_ip: null,
  }));
  check("define accepts null sender_ip",         ipless.sender_ip === null);

  // IPv6 textual.
  var ctx4 = _setup();
  var ipv6 = await ctx4.wu.defineSchedule(_validInput({
    slug:      "ipv6-test",
    sender_ip: "2001:db8::1",
  }));
  check("define accepts IPv6 sender_ip",         ipv6.sender_ip === "2001:db8::1");

  // Re-defining same slug refuses (operator archives + new slug).
  await assert.rejects(
    ctx.wu.defineSchedule(_validInput()),
    /already exists/
  );
}

async function _defineRefusals() {
  var ctx = _setup();
  // Bad slug.
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ slug: "Has Caps" })),  /slug/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ slug: "" })),           /slug/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ slug: 42 })),           /slug/);

  // Bad domain.
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ sender_domain: "" })),         /sender_domain/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ sender_domain: "not a dom" })),/sender_domain/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ sender_domain: "no-tld" })),   /sender_domain/);

  // Bad IP.
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ sender_ip: "not-an-ip" })),     /sender_ip/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ sender_ip: "999.999.999.999" })),/sender_ip/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ sender_ip: "" })),               /sender_ip/);

  // Bad start_date.
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ start_date: "2026/05/22" })),   /start_date/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ start_date: "2026-13-01" })),   /start_date/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ start_date: "2026-02-31" })),   /calendar date/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ start_date: 20260522 })),       /start_date/);

  // Bad daily_targets.
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ daily_targets: [] })),               /daily_targets/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ daily_targets: "ramp" })),           /daily_targets/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ daily_targets: [0, 100] })),         /daily_targets/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ daily_targets: [-50, 100] })),       /daily_targets/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ daily_targets: [50, 100.5] })),      /daily_targets/);

  // Bad threshold.
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ status_check_threshold: -1 })),      /status_check_threshold/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ status_check_threshold: 10001 })),   /status_check_threshold/);
  await assert.rejects(ctx.wu.defineSchedule(_validInput({ status_check_threshold: "high" })),  /status_check_threshold/);

  // Null input.
  await assert.rejects(ctx.wu.defineSchedule(null),         /input/);
  await assert.rejects(ctx.wu.defineSchedule(undefined),    /input/);
}

// ---- currentDay math --------------------------------------------------

async function _currentDayMath() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput());

  // Day 1 (noon UTC of start_date).
  var d1 = await ctx.wu.currentDay("release-ip-2026");
  check("Day 1 index",                            d1.day_index === 1);
  check("Day 1 status in_ramp",                   d1.status === "in_ramp");
  check("Day 1 target = 50",                      d1.daily_target === 50);
  check("Day 1 ramp_length = 7",                  d1.ramp_length === 7);

  // Day 3.
  ctx.clock.setDay(3);
  var d3 = await ctx.wu.currentDay("release-ip-2026");
  check("Day 3 index",                            d3.day_index === 3);
  check("Day 3 target = 250",                     d3.daily_target === 250);

  // Day 7 (last day of ramp).
  ctx.clock.setDay(7);
  var d7 = await ctx.wu.currentDay("release-ip-2026");
  check("Day 7 index",                            d7.day_index === 7);
  check("Day 7 target = 4000",                    d7.daily_target === 4000);

  // Day 8 (post-ramp).
  ctx.clock.setDay(8);
  var d8 = await ctx.wu.currentDay("release-ip-2026");
  check("Day 8 status post_ramp",                 d8.status === "post_ramp");
  check("Day 8 daily_target = 0",                 d8.daily_target === 0);

  // Pre-ramp: clock before start_date.
  ctx.clock.setMs(Date.UTC(2026, 4, 1, 12, 0));  // 2026-05-01 noon UTC
  var dPre = await ctx.wu.currentDay("release-ip-2026");
  check("pre-ramp day_index 0",                   dPre.day_index === 0);
  check("pre-ramp status pre_ramp",               dPre.status === "pre_ramp");
  check("pre-ramp daily_target 0",                dPre.daily_target === 0);

  // Day 2 — boundary check at midnight UTC.
  ctx.clock.setMs(Date.UTC(2026, 4, 23, 0, 0));  // 2026-05-23 00:00:00 UTC
  var d2Boundary = await ctx.wu.currentDay("release-ip-2026");
  check("Day 2 at midnight UTC",                  d2Boundary.day_index === 2);

  // currentDay miss.
  await assert.rejects(ctx.wu.currentDay("never-defined"), /not found/);
}

// ---- canSend within / over daily cap ----------------------------------

async function _canSendWithinCap() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput());

  // Day 1 — daily_target 50. Plan 40, none used → ok.
  var v1 = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 40 });
  check("canSend day1 plan40 ok",                 v1.ok === true);
  check("canSend day1 used 0",                    v1.sends_used_today === 0);
  check("canSend day1 target 50",                 v1.daily_target === 50);
  check("canSend day1 remaining 50",              v1.remaining === 50);
  check("canSend day1 reason ok",                 v1.reason === "ok");
  check("canSend day1 day_index 1",               v1.day_index === 1);

  // Record 40 sends, then plan 5 more — still ok (45 + 5 = 50 == target).
  await ctx.wu.recordSends({ slug: "release-ip-2026", count: 40 });
  var v2 = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 5 });
  check("canSend day1 plan5 after 40 ok",         v2.ok === true);
  check("canSend day1 used 40",                   v2.sends_used_today === 40);
  check("canSend day1 remaining 10",              v2.remaining === 10);

  // Plan 11 more — would be 51, over the 50 cap.
  var v3 = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 11 });
  check("canSend day1 plan11 over-cap not ok",    v3.ok === false);
  check("canSend day1 over-cap reason",           v3.reason === "over_cap");
  check("canSend day1 over-cap reports used 40",  v3.sends_used_today === 40);
  check("canSend day1 over-cap remaining 10",     v3.remaining === 10);

  // Record 10 more — at the cap.
  await ctx.wu.recordSends({ slug: "release-ip-2026", count: 10 });
  var v4 = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1 });
  check("canSend day1 at cap plan1 not ok",       v4.ok === false);
  check("canSend day1 at cap remaining 0",        v4.remaining === 0);

  // Roll the clock to day 2 — fresh 100 target, no sends recorded.
  ctx.clock.setDay(2);
  var v5 = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1 });
  check("canSend day2 ok",                        v5.ok === true);
  check("canSend day2 used 0",                    v5.sends_used_today === 0);
  check("canSend day2 target 100",                v5.daily_target === 100);

  // count_planned defaults to 1 when omitted.
  var v6 = await ctx.wu.canSend({ slug: "release-ip-2026" });
  check("canSend default plan=1 ok",              v6.ok === true);
}

async function _canSendFsmStates() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput());

  // Unknown schedule.
  var unknown = await ctx.wu.canSend({ slug: "never-defined", count_planned: 1 });
  check("canSend unknown ok=false",               unknown.ok === false);
  check("canSend unknown reason",                 unknown.reason === "unknown_schedule");

  // Paused schedule.
  await ctx.wu.pauseSchedule({ slug: "release-ip-2026", reason: "bounce spike" });
  var paused = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1 });
  check("canSend paused ok=false",                paused.ok === false);
  check("canSend paused reason",                  paused.reason === "paused");

  // Resume → ok again.
  await ctx.wu.resumeSchedule({ slug: "release-ip-2026" });
  var resumed = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1 });
  check("canSend post-resume ok",                 resumed.ok === true);

  // Archive → archived reason.
  await ctx.wu.archiveSchedule("release-ip-2026");
  var archived = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1 });
  check("canSend archived ok=false",              archived.ok === false);
  check("canSend archived reason",                archived.reason === "archived");

  // Pre-ramp: define a schedule whose start_date is in the future.
  var ctx2 = _setup("2026-05-22");
  ctx2.clock.setMs(Date.UTC(2026, 4, 1, 12, 0));  // 2026-05-01 noon — well before 2026-05-22
  await ctx2.wu.defineSchedule(_validInput({ slug: "future-ramp" }));
  var preRamp = await ctx2.wu.canSend({ slug: "future-ramp", count_planned: 1 });
  check("canSend pre-ramp ok=false",              preRamp.ok === false);
  check("canSend pre-ramp reason",                preRamp.reason === "pre_ramp");

  // Post-ramp: roll clock past the ramp length.
  var ctx3 = _setup("2026-05-22");
  await ctx3.wu.defineSchedule(_validInput({ slug: "short-ramp", daily_targets: [50, 100] }));
  ctx3.clock.setDay(3);
  var postRamp = await ctx3.wu.canSend({ slug: "short-ramp", count_planned: 1 });
  check("canSend post-ramp ok=false",             postRamp.ok === false);
  check("canSend post-ramp reason",               postRamp.reason === "post_ramp");

  // Bad input shapes.
  await assert.rejects(ctx.wu.canSend(null),                                                /input/);
  await assert.rejects(ctx.wu.canSend({ slug: "X X", count_planned: 1 }),                   /slug/);
  await assert.rejects(ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 0 }),       /count_planned/);
  await assert.rejects(ctx.wu.canSend({ slug: "release-ip-2026", count_planned: -1 }),      /count_planned/);
  await assert.rejects(ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1, now: -5 }), /now/);
}

// ---- recordSends accumulation -----------------------------------------

async function _recordSendsAccumulates() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput());

  // Day 1 — record 20, then 15, then 5 = 40.
  var r1 = await ctx.wu.recordSends({ slug: "release-ip-2026", count: 20 });
  check("recordSends first returns 20",           r1.sends_count === 20);
  check("recordSends day_index 1",                r1.day_index === 1);
  check("recordSends occurred_date populated",    r1.occurred_date === "2026-05-22");

  var r2 = await ctx.wu.recordSends({ slug: "release-ip-2026", count: 15 });
  check("recordSends accumulates 35",             r2.sends_count === 35);

  var r3 = await ctx.wu.recordSends({ slug: "release-ip-2026", count: 5 });
  check("recordSends accumulates 40",             r3.sends_count === 40);

  // canSend reflects the accumulated total.
  var v = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1 });
  check("canSend after 40 used 40",               v.sends_used_today === 40);

  // Roll to day 2 — fresh row for new date.
  ctx.clock.setDay(2);
  var r4 = await ctx.wu.recordSends({ slug: "release-ip-2026", count: 30 });
  check("recordSends day2 fresh 30",              r4.sends_count === 30);
  check("recordSends day2 index 2",               r4.day_index === 2);
  check("recordSends day2 occurred_date",         r4.occurred_date === "2026-05-23");

  // Day 1 row is unaffected.
  var ctxBack = await ctx.wu.canSend({ slug: "release-ip-2026", count_planned: 1, now: ctx.clock.startMs + 12 * 60 * 60 * 1000 });
  check("day 1 used still 40 after day 2 writes", ctxBack.sends_used_today === 40);

  // recordSends refuses against paused schedule.
  await ctx.wu.pauseSchedule({ slug: "release-ip-2026", reason: "pause for test" });
  await assert.rejects(ctx.wu.recordSends({ slug: "release-ip-2026", count: 1 }), /paused/);

  // Resume + archive — archive also refuses.
  await ctx.wu.resumeSchedule({ slug: "release-ip-2026" });
  await ctx.wu.archiveSchedule("release-ip-2026");
  await assert.rejects(ctx.wu.recordSends({ slug: "release-ip-2026", count: 1 }), /archived/);

  // recordSends on missing slug.
  await assert.rejects(ctx.wu.recordSends({ slug: "never-defined", count: 1 }), /not found/);

  // Bad input.
  await assert.rejects(ctx.wu.recordSends(null),                              /input/);
  await assert.rejects(ctx.wu.recordSends({ slug: "release-ip-2026", count: 0 }), /count/);
  await assert.rejects(ctx.wu.recordSends({ slug: "release-ip-2026", count: -1 }), /count/);
}

// ---- recordEngagement -------------------------------------------------

async function _recordEngagement() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput());

  await ctx.wu.recordSends({ slug: "release-ip-2026", count: 50 });
  await ctx.wu.recordEngagement({ slug: "release-ip-2026", event_type: "bounce", count: 2 });
  await ctx.wu.recordEngagement({ slug: "release-ip-2026", event_type: "complaint", count: 1 });

  var m = await ctx.wu.metricsForSchedule("release-ip-2026");
  check("metrics day 1 sends = 50",               m.days[0].sends_count === 50);
  check("metrics day 1 bounces = 2",              m.days[0].bounce_count === 2);
  check("metrics day 1 complaints = 1",           m.days[0].complaint_count === 1);
  check("metrics total sends = 50",               m.total_sends === 50);
  check("metrics total bounces = 2",              m.total_bounces === 2);

  // Drop-silent on unknown schedule (ESP webhook for archived /
  // missing sender).
  var verdict = await ctx.wu.recordEngagement({
    slug: "never-defined",
    event_type: "bounce",
  });
  check("recordEngagement unknown drop-silent",   verdict.recorded === false);

  // Bad input still throws.
  await assert.rejects(ctx.wu.recordEngagement(null),                                            /input/);
  await assert.rejects(ctx.wu.recordEngagement({ slug: "release-ip-2026", event_type: "open" }), /event_type/);
  await assert.rejects(ctx.wu.recordEngagement({ slug: "release-ip-2026", event_type: "bounce", count: -1 }), /count/);
}

// ---- FSM pause / resume / archive -------------------------------------

async function _fsmTransitions() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput());

  // active → paused.
  var paused = await ctx.wu.pauseSchedule({ slug: "release-ip-2026", reason: "bounce spike" });
  check("pause status",                           paused.status === "paused");
  check("pause records reason",                   paused.paused_reason === "bounce spike");
  check("pause stamps paused_at",                 Number.isInteger(paused.paused_at) && paused.paused_at > 0);

  // pause again refuses.
  await assert.rejects(ctx.wu.pauseSchedule({ slug: "release-ip-2026", reason: "double pause" }),
    /cannot pause/);

  // paused → active.
  var resumed = await ctx.wu.resumeSchedule({ slug: "release-ip-2026" });
  check("resume status",                          resumed.status === "active");
  check("resume clears paused_at",                resumed.paused_at === null);
  check("resume clears paused_reason",            resumed.paused_reason === null);

  // resume again refuses (active → resume invalid).
  await assert.rejects(ctx.wu.resumeSchedule({ slug: "release-ip-2026" }),
    /cannot resume/);

  // active → archived (direct).
  var archived = await ctx.wu.archiveSchedule("release-ip-2026");
  check("archive status",                         archived.status === "archived");
  check("archive stamps archived_at",             Number.isInteger(archived.archived_at) && archived.archived_at > 0);

  // archived is terminal — every transition refuses.
  await assert.rejects(ctx.wu.pauseSchedule({ slug: "release-ip-2026", reason: "after-archive" }),
    /cannot pause/);
  await assert.rejects(ctx.wu.resumeSchedule({ slug: "release-ip-2026" }),
    /cannot resume/);
  await assert.rejects(ctx.wu.archiveSchedule("release-ip-2026"),
    /cannot archive/);

  // Define a fresh schedule + paused → archived path.
  await ctx.wu.defineSchedule(_validInput({ slug: "to-archive" }));
  await ctx.wu.pauseSchedule({ slug: "to-archive", reason: "winding down" });
  var pa = await ctx.wu.archiveSchedule("to-archive");
  check("paused→archived",                         pa.status === "archived");

  // Missing slug refusals.
  await assert.rejects(ctx.wu.pauseSchedule({ slug: "never-defined", reason: "x" }), /not found/);
  await assert.rejects(ctx.wu.resumeSchedule({ slug: "never-defined" }),              /not found/);
  await assert.rejects(ctx.wu.archiveSchedule("never-defined"),                       /not found/);

  // Bad inputs.
  await assert.rejects(ctx.wu.pauseSchedule(null),                                                 /input/);
  await assert.rejects(ctx.wu.pauseSchedule({ slug: "release-ip-2026", reason: "" }),              /reason/);
  await assert.rejects(ctx.wu.pauseSchedule({ slug: "release-ip-2026", reason: "x\r\ny" }),        /reason/);
  await assert.rejects(ctx.wu.resumeSchedule(null),                                                /input/);
}

// ---- listSchedules ----------------------------------------------------

async function _listSchedules() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput({ slug: "alpha" }));
  await ctx.wu.defineSchedule(_validInput({ slug: "beta" }));
  await ctx.wu.defineSchedule(_validInput({ slug: "gamma" }));
  await ctx.wu.pauseSchedule({ slug: "beta", reason: "investigate" });
  await ctx.wu.archiveSchedule("gamma");

  var all = await ctx.wu.listSchedules();
  check("listSchedules returns 3",                all.length === 3);

  var actives = await ctx.wu.listSchedules({ active_only: true });
  check("listSchedules active_only = 1 (alpha)",  actives.length === 1);
  check("listSchedules active is alpha",          actives[0].slug === "alpha");

  // limit.
  var limited = await ctx.wu.listSchedules({ limit: 2 });
  check("listSchedules limit = 2",                limited.length === 2);

  // Bad limit.
  await assert.rejects(ctx.wu.listSchedules({ limit: -1 }),   /limit/);
  await assert.rejects(ctx.wu.listSchedules({ limit: 99999 }),/limit/);
}

// ---- metricsForSchedule -----------------------------------------------

async function _metricsForSchedule() {
  var ctx = _setup("2026-05-22");
  await ctx.wu.defineSchedule(_validInput({ status_check_threshold: 500 })); // 5.00%

  // Day 1: 50 sends, 1 bounce → 200 bps (under 500).
  await ctx.wu.recordSends({ slug: "release-ip-2026", count: 50 });
  await ctx.wu.recordEngagement({ slug: "release-ip-2026", event_type: "bounce" });

  // Day 2: 100 sends, 6 bounces, 1 complaint → bounce 600 bps (over), complaint 100 bps.
  ctx.clock.setDay(2);
  await ctx.wu.recordSends({ slug: "release-ip-2026", count: 100 });
  await ctx.wu.recordEngagement({ slug: "release-ip-2026", event_type: "bounce", count: 6 });
  await ctx.wu.recordEngagement({ slug: "release-ip-2026", event_type: "complaint" });

  var m = await ctx.wu.metricsForSchedule("release-ip-2026");
  check("metrics days count = 2",                 m.days.length === 2);
  check("metrics total_sends = 150",              m.total_sends === 150);
  check("metrics total_bounces = 7",              m.total_bounces === 7);
  check("metrics total_complaints = 1",           m.total_complaints === 1);

  // Day 1 entries.
  check("day 1 sends = 50",                       m.days[0].sends_count === 50);
  check("day 1 daily_target = 50",                m.days[0].daily_target === 50);
  check("day 1 bounce_rate_bps = 200",            m.days[0].bounce_rate_bps === 200);
  check("day 1 complaint_rate_bps = 0",           m.days[0].complaint_rate_bps === 0);
  check("day 1 not threshold_breached",           m.days[0].threshold_breached === false);

  // Day 2 entries.
  check("day 2 sends = 100",                      m.days[1].sends_count === 100);
  check("day 2 daily_target = 100",               m.days[1].daily_target === 100);
  check("day 2 bounce_rate_bps = 600",            m.days[1].bounce_rate_bps === 600);
  check("day 2 complaint_rate_bps = 100",         m.days[1].complaint_rate_bps === 100);
  check("day 2 threshold_breached (600 > 500)",   m.days[1].threshold_breached === true);

  // ramp_length + status_check_threshold echo back.
  check("metrics ramp_length = 7",                m.ramp_length === 7);
  check("metrics threshold = 500",                m.status_check_threshold === 500);
  check("metrics sender_domain echo",             m.sender_domain === "release.shop.example");

  // metrics on missing slug.
  await assert.rejects(ctx.wu.metricsForSchedule("never-defined"), /not found/);
}

// ---- module-level helpers ---------------------------------------------

async function _moduleLevelDayMath() {
  // _computeDayIndex + _isoFromMs are exposed for direct testing.
  var startMs = Date.UTC(2026, 4, 22);  // 2026-05-22 00:00 UTC
  var day1Noon = startMs + 12 * 60 * 60 * 1000;
  var day2Noon = startMs + 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
  check("_isoFromMs at start",                    emailWarmup._isoFromMs(startMs) === "2026-05-22");
  check("_isoFromMs at day 1 noon",               emailWarmup._isoFromMs(day1Noon) === "2026-05-22");
  check("_isoFromMs at day 2 noon",               emailWarmup._isoFromMs(day2Noon) === "2026-05-23");

  check("_computeDayIndex day 1",                 emailWarmup._computeDayIndex("2026-05-22", day1Noon) === 1);
  check("_computeDayIndex day 2",                 emailWarmup._computeDayIndex("2026-05-22", day2Noon) === 2);
  check("_computeDayIndex pre-ramp",               emailWarmup._computeDayIndex("2026-05-22", startMs - 24 * 60 * 60 * 1000) === 0);
}

// ---- run --------------------------------------------------------------

async function run() {
  await _defineHappyPath();
  await _defineRefusals();
  await _currentDayMath();
  await _canSendWithinCap();
  await _canSendFsmStates();
  await _recordSendsAccumulates();
  await _recordEngagement();
  await _fsmTransitions();
  await _listSchedules();
  await _metricsForSchedule();
  await _moduleLevelDayMath();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7) is wired
  // before the first test runs.
  void bShop;
  run().then(function () {
    process.stdout.write("email-warmup.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("email-warmup.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
