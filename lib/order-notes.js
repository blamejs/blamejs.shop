"use strict";
/**
 * @module shop.orderNotes
 * @title  Order notes — threaded customer-service notes attached to an order
 *
 * @intro
 *   Customer-service conversation surface attached to an order.
 *   Each note is either a fresh thread starter or a reply to an
 *   earlier note; visibility is either `internal` (operator-only —
 *   fraud markers, fulfillment hints, hand-offs) or
 *   `customer_visible` (rendered on the customer's order page and
 *   emailed).
 *
 *   Composes:
 *     - `b.guardUuid`  — UUID-shape validation for ids
 *     - `b.uuid.v7`    — row ids
 *     - `b.pagination` — HMAC-tagged tuple cursors for listForOrder
 *
 *   Surface:
 *     add({ order_id, author, body, visibility, parent_note_id?,
 *           author_id?, tags? })
 *     get(note_id)
 *     listForOrder({ order_id, visibility_filter?, cursor?, limit? })
 *     thread({ order_id, root_note_id })
 *     markRead({ note_id, by_actor })
 *     pin(note_id) / unpin(note_id)
 *     customerVisibleForOrder(order_id)
 *     internalForOrder(order_id, { resolved? })
 *     resolve({ note_id, resolution }) / reopen(note_id)
 *
 *   Storage:
 *     - `order_notes`      (migration `0037_order_notes.sql`)
 *     - `order_note_reads` (same migration)
 */

var MAX_BODY_LEN        = 8000;
var MAX_TAG_COUNT       = 16;
var MAX_TAG_LEN         = 32;
var MAX_RESOLUTION_LEN  = 280;
var MAX_LIST_LIMIT      = 100;
var DEFAULT_LIST_LIMIT  = 50;

var ALLOWED_AUTHORS     = ["customer", "operator", "system"];
var ALLOWED_VISIBILITY  = ["internal", "customer_visible"];

// Refuse C0 control bytes + DEL + the LRM/RLM/ZWJ/ZWNJ family of
// zero-width / direction-override characters. Newlines (LF, CR) +
// tab are tolerated because operator notes legitimately wrap.
var CONTROL_BYTE_RE     = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
// Zero-width + direction-override family: ZWSP/ZWNJ/ZWJ (U+200B-200D),
// LRM/RLM (U+200E/U+200F), the bidi-formatting block
// (U+202A-U+202E), the invisible-math block (U+2060-U+2064), the
// LRI/RLI/FSI/PDI block (U+2066-U+2069), the BOM (U+FEFF), and the
// Arabic letter mark (U+061C). Spelled with \u-escapes so the
// detector pattern stays grep-able and ESLint's
// no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE       = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// (pinned DESC, created_at DESC, id DESC) — pinned notes float to
// the top; the id tie-break keeps cursor pagination deterministic
// when two notes land in the same millisecond.
var LIST_ORDER_KEY = ["pinned:desc", "created_at:desc", "id:desc"];

// Framework handle — composed-surface accessor for the rest of the
// shop primitives. The framework-first export in `./index` makes this
// module-top deref safe at eval time.
var b = require("./index").framework;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("orderNotes: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _author(s) {
  if (typeof s !== "string" || ALLOWED_AUTHORS.indexOf(s) === -1) {
    throw new TypeError("orderNotes: author must be one of " + ALLOWED_AUTHORS.join(", "));
  }
  return s;
}

function _visibility(s) {
  if (typeof s !== "string" || ALLOWED_VISIBILITY.indexOf(s) === -1) {
    throw new TypeError("orderNotes: visibility must be one of " + ALLOWED_VISIBILITY.join(", "));
  }
  return s;
}

function _body(s) {
  if (typeof s !== "string") {
    throw new TypeError("orderNotes: body must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("orderNotes: body must be non-empty after trim");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("orderNotes: body must be <= " + MAX_BODY_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("orderNotes: body contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("orderNotes: body contains zero-width / direction-override characters");
  }
  return s;
}

function _tags(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("orderNotes: tags must be an array of strings");
  }
  if (input.length > MAX_TAG_COUNT) {
    throw new TypeError("orderNotes: tags array must contain <= " + MAX_TAG_COUNT + " entries");
  }
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    var t = input[i];
    if (typeof t !== "string" || !t.length) {
      throw new TypeError("orderNotes: tags[" + i + "] must be a non-empty string");
    }
    if (t.length > MAX_TAG_LEN) {
      throw new TypeError("orderNotes: tags[" + i + "] must be <= " + MAX_TAG_LEN + " characters");
    }
    if (CONTROL_BYTE_RE.test(t) || ZERO_WIDTH_RE.test(t)) {
      throw new TypeError("orderNotes: tags[" + i + "] contains control / zero-width bytes");
    }
    out.push(t);
  }
  return out;
}

