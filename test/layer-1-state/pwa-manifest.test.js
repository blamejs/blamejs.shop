"use strict";
/**
 * pwa-manifest — operator-configurable PWA web app manifest +
 * service-worker config. Versioned, with `is_active` flipping for
 * the renderer surface.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0168_pwa_manifest.sql`. The primitive isn't wired through
 * `bShop` yet — the test requires `lib/pwa-manifest.js` directly so
 * the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - defineManifest persists + hydrates + refuses non-6-digit-hex
 *     colors / bogus display + orientation / hostile URLs
 *   - renderManifestJson emits a sorted-key deterministic JSON
 *     blob with every required field
 *   - validateIcons round-trips + refuses duplicates + bad shapes
 *   - setActive flips is_active inside a single sweep + refuses
 *     archived versions
 *   - listVersions paginates newest-first + cursor tamper refused
 *   - archiveVersion soft-deletes + clears the active flag
 *   - defineServiceWorkerConfig + renderServiceWorkerJs round-trip
 *     with operator-supplied URLs JSON.stringify'd into the body
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var pwaManifest = require("../../lib/pwa-manifest");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0168_pwa_manifest.sql"
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

function _setup() {
  var query = _makeQuery();
  var pwa = pwaManifest.create({
    query:        query,
    cursorSecret: "pwa-manifest-test-secret",
  });
  return { query: query, pwa: pwa };
}

function _validManifestInput(overrides) {
  var base = {
    name:             "blamejs.shop",
    short_name:       "shop",
    description:      "Default storefront PWA",
    start_url:        "/",
    scope:            "/",
    display:          "standalone",
    orientation:      "portrait",
    theme_color:      "#1a2b3c",
    background_color: "#ffffff",
    lang:             "en",
    dir:              "ltr",
    icons: [
      { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/mask.png", sizes: "512x512", type: "image/png", puroseExtra: true, purpose: "maskable" },
    ],
  };
  if (overrides) {
    var keys = Object.keys(overrides);
    for (var i = 0; i < keys.length; i += 1) base[keys[i]] = overrides[keys[i]];
  }
  return base;
}

// Bare two-icon shape for the colour / URL refusal tests that don't
// care about the third entry.
function _twoIcons() {
  return [
    { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/512.png", sizes: "512x512", type: "image/png" },
  ];
}

// ---- tests --------------------------------------------------------------

async function _defineManifestHappyPath() {
  var ctx = _setup();
  var m = await ctx.pwa.defineManifest(_validManifestInput());
  check("defineManifest returns version_number 1", m.version_number === 1);
  check("defineManifest is unpublished by default", m.is_active === false);
  check("defineManifest persists name",             m.name === "blamejs.shop");
  check("defineManifest hydrates icons array",      Array.isArray(m.icons) && m.icons.length === 3);
  check("defineManifest defaults icon purpose=any", m.icons[0].purpose === "any");
  check("defineManifest preserves explicit purpose", m.icons[2].purpose === "maskable");
  check("defineManifest persists theme_color",      m.theme_color === "#1a2b3c");
  check("defineManifest persists orientation",      m.orientation === "portrait");
  check("defineManifest archived_at null on insert", m.archived_at === null);

  // Second defineManifest increments version_number.
  var m2 = await ctx.pwa.defineManifest(_validManifestInput({
    name: "blamejs.shop v2",
  }));
  check("second defineManifest is version 2",       m2.version_number === 2);
  check("second defineManifest still unpublished",  m2.is_active === false);
  check("second defineManifest updated_at > first", m2.updated_at >= m.updated_at);
}

async function _defineManifestColorRefusal() {
  var ctx = _setup();

  // 3-digit hex refused.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    theme_color: "#fff",
  })), /theme_color/);

  // Uppercase hex refused.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    theme_color: "#AABBCC",
  })), /theme_color/);

  // Named color refused.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    theme_color: "white",
  })), /theme_color/);

  // rgb() form refused.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    theme_color: "rgb(255, 255, 255)",
  })), /theme_color/);

  // 8-digit hex (rgba) refused.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    theme_color: "#1a2b3c4d",
  })), /theme_color/);

  // background_color same refusal shape.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    background_color: "#fff",
  })), /background_color/);
}

async function _defineManifestRefusals() {
  var ctx = _setup();

  await assert.rejects(ctx.pwa.defineManifest(),                                     /input object required/);
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({ display: "weird" })),         /display/);
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({ orientation: "sideways" })),  /orientation/);
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({ dir: "ttb" })),               /dir/);
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({ lang: "BAD!" })),             /lang/);
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({ name: "" })),                  /name/);
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({ short_name: "x".repeat(61) })), /short_name/);

  // Hostile URL — protocol-relative.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    start_url: "//evil.example.com/payload",
  })), /start_url/);

  // Hostile URL — `..` traversal.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    scope: "/../etc/passwd",
  })), /scope/);

  // Cleartext http:// URL refused (b.safeUrl https-only).
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    start_url: "http://example.com/",
  })), /start_url/);

  // javascript: URL refused.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    start_url: "javascript:alert(1)",
  })), /start_url/);

  // Control byte in name.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    name: "bad\x00name",
  })), /name/);

  // Zero-width in description.
  await assert.rejects(ctx.pwa.defineManifest(_validManifestInput({
    description: "bad" + String.fromCharCode(0x200B) + "desc",
  })), /description/);
}

async function _validateIconsSurface() {
  var ctx = _setup();

  // Standalone validation succeeds + normalizes purpose=any.
  var ok = ctx.pwa.validateIcons([
    { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/512.png", sizes: "512x512 192x192", type: "image/png", purpose: "maskable" },
    { src: "https://cdn.example.com/icon.svg", sizes: "any", type: "image/svg+xml" },
  ]);
  check("validateIcons normalizes default purpose", ok[0].purpose === "any");
  check("validateIcons preserves explicit purpose", ok[1].purpose === "maskable");
  check("validateIcons accepts https absolute icon src", ok[2].src.indexOf("https://") === 0);

  // Empty / non-array refused.
  assert.throws(function () { ctx.pwa.validateIcons([]); }, /at least one descriptor/);
  assert.throws(function () { ctx.pwa.validateIcons(null); }, /icons must be an array/);
  assert.throws(function () { ctx.pwa.validateIcons("not-array"); }, /icons must be an array/);

  // Bad sizes shape.
  assert.throws(function () {
    ctx.pwa.validateIcons([{ src: "/icon.png", sizes: "192", type: "image/png" }]);
  }, /sizes/);
  assert.throws(function () {
    ctx.pwa.validateIcons([{ src: "/icon.png", sizes: "", type: "image/png" }]);
  }, /sizes/);

  // Bad MIME type.
  assert.throws(function () {
    ctx.pwa.validateIcons([{ src: "/icon.png", sizes: "192x192", type: "not a mime" }]);
  }, /type/);

  // Bad purpose enum.
  assert.throws(function () {
    ctx.pwa.validateIcons([{ src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "decorative" }]);
  }, /purpose/);

  // Duplicate (sizes, purpose) refused.
  assert.throws(function () {
    ctx.pwa.validateIcons([
      { src: "/a.png", sizes: "192x192", type: "image/png" },
      { src: "/b.png", sizes: "192x192", type: "image/png" },
    ]);
  }, /duplicates/);

  // Hostile icon src — protocol-relative.
  assert.throws(function () {
    ctx.pwa.validateIcons([{ src: "//evil/icon.png", sizes: "192x192", type: "image/png" }]);
  }, /src/);

  // Hostile icon src — cleartext http.
  assert.throws(function () {
    ctx.pwa.validateIcons([{ src: "http://example.com/icon.png", sizes: "192x192", type: "image/png" }]);
  }, /src/);
}

async function _setActiveFlip() {
  var ctx = _setup();
  var v1 = await ctx.pwa.defineManifest(_validManifestInput({ name: "v1", icons: _twoIcons() }));
  var v2 = await ctx.pwa.defineManifest(_validManifestInput({ name: "v2", icons: _twoIcons() }));
  var v3 = await ctx.pwa.defineManifest(_validManifestInput({ name: "v3", icons: _twoIcons() }));

  // No active version yet.
  var initial = await ctx.pwa.getActive();
  check("getActive null before first setActive", initial === null);

  // Flip v2 active.
  var afterV2 = await ctx.pwa.setActive(v2.version_number);
  check("setActive returns active row",          afterV2.is_active === true);
  check("setActive returns the named version",   afterV2.version_number === v2.version_number);

  var act1 = await ctx.pwa.getActive();
  check("getActive returns v2 after flip",       act1.version_number === v2.version_number);

  // Flip to v1 — v2 must drop to is_active=0.
  await ctx.pwa.setActive(v1.version_number);
  var rowsAfter = (await ctx.query("SELECT version_number, is_active FROM pwa_manifests ORDER BY version_number ASC", [])).rows;
  check("after flip, v1 is_active=1",            rowsAfter[0].is_active === 1);
  check("after flip, v2 is_active=0",            rowsAfter[1].is_active === 0);
  check("after flip, v3 is_active=0 still",      rowsAfter[2].is_active === 0);

  // Flip to v3.
  await ctx.pwa.setActive(v3.version_number);
  var act3 = await ctx.pwa.getActive();
  check("getActive returns v3 after second flip", act3.version_number === v3.version_number);
  var allRows = (await ctx.query("SELECT is_active FROM pwa_manifests", [])).rows;
  var activeCount = 0;
  for (var i = 0; i < allRows.length; i += 1) if (allRows[i].is_active === 1) activeCount += 1;
  check("exactly one row is_active=1",           activeCount === 1);

  // Refusals.
  await assert.rejects(ctx.pwa.setActive(999),  /not found/);
  await assert.rejects(ctx.pwa.setActive(0),    /version_number/);
  await assert.rejects(ctx.pwa.setActive(-1),   /version_number/);
  await assert.rejects(ctx.pwa.setActive("x"),  /version_number/);

  // Archived version refuses setActive.
  await ctx.pwa.archiveVersion(v2.version_number);
  await assert.rejects(ctx.pwa.setActive(v2.version_number), /archived/);
}

async function _renderManifestJsonShape() {
  var ctx = _setup();
  var v1 = await ctx.pwa.defineManifest(_validManifestInput({ icons: _twoIcons() }));

  // No active version → render refuses.
  await assert.rejects(ctx.pwa.renderManifestJson(), /no active manifest/);

  await ctx.pwa.setActive(v1.version_number);
  var json = await ctx.pwa.renderManifestJson();
  check("renderManifestJson returns string",     typeof json === "string" && json.length > 0);

  var parsed = JSON.parse(json);
  check("renderManifestJson has name",           parsed.name === "blamejs.shop");
  check("renderManifestJson has short_name",     parsed.short_name === "shop");
  check("renderManifestJson has start_url",      parsed.start_url === "/");
  check("renderManifestJson has scope",          parsed.scope === "/");
  check("renderManifestJson has display",        parsed.display === "standalone");
  check("renderManifestJson has orientation",    parsed.orientation === "portrait");
  check("renderManifestJson has theme_color",    parsed.theme_color === "#1a2b3c");
  check("renderManifestJson has background_color", parsed.background_color === "#ffffff");
  check("renderManifestJson has lang",           parsed.lang === "en");
  check("renderManifestJson has dir",            parsed.dir === "ltr");
  check("renderManifestJson has icons array",    Array.isArray(parsed.icons) && parsed.icons.length === 2);
  check("renderManifestJson icons[0] has src",   parsed.icons[0].src === "/icons/192.png");
  check("renderManifestJson icons[0] has sizes", parsed.icons[0].sizes === "192x192");
  check("renderManifestJson icons[0] has type",  parsed.icons[0].type === "image/png");
  check("renderManifestJson icons[0] has purpose", parsed.icons[0].purpose === "any");

  // Sorted-key deterministic output — `background_color` appears
  // before `description` alphabetically.
  var bgIdx   = json.indexOf("background_color");
  var descIdx = json.indexOf("description");
  check("renderManifestJson keys are sorted",    bgIdx >= 0 && descIdx >= 0 && bgIdx < descIdx);

  // Second render with the same active version returns byte-equal output.
  var json2 = await ctx.pwa.renderManifestJson();
  check("renderManifestJson is deterministic",   json === json2);
}

async function _listVersionsAndArchive() {
  var ctx = _setup();
  // Five versions.
  for (var i = 0; i < 5; i += 1) {
    await ctx.pwa.defineManifest(_validManifestInput({ name: "v" + (i + 1), icons: _twoIcons() }));
  }

  // All in one shot.
  var all = await ctx.pwa.listVersions({});
  check("listVersions returns 5 rows",           all.rows.length === 5);
  check("listVersions newest-first",             all.rows[0].version_number === 5);
  check("listVersions tail is oldest",           all.rows[4].version_number === 1);
  check("listVersions no cursor for full page",  all.next_cursor === null);

  // Paginate at limit=2.
  var p1 = await ctx.pwa.listVersions({ limit: 2 });
  check("page1 returns 2 newest",                p1.rows.length === 2 && p1.rows[0].version_number === 5 && p1.rows[1].version_number === 4);
  check("page1 has cursor",                      typeof p1.next_cursor === "string" && p1.next_cursor.length > 0);
  var p2 = await ctx.pwa.listVersions({ limit: 2, cursor: p1.next_cursor });
  check("page2 returns 3, 2",                    p2.rows.length === 2 && p2.rows[0].version_number === 3 && p2.rows[1].version_number === 2);
  var p3 = await ctx.pwa.listVersions({ limit: 2, cursor: p2.next_cursor });
  check("page3 returns last 1",                  p3.rows.length === 1 && p3.rows[0].version_number === 1);
  check("page3 no cursor",                       p3.next_cursor === null);

  // Tampered cursor refused.
  await assert.rejects(ctx.pwa.listVersions({ cursor: p1.next_cursor + "x" }), /cursor/);

  // Limit refusals.
  await assert.rejects(ctx.pwa.listVersions({ limit: 0 }),    /limit/);
  await assert.rejects(ctx.pwa.listVersions({ limit: 9999 }), /limit/);

  // Activate v3, then archive it — archive clears the active flag.
  await ctx.pwa.setActive(3);
  var activeBeforeArchive = await ctx.pwa.getActive();
  check("v3 is active before archive",           activeBeforeArchive.version_number === 3);

  var archived = await ctx.pwa.archiveVersion(3);
  check("archiveVersion returns archived row",   archived.archived_at != null);
  check("archiveVersion clears is_active",       archived.is_active === false);

  var afterArchive = await ctx.pwa.getActive();
  check("getActive null after archive of active", afterArchive === null);

  // Re-archiving is idempotent.
  var twice = await ctx.pwa.archiveVersion(3);
  check("archiveVersion idempotent",             twice.archived_at != null);

  // Unknown version refused.
  await assert.rejects(ctx.pwa.archiveVersion(999), /not found/);
}

async function _serviceWorkerConfigRoundTrip() {
  var ctx = _setup();

  // Define a SW config.
  var sw1 = await ctx.pwa.defineServiceWorkerConfig({
    cache_name: "shop-v1",
    precache_urls: ["/", "/offline.html", "/icons/192.png"],
    runtime_rules: [
      { url_pattern: "/api/", strategy: "network-first" },
      { url_pattern: "/static/", strategy: "cache-first" },
      { url_pattern: "/products/", strategy: "stale-while-revalidate" },
    ],
    offline_fallback:    "/offline.html",
    navigation_fallback: "/",
  });
  check("defineServiceWorkerConfig version 1",     sw1.version_number === 1);
  check("defineServiceWorkerConfig persists cache_name", sw1.cache_name === "shop-v1");
  check("defineServiceWorkerConfig persists precache", sw1.precache_urls.length === 3);
  check("defineServiceWorkerConfig persists runtime rules", sw1.runtime_rules.length === 3);
  check("defineServiceWorkerConfig persists offline_fallback", sw1.offline_fallback === "/offline.html");

  // No active SW config yet.
  await assert.rejects(ctx.pwa.renderServiceWorkerJs(), /no active service-worker config/);

  // Set active + render.
  await ctx.pwa.setActive("sw", sw1.version_number);
  var swActive = await ctx.pwa.getActive("sw");
  check("getActive('sw') returns active sw",     swActive.version_number === sw1.version_number);
  check("getActive('sw') is_active=true",        swActive.is_active === true);

  var js = await ctx.pwa.renderServiceWorkerJs();
  check("renderServiceWorkerJs returns string",  typeof js === "string" && js.length > 0);
  check("renderServiceWorkerJs has install handler", js.indexOf("addEventListener('install'") !== -1);
  check("renderServiceWorkerJs has fetch handler",   js.indexOf("addEventListener('fetch'") !== -1);
  check("renderServiceWorkerJs has cache_name",      js.indexOf('"shop-v1"') !== -1);
  check("renderServiceWorkerJs embeds precache",     js.indexOf('"/offline.html"') !== -1);
  check("renderServiceWorkerJs embeds api rule",     js.indexOf('"/api/"') !== -1);
  check("renderServiceWorkerJs embeds network-first", js.indexOf("network-first") !== -1);

  // Second SW config → version 2.
  var sw2 = await ctx.pwa.defineServiceWorkerConfig({
    cache_name: "shop-v2",
    precache_urls: ["/"],
    runtime_rules: [],
  });
  check("second defineServiceWorkerConfig is v2", sw2.version_number === 2);

  // listVersions('sw', ...) routes to the SW table.
  var swList = await ctx.pwa.listVersions("sw", {});
  check("listVersions('sw') returns 2 rows",     swList.rows.length === 2);
  check("listVersions('sw') newest-first",       swList.rows[0].version_number === 2);

  // Manifest listVersions ignores SW rows.
  var manifestList = await ctx.pwa.listVersions({});
  check("listVersions (manifest) ignores sw rows", manifestList.rows.length === 0);

  // Refusals.
  await assert.rejects(ctx.pwa.defineServiceWorkerConfig(), /input object required/);
  await assert.rejects(ctx.pwa.defineServiceWorkerConfig({
    cache_name: "BAD CAPS", precache_urls: [], runtime_rules: [],
  }), /cache_name/);
  await assert.rejects(ctx.pwa.defineServiceWorkerConfig({
    cache_name: "ok", precache_urls: ["javascript:alert(1)"], runtime_rules: [],
  }), /precache_urls/);
  await assert.rejects(ctx.pwa.defineServiceWorkerConfig({
    cache_name: "ok", precache_urls: ["/", "/"], runtime_rules: [],
  }), /duplicates/);
  await assert.rejects(ctx.pwa.defineServiceWorkerConfig({
    cache_name: "ok", precache_urls: [], runtime_rules: [
      { url_pattern: "/api/", strategy: "weird-strategy" },
    ],
  }), /strategy/);
  await assert.rejects(ctx.pwa.defineServiceWorkerConfig({
    cache_name: "ok", precache_urls: [], runtime_rules: [
      { url_pattern: "/api/", strategy: "cache-first" },
      { url_pattern: "/api/", strategy: "network-first" },
    ],
  }), /duplicates/);
  await assert.rejects(ctx.pwa.defineServiceWorkerConfig({
    cache_name: "ok", precache_urls: [], runtime_rules: [],
    offline_fallback: "http://evil.example.com/",
  }), /offline_fallback/);

  // setActive on unknown scope refused.
  await assert.rejects(ctx.pwa.setActive("manifesto", 1), /scope/);
}

async function run() {
  await _defineManifestHappyPath();
  await _defineManifestColorRefusal();
  await _defineManifestRefusals();
  await _validateIconsSurface();
  await _setActiveFlip();
  await _renderManifestJsonShape();
  await _listVersionsAndArchive();
  await _serviceWorkerConfigRoundTrip();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/pwa-manifest.test.js`.
if (require.main === module) {
  // bShop import is required for the entry-point smoke side-effect
  // (mirrors knowledge-base.test.js). The variable read silences
  // "unused require" lint signals without changing posture.
  void bShop;
  run().then(function () {
    console.log("OK — pwa-manifest (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — pwa-manifest: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
