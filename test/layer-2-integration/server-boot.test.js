"use strict";
/**
 * Production entry-point boot + liveness gate.
 *
 * Two boots of the REAL `node server.js`, the way the container runs it
 * (documented VAULT_PASSPHRASE secret + a tmpfs dir):
 *
 * BARE BOOT (no D1 bridge) — the Docker HEALTHCHECK contract:
 *   1. actually reaches "listening" — i.e. createApp's wrapped vault +
 *      audit-signing components unlock from the single documented secret
 *      instead of crash-looping (the boot bug that took every write route
 *      down on the deploy while edge reads kept working);
 *   2. answers the Node liveness probe (browser-shaped → passes bot-guard)
 *      with a 2xx — the Docker HEALTHCHECK contract;
 *   3. still 403s a header-less client on the same path — bot-guard stays
 *      fully on; the probe is a well-shaped caller, not an exemption.
 *
 * BRIDGED BOOT (loopback D1-bridge stub) — the dep-wiring liveness gate.
 *   server.js gates its ENTIRE catalog + cart + storefront + admin
 *   composition on D1_BRIDGE_URL/SECRET (it falls back to a JSON identity
 *   ping without them), so only a bridge-backed boot can prove a
 *   dep-gated surface actually reaches the wire. A feature whose dep
 *   server.js forgets to inject renders nothing here even though the unit
 *   tests (which inject the dep directly) pass — booting the real
 *   composition and reading the wire is the only layer that catches that
 *   class. Two instances of it shipped dark before this gate existed: the
 *   cart coupon entry (deps.autoDiscount) and the low-stock alert intake
 *   (/_/low-stock-alert + the admin alerts screen).
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

var bShop = require("../../lib");

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

// Raw GET with EXACTLY the caller-supplied headers — used to mimic a
// plain curl invocation (curl UA, Accept: */*, no Accept-Language),
// which helpers.httpRequest would decorate into a browser shape.
function _rawGet(port, path, headers) {
  return new Promise(function (resolve, reject) {
    var req = nodeHttp.request({
      host: "127.0.0.1", port: port, path: path, method: "GET", timeout: 5000,
      headers: headers || {},
    }, function (res) {
      var body = "";
      res.on("data", function (c) { body += c.toString(); });
      res.on("end", function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// Raw POST with EXACTLY the caller-supplied headers — used to mimic the
// worker's internal service-binding POSTs (x-d1-bridge-secret + JSON, no
// browser shape at all), which helpers.httpRequest would decorate.
function _rawPost(port, path, headers, bodyStr) {
  return new Promise(function (resolve, reject) {
    var buf = Buffer.from(bodyStr || "", "utf8");
    var req = nodeHttp.request({
      host: "127.0.0.1", port: port, path: path, method: "POST", timeout: 5000,
      headers: Object.assign({ "content-length": String(buf.length) }, headers || {}),
    }, function (res) {
      var body = "";
      res.on("data", function (c) { body += c.toString(); });
      res.on("end", function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
    req.write(buf);
    req.end();
  });
}

// Spawn server.js with `extraEnv` and resolve `{ child, port, output }`
// once it logs "listening on :<port>". The caller owns child.kill().
async function _boot(extraEnv, label) {
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
      // Bare boot must stay bare even if the invoking shell carries
      // bridge credentials; the bridged boot overrides via extraEnv.
      D1_BRIDGE_URL:    "",
      D1_BRIDGE_SECRET: "",
    }, extraEnv || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });

  var state = { child: child, port: null, output: "", exited: null, dataDir: dataDir, tmpDir: tmpDir };
  child.stdout.on("data", function (b) { state.output += b.toString(); });
  child.stderr.on("data", function (b) { state.output += b.toString(); });
  child.on("exit", function (code) { state.exited = code; });

  await helpers.waitUntil(function () {
    if (state.exited !== null) throw new Error("server.js exited (" + state.exited + ") before listening — boot crash (" + label + "):\n" + state.output.slice(-600));
    var m = /listening on :(\d+)/.exec(state.output);
    if (m) { state.port = parseInt(m[1], 10); return true; }
    return false;
  }, { timeoutMs: 20000, intervalMs: 100, label: "server.js boot: listening (" + label + ")" });
  return state;
}

function _cleanup(state) {
  try { state.child.kill(); } catch (_e) { /* */ }
  try { nodeFs.rmSync(state.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  try { nodeFs.rmSync(state.tmpDir, { recursive: true, force: true }); } catch (_e) { /* */ }
}

async function _runBare() {
  var state = await _boot(null, "bare");
  try {
    // 1. Boot reaches "listening on :<port>" — never crash-loops on the
    //    wrapped-component passphrases.
    check("server.js boots and listens", typeof state.port === "number" && state.port > 0);

    // 2. The Node liveness probe (browser-shaped) passes bot-guard → 2xx.
    var hc = await new Promise(function (resolve) {
      var p = childProc.spawn(nodeBin, [HEALTHCHECK], { env: Object.assign({}, process.env, { PORT: String(state.port) }), stdio: "ignore" });
      p.on("exit", function (code) { resolve(code); });
    });
    check("node healthcheck probe exits 0", hc === 0);

    // 3. A header-less client is still blocked on the same path — bot-guard
    //    is intact; the probe is a well-shaped caller, not an exemption.
    var headerless = await _get(state.port, {});
    check("header-less /_/health still 403 (bot-guard on)", headerless === 403);

    // And the browser-shaped request the probe sends is allowed.
    var browserish = await _get(state.port, {
      "user-agent": "Mozilla/5.0 (compatible; blamejs-shop-healthcheck)",
      "accept": "text/html", "accept-language": "en-US", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin",
    });
    check("browser-shaped /_/health is 2xx", browserish >= 200 && browserish < 400);
  } finally {
    _cleanup(state);
  }
}

async function _runBridged() {
  // Full shop schema in memory + a real seeded product, shared between the
  // bridge stub the spawned server queries through and this process (which
  // inspects rows directly after driving the HTTP surface).
  var BRIDGE_SECRET = "boot-test-bridge-secret";
  var mem = helpers.memD1Query(helpers.allMigrationPaths(), { tolerant: true });
  var catalog = bShop.catalog.create({ query: mem.query });
  var product = await catalog.products.create({ slug: "boot-widget", title: "Boot Widget", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "BOOT-1", title: "Default" });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 1900 });
  await catalog.inventory.create("BOOT-1", { stock_on_hand: 50 });

  // A code-gated discount rule, so the coupon apply below exercises the
  // real engine lookup — not just the form render.
  var autoDiscount = bShop.autoDiscount.create({ query: mem.query });
  await autoDiscount.defineRule({
    slug:    "boot-coupon",
    title:   "Boot coupon",
    trigger: { kind: "cart_total_min", min_minor: 100 },
    value:   { kind: "percent_off", basis_points: 1000 },
    unlock_code: "BOOTCODE10",
  });

  // A second SKU sitting under its low-stock threshold — the trigger
  // check below mutates ITS stock through the admin surface and expects
  // the catalog's stock observer to fire the alert, with no direct POST
  // to the intake endpoint anywhere near it.
  var ADMIN_KEY = "boot-test-admin-key-01";
  var lowProduct = await catalog.products.create({ slug: "boot-low-widget", title: "Boot Low Widget", status: "active" });
  var lowVariant = await catalog.variants.create(lowProduct.id, { sku: "BOOT-LOW", title: "Default" });
  await catalog.prices.set(lowVariant.id, { currency: "USD", amount_minor: 900 });
  await catalog.inventory.create("BOOT-LOW", { stock_on_hand: 1 });
  await catalog.inventory.setThreshold("BOOT-LOW", 5);

  // An ACTIVE search-ranking weight set, so the /search impression sink has
  // a weight set to attribute against (recordSearchEvent no-ops without one).
  // The container reranks through this same primitive over the bridge.
  var searchRanking = bShop.searchRanking.create({ query: mem.query });
  await searchRanking.defineWeights({ slug: "boot-weights", name: "Boot weights", weights: { in_stock: 1 } });
  await searchRanking.setActiveWeights("boot-weights");

  var bridge = await helpers.startD1Bridge({ query: mem.query, secret: BRIDGE_SECRET });
  var state = null;
  try {
    state = await _boot({ D1_BRIDGE_URL: bridge.url, D1_BRIDGE_SECRET: BRIDGE_SECRET, ADMIN_API_KEY: ADMIN_KEY }, "bridged");

    // 5. The bridge-gated composition mounts: /cart is a storefront page,
    //    not the bare-mode JSON identity ping / 404.
    var jar = helpers.cookieJar();
    var browserHeaders = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" };
    var cartAnon = await helpers.httpRequest({ port: state.port, path: "/cart", jar: jar, headers: browserHeaders });
    check("bridged boot: GET /cart is 2xx (storefront mounted)", cartAnon.status >= 200 && cartAnon.status < 400);

    // 6. Dep-wiring liveness — the coupon entry. The block + its POST
    //    routes render only when server.js hands the auto-discount engine
    //    to the storefront deps, and only on a session-bound cart — so add
    //    a real line first (POST /cart/lines is an edge-POST path:
    //    SameSite + fetch-metadata, no per-form token) and read the wire.
    var added = await helpers.httpRequest({
      port: state.port, path: "/cart/lines", method: "POST", jar: jar,
      headers: browserHeaders,
      form: { variant_id: variant.id, qty: "1" },
    });
    check("bridged boot: POST /cart/lines redirects (303)", added.status === 303);
    check("bridged boot: session cookie issued on add-to-cart", !!jar.get("shop_sid"));

    var cart = await helpers.httpRequest({ port: state.port, path: "/cart", jar: jar, headers: browserHeaders });
    check("bridged boot: session GET /cart is 2xx", cart.status >= 200 && cart.status < 400);
    check("bridged boot: cart line renders", cart.body.indexOf("Boot Widget") !== -1);
    check("bridged boot: cart renders the discount-code entry (auto-discount wired into the storefront)",
      cart.body.indexOf("cart-coupon__form") !== -1 && cart.body.indexOf("Have a discount code?") !== -1);

    // The apply round-trip exercises the full production stack: the
    // coupon POST is NOT edge-exempt, so the double-submit token the
    // page-assembly chokepoint stamped into the form must ride back (the
    // jar echoes the csrf cookie as the header twin), the tight
    // per-client budget admits the request, and the engine resolves the
    // seeded code-gated rule into a persisted cart code.
    var applied = await helpers.httpRequest({
      port: state.port, path: "/cart/coupon", method: "POST", jar: jar,
      headers: browserHeaders, form: { code: "BOOTCODE10" },
    });
    check("bridged boot: POST /cart/coupon applies the seeded code (303 → code_applied)",
      applied.status === 303 && /code_applied=1/.test(String(applied.headers.location || "")));
    var cartApplied = await helpers.httpRequest({ port: state.port, path: "/cart", jar: jar, headers: browserHeaders });
    check("bridged boot: applied-code chip renders on the cart", cartApplied.body.indexOf("BOOTCODE10") !== -1);

    // 6b. Dep-wiring liveness — the search-suggestions autocomplete. The
    //     JSON route mounts only when server.js hands searchSuggestions to
    //     the storefront deps; it returns product matches off the catalog,
    //     so a query for the seeded title surfaces "Boot Widget". And the
    //     shared header carries the island hook (`data-suggest`) so the
    //     autocomplete upgrades the plain search form on every chrome page.
    var suggest = await helpers.httpRequest({
      port: state.port, path: "/search/suggestions?q=boot", jar: jar, headers: browserHeaders,
    });
    check("bridged boot: GET /search/suggestions is 2xx (searchSuggestions wired)",
      suggest.status >= 200 && suggest.status < 400);
    var suggestJson = null;
    try { suggestJson = JSON.parse(suggest.body); } catch (_e) { suggestJson = null; }
    check("bridged boot: /search/suggestions body is JSON with a products array",
      !!suggestJson && Array.isArray(suggestJson.products));
    check("bridged boot: suggestions products contain the seeded Boot Widget",
      !!suggestJson && suggestJson.products.some(function (p) {
        return p && (p.title === "Boot Widget" || p.name === "Boot Widget");
      }));
    check("bridged boot: cart page carries the search-suggest island hook (data-suggest)",
      cart.body.indexOf("data-suggest=\"/search/suggestions\"") !== -1);

    // 6c. Search-ranking impression intake. The /search handler reranks its
    //     universe through searchRanking.applyToResults and then logs one
    //     impression per rendered result list against the ACTIVE weight set
    //     (seeded above). The event is a drop-silent, fire-and-forget write,
    //     so poll the table rather than asserting synchronously off the
    //     response. A regression that drops the impression call (the intake-
    //     without-trigger gap) leaves the search_events table empty here
    //     even though /search itself still 200s.
    var searchPage = await helpers.httpRequest({
      port: state.port, path: "/search?q=boot", jar: jar, headers: browserHeaders,
    });
    check("bridged boot: GET /search is 2xx (storefront search mounted)",
      searchPage.status >= 200 && searchPage.status < 400);
    check("bridged boot: search result links carry the ?from=search click marker",
      searchPage.body.indexOf("?from=search") !== -1);
    await helpers.waitUntil(function () {
      var r = mem.db.prepare(
        "SELECT COUNT(*) AS n FROM search_events WHERE event_type = 'impression' AND weights_slug = ?"
      ).get("boot-weights");
      return r && Number(r.n) >= 1;
    }, { timeoutMs: 5000, label: "bridged boot: /search writes a search_events impression row" });
    var impressionRows = mem.db.prepare(
      "SELECT COUNT(*) AS n FROM search_events WHERE event_type = 'impression' AND weights_slug = ?"
    ).get("boot-weights");
    check("bridged boot: /search writes a search_events impression row through the bridge",
      impressionRows && Number(impressionRows.n) >= 1);

    // 7. Internal-endpoint liveness, WORKER-SHAPED. The worker's
    //    service-binding POSTs carry no browser fingerprint (no
    //    User-Agent, no Accept-Language) — bot-guard's default heuristics
    //    403'd that shape silently for the entire cron/event family until
    //    INTERNAL_BRIDGE_PATHS exempted it, so every probe here sends the
    //    bare worker shape on purpose: a regression in that exemption
    //    re-darkens all seven endpoints at once.
    var tick = await _rawPost(state.port, "/_/cart-recovery-tick",
      { "content-type": "application/json; charset=utf-8", "x-d1-bridge-secret": BRIDGE_SECRET }, "{}");
    check("bridged boot: worker-shaped /_/cart-recovery-tick reaches its handler (2xx ok:true)",
      tick.status === 200 && /"ok":true/.test(tick.body));

    // 8. Dep-wiring liveness — the low-stock alert intake. Mimic the
    //    InventoryLock DO's fire-and-forget POST exactly (shared-secret
    //    header + JSON body, no browser shape): the route must exist,
    //    refuse a missing secret, and persist the alert row through the
    //    same bridge the rest of the composition uses.
    var unauth = await _rawPost(state.port, "/_/low-stock-alert",
      { "content-type": "application/json; charset=utf-8" },
      JSON.stringify({ sku: "BOOT-1", available: 1, threshold: 5 }));
    check("bridged boot: /_/low-stock-alert without secret is 401", unauth.status === 401);

    var alert = await _rawPost(state.port, "/_/low-stock-alert",
      { "content-type": "application/json; charset=utf-8", "x-d1-bridge-secret": BRIDGE_SECRET },
      JSON.stringify({ sku: "BOOT-1", available: 1, threshold: 5 }));
    check("bridged boot: /_/low-stock-alert fires (2xx ok:true)", alert.status === 200 && /"ok":true/.test(alert.body) && /"enabled":true/.test(alert.body));
    var alertRows = mem.db.prepare("SELECT COUNT(*) AS n FROM inventory_alerts WHERE sku = ?").get("BOOT-1");
    check("bridged boot: inventory_alerts row persisted through the bridge", alertRows && Number(alertRows.n) === 1);

    var badShape = await _rawPost(state.port, "/_/low-stock-alert",
      { "content-type": "application/json; charset=utf-8", "x-d1-bridge-secret": BRIDGE_SECRET },
      JSON.stringify({ sku: "BOOT-1", available: -2, threshold: 5 }));
    check("bridged boot: malformed low-stock body is 400", badShape.status === 400);

    // 9. The low-stock TRIGGER, end to end. An admin restock through the
    //    wire mutates stock on a SKU sitting under its threshold
    //    (1 → 2, threshold 5), and the catalog's stock observer drives
    //    the alerts engine into a persisted row — no direct POST to the
    //    intake endpoint anywhere in this step. This is the check that
    //    fails when the observer wiring between catalog.create and the
    //    alerts instance is dropped: every shipped stock path (checkout
    //    hold, release, decrement, restock) reports through the same
    //    observer, and restock is the one reachable over plain HTTP
    //    here. Bearer-token JSON call, browser-shaped enough for
    //    bot-guard (UA + accept-language).
    var restock = await _rawPost(state.port, "/admin/inventory/BOOT-LOW/restock",
      {
        "content-type":    "application/json; charset=utf-8",
        "authorization":   "Bearer " + ADMIN_KEY,
        "user-agent":      "Mozilla/5.0 (compatible; blamejs-shop-boot-test)",
        "accept-language": "en-US",
      },
      JSON.stringify({ qty: 1 }));
    check("bridged boot: admin restock accepted (2xx)", restock.status >= 200 && restock.status < 400);
    var triggered = mem.db.prepare("SELECT COUNT(*) AS n FROM inventory_alerts WHERE sku = ?").get("BOOT-LOW");
    check("bridged boot: a stock mutation fires the low-stock alert through the catalog observer",
      triggered && Number(triggered.n) === 1);

    // 10. The documented admin JSON surface really is one curl away.
    //     curl's User-Agent sits on bot-guard's deny list and the UA
    //     check runs before auth is ever consulted, so the app-level
    //     block-mode bot-guard skips /admin and mountRouteGuards
    //     re-mounts it there in TAG mode — automation is audited
    //     (system.botguard.tag) but never refused, and the timing-safe
    //     bearer gate stays the deciding check. Prove both halves
    //     through the real composition: a curl-shaped call WITH the key
    //     reaches the handler, and the same call WITHOUT the key is
    //     refused by the auth gate (401), not mistaken for a bot (403).
    var curlOk = await _rawGet(state.port, "/admin/products/search?q=boot",
      { "authorization": "Bearer " + ADMIN_KEY, "user-agent": "curl/8.5.0", "accept": "*/*" });
    check("bridged boot: curl-shaped bearer call reaches the admin JSON surface (2xx)",
      curlOk.status >= 200 && curlOk.status < 300);
    var curlNoKey = await _rawGet(state.port, "/admin/products/search?q=boot",
      { "user-agent": "curl/8.5.0", "accept": "*/*" });
    check("bridged boot: curl-shaped call without the key answers 401 from the bearer gate, not 403 from bot-guard",
      curlNoKey.status === 401);

    // 11. Dep-wiring liveness — the B2B quotes surface. The quotes primitive
    //     is handed to BOTH the admin console (deps.quotes) and the storefront
    //     (sfDeps.quotes) in server.js; a missing injection darkens both the
    //     /admin/quotes response queue and the tokened /quote/:token page even
    //     though the unit tests (which inject the dep directly) pass. Seed a
    //     responded quote through the SAME bridge-backed query the running
    //     server reads, then prove both surfaces reach the wire: the admin
    //     console lists it (bearer JSON), and the customer's capability link
    //     renders the actionable quote.
    var quotesSeed = bShop.quotes.create({ query: mem.query });
    var quoteCustomerId = bShop.framework.uuid.v7();
    var seededQuote = await quotesSeed.requestQuote({
      customer_id: quoteCustomerId,
      lines:       [{ sku: "BOOT-1", quantity: 5 }],
      message:     "Bulk order for the boot test",
    });
    check("bridged boot: quote requested with a view token", !!seededQuote && !!seededQuote.view_token);
    var respondedQuote = await quotesSeed.respondToQuote({
      quote_id:    seededQuote.id,
      line_prices: [{ sku: "BOOT-1", unit_price_minor: 1500 }],
      valid_until: Date.now() + 7 * 24 * 60 * 60 * 1000,
      currency:    "USD",
    });
    check("bridged boot: quote responded (total computed)", respondedQuote.status === "responded" && respondedQuote.total_minor === 7500);

    // Admin response queue + customer-scoped list, through the bearer JSON
    // surface (proves deps.quotes reached admin.mount).
    var adminQuotes = await _rawGet(state.port, "/admin/quotes?customer_id=" + encodeURIComponent(quoteCustomerId),
      { "authorization": "Bearer " + ADMIN_KEY, "user-agent": "curl/8.5.0", "accept": "*/*" });
    check("bridged boot: GET /admin/quotes reaches the console (2xx, quotes wired)",
      adminQuotes.status >= 200 && adminQuotes.status < 300);
    var adminQuotesJson = null;
    try { adminQuotesJson = JSON.parse(adminQuotes.body); } catch (_e) { adminQuotesJson = null; }
    check("bridged boot: /admin/quotes lists the seeded quote",
      !!adminQuotesJson && Array.isArray(adminQuotesJson.rows) &&
      adminQuotesJson.rows.some(function (q) { return q.id === seededQuote.id; }));

    // The tokened customer page renders the actionable quote (proves
    // sfDeps.quotes reached storefront.mount). Browser-shaped so bot-guard
    // admits it; the token is the access.
    var quotePage = await helpers.httpRequest({
      port: state.port, path: "/quote/" + encodeURIComponent(seededQuote.view_token),
      jar: helpers.cookieJar(), headers: browserHeaders,
    });
    check("bridged boot: GET /quote/:token is 2xx (storefront quotes mounted)",
      quotePage.status >= 200 && quotePage.status < 400);
    check("bridged boot: quote page renders the accept control",
      quotePage.body.indexOf("Accept this quote") !== -1);
    // A garbage token resolves to the not-found state (404) — the hash lookup
    // never widens to leak another quote.
    var badQuote = await helpers.httpRequest({
      port: state.port, path: "/quote/" + ("x".repeat(43)),
      jar: helpers.cookieJar(), headers: browserHeaders,
    });
    check("bridged boot: unknown quote token is 404", badQuote.status === 404);
  } finally {
    if (state) _cleanup(state);
    await bridge.close();
  }
}

async function _run() {
  await _runBare();
  await _runBridged();
}

module.exports = { run: _run };
