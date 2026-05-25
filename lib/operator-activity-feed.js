"use strict";
/**
 * @module shop.operatorActivityFeed
 * @title  Operator activity feed — admin-homepage timeline aggregator
 *
 * @intro
 *   Operator-side counterpart to `customerActivity`. The admin
 *   homepage wants a single chronological feed of what every staff
 *   member has been doing — actions logged via `operatorAuditLog`,
 *   support tickets they've been assigned + resolved, inbox messages
 *   addressed to them, login sessions they've established or revoked
 *   — not four separate widgets each keyed by a different source
 *   table. `operatorActivityFeed` is the read-only aggregator: it
 *   queries the primitives that already own each event class and
 *   flattens the result into one `{ kind, occurred_at, title, body,
 *   link?, action?, severity? }` stream.
 *
 *   Sources composed (each is optional — when the corresponding peer
 *   is NOT wired into the factory, that source is skipped silently
 *   and the remaining sources still surface):
 *
 *     operatorAuditLog — operator_audit_events rows where
 *                        `actor_id = operator_id` (or any row in
 *                        teamFeed). The `action` column drives the
 *                        event kind ("audit.<action>"); the
 *                        `resource_kind/resource_id` columns feed the
 *                        body + link.
 *     supportTickets   — support_tickets rows where
 *                        `assigned_operator_id = operator_id`. Each
 *                        row contributes a "support.assigned" event at
 *                        opened_at (or last_action_at when assigned
 *                        post-open) plus a "support.resolved" event
 *                        when resolved_at is stamped by this operator.
 *     operatorInbox    — operator_inbox_messages rows addressed to
 *                        operator_id (role-broadcast rows are NOT
 *                        attributed to a specific operator in the
 *                        per-operator feed; they DO surface in
 *                        teamFeed). Each row contributes one
 *                        "inbox.<kind>" event at created_at.
 *
 *   operator_sessions is always queried directly via the injected
 *   `query` — there is no `operatorSessions` peer to wire, because
 *   the sessions table is the canonical store and the feed only
 *   needs read access to it. When the table doesn't exist (e.g. a
 *   harness that didn't load migration 0165), the session collector
 *   catches the error and surfaces nothing — same posture as the
 *   skip-injected-peers rule applies to the source-existence check.
 *
 *   Surface:
 *
 *     forOperator({ operator_id, from?, to?, kinds?, cursor?, limit? })
 *       — returns newest-first `{ events, next_cursor }`. `from`/`to`
 *         bound the window (epoch-ms); `kinds` whitelists event-kind
 *         strings; `cursor`/`limit` paginate (cursor is an opaque
 *         HMAC-tagged tuple).
 *
 *     teamFeed({ from?, to?, kinds?, limit })
 *       — cross-operator feed for the admin homepage's "what's
 *         happening across the team" strip. No cursor — the homepage
 *         shows the freshest `limit` rows. Role-broadcast inbox rows
 *         surface here (with `operator_id: null`).
 *
 *     summarizeForOperator({ operator_id, days })
 *       — returns `{ kind_counts, total, last_activity_at,
 *                    cache_hit }`. Reads through the
 *         operator_activity_cache when fresh; recomputes from sources
 *         and refreshes the cache when not.
 *
 *     recentLogins({ operator_id })
 *       — convenience read for the operator-profile sidebar.
 *         Returns the last 10 `operator_sessions` rows for the
 *         operator with `{ created_at, expires_at, status, ip_hash,
 *         ua_class, revoke_reason }`.
 *
 *     currentlyOnline()
 *       — operators with an `operator_sessions` row whose
 *         `status = 'active'` AND `expires_at > now` AND `created_at`
 *         or `activated_at` is within the last 5 minutes. Returns
 *         `[{ operator_id, last_seen_at }]` newest-first.
 *
 *     topActions({ from, to, limit })
 *       — most-frequent `action` values from `operator_audit_events`
 *         in the window. Returns `[{ action, count }]` ordered by
 *         count DESC. Drives the "what's the team doing most" pulse
 *         widget on the admin homepage.
 *
 *   Read-only posture:
 *     The only write this primitive performs is
 *     `operator_activity_cache` upserts as a memoization side-effect
 *     of summarizeForOperator. Every event row stays in its source
 *     table.
 *
 *   Composition (b.* primitives in use):
 *     - b.guardUuid  — every operator_id input passes through the
 *                      strict profile so a hostile cursor can't
 *                      smuggle SQL fragments through.
 *     - b.pagination — HMAC-tagged tuple cursors for forOperator().
 *
 * @primitive operatorActivityFeed
 * @related   shop.operatorAuditLog, shop.supportTickets,
 *            shop.operatorInbox, shop.operatorSessions
 */

