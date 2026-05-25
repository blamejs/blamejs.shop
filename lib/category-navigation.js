"use strict";
/**
 * @module shop.categoryNavigation
 * @title  Category navigation — storefront category tree + mega-menu
 *
 * @intro
 *   Hierarchical (parent / child) categories that drive two surfaces:
 *
 *     1. Breadcrumbs. Product + collection pages render the ancestor
 *        chain from the root down to the current category. The chain
 *        is the operator-facing identity of where the customer is in
 *        the catalog ("Home > Outdoors > Tents > Family Tents").
 *     2. Mega-menu rendering data. The storefront header consumes
 *        `tree({ depth: 2 })` to render the dropdown panels — every
 *        top-level category becomes a column, its children become
 *        the column's link list, and `hero_image_url` lands as the
 *        column's featured artwork.
 *
 *   Cycle defense:
 *
 *     The schema's `CHECK(slug != parent_slug)` catches the trivial
 *     self-parent case, but A -> B -> A and deeper cycles require an
 *     ancestor walk because SQLite has no recursive-CTE-as-CHECK
 *     shape. `defineCategory` and `move` both walk the proposed
 *     parent's ancestor chain before persisting; if the moving slug
 *     appears anywhere in that chain the call is refused with
 *     `CATEGORY_CYCLE`. The walk is bounded by `MAX_TREE_DEPTH` so
 *     a malformed graph (e.g. an operator-edited database) can't
 *     infinite-loop the primitive.
 *
 *   Archive semantics:
 *
 *     `archive({ slug })` soft-deletes the row (`archived_at` set,
 *     `active` cleared). `cascade: true` recursively archives every
 *     descendant — the storefront shouldn't render a category whose
 *     parent the operator just removed. Without `cascade`, the call
 *     refuses when descendants exist so the operator doesn't orphan
 *     a sub-tree by accident. Re-defining an archived slug (via
 *     `defineCategory` with the same slug) revives it: `archived_at`
 *     clears and `active` flips back to true.
 *
 *   Position ordering:
 *
 *     Siblings under the same parent sort by `(position ASC, slug
 *     ASC)`. `reorderSiblings` takes a complete list of the parent's
 *     direct children in the desired order; partial lists are
 *     refused so a missing slug can't silently drift to the end.
 *     New rows land at the tail (max existing position + 1) unless
 *     the operator supplies an explicit `position`.
 *
 *   Hero image gate:
 *
 *     `hero_image_url` passes through `b.safeUrl.parse` (https-only)
 *     OR accepts a /-rooted absolute path. javascript: / data: /
 *     protocol-relative `//host/...` URLs are refused before the
 *     row lands on disk — the same gate the announcementBar /
 *     knowledgeBase primitives apply.
 *
 *   Optional catalog handle:
 *
 *     `opts.catalog` is an optional read-only marker today — the
 *     primitive doesn't reach into it. A future verb that wants to
 *     refuse archive-with-products or surface a richer
 *     `productCount` can consume the handle without changing the
 *     factory shape. `productCount({ slug, include_descendants? })`
 *     today returns 0 when the catalog handle is absent and delegates
 *     to `catalog.products.countByCategory(slug)` when it exposes
 *     that method.
 *
 *   Composes:
 *     - `b.safeUrl.parse`       — hero_image_url protocol gate
 *
 *   Monotonic per-process clock: two writes in the same millisecond
 *   would tie on `updated_at` and make a sort-by-timestamp read
 *   ambiguous. `_now` bumps to `prior + 1` on collision so the
 *   ordering carries a strict per-process timeline (matches the
 *   knowledgeBase / announcementBar discipline).
 *
 *   Surface:
 *     - defineCategory({ slug, parent_slug?, title, description?,
 *                        hero_image_url?, position?, active? })
 *     - getCategory(slug)
 *     - categoriesByParent({ parent_slug? })
 *     - tree({ root_slug?, depth? })
 *     - breadcrumbsFor({ slug })
 *     - descendantsOf({ slug, depth? })
 *     - move({ slug, new_parent_slug, new_position? })
 *     - archive({ slug, cascade? })
 *     - update({ slug, patch })
 *     - reorderSiblings({ parent_slug, ordered_slugs })
 *     - productCount({ slug, include_descendants? })
 *     - popularCategories({ from, to, limit })
 *
 *   Storage:
 *     - categories (migration `0201_category_navigation.sql`).
 *
 * @primitive categoryNavigation
 * @related    b.safeUrl, shop.catalog, shop.storefront
 */

