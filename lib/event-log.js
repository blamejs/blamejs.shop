"use strict";
/**
 * @module shop.eventLog
 * @title  Event log — universal append-only application event stream
 *
 * @intro
 *   Cross-cutting record of "something happened" across the
 *   application — domain event published, background job dispatched,
 *   cache invalidated, webhook received, feature flag flipped, secret
 *   rotated. Distinct from:
 *
 *     analytics            — customer behavioural events.
 *     operatorAuditLog     — cryptographically chained operator
 *                            mutations.
 *     errorLog             — HTTP 4xx/5xx response events.
 *
 *   `eventLog` is the catch-all stream that doesn't fit those three
 *   shapes: anything an operator might want to grep across after the
 *   fact when reconstructing what the system did. Every row is keyed
 *   on a compact set of dimensions (`kind`, `subject_kind`+
 *   `subject_id`, `actor_kind`+`actor_id`, `severity`, `source`,
 *   `occurred_at`) so the read paths stay deterministic; the optional
 *   `payload` blob carries forensic detail that's never indexed.
 *
 *   **Drop-silent on bad input — by design.** `recordEvent` is wired
 *   directly into every callsite that emits an event; throwing inside
 *   it would crash whichever request / job / hook triggered the
 *   write. The write side resolves every malformed input to a silent
 *   drop and returns `{ dropped: true, reason }`. Read-side methods
 *   (`query`, `tail`, `metricsForKind`, `topKinds`, `purgeOlderThan`)
 *   THROW — those are dashboard / operator-tool entry points with a
 *   human on the other end of the stack trace.
 *
 *   Surface:
 *
 *     recordEvent({
 *       kind, subject_kind, subject_id,
 *       actor_kind?, actor_id?,
 *       payload?, severity?, source?,
 *     })
 *       → { id, occurred_at } on success
 *       → { dropped: true, reason } on bad input (no throw)
 *
 *     query({
 *       kind?, subject?, actor?, severity_min?,
 *       from?, to?, cursor?, limit?,
 *     })
 *       → { rows, next_cursor }
 *       HMAC-tagged opaque cursor over (occurred_at, id) — newest
 *       first. `subject` is `{ kind, id }`; `actor` is `{ kind?, id }`
 *       (id alone is sufficient because actor_id is independently
 *       indexed). `severity_min` is one of debug/info/warning/critical
 *       and includes every rung at or above it.
 *
 *     tail({ poll_ms?, max_events? })
 *       → { rows, observed_at }
 *       Snapshot read of the most recent rows for the operator
 *       tail-style monitoring console. Not a streaming subscription —
 *       the caller polls on its own schedule (`poll_ms` is a hint the
 *       UI consumes, not a side effect the primitive enforces).
 *
 *     metricsForKind({ kind, from, to })
 *       → { kind, total, by_severity, by_source, first_at, last_at }
 *       Roll-up for a single kind across a window. `by_severity` and
 *       `by_source` are flat `{ <bucket>: count }` maps.
 *
 *     topKinds({ from, to, limit })
 *       → [{ kind, count }]
 *       Most-frequent kinds across the window, count DESC then kind
 *       ASC for deterministic ordering.
 *
 *     purgeOlderThan({ days, exclude_critical? })
 *       → { deleted }
 *       Retention sweep. Drops every row whose `occurred_at` is older
 *       than `now - days * 86400000`. `exclude_critical: true`
 *       preserves critical rows past the retention window so they
 *       remain available for after-the-fact incident review.
 *
 *   Composition:
 *     - `b.uuid.v7`          — every row id, sortable by insertion
 *                              order.
 *     - `b.pagination.encodeCursor` / `.decodeCursor` — opaque HMAC-
 *                              tagged keyset cursor over
 *                              (occurred_at, id).
 *
 * @primitive eventLog
 * @related   shop.analytics, shop.operatorAuditLog, shop.errorLog
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}
var C = _b().constants;

// ---- constants ---------------------------------------------------------

var SEVERITIES = ["debug", "info", "warning", "critical"];

// String length bounds. The dimensions are operator-grepped; oversize
// inputs are nearly always producer bugs that, if persisted, would
// either truncate-to-garbage or break the index scan path. The drop-
// silent gate refuses rather than mangles.
var MAX_KIND_LEN          = 128;
var MAX_SUBJECT_KIND_LEN  = 64;
var MAX_SUBJECT_ID_LEN    = 128;
var MAX_ACTOR_KIND_LEN    = 64;
var MAX_ACTOR_ID_LEN      = 128;
var MAX_SOURCE_LEN        = 128;
var MAX_PAYLOAD_BYTES     = 64 * 1024;

var MAX_LIST_LIMIT    = 500;
var DEFAULT_LIST_LIMIT = 100;
var MAX_TAIL_EVENTS    = 500;
var DEFAULT_TAIL_EVENTS = 50;
var MIN_POLL_MS        = 250;
var DEFAULT_POLL_MS    = 2000;
var MAX_POLL_MS        = C.TIME.minutes(1);
var MAX_PURGE_DAYS     = 3650;

// Identifier shapes — kind / subject_kind / actor_kind / source share
// the snake-case-plus-dot vocabulary every other primitive in the
// framework already uses. Concrete ids (subject_id, actor_id) carry
// a wider character class because the upstream producer might hand
// in a UUID, a slug, a hex digest, or a CDN-cache key.
var KIND_RE     = /^[a-z][a-z0-9._-]{0,127}$/;
var ID_RE       = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$/;
var SOURCE_RE   = /^[a-z0-9][a-z0-9._\-/]{0,127}$/;

// Cursor order key matches the (occurred_at DESC, id DESC) keyset
// the query scan reads. Encoded into every cursor so a cursor minted
// by `query` can't be replayed against a method with a different
// order key (HMAC verification rejects the orderKey mismatch).
var CURSOR_ORDER_KEY = ["occurred_at", "id"];

// ---- monotonic clock ---------------------------------------------------
//
// Wall-clock can stall on a hot loop (multiple recordEvent calls in
// the same millisecond) and on coarse-grained virtualised hosts. The
// monotonic shim keeps every per-factory `occurred_at` strictly
// increasing — every subsequent call observes a timestamp at least
// 1ms greater than the previous one. Sibling primitives use the same
// shape; the (occurred_at, id) keyset cursor + the topKinds / tail
// scans rely on strict monotonicity to break ties deterministically.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- write-side drop-silent helpers ------------------------------------

function _isInt(n)         { return typeof n === "number" && Number.isInteger(n); }
function _isNonNegative(n) { return _isInt(n) && n >= 0; }
function _isPositive(n)    { return _isInt(n) && n > 0; }

function _isBoundedKind(v, max, re) {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > max) return false;
  return re.test(v);
}

function _isOptionalBoundedKind(v, max, re) {
  if (v == null) return true;
  return _isBoundedKind(v, max, re);
}

function _isSeverity(v) {
  return typeof v === "string" && SEVERITIES.indexOf(v) !== -1;
}

// ---- read-side validators (THROW — operator-facing) --------------------

function _epochMsOpt(n, label) {
  if (n == null) return null;
  if (!_isNonNegative(n)) {
    throw new TypeError("eventLog: " + label + " must be a non-negative integer (epoch-ms) when provided");
  }
  return n;
}

function _limit(n, label, max, def) {
  if (n == null) return def;
  if (!_isInt(n) || n < 1 || n > max) {
    throw new TypeError("eventLog: " + label + " must be an integer in [1, " + max + "]");
  }
  return n;
}

function _severityMin(s) {
  if (s == null) return null;
  if (!_isSeverity(s)) {
    throw new TypeError("eventLog: severity_min must be one of " + SEVERITIES.join(", "));
  }
  return s;
}

function _readKind(v, label) {
  if (typeof v !== "string" || !v.length || v.length > MAX_KIND_LEN || !KIND_RE.test(v)) {
    throw new TypeError("eventLog: " + label + " must match /[a-z][a-z0-9._-]*/ (≤ " + MAX_KIND_LEN + " chars)");
  }
  return v;
}

