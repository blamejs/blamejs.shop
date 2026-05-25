"use strict";
/**
 * @module shop.customerRiskProfile
 * @title  Customer risk profile — long-running per-customer signal
 *         aggregation that qualifies B2B credit, gates VIP perks, and
 *         flags accounts for hand-review.
 *
 * @intro
 *   Distinct from `fraudScreen` (migration 0038) which scores a single
 *   order draft pre-payment. The risk profile is the long-term picture
 *   built from observed bad signals over time:
 *
 *     - chargeback              (severe: a card-network reversal landed)
 *     - chargeback_dispute_lost (severe: representment came back against us)
 *     - fraud_score_high        (per-order fraudScreen scored above the step-up threshold)
 *     - refund_request          (a refund was requested, not necessarily fraud)
 *     - refund_to_credit        (refund issued as store credit instead of cash — refund-policy verdict)
 *     - late_payment            (B2B credit account paid past payment_terms_days)
 *     - address_mismatch        (order's shipping country differed from billing country)
 *     - device_diversity_high   (this account has logged in from an unusually wide device fingerprint set)
 *
 *   `severity` is operator-chosen on a 1..10 scale per signal — the
 *   integrator picks a calibration that fits their risk appetite. The
 *   recent-window default is 90 days: `risk_score` is the sum of
 *   severities of non-cleared signals occurring in the last 90 days.
 *   Lifetime counts are tracked too but don't feed the score (a
 *   5-year-old chargeback shouldn't keep a recovered customer at
 *   `critical` forever).
 *
 *   Risk bands (closed intervals on score):
 *
 *     0   .. 9    → low
 *     10  .. 24   → moderate
 *     25  .. 49   → high
 *     50+         → critical
 *
 *   The thresholds are exposed on `customerRiskProfile.BANDS` so the
 *   integrator's dashboard and the test suite assert against the same
 *   numbers the runtime uses.
 *
 *   Composition surface:
 *
 *     var risk = bShop.customerRiskProfile.create({ query: q });
 *     await risk.recordSignal({
 *       customer_id: cid,
 *       kind:        "chargeback",
 *       severity:    10,
 *       detail_json: { order_id: oid, amount_minor: 12500 },
 *     });
 *     var prof = await risk.getProfile(cid);
 *     // { customer_id, risk_score, risk_band, recent_signals, lifetime_signals }
 *
 *   The summary table is denormalized: `recordSignal` updates the
 *   summary row in lockstep so getProfile + tier + topRiskCustomers
 *   all answer from a single-row read. `recompute({ customer_id })`
 *   re-derives the summary from the signal log when an operator
 *   clears a signal or the integrator wants to age out signals past
 *   the recent-window boundary. `recomputeAll({ since })` walks every
 *   customer whose summary's `recomputed_at` is older than the cutoff
 *   so the dashboard's pre-rendered ordering doesn't drift.
 *
 *   `clearSignal({ signal_id, reason, cleared_by })` is the operator-
 *   override entry point for false positives — sets cleared_at +
 *   cleared_by + cleared_reason, then recomputes the affected
 *   customer's summary so the band/score reflects the clearing
 *   immediately. Re-clearing an already-cleared signal refuses.
 *
 *   Monotonic per-customer `occurred_at`: two writes against the same
 *   customer in the same millisecond would tie on `occurred_at` and
 *   make the "latest signal" read ambiguous in the `(customer_id,
 *   occurred_at DESC)` index. `_resolveOccurredAt` bumps the requested
 *   timestamp to `prior + 1` on collision, guaranteeing strict
 *   monotonicity (same discipline as credit_transactions).
 *
 *   Surface:
 *     - recordSignal({ customer_id, kind, severity, detail_json?, occurred_at? })
 *     - getProfile(customer_id)
 *     - tier(customer_id)
 *     - historyForCustomer(customer_id)
 *     - recompute({ customer_id })
 *     - recomputeAll({ since })
 *     - topRiskCustomers({ limit, band? })
 *     - clearSignal({ signal_id, reason, cleared_by })
 *
 *   Storage:
 *     - customer_risk_signals    (migration 0142)
 *     - customer_risk_summaries  (migration 0142)
 *
 *   Optional handles (all injectable on create()):
 *     - query         — D1-shaped async query function (required)
 *     - fraudScreen   — used by callers to translate per-order
 *                       fraudScreen verdicts into recordSignal calls;
 *                       the primitive itself never reaches in
 *     - returns       — caller correlator for refund_request signals
 *     - dunning       — caller correlator for late_payment signals
 *     - creditLimits  — caller correlator for late_payment signals
 *
 *   The optional handles are stored for callers that compose this
 *   primitive with the upstream sources; this primitive does not call
 *   into them. Recording a signal is a single explicit operator
 *   action, never an implicit cross-primitive side effect.
 *
 * @primitive customerRiskProfile
 * @related   b.uuid.v7, b.guardUuid, shop.fraudScreen, shop.creditLimits, shop.dunning, shop.returns
 */

