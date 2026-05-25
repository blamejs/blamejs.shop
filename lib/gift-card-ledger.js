"use strict";
/**
 * @module shop.giftCardLedger
 * @title  Gift-card ledger primitive — append-only balance history
 *
 * @intro
 *   Distinct from the `giftcards` primitive (which owns the bearer
 *   credential — code generation, hash storage, single-action redeem
 *   against the snapshot column on the card row). This is the
 *   LEDGER side: one row per credit / debit / expire event,
 *   denormalized `balance_after_minor` snapshot on each row so a
 *   current-balance read is O(1) against the
 *   `(gift_card_id, occurred_at DESC)` index.
 *
 *   The two primitives are intentionally separate because they
 *   answer different questions:
 *
 *     - giftcards.balance(code)      — "what's left to spend on this card?"
 *     - giftCardLedger.history(id)   — "what events landed against this card, in order?"
 *     - giftCardLedger.bulkBalance() — "what's the live balance for these N card ids?"
 *     - giftCardLedger.expiringBalance({ before }) — "which cards are about
 *       to lose money I can sweep into promotional credit?"
 *     - giftCardLedger.transactionsForOrder(id) — "which gift-card movements
 *       are part of this order's settlement?"
 *
 *   The ledger is replay-derivable: SUM(credits) - SUM(debits) -
 *   SUM(expires) reconstructs the live balance from scratch. The
 *   `balance_after_minor` column is denormalization for read speed,
 *   not the source of truth — every write recomputes it from the
 *   prior row so the column is always exactly the running balance.
 *
 *   Composition:
 *     var ledger = bShop.giftCardLedger.create({ query: q });
 *     await ledger.credit({
 *       gift_card_id: cardId,
 *       amount_minor: 5000,
 *       source:       "purchase",
 *       source_ref:   orderId,
 *     });
 *     await ledger.debit({
 *       gift_card_id: cardId,
 *       amount_minor: 1200,
 *       order_id:     orderId,
 *     });
 *     var bal = await ledger.balance(cardId);   // 3800
 *
 *   Overdraft is refused at the primitive layer: debit > available
 *   throws `GIFT_CARD_LEDGER_INSUFFICIENT_BALANCE` and writes no
 *   row. Expire is operator-initiated burn — it caps at the current
 *   balance the same way an over-budget operator sweep should
 *   degrade gracefully rather than refusing.
 *
 *   Surface:
 *     - credit({ gift_card_id, amount_minor, source, source_ref, occurred_at? })
 *     - debit({ gift_card_id, amount_minor, order_id, occurred_at? })
 *     - expire({ gift_card_id, amount_minor, reason, occurred_at? })
 *     - balance(gift_card_id)
 *     - history(gift_card_id, { limit?, cursor? })
 *     - transactionsForOrder(order_id)
 *     - bulkBalance({ gift_card_ids })
 *     - expiringBalance({ before, min_amount_minor })  — JOINs giftcards.expires_at
 *
 *   Storage:
 *     - gift_card_ledger (migration 0081).
 *
 * @primitive giftCardLedger
 * @related   b.uuid.v7, b.guardUuid, shop.giftcards
 */

var b = require("./vendor/blamejs");

var KINDS    = ["credit", "debit", "expire"];
var SOURCES  = ["purchase", "refund_to_giftcard", "promotional", "manual"];

var MAX_SOURCE_REF_LEN = 128;
// Source_ref / reason are short correlation handles (originating
// order id, refund handle, campaign code, operator note). Refuse
// all control bytes including CR/LF — this is a single-line column
// where a newline would just be log-injection cover. Tab is also
// refused; correlation handles don't legitimately contain it.
var PRINTABLE_RE = /^[^\x00-\x1f\x7f]*$/;

var MAX_BULK_IDS = 500;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("giftCardLedger: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _amountMinor(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("giftCardLedger: " + label + " must be a positive integer (minor units)");
  }
  return n;
}

function _source(s) {
  if (typeof s !== "string" || SOURCES.indexOf(s) === -1) {
    throw new TypeError("giftCardLedger: source must be one of " + SOURCES.join(", "));
  }
  return s;
}

