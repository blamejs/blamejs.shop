"use strict";
/**
 * tenants — multi-store directory + host routing.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0063.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/tenants.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineTenant happy path (id / slug / hydrated primary +
 *     alt_domains / status default = active)
 *   - defineTenant refusals (bad slug, bad currency, bad domain
 *     shape, bad locale, bad theme slug, oversize name, control byte
 *     in name, alt-dup of primary, alt-dup within alt)
 *   - slug + primary-domain UNIQUE refusal at the directory layer
 *   - addDomain UNIQUE refusal (across tenants)
 *   - removeDomain refuses primary; succeeds for alt
 *   - setPrimaryDomain uniqueness within tenant — exactly one primary
 *     after the swap; the previous primary demotes to alt
 *   - resolveByHost: exact-match, lowercased, port-stripping, archived
 *     tenant does NOT resolve, paused tenant DOES resolve
 *   - FSM: active <-> paused, archive terminal (re-archive idempotent;
 *     pause/resume on archived refused)
 *   - listTenants filter by status; stats() rollup
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var tenants = require("../../lib/tenants");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0063_tenants.sql"
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
  var t     = tenants.create({ query: query });
  return { query: query, tenants: t };
}

function _validDefine(overrides) {
  return Object.assign({
    slug:              "acme",
    name:              "Acme Store",
    primary_domain:    "shop.acme.com",
    alt_domains:       ["www.acme.com"],
    default_currency:  "USD",
    default_locale:    "en-US",
    theme_slug:        "default",
  }, overrides || {});
}

async function _defineTenantHappyPath() {
  var ctx = _setup();
  var t = await ctx.tenants.defineTenant(_validDefine());
  check("defineTenant returns 36-char uuid id",      typeof t.id === "string" && t.id.length === 36);
  check("defineTenant stores slug",                  t.slug === "acme");
  check("defineTenant stores name",                  t.name === "Acme Store");
  check("defineTenant stores currency",              t.default_currency === "USD");
  check("defineTenant stores locale",                t.default_locale === "en-US");
  check("defineTenant stores theme_slug",            t.theme_slug === "default");
  check("defineTenant default status active",        t.status === "active");
  check("defineTenant paused_at null at open",       t.paused_at === null);
  check("defineTenant archived_at null at open",     t.archived_at === null);
  check("defineTenant stamps created_at",            typeof t.created_at === "number");
  check("defineTenant stamps updated_at",            typeof t.updated_at === "number");
  check("defineTenant hydrates primary_domain",      t.primary_domain === "shop.acme.com");
  check("defineTenant hydrates alt_domains array",   Array.isArray(t.alt_domains) && t.alt_domains.length === 1 && t.alt_domains[0] === "www.acme.com");
  check("defineTenant exposes domains[] with flags", Array.isArray(t.domains) && t.domains.length === 2);

  // get by slug and getById both resolve.
  var bySlug = await ctx.tenants.get("acme");
  check("get(slug) resolves",                        bySlug && bySlug.id === t.id);
  var byId = await ctx.tenants.getById(t.id);
  check("getById resolves",                          byId && byId.slug === "acme");

  // Mixed-case primary_domain canonicalises to lowercase on read.
  var t2 = await ctx.tenants.defineTenant(_validDefine({
    slug:           "globex",
    primary_domain: "Shop.Globex.COM",
    alt_domains:    [],
  }));
  check("defineTenant lowercases primary_domain",    t2.primary_domain === "shop.globex.com");
  check("defineTenant accepts empty alt_domains",    t2.alt_domains.length === 0);

  // Explicit status=paused honored.
  var t3 = await ctx.tenants.defineTenant(_validDefine({
    slug:           "pre-paused",
    primary_domain: "shop.pre-paused.com",
    alt_domains:    [],
    status:         "paused",
  }));
  check("defineTenant respects explicit status",     t3.status === "paused");
}

async function _defineTenantRefusals() {
  var ctx = _setup();
  await assert.rejects(ctx.tenants.defineTenant(),                                  /input object required/);
  // bad slug
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ slug: "-bad" })),    /slug/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ slug: "bad-" })),    /slug/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ slug: "BAD" })),     /slug/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ slug: "bad.dot" })), /slug/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ slug: "" })),        /slug/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ slug: "x".repeat(65) })), /slug/);
  // bad currency
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ default_currency: "usd" })), /default_currency/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ default_currency: "DOLLAR" })), /default_currency/);
  // bad locale
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ default_locale: "" })),       /default_locale/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ default_locale: "en_US" })),  /default_locale/);
  // bad theme slug
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ theme_slug: "BAD" })),        /theme_slug/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ theme_slug: "-bad" })),       /theme_slug/);
  // bad domain shape
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ primary_domain: "no-tld" })),    /primary_domain/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ primary_domain: "-bad.com" })),  /primary_domain/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ primary_domain: "localhost" })), /primary_domain/);
  // bad name
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ name: "" })),                    /name/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ name: "bad\x01name" })),         /control/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({
    name: "bad" + String.fromCharCode(0x200B) + "name",
  })), /zero-width/);
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ name: "x".repeat(201) })), /name/);
  // alt-domain dup of primary
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({
    primary_domain: "shop.acme.com",
    alt_domains:    ["shop.acme.com"],
  })), /duplicates primary_domain/);
  // alt-domain dup of itself
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({
    alt_domains: ["www.acme.com", "www.acme.com"],
  })), /duplicated within alt_domains/);
  // alt_domains not array
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ alt_domains: "www.acme.com" })),
    /alt_domains must be an array/);
  // explicit bad status
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({ status: "deleted" })),  /status/);

  // Slug uniqueness.
  await ctx.tenants.defineTenant(_validDefine());
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({
    primary_domain: "shop.acme-two.com",
    alt_domains:    [],
  })), /slug 'acme' is already registered/);

  // Primary-domain uniqueness across tenants (shop.acme.com already
  // registered above).
  await assert.rejects(ctx.tenants.defineTenant(_validDefine({
    slug:           "another",
    primary_domain: "shop.acme.com",
    alt_domains:    [],
  })), /already registered/);
}

async function _addDomainUniqueRefusal() {
  var ctx = _setup();
  await ctx.tenants.defineTenant(_validDefine());
  await ctx.tenants.defineTenant(_validDefine({
    slug:           "globex",
    primary_domain: "shop.globex.com",
    alt_domains:    [],
  }));

  // Add a fresh alt to acme — succeeds.
  var added = await ctx.tenants.addDomain("acme", "store.acme.com");
  check("addDomain hydrates new alt",
    added.alt_domains.indexOf("store.acme.com") !== -1);
  check("addDomain keeps primary unchanged",          added.primary_domain === "shop.acme.com");

  // Attempt to re-add an already-registered domain — refused. The
  // UNIQUE constraint on tenant_domains.domain is the floor; the
  // primitive surfaces a typed error.
  await assert.rejects(ctx.tenants.addDomain("acme", "store.acme.com"),
    /already registered/);
  // Adding a domain that belongs to another tenant — also refused.
  await assert.rejects(ctx.tenants.addDomain("globex", "store.acme.com"),
    /already registered/);

  // Adding to a non-existent tenant — refused.
  await assert.rejects(ctx.tenants.addDomain("nope", "fresh.example.com"),
    /tenant 'nope' not found/);

  // Bad domain shape on addDomain.
  await assert.rejects(ctx.tenants.addDomain("acme", "bad"), /domain/);

  // Adding to an archived tenant — refused.
  await ctx.tenants.archiveTenant("globex");
  await assert.rejects(ctx.tenants.addDomain("globex", "fresh.globex.com"),
    /archived/);
}

async function _setPrimaryDomainUniqueness() {
  var ctx = _setup();
  var t = await ctx.tenants.defineTenant(_validDefine());
  // Two alts.
  await ctx.tenants.addDomain("acme", "store.acme.com");
  await ctx.tenants.addDomain("acme", "shop-alt.acme.com");
  check("baseline primary",                           t.primary_domain === "shop.acme.com");

  // Promote `store.acme.com` to primary; previous primary demotes.
  var swapped = await ctx.tenants.setPrimaryDomain("acme", "store.acme.com");
  check("setPrimaryDomain promotes target",           swapped.primary_domain === "store.acme.com");
  // Exactly one primary in the hydrated domains array.
  var primaries = swapped.domains.filter(function (d) { return d.is_primary; });
  check("exactly one primary after swap",             primaries.length === 1);
  check("alt list contains old primary",              swapped.alt_domains.indexOf("shop.acme.com") !== -1);
  check("alt list contains untouched alt",            swapped.alt_domains.indexOf("shop-alt.acme.com") !== -1);
  check("alt list excludes promoted domain",          swapped.alt_domains.indexOf("store.acme.com") === -1);

  // Re-promote a domain that's already primary — idempotent.
  var noop = await ctx.tenants.setPrimaryDomain("acme", "store.acme.com");
  var primariesAfter = noop.domains.filter(function (d) { return d.is_primary; });
  check("setPrimaryDomain idempotent",                primariesAfter.length === 1 && primariesAfter[0].domain === "store.acme.com");

  // Refusals.
  await assert.rejects(ctx.tenants.setPrimaryDomain("acme", "never-added.acme.com"),
    /not registered to tenant/);
  await assert.rejects(ctx.tenants.setPrimaryDomain("nope", "shop.acme.com"),
    /tenant 'nope' not found/);
  await assert.rejects(ctx.tenants.setPrimaryDomain("acme", "bad"), /domain/);

  // removeDomain on the (new) primary refused; on an alt succeeds.
  await assert.rejects(ctx.tenants.removeDomain("acme", "store.acme.com"),
    /primary domain/);
  var afterRemove = await ctx.tenants.removeDomain("acme", "shop-alt.acme.com");
  check("removeDomain succeeds for alt",              afterRemove.alt_domains.indexOf("shop-alt.acme.com") === -1);
  await assert.rejects(ctx.tenants.removeDomain("acme", "never-added.acme.com"),
    /not registered/);
}

async function _resolveByHostNearestMatch() {
  var ctx = _setup();
  await ctx.tenants.defineTenant(_validDefine());
  await ctx.tenants.defineTenant(_validDefine({
    slug:           "globex",
    primary_domain: "shop.globex.com",
    alt_domains:    ["www.globex.com", "globex.example.io"],
  }));
  await ctx.tenants.defineTenant(_validDefine({
    slug:           "pausedshop",
    primary_domain: "shop.pausedshop.com",
    alt_domains:    [],
  }));
  await ctx.tenants.pauseTenant("pausedshop");

  // Exact primary match resolves.
  var r1 = await ctx.tenants.resolveByHost("shop.acme.com");
  check("resolveByHost: primary -> tenant",           r1 && r1.slug === "acme");

  // Alt-domain match resolves to the owning tenant.
  var r2 = await ctx.tenants.resolveByHost("www.acme.com");
  check("resolveByHost: alt -> tenant",               r2 && r2.slug === "acme");
  // Even a different tenant's alt resolves correctly.
  var r3 = await ctx.tenants.resolveByHost("globex.example.io");
  check("resolveByHost: cross-tenant alt -> right tenant", r3 && r3.slug === "globex");

  // Case folding on host.
  var r4 = await ctx.tenants.resolveByHost("SHOP.ACME.COM");
  check("resolveByHost lowercases host",              r4 && r4.slug === "acme");

  // Port suffix stripped.
  var r5 = await ctx.tenants.resolveByHost("shop.acme.com:8787");
  check("resolveByHost strips :port",                 r5 && r5.slug === "acme");

  // No match -> null.
  var r6 = await ctx.tenants.resolveByHost("unknown.example.com");
  check("resolveByHost: no match -> null",            r6 === null);

  // Junk host -> null (not a stack trace, request hot path).
  var r7 = await ctx.tenants.resolveByHost("");
  check("resolveByHost: empty -> null",               r7 === null);
  var r8 = await ctx.tenants.resolveByHost("not a host");
  check("resolveByHost: junk -> null",                r8 === null);
  var r9 = await ctx.tenants.resolveByHost(null);
  check("resolveByHost: null host -> null",           r9 === null);

  // Paused tenant DOES resolve (operator wants to render the
  // unavailable page rather than a 404).
  var rPaused = await ctx.tenants.resolveByHost("shop.pausedshop.com");
  check("resolveByHost: paused tenant resolves",      rPaused && rPaused.slug === "pausedshop" && rPaused.status === "paused");

  // Archive globex — its domains stop resolving.
  await ctx.tenants.archiveTenant("globex");
  var rArchived = await ctx.tenants.resolveByHost("shop.globex.com");
  check("resolveByHost: archived tenant -> null",     rArchived === null);
  var rArchivedAlt = await ctx.tenants.resolveByHost("www.globex.com");
  check("resolveByHost: archived alt -> null",        rArchivedAlt === null);
}

async function _fsmTransitions() {
  var ctx = _setup();
  var t = await ctx.tenants.defineTenant(_validDefine());
  check("opens active",                               t.status === "active");

  // active -> paused stamps paused_at.
  var paused = await ctx.tenants.pauseTenant("acme");
  check("active -> paused",                           paused.status === "paused");
  check("pause stamps paused_at",                     typeof paused.paused_at === "number" && paused.paused_at > 0);

  // pause on already-paused is idempotent (no FSM violation).
  var pausedAgain = await ctx.tenants.pauseTenant("acme");
  check("pause idempotent on paused",                 pausedAgain.status === "paused");

  // paused -> active clears paused_at.
  var resumed = await ctx.tenants.resumeTenant("acme");
  check("paused -> active",                           resumed.status === "active");
  check("resume clears paused_at",                    resumed.paused_at === null);

  // resume on already-active is idempotent.
  var resumedAgain = await ctx.tenants.resumeTenant("acme");
  check("resume idempotent on active",                resumedAgain.status === "active");

  // active|paused -> archived stamps archived_at; terminal.
  var archived = await ctx.tenants.archiveTenant("acme");
  check("active -> archived",                         archived.status === "archived");
  check("archive stamps archived_at",                 typeof archived.archived_at === "number" && archived.archived_at > 0);

  // archive on archived is idempotent.
  var archivedAgain = await ctx.tenants.archiveTenant("acme");
  check("archive idempotent on archived",             archivedAgain.status === "archived");

  // archived -> paused refused.
  await assert.rejects(ctx.tenants.pauseTenant("acme"),  /archived/);
  // archived -> active refused.
  await assert.rejects(ctx.tenants.resumeTenant("acme"), /archived/);
  // update on archived refused.
  await assert.rejects(ctx.tenants.update("acme", { name: "Renamed" }), /archived/);

  // Unknown tenant on FSM ops -> null (not throw).
  var nullPause = await ctx.tenants.pauseTenant("nope");
  check("pause unknown -> null",                      nullPause === null);
  var nullResume = await ctx.tenants.resumeTenant("nope");
  check("resume unknown -> null",                     nullResume === null);
  var nullArchive = await ctx.tenants.archiveTenant("nope");
  check("archive unknown -> null",                    nullArchive === null);
}

async function _listAndStats() {
  var ctx = _setup();
  await ctx.tenants.defineTenant(_validDefine());
  await ctx.tenants.defineTenant(_validDefine({
    slug:           "globex",
    primary_domain: "shop.globex.com",
    alt_domains:    ["www.globex.com"],
  }));
  await ctx.tenants.defineTenant(_validDefine({
    slug:           "archivedshop",
    primary_domain: "shop.archivedshop.com",
    alt_domains:    [],
  }));
  await ctx.tenants.pauseTenant("globex");
  await ctx.tenants.archiveTenant("archivedshop");

  var all = await ctx.tenants.listTenants();
  check("listTenants returns all 3",                  all.length === 3);

  var active = await ctx.tenants.listTenants({ status: "active" });
  check("listTenants active filter",                  active.length === 1 && active[0].slug === "acme");
  var pausedList = await ctx.tenants.listTenants({ status: "paused" });
  check("listTenants paused filter",                  pausedList.length === 1 && pausedList[0].slug === "globex");
  var archivedList = await ctx.tenants.listTenants({ status: "archived" });
  check("listTenants archived filter",                archivedList.length === 1 && archivedList[0].slug === "archivedshop");

  await assert.rejects(ctx.tenants.listTenants({ status: "bogus" }), /status/);

  // update on an active tenant patches.
  var patched = await ctx.tenants.update("acme", {
    name:             "Acme Renamed",
    default_currency: "EUR",
    default_locale:   "en-GB",
    theme_slug:       "bold",
  });
  check("update patches name",                        patched.name === "Acme Renamed");
  check("update patches currency",                    patched.default_currency === "EUR");
  check("update patches locale",                      patched.default_locale === "en-GB");
  check("update patches theme",                       patched.theme_slug === "bold");

  // Slug is NOT updatable.
  await assert.rejects(ctx.tenants.update("acme", { slug: "renamed-slug" }), /not updatable/);
  // Empty patch.
  await assert.rejects(ctx.tenants.update("acme", {}),                       /at least one column/);
  // Unknown tenant -> null.
  var noop = await ctx.tenants.update("nope", { name: "x" });
  check("update unknown -> null",                     noop === null);

  // stats() rollup.
  var s = await ctx.tenants.stats();
  check("stats active_count",                         s.active_count === 1);
  check("stats paused_count",                         s.paused_count === 1);
  check("stats archived_count",                       s.archived_count === 1);
  // acme (primary + www) = 2 + globex (primary + www) = 2 +
  // archivedshop (primary only) = 1  ->  5 total.
  check("stats total_domains sums correctly",         s.total_domains === 5);
  check("stats per_tenant length",                    s.per_tenant.length === 3);
  var acmeRow = s.per_tenant.filter(function (r) { return r.slug === "acme"; })[0];
  check("stats per_tenant acme domain_count",         acmeRow && acmeRow.domain_count === 2);
  var globexRow = s.per_tenant.filter(function (r) { return r.slug === "globex"; })[0];
  check("stats per_tenant globex domain_count",       globexRow && globexRow.domain_count === 2);
  check("stats per_tenant globex status reflects FSM", globexRow.status === "paused");
}

async function run() {
  await _defineTenantHappyPath();
  await _defineTenantRefusals();
  await _addDomainUniqueRefusal();
  await _setPrimaryDomainUniqueness();
  await _resolveByHostNearestMatch();
  await _fsmTransitions();
  await _listAndStats();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/tenants.test.js`.
if (require.main === module) {
  // Touch the bShop framework export so a missing-vendor regression
  // surfaces as the operator-friendly message rather than a stack on
  // first guardUuid.sanitize() call.
  void bShop.framework;
  run().then(
    function () {
      console.log("ok - tenants (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
