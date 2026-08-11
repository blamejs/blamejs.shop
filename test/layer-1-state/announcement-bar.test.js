"use strict";
/**
 * announcement-bar — operator-controlled storefront top-strip primitive.
 * One text announcement renders at a time, picked by theme rank (urgency
 * > promo > info > success) within the active window. Dismissible rows
 * filter out for a session that already closed them.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0180.
 *
 * Coverage:
 *   - defineAnnouncement: persists row, refuses bad input shape,
 *     enforces audience<->segment_slug + link_url<->link_label pairs,
 *     idempotent re-define on same slug.
 *   - activeAnnouncement: theme-rank priority (urgency wins over promo);
 *     time window (starts_at / expires_at) filters out future + past
 *     rows; audience filter routes logged_in vs guest correctly;
 *     segment audience composes the wired-in customerSegments handle.
 *   - recordDismissal: hashes session id via namespaceHash; UNIQUE
 *     constraint collapses duplicate dismissals into one row;
 *     activeAnnouncement honors the dismissal for the matching
 *     session and still surfaces the announcement for a different
 *     session.
 *   - renderHtml: escapes operator input (<script>, on*=, "quote
 *     break"); link_url renders inside escaped href; absent link
 *     omits the <a> entirely.
 *   - updateAnnouncement / archiveAnnouncement: patch path enforces
 *     post-patch invariants; archive is idempotent.
 *   - exported constants.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var announcementBar  = require("../../lib/announcement-bar");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0180_announcement_bar.sql");

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

function _factory(extra) {
  var h = _makeQuery();
  var createOpts = { query: h.query };
  if (extra && extra.customerSegments) createOpts.customerSegments = extra.customerSegments;
  return {
    db:    h.db,
    query: h.query,
    ann:   announcementBar.create(createOpts),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- defineAnnouncement shape -------------------------------------------

async function _defineShape() {
  var f = _factory();

  var row = await f.ann.defineAnnouncement({
    slug:        "free-shipping-promo",
    message:     "Free shipping on orders over $50",
    link_url:    "/collections/all",
    link_label:  "Shop now",
    theme:       "promo",
    audience:    "all",
    dismissible: true,
  });
  check("defineAnnouncement returns hydrated row",  row && row.slug === "free-shipping-promo");
  check("defineAnnouncement persists message",      row.message === "Free shipping on orders over $50");
  check("defineAnnouncement persists theme",        row.theme === "promo");
  check("defineAnnouncement persists audience",     row.audience === "all");
  check("defineAnnouncement coerces dismissible",   row.dismissible === true);
  check("defineAnnouncement link pair preserved",   row.link_url === "/collections/all" && row.link_label === "Shop now");
  check("defineAnnouncement created_at set",        Number.isInteger(row.created_at) && row.created_at > 0);

  // Idempotent re-define: same slug updates the row in place,
  // updated_at moves forward, created_at stays.
  var initialCreatedAt = row.created_at;
  var initialUpdatedAt = row.updated_at;
  var redef = await f.ann.defineAnnouncement({
    slug:        "free-shipping-promo",
    message:     "Free shipping on orders over $35",
    theme:       "promo",
    audience:    "all",
    dismissible: false,
  });
  check("re-define preserves created_at",            redef.created_at === initialCreatedAt);
  check("re-define advances updated_at",             redef.updated_at > initialUpdatedAt);
  check("re-define updates message",                 redef.message === "Free shipping on orders over $35");
  check("re-define drops optional link",             redef.link_url === null && redef.link_label === null);
  check("re-define flips dismissible",               redef.dismissible === false);

  // link_url without link_label is refused.
  await assert.rejects(function () {
    return f.ann.defineAnnouncement({
      slug: "broken-link", message: "x", theme: "info", audience: "all",
      dismissible: false, link_url: "/a",
    });
  }, /link_url and link_label/);

  // audience=segment without segment_slug refused.
  await assert.rejects(function () {
    return f.ann.defineAnnouncement({
      slug: "missing-segment", message: "x", theme: "info",
      audience: "segment", dismissible: false,
    });
  }, /requires segment_slug/);

  // segment_slug without audience=segment refused.
  await assert.rejects(function () {
    return f.ann.defineAnnouncement({
      slug: "stray-segment", message: "x", theme: "info",
      audience: "all", segment_slug: "vip", dismissible: false,
    });
  }, /only valid when audience/);

  // Control bytes / newlines refused.
  await assert.rejects(function () {
    return f.ann.defineAnnouncement({
      slug: "bad-msg", message: "line one\nline two", theme: "info",
      audience: "all", dismissible: false,
    });
  }, /must be a single line/);

  // expires_at <= starts_at refused.
  await assert.rejects(function () {
    return f.ann.defineAnnouncement({
      slug: "bad-window", message: "x", theme: "info",
      audience: "all", dismissible: false,
      starts_at: 2000, expires_at: 1000,
    });
  }, /expires_at must be strictly greater/);

  // Theme outside enum refused.
  await assert.rejects(function () {
    return f.ann.defineAnnouncement({
      slug: "bad-theme", message: "x", theme: "danger",
      audience: "all", dismissible: false,
    });
  }, /theme must be one of/);
}

// ---- activeAnnouncement priority ---------------------------------------

async function _activePriority() {
  var f = _factory();
  var t0 = Date.now();

  await f.ann.defineAnnouncement({
    slug: "ann-info",    message: "We're hiring",         theme: "info",
    audience: "all", dismissible: false,
  });
  await f.ann.defineAnnouncement({
    slug: "ann-promo",   message: "30% off this weekend", theme: "promo",
    audience: "all", dismissible: false,
  });
  await f.ann.defineAnnouncement({
    slug: "ann-urgency", message: "Last day for free shipping", theme: "urgency",
    audience: "all", dismissible: false,
  });
  await f.ann.defineAnnouncement({
    slug: "ann-success", message: "Thanks for shopping", theme: "success",
    audience: "all", dismissible: false,
  });

  var pick = await f.ann.activeAnnouncement({ now: t0 + 1000, viewer_kind: "guest" });
  check("urgency wins over promo / info / success", pick && pick.slug === "ann-urgency");

  // Archive urgency, promo should win next.
  await f.ann.archiveAnnouncement("ann-urgency");
  var pick2 = await f.ann.activeAnnouncement({ now: t0 + 2000, viewer_kind: "guest" });
  check("promo wins once urgency is archived",      pick2 && pick2.slug === "ann-promo");

  await f.ann.archiveAnnouncement("ann-promo");
  var pick3 = await f.ann.activeAnnouncement({ now: t0 + 3000, viewer_kind: "guest" });
  check("info wins once promo is archived",         pick3 && pick3.slug === "ann-info");
}

// ---- activeAnnouncement window -----------------------------------------

async function _activeWindow() {
  var f = _factory();
  var t = 1700000000000;

  await f.ann.defineAnnouncement({
    slug: "future", message: "Black Friday is coming", theme: "info",
    audience: "all", dismissible: false,
    starts_at: t + 1000, expires_at: t + 5000,
  });
  await f.ann.defineAnnouncement({
    slug: "now", message: "Today only", theme: "info",
    audience: "all", dismissible: false,
    starts_at: t - 1000, expires_at: t + 1000,
  });
  await f.ann.defineAnnouncement({
    slug: "past", message: "Was a sale", theme: "info",
    audience: "all", dismissible: false,
    starts_at: t - 5000, expires_at: t - 1000,
  });
  await f.ann.defineAnnouncement({
    slug: "unbounded", message: "Always on", theme: "success",
    audience: "all", dismissible: false,
  });

  var picked = await f.ann.activeAnnouncement({ now: t, viewer_kind: "guest" });
  check("window: 'now' row is selected over success-rank unbounded", picked && picked.slug === "now");

  // Slide forward past every bounded window — only the unbounded
  // (success-rank) row remains.
  var late = await f.ann.activeAnnouncement({ now: t + 100000, viewer_kind: "guest" });
  check("window: only unbounded survives past every bounded window", late && late.slug === "unbounded");

  // Slide backward before every starts_at — only the unbounded row
  // remains (no starts_at => active immediately, including times
  // before any other row's starts_at).
  var early = await f.ann.activeAnnouncement({ now: t - 100000, viewer_kind: "guest" });
  check("window: unbounded selected before any bounded row's starts_at", early && early.slug === "unbounded");
}

// ---- activeAnnouncement audience ---------------------------------------

async function _activeAudience() {
  var fakeSegments = {
    _members: Object.create(null),
    add: function (cust, seg) { this._members[cust + "::" + seg] = true; },
    isMember: async function (cust, seg) { return !!this._members[cust + "::" + seg]; },
  };
  var f = _factory({ customerSegments: fakeSegments });

  await f.ann.defineAnnouncement({
    slug: "logged-only", message: "Welcome back", theme: "info",
    audience: "logged_in", dismissible: false,
  });
  await f.ann.defineAnnouncement({
    slug: "guest-only", message: "Sign up for 10% off", theme: "promo",
    audience: "guest", dismissible: false,
  });
  await f.ann.defineAnnouncement({
    slug: "vip-only", message: "Early access for VIPs", theme: "urgency",
    audience: "segment", segment_slug: "vip", dismissible: false,
  });

  var cust = _uuid();
  fakeSegments.add(cust, "vip");

  var guestPick = await f.ann.activeAnnouncement({ now: Date.now(), viewer_kind: "guest" });
  check("guest viewer gets guest-only announcement", guestPick && guestPick.slug === "guest-only");

  var loggedPick = await f.ann.activeAnnouncement({
    now: Date.now(), viewer_kind: "logged_in", customer_id: cust,
  });
  // VIP segment is urgency-rank, beats the logged_in info row.
  check("logged_in + segment-member gets segment row",
    loggedPick && loggedPick.slug === "vip-only");

  var otherCust = _uuid();
  var loggedNonVip = await f.ann.activeAnnouncement({
    now: Date.now(), viewer_kind: "logged_in", customer_id: otherCust,
  });
  // Non-VIP falls through to the logged_in info row.
  check("logged_in non-segment-member skips segment row",
    loggedNonVip && loggedNonVip.slug === "logged-only");

  // viewer_kind=guest with customer_id is refused.
  await assert.rejects(function () {
    return f.ann.activeAnnouncement({
      now: Date.now(), viewer_kind: "guest", customer_id: cust,
    });
  }, /must not carry customer_id/);

  // viewer_kind=logged_in without customer_id is refused.
  await assert.rejects(function () {
    return f.ann.activeAnnouncement({
      now: Date.now(), viewer_kind: "logged_in",
    });
  }, /requires customer_id/);
}

// ---- activeAnnouncement: no segments handle ----------------------------

async function _activeSegmentHandleMissing() {
  var f = _factory();
  await f.ann.defineAnnouncement({
    slug: "vip-only", message: "VIP", theme: "urgency",
    audience: "segment", segment_slug: "vip", dismissible: false,
  });
  await assert.rejects(function () {
    return f.ann.activeAnnouncement({
      now: Date.now(), viewer_kind: "logged_in", customer_id: _uuid(),
    });
  }, /no customerSegments handle/);
}

// ---- recordDismissal dedup --------------------------------------------

async function _dismissalDedup() {
  var f = _factory();
  var t = Date.now();

  await f.ann.defineAnnouncement({
    slug: "dismiss-me", message: "Click X to hide", theme: "info",
    audience: "all", dismissible: true,
  });

  var session1 = "sess-" + _uuid();
  var session2 = "sess-" + _uuid();

  var d1 = await f.ann.recordDismissal({ slug: "dismiss-me", session_id: session1, occurred_at: t });
  check("first dismissal recorded",                d1.recorded === true);
  check("session_id hashed (not raw)",             d1.session_id_hash !== session1
                                                    && d1.session_id_hash.length > 64);

  var d2 = await f.ann.recordDismissal({ slug: "dismiss-me", session_id: session1, occurred_at: t + 100 });
  check("duplicate dismissal collapsed (no-op)",    d2.recorded === false);
  check("duplicate dismissal returns same hash",    d2.session_id_hash === d1.session_id_hash);

  // Confirm only one row in the dismissal table.
  var count = (await f.query("SELECT COUNT(*) AS c FROM announcement_dismissals", [])).rows[0].c;
  check("dismissals table has exactly one row",     Number(count) === 1);

  // activeAnnouncement honors the dismissal for session1, returns
  // the row for session2 (which never dismissed).
  var pick1 = await f.ann.activeAnnouncement({
    now: t + 200, viewer_kind: "guest", session_id: session1,
  });
  check("session1 sees no announcement (dismissed)", pick1 === null);

  var pick2 = await f.ann.activeAnnouncement({
    now: t + 200, viewer_kind: "guest", session_id: session2,
  });
  check("session2 still sees announcement",          pick2 && pick2.slug === "dismiss-me");

  // recordDismissal on unknown slug refused.
  await assert.rejects(function () {
    return f.ann.recordDismissal({ slug: "no-such-slug", session_id: session1 });
  }, /not found/);
}

// ---- renderHtml escapes XSS --------------------------------------------

async function _renderHtmlXssSafe() {
  var f = _factory();
  var row = await f.ann.defineAnnouncement({
    slug:        "safe-render",
    message:     "Hi there", // The operator never gets to author angle brackets — control-byte / zero-width sweep blocks shape attacks at the boundary. We force the post-define mutation below to exercise escapeHtml on adversarial input.
    link_url:    "/landing",
    link_label:  "Click here",
    theme:       "info",
    audience:    "all",
    dismissible: true,
  });

  // Simulate an upstream caller passing an announcement object that
  // somehow carries adversarial fields (e.g. read from a different
  // store, or a future code path that doesn't yet go through
  // defineAnnouncement's validation). renderHtml is the last line of
  // defense — it must escapeHtml every field.
  var adversarial = {
    slug:        row.slug,
    message:     '<script>alert("xss")</script>&"\'',
    link_url:    "/path?a=1&b=2",
    link_label:  '<img src=x onerror=alert(1)>',
    theme:       "info",
    dismissible: true,
  };
  var html = f.ann.renderHtml({ announcement: adversarial });

  check("renderHtml escapes <script>",           html.indexOf("<script>") === -1);
  check("renderHtml escapes raw <img tag",       html.indexOf("<img ") === -1);
  check("renderHtml emits escaped &lt;script",   html.indexOf("&lt;script&gt;") !== -1);
  check("renderHtml escapes & in href",          html.indexOf('href="/path?a=1&amp;b=2"') !== -1);
  check("renderHtml escapes & in message text",  html.indexOf("&amp;&quot;") !== -1
                                                  || html.indexOf("&amp;\"") !== -1
                                                  || html.indexOf("&quot;") !== -1);
  check("renderHtml wraps in announcement-bar",  html.indexOf('class="announcement-bar announcement-bar--info"') !== -1);
  check("renderHtml emits dismiss button",       html.indexOf('class="announcement-bar__dismiss"') !== -1);
  check("renderHtml emits data-announcement-slug", html.indexOf('data-announcement-slug="safe-render"') !== -1);

  // Without link, no <a> tag is emitted.
  var noLink = f.ann.renderHtml({
    announcement: {
      slug: row.slug, message: "Plain text only", theme: "promo", dismissible: false,
    },
  });
  check("renderHtml omits <a> when no link",     noLink.indexOf("<a ") === -1);
  check("renderHtml omits dismiss when !dismissible", noLink.indexOf("announcement-bar__dismiss") === -1);
  check("renderHtml carries theme class",        noLink.indexOf("announcement-bar--promo") !== -1);
}

// ---- updateAnnouncement / archiveAnnouncement --------------------------

async function _updateAndArchive() {
  var f = _factory();
  await f.ann.defineAnnouncement({
    slug: "edit-me", message: "v1", theme: "info",
    audience: "all", dismissible: false,
  });

  var updated = await f.ann.updateAnnouncement("edit-me", {
    message: "v2", theme: "promo",
  });
  check("updateAnnouncement applies patch",         updated.message === "v2" && updated.theme === "promo");

  // Unsupported column refused.
  await assert.rejects(function () {
    return f.ann.updateAnnouncement("edit-me", { archived_at: 0 });
  }, /unsupported column/);

  // Cross-column invariant: switching audience to segment without
  // segment_slug is refused.
  await assert.rejects(function () {
    return f.ann.updateAnnouncement("edit-me", { audience: "segment" });
  }, /requires segment_slug/);

  // Cross-column invariant: switching to segment with the slug is fine.
  var withSeg = await f.ann.updateAnnouncement("edit-me", {
    audience: "segment", segment_slug: "vip",
  });
  check("update audience->segment with slug",       withSeg.audience === "segment" && withSeg.segment_slug === "vip");

  // Archive then verify it stops appearing in activeAnnouncement.
  var arch = await f.ann.archiveAnnouncement("edit-me");
  check("archiveAnnouncement sets archived_at",     arch.archived_at != null && arch.archived_at > 0);

  // Archive again is idempotent (returns the existing row).
  var archAgain = await f.ann.archiveAnnouncement("edit-me");
  check("archiveAnnouncement is idempotent",        archAgain.archived_at === arch.archived_at);

  // Updating an archived row is refused.
  await assert.rejects(function () {
    return f.ann.updateAnnouncement("edit-me", { message: "v3" });
  }, /is archived/);

  // Re-defining an archived slug is refused (operator must un-
  // archive intentionally; the primitive doesn't expose unarchive,
  // matching the "archive is terminal until the operator manually
  // resets it" convention).
  await assert.rejects(function () {
    return f.ann.defineAnnouncement({
      slug: "edit-me", message: "v4", theme: "info",
      audience: "all", dismissible: false,
    });
  }, /is archived/);
}

// ---- listAnnouncements -------------------------------------------------

async function _listAnnouncements() {
  var f = _factory();
  var t = Date.now();

  await f.ann.defineAnnouncement({
    slug: "a", message: "alpha", theme: "info", audience: "all", dismissible: false,
  });
  await f.ann.defineAnnouncement({
    slug: "b", message: "beta",  theme: "info", audience: "all", dismissible: false,
    starts_at: t + 100000, expires_at: t + 200000,  // future
  });
  await f.ann.defineAnnouncement({
    slug: "c", message: "gamma", theme: "info", audience: "all", dismissible: false,
  });
  await f.ann.archiveAnnouncement("c");

  var all = await f.ann.listAnnouncements();
  check("listAnnouncements returns all rows (incl. archived)", all.length === 3);

  var activeOnly = await f.ann.listAnnouncements({ active_only: true });
  check("listAnnouncements active_only filters archived + future",
    activeOnly.length === 1 && activeOnly[0].slug === "a");
}

// ---- exported constants ------------------------------------------------

async function _exportedConstants() {
  check("ALLOWED_THEMES exported",       Array.isArray(announcementBar.ALLOWED_THEMES)
                                          && announcementBar.ALLOWED_THEMES.indexOf("urgency") !== -1);
  check("ALLOWED_AUDIENCES exported",    Array.isArray(announcementBar.ALLOWED_AUDIENCES)
                                          && announcementBar.ALLOWED_AUDIENCES.indexOf("segment") !== -1);
  check("SESSION_HASH_NAMESPACE export", typeof announcementBar.SESSION_HASH_NAMESPACE === "string"
                                          && announcementBar.SESSION_HASH_NAMESPACE.length > 0);

  var inst = announcementBar.create({ query: _makeQuery().query });
  check("instance exposes ALLOWED_THEMES",    inst.ALLOWED_THEMES.length === announcementBar.ALLOWED_THEMES.length);
  check("instance exposes defineAnnouncement",typeof inst.defineAnnouncement === "function");
  check("instance exposes activeAnnouncement",typeof inst.activeAnnouncement === "function");
  check("instance exposes recordDismissal",   typeof inst.recordDismissal    === "function");
  check("instance exposes renderHtml",        typeof inst.renderHtml         === "function");
}

async function run() {
  await _defineShape();
  await _activePriority();
  await _activeWindow();
  await _activeAudience();
  await _activeSegmentHandleMissing();
  await _dismissalDedup();
  await _renderHtmlXssSafe();
  await _updateAndArchive();
  await _listAnnouncements();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - announcement-bar (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
