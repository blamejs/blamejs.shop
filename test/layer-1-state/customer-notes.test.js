"use strict";
/**
 * customerNotes — operator-side CRM annotations attached to a customer.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0134.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/customer-notes.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - addNote happy + refusal classes (control bytes, zero-width,
 *     oversize body, bad enums, tag-shape rules)
 *   - notesForCustomer kind + tag filter + include_archived gate
 *   - pinNote/unpinNote reorders the listing
 *   - searchByTag cross-customer scan
 *   - popularTags aggregation + ordering
 *   - archiveNote / unarchiveNote round-trip + idempotency
 *   - updateNote patches mutable columns only
 *   - getNote round-trip + unknown id -> null
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var customerNotes = require("../../lib/customer-notes");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0134_customer_notes.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

function _setup() {
  var query = _makeQuery();
  var notes = customerNotes.create({
    query:        query,
    cursorSecret: "customer-notes-test-secret",
  });
  return { query: query, notes: notes };
}

// ---- 1. addNote happy + refusal classes ------------------------------

async function _addNoteHappyAndRefusals() {
  var ctx = _setup();

  // Happy path — operator-authored preference note with two tags.
  var note = await ctx.notes.addNote({
    customer_id: "customer-acme-001",
    author:      "operator",
    author_id:   "agent-rebecca",
    body:        "Always wants gift wrap on orders over $100.",
    kind:        "preference",
    tags:        ["vip", "gift-wrap"],
  });
  check("addNote returns 36-char uuid id",         typeof note.id === "string" && note.id.length === 36);
  check("addNote persists customer_id",            note.customer_id === "customer-acme-001");
  check("addNote persists author",                 note.author === "operator");
  check("addNote persists author_id",              note.author_id === "agent-rebecca");
  check("addNote persists body",                   note.body.indexOf("gift wrap") !== -1);
  check("addNote persists kind",                   note.kind === "preference");
  check("addNote persists tags array",             Array.isArray(note.tags) && note.tags.length === 2);
  check("addNote default pinned=0",                note.pinned === 0);
  check("addNote default archived_at=null",        note.archived_at === null);
  check("addNote stamps created_at == updated_at", note.created_at === note.updated_at);
  check("addNote created_at is integer ms",        Number.isInteger(note.created_at) && note.created_at > 0);

  // System-authored note with no author_id + default kind=general.
  var sys = await ctx.notes.addNote({
    customer_id: "customer-acme-001",
    author:      "system",
    body:        "First refund issued on 2026-03-01.",
  });
  check("system note defaults kind=general",       sys.kind === "general");
  check("system note tags default to empty array", Array.isArray(sys.tags) && sys.tags.length === 0);
  check("system note author_id defaults to null",  sys.author_id === null);

  // ---- refusal classes ----
  await assert.rejects(ctx.notes.addNote(),                                            /input object required/);
  await assert.rejects(ctx.notes.addNote(null),                                        /input object required/);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "", author: "operator", body: "ok",
  }), /customer_id/);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "x".repeat(250), author: "operator", body: "ok",
  }), /customer_id/);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "bad\x01id", author: "operator", body: "ok",
  }), /control character/);

  // bad author enum
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "robot", body: "ok",
  }), /author/);
  // customer authorship explicitly refused — customer notes are operator-only
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "customer", body: "ok",
  }), /author/);

  // body shape
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "",
  }), /body/);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "   ",
  }), /body/);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: 42,
  }), /body/);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "x".repeat(8001),
  }), /body/);
  // control bytes refused in body — a NUL is named as a null byte
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "bad\x00body",
  }), /null byte/);
  // ...and a non-NUL C0 control as a control character
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "bad\x07body",
  }), /control character/);
  // a bidi override is refused too — it reorders how the note displays
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator",
    body: "paid" + String.fromCharCode(0x202E) + "dnufer",
  }), /bidi override/);
  // zero-width refused
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator",
    body: "bad" + String.fromCharCode(0x200B) + "body",
  }), /zero-width/);

  // bad kind enum
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "ok", kind: "secret",
  }), /kind/);

  // tags shape
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "ok", tags: "not-an-array",
  }), /tags/);
  var manyTags = [];
  for (var i = 0; i < 17; i += 1) manyTags.push("t" + i);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "ok", tags: manyTags,
  }), /tags/);
  // bad tag shape (uppercase)
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "ok", tags: ["BadTag"],
  }), /tags/);
  // duplicate tag
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "ok", tags: ["vip", "vip"],
  }), /duplicate/);

  // bad author_id
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "ok", author_id: "",
  }), /author_id/);
  await assert.rejects(ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "ok", author_id: "x".repeat(250),
  }), /author_id/);

  // getNote round-trip
  var fetched = await ctx.notes.getNote(note.id);
  check("getNote round-trip preserves body",       fetched.body === note.body);
  check("getNote round-trip preserves tags order",
    fetched.tags[0] === "vip" && fetched.tags[1] === "gift-wrap");

  // getNote unknown -> null
  var miss = await ctx.notes.getNote(_validUUID());
  check("getNote unknown id -> null",              miss === null);

  // getNote bad id -> throw
  await assert.rejects(ctx.notes.getNote("not-a-uuid"),                                /note_id/);
}

// ---- 2. notesForCustomer with kind + tag filters --------------------

async function _notesForCustomerFilters() {
  var ctx = _setup();

  // Four notes on customer A: two preference (vip / gift-wrap, do-not-call),
  // one warning (fraud-watch), one billing. One unrelated note on B.
  var prefVip = await ctx.notes.addNote({
    customer_id: "cust-A", author: "operator",
    body: "VIP customer. Comp shipping on orders > $500.",
    kind: "preference", tags: ["vip"],
  });
  var _prefCall = await ctx.notes.addNote({
    customer_id: "cust-A", author: "operator",
    body: "Do not call after 6pm local.",
    kind: "preference", tags: ["do-not-call"],
  });
  var warning = await ctx.notes.addNote({
    customer_id: "cust-A", author: "operator",
    body: "Refund-abuse suspect — review before approving any refund.",
    kind: "warning", tags: ["fraud-watch", "vip"],
  });
  var billing = await ctx.notes.addNote({
    customer_id: "cust-A", author: "operator",
    body: "Net-30 terms approved by finance 2026-02-01.",
    kind: "billing", tags: ["net-30"],
  });
  await ctx.notes.addNote({
    customer_id: "cust-B", author: "operator",
    body: "Allergic to peanut packaging.",
    kind: "preference", tags: ["allergy"],
  });

  // No filter — every note on cust-A (4).
  var all = await ctx.notes.notesForCustomer({ customer_id: "cust-A" });
  check("notesForCustomer no-filter returns 4 rows",   all.rows.length === 4);
  check("notesForCustomer excludes other customer",
    all.rows.every(function (r) { return r.customer_id === "cust-A"; }));
  check("notesForCustomer DESC by created_at",
    all.rows[0].id === billing.id && all.rows[3].id === prefVip.id);

  // kind filter — only preference notes (2).
  var prefOnly = await ctx.notes.notesForCustomer({
    customer_id: "cust-A", kind: "preference",
  });
  check("kind=preference narrows to 2 rows",            prefOnly.rows.length === 2);
  check("kind=preference excludes warning + billing",
    prefOnly.rows.every(function (r) { return r.kind === "preference"; }));

  // tag filter — "vip" matches the prefVip + warning notes (warning
  // has "vip" + "fraud-watch").
  var vipOnly = await ctx.notes.notesForCustomer({
    customer_id: "cust-A", tags: ["vip"],
  });
  check("tag filter vip matches 2 notes",               vipOnly.rows.length === 2);
  var vipIds = vipOnly.rows.map(function (r) { return r.id; }).sort();
  var expectedVip = [prefVip.id, warning.id].sort();
  check("tag filter vip picks the right ids",
    vipIds[0] === expectedVip[0] && vipIds[1] === expectedVip[1]);

  // Multi-tag filter is ANY — "do-not-call" OR "net-30" matches 2 notes.
  var multi = await ctx.notes.notesForCustomer({
    customer_id: "cust-A", tags: ["do-not-call", "net-30"],
  });
  check("multi-tag filter ANY-matches 2 rows",          multi.rows.length === 2);

  // Combined kind + tag filter.
  var combo = await ctx.notes.notesForCustomer({
    customer_id: "cust-A", kind: "preference", tags: ["vip"],
  });
  check("kind + tag filter picks just prefVip",
    combo.rows.length === 1 && combo.rows[0].id === prefVip.id);

  // include_archived default false — archiving a row hides it.
  await ctx.notes.archiveNote(billing.id);
  var afterArchive = await ctx.notes.notesForCustomer({ customer_id: "cust-A" });
  check("notesForCustomer default excludes archived",   afterArchive.rows.length === 3);
  check("archived id not in default listing",
    afterArchive.rows.every(function (r) { return r.id !== billing.id; }));

  // include_archived=true brings it back.
  var withArchived = await ctx.notes.notesForCustomer({
    customer_id: "cust-A", include_archived: true,
  });
  check("include_archived=true returns all 4",          withArchived.rows.length === 4);

  // ---- refusal classes ----
  await assert.rejects(ctx.notes.notesForCustomer(),                                   /input object required/);
  await assert.rejects(ctx.notes.notesForCustomer({ customer_id: "" }),                /customer_id/);
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "cust-A", kind: "ghost",
  }), /kind/);
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "cust-A", tags: "vip",
  }), /tags/);
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "cust-A", tags: ["Bad Tag"],
  }), /tags/);
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "cust-A", limit: 0,
  }), /limit/);
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "cust-A", limit: 999,
  }), /limit/);
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "cust-A", include_archived: "yes",
  }), /include_archived/);
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "cust-A", cursor: 42,
  }), /cursor/);
}

// ---- 3. pinNote reorders the listing --------------------------------

async function _pinNoteReorders() {
  var ctx = _setup();
  var a = await ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "oldest", kind: "general",
  });
  var b = await ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "middle", kind: "general",
  });
  var c = await ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "newest", kind: "general",
  });

  var before = await ctx.notes.notesForCustomer({ customer_id: "c1" });
  check("before pin, newest first (c)",                before.rows[0].id === c.id);
  check("before pin, oldest last (a)",                 before.rows[2].id === a.id);

  // Pin the oldest — it should float to the top.
  var pinned = await ctx.notes.pinNote(a.id);
  check("pinNote returns pinned=1",                    pinned.pinned === 1);
  check("pinNote bumps updated_at",                    pinned.updated_at >= a.updated_at);

  var after = await ctx.notes.notesForCustomer({ customer_id: "c1" });
  check("after pin, oldest (a) floats to top",         after.rows[0].id === a.id);
  check("after pin, newest (c) drops to second",       after.rows[1].id === c.id);
  check("after pin, middle (b) drops to third",        after.rows[2].id === b.id);

  // Re-pin is idempotent on the column value (pinned stays 1).
  var repin = await ctx.notes.pinNote(a.id);
  check("pinNote idempotent on pinned column",         repin.pinned === 1);

  // Unpin reverts the order.
  var unpinned = await ctx.notes.unpinNote(a.id);
  check("unpinNote returns pinned=0",                  unpinned.pinned === 0);
  var reverted = await ctx.notes.notesForCustomer({ customer_id: "c1" });
  check("after unpin, newest (c) back on top",         reverted.rows[0].id === c.id);
  check("after unpin, oldest (a) back at the bottom",  reverted.rows[2].id === a.id);

  // Pin / unpin on unknown id refused.
  await assert.rejects(ctx.notes.pinNote(_validUUID()),                                /not found/);
  await assert.rejects(ctx.notes.unpinNote(_validUUID()),                              /not found/);
  await assert.rejects(ctx.notes.pinNote("not-a-uuid"),                                /note_id/);
}

// ---- 4. searchByTag cross-customer scan -----------------------------

async function _searchByTagCrossCustomer() {
  var ctx = _setup();
  // "vip" lives across 3 customers; "fraud-watch" across 2; "allergy"
  // on a single customer.
  var v1 = await ctx.notes.addNote({
    customer_id: "cust-1", author: "operator", body: "VIP cust 1", tags: ["vip"],
  });
  var v2 = await ctx.notes.addNote({
    customer_id: "cust-2", author: "operator", body: "VIP cust 2", tags: ["vip", "gift-wrap"],
  });
  var v3 = await ctx.notes.addNote({
    customer_id: "cust-3", author: "operator", body: "VIP cust 3",
    tags: ["vip", "fraud-watch"],
  });
  var f1 = await ctx.notes.addNote({
    customer_id: "cust-4", author: "operator", body: "Fraud watch cust 4",
    tags: ["fraud-watch"],
  });
  await ctx.notes.addNote({
    customer_id: "cust-5", author: "operator", body: "Allergic", tags: ["allergy"],
  });

  // Archived rows excluded from searchByTag.
  var archived = await ctx.notes.addNote({
    customer_id: "cust-6", author: "operator", body: "Old VIP", tags: ["vip"],
  });
  await ctx.notes.archiveNote(archived.id);

  // "vip" returns 3 rows (the archived one excluded).
  var vipScan = await ctx.notes.searchByTag({ tag: "vip" });
  check("searchByTag vip returns 3 rows",              vipScan.rows.length === 3);
  var vipIds = vipScan.rows.map(function (r) { return r.id; });
  check("searchByTag vip excludes archived",           vipIds.indexOf(archived.id) === -1);
  check("searchByTag vip includes v1 / v2 / v3",
    vipIds.indexOf(v1.id) !== -1 && vipIds.indexOf(v2.id) !== -1 && vipIds.indexOf(v3.id) !== -1);
  // DESC order — newest first.
  check("searchByTag vip ordered DESC by created_at",
    vipScan.rows[0].id === v3.id && vipScan.rows[2].id === v1.id);

  // "fraud-watch" returns 2 rows.
  var fraudScan = await ctx.notes.searchByTag({ tag: "fraud-watch" });
  check("searchByTag fraud-watch returns 2 rows",      fraudScan.rows.length === 2);
  var fraudIds = fraudScan.rows.map(function (r) { return r.id; }).sort();
  var expectedFraud = [v3.id, f1.id].sort();
  check("searchByTag fraud-watch picks v3 + f1",
    fraudIds[0] === expectedFraud[0] && fraudIds[1] === expectedFraud[1]);

  // Unknown tag -> [].
  var ghost = await ctx.notes.searchByTag({ tag: "ghost-tag" });
  check("searchByTag unknown tag -> empty",            ghost.rows.length === 0);
  check("searchByTag empty -> next_cursor null",       ghost.next_cursor === null);

  // ---- refusal classes ----
  await assert.rejects(ctx.notes.searchByTag(),                                        /input object required/);
  await assert.rejects(ctx.notes.searchByTag({ tag: "" }),                             /tag/);
  await assert.rejects(ctx.notes.searchByTag({ tag: "Bad Tag" }),                      /tag/);
  await assert.rejects(ctx.notes.searchByTag({ tag: "vip", limit: 0 }),                /limit/);
  await assert.rejects(ctx.notes.searchByTag({ tag: "vip", cursor: 42 }),              /cursor/);
}

// ---- 5. popularTags aggregation -------------------------------------

async function _popularTagsAggregation() {
  var ctx = _setup();
  // Build a small population: vip x4, gift-wrap x2, fraud-watch x1.
  await ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "n1", tags: ["vip"],
  });
  await ctx.notes.addNote({
    customer_id: "c2", author: "operator", body: "n2", tags: ["vip", "gift-wrap"],
  });
  await ctx.notes.addNote({
    customer_id: "c3", author: "operator", body: "n3", tags: ["vip", "gift-wrap"],
  });
  await ctx.notes.addNote({
    customer_id: "c4", author: "operator", body: "n4", tags: ["vip", "fraud-watch"],
  });
  // Archived note's tags are excluded from the aggregate.
  var archived = await ctx.notes.addNote({
    customer_id: "c5", author: "operator", body: "n5", tags: ["vip", "ghost"],
  });
  await ctx.notes.archiveNote(archived.id);

  var top = await ctx.notes.popularTags();
  check("popularTags returns array",                   Array.isArray(top));
  check("popularTags excludes archived 'ghost' tag",
    top.every(function (t) { return t.tag !== "ghost"; }));

  // Re-bucket the result by tag for ergonomic assertions.
  var byTag = {};
  for (var i = 0; i < top.length; i += 1) byTag[top[i].tag] = top[i].count;
  check("popularTags counts vip=4",                    byTag.vip === 4);
  check("popularTags counts gift-wrap=2",              byTag["gift-wrap"] === 2);
  check("popularTags counts fraud-watch=1",            byTag["fraud-watch"] === 1);

  // Ordering — DESC count then alpha tie-break.
  check("popularTags first entry is vip",              top[0].tag === "vip");
  check("popularTags second is gift-wrap",             top[1].tag === "gift-wrap");
  check("popularTags third is fraud-watch",            top[2].tag === "fraud-watch");

  // limit narrows.
  var topOne = await ctx.notes.popularTags({ limit: 1 });
  check("popularTags limit=1 returns 1 row",           topOne.length === 1);
  check("popularTags limit=1 returns vip",             topOne[0].tag === "vip");

  // ---- refusal classes ----
  await assert.rejects(ctx.notes.popularTags({ limit: 0 }),                            /limit/);
  await assert.rejects(ctx.notes.popularTags({ limit: 9999 }),                         /limit/);
  await assert.rejects(ctx.notes.popularTags({ limit: 1.5 }),                          /limit/);
}

// ---- 6. archive / unarchive round-trip ------------------------------

async function _archiveUnarchive() {
  var ctx = _setup();
  var n = await ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "to be archived",
  });
  check("created note archived_at=null",               n.archived_at === null);

  var archived = await ctx.notes.archiveNote(n.id);
  check("archiveNote stamps archived_at",              typeof archived.archived_at === "number" && archived.archived_at > 0);
  check("archiveNote bumps updated_at",                archived.updated_at >= n.updated_at);

  // Re-archive is idempotent — archived_at stays at the original value.
  var reArchived = await ctx.notes.archiveNote(n.id);
  check("archiveNote idempotent on archived row",      reArchived.archived_at === archived.archived_at);

  // Default listing excludes the archived row.
  var defaultList = await ctx.notes.notesForCustomer({ customer_id: "c1" });
  check("archived row excluded from default listing",  defaultList.rows.length === 0);

  // Unarchive clears the timestamp.
  var unarchived = await ctx.notes.unarchiveNote(n.id);
  check("unarchiveNote clears archived_at",            unarchived.archived_at === null);

  // Unarchive on a non-archived row is idempotent.
  var noop = await ctx.notes.unarchiveNote(n.id);
  check("unarchiveNote idempotent on live row",        noop.archived_at === null);

  // After unarchive, the row is back in the default listing.
  var liveAgain = await ctx.notes.notesForCustomer({ customer_id: "c1" });
  check("unarchived row reappears in listing",         liveAgain.rows.length === 1);

  // Archive / unarchive on unknown id refused.
  await assert.rejects(ctx.notes.archiveNote(_validUUID()),                            /not found/);
  await assert.rejects(ctx.notes.unarchiveNote(_validUUID()),                          /not found/);
  await assert.rejects(ctx.notes.archiveNote("not-a-uuid"),                            /note_id/);
}

// ---- 7. updateNote patches mutable columns -------------------------

async function _updateNotePatches() {
  var ctx = _setup();
  var n = await ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "initial body",
    kind: "general", tags: ["vip"],
  });

  // Patch body.
  var bodyPatched = await ctx.notes.updateNote(n.id, { body: "updated body content" });
  check("updateNote patches body",                     bodyPatched.body === "updated body content");
  check("updateNote bumps updated_at",                 bodyPatched.updated_at >= n.updated_at);
  check("updateNote preserves kind on body patch",     bodyPatched.kind === "general");
  check("updateNote preserves tags on body patch",
    bodyPatched.tags.length === 1 && bodyPatched.tags[0] === "vip");

  // Patch kind.
  var kindPatched = await ctx.notes.updateNote(n.id, { kind: "escalation" });
  check("updateNote patches kind",                     kindPatched.kind === "escalation");

  // Patch tags.
  var tagsPatched = await ctx.notes.updateNote(n.id, { tags: ["fraud-watch", "do-not-call"] });
  check("updateNote patches tags",
    tagsPatched.tags.length === 2 &&
    tagsPatched.tags[0] === "fraud-watch" &&
    tagsPatched.tags[1] === "do-not-call");

  // Patch tags to empty array — explicit clear.
  var cleared = await ctx.notes.updateNote(n.id, { tags: [] });
  check("updateNote clears tags via empty array",      cleared.tags.length === 0);

  // ---- refusal classes ----
  await assert.rejects(ctx.notes.updateNote(),                                         /note_id/);
  await assert.rejects(ctx.notes.updateNote("not-a-uuid", { body: "x" }),              /note_id/);
  await assert.rejects(ctx.notes.updateNote(n.id),                                     /patch object required/);
  await assert.rejects(ctx.notes.updateNote(n.id, {}),                                 /at least one column/);
  // unsupported columns (immutable)
  await assert.rejects(ctx.notes.updateNote(n.id, { customer_id: "other" }),           /unsupported column/);
  await assert.rejects(ctx.notes.updateNote(n.id, { author: "system" }),               /unsupported column/);
  await assert.rejects(ctx.notes.updateNote(n.id, { pinned: 1 }),                      /unsupported column/);
  // invalid patch values reuse the same validators
  await assert.rejects(ctx.notes.updateNote(n.id, { body: "" }),                       /body/);
  await assert.rejects(ctx.notes.updateNote(n.id, { body: "x".repeat(9000) }),         /body/);
  await assert.rejects(ctx.notes.updateNote(n.id, { kind: "ghost" }),                  /kind/);
  await assert.rejects(ctx.notes.updateNote(n.id, { tags: ["BadTag"] }),               /tags/);
  // unknown note
  await assert.rejects(ctx.notes.updateNote(_validUUID(), { body: "x" }),              /not found/);
}

// ---- 8. cursor pagination round-trip -------------------------------

async function _cursorPagination() {
  var ctx = _setup();
  // Add 5 notes; page through them at limit=2.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var n = await ctx.notes.addNote({
      customer_id: "c1", author: "operator", body: "note " + i,
    });
    ids.push(n.id);
  }

  var page1 = await ctx.notes.notesForCustomer({ customer_id: "c1", limit: 2 });
  check("page1 returns 2 rows",                        page1.rows.length === 2);
  check("page1 returns a non-empty cursor",
    typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);

  var page2 = await ctx.notes.notesForCustomer({
    customer_id: "c1", limit: 2, cursor: page1.next_cursor,
  });
  check("page2 returns 2 more rows",                   page2.rows.length === 2);
  check("page2 disjoint from page1",
    page2.rows.every(function (r) {
      return page1.rows.every(function (p) { return p.id !== r.id; });
    }));

  var page3 = await ctx.notes.notesForCustomer({
    customer_id: "c1", limit: 2, cursor: page2.next_cursor,
  });
  check("page3 returns the final row",                 page3.rows.length === 1);
  check("page3 emits null cursor",                     page3.next_cursor === null);

  // Tampered cursor is refused (HMAC verification fails).
  await assert.rejects(ctx.notes.notesForCustomer({
    customer_id: "c1", limit: 2, cursor: page1.next_cursor + "x",
  }), /cursor/);

  // Cross-orderKey replay — encode a searchByTag cursor + try to use
  // it on notesForCustomer. The orderKey mismatch is caught.
  await ctx.notes.addNote({
    customer_id: "c1", author: "operator", body: "tagged", tags: ["vip"],
  });
  var tagPage = await ctx.notes.searchByTag({ tag: "vip", limit: 1 });
  if (tagPage.next_cursor) {
    await assert.rejects(ctx.notes.notesForCustomer({
      customer_id: "c1", cursor: tagPage.next_cursor,
    }), /cursor/);
  }
}

// ---- 9. factory + framework wiring ----------------------------------

async function _factoryAndFramework() {
  // Factory accepts an explicit query handle; without one it falls
  // back to bShop.framework.externalDb.query — the factory itself
  // constructs fine (the throw is deferred to first method call).
  var lazyNotes = customerNotes.create();
  check("factory constructs without explicit query",
    typeof lazyNotes.addNote === "function");

  // Module-level constants on the surface.
  check("MAX_BODY_LEN exported",                       customerNotes.MAX_BODY_LEN === 8000);
  check("MAX_TAG_COUNT exported",                      customerNotes.MAX_TAG_COUNT === 16);
  check("MAX_TAG_LEN exported",                        customerNotes.MAX_TAG_LEN === 64);
  check("ALLOWED_AUTHORS is the 2-entry array",
    Array.isArray(customerNotes.ALLOWED_AUTHORS) &&
    customerNotes.ALLOWED_AUTHORS.length === 2 &&
    Object.isFrozen(customerNotes.ALLOWED_AUTHORS));
  check("ALLOWED_KINDS is the 5-entry array",
    Array.isArray(customerNotes.ALLOWED_KINDS) &&
    customerNotes.ALLOWED_KINDS.length === 5 &&
    Object.isFrozen(customerNotes.ALLOWED_KINDS));

  // Framework handle resolves the lazy require cleanly.
  check("bShop.framework exposes uuid.v7",
    typeof bShop.framework.uuid.v7 === "function");
  check("bShop.framework exposes pagination.encodeCursor",
    typeof bShop.framework.pagination.encodeCursor === "function");
}

async function run() {
  await _addNoteHappyAndRefusals();
  await _notesForCustomerFilters();
  await _pinNoteReorders();
  await _searchByTagCrossCustomer();
  await _popularTagsAggregation();
  await _archiveUnarchive();
  await _updateNotePatches();
  await _cursorPagination();
  await _factoryAndFramework();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/customer-notes.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - customer-notes (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
