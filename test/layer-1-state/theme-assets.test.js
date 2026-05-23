"use strict";
/**
 * themeAssets — operator-uploaded theme artifacts (fonts, logos,
 * hero images, favicons, banner / og / icon images, plus a `custom`
 * escape hatch). Distinct from `theme` (active-theme slug + template
 * directory); this is the asset catalog + content-addressed storage
 * references.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0131_theme_assets.sql alone — the primitive has no FKs into the
 * rest of the schema, so the test runs against a minimal in-memory
 * database with just the theme_assets + theme_asset_impressions
 * tables. The primitive isn't wired through `bShop` yet — the test
 * requires `lib/theme-assets.js` directly so the gate exists ahead
 * of the entry-point edit.
 *
 * Coverage:
 *   - registerAsset happy path persists every input field, content-
 *     addressed digest round-trips, impression_count initialized to
 *     zero, archived_at null on insert.
 *   - registerAsset refusals: bad slug, bad kind, bad content_type,
 *     non-hex / wrong-length / uppercase sha3_512, negative byte_size,
 *     javascript: / data: / non-https source_url, protocol-relative
 *     //host, control-byte alt_text, duplicate slug.
 *   - assetsByKind filter: matches the kind enum, drops archived
 *     rows, combined kind + theme_slug filter narrows correctly,
 *     theme_slug: null branch returns only library assets.
 *   - assignToTheme: swaps theme assignment, assetsForTheme reflects
 *     the new mapping, detach (theme_slug: null) returns the asset
 *     to the library, refuses archived assets.
 *   - recordImpression: counter bump, impression-event row appended,
 *     drop-silent on bad slug / missing row / archived row.
 *   - metricsForAsset: returns the windowed impression count + the
 *     lifetime denormalized count; bad window refused.
 *   - cleanupOrphans: archives library assets (theme_slug IS NULL)
 *     older than the idle cutoff, leaves theme-assigned assets
 *     alone, leaves already-archived rows alone, returns archived
 *     count.
 *   - updateAsset: patches content_type / source_url / alt_text /
 *     byte_size / sha3_512; refuses unsupported columns + archived
 *     assets.
 *   - archiveAsset: stamps archived_at, idempotent-refusal on
 *     re-archive, drops the row from assetsForTheme / assetsByKind.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var themeAssets = require("../../lib/theme-assets");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0131_theme_assets.sql");

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
  var assets = themeAssets.create({ query: query });
  return { query: query, assets: assets };
}

// 128-char lowercase hex strings the validator accepts. Built from
// repeated nybbles so the test's intent ("a valid digest, different
// from the next valid digest") stays readable at a glance.
function _digest(nybble) {
  var s = "";
  for (var i = 0; i < 128; i += 1) s += nybble;
  return s;
}
var DIGEST_A = _digest("a");
var DIGEST_B = _digest("b");
var DIGEST_C = _digest("c");

// ---- registerAsset happy path + refusals -------------------------------

async function _registerHappyAndRefusals() {
  var ctx = _setup();

  var a = await ctx.assets.registerAsset({
    slug:         "primary-logo",
    kind:         "logo",
    content_type: "image/svg+xml",
    sha3_512:     DIGEST_A,
    byte_size:    4321,
    source_url:   "https://cdn.example.com/themes/acme/logo.svg",
    alt_text:     "Acme",
    theme_slug:   "acme",
  });
  check("registerAsset persists slug",         a.slug === "primary-logo");
  check("registerAsset persists kind",         a.kind === "logo");
  check("registerAsset persists content_type", a.content_type === "image/svg+xml");
  check("registerAsset persists sha3_512",     a.sha3_512 === DIGEST_A);
  check("registerAsset persists byte_size",    a.byte_size === 4321);
  check("registerAsset persists source_url",   a.source_url === "https://cdn.example.com/themes/acme/logo.svg");
  check("registerAsset persists alt_text",     a.alt_text === "Acme");
  check("registerAsset persists theme_slug",   a.theme_slug === "acme");
  check("registerAsset impression_count 0",    a.impression_count === 0);
  check("registerAsset archived_at null",      a.archived_at === null);
  check("registerAsset created_at numeric",    typeof a.created_at === "number" && a.created_at > 0);
  check("registerAsset updated_at = created_at", a.updated_at === a.created_at);

  // /-rooted internal source_url permitted (e.g. R2-passthrough).
  var b = await ctx.assets.registerAsset({
    slug:         "internal-font",
    kind:         "font",
    content_type: "font/woff2",
    sha3_512:     DIGEST_B,
    byte_size:    21000,
    source_url:   "/assets/themes/acme/fonts/inter.woff2",
  });
  check("registerAsset /-rooted source_url accepted", b.source_url === "/assets/themes/acme/fonts/inter.woff2");
  check("registerAsset null alt_text on font",        b.alt_text === null);
  check("registerAsset null theme_slug when omitted", b.theme_slug === null);

  // Refusals — missing input.
  await assert.rejects(ctx.assets.registerAsset(),                /input object required/);
  await assert.rejects(ctx.assets.registerAsset("not-an-object"), /input object required/);

  // Bad slug shape.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "-bad", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "https://example.com/a",
  }), /slug/);

  // Bad kind.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-kind", kind: "background-music", content_type: "audio/mpeg",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "https://example.com/a",
  }), /kind/);

  // Bad content_type shape.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-ct", kind: "logo", content_type: "not-a-mime-type",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "https://example.com/a",
  }), /content_type/);

  // Bad sha3_512 — uppercase hex.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-sha-upper", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A.toUpperCase(), byte_size: 1, source_url: "https://example.com/a",
  }), /sha3_512/);

  // Bad sha3_512 — wrong length.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-sha-short", kind: "logo", content_type: "image/svg+xml",
    sha3_512: "abc", byte_size: 1, source_url: "https://example.com/a",
  }), /sha3_512/);

  // Bad sha3_512 — non-hex characters.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-sha-nonhex", kind: "logo", content_type: "image/svg+xml",
    sha3_512: _digest("z"), byte_size: 1, source_url: "https://example.com/a",
  }), /sha3_512/);

  // Bad byte_size — negative.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-size", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: -1, source_url: "https://example.com/a",
  }), /byte_size/);

  // Bad byte_size — non-integer.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-size-2", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1.5, source_url: "https://example.com/a",
  }), /byte_size/);

  // Bad source_url — javascript:.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "js-url", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "javascript:alert(1)",
  }), /source_url/);

  // Bad source_url — data:.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "data-url", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "data:image/svg+xml,<svg/>",
  }), /source_url/);

  // Bad source_url — protocol-relative.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "proto-rel", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "//cdn.example.com/a",
  }), /source_url/);

  // Bad source_url — http:// (must be https://).
  await assert.rejects(ctx.assets.registerAsset({
    slug: "http-url", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "http://example.com/a",
  }), /source_url/);

  // Bad source_url — /-rooted with traversal.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "traversal", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "/assets/../etc/passwd",
  }), /source_url/);

  // Control bytes in alt_text.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "ctrl-alt", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "https://example.com/a",
    alt_text: "bad\x00byte",
  }), /alt_text/);

  // Bad theme_slug shape.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "bad-theme", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 1, source_url: "https://example.com/a",
    theme_slug: "-bad",
  }), /theme_slug/);

  // Duplicate slug.
  await assert.rejects(ctx.assets.registerAsset({
    slug: "primary-logo", kind: "favicon", content_type: "image/x-icon",
    sha3_512: DIGEST_C, byte_size: 1, source_url: "https://example.com/b",
  }), /already exists/);
}

// ---- assetsByKind filter + combined theme filter -----------------------

async function _assetsByKindFilter() {
  var ctx = _setup();

  await ctx.assets.registerAsset({
    slug: "logo-acme", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 100,
    source_url: "https://cdn.example.com/acme/logo.svg",
    theme_slug: "acme",
  });
  await ctx.assets.registerAsset({
    slug: "logo-beta", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_B, byte_size: 100,
    source_url: "https://cdn.example.com/beta/logo.svg",
    theme_slug: "beta",
  });
  await ctx.assets.registerAsset({
    slug: "logo-library", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_C, byte_size: 100,
    source_url: "https://cdn.example.com/library/logo.svg",
  });
  await ctx.assets.registerAsset({
    slug: "font-acme", kind: "font", content_type: "font/woff2",
    sha3_512: _digest("d"), byte_size: 21000,
    source_url: "https://cdn.example.com/acme/font.woff2",
    theme_slug: "acme",
  });

  // Every logo regardless of theme assignment.
  var allLogos = await ctx.assets.assetsByKind({ kind: "logo" });
  check("assetsByKind logo returns 3", allLogos.length === 3);
  check("assetsByKind logo includes acme",    allLogos.some(function (a) { return a.slug === "logo-acme"; }));
  check("assetsByKind logo includes beta",    allLogos.some(function (a) { return a.slug === "logo-beta"; }));
  check("assetsByKind logo includes library", allLogos.some(function (a) { return a.slug === "logo-library"; }));

  // Logos for theme=acme only.
  var acmeLogos = await ctx.assets.assetsByKind({ kind: "logo", theme_slug: "acme" });
  check("assetsByKind logo + acme returns 1", acmeLogos.length === 1);
  check("assetsByKind logo + acme slug",      acmeLogos[0].slug === "logo-acme");

  // Library logos (theme_slug: null).
  var libraryLogos = await ctx.assets.assetsByKind({ kind: "logo", theme_slug: null });
  check("assetsByKind logo + null returns 1", libraryLogos.length === 1);
  check("assetsByKind logo + null slug",      libraryLogos[0].slug === "logo-library");

  // Fonts (different kind).
  var fonts = await ctx.assets.assetsByKind({ kind: "font" });
  check("assetsByKind font returns 1",  fonts.length === 1);
  check("assetsByKind font slug",       fonts[0].slug === "font-acme");

  // Hero images (no rows).
  var heros = await ctx.assets.assetsByKind({ kind: "hero_image" });
  check("assetsByKind hero_image empty", heros.length === 0);

  // Archived rows drop out of assetsByKind.
  await ctx.assets.archiveAsset("logo-beta");
  var afterArchive = await ctx.assets.assetsByKind({ kind: "logo" });
  check("assetsByKind logo excludes archived", afterArchive.length === 2);
  check("assetsByKind logo excluded beta",
    !afterArchive.some(function (a) { return a.slug === "logo-beta"; }));

  // Refusals.
  await assert.rejects(ctx.assets.assetsByKind(),                  /input object required/);
  await assert.rejects(ctx.assets.assetsByKind({ kind: "nope" }),  /kind/);
}

// ---- assignToTheme + assetsForTheme reflects ---------------------------

async function _assignToThemeAndAssetsForTheme() {
  var ctx = _setup();

  await ctx.assets.registerAsset({
    slug: "favicon-shared", kind: "favicon", content_type: "image/x-icon",
    sha3_512: DIGEST_A, byte_size: 1024,
    source_url: "https://cdn.example.com/favicon.ico",
  });
  await ctx.assets.registerAsset({
    slug: "logo-shared", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_B, byte_size: 4096,
    source_url: "https://cdn.example.com/logo.svg",
  });

  // Nothing assigned to acme yet.
  var preAssign = await ctx.assets.assetsForTheme("acme");
  check("assetsForTheme pre-assign empty", preAssign.length === 0);

  // Assign both to acme.
  var assigned1 = await ctx.assets.assignToTheme({ slug: "favicon-shared", theme_slug: "acme" });
  check("assignToTheme sets theme_slug", assigned1.theme_slug === "acme");
  await ctx.assets.assignToTheme({ slug: "logo-shared", theme_slug: "acme" });

  var acmeAssets = await ctx.assets.assetsForTheme("acme");
  check("assetsForTheme acme returns 2", acmeAssets.length === 2);
  check("assetsForTheme acme includes favicon",
    acmeAssets.some(function (a) { return a.slug === "favicon-shared"; }));
  check("assetsForTheme acme includes logo",
    acmeAssets.some(function (a) { return a.slug === "logo-shared"; }));

  // Swap favicon-shared to beta.
  var swapped = await ctx.assets.assignToTheme({ slug: "favicon-shared", theme_slug: "beta" });
  check("assignToTheme swaps theme_slug", swapped.theme_slug === "beta");
  var acmeAfter = await ctx.assets.assetsForTheme("acme");
  check("assetsForTheme acme after swap returns 1", acmeAfter.length === 1);
  check("assetsForTheme acme after swap slug",       acmeAfter[0].slug === "logo-shared");
  var betaAfter = await ctx.assets.assetsForTheme("beta");
  check("assetsForTheme beta after swap returns 1", betaAfter.length === 1);
  check("assetsForTheme beta after swap slug",       betaAfter[0].slug === "favicon-shared");

  // Detach (theme_slug: null) returns the asset to the library.
  var detached = await ctx.assets.assignToTheme({ slug: "favicon-shared", theme_slug: null });
  check("assignToTheme detach sets null",   detached.theme_slug === null);
  var betaEmpty = await ctx.assets.assetsForTheme("beta");
  check("assetsForTheme beta after detach", betaEmpty.length === 0);

  // Archived asset refuses to be reassigned.
  await ctx.assets.archiveAsset("favicon-shared");
  await assert.rejects(ctx.assets.assignToTheme({
    slug: "favicon-shared", theme_slug: "acme",
  }), /archived/);

  // Refusals.
  await assert.rejects(ctx.assets.assignToTheme(),                       /input object required/);
  await assert.rejects(ctx.assets.assignToTheme({ slug: "logo-shared" }), /theme_slug required/);
  await assert.rejects(ctx.assets.assignToTheme({
    slug: "ghost", theme_slug: "acme",
  }), /not found/);
}

// ---- recordImpression counter ------------------------------------------

async function _recordImpressionCounter() {
  var ctx = _setup();

  await ctx.assets.registerAsset({
    slug: "tracked", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 100,
    source_url: "https://cdn.example.com/tracked.svg",
    theme_slug: "acme",
  });

  // Three impressions land.
  var r1 = await ctx.assets.recordImpression("tracked");
  check("recordImpression recorded true",  r1.recorded === true);
  check("recordImpression returns id",     typeof r1.id === "string" && r1.id.length > 0);
  await ctx.assets.recordImpression("tracked");
  await ctx.assets.recordImpression("tracked");

  var asset = await ctx.assets.getAsset("tracked");
  check("recordImpression bumps counter to 3", asset.impression_count === 3);

  // metricsForAsset returns the windowed count.
  var m = await ctx.assets.metricsForAsset({ slug: "tracked", from: 0, to: Date.now() + 1000000 });
  check("metricsForAsset windowed count",   m.impressions === 3);
  check("metricsForAsset lifetime count",   m.lifetime_impressions === 3);
  check("metricsForAsset returns slug",     m.slug === "tracked");
  check("metricsForAsset returns window from", m.from === 0);

  // Empty window returns zero.
  var mEmpty = await ctx.assets.metricsForAsset({ slug: "tracked", from: 1, to: 2 });
  check("metricsForAsset empty window", mEmpty.impressions === 0);
  // Lifetime still reads as 3.
  check("metricsForAsset lifetime survives empty window", mEmpty.lifetime_impressions === 3);

  // Drop-silent: bad slug shape.
  var rDrop = await ctx.assets.recordImpression("-bad slug");
  check("recordImpression drop-silent bad slug", rDrop.recorded === false);

  // Drop-silent: missing slug.
  var rGhost = await ctx.assets.recordImpression("ghost");
  check("recordImpression drop-silent missing", rGhost.recorded === false);

  // Drop-silent: archived row.
  await ctx.assets.archiveAsset("tracked");
  var rArch = await ctx.assets.recordImpression("tracked");
  check("recordImpression drop-silent archived", rArch.recorded === false);

  // metricsForAsset refusals.
  await assert.rejects(ctx.assets.metricsForAsset(),                                /input object required/);
  await assert.rejects(ctx.assets.metricsForAsset({ slug: "tracked", from: 2, to: 1 }), /to/);
  await assert.rejects(ctx.assets.metricsForAsset({ slug: "tracked", from: -1, to: 2 }), /from/);
  await assert.rejects(ctx.assets.metricsForAsset({ slug: "ghost", from: 0, to: 1 }), /not found/);
}

// ---- cleanupOrphans ----------------------------------------------------

async function _cleanupOrphans() {
  var ctx = _setup();

  // Register an asset assigned to a theme — must survive cleanup.
  await ctx.assets.registerAsset({
    slug: "assigned-logo", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 100,
    source_url: "https://cdn.example.com/assigned.svg",
    theme_slug: "acme",
  });

  // Register a library asset (no theme).
  await ctx.assets.registerAsset({
    slug: "library-orphan", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_B, byte_size: 100,
    source_url: "https://cdn.example.com/orphan.svg",
  });

  // Backdate the library asset's updated_at past the cutoff. Direct
  // SQL bypass — the test wants a stale row without waiting in real
  // time.
  await ctx.query(
    "UPDATE theme_assets SET updated_at = ?1 WHERE slug = ?2",
    [Date.now() - 30 * 86400000, "library-orphan"],
  );

  // Register a fresh library asset — must survive a 14-day cutoff.
  await ctx.assets.registerAsset({
    slug: "library-fresh", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_C, byte_size: 100,
    source_url: "https://cdn.example.com/fresh.svg",
  });

  // Cleanup with a 14-day idle threshold.
  var r = await ctx.assets.cleanupOrphans({ days_idle: 14 });
  check("cleanupOrphans archived 1", r.archived === 1);

  // Library orphan is now archived.
  var orphan = await ctx.assets.getAsset("library-orphan");
  check("cleanupOrphans archived library orphan", orphan.archived_at != null);

  // Theme-assigned asset survives.
  var assigned = await ctx.assets.getAsset("assigned-logo");
  check("cleanupOrphans leaves theme-assigned", assigned.archived_at === null);

  // Fresh library asset survives.
  var fresh = await ctx.assets.getAsset("library-fresh");
  check("cleanupOrphans leaves fresh library", fresh.archived_at === null);

  // Re-running cleanup is a no-op (the orphan is already archived).
  var r2 = await ctx.assets.cleanupOrphans({ days_idle: 14 });
  check("cleanupOrphans idempotent", r2.archived === 0);

  // days_idle = 0 archives every active library asset (cutoff = now,
  // every row has updated_at < now after the monotonic clock bump).
  var r3 = await ctx.assets.cleanupOrphans({ days_idle: 0 });
  check("cleanupOrphans days_idle 0 archived fresh library", r3.archived === 1);
  var freshAfter = await ctx.assets.getAsset("library-fresh");
  check("cleanupOrphans days_idle 0 stamped fresh", freshAfter.archived_at != null);

  // Refusals.
  await assert.rejects(ctx.assets.cleanupOrphans(),                       /input object required/);
  await assert.rejects(ctx.assets.cleanupOrphans({ days_idle: -1 }),      /days_idle/);
  await assert.rejects(ctx.assets.cleanupOrphans({ days_idle: 1.5 }),     /days_idle/);
  await assert.rejects(ctx.assets.cleanupOrphans({ days_idle: "seven" }), /days_idle/);
}

// ---- updateAsset + archiveAsset ----------------------------------------

async function _updateAndArchive() {
  var ctx = _setup();
  await ctx.assets.registerAsset({
    slug: "u", kind: "logo", content_type: "image/svg+xml",
    sha3_512: DIGEST_A, byte_size: 100,
    source_url: "https://cdn.example.com/u.svg",
    alt_text: "Original",
    theme_slug: "acme",
  });

  // Patch each updatable column.
  var u1 = await ctx.assets.updateAsset("u", { content_type: "image/png" });
  check("update persists content_type", u1.content_type === "image/png");

  var u2 = await ctx.assets.updateAsset("u", {
    source_url: "https://cdn.example.com/u-v2.png",
  });
  check("update persists source_url", u2.source_url === "https://cdn.example.com/u-v2.png");

  var u3 = await ctx.assets.updateAsset("u", { alt_text: "Updated" });
  check("update persists alt_text", u3.alt_text === "Updated");

  var u4 = await ctx.assets.updateAsset("u", { byte_size: 500 });
  check("update persists byte_size", u4.byte_size === 500);

  var u5 = await ctx.assets.updateAsset("u", { sha3_512: DIGEST_B });
  check("update persists sha3_512", u5.sha3_512 === DIGEST_B);

  // Unsupported column refused.
  await assert.rejects(ctx.assets.updateAsset("u", { kind: "favicon" }),       /unsupported column/);
  await assert.rejects(ctx.assets.updateAsset("u", { theme_slug: "beta" }),    /unsupported column/);
  await assert.rejects(ctx.assets.updateAsset("u", { impression_count: 99 }),  /unsupported column/);

  // Empty patch refused.
  await assert.rejects(ctx.assets.updateAsset("u", {}), /at least one column/);

  // Unknown slug refused.
  await assert.rejects(ctx.assets.updateAsset("ghost", { alt_text: "x" }), /not found/);

  // Bad value still validated.
  await assert.rejects(ctx.assets.updateAsset("u", { source_url: "javascript:1" }), /source_url/);

  // Archive + re-archive refused.
  var archived = await ctx.assets.archiveAsset("u");
  check("archive stamps archived_at",
    typeof archived.archived_at === "number" && archived.archived_at > 0);
  await assert.rejects(ctx.assets.archiveAsset("u"),     /already archived/);
  await assert.rejects(ctx.assets.archiveAsset("ghost"), /not found/);

  // Update on an archived asset refused.
  await assert.rejects(ctx.assets.updateAsset("u", { alt_text: "y" }), /archived/);

  // Archived asset drops from assetsForTheme.
  var afterArchive = await ctx.assets.assetsForTheme("acme");
  check("archive removes from assetsForTheme", afterArchive.length === 0);
}

async function run() {
  await _registerHappyAndRefusals();
  await _assetsByKindFilter();
  await _assignToThemeAndAssetsForTheme();
  await _recordImpressionCounter();
  await _cleanupOrphans();
  await _updateAndArchive();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/theme-assets.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("theme-assets: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
