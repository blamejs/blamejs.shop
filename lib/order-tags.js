"use strict";
/**
 * @module shop.orderTags
 * @title  Order tags — free-form operator-applied labels for workflow routing
 *
 * @intro
 *   Operators tag orders with short labels — "rush", "fraud-review",
 *   "wholesale", "demo", "vip-customer" — that drive admin-UI
 *   filtering and downstream automation (priority pick lists,
 *   manual fraud review queues, wholesale-only fulfillment lanes).
 *   Two application paths:
 *
 *     - Manual: an admin clicks a tag pill on the order detail
 *       page; `applyTag` records who applied it, when, and an
 *       optional free-text reason.
 *     - Automatic: a rule named by `defineRule` watches order
 *       shape (total, country, line count, customer segment) and
 *       `applyRulesToOrder` evaluates every active rule against
 *       one order, applying the named tag when the rule matches.
 *       Caller invokes `applyRulesToOrder` at the point the
 *       order's shape stabilizes — typically the FSM's `paid`
 *       transition — not as a background sweep.
 *
 *   Surface:
 *
 *     - `defineTag({ slug, title, description?, color,
 *                    default_color_for_status? })`
 *         Create a new tag definition. `slug` is the operator-
 *         facing handle (UNIQUE). `color` is a 6-hex CSS color
 *         (`#rrggbb`) the admin UI renders the pill in.
 *         `default_color_for_status`, when supplied, names one
 *         of the order FSM states — admin UIs may color rows in
 *         that state with this tag's palette even before the tag
 *         is applied (a "rush" tag with status='pending' lets
 *         pending orders preview the rush color).
 *
 *     - `applyTag({ order_id, tag_slug, applied_by, reason? })`
 *         Apply a tag to one order. UNIQUE-refuses a second
 *         active assignment for the same (order, tag); call
 *         `removeTag` first if reapplication is intentional.
 *         Returns the assignment row.
 *
 *     - `removeTag({ order_id, tag_slug, removed_by })`
 *         Soft-delete the active assignment. The historical row
 *         is preserved with `removed_at` + `removed_by` set;
 *         `historyForOrder` surfaces both apply and remove
 *         events.
 *
 *     - `tagsForOrder(order_id)`
 *         Returns active (non-removed) tags for one order, with
 *         the tag definition hydrated alongside.
 *
 *     - `ordersWithTag({ tag_slug, cursor?, limit? })`
 *         Returns order ids currently carrying the named tag,
 *         paginated via an HMAC-tagged cursor over
 *         (order_id ASC).
 *
 *     - `popularTags({ limit })`
 *         Returns the most-used active tags ranked by current
 *         active-assignment count.
 *
 *     - `defineRule({ slug, conditions, tag_slug })`
 *         Create an auto-application rule. Supported condition
 *         keys: `total_minor_min`, `total_minor_max`,
 *         `country_in`, `line_count_min`,
 *         `customer_segment_in`. Unknown keys are refused at
 *         define time so a typo doesn't silently produce a rule
 *         that matches everything (or nothing). `tag_slug` must
 *         reference a defined tag.
 *
 *     - `applyRulesToOrder(order_id)`
 *         Evaluate every active rule against the order's current
 *         shape; returns `{ applied: [slug, ...], skipped:
 *         [{ rule_slug, reason }, ...] }`. Rules that match a
 *         tag already actively assigned to the order are
 *         no-ops (idempotent).
 *
 *     - `listTags({ include_archived? })`
 *         Enumerate every defined tag.
 *
 *     - `archiveTag(slug)` / `updateTag(slug, patch)`
 *         Soft-delete the definition (active assignments stay
 *         readable for audit) / mutate title / description /
 *         color / default_color_for_status.
 *
 *     - `historyForOrder(order_id)`
 *         Append-only timeline of every apply + remove event for
 *         the order, oldest first.
 *
 *   Composition:
 *
 *     - b.guardUuid     — every order_id / customer_id is shape-
 *                          checked at the entry point.
 *     - b.uuid.v7        — assignment row ids (lexicographically
 *                          sortable for diagnostic logs).
 *     - b.pagination     — HMAC-tagged cursor on (order_id ASC)
 *                          for `ordersWithTag` so an operator
 *                          can't hand-craft a cursor to skip past
 *                          a hidden row or replay across
 *                          deployments.
 *
 *   Storage:
 *
 *     - `order_tags_defined` + `order_tag_assignments` +
 *       `order_tag_rules` (migration `0137_order_tags.sql`).
 *
 *   Monotonic clock:
 *
 *     `applied_at` is strictly monotonic per (order_id, tag_slug)
 *     across the full history — a re-apply after `removeTag`
 *     lands at `max(prior_applied_at, now) + 1` when the clock
 *     would otherwise tie or regress. The result is a totally-
 *     ordered timeline regardless of clock skew or rapid-fire
 *     operator clicks within the same millisecond.
 *
 * @primitive orderTags
 * @related   b.guardUuid, b.pagination, b.uuid, customerSegments
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var DEFAULT_LIMIT  = 100;
var MAX_LIMIT      = 1000;
var SLUG_RE        = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
var COLOR_RE       = /^#[0-9a-f]{6}$/;
var COUNTRY_RE     = /^[A-Z]{2}$/;
var REASON_MAX     = 500;
var BY_MAX         = 200;        // applied_by / removed_by — operator id or display name
var MAX_TITLE_LEN  = 200;
var MAX_DESC_LEN   = 1000;
var MAX_LIST_LEN   = 64;         // country_in / customer_segment_in caps
var ORDER_KEY      = ["order_id:asc"];

var ALLOWED_STATUSES = Object.freeze([
  "pending", "paid", "fulfilling", "shipped", "delivered", "refunded", "cancelled",
]);

var KNOWN_CONDITION_KEYS = Object.freeze([
  "total_minor_min",
  "total_minor_max",
  "country_in",
  "line_count_min",
  "customer_segment_in",
]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("orderTags: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("orderTags: " + (label || "slug") + " must match /^[a-z0-9][a-z0-9_-]*[a-z0-9]?$/ (<= 64 chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("orderTags: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("orderTags: title must be <= " + MAX_TITLE_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("orderTags: title must not contain control bytes");
  }
  return s;
}

function _description(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string") {
    throw new TypeError("orderTags: description must be a string");
  }
  if (s.length > MAX_DESC_LEN) {
    throw new TypeError("orderTags: description must be <= " + MAX_DESC_LEN + " chars");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("orderTags: description must not contain control bytes");
  }
  return s;
}

function _color(s) {
  if (typeof s !== "string" || !COLOR_RE.test(s)) {
    throw new TypeError("orderTags: color must match /^#[0-9a-f]{6}$/ (lowercase hex)");
  }
  return s;
}

function _statusOrNull(s) {
  if (s == null) return null;
  if (typeof s !== "string" || ALLOWED_STATUSES.indexOf(s) === -1) {
    throw new TypeError("orderTags: default_color_for_status must be null or one of " + ALLOWED_STATUSES.join(", "));
  }
  return s;
}

function _reason(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string") {
    throw new TypeError("orderTags: reason must be a string");
  }
  if (s.length > REASON_MAX) {
    throw new TypeError("orderTags: reason must be <= " + REASON_MAX + " chars");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("orderTags: reason must not contain control bytes");
  }
  return s;
}

function _by(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("orderTags: " + label + " must be a non-empty string");
  }
  if (s.length > BY_MAX) {
    throw new TypeError("orderTags: " + label + " must be <= " + BY_MAX + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("orderTags: " + label + " must not contain control bytes");
  }
  return s;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("orderTags: " + label + " must be a non-negative integer");
  }
  return n;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new TypeError("orderTags: " + label + " must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _stringList(arr, label, validator) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("orderTags: " + label + " must be a non-empty array");
  }
  if (arr.length > MAX_LIST_LEN) {
    throw new TypeError("orderTags: " + label + " must contain <= " + MAX_LIST_LEN + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var v = arr[i];
    if (typeof v !== "string") {
      throw new TypeError("orderTags: " + label + "[" + i + "] must be a string");
    }
    if (validator) validator(v, label + "[" + i + "]");
    if (seen[v]) {
      throw new TypeError("orderTags: " + label + " has duplicate entry " + JSON.stringify(v));
    }
    seen[v] = true;
    out.push(v);
  }
  return out;
}

function _countryEntry(v, label) {
  if (!COUNTRY_RE.test(v)) {
    throw new TypeError("orderTags: " + label + " must be a 2-letter ISO 3166-1 country code");
  }
}

function _segmentEntry(v, label) {
  if (!SLUG_RE.test(v)) {
    throw new TypeError("orderTags: " + label + " must be a segment slug (matches /^[a-z0-9][a-z0-9_-]*$/)");
  }
}

function _validateConditions(conditions) {
  if (conditions == null || typeof conditions !== "object" || Array.isArray(conditions)) {
    throw new TypeError("orderTags: conditions must be a plain object");
  }
  var keys = Object.keys(conditions);
  if (keys.length === 0) {
    throw new TypeError("orderTags: conditions must contain at least one predicate");
  }
  var out = {};
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (KNOWN_CONDITION_KEYS.indexOf(k) === -1) {
      throw new TypeError("orderTags: unknown condition key " + JSON.stringify(k) +
        " (allowed: " + KNOWN_CONDITION_KEYS.join(", ") + ")");
    }
    var v = conditions[k];
    switch (k) {
      case "total_minor_min":
      case "total_minor_max":
      case "line_count_min":
        _nonNegInt(v, "conditions." + k);
        out[k] = v;
        break;
      case "country_in":
        out[k] = _stringList(v, "conditions." + k, _countryEntry);
        break;
      case "customer_segment_in":
        out[k] = _stringList(v, "conditions." + k, _segmentEntry);
        break;
      default:
        // Unreachable — KNOWN_CONDITION_KEYS gate above catches anything
        // else. Throwing here so a missing branch surfaces in development
        // instead of silently dropping a predicate.
        throw new TypeError("orderTags: condition key " + JSON.stringify(k) + " has no validator");
    }
  }
  if (out.total_minor_min != null && out.total_minor_max != null
      && out.total_minor_min > out.total_minor_max) {
    throw new TypeError("orderTags: conditions.total_minor_min must be <= total_minor_max");
  }
  return out;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Pagination cursors for ordersWithTag() are HMAC-tagged via
  // b.pagination so an operator can't hand-craft one to skip past a
  // hidden row or replay across deployments. The secret defaults to
  // a dev-only placeholder so the primitive boots in tests; production
  // deploys supply a derived value (typically b.crypto.namespaceHash(
  // "order-tags-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("orderTags.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "order-tags-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  async function _readTag(slug) {
    var r = await query(
      "SELECT slug, title, description, color, default_color_for_status, " +
      "archived_at, created_at, updated_at FROM order_tags_defined " +
      "WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  function _hydrateTag(row) {
    if (!row) return null;
    return {
      slug:                     row.slug,
      title:                    row.title,
      description:              row.description,
      color:                    row.color,
      default_color_for_status: row.default_color_for_status,
      archived_at:              row.archived_at,
      created_at:               row.created_at,
      updated_at:               row.updated_at,
    };
  }

  async function _readActiveAssignment(orderId, tagSlug) {
    var r = await query(
      "SELECT id, order_id, tag_slug, applied_by, applied_at, reason, " +
      "removed_at, removed_by FROM order_tag_assignments " +
      "WHERE order_id = ?1 AND tag_slug = ?2 AND removed_at IS NULL LIMIT 1",
      [orderId, tagSlug],
    );
    return r.rows[0] || null;
  }

  // The latest `applied_at` we've ever written for this (order, tag) pair
  // across both active and removed rows. Used by the monotonic-clock
  // bumper to guarantee a re-apply after removal lands strictly after
  // the prior apply, even when the wall clock would tie or regress.
  async function _latestAppliedAt(orderId, tagSlug) {
    var r = await query(
      "SELECT MAX(applied_at) AS ts FROM order_tag_assignments " +
      "WHERE order_id = ?1 AND tag_slug = ?2",
      [orderId, tagSlug],
    );
    var row = r.rows[0] || {};
    return row.ts == null ? null : Number(row.ts);
  }

  // Two operators clicking the same tag pill within the same
  // millisecond would tie on applied_at and make the
  // "latest assignment for this (order, tag)" ambiguous. Bump the
  // requested timestamp to `prior + 1` on collision (or when an
  // out-of-order operator write would otherwise regress).
  function _resolveAppliedAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _readRule(slug) {
    var r = await query(
      "SELECT slug, conditions_json, tag_slug, archived_at, created_at, updated_at " +
      "FROM order_tag_rules WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  function _hydrateAssignment(row) {
    return {
      id:          row.id,
      order_id:    row.order_id,
      tag_slug:    row.tag_slug,
      applied_by:  row.applied_by,
      applied_at:  row.applied_at,
      reason:      row.reason,
      removed_at:  row.removed_at,
      removed_by:  row.removed_by,
    };
  }

  // Build the order-shape view a rule's conditions predicate against.
  // line_count comes from order_lines; customer_segment_in walks the
  // customer_segment_membership cache (the customerSegments primitive
  // owns the cache; this primitive is a read-only consumer). Cancelled
  // orders are still tagged-able — operator workflows include
  // post-cancellation routing — so we don't filter on status here.
  async function _orderShape(orderId) {
    var orderRow = (await query(
      "SELECT id, customer_id, grand_total_minor, ship_to_json " +
      "FROM orders WHERE id = ?1 LIMIT 1",
      [orderId],
    )).rows[0];
    if (!orderRow) return null;
    var country = null;
    try {
      var shipTo = JSON.parse(orderRow.ship_to_json || "{}");
      if (shipTo && typeof shipTo.country === "string") country = shipTo.country;
    } catch (_e) { /* drop-silent — ship_to_json is operator-shaped */ }
    var lineRow = (await query(
      "SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?1",
      [orderId],
    )).rows[0] || {};
    var lineCount = Number(lineRow.n || 0);
    var segments = [];
    if (orderRow.customer_id) {
      var segRows = (await query(
        "SELECT cs.slug FROM customer_segment_membership csm " +
        "JOIN customer_segments cs ON cs.id = csm.segment_id " +
        "WHERE csm.customer_id = ?1 AND cs.archived_at IS NULL",
        [orderRow.customer_id],
      )).rows;
      for (var i = 0; i < segRows.length; i += 1) segments.push(segRows[i].slug);
    }
    return {
      order_id:          orderRow.id,
      customer_id:       orderRow.customer_id,
      grand_total_minor: Number(orderRow.grand_total_minor || 0),
      country:           country,
      line_count:        lineCount,
      segments:          segments,
    };
  }

  // Pure predicate evaluator: returns null on match, or a reason
  // string when the rule's conditions don't all hold. Unknown keys
  // never reach this function — they're rejected at defineRule time.
  function _matchReason(conditions, shape) {
    if (conditions.total_minor_min != null && shape.grand_total_minor < conditions.total_minor_min) {
      return "total_minor_min";
    }
    if (conditions.total_minor_max != null && shape.grand_total_minor > conditions.total_minor_max) {
      return "total_minor_max";
    }
    if (conditions.line_count_min != null && shape.line_count < conditions.line_count_min) {
      return "line_count_min";
    }
    if (conditions.country_in != null) {
      if (shape.country == null || conditions.country_in.indexOf(shape.country) === -1) {
        return "country_in";
      }
    }
    if (conditions.customer_segment_in != null) {
      var hit = false;
      for (var i = 0; i < conditions.customer_segment_in.length; i += 1) {
        if (shape.segments.indexOf(conditions.customer_segment_in[i]) !== -1) {
          hit = true; break;
        }
      }
      if (!hit) return "customer_segment_in";
    }
    return null;
  }

  return {
    KNOWN_CONDITION_KEYS: KNOWN_CONDITION_KEYS.slice(),
    ALLOWED_STATUSES:     ALLOWED_STATUSES.slice(),
    DEFAULT_LIMIT:        DEFAULT_LIMIT,
    MAX_LIMIT:            MAX_LIMIT,

    defineTag: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderTags.defineTag: input object required");
      }
      var slug   = _slug(input.slug);
      var title  = _title(input.title);
      var desc   = _description(input.description);
      var color  = _color(input.color);
      var dcfs   = _statusOrNull(input.default_color_for_status);

      var existing = await _readTag(slug);
      if (existing) {
        var err = new Error("orderTags.defineTag: slug " + JSON.stringify(slug) + " already defined");
        err.code = "ORDER_TAG_SLUG_EXISTS";
        throw err;
      }

      var ts = _now();
      await query(
        "INSERT INTO order_tags_defined " +
        "(slug, title, description, color, default_color_for_status, " +
        " archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        [slug, title, desc, color, dcfs, ts],
      );
      return _hydrateTag(await _readTag(slug));
    },

    applyTag: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderTags.applyTag: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var tagSlug = _slug(input.tag_slug, "tag_slug");
      var appliedBy = _by(input.applied_by, "applied_by");
      var reason  = _reason(input.reason);

      var tag = await _readTag(tagSlug);
      if (!tag) {
        throw new TypeError("orderTags.applyTag: unknown tag_slug " + JSON.stringify(tagSlug));
      }
      if (tag.archived_at != null) {
        var earc = new Error("orderTags.applyTag: tag_slug " + JSON.stringify(tagSlug) + " is archived");
        earc.code = "ORDER_TAG_ARCHIVED";
        throw earc;
      }

      // Active assignment already present — refuse rather than
      // silently re-using the existing row, so the operator sees the
      // duplicate intent.
      var active = await _readActiveAssignment(orderId, tagSlug);
      if (active) {
        var eu = new Error("orderTags.applyTag: tag " + JSON.stringify(tagSlug) +
          " already active on order " + JSON.stringify(orderId));
        eu.code = "ORDER_TAG_ALREADY_APPLIED";
        throw eu;
      }

      var latestTs = await _latestAppliedAt(orderId, tagSlug);
      var ts = _resolveAppliedAt(_now(), latestTs);
      var id = _b().uuid.v7();
      await query(
        "INSERT INTO order_tag_assignments " +
        "(id, order_id, tag_slug, applied_by, applied_at, reason, " +
        " removed_at, removed_by) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
        [id, orderId, tagSlug, appliedBy, ts, reason],
      );
      return _hydrateAssignment({
        id: id, order_id: orderId, tag_slug: tagSlug,
        applied_by: appliedBy, applied_at: ts, reason: reason,
        removed_at: null, removed_by: null,
      });
    },

    removeTag: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderTags.removeTag: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var tagSlug = _slug(input.tag_slug, "tag_slug");
      var removedBy = _by(input.removed_by, "removed_by");

      var active = await _readActiveAssignment(orderId, tagSlug);
      if (!active) {
        var en = new Error("orderTags.removeTag: tag " + JSON.stringify(tagSlug) +
          " not active on order " + JSON.stringify(orderId));
        en.code = "ORDER_TAG_NOT_ACTIVE";
        throw en;
      }
      // removed_at must land strictly after applied_at so the audit
      // timeline never folds an apply + remove into the same instant.
      var rawNow = _now();
      var ts = rawNow > active.applied_at ? rawNow : active.applied_at + 1;
      await query(
        "UPDATE order_tag_assignments SET removed_at = ?1, removed_by = ?2 " +
        "WHERE id = ?3",
        [ts, removedBy, active.id],
      );
      return {
        id:          active.id,
        order_id:    orderId,
        tag_slug:    tagSlug,
        applied_by:  active.applied_by,
        applied_at:  active.applied_at,
        reason:      active.reason,
        removed_at:  ts,
        removed_by:  removedBy,
      };
    },

    tagsForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var r = await query(
        "SELECT a.id, a.order_id, a.tag_slug, a.applied_by, a.applied_at, " +
        "a.reason, t.title, t.description, t.color, t.default_color_for_status, " +
        "t.archived_at AS tag_archived_at " +
        "FROM order_tag_assignments a " +
        "JOIN order_tags_defined t ON t.slug = a.tag_slug " +
        "WHERE a.order_id = ?1 AND a.removed_at IS NULL " +
        "ORDER BY a.applied_at ASC, a.tag_slug ASC",
        [orderId],
      );
      var rows = r.rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        out.push({
          assignment_id:            row.id,
          order_id:                 row.order_id,
          tag_slug:                 row.tag_slug,
          title:                    row.title,
          description:              row.description,
          color:                    row.color,
          default_color_for_status: row.default_color_for_status,
          applied_by:               row.applied_by,
          applied_at:               row.applied_at,
          reason:                   row.reason,
          tag_archived:             row.tag_archived_at != null,
        });
      }
      return out;
    },

    ordersWithTag: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderTags.ordersWithTag: input object required");
      }
      var tagSlug = _slug(input.tag_slug, "tag_slug");
      var limit   = _limit(input.limit, "limit");

      var cursorVal = null;
      if (input.cursor != null) {
        if (typeof input.cursor !== "string") {
          throw new TypeError("orderTags.ordersWithTag: cursor must be an opaque string or null");
        }
        try {
          var state = _b().pagination.decodeCursor(input.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(ORDER_KEY)) {
            throw new TypeError("orderTags.ordersWithTag: cursor orderKey mismatch");
          }
          cursorVal = state.vals[0];
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("orderTags.ordersWithTag: cursor — " + (e && e.message || "malformed"));
        }
      }

      var sql, params;
      if (cursorVal != null) {
        sql = "SELECT order_id FROM order_tag_assignments " +
              "WHERE tag_slug = ?1 AND removed_at IS NULL AND order_id > ?2 " +
              "ORDER BY order_id ASC LIMIT ?3";
        params = [tagSlug, cursorVal, limit];
      } else {
        sql = "SELECT order_id FROM order_tag_assignments " +
              "WHERE tag_slug = ?1 AND removed_at IS NULL " +
              "ORDER BY order_id ASC LIMIT ?2";
        params = [tagSlug, limit];
      }
      var rows = (await query(sql, params)).rows;
      var ids = [];
      for (var i = 0; i < rows.length; i += 1) ids.push(rows[i].order_id);
      var nextCursor = null;
      if (ids.length === limit) {
        nextCursor = _b().pagination.encodeCursor({
          orderKey: ORDER_KEY,
          vals:     [ids[ids.length - 1]],
          forward:  true,
        }, cursorSecret);
      }
      return { order_ids: ids, next_cursor: nextCursor };
    },

    popularTags: async function (input) {
      input = input || {};
      var limit = _limit(input.limit, "limit");
      var r = await query(
        "SELECT a.tag_slug, COUNT(*) AS n, t.title, t.color " +
        "FROM order_tag_assignments a " +
        "JOIN order_tags_defined t ON t.slug = a.tag_slug " +
        "WHERE a.removed_at IS NULL AND t.archived_at IS NULL " +
        "GROUP BY a.tag_slug, t.title, t.color " +
        "ORDER BY n DESC, a.tag_slug ASC " +
        "LIMIT ?1",
        [limit],
      );
      var rows = r.rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({
          tag_slug: rows[i].tag_slug,
          title:    rows[i].title,
          color:    rows[i].color,
          count:    Number(rows[i].n || 0),
        });
      }
      return out;
    },

    defineRule: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderTags.defineRule: input object required");
      }
      var slug    = _slug(input.slug, "rule slug");
      var conds   = _validateConditions(input.conditions);
      var tagSlug = _slug(input.tag_slug, "tag_slug");

      var existing = await _readRule(slug);
      if (existing) {
        var err = new Error("orderTags.defineRule: rule slug " + JSON.stringify(slug) + " already defined");
        err.code = "ORDER_TAG_RULE_SLUG_EXISTS";
        throw err;
      }

      var tag = await _readTag(tagSlug);
      if (!tag) {
        throw new TypeError("orderTags.defineRule: tag_slug " + JSON.stringify(tagSlug) + " not defined");
      }

      var ts = _now();
      await query(
        "INSERT INTO order_tag_rules " +
        "(slug, conditions_json, tag_slug, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
        [slug, JSON.stringify(conds), tagSlug, ts],
      );
      return {
        slug:        slug,
        conditions:  conds,
        tag_slug:    tagSlug,
        archived_at: null,
        created_at:  ts,
        updated_at:  ts,
      };
    },

    applyRulesToOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var shape = await _orderShape(orderId);
      if (!shape) {
        throw new TypeError("orderTags.applyRulesToOrder: unknown order_id " + JSON.stringify(orderId));
      }

      var rules = (await query(
        "SELECT slug, conditions_json, tag_slug FROM order_tag_rules " +
        "WHERE archived_at IS NULL ORDER BY slug ASC",
        [],
      )).rows;

      var applied = [];
      var skipped = [];
      for (var i = 0; i < rules.length; i += 1) {
        var rule = rules[i];
        var conds;
        try { conds = JSON.parse(rule.conditions_json); }
        catch (_e) {
          skipped.push({ rule_slug: rule.slug, reason: "conditions_unparseable" });
          continue;
        }
        var missReason = _matchReason(conds, shape);
        if (missReason != null) {
          skipped.push({ rule_slug: rule.slug, reason: missReason });
          continue;
        }
        // Tag definition must exist + be active to apply.
        var tag = await _readTag(rule.tag_slug);
        if (!tag || tag.archived_at != null) {
          skipped.push({ rule_slug: rule.slug, reason: "tag_unavailable" });
          continue;
        }
        // Idempotent — skip when already actively applied.
        var active = await _readActiveAssignment(orderId, rule.tag_slug);
        if (active) {
          skipped.push({ rule_slug: rule.slug, reason: "already_applied" });
          continue;
        }
        var latestTs = await _latestAppliedAt(orderId, rule.tag_slug);
        var ts = _resolveAppliedAt(_now(), latestTs);
        var id = _b().uuid.v7();
        await query(
          "INSERT INTO order_tag_assignments " +
          "(id, order_id, tag_slug, applied_by, applied_at, reason, " +
          " removed_at, removed_by) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
          [id, orderId, rule.tag_slug, "rule:" + rule.slug, ts, "auto-applied by rule " + rule.slug],
        );
        applied.push(rule.tag_slug);
      }
      return { applied: applied, skipped: skipped };
    },

    listTags: async function (input) {
      input = input || {};
      var includeArchived = !!input.include_archived;
      var sql = "SELECT slug, title, description, color, default_color_for_status, " +
                "archived_at, created_at, updated_at FROM order_tags_defined";
      if (!includeArchived) sql += " WHERE archived_at IS NULL";
      sql += " ORDER BY slug ASC";
      var rows = (await query(sql, [])).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_hydrateTag(rows[i]));
      return out;
    },

    archiveTag: async function (slug) {
      _slug(slug);
      var existing = await _readTag(slug);
      if (!existing) {
        throw new TypeError("orderTags.archiveTag: unknown slug " + JSON.stringify(slug));
      }
      if (existing.archived_at != null) {
        return _hydrateTag(existing);
      }
      var ts = _now();
      await query(
        "UPDATE order_tags_defined SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return _hydrateTag(await _readTag(slug));
    },

    updateTag: async function (slug, patch) {
      _slug(slug);
      if (!patch || typeof patch !== "object") {
        throw new TypeError("orderTags.updateTag: patch object required");
      }
      var existing = await _readTag(slug);
      if (!existing) {
        throw new TypeError("orderTags.updateTag: unknown slug " + JSON.stringify(slug));
      }

      var nextTitle = existing.title;
      var nextDesc  = existing.description;
      var nextColor = existing.color;
      var nextDcfs  = existing.default_color_for_status;

      if (Object.prototype.hasOwnProperty.call(patch, "title")) {
        nextTitle = _title(patch.title);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "description")) {
        nextDesc = _description(patch.description);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "color")) {
        nextColor = _color(patch.color);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "default_color_for_status")) {
        nextDcfs = _statusOrNull(patch.default_color_for_status);
      }

      var ts = _now();
      await query(
        "UPDATE order_tags_defined SET title = ?1, description = ?2, color = ?3, " +
        "default_color_for_status = ?4, updated_at = ?5 WHERE slug = ?6",
        [nextTitle, nextDesc, nextColor, nextDcfs, ts, slug],
      );
      return _hydrateTag(await _readTag(slug));
    },

    historyForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var r = await query(
        "SELECT id, order_id, tag_slug, applied_by, applied_at, reason, " +
        "removed_at, removed_by FROM order_tag_assignments " +
        "WHERE order_id = ?1 ORDER BY applied_at ASC, tag_slug ASC",
        [orderId],
      );
      var rows = r.rows;
      var events = [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        events.push({
          kind:        "apply",
          assignment_id: row.id,
          tag_slug:    row.tag_slug,
          by:          row.applied_by,
          at:          row.applied_at,
          reason:      row.reason,
        });
        if (row.removed_at != null) {
          events.push({
            kind:        "remove",
            assignment_id: row.id,
            tag_slug:    row.tag_slug,
            by:          row.removed_by,
            at:          row.removed_at,
            reason:      "",
          });
        }
      }
      events.sort(function (a, b) {
        if (a.at !== b.at) return a.at - b.at;
        if (a.tag_slug !== b.tag_slug) return a.tag_slug < b.tag_slug ? -1 : 1;
        // apply before remove on identical timestamps (the monotonic
        // bump guarantees this won't happen for the same assignment
        // row, but two assignments racing at the same ms could).
        if (a.kind !== b.kind) return a.kind === "apply" ? -1 : 1;
        return 0;
      });
      return events;
    },
  };
}

module.exports = {
  create:               create,
  KNOWN_CONDITION_KEYS: KNOWN_CONDITION_KEYS,
  ALLOWED_STATUSES:     ALLOWED_STATUSES,
  DEFAULT_LIMIT:        DEFAULT_LIMIT,
  MAX_LIMIT:            MAX_LIMIT,
};
