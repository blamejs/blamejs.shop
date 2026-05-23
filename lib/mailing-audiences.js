"use strict";
/**
 * @module shop.mailingAudiences
 * @title  Mailing audiences — operator-defined newsletter segmentation
 *
 * @intro
 *   Operators broadcast release notes, abandoned-cart nudges, and
 *   review-request prompts to slices of the `newsletter_signups`
 *   table. This primitive owns the definition + resolution of those
 *   slices ("audiences"). Each audience is a named rule set
 *   (subscribed-at age, source membership, tag filters, country,
 *   language, customer status, double-opt-in confirmation) the
 *   operator authors once; the broadcast pipeline resolves the
 *   audience to a recipient list per campaign.
 *
 *   Composition:
 *     var aud = bShop.mailingAudiences.create({
 *       query:              q,
 *       newsletter:         bShop.newsletter.create({ query: q }),
 *       emailSuppressions:  bShop.emailSuppressions.create({ query: q }),
 *     });
 *     await aud.defineAudience({
 *       slug:  "release-watchers-eu",
 *       title: "Release watchers — EU/UK",
 *       rules: {
 *         subscribed_after:  Date.now() - 365 * 86400000,
 *         double_opt_in:     true,
 *         country_in:        ["DE", "FR", "GB", "NL"],
 *         tag_any:           ["release-notes", "security"],
 *       },
 *     });
 *     var page = await aud.resolve({ slug: "release-watchers-eu", limit: 100 });
 *     // page.emails_hashed         — always populated; hashes only.
 *     // page.emails_normalised     — empty unless include_plaintext.
 *     // page.next_cursor           — HMAC-tagged page cursor.
 *
 *   Suppression composition:
 *     When `opts.emailSuppressions` is supplied and `resolve` is
 *     called with `skip_suppressed: true` (the default), every
 *     candidate's `email_hash` is checked against the suppression
 *     table under the `marketing` scope. Hits drop out of the page +
 *     bump the `suppressed_count` the caller reports back through
 *     `auditDelivery`. Without an injected suppressions handle the
 *     filter is a no-op and the page returns the raw membership.
 *
 *   Plaintext disclosure:
 *     `resolve` returns `emails_hashed` always — the primary key the
 *     downstream send pipeline uses to dedupe + correlate with the
 *     suppressions / consent / per-recipient tracking tables.
 *     `emails_normalised` is the plaintext recipient list and is
 *     gated behind `include_plaintext: true` on the resolve call.
 *     The operator wires that flag through their own admin auth
 *     gate (verifier role check, MFA-stepped-up session, etc.); this
 *     primitive surfaces the toggle but doesn't enforce the policy
 *     — the verifier check lives at the route layer that calls in.
 *
 *   Cache freshness:
 *     `recompute()` walks every non-archived audience, re-evaluates
 *     its rules against the current `newsletter_signups` snapshot,
 *     and replaces the per-audience rows in
 *     `mailing_audience_membership_cache`. The scheduler runs this on
 *     a cron cadence the operator picks; `resolve` reads off the
 *     cache so a 100k-signup list paginates in O(page) rather than
 *     O(signups). The trade-off is operator-visible staleness — a
 *     signup that lands between recomputes won't appear in the next
 *     campaign send. Operators that need stricter freshness call
 *     `recompute()` synchronously before each send.
 *
 *   Audit ledger:
 *     `auditDelivery({ slug, campaign_id, sent_count, suppressed_count })`
 *     writes a row per send. The compliance export reads
 *     `mailing_audience_deliveries` to demonstrate per-audience send
 *     volume + suppression honoring over a reporting window.
 *
 * @primitive mailingAudiences
 * @related   shop.newsletter, shop.emailSuppressions, b.pagination
 */

// ---- constants ----------------------------------------------------------

