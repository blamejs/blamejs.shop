"use strict";
/**
 * @module shop.giftcards
 * @title  Gift cards primitive — issue and redeem prepaid balance
 *
 * @intro
 *   A gift card is a bearer credential. Whoever knows the plaintext
 *   code can spend the balance — so the shop never stores it. On
 *   `issue` we generate a 16-character alphanumeric code from
 *   `b.crypto.generateBytes`, store the
 *   `b.crypto.namespaceHash("giftcard-code", plaintext)` digest, and
 *   return the plaintext exactly once. The issuer is responsible for
 *   delivering it to the recipient (email, paper insert, etc.).
 *
 *   The `code_hint` is the last 4 plaintext characters — useful when
 *   an operator triaging a support request needs to identify which
 *   row the customer is asking about. Four characters of a 32-letter
 *   alphabet is 2^20 ≈ one-in-a-million space, far too small to
 *   enable brute-force recovery of the remaining 12.
 *
 *   Recipients without an account are addressed by an email-hash
 *   (`b.crypto.namespaceHash("giftcard-recipient", email)`) so a
 *   stolen D1 dump leaks no recipient addresses while still letting
 *   the storefront resolve "this address owns these cards" after the
 *   recipient registers.
 *
 *   Composition:
 *     var gc = bShop.giftcards.create({ query: q });
 *     var { id, code, code_hint } = await gc.issue({
 *       amount_minor: 5000, currency: "USD", issued_to_email: "alice@example.com",
 *     });
 *     // deliver `code` to the recipient. Never readable again.
 *     var view = await gc.balance(code);
 *     var { remaining_balance_minor, redemption_id } =
 *       await gc.redeem({ code: code, order_id: orderId, amount_minor: 2500 });
 *
 *   Display formatting (`XXXX-XXXX-XXXX-XXXX`) is purely cosmetic —
 *   redemption + balance + lookup all strip hyphens (and ASCII
 *   whitespace) before hashing, so a customer who types the dashes
 *   back in works without special handling.
 */

var b = require("./vendor/blamejs");

var CODE_NAMESPACE      = "giftcard-code";
var RECIPIENT_NAMESPACE = "giftcard-recipient";

// Alphabet excludes 0/O/I/1 so a code spoken aloud / read off a
// printed insert doesn't collapse into ambiguous characters. 32
// glyphs means each byte modulo-32 lands on a uniform draw (256 is a
// multiple of 32 — no modulo-bias correction needed).
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var CODE_LEN      = 16;
var CODE_HINT_LEN = 4;
var CODE_ALPHABET_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;

var CURRENCY_RE = /^[A-Z]{3}$/;
var STATUSES    = ["active", "redeemed", "expired", "voided"];

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("giftcards: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _amountMinor(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("giftcards: " + label + " must be a positive integer (minor units)");
  }
  return n;
}

function _currency(c) {
  // ISO 4217 alpha-3, uppercase. Matches the storage CHECK
  // (length(currency) = 3) and the operator-facing convention.
  if (typeof c !== "string" || !CURRENCY_RE.test(c)) {
    throw new TypeError("giftcards: currency must be 3-letter uppercase ISO 4217");
  }
  return c;
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("giftcards: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _expiresAt(ts) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts <= 0) {
    throw new TypeError("giftcards: expires_at must be a positive integer epoch-ms or null");
  }
  return ts;
}

function _now() { return Date.now(); }

// ---- code generation + canonicalization ---------------------------------

// Map random bytes to the 32-character alphabet. 256 % 32 === 0 so
// each modulo lands on a uniform alphabet index — no rejection
// sampling needed. Routes through `b.crypto.generateBytes` (SHAKE256
// over OS-RNG) for defense-in-depth over the bare OS RNG.
function _generateCode() {
  var buf = b.crypto.generateBytes(CODE_LEN);
  var out = "";
  for (var i = 0; i < CODE_LEN; i += 1) {
    out += CODE_ALPHABET.charAt(buf[i] & 31);
  }
  return out;
}