function _resolution(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("orderNotes: resolution must be a non-empty string");
  }
  if (s.length > MAX_RESOLUTION_LEN) {
    throw new TypeError("orderNotes: resolution must be <= " + MAX_RESOLUTION_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("orderNotes: resolution contains control / zero-width bytes");
  }
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("orderNotes: limit must be an integer 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _visibilityFilter(s) {
  if (s == null) return undefined;
  if (typeof s !== "string" || ALLOWED_VISIBILITY.indexOf(s) === -1) {
    throw new TypeError("orderNotes: visibility_filter must be one of " + ALLOWED_VISIBILITY.join(", "));
  }
  return s;
}

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

function _hydrate(row) {
  if (!row) return row;
  try { row.tags = JSON.parse(row.tags_json || "[]"); }
  catch (_e) { row.tags = []; }
  return row;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged via b.pagination so an
  // operator can't hand-craft one to skip past a hidden note or
  // replay across deployments. The secret defaults to a dev-only
  // placeholder so the primitive boots in tests; production
  // deployments must supply a derived value (typically
  // b.crypto.namespaceHash("order-notes-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("orderNotes.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "order-notes-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("orderNotes." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("orderNotes." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("orderNotes." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return b.pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [last.pinned, last.created_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  // Internal helper — fetch a note by id without UUID re-validation
  // and without hydrating tags. Used by mutation methods that need
  // the raw row to confirm existence before writing.
  async function _getRaw(id) {
    var r = await query("SELECT * FROM order_notes WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  return {
    MAX_BODY_LEN:       MAX_BODY_LEN,
    MAX_TAG_COUNT:      MAX_TAG_COUNT,
    MAX_TAG_LEN:        MAX_TAG_LEN,
    MAX_RESOLUTION_LEN: MAX_RESOLUTION_LEN,
    MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
    ALLOWED_AUTHORS:    ALLOWED_AUTHORS.slice(),
    ALLOWED_VISIBILITY: ALLOWED_VISIBILITY.slice(),

    add: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderNotes.add: input object required");
      }
      var orderId    = _uuid(input.order_id, "order_id");
      var author     = _author(input.author);
      var visibility = _visibility(input.visibility);
      var body       = _body(input.body);
      var tags       = _tags(input.tags);

      var parentId = null;
      if (input.parent_note_id != null) {
        parentId = _uuid(input.parent_note_id, "parent_note_id");
        var parent = await _getRaw(parentId);
        if (!parent) {
          var pErr = new Error("orderNotes.add: parent_note_id " + parentId + " not found");
          pErr.code = "ORDER_NOTE_PARENT_NOT_FOUND";
          throw pErr;
        }
        if (parent.order_id !== orderId) {
          throw new TypeError("orderNotes.add: parent_note_id belongs to a different order");
        }
      }

      var authorId = null;
      if (input.author_id != null) {
        authorId = _uuid(input.author_id, "author_id");
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO order_notes " +
        "(id, order_id, parent_note_id, author, author_id, visibility, body, tags_json, pinned, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
        [id, orderId, parentId, author, authorId, visibility, body, JSON.stringify(tags), ts],
      );
      return await this.get(id);
    },

    get: async function (id) {
      _uuid(id, "note id");
      var row = await _getRaw(id);
      return _hydrate(row);
    },

    // Paginated note list for an order, ordered (pinned DESC,
    // created_at DESC, id DESC). Optional `visibility_filter`
    // restricts to one of the two visibility tiers — the storefront
    // calls this with `customer_visible`, the operator console with
    // either filter or none.
    listForOrder: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("orderNotes.listForOrder: input object required");
      }
      var orderId    = _uuid(listOpts.order_id, "order_id");
      var visibility = _visibilityFilter(listOpts.visibility_filter);
      var limit      = _limit(listOpts.limit);
      var cursorVals = _decodeCursor(listOpts.cursor, "listForOrder");

      // Compose the WHERE + cursor-keyset clauses. The cursor
      // keyset is `(pinned, created_at, id) < (cv0, cv1, cv2)` in
      // lexicographic order — descending across all three columns.
      var where  = ["order_id = ?1"];
      var params = [orderId];
      var idx    = 2;
      if (visibility !== undefined) {
        where.push("visibility = ?" + idx);
        params.push(visibility);
        idx += 1;
      }
      if (cursorVals) {
        var pPinned = idx;      // pinned
        var pCreated = idx + 1; // created_at
        var pId = idx + 2;      // id
        where.push(
          "(pinned < ?" + pPinned + " OR " +
          "(pinned = ?" + pPinned + " AND created_at < ?" + pCreated + ") OR " +
          "(pinned = ?" + pPinned + " AND created_at = ?" + pCreated + " AND id < ?" + pId + "))"
        );
        params.push(cursorVals[0], cursorVals[1], cursorVals[2]);
        idx += 3;
      }
      params.push(limit);
      var sql = "SELECT * FROM order_notes WHERE " + where.join(" AND ") +
                " ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ?" + idx;
      var r = await query(sql, params);
      var rows = r.rows.map(_hydrate);
      return { rows: rows, next_cursor: _encodeNext(rows, limit) };
    },

    // Tree-shaped thread starting from `root_note_id`. Returns the
    // root + every descendant (any depth) as a nested
    // `{ note, replies: [ ... ] }` structure. The caller is the
    // operator console / customer order page; both want the full
    // tree to render the conversation in order.
    thread: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderNotes.thread: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var rootId  = _uuid(input.root_note_id, "root_note_id");

      var rootRow = await _getRaw(rootId);
      if (!rootRow) {
        var rErr = new Error("orderNotes.thread: root_note_id " + rootId + " not found");
        rErr.code = "ORDER_NOTE_NOT_FOUND";
        throw rErr;
      }
      if (rootRow.order_id !== orderId) {
        throw new TypeError("orderNotes.thread: root_note_id belongs to a different order");
      }

      // Pull every note attached to the order in a single query,
      // then bucket-by-parent in memory. Cheaper than a recursive
      // CTE for the modest depths this primitive sees in practice,
      // and portable across the in-memory test DB + D1.
      var all = (await query(
        "SELECT * FROM order_notes WHERE order_id = ?1 ORDER BY created_at ASC, id ASC",
        [orderId],
      )).rows;
      var byParent = {};
      for (var i = 0; i < all.length; i += 1) {
        var n = _hydrate(all[i]);
        var pk = n.parent_note_id || "__root__";
        if (!byParent[pk]) byParent[pk] = [];
        byParent[pk].push(n);
      }

      function _buildTree(noteId) {
        var children = byParent[noteId] || [];
        var built = [];
        for (var j = 0; j < children.length; j += 1) {
          var c = children[j];
          built.push({ note: c, replies: _buildTree(c.id) });
        }
        return built;
      }

      var root = _hydrate(rootRow);
      return { note: root, replies: _buildTree(root.id) };
    },

    // Write a read receipt for a note. The (note_id, by_actor.role,
    // by_actor.id) tuple is idempotent — re-emitting a receipt for
    // the same reader is a no-op so the storefront can call this
    // from the render path without worrying about row growth.
    markRead: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderNotes.markRead: input object required");
      }
      var noteId = _uuid(input.note_id, "note_id");
      var by = input.by_actor;
      if (!by || typeof by !== "object") {
        throw new TypeError("orderNotes.markRead: by_actor object required");
      }
      var role     = _author(by.role);
      var readerId = null;
      if (by.id != null) readerId = _uuid(by.id, "by_actor.id");

      var existing = (await query(
        "SELECT id FROM order_note_reads WHERE note_id = ?1 AND reader_actor = ?2 " +
        "AND ((reader_id IS NULL AND ?3 IS NULL) OR reader_id = ?3) LIMIT 1",
        [noteId, role, readerId],
      )).rows[0];
      if (existing) return { id: existing.id, idempotent: true };

      // Confirm the note exists before writing the read row — the
      // FK would catch it but the explicit refusal carries a better
      // error code for the caller.
      var note = await _getRaw(noteId);
      if (!note) {
        var nErr = new Error("orderNotes.markRead: note " + noteId + " not found");
        nErr.code = "ORDER_NOTE_NOT_FOUND";
        throw nErr;
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO order_note_reads (id, note_id, reader_actor, reader_id, read_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, noteId, role, readerId, ts],
      );
      return { id: id, idempotent: false };
    },

    pin: async function (id) {
      _uuid(id, "note id");
      var ts = _now();
      var r = await query(
        "UPDATE order_notes SET pinned = 1, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      if (r.rowCount === 0) {
        var err = new Error("orderNotes.pin: note " + id + " not found");
        err.code = "ORDER_NOTE_NOT_FOUND";
        throw err;
      }
      return await this.get(id);
    },

    unpin: async function (id) {
      _uuid(id, "note id");
      var ts = _now();
      var r = await query(
        "UPDATE order_notes SET pinned = 0, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      if (r.rowCount === 0) {
        var err = new Error("orderNotes.unpin: note " + id + " not found");
        err.code = "ORDER_NOTE_NOT_FOUND";
        throw err;
      }
      return await this.get(id);
    },

    // Storefront convenience — only the notes the customer sees
    // for this order, pinned-first, newest-first. No cursor: the
    // storefront draws every visible note inline and the typical
    // count is small (a handful).
    customerVisibleForOrder: async function (orderId) {
      orderId = _uuid(orderId, "order_id");
      var r = await query(
        "SELECT * FROM order_notes WHERE order_id = ?1 AND visibility = 'customer_visible' " +
        "ORDER BY pinned DESC, created_at DESC, id DESC",
        [orderId],
      );
      return r.rows.map(_hydrate);
    },

    // Operator-console filter. `resolved` toggle splits the active
    // queue (resolved_at IS NULL) from the archive
    // (resolved_at IS NOT NULL); leaving it undefined returns both.
    internalForOrder: async function (orderId, filterOpts) {
      orderId = _uuid(orderId, "order_id");
      filterOpts = filterOpts || {};
      var sql, params;
      if (filterOpts.resolved === true) {
        sql = "SELECT * FROM order_notes WHERE order_id = ?1 AND visibility = 'internal' " +
              "AND resolved_at IS NOT NULL " +
              "ORDER BY pinned DESC, created_at DESC, id DESC";
        params = [orderId];
      } else if (filterOpts.resolved === false) {
        sql = "SELECT * FROM order_notes WHERE order_id = ?1 AND visibility = 'internal' " +
              "AND resolved_at IS NULL " +
              "ORDER BY pinned DESC, created_at DESC, id DESC";
        params = [orderId];
      } else if (filterOpts.resolved == null) {
        sql = "SELECT * FROM order_notes WHERE order_id = ?1 AND visibility = 'internal' " +
              "ORDER BY pinned DESC, created_at DESC, id DESC";
        params = [orderId];
      } else {
        throw new TypeError("orderNotes.internalForOrder: resolved must be boolean or undefined");
      }
      var r = await query(sql, params);
      return r.rows.map(_hydrate);
    },

    // Internal-thread workflow — close an internal note with a
    // 280-char operator summary. The note's `resolved_at` +
    // `resolution` are stamped; subsequent `reopen` clears both.
    resolve: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderNotes.resolve: input object required");
      }
      var noteId     = _uuid(input.note_id, "note_id");
      var resolution = _resolution(input.resolution);
      var existing = await _getRaw(noteId);
      if (!existing) {
        var nErr = new Error("orderNotes.resolve: note " + noteId + " not found");
        nErr.code = "ORDER_NOTE_NOT_FOUND";
        throw nErr;
      }
      if (existing.visibility !== "internal") {
        throw new TypeError("orderNotes.resolve: only internal notes can be resolved");
      }
      var ts = _now();
      await query(
        "UPDATE order_notes SET resolved_at = ?1, resolution = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, resolution, noteId],
      );
      return await this.get(noteId);
    },

    reopen: async function (id) {
      _uuid(id, "note id");
      var existing = await _getRaw(id);
      if (!existing) {
        var nErr = new Error("orderNotes.reopen: note " + id + " not found");
        nErr.code = "ORDER_NOTE_NOT_FOUND";
        throw nErr;
      }
      var ts = _now();
      await query(
        "UPDATE order_notes SET resolved_at = NULL, resolution = NULL, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      return await this.get(id);
    },
  };
}

module.exports = {
  create:             create,
  MAX_BODY_LEN:       MAX_BODY_LEN,
  MAX_TAG_COUNT:      MAX_TAG_COUNT,
  MAX_TAG_LEN:        MAX_TAG_LEN,
  MAX_RESOLUTION_LEN: MAX_RESOLUTION_LEN,
  MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
  ALLOWED_AUTHORS:    ALLOWED_AUTHORS.slice(),
  ALLOWED_VISIBILITY: ALLOWED_VISIBILITY.slice(),
};
