"use strict";
/**
 * trustBadges — operator-curated trust signals + certifications
 * rendered across the storefront at six fixed placements.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0111_trust_badges.sql alone — the primitive has no FKs into the
 * rest of the schema, so the test runs against a minimal in-memory
 * database with just the two badge tables.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/trust-badges.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineBadge happy path with inline SVG payload + image_url
 *     payload; counters start at zero; placements survive the
 *     JSON round-trip
 *   - defineBadge refusals: <script> inside svg_payload, javascript:
 *     in link_url, http: link_url, protocol-relative link_url,
 *     both svg_payload AND image_url supplied, neither supplied,
 *     bad placement enum, duplicate placements, bad slug shape,
 *     bad window (expires <= starts)
 *   - activeForPlacement: priority sort, multi-placement membership,
 *     active window filtering (null bounds = evergreen), archived
 *     badges excluded
 *   - renderHtml: SVG payload landed sanitized so <script>/onerror
 *     don't appear; image-mode badge renders <img> with escaped
 *     alt; link_url wraps in <a>; missing slug refused
 *   - updateBadge: column patch + cross-column invariants (can't
 *     end up with both svg + image, can't end up with neither)
 *   - archiveBadge: idempotent + hides from activeForPlacement
 *   - recordImpression + recordClick: counters move, event log
 *     persists, drop-silent on unknown slug / bad input / archived
 *     badge / bad placement
 *   - session_id hashing: raw session_id never reaches the event
 *     row; the hash is deterministic for the same input
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var trustBadges = require("../../lib/trust-badges");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0111_trust_badges.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var query = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  query.__db = db;
  return query;
}

function _setup() {
  var query = _makeQuery();
  var badges = trustBadges.create({ query: query });
  return { query: query, badges: badges };
}

// A minimal valid inline SVG. The strict allowlist (svg / path /
// circle / rect / g / title / desc) accepts every element here.
var GOOD_SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
               '<title>BBB Accredited Business</title>' +
               '<desc>Better Business Bureau accreditation seal</desc>' +
               '<circle cx="50" cy="50" r="40" fill="#003a70" />' +
               '<path d="M30 50 L45 65 L70 35" stroke="#fff" stroke-width="6" fill="none" />' +
               '</svg>';

// ---- defineBadge happy path -------------------------------------------

async function _defineHappy() {
  var ctx = _setup();
  var now = Date.now();

  var bbb = await ctx.badges.defineBadge({
    slug:        "bbb-accredited",
    title:       "BBB Accredited Business",
    svg_payload: GOOD_SVG,
    link_url:    "https://www.bbb.org/us/example/example/profile/0/",
    placements:  ["header", "footer", "checkout"],
    alt_text:    "Better Business Bureau accredited business seal",
    priority:    100,
    starts_at:   now - 1000,
    expires_at:  now + 7 * 24 * 60 * 60 * 1000,
  });
  check("defineBadge persists slug",              bbb.slug === "bbb-accredited");
  check("defineBadge persists title",             bbb.title === "BBB Accredited Business");
  check("defineBadge persists alt_text",          bbb.alt_text === "Better Business Bureau accredited business seal");
  check("defineBadge persists link_url",          bbb.link_url === "https://www.bbb.org/us/example/example/profile/0/");
  check("defineBadge persists priority",          bbb.priority === 100);
  check("defineBadge archived_at null",           bbb.archived_at === null);
  check("defineBadge counters zero",              bbb.impression_count === 0 && bbb.click_count === 0);
  check("defineBadge persists placements array",  Array.isArray(bbb.placements) && bbb.placements.length === 3);
  check("defineBadge placements include header",  bbb.placements.indexOf("header") !== -1);
  check("defineBadge svg_payload non-null",       typeof bbb.svg_payload === "string" && bbb.svg_payload.length > 0);
  check("defineBadge image_url null",             bbb.image_url === null);
  check("defineBadge stamps created_at",          typeof bbb.created_at === "number" && bbb.created_at > 0);

  // Image-mode badge (https:// remote image instead of inline SVG).
  var iso = await ctx.badges.defineBadge({
    slug:        "iso-27001",
    title:       "ISO 27001 Certified",
    image_url:   "https://example.com/img/iso-27001.png",
    placements:  ["footer"],
    alt_text:    "ISO 27001 information security management certification",
    priority:    50,
  });
  check("defineBadge image-mode persists image_url", iso.image_url === "https://example.com/img/iso-27001.png");
  check("defineBadge image-mode svg_payload null",   iso.svg_payload === null);
  check("defineBadge image-mode link_url null",      iso.link_url === null);
  check("defineBadge image-mode evergreen window",   iso.starts_at === null && iso.expires_at === null);
  check("defineBadge image-mode default priority",   iso.priority === 50);

  // /-rooted link_url accepted (storefront-internal route).
  var usa = await ctx.badges.defineBadge({
    slug:        "ships-from-usa",
    title:       "Ships from USA",
    image_url:   "https://example.com/img/usa.svg",
    link_url:    "/about/shipping",
    placements:  ["pdp", "cart_review"],
    alt_text:    "Orders ship from the United States",
    priority:    10,
  });
  check("defineBadge accepts /-rooted link_url", usa.link_url === "/about/shipping");
}

// ---- defineBadge refusals ---------------------------------------------

async function _defineRefusals() {
  var ctx = _setup();
  var now = Date.now();

  // <script> inside SVG — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-svg-script", title: "Evil",
    svg_payload: '<svg><script>alert(1)</script><circle r="10"/></svg>',
    placements: ["footer"], alt_text: "evil", priority: 1,
  }), /svg_payload/);

  // <foreignObject> (namespace-shift escape hatch) — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-svg-fo", title: "Evil",
    svg_payload: '<svg><foreignObject><iframe src="https://evil/"/></foreignObject></svg>',
    placements: ["footer"], alt_text: "evil", priority: 1,
  }), /svg_payload/);

  // onload= event-handler attribute — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-svg-onload", title: "Evil",
    svg_payload: '<svg onload="alert(1)"><circle r="10"/></svg>',
    placements: ["footer"], alt_text: "evil", priority: 1,
  }), /svg_payload/);

  // Non-allowlisted tag (<image>) — refused under our trust-badge
  // narrowing even though the strict guard profile accepts more.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-svg-image", title: "Evil",
    svg_payload: '<svg><image href="https://evil/x.png"/></svg>',
    placements: ["footer"], alt_text: "evil", priority: 1,
  }), /svg_payload/);

  // javascript: link_url — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-link-js", title: "Evil",
    image_url: "https://example.com/img/x.png", link_url: "javascript:alert(1)",
    placements: ["footer"], alt_text: "evil", priority: 1,
  }), /link_url/);

  // http: link_url — refused (storefront is https-only).
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-link-http", title: "Evil",
    image_url: "https://example.com/img/x.png", link_url: "http://example.com/",
    placements: ["footer"], alt_text: "evil", priority: 1,
  }), /link_url/);

  // Protocol-relative link_url — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-link-pr", title: "Evil",
    image_url: "https://example.com/img/x.png", link_url: "//evil.example.com/",
    placements: ["footer"], alt_text: "evil", priority: 1,
  }), /link_url/);

  // data: image_url — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-image-data", title: "Evil",
    image_url: "data:image/svg+xml,<svg/>", placements: ["footer"],
    alt_text: "evil", priority: 1,
  }), /image_url/);

  // Both svg_payload AND image_url — refused (mutually exclusive).
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-both", title: "Both",
    svg_payload: GOOD_SVG, image_url: "https://example.com/img/x.png",
    placements: ["footer"], alt_text: "both", priority: 1,
  }), /svg_payload OR image_url/);

  // Neither svg_payload NOR image_url — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "evil-neither", title: "Neither",
    placements: ["footer"], alt_text: "neither", priority: 1,
  }), /one of svg_payload \/ image_url is required/);

  // Bad placement enum — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "bad-plc", title: "Bad", image_url: "https://example.com/img/x.png",
    placements: ["billboard"], alt_text: "bad", priority: 1,
  }), /placement must be one of/);

  // Empty placements array — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "bad-plc-empty", title: "Bad", image_url: "https://example.com/img/x.png",
    placements: [], alt_text: "bad", priority: 1,
  }), /non-empty array/);

  // Duplicate placements — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "bad-plc-dup", title: "Bad", image_url: "https://example.com/img/x.png",
    placements: ["footer", "footer"], alt_text: "bad", priority: 1,
  }), /duplicate/);

  // Bad slug shape — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "-leading-hyphen", title: "Bad", image_url: "https://example.com/img/x.png",
    placements: ["footer"], alt_text: "bad", priority: 1,
  }), /slug/);

  // expires_at <= starts_at — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "bad-window", title: "Bad", image_url: "https://example.com/img/x.png",
    placements: ["footer"], alt_text: "bad", priority: 1,
    starts_at: now + 1000, expires_at: now + 1000,
  }), /expires_at must be strictly greater/);

  // Control bytes in alt_text — refused.
  await assert.rejects(ctx.badges.defineBadge({
    slug: "ctrl-alt", title: "Bad", image_url: "https://example.com/img/x.png",
    placements: ["footer"], alt_text: "bad\x00byte", priority: 1,
  }), /alt_text/);

  // Empty input — refused.
  await assert.rejects(ctx.badges.defineBadge(), /input object required/);
}

// ---- activeForPlacement: priority + window + multi-placement ----------

async function _activePriorityAndWindow() {
  var ctx = _setup();
  var now = 1700000000000;

  await ctx.badges.defineBadge({
    slug: "p10-footer", title: "Low priority footer",
    image_url: "https://example.com/img/a.png",
    placements: ["footer"], alt_text: "low", priority: 10,
  });
  await ctx.badges.defineBadge({
    slug: "p100-footer-checkout", title: "High priority multi",
    image_url: "https://example.com/img/b.png",
    placements: ["footer", "checkout"], alt_text: "high", priority: 100,
  });
  await ctx.badges.defineBadge({
    slug: "p50-checkout", title: "Mid priority checkout",
    image_url: "https://example.com/img/c.png",
    placements: ["checkout"], alt_text: "mid", priority: 50,
  });
  // Future-windowed badge — must NOT appear in `now`.
  await ctx.badges.defineBadge({
    slug: "future-only", title: "Future",
    image_url: "https://example.com/img/d.png",
    placements: ["footer"], alt_text: "future", priority: 1000,
    starts_at: now + 10000, expires_at: now + 100000,
  });
  // Expired badge — must NOT appear in `now`.
  await ctx.badges.defineBadge({
    slug: "past-only", title: "Past",
    image_url: "https://example.com/img/e.png",
    placements: ["footer"], alt_text: "past", priority: 1000,
    starts_at: now - 100000, expires_at: now - 1000,
  });

  var footerList = await ctx.badges.activeForPlacement({ placement: "footer", now: now });
  check("activeForPlacement returns array",                   Array.isArray(footerList));
  check("activeForPlacement footer count = 2 active",         footerList.length === 2);
  check("activeForPlacement priority order — p100 first",     footerList[0].slug === "p100-footer-checkout");
  check("activeForPlacement priority order — p10 second",     footerList[1].slug === "p10-footer");
  check("activeForPlacement excludes future-window badge",
    !footerList.some(function (b) { return b.slug === "future-only"; }));
  check("activeForPlacement excludes expired badge",
    !footerList.some(function (b) { return b.slug === "past-only"; }));

  var checkoutList = await ctx.badges.activeForPlacement({ placement: "checkout", now: now });
  check("activeForPlacement checkout count = 2 active",       checkoutList.length === 2);
  check("activeForPlacement checkout priority order",         checkoutList[0].slug === "p100-footer-checkout" && checkoutList[1].slug === "p50-checkout");

  var pdpList = await ctx.badges.activeForPlacement({ placement: "pdp", now: now });
  check("activeForPlacement empty placement returns []",      pdpList.length === 0);

  // Now advance into the future-only window — that badge appears,
  // the previously-active ones (still inside their evergreen
  // windows) remain.
  var farFuture = now + 20000;
  var futureFooter = await ctx.badges.activeForPlacement({ placement: "footer", now: farFuture });
  check("activeForPlacement reveals future-only at its window",
    futureFooter.some(function (b) { return b.slug === "future-only"; }));

  // Bad placement input — refused.
  await assert.rejects(ctx.badges.activeForPlacement({ placement: "billboard", now: now }),
    /placement must be one of/);

  // Bad now input — refused.
  await assert.rejects(ctx.badges.activeForPlacement({ placement: "footer", now: -1 }),
    /now/);
}

// ---- renderHtml: sanitization + structure -----------------------------

async function _renderHtmlChecks() {
  var ctx = _setup();

  // SVG badge — emit inline, escape title / alt_text, wrap in <a>.
  await ctx.badges.defineBadge({
    slug:        "render-svg",
    title:       "Tooltip <script>alert(1)</script>",
    svg_payload: GOOD_SVG,
    link_url:    "https://example.com/cert",
    placements:  ["header"],
    alt_text:    'Alt with "quotes" & <script>tags</script>',
    priority:    1,
  });
  var htmlSvg = await ctx.badges.renderHtml({ slug: "render-svg" });
  check("renderHtml svg-mode wraps in <a>",                  htmlSvg.indexOf('<a class="trust-badge"') === 0);
  check("renderHtml svg-mode carries link_url",              htmlSvg.indexOf('href="https://example.com/cert"') !== -1);
  check("renderHtml svg-mode escapes title attribute",       htmlSvg.indexOf('<script>alert(1)') === -1);
  check("renderHtml svg-mode has &lt; in escaped title",     htmlSvg.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1);
  check("renderHtml svg-mode escapes alt_text quotes",       htmlSvg.indexOf('aria-label="Alt with "') === -1);
  check("renderHtml svg-mode aria-label present",            /aria-label="[^"]*Alt with /.test(htmlSvg));
  check("renderHtml svg-mode inlines circle",                htmlSvg.indexOf("<circle") !== -1);
  check("renderHtml svg-mode has no <script>",               htmlSvg.indexOf("<script>") === -1);
  check("renderHtml svg-mode has no onerror=",               !/onerror=/i.test(htmlSvg));
  check("renderHtml svg-mode has no onload=",                !/onload=/i.test(htmlSvg));
  check("renderHtml svg-mode data-trust-badge-slug",         htmlSvg.indexOf('data-trust-badge-slug="render-svg"') !== -1);
  check("renderHtml svg-mode rel=noopener on anchor",        htmlSvg.indexOf('rel="noopener"') !== -1);

  // Image badge with no link — emit <img> wrapped in <span>.
  await ctx.badges.defineBadge({
    slug:        "render-image",
    title:       "ISO 27001",
    image_url:   "https://example.com/img/iso.png",
    placements:  ["footer"],
    alt_text:    "ISO 27001 certified",
    priority:    1,
  });
  var htmlImg = await ctx.badges.renderHtml({ slug: "render-image" });
  check("renderHtml image-mode without link wraps in <span>", htmlImg.indexOf('<span class="trust-badge"') === 0);
  check("renderHtml image-mode has no <a>",                   htmlImg.indexOf("<a ") === -1);
  check("renderHtml image-mode emits <img> with src",         htmlImg.indexOf('src="https://example.com/img/iso.png"') !== -1);
  check("renderHtml image-mode alt attribute set",            htmlImg.indexOf('alt="ISO 27001 certified"') !== -1);

  // Unknown slug refused.
  await assert.rejects(ctx.badges.renderHtml({ slug: "never-defined" }), /not found/);

  // Missing slug refused.
  await assert.rejects(ctx.badges.renderHtml({}), /slug/);
}

// ---- updateBadge: patch + cross-column invariants ---------------------

async function _updateChecks() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.badges.defineBadge({
    slug: "u-svg", title: "Old title", svg_payload: GOOD_SVG,
    placements: ["footer"], alt_text: "old", priority: 1,
  });

  // Patch title + priority — preserves the SVG side.
  var u1 = await ctx.badges.updateBadge("u-svg", {
    title: "New title", priority: 99,
  });
  check("updateBadge persists title",        u1.title === "New title");
  check("updateBadge persists priority",     u1.priority === 99);
  check("updateBadge preserves svg_payload", u1.svg_payload != null && u1.image_url == null);

  // Patch placements — array survives the JSON round-trip.
  var u2 = await ctx.badges.updateBadge("u-svg", {
    placements: ["footer", "header"],
  });
  check("updateBadge persists placements", u2.placements.length === 2 && u2.placements.indexOf("header") !== -1);

  // Atomic flip svg → image: clear svg_payload, set image_url.
  var u3 = await ctx.badges.updateBadge("u-svg", {
    svg_payload: null,
    image_url:   "https://example.com/img/u.png",
  });
  check("updateBadge atomic flip svg → image", u3.svg_payload === null && u3.image_url === "https://example.com/img/u.png");

  // Setting BOTH at once — refused (post-patch invariant).
  await assert.rejects(ctx.badges.updateBadge("u-svg", {
    svg_payload: GOOD_SVG,
  }), /mutually exclusive/);

  // Clearing both — refused.
  await assert.rejects(ctx.badges.updateBadge("u-svg", {
    image_url: null,
  }), /one of svg_payload \/ image_url must remain set/);

  // Window monotonic invariant on patch.
  await ctx.badges.updateBadge("u-svg", { starts_at: now });
  await assert.rejects(ctx.badges.updateBadge("u-svg", {
    expires_at: now,
  }), /expires_at must be strictly greater/);

  // Unsupported column.
  await assert.rejects(ctx.badges.updateBadge("u-svg", {
    impression_count: 99,
  }), /unsupported column/);

  // Unknown slug.
  await assert.rejects(ctx.badges.updateBadge("u-ghost", { title: "x" }),
    /not found/);

  // listBadges active_only excludes a future-windowed entry.
  await ctx.badges.defineBadge({
    slug: "u-future", title: "Future", image_url: "https://example.com/img/f.png",
    placements: ["footer"], alt_text: "f", priority: 1,
    starts_at: now + 1000000, expires_at: now + 2000000,
  });
  var allList    = await ctx.badges.listBadges();
  var activeList = await ctx.badges.listBadges({ active_only: true });
  check("listBadges returns all rows",      allList.length >= 2);
  check("listBadges active_only filters",
    !activeList.some(function (b) { return b.slug === "u-future"; }));
}

// ---- archiveBadge: hides from activeForPlacement ----------------------

async function _archiveChecks() {
  var ctx = _setup();
  await ctx.badges.defineBadge({
    slug: "arch-1", title: "Archivable",
    image_url: "https://example.com/img/a.png",
    placements: ["pdp"], alt_text: "a", priority: 1,
  });

  var pre = await ctx.badges.activeForPlacement({ placement: "pdp", now: Date.now() });
  check("pre-archive: badge visible at pdp", pre.length === 1 && pre[0].slug === "arch-1");

  var archived = await ctx.badges.archiveBadge("arch-1");
  check("archiveBadge stamps archived_at", typeof archived.archived_at === "number");

  var post = await ctx.badges.activeForPlacement({ placement: "pdp", now: Date.now() });
  check("post-archive: badge hidden from activeForPlacement", post.length === 0);

  // Idempotent.
  var archivedAgain = await ctx.badges.archiveBadge("arch-1");
  check("archiveBadge idempotent — second call returns row", archivedAgain.slug === "arch-1");

  // Unknown slug refused.
  await assert.rejects(ctx.badges.archiveBadge("never-existed"), /not found/);
}

// ---- recordImpression / recordClick counters + drop-silent -----------

async function _counterChecks() {
  var ctx = _setup();
  await ctx.badges.defineBadge({
    slug: "counted", title: "Counted",
    image_url: "https://example.com/img/c.png",
    placements: ["header"], alt_text: "counted", priority: 1,
  });

  var r1 = await ctx.badges.recordImpression({
    slug: "counted", placement: "header", session_id: "sess-abc",
  });
  check("recordImpression returns recorded=true", r1.recorded === true);
  check("recordImpression emits id",              typeof r1.id === "string" && r1.id.length > 0);
  await ctx.badges.recordImpression({ slug: "counted", placement: "header" });
  await ctx.badges.recordImpression({ slug: "counted", placement: "header" });
  var afterImp = await ctx.badges.getBadge("counted");
  check("impression_count = 3 after 3 records", afterImp.impression_count === 3);

  await ctx.badges.recordClick({ slug: "counted", placement: "header", session_id: "sess-abc" });
  await ctx.badges.recordClick({ slug: "counted", placement: "header" });
  var afterClk = await ctx.badges.getBadge("counted");
  check("click_count = 2 after 2 records", afterClk.click_count === 2);

  // Event log persisted.
  var events = (await ctx.query("SELECT * FROM trust_badge_events WHERE badge_slug = ?1 ORDER BY occurred_at ASC", ["counted"])).rows;
  check("event log has 5 entries",          events.length === 5);
  check("event log first is impression",    events[0].event_type === "impression");
  check("event log click present",          events.some(function (e) { return e.event_type === "click"; }));

  // Session_id hashed — raw value never reaches the row. Two
  // events with the same session_id produce the same hash; one
  // with no session_id stores NULL.
  var hashed   = events.filter(function (e) { return e.session_id_hash != null; });
  var unhashed = events.filter(function (e) { return e.session_id_hash == null; });
  check("session_id_hash is non-NULL when session_id supplied", hashed.length === 2);
  check("session_id_hash is NULL when session_id omitted",      unhashed.length === 3);
  check("session_id_hash never equals raw session_id",
    hashed.every(function (e) { return e.session_id_hash !== "sess-abc"; }));
  check("session_id_hash deterministic for same session_id",
    hashed[0].session_id_hash === hashed[1].session_id_hash);

  // Drop-silent: unknown slug, bad-shape slug, bad placement, missing
  // arg object — none throw, none increment.
  var ghost1 = await ctx.badges.recordImpression({ slug: "ghost", placement: "header" });
  check("recordImpression drop-silent unknown slug", ghost1.recorded === false);
  var bad1 = await ctx.badges.recordImpression({ slug: "-bad", placement: "header" });
  check("recordImpression drop-silent bad-shape slug", bad1.recorded === false);
  var bad2 = await ctx.badges.recordImpression({ slug: "counted", placement: "billboard" });
  check("recordImpression drop-silent bad placement",  bad2.recorded === false);
  var bad3 = await ctx.badges.recordImpression(null);
  check("recordImpression drop-silent null input",     bad3.recorded === false);
  var bad4 = await ctx.badges.recordClick({ slug: "counted", placement: "header", session_id: 42 });
  check("recordClick drop-silent non-string session_id", bad4.recorded === false);

  // Counts unmoved after the bad calls.
  var stable = await ctx.badges.getBadge("counted");
  check("impression_count stable after bad calls", stable.impression_count === 3);
  check("click_count stable after bad calls",      stable.click_count === 2);

  // Archived badge: counters don't move.
  await ctx.badges.archiveBadge("counted");
  var archedAttempt = await ctx.badges.recordImpression({ slug: "counted", placement: "header" });
  check("recordImpression drop-silent on archived badge", archedAttempt.recorded === false);
  var stillStable = await ctx.badges.getBadge("counted");
  check("archived badge counters frozen", stillStable.impression_count === 3 && stillStable.click_count === 2);
}

async function run() {
  await _defineHappy();
  await _defineRefusals();
  await _activePriorityAndWindow();
  await _renderHtmlChecks();
  await _updateChecks();
  await _archiveChecks();
  await _counterChecks();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("trust-badges: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
