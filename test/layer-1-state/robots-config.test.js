"use strict";
/**
 * robotsConfig — operator-editable robots.txt rules, sitemap
 * declarations, optional canonical-host hint, and a canned-template
 * catalog covering the four common bot-block payloads.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0147.
 *
 * Coverage:
 *   - defineRule persists user_agent + allow / disallow / crawl_delay
 *     + priority; listRules returns the active set sorted by priority
 *     ASC; missing values default sensibly (priority = 100, crawl_delay
 *     = null, allow + disallow = [])
 *   - addSitemap is idempotent against duplicate URLs (the URL is the
 *     PK); listSitemaps round-trips; removeSitemap deletes the row
 *   - render emits a well-formed robots.txt — one User-agent per
 *     stanza, every Allow / Disallow / Crawl-delay line present,
 *     stanzas separated by a blank line, Sitemap lines at the bottom,
 *     trailing newline
 *   - predefinedTemplates ships the four documented payloads
 *     (block_ai_crawlers / block_all / open_all / standard_with_admin_disallow)
 *     with the expected user-agent set
 *   - applyTemplate archives existing rules and writes the template's
 *     stanzas as the new baseline; render reflects the swap
 *   - setHostDirective upserts the singleton host row and render emits
 *     the `Host:` line; absence omits the line
 *   - validation refusals: bad user_agent shape, bad path entries, bad
 *     crawl_delay, non-https sitemap URL, malformed host directive,
 *     unknown template slug
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

require("../../lib");                                                       // ensure entry-point loads so the lazy framework handle works
var robotsConfig = require("../../lib/robots-config");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0147_robots_config.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
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

function _setup() {
  var query = _makeQuery();
  var rc    = robotsConfig.create({ query: query });
  return { query: query, rc: rc };
}

// ----------------------------------------------------------------------

async function _defineAndListRules() {
  var ctx = _setup();

  var ruleA = await ctx.rc.defineRule({
    user_agent: "GPTBot",
    allow:      [],
    disallow:   ["/"],
    priority:   10,
  });
  check("defineRule returns object",                ruleA && typeof ruleA === "object");
  check("defineRule stamps id",                     typeof ruleA.id === "string" && ruleA.id.length > 0);
  check("defineRule round-trips user_agent",        ruleA.user_agent === "GPTBot");
  check("defineRule round-trips disallow",          Array.isArray(ruleA.disallow) && ruleA.disallow.length === 1 && ruleA.disallow[0] === "/");
  check("defineRule round-trips empty allow",       Array.isArray(ruleA.allow) && ruleA.allow.length === 0);
  check("defineRule round-trips priority",          ruleA.priority === 10);
  check("defineRule defaults crawl_delay null",     ruleA.crawl_delay === null);
  check("defineRule timestamps created_at",         typeof ruleA.created_at === "number" && ruleA.created_at > 0);
  check("defineRule timestamps updated_at",         typeof ruleA.updated_at === "number");
  check("defineRule archived_at null",              ruleA.archived_at === null);

  // A second rule against the wildcard with crawl-delay set.
  var ruleB = await ctx.rc.defineRule({
    user_agent:  "*",
    allow:       ["/search"],
    disallow:    ["/admin/", "/cart/checkout"],
    crawl_delay: 5,
  });
  check("defineRule second rule priority default",  ruleB.priority === 100);
  check("defineRule crawl_delay round-trip",        ruleB.crawl_delay === 5);
  check("defineRule allow round-trip",              ruleB.allow.length === 1 && ruleB.allow[0] === "/search");
  check("defineRule disallow array round-trip",     ruleB.disallow.length === 2);

  // listRules — priority ASC, GPTBot (10) before * (100).
  var all = await ctx.rc.listRules({});
  check("listRules returns both",                   all.length === 2);
  check("listRules sorted by priority",             all[0].user_agent === "GPTBot" && all[1].user_agent === "*");

  // listRules filter by user_agent.
  var onlyWildcard = await ctx.rc.listRules({ user_agent: "*" });
  check("listRules filter returns one row",         onlyWildcard.length === 1);
  check("listRules filter matched the wildcard",    onlyWildcard[0].user_agent === "*");

  // archiveRule drops the row from listRules.
  var archived = await ctx.rc.archiveRule(ruleA.id);
  check("archiveRule stamps archived_at",           typeof archived.archived_at === "number");
  var afterArchive = await ctx.rc.listRules({});
  check("listRules excludes archived",              afterArchive.length === 1);
  check("listRules remaining is wildcard",          afterArchive[0].user_agent === "*");

  // updateRule edits an active rule in place.
  var updated = await ctx.rc.updateRule(ruleB.id, {
    crawl_delay: 10,
    disallow:    ["/admin/"],
  });
  check("updateRule changes crawl_delay",           updated.crawl_delay === 10);
  check("updateRule changes disallow",              updated.disallow.length === 1 && updated.disallow[0] === "/admin/");
  check("updateRule preserves user_agent",          updated.user_agent === "*");

  // updateRule clears crawl_delay with explicit null.
  var cleared = await ctx.rc.updateRule(ruleB.id, { crawl_delay: null });
  check("updateRule clears crawl_delay with null",  cleared.crawl_delay === null);

  // updateRule refuses an archived row.
  await assert.rejects(
    ctx.rc.updateRule(ruleA.id, { priority: 50 }),
    /archived/
  );
}

// ----------------------------------------------------------------------

async function _sitemapsLifecycle() {
  var ctx = _setup();

  var added = await ctx.rc.addSitemap("https://shop.example.com/sitemap.xml");
  check("addSitemap returns url + added_at",        added.url === "https://shop.example.com/sitemap.xml" && typeof added.added_at === "number");

  // Idempotent against the same URL.
  var addedAgain = await ctx.rc.addSitemap("https://shop.example.com/sitemap.xml");
  check("addSitemap same URL is idempotent",        addedAgain.url === added.url);
  check("addSitemap same URL preserves added_at",   addedAgain.added_at === added.added_at);

  // Distinct URL adds a fresh row.
  await ctx.rc.addSitemap("https://shop.example.com/sitemap-products.xml");
  var sitemaps = await ctx.rc.listSitemaps();
  check("listSitemaps returns both",                sitemaps.length === 2);

  // Remove drops one row; the other persists.
  var removed = await ctx.rc.removeSitemap("https://shop.example.com/sitemap-products.xml");
  check("removeSitemap reports removed:true",       removed.removed === true);
  var afterRemove = await ctx.rc.listSitemaps();
  check("listSitemaps after remove length",         afterRemove.length === 1);
  check("listSitemaps after remove the kept url",   afterRemove[0].url === "https://shop.example.com/sitemap.xml");

  // Removing an absent URL reports false (idempotent shape).
  var removeMiss = await ctx.rc.removeSitemap("https://shop.example.com/sitemap-missing.xml");
  check("removeSitemap missing URL false",          removeMiss.removed === false);
}

// ----------------------------------------------------------------------

async function _renderWellFormed() {
  var ctx = _setup();

  await ctx.rc.defineRule({
    user_agent: "GPTBot",
    allow:      [],
    disallow:   ["/"],
    priority:   10,
  });
  await ctx.rc.defineRule({
    user_agent:  "*",
    allow:       ["/search"],
    disallow:    ["/admin/"],
    crawl_delay: 5,
    priority:    100,
  });
  await ctx.rc.addSitemap("https://shop.example.com/sitemap.xml");

  var text = await ctx.rc.render({ origin_url: "https://shop.example.com" });
  check("render returns string",                    typeof text === "string");
  check("render trailing newline",                  text.charAt(text.length - 1) === "\n");

  // GPTBot stanza ahead of * (priority ASC).
  var gptIdx  = text.indexOf("User-agent: GPTBot");
  var starIdx = text.indexOf("User-agent: *");
  check("render emits GPTBot stanza",               gptIdx >= 0);
  check("render emits wildcard stanza",             starIdx >= 0);
  check("render orders GPTBot before wildcard",     gptIdx < starIdx);

  // Crawl-delay + Allow + Disallow lines.
  check("render emits Crawl-delay line",            text.indexOf("Crawl-delay: 5") !== -1);
  check("render emits Allow line",                  text.indexOf("Allow: /search") !== -1);
  check("render emits Disallow: / line",            text.indexOf("Disallow: /") !== -1);
  check("render emits /admin/ disallow",            text.indexOf("Disallow: /admin/") !== -1);

  // Sitemap line at the end (after every User-agent stanza).
  var sitemapIdx = text.indexOf("Sitemap: https://shop.example.com/sitemap.xml");
  check("render emits Sitemap line",                sitemapIdx > starIdx);

  // Each stanza separated by a blank line.
  check("render has blank-line separators",         text.indexOf("\n\n") !== -1);

  // render refuses a non-https origin_url.
  await assert.rejects(
    ctx.rc.render({ origin_url: "http://shop.example.com" }),
    /origin_url/
  );

  // Empty-config fallback: a fresh primitive with no rules renders an
  // open-all stanza so a deploy that hasn't been configured yet still
  // serves a well-formed file.
  var fresh = _setup();
  var emptyText = await fresh.rc.render({ origin_url: "https://shop.example.com" });
  check("render empty-config wildcard stanza",      emptyText.indexOf("User-agent: *") !== -1);
  check("render empty-config Allow: /",             emptyText.indexOf("Allow: /") !== -1);
}

// ----------------------------------------------------------------------

async function _predefinedTemplatesPayload() {
  var ctx = _setup();

  var tpls = ctx.rc.predefinedTemplates();
  check("predefinedTemplates ships block_ai_crawlers",          tpls.block_ai_crawlers && tpls.block_ai_crawlers.slug === "block_ai_crawlers");
  check("predefinedTemplates ships block_all",                  tpls.block_all && tpls.block_all.slug === "block_all");
  check("predefinedTemplates ships open_all",                   tpls.open_all && tpls.open_all.slug === "open_all");
  check("predefinedTemplates ships admin disallow",             tpls.standard_with_admin_disallow && tpls.standard_with_admin_disallow.slug === "standard_with_admin_disallow");

  // block_ai_crawlers carries the expected AI-bot user-agents.
  var aiAgents = tpls.block_ai_crawlers.rules.map(function (r) { return r.user_agent; });
  check("template lists GPTBot",                                aiAgents.indexOf("GPTBot")          !== -1);
  check("template lists ClaudeBot",                             aiAgents.indexOf("ClaudeBot")       !== -1);
  check("template lists anthropic-ai",                          aiAgents.indexOf("anthropic-ai")    !== -1);
  check("template lists CCBot",                                 aiAgents.indexOf("CCBot")           !== -1);
  check("template lists Google-Extended",                       aiAgents.indexOf("Google-Extended") !== -1);
  check("template lists Bytespider",                            aiAgents.indexOf("Bytespider")      !== -1);

  // block_all carries the single `*` / Disallow: / stanza.
  check("block_all has one rule",                               tpls.block_all.rules.length === 1);
  check("block_all rule is wildcard",                           tpls.block_all.rules[0].user_agent === "*");
  check("block_all rule disallow root",                         tpls.block_all.rules[0].disallow[0] === "/");

  // open_all has a wildcard with empty allow / disallow.
  check("open_all has one rule",                                tpls.open_all.rules.length === 1);
  check("open_all rule empty disallow",                         tpls.open_all.rules[0].disallow.length === 0);

  // standard_with_admin_disallow has /admin/ in disallow.
  check("admin template disallow /admin/",                      tpls.standard_with_admin_disallow.rules[0].disallow[0] === "/admin/");

  // Returned payload is a fresh clone — mutating it does not affect
  // the next predefinedTemplates() call.
  tpls.block_ai_crawlers.rules.push({ user_agent: "MutationBot", allow: [], disallow: ["/"], priority: 5 });
  var tplsAgain = ctx.rc.predefinedTemplates();
  var allAgents = tplsAgain.block_ai_crawlers.rules.map(function (r) { return r.user_agent; });
  check("predefinedTemplates clone-safe",                       allAgents.indexOf("MutationBot") === -1);
}

// ----------------------------------------------------------------------

async function _applyTemplateReplacesRules() {
  var ctx = _setup();

  // Seed with an arbitrary user-defined rule so applyTemplate has
  // something to archive.
  var legacy = await ctx.rc.defineRule({
    user_agent: "OldBot",
    disallow:   ["/secret/"],
    priority:   50,
  });
  var beforeActive = await ctx.rc.listRules({});
  check("seeded rule is active",                                beforeActive.length === 1);

  var applied = await ctx.rc.applyTemplate({ template_slug: "block_ai_crawlers" });
  check("applyTemplate reports the slug",                       applied.template_slug === "block_ai_crawlers");
  check("applyTemplate returns the new rules",                  Array.isArray(applied.rules) && applied.rules.length >= 8);

  // The legacy rule must now be archived.
  var afterActive = await ctx.rc.listRules({});
  var stillLegacy = afterActive.some(function (r) { return r.user_agent === "OldBot"; });
  check("applyTemplate archived the legacy rule",               stillLegacy === false);

  // The render output reflects every template stanza.
  var text = await ctx.rc.render({ origin_url: "https://shop.example.com" });
  check("applyTemplate render carries GPTBot",                  text.indexOf("User-agent: GPTBot")          !== -1);
  check("applyTemplate render carries ClaudeBot",               text.indexOf("User-agent: ClaudeBot")       !== -1);
  check("applyTemplate render carries Google-Extended",         text.indexOf("User-agent: Google-Extended") !== -1);
  check("applyTemplate render omits OldBot",                    text.indexOf("User-agent: OldBot") === -1);

  // The legacy rule's id remains queryable through archiveRule's
  // idempotent shape — archived = archived = same row.
  var stillArchived = await ctx.rc.archiveRule(legacy.id);
  check("archiveRule re-archive idempotent",                    stillArchived.archived_at != null);
}

// ----------------------------------------------------------------------

async function _hostDirectiveInOutput() {
  var ctx = _setup();

  // No host set → render omits the Host: line.
  await ctx.rc.defineRule({ user_agent: "*", priority: 100 });
  var before = await ctx.rc.render({ origin_url: "https://shop.example.com" });
  check("render without host omits Host: line",                 before.indexOf("Host:") === -1);

  // Set the host → render emits the Host: line.
  var setHost = await ctx.rc.setHostDirective("shop.example.com");
  check("setHostDirective returns the host",                    setHost.host === "shop.example.com");
  check("setHostDirective stamps updated_at",                   typeof setHost.updated_at === "number");

  var after = await ctx.rc.render({ origin_url: "https://shop.example.com" });
  check("render with host emits Host: line",                    after.indexOf("Host: shop.example.com") !== -1);

  // getHostDirective round-trips.
  var got = await ctx.rc.getHostDirective();
  check("getHostDirective returns the row",                     got && got.host === "shop.example.com");

  // Upsert the host to a new value; singleton table holds at most one.
  var changed = await ctx.rc.setHostDirective("www.shop.example.com");
  check("setHostDirective upserts",                             changed.host === "www.shop.example.com");
  var afterChange = await ctx.rc.render({ origin_url: "https://shop.example.com" });
  check("render reflects updated host",                         afterChange.indexOf("Host: www.shop.example.com") !== -1);
  check("render does not duplicate Host: line",                 afterChange.split("Host: ").length === 2);

  // Host accepting a :port suffix.
  await ctx.rc.setHostDirective("shop.example.com:8443");
  var withPort = await ctx.rc.render({ origin_url: "https://shop.example.com" });
  check("render emits host:port",                               withPort.indexOf("Host: shop.example.com:8443") !== -1);
}

// ----------------------------------------------------------------------

async function _inputRefusals() {
  var ctx = _setup();

  // defineRule: missing input.
  await assert.rejects(ctx.rc.defineRule(null),    /input object required/);
  await assert.rejects(ctx.rc.defineRule({}),      /user_agent/);

  // defineRule: bad user_agent.
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "bad\nname", disallow: ["/"] }),
    /must be a single line/
  );
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "has:colon", disallow: ["/"] }),
    /':'/
  );
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "", disallow: ["/"] }),
    /user_agent/
  );

  // defineRule: bad path entry (not /-rooted).
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "Bot", disallow: ["admin"] }),
    /-rooted/
  );
  // Path with control bytes refused.
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "Bot", disallow: ["/admin\n"] }),
    /must not contain control bytes/
  );

  // defineRule: bad crawl_delay.
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "Bot", crawl_delay: -1 }),
    /crawl_delay/
  );
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "Bot", crawl_delay: 999999999 }),
    /crawl_delay/
  );
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "Bot", crawl_delay: 1.5 }),
    /crawl_delay/
  );

  // defineRule: bad priority.
  await assert.rejects(
    ctx.rc.defineRule({ user_agent: "Bot", priority: -1 }),
    /priority/
  );

  // addSitemap: non-https.
  await assert.rejects(
    ctx.rc.addSitemap("http://shop.example.com/sitemap.xml"),
    /sitemap url/
  );
  // addSitemap: javascript: refused by safeUrl.
  await assert.rejects(
    ctx.rc.addSitemap("javascript:alert(1)"),
    /sitemap url/
  );
  // addSitemap: control bytes refused.
  await assert.rejects(
    ctx.rc.addSitemap("https://shop.example.com/sitemap.xml\n"),
    /must be a single line/
  );

  // setHostDirective: refuses scheme.
  await assert.rejects(
    ctx.rc.setHostDirective("https://shop.example.com"),
    /host/
  );
  // setHostDirective: refuses path.
  await assert.rejects(
    ctx.rc.setHostDirective("shop.example.com/path"),
    /host/
  );
  // setHostDirective: refuses control bytes.
  await assert.rejects(
    ctx.rc.setHostDirective("shop.example.com\n"),
    /must be a single line/
  );

  // applyTemplate: unknown slug.
  await assert.rejects(
    ctx.rc.applyTemplate({ template_slug: "unknown" }),
    /template_slug/
  );
  await assert.rejects(
    ctx.rc.applyTemplate(null),
    /input object required/
  );

  // archiveRule: missing row.
  await assert.rejects(
    ctx.rc.archiveRule("not-a-real-id"),
    /not found/
  );

  // updateRule: missing row.
  await assert.rejects(
    ctx.rc.updateRule("not-a-real-id", { priority: 5 }),
    /not found/
  );
}

// ----------------------------------------------------------------------

async function run() {
  await _defineAndListRules();
  await _sitemapsLifecycle();
  await _renderWellFormed();
  await _predefinedTemplatesPayload();
  await _applyTemplateReplacesRules();
  await _hostDirectiveInOutput();
  await _inputRefusals();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/robots-config.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - robots-config (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
