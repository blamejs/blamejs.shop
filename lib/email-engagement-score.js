"use strict";
/**
 * @module shop.emailEngagementScore
 * @title  Email engagement score — per-customer 0..100 score derived
 *         from open / click / unsubscribe / spam-complaint events.
 *
 * @intro
 *   Marketing-list health is a long-running aggregation problem: a
 *   customer who opens every weekly newsletter and clicks one link a
 *   month is worth a richer send cadence; a customer who hasn't opened
 *   a message in three months but never formally unsubscribed is a
 *   future spam complaint waiting to happen. Sending to lapsed
 *   addresses degrades the sender's domain reputation across the
 *   entire list, so the primitive's purpose is to give the operator a
 *   single integer per customer (and a band label) so the campaign
 *   scheduler can filter the audience before a send rather than after
 *   the deliverability damage is done.
 *
 *   Distinct from `emailSuppressions` (migration 0028), which is the
 *   absolute opt-out / bounce / complaint gate: a row there blocks
 *   every matching send. The engagement score is the softer signal —
 *   marketing surfaces (`emailCampaigns`, dunning reminders,
 *   abandoned-cart) read this primitive at audience-resolution time
 *   and drop recipients below the operator's chosen band so the
 *   sending domain doesn't decay from broadcasting into silent
 *   inboxes.
 *
 *   Six observable event types, each with a calibrated default
 *   weight:
 *
 *     opened                +5
 *     clicked              +15
 *     unsubscribed         -50   (immediately drops the band)
 *     spam_reported        -75   (worst possible — destroys reputation)
 *     bounced              -10
 *     not_opened_in_window  -3   (silent decay — cron-driven)
 *
 *   The running score starts at 50 (the operator's first impression
 *   of a fresh customer is "neutral, prove yourself either way"), is
 *   accumulated from the event log on every recompute, and is clamped
 *   to the closed interval 0..100.
 *
 *   Bands (closed intervals on score):
 *
 *     75 .. 100  → highly_engaged
 *     50 ..  74  → engaged
 *     20 ..  49  → lapsed
 *      0 ..  19  → unengaged
 *
 *   The thresholds are exposed on `emailEngagementScore.BANDS` so the
 *   integrator's dashboard and the test suite assert against the same
 *   numbers the runtime uses.
 *
 *   Surface:
 *     - recordEngagementEvent({ customer_id, event_type, occurred_at? })
 *     - getScore(customer_id)
 *     - recompute(customer_id)
 *     - recomputeAll({ since })
 *     - unengagedCustomers({ band_max, limit })
 *     - metricsForBand({ band, from?, to? })
 *     - historyForCustomer(customer_id, { from?, to?, limit? })
 *
 *   Composition surface:
 *
 *     var eng = bShop.emailEngagementScore.create({ query: q });
 *     await eng.recordEngagementEvent({
 *       customer_id: cid, event_type: "opened",
 *     });
 *     var view = await eng.getScore(cid);
 *     // { customer_id, score, band, last_opened_at, last_clicked_at,
 *     //   send_count, open_count, click_count, open_rate, click_rate,
 *     //   computed_at }
 *
 *   Storage:
 *     - email_engagement_events  (migration 0187)
 *     - email_engagement_scores  (migration 0187)
 *
 *   Optional handles (all injectable on create()):
 *     - query             — D1-shaped async query function (required)
 *     - emailCampaigns    — caller correlator for "this engagement
 *                           event came from a campaign send"; stored
 *                           on the instance for an integrator's
 *                           cross-primitive orchestration, never
 *                           reached into by this primitive
 *     - emailSuppressions — caller correlator for the suppression-on-
 *                           spam_reported reflex; same posture as the
 *                           campaign handle (stored, not consumed)
 *
 *   Recording an event is always an explicit caller action — never an
 *   implicit cross-primitive side effect. That keeps the score audit
 *   trail clean (every change in the score has exactly one recorded
 *   event behind it) and lets the test suite isolate each event
 *   source.
 *
 *   Monotonic per-customer occurred_at: two writes against the same
 *   customer in the same millisecond would tie on `occurred_at` and
 *   make the "latest event" read ambiguous in the `(customer_id,
 *   occurred_at DESC)` index. `_resolveOccurredAt` bumps the
 *   requested timestamp to `prior + 1` on collision, guaranteeing
 *   strict monotonicity (same discipline as customer_risk_signals).
 *
 *   Recording an event refreshes the denormalized summary in lockstep
 *   so getScore / unengagedCustomers / metricsForBand all answer from
 *   a single-row read on the hot path.
 *
 * @primitive emailEngagementScore
 * @related   b.uuid.v7, b.guardUuid, shop.emailCampaigns, shop.emailSuppressions
 */

