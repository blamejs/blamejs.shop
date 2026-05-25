"use strict";
/**
 * @module shop.robotsConfig
 * @title  Robots config — operator-editable robots.txt rules,
 *         AI-crawler opt-outs, sitemap declarations, optional
 *         canonical-host hint.
 *
 * @intro
 *   The bytes a crawler fetches at `/robots.txt`. Distinct from the
 *   worker's static fallback (which ships an allow-all default with
 *   one Sitemap declaration so a fresh deploy is still crawlable) —
 *   this primitive is the operator's editable surface:
 *
 *     - Per-bot Allow / Disallow stanzas. Each `defineRule` call
 *       persists one (user_agent, allow[], disallow[], crawl_delay?)
 *       tuple. `render()` joins every active rule into the canonical
 *       robots.txt format, stable-sorted by `priority` ASC then
 *       `user_agent` ASC.
 *     - Sitemap declarations. `addSitemap(url)` records an absolute
 *       https:// URL the crawler should fetch the sitemap index from;
 *       `render()` emits each one on its own `Sitemap: <url>` line at
 *       the bottom of the file (the convention every search engine
 *       follows). Duplicate adds are idempotent (the URL is the PK).
 *     - Host directive. `setHostDirective(host)` upserts the optional
 *       `Host: <canonical-host>` hint. The directive is non-standard
 *       but widely-honored — Yandex's primary canonical signal, a soft
 *       hint to Bing, ignored by Google. The line is omitted entirely
 *       when no host has been set.
 *     - Predefined templates. `predefinedTemplates()` returns the
 *       four common bot-block payloads operators reach for first:
 *       `block_ai_crawlers` (GPTBot / ClaudeBot / CCBot / anthropic-ai /
 *       Google-Extended / Bytespider / Amazonbot / FacebookBot — every
 *       AI-training scraper currently in the wild), `block_all`
 *       (one `User-agent: *` / `Disallow: /` stanza), `open_all`
 *       (allow-everything, suitable for a fresh launch), and
 *       `standard_with_admin_disallow` (open allow plus a
 *       `Disallow: /admin/` to keep the admin surface out of search
 *       indices). `applyTemplate({ template_slug })` archives every
 *       active rule and writes the template's stanzas as the new
 *       baseline — the prior rules remain in the table for audit but
 *       no longer affect `render()`.
 *
 *   Render contract. The emitted bytes are the canonical robots.txt
 *   format: one stanza per rule, each stanza is
 *     User-agent: <ua>
 *     [Crawl-delay: <n>]
 *     Allow: <path>     (one line per allow entry)
 *     Disallow: <path>  (one line per disallow entry)
 *   followed by a blank line. Stanzas with the same user_agent are
 *   emitted as separate blocks (operators sometimes want two
 *   priorities against the same bot — e.g. priority=10 for the
 *   permissive "allow /search" line and priority=20 for the broader
 *   "disallow /admin" line). The `Host:` line (when set) and every
 *   `Sitemap:` line follow at the bottom of the file.
 *
 *   Validation discipline.
 *     - Sitemap URLs run through `b.safeUrl.parse` with the
 *       `{ allowedProtocols: ["https:"] }` allowlist. Cleartext is
 *       refused; an MITM rewriting the sitemap location would let an
 *       attacker swap the crawler's view of the site.
 *     - The host directive accepts a hostname or `host:port` shape —
 *       no scheme, no path. The host is just the canonical hostname
 *       the operator wants crawlers to attribute results to.
 *     - User-agent strings are length-capped and refuse control bytes
 *       — robots.txt is a newline-delimited format and a CR/LF in the
 *       UA field would break the stanza boundary.
 *     - Allow / Disallow path entries are `/`-rooted absolute paths
 *       (relative paths are meaningless in robots.txt). Wildcards
 *       (`*` and `$`) are permitted — every major crawler honors the
 *       extended-syntax wildcards even though they're not in the
 *       original 1994 spec.
 *
 *   Composes ONLY blamejs:
 *     - `b.framework.safeUrl.parse` — sitemap URL validation
 *       (https-only).
 *     - `b.framework.uuid.v7` — rule-row id; lexicographically
 *       sortable so a `created_at` tiebreak is rarely needed.
 *
 *   Storage (migration `0147_robots_config.sql`):
 *     - `robots_rules`           — one row per operator-defined stanza
 *     - `robots_sitemaps`        — one row per declared sitemap URL
 *     - `robots_host_directive`  — singleton row (id=1) holding the
 *                                  canonical-host hint
 *
 * @primitive robotsConfig
 * @related   shop.sitemapGenerator, b.safeUrl.parse, b.uuid.v7
 */