// Display form: XXXX-XXXX-XXXX-XXXX. Pure cosmetic — the hash
// derivation runs on the canonicalized (hyphen-stripped) form.
function _formatCode(plain) {
  return plain.slice(0, 4) + "-" + plain.slice(4, 8) + "-" + plain.slice(8, 12) + "-" + plain.slice(12, 16);
}

// Strip hyphens + ASCII whitespace so a customer who types the
// dashes (or pastes with a trailing newline) works without special
// handling. Returns the canonical 16-character uppercase code, or
// throws if the result isn't a well-formed alphabet draw.
function _canonicalCode(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("giftcards: code must be a non-empty string");
  }
  // Operator-facing affordance: tolerate hyphens + ASCII whitespace
  // anywhere. Anything else (including unicode whitespace, control
  // bytes, or out-of-alphabet glyphs) is a refusal — we don't want a
  // sloppy normalizer to map two distinct codes to the same hash.
  var stripped = input.replace(/[-\s]+/g, "").toUpperCase();
  if (stripped.length !== CODE_LEN) {
    throw new TypeError("giftcards: code must be " + CODE_LEN + " alphabet characters (hyphens optional)");
  }
  if (!CODE_ALPHABET_RE.test(stripped)) {
    throw new TypeError("giftcards: code contains characters outside the gift-card alphabet");
  }
  return stripped;
}

function _hashCode(canonical) {
  return b.crypto.namespaceHash(CODE_NAMESPACE, canonical);
}

