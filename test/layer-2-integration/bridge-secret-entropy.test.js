"use strict";
/**
 * D1 bridge-secret entropy floor at boot.
 *
 * The Worker route POST /_/db/query is a single-statement SQL oracle on
 * the live D1, and the same D1_BRIDGE_SECRET authorizes /_/r2/put +
 * /_/low-stock-alert. A weak / guessable secret hands an attacker the
 * whole backend, so server.js emits a loud boot WARNING when a secret
 * shorter than 32 chars is configured in production — surfacing the weak
 * secret in the boot log without refusing to boot (the live secret's
 * length can't be verified out of band at deploy time, so a hard refusal
 * could wedge a healthy deploy). Only in production, so local + e2e
 * (which boot over http with short test secrets) stay quiet.
 *
 * Spawns the REAL `node server.js` the way the container runs it (argv
 * array, no shell — no command-injection surface) so the production code
 * path is exercised, not a reimplementation. The warning is emitted at
 * the bridge-wiring point, before the adapter is constructed, so it lands
 * in the boot log regardless of what the (unreachable test) bridge does.
 *
 * Network: none — the bridge is pointed at a closed loopback port and we
 * assert only on whether the entropy WARNING appeared in the boot output,
 * never on the later (irrelevant) bridge-connect outcome.
 */

var childProc = require("node:child_process");
var nodeFs    = require("node:fs");
var nodeOs    = require("node:os");
var nodePath  = require("node:path");

var helpers = require("../helpers");
var check   = helpers.check;

var nodeBin   = process.argv[0];
var REPO_ROOT = nodePath.resolve(__dirname, "..", "..");
var SERVER_JS = nodePath.join(REPO_ROOT, "server.js");

// Spawn server.js with the given env overrides and observe its boot. The
// entropy gate (if it fires) throws synchronously, before the adapter is
// built or any socket opens, so a too-short secret crashes the process in
// well under a second. Resolve as soon as the process exits, prints
// "listening on", or — for the non-throwing cases, where boot proceeds to
// the (intentionally unreachable) bridge and may stall on connect — a
// short observation window elapses. We only ever assert on whether the
// gate's message appeared, so observing the first second of boot is
// sufficient and keeps the spawn fast.
// opts: { observeMs, settleOnMatch }
//   settleOnMatch — a RegExp; resolve the instant accumulated output matches
//   it, instead of burning a fixed budget. The config-validation entropy gate
//   runs very early but only AFTER Node has loaded the whole app graph, which
//   on a cold/contended CI runner can take several seconds — a fixed 2.5s
//   budget settled before the gate ran and read the warning as absent (a
//   macOS-only flake). settleOnMatch ends the wait deterministically on the
//   warning (positive cases) or the first framework boot log (absence cases,
//   which proves the upstream gate already ran); observeMs is only a backstop.
function _spawnServer(envOverrides, opts) {
  opts = opts || {};
  var observeMs     = opts.observeMs || 20000;
  var settleOnMatch = opts.settleOnMatch || null;
  return new Promise(function (resolve) {
    var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-bridge-"));
    var tmpDir  = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-bridge-tmp-"));
    var child = childProc.spawn(nodeBin, [SERVER_JS], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, {
        PORT:                             "0",
        DATA_DIR:                         dataDir,
        VAULT_PASSPHRASE:                 "bridge-entropy-test-passphrase",
        BLAMEJS_TMPDIR:                   tmpDir,
        BLAMEJS_SKIP_NTP_CHECK:           "1",
        BLAMEJS_VAULT_PASSPHRASE:         "",
        BLAMEJS_AUDIT_SIGNING_PASSPHRASE: "",
      }, envOverrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
    var out = "";
    var exited = null;
    var settled = false;
    function _cleanup() {
      try { child.kill(); } catch (_e) { /* */ }
      try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
      try { nodeFs.rmSync(tmpDir,  { recursive: true, force: true }); } catch (_e) { /* */ }
    }
    function _settle() {
      if (settled) return;
      settled = true;
      _cleanup();
      resolve({ exited: exited, out: out });
    }
    function _checkMatch() {
      if (/listening on :/.test(out)) return _settle();
      if (settleOnMatch && settleOnMatch.test(out)) return _settle();
    }
    child.stdout.on("data", function (b) { out += b.toString(); _checkMatch(); });
    child.stderr.on("data", function (b) { out += b.toString(); _checkMatch(); });
    child.on("exit", function (code) { exited = code; _settle(); });
    // Backstop only — settleOnMatch resolves the instant the asserted output
    // appears, so this generous window just bounds the wait if the process
    // stalls without ever emitting it (e.g. a hang on the unreachable bridge).
    setTimeout(_settle, observeMs).unref();
  });
}

async function _run() {
  // 1. Production + bridge configured + short secret → boot emits the
  //    entropy WARNING (and keeps going; the warning is what we assert).
  var prodShort = await _spawnServer({
    NODE_ENV:         "production",
    D1_BRIDGE_URL:    "http://127.0.0.1:1",   // unreachable — irrelevant; we assert on the warning only
    D1_BRIDGE_SECRET: "short-secret",          // 12 chars, below the 32 floor
  }, { settleOnMatch: /D1_BRIDGE_SECRET is too short/ });
  check("prod short bridge secret warns",           /D1_BRIDGE_SECRET is too short/.test(prodShort.out));
  check("prod short bridge secret states the rule", /at least 32 characters/.test(prodShort.out));
  check("prod short bridge secret warning is a warning, not a crash", /WARNING/.test(prodShort.out));

  // 2. Production + bridge configured + a 32+ char secret → the entropy
  //    warning does NOT fire (boot may still fail later on the unreachable
  //    bridge, but never with the too-short message).
  var prodLong = await _spawnServer({
    NODE_ENV:         "production",
    D1_BRIDGE_URL:    "http://127.0.0.1:1",
    D1_BRIDGE_SECRET: "x".repeat(43),          // documented recipe yields 43 base64url chars
  }, { settleOnMatch: /"boot":true/ });
  check("prod 43-char secret clears the entropy warning", !/D1_BRIDGE_SECRET is too short/.test(prodLong.out));

  // 3. Dev (NODE_ENV unset) + bridge configured + short secret → the
  //    entropy gate is NOT enforced, so local/e2e with short test secrets
  //    still boot past the gate. We assert only that the gate didn't fire.
  var devShort = await _spawnServer({
    D1_BRIDGE_URL:    "http://127.0.0.1:1",
    D1_BRIDGE_SECRET: "short-secret",
  }, { settleOnMatch: /"boot":true/ });
  check("dev short bridge secret skips the entropy gate", !/D1_BRIDGE_SECRET is too short/.test(devShort.out));
}

module.exports = { run: _run };
