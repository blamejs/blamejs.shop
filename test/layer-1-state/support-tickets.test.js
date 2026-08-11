"use strict";
/**
 * supportTickets — customer-service ticketing surface broader than
 * orderNotes.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0047.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/support-tickets.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - open happy: persists row + hashes email + seeds first message
 *   - open refusals: missing input / bad enums / oversize / control
 *                    bytes / zero-width
 *   - reply flips status new -> in_progress on first operator reply,
 *     stamps first_response_at + last_action_at; customer reply
 *     moves waiting_customer -> in_progress; closed-ticket reply
 *     refused
 *   - transition FSM: legal paths + every refused edge per from-
 *     state; status_history rows written
 *   - assign / unassign update assigned_operator_id + last_action_at
 *   - tag CRUD: add idempotent, remove no-op when absent, cap honored
 *   - listForCustomer cursor round-trip + tamper refusal + status_filter
 *   - listOpenAssignedTo + listUnassigned ordering
 *   - slaCheck threshold correctness per priority
 *   - metrics aggregation (per-category, avg first-response, resolution-
 *     rate, escalation-rate)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var supportTickets = require("../../lib/support-tickets");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0047_support_tickets.sql"
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
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

function _setup() {
  var query   = _makeQuery();
  var tickets = supportTickets.create({
    query:        query,
    cursorSecret: "support-tickets-test-secret",
  });
  return { query: query, tickets: tickets };
}

async function _openHappyPath() {
  var ctx = _setup();
  var customerId = _validUUID();
  var t = await ctx.tickets.open({
    customer_id:    customerId,
    customer_email: "Alice@Example.com",
    subject:        "Where is my order?",
    body:           "I placed an order three days ago and still haven't received a tracking number.",
    category:       "order_issue",
    priority:       "high",
    tags:           ["urgent-customer", "vip"],
  });
  check("open returns 36-char uuid",            typeof t.id === "string" && t.id.length === 36);
  check("open stamps status='new'",             t.status === "new");
  check("open stamps priority='high'",          t.priority === "high");
  check("open stamps category",                 t.category === "order_issue");
  check("open hashes email (hex sha3-512)",     typeof t.customer_email_hash === "string" && /^[0-9a-f]{128}$/.test(t.customer_email_hash));
  check("open does NOT store raw email",        Object.keys(t).indexOf("customer_email") === -1);
  check("open persists customer_id",            t.customer_id === customerId);
  check("open persists tags as array",          Array.isArray(t.tags) && t.tags.length === 2);
  check("open opened_at == last_action_at",     t.opened_at === t.last_action_at);
  check("open first_response_at unset",         t.first_response_at == null);
  check("open resolved_at unset",               t.resolved_at == null);
  check("open closed_at unset",                 t.closed_at == null);

  // Seeded first message lands in the thread.
  var thread = await ctx.tickets.thread(t.id);
  check("thread returns ticket + messages",     thread.ticket.id === t.id && Array.isArray(thread.messages));
  check("thread seeds 1 customer message",      thread.messages.length === 1 && thread.messages[0].author === "customer");
  check("thread seeded message carries body",   thread.messages[0].body.indexOf("three days") !== -1);

  // Default priority is "normal" when omitted.
  var t2 = await ctx.tickets.open({
    customer_email: "bob@example.com",
    subject:        "Pre-sale question about shipping",
    body:           "Do you ship to Canada?",
    category:       "pre_sale",
  });
  check("open default priority is normal",      t2.priority === "normal");

  // Two tickets for the same email collide on the same hash —
  // listForCustomer surfaces both.
  var listed = await ctx.tickets.listForCustomer({ customer_email: "alice@example.com" });
  check("listForCustomer hashes lookup email",  listed.rows.length === 1);

  // Email casing normalised — opening with a different casing still
  // attaches to the same hash bucket.
  await ctx.tickets.open({
    customer_email: "ALICE@example.COM",
    subject:        "Another question",
    body:           "Follow up on the prior ticket.",
    category:       "order_issue",
  });
  var listed2 = await ctx.tickets.listForCustomer({ customer_email: "Alice@Example.Com" });
  check("listForCustomer casing-insensitive",   listed2.rows.length === 2);
}

async function _openRefusalClasses() {
  var ctx = _setup();
  await assert.rejects(ctx.tickets.open(),                                /input object required/);
  // missing email
  await assert.rejects(ctx.tickets.open({
    subject: "s", body: "b", category: "other",
  }), /customer_email/);
  // bad email shape
  await assert.rejects(ctx.tickets.open({
    customer_email: "not an email", subject: "s", body: "b", category: "other",
  }), /customer_email/);
  // bad category
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "s", body: "b", category: "wat",
  }), /category/);
  // bad priority
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "s", body: "b", category: "other", priority: "asap",
  }), /priority/);
  // oversize subject
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com",
    subject:        "x".repeat(201),
    body:           "b",
    category:       "other",
  }), /subject/);
  // empty subject after trim
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "   ", body: "b", category: "other",
  }), /subject/);
  // control byte in subject (subject is strict — newline refused)
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "bad\nsubject", body: "b", category: "other",
  }), /subject/);
  // oversize body
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com",
    subject:        "s",
    body:           "x".repeat(8001),
    category:       "other",
  }), /body/);
  // control byte in body
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "s", body: "bad\x00body", category: "other",
  }), /null byte/);
  // zero-width in body — built via String.fromCharCode so the source
  // file stays free of irregular-whitespace ESLint hits.
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com",
    subject:        "s",
    body:           "bad" + String.fromCharCode(0x200B) + "body",
    category:       "other",
  }), /zero-width/);
  // tags too many
  var manyTags = [];
  for (var i = 0; i < 17; i += 1) manyTags.push("t" + i);
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "s", body: "b", category: "other", tags: manyTags,
  }), /tags/);
  // bad customer_id
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "s", body: "b", category: "other", customer_id: "not-a-uuid",
  }), /customer_id/);
  // bad order_id
  await assert.rejects(ctx.tickets.open({
    customer_email: "x@example.com", subject: "s", body: "b", category: "other", order_id: "nope",
  }), /order_id/);
}

async function _replyFlipsStatus() {
  var ctx = _setup();
  var t = await ctx.tickets.open({
    customer_email: "alice@example.com",
    subject:        "Help",
    body:           "Initial body.",
    category:       "other",
  });
  check("open status starts at 'new'",          t.status === "new");

  // Customer reply on a `new` ticket does NOT flip status.
  var afterCust = await ctx.tickets.reply({
    ticket_id: t.id,
    author:    "customer",
    body:      "Bump.",
  });
  check("customer reply keeps status='new'",    afterCust.status === "new");
  check("customer reply does NOT stamp first_response_at",  afterCust.first_response_at == null);
  check("customer reply does NOT bump last_action_at",      afterCust.last_action_at === t.last_action_at);

  // Operator reply flips status to in_progress, stamps first_response_at.
  var operatorId = _validUUID();
  await helpers.waitUntil(function () { return Date.now() > t.opened_at; }, { timeoutMs: 5000, intervalMs: 2 });
  var afterOp = await ctx.tickets.reply({
    ticket_id: t.id,
    author:    "operator",
    author_id: operatorId,
    body:      "Looking into this now.",
  });
  check("operator reply flips status -> in_progress", afterOp.status === "in_progress");
  check("operator reply stamps first_response_at",    typeof afterOp.first_response_at === "number");
  check("operator reply bumps last_action_at",        afterOp.last_action_at > t.last_action_at);

  // Second operator reply doesn't overwrite first_response_at.
  var firstResp = afterOp.first_response_at;
  await helpers.waitUntil(function () { return Date.now() > afterOp.last_action_at; }, { timeoutMs: 5000, intervalMs: 2 });
  var afterOp2 = await ctx.tickets.reply({
    ticket_id: t.id, author: "operator", body: "Update — escalating.",
  });
  check("second operator reply preserves first_response_at", afterOp2.first_response_at === firstResp);

  // System reply doesn't change status.
  var afterSys = await ctx.tickets.reply({
    ticket_id: t.id, author: "system", body: "Auto: assigned to triage queue.",
  });
  check("system reply preserves status",        afterSys.status === "in_progress");

  // Internal note from operator allowed (appended to the thread); the
  // ticket was already in_progress, so it stays there. internal=true with
  // author!=operator refused.
  var afterInternal = await ctx.tickets.reply({
    ticket_id: t.id, author: "operator", body: "Internal note: VIP flag.", internal: true,
  });
  check("internal operator reply accepted",     afterInternal.status === "in_progress");
  await assert.rejects(ctx.tickets.reply({
    ticket_id: t.id, author: "customer", body: "x", internal: true,
  }), /internal=true/);

  // Move to waiting_customer; customer reply moves back to in_progress.
  await ctx.tickets.transition({ ticket_id: t.id, to_status: "waiting_customer" });
  var afterCustReply = await ctx.tickets.reply({
    ticket_id: t.id, author: "customer", body: "Here's the info you asked for.",
  });
  check("customer reply on waiting_customer -> in_progress", afterCustReply.status === "in_progress");

  // Closed ticket refuses replies.
  await ctx.tickets.transition({ ticket_id: t.id, to_status: "resolved" });
  await ctx.tickets.transition({ ticket_id: t.id, to_status: "closed" });
  await assert.rejects(ctx.tickets.reply({
    ticket_id: t.id, author: "customer", body: "still around?",
  }), /closed/);

  // Refusal classes.
  await assert.rejects(ctx.tickets.reply({
    ticket_id: _validUUID(), author: "operator", body: "x",
  }), /not found/);
  await assert.rejects(ctx.tickets.reply({
    ticket_id: t.id, author: "alien", body: "x",
  }), /author/);
  await assert.rejects(ctx.tickets.reply({
    ticket_id: t.id, author: "operator", body: "",
  }), /body/);
}

// An INTERNAL operator note (internal=true) is operator-to-operator: the
// customer never sees it, so it must NOT count as a first response or move
// a `new` ticket into the workflow. Only a customer-visible operator reply
// stamps first_response_at — otherwise the response SLA is satisfied by
// content the customer never received.
async function _internalNoteDoesNotStampFirstResponse() {
  var ctx = _setup();
  var t = await ctx.tickets.open({
    customer_email: "alice@example.com",
    subject: "Q", body: "Initial body.", category: "other",
  });
  check("internal-note: opens at new",          t.status === "new");

  var operatorId = _validUUID();
  var afterInternal = await ctx.tickets.reply({
    ticket_id: t.id, author: "operator", author_id: operatorId,
    body: "Internal: flag for billing review.", internal: true,
  });
  check("internal note keeps status='new'",                afterInternal.status === "new");
  check("internal note does NOT stamp first_response_at",  afterInternal.first_response_at == null);
  check("internal note does NOT bump last_action_at",      afterInternal.last_action_at === t.last_action_at);

  // The internal message WAS appended to the thread (operator-visible).
  var thread = await ctx.tickets.thread(t.id);
  var internalMsgs = thread.messages.filter(function (m) { return m.internal === 1 || m.internal === true; });
  check("internal note appended to the thread", internalMsgs.length === 1);

  // A subsequent customer-visible operator reply IS the first response.
  await helpers.waitUntil(function () { return Date.now() > t.opened_at; }, { timeoutMs: 5000, intervalMs: 2 });
  var afterVisible = await ctx.tickets.reply({
    ticket_id: t.id, author: "operator", author_id: operatorId, body: "Hi — here's the answer.",
  });
  check("customer-visible reply flips -> in_progress",  afterVisible.status === "in_progress");
  check("customer-visible reply stamps first_response_at", typeof afterVisible.first_response_at === "number");
}

// A customer reply to a RESOLVED ticket must reopen it (resolved ->
// reopened) so it lands back in an operator queue — never silently dropped.
async function _customerReplyReopensResolved() {
  var ctx = _setup();
  var operatorId = _validUUID();
  var t = await ctx.tickets.open({
    customer_email: "alice@example.com",
    subject: "Q", body: "Initial body.", category: "other",
  });
  await ctx.tickets.reply({ ticket_id: t.id, author: "operator", author_id: operatorId, body: "Try this fix." });
  var resolved = await ctx.tickets.transition({ ticket_id: t.id, to_status: "resolved" });
  check("resolved status set",                  resolved.status === "resolved");

  await helpers.waitUntil(function () { return Date.now() > resolved.last_action_at; }, { timeoutMs: 5000, intervalMs: 2 });
  var afterReply = await ctx.tickets.reply({
    ticket_id: t.id, author: "customer", body: "That didn't work — still broken.",
  });
  check("customer reply to resolved -> reopened",       afterReply.status === "reopened");
  check("reopen bumps last_action_at (fresh SLA clock)", afterReply.last_action_at > resolved.last_action_at);

  // The reopen is recorded in the status history (auditable, not silent).
  var thread = await ctx.tickets.thread(t.id);
  check("reopen message appended", thread.messages.some(function (m) { return m.author === "customer" && m.body.indexOf("still broken") !== -1; }));
}

// addTag / removeTag mutate tags_json in a SINGLE atomic JSON1 statement,
// so two concurrent adds of distinct tags can't lose one. The prior
// read-modify-write (decode -> push in JS -> write back) dropped a write.
async function _concurrentTagWritesAtomic() {
  var ctx = _setup();
  var t = await ctx.tickets.open({
    customer_email: "alice@example.com",
    subject: "Q", body: "Initial body.", category: "other",
  });
  await Promise.all([
    ctx.tickets.addTag({ ticket_id: t.id, tag: "alpha" }),
    ctx.tickets.addTag({ ticket_id: t.id, tag: "beta" }),
    ctx.tickets.addTag({ ticket_id: t.id, tag: "gamma" }),
  ]);
  var after = await ctx.tickets.get(t.id);
  check("concurrent addTag keeps alpha", after.tags.indexOf("alpha") !== -1);
  check("concurrent addTag keeps beta",  after.tags.indexOf("beta") !== -1);
  check("concurrent addTag keeps gamma", after.tags.indexOf("gamma") !== -1);
  check("concurrent addTag no lost write", after.tags.length === 3);

  // Idempotent re-add over the atomic path is still a no-op.
  var dup = await ctx.tickets.addTag({ ticket_id: t.id, tag: "alpha" });
  check("atomic addTag idempotent",      dup.tags.length === 3);

  // Atomic remove of a present tag; no-op on an absent one.
  var removed = await ctx.tickets.removeTag({ ticket_id: t.id, tag: "beta" });
  check("atomic removeTag drops beta",   removed.tags.indexOf("beta") === -1 && removed.tags.length === 2);
  var noop = await ctx.tickets.removeTag({ ticket_id: t.id, tag: "not-present" });
  check("atomic removeTag no-op absent", noop.tags.length === 2);

  // Cap still enforced through the atomic path.
  var u = await ctx.tickets.open({
    customer_email: "bob@example.com", subject: "Q", body: "Body.", category: "other",
  });
  for (var i = 0; i < 16; i += 1) {
    await ctx.tickets.addTag({ ticket_id: u.id, tag: "t-" + i });
  }
  await assert.rejects(ctx.tickets.addTag({ ticket_id: u.id, tag: "overflow" }), /tags/);
  // A missing ticket is still a hard error on both paths.
  await assert.rejects(ctx.tickets.addTag({ ticket_id: _validUUID(), tag: "x" }), /not found/);
  await assert.rejects(ctx.tickets.removeTag({ ticket_id: _validUUID(), tag: "x" }), /not found/);
}

async function _fsmTransitions() {
  var ctx = _setup();
  var t = await ctx.tickets.open({
    customer_email: "alice@example.com",
    subject: "Q", body: "B", category: "other",
  });

  // new -> in_progress
  var t1 = await ctx.tickets.transition({ ticket_id: t.id, to_status: "in_progress", reason: "manual triage" });
  check("new -> in_progress",                   t1.status === "in_progress");

  // in_progress -> waiting_customer
  var t2 = await ctx.tickets.transition({ ticket_id: t.id, to_status: "waiting_customer" });
  check("in_progress -> waiting_customer",      t2.status === "waiting_customer");

  // waiting_customer -> in_progress (legal branch)
  var t3 = await ctx.tickets.transition({ ticket_id: t.id, to_status: "in_progress" });
  check("waiting_customer -> in_progress",      t3.status === "in_progress");

  // in_progress -> resolved (stamps resolved_at)
  var t4 = await ctx.tickets.transition({ ticket_id: t.id, to_status: "resolved" });
  check("in_progress -> resolved",              t4.status === "resolved");
  check("transition to resolved stamps resolved_at", typeof t4.resolved_at === "number");

  // resolved -> reopened -> in_progress
  var t5 = await ctx.tickets.transition({ ticket_id: t.id, to_status: "reopened" });
  check("resolved -> reopened",                 t5.status === "reopened");
  // resolved_at retains its original stamp (audit trail).
  check("reopened preserves prior resolved_at", t5.resolved_at === t4.resolved_at);
  var t6 = await ctx.tickets.transition({ ticket_id: t.id, to_status: "in_progress" });
  check("reopened -> in_progress",              t6.status === "in_progress");

  // Force-close from any state.
  var t7 = await ctx.tickets.transition({ ticket_id: t.id, to_status: "closed", reason: "operator force-close" });
  check("any -> closed",                        t7.status === "closed");
  check("transition to closed stamps closed_at", typeof t7.closed_at === "number");

  // closed is terminal — every onward edge refused.
  await assert.rejects(ctx.tickets.transition({ ticket_id: t.id, to_status: "in_progress" }), /refused/);
  await assert.rejects(ctx.tickets.transition({ ticket_id: t.id, to_status: "reopened"    }), /refused/);

  // Illegal edges from intermediate states.
  var u = await ctx.tickets.open({
    customer_email: "bob@example.com", subject: "Q", body: "B", category: "other",
  });
  // new -> waiting_customer is illegal (must go through in_progress)
  await assert.rejects(ctx.tickets.transition({ ticket_id: u.id, to_status: "waiting_customer" }), /refused/);
  // new -> resolved is illegal
  await assert.rejects(ctx.tickets.transition({ ticket_id: u.id, to_status: "resolved" }), /refused/);
  // new -> reopened is illegal
  await assert.rejects(ctx.tickets.transition({ ticket_id: u.id, to_status: "reopened" }), /refused/);

  // Bad to_status enum refused.
  await assert.rejects(ctx.tickets.transition({ ticket_id: u.id, to_status: "exploded" }), /to_status/);
  // Bad ticket_id refused.
  await assert.rejects(ctx.tickets.transition({ ticket_id: _validUUID(), to_status: "in_progress" }), /not found/);
  // Oversize reason refused.
  await assert.rejects(ctx.tickets.transition({
    ticket_id: u.id, to_status: "in_progress", reason: "x".repeat(281),
  }), /reason/);

  // Status history rows recorded.
  var history = (await ctx.query(
    "SELECT * FROM support_status_history WHERE ticket_id = ?1 ORDER BY occurred_at ASC, id ASC",
    [t.id],
  )).rows;
  check("status history records every transition", history.length === 7);
  var manualTriage = history.filter(function (h) { return h.reason === "manual triage"; });
  check("status history records reason",         manualTriage.length === 1 && manualTriage[0].from_status === "new" && manualTriage[0].to_status === "in_progress");
  var forceClose = history.filter(function (h) { return h.reason === "operator force-close"; });
  check("status history records force-close reason", forceClose.length === 1 && forceClose[0].to_status === "closed");
}

async function _assignUnassign() {
  var ctx = _setup();
  var t = await ctx.tickets.open({
    customer_email: "alice@example.com", subject: "Q", body: "B", category: "other",
  });
  var operatorId = _validUUID();
  await helpers.waitUntil(function () { return Date.now() > t.opened_at; }, { timeoutMs: 5000, intervalMs: 2 });
  var assigned = await ctx.tickets.assign({ ticket_id: t.id, operator_id: operatorId });
  check("assign sets assigned_operator_id",     assigned.assigned_operator_id === operatorId);
  check("assign bumps last_action_at",          assigned.last_action_at > t.last_action_at);

  await helpers.waitUntil(function () { return Date.now() > assigned.last_action_at; }, { timeoutMs: 5000, intervalMs: 2 });
  var unassigned = await ctx.tickets.unassign(t.id);
  check("unassign clears assigned_operator_id", unassigned.assigned_operator_id == null);
  check("unassign bumps last_action_at",        unassigned.last_action_at > assigned.last_action_at);

  // Refusals.
  await assert.rejects(ctx.tickets.assign({ ticket_id: _validUUID(), operator_id: operatorId }), /not found/);
  await assert.rejects(ctx.tickets.assign({ ticket_id: t.id,         operator_id: "bad"     }), /operator_id/);
  await assert.rejects(ctx.tickets.unassign(_validUUID()),                                       /not found/);
}

async function _tagCRUD() {
  var ctx = _setup();
  var t = await ctx.tickets.open({
    customer_email: "alice@example.com", subject: "Q", body: "B", category: "other",
  });
  var t1 = await ctx.tickets.addTag({ ticket_id: t.id, tag: "vip" });
  check("addTag adds tag",                      t1.tags.indexOf("vip") !== -1 && t1.tags.length === 1);
  // Idempotent on the same tag.
  var t2 = await ctx.tickets.addTag({ ticket_id: t.id, tag: "vip" });
  check("addTag idempotent",                    t2.tags.length === 1);
  // Distinct tag adds.
  var t3 = await ctx.tickets.addTag({ ticket_id: t.id, tag: "refund-investigation" });
  check("addTag distinct adds",                 t3.tags.length === 2);

  // Remove existing.
  var t4 = await ctx.tickets.removeTag({ ticket_id: t.id, tag: "vip" });
  check("removeTag removes tag",                t4.tags.indexOf("vip") === -1 && t4.tags.length === 1);
  // Remove absent — no-op.
  var t5 = await ctx.tickets.removeTag({ ticket_id: t.id, tag: "not-there" });
  check("removeTag no-op on absent",            t5.tags.length === 1);

  // Cap honored — fill to MAX then refuse.
  for (var i = t5.tags.length; i < supportTickets.MAX_TAG_COUNT; i += 1) {
    await ctx.tickets.addTag({ ticket_id: t.id, tag: "tag-" + i });
  }
  await assert.rejects(ctx.tickets.addTag({ ticket_id: t.id, tag: "overflow" }), /tags/);

  // Refusals.
  await assert.rejects(ctx.tickets.addTag({ ticket_id: t.id, tag: "" }),                              /tag/);
  await assert.rejects(ctx.tickets.addTag({ ticket_id: t.id, tag: "x".repeat(33) }),                  /tag/);
  await assert.rejects(ctx.tickets.addTag({ ticket_id: t.id, tag: "bad\x01tag" }),                    /tag/);
  await assert.rejects(ctx.tickets.addTag({ ticket_id: _validUUID(), tag: "vip" }),                   /not found/);
  await assert.rejects(ctx.tickets.removeTag({ ticket_id: _validUUID(), tag: "vip" }),                /not found/);
}

async function _listForCustomerPagination() {
  var ctx = _setup();
  // Open 5 tickets for alice with deterministic opened_at separation.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var t = await ctx.tickets.open({
      customer_email: "alice@example.com",
      subject:        "Ticket " + i,
      body:           "Body " + i,
      category:       i % 2 === 0 ? "order_issue" : "billing",
    });
    ids.push(t.id);
    await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  }
  // One ticket for a different email — must not leak.
  await ctx.tickets.open({
    customer_email: "bob@example.com",
    subject: "Bob's ticket", body: "B", category: "other",
  });

  // All in one shot.
  var all = await ctx.tickets.listForCustomer({ customer_email: "alice@example.com" });
  check("listForCustomer returns all 5 alice tickets", all.rows.length === 5);
  check("listForCustomer excludes other emails",
    all.rows.every(function (r) { return ids.indexOf(r.id) !== -1; }));

  // Paginate at limit=2.
  var page1 = await ctx.tickets.listForCustomer({ customer_email: "alice@example.com", limit: 2 });
  check("listForCustomer page1 returns 2",      page1.rows.length === 2);
  check("listForCustomer page1 has cursor",     typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await ctx.tickets.listForCustomer({
    customer_email: "alice@example.com", limit: 2, cursor: page1.next_cursor,
  });
  check("listForCustomer page2 returns 2",      page2.rows.length === 2);
  var page3 = await ctx.tickets.listForCustomer({
    customer_email: "alice@example.com", limit: 2, cursor: page2.next_cursor,
  });
  check("listForCustomer page3 returns last 1", page3.rows.length === 1);
  check("listForCustomer page3 no cursor",      page3.next_cursor === null);
  // Disjoint pages.
  var seen = {};
  page1.rows.concat(page2.rows, page3.rows).forEach(function (r) { seen[r.id] = (seen[r.id] || 0) + 1; });
  check("listForCustomer paginated coverage disjoint",
    Object.keys(seen).length === 5 && Object.keys(seen).every(function (k) { return seen[k] === 1; }));

  // Tampered cursor refused.
  await assert.rejects(ctx.tickets.listForCustomer({
    customer_email: "alice@example.com", cursor: page1.next_cursor + "x",
  }), /cursor/);

  // status_filter narrows.
  await ctx.tickets.transition({ ticket_id: ids[0], to_status: "in_progress" });
  var newOnly = await ctx.tickets.listForCustomer({
    customer_email: "alice@example.com", status_filter: "new",
  });
  check("status_filter='new' narrows",          newOnly.rows.length === 4);
  var inprogOnly = await ctx.tickets.listForCustomer({
    customer_email: "alice@example.com", status_filter: "in_progress",
  });
  check("status_filter='in_progress' narrows",  inprogOnly.rows.length === 1 && inprogOnly.rows[0].id === ids[0]);

  // Bad limit + bad status_filter refused.
  await assert.rejects(ctx.tickets.listForCustomer({
    customer_email: "alice@example.com", limit: 0,
  }), /limit/);
  await assert.rejects(ctx.tickets.listForCustomer({
    customer_email: "alice@example.com", status_filter: "bogus",
  }), /status_filter/);
}

async function _assignedAndUnassignedQueues() {
  var ctx = _setup();
  var op1 = _validUUID();
  var op2 = _validUUID();

  var lo = await ctx.tickets.open({
    customer_email: "low@example.com", subject: "Q", body: "B", category: "other", priority: "low",
  });
  var hi = await ctx.tickets.open({
    customer_email: "high@example.com", subject: "Q", body: "B", category: "other", priority: "high",
  });
  var ur = await ctx.tickets.open({
    customer_email: "urgent@example.com", subject: "Q", body: "B", category: "other", priority: "urgent",
  });
  var no = await ctx.tickets.open({
    customer_email: "normal@example.com", subject: "Q", body: "B", category: "other",
  });

  // Assign one of each to op1; leave the others unassigned.
  await ctx.tickets.assign({ ticket_id: ur.id, operator_id: op1 });
  await ctx.tickets.assign({ ticket_id: hi.id, operator_id: op1 });
  // op2 gets the normal one.
  await ctx.tickets.assign({ ticket_id: no.id, operator_id: op2 });

  // listOpenAssignedTo orders urgent before high.
  var op1Queue = await ctx.tickets.listOpenAssignedTo(op1);
  check("listOpenAssignedTo lists op1's two tickets", op1Queue.length === 2);
  check("listOpenAssignedTo orders urgent first",     op1Queue[0].id === ur.id && op1Queue[1].id === hi.id);

  // Resolved tickets drop out of the queue.
  await ctx.tickets.transition({ ticket_id: hi.id, to_status: "in_progress" });
  await ctx.tickets.transition({ ticket_id: hi.id, to_status: "resolved"    });
  var op1After = await ctx.tickets.listOpenAssignedTo(op1);
  check("resolved tickets drop out of assigned queue", op1After.length === 1 && op1After[0].id === ur.id);

  // listUnassigned returns just `lo` since the others are assigned.
  var un = await ctx.tickets.listUnassigned();
  check("listUnassigned returns only the unassigned",  un.length === 1 && un[0].id === lo.id);

  // Priority filter narrows.
  var unLow  = await ctx.tickets.listUnassigned({ priority: "low" });
  var unHigh = await ctx.tickets.listUnassigned({ priority: "high" });
  check("listUnassigned priority=low matches",   unLow.length === 1 && unLow[0].id === lo.id);
  check("listUnassigned priority=high empty",    unHigh.length === 0);

  // Bad priority refused.
  await assert.rejects(ctx.tickets.listUnassigned({ priority: "bogus" }), /priority/);
  await assert.rejects(ctx.tickets.listOpenAssignedTo("not-a-uuid"),      /operator_id/);
}

async function _slaCheckThresholds() {
  var ctx = _setup();
  var query = ctx.query;

  // Helper: insert a fully-formed ticket row with a controlled
  // last_action_at so we don't have to wait real time for SLA
  // budgets to elapse. The primitive's SQL doesn't care about how
  // the row got there.
  async function _stamp(priority, lastActionAgoMs, status) {
    var id     = bShop.framework.uuid.v7();
    var openedAt = Date.now() - lastActionAgoMs;
    var emailHash = bShop.framework.crypto.namespaceHash(
      "support-ticket-email", "x-" + id + "@example.com"
    );
    await query(
      "INSERT INTO support_tickets " +
      "(id, customer_id, customer_email_hash, subject, body, category, status, " +
      " priority, order_id, assigned_operator_id, tags_json, opened_at, " +
      " first_response_at, last_action_at, resolved_at, closed_at) " +
      "VALUES (?1, NULL, ?2, 's', 'b', 'other', ?3, ?4, NULL, NULL, '[]', ?5, NULL, ?5, NULL, NULL)",
      [id, emailHash, status, priority, openedAt],
    );
    return id;
  }

  // urgent breaches at 1h (3,600,000 ms). Stamp one over, one under.
  var urgentBreached = await _stamp("urgent", 3700000, "in_progress");
  /* urgentFresh   */   await _stamp("urgent",  100000, "in_progress");
  // high breaches at 4h (14,400,000 ms).
  var highBreached   = await _stamp("high",   14500000, "in_progress");
  /* highFresh   */     await _stamp("high",    3600000, "in_progress");
  // normal breaches at 24h.
  var normalBreached = await _stamp("normal", 25 * 3600000, "waiting_customer");
  /* normalFresh */     await _stamp("normal", 23 * 3600000, "waiting_customer");
  // low breaches at 72h.
  var lowBreached    = await _stamp("low",    73 * 3600000, "in_progress");
  /* lowFresh    */     await _stamp("low",    71 * 3600000, "in_progress");
  // Resolved + closed tickets never breach even when stamped over budget.
  /* resolved */        await _stamp("urgent", 99999999, "resolved");
  /* closed   */        await _stamp("urgent", 99999999, "closed");

  var breaches = await ctx.tickets.slaCheck();
  var breachedIds = breaches.map(function (r) { return r.id; });
  check("slaCheck surfaces urgent breached",     breachedIds.indexOf(urgentBreached) !== -1);
  check("slaCheck surfaces high breached",       breachedIds.indexOf(highBreached)   !== -1);
  check("slaCheck surfaces normal breached",     breachedIds.indexOf(normalBreached) !== -1);
  check("slaCheck surfaces low breached",        breachedIds.indexOf(lowBreached)    !== -1);
  check("slaCheck returns exactly 4 breaches",   breaches.length === 4);
  check("slaCheck decorates with sla_budget_ms", breaches.every(function (r) { return typeof r.sla_budget_ms === "number"; }));
  check("slaCheck decorates with sla_elapsed_ms",breaches.every(function (r) { return typeof r.sla_elapsed_ms === "number" && r.sla_elapsed_ms > r.sla_budget_ms; }));
}

