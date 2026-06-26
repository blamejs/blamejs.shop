"use strict";
/**
 * @module shop.loyalty
 * @title  Loyalty primitive — customer points balance + tier system
 *
 * @intro
 *   Tracks a running points balance and a never-decremented lifetime
 *   total per customer. The lifetime total drives tier placement
 *   (bronze / silver / gold / platinum) against operator-tunable
 *   thresholds. Every state mutation lands as a row in the
 *   `loyalty_transactions` audit trail with an operator-supplied
 *   `source` string and an optional `order_id` link.
 *
 *   Composition:
 *     var loy = bShop.loyalty.create({ query: q });
 *     await loy.ensureAccount(customerId);
 *     var earn = await loy.earn({
 *       customer_id: customerId,
 *       points:      120,
 *       source:      "order-paid",
 *       order_id:    orderId,
 *     });
 *     // earn.tier_changed is true on a tier promotion crossing
 *     // (e.g. lifetime 499 -> 500 silver).
 *
 *   Conversion ratios are operator-tunable but ship with sensible
 *   defaults: 1 USD spent = 10 points earned, 100 points = $1 in
 *   redemption value. The primitive exposes the ratios on the
 *   returned object so callers compose order subtotals and
 *   redemption-cap calculations without re-deriving the constants.
 *
 *   Tier computation is monotonic in lifetime points — a tier
 *   downgrade can only happen via `expire` on the lifetime total,
 *   which `expire` does NOT do by default (expiry decrements balance
 *   only). Operators that want lifetime-tier sunset semantics use
 *   `tier_expires_at` and a separate scheduled job to recompute.
 *
 *   Surface:
 *     - ensureAccount(customer_id)
 *     - earn({ customer_id, points, source, order_id?, notes? })
 *     - redeem({ customer_id, points, order_id?, notes? })
 *     - adjust({ customer_id, points, source, notes? })
 *     - expire({ customer_id, points, reason })
 *     - balance(customer_id)
 *     - history(customer_id, { limit?, cursor? })
 *     - tierLeaderboard({ tier?, limit? })
 *     - computeTier(lifetime_points)
 *
 *   Storage:
 *     - loyalty_accounts, loyalty_transactions (migration 0022).
 *
 * @primitive loyalty
 * @related   b.uuid.v7, b.guardUuid
 */

var b = require("./vendor/blamejs");

var TIERS = ["bronze", "silver", "gold", "platinum"];
var TX_TYPES = ["earn", "redeem", "expire", "adjust", "tier-bonus"];

var DEFAULT_TIER_THRESHOLDS = {
  bronze:   0,
  silver:   500,
  gold:     2000,
  platinum: 10000,
};

// Conversion ratios — operator-tunable via `create({...})`. The
// defaults match the spec: 1 USD spent earns 10 points; 100 points
// redeem for $1 in storefront credit. Held in whole-number minor units
// at the call site to avoid floating-point creep.
var DEFAULT_POINTS_PER_USD          = 10;
var DEFAULT_REDEMPTION_POINTS_PER_USD = 100;

var MAX_SOURCE_LEN = 64;
var SOURCE_RE      = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;
var MAX_NOTES_LEN  = 512;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("loyalty: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _positiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("loyalty: " + label + " must be a positive integer");
  }
  return n;
}

function _signedInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n === 0) {
    throw new TypeError("loyalty: " + label + " must be a non-zero integer");
  }
  return n;
}

function _source(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("loyalty: source must be a non-empty string");
  }
  var clean = s.toLowerCase().trim();
  if (clean.length > MAX_SOURCE_LEN) {
    throw new TypeError("loyalty: source must be <= " + MAX_SOURCE_LEN + " chars");
  }
  if (!SOURCE_RE.test(clean)) {
    throw new TypeError("loyalty: source must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/");
  }
  return clean;
}

function _notes(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string") {
    throw new TypeError("loyalty: notes must be a string");
  }
  if (s.length > MAX_NOTES_LEN) {
    throw new TypeError("loyalty: notes must be <= " + MAX_NOTES_LEN + " chars");
  }
  // Refuse control bytes outside HT/LF/CR — keep operator-facing
  // strings printable without losing newline-as-separator in long
  // free-form notes.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("loyalty: notes must not contain control bytes");
  }
  return s;
}

function _validateThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== "object") {
    throw new TypeError("loyalty: tierThresholds must be an object");
  }
  for (var i = 0; i < TIERS.length; i += 1) {
    var t = TIERS[i];
    var v = thresholds[t];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new TypeError("loyalty: tierThresholds." + t + " must be a non-negative integer");
    }
  }
  if (thresholds.bronze !== 0) {
    throw new TypeError("loyalty: tierThresholds.bronze must be 0 (base tier)");
  }
  // Thresholds must be strictly monotonically increasing — otherwise
  // computeTier becomes ambiguous (two tiers crossing at the same
  // lifetime point would silently prefer the later one).
  if (!(thresholds.silver > thresholds.bronze
        && thresholds.gold > thresholds.silver
        && thresholds.platinum > thresholds.gold)) {
    throw new TypeError("loyalty: tierThresholds must be strictly increasing bronze < silver < gold < platinum");
  }
}

