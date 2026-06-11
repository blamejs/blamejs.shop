"use strict";
/**
 * Blog console — browser-side admin authoring for the storefront blog.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * blog), then exercises the full author lifecycle end-to-end and pins the
 * one contract that matters most: a DRAFT never reaches the storefront.
 *
 *   - create a post via the browser form  → 303 PRG to the editor; the
 *     row persists as a DRAFT; it shows in the admin list but is INVISIBLE
 *     to the storefront /blog (index + /blog/:slug both empty for it).
 *   - publish it                          → now visible on the storefront
 *     index AND the per-slug read.
 *   - edit the title                      → persists; the storefront read
 *     reflects the new title.
 *   - unpublish                           → gone from the storefront again.
 *   - re-publish + archive                → gone from the storefront, and
 *     dropped from the editable list's published set.
 *   - the bearer JSON contract, the auth gate, and a bad-slug 404 path.
 *
 * The storefront-visibility oracle is the EDGE Worker's own published-only
 * read (worker/data/catalog.js — getBlogArticleBySlug / listBlogArticles),
 * driven over a D1-shaped shim atop the same in-memory SQLite the admin
 * writes to. The worker module is dynamically imported behind an
 * fs.existsSync guard (worker/ is excluded from the container build
 * context, so an unguarded import would brick the in-image smoke); when
 * it's absent the test runs the worker's exact SQL predicate directly, so
 * the contract is asserted against the literal storefront query either
 * way. Network: zero — no Stripe, no HTTP beyond the admin loopback.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var nodeUrl  = require("node:url");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql", "0189_blog_articles.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }

// One in-memory database shared by the blog primitive (via `query`) and
// the storefront-read shim (via `d1`), so an admin write is visible to the
// storefront read exactly as it is in production (one D1 instance).
function _makeDb() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return db;
}

function _queryFn(db) {
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// A minimal Cloudflare-D1-shaped binding over node:sqlite: `.prepare(sql)
// .bind(...args).all()/.first()`. This is the exact surface the edge
// worker's data layer calls, so the storefront read path runs unchanged.
function _d1Shim(db) {
  return {
    prepare: function (sql) {
      var bound = [];
      var api = {
        bind: function () { bound = Array.prototype.slice.call(arguments); return api; },
        all: async function () {
          var rows = db.prepare(sql).all.apply(db.prepare(sql), bound);
          return { results: rows };
        },
        first: async function () {
          var rows = db.prepare(sql).all.apply(db.prepare(sql), bound);
          return rows.length ? rows[0] : null;
        },
      };
      return api;
    },
  };
}

// Resolve the storefront-read oracle. Prefer the edge Worker's real
// published-only data functions (dynamic ESM import, fs.existsSync-
// guarded). Fall back to the worker's exact SQL predicate when the worker
// tree isn't present (container build context), so the storefront
// contract is asserted against the literal query in both substrates.
async function _storefrontReader(db) {
  var d1 = _d1Shim(db);
  var workerData = nodePath.resolve(__dirname, "..", "..", "worker", "data", "catalog.js");
  if (nodeFs.existsSync(workerData)) {
    var mod = await import(nodeUrl.pathToFileURL(workerData).href);
    return {
      via: "worker",
      bySlug: function (slug) { return mod.getBlogArticleBySlug(d1, slug); },
      list:   async function () { return (await mod.listBlogArticles(d1, { limit: 50 })).rows; },
    };
  }
  // Fallback: the same predicate the worker's getBlogArticleBySlug /
  // listBlogArticles use — status='published' AND published_at IS NOT NULL.
  return {
    via: "predicate",
    bySlug: async function (slug) {
      var rows = db.prepare(
        "SELECT * FROM blog_articles WHERE slug = ?1 AND status = 'published' AND published_at IS NOT NULL"
      ).all(slug);
      return rows.length ? rows[0] : null;
    },
    list: async function () {
      return db.prepare(
        "SELECT slug, title FROM blog_articles WHERE status = 'published' AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 50"
      ).all();
    },
  };
}

async function _run() {
  var db      = _makeDb();
  var query   = _queryFn(db);
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "blog-console" });
  var config  = bShop.config.create({ query: query });
  var blog    = bShop.blogArticles.create({ query: query, cursorSecret: "blog-console" });

  var store = await _storefrontReader(db);

  function _storefrontHas(slug) {
    return store.list().then(function (rows) {
      return rows.some(function (r) { return r.slug === slug; });
    });
  }

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-blog-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, blog: blog, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var SLUG = "first-post";

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // Empty list renders the page + the nav link; the storefront is empty.
    var empty = await helpers.httpRequest({ port: port, path: "/admin/blog", jar: jar });
    check("blog page then 200",                  empty.status === 200);
    check("nav includes Blog",                   empty.body.indexOf("\"/admin/blog\"") !== -1);
    check("empty state shown",                   empty.body.indexOf("No posts") !== -1);
    check("storefront empty to start",           (await store.list()).length === 0);

    // The new-post form renders the create form.
    var newForm = await helpers.httpRequest({ port: port, path: "/admin/blog/new", jar: jar });
    check("new-post form then 200",              newForm.status === 200);
    check("new-post form has a body field",      newForm.body.indexOf("name=\"body\"") !== -1);

    // Create a post via the browser form → 303 PRG to the editor.
    var created = await helpers.httpRequest({
      port: port, path: "/admin/blog", method: "POST", jar: jar,
      form: {
        slug: SLUG, title: "First Post", author_id: "ed",
        body: "# Hello\n\nThis is the **first** post.", tags: "news, guides",
        meta_description: "An intro post.",
      },
    });
    check("create then 303",                     created.status === 303);
    check("create redirects to the editor",      (created.headers.location || "").indexOf("/admin/blog/" + SLUG) !== -1);

    // It persisted as a DRAFT.
    var row = await blog.get(SLUG);
    check("post persisted",                      !!row);
    check("post is a DRAFT on create",           row.status === "draft");
    check("post body persisted",                 row.body.indexOf("first") !== -1);
    check("post tags persisted",                 row.tags.indexOf("news") !== -1 && row.tags.indexOf("guides") !== -1);

    // It shows in the admin list...
    var listed = await helpers.httpRequest({ port: port, path: "/admin/blog", jar: jar });
    check("admin list shows the draft",          listed.body.indexOf("First Post") !== -1 && listed.body.indexOf(SLUG) !== -1);
    check("admin list marks it draft",           listed.body.indexOf(">draft<") !== -1);

    // ...but the storefront does NOT show a draft.
    check("draft NOT on storefront index",       !(await _storefrontHas(SLUG)));
    check("draft NOT on storefront /blog/:slug", (await store.bySlug(SLUG)) == null);

    // Publish it → 303 back to the editor with the published banner flag.
    var pub = await helpers.httpRequest({ port: port, path: "/admin/blog/" + SLUG + "/publish", method: "POST", jar: jar });
    check("publish then 303",                    pub.status === 303);
    check("publish flags published",             (pub.headers.location || "").indexOf("published=1") !== -1);
    check("post now published",                  (await blog.get(SLUG)).status === "published");

    // Now it IS on the storefront — index + per-slug.
    check("published post on storefront index",  await _storefrontHas(SLUG));
    var sfRow = await store.bySlug(SLUG);
    check("published post on /blog/:slug",        sfRow != null && sfRow.slug === SLUG);
    check("storefront shows the title",           sfRow.title === "First Post");

    // Edit the title via the browser form → 303 updated; persists + the
    // storefront read reflects it.
    var edit = await helpers.httpRequest({
      port: port, path: "/admin/blog/" + SLUG + "/edit", method: "POST", jar: jar,
      form: { title: "First Post (revised)", author_id: "ed", body: "# Hello\n\nRevised body.", tags: "news" },
    });
    check("edit then 303",                       edit.status === 303);
    check("edit flags updated",                  (edit.headers.location || "").indexOf("updated=1") !== -1);
    check("title persisted",                     (await blog.get(SLUG)).title === "First Post (revised)");
    check("edit stays published",                (await blog.get(SLUG)).status === "published");
    check("storefront reflects the new title",   (await store.bySlug(SLUG)).title === "First Post (revised)");

    // Unpublish → 303; gone from the storefront, back to draft.
    var unpub = await helpers.httpRequest({ port: port, path: "/admin/blog/" + SLUG + "/unpublish", method: "POST", jar: jar });
    check("unpublish then 303",                  unpub.status === 303);
    check("post back to draft",                  (await blog.get(SLUG)).status === "draft");
    check("unpublished gone from storefront",    !(await _storefrontHas(SLUG)) && (await store.bySlug(SLUG)) == null);

    // Re-publish, then archive (with the confirm interstitial) → gone from
    // the storefront, and dropped from the published set.
    await helpers.httpRequest({ port: port, path: "/admin/blog/" + SLUG + "/publish", method: "POST", jar: jar });
    check("re-published on storefront",          await _storefrontHas(SLUG));
    var confirm = await helpers.httpRequest({ port: port, path: "/admin/blog/" + SLUG + "/archive/confirm-page", jar: jar });
    check("archive confirm page then 200",       confirm.status === 200);
    check("archive confirm names the action",    confirm.body.indexOf("/admin/blog/" + SLUG + "/archive") !== -1);
    var archive = await helpers.httpRequest({ port: port, path: "/admin/blog/" + SLUG + "/archive", method: "POST", jar: jar });
    check("archive then 303",                    archive.status === 303);
    check("archive lands on the list",           (archive.headers.location || "").indexOf("archived=1") !== -1);
    check("post now archived",                   (await blog.get(SLUG)).status === "archived");
    check("archived gone from storefront",       !(await _storefrontHas(SLUG)) && (await store.bySlug(SLUG)) == null);

    // Restore → back to draft (still off the storefront).
    var restore = await helpers.httpRequest({ port: port, path: "/admin/blog/" + SLUG + "/restore", method: "POST", jar: jar });
    check("restore then 303",                    restore.status === 303);
    check("restored to draft",                   (await blog.get(SLUG)).status === "draft");
    check("restored still off storefront",       !(await _storefrontHas(SLUG)));

    // The bearer JSON contract: create returns 201, list returns rows.
    var apiCreate = await helpers.httpRequest({
      port: port, path: "/admin/blog", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "api-post", title: "API Post", author_id: "ed", body: "Made over the API." }),
    });
    check("bearer create returns 201 JSON",      apiCreate.status === 201 && (apiCreate.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer-made post is a draft",         JSON.parse(apiCreate.body).status === "draft");
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/blog", headers: bearer });
    check("blog API still JSON",                 (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    check("blog API returns both posts",         JSON.parse(apiList.body).rows.length === 2);

    // A bad-shape create (missing body) re-renders the form with the
    // validator's message, not a 500.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/blog", method: "POST", jar: jar,
      form: { slug: "no-body", title: "No Body", author_id: "ed" },
    });
    check("bad create then 400",                 bad.status === 400);
    check("bad create surfaces validator msg",   bad.body.indexOf("body") !== -1);

    // A bad / unknown slug is a 404 page (notice), never a 500.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/blog/does-not-exist", jar: jar });
    check("unknown slug then 404",               miss.status === 404);
    check("unknown slug shows not-found notice", miss.body.indexOf("not found") !== -1);
    var badSlug = await helpers.httpRequest({ port: port, path: "/admin/blog/Bad_Slug!", jar: jar });
    check("malformed slug not a 500",            badSlug.status === 404);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/blog" });
    check("anon blog → login form",              anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { db.close(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