async function _metricsAggregation() {
  var ctx = _setup();

  // Open 4 tickets spread across categories.
  var t1 = await ctx.tickets.open({
    customer_email: "a@example.com", subject: "Q", body: "B", category: "order_issue",
  });
  var t2 = await ctx.tickets.open({
    customer_email: "b@example.com", subject: "Q", body: "B", category: "order_issue",
  });
  await ctx.tickets.open({
    customer_email: "c@example.com", subject: "Q", body: "B", category: "billing",
  });
  await ctx.tickets.open({
    customer_email: "d@example.com", subject: "Q", body: "B", category: "pre_sale",
  });
  await helpers.waitUntil(function () { return Date.now() > t1.opened_at; }, { timeoutMs: 5000, intervalMs: 2 });

  // Two tickets get an operator first-response.
  await ctx.tickets.reply({ ticket_id: t1.id, author: "operator", body: "On it." });
  await ctx.tickets.reply({ ticket_id: t2.id, author: "operator", body: "Investigating." });
  // One ticket resolves.
  await ctx.tickets.transition({ ticket_id: t1.id, to_status: "resolved" });
  // One ticket escalates: waiting_customer -> in_progress.
  await ctx.tickets.transition({ ticket_id: t2.id, to_status: "waiting_customer" });
  await ctx.tickets.transition({ ticket_id: t2.id, to_status: "in_progress"      });
  // Another escalation: resolved -> reopened.
  await ctx.tickets.transition({ ticket_id: t1.id, to_status: "reopened" });

  var from = t1.opened_at - 1;
  var to   = Date.now() + 1;
  var m = await ctx.tickets.metrics({ from: from, to: to });
  check("metrics returns opened_count",                m.opened_count === 4);
  check("metrics per_category order_issue=2",          m.per_category.order_issue === 2);
  check("metrics per_category billing=1",              m.per_category.billing === 1);
  check("metrics per_category pre_sale=1",             m.per_category.pre_sale === 1);
  check("metrics per_category zero buckets stay 0",    m.per_category.shipping === 0 && m.per_category.complaint === 0);
  check("metrics avg_first_response_ms is a number",   typeof m.avg_first_response_ms === "number");
  check("metrics avg_first_response_ms >= 0",          m.avg_first_response_ms >= 0);
  check("metrics resolution_rate = 1/4",               Math.abs(m.resolution_rate - 0.25) < 1e-9);
  check("metrics escalation_count = 2",                m.escalation_count === 2);
  check("metrics escalation_rate = 2/4",               Math.abs(m.escalation_rate - 0.5) < 1e-9);

  // Refusals.
  await assert.rejects(ctx.tickets.metrics(),                              /input object required/);
  await assert.rejects(ctx.tickets.metrics({ from: "x", to: 0 }),          /from/);
  await assert.rejects(ctx.tickets.metrics({ from: 10,  to: 5 }),          /from must be <= to/);
}

