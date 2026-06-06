"use strict";
/**
 * @module shop.operatorAuditLog
 * @title  Operator audit log — append-only WHO/WHAT/WHICH/WHEN trail
 *
 * @intro
 *   Cryptographically chained audit trail for operator-side actions
 *   against the storefront — admin-console mutations, support-ticket
 *   state changes, manual refunds, price overrides, automated-job
 *   activity. Distinct from `b.audit` (the framework's lower-level
 *   record of cryptographic / authentication events) and from
 *   `analytics` (the customer-side behavioural stream).
 *
 *   Every row stores `prev_hash` + `row_hash`. The chain math is
 *
 *     row_hash = SHA3-512(prev_hash || canonical-json(row-without-hashes))
 *
 *   `canonical-json` is the framework's RFC 8785 walker so the
 *   preimage is byte-identical across deployments. `verifyChain`
 *   walks the table in `(occurred_at, id)` order, recomputing each
 *   hash and reporting the first row where stored ≠ computed — any
 *   post-hoc edit to a recorded row, or a deletion that breaks the
 *   linkage, surfaces with `{ ok: false, reason, break_at, ... }`.
 *
 *   Surface:
 *     - record({ actor_type, actor_id, action, resource_kind,
 *                resource_id, before?, after?, ip_hash?, ua_class? })
 *         Append a row. `before` / `after` are arbitrary JSON-safe
 *         shapes that document the state delta (or `null` for
 *         create / delete actions). Returns the persisted row with
 *         its assigned id + occurred_at + prev_hash + row_hash.
 *
 *     - listByActor({ actor_id, from?, to?, cursor? })
 *         Newest-first feed for a single actor, optionally clipped to
 *         `[from, to)` epoch-ms range. Returns
 *         `{ rows, next_cursor }` — `next_cursor` is opaque, pass it
 *         back as `cursor` to fetch the next page.
 *
 *     - listByResource({ resource_kind, resource_id, cursor? })
 *         Newest-first feed for a single resource (e.g. every change
 *         to product X).
 *
 *     - searchAction({ action, from?, to? })
 *         Find every row whose `action` matches exactly, optionally
 *         within an epoch-ms range. Used for queries like "every
 *         manual refund this month".
 *
 *     - chainHead()
 *         Current head hash — the `row_hash` of the most recent row,
 *         or the ZERO sentinel when the table is empty. Sign + store
 *         externally for tamper-evidence beyond the on-disk row.
 *
 *     - verifyChain()
 *         Recompute every row's hash and flag the first divergence.
 *         O(n) in row count; intended for operator-initiated audits,
 *         not hot-path use.
 *
 *   Composition:
 *     - `b.auditChain.canonicalize` — single source of truth for the
 *       canonical-json preimage shape (sorted keys, hash columns
 *       excluded, RFC 8785 number formatting).
 *     - `b.auditChain.ZERO_HASH` — anchor for the first row's
 *       prev_hash.
 *     - `b.crypto.sha3Hash` — SHA3-512 hex digest.
 *     - `b.uuid.v7` — row id; v7 sorts lexicographically by insertion
 *       time so the chain order matches the row id order.
 *
 *   Storage:
 *     - operator_audit_events (migration 0074_operator_audit_log.sql).
 *
 * @primitive operatorAuditLog
 * @related   b.auditChain, b.crypto.sha3Hash, b.uuid.v7
 */

var MAX_ACTOR_ID_LEN      = 128;
var MAX_ACTION_LEN        = 128;
var MAX_RESOURCE_KIND_LEN = 64;
var MAX_RESOURCE_ID_LEN   = 128;
var MAX_JSON_BYTES        = 64 * 1024;
var MAX_IP_HASH_LEN       = 256;
var MAX_LIST_LIMIT        = 200;
var DEFAULT_LIST_LIMIT    = 50;
var SHA3_512_HEX_LEN      = 128;

var ZERO_HASH = "0".repeat(SHA3_512_HEX_LEN);

// Canonical prefix for the bytes a checkpoint signs. Stable forever —
// changing it invalidates every prior checkpoint signature. Mirrors the
// framework audit chain's "blamejs-audit-checkpoint-v1" format.
var CHECKPOINT_FORMAT = "blamejs-operator-audit-checkpoint-v1";

