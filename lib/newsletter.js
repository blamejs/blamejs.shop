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
 *     variation.
 *   - `b.uuid.v7` — row id.
 *
 * Surface:
 *   - `signup({ email, source })` — INSERT-OR-IGNORE; returns
 *     `{ id, status: "new" | "dedup", email_normalized }`.
 *   - `byEmailHash(hash)` — operator lookup.
 *   - `count()` — total non-unsubscribed signups (for the live
 *     newsletter-band stat the home page renders).
 *
 * Storage:
 *   - `newsletter_signups` (migration `0010_newsletter_signups.sql`).
 *
 * @primitive newsletter
 * @related   b.guardEmail, b.crypto.namespaceHash
 */

"use strict";

var EMAIL_NAMESPACE = "newsletter-email";
var MAX_SOURCE_LEN  = 64;
var SOURCE_RE       = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

// Lazy framework handle — matches the pattern used by the rest of
// the shop primitives; avoids the `require` cycle that would arise
// from importing `./index` at module-eval time.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

function _normalizeEmail(s) {
  if (typeof s !== "string") {
    throw new TypeError("newsletter: email must be a string");
  }
  var trimmed = s.trim();
  // Defer the shape check to `b.guardEmail`. The guard refuses
  // control bytes, empty input, oversized input, and RFC-shape
  // violations; we just hand it through with the trim already
  // applied so the canonical form lands in storage.
  var checked = _b().guardEmail(trimmed, { profile: "strict" });
  return checked.toLowerCase();
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
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  return {
    EMAIL_NAMESPACE: EMAIL_NAMESPACE,

    signup: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("newsletter.signup: input object required");
      }
      var emailNormalized = _normalizeEmail(input.email);
      var source          = _normalizeSource(input.source);
      var emailHash       = _b().crypto.namespaceHash(EMAIL_NAMESPACE, emailNormalized);
      var now             = Date.now();

      // Idempotent insert — re-running with the same address is a
      // no-op on the storage side, but the operator's caller might
      // want to distinguish "this address just joined" from "we
      // already had this address" for response copy. The SELECT
      // after the INSERT-OR-IGNORE tells us which one happened.
      var id = _b().uuid.v7();
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
  };
}

module.exports = {
  create: create,
};
