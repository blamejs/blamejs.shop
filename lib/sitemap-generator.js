"use strict";
/**
 * @module shop.sitemapGenerator
 * @title  Sitemap generator — sitemap.xml + sitemap-index.xml emission
 *
 * @intro
 *   Crawler-facing sitemap surface. Generates the bytes a search-
 *   engine fetches at `/sitemap.xml` (the index) and at each chunk
 *   filename listed inside the index. The primitive does NOT persist
 *   the bytes — the operator's worker writes the returned artifact
 *   list to the storefront's static-asset surface (R2 / CDN / disk)
 *   and calls `recordGeneration({ artifacts })` to log what shipped.
 *
 *   Sections:
 *     - `defineSection({ slug, source, base_path, priority, changefreq, max_urls? })`
 *       — register an emitting section. `source` picks the URL stream
 *       the section reads from:
 *         'product'         — every active catalog product, slug-rooted
 *         'collection'      — every non-archived collection
 *         'storefront_page' — every published storefront page
 *         'custom'          — operator supplies the URLs at generate
 *                             time via `create({ custom: { <slug>: fn }})`
 *
 *   Generation:
 *     - `generate({ origin_url, sections_filter? })` — walks every
 *       active, non-archived section (or only those whose slug is in
 *       `sections_filter`), pulls the URL stream, applies the
 *       per-section `max_urls` cap, splits the result at the sitemap
 *       spec's hard limits (50,000 URLs per file, ~50 MB serialized
 *       per file), and returns an array of `{ filename, content }`
 *       artifacts — the chunk files first, the index file last. The
 *       index file lists every chunk's loc relative to `origin_url`.
 *       Returns an empty array (no index, no chunks) when no section
 *       produced any URLs.
 *
 *   Audit:
 *     - `recordGeneration({ artifacts })` — appends the audit row
 *       (artifact_count + total_url_count + total_byte_size +
 *       generated_at). The operator's worker calls this after the
 *       bytes ship so `lastGeneration()` can answer the dashboard's
 *       "when did the sitemap last update" question.
 *     - `lastGeneration()` — the newest audit row, or null when
 *       nothing has shipped yet.
 *
 *   Read helpers:
 *     - `sections({ active_only? })` — enumerate the registered
 *       sections.
 *     - `archiveSection(slug)` — soft-delete the section. The bytes
 *       drop out of the next `generate()`; the config row stays so
 *       an operator can audit "what we used to emit".
 *
 *   URL validation:
 *     - `validateOriginUrl({ origin_url })` — through `b.safeUrl`
 *       with `{ allowedProtocols: ["https:"] }`. The origin URL is
 *       what every `<loc>` in the index resolves against; cleartext
 *       would let an MITM swap the canonical host.
 *
 *   URL encoding (sitemap spec compliance):
 *     - Every emitted URL is percent-encoded for path-segment
 *       reserved characters (`%`, `?`, `#`, ` `, etc.) AND then
 *       XML-escaped (`&` → `&amp;`, `'` → `&apos;`, `"` → `&quot;`,
 *       `<` → `&lt;`, `>` → `&gt;`). Both passes are required by
 *       the spec; a slug containing an ampersand reaches the crawler
 *       as `&amp;` inside a `<loc>` element.
 *
 *   Composes ONLY blamejs:
 *     - `b.framework.safeUrl.parse` — origin URL validation (https-only).
 *     - `b.framework.template.escapeHtml` — XML-escape of operator-
 *       sourced URL fragments (the escape catalog covers the five
 *       XML special characters).
 *     - `b.framework.uuid.v7` — audit-row id.
 *
 * @primitive sitemapGenerator
 * @related   b.safeUrl.parse, b.template.escapeHtml, b.uuid.v7
 */

// Sitemap protocol hard limits (https://www.sitemaps.org/protocol.html).
// A single sitemap file may contain at most 50,000 URLs AND must not
// exceed 50 MB uncompressed; either limit triggers a chunk split.
var URL_HARD_CAP   = 50000;
var BYTE_HARD_CAP  = 50 * 1024 * 1024;