function _hashRecipient(email) {
  // Recipient email is a free-form operator-supplied string at this
  // tier; the storefront route layer is responsible for guardEmail
  // validation before issuing the card. Here we only enforce
  // shape-tier: non-empty, no control bytes (the namespaceHash
  // primitive refuses CR/LF itself).
  if (typeof email !== "string" || !email.length) {
    throw new TypeError("giftcards: issued_to_email must be a non-empty string when provided");
  }
  // Lowercase the address before hashing so two casings of the same
  // recipient collide on lookup. Local-part case sensitivity (RFC
  // 5321) is operator-irrelevant for gift-card delivery — operators
  // address the human, not the mailbox.
  return b.crypto.namespaceHash(RECIPIENT_NAMESPACE, email.toLowerCase());
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // `lookup` resolves a plaintext code to the live card row. Returns
  // null on no match. The hash compare itself is constant-time
  // because we go through `b.crypto.namespaceHash` (SHA3-512
  // deterministic) and then SQL = comparison on the hex hash — an
  // attacker who can time the query can't distinguish "no row" from
  // "wrong hash" because both paths execute the same query.
  // We additionally route the hex compare through
  // `b.crypto.timingSafeEqual` for the returned row so a future
  // refactor that adds non-constant-time matching can't slip in.
  async function _lookup(plaintextCode) {
    var canonical = _canonicalCode(plaintextCode);
    var hash = _hashCode(canonical);
    var r = await query(
      "SELECT id, code_hash, balance_minor, currency, status, expires_at " +
      "FROM giftcards WHERE code_hash = ?1",
      [hash],
    );
    if (!r.rows.length) return null;
    var row = r.rows[0];
    // Belt-and-braces: the SQL = already matched, but route the hex
    // strings through timingSafeEqual so the equality check leaves no
    // micro-timing oracle in case a future schema change moves to a
    // collection scan.
    if (!b.crypto.timingSafeEqual(row.code_hash, hash)) return null;
    return {
      id:            row.id,
      balance_minor: row.balance_minor,
      currency:      row.currency,
      status:        row.status,
      expires_at:    row.expires_at,
    };
  }

  return {
    CODE_NAMESPACE:      CODE_NAMESPACE,
    RECIPIENT_NAMESPACE: RECIPIENT_NAMESPACE,
    CODE_ALPHABET:       CODE_ALPHABET,
    CODE_LEN:            CODE_LEN,
    STATUSES:            STATUSES,

    issue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("giftcards.issue: input object required");
      }
      _amountMinor(input.amount_minor, "amount_minor");
      _currency(input.currency);
      var expiresAt = _expiresAt(input.expires_at);

      var issuedToCustomerId = null;
      if (input.issued_to_customer_id != null) {
        issuedToCustomerId = _uuid(input.issued_to_customer_id, "issued_to_customer_id");
      }
      var issuedToEmailHash = null;
      if (input.issued_to_email != null) {
        issuedToEmailHash = _hashRecipient(input.issued_to_email);
      }

      // Allow neither, either, or both. A purely operator-issued card
      // (promotion / refund credit) has no recipient identity at all.

      var id   = b.uuid.v7();
      var code = _generateCode();
      var hash = _hashCode(code);
      var hint = code.slice(CODE_LEN - CODE_HINT_LEN);
      var ts   = _now();

      await query(
        "INSERT INTO giftcards (id, code_hash, code_hint, currency, issued_minor, balance_minor, " +
        "issued_to_customer_id, issued_to_email_hash, expires_at, status, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, 'active', ?9, ?9)",
        [
          id, hash, hint, input.currency, input.amount_minor,
          issuedToCustomerId, issuedToEmailHash, expiresAt, ts,
        ],
      );

      // `code` is returned plaintext exactly ONCE. The issuer
      // delivers it. Subsequent reads against this row only ever see
      // the hash + hint.
      return {
        id:        id,
        code:      _formatCode(code),
        code_hint: hint,
      };
    },

    // Public helper — returns null on no-match (constant-time at the
    // hash layer; see `_lookup`).
    lookup: function (plaintextCode) {
      return _lookup(plaintextCode);
    },

    balance: async function (plaintextCode) {
      var row = await _lookup(plaintextCode);
      if (!row) return null;
      return {
        balance_minor: row.balance_minor,
        currency:      row.currency,
        status:        row.status,
        expires_at:    row.expires_at,
      };
    },

    redeem: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("giftcards.redeem: input object required");
      }
      _amountMinor(input.amount_minor, "amount_minor");
      var orderId = null;
      if (input.order_id != null) orderId = _uuid(input.order_id, "order_id");

      var row = await _lookup(input.code);
      if (!row) {
        var miss = new Error("giftcards.redeem: code not recognized");
        miss.code = "GIFTCARD_NOT_FOUND";
        throw miss;
      }
      if (row.status !== "active") {
        var inactive = new Error("giftcards.redeem: card is " + row.status);
        inactive.code = "GIFTCARD_NOT_ACTIVE";
        throw inactive;
      }
      var ts = _now();
      if (row.expires_at != null && row.expires_at <= ts) {
        // Expired-but-still-flagged-active: lazily transition the
        // row so future reads reflect reality, then refuse this
        // redemption. The transition itself is idempotent — every
        // `redeem`/`balance` caller does the same check.
        await query(
          "UPDATE giftcards SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status = 'active'",
          [ts, row.id],
        );
        var exp = new Error("giftcards.redeem: card is expired");
        exp.code = "GIFTCARD_EXPIRED";
        throw exp;
      }
      if (input.amount_minor > row.balance_minor) {
        var ins = new Error("giftcards.redeem: amount exceeds remaining balance");
        ins.code = "GIFTCARD_INSUFFICIENT_BALANCE";
        throw ins;
      }

      // Atomic decrement guarded by a balance check at the SQL tier
      // so two concurrent redemptions can't double-spend. The
      // `balance_minor >= ?` predicate plus the row-level lock the
      // UPDATE takes means whichever transaction lands second sees
      // rowCount === 0 and we surface as insufficient.
      var dec = await query(
        "UPDATE giftcards SET balance_minor = balance_minor - ?1, " +
        "status = CASE WHEN balance_minor - ?1 = 0 THEN 'redeemed' ELSE status END, " +
        "updated_at = ?2 WHERE id = ?3 AND balance_minor >= ?1 AND status = 'active'",
        [input.amount_minor, ts, row.id],
      );
      if (!b.sql.casWon(dec).won) {
        // Race: another redemption beat us to the balance. Refuse
        // with the same shape as the up-front insufficient check so
        // the caller doesn't have to distinguish "checked then
        // raced" from "always insufficient".
        var raced = new Error("giftcards.redeem: amount exceeds remaining balance");
        raced.code = "GIFTCARD_INSUFFICIENT_BALANCE";
        throw raced;
      }

      var redemptionId = b.uuid.v7();
      try {
        await query(
          "INSERT INTO giftcard_redemptions (id, giftcard_id, order_id, amount_minor, redeemed_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5)",
          [redemptionId, row.id, orderId, input.amount_minor, ts],
        );
      } catch (insErr) {
        // The balance was already debited by the atomic UPDATE above. The
        // insert threw — but on an autocommit-per-statement bridge a throw
        // does NOT prove the row didn't commit (a connection reset while
        // returning the response, or a retry that then collides on the
        // redemption-id primary key, both surface as a throw over a row that
        // actually landed). So DELETE the redemption row by its id FIRST: if
        // it committed, this removes it so a later reverseRedemption can't
        // credit the spend a second time; if it never landed, the delete is a
        // no-op. ONLY THEN re-credit the card (and un-terminate it if this
        // debit had zeroed it), making the redeem all-or-nothing either way.
        // Deleting before crediting is deliberate: crediting first and then
        // failing to delete would leave a live row against a full balance —
        // the double-credit this guards against.
        await query("DELETE FROM giftcard_redemptions WHERE id = ?1", [redemptionId]);
        await query(
          "UPDATE giftcards SET balance_minor = balance_minor + ?1, " +
          "status = CASE WHEN status = 'redeemed' THEN 'active' ELSE status END, " +
          "updated_at = ?2 WHERE id = ?3",
          [input.amount_minor, _now(), row.id],
        );
        throw insErr;
      }

      var remaining = row.balance_minor - input.amount_minor;
      return {
        remaining_balance_minor: remaining,
        redemption_id:           redemptionId,
      };
    },

    // Credit a card's spend back when the order that redeemed it never
    // completed (abandoned / cancelled / refunded). `redeem` debited the
    // card row's balance at checkout; if the order dies, that money must
    // return to the card or the customer's balance is silently gone.
    //
    // Keyed on the ORDER id — the order FSM drives this on its cancel /
    // refund edges (the same transitions that release inventory holds), so
    // reversal is transition-driven, not a separate operator action. Every
    // unreversed redemption against the order is restored.
    //
    // Idempotent + concurrency-safe: each redemption is claimed with
    // `WHERE id = ? AND reversed_at IS NULL` and the rowCount checked, so a
    // double-fire (the stale-order reaper racing a payment-failed webhook,
    // or a re-delivered cancel) credits the balance back exactly once. The
    // balance restore is itself bounded by the card's issued_minor CHECK, so
    // it can never push the card above its original face value. A card that
    // had drained to `redeemed` is reactivated since it now carries balance
    // again. Returns the list of reversed redemptions (empty when there was
    // nothing to reverse — an order that used no gift card, or one already
    // fully reversed).
    reverseRedemption: async function (orderId) {
      _uuid(orderId, "order_id");
      var rows = (await query(
        "SELECT id, giftcard_id, amount_minor FROM giftcard_redemptions " +
        "WHERE order_id = ?1 AND reversed_at IS NULL",
        [orderId],
      )).rows;
      var reversed = [];
      for (var i = 0; i < rows.length; i += 1) {
        var red = rows[i];
        var ts = _now();
        // Claim the redemption first — the unreversed predicate is the
        // serialization point so two concurrent reversals can't both credit.
        var claim = await query(
          "UPDATE giftcard_redemptions SET reversed_at = ?1 WHERE id = ?2 AND reversed_at IS NULL",
          [ts, red.id],
        );
        if (!b.sql.casWon(claim).won) continue;   // lost the claim
        // Restore the spendable balance on the card row. Capped at the card's
        // issued_minor by the schema CHECK; the amount restored is exactly
        // what this redemption debited, so it can't exceed the face value.
        // Reactivate a card that had drained to `redeemed` — it carries
        // balance again. A `voided`/`expired` card stays in its terminal
        // status (the balance is restored on the row for reconciliation, but
        // a voided/expired card isn't spendable regardless).
        await query(
          "UPDATE giftcards SET balance_minor = balance_minor + ?1, " +
          "status = CASE WHEN status = 'redeemed' THEN 'active' ELSE status END, " +
          "updated_at = ?2 WHERE id = ?3",
          [red.amount_minor, ts, red.giftcard_id],
        );
        reversed.push({
          redemption_id: red.id,
          gift_card_id:  red.giftcard_id,
          amount_minor:  red.amount_minor,
        });
      }
      return reversed;
    },

    // Attach a redemption that was debited BEFORE its order existed to the
    // order it paid for. Checkout debits the card pre-charge (the debit is
    // the double-spend gate, so it must land before any money moves) with
    // `order_id` NULL, then links the row here once the order row exists.
    // The link is what the refund/cancel reversers key on — an unlinked
    // redemption is invisible to reverseRedemption / reverseRedemptionProRata.
    // Write-once: only a NULL order_id row accepts a link, so a re-fire or a
    // mistaken second link against a settled redemption is a no-op rather
    // than a silent re-keying. Returns true when the link landed.
    linkRedemptionToOrder: async function (redemptionId, orderId) {
      _uuid(redemptionId, "redemption_id");
      _uuid(orderId, "order_id");
      var res = await query(
        "UPDATE giftcard_redemptions SET order_id = ?1 WHERE id = ?2 AND order_id IS NULL",
        [orderId, redemptionId],
      );
      return b.sql.casWon(res).won;
    },

    // Reverse ONE redemption by its own id — the compensation edge for a
    // pre-charge debit whose checkout failed before the order existed
    // (PaymentIntent refused, order insert threw). reverseRedemption can't
    // reach these rows: it keys on order_id, which is still NULL at that
    // point. Same claim discipline as the order-keyed reversal — the
    // `reversed_at IS NULL` predicate is the serialization point, so a
    // double-fire credits the balance back exactly once — and the same
    // status semantics (a card that drained to `redeemed` reactivates; a
    // voided/expired card keeps its terminal status). Returns the reversed
    // row, or null when the claim was already taken (or the id is unknown).
    reverseRedemptionById: async function (redemptionId) {
      _uuid(redemptionId, "redemption_id");
      var red = (await query(
        "SELECT id, giftcard_id, amount_minor FROM giftcard_redemptions " +
        "WHERE id = ?1 AND reversed_at IS NULL",
        [redemptionId],
      )).rows[0];
      if (!red) return null;
      var ts = _now();
      var claim = await query(
        "UPDATE giftcard_redemptions SET reversed_at = ?1 WHERE id = ?2 AND reversed_at IS NULL",
        [ts, red.id],
      );
      if (!b.sql.casWon(claim).won) return null;   // lost the claim
      await query(
        "UPDATE giftcards SET balance_minor = balance_minor + ?1, " +
        "status = CASE WHEN status = 'redeemed' THEN 'active' ELSE status END, " +
        "updated_at = ?2 WHERE id = ?3",
        [red.amount_minor, ts, red.giftcard_id],
      );
      return {
        redemption_id: red.id,
        gift_card_id:  red.giftcard_id,
        amount_minor:  red.amount_minor,
      };
    },

    // Credit a card's spend back PROPORTIONALLY to a partial refund — the
    // refund-by-amount counterpart to reverseRedemption's all-or-nothing
    // (cancel) release. A full refund (cancel / payment-failed) returns the
    // whole spend; a partial refund must return only the share the refund
    // covers, or a 10%-refunded order would re-mint the entire gift-card
    // value as spendable while the customer keeps 90% of the goods.
    //
    // For each redemption against the order the target cumulative reversal is
    // floor(amount_minor * refunded_minor / order_total_minor), clamped to
    // amount_minor so rounding + a refund that exceeds the recorded total can
    // never credit back more than the card actually paid. The credit is the
    // delta between that target and what's already been reversed
    // (reversed_minor), so a partial-then-final refund sequence converges
    // exactly on the spend without ever over-crediting. reversed_minor is
    // advanced under a guarded UPDATE keyed on the row's live value, so two
    // concurrent reversals can't both credit the same slice (the second sees
    // its expected-prior value no longer matches and re-derives the delta as
    // zero). A redemption that reaches full reversal also stamps reversed_at
    // so the existing (binary) reverseRedemption short-circuits it.
    //
    // Returns the list of redemptions that received a non-zero credit, each
    // with the minor-units credited this call — the caller writes the
    // matching ledger credits. An order that used no gift card, or one
    // already reversed up to the requested proportion, returns [].
    reverseRedemptionProRata: async function (orderId, input) {
      _uuid(orderId, "order_id");
      input = input || {};
      var refundedMinor = input.refunded_minor;
      var orderTotalMinor = input.order_total_minor;
      if (!Number.isInteger(refundedMinor) || refundedMinor < 0) {
        throw new TypeError("giftcards.reverseRedemptionProRata: refunded_minor must be a non-negative integer (minor units)");
      }
      if (!Number.isInteger(orderTotalMinor) || orderTotalMinor <= 0) {
        throw new TypeError("giftcards.reverseRedemptionProRata: order_total_minor must be a positive integer (minor units)");
      }
      // A refund can't exceed the order total; clamp the fraction at 1 so a
      // recorded over-refund (rounding at the provider, a manual adjustment)
      // never targets more than the full spend.
      var effRefunded = refundedMinor > orderTotalMinor ? orderTotalMinor : refundedMinor;
      var rows = (await query(
        "SELECT id, giftcard_id, amount_minor, reversed_minor FROM giftcard_redemptions " +
        "WHERE order_id = ?1",
        [orderId],
      )).rows;
      var credited = [];
      for (var i = 0; i < rows.length; i += 1) {
        var red = rows[i];
        var amount = Number(red.amount_minor);
        var already = Number(red.reversed_minor || 0);
        // Proportional target in minor units. floor so we never round UP
        // into crediting a fraction the refund didn't cover; clamp to the
        // full spend so cumulative reversals can't exceed it.
        var target = Math.floor((amount * effRefunded) / orderTotalMinor);
        if (target > amount) target = amount;
        var delta = target - already;
        if (delta <= 0) continue;   // already reversed to (or past) this proportion
        var ts = _now();
        var nowFull = target >= amount;
        // Claim the slice: advance reversed_minor from its expected prior
        // value so a concurrent reversal can't double-credit. Stamp
        // reversed_at only when the redemption is now fully reversed (so the
        // binary reverseRedemption treats it as done).
        var claim = await query(
          "UPDATE giftcard_redemptions SET reversed_minor = ?1, " +
          "reversed_at = CASE WHEN ?2 = 1 THEN ?3 ELSE reversed_at END " +
          "WHERE id = ?4 AND reversed_minor = ?5",
          [target, nowFull ? 1 : 0, ts, red.id, already],
        );
        if (!b.sql.casWon(claim).won) continue;   // lost the claim to a concurrent reversal
        // Restore the spendable balance on the card row. Capped at the card's
        // issued_minor by the schema CHECK; the cumulative reversed_minor is
        // bounded by amount_minor, so it can't exceed the face value.
        // Reactivate a card drained to `redeemed` — it carries balance again.
        await query(
          "UPDATE giftcards SET balance_minor = balance_minor + ?1, " +
          "status = CASE WHEN status = 'redeemed' THEN 'active' ELSE status END, " +
          "updated_at = ?2 WHERE id = ?3",
          [delta, ts, red.giftcard_id],
        );
        credited.push({
          redemption_id: red.id,
          gift_card_id:  red.giftcard_id,
          amount_minor:  delta,
        });
      }
      return credited;
    },

    "void": async function (id, opts2) {
      opts2 = opts2 || {};
      _uuid(id, "giftcard id");
      var ts = _now();
      // Atomic guarded transition active -> voided. The status='active' fence
      // lives in SQL (mirroring redeem()), so a concurrent redeem or expire
      // that already moved the card to a terminal state is NOT silently
      // overwritten — the prior read-decide-write clobbered a racing
      // redemption (discarding its remaining-balance debit) because the
      // UPDATE omitted the status fence.
      var upd = await query(
        "UPDATE giftcards SET status = 'voided', updated_at = ?1 WHERE id = ?2 AND status = 'active'",
        [ts, id],
      );
      // `opts2.reason` is operator-supplied free-form; it's not persisted on
      // the row (no schema column) but accepted so a future audit-log
      // primitive can ride alongside without a surface change.
      void opts2.reason;
      if (b.sql.casWon(upd).won) {
        var after = await query("SELECT * FROM giftcards WHERE id = ?1", [id]);
        return after.rows[0] || null;
      }
      // Zero rows: the card is missing or already in a terminal state.
      // Re-read to disambiguate and preserve the prior call's contract.
      var r = await query("SELECT * FROM giftcards WHERE id = ?1", [id]);
      if (!r.rows.length) return null;
      var row = r.rows[0];
      if (row.status === "voided") return row;   // idempotent — already voided
      if (row.status === "redeemed") {
        var already = new Error("giftcards.void: card is fully redeemed");
        already.code = "GIFTCARD_ALREADY_REDEEMED";
        throw already;
      }
      // Any other terminal state (e.g. expired) — return the row as-is rather
      // than forcing it to voided over a terminal transition.
      return row;
    },

    // Operator-facing list of issued cards — drives the admin
    // gift-card ledger console. Never returns the code hash or the
    // recipient hash (operators identify a card by its `code_hint` +
    // issued date, not the bearer credential). Newest first. The
    // optional `status` filter narrows to one lifecycle state; the
    // `limit` caps the page (defaults to 100, max 500). This is a
    // read-only projection — no balance math, just the snapshot
    // columns the card row already carries.
    list: async function (opts4) {
      opts4 = opts4 || {};
      var limit = opts4.limit == null ? 100 : opts4.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new TypeError("giftcards.list: limit must be an integer in [1, 500]");
      }
      var sql = "SELECT id, code_hint, currency, issued_minor, balance_minor, status, " +
                "expires_at, created_at, updated_at FROM giftcards";
      var params = [];
      if (opts4.status != null) {
        _status(opts4.status);
        sql += " WHERE status = ?1";
        params.push(opts4.status);
      }
      sql += " ORDER BY created_at DESC LIMIT ?" + (params.length + 1);
      params.push(limit);
      var r = await query(sql, params);
      return r.rows;
    },

    // Fetch a single card by id for the admin detail view — same
    // projection as `list` (no hash). Returns null on no match.
    getById: async function (id) {
      _uuid(id, "giftcard id");
      var r = await query(
        "SELECT id, code_hint, currency, issued_minor, balance_minor, status, " +
        "expires_at, created_at, updated_at FROM giftcards WHERE id = ?1",
        [id],
      );
      return r.rows.length ? r.rows[0] : null;
    },

    listForCustomer: async function (customerId, opts3) {
      _uuid(customerId, "customer_id");
      opts3 = opts3 || {};
      var sql = "SELECT * FROM giftcards WHERE issued_to_customer_id = ?1";
      var params = [customerId];
      if (opts3.status != null) {
        _status(opts3.status);
        sql += " AND status = ?2";
        params.push(opts3.status);
      }
      sql += " ORDER BY created_at DESC";
      var r = await query(sql, params);
      return r.rows;
    },
  };
}

module.exports = {
  create:              create,
  CODE_NAMESPACE:      CODE_NAMESPACE,
  RECIPIENT_NAMESPACE: RECIPIENT_NAMESPACE,
  CODE_ALPHABET:       CODE_ALPHABET,
  CODE_LEN:            CODE_LEN,
  STATUSES:            STATUSES,
};
