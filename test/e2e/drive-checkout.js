"use strict";
/**
 * CI end-to-end checkout driver — boots the real e2e server (test/e2e/serve.js,
 * which mounts the FULL production middleware composition: bot-guard, global
 * rate-limit, fetch-metadata, scoped double-submit CSRF, sealed cookies),
 * waits for E2E_READY, then HTTP-drives a checkout through that live stack and
 * asserts:
 *   1. A CSRF-protected POST WITHOUT the token is rejected (403) — the guard
 *      is live.
 *   2. The SAME POST WITH the storefront-issued token round-trips (accepted).
 *   3. Add-to-cart lands a line in the session cart.
 *   4. Checkout creates an order that TRANSITIONS past `pending` (→ paid).
 *
 * HTTP-level only — no Playwright, no browser. The orchestration lives in
 * Node (not shell) so it is cross-platform and reuses test/helpers.
 *
 * NO worker/ import: this driver imports only test/helpers + node builtins
 * and spawns serve.js (which imports ../../lib, never worker/). Do NOT add a
 * worker/ require here (it would need an fs.existsSync guard and would brick
 * the in-image smoke).
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodePath  = require("node:path");
var childProc = require("node:child_process");

var helpers = require("../helpers");

var PORT = "8099";

function _fail(msg) {
  process.stderr.write("[e2e-drive] FAIL: " + msg + "\n");
}

async function main() {
  var serverStderr = "";
  var serverStdout = "";
  var ready = { port: null };

  var child = childProc.spawn(
    process.execPath,
    [nodePath.join(__dirname, "serve.js")],
    { env: Object.assign({}, process.env, { E2E_PORT: PORT }), stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", function (c) {
    var s = c.toString("utf8");
    serverStdout += s;
    var m = /E2E_READY\s+(\d+)/.exec(serverStdout);
    if (m) ready.port = parseInt(m[1], 10);
  });
  child.stderr.on("data", function (c) { serverStderr += c.toString("utf8"); });

  var exited = { code: null };
  child.on("exit", function (code) { exited.code = code; });

  function _stop() { try { child.kill("SIGTERM"); } catch (_e) { /* */ } }
  process.on("exit", _stop);

  try {
    // Wait for the server to print E2E_READY (cold CI runner — generous budget).
    await helpers.waitUntil(function () {
      if (exited.code != null) throw new Error("serve.js exited early (code " + exited.code + ")\n" + serverStderr);
      return ready.port != null;
    }, { timeoutMs: 30000, label: "e2e: serve.js E2E_READY" });

    var port = ready.port;
    var jar = helpers.cookieJar();

    // 1. GET the PDP — seeds the session + CSRF cookie into the jar.
    var pdp = await helpers.httpRequest({ port: port, path: "/products/e2e-widget", jar: jar });
    helpers.check("pdp 200", pdp.status === 200);
    helpers.check("csrf cookie seeded", !!(jar.get("csrf") || jar.get("__Host-csrf")));

    // Resolve the seeded variant id from the PDP add-to-cart form so the
    // add lands a real line (the form posts variant_id + qty).
    var vm = /name="variant_id"\s+value="([^"]+)"/.exec(pdp.body) ||
             /value="([^"]+)"\s+name="variant_id"/.exec(pdp.body);
    helpers.check("pdp exposes a variant_id", !!vm);
    var variantId = vm[1];

    // 2. CSRF live: a POST to the CSRF-protected checkout carrying the session
    //    csrf COOKIE but a WRONG double-submit token is rejected (403).
    //    /cart/lines is intentionally EDGE_POST_PATHS-exempt (cookieless edge
    //    form), so the CSRF assertion runs against /e2e/checkout, which is NOT
    //    exempt and therefore guarded. A non-empty bad token defeats the jar's
    //    auto-attach (the jar only fills in a token when none is set) so the
    //    request reaches the gate with a real cookie + a mismatched token —
    //    proving the gate validates the token value, not merely its presence.
    var badToken = await helpers.httpRequest({
      port: port, path: "/e2e/checkout", method: "POST", jar: jar,
      headers: { "x-csrf-token": "csrf-token-that-does-not-match" }, body: "",
    });
    helpers.check("bad-token checkout rejected (403)", badToken.status === 403);

    // 3. Add-to-cart (edge-exempt path; the jar attaches the token harmlessly).
    var add = await helpers.httpRequest({
      port: port, path: "/cart/lines", method: "POST", jar: jar,
      form: { variant_id: variantId, qty: "2" },
    });
    helpers.check("add-to-cart accepted (303)", add.status === 303);

    var cartView = await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    helpers.check("cart shows the line (E2E Widget)", cartView.body.indexOf("E2E Widget") !== -1);

    // 4. Checkout WITH the jar-attached CSRF token → order created + transitioned.
    var checkout = await helpers.httpRequest({
      port: port, path: "/e2e/checkout", method: "POST", jar: jar, body: "",
    });
    helpers.check("tokened checkout accepted (200)", checkout.status === 200);
    var out = JSON.parse(checkout.body);
    helpers.check("checkout returned an order_id", typeof out.order_id === "string" && out.order_id.length > 0);
    helpers.check("order transitioned past pending (paid)", out.status === "paid");

    process.stdout.write("[e2e-drive] OK — " + helpers.getChecks() + " checks passed " +
      "(CSRF round-trip + order " + out.order_id.slice(0, 8) + " → " + out.status + ")\n");
  } catch (e) {
    _fail((e && e.message) || String(e));
    if (serverStderr) process.stderr.write("--- serve.js stderr ---\n" + serverStderr + "\n");
    _stop();
    process.exitCode = 1;
    return;
  } finally {
    _stop();
  }
}

main();
