"use strict";
/**
 * @module shop.emailSuppressions
 * @title  Email suppression list — opt-out / bounce / complaint gate
 *
 * @intro
 *   The storefront sends transactional mail (order receipt, ship
 *   notification, refund) and marketing mail (newsletter, wishlist-
 *   discount, abandoned-cart, review-request). Every send-time caller
 *   asks this primitive whether the recipient is suppressed before
 *   composing the message, so addresses that hard-bounced, filed an
 *   ISP complaint, opted out of marketing, or were manually shut off
 *   by the operator never see another delivery attempt.
 *
 *   Storage shape:
 *     - `email_hash` (PK) — `b.crypto.namespaceHash("email-
 *       suppression", normalised_email)`. Re-occurrence collapses
 *       onto the same row via `INSERT OR REPLACE`, incrementing
 *       `occurrences` + bumping `last_seen_at` + refreshing `reason`.
 *     - `email_normalized` — lowercased + trimmed plaintext. The raw
 *       input (mixed case, surrounding whitespace) never persists.
 *       Operators authoring application-layer AEAD can wrap this
 *       primitive via `b.vault.seal`; D1's at-rest AEAD covers the
 *       disk layer by default.
 *     - `suppression_type` — `unsubscribe` / `hard-bounce` /
 *       `soft-bounce` / `complaint` / `operator-manual` /
 *       `rate-limit-block`. Operator-debuggable cause.
 *     - `scope` — `all` blocks every outbound mail; `marketing`
 *       blocks newsletter / wishlist-discount / abandoned-cart /
 *       review-request; `transactional` blocks order receipt / ship
 *       notification / refund.
 *     - `expires_at` — NULL for permanent suppressions. `soft-bounce`
 *       and `rate-limit-block` default to operator-supplied windows
 *       (caller supplies; primitive doesn't pick a default).
 *
 *   Composition:
 *     var sup = bShop.emailSuppressions.create({ query: q });
 *     await sup.add({
 *       email: "alice@example.com",
 *       suppression_type: "hard-bounce",
 *       reason: "550 5.1.1 mailbox does not exist",
 *       source: "sendgrid",
 *     });
 *     var view = await sup.isSuppressed({
 *       email: "alice@example.com",
 *       scope: "transactional",
 *     });
 *     // view.suppressed === true; respect it before composing the
 *     // order receipt.
 *
 *   Scope hierarchy:
 *     A row with `scope='all'` suppresses every outbound regardless
 *     of the caller's requested scope. A row with `scope='marketing'`
 *     suppresses only marketing sends; transactional still ships. A
 *     row with `scope='transactional'` is the rare case — usually
 *     only after a hard-bounce when the operator decides not to
 *     retry — and suppresses only transactional sends.
 *
 *   Pagination:
 *     `list({ cursor })` returns an HMAC-tagged cursor signed by
 *     `opts.cursorSecret` so an operator can't hand-craft one to
 *     skip past a hidden row. The secret defaults to a dev-only
 *     placeholder under `NODE_ENV != 'production'`; the deployment
 *     supplies a derived value (typically
 *     `b.crypto.namespaceHash("email-suppressions-cursor",
 *     D1_BRIDGE_SECRET)`).
 *
 * @primitive emailSuppressions
 * @related   b.guardEmail, b.crypto.namespaceHash, b.pagination
 */

var EMAIL_NAMESPACE     = "email-suppression";
var SUPPRESSION_TYPES   = [
  "unsubscribe", "hard-bounce", "soft-bounce",
  "complaint",   "operator-manual", "rate-limit-block",
];
var SCOPES              = ["transactional", "marketing", "all"];
var MAX_REASON_LEN      = 1024;
var MAX_SOURCE_LEN      = 64;
var SOURCE_RE           = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var MAX_LIST_LIMIT      = 200;
var DEFAULT_LIST_LIMIT  = 25;
var LIST_ORDER_KEY      = ["last_seen_at:desc", "email_hash:desc"];