var b = require("./index").framework;
var C = b.constants;

// ---- constants ----------------------------------------------------------

var KINDS = [
  "chargeback",
  "refund_request",
  "fraud_score_high",
  "chargeback_dispute_lost",
  "late_payment",
  "address_mismatch",
  "device_diversity_high",
  "refund_to_credit",
];

var BAND_NAMES = ["low", "moderate", "high", "critical"];

// Closed intervals on risk_score. Score 0..9 → low, 10..24 → moderate,
// 25..49 → high, 50+ → critical. Exposed so the test suite + the
// dashboard renderer pull the same numbers the runtime uses.
var BANDS = Object.freeze({
  LOW_MAX:      9,
  MODERATE_MAX: 24,
  HIGH_MAX:     49,
});

// Recent-window — signals older than this don't contribute to the
// score (their lifetime count still reflects them). 90 days matches
// the typical card-network chargeback-evidence cycle: anything older
// has already gone through dispute and is settled.
var RECENT_WINDOW_MS = C.TIME.days(90);

// detail_json byte ceiling. Operators routinely embed order ids,
// amounts, a few human-readable notes — 8 KiB after JSON-encoding
// leaves room for that without becoming a payload-smuggling channel.
var MAX_DETAIL_JSON_BYTES = 8192;

// Plain-text refuses control bytes on the short fields. cleared_by /
// cleared_reason are short correlation strings — log-injection bytes
// have no place in a one-line column.
var MAX_REF_LEN  = 128;
var PRINTABLE_RE = /^[^\x00-\x1f\x7f]*$/;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customerRiskProfile: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("customerRiskProfile: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _severity(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
    throw new TypeError("customerRiskProfile: severity must be an integer in [1, 10]");
  }
  return n;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("customerRiskProfile: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}

function _band(s) {
  if (typeof s !== "string" || BAND_NAMES.indexOf(s) === -1) {
    throw new TypeError("customerRiskProfile: band must be one of " + BAND_NAMES.join(", "));
  }
  return s;
}

function _ref(s, label, required) {
  if (s == null) {
    if (required) {
      throw new TypeError("customerRiskProfile: " + label + " is required");
    }
    return null;
  }
  if (typeof s !== "string") {
    throw new TypeError("customerRiskProfile: " + label + " must be a string");
  }
  if (!s.length) {
    throw new TypeError("customerRiskProfile: " + label + " must be a non-empty string when provided");
  }
  if (s.length > MAX_REF_LEN) {
    throw new TypeError("customerRiskProfile: " + label + " must be <= " + MAX_REF_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("customerRiskProfile: " + label + " must not contain control bytes");
  }
  return s;
}

function _detailJson(v) {
  if (v == null) return null;
  if (typeof v !== "object") {
    throw new TypeError("customerRiskProfile: detail_json must be a plain object when provided");
  }
  var encoded;
  try { encoded = JSON.stringify(v); }
  catch (_e) { throw new TypeError("customerRiskProfile: detail_json must be JSON-serializable"); }
  if (encoded == null) {
    throw new TypeError("customerRiskProfile: detail_json must be JSON-serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_DETAIL_JSON_BYTES) {
    throw new TypeError("customerRiskProfile: detail_json must be <= " + MAX_DETAIL_JSON_BYTES + " bytes when JSON-encoded");
  }
  return encoded;
}

function _positiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("customerRiskProfile: " + label + " must be a positive integer");
  }
  return n;
}

function _now() { return Date.now(); }

function _bandFor(score) {
  if (score <= BANDS.LOW_MAX)      return "low";
  if (score <= BANDS.MODERATE_MAX) return "moderate";
  if (score <= BANDS.HIGH_MAX)     return "high";
  return "critical";
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional caller-correlator handles. Stored so an integrator can
  // recover them from the instance for orchestration; not consumed
  // by this primitive directly. Recording a signal is always an
  // explicit operator call, never an implicit cross-primitive
  // side effect — that's how the test suite isolates each signal
  // source and the dashboard can show the audit trail.
  var fraudScreen  = opts.fraudScreen  || null;
  var returns      = opts.returns      || null;
  var dunning      = opts.dunning      || null;
  var creditLimits = opts.creditLimits || null;

  async function _readLatestSignalTs(customerId) {
    var r = await query(
      "SELECT occurred_at FROM customer_risk_signals " +
      "WHERE customer_id = ?1 ORDER BY occurred_at DESC LIMIT 1",
      [customerId],
    );
    return r.rows.length ? r.rows[0].occurred_at : null;
  }

  // Same monotonic-clock discipline as credit_transactions: two
  // writes against the same customer in the same millisecond would
  // tie on `occurred_at` and corrupt the `(customer_id, occurred_at
  // DESC)` index ordering. Bump the second write to `prior + 1`.
  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _readSummary(customerId) {
    var r = await query(
      "SELECT customer_id, risk_score, risk_band, lifetime_signal_count, recent_signal_count, recomputed_at " +
      "FROM customer_risk_summaries WHERE customer_id = ?1 LIMIT 1",
      [customerId],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  // Recompute the denormalized summary row for one customer from the
  // signal log. Pulls every non-cleared signal, partitions into
  // recent-window (contributes to risk_score) vs older (lifetime
  // count only), and upserts the summary row. Returns the fresh
  // summary shape so callers don't re-read.
  async function _recomputeOne(customerId, now) {
    var cutoff = now - RECENT_WINDOW_MS;

    var r = await query(
      "SELECT severity, occurred_at FROM customer_risk_signals " +
      "WHERE customer_id = ?1 AND cleared_at IS NULL",
      [customerId],
    );

    var lifetimeCount = r.rows.length;
    var recentCount   = 0;
    var score         = 0;
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      if (row.occurred_at >= cutoff) {
        recentCount += 1;
        score       += row.severity;
      }
    }
    var band = _bandFor(score);

    var existing = await _readSummary(customerId);
    if (existing) {
      await query(
        "UPDATE customer_risk_summaries SET risk_score = ?1, risk_band = ?2, " +
        "lifetime_signal_count = ?3, recent_signal_count = ?4, recomputed_at = ?5 " +
        "WHERE customer_id = ?6",
        [score, band, lifetimeCount, recentCount, now, customerId],
      );
    } else {
      await query(
        "INSERT INTO customer_risk_summaries " +
        "(customer_id, risk_score, risk_band, lifetime_signal_count, recent_signal_count, recomputed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [customerId, score, band, lifetimeCount, recentCount, now],
      );
    }
    return {
      customer_id:           customerId,
      risk_score:            score,
      risk_band:             band,
      lifetime_signal_count: lifetimeCount,
      recent_signal_count:   recentCount,
      recomputed_at:         now,
    };
  }

  return {
    KINDS:       KINDS.slice(),
    BAND_NAMES:  BAND_NAMES.slice(),
    BANDS:       { LOW_MAX: BANDS.LOW_MAX, MODERATE_MAX: BANDS.MODERATE_MAX, HIGH_MAX: BANDS.HIGH_MAX },
    RECENT_WINDOW_MS: RECENT_WINDOW_MS,

    // Stored optional handles — exposed read-only so an integrator
    // can recover them off the instance for cross-primitive
    // orchestration. The primitive itself never reaches in.
    handles: {
      fraudScreen:  fraudScreen,
      returns:      returns,
      dunning:      dunning,
      creditLimits: creditLimits,
    },

    recordSignal: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerRiskProfile.recordSignal: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var kind       = _kind(input.kind);
      var severity   = _severity(input.severity);
      var detail     = _detailJson(input.detail_json);
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatestSignalTs(customerId);
      var ts     = _resolveOccurredAt(requested, latest);

      var id = b.uuid.v7();
      await query(
        "INSERT INTO customer_risk_signals " +
        "(id, customer_id, kind, severity, detail_json, occurred_at, cleared_at, cleared_by, cleared_reason) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL)",
        [id, customerId, kind, severity, detail, ts],
      );

      // Refresh the denormalized summary in lockstep so getProfile /
      // tier / topRiskCustomers answer from a single-row read on the
      // hot path.
      var summary = await _recomputeOne(customerId, _now());

      return {
        id:           id,
        customer_id:  customerId,
        kind:         kind,
        severity:     severity,
        detail_json:  detail,
        occurred_at:  ts,
        risk_score:   summary.risk_score,
        risk_band:    summary.risk_band,
      };
    },

    getProfile: async function (customerId) {
      _uuid(customerId, "customer_id");
      var summary = await _readSummary(customerId);
      if (!summary) {
        // Customer never had a signal — return the conservative
        // shape so the dashboard can render "no signals on file" the
        // same way as "we recomputed and there's nothing." `risk_band`
        // is `low` because score 0 lands in the low band; the
        // bucketization is the same function the runtime uses
        // elsewhere.
        return {
          customer_id:           customerId,
          risk_score:            0,
          risk_band:             "low",
          lifetime_signal_count: 0,
          recent_signal_count:   0,
          recomputed_at:         null,
        };
      }
      return {
        customer_id:           summary.customer_id,
        risk_score:            summary.risk_score,
        risk_band:             summary.risk_band,
        lifetime_signal_count: summary.lifetime_signal_count,
        recent_signal_count:   summary.recent_signal_count,
        recomputed_at:         summary.recomputed_at,
      };
    },

    tier: async function (customerId) {
      _uuid(customerId, "customer_id");
      var summary = await _readSummary(customerId);
      if (!summary) return "low";
      return summary.risk_band;
    },

    historyForCustomer: async function (customerId) {
      _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT id, customer_id, kind, severity, detail_json, occurred_at, " +
        "cleared_at, cleared_by, cleared_reason " +
        "FROM customer_risk_signals WHERE customer_id = ?1 ORDER BY occurred_at DESC",
        [customerId],
      );
      return r.rows.map(function (row) {
        return {
          id:             row.id,
          customer_id:    row.customer_id,
          kind:           row.kind,
          severity:       row.severity,
          detail_json:    row.detail_json == null ? null : JSON.parse(row.detail_json),
          occurred_at:    row.occurred_at,
          cleared_at:     row.cleared_at,
          cleared_by:     row.cleared_by,
          cleared_reason: row.cleared_reason,
        };
      });
    },

    recompute: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerRiskProfile.recompute: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      return _recomputeOne(customerId, _now());
    },

    // Refresh every summary whose `recomputed_at` is older than the
    // operator-supplied cutoff. The integrator wires this on a cron
    // so signals naturally age out of the recent-window as wall-clock
    // advances — without the cron, a customer with a 90-day-old
    // chargeback would keep showing the same score until a fresh
    // signal forced a recompute.
    recomputeAll: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerRiskProfile.recomputeAll: input object required");
      }
      var since = _epochMs(input.since, "since");
      if (since == null) {
        throw new TypeError("customerRiskProfile.recomputeAll: since is required");
      }
      // Pick up every customer with EITHER a stale summary OR a
      // signal recorded since the cutoff. The union ensures a
      // never-summarized customer who's accumulated signals also
      // surfaces — recomputeAll is the integrator's "reconcile
      // everything observable" entry point.
      var r = await query(
        "SELECT DISTINCT customer_id FROM customer_risk_summaries WHERE recomputed_at < ?1 " +
        "UNION " +
        "SELECT DISTINCT customer_id FROM customer_risk_signals WHERE occurred_at >= ?1",
        [since],
      );
      var now      = _now();
      var refreshed = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var customerId = r.rows[i].customer_id;
        var summary    = await _recomputeOne(customerId, now);
        refreshed.push(summary);
      }
      return { recomputed_count: refreshed.length, recomputed_at: now };
    },

    topRiskCustomers: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerRiskProfile.topRiskCustomers: input object required");
      }
      var limit = _positiveInt(input.limit, "limit");
      var band  = null;
      if (input.band != null) band = _band(input.band);

      var sql = "SELECT customer_id, risk_score, risk_band, lifetime_signal_count, recent_signal_count, recomputed_at " +
                "FROM customer_risk_summaries";
      var params = [];
      if (band != null) {
        sql += " WHERE risk_band = ?1";
        params.push(band);
      }
      sql += " ORDER BY risk_score DESC, customer_id ASC";
      // SQLite parameter slot for LIMIT — use a fresh slot index so
      // the predicate parameter (if present) doesn't collide.
      sql += " LIMIT ?" + (params.length + 1);
      params.push(limit);

      var r = await query(sql, params);
      return r.rows;
    },

    clearSignal: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerRiskProfile.clearSignal: input object required");
      }
      var signalId   = _uuid(input.signal_id, "signal_id");
      var reason     = _ref(input.reason, "reason", true);
      var clearedBy  = _ref(input.cleared_by, "cleared_by", true);

      var r = await query(
        "SELECT id, customer_id, cleared_at FROM customer_risk_signals WHERE id = ?1 LIMIT 1",
        [signalId],
      );
      if (!r.rows.length) {
        var notFound = new Error("customerRiskProfile.clearSignal: signal " + JSON.stringify(signalId) + " not found");
        notFound.code = "RISK_SIGNAL_NOT_FOUND";
        throw notFound;
      }
      var row = r.rows[0];
      if (row.cleared_at != null) {
        var already = new Error("customerRiskProfile.clearSignal: signal " + JSON.stringify(signalId) + " already cleared");
        already.code = "RISK_SIGNAL_ALREADY_CLEARED";
        throw already;
      }

      var now = _now();
      await query(
        "UPDATE customer_risk_signals SET cleared_at = ?1, cleared_by = ?2, cleared_reason = ?3 " +
        "WHERE id = ?4",
        [now, clearedBy, reason, signalId],
      );

      // Cleared signals drop their contribution to the score
      // immediately — recompute the affected customer's summary so
      // the band/score reflect the clearing on the next dashboard
      // read without waiting for a recomputeAll cron tick.
      var summary = await _recomputeOne(row.customer_id, now);

      return {
        signal_id:      signalId,
        customer_id:    row.customer_id,
        cleared_at:     now,
        cleared_by:     clearedBy,
        cleared_reason: reason,
        risk_score:     summary.risk_score,
        risk_band:      summary.risk_band,
      };
    },
  };
}

module.exports = {
  create:           create,
  KINDS:            KINDS,
  BAND_NAMES:       BAND_NAMES,
  BANDS:            BANDS,
  RECENT_WINDOW_MS: RECENT_WINDOW_MS,
};
