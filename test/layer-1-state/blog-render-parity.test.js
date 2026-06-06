"use strict";
/**
 * Blog body render — edge ↔ container parity.
 *
 * The blog is edge-served: worker/index.js paints /blog/:slug via
 * worker/render/blog.js#renderBlogArticle. The article body is authored in
 * the Markdown subset lib/blog-articles.js documents, and that primitive's
 * renderHtml turns it into sanitized HTML (escape-by-default; https-or-
 * rooted links; no raw HTML passthrough). The edge mirror ports the SAME
 * renderer so the public post page matches what blogArticles.renderHtml
 * produces — a shopper reads the same markup, and the admin preview (which
 * composes the lib primitive) matches the live page.
 *
 * This pins the two together: for the same body, the lib's renderHtml output
 * must equal the body region the edge renderBlogArticle paints, byte-for-
 * byte, and a hostile body must render inert on the edge exactly as it does
 * in the lib.
 *
 * DEPLOY-BRICKER: this test imports worker/render/blog.js, which is EXCLUDED
 * from the container build context (.dockerignore). The fs.existsSync guard
 * + early return BEFORE the import() is mandatory — an unguarded worker
 * import fails the in-image `RUN node test/smoke.js`, fails the Docker
 * build, and bricks every container deploy. Copied from
 * search-faceting-parity.test.js.
 */

var nodePath   = require("node:path");
var nodeFs     = require("node:fs");
var nodeUrl    = require("node:url");
var nodeModule = require("node:module");
var DatabaseSync = require("node:sqlite").DatabaseSync;

var blogArticles = require("../../lib/blog-articles");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0189_blog_articles.sql");

var _jsonHookRegistered = false;
function _registerJsonHook() {
  if (_jsonHookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _jsonHookRegistered = true;
}

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _setup() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var query = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), changes: Number(info.changes) };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  return { db: db, blog: blogArticles.create({ query: query, cursorSecret: "blog-render-parity-secret" }) };
}

// Pull the `<div class="blog-article__body">…</div>` region out of the edge
// article HTML so the comparison is scoped to the rendered body — the chrome
// around it (head meta, byline, JSON-LD) is covered elsewhere.
function _edgeBody(html) {
  var m = html.match(/<div class="blog-article__body">\s*([\s\S]*?)\s*<\/div>/);
  return m ? m[1] : null;
}

async function _run() {
  // worker/ is excluded from the container build context, so the edge mirror
  // isn't present in the in-image smoke gate. Skip there; the full-tree CI
  // run (worker/ present) covers parity.
  var edgePath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "blog.js");
  if (!nodeFs.existsSync(edgePath)) return;
  _registerJsonHook();
  var edge = await import(nodeUrl.pathToFileURL(edgePath).href);

  var ctx = _setup();

  // Body cases exercise every block the Markdown subset supports plus a
  // hostile body. The plural / formatting cases prove the edge interprets
  // Markdown (not raw source); the hostile case proves it stays inert.
  var bodies = [
    {
      slug: "formatted",
      body: [
        "## Heading one",
        "",
        "A paragraph with **bold**, *italic*, and `inline code`.",
        "",
        "- first bullet",
        "- second bullet",
        "",
        "1. step one",
        "2. step two",
        "",
        "> a pulled quote",
        "",
        "---",
        "",
        "A [safe link](https://example.com/) and a [rooted link](/products/x).",
      ].join("\n"),
    },
    {
      slug: "plain",
      body: "Line one wraps into\nthe same paragraph.\n\nA second paragraph stands alone.",
    },
    {
      slug: "hostile",
      body: [
        "## Heading <script>alert(1)</script>",
        "",
        "An [evil link](javascript:alert(1)) and a [safe one](https://example.com/).",
        "",
        "An <img src=x onerror=alert(1)> attempt and **bold with <iframe src=evil></iframe>**.",
      ].join("\n"),
    },
  ];

  for (var i = 0; i < bodies.length; i += 1) {
    await ctx.blog.createDraft({ slug: bodies[i].slug, title: "T", body: bodies[i].body, author_id: "ed-editor" });
    var libHtml = await ctx.blog.renderHtml({ slug: bodies[i].slug });
    var edgeHtml = edge.renderBlogArticle({
      article: { slug: bodies[i].slug, title: "T", body: bodies[i].body, author_id: "ed-editor", published_at: Date.now() },
      shopName: "Acme",
    });
    var edgeBody = _edgeBody(edgeHtml);
    check("blog parity (" + bodies[i].slug + "): edge body region present", edgeBody !== null);
    assert.strictEqual(edgeBody, libHtml, "blog body render parity: " + bodies[i].slug);
    check("blog body render byte-identical (" + bodies[i].slug + ")", true);
  }

  // The formatted case actually rendered Markdown, not escaped source.
  await ctx.blog.createDraft({ slug: "fmt-assert", title: "T", body: "## Hi\n\n**b** and *i*.", author_id: "ed-editor" });
  var fmt = await ctx.blog.renderHtml({ slug: "fmt-assert" });
  check("blog renders heading element", fmt.indexOf("<h2>Hi</h2>") !== -1);
  check("blog renders strong element",  fmt.indexOf("<strong>b</strong>") !== -1);
  check("blog renders em element",      fmt.indexOf("<em>i</em>") !== -1);

  // Hostile body is inert on the edge: no live <script>/<img>/<iframe>, the
  // javascript: href is dropped, the https one survives.
  var hostileEdge = _edgeBody(edge.renderBlogArticle({
    article: { slug: "hostile", title: "T", body: bodies[2].body, author_id: "ed-editor", published_at: Date.now() },
    shopName: "Acme",
  }));
  check("edge blog drops live <script>",   hostileEdge.indexOf("<script") === -1);
  check("edge blog drops live <img",       hostileEdge.indexOf("<img") === -1);
  check("edge blog drops live <iframe",    hostileEdge.indexOf("<iframe") === -1);
  check("edge blog escapes raw <",         hostileEdge.indexOf("&lt;script") !== -1);
  check("edge blog drops javascript: href", hostileEdge.indexOf('href="javascript:') === -1);
  check("edge blog keeps https:// href",   hostileEdge.indexOf('href="https://example.com/"') !== -1);

  console.log("ok - blog-render-parity (" + helpers.getChecks() + " checks)");
}

module.exports = { run: _run };
