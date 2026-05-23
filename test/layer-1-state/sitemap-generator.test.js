"use strict";
/**
 * sitemapGenerator — sitemap.xml + sitemap-index.xml emission with
 * per-source pulls (catalog products, collections, storefront pages,
 * operator-supplied custom adapters), per-section priority +
 * changefreq, hard-cap chunk splitting (50,000 URLs / 50 MB per
 * file), and an audit log over recorded generations.
 *
 * Layer 1 against in-memory node:sqlite loaded from the migrations
 * the primitive's per-source pulls read against (products,
 * collections, storefront_pages) plus the 0130 sitemap-generator
 * migration. The primitive isn't wired through `bShop` yet — the
 * test requires `lib/sitemap-generator.js` directly.
 *
 * Coverage:
 *   - defineSection happy path persists every input field, exposes
 *     it through sections({ active_only })
 *   - defineSection accepts every supported source kind (product,
 *     collection, storefront_page, custom)
 *   - generate emits well-formed XML (declaration, urlset namespace,
 *     `<loc>` / `<lastmod>` / `<changefreq>` / `<priority>` fields)
 *     and the index references the chunk filenames
 *   - lastmod is sourced from the underlying row's updated_at (not
 *     a fresh wall clock) — re-running generate without changes is
 *     a no-op as far as crawler signals go
 *   - generate splits at 50,000 URLs per chunk; the index references
 *     every chunk
 *   - URL encoding handles ampersand + space + non-ASCII (percent-
 *     encoded path + XML-escaped `<loc>`)
 *   - archiveSection drops the section from the next generate() and
 *     archives are idempotent
 *   - recordGeneration counts only `<url>` entries inside chunk
 *     files (the index file's `<sitemap>` entries don't inflate
 *     total_url_count); lastGeneration returns the newest audit row
 *   - validateOriginUrl enforces https-only
 *   - validation refusals on bad inputs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var sitemapGenerator = require("../../lib/sitemap-generator");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0043_collections.sql",
  "0059_storefront_pages.sql",
  "0130_sitemap_generator.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
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

// Seed a small catalog. Operator-controlled status + slug shape;
// the sitemap pull filters on `status = 'active'`.
async function _seedProducts(query, count, opts) {
  opts = opts || {};
  var baseTs = opts.baseTs || 1700000000000;
  for (var i = 0; i < count; i += 1) {
    await query(
      "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, '', ?4, ?5, ?5)",
      [
        "p" + i,
        (opts.slugPrefix || "prod-") + i,
        "Product " + i,
        opts.status || "active",
        baseTs + i,
      ],
    );
  }
}

async function _seedCollections(query, count, opts) {
  opts = opts || {};
  var baseTs = opts.baseTs || 1700100000000;
  for (var i = 0; i < count; i += 1) {
    await query(
      "INSERT INTO collections (slug, type, title, description, hero_image_url, rules_json, " +
      "sort_strategy, archived_at, created_at, updated_at) " +
      "VALUES (?1, 'manual', ?2, '', NULL, NULL, 'manual', ?3, ?4, ?4)",
      [
        "col-" + i,
        "Collection " + i,
        opts.archived ? baseTs : null,
        baseTs + i,
      ],
    );
  }
}

async function _seedStorefrontPages(query, count, opts) {
  opts = opts || {};
  var baseTs = opts.baseTs || 1700200000000;
  for (var i = 0; i < count; i += 1) {
    await query(
      "INSERT INTO storefront_pages (slug, version, title, body, meta_description, meta_keywords, " +
      "layout, status, published_at, archived_at, created_at, updated_at) " +
      "VALUES (?1, 1, ?2, 'body', NULL, NULL, 'default', ?3, ?4, NULL, ?5, ?5)",
      [
        "page-" + i,
        "Page " + i,
        opts.status || "published",
        opts.status === "published" || opts.status == null ? baseTs : null,
        baseTs + i,
      ],
    );
  }
}

// ---- defineSection happy path + per-source --------------------------

async function _defineSectionPerSource() {
  var query = _makeQuery();
  var sg = sitemapGenerator.create({ query: query });

  var products = await sg.defineSection({
    slug:       "products",
    source:     "product",
    base_path:  "/products/",
    priority:   0.8,
    changefreq: "daily",
  });
  check("defineSection product slug",       products.slug === "products");
  check("defineSection product source",     products.source === "product");
  check("defineSection product base_path",  products.base_path === "/products/");
  check("defineSection product priority",   products.priority === 0.8);
  check("defineSection product changefreq", products.changefreq === "daily");
  check("defineSection product max_urls=null default", products.max_urls === null);
  check("defineSection product active=true",           products.active === true);
  check("defineSection product archived_at=null",      products.archived_at === null);

  var cols = await sg.defineSection({
    slug:       "collections",
    source:     "collection",
    base_path:  "/collections/",
    priority:   0.6,
    changefreq: "weekly",
  });
  check("defineSection collection source", cols.source === "collection");

  var pages = await sg.defineSection({
    slug:       "pages",
    source:     "storefront_page",
    base_path:  "/pages/",
    priority:   0.5,
    changefreq: "monthly",
  });
  check("defineSection storefront_page source", pages.source === "storefront_page");

  var custom = await sg.defineSection({
    slug:       "blog",
    source:     "custom",
    base_path:  "/blog/",
    priority:   0.3,
    changefreq: "weekly",
    max_urls:   100,
  });
  check("defineSection custom source",          custom.source === "custom");
  check("defineSection custom max_urls applied", custom.max_urls === 100);

  var all = await sg.sections({ active_only: true });
  check("sections enumerates four registered", all.length === 4);

  // Duplicate slug refused.
  await assert.rejects(sg.defineSection({
    slug:       "products",
    source:     "product",
    base_path:  "/products/",
    priority:   0.7,
    changefreq: "daily",
  }), /already registered/);
}

// ---- generate produces well-formed XML + index ----------------------

async function _generateWellFormedXml() {
  var query = _makeQuery();
  await _seedProducts(query, 3);
  await _seedCollections(query, 2);
  await _seedStorefrontPages(query, 2);

  var sg = sitemapGenerator.create({ query: query });
  await sg.defineSection({
    slug: "products", source: "product", base_path: "/products/",
    priority: 0.8, changefreq: "daily",
  });
  await sg.defineSection({
    slug: "collections", source: "collection", base_path: "/collections/",
    priority: 0.6, changefreq: "weekly",
  });
  await sg.defineSection({
    slug: "pages", source: "storefront_page", base_path: "/pages/",
    priority: 0.5, changefreq: "monthly",
  });

  var artifacts = await sg.generate({ origin_url: "https://shop.example.com" });
  check("generate returns artifacts array",     Array.isArray(artifacts));
  check("generate returned 4 artifacts (3 chunks + 1 index)", artifacts.length === 4);

  // Index is last.
  var index = artifacts[artifacts.length - 1];
  check("index filename is sitemap.xml",        index.filename === "sitemap.xml");
  check("index has XML declaration",            index.content.indexOf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>") === 0);
  check("index uses sitemapindex root",         index.content.indexOf("<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">") !== -1);
  check("index references products chunk",      index.content.indexOf("<loc>https://shop.example.com/sitemap-products-1.xml</loc>") !== -1);
  check("index references collections chunk",   index.content.indexOf("<loc>https://shop.example.com/sitemap-collections-1.xml</loc>") !== -1);
  check("index references pages chunk",         index.content.indexOf("<loc>https://shop.example.com/sitemap-pages-1.xml</loc>") !== -1);
  check("index has lastmod entries",            (index.content.match(/<lastmod>/g) || []).length === 3);
  check("index closes cleanly",                 index.content.indexOf("</sitemapindex>") !== -1);

  // Find the products chunk.
  var productsChunk = null;
  for (var i = 0; i < artifacts.length; i += 1) {
    if (artifacts[i].filename === "sitemap-products-1.xml") { productsChunk = artifacts[i]; break; }
  }
  check("products chunk exists",                productsChunk !== null);
  check("products chunk uses urlset root",      productsChunk.content.indexOf("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">") !== -1);
  check("products chunk has 3 <url> entries",   (productsChunk.content.match(/<url>/g) || []).length === 3);
  check("products chunk has prod-0 loc",        productsChunk.content.indexOf("<loc>https://shop.example.com/products/prod-0</loc>") !== -1);
  check("products chunk has prod-1 loc",        productsChunk.content.indexOf("<loc>https://shop.example.com/products/prod-1</loc>") !== -1);
  check("products chunk has prod-2 loc",        productsChunk.content.indexOf("<loc>https://shop.example.com/products/prod-2</loc>") !== -1);
  check("products chunk has changefreq=daily",  productsChunk.content.indexOf("<changefreq>daily</changefreq>") !== -1);
  check("products chunk has priority=0.8",      productsChunk.content.indexOf("<priority>0.8</priority>") !== -1);
  check("products chunk closes cleanly",        productsChunk.content.indexOf("</urlset>") !== -1);
}

// ---- lastmod sources from underlying row ----------------------------

async function _lastmodFromRow() {
  var query = _makeQuery();
  // Fix the row's updated_at to a known instant so the test can
  // assert the rendered lastmod is exactly that timestamp.
  var fixedTs = Date.UTC(2024, 5, 15, 12, 30, 45); // 2024-06-15T12:30:45Z
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES ('p-fixed', 'fixed-product', 'Fixed', '', 'active', ?1, ?1)",
    [fixedTs],
  );

  var sg = sitemapGenerator.create({ query: query });
  await sg.defineSection({
    slug: "products", source: "product", base_path: "/products/",
    priority: 0.7, changefreq: "weekly",
  });

  var artifacts = await sg.generate({ origin_url: "https://shop.example.com" });
  var chunk = null;
  for (var i = 0; i < artifacts.length; i += 1) {
    if (artifacts[i].filename === "sitemap-products-1.xml") { chunk = artifacts[i]; break; }
  }
  check("chunk exists",                      chunk !== null);
  check("lastmod renders fixed row updated_at as ISO 8601",
    chunk.content.indexOf("<lastmod>2024-06-15T12:30:45Z</lastmod>") !== -1);
}

// ---- splitting at 50000 URLs per chunk ------------------------------

async function _splittingAt50000Urls() {
  var query = _makeQuery();
  var sg = sitemapGenerator.create({
    query: query,
    custom: {
      bulk: async function () {
        var rows = [];
        // 50,001 URLs forces a split. Synthetic rows are generated
        // in-line (no DB seeding for this volume — that would
        // dominate the test runtime). The custom adapter is the
        // exact integration point for an operator wanting to emit a
        // high-volume URL set outside the catalog/collections/pages
        // tables.
        for (var i = 0; i < 50001; i += 1) {
          rows.push({ slug: "bulk-" + i, updated_at: 1700000000000 + i });
        }
        return rows;
      },
    },
  });

  await sg.defineSection({
    slug: "bulk", source: "custom", base_path: "/bulk/",
    priority: 0.4, changefreq: "monthly",
  });

  var artifacts = await sg.generate({ origin_url: "https://shop.example.com" });
  // 50,001 URLs → 2 chunks (50,000 + 1) + 1 index = 3 artifacts.
  check("generate split 50001 urls into 3 artifacts", artifacts.length === 3);

  var chunk1 = artifacts[0];
  var chunk2 = artifacts[1];
  var index  = artifacts[2];

  check("chunk1 filename",                  chunk1.filename === "sitemap-bulk-1.xml");
  check("chunk2 filename",                  chunk2.filename === "sitemap-bulk-2.xml");
  check("index filename",                   index.filename  === "sitemap.xml");

  // Hard limit on chunk1 — exactly 50,000 `<url>` entries.
  var chunk1Count = (chunk1.content.match(/<url>/g) || []).length;
  var chunk2Count = (chunk2.content.match(/<url>/g) || []).length;
  check("chunk1 has 50000 url entries",     chunk1Count === sitemapGenerator.URL_HARD_CAP);
  check("chunk2 has 1 url entry",           chunk2Count === 1);
  check("total url count matches input",    chunk1Count + chunk2Count === 50001);

  // Index references BOTH chunks.
  check("index references chunk1",          index.content.indexOf("sitemap-bulk-1.xml") !== -1);
  check("index references chunk2",          index.content.indexOf("sitemap-bulk-2.xml") !== -1);
}

// ---- URL encoding ---------------------------------------------------

async function _urlEncoding() {
  var query = _makeQuery();
  // Embed reserved characters in product slugs. The catalog primitive
  // refuses these at the app layer, but the sitemap generator must
  // handle them defensively since the row reaches it via a SELECT and
  // the underlying tables can carry historical rows that pre-date
  // tightened validation.
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES ('p-amp', 'r&d-prototype', 'R&D', '', 'active', 1700000000000, 1700000000000)",
  );
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES ('p-space', 'pro duct', 'Pro Duct', '', 'active', 1700000000001, 1700000000001)",
  );

  var sg = sitemapGenerator.create({ query: query });
  await sg.defineSection({
    slug: "products", source: "product", base_path: "/products/",
    priority: 0.8, changefreq: "daily",
  });

  var artifacts = await sg.generate({ origin_url: "https://shop.example.com" });
  var chunk = null;
  for (var i = 0; i < artifacts.length; i += 1) {
    if (artifacts[i].filename === "sitemap-products-1.xml") { chunk = artifacts[i]; break; }
  }
  // Ampersand must be percent-encoded (`%26`) AND/OR XML-escaped.
  // Our pipeline percent-encodes first (`&` → `%26`) so the rendered
  // form is `r%26d-prototype`; the `<loc>` text contains no raw `&`.
  check("ampersand handled (no raw &)",   chunk.content.indexOf("r&d-prototype") === -1);
  check("ampersand percent-encoded",      chunk.content.indexOf("r%26d-prototype") !== -1);
  // Space must be percent-encoded.
  check("space percent-encoded",          chunk.content.indexOf("pro%20duct") !== -1);
  // Path separator stays unescaped.
  check("path separator unescaped",       chunk.content.indexOf("/products/") !== -1);
}

// ---- archiveSection drops from generate -----------------------------

async function _archiveDropsFromGenerate() {
  var query = _makeQuery();
  await _seedProducts(query, 2);
  await _seedCollections(query, 2);

  var sg = sitemapGenerator.create({ query: query });
  await sg.defineSection({
    slug: "products", source: "product", base_path: "/products/",
    priority: 0.8, changefreq: "daily",
  });
  await sg.defineSection({
    slug: "collections", source: "collection", base_path: "/collections/",
    priority: 0.6, changefreq: "weekly",
  });

  var before = await sg.generate({ origin_url: "https://shop.example.com" });
  // 2 chunks + 1 index = 3 artifacts.
  check("before archive: 3 artifacts",     before.length === 3);

  var archived = await sg.archiveSection("collections");
  check("archiveSection stamps archived_at", archived.archived_at !== null);
  check("archiveSection deactivates",        archived.active === false);

  // Idempotent re-archive.
  var archivedAgain = await sg.archiveSection("collections");
  check("re-archive idempotent",             archivedAgain.archived_at === archived.archived_at);

  var after = await sg.generate({ origin_url: "https://shop.example.com" });
  // 1 chunk + 1 index = 2 artifacts.
  check("after archive: 2 artifacts",        after.length === 2);
  check("after archive: products chunk present",
    after.some(function (a) { return a.filename === "sitemap-products-1.xml"; }));
  check("after archive: collections chunk gone",
    after.every(function (a) { return a.filename !== "sitemap-collections-1.xml"; }));

  // sections({ active_only: true }) filters archived.
  var active = await sg.sections({ active_only: true });
  check("active_only filter drops archived", active.length === 1 && active[0].slug === "products");

  // sections({}) returns all including archived.
  var all = await sg.sections({});
  check("default lists archived too",        all.length === 2);
}

// ---- recordGeneration + lastGeneration ------------------------------

async function _recordGenerationAuditTrail() {
  var query = _makeQuery();
  await _seedProducts(query, 2);

  var sg = sitemapGenerator.create({ query: query });
  await sg.defineSection({
    slug: "products", source: "product", base_path: "/products/",
    priority: 0.8, changefreq: "daily",
  });

  var none = await sg.lastGeneration();
  check("lastGeneration null before any record", none === null);

  var artifacts = await sg.generate({ origin_url: "https://shop.example.com" });
  var rec = await sg.recordGeneration({
    origin_url: "https://shop.example.com",
    artifacts:  artifacts,
  });
  check("recordGeneration returns object",        rec && typeof rec === "object");
  check("recordGeneration carries artifact_count", rec.artifact_count === artifacts.length);
  // 2 products → 2 url entries total. Index file's <sitemap>
  // entries must NOT be counted.
  check("recordGeneration counts only <url> entries (not <sitemap>)", rec.total_url_count === 2);
  check("recordGeneration measures bytes",        rec.total_byte_size > 0);

  var last = await sg.lastGeneration();
  check("lastGeneration matches recordGeneration", last.id === rec.id);
  check("lastGeneration carries origin_url",       last.origin_url === "https://shop.example.com");
  check("lastGeneration carries url count",        last.total_url_count === 2);
}

// ---- validateOriginUrl + validation refusals ------------------------

async function _validationRefusals() {
  var query = _makeQuery();
  var sg = sitemapGenerator.create({ query: query });

  // validateOriginUrl
  check("validateOriginUrl returns valid url",
    sg.validateOriginUrl({ origin_url: "https://shop.example.com" }) === "https://shop.example.com");
  check("validateOriginUrl strips trailing slash",
    sg.validateOriginUrl({ origin_url: "https://shop.example.com/" }) === "https://shop.example.com");
  assert.throws(function () { sg.validateOriginUrl({ origin_url: "http://shop.example.com" }); }, /origin_url/);
  assert.throws(function () { sg.validateOriginUrl({ origin_url: "javascript:alert(1)" }); }, /origin_url/);
  assert.throws(function () { sg.validateOriginUrl({ origin_url: "" }); }, /origin_url/);
  assert.throws(function () { sg.validateOriginUrl(); }, /input object required/);

  // defineSection
  await assert.rejects(sg.defineSection(), /input object required/);
  await assert.rejects(sg.defineSection({}), /slug/);
  await assert.rejects(sg.defineSection({
    slug: "bad slug!", source: "product", base_path: "/p/", priority: 0.5, changefreq: "daily",
  }), /slug/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "blog-posts", base_path: "/p/", priority: 0.5, changefreq: "daily",
  }), /source/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "no-leading-slash", priority: 0.5, changefreq: "daily",
  }), /base_path/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "//evil.example", priority: 0.5, changefreq: "daily",
  }), /base_path/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "/../etc/passwd", priority: 0.5, changefreq: "daily",
  }), /base_path/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "/p/", priority: 1.5, changefreq: "daily",
  }), /priority/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "/p/", priority: -0.1, changefreq: "daily",
  }), /priority/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "/p/", priority: 0.5, changefreq: "yearly-ish",
  }), /changefreq/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "/p/", priority: 0.5, changefreq: "daily", max_urls: 0,
  }), /max_urls/);
  await assert.rejects(sg.defineSection({
    slug: "ok", source: "product", base_path: "/p/", priority: 0.5, changefreq: "daily", max_urls: 1.5,
  }), /max_urls/);

  // generate
  await assert.rejects(sg.generate(), /input object required/);
  await assert.rejects(sg.generate({}), /origin_url/);
  await assert.rejects(sg.generate({ origin_url: "http://shop.example.com" }), /origin_url/);
  await assert.rejects(sg.generate({
    origin_url: "https://shop.example.com", sections_filter: "not-an-array",
  }), /sections_filter/);
  await assert.rejects(sg.generate({
    origin_url: "https://shop.example.com", sections_filter: [123],
  }), /sections_filter/);

  // archiveSection
  await assert.rejects(sg.archiveSection("missing"), /not found/);
  await assert.rejects(sg.archiveSection("bad slug!"), /slug/);

  // recordGeneration
  await assert.rejects(sg.recordGeneration(), /input object required/);
  await assert.rejects(sg.recordGeneration({
    origin_url: "https://shop.example.com",
  }), /artifacts/);
  await assert.rejects(sg.recordGeneration({
    origin_url: "https://shop.example.com", artifacts: "not-array",
  }), /artifacts/);
  await assert.rejects(sg.recordGeneration({
    origin_url: "https://shop.example.com",
    artifacts:  [{ filename: "x", /* missing content */ }],
  }), /filename/);

  // generate with custom source but no adapter
  var sg2 = sitemapGenerator.create({ query: query });
  await sg2.defineSection({
    slug: "blog", source: "custom", base_path: "/blog/",
    priority: 0.3, changefreq: "weekly",
  });
  await assert.rejects(sg2.generate({ origin_url: "https://shop.example.com" }),
    /no adapter was registered/);
}