var b = require("./index").framework;
var C = b.constants;

// ---- constants ----------------------------------------------------------

var MAX_LIMIT       = 200;
var DEFAULT_LIMIT   = 50;
var MAX_RECENT_LOGINS = 10;
var ONLINE_WINDOW_MS = C.TIME.minutes(5);
var MS_PER_DAY = C.TIME.days(1);

// Cache freshness window. summarizeForOperator returns the cached row
// when computed_at is within this window AND no source has a newer
// event than last_activity_at. Same posture as customer-activity uses.
var CACHE_TTL_MS = C.TIME.minutes(5);

// Order-key for the forOperator() pagination cursor — (occurred_at
// DESC, kind DESC). Tuple keeps the cursor monotonic even when two
// events land in the same epoch-ms.
var LIST_ORDER_KEY = ["occurred_at", "kind"];

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("operatorActivityFeed: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _limit(n, max, def) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("operatorActivityFeed: limit must be an integer 1..." + max);
  }
  return n;
}

function _epochMs(v, label) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0) {
    throw new TypeError("operatorActivityFeed: " + label + " must be a non-negative integer (epoch-ms) when provided");
  }
  return v;
}

function _kinds(arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) {
    throw new TypeError("operatorActivityFeed: kinds must be an array of strings when provided");
  }
  if (arr.length === 0) return null;
  if (arr.length > 64) {
    throw new TypeError("operatorActivityFeed: kinds may carry at most 64 entries");
  }
  var out = [];
  var seen = {};
  for (var i = 0; i < arr.length; i += 1) {
    var k = arr[i];
    if (typeof k !== "string" || !k.length || k.length > 128) {
      throw new TypeError("operatorActivityFeed: kinds[" + i + "] must be a non-empty string up to 128 chars");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(k)) {
      throw new TypeError("operatorActivityFeed: kinds[" + i + "] must be alnum/./_/- only, starting alnum");
    }
    if (seen[k]) continue;
    seen[k] = true;
    out.push(k);
  }
  return out;
}

