"use strict";
/**
 * orderNotes — threaded customer-service notes attached to an order.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog) + 0002 (cart) + 0003 (order) + 0037 (order notes).
 *
 * The primitive isn't wired through `bShop` yet — the test
 * requires `lib/order-notes.js` directly so the gate exists ahead
 * of the entry-point edit.
 *
 * Coverage:
 *   - add happy: persists row + hydrates tags, parent_note_id
 *                round-trip + cross-order parent refused
 *   - add visibility / author refusal classes + control-byte +
 *                zero-width + empty-after-trim body refusal
 *   - listForOrder visibility filter + cursor pagination
 *   - thread builds a 3-level tree shape
 *   - markRead idempotency (same actor twice -> one row)
 *   - pin/unpin reorders the list (pinned floats to the top)
 *   - resolve writes resolution + reopen clears it
 *   - customerVisibleForOrder excludes internal notes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop      = require("../../lib");
var orderNotes = require("../../lib/order-notes");
var helpers    = require("../helpers");
var check      = helpers.check;
var assert     = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql",
  "0037_order_notes.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

// Seed a minimal cart + order row so the FK from order_notes ->
// orders has a target. The reviews primitive seeds catalog directly;
// the order primitive's seeding helper is heavier than this test
// needs — we just want one row to attach notes to.
async function _seedOrder(query, opts) {
  opts = opts || {};
  var ts = Date.now();
  // carts row to satisfy orders.cart_id FK.
  var cartId = _validUUID();
  await query(
    "INSERT INTO carts (id, session_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, 'USD', 'active', ?3, ?3, ?4)",
    [cartId, _validUUID(), ts, ts + 86400000],
  );
  var orderId = opts.id || _validUUID();
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'pending', 'USD', 0, 0, 0, 0, 0, '{\"country\":\"US\"}', ?5, ?5)",
    [orderId, cartId, opts.customer_id || null, _validUUID(), ts],
  );
  return orderId;
}

async function _setup() {
  var query  = _makeQuery();
  var orderId = await _seedOrder(query);
  var notes  = orderNotes.create({
    query:        query,
    cursorSecret: "order-notes-test-secret",
  });
  return { query: query, orderId: orderId, notes: notes };
}

async function _addHappyAndParent() {
  var ctx = await _setup();

  // Fresh thread starter.
  var parent = await ctx.notes.add({
    order_id:   ctx.orderId,
    author:     "operator",
    visibility: "internal",
    body:       "Customer called about a missing item.",
    tags:       ["fulfillment", "follow-up"],
    author_id:  _validUUID(),
  });
  check("add returns 36-char uuid",          typeof parent.id === "string" && parent.id.length === 36);
  check("add persists author",                parent.author === "operator");
  check("add persists visibility",            parent.visibility === "internal");
  check("add persists body",                  parent.body === "Customer called about a missing item.");
  check("add persists tags as array",         Array.isArray(parent.tags) && parent.tags.length === 2);
  check("add stamps parent_note_id NULL",     parent.parent_note_id == null);
  check("add stamps pinned=0",                parent.pinned === 0);
  check("add stamps created_at == updated_at", parent.created_at === parent.updated_at);

  // Reply to the prior note.
  var reply = await ctx.notes.add({
    order_id:       ctx.orderId,
    parent_note_id: parent.id,
    author:         "customer",
    visibility:     "customer_visible",
    body:           "Thanks — when can I expect the replacement?",
  });
  check("reply stamps parent_note_id",        reply.parent_note_id === parent.id);
  check("reply visibility differs from parent", reply.visibility === "customer_visible");
  check("reply tags default to empty array",   Array.isArray(reply.tags) && reply.tags.length === 0);

  // Parent on a different order is refused.
  var otherOrder = await _seedOrder(ctx.query);
  await assert.rejects(ctx.notes.add({
    order_id:       otherOrder,
    parent_note_id: parent.id,
    author:         "operator",
    visibility:     "internal",
    body:           "different order",
  }), /different order/);

  // Missing parent is refused.
  await assert.rejects(ctx.notes.add({
    order_id:       ctx.orderId,
    parent_note_id: _validUUID(),
    author:         "operator",
    visibility:     "internal",
    body:           "no parent",
  }), /parent_note_id/);
}

async function _addRefusalClasses() {
  var ctx = await _setup();

  // input object required
  await assert.rejects(ctx.notes.add(),                                /input object required/);
  // bad order_id
  await assert.rejects(ctx.notes.add({
    order_id: "not-a-uuid", author: "operator", visibility: "internal", body: "ok",
  }), /order_id/);
  // bad author
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "robot", visibility: "internal", body: "ok",
  }), /author/);
  // bad visibility
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "secret", body: "ok",
  }), /visibility/);
  // empty body
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "   ",
  }), /body/);
  // body type
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: 12345,
  }), /body/);
  // oversize body
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "x".repeat(8001),
  }), /body/);
  // control byte
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "bad\x00body",
  }), /control bytes/);
  // zero-width char (U+200B built via String.fromCharCode so the
  // source file stays free of irregular-whitespace ESLint hits)
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal",
    body: "bad" + String.fromCharCode(0x200B) + "body",
  }), /zero-width/);
  // tags type
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "ok", tags: "not-an-array",
  }), /tags/);
  // too many tags
  var manyTags = [];
  for (var i = 0; i < 17; i += 1) manyTags.push("t" + i);
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "ok", tags: manyTags,
  }), /tags/);
  // oversize tag
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "ok",
    tags: ["x".repeat(33)],
  }), /tags/);
  // control-byte tag
  await assert.rejects(ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "ok",
    tags: ["bad\x01tag"],
  }), /tags/);
}

async function _listAndCursor() {
  var ctx = await _setup();
  // Three customer-visible + one internal note. Force created_at
  // separation so the (pinned, created_at, id) cursor keyset is
  // deterministic for the page-2 assertion below.
  var ids = [];
  for (var i = 0; i < 3; i += 1) {
    var n = await ctx.notes.add({
      order_id:   ctx.orderId,
      author:     "operator",
      visibility: "customer_visible",
      body:       "Note " + i,
    });
    ids.push(n.id);
    await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });   // minimum-distinct-ts seed
  }
  var internal = await ctx.notes.add({
    order_id:   ctx.orderId,
    author:     "operator",
    visibility: "internal",
    body:       "Hidden from customer",
  });

  // Default visibility filter — both tiers surface.
  var all = await ctx.notes.listForOrder({ order_id: ctx.orderId });
  check("listForOrder no-filter returns all 4 notes", all.rows.length === 4);

  // visibility_filter = customer_visible — only the three notes
  var cv = await ctx.notes.listForOrder({ order_id: ctx.orderId, visibility_filter: "customer_visible" });
  check("listForOrder customer-only returns 3",       cv.rows.length === 3);
  check("listForOrder customer-only excludes internal",
    cv.rows.every(function (r) { return r.id !== internal.id; }));

  // visibility_filter = internal — only the internal note
  var inOnly = await ctx.notes.listForOrder({ order_id: ctx.orderId, visibility_filter: "internal" });
  check("listForOrder internal-only returns 1",       inOnly.rows.length === 1);
  check("listForOrder internal-only returns the internal note",
    inOnly.rows[0].id === internal.id);

  // Cursor pagination — limit 2 over the customer-visible set, then resume.
  var page1 = await ctx.notes.listForOrder({
    order_id: ctx.orderId, visibility_filter: "customer_visible", limit: 2,
  });
  check("page1 returns 2 rows",                        page1.rows.length === 2);
  check("page1 cursor present",                        typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await ctx.notes.listForOrder({
    order_id: ctx.orderId, visibility_filter: "customer_visible", limit: 2, cursor: page1.next_cursor,
  });
  check("page2 returns the remaining row",             page2.rows.length === 1);
  check("page2 no further cursor",                     page2.next_cursor === null);
  check("page2 disjoint from page1",
    page1.rows.every(function (r) { return r.id !== page2.rows[0].id; }));

  // Tampered cursor refused.
  await assert.rejects(ctx.notes.listForOrder({
    order_id: ctx.orderId, visibility_filter: "customer_visible", cursor: page1.next_cursor + "x",
  }), /cursor/);

  // Bad visibility filter refused.
  await assert.rejects(ctx.notes.listForOrder({
    order_id: ctx.orderId, visibility_filter: "bogus",
  }), /visibility_filter/);

  // Bad limit refused.
  await assert.rejects(ctx.notes.listForOrder({
    order_id: ctx.orderId, limit: 0,
  }), /limit/);
}

async function _threadTree() {
  var ctx = await _setup();
  // Build a 3-level tree:
  //   root
  //   ├── childA
  //   │   └── grandchild
  //   └── childB
  var root = await ctx.notes.add({
    order_id: ctx.orderId, author: "customer", visibility: "customer_visible",
    body: "Where is my order?",
  });
  await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  var childA = await ctx.notes.add({
    order_id: ctx.orderId, parent_note_id: root.id,
    author: "operator", visibility: "customer_visible",
    body: "Shipped Tuesday — tracking attached.",
  });
  await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  var childB = await ctx.notes.add({
    order_id: ctx.orderId, parent_note_id: root.id,
    author: "system", visibility: "internal",
    body: "Auto-stamped: order entered fulfilling state.",
  });
  await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  var grandchild = await ctx.notes.add({
    order_id: ctx.orderId, parent_note_id: childA.id,
    author: "customer", visibility: "customer_visible",
    body: "Got it, thanks!",
  });

  var tree = await ctx.notes.thread({ order_id: ctx.orderId, root_note_id: root.id });
  check("thread root note id matches",                 tree.note.id === root.id);
  check("thread root has 2 replies",                   tree.replies.length === 2);
  // Replies are ordered by created_at ASC — childA before childB.
  check("thread reply[0] is childA",                   tree.replies[0].note.id === childA.id);
  check("thread reply[1] is childB",                   tree.replies[1].note.id === childB.id);
  check("thread childA has 1 reply",                   tree.replies[0].replies.length === 1);
  check("thread childA reply is grandchild",           tree.replies[0].replies[0].note.id === grandchild.id);
  check("thread grandchild has no replies",            tree.replies[0].replies[0].replies.length === 0);
  check("thread childB has no replies",                tree.replies[1].replies.length === 0);

  // Bad root id refused.
  await assert.rejects(ctx.notes.thread({ order_id: ctx.orderId, root_note_id: _validUUID() }), /not found/);

  // Cross-order root refused.
  var otherOrder = await _seedOrder(ctx.query);
  await assert.rejects(ctx.notes.thread({ order_id: otherOrder, root_note_id: root.id }), /different order/);
}

async function _markReadIdempotency() {
  var ctx = await _setup();
  var n = await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "look at this",
  });
  var operatorId = _validUUID();
  var first = await ctx.notes.markRead({
    note_id: n.id,
    by_actor: { role: "operator", id: operatorId },
  });
  check("markRead first call writes a row",            first.idempotent === false && typeof first.id === "string");

  var second = await ctx.notes.markRead({
    note_id: n.id,
    by_actor: { role: "operator", id: operatorId },
  });
  check("markRead second call is idempotent",          second.idempotent === true && second.id === first.id);

  // Distinct reader on the same note writes a new row.
  var otherOperator = _validUUID();
  var third = await ctx.notes.markRead({
    note_id: n.id,
    by_actor: { role: "operator", id: otherOperator },
  });
  check("markRead distinct reader writes new row",     third.idempotent === false && third.id !== first.id);

  // System reader (no id) — first call writes, second is idempotent.
  var sys1 = await ctx.notes.markRead({ note_id: n.id, by_actor: { role: "system" } });
  check("markRead system first call writes",           sys1.idempotent === false);
  var sys2 = await ctx.notes.markRead({ note_id: n.id, by_actor: { role: "system" } });
  check("markRead system second call idempotent",      sys2.idempotent === true && sys2.id === sys1.id);

  // Unknown note refused.
  await assert.rejects(ctx.notes.markRead({
    note_id: _validUUID(), by_actor: { role: "operator", id: operatorId },
  }), /not found/);
}

async function _pinReorders() {
  var ctx = await _setup();
  // Three notes, oldest first.
  var oldest = await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "oldest",
  });
  await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "middle",
  });
  await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  var newest = await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal", body: "newest",
  });

  var before = await ctx.notes.listForOrder({ order_id: ctx.orderId, visibility_filter: "internal" });
  check("before pin, newest is first",                 before.rows[0].id === newest.id);
  check("before pin, oldest is last",                  before.rows[2].id === oldest.id);

  // Pin the oldest — it should float to the top.
  var pinned = await ctx.notes.pin(oldest.id);
  check("pin returns pinned=1",                        pinned.pinned === 1);

  var after = await ctx.notes.listForOrder({ order_id: ctx.orderId, visibility_filter: "internal" });
  check("after pin, oldest floats to top",             after.rows[0].id === oldest.id);
  check("after pin, newest drops to second",           after.rows[1].id === newest.id);

  // Unpin — order reverts.
  var unpinned = await ctx.notes.unpin(oldest.id);
  check("unpin returns pinned=0",                      unpinned.pinned === 0);

  var reverted = await ctx.notes.listForOrder({ order_id: ctx.orderId, visibility_filter: "internal" });
  check("after unpin, newest back on top",             reverted.rows[0].id === newest.id);
  check("after unpin, oldest back at the bottom",      reverted.rows[2].id === oldest.id);

  // Pin/unpin on unknown id refused.
  await assert.rejects(ctx.notes.pin(_validUUID()),    /not found/);
  await assert.rejects(ctx.notes.unpin(_validUUID()),  /not found/);
}

async function _resolveAndReopen() {
  var ctx = await _setup();
  var internalNote = await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal",
    body: "Open thread: investigate fraud signal.",
  });

  // Resolve writes the resolution + stamps resolved_at.
  var resolved = await ctx.notes.resolve({
    note_id: internalNote.id,
    resolution: "Confirmed legitimate — buyer's billing zip matches shipping; closing.",
  });
  check("resolve sets resolution",                     typeof resolved.resolution === "string" && resolved.resolution.indexOf("Confirmed") === 0);
  check("resolve sets resolved_at",                    typeof resolved.resolved_at === "number" && resolved.resolved_at > 0);

  // internalForOrder({ resolved: true }) surfaces it.
  var resolvedList = await ctx.notes.internalForOrder(ctx.orderId, { resolved: true });
  check("internalForOrder({resolved:true}) lists it",  resolvedList.length === 1 && resolvedList[0].id === internalNote.id);
  // internalForOrder({ resolved: false }) does not.
  var openList = await ctx.notes.internalForOrder(ctx.orderId, { resolved: false });
  check("internalForOrder({resolved:false}) excludes it", openList.length === 0);
  // No filter — both.
  var both = await ctx.notes.internalForOrder(ctx.orderId);
  check("internalForOrder no-filter includes resolved", both.length === 1);

  // Reopen clears resolution + resolved_at.
  var reopened = await ctx.notes.reopen(internalNote.id);
  check("reopen clears resolution",                    reopened.resolution == null);
  check("reopen clears resolved_at",                   reopened.resolved_at == null);
  var afterReopenOpen = await ctx.notes.internalForOrder(ctx.orderId, { resolved: false });
  check("after reopen, surfaces in open queue",        afterReopenOpen.length === 1);

  // Refusal: resolution length cap + control bytes.
  await assert.rejects(ctx.notes.resolve({
    note_id: internalNote.id, resolution: "x".repeat(281),
  }), /resolution/);
  await assert.rejects(ctx.notes.resolve({
    note_id: internalNote.id, resolution: "bad\x00bytes",
  }), /resolution/);
  await assert.rejects(ctx.notes.resolve({
    note_id: internalNote.id, resolution: "",
  }), /resolution/);

  // Resolve on a customer_visible note refused.
  var cvNote = await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "customer_visible",
    body: "public message",
  });
  await assert.rejects(ctx.notes.resolve({
    note_id: cvNote.id, resolution: "trying to resolve a public note",
  }), /internal/);

  // Unknown ids refused.
  await assert.rejects(ctx.notes.resolve({
    note_id: _validUUID(), resolution: "x",
  }), /not found/);
  await assert.rejects(ctx.notes.reopen(_validUUID()), /not found/);
}

async function _customerVisibleExcludesInternal() {
  var ctx = await _setup();
  await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "customer_visible",
    body: "Your order is on the way.",
  });
  await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  var internal = await ctx.notes.add({
    order_id: ctx.orderId, author: "operator", visibility: "internal",
    body: "Cross-check fraud signal A23.",
  });
  await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  await ctx.notes.add({
    order_id: ctx.orderId, author: "system", visibility: "customer_visible",
    body: "Tracking number updated.",
  });

  var customerView = await ctx.notes.customerVisibleForOrder(ctx.orderId);
  check("customerVisibleForOrder returns 2 notes",     customerView.length === 2);
  check("customerVisibleForOrder excludes internal",
    customerView.every(function (r) { return r.id !== internal.id && r.visibility === "customer_visible"; }));

  // Pinned customer-visible note floats to the top in this view too.
  var second = customerView[1];
  await ctx.notes.pin(second.id);
  var afterPin = await ctx.notes.customerVisibleForOrder(ctx.orderId);
  check("customerVisibleForOrder respects pin order",  afterPin[0].id === second.id);
}

async function run() {
  await _addHappyAndParent();
  await _addRefusalClasses();
  await _listAndCursor();
  await _threadTree();
  await _markReadIdempotency();
  await _pinReorders();
  await _resolveAndReopen();
  await _customerVisibleExcludesInternal();
}

module.exports = { run: run };
