"use strict";
/**
 * clickstream — server-side page-event capture for storefront pages.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0161.
 *
 * Coverage:
 *   - recordPageView round-trip: row persists with hashed session +
 *     hashed customer, query string stripped from path, default
 *     ua_class, default occurred_at advances monotonically.
 *   - recordEvent round-trip: every supported `kind`, drop-silent
 *     on bad kind / payload / page_path / raw PII, oversized
 *     payload rejected, occurred_at monotonic across same-ms calls.
 *   - sessionPath merges pageviews + events chronologically.
 *   - topPages aggregates view count + unique session count, sorts
 *     by views DESC, respects limit.
 *   - topClicks aggregates click counts, narrows by page_path.
 *   - funnelAnalysis: literal + `/*`-prefix steps, retention only
 *     credits sessions reaching step N at-or-after step N-1.
 *   - bouncerate: single-page sessions / total sessions math.
 *   - dwellByPage: avg + sorted-nearest-rank p95 from `dwell`
 *     events' payload.ms.
 *   - cleanupOlderThan: per-table delete counts.
 *   - read-path validation surface: throws on missing args,
 *     reversed windows, bad limits, bad days.
 *   - drop-silent write surface: returns null on bad shapes
 *     without throwing.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop      = require("../../lib");
var clickstream = require("../../lib/clickstream");
var helpers    = require("../helpers");
var check      = helpers.check;
var assert     = helpers.assert;

var MIG_CLICKSTREAM = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0161_clickstream.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_CLICKSTREAM, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return {
          rows:      [],
          rowCount:  Number(info.changes),
          lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    cs:    clickstream.create({ query: h.query }),
  };
}

function _sessionHash(raw) {
  return bShop.framework.crypto.namespaceHash(clickstream.SESSION_NAMESPACE, raw);
}

function _customerHash(raw) {
  return bShop.framework.crypto.namespaceHash(clickstream.CUSTOMER_NAMESPACE, raw);
}

// ---- recordPageView -----------------------------------------------------

async function _recordPageViewRoundTrip() {
  var f = _factory();
  var sessionId = "sess-" + bShop.framework.uuid.v7();
  var customerId = "cust-" + bShop.framework.uuid.v7();
  var pv = await f.cs.recordPageView({
    session_id:  sessionId,
    path:        "/products/widget?utm_source=email",
    referrer:    "https://example.com/blog",
    ua_class:    "desktop",
    customer_id: customerId,
  });
  check("recordPageView returns row",        pv && typeof pv.id === "string");
  check("recordPageView occurred_at set",    typeof pv.occurred_at === "number" && pv.occurred_at > 0);

  // Direct row inspection — query string stripped, session hashed,
  // customer hashed, ua_class persisted.
  var rows = f.db.prepare("SELECT * FROM clickstream_pageviews").all();
  check("pageview persisted",                rows.length === 1);
  check("query string stripped from path",   rows[0].path === "/products/widget");
  check("session_id hashed at write site",   rows[0].session_id_hash === _sessionHash(sessionId)
                                              && rows[0].session_id_hash !== sessionId);
  check("customer_id hashed at write site",  rows[0].customer_id_hash === _customerHash(customerId)
                                              && rows[0].customer_id_hash !== customerId);
  check("ua_class persisted",                rows[0].ua_class === "desktop");
  check("referrer persisted",                rows[0].referrer === "https://example.com/blog");

  // Default ua_class is `other` when omitted.
  var pv2 = await f.cs.recordPageView({ session_id: "sess-defaults", path: "/cart" });
  check("recordPageView default ua_class",   pv2 !== null);
  var row2 = f.db.prepare("SELECT * FROM clickstream_pageviews WHERE id = ?").all(pv2.id);
  check("ua_class defaults to 'other'",      row2[0].ua_class === "other");

  // Monotonic occurred_at across same-ms calls — the strict-monotonic
  // clock ensures two writes in the same millisecond produce distinct
  // timestamps so timeline ordering is deterministic.
  var burst = [];
  for (var i = 0; i < 5; i += 1) {
    burst.push(await f.cs.recordPageView({ session_id: "burst-" + i, path: "/p" }));
  }
  var ts = burst.map(function (r) { return r.occurred_at; });
  var strictlyAsc = true;
  for (var k = 1; k < ts.length; k += 1) {
    if (ts[k] <= ts[k - 1]) { strictlyAsc = false; break; }
  }
  check("recordPageView monotonic ts",       strictlyAsc);
}

async function _recordPageViewDropSilent() {
  var f = _factory();
  // Each of these is a misshapen call the hot path drops silently.
  check("drop on missing input",             (await f.cs.recordPageView()) === null);
  check("drop on null session",              (await f.cs.recordPageView({ session_id: null, path: "/" })) === null);
  check("drop on empty session",             (await f.cs.recordPageView({ session_id: "",   path: "/" })) === null);
  check("drop on missing path",              (await f.cs.recordPageView({ session_id: "s" })) === null);
  check("drop on empty path",                (await f.cs.recordPageView({ session_id: "s", path: "" })) === null);
  check("drop on raw email session",         (await f.cs.recordPageView({ session_id: "alice@example.com", path: "/" })) === null);
  check("drop on raw IPv4 session",          (await f.cs.recordPageView({ session_id: "192.168.1.1", path: "/" })) === null);
  check("drop on bad ua_class",              (await f.cs.recordPageView({ session_id: "s", path: "/", ua_class: "tv" })) === null);
  check("drop on raw email customer",        (await f.cs.recordPageView({ session_id: "s", path: "/", customer_id: "bob@example.com" })) === null);
  check("drop on bad occurred_at",           (await f.cs.recordPageView({ session_id: "s", path: "/", occurred_at: -1 })) === null);
  check("drop on float occurred_at",         (await f.cs.recordPageView({ session_id: "s", path: "/", occurred_at: 1.5 })) === null);

  // The drops above never persisted a row.
  var rows = f.db.prepare("SELECT COUNT(*) AS n FROM clickstream_pageviews").all();
  check("drop-silent left no rows",          Number(rows[0].n) === 0);
}

// ---- recordEvent --------------------------------------------------------

async function _recordEventEveryKind() {
  var f = _factory();
  var session = "s-event-kinds";
  var kinds = clickstream.EVENT_KINDS;
  for (var i = 0; i < kinds.length; i += 1) {
    var r = await f.cs.recordEvent({
      session_id: session,
      kind:       kinds[i],
      element:    "btn-" + kinds[i],
      page_path:  "/p?nope=x",
      payload:    { sample: i, ms: 100 + i },
    });
    check("recordEvent " + kinds[i] + " round-trip", r && typeof r.id === "string");
  }
  var rows = f.db.prepare("SELECT kind, page_path, payload_json FROM clickstream_events ORDER BY occurred_at ASC").all();
  check("every kind persisted",              rows.length === kinds.length);
  check("page_path query stripped",          rows[0].page_path === "/p");
  // payload JSON round-trips
  var parsed = JSON.parse(rows[0].payload_json);
  check("payload round-trip",                parsed.sample === 0 && parsed.ms === 100);
}

async function _recordEventDropSilent() {
  var f = _factory();
  check("drop on missing input",             (await f.cs.recordEvent()) === null);
  check("drop on bad kind",                  (await f.cs.recordEvent({ session_id: "s", kind: "tap",   page_path: "/" })) === null);
  check("drop on missing kind",              (await f.cs.recordEvent({ session_id: "s",                page_path: "/" })) === null);
  check("drop on bad page_path",             (await f.cs.recordEvent({ session_id: "s", kind: "click", page_path: "" })) === null);
  check("drop on raw email session",         (await f.cs.recordEvent({ session_id: "user@example.com", kind: "click", page_path: "/" })) === null);
  check("drop on array payload",             (await f.cs.recordEvent({ session_id: "s", kind: "click", page_path: "/", payload: [1, 2, 3] })) === null);

  // Oversized payload (>4 KiB JSON-encoded) — drop-silent.
  var big = { blob: "x".repeat(5000) };
  check("drop on oversized payload",         (await f.cs.recordEvent({ session_id: "s", kind: "click", page_path: "/", payload: big })) === null);

  var rows = f.db.prepare("SELECT COUNT(*) AS n FROM clickstream_events").all();
  check("drop-silent left no event rows",    Number(rows[0].n) === 0);
}

// ---- sessionPath --------------------------------------------------------

async function _sessionPathOrdering() {
  var f = _factory();
  var session = "alice";
  // Pin occurred_at values so the timeline is independent of wall-clock.
  await f.cs.recordPageView({ session_id: session, path: "/home", occurred_at: 1000 });
  await f.cs.recordEvent({     session_id: session, kind: "click", element: "cta",   page_path: "/home", occurred_at: 1500 });
  await f.cs.recordPageView({ session_id: session, path: "/pdp",   occurred_at: 2000 });
  await f.cs.recordEvent({     session_id: session, kind: "scroll_depth", element: null, page_path: "/pdp", payload: { depth: 50 }, occurred_at: 2500 });
  await f.cs.recordEvent({     session_id: session, kind: "form_submit", element: "buy-form", page_path: "/pdp", occurred_at: 3000 });

  // Decoy: another session's events must NOT show up.
  await f.cs.recordPageView({ session_id: "bob", path: "/home", occurred_at: 1200 });
  await f.cs.recordEvent({     session_id: "bob", kind: "click", element: "x",    page_path: "/home", occurred_at: 1300 });

  var timeline = await f.cs.sessionPath({ session_id: session });
  check("sessionPath length",                timeline.length === 5);
  check("sessionPath chronological",         timeline[0].occurred_at === 1000
                                              && timeline[1].occurred_at === 1500
                                              && timeline[2].occurred_at === 2000
                                              && timeline[3].occurred_at === 2500
                                              && timeline[4].occurred_at === 3000);
  check("sessionPath first is pageview",     timeline[0].kind === "pageview" && timeline[0].path === "/home");
  check("sessionPath click after",           timeline[1].kind === "click"    && timeline[1].element === "cta");
  check("sessionPath excludes other sessions",
                                              timeline.every(function (r) {
                                                return (r.kind === "pageview")
                                                  || r.page_path === "/home"
                                                  || r.page_path === "/pdp";
                                              }));
  // payload survives.
  check("sessionPath payload round-trip",    timeline[3].kind === "scroll_depth" && timeline[3].payload.depth === 50);
}

// ---- topPages -----------------------------------------------------------

async function _topPagesAggregation() {
  var f = _factory();
  var base = 1_700_000_000_000;
  // /home: 4 views from 3 distinct sessions
  // /pdp:  2 views from 2 distinct sessions
  // /cart: 1 view  from 1 session
  await f.cs.recordPageView({ session_id: "s1", path: "/home", occurred_at: base + 10 });
  await f.cs.recordPageView({ session_id: "s2", path: "/home", occurred_at: base + 20 });
  await f.cs.recordPageView({ session_id: "s3", path: "/home", occurred_at: base + 30 });
  await f.cs.recordPageView({ session_id: "s1", path: "/home", occurred_at: base + 40 });
  await f.cs.recordPageView({ session_id: "s1", path: "/pdp",  occurred_at: base + 50 });
  await f.cs.recordPageView({ session_id: "s2", path: "/pdp",  occurred_at: base + 60 });
  await f.cs.recordPageView({ session_id: "s1", path: "/cart", occurred_at: base + 70 });

  var top = await f.cs.topPages({ from: base, to: base + 1000, limit: 10 });
  check("topPages row count",                top.length === 3);
  check("topPages /home views",              top[0].path === "/home" && top[0].views === 4 && top[0].unique_sessions === 3);
  check("topPages /pdp views",               top[1].path === "/pdp"  && top[1].views === 2 && top[1].unique_sessions === 2);
  check("topPages /cart views",              top[2].path === "/cart" && top[2].views === 1 && top[2].unique_sessions === 1);

  // limit respected
  var top1 = await f.cs.topPages({ from: base, to: base + 1000, limit: 1 });
  check("topPages limit honoured",           top1.length === 1 && top1[0].path === "/home");
}

// ---- topClicks ----------------------------------------------------------

async function _topClicksAggregation() {
  var f = _factory();
  var base = 1_700_000_000_000;
  await f.cs.recordEvent({ session_id: "s1", kind: "click", element: "buy",  page_path: "/pdp",  occurred_at: base + 10 });
  await f.cs.recordEvent({ session_id: "s2", kind: "click", element: "buy",  page_path: "/pdp",  occurred_at: base + 20 });
  await f.cs.recordEvent({ session_id: "s1", kind: "click", element: "cart", page_path: "/pdp",  occurred_at: base + 30 });
  await f.cs.recordEvent({ session_id: "s1", kind: "click", element: "home", page_path: "/home", occurred_at: base + 40 });
  // Non-click event must NOT count.
  await f.cs.recordEvent({ session_id: "s1", kind: "form_submit", element: "buy", page_path: "/pdp", occurred_at: base + 50 });

  var all = await f.cs.topClicks({ from: base, to: base + 1000, limit: 10 });
  check("topClicks row count",               all.length === 3);
  check("topClicks /pdp buy=2",              all[0].element === "buy" && all[0].page_path === "/pdp" && all[0].clicks === 2);

  var pdp = await f.cs.topClicks({ from: base, to: base + 1000, limit: 10, page_path: "/pdp" });
  check("topClicks page_path narrowed",      pdp.length === 2 && pdp.every(function (r) { return r.page_path === "/pdp"; }));
}

// ---- funnelAnalysis -----------------------------------------------------

async function _funnelAnalysisRetention() {
  var f = _factory();
  var base = 1_700_000_000_000;
  // s1: /home -> /pdp/widget -> /cart -> /checkout   (reaches step 4)
  // s2: /home -> /pdp/widget -> /cart                 (drops at step 4)
  // s3: /home -> /pdp/gadget                          (drops at step 3)
  // s4: /home                                         (drops at step 2)
  // s5: /pdp/widget (no /home)                        (never enters)
  // s6: /home -> /cart -> /pdp/widget                 (out-of-order; step 3 BEFORE step 2 → drops)
  await f.cs.recordPageView({ session_id: "s1", path: "/home",         occurred_at: base + 10 });
  await f.cs.recordPageView({ session_id: "s1", path: "/pdp/widget",   occurred_at: base + 20 });
  await f.cs.recordPageView({ session_id: "s1", path: "/cart",         occurred_at: base + 30 });
  await f.cs.recordPageView({ session_id: "s1", path: "/checkout",     occurred_at: base + 40 });

  await f.cs.recordPageView({ session_id: "s2", path: "/home",         occurred_at: base + 50 });
  await f.cs.recordPageView({ session_id: "s2", path: "/pdp/widget",   occurred_at: base + 60 });
  await f.cs.recordPageView({ session_id: "s2", path: "/cart",         occurred_at: base + 70 });

  await f.cs.recordPageView({ session_id: "s3", path: "/home",         occurred_at: base + 80 });
  await f.cs.recordPageView({ session_id: "s3", path: "/pdp/gadget",   occurred_at: base + 90 });

  await f.cs.recordPageView({ session_id: "s4", path: "/home",         occurred_at: base + 100 });

  await f.cs.recordPageView({ session_id: "s5", path: "/pdp/widget",   occurred_at: base + 110 });

  await f.cs.recordPageView({ session_id: "s6", path: "/home",         occurred_at: base + 120 });
  await f.cs.recordPageView({ session_id: "s6", path: "/cart",         occurred_at: base + 130 });
  await f.cs.recordPageView({ session_id: "s6", path: "/pdp/widget",   occurred_at: base + 140 });

  var fa = await f.cs.funnelAnalysis({
    steps: ["/home", "/pdp/*", "/cart", "/checkout"],
    from:  base,
    to:    base + 10_000,
  });
  // total_sessions seeded by step 1 (/home): s1, s2, s3, s4, s6 = 5.
  check("funnel total_sessions",             fa.total_sessions === 5);
  check("funnel step 1 sessions",            fa.steps[0].sessions === 5 && fa.steps[0].path_pattern === "/home");
  // Step 2 (/pdp/*) at-or-after step 1: s1, s2, s3 (s6's /pdp/widget AFTER its /home, so retained).
  check("funnel step 2 sessions",            fa.steps[1].sessions === 4);
  // Step 3 (/cart) at-or-after step 2: s1, s2 (s6 has /cart BEFORE /pdp/* so does NOT credit).
  check("funnel step 3 sessions",            fa.steps[2].sessions === 2);
  // Step 4 (/checkout) at-or-after step 3: s1 only.
  check("funnel step 4 sessions",            fa.steps[3].sessions === 1);
  check("funnel retained pct shape",         fa.steps[3].retained_pct > 0 && fa.steps[3].retained_pct <= 0.2 + 1e-9);
}

// ---- bouncerate ---------------------------------------------------------

async function _bouncerateMath() {
  var f = _factory();
  var base = 1_700_000_000_000;
  // s1: /home only                              -> single-page
  // s2: /home, /home                             -> single-page (same path twice)
  // s3: /home, /pdp                              -> multi-page
  // s4: /pdp only                                -> single-page
  await f.cs.recordPageView({ session_id: "s1", path: "/home", occurred_at: base + 10 });

  await f.cs.recordPageView({ session_id: "s2", path: "/home", occurred_at: base + 20 });
  await f.cs.recordPageView({ session_id: "s2", path: "/home", occurred_at: base + 30 });

  await f.cs.recordPageView({ session_id: "s3", path: "/home", occurred_at: base + 40 });
  await f.cs.recordPageView({ session_id: "s3", path: "/pdp",  occurred_at: base + 50 });

  await f.cs.recordPageView({ session_id: "s4", path: "/pdp",  occurred_at: base + 60 });

  var br = await f.cs.bouncerate({ from: base, to: base + 1000 });
  check("bouncerate total_sessions",         br.total_sessions === 4);
  check("bouncerate single_page",            br.single_page_sessions === 3);
  check("bouncerate ratio",                  Math.abs(br.bouncerate - 0.75) < 1e-9);

  // Empty window — operator-meaningful zero (no traffic, no bounce).
  var empty = await f.cs.bouncerate({ from: base + 10_000, to: base + 20_000 });
  check("bouncerate empty window",           empty.total_sessions === 0 && empty.bouncerate === 0);
}

// ---- dwellByPage --------------------------------------------------------

async function _dwellByPagePercentile() {
  var f = _factory();
  var base = 1_700_000_000_000;
  // /pdp dwell samples (ms): 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500
  // n=10, sum=33000, avg=3300, sorted-nearest-rank p95 idx=ceil(9.5)-1=9 -> 5500.
  for (var i = 0; i < 10; i += 1) {
    await f.cs.recordEvent({
      session_id: "s-pdp-" + i,
      kind:       "dwell",
      page_path:  "/pdp",
      payload:    { ms: 1000 + i * 500 },
      occurred_at: base + i * 10,
    });
  }
  // /home dwell samples (ms): 500, 600 (small sample) — avg=550, p95=600.
  await f.cs.recordEvent({ session_id: "h1", kind: "dwell", page_path: "/home", payload: { ms: 500 }, occurred_at: base + 200 });
  await f.cs.recordEvent({ session_id: "h2", kind: "dwell", page_path: "/home", payload: { ms: 600 }, occurred_at: base + 210 });

  // A dwell event with no ms in the payload is ignored.
  await f.cs.recordEvent({ session_id: "ghost", kind: "dwell", page_path: "/pdp", payload: { other: 1 }, occurred_at: base + 220 });

  var dw = await f.cs.dwellByPage({ from: base, to: base + 10_000 });
  // Sort: samples DESC, page_path ASC — /pdp (10 samples) first.
  check("dwellByPage row count",             dw.length === 2);
  check("dwellByPage /pdp samples",          dw[0].page_path === "/pdp" && dw[0].samples === 10);
  check("dwellByPage /pdp avg",              dw[0].avg_ms === 3250);
  check("dwellByPage /pdp p95",              dw[0].p95_ms === 5500);
  check("dwellByPage /home samples",         dw[1].page_path === "/home" && dw[1].samples === 2);
  check("dwellByPage /home avg",             dw[1].avg_ms === 550);
  check("dwellByPage /home p95",             dw[1].p95_ms === 600);
}

// ---- cleanupOlderThan ---------------------------------------------------

async function _cleanupOlderThan() {
  var f = _factory();
  var now = Date.now();
  var old = now - (60 * 24 * 60 * 60 * 1000); // 60 days ago
  await f.cs.recordPageView({ session_id: "ancient", path: "/old", occurred_at: old });
  await f.cs.recordEvent({     session_id: "ancient", kind: "click", element: "x", page_path: "/old", occurred_at: old });
  await f.cs.recordPageView({ session_id: "fresh",   path: "/new", occurred_at: now });
  await f.cs.recordEvent({     session_id: "fresh",   kind: "click", element: "y", page_path: "/new", occurred_at: now });

  var r = await f.cs.cleanupOlderThan(30);
  check("cleanup pageviews_deleted",         r.pageviews_deleted === 1);
  check("cleanup events_deleted",            r.events_deleted === 1);

  var remaining = f.db.prepare("SELECT path FROM clickstream_pageviews").all();
  check("cleanup retained fresh row",        remaining.length === 1 && remaining[0].path === "/new");
}

// ---- validation surface (read paths throw) -----------------------------

async function _validationSurface() {
  var f = _factory();

  // sessionPath
  await assert.rejects(f.cs.sessionPath(),                                                      /input object required/);
  await assert.rejects(f.cs.sessionPath({}),                                                    /session_id required/);
  await assert.rejects(f.cs.sessionPath({ session_id: "" }),                                    /session_id required/);
  await assert.rejects(f.cs.sessionPath({ session_id: "alice@example.com" }),                   /raw PII/);

  // topPages
  await assert.rejects(f.cs.topPages(),                                                         /input object required/);
  await assert.rejects(f.cs.topPages({ from: 100, to: 50 }),                                    /from must be strictly less than to/);
  await assert.rejects(f.cs.topPages({ from: -1, to: 100 }),                                    /from must be a non-negative integer/);
  await assert.rejects(f.cs.topPages({ from: 1, to: 1 + 2 * clickstream.ONE_YEAR_MS }),         /≤ 1 year/);
  await assert.rejects(f.cs.topPages({ from: 1, to: 2, limit: 0 }),                             /limit must be an integer/);
  await assert.rejects(f.cs.topPages({ from: 1, to: 2, limit: 9999 }),                          /limit must be an integer/);

  // topClicks
  await assert.rejects(f.cs.topClicks({ from: 1, to: 2, page_path: "" }),                       /page_path must be a non-empty string/);
  await assert.rejects(f.cs.topClicks({ from: 1, to: 2, page_path: "x".repeat(3000) }),         /page_path exceeds/);

  // funnelAnalysis
  await assert.rejects(f.cs.funnelAnalysis(),                                                   /input object required/);
  await assert.rejects(f.cs.funnelAnalysis({ steps: ["/only-one"], from: 1, to: 2 }),           /at least 2 patterns/);
  await assert.rejects(f.cs.funnelAnalysis({ steps: ["/a", ""], from: 1, to: 2 }),              /steps\[1\]/);
  var many = [];
  for (var s = 0; s < 20; s += 1) many.push("/s" + s);
  await assert.rejects(f.cs.funnelAnalysis({ steps: many, from: 1, to: 2 }),                    /steps exceeds/);

  // bouncerate
  await assert.rejects(f.cs.bouncerate(),                                                       /input object required/);
  await assert.rejects(f.cs.bouncerate({ from: 100, to: 50 }),                                  /from must be strictly less than to/);

  // dwellByPage
  await assert.rejects(f.cs.dwellByPage(),                                                      /input object required/);
  await assert.rejects(f.cs.dwellByPage({ from: 100, to: 50 }),                                 /from must be strictly less than to/);

  // cleanupOlderThan
  await assert.rejects(f.cs.cleanupOlderThan(),                                                 /days must be an integer/);
  await assert.rejects(f.cs.cleanupOlderThan(0),                                                /days must be an integer/);
  await assert.rejects(f.cs.cleanupOlderThan(99999),                                            /days must be an integer/);
  await assert.rejects(f.cs.cleanupOlderThan(1.5),                                              /days must be an integer/);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("UA_CLASSES exported",               Array.isArray(clickstream.UA_CLASSES)
                                              && clickstream.UA_CLASSES.indexOf("desktop") !== -1
                                              && clickstream.UA_CLASSES.indexOf("mobile")  !== -1
                                              && clickstream.UA_CLASSES.indexOf("tablet")  !== -1
                                              && clickstream.UA_CLASSES.indexOf("bot")     !== -1
                                              && clickstream.UA_CLASSES.indexOf("other")   !== -1);
  check("EVENT_KINDS exported",              Array.isArray(clickstream.EVENT_KINDS)
                                              && clickstream.EVENT_KINDS.indexOf("click")        !== -1
                                              && clickstream.EVENT_KINDS.indexOf("form_submit")  !== -1
                                              && clickstream.EVENT_KINDS.indexOf("form_abandon") !== -1
                                              && clickstream.EVENT_KINDS.indexOf("video_play")    !== -1
                                              && clickstream.EVENT_KINDS.indexOf("video_complete")!== -1
                                              && clickstream.EVENT_KINDS.indexOf("scroll_depth")  !== -1
                                              && clickstream.EVENT_KINDS.indexOf("dwell")         !== -1);
  check("SESSION_NAMESPACE exported",        typeof clickstream.SESSION_NAMESPACE === "string"
                                              && clickstream.SESSION_NAMESPACE.length > 0);
  check("CUSTOMER_NAMESPACE exported",       typeof clickstream.CUSTOMER_NAMESPACE === "string"
                                              && clickstream.CUSTOMER_NAMESPACE.length > 0);

  var inst = clickstream.create({ query: _makeQuery().query });
  check("instance exposes UA_CLASSES",       inst.UA_CLASSES.length === clickstream.UA_CLASSES.length);
  check("instance exposes EVENT_KINDS",      inst.EVENT_KINDS.length === clickstream.EVENT_KINDS.length);
}

async function run() {
  await _recordPageViewRoundTrip();
  await _recordPageViewDropSilent();
  await _recordEventEveryKind();
  await _recordEventDropSilent();
  await _sessionPathOrdering();
  await _topPagesAggregation();
  await _topClicksAggregation();
  await _funnelAnalysisRetention();
  await _bouncerateMath();
  await _dwellByPagePercentile();
  await _cleanupOlderThan();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - clickstream (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