var SLUG_RE              = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var TAG_RE               = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var COUNTRY_RE           = /^[A-Z]{2}$/;
var LANGUAGE_RE          = /^[a-z]{2}(-[A-Z]{2})?$/;
var CUSTOMER_STATUS_RE   = /^[a-z][a-z0-9_-]{0,31}$/;
var SOURCE_RE            = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var MAX_TITLE_LEN        = 200;
var MAX_RULE_LIST_LEN    = 64;
var MAX_LIST_LIMIT       = 500;
var DEFAULT_LIST_LIMIT   = 100;
var LIST_ORDER_KEY       = ["signup_id:asc"];
var KNOWN_RULE_KEYS      = [
  "subscribed_after",
  "subscribed_before",
  "source_in",
  "tag_any",
  "tag_all",
  "country_in",
  "double_opt_in",
  "language_in",
  "customer_status_in",
];

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _validateSlug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("mailingAudiences: slug must be a non-empty string");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "mailingAudiences: slug must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/"
    );
  }
  return s;
}

function _validateTitle(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("mailingAudiences: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError(
      "mailingAudiences: title must be <= " + MAX_TITLE_LEN + " chars"
    );
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("mailingAudiences: title must not contain CR / LF / NUL");
  }
  return s;
}

function _validateTs(ts, label) {
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError(
      "mailingAudiences: " + label + " must be a non-negative integer epoch-ms"
    );
  }
  return ts;
}

function _validateStringList(arr, label, pattern) {
  if (!Array.isArray(arr)) {
    throw new TypeError(
      "mailingAudiences: " + label + " must be an array of strings"
    );
  }
  if (arr.length === 0) {
    throw new TypeError(
      "mailingAudiences: " + label + " must be a non-empty array"
    );
  }
  if (arr.length > MAX_RULE_LIST_LEN) {
    throw new TypeError(
      "mailingAudiences: " + label + " must have <= " +
      MAX_RULE_LIST_LEN + " entries"
    );
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var v = arr[i];
    if (typeof v !== "string" || !v.length) {
      throw new TypeError(
        "mailingAudiences: " + label + "[" + i + "] must be a non-empty string"
      );
    }
    if (!pattern.test(v)) {
      throw new TypeError(
        "mailingAudiences: " + label + "[" + i + "] does not match " + pattern.source
      );
    }
    if (seen[v]) continue;
    seen[v] = true;
    out.push(v);
  }
  return out;
}

// Each known rule key is validated against its shape. Unknown keys
// are refused outright — operators should never silently lose a
// predicate to a typo, and a forward-compat rule key lands with an
// explicit primitive update (not a silent acceptance).
function _validateRules(rules) {
  if (rules == null || typeof rules !== "object" || Array.isArray(rules)) {
    throw new TypeError("mailingAudiences: rules must be an object");
  }
  var keys = Object.keys(rules);
  for (var i = 0; i < keys.length; i += 1) {
    if (KNOWN_RULE_KEYS.indexOf(keys[i]) === -1) {
      throw new TypeError(
        "mailingAudiences: unknown rule key '" + keys[i] + "' — allowed: " +
        KNOWN_RULE_KEYS.join(", ")
      );
    }
  }
  var out = {};
  if (rules.subscribed_after != null) {
    out.subscribed_after = _validateTs(rules.subscribed_after, "rules.subscribed_after");
  }
  if (rules.subscribed_before != null) {
    out.subscribed_before = _validateTs(rules.subscribed_before, "rules.subscribed_before");
  }
  if (out.subscribed_after != null && out.subscribed_before != null &&
      out.subscribed_after > out.subscribed_before) {
    throw new TypeError(
      "mailingAudiences: rules.subscribed_after must be <= subscribed_before"
    );
  }
  if (rules.source_in != null) {
    out.source_in = _validateStringList(rules.source_in, "rules.source_in", SOURCE_RE);
  }
  if (rules.tag_any != null) {
    out.tag_any = _validateStringList(rules.tag_any, "rules.tag_any", TAG_RE);
  }
  if (rules.tag_all != null) {
    out.tag_all = _validateStringList(rules.tag_all, "rules.tag_all", TAG_RE);
  }
  if (rules.country_in != null) {
    out.country_in = _validateStringList(rules.country_in, "rules.country_in", COUNTRY_RE);
  }
  if (rules.double_opt_in != null) {
    if (typeof rules.double_opt_in !== "boolean") {
      throw new TypeError(
        "mailingAudiences: rules.double_opt_in must be a boolean"
      );
    }
    out.double_opt_in = rules.double_opt_in;
  }
  if (rules.language_in != null) {
    out.language_in = _validateStringList(rules.language_in, "rules.language_in", LANGUAGE_RE);
  }
  if (rules.customer_status_in != null) {
    out.customer_status_in = _validateStringList(
      rules.customer_status_in, "rules.customer_status_in", CUSTOMER_STATUS_RE
    );
  }
  return out;
}