var MAX_USER_AGENT_LEN  = 200;
var MAX_PATH_LEN        = 512;
var MAX_PATHS_PER_RULE  = 200;
var MAX_SITEMAP_URL_LEN = 2048;
var MAX_HOST_LEN        = 255;
// allow:raw-time-literal — robots.txt Crawl-delay is a seconds value; C.TIME returns ms
var MAX_CRAWL_DELAY     = 86400;     // 24 h — anything larger is a typo
var MAX_PRIORITY        = 1000000;
var MAX_RULE_ID_LEN     = 80;

var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

// Lazy framework handle — matches the rest of the shop primitives.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- predefined templates ---------------------------------------------
//
// The frozen catalog of canned payloads `applyTemplate` writes into the
// `robots_rules` table. Each entry is the stanza set + the sitemap +
// host fields a sensible default would carry; `applyTemplate` does the
// archive-then-write step. The catalog is exported through
// `predefinedTemplates()` so the operator-facing dashboard can render
// the choices without re-reading this file.

var PREDEFINED_TEMPLATES = Object.freeze({
  block_ai_crawlers: Object.freeze({
    slug: "block_ai_crawlers",
    label: "Block AI training crawlers",
    description:
      "Refuse every AI-training scraper currently in the wild — " +
      "GPTBot (OpenAI), ClaudeBot + anthropic-ai (Anthropic), " +
      "CCBot (Common Crawl, the corpus most LLMs train on), " +
      "Google-Extended (Google's training opt-out token), " +
      "Bytespider (ByteDance), Amazonbot, FacebookBot. Leaves " +
      "the wildcard `*` stanza permissive so search-engine indexing " +
      "continues to work.",
    rules: Object.freeze([
      Object.freeze({ user_agent: "GPTBot",          allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "ClaudeBot",       allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "anthropic-ai",    allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "CCBot",           allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "Google-Extended", allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "Bytespider",      allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "Amazonbot",       allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "FacebookBot",     allow: [], disallow: ["/"], priority: 10 }),
      Object.freeze({ user_agent: "*",               allow: [], disallow: [],    priority: 100 }),
    ]),
  }),
  block_all: Object.freeze({
    slug: "block_all",
    label: "Block every crawler",
    description:
      "Refuse every crawler at every path. Suitable for a staging " +
      "environment or a pre-launch site that must not leak into " +
      "search indices.",
    rules: Object.freeze([
      Object.freeze({ user_agent: "*", allow: [], disallow: ["/"], priority: 100 }),
    ]),
  }),
  open_all: Object.freeze({
    slug: "open_all",
    label: "Open to every crawler",
    description:
      "Permit every crawler to fetch every path. The default shape " +
      "for a freshly-launched storefront that wants maximum search " +
      "visibility.",
    rules: Object.freeze([
      Object.freeze({ user_agent: "*", allow: [], disallow: [], priority: 100 }),
    ]),
  }),
  standard_with_admin_disallow: Object.freeze({
    slug: "standard_with_admin_disallow",
    label: "Open with /admin/ disallowed",
    description:
      "Permit every crawler except inside `/admin/`. Keeps the " +
      "operator-only surface out of search indices while leaving " +
      "the storefront fully crawlable.",
    rules: Object.freeze([
      Object.freeze({
        user_agent: "*",
        allow:      [],
        disallow:   ["/admin/"],
        priority:   100,
      }),
    ]),
  }),
});

var TEMPLATE_SLUGS = Object.freeze(Object.keys(PREDEFINED_TEMPLATES));

// ---- validators -------------------------------------------------------