function _readSubject(v) {
  if (v == null) return null;
  if (typeof v !== "object") {
    throw new TypeError("eventLog: subject must be an object { kind, id } when provided");
  }
  if (typeof v.kind !== "string" || !v.kind.length || v.kind.length > MAX_SUBJECT_KIND_LEN || !KIND_RE.test(v.kind)) {
    throw new TypeError("eventLog: subject.kind must match /[a-z][a-z0-9._-]*/ (≤ " + MAX_SUBJECT_KIND_LEN + " chars)");
  }
  if (typeof v.id !== "string" || !v.id.length || v.id.length > MAX_SUBJECT_ID_LEN || !ID_RE.test(v.id)) {
    throw new TypeError("eventLog: subject.id must match /[A-Za-z0-9][A-Za-z0-9._:-]*/ (≤ " + MAX_SUBJECT_ID_LEN + " chars)");
  }
  return { kind: v.kind, id: v.id };
}

function _readActor(v) {
  if (v == null) return null;
  if (typeof v !== "object") {
    throw new TypeError("eventLog: actor must be an object { kind?, id } when provided");
  }
  if (typeof v.id !== "string" || !v.id.length || v.id.length > MAX_ACTOR_ID_LEN || !ID_RE.test(v.id)) {
    throw new TypeError("eventLog: actor.id must match /[A-Za-z0-9][A-Za-z0-9._:-]*/ (≤ " + MAX_ACTOR_ID_LEN + " chars)");
  }
  var out = { id: v.id };
  if (v.kind != null) {
    if (typeof v.kind !== "string" || !v.kind.length || v.kind.length > MAX_ACTOR_KIND_LEN || !KIND_RE.test(v.kind)) {
      throw new TypeError("eventLog: actor.kind must match /[a-z][a-z0-9._-]*/ (≤ " + MAX_ACTOR_KIND_LEN + " chars)");
    }
    out.kind = v.kind;
  }
  return out;
}