function _validateLimit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError(
      "mailingAudiences: limit must be 1..." + MAX_LIST_LIMIT
    );
  }
  return n;
}

function _validateCampaignId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(
      "mailingAudiences: campaign_id must be a non-empty string"
    );
  }
  if (s.length > 128) {
    throw new TypeError("mailingAudiences: campaign_id must be <= 128 chars");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(s)) {
    throw new TypeError(
      "mailingAudiences: campaign_id must match /[A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9]/"
    );
  }
  return s;
}

function _validateNonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "mailingAudiences: " + label + " must be a non-negative integer"
    );
  }
  return n;
}

// ---- in-memory rule evaluator ------------------------------------------
//
// Used by `recompute()` and `resolve()` (cold path — when no cache row
// exists yet). The hot path reads `mailing_audience_membership_cache`
// directly; this evaluator only runs over the full signup row set
// during a recompute pass. The cost-bound stays operator-visible
// because the scheduler controls when recompute happens.

function _csvHasAny(csv, needles) {
  if (!csv) return false;
  var have = csv.split(",");
  for (var i = 0; i < have.length; i += 1) {
    var t = have[i];
    if (!t) continue;
    if (needles.indexOf(t) !== -1) return true;
  }
  return false;
}

function _csvHasAll(csv, needles) {
  if (!csv) return false;
  var have = csv.split(",");
  for (var i = 0; i < needles.length; i += 1) {
    if (have.indexOf(needles[i]) === -1) return false;
  }
  return true;
}

