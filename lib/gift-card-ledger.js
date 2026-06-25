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

var SHA3_512_HEX_LEN = 128;
// Genesis anchor for a card's first ledger row. Each gift card is its own
// independent chain — the first row keyed by a `gift_card_id` links to
// ZERO, every subsequent row links to the prior row's row_hash for the
// SAME card.
var ZERO_HASH = "0".repeat(SHA3_512_HEX_LEN);

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

// ---- chain hashing ------------------------------------------------------
//
// Mirrors operator-audit-log's composition exactly: the preimage is
//
//   row_hash = SHA3-512(prev_hash || canonical-json(row-fields))
//
// where row-fields is every persisted ledger column except prev_hash +
// row_hash. `b.auditChain.canonicalize` (RFC 8785 walker, sorted keys,
// hash columns excluded) makes the preimage byte-identical across
// deployments + node versions. We deliberately do NOT use
// b.auditChain.computeRowHash / verifyChain — those expect camelCase
// rowHash / monotonicCounter / nonce columns this snake_case schema does
// not carry; composing canonicalize + sha3Hash directly is the
// snake_case-compatible path.

function _rowFieldsForHash(row) {
  return {
    id:                  row.id,
    gift_card_id:        row.gift_card_id,
    kind:                row.kind,
    amount_minor:        Number(row.amount_minor),
    source:              row.source == null ? null : row.source,
    source_ref:          row.source_ref == null ? null : row.source_ref,
    order_id:            row.order_id == null ? null : row.order_id,
    balance_after_minor: Number(row.balance_after_minor),
    occurred_at:         Number(row.occurred_at),
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
      "SELECT id, balance_after_minor, occurred_at, row_hash FROM gift_card_ledger " +
      "WHERE gift_card_id = ?1 ORDER BY occurred_at DESC, id DESC LIMIT 1",
      [giftCardId],
    );
    if (!r.rows.length) return { id: null, balance: 0, occurred_at: null, row_hash: ZERO_HASH };
    return {
      id:          r.rows[0].id,
      balance:     r.rows[0].balance_after_minor,
      occurred_at: r.rows[0].occurred_at,
      // A legacy pre-chain row carries NULL row_hash — chain forward from
      // ZERO so the first hashed row anchors the chain; verifyChain treats
      // the unhashed legacy prefix as unverifiable (NULL row_hash break)
      // rather than silently trusting it.
      row_hash:    r.rows[0].row_hash == null ? ZERO_HASH : r.rows[0].row_hash,
    };
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

  // How many times a writer re-derives the chain tip when the parent fence
  // refuses its INSERT (another write landed first). Each retry re-reads
  // the tip, so contention resolves in one extra round trip per racing
  // writer; five attempts is far beyond any realistic burst.
  var CHAIN_WRITE_ATTEMPTS = 5;

  // One fenced write attempt against a tip the caller just read. EVERY
  // event kind writes through here so every row participates in the
  // per-card hash chain — prev_hash + row_hash are computed app-side over
  // the fully-resolved tuple and bound explicitly. What makes the
  // app-computed values safe to bind is the chain-parent fence
  // (UNIQUE(gift_card_id, prev_hash), migration 0230): a row's prev_hash
  // names its parent, a chain has exactly one child per parent, so a
  // write derived from a STALE tip collides at the constraint instead of
  // forking the chain or persisting a stale balance_after — the caller
  // re-reads and retries. The debit overdraft gate additionally stays
  // INSIDE the statement (WHERE live-balance >= amount, the correlated
  // subquery — never an app-side check): with the fence it is
  // defense-in-depth, and it is what turns a genuine overdraft into a
  // zero-row refusal rather than a retry loop. Returns one of
  // { written }, { refused } (guard said no against the live tip), or
  // { collided } (tip moved — retry).
  async function _attemptChainedWrite(giftCardId, kind, latest, d) {
    var id = b.uuid.v7();
    var rowHash = _computeRowHash(latest.row_hash, {
      id:                  id,
      gift_card_id:        giftCardId,
      kind:                kind,
      amount_minor:        d.amount,
      source:              d.source,
      source_ref:          d.sourceRef,
      order_id:            d.orderId,
      balance_after_minor: d.after,
      occurred_at:         d.ts,
    });
    var balSub =
      "COALESCE((SELECT balance_after_minor FROM gift_card_ledger " +
      "WHERE gift_card_id = ?2 ORDER BY occurred_at DESC, id DESC LIMIT 1), 0)";
    try {
      var res = await query(
        "INSERT INTO gift_card_ledger " +
        "(id, gift_card_id, kind, amount_minor, source, source_ref, order_id, balance_after_minor, occurred_at, prev_hash, row_hash) " +
        "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 " +
        "WHERE " + (d.guarded ? balSub + " >= ?4" : "1"),
        [id, giftCardId, kind, d.amount, d.source, d.sourceRef, d.orderId, d.after, d.ts, latest.row_hash, rowHash],
      );
      if (Number(res.rowCount || 0) === 0) return { refused: true };
      return { written: { id: id, balance_after_minor: d.after, occurred_at: d.ts } };
    } catch (e) {
      // State-agnostic collision detection — never error-message matching:
      // the production D1 service-binding redacts the SQLite "UNIQUE
      // constraint failed" text to a generic "HTTP 500", so a message regex
      // is blind in prod (it would only match under node:sqlite, where the
      // full text survives). Re-read the tip — if it advanced past the
      // parent we tried to chain off, a competing write claimed our slot (a
      // genuine fence collision) and we retry; if the tip is unchanged the
      // insert failed for another reason, so re-throw.
      var after = await _readLatest(giftCardId);
      if (after.row_hash !== latest.row_hash) return { collided: true };
      throw e;
    }
  }

  // Run a chained write with bounded tip-contention retries. `derive` maps
  // the freshly-read tip to the attempt's concrete fields — or a noop
  // sentinel ({ noop: true }) for writes that degrade gracefully on an
  // empty wallet. Each fence collision re-reads the tip and re-derives, so
  // the values that land are always consistent with the parent they chain
  // off.
  async function _writeChained(giftCardId, kind, derive) {
    for (var attempt = 0; attempt < CHAIN_WRITE_ATTEMPTS; attempt += 1) {
      var latest = await _readLatest(giftCardId);
      var d = derive(latest);
      if (d.noop) return { noop: true, balance: latest.balance };
      var r = await _attemptChainedWrite(giftCardId, kind, latest, d);
      if (r.collided) continue;
      if (r.refused) return { refused: true };
      return r.written;
    }
    var contention = new Error("giftCardLedger." + kind + ": persistent chain-tip contention — retry the write");
    contention.code = "GIFT_CARD_LEDGER_CONTENTION";
    throw contention;
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

      var w = await _writeChained(giftCardId, "credit", function (latest) {
        return {
          amount:    amount,
          source:    source,
          sourceRef: sourceRef,
          orderId:   null,
          after:     latest.balance + amount,
          ts:        _resolveOccurredAt(requested, latest.occurred_at),
          guarded:   false,
        };
      });

      return {
        id:                  w.id,
        gift_card_id:        giftCardId,
        kind:                "credit",
        amount_minor:        amount,
        source:              source,
        source_ref:          sourceRef,
        balance_after_minor: w.balance_after_minor,
        occurred_at:         w.occurred_at,
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

      // The overdraft gate stays INSIDE the guarded INSERT (live correlated
      // subquery — never an app-side check), and the debit row now ALSO
      // binds prev_hash/row_hash so it participates in the per-card chain
      // like every other kind: the chain-parent fence is what makes the
      // app-computed values safe (a stale-tip write collides and retries
      // instead of forking the chain). A zero-row refusal against the live
      // tip is a genuine overdraft — either always insufficient, or the
      // loser of a race whose winner drained the balance.
      var w = await _writeChained(giftCardId, "debit", function (latest) {
        return {
          amount:    amount,
          source:    null,
          sourceRef: null,
          orderId:   orderId,
          after:     latest.balance - amount,
          ts:        _resolveOccurredAt(requested, latest.occurred_at),
          guarded:   true,
        };
      });
      if (w.refused) {
        var insufficient = new Error("giftCardLedger.debit: amount exceeds available balance");
        insufficient.code = "GIFT_CARD_LEDGER_INSUFFICIENT_BALANCE";
        throw insufficient;
      }
      return {
        id:                  w.id,
        gift_card_id:        giftCardId,
        kind:                "debit",
        amount_minor:        amount,
        order_id:            orderId,
        balance_after_minor: w.balance_after_minor,
        occurred_at:         w.occurred_at,
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

      // Expire caps at the current balance — operators running a scheduled
      // sweep over computed "expiring before X" amounts degrade gracefully
      // rather than refusing when an interim debit has already drained the
      // card. The cap re-derives on every fence retry, so the burn is
      // always consistent with the tip it chains off. An empty wallet is
      // the structured no-op below, never a throw — a zero-amount row
      // would violate CHECK(amount_minor > 0), and a no-op expire is a
      // valid outcome of a bulk sweep.
      var burned = { amount: 0 };
      var w = await _writeChained(giftCardId, "expire", function (latest) {
        var toBurn = amount > latest.balance ? latest.balance : amount;
        if (toBurn === 0) return { noop: true };
        burned.amount = toBurn;
        return {
          amount:    toBurn,
          source:    null,
          sourceRef: reason,
          orderId:   null,
          after:     latest.balance - toBurn,
          ts:        _resolveOccurredAt(requested, latest.occurred_at),
          guarded:   false,
        };
      });
      if (w.noop) {
        return {
          id:                  null,
          gift_card_id:        giftCardId,
          kind:                "expire",
          amount_minor:        0,
          requested_minor:     amount,
          reason:              reason,
          balance_after_minor: w.balance,
          occurred_at:         requested,
          noop:                true,
        };
      }

      return {
        id:                  w.id,
        gift_card_id:        giftCardId,
        kind:                "expire",
        amount_minor:        burned.amount,
        requested_minor:     amount,
        reason:              reason,
        balance_after_minor: w.balance_after_minor,
        occurred_at:         w.occurred_at,
        noop:                false,
      };
    },

    // Recompute one card's hash chain and flag the first divergence — the
    // tamper-evidence READ side of the chain the writers maintain. Walks
    // the card's rows in (occurred_at, id) order; rows from before the
    // chain columns existed (NULL row_hash) are tolerated as an
    // unverifiable legacy PREFIX and counted, but once a hashed row
    // appears every later row must link — an unhashed row after the
    // anchor, a prev_hash that doesn't name its parent, or a row_hash
    // that doesn't recompute is a break. A populated ledger that never
    // anchors (every row NULL-hashed — the shape a full-ledger rewrite
    // leaves behind) fails: an all-NULL chain is unanchored, not valid.
    // An empty ledger (zero rows) is the only no-anchor case that passes.
    // O(n) per card; operator-audit use, not hot-path.
    verifyChain: async function (giftCardId) {
      _uuid(giftCardId, "gift_card_id");
      var r = await query(
        "SELECT * FROM gift_card_ledger WHERE gift_card_id = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [giftCardId],
      );
      var rows = r.rows;
      var legacyPrefix = 0;
      var anchored = false;
      var prevHash = ZERO_HASH;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (!anchored && row.row_hash == null) { legacyPrefix += 1; continue; }
        anchored = true;
        var breakBase = {
          ok:             false,
          rows_verified:  i - legacyPrefix,
          legacy_prefix:  legacyPrefix,
          break_at:       i,
          break_row_id:   row.id,
        };
        if (row.row_hash == null) {
          return Object.assign(breakBase, { reason: "unhashed row after chain anchor" });
        }
        if (row.prev_hash !== prevHash) {
          return Object.assign(breakBase, {
            reason:   "prev_hash mismatch",
            expected: prevHash,
            actual:   row.prev_hash,
          });
        }
        var computed = _computeRowHash(prevHash, {
          id:                  row.id,
          gift_card_id:        row.gift_card_id,
          kind:                row.kind,
          amount_minor:        row.amount_minor,
          source:              row.source,
          source_ref:          row.source_ref,
          order_id:            row.order_id,
          balance_after_minor: row.balance_after_minor,
          occurred_at:         row.occurred_at,
        });
        if (computed !== row.row_hash) {
          return Object.assign(breakBase, {
            reason:   "row_hash mismatch",
            expected: computed,
            actual:   row.row_hash,
          });
        }
        prevHash = row.row_hash;
      }
      // A populated ledger that never anchored has no cryptographic root to
      // verify against — every row read as an unverifiable legacy prefix.
      // That's the shape a full-ledger rewrite produces (clear every
      // row_hash, then edit balances freely): an all-NULL chain is
      // unanchored, not "valid". Only a genuinely empty ledger (zero rows)
      // is legitimately ok with no anchor.
      if (!anchored && rows.length > 0) {
        return {
          ok:             false,
          rows_verified:  0,
          legacy_prefix:  legacyPrefix,
          break_at:       0,
          break_row_id:   rows[0].id,
          reason:         "unanchored chain (no hashed row in a populated ledger)",
        };
      }
      return {
        ok:            true,
        rows_verified: rows.length - legacyPrefix,
        legacy_prefix: legacyPrefix,
        last_hash:     prevHash,
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
