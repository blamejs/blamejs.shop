"use strict";
/**
 * @module shop.referrals
 * @title  Referrals primitive — refer-a-friend with two-sided rewards
 *
 * @intro
 *   A referrer (an existing customer) issues an 8-character code via
 *   `issueCode`. The shop generates the code from a confusion-
 *   resistant alphabet (no 0/O/I/1 ambiguities) over
 *   `b.crypto.generateBytes` — 256 % 32 === 0 so each byte modulo-32
 *   lands on a uniform alphabet index with no rejection sampling
 *   needed. The plaintext code is the public handle; lookup is case-
 *   insensitive, storage is uppercase.
 *
 *   One active code per referrer is enforced — rotating means
 *   disabling the existing row before a new one issues. Historical
 *   invitations still resolve to their original code so the audit
 *   trail stays intact across rotations.
 *
 *   The referred-friend's email is NEVER persisted plaintext. Only
 *   `b.crypto.namespaceHash("referral-referee", normalized_email)`
 *   reaches storage. Dedupe is on (code_id, email_hash) so the same
 *   friend invited twice by the same referrer collapses to a single
 *   invitation row.
 *
 *   Funnel transitions:
 *     issueCode   -> referral_codes row, status="active"
 *     invite      -> invitation row, reward_status="pending"
 *     trackVisit  -> visited_at populated
 *     trackSignup -> signed_up_at + signed_up_customer_id populated
 *     trackPurchase -> first_purchase_at + first_order_id populated,
 *                     reward_status -> "both-rewarded",
 *                     referrals_count bumped on the code row
 *     rewardReferrer / rewardReferee -> records the operator's chosen
 *                     reward instrument id (gift card / discount /
 *                     credit) for ledger reconciliation
 *
 *   The reward instrument itself (gift card, discount code, ledger
 *   credit) is a separate primitive — this surface only records the
 *   id the operator handed out so a future audit can join across
 *   tables.
 *
 *   Composition:
 *     var refs = bShop.referrals.create({ query: q });
 *     var { code, link } = await refs.issueCode({
 *       referrer_customer_id: customerId,
 *     });
 *     // referrer shares `link` (e.g. https://blamejs.shop/?ref=<code>)
 *     await refs.invite({ code: code, referee_email: "alice@example.com" });
 *     await refs.trackVisit({ code: code });
 *     await refs.trackSignup({ code: code, customer_id: newCustomerId });
 *     await refs.trackPurchase({ customer_id: newCustomerId, order_id: orderId });
 *     await refs.rewardReferrer(invitationId, { reward_id: giftcardId });
 *     await refs.rewardReferee(invitationId, { reward_id: giftcardId });
 */

var b = require("./index").framework;

var REFEREE_NAMESPACE = "referral-referee";

// Alphabet excludes 0/O/I/1 so a code spoken aloud / shared as a URL
// fragment doesn't collapse into ambiguous characters. 32 glyphs
// means each byte modulo-32 lands on a uniform draw (256 % 32 === 0
// — no modulo-bias correction needed).
var DEFAULT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var CODE_LEN         = 8;

var DEFAULT_LINK_BASE = "https://blamejs.shop/?ref=";

var CODE_STATUSES   = ["active", "disabled"];
var REWARD_STATUSES = ["pending", "referrer-rewarded", "both-rewarded", "expired", "voided"];

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("referrals: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("referrals: referee_email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("referrals: referee_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("referrals: referee_email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("referrals: referee_email — " + (e && e.message || "refused"));
  }
  // Full lowercase before hashing. RFC 5321 leaves local-part case
  // sensitive, but referral dedupe is about "did this human already
  // get invited via this code"; treating `FRIEND@example.com` and
  // `friend@example.com` as the same recipient matches operator
  // intuition. Aligns with the newsletter primitive's posture.
  return canonical.toLowerCase();
}

function _now() { return Date.now(); }

// ---- code generation + canonicalization ---------------------------------