function _now() { return Date.now(); }

// ---- chain hashing ------------------------------------------------------
//
// loyalty_transactions is a per-customer running-balance hash chain (the
// gift-card-ledger / store-credit-ledger model). Each mutating row carries the
// running balance_after_points + lifetime_after_points + tier_after, written by
// the SAME guarded INSERT that records the event, so the balance change and the
// audit row are one write — the stored-column two-statement window (and the
// double-credit-on-revert hazard it forced) is structurally gone. A SHA3-512
// chain (prev_hash + row_hash, fenced by UNIQUE(customer_id, prev_hash)) makes
// the running snapshot tamper-evident and serializes concurrent writers.
//
//   row_hash = SHA3-512(prev_hash || canonical-json(row-fields))
//
// order_id and restored_points are EXCLUDED from the hashed fields: both are
// mutated AFTER the row is inserted (linkRedemptionToOrder stamps order_id;
// reverse/restore advance restored_points), so hashing them would report a
// false tamper on every linked redemption and every restore.
var SHA3_512_HEX_LEN = 128;
var ZERO_HASH = "0".repeat(SHA3_512_HEX_LEN);

function _rowFieldsForHash(row) {
  return {
    id:                    row.id,
    customer_id:           row.customer_id,
    transaction_type:      row.transaction_type,
    points:                Number(row.points),
    source:                row.source == null ? null : row.source,
    notes:                 row.notes == null ? null : row.notes,
    balance_after_points:  Number(row.balance_after_points),
    lifetime_after_points: Number(row.lifetime_after_points),
    tier_after:            row.tier_after,
    occurred_at:           Number(row.occurred_at),
    // order_id + restored_points EXCLUDED — both mutated post-insert.
  };
}