// `severity_min` filter expands to the set of rungs at or above the
// given severity, in the SEVERITIES ordering. critical >= warning >=
// info >= debug.
function _severitiesAtOrAbove(min) {
  if (min == null) return null;
  var idx = SEVERITIES.indexOf(min);
  return SEVERITIES.slice(idx);
}

// ---- row hydration ------------------------------------------------------

function _hydrate(r) {
  if (!r) return null;
  var payload = null;
  if (r.payload_json != null) {
    try { payload = JSON.parse(r.payload_json); }
    catch (_e) { payload = null; }                                       // drop-silent — corrupted blob still surfaces the row, just without payload
  }
  return {
    id:            r.id,
    kind:          r.kind,
    subject_kind:  r.subject_kind,
    subject_id:    r.subject_id,
    actor_kind:    r.actor_kind == null ? null : r.actor_kind,
    actor_id:      r.actor_id   == null ? null : r.actor_id,
    payload:       payload,
    severity:      r.severity,
    source:        r.source == null ? null : r.source,
    occurred_at:   Number(r.occurred_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // HMAC-tagged cursor secret. Production wiring MUST pass an
  // operator-managed secret derived from the deployment's bridge
  // secret (e.g. `b.crypto.namespaceHash("event-log-cursor", ...)`).
  // Dev fallback is a stable placeholder so the suite can run against
  // an in-memory factory without pre-arranged secrets.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("eventLog.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "event-log-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("eventLog." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = _b().pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(CURSOR_ORDER_KEY)) {
        throw new TypeError("eventLog." + label + ": cursor orderKey mismatch");
      }
      if (!Array.isArray(state.vals) || state.vals.length !== 2) {
        throw new TypeError("eventLog." + label + ": cursor vals shape mismatch");
      }
      var occurredAt = state.vals[0];
      var rowId      = state.vals[1];
      if (!Number.isInteger(occurredAt) || occurredAt < 0) {
        throw new TypeError("eventLog." + label + ": cursor occurred_at must be a non-negative integer");
      }
      if (typeof rowId !== "string" || !rowId.length) {
        throw new TypeError("eventLog." + label + ": cursor id must be a non-empty string");
      }
      return { occurred_at: occurredAt, id: rowId };
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("eventLog." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit) {
    if (rows.length < limit) return null;
    var last = rows[rows.length - 1];
    return _b().pagination.encodeCursor({
      orderKey: CURSOR_ORDER_KEY,
      vals:     [last.occurred_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  // -- recordEvent --------------------------------------------------------
  //
  // Drop-silent on bad input. Returns `{ id, occurred_at }` on success
  // and `{ dropped: true, reason }` on every refusal so a caller that
  // wants to log the drop (smoke tests, debug builds) can see why.
  // Production callers ignore the return value entirely; the drop is
  // silent from the operator dashboard's perspective.

  async function recordEvent(input) {
    try {
      if (!input || typeof input !== "object") {
        return { dropped: true, reason: "input must be an object" };
      }

      var kind = input.kind;
      if (!_isBoundedKind(kind, MAX_KIND_LEN, KIND_RE)) {
        return { dropped: true, reason: "kind must match /[a-z][a-z0-9._-]*/ (≤ " + MAX_KIND_LEN + " chars)" };
      }

      var subjectKind = input.subject_kind;
      if (!_isBoundedKind(subjectKind, MAX_SUBJECT_KIND_LEN, KIND_RE)) {
        return { dropped: true, reason: "subject_kind must match /[a-z][a-z0-9._-]*/ (≤ " + MAX_SUBJECT_KIND_LEN + " chars)" };
      }

      var subjectId = input.subject_id;
      if (!_isBoundedKind(subjectId, MAX_SUBJECT_ID_LEN, ID_RE)) {
        return { dropped: true, reason: "subject_id must match /[A-Za-z0-9][A-Za-z0-9._:-]*/ (≤ " + MAX_SUBJECT_ID_LEN + " chars)" };
      }

      var actorKindRaw = input.actor_kind == null ? null : input.actor_kind;
      if (!_isOptionalBoundedKind(actorKindRaw, MAX_ACTOR_KIND_LEN, KIND_RE)) {
        return { dropped: true, reason: "actor_kind must match /[a-z][a-z0-9._-]*/ (≤ " + MAX_ACTOR_KIND_LEN + " chars) when provided" };
      }
      var actorIdRaw = input.actor_id == null ? null : input.actor_id;
      if (!_isOptionalBoundedKind(actorIdRaw, MAX_ACTOR_ID_LEN, ID_RE)) {
        return { dropped: true, reason: "actor_id must match /[A-Za-z0-9][A-Za-z0-9._:-]*/ (≤ " + MAX_ACTOR_ID_LEN + " chars) when provided" };
      }
      // actor_kind without actor_id is a producer bug — the kind
      // describes the id, and dangling-kind rows confuse the actor-
      // indexed scans.
      if (actorKindRaw != null && actorIdRaw == null) {
        return { dropped: true, reason: "actor_kind provided without actor_id" };
      }

      var severity = input.severity == null ? "info" : input.severity;
      if (!_isSeverity(severity)) {
        return { dropped: true, reason: "severity must be one of " + SEVERITIES.join(", ") };
      }

      var sourceRaw = input.source == null ? null : input.source;
      if (!_isOptionalBoundedKind(sourceRaw, MAX_SOURCE_LEN, SOURCE_RE)) {
        return { dropped: true, reason: "source must match /[a-z0-9][a-z0-9._\\-/]*/ (≤ " + MAX_SOURCE_LEN + " chars) when provided" };
      }

      // Payload is optional + opaque. JSON.stringify refuses BigInt /
      // circular references / functions; bound the size so a runaway
      // producer can't fill the row store with a single megabyte blob.
      var payloadJson = null;
      if (input.payload != null) {
        try { payloadJson = JSON.stringify(input.payload); }
        catch (_e) {
          return { dropped: true, reason: "payload is not JSON-serialisable" };
        }
        if (payloadJson == null) {
          return { dropped: true, reason: "payload is not JSON-serialisable" };
        }
        if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
          return { dropped: true, reason: "payload JSON exceeds " + MAX_PAYLOAD_BYTES + " bytes" };
        }
      }

      var occurredAt = _now();
      var id         = _b().uuid.v7();

      await query(
        "INSERT INTO event_log " +
        "(id, kind, subject_kind, subject_id, actor_kind, actor_id, " +
        " payload_json, severity, source, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [
          id, kind, subjectKind, subjectId,
          actorKindRaw, actorIdRaw,
          payloadJson, severity, sourceRaw,
          occurredAt,
        ],
      );
      return { id: id, occurred_at: occurredAt };
    } catch (_e) {
      // Drop-silent on any unexpected failure — a database hiccup at
      // event-record time must not crash whichever request / job
      // triggered the write. The aggregate dashboards already render
      // "no data" gracefully so an observed gap is the operator's
      // signal to check the DB.
      return { dropped: true, reason: "internal" };
    }
  }

  // -- query --------------------------------------------------------------
  //
  // HMAC-paginated event stream. `kind`, `subject`, `actor`,
  // `severity_min`, `from`, `to` narrow the scan; `cursor` + `limit`
  // paginate it. Cursor is an opaque base64url string the caller
  // round-trips verbatim.

  async function queryFn(input) {
    if (input == null) input = {};
    if (typeof input !== "object") {
      throw new TypeError("eventLog.query: input must be an object");
    }
    var kind         = input.kind == null ? null : _readKind(input.kind, "kind");
    var subject      = _readSubject(input.subject);
    var actor        = _readActor(input.actor);
    var severityMin  = _severityMin(input.severity_min);
    var fromTs       = _epochMsOpt(input.from, "from");
    var toTs         = _epochMsOpt(input.to,   "to");
    if (fromTs != null && toTs != null && fromTs > toTs) {
      throw new TypeError("eventLog.query: from must be <= to");
    }
    var limit  = _limit(input.limit, "limit", MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
    var cursor = _decodeCursor(input.cursor, "query");

    var clauses = [];
    var params  = [];
    var idx     = 1;
    if (kind != null) { clauses.push("kind = ?" + idx); params.push(kind); idx += 1; }
    if (subject != null) {
      clauses.push("subject_kind = ?" + idx); params.push(subject.kind); idx += 1;
      clauses.push("subject_id   = ?" + idx); params.push(subject.id);   idx += 1;
    }
    if (actor != null) {
      clauses.push("actor_id = ?" + idx); params.push(actor.id); idx += 1;
      if (actor.kind != null) {
        clauses.push("actor_kind = ?" + idx); params.push(actor.kind); idx += 1;
      }
    }
    if (severityMin != null) {
      var rungs = _severitiesAtOrAbove(severityMin);
      var placeholders = [];
      for (var s = 0; s < rungs.length; s += 1) {
        placeholders.push("?" + idx);
        params.push(rungs[s]);
        idx += 1;
      }
      clauses.push("severity IN (" + placeholders.join(", ") + ")");
    }
    if (fromTs != null) { clauses.push("occurred_at >= ?" + idx); params.push(fromTs); idx += 1; }
    if (toTs   != null) { clauses.push("occurred_at <= ?" + idx); params.push(toTs);   idx += 1; }
    if (cursor != null) {
      clauses.push("(occurred_at < ?" + idx + " OR (occurred_at = ?" + idx + " AND id < ?" + (idx + 1) + "))");
      params.push(cursor.occurred_at);
      params.push(cursor.id);
      idx += 2;
    }

    var sql = "SELECT id, kind, subject_kind, subject_id, actor_kind, actor_id, " +
              "payload_json, severity, source, occurred_at FROM event_log";
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY occurred_at DESC, id DESC LIMIT ?" + idx;
    params.push(limit + 1);

    var rs = await query(sql, params);
    var raw = rs.rows;
    var page = raw.slice(0, limit);
    var rows = [];
    for (var i = 0; i < page.length; i += 1) rows.push(_hydrate(page[i]));
    var nextCursor = null;
    if (raw.length > limit) {
      var last = rows[rows.length - 1];
      nextCursor = _b().pagination.encodeCursor({
        orderKey: CURSOR_ORDER_KEY,
        vals:     [last.occurred_at, last.id],
        forward:  true,
      }, cursorSecret);
    }
    return { rows: rows, next_cursor: nextCursor };
  }

  // -- tail ---------------------------------------------------------------
  //
  // Snapshot read of the most recent rows. Operator's monitoring
  // console polls this on its own schedule. The `poll_ms` hint is
  // echoed back as `observed_poll_ms` so the UI knows what cadence
  // the primitive validated.

  async function tail(input) {
    if (input == null || typeof input !== "object") {
      throw new TypeError("eventLog.tail: input must be an object");
    }
    var pollMs;
    if (input.poll_ms == null) {
      pollMs = DEFAULT_POLL_MS;
    } else if (_isInt(input.poll_ms) && input.poll_ms >= MIN_POLL_MS && input.poll_ms <= MAX_POLL_MS) {
      pollMs = input.poll_ms;
    } else {
      throw new TypeError("eventLog.tail: poll_ms must be an integer in [" + MIN_POLL_MS + ", " + MAX_POLL_MS + "]");
    }
    var maxEvents = _limit(input.max_events, "max_events", MAX_TAIL_EVENTS, DEFAULT_TAIL_EVENTS);

    var observedAt = _now();
    var rs = await query(
      "SELECT id, kind, subject_kind, subject_id, actor_kind, actor_id, " +
      "payload_json, severity, source, occurred_at FROM event_log " +
      "ORDER BY occurred_at DESC, id DESC LIMIT ?1",
      [maxEvents],
    );
    var rows = [];
    for (var i = 0; i < rs.rows.length; i += 1) rows.push(_hydrate(rs.rows[i]));
    return {
      rows:             rows,
      observed_at:      observedAt,
      observed_poll_ms: pollMs,
    };
  }

  // -- metricsForKind -----------------------------------------------------
  //
  // Roll-up for a single kind across [from, to]. by_severity and
  // by_source are flat `{ <bucket>: count }` maps so the operator
  // dashboard renders both panels off one query.

  async function metricsForKind(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("eventLog.metricsForKind: input must be an object");
    }
    var kind = _readKind(input.kind, "kind");
    var fromTs = _epochMsOpt(input.from, "from");
    var toTs   = _epochMsOpt(input.to,   "to");
    if (fromTs == null) {
      throw new TypeError("eventLog.metricsForKind: from is required");
    }
    if (toTs == null) {
      throw new TypeError("eventLog.metricsForKind: to is required");
    }
    if (fromTs > toTs) {
      throw new TypeError("eventLog.metricsForKind: from must be <= to");
    }

    var rs = await query(
      "SELECT severity, source, occurred_at FROM event_log " +
      "WHERE kind = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3",
      [kind, fromTs, toTs],
    );

    var bySeverity = { debug: 0, info: 0, warning: 0, critical: 0 };
    var bySource   = {};
    var total      = 0;
    var firstAt    = null;
    var lastAt     = null;
    for (var i = 0; i < rs.rows.length; i += 1) {
      var r = rs.rows[i];
      total += 1;
      if (bySeverity[r.severity] != null) bySeverity[r.severity] += 1;
      var src = r.source == null ? "(none)" : r.source;
      bySource[src] = (bySource[src] || 0) + 1;
      var ts = Number(r.occurred_at);
      if (firstAt == null || ts < firstAt) firstAt = ts;
      if (lastAt  == null || ts > lastAt)  lastAt  = ts;
    }
    return {
      kind:        kind,
      from:        fromTs,
      to:          toTs,
      total:       total,
      by_severity: bySeverity,
      by_source:   bySource,
      first_at:    firstAt,
      last_at:     lastAt,
    };
  }

  // -- topKinds -----------------------------------------------------------

  async function topKinds(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("eventLog.topKinds: input must be an object");
    }
    var fromTs = _epochMsOpt(input.from, "from");
    var toTs   = _epochMsOpt(input.to,   "to");
    if (fromTs == null) {
      throw new TypeError("eventLog.topKinds: from is required");
    }
    if (toTs == null) {
      throw new TypeError("eventLog.topKinds: to is required");
    }
    if (fromTs > toTs) {
      throw new TypeError("eventLog.topKinds: from must be <= to");
    }
    var limit = _limit(input.limit, "limit", MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);

    var rs = await query(
      "SELECT kind, COUNT(*) AS c FROM event_log " +
      "WHERE occurred_at >= ?1 AND occurred_at <= ?2 " +
      "GROUP BY kind ORDER BY c DESC, kind ASC LIMIT ?3",
      [fromTs, toTs, limit],
    );
    var out = [];
    for (var i = 0; i < rs.rows.length; i += 1) {
      out.push({
        kind:  rs.rows[i].kind,
        count: Number(rs.rows[i].c) || 0,
      });
    }
    return out;
  }

  // -- purgeOlderThan -----------------------------------------------------
  //
  // Retention sweep. Drops every row whose `occurred_at` is older
  // than `now - days * 86400000`. `exclude_critical: true` preserves
  // critical-rung rows past the retention window so the next incident
  // review still has the high-signal events to grep over.

  async function purgeOlderThan(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("eventLog.purgeOlderThan: input must be an object");
    }
    var days = input.days;
    if (!_isPositive(days) || days > MAX_PURGE_DAYS) {
      throw new TypeError("eventLog.purgeOlderThan: days must be an integer in [1, " + MAX_PURGE_DAYS + "]");
    }
    var excludeCritical = !!input.exclude_critical;
    var cutoff = _now() - C.TIME.days(days);

    var sql, params;
    if (excludeCritical) {
      sql = "DELETE FROM event_log WHERE occurred_at < ?1 AND severity != 'critical'";
      params = [cutoff];
    } else {
      sql = "DELETE FROM event_log WHERE occurred_at < ?1";
      params = [cutoff];
    }
    var rs = await query(sql, params);
    return { deleted: Number(rs.rowCount) || 0 };
  }

  return {
    SEVERITIES:           SEVERITIES.slice(),
    MAX_KIND_LEN:         MAX_KIND_LEN,
    MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:   DEFAULT_LIST_LIMIT,
    MAX_TAIL_EVENTS:      MAX_TAIL_EVENTS,
    DEFAULT_TAIL_EVENTS:  DEFAULT_TAIL_EVENTS,
    MIN_POLL_MS:          MIN_POLL_MS,
    DEFAULT_POLL_MS:      DEFAULT_POLL_MS,
    MAX_POLL_MS:          MAX_POLL_MS,
    MAX_PURGE_DAYS:       MAX_PURGE_DAYS,

    recordEvent:    recordEvent,
    query:          queryFn,
    tail:           tail,
    metricsForKind: metricsForKind,
    topKinds:       topKinds,
    purgeOlderThan: purgeOlderThan,
  };
}

// Async run() entry point — invoked by harnesses that load the
// primitive as a unit. Builds a default factory against `b.externalDb`
// so callers don't need to know about the peer injection surface to
// verify the module loads cleanly.
async function run() {
  var instance = create({});
  return {
    ok:      true,
    surface: Object.keys(instance),
  };
}

module.exports = {
  create:              create,
  run:                 run,
  SEVERITIES:          SEVERITIES.slice(),
  MAX_KIND_LEN:        MAX_KIND_LEN,
  MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:  DEFAULT_LIST_LIMIT,
  MAX_TAIL_EVENTS:     MAX_TAIL_EVENTS,
  DEFAULT_TAIL_EVENTS: DEFAULT_TAIL_EVENTS,
  MIN_POLL_MS:         MIN_POLL_MS,
  DEFAULT_POLL_MS:     DEFAULT_POLL_MS,
  MAX_POLL_MS:         MAX_POLL_MS,
  MAX_PURGE_DAYS:      MAX_PURGE_DAYS,
};
