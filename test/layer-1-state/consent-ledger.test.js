"use strict";
/**
 * consent-ledger — append-only per-customer record of every consent
 * decision (cookie categories, marketing email, SMS, third-party
 * data sharing, general data processing). Distinct from
 * cookieConsent (session-level browser gate) — this primitive is
 * the durable GDPR / ePrivacy / CCPA audit-of-record.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0185_consent_ledger.sql`. The primitive isn't wired through
 * `bShop` yet — the test requires `lib/consent-ledger.js` directly
 * so the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - recordConsentChange refuses bad input on every column
 *     (customer_id shape, consent_kind enum, state enum, source
 *     enum, jurisdiction shape, evidence_ref shape)
 *   - currentStateForCustomer reflects the latest row per kind
 *     (granted -> withdrawn -> granted timeline collapses to the
 *     newest decision); kinds with no row are omitted
 *   - historyForCustomer returns newest-first; monotonic clock
 *     resolves same-millisecond ties via id DESC
 *   - auditExport CSV emits RFC-4180 header + quoted-as-needed
 *     cells; JSON returns the raw row array
 *   - bulkExportByJurisdiction filters on jurisdiction + window;
 *     rows outside the window or in another jurisdiction excluded
 *   - summarizeForCompliance aggregates per (kind, source) with
 *     granted / withdrawn counts; jurisdiction filter narrows;
 *     unobserved tuples omitted
 *   - append-only: no UPDATE / DELETE path on the public surface;
 *     withdrawal writes a new row, prior row survives
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var consentLedger  = require("../../lib/consent-ledger");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0185_consent_ledger.sql"
);
var MIG_LAWFUL_BASIS = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0232_consent_ledger_lawful_basis.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  // The lawful_basis column lands in a follow-on migration; apply it so
  // the in-memory schema matches production.
  _splitSchema(nodeFs.readFileSync(MIG_LAWFUL_BASIS, "utf8")).forEach(function (s) {
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
        changes:   Number(info.changes),
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _setup() {
  var query = _makeQuery();
  var ledger = consentLedger.create({ query: query });
  return { query: query, ledger: ledger };
}

async function _recordConsentRefusals() {
  var ctx = _setup();
  var cust = _uuid();

  // Happy path — a complete grant row persists with every column.
  var row = await ctx.ledger.recordConsentChange({
    customer_id:  cust,
    consent_kind: "marketing_email",
    state:        "granted",
    source:       "signup_form",
    jurisdiction: "DE",
    evidence_ref: "signup_form_v3:submission_abc",
  });
  check("recordConsentChange returns row id (uuid)",  typeof row.id === "string" && row.id.length > 0);
  check("recordConsentChange preserves customer_id",  row.customer_id === cust);
  check("recordConsentChange preserves consent_kind", row.consent_kind === "marketing_email");
  check("recordConsentChange preserves state",        row.state === "granted");
  check("recordConsentChange preserves source",       row.source === "signup_form");
  check("recordConsentChange preserves jurisdiction", row.jurisdiction === "DE");
  check("recordConsentChange preserves evidence_ref", row.evidence_ref === "signup_form_v3:submission_abc");
  check("recordConsentChange stamps occurred_at",     typeof row.occurred_at === "number" && row.occurred_at > 0);
  check("recordConsentChange defaults lawful_basis from kind", row.lawful_basis === "consent");

  // Optional columns nullable.
  var minimal = await ctx.ledger.recordConsentChange({
    customer_id:  cust,
    consent_kind: "cookies_analytics",
    state:        "granted",
    source:       "cookie_banner",
  });
  check("optional jurisdiction nullable",  minimal.jurisdiction === null);
  check("optional evidence_ref nullable",  minimal.evidence_ref === null);

  // Refusals — every public-surface input refuses bad shapes.
  await assert.rejects(ctx.ledger.recordConsentChange(),                              /input object required/);
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: "not-uuid", consent_kind: "marketing_email", state: "granted", source: "signup_form",
  }), /customer_id/);
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "BAD_KIND", state: "granted", source: "signup_form",
  }), /consent_kind/);
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "maybe", source: "signup_form",
  }), /state/);
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "telepathy",
  }), /source/);

  // Jurisdiction shape: ISO-3166-1 alpha-2 UPPERCASE only.
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    jurisdiction: "de",
  }), /jurisdiction/);
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    jurisdiction: "DEU",
  }), /jurisdiction/);

  // Evidence ref refuses control bytes, oversize, bad shape.
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    evidence_ref: "bad\x00ref",
  }), /evidence_ref/);
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    evidence_ref: "has space",
  }), /evidence_ref/);
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    evidence_ref: "x".repeat(257),
  }), /evidence_ref/);

  // An explicit lawful_basis outside the Art. 6(1) set is refused.
  await assert.rejects(ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "data_processing", state: "granted", source: "signup_form",
    lawful_basis: "telepathy",
  }), /lawful_basis/);
}

async function _lawfulBasisTagging() {
  var ctx = _setup();
  var cust = _uuid();

  // Every consent kind defaults to the consent basis (they are all
  // consent-gated in this ledger). Spot-check across the categories.
  var kinds = ["cookies_marketing", "marketing_sms", "data_sharing_partners", "data_processing"];
  for (var i = 0; i < kinds.length; i += 1) {
    var rec = await ctx.ledger.recordConsentChange({
      customer_id: cust, consent_kind: kinds[i], state: "granted", source: "preference_center",
    });
    check("lawful_basis defaults to consent for " + kinds[i], rec.lawful_basis === "consent");
  }

  // A withdrawal row carries the same (kind-derived) basis as its grant.
  var withdrawal = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "withdrawn", source: "preference_center",
  });
  check("withdrawal row carries the kind's lawful_basis", withdrawal.lawful_basis === "consent");

  // An explicit basis overrides the default and persists.
  var explicit = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "data_processing", state: "granted", source: "customer_support",
    lawful_basis: "legal_obligation",
  });
  check("explicit lawful_basis overrides the default", explicit.lawful_basis === "legal_obligation");

  // The persisted basis round-trips through the read path.
  var history = await ctx.ledger.historyForCustomer(cust);
  var persisted = history.find(function (r) { return r.id === explicit.id; });
  check("explicit lawful_basis round-trips through read", persisted && persisted.lawful_basis === "legal_obligation");

  // A backfill-style row inserted without a basis hydrates as null
  // (the column is nullable; pre-existing rows are not retro-stamped).
  var legacyId = _uuid();
  await ctx.query(
    "INSERT INTO consent_ledger " +
    "(id, customer_id, consent_kind, state, source, jurisdiction, evidence_ref, occurred_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    [legacyId, cust, "marketing_email", "granted", "system_default", null, null, 1000],
  );
  var withLegacy = await ctx.ledger.historyForCustomer(cust);
  var legacy = withLegacy.find(function (r) { return r.id === legacyId; });
  check("backfill row without a basis hydrates null", legacy && legacy.lawful_basis === null);

  // The migration's CHECK rejects an out-of-set basis at the DB layer
  // for a row written after the ALTER.
  var checkRejected = false;
  try {
    await ctx.query(
      "INSERT INTO consent_ledger " +
      "(id, customer_id, consent_kind, state, source, lawful_basis, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      [_uuid(), cust, "marketing_email", "granted", "system_default", "garbage", 1001],
    );
  } catch (_e) {
    checkRejected = true;
  }
  check("DB CHECK rejects an out-of-set lawful_basis", checkRejected);
}

async function _currentStateReflectsLatest() {
  var ctx = _setup();
  var cust = _uuid();
  var other = _uuid();

  // Granted twice in a row, then withdrawn — current state should
  // be the withdrawal.
  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "preference_center",
  });
  var withdrawal = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "withdrawn", source: "preference_center",
    evidence_ref: "preference_center:revoke_8819",
  });

  // A second category granted only once.
  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_sms", state: "granted", source: "signup_form",
  });

  // A third kind cycled granted -> withdrawn -> granted.
  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "cookies_analytics", state: "granted", source: "cookie_banner",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "cookies_analytics", state: "withdrawn", source: "preference_center",
  });
  var cookiesAnalyticsLatest = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "cookies_analytics", state: "granted", source: "cookie_banner",
  });

  // A different customer's row must not leak into this customer's
  // current state.
  await ctx.ledger.recordConsentChange({
    customer_id: other, consent_kind: "marketing_email", state: "granted", source: "signup_form",
  });

  var current = await ctx.ledger.currentStateForCustomer(cust);
  check("currentState includes marketing_email",          !!current.marketing_email);
  check("currentState latest marketing_email is withdrawn", current.marketing_email.state === "withdrawn");
  check("currentState carries withdrawal source",         current.marketing_email.source === "preference_center");
  check("currentState carries withdrawal occurred_at",    current.marketing_email.occurred_at === withdrawal.occurred_at);
  check("currentState carries withdrawal evidence_ref",   current.marketing_email.evidence_ref === "preference_center:revoke_8819");

  check("currentState includes marketing_sms",            current.marketing_sms && current.marketing_sms.state === "granted");

  check("currentState cycled kind reflects newest grant", current.cookies_analytics.state === "granted");
  check("currentState newest matches recorded occurred_at",
    current.cookies_analytics.occurred_at === cookiesAnalyticsLatest.occurred_at);

  // Kinds with no row are omitted — caller must not be able to infer
  // "withdrawn" from absence; the contract is "no row means caller
  // decides the default."
  check("currentState omits never-recorded kind", current.marketing_sms_off === undefined);
  check("currentState omits cookies_marketing",   current.cookies_marketing === undefined);

  // Refusal — bad customer_id shape rejected.
  await assert.rejects(ctx.ledger.currentStateForCustomer("not-uuid"), /customer_id/);

  // Empty when customer has no rows at all.
  var empty = await ctx.ledger.currentStateForCustomer(_uuid());
  check("currentState for never-seen customer is empty", Object.keys(empty).length === 0);
}

async function _historyOrdering() {
  var ctx = _setup();
  var cust = _uuid();

  var r1 = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
  });
  var r2 = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_sms", state: "granted", source: "signup_form",
  });
  var r3 = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "withdrawn", source: "preference_center",
  });
  var r4 = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_sms", state: "withdrawn", source: "preference_center",
  });

  var hist = await ctx.ledger.historyForCustomer(cust);
  check("historyForCustomer returns every row", hist.length === 4);
  check("historyForCustomer newest first",      hist[0].id === r4.id);
  check("historyForCustomer second is r3",      hist[1].id === r3.id);
  check("historyForCustomer third is r2",       hist[2].id === r2.id);
  check("historyForCustomer oldest last",       hist[3].id === r1.id);

  // Monotonic clock: every occurred_at is strictly greater than the
  // prior write's, even when the host loop fires multiple rows in
  // the same millisecond.
  check("history occurred_at strictly increases r1->r2", r2.occurred_at > r1.occurred_at);
  check("history occurred_at strictly increases r2->r3", r3.occurred_at > r2.occurred_at);
  check("history occurred_at strictly increases r3->r4", r4.occurred_at > r3.occurred_at);

  // Different customer's rows excluded.
  var stranger = _uuid();
  await ctx.ledger.recordConsentChange({
    customer_id: stranger, consent_kind: "marketing_email", state: "granted", source: "signup_form",
  });
  var stillFour = await ctx.ledger.historyForCustomer(cust);
  check("history excludes other customers", stillFour.length === 4);

  // Refusal.
  await assert.rejects(ctx.ledger.historyForCustomer("not-uuid"), /customer_id/);
}

async function _auditExportCsvFormat() {
  var ctx = _setup();
  var cust = _uuid();

  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    jurisdiction: "DE", evidence_ref: "form_v3:abc",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "withdrawn", source: "preference_center",
    jurisdiction: "DE",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "data_sharing_partners", state: "granted", source: "preference_center",
    jurisdiction: "DE",
  });

  // CSV format.
  var csv = await ctx.ledger.auditExport({ customer_id: cust, format: "csv" });
  check("auditExport CSV reports format",       csv.format === "csv");
  check("auditExport CSV body is a string",     typeof csv.body === "string" && csv.body.length > 0);

  var lines = csv.body.split("\n");
  check("auditExport CSV emits header row",
    lines[0] === "id,customer_id,consent_kind,state,source,lawful_basis,jurisdiction,evidence_ref,occurred_at");
  check("auditExport CSV emits one line per row + header", lines.length === 4);
  // Newest-first ordering carries into CSV output.
  check("auditExport CSV first data line is data_sharing_partners grant",
    lines[1].indexOf("data_sharing_partners") !== -1 && lines[1].indexOf(",granted,") !== -1);
  check("auditExport CSV second data line is marketing_email withdrawal",
    lines[2].indexOf("marketing_email") !== -1 && lines[2].indexOf(",withdrawn,") !== -1);
  check("auditExport CSV last data line carries evidence_ref",
    lines[3].indexOf("form_v3:abc") !== -1);

  // JSON format.
  var json = await ctx.ledger.auditExport({ customer_id: cust, format: "json" });
  check("auditExport JSON reports format",      json.format === "json");
  check("auditExport JSON rows length matches", json.rows.length === 3);
  check("auditExport JSON newest-first",        json.rows[0].consent_kind === "data_sharing_partners");

  // Refusals.
  await assert.rejects(ctx.ledger.auditExport(),                                            /input object required/);
  await assert.rejects(ctx.ledger.auditExport({ customer_id: "not-uuid", format: "csv" }),  /customer_id/);
  await assert.rejects(ctx.ledger.auditExport({ customer_id: cust, format: "xml" }),        /format/);
  await assert.rejects(ctx.ledger.auditExport({ customer_id: cust }),                       /format/);

  // Empty customer round-trips to an empty CSV (header line only) +
  // empty JSON rows array.
  var emptyJson = await ctx.ledger.auditExport({ customer_id: _uuid(), format: "json" });
  check("empty customer JSON rows is []",       emptyJson.rows.length === 0);
  var emptyCsv = await ctx.ledger.auditExport({ customer_id: _uuid(), format: "csv" });
  // csv.stringify with empty rows returns "" — header-only output
  // is not emitted on an empty input; downstream callers treat the
  // empty string as "no rows".
  check("empty customer CSV is empty string",   emptyCsv.body === "");
}

async function _jurisdictionFilter() {
  var ctx = _setup();
  var custA = _uuid();
  var custB = _uuid();
  var custC = _uuid();

  // Three DE rows over a window; one US row inside the window; one
  // DE row outside the window.
  var WINDOW_START = 1700000000000;
  var WINDOW_END   = 1800000000000;

  // We can't pass occurred_at directly through the primitive (the
  // ledger stamps its own monotonic clock); instead we record rows
  // and rely on Date.now()'s actual value being well inside [start,
  // end) for the in-window rows. The "outside" row we insert
  // directly via the raw query to exercise the date filter
  // (operator's audit story includes historical rows imported via
  // backfill — the filter must apply to them too).
  await ctx.ledger.recordConsentChange({
    customer_id: custA, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    jurisdiction: "DE", evidence_ref: "a1",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: custB, consent_kind: "marketing_sms", state: "granted", source: "signup_form",
    jurisdiction: "DE", evidence_ref: "b1",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: custB, consent_kind: "marketing_sms", state: "withdrawn", source: "preference_center",
    jurisdiction: "DE",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: custC, consent_kind: "marketing_email", state: "granted", source: "signup_form",
    jurisdiction: "US",
  });

  // Backfilled out-of-window DE row — inserted directly so the date
  // filter has something to exclude.
  await ctx.query(
    "INSERT INTO consent_ledger " +
    "(id, customer_id, consent_kind, state, source, jurisdiction, evidence_ref, occurred_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    [_uuid(), custA, "data_processing", "granted", "system_default", "DE", "ancient", 1000],
  );

  // Filter on jurisdiction=DE in [WINDOW_START, WINDOW_END) — picks
  // up the three live DE rows, excludes the US row AND the
  // out-of-window DE row.
  var deCsv = await ctx.ledger.bulkExportByJurisdiction({
    jurisdiction: "DE", from: WINDOW_START, to: WINDOW_END,
  });
  check("bulkExportByJurisdiction default CSV",    deCsv.format === "csv");
  check("bulkExportByJurisdiction echoes country", deCsv.jurisdiction === "DE");
  var deLines = deCsv.body.split("\n").slice(1); // drop header
  check("bulkExport DE includes 3 rows", deLines.length === 3);
  check("bulkExport DE excludes US row", deCsv.body.indexOf(",US,") === -1);
  check("bulkExport DE excludes out-of-window", deCsv.body.indexOf("ancient") === -1);

  // JSON format round-trips with the same filter semantics.
  var deJson = await ctx.ledger.bulkExportByJurisdiction({
    jurisdiction: "DE", from: WINDOW_START, to: WINDOW_END, format: "json",
  });
  check("bulkExport DE JSON 3 rows",       deJson.rows.length === 3);
  check("bulkExport DE JSON all DE",       deJson.rows.every(function (r) { return r.jurisdiction === "DE"; }));
  check("bulkExport DE JSON within window",
    deJson.rows.every(function (r) { return r.occurred_at >= WINDOW_START && r.occurred_at < WINDOW_END; }));

  // US country filter narrows to one row.
  var usJson = await ctx.ledger.bulkExportByJurisdiction({
    jurisdiction: "US", from: WINDOW_START, to: WINDOW_END, format: "json",
  });
  check("bulkExport US JSON 1 row",        usJson.rows.length === 1);
  check("bulkExport US row is custC",      usJson.rows[0].customer_id === custC);

  // Refusals.
  await assert.rejects(ctx.ledger.bulkExportByJurisdiction(),                                              /input object required/);
  await assert.rejects(ctx.ledger.bulkExportByJurisdiction({ jurisdiction: "de", from: 0, to: 1 }),         /jurisdiction/);
  await assert.rejects(ctx.ledger.bulkExportByJurisdiction({ jurisdiction: "DE", from: -1, to: 1 }),        /from/);
  await assert.rejects(ctx.ledger.bulkExportByJurisdiction({ jurisdiction: "DE", from: 10, to: 5 }),        /to must be > from/);
  await assert.rejects(ctx.ledger.bulkExportByJurisdiction({ jurisdiction: "DE", from: 0, to: 1, format: "xml" }), /format/);
}

async function _complianceSummary() {
  var ctx = _setup();
  var custA = _uuid();
  var custB = _uuid();
  var custC = _uuid();

  // Mixed signup-form grants + preference-center withdrawals across
  // marketing_email and marketing_sms in DE; one US row to test
  // jurisdiction filter.
  await ctx.ledger.recordConsentChange({
    customer_id: custA, consent_kind: "marketing_email", state: "granted", source: "signup_form", jurisdiction: "DE",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: custB, consent_kind: "marketing_email", state: "granted", source: "signup_form", jurisdiction: "DE",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: custB, consent_kind: "marketing_email", state: "withdrawn", source: "preference_center", jurisdiction: "DE",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: custA, consent_kind: "marketing_sms", state: "granted", source: "signup_form", jurisdiction: "DE",
  });
  await ctx.ledger.recordConsentChange({
    customer_id: custC, consent_kind: "marketing_email", state: "granted", source: "signup_form", jurisdiction: "US",
  });

  var now = Date.now();
  var summary = await ctx.ledger.summarizeForCompliance({ from: 0, to: now + 1000000 });
  check("summary marketing_email signup_form granted = 3",
    summary.summary.marketing_email.signup_form.granted === 3);
  check("summary marketing_email preference_center withdrawn = 1",
    summary.summary.marketing_email.preference_center.withdrawn === 1);
  check("summary marketing_sms signup_form granted = 1",
    summary.summary.marketing_sms.signup_form.granted === 1);
  check("summary echoes jurisdiction = null when omitted",
    summary.jurisdiction === null);

  // Tuples never observed are omitted from the result map.
  check("summary omits never-observed kind",   summary.summary.data_sharing_partners === undefined);
  check("summary omits never-observed source", summary.summary.marketing_sms.preference_center === undefined);

  // Jurisdiction filter narrows the summary.
  var deOnly = await ctx.ledger.summarizeForCompliance({ from: 0, to: now + 1000000, jurisdiction: "DE" });
  check("summary DE marketing_email signup_form granted = 2",
    deOnly.summary.marketing_email.signup_form.granted === 2);
  check("summary DE echoes jurisdiction",       deOnly.jurisdiction === "DE");
  // The US row contributed +1 in the unfiltered summary; the DE-only
  // count must reflect the drop.
  check("summary DE excludes US row",
    deOnly.summary.marketing_email.signup_form.granted < summary.summary.marketing_email.signup_form.granted);

  // Refusals.
  await assert.rejects(ctx.ledger.summarizeForCompliance(),                                  /input object required/);
  await assert.rejects(ctx.ledger.summarizeForCompliance({ from: -1, to: 1 }),                /from/);
  await assert.rejects(ctx.ledger.summarizeForCompliance({ from: 10, to: 5 }),                /to must be > from/);
  await assert.rejects(ctx.ledger.summarizeForCompliance({ from: 0, to: 1, jurisdiction: "de" }), /jurisdiction/);
}

async function _appendOnly() {
  var ctx = _setup();
  var cust = _uuid();

  // Record three rows; assert the table grows monotonically and
  // none of the prior rows mutate. This is the GDPR art. 7(1)
  // guarantee — the controller MUST be able to demonstrate
  // historical consent state, which requires the prior rows to
  // survive every subsequent decision.
  var r1 = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "signup_form",
  });
  var r2 = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "withdrawn", source: "preference_center",
  });
  var r3 = await ctx.ledger.recordConsentChange({
    customer_id: cust, consent_kind: "marketing_email", state: "granted", source: "preference_center",
  });

  var raw = (await ctx.query("SELECT * FROM consent_ledger WHERE customer_id = ?1 ORDER BY occurred_at ASC", [cust])).rows;
  check("append-only: every recorded row persisted", raw.length === 3);
  check("append-only: r1 row unchanged",             raw[0].id === r1.id && raw[0].state === "granted");
  check("append-only: r2 row unchanged",             raw[1].id === r2.id && raw[1].state === "withdrawn");
  check("append-only: r3 row latest",                raw[2].id === r3.id && raw[2].state === "granted");

  // currentState collapses to the newest decision.
  var cur = await ctx.ledger.currentStateForCustomer(cust);
  check("append-only: current is newest grant",      cur.marketing_email.state === "granted");
  check("append-only: current id matches r3",        cur.marketing_email.occurred_at === r3.occurred_at);

  // The public surface exposes no UPDATE / DELETE path — the
  // primitive's returned object MUST NOT carry one. (Operators
  // can issue raw SQL for legitimate retention sweeps; the audit
  // story for that is outside this primitive's surface.)
  check("no public update method", typeof ctx.ledger.update === "undefined");
  check("no public delete method", typeof ctx.ledger.delete === "undefined");
  check("no public mutate method", typeof ctx.ledger.mutate === "undefined");
}

async function run() {
  await _recordConsentRefusals();
  await _lawfulBasisTagging();
  await _currentStateReflectsLatest();
  await _historyOrdering();
  await _auditExportCsvFormat();
  await _jurisdictionFilter();
  await _complianceSummary();
  await _appendOnly();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/consent-ledger.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — consent-ledger (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — consent-ledger: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
