"use strict";
/**
 * Local end-to-end account-subscriptions driver — boots the real authed
 * account server (test/e2e/serve-account.js, which mounts the FULL
 * production middleware composition: bot-guard, global rate-limit,
 * fetch-metadata, scoped double-submit CSRF, sealed cookies — and serves
 * the real theme assets so the islands load), waits for E2E_READY, then
 * drives the SIGNED-IN subscription plan-change flow in a REAL browser
 * (Playwright/Chromium) and asserts:
 *
 *   (a) GET /account/subscriptions renders the subscription card + the
 *       "Change plan" link.
 *   (b) GET /account/subscriptions/<id>/change renders the candidate
 *       plans + the proration copy ("you'll be charged" / "in store
 *       credit").
 *   (c) Submitting the change form (immediate -> premium) lands on
 *       /account/subscriptions?ok=plan_changed and the plan now shows
 *       premium.
 *   (d) NO browser console error fires on these AUTHED pages (CSP /
 *       Trusted-Types violation, broken island, failed fetch, page error).
 *
 * Why a real browser: the storefront's auth is passwordless (WebAuthn /
 * magic-link), so the prod Playwright sweep stops at the login screen and
 * never validates an authed page. Here the server prints the sealed
 * `shop_auth` cookie the framework ITSELF mints; the driver injects it
 * into the browser context (context.addCookies) — no login-bypass
 * endpoint, no weakened middleware.
 *
 * Browser library: `playwright` (chromium). Not an npm RUNTIME dep — a
 * dev/test-only tool, run on demand. If `require("playwright")` fails the
 * driver exits non-zero with the install hint
 * (`npx playwright install chromium`), the same way a missing toolchain
 * would fail any other test driver.
 *
 * NO worker/ import: this driver imports only ../helpers + playwright +
 * node builtins and spawns serve-account.js (which imports ../../lib,
 * never worker/). Do NOT add a worker/ require here.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodePath  = require("node:path");
var childProc = require("node:child_process");

var helpers = require("../helpers");

var PORT = process.env.E2E_PORT || "8098";

function _fail(msg) {
  process.stderr.write("[e2e-account] FAIL: " + msg + "\n");
}

// Load Playwright; a missing install is a clear, actionable failure
// rather than an opaque MODULE_NOT_FOUND. Bind the error and surface its
// message + the fix command (no swallow, no hard-coded failure string
// that throws the cause away).
function _loadPlaywright() {
  try {
    return require("playwright");
  } catch (e) {
    var detail = (e && e.message) || String(e);
    throw new Error(
      "playwright is not installed (" + detail + "). Install it with: " +
      "npm install --no-save playwright && npx playwright install chromium",
    );
  }
}

async function main() {
  var playwright = _loadPlaywright();

  var serverStderr = "";
  var serverStdout = "";
  var ready = { port: null };
  var authInfo = { customerId: null, cookie: null, subId: null };

  var child = childProc.spawn(
    process.execPath,
    [nodePath.join(__dirname, "serve-account.js")],
    { env: Object.assign({}, process.env, { E2E_PORT: PORT }), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", function (c) {
    var s = c.toString("utf8");
    serverStdout += s;
    var auth = /E2E_AUTH\s+(\S+)\s+(\S+)\s+(\S+)/.exec(serverStdout);
    if (auth) {
      authInfo.customerId = auth[1];
      authInfo.cookie     = auth[2];
      authInfo.subId      = auth[3];
    }
    var m = /E2E_READY\s+(\d+)/.exec(serverStdout);
    if (m) ready.port = parseInt(m[1], 10);
  });
  child.stderr.on("data", function (c) { serverStderr += c.toString("utf8"); });

  var exited = { code: null };
  child.on("exit", function (code) { exited.code = code; });

  var browser = null;
  function _stopServer() { try { child.kill("SIGTERM"); } catch (_e) { /* best-effort */ } }
  process.on("exit", _stopServer);

  // Every console error / page error / failed request harvested across the
  // authed navigation, so a single summary lists them all.
  var consoleErrors = [];

  try {
    // Wait for the server to print E2E_READY (cold runner — generous budget).
    await helpers.waitUntil(function () {
      if (exited.code != null) throw new Error("serve-account.js exited early (code " + exited.code + ")\n" + serverStderr);
      return ready.port != null;
    }, { timeoutMs: 30000, label: "e2e-account: serve-account.js E2E_READY" });

    if (!authInfo.cookie || !authInfo.customerId || !authInfo.subId) {
      throw new Error("serve-account.js printed no E2E_AUTH line\n" + serverStdout + "\n" + serverStderr);
    }

    var port = ready.port;
    var origin = "http://127.0.0.1:" + port;

    // Split the printed `shop_auth=<sealed>` into name + value. The value
    // is URL-encoded on the wire (the framework cookie writer encodes it);
    // addCookies wants the value EXACTLY as it appears in the Cookie header,
    // so the encoded form is correct (the server's cookie reader decodes it).
    var eq = authInfo.cookie.indexOf("=");
    if (eq <= 0) throw new Error("malformed E2E_AUTH cookie: " + authInfo.cookie);
    var cookieName  = authInfo.cookie.slice(0, eq);
    var cookieValue = authInfo.cookie.slice(eq + 1);

    browser = await playwright.chromium.launch({ headless: true });
    var context = await browser.newContext({
      // A real-browser UA + Accept-Language so the bot-guard middleware
      // admits the navigation (the same shape helpers.httpRequest sends).
      userAgent: "Mozilla/5.0 (e2e-account-driver) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/Playwright",
      locale:    "en-US",
    });

    // Inject the sealed auth cookie the framework minted. Loopback is plain
    // HTTP, so the cookie name is the bare `shop_auth` (not `__Host-`),
    // path `/`, domain `127.0.0.1`, NOT secure (matches what the server
    // wrote). This is the exact envelope a real sign-in would set.
    await context.addCookies([{
      name:     cookieName,
      value:    cookieValue,
      domain:   "127.0.0.1",
      path:     "/",
      httpOnly: true,
      secure:   false,
      sameSite: "Lax",
    }]);

    var page = await context.newPage();

    // Harvest EVERY console error, page error (uncaught JS), and failed
    // request across the whole flow. A CSP / Trusted-Types violation, a
    // broken island, or a failed island fetch all surface here.
    page.on("console", function (msg) {
      if (msg.type() === "error") {
        consoleErrors.push("console.error: " + msg.text() + " @ " + (msg.location() ? msg.location().url : "?"));
      }
    });
    page.on("pageerror", function (err) {
      consoleErrors.push("pageerror: " + ((err && err.message) || String(err)));
    });
    page.on("requestfailed", function (req) {
      var f = req.failure();
      consoleErrors.push("requestfailed: " + req.url() + " (" + (f ? f.errorText : "unknown") + ")");
    });

    // ---- (a) /account/subscriptions renders the card + change link -------
    var listResp = await page.goto(origin + "/account/subscriptions", { waitUntil: "networkidle" });
    helpers.check("subscriptions list 200", listResp && listResp.status() === 200);
    // The card class + the "Change plan" link to THIS subscription render.
    var hasCard = await page.$(".subscription-card");
    helpers.check("subscriptions list shows a subscription card", !!hasCard);
    var changeHref = "/account/subscriptions/" + authInfo.subId + "/change";
    var hasChangeLink = await page.$("a[href=\"" + changeHref + "\"]");
    helpers.check("subscriptions list shows the Change plan link", !!hasChangeLink);

    // ---- (b) the change page renders candidates + proration copy ---------
    var changeResp = await page.goto(origin + changeHref, { waitUntil: "networkidle" });
    helpers.check("change page 200", changeResp && changeResp.status() === 200);
    var changeHtml = await page.content();
    // Candidate radios for the premium upgrade + the cheap downgrade.
    helpers.check("change page offers candidate plan radios", (await page.$$("input[name=\"new_plan_id\"]")).length >= 2);
    // The upgrade preview shows a charge; the downgrade shows a store-credit
    // line. Both proration phrases are rendered on the page.
    helpers.check("change page shows a proration charge copy", changeHtml.indexOf("you'll be charged") !== -1);
    helpers.check("change page shows a store-credit copy",     changeHtml.indexOf("in store credit") !== -1);
    helpers.check("change page offers both timing radios", (await page.$$("input[name=\"timing\"]")).length >= 2);

    // ---- (c) submit the change (immediate -> premium) --------------------
    // Pick the premium (upgrade) candidate so the change is an upgrade,
    // select the immediate timing, and submit the real form in the browser.
    // The `_csrf` hidden field is auto-injected by the storefront form
    // chokepoint, so a native submit carries the token.
    //
    // Resolve the upgrade radio by the proration copy of its enclosing
    // option ("you'll be charged" = the upgrade), via a Playwright locator,
    // so the pick doesn't depend on DOM order. The radio is the input
    // inside the .plan-change-option that contains that phrase.
    var upgradeOption = page.locator(".plan-change-option", { hasText: "you'll be charged" });
    helpers.check("change page exposed an upgrade candidate to pick", (await upgradeOption.count()) >= 1);
    var upgradeRadio = upgradeOption.first().locator("input[name=\"new_plan_id\"]");
    await upgradeRadio.check();
    // Ensure the immediate timing radio is selected (it's checked by default,
    // but assert it explicitly).
    await page.check("input[name=\"timing\"][value=\"immediate\"]");

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click("button[type=\"submit\"].btn-primary"),
    ]);

    // Landed back on the list with the success marker.
    var landedUrl = page.url();
    helpers.check("change submit landed on the list ?ok=plan_changed",
      landedUrl.indexOf("/account/subscriptions") !== -1 && landedUrl.indexOf("ok=plan_changed") !== -1);
    // The list now shows the success notice + the plan reads premium ($40).
    var afterHtml = await page.content();
    helpers.check("post-change list shows the success notice (\"Your plan change is set.\")",
      afterHtml.indexOf("Your plan change is set.") !== -1);
    // The premium price ($40.00) now appears on the card.
    helpers.check("post-change card shows the premium price ($40.00)", afterHtml.indexOf("40.00") !== -1);

    // ---- (d) no console errors on the authed pages -----------------------
    helpers.check("no browser console errors on the authed subscription pages",
      consoleErrors.length === 0);

    process.stdout.write("[e2e-account] OK — " + helpers.getChecks() + " checks passed " +
      "(authed plan-change immediate upgrade -> premium, zero console errors)\n");
  } catch (e) {
    _fail((e && e.message) || String(e));
    if (consoleErrors.length) {
      process.stderr.write("--- console errors on authed pages (" + consoleErrors.length + ") ---\n");
      for (var i = 0; i < consoleErrors.length; i += 1) process.stderr.write("  " + consoleErrors[i] + "\n");
    }
    if (serverStderr) process.stderr.write("--- serve-account.js stderr ---\n" + serverStderr + "\n");
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch (_e) { /* best-effort */ } }
    _stopServer();
  }
}

main();
