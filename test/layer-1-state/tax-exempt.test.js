"use strict";
/**
 * taxExempt — B2B / non-profit tax exemption certificates.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0027_tax_exempt_certs.sql. Buyer submits → operator reviews →
 * approved certs suppress tax at checkout (via `isExempt`) until
 * they expire or are revoked.
 *
 * Coverage:
 *   - submit: persists pending-review, returns id + status
 *   - submit: idempotent on (customer_id, jurisdiction, hash) —
 *     re-submitting the same cert by the same customer does NOT
 *     reset an approved row to pending-review
 *   - submit: case-folds + trims the certificate_number before
 *     hashing (so 'sr-ca-1' and ' SR-CA-1 ' dedup to one row)
 *   - approve / reject / revoke transitions, including refusal on
 *     invalid source state
 *   - expireScan: transitions only approved+past-expiry rows
 *   - isExempt: exact jurisdiction match, regional match
 *     ('US' covers 'US-CA'), no match, expired row miss, rejected
 *     and pending rows do not count
 *   - activeForCustomer: returns approved + non-expired rows,
 *     filtered by jurisdiction including region ancestor
 *   - listPendingReview: returns oldest-first queue, refuses bad limit
 *   - validation: refuses bad jurisdiction format, bad cert type,
 *     missing legal_name, expires_at <= issued_at, etc.
 *   - get: returns full row including operator-display
 *     certificate_number plaintext
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_TAX_EXEMPT = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0027_tax_exempt_certs.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_TAX_EXEMPT, "utf8")).forEach(function (s) {
    db.prepare(s).run();
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

function _factory() {
  var h = _makeQuery();
  return { db: h.db, te: bShop.taxExempt.create({ query: h.query }) };
}

function _newCustomer() { return bShop.framework.uuid.v7(); }

function _baseSubmit(overrides) {
  return Object.assign({
    customer_id:        _newCustomer(),
    certificate_type:   "resale",
    jurisdiction:       "US-CA",
    certificate_number: "SR-CA-12345678",
    legal_name:         "Acme Industrial Supply LLC",
    issued_at:          Date.now() - 86400000,
  }, overrides || {});
}

// ---- tests --------------------------------------------------------------

async function _submitAndIdempotency() {
  var f = _factory();
  var custId = _newCustomer();

  var r1 = await f.te.submit(_baseSubmit({ customer_id: custId }));
  check("submit returns uuid id",                typeof r1.id === "string" && r1.id.length === 36);
  check("submit returns pending-review",         r1.status === "pending-review");

  // Stored row sanity: holds plaintext cert number, has a 128-hex
  // hash, status pending-review, no reviewed_* fields set.
  var row = f.db.prepare("SELECT * FROM tax_exempt_certificates WHERE id = ?").all(r1.id)[0];
  check("submit persists exactly one row",        row && row.id === r1.id);
  check("stored row keeps operator-display num",  row.certificate_number === "SR-CA-12345678");
  check("stored row has hex hash",                /^[0-9a-f]{128}$/.test(row.certificate_number_hash));
  check("stored row legal_name",                  row.legal_name === "Acme Industrial Supply LLC");
  check("stored row pending-review",              row.status === "pending-review");
  check("stored row reviewed_at null",            row.reviewed_at === null && row.reviewed_by === null);
  check("stored row notes empty default",         row.notes === "");

  // Idempotent on (customer_id, jurisdiction, hash) — even with
  // casing + whitespace variations in the cert number.
  var r2 = await f.te.submit(_baseSubmit({
    customer_id:        custId,
    certificate_number: "  sr-ca-12345678  ",
    legal_name:         "Different Display Name",
    notes:              "second attempt",
  }));
  check("re-submit returns same id",              r2.id === r1.id);
  check("re-submit returns same status",          r2.status === "pending-review");

  // Approve, then re-submit — must NOT reset to pending-review.
  await f.te.approve(r1.id, { reviewed_by: "ops@example.com" });
  var r3 = await f.te.submit(_baseSubmit({
    customer_id:        custId,
    certificate_number: "SR-CA-12345678",
  }));
  check("re-submit of approved row returns approved status", r3.status === "approved");
  check("re-submit of approved row is same id",              r3.id === r1.id);

  // Different jurisdiction → distinct row.
  var r4 = await f.te.submit(_baseSubmit({
    customer_id:  custId,
    jurisdiction: "US-NY",
  }));
  check("different jurisdiction → new row",       r4.id !== r1.id && r4.status === "pending-review");

  // Different customer → distinct row.
  var r5 = await f.te.submit(_baseSubmit({ certificate_number: "SR-CA-12345678" }));
  check("different customer → new row",           r5.id !== r1.id);
}

async function _approveRejectRevoke() {
  var f = _factory();

  // approve happy path.
  var a = await f.te.submit(_baseSubmit({ notes: "buyer-supplied note" }));
  var approved = await f.te.approve(a.id, { reviewed_by: "ops@example.com", notes: "verified scan" });
  check("approve transitions to approved",        approved.status === "approved");
  check("approve sets reviewed_by",               approved.reviewed_by === "ops@example.com");
  check("approve sets reviewed_at",               typeof approved.reviewed_at === "number" && approved.reviewed_at > 0);
  check("approve merges buyer + operator notes",  approved.notes.indexOf("buyer-supplied note") !== -1 && approved.notes.indexOf("verified scan") !== -1);

  // Cannot re-approve.
  await assert.rejects(
    f.te.approve(a.id, { reviewed_by: "ops@example.com" }),
    /approved/,
  );

  // reject happy path.
  var r = await f.te.submit(_baseSubmit());
  var rejected = await f.te.reject(r.id, { reviewed_by: "ops@example.com", rejection_reason: "scan unreadable" });
  check("reject transitions to rejected",         rejected.status === "rejected");
  check("reject persists rejection_reason",       rejected.rejection_reason === "scan unreadable");

  // Cannot approve a rejected row.
  await assert.rejects(
    f.te.approve(r.id, { reviewed_by: "ops@example.com" }),
    /rejected/,
  );

  // revoke happy path — only against an approved cert.
  var v = await f.te.submit(_baseSubmit());
  await assert.rejects(
    f.te.revoke(v.id, { reviewed_by: "ops@example.com", reason: "fraud" }),
    /pending-review/,
  );
  await f.te.approve(v.id, { reviewed_by: "ops@example.com" });
  var revoked = await f.te.revoke(v.id, { reviewed_by: "ops@example.com", reason: "operator-detected fraud" });
  check("revoke transitions to revoked",          revoked.status === "revoked");
  check("revoke notes tag the row",               revoked.notes.indexOf("revoked: operator-detected fraud") !== -1);

  // Unknown id returns null on every action.
  var stray = bShop.framework.uuid.v7();
  check("approve unknown id null",                (await f.te.approve(stray, { reviewed_by: "ops@example.com" })) === null);
  check("reject unknown id null",                 (await f.te.reject(stray, { reviewed_by: "ops@example.com", rejection_reason: "x" })) === null);
  check("revoke unknown id null",                 (await f.te.revoke(stray, { reviewed_by: "ops@example.com", reason: "x" })) === null);

  // get returns full row.
  var full = await f.te.get(a.id);
  check("get returns full row",                   full && full.id === a.id && full.certificate_number === "SR-CA-12345678");
  check("get unknown returns null",               (await f.te.get(stray)) === null);
}

async function _expireScan() {
  var f = _factory();
  var now = Date.now();

  // Three approved certs: one no-expiry, one future-expiry, one past-expiry.
  var noExp  = await f.te.submit(_baseSubmit({ jurisdiction: "US-CA" }));
  var future = await f.te.submit(_baseSubmit({ jurisdiction: "US-NY", expires_at: now + 86400000 }));
  var past   = await f.te.submit(_baseSubmit({ jurisdiction: "US-TX", expires_at: now + 1000 }));
  await f.te.approve(noExp.id,  { reviewed_by: "ops@example.com" });
  await f.te.approve(future.id, { reviewed_by: "ops@example.com" });
  await f.te.approve(past.id,   { reviewed_by: "ops@example.com" });

  // A pending-review past-expiry row must NOT be touched by the scan
  // (only approved → expired is in scope).
  var pendingPast = await f.te.submit(_baseSubmit({ jurisdiction: "US-FL", expires_at: now + 1000 }));

  // Run the scan at a future timestamp past the past cert's expiry.
  var scanTs = now + 86400000 / 2;
  var count = await f.te.expireScan(scanTs);
  check("expireScan returns 1 (only past+approved)", count === 1);

  check("no-expiry stays approved",              (await f.te.get(noExp.id)).status === "approved");
  check("future-expiry stays approved",          (await f.te.get(future.id)).status === "approved");
  check("past+approved transitions to expired",  (await f.te.get(past.id)).status === "expired");
  check("pending+past untouched",                (await f.te.get(pendingPast.id)).status === "pending-review");

  // Idempotent re-run — nothing left to transition.
  var second = await f.te.expireScan(scanTs);
  check("expireScan idempotent on second run",   second === 0);

  // Default timestamp = now.
  var defaulted = await f.te.expireScan();
  check("expireScan default-now is a count",     typeof defaulted === "number" && defaulted >= 0);
}

async function _isExemptCoverage() {
  var f = _factory();
  var custId = _newCustomer();
  var otherCust = _newCustomer();

  // Approved US-CA cert for `custId` — exempts US-CA only.
  var ca = await f.te.submit(_baseSubmit({ customer_id: custId, jurisdiction: "US-CA" }));
  await f.te.approve(ca.id, { reviewed_by: "ops@example.com" });

  check("isExempt US-CA hit",                    await f.te.isExempt({ customer_id: custId, jurisdiction: "US-CA" }) === true);
  check("isExempt US-NY miss (no NY cert)",      await f.te.isExempt({ customer_id: custId, jurisdiction: "US-NY" }) === false);
  check("isExempt EU-DE miss (no EU cert)",      await f.te.isExempt({ customer_id: custId, jurisdiction: "EU-DE" }) === false);
  check("isExempt other customer miss",          await f.te.isExempt({ customer_id: otherCust, jurisdiction: "US-CA" }) === false);

  // Add a regional 'US' cert — now any 'US-XX' jurisdiction is exempt.
  var us = await f.te.submit(_baseSubmit({
    customer_id:        custId,
    jurisdiction:       "US",
    certificate_number: "FED-NONPROF-9999",
    certificate_type:   "nonprofit",
  }));
  await f.te.approve(us.id, { reviewed_by: "ops@example.com" });

  check("regional US covers US-NY",              await f.te.isExempt({ customer_id: custId, jurisdiction: "US-NY" }) === true);
  check("regional US covers US",                 await f.te.isExempt({ customer_id: custId, jurisdiction: "US" }) === true);
  check("regional US does not cover EU-DE",      await f.te.isExempt({ customer_id: custId, jurisdiction: "EU-DE" }) === false);
  check("regional US does not cover CA-ON",      await f.te.isExempt({ customer_id: custId, jurisdiction: "CA-ON" }) === false);

  // Expired cert is NOT exempt.
  var exp = await f.te.submit(_baseSubmit({
    customer_id:  otherCust,
    jurisdiction: "EU-DE",
    expires_at:   Date.now() + 1000,
  }));
  await f.te.approve(exp.id, { reviewed_by: "ops@example.com" });
  // Force-transition the row directly to mimic an expireScan having run.
  f.db.prepare("UPDATE tax_exempt_certificates SET status='expired' WHERE id=?").run(exp.id);
  check("expired cert is not exempt",            await f.te.isExempt({ customer_id: otherCust, jurisdiction: "EU-DE" }) === false);

  // Even without the status flip, read-time filtering kicks in if
  // expires_at <= now.
  var stale = await f.te.submit(_baseSubmit({
    customer_id:  otherCust,
    jurisdiction: "GB-ENG",
    expires_at:   Date.now() + 50,
  }));
  await f.te.approve(stale.id, { reviewed_by: "ops@example.com" });
  // Force expires_at into the past WITHOUT changing status — read
  // path must still treat the row as inactive.
  f.db.prepare("UPDATE tax_exempt_certificates SET expires_at=? WHERE id=?").run(Date.now() - 1000, stale.id);
  check("read-time expiry filter still hides",   await f.te.isExempt({ customer_id: otherCust, jurisdiction: "GB-ENG" }) === false);

  // Pending + rejected + revoked all miss.
  var pend = await f.te.submit(_baseSubmit({ customer_id: otherCust, jurisdiction: "FR" }));
  check("pending row does not exempt",           await f.te.isExempt({ customer_id: otherCust, jurisdiction: "FR" }) === false);
  await f.te.reject(pend.id, { reviewed_by: "ops@example.com", rejection_reason: "bad scan" });
  check("rejected row does not exempt",          await f.te.isExempt({ customer_id: otherCust, jurisdiction: "FR" }) === false);

  var rev = await f.te.submit(_baseSubmit({ customer_id: otherCust, jurisdiction: "AU-NSW" }));
  await f.te.approve(rev.id, { reviewed_by: "ops@example.com" });
  check("freshly-approved exempts",              await f.te.isExempt({ customer_id: otherCust, jurisdiction: "AU-NSW" }) === true);
  await f.te.revoke(rev.id, { reviewed_by: "ops@example.com", reason: "fraud" });
  check("revoked row no longer exempts",         await f.te.isExempt({ customer_id: otherCust, jurisdiction: "AU-NSW" }) === false);
}

async function _activeForCustomer() {
  var f = _factory();
  var custId = _newCustomer();

  // 4 rows: approved US-CA, approved US, pending US-NY, rejected EU-DE.
  var caCert = await f.te.submit(_baseSubmit({ customer_id: custId, jurisdiction: "US-CA" }));
  var usCert = await f.te.submit(_baseSubmit({ customer_id: custId, jurisdiction: "US", certificate_number: "US-FED-1" }));
  await f.te.submit(_baseSubmit({ customer_id: custId, jurisdiction: "US-NY", certificate_number: "NY-RES-1" }));
  var euCert = await f.te.submit(_baseSubmit({ customer_id: custId, jurisdiction: "EU-DE", certificate_number: "DE-1" }));
  await f.te.approve(caCert.id, { reviewed_by: "ops@example.com" });
  await f.te.approve(usCert.id, { reviewed_by: "ops@example.com" });
  await f.te.reject(euCert.id,  { reviewed_by: "ops@example.com", rejection_reason: "expired" });

  var all = await f.te.activeForCustomer(custId);
  check("activeForCustomer returns 2 approved",  all.length === 2);
  check("all rows are approved",                 all.every(function (r) { return r.status === "approved"; }));

  // Jurisdiction filter: exact + regional ancestor.
  var caScope = await f.te.activeForCustomer(custId, { jurisdiction: "US-CA" });
  var caIds   = caScope.map(function (r) { return r.id; }).sort();
  var expCa   = [caCert.id, usCert.id].sort();
  check("US-CA scope returns CA + US ancestor",  caIds.length === 2 && caIds[0] === expCa[0] && caIds[1] === expCa[1]);

  var nyScope = await f.te.activeForCustomer(custId, { jurisdiction: "US-NY" });
  check("US-NY scope returns just US ancestor",  nyScope.length === 1 && nyScope[0].id === usCert.id);

  var euScope = await f.te.activeForCustomer(custId, { jurisdiction: "EU-DE" });
  check("EU-DE scope returns nothing",            euScope.length === 0);
}

async function _listPendingReview() {
  var f = _factory();
  var custA = _newCustomer();
  var custB = _newCustomer();
  var custC = _newCustomer();

  var a = await f.te.submit(_baseSubmit({ customer_id: custA, jurisdiction: "US-CA" }));
  // Bump created_at on each row so ORDER BY created_at ASC is
  // deterministic — sqlite ms-precision means same-tick rows may
  // sort by insertion order, but we want unambiguous ordering.
  f.db.prepare("UPDATE tax_exempt_certificates SET created_at=? WHERE id=?").run(1000, a.id);

  var b = await f.te.submit(_baseSubmit({ customer_id: custB, jurisdiction: "US-NY" }));
  f.db.prepare("UPDATE tax_exempt_certificates SET created_at=? WHERE id=?").run(2000, b.id);

  var c = await f.te.submit(_baseSubmit({ customer_id: custC, jurisdiction: "EU-DE", certificate_number: "DE-NONPROF-1", certificate_type: "nonprofit" }));
  f.db.prepare("UPDATE tax_exempt_certificates SET created_at=? WHERE id=?").run(3000, c.id);

  // Approve `b` — drops out of the queue.
  await f.te.approve(b.id, { reviewed_by: "ops@example.com" });

  var queue = await f.te.listPendingReview();
  check("listPendingReview returns 2",           queue.length === 2);
  check("listPendingReview oldest-first",        queue[0].id === a.id && queue[1].id === c.id);

  var lim = await f.te.listPendingReview({ limit: 1 });
  check("listPendingReview respects limit",      lim.length === 1 && lim[0].id === a.id);

  await assert.rejects(f.te.listPendingReview({ limit: 0 }),     /limit/);
  await assert.rejects(f.te.listPendingReview({ limit: -1 }),    /limit/);
  await assert.rejects(f.te.listPendingReview({ limit: 1.5 }),   /limit/);
  await assert.rejects(f.te.listPendingReview({ limit: 9999 }),  /limit/);
}

async function _validationRefusals() {
  var f = _factory();

  // submit — bad input shapes.
  await assert.rejects(f.te.submit(),                                                                     /input object required/);
  await assert.rejects(f.te.submit({}),                                                                   /customer_id/);
  await assert.rejects(f.te.submit(_baseSubmit({ customer_id: "not-a-uuid" })),                            /customer_id/);
  await assert.rejects(f.te.submit(_baseSubmit({ certificate_type: "bogus" })),                            /certificate_type/);
  await assert.rejects(f.te.submit(_baseSubmit({ certificate_type: "" })),                                 /certificate_type/);
  await assert.rejects(f.te.submit(_baseSubmit({ jurisdiction: "us-ca" })),                                /jurisdiction/);
  await assert.rejects(f.te.submit(_baseSubmit({ jurisdiction: "USA" })),                                  /jurisdiction/);
  await assert.rejects(f.te.submit(_baseSubmit({ jurisdiction: "US-CALIF" })),                             /jurisdiction/);
  await assert.rejects(f.te.submit(_baseSubmit({ jurisdiction: "US_CA" })),                                /jurisdiction/);
  await assert.rejects(f.te.submit(_baseSubmit({ jurisdiction: "" })),                                     /jurisdiction/);
  await assert.rejects(f.te.submit(_baseSubmit({ certificate_number: "abc" })),                            /certificate_number/);
  await assert.rejects(f.te.submit(_baseSubmit({ certificate_number: "" })),                               /certificate_number/);
  await assert.rejects(f.te.submit(_baseSubmit({ certificate_number: "X".repeat(65) })),                   /certificate_number/);
  await assert.rejects(f.te.submit(_baseSubmit({ certificate_number: "ABC DEF" })),                   /certificate_number/);
  await assert.rejects(f.te.submit(_baseSubmit({ legal_name: "" })),                                       /legal_name/);
  await assert.rejects(f.te.submit(_baseSubmit({ legal_name: "  " })),                                     /legal_name/);
  await assert.rejects(f.te.submit(_baseSubmit({ legal_name: "Acme\nInjection" })),                        /legal_name/);
  await assert.rejects(f.te.submit(_baseSubmit({ legal_name: "X".repeat(257) })),                          /legal_name/);
  await assert.rejects(f.te.submit(_baseSubmit({ issued_at: 0 })),                                         /issued_at/);
  await assert.rejects(f.te.submit(_baseSubmit({ issued_at: -1 })),                                        /issued_at/);
  await assert.rejects(f.te.submit(_baseSubmit({ issued_at: 1.5 })),                                       /issued_at/);
  await assert.rejects(f.te.submit(_baseSubmit({ issued_at: "yesterday" })),                               /issued_at/);
  await assert.rejects(f.te.submit(_baseSubmit({ expires_at: -1 })),                                       /expires_at/);
  await assert.rejects(f.te.submit(_baseSubmit({
    issued_at:  1000,
    expires_at: 500,
  })),                                                                                                     /expires_at must be > issued_at/);
  await assert.rejects(f.te.submit(_baseSubmit({ document_r2_key: "" })),                                  /document_r2_key/);
  await assert.rejects(f.te.submit(_baseSubmit({ notes: "X".repeat(4097) })),                              /notes/);

  // approve / reject / revoke — required reviewer + reason.
  var ok = await f.te.submit(_baseSubmit());
  await assert.rejects(f.te.approve(),                                                                     /cert_id/);
  await assert.rejects(f.te.approve("not-a-uuid", { reviewed_by: "x" }),                                   /cert_id/);
  await assert.rejects(f.te.approve(ok.id),                                                                /input object required/);
  await assert.rejects(f.te.approve(ok.id, {}),                                                            /reviewed_by/);
  await assert.rejects(f.te.approve(ok.id, { reviewed_by: "" }),                                           /reviewed_by/);

  await assert.rejects(f.te.reject(ok.id, { reviewed_by: "x" }),                                           /rejection_reason/);
  await assert.rejects(f.te.reject(ok.id, { reviewed_by: "x", rejection_reason: "" }),                     /rejection_reason/);
  await assert.rejects(f.te.reject(ok.id, { rejection_reason: "x" }),                                      /reviewed_by/);

  await assert.rejects(f.te.revoke(ok.id, { reviewed_by: "x" }),                                           /reason/);
  await assert.rejects(f.te.revoke(ok.id, { reviewed_by: "x", reason: "" }),                               /reason/);
  await assert.rejects(f.te.revoke(ok.id, { reason: "x" }),                                                /reviewed_by/);

  // isExempt — bad input.
  await assert.rejects(f.te.isExempt(),                                                                    /input object required/);
  await assert.rejects(f.te.isExempt({}),                                                                  /customer_id/);
  await assert.rejects(f.te.isExempt({ customer_id: "not-a-uuid", jurisdiction: "US" }),                   /customer_id/);
  await assert.rejects(f.te.isExempt({ customer_id: bShop.framework.uuid.v7(), jurisdiction: "bogus" }),   /jurisdiction/);

  // activeForCustomer — bad uuid + bad jurisdiction filter.
  await assert.rejects(f.te.activeForCustomer("not-a-uuid"),                                               /customer_id/);
  await assert.rejects(f.te.activeForCustomer(bShop.framework.uuid.v7(), { jurisdiction: "lower" }),       /jurisdiction/);

  // expireScan — bad timestamp.
  await assert.rejects(f.te.expireScan(-1),                                                                /ts/);
  await assert.rejects(f.te.expireScan(1.5),                                                               /ts/);

  // get — bad uuid.
  await assert.rejects(f.te.get("not-a-uuid"),                                                             /cert_id/);
}

async function _expiredStatusSemantics() {
  // Once a cert has lazily transitioned to 'expired', subsequent
  // operator actions against it must refuse — there's no "un-expire"
  // path. Operators issue a fresh submission instead.
  var f = _factory();
  var s = await f.te.submit(_baseSubmit({ expires_at: Date.now() + 1000 }));
  await f.te.approve(s.id, { reviewed_by: "ops@example.com" });
  f.db.prepare("UPDATE tax_exempt_certificates SET status='expired' WHERE id=?").run(s.id);

  await assert.rejects(
    f.te.revoke(s.id, { reviewed_by: "ops@example.com", reason: "x" }),
    /expired/,
  );
  await assert.rejects(
    f.te.approve(s.id, { reviewed_by: "ops@example.com" }),
    /expired/,
  );
  await assert.rejects(
    f.te.reject(s.id, { reviewed_by: "ops@example.com", rejection_reason: "x" }),
    /expired/,
  );

  // But re-submitting opens a NEW pending-review row — the UNIQUE
  // constraint on (customer_id, jurisdiction, hash) would block this,
  // so the idempotency check returns the expired row's id + status.
  // Operators handle this by submitting under a different cert number
  // (typical real-world case — the new certificate has a new number).
  var row = await f.te.get(s.id);
  var resub = await f.te.submit(_baseSubmit({
    customer_id:        row.customer_id,
    jurisdiction:       row.jurisdiction,
    certificate_number: row.certificate_number,
  }));
  check("re-submit of expired returns expired status", resub.status === "expired" && resub.id === s.id);

  // New cert number → genuinely new submission, pending-review.
  var fresh = await f.te.submit(_baseSubmit({
    customer_id:        row.customer_id,
    jurisdiction:       row.jurisdiction,
    certificate_number: "FRESH-REPLACEMENT-CERT",
  }));
  check("fresh number = new pending row",        fresh.id !== s.id && fresh.status === "pending-review");
}

async function _factoryExports() {
  // Surface contract — every public field documented in the
  // primitive header must show up on the module + factory.
  check("module exports create",                  typeof bShop.taxExempt.create === "function");
  check("module exports CERT_TYPES",              Array.isArray(bShop.taxExempt.CERT_TYPES) && bShop.taxExempt.CERT_TYPES.length === 8);
  check("module exports STATUSES",                Array.isArray(bShop.taxExempt.STATUSES) && bShop.taxExempt.STATUSES.length === 5);
  check("module exports CERT_NUMBER_NAMESPACE",   bShop.taxExempt.CERT_NUMBER_NAMESPACE === "tax-cert-number");

  var f = _factory();
  ["submit", "approve", "reject", "revoke", "expireScan", "get", "activeForCustomer", "listPendingReview", "isExempt"].forEach(function (m) {
    check("factory exports " + m,                  typeof f.te[m] === "function");
  });
}

async function run() {
  await _factoryExports();
  await _submitAndIdempotency();
  await _approveRejectRevoke();
  await _expireScan();
  await _isExemptCoverage();
  await _activeForCustomer();
  await _listPendingReview();
  await _validationRefusals();
  await _expiredStatusSemantics();
}

module.exports = { run: run };
