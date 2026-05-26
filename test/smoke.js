"use strict";
/**
 * Smoke test — orchestrator only.
 *
 * Run: `npm test` (or `node test/smoke.js`)
 *
 * The smoke gate runs every check that protects the release pipeline:
 *
 *   1. Static gates (non-mutating, fail fast):
 *      - Release-notes rollup is up-to-date (`consolidate --check`).
 *      - CHANGELOG.md matches the rebuild from `release-notes/`
 *        (`generate-changelog-entry.js --check`).
 *      - Vendor drift check (`vendor-update.sh --check`).
 *      - Layer-0 codebase-patterns gate (every detector in
 *        `test/layer-0-primitives/`).
 *   2. Per-layer test files under `test/layer-N-<name>/*.test.js`.
 *
 * Per-test timing reported on stdout — drift detection without
 * extra tooling. Output also persisted to `.test-output/smoke.log`
 * via synchronous fd writes so a fatal failure mid-run still leaves
 * a readable log behind.
 */

var fs   = require("node:fs");
var path = require("node:path");
var cp   = require("node:child_process");

var REPO_ROOT  = path.resolve(__dirname, "..");
var OUTPUT_DIR = path.join(REPO_ROOT, ".test-output");
try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (_e) { /* best-effort */ }
var LOG_PATH = path.join(OUTPUT_DIR, "smoke.log");
try { fs.unlinkSync(LOG_PATH); } catch (_e) { /* fresh start */ }
var _logFd = fs.openSync(LOG_PATH, "w");

function _logWrite(chunk) {
  try {
    var buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    fs.writeSync(_logFd, buf, 0, buf.length, null);
  } catch (_e) { /* best-effort */ }
}

var _origStdoutWrite = process.stdout.write.bind(process.stdout);
var _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = function (chunk, encoding, cb) {
  _logWrite(chunk);
  return _origStdoutWrite(chunk, encoding, cb);
};
process.stderr.write = function (chunk, encoding, cb) {
  _logWrite(chunk);
  return _origStderrWrite(chunk, encoding, cb);
};
process.on("exit", function () {
  try { fs.closeSync(_logFd); } catch (_e) { /* best-effort */ }
});

var pkg = require("../package.json");
console.log(pkg.name + " v" + pkg.version + " — smoke test");
console.log("output: " + LOG_PATH);

function _padRight(s, n) {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

// Non-mutating gates that fail fast — the operator runs the named
// `--prune` / `--rebuild` / refresh command to fix any drift these
// surface, then re-runs smoke. Smoke never writes to the working
// tree.
function _gate(label, script, args) {
  var r = cp.spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", script)].concat(args || []),
    { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"] }
  );
  if (r.status !== 0) {
    throw new Error(label + " — gate failed (see prior stderr for the fix recipe)");
  }
}

function _shellGate(label, command) {
  var r = cp.spawnSync("bash", ["-lc", command], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    throw new Error(label + " — gate failed (see prior stderr for the fix recipe)");
  }
}

// Walk test/layer-N-<name>/ directories for *.test.js files. Each is
// require()'d and its `run()` export awaited. The orchestrator stays
// dumb — every test file decides its own setup / teardown.
function _layerDirFor(layerNum) {
  var names = ["primitives", "state", "integration"];
  var dir = path.join(__dirname, "layer-" + layerNum + "-" + names[layerNum]);
  if (!fs.existsSync(dir)) return null;
  return dir;
}

async function _runTestModule(modulePath, displayName) {
  var mod = require(modulePath);
  var fileStart = Date.now();
  if (typeof mod.run === "function") {
    try { await mod.run(); }
    catch (err) {
      err.message = displayName + ": " + err.message;
      throw err;
    }
  }
  return Date.now() - fileStart;
}

async function _runLayer(layerNum, layerName) {
  var dir = _layerDirFor(layerNum);
  if (!dir) return;
  var files = fs.readdirSync(dir).filter(function (f) {
    return f.endsWith(".test.js");
  }).sort();
  if (files.length === 0) return;
  console.log(layerName);
  for (var i = 0; i < files.length; i += 1) {
    var fullPath = path.join(dir, files[i]);
    var ms = await _runTestModule(fullPath, layerName + " / " + files[i]);
    console.log("  " + _padRight(files[i], 40) + " (" + ms + "ms)");
  }
}

(async function () {
  var smokeStart = Date.now();
  console.log("Static gates");
  _gate("release-notes-rollup", "consolidate-release-notes.js", ["--check"]);
  console.log("  " + _padRight("release-notes-rollup", 40) + " (ok)");
  _gate("changelog-in-sync", "generate-changelog-entry.js", ["--check"]);
  console.log("  " + _padRight("changelog-in-sync", 40) + " (ok)");
  _gate("asset-manifest-in-sync", "generate-asset-manifest.js", ["--check"]);
  console.log("  " + _padRight("asset-manifest-in-sync", 40) + " (ok)");
  _shellGate("vendor-drift", "bash scripts/vendor-update.sh --check");
  console.log("  " + _padRight("vendor-drift", 40) + " (ok)");
  // Worker-syntax check — walks every reachable file under worker/
  // tracking string / template / comment / regex state and asserts
  // braces / parens / brackets balance at EOF. Catches the
  // node-tolerates / esbuild-refuses class that broke v0.0.95 +
  // v0.0.97 deploys (missing trailing `}`). Self-contained Node
  // script — no npm-registry dependency, runs inside the container
  // build stage without network access.
  _gate("worker-syntax", "check-worker-syntax.js", []);
  console.log("  " + _padRight("worker-syntax", 40) + " (ok)");

  await _runLayer(0, "Layer 0");
  await _runLayer(1, "Layer 1");
  await _runLayer(2, "Layer 2");

  console.log("OK — smoke passed (" + (Date.now() - smokeStart) + "ms total)");
})().catch(function (err) {
  console.error("SMOKE TEST FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