var b = require("./vendor/blamejs");

// ---- validators ---------------------------------------------------------

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("emailSuppressions: email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  // validate first so a critical-severity refusal surfaces with the
  // exact issue; sanitize then folds bidi / zero-width / control
  // codepoints per the strict profile. Lowercase + trim is applied
  // before hashing so two casings collide onto a single row.
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("emailSuppressions: email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("emailSuppressions: email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("emailSuppressions: email — " + (e && e.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _validateType(t) {
  if (typeof t !== "string" || SUPPRESSION_TYPES.indexOf(t) === -1) {
    throw new TypeError(
      "emailSuppressions: suppression_type must be one of " +
      SUPPRESSION_TYPES.join(", ")
    );
  }
  return t;
}

function _validateScope(s, label) {
  if (typeof s !== "string" || SCOPES.indexOf(s) === -1) {
    throw new TypeError(
      "emailSuppressions: " + label + " must be one of " + SCOPES.join(", ")
    );
  }
  return s;
}

function _defaultScopeFor(type) {
  // hard-bounce / soft-bounce / complaint default to transactional —
  // the recipient is failing deliveries, the operator decides not to
  // retry. unsubscribe defaults to marketing — the user opted out of
  // broadcast volume, not transactional receipts. operator-manual
  // and rate-limit-block default to all — the operator's intent is
  // shut-off-completely.
  if (type === "hard-bounce" || type === "soft-bounce" || type === "complaint") {
    return "transactional";
  }
  if (type === "unsubscribe") {
    return "marketing";
  }
  return "all";
}

function _validateReason(r) {
  if (r == null) return "";
  if (typeof r !== "string") {
    throw new TypeError("emailSuppressions: reason must be a string or null");
  }
  if (r.length > MAX_REASON_LEN) {
    throw new TypeError(
      "emailSuppressions: reason must be <= " + MAX_REASON_LEN + " chars"
    );
  }
  // Refuse CR / LF / NUL so a bounce-message echo can't smuggle a
  // header-injection or log-injection vector into operator-visible
  // surfaces.
  if (/[\r\n\0]/.test(r)) {
    throw new TypeError("emailSuppressions: reason must not contain CR / LF / NUL");
  }
  return r;
}

function _validateSource(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string") {
    throw new TypeError("emailSuppressions: source must be a string");
  }
  var clean = s.toLowerCase().trim();
  if (clean.length > MAX_SOURCE_LEN) {
    throw new TypeError(
      "emailSuppressions: source must be <= " + MAX_SOURCE_LEN + " chars"
    );
  }
  if (!SOURCE_RE.test(clean)) {
    throw new TypeError(
      "emailSuppressions: source must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/"
    );
  }
  return clean;
}

function _validateExpiresAt(ts) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts <= 0) {
    throw new TypeError(
      "emailSuppressions: expires_at must be a positive integer epoch-ms or null"
    );
  }
  return ts;
}

function _validateEmailHash(h) {
  if (typeof h !== "string" || !h.length) {
    throw new TypeError("emailSuppressions: email_hash must be a non-empty string");
  }
  // `b.crypto.namespaceHash` returns a hex-encoded SHA3-512 — 128
  // hex characters. Refuse anything outside that shape so a
  // hand-crafted lookup can't smuggle SQL through the parameter.
  if (!/^[0-9a-f]{128}$/.test(h)) {
    throw new TypeError(
      "emailSuppressions: email_hash must be 128 lowercase hex characters"
    );
  }
  return h;
}

function _validateLimit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError(
      "emailSuppressions: limit must be 1..." + MAX_LIST_LIMIT
    );
  }
  return n;
}

