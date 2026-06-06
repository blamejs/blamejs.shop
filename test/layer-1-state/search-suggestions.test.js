"use strict";
/**
 * searchSuggestions — autocomplete dropdown data for the storefront
 * search input.
 *
 * Layer 1 against an in-memory node:sqlite database loaded from the
 * live migration files. Two migrations are mounted so the primitive's
 * `suggest` path can compose with the catalog primitive's
 * `products.search`:
 *
 *   - `0001_catalog.sql` (products table — feeds `suggest`'s product
 *     category via the catalog primitive)
 *   - `0030_search_suggestions.sql` (featured_search_suggestions +
 *     search_query_log — owned by this primitive)
 *
 * Coverage:
 *   - recordQuery: normalises q (lowercase + trim), hashes
 *     session_id, persists with result_count + occurred_at
 *   - suggest: returns the three category arrays in shape; product
 *     matches flow through the catalog primitive; popular queries
 *     are aggregated from the log; featured rows respect the
 *     (status, starts_at, expires_at) window
 *   - addFeatured / updateFeatured / deleteFeatured: insert,
 *     partial update, delete
 *   - popularQueries: aggregation with from/to window + zero-result
 *     share
 *   - cleanupOldQueries: retention sweep deletes rows < ts
 *   - refusals: empty q, missing session_id, oversize q, bad
 *     result_count, bad limit, javascript: scheme on featured rows,
 *     bad epoch-ms, expires_at <= starts_at, control bytes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0030_search_suggestions.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _setup(opts) {
  opts = opts || {};
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var ss      = bShop.searchSuggestions.create({
    query:   query,
    catalog: opts.skipCatalog ? null : catalog,
  });
  return { query: query, catalog: catalog, ss: ss };
}

async function _recordQueryHashesAndNormalises() {
  var ctx = await _setup();
  var r = await ctx.ss.recordQuery({
    q:            "  Blue WIDGET  ",
    session_id:   "session-abc-123",
    result_count: 3,
  });
  check("recordQuery: returns id",                  typeof r.id === "string" && r.id.length === 36);

  var rows = (await ctx.query("SELECT * FROM search_query_log", [])).rows;
  check("recordQuery: persisted one row",            rows.length === 1);
  check("recordQuery: normalises q (lowercase+trim)",rows[0].query_normalized === "blue widget");
  check("recordQuery: stores result_count",          Number(rows[0].result_count) === 3);
  check("recordQuery: stores occurred_at as ms",     Number.isInteger(rows[0].occurred_at) && rows[0].occurred_at > 0);

  // session_id is hashed — the raw string never reaches the row,
  // and the hash output is namespaceHash-shaped (hex). Re-record
  // the same session yields the same hash so the operator can
  // group activity from one session without storing the raw id.
  check("recordQuery: hashes session_id (no raw id in row)",
    rows[0].session_id_hash !== "session-abc-123" && rows[0].session_id_hash.length >= 32);
  check("recordQuery: hash is hex",                  /^[0-9a-f]+$/.test(rows[0].session_id_hash));

  await ctx.ss.recordQuery({ q: "red", session_id: "session-abc-123", result_count: 0 });
  var both = (await ctx.query("SELECT session_id_hash FROM search_query_log ORDER BY occurred_at ASC", [])).rows;
  check("recordQuery: same session_id => same hash", both[0].session_id_hash === both[1].session_id_hash);
}

async function _suggestReturnsThreeArrays() {
  var ctx = await _setup();

  // Seed two active products that match the prefix.
  await ctx.catalog.products.create({ slug: "blue-widget",  title: "Blue Widget",  description: "A sturdy widget in cobalt blue.", status: "active" });
  await ctx.catalog.products.create({ slug: "blueberry-jam", title: "Blueberry Jam", description: "Homemade preserves.",            status: "active" });
  await ctx.catalog.products.create({ slug: "red-widget",   title: "Red Widget",   description: "A sturdy widget in crimson red.",  status: "active" });

  // Seed popular-query log rows — "blue widget" twice, "blue
  // jeans" once. All inside the 30-day window.
  for (var i = 0; i < 2; i += 1) {
    await ctx.ss.recordQuery({ q: "blue widget", session_id: "sess-" + i, result_count: 1 });
  }
  await ctx.ss.recordQuery({ q: "blue jeans", session_id: "sess-x", result_count: 0 });
  // A query that doesn't share the prefix shouldn't surface
  await ctx.ss.recordQuery({ q: "red shirt", session_id: "sess-y", result_count: 1 });

  // Seed a featured row that triggers on "blue".
  await ctx.ss.addFeatured({
    prefix:       "blue",
    display_text: "Shop the blue collection",
    link_url:     "/collections/blue",
    priority:     5,
  });

  var out = await ctx.ss.suggest({ q: "blue", limit: 5 });
  check("suggest: products is an array",  Array.isArray(out.products));
  check("suggest: queries is an array",   Array.isArray(out.queries));
  check("suggest: featured is an array",  Array.isArray(out.featured));

  // products — two matches (blue-widget + blueberry-jam), neither
  // includes the red one
  check("suggest: returns 2 product matches", out.products.length === 2);
  var slugs = out.products.map(function (p) { return p.slug; }).sort();
  check("suggest: product slugs include blue-widget + blueberry-jam",
    slugs.indexOf("blue-widget") !== -1 && slugs.indexOf("blueberry-jam") !== -1);

  // queries — "blue widget" (count 2) ranks before "blue jeans"
  check("suggest: returns 2 popular queries", out.queries.length === 2);
  check("suggest: popular query sorted by count desc",
    out.queries[0].query_normalized === "blue widget" && out.queries[0].count === 2);
  check("suggest: popular query has last_seen",
    Number.isInteger(out.queries[0].last_seen) && out.queries[0].last_seen > 0);

  // featured — the active row surfaces
  check("suggest: returns the featured row",  out.featured.length === 1);
  check("suggest: featured row display_text", out.featured[0].display_text === "Shop the blue collection");
  check("suggest: featured row link_url",     out.featured[0].link_url === "/collections/blue");
  check("suggest: featured priority numeric", out.featured[0].priority === 5);

  // Limit honoured per-category
  var trimmed = await ctx.ss.suggest({ q: "blue", limit: 1 });
  check("suggest: limit honoured for products", trimmed.products.length === 1);
  check("suggest: limit honoured for queries",  trimmed.queries.length === 1);
  check("suggest: limit honoured for featured", trimmed.featured.length === 1);

  // listFeatured — the console read: full set regardless of status or
  // schedule window (suggest() is prefix-scoped + active-only), reading
  // through the SAME injected query handle the writes used.
  var drafted = await ctx.ss.addFeatured({
    prefix: "zzz", display_text: "Draft row", link_url: "/collections/zzz",
  });
  await ctx.ss.updateFeatured(drafted.id, { status: "draft", priority: 9 });
  var all = await ctx.ss.listFeatured({});
  check("listFeatured: returns every row regardless of status", all.length === 2);
  check("listFeatured: priority-desc ordering", all[0].priority === 9 && all[1].priority === 5);
  check("listFeatured: carries the full curation shape",
    all[0].prefix === "zzz" && all[0].status === "draft" &&
    typeof all[0].id === "string" && Number.isInteger(all[0].created_at));
  var paged = await ctx.ss.listFeatured({ limit: 1, offset: 1 });
  check("listFeatured: limit + offset page the set", paged.length === 1 && paged[0].priority === 5);
  var badLimit = null;
  try { await ctx.ss.listFeatured({ limit: 0 }); } catch (e) { badLimit = e; }
  check("listFeatured: limit 0 refused with TypeError", badLimit instanceof TypeError);

  // Default limit (no opts)
  var def = await ctx.ss.suggest({ q: "blue" });
  check("suggest: default limit works", def.products.length >= 1 && def.queries.length >= 1);
}

async function _suggestFeaturedWindowing() {
  var ctx = await _setup();
  var now = Date.now();

  // Active, in-window
  var live = await ctx.ss.addFeatured({
    prefix: "free", display_text: "Free shipping over $50", link_url: "/shipping", priority: 10,
    starts_at: now - 1000, expires_at: now + 86400000,
  });
  // Future starts_at — not yet visible
  await ctx.ss.addFeatured({
    prefix: "free", display_text: "Upcoming promo", link_url: "/promo",
    starts_at: now + 86400000,
  });
  // Expired
  await ctx.ss.addFeatured({
    prefix: "free", display_text: "Old promo", link_url: "/old",
    starts_at: now - 86400000, expires_at: now - 1000,
  });
  // Draft (status filter excludes)
  await ctx.ss.addFeatured({
    prefix: "free", display_text: "Authoring", link_url: "/draft", status: "draft",
  });

  var out = await ctx.ss.suggest({ q: "free", limit: 10 });
  check("suggest: featured filters active+in-window only",
    out.featured.length === 1 && out.featured[0].id === live.id);

  // Prefix-extension match — typing "f" should also surface the
  // row whose prefix is "free" (it's an unambiguous extension)
  var partial = await ctx.ss.suggest({ q: "f", limit: 10 });
  check("suggest: featured surfaces on prefix-extension match",
    partial.featured.some(function (r) { return r.id === live.id; }));
}

async function _addUpdateDeleteFeatured() {
  var ctx = await _setup();
  var added = await ctx.ss.addFeatured({
    prefix: "sale", display_text: "Summer sale", link_url: "/sale", priority: 3,
  });
  check("addFeatured: returns row with id",       typeof added.id === "string" && added.id.length === 36);
  check("addFeatured: stores prefix lowercased",  added.prefix === "sale");
  check("addFeatured: stores display_text",       added.display_text === "Summer sale");
  check("addFeatured: stores link_url",           added.link_url === "/sale");
  check("addFeatured: default status active",     added.status === "active");
  check("addFeatured: priority stored",           Number(added.priority) === 3);
  check("addFeatured: stamps created_at==updated_at", added.created_at === added.updated_at);

  // Partial update: change display_text + priority, leave other fields
  var updated = await ctx.ss.updateFeatured(added.id, { display_text: "Winter sale", priority: 7 });
  check("updateFeatured: display_text patched",   updated.display_text === "Winter sale");
  check("updateFeatured: priority patched",       Number(updated.priority) === 7);
  check("updateFeatured: link_url preserved",     updated.link_url === "/sale");
  check("updateFeatured: updated_at advanced",    updated.updated_at >= added.updated_at);

  // Update status to expired
  var expired = await ctx.ss.updateFeatured(added.id, { status: "expired" });
  check("updateFeatured: status -> expired",      expired.status === "expired");

  // Empty patch refused
  await assert.rejects(ctx.ss.updateFeatured(added.id, {}), /no updatable fields/);

  // Update non-existent id returns null
  var missing = await ctx.ss.updateFeatured("00000000-0000-7000-8000-000000000000", { priority: 1 });
  check("updateFeatured: returns null for unknown id", missing === null);

  // Delete
  var del = await ctx.ss.deleteFeatured(added.id);
  check("deleteFeatured: removed=true on hit",    del.removed === true);
  var delAgain = await ctx.ss.deleteFeatured(added.id);
  check("deleteFeatured: removed=false on miss",  delAgain.removed === false);
}

async function _popularQueriesAggregation() {
  var ctx = await _setup();
  var now = Date.now();

  // Six rows for "popular term" (5 with hits, 1 zero-result), three
  // rows for "other term" (all zero-result).
  for (var i = 0; i < 5; i += 1) {
    await ctx.ss.recordQuery({ q: "popular term", session_id: "s-" + i, result_count: 2 });
  }
  await ctx.ss.recordQuery({ q: "popular term", session_id: "s-z", result_count: 0 });
  for (var j = 0; j < 3; j += 1) {
    await ctx.ss.recordQuery({ q: "other term", session_id: "o-" + j, result_count: 0 });
  }

  var rows = await ctx.ss.popularQueries({ from: now - 60000, to: now + 60000, limit: 10 });
  check("popularQueries: returns 2 rows",            rows.length === 2);
  check("popularQueries: sorted by count desc",      rows[0].query_normalized === "popular term" && rows[0].count === 6);
  check("popularQueries: tracks zero_result_share",  Math.abs(rows[0].zero_result_share - (1 / 6)) < 1e-9);
  check("popularQueries: other-term zero share is 1", rows[1].query_normalized === "other term" && rows[1].zero_result_share === 1);
  check("popularQueries: last_seen present",         Number.isInteger(rows[0].last_seen) && rows[0].last_seen > 0);

  // Default window (no from/to) returns within 30 days
  var def = await ctx.ss.popularQueries();
  check("popularQueries: default window returns 2 rows", def.length === 2);

  // Limit honoured
  var oneRow = await ctx.ss.popularQueries({ limit: 1 });
  check("popularQueries: limit honoured",            oneRow.length === 1);

  // to < from rejected
  await assert.rejects(ctx.ss.popularQueries({ from: now, to: now - 1000 }), /to must be/);
}

async function _cleanupOldQueries() {
  var ctx = await _setup();
  var now = Date.now();

  await ctx.ss.recordQuery({ q: "old", session_id: "s-old", result_count: 1 });
  await ctx.ss.recordQuery({ q: "new", session_id: "s-new", result_count: 1 });

  // Force the "old" row's occurred_at into the past
  await ctx.query(
    "UPDATE search_query_log SET occurred_at = ?1 WHERE query_normalized = 'old'",
    [now - 1000000],
  );

  var swept = await ctx.ss.cleanupOldQueries(now - 1000);
  check("cleanupOldQueries: removed the old row",   swept.removed === 1);

  var left = (await ctx.query("SELECT query_normalized FROM search_query_log", [])).rows;
  check("cleanupOldQueries: new row remains",       left.length === 1 && left[0].query_normalized === "new");

  // Bad ts refused
  await assert.rejects(ctx.ss.cleanupOldQueries(-1),       /ts must be/);
  await assert.rejects(ctx.ss.cleanupOldQueries("nope"),   /ts must be/);
  await assert.rejects(ctx.ss.cleanupOldQueries(1.5),      /ts must be/);
}

async function _refusals() {
  var ctx = await _setup();

  // recordQuery refusals
  await assert.rejects(ctx.ss.recordQuery(),                                                     /input object required/);
  await assert.rejects(ctx.ss.recordQuery({ session_id: "s" }),                                  /q must be/);
  await assert.rejects(ctx.ss.recordQuery({ q: "",          session_id: "s" }),                  /q must be/);
  await assert.rejects(ctx.ss.recordQuery({ q: "   ",       session_id: "s" }),                  /q must be/);
  await assert.rejects(ctx.ss.recordQuery({ q: "ok",        session_id: "" }),                   /session_id/);
  await assert.rejects(ctx.ss.recordQuery({ q: "ok" }),                                          /session_id/);
  await assert.rejects(ctx.ss.recordQuery({ q: 42,          session_id: "s" }),                  /q must be a string/);
  await assert.rejects(ctx.ss.recordQuery({ q: "ok\nbad",   session_id: "s" }),                  /control bytes/);
  await assert.rejects(ctx.ss.recordQuery({ q: "ok",        session_id: "s", result_count: -1 }), /result_count/);
  await assert.rejects(ctx.ss.recordQuery({ q: "ok",        session_id: "s", result_count: 1.5 }), /result_count/);
  await assert.rejects(ctx.ss.recordQuery({ q: "ok",        session_id: "s", result_count: "no" }), /result_count/);
  var huge = new Array(MaxLenPlus()).join("x");
  await assert.rejects(ctx.ss.recordQuery({ q: huge,         session_id: "s" }),                 /q must be/);

  // suggest refusals — empty q, bad limit
  await assert.rejects(ctx.ss.suggest({ q: "" }),                                                /q must be/);
  await assert.rejects(ctx.ss.suggest({ q: "ok", limit: 0 }),                                    /limit/);
  await assert.rejects(ctx.ss.suggest({ q: "ok", limit: 9999 }),                                 /limit/);
  await assert.rejects(ctx.ss.suggest({ q: "ok", limit: 1.5 }),                                  /limit/);

  // addFeatured refusals
  await assert.rejects(ctx.ss.addFeatured(),                                                     /input object required/);
  await assert.rejects(ctx.ss.addFeatured({}),                                                   /prefix/);
  await assert.rejects(ctx.ss.addFeatured({ prefix: "ok" }),                                     /display_text/);
  await assert.rejects(ctx.ss.addFeatured({ prefix: "ok", display_text: "x" }),                  /link_url/);
  // javascript: scheme refused — script-in-href XSS defense
  await assert.rejects(
    ctx.ss.addFeatured({ prefix: "ok", display_text: "x", link_url: "javascript:alert(1)" }),
    /link_url scheme/,
  );
  await assert.rejects(
    ctx.ss.addFeatured({ prefix: "ok", display_text: "x", link_url: "data:text/html,evil" }),
    /link_url scheme/,
  );
  // expires_at <= starts_at refused
  await assert.rejects(
    ctx.ss.addFeatured({ prefix: "ok", display_text: "x", link_url: "/y", starts_at: 1000, expires_at: 500 }),
    /expires_at/,
  );
  // bad status enum refused
  await assert.rejects(
    ctx.ss.addFeatured({ prefix: "ok", display_text: "x", link_url: "/y", status: "junk" }),
    /status must be/,
  );
  // priority negative refused
  await assert.rejects(
    ctx.ss.addFeatured({ prefix: "ok", display_text: "x", link_url: "/y", priority: -1 }),
    /priority/,
  );

  // updateFeatured refusals
  await assert.rejects(ctx.ss.updateFeatured("",   { priority: 1 }),                             /id must be/);
  await assert.rejects(ctx.ss.updateFeatured("id", null),                                        /patch object required/);
  await assert.rejects(ctx.ss.updateFeatured("id", { status: "junk" }),                          /status must be/);

  // deleteFeatured refusals
  await assert.rejects(ctx.ss.deleteFeatured(""),                                                /id must be/);
  await assert.rejects(ctx.ss.deleteFeatured(42),                                                /id must be/);
}

// 201-char string for the over-length q refusal
function MaxLenPlus() { return 202; }

async function run() {
  await _recordQueryHashesAndNormalises();
  await _suggestReturnsThreeArrays();
  await _suggestFeaturedWindowing();
  await _addUpdateDeleteFeatured();
  await _popularQueriesAggregation();
  await _cleanupOldQueries();
  await _refusals();
}

module.exports = { run: run };