var b = require("./index").framework;

// ---- constants ----------------------------------------------------------

var EVENT_TYPES = Object.freeze([
  "opened",
  "clicked",
  "unsubscribed",
  "spam_reported",
  "bounced",
  "not_opened_in_window",
]);

// Per-event score deltas. The operator who needs a different
// calibration forks the constant on a project-local module and
// composes the primitive against that; the exposed table is the
// runtime's single source of truth.
var WEIGHTS = Object.freeze({
  opened:               5,
  clicked:              15,
  unsubscribed:         -50,
  spam_reported:        -75,
  bounced:              -10,
  not_opened_in_window: -3,
});

// Starting score for a customer with no events on file. Neutral —
// neither the campaign scheduler nor the suppression gate has a
// reason to treat the address as risky until evidence accumulates.
var STARTING_SCORE = 50;

// Closed intervals on score. Score 0..19 → unengaged, 20..49 →
// lapsed, 50..74 → engaged, 75..100 → highly_engaged. Exposed so
// the test suite + the dashboard renderer pull the same numbers the
// runtime uses.
var BANDS = Object.freeze({
  UNENGAGED_MAX:      19,
  LAPSED_MAX:         49,
  ENGAGED_MAX:        74,
});

var BAND_NAMES = Object.freeze([
  "unengaged", "lapsed", "engaged", "highly_engaged",
]);

// Events that count toward `send_count` (the denominator for
// open_rate / click_rate). A bounce IS a send (the message was
// dispatched but rejected by the destination); an unsubscribe /
// spam_reported is NOT a fresh send signal — it's a response to a
// prior delivery, captured separately.
var SEND_EVENTS = Object.freeze({
  opened:               true,
  clicked:              true,
  bounced:              true,
  not_opened_in_window: true,
});

// List-read upper bound — keeps unengagedCustomers / metricsForBand
// from accidentally returning a giant page when the operator forgets
// to bound their query.
var MAX_LIST_LIMIT = 500;

// ---- monotonic clock ---------------------------------------------------
//
// Two writes against the same customer in the same millisecond would
// tie on occurred_at and corrupt the (customer_id, occurred_at DESC)
// index ordering. Bumping by 1ms on a tie keeps the timeline strictly
// increasing so a sort-by-timestamp read returns events in the order
// they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("emailEngagementScore: " + label +
      " — " + (e && e.message || "invalid UUID"));
  }
}

function _eventType(s) {
  if (typeof s !== "string" || EVENT_TYPES.indexOf(s) === -1) {
    throw new TypeError("emailEngagementScore: event_type must be one of " +
      EVENT_TYPES.join(", ") + ", got " + JSON.stringify(s));
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("emailEngagementScore: " + label +
      " must be a non-negative integer epoch-ms");
  }
  return ts;
}

function _band(s) {
  if (typeof s !== "string" || BAND_NAMES.indexOf(s) === -1) {
    throw new TypeError("emailEngagementScore: band must be one of " +
      BAND_NAMES.join(", "));
  }
  return s;
}

function _positiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("emailEngagementScore: " + label +
      " must be a positive integer");
  }
  return n;
}

function _limit(n) {
  _positiveInt(n, "limit");
  if (n > MAX_LIST_LIMIT) {
    throw new TypeError("emailEngagementScore: limit must be <= " +
      MAX_LIST_LIMIT);
  }
  return n;
}

function _clampScore(n) {
  if (n < 0)   return 0;
  if (n > 100) return 100;
  return n;
}

function _bandFor(score) {
  if (score <= BANDS.UNENGAGED_MAX) return "unengaged";
  if (score <= BANDS.LAPSED_MAX)    return "lapsed";
  if (score <= BANDS.ENGAGED_MAX)   return "engaged";
  return "highly_engaged";
}

