"use strict";
/**
 * cmsBlocks — operator-editable content slots embedded in storefront
 * templates. Each block carries a key, a default_body, a layout, an
 * archive flag, and a per-(key, locale) version history with optional
 * publish windows.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0079_cms_blocks.sql alone — the primitive owns its own tables and
 * doesn't FK into the rest of the schema.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/cms-blocks.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineBlock happy path (insert) and idempotent re-define (update)
 *   - defineBlock refusals — bad key, bad layout, missing input,
 *     control bytes in default_body
 *   - setLocalized appends a new version row each call; version
 *     starts at 1 and monotonically increments per (key, locale)
 *   - setLocalized refuses missing block, archived block, bad locale,
 *     bad publish window (expire_at <= publish_at)
 *   - getRendered locale fallback: fr-CA -> fr -> default_body
 *   - getRendered publish window respected: rows outside (publish_at,
 *     expire_at) are skipped, the previous version wins, finally the
 *     default body
 *   - archiveBlock returns empty render even when localizations exist
 *   - HTML-escape safety on hostile body: <script>, onerror, javascript:
 *     URLs all neutralised in render output
 *   - update patches default_body / layout only; refuses other columns
 *   - versionsForBlock returns the full version history newest-first
 *   - listBlocks excludes archived by default; include_archived flag
 *     surfaces every row
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop     = require("../../lib");
var cmsBlocks = require("../../lib/cms-blocks");
var helpers   = require("../helpers");
var check     = helpers.check;
var assert    = helpers.assert;

void bShop;   // touch the entry point so the require cycle is exercised

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0079_cms_blocks.sql");

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
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _setup() {
  var query = _makeQuery();
  var c = cmsBlocks.create({ query: query });
  return { query: query, c: c };
}

// ---- defineBlock happy + idempotent ------------------------------------

async function _defineHappy() {
  var ctx = _setup();
  var b1 = await ctx.c.defineBlock({
    key:          "header.announcement",
    default_body: "Welcome to the shop.",
    layout:       "header_announcement",
  });
  check("defineBlock persists key",           b1.key === "header.announcement");
  check("defineBlock persists default_body",  b1.default_body === "Welcome to the shop.");
  check("defineBlock persists layout",        b1.layout === "header_announcement");
  check("defineBlock archived_at null",       b1.archived_at === null);
  check("defineBlock stamps created_at",      typeof b1.created_at === "number" && b1.created_at > 0);
  check("defineBlock updated_at = created_at", b1.updated_at === b1.created_at);

  // Re-defining the same key is idempotent — updates default_body +
  // layout but leaves the row in place.
  var b2 = await ctx.c.defineBlock({
    key:          "header.announcement",
    default_body: "New welcome copy.",
    layout:       "header_announcement",
  });
  check("re-define updates default_body", b2.default_body === "New welcome copy.");
  check("re-define preserves key",        b2.key === "header.announcement");

  // Default layout is `inline` when omitted.
  var b3 = await ctx.c.defineBlock({
    key:          "ad.hoc",
    default_body: "Some inline copy.",
  });
  check("defineBlock defaults layout to inline", b3.layout === "inline");

  // Every allowed layout works.
  var layouts = ["hero", "category_hero", "pdp_bottom", "footer_column", "checkout_success"];
  for (var i = 0; i < layouts.length; i += 1) {
    var b = await ctx.c.defineBlock({
      key:          "slot_" + i,
      default_body: "Body " + i,
      layout:       layouts[i],
    });
    check("defineBlock accepts layout=" + layouts[i], b.layout === layouts[i]);
  }
}

// ---- defineBlock refusals ----------------------------------------------

async function _defineRefusals() {
  var ctx = _setup();

  await assert.rejects(ctx.c.defineBlock(), /input object required/);

  await assert.rejects(ctx.c.defineBlock({
    key: "-leading", default_body: "x",
  }), /key/);

  await assert.rejects(ctx.c.defineBlock({
    key: "has space", default_body: "x",
  }), /key/);

  await assert.rejects(ctx.c.defineBlock({
    key: "bad-layout", default_body: "x", layout: "kitchen-sink",
  }), /layout must be one of/);

  await assert.rejects(ctx.c.defineBlock({
    key: "no-body", default_body: "",
  }), /default_body/);

  await assert.rejects(ctx.c.defineBlock({
    key: "ctrl-body", default_body: "bad\x00byte",
  }), /default_body/);
}

// ---- setLocalized + version increment ----------------------------------

async function _setLocalizedVersions() {
  var ctx = _setup();
  await ctx.c.defineBlock({ key: "hero", default_body: "Default hero.", layout: "hero" });

  var v1 = await ctx.c.setLocalized({
    key:    "hero",
    locale: "fr",
    body:   "Bonjour le monde.",
  });
  check("setLocalized first version is 1",          v1.version === 1);
  check("setLocalized persists locale (lowercase)", v1.locale === "fr");
  check("setLocalized persists body",               v1.body === "Bonjour le monde.");
  check("setLocalized publish_at null by default",  v1.publish_at === null);
  check("setLocalized expire_at null by default",   v1.expire_at === null);
  check("setLocalized assigns id",                  typeof v1.id === "string" && v1.id.length > 0);

  var v2 = await ctx.c.setLocalized({
    key:    "hero",
    locale: "fr",
    body:   "Bonjour, monde.",
  });
  check("setLocalized second version is 2", v2.version === 2);

  var v3 = await ctx.c.setLocalized({
    key:    "hero",
    locale: "fr",
    body:   "Salut le monde.",
  });
  check("setLocalized third version is 3", v3.version === 3);

  // A different locale starts at version 1 independently.
  var es1 = await ctx.c.setLocalized({
    key:    "hero",
    locale: "es",
    body:   "Hola mundo.",
  });
  check("setLocalized other-locale starts at 1", es1.version === 1);

  // Case-insensitive locale canonicalises to lowercase.
  var caFR = await ctx.c.setLocalized({
    key:    "hero",
    locale: "fr-CA",
    body:   "Salut au Canada.",
  });
  check("setLocalized canonicalises fr-CA -> fr-ca", caFR.locale === "fr-ca");
  check("setLocalized fr-ca starts at 1",            caFR.version === 1);

  // versionsForBlock returns the full history newest-first.
  var history = await ctx.c.versionsForBlock({ key: "hero", locale: "fr" });
  check("versionsForBlock returns 3 rows",         history.length === 3);
  check("versionsForBlock newest first (v=3)",     history[0].version === 3);
  check("versionsForBlock middle (v=2)",           history[1].version === 2);
  check("versionsForBlock oldest (v=1)",           history[2].version === 1);

  // Refusals.
  await assert.rejects(ctx.c.setLocalized({
    key: "ghost", locale: "fr", body: "x",
  }), /not found/);
  await assert.rejects(ctx.c.setLocalized({
    key: "hero", locale: "fr", body: "x", publish_at: 1000, expire_at: 1000,
  }), /expire_at must be strictly greater/);
  await assert.rejects(ctx.c.setLocalized({
    key: "hero", locale: "fr", body: "x", publish_at: 2000, expire_at: 1000,
  }), /expire_at must be strictly greater/);
  await assert.rejects(ctx.c.setLocalized({
    key: "hero", locale: "not a locale", body: "x",
  }), /locale/);
}

// ---- getRendered locale fallback ---------------------------------------

async function _renderLocaleFallback() {
  var ctx = _setup();
  await ctx.c.defineBlock({
    key:          "hero",
    default_body: "Default English copy.",
    layout:       "hero",
  });

  // Only metropolitan French is authored — fr-CA must fall back to fr.
  await ctx.c.setLocalized({ key: "hero", locale: "fr", body: "Bonjour le monde." });

  var rFR    = await ctx.c.getRendered({ key: "hero", locale: "fr" });
  var rFRCA  = await ctx.c.getRendered({ key: "hero", locale: "fr-CA" });
  var rEN    = await ctx.c.getRendered({ key: "hero", locale: "en" });
  var rDE    = await ctx.c.getRendered({ key: "hero", locale: "de" });

  check("render fr renders fr body",          rFR.indexOf("Bonjour le monde.") !== -1);
  check("render fr-CA falls back to fr",      rFRCA.indexOf("Bonjour le monde.") !== -1);
  check("render en falls back to default",    rEN.indexOf("Default English copy.") !== -1);
  check("render de falls back to default",    rDE.indexOf("Default English copy.") !== -1);

  // Author fr-CA specifically — fr-CA now wins over fr.
  await ctx.c.setLocalized({ key: "hero", locale: "fr-CA", body: "Salut au Canada." });
  var rFRCA2 = await ctx.c.getRendered({ key: "hero", locale: "fr-CA" });
  check("render fr-CA prefers fr-ca over fr", rFRCA2.indexOf("Salut au Canada.") !== -1);
  check("render fr-CA does not leak fr copy", rFRCA2.indexOf("Bonjour le monde.") === -1);

  // Latest version wins.
  await ctx.c.setLocalized({ key: "hero", locale: "fr", body: "Salut, monde !" });
  var rFR2 = await ctx.c.getRendered({ key: "hero", locale: "fr" });
  check("render fr picks latest version", rFR2.indexOf("Salut, monde !") !== -1);
  check("render fr does not leak v1",     rFR2.indexOf("Bonjour le monde.") === -1);

  // Missing key throws.
  await assert.rejects(ctx.c.getRendered({ key: "ghost", locale: "fr" }), /not found/);
  await assert.rejects(ctx.c.getRendered(), /input object required/);
}

// ---- publish window respected ------------------------------------------

async function _publishWindow() {
  var ctx = _setup();
  await ctx.c.defineBlock({
    key:          "promo.flash",
    default_body: "Default flash promo.",
    layout:       "hero",
  });

  var t0 = 1_700_000_000_000;
  var t1 = t0 + 1000;
  var t2 = t0 + 2000;
  var t3 = t0 + 3000;

  // Version 1 — active in [t1, t2).
  await ctx.c.setLocalized({
    key:        "promo.flash",
    locale:     "en",
    body:       "Hot flash window v1.",
    publish_at: t1,
    expire_at:  t2,
  });
  // Version 2 — active in [t2, t3). The renderer is supposed to
  // pick this row at t2 onwards because it's a higher version AND
  // its window covers t2. Outside [t1, t3), both rows are inactive
  // and the renderer falls back to default_body.
  await ctx.c.setLocalized({
    key:        "promo.flash",
    locale:     "en",
    body:       "Hot flash window v2.",
    publish_at: t2,
    expire_at:  t3,
  });

  var beforeFirst = await ctx.c.getRendered({ key: "promo.flash", locale: "en", now: t0 });
  check("before publish: falls back to default", beforeFirst.indexOf("Default flash promo.") !== -1);
  check("before publish: no v1 leak",            beforeFirst.indexOf("v1") === -1);
  check("before publish: no v2 leak",            beforeFirst.indexOf("v2") === -1);

  var duringFirst = await ctx.c.getRendered({ key: "promo.flash", locale: "en", now: t1 });
  check("during v1 window: renders v1",    duringFirst.indexOf("Hot flash window v1.") !== -1);

  var duringSecond = await ctx.c.getRendered({ key: "promo.flash", locale: "en", now: t2 });
  check("during v2 window: renders v2",    duringSecond.indexOf("Hot flash window v2.") !== -1);
  check("during v2 window: no v1 leak",    duringSecond.indexOf("Hot flash window v1.") === -1);

  var afterAll = await ctx.c.getRendered({ key: "promo.flash", locale: "en", now: t3 });
  check("after all windows: falls back to default", afterAll.indexOf("Default flash promo.") !== -1);
  check("after all windows: no v1 leak",            afterAll.indexOf("v1") === -1);
  check("after all windows: no v2 leak",            afterAll.indexOf("v2") === -1);

  // Open-ended publish_at (NULL expire_at) — once published, stays
  // active forever.
  await ctx.c.defineBlock({ key: "open.ended", default_body: "Default.", layout: "inline" });
  await ctx.c.setLocalized({
    key:        "open.ended",
    locale:     "en",
    body:       "Always-on body.",
    publish_at: t1,
  });
  var farFuture = await ctx.c.getRendered({ key: "open.ended", locale: "en", now: t1 + 1_000_000_000 });
  check("open-ended publish window stays active", farFuture.indexOf("Always-on body.") !== -1);
}

// ---- archiveBlock returns empty render ---------------------------------

async function _archiveEmptyRender() {
  var ctx = _setup();
  await ctx.c.defineBlock({
    key:          "old.footer",
    default_body: "Old footer copy.",
    layout:       "footer_column",
  });
  await ctx.c.setLocalized({
    key:    "old.footer",
    locale: "en",
    body:   "Localised footer copy.",
  });

  // Sanity — before archive the renderer returns content.
  var pre = await ctx.c.getRendered({ key: "old.footer", locale: "en" });
  check("pre-archive: renders localized body", pre.indexOf("Localised footer copy.") !== -1);

  var archived = await ctx.c.archiveBlock("old.footer");
  check("archiveBlock stamps archived_at", typeof archived.archived_at === "number" && archived.archived_at > 0);

  var post = await ctx.c.getRendered({ key: "old.footer", locale: "en" });
  check("post-archive: renders empty string", post === "");

  // Even with a locale that has no localization, archived block
  // renders "" (not the default_body).
  var postOther = await ctx.c.getRendered({ key: "old.footer", locale: "de" });
  check("post-archive other locale: empty too", postOther === "");

  // listBlocks excludes archived by default.
  var visible  = await ctx.c.listBlocks();
  var allRows  = await ctx.c.listBlocks({ include_archived: true });
  check("listBlocks excludes archived by default",  !visible.some(function (b) { return b.key === "old.footer"; }));
  check("listBlocks include_archived surfaces it",  allRows.some(function (b) { return b.key === "old.footer"; }));

  // setLocalized refused on an archived block.
  await assert.rejects(ctx.c.setLocalized({
    key: "old.footer", locale: "en", body: "x",
  }), /archived/);

  // archiveBlock on unknown key throws.
  await assert.rejects(ctx.c.archiveBlock("ghost"), /not found/);

  // Re-defining the archived key restores it (clears archived_at).
  var restored = await ctx.c.defineBlock({
    key:          "old.footer",
    default_body: "New footer copy.",
    layout:       "footer_column",
  });
  check("re-define clears archived_at", restored.archived_at === null);

  var restoredRender = await ctx.c.getRendered({ key: "old.footer", locale: "en" });
  // The previous localization still exists (FK ON DELETE CASCADE
  // only fires on row removal, not archive). So the renderer picks
  // it back up.
  check("restored block renders localized body again", restoredRender.indexOf("Localised footer copy.") !== -1);
}

// ---- HTML-escape safety on hostile body --------------------------------

async function _renderSafety() {
  var ctx = _setup();
  await ctx.c.defineBlock({
    key:          "hostile",
    default_body: "default fallback",
    layout:       "inline",
  });
  await ctx.c.setLocalized({
    key:    "hostile",
    locale: "en",
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

  var html = await ctx.c.getRendered({ key: "hostile", locale: "en" });

  // No live <script> tag from the body anywhere in the output.
  check("renderHtml escapes script in heading",   html.indexOf("<script>alert(1)") === -1);
  check("renderHtml escapes script in inline",    html.indexOf("<script>alert(4)") === -1);
  check("renderHtml escapes script in data: URL", html.indexOf("<script>x</script>") === -1);
  // No `onerror` attribute lands on any tag.
  check("renderHtml escapes img onerror",          !/<img[^>]*onerror=/i.test(html));
  // No `onload` attribute lands on any tag.
  check("renderHtml escapes svg onload",           !/<svg[^>]*onload=/i.test(html));
  // The hostile script content survives as inert escaped text.
  check("renderHtml encodes < as &lt;",            html.indexOf("&lt;script&gt;") !== -1);
  // The javascript: URL is dropped.
  check("renderHtml refuses javascript: href",     html.indexOf('href="javascript:') === -1);
  // The data: URL is dropped.
  check("renderHtml refuses data: href",           html.indexOf('href="data:') === -1);
  // Protocol-relative URL is dropped.
  check("renderHtml refuses //-host href",         html.indexOf('href="//') === -1);
  // The safe https URL renders as a real anchor.
  check("renderHtml emits https link",             html.indexOf('href="https://example.com/"') !== -1);
  // The /-rooted internal link also renders as a real anchor.
  check("renderHtml emits /-rooted link",          html.indexOf('href="/about"') !== -1);
  // Anchor text from dropped-URL links survives as escaped text.
  check("renderHtml preserves anchor text for dropped URL", html.indexOf("Bad link") !== -1);
}

// ---- update + versionsForBlock + listBlocks ----------------------------

async function _updatePatch() {
  var ctx = _setup();
  await ctx.c.defineBlock({
    key:          "p1",
    default_body: "Original default.",
    layout:       "inline",
  });

  // Patch default_body.
  var u1 = await ctx.c.update("p1", { default_body: "New default copy." });
  check("update persists default_body", u1.default_body === "New default copy.");
  check("update preserves layout",      u1.layout === "inline");

  // Patch layout.
  var u2 = await ctx.c.update("p1", { layout: "hero" });
  check("update persists layout", u2.layout === "hero");

  // Refusals.
  await assert.rejects(ctx.c.update("p1", { archived_at: 1 }), /unsupported column/);
  await assert.rejects(ctx.c.update("p1", { key: "x" }),       /unsupported column/);
  await assert.rejects(ctx.c.update("p1", {}),                  /at least one column/);
  await assert.rejects(ctx.c.update("ghost", { layout: "inline" }), /not found/);
  await assert.rejects(ctx.c.update("p1", { default_body: "" }),    /default_body/);
  await assert.rejects(ctx.c.update("p1", { layout: "bogus" }),     /layout/);
}

async function run() {
  await _defineHappy();
  await _defineRefusals();
  await _setLocalizedVersions();
  await _renderLocaleFallback();
  await _publishWindow();
  await _archiveEmptyRender();
  await _renderSafety();
  await _updatePatch();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/cms-blocks.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("cms-blocks: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
