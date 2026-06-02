"use strict";
/**
 * locale-router — storefront locale routing via URL prefix /
 * subdomain / cookie / Accept-Language / customer preference, with
 * fallback chains against migration 0139's schema.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0139.
 *
 * Coverage:
 *   - defineLocale across kinds (primary / regional / variant) +
 *     fallback chain validation
 *   - definePolicy for every strategy in the enum
 *   - resolveLocale precedence:
 *       customer preference -> URL prefix -> subdomain -> cookie ->
 *       Accept-Language -> policy default
 *   - setCustomerLocale overrides every other hint
 *   - fallback chain: a candidate locale not in supported_locales
 *     walks the catalog fallback chain until it lands on one that is
 *   - setActivePolicy / activePolicy invariants (only one active)
 *   - archivePolicy idempotence + active demotion
 *   - localePopularity audit + validation surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var localeRouter = require("../../lib/locale-router");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0139_locale_router.sql");

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
  return {
    db:    db,
    query: async function (sql, params) {
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
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:     h.db,
    query:  h.query,
    router: localeRouter.create({ query: h.query }),
  };
}

// Seed a small but realistic locale catalog. Used by every
// resolve-path test that doesn't otherwise mutate the catalog.
async function _seedCatalog(router) {
  await router.defineLocale({ tag: "en",    kind: "primary",  currency: "USD", active: true });
  await router.defineLocale({ tag: "en-US", kind: "regional", currency: "USD", active: true, fallback: "en" });
  await router.defineLocale({ tag: "en-GB", kind: "regional", currency: "GBP", active: true, fallback: "en" });
  await router.defineLocale({ tag: "de",    kind: "primary",  currency: "EUR", active: true });
  await router.defineLocale({ tag: "de-DE", kind: "regional", currency: "EUR", active: true, fallback: "de" });
  await router.defineLocale({ tag: "de-AT", kind: "regional", currency: "EUR", active: true, fallback: "de" });
  await router.defineLocale({ tag: "fr",    kind: "primary",  currency: "EUR", active: true });
  await router.defineLocale({ tag: "fr-CA", kind: "regional", currency: "CAD", active: true, fallback: "fr" });
  await router.defineLocale({ tag: "zh-Hans", kind: "variant", currency: "CNY", active: true });
}

// ---- tests --------------------------------------------------------------

async function _defineLocaleAcrossKinds() {
  var f = _factory();

  var en = await f.router.defineLocale({
    tag: "en", kind: "primary", currency: "USD", active: true,
  });
  check("defineLocale primary shape",       en.tag === "en"
                                              && en.kind === "primary"
                                              && en.currency === "USD"
                                              && en.fallback === null
                                              && en.active === true
                                              && en.archived_at === null);
  check("defineLocale created_at",          typeof en.created_at === "number" && en.created_at > 0);
  check("defineLocale updated_at",          typeof en.updated_at === "number" && en.updated_at >= en.created_at);

  var enUs = await f.router.defineLocale({
    tag: "en-US", kind: "regional", currency: "USD", active: true, fallback: "en",
  });
  check("defineLocale regional fallback",   enUs.kind === "regional" && enUs.fallback === "en");

  var zh = await f.router.defineLocale({
    tag: "zh-Hans", kind: "variant", currency: "CNY", active: true,
  });
  check("defineLocale variant",             zh.kind === "variant" && zh.tag === "zh-Hans");

  // Fallback referencing an unknown locale refuses.
  await assert.rejects(
    f.router.defineLocale({ tag: "es", kind: "primary", currency: "EUR", active: true, fallback: "xx" }),
    /does not reference a known locale/
  );

  // Self-loop fallback refuses.
  await assert.rejects(
    f.router.defineLocale({ tag: "it", kind: "primary", currency: "EUR", active: true, fallback: "it" }),
    /cannot equal tag/
  );

  // Bad kind refuses.
  await assert.rejects(
    f.router.defineLocale({ tag: "es", kind: "weird", currency: "EUR", active: true }),
    /kind must be one of/
  );

  // Bad locale tag refuses.
  await assert.rejects(
    f.router.defineLocale({ tag: "!!", kind: "primary", currency: "USD", active: true }),
    /BCP-47 language tag/
  );

  // Bad currency refuses.
  await assert.rejects(
    f.router.defineLocale({ tag: "es", kind: "primary", currency: "eur", active: true }),
    /ISO 4217/
  );

  // listLocales sorted by tag.
  var list = await f.router.listLocales({});
  check("listLocales sorted",               list.length === 3
                                              && list[0].tag === "en"
                                              && list[1].tag === "en-US"
                                              && list[2].tag === "zh-Hans");

  // getLocale round trip.
  var rt = await f.router.getLocale("en");
  check("getLocale round trip",             rt && rt.tag === "en" && rt.currency === "USD");

  // Re-define refreshes in place (monotonic updated_at).
  var en2 = await f.router.defineLocale({
    tag: "en", kind: "primary", currency: "USD", active: false,
  });
  check("re-define archives by active flag", en2.active === false && en2.archived_at !== null);

  // Re-activate by re-defining with active: true.
  var en3 = await f.router.defineLocale({
    tag: "en", kind: "primary", currency: "USD", active: true,
  });
  check("re-define reactivates",            en3.active === true && en3.archived_at === null);
}

async function _definePolicyPerStrategy() {
  var f = _factory();
  await _seedCatalog(f.router);

  // Every strategy in the enum gets a policy.
  var urlPrefix = await f.router.definePolicy({
    slug: "url",
    strategy: "url_prefix",
    default_locale: "en",
    supported_locales: ["en", "en-US", "de", "fr"],
  });
  check("definePolicy url_prefix shape",    urlPrefix.slug === "url"
                                              && urlPrefix.strategy === "url_prefix"
                                              && urlPrefix.default_locale === "en"
                                              && urlPrefix.supported_locales.length === 4
                                              && urlPrefix.is_active === false
                                              && urlPrefix.archived_at === null);

  await f.router.definePolicy({
    slug: "sub", strategy: "subdomain",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });
  await f.router.definePolicy({
    slug: "cookie", strategy: "cookie",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });
  await f.router.definePolicy({
    slug: "alonly", strategy: "accept_language_only",
    default_locale: "en", supported_locales: ["en", "de"],
  });
  await f.router.definePolicy({
    slug: "cust", strategy: "customer_preference",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });

  var listed = await f.router.listPolicies({});
  check("listPolicies count",               listed.length === 5);

  // default_locale must appear in supported_locales.
  await assert.rejects(
    f.router.definePolicy({
      slug: "bad", strategy: "url_prefix",
      default_locale: "es", supported_locales: ["en", "de"],
    }),
    /must appear in supported_locales/
  );

  // Unknown supported entry refuses.
  await assert.rejects(
    f.router.definePolicy({
      slug: "bad2", strategy: "url_prefix",
      default_locale: "en", supported_locales: ["en", "xx"],
    }),
    /does not reference a known locale/
  );

  // Bad strategy refuses.
  await assert.rejects(
    f.router.definePolicy({
      slug: "bad3", strategy: "weird",
      default_locale: "en", supported_locales: ["en"],
    }),
    /strategy must be one of/
  );

  // Bad slug refuses.
  await assert.rejects(
    f.router.definePolicy({
      slug: "Bad Slug!", strategy: "url_prefix",
      default_locale: "en", supported_locales: ["en"],
    }),
    /slug/
  );

  // Duplicate supported entries refuse.
  await assert.rejects(
    f.router.definePolicy({
      slug: "dupes", strategy: "url_prefix",
      default_locale: "en", supported_locales: ["en", "en"],
    }),
    /duplicate/
  );
}

async function _resolveLocalePrecedence() {
  var f = _factory();
  await _seedCatalog(f.router);
  await f.router.definePolicy({
    slug: "main", strategy: "url_prefix",
    default_locale: "en", supported_locales: ["en", "en-US", "de", "de-DE", "fr", "fr-CA"],
  });
  await f.router.setActivePolicy("main");

  // 1. URL prefix wins over Accept-Language.
  var r1 = await f.router.resolveLocale({
    request: {
      host: "example.com",
      path: "/de/about",
      accept_language: "fr-FR,fr;q=0.9,en;q=0.5",
    },
  });
  check("url_prefix wins",                  r1.locale === "de" && r1.source === "url_prefix");
  check("url_prefix canonical present",     typeof r1.canonical_url === "string"
                                              && r1.canonical_url.indexOf("/de/") !== -1);

  // 2. fr-CA prefix exact match.
  var r2 = await f.router.resolveLocale({
    request: { host: "example.com", path: "/fr-ca/produits" },
  });
  check("url_prefix fr-CA match",           r2.locale === "fr-CA" && r2.source === "url_prefix");
  check("fr-CA canonical lowercased",       r2.canonical_url.indexOf("/fr-ca/") !== -1);

  // 3. No URL prefix -> Accept-Language fallback.
  var r3 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/about",
      accept_language: "de-DE,de;q=0.9,en;q=0.5",
    },
  });
  check("accept_language fallback",         r3.locale === "de-DE" && r3.source === "accept_language");

  // 4. No prefix, no AL -> policy default.
  var r4 = await f.router.resolveLocale({
    request: { host: "example.com", path: "/about" },
  });
  check("default fallback",                 r4.locale === "en" && r4.source === "default");

  // 5. URL prefix tag NOT in supported_locales falls through to AL.
  var r5 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/es/about",
      accept_language: "de;q=0.9",
    },
  });
  check("unsupported prefix -> AL",         r5.locale === "de" && r5.source === "accept_language");

  // 6. subdomain strategy.
  await f.router.definePolicy({
    slug: "subpol", strategy: "subdomain",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });
  await f.router.setActivePolicy("subpol");
  var r6 = await f.router.resolveLocale({
    request: { host: "de.example.com", path: "/about" },
  });
  check("subdomain resolved",               r6.locale === "de" && r6.source === "subdomain");
  check("subdomain canonical",              r6.canonical_url.indexOf("de.example.com") !== -1);

  // www.example.com is NOT a locale subdomain — falls to default.
  var r7 = await f.router.resolveLocale({
    request: { host: "www.example.com", path: "/" },
  });
  check("www not a locale",                 r7.locale === "en" && r7.source === "default");

  // 7. cookie strategy.
  await f.router.definePolicy({
    slug: "cookpol", strategy: "cookie",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });
  await f.router.setActivePolicy("cookpol");
  var r8 = await f.router.resolveLocale({
    request: { host: "example.com", path: "/about", cookie_locale: "fr" },
  });
  check("cookie resolved",                  r8.locale === "fr" && r8.source === "cookie");
  check("cookie no canonical url",          r8.canonical_url === undefined);

  // Garbage cookie value -> falls through.
  var r9 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/about",
      cookie_locale: "!!", accept_language: "de;q=1.0",
    },
  });
  check("bad cookie -> AL",                 r9.locale === "de" && r9.source === "accept_language");

  // 8. accept_language_only — URL prefix ignored.
  await f.router.definePolicy({
    slug: "alonly", strategy: "accept_language_only",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });
  await f.router.setActivePolicy("alonly");
  var r10 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/de/about",
      accept_language: "fr;q=0.9",
    },
  });
  check("AL-only ignores URL prefix",       r10.locale === "fr" && r10.source === "accept_language");
}

async function _setCustomerLocaleOverrides() {
  var f = _factory();
  await _seedCatalog(f.router);
  await f.router.definePolicy({
    slug: "main", strategy: "url_prefix",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });
  await f.router.setActivePolicy("main");

  // Set a pref for customer "alice".
  var pref = await f.router.setCustomerLocale({
    customer_id: "alice", locale: "fr",
  });
  check("setCustomerLocale shape",          pref.customer_id === "alice"
                                              && pref.locale === "fr"
                                              && typeof pref.set_at === "number"
                                              && pref.set_at > 0);

  // Customer pref wins over URL prefix.
  var r1 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/de/about", customer_id: "alice",
    },
  });
  check("customer pref beats URL prefix",   r1.locale === "fr" && r1.source === "customer_preference");

  // Customer pref wins over Accept-Language.
  var r2 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/", customer_id: "alice",
      accept_language: "de;q=0.9",
    },
  });
  check("customer pref beats AL",           r2.locale === "fr" && r2.source === "customer_preference");

  // Anonymous (no customer_id) — URL prefix wins.
  var r3 = await f.router.resolveLocale({
    request: { host: "example.com", path: "/de/about" },
  });
  check("anon URL prefix wins",             r3.locale === "de" && r3.source === "url_prefix");

  // Update existing pref — round trip and monotonic updated_at.
  var pref2 = await f.router.setCustomerLocale({
    customer_id: "alice", locale: "de",
  });
  check("setCustomerLocale update",         pref2.locale === "de" && pref2.updated_at >= pref.updated_at);

  // getCustomerLocale round trip.
  var got = await f.router.getCustomerLocale("alice");
  check("getCustomerLocale",                got.locale === "de");

  // clearCustomerLocale.
  var cleared = await f.router.clearCustomerLocale("alice");
  check("clearCustomerLocale",              cleared.cleared === true && cleared.customer_id === "alice");
  var none = await f.router.getCustomerLocale("alice");
  check("getCustomerLocale post-clear",     none === null);

  // setCustomerLocale to an unknown locale refuses.
  await assert.rejects(
    f.router.setCustomerLocale({ customer_id: "bob", locale: "xx" }),
    /does not reference a known locale/
  );

  // Bad customer_id refuses.
  await assert.rejects(
    f.router.setCustomerLocale({ customer_id: "!!bad!!", locale: "en" }),
    /customer_id/
  );

  // Customer pref to an UNSUPPORTED locale (not in active policy
  // supported_locales) — falls through to next resolution step.
  await f.router.setCustomerLocale({ customer_id: "carol", locale: "fr-CA" });
  // fr-CA is in the catalog but not in this policy's supported list.
  // The fallback chain on fr-CA -> fr is in the supported list, so
  // resolution lands on fr.
  var r4 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/", customer_id: "carol",
      accept_language: "de;q=0.9",
    },
  });
  check("cust pref fallback chain",         r4.locale === "fr" && r4.source === "customer_preference");
}

async function _fallbackChainWalk() {
  var f = _factory();
  await _seedCatalog(f.router);

  // Policy supports only "en" and "de" (the primary tags). A
  // request for de-AT must walk the fallback chain to "de".
  await f.router.definePolicy({
    slug: "p", strategy: "accept_language_only",
    default_locale: "en", supported_locales: ["en", "de"],
  });
  await f.router.setActivePolicy("p");

  // de-AT -> fallback -> de (supported). Tests the explicit
  // fallback column walk.
  var r1 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/",
      accept_language: "de-AT,de-DE;q=0.5",
    },
  });
  check("de-AT primary subtag match",       r1.locale === "de");

  // en-GB -> primary subtag match against "en".
  var r2 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/",
      accept_language: "en-GB,fr;q=0.5",
    },
  });
  check("en-GB primary subtag match",       r2.locale === "en");

  // A locale not in catalog at all, not matching any primary subtag,
  // walks to policy default.
  var r3 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/",
      accept_language: "ja;q=0.9",
    },
  });
  check("ja -> default",                    r3.locale === "en" && r3.source === "default");

  // Q-sorting respected — lower-q de wins over higher-q ja since ja
  // doesn't resolve.
  var r4 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/",
      accept_language: "ja;q=0.9,de;q=0.5",
    },
  });
  check("q-sort with miss",                 r4.locale === "de" && r4.source === "accept_language");

  // Wildcard "*" silently dropped — falls through.
  var r5 = await f.router.resolveLocale({
    request: {
      host: "example.com", path: "/",
      accept_language: "*,de;q=0.5",
    },
  });
  check("wildcard dropped",                 r5.locale === "de" && r5.source === "accept_language");
}

async function _setActivePolicyInvariants() {
  var f = _factory();
  await _seedCatalog(f.router);

  await f.router.definePolicy({
    slug: "a", strategy: "url_prefix",
    default_locale: "en", supported_locales: ["en", "de"],
  });
  await f.router.definePolicy({
    slug: "b", strategy: "cookie",
    default_locale: "en", supported_locales: ["en", "fr"],
  });

  // No active policy initially.
  var none = await f.router.activePolicy();
  check("activePolicy initially null",      none === null);

  // resolveLocale with no active policy refuses.
  await assert.rejects(
    f.router.resolveLocale({ request: { host: "example.com", path: "/" } }),
    /no active policy/
  );

  // Activate a.
  var a = await f.router.setActivePolicy("a");
  check("setActivePolicy a",                a.is_active === true);

  var activeA = await f.router.activePolicy();
  check("activePolicy returns a",           activeA.slug === "a");

  // Flip to b — a demotes automatically.
  await f.router.setActivePolicy("b");
  var activeB = await f.router.activePolicy();
  check("activePolicy now b",               activeB.slug === "b");
  var aRefreshed = await f.router.getPolicy("a");
  check("a demoted",                        aRefreshed.is_active === false);

  // Activating unknown slug refuses.
  await assert.rejects(
    f.router.setActivePolicy("nope"),
    /no policy exists/
  );

  // Archiving the active policy clears is_active.
  var arc = await f.router.archivePolicy("b");
  check("archivePolicy clears active",      arc.is_active === false && arc.archived_at !== null);

  // Idempotent re-archive.
  var arc2 = await f.router.archivePolicy("b");
  check("re-archive idempotent",            arc2.is_active === false);

  // Activating archived policy refuses.
  await assert.rejects(
    f.router.setActivePolicy("b"),
    /archived/
  );

  // listPolicies default excludes archived.
  var defaultList = await f.router.listPolicies({});
  check("default list excludes archived",   defaultList.length === 1 && defaultList[0].slug === "a");

  // listPolicies({ include_archived: true }) includes b.
  var allList = await f.router.listPolicies({ include_archived: true });
  check("list with archived",               allList.length === 2);

  // archivePolicy on unknown slug refuses.
  await assert.rejects(
    f.router.archivePolicy("nope"),
    /no policy exists/
  );
}

async function _localePopularityAudit() {
  var f = _factory();
  await _seedCatalog(f.router);
  await f.router.definePolicy({
    slug: "main", strategy: "url_prefix",
    default_locale: "en", supported_locales: ["en", "de", "fr"],
  });
  await f.router.setActivePolicy("main");

  // Fire a known mix of resolutions.
  await f.router.resolveLocale({ request: { host: "example.com", path: "/de/" } });
  await f.router.resolveLocale({ request: { host: "example.com", path: "/de/x" } });
  await f.router.resolveLocale({ request: { host: "example.com", path: "/de/y" } });
  await f.router.resolveLocale({ request: { host: "example.com", path: "/fr/" } });
  await f.router.resolveLocale({ request: { host: "example.com", path: "/" } });

  var pop = await f.router.localePopularity({});
  check("popularity captures all",          pop.length === 3);
  // Newest aggregation: de=3, fr=1, en=1 (en from default).
  check("popularity de=3 highest",          pop[0].locale === "de" && pop[0].hits === 3);
  // Tie between en and fr at 1; tiebreak alphabetical (en before fr).
  check("popularity en before fr",          pop[1].locale === "en" && pop[1].hits === 1
                                              && pop[2].locale === "fr" && pop[2].hits === 1);

  // Window filter — `to=0` excludes everything.
  var empty = await f.router.localePopularity({ to: 0 });
  check("popularity empty window",          empty.length === 0);

  // Validation
  await assert.rejects(f.router.localePopularity(),                                   /input object required/);
  await assert.rejects(f.router.localePopularity({ from: -1 }),                       /from/);
  await assert.rejects(f.router.localePopularity({ to: "bad" }),                      /to/);
  await assert.rejects(f.router.localePopularity({ from: 100, to: 50 }),              /from must be <= to/);
  await assert.rejects(f.router.localePopularity({ limit: 0 }),                       /limit/);
}

async function _validationSurface() {
  var f = _factory();

  // defineLocale
  await assert.rejects(f.router.defineLocale(),                                              /input object required/);
  await assert.rejects(f.router.defineLocale({ tag: "en", kind: "primary", currency: "USD" }), /active/);

  // definePolicy
  await assert.rejects(f.router.definePolicy(),                                              /input object required/);

  // resolveLocale validation
  await assert.rejects(f.router.resolveLocale(),                                             /input object required/);
  await assert.rejects(f.router.resolveLocale({ request: null }),                            /request object required/);
  await assert.rejects(
    f.router.resolveLocale({ request: { host: "example.com", path: "noslash" } }),
    /must start with/
  );
  await assert.rejects(
    f.router.resolveLocale({ request: { host: "BAD HOST!", path: "/" } }),
    /valid hostname/
  );
  await assert.rejects(
    f.router.resolveLocale({ request: { host: "example.com", path: "/", accept_language: 42 } }),
    /accept_language/
  );

  // setCustomerLocale
  await assert.rejects(f.router.setCustomerLocale(),                                         /input object required/);
  await assert.rejects(f.router.setCustomerLocale({ customer_id: "x" }),                     /locale/);

  // setActivePolicy
  await assert.rejects(f.router.setActivePolicy("BAD!!"),                                    /slug/);

  // listLocales
  await assert.rejects(f.router.listLocales({ active_only: "yes" }),                         /active_only/);
  await assert.rejects(f.router.listLocales({ limit: 0 }),                                   /limit/);

  // listPolicies
  await assert.rejects(f.router.listPolicies({ include_archived: "yes" }),                   /include_archived/);

  // create factory
  assert.throws(function () { localeRouter.create({ query: "not a fn" }); },                 /query must be a function/);
}

async function _exportedConstants() {
  check("KINDS exported",                   Array.isArray(localeRouter.KINDS)
                                              && localeRouter.KINDS.indexOf("primary")  !== -1
                                              && localeRouter.KINDS.indexOf("regional") !== -1
                                              && localeRouter.KINDS.indexOf("variant")  !== -1);
  check("STRATEGIES exported",              Array.isArray(localeRouter.STRATEGIES)
                                              && localeRouter.STRATEGIES.indexOf("url_prefix")           !== -1
                                              && localeRouter.STRATEGIES.indexOf("subdomain")            !== -1
                                              && localeRouter.STRATEGIES.indexOf("cookie")               !== -1
                                              && localeRouter.STRATEGIES.indexOf("accept_language_only") !== -1
                                              && localeRouter.STRATEGIES.indexOf("customer_preference")  !== -1);
  check("LOCALE_RE exported",               localeRouter.LOCALE_RE instanceof RegExp);
  check("CURRENCY_RE exported",             localeRouter.CURRENCY_RE instanceof RegExp);

  var inst = localeRouter.create({ query: _makeQuery().query });
  check("instance KINDS",                   inst.KINDS.length === 3);
  check("instance STRATEGIES",              inst.STRATEGIES.length === 5);
}

// alternateUrls — the hreflang alternate set for the active URL-shaped
// policy. Composes _canonicalForUrl; returns null for non-URL strategies,
// a single-locale policy, no active policy, or a malformed host/path (a
// request-shape reader — never throws on bad input).
async function _alternateUrlsHelper() {
  // url_prefix: a leading locale segment is swapped per supported locale.
  var fp = _factory();
  await _seedCatalog(fp.router);
  await fp.router.definePolicy({
    slug: "main", strategy: "url_prefix", default_locale: "en",
    supported_locales: ["en", "de", "fr"],
  });
  await fp.router.setActivePolicy("main");

  var up = await fp.router.alternateUrls("shop.example", "/de/about");
  check("alternateUrls url_prefix not null",   up !== null);
  check("alternateUrls default_locale",        up.default_locale === "en");
  check("alternateUrls x_default_url",          up.x_default_url === "https://shop.example/en/about");
  var byTag = {};
  up.alternates.forEach(function (a) { byTag[a.tag] = a.href; });
  check("alternateUrls en href",               byTag.en === "https://shop.example/en/about");
  check("alternateUrls de href (segment swap)", byTag.de === "https://shop.example/de/about");
  check("alternateUrls fr href",               byTag.fr === "https://shop.example/fr/about");
  // A path with no leading locale segment prepends the locale.
  var upNoSeg = await fp.router.alternateUrls("shop.example", "/about");
  var byTag2 = {};
  upNoSeg.alternates.forEach(function (a) { byTag2[a.tag] = a.href; });
  check("alternateUrls url_prefix prepend",    byTag2.de === "https://shop.example/de/about");

  // subdomain: the leftmost locale subdomain is swapped per supported tag.
  var fs2 = _factory();
  await _seedCatalog(fs2.router);
  await fs2.router.definePolicy({
    slug: "sub", strategy: "subdomain", default_locale: "en",
    supported_locales: ["en", "de"],
  });
  await fs2.router.setActivePolicy("sub");
  var sd = await fs2.router.alternateUrls("de.shop.example", "/about");
  check("alternateUrls subdomain not null",    sd !== null);
  var sdByTag = {};
  sd.alternates.forEach(function (a) { sdByTag[a.tag] = a.href; });
  check("alternateUrls subdomain en host swap", sdByTag.en === "https://en.shop.example/about");
  check("alternateUrls subdomain de host swap", sdByTag.de === "https://de.shop.example/about");
  check("alternateUrls subdomain x_default",    sd.x_default_url === "https://en.shop.example/about");

  // cookie strategy → null (no URL-shaped alternates).
  var fc = _factory();
  await _seedCatalog(fc.router);
  await fc.router.definePolicy({
    slug: "ck", strategy: "cookie", default_locale: "en",
    supported_locales: ["en", "de"],
  });
  await fc.router.setActivePolicy("ck");
  check("alternateUrls cookie strategy → null", (await fc.router.alternateUrls("shop.example", "/about")) === null);

  // malformed host → null, no throw.
  check("alternateUrls malformed host → null",  (await fp.router.alternateUrls("not a host!!", "/about")) === null);
  // malformed path → null, no throw.
  check("alternateUrls malformed path → null",  (await fp.router.alternateUrls("shop.example", "no-leading-slash")) === null);

  // no active policy → null.
  var fn = _factory();
  await _seedCatalog(fn.router);
  check("alternateUrls no active policy → null", (await fn.router.alternateUrls("shop.example", "/about")) === null);
}

async function run() {
  await _defineLocaleAcrossKinds();
  await _definePolicyPerStrategy();
  await _resolveLocalePrecedence();
  await _setCustomerLocaleOverrides();
  await _fallbackChainWalk();
  await _setActivePolicyInvariants();
  await _localePopularityAudit();
  await _validationSurface();
  await _exportedConstants();
  await _alternateUrlsHelper();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - locale-router (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
