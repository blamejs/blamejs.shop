"use strict";
/**
 * @module shop.stockAlerts
 * @title  Back-in-stock notification subscriptions
 *
 * @intro
 *   A customer browses a sold-out SKU and clicks "Notify me when back
 *   in stock". The storefront calls `subscribe({ email, sku,
 *   variant_id? })`; the primitive writes a pending row keyed by
 *   `(email_hash, sku, COALESCE(variant_id, ''))` and returns a 32-
 *   character base64url confirmation token. The operator emails the
 *   confirmation link; the customer clicks; the route calls
 *   `confirm(token)` which stamps `confirmed_at`. Later, when stock
 *   for that SKU rises above zero, an operator-driven sweeper
 *   (`scanAndNotify`) walks the confirmed + un-notified subscriptions
 *   for the SKU and hands each one to the `notifications` primitive
 *   (when wired) as an `in-app` enqueue tagged with the recipient's
 *   email_hash. The row stamps `notified_at` and never fires again.
 *
 *   Privacy by construction. The raw email is hashed via
 *   `b.crypto.namespaceHash("stock-alert-email", lowercased_email)`
 *   before any WHERE clause sees it; the lowercased + trimmed
 *   plaintext is stored alongside so the operator can hand the
 *   canonical address to `notifications.enqueue` without a reverse-
 *   lookup table. Operators wrapping at-rest AEAD on top compose
 *   `b.vault.seal` at the route boundary.
 *
 *   Dedupe. Re-subscribing to the same (email, sku, variant) while a
 *   pending or confirmed row exists is a no-op — the existing row's
 *   id + status surface back. Re-subscribing AFTER a notification has
 *   fired (or after the row has been operator-purged via
 *   `cleanupExpired`) writes a fresh row with a fresh token; the
 *   prior row's terminal state is cleared from the unique-index slot
 *   first.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — email hash + token hash.
 *     - `b.crypto.generateBytes` — 24 random bytes →
 *       base64url-encoded to a 32-character plaintext token, used for
 *       BOTH the double-opt-in confirmation token and the unsubscribe
 *       bearer token. Each plaintext is returned ONCE (confirm + unsub
 *       tokens from `subscribe`; a fresh unsub token per fired row from
 *       `scanAndNotify`); only the hashes persist.
 *     - `b.crypto.timingSafeEqual` — constant-time re-comparison of the
 *       stored unsubscribe-token hash against the recomputed hash so the
 *       unknown-token miss path can't be distinguished by latency.
 *     - `b.guardEmail` — strict-profile email validation +
 *       sanitization before normalisation.
 *     - `b.guardUuid` — optional customer_id / variant_id shape gate.
 *     - `b.uuid.v7` — row id.
 *     - `notifications` (optional) — when wired, `scanAndNotify`
 *       hands each fired row to `notifications.enqueue` as an
 *       in-app message keyed by the recipient's email_hash.
 *
 * @primitive stockAlerts
 * @related   b.crypto.namespaceHash, b.crypto.generateBytes,
 *            b.crypto.timingSafeEqual, b.guardEmail, b.guardUuid,
 *            notifications
 */

var EMAIL_NAMESPACE = "stock-alert-email";
var TOKEN_NAMESPACE = "stock-alert-token";
var UNSUB_NAMESPACE = "stock-alert-unsub-token";
var TOKEN_BYTES     = 24;                // 24 raw bytes → 32 base64url chars
var TOKEN_LEN       = 32;
var TOKEN_RE        = /^[A-Za-z0-9_-]{32}$/;
var b = require("./vendor/blamejs");
var DEFAULT_TTL_MS  = b.constants.TIME.days(90);   // 90 days
var SKU_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var MAX_LIST_LIMIT  = 200;
var DEFAULT_LIMIT   = 50;

// ---- helpers ------------------------------------------------------------

function _normaliseEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("stockAlerts: email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("stockAlerts: email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("stockAlerts: email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("stockAlerts: email — " + (e && e.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _validateSku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("stockAlerts: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, <= 128 chars)");
  }
  return s;
}

