"use strict";
/**
 * blog-articles — operator-published editorial storefront content
 * (separate from storefrontPages legal/about pages). Author + tags +
 * featured-product links + SEO meta + publish FSM.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0189_blog_articles.sql`. The primitive isn't wired through `bShop`
 * yet — the test requires `lib/blog-articles.js` directly so the gate
 * exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - createDraft persists + hydrates; re-insert against the same
 *     slug refused; publish FSM (draft -> published -> archived ->
 *     draft) + every illegal transition refused with both states
 *     named; unpublish/restore round-trip preserves published_at
 *   - listPublished newest-first + tag filter + cursor round-trip;
 *     drafts + archived excluded
 *   - relatedArticles tag-overlap ranking; anchor slug excluded;
 *     unpublished + archived excluded; ties break newer-first then
 *     slug DESC
 *   - recordView increments view_count; session_id hashed (raw never
 *     persisted); refuses unknown slug
 *   - renderHtml escapes hostile body — every `<script>` / `onerror`
 *     / javascript: URL lands as inert escaped text
 *   - byAuthor + popularArticles window aggregation
 *   - update patch (incl. tags / featured_product_ids /
 *     hero_image_url through safeUrl gate); hostile hero_image_url
 *     refused
 *   - validation surface on every entry point
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var blogArticles = require("../../lib/blog-articles");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0189_blog_articles.sql"
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
          changes:   Number(info.changes),
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _setup() {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    blog:  blogArticles.create({
      query:        h.query,
      cursorSecret: "blog-articles-test-secret",
    }),
  };
}

// ---- createDraft + publish FSM ----------------------------------------

async function _createDraftAndPublishFsm() {
  var ctx = _setup();
  var post = await ctx.blog.createDraft({
    slug:                 "five-mistakes-buying-coffee",
    title:                "Five mistakes buying coffee online",
    body:                 "## Mistake one\n\nBuying pre-ground when you've got a [grinder](/products/grinder).",
    author_id:            "ed-editor",
    tags:                 ["coffee", "guides"],
    featured_product_ids: ["sku-grinder-01", "sku-bean-house-blend"],
    hero_image_url:       "https://cdn.example.com/blog/coffee.jpg",
    meta_description:     "Avoid the five most common pitfalls when buying coffee online.",
    meta_keywords:        "coffee, online shopping, guides",
  });
  check("createDraft returns slug",              post.slug === "five-mistakes-buying-coffee");
  check("createDraft status draft",              post.status === "draft");
  check("createDraft tags persisted",            JSON.stringify(post.tags) === '["coffee","guides"]');
  check("createDraft features persisted",        post.featured_product_ids.length === 2);
  check("createDraft hero url persisted",        post.hero_image_url === "https://cdn.example.com/blog/coffee.jpg");
  check("createDraft meta_description set",      post.meta_description.length > 0);
  check("createDraft created_at set",            typeof post.created_at === "number" && post.created_at > 0);
  check("createDraft updated_at set",            typeof post.updated_at === "number" && post.updated_at > 0);
  check("createDraft published_at null",         post.published_at === null);
  check("createDraft archived_at null",          post.archived_at === null);
  check("createDraft view_count zero",           post.view_count === 0);

  // Re-insert against same slug refused.
  await assert.rejects(
    ctx.blog.createDraft({
      slug:      "five-mistakes-buying-coffee",
      title:     "Dup",
      body:      "x",
      author_id: "ed-editor",
    }),
    function (err) { return err && err.code === "BLOG_ARTICLE_EXISTS"; },
  );

  // FSM: draft -> published
  var published = await ctx.blog.publish("five-mistakes-buying-coffee");
  check("publish flips status",                  published.status === "published");
  check("publish stamps published_at",            typeof published.published_at === "number");
  var firstPublishedAt = published.published_at;

  // FSM: republish from draft after unpublish reuses published_at.
  var unpublished = await ctx.blog.unpublish("five-mistakes-buying-coffee");
  check("unpublish back to draft",                unpublished.status === "draft");
  check("unpublish preserves published_at",       unpublished.published_at === firstPublishedAt);

  var rePublished = await ctx.blog.publish("five-mistakes-buying-coffee");
  check("republish keeps original published_at",  rePublished.published_at === firstPublishedAt);

  // FSM: published -> archived -> restore -> draft
  var archived = await ctx.blog.archive("five-mistakes-buying-coffee");
  check("archive flips status",                   archived.status === "archived");
  check("archive stamps archived_at",             typeof archived.archived_at === "number");

  var restored = await ctx.blog.restore("five-mistakes-buying-coffee");
  check("restore back to draft",                  restored.status === "draft");
  check("restore clears archived_at",             restored.archived_at === null);

  // Illegal transitions refused with both states named.
  await assert.rejects(
    ctx.blog.unpublish("five-mistakes-buying-coffee"),
    /is in status "draft".*unpublish requires status one of \["published"\]/,
  );
  await assert.rejects(
    ctx.blog.archive("five-mistakes-buying-coffee"),
    /is in status "draft".*archive requires status one of \["published"\]/,
  );
  await assert.rejects(
    ctx.blog.restore("five-mistakes-buying-coffee"),
    /is in status "draft".*restore requires status one of \["archived"\]/,
  );
  await assert.rejects(
    ctx.blog.publish("nonexistent-slug"),
    function (err) { return err && err.code === "BLOG_ARTICLE_NOT_FOUND"; },
  );

  // listDrafts surfaces a draft; listArchived empty after restore.
  var drafts = await ctx.blog.listDrafts();
  check("listDrafts surfaces the restored post",  drafts.length === 1 && drafts[0].slug === "five-mistakes-buying-coffee");
  var arch = await ctx.blog.listArchived();
  check("listArchived empty after restore",       arch.length === 0);
}

// ---- listPublished tag filter -----------------------------------------

async function _listPublishedTagFilter() {
  var ctx = _setup();

  // Seed three published posts with overlapping tags.
  await ctx.blog.createDraft({
    slug:      "post-coffee-a",
    title:     "Coffee A",
    body:      "Body A.",
    author_id: "ed-editor",
    tags:      ["coffee", "guides"],
  });
  await ctx.blog.createDraft({
    slug:      "post-tea-b",
    title:     "Tea B",
    body:      "Body B.",
    author_id: "ed-editor",
    tags:      ["tea", "guides"],
  });
  await ctx.blog.createDraft({
    slug:      "post-coffee-c",
    title:     "Coffee C",
    body:      "Body C.",
    author_id: "ed-editor",
    tags:      ["coffee", "espresso"],
  });
  // One draft (excluded from listPublished).
  await ctx.blog.createDraft({
    slug:      "post-draft-d",
    title:     "Draft D",
    body:      "Body D.",
    author_id: "ed-editor",
    tags:      ["coffee"],
  });
  // One archived (excluded too).
  await ctx.blog.createDraft({
    slug:      "post-archived-e",
    title:     "Archived E",
    body:      "Body E.",
    author_id: "ed-editor",
    tags:      ["coffee"],
  });

  await ctx.blog.publish("post-coffee-a");
  await ctx.blog.publish("post-tea-b");
  await ctx.blog.publish("post-coffee-c");
  await ctx.blog.publish("post-archived-e");
  await ctx.blog.archive("post-archived-e");

  // No filter: published only, newest-first.
  var all = await ctx.blog.listPublished({});
  check("listPublished returns published only",   all.rows.length === 3);
  check("listPublished excludes archived",        all.rows.every(function (r) { return r.slug !== "post-archived-e"; }));
  check("listPublished excludes draft",           all.rows.every(function (r) { return r.slug !== "post-draft-d"; }));
  // Newest first: post-coffee-c was published last.
  check("listPublished newest first",             all.rows[0].slug === "post-coffee-c");

  // Filter by tag: coffee surfaces A + C but not B (tea).
  var coffee = await ctx.blog.listPublished({ tag: "coffee" });
  check("tag filter coffee count",                coffee.rows.length === 2);
  check("tag filter coffee includes A",           coffee.rows.some(function (r) { return r.slug === "post-coffee-a"; }));
  check("tag filter coffee includes C",           coffee.rows.some(function (r) { return r.slug === "post-coffee-c"; }));
  check("tag filter coffee excludes B",           coffee.rows.every(function (r) { return r.slug !== "post-tea-b"; }));

  // Filter by a tag with no published matches yields empty list.
  var bogus = await ctx.blog.listPublished({ tag: "matcha" });
  check("tag filter matcha empty",                bogus.rows.length === 0);

  // Cursor round-trip with limit=1 paginates through coffee posts.
  var p1 = await ctx.blog.listPublished({ tag: "coffee", limit: 1 });
  check("tag filter coffee page1 size",           p1.rows.length === 1);
  check("tag filter coffee page1 cursor set",     typeof p1.next_cursor === "string");
  var p2 = await ctx.blog.listPublished({ tag: "coffee", limit: 1, cursor: p1.next_cursor });
  check("tag filter coffee page2 size",           p2.rows.length === 1);
  check("tag filter coffee page2 different",      p2.rows[0].slug !== p1.rows[0].slug);

  // Tampered cursor refused.
  await assert.rejects(
    ctx.blog.listPublished({ cursor: "not-a-real-cursor" }),
    /cursor/,
  );
}

// ---- relatedArticles tag-overlap ranking -------------------------------

async function _relatedArticlesRanking() {
  var ctx = _setup();

  await ctx.blog.createDraft({
    slug:      "anchor",
    title:     "Anchor",
    body:      "Anchor body.",
    author_id: "ed-editor",
    tags:      ["coffee", "espresso", "guides"],
  });
  await ctx.blog.createDraft({
    slug:      "candidate-3-overlap",
    title:     "Three overlap",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["coffee", "espresso", "guides"],
  });
  await ctx.blog.createDraft({
    slug:      "candidate-2-overlap-a",
    title:     "Two overlap A",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["coffee", "espresso"],
  });
  await ctx.blog.createDraft({
    slug:      "candidate-2-overlap-b",
    title:     "Two overlap B",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["coffee", "guides"],
  });
  await ctx.blog.createDraft({
    slug:      "candidate-1-overlap",
    title:     "One overlap",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["coffee"],
  });
  await ctx.blog.createDraft({
    slug:      "candidate-no-overlap",
    title:     "No overlap",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["tea"],
  });
  // Draft + archived candidates should be excluded.
  await ctx.blog.createDraft({
    slug:      "candidate-draft",
    title:     "Draft candidate",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["coffee", "espresso", "guides"],
  });
  await ctx.blog.createDraft({
    slug:      "candidate-archived",
    title:     "Archived candidate",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["coffee", "espresso", "guides"],
  });

  await ctx.blog.publish("anchor");
  await ctx.blog.publish("candidate-3-overlap");
  await ctx.blog.publish("candidate-2-overlap-a");
  await ctx.blog.publish("candidate-2-overlap-b");
  await ctx.blog.publish("candidate-1-overlap");
  await ctx.blog.publish("candidate-no-overlap");
  await ctx.blog.publish("candidate-archived");
  await ctx.blog.archive("candidate-archived");

  var related = await ctx.blog.relatedArticles({ slug: "anchor", limit: 10 });
  // Anchor itself never appears.
  check("relatedArticles excludes anchor",        related.every(function (r) { return r.slug !== "anchor"; }));
  // Draft + archived candidates excluded.
  check("relatedArticles excludes draft",         related.every(function (r) { return r.slug !== "candidate-draft"; }));
  check("relatedArticles excludes archived",      related.every(function (r) { return r.slug !== "candidate-archived"; }));
  // No-overlap excluded (overlap == 0 -> drop).
  check("relatedArticles excludes zero overlap",  related.every(function (r) { return r.slug !== "candidate-no-overlap"; }));
  // Top is the 3-overlap candidate.
  check("relatedArticles top is 3-overlap",       related[0].slug === "candidate-3-overlap");
  check("relatedArticles top overlap is 3",       related[0].overlap === 3);
  // Next two carry overlap 2.
  check("relatedArticles 2nd overlap is 2",       related[1].overlap === 2);
  check("relatedArticles 3rd overlap is 2",       related[2].overlap === 2);
  // Last surfaced is the 1-overlap candidate.
  check("relatedArticles last is 1-overlap",      related[related.length - 1].slug === "candidate-1-overlap");

  // limit honored.
  var topTwo = await ctx.blog.relatedArticles({ slug: "anchor", limit: 2 });
  check("relatedArticles limit honored",          topTwo.length === 2);

  // Anchor with no tags surfaces nothing (no ranker signal).
  await ctx.blog.createDraft({
    slug:      "tagless-anchor",
    title:     "Tagless",
    body:      "Body.",
    author_id: "ed-editor",
  });
  await ctx.blog.publish("tagless-anchor");
  var none = await ctx.blog.relatedArticles({ slug: "tagless-anchor" });
  check("relatedArticles tagless anchor empty",   none.length === 0);

  // Non-existent anchor -> empty (no throw).
  var nope = await ctx.blog.relatedArticles({ slug: "nope-not-here" });
  check("relatedArticles unknown anchor empty",   nope.length === 0);
}

// ---- recordView increments + hashes session ----------------------------

async function _recordViewIncrementsAndHashes() {
  var ctx = _setup();
  await ctx.blog.createDraft({
    slug:      "view-test",
    title:     "Viewable",
    body:      "Body.",
    author_id: "ed-editor",
  });
  await ctx.blog.publish("view-test");

  // First view bumps to 1.
  var v1 = await ctx.blog.recordView({ slug: "view-test", session_id: "session-abc" });
  check("recordView returns slug",                v1.slug === "view-test");
  check("recordView returns occurred_at",          typeof v1.occurred_at === "number");

  var post = await ctx.blog.get("view-test");
  check("view_count incremented to 1",            post.view_count === 1);

  // Three more views from distinct sessions.
  await ctx.blog.recordView({ slug: "view-test", session_id: "session-bcd" });
  await ctx.blog.recordView({ slug: "view-test", session_id: "session-cde" });
  await ctx.blog.recordView({ slug: "view-test" });   // anonymous

  post = await ctx.blog.get("view-test");
  check("view_count incremented to 4",            post.view_count === 4);

  // Raw session_id NEVER on disk — only the namespaceHash.
  var viewRows = ctx.db.prepare(
    "SELECT session_id_hash FROM blog_article_views WHERE slug = ? ORDER BY occurred_at ASC"
  ).all("view-test");
  check("view-log row count matches",             viewRows.length === 4);
  check("first view session hashed",              typeof viewRows[0].session_id_hash === "string"
                                                  && viewRows[0].session_id_hash.length > 0
                                                  && viewRows[0].session_id_hash !== "session-abc");
  check("anonymous view has null hash",           viewRows[3].session_id_hash === null);

  // Unknown slug refused.
  await assert.rejects(
    ctx.blog.recordView({ slug: "nonexistent" }),
    function (err) { return err && err.code === "BLOG_ARTICLE_NOT_FOUND"; },
  );

  // popularArticles aggregates the window.
  var pop = await ctx.blog.popularArticles({ from: 0, to: Date.now() + 60000, limit: 5 });
  check("popularArticles top is view-test",       pop.length === 1 && pop[0].slug === "view-test");
  check("popularArticles top views is 4",         pop[0].views === 4);
}

// ---- renderHtml escapes hostile body -----------------------------------

async function _renderHtmlEscapesHostileBody() {
  var ctx = _setup();
  var hostileBody = [
    "## Heading <script>alert(1)</script>",
    "",
    "An [evil link](javascript:alert(1)) followed by a [safe one](https://example.com/).",
    "",
    "An [evil image link](vbscript:msgbox) and a [data-uri link](data:text/html,<script>alert(1)</script>).",
    "",
    "An <img src=x onerror=alert(1)> attempt.",
    "",
    "Inline `code <script>` is escaped too.",
    "",
    "**Bold with <iframe src=evil></iframe>** inside.",
  ].join("\n");

  await ctx.blog.createDraft({
    slug:      "hostile-body",
    title:     "Hostile",
    body:      hostileBody,
    author_id: "ed-editor",
  });

  var html = await ctx.blog.renderHtml({ slug: "hostile-body" });

  // No live <script> survives.
  check("renderHtml drops <script>",              html.indexOf("<script") === -1);
  check("renderHtml drops <iframe>",              html.indexOf("<iframe") === -1);
  // Raw `<` is escaped to `&lt;`.
  check("renderHtml escapes raw <",               html.indexOf("&lt;script") !== -1
                                                  || html.indexOf("&lt;/script") !== -1);
  // Hostile link protocols dropped from href (anchor text survives
  // as escaped text).
  check("renderHtml drops javascript: href",      html.indexOf('href="javascript:') === -1);
  check("renderHtml drops vbscript: href",        html.indexOf('href="vbscript:') === -1);
  check("renderHtml drops data: href",            html.indexOf('href="data:') === -1);
  // Safe https:// link survives in a real anchor.
  check("renderHtml keeps https:// link",         html.indexOf('href="https://example.com/"') !== -1);
  // The `onerror=` attribute never appears as a live HTML attribute —
  // any `<` in the body is escaped before reaching the output.
  check("renderHtml has no live onerror attr",    html.indexOf("<img src=x onerror") === -1);

  // Missing slug throws (config-tier: an operator bug).
  await assert.rejects(
    ctx.blog.renderHtml({ slug: "no-such-post" }),
    /not found/,
  );
}

// ---- byAuthor ----------------------------------------------------------

async function _byAuthorListing() {
  var ctx = _setup();

  await ctx.blog.createDraft({
    slug:      "by-alice-published-1",
    title:     "Alice One",
    body:      "Body.",
    author_id: "alice",
  });
  await ctx.blog.createDraft({
    slug:      "by-alice-published-2",
    title:     "Alice Two",
    body:      "Body.",
    author_id: "alice",
  });
  await ctx.blog.createDraft({
    slug:      "by-alice-draft",
    title:     "Alice Draft",
    body:      "Body.",
    author_id: "alice",
  });
  await ctx.blog.createDraft({
    slug:      "by-bob-published",
    title:     "Bob One",
    body:      "Body.",
    author_id: "bob",
  });
  await ctx.blog.publish("by-alice-published-1");
  await ctx.blog.publish("by-alice-published-2");
  await ctx.blog.publish("by-bob-published");

  // Default: published only.
  var alice = await ctx.blog.byAuthor({ author_id: "alice" });
  check("byAuthor default published-only count", alice.length === 2);
  check("byAuthor default excludes drafts",      alice.every(function (r) { return r.status === "published"; }));

  // status=all surfaces the draft too.
  var aliceAll = await ctx.blog.byAuthor({ author_id: "alice", status: "all" });
  check("byAuthor status=all count",             aliceAll.length === 3);

  // status=draft filters narrowly.
  var aliceDraft = await ctx.blog.byAuthor({ author_id: "alice", status: "draft" });
  check("byAuthor status=draft count",           aliceDraft.length === 1
                                                 && aliceDraft[0].slug === "by-alice-draft");

  // Unknown author -> empty.
  var unknown = await ctx.blog.byAuthor({ author_id: "carol" });
  check("byAuthor unknown empty",                unknown.length === 0);

  // Bad status refused.
  await assert.rejects(
    ctx.blog.byAuthor({ author_id: "alice", status: "purgatory" }),
    /status must be one of/,
  );
}

// ---- update + hostile hero_image_url -----------------------------------

async function _updateAndHostileHeroUrl() {
  var ctx = _setup();
  await ctx.blog.createDraft({
    slug:      "patchable",
    title:     "Patchable",
    body:      "Body.",
    author_id: "ed-editor",
    tags:      ["a", "b"],
  });

  // Patch tags + title + hero_image_url + featured_product_ids in one call.
  var patched = await ctx.blog.update("patchable", {
    title:                "Patched title",
    tags:                 ["c", "d", "e"],
    hero_image_url:       "https://cdn.example.com/new.jpg",
    featured_product_ids: ["sku-new"],
  });
  check("update applies title",                  patched.title === "Patched title");
  check("update applies tags",                   JSON.stringify(patched.tags) === '["c","d","e"]');
  check("update applies hero_image_url",          patched.hero_image_url === "https://cdn.example.com/new.jpg");
  check("update applies featured_product_ids",    JSON.stringify(patched.featured_product_ids) === '["sku-new"]');
  check("update stamps updated_at change",        patched.updated_at >= patched.created_at);

  // Relative `/`-path hero accepted.
  var localHero = await ctx.blog.update("patchable", {
    hero_image_url: "/static/blog/hero.jpg",
  });
  check("update accepts /-rooted hero",           localHero.hero_image_url === "/static/blog/hero.jpg");

  // Hostile hero_image_url refused (every shape safeUrl drops).
  await assert.rejects(
    ctx.blog.update("patchable", { hero_image_url: "javascript:alert(1)" }),
    /hero_image_url/,
  );
  await assert.rejects(
    ctx.blog.update("patchable", { hero_image_url: "data:text/html,<script>" }),
    /hero_image_url/,
  );
  await assert.rejects(
    ctx.blog.update("patchable", { hero_image_url: "http://insecure.example/" }),
    /hero_image_url/,
  );
  await assert.rejects(
    ctx.blog.update("patchable", { hero_image_url: "//cdn.example.com/img.jpg" }),
    /protocol-relative/,
  );
  await assert.rejects(
    ctx.blog.update("patchable", { hero_image_url: "/../etc/passwd" }),
    /'\.\.'/,
  );

  // Unsupported patch column refused.
  await assert.rejects(
    ctx.blog.update("patchable", { status: "published" }),
    /unsupported column/,
  );

  // Patch against missing slug refused.
  await assert.rejects(
    ctx.blog.update("nope", { title: "x" }),
    function (err) { return err && err.code === "BLOG_ARTICLE_NOT_FOUND"; },
  );
}

// ---- validation surface ------------------------------------------------

async function _validationSurface() {
  var ctx = _setup();

  // createDraft
  await assert.rejects(ctx.blog.createDraft(),                                       /input object required/);
  await assert.rejects(ctx.blog.createDraft({}),                                     /slug/);
  await assert.rejects(ctx.blog.createDraft({ slug: "Bad Slug" }),                   /slug/);
  await assert.rejects(ctx.blog.createDraft({ slug: "ok" }),                         /title/);
  await assert.rejects(ctx.blog.createDraft({ slug: "ok", title: "T" }),             /body/);
  await assert.rejects(ctx.blog.createDraft({
    slug: "ok", title: "T", body: "B",
  }), /author_id/);
  await assert.rejects(ctx.blog.createDraft({
    slug: "ok", title: "T", body: "B", author_id: "ed", tags: ["Bad Tag"],
  }), /tags\[0\]/);
  await assert.rejects(ctx.blog.createDraft({
    slug: "ok", title: "T", body: "B", author_id: "ed",
    featured_product_ids: ["bad product"],
  }), /featured_product_ids\[0\]/);
  // title with CR/LF refused.
  await assert.rejects(ctx.blog.createDraft({
    slug: "ok", title: "Line1\nLine2", body: "B", author_id: "ed",
  }), /title contains a line break or tab/);
  // body with control bytes refused (LF is fine; \x00 is not).
  await assert.rejects(ctx.blog.createDraft({
    slug: "ok", title: "T", body: "Body with \x00 null", author_id: "ed",
  }), /body contains a null byte/);

  // get / getPublished
  await assert.rejects(ctx.blog.get(undefined),                                      /slug/);
  await assert.rejects(ctx.blog.getPublished("Bad Slug"),                            /slug/);

  // recordView
  await assert.rejects(ctx.blog.recordView(),                                        /input object required/);
  await assert.rejects(ctx.blog.recordView({}),                                      /slug/);
  await ctx.blog.createDraft({ slug: "vs", title: "VS", body: "B", author_id: "ed" });
  await ctx.blog.publish("vs");
  await assert.rejects(ctx.blog.recordView({ slug: "vs", session_id: "" }),          /session_id/);
  await assert.rejects(ctx.blog.recordView({ slug: "vs", session_id: "x\x00y" }),    /session_id/);

  // listPublished
  await assert.rejects(ctx.blog.listPublished({ limit: 0 }),                         /limit/);
  await assert.rejects(ctx.blog.listPublished({ limit: 99999 }),                     /limit/);
  await assert.rejects(ctx.blog.listPublished({ tag: "Bad Tag" }),                   /tag\[0\]/);

  // relatedArticles
  await assert.rejects(ctx.blog.relatedArticles(),                                   /input object required/);
  await assert.rejects(ctx.blog.relatedArticles({ slug: "ok", limit: 0 }),           /limit/);

  // byAuthor
  await assert.rejects(ctx.blog.byAuthor(),                                          /input object required/);
  await assert.rejects(ctx.blog.byAuthor({ author_id: "" }),                         /author_id/);

  // popularArticles
  await assert.rejects(ctx.blog.popularArticles(),                                   /input object required/);
  await assert.rejects(ctx.blog.popularArticles({ from: -1, to: 0 }),                /from/);
  await assert.rejects(ctx.blog.popularArticles({ from: 100, to: 50 }),              /from must be <= to/);

  // renderHtml
  await assert.rejects(ctx.blog.renderHtml(),                                        /input object required/);
  await assert.rejects(ctx.blog.renderHtml({ slug: "Bad Slug" }),                    /slug/);

  // update
  await assert.rejects(ctx.blog.update("ok"),                                        /patch object required/);
  await assert.rejects(ctx.blog.update("ok", {}),                                    /at least one column/);

  // create() rejects bad customers handle.
  await assert.rejects(
    Promise.resolve().then(function () {
      return blogArticles.create({ query: _makeQuery().query, customers: 42 });
    }),
    /customers/,
  );
}

// ---- exported constants ------------------------------------------------

async function _exportedConstants() {
  check("MAX_SLUG_LEN exported",                  blogArticles.MAX_SLUG_LEN === 120);
  check("MAX_TITLE_LEN exported",                 blogArticles.MAX_TITLE_LEN === 200);
  check("MAX_BODY_LEN exported",                  blogArticles.MAX_BODY_LEN === 200000);
  check("ALLOWED_STATUSES exported",              Array.isArray(blogArticles.ALLOWED_STATUSES)
                                                  && blogArticles.ALLOWED_STATUSES.indexOf("draft") !== -1
                                                  && blogArticles.ALLOWED_STATUSES.indexOf("published") !== -1
                                                  && blogArticles.ALLOWED_STATUSES.indexOf("archived") !== -1);
  check("create is function",                     typeof blogArticles.create === "function");
  check("framework reachable",                    typeof bShop.framework.uuid.v7 === "function");
}

async function run() {
  await _createDraftAndPublishFsm();
  await _listPublishedTagFilter();
  await _relatedArticlesRanking();
  await _recordViewIncrementsAndHashes();
  await _renderHtmlEscapesHostileBody();
  await _byAuthorListing();
  await _updateAndHostileHeroUrl();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - blog-articles (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
