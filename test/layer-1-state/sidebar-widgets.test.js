"use strict";
/**
 * sidebar-widgets — operator-curated storefront sidebar widgets.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0176.
 *
 * Coverage:
 *   - defineWidget: persists row per kind, refuses bad payload shape,
 *     refuses audience/segment mismatch, refuses kind swap on
 *     same-slug re-define, idempotent on same-slug update
 *   - setPagePlacement: atomic replace of page's ordered widget list,
 *     refuses unknown / archived widget, refuses duplicate slugs
 *   - widgetsForPage: ordered placement returned, schedule window +
 *     archived gate respected, audience filter (all/logged_in/guest/
 *     segment) honoured, segment audience requires customerSegments
 *   - recordImpression / recordClick: drop-silent on bad input,
 *     append-only ledger insert, archived widget drops silently
 *   - metricsForWidget: impressions/clicks/CTR + per-page breakdown,
 *     from/to bounds, empty case returns zeros
 *   - listWidgets: kind + audience + include_archived filters
 *   - updateWidget: payload re-validates against immutable kind,
 *     audience/segment_slug joint invariant
 *   - archiveWidget: soft-retire, idempotent on already-archived
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var sidebarWidgets = require("../../lib/sidebar-widgets");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_SIDEBAR = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0176_sidebar_widgets.sql");

function _splitSchema(text) {
  // Strip line comments before splitting on `;` so a `--` line
  // doesn't comment out the closing paren of a CREATE TABLE.
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_SIDEBAR, "utf8")).forEach(function (s) {
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

function _factory(extra) {
  extra = extra || {};
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    sw:    sidebarWidgets.create(Object.assign({ query: h.query }, extra)),
  };
}

function _baseDefine(slug, overrides) {
  var base = {
    slug:       slug,
    title:      "Title for " + slug,
    kind:       "newsletter_signup",
    payload:    { list_id: "main_list", headline: "Subscribe", cta_label: "Join" },
    audience:   "all",
    priority:   0,
    starts_at:  1000,
    expires_at: 1000000,
  };
  if (overrides) {
    Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
  }
  return base;
}

// ---- defineWidget shape -------------------------------------------------

async function _defineWidgetShape() {
  var f = _factory();
  var w = await f.sw.defineWidget(_baseDefine("newsletter"));
  check("defineWidget returns row",         w && w.slug === "newsletter");
  check("defineWidget kind persisted",      w.kind === "newsletter_signup");
  check("defineWidget payload persisted",   w.payload.list_id === "main_list" && w.payload.cta_label === "Join");
  check("defineWidget audience default",    w.audience === "all");
  check("defineWidget timestamps set",      Number.isInteger(w.created_at) && Number.isInteger(w.updated_at));
  check("defineWidget archived_at null",    w.archived_at == null);

  // Same-slug re-define updates atomically; updated_at advances.
  var w2 = await f.sw.defineWidget(_baseDefine("newsletter", {
    title: "Updated title",
    payload: { list_id: "vip_list", headline: "VIP", cta_label: "Join VIP" },
  }));
  check("defineWidget update keeps slug",        w2.slug === "newsletter");
  check("defineWidget update changes title",     w2.title === "Updated title");
  check("defineWidget update changes payload",   w2.payload.list_id === "vip_list");
  check("defineWidget update advances updated",  w2.updated_at >= w.updated_at);

  // Kind swap refused on same slug.
  await assert.rejects(
    f.sw.defineWidget(_baseDefine("newsletter", {
      kind: "trust_badges",
      payload: { badges: ["secure-checkout"] },
    })),
    /cannot change kind/,
  );

  // Different kinds, different payloads.
  var tb = await f.sw.defineWidget(_baseDefine("trust", {
    kind: "trust_badges",
    payload: { badges: ["secure-checkout", "free-returns", "fast-shipping"] },
  }));
  check("trust_badges payload persisted",   tb.payload.badges.length === 3);

  var fc = await f.sw.defineWidget(_baseDefine("featured", {
    kind: "featured_collection",
    payload: { collection_slug: "summer-sale", limit: 6 },
  }));
  check("featured_collection payload",      fc.payload.collection_slug === "summer-sale" && fc.payload.limit === 6);

  var ct = await f.sw.defineWidget(_baseDefine("counter", {
    kind: "countdown_timer",
    payload: { target_at: 99999999, completed_label: "Sale ended" },
  }));
  check("countdown_timer payload",          ct.payload.target_at === 99999999);

  var lv = await f.sw.defineWidget(_baseDefine("visitors", {
    kind: "live_visitors",
    payload: { window_minutes: 30, min_threshold: 5 },
  }));
  check("live_visitors payload",            lv.payload.window_minutes === 30);

  // expires_at must be > starts_at
  await assert.rejects(
    f.sw.defineWidget(_baseDefine("bad-window", { starts_at: 100, expires_at: 100 })),
    /expires_at must be strictly greater/,
  );

  // Bad payload shape for the declared kind.
  await assert.rejects(
    f.sw.defineWidget(_baseDefine("bad-payload", {
      kind: "recently_viewed",
      payload: { limit: 0 },                   // limit must be >= 1
    })),
    /payload\.limit/,
  );
  await assert.rejects(
    f.sw.defineWidget(_baseDefine("bad-payload", {
      kind: "newsletter_signup",
      payload: { list_id: "x", headline: "h", cta_label: "c", surplus: "y" },
    })),
    /payload key/,
  );
}

// ---- audience / segment invariants --------------------------------------

async function _audienceInvariants() {
  var memberships = Object.create(null);
  memberships["cust-vip"] = { vip: true };
  var fakeSegments = {
    isMember: async function (customerId, slug) {
      return !!(memberships[customerId] && memberships[customerId][slug]);
    },
  };
  var f = _factory({ customerSegments: fakeSegments });

  await f.sw.defineWidget(_baseDefine("everyone"));
  await f.sw.defineWidget(_baseDefine("members-only", { audience: "logged_in" }));
  await f.sw.defineWidget(_baseDefine("guests-only",  { audience: "guest" }));
  await f.sw.defineWidget(_baseDefine("vip-only",     {
    audience: "segment", segment_slug: "vip",
  }));

  // audience="segment" requires segment_slug, others refuse it.
  await assert.rejects(
    f.sw.defineWidget(_baseDefine("bad-seg-missing", { audience: "segment" })),
    /requires segment_slug/,
  );
  await assert.rejects(
    f.sw.defineWidget(_baseDefine("bad-seg-extra", { audience: "all", segment_slug: "vip" })),
    /segment_slug only valid/,
  );

  await f.sw.setPagePlacement("home", [
    "everyone", "members-only", "guests-only", "vip-only",
  ]);

  // Guest viewer: sees everyone + guests-only.
  var guestList = await f.sw.widgetsForPage({
    page_key: "home", viewer_kind: "guest", now: 2000,
  });
  var guestSlugs = guestList.map(function (w) { return w.slug; });
  check("guest sees everyone",     guestSlugs.indexOf("everyone") !== -1);
  check("guest sees guests-only",  guestSlugs.indexOf("guests-only") !== -1);
  check("guest hides members",     guestSlugs.indexOf("members-only") === -1);
  check("guest hides vip",         guestSlugs.indexOf("vip-only") === -1);

  // Logged-in non-VIP: sees everyone + members-only.
  var basicList = await f.sw.widgetsForPage({
    page_key: "home", viewer_kind: "logged_in", customer_id: "cust-basic", now: 2000,
  });
  var basicSlugs = basicList.map(function (w) { return w.slug; });
  check("basic sees everyone",     basicSlugs.indexOf("everyone") !== -1);
  check("basic sees members-only", basicSlugs.indexOf("members-only") !== -1);
  check("basic hides guests",      basicSlugs.indexOf("guests-only") === -1);
  check("basic hides vip",         basicSlugs.indexOf("vip-only") === -1);

  // Logged-in VIP: sees everyone + members-only + vip-only.
  var vipList = await f.sw.widgetsForPage({
    page_key: "home", viewer_kind: "logged_in", customer_id: "cust-vip", now: 2000,
  });
  var vipSlugs = vipList.map(function (w) { return w.slug; });
  check("vip sees everyone",       vipSlugs.indexOf("everyone") !== -1);
  check("vip sees members-only",   vipSlugs.indexOf("members-only") !== -1);
  check("vip sees vip-only",       vipSlugs.indexOf("vip-only") !== -1);
  check("vip hides guests",        vipSlugs.indexOf("guests-only") === -1);

  // Order preserved from setPagePlacement.
  check("placement order preserved",
        vipSlugs.indexOf("everyone") < vipSlugs.indexOf("members-only") &&
        vipSlugs.indexOf("members-only") < vipSlugs.indexOf("vip-only"));

  // Without a customerSegments handle, segment-audience widget surfaces a clear error.
  var noSeg = _factory();
  await noSeg.sw.defineWidget(_baseDefine("vip-noh", { audience: "segment", segment_slug: "vip" }));
  await noSeg.sw.setPagePlacement("home", ["vip-noh"]);
  await assert.rejects(
    noSeg.sw.widgetsForPage({
      page_key: "home", viewer_kind: "logged_in", customer_id: "x", now: 2000,
    }),
    /no customerSegments handle/,
  );

  // viewer_kind logged_in requires customer_id; guest must not carry it.
  await assert.rejects(
    f.sw.widgetsForPage({ page_key: "home", viewer_kind: "logged_in", now: 2000 }),
    /requires customer_id/,
  );
  await assert.rejects(
    f.sw.widgetsForPage({
      page_key: "home", viewer_kind: "guest", customer_id: "x", now: 2000,
    }),
    /must not carry customer_id/,
  );
}

// ---- setPagePlacement --------------------------------------------------

async function _setPagePlacementShape() {
  var f = _factory();
  await f.sw.defineWidget(_baseDefine("alpha"));
  await f.sw.defineWidget(_baseDefine("bravo"));
  await f.sw.defineWidget(_baseDefine("charlie"));

  var res = await f.sw.setPagePlacement("pdp:default", ["alpha", "bravo", "charlie"]);
  check("setPagePlacement returns slugs", res.slugs.length === 3 && res.slugs[0] === "alpha");

  var rendered = await f.sw.widgetsForPage({
    page_key: "pdp:default", viewer_kind: "guest", now: 2000,
  });
  check("widgetsForPage returns ordered",
        rendered.length === 3 &&
        rendered[0].slug === "alpha" &&
        rendered[1].slug === "bravo" &&
        rendered[2].slug === "charlie");

  // Replace atomically — old placements gone.
  await f.sw.setPagePlacement("pdp:default", ["charlie", "alpha"]);
  var rendered2 = await f.sw.widgetsForPage({
    page_key: "pdp:default", viewer_kind: "guest", now: 2000,
  });
  check("setPagePlacement replaces atomically",
        rendered2.length === 2 &&
        rendered2[0].slug === "charlie" &&
        rendered2[1].slug === "alpha");

  // Empty array clears the page.
  await f.sw.setPagePlacement("pdp:default", []);
  var rendered3 = await f.sw.widgetsForPage({
    page_key: "pdp:default", viewer_kind: "guest", now: 2000,
  });
  check("setPagePlacement empty clears page", rendered3.length === 0);

  // Unknown widget refused.
  await assert.rejects(
    f.sw.setPagePlacement("pdp:default", ["alpha", "missing-slug"]),
    /not found/,
  );

  // Archived widget refused.
  await f.sw.archiveWidget("bravo");
  await assert.rejects(
    f.sw.setPagePlacement("pdp:default", ["bravo"]),
    /is archived/,
  );

  // Duplicate slug refused.
  await assert.rejects(
    f.sw.setPagePlacement("pdp:default", ["alpha", "alpha"]),
    /duplicates a previous entry/,
  );
}

// ---- widgetsForPage schedule window ------------------------------------

async function _widgetsForPageScheduleWindow() {
  var f = _factory();
  await f.sw.defineWidget(_baseDefine("future",  { starts_at: 5000, expires_at: 10000 }));
  await f.sw.defineWidget(_baseDefine("current", { starts_at: 1000, expires_at: 10000 }));
  await f.sw.defineWidget(_baseDefine("past",    { starts_at: 1000, expires_at: 2000  }));
  await f.sw.setPagePlacement("home", ["future", "current", "past"]);

  // now=3000 — current is in-window, future not yet, past expired.
  var nowList = await f.sw.widgetsForPage({
    page_key: "home", viewer_kind: "guest", now: 3000,
  });
  check("widgetsForPage schedule window — current only",
        nowList.length === 1 && nowList[0].slug === "current");

  // now=7000 — current still active, future now active, past expired.
  var laterList = await f.sw.widgetsForPage({
    page_key: "home", viewer_kind: "guest", now: 7000,
  });
  var laterSlugs = laterList.map(function (w) { return w.slug; });
  check("schedule later — future + current visible",
        laterSlugs.indexOf("future") !== -1 && laterSlugs.indexOf("current") !== -1);
  check("schedule later — past stays hidden", laterSlugs.indexOf("past") === -1);

  // Archived widget never renders even if placed + in-window.
  await f.sw.archiveWidget("current");
  var afterArchive = await f.sw.widgetsForPage({
    page_key: "home", viewer_kind: "guest", now: 3000,
  });
  check("archived widget drops from render", afterArchive.length === 0);
}

// ---- recordImpression / recordClick + metrics --------------------------

async function _eventsAndMetrics() {
  var f = _factory();
  await f.sw.defineWidget(_baseDefine("newsletter"));
  await f.sw.defineWidget(_baseDefine("trust", {
    kind: "trust_badges", payload: { badges: ["secure"] },
  }));

  // Drop-silent on missing input.
  var r1 = await f.sw.recordImpression();
  check("recordImpression no-input drop-silent", r1.recorded === false);
  var r2 = await f.sw.recordImpression({});
  check("recordImpression no-fields drop-silent", r2.recorded === false);
  var r3 = await f.sw.recordImpression({ widget_slug: "" });
  check("recordImpression bad-slug drop-silent", r3.recorded === false);
  var r4 = await f.sw.recordImpression({ widget_slug: "newsletter", page_key: "" });
  check("recordImpression bad-page drop-silent", r4.recorded === false);
  var r5 = await f.sw.recordImpression({ widget_slug: "missing", page_key: "home" });
  check("recordImpression missing-widget drop-silent", r5.recorded === false);

  // Good path — impressions + clicks across pages.
  var ev1 = await f.sw.recordImpression({ widget_slug: "newsletter", page_key: "home" });
  check("recordImpression good returns id", ev1.recorded === true && typeof ev1.event_id === "string");
  await f.sw.recordImpression({ widget_slug: "newsletter", page_key: "home" });
  await f.sw.recordImpression({ widget_slug: "newsletter", page_key: "home" });
  await f.sw.recordImpression({ widget_slug: "newsletter", page_key: "pdp" });
  await f.sw.recordImpression({ widget_slug: "newsletter", page_key: "pdp" });
  await f.sw.recordClick(     { widget_slug: "newsletter", page_key: "home" });
  await f.sw.recordClick(     { widget_slug: "newsletter", page_key: "pdp" });

  await f.sw.recordImpression({ widget_slug: "trust", page_key: "pdp" });

  var m = await f.sw.metricsForWidget({ slug: "newsletter" });
  check("metrics impressions total",   m.impressions === 5);
  check("metrics clicks total",        m.clicks === 2);
  check("metrics CTR",                 Math.abs(m.ctr - 0.4) < 1e-9);
  check("metrics by_page pages",       m.by_page.length === 2);
  var byHome = m.by_page.filter(function (p) { return p.page_key === "home"; })[0];
  var byPdp  = m.by_page.filter(function (p) { return p.page_key === "pdp"; })[0];
  check("metrics home impressions",    byHome.impressions === 3);
  check("metrics home clicks",         byHome.clicks === 1);
  check("metrics home CTR",            Math.abs(byHome.ctr - 0.3333) < 0.001);
  check("metrics pdp impressions",     byPdp.impressions === 2);
  check("metrics pdp clicks",          byPdp.clicks === 1);

  // Empty / unknown widget metrics
  var none = await f.sw.metricsForWidget({ slug: "missing-widget" });
  check("metrics missing returns null", none === null);

  // Different widget — isolated metrics
  var m2 = await f.sw.metricsForWidget({ slug: "trust" });
  check("metrics other widget isolated",
        m2.impressions === 1 && m2.clicks === 0 && m2.ctr === 0);

  // Archived widget drops events silently
  await f.sw.archiveWidget("trust");
  var post = await f.sw.recordImpression({ widget_slug: "trust", page_key: "pdp" });
  check("archived widget drops impression", post.recorded === false);
}

// ---- listWidgets / updateWidget / archiveWidget ------------------------

async function _listUpdateArchive() {
  var f = _factory();
  await f.sw.defineWidget(_baseDefine("a", { priority: 100 }));
  await f.sw.defineWidget(_baseDefine("b", { priority: 200, kind: "trust_badges",
                                              payload: { badges: ["secure"] } }));
  await f.sw.defineWidget(_baseDefine("c", { priority: 50, audience: "logged_in" }));
  await f.sw.defineWidget(_baseDefine("d", { kind: "size_chart",
                                              payload: { chart_slug: "mens-tops" } }));

  // listWidgets default sorts by priority DESC.
  var all = await f.sw.listWidgets();
  check("listWidgets returns all non-archived",  all.length === 4);
  check("listWidgets priority DESC",              all[0].slug === "b" && all[1].slug === "a");

  // Kind filter.
  var trust = await f.sw.listWidgets({ kind: "trust_badges" });
  check("listWidgets kind filter",                trust.length === 1 && trust[0].slug === "b");

  // Audience filter.
  var loggedIn = await f.sw.listWidgets({ audience: "logged_in" });
  check("listWidgets audience filter",            loggedIn.length === 1 && loggedIn[0].slug === "c");

  // Archive + include_archived behavior.
  await f.sw.archiveWidget("a");
  var afterArchive = await f.sw.listWidgets();
  check("archived widget hidden by default",      afterArchive.length === 3 &&
                                                  afterArchive.every(function (w) { return w.slug !== "a"; }));
  var withArchived = await f.sw.listWidgets({ include_archived: true });
  check("include_archived returns archived too",  withArchived.length === 4);

  // Idempotent archive.
  var a2 = await f.sw.archiveWidget("a");
  check("archive idempotent",                     a2.slug === "a" && a2.archived_at != null);

  // Archive on missing widget — refuses.
  await assert.rejects(
    f.sw.archiveWidget("missing"),
    /not found/,
  );

  // updateWidget — patch payload, title, audience.
  var bUpdated = await f.sw.updateWidget("b", {
    title: "Trust v2",
    payload: { badges: ["secure", "free-returns"] },
    priority: 999,
  });
  check("updateWidget title",                     bUpdated.title === "Trust v2");
  check("updateWidget payload",                   bUpdated.payload.badges.length === 2);
  check("updateWidget priority",                  bUpdated.priority === 999);
  check("updateWidget kind unchanged",            bUpdated.kind === "trust_badges");

  // Refuse payload reshape that violates kind invariants.
  await assert.rejects(
    f.sw.updateWidget("b", { payload: { collection_slug: "x", limit: 1 } }),
    /payload key/,
  );

  // Refuse audience swap that breaks segment_slug invariant.
  await assert.rejects(
    f.sw.updateWidget("b", { audience: "segment" }),
    /requires segment_slug/,
  );
  await assert.rejects(
    f.sw.updateWidget("b", { segment_slug: "vip" }),
    /segment_slug only valid/,
  );

  // Update with audience + segment_slug together: ok.
  var bSeg = await f.sw.updateWidget("b", { audience: "segment", segment_slug: "vip" });
  check("updateWidget audience+segment",          bSeg.audience === "segment" && bSeg.segment_slug === "vip");

  // Patch expires_at < starts_at refused.
  await assert.rejects(
    f.sw.updateWidget("b", { expires_at: 500 }),
    /expires_at must be strictly greater/,
  );

  // Unsupported column refused.
  await assert.rejects(
    f.sw.updateWidget("b", { kind: "social_proof" }),
    /unsupported column/,
  );

  // Empty patch refused.
  await assert.rejects(
    f.sw.updateWidget("b", {}),
    /at least one column/,
  );

  // Update on archived widget refused.
  await assert.rejects(
    f.sw.updateWidget("a", { title: "x" }),
    /is archived/,
  );

  // Update on missing widget refused.
  await assert.rejects(
    f.sw.updateWidget("missing", { title: "x" }),
    /not found/,
  );
}

// ---- validation surface -------------------------------------------------

async function _validationSurface() {
  var f = _factory();

  // defineWidget
  await assert.rejects(f.sw.defineWidget(),                                          /input object required/);
  await assert.rejects(f.sw.defineWidget({ slug: "Bad Slug" }),                      /slug/);
  await assert.rejects(f.sw.defineWidget(_baseDefine("x", { title: "" })),           /title/);
  await assert.rejects(f.sw.defineWidget(_baseDefine("x", { title: "ok\nlf" })),     /control bytes/);
  await assert.rejects(f.sw.defineWidget(_baseDefine("x", { kind: "bogus" })),       /kind must be one of/);
  await assert.rejects(f.sw.defineWidget(_baseDefine("x", { audience: "bogus" })),   /audience must be one of/);
  await assert.rejects(f.sw.defineWidget(_baseDefine("x", { priority: -1 })),        /priority/);
  await assert.rejects(f.sw.defineWidget(_baseDefine("x", { starts_at: -1 })),       /starts_at/);

  // Seed for entry-point tests.
  await f.sw.defineWidget(_baseDefine("live"));

  // setPagePlacement
  await assert.rejects(f.sw.setPagePlacement("Bad Key With Spaces", []),             /page_key/);
  await assert.rejects(f.sw.setPagePlacement("page-1", "not-array"),                 /slugs must be an array/);
  await assert.rejects(f.sw.setPagePlacement("page-1"),                              /slugs must be an array/);
  await assert.rejects(f.sw.setPagePlacement("page-1", ["Bad Slug!"]),               /slugs\[0\]/);

  // widgetsForPage
  await assert.rejects(f.sw.widgetsForPage(),                                        /input object required/);
  await assert.rejects(f.sw.widgetsForPage({ page_key: "Bad Key" }),                 /page_key/);
  await assert.rejects(f.sw.widgetsForPage({ page_key: "home", viewer_kind: "x" }),  /viewer_kind/);
  await assert.rejects(f.sw.widgetsForPage({
    page_key: "home", viewer_kind: "guest", now: -1,
  }), /now/);

  // metricsForWidget
  await assert.rejects(f.sw.metricsForWidget(),                                      /input object required/);
  await assert.rejects(f.sw.metricsForWidget({ slug: "Bad Slug" }),                  /slug/);
  await assert.rejects(f.sw.metricsForWidget({ slug: "live", from: 100, to: 50 }),   /from must be <= to/);

  // listWidgets
  await assert.rejects(f.sw.listWidgets({ kind: "bogus" }),                          /kind must be one of/);
  await assert.rejects(f.sw.listWidgets({ audience: "bogus" }),                      /audience/);
  await assert.rejects(f.sw.listWidgets({ include_archived: "yes" }),                /include_archived/);
  await assert.rejects(f.sw.listWidgets({ limit: 0 }),                               /limit/);

  // updateWidget
  await assert.rejects(f.sw.updateWidget("Bad Slug", {}),                            /slug/);
  await assert.rejects(f.sw.updateWidget("live"),                                    /patch object required/);

  // archiveWidget
  await assert.rejects(f.sw.archiveWidget("Bad Slug"),                               /slug/);

  // getWidget
  await assert.rejects(f.sw.getWidget("Bad Slug"),                                   /slug/);
  var missing = await f.sw.getWidget("nonexistent");
  check("getWidget missing returns null", missing === null);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("KINDS exported",          Array.isArray(sidebarWidgets.KINDS) &&
                                    sidebarWidgets.KINDS.indexOf("newsletter_signup") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("recently_viewed") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("trust_badges") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("featured_collection") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("social_proof") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("size_chart") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("live_visitors") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("countdown_timer") !== -1 &&
                                    sidebarWidgets.KINDS.indexOf("sticky_addtocart") !== -1);
  check("AUDIENCES exported",      Array.isArray(sidebarWidgets.AUDIENCES) &&
                                    sidebarWidgets.AUDIENCES.indexOf("all") !== -1 &&
                                    sidebarWidgets.AUDIENCES.indexOf("segment") !== -1);
  check("EVENT_KINDS exported",    Array.isArray(sidebarWidgets.EVENT_KINDS) &&
                                    sidebarWidgets.EVENT_KINDS.indexOf("impression") !== -1 &&
                                    sidebarWidgets.EVENT_KINDS.indexOf("click") !== -1);
  check("MAX_WIDGETS_PER_PAGE",    typeof sidebarWidgets.MAX_WIDGETS_PER_PAGE === "number" &&
                                    sidebarWidgets.MAX_WIDGETS_PER_PAGE > 0);

  var inst = sidebarWidgets.create({ query: _makeQuery().query });
  check("instance exposes KINDS",     inst.KINDS.length === sidebarWidgets.KINDS.length);
  check("instance exposes AUDIENCES", inst.AUDIENCES.length === sidebarWidgets.AUDIENCES.length);
}

async function run() {
  await _defineWidgetShape();
  await _audienceInvariants();
  await _setPagePlacementShape();
  await _widgetsForPageScheduleWindow();
  await _eventsAndMetrics();
  await _listUpdateArchive();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - sidebar-widgets (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
