"use strict";
/**
 * @module shop.customerNotes
 * @title  Customer notes — operator-side CRM annotations on a customer
 *
 * @intro
 *   Durable, customer-level annotations a support agent or account
 *   manager wants surfaced every time that customer is on the line.
 *   Distinct from `orderNotes` (which carries per-order conversation
 *   threads): a `customer_notes` row is attached to the customer
 *   record itself and persists across that customer's entire order
 *   history.
 *
 *   The shape covers the canonical operator vocabulary:
 *
 *     "VIP — comp shipping where possible"
 *     "Always wants gift wrap on orders > $100"
 *     "Do not call after 6pm"
 *     "Allergic to peanut packaging — flag before fulfilment"
 *
 *   Every note is operator-only. There is no customer-facing channel
 *   here — customer-visible content belongs in the customer-portal
 *   surface, never in this table.
 *
 *   Surface:
 *     addNote({ customer_id, author, author_id?, body, kind?, tags? })
 *     getNote(note_id)
 *     notesForCustomer({ customer_id, kind?, tags?, cursor?, limit?,
 *                        include_archived? })
 *     updateNote(note_id, patch)
 *     archiveNote(note_id) / unarchiveNote(note_id)
 *     pinNote(note_id)    / unpinNote(note_id)
 *     searchByTag({ tag, limit, cursor })
 *     popularTags({ limit })
 *
 *   Composes:
 *     - `b.guardUuid`  — UUID-shape validation for note ids
 *     - `b.uuid.v7`    — row primary keys (monotonic lex-sortable)
 *     - `b.pagination` — HMAC-tagged tuple cursors for the listings
 *
 *   Storage: `migrations-d1/0134_customer_notes.sql` —
 *     `customer_notes` (single table).
 *
 * @primitive customerNotes
 * @related   b.guardUuid, b.uuid, b.pagination
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var ALLOWED_AUTHORS  = Object.freeze(["operator", "system"]);
var ALLOWED_KINDS    = Object.freeze(["general", "preference", "escalation", "warning", "billing"]);

var MAX_BODY_LEN     = 8000;
var MAX_TAG_COUNT    = 16;
var MAX_TAG_LEN      = 64;
var MAX_CUSTOMER_ID  = 200;
var MAX_AUTHOR_ID    = 200;

var DEFAULT_LIMIT    = 50;
var MAX_LIMIT        = 200;
var DEFAULT_TAG_LIMIT = 20;
var MAX_TAG_FETCH    = 100;

// Refuse C0 control bytes + DEL across the body, tags, and ids. CR/LF
// + tab survive in `body` so operators can wrap a multi-line note;
// tags + ids are single-line and refuse CR/LF too via the strict re.
var CONTROL_BYTE_RE        = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var CONTROL_BYTE_STRICT_RE = /[\x00-\x1f\x7f]/;
// Zero-width / direction-override / BOM family. Spelled with
// \u-escapes so the source file stays free of irregular-whitespace
// ESLint hits.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// Tag shape — lowercase alnum + dash + underscore. The operator UI
// canonicalises on input (lower-case) so the popularTags aggregate
// doesn't fragment between "VIP" and "vip".
var TAG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

// (pinned DESC, created_at DESC, id DESC) — pinned notes float to
// the top; the id tie-break keeps cursor pagination deterministic
// when two notes land in the same millisecond.
var LIST_ORDER_KEY     = ["pinned:desc", "created_at:desc", "id:desc"];
// (created_at DESC, id DESC) for searchByTag — pin order doesn't
// apply to a single-tag scan across customers.
var TAG_LIST_ORDER_KEY = ["created_at:desc", "id:desc"];

// ---- monotonic clock ----------------------------------------------------
//
// Notes are listed by `created_at DESC`. Operators routinely add two
// notes in the same millisecond (paste-from-clipboard, bulk-import
// during onboarding) — the strict-monotonic clock guarantees distinct
// timestamps so the (created_at, id) tie-break never collapses to a
// single equivalence class. Tests that add notes in tight loops rely
// on this for ordering assertions.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _customerId(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_CUSTOMER_ID) {
    throw new TypeError("customerNotes: customer_id must be a non-empty string (<= " + MAX_CUSTOMER_ID + " chars)");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s)) {
    throw new TypeError("customerNotes: customer_id must not contain control bytes");
  }
  return s;
}

function _author(s) {
  if (typeof s !== "string" || ALLOWED_AUTHORS.indexOf(s) === -1) {
    throw new TypeError("customerNotes: author must be one of " + ALLOWED_AUTHORS.join(", "));
  }
  return s;
}

function _authorId(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_AUTHOR_ID) {
    throw new TypeError("customerNotes: author_id must be a non-empty string (<= " + MAX_AUTHOR_ID + " chars) when provided");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s)) {
    throw new TypeError("customerNotes: author_id must not contain control bytes");
  }
  return s;
}

function _kind(s) {
  if (s == null) return "general";
  if (typeof s !== "string" || ALLOWED_KINDS.indexOf(s) === -1) {
    throw new TypeError("customerNotes: kind must be one of " + ALLOWED_KINDS.join(", "));
  }
  return s;
}

function _body(s) {
  if (typeof s !== "string") {
    throw new TypeError("customerNotes: body must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("customerNotes: body must be non-empty after trim");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("customerNotes: body must be <= " + MAX_BODY_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("customerNotes: body must not contain control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("customerNotes: body must not contain zero-width / direction-override characters");
  }
  return s;
}

function _tag(t, label) {
  if (typeof t !== "string" || !TAG_RE.test(t)) {
    throw new TypeError("customerNotes: " + label + " must be lowercase alnum / underscore / dash, 1.." +
                        MAX_TAG_LEN + " chars (no leading/trailing dash)");
  }
  if (t.length > MAX_TAG_LEN) {
    throw new TypeError("customerNotes: " + label + " must be <= " + MAX_TAG_LEN + " characters");
  }
  return t;
}

function _tags(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("customerNotes: tags must be an array of strings");
  }
  if (input.length > MAX_TAG_COUNT) {
    throw new TypeError("customerNotes: tags array must contain <= " + MAX_TAG_COUNT + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    var t = _tag(input[i], "tags[" + i + "]");
    if (seen[t]) {
      throw new TypeError("customerNotes: tags[" + i + "] duplicates a previous entry");
    }
    seen[t] = true;
    out.push(t);
  }
  return out;
}

function _filterTags(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) {
    throw new TypeError("customerNotes: tags filter must be an array of strings");
  }
  if (input.length === 0) return null;
  if (input.length > MAX_TAG_COUNT) {
    throw new TypeError("customerNotes: tags filter must contain <= " + MAX_TAG_COUNT + " entries");
  }
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    out.push(_tag(input[i], "tags filter[" + i + "]"));
  }
  return out;
}

function _limit(n, max) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > (max || MAX_LIMIT)) {
    throw new TypeError("customerNotes: limit must be an integer 1..." + (max || MAX_LIMIT));
  }
  return n;
}

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customerNotes: " + label + " — " + (e && e.message || "invalid UUID")); }
}

// ---- row hydration ------------------------------------------------------

function _hydrate(row) {
  if (!row) return row;
  var tags;
  try { tags = JSON.parse(row.tags_json || "[]"); }
  catch (_e) { tags = []; }
  return {
    id:          row.id,
    customer_id: row.customer_id,
    author:      row.author,
    author_id:   row.author_id != null ? row.author_id : null,
    body:        row.body,
    kind:        row.kind,
    tags:        Array.isArray(tags) ? tags : [],
    pinned:      Number(row.pinned) === 1 ? 1 : 0,
    archived_at: row.archived_at != null ? Number(row.archived_at) : null,
    created_at:  Number(row.created_at),
    updated_at:  Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Pagination cursors are HMAC-tagged via b.pagination so an
  // operator can't hand-craft one to skip past a hidden note or
  // replay across deployments. Production deployments must supply a
  // derived secret (typically
  // `b.crypto.namespaceHash("customer-notes-cursor", D1_BRIDGE_SECRET)`);
  // dev / test gets a placeholder that boots without env wiring.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("customerNotes.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "customer-notes-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label, orderKey) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("customerNotes." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = _b().pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(orderKey)) {
        throw new TypeError("customerNotes." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("customerNotes." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNextNotes(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return _b().pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [last.pinned, last.created_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  function _encodeNextTag(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return _b().pagination.encodeCursor({
      orderKey: TAG_LIST_ORDER_KEY,
      vals:     [last.created_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM customer_notes WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // ---- addNote ---------------------------------------------------------

  async function addNote(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerNotes.addNote: input object required");
    }
    var customerId = _customerId(input.customer_id);
    var author     = _author(input.author);
    var authorId   = _authorId(input.author_id);
    var body       = _body(input.body);
    var kind       = _kind(input.kind);
    var tags       = _tags(input.tags);

    var id = _b().uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO customer_notes " +
      "(id, customer_id, author, author_id, body, kind, tags_json, pinned, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, ?8)",
      [id, customerId, author, authorId, body, kind, JSON.stringify(tags), ts],
    );
    return _hydrate(await _getRaw(id));
  }

  // ---- getNote ---------------------------------------------------------

  async function getNote(id) {
    _uuid(id, "note_id");
    return _hydrate(await _getRaw(id));
  }

  // ---- notesForCustomer ------------------------------------------------

  async function notesForCustomer(listOpts) {
    if (!listOpts || typeof listOpts !== "object") {
      throw new TypeError("customerNotes.notesForCustomer: input object required");
    }
    var customerId      = _customerId(listOpts.customer_id);
    var kind            = listOpts.kind == null ? null : _kind(listOpts.kind);
    var tagFilter       = _filterTags(listOpts.tags);
    var includeArchived = listOpts.include_archived === true;
    if (listOpts.include_archived != null && typeof listOpts.include_archived !== "boolean") {
      throw new TypeError("customerNotes.notesForCustomer: include_archived must be a boolean when provided");
    }
    var limit      = _limit(listOpts.limit, MAX_LIMIT);
    var cursorVals = _decodeCursor(listOpts.cursor, "notesForCustomer", LIST_ORDER_KEY);

    var where  = ["customer_id = ?1"];
    var params = [customerId];
    var idx    = 2;
    if (!includeArchived) {
      where.push("archived_at IS NULL");
    }
    if (kind != null) {
      where.push("kind = ?" + idx);
      params.push(kind);
      idx += 1;
    }
    if (cursorVals) {
      var a = idx;     // pinned
      var b = idx + 1; // created_at
      var c = idx + 2; // id
      where.push(
        "(pinned < ?" + a + " OR " +
        "(pinned = ?" + a + " AND created_at < ?" + b + ") OR " +
        "(pinned = ?" + a + " AND created_at = ?" + b + " AND id < ?" + c + "))"
      );
      params.push(cursorVals[0], cursorVals[1], cursorVals[2]);
      idx += 3;
    }
    params.push(limit);
    var sql = "SELECT * FROM customer_notes WHERE " + where.join(" AND ") +
              " ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ?" + idx;
    var r = await query(sql, params);
    var rows = r.rows.map(_hydrate);

    // Capture the SQL-page tail BEFORE the in-memory tag filter — the
    // cursor must advance over every candidate the operator already
    // saw, including the ones the tag filter dropped. Otherwise a
    // tag-filtered listing would re-visit the dropped rows on every
    // subsequent page until the cursor finally crossed them.
    var nextCursor = _encodeNextNotes(rows, limit);

    // Tag filter applied in-memory (small page sizes; SQLite LIKE-on-
    // JSON would force a full scan and lock the operator into one
    // dialect). The match semantics are ANY: a note matches when at
    // least one filter tag appears on the note. Use a single-tag
    // searchByTag() when the operator wants a cross-customer view.
    if (tagFilter && tagFilter.length) {
      var filtered = [];
      for (var i = 0; i < rows.length; i += 1) {
        var noteTags = rows[i].tags || [];
        var matched = false;
        for (var j = 0; j < tagFilter.length && !matched; j += 1) {
          if (noteTags.indexOf(tagFilter[j]) !== -1) matched = true;
        }
        if (matched) filtered.push(rows[i]);
      }
      rows = filtered;
    }

    return { rows: rows, next_cursor: nextCursor };
  }

  // ---- updateNote ------------------------------------------------------
  //
  // Patch the mutable columns of an existing note. The set is small on
  // purpose: customer_id / author / author_id are stamped at creation
  // and don't move (a re-attribution is a delete + re-create); body /
  // kind / tags are the operator-editable surface.

  async function updateNote(id, patch) {
    _uuid(id, "note_id");
    if (!patch || typeof patch !== "object") {
      throw new TypeError("customerNotes.updateNote: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("customerNotes.updateNote: patch must set at least one column");
    }
    var ALLOWED = { body: true, kind: true, tags: true };
    for (var k = 0; k < keys.length; k += 1) {
      if (!ALLOWED[keys[k]]) {
        throw new TypeError("customerNotes.updateNote: unsupported column " + JSON.stringify(keys[k]));
      }
    }

    var existing = await _getRaw(id);
    if (!existing) {
      var err = new Error("customerNotes.updateNote: note " + id + " not found");
      err.code = "CUSTOMER_NOTE_NOT_FOUND";
      throw err;
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    if (Object.prototype.hasOwnProperty.call(patch, "body")) {
      sets.push("body = ?" + idx);
      params.push(_body(patch.body));
      idx += 1;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "kind")) {
      // Explicit null on update would mean "clear kind", which the
      // schema refuses (NOT NULL CHECK). Validate as a kind value.
      sets.push("kind = ?" + idx);
      params.push(_kind(patch.kind));
      idx += 1;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) {
      sets.push("tags_json = ?" + idx);
      params.push(JSON.stringify(_tags(patch.tags)));
      idx += 1;
    }
    var ts = _now();
    sets.push("updated_at = ?" + idx);
    params.push(ts);
    idx += 1;
    params.push(id);
    await query(
      "UPDATE customer_notes SET " + sets.join(", ") + " WHERE id = ?" + idx,
      params,
    );
    return _hydrate(await _getRaw(id));
  }

  // ---- archive / unarchive --------------------------------------------

  async function archiveNote(id) {
    _uuid(id, "note_id");
    var existing = await _getRaw(id);
    if (!existing) {
      var err = new Error("customerNotes.archiveNote: note " + id + " not found");
      err.code = "CUSTOMER_NOTE_NOT_FOUND";
      throw err;
    }
    if (existing.archived_at != null) {
      // Idempotent — re-archive returns the unchanged row.
      return _hydrate(existing);
    }
    var ts = _now();
    await query(
      "UPDATE customer_notes SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
      [ts, id],
    );
    return _hydrate(await _getRaw(id));
  }

  async function unarchiveNote(id) {
    _uuid(id, "note_id");
    var existing = await _getRaw(id);
    if (!existing) {
      var err = new Error("customerNotes.unarchiveNote: note " + id + " not found");
      err.code = "CUSTOMER_NOTE_NOT_FOUND";
      throw err;
    }
    if (existing.archived_at == null) {
      return _hydrate(existing);
    }
    var ts = _now();
    await query(
      "UPDATE customer_notes SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
      [ts, id],
    );
    return _hydrate(await _getRaw(id));
  }

  // ---- pin / unpin -----------------------------------------------------

  async function pinNote(id) {
    _uuid(id, "note_id");
    var ts = _now();
    var r = await query(
      "UPDATE customer_notes SET pinned = 1, updated_at = ?1 WHERE id = ?2",
      [ts, id],
    );
    if (Number(r.rowCount || 0) === 0) {
      var err = new Error("customerNotes.pinNote: note " + id + " not found");
      err.code = "CUSTOMER_NOTE_NOT_FOUND";
      throw err;
    }
    return _hydrate(await _getRaw(id));
  }

  async function unpinNote(id) {
    _uuid(id, "note_id");
    var ts = _now();
    var r = await query(
      "UPDATE customer_notes SET pinned = 0, updated_at = ?1 WHERE id = ?2",
      [ts, id],
    );
    if (Number(r.rowCount || 0) === 0) {
      var err = new Error("customerNotes.unpinNote: note " + id + " not found");
      err.code = "CUSTOMER_NOTE_NOT_FOUND";
      throw err;
    }
    return _hydrate(await _getRaw(id));
  }

  // ---- searchByTag -----------------------------------------------------
  //
  // Cross-customer scan for every note carrying a single tag. The
  // operator console uses this to find every customer flagged "vip"
  // or "fraud-watch" across the entire customer base.

  async function searchByTag(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerNotes.searchByTag: input object required");
    }
    var tag        = _tag(input.tag, "tag");
    var limit      = _limit(input.limit, MAX_LIMIT);
    var cursorVals = _decodeCursor(input.cursor, "searchByTag", TAG_LIST_ORDER_KEY);

    var where  = ["archived_at IS NULL"];
    var params = [];
    var idx    = 1;
    if (cursorVals) {
      var a = idx;     // created_at
      var b = idx + 1; // id
      where.push(
        "(created_at < ?" + a + " OR (created_at = ?" + a + " AND id < ?" + b + "))"
      );
      params.push(cursorVals[0], cursorVals[1]);
      idx += 2;
    }
    params.push(limit);
    // Fetch a 2× buffer so the in-memory tag filter has headroom to
    // reach the requested page size even when half the candidates
    // miss. Operators with high tag-cardinality customers can call
    // again with the returned cursor to drain the rest.
    var sql = "SELECT * FROM customer_notes WHERE " + where.join(" AND ") +
              " ORDER BY created_at DESC, id DESC LIMIT ?" + idx;
    // Replace the limit slot with a buffered fetch.
    var bufferedLimit = Math.min(limit * 4, MAX_LIMIT * 4);
    params[params.length - 1] = bufferedLimit;
    var r = await query(sql, params);

    var matches = [];
    var lastScanned = null;
    for (var i = 0; i < r.rows.length && matches.length < limit; i += 1) {
      var hydrated = _hydrate(r.rows[i]);
      lastScanned = hydrated;
      if (hydrated.tags.indexOf(tag) !== -1) matches.push(hydrated);
    }

    // Cursor advances on the last SCANNED row, not the last match —
    // otherwise a page that exhausts its buffer with mostly-misses
    // would emit a null cursor while subsequent matches still wait
    // behind the buffer tail. The caller pages until the SQL fetch
    // returns fewer rows than the buffered limit (signalling "no
    // more candidates anywhere"), at which point we emit null.
    var nextCursor = null;
    if (lastScanned && r.rows.length >= bufferedLimit) {
      nextCursor = _b().pagination.encodeCursor({
        orderKey: TAG_LIST_ORDER_KEY,
        vals:     [lastScanned.created_at, lastScanned.id],
        forward:  true,
      }, cursorSecret);
    } else if (matches.length === limit && r.rows.length > matches.length) {
      // We filled the requested page before exhausting the buffer —
      // hand back the last-match cursor so the next call resumes
      // immediately after.
      nextCursor = _b().pagination.encodeCursor({
        orderKey: TAG_LIST_ORDER_KEY,
        vals:     [matches[matches.length - 1].created_at, matches[matches.length - 1].id],
        forward:  true,
      }, cursorSecret);
    }

    return { rows: matches, next_cursor: nextCursor };
  }

  // ---- popularTags -----------------------------------------------------
  //
  // Aggregate the in-use tag vocabulary, ordered by usage count DESC.
  // The operator console uses this to populate the tag picker so
  // agents tag-on-create with the existing taxonomy instead of
  // inventing fresh near-duplicates ("vip" vs "vip-customer").

  async function popularTags(input) {
    input = input || {};
    var limit;
    if (input.limit == null) {
      limit = DEFAULT_TAG_LIMIT;
    } else if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > MAX_TAG_FETCH) {
      throw new TypeError("customerNotes.popularTags: limit must be an integer 1..." + MAX_TAG_FETCH);
    } else {
      limit = input.limit;
    }

    // Single full scan of non-archived notes. The table fits this
    // shape because cardinality is bounded (an operator typically
    // carries hundreds-to-thousands of customer notes, not millions);
    // when the table outgrows the assumption the aggregation moves to
    // a materialised view in a follow-up primitive.
    var r = await query(
      "SELECT tags_json FROM customer_notes WHERE archived_at IS NULL",
      [],
    );
    var counts = Object.create(null);
    for (var i = 0; i < r.rows.length; i += 1) {
      var tags;
      try { tags = JSON.parse(r.rows[i].tags_json || "[]"); }
      catch (_e) { tags = []; }
      if (!Array.isArray(tags)) continue;
      for (var j = 0; j < tags.length; j += 1) {
        var t = tags[j];
        if (typeof t !== "string") continue;
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    var keys = Object.keys(counts);
    keys.sort(function (a, b) {
      var d = counts[b] - counts[a];
      if (d !== 0) return d;
      // Alphabetical tie-break so the operator UI doesn't shuffle the
      // tag picker across reloads when two tags tie on count.
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    var out = [];
    for (var k = 0; k < keys.length && out.length < limit; k += 1) {
      out.push({ tag: keys[k], count: counts[keys[k]] });
    }
    return out;
  }

  return {
    ALLOWED_AUTHORS:  ALLOWED_AUTHORS.slice(),
    ALLOWED_KINDS:    ALLOWED_KINDS.slice(),
    MAX_BODY_LEN:     MAX_BODY_LEN,
    MAX_TAG_COUNT:    MAX_TAG_COUNT,
    MAX_TAG_LEN:      MAX_TAG_LEN,
    MAX_LIMIT:        MAX_LIMIT,

    addNote:          addNote,
    getNote:          getNote,
    notesForCustomer: notesForCustomer,
    updateNote:       updateNote,
    archiveNote:      archiveNote,
    unarchiveNote:    unarchiveNote,
    pinNote:          pinNote,
    unpinNote:        unpinNote,
    searchByTag:      searchByTag,
    popularTags:      popularTags,
  };
}

module.exports = {
  create:           create,
  ALLOWED_AUTHORS:  ALLOWED_AUTHORS,
  ALLOWED_KINDS:    ALLOWED_KINDS,
  MAX_BODY_LEN:     MAX_BODY_LEN,
  MAX_TAG_COUNT:    MAX_TAG_COUNT,
  MAX_TAG_LEN:      MAX_TAG_LEN,
  MAX_LIMIT:        MAX_LIMIT,
};
