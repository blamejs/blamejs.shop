"use strict";
/**
 * @module shop.referralLeaderboard
 * @title  Referral leaderboard — top-referrer reports + tiered rewards
 *
 * @intro
 *   Sits on top of the existing referrals primitive (migration 0025).
 *   Reads from `referral_codes` + `referral_invitations` to compute:
 *
 *     - `topReferrers({ from, to, limit })` — completed funnels per
 *       referrer in the [from, to] window, ordered by count DESC,
 *       referrer_customer_id ASC for stable ties. Lifetime referral
 *       revenue is filled in by an optional `referrals.revenueForCustomer`
 *       hook on the injected handle; absent the hook, the field is 0.
 *
 *     - `referralTier({ customer_id, as_of? })` — counts completed
 *       funnels in the trailing 90 days against the operator-tunable
 *       thresholds in `referral_tier_config`. Returns one of
 *       bronze / silver / gold / platinum.
 *
 *     - `awardLeaderboardBonus({ customer_id, tier, period_label })`
 *       — UNIQUE on (customer_id, period_label, tier) is the re-award
 *       gate. On a fresh row the composition calls `loyalty.earn`
 *       (when wired) for the tier's configured point bonus; on a
 *       duplicate, returns `{ status: "already-awarded" }` and
 *       NEVER re-invokes loyalty.
 *
 *     - `monthlyChampions({ year, month, limit })` — convenience
 *       wrapper around topReferrers with the month's UTC window.
 *
 *     - `cleanupExpiredBonuses(days)` — sweeps audit-log rows older
 *       than `days` days from `referral_leaderboard_bonuses`. The
 *       loyalty side is untouched (points already landed in the
 *       customer's account); this is a log-retention sweep, not a
 *       reversal.
 *
 *   Tier thresholds (operator-tunable via `setTierThresholds`):
 *
 *     - bronze   — 0  completed referrals in trailing 90d
 *     - silver   — 5
 *     - gold     — 15
 *     - platinum — 40
 *
 *   Point bonuses per tier (operator-tunable via factory opts):
 *
 *     - bronze   — 100   points
 *     - silver   — 500
 *     - gold     — 2000
 *     - platinum — 10000
 *
 *   Monotonic per-process clock: two awards in the same millisecond
 *   would tie on `occurred_at` and make a sort-by-timestamp read
 *   ambiguous. `_now()` bumps to `prior + 1` on collision so the
 *   `historyForCustomer` ORDER BY occurred_at DESC carries a strict
 *   per-process ordering.
 *
 *   Composes:
 *     - `b.uuid.v7`                 — bonus row ids.
 *     - `b.guardUuid`               — strict UUID gate on every
 *                                     customer_id at the entry point.
 *     - `referrals` (optional)      — when wired, `topReferrers`
 *                                     surfaces `lifetime_revenue` via
 *                                     `referrals.revenueForCustomer`.
 *                                     Absent, the field is 0.
 *     - `loyalty` (optional)        — when wired,
 *                                     `awardLeaderboardBonus` composes
 *                                     `loyalty.earn(...)` for the
 *                                     tier's configured bonus.
 *                                     Absent, the bonus row lands
 *                                     and the operator pays out via
 *                                     their own channel.
 *
 *   Storage:
 *     - referral_tier_config, referral_leaderboard_bonuses
 *       (migration `0182_referral_leaderboard.sql`).
 *
 * @primitive referralLeaderboard
 * @related    shop.referrals, shop.loyalty, b.uuid.v7, b.guardUuid
 */

var b = require("./vendor/blamejs");
var C = b.constants;

var TIERS = ["bronze", "silver", "gold", "platinum"];

var DEFAULT_THRESHOLDS = {
  bronze:   0,
  silver:   5,
  gold:     15,
  platinum: 40,
};

var DEFAULT_TIER_BONUS_POINTS = {
  bronze:   100,
  silver:   500,
  gold:     2000,
  platinum: 10000,
};

var MS_PER_DAY = C.TIME.days(1);
var ROLLING_WINDOW_DAYS = 90;

var MAX_LEADERBOARD_LIMIT = 100;
var DEFAULT_LEADERBOARD_LIMIT = 10;

var MAX_PERIOD_LABEL_LEN = 64;
// `2026-05` / `2026-Q2` / `2026-week-21` / `monthly-2026-05` etc.
var PERIOD_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9]$/;