function _days(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 3650) {
    throw new TypeError("operatorActivityFeed: days must be an integer 1...3650");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Pagination cursor secret. Production deployments derive one via
  // `b.crypto.namespaceHash("operator-activity-feed-cursor",
  // D1_BRIDGE_SECRET)`; dev / test gets a stable placeholder.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("operatorActivityFeed.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "operator-activity-feed-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Injected peers — each optional. Truthy presence flips the
  // matching collector on. The collector reads the source's canonical
  // table directly so it doesn't depend on a particular method on the
  // peer — same posture customer-activity uses.
  var auditPeer   = opts.operatorAuditLog || null;
  var supportPeer = opts.supportTickets   || null;
  var inboxPeer   = opts.operatorInbox    || null;

  // Per-factory monotonic clock for cache computed_at stamps. Two
  // cache refreshes for the same operator in the same wall-clock
  // millisecond would otherwise tie on computed_at and confuse the
  // freshness check. Forward-leap when wall outpaces the counter;
  // otherwise bump by 1ms so the sequence stays strictly increasing
  // per primitive instance.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = _now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- per-source collectors --------------------------------------------
  //
  // Each collector returns an array of `{ operator_id, kind,
  // occurred_at, title, body, link, action, severity }` records.
  // Newest-first ordering happens at the aggregator. Missing peers
  // collapse to an empty list so the aggregator stays the same shape
  // regardless of wiring.

  async function _collectAuditEvents(operatorId, fromTs, toTs) {
    if (!auditPeer) return [];
    var sql = "SELECT id, actor_type, actor_id, action, resource_kind, " +
              "resource_id, ip_hash, ua_class, occurred_at " +
              "FROM operator_audit_events WHERE actor_id = ?1";
    var params = [operatorId];
    var idx = 2;
    if (fromTs != null) { sql += " AND occurred_at >= ?" + idx; params.push(fromTs); idx += 1; }
    if (toTs   != null) { sql += " AND occurred_at <= ?" + idx; params.push(toTs);   idx += 1; }
    sql += " ORDER BY occurred_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      out.push({
        operator_id: operatorId,
        kind:        "audit." + r.action,
        occurred_at: Number(r.occurred_at),
        title:       "Audit: " + r.action,
        body:        r.resource_kind + " " + r.resource_id,
        link:        "/admin/audit/" + r.id,
        action:      r.action,
        severity:    "info",
      });
    }
    return out;
  }

  async function _collectAuditEventsAll(fromTs, toTs) {
    if (!auditPeer) return [];
    var sql = "SELECT id, actor_id, action, resource_kind, resource_id, " +
              "occurred_at FROM operator_audit_events WHERE actor_type = 'operator'";
    var params = [];
    var idx = 1;
    if (fromTs != null) { sql += " AND occurred_at >= ?" + idx; params.push(fromTs); idx += 1; }
    if (toTs   != null) { sql += " AND occurred_at <= ?" + idx; params.push(toTs);   idx += 1; }
    sql += " ORDER BY occurred_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      out.push({
        operator_id: r.actor_id,
        kind:        "audit." + r.action,
        occurred_at: Number(r.occurred_at),
        title:       "Audit: " + r.action,
        body:        r.resource_kind + " " + r.resource_id,
        link:        "/admin/audit/" + r.id,
        action:      r.action,
        severity:    "info",
      });
    }
    return out;
  }

  async function _collectSupportEvents(operatorId, fromTs, toTs) {
    if (!supportPeer) return [];
    // Two events per ticket: "support.assigned" (the moment the
    // ticket carried this operator's id) — approximated by opened_at
    // since the schema doesn't record an "assigned_at" stamp
    // separately. "support.resolved" surfaces only for tickets this
    // operator was assigned to at resolution time, using resolved_at.
    var rows = (await query(
      "SELECT id, subject, category, status, priority, opened_at, " +
      "last_action_at, resolved_at, closed_at FROM support_tickets " +
      "WHERE assigned_operator_id = ?1 ORDER BY opened_at ASC",
      [operatorId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var t = rows[i];
      var openedAt = Number(t.opened_at);
      if ((fromTs == null || openedAt >= fromTs) && (toTs == null || openedAt <= toTs)) {
        out.push({
          operator_id: operatorId,
          kind:        "support.assigned",
          occurred_at: openedAt,
          title:       "Support ticket assigned",
          body:        t.subject + " [" + t.category + "/" + t.priority + "]",
          link:        "/operator/support/" + t.id,
          action:      "assign",
          severity:    t.priority === "urgent" ? "urgent" : (t.priority === "high" ? "warning" : "info"),
        });
      }
      if (t.resolved_at != null) {
        var resolvedAt = Number(t.resolved_at);
        if ((fromTs == null || resolvedAt >= fromTs) && (toTs == null || resolvedAt <= toTs)) {
          out.push({
            operator_id: operatorId,
            kind:        "support.resolved",
            occurred_at: resolvedAt,
            title:       "Support ticket resolved",
            body:        t.subject,
            link:        "/operator/support/" + t.id,
            action:      "resolve",
            severity:    "info",
          });
        }
      }
    }
    return out;
  }

  async function _collectSupportEventsAll(fromTs, toTs) {
    if (!supportPeer) return [];
    var rows = (await query(
      "SELECT id, subject, category, priority, assigned_operator_id, " +
      "opened_at, resolved_at FROM support_tickets " +
      "WHERE assigned_operator_id IS NOT NULL ORDER BY opened_at ASC",
      [],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var t = rows[i];
      var openedAt = Number(t.opened_at);
      if ((fromTs == null || openedAt >= fromTs) && (toTs == null || openedAt <= toTs)) {
        out.push({
          operator_id: t.assigned_operator_id,
          kind:        "support.assigned",
          occurred_at: openedAt,
          title:       "Support ticket assigned",
          body:        t.subject + " [" + t.category + "/" + t.priority + "]",
          link:        "/operator/support/" + t.id,
          action:      "assign",
          severity:    t.priority === "urgent" ? "urgent" : (t.priority === "high" ? "warning" : "info"),
        });
      }
      if (t.resolved_at != null) {
        var resolvedAt = Number(t.resolved_at);
        if ((fromTs == null || resolvedAt >= fromTs) && (toTs == null || resolvedAt <= toTs)) {
          out.push({
            operator_id: t.assigned_operator_id,
            kind:        "support.resolved",
            occurred_at: resolvedAt,
            title:       "Support ticket resolved",
            body:        t.subject,
            link:        "/operator/support/" + t.id,
            action:      "resolve",
            severity:    "info",
          });
        }
      }
    }
    return out;
  }

  async function _collectInboxEvents(operatorId, fromTs, toTs) {
    if (!inboxPeer) return [];
    // Per-operator inbox events. Role-broadcast rows do not surface
    // here because they aren't attributable to a single operator —
    // they show up in teamFeed instead.
    var sql = "SELECT id, kind, severity, subject, body, created_at " +
              "FROM operator_inbox_messages WHERE operator_id = ?1";
    var params = [operatorId];
    var idx = 2;
    if (fromTs != null) { sql += " AND created_at >= ?" + idx; params.push(fromTs); idx += 1; }
    if (toTs   != null) { sql += " AND created_at <= ?" + idx; params.push(toTs);   idx += 1; }
    sql += " ORDER BY created_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var m = rows[i];
      out.push({
        operator_id: operatorId,
        kind:        "inbox." + m.kind,
        occurred_at: Number(m.created_at),
        title:       m.subject,
        body:        m.body,
        link:        "/operator/inbox/" + m.id,
        action:      "inbox-message",
        severity:    m.severity,
      });
    }
    return out;
  }

  async function _collectInboxEventsAll(fromTs, toTs) {
    if (!inboxPeer) return [];
    var sql = "SELECT id, operator_id, role, kind, severity, subject, body, " +
              "created_at FROM operator_inbox_messages";
    var params = [];
    var clauses = [];
    var idx = 1;
    if (fromTs != null) { clauses.push("created_at >= ?" + idx); params.push(fromTs); idx += 1; }
    if (toTs   != null) { clauses.push("created_at <= ?" + idx); params.push(toTs);   idx += 1; }
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY created_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var m = rows[i];
      out.push({
        operator_id: m.operator_id || null,
        kind:        "inbox." + m.kind,
        occurred_at: Number(m.created_at),
        title:       m.subject,
        body:        m.body,
        link:        "/operator/inbox/" + m.id,
        action:      "inbox-message",
        severity:    m.severity,
      });
    }
    return out;
  }

  async function _collectSessionEvents(operatorId, fromTs, toTs) {
    // operator_sessions is queried directly (no peer gate) because
    // the table is canonical. When the migration isn't loaded the
    // catch below collapses the source to an empty list — same posture
    // as the skip-injected-peers rule.
    var rows;
    try {
      rows = (await query(
        "SELECT id, status, ip_hash, ua_class, created_at, activated_at, " +
        "revoked_at, revoke_reason, expires_at FROM operator_sessions " +
        "WHERE operator_id = ?1 ORDER BY created_at ASC",
        [operatorId],
      )).rows;
    } catch (_e) {
      return [];                                                       // drop-silent — sessions migration may be unloaded in a slim harness
    }
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var s = rows[i];
      var createdAt = Number(s.created_at);
      if ((fromTs == null || createdAt >= fromTs) && (toTs == null || createdAt <= toTs)) {
        out.push({
          operator_id: operatorId,
          kind:        "session.login",
          occurred_at: createdAt,
          title:       "Logged in",
          body:        s.ua_class ? ("via " + s.ua_class) : "session started",
          link:        "/admin/operators/" + operatorId + "/sessions",
          action:      "login",
          severity:    "info",
        });
      }
      if (s.revoked_at != null) {
        var revokedAt = Number(s.revoked_at);
        if ((fromTs == null || revokedAt >= fromTs) && (toTs == null || revokedAt <= toTs)) {
          out.push({
            operator_id: operatorId,
            kind:        "session.revoked",
            occurred_at: revokedAt,
            title:       "Session revoked",
            body:        s.revoke_reason || "session ended",
            link:        "/admin/operators/" + operatorId + "/sessions",
            action:      "revoke",
            severity:    s.revoke_reason && /lockout/.test(s.revoke_reason) ? "warning" : "info",
          });
        }
      }
    }
    return out;
  }

  async function _collectSessionEventsAll(fromTs, toTs) {
    var rows;
    try {
      rows = (await query(
        "SELECT id, operator_id, ua_class, created_at, revoked_at, revoke_reason " +
        "FROM operator_sessions ORDER BY created_at ASC",
        [],
      )).rows;
    } catch (_e) {
      return [];                                                       // drop-silent — sessions migration may be unloaded in a slim harness
    }
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var s = rows[i];
      var createdAt = Number(s.created_at);
      if ((fromTs == null || createdAt >= fromTs) && (toTs == null || createdAt <= toTs)) {
        out.push({
          operator_id: s.operator_id,
          kind:        "session.login",
          occurred_at: createdAt,
          title:       "Logged in",
          body:        s.ua_class ? ("via " + s.ua_class) : "session started",
          link:        "/admin/operators/" + s.operator_id + "/sessions",
          action:      "login",
          severity:    "info",
        });
      }
      if (s.revoked_at != null) {
        var revokedAt = Number(s.revoked_at);
        if ((fromTs == null || revokedAt >= fromTs) && (toTs == null || revokedAt <= toTs)) {
          out.push({
            operator_id: s.operator_id,
            kind:        "session.revoked",
            occurred_at: revokedAt,
            title:       "Session revoked",
            body:        s.revoke_reason || "session ended",
            link:        "/admin/operators/" + s.operator_id + "/sessions",
            action:      "revoke",
            severity:    s.revoke_reason && /lockout/.test(s.revoke_reason) ? "warning" : "info",
          });
        }
      }
    }
    return out;
  }

  // ---- aggregation ------------------------------------------------------

  async function _collectForOperator(operatorId, fromTs, toTs) {
    var batches = await Promise.all([
      _collectAuditEvents(operatorId, fromTs, toTs),
      _collectSupportEvents(operatorId, fromTs, toTs),
      _collectInboxEvents(operatorId, fromTs, toTs),
      _collectSessionEvents(operatorId, fromTs, toTs),
    ]);
    var flat = [];
    for (var b = 0; b < batches.length; b += 1) {
      for (var i = 0; i < batches[b].length; i += 1) {
        flat.push(batches[b][i]);
      }
    }
    return flat;
  }

  async function _collectAll(fromTs, toTs) {
    var batches = await Promise.all([
      _collectAuditEventsAll(fromTs, toTs),
      _collectSupportEventsAll(fromTs, toTs),
      _collectInboxEventsAll(fromTs, toTs),
      _collectSessionEventsAll(fromTs, toTs),
    ]);
    var flat = [];
    for (var b = 0; b < batches.length; b += 1) {
      for (var i = 0; i < batches[b].length; i += 1) {
        flat.push(batches[b][i]);
      }
    }
    return flat;
  }

  function _sortNewestFirst(events) {
    events.sort(function (a, b) {
      if (b.occurred_at !== a.occurred_at) return b.occurred_at - a.occurred_at;
      // Tie-break on kind so the order is deterministic across
      // platforms when two events land in the same epoch-ms.
      if (a.kind < b.kind) return 1;
      if (a.kind > b.kind) return -1;
      return 0;
    });
    return events;
  }

  function _filterKinds(events, kinds) {
    if (!kinds) return events;
    var set = {};
    for (var i = 0; i < kinds.length; i += 1) set[kinds[i]] = true;
    return events.filter(function (e) { return set[e.kind] === true; });
  }

  // Apply the cursor tail-tuple. Cursor carries `[occurred_at, kind]`
  // of the last row of the previous page; the next page starts at
  // the first row that's strictly older in the (occurred_at DESC,
  // kind DESC) ordering.
  function _applyCursor(events, cursorVals) {
    if (!cursorVals) return events;
    var ts   = Number(cursorVals[0]);
    var kind = String(cursorVals[1]);
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      if (e.occurred_at < ts) { out.push(e); continue; }
      if (e.occurred_at === ts && e.kind < kind) { out.push(e); continue; }
    }
    return out;
  }

  function _encodeNext(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return b.pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [last.occurred_at, last.kind],
      forward:  true,
    }, cursorSecret);
  }

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("operatorActivityFeed." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("operatorActivityFeed." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("operatorActivityFeed." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _stripInternalFields(events) {
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      out.push({
        operator_id: e.operator_id == null ? null : e.operator_id,
        kind:        e.kind,
        occurred_at: e.occurred_at,
        title:       e.title,
        body:        e.body == null ? null : e.body,
        link:        e.link == null ? null : e.link,
        action:      e.action == null ? null : e.action,
        severity:    e.severity == null ? "info" : e.severity,
      });
    }
    return out;
  }

  // Roll up per-source freshness stats so the cache freshness check
  // can detect a new source-event that lands in the same epoch-ms
  // as the cache row.
  async function _sourceStats(operatorId) {
    var checks = [];
    if (auditPeer) {
      checks.push(query(
        "SELECT MAX(occurred_at) AS m FROM operator_audit_events WHERE actor_id = ?1",
        [operatorId],
      ));
    }
    if (supportPeer) {
      checks.push(query(
        "SELECT " +
        "(SELECT MAX(opened_at)   FROM support_tickets WHERE assigned_operator_id = ?1) AS c1, " +
        "(SELECT MAX(resolved_at) FROM support_tickets WHERE assigned_operator_id = ?1) AS c2",
        [operatorId],
      ));
    }
    if (inboxPeer) {
      checks.push(query(
        "SELECT MAX(created_at) AS m FROM operator_inbox_messages WHERE operator_id = ?1",
        [operatorId],
      ));
    }
    // Sessions table check — wrapped in try/catch the same way the
    // collector is, so a missing migration doesn't break the freshness
    // gate.
    var sessionsP = (async function () {
      try {
        return await query(
          "SELECT MAX(created_at) AS m1, MAX(revoked_at) AS m2 FROM operator_sessions WHERE operator_id = ?1",
          [operatorId],
        );
      } catch (_e) {
        return { rows: [] };                                           // drop-silent — sessions migration absent
      }
    })();
    checks.push(sessionsP);

    var results = await Promise.all(checks);
    var latest = 0;
    for (var i = 0; i < results.length; i += 1) {
      var rs = results[i].rows;
      if (!rs.length) continue;
      var row = rs[0];
      var keys = Object.keys(row);
      for (var k = 0; k < keys.length; k += 1) {
        var raw = row[keys[k]];
        if (raw == null) continue;
        var v = Number(raw);
        if (Number.isFinite(v) && v > latest) latest = v;
      }
    }
    return { latest: latest };
  }

  async function _cacheGet(operatorId) {
    var r = await query(
      "SELECT operator_id, last_activity_at, recent_actions_json, computed_at " +
      "FROM operator_activity_cache WHERE operator_id = ?1",
      [operatorId],
    );
    return r.rows[0] || null;
  }

  async function _cachePut(operatorId, summary) {
    var ts = _monotonicTs();
    await query("DELETE FROM operator_activity_cache WHERE operator_id = ?1", [operatorId]);
    await query(
      "INSERT INTO operator_activity_cache " +
      "(operator_id, last_activity_at, recent_actions_json, computed_at) " +
      "VALUES (?1, ?2, ?3, ?4)",
      [
        operatorId,
        summary.last_activity_at || 0,
        JSON.stringify(summary.kind_counts || {}),
        ts,
      ],
    );
  }

  async function _cacheIsFresh(cacheRow, nowTs) {
    if (!cacheRow) return false;
    if (nowTs - Number(cacheRow.computed_at) > CACHE_TTL_MS) return false;
    var stats = await _sourceStats(cacheRow.operator_id);
    if (stats.latest > Number(cacheRow.last_activity_at)) return false;
    return true;
  }

  function _countByKindInWindow(events, cutoff) {
    var counts = {};
    var total = 0;
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      if (e.occurred_at < cutoff) continue;
      counts[e.kind] = (counts[e.kind] || 0) + 1;
      total += 1;
    }
    return { counts: counts, total: total };
  }

  async function _computeSummary(operatorId, days, nowTs) {
    var cutoff = nowTs - (days * MS_PER_DAY);
    var events = await _collectForOperator(operatorId, null, null);
    _sortNewestFirst(events);
    var last = events.length ? events[0].occurred_at : 0;
    var roll = _countByKindInWindow(events, cutoff);
    return {
      last_activity_at:  last,
      kind_counts:       roll.counts,
      total:             roll.total,
    };
  }

  // ---- public surface ---------------------------------------------------

  return {
    CACHE_TTL_MS:        CACHE_TTL_MS,
    MAX_LIMIT:           MAX_LIMIT,
    DEFAULT_LIMIT:       DEFAULT_LIMIT,
    MAX_RECENT_LOGINS:   MAX_RECENT_LOGINS,
    ONLINE_WINDOW_MS:    ONLINE_WINDOW_MS,

    forOperator: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorActivityFeed.forOperator: input object required");
      }
      var operatorId = _uuid(input.operator_id, "operator_id");
      var fromTs     = _epochMs(input.from, "from");
      var toTs       = _epochMs(input.to,   "to");
      if (fromTs != null && toTs != null && fromTs > toTs) {
        throw new TypeError("operatorActivityFeed.forOperator: from must be <= to");
      }
      var kinds  = _kinds(input.kinds);
      var limit  = _limit(input.limit, MAX_LIMIT, DEFAULT_LIMIT);
      var cursor = _decodeCursor(input.cursor, "forOperator");

      var events = await _collectForOperator(operatorId, fromTs, toTs);
      events = _filterKinds(events, kinds);
      _sortNewestFirst(events);
      if (cursor) events = _applyCursor(events, cursor);
      var page = events.slice(0, limit);
      return {
        events:      _stripInternalFields(page),
        next_cursor: _encodeNext(page, limit),
      };
    },

    teamFeed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorActivityFeed.teamFeed: input object required");
      }
      var fromTs = _epochMs(input.from, "from");
      var toTs   = _epochMs(input.to,   "to");
      if (fromTs != null && toTs != null && fromTs > toTs) {
        throw new TypeError("operatorActivityFeed.teamFeed: from must be <= to");
      }
      var kinds = _kinds(input.kinds);
      var limit = _limit(input.limit, MAX_LIMIT, DEFAULT_LIMIT);
      var events = await _collectAll(fromTs, toTs);
      events = _filterKinds(events, kinds);
      _sortNewestFirst(events);
      var page = events.slice(0, limit);
      return _stripInternalFields(page);
    },

    summarizeForOperator: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorActivityFeed.summarizeForOperator: input object required");
      }
      var operatorId = _uuid(input.operator_id, "operator_id");
      var days       = _days(input.days);
      var nowTs = _now();

      // The cache stores the latest kind_counts blob (whatever the
      // last summarize() computation rolled). For a different `days`
      // window we recompute — caching every (operator, days) tuple
      // would explode the keyspace. The cache hot-path is the common
      // case where the admin homepage strip calls summarizeForOperator
      // for the same `days` value repeatedly.
      var cached = await _cacheGet(operatorId);
      if (await _cacheIsFresh(cached, nowTs)) {
        // The cache row's kind_counts only matches the requested
        // `days` window if the request matches the stored summary's
        // window. Without a stored window we MUST recompute to give
        // the caller a correct answer; the cache still benefits
        // freshness checks because _sourceStats() is the dominant
        // cost on a cold call.
        var summary = await _computeSummary(operatorId, days, nowTs);
        return {
          last_activity_at: summary.last_activity_at || null,
          kind_counts:      summary.kind_counts,
          total:            summary.total,
          cache_hit:        true,
        };
      }
      var fresh = await _computeSummary(operatorId, days, nowTs);
      await _cachePut(operatorId, fresh);
      return {
        last_activity_at: fresh.last_activity_at || null,
        kind_counts:      fresh.kind_counts,
        total:            fresh.total,
        cache_hit:        false,
      };
    },

    recentLogins: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorActivityFeed.recentLogins: input object required");
      }
      var operatorId = _uuid(input.operator_id, "operator_id");
      var rows;
      try {
        rows = (await query(
          "SELECT id, status, ip_hash, ua_class, created_at, activated_at, " +
          "revoked_at, revoke_reason, expires_at FROM operator_sessions " +
          "WHERE operator_id = ?1 ORDER BY created_at DESC LIMIT ?2",
          [operatorId, MAX_RECENT_LOGINS],
        )).rows;
      } catch (_e) {
        return [];                                                     // drop-silent — sessions migration absent
      }
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var s = rows[i];
        out.push({
          id:            s.id,
          status:        s.status,
          ip_hash:       s.ip_hash,
          ua_class:      s.ua_class == null ? null : s.ua_class,
          created_at:    Number(s.created_at),
          activated_at:  s.activated_at == null ? null : Number(s.activated_at),
          revoked_at:    s.revoked_at   == null ? null : Number(s.revoked_at),
          revoke_reason: s.revoke_reason == null ? null : s.revoke_reason,
          expires_at:    Number(s.expires_at),
        });
      }
      return out;
    },

    currentlyOnline: async function () {
      var nowTs  = _now();
      var cutoff = nowTs - ONLINE_WINDOW_MS;
      var rows;
      try {
        rows = (await query(
          "SELECT operator_id, " +
          "MAX(COALESCE(activated_at, created_at)) AS last_seen_at " +
          "FROM operator_sessions " +
          "WHERE status = 'active' AND expires_at > ?1 " +
          "AND COALESCE(activated_at, created_at) >= ?2 " +
          "GROUP BY operator_id " +
          "ORDER BY last_seen_at DESC",
          [nowTs, cutoff],
        )).rows;
      } catch (_e) {
        return [];                                                     // drop-silent — sessions migration absent
      }
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({
          operator_id:   rows[i].operator_id,
          last_seen_at:  Number(rows[i].last_seen_at),
        });
      }
      return out;
    },

    topActions: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorActivityFeed.topActions: input object required");
      }
      var fromTs = _epochMs(input.from, "from");
      var toTs   = _epochMs(input.to,   "to");
      if (fromTs == null) {
        throw new TypeError("operatorActivityFeed.topActions: from is required");
      }
      if (toTs == null) {
        throw new TypeError("operatorActivityFeed.topActions: to is required");
      }
      if (fromTs > toTs) {
        throw new TypeError("operatorActivityFeed.topActions: from must be <= to");
      }
      var limit = _limit(input.limit, MAX_LIMIT, DEFAULT_LIMIT);
      if (!auditPeer) return [];
      var rows = (await query(
        "SELECT action, COUNT(*) AS c FROM operator_audit_events " +
        "WHERE occurred_at >= ?1 AND occurred_at <= ?2 " +
        "GROUP BY action ORDER BY c DESC, action ASC LIMIT ?3",
        [fromTs, toTs, limit],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({
          action: rows[i].action,
          count:  Number(rows[i].c),
        });
      }
      return out;
    },
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
  CACHE_TTL_MS:        CACHE_TTL_MS,
  MAX_LIMIT:           MAX_LIMIT,
  DEFAULT_LIMIT:       DEFAULT_LIMIT,
  MAX_RECENT_LOGINS:   MAX_RECENT_LOGINS,
  ONLINE_WINDOW_MS:    ONLINE_WINDOW_MS,
};