var ALLOWED_ACTOR_TYPES = Object.freeze(["operator", "system", "app"]);
var ALLOWED_UA_CLASSES  = Object.freeze([
  "browser",
  "mobile_app",
  "api_client",
  "cli",
  "bot",
  "unknown",
]);

// Refuse C0 control bytes + DEL in operator-authored strings. The
// audit log surfaces these strings back to the operator console; the
// discipline matches every other operator-facing primitive (catalog,
// experiments, promo-banners) — strings reach the dashboard as inert
// text, never as live markup.
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$/;
var ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$/;
var KIND_RE   = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;

var b = require("./vendor/blamejs");

// ---- validators ---------------------------------------------------------

function _actorType(s) {
  if (typeof s !== "string" || ALLOWED_ACTOR_TYPES.indexOf(s) === -1) {
    throw new TypeError("operatorAuditLog: actor_type must be one of " +
      JSON.stringify(ALLOWED_ACTOR_TYPES));
  }
  return s;
}

function _uaClass(s) {
  if (s == null) return null;
  if (typeof s !== "string" || ALLOWED_UA_CLASSES.indexOf(s) === -1) {
    throw new TypeError("operatorAuditLog: ua_class must be null or one of " +
      JSON.stringify(ALLOWED_UA_CLASSES));
  }
  return s;
}

function _ident(s, label, re, maxLen) {
  if (typeof s !== "string" || !re.test(s)) {
    throw new TypeError("operatorAuditLog: " + label +
      " must match " + re.toString() + " (≤ " + maxLen + " chars)");
  }
  return s;
}

function _ipHash(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_IP_HASH_LEN) {
    throw new TypeError("operatorAuditLog: ip_hash must be a non-empty string ≤ " +
      MAX_IP_HASH_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("operatorAuditLog: ip_hash contains control / zero-width characters");
  }
  return s;
}