function _makeCodeGenerator(alphabet) {
  if (typeof alphabet !== "string" || alphabet.length !== 32) {
    throw new TypeError("referrals: codeAlphabet must be exactly 32 characters (uniform-draw over a random byte)");
  }
  // Guard against operator-supplied alphabets that contain duplicates
  // (which would skew the draw) or lowercase letters (storage is
  // uppercase; lowercase chars would never match a lookup).
  var seen = {};
  for (var i = 0; i < alphabet.length; i += 1) {
    var ch = alphabet.charAt(i);
    if (seen[ch]) {
      throw new TypeError("referrals: codeAlphabet must not contain duplicate characters");
    }
    if (ch !== ch.toUpperCase()) {
      throw new TypeError("referrals: codeAlphabet must be uppercase (codes are stored uppercase)");
    }
    seen[ch] = true;
  }
  return function () {
    var buf = b.crypto.generateBytes(CODE_LEN);
    var out = "";
    for (var j = 0; j < CODE_LEN; j += 1) {
      out += alphabet.charAt(buf[j] & 31);
    }
    return out;
  };
}

// Canonicalize an operator-supplied lookup string into the storage
// form. Strips ASCII whitespace + hyphens (forgiving for hand-typed
// codes pasted from email), uppercases, refuses control bytes /
// unicode whitespace / non-alphabet glyphs.
function _canonicalCode(input, alphabetRe) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("referrals: code must be a non-empty string");
  }
  var stripped = input.replace(/[-\s]+/g, "").toUpperCase();
  if (stripped.length !== CODE_LEN) {
    throw new TypeError("referrals: code must be " + CODE_LEN + " alphabet characters");
  }
  if (!alphabetRe.test(stripped)) {
    throw new TypeError("referrals: code contains characters outside the referral alphabet");
  }
  return stripped;
}

