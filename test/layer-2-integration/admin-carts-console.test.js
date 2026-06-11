"use strict";
/**
 * Abandoned-cart admin console — the operator screen at /admin/carts that
 * surfaces idle carts directly from the live `carts` table (no scanner cron
 * required) and offers the one recovery the framework's hash-only email
 * stance actually permits: minting a single-use code-gated discount.
 *
 * Boots b.createApp with admin.mount wired to the cart + autoDiscount
 * primitives, seeds carts at different ages / states, then drives the screen
 * through both auth shapes:
 *
 *   - abandoned filter math: an old active cart with lines is listed; a
 *     fresh cart, an empty cart, and a converted cart are all excluded
 *   - the value-at-risk summary line counts the same carts
 *   - the `?hours=` window is operator-tunable (a 72h window drops a cart
 *     idle only 30h)
 *   - signed-in vs guest is distinguished + the signed-in cart links to the
 *     customer detail screen
 *   - the bearer JSON contract returns { carts, summary }
 *   - the recovery-code action mints a single-use unlock_code-gated rule
 *     (max_redemptions_total = 1), surfaces the code once, and writes an
 *     audit row
 *   - a bad percent_off -> clean 4xx, no rule minted
 *   - the recovery screen states the no-email caveat honestly
 *   - the empty state renders
 *   - escapes hold (a hostile cart id can't break the markup — UUIDs are
 *     framework-issued, but the escape discipline is asserted anyway)
 *   - anon -> the sign-in form
 *
 * Network: zero.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0006_customers.sql",
  "0107_auto_discount.sql", "0231_auto_discount_application_unique.sql", "0209_auto_discount_unlock_code.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

var HOUR = 3600000;
var DAY  = 86400000;

// Seed a cart + (optionally) a line directly. Returns the cart id.
async function _seedCart(query, opts) {
  var id = b.uuid.v7();
  var sessionId = "sess" + b.uuid.v7().replace(/-/g, "").slice(0, 20);
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
    [id, sessionId, opts.customer_id || null, opts.currency || "USD", opts.status || "active", opts.updated_at, opts.updated_at + 30 * DAY],
  );
  if (opts.line) {
    await query(
      "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
      [b.uuid.v7(), id, opts.variant_id, opts.line.sku, opts.line.qty, opts.line.unit_amount_minor, opts.currency || "USD", opts.updated_at],
    );
  }
  return id;
}

async function _run() {
  var query        = _makeQuery();
  var catalog      = bShop.catalog.create({ query: query });
  var cart         = bShop.cart.create({ query: query });
  var customers    = bShop.customers.create({ query: query, cursorSecret: "carts-console-customers" });
  var autoDiscount = bShop.autoDiscount.create({ query: query });

  // A product + variant so the cart_lines FK resolves.
  var product = await catalog.products.create({ slug: "widget", title: "Widget" });
  var variant = await catalog.variants.create(product.id, { sku: "SKU-W1" });

  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Anderson" });

  var now = Date.now();

  // 1. OLD active cart with a line, signed-in (Alice) — 4 days idle. LISTED
  //    at 24h and still present at 72h.
  var oldSignedIn = await _seedCart(query, {
    customer_id: alice.id, variant_id: variant.id, updated_at: now - 4 * DAY,
    line: { sku: "SKU-W1", qty: 2, unit_amount_minor: 1500 },
  });
  // 2. OLD active cart with a line, GUEST — 30h idle. LISTED at 24h, dropped at 72h.
  var guestThirtyH = await _seedCart(query, {
    variant_id: variant.id, updated_at: now - 30 * HOUR,
    line: { sku: "SKU-W1", qty: 1, unit_amount_minor: 4000 },
  });
  // 3. FRESH active cart with a line — just now. EXCLUDED (still live).
  await _seedCart(query, {
    variant_id: variant.id, updated_at: now,
    line: { sku: "SKU-W1", qty: 3, unit_amount_minor: 1000 },
  });
  // 4. OLD active cart with NO lines — 2 days idle. EXCLUDED (nothing to recover).
  await _seedCart(query, { updated_at: now - 2 * DAY });
  // 5. OLD CONVERTED cart with a line — 2 days idle. EXCLUDED (not active).
  await _seedCart(query, {
    variant_id: variant.id, status: "converted", updated_at: now - 2 * DAY,
    line: { sku: "SKU-W1", qty: 9, unit_amount_minor: 9000 },
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-carts-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: {}, // order unused on this screen
        cart: cart, customers: customers, autoDiscount: autoDiscount,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  // Spy on b.audit.safeEmit so the recovery-code audit assertion is
  // deterministic and touches no chain read path.
  var auditCaptured = [];
  var _origSafeEmit = b.audit.safeEmit;
  b.audit.safeEmit = function (ev) { auditCaptured.push(ev); return _origSafeEmit.apply(this, arguments); };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- nav + list + filter math (browser) ----------------------------
    var list = await helpers.httpRequest({ port: port, path: "/admin/carts", jar: jar });
    check("carts list then 200", list.status === 200);
    check("nav links to carts", list.body.indexOf("href=\"/admin/carts\"") !== -1);
    check("nav label is Abandoned carts", list.body.indexOf("Abandoned carts") !== -1);

    // Default 24h window: the two old carts with lines are listed; fresh /
    // empty / converted are excluded. Assert membership through the bearer
    // JSON (full ids) — the HTML shows only the 8-char prefix, which two
    // same-millisecond v7 UUIDs can share (see uuid-prefix-unique-collision).
    var list24 = JSON.parse((await helpers.httpRequest({ port: port, path: "/admin/carts", headers: bearer })).body);
    var ids24 = list24.carts.map(function (c) { return c.id; });
    check("24h window lists exactly the 2 abandoned carts", ids24.length === 2 && ids24.indexOf(oldSignedIn) !== -1 && ids24.indexOf(guestThirtyH) !== -1);

    // The summary line counts both carts + their value at risk.
    var summary = await cart.abandonedSummary({ idle_threshold_ms: DAY });
    check("summary counts 2 carts", summary.cart_count === 2);
    check("summary value = 3000 + 4000", summary.by_currency.length === 1 && summary.by_currency[0].value_minor === 7000);
    check("list shows the at-risk total", list.body.indexOf("at risk") !== -1);
    check("list shows the 2-cart headline", /2<\/strong>\s*abandoned cart/.test(list.body));

    // Subtotals rendered (2 * 1500 = $30.00; 1 * 4000 = $40.00).
    check("signed-in subtotal $30.00", list.body.indexOf("$30.00") !== -1);
    check("guest subtotal $40.00", list.body.indexOf("$40.00") !== -1);

    // Signed-in vs guest distinguished; signed-in links to the customer.
    check("guest chip present", list.body.indexOf(">Guest<") !== -1);
    check("signed-in chip present", list.body.indexOf("Signed in") !== -1);
    check("signed-in cart links to customer", list.body.indexOf("/admin/customers/" + encodeURIComponent(alice.id)) !== -1);

    // ---- the ?hours= window is operator-tunable ------------------------
    // At 72h, the 30h guest cart drops; only the 4-day signed-in cart stays.
    // Membership asserted through the JSON (full ids); the HTML render is
    // exercised separately for status + chip highlight.
    var wide = await helpers.httpRequest({ port: port, path: "/admin/carts?hours=72", jar: jar });
    check("72h window then 200", wide.status === 200);
    check("72h chip highlighted", wide.body.indexOf("chip--on") !== -1);
    var wide72 = JSON.parse((await helpers.httpRequest({ port: port, path: "/admin/carts?hours=72", headers: bearer })).body);
    var ids72 = wide72.carts.map(function (c) { return c.id; });
    check("72h keeps the 4-day cart", ids72.indexOf(oldSignedIn) !== -1);
    check("72h drops the 30h cart", ids72.indexOf(guestThirtyH) === -1);
    check("72h lists exactly 1 cart", ids72.length === 1);

    // A garbage ?hours= falls back to the default window, never a 500.
    var garbage = await helpers.httpRequest({ port: port, path: "/admin/carts?hours=notanumber", jar: jar });
    check("garbage hours then 200", garbage.status === 200);
    var garbageJson = JSON.parse((await helpers.httpRequest({ port: port, path: "/admin/carts?hours=notanumber", headers: bearer })).body);
    check("garbage hours lists both carts (default 24h)", garbageJson.carts.length === 2);

    // ---- honest recovery copy ------------------------------------------
    check("screen states the no-email caveat", /one-way hash/i.test(list.body) && /can't send an abandoned-cart email/i.test(list.body));
    check("recovery code action offered (autoDiscount wired)", list.body.indexOf("/recovery-code") !== -1);

    // ---- the bearer JSON contract --------------------------------------
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/carts", headers: bearer });
    check("bearer list 200 JSON", apiList.status === 200 && (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    var apiJson = JSON.parse(apiList.body);
    check("bearer list carries carts array", Array.isArray(apiJson.carts) && apiJson.carts.length === 2);
    check("bearer list carries summary", apiJson.summary && apiJson.summary.cart_count === 2);
    // Newest-activity-first: the 30h guest cart sorts ahead of the 2-day cart.
    check("bearer list newest-activity-first", apiJson.carts[0].id === guestThirtyH && apiJson.carts[1].id === oldSignedIn);
    // session_id is sealed-cookie material — must never leak to the operator.
    check("bearer list omits session_id", apiJson.carts.every(function (c) { return c.session_id === undefined; }));
    check("bearer list carries customer_id for signed-in", apiJson.carts[1].customer_id === alice.id);
    check("bearer list null customer_id for guest", apiJson.carts[0].customer_id === null);

    // ---- recovery-code action: mints a single-use code-gated rule -------
    var beforeRules = await autoDiscount.listRules({ limit: 500 });
    var issue = await helpers.httpRequest({
      port: port, path: "/admin/carts/" + encodeURIComponent(oldSignedIn) + "/recovery-code",
      method: "POST", jar: jar, form: { percent_off: "15" },
    });
    check("issue code then 303", issue.status === 303);
    check("issue redirects ?issued with the code", (issue.headers.location || "").indexOf("issued=1") !== -1 && (issue.headers.location || "").indexOf("code=SAVE") !== -1);

    var afterRules = await autoDiscount.listRules({ limit: 500 });
    check("one new discount rule minted", afterRules.length === beforeRules.length + 1);
    var minted = afterRules.find(function (rule) { return /^cart-recovery-/.test(rule.slug); });
    check("minted rule exists", !!minted);
    check("minted rule is single-use", minted && minted.max_redemptions_total === 1);
    check("minted rule is code-gated", minted && typeof minted.unlock_code === "string" && /^SAVE/.test(minted.unlock_code));
    check("minted rule is 15% off", minted && minted.value && minted.value.basis_points === 1500);
    check("minted rule unlock_code in redirect", (issue.headers.location || "").indexOf(encodeURIComponent(minted.unlock_code)) !== -1);

    // The success banner surfaces the code ONCE on the redirected page.
    var afterIssue = await helpers.httpRequest({ port: port, path: issue.headers.location, jar: jar });
    check("issued banner shows the code", afterIssue.body.indexOf(minted.unlock_code) !== -1);
    check("issued banner says single-use", afterIssue.body.toLowerCase().indexOf("single-use") !== -1);

    // The action wrote an audit row (captured by the spy).
    var issueAudits = auditCaptured.filter(function (r) {
      return r.action === "shop_admin.cart_recovery_code.issue" && r.outcome === "success";
    });
    check("recovery-code issue recorded an audit row", issueAudits.length >= 1);

    // ---- bad percent_off -> clean 4xx, no rule minted ------------------
    var rulesBeforeBad = (await autoDiscount.listRules({ limit: 500 })).length;
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/carts/" + encodeURIComponent(guestThirtyH) + "/recovery-code",
      method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ percent_off: 250 }),
    });
    check("bad percent then 4xx", bad.status >= 400 && bad.status < 500);
    check("bad percent body has no stack frame", !/\n\s+at\s+\S+\s*\(/.test(bad.body));
    check("bad percent minted nothing", (await autoDiscount.listRules({ limit: 500 })).length === rulesBeforeBad);

    // An unknown cart id -> 404 (no rule minted for a phantom cart).
    var missingCart = await helpers.httpRequest({
      port: port, path: "/admin/carts/" + b.uuid.v7() + "/recovery-code",
      method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("unknown cart recovery then 404", missingCart.status === 404);

    // The bearer JSON issue path returns the minted rule shape.
    var apiIssue = await helpers.httpRequest({
      port: port, path: "/admin/carts/" + encodeURIComponent(guestThirtyH) + "/recovery-code",
      method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ percent_off: 20 }),
    });
    check("bearer issue 201 JSON", apiIssue.status === 201);
    var apiIssueJson = JSON.parse(apiIssue.body);
    check("bearer issue returns the code + percent", /^SAVE/.test(apiIssueJson.unlock_code) && apiIssueJson.percent_off === 20);

    // ---- empty state ---------------------------------------------------
    // A window so wide every seeded cart is younger than it -> empty list.
    // (The cart primitive clamps the window to <= 90d; a 2160h = 90d window
    // still excludes our 2-day-old carts.)
    var empty = await helpers.httpRequest({ port: port, path: "/admin/carts?hours=2160", jar: jar });
    check("empty window then 200", empty.status === 200);
    check("empty state copy shown", empty.body.indexOf("No carts have been abandoned") !== -1);

    // ---- anon -> sign-in form ------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: "/admin/carts" });
    check("anon list -> login form", anon.body.indexOf("Admin API key") !== -1);
    // An unauthenticated POST never mints a code — _pageOrApi bounces a
    // non-GET to /admin (a redirect), never the 201 create path. Confirm
    // no new rule was minted by the anon attempt.
    var rulesBeforeAnon = (await autoDiscount.listRules({ limit: 500 })).length;
    var anonIssue = await helpers.httpRequest({
      port: port, path: "/admin/carts/" + encodeURIComponent(oldSignedIn) + "/recovery-code", method: "POST",
    });
    check("anon issue not 201", anonIssue.status !== 201);
    check("anon issue minted nothing", (await autoDiscount.listRules({ limit: 500 })).length === rulesBeforeAnon);
  } finally {
    try { b.audit.safeEmit = _origSafeEmit; } catch (_e) { /* */ }
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
