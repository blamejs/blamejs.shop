"use strict";
/**
 * translations — per-resource translation table for storefront
 * localization. Layer 1 against an in-memory node:sqlite database;
 * mounts only the translations migration since the primitive owns
 * its single table and doesn't read from any sibling tables.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/translations.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - setTranslation persists a row + roundtrips
 *   - setTranslation upserts on the UNIQUE (kind, id, locale, field)
 *     index — re-authoring overwrites in place
 *   - setTranslation HTML-escapes value at write; newlines survive
 *   - locale fallback chain: fr-CA -> fr -> en (and `en` baseline
 *     always appended)
 *   - getForResource returns every field at the locale, picking the
 *     most-specific candidate per field independently
 *   - removeTranslation with + without `field`
 *   - localesForResource enumerates distinct locales
 *   - missingTranslations identifies resources lacking the locale
 *   - bulkSet atomicity: bad row fails the whole batch
 *   - input refusals: bad locale shape, bad kind shape, oversize
 *     value, control bytes, zero-width chars
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var translations = require("../../lib/translations");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

void bShop;   // touch the entry point so the require cycle is exercised

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0070_translations.sql");

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
  var t = translations.create({ query: query });
  return { query: query, t: t };
}

async function _setTranslationHappyPath() {
  var ctx = _setup();

  var row = await ctx.t.setTranslation({
    resource_kind: "product",
    resource_id:   "sku-001",
    locale:        "fr",
    field:         "title",
    value:         "Chemise bleue",
  });
  check("setTranslation: returns id",             typeof row.id === "string" && row.id.length > 0);
  check("setTranslation: returns kind",           row.resource_kind === "product");
  check("setTranslation: returns resource_id",    row.resource_id === "sku-001");
  check("setTranslation: returns canonical locale", row.locale === "fr");
  check("setTranslation: returns field",          row.field === "title");
  check("setTranslation: returns escaped value",  row.value === "Chemise bleue");
  check("setTranslation: stamps updated_at",      Number.isInteger(row.updated_at) && row.updated_at > 0);

  // Round-trip through getTranslation
  var got = await ctx.t.getTranslation({
    resource_kind: "product",
    resource_id:   "sku-001",
    locale:        "fr",
    field:         "title",
  });
  check("getTranslation: returns row",            got !== null);
  check("getTranslation: value matches",          got.value === "Chemise bleue");
  check("getTranslation: matched_locale exact",   got.matched_locale === "fr");
  check("getTranslation: requested_locale echoes", got.requested_locale === "fr");

  // Locale region normalises (fr-ca -> fr-CA, FR-CA -> fr-CA)
  var normalized = await ctx.t.setTranslation({
    resource_kind: "product",
    resource_id:   "sku-001",
    locale:        "fr-ca",
    field:         "title",
    value:         "Chandail bleu",
  });
  check("setTranslation: locale region normalises to upper", normalized.locale === "fr-CA");
}

async function _setTranslationUpsertAndEscape() {
  var ctx = _setup();

  // First write
  var a = await ctx.t.setTranslation({
    resource_kind: "product",
    resource_id:   "sku-001",
    locale:        "fr",
    field:         "description",
    value:         "Première version",
  });

  // Re-write the same (kind, id, locale, field) — UNIQUE-backed upsert
  var b = await ctx.t.setTranslation({
    resource_kind: "product",
    resource_id:   "sku-001",
    locale:        "fr",
    field:         "description",
    value:         "Deuxième version",
  });

  check("setTranslation: upsert returns updated value",
    b.value === "Deuxième version");
  check("setTranslation: upsert advances updated_at",
    b.updated_at >= a.updated_at);

  // Only one row should be present for the (kind, id, locale, field) tuple
  var n = (await ctx.query(
    "SELECT COUNT(*) AS n FROM translations WHERE resource_kind = ?1 AND resource_id = ?2 AND locale = ?3 AND field = ?4",
    ["product", "sku-001", "fr", "description"]
  )).rows[0].n;
  check("setTranslation: upsert leaves exactly one row", Number(n) === 1);

  // HTML escape — hostile script tag lands inert; newlines preserved
  var hostile = await ctx.t.setTranslation({
    resource_kind: "page",
    resource_id:   "about",
    locale:        "en",
    field:         "body",
    value:         "Hello <script>alert(1)</script>\nNewline preserved\n& ampersand",
  });
  check("setTranslation: < escaped",      hostile.value.indexOf("&lt;") !== -1);
  check("setTranslation: > escaped",      hostile.value.indexOf("&gt;") !== -1);
  check("setTranslation: & escaped",      hostile.value.indexOf("&amp;") !== -1);
  check("setTranslation: no raw <script>", hostile.value.indexOf("<script>") === -1);
  check("setTranslation: newline preserved", hostile.value.indexOf("\n") !== -1);
}

async function _localeFallbackChain() {
  var ctx = _setup();

  // Seed only the English title; fr-CA lookup must fall through to en.
  await ctx.t.setTranslation({
    resource_kind: "product",
    resource_id:   "sku-fallback",
    locale:        "en",
    field:         "title",
    value:         "Blue shirt",
  });
  var enOnly = await ctx.t.getTranslation({
    resource_kind: "product",
    resource_id:   "sku-fallback",
    locale:        "fr-CA",
    field:         "title",
  });
  check("fallback: fr-CA falls through to en",       enOnly !== null && enOnly.value === "Blue shirt");
  check("fallback: matched_locale is en",            enOnly.matched_locale === "en");
  check("fallback: requested_locale echoes fr-CA",   enOnly.requested_locale === "fr-CA");

  // Add a metropolitan French row — fr-CA now resolves to fr, not en.
  await ctx.t.setTranslation({
    resource_kind: "product",
    resource_id:   "sku-fallback",
    locale:        "fr",
    field:         "title",
    value:         "Chemise bleue",
  });
  var frMatch = await ctx.t.getTranslation({
    resource_kind: "product",
    resource_id:   "sku-fallback",
    locale:        "fr-CA",
    field:         "title",
  });
  check("fallback: fr-CA -> fr when fr present",     frMatch.matched_locale === "fr");
  check("fallback: fr value returned",               frMatch.value === "Chemise bleue");

  // Add the Canadian French row — most-specific wins.
  await ctx.t.setTranslation({
    resource_kind: "product",
    resource_id:   "sku-fallback",
    locale:        "fr-CA",
    field:         "title",
    value:         "Chandail bleu",
  });
  var frCaMatch = await ctx.t.getTranslation({
    resource_kind: "product",
    resource_id:   "sku-fallback",
    locale:        "fr-CA",
    field:         "title",
  });
  check("fallback: most-specific locale wins",       frCaMatch.matched_locale === "fr-CA");
  check("fallback: fr-CA value returned",            frCaMatch.value === "Chandail bleu");

  // No row at all -> null
  var missing = await ctx.t.getTranslation({
    resource_kind: "product",
    resource_id:   "sku-unknown",
    locale:        "fr-CA",
    field:         "title",
  });
  check("fallback: unknown resource returns null",   missing === null);
}

async function _getForResourceMultipleFields() {
  var ctx = _setup();

  // English baseline for three fields
  await ctx.t.bulkSet([
    { resource_kind: "product", resource_id: "sku-multi", locale: "en", field: "title",       value: "Blue shirt" },
    { resource_kind: "product", resource_id: "sku-multi", locale: "en", field: "description", value: "Cotton, breathable" },
    { resource_kind: "product", resource_id: "sku-multi", locale: "en", field: "care",        value: "Machine wash cold" },
  ]);
  // French — title + description, but not `care`
  await ctx.t.bulkSet([
    { resource_kind: "product", resource_id: "sku-multi", locale: "fr", field: "title",       value: "Chemise bleue" },
    { resource_kind: "product", resource_id: "sku-multi", locale: "fr", field: "description", value: "Coton, respirant" },
  ]);
  // Canadian French — title only, the most specific shape
  await ctx.t.setTranslation({
    resource_kind: "product", resource_id: "sku-multi", locale: "fr-CA", field: "title", value: "Chandail bleu",
  });

  var bundle = await ctx.t.getForResource({
    resource_kind: "product",
    resource_id:   "sku-multi",
    locale:        "fr-CA",
  });
  check("getForResource: returns kind + id + requested locale",
    bundle.resource_kind === "product"
      && bundle.resource_id === "sku-multi"
      && bundle.requested_locale === "fr-CA");
  check("getForResource: title matched at fr-CA",
    bundle.fields.title.matched_locale === "fr-CA"
      && bundle.fields.title.value === "Chandail bleu");
  check("getForResource: description matched at fr",
    bundle.fields.description.matched_locale === "fr"
      && bundle.fields.description.value === "Coton, respirant");
  check("getForResource: care fell back to en",
    bundle.fields.care.matched_locale === "en"
      && bundle.fields.care.value === "Machine wash cold");

  // Resource with no translations at all -> empty fields object
  var empty = await ctx.t.getForResource({
    resource_kind: "product",
    resource_id:   "sku-empty",
    locale:        "fr-CA",
  });
  check("getForResource: empty fields object on miss",
    empty.fields && Object.keys(empty.fields).length === 0);
}

async function _removeAndLocalesForResource() {
  var ctx = _setup();

  await ctx.t.bulkSet([
    { resource_kind: "product", resource_id: "sku-rm", locale: "en",    field: "title", value: "Blue shirt" },
    { resource_kind: "product", resource_id: "sku-rm", locale: "fr",    field: "title", value: "Chemise" },
    { resource_kind: "product", resource_id: "sku-rm", locale: "fr",    field: "body",  value: "Description FR" },
    { resource_kind: "product", resource_id: "sku-rm", locale: "fr-CA", field: "title", value: "Chandail" },
  ]);

  // localesForResource enumerates distinct locales
  var locs = await ctx.t.localesForResource({
    resource_kind: "product", resource_id: "sku-rm",
  });
  check("localesForResource: returns 3 locales",
    locs.length === 3 && locs.indexOf("en") !== -1 && locs.indexOf("fr") !== -1 && locs.indexOf("fr-CA") !== -1);

  // removeTranslation(field) — remove just one field/locale
  var r1 = await ctx.t.removeTranslation({
    resource_kind: "product", resource_id: "sku-rm", locale: "fr", field: "body",
  });
  check("removeTranslation: removed=1 for matching field", r1.removed === 1);

  // removeTranslation() with no field — remove every field for the locale
  var r2 = await ctx.t.removeTranslation({
    resource_kind: "product", resource_id: "sku-rm", locale: "fr",
  });
  check("removeTranslation: removed=1 for remaining fr row", r2.removed === 1);

  // After removing every fr row, localesForResource shows only en + fr-CA
  var locs2 = await ctx.t.localesForResource({
    resource_kind: "product", resource_id: "sku-rm",
  });
  check("localesForResource: fr removed",
    locs2.length === 2 && locs2.indexOf("fr") === -1);

  // Remove non-existent
  var r3 = await ctx.t.removeTranslation({
    resource_kind: "product", resource_id: "sku-rm", locale: "de", field: "title",
  });
  check("removeTranslation: removed=0 on miss", r3.removed === 0);
}

async function _missingTranslationsIdentifiesGaps() {
  var ctx = _setup();

  // Three products with English translations
  await ctx.t.bulkSet([
    { resource_kind: "product", resource_id: "sku-a", locale: "en", field: "title", value: "Alpha" },
    { resource_kind: "product", resource_id: "sku-b", locale: "en", field: "title", value: "Beta"  },
    { resource_kind: "product", resource_id: "sku-c", locale: "en", field: "title", value: "Gamma" },
  ]);
  // Only sku-a has a French translation
  await ctx.t.setTranslation({
    resource_kind: "product", resource_id: "sku-a", locale: "fr", field: "title", value: "Alpha-fr",
  });

  var report = await ctx.t.missingTranslations({
    resource_kind: "product",
    locale:        "fr",
  });
  check("missingTranslations: returns kind",         report.resource_kind === "product");
  check("missingTranslations: returns chain",
    Array.isArray(report.fallback_chain) && report.fallback_chain[0] === "fr" && report.fallback_chain.indexOf("en") !== -1);
  // sku-b and sku-c lack fr translations; sku-a has one. But sku-a
  // would still appear as "missing" if we counted fallbacks — the
  // primitive treats `en` as a fallback too, so a row in the chain
  // covers the resource. Here `en` is in the chain, so all three are
  // "covered" by en. To force a gap, we ask for a locale whose only
  // fallback is `en` and look at resources lacking any non-en row.
  // Re-run with explicit chain reasoning:
  var report2 = await ctx.t.missingTranslations({
    resource_kind: "product",
    locale:        "de",          // chain: ["de", "en"]
  });
  // sku-a, sku-b, sku-c all have en rows, so chain coverage means
  // missingTranslations should report ZERO missing — `en` is in the
  // chain. That's the documented semantics: "missing" means "no row
  // in the chain", not "no row in the leaf locale".
  check("missingTranslations: chain coverage hides en-baseline resources",
    report2.missing.length === 0);

  // Drop the en row for sku-c — now it's genuinely uncovered for de.
  await ctx.t.removeTranslation({
    resource_kind: "product", resource_id: "sku-c", locale: "en",
  });
  // Add a non-chain locale for sku-c so it still appears in the
  // table (the primitive enumerates resource_ids that exist in some
  // locale of this kind).
  await ctx.t.setTranslation({
    resource_kind: "product", resource_id: "sku-c", locale: "ja", field: "title", value: "ガンマ",
  });
  var report3 = await ctx.t.missingTranslations({
    resource_kind: "product",
    locale:        "de",
  });
  check("missingTranslations: sku-c surfaces as missing for de",
    report3.missing.length === 1 && report3.missing[0] === "sku-c");

  // sample_size cap honoured
  var bulkSample = [];
  for (var i = 0; i < 20; i += 1) {
    bulkSample.push({
      resource_kind: "page",
      resource_id:   "page-" + i,
      locale:        "ja",
      field:         "title",
      value:         "ページ " + i,
    });
  }
  await ctx.t.bulkSet(bulkSample);
  var capped = await ctx.t.missingTranslations({
    resource_kind: "page",
    locale:        "de",
    sample_size:   5,
  });
  check("missingTranslations: sample_size caps the list", capped.missing.length === 5);
  check("missingTranslations: truncated flag set on cap",  capped.truncated === true);

  // Bad sample_size refused
  await assert.rejects(
    ctx.t.missingTranslations({ resource_kind: "product", locale: "de", sample_size: 0 }),
    /sample_size/
  );
  await assert.rejects(
    ctx.t.missingTranslations({ resource_kind: "product", locale: "de", sample_size: 9999 }),
    /sample_size/
  );
}

async function _bulkSetAtomicity() {
  var ctx = _setup();

  // Three good rows + one bad row — the whole batch must fail.
  var rows = [
    { resource_kind: "product", resource_id: "sku-1", locale: "fr", field: "title", value: "Un" },
    { resource_kind: "product", resource_id: "sku-2", locale: "fr", field: "title", value: "Deux" },
    { resource_kind: "product", resource_id: "sku-3", locale: "fr", field: "title", value: "Trois" },
    { resource_kind: "product", resource_id: "sku-4", locale: "BAD LOCALE", field: "title", value: "Quatre" },
  ];

  await assert.rejects(ctx.t.bulkSet(rows), /row\[3\]/);

  // Verify zero rows landed — pre-flight validation is the atomicity story
  var n = (await ctx.query(
    "SELECT COUNT(*) AS n FROM translations WHERE resource_kind = ?1",
    ["product"]
  )).rows[0].n;
  check("bulkSet: atomicity — zero rows written when any row fails",
    Number(n) === 0);

  // Happy bulkSet writes every row
  var ok = await ctx.t.bulkSet([
    { resource_kind: "product", resource_id: "sku-1", locale: "fr", field: "title", value: "Un" },
    { resource_kind: "product", resource_id: "sku-2", locale: "fr", field: "title", value: "Deux" },
  ]);
  check("bulkSet: returns written count",                ok.written === 2);
  var n2 = (await ctx.query(
    "SELECT COUNT(*) AS n FROM translations WHERE resource_kind = ?1",
    ["product"]
  )).rows[0].n;
  check("bulkSet: all rows persisted on happy path",     Number(n2) === 2);

  // Empty array — no-op, returns written=0
  var empty = await ctx.t.bulkSet([]);
  check("bulkSet: empty array returns written=0",        empty.written === 0);

  // Non-array refused
  await assert.rejects(ctx.t.bulkSet("not an array"),    /rows must be an array/);

  // Oversize batch refused
  var huge = [];
  for (var i = 0; i < 1001; i += 1) {
    huge.push({ resource_kind: "p", resource_id: "x", locale: "en", field: "t", value: "v" });
  }
  await assert.rejects(ctx.t.bulkSet(huge), /<= 1000/);
}

async function _inputRefusals() {
  var ctx = _setup();

  // Bad resource_kind shape
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "BadKind", resource_id: "x", locale: "en", field: "title", value: "v" }),
    /resource_kind must match/
  );
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "", resource_id: "x", locale: "en", field: "title", value: "v" }),
    /resource_kind must be a non-empty string/
  );

  // Bad resource_id
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "has whitespace", locale: "en", field: "title", value: "v" }),
    /resource_id must match/
  );

  // Bad locale
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "x", locale: "ENGLISH", field: "title", value: "v" }),
    /locale/
  );
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "x", locale: "e", field: "title", value: "v" }),
    /locale language subtag/
  );

  // Bad field
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "x", locale: "en", field: "9field", value: "v" }),
    /field must match/
  );

  // Empty value refused
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "x", locale: "en", field: "title", value: "" }),
    /value must be non-empty/
  );

  // Oversize value refused (16 KiB cap + 1)
  var huge = new Array(16386).join("x");
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "x", locale: "en", field: "title", value: huge }),
    /value must be/
  );

  // Control bytes in value refused (NUL)
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "x", locale: "en", field: "title", value: "hello\x00world" }),
    /control bytes/
  );

  // Zero-width / direction-override in value refused
  var ZWSP = String.fromCharCode(0x200B);
  await assert.rejects(
    ctx.t.setTranslation({ resource_kind: "product", resource_id: "x", locale: "en", field: "title", value: "ab" + ZWSP + "cd" }),
    /zero-width/
  );

  // Missing input object
  await assert.rejects(ctx.t.setTranslation(),          /input object required/);
  await assert.rejects(ctx.t.getTranslation(),          /input object required/);
  await assert.rejects(ctx.t.getForResource(),          /input object required/);
  await assert.rejects(ctx.t.removeTranslation(),       /input object required/);
  await assert.rejects(ctx.t.localesForResource(),      /input object required/);
  await assert.rejects(ctx.t.missingTranslations(),     /input object required/);
}

async function run() {
  await _setTranslationHappyPath();
  await _setTranslationUpsertAndEscape();
  await _localeFallbackChain();
  await _getForResourceMultipleFields();
  await _removeAndLocalesForResource();
  await _missingTranslationsIdentifiesGaps();
  await _bulkSetAtomicity();
  await _inputRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — " + helpers.getChecks() + " check(s) passed");
  }, function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