function _alphabetRe(alphabet) {
  // Escape any regex-special characters from the alphabet — the
  // default alphabet has none, but an operator-supplied 32-char set
  // could legally include `]` or `-`.
  var escaped = alphabet.replace(/[\\\]^-]/g, "\\$&");
  return new RegExp("^[" + escaped + "]+$");
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var alphabet = opts.codeAlphabet || DEFAULT_ALPHABET;
  var generateCode = _makeCodeGenerator(alphabet);
  var alphabetRe   = _alphabetRe(alphabet);
  var linkBase = opts.linkBase || DEFAULT_LINK_BASE;
  if (typeof linkBase !== "string" || !linkBase.length) {
    throw new TypeError("referrals: linkBase must be a non-empty string");
  }

  // Idempotent invitation upsert. Two callers (the referrer and a
  // retry) sending the same (code, referee_email) collapse to a
  // single row; the returned id is the existing one on the second
  // call.
  async function _findInvitationByCodeAndEmail(codeId, emailHash) {
    var r = await query(
      "SELECT id, reward_status FROM referral_invitations " +
      "WHERE referral_code_id = ?1 AND referred_email_hash = ?2 LIMIT 1",
      [codeId, emailHash],
    );
    return r.rows[0] || null;
  }

  async function _activeCodeByReferrer(referrerId) {
    var r = await query(
      "SELECT id, code, status FROM referral_codes " +
      "WHERE referrer_customer_id = ?1 AND status = 'active' LIMIT 1",
      [referrerId],
    );
    return r.rows[0] || null;
  }

  async function _codeRowByCode(code) {
    var canonical = _canonicalCode(code, alphabetRe);
    var r = await query(
      "SELECT id, referrer_customer_id, code, status, referrals_count, created_at, updated_at " +
      "FROM referral_codes WHERE code = ?1 LIMIT 1",
      [canonical],
    );
    return r.rows[0] || null;
  }

  function _formatLink(code) {
    return linkBase + code;
  }

  return {
    REFEREE_NAMESPACE: REFEREE_NAMESPACE,
    CODE_ALPHABET:     alphabet,
    CODE_LEN:          CODE_LEN,
    CODE_STATUSES:     CODE_STATUSES,
    REWARD_STATUSES:   REWARD_STATUSES,

    issueCode: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referrals.issueCode: input object required");
      }
      var referrerId = _uuid(input.referrer_customer_id, "referrer_customer_id");
      // One active code per customer. Rotating means the operator
      // calls `disableCode` first; the audit trail of historical
      // invitations is preserved against the original row.
      var existing = await _activeCodeByReferrer(referrerId);
      if (existing) {
        var err = new Error("referrals.issueCode: referrer already has an active code");
        err.code = "REFERRAL_CODE_ALREADY_ACTIVE";
        throw err;
      }
      var id = b.uuid.v7();
      // Generation collisions on an 8-char/32-alphabet space are
      // ~32^8 = 2^40 — vanishingly unlikely, but the UNIQUE constraint
      // on `code` is the safety net. Retry on collision up to a small
      // bound; any caller that exhausts it surfaces the underlying
      // error rather than spinning indefinitely.
      var ts = _now();
      var code;
      var attempts = 0;
      var lastErr;
      while (attempts < 5) {
        attempts += 1;
        code = generateCode();
        try {
          await query(
            "INSERT INTO referral_codes (id, referrer_customer_id, code, status, referrals_count, created_at, updated_at) " +
            "VALUES (?1, ?2, ?3, 'active', 0, ?4, ?4)",
            [id, referrerId, code, ts],
          );
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // UNIQUE-violation: regenerate. Any other error propagates.
          if (!e || !e.message || e.message.indexOf("UNIQUE") === -1) {
            throw e;
          }
        }
      }
      if (lastErr) throw lastErr;
      return {
        id:   id,
        code: code,
        link: _formatLink(code),
      };
    },

    // Operator-side invitation tracking. Stores only the email hash;
    // raw address never reaches storage. Idempotent on (code, email).
    invite: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referrals.invite: input object required");
      }
      var row = await _codeRowByCode(input.code);
      if (!row) {
        var miss = new Error("referrals.invite: code not recognized");
        miss.code = "REFERRAL_CODE_NOT_FOUND";
        throw miss;
      }
      if (row.status !== "active") {
        var inactive = new Error("referrals.invite: code is " + row.status);
        inactive.code = "REFERRAL_CODE_NOT_ACTIVE";
        throw inactive;
      }
      var normalized = _normalizeEmail(input.referee_email);
      var emailHash  = b.crypto.namespaceHash(REFEREE_NAMESPACE, normalized);
      var existing   = await _findInvitationByCodeAndEmail(row.id, emailHash);
      if (existing) {
        return {
          id:                  existing.id,
          referral_code_id:    row.id,
          referred_email_hash: emailHash,
          status:              "dedup",
        };
      }
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO referral_invitations " +
        "(id, referral_code_id, referred_email_hash, invited_at, reward_status) " +
        "VALUES (?1, ?2, ?3, ?4, 'pending')",
        [id, row.id, emailHash, ts],
      );
      return {
        id:                  id,
        referral_code_id:    row.id,
        referred_email_hash: emailHash,
        status:              "new",
      };
    },

    // Recorded when someone lands with `?ref=<code>`. Bumps every
    // pending invitation on this code so the operator's funnel-stat
    // queries reflect the visit. Idempotent: re-running keeps the
    // first `visited_at` (we never overwrite a populated column).
    trackVisit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referrals.trackVisit: input object required");
      }
      var row = await _codeRowByCode(input.code);
      if (!row) {
        var miss = new Error("referrals.trackVisit: code not recognized");
        miss.code = "REFERRAL_CODE_NOT_FOUND";
        throw miss;
      }
      var ts = _now();
      var r = await query(
        "UPDATE referral_invitations SET visited_at = ?1 " +
        "WHERE referral_code_id = ?2 AND visited_at IS NULL",
        [ts, row.id],
      );
      return {
        referral_code_id: row.id,
        updated:          Number(r.rowCount || 0),
      };
    },

    // Recorded when the referred friend creates an account. Matches
    // the most recent pending invitation on the code that doesn't
    // already have a signed_up_customer_id pinned. Returns null if
    // no matching invitation exists (the friend may have arrived
    // organically — caller decides whether to treat as a miss).
    trackSignup: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referrals.trackSignup: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var row = await _codeRowByCode(input.code);
      if (!row) {
        var miss = new Error("referrals.trackSignup: code not recognized");
        miss.code = "REFERRAL_CODE_NOT_FOUND";
        throw miss;
      }
      var ts = _now();
      // Pin the signup to the oldest pending invitation under this
      // code that doesn't have a customer attached yet — the same
      // friend can be invited by multiple referrers, but only one
      // (the code they actually landed through) gets the funnel
      // attribution.
      var candidate = await query(
        "SELECT id FROM referral_invitations " +
        "WHERE referral_code_id = ?1 AND signed_up_customer_id IS NULL " +
        "ORDER BY invited_at ASC LIMIT 1",
        [row.id],
      );
      if (!candidate.rows.length) {
        // No pending invitation — record nothing. The caller can
        // surface this if they want to gate signup-bonuses to known
        // referrals.
        return null;
      }
      var invitationId = candidate.rows[0].id;
      await query(
        "UPDATE referral_invitations " +
        "SET signed_up_at = ?1, signed_up_customer_id = ?2 " +
        "WHERE id = ?3",
        [ts, customerId, invitationId],
      );
      var updated = await query(
        "SELECT id, referral_code_id, signed_up_customer_id, signed_up_at, reward_status " +
        "FROM referral_invitations WHERE id = ?1",
        [invitationId],
      );
      return updated.rows[0] || null;
    },

    // Recorded when a referred customer makes their first qualifying
    // purchase. Transitions reward_status pending -> both-rewarded
    // (the funnel-complete marker; the operator still has to issue
    // the actual reward instrument via rewardReferrer / rewardReferee)
    // and bumps the referrer's referrals_count. Idempotent: a second
    // purchase by the same customer is a no-op (`first_purchase_at`
    // is set only once).
    trackPurchase: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("referrals.trackPurchase: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var orderId    = _uuid(input.order_id, "order_id");

      var r = await query(
        "SELECT id, referral_code_id, reward_status, first_purchase_at " +
        "FROM referral_invitations WHERE signed_up_customer_id = ?1 " +
        "ORDER BY signed_up_at ASC LIMIT 1",
        [customerId],
      );
      if (!r.rows.length) return null;
      var inv = r.rows[0];
      if (inv.first_purchase_at != null) {
        // Already recorded the first qualifying purchase — second
        // and later purchases don't re-trigger the reward funnel.
        return {
          id:                inv.id,
          reward_status:     inv.reward_status,
          first_purchase_at: inv.first_purchase_at,
          status:            "already-recorded",
        };
      }
      var ts = _now();
      await query(
        "UPDATE referral_invitations " +
        "SET first_purchase_at = ?1, first_order_id = ?2, " +
        "reward_status = 'both-rewarded' " +
        "WHERE id = ?3",
        [ts, orderId, inv.id],
      );
      // Bump the referrer's running count. `referrals_count` is the
      // leaderboard key; it counts completed funnels (a friend who
      // signed up but never purchased doesn't count).
      await query(
        "UPDATE referral_codes " +
        "SET referrals_count = referrals_count + 1, updated_at = ?1 " +
        "WHERE id = ?2",
        [ts, inv.referral_code_id],
      );
      var after = await query(
        "SELECT id, referral_code_id, reward_status, first_purchase_at, first_order_id " +
        "FROM referral_invitations WHERE id = ?1",
        [inv.id],
      );
      var out = after.rows[0] || null;
      if (out) out.status = "completed";
      return out;
    },

    // Operator records that the referrer payout has been issued.
    // `reward_id` is opaque (operator's gift-card id, discount-code
    // id, ledger-credit id — whatever instrument they chose). The
    // FSM accepts transitions from any non-terminal state so the
    // operator can pay out before or after the friend's purchase if
    // their reward policy says so.
    rewardReferrer: async function (invitationId, rewardOpts) {
      var id = _uuid(invitationId, "invitation_id");
      if (!rewardOpts || typeof rewardOpts !== "object") {
        throw new TypeError("referrals.rewardReferrer: opts object with reward_id required");
      }
      if (typeof rewardOpts.reward_id !== "string" || !rewardOpts.reward_id.length) {
        throw new TypeError("referrals.rewardReferrer: reward_id must be a non-empty string");
      }
      var r = await query(
        "SELECT id, reward_status, referrer_reward_id, referee_reward_id " +
        "FROM referral_invitations WHERE id = ?1",
        [id],
      );
      if (!r.rows.length) return null;
      var inv = r.rows[0];
      if (inv.reward_status === "expired" || inv.reward_status === "voided") {
        var terminal = new Error("referrals.rewardReferrer: invitation is " + inv.reward_status);
        terminal.code = "REFERRAL_INVITATION_TERMINAL";
        throw terminal;
      }
      // FSM: pending -> referrer-rewarded; if the referee has already
      // been rewarded, transition to both-rewarded (the operator's
      // chosen order doesn't matter).
      var nextStatus = inv.referee_reward_id ? "both-rewarded" : "referrer-rewarded";
      await query(
        "UPDATE referral_invitations " +
        "SET referrer_reward_id = ?1, reward_status = ?2 " +
        "WHERE id = ?3",
        [rewardOpts.reward_id, nextStatus, id],
      );
      var after = await query(
        "SELECT id, reward_status, referrer_reward_id, referee_reward_id " +
        "FROM referral_invitations WHERE id = ?1",
        [id],
      );
      return after.rows[0] || null;
    },

    rewardReferee: async function (invitationId, rewardOpts) {
      var id = _uuid(invitationId, "invitation_id");
      if (!rewardOpts || typeof rewardOpts !== "object") {
        throw new TypeError("referrals.rewardReferee: opts object with reward_id required");
      }
      if (typeof rewardOpts.reward_id !== "string" || !rewardOpts.reward_id.length) {
        throw new TypeError("referrals.rewardReferee: reward_id must be a non-empty string");
      }
      var r = await query(
        "SELECT id, reward_status, referrer_reward_id, referee_reward_id " +
        "FROM referral_invitations WHERE id = ?1",
        [id],
      );
      if (!r.rows.length) return null;
      var inv = r.rows[0];
      if (inv.reward_status === "expired" || inv.reward_status === "voided") {
        var terminal = new Error("referrals.rewardReferee: invitation is " + inv.reward_status);
        terminal.code = "REFERRAL_INVITATION_TERMINAL";
        throw terminal;
      }
      var nextStatus = inv.referrer_reward_id ? "both-rewarded" : inv.reward_status;
      // If the referrer hasn't been rewarded yet, the referee payout
      // alone doesn't advance the funnel state — only both-sides
      // payment lands on "both-rewarded". This keeps the leaderboard
      // and stats coherent: a referee paid early without the referrer
      // ever being paid stays visible in the operator's `referee
      // payments outstanding` queue.
      await query(
        "UPDATE referral_invitations " +
        "SET referee_reward_id = ?1, reward_status = ?2 " +
        "WHERE id = ?3",
        [rewardOpts.reward_id, nextStatus, id],
      );
      var after = await query(
        "SELECT id, reward_status, referrer_reward_id, referee_reward_id " +
        "FROM referral_invitations WHERE id = ?1",
        [id],
      );
      return after.rows[0] || null;
    },

    // Operator lookup. Case-insensitive (lookup folds + uppercases
    // before the SQL query); returns null on miss.
    byCode: async function (code) {
      return await _codeRowByCode(code);
    },

    // Operator action — flip an active code to "disabled". A
    // referrer can then call issueCode to mint a new one. Returns
    // the post-state row, or null if the id doesn't resolve.
    disableCode: async function (codeId) {
      var id = _uuid(codeId, "code_id");
      var ts = _now();
      var r = await query(
        "UPDATE referral_codes SET status = 'disabled', updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      if (Number(r.rowCount || 0) === 0) return null;
      var after = await query(
        "SELECT id, referrer_customer_id, code, status, referrals_count, created_at, updated_at " +
        "FROM referral_codes WHERE id = ?1",
        [id],
      );
      return after.rows[0] || null;
    },

    // Aggregate funnel stats for one referrer across every code
    // they've ever held. Operators surface this on the referrer's
    // account page ("you've invited N friends, M have purchased,
    // your rewards: X").
    statsForReferrer: async function (customerId) {
      var id = _uuid(customerId, "customer_id");
      var codes = await query(
        "SELECT id, code, status, referrals_count, created_at " +
        "FROM referral_codes WHERE referrer_customer_id = ?1",
        [id],
      );
      var totalCompleted = 0;
      for (var i = 0; i < codes.rows.length; i += 1) {
        totalCompleted += Number(codes.rows[i].referrals_count || 0);
      }
      var counts = await query(
        "SELECT COUNT(*) AS total, " +
        "SUM(CASE WHEN visited_at IS NOT NULL THEN 1 ELSE 0 END) AS visited, " +
        "SUM(CASE WHEN signed_up_at IS NOT NULL THEN 1 ELSE 0 END) AS signed_up, " +
        "SUM(CASE WHEN first_purchase_at IS NOT NULL THEN 1 ELSE 0 END) AS purchased, " +
        "SUM(CASE WHEN referrer_reward_id IS NOT NULL THEN 1 ELSE 0 END) AS referrer_rewarded, " +
        "SUM(CASE WHEN referee_reward_id IS NOT NULL THEN 1 ELSE 0 END) AS referee_rewarded " +
        "FROM referral_invitations WHERE referral_code_id IN (" +
        "SELECT id FROM referral_codes WHERE referrer_customer_id = ?1)",
        [id],
      );
      var row = counts.rows[0] || {};
      return {
        customer_id:          id,
        codes:                codes.rows,
        completed_referrals:  totalCompleted,
        invitations_total:    Number(row.total || 0),
        invitations_visited:  Number(row.visited || 0),
        invitations_signed_up: Number(row.signed_up || 0),
        invitations_purchased: Number(row.purchased || 0),
        referrer_rewarded:    Number(row.referrer_rewarded || 0),
        referee_rewarded:     Number(row.referee_rewarded || 0),
      };
    },

    // Top-N referrers by completed referrals (referrals_count is the
    // funnel-complete counter; signups without a first purchase don't
    // count). Defaults to 10; capped at 100 so an operator can't
    // accidentally page through the entire customer base via the
    // public storefront route.
    leaderboard: async function (input) {
      input = input || {};
      var limit = input.limit == null ? 10 : input.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 100) {
        throw new TypeError("referrals.leaderboard: limit must be a positive integer <= 100");
      }
      var r = await query(
        "SELECT referrer_customer_id, SUM(referrals_count) AS completed_referrals " +
        "FROM referral_codes GROUP BY referrer_customer_id " +
        "HAVING SUM(referrals_count) > 0 " +
        "ORDER BY completed_referrals DESC, referrer_customer_id ASC " +
        "LIMIT ?1",
        [limit],
      );
      // Coerce SUM() result to a Number — `node:sqlite` returns BIGINT
      // for SUM() over INTEGER on some Node minor versions, plain
      // Number on others. Normalizing here keeps the operator's
      // downstream JSON serializer from emitting BigInt syntax.
      return r.rows.map(function (row) {
        return {
          referrer_customer_id: row.referrer_customer_id,
          completed_referrals: Number(row.completed_referrals || 0),
        };
      });
    },
  };
}

module.exports = {
  create:            create,
  REFEREE_NAMESPACE: REFEREE_NAMESPACE,
  CODE_ALPHABET:     DEFAULT_ALPHABET,
  CODE_LEN:          CODE_LEN,
  CODE_STATUSES:     CODE_STATUSES,
  REWARD_STATUSES:   REWARD_STATUSES,
};
