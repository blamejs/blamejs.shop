"use strict";
/**
 * errorLog — hot-path observability sink for HTTP 4xx/5xx events.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0100_error_log.sql. Exercises every shipped surface:
 *
 *   - recordError happy path (row landed; session_id hashed)
 *   - recordError drop-silent on bad input (no throw; no row)
 *   - top404Paths GROUP BY path, ORDER BY count DESC
 *   - top5xxErrors GROUP BY (path, status), filter on 5xx only
 *   - slowRenders threshold + ordering
 *   - errorById correlation lookup (hit + miss)
 *   - byStatus keyset pagination across multiple pages
 *   - metrics total + 4xx/5xx class split + p50/p95/p99
 *   - read-side validators THROW (operator-facing dashboard surface)
 *
 * The primitive is required directly from `lib/error-log.js` — it
 * isn't (yet) wired onto the framework's index export, so the test
 * mirrors the layout other layer-1 tests use when they need just
 * the factory.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop      = require("../../lib");
var errorLogMod = require("../../lib/error-log");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

// Both migrations: the base table (0100) + the captured-message column
// the server-error capture path writes (0208). Loaded in order so the
// ALTER TABLE in 0208 lands on the table 0100 created.
var MIG_PATHS = [
  nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0100_error_log.sql"),
  nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0208_error_log_message.sql"),
];

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  MIG_PATHS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return {
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
    raw: db,
  };
}

var DAY    = 24 * 60 * 60 * 1000;
var MINUTE = 60 * 1000;

async function _recordHappy() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });

  var rawSession = "sess_" + bShop.framework.uuid.v7();
  var out = await log.recordError({
    status:           404,
    path:             "/products/missing-widget",
    method:           "GET",
    referrer:         "https://example.com/home",
    user_agent_class: "desktop",
    session_id:       rawSession,
    customer_id:      "cust-42",
    error_id:         "err-abc-001",
    response_time_ms: 87,
  });
  check("recordError returns id",         typeof out.id === "string" && out.id.length >= 26);
  check("recordError returns occurred_at", Number.isInteger(out.occurred_at) && out.occurred_at > 0);
  check("recordError reports no drop",     !out.dropped);

  var row = q.raw.prepare("SELECT * FROM error_log WHERE id = ?").get(out.id);
  check("recordError persisted one row",            !!row);
  check("status stored as integer",                  row.status === 404);
  check("path stored verbatim",                       row.path === "/products/missing-widget");
  check("method stored verbatim",                     row.method === "GET");
  check("referrer stored verbatim",                   row.referrer === "https://example.com/home");
  check("user_agent_class stored",                    row.user_agent_class === "desktop");
  check("customer_id stored plain",                   row.customer_id === "cust-42");
  check("error_id stored",                            row.error_id === "err-abc-001");
  check("response_time_ms stored",                    Number(row.response_time_ms) === 87);
  check("session_id_hash is hex (hashed)",            /^[0-9a-f]{128}$/.test(row.session_id_hash));
  check("raw session_id NEVER persisted",             row.session_id_hash !== rawSession);

  // Repeat call with the same raw session hashes to the same value.
  var out2 = await log.recordError({
    status:           500,
    path:             "/api/checkout",
    method:           "POST",
    user_agent_class: "mobile",
    session_id:       rawSession,
  });
  var row2 = q.raw.prepare("SELECT * FROM error_log WHERE id = ?").get(out2.id);
  check("repeat session hash is deterministic",      row2.session_id_hash === row.session_id_hash);
  check("optional fields default to NULL",            row2.referrer === null && row2.customer_id === null && row2.error_id === null && row2.response_time_ms === null);
}

async function _recordDropsSilent() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });

  // Every bad-input shape resolves to a drop (no throw, no row).
  var drops = [
    null,
    undefined,
    "not-an-object",
    {},                                                          // missing everything
    { status: 200, path: "/x", method: "GET", user_agent_class: "desktop" },             // status out of range
    { status: 600, path: "/x", method: "GET", user_agent_class: "desktop" },             // status out of range
    { status: 404, path: "",   method: "GET", user_agent_class: "desktop" },             // empty path
    { status: 404, path: "x".repeat(3000), method: "GET", user_agent_class: "desktop" }, // oversized path
    { status: 404, path: "/x", method: "FROOB", user_agent_class: "desktop" },           // unknown method
    { status: 404, path: "/x", method: "GET", user_agent_class: "smartfridge" },         // unknown ua class
    { status: 404, path: "/x", method: "GET" },                                            // missing ua class
    { status: 404, path: "/x", method: "GET", user_agent_class: "desktop", session_id: "" },  // empty session_id
    { status: 404, path: "/x", method: "GET", user_agent_class: "desktop", session_id: "s".repeat(600) }, // oversized
    { status: 404, path: "/x", method: "GET", user_agent_class: "desktop", response_time_ms: -1 },        // negative timing
    { status: 404, path: "/x", method: "GET", user_agent_class: "desktop", response_time_ms: 1.5 },        // float timing
    { status: 404, path: "/x", method: "GET", user_agent_class: "desktop", occurred_at: "yesterday" },      // bad occurred_at
    { status: "404", path: "/x", method: "GET", user_agent_class: "desktop" },             // string status
  ];

  for (var i = 0; i < drops.length; i += 1) {
    var out = await log.recordError(drops[i]);
    check("drop-silent case " + i + " returned dropped:true",
      out && out.dropped === true && typeof out.reason === "string");
    check("drop-silent case " + i + " did NOT throw and did NOT return an id",
      out.id == null);
  }
  var n = q.raw.prepare("SELECT COUNT(*) AS n FROM error_log").get().n;
  check("no rows landed across every drop-silent case", Number(n) === 0);
}

async function _top404Paths() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  var now = Date.now();
  var from = now - 7 * DAY;

  // /broken: 3 hits, /missing: 2, /lost: 1; a 500 on /broken must
  // NOT count (filter is status=404).
  await log.recordError({ status: 404, path: "/broken",  method: "GET", user_agent_class: "desktop", occurred_at: from + 1 * MINUTE });
  await log.recordError({ status: 404, path: "/broken",  method: "GET", user_agent_class: "desktop", occurred_at: from + 2 * MINUTE });
  await log.recordError({ status: 404, path: "/broken",  method: "GET", user_agent_class: "desktop", occurred_at: from + 3 * MINUTE });
  await log.recordError({ status: 404, path: "/missing", method: "GET", user_agent_class: "desktop", occurred_at: from + 4 * MINUTE });
  await log.recordError({ status: 404, path: "/missing", method: "GET", user_agent_class: "desktop", occurred_at: from + 5 * MINUTE });
  await log.recordError({ status: 404, path: "/lost",    method: "GET", user_agent_class: "desktop", occurred_at: from + 6 * MINUTE });
  await log.recordError({ status: 500, path: "/broken",  method: "GET", user_agent_class: "desktop", occurred_at: from + 7 * MINUTE });

  var rows = await log.top404Paths({ from: from, to: now, limit: 10 });
  check("top404Paths returns 3 rows (500 excluded)", rows.length === 3);
  check("/broken first with 3",                       rows[0].path === "/broken"  && rows[0].count === 3);
  check("/missing second with 2",                     rows[1].path === "/missing" && rows[1].count === 2);
  check("/lost third with 1",                         rows[2].path === "/lost"    && rows[2].count === 1);

  var limited = await log.top404Paths({ from: from, to: now, limit: 1 });
  check("top404Paths honors limit=1", limited.length === 1 && limited[0].path === "/broken");
}

async function _top5xxErrors() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  var now  = Date.now();
  var from = now - 7 * DAY;

  // /api/checkout 502: 3 hits → top.
  // /api/checkout 500: 2 hits.
  // /api/cart 503:     1 hit.
  // A 404 on /api/checkout must NOT contaminate.
  await log.recordError({ status: 502, path: "/api/checkout", method: "POST", user_agent_class: "desktop", occurred_at: from + 1 * MINUTE });
  await log.recordError({ status: 502, path: "/api/checkout", method: "POST", user_agent_class: "desktop", occurred_at: from + 2 * MINUTE });
  await log.recordError({ status: 502, path: "/api/checkout", method: "POST", user_agent_class: "desktop", occurred_at: from + 3 * MINUTE });
  await log.recordError({ status: 500, path: "/api/checkout", method: "POST", user_agent_class: "desktop", occurred_at: from + 4 * MINUTE });
  await log.recordError({ status: 500, path: "/api/checkout", method: "POST", user_agent_class: "desktop", occurred_at: from + 5 * MINUTE });
  await log.recordError({ status: 503, path: "/api/cart",     method: "GET",  user_agent_class: "mobile",  occurred_at: from + 6 * MINUTE });
  await log.recordError({ status: 404, path: "/api/checkout", method: "POST", user_agent_class: "desktop", occurred_at: from + 7 * MINUTE });

  var rows = await log.top5xxErrors({ from: from, to: now, limit: 10 });
  check("top5xxErrors returns 3 rows (404 excluded)",  rows.length === 3);
  check("(checkout, 502) first with count 3",
    rows[0].path === "/api/checkout" && rows[0].status === 502 && rows[0].count === 3);
  check("(checkout, 500) second with count 2",
    rows[1].path === "/api/checkout" && rows[1].status === 500 && rows[1].count === 2);
  check("(cart, 503) third with count 1",
    rows[2].path === "/api/cart" && rows[2].status === 503 && rows[2].count === 1);
}

async function _slowRenders() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  var now  = Date.now();
  var from = now - 7 * DAY;

  // Threshold 2000ms; rows above: 5000, 3000, 2500. Rows below
  // (1500, 100, NULL) excluded.
  await log.recordError({ status: 500, path: "/p/slow1", method: "GET", user_agent_class: "desktop", response_time_ms: 5000, occurred_at: from + 1 * MINUTE });
  await log.recordError({ status: 500, path: "/p/slow2", method: "GET", user_agent_class: "desktop", response_time_ms: 3000, occurred_at: from + 2 * MINUTE });
  await log.recordError({ status: 500, path: "/p/slow3", method: "GET", user_agent_class: "desktop", response_time_ms: 2500, occurred_at: from + 3 * MINUTE });
  await log.recordError({ status: 500, path: "/p/fast",  method: "GET", user_agent_class: "desktop", response_time_ms: 1500, occurred_at: from + 4 * MINUTE });
  await log.recordError({ status: 500, path: "/p/fast2", method: "GET", user_agent_class: "desktop", response_time_ms: 100,  occurred_at: from + 5 * MINUTE });
  await log.recordError({ status: 500, path: "/p/none",  method: "GET", user_agent_class: "desktop",                           occurred_at: from + 6 * MINUTE });

  var rows = await log.slowRenders({ from: from, to: now, limit: 10, p99_threshold_ms: 2000 });
  check("slowRenders returns 3 rows above threshold",  rows.length === 3);
  check("slowest first",                                rows[0].path === "/p/slow1" && rows[0].response_time_ms === 5000);
  check("second slowest",                               rows[1].path === "/p/slow2" && rows[1].response_time_ms === 3000);
  check("third slowest",                                rows[2].path === "/p/slow3" && rows[2].response_time_ms === 2500);

  // Higher threshold trims the result.
  var trimmed = await log.slowRenders({ from: from, to: now, limit: 10, p99_threshold_ms: 4000 });
  check("higher threshold trims to 1",                 trimmed.length === 1 && trimmed[0].path === "/p/slow1");
}

async function _errorById() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });

  var out = await log.recordError({
    status: 500, path: "/api/payment", method: "POST",
    user_agent_class: "desktop", error_id: "err-corr-9001",
    response_time_ms: 220,
  });
  check("recordError surfaced id",   typeof out.id === "string");

  var row = await log.errorById("err-corr-9001");
  check("errorById finds the row",            !!row);
  check("errorById returns same persisted id", row.id === out.id);
  check("errorById path matches",              row.path === "/api/payment");
  check("errorById status matches",            row.status === 500);
  check("errorById method matches",            row.method === "POST");
  check("errorById response_time_ms matches",   row.response_time_ms === 220);

  // Miss → null
  var miss = await log.errorById("err-not-real");
  check("errorById returns null on miss",      miss === null);

  // Bad input throws (read-side surface)
  await assert.rejects(log.errorById(""),              /error_id required/);
  await assert.rejects(log.errorById("x".repeat(200)), /error_id exceeds/);
}

async function _byStatusPagination() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  var now  = Date.now();
  var from = now - 7 * DAY;

  // Seed 7 404 rows at distinct timestamps so DESC ordering is
  // unambiguous. Decoy: one 500 must NOT appear.
  var i;
  for (i = 0; i < 7; i += 1) {
    await log.recordError({
      status: 404, path: "/p/" + i, method: "GET",
      user_agent_class: "desktop",
      occurred_at: from + (i + 1) * MINUTE,
    });
  }
  await log.recordError({ status: 500, path: "/decoy", method: "GET", user_agent_class: "desktop", occurred_at: from + 100 * MINUTE });

  // Page 1: limit 3 → 3 rows + next_cursor.
  var page1 = await log.byStatus({ status: 404, from: from, to: now, limit: 3 });
  check("byStatus page1 returns 3 rows",          page1.rows.length === 3);
  check("byStatus surfaces next_cursor",          typeof page1.next_cursor === "string");
  check("byStatus page1 sorted occurred_at DESC", page1.rows[0].occurred_at > page1.rows[2].occurred_at);
  check("byStatus page1 most-recent row first",   page1.rows[0].path === "/p/6");

  // Page 2: cursor from page 1.
  var page2 = await log.byStatus({ status: 404, from: from, to: now, limit: 3, cursor: page1.next_cursor });
  check("byStatus page2 returns 3 rows",          page2.rows.length === 3);
  check("byStatus page2 picks up at /p/3",         page2.rows[0].path === "/p/3");
  check("byStatus page2 ends at /p/1",             page2.rows[2].path === "/p/1");
  check("byStatus page2 still has next_cursor (one row left)", page2.next_cursor != null);

  // Page 3: last row.
  var page3 = await log.byStatus({ status: 404, from: from, to: now, limit: 3, cursor: page2.next_cursor });
  check("byStatus page3 returns 1 row",           page3.rows.length === 1);
  check("byStatus page3 picks up at /p/0",         page3.rows[0].path === "/p/0");
  check("byStatus page3 has no next_cursor",      page3.next_cursor === null);

  // Pages never include the 500 decoy.
  var allPaths = page1.rows.concat(page2.rows, page3.rows).map(function (r) { return r.path; });
  check("byStatus never surfaces a non-matching status", allPaths.indexOf("/decoy") === -1);

  // Validators throw on read-side surface
  await assert.rejects(log.byStatus({ status: 200, from: from, to: now }), /status must be/);
  await assert.rejects(log.byStatus({ status: 404, from: from, to: now, limit: 0 }),   /limit/);
  await assert.rejects(log.byStatus({ status: 404, from: from, to: now, limit: 501 }), /limit/);
  await assert.rejects(log.byStatus({ status: 404, from: from, to: now, cursor: "garbage" }),
    /cursor must be a string of the form/);
  await assert.rejects(log.byStatus({ status: 404, from: from, to: now, cursor: "abc:def" }),
    /cursor parses to garbage/);
}

async function _metrics() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  var now  = Date.now();
  var from = now - 7 * DAY;

  // Seed 100 rows: 70 with status 404 (4xx), 30 with status 503 (5xx).
  // response_time_ms = 1..100 → p50 = 50, p95 = 95, p99 = 99.
  // (Nearest-rank: ceil(p*N)-1 → ceil(50)-1=49 → sorted[49]=50;
  //  ceil(95)-1=94 → 95; ceil(99)-1=98 → 99.)
  var i;
  for (i = 1; i <= 70; i += 1) {
    await log.recordError({
      status: 404, path: "/p" + i, method: "GET",
      user_agent_class: "desktop", response_time_ms: i,
      occurred_at: from + i * MINUTE,
    });
  }
  for (i = 71; i <= 100; i += 1) {
    await log.recordError({
      status: 503, path: "/a" + i, method: "POST",
      user_agent_class: "desktop", response_time_ms: i,
      occurred_at: from + i * MINUTE,
    });
  }

  var m = await log.metrics({ from: from, to: now });
  check("metrics.total = 100",          m.total === 100);
  check("metrics.by_status_class.4xx = 70", m.by_status_class["4xx"] === 70);
  check("metrics.by_status_class.5xx = 30", m.by_status_class["5xx"] === 30);
  check("metrics.p50_ms = 50",          m.p50_ms === 50);
  check("metrics.p95_ms = 95",          m.p95_ms === 95);
  check("metrics.p99_ms = 99",          m.p99_ms === 99);

  // Empty window → zeros (not NaN).
  var empty = await log.metrics({ from: from - 365 * DAY + 1, to: from - 200 * DAY });
  check("metrics empty.total = 0",      empty.total === 0);
  check("metrics empty.p50_ms = 0",      empty.p50_ms === 0);
  check("metrics empty.p95_ms = 0",      empty.p95_ms === 0);
  check("metrics empty.p99_ms = 0",      empty.p99_ms === 0);
}

async function _validation() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  // Read-side validators THROW (operator-facing dashboard surface).
  await assert.rejects(log.top404Paths({ from: "x",  to: Date.now() }),    /from must be/);
  await assert.rejects(log.top404Paths({ from: 100,  to: 100 }),            /strictly less/);
  await assert.rejects(log.top404Paths({ from: 0,    to: 366 * DAY }),       /≤ 1 year/);
  await assert.rejects(log.top404Paths({ from: 0,    to: 1000, limit: 0 }),  /limit/);
  await assert.rejects(log.top5xxErrors({ from: 0,   to: 1000, limit: 101 }), /limit/);
  await assert.rejects(log.slowRenders({ from: 0,    to: 1000, p99_threshold_ms: -1 }), /p99_threshold_ms must be/);
  await assert.rejects(log.metrics({ from: 200,      to: 100 }),             /strictly less/);

  // No rows leaked from the validation calls.
  var n = q.raw.prepare("SELECT COUNT(*) AS n FROM error_log").get().n;
  check("validation calls landed no rows", Number(n) === 0);
}

async function _captureHappy() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });

  // Explicit, distinct occurred_at so the (occurred_at DESC) primary
  // sort is unambiguous — uuid.v7 is NOT monotonic within a single ms,
  // so a same-ms tie would order non-deterministically by id.
  var base = Date.now() - 60000;
  var out = await log.captureServerError({
    route: "/checkout", message: "Stripe confirm failed: card_declined",
    method: "POST", status: 500, occurred_at: base,
  });
  check("captureServerError returns id",         typeof out.id === "string" && out.id.length >= 26);
  check("captureServerError returns occurred_at", Number.isInteger(out.occurred_at) && out.occurred_at > 0);
  check("captureServerError reports no drop",     !out.dropped);

  var row = q.raw.prepare("SELECT * FROM error_log WHERE id = ?").get(out.id);
  check("capture persisted one row",      !!row);
  check("capture stored the message",     row.message === "Stripe confirm failed: card_declined");
  check("capture stored the route as path", row.path === "/checkout");
  check("capture stored the method",      row.method === "POST");
  check("capture stored the status",      row.status === 500);
  check("capture lands UA class 'other'", row.user_agent_class === "other");
  check("capture carries NO session PII", row.session_id_hash == null);
  check("capture carries NO customer PII", row.customer_id == null);
  check("capture carries NO referrer",    row.referrer == null);

  // Defaults: status→500, method→GET, occurred_at→now.
  var out2 = await log.captureServerError({ route: "/api/catalog/products", message: "DB timeout", occurred_at: base + 1000 });
  var row2 = q.raw.prepare("SELECT * FROM error_log WHERE id = ?").get(out2.id);
  check("capture status defaults to 500", row2.status === 500);
  check("capture method defaults to GET", row2.method === "GET");
  check("capture occurred_at stored",     Number(row2.occurred_at) === base + 1000);

  // recentServerErrors returns newest-first, message-bearing only.
  var recent = await log.recentServerErrors({ limit: 50 });
  check("recentServerErrors returns both captured rows", recent.length === 2);
  check("recentServerErrors newest first", recent[0].id === out2.id && recent[1].id === out.id);
  check("recentServerErrors maps route+message", recent[1].route === "/checkout" && recent[1].message === "Stripe confirm failed: card_declined");
}

async function _captureIsolatesFromMetadataRows() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });

  // A response-metadata row (recordError) must NOT appear in the
  // captured-error feed, and a captured row must NOT pollute the 5xx
  // aggregate's path/status buckets beyond its own row.
  await log.recordError({ status: 500, path: "/p/meta", method: "GET", user_agent_class: "desktop" });
  await log.captureServerError({ route: "/checkout", message: "boom" });

  var recent = await log.recentServerErrors({ limit: 50 });
  check("feed excludes response-metadata rows", recent.length === 1 && recent[0].route === "/checkout");

  // The metadata row has NULL message; the captured row has NULL referrer/etc.
  var metaRow = q.raw.prepare("SELECT * FROM error_log WHERE path = ?").get("/p/meta");
  check("response-metadata row has NULL message", metaRow.message == null);
}

async function _captureDropsSilent() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });

  var drops = [
    null,
    undefined,
    "not-an-object",
    {},                                                        // missing route + message
    { route: "/x" },                                            // missing message
    { message: "boom" },                                        // missing route
    { route: "", message: "boom" },                             // empty route
    { route: "x".repeat(3000), message: "boom" },               // oversized route
    { route: "/x", message: "" },                               // empty message
    { route: "/x", message: 12345 },                            // non-string message
    { route: "/x", message: "boom", status: 404 },              // 4xx not allowed (goes through recordError)
    { route: "/x", message: "boom", status: 200 },              // out of 5xx band
    { route: "/x", message: "boom", method: "FROOB" },          // unknown method
    { route: "/x", message: "boom", occurred_at: "yesterday" },  // bad occurred_at
  ];

  for (var i = 0; i < drops.length; i += 1) {
    var out = await log.captureServerError(drops[i]);
    check("capture drop-silent case " + i + " returned dropped:true",
      out && out.dropped === true && typeof out.reason === "string");
    check("capture drop-silent case " + i + " did NOT throw and did NOT return an id", out.id == null);
  }
  var n = q.raw.prepare("SELECT COUNT(*) AS n FROM error_log").get().n;
  check("no rows landed across every capture drop-silent case", Number(n) === 0);
}

async function _captureTruncatesMessage() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });

  // An over-long message is TRUNCATED to MAX_MESSAGE, not dropped — the
  // head of a scrubbed failure is the useful part.
  var long = "E".repeat(errorLogMod.MAX_MESSAGE + 500);
  var out = await log.captureServerError({ route: "/checkout", message: long });
  check("oversized message still captured (not dropped)", !out.dropped && typeof out.id === "string");
  var row = q.raw.prepare("SELECT message FROM error_log WHERE id = ?").get(out.id);
  check("message truncated to MAX_MESSAGE", row.message.length === errorLogMod.MAX_MESSAGE);
  check("message keeps the head", row.message === "E".repeat(errorLogMod.MAX_MESSAGE));
}

async function _captureRingBufferCap() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  var now = Date.now();

  // Seed CAP + 25 captured rows at strictly increasing timestamps. After
  // each insert the trim keeps only the newest CAP, so the feed holds
  // exactly CAP rows and the OLDEST 25 are gone.
  var cap = errorLogMod.SERVER_ERROR_CAP;
  var total = cap + 25;
  for (var i = 0; i < total; i += 1) {
    await log.captureServerError({
      route: "/checkout", message: "err-" + i,
      occurred_at: now - (total - i) * 1000,    // older → newer
    });
  }

  var n = q.raw.prepare("SELECT COUNT(*) AS n FROM error_log WHERE message IS NOT NULL").get().n;
  check("ring buffer holds exactly the cap", Number(n) === cap);

  // The 25 oldest (err-0 .. err-24) are gone; the newest (err-{total-1}) remains.
  var oldest = q.raw.prepare("SELECT COUNT(*) AS n FROM error_log WHERE message = ?").get("err-0").n;
  check("oldest captured row evicted", Number(oldest) === 0);
  var newest = q.raw.prepare("SELECT COUNT(*) AS n FROM error_log WHERE message = ?").get("err-" + (total - 1)).n;
  check("newest captured row retained", Number(newest) === 1);

  // recentServerErrors honours its own limit independent of the cap.
  var page = await log.recentServerErrors({ limit: 10 });
  check("recentServerErrors honours limit", page.length === 10);
  check("recentServerErrors newest-first after trim", page[0].message === "err-" + (total - 1));
}

async function _captureDropSilentOnBrokenQuery() {
  // A write failure mid-request must resolve to a silent drop — the
  // capture is wired into catch blocks and must never throw.
  var calls = 0;
  var brokenQuery = async function () {
    calls += 1;
    throw new Error("D1 bridge unreachable");
  };
  var log = errorLogMod.create({ query: brokenQuery });

  var out = await log.captureServerError({ route: "/checkout", message: "boom" });
  check("broken-query capture did NOT throw", out && out.dropped === true);
  check("broken-query capture reason is internal", out.reason === "internal");
  check("broken-query capture attempted the write", calls >= 1);

  // recentServerErrors (read-side) propagates a broken-query failure —
  // that's a dashboard read with an operator on the other end. (The
  // ADMIN route wraps it in try/catch; the primitive itself throws.)
  await assert.rejects(log.recentServerErrors({ limit: 10 }), /D1 bridge unreachable/);
}

async function _captureReadValidation() {
  var q = _makeQuery();
  var log = errorLogMod.create({ query: q.query });
  // recentServerErrors is a read-side surface — bad limit THROWS.
  await assert.rejects(log.recentServerErrors({ limit: 0 }),   /limit/);
  await assert.rejects(log.recentServerErrors({ limit: 501 }), /limit/);
  await assert.rejects(log.recentServerErrors({ limit: 1.5 }), /limit/);
}

async function run() {
  await _recordHappy();
  await _recordDropsSilent();
  await _top404Paths();
  await _top5xxErrors();
  await _slowRenders();
  await _errorById();
  await _byStatusPagination();
  await _metrics();
  await _validation();
  await _captureHappy();
  await _captureIsolatesFromMetadataRows();
  await _captureDropsSilent();
  await _captureTruncatesMessage();
  await _captureRingBufferCap();
  await _captureDropSilentOnBrokenQuery();
  await _captureReadValidation();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("error-log.test.js: ok (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("error-log.test.js: FAIL\n" + (e && e.stack ? e.stack : e) + "\n");
    process.exit(1);
  });
}
