"use strict";
/**
 * mailingAudiences — operator-defined newsletter segmentation.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations 0010
 * (newsletter_signups) + 0028 (email_suppressions) + 0056 (mailing
 * audiences). The 0056 migration extends `newsletter_signups`
 * additively with the columns the audience rules filter on
 * (`tags_csv`, `country`, `language`, `customer_status`,
 * `double_opt_in_at`).
 *
 * Coverage:
 *   - defineAudience: happy path + upsert refresh
 *   - rule combinations: subscribed_at window, source_in,
 *     tag_any / tag_all, country_in, double_opt_in, language_in,
 *     customer_status_in
 *   - resolve: hashes always, plaintext only on include_plaintext,
 *     suppression filter when emailSuppressions injected
 *   - recompute: cache freshness — new signup not visible until
 *     recompute runs
 *   - cursor pagination: round-trip + cross-secret tamper refusal
 *   - update / archive / listAudiences include_archived
 *   - auditDelivery + listDeliveries
 *   - refusals: bad slug, bad rules, unknown rule key, archived
 *     audience refuses resolve / update
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var mailingAudiences  = require("../../lib/mailing-audiences");
var newsletterMod     = require("../../lib/newsletter");
var emailSuppressMod  = require("../../lib/email-suppressions");
var helpers           = require("../helpers");
var check             = helpers.check;
var assert            = helpers.assert;

var MIG_SIGNUPS      = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0010_newsletter_signups.sql");
var MIG_SUPPRESSIONS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0028_email_suppressions.sql");
var MIG_AUDIENCES    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0056_mailing_audiences.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  var schemas = [
    nodeFs.readFileSync(MIG_SIGNUPS,      "utf8"),
    nodeFs.readFileSync(MIG_SUPPRESSIONS, "utf8"),
    nodeFs.readFileSync(MIG_AUDIENCES,    "utf8"),
  ];
  schemas.forEach(function (text) {
    _splitSchema(text).forEach(function (s) { db.prepare(s).run(); });
  });
  var raw = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  raw._db = db;
  return raw;
}

// Seed N newsletter_signups rows directly so the test can populate
// the audience-filterable columns the public `newsletter.signup`
// surface doesn't expose. Returns the signup row ids in insertion
// order so the test can correlate audience membership against the
// known shape.
async function _seedSignup(query, attrs) {
  var id    = attrs.id || ("sig-" + Math.random().toString(36).slice(2));
  var hash  = attrs.email_hash || ("hash-" + id);
  var email = attrs.email || (id + "@example.com");
  await query(
    "INSERT INTO newsletter_signups " +
    "(id, email_hash, email_normalized, source, created_at, unsubscribed_at, " +
    "tags_csv, country, language, customer_status, double_opt_in_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    [
      id, hash, email,
      attrs.source           || "storefront-footer",
      attrs.created_at       || Date.now(),
      attrs.unsubscribed_at  != null ? attrs.unsubscribed_at : null,
      attrs.tags_csv         != null ? attrs.tags_csv        : "",
      attrs.country          != null ? attrs.country         : null,
      attrs.language         != null ? attrs.language        : null,
      attrs.customer_status  != null ? attrs.customer_status : null,
      attrs.double_opt_in_at != null ? attrs.double_opt_in_at : null,
    ],
  );
  return { id: id, email_hash: hash, email_normalized: email };
}

function _factory(query, opts) {
  opts = opts || {};
  return mailingAudiences.create({
    query:             query,
    newsletter:        opts.newsletter || null,
    emailSuppressions: opts.emailSuppressions || null,
    cursorSecret:      opts.cursorSecret,
  });
}

async function _defineAudienceHappyPath() {
  var query = _makeQuery();
  var aud   = _factory(query);

  var rv = await aud.defineAudience({
    slug:  "release-watchers",
    title: "Release watchers",
    rules: {
      subscribed_after: 1,
      source_in:        ["storefront-footer", "release-notes-page"],
      tag_any:          ["release-notes"],
      double_opt_in:    true,
    },
  });
  check("define returns slug",            rv.slug === "release-watchers");
  check("define returns title",           rv.title === "Release watchers");
  check("define returns status 'new'",    rv.status === "new");
  check("define normalises rules",        rv.rules.subscribed_after === 1);
  check("define dedupes source_in",       rv.rules.source_in.length === 2);
  check("define archived_at NULL",        rv.archived_at === null);
  check("define created_at populated",    Number.isInteger(rv.created_at) && rv.created_at > 0);
  check("define updated_at == created_at on new", rv.updated_at === rv.created_at);

  // Re-define same slug → upsert, status 'updated', created_at sticky.
  await new Promise(function (r) { setImmediate(r); });
  var rv2 = await aud.defineAudience({
    slug:  "release-watchers",
    title: "Release watchers (revised)",
    rules: { subscribed_after: 100 },
  });
  check("re-define status 'updated'",     rv2.status === "updated");
  check("re-define title refreshed",      rv2.title === "Release watchers (revised)");
  check("re-define created_at sticky",    rv2.created_at === rv.created_at);
  check("re-define updated_at advanced",  rv2.updated_at >= rv.updated_at);
  check("re-define rules replaced",       rv2.rules.subscribed_after === 100 && rv2.rules.source_in === undefined);

  // getAudience returns the parsed rules.
  var got = await aud.getAudience("release-watchers");
  check("getAudience returns row",        got && got.slug === "release-watchers");
  check("getAudience parsed rules",       got.rules.subscribed_after === 100);
  check("getAudience miss → null",        (await aud.getAudience("missing")) === null);

  // listAudiences active by default.
  var list = await aud.listAudiences();
  check("listAudiences returns 1 active", list.length === 1 && list[0].slug === "release-watchers");
}

async function _ruleCombinations() {
  var query = _makeQuery();
  var aud   = _factory(query);

  var now = Date.now();
  // Spread a 5-row population across every rule axis.
  await _seedSignup(query, {
    id: "a", email_hash: "h-a", email: "a@example.com",
    source: "storefront-footer",
    created_at: now - 30 * 86400000,
    tags_csv:   "release-notes,security",
    country:    "DE", language: "de",
    customer_status: "active",
    double_opt_in_at: now - 29 * 86400000,
  });
  await _seedSignup(query, {
    id: "b", email_hash: "h-b", email: "b@example.com",
    source: "release-notes-page",
    created_at: now - 10 * 86400000,
    tags_csv:   "release-notes",
    country:    "GB", language: "en-GB",
    customer_status: "active",
    double_opt_in_at: now - 9 * 86400000,
  });
  await _seedSignup(query, {
    id: "c", email_hash: "h-c", email: "c@example.com",
    source: "storefront-footer",
    created_at: now - 400 * 86400000,            // old signup
    tags_csv:   "promo",
    country:    "US", language: "en-US",
    customer_status: "lapsed",
    double_opt_in_at: null,                       // not double-opted-in
  });
  await _seedSignup(query, {
    id: "d", email_hash: "h-d", email: "d@example.com",
    source: "wishlist-signup",
    created_at: now - 5 * 86400000,
    tags_csv:   "security,vip",
    country:    "FR", language: "fr",
    customer_status: "active",
    double_opt_in_at: now - 4 * 86400000,
  });
  await _seedSignup(query, {
    id: "e", email_hash: "h-e", email: "e@example.com",
    source: "storefront-footer",
    created_at: now - 1 * 86400000,
    tags_csv:   "release-notes,vip",
    country:    "DE", language: "de",
    customer_status: "active",
    double_opt_in_at: now - 1 * 3600000,
    unsubscribed_at:  now - 1 * 3600000,          // unsubscribed → never a member
  });

  // Audience 1 — recent + EU + double-opt-in + tag 'release-notes'.
  await aud.defineAudience({
    slug:  "eu-release",
    title: "EU release watchers",
    rules: {
      subscribed_after: now - 60 * 86400000,
      country_in:       ["DE", "GB", "FR", "NL"],
      double_opt_in:    true,
      tag_any:          ["release-notes"],
    },
  });

  // Audience 2 — all-tag intersection: must have BOTH security AND vip.
  await aud.defineAudience({
    slug:  "vip-security",
    title: "VIP security watchers",
    rules: { tag_all: ["security", "vip"] },
  });

  // Audience 3 — lapsed customers.
  await aud.defineAudience({
    slug:  "lapsed-reactivation",
    title: "Lapsed reactivation",
    rules: { customer_status_in: ["lapsed"] },
  });

  // Recompute populates the membership cache.
  var rc = await aud.recompute();
  check("recompute summary surfaces eu-release",   rc.counts["eu-release"] === 2); // a, b
  check("recompute summary surfaces vip-security", rc.counts["vip-security"] === 1); // d
  check("recompute summary surfaces lapsed",       rc.counts["lapsed-reactivation"] === 1); // c
  check("recompute refreshed_at populated",        Number.isInteger(rc.refreshed_at) && rc.refreshed_at > 0);

  // Counts via cached path.
  check("count(eu-release) = 2",               (await aud.count("eu-release")) === 2);
  check("count(vip-security) = 1",             (await aud.count("vip-security")) === 1);
  check("count(lapsed-reactivation) = 1",      (await aud.count("lapsed-reactivation")) === 1);

  // Resolve eu-release — hashes only by default.
  var euPage = await aud.resolve({ slug: "eu-release", limit: 10 });
  check("eu-release resolve emits 2 hashes",   euPage.emails_hashed.length === 2);
  check("eu-release resolve plaintext empty",  euPage.emails_normalised.length === 0);
  check("eu-release resolve cursor null",      euPage.next_cursor === null);
  var euHashesSorted = euPage.emails_hashed.slice().sort();
  check("eu-release resolve hashes are a,b",   euHashesSorted[0] === "h-a" && euHashesSorted[1] === "h-b");
  check("eu-release excludes lapsed/wrong-tag", euHashesSorted.indexOf("h-c") === -1 && euHashesSorted.indexOf("h-d") === -1);
  check("eu-release excludes unsubscribed",    euHashesSorted.indexOf("h-e") === -1);

  // Resolve with plaintext flag.
  var euPlain = await aud.resolve({
    slug: "eu-release", limit: 10, include_plaintext: true,
  });
  check("plaintext resolve emits 2 emails",    euPlain.emails_normalised.length === 2);
  var emailsSorted = euPlain.emails_normalised.slice().sort();
  check("plaintext emails are a,b",            emailsSorted[0] === "a@example.com" && emailsSorted[1] === "b@example.com");

  // tag_all narrows tighter than tag_any.
  var vipPage = await aud.resolve({ slug: "vip-security", limit: 10 });
  check("vip-security resolve emits 1 hash",   vipPage.emails_hashed.length === 1);
  check("vip-security hash is d",              vipPage.emails_hashed[0] === "h-d");

  // customer_status filter.
  var lapsedPage = await aud.resolve({ slug: "lapsed-reactivation", limit: 10 });
  check("lapsed-reactivation emits 1 hash",    lapsedPage.emails_hashed.length === 1);
  check("lapsed-reactivation hash is c",       lapsedPage.emails_hashed[0] === "h-c");

  // Language filter — separate audience.
  await aud.defineAudience({
    slug:  "de-only",
    title: "DE-only",
    rules: { language_in: ["de"] },
  });
  await aud.recompute();
  var dePage = await aud.resolve({ slug: "de-only", limit: 10 });
  check("language_in narrows to de",           dePage.emails_hashed.length === 1 && dePage.emails_hashed[0] === "h-a");
}

async function _resolveWithSuppression() {
  var query = _makeQuery();
  var supp  = emailSuppressMod.create({ query: query });
  var aud   = _factory(query, { emailSuppressions: supp });

  var now = Date.now();
  await _seedSignup(query, {
    id: "x", email_hash: "h-x", email: "x@example.com",
    source: "storefront-footer", created_at: now - 86400000,
    tags_csv: "release", double_opt_in_at: now,
  });
  await _seedSignup(query, {
    id: "y", email_hash: "h-y", email: "y@example.com",
    source: "storefront-footer", created_at: now - 86400000,
    tags_csv: "release", double_opt_in_at: now,
  });
  await _seedSignup(query, {
    id: "z", email_hash: "h-z", email: "z@example.com",
    source: "storefront-footer", created_at: now - 86400000,
    tags_csv: "release", double_opt_in_at: now,
  });

  // Suppress y under marketing scope.
  await supp.add({
    email:            "y@example.com",
    suppression_type: "unsubscribe",
  });
  // Suppress z under transactional scope — should NOT filter the
  // marketing-scope resolve.
  await supp.add({
    email:            "z@example.com",
    suppression_type: "hard-bounce",
    scope:            "transactional",
  });

  await aud.defineAudience({
    slug:  "all-release",
    title: "All release-tagged",
    rules: { tag_any: ["release"] },
  });
  await aud.recompute();

  // Default: skip_suppressed = true.
  var page = await aud.resolve({ slug: "all-release", limit: 10 });
  check("suppression filter drops marketing-suppressed y", page.emails_hashed.indexOf("h-y") === -1);
  check("suppression filter keeps transactional-only z",    page.emails_hashed.indexOf("h-z") !== -1);
  check("suppression filter keeps unfiltered x",            page.emails_hashed.indexOf("h-x") !== -1);
  check("page.suppressed_count = 1",                        page.suppressed_count === 1);

  // skip_suppressed: false → bypass filter.
  var unfiltered = await aud.resolve({
    slug: "all-release", limit: 10, skip_suppressed: false,
  });
  check("skip_suppressed=false includes y",                 unfiltered.emails_hashed.indexOf("h-y") !== -1);
  check("skip_suppressed=false suppressed_count = 0",       unfiltered.suppressed_count === 0);

  // No emailSuppressions handle → filter is a no-op.
  var bare = _factory(query);
  var bareDef = await bare.resolve({ slug: "all-release", limit: 10 });
  check("no-handle resolve includes y",                     bareDef.emails_hashed.indexOf("h-y") !== -1);
  check("no-handle suppressed_count = 0",                   bareDef.suppressed_count === 0);
}

async function _recomputeCacheFreshness() {
  var query = _makeQuery();
  var aud   = _factory(query);
  var now   = Date.now();

  await _seedSignup(query, {
    id: "early", email_hash: "h-early", email: "early@example.com",
    created_at: now - 30 * 86400000, tags_csv: "newsletter",
  });

  await aud.defineAudience({
    slug:  "newsletter-tag",
    title: "Newsletter tag",
    rules: { tag_any: ["newsletter"] },
  });
  await aud.recompute();
  check("pre-add: 1 member",               (await aud.count("newsletter-tag")) === 1);

  // New signup lands AFTER the recompute — cache is stale.
  await _seedSignup(query, {
    id: "late", email_hash: "h-late", email: "late@example.com",
    created_at: now, tags_csv: "newsletter",
  });
  // Cache still 1 — recompute hasn't run.
  check("stale cache: still 1 member",     (await aud.count("newsletter-tag")) === 1);
  var stalePage = await aud.resolve({ slug: "newsletter-tag", limit: 10 });
  check("stale resolve excludes late add", stalePage.emails_hashed.indexOf("h-late") === -1);

  // Recompute → cache reflects the new signup.
  await aud.recompute();
  check("fresh cache: 2 members",          (await aud.count("newsletter-tag")) === 2);
  var freshPage = await aud.resolve({ slug: "newsletter-tag", limit: 10 });
  check("fresh resolve includes late add", freshPage.emails_hashed.indexOf("h-late") !== -1);

  // Unsubscribe the early signup → recompute drops it.
  await query(
    "UPDATE newsletter_signups SET unsubscribed_at = ?1 WHERE id = ?2",
    [Date.now(), "early"],
  );
  await aud.recompute();
  check("unsubscribed signup dropped",     (await aud.count("newsletter-tag")) === 1);
  var postUnsub = await aud.resolve({ slug: "newsletter-tag", limit: 10 });
  check("post-unsub resolve excludes early", postUnsub.emails_hashed.indexOf("h-early") === -1);
}

async function _cursorPagination() {
  var query = _makeQuery();
  var aud   = _factory(query);
  var now   = Date.now();

  // Seed 5 signups under a uniform rule.
  for (var i = 0; i < 5; i += 1) {
    await _seedSignup(query, {
      id: "p" + i, email_hash: "h-p" + i, email: ("p" + i) + "@example.com",
      created_at: now - i * 86400000,
      tags_csv:   "page",
    });
  }
  await aud.defineAudience({
    slug:  "page-test",
    title: "Pagination test",
    rules: { tag_any: ["page"] },
  });
  await aud.recompute();

  // Single page (limit > population).
  var full = await aud.resolve({ slug: "page-test", limit: 100 });
  check("full page returns 5 rows",        full.emails_hashed.length === 5);
  check("full page next_cursor null",      full.next_cursor === null);

  // Paginate 2 + 2 + 1.
  var p1 = await aud.resolve({ slug: "page-test", limit: 2 });
  check("page-1 has 2 rows",               p1.emails_hashed.length === 2);
  check("page-1 cursor is string",         typeof p1.next_cursor === "string");

  var p2 = await aud.resolve({ slug: "page-test", limit: 2, cursor: p1.next_cursor });
  check("page-2 has 2 rows",               p2.emails_hashed.length === 2);
  check("page-2 cursor is string",         typeof p2.next_cursor === "string");
  check("page-2 distinct from page-1",     p2.emails_hashed[0] !== p1.emails_hashed[0]);

  var p3 = await aud.resolve({ slug: "page-test", limit: 2, cursor: p2.next_cursor });
  check("page-3 has 1 row (residual)",     p3.emails_hashed.length === 1);
  check("page-3 cursor is null",           p3.next_cursor === null);

  // Combine pages → full population, no dupes.
  var combined = p1.emails_hashed.concat(p2.emails_hashed).concat(p3.emails_hashed).sort();
  check("paginated combined = 5 unique",   combined.length === 5 && combined.filter(function (v, idx) { return combined.indexOf(v) === idx; }).length === 5);

  // Cross-secret tamper → refused.
  var tampered = (p1.next_cursor.charAt(0) === "A" ? "B" : "A") + p1.next_cursor.slice(1);
  await assert.rejects(
    aud.resolve({ slug: "page-test", limit: 2, cursor: tampered }),
    /cursor/i
  );
}

async function _updateArchiveAndList() {
  var query = _makeQuery();
  var aud   = _factory(query);

  await aud.defineAudience({
    slug:  "to-edit",
    title: "Original",
    rules: { source_in: ["storefront-footer"] },
  });
  await aud.defineAudience({
    slug:  "to-archive",
    title: "Archived candidate",
    rules: { source_in: ["wishlist"] },
  });

  // update with partial patch — title only.
  await new Promise(function (r) { setImmediate(r); });
  var updTitle = await aud.update("to-edit", { title: "Renamed" });
  check("update title-only refreshed",     updTitle.title === "Renamed");
  check("update preserves rules",          updTitle.rules.source_in[0] === "storefront-footer");

  // update with rules-only patch.
  var updRules = await aud.update("to-edit", {
    rules: { source_in: ["release-notes-page"], double_opt_in: true },
  });
  check("update rules-only refreshed",     updRules.rules.source_in[0] === "release-notes-page");
  check("update preserves title",          updRules.title === "Renamed");
  check("update double_opt_in stored",     updRules.rules.double_opt_in === true);

  // archive flips archived_at.
  var arch = await aud.archive("to-archive");
  check("archive returns archived_at",     Number.isInteger(arch.archived_at));
  check("archive status 'archived'",       arch.status === "archived");

  // listAudiences default hides archived.
  var defaultList = await aud.listAudiences();
  check("default listAudiences hides archived",
    defaultList.length === 1 && defaultList[0].slug === "to-edit");
  var withArchived = await aud.listAudiences({ include_archived: true });
  check("listAudiences include_archived shows both",
    withArchived.length === 2);

  // Re-archive → 'already-archived' status, no rewrite.
  var rearch = await aud.archive("to-archive");
  check("re-archive status already-archived", rearch.status === "already-archived");

  // archived audience refuses resolve.
  await assert.rejects(
    aud.resolve({ slug: "to-archive" }),
    /archived/
  );
  // archived audience refuses update — operator un-archives via defineAudience.
  await assert.rejects(
    aud.update("to-archive", { title: "Reactivated?" }),
    /archived/
  );
  // defineAudience un-archives + replaces rules.
  await new Promise(function (r) { setImmediate(r); });
  var revived = await aud.defineAudience({
    slug:  "to-archive",
    title: "Reactivated",
    rules: { source_in: ["wishlist"] },
  });
  check("defineAudience revives archived",  revived.archived_at === null);
  check("revive status 'updated'",          revived.status === "updated");
}

async function _auditDeliveryLog() {
  var query = _makeQuery();
  var aud   = _factory(query);

  await aud.defineAudience({
    slug:  "audited",
    title: "Audited",
    rules: { source_in: ["storefront-footer"] },
  });

  var d1 = await aud.auditDelivery({
    slug:             "audited",
    campaign_id:      "release-0.0.9-broadcast",
    sent_count:       42,
    suppressed_count: 3,
  });
  check("auditDelivery returns id",         typeof d1.id === "string" && d1.id.length > 0);
  check("auditDelivery returns slug",       d1.slug === "audited");
  check("auditDelivery returns campaign",   d1.campaign_id === "release-0.0.9-broadcast");
  check("auditDelivery returns sent_count", d1.sent_count === 42);
  check("auditDelivery returns occurred_at", Number.isInteger(d1.occurred_at) && d1.occurred_at > 0);

  await new Promise(function (r) { setImmediate(r); });
  var d2 = await aud.auditDelivery({
    slug:             "audited",
    campaign_id:      "release-0.0.10-broadcast",
    sent_count:       50,
    suppressed_count: 5,
    occurred_at:      Date.now(),
  });
  check("auditDelivery distinct id",        d2.id !== d1.id);

  // listDeliveries returns both, newest first.
  var ls = await aud.listDeliveries({ slug: "audited" });
  check("listDeliveries returns 2 rows",    ls.rows.length === 2);
  check("listDeliveries sorted DESC",       ls.rows[0].occurred_at >= ls.rows[1].occurred_at);

  // auditDelivery still records for archived audiences (compliance trail).
  await aud.archive("audited");
  var d3 = await aud.auditDelivery({
    slug:             "audited",
    campaign_id:      "rc-followup",
    sent_count:       0,
    suppressed_count: 0,
  });
  check("auditDelivery works post-archive", d3.id !== d1.id && d3.id !== d2.id);

  var ls2 = await aud.listDeliveries({ slug: "audited" });
  check("listDeliveries surfaces post-archive row", ls2.rows.length === 3);
}

async function _refusals() {
  var query = _makeQuery();
  var aud   = _factory(query);

  // Bad slug shape.
  await assert.rejects(
    aud.defineAudience({ slug: "Has Caps", title: "x", rules: {} }),
    /slug/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "", title: "x", rules: {} }),
    /slug/
  );
  await assert.rejects(
    aud.defineAudience({ slug: 42, title: "x", rules: {} }),
    /slug/
  );

  // Bad title.
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "", rules: {} }),
    /title/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "line1\r\nline2", rules: {} }),
    /title/
  );

  // Missing rules object.
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok" }),
    /rules/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: "string" }),
    /rules/
  );

  // Unknown rule key.
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { invented_predicate: 1 } }),
    /unknown rule key/
  );

  // Bad rule value shapes.
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { subscribed_after: -1 } }),
    /subscribed_after/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { subscribed_after: "yesterday" } }),
    /subscribed_after/
  );
  await assert.rejects(
    aud.defineAudience({
      slug:  "ok", title: "Ok",
      rules: { subscribed_after: 100, subscribed_before: 50 },
    }),
    /subscribed_after/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { source_in: [] } }),
    /source_in/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { source_in: ["BAD UPPER"] } }),
    /source_in/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { country_in: ["us"] } }),
    /country_in/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { language_in: ["EN"] } }),
    /language_in/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { double_opt_in: "yes" } }),
    /double_opt_in/
  );
  await assert.rejects(
    aud.defineAudience({ slug: "ok", title: "Ok", rules: { tag_any: "release" } }),
    /tag_any/
  );

  // resolve / count / update / archive on missing slug.
  await assert.rejects(
    aud.resolve({ slug: "never-defined" }),
    /not found/
  );
  await assert.rejects(
    aud.count("never-defined"),
    /not found/
  );
  await assert.rejects(
    aud.update("never-defined", { title: "x" }),
    /not found/
  );
  await assert.rejects(
    aud.archive("never-defined"),
    /not found/
  );

  // resolve: bad limit.
  await aud.defineAudience({ slug: "ok", title: "Ok", rules: {} });
  await assert.rejects(
    aud.resolve({ slug: "ok", limit: 0 }),
    /limit/
  );
  await assert.rejects(
    aud.resolve({ slug: "ok", limit: 999999 }),
    /limit/
  );
  // resolve: bad cursor type.
  await assert.rejects(
    aud.resolve({ slug: "ok", cursor: 42 }),
    /cursor/
  );

  // auditDelivery refusals.
  await assert.rejects(
    aud.auditDelivery({ slug: "ok", campaign_id: "", sent_count: 1, suppressed_count: 0 }),
    /campaign_id/
  );
  await assert.rejects(
    aud.auditDelivery({ slug: "ok", campaign_id: "ok", sent_count: -1, suppressed_count: 0 }),
    /sent_count/
  );
  await assert.rejects(
    aud.auditDelivery({ slug: "ok", campaign_id: "ok", sent_count: 1, suppressed_count: -1 }),
    /suppressed_count/
  );
  await assert.rejects(
    aud.auditDelivery({ slug: "ok", campaign_id: "ok", sent_count: 1, suppressed_count: 0, occurred_at: "yesterday" }),
    /occurred_at/
  );
  await assert.rejects(
    aud.auditDelivery(null),
    /input/
  );

  // Factory in production requires cursorSecret.
  var prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      function () { mailingAudiences.create({ query: query }); },
      /cursorSecret/
    );
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
}

async function _newsletterHandlePassthrough() {
  // The optional newsletter handle is stored on the factory but the
  // resolve / recompute paths go through `query` directly. This test
  // pins the composition surface so a future refactor doesn't
  // silently drop the handle.
  var query      = _makeQuery();
  var newsletter = newsletterMod.create({ query: query });
  var aud        = _factory(query, { newsletter: newsletter });
  check("newsletter handle round-trips",   aud._newsletterHandle() === newsletter);
  var bareAud = _factory(query);
  check("no-handle factory returns null",  bareAud._newsletterHandle() === null);
}

async function run() {
  await _defineAudienceHappyPath();
  await _ruleCombinations();
  await _resolveWithSuppression();
  await _recomputeCacheFreshness();
  await _cursorPagination();
  await _updateArchiveAndList();
  await _auditDeliveryLog();
  await _refusals();
  await _newsletterHandlePassthrough();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("mailing-audiences.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("mailing-audiences.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