var BONUS_LOG_SOURCE = "referral-leaderboard-bonus";

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven awards can land in the same millisecond on fast
// machines. Bumping by 1ms on a tie keeps the timeline strictly
// increasing so `historyForCustomer` ORDER BY occurred_at returns
// rows in issue order.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("referralLeaderboard: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _positiveInt(n, label, maxOpt) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("referralLeaderboard: " + label + " must be a positive integer");
  }
  if (typeof maxOpt === "number" && n > maxOpt) {
    throw new TypeError("referralLeaderboard: " + label + " must be <= " + maxOpt);
  }
  return n;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("referralLeaderboard: " + label + " must be a non-negative integer");
  }
  return n;
}

function _timestamp(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("referralLeaderboard: " + label + " must be a non-negative integer timestamp");
  }
  return n;
}

function _periodLabel(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("referralLeaderboard: period_label must be a non-empty string");
  }
  if (s.length > MAX_PERIOD_LABEL_LEN) {
    throw new TypeError("referralLeaderboard: period_label must be <= " + MAX_PERIOD_LABEL_LEN + " characters");
  }
  if (!PERIOD_LABEL_RE.test(s)) {
    throw new TypeError("referralLeaderboard: period_label must match /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/");
  }
  return s;
}

function _tier(s) {
  if (typeof s !== "string" || TIERS.indexOf(s) === -1) {
    throw new TypeError("referralLeaderboard: tier must be one of " + TIERS.join(", "));
  }
  return s;
}

function _validateThresholds(t) {
  if (!t || typeof t !== "object") {
    throw new TypeError("referralLeaderboard: thresholds object required");
  }
  for (var i = 0; i < TIERS.length; i += 1) {
    var k = TIERS[i];
    if (!Object.prototype.hasOwnProperty.call(t, k)) {
      throw new TypeError("referralLeaderboard: thresholds." + k + " missing");
    }
    _nonNegInt(t[k], "thresholds." + k);
  }
  // Monotonicity — silver >= bronze, gold >= silver, platinum >= gold.
  // Equal is permitted (the operator may collapse tiers); strictly-
  // decreasing is refused since the tier-resolver assumes the array
  // is sorted by threshold ASC.
  if (t.silver < t.bronze || t.gold < t.silver || t.platinum < t.gold) {
    throw new TypeError("referralLeaderboard: thresholds must be non-decreasing (bronze <= silver <= gold <= platinum)");
  }
  return { bronze: t.bronze, silver: t.silver, gold: t.gold, platinum: t.platinum };
}