function _computeRowHash(prevHash, rowFields) {
  var canonical = b.auditChain.canonicalize(rowFields, ["prev_hash", "row_hash"]);
  var preimage  = Buffer.concat([
    Buffer.from(prevHash, "hex"),
    Buffer.from(canonical, "utf8"),
  ]);
  return b.crypto.sha3Hash(preimage);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var thresholds = opts.tierThresholds
    ? { bronze: opts.tierThresholds.bronze, silver: opts.tierThresholds.silver,
        gold: opts.tierThresholds.gold, platinum: opts.tierThresholds.platinum }
    : { bronze: DEFAULT_TIER_THRESHOLDS.bronze, silver: DEFAULT_TIER_THRESHOLDS.silver,
        gold: DEFAULT_TIER_THRESHOLDS.gold, platinum: DEFAULT_TIER_THRESHOLDS.platinum };
  _validateThresholds(thresholds);

  var pointsPerUsd = opts.pointsPerUsd != null ? opts.pointsPerUsd : DEFAULT_POINTS_PER_USD;
  if (typeof pointsPerUsd !== "number" || !Number.isInteger(pointsPerUsd) || pointsPerUsd <= 0) {
    throw new TypeError("loyalty: pointsPerUsd must be a positive integer");
  }
  var redemptionPointsPerUsd = opts.redemptionPointsPerUsd != null
    ? opts.redemptionPointsPerUsd : DEFAULT_REDEMPTION_POINTS_PER_USD;
  if (typeof redemptionPointsPerUsd !== "number" || !Number.isInteger(redemptionPointsPerUsd) || redemptionPointsPerUsd <= 0) {
    throw new TypeError("loyalty: redemptionPointsPerUsd must be a positive integer");
  }

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Pure helper — exposed on the API as `.computeTier` for callers
  // who want to preview a tier without writing an account row. Walks
  // the tier list from highest-threshold down so a lifetime total
  // sitting at exactly the platinum threshold lands on platinum, not
  // gold. (The threshold is inclusive on the upgrade side.)
  function computeTier(lifetime) {
    if (typeof lifetime !== "number" || !Number.isInteger(lifetime) || lifetime < 0) {
      throw new TypeError("loyalty.computeTier: lifetime must be a non-negative integer");
    }
    if (lifetime >= thresholds.platinum) return "platinum";
    if (lifetime >= thresholds.gold)     return "gold";
    if (lifetime >= thresholds.silver)   return "silver";
    return "bronze";
  }

  async function _readAccount(customerId) {
    var r = await query(
      "SELECT customer_id, balance_points, lifetime_points, tier, tier_expires_at, created_at, updated_at " +
      "FROM loyalty_accounts WHERE customer_id = ?1",
      [customerId],
    );
    return r.rows[0] || null;
  }

  async function _ensureAccountRow(customerId, ts) {
    // INSERT OR IGNORE is idempotent — repeated calls land a single
    // row. We don't bump `updated_at` on the existing-row path; the
    // operator's intent is "make sure this exists", not "touch this".
    await query(
      "INSERT OR IGNORE INTO loyalty_accounts " +
      "(customer_id, balance_points, lifetime_points, tier, tier_expires_at, created_at, updated_at) " +
      "VALUES (?1, 0, 0, 'bronze', NULL, ?2, ?2)",
      [customerId, ts],
    );
  }

  // O(1) chain-tip read: the latest row by (customer_id, occurred_at DESC,
  // id DESC) carries the running balance/lifetime/tier snapshot AFTER it.
  // No SUM at read time. Falls through to a bronze zero-tip when the customer
  // has no rows (a brand-new account anchors its chain from ZERO on the first
  // write). A legacy/genesis NULL row_hash coerces to ZERO_HASH so the first
  // hashed row anchors the chain (the lazy genesis anchor).
  async function _readLatest(customerId) {
    var r = await query(
      "SELECT id, balance_after_points, lifetime_after_points, tier_after, occurred_at, row_hash " +
      "FROM loyalty_transactions WHERE customer_id = ?1 " +
      "ORDER BY occurred_at DESC, id DESC LIMIT 1",
      [customerId],
    );
    if (!r.rows.length) {
      return { id: null, balance: 0, lifetime: 0, tier: "bronze",
               occurred_at: null, row_hash: ZERO_HASH };
    }
    var row = r.rows[0];
    return {
      id:          row.id,
      balance:     Number(row.balance_after_points),
      lifetime:    Number(row.lifetime_after_points),
      tier:        row.tier_after,
      occurred_at: Number(row.occurred_at),
      row_hash:    row.row_hash == null ? ZERO_HASH : row.row_hash,
    };
  }

  // Strict-monotonic per-customer occurred_at: two writes in the same ms (or a
  // backdated write) would tie and make the tip ambiguous, so a colliding
  // timestamp bumps to prior + 1. Non-colliding (future) timestamps land as
  // requested.
  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  // Re-derive the tip this many times when the chain-parent fence refuses an
  // INSERT (a concurrent write claimed the slot). Each fence round lets exactly
  // one racing writer win, so the cap is sized well beyond realistic same-
  // customer fan-in; a genuine non-collision insert error re-throws on attempt
  // one (the tip is unchanged), so a high cap never spins on a real failure.
  var CHAIN_WRITE_ATTEMPTS = 64;

  // One fenced write attempt off a freshly-read tip. Every event kind writes
  // through here so every row joins the per-customer chain. The chain-parent
  // fence (UNIQUE(customer_id, prev_hash)) makes the app-computed prev_hash /
  // row_hash safe: a row derived from a stale tip collides instead of forking
  // the chain or persisting a stale balance_after. The overdraft / underflow
  // gate stays INSIDE the statement (correlated subquery against the live tip,
  // never an app-side check) so a refusal is a zero-row no-op. Returns one of
  // { written }, { refused } (guard said no), { collided } (tip moved — retry).
  async function _attemptChainedWrite(customerId, d) {
    var id = b.uuid.v7();
    var rowHash = _computeRowHash(d.prevHash, {
      id:                    id,
      customer_id:           customerId,
      transaction_type:      d.type,
      points:                d.points,
      source:                d.source,
      notes:                 d.notes,
      balance_after_points:  d.balanceAfter,
      lifetime_after_points: d.lifetimeAfter,
      tier_after:            d.tierAfter,
      occurred_at:           d.ts,
    });
    var balSub =
      "COALESCE((SELECT balance_after_points FROM loyalty_transactions " +
      "WHERE customer_id = ?2 ORDER BY occurred_at DESC, id DESC LIMIT 1), 0)";
    try {
      var res = await query(
        "INSERT INTO loyalty_transactions " +
        "(id, customer_id, transaction_type, points, source, order_id, notes, occurred_at, " +
        "balance_after_points, lifetime_after_points, tier_after, prev_hash, row_hash) " +
        "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13 " +
        "WHERE " + (d.guard ? d.guard.replace(/__BAL__/g, balSub) : "1"),
        [id, customerId, d.type, d.points, d.source, d.orderId, d.notes, d.ts,
          d.balanceAfter, d.lifetimeAfter, d.tierAfter, d.prevHash, rowHash],
      );
      if (Number(res.rowCount || 0) === 0) return { refused: true };
      return { written: { id: id, points: d.points, balance: d.balanceAfter,
                          lifetime: d.lifetimeAfter, tier: d.tierAfter, occurred_at: d.ts } };
    } catch (e) {
      // State-agnostic collision detection — never error-message matching (the
      // prod D1 bridge redacts the SQLite UNIQUE text to a generic HTTP 500).
      // If the tip advanced past the parent we tried to chain off, a competing
      // write claimed our slot — retry; otherwise the insert failed for another
      // reason — re-throw.
      var after = await _readLatest(customerId);
      if (after.row_hash !== d.prevHash) return { collided: true };
      throw e;
    }
  }

  // Run a chained write with bounded tip-contention retries. `derive(tip)` maps
  // the freshly-read tip to the concrete row fields; each fence collision
  // re-reads + re-derives so the values that land are always consistent with
  // the parent they chain off. Returns the written row, or { refused: true }
  // when the in-statement guard rejected it against the live tip.
  async function _writeChained(customerId, derive) {
    for (var attempt = 0; attempt < CHAIN_WRITE_ATTEMPTS; attempt += 1) {
      var latest = await _readLatest(customerId);
      var d = derive(latest);
      d.prevHash = latest.row_hash;
      var r = await _attemptChainedWrite(customerId, d);
      if (r.collided) continue;
      if (r.refused) return { refused: true };
      return r.written;
    }
    var contention = new Error("loyalty: persistent chain-tip contention — retry the write");
    contention.code = "LOYALTY_CONTENTION";
    throw contention;
  }

  // Best-effort refresh of the loyalty_accounts mirror from a freshly-written
  // tip. The mirror is NOT authoritative and NOT on any mutation's decision
  // path — balance() and every guard read the chain tip; the mirror exists only
  // for the cross-customer tierLeaderboard and the operator tier_expires_at
  // time-bound. Runs OUTSIDE the atomicity boundary: a crash here leaves money
  // exactly-once correct and the next advancing write re-syncs it.
  async function _refreshMirror(customerId, w, ts) {
    await query(
      "UPDATE loyalty_accounts SET balance_points = ?1, lifetime_points = ?2, " +
      "tier = ?3, updated_at = ?4 WHERE customer_id = ?5",
      [w.balance, w.lifetime, w.tier, ts, customerId],
    );
  }

  return {
    TIERS:                  TIERS.slice(),
    TX_TYPES:               TX_TYPES.slice(),
    TIER_THRESHOLDS:        { bronze: thresholds.bronze, silver: thresholds.silver,
                              gold: thresholds.gold, platinum: thresholds.platinum },
    POINTS_PER_USD:         pointsPerUsd,
    REDEMPTION_POINTS_PER_USD: redemptionPointsPerUsd,

    computeTier: computeTier,

    ensureAccount: async function (customerId) {
      _uuid(customerId, "customer_id");
      var ts = _now();
      var before = await _readAccount(customerId);
      if (before) return { created: false, account: before };
      await _ensureAccountRow(customerId, ts);
      var after = await _readAccount(customerId);
      return { created: true, account: after };
    },

    earn: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("loyalty.earn: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var points     = _positiveInt(input.points, "points");
      var source     = _source(input.source);
      var orderId    = input.order_id != null ? _uuid(input.order_id, "order_id") : null;
      var notes      = _notes(input.notes);

      var requested = _now();
      await _ensureAccountRow(customerId, requested);
      // Balance + lifetime + tier all ride the SAME guarded chained INSERT off
      // the freshly-read tip — there is no stored-column second statement to
      // lose. earn advances lifetime and recomputes the tier off the new
      // lifetime; `tier_changed` compares the chain's before/after tiers (both
      // from the tip, no separate snapshot read).
      var tierBefore;
      var w = await _writeChained(customerId, function (latest) {
        tierBefore = latest.tier;
        var lifeAfter = latest.lifetime + points;
        return {
          type: "earn", points: points, source: source, orderId: orderId, notes: notes,
          balanceAfter:  latest.balance + points,
          lifetimeAfter: lifeAfter,
          tierAfter:     computeTier(lifeAfter),
          ts:            _resolveOccurredAt(requested, latest.occurred_at),
        };
      });
      await _refreshMirror(customerId, w, requested);
      return {
        balance:      w.balance,
        lifetime:     w.lifetime,
        tier:         w.tier,
        tier_changed: w.tier !== tierBefore,
      };
    },

    redeem: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("loyalty.redeem: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var points     = _positiveInt(input.points, "points");
      var orderId    = input.order_id != null ? _uuid(input.order_id, "order_id") : null;
      var notes      = _notes(input.notes);

      var requested = _now();
      await _ensureAccountRow(customerId, requested);
      // The overdraft refusal lives INSIDE the guarded INSERT (balSub + points
      // >= 0, where points is the negative burn delta) — never an app-side
      // pre-check — so two concurrent redemptions can't double-spend off a
      // stale snapshot: the chain-parent fence serializes them and the loser
      // re-reads the winner's smaller balance and is refused. Lifetime is not
      // affected; redemption spends from the running balance only.
      var w = await _writeChained(customerId, function (latest) {
        return {
          type: "redeem", points: -points, source: "redeem", orderId: orderId, notes: notes,
          balanceAfter:  latest.balance - points,
          lifetimeAfter: latest.lifetime,
          tierAfter:     latest.tier,
          ts:            _resolveOccurredAt(requested, latest.occurred_at),
          guard:         "__BAL__ + ?4 >= 0",
        };
      });
      if (w.refused) {
        var ins = new Error("loyalty.redeem: insufficient balance");
        ins.code = "LOYALTY_INSUFFICIENT_BALANCE";
        throw ins;
      }
      await _refreshMirror(customerId, w, requested);
      var acct = await _readAccount(customerId);
      return {
        balance:         w.balance,
        lifetime:        w.lifetime,
        tier:            w.tier,
        tier_expires_at: acct ? acct.tier_expires_at : null,
        // Ledger row id of this burn — checkout debits points BEFORE its order
        // exists (the debit is the double-spend gate) and links the row to the
        // order afterwards via linkRedemptionToOrder, or compensates via
        // reverseRedemptionById when the checkout dies before the order exists.
        tx_id:           w.id,
      };
    },

    // Attach a redeem ledger row that was debited BEFORE its order existed
    // to the order it tendered for. The order link is what
    // restoreRedemption keys on — an unlinked burn is invisible to the
    // refund restore. Write-once: only a NULL order_id redeem row accepts a
    // link, so a re-fire never re-keys a settled burn. Returns true when
    // the link landed.
    linkRedemptionToOrder: async function (txId, orderId) {
      var tid = _uuid(txId, "tx_id");
      var oid = _uuid(orderId, "order_id");
      var res = await query(
        "UPDATE loyalty_transactions SET order_id = ?1 " +
        "WHERE id = ?2 AND transaction_type = 'redeem' AND order_id IS NULL",
        [oid, tid],
      );
      return b.sql.casWon(res).won;
    },

    // Reverse ONE redeem burn by its ledger row id — the compensation edge
    // for a pre-charge debit whose checkout failed before the order existed
    // (PaymentIntent refused, order insert threw). restoreRedemption can't
    // reach these rows: it keys on order_id, still NULL at that point. The
    // claim rides the same restored_points column the refund restore uses —
    // advancing it 0 → spent is the serialization point, so a double-fire
    // credits the balance back exactly once. Balance only; lifetime is
    // untouched (the burn never moved it). Returns { restored_points }, 0
    // when the claim was already taken (or the id is unknown / not a burn).
    reverseRedemptionById: async function (txId) {
      var tid = _uuid(txId, "tx_id");
      var row = (await query(
        "SELECT id, customer_id, points, restored_points FROM loyalty_transactions " +
        "WHERE id = ?1 AND transaction_type = 'redeem'",
        [tid],
      )).rows[0];
      if (!row) return { restored_points: 0 };
      var spent = Math.abs(Number(row.points || 0));
      if (spent <= 0 || Number(row.restored_points || 0) !== 0) return { restored_points: 0 };
      var ts = _now();
      var claim = await query(
        "UPDATE loyalty_transactions SET restored_points = ?1 " +
        "WHERE id = ?2 AND restored_points = 0",
        [spent, row.id],
      );
      if (!b.sql.casWon(claim).won) return { restored_points: 0 };   // lost the claim
      await _ensureAccountRow(row.customer_id, ts);
      // Forward-only credit-back: ONE chained +spent row off the live tip
      // (lifetime untouched). The restored_points claim above is the
      // serialization point, so a double-fire wins no claim and appends
      // nothing — exactly-once. There is no revert anywhere, so the
      // two-statement double-credit-on-revert hazard is structurally gone.
      var w = await _writeChained(row.customer_id, function (latest) {
        return {
          type: "redeem", points: spent, source: "redeem-reversal", orderId: null,
          notes:         "restored ref=tx:" + row.id,
          balanceAfter:  latest.balance + spent,
          lifetimeAfter: latest.lifetime,
          tierAfter:     latest.tier,
          ts:            _resolveOccurredAt(ts, latest.occurred_at),
        };
      });
      await _refreshMirror(row.customer_id, w, ts);
      return { restored_points: spent };
    },

    // Restore points a customer SPENT as a checkout tender when the order
    // that spent them is refunded — the symmetric counterpart to the
    // gift-card-spend restore. `redeem` debited the balance at checkout
    // against `order_id`; a refund returns money to the buyer, so the points
    // they tendered have to come back to their balance or the refund silently
    // burns them (inconsistent with the gift-card spend, which IS restored).
    //
    // PROPORTIONAL to the refund: the target cumulative restore per redeem row
    // is floor(spent_points * refunded_minor / order_total_minor), clamped to
    // the points spent, so a partial refund restores only the covered share
    // and a partial-then-final sequence converges exactly on the points spent.
    // The credit is the delta vs `restored_points` (the cumulative already
    // restored), advanced under a guarded UPDATE keyed on the row's live value
    // so a concurrent double-fire can't double-restore. Balance only —
    // lifetime is NOT touched (redeem never decremented it, so the restore
    // mustn't inflate it and retroactively promote a tier). A new positive
    // `redeem` ledger row records each restore so the audit trail nets to the
    // un-refunded spend.
    //
    // Idempotent + a natural no-op for an order that tendered no points (no
    // redeem rows) or one already restored to the requested proportion.
    // Returns { restored_points } — the points credited back this call.
    restoreRedemption: async function (orderId, input) {
      var oid = _uuid(orderId, "order_id");
      input = input || {};
      var refundedMinor   = input.refunded_minor;
      var orderTotalMinor = input.order_total_minor;
      if (typeof refundedMinor !== "number" || !Number.isInteger(refundedMinor) || refundedMinor < 0) {
        throw new TypeError("loyalty.restoreRedemption: refunded_minor must be a non-negative integer (minor units)");
      }
      if (typeof orderTotalMinor !== "number" || !Number.isInteger(orderTotalMinor) || orderTotalMinor <= 0) {
        throw new TypeError("loyalty.restoreRedemption: order_total_minor must be a positive integer (minor units)");
      }
      var effRefunded = refundedMinor > orderTotalMinor ? orderTotalMinor : refundedMinor;

      // Scan only the GENUINE burns (source = 'redeem'), never the positive
      // 'redeem-reversal' rows this function writes below — those also carry
      // transaction_type 'redeem', so without the source filter a second
      // restore pass (the cash-first refund path runs this once for the
      // partial slice and again on the terminal refund edge) would re-read a
      // prior pass's reversal as a fresh redemption and credit it again,
      // compounding the restore past the original spend (money creation).
      var rows = (await query(
        "SELECT id, customer_id, points, restored_points FROM loyalty_transactions " +
        "WHERE order_id = ?1 AND transaction_type = 'redeem' AND source = 'redeem'",
        [oid],
      )).rows;
      var restoredTotal = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        // `points` on a redeem row is the NEGATIVE delta; the spend is its
        // magnitude.
        var spent = Math.abs(Number(row.points || 0));
        if (spent <= 0) continue;
        var already = Number(row.restored_points || 0);
        var target  = Math.floor((spent * effRefunded) / orderTotalMinor);
        if (target > spent) target = spent;
        var delta = target - already;
        if (delta <= 0) continue;
        var ts = _now();
        // Claim the slice: advance restored_points from its expected prior
        // value so a concurrent restore can't double-credit.
        var claim = await query(
          "UPDATE loyalty_transactions SET restored_points = ?1 " +
          "WHERE id = ?2 AND restored_points = ?3",
          [target, row.id, already],
        );
        if (!b.sql.casWon(claim).won) continue;   // lost the claim
        await _ensureAccountRow(row.customer_id, ts);
        // Forward-only credit-back: ONE chained +delta row off the live tip,
        // BALANCE only (lifetime untouched — a redeem never moved it, so the
        // restore mustn't either). The restored_points claim above is the
        // serialization point; there is no revert, so no double-credit hazard.
        // `source='redeem-reversal'` distinguishes it from the original burn so
        // the scan above never re-reads it. _writeChained is awaited before the
        // loop advances, so `delta`/`oid`/`ts` are stable inside the derive.
        var wRestore = await _writeChained(row.customer_id, function (latest) {
          return {
            type: "redeem", points: delta, source: "redeem-reversal", orderId: oid,
            notes:         "restored ref=order:" + oid,
            balanceAfter:  latest.balance + delta,
            lifetimeAfter: latest.lifetime,
            tierAfter:     latest.tier,
            ts:            _resolveOccurredAt(ts, latest.occurred_at),
          };
        });
        await _refreshMirror(row.customer_id, wRestore, ts);
        restoredTotal += delta;
      }
      return { restored_points: restoredTotal };
    },

    adjust: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("loyalty.adjust: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var delta      = _signedInt(input.points, "points");
      var source     = _source(input.source);
      var notes      = _notes(input.notes);

      var requested = _now();
      await _ensureAccountRow(customerId, requested);
      // Positive adjustments increment lifetime (operator goodwill counts
      // toward tier) and recompute the tier; negative adjustments do NOT move
      // lifetime (no retroactive tier downgrade) and are guarded so the balance
      // can't go below zero (balSub + delta >= 0, delta negative) — the loser
      // of a concurrent over-draw re-reads the live balance and is refused.
      var lifetimeDelta = delta > 0 ? delta : 0;
      var tierBefore;
      var w = await _writeChained(customerId, function (latest) {
        tierBefore = latest.tier;
        var lifeAfter = latest.lifetime + lifetimeDelta;
        return {
          type: "adjust", points: delta, source: source, orderId: null, notes: notes,
          balanceAfter:  latest.balance + delta,
          lifetimeAfter: lifeAfter,
          tierAfter:     delta > 0 ? computeTier(lifeAfter) : latest.tier,
          ts:            _resolveOccurredAt(requested, latest.occurred_at),
          guard:         delta < 0 ? "__BAL__ + ?4 >= 0" : undefined,
        };
      });
      if (w.refused) {
        var ins = new Error("loyalty.adjust: adjustment would underflow balance");
        ins.code = "LOYALTY_INSUFFICIENT_BALANCE";
        throw ins;
      }
      await _refreshMirror(customerId, w, requested);
      return {
        balance:      w.balance,
        lifetime:     w.lifetime,
        tier:         w.tier,
        tier_changed: w.tier !== tierBefore,
      };
    },

    // Credit the SPENDABLE balance only, never lifetime. The
    // refund-the-burn counterpart to `redeem`: redeem debits balance
    // and leaves lifetime alone, so giving the points back must mirror
    // that — touching lifetime here would inflate the tier-driving
    // total above what was actually earned, and a redeem→cancel loop
    // would escalate the tier without limit. Unlike `adjust(+points)`,
    // which credits lifetime on a positive delta, this never moves
    // lifetime and never recomputes tier. Relative-atomic so a
    // concurrent earn/redeem can't clobber the credit. Writes an
    // `adjust`-type ledger row so the audit trail records the refund.
    creditBalance: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("loyalty.creditBalance: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var points     = _positiveInt(input.points, "points");
      var source     = _source(input.source);
      var notes      = _notes(input.notes);

      var requested = _now();
      await _ensureAccountRow(customerId, requested);
      // Forward-only +points chained row, BALANCE only — never moves lifetime
      // and never recomputes tier (giving redeemed points back must not inflate
      // the tier-driving total above what was actually earned).
      var w = await _writeChained(customerId, function (latest) {
        return {
          type: "adjust", points: points, source: source, orderId: null, notes: notes,
          balanceAfter:  latest.balance + points,
          lifetimeAfter: latest.lifetime,
          tierAfter:     latest.tier,
          ts:            _resolveOccurredAt(requested, latest.occurred_at),
        };
      });
      await _refreshMirror(customerId, w, requested);
      return { balance: w.balance, lifetime: w.lifetime, tier: w.tier };
    },

    expire: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("loyalty.expire: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var points     = _positiveInt(input.points, "points");
      if (input.reason == null || input.reason === "") {
        throw new TypeError("loyalty.expire: reason must be a non-empty string");
      }
      var reason     = _source(input.reason);

      var requested = _now();
      await _ensureAccountRow(customerId, requested);
      // Cap at the LIVE balance on every attempt (an interim redemption may
      // have shrunk it) — expire only what's there, never refusing. A zero-cap
      // (empty balance) still writes a points:0 breadcrumb so the audit trail
      // records the sweep ran. Lifetime is untouched. The chained row carries
      // the new running balance, so there is no stored-column second statement.
      var w = await _writeChained(customerId, function (latest) {
        var toExpire = points > latest.balance ? latest.balance : points;
        return {
          type: "expire", points: -toExpire, source: reason, orderId: null, notes: "",
          balanceAfter:  latest.balance - toExpire,
          lifetimeAfter: latest.lifetime,
          tierAfter:     latest.tier,
          ts:            _resolveOccurredAt(requested, latest.occurred_at),
          // toExpire is capped at the same tip so the debit never underflows;
          // the guard is belt-and-braces against a racing debit (which would
          // instead collide on the fence and re-cap on retry).
          guard:         "__BAL__ + ?4 >= 0",
        };
      });
      await _refreshMirror(customerId, w, requested);
      return {
        balance:  w.balance,
        lifetime: w.lifetime,
        tier:     w.tier,
        expired:  -w.points,
      };
    },

    balance: async function (customerId) {
      _uuid(customerId, "customer_id");
      // Authoritative balance/lifetime/tier come from the chain tip (O(1) on
      // the running index), NOT the advisory loyalty_accounts mirror. Only
      // tier_expires_at — an operator time-bound the ledger doesn't carry — is
      // read from the mirror.
      var tip  = await _readLatest(customerId);
      var acct = await _readAccount(customerId);
      return {
        balance:         tip.balance,
        lifetime:        tip.lifetime,
        tier:            tip.tier,
        tier_expires_at: acct ? acct.tier_expires_at : null,
      };
    },

    history: async function (customerId, opts2) {
      _uuid(customerId, "customer_id");
      opts2 = opts2 || {};
      var limit = opts2.limit != null ? opts2.limit : 50;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new TypeError("loyalty.history: limit must be an integer in [1, 500]");
      }
      var cursor = opts2.cursor;
      // Exclude the per-customer chain-genesis anchor (the migration backfill
      // row, id 'genesis-<customer_id>', points 0) — it carries the running-
      // balance snapshot for the chain, not a real customer transaction. A real
      // uuid.v7 id never starts with 'genesis-', so this excludes only the
      // anchor (filtering by id-prefix, not by source: an operator source could
      // legitimately be 'chain-genesis').
      var sql = "SELECT id, customer_id, transaction_type, points, source, order_id, notes, occurred_at " +
                "FROM loyalty_transactions WHERE customer_id = ?1 AND id NOT LIKE 'genesis-%'";
      var params = [customerId];
      if (cursor != null) {
        if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
          throw new TypeError("loyalty.history: cursor must be a non-negative integer epoch-ms");
        }
        // Cursor is the `occurred_at` of the last row in the previous
        // page — request rows STRICTLY OLDER so a page boundary
        // landing on a tied timestamp doesn't double-return rows.
        sql += " AND occurred_at < ?2";
        params.push(cursor);
      }
      // Fetch one row beyond the page so the next cursor is emitted ONLY
      // when an older transaction actually exists. Keying the cursor off
      // a full page alone (rows.length === limit) advertises a phantom
      // next page when the history length is an exact multiple of the
      // limit — the "Older activity" link then lands on an empty page.
      sql += " ORDER BY occurred_at DESC LIMIT ?" + (params.length + 1);
      params.push(limit + 1);
      var r = await query(sql, params);
      var hasMore = r.rows.length > limit;
      var rows = hasMore ? r.rows.slice(0, limit) : r.rows;
      var nextCursor = hasMore ? rows[rows.length - 1].occurred_at : null;
      return { rows: rows, next_cursor: nextCursor };
    },

    tierLeaderboard: async function (opts3) {
      opts3 = opts3 || {};
      var limit = opts3.limit != null ? opts3.limit : 10;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new TypeError("loyalty.tierLeaderboard: limit must be an integer in [1, 1000]");
      }
      var sql = "SELECT customer_id, balance_points, lifetime_points, tier, tier_expires_at " +
                "FROM loyalty_accounts";
      var params = [];
      if (opts3.tier != null) {
        if (typeof opts3.tier !== "string" || TIERS.indexOf(opts3.tier) === -1) {
          throw new TypeError("loyalty.tierLeaderboard: tier must be one of " + TIERS.join(", "));
        }
        sql += " WHERE tier = ?1";
        params.push(opts3.tier);
      }
      sql += " ORDER BY lifetime_points DESC, customer_id ASC LIMIT ?" + (params.length + 1);
      params.push(limit);
      var r = await query(sql, params);
      return r.rows;
    },

    // Walk a customer's running-balance chain and recompute every row_hash to
    // prove no row was edited or re-ordered after the fact (the loyalty leg of
    // the money-ledger tamper-evidence). Mirrors gift-card-ledger.verifyChain:
    // a NULL-row_hash legacy/genesis prefix is skipped until the first hashed
    // row anchors the chain; a populated all-NULL ledger is `unanchored` (the
    // shape a full rewrite produces), not "valid". An optional trusted
    // { count, head } anchor additionally rules out a tail truncation. Verifies
    // over _rowFieldsForHash — the SAME tuple the writer hashes (order_id +
    // restored_points excluded), so a linked redemption or a restore can't
    // false-tamper. O(n); operator-audit use, not hot-path.
    verifyChain: async function (customerId, opts) {
      _uuid(customerId, "customer_id");
      opts = opts || {};
      var anchor = null;
      if (opts.anchor != null) {
        if (typeof opts.anchor !== "object"
            || typeof opts.anchor.count !== "number" || !Number.isInteger(opts.anchor.count) || opts.anchor.count < 1
            || typeof opts.anchor.head !== "string" || opts.anchor.head.length !== SHA3_512_HEX_LEN) {
          throw new TypeError("loyalty.verifyChain: anchor must be { count: positive integer, head: " + SHA3_512_HEX_LEN + "-hex-char string }");
        }
        anchor = opts.anchor;
      }
      var rows = (await query(
        "SELECT * FROM loyalty_transactions WHERE customer_id = ?1 ORDER BY occurred_at ASC, id ASC",
        [customerId],
      )).rows;
      var legacyPrefix = 0, anchored = false, prevHash = ZERO_HASH;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (!anchored && row.row_hash == null) { legacyPrefix += 1; continue; }
        anchored = true;
        var breakBase = { ok: false, rows_verified: i - legacyPrefix, legacy_prefix: legacyPrefix,
                          break_at: i, break_row_id: row.id };
        if (row.row_hash == null) return Object.assign(breakBase, { reason: "unhashed row after chain anchor" });
        if (row.prev_hash !== prevHash) {
          return Object.assign(breakBase, { reason: "prev_hash mismatch", expected: prevHash, actual: row.prev_hash });
        }
        var computed = _computeRowHash(prevHash, _rowFieldsForHash(row));
        if (computed !== row.row_hash) {
          return Object.assign(breakBase, { reason: "row_hash mismatch", expected: computed, actual: row.row_hash });
        }
        prevHash = row.row_hash;
      }
      if (!anchored && rows.length > 0) {
        return { ok: false, rows_verified: 0, legacy_prefix: legacyPrefix, break_at: 0,
                 break_row_id: rows[0].id, reason: "unanchored chain (no hashed row in a populated ledger)" };
      }
      if (anchor) {
        if (rows.length < anchor.count) {
          return { ok: false, rows_verified: rows.length - legacyPrefix, legacy_prefix: legacyPrefix,
                   anchor_checked: true, reason: "row count below anchor (possible tail truncation)",
                   expected_count: anchor.count, actual_count: rows.length };
        }
        var anchorRow = rows[anchor.count - 1];
        if (anchorRow.row_hash !== anchor.head) {
          return { ok: false, rows_verified: rows.length - legacyPrefix, legacy_prefix: legacyPrefix,
                   anchor_checked: true, reason: "anchor head mismatch (chain replaced below snapshot)",
                   expected: anchor.head, actual: anchorRow.row_hash };
        }
      }
      return { ok: true, rows_verified: rows.length - legacyPrefix, legacy_prefix: legacyPrefix,
               head: prevHash, anchor_checked: !!anchor };
    },
  };
}

module.exports = {
  create:                    create,
  TIERS:                     TIERS,
  TX_TYPES:                  TX_TYPES,
  DEFAULT_TIER_THRESHOLDS:   DEFAULT_TIER_THRESHOLDS,
  DEFAULT_POINTS_PER_USD:    DEFAULT_POINTS_PER_USD,
  DEFAULT_REDEMPTION_POINTS_PER_USD: DEFAULT_REDEMPTION_POINTS_PER_USD,
};
