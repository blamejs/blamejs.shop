"use strict";
/**
 * Help center (knowledge base) — end-to-end authoring + reading.
 *
 * Boots one b.createApp with BOTH admin.mount and storefront.mount wired
 * with the knowledgeBase dep, against a single in-memory node:sqlite DB, so
 * an admin write is visible to the storefront read exactly as in production
 * (one D1 instance). Exercises the full surface and pins the contracts that
 * matter:
 *
 *   - an operator creates an article via the browser form  → it persists as
 *     a DRAFT (published off); it shows in the admin list but is INVISIBLE
 *     on the storefront /help index AND /help/:slug (404).
 *   - publish it  → now on the /help index AND rendered at /help/:slug, with
 *     the body SAFELY rendered: a body containing < > & and a <script> tag
 *     comes back HTML-escaped (no raw tag), via the primitive's body_html.
 *   - the article page carries a Help breadcrumb + BreadcrumbList JSON-LD.
 *   - a "was this helpful?" vote (POST /help/:slug/vote) records and the
 *     aggregate reflects it; a second vote from the same session dedups.
 *   - an unknown slug is a clean 404 (no raw error / stack leak).
 *   - archive  → gone from /help index and /help/:slug 404s for it again.
 *
 * The vote POST is CSRF-safe: the helpers' httpRequest echoes the captured
 * double-submit cookie as X-CSRF-Token (a prior GET seeds it into the jar),
 * exactly as a real browser submits the `_csrf` field `_wrap` injects.
 *
 * Network: zero — every request lands on 127.0.0.1; no Stripe, no HTTP
 * beyond the loopback app.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql", "0162_knowledge_base.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }

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

async function _run() {
  var db      = _makeDb();
  var query   = _queryFn(db);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "help-flow" });
  var config  = bShop.config.create({ query: query });
  var kb      = bShop.knowledgeBase.create({ query: query, cursorSecret: "help-flow" });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-help-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, knowledgeBase: kb, shop_name: "Test Shop" });
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, order: order, config: { shop_name: "Test Shop" }, knowledgeBase: kb });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var SLUG = "how-to-return";
  // A body that mixes Markdown with bytes that MUST be escaped at the sink:
  // angle brackets, an ampersand, and a literal <script> tag. If any reaches
  // the page unescaped, the assertion below catches it.
  var BODY = "# Returns\n\nEmail us at <support> & we'll help.\n\n<script>alert('x')</script>\n\nSee [our policy](https://example.com/policy).";

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // The admin help page renders with the nav link; the storefront /help is
    // the empty state to start.
    var empty = await helpers.httpRequest({ port: port, path: "/admin/help", jar: jar });
    check("admin help page then 200",            empty.status === 200);
    check("nav includes Help center",            empty.body.indexOf("\"/admin/help\"") !== -1);
    check("admin empty state shown",             empty.body.indexOf("No articles") !== -1);
    var sfEmpty = await helpers.httpRequest({ port: port, path: "/help" });
    check("storefront /help then 200",           sfEmpty.status === 200);
    check("storefront empty state shown",        sfEmpty.body.indexOf("No help articles have been published") !== -1);

    // The new-article form renders the create form.
    var newForm = await helpers.httpRequest({ port: port, path: "/admin/help/new", jar: jar });
    check("new-article form then 200",           newForm.status === 200);
    check("new-article form has a body field",   newForm.body.indexOf("name=\"body\"") !== -1);
    check("new-article form has a category field", newForm.body.indexOf("name=\"category\"") !== -1);

    // Create via the browser form → 303 PRG to the editor.
    var created = await helpers.httpRequest({
      port: port, path: "/admin/help", method: "POST", jar: jar,
      form: { slug: SLUG, title: "How to return", category: "returns", body: BODY, tags: "refunds, delivery" },
    });
    check("create then 303",                     created.status === 303);
    check("create redirects to the editor",      (created.headers.location || "").indexOf("/admin/help/" + SLUG) !== -1);

    // It persisted as a DRAFT (published off).
    var row = await kb.getArticle({ slug: SLUG });
    check("article persisted",                   !!row);
    check("article is a DRAFT on create",        row.published === false);
    check("article category persisted",          row.category === "returns");
    check("article tags persisted",              row.tags.indexOf("refunds") !== -1 && row.tags.indexOf("delivery") !== -1);

    // Shows in the admin list...
    var listed = await helpers.httpRequest({ port: port, path: "/admin/help", jar: jar });
    check("admin list shows the draft",          listed.body.indexOf("How to return") !== -1 && listed.body.indexOf(SLUG) !== -1);
    check("admin list marks it draft",           listed.body.indexOf(">draft<") !== -1);

    // ...but the storefront does NOT show a draft (index + per-slug 404).
    var idxDraft = await helpers.httpRequest({ port: port, path: "/help" });
    check("draft NOT on /help index",            idxDraft.body.indexOf("How to return") === -1);
    var slugDraft = await helpers.httpRequest({ port: port, path: "/help/" + SLUG });
    check("draft /help/:slug → 404",             slugDraft.status === 404);

    // Publish it → 303 to the editor with the published flag.
    var pub = await helpers.httpRequest({ port: port, path: "/admin/help/" + SLUG + "/publish", method: "POST", jar: jar });
    check("publish then 303",                    pub.status === 303);
    check("publish flags published",             (pub.headers.location || "").indexOf("published=1") !== -1);
    check("article now published",               (await kb.getArticle({ slug: SLUG })).published === true);

    // Now it IS on the storefront — index + per-slug.
    var idxPub = await helpers.httpRequest({ port: port, path: "/help" });
    check("published article on /help index",    idxPub.body.indexOf("How to return") !== -1);
    check("/help index links the article",       idxPub.body.indexOf("/help/" + SLUG) !== -1);
    check("/help index groups by category",      idxPub.body.indexOf("returns") !== -1);

    var artJar = helpers.cookieJar();
    var art = await helpers.httpRequest({ port: port, path: "/help/" + SLUG, jar: artJar });
    check("/help/:slug then 200",                art.status === 200);
    check("article shows the title",             art.body.indexOf("How to return") !== -1);

    // BODY SAFETY: the body_html is escaped — the raw <script> tag must NOT
    // appear; its escaped form must. Same for the bare angle brackets + amp.
    check("no raw <script> in the page",         art.body.indexOf("<script>alert(") === -1);
    check("script tag landed escaped",           art.body.indexOf("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;") !== -1);
    check("bare angle bytes landed escaped",     art.body.indexOf("&lt;support&gt;") !== -1);
    check("ampersand landed escaped",            art.body.indexOf("Email us at &lt;support&gt; &amp; we&#x27;ll help.") !== -1);
    // The Markdown heading + the https link DID render through the subset.
    check("markdown heading rendered",           art.body.indexOf("<h1>Returns</h1>") !== -1);
    check("https link rendered as anchor",       art.body.indexOf("href=\"https://example.com/policy\"") !== -1);

    // Breadcrumb + BreadcrumbList JSON-LD.
    check("article has a Help breadcrumb",       art.body.indexOf("class=\"breadcrumb\"") !== -1 && art.body.indexOf(">Help<") !== -1);
    check("article has BreadcrumbList JSON-LD",  art.body.indexOf("\"@type\":\"BreadcrumbList\"") !== -1);

    // The "was this helpful?" control is present (form posts to the vote route).
    check("article shows the vote form",         art.body.indexOf("action=\"/help/" + SLUG + "/vote\"") !== -1);
    check("vote form has yes/no buttons",        art.body.indexOf("value=\"helpful\"") !== -1 && art.body.indexOf("value=\"not_helpful\"") !== -1);

    // A view was recorded on the GET above (best-effort; assert it counted).
    check("view recorded on read",               (await kb.getArticle({ slug: SLUG })).view_count >= 1);

    // Vote "helpful" → 200 with the thank-you. The artJar carries the CSRF
    // cookie seeded by the GET above; httpRequest echoes it as X-CSRF-Token.
    var vote1 = await helpers.httpRequest({ port: port, path: "/help/" + SLUG + "/vote", method: "POST", form: { vote: "helpful" }, jar: artJar });
    check("vote then 200",                       vote1.status === 200);
    check("vote shows thank-you",                vote1.body.indexOf("Thanks for your feedback") !== -1);

    var agg1 = await kb.voteAggregateForArticle(SLUG);
    check("aggregate counts the helpful vote",   agg1.helpful_count === 1 && agg1.total_votes === 1);

    // A second vote from the SAME session dedups (no double count).
    var vote2 = await helpers.httpRequest({ port: port, path: "/help/" + SLUG + "/vote", method: "POST", form: { vote: "helpful" }, jar: artJar });
    check("second vote then 200",                vote2.status === 200);
    var agg2 = await kb.voteAggregateForArticle(SLUG);
    check("repeat vote deduped (still 1)",       agg2.helpful_count === 1 && agg2.total_votes === 1);

    // An unknown slug is a clean 404, no raw error / stack leak.
    var miss = await helpers.httpRequest({ port: port, path: "/help/no-such-article" });
    check("unknown /help slug → 404",            miss.status === 404);
    check("404 leaks no stack",                  miss.body.indexOf("    at ") === -1 && miss.body.toLowerCase().indexOf("knowledgebase:") === -1);

    // A malformed slug (bad shape) is also a clean 404, never a 500.
    var badSlug = await helpers.httpRequest({ port: port, path: "/help/Bad_Slug!" });
    check("malformed /help slug not a 500",      badSlug.status === 404);

    // The admin detail surfaces the helpfulness aggregate + view count.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/help/" + SLUG, jar: jar });
    check("admin detail then 200",               detail.status === 200);
    check("admin detail shows helpful count",    detail.body.indexOf("Helpful: 1") !== -1);

    // The bearer JSON contract: create returns 201, list returns rows.
    var apiCreate = await helpers.httpRequest({
      port: port, path: "/admin/help", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "api-article", title: "API Article", category: "general", body: "Made over the API." }),
    });
    check("bearer create returns 201 JSON",      apiCreate.status === 201 && (apiCreate.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer-made article is a draft",      JSON.parse(apiCreate.body).published === false);
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/help", headers: bearer });
    check("help API still JSON",                 (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    check("help API returns both articles",      JSON.parse(apiList.body).rows.length === 2);

    // A bad-shape create (missing body) re-renders the form with the
    // validator's message, not a 500 / stack.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/help", method: "POST", jar: jar,
      form: { slug: "no-body", title: "No Body", category: "general" },
    });
    check("bad create then 400",                 bad.status === 400);
    check("bad create surfaces validator msg",   bad.body.indexOf("body") !== -1);
    check("bad create leaks no stack",           bad.body.indexOf("    at ") === -1);

    // Archive (with the confirm interstitial) → gone from the storefront.
    var confirm = await helpers.httpRequest({ port: port, path: "/admin/help/" + SLUG + "/archive/confirm-page", jar: jar });
    check("archive confirm page then 200",       confirm.status === 200);
    check("archive confirm names the action",    confirm.body.indexOf("/admin/help/" + SLUG + "/archive") !== -1);
    var archive = await helpers.httpRequest({ port: port, path: "/admin/help/" + SLUG + "/archive", method: "POST", jar: jar });
    check("archive then 303",                    archive.status === 303);
    check("archive lands on the list",           (archive.headers.location || "").indexOf("archived=1") !== -1);

    var idxArch = await helpers.httpRequest({ port: port, path: "/help" });
    check("archived gone from /help index",      idxArch.body.indexOf("How to return") === -1);
    var slugArch = await helpers.httpRequest({ port: port, path: "/help/" + SLUG });
    check("archived /help/:slug → 404",          slugArch.status === 404);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/help" });
    check("anon admin help → login form",        anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { db.close(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