function _computeTierFromCount(count, thresholds) {
  // Walk tiers from highest to lowest; first whose threshold the
  // count meets or exceeds wins. Bronze is the floor (threshold 0
  // by default), so the loop always terminates with a placement.
  if (count >= thresholds.platinum) return "platinum";
  if (count >= thresholds.gold)     return "gold";
  if (count >= thresholds.silver)   return "silver";
  return "bronze";
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // referrals is optional — when wired, topReferrers surfaces
  // `lifetime_revenue` via `referrals.revenueForCustomer(customer_id)`.
  // Absent the hook (or the handle entirely), the field falls back to 0
  // so the leaderboard surface stays usable on operator setups that
  // haven't wired revenue tracking yet.
  var referralsHandle = opts.referrals || null;
  if (referralsHandle
      && typeof referralsHandle !== "object") {
    throw new TypeError("referralLeaderboard.create: opts.referrals must be an object");
  }
  if (referralsHandle
      && typeof referralsHandle.revenueForCustomer !== "function"
      && referralsHandle.revenueForCustomer !== undefined) {
    throw new TypeError("referralLeaderboard.create: opts.referrals.revenueForCustomer must be a function when provided");
  }

  // loyalty is optional — when wired, awardLeaderboardBonus composes
  // `loyalty.earn(...)` for the configured tier bonus. Absent, the
  // bonus log row still lands; the operator pays out via their own
  // channel (gift card / discount / store credit).
  var loyaltyHandle = opts.loyalty || null;
  if (loyaltyHandle && typeof loyaltyHandle.earn !== "function") {
    throw new TypeError("referralLeaderboard.create: opts.loyalty must expose an earn(input) method");
  }

  // Tier bonus point values are operator-tunable per factory; the
  // defaults match the loyalty primitive's silver/gold/platinum
  // promotion thresholds so a tier-bonus payout matches the
  // loyalty-tier promotion threshold by default.
  var tierBonusPoints = Object.assign({}, DEFAULT_TIER_BONUS_POINTS);
  if (opts.tierBonusPoints && typeof opts.tierBonusPoints === "object") {
    for (var bi = 0; bi < TIERS.length; bi += 1) {
      var bk = TIERS[bi];
      if (Object.prototype.hasOwnProperty.call(opts.tierBonusPoints, bk)) {
        _nonNegInt(opts.tierBonusPoints[bk], "tierBonusPoints." + bk);
        tierBonusPoints[bk] = opts.tierBonusPoints[bk];
      }
    }
  }

  async function _readThresholds() {
    var r = await query(
      "SELECT bronze_threshold, silver_threshold, gold_threshold, platinum_threshold " +
      "FROM referral_tier_config WHERE id = 1",
      [],
    );
    if (!r.rows.length) {
      return Object.assign({}, DEFAULT_THRESHOLDS);
    }
    var row = r.rows[0];
    return {
      bronze:   Number(row.bronze_threshold),
      silver:   Number(row.silver_threshold),
      gold:     Number(row.gold_threshold),
      platinum: Number(row.platinum_threshold),
    };
  }

  // Window-bounded completed-referral counts joined across referral
  // codes + invitations. `from` and `to` are inclusive on
  // `first_purchase_at` (the funnel-complete timestamp from the
  // referrals primitive). Returns one row per referrer with non-zero
  // completions in the window.
  async function _completedCountsInWindow(from, to, limit) {
    var r = await query(
      "SELECT c.referrer_customer_id AS referrer_customer_id, " +
      "COUNT(i.id) AS completed_referrals " +
      "FROM referral_invitations i " +
      "JOIN referral_codes c ON c.id = i.referral_code_id " +
      "WHERE i.first_purchase_at IS NOT NULL " +
      "AND i.first_purchase_at >= ?1 AND i.first_purchase_at <= ?2 " +
      "GROUP BY c.referrer_customer_id " +
      "HAVING COUNT(i.id) > 0 " +
      "ORDER BY completed_referrals DESC, c.referrer_customer_id ASC " +
      "LIMIT ?3",
      [from, to, limit],
    );
    return r.rows.map(function (row) {
      return {
        referrer_customer_id: row.referrer_customer_id,
        completed_referrals:  Number(row.completed_referrals || 0),
      };
    });
  }

  async function _completedCountForCustomerSince(customerId, sinceTs, untilTs) {
    var r = await query(
      "SELECT COUNT(i.id) AS n FROM referral_invitations i " +
      "JOIN referral_codes c ON c.id = i.referral_code_id " +
      "WHERE c.referrer_customer_id = ?1 " +
      "AND i.first_purchase_at IS NOT NULL " +
      "AND i.first_purchase_at >= ?2 AND i.first_purchase_at <= ?3",
      [customerId, sinceTs, untilTs],
    );
    return Number((r.rows[0] && r.rows[0].n) || 0);
  }

  async function _lifetimeRevenueFor(customerId) {
    if (!referralsHandle || typeof referralsHandle.revenueForCustomer !== "function") {
      return 0;
    }
    var v = await referralsHandle.revenueForCustomer(customerId);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
    return v;
  }

  // UTC month window. `month` is 1-based to match operator intuition
  // (2026-05 -> month = 5); the Date constructor's 0-based month is
  // an implementation detail of this primitive.
  function _monthWindow(year, month) {
    if (!Number.isInteger(year) || year < 1970 || year > 9999) {
      throw new TypeError("referralLeaderboard: year must be an integer in [1970, 9999]");
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new TypeError("referralLeaderboard: month must be an integer in [1, 12]");
    }
    var from = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
    // First instant of the next month, minus 1ms = last instant of
    // the requested month.
    var to = Date.UTC(year, month, 1, 0, 0, 0, 0) - 1;
    return { from: from, to: to };
  }

  return {
    TIERS:                       TIERS.slice(),
    DEFAULT_THRESHOLDS:          Object.assign({}, DEFAULT_THRESHOLDS),
    DEFAULT_TIER_BONUS_POINTS:   Object.assign({}, DEFAULT_TIER_BONUS_POINTS),
    ROLLING_WINDOW_DAYS:         ROLLING_WINDOW_DAYS,
    BONUS_LOG_SOURCE:            BONUS_LOG_SOURCE,

    topReferrers: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referralLeaderboard.topReferrers: input object required");
      }
      _timestamp(input.from, "from");
      _timestamp(input.to,   "to");
      if (input.from > input.to) {
        throw new TypeError("referralLeaderboard.topReferrers: from must be <= to");
      }
      var limit = input.limit == null ? DEFAULT_LEADERBOARD_LIMIT : input.limit;
      _positiveInt(limit, "limit", MAX_LEADERBOARD_LIMIT);

      var rows = await _completedCountsInWindow(input.from, input.to, limit);
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var revenue = await _lifetimeRevenueFor(rows[i].referrer_customer_id);
        out.push({
          referrer_customer_id: rows[i].referrer_customer_id,
          completed_referrals:  rows[i].completed_referrals,
          lifetime_revenue:     revenue,
        });
      }
      return out;
    },

    referralTier: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referralLeaderboard.referralTier: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var asOf = input.as_of == null ? _now() : _timestamp(input.as_of, "as_of");
      // The rolling-90-day window — `since` is asOf minus the window
      // length. A referral whose `first_purchase_at` lands exactly on
      // `since` still counts; the gate is inclusive on both ends.
      var since = asOf - (ROLLING_WINDOW_DAYS * MS_PER_DAY);
      if (since < 0) since = 0;
      var thresholds = await _readThresholds();
      var count = await _completedCountForCustomerSince(customerId, since, asOf);
      var tier = _computeTierFromCount(count, thresholds);
      return {
        customer_id:                customerId,
        tier:                       tier,
        rolling_completed_referrals: count,
        rolling_window_days:        ROLLING_WINDOW_DAYS,
        as_of:                      asOf,
        thresholds:                 thresholds,
      };
    },

    tierThresholds: async function () {
      return await _readThresholds();
    },

    setTierThresholds: async function (input) {
      var thresholds = _validateThresholds(input);
      var ts = _now();
      // Singleton upsert: id = 1 always. node:sqlite + d1 both honor
      // INSERT OR REPLACE here (PK = 1 collapses to a single row).
      await query(
        "INSERT INTO referral_tier_config " +
        "(id, bronze_threshold, silver_threshold, gold_threshold, platinum_threshold, updated_at) " +
        "VALUES (1, ?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "bronze_threshold = excluded.bronze_threshold, " +
        "silver_threshold = excluded.silver_threshold, " +
        "gold_threshold = excluded.gold_threshold, " +
        "platinum_threshold = excluded.platinum_threshold, " +
        "updated_at = excluded.updated_at",
        [thresholds.bronze, thresholds.silver, thresholds.gold, thresholds.platinum, ts],
      );
      return Object.assign({}, thresholds, { updated_at: ts });
    },

    // Composes loyalty.earn (when wired) for the tier's configured
    // bonus, then logs the payout to `referral_leaderboard_bonuses`.
    // UNIQUE on (customer_id, period_label, tier) is the re-award
    // gate — a second call with the same triple returns
    // `{ status: "already-awarded" }` and NEVER re-invokes loyalty.
    //
    // FSM order: the bonus log row is inserted FIRST (so two
    // concurrent callers race on the UNIQUE constraint, not on
    // loyalty.earn). Only the winning insert proceeds to the
    // loyalty.earn call. On loyalty.earn failure, the bonus row is
    // rolled back via DELETE so a retry can re-attempt the full
    // composition — without rollback, a wedged loyalty primitive
    // would permanently lock out the customer from this tier's
    // award.
    awardLeaderboardBonus: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referralLeaderboard.awardLeaderboardBonus: input object required");
      }
      var customerId  = _uuid(input.customer_id, "customer_id");
      var tier        = _tier(input.tier);
      var periodLabel = _periodLabel(input.period_label);
      var pointsBudget = tierBonusPoints[tier];

      // Existing-row probe (idempotency short-circuit). The UNIQUE
      // constraint is still the source of truth — this is the read-
      // side win for the common "second call is a duplicate" case so
      // we don't allocate a row id + risk a no-op INSERT.
      var existing = await query(
        "SELECT id, customer_id, tier, period_label, points_awarded, occurred_at " +
        "FROM referral_leaderboard_bonuses " +
        "WHERE customer_id = ?1 AND period_label = ?2 AND tier = ?3 LIMIT 1",
        [customerId, periodLabel, tier],
      );
      if (existing.rows.length) {
        var row = existing.rows[0];
        return {
          id:             row.id,
          customer_id:    row.customer_id,
          tier:           row.tier,
          period_label:   row.period_label,
          points_awarded: Number(row.points_awarded || 0),
          occurred_at:    Number(row.occurred_at || 0),
          status:         "already-awarded",
        };
      }

      var id = b.uuid.v7();
      var ts = _now();
      try {
        await query(
          "INSERT INTO referral_leaderboard_bonuses " +
          "(id, customer_id, tier, period_label, points_awarded, occurred_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          [id, customerId, tier, periodLabel, pointsBudget, ts],
        );
      } catch (e) {
        if (e && e.message && e.message.indexOf("UNIQUE") !== -1) {
          // Lost the race to a concurrent caller — return their row.
          var raced = await query(
            "SELECT id, customer_id, tier, period_label, points_awarded, occurred_at " +
            "FROM referral_leaderboard_bonuses " +
            "WHERE customer_id = ?1 AND period_label = ?2 AND tier = ?3 LIMIT 1",
            [customerId, periodLabel, tier],
          );
          if (raced.rows.length) {
            var rr = raced.rows[0];
            return {
              id:             rr.id,
              customer_id:    rr.customer_id,
              tier:           rr.tier,
              period_label:   rr.period_label,
              points_awarded: Number(rr.points_awarded || 0),
              occurred_at:    Number(rr.occurred_at || 0),
              status:         "already-awarded",
            };
          }
        }
        throw e;
      }

      // Compose loyalty.earn for the points budget. On failure, roll
      // back the bonus row so a retry can re-attempt cleanly.
      if (loyaltyHandle && pointsBudget > 0) {
        try {
          await loyaltyHandle.earn({
            customer_id: customerId,
            points:      pointsBudget,
            source:      BONUS_LOG_SOURCE,
            notes:       "tier=" + tier + " period=" + periodLabel,
          });
        } catch (e) {
          await query(
            "DELETE FROM referral_leaderboard_bonuses WHERE id = ?1",
            [id],
          );
          throw e;
        }
      }

      return {
        id:             id,
        customer_id:    customerId,
        tier:           tier,
        period_label:   periodLabel,
        points_awarded: pointsBudget,
        occurred_at:    ts,
        status:         "awarded",
      };
    },

    historyForCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referralLeaderboard.historyForCustomer: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var r = await query(
        "SELECT id, customer_id, tier, period_label, points_awarded, occurred_at " +
        "FROM referral_leaderboard_bonuses " +
        "WHERE customer_id = ?1 " +
        "ORDER BY occurred_at DESC, id DESC",
        [customerId],
      );
      return r.rows.map(function (row) {
        return {
          id:             row.id,
          customer_id:    row.customer_id,
          tier:           row.tier,
          period_label:   row.period_label,
          points_awarded: Number(row.points_awarded || 0),
          occurred_at:    Number(row.occurred_at || 0),
        };
      });
    },

    monthlyChampions: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referralLeaderboard.monthlyChampions: input object required");
      }
      var win = _monthWindow(input.year, input.month);
      var limit = input.limit == null ? DEFAULT_LEADERBOARD_LIMIT : input.limit;
      _positiveInt(limit, "limit", MAX_LEADERBOARD_LIMIT);
      var rows = await _completedCountsInWindow(win.from, win.to, limit);
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var revenue = await _lifetimeRevenueFor(rows[i].referrer_customer_id);
        out.push({
          referrer_customer_id: rows[i].referrer_customer_id,
          completed_referrals:  rows[i].completed_referrals,
          lifetime_revenue:     revenue,
        });
      }
      return {
        year:        input.year,
        month:       input.month,
        from:        win.from,
        to:          win.to,
        champions:   out,
      };
    },

    // Retention sweep on the audit-log table — the loyalty side is
    // untouched (points already landed in the customer's account).
    // This deletes bonus log rows older than `days` days; the
    // operator drives the sweep cadence.
    cleanupExpiredBonuses: async function (days) {
      _positiveInt(days, "days");
      var cutoff = _now() - (days * MS_PER_DAY);
      var r = await query(
        "DELETE FROM referral_leaderboard_bonuses WHERE occurred_at < ?1",
        [cutoff],
      );
      return {
        deleted_count: Number(r.rowCount || 0),
        cutoff_at:     cutoff,
      };
    },
  };
}

module.exports = {
  create:                    create,
  TIERS:                     TIERS,
  DEFAULT_THRESHOLDS:        DEFAULT_THRESHOLDS,
  DEFAULT_TIER_BONUS_POINTS: DEFAULT_TIER_BONUS_POINTS,
  ROLLING_WINDOW_DAYS:       ROLLING_WINDOW_DAYS,
  BONUS_LOG_SOURCE:          BONUS_LOG_SOURCE,
};