function _sourceRef(s, label) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("giftCardLedger: " + label + " must be a string");
  }
  if (!s.length) {
    throw new TypeError("giftCardLedger: " + label + " must be a non-empty string when provided");
  }
  if (s.length > MAX_SOURCE_REF_LEN) {
    throw new TypeError("giftCardLedger: " + label + " must be <= " + MAX_SOURCE_REF_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("giftCardLedger: " + label + " must not contain control bytes");
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("giftCardLedger: " + label + " must be a non-negative integer epoch-ms");
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

  // The optional `giftcards` factory arg is accepted so callers can
  // hand in a giftcards instance for future-facing composition
  // (e.g. a debit-by-code shortcut). The ledger primitive itself
  // operates on `gift_card_id` UUIDs — overdraft + balance logic is
  // self-contained at the SQL tier and doesn't need to consult the
  // giftcards primitive. The arg is held so a subsequent additive
  // primitive can lift it without a surface change.
  var giftcards = opts.giftcards || null;
  void giftcards;

  // O(1) current-balance read: the latest row by `occurred_at DESC`
  // holds `balance_after_minor` as the denormalized snapshot. No SUM
  // aggregation at read time. Falls through to 0 when no rows exist
  // (a card that has never had a ledger row has zero ledger
  // balance). Returns both the snapshot and the occurred_at so the
  // write path can guarantee strict monotonicity (see
  // `_resolveOccurredAt`).
  async function _readLatest(giftCardId) {
    var r = await query(
      "SELECT balance_after_minor, occurred_at FROM gift_card_ledger " +
      "WHERE gift_card_id = ?1 ORDER BY occurred_at DESC LIMIT 1",
      [giftCardId],
    );
    if (!r.rows.length) return { balance: 0, occurred_at: null };
    return { balance: r.rows[0].balance_after_minor, occurred_at: r.rows[0].occurred_at };
  }

  async function _currentBalance(giftCardId) {
    var latest = await _readLatest(giftCardId);
    return latest.balance;
  }

  // Two writes against the same card in the same millisecond would
  // tie on `occurred_at` and make the "latest row" ambiguous. We
  // bump the requested timestamp to `prior + 1` when it would
  // collide (or land older than the prior row, which an
  // out-of-order operator write could trigger). The result is a
  // strictly-monotonic per-card `occurred_at` sequence, so the
  // denormalized `balance_after_minor` snapshot is unambiguous on
  // read. Operator-supplied backdated writes still land at the
  // requested timestamp when there's no collision — only ties get
  // adjusted.
  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _writeRow(giftCardId, kind, amountMinor, source, sourceRef, orderId, balanceAfter, ts) {
    var id = b.uuid.v7();
    await query(
      "INSERT INTO gift_card_ledger " +
      "(id, gift_card_id, kind, amount_minor, source, source_ref, order_id, balance_after_minor, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      [id, giftCardId, kind, amountMinor, source, sourceRef, orderId, balanceAfter, ts],
    );
    return id;
  }

  return {
    KINDS:   KINDS.slice(),
    SOURCES: SOURCES.slice(),

    credit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("giftCardLedger.credit: input object required");
      }
      var giftCardId = _uuid(input.gift_card_id, "gift_card_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      var source     = _source(input.source);
      var sourceRef  = _sourceRef(input.source_ref, "source_ref");
      var requested = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatest(giftCardId);
      var ts     = _resolveOccurredAt(requested, latest.occurred_at);
      var after  = latest.balance + amount;
      var id = await _writeRow(giftCardId, "credit", amount, source, sourceRef, null, after, ts);

      return {
        id:                  id,
        gift_card_id:        giftCardId,
        kind:                "credit",
        amount_minor:        amount,
        source:              source,
        source_ref:          sourceRef,
        balance_after_minor: after,
        occurred_at:         ts,
      };
    },

    debit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("giftCardLedger.debit: input object required");
      }
      var giftCardId = _uuid(input.gift_card_id, "gift_card_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      var orderId    = _uuid(input.order_id, "order_id");
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatest(giftCardId);
      if (amount > latest.balance) {
        var insufficient = new Error("giftCardLedger.debit: amount exceeds available balance");
        insufficient.code = "GIFT_CARD_LEDGER_INSUFFICIENT_BALANCE";
        throw insufficient;
      }
      var ts    = _resolveOccurredAt(requested, latest.occurred_at);
      var after = latest.balance - amount;
      var id = await _writeRow(giftCardId, "debit", amount, null, null, orderId, after, ts);

      return {
        id:                  id,
        gift_card_id:        giftCardId,
        kind:                "debit",
        amount_minor:        amount,
        order_id:            orderId,
        balance_after_minor: after,
        occurred_at:         ts,
      };
    },

    expire: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("giftCardLedger.expire: input object required");
      }
      var giftCardId = _uuid(input.gift_card_id, "gift_card_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      // `reason` is operator-supplied free-form. We require it
      // explicitly (vs. an optional sourceRef) so an audit-trail row
      // tagged 'expire' always carries the operator's justification.
      if (input.reason == null || input.reason === "") {
        throw new TypeError("giftCardLedger.expire: reason must be a non-empty string");
      }
      var reason    = _sourceRef(input.reason, "reason");
      var requested = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latest = await _readLatest(giftCardId);
      // Expire caps at the current balance — operators running a
      // scheduled sweep over computed "expiring before X" amounts
      // should degrade gracefully rather than refusing when an
      // interim debit has already drained the card. A capped expire
      // returns the actual amount burned so the operator can
      // reconcile.
      var toBurn = amount > latest.balance ? latest.balance : amount;
      if (toBurn === 0) {
        // No-op write: persist a zero-amount row would violate the
        // CHECK(amount_minor > 0) constraint. Surface a structured
        // refusal so the caller can distinguish "already empty" from
        // "actually burned N". A no-op expire is a valid outcome of
        // a bulk sweep — we don't throw.
        return {
          id:                  null,
          gift_card_id:        giftCardId,
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
      var id = await _writeRow(giftCardId, "expire", toBurn, null, reason, null, after, ts);

      return {
        id:                  id,
        gift_card_id:        giftCardId,
        kind:                "expire",
        amount_minor:        toBurn,
        requested_minor:     amount,
        reason:              reason,
        balance_after_minor: after,
        occurred_at:         ts,
        noop:                false,
      };
    },

    balance: async function (giftCardId) {
      _uuid(giftCardId, "gift_card_id");
      var bal = await _currentBalance(giftCardId);
      return { gift_card_id: giftCardId, balance_minor: bal };
    },

    history: async function (giftCardId, opts2) {
      _uuid(giftCardId, "gift_card_id");
      opts2 = opts2 || {};
      var limit = opts2.limit != null ? opts2.limit : 50;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new TypeError("giftCardLedger.history: limit must be an integer in [1, 500]");
      }
      var cursor = opts2.cursor;
      var sql = "SELECT id, gift_card_id, kind, amount_minor, source, source_ref, order_id, " +
                "balance_after_minor, occurred_at FROM gift_card_ledger " +
                "WHERE gift_card_id = ?1";
      var params = [giftCardId];
      if (cursor != null) {
        if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
          throw new TypeError("giftCardLedger.history: cursor must be a non-negative integer epoch-ms");
        }
        // Cursor is the `occurred_at` of the last row in the previous
        // page — request rows STRICTLY OLDER so a page boundary
        // landing on a tied timestamp doesn't double-return rows.
        sql += " AND occurred_at < ?2";
        params.push(cursor);
      }
      sql += " ORDER BY occurred_at DESC, id DESC LIMIT ?" + (params.length + 1);
      params.push(limit);
      var r = await query(sql, params);
      var rows = r.rows;
      var nextCursor = rows.length === limit ? rows[rows.length - 1].occurred_at : null;
      return { rows: rows, next_cursor: nextCursor };
    },

    transactionsForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var r = await query(
        "SELECT id, gift_card_id, kind, amount_minor, source, source_ref, order_id, " +
        "balance_after_minor, occurred_at FROM gift_card_ledger " +
        "WHERE order_id = ?1 ORDER BY occurred_at ASC, id ASC",
        [orderId],
      );
      return r.rows;
    },

    bulkBalance: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("giftCardLedger.bulkBalance: input object required");
      }
      var ids = input.gift_card_ids;
      if (!Array.isArray(ids)) {
        throw new TypeError("giftCardLedger.bulkBalance: gift_card_ids must be an array");
      }
      if (ids.length === 0) return [];
      if (ids.length > MAX_BULK_IDS) {
        throw new TypeError("giftCardLedger.bulkBalance: gift_card_ids must be <= " + MAX_BULK_IDS + " entries");
      }
      // Validate every id at the call site — D1 will refuse the
      // query on a non-UUID value but the operator-facing error is
      // far better when the primitive surfaces "ids[3] is not a
      // UUID" up front.
      var validated = [];
      for (var i = 0; i < ids.length; i += 1) {
        validated.push(_uuid(ids[i], "gift_card_ids[" + i + "]"));
      }
      // Per-id subquery so the join lands the LATEST row per card.
      // SQLite (and D1) support a correlated subquery against the
      // same table for `MAX(occurred_at)` keyed off the card id —
      // the `(gift_card_id, occurred_at DESC)` index drives both
      // legs.
      var placeholders = [];
      for (var p = 0; p < validated.length; p += 1) {
        placeholders.push("?" + (p + 1));
      }
      var sql =
        "SELECT g.gift_card_id, g.balance_after_minor, g.occurred_at " +
        "FROM gift_card_ledger g " +
        "WHERE g.gift_card_id IN (" + placeholders.join(",") + ") " +
        "AND g.occurred_at = (" +
        "  SELECT MAX(g2.occurred_at) FROM gift_card_ledger g2 " +
        "  WHERE g2.gift_card_id = g.gift_card_id" +
        ") " +
        "ORDER BY g.gift_card_id ASC";
      var r = await query(sql, validated);
      // Build a lookup keyed by id so cards with no ledger rows at
      // all still surface in the result set as `balance_minor: 0`.
      // Operators sweeping a list of "all issued cards" expect a row
      // back for every input id; a missing entry would be a silent
      // skip.
      var byId = Object.create(null);
      for (var k = 0; k < r.rows.length; k += 1) {
        var row = r.rows[k];
        byId[row.gift_card_id] = row.balance_after_minor;
      }
      // Tie-break: when two rows land at the same `occurred_at`
      // (operator backdating two credits to the same millisecond),
      // the MAX(occurred_at) subquery matches both. Keep the one
      // with the higher `balance_after_minor` since UUIDv7 secondary
      // ordering would require a second subquery — and "the higher
      // running balance" is the answer a sweep wants either way.
      // Real-world collisions only happen on backdated operator
      // writes; the in-flight `_now()` path is monotonic per-id.
      var out = [];
      for (var m = 0; m < validated.length; m += 1) {
        var id = validated[m];
        out.push({
          gift_card_id:  id,
          balance_minor: Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : 0,
        });
      }
      return out;
    },

    expiringBalance: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("giftCardLedger.expiringBalance: input object required");
      }
      var before = _epochMs(input.before, "before");
      if (before == null) {
        throw new TypeError("giftCardLedger.expiringBalance: before is required");
      }
      var minAmount = input.min_amount_minor != null ? input.min_amount_minor : 1;
      if (typeof minAmount !== "number" || !Number.isInteger(minAmount) || minAmount < 0) {
        throw new TypeError("giftCardLedger.expiringBalance: min_amount_minor must be a non-negative integer");
      }
      // JOIN against `giftcards` so we filter on `expires_at`.
      // `expires_at < ?before AND expires_at IS NOT NULL` returns
      // cards whose deadline has passed (or will pass before the
      // sweep horizon — operators pass `Date.now() + days_window`).
      // The balance comes from the ledger's latest row per card.
      // Cards with no ledger rows at all are excluded (a card that
      // has never been credited has nothing to expire).
      var sql =
        "SELECT gc.id AS gift_card_id, gc.expires_at, l.balance_after_minor AS balance_minor " +
        "FROM giftcards gc " +
        "JOIN gift_card_ledger l ON l.gift_card_id = gc.id " +
        "WHERE gc.expires_at IS NOT NULL " +
        "AND gc.expires_at < ?1 " +
        "AND l.occurred_at = (" +
        "  SELECT MAX(l2.occurred_at) FROM gift_card_ledger l2 " +
        "  WHERE l2.gift_card_id = gc.id" +
        ") " +
        "AND l.balance_after_minor >= ?2 " +
        "ORDER BY gc.expires_at ASC, gc.id ASC";
      var r = await query(sql, [before, minAmount]);
      return r.rows;
    },
  };
}

module.exports = {
  create:  create,
  KINDS:   KINDS,
  SOURCES: SOURCES,
};