// Per-section slug shape. Reaches the chunk filename
// (`sitemap-<slug>-N.xml`) so a hostile slug would smuggle a path
// traversal — refuse everything outside the narrow alnum + dot +
// hyphen + underscore set.
var MAX_SECTION_SLUG_LEN = 80;
var SECTION_SLUG_RE      = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

var MAX_BASE_PATH_LEN = 256;
var MAX_ORIGIN_URL_LEN = 2048;

var ALLOWED_SOURCES = Object.freeze([
  "product",
  "collection",
  "storefront_page",
  "custom",
]);

var ALLOWED_CHANGEFREQS = Object.freeze([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SECTION_SLUG_RE.test(s)) {
    throw new TypeError(
      "sitemapGenerator: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ " +
      "(<= " + MAX_SECTION_SLUG_LEN + " chars)"
    );
  }
  return s;
}

function _source(s) {
  if (typeof s !== "string" || ALLOWED_SOURCES.indexOf(s) === -1) {
    throw new TypeError("sitemapGenerator: source must be one of " + JSON.stringify(ALLOWED_SOURCES));
  }
  return s;
}

function _basePath(s) {
  if (typeof s !== "string" || s.length < 1 || s.length > MAX_BASE_PATH_LEN) {
    throw new TypeError("sitemapGenerator: base_path must be a string 1.." + MAX_BASE_PATH_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("sitemapGenerator: base_path contains control bytes");
  }
  if (s.charCodeAt(0) !== 47 /* "/" */) {
    throw new TypeError("sitemapGenerator: base_path must start with '/'");
  }
  // Refuse protocol-relative `//host` — that would let a section
  // emit URLs pointing at an arbitrary domain.
  if (s.length > 1 && s.charCodeAt(1) === 47) {
    throw new TypeError("sitemapGenerator: base_path must not start with '//'");
  }
  if (s.indexOf("..") !== -1) {
    throw new TypeError("sitemapGenerator: base_path must not contain '..'");
  }
  return s;
}

function _priority(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0 || n > 1) {
    throw new TypeError("sitemapGenerator: priority must be a number 0.0..1.0");
  }
  return n;
}

function _changefreq(s) {
  if (typeof s !== "string" || ALLOWED_CHANGEFREQS.indexOf(s) === -1) {
    throw new TypeError("sitemapGenerator: changefreq must be one of " + JSON.stringify(ALLOWED_CHANGEFREQS));
  }
  return s;
}

function _maxUrls(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError("sitemapGenerator: max_urls must be a positive integer or null");
  }
  return n;
}

