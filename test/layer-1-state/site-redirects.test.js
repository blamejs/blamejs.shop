"use strict";
/**
 * siteRedirects — operator-defined 301/302/307/308 URL redirects with
 * match-kind precedence + hit counter.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0119.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/site-redirects.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - exact match round-trips the row + sets the four redirect codes
 *   - prefix match resolves the longest source_path first
 *   - regex match anchors the pattern (^...$) so a substring source
 *     doesn't trip on a longer request path
 *   - resolveForPath precedence: exact wins over prefix wins over regex
 *   - regex with backreference / lookahead refused at define time
 *   - recordHit increments the running counter AND appends a
 *     site_redirect_hits row; topHits buckets within the window
 *   - archive / unarchive FSM transitions; archived rows drop out of
 *     resolveForPath; idempotent re-archive / re-unarchive return the
 *     existing row
 *   - expires_at cutoff: expired row reads as miss at resolveForPath,
 *     stays on disk until cleanupExpired sweeps it
 *   - updateRedirect rotates individual fields; explicit `null`
 *     expires_at makes a previously-expiring redirect permanent
 *   - input refusals: bad slug / code / match_kind / target_url
 *     (javascript: / protocol-relative) / source_path control bytes /
 *     bogus listRedirects / topHits window
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

require("../../lib");                                                       // ensure entry-point loads + the framework handle works for lazy require
var siteRedirects = require("../../lib/site-redirects");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0119_site_redirects.sql"
);

function _splitSchema(text) {
  // Strip line comments + block comments before splitting on `;`.
  var noLine  = text.replace(/--[^\n]*\n/g, "\n");
  var noBlock = noLine.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _setup() {
  var query = _makeQuery();
  var sr    = siteRedirects.create({ query: query });
  return { query: query, sr: sr };
}

var T0 = Date.now();
function _later(secs) { return T0 + secs * 1000; }

// ---- exact match round-trip + four codes ------------------------------

async function _exactMatch() {
  var s = _setup();

  var rec = await s.sr.defineRedirect({
    slug:        "old-home",
    source_path: "/old-home",
    target_url:  "/new-home",
    code:        301,
    match_kind:  "exact",
    active:      true,
  });
  check("defineRedirect slug",                rec.slug === "old-home");
  check("defineRedirect source_path",         rec.source_path === "/old-home");
  check("defineRedirect target_url",          rec.target_url === "/new-home");
  check("defineRedirect code 301",            rec.code === 301);
  check("defineRedirect match_kind exact",    rec.match_kind === "exact");
  check("defineRedirect active true",         rec.active === true);
  check("defineRedirect hit_count zero",      rec.hit_count === 0);
  check("defineRedirect expires_at null",     rec.expires_at === null);
  check("defineRedirect archived_at null",    rec.archived_at === null);

  var hit = await s.sr.resolveForPath("/old-home");
  check("resolveForPath exact hit",           hit !== null && hit.slug === "old-home");
  check("resolveForPath exact code",          hit.code === 301);

  // Non-matching path -> null.
  var miss = await s.sr.resolveForPath("/nowhere");
  check("resolveForPath miss returns null",   miss === null);

  // The four codes round-trip.
  for (var i = 0; i < siteRedirects.CODES.length; i += 1) {
    var code = siteRedirects.CODES[i];
    var r = await s.sr.defineRedirect({
      slug:        "code-" + code,
      source_path: "/path-" + code,
      target_url:  "https://example.com/new",
      code:        code,
      match_kind:  "exact",
      active:      true,
    });
    check("defineRedirect code " + code,      r.code === code);
  }

  // Refuse unknown code.
  await assert.rejects(s.sr.defineRedirect({
    slug: "bad-code", source_path: "/x", target_url: "/y",
    code: 303, match_kind: "exact", active: true,
  }), /code/);
}

// ---- prefix match — longest source wins -------------------------------

async function _prefixMatch() {
  var s = _setup();

  await s.sr.defineRedirect({
    slug:        "sale-broad",
    source_path: "/sale/",
    target_url:  "/promotions/",
    code:        302,
    match_kind:  "prefix",
    active:      true,
  });
  await s.sr.defineRedirect({
    slug:        "sale-bfcm",
    source_path: "/sale/black-friday/",
    target_url:  "/promotions/bfcm/",
    code:        302,
    match_kind:  "prefix",
    active:      true,
  });

  // Generic prefix.
  var broad = await s.sr.resolveForPath("/sale/spring/widget");
  check("prefix broad match",                 broad !== null && broad.slug === "sale-broad");

  // Specific prefix beats broad.
  var specific = await s.sr.resolveForPath("/sale/black-friday/deal-1");
  check("prefix longest wins",                specific !== null && specific.slug === "sale-bfcm");

  // Path that doesn't start with any prefix -> null.
  var miss = await s.sr.resolveForPath("/about");
  check("prefix miss returns null",           miss === null);
}

// ---- regex match — anchored + refuses backrefs / lookahead -----------

async function _regexMatch() {
  var s = _setup();

  // Year-bucketed blog archive: `/blog/2024/anything` -> /archives/2024/...
  // The regex is anchored at define time so `/blog/2024/foo/extra` matches
  // (the `.+` swallows the tail) and `/blog/2024xyz` does NOT match (no `/`
  // separator).
  await s.sr.defineRedirect({
    slug:        "blog-archive",
    source_path: "/blog/\\d{4}/.+",
    target_url:  "/archives/",
    code:        301,
    match_kind:  "regex",
    active:      true,
  });

  var matched = await s.sr.resolveForPath("/blog/2024/some-post");
  check("regex match hits",                   matched !== null && matched.slug === "blog-archive");

  // Anchored — a substring shape doesn't slip through.
  var notMatched = await s.sr.resolveForPath("/prefix/blog/2024/x");
  check("regex anchored — no substring match", notMatched === null);

  // Pattern that anchored fails -> null.
  var noTail = await s.sr.resolveForPath("/blog/2024/");
  check("regex requires .+ tail",             noTail === null);

  // -- refusals ------------------------------------------------------
  // Backreference.
  await assert.rejects(s.sr.defineRedirect({
    slug: "bad-backref", source_path: "(.)\\1", target_url: "/x",
    code: 301, match_kind: "regex", active: true,
  }), /backreference/);

  // Lookahead.
  await assert.rejects(s.sr.defineRedirect({
    slug: "bad-lookahead", source_path: "/foo(?=bar)", target_url: "/x",
    code: 301, match_kind: "regex", active: true,
  }), /lookahead/);

  // Lookbehind.
  await assert.rejects(s.sr.defineRedirect({
    slug: "bad-lookbehind", source_path: "(?<=foo)bar", target_url: "/x",
    code: 301, match_kind: "regex", active: true,
  }), /lookahead/);

  // Negative lookahead.
  await assert.rejects(s.sr.defineRedirect({
    slug: "bad-neg-lookahead", source_path: "/foo(?!bar)", target_url: "/x",
    code: 301, match_kind: "regex", active: true,
  }), /lookahead/);

  // Nested unbounded quantifier ((a+)+, (a*)*, (?:a+)+ …): catastrophic
  // backtracking that the backref/lookaround walker doesn't catch. The pattern
  // runs against the request path in resolveForPath, so a super-linear match
  // is a per-request DoS; it is refused at define time.
  // `(a|a)*` is the ambiguous-alternation arm of the same class: overlapping
  // branches under an unbounded quantifier backtrack exponentially exactly as
  // `(a+)+` does. The module's previous hand-rolled walker only looked for
  // nested quantifiers and accepted it; b.guardRegex.assertSafe refuses it.
  var redosShapes = ["(a+)+", "(a*)*$", "(?:a+)+", "(.+)+", "((ab)+)+", "(a|a)*b"];
  for (var ri = 0; ri < redosShapes.length; ri += 1) {
    await assert.rejects(s.sr.defineRedirect({
      slug: "bad-redos-" + ri, source_path: redosShapes[ri], target_url: "/x",
      code: 301, match_kind: "regex", active: true,
    }), /nested unbounded quantifier|catastrophic-backtracking|ReDoS/);
  }

  // Regression guard: a LINEAR pattern MUST be accepted. Beyond the quantified
  // non-capturing group and the optional quantified group, this covers the two
  // shapes the screen used to refuse conservatively: an alternation under an
  // unbounded quantifier whose branches are disjoint (`/a(?:b|c)+` — at each
  // position exactly one branch can match, so there is nothing to backtrack
  // into), and a nested quantifier whose repetitions a delimiter makes
  // unambiguous (`/shop/(?:[a-z]+-)*[a-z]+` — `-` is not in `[a-z]`, so the
  // split points are forced). Both are ordinary URL-matching shapes.
  var linearShapes = [
    "/blog(?:/page/\\d+)?", "/foo(?:bar)*", "/foo(?:bar)?", "/p/(?:\\d+)?/edit",
    "/(?:en|fr|de)/blog/.*", "/a(?:b|c)+", "/shop/(?:[a-z]+-)*[a-z]+",
  ];
  for (var li = 0; li < linearShapes.length; li += 1) {
    var okRow = await s.sr.defineRedirect({
      slug: "ok-nc-" + li, source_path: linearShapes[li], target_url: "/dest-" + li,
      code: 301, match_kind: "regex", active: true,
    });
    check("linear non-capturing group accepted: " + linearShapes[li], okRow && okRow.slug === "ok-nc-" + li);
  }
}

// ---- resolveForPath precedence: exact > prefix > regex --------------

async function _precedence() {
  var s = _setup();

  // Three redirects that all could match `/promo/sale`:
  //   * exact   -> /winner-exact
  //   * prefix  -> /loser-prefix
  //   * regex   -> /loser-regex
  await s.sr.defineRedirect({
    slug: "exact-row", source_path: "/promo/sale", target_url: "/winner-exact",
    code: 301, match_kind: "exact", active: true,
  });
  await s.sr.defineRedirect({
    slug: "prefix-row", source_path: "/promo/", target_url: "/loser-prefix",
    code: 301, match_kind: "prefix", active: true,
  });
  await s.sr.defineRedirect({
    slug: "regex-row", source_path: "/promo/.+", target_url: "/loser-regex",
    code: 301, match_kind: "regex", active: true,
  });

  var winner = await s.sr.resolveForPath("/promo/sale");
  check("exact beats prefix beats regex",     winner !== null && winner.slug === "exact-row");

  // Remove the exact row -> prefix wins.
  await s.sr.archiveRedirect("exact-row");
  var prefixWinner = await s.sr.resolveForPath("/promo/sale");
  check("with exact archived, prefix wins",   prefixWinner !== null && prefixWinner.slug === "prefix-row");

  // Remove the prefix row -> regex finally fires.
  await s.sr.archiveRedirect("prefix-row");
  var regexWinner = await s.sr.resolveForPath("/promo/sale");
  check("with exact+prefix archived, regex wins", regexWinner !== null && regexWinner.slug === "regex-row");
}

// ---- recordHit + topHits ---------------------------------------------

async function _hitCounter() {
  var s = _setup();

  await s.sr.defineRedirect({
    slug: "busy", source_path: "/busy", target_url: "/new-busy",
    code: 301, match_kind: "exact", active: true,
  });
  await s.sr.defineRedirect({
    slug: "quiet", source_path: "/quiet", target_url: "/new-quiet",
    code: 301, match_kind: "exact", active: true,
  });

  // Three hits on busy, one on quiet, inside [T0, T0+10000].
  await s.sr.recordHit({ slug: "busy",  occurred_at: T0 + 1000 });
  await s.sr.recordHit({ slug: "busy",  occurred_at: T0 + 2000 });
  await s.sr.recordHit({ slug: "busy",  occurred_at: T0 + 3000 });
  await s.sr.recordHit({ slug: "quiet", occurred_at: T0 + 1500 });
  // One outside the window — must not count.
  await s.sr.recordHit({ slug: "busy",  occurred_at: T0 + 1_000_000 });

  // Running counter on the row.
  var busy  = await s.sr.getRedirect("busy");
  var quiet = await s.sr.getRedirect("quiet");
  check("recordHit increments busy counter",  busy.hit_count === 4);
  check("recordHit increments quiet counter", quiet.hit_count === 1);

  // topHits inside the window.
  var top = await s.sr.topHits({ from: T0, to: T0 + 10000, limit: 10 });
  check("topHits length",                     top.results.length === 2);
  check("topHits busiest first",              top.results[0].slug === "busy" && top.results[0].hits === 3);
  check("topHits second",                     top.results[1].slug === "quiet" && top.results[1].hits === 1);
  check("topHits from passthrough",           top.from === T0);
  check("topHits to passthrough",             top.to === T0 + 10000);

  // recordHit against unknown slug refuses.
  await assert.rejects(s.sr.recordHit({ slug: "missing" }), /not found/);

  // topHits window refusal.
  await assert.rejects(s.sr.topHits({ from: T0 + 100, to: T0 }), /to must be >= from/);
  await assert.rejects(s.sr.topHits({ from: T0, to: T0 + 10, limit: 0 }), /limit/);
}

// ---- archive / unarchive FSM ----------------------------------------

async function _archiveFsm() {
  var s = _setup();

  await s.sr.defineRedirect({
    slug: "rotating", source_path: "/rotating", target_url: "/new-rotating",
    code: 302, match_kind: "exact", active: true,
  });

  // Live row resolves.
  var live = await s.sr.resolveForPath("/rotating");
  check("live row resolves",                  live !== null && live.slug === "rotating");

  // Archive.
  var archived = await s.sr.archiveRedirect("rotating");
  check("archive sets archived_at",           archived.archived_at !== null);

  // Archived row drops out of resolveForPath.
  var archivedMiss = await s.sr.resolveForPath("/rotating");
  check("archived row reads as miss",         archivedMiss === null);

  // Idempotent re-archive returns the row.
  var reArchived = await s.sr.archiveRedirect("rotating");
  check("re-archive idempotent",              reArchived.slug === "rotating" && reArchived.archived_at !== null);

  // Unarchive restores resolution.
  var restored = await s.sr.unarchiveRedirect("rotating");
  check("unarchive clears archived_at",       restored.archived_at === null);
  var restoredHit = await s.sr.resolveForPath("/rotating");
  check("restored row resolves",              restoredHit !== null && restoredHit.slug === "rotating");

  // Idempotent re-unarchive.
  var reUnarchived = await s.sr.unarchiveRedirect("rotating");
  check("re-unarchive idempotent",            reUnarchived.slug === "rotating" && reUnarchived.archived_at === null);

  // Archive / unarchive against unknown slug refuses.
  await assert.rejects(s.sr.archiveRedirect("missing"), /not found/);
  await assert.rejects(s.sr.unarchiveRedirect("missing"), /not found/);

  // listRedirects with active_only respects the `active` flag.
  await s.sr.defineRedirect({
    slug: "inactive", source_path: "/inactive", target_url: "/x",
    code: 301, match_kind: "exact", active: false,
  });
  var all    = await s.sr.listRedirects();
  var actOnly = await s.sr.listRedirects({ active_only: true });
  check("listRedirects all count",            all.length === 2);                  // rotating + inactive
  check("listRedirects active_only count",    actOnly.length === 1);
  check("listRedirects active_only slug",     actOnly[0].slug === "rotating");
}

// ---- expires_at cutoff + cleanupExpired -----------------------------

async function _expiresAtCutoff() {
  var s = _setup();

  // Two expired + one fresh + one permanent (no expires_at).
  await s.sr.defineRedirect({
    slug: "expired-1", source_path: "/expired-1", target_url: "/x",
    code: 301, match_kind: "exact", active: true, expires_at: 100,
  });
  await s.sr.defineRedirect({
    slug: "expired-2", source_path: "/expired-2", target_url: "/x",
    code: 301, match_kind: "exact", active: true, expires_at: 200,
  });
  await s.sr.defineRedirect({
    slug: "fresh", source_path: "/fresh", target_url: "/x",
    code: 301, match_kind: "exact", active: true, expires_at: 9_999_999_999_999,
  });
  await s.sr.defineRedirect({
    slug: "permanent", source_path: "/permanent", target_url: "/x",
    code: 301, match_kind: "exact", active: true,
  });

  // Wall-clock now is well past 200; expired rows must NOT resolve.
  var expMiss = await s.sr.resolveForPath("/expired-1");
  check("expired row reads as miss",          expMiss === null);

  var freshHit = await s.sr.resolveForPath("/fresh");
  check("fresh row resolves",                 freshHit !== null && freshHit.slug === "fresh");

  var permHit = await s.sr.resolveForPath("/permanent");
  check("permanent row resolves",             permHit !== null && permHit.slug === "permanent");

  // Expired rows still on disk pre-cleanup.
  var beforeAll = await s.sr.listRedirects();
  check("expired rows present pre-cleanup",   beforeAll.length === 4);

  // Sweep at now=300; deletes the two with expires_at <= 300.
  var swept = await s.sr.cleanupExpired({ now: 300 });
  check("cleanupExpired swept count",         swept.swept === 2);
  check("cleanupExpired now passthrough",     swept.now === 300);

  var afterAll = await s.sr.listRedirects();
  check("post-cleanup count",                 afterAll.length === 2);

  // Idempotent on second sweep.
  var sweptAgain = await s.sr.cleanupExpired({ now: 300 });
  check("cleanupExpired idempotent",          sweptAgain.swept === 0);

  // updateRedirect with explicit null expires_at makes a redirect
  // permanent. Build a transient redirect that's expiring soon, then
  // rotate its expiry off.
  await s.sr.defineRedirect({
    slug: "soon-permanent", source_path: "/soon-permanent", target_url: "/x",
    code: 301, match_kind: "exact", active: true, expires_at: _later(60),
  });
  var nowPerm = await s.sr.updateRedirect({ slug: "soon-permanent", expires_at: null });
  check("updateRedirect clears expires_at",   nowPerm.expires_at === null);

  // updateRedirect rotates target_url + code while preserving slug.
  var rotated = await s.sr.updateRedirect({
    slug: "soon-permanent", target_url: "/rotated", code: 308,
  });
  check("updateRedirect rotates target_url",  rotated.target_url === "/rotated");
  check("updateRedirect rotates code",        rotated.code === 308);
  check("updateRedirect preserves slug",      rotated.slug === "soon-permanent");

  // updateRedirect against unknown slug refuses.
  await assert.rejects(s.sr.updateRedirect({ slug: "missing", target_url: "/x" }), /not found/);
}

// ---- input refusals --------------------------------------------------

async function _refusals() {
  var s = _setup();

  await assert.rejects(s.sr.defineRedirect(), /input object required/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "BAD SLUG", source_path: "/x", target_url: "/y",
    code: 301, match_kind: "exact", active: true,
  }), /slug/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "x", target_url: "/y",
    code: 301, match_kind: "exact", active: true,
  }), /source_path must be \/-rooted/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "//host/x", target_url: "/y",
    code: 301, match_kind: "exact", active: true,
  }), /protocol-relative/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/has\x00null", target_url: "/y",
    code: 301, match_kind: "exact", active: true,
  }), /control/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "javascript:alert(1)",
    code: 301, match_kind: "exact", active: true,
  }), /target_url/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "//evil.example/",
    code: 301, match_kind: "exact", active: true,
  }), /protocol-relative/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "http://insecure.example/",
    code: 301, match_kind: "exact", active: true,
  }), /target_url/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "/etc/../passwd",
    code: 301, match_kind: "exact", active: true,
  }), /'\.\.'/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "/y",
    code: 200, match_kind: "exact", active: true,
  }), /code/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "/y",
    code: 301, match_kind: "bogus", active: true,
  }), /match_kind/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "/y",
    code: 301, match_kind: "exact", active: "yes",
  }), /active/);
  await assert.rejects(s.sr.defineRedirect({
    slug: "ok", source_path: "/x", target_url: "/y",
    code: 301, match_kind: "exact", active: true, expires_at: -1,
  }), /expires_at/);

  await assert.rejects(s.sr.resolveForPath(""), /path/);
  await assert.rejects(s.sr.resolveForPath("/has\x00null"), /control/);

  await assert.rejects(s.sr.recordHit(), /input object required/);
  await assert.rejects(s.sr.recordHit({ slug: "x", occurred_at: -1 }), /occurred_at/);

  await assert.rejects(s.sr.topHits(), /input object required/);

  await assert.rejects(s.sr.archiveRedirect(""), /slug/);
  await assert.rejects(s.sr.unarchiveRedirect(""), /slug/);
  await assert.rejects(s.sr.getRedirect(123), /slug/);
}

async function run() {
  await _exactMatch();
  await _prefixMatch();
  await _regexMatch();
  await _precedence();
  await _hitCounter();
  await _archiveFsm();
  await _expiresAtCutoff();
  await _refusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - site-redirects (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - site-redirects: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
