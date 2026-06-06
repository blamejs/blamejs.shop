"use strict";
/**
 * @module shop.storeCredit
 * @title  Store-credit primitive — per-customer account-bound wallet
 *
 * @intro
 *   Per-customer store-credit wallet. Distinct from the `giftcards`
 *   + `giftCardLedger` primitives — gift cards are bearer
 *   credentials tied to a code (whoever holds the code can spend),
 *   store credit is account-bound (no code, follows the customer
 *   record). The two ledgers share the same shape because the
 *   read patterns are identical: O(1) current balance against a
 *   denormalized `balance_after_minor` snapshot, paginated history
 *   newest-first, transactions touching a given order, expiring-
 *   balance sweeps.
 *
 *   Composition:
 *     var credit = bShop.storeCredit.create({ query: q });
 *     await credit.credit({
 *       customer_id:  customerId,
 *       amount_minor: 2500,
 *       source:       "refund",
 *       source_ref:   refundId,
 *       expires_at:   Date.now() + 365 * 86400 * 1000,
 *     });
 *     await credit.debit({
 *       customer_id:  customerId,
 *       amount_minor: 1200,
 *       order_id:     orderId,
 *     });
 *     var bal = await credit.balance(customerId);   // 1300
 *
 *   Overdraft is refused at the primitive layer: debit > available
 *   throws `STORE_CREDIT_INSUFFICIENT_BALANCE` and writes no row.
 *   Expire caps at the current balance (operator-initiated burn
 *   degrades gracefully when the credit has already been spent).
 *
 *   `cleanupExpired` is the scheduler-callable sweep: it walks
 *   credit rows whose `expires_at < now` and whose deposited amount
 *   hasn't already been offset by a later expire entry, then writes
 *   an offsetting `expire` row for each. The sweep is idempotent —
 *   re-running it produces no new rows because the offsetting
 *   entries already exist.
 *
 *   Surface:
 *     - credit({ customer_id, amount_minor, source, source_ref?, expires_at?, occurred_at? })
 *     - debit({ customer_id, amount_minor, order_id, occurred_at? })
 *     - expire({ customer_id, amount_minor, reason })
 *     - balance(customer_id)
 *     - history({ customer_id, cursor?, limit? })
 *     - transactionsForOrder(order_id)
 *     - expiringWithin({ customer_id, days })
 *     - bulkBalance({ customer_ids })
 *     - cleanupExpired({ now })
 *
 *   Storage:
 *     - store_credit_ledger (migration 0094).
 *
 * @primitive storeCredit
 * @related   b.uuid.v7, b.guardUuid, shop.giftCardLedger
 */

var b = require("./vendor/blamejs");

var C = b.constants;

var KINDS   = ["credit", "debit", "expire"];
var SOURCES = ["refund", "goodwill", "promotional", "manual", "loyalty_redemption"];

// Reserved source_ref stamped on every expire row the scheduled sweep
// writes. `cleanupExpired` keys its "already swept" idempotency on this
// marker SO THAT operator-initiated `expire()` rows (which carry the
// operator's own reason) don't masquerade as prior sweep output and
// suppress a legitimate expiry. The marker is short + control-byte-free
// so it passes `_sourceRef` validation when written.
var SWEEP_SOURCE_REF = "scheduled-expiry-sweep";

var MAX_SOURCE_REF_LEN = 128;
// source_ref / reason are short correlation handles. Refuse all
// control bytes (including CR/LF and tab) — log-injection cover has
// no legitimate place in a one-line correlation column.
var PRINTABLE_RE = /^[^\x00-\x1f\x7f]*$/;

var MAX_BULK_IDS = 500;
var MS_PER_DAY   = C.TIME.days(1);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("storeCredit: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _amountMinor(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("storeCredit: " + label + " must be a positive integer (minor units)");
  }
  return n;
}

function _source(s) {
  if (typeof s !== "string" || SOURCES.indexOf(s) === -1) {
    throw new TypeError("storeCredit: source must be one of " + SOURCES.join(", "));
  }
  return s;
}