function _validateRange(from, to) {
  if (from != null && (typeof from !== "number" || !Number.isInteger(from) || from < 0)) {
    throw new TypeError("emailSuppressions: from must be a non-negative integer epoch-ms or null");
  }
  if (to != null && (typeof to !== "number" || !Number.isInteger(to) || to < 0)) {
    throw new TypeError("emailSuppressions: to must be a non-negative integer epoch-ms or null");
  }
  if (from != null && to != null && from > to) {
    throw new TypeError("emailSuppressions: from must be <= to");
  }
}

// ---- scope filter --------------------------------------------------------

// Build the WHERE clause that selects rows whose scope blocks the
// caller's requested scope. The hierarchy is:
//   caller asks scope='transactional' → blocked by row.scope in ('all', 'transactional')
//   caller asks scope='marketing'     → blocked by row.scope in ('all', 'marketing')
//   caller asks scope='all'           → blocked by any row (all three)
// Returns `{ sql, params }` with positional placeholders starting at
// `nextIdx` so the caller can slot the fragment into a larger query.
function _scopeFilterScopes(scope) {
  if (scope === "transactional") return ["all", "transactional"];
  if (scope === "marketing")     return ["all", "marketing"];
  return ["all", "marketing", "transactional"];
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged so an operator can't
  // hand-craft one to skip past a hidden row. Dev default keeps the
  // primitive bootable in tests; the deployment supplies a derived
  // secret (typically
  // `b.crypto.namespaceHash("email-suppressions-cursor",
  // D1_BRIDGE_SECRET)`).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "emailSuppressions.create: opts.cursorSecret is required in production"
      );
    }
    opts.cursorSecret = "email-suppressions-cursor-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  return {
    EMAIL_NAMESPACE:   EMAIL_NAMESPACE,
    SUPPRESSION_TYPES: SUPPRESSION_TYPES,
    SCOPES:            SCOPES,

    // Insert or upsert a suppression. Re-occurrence (same email_hash)
    // bumps `occurrences` + `last_seen_at`, refreshes `reason` /
    // `source` / `expires_at`, and keeps `first_seen_at` sticky.
    // Returns `{ email_hash, email_normalized, suppression_type,
    // scope, occurrences, status: 'new' | 'updated' }`.
    add: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailSuppressions.add: input object required");
      }
      var emailNormalized = _normalizeEmail(input.email);
      var type            = _validateType(input.suppression_type);
      var scope           = input.scope == null
        ? _defaultScopeFor(type)
        : _validateScope(input.scope, "scope");
      var reason          = _validateReason(input.reason);
      var source          = _validateSource(input.source);
      var expiresAt       = _validateExpiresAt(input.expires_at);
      var emailHash       = b.crypto.namespaceHash(EMAIL_NAMESPACE, emailNormalized);
      var now             = Date.now();

      var existing = (await query(
        "SELECT email_hash, first_seen_at, occurrences " +
        "FROM email_suppressions WHERE email_hash = ?1 LIMIT 1",
        [emailHash],
      )).rows[0];

      if (existing) {
        var nextCount = Number(existing.occurrences || 0) + 1;
        await query(
          "UPDATE email_suppressions SET " +
          "email_normalized = ?1, suppression_type = ?2, scope = ?3, " +
          "reason = ?4, source = ?5, last_seen_at = ?6, expires_at = ?7, " +
          "occurrences = ?8 " +
          "WHERE email_hash = ?9",
          [
            emailNormalized, type, scope, reason, source, now, expiresAt,
            nextCount, emailHash,
          ],
        );
        return {
          email_hash:       emailHash,
          email_normalized: emailNormalized,
          suppression_type: type,
          scope:            scope,
          occurrences:      nextCount,
          status:           "updated",
        };
      }

      await query(
        "INSERT INTO email_suppressions " +
        "(email_hash, email_normalized, suppression_type, scope, " +
        "reason, source, first_seen_at, last_seen_at, expires_at, " +
        "occurrences) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, 1)",
        [
          emailHash, emailNormalized, type, scope, reason, source,
          now, expiresAt,
        ],
      );
      return {
        email_hash:       emailHash,
        email_normalized: emailNormalized,
        suppression_type: type,
        scope:            scope,
        occurrences:      1,
        status:           "new",
      };
    },

    // Returns `{ suppressed: boolean, suppression_type?, scope?,
    // reason?, expires_at? }`. Scope defaults to 'all' — the most
    // restrictive view, which surfaces any active row. Expired
    // soft-bounces (expires_at < now) don't suppress.
    isSuppressed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailSuppressions.isSuppressed: input object required");
      }
      var emailNormalized = _normalizeEmail(input.email);
      var scope           = input.scope == null
        ? "all"
        : _validateScope(input.scope, "scope");
      var emailHash       = b.crypto.namespaceHash(EMAIL_NAMESPACE, emailNormalized);
      var now             = Date.now();
      var allowedScopes   = _scopeFilterScopes(scope);
      // SQLite parameter slots — bind scope list dynamically. Two-or-
      // three element list, so a small inline expansion is safer than
      // a generic IN-clause builder.
      var sql, params;
      if (allowedScopes.length === 3) {
        sql = "SELECT suppression_type, scope, reason, expires_at " +
              "FROM email_suppressions " +
              "WHERE email_hash = ?1 AND scope IN (?2, ?3, ?4) " +
              "AND (expires_at IS NULL OR expires_at > ?5) " +
              "LIMIT 1";
        params = [emailHash, allowedScopes[0], allowedScopes[1], allowedScopes[2], now];
      } else {
        sql = "SELECT suppression_type, scope, reason, expires_at " +
              "FROM email_suppressions " +
              "WHERE email_hash = ?1 AND scope IN (?2, ?3) " +
              "AND (expires_at IS NULL OR expires_at > ?4) " +
              "LIMIT 1";
        params = [emailHash, allowedScopes[0], allowedScopes[1], now];
      }
      var row = (await query(sql, params)).rows[0];
      if (!row) return { suppressed: false };
      return {
        suppressed:       true,
        suppression_type: row.suppression_type,
        scope:            row.scope,
        reason:           row.reason,
        expires_at:       row.expires_at == null ? null : Number(row.expires_at),
      };
    },

    // Operator manual override — removes the suppression row. Useful
    // when a customer complaint was a mistake or a hard-bounce
    // re-resolved (the recipient fixed their MX). The `reason`
    // parameter is mandatory so the operator can't accidentally drop
    // rows without recording the rationale; the deletion event is
    // not persisted by this primitive (operators wire an audit sink
    // at the route layer if they need it).
    remove: async function (emailHash, opts2) {
      _validateEmailHash(emailHash);
      if (!opts2 || typeof opts2 !== "object") {
        throw new TypeError("emailSuppressions.remove: opts.reason required");
      }
      if (typeof opts2.reason !== "string" || !opts2.reason.length) {
        throw new TypeError("emailSuppressions.remove: opts.reason must be a non-empty string");
      }
      _validateReason(opts2.reason);
      var r = await query(
        "DELETE FROM email_suppressions WHERE email_hash = ?1",
        [emailHash],
      );
      return { removed: r.rowCount > 0, email_hash: emailHash };
    },

    // Operator lookup by hash — used by the dashboard when a support
    // ticket includes the address but the agent needs the full row
    // (reason, source, occurrences, first_seen_at, expires_at).
    byHash: async function (emailHash) {
      _validateEmailHash(emailHash);
      var r = await query(
        "SELECT email_hash, email_normalized, suppression_type, scope, " +
        "reason, source, first_seen_at, last_seen_at, expires_at, " +
        "occurrences " +
        "FROM email_suppressions WHERE email_hash = ?1 LIMIT 1",
        [emailHash],
      );
      return r.rows[0] || null;
    },

    // Operator dashboard surface. Sorted (last_seen_at DESC, email_hash
    // DESC) so the most-recent activity surfaces first. The cursor is
    // HMAC-tagged via b.pagination — same shape as catalog.products.list
    // and order.listForCustomer.
    list: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = _validateLimit(listOpts.limit);
      var type = null;
      if (listOpts.suppression_type != null) {
        type = _validateType(listOpts.suppression_type);
      }
      var scope = null;
      if (listOpts.scope != null) {
        scope = _validateScope(listOpts.scope, "scope");
      }
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("emailSuppressions.list: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
            throw new TypeError("emailSuppressions.list: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("emailSuppressions.list: cursor — " + (e && e.message || "malformed"));
        }
      }
      // Build the query incrementally — base columns + sort, then
      // append filters and the cursor tuple comparison.
      var where  = [];
      var params = [];
      var p = 1;
      if (type) {
        where.push("suppression_type = ?" + p);
        params.push(type);
        p += 1;
      }
      if (scope) {
        where.push("scope = ?" + p);
        params.push(scope);
        p += 1;
      }
      if (cursorVals) {
        where.push("(last_seen_at < ?" + p + " OR (last_seen_at = ?" + p + " AND email_hash < ?" + (p + 1) + "))");
        params.push(cursorVals[0]);
        params.push(cursorVals[1]);
        p += 2;
      }
      var sql = "SELECT email_hash, email_normalized, suppression_type, scope, " +
        "reason, source, first_seen_at, last_seen_at, expires_at, " +
        "occurrences FROM email_suppressions" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY last_seen_at DESC, email_hash DESC LIMIT ?" + p;
      params.push(limit);

      var rows = (await query(sql, params)).rows;
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: LIST_ORDER_KEY,
          vals:     [last.last_seen_at, last.email_hash],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    // Purge rows whose expires_at < ts (default: now). Returns the
    // number of rows removed. Soft-bounces and rate-limit-blocks are
    // the typical inhabitants; permanent rows (expires_at IS NULL)
    // are never touched.
    cleanupExpired: async function (ts) {
      var cutoff;
      if (ts == null) {
        cutoff = Date.now();
      } else {
        if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
          throw new TypeError("emailSuppressions.cleanupExpired: ts must be a non-negative integer epoch-ms or null");
        }
        cutoff = ts;
      }
      var r = await query(
        "DELETE FROM email_suppressions WHERE expires_at IS NOT NULL AND expires_at < ?1",
        [cutoff],
      );
      return { removed: r.rowCount };
    },

    // Aggregate counts grouped by suppression_type, optionally
    // bounded by [from, to] against last_seen_at. Operator
    // dashboards render the breakdown so the bounce-rate trend is
    // visible without a separate analytics primitive.
    stats: async function (opts3) {
      opts3 = opts3 || {};
      _validateRange(opts3.from, opts3.to);
      var where  = [];
      var params = [];
      var p = 1;
      if (opts3.from != null) {
        where.push("last_seen_at >= ?" + p);
        params.push(opts3.from);
        p += 1;
      }
      if (opts3.to != null) {
        where.push("last_seen_at <= ?" + p);
        params.push(opts3.to);
        p += 1;
      }
      var sql = "SELECT suppression_type, COUNT(*) AS n " +
        "FROM email_suppressions" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " GROUP BY suppression_type";
      var rows = (await query(sql, params)).rows;
      // Surface the full type set so an operator dashboard renders
      // zeros instead of "missing key" — easier to spot a trend
      // reversal when the row is present at 0 than when it's absent.
      var out = {};
      for (var i = 0; i < SUPPRESSION_TYPES.length; i += 1) {
        out[SUPPRESSION_TYPES[i]] = 0;
      }
      for (var j = 0; j < rows.length; j += 1) {
        out[rows[j].suppression_type] = Number(rows[j].n || 0);
      }
      return out;
    },
  };
}

module.exports = {
  create:            create,
  EMAIL_NAMESPACE:   EMAIL_NAMESPACE,
  SUPPRESSION_TYPES: SUPPRESSION_TYPES,
  SCOPES:            SCOPES,
};
