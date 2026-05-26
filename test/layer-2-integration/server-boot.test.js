"use strict";
/**
 * Production entry-point boot + liveness gate.
 *
 * Spawns the REAL `node server.js` the way the container runs it (with the
 * documented VAULT_PASSPHRASE secret and a tmpfs dir) and asserts it:
 *   1. actually reaches "listening" — i.e. createApp's wrapped vault +
 *      audit-signing components unlock from the single documented secret
 *      instead of crash-looping (the boot bug that took every write route
 *      down on the deploy while edge reads kept working);
 *   2. answers the Node liveness probe (browser-shaped → passes bot-guard)
 *      with a 2xx — the Docker HEALTHCHECK contract;
 *   3. still 403s a header-less client on the same path — bot-guard stays
 *      fully on; the probe is a well-shaped caller, not an exemption.
 *
 * This is the layer the in-process integration tests miss: they mount the
 * storefront with permissive middleware and never exercise server.js's own
 * boot + the production middleware defaults. Network: loopback only.
 *
 * Spawning is done with `spawn(nodeBin, [scriptPath])` — an argv array, no
 * shell — so there is no command-injection surface.
 */

var childProc = require("node:child_process");
var nodeHttp  = require("node:http");
var nodeFs    = require("node:fs");
var nodeOs    = require("node:os");
var nodePath  = require("node:path");

var helpers = require("../helpers");
var check   = helpers.check;

var nodeBin     = process.argv[0]; // the node binary running this test
var REPO_ROOT   = nodePath.resolve(__dirname, "..", "..");
var SERVER_JS   = nodePath.join(REPO_ROOT, "server.js");
var HEALTHCHECK = nodePath.join(REPO_ROOT, "scripts", "healthcheck.js");

function _get(port, headers) {
  return new Promise(function (resolve, reject) {
    var req = nodeHttp.request({ host: "127.0.0.1", port: port, path: "/_/health", method: "GET", timeout: 4000, headers: headers || {} }, function (res) {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function _run() {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-boot-"));
  var tmpDir  = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-boot-tmp-"));

  var child = childProc.spawn(nodeBin, [SERVER_JS], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, {
      PORT:                   "0",        // ephemeral; parse the bound port from stdout
      DATA_DIR:               dataDir,
      VAULT_PASSPHRASE:       "boot-test-passphrase",   // the single DOCUMENTED secret
      BLAMEJS_TMPDIR:         tmpDir,                   // CI /tmp may not be tmpfs; trust an explicit dir
      BLAMEJS_SKIP_NTP_CHECK: "1",
      // Ensure no inherited BLAMEJS_* shadows the documented-name bridge.
      BLAMEJS_VAULT_PASSPHRASE:         "",
      BLAMEJS_AUDIT_SIGNING_PASSPHRASE: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  var out = "";
  var exited = null;
  child.stdout.on("data", function (b) { out += b.toString(); });
  child.stderr.on("data", function (b) { out += b.toString(); });
  child.on("exit", function (code) { exited = code; });

  try {
    // 1. Boot reaches "listening on :<port>" — never crash-loops on the
    //    wrapped-component passphrases.
    var port = null;
    await helpers.waitUntil(function () {
      if (exited !== null) throw new Error("server.js exited (" + exited + ") before listening — boot crash:\n" + out.slice(-600));
      var m = /listening on :(\d+)/.exec(out);
      if (m) { port = parseInt(m[1], 10); return true; }
      return false;
    }, { timeoutMs: 20000, intervalMs: 100, label: "server.js boot: listening" });
    check("server.js boots and listens", typeof port === "number" && port > 0);

    // 2. The Node liveness probe (browser-shaped) passes bot-guard → 2xx.
    var hc = await new Promise(function (resolve) {
      var p = childProc.spawn(nodeBin, [HEALTHCHECK], { env: Object.assign({}, process.env, { PORT: String(port) }), stdio: "ignore" });
      p.on("exit", function (code) { resolve(code); });
    });
    check("node healthcheck probe exits 0", hc === 0);

    // 3. A header-less client is still blocked on the same path — bot-guard
    //    is intact; the probe is a well-shaped caller, not an exemption.
    var headerless = await _get(port, {});
    check("header-less /_/health still 403 (bot-guard on)", headerless === 403);

    // And the browser-shaped request the probe sends is allowed.
    var browserish = await _get(port, {
      "user-agent": "Mozilla/5.0 (compatible; blamejs-shop-healthcheck)",
      "accept": "text/html", "accept-language": "en-US", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin",
    });
    check("browser-shaped /_/health is 2xx", browserish >= 200 && browserish < 400);
  } finally {
    try { child.kill(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
    try { nodeFs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
