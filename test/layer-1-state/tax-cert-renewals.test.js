"use strict";
/**
 * taxCertRenewals — exemption-certificate renewal scheduler.
 *
 * Layer 1 against in-memory node:sqlite loaded from:
 *   0027_tax_exempt_certs.sql — taxExempt rows the scanner consumes
 *   0145_tax_cert_renewals.sql — schedule + reminder ledgers
 *
 * Direct require of `lib/tax-cert-renewals.js` — the primitive isn't
 * wired into `lib/index.js` yet; this test gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineSchedule: upserts, validates jurisdiction + cadence,
 *     un-archives on re-define
 *   - scanAndEnqueue: picks approved certs whose expires_at lands in
 *     the lead-time window and writes queued rows
 *   - scanAndEnqueue: monotonic-clock — same-ms re-scan bumps
 *     created_at by +1 so the per-(cert,channel) sequence stays
 *     strictly increasing
 *   - scanAndEnqueue: skips when an open (queued/sent) row already
 *     exists for (cert, channel)
 *   - scanAndEnqueue: notifications opt-out short-circuits the row
 *     write and counts toward skipped_opted_out
 *   - recordReminderSent FSM: queued -> sent
 *   - markEscalated: only against a sent row, refuses when the
 *     schedule has no escalate_after_days policy
 *   - markRenewed: closes every open row (queued/sent/escalated) for
 *     the cert in one shot
 *   - markExpired: closes open rows when no renewal arrived
 *   - metricsForSchedule: rate math (renewal_rate / escalation_rate /
 *     expiry_rate) over a window
 *   - listSchedules + archiveSchedule
 *   - validation: bad jurisdiction, bad lead_time_days, missing
 *     reminder_template_slug, bad escalate_after_days, bad uuid
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var taxCertRenewals = require("../../lib/tax-cert-renewals");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIGS = [
  "0027_tax_exempt_certs.sql",
  "0145_tax_cert_renewals.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

var DAY_MS = 86400000;

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
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _newUuid() { return bShop.framework.uuid.v7(); }

// Seed an approved tax-exempt certificate directly through SQL — the
// scanner reads the table verbatim, so no need to compose the real
// taxExempt factory for the fixture.
function _seedCert(db, opts) {
  opts = opts || {};
  var id          = opts.id          || _newUuid();
  var customerId  = opts.customer_id || _newUuid();
  var jurisdiction = opts.jurisdiction || "US-CA";
  var expiresAt   = opts.expires_at;
  var status      = opts.status      || "approved";
  var certNumber  = opts.certificate_number || ("CERT-" + id.slice(0, 8));
  var issuedAt    = opts.issued_at   || (Date.now() - 365 * DAY_MS);
  var ts          = opts.created_at  || Date.now();
  db.prepare(
    "INSERT INTO tax_exempt_certificates " +
    "(id, customer_id, certificate_type, jurisdiction, certificate_number, " +
    " certificate_number_hash, legal_name, issued_at, expires_at, status, " +
    " notes, created_at, updated_at) " +
    "VALUES (?, ?, 'resale', ?, ?, ?, 'Acme LLC', ?, ?, ?, '', ?, ?)"
  ).run(id, customerId, jurisdiction, certNumber, "hash-" + id, issuedAt, expiresAt, status, ts, ts);
  return { id: id, customer_id: customerId, jurisdiction: jurisdiction, expires_at: expiresAt };
}

function _stubNotifications(opts) {
  opts = opts || {};
  var optedOut = opts.optedOut || {};   // key: recipient_id|channel -> bool
  var calls = [];
  return {
    enqueue: async function (input) {
      calls.push(input);
      var key = input.recipient_id + "|" + input.channel;
      if (optedOut[key]) {
        return { ok: false, error: "opted-out" };
      }
      return { ok: true, id: _newUuid(), scheduled_at: input.scheduled_at };
    },
    calls: calls,
  };
}

function _factory(opts) {
  opts = opts || {};
  var h = _makeQuery();
  var notifications = opts.notifications;
  var tcr = taxCertRenewals.create({
    query:         h.query,
    notifications: notifications || null,
  });
  return { db: h.db, query: h.query, tcr: tcr, notifications: notifications };
}

// ---- tests --------------------------------------------------------------

async function _factoryExports() {
  check("module exports create",   typeof taxCertRenewals.create === "function");
  check("module exports STATUSES", Array.isArray(taxCertRenewals.STATUSES) && taxCertRenewals.STATUSES.length === 5);

  var f = _factory();
  [
    "defineSchedule", "scanAndEnqueue", "recordReminderSent", "markEscalated",
    "markRenewed", "markExpired", "certificationsDueSoon", "metricsForSchedule",
    "listSchedules", "archiveSchedule", "listRemindersForCert",
  ].forEach(function (m) {
    check("factory exports " + m, typeof f.tcr[m] === "function");
  });
}

async function _defineSchedule() {
  var f = _factory();

  var s1 = await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "tax-cert-renewal-us-ca",
    escalate_after_days:    14,
  });
  check("defineSchedule returns row",          s1 && s1.jurisdiction === "US-CA");
  check("defineSchedule persists lead_time",   s1.lead_time_days === 60);
  check("defineSchedule persists slug",        s1.reminder_template_slug === "tax-cert-renewal-us-ca");
  check("defineSchedule persists escalate",    s1.escalate_after_days === 14);
  check("defineSchedule archived_at null",     s1.archived_at == null);

  // Re-define upserts.
  var s2 = await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         90,
    reminder_template_slug: "tax-cert-renewal-us-ca-v2",
    escalate_after_days:    null,
  });
  check("re-define updates lead_time",         s2.lead_time_days === 90);
  check("re-define updates slug",              s2.reminder_template_slug === "tax-cert-renewal-us-ca-v2");
  check("re-define clears escalate",           s2.escalate_after_days == null);

  // archiveSchedule then re-define = un-archive.
  var arch = await f.tcr.archiveSchedule("US-CA");
  check("archiveSchedule stamps archived_at",  typeof arch.archived_at === "number" && arch.archived_at > 0);

  var s3 = await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         30,
    reminder_template_slug: "tax-cert-renewal-us-ca-v3",
  });
  check("re-define un-archives",               s3.archived_at == null);
  check("re-define accepts omitted escalate",  s3.escalate_after_days == null);
}

async function _scanAndEnqueuePicksExpiringCerts() {
  var notif = _stubNotifications();
  var f = _factory({ notifications: notif });

  var now = Date.now();
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "tax-cert-renewal-us-ca",
    escalate_after_days:    14,
  });

  // In-window cert.
  var caInWindow = _seedCert(f.db, {
    jurisdiction: "US-CA",
    expires_at:   now + 30 * DAY_MS,
  });
  // Out-of-window cert (expiry beyond lead time).
  _seedCert(f.db, {
    jurisdiction: "US-CA",
    expires_at:   now + 120 * DAY_MS,
  });
  // Past-expiry cert (should not be picked up — the row is past now,
  // not in the forward window).
  _seedCert(f.db, {
    jurisdiction: "US-CA",
    expires_at:   now - 5 * DAY_MS,
  });
  // Different jurisdiction without a schedule.
  _seedCert(f.db, {
    jurisdiction: "US-NY",
    expires_at:   now + 20 * DAY_MS,
  });
  // Pending-review cert in window — must not enqueue.
  _seedCert(f.db, {
    jurisdiction: "US-CA",
    expires_at:   now + 20 * DAY_MS,
    status:       "pending-review",
  });
  // No-expiry cert — undefined expires_at means never expires.
  _seedCert(f.db, {
    jurisdiction: "US-CA",
    expires_at:   null,
  });

  var res = await f.tcr.scanAndEnqueue({ now: now });
  check("scanAndEnqueue picks exactly the in-window approved cert", res.enqueued === 1);
  check("notifications.enqueue called once",                        notif.calls.length === 1);
  check("notification carried cert_id",                             notif.calls[0].payload.cert_id === caInWindow.id);
  check("notification jurisdiction matches",                        notif.calls[0].payload.jurisdiction === "US-CA");

  var rows = await f.tcr.listRemindersForCert(caInWindow.id);
  check("reminder row written",                                     rows.length === 1);
  check("reminder row queued",                                      rows[0].status === "queued");
  check("reminder row channel default = email",                     rows[0].channel === "email");
  check("reminder row jurisdiction",                                rows[0].jurisdiction === "US-CA");

  // Idempotent — re-scan does not re-enqueue while the row is open.
  var second = await f.tcr.scanAndEnqueue({ now: now });
  check("re-scan enqueues zero (open row exists)",                  second.enqueued === 0);
  check("re-scan reports skipped_existing == 1",                    second.skipped_existing === 1);
}

async function _scanAndEnqueueMonotonicClock() {
  // Two scans at the same ms wallclock should still produce strictly-
  // increasing reminder created_at values for the same (cert, channel).
  // First scan writes row at `now`. We then flip the first reminder to
  // a closed state so the next scan is allowed to write a new row, run
  // the scan AGAIN at the same `now` — the new row's created_at must
  // be > the prior row's, regardless of `now` equality.
  var f = _factory();
  var now = Date.now();
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "slug",
  });
  var c = _seedCert(f.db, { jurisdiction: "US-CA", expires_at: now + 10 * DAY_MS });

  await f.tcr.scanAndEnqueue({ now: now });
  var rows1 = await f.tcr.listRemindersForCert(c.id);
  check("first scan writes 1 row",                  rows1.length === 1);
  var firstTs = rows1[0].created_at;

  // Close the first reminder so the scanner is allowed to write again.
  await f.tcr.markExpired({ cert_id: c.id, ts: now + 1 });

  await f.tcr.scanAndEnqueue({ now: now });
  var rows2 = await f.tcr.listRemindersForCert(c.id);
  check("second scan writes a new row",             rows2.length === 2);
  // Order by created_at — confirm the second row's ts is strictly > first.
  var sorted = rows2.slice().sort(function (a, b) { return a.created_at - b.created_at; });
  check("monotonic-clock bumps tied created_at",    sorted[1].created_at > sorted[0].created_at);
  check("first row preserved",                      sorted[0].created_at === firstTs);
}

async function _scanAndEnqueueOptedOut() {
  // Notifications opt-out short-circuits the row write.
  var caCustomer = _newUuid();
  var notif = _stubNotifications({
    optedOut: { [caCustomer + "|email"]: true },
  });
  var f = _factory({ notifications: notif });

  var now = Date.now();
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "slug",
  });
  _seedCert(f.db, {
    customer_id:  caCustomer,
    jurisdiction: "US-CA",
    expires_at:   now + 30 * DAY_MS,
  });
  // A separate cert whose customer is opted-in.
  _seedCert(f.db, {
    jurisdiction: "US-CA",
    expires_at:   now + 30 * DAY_MS,
  });

  var res = await f.tcr.scanAndEnqueue({ now: now });
  check("opted-out cert does not enqueue",          res.enqueued === 1);
  check("skipped_opted_out reports the refusal",    res.skipped_opted_out === 1);
}

async function _recordReminderSentFSM() {
  var f = _factory();
  var now = Date.now();
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "slug",
  });
  var c = _seedCert(f.db, { jurisdiction: "US-CA", expires_at: now + 10 * DAY_MS });
  await f.tcr.scanAndEnqueue({ now: now });

  // No queued reminder for a fake cert — refuse.
  var nope = await f.tcr.recordReminderSent({ cert_id: _newUuid(), channel: "email" });
  check("recordReminderSent refuses unknown cert",   nope.ok === false && nope.error === "no-queued-reminder");

  // Wrong channel for a real cert — refuse.
  var wrong = await f.tcr.recordReminderSent({ cert_id: c.id, channel: "webhook" });
  check("recordReminderSent refuses wrong channel",  wrong.ok === false);

  // Happy path: queued -> sent.
  var ok = await f.tcr.recordReminderSent({ cert_id: c.id, channel: "email", ts: now + 5000 });
  check("recordReminderSent ok",                     ok.ok === true && ok.sent_at === now + 5000);

  var rows = await f.tcr.listRemindersForCert(c.id);
  check("row status sent",                           rows[0].status === "sent");
  check("row sent_at stamped",                       rows[0].sent_at === now + 5000);

  // Cannot re-send (no queued row left).
  var again = await f.tcr.recordReminderSent({ cert_id: c.id, channel: "email" });
  check("re-send refuses (no queued row)",           again.ok === false);
}

async function _escalateAfterThreshold() {
  var f = _factory();
  var now = Date.now();

  // Schedule with escalation policy.
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "slug",
    escalate_after_days:    14,
  });
  // Schedule without escalation policy.
  await f.tcr.defineSchedule({
    jurisdiction:           "US-NY",
    lead_time_days:         60,
    reminder_template_slug: "slug-ny",
  });

  var caCert = _seedCert(f.db, { jurisdiction: "US-CA", expires_at: now + 30 * DAY_MS });
  var nyCert = _seedCert(f.db, { jurisdiction: "US-NY", expires_at: now + 30 * DAY_MS });
  await f.tcr.scanAndEnqueue({ now: now });

  // Cannot escalate while still queued.
  var queued = await f.tcr.markEscalated({ cert_id: caCert.id, escalated_to: "ops@example.com" });
  check("markEscalated refuses queued",              queued.ok === false && queued.error === "no-sent-reminder");

  await f.tcr.recordReminderSent({ cert_id: caCert.id, channel: "email", ts: now + 1000 });
  await f.tcr.recordReminderSent({ cert_id: nyCert.id, channel: "email", ts: now + 1000 });

  // NY schedule has no escalate policy — refuse.
  var noPolicy = await f.tcr.markEscalated({ cert_id: nyCert.id, escalated_to: "ops@example.com" });
  check("markEscalated refuses without policy",      noPolicy.ok === false && noPolicy.error === "no-escalation-policy");

  // CA escalation happy path.
  var esc = await f.tcr.markEscalated({
    cert_id:      caCert.id,
    escalated_to: "account-manager@example.com",
    ts:           now + 15 * DAY_MS,
  });
  check("markEscalated ok",                          esc.ok === true);

  var rows = await f.tcr.listRemindersForCert(caCert.id);
  check("row status escalated",                      rows[0].status === "escalated");
  check("escalated_at stamped",                      rows[0].escalated_at === now + 15 * DAY_MS);
  check("escalated_to stored",                       rows[0].escalated_to === "account-manager@example.com");

  // Validation: bad escalated_to.
  await assert.rejects(
    f.tcr.markEscalated({ cert_id: caCert.id, escalated_to: "" }),
    /escalated_to/,
  );
  await assert.rejects(
    f.tcr.markEscalated({ cert_id: caCert.id, escalated_to: "x\nsmuggle" }),
    /escalated_to/,
  );
}

async function _markRenewedClosesLoop() {
  var f = _factory();
  var now = Date.now();
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "slug",
    escalate_after_days:    14,
  });

  // Multi-channel scan to produce two open reminders for the same cert.
  var c = _seedCert(f.db, { jurisdiction: "US-CA", expires_at: now + 10 * DAY_MS });
  var scan = await f.tcr.scanAndEnqueue({ now: now, channels: ["email", "in-app"] });
  check("multi-channel scan writes 2 rows",          scan.enqueued === 2);

  // Send one channel, leave the other queued.
  await f.tcr.recordReminderSent({ cert_id: c.id, channel: "email", ts: now + 1000 });

  var newExpiry = now + 365 * DAY_MS;
  var res = await f.tcr.markRenewed({
    cert_id:    c.id,
    new_expiry: newExpiry,
    ts:         now + 2000,
  });
  check("markRenewed closes both rows",              res.ok === true && res.closed === 2);

  var rows = await f.tcr.listRemindersForCert(c.id);
  check("all rows now renewed",                      rows.every(function (r) { return r.status === "renewed"; }));
  check("renewed_at stamped on all rows",            rows.every(function (r) { return r.renewed_at === now + 2000; }));
  check("new_expiry stamped on all rows",            rows.every(function (r) { return r.new_expiry === newExpiry; }));

  // Subsequent markRenewed is a no-op (closed: 0).
  var second = await f.tcr.markRenewed({
    cert_id:    c.id,
    new_expiry: newExpiry + DAY_MS,
    ts:         now + 3000,
  });
  check("second markRenewed reports zero closed",    second.ok === true && second.closed === 0);
}

async function _markExpiredCloses() {
  var f = _factory();
  var now = Date.now();
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "slug",
    escalate_after_days:    14,
  });

  var c = _seedCert(f.db, { jurisdiction: "US-CA", expires_at: now + 10 * DAY_MS });
  await f.tcr.scanAndEnqueue({ now: now });
  await f.tcr.recordReminderSent({ cert_id: c.id, channel: "email", ts: now + 1000 });

  var res = await f.tcr.markExpired({ cert_id: c.id, ts: now + 30 * DAY_MS });
  check("markExpired closes the row",                res.ok === true && res.closed === 1);

  var rows = await f.tcr.listRemindersForCert(c.id);
  check("row status expired",                        rows[0].status === "expired");
  check("expired_at stamped",                        rows[0].expired_at === now + 30 * DAY_MS);
}

async function _metricsRateMath() {
  var f = _factory();
  var windowStart = Date.now() - 7 * DAY_MS;
  var windowEnd   = Date.now() + 7 * DAY_MS;

  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "slug",
    escalate_after_days:    14,
  });

  // Build a fixture: 10 reminders for 10 different certs, distributed
  // across statuses to make the rate math obvious.
  //   1 queued, 2 sent, 1 escalated, 3 renewed, 3 expired
  var statuses = [
    "queued",
    "sent", "sent",
    "escalated",
    "renewed", "renewed", "renewed",
    "expired", "expired", "expired",
  ];
  var t = Date.now();
  for (var i = 0; i < statuses.length; i += 1) {
    var id = _newUuid();
    var ts = t + i;
    f.db.prepare(
      "INSERT INTO tax_cert_renewal_reminders " +
      "(id, cert_id, jurisdiction, channel, status, created_at) " +
      "VALUES (?, ?, 'US-CA', 'email', ?, ?)"
    ).run(id, _newUuid(), statuses[i], ts);
  }

  // Out-of-window row — must NOT be counted.
  f.db.prepare(
    "INSERT INTO tax_cert_renewal_reminders " +
    "(id, cert_id, jurisdiction, channel, status, created_at) " +
    "VALUES (?, ?, 'US-CA', 'email', 'renewed', ?)"
  ).run(_newUuid(), _newUuid(), windowEnd + 10 * DAY_MS);

  // Different-jurisdiction row — must NOT be counted.
  f.db.prepare(
    "INSERT INTO tax_cert_renewal_reminders " +
    "(id, cert_id, jurisdiction, channel, status, created_at) " +
    "VALUES (?, ?, 'US-NY', 'email', 'renewed', ?)"
  ).run(_newUuid(), _newUuid(), t);

  var m = await f.tcr.metricsForSchedule({
    jurisdiction: "US-CA",
    from:         windowStart,
    to:           windowEnd,
  });
  check("metrics total is 10",                       m.total === 10);
  check("metrics counts.queued = 1",                 m.counts.queued === 1);
  check("metrics counts.sent = 2",                   m.counts.sent === 2);
  check("metrics counts.escalated = 1",              m.counts.escalated === 1);
  check("metrics counts.renewed = 3",                m.counts.renewed === 3);
  check("metrics counts.expired = 3",                m.counts.expired === 3);
  check("metrics renewal_rate = 0.3",                Math.abs(m.renewal_rate - 0.3) < 1e-9);
  check("metrics escalation_rate = 0.1",             Math.abs(m.escalation_rate - 0.1) < 1e-9);
  check("metrics expiry_rate = 0.3",                 Math.abs(m.expiry_rate - 0.3) < 1e-9);
  // send_rate = (sent + escalated + renewed + expired) / total = 9/10
  check("metrics send_rate = 0.9",                   Math.abs(m.send_rate - 0.9) < 1e-9);

  // Empty-window guard.
  var empty = await f.tcr.metricsForSchedule({
    jurisdiction: "US-CA",
    from:         windowEnd + 100 * DAY_MS,
    to:           windowEnd + 110 * DAY_MS,
  });
  check("empty window total = 0",                    empty.total === 0);
  check("empty window renewal_rate = 0",             empty.renewal_rate === 0);
  check("empty window send_rate = 0",                empty.send_rate === 0);
}

async function _listAndArchiveSchedules() {
  var f = _factory();
  await f.tcr.defineSchedule({
    jurisdiction:           "US-CA",
    lead_time_days:         60,
    reminder_template_slug: "ca",
  });
  await f.tcr.defineSchedule({
    jurisdiction:           "US-NY",
    lead_time_days:         30,
    reminder_template_slug: "ny",
  });
  await f.tcr.defineSchedule({
    jurisdiction:           "EU-DE",
    lead_time_days:         90,
    reminder_template_slug: "de",
  });

  var all = await f.tcr.listSchedules();
  check("listSchedules returns 3",                   all.length === 3);
  check("listSchedules ordered by jurisdiction",     all[0].jurisdiction === "EU-DE" && all[2].jurisdiction === "US-NY");

  await f.tcr.archiveSchedule("US-NY");
  var active = await f.tcr.listSchedules();
  check("listSchedules excludes archived by default", active.length === 2);

  var inclArch = await f.tcr.listSchedules({ include_archived: true });
  check("include_archived returns 3",                inclArch.length === 3);

  var oneJurisdiction = await f.tcr.listSchedules({ jurisdiction: "US-CA" });
  check("jurisdiction filter narrows",               oneJurisdiction.length === 1 && oneJurisdiction[0].jurisdiction === "US-CA");

  // Archiving a non-existent schedule returns null.
  var nope = await f.tcr.archiveSchedule("AU");
  check("archiveSchedule unknown jurisdiction null", nope === null);
}

async function _certificationsDueSoon() {
  var f = _factory();
  var now = Date.now();
  var customer = _newUuid();
  var c1 = _seedCert(f.db, { customer_id: customer, jurisdiction: "US-CA", expires_at: now + 10 * DAY_MS });
  var c2 = _seedCert(f.db, { customer_id: customer, jurisdiction: "US-NY", expires_at: now + 45 * DAY_MS });
  _seedCert(f.db, { customer_id: customer, jurisdiction: "US-TX", expires_at: now + 200 * DAY_MS });
  // pending-review must not surface.
  _seedCert(f.db, { customer_id: customer, jurisdiction: "EU-DE", expires_at: now + 5 * DAY_MS, status: "pending-review" });

  var all = await f.tcr.certificationsDueSoon({
    from: now,
    to:   now + 60 * DAY_MS,
  });
  check("due-soon returns approved in window",       all.length === 2);
  check("due-soon ordered by expires_at ASC",        all[0].id === c1.id && all[1].id === c2.id);

  var byJ = await f.tcr.certificationsDueSoon({
    from:         now,
    to:           now + 60 * DAY_MS,
    jurisdiction: "US-CA",
  });
  check("jurisdiction filter narrows due-soon",      byJ.length === 1 && byJ[0].id === c1.id);

  var byCustomer = await f.tcr.certificationsDueSoon({
    from:        now,
    to:          now + 60 * DAY_MS,
    customer_id: customer,
  });
  check("customer filter narrows due-soon",          byCustomer.length === 2);
}

async function _validation() {
  var f = _factory();

  await assert.rejects(f.tcr.defineSchedule(),                                                        /input object required/);
  await assert.rejects(f.tcr.defineSchedule({}),                                                      /jurisdiction/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "us-ca", lead_time_days: 60, reminder_template_slug: "slug" }), /jurisdiction/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "US-CA", lead_time_days: 0, reminder_template_slug: "slug" }),  /lead_time_days/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "US-CA", lead_time_days: 1.5, reminder_template_slug: "slug" }),/lead_time_days/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "US-CA", lead_time_days: 400, reminder_template_slug: "slug" }),/lead_time_days/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "US-CA", lead_time_days: 60, reminder_template_slug: "BAD" }),  /reminder_template_slug/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "US-CA", lead_time_days: 60, reminder_template_slug: "slug", escalate_after_days: 0 }),    /escalate_after_days/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "US-CA", lead_time_days: 60, reminder_template_slug: "slug", escalate_after_days: -1 }),   /escalate_after_days/);
  await assert.rejects(f.tcr.defineSchedule({ jurisdiction: "US-CA", lead_time_days: 60, reminder_template_slug: "slug", escalate_after_days: 999 }),  /escalate_after_days/);

  await assert.rejects(f.tcr.scanAndEnqueue(),                                                        /input object required/);
  await assert.rejects(f.tcr.scanAndEnqueue({}),                                                      /now/);
  await assert.rejects(f.tcr.scanAndEnqueue({ now: -1 }),                                             /now/);
  await assert.rejects(f.tcr.scanAndEnqueue({ now: Date.now(), channels: [] }),                       /channels/);
  await assert.rejects(f.tcr.scanAndEnqueue({ now: Date.now(), channels: ["BAD"] }),                  /channel/);

  await assert.rejects(f.tcr.recordReminderSent(),                                                    /input object required/);
  await assert.rejects(f.tcr.recordReminderSent({ cert_id: "not-a-uuid", channel: "email" }),         /cert_id/);
  await assert.rejects(f.tcr.recordReminderSent({ cert_id: _newUuid(), channel: "BAD" }),             /channel/);

  await assert.rejects(f.tcr.markEscalated(),                                                         /input object required/);
  await assert.rejects(f.tcr.markEscalated({ cert_id: "x", escalated_to: "ops@x" }),                  /cert_id/);
  await assert.rejects(f.tcr.markEscalated({ cert_id: _newUuid() }),                                  /escalated_to/);

  await assert.rejects(f.tcr.markRenewed(),                                                           /input object required/);
  await assert.rejects(f.tcr.markRenewed({ cert_id: _newUuid() }),                                    /new_expiry/);
  await assert.rejects(f.tcr.markRenewed({ cert_id: _newUuid(), new_expiry: -1 }),                    /new_expiry/);
  await assert.rejects(f.tcr.markRenewed({ cert_id: "x", new_expiry: Date.now() }),                   /cert_id/);

  await assert.rejects(f.tcr.markExpired(),                                                           /input object required/);
  await assert.rejects(f.tcr.markExpired({ cert_id: "x" }),                                           /cert_id/);

  await assert.rejects(f.tcr.certificationsDueSoon(),                                                 /input object required/);
  await assert.rejects(f.tcr.certificationsDueSoon({ from: Date.now() }),                             /to/);
  await assert.rejects(f.tcr.certificationsDueSoon({ from: 1000, to: 500 }),                          /to must be > from/);
  await assert.rejects(f.tcr.certificationsDueSoon({ from: Date.now(), to: Date.now() + 1, jurisdiction: "bad" }), /jurisdiction/);
  await assert.rejects(f.tcr.certificationsDueSoon({ from: Date.now(), to: Date.now() + 1, customer_id: "x" }),    /customer_id/);

  await assert.rejects(f.tcr.metricsForSchedule(),                                                    /input object required/);
  await assert.rejects(f.tcr.metricsForSchedule({ jurisdiction: "US-CA" }),                           /from/);
  await assert.rejects(f.tcr.metricsForSchedule({ jurisdiction: "US-CA", from: Date.now() }),         /to/);
  await assert.rejects(f.tcr.metricsForSchedule({ jurisdiction: "US-CA", from: 1000, to: 500 }),      /to must be > from/);

  await assert.rejects(f.tcr.archiveSchedule("lower"),                                                /jurisdiction/);
  await assert.rejects(f.tcr.listSchedules({ jurisdiction: "lower" }),                                /jurisdiction/);
}

async function run() {
  await _factoryExports();
  await _defineSchedule();
  await _scanAndEnqueuePicksExpiringCerts();
  await _scanAndEnqueueMonotonicClock();
  await _scanAndEnqueueOptedOut();
  await _recordReminderSentFSM();
  await _escalateAfterThreshold();
  await _markRenewedClosesLoop();
  await _markExpiredCloses();
  await _metricsRateMath();
  await _listAndArchiveSchedules();
  await _certificationsDueSoon();
  await _validation();
}

module.exports = { run: run };

// Standalone invocation.
if (require.main === module) {
  run().then(function () {
    console.log("tax-cert-renewals: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
