"use strict";
/**
 * storefrontPages — operator-authored CMS pages with a Markdown body
 * and a draft → published → archived publish FSM.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0059_storefront_pages.sql alone — the primitive has no FKs into
 * the rest of the schema, so the test runs against a minimal in-
 * memory database with just the storefront_pages table.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/storefront-pages.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineDraft happy path persists every input field, version 1,
 *     status "draft", published_at + archived_at null
 *   - defineDraft refuses bad slug shape, bad layout enum, control
 *     bytes in title / body, missing input object
 *   - FSM happy path: draft -> publish -> unpublish -> publish ->
 *     archive -> restore, each transition stamps the matching
 *     wall-clock column
 *   - FSM refusals: every illegal transition is refused with an
 *     error naming the current status (publish-from-published,
 *     unpublish-from-draft, archive-from-draft, restore-from-draft)
 *   - update increments version, persists patched columns, leaves
 *     untouched columns alone; refuses unsupported columns
 *   - renderHtml safety: hostile body containing <script> tags,
 *     <img onerror=...>, javascript: links, and protocol-relative
 *     URLs survives as inert escaped HTML
 *   - renderHtml correctly emits paragraphs, headings, lists, inline
 *     code, emphasis, and safe https links
 *   - listPublished / listDrafts / listArchived filter by FSM state
 *     and return the expected ordering
 *   - get / getPublished — getPublished returns null for non-published
 *     statuses
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var storefrontPages = require("../../lib/storefront-pages");
var helpers         = require("../helpers");
var check           = helpers.check;
var assert          = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0059_storefront_pages.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _setup() {
  var query = _makeQuery();
  var pages = storefrontPages.create({ query: query });
  return { query: query, pages: pages };
}

// ---- defineDraft happy path --------------------------------------------

async function _defineHappy() {
  var ctx = _setup();
  var p = await ctx.pages.defineDraft({
    slug:             "about",
    title:            "About blamejs.shop",
    body:             "# About\n\nWe sell stuff.\n\nVisit our [home page](https://example.com/).",
    meta_description: "Learn about blamejs.shop and our mission.",
    meta_keywords:    "blamejs, shop, ecommerce, open-source",
    layout:           "default",
  });
  check("defineDraft persists slug",             p.slug === "about");
  check("defineDraft persists title",            p.title === "About blamejs.shop");
  check("defineDraft persists body",             p.body.indexOf("We sell stuff.") !== -1);
  check("defineDraft persists meta_description", p.meta_description === "Learn about blamejs.shop and our mission.");
  check("defineDraft persists meta_keywords",    p.meta_keywords === "blamejs, shop, ecommerce, open-source");
  check("defineDraft persists layout",           p.layout === "default");
  check("defineDraft sets version=1",            p.version === 1);
  check("defineDraft sets status=draft",         p.status === "draft");
  check("defineDraft published_at null",         p.published_at === null);
  check("defineDraft archived_at null",          p.archived_at === null);
  check("defineDraft stamps created_at",         typeof p.created_at === "number" && p.created_at > 0);
  check("defineDraft updated_at = created_at",   p.updated_at === p.created_at);

  // layout defaults to "default" when omitted; meta_* nullable.
  var p2 = await ctx.pages.defineDraft({
    slug:  "shipping",
    title: "Shipping",
    body:  "Ships in 1-2 business days.",
  });
  check("defineDraft defaults layout to default", p2.layout === "default");
  check("defineDraft meta_description nullable",  p2.meta_description === null);
  check("defineDraft meta_keywords nullable",     p2.meta_keywords === null);

  // wide / landing / legal layouts all valid.
  var p3 = await ctx.pages.defineDraft({
    slug: "privacy", title: "Privacy", body: "We respect your privacy.", layout: "legal",
  });
  check("defineDraft accepts layout=legal", p3.layout === "legal");
}

// ---- defineDraft refusals ----------------------------------------------

async function _defineRefusals() {
  var ctx = _setup();

  // Missing input object.
  await assert.rejects(ctx.pages.defineDraft(), /input object required/);

  // Bad slug shape — leading hyphen.
  await assert.rejects(ctx.pages.defineDraft({
    slug: "-leading", title: "x", body: "y",
  }), /slug/);

  // Bad slug shape — has a space.
  await assert.rejects(ctx.pages.defineDraft({
    slug: "has space", title: "x", body: "y",
  }), /slug/);

  // Bad layout enum.
  await assert.rejects(ctx.pages.defineDraft({
    slug: "bad-layout", title: "x", body: "y", layout: "kitchen-sink",
  }), /layout must be one of/);

  // Empty title.
  await assert.rejects(ctx.pages.defineDraft({
    slug: "no-title", title: "", body: "y",
  }), /title/);

  // Empty body.
  await assert.rejects(ctx.pages.defineDraft({
    slug: "no-body", title: "x", body: "",
  }), /body/);

  // Control byte in title.
  await assert.rejects(ctx.pages.defineDraft({
    slug: "ctrl-title", title: "bad\x00byte", body: "y",
  }), /title/);

  // Control byte in body (NUL — even body refuses NULs).
  await assert.rejects(ctx.pages.defineDraft({
    slug: "ctrl-body", title: "x", body: "bad\x00byte",
  }), /body/);

  // Zero-width in title.
  await assert.rejects(ctx.pages.defineDraft({
    slug: "zw-title", title: "Sneaky​space", body: "y",
  }), /title/);

  // CR/LF in meta_description refused (single-line field).
  await assert.rejects(ctx.pages.defineDraft({
    slug: "crlf-meta", title: "x", body: "y", meta_description: "one\ntwo",
  }), /meta_description/);
}

// ---- FSM happy path ----------------------------------------------------

async function _fsmHappy() {
  var ctx = _setup();
  await ctx.pages.defineDraft({ slug: "terms", title: "Terms", body: "Read this." });

  var d = await ctx.pages.get("terms");
  check("initial status is draft", d.status === "draft");
  check("initial published_at null", d.published_at === null);
  check("initial archived_at null",  d.archived_at === null);

  // publish: draft -> published, stamps published_at.
  var published = await ctx.pages.publish("terms");
  check("publish moves to published",        published.status === "published");
  check("publish stamps published_at",       typeof published.published_at === "number" && published.published_at > 0);
  check("publish leaves archived_at null",   published.archived_at === null);
  var firstPublishedAt = published.published_at;

  // unpublish: published -> draft, preserves published_at.
  var unpublished = await ctx.pages.unpublish("terms");
  check("unpublish moves to draft",          unpublished.status === "draft");
  check("unpublish preserves published_at",  unpublished.published_at === firstPublishedAt);

  // re-publish: draft -> published, preserves published_at (the
  // historical "first went live" timestamp doesn't reset).
  var rePublished = await ctx.pages.publish("terms");
  check("re-publish stays at first published_at", rePublished.published_at === firstPublishedAt);
  check("re-publish status is published",         rePublished.status === "published");

  // archive: published -> archived, stamps archived_at.
  var archived = await ctx.pages.archive("terms");
  check("archive moves to archived",          archived.status === "archived");
  check("archive stamps archived_at",         typeof archived.archived_at === "number" && archived.archived_at > 0);

  // restore: archived -> draft, clears archived_at.
  var restored = await ctx.pages.restore("terms");
  check("restore moves to draft",             restored.status === "draft");
  check("restore clears archived_at",         restored.archived_at === null);
  check("restore preserves published_at",     restored.published_at === firstPublishedAt);
}

// ---- FSM refusals ------------------------------------------------------

async function _fsmRefusals() {
  var ctx = _setup();
  await ctx.pages.defineDraft({ slug: "returns", title: "Returns", body: "30-day window." });

  // Publish from draft — fine (sanity).
  await ctx.pages.publish("returns");

  // Publish-from-published refused.
  await assert.rejects(ctx.pages.publish("returns"), /publish requires status one of/);

  // Archive from published — fine.
  await ctx.pages.archive("returns");

  // Archive-from-archived refused.
  await assert.rejects(ctx.pages.archive("returns"), /archive requires status one of/);

  // Unpublish-from-archived refused.
  await assert.rejects(ctx.pages.unpublish("returns"), /unpublish requires status one of/);

  // Publish-from-archived refused (archived must restore first).
  await assert.rejects(ctx.pages.publish("returns"), /publish requires status one of/);

  // Restore to draft, then verify restore-from-draft is refused.
  await ctx.pages.restore("returns");
  await assert.rejects(ctx.pages.restore("returns"), /restore requires status one of/);

  // Unpublish-from-draft refused.
  await assert.rejects(ctx.pages.unpublish("returns"), /unpublish requires status one of/);

  // Archive-from-draft refused.
  await assert.rejects(ctx.pages.archive("returns"), /archive requires status one of/);

  // Operations on unknown slug.
  await assert.rejects(ctx.pages.publish("never-existed"),   /not found/);
  await assert.rejects(ctx.pages.unpublish("never-existed"), /not found/);
  await assert.rejects(ctx.pages.archive("never-existed"),   /not found/);
  await assert.rejects(ctx.pages.restore("never-existed"),   /not found/);
}

// ---- update: version + columns -----------------------------------------

async function _updatePatch() {
  var ctx = _setup();
  await ctx.pages.defineDraft({
    slug: "u1", title: "Original", body: "Original body.", layout: "default",
  });

  var original = await ctx.pages.get("u1");
  check("initial version is 1", original.version === 1);

  // Patch title + body.
  var u1 = await ctx.pages.update("u1", {
    title: "Updated Title",
    body:  "Updated body content.",
  });
  check("update persists title",         u1.title === "Updated Title");
  check("update persists body",          u1.body === "Updated body content.");
  check("update bumps version to 2",     u1.version === 2);
  check("update preserves slug",         u1.slug === "u1");
  check("update preserves layout",       u1.layout === "default");
  check("update preserves status=draft", u1.status === "draft");

  // Each update increments version.
  var u2 = await ctx.pages.update("u1", { meta_description: "New SEO desc." });
  check("second update bumps version to 3",       u2.version === 3);
  check("second update persists meta_description", u2.meta_description === "New SEO desc.");

  var u3 = await ctx.pages.update("u1", { layout: "legal" });
  check("layout update bumps version to 4", u3.version === 4);
  check("layout update persists layout",    u3.layout === "legal");

  // Unsupported column refused.
  await assert.rejects(ctx.pages.update("u1", {
    status: "published",
  }), /unsupported column/);

  // Status / version / published_at are NOT in the patch surface.
  await assert.rejects(ctx.pages.update("u1", {
    version: 99,
  }), /unsupported column/);
  await assert.rejects(ctx.pages.update("u1", {
    published_at: Date.now(),
  }), /unsupported column/);

  // Empty patch refused.
  await assert.rejects(ctx.pages.update("u1", {}), /at least one column/);

  // Unknown slug refused.
  await assert.rejects(ctx.pages.update("u-ghost", { title: "x" }), /not found/);

  // Bad-value patch refused — empty title rejected.
  await assert.rejects(ctx.pages.update("u1", { title: "" }), /title/);
  await assert.rejects(ctx.pages.update("u1", { layout: "bogus" }), /layout/);
}

// ---- renderHtml safety -------------------------------------------------

async function _renderSafety() {
  var ctx = _setup();

  // Hostile body — every common XSS vector smuggled into the
  // operator-authored Markdown. renderHtml must neutralize each one.
  await ctx.pages.defineDraft({
    slug: "hostile",
    title: "Hostile",
    body:
      "# Heading <script>alert(1)</script>\n\n" +
      "Paragraph with <img src=x onerror=alert(2)> inside.\n\n" +
      "[Bad link](javascript:alert(3))\n\n" +
      "[Other bad link](data:text/html,<script>x</script>)\n\n" +
      "[Protocol-relative](//evil.example.com/)\n\n" +
      "[Good link](https://example.com/)\n\n" +
      "[Internal link](/about)\n\n" +
      "Inline `<script>alert(4)</script>` code.\n\n" +
      "- list with <svg/onload=alert(5)> item\n" +
      "- second item\n",
  });

  var html = await ctx.pages.renderHtml({ slug: "hostile" });

  // No live <script> tag from the body anywhere in the output.
  check("renderHtml escapes script in heading",   html.indexOf("<script>alert(1)") === -1);
  check("renderHtml escapes script in inline",    html.indexOf("<script>alert(4)") === -1);
  check("renderHtml escapes script in data: URL", html.indexOf("<script>x</script>") === -1);
  // No `onerror` attribute lands on any tag (img onerror=...).
  check("renderHtml escapes img onerror",          !/<img[^>]*onerror=/i.test(html));
  // No `onload` attribute lands on any tag (svg/onload=...).
  check("renderHtml escapes svg onload",           !/<svg[^>]*onload=/i.test(html));

  // The hostile script content survives as inert escaped text.
  check("renderHtml encodes < as &lt;",            html.indexOf("&lt;script&gt;") !== -1);

  // The javascript: URL is dropped — no <a href="javascript:..."> in output.
  check("renderHtml refuses javascript: href",     html.indexOf('href="javascript:') === -1);
  // The data: URL is dropped — no <a href="data:..."> in output.
  check("renderHtml refuses data: href",           html.indexOf('href="data:') === -1);
  // Protocol-relative URL is dropped.
  check("renderHtml refuses //-host href",         html.indexOf('href="//') === -1);

  // The safe https URL renders as a real anchor.
  check("renderHtml emits https link",             html.indexOf('href="https://example.com/"') !== -1);
  // The /-rooted internal link also renders as a real anchor.
  check("renderHtml emits /-rooted link",          html.indexOf('href="/about"') !== -1);

  // Anchor text from the dropped-URL links survives as escaped text
  // (the visitor still sees "Bad link", just not as a clickable link).
  check("renderHtml preserves anchor text for dropped URL", html.indexOf("Bad link") !== -1);
}

// ---- renderHtml correctness --------------------------------------------

async function _renderCorrectness() {
  var ctx = _setup();
  await ctx.pages.defineDraft({
    slug: "render",
    title: "Render",
    body:
      "# H1\n\n" +
      "## H2\n\n" +
      "First paragraph with **bold** and *italic* and `code`.\n\n" +
      "Second paragraph with a [safe link](https://example.com/).\n\n" +
      "- one\n" +
      "- two\n" +
      "- three\n\n" +
      "1. first\n" +
      "2. second\n\n" +
      "> a blockquote\n\n" +
      "---\n\n" +
      "Final paragraph.\n",
  });

  var html = await ctx.pages.renderHtml({ slug: "render" });

  check("renders <h1>",                  html.indexOf("<h1>H1</h1>") !== -1);
  check("renders <h2>",                  html.indexOf("<h2>H2</h2>") !== -1);
  check("renders <strong>",              html.indexOf("<strong>bold</strong>") !== -1);
  check("renders <em>",                  html.indexOf("<em>italic</em>") !== -1);
  check("renders <code>",                html.indexOf("<code>code</code>") !== -1);
  check("renders safe https link",       html.indexOf('<a href="https://example.com/">safe link</a>') !== -1);
  check("renders <ul> + <li>",            html.indexOf("<ul>") !== -1 && html.indexOf("<li>one</li>") !== -1);
  check("renders <ol> + <li>",            html.indexOf("<ol>") !== -1 && html.indexOf("<li>first</li>") !== -1);
  check("renders <blockquote>",           html.indexOf("<blockquote><p>a blockquote</p></blockquote>") !== -1);
  check("renders <hr />",                 html.indexOf("<hr />") !== -1);
  check("renders trailing paragraph",     html.indexOf("<p>Final paragraph.</p>") !== -1);

  // renderHtml refuses missing input / unknown slug.
  await assert.rejects(ctx.pages.renderHtml(), /input object required/);
  await assert.rejects(ctx.pages.renderHtml({ slug: "ghost" }), /not found/);
}

// ---- list helpers + filtering ------------------------------------------

async function _listHelpers() {
  var ctx = _setup();

  // Define five pages with distinct statuses.
  await ctx.pages.defineDraft({ slug: "draft-a", title: "Draft A", body: "a" });
  await ctx.pages.defineDraft({ slug: "draft-b", title: "Draft B", body: "b" });
  await ctx.pages.defineDraft({ slug: "pub-1",   title: "Pub 1",   body: "p1" });
  await ctx.pages.defineDraft({ slug: "pub-2",   title: "Pub 2",   body: "p2" });
  await ctx.pages.defineDraft({ slug: "old",     title: "Old",     body: "o" });

  // Publish pub-1 first, then pub-2. listPublished is newest-first
  // so pub-2 should sort before pub-1.
  await ctx.pages.publish("pub-1");
  // Force pub-2's published_at to be strictly later than pub-1's.
  // The wall-clock difference is normally 1ms+ on a real run; on a
  // pathologically fast runner the two stamps could tie. Use
  // waitUntil so the test stays robust without sleeping a fixed
  // budget.
  await helpers.waitUntil(async function () {
    var p1 = await ctx.pages.get("pub-1");
    return Date.now() > p1.published_at;
  }, { label: "wall-clock advance past pub-1.published_at" });
  await ctx.pages.publish("pub-2");

  // Publish old then archive it.
  await ctx.pages.publish("old");
  await ctx.pages.archive("old");

  var drafts    = await ctx.pages.listDrafts();
  var published = await ctx.pages.listPublished();
  var archived  = await ctx.pages.listArchived();

  // listDrafts returns exactly { draft-a, draft-b } in creation order.
  check("listDrafts returns 2 rows",         drafts.length === 2);
  check("listDrafts contains draft-a",       drafts.some(function (p) { return p.slug === "draft-a"; }));
  check("listDrafts contains draft-b",       drafts.some(function (p) { return p.slug === "draft-b"; }));
  check("listDrafts excludes published",     !drafts.some(function (p) { return p.slug === "pub-1"; }));
  check("listDrafts excludes archived",      !drafts.some(function (p) { return p.slug === "old"; }));

  // listPublished returns exactly { pub-1, pub-2 } newest-first.
  check("listPublished returns 2 rows",      published.length === 2);
  check("listPublished newest first",        published[0].slug === "pub-2" && published[1].slug === "pub-1");
  check("listPublished excludes drafts",     !published.some(function (p) { return p.slug === "draft-a"; }));
  check("listPublished excludes archived",   !published.some(function (p) { return p.slug === "old"; }));

  // listArchived returns exactly { old }.
  check("listArchived returns 1 row",        archived.length === 1);
  check("listArchived contains old",         archived[0].slug === "old");

  // getPublished returns null for non-published slugs.
  var draftFetch = await ctx.pages.getPublished("draft-a");
  check("getPublished returns null for draft",      draftFetch === null);
  var archivedFetch = await ctx.pages.getPublished("old");
  check("getPublished returns null for archived",   archivedFetch === null);
  var pubFetch = await ctx.pages.getPublished("pub-1");
  check("getPublished returns row for published",   pubFetch && pubFetch.slug === "pub-1");

  // get returns the row regardless of status.
  var anyDraft = await ctx.pages.get("draft-a");
  check("get returns draft regardless of status", anyDraft.status === "draft");
  var ghost = await ctx.pages.get("never-existed");
  check("get returns null for unknown slug",      ghost === null);
}

async function run() {
  await _defineHappy();
  await _defineRefusals();
  await _fsmHappy();
  await _fsmRefusals();
  await _updatePatch();
  await _renderSafety();
  await _renderCorrectness();
  await _listHelpers();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/storefront-pages.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("storefront-pages: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