// listByCustomerId (keyed on customer_id, the path the subject-access
// export uses — it has no plaintext email for listForCustomer) returns
// { rows, next_cursor } and pages, so an export can drain a customer's
// COMPLETE ticket history instead of stopping at the first limit.
async function _listByCustomerIdPagination() {
  var ctx = _setup();
  var customerId = _validUUID();
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var t = await ctx.tickets.open({
      customer_id:    customerId,
      customer_email: "drain@example.com",
      subject:        "Drain " + i,
      body:           "Body " + i,
      category:       i % 2 === 0 ? "order_issue" : "billing",
    });
    ids.push(t.id);
    await helpers.waitUntil(function () { return true; }, { timeoutMs: 10, intervalMs: 2 });
  }
  // A ticket for a different customer_id must not leak into the page.
  await ctx.tickets.open({
    customer_id: _validUUID(), customer_email: "other@example.com",
    subject: "Other", body: "B", category: "other",
  });

  var page1 = await ctx.tickets.listByCustomerId(customerId, { limit: 2 });
  check("listByCustomerId page1 returns 2",            page1.rows.length === 2);
  check("listByCustomerId page1 emits a cursor",       typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  check("listByCustomerId page1 scoped to customer",   page1.rows.every(function (r) { return ids.indexOf(r.id) !== -1; }));

  // Drain to completion — the exact loop the DSR export runs.
  var drained = [];
  var cursor = null;
  do {
    var page = await ctx.tickets.listByCustomerId(customerId, cursor ? { limit: 2, cursor: cursor } : { limit: 2 });
    drained = drained.concat(page.rows);
    cursor = page.next_cursor;
  } while (cursor);
  check("listByCustomerId drains all 5 tickets",       drained.length === 5);
  check("listByCustomerId drain excludes other customer",
    drained.every(function (r) { return ids.indexOf(r.id) !== -1; }));
  var counts = {};
  drained.forEach(function (r) { counts[r.id] = (counts[r.id] || 0) + 1; });
  check("listByCustomerId drain has no duplicates",
    Object.keys(counts).length === 5 && Object.keys(counts).every(function (k) { return counts[k] === 1; }));
}

async function run() {
  await _openHappyPath();
  await _openRefusalClasses();
  await _replyFlipsStatus();
  await _internalNoteDoesNotStampFirstResponse();
  await _customerReplyReopensResolved();
  await _concurrentTagWritesAtomic();
  await _fsmTransitions();
  await _assignUnassign();
  await _tagCRUD();
  await _listForCustomerPagination();
  await _listByCustomerIdPagination();
  await _assignedAndUnassignedQueues();
  await _slaCheckThresholds();
  await _metricsAggregation();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/support-tickets.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — support-tickets (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — support-tickets: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
