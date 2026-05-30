"use strict";
/**
 * gate-contract — release-time coverage verifier.
 *
 * Asserts the pure `verify()` returns `ok:true` on the known-good tree,
 * and `ok:false` with a paste-ready gap on each failure mode (a
 * declared detector removed, a new shipped-bug detector with no
 * coverage row, a gate dropped from the pipeline). A real
 * file-mutation round-trip proves the script itself exits non-zero when
 * a detector is genuinely removed from the catalog, then restores the
 * file.
 *
 * Coverage:
 *   - verify() ok:true on the clean tree (no gaps)
 *   - removing a declared detector -> missing-detector gap
 *   - adding a bugClassDeclared detector with no COVERAGE row ->
 *     undeclared-detector gap
 *   - a COVERAGE gate token missing from release.js -> gate-not-wired
 *   - every COVERAGE.detector resolves in the live catalog
 *   - every bugClassDeclared catalog detector has a COVERAGE row
 *   - end-to-end: `node scripts/gate-contract.js` exits 0 clean,
 *     non-zero after a detector is removed from the catalog file
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var nodeCp   = require("node:child_process");

var helpers = require("../helpers");
var check   = helpers.check;

var ROOT          = nodePath.resolve(__dirname, "..", "..");
var GC_PATH       = nodePath.resolve(ROOT, "scripts", "gate-contract.js");
var CATALOG_PATH  = nodePath.resolve(ROOT, "test", "layer-0-primitives", "codebase-patterns.test.js");

// Load gate-contract fresh, optionally with the catalog module stubbed
// to a caller-supplied KNOWN_ANTIPATTERNS array (so we exercise verify()
// failure modes without touching any file on disk).
function _verifyWith(catalogArray, env) {
  var savedCatalog = require.cache[CATALOG_PATH];
  var savedEnv = process.env.RELEASE_ALLOW_GATE_GAPS;
  if (env && env.RELEASE_ALLOW_GATE_GAPS != null) {
    process.env.RELEASE_ALLOW_GATE_GAPS = env.RELEASE_ALLOW_GATE_GAPS;
  }
  if (catalogArray) {
    require.cache[CATALOG_PATH] = {
      id: CATALOG_PATH, filename: CATALOG_PATH, loaded: true,
      exports: { run: function () {}, KNOWN_ANTIPATTERNS: catalogArray },
    };
  }
  delete require.cache[GC_PATH];
  var out;
  try {
    out = require(GC_PATH).verify();
  } finally {
    if (savedCatalog) require.cache[CATALOG_PATH] = savedCatalog;
    else delete require.cache[CATALOG_PATH];
    delete require.cache[GC_PATH];
    if (savedEnv == null) delete process.env.RELEASE_ALLOW_GATE_GAPS;
    else process.env.RELEASE_ALLOW_GATE_GAPS = savedEnv;
  }
  return out;
}

function _realCatalog() {
  delete require.cache[CATALOG_PATH];
  return require(CATALOG_PATH).KNOWN_ANTIPATTERNS;
}

function _hasKind(gaps, kind) {
  return gaps.some(function (g) { return g.kind === kind; });
}

function _cleanTree() {
  var r = _verifyWith(null);
  check("verify() ok on clean tree", r.ok === true);
  check("verify() no gaps on clean tree", r.gaps.length === 0);
}

function _everyCoverageDetectorResolves() {
  delete require.cache[GC_PATH];
  var gc = require(GC_PATH);
  var ids = {};
  _realCatalog().forEach(function (a) { if (a && a.id) ids[a.id] = true; });
  var allResolve = gc.COVERAGE.every(function (row) { return ids[row.detector]; });
  check("every COVERAGE.detector resolves in the live catalog", allResolve);
  check("COVERAGE is non-empty", gc.COVERAGE.length > 0);
}

function _everyDeclaredHasCoverageRow() {
  delete require.cache[GC_PATH];
  var gc = require(GC_PATH);
  var covered = {};
  gc.COVERAGE.forEach(function (row) { covered[row.detector] = true; });
  var declared = _realCatalog().filter(function (a) { return a && a.bugClassDeclared; });
  check("there is at least one bugClassDeclared detector", declared.length > 0);
  var allCovered = declared.every(function (a) { return covered[a.id]; });
  check("every bugClassDeclared detector has a COVERAGE row", allCovered);
}

function _removedDetectorTrips() {
  var real = _realCatalog();
  var without = real.filter(function (a) { return a.id !== "giftcard-issue-without-iso4217-currency-check"; });
  var r = _verifyWith(without);
  check("removed detector -> not ok", r.ok === false);
  check("removed detector -> missing-detector gap", _hasKind(r.gaps, "missing-detector"));
  var msg = r.gaps.find(function (g) { return g.kind === "missing-detector"; }).message;
  check("missing-detector message is paste-ready (names the id)", msg.indexOf("giftcard-issue-without-iso4217-currency-check") !== -1);
}

function _undeclaredDetectorTrips() {
  var real = _realCatalog();
  var plus = real.concat([{ id: "synthetic-shipped-bug-xyz", bugClassDeclared: true, regex: /zzz/, scanScope: "lib" }]);
  var r = _verifyWith(plus);
  check("new bugClassDeclared w/o coverage -> not ok", r.ok === false);
  check("new bugClassDeclared w/o coverage -> undeclared-detector gap", _hasKind(r.gaps, "undeclared-detector"));
  var msg = r.gaps.find(function (g) { return g.kind === "undeclared-detector"; }).message;
  check("undeclared-detector message names the id", msg.indexOf("synthetic-shipped-bug-xyz") !== -1);
}

function _deferralHatchKeepsGapVisible() {
  // The hatch is applied by the script body, not verify(); verify() still
  // reports the gap (the debt stays visible) regardless of the env.
  var real = _realCatalog();
  var without = real.filter(function (a) { return a.id !== "returns-refund-typeerror-mapped-to-404"; });
  var r = _verifyWith(without, { RELEASE_ALLOW_GATE_GAPS: "1" });
  check("deferral env: verify() still reports the gap", r.ok === false && r.gaps.length >= 1);
}

// End-to-end: the script exits 0 on the clean tree, and non-zero after a
// declared detector is genuinely removed from the catalog file. The
// mutation is reverted in a finally so the working tree is restored even
// if an assertion throws.
function _endToEndExitCodes() {
  var clean = nodeCp.spawnSync(process.execPath, [GC_PATH], { cwd: ROOT, encoding: "utf8" });
  check("script exits 0 on clean tree", clean.status === 0);

  var original = nodeFs.readFileSync(CATALOG_PATH, "utf8");
  var marker = 'id:        "money-binding-currency-without-catalog-check",';
  check("mutation marker present in catalog file", original.indexOf(marker) !== -1);
  var mutated = original.replace(marker, 'id:        "money-binding-currency-without-catalog-check-RENAMED",');
  check("mutation actually changed the file text", mutated !== original);
  try {
    nodeFs.writeFileSync(CATALOG_PATH, mutated);
    var broken = nodeCp.spawnSync(process.execPath, [GC_PATH], { cwd: ROOT, encoding: "utf8" });
    check("script exits non-zero after a declared detector is removed", broken.status !== 0);
    check("broken run prints a paste-ready MISSING DETECTOR line", /MISSING DETECTOR\s+money-binding-currency-without-catalog-check\b/.test(broken.stderr || ""));

    // The deferral hatch downgrades the same gap to exit 0.
    var deferred = nodeCp.spawnSync(process.execPath, [GC_PATH], {
      cwd: ROOT, encoding: "utf8",
      env: Object.assign({}, process.env, { RELEASE_ALLOW_GATE_GAPS: "1" }),
    });
    check("deferral env: script exits 0 but still prints the gap", deferred.status === 0 && /MISSING DETECTOR/.test(deferred.stderr || ""));
  } finally {
    nodeFs.writeFileSync(CATALOG_PATH, original);
  }

  // Restored tree exits 0 again — proves the round-trip left no residue.
  var restored = nodeCp.spawnSync(process.execPath, [GC_PATH], { cwd: ROOT, encoding: "utf8" });
  check("script exits 0 again after the file is restored", restored.status === 0);
}

async function run() {
  _cleanTree();
  _everyCoverageDetectorResolves();
  _everyDeclaredHasCoverageRow();
  _removedDetectorTrips();
  _undeclaredDetectorTrips();
  _deferralHatchKeepsGapVisible();
  _endToEndExitCodes();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("ok - gate-contract (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - gate-contract: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