function _userAgent(s) {
  if (typeof s !== "string" || s.length < 1 || s.length > MAX_USER_AGENT_LEN) {
    throw new TypeError(
      "robotsConfig: user_agent must be a string 1.." + MAX_USER_AGENT_LEN + " chars"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("robotsConfig: user_agent must not contain control bytes");
  }
  // robots.txt is a colon-delimited key/value format — a colon in the
  // user-agent value would shift the parser onto a different key.
  if (s.indexOf(":") !== -1) {
    throw new TypeError("robotsConfig: user_agent must not contain ':'");
  }
  return s;
}

function _pathEntry(s, label) {
  if (typeof s !== "string" || s.length < 1 || s.length > MAX_PATH_LEN) {
    throw new TypeError(
      "robotsConfig: " + label + " entry must be a string 1.." + MAX_PATH_LEN + " chars"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("robotsConfig: " + label + " entry must not contain control bytes");
  }
  // robots.txt path entries are /-rooted absolute paths. Wildcards
  // (`*` for "any sequence") and end-of-path anchors (`$`) are
  // honored by every major crawler — the leading `/` is the only
  // structural rule.
  if (s.charCodeAt(0) !== 47 /* "/" */) {
    throw new TypeError(
      "robotsConfig: " + label + " entry must be a /-rooted absolute path; got " + JSON.stringify(s)
    );
  }
  return s;
}

function _pathArray(arr, label) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("robotsConfig: " + label + " must be an array of paths");
  }
  if (arr.length > MAX_PATHS_PER_RULE) {
    throw new TypeError(
      "robotsConfig: " + label + " must have <= " + MAX_PATHS_PER_RULE + " entries"
    );
  }
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    out.push(_pathEntry(arr[i], label));
  }
  return out;
}

function _crawlDelay(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0 || n > MAX_CRAWL_DELAY) {
    throw new TypeError(
      "robotsConfig: crawl_delay must be an integer 0.." + MAX_CRAWL_DELAY + " seconds, or null"
    );
  }
  return n;
}

function _priority(n) {
  if (n == null) return 100;
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) {
    throw new TypeError(
      "robotsConfig: priority must be an integer 0.." + MAX_PRIORITY
    );
  }
  return n;
}

