"use strict";
/**
 * @module shop.clickstream
 * @title  Clickstream — server-side page-event capture for storefront
 *
 * @intro
 *   Captures page views + button clicks + form submits + scroll depth
 *   + video engagement + dwell time without a third-party JS tag.
 *   Distinct from `analytics` (which carries the operator-relevant
 *   funnel: PDP view, cart add, checkout) — this is the explicit
 *   page-event layer underneath. Operators wire `recordPageView` into
 *   the page handler and `recordEvent` into the form/fetch beacon
 *   endpoint; the same `query` adapter the rest of the data layer
 *   uses persists each row to D1 (or any sqlite-shaped backend during
 *   tests).
 *
 *   Three-tier validation: this primitive is a HOT-PATH observability
 *   sink. The write entry points (`recordPageView`, `recordEvent`)
 *   drop-silent on malformed input — a throw here would crash the
 *   request that triggered the event and lose the page render that
 *   the operator was trying to instrument. The READ entry points
 *   (`sessionPath`, `topPages`, `topClicks`, `funnelAnalysis`,
 *   `bouncerate`, `dwellByPage`, `cleanupOlderThan`) throw on bad
 *   input because they're operator-driven dashboard / cron call sites
 *   where a typo SHOULD surface loudly.
 *
 *   Surface:
 *
 *     clickstream.recordPageView({ session_id, path, referrer?,
 *                                  ua_class?, customer_id?, occurred_at? })
 *       → { id, occurred_at } | null   (null on drop-silent rejection)
 *
 *     clickstream.recordEvent({ session_id, kind, element?, payload?,
 *                               page_path, occurred_at? })
 *       → { id, occurred_at } | null
 *       kind ∈ { click, form_submit, form_abandon,
 *                video_play, video_complete, scroll_depth, dwell }
 *
 *     clickstream.sessionPath({ session_id })
 *       → [{ kind: 'pageview'|<event_kind>, path, ...row, occurred_at }]
 *         chronologically sorted; merges pageviews + events into one
 *         timeline the operator can replay.
 *
 *     clickstream.topPages({ from, to, limit })
 *       → [{ path, views, unique_sessions }]
 *
 *     clickstream.topClicks({ from, to, limit, page_path? })
 *       → [{ element, page_path, clicks }]
 *
 *     clickstream.funnelAnalysis({ steps, from, to })
 *       → { steps: [{ path_pattern, sessions, retained_pct }], total_sessions }
 *         steps[] are glob-ish path patterns (literal path OR a path
 *         ending in `/*` for prefix match). Retention is computed per
 *         session: a session counts for step N if it visited a path
 *         matching step N AFTER its earliest visit to step N-1.
 *
 *     clickstream.bouncerate({ from, to })
 *       → { single_page_sessions, total_sessions, bouncerate }
 *         bouncerate = single_page_sessions / total_sessions, clamped
 *         to [0, 1]. A session counts as single-page if all its
 *         pageviews share the same path.
 *
 *     clickstream.dwellByPage({ from, to })
 *       → [{ page_path, samples, avg_ms, p95_ms }]
 *         derived from `dwell` events (payload.ms). p95 is a sorted-
 *         nearest-rank percentile (no interpolation) — the cheapest
 *         shape that's still operator-meaningful for this volume.
 *
 *     clickstream.cleanupOlderThan(days)
 *       → { pageviews_deleted, events_deleted }
 *
 *   Privacy posture: `session_id` and `customer_id` are SHA3-512
 *   namespace-hashed (`clickstream-session` / `clickstream-customer`)
 *   before the row reaches the database. Raw values never persist;
 *   `sessionPath({ session_id })` re-hashes its argument under the
 *   same namespace so the operator hands in the raw cookie value
 *   they have on hand. The path columns are stripped of any query
 *   string at the write site so a `?email=alice@example.com` in the
 *   URL never reaches the table.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — SHA3-512 hash of session + customer
 *                                  identifiers under the clickstream
 *                                  namespaces.
 *     - `b.uuid.v7`              — monotonic-lex row ids so the
 *                                  default `ORDER BY id` matches
 *                                  `ORDER BY occurred_at` without an
 *                                  explicit tiebreaker.
 *
 *   Storage: `migrations-d1/0161_clickstream.sql`.
 *
 * @primitive clickstream
 * @related   shop.analytics, b.crypto, b.uuid
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SESSION_NAMESPACE   = "clickstream-session";
var CUSTOMER_NAMESPACE  = "clickstream-customer";

var UA_CLASSES          = Object.freeze(["desktop", "mobile", "tablet", "bot", "other"]);
var EVENT_KINDS         = Object.freeze([
  "click", "form_submit", "form_abandon",
  "video_play", "video_complete",
  "scroll_depth", "dwell",
]);

var MAX_PATH_LEN        = 2048;
var MAX_REFERRER_LEN    = 2048;
var MAX_ELEMENT_LEN     = 256;
var MAX_SESSION_ID_LEN  = 512;
var MAX_CUSTOMER_ID_LEN = 512;
var MAX_PAYLOAD_BYTES   = 4096;

var DEFAULT_TOP_LIMIT   = 10;
var MAX_TOP_LIMIT       = 100;
var MAX_FUNNEL_STEPS    = 16;
var MAX_CLEANUP_DAYS    = 365 * 5;
var MIN_CLEANUP_DAYS    = 1;

var ONE_YEAR_MS         = C.TIME.days(365);
var DEFAULT_WINDOW_MS   = C.TIME.days(30);

// Raw-PII shapes refused at every write site (mirrors the analytics
// guard). A hashed identifier is hex / base64url and never trips
// these shapes, so the gate is a one-way "operator handed us raw
// PII" detector.
// Each quantifier is bounded so a long run of non-@ characters can't drive
// backtracking: one char before the @, then a non-empty local part, then a
// lazy bridge to the first dot that is followed by another non-@ character.
var RAW_EMAIL_RE = /[^\s@]@[^\s@][^\s@]*?\.[^\s@]/;
var RAW_IPV4_RE  = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
var RAW_IPV6_RE  = /(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{0,4}/;

// ---- monotonic clock ----------------------------------------------------
//
// Page views + intra-page events persist epoch-ms timestamps and the
// session-timeline / funnel queries read them back in chronological
// order. Two same-millisecond `_now()` calls produce distinct
// integers so a tight burst of clicks (a customer hammering the
// "add to cart" button) sorts deterministically without an extra
// tiebreaker column.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- drop-silent input checks (hot-path writes) ------------------------
//
// drop-silent — by design: the recordPageView / recordEvent paths run
// inside the request lifecycle. A throw here would fail the request
// that triggered the page render or beacon. Each `_dropOn*` helper
// returns true when the value is unusable, so the caller bails to
// `return null` without raising.

function _badString(value, maxLen) {
  if (typeof value !== "string") return true;
  if (value.length === 0) return true;
  if (value.length > maxLen) return true;
  return false;
}

function _looksLikeRawPii(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (RAW_EMAIL_RE.test(value)) return true;
  if (RAW_IPV4_RE.test(value))  return true;
  if (RAW_IPV6_RE.test(value))  return true;
  return false;
}

// Strip the query string + fragment from a path. PII often rides in
// query params (`?email=`, `?token=`) and the table never wants it.
// The hash mark / question mark are both potential carriers; the
// path-only prefix is what aggregates index on.
function _normalizePath(p) {
  if (typeof p !== "string") return null;
  var q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  var h = p.indexOf("#");
  if (h !== -1) p = p.slice(0, h);
  if (p.length === 0) return null;
  if (p.length > MAX_PATH_LEN) return null;
  return p;
}

// ---- throw-on-bad-input checks (operator-driven reads) -----------------

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("clickstream: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _resolveWindow(opts, label) {
  if (opts == null || typeof opts !== "object") {
    throw new TypeError("clickstream." + label + ": input object required");
  }
  var now  = Date.now();
  var from = opts.from == null ? (now - DEFAULT_WINDOW_MS) : opts.from;
  var to   = opts.to   == null ? now                       : opts.to;
  _epochMs(from, "from");
  _epochMs(to,   "to");
  if (from >= to) {
    throw new TypeError("clickstream." + label + ": from must be strictly less than to");
  }
  if ((to - from) > ONE_YEAR_MS) {
    throw new TypeError("clickstream." + label + ": window (to - from) must be ≤ 1 year");
  }
  return { from: from, to: to };
}

function _limit(n, label, max) {
  max = max || MAX_TOP_LIMIT;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new TypeError("clickstream." + label + ": limit must be an integer in [1, " + max + "]");
  }
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Hash helpers — namespace-separated digests of the raw session /
  // customer identifiers so stored rows never carry the plaintext.
  function _sessionHash(raw)  { return b.crypto.namespaceHash(SESSION_NAMESPACE,  raw); }
  function _customerHash(raw) { return b.crypto.namespaceHash(CUSTOMER_NAMESPACE, raw); }

  return {

    // ---- write paths (drop-silent on bad input) ------------------------

    // Record a single server-rendered page view. The session_id and
    // customer_id are hashed at the write site; raw email / IP
    // shapes are refused by dropping the write. Query string is
    // stripped from `path` before persistence.
    recordPageView: async function (input) {
      if (!input || typeof input !== "object")              return null;
      if (_badString(input.session_id, MAX_SESSION_ID_LEN)) return null;
      if (_looksLikeRawPii(input.session_id))               return null;

      var path = _normalizePath(input.path);
      if (path == null) return null;

      var referrer = null;
      if (input.referrer != null) {
        if (_badString(input.referrer, MAX_REFERRER_LEN)) return null;
        if (_looksLikeRawPii(input.referrer))             return null;
        referrer = input.referrer;
      }

      var uaClass = input.ua_class == null ? "other" : input.ua_class;
      if (UA_CLASSES.indexOf(uaClass) === -1) return null;

      var customerIdHash = null;
      if (input.customer_id != null) {
        if (_badString(input.customer_id, MAX_CUSTOMER_ID_LEN)) return null;
        if (_looksLikeRawPii(input.customer_id))                return null;
        customerIdHash = _customerHash(input.customer_id);
      }

      var occurredAt;
      if (input.occurred_at == null) {
        occurredAt = _now();
      } else if (Number.isInteger(input.occurred_at) && input.occurred_at >= 0) {
        occurredAt = input.occurred_at;
      } else {
        return null;
      }

      var sessionHash = _sessionHash(input.session_id);
      var id = b.uuid.v7();
      try {
        await query(
          "INSERT INTO clickstream_pageviews " +
          "(id, session_id_hash, path, referrer, ua_class, customer_id_hash, occurred_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
          [id, sessionHash, path, referrer, uaClass, customerIdHash, occurredAt],
        );
      } catch (_e) { return null; /* drop-silent — by design; write-site sink swallow */ }
      return { id: id, occurred_at: occurredAt };
    },

    // Record a single intra-page event. Same drop-silent posture as
    // recordPageView — a malformed beacon never crashes the request.
    recordEvent: async function (input) {
      if (!input || typeof input !== "object")              return null;
      if (_badString(input.session_id, MAX_SESSION_ID_LEN)) return null;
      if (_looksLikeRawPii(input.session_id))               return null;

      if (typeof input.kind !== "string")          return null;
      if (EVENT_KINDS.indexOf(input.kind) === -1)  return null;

      var pagePath = _normalizePath(input.page_path);
      if (pagePath == null) return null;

      var element = null;
      if (input.element != null) {
        if (_badString(input.element, MAX_ELEMENT_LEN)) return null;
        if (_looksLikeRawPii(input.element))            return null;
        element = input.element;
      }

      // payload — JSON-encode in-process so the size bound checks the
      // encoded bytes. `null` / `undefined` defaults to `{}`.
      var payloadInput = input.payload == null ? {} : input.payload;
      if (typeof payloadInput !== "object" || Array.isArray(payloadInput)) return null;
      var payloadJson;
      try { payloadJson = JSON.stringify(payloadInput); }
      catch (_e) { return null; /* drop-silent — by design; unserialisable payload from the wire */ }
      if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) return null;

      var occurredAt;
      if (input.occurred_at == null) {
        occurredAt = _now();
      } else if (Number.isInteger(input.occurred_at) && input.occurred_at >= 0) {
        occurredAt = input.occurred_at;
      } else {
        return null;
      }

      var sessionHash = _sessionHash(input.session_id);
      var id = b.uuid.v7();
      try {
        await query(
          "INSERT INTO clickstream_events " +
          "(id, session_id_hash, kind, element, payload_json, page_path, occurred_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
          [id, sessionHash, input.kind, element, payloadJson, pagePath, occurredAt],
        );
      } catch (_e) { return null; /* drop-silent — by design; write-site sink swallow */ }
      return { id: id, occurred_at: occurredAt };
    },

    // ---- read paths (throw on bad input) -------------------------------

    // Full per-session timeline. Operator hands in the raw session_id
    // they have on the request; the primitive hashes it under the
    // same namespace as the write site and returns the merged
    // pageview + event stream sorted ascending by occurred_at.
    sessionPath: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("clickstream.sessionPath: input object required");
      }
      if (typeof input.session_id !== "string" || input.session_id.length === 0) {
        throw new TypeError("clickstream.sessionPath: session_id required");
      }
      if (input.session_id.length > MAX_SESSION_ID_LEN) {
        throw new TypeError("clickstream.sessionPath: session_id exceeds " + MAX_SESSION_ID_LEN + " chars");
      }
      if (_looksLikeRawPii(input.session_id)) {
        throw new TypeError("clickstream.sessionPath: session_id looks like raw PII");
      }
      var hash = _sessionHash(input.session_id);

      var pv = await query(
        "SELECT id, path, referrer, ua_class, customer_id_hash, occurred_at " +
        "  FROM clickstream_pageviews " +
        " WHERE session_id_hash = ?1 " +
        " ORDER BY occurred_at ASC, id ASC",
        [hash],
      );
      var ev = await query(
        "SELECT id, kind, element, payload_json, page_path, occurred_at " +
        "  FROM clickstream_events " +
        " WHERE session_id_hash = ?1 " +
        " ORDER BY occurred_at ASC, id ASC",
        [hash],
      );

      var rows = [];
      for (var i = 0; i < pv.rows.length; i += 1) {
        var p = pv.rows[i];
        rows.push({
          kind:             "pageview",
          id:               p.id,
          path:             p.path,
          referrer:         p.referrer,
          ua_class:         p.ua_class,
          customer_id_hash: p.customer_id_hash,
          occurred_at:      Number(p.occurred_at) || 0,
        });
      }
      for (var j = 0; j < ev.rows.length; j += 1) {
        var e = ev.rows[j];
        var payload;
        try { payload = JSON.parse(e.payload_json || "{}"); }
        catch (_e) { payload = {}; /* drop-silent — by design; stored shape is primitive-owned */ }
        rows.push({
          kind:        e.kind,
          id:          e.id,
          element:     e.element,
          payload:     payload,
          page_path:   e.page_path,
          occurred_at: Number(e.occurred_at) || 0,
        });
      }
      rows.sort(function (a, b) {
        if (a.occurred_at !== b.occurred_at) return a.occurred_at - b.occurred_at;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
      return rows;
    },

    // Top-N visited paths in the window. Reports both total view
    // count and unique-session count (the second is the operator-
    // useful "reach" metric — a single bot hammering /home doesn't
    // skew it).
    topPages: async function (windowOpts) {
      var w = _resolveWindow(windowOpts, "topPages");
      var limit = (windowOpts && windowOpts.limit) == null ? DEFAULT_TOP_LIMIT : windowOpts.limit;
      _limit(limit, "topPages");
      var r = await query(
        "SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id_hash) AS unique_sessions " +
        "  FROM clickstream_pageviews " +
        " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
        " GROUP BY path " +
        " ORDER BY views DESC, path ASC " +
        " LIMIT ?3",
        [w.from, w.to, limit],
      );
      return r.rows.map(function (row) {
        return {
          path:            row.path,
          views:           Number(row.views) || 0,
          unique_sessions: Number(row.unique_sessions) || 0,
        };
      });
    },

    // Top-N click elements in the window. Optional `page_path`
    // narrows the aggregate to a single page (operator inspecting
    // a specific landing-page CTA mix).
    topClicks: async function (windowOpts) {
      var w = _resolveWindow(windowOpts, "topClicks");
      var limit = (windowOpts && windowOpts.limit) == null ? DEFAULT_TOP_LIMIT : windowOpts.limit;
      _limit(limit, "topClicks");
      var sql, params;
      if (windowOpts && windowOpts.page_path != null) {
        if (typeof windowOpts.page_path !== "string" || windowOpts.page_path.length === 0) {
          throw new TypeError("clickstream.topClicks: page_path must be a non-empty string when provided");
        }
        if (windowOpts.page_path.length > MAX_PATH_LEN) {
          throw new TypeError("clickstream.topClicks: page_path exceeds " + MAX_PATH_LEN + " chars");
        }
        sql =
          "SELECT element, page_path, COUNT(*) AS clicks " +
          "  FROM clickstream_events " +
          " WHERE kind = 'click' " +
          "   AND element IS NOT NULL " +
          "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
          "   AND page_path = ?3 " +
          " GROUP BY element, page_path " +
          " ORDER BY clicks DESC, element ASC " +
          " LIMIT ?4";
        params = [w.from, w.to, windowOpts.page_path, limit];
      } else {
        sql =
          "SELECT element, page_path, COUNT(*) AS clicks " +
          "  FROM clickstream_events " +
          " WHERE kind = 'click' " +
          "   AND element IS NOT NULL " +
          "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
          " GROUP BY element, page_path " +
          " ORDER BY clicks DESC, element ASC " +
          " LIMIT ?3";
        params = [w.from, w.to, limit];
      }
      var r = await query(sql, params);
      return r.rows.map(function (row) {
        return {
          element:   row.element,
          page_path: row.page_path,
          clicks:    Number(row.clicks) || 0,
        };
      });
    },

    // Multi-step funnel retention. Steps are path patterns — either
    // a literal path or a path ending in `/*` for prefix match. A
    // session is retained for step N when it visited a matching
    // path at OR AFTER its earliest visit to step N-1. The first
    // step seeds `total_sessions` (the denominator every retained
    // percentage uses).
    funnelAnalysis: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("clickstream.funnelAnalysis: input object required");
      }
      if (!Array.isArray(input.steps) || input.steps.length < 2) {
        throw new TypeError("clickstream.funnelAnalysis: steps must be an array of at least 2 patterns");
      }
      if (input.steps.length > MAX_FUNNEL_STEPS) {
        throw new TypeError("clickstream.funnelAnalysis: steps exceeds " + MAX_FUNNEL_STEPS);
      }
      for (var s = 0; s < input.steps.length; s += 1) {
        var p = input.steps[s];
        if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH_LEN) {
          throw new TypeError("clickstream.funnelAnalysis: steps[" + s + "] must be a non-empty path pattern <= " + MAX_PATH_LEN + " chars");
        }
      }
      var w = _resolveWindow(input, "funnelAnalysis");

      // Translate each pattern to a SQL predicate (literal `path = ?`
      // or `path LIKE ?` for the `/foo/*` prefix shape). Capture
      // (session_id_hash, earliest occurred_at) per step then walk
      // the steps in order, retaining a session at step N only if
      // its earliest-match for step N happened at-or-after its
      // step (N-1) earliest-match.
      var stepHits = [];
      for (var i = 0; i < input.steps.length; i += 1) {
        var pat = input.steps[i];
        var sql, params;
        if (pat.length > 2 && pat.slice(-2) === "/*") {
          var prefix = pat.slice(0, -1); // keep trailing slash
          sql =
            "SELECT session_id_hash, MIN(occurred_at) AS earliest " +
            "  FROM clickstream_pageviews " +
            " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
            "   AND path LIKE ?3 " +
            " GROUP BY session_id_hash";
          params = [w.from, w.to, prefix + "%"];
        } else {
          sql =
            "SELECT session_id_hash, MIN(occurred_at) AS earliest " +
            "  FROM clickstream_pageviews " +
            " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
            "   AND path = ?3 " +
            " GROUP BY session_id_hash";
          params = [w.from, w.to, pat];
        }
        var r = await query(sql, params);
        var byHash = new Map();
        for (var j = 0; j < r.rows.length; j += 1) {
          byHash.set(r.rows[j].session_id_hash, Number(r.rows[j].earliest) || 0);
        }
        stepHits.push(byHash);
      }

      // Walk forwards: retained[i] is the set of session_id_hashes
      // that reached step i, anchored by the earliest-occurred-at
      // recorded for step i-1.
      var totalSessions = stepHits[0].size;
      var retainedSet = new Set(stepHits[0].keys());
      var stepsOut = [];
      stepsOut.push({
        path_pattern:  input.steps[0],
        sessions:      retainedSet.size,
        retained_pct:  totalSessions > 0 ? 1 : 0,
      });
      var prevHits = stepHits[0];
      for (var k = 1; k < input.steps.length; k += 1) {
        var thisHits = stepHits[k];
        var next = new Set();
        retainedSet.forEach(function (hash) {
          if (!thisHits.has(hash)) return;
          var prev = prevHits.get(hash);
          var curr = thisHits.get(hash);
          if (prev == null || curr == null) return;
          if (curr >= prev) next.add(hash);
        });
        var pct = totalSessions > 0 ? (next.size / totalSessions) : 0;
        if (pct < 0) pct = 0;
        if (pct > 1) pct = 1;
        stepsOut.push({
          path_pattern: input.steps[k],
          sessions:     next.size,
          retained_pct: pct,
        });
        retainedSet = next;
        // Anchor advances to the latest cursor at each step — the
        // monotonic "step N at-or-after step N-1" semantics.
        var advanced = new Map();
        next.forEach(function (h) { advanced.set(h, thisHits.get(h)); });
        prevHits = advanced;
      }
      return {
        steps:          stepsOut,
        total_sessions: totalSessions,
      };
    },

    // Single-page-session rate. A session counts as single-page
    // when every pageview it landed in the window shares the same
    // path. Empty windows return 0 (no sessions, no bounce).
    bouncerate: async function (windowOpts) {
      var w = _resolveWindow(windowOpts, "bouncerate");
      var r = await query(
        "SELECT session_id_hash, COUNT(DISTINCT path) AS distinct_paths " +
        "  FROM clickstream_pageviews " +
        " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
        " GROUP BY session_id_hash",
        [w.from, w.to],
      );
      var total = r.rows.length;
      var single = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        if (Number(r.rows[i].distinct_paths) === 1) single += 1;
      }
      var rate = total > 0 ? (single / total) : 0;
      if (rate < 0) rate = 0;
      if (rate > 1) rate = 1;
      return {
        single_page_sessions: single,
        total_sessions:       total,
        bouncerate:           rate,
      };
    },

    // Average + p95 dwell time per page from `dwell` events. p95 is
    // sorted-nearest-rank (no interpolation) — cheap, monotonic,
    // and operator-meaningful when the sample count crosses ~20.
    dwellByPage: async function (windowOpts) {
      var w = _resolveWindow(windowOpts, "dwellByPage");
      var r = await query(
        "SELECT page_path, payload_json, occurred_at " +
        "  FROM clickstream_events " +
        " WHERE kind = 'dwell' " +
        "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
        " ORDER BY page_path ASC",
        [w.from, w.to],
      );
      var buckets = new Map();
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var payload;
        try { payload = JSON.parse(row.payload_json || "{}"); }
        catch (_e) { payload = {}; /* drop-silent — by design; stored shape is primitive-owned */ }
        var ms = payload && typeof payload.ms === "number" && isFinite(payload.ms) && payload.ms >= 0 ? payload.ms : null;
        if (ms == null) continue;
        if (!buckets.has(row.page_path)) buckets.set(row.page_path, []);
        buckets.get(row.page_path).push(ms);
      }
      var out = [];
      buckets.forEach(function (samples, page_path) {
        samples.sort(function (a, b) { return a - b; });
        var n = samples.length;
        var sum = 0;
        for (var k = 0; k < n; k += 1) sum += samples[k];
        var avg = n > 0 ? (sum / n) : 0;
        // Sorted-nearest-rank p95: index = ceil(0.95 * n) - 1, clamped.
        var idx = Math.ceil(0.95 * n) - 1;
        if (idx < 0) idx = 0;
        if (idx > n - 1) idx = n - 1;
        var p95 = n > 0 ? samples[idx] : 0;
        out.push({
          page_path: page_path,
          samples:   n,
          avg_ms:    avg,
          p95_ms:    p95,
        });
      });
      out.sort(function (a, b) {
        if (b.samples !== a.samples) return b.samples - a.samples;
        if (a.page_path < b.page_path) return -1;
        if (a.page_path > b.page_path) return 1;
        return 0;
      });
      return out;
    },

    // Retention sweep. Operators schedule this against the same cron
    // they use for the rest of the data-minimisation stack — returns
    // the per-table delete count so a long-running sweep can log
    // its impact.
    cleanupOlderThan: async function (days) {
      if (!Number.isInteger(days) || days < MIN_CLEANUP_DAYS || days > MAX_CLEANUP_DAYS) {
        throw new TypeError("clickstream.cleanupOlderThan: days must be an integer in [" +
                            MIN_CLEANUP_DAYS + ", " + MAX_CLEANUP_DAYS + "]");
      }
      var cutoff = Date.now() - (days * C.TIME.days(1));
      var pv = await query(
        "DELETE FROM clickstream_pageviews WHERE occurred_at < ?1",
        [cutoff],
      );
      var ev = await query(
        "DELETE FROM clickstream_events WHERE occurred_at < ?1",
        [cutoff],
      );
      return {
        pageviews_deleted: Number(pv.rowCount) || 0,
        events_deleted:    Number(ev.rowCount) || 0,
      };
    },

    // Exposed enums so the operator-facing dashboard can render the
    // canonical kind / ua_class list without duplicating the source
    // of truth.
    UA_CLASSES:   UA_CLASSES,
    EVENT_KINDS:  EVENT_KINDS,
  };
}

module.exports = {
  create:            create,
  UA_CLASSES:        UA_CLASSES,
  EVENT_KINDS:       EVENT_KINDS,
  SESSION_NAMESPACE: SESSION_NAMESPACE,
  CUSTOMER_NAMESPACE:CUSTOMER_NAMESPACE,
  ONE_YEAR_MS:       ONE_YEAR_MS,
  DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
};