var MAX_SLUG_LEN          = 120;
var MAX_TITLE_LEN          = 200;
var MAX_DESCRIPTION_LEN    = 2000;
var MAX_HERO_URL_LEN       = 2048;
var MAX_POSITION           = 1000000;
var MAX_TREE_DEPTH         = 16;
var DEFAULT_TREE_DEPTH     = 16;
var MAX_LIST_LIMIT         = 200;
var DEFAULT_POPULAR_LIMIT  = 10;
var MAX_POPULAR_LIMIT      = 100;
var MAX_REORDER_BATCH      = 500;

var SLUG_RE                = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
var CONTROL_BYTE_STRICT_RE = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_BODY_RE   = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var b = require("./index").framework;

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven writes can land in the same millisecond on fast
// machines. Bumping by 1ms on a tie keeps the timeline strictly
// increasing so a sort-by-timestamp read returns events in the order
// they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _slug(s, label) {
  label = label || "slug";
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("categoryNavigation: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("categoryNavigation: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("categoryNavigation: " + label + " must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string") {
    throw new TypeError("categoryNavigation: title must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("categoryNavigation: title must be non-empty after trim");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("categoryNavigation: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s)) {
    throw new TypeError("categoryNavigation: title contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("categoryNavigation: title contains zero-width / direction-override characters");
  }
  return s;
}

function _description(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("categoryNavigation: description must be a string or null");
  }
  if (s.length > MAX_DESCRIPTION_LEN) {
    throw new TypeError("categoryNavigation: description must be <= " + MAX_DESCRIPTION_LEN + " characters");
  }
  if (CONTROL_BYTE_BODY_RE.test(s)) {
    throw new TypeError("categoryNavigation: description contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("categoryNavigation: description contains zero-width / direction-override characters");
  }
  return s;
}

// Validate a hero-image URL through `b.safeUrl.parse` (https-only) OR
// accept a /-rooted absolute path. The same boundary defense the
// announcementBar / knowledgeBase primitives apply — javascript: /
// data: / protocol-relative `//host/...` are refused before
// persistence.
function _heroImageUrl(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("categoryNavigation: hero_image_url must be a non-empty string or null");
  }
  if (s.length > MAX_HERO_URL_LEN) {
    throw new TypeError("categoryNavigation: hero_image_url must be <= " + MAX_HERO_URL_LEN + " characters");
  }
  if (CONTROL_BYTE_BODY_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("categoryNavigation: hero_image_url contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError("categoryNavigation: hero_image_url protocol-relative `//host/...` refused — use absolute https://");
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("categoryNavigation: hero_image_url path must not contain '..'");
    }
    return s;
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("categoryNavigation: hero_image_url — " + (e && e.message || "must be https:// or a /-rooted absolute path"));
  }
  return s;
}

function _position(n, label) {
  label = label || "position";
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0 || n > MAX_POSITION) {
    throw new TypeError("categoryNavigation: " + label + " must be an integer 0..." + MAX_POSITION);
  }
  return n;
}

function _depth(n, label) {
  label = label || "depth";
  if (n == null) return DEFAULT_TREE_DEPTH;
  if (!Number.isInteger(n) || n < 1 || n > MAX_TREE_DEPTH) {
    throw new TypeError("categoryNavigation: " + label + " must be an integer 1..." + MAX_TREE_DEPTH);
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("categoryNavigation: " + label + " must be a boolean");
  }
  return v;
}

function _limit(n, max, def, label) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("categoryNavigation: " + label + " must be an integer 1..." + max);
  }
  return n;
}

function _timestampRange(from, to, label) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError("categoryNavigation." + label + ": from must be a non-negative integer (ms epoch)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError("categoryNavigation." + label + ": to must be a non-negative integer (ms epoch)");
  }
  if (from > to) {
    throw new TypeError("categoryNavigation." + label + ": from must be <= to");
  }
}