function _originUrl(u) {
  if (typeof u !== "string" || u.length < 1 || u.length > MAX_ORIGIN_URL_LEN) {
    throw new TypeError("sitemapGenerator: origin_url must be a string 1.." + MAX_ORIGIN_URL_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(u)) {
    throw new TypeError("sitemapGenerator: origin_url contains control bytes");
  }
  try {
    _b().safeUrl.parse(u, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("sitemapGenerator: origin_url — " + (e && e.message || "must be a valid https:// URL"));
  }
  // Refuse a trailing slash — the join logic prepends `/` so a
  // trailing slash would emit `https://shop.example.com//products/...`.
  if (u.charCodeAt(u.length - 1) === 47) {
    return u.slice(0, -1);
  }
  return u;
}

// XML-escape the five special characters per the sitemap spec.
// Reuses `b.template.escapeHtml` — the framework's escape catalog
// already covers `&`, `<`, `>`, `"`, `'` which is exactly the XML
// set the sitemap spec calls out.
function _xmlEscape(s) {
  return _b().template.escapeHtml(String(s));
}

// Percent-encode a path segment per the sitemap spec. We escape
// everything except the URL-safe set `A-Z a-z 0-9 - _ . ~ /` — the
// forward slash stays unescaped because base_path + slug joins are
// path-shaped (one or more segments). Operators emitting URLs with
// embedded query strings should encode those upstream before they
// reach the `loc` field.
function _percentEncode(s) {
  return String(s).replace(/[^A-Za-z0-9\-_.~/]/g, function (ch) {
    return encodeURIComponent(ch);
  });
}

// Compose a sitemap-spec `<loc>` value: the origin URL passes
// through unmodified (it was validated through b.safeUrl and is
// already a well-formed https:// URL), the path is percent-encoded
// for path-segment reserved characters, and the joined result is
// XML-escaped. Percent-encoding before XML-escape is required by
// the spec — a slug containing `&` reaches the crawler as `%26`
// (percent-encoded form survives the XML round trip) rather than
// as `&amp;` of a raw ampersand.
function _encodeLoc(originUrl, path) {
  return _xmlEscape(originUrl + _percentEncode(path));
}

// W3C ISO 8601 (UTC, second precision). The sitemap spec accepts
// either date-only or full datetime; full datetime is the operator-
// friendlier shape because it lets the crawler diff a re-emission.
function _iso8601(epochMs) {
  var d = new Date(epochMs);
  function _pad(n) { return n < 10 ? "0" + n : String(n); }
  return d.getUTCFullYear() + "-" + _pad(d.getUTCMonth() + 1) + "-" + _pad(d.getUTCDate()) +
         "T" + _pad(d.getUTCHours()) + ":" + _pad(d.getUTCMinutes()) + ":" + _pad(d.getUTCSeconds()) + "Z";
}

// ---- row hydration ------------------------------------------------------

function _hydrateSection(r) {
  if (!r) return null;
  return {
    slug:         r.slug,
    source:       r.source,
    base_path:    r.base_path,
    priority:     Number(r.priority),
    changefreq:   r.changefreq,
    max_urls:     r.max_urls == null ? null : Number(r.max_urls),
    active:       Number(r.active) === 1,
    archived_at:  r.archived_at == null ? null : Number(r.archived_at),
    created_at:   Number(r.created_at),
    updated_at:   Number(r.updated_at),
  };
}

function _hydrateGeneration(r) {
  if (!r) return null;
  return {
    id:              r.id,
    origin_url:      r.origin_url,
    artifact_count:  Number(r.artifact_count),
    total_url_count: Number(r.total_url_count),
    total_byte_size: Number(r.total_byte_size),
    generated_at:    Number(r.generated_at),
  };
}

// ---- chunk serialization ------------------------------------------------
//
// Serialize an array of `{ loc, lastmod, priority, changefreq }`
// entries into a sitemap-spec XML document. The function returns
// chunks — when the URL count or the byte size crosses the hard
// caps, the entries are split into N strings.
//
// The hard caps:
//   - 50,000 URLs per file (URL_HARD_CAP)
//   - 50 MB serialized per file (BYTE_HARD_CAP)
//
// Both are required by the sitemap protocol. Crawlers refuse files
// exceeding either limit.

var URLSET_OPEN  = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
                   "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n";
var URLSET_CLOSE = "</urlset>\n";

function _renderUrlEntry(entry) {
  var out = "  <url>\n";
  out += "    <loc>" + entry.loc + "</loc>\n";
  if (entry.lastmod != null) {
    out += "    <lastmod>" + entry.lastmod + "</lastmod>\n";
  }
  out += "    <changefreq>" + entry.changefreq + "</changefreq>\n";
  // The priority is a float 0.0..1.0; render with one decimal place.
  // The sitemap spec accepts any decimal representation but a single
  // fractional digit is the convention.
  out += "    <priority>" + entry.priority.toFixed(1) + "</priority>\n";
  out += "  </url>\n";
  return out;
}

function _chunkEntries(entries) {
  var chunks = [];
  var current = [];
  var currentBytes = URLSET_OPEN.length + URLSET_CLOSE.length;
  for (var i = 0; i < entries.length; i += 1) {
    var rendered = _renderUrlEntry(entries[i]);
    var renderedBytes = Buffer.byteLength(rendered, "utf8");
    var wouldExceedUrls  = current.length + 1 > URL_HARD_CAP;
    var wouldExceedBytes = currentBytes + renderedBytes > BYTE_HARD_CAP;
    if ((wouldExceedUrls || wouldExceedBytes) && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = URLSET_OPEN.length + URLSET_CLOSE.length;
    }
    current.push(rendered);
    currentBytes += renderedBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function _renderChunk(renderedEntries) {
  return URLSET_OPEN + renderedEntries.join("") + URLSET_CLOSE;
}

var SITEMAPINDEX_OPEN  = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
                         "<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n";
var SITEMAPINDEX_CLOSE = "</sitemapindex>\n";

function _renderIndex(originUrl, chunkFilenames, lastmodMs) {
  var lastmod = _iso8601(lastmodMs);
  var body = "";
  for (var i = 0; i < chunkFilenames.length; i += 1) {
    var loc = _xmlEscape(originUrl + "/" + chunkFilenames[i]);
    body += "  <sitemap>\n";
    body += "    <loc>" + loc + "</loc>\n";
    body += "    <lastmod>" + lastmod + "</lastmod>\n";
    body += "  </sitemap>\n";
  }
  return SITEMAPINDEX_OPEN + body + SITEMAPINDEX_CLOSE;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // The catalog / collections / storefrontPages primitives aren't
  // required at construct time — the source SQL we run is direct
  // (sitemap generation reads the underlying tables, not the
  // primitive's hydrated rows). The optional opts.catalog etc.
  // entries are accepted for forward compatibility with callers
  // that wire the whole bShop bag in one shot.
  var customAdapters = opts.custom && typeof opts.custom === "object" ? opts.custom : {};

  // Per-factory monotonic clock — guarantees `updated_at` across
  // a single defineSection + archiveSection roundtrip is strictly
  // increasing even when the wall clock has 1ms resolution and
  // the caller chains the two inside one tick.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- defineSection ---------------------------------------------------

  async function defineSection(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("sitemapGenerator.defineSection: input object required");
    }
    var slug       = _slug(input.slug);
    var source     = _source(input.source);
    var basePath   = _basePath(input.base_path);
    var priority   = _priority(input.priority);
    var changefreq = _changefreq(input.changefreq);
    var maxUrls    = _maxUrls(input.max_urls);

    var ts = _monotonicTs();
    try {
      await query(
        "INSERT INTO sitemap_sections (slug, source, base_path, priority, changefreq, " +
        "max_urls, active, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL, ?7, ?7)",
        [slug, source, basePath, priority, changefreq, maxUrls, ts],
      );
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(e && e.message))) {
        throw new TypeError("sitemapGenerator.defineSection: slug " + JSON.stringify(slug) + " already registered");
      }
      throw e;
    }
    return await _getSection(slug);
  }

  async function _getSection(slug) {
    var r = (await query(
      "SELECT * FROM sitemap_sections WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateSection(r);
  }

  // ---- sections --------------------------------------------------------

  async function sections(input) {
    input = input || {};
    var activeOnly = input.active_only === true;
    var sql;
    if (activeOnly) {
      sql = "SELECT * FROM sitemap_sections WHERE active = 1 AND archived_at IS NULL " +
            "ORDER BY slug ASC";
    } else {
      sql = "SELECT * FROM sitemap_sections ORDER BY slug ASC";
    }
    var rows = (await query(sql, [])).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateSection(rows[i]));
    return out;
  }

  // ---- archiveSection --------------------------------------------------

  async function archiveSection(slug) {
    _slug(slug);
    var current = await _getSection(slug);
    if (!current) {
      throw new TypeError("sitemapGenerator.archiveSection: slug " + JSON.stringify(slug) + " not found");
    }
    if (current.archived_at != null) return current;
    var ts = _monotonicTs();
    await query(
      "UPDATE sitemap_sections SET archived_at = ?1, active = 0, updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return await _getSection(slug);
  }

  // ---- validateOriginUrl ----------------------------------------------

  function validateOriginUrl(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("sitemapGenerator.validateOriginUrl: input object required");
    }
    return _originUrl(input.origin_url);
  }

  // ---- per-source URL pullers ----------------------------------------
  //
  // Each puller returns an array of `{ slug, updated_at }` rows. The
  // generate() composer joins the section's `base_path` with each
  // row's slug, applies the section's priority + changefreq, and
  // tags the row's updated_at as the URL's lastmod.

  async function _pullProducts() {
    var rows = (await query(
      "SELECT slug, updated_at FROM products WHERE status = 'active' " +
      "ORDER BY updated_at DESC, slug ASC",
      [],
    )).rows;
    return rows.map(function (r) {
      return { slug: r.slug, updated_at: Number(r.updated_at) };
    });
  }

  async function _pullCollections() {
    var rows = (await query(
      "SELECT slug, updated_at FROM collections WHERE archived_at IS NULL " +
      "ORDER BY updated_at DESC, slug ASC",
      [],
    )).rows;
    return rows.map(function (r) {
      return { slug: r.slug, updated_at: Number(r.updated_at) };
    });
  }

  async function _pullStorefrontPages() {
    var rows = (await query(
      "SELECT slug, updated_at FROM storefront_pages WHERE status = 'published' " +
      "ORDER BY updated_at DESC, slug ASC",
      [],
    )).rows;
    return rows.map(function (r) {
      return { slug: r.slug, updated_at: Number(r.updated_at) };
    });
  }

  async function _pullCustom(sectionSlug) {
    var adapter = customAdapters[sectionSlug];
    if (!adapter) {
      throw new TypeError(
        "sitemapGenerator.generate: section " + JSON.stringify(sectionSlug) +
        " has source='custom' but no adapter was registered via create({ custom: { ... } })"
      );
    }
    if (typeof adapter !== "function") {
      throw new TypeError(
        "sitemapGenerator.generate: custom adapter for section " + JSON.stringify(sectionSlug) +
        " must be a function returning an array of { slug, updated_at }"
      );
    }
    var rows = await adapter();
    if (!Array.isArray(rows)) {
      throw new TypeError(
        "sitemapGenerator.generate: custom adapter for section " + JSON.stringify(sectionSlug) +
        " must return an array; got " + (rows === null ? "null" : typeof rows)
      );
    }
    return rows.map(function (r) {
      if (!r || typeof r !== "object" || typeof r.slug !== "string") {
        throw new TypeError(
          "sitemapGenerator.generate: custom adapter for section " + JSON.stringify(sectionSlug) +
          " must yield { slug: string, updated_at: number } rows"
        );
      }
      var u = Number(r.updated_at);
      if (!isFinite(u)) {
        throw new TypeError(
          "sitemapGenerator.generate: custom adapter for section " + JSON.stringify(sectionSlug) +
          " yielded a row with non-numeric updated_at"
        );
      }
      return { slug: r.slug, updated_at: u };
    });
  }

  async function _pullSection(section) {
    if (section.source === "product")         return await _pullProducts();
    if (section.source === "collection")      return await _pullCollections();
    if (section.source === "storefront_page") return await _pullStorefrontPages();
    /* custom */                               return await _pullCustom(section.slug);
  }

  // ---- generate --------------------------------------------------------

  async function generate(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("sitemapGenerator.generate: input object required");
    }
    var originUrl = _originUrl(input.origin_url);

    var filter = null;
    if (input.sections_filter != null) {
      if (!Array.isArray(input.sections_filter)) {
        throw new TypeError("sitemapGenerator.generate: sections_filter must be an array of slugs or null");
      }
      filter = {};
      for (var fi = 0; fi < input.sections_filter.length; fi += 1) {
        var f = input.sections_filter[fi];
        if (typeof f !== "string") {
          throw new TypeError("sitemapGenerator.generate: sections_filter entries must be strings");
        }
        filter[f] = true;
      }
    }

    var allSections = await sections({ active_only: true });

    var artifacts = [];
    var maxLastmod = 0;
    var anyUrls = false;

    for (var si = 0; si < allSections.length; si += 1) {
      var section = allSections[si];
      if (filter && !filter[section.slug]) continue;

      var rows = await _pullSection(section);
      if (section.max_urls != null && rows.length > section.max_urls) {
        rows = rows.slice(0, section.max_urls);
      }

      var entries = [];
      for (var ri = 0; ri < rows.length; ri += 1) {
        var row = rows[ri];
        var path = section.base_path;
        if (path.charCodeAt(path.length - 1) !== 47) path += "/";
        path += row.slug;
        var lastmod = isFinite(row.updated_at) && row.updated_at > 0
          ? _iso8601(row.updated_at)
          : null;
        if (row.updated_at > maxLastmod) maxLastmod = row.updated_at;
        entries.push({
          loc:        _encodeLoc(originUrl, path),
          lastmod:    lastmod,
          priority:   section.priority,
          changefreq: section.changefreq,
        });
      }

      if (entries.length === 0) continue;
      anyUrls = true;

      var chunks = _chunkEntries(entries);
      for (var ci = 0; ci < chunks.length; ci += 1) {
        var filename = "sitemap-" + section.slug + "-" + (ci + 1) + ".xml";
        artifacts.push({
          filename: filename,
          content:  _renderChunk(chunks[ci]),
        });
      }
    }

    if (!anyUrls) return [];

    var chunkFilenames = artifacts.map(function (a) { return a.filename; });
    var indexContent = _renderIndex(
      originUrl,
      chunkFilenames,
      maxLastmod > 0 ? maxLastmod : Date.now(),
    );
    artifacts.push({ filename: "sitemap.xml", content: indexContent });

    return artifacts;
  }

  // ---- recordGeneration -----------------------------------------------

  async function recordGeneration(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("sitemapGenerator.recordGeneration: input object required");
    }
    if (!Array.isArray(input.artifacts)) {
      throw new TypeError("sitemapGenerator.recordGeneration: artifacts must be an array");
    }
    // Origin URL is required so the audit row can name the canonical
    // host the bytes were generated against — operators running
    // multi-tenant shops may rotate origins and the audit trail wants
    // to distinguish a regeneration against shop-A from a regeneration
    // against shop-B.
    var originUrl = _originUrl(input.origin_url);

    var artifactCount = input.artifacts.length;
    var totalUrlCount = 0;
    var totalByteSize = 0;
    var urlsetOpenTag = "<urlset";
    for (var i = 0; i < input.artifacts.length; i += 1) {
      var a = input.artifacts[i];
      if (!a || typeof a !== "object" ||
          typeof a.filename !== "string" || typeof a.content !== "string") {
        throw new TypeError(
          "sitemapGenerator.recordGeneration: artifacts[" + i + "] must be " +
          "{ filename: string, content: string }"
        );
      }
      totalByteSize += Buffer.byteLength(a.content, "utf8");
      // Count `<url>` entries only inside chunk files; the index
      // file's `<sitemap>` entries are an internal pointer surface,
      // not part of the URL count an operator cares about.
      if (a.content.indexOf(urlsetOpenTag) !== -1) {
        var marker = "<url>";
        var pos = -1;
        while ((pos = a.content.indexOf(marker, pos + 1)) !== -1) {
          totalUrlCount += 1;
        }
      }
    }

    var id = _b().uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO sitemap_generations (id, origin_url, artifact_count, total_url_count, " +
      "total_byte_size, generated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, originUrl, artifactCount, totalUrlCount, totalByteSize, ts],
    );
    return {
      id:               id,
      origin_url:       originUrl,
      artifact_count:   artifactCount,
      total_url_count:  totalUrlCount,
      total_byte_size:  totalByteSize,
      generated_at:     ts,
    };
  }

  // ---- lastGeneration -------------------------------------------------

  async function lastGeneration() {
    var rows = (await query(
      "SELECT * FROM sitemap_generations ORDER BY generated_at DESC, id DESC LIMIT 1",
      [],
    )).rows;
    if (!rows.length) return null;
    return _hydrateGeneration(rows[0]);
  }

  return {
    URL_HARD_CAP:         URL_HARD_CAP,
    BYTE_HARD_CAP:        BYTE_HARD_CAP,
    ALLOWED_SOURCES:      ALLOWED_SOURCES,
    ALLOWED_CHANGEFREQS:  ALLOWED_CHANGEFREQS,

    defineSection:       defineSection,
    sections:            sections,
    archiveSection:      archiveSection,
    validateOriginUrl:   validateOriginUrl,
    generate:            generate,
    recordGeneration:    recordGeneration,
    lastGeneration:      lastGeneration,
  };
}

module.exports = {
  create:               create,
  URL_HARD_CAP:         URL_HARD_CAP,
  BYTE_HARD_CAP:        BYTE_HARD_CAP,
  ALLOWED_SOURCES:      ALLOWED_SOURCES,
  ALLOWED_CHANGEFREQS:  ALLOWED_CHANGEFREQS,
};