function _rate(num, den) {
  if (!den) return 0;
  // Four-decimal-place rate so the dashboard renders 0.1234 without
  // floating-point trailing noise. The input is integer / integer so
  // Math.round is exact.
  return Math.round((num / den) * 10000) / 10000;
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Optional caller-correlator handles. Stored so an integrator can
  // recover them off the instance for orchestration; not consumed by
  // this primitive directly. Recording an event is always an explicit
  // operator call, never an implicit cross-primitive side effect.
  var emailCampaigns    = opts.emailCampaigns    || null;
  var emailSuppressions = opts.emailSuppressions || null;

  async function _readLatestEventTs(customerId) {
    var r = await query(
      "SELECT occurred_at FROM email_engagement_events " +
      "WHERE customer_id = ?1 ORDER BY occurred_at DESC LIMIT 1",
      [customerId],
    );
    return r.rows.length ? r.rows[0].occurred_at : null;
  }

  // Same monotonic-clock discipline as customer_risk_signals: two
  // writes against the same customer in the same millisecond would
  // tie on occurred_at and corrupt the (customer_id, occurred_at
  // DESC) index ordering. Bump the second write to prior + 1.
  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _readSummary(customerId) {
    var r = await query(
      "SELECT customer_id, score, band, last_opened_at, last_clicked_at, " +
      "send_count, open_count, click_count, computed_at " +
      "FROM email_engagement_scores WHERE customer_id = ?1 LIMIT 1",
      [customerId],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  // Recompute the denormalized summary row for one customer from the
  // event log. Walks every event in chronological order, applies the
  // weight table, clamps to 0..100, and upserts the summary. Returns
  // the fresh summary shape so callers don't re-read.
  async function _recomputeOne(customerId, now) {
    var r = await query(
      "SELECT event_type, occurred_at FROM email_engagement_events " +
      "WHERE customer_id = ?1 ORDER BY occurred_at ASC",
      [customerId],
    );

    var score         = STARTING_SCORE;
    var lastOpenedAt  = null;
    var lastClickedAt = null;
    var sendCount     = 0;
    var openCount     = 0;
    var clickCount    = 0;

    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var et  = row.event_type;
      score += (Object.prototype.hasOwnProperty.call(WEIGHTS, et) ? WEIGHTS[et] : 0);
      if (SEND_EVENTS[et]) sendCount += 1;
      if (et === "opened") {
        openCount    += 1;
        if (lastOpenedAt == null || row.occurred_at > lastOpenedAt) {
          lastOpenedAt = row.occurred_at;
        }
      } else if (et === "clicked") {
        clickCount    += 1;
        if (lastClickedAt == null || row.occurred_at > lastClickedAt) {
          lastClickedAt = row.occurred_at;
        }
        // A click implies an open even if the open beacon never
        // fired (image-blocking clients). Bump open_count + stamp
        // last_opened_at so the rate columns stay honest.
        openCount    += 1;
        if (lastOpenedAt == null || row.occurred_at > lastOpenedAt) {
          lastOpenedAt = row.occurred_at;
        }
      }
    }

    score      = _clampScore(score);
    var band   = _bandFor(score);

    var existing = await _readSummary(customerId);
    if (existing) {
      await query(
        "UPDATE email_engagement_scores SET score = ?1, band = ?2, " +
        "last_opened_at = ?3, last_clicked_at = ?4, send_count = ?5, " +
        "open_count = ?6, click_count = ?7, computed_at = ?8 " +
        "WHERE customer_id = ?9",
        [score, band, lastOpenedAt, lastClickedAt, sendCount,
          openCount, clickCount, now, customerId],
      );
    } else {
      await query(
        "INSERT INTO email_engagement_scores " +
        "(customer_id, score, band, last_opened_at, last_clicked_at, " +
        "send_count, open_count, click_count, computed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        [customerId, score, band, lastOpenedAt, lastClickedAt,
          sendCount, openCount, clickCount, now],
      );
    }

    return {
      customer_id:     customerId,
      score:           score,
      band:            band,
      last_opened_at:  lastOpenedAt,
      last_clicked_at: lastClickedAt,
      send_count:      sendCount,
      open_count:      openCount,
      click_count:     clickCount,
      computed_at:     now,
    };
  }

  function _hydrate(summary) {
    var sendCount  = Number(summary.send_count);
    var openCount  = Number(summary.open_count);
    var clickCount = Number(summary.click_count);
    return {
      customer_id:     summary.customer_id,
      score:           Number(summary.score),
      band:            summary.band,
      last_opened_at:  summary.last_opened_at,
      last_clicked_at: summary.last_clicked_at,
      send_count:      sendCount,
      open_count:      openCount,
      click_count:     clickCount,
      open_rate:       _rate(openCount,  sendCount),
      click_rate:      _rate(clickCount, sendCount),
      computed_at:     summary.computed_at,
    };
  }

  return {

    EVENT_TYPES:     EVENT_TYPES,
    BAND_NAMES:      BAND_NAMES,
    BANDS:           { UNENGAGED_MAX: BANDS.UNENGAGED_MAX,
                       LAPSED_MAX:    BANDS.LAPSED_MAX,
                       ENGAGED_MAX:   BANDS.ENGAGED_MAX },
    WEIGHTS:         WEIGHTS,
    STARTING_SCORE:  STARTING_SCORE,

    // Stored optional handles — exposed read-only so an integrator
    // can recover them off the instance for cross-primitive
    // orchestration. The primitive itself never reaches in.
    handles: {
      emailCampaigns:    emailCampaigns,
      emailSuppressions: emailSuppressions,
    },

    recordEngagementEvent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailEngagementScore.recordEngagementEvent: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var eventType  = _eventType(input.event_type);
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatestEventTs(customerId);
      var ts     = _resolveOccurredAt(requested, latest);

      var id = b.uuid.v7();
      await query(
        "INSERT INTO email_engagement_events " +
        "(id, customer_id, event_type, occurred_at) VALUES (?1, ?2, ?3, ?4)",
        [id, customerId, eventType, ts],
      );

      // Refresh the denormalized summary in lockstep so getScore /
      // unengagedCustomers / metricsForBand all answer from a single-
      // row read on the hot path.
      var summary = await _recomputeOne(customerId, _now());

      return {
        id:           id,
        customer_id:  customerId,
        event_type:   eventType,
        occurred_at:  ts,
        score:        summary.score,
        band:         summary.band,
      };
    },

    getScore: async function (customerId) {
      _uuid(customerId, "customer_id");
      var summary = await _readSummary(customerId);
      if (!summary) {
        // Customer never had an event — return the neutral starting
        // shape so the dashboard renders "no engagement data" the
        // same way as "we recomputed and there's nothing." The
        // starting score lands in the `engaged` band by design (a
        // fresh address has no reason to be excluded from the
        // welcome series).
        return _hydrate({
          customer_id:     customerId,
          score:           STARTING_SCORE,
          band:            _bandFor(STARTING_SCORE),
          last_opened_at:  null,
          last_clicked_at: null,
          send_count:      0,
          open_count:      0,
          click_count:     0,
          computed_at:     null,
        });
      }
      return _hydrate(summary);
    },

    recompute: async function (customerId) {
      _uuid(customerId, "customer_id");
      var summary = await _recomputeOne(customerId, _now());
      return _hydrate(summary);
    },

    // Refresh every summary whose `computed_at` is older than the
    // operator-supplied cutoff OR who has an event recorded since the
    // cutoff. The integrator wires this on a cron so a customer
    // accumulating not_opened_in_window decay events keeps drifting
    // toward `unengaged` without waiting for a fresh positive signal
    // to force a recompute.
    recomputeAll: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailEngagementScore.recomputeAll: input object required");
      }
      var since = _epochMs(input.since, "since");
      if (since == null) {
        throw new TypeError("emailEngagementScore.recomputeAll: since is required");
      }
      var r = await query(
        "SELECT DISTINCT customer_id FROM email_engagement_scores WHERE computed_at < ?1 " +
        "UNION " +
        "SELECT DISTINCT customer_id FROM email_engagement_events WHERE occurred_at >= ?1",
        [since],
      );
      var now       = _now();
      var rows      = r.rows;
      var refreshed = [];
      for (var i = 0; i < rows.length; i += 1) {
        var summary = await _recomputeOne(rows[i].customer_id, now);
        refreshed.push(_hydrate(summary));
      }
      return { recomputed_count: refreshed.length, recomputed_at: now };
    },

    // Customers under or at a band cap, ordered by score ascending
    // (lowest-engagement first) so the operator's "who do we
    // re-engage / who do we drop" review starts at the worst
    // offenders. `band_max` is INCLUSIVE — `band_max: "lapsed"`
    // returns both lapsed AND unengaged customers (everything at-or-
    // below the lapsed tier).
    unengagedCustomers: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailEngagementScore.unengagedCustomers: input object required");
      }
      var bandMax = _band(input.band_max);
      var limit   = _limit(input.limit);

      // Score ceiling for the inclusive band cap.
      var ceiling;
      switch (bandMax) {
      case "unengaged":      ceiling = BANDS.UNENGAGED_MAX; break;
      case "lapsed":         ceiling = BANDS.LAPSED_MAX;    break;
      case "engaged":        ceiling = BANDS.ENGAGED_MAX;   break;
      case "highly_engaged": ceiling = 100;                 break;
      default:
        // _band above is exhaustive over BAND_NAMES, but the eslint
        // default-case rule wants an explicit fallthrough — keep the
        // throw so a future band addition refuses loud instead of
        // returning accidentally-empty results.
        throw new TypeError("emailEngagementScore.unengagedCustomers: unhandled band " +
          JSON.stringify(bandMax));
      }

      var r = await query(
        "SELECT customer_id, score, band, last_opened_at, last_clicked_at, " +
        "send_count, open_count, click_count, computed_at " +
        "FROM email_engagement_scores WHERE score <= ?1 " +
        "ORDER BY score ASC, customer_id ASC LIMIT ?2",
        [ceiling, limit],
      );
      return r.rows.map(_hydrate);
    },

    // Aggregate counters + average score for one band over an optional
    // [from, to] window on `computed_at`. `from` / `to` are optional —
    // absent, the entire band is in scope. The operator's KPI
    // dashboard reads this to chart band-membership drift over time.
    metricsForBand: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailEngagementScore.metricsForBand: input object required");
      }
      var band = _band(input.band);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from != null && to != null && to < from) {
        throw new TypeError("emailEngagementScore.metricsForBand: to must be >= from");
      }

      var sql    = "SELECT COUNT(*) AS n, COALESCE(AVG(score), 0) AS avg_score, " +
                   "COALESCE(SUM(send_count), 0)  AS sends, " +
                   "COALESCE(SUM(open_count), 0)  AS opens, " +
                   "COALESCE(SUM(click_count), 0) AS clicks " +
                   "FROM email_engagement_scores WHERE band = ?1";
      var params = [band];
      var slot   = 2;
      if (from != null) { sql += " AND computed_at >= ?" + slot; params.push(from); slot += 1; }
      if (to   != null) { sql += " AND computed_at <= ?" + slot; params.push(to);   slot += 1; }

      var row    = (await query(sql, params)).rows[0];
      var count  = Number(row.n);
      var sends  = Number(row.sends  || 0);
      var opens  = Number(row.opens  || 0);
      var clicks = Number(row.clicks || 0);
      return {
        band:           band,
        customer_count: count,
        // AVG returns 0 on an empty band; surface null so the
        // dashboard distinguishes "the band is empty" from "every
        // customer in the band scored 0".
        avg_score:      count === 0 ? null : Number(row.avg_score),
        send_count:     sends,
        open_count:     opens,
        click_count:    clicks,
        open_rate:      _rate(opens,  sends),
        click_rate:     _rate(clicks, sends),
      };
    },

    historyForCustomer: async function (customerId, listOpts) {
      _uuid(customerId, "customer_id");
      listOpts  = listOpts || {};
      var from  = _epochMs(listOpts.from, "from");
      var to    = _epochMs(listOpts.to,   "to");
      var limit = listOpts.limit == null ? MAX_LIST_LIMIT : _limit(listOpts.limit);
      if (from != null && to != null && to < from) {
        throw new TypeError("emailEngagementScore.historyForCustomer: to must be >= from");
      }

      var sql    = "SELECT id, customer_id, event_type, occurred_at " +
                   "FROM email_engagement_events WHERE customer_id = ?1";
      var params = [customerId];
      var slot   = 2;
      if (from != null) { sql += " AND occurred_at >= ?" + slot; params.push(from); slot += 1; }
      if (to   != null) { sql += " AND occurred_at <= ?" + slot; params.push(to);   slot += 1; }
      sql += " ORDER BY occurred_at DESC LIMIT ?" + slot;
      params.push(limit);

      var r = await query(sql, params);
      return r.rows;
    },
  };
}

module.exports = {
  create:         create,
  EVENT_TYPES:    EVENT_TYPES,
  BAND_NAMES:     BAND_NAMES,
  BANDS:          BANDS,
  WEIGHTS:        WEIGHTS,
  STARTING_SCORE: STARTING_SCORE,
};
