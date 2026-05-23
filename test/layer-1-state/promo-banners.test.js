"use strict";
/**
 * promoBanners — operator-controlled marketing banners across the
 * storefront, scheduled + audience-filtered + priority-ranked.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0053_promo_banners.sql alone — the primitive has no FKs into the
 * rest of the schema, so the test runs against a minimal in-memory
 * database with just the banner table.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/promo-banners.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineBanner happy path + every required field is persisted
 *   - defineBanner refuses bad URL scheme (javascript:), bad enum
 *     values (placement / audience / theme), bad window (expires <=
 *     starts), audience=segment without segment_slug
 *   - activeForPlacement returns the highest-priority active banner
 *     and respects the schedule window (before starts / after expires
 *     yield no banner)
 *   - activeForPlacement audience filtering: all / logged_in / guest /
 *     segment via a stub customerSegments handle
 *   - renderHtml HTML-escapes every operator-input field — hostile
 *     headline + body + cta_label survive unescaped <script> attempts
 *     as inert text
 *   - impressionCount + clickCount counters via recordImpression /
 *     recordClick, plus drop-silent on bad slug
 *   - archive / unarchive flips visibility from activeForPlacement
 *   - updateBanner patch path with cross-column invariants
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var promoBanners = require("../../lib/promo-banners");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0053_promo_banners.sql");

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
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Build a stub customerSegments handle backed by an in-memory map.
// The test wires a deterministic membership table so audience=
// "segment" can be exercised without depending on a real segments
// primitive.
function _stubSegments(memberships) {
  return {
    isMember: async function (customerId, segmentSlug) {
      if (!memberships[segmentSlug]) return false;
      return memberships[segmentSlug].indexOf(customerId) !== -1;
    },
  };
}

function _setup(memberships) {
  var query = _makeQuery();
  var banners = promoBanners.create({
    query:            query,
    customerSegments: _stubSegments(memberships || {}),
  });
  return { query: query, banners: banners };
}

// ---- defineBanner happy path -------------------------------------------

async function _defineHappy() {
  var ctx = _setup();
  var now = Date.now();
  var b = await ctx.banners.defineBanner({
    slug:        "summer-sale-top",
    placement:   "top_strip",
    headline:    "Summer Sale — up to 40% off",
    body:        "Through Sunday only.",
    cta_label:   "Shop the sale",
    cta_url:     "https://example.com/sale",
    image_url:   "https://example.com/img/sale.png",
    audience:    "all",
    priority:    100,
    starts_at:   now - 60 * 1000,
    expires_at:  now + 7 * 24 * 60 * 60 * 1000,
    theme:       "promo",
  });
  check("defineBanner persists slug",          b.slug === "summer-sale-top");
  check("defineBanner persists placement",     b.placement === "top_strip");
  check("defineBanner persists headline",      b.headline === "Summer Sale — up to 40% off");
  check("defineBanner persists body",          b.body === "Through Sunday only.");
  check("defineBanner persists cta_label",     b.cta_label === "Shop the sale");
  check("defineBanner persists cta_url",       b.cta_url === "https://example.com/sale");
  check("defineBanner persists image_url",     b.image_url === "https://example.com/img/sale.png");
  check("defineBanner persists audience",      b.audience === "all");
  check("defineBanner persists priority",      b.priority === 100);
  check("defineBanner persists theme",         b.theme === "promo");
  check("defineBanner persists window",        b.starts_at < b.expires_at);
  check("defineBanner archived_at null",       b.archived_at === null);
  check("defineBanner counters zero",          b.impression_count === 0 && b.click_count === 0);
  check("defineBanner stamps created_at",      typeof b.created_at === "number" && b.created_at > 0);

  // theme defaults to "info" when omitted.
  var b2 = await ctx.banners.defineBanner({
    slug:        "no-theme",
    placement:   "footer",
    headline:    "Hi",
    cta_label:   "Go",
    cta_url:     "https://example.com/",
    audience:    "all",
    priority:    1,
    starts_at:   now,
    expires_at:  now + 1000,
  });
  check("defineBanner defaults theme to info", b2.theme === "info");

  // /-rooted CTA URL is accepted (storefront-internal link).
  var b3 = await ctx.banners.defineBanner({
    slug:        "internal-link",
    placement:   "homepage_hero",
    headline:    "New arrivals",
    cta_label:   "Browse",
    cta_url:     "/collections/new",
    audience:    "all",
    priority:    5,
    starts_at:   now,
    expires_at:  now + 1000,
  });
  check("defineBanner accepts /-rooted cta_url", b3.cta_url === "/collections/new");

  // segment audience requires segment_slug.
  var b4 = await ctx.banners.defineBanner({
    slug:          "vip-only",
    placement:     "homepage_hero",
    headline:      "VIP early access",
    cta_label:     "Browse",
    cta_url:       "https://example.com/vip",
    audience:      "segment",
    segment_slug:  "vip",
    priority:      1,
    starts_at:     now,
    expires_at:    now + 1000,
  });
  check("defineBanner persists segment_slug", b4.segment_slug === "vip");
}

// ---- defineBanner refusals --------------------------------------------

async function _defineRefusals() {
  var ctx = _setup();
  var now = Date.now();

  // Bad URL scheme — javascript: refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "evil-1", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "javascript:alert(1)", audience: "all", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /cta_url/);

  // Bad URL scheme — data: refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "evil-2", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "data:text/html,<script>alert(1)</script>", audience: "all", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /cta_url/);

  // Bad URL scheme — http: refused (storefront is https-only).
  await assert.rejects(ctx.banners.defineBanner({
    slug: "evil-3", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "http://example.com/sale", audience: "all", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /cta_url/);

  // Protocol-relative refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "evil-4", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "//evil.example.com/", audience: "all", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /cta_url/);

  // Bad image_url scheme also refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "evil-5", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", image_url: "javascript:alert(2)",
    audience: "all", priority: 1, starts_at: now, expires_at: now + 1000,
  }), /image_url/);

  // Bad placement enum.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "bad-plc", placement: "billboard", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /placement must be one of/);

  // Bad audience enum.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "bad-aud", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "everyone", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /audience must be one of/);

  // Bad theme enum.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "bad-thm", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now, expires_at: now + 1000, theme: "rainbow",
  }), /theme must be one of/);

  // expires_at <= starts_at refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "bad-win", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now + 1000, expires_at: now + 1000,
  }), /expires_at must be strictly greater/);
  await assert.rejects(ctx.banners.defineBanner({
    slug: "bad-win2", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now + 2000, expires_at: now + 1000,
  }), /expires_at must be strictly greater/);

  // audience=segment without segment_slug refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "seg-missing", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "segment", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /requires segment_slug/);

  // segment_slug supplied with non-segment audience refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "seg-wrong-aud", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", segment_slug: "vip", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /segment_slug only valid/);

  // Bad slug shape refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "-leading-hyphen", placement: "top_strip", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now, expires_at: now + 1000,
  }), /slug/);

  // Empty input refused.
  await assert.rejects(ctx.banners.defineBanner(), /input object required/);

  // Control bytes in headline refused.
  await assert.rejects(ctx.banners.defineBanner({
    slug: "ctrl-head", placement: "top_strip", headline: "bad\x00byte",
    cta_label: "y", cta_url: "https://example.com/", audience: "all",
    priority: 1, starts_at: now, expires_at: now + 1000,
  }), /headline/);
}

// ---- activeForPlacement: priority + window -----------------------------

async function _activePriorityAndWindow() {
  var ctx = _setup();
  var now = 1700000000000;

  await ctx.banners.defineBanner({
    slug: "p10", placement: "top_strip", headline: "Low priority",
    cta_label: "Go", cta_url: "https://example.com/a", audience: "all",
    priority: 10, starts_at: now - 1000, expires_at: now + 10000,
  });
  await ctx.banners.defineBanner({
    slug: "p100", placement: "top_strip", headline: "High priority",
    cta_label: "Go", cta_url: "https://example.com/b", audience: "all",
    priority: 100, starts_at: now - 1000, expires_at: now + 10000,
  });
  await ctx.banners.defineBanner({
    slug: "p50", placement: "top_strip", headline: "Mid priority",
    cta_label: "Go", cta_url: "https://example.com/c", audience: "all",
    priority: 50, starts_at: now - 1000, expires_at: now + 10000,
  });

  var winner = await ctx.banners.activeForPlacement({
    placement: "top_strip", viewer_kind: "guest", now: now,
  });
  check("activeForPlacement picks highest priority", winner.slug === "p100");

  // Before window — no banner.
  var beforeWin = await ctx.banners.activeForPlacement({
    placement: "top_strip", viewer_kind: "guest", now: now - 5000,
  });
  check("activeForPlacement before window returns null", beforeWin === null);

  // After window — no banner.
  var afterWin = await ctx.banners.activeForPlacement({
    placement: "top_strip", viewer_kind: "guest", now: now + 20000,
  });
  check("activeForPlacement after window returns null", afterWin === null);

  // Different placement — no banner.
  var otherPlace = await ctx.banners.activeForPlacement({
    placement: "footer", viewer_kind: "guest", now: now,
  });
  check("activeForPlacement other placement returns null", otherPlace === null);

  // Add a higher-priority banner that's NOT yet started — the
  // existing p100 banner should still win at `now`.
  await ctx.banners.defineBanner({
    slug: "p1000-future", placement: "top_strip", headline: "Future",
    cta_label: "Go", cta_url: "https://example.com/d", audience: "all",
    priority: 1000, starts_at: now + 5000, expires_at: now + 100000,
  });
  var stillP100 = await ctx.banners.activeForPlacement({
    placement: "top_strip", viewer_kind: "guest", now: now,
  });
  check("future-window banner doesn't preempt current winner", stillP100.slug === "p100");
}

// ---- activeForPlacement: audience filter -------------------------------

async function _activeAudience() {
  var ctx = _setup({ vip: ["cus_123"], gold: ["cus_999"] });
  var now = 1700000000000;

  // One banner per audience type at distinct priorities so we can
  // verify the audience filter without the priority sort confusing
  // the picture.
  await ctx.banners.defineBanner({
    slug: "all-aud", placement: "homepage_hero", headline: "Everyone",
    cta_label: "Go", cta_url: "https://example.com/a", audience: "all",
    priority: 10, starts_at: now - 1000, expires_at: now + 10000,
  });
  await ctx.banners.defineBanner({
    slug: "logged-aud", placement: "homepage_hero", headline: "Logged in",
    cta_label: "Go", cta_url: "https://example.com/b", audience: "logged_in",
    priority: 20, starts_at: now - 1000, expires_at: now + 10000,
  });
  await ctx.banners.defineBanner({
    slug: "guest-aud", placement: "homepage_hero", headline: "Guests",
    cta_label: "Go", cta_url: "https://example.com/c", audience: "guest",
    priority: 30, starts_at: now - 1000, expires_at: now + 10000,
  });
  await ctx.banners.defineBanner({
    slug: "vip-aud", placement: "homepage_hero", headline: "VIPs",
    cta_label: "Go", cta_url: "https://example.com/d", audience: "segment",
    segment_slug: "vip", priority: 40, starts_at: now - 1000, expires_at: now + 10000,
  });

  // Guest viewer: guest-aud (prio 30) wins over all-aud (10).
  // logged_in and segment banners don't apply.
  var guestPick = await ctx.banners.activeForPlacement({
    placement: "homepage_hero", viewer_kind: "guest", now: now,
  });
  check("guest viewer gets guest-aud banner", guestPick.slug === "guest-aud");

  // Logged-in non-VIP viewer: vip-aud doesn't match (not a member),
  // logged-aud (20) wins over all-aud (10).
  var loggedNonVip = await ctx.banners.activeForPlacement({
    placement: "homepage_hero", viewer_kind: "logged_in", customer_id: "cus_404", now: now,
  });
  check("logged-in non-vip gets logged-aud banner", loggedNonVip.slug === "logged-aud");

  // Logged-in VIP viewer: vip-aud (40) wins.
  var loggedVip = await ctx.banners.activeForPlacement({
    placement: "homepage_hero", viewer_kind: "logged_in", customer_id: "cus_123", now: now,
  });
  check("logged-in vip gets vip-aud banner", loggedVip.slug === "vip-aud");

  // viewer_kind=logged_in without customer_id is refused.
  await assert.rejects(ctx.banners.activeForPlacement({
    placement: "homepage_hero", viewer_kind: "logged_in", now: now,
  }), /requires customer_id/);

  // viewer_kind=guest with customer_id is refused.
  await assert.rejects(ctx.banners.activeForPlacement({
    placement: "homepage_hero", viewer_kind: "guest", customer_id: "cus_123", now: now,
  }), /must not carry customer_id/);

  // Segment banner with no customerSegments handle wired — the
  // factory must surface a clear error.
  var ctxNoSeg = { query: _makeQuery() };
  ctxNoSeg.banners = promoBanners.create({ query: ctxNoSeg.query });
  await ctxNoSeg.banners.defineBanner({
    slug: "seg-only", placement: "homepage_hero", headline: "VIPs",
    cta_label: "Go", cta_url: "https://example.com/d", audience: "segment",
    segment_slug: "vip", priority: 1, starts_at: now - 1000, expires_at: now + 10000,
  });
  await assert.rejects(ctxNoSeg.banners.activeForPlacement({
    placement: "homepage_hero", viewer_kind: "logged_in", customer_id: "cus_123", now: now,
  }), /no customerSegments handle/);
}

// ---- renderHtml escaping ------------------------------------------------

async function _renderEscaping() {
  var ctx = _setup();
  var now = Date.now();

  // Hostile operator input — every operator-input field carries a
  // <script> attempt. renderHtml must escape every one of them so
  // the resulting HTML contains no live <script> tag.
  await ctx.banners.defineBanner({
    slug:      "hostile",
    placement: "top_strip",
    headline:  "<script>alert('h')</script>",
    body:      "<img src=x onerror=alert('b')>\n<svg/onload=alert(2)>",
    cta_label: "<script>alert('c')</script>",
    cta_url:   "https://example.com/?q=%3Cscript%3E",
    image_url: "https://example.com/img/x.png",
    audience:  "all",
    priority:  1,
    starts_at: now - 1000,
    expires_at: now + 10000,
  });

  var banner = await ctx.banners.getBanner("hostile");
  var html = ctx.banners.renderHtml({ banner: banner, locale: "en-US" });

  // No live tags from the hostile input.
  check("renderHtml escapes script in headline",  html.indexOf("<script>") === -1);
  check("renderHtml escapes onerror in body",      !/<img[^>]*onerror=/i.test(html));
  check("renderHtml escapes svg/onload in body",   !/<svg[^>]*onload=/i.test(html));
  // The hostile strings still appear as escaped entities.
  check("renderHtml encodes < as &lt;",            html.indexOf("&lt;script&gt;") !== -1);
  check("renderHtml encodes apostrophes safely",   html.indexOf("'h'") === -1 || html.indexOf("&#39;h&#39;") !== -1 || html.indexOf("&apos;h&apos;") !== -1 || html.indexOf("&#x27;h&#x27;") !== -1);
  // Slug + locale + theme + placement land into attributes.
  check("renderHtml carries slug attr",            html.indexOf('data-banner-slug="hostile"') !== -1);
  check("renderHtml carries locale attr",          html.indexOf('lang="en-US"') !== -1);
  check("renderHtml carries placement class",      html.indexOf("promo-banner--top_strip") !== -1);
  check("renderHtml carries theme class",          html.indexOf("promo-banner--info") !== -1);
  // CTA href is the escaped URL, but renderHtml doesn't introduce
  // any newly-live markup from the encoded payload inside the query.
  check("renderHtml href present",                 html.indexOf('class="promo-banner__cta"') !== -1);
  check("renderHtml has no raw < in cta_url",      !/href="[^"]*<script/.test(html));

  // Body without a value is omitted entirely.
  await ctx.banners.defineBanner({
    slug: "no-body", placement: "footer", headline: "Hello",
    cta_label: "Go", cta_url: "https://example.com/", audience: "all",
    priority: 1, starts_at: now - 1000, expires_at: now + 10000,
  });
  var b2 = await ctx.banners.getBanner("no-body");
  var html2 = ctx.banners.renderHtml({ banner: b2 });
  check("renderHtml omits body block when null", html2.indexOf("promo-banner__line") === -1);

  // Bad locale shape refused.
  assert.throws(function () {
    ctx.banners.renderHtml({ banner: banner, locale: "not a locale!" });
  }, /locale/);
}

// ---- counters: record + read -------------------------------------------

async function _counters() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.banners.defineBanner({
    slug: "counted", placement: "footer", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now - 1000, expires_at: now + 10000,
  });

  check("initial impressionCount = 0", (await ctx.banners.impressionCount("counted")) === 0);
  check("initial clickCount = 0",      (await ctx.banners.clickCount("counted")) === 0);

  var r1 = await ctx.banners.recordImpression("counted");
  check("recordImpression returns recorded=true", r1.recorded === true);
  await ctx.banners.recordImpression("counted");
  await ctx.banners.recordImpression("counted");
  check("impressionCount = 3 after 3 records", (await ctx.banners.impressionCount("counted")) === 3);

  await ctx.banners.recordClick("counted");
  await ctx.banners.recordClick("counted");
  check("clickCount = 2 after 2 records", (await ctx.banners.clickCount("counted")) === 2);

  // Unknown slug: drop-silent. recordImpression / recordClick must
  // not throw; they return { recorded: false }. Counters for an
  // unknown slug read as 0.
  var ghost1 = await ctx.banners.recordImpression("ghost-slug");
  check("recordImpression drop-silent for unknown slug", ghost1.recorded === false);
  var ghost2 = await ctx.banners.recordClick("ghost-slug");
  check("recordClick drop-silent for unknown slug",       ghost2.recorded === false);
  check("impressionCount for unknown slug returns 0",     (await ctx.banners.impressionCount("counted-x")) === 0);

  // Bad-shape slug: also drop-silent (no throw, no increment).
  var bad1 = await ctx.banners.recordImpression(null);
  check("recordImpression drop-silent for null slug",     bad1.recorded === false);
  var bad2 = await ctx.banners.recordImpression("-bad");
  check("recordImpression drop-silent for bad-shape slug", bad2.recorded === false);
  var bad3 = await ctx.banners.recordClick("");
  check("recordClick drop-silent for empty slug",         bad3.recorded === false);

  // Existing slug's count never moved when we banged on bad input.
  check("counted's impression count is still 3", (await ctx.banners.impressionCount("counted")) === 3);
}

// ---- archive / unarchive flips visibility -------------------------------

async function _archiveUnarchive() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.banners.defineBanner({
    slug: "active-banner", placement: "cart_side", headline: "x", cta_label: "y",
    cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now - 1000, expires_at: now + 10000,
  });

  var pick1 = await ctx.banners.activeForPlacement({
    placement: "cart_side", viewer_kind: "guest", now: now,
  });
  check("pre-archive: active banner is reachable", pick1 && pick1.slug === "active-banner");

  var archived = await ctx.banners.archive("active-banner");
  check("archive stamps archived_at", typeof archived.archived_at === "number" && archived.archived_at > 0);

  var pick2 = await ctx.banners.activeForPlacement({
    placement: "cart_side", viewer_kind: "guest", now: now,
  });
  check("archived banner removed from activeForPlacement", pick2 === null);

  // Archive twice — idempotent.
  var archived2 = await ctx.banners.archive("active-banner");
  check("archive idempotent — second call returns row", archived2.slug === "active-banner");

  // Unarchive brings it back.
  var unarchived = await ctx.banners.unarchive("active-banner");
  check("unarchive clears archived_at", unarchived.archived_at === null);
  var pick3 = await ctx.banners.activeForPlacement({
    placement: "cart_side", viewer_kind: "guest", now: now,
  });
  check("post-unarchive: banner reachable again", pick3 && pick3.slug === "active-banner");

  // archive on unknown slug — refused.
  await assert.rejects(ctx.banners.archive("never-existed"), /not found/);
  await assert.rejects(ctx.banners.unarchive("never-existed"), /not found/);
}

// ---- updateBanner patch + invariants -----------------------------------

async function _updateBanner() {
  var ctx = _setup({ vip: ["cus_1"] });
  var now = Date.now();
  await ctx.banners.defineBanner({
    slug: "u1", placement: "search_empty", headline: "Old headline",
    cta_label: "Go", cta_url: "https://example.com/old", audience: "all",
    priority: 5, starts_at: now - 1000, expires_at: now + 10000, theme: "info",
  });

  var u = await ctx.banners.updateBanner("u1", {
    headline: "New headline",
    cta_url:  "https://example.com/new",
    priority: 50,
    theme:    "urgency",
  });
  check("updateBanner persists headline", u.headline === "New headline");
  check("updateBanner persists cta_url",  u.cta_url === "https://example.com/new");
  check("updateBanner persists priority", u.priority === 50);
  check("updateBanner persists theme",    u.theme === "urgency");
  // Untouched columns preserved.
  check("updateBanner preserves placement", u.placement === "search_empty");
  check("updateBanner preserves audience",  u.audience === "all");

  // expires_at <= starts_at refused.
  await assert.rejects(ctx.banners.updateBanner("u1", {
    expires_at: u.starts_at,
  }), /expires_at must be strictly greater/);

  // Switching audience to "segment" without supplying segment_slug
  // in the same patch is refused.
  await assert.rejects(ctx.banners.updateBanner("u1", {
    audience: "segment",
  }), /requires segment_slug/);

  // Atomic flip: change audience AND segment_slug in one patch.
  var seg = await ctx.banners.updateBanner("u1", {
    audience: "segment",
    segment_slug: "vip",
  });
  check("updateBanner atomic audience+segment flip", seg.audience === "segment" && seg.segment_slug === "vip");

  // Switching back: clear segment_slug AND set audience back.
  var back = await ctx.banners.updateBanner("u1", {
    audience: "all",
    segment_slug: null,
  });
  check("updateBanner atomic flip back to all", back.audience === "all" && back.segment_slug === null);

  // Unsupported column refused.
  await assert.rejects(ctx.banners.updateBanner("u1", {
    impression_count: 99,
  }), /unsupported column/);

  // Unknown slug refused.
  await assert.rejects(ctx.banners.updateBanner("u-ghost", {
    headline: "x",
  }), /not found/);

  // listAll active_only filter.
  await ctx.banners.defineBanner({
    slug: "future-only", placement: "search_empty", headline: "later",
    cta_label: "Go", cta_url: "https://example.com/", audience: "all", priority: 1,
    starts_at: now + 1000000, expires_at: now + 2000000,
  });
  var allList    = await ctx.banners.listAll();
  var activeList = await ctx.banners.listAll({ active_only: true });
  check("listAll returns all rows",        allList.length >= 2);
  check("listAll active_only excludes future-only window",
    !activeList.some(function (b) { return b.slug === "future-only"; }));
}

async function run() {
  await _defineHappy();
  await _defineRefusals();
  await _activePriorityAndWindow();
  await _activeAudience();
  await _renderEscaping();
  await _counters();
  await _archiveUnarchive();
  await _updateBanner();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/promo-banners.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("promo-banners: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
