"use strict";
/**
 * cookie-consent — GDPR / ePrivacy per-session category opt-in records
 * with DNT / Sec-GPC honored as implicit deny for analytics + marketing.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0103.
 *
 * Coverage:
 *   - recordConsent persists every toggleable category + categoryAllowed
 *     reads each one back; strictly-necessary always true; missing
 *     session defaults deny
 *   - DNT short-circuits analytics + marketing regardless of recorded
 *     consent; functional + preferences still honored
 *   - GPC (Sec-GPC) short-circuits the same two categories
 *   - withdrawConsent flips every toggleable category to deny on the
 *     next read; double-withdraw is idempotent; no-prior returns null
 *   - registerPolicyVersion + policyVersion setter both flag older
 *     records for re-prompt; a fresh record under the new version
 *     comes back without the flag
 *   - metricsForBanner bucketises accept-all / reject-all / mixed and
 *     respects the from / to window; DNT does not collapse the buckets
 *   - cleanupOlderThan deletes aged-out audit rows but preserves the
 *     latest record per session
 *   - factory + input-shape refusals (bad session_id, unknown category
 *     key, strictly_necessary=false, bad ua_class, bad policy_version,
 *     non-positive cleanup days, from >= to)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

require("../../lib");                                                       // ensure entry-point loads + the framework handle works for lazy require
var cookieConsent = require("../../lib/cookie-consent");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0103_cookie_consent.sql"
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
  var cc    = cookieConsent.create({ query: query });
  return { query: query, cc: cc };
}

async function _recordAndReadBack() {
  var ctx = _setup();
  var rec = await ctx.cc.recordConsent({
    session_id: "session-alpha",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          false,
      marketing:          false,
      preferences:        true,
    },
    ip_hash:  "ip-hash-1",
    ua_class: "desktop",
  });
  check("recordConsent returns object",            rec && typeof rec === "object");
  check("recordConsent stamps id",                 typeof rec.id === "string" && rec.id.length > 0);
  check("recordConsent hashes session id",         typeof rec.session_id_hash === "string"
                                                   && rec.session_id_hash.length > 0
                                                   && rec.session_id_hash !== "session-alpha");
  check("recordConsent stamps policy_version",     rec.policy_version === "v1");
  check("recordConsent strictly_necessary on",     rec.categories.strictly_necessary === true);
  check("recordConsent functional persisted",      rec.categories.functional === true);
  check("recordConsent analytics persisted",       rec.categories.analytics === false);
  check("recordConsent marketing persisted",       rec.categories.marketing === false);
  check("recordConsent preferences persisted",     rec.categories.preferences === true);
  check("recordConsent ip_hash round-trip",        rec.ip_hash === "ip-hash-1");
  check("recordConsent ua_class round-trip",      rec.ua_class === "desktop");
  check("recordConsent occurred_at stamped",       typeof rec.occurred_at === "number");
  check("recordConsent withdrawn_at null",         rec.withdrawn_at === null);
  check("recordConsent needs_reprompt false",      rec.needs_reprompt === false);

  // categoryAllowed reads each toggle back through the gate.
  var allowSN = await ctx.cc.categoryAllowed({ session_id: "session-alpha", category: "strictly_necessary" });
  check("categoryAllowed strictly_necessary true",   allowSN === true);
  var allowFn = await ctx.cc.categoryAllowed({ session_id: "session-alpha", category: "functional" });
  check("categoryAllowed functional true",           allowFn === true);
  var allowAn = await ctx.cc.categoryAllowed({ session_id: "session-alpha", category: "analytics" });
  check("categoryAllowed analytics false",           allowAn === false);
  var allowMk = await ctx.cc.categoryAllowed({ session_id: "session-alpha", category: "marketing" });
  check("categoryAllowed marketing false",           allowMk === false);
  var allowPr = await ctx.cc.categoryAllowed({ session_id: "session-alpha", category: "preferences" });
  check("categoryAllowed preferences true",          allowPr === true);

  // Missing-session default-deny: strictly_necessary still on, others off.
  var unknownSN = await ctx.cc.categoryAllowed({ session_id: "no-record", category: "strictly_necessary" });
  check("categoryAllowed unknown-session SN true",   unknownSN === true);
  var unknownAn = await ctx.cc.categoryAllowed({ session_id: "no-record", category: "analytics" });
  check("categoryAllowed unknown-session deny",      unknownAn === false);

  // getConsentFor returns the row; unknown session is null.
  var got = await ctx.cc.getConsentFor("session-alpha");
  check("getConsentFor returns persisted row",       got && got.id === rec.id);
  var miss = await ctx.cc.getConsentFor("no-record");
  check("getConsentFor unknown -> null",             miss === null);
}

async function _dntForcesImplicitDeny() {
  var ctx = _setup();
  // Stored opt-IN to every category, but DNT=true on the row.
  await ctx.cc.recordConsent({
    session_id: "session-dnt",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          true,
      marketing:          true,
      preferences:        true,
    },
    dnt: true,
  });

  var an = await ctx.cc.categoryAllowed({ session_id: "session-dnt", category: "analytics" });
  check("DNT denies analytics despite opt-in",       an === false);
  var mk = await ctx.cc.categoryAllowed({ session_id: "session-dnt", category: "marketing" });
  check("DNT denies marketing despite opt-in",       mk === false);

  // Functional + preferences are NOT in the DNT implicit-deny set.
  var fn = await ctx.cc.categoryAllowed({ session_id: "session-dnt", category: "functional" });
  check("DNT does not deny functional",              fn === true);
  var pr = await ctx.cc.categoryAllowed({ session_id: "session-dnt", category: "preferences" });
  check("DNT does not deny preferences",             pr === true);

  // Row records the signal for the audit trail.
  var rec = await ctx.cc.getConsentFor("session-dnt");
  check("DNT signal persisted on row",               rec.dnt === true);
  check("DNT row reports stored opt-in shape",       rec.categories.marketing === true
                                                     && rec.categories.analytics === true);
}

async function _gpcForcesImplicitDeny() {
  var ctx = _setup();
  await ctx.cc.recordConsent({
    session_id: "session-gpc",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          true,
      marketing:          true,
      preferences:        true,
    },
    gpc: true,
  });

  var an = await ctx.cc.categoryAllowed({ session_id: "session-gpc", category: "analytics" });
  check("GPC denies analytics despite opt-in",       an === false);
  var mk = await ctx.cc.categoryAllowed({ session_id: "session-gpc", category: "marketing" });
  check("GPC denies marketing despite opt-in",       mk === false);

  var fn = await ctx.cc.categoryAllowed({ session_id: "session-gpc", category: "functional" });
  check("GPC does not deny functional",              fn === true);
  var pr = await ctx.cc.categoryAllowed({ session_id: "session-gpc", category: "preferences" });
  check("GPC does not deny preferences",             pr === true);

  var rec = await ctx.cc.getConsentFor("session-gpc");
  check("GPC signal persisted on row",               rec.gpc === true);
}

async function _withdrawFlipsLaterReads() {
  var ctx = _setup();
  await ctx.cc.recordConsent({
    session_id: "session-withdraw",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          true,
      marketing:          true,
      preferences:        true,
    },
  });

  // Pre-withdraw: opted in to marketing.
  var beforeMk = await ctx.cc.categoryAllowed({ session_id: "session-withdraw", category: "marketing" });
  check("pre-withdraw marketing allowed",            beforeMk === true);

  var w = await ctx.cc.withdrawConsent({
    session_id: "session-withdraw",
    reason:     "operator UI button",
  });
  check("withdrawConsent returns new row",           w && typeof w === "object");
  check("withdrawConsent stamps withdrawn_at",       typeof w.withdrawn_at === "number");
  check("withdrawConsent persists reason",           w.withdrawal_reason === "operator UI button");
  check("withdrawConsent zeros functional",          w.categories.functional   === false);
  check("withdrawConsent zeros analytics",           w.categories.analytics    === false);
  check("withdrawConsent zeros marketing",           w.categories.marketing    === false);
  check("withdrawConsent zeros preferences",         w.categories.preferences  === false);
  check("withdrawConsent strictly_necessary on",     w.categories.strictly_necessary === true);

  // Post-withdraw: every toggleable category denies.
  var afterFn = await ctx.cc.categoryAllowed({ session_id: "session-withdraw", category: "functional" });
  check("post-withdraw functional denied",           afterFn === false);
  var afterMk = await ctx.cc.categoryAllowed({ session_id: "session-withdraw", category: "marketing" });
  check("post-withdraw marketing denied",            afterMk === false);
  // Strictly-necessary survives.
  var afterSN = await ctx.cc.categoryAllowed({ session_id: "session-withdraw", category: "strictly_necessary" });
  check("post-withdraw SN still allowed",            afterSN === true);

  // Double-withdraw is idempotent — same row id back, no duplicate stack.
  var w2 = await ctx.cc.withdrawConsent({ session_id: "session-withdraw" });
  check("double-withdraw returns prior row",         w2.id === w.id);
  check("double-withdraw preserves original reason", w2.withdrawal_reason === "operator UI button");

  // No prior consent for the session -> null.
  var none = await ctx.cc.withdrawConsent({ session_id: "session-never" });
  check("withdrawConsent with no prior -> null",     none === null);
}

async function _policyBumpFlagsReprompt() {
  var ctx = _setup();
  await ctx.cc.recordConsent({
    session_id: "session-policy",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          false,
      marketing:          false,
      preferences:        false,
    },
  });

  var pre = await ctx.cc.getConsentFor("session-policy");
  check("pre-bump policy_version v1",                pre.policy_version === "v1");
  check("pre-bump needs_reprompt false",             pre.needs_reprompt === false);

  // Bump via registerPolicyVersion.
  var reg = await ctx.cc.registerPolicyVersion({
    version: "v2",
    summary: "added Klaviyo analytics",
  });
  check("registerPolicyVersion returns row",         reg && reg.version === "v2");
  check("registerPolicyVersion persists summary",    reg.summary === "added Klaviyo analytics");
  check("registerPolicyVersion stamps effective",    typeof reg.effective_from === "number");
  check("policyVersion getter reflects bump",        ctx.cc.policyVersion === "v2");

  // Older record now flagged.
  var post = await ctx.cc.getConsentFor("session-policy");
  check("post-bump needs_reprompt true",             post.needs_reprompt === true);
  check("post-bump still reports old version",       post.policy_version === "v1");

  // Fresh record under the new policy is clean.
  var fresh = await ctx.cc.recordConsent({
    session_id: "session-fresh",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          true,
      marketing:          false,
      preferences:        false,
    },
  });
  check("fresh record stamped v2",                   fresh.policy_version === "v2");
  check("fresh record needs_reprompt false",         fresh.needs_reprompt === false);

  // Direct setter on policyVersion also flags older records.
  ctx.cc.policyVersion = "v3";
  check("policyVersion setter sticks",               ctx.cc.policyVersion === "v3");
  var afterSetter = await ctx.cc.getConsentFor("session-fresh");
  check("setter bump flags v2 row",                  afterSetter.needs_reprompt === true);

  // Idempotent re-register of the same version is a no-op.
  var again = await ctx.cc.registerPolicyVersion({ version: "v2", summary: "re-register no-op" });
  check("re-register returns v2",                    again.version === "v2");
  check("re-register flips active back to v2",       ctx.cc.policyVersion === "v2");
}

async function _metricsBuckets() {
  var ctx = _setup();
  var t0 = Date.now() - 60 * 1000;
  var t1 = Date.now() + 60 * 1000;

  // Accept-all row.
  await ctx.cc.recordConsent({
    session_id: "session-accept",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          true,
      marketing:          true,
      preferences:        true,
    },
  });
  // Reject-all row.
  await ctx.cc.recordConsent({
    session_id: "session-reject",
    categories: {
      strictly_necessary: true,
      functional:         false,
      analytics:          false,
      marketing:          false,
      preferences:        false,
    },
  });
  // Mixed row.
  await ctx.cc.recordConsent({
    session_id: "session-mixed",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          false,
      marketing:          true,
      preferences:        false,
    },
  });
  // Second accept-all row (different session) — and DNT to confirm DNT
  // does NOT collapse bucketing.
  await ctx.cc.recordConsent({
    session_id: "session-accept-dnt",
    categories: {
      strictly_necessary: true,
      functional:         true,
      analytics:          true,
      marketing:          true,
      preferences:        true,
    },
    dnt: true,
  });

  var m = await ctx.cc.metricsForBanner({ from: t0, to: t1 });
  check("metrics accept_all = 2",                    m.accept_all === 2);
  check("metrics reject_all = 1",                    m.reject_all === 1);
  check("metrics mixed = 1",                         m.mixed === 1);

  // Window-exclusive upper / inclusive lower: an out-of-window query
  // returns zero counts.
  var far = await ctx.cc.metricsForBanner({ from: 1, to: 2 });
  check("metrics window-miss zeros accept_all",      far.accept_all === 0);
  check("metrics window-miss zeros reject_all",      far.reject_all === 0);
  check("metrics window-miss zeros mixed",           far.mixed === 0);
}

async function _cleanupOlderThanWalk() {
  var ctx = _setup();

  // Two sessions, three rows each — first two rows old, last row fresh.
  var sessionHashes = [];
  for (var s = 0; s < 2; s += 1) {
    var sid = "session-cleanup-" + s;
    for (var i = 0; i < 3; i += 1) {
      var rec = await ctx.cc.recordConsent({
        session_id: sid,
        categories: {
          strictly_necessary: true,
          functional:         i === 2,
          analytics:          false,
          marketing:          false,
          preferences:        false,
        },
      });
      if (i === 0) sessionHashes.push(rec.session_id_hash);
    }
  }

  // Backdate the first two rows for each session past the 30d window.
  var dayMs   = 86400 * 1000;
  var oldStamp = Date.now() - 90 * dayMs;
  for (var h = 0; h < sessionHashes.length; h += 1) {
    await ctx.query(
      "UPDATE cookie_consent_records SET occurred_at = ?1 " +
      "WHERE session_id_hash = ?2 " +
      "AND id IN (SELECT id FROM cookie_consent_records " +
      "           WHERE session_id_hash = ?2 " +
      "           ORDER BY occurred_at ASC LIMIT 2)",
      [oldStamp, sessionHashes[h]],
    );
  }

  // Pre-cleanup row count.
  var preAll = await ctx.query("SELECT COUNT(*) AS n FROM cookie_consent_records", []);
  check("pre-cleanup: 6 rows total",                 Number(preAll.rows[0].n) === 6);

  var r = await ctx.cc.cleanupOlderThan(30);
  check("cleanupOlderThan reports deletions",        r.deleted === 4);

  // Latest row per session must survive.
  var postAll = await ctx.query("SELECT COUNT(*) AS n FROM cookie_consent_records", []);
  check("post-cleanup: 2 rows survive",              Number(postAll.rows[0].n) === 2);

  for (var k = 0; k < 2; k += 1) {
    var live = await ctx.cc.getConsentFor("session-cleanup-" + k);
    check("post-cleanup latest survives s" + k,        live !== null);
    check("post-cleanup latest is the fresh row s" + k, live.categories.functional === true);
  }
}

async function _factoryAndInputRefusals() {
  var ctx = _setup();

  // Factory call works without `query` (would fall through to externalDb
  // but we don't exercise that path here — only assert the factory
  // surface is callable + returns the documented constants).
  var bare = cookieConsent.create();
  check("create() returns object",                   bare && typeof bare === "object");
  check("create() exposes CATEGORY_KEYS",            Array.isArray(bare.CATEGORY_KEYS)
                                                     && bare.CATEGORY_KEYS.length === 5);
  check("create() exposes TOGGLEABLE",               Array.isArray(bare.TOGGLEABLE_CATEGORIES)
                                                     && bare.TOGGLEABLE_CATEGORIES.length === 4);
  check("create() exposes DNT_GPC list",             Array.isArray(bare.DNT_GPC_IMPLICIT_DENY)
                                                     && bare.DNT_GPC_IMPLICIT_DENY.indexOf("analytics") !== -1
                                                     && bare.DNT_GPC_IMPLICIT_DENY.indexOf("marketing") !== -1);
  check("module re-exports constants",               cookieConsent.CATEGORY_KEYS.length === 5);

  // recordConsent: missing input.
  await assert.rejects(ctx.cc.recordConsent(null),               /input object required/);
  // bad session_id.
  await assert.rejects(ctx.cc.recordConsent({
    session_id: "",
    categories: { strictly_necessary: true, functional: true, analytics: false, marketing: false, preferences: false },
  }), /session_id/);
  await assert.rejects(ctx.cc.recordConsent({
    session_id: "ok",
    categories: { strictly_necessary: true, functional: true, analytics: false, marketing: false, preferences: false },
    ua_class:   "smartwatch",
  }), /ua_class/);

  // categories: missing object.
  await assert.rejects(ctx.cc.recordConsent({
    session_id: "ok",
    categories: null,
  }), /categories/);

  // categories: unknown key.
  await assert.rejects(ctx.cc.recordConsent({
    session_id: "ok",
    categories: { strictly_necessary: true, marketting: true },
  }), /unknown category/);

  // categories: strictly_necessary=false refused.
  await assert.rejects(ctx.cc.recordConsent({
    session_id: "ok",
    categories: { strictly_necessary: false, functional: true, analytics: false, marketing: false, preferences: false },
  }), /implicit-on/);

  // categories: non-boolean toggle.
  await assert.rejects(ctx.cc.recordConsent({
    session_id: "ok",
    categories: { functional: "yes" },
  }), /must be a boolean/);

  // policyVersion setter: bad shape.
  assert.throws(function () { ctx.cc.policyVersion = "v1 with space"; }, /policy_version/);
  assert.throws(function () { ctx.cc.policyVersion = ""; },              /policy_version/);

  // registerPolicyVersion: missing summary.
  await assert.rejects(ctx.cc.registerPolicyVersion({ version: "v9" }), /summary required/);

  // categoryAllowed: bad category key.
  await assert.rejects(ctx.cc.categoryAllowed({
    session_id: "ok", category: "tracking",
  }), /category must be one of/);

  // metricsForBanner: to <= from refused.
  await assert.rejects(ctx.cc.metricsForBanner({ from: 100, to: 100 }), /to must be > from/);
  await assert.rejects(ctx.cc.metricsForBanner({ from: 100, to: 99  }), /to must be > from/);
  // Negative from refused.
  await assert.rejects(ctx.cc.metricsForBanner({ from: -1, to: 1 }), /from/);

  // cleanupOlderThan: non-positive integer.
  await assert.rejects(ctx.cc.cleanupOlderThan(0),    /positive integer/);
  await assert.rejects(ctx.cc.cleanupOlderThan(-3),   /positive integer/);
  await assert.rejects(ctx.cc.cleanupOlderThan(1.5),  /positive integer/);

  // withdrawConsent: missing input + bad session_id.
  await assert.rejects(ctx.cc.withdrawConsent(null),       /input object required/);
  await assert.rejects(ctx.cc.withdrawConsent({}),         /session_id/);
}

async function run() {
  await _recordAndReadBack();
  await _dntForcesImplicitDeny();
  await _gpcForcesImplicitDeny();
  await _withdrawFlipsLaterReads();
  await _policyBumpFlagsReprompt();
  await _metricsBuckets();
  await _cleanupOlderThanWalk();
  await _factoryAndInputRefusals();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/cookie-consent.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - cookie-consent (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
