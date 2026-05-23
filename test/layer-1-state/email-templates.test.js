"use strict";
/**
 * emailTemplates — operator-editable transactional email bodies
 * with per-locale versions + variable substitution + HTML-escape.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0125.
 *
 * Coverage:
 *   - defineTemplate creates a v1 row in the requested locale
 *   - renderTemplate substitutes variables + HTML-escapes hostile
 *     input + supports `{{name|raw}}` slots when the schema vouches
 *   - locale fallback: a renderTemplate at 'fr' falls back to 'en'
 *     when the French variant has no published version
 *   - publishVersion flips the active version + demotes the prior
 *   - validateVariables refuses unknown keys + missing required
 *   - versionsFor pages history newest-first; archiveTemplate
 *     drops every published flag + makes renderTemplate refuse
 *   - definition-time refusals: bad slug, bad kind, bad locale,
 *     template references undeclared variable, template uses
 *     `|raw` for a name not in schema.raw
 *
 * The monotonic-clock seam is exercised by passing an explicit
 * `now` to defineTemplate / publishVersion / updateTemplate so the
 * test's row timestamps are deterministic.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var emailTemplates = require("../../lib/email-templates");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_TEMPLATES = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0125_email_templates.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_TEMPLATES, "utf8")).forEach(function (s) {
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
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _factory() {
  var query = _makeQuery();
  return {
    query:     query,
    templates: emailTemplates.create({ query: query }),
  };
}

// Monotonic clock — a counter the tests advance per call so two
// versions written in the same millisecond still have ordered
// `created_at` values + `updated_at` columns we can assert on
// without leaning on real wall-clock time.
function _clock(start) {
  var t = start || 1700000000000;
  return function () { t += 1; return t; };
}

// ---- tests --------------------------------------------------------------

async function _defineHappyPath() {
  var f = _factory();
  var tick = _clock();

  var rv = await f.templates.defineTemplate({
    slug:      "order-confirmation-default",
    title:     "Default order confirmation",
    kind:      "order_confirmation",
    subject:   "Order {{order_id}} confirmed",
    body_html: "<h1>Thanks {{customer_name}}</h1><p>Total: {{grand_total_formatted}}</p>",
    body_text: "Thanks {{customer_name}}. Total: {{grand_total_formatted}}",
    variables_schema: {
      required: ["customer_name", "order_id"],
      optional: ["grand_total_formatted"],
    },
    locale: "en",
    now:    tick(),
  });

  check("defineTemplate returns template slug",
    rv.template.slug === "order-confirmation-default");
  check("defineTemplate returns template title",
    rv.template.title === "Default order confirmation");
  check("defineTemplate returns template kind",
    rv.template.kind === "order_confirmation");
  check("defineTemplate archived_at null",
    rv.template.archived_at === null);
  check("defineTemplate version_number 1",
    rv.version.version_number === 1);
  check("defineTemplate version not published yet",
    rv.version.published === false);
  check("defineTemplate version locale 'en'",
    rv.version.locale === "en");
  check("defineTemplate schema persisted",
    rv.version.variables_schema.required.indexOf("customer_name") !== -1);

  // Second define call appends v2 (same locale).
  var rv2 = await f.templates.defineTemplate({
    slug:      "order-confirmation-default",
    title:     "Default order confirmation (revised)",
    kind:      "order_confirmation",
    subject:   "Order {{order_id}} is confirmed",
    body_html: "<h1>Hello {{customer_name}}</h1>",
    body_text: "Hello {{customer_name}}",
    variables_schema: { required: ["customer_name", "order_id"] },
    locale: "en",
    now:    tick(),
  });
  check("defineTemplate v2 bumps version_number",
    rv2.version.version_number === 2);
  check("defineTemplate v2 refreshes title",
    rv2.template.title === "Default order confirmation (revised)");

  // listTemplates surfaces the row.
  var ls = await f.templates.listTemplates();
  check("listTemplates returns 1 row", ls.length === 1);
  var lsByKind = await f.templates.listTemplates({ kind: "order_confirmation" });
  check("listTemplates filtered by kind",
    lsByKind.length === 1 && lsByKind[0].slug === "order-confirmation-default");
  var lsOther = await f.templates.listTemplates({ kind: "password_reset" });
  check("listTemplates(kind=other) empty", lsOther.length === 0);

  // updateTemplate patches the title only.
  var upd = await f.templates.updateTemplate({
    slug:  "order-confirmation-default",
    patch: { title: "Default order confirmation (renamed)" },
    now:   tick(),
  });
  check("updateTemplate refreshes title",
    upd.title === "Default order confirmation (renamed)");

  // updateTemplate refuses unknown patch keys (e.g. body_html).
  await assert.rejects(
    f.templates.updateTemplate({
      slug:  "order-confirmation-default",
      patch: { body_html: "<p>nope</p>" },
      now:   tick(),
    }),
    /not patchable/
  );
}

async function _renderTemplateHtmlEscape() {
  var f = _factory();
  var tick = _clock();

  await f.templates.defineTemplate({
    slug:      "render-test",
    title:     "Render test",
    kind:      "welcome",
    subject:   "Hello {{customer_name}}",
    body_html: "<h1>Hi {{customer_name}}</h1><p>Code: {{coupon_code}}</p>",
    body_text: "Hi {{customer_name}}. Code: {{coupon_code}}",
    variables_schema: { required: ["customer_name", "coupon_code"] },
    locale: "en",
    now:    tick(),
  });
  await f.templates.publishVersion("render-test", { locale: "en", now: tick() });

  // Hostile input — every special HTML char must escape.
  var hostile = "<script>alert('xss')</script>&\"'";
  var out = await f.templates.renderTemplate({
    slug:    "render-test",
    locale:  "en",
    variables: {
      customer_name: hostile,
      coupon_code:   "SAVE20",
    },
  });
  check("rendered subject escapes <",
    out.subject.indexOf("&lt;script&gt;") !== -1);
  check("rendered subject has no literal <script>",
    out.subject.indexOf("<script>") === -1);
  check("rendered body_html escapes <",
    out.body_html.indexOf("&lt;script&gt;") !== -1);
  check("rendered body_html escapes &",
    out.body_html.indexOf("&amp;") !== -1);
  check("rendered body_html escapes \"",
    out.body_html.indexOf("&quot;") !== -1);
  check("rendered body_html escapes '",
    out.body_html.indexOf("&#x27;") !== -1);
  check("rendered body_html has no literal <script>",
    out.body_html.indexOf("<script>") === -1);
  check("rendered body_text escapes <",
    out.body_text.indexOf("&lt;") !== -1);
  check("rendered substitutes safe value verbatim",
    out.body_html.indexOf("SAVE20") !== -1);
  check("renderTemplate returns version_number",
    out.version_number === 1);
  check("renderTemplate returns locale_used",
    out.locale_used === "en");

  // Raw slot — operator vouches for an HTML fragment at definition
  // time. The schema lists `cta_html` in raw; the body uses
  // `{{cta_html|raw}}`; the render passes the value through
  // verbatim.
  await f.templates.defineTemplate({
    slug:      "raw-slot",
    title:     "Raw slot",
    kind:      "generic",
    subject:   "Hello",
    body_html: "<p>Hi {{customer_name}}</p>{{cta_html|raw}}",
    body_text: "Hi {{customer_name}}",
    variables_schema: {
      required: ["customer_name", "cta_html"],
      raw:      ["cta_html"],
    },
    locale: "en",
    now:    tick(),
  });
  await f.templates.publishVersion("raw-slot", { locale: "en", now: tick() });
  var raw = await f.templates.renderTemplate({
    slug:   "raw-slot",
    locale: "en",
    variables: {
      customer_name: "Alex",
      cta_html:      "<a href=\"https://example.com/cta\">Click</a>",
    },
  });
  check("raw slot passes HTML through verbatim",
    raw.body_html.indexOf("<a href=\"https://example.com/cta\">Click</a>") !== -1);
  check("non-raw slot still escapes",
    raw.body_html.indexOf("Hi Alex") !== -1);
}

async function _localeFallback() {
  var f = _factory();
  var tick = _clock();

  // Define + publish the English variant.
  await f.templates.defineTemplate({
    slug:      "multi-locale",
    title:     "Multi-locale",
    kind:      "welcome",
    subject:   "Welcome, {{customer_name}}",
    body_html: "<p>Welcome, {{customer_name}}</p>",
    body_text: "Welcome, {{customer_name}}",
    variables_schema: { required: ["customer_name"] },
    locale: "en",
    now:    tick(),
  });
  await f.templates.publishVersion("multi-locale", { locale: "en", now: tick() });

  // Request the French variant — there is none, so the renderer
  // falls back to English. The `locale_used` field surfaces which
  // variant was actually rendered.
  var rv = await f.templates.renderTemplate({
    slug:    "multi-locale",
    locale:  "fr",
    variables: { customer_name: "Marie" },
  });
  check("fr falls back to en (locale_used)",
    rv.locale_used === "en");
  check("fr fallback renders the en body",
    rv.body_html.indexOf("Welcome, Marie") !== -1);

  // Add + publish the French variant.
  await f.templates.defineTemplate({
    slug:      "multi-locale",
    title:     "Multi-locale",
    kind:      "welcome",
    subject:   "Bienvenue, {{customer_name}}",
    body_html: "<p>Bienvenue, {{customer_name}}</p>",
    body_text: "Bienvenue, {{customer_name}}",
    variables_schema: { required: ["customer_name"] },
    locale: "fr",
    now:    tick(),
  });
  await f.templates.publishVersion("multi-locale", { locale: "fr", now: tick() });

  var rvFr = await f.templates.renderTemplate({
    slug:    "multi-locale",
    locale:  "fr",
    variables: { customer_name: "Marie" },
  });
  check("fr now resolves to fr",
    rvFr.locale_used === "fr");
  check("fr renders Bienvenue",
    rvFr.body_html.indexOf("Bienvenue, Marie") !== -1);

  // A locale with no fallback either — but English is published,
  // so 'pt-BR' still falls back to 'en'.
  var rvPt = await f.templates.renderTemplate({
    slug:    "multi-locale",
    locale:  "pt-BR",
    variables: { customer_name: "Carlos" },
  });
  check("pt-BR falls back to en",
    rvPt.locale_used === "en");

  // Render for an unknown slug surfaces EMAIL_TEMPLATE_NOT_FOUND.
  await assert.rejects(
    f.templates.renderTemplate({
      slug:      "does-not-exist",
      locale:    "en",
      variables: {},
    }),
    function (e) {
      return e.code === "EMAIL_TEMPLATE_NOT_FOUND";
    }
  );
}

async function _publishVersionFlipsActive() {
  var f = _factory();
  var tick = _clock();

  // v1.
  var v1 = await f.templates.defineTemplate({
    slug:      "publish-flip",
    title:     "Publish flip",
    kind:      "generic",
    subject:   "Subject v1",
    body_html: "<p>Body v1</p>",
    body_text: "Body v1",
    variables_schema: {},
    locale: "en",
    now:    tick(),
  });
  await f.templates.publishVersion("publish-flip", {
    locale:     "en",
    version_id: v1.version.id,
    now:        tick(),
  });
  var rv1 = await f.templates.renderTemplate({
    slug:    "publish-flip",
    locale:  "en",
    variables: {},
  });
  check("v1 is active before second publish",
    rv1.body_html === "<p>Body v1</p>");

  // v2.
  var v2 = await f.templates.defineTemplate({
    slug:      "publish-flip",
    title:     "Publish flip",
    kind:      "generic",
    subject:   "Subject v2",
    body_html: "<p>Body v2</p>",
    body_text: "Body v2",
    variables_schema: {},
    locale: "en",
    now:    tick(),
  });
  // Until v2 is published, v1 is still active.
  var stillV1 = await f.templates.renderTemplate({
    slug:    "publish-flip",
    locale:  "en",
    variables: {},
  });
  check("defining v2 does NOT auto-publish",
    stillV1.body_html === "<p>Body v1</p>");
  check("defining v2 keeps v1 published flag",
    stillV1.version_number === 1);

  // Publish v2 — v1 demotes.
  await f.templates.publishVersion("publish-flip", {
    locale:     "en",
    version_id: v2.version.id,
    now:        tick(),
  });
  var rv2 = await f.templates.renderTemplate({
    slug:    "publish-flip",
    locale:  "en",
    variables: {},
  });
  check("v2 is now active",
    rv2.body_html === "<p>Body v2</p>");
  check("v2 version_number is 2",
    rv2.version_number === 2);

  // versionsFor surfaces both rows, newest first; v1 demoted +
  // v2 published.
  var hist = await f.templates.versionsFor("publish-flip", "en");
  check("versionsFor returns 2 rows", hist.length === 2);
  check("versionsFor newest-first (v2 then v1)",
    hist[0].version_number === 2 && hist[1].version_number === 1);
  check("v2 published flag set",
    hist[0].published === true);
  check("v1 published flag cleared",
    hist[1].published === false);

  // Publishing the same version twice is idempotent (same row stays
  // published; no spurious demotion).
  await f.templates.publishVersion("publish-flip", {
    locale:     "en",
    version_id: v2.version.id,
    now:        tick(),
  });
  var hist2 = await f.templates.versionsFor("publish-flip", "en");
  check("idempotent publish keeps v2 active",
    hist2[0].version_number === 2 && hist2[0].published === true);

  // publishVersion without version_id auto-picks the latest.
  var v3 = await f.templates.defineTemplate({
    slug:      "publish-flip",
    title:     "Publish flip",
    kind:      "generic",
    subject:   "Subject v3",
    body_html: "<p>Body v3</p>",
    body_text: "Body v3",
    variables_schema: {},
    locale: "en",
    now:    tick(),
  });
  await f.templates.publishVersion("publish-flip", { locale: "en", now: tick() });
  var rv3 = await f.templates.renderTemplate({
    slug:    "publish-flip",
    locale:  "en",
    variables: {},
  });
  check("publishVersion w/o version_id picks latest",
    rv3.version_id === v3.version.id);
}

async function _validateVariablesAndRefusals() {
  var f = _factory();
  var tick = _clock();

  // validateVariables refuses unknown keys.
  assert.throws(
    function () {
      f.templates.validateVariables({
        schema: { required: ["customer_name"] },
        variables: { customer_name: "Alex", unexpected_key: "leak" },
      });
    },
    /unknown variable/
  );
  // validateVariables refuses missing required.
  assert.throws(
    function () {
      f.templates.validateVariables({
        schema: { required: ["customer_name", "order_id"] },
        variables: { customer_name: "Alex" },
      });
    },
    /required variable 'order_id' missing/
  );
  // validateVariables happy path.
  var ok = f.templates.validateVariables({
    schema: { required: ["customer_name"], optional: ["coupon"] },
    variables: { customer_name: "Alex", coupon: "SAVE20" },
  });
  check("validateVariables ok", ok && ok.ok === true);

  // Definition-time refusals.
  await assert.rejects(
    f.templates.defineTemplate({
      slug: "Has Caps",
      title: "x", kind: "generic",
      subject: "x", body_html: "<p>x</p>", body_text: "x",
      now: tick(),
    }),
    /slug/
  );
  await assert.rejects(
    f.templates.defineTemplate({
      slug: "bad-kind",
      title: "x", kind: "exploded",
      subject: "x", body_html: "<p>x</p>", body_text: "x",
      now: tick(),
    }),
    /kind/
  );
  await assert.rejects(
    f.templates.defineTemplate({
      slug:    "bad-locale",
      title:   "x", kind: "generic",
      subject: "x", body_html: "<p>x</p>", body_text: "x",
      locale:  "english",
      now:     tick(),
    }),
    /locale/
  );
  // Template references undeclared variable.
  await assert.rejects(
    f.templates.defineTemplate({
      slug:    "undeclared-ref",
      title:   "x", kind: "generic",
      subject: "Hi {{unknown_key}}",
      body_html: "<p>x</p>", body_text: "x",
      variables_schema: { required: [] },
      now: tick(),
    }),
    /not declared/
  );
  // Template uses `|raw` for a name not whitelisted in schema.raw.
  await assert.rejects(
    f.templates.defineTemplate({
      slug:    "raw-not-vouched",
      title:   "x", kind: "generic",
      subject: "x",
      body_html: "<p>{{coupon_html|raw}}</p>",
      body_text: "x",
      variables_schema: { required: ["coupon_html"] },
      now: tick(),
    }),
    /raw/
  );
  // Subject with CR/LF.
  await assert.rejects(
    f.templates.defineTemplate({
      slug:    "crlf",
      title:   "x", kind: "generic",
      subject: "line1\r\nline2",
      body_html: "<p>x</p>", body_text: "x",
      now: tick(),
    }),
    /subject/
  );

  // renderTemplate refusals — unknown variable at render time.
  await f.templates.defineTemplate({
    slug:    "render-refuse",
    title:   "Render refuse",
    kind:    "generic",
    subject: "Hi {{customer_name}}",
    body_html: "<p>Hi {{customer_name}}</p>",
    body_text: "Hi {{customer_name}}",
    variables_schema: { required: ["customer_name"] },
    now: tick(),
  });
  await f.templates.publishVersion("render-refuse", { locale: "en", now: tick() });
  await assert.rejects(
    f.templates.renderTemplate({
      slug:   "render-refuse",
      locale: "en",
      variables: { customer_name: "Alex", uninvited: "leak" },
    }),
    /unknown variable/
  );
  await assert.rejects(
    f.templates.renderTemplate({
      slug:      "render-refuse",
      locale:    "en",
      variables: {},
    }),
    /required variable/
  );

  // publishVersion + archiveTemplate refusals on missing slug.
  await assert.rejects(
    f.templates.publishVersion("never-defined", { locale: "en", now: tick() }),
    /not found/
  );
  await assert.rejects(
    f.templates.archiveTemplate("never-defined"),
    /not found/
  );
}

async function _archiveTemplate() {
  var f = _factory();
  var tick = _clock();

  await f.templates.defineTemplate({
    slug:    "to-archive",
    title:   "Archive me",
    kind:    "generic",
    subject: "Hi",
    body_html: "<p>Hi</p>",
    body_text: "Hi",
    variables_schema: {},
    now: tick(),
  });
  await f.templates.publishVersion("to-archive", { locale: "en", now: tick() });

  // Live render works pre-archive.
  var pre = await f.templates.renderTemplate({
    slug: "to-archive", locale: "en", variables: {},
  });
  check("pre-archive renders", pre.body_html === "<p>Hi</p>");

  var arch = await f.templates.archiveTemplate("to-archive");
  check("archive sets archived_at",
    Number.isInteger(arch.archived_at) && arch.archived_at > 0);

  // Render now refuses — archived templates aren't reachable.
  await assert.rejects(
    f.templates.renderTemplate({
      slug: "to-archive", locale: "en", variables: {},
    }),
    function (e) { return e.code === "EMAIL_TEMPLATE_NOT_FOUND"; }
  );
  // getTemplate returns null too.
  var got = await f.templates.getTemplate({ slug: "to-archive", locale: "en" });
  check("getTemplate returns null after archive", got === null);

  // listTemplates default hides it.
  var ls = await f.templates.listTemplates();
  check("listTemplates hides archived by default", ls.length === 0);
  // listTemplates with active_only:false surfaces it.
  var lsAll = await f.templates.listTemplates({ active_only: false });
  check("listTemplates active_only:false surfaces it",
    lsAll.length === 1 && lsAll[0].slug === "to-archive");

  // Re-archiving is idempotent.
  var arch2 = await f.templates.archiveTemplate("to-archive");
  check("re-archive returns same row (idempotent)",
    arch2.archived_at === arch.archived_at);

  // defineTemplate on an archived slug refuses (operator must pick a
  // fresh slug or restore via a separate primitive).
  await assert.rejects(
    f.templates.defineTemplate({
      slug:    "to-archive",
      title:   "x", kind: "generic",
      subject: "x", body_html: "<p>x</p>", body_text: "x",
      now: tick(),
    }),
    /archived/
  );
}

async function _versionsForAndGetTemplate() {
  var f = _factory();
  var tick = _clock();

  // Three versions at 'en', two at 'fr'.
  for (var i = 1; i <= 3; i += 1) {
    await f.templates.defineTemplate({
      slug:    "versioned",
      title:   "Versioned",
      kind:    "generic",
      subject: "Subject v" + i,
      body_html: "<p>Body v" + i + "</p>",
      body_text: "Body v" + i,
      variables_schema: {},
      locale: "en",
      now:    tick(),
    });
  }
  for (var j = 1; j <= 2; j += 1) {
    await f.templates.defineTemplate({
      slug:    "versioned",
      title:   "Versioned",
      kind:    "generic",
      subject: "Sujet v" + j,
      body_html: "<p>Corps v" + j + "</p>",
      body_text: "Corps v" + j,
      variables_schema: {},
      locale: "fr",
      now:    tick(),
    });
  }

  var en = await f.templates.versionsFor("versioned", "en");
  var fr = await f.templates.versionsFor("versioned", "fr");
  check("versionsFor(en) returns 3 rows", en.length === 3);
  check("versionsFor(fr) returns 2 rows", fr.length === 2);
  check("versionsFor(en) newest first",
    en[0].version_number === 3 && en[2].version_number === 1);
  check("versionsFor(en) every row not published",
    en.every(function (v) { return v.published === false; }));

  // Publish the latest 'en' version; getTemplate returns it.
  await f.templates.publishVersion("versioned", { locale: "en", now: tick() });
  var got = await f.templates.getTemplate({ slug: "versioned", locale: "en" });
  check("getTemplate returns published version",
    got && got.version.version_number === 3);
  check("getTemplate returns locale_used",
    got.locale_used === "en");

  // getTemplate at 'fr' before publish — falls back to en since fr
  // has no published version yet.
  var gotFr = await f.templates.getTemplate({ slug: "versioned", locale: "fr" });
  check("getTemplate fr falls back to en pre-publish",
    gotFr && gotFr.locale_used === "en");

  // Publish fr v1 explicitly by version_id.
  var frV1 = fr.filter(function (v) { return v.version_number === 1; })[0];
  await f.templates.publishVersion("versioned", {
    locale:     "fr",
    version_id: frV1.id,
    now:        tick(),
  });
  var gotFr2 = await f.templates.getTemplate({ slug: "versioned", locale: "fr" });
  check("getTemplate fr resolves fr after publish",
    gotFr2.locale_used === "fr" && gotFr2.version.version_number === 1);
}

async function run() {
  await _defineHappyPath();
  await _renderTemplateHtmlEscape();
  await _localeFallback();
  await _publishVersionFlipsActive();
  await _validateVariablesAndRefusals();
  await _archiveTemplate();
  await _versionsForAndGetTemplate();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7,
  // template.escapeHtml) is wired before the first test runs.
  void bShop;
  run().then(function () {
    process.stdout.write("email-templates.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("email-templates.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
