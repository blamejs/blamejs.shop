/**
 * Newsletter signups — operator-collected email broadcast list.
 *
 * Composes:
 *   - `b.guardEmail` — RFC-shape validation, length cap, control-
 *     byte refusal. The primitive itself never tries to parse the
 *     address; it delegates the entire shape check to the guard.
 *   - `b.crypto.namespaceHash` — dedupe key. The hash is computed
 *     from the namespace `"newsletter-email"` + the normalised
 *     address (lowercased + trimmed) so two signups for the same
 *     mailbox collapse to a single row regardless of casing
 *     variation. Also keys the unsubscribe-token table off
 *     `"newsletter-unsubscribe"` + the plaintext bearer.
 *   - `b.crypto.generateBytes` + `b.crypto.toBase64Url` — opaque
 *     unsubscribe token generation (24 bytes → 32 base64url chars).
 *   - `b.crypto.timingSafeEqual` — constant-time comparison of the
 *     supplied token hash against the stored row's hash on consume.
 *   - `b.uuid.v7` — row id.
 *
 * Surface:
 *   - `signup({ email, source })` — INSERT-OR-IGNORE; returns
 *     `{ id, status: "new" | "dedup", email_normalized }`.
 *   - `byEmailHash(hash)` — operator lookup.
 *   - `count()` — total non-unsubscribed signups (for the live
 *     newsletter-band stat the home page renders).
 *   - `issueUnsubscribeToken(signup_id)` — mints a one-shot bearer
 *     for the unsubscribe URL. The plaintext token is returned
 *     once; the database stores only the namespaceHash. Default
 *     expiry is one year from issuance.
 *   - `consumeUnsubscribeToken(plaintext)` — single-use exchange.
 *     Marks the token consumed and stamps
 *     `newsletter_signups.unsubscribed_at` for the linked signup.
 *     Returns a structured result with one of the error codes
 *     `"not-found" | "already-consumed" | "expired"`, or `"ok"`
 *     on success.
 *   - `resubscribe({ email })` — clears `unsubscribed_at` for an
 *     existing signup looked up by email hash.
 *
 * Storage:
 *   - `newsletter_signups` (migration `0010_newsletter_signups.sql`).
 *   - `newsletter_unsubscribe_tokens`
 *     (migration `0014_newsletter_unsubscribe_tokens.sql`).
 *
 * @primitive newsletter
 * @related   b.guardEmail, b.crypto.namespaceHash,
 *            b.crypto.timingSafeEqual
 */

"use strict";

var b = require("./vendor/blamejs");

var C = b.constants;

var EMAIL_NAMESPACE         = "newsletter-email";
var UNSUBSCRIBE_NAMESPACE   = "newsletter-unsubscribe";
var UNSUBSCRIBE_TOKEN_BYTES = 24;
var UNSUBSCRIBE_TTL_MS      = C.TIME.days(365);
var MAX_SOURCE_LEN          = 64;
var SOURCE_RE               = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

function _normalizeEmail(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("newsletter: email must be a non-empty string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("newsletter: email must be a non-empty string");
  }
  // Defer the shape check to `b.guardEmail`. The guard refuses
  // control bytes, oversized input, header-injection sequences,
  // and RFC-shape violations. `validate` surfaces a structured
  // `{ ok, issues }` report; we re-raise the first issue's
  // snippet so the caller gets a precise refusal reason rather
  // than the generic sanitize message.
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(trimmed, { profile: "strict" });
  } catch (e) {
    throw new TypeError("newsletter: email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("newsletter: email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(trimmed, { profile: "strict" });
  } catch (e) {
    throw new TypeError("newsletter: email — " + (e && e.message || "refused"));
  }
  return canonical.toLowerCase();
}