// ---- hydration ---------------------------------------------------------

function _hydrateRow(row) {
  if (!row) return null;
  return {
    slug:           row.slug,
    parent_slug:    row.parent_slug == null ? null : row.parent_slug,
    title:          row.title,
    description:    row.description == null ? null : row.description,
    hero_image_url: row.hero_image_url == null ? null : row.hero_image_url,
    position:       Number(row.position) || 0,
    active:         row.active === 1 || row.active === true,
    archived_at:    row.archived_at == null ? null : Number(row.archived_at),
    created_at:     Number(row.created_at),
    updated_at:     Number(row.updated_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // `catalog` is held as an optional read-only marker today — the
  // primitive doesn't read from it on the core verbs. `productCount`
  // delegates to `catalog.products.countByCategory(slug)` when the
  // handle is wired; without it, the count is 0. A future verb that
  // refuses archive-with-products can consume the handle without
  // changing the factory shape.
  var catalog = opts.catalog || null;
  if (catalog !== null && typeof catalog !== "object") {
    throw new TypeError("categoryNavigation.create: opts.catalog must be an object or null");
  }

  async function _readBySlug(slug) {
    var r = await query("SELECT * FROM categories WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _readChildren(parentSlug) {
    if (parentSlug == null) {
      var r1 = await query(
        "SELECT * FROM categories WHERE parent_slug IS NULL AND archived_at IS NULL " +
        "ORDER BY position ASC, slug ASC",
        []
      );
      return r1.rows;
    }
    var r2 = await query(
      "SELECT * FROM categories WHERE parent_slug = ?1 AND archived_at IS NULL " +
      "ORDER BY position ASC, slug ASC",
      [parentSlug]
    );
    return r2.rows;
  }

  // Walk ancestors from a starting slug upward. Returns an array of
  // raw rows ordered child -> root. Bounded by MAX_TREE_DEPTH so a
  // malformed graph (operator-edited DB) can't infinite-loop.
  async function _walkAncestors(slug) {
    var chain = [];
    var cur = slug;
    var seen = {};
    for (var i = 0; i < MAX_TREE_DEPTH + 1; i += 1) {
      if (cur == null) break;
      if (seen[cur]) {
        var loopErr = new Error("categoryNavigation: malformed graph — cycle detected at '" + cur + "'");
        loopErr.code = "CATEGORY_GRAPH_MALFORMED";
        throw loopErr;
      }
      seen[cur] = 1;
      var row = await _readBySlug(cur);
      if (!row) break;
      chain.push(row);
      cur = row.parent_slug;
    }
    if (i > MAX_TREE_DEPTH) {
      var depthErr = new Error("categoryNavigation: ancestor chain exceeds MAX_TREE_DEPTH (" + MAX_TREE_DEPTH + ")");
      depthErr.code = "CATEGORY_GRAPH_MALFORMED";
      throw depthErr;
    }
    return chain;
  }

  // Returns true when `candidateAncestor` appears anywhere in the
  // ancestor chain of `descendantSlug` (inclusive). Used by `move`
  // and `defineCategory` to refuse cycle-introducing edges before
  // the row lands on disk.
  async function _isAncestorOrSelf(candidateAncestor, descendantSlug) {
    var cur = descendantSlug;
    var seen = {};
    for (var i = 0; i < MAX_TREE_DEPTH + 1; i += 1) {
      if (cur == null) return false;
      if (cur === candidateAncestor) return true;
      if (seen[cur]) return false;
      seen[cur] = 1;
      var row = await _readBySlug(cur);
      if (!row) return false;
      cur = row.parent_slug;
    }
    return false;
  }

  async function _nextPositionUnder(parentSlug) {
    var sql, params;
    if (parentSlug == null) {
      sql = "SELECT MAX(position) AS max_pos FROM categories WHERE parent_slug IS NULL";
      params = [];
    } else {
      sql = "SELECT MAX(position) AS max_pos FROM categories WHERE parent_slug = ?1";
      params = [parentSlug];
    }
    var r = await query(sql, params);
    var max = r.rows[0] && r.rows[0].max_pos;
    if (max == null) return 0;
    return Number(max) + 1;
  }

  // Recursive descendant fetch. Returns rows ordered breadth-first
  // (depth-1 children first, then depth-2, etc.). Each row carries
  // an injected `_depth` field so callers can render the tree
  // without re-walking. Bounded by MAX_TREE_DEPTH; archived rows
  // excluded.
  async function _readDescendants(rootSlug, maxDepth) {
    var out = [];
    var queue = [{ slug: rootSlug, depth: 0 }];
    while (queue.length) {
      var head = queue.shift();
      if (head.depth >= maxDepth) continue;
      var kids = await _readChildren(head.slug);
      for (var i = 0; i < kids.length; i += 1) {
        var kid = kids[i];
        kid._depth = head.depth + 1;
        out.push(kid);
        queue.push({ slug: kid.slug, depth: head.depth + 1 });
      }
    }
    return out;
  }

  return {
    MAX_SLUG_LEN:         MAX_SLUG_LEN,
    MAX_TITLE_LEN:        MAX_TITLE_LEN,
    MAX_DESCRIPTION_LEN:  MAX_DESCRIPTION_LEN,
    MAX_HERO_URL_LEN:     MAX_HERO_URL_LEN,
    MAX_POSITION:         MAX_POSITION,
    MAX_TREE_DEPTH:       MAX_TREE_DEPTH,
    MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
    MAX_POPULAR_LIMIT:    MAX_POPULAR_LIMIT,
    MAX_REORDER_BATCH:    MAX_REORDER_BATCH,

    // Idempotent insert / update of a single category row. The first
    // call for a slug inserts; subsequent calls patch the title /
    // description / hero / position / active fields in place. A
    // re-define on an archived slug revives the row (`archived_at`
    // clears, `active` flips back to true). `parent_slug` is
    // validated to exist + the proposed edge is checked against
    // cycles before persistence.
    defineCategory: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.defineCategory: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var title = _title(input.title);
      var description = _description(input.description);
      var heroImage = _heroImageUrl(input.hero_image_url);
      var explicitPosition = _position(input.position, "position");
      var active = input.active == null ? true : _bool(input.active, "active");

      var parentSlug = null;
      if (input.parent_slug != null) {
        parentSlug = _slug(input.parent_slug, "parent_slug");
        if (parentSlug === slug) {
          throw new TypeError("categoryNavigation.defineCategory: parent_slug must differ from slug");
        }
        var parentRow = await _readBySlug(parentSlug);
        if (!parentRow) {
          var pErr = new Error("categoryNavigation.defineCategory: parent_slug '" + parentSlug + "' not found");
          pErr.code = "CATEGORY_PARENT_NOT_FOUND";
          throw pErr;
        }
        if (parentRow.archived_at != null) {
          var aErr = new Error("categoryNavigation.defineCategory: parent_slug '" + parentSlug + "' is archived");
          aErr.code = "CATEGORY_PARENT_ARCHIVED";
          throw aErr;
        }
        // Cycle check: would the proposed parent end up downstream
        // of `slug`? Only relevant on an update (the row already
        // exists). For a fresh insert no descendants exist yet, so
        // the candidate parent's chain can be trusted.
        var existing = await _readBySlug(slug);
        if (existing) {
          var wouldCycle = await _isAncestorOrSelf(slug, parentSlug);
          if (wouldCycle) {
            var cErr = new Error("categoryNavigation.defineCategory: setting parent_slug '" + parentSlug + "' would create a cycle through '" + slug + "'");
            cErr.code = "CATEGORY_CYCLE";
            throw cErr;
          }
        }
      }

      var ts = _now();
      var existingRow = await _readBySlug(slug);
      var position;
      if (existingRow) {
        position = explicitPosition == null ? Number(existingRow.position) : explicitPosition;
        await query(
          "UPDATE categories " +
          "SET parent_slug = ?1, title = ?2, description = ?3, hero_image_url = ?4, " +
          "    position = ?5, active = ?6, archived_at = NULL, updated_at = ?7 " +
          "WHERE slug = ?8",
          [parentSlug, title, description, heroImage, position, active ? 1 : 0, ts, slug]
        );
      } else {
        position = explicitPosition == null
          ? await _nextPositionUnder(parentSlug)
          : explicitPosition;
        await query(
          "INSERT INTO categories " +
          "(slug, parent_slug, title, description, hero_image_url, position, active, " +
          " archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
          [slug, parentSlug, title, description, heroImage, position, active ? 1 : 0, ts]
        );
      }
      var fresh = await _readBySlug(slug);
      return _hydrateRow(fresh);
    },

    getCategory: async function (slug) {
      slug = _slug(slug, "slug");
      var row = await _readBySlug(slug);
      if (!row || row.archived_at != null) return null;
      return _hydrateRow(row);
    },

    // Direct children of a parent. `parent_slug` omitted / null
    // returns the top-level (root) categories. Archived rows are
    // excluded from every read.
    categoriesByParent: async function (input) {
      input = input || {};
      var parentSlug = null;
      if (input.parent_slug != null) {
        parentSlug = _slug(input.parent_slug, "parent_slug");
        var parentRow = await _readBySlug(parentSlug);
        if (!parentRow || parentRow.archived_at != null) {
          var err = new Error("categoryNavigation.categoriesByParent: parent_slug '" + parentSlug + "' not found");
          err.code = "CATEGORY_NOT_FOUND";
          throw err;
        }
      }
      var rows = await _readChildren(parentSlug);
      return rows.map(_hydrateRow);
    },

    // Nested tree. `root_slug` omitted / null roots at the top-level
    // (returns every top-level category with its descendants nested).
    // `depth` caps the recursion; default 16, max 16. Each returned
    // node has a `children` array (empty when no children at that
    // depth, or when `depth` cuts off further recursion).
    tree: async function (input) {
      input = input || {};
      var depth = _depth(input.depth, "depth");
      var rootSlug = null;
      var rootRow = null;
      if (input.root_slug != null) {
        rootSlug = _slug(input.root_slug, "root_slug");
        rootRow = await _readBySlug(rootSlug);
        if (!rootRow || rootRow.archived_at != null) {
          var err = new Error("categoryNavigation.tree: root_slug '" + rootSlug + "' not found");
          err.code = "CATEGORY_NOT_FOUND";
          throw err;
        }
      }

      async function _build(parentSlug, remaining) {
        if (remaining <= 0) return [];
        var kids = await _readChildren(parentSlug);
        var out = [];
        for (var i = 0; i < kids.length; i += 1) {
          var node = _hydrateRow(kids[i]);
          node.children = await _build(kids[i].slug, remaining - 1);
          out.push(node);
        }
        return out;
      }

      if (rootRow) {
        var rootNode = _hydrateRow(rootRow);
        rootNode.children = await _build(rootSlug, depth);
        return rootNode;
      }
      return await _build(null, depth);
    },

    // Returns the ancestor chain from root -> slug (inclusive of
    // `slug` itself), one hydrated row per level. Useful for
    // breadcrumb rendering. The current page (slug) is the last
    // entry; the storefront typically renders it as plain text
    // rather than a link.
    breadcrumbsFor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.breadcrumbsFor: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var row = await _readBySlug(slug);
      if (!row || row.archived_at != null) {
        var err = new Error("categoryNavigation.breadcrumbsFor: slug '" + slug + "' not found");
        err.code = "CATEGORY_NOT_FOUND";
        throw err;
      }
      var chain = await _walkAncestors(slug);
      // _walkAncestors returns child -> root; flip for breadcrumb
      // rendering (root -> child).
      var ordered = chain.slice().reverse();
      return ordered.map(_hydrateRow);
    },

    // Flat descendant list under a slug. `depth` caps the recursion
    // (default 16). Returned rows carry a `depth` field (1 = direct
    // child of `slug`, 2 = grandchild, etc.) — the caller can
    // reconstruct a nested shape if needed, or just iterate the
    // flat list (e.g. to count descendants).
    descendantsOf: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.descendantsOf: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var depth = _depth(input.depth, "depth");
      var row = await _readBySlug(slug);
      if (!row || row.archived_at != null) {
        var err = new Error("categoryNavigation.descendantsOf: slug '" + slug + "' not found");
        err.code = "CATEGORY_NOT_FOUND";
        throw err;
      }
      var rows = await _readDescendants(slug, depth);
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var hydrated = _hydrateRow(rows[i]);
        hydrated.depth = rows[i]._depth;
        out.push(hydrated);
      }
      return out;
    },

    // Re-parent + optionally re-position a category. The cycle
    // guard is the load-bearing check: moving `outdoors` under its
    // own descendant `tents` would create a cycle, and a JSON
    // round-trip can't validate that without an ancestor walk.
    // `new_parent_slug: null` promotes the category to top-level.
    move: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.move: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var newParentSlug = null;
      if (input.new_parent_slug != null) {
        newParentSlug = _slug(input.new_parent_slug, "new_parent_slug");
      }
      var newPosition = _position(input.new_position, "new_position");

      var row = await _readBySlug(slug);
      if (!row || row.archived_at != null) {
        var err = new Error("categoryNavigation.move: slug '" + slug + "' not found");
        err.code = "CATEGORY_NOT_FOUND";
        throw err;
      }

      if (newParentSlug !== null) {
        if (newParentSlug === slug) {
          throw new TypeError("categoryNavigation.move: new_parent_slug must differ from slug");
        }
        var parentRow = await _readBySlug(newParentSlug);
        if (!parentRow || parentRow.archived_at != null) {
          var pErr = new Error("categoryNavigation.move: new_parent_slug '" + newParentSlug + "' not found");
          pErr.code = "CATEGORY_PARENT_NOT_FOUND";
          throw pErr;
        }
        // Cycle check — would the proposed parent be downstream of
        // the moving slug?
        var wouldCycle = await _isAncestorOrSelf(slug, newParentSlug);
        if (wouldCycle) {
          var cErr = new Error("categoryNavigation.move: moving '" + slug + "' under '" + newParentSlug + "' would create a cycle");
          cErr.code = "CATEGORY_CYCLE";
          throw cErr;
        }
      }

      var ts = _now();
      var position = newPosition == null
        ? await _nextPositionUnder(newParentSlug)
        : newPosition;
      await query(
        "UPDATE categories SET parent_slug = ?1, position = ?2, updated_at = ?3 WHERE slug = ?4",
        [newParentSlug, position, ts, slug]
      );
      var fresh = await _readBySlug(slug);
      return _hydrateRow(fresh);
    },

    // Soft-delete. `cascade: true` recursively archives every
    // descendant; without it, the call refuses when descendants
    // exist so an operator doesn't orphan a sub-tree. Archived
    // rows are hidden from every read surface.
    archive: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.archive: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var cascade = input.cascade === true;
      var row = await _readBySlug(slug);
      if (!row) {
        var err = new Error("categoryNavigation.archive: slug '" + slug + "' not found");
        err.code = "CATEGORY_NOT_FOUND";
        throw err;
      }
      if (row.archived_at != null) {
        return _hydrateRow(row);
      }

      var descendants = await _readDescendants(slug, MAX_TREE_DEPTH);
      if (descendants.length && !cascade) {
        var dErr = new Error("categoryNavigation.archive: slug '" + slug + "' has " + descendants.length + " descendant(s); pass cascade=true to archive the sub-tree");
        dErr.code = "CATEGORY_HAS_DESCENDANTS";
        throw dErr;
      }

      var ts = _now();
      await query(
        "UPDATE categories SET archived_at = ?1, active = 0, updated_at = ?1 WHERE slug = ?2",
        [ts, slug]
      );
      if (cascade) {
        for (var i = 0; i < descendants.length; i += 1) {
          await query(
            "UPDATE categories SET archived_at = ?1, active = 0, updated_at = ?1 WHERE slug = ?2",
            [ts, descendants[i].slug]
          );
        }
      }
      var fresh = await _readBySlug(slug);
      return _hydrateRow(fresh);
    },

    // Patch an existing category. The patch envelope can contain any
    // subset of { title, description, hero_image_url, active,
    // position }. Parent re-parenting goes through `move` so the
    // cycle guard fires; trying to patch `parent_slug` here is
    // refused.
    update: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.update: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var patch = input.patch;
      if (!patch || typeof patch !== "object") {
        throw new TypeError("categoryNavigation.update: patch object required");
      }
      if (Object.prototype.hasOwnProperty.call(patch, "parent_slug")) {
        throw new TypeError("categoryNavigation.update: re-parenting goes through move(), not update()");
      }
      if (Object.prototype.hasOwnProperty.call(patch, "slug")) {
        throw new TypeError("categoryNavigation.update: slug is immutable");
      }
      var row = await _readBySlug(slug);
      if (!row) {
        var err = new Error("categoryNavigation.update: slug '" + slug + "' not found");
        err.code = "CATEGORY_NOT_FOUND";
        throw err;
      }
      if (row.archived_at != null) {
        var aErr = new Error("categoryNavigation.update: slug '" + slug + "' is archived");
        aErr.code = "CATEGORY_ARCHIVED";
        throw aErr;
      }

      var title = Object.prototype.hasOwnProperty.call(patch, "title")
        ? _title(patch.title)
        : row.title;
      var description = Object.prototype.hasOwnProperty.call(patch, "description")
        ? _description(patch.description)
        : row.description;
      var heroImage = Object.prototype.hasOwnProperty.call(patch, "hero_image_url")
        ? _heroImageUrl(patch.hero_image_url)
        : row.hero_image_url;
      var active = Object.prototype.hasOwnProperty.call(patch, "active")
        ? _bool(patch.active, "active")
        : (row.active === 1 || row.active === true);
      var position = Object.prototype.hasOwnProperty.call(patch, "position")
        ? _position(patch.position, "position")
        : Number(row.position);
      if (position == null) position = Number(row.position);

      var ts = _now();
      await query(
        "UPDATE categories " +
        "SET title = ?1, description = ?2, hero_image_url = ?3, active = ?4, " +
        "    position = ?5, updated_at = ?6 " +
        "WHERE slug = ?7",
        [title, description, heroImage, active ? 1 : 0, position, ts, slug]
      );
      var fresh = await _readBySlug(slug);
      return _hydrateRow(fresh);
    },

    // Re-assign sibling positions in bulk. `ordered_slugs` must be a
    // COMPLETE list of the parent's direct children — a missing slug
    // is refused so it can't silently drift to the end of the order.
    // Positions are re-stamped 0..N-1 in the supplied order.
    reorderSiblings: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.reorderSiblings: input object required");
      }
      var parentSlug = null;
      if (input.parent_slug != null) {
        parentSlug = _slug(input.parent_slug, "parent_slug");
        var parentRow = await _readBySlug(parentSlug);
        if (!parentRow || parentRow.archived_at != null) {
          var pErr = new Error("categoryNavigation.reorderSiblings: parent_slug '" + parentSlug + "' not found");
          pErr.code = "CATEGORY_NOT_FOUND";
          throw pErr;
        }
      }
      var orderedSlugs = input.ordered_slugs;
      if (!Array.isArray(orderedSlugs)) {
        throw new TypeError("categoryNavigation.reorderSiblings: ordered_slugs must be an array");
      }
      if (orderedSlugs.length > MAX_REORDER_BATCH) {
        throw new TypeError("categoryNavigation.reorderSiblings: ordered_slugs must contain <= " + MAX_REORDER_BATCH + " entries");
      }
      var seen = {};
      for (var i = 0; i < orderedSlugs.length; i += 1) {
        var s = _slug(orderedSlugs[i], "ordered_slugs[" + i + "]");
        if (seen[s]) {
          throw new TypeError("categoryNavigation.reorderSiblings: ordered_slugs contains duplicate '" + s + "'");
        }
        seen[s] = 1;
      }

      var children = await _readChildren(parentSlug);
      if (children.length !== orderedSlugs.length) {
        throw new TypeError(
          "categoryNavigation.reorderSiblings: ordered_slugs has " + orderedSlugs.length +
          " entries but parent has " + children.length + " direct children — supply a complete list"
        );
      }
      var childSet = {};
      for (var c = 0; c < children.length; c += 1) childSet[children[c].slug] = 1;
      for (var k = 0; k < orderedSlugs.length; k += 1) {
        if (!childSet[orderedSlugs[k]]) {
          throw new TypeError(
            "categoryNavigation.reorderSiblings: '" + orderedSlugs[k] +
            "' is not a direct child of parent_slug " + JSON.stringify(parentSlug)
          );
        }
      }

      var ts = _now();
      for (var p = 0; p < orderedSlugs.length; p += 1) {
        await query(
          "UPDATE categories SET position = ?1, updated_at = ?2 WHERE slug = ?3",
          [p, ts, orderedSlugs[p]]
        );
      }
      var fresh = await _readChildren(parentSlug);
      return fresh.map(_hydrateRow);
    },

    // Product-count adjacency. When `opts.catalog` exposes a
    // `products.countByCategory(slug)` method the primitive delegates
    // to it; without the handle the count is 0. `include_descendants`
    // sums every descendant's count under the slug (one DB walk +
    // one count call per category).
    productCount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.productCount: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var includeDescendants = input.include_descendants === true;
      var row = await _readBySlug(slug);
      if (!row || row.archived_at != null) {
        var err = new Error("categoryNavigation.productCount: slug '" + slug + "' not found");
        err.code = "CATEGORY_NOT_FOUND";
        throw err;
      }

      function _countFor(s) {
        if (!catalog || !catalog.products || typeof catalog.products.countByCategory !== "function") {
          return Promise.resolve(0);
        }
        return Promise.resolve(catalog.products.countByCategory(s));
      }

      var ownCount = Number(await _countFor(slug)) || 0;
      if (!includeDescendants) {
        return { slug: slug, count: ownCount, includes_descendants: false };
      }
      var descendants = await _readDescendants(slug, MAX_TREE_DEPTH);
      var total = ownCount;
      for (var i = 0; i < descendants.length; i += 1) {
        total += Number(await _countFor(descendants[i].slug)) || 0;
      }
      return { slug: slug, count: total, includes_descendants: true };
    },

    // Top-N categories by combined product count over the active +
    // non-archived set. The "popular" signal is the product-count
    // delegation above (no separate view log — categories are
    // operator-curated, not customer-visited like KB articles), so
    // the window is informational: the returned snapshot reflects
    // the catalog state at call time, restricted to categories
    // created within [from, to]. Operators who want a true traffic-
    // weighted popularity ranking compose with the clickstream
    // primitive.
    popularCategories: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("categoryNavigation.popularCategories: input object required");
      }
      _timestampRange(input.from, input.to, "popularCategories");
      var limit = _limit(input.limit, MAX_POPULAR_LIMIT, DEFAULT_POPULAR_LIMIT, "limit");

      var r = await query(
        "SELECT slug FROM categories " +
        "WHERE archived_at IS NULL AND active = 1 " +
        "  AND created_at >= ?1 AND created_at <= ?2",
        [input.from, input.to]
      );
      var scored = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var s = r.rows[i].slug;
        var count = 0;
        if (catalog && catalog.products && typeof catalog.products.countByCategory === "function") {
          count = Number(await catalog.products.countByCategory(s)) || 0;
        }
        scored.push({ slug: s, count: count });
      }
      scored.sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count;
        if (a.slug < b.slug) return -1;
        if (a.slug > b.slug) return 1;
        return 0;
      });
      return scored.slice(0, limit);
    },
  };
}

module.exports = {
  create:              create,
  MAX_SLUG_LEN:        MAX_SLUG_LEN,
  MAX_TITLE_LEN:       MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN: MAX_DESCRIPTION_LEN,
  MAX_HERO_URL_LEN:    MAX_HERO_URL_LEN,
  MAX_POSITION:        MAX_POSITION,
  MAX_TREE_DEPTH:      MAX_TREE_DEPTH,
  MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
  MAX_POPULAR_LIMIT:   MAX_POPULAR_LIMIT,
  MAX_REORDER_BATCH:   MAX_REORDER_BATCH,
};
