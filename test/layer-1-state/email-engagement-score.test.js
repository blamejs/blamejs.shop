"use strict";
/**
 * emailEngagementScore — per-customer 0..100 engagement grade derived
 * from open / click / unsubscribe / spam-complaint events. Marketing
 * surfaces consult the summary at audience-resolution time and drop
 * recipients below the operator's threshold so sending-domain
 * reputation doesn't decay from broadcasting into silent inboxes.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0187
 * alone — the primitive has no FKs into the rest of the schema, so
 * the test runs against a minimal in-memory database with just the two
 * engagement tables.
 *
 * The primitive isn't wired through bShop yet — the test requires
 * lib/email-engagement-score.js directly so the gate exists ahead of
 * the entry-point edit.
 *
 * Coverage:
 *   - recordEngagementEvent happy path for every event_type, weight
 *     table applied, score clamped to [0, 100], cold-start neutral
 *     baseline 50.
 *   - clicked also bumps open_count + last_opened_at (image-blocked
 *     clients).
 *   - monotonic per-customer occurred_at: two writes in the same
 *     millisecond don't tie on the index.
 *   - getScore on a never-recorded customer returns the neutral shape
 *     without inserting a summary row.
 *   - band mapping at the four boundary thresholds.
 *   - historyForCustomer returns the event log in descending order,
 *     honours from / to / limit.
 *   - recompute re-derives the summary from the event log.
 *   - recomputeAll picks up stale summaries + customers with recent
 *     events but no summary row.
 *   - unengagedCustomers respects inclusive band_max + score-asc sort.
 *   - metricsForBand aggregates customer_count + avg_score + rate
 *     columns within an optional window.
 *   - input refusals: bad customer_id, bad event_type, bad
 *     occurred_at, bad band / band_max, bad limit, bad from / to,
 *     null input.
 *   - factory accepts the optional emailCampaigns / emailSuppressions
 *     handles and exposes them on `.handles`.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop                = require("../../lib");
var emailEngagementScore = require("../../lib/email-engagement-score");
var helpers              = require("../helpers");
var check                = helpers.check;
var assert               = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0187_email_engagement_score.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var queryFn = async function (sql, params) {
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
  queryFn.__db = db;
  return queryFn;
}

function _setup(extraOpts) {
  extraOpts = extraOpts || {};
  var query = _makeQuery();
  var es    = emailEngagementScore.create(Object.assign({ query: query }, extraOpts));
  return { query: query, es: es };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- recordEngagementEvent — weights, send_count, rates ------------------

async function _recordEventHappy() {
  var ctx = _setup();
  var cid = _uuid();

  // opened → +5. Neutral 50 → 55, band engaged.
  var r1 = await ctx.es.recordEngagementEvent({
    customer_id: cid,
    event_type:  "opened",
  });
  check("recordEngagementEvent returns id (uuid v7)", typeof r1.id === "string" && r1.id.length >= 32);
  check("recordEngagementEvent customer_id echo",      r1.customer_id === cid);
  check("recordEngagementEvent event_type echo",       r1.event_type === "opened");
  check("recordEngagementEvent score 55 after open",   r1.score === 55);
  check("recordEngagementEvent band engaged",          r1.band === "engaged");
  check("recordEngagementEvent occurred_at populated", Number.isInteger(r1.occurred_at) && r1.occurred_at > 0);

  // getScore reflects + denormalized counters.
  var g1 = await ctx.es.getScore(cid);
  check("getScore score 55",                           g1.score === 55);
  check("getScore band engaged",                       g1.band === "engaged");
  check("getScore send_count 1 (opened counts)",       g1.send_count === 1);
  check("getScore open_count 1",                       g1.open_count === 1);
  check("getScore click_count 0",                      g1.click_count === 0);
  check("getScore open_rate = 1",                      g1.open_rate === 1);
  check("getScore click_rate = 0",                     g1.click_rate === 0);
  check("getScore last_opened_at stamped",             Number.isInteger(g1.last_opened_at) && g1.last_opened_at > 0);
  check("getScore last_clicked_at null",               g1.last_clicked_at === null);
  check("getScore computed_at stamped",                Number.isInteger(g1.computed_at) && g1.computed_at > 0);

  // clicked → +15. Implies an open even when the open beacon never
  // fired (image-blocked clients), so open_count + last_opened_at also
  // bump. 55 → 70.
  var r2 = await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "clicked" });
  check("recordEngagementEvent score 70 after click",  r2.score === 70);

  var g2 = await ctx.es.getScore(cid);
  check("clicked bumps click_count",                   g2.click_count === 1);
  check("clicked implies open (count)",                g2.open_count  === 2);
  check("clicked send_count 2",                        g2.send_count  === 2);
  check("clicked last_clicked_at stamped",             Number.isInteger(g2.last_clicked_at) && g2.last_clicked_at > 0);

  // open_rate now 2/2 = 1; click_rate 1/2 = 0.5.
  check("getScore open_rate 1.0",                      g2.open_rate  === 1);
  check("getScore click_rate 0.5",                     g2.click_rate === 0.5);

  // Drive into highly_engaged (≥ 75): one more click → 85.
  var r3 = await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "clicked" });
  check("score 85 after 2nd click",                    r3.score === 85);
  check("band highly_engaged at 85",                   r3.band  === "highly_engaged");

  // Cap at 100. From 85 with successive +15 clicks: 100, clamped.
  await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "clicked" });    // 100
  var rOver = await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "clicked" });
  check("score clamped to 100",                        rOver.score === 100);
  var rStill = await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened" });
  check("score stays at ceiling 100",                  rStill.score === 100);
}

// ---- negative event types ------------------------------------------------

async function _negativeEvents() {
  var ctx = _setup();

  // unsubscribed → -50, drives 50 → 0 (unengaged).
  var cidU = _uuid();
  var rU = await ctx.es.recordEngagementEvent({ customer_id: cidU, event_type: "unsubscribed" });
  check("unsubscribed score 0",                        rU.score === 0);
  check("unsubscribed band unengaged",                 rU.band === "unengaged");

  // spam_reported → -75, drives 50 → -25 → clamped 0.
  var cidS = _uuid();
  var rS = await ctx.es.recordEngagementEvent({ customer_id: cidS, event_type: "spam_reported" });
  check("spam_reported clamped to 0",                  rS.score === 0);
  check("spam_reported band unengaged",                rS.band === "unengaged");

  // bounced → -10, drives 50 → 40 (lapsed band 20..49).
  var cidB = _uuid();
  var rB = await ctx.es.recordEngagementEvent({ customer_id: cidB, event_type: "bounced" });
  check("bounced score 40",                            rB.score === 40);
  check("bounced band lapsed",                         rB.band === "lapsed");

  // not_opened_in_window → -3, drives 50 → 47 (lapsed).
  var cidN = _uuid();
  var rN = await ctx.es.recordEngagementEvent({ customer_id: cidN, event_type: "not_opened_in_window" });
  check("not_opened_in_window score 47",               rN.score === 47);
  check("not_opened_in_window band lapsed",            rN.band === "lapsed");

  // bounced counts as a "send" (the message was dispatched but
  // rejected). open_count / click_count stay 0.
  var gB = await ctx.es.getScore(cidB);
  check("bounce contributes to send_count",            gB.send_count === 1);
  check("bounce does not contribute to open_count",    gB.open_count === 0);

  // unsubscribed / spam_reported do NOT count as sends — they're
  // responses to prior deliveries, not fresh send signals.
  var gU = await ctx.es.getScore(cidU);
  check("unsubscribed send_count 0",                   gU.send_count === 0);
  var gS = await ctx.es.getScore(cidS);
  check("spam_reported send_count 0",                  gS.send_count === 0);

  // Module-level WEIGHTS surface matches what the runtime applies.
  var w = emailEngagementScore.WEIGHTS;
  check("WEIGHTS.opened",                              w.opened === 5);
  check("WEIGHTS.clicked",                             w.clicked === 15);
  check("WEIGHTS.unsubscribed",                        w.unsubscribed === -50);
  check("WEIGHTS.spam_reported",                       w.spam_reported === -75);
  check("WEIGHTS.bounced",                             w.bounced === -10);
  check("WEIGHTS.not_opened_in_window",                w.not_opened_in_window === -3);
}

// ---- monotonic clock -----------------------------------------------------

async function _monotonicClock() {
  var ctx = _setup();
  var cid = _uuid();

  // Three events stamped at the same wall-clock millisecond — primitive
  // bumps each one forward by +1 so the (customer_id, occurred_at DESC)
  // index stays strictly monotonic.
  var t0 = Date.UTC(2026, 4, 22, 12, 0, 0);
  var r1 = await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened", occurred_at: t0 });
  var r2 = await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened", occurred_at: t0 });
  var r3 = await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened", occurred_at: t0 });
  check("monotonic 1 occurred_at == t0",               r1.occurred_at === t0);
  check("monotonic 2 occurred_at == t0 + 1",           r2.occurred_at === t0 + 1);
  check("monotonic 3 occurred_at == t0 + 2",           r3.occurred_at === t0 + 2);

  // An older requested timestamp gets bumped forward to latest + 1.
  var rOld = await ctx.es.recordEngagementEvent({
    customer_id: cid,
    event_type:  "opened",
    occurred_at: t0 - 5000,
  });
  check("monotonic backfill bumps to latest+1",        rOld.occurred_at === t0 + 3);

  // A strictly newer timestamp is preserved.
  var rNew = await ctx.es.recordEngagementEvent({
    customer_id: cid,
    event_type:  "opened",
    occurred_at: t0 + 1000,
  });
  check("monotonic forward preserved",                 rNew.occurred_at === t0 + 1000);

  // Different customer — independent monotonic line.
  var cid2 = _uuid();
  var rOther = await ctx.es.recordEngagementEvent({
    customer_id: cid2,
    event_type:  "opened",
    occurred_at: t0,
  });
  check("monotonic per-customer independent",          rOther.occurred_at === t0);
}

// ---- getScore cold start -------------------------------------------------

async function _getScoreColdStart() {
  var ctx = _setup();
  var cid = _uuid();

  var grade = await ctx.es.getScore(cid);
  check("getScore cold-start score 50",                grade.score === 50);
  check("getScore cold-start band engaged",            grade.band === "engaged");
  check("getScore cold-start send_count 0",            grade.send_count === 0);
  check("getScore cold-start open_count 0",            grade.open_count === 0);
  check("getScore cold-start click_count 0",           grade.click_count === 0);
  check("getScore cold-start open_rate 0",             grade.open_rate === 0);
  check("getScore cold-start click_rate 0",            grade.click_rate === 0);
  check("getScore cold-start last_opened_at null",     grade.last_opened_at === null);
  check("getScore cold-start last_clicked_at null",    grade.last_clicked_at === null);
  check("getScore cold-start computed_at null",        grade.computed_at === null);

  // Cold-start lookup must NOT have created a summary row — the
  // dashboard treats summary-present as "we've observed this customer".
  var r = await ctx.query(
    "SELECT customer_id FROM email_engagement_scores WHERE customer_id = ?1",
    [cid],
  );
  check("getScore cold-start did not insert summary",  r.rows.length === 0);
}

// ---- band boundary mapping -----------------------------------------------

async function _bandBoundaries() {
  // Drive each customer's score to a specific value by composing events
  // that sum to the desired delta from the neutral 50 starting point.
  // The weights table: opened +5, clicked +15, unsubscribed -50,
  // spam_reported -75, bounced -10, not_opened_in_window -3.

  async function _atScore(target) {
    var ctx = _setup();
    var cid = _uuid();
    // Use opens (+5) and not_opened_in_window (-3) to land precisely.
    // Combinations:
    //   0   → -50 from 50 → 10x not_opened (-30) + spam (-75) clamped
    //   25  → 5 opens (+25)
    //   49  → -1 from 50 → spam clamped + then 25 opens = 25; instead
    //         bounce (-10) + 13 opens (+65) = 55; tricky.
    // Easier: use opens (+5), clicks (+15), bounce (-10), and
    // not_opened (-3) to land precisely on each boundary value.
    var moves;
    switch (target) {
    case 100: moves = []; for (var i = 0; i < 10; i += 1) moves.push("clicked"); break;     // 50 + 150 → clamped 100
    case 75:  moves = ["clicked","clicked","opened","opened","opened","opened","opened"];   // 50 + 30 + 25 = 105 → 100; use weights to land at 75 instead
              // 50 + 15 + 10 = 75 → click + 2 opens.
              moves = ["clicked", "opened", "opened"]; break;
    case 74:  // 50 + 24. 4 clicks = +60, too much. Use 3 opens (+15) + 5 not_open (-15) = 0. Need +24.
              // +15 (click) + +9 (need). 9 isn't a multiple of weights. Try opens (+5) ×4 = +20, then +4? No.
              // Use 5 opens (+25), -1: 5 opens + 1 not_open (-3) + 2 opens (+10) = 35. Not -1.
              // Approach: bounces (-10) only land in multiples of 10. opens (+5) in multiples of 5.
              // Use bounce (-10) + 17 opens (+85) = 75. We need 74.
              // not_opened (-3): 3 not_opened = -9. 50 - 9 = 41. + opens (+5) doesn't reach 74.
              // 1 click (+15) + 2 opens (+10) = 25 → 75. Need 24.
              // 1 click (+15) + 1 open (+5) + (need +4). Tricky. Try 8 opens (+40) - 5 not_opened (-15) = 25 → 75.
              // (need 74 = 50+24): 5 opens (+25) - 0 = 75. Off by 1. Add 1 not_open (-3) = 72. Off by -2.
              // 6 opens (+30) - 2 not_opened (-6) = 24 → 74.
              moves = ["opened","opened","opened","opened","opened","opened","not_opened_in_window","not_opened_in_window"]; break;
    case 50:  moves = []; break;                                                            // start at 50
    case 49:  // -1. 1 not_opened (-3) + +2 — can't. -3 + +5 (open) = +2 → 52. 1 click (+15) + 5 not_opened (-15) = 0 → 50.
              // 1 bounce (-10) + 9 not_opened (-27) = -37 → 13. Not -1.
              // 8 opens (+40) - 14 not_opened (-42) = -2 → 48. 9 opens (+45) - 14 not_opened (-42) = +3 → 53.
              // 7 opens (+35) - 12 not_opened (-36) = -1 → 49.
              moves = ["opened","opened","opened","opened","opened","opened","opened",
                       "not_opened_in_window","not_opened_in_window","not_opened_in_window","not_opened_in_window",
                       "not_opened_in_window","not_opened_in_window","not_opened_in_window","not_opened_in_window",
                       "not_opened_in_window","not_opened_in_window","not_opened_in_window","not_opened_in_window"]; break;
    case 20:  // -30. 3 bounces = -30 → 20.
              moves = ["bounced","bounced","bounced"]; break;
    case 19:  // -31. 3 bounces (-30) + 1 not_opened (... not exact). 1 click (+15) - 5 bounces (-50) + opens? Let's see.
              // 3 bounces (-30) + 1 not_opened (-3) = -33 → 17. Off.
              // 10 not_opened (-30) + 1 not_opened (-3) = -33 → 17. Same.
              // 1 unsubscribe (-50) + 4 opens (+20) - 1 not_opened (-3) = -33 → 17.
              // 1 unsubscribe (-50) + 1 click (+15) + 1 open (+5) - 1 not_opened (-3) = -33 → 17.
              // Want -31. 1 unsubscribe (-50) + 1 click (+15) + 1 open (+5) - 1 not_opened (-3) + 1 open (+5) - 3 not_opened (-9) = +12 - 12 = 0 → 50. ugh.
              // 1 bounce (-10) + 7 not_opened (-21) = -31 → 19.
              moves = ["bounced","not_opened_in_window","not_opened_in_window","not_opened_in_window","not_opened_in_window","not_opened_in_window","not_opened_in_window","not_opened_in_window"]; break;
    case 0:   // -50. Unsubscribe (-50).
              moves = ["unsubscribed"]; break;
    default:
      throw new Error("test: no recipe for score " + target);
    }
    for (var k = 0; k < moves.length; k += 1) {
      await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: moves[k] });
    }
    return ctx.es.getScore(cid);
  }

  var g100 = await _atScore(100); check("band 100 highly_engaged",           g100.band === "highly_engaged" && g100.score === 100);
  var g75  = await _atScore(75);  check("band 75 highly_engaged (lower)",    g75.band  === "highly_engaged" && g75.score  === 75);
  var g74  = await _atScore(74);  check("band 74 engaged (upper)",           g74.band  === "engaged"        && g74.score  === 74);
  var g50  = await _atScore(50);  check("band 50 engaged (lower / cold)",    g50.band  === "engaged"        && g50.score  === 50);
  var g49  = await _atScore(49);  check("band 49 lapsed (upper)",            g49.band  === "lapsed"         && g49.score  === 49);
  var g20  = await _atScore(20);  check("band 20 lapsed (lower)",            g20.band  === "lapsed"         && g20.score  === 20);
  var g19  = await _atScore(19);  check("band 19 unengaged (upper)",         g19.band  === "unengaged"      && g19.score  === 19);
  var g0   = await _atScore(0);   check("band 0 unengaged",                  g0.band   === "unengaged"      && g0.score   === 0);

  // BANDS constants exposed on the module.
  check("BANDS.UNENGAGED_MAX",                         emailEngagementScore.BANDS.UNENGAGED_MAX === 19);
  check("BANDS.LAPSED_MAX",                            emailEngagementScore.BANDS.LAPSED_MAX === 49);
  check("BANDS.ENGAGED_MAX",                           emailEngagementScore.BANDS.ENGAGED_MAX === 74);
}

// ---- historyForCustomer --------------------------------------------------

async function _historyForCustomer() {
  var ctx = _setup();
  var cid = _uuid();
  var cidOther = _uuid();

  var t0 = Date.UTC(2026, 4, 22, 0, 0, 0);
  await ctx.es.recordEngagementEvent({ customer_id: cid,       event_type: "opened",  occurred_at: t0 + 1000 });
  await ctx.es.recordEngagementEvent({ customer_id: cid,       event_type: "clicked", occurred_at: t0 + 2000 });
  await ctx.es.recordEngagementEvent({ customer_id: cid,       event_type: "bounced", occurred_at: t0 + 3000 });
  await ctx.es.recordEngagementEvent({ customer_id: cidOther,  event_type: "opened",  occurred_at: t0 + 1500 });

  var rows = await ctx.es.historyForCustomer(cid);
  check("historyForCustomer length 3",                 rows.length === 3);
  check("historyForCustomer[0] is bounced (newest)",   rows[0].event_type === "bounced");
  check("historyForCustomer[1] is clicked",            rows[1].event_type === "clicked");
  check("historyForCustomer[2] is opened",             rows[2].event_type === "opened");
  check("historyForCustomer scoped by customer",       rows.every(function (r) { return r.customer_id === cid; }));

  // from/to window — pulls only events strictly inside [from, to].
  var win = await ctx.es.historyForCustomer(cid, { from: t0 + 1500, to: t0 + 2500 });
  check("historyForCustomer window length 1",          win.length === 1);
  check("historyForCustomer window[0] is clicked",     win[0].event_type === "clicked");

  // limit clamp.
  var oneRow = await ctx.es.historyForCustomer(cid, { limit: 1 });
  check("historyForCustomer limit 1",                  oneRow.length === 1);
  check("historyForCustomer limit 1 [0] is bounced",   oneRow[0].event_type === "bounced");

  // Unknown customer returns empty.
  var empty = await ctx.es.historyForCustomer(_uuid());
  check("historyForCustomer unknown empty",            empty.length === 0);

  // Range refusal — to < from.
  await assert.rejects(
    ctx.es.historyForCustomer(cid, { from: t0 + 1000, to: t0 + 500 }),
    /to must be >= from/
  );
}

// ---- recompute + recomputeAll --------------------------------------------

async function _recomputeAndAll() {
  var ctx = _setup();
  var cid = _uuid();

  // Record one event, then directly hand-edit the summary to a stale
  // value. recompute() must re-derive the correct score from the log.
  await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened" });
  await ctx.query(
    "UPDATE email_engagement_scores SET score = 99, band = 'highly_engaged' WHERE customer_id = ?1",
    [cid],
  );

  var stale = await ctx.es.getScore(cid);
  check("getScore reads stale summary",                stale.score === 99);

  var fresh = await ctx.es.recompute(cid);
  check("recompute re-derives score 55",               fresh.score === 55);
  check("recompute re-derives band engaged",           fresh.band === "engaged");
  check("recompute open_count 1",                      fresh.open_count === 1);
  check("recompute click_count 0",                     fresh.click_count === 0);
  check("recompute send_count 1",                      fresh.send_count === 1);

  var afterRecompute = await ctx.es.getScore(cid);
  check("getScore reflects recompute",                 afterRecompute.score === 55);

  // recomputeAll: customer A has a stale summary, customer B has events
  // but a fresh-ish summary (no recompute needed for it), customer C
  // has an event but NO summary row (mimics an interrupted upsert).
  var cidA = _uuid();
  var cidB = _uuid();
  var cidC = _uuid();
  var now = Date.now();

  await ctx.es.recordEngagementEvent({ customer_id: cidA, event_type: "opened" });
  await ctx.es.recordEngagementEvent({ customer_id: cidB, event_type: "opened" });
  // Backdate A's summary to look stale (computed_at < since cutoff).
  await ctx.query(
    "UPDATE email_engagement_scores SET computed_at = ?1 WHERE customer_id = ?2",
    [now - 100000, cidA],
  );
  // Hand-insert an event for cidC without creating a summary.
  var id = bShop.framework.uuid.v7();
  await ctx.query(
    "INSERT INTO email_engagement_events (id, customer_id, event_type, occurred_at) " +
    "VALUES (?1, ?2, ?3, ?4)",
    [id, cidC, "clicked", now - 50],
  );

  var result = await ctx.es.recomputeAll({ since: now - 50000 });
  check("recomputeAll returns count",                  Number.isInteger(result.recomputed_count) && result.recomputed_count >= 2);
  check("recomputeAll returns recomputed_at",          Number.isInteger(result.recomputed_at) && result.recomputed_at > 0);

  // cidA refreshed (stale-summary path).
  var sA = await ctx.es.getScore(cidA);
  check("recomputeAll refreshed cidA score 55",        sA.score === 55);
  check("recomputeAll bumped cidA computed_at",        sA.computed_at >= now - 50);

  // cidC summary created (no-summary, recent-event path). A click is
  // +15 (open implied) → 65, engaged.
  var sC = await ctx.es.getScore(cidC);
  check("recomputeAll created cidC summary score 65",  sC.score === 65);
  check("recomputeAll cidC band engaged",              sC.band === "engaged");
  check("recomputeAll cidC click_count 1",             sC.click_count === 1);
  check("recomputeAll cidC open_count 1 (implied)",    sC.open_count === 1);
  check("recomputeAll cidC send_count 1",              sC.send_count === 1);
}

// ---- unengagedCustomers --------------------------------------------------

async function _unengagedCustomers() {
  var ctx = _setup();
  var cidHigh = _uuid();
  var cidEngaged = _uuid();
  var cidLapsed = _uuid();
  var cidGone  = _uuid();

  // Highly engaged: lots of clicks → 100.
  for (var i = 0; i < 10; i += 1) {
    await ctx.es.recordEngagementEvent({ customer_id: cidHigh, event_type: "clicked" });
  }
  // Engaged: 1 open → 55.
  await ctx.es.recordEngagementEvent({ customer_id: cidEngaged, event_type: "opened" });
  // Lapsed: 1 bounce → 40.
  await ctx.es.recordEngagementEvent({ customer_id: cidLapsed, event_type: "bounced" });
  // Unengaged: unsubscribe → 0.
  await ctx.es.recordEngagementEvent({ customer_id: cidGone, event_type: "unsubscribed" });

  // band_max = "unengaged" → only cidGone (score ≤ 19).
  var only = await ctx.es.unengagedCustomers({ band_max: "unengaged", limit: 10 });
  check("unengagedCustomers unengaged length 1",       only.length === 1);
  check("unengagedCustomers unengaged is cidGone",     only[0].customer_id === cidGone);
  check("unengagedCustomers unengaged score 0",        only[0].score === 0);

  // band_max = "lapsed" → cidGone + cidLapsed, sorted asc.
  var loose = await ctx.es.unengagedCustomers({ band_max: "lapsed", limit: 10 });
  check("unengagedCustomers lapsed length 2",          loose.length === 2);
  check("unengagedCustomers lapsed[0] is cidGone",     loose[0].customer_id === cidGone);
  check("unengagedCustomers lapsed[1] is cidLapsed",   loose[1].customer_id === cidLapsed);

  // band_max = "engaged" → cidGone + cidLapsed + cidEngaged (≤ 74).
  var wider = await ctx.es.unengagedCustomers({ band_max: "engaged", limit: 10 });
  check("unengagedCustomers engaged length 3",         wider.length === 3);
  check("unengagedCustomers engaged[0] is cidGone",    wider[0].customer_id === cidGone);
  check("unengagedCustomers engaged[2] is cidEngaged", wider[2].customer_id === cidEngaged);

  // band_max = "highly_engaged" → all 4.
  var all = await ctx.es.unengagedCustomers({ band_max: "highly_engaged", limit: 10 });
  check("unengagedCustomers highly_engaged length 4",  all.length === 4);
  check("unengagedCustomers all[3] is cidHigh (top)",  all[3].customer_id === cidHigh);

  // limit honoured.
  var two = await ctx.es.unengagedCustomers({ band_max: "highly_engaged", limit: 2 });
  check("unengagedCustomers limit 2",                  two.length === 2);
  check("unengagedCustomers limit 2 [0] cidGone",      two[0].customer_id === cidGone);
}

// ---- metricsForBand ------------------------------------------------------

async function _metricsForBand() {
  var ctx = _setup();

  // Three customers in the engaged band.
  for (var i = 0; i < 3; i += 1) {
    var cid = _uuid();
    await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened" });
    await ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened" });
  }
  // One customer in the unengaged band.
  var cidU = _uuid();
  await ctx.es.recordEngagementEvent({ customer_id: cidU, event_type: "unsubscribed" });

  var engaged = await ctx.es.metricsForBand({ band: "engaged" });
  check("metricsForBand engaged customer_count 3",     engaged.customer_count === 3);
  check("metricsForBand engaged avg_score 60",         engaged.avg_score === 60);     // each had 2 opens → 60
  check("metricsForBand engaged send_count 6",         engaged.send_count === 6);
  check("metricsForBand engaged open_count 6",         engaged.open_count === 6);
  check("metricsForBand engaged click_count 0",        engaged.click_count === 0);
  check("metricsForBand engaged open_rate 1",          engaged.open_rate === 1);
  check("metricsForBand engaged click_rate 0",         engaged.click_rate === 0);

  var unengaged = await ctx.es.metricsForBand({ band: "unengaged" });
  check("metricsForBand unengaged customer_count 1",   unengaged.customer_count === 1);
  check("metricsForBand unengaged avg_score 0",        unengaged.avg_score === 0);

  // Empty band — lapsed has nobody. avg_score must be null, not 0.
  var lapsed = await ctx.es.metricsForBand({ band: "lapsed" });
  check("metricsForBand empty band count 0",           lapsed.customer_count === 0);
  check("metricsForBand empty band avg_score null",    lapsed.avg_score === null);
  check("metricsForBand empty band rates 0",           lapsed.open_rate === 0 && lapsed.click_rate === 0);

  // Window — narrow `from` past computed_at on all rows → 0 results.
  var future = await ctx.es.metricsForBand({
    band: "engaged",
    from: Date.now() + 1000 * 1000,
  });
  check("metricsForBand future window count 0",        future.customer_count === 0);
  check("metricsForBand future window avg null",       future.avg_score === null);

  // Range refusal — to < from.
  await assert.rejects(
    ctx.es.metricsForBand({ band: "engaged", from: 100, to: 50 }),
    /to must be >= from/
  );
}

// ---- input refusals ------------------------------------------------------

async function _refusals() {
  var ctx = _setup();
  var cid = _uuid();

  // recordEngagementEvent refusals.
  await assert.rejects(ctx.es.recordEngagementEvent(null),                                                /input/);
  await assert.rejects(ctx.es.recordEngagementEvent(undefined),                                            /input/);
  await assert.rejects(ctx.es.recordEngagementEvent({ customer_id: "not-a-uuid", event_type: "opened" }),  /customer_id/);
  await assert.rejects(ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "purchased" }),        /event_type/);
  await assert.rejects(ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "" }),                 /event_type/);
  await assert.rejects(ctx.es.recordEngagementEvent({ customer_id: cid, event_type: 42 }),                 /event_type/);
  // Bad occurred_at.
  await assert.rejects(ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened", occurred_at: -1 }),    /occurred_at/);
  await assert.rejects(ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened", occurred_at: 1.5 }),    /occurred_at/);
  await assert.rejects(ctx.es.recordEngagementEvent({ customer_id: cid, event_type: "opened", occurred_at: "ts" }),  /occurred_at/);

  // getScore refusals.
  await assert.rejects(ctx.es.getScore("not-a-uuid"),  /customer_id/);
  await assert.rejects(ctx.es.getScore(null),          /customer_id/);

  // recompute refusals.
  await assert.rejects(ctx.es.recompute("not-a-uuid"), /customer_id/);
  await assert.rejects(ctx.es.recompute(null),         /customer_id/);

  // historyForCustomer refusals.
  await assert.rejects(ctx.es.historyForCustomer("not-a-uuid"),        /customer_id/);
  await assert.rejects(ctx.es.historyForCustomer(null),                /customer_id/);
  await assert.rejects(ctx.es.historyForCustomer(cid, { from: -1 }),   /from/);
  await assert.rejects(ctx.es.historyForCustomer(cid, { to: 1.5 }),    /to/);
  await assert.rejects(ctx.es.historyForCustomer(cid, { limit: 0 }),   /limit/);
  await assert.rejects(ctx.es.historyForCustomer(cid, { limit: 1.5 }), /limit/);

  // recomputeAll refusals.
  await assert.rejects(ctx.es.recomputeAll(null),                /input/);
  await assert.rejects(ctx.es.recomputeAll({}),                  /since/);
  await assert.rejects(ctx.es.recomputeAll({ since: -1 }),       /since/);
  await assert.rejects(ctx.es.recomputeAll({ since: 1.5 }),      /since/);
  await assert.rejects(ctx.es.recomputeAll({ since: "ts" }),     /since/);

  // unengagedCustomers refusals.
  await assert.rejects(ctx.es.unengagedCustomers(null),                                /input/);
  await assert.rejects(ctx.es.unengagedCustomers({ band_max: "engaged" }),             /limit/);
  await assert.rejects(ctx.es.unengagedCustomers({ band_max: "engaged", limit: 0 }),   /limit/);
  await assert.rejects(ctx.es.unengagedCustomers({ band_max: "engaged", limit: 1.5 }), /limit/);
  await assert.rejects(ctx.es.unengagedCustomers({ band_max: "nope", limit: 10 }),     /band/);
  await assert.rejects(ctx.es.unengagedCustomers({ limit: 10 }),                       /band/);

  // metricsForBand refusals.
  await assert.rejects(ctx.es.metricsForBand(null),                       /input/);
  await assert.rejects(ctx.es.metricsForBand({}),                          /band/);
  await assert.rejects(ctx.es.metricsForBand({ band: "platinum" }),        /band/);
  await assert.rejects(ctx.es.metricsForBand({ band: "engaged", from: -1 }), /from/);
  await assert.rejects(ctx.es.metricsForBand({ band: "engaged", to: 1.5 }),  /to/);
}

// ---- optional handles + module exports -----------------------------------

async function _optionalHandlesAndExports() {
  var sentinelCampaigns    = { fake: "campaigns" };
  var sentinelSuppressions = { fake: "suppressions" };
  var ctx = _setup({
    emailCampaigns:    sentinelCampaigns,
    emailSuppressions: sentinelSuppressions,
  });
  check("handles.emailCampaigns exposed",              ctx.es.handles.emailCampaigns === sentinelCampaigns);
  check("handles.emailSuppressions exposed",           ctx.es.handles.emailSuppressions === sentinelSuppressions);

  var bare = _setup();
  check("handles default emailCampaigns null",         bare.es.handles.emailCampaigns === null);
  check("handles default emailSuppressions null",      bare.es.handles.emailSuppressions === null);

  // Module-level exports the dashboard and test suite share with the
  // runtime.
  check("EVENT_TYPES exported",                        Array.isArray(emailEngagementScore.EVENT_TYPES) && emailEngagementScore.EVENT_TYPES.length === 6);
  check("BAND_NAMES exported",                         Array.isArray(emailEngagementScore.BAND_NAMES) && emailEngagementScore.BAND_NAMES.length === 4);
  check("STARTING_SCORE exported",                     emailEngagementScore.STARTING_SCORE === 50);
}

// ---- run -----------------------------------------------------------------

async function run() {
  await _recordEventHappy();
  await _negativeEvents();
  await _monotonicClock();
  await _getScoreColdStart();
  await _bandBoundaries();
  await _historyForCustomer();
  await _recomputeAndAll();
  await _unengagedCustomers();
  await _metricsForBand();
  await _refusals();
  await _optionalHandlesAndExports();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7, guardUuid)
  // is wired before the first test runs.
  void bShop;
  run().then(function () {
    process.stdout.write("email-engagement-score.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("email-engagement-score.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
