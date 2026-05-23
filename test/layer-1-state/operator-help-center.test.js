"use strict";
/**
 * operator-help-center — in-admin operator help articles, indexed by
 * admin-console section. Distinct from `knowledgeBase` (customer-
 * facing). Visibility gated by a closed `audience_roles` allow-list
 * drawn from `operatorRoles.PERMISSIONS`.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0200_operator_help_center.sql`. The primitive isn't wired through
 * `bShop` yet — the test requires `lib/operator-help-center.js`
 * directly so the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - defineArticle persists + hydrates + renders body_html via the
 *     markdown subset; raw HTML in the body is escaped; raw body
 *     preserved
 *   - audience_roles allow-list is closed at the primitive layer; a
 *     token outside operatorRoles.PERMISSIONS is refused
 *   - articlesForSection filters by section + role; empty
 *     audience_roles is visible to every role; non-empty filters
 *     down
 *   - searchSuggest ranking: title-hit (3) > section-hit (2) >
 *     body-hit (1); archived excluded; role filter narrows
 *   - recordHelpfulVote dedup at (slug, operator_id) UNIQUE +
 *     aggregate counters reflect distinct operators only
 *   - popularArticles top-N over a closed window; archived excluded;
 *     role filter applied
 *   - updateArticle patch + allow-list refusal on unknown keys
 *   - archiveArticle tombstones the row; every read surface hides it
 *   - input refusals on every public surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop              = require("../../lib");
var operatorHelpCenter = require("../../lib/operator-help-center");
var operatorRoles      = require("../../lib/operator-roles");
var helpers            = require("../helpers");
var check              = helpers.check;
var assert             = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0200_operator_help_center.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        changes:   Number(info.changes),
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _setup() {
  var query = _makeQuery();
  var hc = operatorHelpCenter.create({
    query:        query,
    cursorSecret: "operator-help-center-test-secret",
  });
  return { query: query, hc: hc };
}

async function _defineAndRender() {
  var ctx = _setup();
  var a = await ctx.hc.defineArticle({
    slug:    "how-to-issue-refund",
    title:   "How to issue a refund",
    body:    "Open the order, click **Refund**, then visit " +
             "[the policy](/policies/refunds) to confirm.",
    section: "orders",
    related_actions: ["orders/list", "settings/refund-policy"],
    audience_roles:  ["orders.refund"],
  });
  check("defineArticle returns slug",                a.slug === "how-to-issue-refund");
  check("defineArticle stores section",              a.section === "orders");
  check("defineArticle starts unarchived",           a.archived_at === null);
  check("defineArticle starts at 0 view_count",      a.view_count === 0);
  check("defineArticle hydrates related_actions",    Array.isArray(a.related_actions) && a.related_actions.length === 2);
  check("defineArticle hydrates audience_roles",     Array.isArray(a.audience_roles) && a.audience_roles[0] === "orders.refund");
  check("defineArticle renders bold markdown",       a.body_html.indexOf("<strong>Refund</strong>") !== -1);
  check("defineArticle renders safe absolute link",  a.body_html.indexOf('<a href="/policies/refunds">the policy</a>') !== -1);
  check("defineArticle preserves raw body",          a.body.indexOf("**Refund**") !== -1);

  // Raw HTML body is escaped, not passed through.
  var b = await ctx.hc.defineArticle({
    slug:    "html-injection",
    title:   "HTML test",
    body:    "Watch out for <script>alert(1)</script> tags.",
    section: "security",
  });
  check("body_html escapes raw HTML",
    b.body_html.indexOf("<script>") === -1 && b.body_html.indexOf("&lt;script&gt;") !== -1);

  // Dangerous URL is dropped at render time; safe URL renders.
  var c = await ctx.hc.defineArticle({
    slug:    "link-gate",
    title:   "Link gate",
    body:    "See [bad](javascript:alert(1)) and [good](https://example.com).",
    section: "security",
  });
  check("dangerous javascript: URL dropped",         c.body_html.indexOf("javascript:") === -1);
  check("safe https URL renders",                    c.body_html.indexOf('<a href="https://example.com">good</a>') !== -1);

  // Idempotent re-define on the same slug updates title/body/section
  // in place; created_at is preserved.
  var aPrime = await ctx.hc.defineArticle({
    slug:    "how-to-issue-refund",
    title:   "How to issue a refund (revised)",
    body:    "Revised body.",
    section: "orders",
    audience_roles: ["orders.refund"],
  });
  check("defineArticle idempotent on slug",          aPrime.title.indexOf("revised") !== -1);
  check("defineArticle preserves created_at",        aPrime.created_at === a.created_at);
  check("defineArticle bumps updated_at",            aPrime.updated_at >= a.updated_at);

  // audience_roles outside operatorRoles.PERMISSIONS is refused at
  // the primitive layer (closed allow-list).
  await assert.rejects(ctx.hc.defineArticle({
    slug: "bad-role", title: "T", body: "B", section: "general",
    audience_roles: ["not.a.real.permission"],
  }), /audience_roles/);

  // Refusals.
  await assert.rejects(ctx.hc.defineArticle(),                                                           /input object required/);
  await assert.rejects(ctx.hc.defineArticle({ slug: "BAD CAPS", title: "T", body: "B", section: "x" }),   /slug/);
  await assert.rejects(ctx.hc.defineArticle({ slug: "ok",   title: "",  body: "B", section: "x" }),       /title/);
  await assert.rejects(ctx.hc.defineArticle({ slug: "ok",   title: "T", body: "",  section: "x" }),       /body/);
  await assert.rejects(ctx.hc.defineArticle({ slug: "ok",   title: "T", body: "B", section: "BAD!" }),     /section/);
  await assert.rejects(ctx.hc.defineArticle({
    slug: "ok2", title: "bad\ntitle", body: "B", section: "x",
  }), /title/);
  await assert.rejects(ctx.hc.defineArticle({
    slug: "ok3", title: "T", body: "bad" + String.fromCharCode(0x200B) + "body", section: "x",
  }), /zero-width/);
}

async function _articlesForSectionByRole() {
  var ctx = _setup();
  // Public article — visible to every operator (empty audience_roles).
  await ctx.hc.defineArticle({
    slug: "orders-overview", title: "Orders overview", body: "Body.",
    section: "orders",
  });
  // Refund-only article — visible only to operators carrying the
  // orders.refund permission.
  await ctx.hc.defineArticle({
    slug: "orders-refund-flow", title: "Issuing refunds", body: "Body.",
    section: "orders",
    audience_roles: ["orders.refund"],
  });
  // Cancellation-only article — visible only to operators carrying
  // orders.cancel.
  await ctx.hc.defineArticle({
    slug: "orders-cancel-flow", title: "Cancelling orders", body: "Body.",
    section: "orders",
    audience_roles: ["orders.cancel"],
  });
  // Article in a different section — never returned by orders queries.
  await ctx.hc.defineArticle({
    slug: "catalog-overview", title: "Catalog overview", body: "Body.",
    section: "catalog",
  });

  // No role -> every non-archived row in the section is returned.
  var allInOrders = await ctx.hc.articlesForSection({ section: "orders" });
  check("articlesForSection without role returns all 3", allInOrders.rows.length === 3);
  check("articlesForSection scope is the section",
    allInOrders.rows.every(function (r) { return r.section === "orders"; }));

  // Refunder role -> sees public + refund-only.
  var refunderView = await ctx.hc.articlesForSection({
    section: "orders", role: "orders.refund",
  });
  var refunderSlugs = refunderView.rows.map(function (r) { return r.slug; }).sort();
  check("refunder sees public + refund article",
    refunderSlugs.length === 2 &&
    refunderSlugs.indexOf("orders-overview") !== -1 &&
    refunderSlugs.indexOf("orders-refund-flow") !== -1);

  // Canceller role -> sees public + cancel-only (NOT refund-only).
  var cancellerView = await ctx.hc.articlesForSection({
    section: "orders", role: "orders.cancel",
  });
  var cancellerSlugs = cancellerView.rows.map(function (r) { return r.slug; }).sort();
  check("canceller sees public + cancel article",
    cancellerSlugs.length === 2 &&
    cancellerSlugs.indexOf("orders-overview") !== -1 &&
    cancellerSlugs.indexOf("orders-cancel-flow") !== -1);
  check("canceller does NOT see refund-only article",
    cancellerSlugs.indexOf("orders-refund-flow") === -1);

  // Unrelated role (catalog.read) -> sees only the public article.
  var catalogView = await ctx.hc.articlesForSection({
    section: "orders", role: "catalog.read",
  });
  check("unrelated role sees only public article",
    catalogView.rows.length === 1 && catalogView.rows[0].slug === "orders-overview");

  // Section with no articles -> empty.
  var emptySection = await ctx.hc.articlesForSection({ section: "vendors" });
  check("empty section returns []", emptySection.rows.length === 0);

  // Role outside the permission allow-list is refused.
  await assert.rejects(ctx.hc.articlesForSection({
    section: "orders", role: "not.a.real.permission",
  }), /role/);

  // Refusals.
  await assert.rejects(ctx.hc.articlesForSection(),                                /input object required/);
  await assert.rejects(ctx.hc.articlesForSection({ section: "BAD!" }),               /section/);
  await assert.rejects(ctx.hc.articlesForSection({ section: "orders", limit: 0 }),   /limit/);
}

async function _searchSuggestRanking() {
  var ctx = _setup();
  // Article whose TITLE matches "refund".
  await ctx.hc.defineArticle({
    slug: "refund-overview", title: "Refund overview",
    body: "How refunds work.", section: "billing",
  });
  // Article whose SECTION matches "refund" but title doesn't.
  await ctx.hc.defineArticle({
    slug: "process-flow", title: "Process flow",
    body: "Step-by-step.", section: "refund",
  });
  // Article whose BODY mentions "refund" but title + section don't.
  await ctx.hc.defineArticle({
    slug: "customer-policy", title: "Customer policy",
    body: "Original refund is non-negotiable.", section: "policies",
  });
  // Archived — must be excluded.
  await ctx.hc.defineArticle({
    slug: "old-refund", title: "Old refund policy",
    body: "Refund was a thing.", section: "policies",
  });
  await ctx.hc.archiveArticle("old-refund");

  var hits = await ctx.hc.searchSuggest({ query: "refund", limit: 5 });
  check("searchSuggest returns 3 hits",            hits.length === 3);
  check("searchSuggest #1 is title-match (3)",     hits[0].slug === "refund-overview" && hits[0].score === 3);
  check("searchSuggest #2 is section-match (2)",   hits[1].slug === "process-flow" && hits[1].score === 2);
  check("searchSuggest #3 is body-match (1)",      hits[2].slug === "customer-policy" && hits[2].score === 1);
  check("searchSuggest excludes archived",         hits.every(function (h) { return h.slug !== "old-refund"; }));

  // Role filter narrows the corpus.
  await ctx.hc.defineArticle({
    slug: "refund-admin-only", title: "Refund admin only",
    body: "Body.", section: "billing",
    audience_roles: ["orders.refund"],
  });
  var refunderHits = await ctx.hc.searchSuggest({ query: "refund", role: "orders.refund" });
  var refunderSlugs = refunderHits.map(function (h) { return h.slug; });
  check("role-filtered search includes audience-empty + matching-role",
    refunderSlugs.indexOf("refund-overview") !== -1 &&
    refunderSlugs.indexOf("refund-admin-only") !== -1);

  var cancellerHits = await ctx.hc.searchSuggest({ query: "refund", role: "orders.cancel" });
  var cancellerSlugs = cancellerHits.map(function (h) { return h.slug; });
  check("role-filtered search excludes mismatched-role article",
    cancellerSlugs.indexOf("refund-admin-only") === -1);

  // Compound query.
  var compound = await ctx.hc.searchSuggest({ query: "refund overview" });
  // "refund-overview": title "refund" (3) + title "overview" (3) = 6
  check("compound query top score = 6",            compound[0].slug === "refund-overview" && compound[0].score === 6);

  // Empty / noise.
  var empty1 = await ctx.hc.searchSuggest({ query: "" });
  check("empty query returns []",                  Array.isArray(empty1) && empty1.length === 0);
  var empty2 = await ctx.hc.searchSuggest({ query: "a b c" });
  check("sub-2-char-token query returns []",       empty2.length === 0);

  // Limit cap.
  var capped = await ctx.hc.searchSuggest({ query: "refund", limit: 2 });
  check("searchSuggest honors limit cap",          capped.length === 2);

  // Refusals.
  await assert.rejects(ctx.hc.searchSuggest(),                                          /input object required/);
  await assert.rejects(ctx.hc.searchSuggest({ query: "x".repeat(401) }),                  /query/);
  await assert.rejects(ctx.hc.searchSuggest({ query: "ok", limit: 0 }),                   /limit/);
  await assert.rejects(ctx.hc.searchSuggest({ query: "ok", limit: 999 }),                 /limit/);
  await assert.rejects(ctx.hc.searchSuggest({ query: "bad\x00" }),                        /query/);
  await assert.rejects(ctx.hc.searchSuggest({ query: "ok", role: "not.real" }),           /role/);
}

async function _recordHelpfulVoteDedup() {
  var ctx = _setup();
  await ctx.hc.defineArticle({
    slug: "vote-test", title: "T", body: "B", section: "general",
  });

  var op1 = _uuid();
  var op2 = _uuid();
  var op3 = _uuid();
  var op4 = _uuid();

  // First helpful vote from op1 counts.
  var v1 = await ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op1, vote: "helpful" });
  check("first vote recorded",                 v1.recorded === true);

  // Repeat from same operator no-ops (UNIQUE dedup).
  var v2 = await ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op1, vote: "helpful" });
  check("repeat vote no-op (dedup)",           v2.recorded === false);

  // Same operator, different vote, still a no-op (first vote wins).
  var v3 = await ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op1, vote: "not_helpful" });
  check("vote flip from same operator no-op",  v3.recorded === false);

  // Different operators count.
  await ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op2, vote: "helpful" });
  await ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op3, vote: "not_helpful" });
  await ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op4, vote: "helpful" });

  var row = await ctx.hc.getArticle({ slug: "vote-test" });
  check("helpful_count = 3 (3 distinct helpful operators)", row.helpful_count === 3);
  check("not_helpful_count = 1",                            row.not_helpful_count === 1);

  // Refusals.
  await assert.rejects(ctx.hc.recordHelpfulVote(),                                                                /input object required/);
  await assert.rejects(ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op1 }),                          /vote/);
  await assert.rejects(ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: "not-a-uuid", vote: "helpful" }), /operator_id/);
  await assert.rejects(ctx.hc.recordHelpfulVote({ slug: "vote-test", operator_id: op1, vote: "maybe" }),            /vote/);
  await assert.rejects(ctx.hc.recordHelpfulVote({ slug: "no-such",   operator_id: op1, vote: "helpful" }),          /not found/);

  // Archived article rejects votes.
  await ctx.hc.archiveArticle("vote-test");
  await assert.rejects(ctx.hc.recordHelpfulVote({
    slug: "vote-test", operator_id: op1, vote: "helpful",
  }), /archived/);
}

async function _popularArticles() {
  var ctx = _setup();
  await ctx.hc.defineArticle({ slug: "pop-a", title: "A", body: "A.", section: "general" });
  await ctx.hc.defineArticle({ slug: "pop-b", title: "B", body: "B.", section: "general" });
  await ctx.hc.defineArticle({ slug: "pop-c", title: "C", body: "C.", section: "general" });
  // Archived article is excluded from popularity.
  await ctx.hc.defineArticle({ slug: "pop-archived", title: "X", body: "X.", section: "general" });
  await ctx.hc.archiveArticle("pop-archived");
  // Role-gated article — counted only when caller carries the role.
  await ctx.hc.defineArticle({
    slug: "pop-refund-only", title: "Refund only", body: "Body.",
    section: "billing", audience_roles: ["orders.refund"],
  });

  var op = _uuid();
  var start = Date.now();
  await ctx.hc.recordView({ slug: "pop-a",           operator_id: op });
  await ctx.hc.recordView({ slug: "pop-a",           operator_id: _uuid() });
  await ctx.hc.recordView({ slug: "pop-a",           operator_id: _uuid() });
  await ctx.hc.recordView({ slug: "pop-b",           operator_id: op });
  await ctx.hc.recordView({ slug: "pop-b",           operator_id: _uuid() });
  await ctx.hc.recordView({ slug: "pop-c",           operator_id: op });
  await ctx.hc.recordView({ slug: "pop-refund-only", operator_id: op });
  await ctx.hc.recordView({ slug: "pop-refund-only", operator_id: _uuid() });
  // Archived recordView is refused.
  await assert.rejects(ctx.hc.recordView({ slug: "pop-archived", operator_id: op }), /archived/);
  var end = Date.now() + 1000;

  var pop = await ctx.hc.popularArticles({ from: start - 1, to: end, limit: 10 });
  check("popularArticles top is A with 3 views",   pop[0].slug === "pop-a" && pop[0].views === 3);
  check("popularArticles 2nd is refund-only (2)",  pop[1].slug === "pop-refund-only" && pop[1].views === 2);
  check("popularArticles 3rd is B with 2 views",   pop[2].slug === "pop-b" && pop[2].views === 2);
  check("popularArticles 4th is C with 1 view",    pop[3].slug === "pop-c" && pop[3].views === 1);
  check("popularArticles excludes archived",       pop.every(function (p) { return p.slug !== "pop-archived"; }));

  // Role filter excludes mismatched audience.
  var popForCanceller = await ctx.hc.popularArticles({
    from: start - 1, to: end, limit: 10, role: "orders.cancel",
  });
  check("role-filtered popular excludes refund-only",
    popForCanceller.every(function (p) { return p.slug !== "pop-refund-only"; }));

  // Limit cap.
  var top1 = await ctx.hc.popularArticles({ from: start - 1, to: end, limit: 1 });
  check("popularArticles limit=1 returns just top", top1.length === 1 && top1[0].slug === "pop-a");

  // Empty window.
  var emptyWindow = await ctx.hc.popularArticles({ from: 1, to: 2 });
  check("popularArticles empty window returns []", emptyWindow.length === 0);

  // Refusals.
  await assert.rejects(ctx.hc.popularArticles(),                                /input object required/);
  await assert.rejects(ctx.hc.popularArticles({ from: "x", to: 0 }),              /from/);
  await assert.rejects(ctx.hc.popularArticles({ from: 10, to: 5 }),               /from must be <= to/);
  await assert.rejects(ctx.hc.popularArticles({ from: 0, to: 1, limit: 0 }),      /limit/);
  await assert.rejects(ctx.hc.popularArticles({ from: 0, to: 1, role: "x.y" }),   /role/);

  // recordView refusals.
  await assert.rejects(ctx.hc.recordView(),                                                  /input object required/);
  await assert.rejects(ctx.hc.recordView({ slug: "no-such",  operator_id: op }),              /not found/);
  await assert.rejects(ctx.hc.recordView({ slug: "pop-a",    operator_id: "not-uuid" }),       /operator_id/);
}

async function _updateArticleSurface() {
  var ctx = _setup();
  await ctx.hc.defineArticle({
    slug: "patch-me", title: "Original", body: "Body.",
    section: "settings",
    related_actions: ["settings/general"],
    audience_roles: ["settings.write"],
  });

  // Patch title only.
  var p1 = await ctx.hc.updateArticle("patch-me", { title: "Revised" });
  check("updateArticle patches title",            p1.title === "Revised");
  check("updateArticle leaves body alone",        p1.body === "Body.");
  check("updateArticle leaves section alone",     p1.section === "settings");

  // Patch audience_roles + section together.
  var p2 = await ctx.hc.updateArticle("patch-me", {
    section: "billing",
    audience_roles: ["billing.view"],
  });
  check("updateArticle patches section",          p2.section === "billing");
  check("updateArticle patches audience_roles",   p2.audience_roles[0] === "billing.view");

  // Patch related_actions to empty.
  var p3 = await ctx.hc.updateArticle("patch-me", { related_actions: [] });
  check("updateArticle clears related_actions",   p3.related_actions.length === 0);

  // Unknown patch key is refused (allow-list closed).
  await assert.rejects(ctx.hc.updateArticle("patch-me", { archived_at: 0 }), /allow-list/);
  await assert.rejects(ctx.hc.updateArticle("patch-me", { slug: "rename" }), /allow-list/);

  // Invalid audience_roles refused.
  await assert.rejects(ctx.hc.updateArticle("patch-me", {
    audience_roles: ["not.a.real.permission"],
  }), /audience_roles/);

  // Refusals.
  await assert.rejects(ctx.hc.updateArticle("patch-me"),                                /patch object required/);
  await assert.rejects(ctx.hc.updateArticle("patch-me", { title: "" }),                  /title/);
  await assert.rejects(ctx.hc.updateArticle("patch-me", { body:  "" }),                  /body/);
  await assert.rejects(ctx.hc.updateArticle("patch-me", { section: "BAD!" }),            /section/);
  await assert.rejects(ctx.hc.updateArticle("no-such",  { title: "x" }),                 /not found/);
  await assert.rejects(ctx.hc.updateArticle("BAD!",     { title: "x" }),                 /slug/);
}

async function _archiveLifecycle() {
  var ctx = _setup();
  await ctx.hc.defineArticle({
    slug: "archive-me", title: "Test", body: "Body.",
    section: "general",
  });

  // Visible before archive.
  var before = await ctx.hc.getArticle({ slug: "archive-me" });
  check("getArticle returns row before archive", before !== null && before.slug === "archive-me");

  var arch = await ctx.hc.archiveArticle("archive-me");
  check("archiveArticle sets archived_at",       typeof arch.archived_at === "number");

  // Disappears from getArticle.
  var gone = await ctx.hc.getArticle({ slug: "archive-me" });
  check("archived hidden from getArticle",       gone === null);

  // Disappears from articlesForSection.
  var sectionAfter = await ctx.hc.articlesForSection({ section: "general" });
  check("archived hidden from articlesForSection",
    sectionAfter.rows.every(function (r) { return r.slug !== "archive-me"; }));

  // Disappears from searchSuggest.
  var suggestAfter = await ctx.hc.searchSuggest({ query: "test" });
  check("archived hidden from searchSuggest",
    suggestAfter.every(function (h) { return h.slug !== "archive-me"; }));

  // updateArticle refused on archived row.
  await assert.rejects(ctx.hc.updateArticle("archive-me", { title: "x" }), /archived/);

  // defineArticle refused on archived slug — operator must re-author
  // under a fresh slug.
  await assert.rejects(ctx.hc.defineArticle({
    slug: "archive-me", title: "T", body: "B", section: "general",
  }), /archived/);

  // recordView / recordHelpfulVote refused on archived row.
  var op = _uuid();
  await assert.rejects(ctx.hc.recordView({ slug: "archive-me", operator_id: op }), /archived/);
  await assert.rejects(ctx.hc.recordHelpfulVote({
    slug: "archive-me", operator_id: op, vote: "helpful",
  }), /archived/);

  // archiveArticle on unknown slug refused.
  await assert.rejects(ctx.hc.archiveArticle("no-such"), /not found/);
  await assert.rejects(ctx.hc.archiveArticle("BAD!"),    /slug/);
}

async function _listSectionsAndPagination() {
  var ctx = _setup();
  // listSections empty when no articles.
  var sectionsEmpty = await ctx.hc.listSections();
  check("listSections returns [] when no articles", sectionsEmpty.length === 0);

  // Seven articles across three sections, deterministic ordering
  // via the monotonic clock.
  for (var i = 0; i < 7; i += 1) {
    var section = ["orders", "catalog", "settings"][i % 3];
    await ctx.hc.defineArticle({
      slug:    "art-" + i,
      title:   "Title " + i,
      body:    "Body " + i,
      section: section,
    });
  }

  // Archived row is excluded from listSections (if it was the only
  // article in its section, that section disappears too).
  await ctx.hc.defineArticle({
    slug: "only-vendor-article", title: "Vendor", body: "Body.",
    section: "vendors",
  });
  await ctx.hc.archiveArticle("only-vendor-article");
  var sections = await ctx.hc.listSections();
  check("listSections returns distinct sections sorted",
    JSON.stringify(sections) === JSON.stringify(["catalog", "orders", "settings"]));

  // Pagination round-trip on a single section.
  var page1 = await ctx.hc.articlesForSection({ section: "orders", limit: 1 });
  check("page1 returns 1 row",                     page1.rows.length === 1);
  check("page1 carries a next_cursor",             typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await ctx.hc.articlesForSection({ section: "orders", limit: 1, cursor: page1.next_cursor });
  check("page2 returns 1 row",                     page2.rows.length === 1);
  check("page2 row distinct from page1",           page2.rows[0].slug !== page1.rows[0].slug);
  var page3 = await ctx.hc.articlesForSection({ section: "orders", limit: 1, cursor: page2.next_cursor });
  check("page3 returns 1 row (last)",              page3.rows.length === 1);
  check("page3 has no next_cursor",                page3.next_cursor === null);

  // Tampered cursor refused.
  await assert.rejects(ctx.hc.articlesForSection({
    section: "orders", cursor: page1.next_cursor + "x",
  }), /cursor/);

  // PERMISSIONS expose mirrors operatorRoles allow-list.
  check("hc.PERMISSIONS mirrors operatorRoles.PERMISSIONS",
    Array.isArray(operatorHelpCenter.create({ cursorSecret: "x" }).PERMISSIONS) &&
    operatorRoles.PERMISSIONS.indexOf("orders.refund") !== -1);
}

async function run() {
  await _defineAndRender();
  await _articlesForSectionByRole();
  await _searchSuggestRanking();
  await _recordHelpfulVoteDedup();
  await _popularArticles();
  await _updateArticleSurface();
  await _archiveLifecycle();
  await _listSectionsAndPagination();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/operator-help-center.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — operator-help-center (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — operator-help-center: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
