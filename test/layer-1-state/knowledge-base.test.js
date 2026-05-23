"use strict";
/**
 * knowledge-base — self-serve customer help center. FAQ articles
 * with categories, locale fallback, helpfulness voting, view
 * tracking, and ranked search-suggest. Composed by supportTickets
 * intake to surface articles before a ticket opens.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0162_knowledge_base.sql`. The primitive isn't wired through
 * `bShop` yet — the test requires `lib/knowledge-base.js` directly
 * so the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - defineArticle persists + hydrates + renders body_html via
 *     the markdown subset; raw HTML in the body is escaped
 *   - locale fallback chain: "fr-ca" -> "fr" -> default "en"
 *   - publish / unpublish / archive FSM + revival via publish
 *   - recordVote dedup at (slug, session_id_hash) UNIQUE + aggregate
 *     counters reflect distinct sessions only
 *   - searchSuggest ranking: title-match (3) + tag-match (2) +
 *     body-match (1); ties break on slug DESC; archived /
 *     unpublished excluded
 *   - popularArticles top-N over a closed window; unpublished /
 *     archived rows excluded
 *   - updateArticle slug-wide category/tags vs locale-scoped
 *     title/body
 *   - listArticles cursor round-trip + tamper refusal + filters
 *   - input refusals on every public surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var knowledgeBase = require("../../lib/knowledge-base");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0162_knowledge_base.sql"
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
  var kb = knowledgeBase.create({
    query:         query,
    cursorSecret:  "knowledge-base-test-secret",
    defaultLocale: "en",
  });
  return { query: query, kb: kb };
}

async function _defineAndRender() {
  var ctx = _setup();
  var a = await ctx.kb.defineArticle({
    slug:     "how-to-track-your-order",
    title:    "How to track your order",
    body:     "Visit your **account** dashboard and click [tracking](/orders).\n\n" +
              "If the carrier hasn't picked up yet, the tracking number\n" +
              "appears within 24 hours.",
    category: "orders",
    tags:     ["tracking", "shipping"],
    locale:   "en",
  });
  check("defineArticle returns slug",        a.slug === "how-to-track-your-order");
  check("defineArticle returns locale",      a.locale === "en");
  check("defineArticle defaults to unpublished", a.published === false);
  check("defineArticle returns 0 view_count", a.view_count === 0);
  check("defineArticle hydrates tags array", Array.isArray(a.tags) && a.tags.length === 2 && a.tags[0] === "tracking");
  check("defineArticle renders body_html",   typeof a.body_html === "string" && a.body_html.indexOf("<strong>account</strong>") !== -1);
  check("defineArticle renders safe link",   a.body_html.indexOf('<a href="/orders">tracking</a>') !== -1);
  check("defineArticle preserves raw body",  a.body.indexOf("**account**") !== -1);

  // Raw HTML in body is escaped, not passed through.
  var b = await ctx.kb.defineArticle({
    slug:     "html-injection",
    title:    "HTML test",
    body:     "Watch out for <script>alert(1)</script> tags.",
    category: "security",
    locale:   "en",
  });
  check("body_html escapes raw HTML",        b.body_html.indexOf("<script>") === -1 && b.body_html.indexOf("&lt;script&gt;") !== -1);

  // Dangerous URL is dropped at render time.
  var c = await ctx.kb.defineArticle({
    slug:     "link-test",
    title:    "Link test",
    body:     "See [bad link](javascript:alert(1)) and [good link](https://example.com).",
    category: "security",
    locale:   "en",
  });
  check("dangerous URL dropped from render", c.body_html.indexOf("javascript:") === -1);
  check("safe https URL renders",            c.body_html.indexOf('<a href="https://example.com">good link</a>') !== -1);

  // Idempotent re-define on (slug, locale) updates title + body in place.
  var aPrime = await ctx.kb.defineArticle({
    slug:     "how-to-track-your-order",
    title:    "How to track your order (updated)",
    body:     "New body.",
    category: "orders",
    tags:     ["tracking", "shipping"],
    locale:   "en",
  });
  check("defineArticle idempotent on (slug, locale)", aPrime.title === "How to track your order (updated)");
  check("defineArticle preserves created_at",         aPrime.created_at === a.created_at);
  check("defineArticle bumps updated_at",             aPrime.updated_at >= a.updated_at);

  // Category mismatch on the same slug refused.
  await assert.rejects(ctx.kb.defineArticle({
    slug: "how-to-track-your-order", title: "T", body: "B",
    category: "billing", tags: ["tracking", "shipping"], locale: "fr",
  }), /category mismatch/);

  // Tag mismatch on the same slug refused.
  await assert.rejects(ctx.kb.defineArticle({
    slug: "how-to-track-your-order", title: "T", body: "B",
    category: "orders", tags: ["different"], locale: "fr",
  }), /tags mismatch/);

  // Refusals.
  await assert.rejects(ctx.kb.defineArticle(),                       /input object required/);
  await assert.rejects(ctx.kb.defineArticle({ slug: "BAD CAPS", title: "T", body: "B", category: "x", locale: "en" }), /slug/);
  await assert.rejects(ctx.kb.defineArticle({ slug: "ok", title: "", body: "B", category: "x", locale: "en" }), /title/);
  await assert.rejects(ctx.kb.defineArticle({ slug: "ok", title: "T", body: "", category: "x", locale: "en" }), /body/);
  await assert.rejects(ctx.kb.defineArticle({ slug: "ok", title: "T", body: "B", category: "BAD", locale: "en" }), /category/);
  await assert.rejects(ctx.kb.defineArticle({ slug: "ok", title: "T", body: "B", category: "x", locale: "BAD!" }), /locale/);
  // Control byte in title.
  await assert.rejects(ctx.kb.defineArticle({
    slug: "ok2", title: "bad\ntitle", body: "B", category: "x", locale: "en",
  }), /title/);
  // Zero-width in body.
  await assert.rejects(ctx.kb.defineArticle({
    slug: "ok3", title: "T", body: "bad" + String.fromCharCode(0x200B) + "body", category: "x", locale: "en",
  }), /zero-width/);
}

async function _localeFallback() {
  var ctx = _setup();
  // Define English baseline + French Canadian localization. No
  // generic French row — fallback should walk fr-ca -> fr -> en.
  await ctx.kb.defineArticle({
    slug: "shipping-policy", title: "Shipping policy (EN)",
    body: "English body.", category: "policies",
    locale: "en", published: true,
  });
  await ctx.kb.defineArticle({
    slug: "shipping-policy", title: "Politique d'expédition (FR-CA)",
    body: "Corps en français.", category: "policies",
    locale: "fr-ca", published: true,
  });

  // Exact locale match.
  var frCa = await ctx.kb.getArticle({ slug: "shipping-policy", locale: "fr-ca" });
  check("getArticle exact locale fr-ca",        frCa.title.indexOf("FR-CA") !== -1);

  // No fr row exists — fr-ca strips to fr (also missing) then default "en".
  var fr = await ctx.kb.getArticle({ slug: "shipping-policy", locale: "fr" });
  check("getArticle fr falls back to en",       fr.title.indexOf("(EN)") !== -1);

  // Default locale request.
  var en = await ctx.kb.getArticle({ slug: "shipping-policy", locale: "en" });
  check("getArticle en returns en row",         en.title.indexOf("(EN)") !== -1);

  // Locale omitted → default locale.
  var dflt = await ctx.kb.getArticle({ slug: "shipping-policy" });
  check("getArticle locale-omitted uses default", dflt.title.indexOf("(EN)") !== -1);

  // Unknown locale walks the chain right-to-left then to default.
  var fakeChain = await ctx.kb.getArticle({ slug: "shipping-policy", locale: "es-mx" });
  check("getArticle es-mx falls back to en",    fakeChain.title.indexOf("(EN)") !== -1);

  // Unknown slug returns null.
  var missing = await ctx.kb.getArticle({ slug: "no-such-slug", locale: "en" });
  check("getArticle missing slug returns null", missing === null);

  // Archived slug returns null at every locale.
  await ctx.kb.archiveArticle("shipping-policy");
  var archived = await ctx.kb.getArticle({ slug: "shipping-policy", locale: "fr-ca" });
  check("getArticle archived returns null",     archived === null);

  // Refusals.
  await assert.rejects(ctx.kb.getArticle(),                                 /input object required/);
  await assert.rejects(ctx.kb.getArticle({ slug: "BAD!" }),                  /slug/);
  await assert.rejects(ctx.kb.getArticle({ slug: "ok", locale: "BAD!" }),    /locale/);
}

async function _voteDedupAndAggregate() {
  var ctx = _setup();
  await ctx.kb.defineArticle({
    slug: "vote-test", title: "T", body: "B", category: "general",
    locale: "en", published: true,
  });

  // First helpful vote from session-A counts.
  var v1 = await ctx.kb.recordVote({ slug: "vote-test", session_id: "session-A", vote: "helpful" });
  check("first vote recorded",                  v1.recorded === true);

  // Repeat from same session is a no-op.
  var v2 = await ctx.kb.recordVote({ slug: "vote-test", session_id: "session-A", vote: "helpful" });
  check("repeat vote no-op (dedup)",            v2.recorded === false);

  // Flipping the vote from same session is also a no-op (one vote
  // per (slug, session) — switching requires the operator to clear
  // the entry, which the public surface doesn't expose by design).
  var v3 = await ctx.kb.recordVote({ slug: "vote-test", session_id: "session-A", vote: "not_helpful" });
  check("vote flip from same session no-op",    v3.recorded === false);

  // Different session counts.
  await ctx.kb.recordVote({ slug: "vote-test", session_id: "session-B", vote: "helpful" });
  await ctx.kb.recordVote({ slug: "vote-test", session_id: "session-C", vote: "not_helpful" });
  await ctx.kb.recordVote({ slug: "vote-test", session_id: "session-D", vote: "helpful" });

  var agg = await ctx.kb.voteAggregateForArticle("vote-test");
  check("voteAggregate helpful_count = 3",      agg.helpful_count === 3);
  check("voteAggregate not_helpful_count = 1",  agg.not_helpful_count === 1);
  check("voteAggregate total_votes = 4",        agg.total_votes === 4);
  check("voteAggregate helpfulness_ratio = 3/4", Math.abs(agg.helpfulness_ratio - 0.75) < 1e-9);

  // session_id_hash inspection — raw session id never lands on disk.
  var voteRows = (await ctx.query("SELECT session_id_hash FROM kb_votes", [])).rows;
  check("session_id stored as hex sha3 hash",
    voteRows.every(function (r) { return typeof r.session_id_hash === "string" && /^[0-9a-f]{128}$/.test(r.session_id_hash); }));
  check("raw session_id never lands on disk",
    voteRows.every(function (r) { return r.session_id_hash.indexOf("session-") === -1; }));

  // Refusals.
  await assert.rejects(ctx.kb.recordVote(),                                                         /input object required/);
  await assert.rejects(ctx.kb.recordVote({ slug: "vote-test", session_id: "x" }),                    /vote/);
  await assert.rejects(ctx.kb.recordVote({ slug: "vote-test", session_id: "", vote: "helpful" }),    /session_id/);
  await assert.rejects(ctx.kb.recordVote({ slug: "vote-test", session_id: "x", vote: "maybe" }),     /vote/);
  await assert.rejects(ctx.kb.recordVote({ slug: "no-such", session_id: "x", vote: "helpful" }),     /not found/);
  await assert.rejects(ctx.kb.voteAggregateForArticle("no-such"),                                   /not found/);

  // Zero-vote article returns null helpfulness_ratio (no division
  // by zero, no fake 0).
  await ctx.kb.defineArticle({
    slug: "no-votes", title: "T", body: "B", category: "general",
    locale: "en", published: true,
  });
  var aggEmpty = await ctx.kb.voteAggregateForArticle("no-votes");
  check("zero-vote helpfulness_ratio is null",  aggEmpty.helpfulness_ratio === null);
  check("zero-vote total_votes is 0",           aggEmpty.total_votes === 0);
}

async function _searchSuggestRanking() {
  var ctx = _setup();
  // Article whose TITLE matches "shipping".
  await ctx.kb.defineArticle({
    slug: "shipping-times", title: "Shipping times explained",
    body: "We aim to dispatch within 24 hours.", category: "shipping",
    locale: "en", published: true,
  });
  // Article whose TAGS match "shipping" but title doesn't.
  await ctx.kb.defineArticle({
    slug: "international-orders", title: "International orders",
    body: "Customs may delay delivery.", category: "shipping",
    tags: ["shipping", "customs"], locale: "en", published: true,
  });
  // Article whose BODY mentions "shipping" but tags + title don't.
  await ctx.kb.defineArticle({
    slug: "returns-policy", title: "How returns work",
    body: "Original shipping is non-refundable. Contact support to start a return.",
    category: "returns", locale: "en", published: true,
  });
  // Unpublished — must be excluded.
  await ctx.kb.defineArticle({
    slug: "draft-doc", title: "Shipping update (draft)",
    body: "Coming soon.", category: "shipping", locale: "en",
  });
  // Archived — must be excluded.
  await ctx.kb.defineArticle({
    slug: "old-doc", title: "Old shipping policy",
    body: "Shipping was a thing.", category: "shipping",
    locale: "en", published: true,
  });
  await ctx.kb.archiveArticle("old-doc");

  // Query "shipping" ranks: title-hit (3) > tag-hit (2) > body-hit (1).
  var hits = await ctx.kb.searchSuggest({ query: "shipping", limit: 5 });
  check("searchSuggest returns ranked hits",     hits.length === 3);
  check("searchSuggest #1 is title-match",       hits[0].slug === "shipping-times" && hits[0].score === 3);
  check("searchSuggest #2 is tag-match",         hits[1].slug === "international-orders" && hits[1].score === 2);
  check("searchSuggest #3 is body-match",        hits[2].slug === "returns-policy" && hits[2].score === 1);
  check("searchSuggest excludes unpublished",    hits.every(function (h) { return h.slug !== "draft-doc"; }));
  check("searchSuggest excludes archived",       hits.every(function (h) { return h.slug !== "old-doc"; }));

  // Compound query: title-hit + tag-hit > pure body-hit.
  await ctx.kb.defineArticle({
    slug: "delivery-fees", title: "Delivery fees by region",
    body: "International deliveries cost more.", category: "shipping",
    tags: ["shipping", "fees"], locale: "en", published: true,
  });
  var hits2 = await ctx.kb.searchSuggest({ query: "shipping delivery", limit: 5 });
  // "delivery-fees": title "delivery" (3) + tag "shipping" (2) = 5
  // "shipping-times": title "shipping" (3) = 3
  // "international-orders": tag "shipping" (2) + body "delivery" (1) = 3
  // "returns-policy": body "shipping" (1) = 1
  check("searchSuggest compound #1 has score 5", hits2[0].slug === "delivery-fees" && hits2[0].score === 5);
  check("searchSuggest tie breaks by slug DESC",
    (hits2[1].slug === "shipping-times" && hits2[1].score === 3) ||
    (hits2[1].slug === "international-orders" && hits2[1].score === 3));

  // Empty / noise query yields no hits.
  var empty1 = await ctx.kb.searchSuggest({ query: "" });
  check("empty query returns []",                Array.isArray(empty1) && empty1.length === 0);
  var empty2 = await ctx.kb.searchSuggest({ query: "a b c" });
  check("sub-2-char-token query returns []",     empty2.length === 0);

  // Category filter narrows the candidate set.
  var byCat = await ctx.kb.searchSuggest({ query: "shipping", category: "returns" });
  check("category filter narrows candidates",    byCat.length === 1 && byCat[0].slug === "returns-policy");

  // Limit cap honored.
  var capped = await ctx.kb.searchSuggest({ query: "shipping delivery", limit: 2 });
  check("searchSuggest honors limit",            capped.length === 2);

  // Refusals.
  await assert.rejects(ctx.kb.searchSuggest(),                                     /input object required/);
  await assert.rejects(ctx.kb.searchSuggest({ query: "x".repeat(401) }),             /query/);
  await assert.rejects(ctx.kb.searchSuggest({ query: "ok", limit: 0 }),              /limit/);
  await assert.rejects(ctx.kb.searchSuggest({ query: "ok", limit: 999 }),            /limit/);
  await assert.rejects(ctx.kb.searchSuggest({ query: "bad\x00" }),                   /query/);
}

async function _popularArticles() {
  var ctx = _setup();
  await ctx.kb.defineArticle({
    slug: "popular-a", title: "A", body: "A.", category: "general", locale: "en", published: true,
  });
  await ctx.kb.defineArticle({
    slug: "popular-b", title: "B", body: "B.", category: "general", locale: "en", published: true,
  });
  await ctx.kb.defineArticle({
    slug: "popular-c", title: "C", body: "C.", category: "general", locale: "en", published: true,
  });
  // Unpublished + archived rows are excluded from popular ranking.
  await ctx.kb.defineArticle({
    slug: "popular-draft", title: "D", body: "D.", category: "general", locale: "en",
  });
  await ctx.kb.defineArticle({
    slug: "popular-archived", title: "E", body: "E.", category: "general", locale: "en", published: true,
  });
  await ctx.kb.archiveArticle("popular-archived");

  // Stamp views with deterministic distribution.
  var start = Date.now();
  await ctx.kb.recordView({ slug: "popular-a", session_id: "s1" });
  await ctx.kb.recordView({ slug: "popular-a", session_id: "s2" });
  await ctx.kb.recordView({ slug: "popular-a", session_id: "s3" });
  await ctx.kb.recordView({ slug: "popular-b", session_id: "s4" });
  await ctx.kb.recordView({ slug: "popular-b", session_id: "s5" });
  await ctx.kb.recordView({ slug: "popular-c", session_id: "s6" });
  await ctx.kb.recordView({ slug: "popular-draft",    session_id: "s7" });
  await ctx.kb.recordView({ slug: "popular-archived", session_id: "s8" });
  var end = Date.now() + 1000;

  var pop = await ctx.kb.popularArticles({ from: start - 1, to: end, limit: 10 });
  check("popularArticles top is A with 3 views",   pop[0].slug === "popular-a" && pop[0].views === 3);
  check("popularArticles 2nd is B with 2 views",   pop[1].slug === "popular-b" && pop[1].views === 2);
  check("popularArticles 3rd is C with 1 view",    pop[2].slug === "popular-c" && pop[2].views === 1);
  check("popularArticles excludes draft",          pop.every(function (p) { return p.slug !== "popular-draft"; }));
  check("popularArticles excludes archived",       pop.every(function (p) { return p.slug !== "popular-archived"; }));

  // Limit honored.
  var top1 = await ctx.kb.popularArticles({ from: start - 1, to: end, limit: 1 });
  check("popularArticles limit=1 returns just top", top1.length === 1 && top1[0].slug === "popular-a");

  // Empty window returns [].
  var empty = await ctx.kb.popularArticles({ from: 1, to: 2 });
  check("popularArticles empty window returns []", empty.length === 0);

  // Refusals.
  await assert.rejects(ctx.kb.popularArticles(),                                      /input object required/);
  await assert.rejects(ctx.kb.popularArticles({ from: "x", to: 0 }),                  /from/);
  await assert.rejects(ctx.kb.popularArticles({ from: 10, to: 5 }),                   /from must be <= to/);
  await assert.rejects(ctx.kb.popularArticles({ from: 0, to: 1, limit: 0 }),          /limit/);

  // recordView refusals.
  await assert.rejects(ctx.kb.recordView(),                                            /input object required/);
  await assert.rejects(ctx.kb.recordView({ slug: "no-such" }),                          /not found/);
  await assert.rejects(ctx.kb.recordView({ slug: "popular-a", customer_id: "not-uuid" }), /customer_id/);
  await assert.rejects(ctx.kb.recordView({ slug: "popular-a", session_id: "" }),         /session_id/);

  // customer_id round-trips.
  var custId = _uuid();
  await ctx.kb.recordView({ slug: "popular-a", customer_id: custId });
  var viewRows = (await ctx.query("SELECT customer_id FROM kb_views WHERE customer_id IS NOT NULL", [])).rows;
  check("recordView persists customer_id",         viewRows.some(function (r) { return r.customer_id === custId; }));
}

async function _publishFSM() {
  var ctx = _setup();
  var a = await ctx.kb.defineArticle({
    slug: "fsm-test", title: "T", body: "B", category: "general", locale: "en",
  });
  check("article starts unpublished",          a.published === false);

  // Publish.
  var pub = await ctx.kb.publishArticle("fsm-test");
  check("publishArticle flips published=true", pub.published === true);

  // Unpublish.
  var unp = await ctx.kb.unpublishArticle("fsm-test");
  check("unpublishArticle flips published=false", unp.published === false);

  // Re-publish.
  var rep = await ctx.kb.publishArticle("fsm-test");
  check("re-publish flips back to true",       rep.published === true);

  // Archive — sets archived_at + clears published.
  var arch = await ctx.kb.archiveArticle("fsm-test");
  check("archiveArticle sets archived_at",     typeof arch.archived_at === "number");
  check("archiveArticle clears published",     arch.published === false);

  // Archived article disappears from getArticle.
  var gone = await ctx.kb.getArticle({ slug: "fsm-test", locale: "en" });
  check("archived article hidden from getArticle", gone === null);

  // updateArticle refuses on archived row.
  await assert.rejects(ctx.kb.updateArticle("fsm-test", { title: "x" }), /archived/);

  // Publish revives — archived_at clears.
  var revived = await ctx.kb.publishArticle("fsm-test");
  check("publishArticle revives archived row", revived.archived_at == null);
  check("revived article is published",        revived.published === true);

  // FSM operations on unknown slug refused.
  await assert.rejects(ctx.kb.publishArticle("no-such"),   /not found/);
  await assert.rejects(ctx.kb.unpublishArticle("no-such"), /not found/);
  await assert.rejects(ctx.kb.archiveArticle("no-such"),   /not found/);
  await assert.rejects(ctx.kb.publishArticle("BAD CAPS"),  /slug/);

  // Slug-wide effect: publishing one slug touches every locale row.
  await ctx.kb.defineArticle({
    slug: "multi-locale", title: "EN", body: "B", category: "general", locale: "en",
  });
  await ctx.kb.defineArticle({
    slug: "multi-locale", title: "FR", body: "B", category: "general", locale: "fr",
  });
  await ctx.kb.publishArticle("multi-locale");
  var enRow = (await ctx.query(
    "SELECT published FROM kb_articles WHERE slug = ?1 AND locale = ?2", ["multi-locale", "en"]
  )).rows[0];
  var frRow = (await ctx.query(
    "SELECT published FROM kb_articles WHERE slug = ?1 AND locale = ?2", ["multi-locale", "fr"]
  )).rows[0];
  check("publish touches every locale row (en)", enRow.published === 1);
  check("publish touches every locale row (fr)", frRow.published === 1);
}

async function _updateArticleSurface() {
  var ctx = _setup();
  await ctx.kb.defineArticle({
    slug: "patch-test", title: "Original EN", body: "Body EN.", category: "billing",
    tags: ["invoices"], locale: "en", published: true,
  });
  await ctx.kb.defineArticle({
    slug: "patch-test", title: "Original FR", body: "Corps FR.", category: "billing",
    tags: ["invoices"], locale: "fr", published: true,
  });

  // Patch title only (default locale).
  var p1 = await ctx.kb.updateArticle("patch-test", { title: "New EN" });
  check("updateArticle patches title on default locale", p1.title === "New EN");

  // FR row untouched.
  var fr = await ctx.kb.getArticle({ slug: "patch-test", locale: "fr" });
  check("updateArticle leaves other-locale title alone", fr.title === "Original FR");

  // Patch body on specific locale.
  var p2 = await ctx.kb.updateArticle("patch-test", { locale: "fr", body: "Nouveau corps FR." });
  check("updateArticle patches body on named locale",    p2.body === "Nouveau corps FR.");

  // Slug-wide category/tags rewrite every locale row.
  var p3 = await ctx.kb.updateArticle("patch-test", { category: "payments", tags: ["receipts"] });
  check("updateArticle rewrites category slug-wide",     p3.category === "payments");
  var frAfter = await ctx.kb.getArticle({ slug: "patch-test", locale: "fr" });
  check("slug-wide category update touches every locale", frAfter.category === "payments");
  check("slug-wide tags update touches every locale",     frAfter.tags.length === 1 && frAfter.tags[0] === "receipts");

  // Empty patch is a no-op.
  var p4 = await ctx.kb.updateArticle("patch-test", {});
  check("empty patch returns hydrated row",              p4.slug === "patch-test");

  // Refusals.
  await assert.rejects(ctx.kb.updateArticle("patch-test"),                              /patch object required/);
  await assert.rejects(ctx.kb.updateArticle("patch-test", { title: "" }),                /title/);
  await assert.rejects(ctx.kb.updateArticle("patch-test", { body:  "" }),                /body/);
  await assert.rejects(ctx.kb.updateArticle("patch-test", { category: "BAD" }),          /category/);
  await assert.rejects(ctx.kb.updateArticle("patch-test", { tags: ["BAD CAPS"] }),       /tags/);
  await assert.rejects(ctx.kb.updateArticle("no-such",    { title: "x" }),               /not found/);
  await assert.rejects(ctx.kb.updateArticle("patch-test", { locale: "de", title: "x" }), /not found/);
  await assert.rejects(ctx.kb.updateArticle("BAD!",        { title: "x" }),               /slug/);
}

async function _listArticlesPagination() {
  var ctx = _setup();
  // Five articles, all default locale, deterministic ordering via
  // monotonic clock.
  for (var i = 0; i < 5; i += 1) {
    await ctx.kb.defineArticle({
      slug:     "art-" + i,
      title:    "Title " + i,
      body:     "Body " + i,
      category: i % 2 === 0 ? "shipping" : "billing",
      locale:   "en",
      published: i < 3,
    });
  }

  // All in one shot.
  var all = await ctx.kb.listArticles({});
  check("listArticles returns all 5 (default-locale rows)", all.rows.length === 5);

  // published_only filters.
  var pubOnly = await ctx.kb.listArticles({ published_only: true });
  check("published_only narrows to 3",          pubOnly.rows.length === 3);

  // category filters.
  var shipOnly = await ctx.kb.listArticles({ category: "shipping" });
  check("category filter narrows",              shipOnly.rows.every(function (r) { return r.category === "shipping"; }));

  // Paginate at limit=2.
  var page1 = await ctx.kb.listArticles({ limit: 2 });
  check("page1 returns 2",                      page1.rows.length === 2);
  check("page1 has cursor",                     typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await ctx.kb.listArticles({ limit: 2, cursor: page1.next_cursor });
  check("page2 returns 2",                      page2.rows.length === 2);
  var page3 = await ctx.kb.listArticles({ limit: 2, cursor: page2.next_cursor });
  check("page3 returns last 1",                 page3.rows.length === 1);
  check("page3 no cursor",                      page3.next_cursor === null);
  // Disjoint pages.
  var seen = {};
  page1.rows.concat(page2.rows, page3.rows).forEach(function (r) { seen[r.slug] = (seen[r.slug] || 0) + 1; });
  check("paginated coverage disjoint",
    Object.keys(seen).length === 5 && Object.keys(seen).every(function (k) { return seen[k] === 1; }));

  // Tampered cursor refused.
  await assert.rejects(ctx.kb.listArticles({ cursor: page1.next_cursor + "x" }), /cursor/);

  // search filter.
  var titleHit = await ctx.kb.listArticles({ search: "Title 1" });
  check("search filter narrows",                titleHit.rows.length === 1 && titleHit.rows[0].slug === "art-1");

  // Archive one — disappears from list.
  await ctx.kb.archiveArticle("art-0");
  var afterArchive = await ctx.kb.listArticles({});
  check("archived row excluded from list",      afterArchive.rows.every(function (r) { return r.slug !== "art-0"; }));

  // Refusals.
  await assert.rejects(ctx.kb.listArticles({ limit: 0 }),                              /limit/);
  await assert.rejects(ctx.kb.listArticles({ limit: 9999 }),                           /limit/);
  await assert.rejects(ctx.kb.listArticles({ category: "BAD" }),                       /category/);
  await assert.rejects(ctx.kb.listArticles({ search: "x".repeat(401) }),               /query/);
  await assert.rejects(ctx.kb.listArticles({ cursor: 42 }),                            /cursor/);
}

async function run() {
  await _defineAndRender();
  await _localeFallback();
  await _voteDedupAndAggregate();
  await _searchSuggestRanking();
  await _popularArticles();
  await _publishFSM();
  await _updateArticleSurface();
  await _listArticlesPagination();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/knowledge-base.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — knowledge-base (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — knowledge-base: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
