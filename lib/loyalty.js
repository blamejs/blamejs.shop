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

  async function _writeTx(customerId, type, points, source, orderId, notes, ts) {
    var id = b.uuid.v7();
    await query(
      "INSERT INTO loyalty_transactions " +
      "(id, customer_id, transaction_type, points, source, order_id, notes, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [id, customerId, type, points, source, orderId, notes, ts],
    );
    return id;
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

  // SQL fragment that derives the tier from a lifetime-points
  // expression evaluated INSIDE the UPDATE statement, so balance,
  // lifetime, and tier all move in one atomic write off the row's
  // live value rather than a stale snapshot. `lifetimeExpr` is the
  // post-mutation lifetime SQL (e.g. `lifetime_points + ?2`). The
  // operator-tunable thresholds bind as literals — they're validated
  // non-negative integers at factory time, never operator input here,
  // so inlining them keeps the CASE a single self-contained
  // expression without widening the bound-parameter list per call.
  // Mirrors computeTier's highest-threshold-first ladder so the SQL
  // and JS classifications never diverge.
  function _tierCase(lifetimeExpr) {
    return "CASE" +
      " WHEN (" + lifetimeExpr + ") >= " + thresholds.platinum + " THEN 'platinum'" +
      " WHEN (" + lifetimeExpr + ") >= " + thresholds.gold     + " THEN 'gold'" +
      " WHEN (" + lifetimeExpr + ") >= " + thresholds.silver   + " THEN 'silver'" +
      " ELSE 'bronze' END";
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

      var ts = _now();
      await _ensureAccountRow(customerId, ts);
      // Snapshot the tier ONLY to report `tier_changed` — the balance /
      // lifetime / tier mutation itself is relative-atomic below, so a
      // concurrent earn can't clobber this credit (the lost-update the
      // absolute write suffered). The tier is recomputed in-SQL off the
      // row's live `lifetime_points`, not this stale snapshot.
      var before = await _readAccount(customerId);
      await query(
        "UPDATE loyalty_accounts SET balance_points = balance_points + ?1, " +
        "lifetime_points = lifetime_points + ?1, " +
        "tier = " + _tierCase("lifetime_points + ?1") + ", " +
        "updated_at = ?2 WHERE customer_id = ?3",
        [points, ts, customerId],
      );
      await _writeTx(customerId, "earn", points, source, orderId, notes, ts);

      var after = await _readAccount(customerId);
      return {
        balance:      after.balance_points,
        lifetime:     after.lifetime_points,
        tier:         after.tier,
        tier_changed: after.tier !== before.tier,
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

      var ts = _now();
      await _ensureAccountRow(customerId, ts);
      var before = await _readAccount(customerId);
      if (before.balance_points < points) {
        var ins = new Error("loyalty.redeem: insufficient balance");
        ins.code = "LOYALTY_INSUFFICIENT_BALANCE";
        throw ins;
      }

      // Atomic decrement guarded by a balance check at the SQL tier so
      // two concurrent redemptions can't double-spend. Lifetime is not
      // affected — redemption spends from the running balance only.
      var dec = await query(
        "UPDATE loyalty_accounts SET balance_points = balance_points - ?1, " +
        "updated_at = ?2 WHERE customer_id = ?3 AND balance_points >= ?1",
        [points, ts, customerId],
      );
      if (dec.rowCount === 0) {
        var raced = new Error("loyalty.redeem: insufficient balance");
        raced.code = "LOYALTY_INSUFFICIENT_BALANCE";
        throw raced;
      }

      var txId = await _writeTx(customerId, "redeem", -points, "redeem", orderId, notes, ts);

      var after = await _readAccount(customerId);
      return {
        balance:         after.balance_points,
        lifetime:        after.lifetime_points,
        tier:            after.tier,
        tier_expires_at: after.tier_expires_at,
        // Ledger row id of this burn — checkout debits points BEFORE its
        // order exists (the debit is the double-spend gate) and links the
        // row to the order afterwards via linkRedemptionToOrder, or
        // compensates via reverseRedemptionById when the checkout dies
        // before the order is created.
        tx_id:           txId,
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
      return Number(res.rowCount || 0) === 1;
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
      if (Number(claim.rowCount || 0) === 0) return { restored_points: 0 };   // lost the claim
      // The restored_points claim above is the idempotency fence, but the
      // balance credit + ledger row are SEPARATE non-idempotent statements
      // (D1 has no interactive transactions). If one throws, the fence is
      // already advanced while the points never landed — a retry then reads
      // restored_points!=0 and no-ops, stranding the restore. Revert the fence
      // on failure so the restore can be re-attempted; the original error is
      // rethrown.
      try {
        await _ensureAccountRow(row.customer_id, ts);
        await query(
          "UPDATE loyalty_accounts SET balance_points = balance_points + ?1, " +
          "updated_at = ?2 WHERE customer_id = ?3",
          [spent, ts, row.customer_id],
        );
        await _writeTx(row.customer_id, "redeem", spent, "redeem-reversal", null,
          "restored ref=tx:" + row.id, ts);
      } catch (e) {
        try {
          await query(
            "UPDATE loyalty_transactions SET restored_points = 0 " +
            "WHERE id = ?1 AND restored_points = ?2",
            [row.id, spent],
          );
        } catch (_revertErr) { /* drop-silent — surface the original cause */ }
        throw e;
      }
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
        if (Number(claim.rowCount || 0) === 0) continue;   // lost the claim
        // The restored_points claim is the idempotency fence, but the balance
        // credit + ledger row are SEPARATE non-idempotent statements. If one
        // throws, the fence is advanced (already→target) while the points
        // never landed, and a later pass computes delta=0 and skips —
        // stranding the restore. Revert the fence to `already` on failure so
        // the slice can be re-restored; the original error is rethrown.
        try {
          await _ensureAccountRow(row.customer_id, ts);
          // Credit BALANCE only — lifetime is untouched (a redeem never moved
          // lifetime; restoring it mustn't either). Relative-atomic so a
          // concurrent earn/redeem can't clobber it.
          await query(
            "UPDATE loyalty_accounts SET balance_points = balance_points + ?1, " +
            "updated_at = ?2 WHERE customer_id = ?3",
            [delta, ts, row.customer_id],
          );
          // Positive `redeem`-type ledger row so the trail nets to the
          // un-refunded spend. `source` distinguishes it from the original burn.
          await _writeTx(row.customer_id, "redeem", delta, "redeem-reversal", oid,
            "restored ref=order:" + oid, ts);
        } catch (e) {
          try {
            await query(
              "UPDATE loyalty_transactions SET restored_points = ?1 " +
              "WHERE id = ?2 AND restored_points = ?3",
              [already, row.id, target],
            );
          } catch (_revertErr) { /* drop-silent — surface the original cause */ }
          throw e;
        }
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

      var ts = _now();
      await _ensureAccountRow(customerId, ts);
      // Snapshot the pre-adjust tier only to report `tier_changed`. The
      // mutation is relative-atomic with an underflow guard at the SQL
      // tier so two concurrent adjustments can't lose an update or drive
      // the balance negative past each other.
      var before = await _readAccount(customerId);

      // Positive adjustments also increment lifetime — operators
      // crediting a customer for a service recovery should see that
      // credit count toward tier. Negative adjustments do NOT
      // decrement lifetime (otherwise a clawback could downgrade tier
      // retroactively, which is a customer-facing surprise). The
      // lifetime delta is therefore the positive part of `delta`.
      var lifetimeDelta = delta > 0 ? delta : 0;
      // Conditional UPDATE: the row mutates ONLY when the post-adjust
      // balance stays non-negative, checked against the row's LIVE
      // balance (not the stale snapshot). A racing concurrent adjust
      // that already spent the balance makes this match zero rows, so
      // we surface the same insufficient-balance refusal rather than
      // writing a ledger row that diverges from the account.
      var upd = await query(
        "UPDATE loyalty_accounts SET balance_points = balance_points + ?1, " +
        "lifetime_points = lifetime_points + ?2, " +
        "tier = " + _tierCase("lifetime_points + ?2") + ", " +
        "updated_at = ?3 WHERE customer_id = ?4 AND balance_points + ?1 >= 0",
        [delta, lifetimeDelta, ts, customerId],
      );
      if (Number(upd.rowCount || 0) === 0) {
        var ins = new Error("loyalty.adjust: adjustment would underflow balance");
        ins.code = "LOYALTY_INSUFFICIENT_BALANCE";
        throw ins;
      }
      await _writeTx(customerId, "adjust", delta, source, null, notes, ts);

      var after = await _readAccount(customerId);
      return {
        balance:      after.balance_points,
        lifetime:     after.lifetime_points,
        tier:         after.tier,
        tier_changed: after.tier !== before.tier,
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

      var ts = _now();
      await _ensureAccountRow(customerId, ts);
      await query(
        "UPDATE loyalty_accounts SET balance_points = balance_points + ?1, " +
        "updated_at = ?2 WHERE customer_id = ?3",
        [points, ts, customerId],
      );
      await _writeTx(customerId, "adjust", points, source, null, notes, ts);

      var after = await _readAccount(customerId);
      return {
        balance:  after.balance_points,
        lifetime: after.lifetime_points,
        tier:     after.tier,
      };
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

      var ts = _now();
      await _ensureAccountRow(customerId, ts);
      var before = await _readAccount(customerId);

      // Expiry caps at the current balance — operators schedule annual
      // sweeps that compute "points older than 365d" from the ledger;
      // when the live balance is already smaller than the requested
      // expire amount (because of an interim redemption), we expire
      // only what's there rather than refusing.
      var toExpire = points > before.balance_points ? before.balance_points : points;
      if (toExpire === 0) {
        // No-op write the ledger row anyway so the audit trail
        // records that the operator ran the sweep and found nothing.
        await _writeTx(customerId, "expire", 0, reason, null, "", ts);
        return {
          balance:  before.balance_points,
          lifetime: before.lifetime_points,
          tier:     before.tier,
          expired:  0,
        };
      }

      await query(
        "UPDATE loyalty_accounts SET balance_points = balance_points - ?1, " +
        "updated_at = ?2 WHERE customer_id = ?3 AND balance_points >= ?1",
        [toExpire, ts, customerId],
      );
      await _writeTx(customerId, "expire", -toExpire, reason, null, "", ts);

      var after = await _readAccount(customerId);
      return {
        balance:  after.balance_points,
        lifetime: after.lifetime_points,
        tier:     after.tier,
        expired:  toExpire,
      };
    },

    balance: async function (customerId) {
      _uuid(customerId, "customer_id");
      var row = await _readAccount(customerId);
      if (!row) {
        return { balance: 0, lifetime: 0, tier: "bronze", tier_expires_at: null };
      }
      return {
        balance:         row.balance_points,
        lifetime:        row.lifetime_points,
        tier:            row.tier,
        tier_expires_at: row.tier_expires_at,
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
      var sql = "SELECT id, customer_id, transaction_type, points, source, order_id, notes, occurred_at " +
                "FROM loyalty_transactions WHERE customer_id = ?1";
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
