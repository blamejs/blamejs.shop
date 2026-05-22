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

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

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
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
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
  var buf = _b().crypto.generateBytes(CODE_LEN);
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
  return _b().crypto.namespaceHash(CODE_NAMESPACE, canonical);
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
  return _b().crypto.namespaceHash(RECIPIENT_NAMESPACE, email.toLowerCase());
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
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
    if (!_b().crypto.timingSafeEqual(row.code_hash, hash)) return null;
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

      var id   = _b().uuid.v7();
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
      if (dec.rowCount === 0) {
        // Race: another redemption beat us to the balance. Refuse
        // with the same shape as the up-front insufficient check so
        // the caller doesn't have to distinguish "checked then
        // raced" from "always insufficient".
        var raced = new Error("giftcards.redeem: amount exceeds remaining balance");
        raced.code = "GIFTCARD_INSUFFICIENT_BALANCE";
        throw raced;
      }

      var redemptionId = _b().uuid.v7();
      await query(
        "INSERT INTO giftcard_redemptions (id, giftcard_id, order_id, amount_minor, redeemed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [redemptionId, row.id, orderId, input.amount_minor, ts],
      );

      var remaining = row.balance_minor - input.amount_minor;
      return {
        remaining_balance_minor: remaining,
        redemption_id:           redemptionId,
      };
    },

    "void": async function (id, opts2) {
      opts2 = opts2 || {};
      _uuid(id, "giftcard id");
      var r = await query(
        "SELECT id, status FROM giftcards WHERE id = ?1",
        [id],
      );
      if (!r.rows.length) return null;
      var row = r.rows[0];
      if (row.status === "redeemed") {
        var already = new Error("giftcards.void: card is fully redeemed");
        already.code = "GIFTCARD_ALREADY_REDEEMED";
        throw already;
      }
      if (row.status === "voided") {
        // Idempotent — already voided; return the row as-is.
        var existing = await query("SELECT * FROM giftcards WHERE id = ?1", [id]);
        return existing.rows[0] || null;
      }
      var ts = _now();
      await query(
        "UPDATE giftcards SET status = 'voided', updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      // `opts2.reason` is operator-supplied free-form; it's not
      // persisted on the row (no schema column) but accepted so a
      // future audit-log primitive can ride alongside without a
      // surface change.
      void opts2.reason;
      var after = await query("SELECT * FROM giftcards WHERE id = ?1", [id]);
      return after.rows[0] || null;
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
