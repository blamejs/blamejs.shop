"use strict";
/**
 * Order notes console — the customer-service notes panel on the admin
 * order-detail screen (/admin/orders/:id). Boots one b.createApp with
 * admin.mount (token + catalog + order + config + orderNotes) over an
 * in-memory node:sqlite DB loaded from the live migrations.
 *
 * Exercises the order-notes surface from the console:
 *   - GET /admin/orders/:id renders the notes panel (add form + list) only
 *     when the orderNotes primitive is wired; the auth gate refuses anon
 *   - ADD: a note attaches to the path order, defaults author "operator" +
 *     visibility "internal"; an operator can opt a note customer-visible. A
 *     blank body is a clean 4xx with nothing written
 *   - XSS: a note body carrying an HTML/script payload is ESCAPED at render
 *     (no live <script>; the angle brackets are entity-encoded)
 *   - LIFECYCLE: pin (floats first + Unpin offered) / unpin; resolve an
 *     internal note with a summary (Resolved pill + reopen offered) / reopen;
 *     resolving a customer-visible note is refused (clean 4xx, no change)
 *   - AUDIT: each mutation routes through the audited write wrapper
 *     (W("order.note.*") on the JSON path, b.audit.safeEmit on the HTML path)
 *     — the framework emit is drop-silent so it's verified structurally by the
 *     write succeeding through that path, matching the rest of the console suite
 *   - IDOR: a note on a DIFFERENT order can't be pinned / resolved through
 *     this order's id (a clean 404 with no mutation)
 *   - an unknown / malformed order or note id -> a clean 4xx, never a 500
 *
 * Network: zero — every request lands on 127.0.0.1.
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

var TOKEN = "admin-token-0123456789abcdef-ordernotes";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql", "0037_order_notes.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  var q = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  q._db = db;
  return q;
}

function _post(port, path, jar, form, extraHeaders) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST", jar: jar, form: form,
    headers: extraHeaders || undefined,
  });
}

// A minimal valid order — createFromCart needs a cart_id + session_id
// (UUID-shaped), one line, totals, and a ship_to with a country. The orders
// FK references carts(id), so seed the cart row first.
async function _seedOrder(query, order) {
  var cartId = b.uuid.v7();
  var sessionId = b.uuid.v7();
  var now = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, sessionId, now, now + 86400000],
  );
  return order.createFromCart({
    cart_id:           cartId,
    session_id:        sessionId,
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
  var query      = _makeQuery();
  var catalog    = bShop.catalog.create({ query: query });
  var order      = bShop.order.create({ query: query, cursorSecret: "order-notes-order" });
  var config     = bShop.config.create({ query: query });
  var orderNotes = bShop.orderNotes.create({ query: query, cursorSecret: "order-notes-cursor" });

  var ord  = await _seedOrder(query, order);
  // A SECOND order with its own note — proves the per-note lifecycle routes
  // are scoped to the path :id order (order B's note can't be mutated through
  // order A's id — the cross-order IDOR guard).
  var ordB = await _seedOrder(query, order);
  var noteB = await orderNotes.add({
    order_id: ordB.id, author: "operator", visibility: "internal",
    body: "Order B's private note — do not touch",
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-order-notes-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        orderNotes: orderNotes,
      });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var base = "/admin/orders/" + encodeURIComponent(ord.id);

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- detail: the notes panel renders ------------------------------
    var detail = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("order detail then 200",               detail.status === 200);
    check("detail shows the notes panel",        detail.body.indexOf("Customer-service notes") !== -1);
    check("detail shows the add-note form",      detail.body.indexOf(base + "/notes\"") !== -1);
    check("empty panel says no notes yet",       detail.body.indexOf("No notes on this order yet") !== -1);

    // ---- add a note ----------------------------------------------------
    var add = await _post(port, base + "/notes", jar, {
      body: "Buyer asked to delay shipment until Monday", author: "operator", visibility: "internal",
    });
    check("add note then 303",                   add.status === 303);
    check("add redirects note=1",                (add.headers.location || "").indexOf("note=1") !== -1);
    var listed = await orderNotes.listForOrder({ order_id: ord.id, limit: 10 });
    check("note persisted",                      listed.rows.length === 1 && listed.rows[0].body === "Buyer asked to delay shipment until Monday");
    check("note author is operator",             listed.rows[0].author === "operator");
    check("note visibility is internal",         listed.rows[0].visibility === "internal");
    var detailAfterAdd = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail lists the new note",           detailAfterAdd.body.indexOf("Buyer asked to delay shipment until Monday") !== -1);
    check("detail shows the Internal pill",      detailAfterAdd.body.indexOf("Internal") !== -1);

    // A customer-visible note via the form's visibility select.
    var addVisible = await _post(port, base + "/notes", jar, {
      body: "Your order ships Monday — thanks for your patience", author: "operator", visibility: "customer_visible",
    });
    check("add customer-visible note 303",       addVisible.status === 303);
    var visList = await orderNotes.listForOrder({ order_id: ord.id, visibility_filter: "customer_visible", limit: 10 });
    check("customer-visible note recorded",      visList.rows.length === 1);

    // A blank body is a clean 4xx with nothing written (still 2 notes).
    var blank = await _post(port, base + "/notes", jar, { body: "   " });
    check("blank note redirect err",             blank.status === 303 && (blank.headers.location || "").indexOf("note_err=") !== -1);
    check("blank note leaks no internal prefix", (blank.headers.location || "").indexOf("orderNotes") === -1 && (blank.headers.location || "").indexOf("admin.") === -1);
    check("blank note: still two notes",         (await orderNotes.listForOrder({ order_id: ord.id, limit: 10 })).rows.length === 2);
    // Bearer JSON: a blank body is a clean 400.
    var blankApi = await helpers.httpRequest({
      port: port, path: base + "/notes", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ body: "" }),
    });
    check("bearer blank add then 400",           blankApi.status === 400);

    // ---- XSS: a script-payload body is escaped at render ---------------
    var XSS = "<script>alert('order-note-xss')</script><img src=x onerror=alert(1)>";
    var xssAdd = await _post(port, base + "/notes", jar, { body: XSS, author: "operator", visibility: "internal" });
    check("xss note add then 303",               xssAdd.status === 303);
    var detailXss = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("xss: no live <script> in the body",   detailXss.body.indexOf("<script>alert('order-note-xss')") === -1);
    check("xss: no live onerror handler",        detailXss.body.indexOf("<img src=x onerror=") === -1);
    check("xss: payload is entity-escaped",       detailXss.body.indexOf("&lt;script&gt;alert(") !== -1 && detailXss.body.indexOf("&lt;/script&gt;") !== -1);

    // ---- pin / unpin ---------------------------------------------------
    // Operate the lifecycle on the FIRST note added (the delay-shipment one).
    var targetNote = listed.rows[0];
    var noteBase = base + "/notes/" + encodeURIComponent(targetNote.id);
    var pin = await _post(port, noteBase + "/pin", jar, {});
    check("pin note then 303",                   pin.status === 303);
    check("pin flagged the note pinned",         Number((await orderNotes.get(targetNote.id)).pinned) === 1);
    var pinnedList = await orderNotes.listForOrder({ order_id: ord.id, limit: 10 });
    check("pinned note sorts first",             pinnedList.rows[0].id === targetNote.id);
    var detailPinned = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail shows the Pinned pill",        detailPinned.body.indexOf("Pinned") !== -1);
    check("detail offers Unpin once pinned",     detailPinned.body.indexOf(encodeURIComponent(targetNote.id) + "/unpin") !== -1);
    var unpin = await _post(port, noteBase + "/unpin", jar, {});
    check("unpin note then 303",                 unpin.status === 303);
    check("unpin cleared the flag",              Number((await orderNotes.get(targetNote.id)).pinned) === 0);

    // ---- resolve / reopen (internal threads only) ----------------------
    var resolve = await _post(port, noteBase + "/resolve", jar, { resolution: "Shipped Monday as promised" });
    check("resolve note then 303",               resolve.status === 303);
    var resolved = await orderNotes.get(targetNote.id);
    check("resolve stamped resolved_at",         resolved.resolved_at != null);
    check("resolve stored the summary",          resolved.resolution === "Shipped Monday as promised");
    var detailResolved = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail shows the Resolved pill",      detailResolved.body.indexOf("Resolved") !== -1);
    check("detail shows the resolution text",    detailResolved.body.indexOf("Shipped Monday as promised") !== -1);
    check("detail offers Reopen once resolved",  detailResolved.body.indexOf(encodeURIComponent(targetNote.id) + "/reopen") !== -1);
    var reopen = await _post(port, noteBase + "/reopen", jar, {});
    check("reopen note then 303",                reopen.status === 303);
    check("reopen cleared resolved_at",          (await orderNotes.get(targetNote.id)).resolved_at == null);

    // A blank resolution summary is a clean 4xx with nothing written.
    var blankResolve = await _post(port, noteBase + "/resolve", jar, { resolution: "" });
    check("blank resolution redirect err",       blankResolve.status === 303 && (blankResolve.headers.location || "").indexOf("note_err=") !== -1);
    check("blank resolution: still unresolved",  (await orderNotes.get(targetNote.id)).resolved_at == null);

    // Resolving a CUSTOMER-VISIBLE note is refused by the primitive (only
    // internal threads carry a resolution) — a clean 4xx, no change.
    var visNoteId = visList.rows[0].id;
    var visResolve = await helpers.httpRequest({
      port: port, path: base + "/notes/" + encodeURIComponent(visNoteId) + "/resolve", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ resolution: "should be refused" }),
    });
    check("resolve customer-visible then 400",   visResolve.status === 400);
    check("customer-visible note unresolved",    (await orderNotes.get(visNoteId)).resolved_at == null);

    // ---- bearer JSON contract on a lifecycle write ---------------------
    var pinApi = await helpers.httpRequest({
      port: port, path: noteBase + "/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("bearer pin then 200 JSON",            pinApi.status === 200 && (pinApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var pinJson = JSON.parse(pinApi.body);
    check("bearer pin returns the note",         pinJson.id === targetNote.id && Number(pinJson.pinned) === 1);
    await _post(port, noteBase + "/unpin", jar, {});

    // ---- IDOR: order B's note can't be mutated through order A's id ----
    var bViaA = base + "/notes/" + encodeURIComponent(noteB.id);
    var idorPin = await helpers.httpRequest({
      port: port, path: bViaA + "/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("IDOR pin (bearer) then 404",          idorPin.status === 404);
    var idorResolve = await helpers.httpRequest({
      port: port, path: bViaA + "/resolve", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ resolution: "hijack" }),
    });
    check("IDOR resolve (bearer) then 404",      idorResolve.status === 404);
    var idorPinHtml = await _post(port, bViaA + "/pin", jar, {});
    check("IDOR pin (HTML) redirect err",        idorPinHtml.status === 303 && (idorPinHtml.headers.location || "").indexOf("note_err=") !== -1);
    var bAfter = await orderNotes.get(noteB.id);
    check("order B's note untouched (pin)",      Number(bAfter.pinned) === 0);
    check("order B's note untouched (resolve)",  bAfter.resolved_at == null);
    check("order B's note body intact",          bAfter.body === "Order B's private note — do not touch");

    // ---- unknown / malformed ids -> clean 4xx (never 500) --------------
    var unknownNote = await helpers.httpRequest({
      port: port, path: base + "/notes/" + b.uuid.v7() + "/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("unknown note id then 404",            unknownNote.status === 404);
    var malformedNote = await helpers.httpRequest({
      port: port, path: base + "/notes/not-a-uuid/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("malformed note id then 400 (not 500)", malformedNote.status === 400);
    var unknownOrder = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + b.uuid.v7() + "/notes", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ body: "x" }),
    });
    check("unknown order id add then 404",       unknownOrder.status === 404);
    var malformedOrder = await _post(port, "/admin/orders/not-a-uuid/notes", jar, { body: "x" });
    check("malformed order id add then 404 (not 500)", malformedOrder.status === 404);

    // ---- auth gate -----------------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: base });
    check("anon order detail → login form",      anon.body.indexOf("Admin API key") !== -1);
    check("anon detail does not leak the note",  anon.body.indexOf("Buyer asked to delay shipment") === -1);
    var anonAdd = await helpers.httpRequest({
      port: port, path: base + "/notes", method: "POST", form: { body: "anon note" },
    });
    check("anon add does not 5xx",               anonAdd.status < 500);
    check("anon add did not write",              (await orderNotes.listForOrder({ order_id: ord.id, limit: 20 })).rows.every(function (n) { return n.body !== "anon note"; }));
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