function _ruleId(s) {
  if (typeof s !== "string" || s.length < 1 || s.length > MAX_RULE_ID_LEN) {
    throw new TypeError(
      "robotsConfig: rule_id must be a string 1.." + MAX_RULE_ID_LEN + " chars"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("robotsConfig: rule_id must not contain control bytes");
  }
  return s;
}

function _sitemapUrl(u) {
  if (typeof u !== "string" || u.length < 1 || u.length > MAX_SITEMAP_URL_LEN) {
    throw new TypeError(
      "robotsConfig: sitemap url must be a string 1.." + MAX_SITEMAP_URL_LEN + " chars"
    );
  }
  if (CONTROL_BYTE_RE.test(u)) {
    throw new TypeError("robotsConfig: sitemap url must not contain control bytes");
  }
  // robots.txt only carries the URL itself, so the path-rooted form
  // promo-banners accepts isn't meaningful here — every crawler treats
  // the Sitemap: value as an absolute URL. https-only protects against
  // an MITM rewriting the sitemap location.
  try {
    _b().safeUrl.parse(u, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError(
      "robotsConfig: sitemap url — " + (e && e.message || "must be a valid https:// URL")
    );
  }
  return u;
}

function _hostDirective(s) {
  if (typeof s !== "string" || s.length < 1 || s.length > MAX_HOST_LEN) {
    throw new TypeError(
      "robotsConfig: host must be a string 1.." + MAX_HOST_LEN + " chars"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("robotsConfig: host must not contain control bytes");
  }
  // The host directive is a bare hostname (optionally with :port) —
  // no scheme, no path. Refuse anything that looks like a URL so an
  // operator can't accidentally paste the full origin URL in.
  if (s.indexOf("/") !== -1 || s.indexOf(":") !== s.lastIndexOf(":")) {
    throw new TypeError(
      "robotsConfig: host must be a bare hostname (optionally host:port), no scheme / path"
    );
  }
  if (s.indexOf("://") !== -1) {
    throw new TypeError(
      "robotsConfig: host must be a bare hostname, not a scheme://host URL"
    );
  }
  // A hostname character class — letters, digits, dot, hyphen, and an
  // optional :port suffix.
  if (!/^[A-Za-z0-9.\-]+(?::[0-9]+)?$/.test(s)) {
    throw new TypeError(
      "robotsConfig: host must match hostname (optionally host:port) syntax"
    );
  }
  return s;
}

function _templateSlug(s) {
  if (typeof s !== "string" || s.length < 1) {
    throw new TypeError("robotsConfig: template_slug must be a non-empty string");
  }
  if (TEMPLATE_SLUGS.indexOf(s) === -1) {
    throw new TypeError(
      "robotsConfig: template_slug must be one of " + TEMPLATE_SLUGS.join(", ") +
      "; got " + JSON.stringify(s)
    );
  }
  return s;
}

// ---- row hydration ----------------------------------------------------

function _hydrateRule(row) {
  if (!row) return null;
  var allow    = [];
  var disallow = [];
  try { allow    = JSON.parse(row.allow_json    || "[]"); } catch (_e) { allow    = []; }
  try { disallow = JSON.parse(row.disallow_json || "[]"); } catch (_e) { disallow = []; }
  return {
    id:          row.id,
    user_agent:  row.user_agent,
    allow:       Array.isArray(allow)    ? allow    : [],
    disallow:    Array.isArray(disallow) ? disallow : [],
    crawl_delay: row.crawl_delay == null ? null : Number(row.crawl_delay),
    priority:    Number(row.priority),
    archived_at: row.archived_at == null ? null : Number(row.archived_at),
    created_at:  Number(row.created_at),
    updated_at:  Number(row.updated_at),
  };
}

// ---- render -----------------------------------------------------------

function _renderRule(rule) {
  // One stanza per rule. The stanza always opens with the User-agent
  // line; Crawl-delay (when set) follows; then every Allow line; then
  // every Disallow line; closing with a blank line so the next stanza
  // is parseable as a fresh block.
  var lines = ["User-agent: " + rule.user_agent];
  if (rule.crawl_delay != null) {
    lines.push("Crawl-delay: " + rule.crawl_delay);
  }
  for (var ai = 0; ai < rule.allow.length; ai += 1) {
    lines.push("Allow: " + rule.allow[ai]);
  }
  for (var di = 0; di < rule.disallow.length; di += 1) {
    lines.push("Disallow: " + rule.disallow[di]);
  }
  return lines.join("\n");
}

// ---- factory ----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Per-factory monotonic clock — guarantees `updated_at` across a
  // defineRule + updateRule + archiveRule chain is strictly
  // increasing even when the wall clock has 1 ms resolution and the
  // caller threads the calls inside one tick.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  async function _getRule(ruleId) {
    var r = await query(
      "SELECT * FROM robots_rules WHERE id = ?1 LIMIT 1",
      [ruleId],
    );
    return _hydrateRule(r.rows[0] || null);
  }

  // ---- defineRule -----------------------------------------------------

  async function defineRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("robotsConfig.defineRule: input object required");
    }
    var userAgent  = _userAgent(input.user_agent);
    var allow      = _pathArray(input.allow,    "allow");
    var disallow   = _pathArray(input.disallow, "disallow");
    var crawlDelay = _crawlDelay(input.crawl_delay == null ? null : input.crawl_delay);
    var priority   = _priority(input.priority == null ? null : input.priority);

    var id = _b().uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO robots_rules " +
      "(id, user_agent, allow_json, disallow_json, crawl_delay, priority, " +
      " archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
      [
        id, userAgent,
        JSON.stringify(allow),
        JSON.stringify(disallow),
        crawlDelay,
        priority,
        ts,
      ],
    );
    return await _getRule(id);
  }

  // ---- listRules ------------------------------------------------------

  async function listRules(input) {
    input = input || {};
    var sql;
    var params = [];
    if (input.user_agent != null) {
      var ua = _userAgent(input.user_agent);
      sql = "SELECT * FROM robots_rules WHERE archived_at IS NULL AND user_agent = ?1 " +
            "ORDER BY priority ASC, user_agent ASC, created_at ASC";
      params = [ua];
    } else {
      sql = "SELECT * FROM robots_rules WHERE archived_at IS NULL " +
            "ORDER BY priority ASC, user_agent ASC, created_at ASC";
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRule(rows[i]));
    return out;
  }

  // ---- archiveRule ----------------------------------------------------

  async function archiveRule(ruleId) {
    _ruleId(ruleId);
    var current = await _getRule(ruleId);
    if (!current) {
      throw new TypeError(
        "robotsConfig.archiveRule: rule_id " + JSON.stringify(ruleId) + " not found"
      );
    }
    if (current.archived_at != null) return current;
    var ts = _monotonicTs();
    await query(
      "UPDATE robots_rules SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
      [ts, ruleId],
    );
    return await _getRule(ruleId);
  }

  // ---- updateRule -----------------------------------------------------

  async function updateRule(ruleId, patch) {
    _ruleId(ruleId);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("robotsConfig.updateRule: patch object required");
    }
    var current = await _getRule(ruleId);
    if (!current) {
      throw new TypeError(
        "robotsConfig.updateRule: rule_id " + JSON.stringify(ruleId) + " not found"
      );
    }
    if (current.archived_at != null) {
      throw new TypeError(
        "robotsConfig.updateRule: rule_id " + JSON.stringify(ruleId) +
        " is archived; defineRule a fresh rule instead"
      );
    }

    var next = {
      user_agent:  current.user_agent,
      allow:       current.allow,
      disallow:    current.disallow,
      crawl_delay: current.crawl_delay,
      priority:    current.priority,
    };
    if (patch.user_agent  != null) next.user_agent  = _userAgent(patch.user_agent);
    if (patch.allow       != null) next.allow       = _pathArray(patch.allow,    "allow");
    if (patch.disallow    != null) next.disallow    = _pathArray(patch.disallow, "disallow");
    // `crawl_delay` is the one nullable field — an explicit `null` in
    // the patch clears the column; absence preserves it.
    if (Object.prototype.hasOwnProperty.call(patch, "crawl_delay")) {
      next.crawl_delay = _crawlDelay(patch.crawl_delay);
    }
    if (patch.priority    != null) next.priority    = _priority(patch.priority);

    var ts = _monotonicTs();
    await query(
      "UPDATE robots_rules SET " +
      "user_agent = ?1, allow_json = ?2, disallow_json = ?3, " +
      "crawl_delay = ?4, priority = ?5, updated_at = ?6 " +
      "WHERE id = ?7",
      [
        next.user_agent,
        JSON.stringify(next.allow),
        JSON.stringify(next.disallow),
        next.crawl_delay,
        next.priority,
        ts,
        ruleId,
      ],
    );
    return await _getRule(ruleId);
  }

  // ---- sitemaps -------------------------------------------------------

  async function addSitemap(url) {
    var u = _sitemapUrl(url);
    var ts = _monotonicTs();
    // INSERT OR IGNORE — the URL is the PK so a duplicate add is a no-op
    // rather than a throw. The first add wins on `added_at`; a later
    // re-add doesn't bump the timestamp (the operator's audit trail
    // shows when the URL was first declared).
    await query(
      "INSERT OR IGNORE INTO robots_sitemaps (url, added_at) VALUES (?1, ?2)",
      [u, ts],
    );
    var r = await query(
      "SELECT url, added_at FROM robots_sitemaps WHERE url = ?1 LIMIT 1",
      [u],
    );
    var row = r.rows[0];
    return { url: row.url, added_at: Number(row.added_at) };
  }

  async function removeSitemap(url) {
    var u = _sitemapUrl(url);
    var r = await query(
      "DELETE FROM robots_sitemaps WHERE url = ?1",
      [u],
    );
    return { removed: Number(r.rowCount || 0) > 0 };
  }

  async function listSitemaps() {
    var rows = (await query(
      "SELECT url, added_at FROM robots_sitemaps ORDER BY added_at ASC, url ASC",
      [],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      out.push({ url: rows[i].url, added_at: Number(rows[i].added_at) });
    }
    return out;
  }

  // ---- host directive -------------------------------------------------

  async function setHostDirective(host) {
    var h = _hostDirective(host);
    var ts = _monotonicTs();
    // SQLite UPSERT against the singleton row (id = 1). The CHECK
    // constraint on the table forbids any other id, so the table is
    // bounded to at most one host string.
    await query(
      "INSERT INTO robots_host_directive (id, host, updated_at) VALUES (1, ?1, ?2) " +
      "ON CONFLICT(id) DO UPDATE SET host = excluded.host, updated_at = excluded.updated_at",
      [h, ts],
    );
    return { host: h, updated_at: ts };
  }

  async function getHostDirective() {
    var r = await query(
      "SELECT host, updated_at FROM robots_host_directive WHERE id = 1 LIMIT 1",
      [],
    );
    var row = r.rows[0];
    if (!row) return null;
    return { host: row.host, updated_at: Number(row.updated_at) };
  }

  // ---- render ---------------------------------------------------------

  async function render(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("robotsConfig.render: input object required");
    }
    // `origin_url` validates through `b.safeUrl` — required so the
    // bytes always carry a canonical origin context even when no
    // sitemap entries are declared. The render output itself doesn't
    // embed origin_url, but accepting it here keeps the surface
    // symmetrical with sitemapGenerator.generate({ origin_url }) and
    // lets a future emission step interpolate the canonical host into
    // operator-supplied path entries.
    if (typeof input.origin_url !== "string" || !input.origin_url.length) {
      throw new TypeError("robotsConfig.render: origin_url must be a non-empty string");
    }
    try {
      _b().safeUrl.parse(input.origin_url, { allowedProtocols: ["https:"] });
    } catch (e) {
      throw new TypeError(
        "robotsConfig.render: origin_url — " + (e && e.message || "must be a valid https:// URL")
      );
    }

    var rules    = await listRules({});
    var sitemaps = await listSitemaps();
    var host     = await getHostDirective();

    var sections = [];

    // Empty-config fallback: emit the open-all default. The worker's
    // static /robots.txt fallback handles the "no DB connectivity"
    // case; this branch handles "DB up, table empty" so a fresh
    // deploy still serves a well-formed robots.txt.
    if (rules.length === 0) {
      sections.push("User-agent: *\nAllow: /");
    } else {
      for (var i = 0; i < rules.length; i += 1) {
        sections.push(_renderRule(rules[i]));
      }
    }

    if (host) {
      sections.push("Host: " + host.host);
    }

    if (sitemaps.length > 0) {
      var sitemapLines = [];
      for (var si = 0; si < sitemaps.length; si += 1) {
        sitemapLines.push("Sitemap: " + sitemaps[si].url);
      }
      sections.push(sitemapLines.join("\n"));
    }

    // Sections separated by a single blank line; trailing newline so
    // the file ends on a clean LF boundary the way every robots.txt
    // emitter in the wild ships it.
    return sections.join("\n\n") + "\n";
  }

  // ---- templates ------------------------------------------------------

  function predefinedTemplates() {
    // Return a freshly-cloned snapshot so callers cannot mutate the
    // frozen catalog. The catalog itself is deep-frozen at module
    // load; the returned shape is a plain-object copy suitable for
    // serialization back to a dashboard.
    var out = {};
    for (var i = 0; i < TEMPLATE_SLUGS.length; i += 1) {
      var slug = TEMPLATE_SLUGS[i];
      var tpl  = PREDEFINED_TEMPLATES[slug];
      var rules = [];
      for (var ri = 0; ri < tpl.rules.length; ri += 1) {
        var r = tpl.rules[ri];
        rules.push({
          user_agent: r.user_agent,
          allow:      r.allow.slice(),
          disallow:   r.disallow.slice(),
          priority:   r.priority,
        });
      }
      out[slug] = {
        slug:        tpl.slug,
        label:       tpl.label,
        description: tpl.description,
        rules:       rules,
      };
    }
    return out;
  }

  async function applyTemplate(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("robotsConfig.applyTemplate: input object required");
    }
    var slug = _templateSlug(input.template_slug);
    var tpl  = PREDEFINED_TEMPLATES[slug];

    // Archive every currently-active rule. The audit trail keeps the
    // prior shape; `listRules({})` returns only the active set so the
    // template's stanzas become the new baseline.
    var active = await listRules({});
    for (var ai = 0; ai < active.length; ai += 1) {
      await archiveRule(active[ai].id);
    }

    // Write each template stanza as a fresh rule. The priority field
    // on the template entries is honored so an operator who renders
    // immediately sees the canonical bot-block first.
    var written = [];
    for (var ri = 0; ri < tpl.rules.length; ri += 1) {
      var stanza = tpl.rules[ri];
      var rule = await defineRule({
        user_agent: stanza.user_agent,
        allow:      stanza.allow,
        disallow:   stanza.disallow,
        priority:   stanza.priority,
      });
      written.push(rule);
    }
    return { template_slug: slug, rules: written };
  }

  return {
    defineRule:           defineRule,
    listRules:            listRules,
    archiveRule:          archiveRule,
    updateRule:           updateRule,
    addSitemap:           addSitemap,
    removeSitemap:        removeSitemap,
    listSitemaps:         listSitemaps,
    setHostDirective:     setHostDirective,
    getHostDirective:     getHostDirective,
    render:               render,
    predefinedTemplates:  predefinedTemplates,
    applyTemplate:        applyTemplate,
    TEMPLATE_SLUGS:       TEMPLATE_SLUGS,
  };
}

module.exports = {
  create:               create,
  TEMPLATE_SLUGS:       TEMPLATE_SLUGS,
  MAX_USER_AGENT_LEN:   MAX_USER_AGENT_LEN,
  MAX_PATH_LEN:         MAX_PATH_LEN,
  MAX_PATHS_PER_RULE:   MAX_PATHS_PER_RULE,
  MAX_SITEMAP_URL_LEN:  MAX_SITEMAP_URL_LEN,
  MAX_HOST_LEN:         MAX_HOST_LEN,
  MAX_CRAWL_DELAY:      MAX_CRAWL_DELAY,
};