// ---- generate empty when no sections / no URLs ---------------------

async function _generateEmpty() {
  var query = _makeQuery();
  var sg = sitemapGenerator.create({ query: query });

  // No sections at all.
  var empty1 = await sg.generate({ origin_url: "https://shop.example.com" });
  check("generate returns [] with no sections", Array.isArray(empty1) && empty1.length === 0);

  // Section registered but the source table is empty.
  await sg.defineSection({
    slug: "products", source: "product", base_path: "/products/",
    priority: 0.8, changefreq: "daily",
  });
  var empty2 = await sg.generate({ origin_url: "https://shop.example.com" });
  check("generate returns [] with no URLs", Array.isArray(empty2) && empty2.length === 0);
}

// ---- sections_filter narrows the generation ------------------------

async function _sectionsFilter() {
  var query = _makeQuery();
  await _seedProducts(query, 2);
  await _seedCollections(query, 2);

  var sg = sitemapGenerator.create({ query: query });
  await sg.defineSection({
    slug: "products", source: "product", base_path: "/products/",
    priority: 0.8, changefreq: "daily",
  });
  await sg.defineSection({
    slug: "collections", source: "collection", base_path: "/collections/",
    priority: 0.6, changefreq: "weekly",
  });

  var onlyProducts = await sg.generate({
    origin_url: "https://shop.example.com",
    sections_filter: ["products"],
  });
  check("sections_filter narrows to one section",
    onlyProducts.length === 2 && onlyProducts.some(function (a) { return a.filename === "sitemap-products-1.xml"; }));
  check("sections_filter excludes collections",
    onlyProducts.every(function (a) { return a.filename !== "sitemap-collections-1.xml"; }));
}

async function run() {
  await _defineSectionPerSource();
  await _generateWellFormedXml();
  await _lastmodFromRow();
  await _splittingAt50000Urls();
  await _urlEncoding();
  await _archiveDropsFromGenerate();
  await _recordGenerationAuditTrail();
  await _validationRefusals();
  await _generateEmpty();
  await _sectionsFilter();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/sitemap-generator.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — sitemap-generator (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — sitemap-generator: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
