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
 *     - exportForCustomer(customer_id) — DSR export reader: the
 *       subject's balance + full ledger history.
 *     - eraseForCustomer(customer_id, { dry_run? }) — DSR erasure:
 *       RETAINS (financial ledger, legal-obligation basis). Returns
 *       the `{ table, deleted: 0, note }` reader contract.
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

var SHA3_512_HEX_LEN = 128;
// Genesis anchor for a customer's first ledger row. Each customer wallet
// is its own independent chain — the first row links to ZERO, every
// subsequent row links to the prior row's row_hash for the SAME customer.
var ZERO_HASH = "0".repeat(SHA3_512_HEX_LEN);

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

// ---- chain hashing ------------------------------------------------------
//
// row_hash = SHA3-512(prev_hash || canonical-json(row-fields)), mirroring
// shop.giftCardLedger / operator-audit-log. `b.auditChain.canonicalize`
// (RFC 8785 walker, sorted keys, hash columns excluded) makes the preimage
// byte-identical across deployments + node versions. Every persisted column
// except the two hash columns participates, normalized so the write side
// and `verifyChain` produce identical preimages for the same logical row.

function _rowFieldsForHash(row) {
  return {
    id:                  row.id,
    customer_id:         row.customer_id,
    kind:                row.kind,
    amount_minor:        Number(row.amount_minor),
    source:              row.source == null ? null : row.source,
    source_ref:          row.source_ref == null ? null : row.source_ref,
    order_id:            row.order_id == null ? null : row.order_id,
    balance_after_minor: Number(row.balance_after_minor),
    expires_at:          row.expires_at == null ? null : Number(row.expires_at),
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

  // O(1) current-balance read: the latest row by `occurred_at DESC, id
  // DESC` holds `balance_after_minor` as the denormalized snapshot. No SUM
  // aggregation at read time. Falls through to 0 when no rows exist
  // (a customer that has never had a ledger row has zero credit). The id
  // tie-break keeps any legacy same-millisecond rows deterministic; new
  // writes can't tie — _resolveOccurredAt bumps a colliding timestamp to
  // prior+1 app-side before the fenced INSERT. Also returns the tip's
  // row_hash so the write path can chain off it (see _attemptChainedWrite).
  async function _readLatest(customerId) {
    var r = await query(
      "SELECT balance_after_minor, occurred_at, row_hash FROM store_credit_ledger " +
      "WHERE customer_id = ?1 ORDER BY occurred_at DESC, id DESC LIMIT 1",
      [customerId],
    );
    if (!r.rows.length) return { balance: 0, occurred_at: null, row_hash: ZERO_HASH };
    return {
      balance:     r.rows[0].balance_after_minor,
      occurred_at: r.rows[0].occurred_at,
      // A legacy pre-chain row carries NULL row_hash — chain forward from
      // ZERO so the first hashed row anchors the chain; verifyChain treats
      // the unhashed legacy prefix as unverifiable rather than trusting it.
      row_hash:    r.rows[0].row_hash == null ? ZERO_HASH : r.rows[0].row_hash,
    };
  }

  async function _currentBalance(customerId) {
    var latest = await _readLatest(customerId);
    return latest.balance;
  }

  // Strictly-monotonic per-customer occurred_at: a write at or before the
  // prior row's timestamp is bumped to prior+1, so the denormalized
  // balance_after snapshot is unambiguous on read. A backdated operator
  // write still lands at the requested time when there's no collision.
  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  // How many times a writer re-derives the chain tip when the parent fence
  // refuses its INSERT (another write landed first). Each fence round lets
  // exactly ONE racing writer win, so a burst of N concurrent writes to the
  // SAME customer needs up to N rounds — the cap is sized well beyond any
  // realistic same-wallet fan-in (an admin grant + the scheduled expiry
  // sweep + a checkout debit racing at once) so a legitimate burst is never
  // dropped with STORE_CREDIT_CONTENTION. A genuine non-collision insert
  // error re-throws on the first attempt (see _attemptChainedWrite), so a
  // high cap never spins on a real failure.
  var CHAIN_WRITE_ATTEMPTS = 64;

  // One fenced write against the tip the caller just read. The live balance
  // AND the strictly-monotonic occurred_at are computed APP-SIDE and bound
  // explicitly, together with prev_hash + row_hash so every row participates
  // in the per-customer hash chain. What makes the app-computed values safe
  // is the chain-parent fence UNIQUE(customer_id, prev_hash) (migration
  // 0236): a write derived from a STALE tip collides at the constraint
  // instead of forking the chain or persisting a balance computed off a
  // stale snapshot — the caller re-reads and retries. The debit overdraft
  // gate stays INSIDE the statement (the correlated subquery, never a
  // JS-side check): with the fence it is defense-in-depth, and it is what
  // turns a genuine overdraft into a zero-row refusal rather than a retry
  // loop.
  //
  // Collision detection is STATE-AGNOSTIC, never error-message matching:
  // the production D1 service-binding redacts the SQLite "UNIQUE constraint
  // failed" text to a generic "HTTP 500", so on ANY insert error we re-read
  // the tip — if it advanced past the parent we tried to chain off, a
  // competing write claimed our slot (a genuine fence collision) and we
  // retry; if the tip is unchanged the insert failed for another reason, so
  // we re-throw. Returns one of { written }, { refused } (the guard said no
  // against the live tip), or { collided } (tip moved — retry).
  async function _attemptChainedWrite(customerId, kind, latest, d) {
    var id = b.uuid.v7();
    var storedKind = kind === "sweep" ? "expire" : kind;
    var rowHash = _computeRowHash(latest.row_hash, _rowFieldsForHash({
      id:                  id,
      customer_id:         customerId,
      kind:                storedKind,
      amount_minor:        d.amount,
      source:              d.source,
      source_ref:          d.sourceRef,
      order_id:            d.orderId,
      balance_after_minor: d.after,
      expires_at:          d.expiresAt,
      occurred_at:         d.ts,
    }));
    var balSub = "COALESCE((SELECT balance_after_minor FROM store_credit_ledger " +
                 "WHERE customer_id = ?2 ORDER BY occurred_at DESC, id DESC LIMIT 1), 0)";
    try {
      var res = await query(
        "INSERT INTO store_credit_ledger " +
        "(id, customer_id, kind, amount_minor, source, source_ref, order_id, balance_after_minor, expires_at, occurred_at, prev_hash, row_hash) " +
        "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 " +
        "WHERE " + (d.guarded ? balSub + " >= ?4" : "1"),
        [id, customerId, storedKind, d.amount, d.source, d.sourceRef, d.orderId, d.after, d.expiresAt, d.ts, latest.row_hash, rowHash],
      );
      if (Number(res.rowCount || 0) === 0) return { refused: true };
      return { written: { id: id, amount_minor: d.amount, balance_after_minor: d.after, occurred_at: d.ts } };
    } catch (e) {
      var after = await _readLatest(customerId);
      if (after.row_hash !== latest.row_hash) return { collided: true };
      throw e;
    }
  }

  // Run a chained write with bounded tip-contention retries. `derive` maps
  // the freshly-read tip to the attempt's concrete fields (it may be async —
  // the sweep reads its prior-burn sum inside), or returns { noop: true }
  // for a write that degrades gracefully on an empty / already-settled
  // wallet. Each fence collision re-reads the tip and re-derives, so the
  // values that land are always consistent with the parent they chain off.
  async function _writeChained(customerId, kind, derive) {
    for (var attempt = 0; attempt < CHAIN_WRITE_ATTEMPTS; attempt += 1) {
      var latest = await _readLatest(customerId);
      var d = await derive(latest);
      if (d.noop) return { noop: true, balance: latest.balance };
      var r = await _attemptChainedWrite(customerId, kind, latest, d);
      if (r.collided) continue;
      if (r.refused) return { refused: true };
      return r.written;
    }
    var contention = new Error("storeCredit." + kind + ": persistent chain-tip contention — retry the write");
    contention.code = "STORE_CREDIT_CONTENTION";
    throw contention;
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

      var w = await _writeChained(customerId, "credit", function (latest) {
        return {
          amount:    amount,
          source:    source,
          sourceRef: sourceRef,
          orderId:   null,
          expiresAt: expiresAt,
          after:     latest.balance + amount,
          ts:        _resolveOccurredAt(requested, latest.occurred_at),
          guarded:   false,
        };
      });

      return {
        id:                  w.id,
        customer_id:         customerId,
        kind:                "credit",
        amount_minor:        amount,
        source:              source,
        source_ref:          sourceRef,
        expires_at:          expiresAt,
        balance_after_minor: w.balance_after_minor,
        occurred_at:         w.occurred_at,
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

      // The balance gate lives INSIDE the insert (defense-in-depth behind
      // the chain-parent fence) — a refused write covers both "always
      // insufficient" and "a concurrent debit drained it first", with no
      // window between check and write.
      var w = await _writeChained(customerId, "debit", function (latest) {
        return {
          amount:    amount,
          source:    null,
          sourceRef: null,
          orderId:   orderId,
          expiresAt: null,
          after:     latest.balance - amount,
          ts:        _resolveOccurredAt(requested, latest.occurred_at),
          guarded:   true,
        };
      });
      if (w.refused) {
        var insufficient = new Error("storeCredit.debit: amount exceeds available balance");
        insufficient.code = "STORE_CREDIT_INSUFFICIENT_BALANCE";
        throw insufficient;
      }

      return {
        id:                  w.id,
        customer_id:         customerId,
        kind:                "debit",
        amount_minor:        amount,
        order_id:            orderId,
        balance_after_minor: w.balance_after_minor,
        occurred_at:         w.occurred_at,
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

      // Expire caps at the current balance INSIDE the insert — operators
      // running a scheduled sweep over computed "expiring before X"
      // amounts degrade gracefully rather than refusing when an interim
      // debit has already drained the wallet. A refused write (wallet
      // already at zero) is the structured no-op below, never a throw —
      // by design: a no-op expire is a valid outcome of a bulk sweep,
      // and a zero-amount row would violate CHECK(amount_minor > 0).
      var w = await _writeChained(customerId, "expire", function (latest) {
        var burn = amount > latest.balance ? latest.balance : amount;
        // An empty wallet is the structured no-op below, never a throw —
        // a zero-amount row would violate CHECK(amount_minor > 0), and a
        // no-op expire is a valid outcome of a bulk sweep.
        if (burn === 0) return { noop: true };
        return {
          amount:    burn,
          source:    null,
          sourceRef: reason,
          orderId:   null,
          expiresAt: null,
          after:     latest.balance - burn,
          ts:        _resolveOccurredAt(requested, latest.occurred_at),
          guarded:   false,
        };
      });
      if (w.noop) {
        return {
          id:                  null,
          customer_id:         customerId,
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
        customer_id:         customerId,
        kind:                "expire",
        amount_minor:        w.amount_minor,
        requested_minor:     amount,
        reason:              reason,
        balance_after_minor: w.balance_after_minor,
        occurred_at:         w.occurred_at,
        noop:                false,
      };
    },

    balance: async function (customerId) {
      _uuid(customerId, "customer_id");
      var bal = await _currentBalance(customerId);
      return { customer_id: customerId, balance_minor: bal };
    },

    // Recompute one customer's hash chain and flag the first divergence —
    // the tamper-evidence READ side of the chain the writers maintain.
    // Walks the wallet's rows in (occurred_at, id) order; rows from before
    // the chain columns existed (NULL row_hash) are tolerated as an
    // unverifiable legacy PREFIX, but once a hashed row anchors, every
    // later row must link — an unhashed row after the anchor, a prev_hash
    // that doesn't name its parent, or a row_hash that doesn't recompute is
    // a break. A populated ledger that never anchors (every row NULL-hashed
    // — the shape a full-ledger rewrite leaves behind) fails as unanchored;
    // an empty ledger is the only no-anchor case that passes. O(n) per
    // customer; operator-audit use, not hot-path.
    //
    // Optional trusted anchor (opts.anchor = { count, head }) — the ONLY
    // way to detect a TAIL TRUNCATION (deleting the most-recent rows) or a
    // whole-chain replacement, since an append-only chain stays internally
    // consistent after its tail is removed (a deleted latest debit makes
    // balance() revert while the remaining prefix still links). The caller
    // supplies a count + head captured from a trusted prior snapshot of this
    // same result (count = total_rows, head = last_hash) — a periodic
    // operator checkpoint or an out-of-band monitor. The chain row at index
    // count-1 must still carry that head hash, so a truncation BELOW the
    // snapshot is caught even after later valid appends. Without an anchor
    // this verifies INTERNAL consistency only and reports
    // anchor_checked:false so the caller knows truncation was not ruled out
    // (operator-audit-log closes the same gap with signed checkpoints).
    verifyChain: async function (customerId, opts) {
      _uuid(customerId, "customer_id");
      opts = opts || {};
      var anchor = null;
      if (opts.anchor != null) {
        if (typeof opts.anchor !== "object"
            || typeof opts.anchor.count !== "number" || !Number.isInteger(opts.anchor.count) || opts.anchor.count < 1
            || typeof opts.anchor.head !== "string" || opts.anchor.head.length !== SHA3_512_HEX_LEN) {
          throw new TypeError("storeCredit.verifyChain: anchor must be { count: positive integer, head: " + SHA3_512_HEX_LEN + "-hex-char string }");
        }
        anchor = opts.anchor;
      }
      var r = await query(
        "SELECT * FROM store_credit_ledger WHERE customer_id = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [customerId],
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
          ok:            false,
          rows_verified: i - legacyPrefix,
          legacy_prefix: legacyPrefix,
          break_at:      i,
          break_row_id:  row.id,
        };
        if (row.row_hash == null) {
          return Object.assign(breakBase, { reason: "unhashed row after chain anchor" });
        }
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
        return {
          ok:            false,
          rows_verified: 0,
          legacy_prefix: legacyPrefix,
          break_at:      0,
          break_row_id:  rows[0].id,
          reason:        "unanchored chain (no hashed row in a populated ledger)",
        };
      }
      // Internal walk is clean. With a trusted anchor, also rule out a tail
      // truncation below the snapshot: the row at the snapshot's position
      // must still carry the snapshot's head hash (it survives later valid
      // appends), and the chain must not be shorter than the snapshot.
      if (anchor) {
        if (rows.length < anchor.count) {
          return {
            ok:             false,
            rows_verified:  rows.length - legacyPrefix,
            legacy_prefix:  legacyPrefix,
            anchor_checked: true,
            reason:         "row count below anchor (possible tail truncation)",
            expected_count: anchor.count,
            actual_count:   rows.length,
          };
        }
        var anchorRow = rows[anchor.count - 1];
        if (!anchorRow || anchorRow.row_hash !== anchor.head) {
          return {
            ok:             false,
            rows_verified:  rows.length - legacyPrefix,
            legacy_prefix:  legacyPrefix,
            anchor_checked: true,
            reason:         "anchor row hash mismatch (possible tail truncation or divergence)",
            expected:       anchor.head,
            actual:         anchorRow ? anchorRow.row_hash : null,
          };
        }
      }
      return {
        ok:             true,
        rows_verified:  rows.length - legacyPrefix,
        legacy_prefix:  legacyPrefix,
        total_rows:     rows.length,
        last_hash:      prevHash,
        anchor_checked: anchor != null,
      };
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

    // ---- exportForCustomer / eraseForCustomer (DSR) -----------------
    //
    // Subject-access-request hooks consumed by complianceExport. The
    // ledger keys on `customer_id`.
    //
    // exportForCustomer(customer_id) — the subject's current balance +
    // their full ledger history (the financial record of every credit /
    // debit / expire against their wallet). Pure read; the history is
    // capped at the same 500-row ceiling `history()` enforces.
    exportForCustomer: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var bal = await _currentBalance(cid);
      var r = await query(
        "SELECT id, customer_id, kind, amount_minor, source, source_ref, order_id, " +
        "balance_after_minor, expires_at, occurred_at FROM store_credit_ledger " +
        "WHERE customer_id = ?1 ORDER BY occurred_at DESC, id DESC LIMIT 500",
        [cid],
      );
      return { balance_minor: bal, history: r.rows };
    },

    // eraseForCustomer(customer_id, { dry_run }) — store credit is a
    // financial ledger: an audited record of money owed to and spent by
    // the customer, retained under the controller's legal-obligation /
    // accounting basis (the same posture as the loyalty ledger and gift
    // cards in the DSR reader map). Erasure RETAINS — deleting the rows
    // would destroy the proof of a balance the customer may still be
    // entitled to and the accounting trail a tax / chargeback audit
    // needs. Returns `{ table, deleted: 0, note }`; dry_run reports the
    // same retain decision (0 rows would be removed). The customer-
    // identity scrub rides the anonymized customers row.
    eraseForCustomer: async function (customerId, _opts) {
      _uuid(customerId, "customer_id");
      return { table: "store_credit_ledger", deleted: 0, note: "retained-financial-ledger" };
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
      // every expire row. Counting all expire rows here was a bug:
      // an operator-initiated `expire()` (a clawback, a goodwill burn)
      // or any non-sweep expire would be subtracted from the expired-
      // credit total, shrinking the pending burn and leaving genuinely
      // expired credit un-swept. Operator expires + debits already
      // reduced the BALANCE; the live-balance cap inside the write is
      // what keeps the sweep from over-burning when the wallet was
      // partly drained — so they must not also be netted out of the
      // expired pool, or the reduction is double-counted.
      //
      // The pending-burn arithmetic (expired total minus this sweep's
      // own prior output) and the balance cap both run INSIDE the
      // guarded insert, not from a JS-side read. A read-then-write here
      // raced: two concurrent sweeps both read a zero prior-burn before
      // either wrote, both computed the full expired total as pending,
      // and the second's capped write then burned the still-valid
      // (non-expired) credit the first sweep left behind. With the
      // remainder recomputed at insert time, the second sweep serializes
      // behind the first's committed row, sees zero pending, and matches
      // no rows — an idempotent no-op that never touches valid balance.
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

        // The burn amount = (expired total − sweep's own prior burn),
        // capped at the wallet's current balance — all computed INSIDE
        // the guarded insert. Debits between the credit and the sweep
        // may have spent the expired amount already; the write never
        // drives the balance negative, and a wallet already at zero (or
        // a fully-swept expired pool) refuses the write entirely. A
        // refused write is the idempotent skip — no duplicate row, no
        // CHECK > 0 violation; the operator reconciles via history. The
        // expired credits are "first-out" from the operator's POV — the
        // schema doesn't track FIFO at row level, so the audit trail
        // reflects what was actually burned.
        var w = await _writeChained(customerId, "sweep", async function (latest) {
          // Pending burn = this customer's expired-credit total minus the
          // sweep's OWN prior output (expire rows stamped SWEEP_SOURCE_REF),
          // capped at the live balance. The prior-burn sum is read INSIDE
          // the derive so a fence retry recomputes it against the committed
          // tip: a racing second sweep collides, re-reads a now-nonzero
          // swept sum, sees zero pending, and no-ops — never burning the
          // still-valid (non-expired) credit the first sweep left behind.
          // Operator expires + debits already reduced the balance; the
          // balance cap is what keeps the sweep from over-burning a partly
          // drained wallet, so they must not also be netted out of the
          // expired pool (only this sweep's own output is).
          var sweptRow = (await query(
            "SELECT COALESCE(SUM(amount_minor), 0) AS swept FROM store_credit_ledger " +
            "WHERE customer_id = ?1 AND kind = 'expire' AND source_ref = ?2",
            [customerId, SWEEP_SOURCE_REF],
          )).rows[0];
          var pending = expiredTotal - Number(sweptRow.swept || 0);
          if (pending <= 0 || latest.balance <= 0) return { noop: true };
          var burn = pending > latest.balance ? latest.balance : pending;
          return {
            amount:    burn,
            source:    null,
            sourceRef: SWEEP_SOURCE_REF,
            orderId:   null,
            expiresAt: null,
            after:     latest.balance - burn,
            ts:        _resolveOccurredAt(now, latest.occurred_at),
            guarded:   false,
          };
        });
        if (!w || w.noop || w.refused) continue;
        processed.push({
          id:                  w.id,
          customer_id:         customerId,
          amount_minor:        w.amount_minor,
          balance_after_minor: w.balance_after_minor,
          occurred_at:         w.occurred_at,
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