function _normalizeSource(s) {
  if (s == null || s === "") return "storefront-footer";
  if (typeof s !== "string") {
    throw new TypeError("newsletter: source must be a string");
  }
  var clean = s.toLowerCase().trim();
  if (clean.length > MAX_SOURCE_LEN) {
    throw new TypeError("newsletter: source must be <= " + MAX_SOURCE_LEN + " chars");
  }
  if (!SOURCE_RE.test(clean)) {
    throw new TypeError("newsletter: source must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/");
  }
  return clean;
}

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  return {
    EMAIL_NAMESPACE: EMAIL_NAMESPACE,

    signup: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("newsletter.signup: input object required");
      }
      var emailNormalized = _normalizeEmail(input.email);
      var source          = _normalizeSource(input.source);
      var emailHash       = b.crypto.namespaceHash(EMAIL_NAMESPACE, emailNormalized);
      var now             = Date.now();

      // Idempotent insert — re-running with the same address is a
      // no-op on the storage side, but the operator's caller might
      // want to distinguish "this address just joined" from "we
      // already had this address" for response copy. The SELECT
      // after the INSERT-OR-IGNORE tells us which one happened.
      var id = b.uuid.v7();
      await query(
        "INSERT OR IGNORE INTO newsletter_signups " +
        "(id, email_hash, email_normalized, source, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, emailHash, emailNormalized, source, now],
      );
      var existing = (await query(
        "SELECT id, created_at FROM newsletter_signups WHERE email_hash = ?1 LIMIT 1",
        [emailHash],
      )).rows[0];
      var status = existing && existing.id === id ? "new" : "dedup";
      return {
        id:               existing ? existing.id : id,
        status:           status,
        email_normalized: emailNormalized,
      };
    },

    byEmailHash: async function (emailHash) {
      if (typeof emailHash !== "string" || !emailHash.length) {
        throw new TypeError("newsletter.byEmailHash: emailHash required");
      }
      var r = await query(
        "SELECT id, email_normalized, source, created_at, unsubscribed_at " +
        "FROM newsletter_signups WHERE email_hash = ?1 LIMIT 1",
        [emailHash],
      );
      return r.rows[0] || null;
    },

    // Total active signups — drives the optional live stat the
    // operator can surface in the newsletter band. Excludes rows
    // where `unsubscribed_at` is non-NULL.
    count: async function () {
      var r = await query(
        "SELECT COUNT(*) AS n FROM newsletter_signups WHERE unsubscribed_at IS NULL",
        [],
      );
      return Number((r.rows[0] || {}).n || 0);
    },

    // Mint a single-use opaque bearer for the unsubscribe URL. The
    // plaintext is returned ONCE — the database stores only its
    // namespaceHash, so re-issuance is impossible (and a leak of
    // the storage layer never reveals the live links the operator
    // emailed out). Caller is responsible for delivering the
    // plaintext through the transactional-email primitive.
    issueUnsubscribeToken: async function (signupId) {
      if (typeof signupId !== "string" || !signupId.length) {
        throw new TypeError("newsletter.issueUnsubscribeToken: signup_id required");
      }
      var row = (await query(
        "SELECT id FROM newsletter_signups WHERE id = ?1 LIMIT 1",
        [signupId],
      )).rows[0];
      if (!row) {
        throw new TypeError("newsletter.issueUnsubscribeToken: signup_id not found");
      }
      var plaintext = b.crypto.toBase64Url(
        b.crypto.generateBytes(UNSUBSCRIBE_TOKEN_BYTES)
      );
      var tokenHash = b.crypto.namespaceHash(UNSUBSCRIBE_NAMESPACE, plaintext);
      var now       = Date.now();
      var expiresAt = now + UNSUBSCRIBE_TTL_MS;
      await query(
        "INSERT INTO newsletter_unsubscribe_tokens " +
        "(token_hash, signup_id, created_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [tokenHash, signupId, now, expiresAt],
      );
      // The plaintext leaves this function exactly once. Callers
      // pass it into the email body; never log it, never persist
      // it server-side — the row above is the only durable handle.
      return { token: plaintext, expires_at: expiresAt };
    },

    // Single-use redeem. Errors are structured (not thrown) because
    // the caller is typically an HTTP handler that needs to render a
    // friendly page for each failure mode. The lookup itself runs
    // off a constant-shape hash → primary-key query; the
    // `timingSafeEqual` re-comparison on hit equalises the on-CPU
    // work between the hit and miss paths so an attacker can't
    // distinguish "this token never existed" from "this token was
    // already used" through the response-latency channel. The
    // plaintext token is never logged or echoed back.
    consumeUnsubscribeToken: async function (plaintext) {
      if (typeof plaintext !== "string" || !plaintext.length) {
        return { ok: false, error: "not-found" };
      }
      var tokenHash = b.crypto.namespaceHash(UNSUBSCRIBE_NAMESPACE, plaintext);
      var row = (await query(
        "SELECT token_hash, signup_id, consumed_at, expires_at " +
        "FROM newsletter_unsubscribe_tokens WHERE token_hash = ?1 LIMIT 1",
        [tokenHash],
      )).rows[0];
      if (!row) {
        // Miss path — burn the same comparison work as the hit
        // path so the latency profile matches. The compared values
        // are deliberately equal-length and equal (the hash
        // against itself); the result is discarded.
        b.crypto.timingSafeEqual(tokenHash, tokenHash);
        return { ok: false, error: "not-found" };
      }
      // Constant-time check of the stored hash against the
      // recomputed hash — defensive belt-and-braces against any
      // future change to the primary-key index implementation.
      var matched = b.crypto.timingSafeEqual(row.token_hash, tokenHash);
      if (!matched) return { ok: false, error: "not-found" };
      if (row.consumed_at != null) {
        return { ok: false, error: "already-consumed" };
      }
      var now = Date.now();
      if (Number(row.expires_at) <= now) {
        return { ok: false, error: "expired" };
      }
      await query(
        "UPDATE newsletter_unsubscribe_tokens SET consumed_at = ?1 " +
        "WHERE token_hash = ?2 AND consumed_at IS NULL",
        [now, tokenHash],
      );
      await query(
        "UPDATE newsletter_signups SET unsubscribed_at = ?1 WHERE id = ?2",
        [now, row.signup_id],
      );
      var signup = (await query(
        "SELECT email_hash FROM newsletter_signups WHERE id = ?1 LIMIT 1",
        [row.signup_id],
      )).rows[0];
      return {
        ok:         true,
        error:      "ok",
        signup_id:  row.signup_id,
        email_hash: signup ? signup.email_hash : null,
      };
    },

    // A subscriber who unsubscribed and changed their mind. The
    // signup row stays the same id — we just clear the
    // `unsubscribed_at` stamp. No new row, no new hash, so the
    // operator's analytics keep continuity. Returns `ok: false`
    // (without throwing) when the address has never signed up; the
    // caller decides whether to surface "you weren't subscribed" or
    // silently create a fresh signup via `.signup({ email })`.
    resubscribe: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("newsletter.resubscribe: input object required");
      }
      var emailNormalized = _normalizeEmail(input.email);
      var emailHash       = b.crypto.namespaceHash(EMAIL_NAMESPACE, emailNormalized);
      var existing = (await query(
        "SELECT id FROM newsletter_signups WHERE email_hash = ?1 LIMIT 1",
        [emailHash],
      )).rows[0];
      if (!existing) return { ok: false };
      await query(
        "UPDATE newsletter_signups SET unsubscribed_at = NULL WHERE id = ?1",
        [existing.id],
      );
      return { ok: true, signup_id: existing.id };
    },
  };
}

module.exports = {
  create: create,
};