function _sourceRef(s, label) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("storeCredit: " + label + " must be a string");
  }
  if (!s.length) {
    throw new TypeError("storeCredit: " + label + " must be a non-empty string when provided");
  }
  if (s.length > MAX_SOURCE_REF_LEN) {
    throw new TypeError("storeCredit: " + label + " must be <= " + MAX_SOURCE_REF_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("storeCredit: " + label + " must not contain control bytes");
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("storeCredit: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // O(1) current-balance read: the latest row by `occurred_at DESC`
  // holds `balance_after_minor` as the denormalized snapshot. No SUM
  // aggregation at read time. Falls through to 0 when no rows exist
  // (a customer that has never had a ledger row has zero credit).
  // Returns both the snapshot and the occurred_at so the write path
  // can guarantee strict monotonicity (see `_resolveOccurredAt`).
  async function _readLatest(customerId) {
    var r = await query(
      "SELECT balance_after_minor, occurred_at FROM store_credit_ledger " +
      "WHERE customer_id = ?1 ORDER BY occurred_at DESC LIMIT 1",
      [customerId],
    );
    if (!r.rows.length) return { balance: 0, occurred_at: null };
    return { balance: r.rows[0].balance_after_minor, occurred_at: r.rows[0].occurred_at };
  }

  async function _currentBalance(customerId) {
    var latest = await _readLatest(customerId);
    return latest.balance;
  }

  // Two writes against the same customer in the same millisecond
  // would tie on `occurred_at` and make the "latest row" ambiguous.
  // Bump the requested timestamp to `prior + 1` when it would
  // collide (or land older than the prior row, which an
  // out-of-order operator write could trigger). The result is a
  // strictly-monotonic per-customer `occurred_at` sequence.
  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _writeRow(customerId, kind, amountMinor, source, sourceRef, orderId, balanceAfter, expiresAt, ts) {
    var id = b.uuid.v7();
    await query(
      "INSERT INTO store_credit_ledger " +
      "(id, customer_id, kind, amount_minor, source, source_ref, order_id, balance_after_minor, expires_at, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
      [id, customerId, kind, amountMinor, source, sourceRef, orderId, balanceAfter, expiresAt, ts],
    );
    return id;
  }

  return {
    KINDS:   KINDS.slice(),
    SOURCES: SOURCES.slice(),

    credit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("storeCredit.credit: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      var source     = _source(input.source);
      var sourceRef  = _sourceRef(input.source_ref, "source_ref");
      var expiresAt  = _epochMs(input.expires_at, "expires_at");
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatest(customerId);
      var ts     = _resolveOccurredAt(requested, latest.occurred_at);
      var after  = latest.balance + amount;
      var id = await _writeRow(customerId, "credit", amount, source, sourceRef, null, after, expiresAt, ts);

      return {
        id:                  id,
        customer_id:         customerId,
        kind:                "credit",
        amount_minor:        amount,
        source:              source,
        source_ref:          sourceRef,
        expires_at:          expiresAt,
        balance_after_minor: after,
        occurred_at:         ts,
      };
    },

    debit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("storeCredit.debit: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      var orderId    = _uuid(input.order_id, "order_id");
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatest(customerId);
      if (amount > latest.balance) {
        var insufficient = new Error("storeCredit.debit: amount exceeds available balance");
        insufficient.code = "STORE_CREDIT_INSUFFICIENT_BALANCE";
        throw insufficient;
      }
      var ts    = _resolveOccurredAt(requested, latest.occurred_at);
      var after = latest.balance - amount;
      var id = await _writeRow(customerId, "debit", amount, null, null, orderId, after, null, ts);

      return {
        id:                  id,
        customer_id:         customerId,
        kind:                "debit",
        amount_minor:        amount,
        order_id:            orderId,
        balance_after_minor: after,
        occurred_at:         ts,
      };
    },

    expire: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("storeCredit.expire: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      // `reason` is operator-supplied free-form. Require it
      // explicitly (vs. an optional sourceRef) so an audit-trail
      // row tagged 'expire' always carries the operator's
      // justification.
      if (input.reason == null || input.reason === "") {
        throw new TypeError("storeCredit.expire: reason must be a non-empty string");
      }
      var reason    = _sourceRef(input.reason, "reason");
      var requested = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatest(customerId);
      // Expire caps at the current balance — operators running a
      // scheduled sweep over computed "expiring before X" amounts
      // should degrade gracefully rather than refusing when an
      // interim debit has already drained the wallet.
      var toBurn = amount > latest.balance ? latest.balance : amount;
      if (toBurn === 0) {
        // No-op write: persisting a zero-amount row would violate
        // the CHECK(amount_minor > 0) constraint. Surface a
        // structured refusal so the caller can distinguish "already
        // empty" from "actually burned N". A no-op expire is a
        // valid outcome of a bulk sweep — don't throw.
        return {
          id:                  null,
          customer_id:         customerId,
          kind:                "expire",
          amount_minor:        0,
          requested_minor:     amount,
          reason:              reason,
          balance_after_minor: latest.balance,
          occurred_at:         requested,
          noop:                true,
        };
      }
      var ts    = _resolveOccurredAt(requested, latest.occurred_at);
      var after = latest.balance - toBurn;
      var id = await _writeRow(customerId, "expire", toBurn, null, reason, null, after, null, ts);

      return {
        id:                  id,
        customer_id:         customerId,
        kind:                "expire",
        amount_minor:        toBurn,
        requested_minor:     amount,
        reason:              reason,
        balance_after_minor: after,
        occurred_at:         ts,
        noop:                false,
      };
    },

    balance: async function (customerId) {
      _uuid(customerId, "customer_id");
      var bal = await _currentBalance(customerId);
      return { customer_id: customerId, balance_minor: bal };
    },

    history: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("storeCredit.history: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var limit = input.limit != null ? input.limit : 50;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new TypeError("storeCredit.history: limit must be an integer in [1, 500]");
      }
      var cursor = input.cursor;
      var sql = "SELECT id, customer_id, kind, amount_minor, source, source_ref, order_id, " +
                "balance_after_minor, expires_at, occurred_at FROM store_credit_ledger " +
                "WHERE customer_id = ?1";
      var params = [customerId];
      if (cursor != null) {
        if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
          throw new TypeError("storeCredit.history: cursor must be a non-negative integer epoch-ms");
        }
        // Cursor is the `occurred_at` of the last row in the
        // previous page — request rows STRICTLY OLDER so a page
        // boundary landing on a tied timestamp doesn't double-
        // return rows.
        sql += " AND occurred_at < ?2";
        params.push(cursor);
      }
      // Fetch one row beyond the page so the next cursor is emitted ONLY
      // when an older ledger entry actually exists. Keying the cursor off
      // a full page alone (rows.length === limit) advertises a phantom
      // next page when the ledger length is an exact multiple of the
      // limit — the "Older activity" link then lands on an empty page.
      sql += " ORDER BY occurred_at DESC, id DESC LIMIT ?" + (params.length + 1);
      params.push(limit + 1);
      var r = await query(sql, params);
      var hasMore = r.rows.length > limit;
      var rows = hasMore ? r.rows.slice(0, limit) : r.rows;
      var nextCursor = hasMore ? rows[rows.length - 1].occurred_at : null;
      return { rows: rows, next_cursor: nextCursor };
    },

    transactionsForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var r = await query(
        "SELECT id, customer_id, kind, amount_minor, source, source_ref, order_id, " +
        "balance_after_minor, expires_at, occurred_at FROM store_credit_ledger " +
        "WHERE order_id = ?1 ORDER BY occurred_at ASC, id ASC",
        [orderId],
      );
      return r.rows;
    },

    expiringWithin: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("storeCredit.expiringWithin: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var days = input.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 0) {
        throw new TypeError("storeCredit.expiringWithin: days must be a non-negative integer");
      }
      var now      = _now();
      var horizon  = now + (days * MS_PER_DAY);

      // Walk this customer's credit rows whose expires_at falls in
      // the window (now, horizon]. A row whose expires_at has
      // already passed is excluded — that's `cleanupExpired`'s
      // domain. Match each credit row against the running sum of
      // later `expire` entries to compute how much of the deposit
      // remains exposed; only rows with non-zero remaining come
      // back. Replay-derived rather than denormalized because
      // expiring-balance is a per-credit-row question (the wallet
      // can hold credits with different deadlines), not the
      // single-balance question `balance()` answers.
      var creditRows = (await query(
        "SELECT id, amount_minor, source, source_ref, expires_at, occurred_at " +
        "FROM store_credit_ledger " +
        "WHERE customer_id = ?1 AND kind = 'credit' AND expires_at IS NOT NULL " +
        "AND expires_at > ?2 AND expires_at <= ?3 " +
        "ORDER BY expires_at ASC, occurred_at ASC",
        [customerId, now, horizon],
      )).rows;

      if (!creditRows.length) return [];

      // Aggregate expire-row burn for this customer post-`now` —
      // the sum we'll consume against the FIFO-ordered (by
      // expires_at) credit rows. Expire rows themselves don't
      // carry expires_at; they're just balance reductions. We can't
      // attribute an expire to a specific credit row at the schema
      // level (no parent pointer), so we apply burn FIFO across
      // credit rows whose deadline has already passed (impossible
      // here — we filtered to expires_at > now) plus burn applied
      // generically. The simpler model: ignore historical expires
      // for the within-window question — those expires offset
      // already-expired credits (handled by cleanupExpired).
      // Customer's current total balance bounds how much of the
      // window-resident credits remains spendable.
      var totalBal = (await _readLatest(customerId)).balance;

      // FIFO walk: each credit row contributes up to its
      // amount_minor toward the running spendable balance, in
      // expires_at order. Rows past the spendable bound are
      // implicitly already-spent by post-credit debits — exclude.
      var out = [];
      var remaining = totalBal;
      for (var i = 0; i < creditRows.length; i += 1) {
        if (remaining <= 0) break;
        var row = creditRows[i];
        var slice = row.amount_minor > remaining ? remaining : row.amount_minor;
        out.push({
          credit_id:    row.id,
          amount_minor: slice,
          source:       row.source,
          source_ref:   row.source_ref,
          expires_at:   row.expires_at,
          occurred_at:  row.occurred_at,
        });
        remaining -= slice;
      }
      return out;
    },

    bulkBalance: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("storeCredit.bulkBalance: input object required");
      }
      var ids = input.customer_ids;
      if (!Array.isArray(ids)) {
        throw new TypeError("storeCredit.bulkBalance: customer_ids must be an array");
      }
      if (ids.length === 0) return [];
      if (ids.length > MAX_BULK_IDS) {
        throw new TypeError("storeCredit.bulkBalance: customer_ids must be <= " + MAX_BULK_IDS + " entries");
      }
      // Validate every id up front — surface "ids[3] is not a UUID"
      // at the call site rather than letting D1 reject the whole
      // query with an opaque error.
      var validated = [];
      for (var i = 0; i < ids.length; i += 1) {
        validated.push(_uuid(ids[i], "customer_ids[" + i + "]"));
      }
      // Per-id correlated subquery: the join lands the LATEST row
      // per customer. `(customer_id, occurred_at DESC)` index drives
      // both legs.
      var placeholders = [];
      for (var p = 0; p < validated.length; p += 1) {
        placeholders.push("?" + (p + 1));
      }
      var sql =
        "SELECT g.customer_id, g.balance_after_minor, g.occurred_at " +
        "FROM store_credit_ledger g " +
        "WHERE g.customer_id IN (" + placeholders.join(",") + ") " +
        "AND g.occurred_at = (" +
        "  SELECT MAX(g2.occurred_at) FROM store_credit_ledger g2 " +
        "  WHERE g2.customer_id = g.customer_id" +
        ") " +
        "ORDER BY g.customer_id ASC";
      var r = await query(sql, validated);
      // Build a lookup keyed by id so customers with no rows still
      // surface as `balance_minor: 0`. Operators sweeping a list
      // expect a row for every input id; a silent skip would be a
      // footgun.
      var byId = Object.create(null);
      for (var k = 0; k < r.rows.length; k += 1) {
        var row = r.rows[k];
        byId[row.customer_id] = row.balance_after_minor;
      }
      var out = [];
      for (var m = 0; m < validated.length; m += 1) {
        var id = validated[m];
        out.push({
          customer_id:   id,
          balance_minor: Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : 0,
        });
      }
      return out;
    },

    cleanupExpired: async function (input) {
      input = input || {};
      var now = _epochMs(input.now, "now");
      if (now == null) now = _now();

      // Walk every credit row whose deadline has passed. For each
      // customer, expire the still-unburned portion of their expired
      // credit, capped at the wallet's current balance.
      //
      // The "already swept" check is per-customer rather than
      // per-credit-row because expire rows have no parent pointer at
      // the schema level. The idempotency key is the SWEEP's OWN prior
      // output — expire rows stamped with `SWEEP_SOURCE_REF` — NOT
      // every expire row. Counting all expire rows here was the bug:
      // an operator-initiated `expire()` (a clawback, a goodwill burn)
      // or any non-sweep expire would be subtracted from the expired-
      // credit total, shrinking `pendingBurn` and leaving genuinely
      // expired credit un-swept. Operator expires + debits already
      // reduced the BALANCE; the `min(pendingBurn, balance)` cap below
      // is what keeps the sweep from over-burning when the wallet was
      // partly drained — so they must not also be netted out of the
      // expired pool, or the reduction is double-counted. When the
      // unburned remainder is zero, the sweep is a no-op for that
      // customer (idempotent re-run produces no duplicates).
      var expiredByCustomer = (await query(
        "SELECT customer_id, SUM(amount_minor) AS total " +
        "FROM store_credit_ledger " +
        "WHERE kind = 'credit' AND expires_at IS NOT NULL AND expires_at <= ?1 " +
        "GROUP BY customer_id",
        [now],
      )).rows;

      var processed = [];
      for (var i = 0; i < expiredByCustomer.length; i += 1) {
        var row = expiredByCustomer[i];
        var customerId = row.customer_id;
        var expiredTotal = row.total;

        var burnRow = (await query(
          "SELECT COALESCE(SUM(amount_minor), 0) AS total " +
          "FROM store_credit_ledger " +
          "WHERE customer_id = ?1 AND kind = 'expire' AND source_ref = ?2",
          [customerId, SWEEP_SOURCE_REF],
        )).rows[0];
        var alreadyBurned = burnRow ? burnRow.total : 0;
        var pendingBurn   = expiredTotal - alreadyBurned;

        if (pendingBurn <= 0) {
          // The sweep already burned this customer's expired credit on
          // a prior run. Idempotent skip.
          continue;
        }

        var latest = await _readLatest(customerId);
        // Cap the burn at the wallet's current balance.
        // Debits between the credit and the sweep may have spent
        // the expired amount already; we never drive the balance
        // negative. The expired credits were "first-out" from the
        // operator's POV — but the schema doesn't track FIFO at
        // row-level, so cap by current balance and let the audit
        // trail reflect what was actually burned.
        var toBurn = pendingBurn > latest.balance ? latest.balance : pendingBurn;
        if (toBurn <= 0) {
          // Wallet already empty — record nothing (no CHECK > 0
          // violation). Operator can reconcile via history.
          continue;
        }
        var ts    = _resolveOccurredAt(now, latest.occurred_at);
        var after = latest.balance - toBurn;
        var id    = await _writeRow(customerId, "expire", toBurn, null, SWEEP_SOURCE_REF, null, after, null, ts);
        processed.push({
          id:                  id,
          customer_id:         customerId,
          amount_minor:        toBurn,
          balance_after_minor: after,
          occurred_at:         ts,
        });
      }
      return { processed: processed, swept_at: now };
    },
  };
}

module.exports = {
  create:  create,
  KINDS:   KINDS,
  SOURCES: SOURCES,
};