function _optUuid(s, label) {
  if (s == null || s === "") return null;
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("stockAlerts: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _validateToken(t) {
  if (typeof t !== "string" || !TOKEN_RE.test(t)) {
    throw new TypeError("stockAlerts: confirmation token must be 32 base64url characters");
  }
  return t;
}

function _validateLimit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("stockAlerts: limit must be an integer in 1.." + MAX_LIST_LIMIT);
  }
  return n;
}

function _validateTtlMs(ms) {
  if (ms == null) return DEFAULT_TTL_MS;
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new TypeError("stockAlerts: ttl_ms must be a positive integer epoch-ms delta or null");
  }
  return ms;
}

function _validateNow(n) {
  if (n == null) return Date.now();
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("stockAlerts: now must be a non-negative integer epoch-ms or null");
  }
  return n;
}

function _mintToken() {
  var raw = b.crypto.generateBytes(TOKEN_BYTES);
  return b.crypto.toBase64Url(raw);
}

function _hashEmail(normalised) {
  return b.crypto.namespaceHash(EMAIL_NAMESPACE, normalised);
}

function _hashToken(plaintext) {
  return b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
}

function _hashUnsubToken(plaintext) {
  return b.crypto.namespaceHash(UNSUB_NAMESPACE, plaintext);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var catalog = opts.catalog;
  if (!catalog || !catalog.inventory || typeof catalog.inventory.get !== "function") {
    throw new TypeError("stockAlerts.create: opts.catalog must expose inventory.get(sku)");
  }
  // Optional dep — when wired, scanAndNotify enqueues an in-app
  // notification per fired row. Absent → scanAndNotify still walks
  // the table, stamps `notified_at`, and returns the fired rows so a
  // bespoke dispatcher can take it from there.
  var notifications = opts.notifications || null;
  if (notifications && typeof notifications.enqueue !== "function") {
    throw new TypeError("stockAlerts.create: opts.notifications must expose enqueue(input)");
  }
  var defaultTtl = _validateTtlMs(opts.ttl_ms == null ? null : opts.ttl_ms);

  // The notifications surface keys recipients by an opaque string and
  // hashes them itself. We hand the email_hash as the recipient_id so
  // a stranger looking at the notifications table never sees the raw
  // address; the recipient_id_hash on the notifications row is a
  // re-hash (namespaceHash over the hash) which is still operator-
  // unique-per-recipient.
  var EVENT_TYPE = "stock.back-in-stock";
  var CHANNEL    = "in-app";

  return {
    EMAIL_NAMESPACE: EMAIL_NAMESPACE,
    TOKEN_NAMESPACE: TOKEN_NAMESPACE,
    UNSUB_NAMESPACE: UNSUB_NAMESPACE,
    TOKEN_LEN:       TOKEN_LEN,
    EVENT_TYPE:      EVENT_TYPE,

    // Hash an email without writing — useful when the caller wants to
    // look the row up under the same key without going through
    // `subscribe`. Refuses bad email shapes via the same strict path.
    hashEmail: function (email) {
      return _hashEmail(_normaliseEmail(email));
    },

    // Subscribe to the back-in-stock alert for a SKU (and optionally
    // a specific variant). Returns:
    //   { id, status: "subscribed" | "already-pending" |
    //     "already-confirmed", confirmation_token?, unsubscribe_token?,
    //     email_hash, expires_at }
    // The plaintext `confirmation_token` and `unsubscribe_token` are
    // returned ONLY on a brand-new subscription — the confirmation email
    // carries both (the confirm link + a one-click unsubscribe link). Only
    // their hashes persist. Re-subscriptions surface the existing row's
    // status — operators that want to re-send the confirmation email mint
    // a fresh subscription by calling `unsubscribeByToken` first.
    subscribe: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stockAlerts.subscribe: input object required");
      }
      var emailNorm  = _normaliseEmail(input.email);
      var sku        = _validateSku(input.sku);
      var variantId  = _optUuid(input.variant_id, "variant_id");
      var customerId = _optUuid(input.customer_id, "customer_id");
      var ttlMs      = _validateTtlMs(input.ttl_ms == null ? defaultTtl : input.ttl_ms);
      var now        = _validateNow(input.now);
      var emailHash  = _hashEmail(emailNorm);

      var existing = (await query(
        "SELECT id, confirmed_at, notified_at, expires_at FROM stock_alerts " +
        "WHERE email_hash = ?1 AND sku = ?2 " +
        "AND COALESCE(variant_id, '') = COALESCE(?3, '') LIMIT 1",
        [emailHash, sku, variantId],
      )).rows[0];

      if (existing) {
        var stillLive = existing.notified_at == null && Number(existing.expires_at) > now;
        if (stillLive) {
          return {
            id:         existing.id,
            status:     existing.confirmed_at == null ? "already-pending" : "already-confirmed",
            email_hash: emailHash,
            expires_at: Number(existing.expires_at),
          };
          // Plaintext token is NOT returned on dedupe — the operator's
          // confirmation email landed once; re-sending requires an
          // unsubscribe + fresh subscribe.
        }
        // Prior row is terminal (notified) OR operator-expired but not
        // yet purged. Drop it so the unique-index slot frees and a
        // fresh subscription lands cleanly.
        await query("DELETE FROM stock_alerts WHERE id = ?1", [existing.id]);
      }

      var token      = _mintToken();
      var tokenHash  = _hashToken(token);
      var unsubToken = _mintToken();
      var unsubHash  = _hashUnsubToken(unsubToken);
      var id         = b.uuid.v7();
      var expiresAt  = now + ttlMs;

      await query(
        "INSERT INTO stock_alerts " +
        "(id, email_hash, email_normalised, sku, variant_id, customer_id, " +
        " confirmation_token_hash, unsubscribe_token_hash, confirmed_at, notified_at, expires_at, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, ?10)",
        [id, emailHash, emailNorm, sku, variantId, customerId, tokenHash, unsubHash, expiresAt, now],
      );
      return {
        id:                 id,
        status:             "subscribed",
        email_hash:         emailHash,
        confirmation_token: token,
        unsubscribe_token:  unsubToken,
        expires_at:         expiresAt,
      };
    },

    // Confirm a subscription by its plaintext token. Returns the row
    // when found (with confirmed_at stamped on the in-memory shape) or
    // null when the token doesn't match any row. Re-confirming a row
    // is a no-op — confirmed_at stays at its original value.
    confirm: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stockAlerts.confirm: input object required");
      }
      var token = _validateToken(input.token);
      var now   = _validateNow(input.now);
      var tokenHash = _hashToken(token);
      var row = (await query(
        "SELECT * FROM stock_alerts WHERE confirmation_token_hash = ?1 LIMIT 1",
        [tokenHash],
      )).rows[0];
      if (!row) return null;
      if (row.notified_at != null) {
        // A notified row is terminal; confirming it has no effect on
        // the dispatcher (it already fired). Surface the row so the
        // caller's UI can render "you've already been notified".
        return row;
      }
      if (Number(row.expires_at) <= now) {
        return null;
      }
      if (row.confirmed_at == null) {
        await query(
          "UPDATE stock_alerts SET confirmed_at = ?1 WHERE id = ?2",
          [now, row.id],
        );
        row.confirmed_at = now;
      }
      return row;
    },

    // Unsubscribe by the per-row bearer token carried in the email's
    // unsubscribe link. The token IS the authorization — knowing a
    // victim's email + a SKU is no longer enough to cancel their alert,
    // only the opaque token the shop emailed them is. Resolves the row by
    // the token's namespaceHash and deletes it.
    //
    // Enumeration-safe by construction: a bad-shape, empty, or unknown
    // token returns the SAME `{ removed: false }` shape a valid-but-
    // already-removed token does (idempotent re-click), and the miss path
    // burns the same constant-time comparison as the hit path so the
    // unknown-vs-known distinction doesn't leak through response latency.
    // Never throws on a token argument — the public route renders a
    // uniform "you're unsubscribed" page for every outcome.
    unsubscribeByToken: async function (plaintext) {
      if (typeof plaintext !== "string" || !TOKEN_RE.test(plaintext)) {
        // Bad shape can't match any stored hash — short-circuit to the
        // same no-op the unknown-token path returns. No oracle.
        return { removed: false };
      }
      var unsubHash = _hashUnsubToken(plaintext);
      var row = (await query(
        "SELECT id, unsubscribe_token_hash FROM stock_alerts " +
        "WHERE unsubscribe_token_hash = ?1 LIMIT 1",
        [unsubHash],
      )).rows[0];
      if (!row) {
        // Miss path — burn the same comparison work as the hit path so
        // the latency profile matches (the compared values are equal by
        // construction; the result is discarded).
        b.crypto.timingSafeEqual(unsubHash, unsubHash);
        return { removed: false };
      }
      // Constant-time check of the stored hash against the recomputed
      // hash — belt-and-braces against any future change to the index
      // lookup. A mismatch reads as a miss (uniform no-op).
      if (!b.crypto.timingSafeEqual(row.unsubscribe_token_hash, unsubHash)) {
        return { removed: false };
      }
      var r = await query("DELETE FROM stock_alerts WHERE id = ?1", [row.id]);
      return { removed: Number(r.rowCount || 0) > 0 };
    },

    // Lookup helper for the storefront PDP's toggle state — "is this
    // address already subscribed for this SKU?". Returns
    // `{ subscribed: boolean, status?: "pending" | "confirmed" |
    //   "notified" }`. Expired rows surface as `subscribed: false`.
    isSubscribed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stockAlerts.isSubscribed: input object required");
      }
      var emailNorm = _normaliseEmail(input.email);
      var sku       = _validateSku(input.sku);
      var variantId = _optUuid(input.variant_id, "variant_id");
      var now       = _validateNow(input.now);
      var emailHash = _hashEmail(emailNorm);
      var row = (await query(
        "SELECT confirmed_at, notified_at, expires_at FROM stock_alerts " +
        "WHERE email_hash = ?1 AND sku = ?2 " +
        "AND COALESCE(variant_id, '') = COALESCE(?3, '') LIMIT 1",
        [emailHash, sku, variantId],
      )).rows[0];
      if (!row) return { subscribed: false };
      if (Number(row.expires_at) <= now) return { subscribed: false };
      if (row.notified_at != null) return { subscribed: true, status: "notified" };
      if (row.confirmed_at != null) return { subscribed: true, status: "confirmed" };
      return { subscribed: true, status: "pending" };
    },

    // Operator dashboard — every live subscription for a SKU. Returns
    // the rows ordered (created_at DESC, id DESC). The plaintext
    // token never appears in the result set; only the row metadata
    // (including the email_normalised the operator may need for
    // support triage).
    listForSku: async function (sku, listOpts) {
      _validateSku(sku);
      listOpts = listOpts || {};
      var limit = _validateLimit(listOpts.limit);
      var includeNotified = listOpts.include_notified === true;
      var sql, params;
      if (includeNotified) {
        sql = "SELECT id, email_hash, email_normalised, sku, variant_id, customer_id, " +
              "confirmed_at, notified_at, expires_at, created_at " +
              "FROM stock_alerts WHERE sku = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [sku, limit];
      } else {
        sql = "SELECT id, email_hash, email_normalised, sku, variant_id, customer_id, " +
              "confirmed_at, notified_at, expires_at, created_at " +
              "FROM stock_alerts WHERE sku = ?1 AND notified_at IS NULL " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [sku, limit];
      }
      var rows = (await query(sql, params)).rows;
      return rows;
    },

    // Account-page surface — every subscription tied to a logged-in
    // customer. Anonymous subscriptions (no customer_id) are not
    // returned here; the storefront's account page knows the customer
    // is signed in by definition.
    listForCustomer: async function (customerId, listOpts) {
      var cid = _optUuid(customerId, "customer_id");
      if (cid == null) {
        throw new TypeError("stockAlerts.listForCustomer: customer_id required");
      }
      listOpts = listOpts || {};
      var limit = _validateLimit(listOpts.limit);
      var rows = (await query(
        "SELECT id, email_hash, email_normalised, sku, variant_id, customer_id, " +
        "confirmed_at, notified_at, expires_at, created_at " +
        "FROM stock_alerts WHERE customer_id = ?1 " +
        "ORDER BY created_at DESC, id DESC LIMIT ?2",
        [cid, limit],
      )).rows;
      return rows;
    },

    // Operator-driven sweeper. Walks every pending (confirmed +
    // un-notified + un-expired) subscription whose SKU now has
    // catalog.inventory.stock_on_hand - stock_held > 0 and:
    //   1. mints a fresh unsubscribe bearer token, rotating the row's
    //      unsubscribe_token_hash so the notification email's one-click
    //      unsubscribe link is a live, single-purpose handle (the prior
    //      confirmation-email token is superseded — a notified row is
    //      terminal so its older link is moot anyway),
    //   2. stamps notified_at on the row, and
    //   3. (if notifications is wired) enqueues an in-app message
    //      keyed by the recipient's email_hash.
    // Returns `{ scanned, notified, enqueued, rows }` — `rows` is the
    // shape that fired, post-update, each carrying the plaintext
    // `unsubscribe_token` (returned ONCE here, for the email builder to
    // embed; only the hash persists). The sweeper is idempotent at the
    // row level: a row that's already been notified is skipped.
    scanAndNotify: async function (sweepOpts) {
      sweepOpts = sweepOpts || {};
      var now   = _validateNow(sweepOpts.now);
      var limit = _validateLimit(sweepOpts.limit);
      // Optional sku filter — operators that just restocked a single
      // SKU can scope the sweep instead of walking the whole table.
      var onlySku = null;
      if (sweepOpts.sku != null) {
        onlySku = _validateSku(sweepOpts.sku);
      }

      var sql, params;
      if (onlySku) {
        sql = "SELECT id, email_hash, email_normalised, sku, variant_id, customer_id, " +
              "confirmed_at, notified_at, expires_at, created_at " +
              "FROM stock_alerts " +
              "WHERE sku = ?1 AND confirmed_at IS NOT NULL " +
              "AND notified_at IS NULL AND expires_at > ?2 " +
              "ORDER BY created_at ASC, id ASC LIMIT ?3";
        params = [onlySku, now, limit];
      } else {
        sql = "SELECT id, email_hash, email_normalised, sku, variant_id, customer_id, " +
              "confirmed_at, notified_at, expires_at, created_at " +
              "FROM stock_alerts " +
              "WHERE confirmed_at IS NOT NULL AND notified_at IS NULL " +
              "AND expires_at > ?1 " +
              "ORDER BY created_at ASC, id ASC LIMIT ?2";
        params = [now, limit];
      }
      var pending = (await query(sql, params)).rows;

      // Group by SKU so a single inventory lookup serves every
      // subscription for that SKU. Inventory query failure is
      // drop-silent at the row level — a flapping inventory backend
      // must not poison the sweeper run.
      var bySku = {};
      for (var i = 0; i < pending.length; i += 1) {
        var r = pending[i];
        if (!bySku[r.sku]) bySku[r.sku] = [];
        bySku[r.sku].push(r);
      }

      var fired = [];
      var enqueued = 0;
      var skus = Object.keys(bySku);
      for (var j = 0; j < skus.length; j += 1) {
        var skuKey = skus[j];
        var inv;
        try { inv = await catalog.inventory.get(skuKey); }
        catch (_e) { inv = null; /* drop-silent — bad inventory row skips this SKU's pending alerts this sweep */ }
        if (!inv) continue;
        var available = Number(inv.stock_on_hand || 0) - Number(inv.stock_held || 0);
        if (!(available > 0)) continue;
        var rows = bySku[skuKey];
        for (var k = 0; k < rows.length; k += 1) {
          var row = rows[k];
          // Mint + rotate a fresh unsubscribe bearer for this fired row.
          // The plaintext rides out on the row object (the email builder
          // embeds it); only the hash is durable.
          var rowUnsubToken = _mintToken();
          await query(
            "UPDATE stock_alerts SET notified_at = ?1, unsubscribe_token_hash = ?2 " +
            "WHERE id = ?3 AND notified_at IS NULL",
            [now, _hashUnsubToken(rowUnsubToken), row.id],
          );
          row.notified_at = now;
          row.unsubscribe_token = rowUnsubToken;
          fired.push(row);
          if (notifications) {
            try {
              var payload = {
                sku:        row.sku,
                variant_id: row.variant_id,
                available:  available,
                email:      row.email_normalised,
              };
              var rv = await notifications.enqueue({
                recipient_id: row.email_hash,
                channel:      CHANNEL,
                event_type:   EVENT_TYPE,
                title:        "Back in stock: " + row.sku,
                body:         "",
                payload:      payload,
                scheduled_at: now,
              });
              if (rv && rv.ok) enqueued += 1;
              // ok:false (opted-out) is a documented outcome — the
              // row still stamps notified_at because the customer's
              // opt-out is a "they don't want this signal" decision,
              // not a transient failure to retry.
            } catch (_e) { /* drop-silent — dispatcher failure must not roll back the notified_at stamp */ }
          }
        }
      }

      return {
        scanned:  pending.length,
        notified: fired.length,
        enqueued: enqueued,
        rows:     fired,
      };
    },

    // Operator retention sweep — drop rows whose expires_at < cutoff.
    // Returns the number of rows removed. Confirmed + un-notified
    // rows are eligible the same as un-confirmed ones; once a row is
    // past its expires_at it's stale regardless of state.
    cleanupExpired: async function (sweepOpts) {
      sweepOpts = sweepOpts || {};
      var cutoff = _validateNow(sweepOpts.now);
      var r = await query(
        "DELETE FROM stock_alerts WHERE expires_at < ?1",
        [cutoff],
      );
      return { removed: Number(r.rowCount || 0) };
    },

    // Operator dashboard headline counts. Returns
    // `{ total, pending, confirmed, notified, expired }`. `expired`
    // is computed against `now`; the column doesn't carry a separate
    // 'expired' state — the timestamp is the gate.
    stats: async function (statsOpts) {
      statsOpts = statsOpts || {};
      var now = _validateNow(statsOpts.now);
      var r = await query(
        "SELECT " +
        "  COUNT(*) AS total, " +
        "  SUM(CASE WHEN confirmed_at IS NULL AND notified_at IS NULL AND expires_at > ?1 THEN 1 ELSE 0 END) AS pending, " +
        "  SUM(CASE WHEN confirmed_at IS NOT NULL AND notified_at IS NULL AND expires_at > ?1 THEN 1 ELSE 0 END) AS confirmed, " +
        "  SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END) AS notified, " +
        "  SUM(CASE WHEN expires_at <= ?1 AND notified_at IS NULL THEN 1 ELSE 0 END) AS expired " +
        "FROM stock_alerts",
        [now],
      );
      var row = r.rows[0] || {};
      return {
        total:     Number(row.total     || 0),
        pending:   Number(row.pending   || 0),
        confirmed: Number(row.confirmed || 0),
        notified:  Number(row.notified  || 0),
        expired:   Number(row.expired   || 0),
      };
    },
  };
}

module.exports = {
  create:          create,
  EMAIL_NAMESPACE: EMAIL_NAMESPACE,
  TOKEN_NAMESPACE: TOKEN_NAMESPACE,
  UNSUB_NAMESPACE: UNSUB_NAMESPACE,
  TOKEN_LEN:       TOKEN_LEN,
};
