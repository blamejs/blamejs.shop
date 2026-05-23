"use strict";
/**
 * captchaGate — CAPTCHA provider registry plus per-verification audit
 * log for high-risk entry points.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0114_captcha_gate.sql`.
 *
 * Coverage:
 *   - registerProvider round-trips slug / kind / public_key / hashed
 *     secret; refuses bad slug / kind, threshold on non-v3 kinds,
 *     redefine, missing secret
 *   - verifyToken happy path: stub returns success=true → ok with
 *     verified reason
 *   - verifyToken provider failure: stub returns success=false →
 *     ok=false with provider_rejected
 *   - verifyToken reCAPTCHA v3 score: above threshold → ok; below
 *     threshold → ok=false with score_below_threshold; expected_score
 *     overrides registered threshold per-call
 *   - verifyToken action mismatch: declared action vs returned action
 *     mismatched → action_match=false
 *   - verifyToken provider archived / inactive → provider_inactive
 *   - verifyToken callback throws → verify_callback_threw
 *   - recordOutcome round-trips ok / score / gate / session-id-hash;
 *     refuses unknown gate; hashes the raw session id
 *   - metricsForProvider rate math: 3 passed + 2 failed = pass_rate_bps
 *     6000; score_avg_bps over only the non-null score rows
 *   - listProviders / getProvider / archiveProvider / updateProvider
 *     (secret rotation + threshold mutation + active flip)
 *   - gatesForVerification keyset pagination with cursor
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var captchaGate = require("../../lib/captcha-gate");
var blamejs     = require("../../lib/vendor/blamejs");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0114_captcha_gate.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim()
                  .split(/\s+/)[0].toUpperCase();
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

function _newGate() {
  return captchaGate.create({ query: _makeQuery() });
}

// ---- registerProvider --------------------------------------------------

async function _registerProvider() {
  var cg = _newGate();

  var p = await cg.registerProvider({
    slug:       "turnstile",
    kind:       "turnstile",
    public_key: "0x4AAAAAAA-pub-test",
    secret_key: "0x4AAAAAAA-secret-test  ",   // trailing whitespace exercised
    active:     true,
  });
  check("registerProvider slug",            p.slug === "turnstile");
  check("registerProvider kind",            p.kind === "turnstile");
  check("registerProvider public_key",      p.public_key === "0x4AAAAAAA-pub-test");
  check("registerProvider active",          p.active === true);
  check("registerProvider threshold null",  p.threshold_score === null);
  check("registerProvider archived_at null", p.archived_at === null);
  check("registerProvider created_at int",  Number.isInteger(p.created_at));
  check("registerProvider updated_at int",  Number.isInteger(p.updated_at));
  check("registerProvider hashed",          typeof p.secret_key_hash === "string" && p.secret_key_hash.length > 0);
  check("registerProvider no raw secret leak",
        Object.prototype.hasOwnProperty.call(p, "secret_key_normalized") === false);

  // Hash equals namespaceHash of trimmed secret.
  var expected = blamejs.crypto.namespaceHash("captcha-secret", "0x4AAAAAAA-secret-test");
  check("registerProvider hash matches namespaceHash",
        p.secret_key_hash === expected);

  // reCAPTCHA v3 with threshold.
  var v3 = await cg.registerProvider({
    slug:            "recap3",
    kind:            "recaptcha_v3",
    public_key:      "site-key-v3",
    secret_key:      "secret-v3",
    threshold_score: 5000,
    active:          true,
  });
  check("v3 threshold stored",              v3.threshold_score === 5000);

  // Refusals
  await assert.rejects(cg.registerProvider(), /input object required/);
  await assert.rejects(cg.registerProvider({
    slug: "Has Space", kind: "turnstile", public_key: "x", secret_key: "s",
  }), /slug/);
  await assert.rejects(cg.registerProvider({
    slug: "ok", kind: "unknown", public_key: "x", secret_key: "s",
  }), /kind/);
  await assert.rejects(cg.registerProvider({
    slug: "ok", kind: "turnstile", public_key: "", secret_key: "s",
  }), /public_key/);
  await assert.rejects(cg.registerProvider({
    slug: "ok", kind: "turnstile", public_key: "x", secret_key: "",
  }), /secret_key/);
  // threshold against non-v3 kind
  await assert.rejects(cg.registerProvider({
    slug: "ok", kind: "turnstile", public_key: "x", secret_key: "s",
    threshold_score: 5000,
  }), /threshold_score/);
  // threshold out of range
  await assert.rejects(cg.registerProvider({
    slug: "ok", kind: "recaptcha_v3", public_key: "x", secret_key: "s",
    threshold_score: 20000,
  }), /threshold_score/);
  // active not boolean
  await assert.rejects(cg.registerProvider({
    slug: "ok", kind: "turnstile", public_key: "x", secret_key: "s",
    active: "yes",
  }), /active/);
  // redefine
  await assert.rejects(cg.registerProvider({
    slug: "turnstile", kind: "turnstile", public_key: "x", secret_key: "s",
  }), /already exists/);
}

// ---- verifyToken happy path -------------------------------------------

async function _verifyHappy() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "ts", kind: "turnstile",
    public_key: "pub", secret_key: "secret",
    active: true,
  });

  var seenCtx = null;
  var r = await cg.verifyToken({
    provider_slug: "ts",
    token:         "0123456789abcdef",
    verify: async function (ctx) {
      seenCtx = ctx;
      return { success: true };
    },
  });
  check("verify happy ok",                r.ok === true);
  check("verify happy reasons",           r.reasons.indexOf("verified") !== -1);
  check("verify happy action_match",      r.action_match === true);
  check("verify happy score null",        r.score === null);
  check("verify callback got kind",       seenCtx.kind === "turnstile");
  check("verify callback got public_key", seenCtx.public_key === "pub");
  check("verify callback got secret",     seenCtx.secret_key === "secret");
  check("verify callback got token",      seenCtx.token === "0123456789abcdef");
}

// ---- verifyToken provider rejected ------------------------------------

async function _verifyProviderRejected() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "ts", kind: "turnstile",
    public_key: "pub", secret_key: "secret",
    active: true,
  });

  var r = await cg.verifyToken({
    provider_slug: "ts",
    token:         "bad-token",
    verify: async function () { return { success: false, "error-codes": ["invalid-input-response"] }; },
  });
  check("verify rejected ok=false",       r.ok === false);
  check("verify rejected reason",         r.reasons.indexOf("provider_rejected") !== -1);
  check("verify rejected no verified",    r.reasons.indexOf("verified") === -1);

  // Callback returns non-object → reasons enumerate.
  var rNon = await cg.verifyToken({
    provider_slug: "ts", token: "t",
    verify: async function () { return null; },
  });
  check("verify non-object ok=false",     rNon.ok === false);
  check("verify non-object reason",
        rNon.reasons.indexOf("verify_callback_returned_non_object") !== -1);

  // Callback throws → recorded reason.
  var rThrow = await cg.verifyToken({
    provider_slug: "ts", token: "t",
    verify: async function () { throw new Error("network down"); },
  });
  check("verify throws ok=false",         rThrow.ok === false);
  check("verify throws reason",           rThrow.reasons.indexOf("verify_callback_threw") !== -1);
}

// ---- verifyToken reCAPTCHA v3 score gate ------------------------------

async function _verifyScoreGate() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "v3", kind: "recaptcha_v3",
    public_key: "pub", secret_key: "secret",
    threshold_score: 5000,
    active: true,
  });

  // Above threshold (0.7 = 7000bps > 5000bps).
  var rOk = await cg.verifyToken({
    provider_slug: "v3", token: "t",
    verify: async function () { return { success: true, score: 0.7 }; },
  });
  check("v3 above threshold ok",          rOk.ok === true);
  check("v3 above threshold score",       rOk.score === 7000);
  check("v3 above threshold verified",    rOk.reasons.indexOf("verified") !== -1);

  // Below threshold (0.3 = 3000bps < 5000bps).
  var rLow = await cg.verifyToken({
    provider_slug: "v3", token: "t",
    verify: async function () { return { success: true, score: 0.3 }; },
  });
  check("v3 below threshold ok=false",    rLow.ok === false);
  check("v3 below threshold score",       rLow.score === 3000);
  check("v3 below threshold reason",
        rLow.reasons.indexOf("score_below_threshold") !== -1);
  check("v3 below threshold not verified",
        rLow.reasons.indexOf("verified") === -1);

  // expected_score overrides registered threshold (call asks for 8000bps).
  var rOverride = await cg.verifyToken({
    provider_slug: "v3", token: "t",
    expected_score: 8000,
    verify: async function () { return { success: true, score: 0.7 }; },
  });
  check("v3 expected_score override fails",
        rOverride.ok === false &&
        rOverride.reasons.indexOf("score_below_threshold") !== -1);

  // Provider returned no score under v3 → score_missing reason when
  // threshold is set.
  var rNoScore = await cg.verifyToken({
    provider_slug: "v3", token: "t",
    verify: async function () { return { success: true }; },
  });
  check("v3 missing score reason",
        rNoScore.reasons.indexOf("score_missing") !== -1);
  check("v3 missing score ok=false",      rNoScore.ok === false);
}

// ---- verifyToken action mismatch --------------------------------------

async function _verifyActionMismatch() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "v3", kind: "recaptcha_v3",
    public_key: "pub", secret_key: "secret",
    threshold_score: 5000,
    active: true,
  });

  // Action declared = "signup", but provider stamped "contact_form" —
  // replay candidate.
  var rMismatch = await cg.verifyToken({
    provider_slug: "v3", token: "t",
    action:        "signup",
    verify: async function () {
      return { success: true, score: 0.9, action: "contact_form" };
    },
  });
  check("action mismatch action_match",   rMismatch.action_match === false);
  check("action mismatch ok=false",       rMismatch.ok === false);
  check("action mismatch reason",         rMismatch.reasons.indexOf("action_mismatch") !== -1);

  // Action equal — clean verification.
  var rMatch = await cg.verifyToken({
    provider_slug: "v3", token: "t",
    action:        "signup",
    verify: async function () {
      return { success: true, score: 0.9, action: "signup" };
    },
  });
  check("action match action_match true", rMatch.action_match === true);
  check("action match ok",                rMatch.ok === true);
}

// ---- verifyToken provider inactive / archived -------------------------

async function _verifyInactive() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "ts", kind: "turnstile",
    public_key: "pub", secret_key: "secret",
    active: false,
  });

  var rInactive = await cg.verifyToken({
    provider_slug: "ts", token: "t",
    verify: async function () { return { success: true }; },
  });
  check("inactive provider ok=false",     rInactive.ok === false);
  check("inactive reason",                rInactive.reasons.indexOf("provider_inactive") !== -1);

  // unknown provider throws (operator misconfig)
  await assert.rejects(cg.verifyToken({
    provider_slug: "nope", token: "t",
    verify: async function () { return { success: true }; },
  }), /not found/);

  // missing verify callback
  await assert.rejects(cg.verifyToken({
    provider_slug: "ts", token: "t",
  }), /verify/);

  // bad token
  await assert.rejects(cg.verifyToken({
    provider_slug: "ts", token: "",
    verify: async function () { return { success: true }; },
  }), /token/);
}

// ---- recordOutcome -----------------------------------------------------

async function _recordOutcome() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "ts", kind: "turnstile",
    public_key: "pub", secret_key: "secret",
    active: true,
  });

  var row = await cg.recordOutcome({
    provider_slug: "ts",
    gate:          "signup",
    ok:            true,
    session_id:    "session-cookie-value-raw",
  });
  check("recordOutcome ok",               row.ok === true);
  check("recordOutcome gate",             row.gate === "signup");
  check("recordOutcome score null",       row.score === null);
  check("recordOutcome ip_hash null",     row.ip_hash === null);
  check("recordOutcome session hashed",
        typeof row.session_id_hash === "string" && row.session_id_hash.length > 0);
  // hash matches what namespaceHash would produce
  var expected = blamejs.crypto.namespaceHash("captcha-session", "session-cookie-value-raw");
  check("recordOutcome session hash matches",
        row.session_id_hash === expected);

  // With ip_hash + score
  var row2 = await cg.recordOutcome({
    provider_slug: "ts",
    gate:          "password_reset",
    ok:            false,
    score:         3000,
    ip_hash:       "abc123ef",
  });
  check("recordOutcome ok=false",         row2.ok === false);
  check("recordOutcome ip_hash stored",   row2.ip_hash === "abc123ef");
  check("recordOutcome score stored",     row2.score === 3000);

  // Refusals
  await assert.rejects(cg.recordOutcome(), /input object required/);
  await assert.rejects(cg.recordOutcome({
    provider_slug: "ts", gate: "unknown_gate", ok: true,
  }), /gate/);
  await assert.rejects(cg.recordOutcome({
    provider_slug: "ts", gate: "signup", ok: "yes",
  }), /ok/);
  await assert.rejects(cg.recordOutcome({
    provider_slug: "nope", gate: "signup", ok: true,
  }), /not found/);
}

// ---- metricsForProvider rate math --------------------------------------

async function _metricsForProvider() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "v3", kind: "recaptcha_v3",
    public_key: "pub", secret_key: "secret",
    threshold_score: 5000,
    active: true,
  });

  // 3 passed + 2 failed = 60% pass rate.
  await cg.recordOutcome({ provider_slug: "v3", gate: "signup", ok: true,  score: 9000 });
  await cg.recordOutcome({ provider_slug: "v3", gate: "signup", ok: true,  score: 8000 });
  await cg.recordOutcome({ provider_slug: "v3", gate: "signup", ok: true,  score: 7000 });
  await cg.recordOutcome({ provider_slug: "v3", gate: "signup", ok: false, score: 3000 });
  await cg.recordOutcome({ provider_slug: "v3", gate: "signup", ok: false, score: 2000 });

  var now = Date.now();
  var m = await cg.metricsForProvider({
    slug: "v3",
    from: now - 60 * 60 * 1000,
    to:   now + 60 * 60 * 1000,
  });
  check("metrics total",             m.total === 5);
  check("metrics passed",            m.passed === 3);
  check("metrics failed",            m.failed === 2);
  check("metrics pass_rate_bps",     m.pass_rate_bps === 6000);
  // (9000+8000+7000+3000+2000) / 5 = 5800
  check("metrics score_avg_bps",     m.score_avg_bps === 5800);

  // Empty window
  var mEmpty = await cg.metricsForProvider({
    slug: "v3", from: 0, to: 1,
  });
  check("metrics empty total",       mEmpty.total === 0);
  check("metrics empty pass_rate",   mEmpty.pass_rate_bps === 0);
  check("metrics empty score_avg",   mEmpty.score_avg_bps === null);

  // Refusals
  await assert.rejects(cg.metricsForProvider(), /input object required/);
  await assert.rejects(cg.metricsForProvider({
    slug: "v3", from: 100, to: 100,
  }), /to/);
  await assert.rejects(cg.metricsForProvider({
    slug: "missing", from: 0, to: 100,
  }), /not found/);
}

// ---- list / get / archive / update -------------------------------------

async function _listGetArchiveUpdate() {
  var cg = _newGate();

  await cg.registerProvider({
    slug: "a", kind: "turnstile",   public_key: "pa", secret_key: "sa",
  });
  await cg.registerProvider({
    slug: "b", kind: "recaptcha_v3", public_key: "pb", secret_key: "sb",
    threshold_score: 5000,
  });

  var g = await cg.getProvider("a");
  check("getProvider slug",                  g.slug === "a");
  check("getProvider null missing",          (await cg.getProvider("missing")) === null);

  var all = await cg.listProviders();
  check("listProviders both",                all.length === 2);

  // updateProvider — rotate secret + threshold + active.
  var u = await cg.updateProvider("b", {
    secret_key:      "sb-rotated",
    threshold_score: 7000,
    active:          false,
  });
  check("update threshold",                  u.threshold_score === 7000);
  check("update active flipped",             u.active === false);
  var expectedHash = blamejs.crypto.namespaceHash("captcha-secret", "sb-rotated");
  check("update secret rotated hash",        u.secret_key_hash === expectedHash);

  // listProviders active_only excludes the deactivated one.
  var act = await cg.listProviders({ active_only: true });
  check("listProviders active_only",         act.length === 1 && act[0].slug === "a");

  // updateProvider refusals
  await assert.rejects(cg.updateProvider("missing", { active: true }), /not found/);
  await assert.rejects(cg.updateProvider("a", {}), /at least one column/);
  await assert.rejects(cg.updateProvider("a", { slug: "x" }), /unsupported column/);
  // threshold on non-v3 kind via patch
  await assert.rejects(cg.updateProvider("a", { threshold_score: 5000 }),
                       /threshold_score/);

  // archiveProvider
  var arch = await cg.archiveProvider("a");
  check("archive sets archived_at",          arch.archived_at != null);
  check("archive flips active",              arch.active === false);

  // Idempotent
  var archAgain = await cg.archiveProvider("a");
  check("archive idempotent",                archAgain.archived_at != null);

  await assert.rejects(cg.archiveProvider("nope"), /not found/);

  // Archived provider cannot verify.
  var rArch = await cg.verifyToken({
    provider_slug: "a", token: "t",
    verify: async function () { return { success: true }; },
  });
  check("archived provider verify inactive",
        rArch.reasons.indexOf("provider_inactive") !== -1);
}

// ---- gatesForVerification keyset pagination ---------------------------

async function _gatesPagination() {
  var cg = _newGate();
  await cg.registerProvider({
    slug: "ts", kind: "turnstile",
    public_key: "pub", secret_key: "secret",
    active: true,
  });

  // 5 rows
  for (var i = 0; i < 5; i += 1) {
    await cg.recordOutcome({
      provider_slug: "ts", gate: "signup", ok: i % 2 === 0,
    });
  }

  var page1 = await cg.gatesForVerification({
    slug: "ts",
    from: 0, to: Date.now() + 1_000_000,
    limit: 2,
  });
  check("page1 rows length",        page1.rows.length === 2);
  check("page1 next_cursor set",    typeof page1.next_cursor === "string" &&
                                    page1.next_cursor.indexOf(":") !== -1);

  var page2 = await cg.gatesForVerification({
    slug: "ts",
    from: 0, to: Date.now() + 1_000_000,
    limit: 2,
    cursor: page1.next_cursor,
  });
  check("page2 rows length",        page2.rows.length === 2);
  check("page2 distinct ids",       page2.rows[0].id !== page1.rows[0].id &&
                                    page2.rows[0].id !== page1.rows[1].id);

  var page3 = await cg.gatesForVerification({
    slug: "ts",
    from: 0, to: Date.now() + 1_000_000,
    limit: 2,
    cursor: page2.next_cursor,
  });
  check("page3 last row",           page3.rows.length === 1);
  check("page3 next_cursor null",   page3.next_cursor === null);

  // DESC order: page1[0] is the newest.
  check("desc page1[0] > page1[1]",
        page1.rows[0].occurred_at >= page1.rows[1].occurred_at);

  // Refusals
  await assert.rejects(cg.gatesForVerification(), /input object required/);
  await assert.rejects(cg.gatesForVerification({
    slug: "ts", from: 100, to: 100,
  }), /to/);
  await assert.rejects(cg.gatesForVerification({
    slug: "ts", from: 0, to: 100, limit: 2, cursor: "garbage",
  }), /cursor/);
}

async function run() {
  await _registerProvider();
  await _verifyHappy();
  await _verifyProviderRejected();
  await _verifyScoreGate();
  await _verifyActionMismatch();
  await _verifyInactive();
  await _recordOutcome();
  await _metricsForProvider();
  await _listGetArchiveUpdate();
  await _gatesPagination();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - captcha-gate (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - captcha-gate: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
