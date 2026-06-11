"use strict";
/**
 * Customers console — read-only browser-side customer roster.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * customers), seeds three customers (a passkey holder, a Google-linked
 * account, and one with no credential yet) plus a couple of orders, and
 * exercises the list (HTML + JSON), the per-customer order count + sign-in
 * method (resolved by bounded aggregate queries, no N+1), the bearer JSON
 * contract, and the auth gate. Read-only — no mutation routes exist.
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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql", "0004_shop_config.sql", "0006_customers.sql", "0205_customer_oauth_identities.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

// A minimal valid order for a customer — createFromCart needs a cart_id +
// session_id (UUID-shaped), one line, totals, and a ship_to with a country.
// The orders FK references carts(id), so seed the cart row first.
async function _seedOrder(query, order, customerId) {
  var cartId = b.uuid.v7();
  var sessionId = b.uuid.v7();
  var now = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionId, customerId, now, now + 86400000],
  );
  return order.createFromCart({
    cart_id:           cartId,
    session_id:        sessionId,
    customer_id:       customerId,
    lines:             [{ variant_id: b.uuid.v7(), sku: "SKU-1", qty: 1, unit_amount_minor: 1000 }],
    currency:          "USD",
    subtotal_minor:    1000,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 1000,
    ship_to:           { country: "US" },
  });
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var order    = bShop.order.create({ query: query, cursorSecret: "customers-console-order" });
  var config   = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query, cursorSecret: "customers-console" });

  // Seed three customers, then pin distinct created_at values so the
  // newest-first ordering is deterministic (register() stamps Date.now(),
  // which ties across same-ms inserts and leaves the order to the random
  // sub-ms UUID bits). Carol is newest, Alice oldest.
  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Anderson" });
  var bob   = await customers.register({ email: "bob@example.com",   display_name: "Bob Brown" });
  var carol = await customers.register({ email: "carol@example.com", display_name: "Carol Clark" });
  await query("UPDATE customers SET created_at = ?1 WHERE id = ?2", [1000, alice.id]);
  await query("UPDATE customers SET created_at = ?1 WHERE id = ?2", [2000, bob.id]);
  await query("UPDATE customers SET created_at = ?1 WHERE id = ?2", [3000, carol.id]);

  // Alice enrols a passkey; Bob links a Google identity; Carol has neither.
  await customers.addPasskey(alice.id, {
    credential_id: "cred-alice-1", public_key: "pk-alice", counter: 0, transports: "internal",
  });
  await query(
    "INSERT INTO customer_oauth_identities (id, customer_id, provider, subject, email, email_verified, created_at, updated_at) " +
    "VALUES (?1, ?2, 'google', 'sub-bob', ?3, 1, ?4, ?4)",
    [b.uuid.v7(), bob.id, "bob@example.com", Date.now()],
  );

  // Alice has two orders, Bob one, Carol none — the count column must reflect this.
  await _seedOrder(query, order, alice.id);
  await _seedOrder(query, order, alice.id);
  await _seedOrder(query, order, bob.id);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-customers-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, customers: customers, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // List: HTML for the browser, JSON for the bearer token.
    var html = await helpers.httpRequest({ port: port, path: "/admin/customers", jar: jar });
    check("customers page then 200",             html.status === 200);
    check("roster shows all seeded customers",   html.body.indexOf("Alice Anderson") !== -1 && html.body.indexOf("Bob Brown") !== -1 && html.body.indexOf("Carol Clark") !== -1);
    check("nav includes Customers",              html.body.indexOf("\"/admin/customers\"") !== -1);

    // Sign-in method column: Alice shows a passkey chip, Bob a google chip.
    check("passkey holder shows passkey chip",   html.body.indexOf("1 passkey") !== -1);
    check("oauth account shows provider chip",   html.body.indexOf(">google<") !== -1);

    // Order count column is correct (Alice 2, Bob 1, Carol 0). Assert the
    // exact count cells render — the aggregate resolved them without N+1.
    var counts = await order.countsByCustomer([alice.id, bob.id, carol.id]);
    check("order count: alice = 2",              counts[alice.id] === 2);
    check("order count: bob = 1",                counts[bob.id] === 1);
    check("order count: carol absent (zero)",    counts[carol.id] === undefined);
    check("zero-order customer renders 0",       html.body.indexOf(">0<") !== -1);

    // Bearer JSON contract: rows + next_cursor, no HTML.
    var api = await helpers.httpRequest({ port: port, path: "/admin/customers", headers: bearer });
    check("customers API still JSON",            (api.headers["content-type"] || "").indexOf("application/json") === 0);
    var parsed = JSON.parse(api.body);
    check("customers API returns 3 rows",        parsed.rows.length === 3);
    check("customers API rows omit raw email",   parsed.rows.every(function (c) { return c.email == null && typeof c.email_hash === "string"; }));
    check("newest-first ordering (carol first)", parsed.rows[0].id === carol.id);

    // Bounded limit produces a next_cursor that round-trips to the next page.
    var p1 = await customers.list({ limit: 2 });
    check("limited page returns 2 rows",         p1.rows.length === 2);
    check("limited page yields a next_cursor",   typeof p1.next_cursor === "string" && p1.next_cursor.length > 0);
    var p2 = await customers.list({ limit: 2, cursor: p1.next_cursor });
    check("cursor page returns the remainder",   p2.rows.length === 1 && p2.rows[0].id === alice.id);
    check("cursor page exhausts (no next)",      p2.next_cursor === null);

    // The browser roster honors ?cursor too (not just the bearer API) — an
    // operator can page past the first screen. Passing the next_cursor from
    // page 1 returns the remainder (Alice) and excludes the first page.
    var pageCursor = await helpers.httpRequest({ port: port, path: "/admin/customers?cursor=" + encodeURIComponent(p1.next_cursor), jar: jar });
    check("browser roster honors ?cursor",       pageCursor.status === 200 && pageCursor.body.indexOf("Alice Anderson") !== -1);
    check("browser cursor page excludes page 1", pageCursor.body.indexOf("Carol Clark") === -1 && pageCursor.body.indexOf("Bob Brown") === -1);

    // A tampered cursor is refused as a TypeError (bad request), never a 500.
    var tamperThrew = false;
    try { await customers.list({ cursor: "not-a-valid-cursor" }); } catch (e) { tamperThrew = e instanceof TypeError; }
    check("bad cursor refused as TypeError",     tamperThrew);

    // Read-only: no write routes mounted. A POST / DELETE is a 404 (no such
    // route), not a redirect / success from a real handler.
    var post = await helpers.httpRequest({ port: port, path: "/admin/customers", method: "POST", headers: bearer });
    check("customers console is read-only (POST 404)", post.status === 404);
    var del = await helpers.httpRequest({ port: port, path: "/admin/customers", method: "DELETE", headers: bearer });
    check("customers console is read-only (DELETE 404)", del.status === 404);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/customers" });
    check("anon customers → login form",         anon.body.indexOf("Admin API key") !== -1);
    check("anon does not leak a customer name",  anon.body.indexOf("Alice Anderson") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