function _jsonValue(v, label) {
  if (v === undefined || v === null) return null;
  // Refuse non-plain-JSON shapes upfront — operators occasionally hand
  // a Date / Buffer through and would otherwise discover the silent
  // serialization difference at verify-chain time.
  var encoded;
  try { encoded = JSON.stringify(v); }
  catch (_e) {
    throw new TypeError("operatorAuditLog: " + label + " is not JSON-serializable");
  }
  if (encoded == null) {
    // JSON.stringify(undefined) returns undefined.
    throw new TypeError("operatorAuditLog: " + label + " is not JSON-serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) {
    throw new TypeError("operatorAuditLog: " + label + " JSON exceeds " +
      MAX_JSON_BYTES + " bytes");
  }
  return v;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("operatorAuditLog: " + label +
      " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
    throw new TypeError("operatorAuditLog: limit must be an integer in [1, " +
      MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- opaque cursor -----------------------------------------------------
//
// The cursor encodes (occurred_at, id) — the keyset that drives every
// listBy* query — as a base64url-encoded JSON tuple. No HMAC: the
// cursor exposes nothing not already visible in the previous page's
// last row, and the index keyset is monotonic so a hand-crafted cursor
// can only seek forward through history.

function _encodeCursor(occurredAt, id) {
  var raw = JSON.stringify([occurredAt, id]);
  return Buffer.from(raw, "utf8").toString("base64url");
}

function _decodeCursor(cursor, label) {
  if (cursor == null) return null;
  if (typeof cursor !== "string" || !cursor.length) {
    throw new TypeError("operatorAuditLog." + label +
      ": cursor must be an opaque string or null");
  }
  var raw;
  try { raw = Buffer.from(cursor, "base64url").toString("utf8"); }
  catch (_e) {
    throw new TypeError("operatorAuditLog." + label + ": cursor malformed");
  }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (_e) {
    throw new TypeError("operatorAuditLog." + label + ": cursor malformed");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new TypeError("operatorAuditLog." + label + ": cursor malformed");
  }
  if (!Number.isInteger(parsed[0]) || parsed[0] < 0 ||
      typeof parsed[1] !== "string" || !parsed[1].length) {
    throw new TypeError("operatorAuditLog." + label + ": cursor malformed");
  }
  return { occurred_at: parsed[0], id: parsed[1] };
}

// ---- chain hashing ------------------------------------------------------
//
// The preimage layout is:
//
//   row_hash = SHA3-512(prev_hash || canonical-json(row-fields))
//
// where row-fields is every column except prev_hash + row_hash. The
// canonical-json walker (b.auditChain.canonicalize) sorts keys and
// renders values per RFC 8785 so the preimage is byte-identical
// across deployments + node versions.

function _rowFieldsForHash(row) {
  return {
    id:            row.id,
    actor_type:    row.actor_type,
    actor_id:      row.actor_id,
    action:        row.action,
    resource_kind: row.resource_kind,
    resource_id:   row.resource_id,
    before:        row.before == null ? null : row.before,
    after:         row.after  == null ? null : row.after,
    ip_hash:       row.ip_hash    == null ? null : row.ip_hash,
    ua_class:      row.ua_class   == null ? null : row.ua_class,
    occurred_at:   row.occurred_at,
  };
}

function _computeRowHash(prevHash, rowFields) {
  var canonical = b.auditChain.canonicalize(rowFields, ["prev_hash", "row_hash"]);
  var preimage  = Buffer.concat([
    Buffer.from(prevHash, "hex"),
    Buffer.from(canonical, "utf8"),
  ]);
  return b.crypto.sha3Hash(preimage);
}

// ---- row hydration ------------------------------------------------------

function _hydrate(r) {
  if (!r) return null;
  var before = null;
  if (r.before_json != null) {
    try { before = JSON.parse(r.before_json); }
    catch (_e) { before = null; }
  }
  var after = null;
  if (r.after_json != null) {
    try { after = JSON.parse(r.after_json); }
    catch (_e) { after = null; }
  }
  return {
    id:            r.id,
    actor_type:    r.actor_type,
    actor_id:      r.actor_id,
    action:        r.action,
    resource_kind: r.resource_kind,
    resource_id:   r.resource_id,
    before:        before,
    after:         after,
    ip_hash:       r.ip_hash    == null ? null : r.ip_hash,
    ua_class:      r.ua_class   == null ? null : r.ua_class,
    occurred_at:   Number(r.occurred_at),
    prev_hash:     r.prev_hash,
    row_hash:      r.row_hash,
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Single-writer discipline for the append path. `record()` reads the
  // chain head, derives prev_hash + row_hash from it, then INSERTs — a
  // read-derive-write sequence that is NOT atomic across the three
  // awaits. Two concurrent record() calls would otherwise both read the
  // same head, both stamp the same prev_hash, and fork the chain — which
  // verifyChain() then reports as a prev_hash mismatch, indistinguishable
  // from a real tamper. Serializing the whole body behind a per-instance
  // mutex collapses the window: the second writer blocks until the first
  // has committed its row, so it reads the freshly-advanced head. In-
  // process only — it narrows the fork window to a single isolate, the
  // same bound the framework chain primitive carries; the checkpoint
  // anchoring below remains the cross-isolate / full-rewrite defense.
  var appendMutex = new b.safeAsync.Mutex();

  async function _currentHead() {
    var r = await query(
      "SELECT row_hash, occurred_at, id FROM operator_audit_events " +
      "ORDER BY occurred_at DESC, id DESC LIMIT 1",
      [],
    );
    if (!r.rows.length) {
      return { row_hash: ZERO_HASH, occurred_at: 0, id: null };
    }
    return {
      row_hash:    r.rows[0].row_hash,
      occurred_at: Number(r.rows[0].occurred_at),
      id:          r.rows[0].id,
    };
  }

  // -- record ------------------------------------------------------------

  async function record(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorAuditLog.record: input object required");
    }
    // Validate OUTSIDE the lock — a bad-input throw shouldn't hold the
    // append serializer, and validation touches no shared chain state.
    var actorType    = _actorType(input.actor_type);
    var actorId      = _ident(input.actor_id,      "actor_id",      IDENT_RE, MAX_ACTOR_ID_LEN);
    var action       = _ident(input.action,        "action",        ACTION_RE, MAX_ACTION_LEN);
    var resourceKind = _ident(input.resource_kind, "resource_kind", KIND_RE,   MAX_RESOURCE_KIND_LEN);
    var resourceId   = _ident(input.resource_id,   "resource_id",   IDENT_RE,  MAX_RESOURCE_ID_LEN);
    var before       = _jsonValue(input.before,    "before");
    var after        = _jsonValue(input.after,     "after");
    var ipHash       = _ipHash(input.ip_hash);
    var uaClass      = _uaClass(input.ua_class);

    // Acquire the append mutex for the head-read → hash → INSERT body so
    // the chain advances under a single writer.
    return appendMutex.runExclusive(async function () {
    var head      = await _currentHead();
    var prevHash  = head.row_hash;
    var id        = b.uuid.v7();
    // Clamp occurred_at to be strictly monotonic — same-millisecond
    // appends on a fast runner still produce a deterministic chain
    // order because the (occurred_at, id) tuple breaks ties on the v7
    // id. If wall-clock has drifted backwards relative to the head
    // (NTP step, container clock skew) we bump to head + 1ms so the
    // chain stays insertion-ordered. The v7 id is generated AFTER the
    // bump so its embedded timestamp matches the stored column.
    var occurredAt = _now();
    if (occurredAt <= head.occurred_at) {
      occurredAt = head.occurred_at + 1;
    }

    var rowFields = {
      id:            id,
      actor_type:    actorType,
      actor_id:      actorId,
      action:        action,
      resource_kind: resourceKind,
      resource_id:   resourceId,
      before:        before == null ? null : before,
      after:         after  == null ? null : after,
      ip_hash:       ipHash,
      ua_class:      uaClass,
      occurred_at:   occurredAt,
    };
    var rowHash = _computeRowHash(prevHash, rowFields);

    var beforeJson = before == null ? null : JSON.stringify(before);
    var afterJson  = after  == null ? null : JSON.stringify(after);

    await query(
      "INSERT INTO operator_audit_events " +
      "(id, actor_type, actor_id, action, resource_kind, resource_id, " +
      " before_json, after_json, ip_hash, ua_class, occurred_at, prev_hash, row_hash) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
      [id, actorType, actorId, action, resourceKind, resourceId,
       beforeJson, afterJson, ipHash, uaClass, occurredAt, prevHash, rowHash],
    );

    return {
      id:            id,
      actor_type:    actorType,
      actor_id:      actorId,
      action:        action,
      resource_kind: resourceKind,
      resource_id:   resourceId,
      before:        before == null ? null : before,
      after:         after  == null ? null : after,
      ip_hash:       ipHash,
      ua_class:      uaClass,
      occurred_at:   occurredAt,
      prev_hash:     prevHash,
      row_hash:      rowHash,
    };
    });
  }

  // -- listByActor -------------------------------------------------------

  async function listByActor(listOpts) {
    if (!listOpts || typeof listOpts !== "object") {
      throw new TypeError("operatorAuditLog.listByActor: input object required");
    }
    var actorId = _ident(listOpts.actor_id, "actor_id", IDENT_RE, MAX_ACTOR_ID_LEN);
    var from = listOpts.from == null ? null : _epochMs(listOpts.from, "from");
    var to   = listOpts.to   == null ? null : _epochMs(listOpts.to,   "to");
    if (from != null && to != null && to < from) {
      throw new TypeError("operatorAuditLog.listByActor: to must be ≥ from");
    }
    var limit  = _limit(listOpts.limit);
    var cursor = _decodeCursor(listOpts.cursor, "listByActor");

    var where  = ["actor_id = ?1"];
    var params = [actorId];
    var idx    = 2;
    if (from != null) {
      where.push("occurred_at >= ?" + idx);
      params.push(from);
      idx += 1;
    }
    if (to != null) {
      where.push("occurred_at < ?" + idx);
      params.push(to);
      idx += 1;
    }
    if (cursor) {
      where.push(
        "(occurred_at < ?" + idx + " OR " +
        "(occurred_at = ?" + idx + " AND id < ?" + (idx + 1) + "))"
      );
      params.push(cursor.occurred_at, cursor.id);
      idx += 2;
    }
    params.push(limit);
    var sql = "SELECT * FROM operator_audit_events WHERE " + where.join(" AND ") +
              " ORDER BY occurred_at DESC, id DESC LIMIT ?" + idx;
    var r = await query(sql, params);
    var rows = r.rows.map(_hydrate);
    return {
      rows:        rows,
      next_cursor: _nextCursor(rows, limit),
    };
  }

  // -- listByResource ----------------------------------------------------

  async function listByResource(listOpts) {
    if (!listOpts || typeof listOpts !== "object") {
      throw new TypeError("operatorAuditLog.listByResource: input object required");
    }
    var resourceKind = _ident(listOpts.resource_kind, "resource_kind", KIND_RE, MAX_RESOURCE_KIND_LEN);
    var resourceId   = _ident(listOpts.resource_id,   "resource_id",   IDENT_RE, MAX_RESOURCE_ID_LEN);
    var limit  = _limit(listOpts.limit);
    var cursor = _decodeCursor(listOpts.cursor, "listByResource");

    var where  = ["resource_kind = ?1", "resource_id = ?2"];
    var params = [resourceKind, resourceId];
    var idx    = 3;
    if (cursor) {
      where.push(
        "(occurred_at < ?" + idx + " OR " +
        "(occurred_at = ?" + idx + " AND id < ?" + (idx + 1) + "))"
      );
      params.push(cursor.occurred_at, cursor.id);
      idx += 2;
    }
    params.push(limit);
    var sql = "SELECT * FROM operator_audit_events WHERE " + where.join(" AND ") +
              " ORDER BY occurred_at DESC, id DESC LIMIT ?" + idx;
    var r = await query(sql, params);
    var rows = r.rows.map(_hydrate);
    return {
      rows:        rows,
      next_cursor: _nextCursor(rows, limit),
    };
  }

  // -- searchAction ------------------------------------------------------

  async function searchAction(searchOpts) {
    if (!searchOpts || typeof searchOpts !== "object") {
      throw new TypeError("operatorAuditLog.searchAction: input object required");
    }
    var action = _ident(searchOpts.action, "action", ACTION_RE, MAX_ACTION_LEN);
    var from = searchOpts.from == null ? null : _epochMs(searchOpts.from, "from");
    var to   = searchOpts.to   == null ? null : _epochMs(searchOpts.to,   "to");
    if (from != null && to != null && to < from) {
      throw new TypeError("operatorAuditLog.searchAction: to must be ≥ from");
    }
    var limit  = _limit(searchOpts.limit);
    var cursor = _decodeCursor(searchOpts.cursor, "searchAction");

    var where  = ["action = ?1"];
    var params = [action];
    var idx    = 2;
    if (from != null) {
      where.push("occurred_at >= ?" + idx);
      params.push(from);
      idx += 1;
    }
    if (to != null) {
      where.push("occurred_at < ?" + idx);
      params.push(to);
      idx += 1;
    }
    if (cursor) {
      where.push(
        "(occurred_at < ?" + idx + " OR " +
        "(occurred_at = ?" + idx + " AND id < ?" + (idx + 1) + "))"
      );
      params.push(cursor.occurred_at, cursor.id);
      idx += 2;
    }
    params.push(limit);
    var sql = "SELECT * FROM operator_audit_events WHERE " + where.join(" AND ") +
              " ORDER BY occurred_at DESC, id DESC LIMIT ?" + idx;
    var r = await query(sql, params);
    var rows = r.rows.map(_hydrate);
    return {
      rows:        rows,
      next_cursor: _nextCursor(rows, limit),
    };
  }

  function _nextCursor(rows, limit) {
    if (rows.length < limit) return null;
    var last = rows[rows.length - 1];
    return _encodeCursor(last.occurred_at, last.id);
  }

  // -- chainHead ---------------------------------------------------------

  async function chainHead() {
    var head = await _currentHead();
    return head.row_hash;
  }

  // -- verifyChain -------------------------------------------------------

  async function verifyChain() {
    var r = await query(
      "SELECT * FROM operator_audit_events ORDER BY occurred_at ASC, id ASC",
      [],
    );
    var rows = r.rows;
    if (!rows.length) {
      return { ok: true, rows_verified: 0, last_hash: ZERO_HASH };
    }
    var prevHash = ZERO_HASH;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row.prev_hash !== prevHash) {
        return {
          ok:            false,
          rows_verified: i,
          break_at:      i,
          break_row_id:  row.id,
          reason:        "prev_hash mismatch",
          expected:      prevHash,
          actual:        row.prev_hash,
        };
      }
      // Reconstruct the row-fields tuple the same way `record` did,
      // then re-canonicalize + re-hash.
      var hydrated = _hydrate(row);
      var rowFields = _rowFieldsForHash(hydrated);
      var computed  = _computeRowHash(prevHash, rowFields);
      if (computed !== row.row_hash) {
        return {
          ok:            false,
          rows_verified: i,
          break_at:      i,
          break_row_id:  row.id,
          reason:        "row_hash mismatch",
          expected:      computed,
          actual:        row.row_hash,
        };
      }
      prevHash = row.row_hash;
    }
    return { ok: true, rows_verified: rows.length, last_hash: prevHash };
  }

  // -- checkpoint anchoring ----------------------------------------------
  //
  // The hash chain is tamper-EVIDENT against a single edited/deleted row,
  // but an attacker who can rewrite the whole table can re-hash from a
  // forged genesis and leave the chain internally consistent. Anchoring
  // the tip with a post-quantum signature over the head row_hash — keyed
  // off the framework's b.auditSign keypair, whose private half never
  // touches D1 — closes that hole: a full-chain rewrite can't reproduce a
  // valid checkpoint signature over the rewritten tip.
  //
  // checkpoint() signs the CURRENT head and inserts an anchor row.
  // verifyCheckpoints() re-derives every anchor's signature and confirms
  // the anchored row still carries the signed hash. Both no-op gracefully
  // when b.auditSign isn't initialized (the chain stays hash-linked; the
  // signature layer is simply absent) so a deployment without the
  // audit-signing keypair still records + verifies the linkage.

  function _auditSignReady() {
    try { b.auditSign.getPublicKeyFingerprint(); return true; }
    catch (_e) { return false; }
  }

  // Canonical signed bytes for a checkpoint. STABLE FOREVER — changing
  // this layout invalidates every prior checkpoint signature.
  function _checkpointPayload(atRowId, atOccurredAt, atRowHash, createdAt) {
    return Buffer.from(
      CHECKPOINT_FORMAT + "\n" +
      atRowId + "\n" +
      String(atOccurredAt) + "\n" +
      atRowHash + "\n" +
      String(createdAt),
      "utf8",
    );
  }

  // Anchor the current chain tip with a fresh PQC signature. Returns the
  // inserted checkpoint row, or null when the chain is empty (nothing to
  // anchor) or `skipIfUnchanged` and the tip hasn't advanced since the
  // last checkpoint. Throws OperatorAuditCheckpointSigningUnavailable-
  // shaped TypeError only if asked to checkpoint without a signing key —
  // callers that want a soft skip check `signingAvailable()` first.
  async function checkpoint(checkpointOpts) {
    checkpointOpts = checkpointOpts || {};
    if (!_auditSignReady()) {
      throw new TypeError("operatorAuditLog.checkpoint: b.auditSign is not initialized — " +
        "no signing key to anchor the chain with");
    }
    var head = await _currentHead();
    if (head.id === null) return null;  // empty chain — nothing to anchor

    if (checkpointOpts.skipIfUnchanged) {
      var last = await query(
        "SELECT at_row_hash FROM operator_audit_checkpoints " +
        "ORDER BY created_at DESC, id DESC LIMIT 1",
        [],
      );
      if (last.rows.length && last.rows[0].at_row_hash === head.row_hash) {
        return null;  // already anchored at this exact tip
      }
    }

    var createdAt = _now();
    var payload   = _checkpointPayload(head.id, head.occurred_at, head.row_hash, createdAt);
    var signature = b.auditSign.sign(payload).toString("base64");
    var pubFp     = b.auditSign.getPublicKeyFingerprint();
    var id        = b.uuid.v7();

    await query(
      "INSERT INTO operator_audit_checkpoints " +
      "(id, created_at, at_row_id, at_occurred_at, at_row_hash, signature, public_key_fingerprint) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      [id, createdAt, head.id, head.occurred_at, head.row_hash, signature, pubFp],
    );

    return {
      id:                     id,
      created_at:             createdAt,
      at_row_id:              head.id,
      at_occurred_at:         head.occurred_at,
      at_row_hash:            head.row_hash,
      public_key_fingerprint: pubFp,
    };
  }

  // Walk every checkpoint oldest-first, re-derive its signature, and
  // confirm the anchored row still carries the signed hash. Reports the
  // first divergence — a forged signature, a key-rotation fingerprint
  // mismatch, a vanished anchor row, or a rewritten tip whose hash no
  // longer matches what was signed.
  async function verifyCheckpoints() {
    if (!_auditSignReady()) {
      return { ok: true, checkpoints_verified: 0, reason: "audit-sign-unavailable" };
    }
    var r = await query(
      "SELECT * FROM operator_audit_checkpoints ORDER BY created_at ASC, id ASC",
      [],
    );
    var rows = r.rows;
    if (!rows.length) return { ok: true, checkpoints_verified: 0 };

    var currentFp  = b.auditSign.getPublicKeyFingerprint();
    var currentPub = b.auditSign.getPublicKey();

    for (var i = 0; i < rows.length; i += 1) {
      var c = rows[i];
      // Only the current key verifies (no key-history table). A rotation
      // without re-signing surfaces here rather than silently failing.
      if (c.public_key_fingerprint !== currentFp) {
        return {
          ok: false, checkpoints_verified: i, break_at: i, checkpoint_id: c.id,
          reason: "public key fingerprint mismatch (key rotated without re-signing?)",
          expected: currentFp, actual: c.public_key_fingerprint,
        };
      }
      var payload = _checkpointPayload(c.at_row_id, Number(c.at_occurred_at), c.at_row_hash, Number(c.created_at));
      var sigBuf;
      try { sigBuf = Buffer.from(c.signature, "base64"); }
      catch (_e) {
        return { ok: false, checkpoints_verified: i, break_at: i, checkpoint_id: c.id,
          reason: "checkpoint signature not decodable" };
      }
      if (!b.auditSign.verify(payload, sigBuf, currentPub)) {
        return { ok: false, checkpoints_verified: i, break_at: i, checkpoint_id: c.id,
          reason: "post-quantum signature failed" };
      }
      // The anchored row must still exist AND still carry the signed hash.
      // A full-chain rewrite changes row_hash → this mismatch is the catch.
      var anchored = await query(
        "SELECT row_hash FROM operator_audit_events WHERE id = ?1 LIMIT 1",
        [c.at_row_id],
      );
      if (!anchored.rows.length) {
        return { ok: false, checkpoints_verified: i, break_at: i, checkpoint_id: c.id,
          reason: "anchored audit row missing (id=" + c.at_row_id + ")" };
      }
      if (anchored.rows[0].row_hash !== c.at_row_hash) {
        return {
          ok: false, checkpoints_verified: i, break_at: i, checkpoint_id: c.id,
          reason: "anchored row_hash mismatch — operator_audit_events was rewritten",
          expected: c.at_row_hash, actual: anchored.rows[0].row_hash,
        };
      }
    }
    return { ok: true, checkpoints_verified: rows.length };
  }

  return {
    MAX_ACTOR_ID_LEN:      MAX_ACTOR_ID_LEN,
    MAX_ACTION_LEN:        MAX_ACTION_LEN,
    MAX_RESOURCE_KIND_LEN: MAX_RESOURCE_KIND_LEN,
    MAX_RESOURCE_ID_LEN:   MAX_RESOURCE_ID_LEN,
    MAX_JSON_BYTES:        MAX_JSON_BYTES,
    MAX_LIST_LIMIT:        MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:    DEFAULT_LIST_LIMIT,
    ALLOWED_ACTOR_TYPES:   ALLOWED_ACTOR_TYPES,
    ALLOWED_UA_CLASSES:    ALLOWED_UA_CLASSES,
    ZERO_HASH:             ZERO_HASH,

    record:            record,
    listByActor:       listByActor,
    listByResource:    listByResource,
    searchAction:      searchAction,
    chainHead:         chainHead,
    verifyChain:       verifyChain,
    // Checkpoint anchoring — sign the chain tip out-of-band so a
    // full-chain rewrite (which verifyChain alone can't catch) becomes
    // detectable. `signingAvailable()` lets callers soft-skip when the
    // audit-signing key isn't initialized.
    checkpoint:        checkpoint,
    verifyCheckpoints: verifyCheckpoints,
    signingAvailable:  _auditSignReady,
    CHECKPOINT_FORMAT: CHECKPOINT_FORMAT,
  };
}

module.exports = {
  create:                create,
  MAX_ACTOR_ID_LEN:      MAX_ACTOR_ID_LEN,
  MAX_ACTION_LEN:        MAX_ACTION_LEN,
  MAX_RESOURCE_KIND_LEN: MAX_RESOURCE_KIND_LEN,
  MAX_RESOURCE_ID_LEN:   MAX_RESOURCE_ID_LEN,
  MAX_JSON_BYTES:        MAX_JSON_BYTES,
  MAX_LIST_LIMIT:        MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:    DEFAULT_LIST_LIMIT,
  ALLOWED_ACTOR_TYPES:   ALLOWED_ACTOR_TYPES,
  ALLOWED_UA_CLASSES:    ALLOWED_UA_CLASSES,
  ZERO_HASH:             ZERO_HASH,
  CHECKPOINT_FORMAT:     CHECKPOINT_FORMAT,
};
