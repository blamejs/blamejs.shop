"use strict";
/**
 * storefrontForms — operator-defined contact / lead-capture forms
 * with per-field validation, throttling, and email/webhook dispatch.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0076_storefront_forms.sql alone — the primitive has no FKs into
 * the rest of the schema.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/storefront-forms.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineForm happy path: persists every field; refuses bad slug,
 *     bad field kind, duplicate field name, select without options,
 *     bad submit_to shape (kind / value)
 *   - submit refuses missing required field; refuses unknown field
 *     name; aggregates field_validation errors
 *   - email-kind field validates via b.guardEmail; rejects garbage
 *   - throttle: per-session limit refuses over-limit submits, returns
 *     `throttled` error, no row written
 *   - submissionsForForm pagination: walks two pages with the cursor;
 *     newest-first ordering across the boundary
 *   - dispatch: email submit_to invokes injected notifications.enqueue;
 *     webhook submit_to invokes injected webhooks.send; absent dep
 *     leaves dispatched=false but row still persists
 *   - listForms / archiveForm / updateForm: archived forms hidden;
 *     update bumps fields/title and persists
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var storefrontForms = require("../../lib/storefront-forms");
var helpers         = require("../helpers");
var check           = helpers.check;
var assert          = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0076_storefront_forms.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// Notifications collector — captures every enqueue call. Mirrors the
// shape of the real notifications primitive's enqueue surface.
function _collectorNotifications() {
  var enqueued = [];
  return {
    enqueued: enqueued,
    enqueue: function (input) {
      enqueued.push(input);
      return Promise.resolve({ ok: true, id: "noti-" + enqueued.length });
    },
  };
}

// Webhooks collector — captures every send(event, payload) call.
function _collectorWebhooks(opts) {
  var sent  = [];
  var fail  = opts && opts.fail;
  return {
    sent: sent,
    send: function (event, payload) {
      sent.push({ event: event, payload: payload });
      if (fail) return Promise.reject(new Error("webhook send failed: simulated"));
      return Promise.resolve({ ok: true });
    },
  };
}

function _setup(extra) {
  var query = _makeQuery();
  extra = extra || {};
  var forms = storefrontForms.create({
    query:         query,
    notifications: extra.notifications || null,
    webhooks:      extra.webhooks      || null,
  });
  return { query: query, forms: forms };
}

// ---- defineForm happy path + refusals ----------------------------------

async function _defineFormHappy() {
  var ctx = _setup();
  var f = await ctx.forms.defineForm({
    slug:        "contact",
    title:       "Contact us",
    description: "Reach the team.",
    fields: [
      { name: "name",    kind: "text",     required: true,  label: "Your name" },
      { name: "email",   kind: "email",    required: true,  label: "Your email" },
      { name: "topic",   kind: "select",   required: true,  label: "Topic",
        options: ["sales", "support", "press"] },
      { name: "message", kind: "textarea", required: true,  label: "Message" },
      { name: "subscribe", kind: "checkbox", required: false, label: "Subscribe" },
      { name: "headcount", kind: "number",   required: false, label: "Team size" },
      { name: "phone",   kind: "phone",    required: false, label: "Phone" },
    ],
    submit_to:        { kind: "email", value: "ops@example.com" },
    success_message:  "Thanks — we'll get back to you.",
  });

  check("defineForm persists slug",          f.slug === "contact");
  check("defineForm persists title",         f.title === "Contact us");
  check("defineForm persists description",   f.description === "Reach the team.");
  check("defineForm persists fields count",  f.fields.length === 7);
  check("defineForm persists field order",   f.fields[0].name === "name" && f.fields[2].name === "topic");
  check("defineForm persists select opts",   f.fields[2].options[1] === "support");
  check("defineForm persists submit_to",     f.submit_to.kind === "email" && f.submit_to.value === "ops@example.com");
  check("defineForm persists success_msg",   f.success_message === "Thanks — we'll get back to you.");
  check("defineForm default throttle = 5",   f.throttle_per_minute_per_session === 5);
  check("defineForm archived_at null",       f.archived_at === null);
  check("defineForm stamps created_at",      typeof f.created_at === "number" && f.created_at > 0);
  check("defineForm updated_at = created_at", f.updated_at === f.created_at);

  // Webhook submit_to is also accepted.
  var f2 = await ctx.forms.defineForm({
    slug:  "webhook-only",
    title: "Webhook target",
    fields: [{ name: "msg", kind: "text", required: true, label: "Msg" }],
    submit_to: { kind: "webhook", value: "form.received" },
    success_message: "Got it.",
    throttle_per_minute_per_session: 0,
  });
  check("defineForm accepts webhook submit_to", f2.submit_to.kind === "webhook" && f2.submit_to.value === "form.received");
  check("defineForm throttle=0 persists",       f2.throttle_per_minute_per_session === 0);
}

async function _defineFormRefusals() {
  var ctx = _setup();

  // Missing input object.
  await assert.rejects(ctx.forms.defineForm(), /input object required/);

  // Bad slug shape.
  await assert.rejects(ctx.forms.defineForm({
    slug: "-bad", title: "x",
    fields: [{ name: "n", kind: "text", required: true, label: "L" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  }), /slug/);

  // Bad field kind.
  await assert.rejects(ctx.forms.defineForm({
    slug: "bad-kind", title: "x",
    fields: [{ name: "n", kind: "file", required: true, label: "L" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  }), /field kind must be one of/);

  // Duplicate field name.
  await assert.rejects(ctx.forms.defineForm({
    slug: "dup", title: "x",
    fields: [
      { name: "n", kind: "text", required: true, label: "A" },
      { name: "n", kind: "text", required: true, label: "B" },
    ],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  }), /duplicate field name/);

  // Select without options.
  await assert.rejects(ctx.forms.defineForm({
    slug: "no-opts", title: "x",
    fields: [{ name: "topic", kind: "select", required: true, label: "T" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  }), /options/);

  // submit_to kind missing.
  await assert.rejects(ctx.forms.defineForm({
    slug: "bad-st-kind", title: "x",
    fields: [{ name: "n", kind: "text", required: true, label: "L" }],
    submit_to: { kind: "sms", value: "+10000000000" },
    success_message: "ok",
  }), /submit_to\.kind/);

  // submit_to.value (email) garbage.
  await assert.rejects(ctx.forms.defineForm({
    slug: "bad-st-email", title: "x",
    fields: [{ name: "n", kind: "text", required: true, label: "L" }],
    submit_to: { kind: "email", value: "not-an-email" },
    success_message: "ok",
  }), /submit_to\.value/);

  // submit_to.value (webhook) bad event-name shape.
  await assert.rejects(ctx.forms.defineForm({
    slug: "bad-st-wh", title: "x",
    fields: [{ name: "n", kind: "text", required: true, label: "L" }],
    submit_to: { kind: "webhook", value: "Bad Event!" },
    success_message: "ok",
  }), /submit_to\.value/);

  // Empty fields array.
  await assert.rejects(ctx.forms.defineForm({
    slug: "no-fields", title: "x",
    fields: [],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  }), /fields must be a non-empty array/);
}

// ---- submit: required-field refusal + per-field validation -------------

async function _submitRequiredRefusal() {
  var notifications = _collectorNotifications();
  var ctx = _setup({ notifications: notifications });
  await ctx.forms.defineForm({
    slug:  "contact",
    title: "Contact",
    fields: [
      { name: "name",  kind: "text",  required: true,  label: "Name" },
      { name: "email", kind: "email", required: true,  label: "Email" },
      { name: "msg",   kind: "textarea", required: false, label: "Msg" },
    ],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  });

  // Missing required name + email.
  var r1 = await ctx.forms.submit({
    form_slug: "contact",
    values:    { msg: "Just a note." },
    session_id: "sess-1",
  });
  check("submit refuses missing required: ok=false",        r1.ok === false);
  check("submit refuses missing required: error",           r1.error === "field_validation");
  check("submit refuses missing required: name flagged",    r1.field_errors.name === "required");
  check("submit refuses missing required: email flagged",   r1.field_errors.email === "required");
  check("submit refuses missing required: no notifications", notifications.enqueued.length === 0);

  // Unknown field name refused.
  var r2 = await ctx.forms.submit({
    form_slug: "contact",
    values:    { name: "x", email: "x@example.com", surprise: "smuggled" },
    session_id: "sess-2",
  });
  check("submit refuses unknown field: ok=false",  r2.ok === false);
  check("submit refuses unknown field: error",     /unknown field/.test(r2.error));
}

async function _submitEmailValidation() {
  var notifications = _collectorNotifications();
  var ctx = _setup({ notifications: notifications });
  await ctx.forms.defineForm({
    slug:  "lead",
    title: "Lead",
    fields: [
      { name: "email", kind: "email", required: true,  label: "Email" },
      { name: "size",  kind: "number", required: false, label: "Team size" },
      { name: "ok",    kind: "checkbox", required: false, label: "Agree" },
    ],
    submit_to: { kind: "email", value: "leads@example.com" },
    success_message: "Thanks",
  });

  // Garbage email rejected.
  var bad = await ctx.forms.submit({
    form_slug: "lead",
    values:    { email: "not an email" },
    session_id: "s1",
  });
  check("submit rejects bad email: ok=false",                    bad.ok === false);
  check("submit rejects bad email: field_validation",            bad.error === "field_validation");
  check("submit rejects bad email: email field flagged",         typeof bad.field_errors.email === "string");

  // Number-string parsing + checkbox boolean.
  var good = await ctx.forms.submit({
    form_slug: "lead",
    values:    { email: "buyer@example.com", size: "12", ok: true },
    session_id: "s2",
  });
  check("submit accepts valid lead: ok=true",        good.ok === true);
  check("submit dispatches via notifications",       notifications.enqueued.length === 1);
  check("submit dispatches with cleaned email",      notifications.enqueued[0].payload.values.email === "buyer@example.com");
  check("submit parses numeric string to number",    notifications.enqueued[0].payload.values.size === 12);
  check("submit carries checkbox bool",              notifications.enqueued[0].payload.values.ok === true);

  // Non-numeric "12abc" rejected.
  var badN = await ctx.forms.submit({
    form_slug: "lead",
    values:    { email: "ok@example.com", size: "12abc" },
    session_id: "s3",
  });
  check("submit rejects non-numeric string: ok=false", badN.ok === false);
  check("submit rejects non-numeric string: error",    typeof badN.field_errors.size === "string");
}

// ---- throttle limit refusal --------------------------------------------

async function _submitThrottle() {
  var notifications = _collectorNotifications();
  var ctx = _setup({ notifications: notifications });
  await ctx.forms.defineForm({
    slug:  "tight",
    title: "Tight",
    fields: [
      { name: "msg", kind: "text", required: true, label: "Msg" },
    ],
    submit_to:                        { kind: "email", value: "ops@example.com" },
    success_message:                  "ok",
    throttle_per_minute_per_session:  2,
  });

  var s = "throttle-session-1";
  var a = await ctx.forms.submit({ form_slug: "tight", values: { msg: "one" },   session_id: s });
  var b = await ctx.forms.submit({ form_slug: "tight", values: { msg: "two" },   session_id: s });
  var c = await ctx.forms.submit({ form_slug: "tight", values: { msg: "three" }, session_id: s });

  check("submit #1 ok",         a.ok === true);
  check("submit #2 ok",         b.ok === true);
  check("submit #3 throttled",  c.ok === false && c.error === "throttled");
  check("submit #3 reports limit", c.limit === 2);
  check("submit #3 reports count", c.count === 2);

  // No row was persisted for the throttled submit.
  var p1 = await ctx.forms.submissionsForForm({ form_slug: "tight" });
  check("throttled submit did not persist", p1.items.length === 2);

  // throttleCheck reports the same state directly.
  var t = await ctx.forms.throttleCheck({ form_slug: "tight", session_id: s });
  check("throttleCheck reports over-limit", t.ok === false && t.error === "throttled");

  // A different session is independent.
  var d = await ctx.forms.submit({ form_slug: "tight", values: { msg: "fresh" }, session_id: "other" });
  check("different session not throttled", d.ok === true);

  // Form with throttle=0 never throttles.
  await ctx.forms.defineForm({
    slug:  "open",
    title: "Open",
    fields: [{ name: "msg", kind: "text", required: true, label: "Msg" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
    throttle_per_minute_per_session: 0,
  });
  for (var i = 0; i < 5; i += 1) {
    var r = await ctx.forms.submit({ form_slug: "open", values: { msg: "x" + i }, session_id: "open-s" });
    check("open form submit #" + i + " ok", r.ok === true);
  }
}

// ---- submissionsForForm pagination -------------------------------------

async function _submissionsPagination() {
  var ctx = _setup({ notifications: _collectorNotifications() });
  await ctx.forms.defineForm({
    slug:  "list",
    title: "List",
    fields: [{ name: "n", kind: "number", required: true, label: "n" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
    throttle_per_minute_per_session: 0,
  });

  // Write 5 submissions; force created_at advance between rows via
  // waitUntil so the DESC ordering is unambiguous on a fast runner.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var r = await ctx.forms.submit({ form_slug: "list", values: { n: i }, session_id: "page-s" });
    ids.push(r.id);
    await helpers.waitUntil(function (snapshot) {
      return function () { return Date.now() > snapshot; };
    }(Date.now()), { label: "wall-clock advance between submissions" });
  }
  check("recorded 5 ids", ids.length === 5);

  // Page 1 — first 2 items, newest-first (so submission #4 is first).
  var p1 = await ctx.forms.submissionsForForm({ form_slug: "list", limit: 2 });
  check("page1 returns 2 items",            p1.items.length === 2);
  check("page1 newest-first",               p1.items[0].id === ids[4] && p1.items[1].id === ids[3]);
  check("page1 has next_cursor",            typeof p1.next_cursor === "string" && p1.next_cursor.length > 0);
  check("page1 hydrates values",            p1.items[0].values.n === 4);

  // Page 2.
  var p2 = await ctx.forms.submissionsForForm({ form_slug: "list", limit: 2, cursor: p1.next_cursor });
  check("page2 returns 2 items",            p2.items.length === 2);
  check("page2 ids correct",                p2.items[0].id === ids[2] && p2.items[1].id === ids[1]);
  check("page2 has next_cursor",            typeof p2.next_cursor === "string" && p2.next_cursor.length > 0);

  // Page 3 — only one row left.
  var p3 = await ctx.forms.submissionsForForm({ form_slug: "list", limit: 2, cursor: p2.next_cursor });
  check("page3 returns 1 item",             p3.items.length === 1);
  check("page3 id correct",                 p3.items[0].id === ids[0]);
  check("page3 has no next_cursor",         p3.next_cursor === null);
}

// ---- dispatch behavior: email + webhook + missing dep ------------------

async function _dispatch() {
  // Email dispatch via injected notifications collector.
  var notifications = _collectorNotifications();
  var ctxE = _setup({ notifications: notifications });
  await ctxE.forms.defineForm({
    slug:  "to-email",
    title: "To email",
    fields: [{ name: "msg", kind: "text", required: true, label: "Msg" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "Thanks",
    throttle_per_minute_per_session: 0,
  });
  var rE = await ctxE.forms.submit({
    form_slug: "to-email",
    values:    { msg: "hello" },
    session_id: "e-1",
  });
  check("email dispatch: ok",                rE.ok === true);
  check("email dispatch: dispatched=true",   rE.dispatched === true);
  check("email dispatch: recipient",         notifications.enqueued[0].recipient_id === "ops@example.com");
  check("email dispatch: channel",           notifications.enqueued[0].channel === "email");
  check("email dispatch: event_type",        notifications.enqueued[0].event_type === "storefront.form_submission");
  check("email dispatch: payload msg",       notifications.enqueued[0].payload.values.msg === "hello");
  check("email dispatch: success_message",   rE.success_message === "Thanks");

  // Verify the persisted row stamped dispatched_at.
  var rowsE = await ctxE.forms.submissionsForForm({ form_slug: "to-email" });
  check("email dispatch: row dispatched_at stamped", rowsE.items[0].dispatched_at !== null);
  check("email dispatch: row dispatch_error null",   rowsE.items[0].dispatch_error === null);

  // Webhook dispatch via injected webhooks collector.
  var webhooks = _collectorWebhooks();
  var ctxW = _setup({ webhooks: webhooks });
  await ctxW.forms.defineForm({
    slug:  "to-webhook",
    title: "To webhook",
    fields: [{ name: "msg", kind: "text", required: true, label: "Msg" }],
    submit_to: { kind: "webhook", value: "form.received" },
    success_message: "ok",
    throttle_per_minute_per_session: 0,
  });
  var rW = await ctxW.forms.submit({
    form_slug: "to-webhook",
    values:    { msg: "via-hook" },
    session_id: "w-1",
  });
  check("webhook dispatch: ok",              rW.ok === true);
  check("webhook dispatch: dispatched=true", rW.dispatched === true);
  check("webhook dispatch: event name",      webhooks.sent[0].event === "form.received");
  check("webhook dispatch: payload msg",     webhooks.sent[0].payload.values.msg === "via-hook");
  check("webhook dispatch: submission id",   webhooks.sent[0].payload.submission_id === rW.id);

  // Webhook dispatch that THROWS: row still persists, dispatch_error
  // stamped, ok=true (the submission landed; the operator sees the
  // failed dispatch on review).
  var failing = _collectorWebhooks({ fail: true });
  var ctxF = _setup({ webhooks: failing });
  await ctxF.forms.defineForm({
    slug:  "to-failing",
    title: "Failing",
    fields: [{ name: "msg", kind: "text", required: true, label: "Msg" }],
    submit_to: { kind: "webhook", value: "form.failed" },
    success_message: "ok",
    throttle_per_minute_per_session: 0,
  });
  var rF = await ctxF.forms.submit({
    form_slug: "to-failing",
    values:    { msg: "won't reach" },
    session_id: "f-1",
  });
  check("failing dispatch: ok=true (row landed)",         rF.ok === true);
  check("failing dispatch: dispatched=false",             rF.dispatched === false);
  check("failing dispatch: dispatch_error stamped",       typeof rF.dispatch_error === "string");
  var rowsF = await ctxF.forms.submissionsForForm({ form_slug: "to-failing" });
  check("failing dispatch: row persisted with error",     rowsF.items[0].dispatch_error !== null);
  check("failing dispatch: row dispatched_at null",       rowsF.items[0].dispatched_at === null);

  // No dep wired — row persists, dispatched=false, no error stamped.
  var ctxN = _setup({});
  await ctxN.forms.defineForm({
    slug:  "no-dep",
    title: "No dep",
    fields: [{ name: "msg", kind: "text", required: true, label: "Msg" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
    throttle_per_minute_per_session: 0,
  });
  var rN = await ctxN.forms.submit({
    form_slug: "no-dep",
    values:    { msg: "noop" },
    session_id: "n-1",
  });
  check("no-dep: ok=true",            rN.ok === true);
  check("no-dep: dispatched=false",   rN.dispatched === false);
  check("no-dep: no dispatch_error",  rN.dispatch_error === null);
}

// ---- listForms / archiveForm / updateForm ------------------------------

async function _listArchiveUpdate() {
  var ctx = _setup();
  await ctx.forms.defineForm({
    slug:  "alpha",
    title: "Alpha",
    fields: [{ name: "m", kind: "text", required: true, label: "M" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  });
  await ctx.forms.defineForm({
    slug:  "beta",
    title: "Beta",
    fields: [{ name: "m", kind: "text", required: true, label: "M" }],
    submit_to: { kind: "email", value: "ops@example.com" },
    success_message: "ok",
  });
  var listed = await ctx.forms.listForms();
  check("listForms returns 2 rows",     listed.length === 2);
  check("listForms creation-ordered",   listed[0].slug === "alpha" && listed[1].slug === "beta");

  // archiveForm hides the row from listForms but getForm still
  // resolves.
  var archived = await ctx.forms.archiveForm("alpha");
  check("archiveForm stamps archived_at",   typeof archived.archived_at === "number" && archived.archived_at > 0);
  var listed2 = await ctx.forms.listForms();
  check("listForms excludes archived",      listed2.length === 1 && listed2[0].slug === "beta");
  var direct = await ctx.forms.getForm("alpha");
  check("getForm still resolves archived",  direct && direct.archived_at !== null);

  // archiveForm idempotent on already-archived row.
  var archAgain = await ctx.forms.archiveForm("alpha");
  check("archiveForm idempotent",           archAgain.slug === "alpha");

  // updateForm patches title + fields.
  var updated = await ctx.forms.updateForm("beta", {
    title: "Beta v2",
    fields: [
      { name: "m",     kind: "text",     required: true,  label: "M" },
      { name: "extra", kind: "checkbox", required: false, label: "Extra" },
    ],
  });
  check("updateForm patches title",     updated.title === "Beta v2");
  check("updateForm patches fields",    updated.fields.length === 2 && updated.fields[1].name === "extra");
  check("updateForm preserves slug",    updated.slug === "beta");

  // updateForm refuses unsupported column.
  await assert.rejects(ctx.forms.updateForm("beta", { slug: "renamed" }), /unsupported column/);

  // updateForm refuses empty patch.
  await assert.rejects(ctx.forms.updateForm("beta", {}), /at least one column/);

  // updateForm refuses unknown slug.
  await assert.rejects(ctx.forms.updateForm("ghost", { title: "x" }), /not found/);

  // Submission against archived form refused.
  var rArch = await ctx.forms.submit({
    form_slug: "alpha",
    values:    { m: "ignored" },
    session_id: "arch-s",
  });
  check("submit against archived returns ok=false",  rArch.ok === false);
  check("submit against archived returns 'archived'", rArch.error === "archived");
}

async function run() {
  await _defineFormHappy();
  await _defineFormRefusals();
  await _submitRequiredRefusal();
  await _submitEmailValidation();
  await _submitThrottle();
  await _submissionsPagination();
  await _dispatch();
  await _listArchiveUpdate();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/storefront-forms.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("storefront-forms: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