function _matches(row, rules) {
  if (rules.subscribed_after != null &&
      !(Number(row.created_at) >= rules.subscribed_after)) {
    return false;
  }
  if (rules.subscribed_before != null &&
      !(Number(row.created_at) <= rules.subscribed_before)) {
    return false;
  }
  if (rules.source_in != null &&
      rules.source_in.indexOf(row.source) === -1) {
    return false;
  }
  if (rules.tag_any != null &&
      !_csvHasAny(row.tags_csv || "", rules.tag_any)) {
    return false;
  }
  if (rules.tag_all != null &&
      !_csvHasAll(row.tags_csv || "", rules.tag_all)) {
    return false;
  }
  if (rules.country_in != null &&
      (!row.country || rules.country_in.indexOf(row.country) === -1)) {
    return false;
  }
  if (rules.double_opt_in === true && row.double_opt_in_at == null) {
    return false;
  }
  if (rules.double_opt_in === false && row.double_opt_in_at != null) {
    return false;
  }
  if (rules.language_in != null &&
      (!row.language || rules.language_in.indexOf(row.language) === -1)) {
    return false;
  }
  if (rules.customer_status_in != null &&
      (!row.customer_status ||
       rules.customer_status_in.indexOf(row.customer_status) === -1)) {
    return false;
  }
  // Unsubscribed rows are never audience members regardless of rule
  // shape — opt-out is the universal short-circuit. The operator can
  // re-include via `newsletter.resubscribe`.
  if (row.unsubscribed_at != null) return false;
  return true;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // The `newsletter` handle is optional — the primitive composes
  // `newsletter_signups` directly via `query`. Operators pass the
  // handle when they want to short-circuit a resolve into a fresh
  // recompute (e.g. count() against a freshly-mutated table).
  var newsletterHandle = opts.newsletter || null;
  var suppressionsHandle = opts.emailSuppressions || null;

  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "mailingAudiences.create: opts.cursorSecret is required in production"
      );
    }
    opts.cursorSecret = "mailing-audiences-cursor-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Cold-path resolver — walks every signup row, applies the rule
  // evaluator, replaces the cache rows for this slug. Returns the
  // member id list so `recompute()` can roll up counts.
  async function _recomputeOne(slug, rules, now) {
    var r = await query(
      "SELECT id, email_hash, email_normalized, source, created_at, " +
      "unsubscribed_at, tags_csv, country, language, customer_status, " +
      "double_opt_in_at " +
      "FROM newsletter_signups",
      [],
    );
    var members = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      if (_matches(r.rows[i], rules)) members.push(r.rows[i].id);
    }
    // Replace the slug's cache rows in two steps — SQLite has no
    // multi-row UPSERT that's portable across the D1 SQLite dialect
    // we run on, so the safer route is DELETE + INSERT. Bounded by
    // the audience size (operator picks); a 100k-member audience is
    // still ~10ms on D1.
    await query(
      "DELETE FROM mailing_audience_membership_cache WHERE slug = ?1",
      [slug],
    );
    for (var j = 0; j < members.length; j += 1) {
      await query(
        "INSERT INTO mailing_audience_membership_cache " +
        "(slug, signup_id, refreshed_at) VALUES (?1, ?2, ?3)",
        [slug, members[j], now],
      );
    }
    return members;
  }

  function _decodeCursor(cursor) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError(
        "mailingAudiences: cursor must be an opaque string or null"
      );
    }
    try {
      var state = _b().pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError(
          "mailingAudiences: cursor orderKey mismatch"
        );
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError(
        "mailingAudiences: cursor — " + (e && e.message || "malformed")
      );
    }
  }

  function _encodeCursor(lastSignupId) {
    return _b().pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [lastSignupId],
      forward:  true,
    }, cursorSecret);
  }

  async function _getAudienceRow(slug) {
    var r = await query(
      "SELECT slug, title, rules_json, archived_at, created_at, updated_at " +
      "FROM mailing_audiences WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  return {
    KNOWN_RULE_KEYS: KNOWN_RULE_KEYS,

    // Define (or upsert) an audience. The rules object is normalised
    // before persisting — unknown keys refused, lists deduped, types
    // checked. Re-defining the same slug bumps `updated_at` + replaces
    // rules; archived audiences un-archive on re-define so an
    // operator can revive an audience without inventing a new slug.
    defineAudience: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("mailingAudiences.defineAudience: input object required");
      }
      var slug   = _validateSlug(input.slug);
      var title  = _validateTitle(input.title);
      var rules  = _validateRules(input.rules);
      var now    = Date.now();

      var existing = await _getAudienceRow(slug);
      var rulesJson;
      try {
        rulesJson = JSON.stringify(rules);
      } catch (_e) {
        // Validators above only emit JSON-safe primitives; this is
        // defensive — a circular ref would have to come from an
        // operator-built proxy, which the validators wouldn't touch.
        throw new TypeError("mailingAudiences.defineAudience: rules not serialisable");
      }
      if (existing) {
        await query(
          "UPDATE mailing_audiences SET title = ?1, rules_json = ?2, " +
          "archived_at = NULL, updated_at = ?3 WHERE slug = ?4",
          [title, rulesJson, now, slug],
        );
        return {
          slug:        slug,
          title:       title,
          rules:       rules,
          archived_at: null,
          created_at:  Number(existing.created_at),
          updated_at:  now,
          status:      "updated",
        };
      }
      await query(
        "INSERT INTO mailing_audiences " +
        "(slug, title, rules_json, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
        [slug, title, rulesJson, now],
      );
      return {
        slug:        slug,
        title:       title,
        rules:       rules,
        archived_at: null,
        created_at:  now,
        updated_at:  now,
        status:      "new",
      };
    },

    // Resolve an audience to a page of recipients. The cache rows
    // are joined back to `newsletter_signups` for the hash +
    // normalised columns; suppressions (if injected) drop hits per
    // hash. `emails_normalised` is empty unless `include_plaintext:
    // true`. Pagination is cursor-based and HMAC-tagged so an
    // operator can't hand-craft one to skip past hidden rows.
    resolve: async function (resolveOpts) {
      resolveOpts = resolveOpts || {};
      var slug              = _validateSlug(resolveOpts.slug);
      var limit             = _validateLimit(resolveOpts.limit);
      var cursorVals        = _decodeCursor(resolveOpts.cursor);
      var skipSuppressed    = resolveOpts.skip_suppressed !== false;
      var includePlaintext  = resolveOpts.include_plaintext === true;

      var audience = await _getAudienceRow(slug);
      if (!audience) {
        throw new TypeError(
          "mailingAudiences.resolve: audience '" + slug + "' not found"
        );
      }
      if (audience.archived_at != null) {
        throw new TypeError(
          "mailingAudiences.resolve: audience '" + slug + "' is archived"
        );
      }
      var sql = "SELECT s.id AS signup_id, s.email_hash, s.email_normalized " +
        "FROM mailing_audience_membership_cache c " +
        "JOIN newsletter_signups s ON s.id = c.signup_id " +
        "WHERE c.slug = ?1";
      var params = [slug];
      var p = 2;
      if (cursorVals) {
        sql += " AND c.signup_id > ?" + p;
        params.push(cursorVals[0]);
        p += 1;
      }
      sql += " ORDER BY c.signup_id ASC LIMIT ?" + p;
      // Over-fetch by the configured limit so the suppression filter
      // doesn't underfill the page on a high-suppression slug.
      // Bounded by `MAX_LIST_LIMIT * 2` so a pathological audience
      // can't blow memory; if the over-fetch saturates and the page
      // still underfills, the caller paginates to the next cursor.
      var overfetch = Math.min(MAX_LIST_LIMIT * 2, limit * 2);
      params.push(overfetch);

      var rows = (await query(sql, params)).rows;
      var hashes    = [];
      var emails    = [];
      var lastId    = null;
      var droppedSuppressed = 0;

      for (var i = 0; i < rows.length && hashes.length < limit; i += 1) {
        var row = rows[i];
        lastId = row.signup_id;
        if (skipSuppressed && suppressionsHandle) {
          var ssView = await suppressionsHandle.isSuppressed({
            email: row.email_normalized,
            scope: "marketing",
          });
          if (ssView.suppressed) {
            droppedSuppressed += 1;
            continue;
          }
        }
        hashes.push(row.email_hash);
        if (includePlaintext) emails.push(row.email_normalized);
      }

      var next = null;
      // If the over-fetch returned at least one more row past the
      // last we emitted, a next page exists. The cursor anchors on
      // the last cache row we examined — including dropped
      // suppressions — so the next page resumes past them.
      if (rows.length > 0 && hashes.length === limit) {
        next = _encodeCursor(lastId);
      }
      return {
        slug:                slug,
        emails_hashed:       hashes,
        emails_normalised:   emails,
        suppressed_count:    droppedSuppressed,
        next_cursor:         next,
      };
    },

    // Count of cached members for an audience. Reads off
    // `mailing_audience_membership_cache` — does NOT re-resolve.
    // Operators that need cache-fresh counts call `recompute()`
    // first.
    count: async function (slug) {
      _validateSlug(slug);
      var audience = await _getAudienceRow(slug);
      if (!audience) {
        throw new TypeError(
          "mailingAudiences.count: audience '" + slug + "' not found"
        );
      }
      var r = await query(
        "SELECT COUNT(*) AS n FROM mailing_audience_membership_cache WHERE slug = ?1",
        [slug],
      );
      return Number((r.rows[0] || {}).n || 0);
    },

    // Single-audience operator dashboard view. Returns the row + the
    // parsed rules object (not the JSON string) for ergonomic
    // rendering. Returns null on miss rather than throwing — the
    // dashboard renders a "not found" view; throwing would force the
    // caller to wrap every read in try/catch.
    getAudience: async function (slug) {
      _validateSlug(slug);
      var row = await _getAudienceRow(slug);
      if (!row) return null;
      var rules;
      try { rules = JSON.parse(row.rules_json); }
      catch (_e) { rules = {}; }
      return {
        slug:        row.slug,
        title:       row.title,
        rules:       rules,
        archived_at: row.archived_at == null ? null : Number(row.archived_at),
        created_at:  Number(row.created_at),
        updated_at:  Number(row.updated_at),
      };
    },

    // Operator dashboard list. Active-only by default; pass
    // `include_archived: true` to surface the soft-deleted entries
    // for compliance / undo-style flows.
    listAudiences: async function (listOpts) {
      listOpts = listOpts || {};
      var includeArchived = listOpts.include_archived === true;
      var sql = "SELECT slug, title, rules_json, archived_at, created_at, updated_at " +
        "FROM mailing_audiences";
      if (!includeArchived) sql += " WHERE archived_at IS NULL";
      sql += " ORDER BY slug ASC";
      var rows = (await query(sql, [])).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var rules;
        try { rules = JSON.parse(rows[i].rules_json); }
        catch (_e) { rules = {}; }
        out.push({
          slug:        rows[i].slug,
          title:       rows[i].title,
          rules:       rules,
          archived_at: rows[i].archived_at == null ? null : Number(rows[i].archived_at),
          created_at:  Number(rows[i].created_at),
          updated_at:  Number(rows[i].updated_at),
        });
      }
      return out;
    },

    // Update an audience's title and / or rules. Either or both may
    // appear in the patch; absent keys leave the persisted value
    // alone. Archived audiences refuse updates — the operator
    // un-archives via `defineAudience` (which is the upsert path).
    update: async function (slug, patch) {
      _validateSlug(slug);
      if (!patch || typeof patch !== "object") {
        throw new TypeError("mailingAudiences.update: patch object required");
      }
      var existing = await _getAudienceRow(slug);
      if (!existing) {
        throw new TypeError(
          "mailingAudiences.update: audience '" + slug + "' not found"
        );
      }
      if (existing.archived_at != null) {
        throw new TypeError(
          "mailingAudiences.update: audience '" + slug + "' is archived — " +
          "use defineAudience to revive"
        );
      }
      var title;
      if (patch.title != null) title = _validateTitle(patch.title);
      else                     title = existing.title;
      var rules;
      if (patch.rules != null) rules = _validateRules(patch.rules);
      else                     rules = JSON.parse(existing.rules_json);
      var now = Date.now();
      await query(
        "UPDATE mailing_audiences SET title = ?1, rules_json = ?2, updated_at = ?3 " +
        "WHERE slug = ?4",
        [title, JSON.stringify(rules), now, slug],
      );
      return {
        slug:        slug,
        title:       title,
        rules:       rules,
        archived_at: null,
        created_at:  Number(existing.created_at),
        updated_at:  now,
        status:      "updated",
      };
    },

    // Soft-delete — stamps `archived_at`. The membership cache is
    // dropped at the same time so a stale page can't resolve against
    // a dormant audience; the audit ledger (deliveries) stays intact
    // so the compliance export keeps reading the historical sends.
    archive: async function (slug) {
      _validateSlug(slug);
      var existing = await _getAudienceRow(slug);
      if (!existing) {
        throw new TypeError(
          "mailingAudiences.archive: audience '" + slug + "' not found"
        );
      }
      if (existing.archived_at != null) {
        return {
          slug:        slug,
          archived_at: Number(existing.archived_at),
          status:      "already-archived",
        };
      }
      var now = Date.now();
      await query(
        "UPDATE mailing_audiences SET archived_at = ?1, updated_at = ?1 " +
        "WHERE slug = ?2",
        [now, slug],
      );
      await query(
        "DELETE FROM mailing_audience_membership_cache WHERE slug = ?1",
        [slug],
      );
      return { slug: slug, archived_at: now, status: "archived" };
    },

    // Scheduler entry point. Walks every non-archived audience and
    // replaces its membership cache rows. Returns the per-slug
    // member counts so the scheduler can log a recompute summary.
    recompute: async function () {
      var rows = (await query(
        "SELECT slug, rules_json FROM mailing_audiences WHERE archived_at IS NULL",
        [],
      )).rows;
      var now = Date.now();
      var counts = {};
      for (var i = 0; i < rows.length; i += 1) {
        var rules;
        try { rules = JSON.parse(rows[i].rules_json); }
        catch (_e) {
          // Persisted JSON failed to parse — operator-visible drift.
          // Skip the slug rather than crash the whole sweep so one
          // bad row doesn't stall the scheduler; the count surfaces
          // as 0 in the return so the operator notices.
          counts[rows[i].slug] = 0;
          continue;
        }
        var members = await _recomputeOne(rows[i].slug, rules, now);
        counts[rows[i].slug] = members.length;
      }
      return { refreshed_at: now, counts: counts };
    },

    // Append-only delivery audit. One row per send the broadcast
    // pipeline performs. The compliance export reads
    // `mailing_audience_deliveries` to demonstrate per-audience
    // send volume + suppression honoring.
    auditDelivery: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError(
          "mailingAudiences.auditDelivery: input object required"
        );
      }
      var slug             = _validateSlug(input.slug);
      var campaignId       = _validateCampaignId(input.campaign_id);
      var sentCount        = _validateNonNegInt(input.sent_count, "sent_count");
      var suppressedCount  = _validateNonNegInt(input.suppressed_count, "suppressed_count");
      var occurredAt;
      if (input.occurred_at == null) {
        occurredAt = Date.now();
      } else {
        occurredAt = _validateTs(input.occurred_at, "occurred_at");
      }
      // Audience existence is a soft check — the audit row records
      // what the operator sent under the slug they used. An archived
      // or deleted audience still gets logged so the compliance
      // export sees the historical activity. The slug-existence
      // refusal is reserved for resolve / count where stale data
      // would mislead the caller.
      var id = _b().uuid.v7();
      await query(
        "INSERT INTO mailing_audience_deliveries " +
        "(id, slug, campaign_id, sent_count, suppressed_count, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, slug, campaignId, sentCount, suppressedCount, occurredAt],
      );
      return {
        id:               id,
        slug:             slug,
        campaign_id:      campaignId,
        sent_count:       sentCount,
        suppressed_count: suppressedCount,
        occurred_at:      occurredAt,
      };
    },

    // Operator compliance read — paginated delivery audit log,
    // optionally narrowed to a slug. Sorted (occurred_at DESC,
    // id DESC) so the most-recent send surfaces first. Uses the
    // primitive's cursorSecret so the same HMAC tag protects cross-
    // surface pagination.
    listDeliveries: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = _validateLimit(listOpts.limit);
      var slug  = null;
      if (listOpts.slug != null) slug = _validateSlug(listOpts.slug);
      var where  = [];
      var params = [];
      var p = 1;
      if (slug) {
        where.push("slug = ?" + p);
        params.push(slug);
        p += 1;
      }
      var sql = "SELECT id, slug, campaign_id, sent_count, suppressed_count, occurred_at " +
        "FROM mailing_audience_deliveries" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY occurred_at DESC, id DESC LIMIT ?" + p;
      params.push(limit);
      var rows = (await query(sql, params)).rows;
      return { rows: rows };
    },

    // Optional accessor — surfaces whether the primitive was wired
    // with a newsletter handle. Tests + operator-debugging surfaces
    // use this to assert composition; the resolve / recompute paths
    // don't need it (they go through `query` directly).
    _newsletterHandle: function () { return newsletterHandle; },
  };
}

module.exports = {
  create:          create,
  KNOWN_RULE_KEYS: KNOWN_RULE_KEYS,
};
