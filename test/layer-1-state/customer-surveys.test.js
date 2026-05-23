"use strict";
/**
 * customer-surveys — post-purchase satisfaction / NPS / CSAT / CES
 * primitive. Operators define a survey once, the application issues
 * single-use plaintext-token invitations per (customer, source event),
 * the customer submits answers against the survey's question shapes,
 * and `rollup` computes the kind-specific aggregate.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0128.
 *
 * Coverage:
 *   - defineSurvey: persists row, refuses bad question shape, refuses
 *     kind-mismatched primary question (NPS without rating-10, etc.),
 *     idempotent on same-slug re-define
 *   - issueInvitation: plaintext token shown exactly once + storage
 *     row carries only the SHA3-512 hash; refuses unknown / archived
 *     survey
 *   - submitResponse: validates per-question shape (rating range /
 *     select option / free_text length); refuses duplicate response
 *     against same invitation; refuses expired / closed invitations;
 *     wrong token surfaces as not-found
 *   - rollup math: NPS = round(%promoters - %detractors); CSAT top-
 *     two-box %; per-question buckets seeded for zero-response cases
 *   - closeInvitation: operator-initiated revoke pre-response;
 *     refuses on already-responded
 *   - cleanupExpired: sweeps issued invitations past expires_at
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop           = require("../../lib");
var customerSurveys = require("../../lib/customer-surveys");
var helpers         = require("../helpers");
var check           = helpers.check;
var assert          = helpers.assert;

var MIG_SURVEYS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0128_customer_surveys.sql");

function _splitSchema(text) {
  // Strip line comments before splitting on `;` so a `--` line
  // doesn't comment out the closing paren of a CREATE TABLE.
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_SURVEYS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
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
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    surv:  customerSurveys.create({ query: h.query }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- defineSurvey shape -------------------------------------------------

async function _defineSurveyShape() {
  var f = _factory();
  var survey = await f.surv.defineSurvey({
    slug:    "post-delivery-nps",
    title:   "How likely are you to recommend us?",
    kind:    "nps",
    trigger: "after_delivery",
    questions: [
      { id: "score", kind: "rating", label: "On a scale of 0-10, how likely are you to recommend us?", max: 10 },
      { id: "why",   kind: "free_text", label: "What's the main reason for your score?", required: false },
    ],
  });
  check("defineSurvey returns row",         survey && survey.slug === "post-delivery-nps");
  check("defineSurvey kind persisted",      survey.kind === "nps");
  check("defineSurvey trigger persisted",   survey.trigger === "after_delivery");
  check("defineSurvey title persisted",     survey.title === "How likely are you to recommend us?");
  check("defineSurvey questions persisted", Array.isArray(survey.questions) && survey.questions.length === 2);
  check("defineSurvey created_at set",      typeof survey.created_at === "number");
  check("defineSurvey archived_at null",    survey.archived_at === null);
  check("defineSurvey primary rating max",  survey.questions[0].max === 10);
  check("defineSurvey free_text default required", survey.questions[1].required === false);

  // getSurvey round-trips.
  var fetched = await f.surv.getSurvey("post-delivery-nps");
  check("getSurvey round-trip",             fetched.slug === survey.slug);

  // Re-defining the same slug updates atomically.
  var updated = await f.surv.defineSurvey({
    slug:    "post-delivery-nps",
    title:   "Updated title",
    kind:    "nps",
    trigger: "after_delivery",
    questions: [
      { id: "score", kind: "rating", label: "Score", max: 10 },
    ],
  });
  check("defineSurvey re-define title",     updated.title === "Updated title");
  check("defineSurvey re-define questions", updated.questions.length === 1);

  // Kind-mismatched primary refused: NPS demands rating with max 10.
  await assert.rejects(
    f.surv.defineSurvey({
      slug:    "bad-nps",
      title:   "Bad",
      kind:    "nps",
      trigger: "manual",
      questions: [
        { id: "score", kind: "rating", label: "Score", max: 5 },
      ],
    }),
    /max === 10/,
  );

  // CSAT demands rating with max 5.
  await assert.rejects(
    f.surv.defineSurvey({
      slug:    "bad-csat",
      title:   "Bad",
      kind:    "csat",
      trigger: "manual",
      questions: [
        { id: "score", kind: "select", label: "Choose", options: ["good", "bad"] },
      ],
    }),
    /requires questions\[0\]\.kind === 'rating'/,
  );

  // Custom kind has no primary-question constraint.
  var custom = await f.surv.defineSurvey({
    slug:    "custom-survey",
    title:   "Anything",
    kind:    "custom",
    trigger: "manual",
    questions: [
      { id: "reason", kind: "select", label: "Why?", options: ["price", "quality", "service"] },
    ],
  });
  check("custom survey allows select primary", custom.kind === "custom"
                                                && custom.questions[0].kind === "select");
}

// ---- issueInvitation: plaintext shown once ------------------------------

async function _issueInvitationPlaintextOnce() {
  var f = _factory();
  await f.surv.defineSurvey({
    slug:    "delivery-csat",
    title:   "How was your delivery?",
    kind:    "csat",
    trigger: "after_delivery",
    questions: [
      { id: "score", kind: "rating", label: "Rate your delivery", max: 5 },
    ],
  });

  var customerId    = _uuid();
  var sourceEventId = "delivery-" + _uuid();

  var inv = await f.surv.issueInvitation({
    survey_slug:      "delivery-csat",
    customer_id:      customerId,
    source_event_id:  sourceEventId,
    expires_in_hours: 24,
  });
  check("issueInvitation returns id",              typeof inv.invitation_id === "string" && inv.invitation_id.length === 36);
  check("issueInvitation status issued",           inv.status === "issued");
  check("issueInvitation plaintext shape",          typeof inv.plaintext_token === "string"
                                                    && inv.plaintext_token.length === 43);
  check("issueInvitation customer persisted",       inv.customer_id === customerId);
  check("issueInvitation source event persisted",   inv.source_event_id === sourceEventId);
  check("issueInvitation expires future",           inv.expires_at > inv.issued_at);

  // Storage row carries ONLY the hash — plaintext never persisted.
  var storageRow = f.db.prepare(
    "SELECT token_hash, status, expires_at FROM survey_invitations WHERE id = ?",
  ).all(inv.invitation_id)[0];
  check("storage row has token_hash",               typeof storageRow.token_hash === "string"
                                                    && storageRow.token_hash.length > 0);
  check("storage row hash != plaintext",            storageRow.token_hash !== inv.plaintext_token);
  check("storage row status issued",                storageRow.status === "issued");

  // Re-reading the invitation row does NOT surface the plaintext.
  var fetched = await f.surv.getInvitation(inv.invitation_id);
  check("getInvitation never exposes plaintext",    !Object.prototype.hasOwnProperty.call(fetched, "plaintext_token"));
  check("getInvitation never exposes token_hash",   !Object.prototype.hasOwnProperty.call(fetched, "token_hash"));

  // invitationsForCustomer returns the row.
  var list = await f.surv.invitationsForCustomer(customerId);
  check("invitationsForCustomer returns issued",    list.length === 1 && list[0].id === inv.invitation_id);

  // issueInvitation refuses an unknown survey.
  await assert.rejects(
    f.surv.issueInvitation({
      survey_slug:  "nope",
      customer_id:  customerId,
    }),
    /not found/,
  );

  // Archived survey refuses new invitations.
  await f.surv.archiveSurvey("delivery-csat");
  await assert.rejects(
    f.surv.issueInvitation({ survey_slug: "delivery-csat", customer_id: customerId }),
    /is archived/,
  );
}

// ---- submitResponse: validates answers ----------------------------------

async function _submitResponseValidates() {
  var f = _factory();
  await f.surv.defineSurvey({
    slug:    "mixed-survey",
    title:   "Mixed",
    kind:    "custom",
    trigger: "manual",
    questions: [
      { id: "rate",   kind: "rating",    label: "Rate (1-5)", max: 5 },
      { id: "reason", kind: "select",    label: "Why?",        options: ["price", "service", "quality"] },
      { id: "more",   kind: "free_text", label: "Anything else?", required: false, max: 100 },
    ],
  });
  var customerId = _uuid();
  var inv = await f.surv.issueInvitation({
    survey_slug: "mixed-survey",
    customer_id: customerId,
  });

  // Valid submission round-trips.
  var resp = await f.surv.submitResponse({
    token:   inv.plaintext_token,
    answers: { rate: 4, reason: "service", more: "Liked the chat support." },
  });
  check("submitResponse returns id",            typeof resp.response_id === "string" && resp.response_id.length === 36);
  check("submitResponse answers canonicalized", resp.answers.rate === 4
                                                && resp.answers.reason === "service"
                                                && resp.answers.more === "Liked the chat support.");
  check("submitResponse responded_at set",       typeof resp.responded_at === "number");

  // Invitation moved to responded.
  var afterInv = await f.surv.getInvitation(inv.invitation_id);
  check("invitation now responded",              afterInv.status === "responded");
  check("invitation responded_at set",           typeof afterInv.responded_at === "number");

  // Second submit against same token refused.
  await assert.rejects(
    f.surv.submitResponse({
      token:   inv.plaintext_token,
      answers: { rate: 5, reason: "quality" },
    }),
    function (err) { return err && err.code === "SURVEY_INVITATION_ALREADY_RESPONDED"; },
  );

  // Bad rating: out of range.
  var inv2 = await f.surv.issueInvitation({ survey_slug: "mixed-survey", customer_id: _uuid() });
  await assert.rejects(
    f.surv.submitResponse({ token: inv2.plaintext_token, answers: { rate: 6, reason: "price" } }),
    /integer in \[0, 5\]/,
  );

  // Bad rating: non-integer.
  await assert.rejects(
    f.surv.submitResponse({ token: inv2.plaintext_token, answers: { rate: 3.5, reason: "price" } }),
    /integer in \[0, 5\]/,
  );

  // Bad select: outside option set.
  await assert.rejects(
    f.surv.submitResponse({ token: inv2.plaintext_token, answers: { rate: 3, reason: "bogus" } }),
    /must be one of/,
  );

  // Bad free_text: too long.
  var longStr = new Array(150).join("x");
  await assert.rejects(
    f.surv.submitResponse({
      token:   inv2.plaintext_token,
      answers: { rate: 3, reason: "price", more: longStr },
    }),
    /<= 100 chars/,
  );

  // Required missing: omitting `rate` refused.
  await assert.rejects(
    f.surv.submitResponse({ token: inv2.plaintext_token, answers: { reason: "price" } }),
    /required question/,
  );

  // Unknown question id refused.
  await assert.rejects(
    f.surv.submitResponse({
      token:   inv2.plaintext_token,
      answers: { rate: 3, reason: "price", phantom: "x" },
    }),
    /unknown question id/,
  );

  // Optional free_text can be omitted entirely.
  var inv3 = await f.surv.issueInvitation({ survey_slug: "mixed-survey", customer_id: _uuid() });
  var resp3 = await f.surv.submitResponse({
    token:   inv3.plaintext_token,
    answers: { rate: 5, reason: "quality" },
  });
  check("optional free_text omitted ok",          !Object.prototype.hasOwnProperty.call(resp3.answers, "more"));

  // Wrong token surfaces as not-found.
  var bogus = inv3.plaintext_token.slice(0, 42) + (inv3.plaintext_token.slice(-1) === "A" ? "B" : "A");
  await assert.rejects(
    f.surv.submitResponse({ token: bogus, answers: { rate: 3, reason: "price" } }),
    function (err) { return err && err.code === "SURVEY_INVITATION_NOT_FOUND"; },
  );
}

// ---- rollup math --------------------------------------------------------

async function _rollupNpsAndCsatMath() {
  var f = _factory();
  await f.surv.defineSurvey({
    slug:    "nps-survey",
    title:   "NPS",
    kind:    "nps",
    trigger: "after_delivery",
    questions: [{ id: "score", kind: "rating", label: "Score", max: 10 }],
  });

  // Issue + submit 10 responses with a known mix:
  //   - 5 promoters (9, 9, 10, 10, 10)
  //   - 2 passives  (7, 8)
  //   - 3 detractors (3, 5, 6)
  // %promoters = 50, %passives = 20, %detractors = 30
  // NPS score = 50 - 30 = 20
  var scores = [9, 9, 10, 10, 10, 7, 8, 3, 5, 6];
  for (var i = 0; i < scores.length; i += 1) {
    var inv = await f.surv.issueInvitation({
      survey_slug: "nps-survey",
      customer_id: _uuid(),
    });
    await f.surv.submitResponse({ token: inv.plaintext_token, answers: { score: scores[i] } });
  }

  var roll = await f.surv.rollup({ slug: "nps-survey" });
  check("rollup response_count",                roll.response_count === 10);
  check("rollup kind",                           roll.kind === "nps");
  check("rollup NPS score 20",                   roll.nps.score === 20);
  check("rollup NPS promoters 5",                roll.nps.promoters === 5);
  check("rollup NPS passives 2",                 roll.nps.passives === 2);
  check("rollup NPS detractors 3",               roll.nps.detractors === 3);
  check("rollup NPS promoter_pct 50",            roll.nps.promoter_pct === 50);
  check("rollup NPS detractor_pct 30",           roll.nps.detractor_pct === 30);

  // Empty survey rollup: score 0 + zero counts, distinguishable from
  // a low-score scenario via the response_count field.
  await f.surv.defineSurvey({
    slug:    "empty-nps",
    title:   "Empty",
    kind:    "nps",
    trigger: "manual",
    questions: [{ id: "score", kind: "rating", label: "Score", max: 10 }],
  });
  var emptyRoll = await f.surv.rollup({ slug: "empty-nps" });
  check("empty rollup response_count zero",     emptyRoll.response_count === 0);
  check("empty rollup NPS score zero",          emptyRoll.nps.score === 0);
  check("empty rollup NPS promoters zero",      emptyRoll.nps.promoters === 0);

  // CSAT math: 4 + 5 are positive, top-2-box %.
  await f.surv.defineSurvey({
    slug:    "csat-survey",
    title:   "CSAT",
    kind:    "csat",
    trigger: "after_support_close",
    questions: [{ id: "score", kind: "rating", label: "Score", max: 5 }],
  });
  var csatScores = [5, 5, 4, 3, 1];   // 3 positives, 1 neutral, 1 negative -> 60%
  for (var c = 0; c < csatScores.length; c += 1) {
    var ci = await f.surv.issueInvitation({ survey_slug: "csat-survey", customer_id: _uuid() });
    await f.surv.submitResponse({ token: ci.plaintext_token, answers: { score: csatScores[c] } });
  }
  var csatRoll = await f.surv.rollup({ slug: "csat-survey" });
  check("rollup CSAT positives 3",                csatRoll.csat.positives === 3);
  check("rollup CSAT positive_pct 60",            csatRoll.csat.positive_pct === 60);
  check("rollup CSAT mean 3.6",                   csatRoll.csat.mean === 3.6);

  // Per-question bucket includes every defined question even when
  // zero responses targeted it (the rollup primes the buckets from
  // the survey shape so the operator sees the same column list
  // regardless of how many responses landed).
  await f.surv.defineSurvey({
    slug:    "two-q-survey",
    title:   "Two",
    kind:    "custom",
    trigger: "manual",
    questions: [
      { id: "rate", kind: "rating", label: "Rate", max: 5 },
      { id: "why",  kind: "select", label: "Why?", options: ["a", "b"], required: false },
    ],
  });
  var tq = await f.surv.issueInvitation({ survey_slug: "two-q-survey", customer_id: _uuid() });
  await f.surv.submitResponse({ token: tq.plaintext_token, answers: { rate: 4 } });
  var tqRoll = await f.surv.rollup({ slug: "two-q-survey" });
  check("rollup per_question length matches questions", tqRoll.per_question.length === 2);
  var whyBucket = tqRoll.per_question.filter(function (q) { return q.id === "why"; })[0];
  check("zero-response select question still in rollup", whyBucket && whyBucket.count === 0);
  check("zero-response select keeps option buckets",     whyBucket.buckets.a === 0 && whyBucket.buckets.b === 0);

  // Unknown slug -> null
  var miss = await f.surv.rollup({ slug: "nope" });
  check("rollup unknown null",                   miss === null);
}

// ---- expiry + close FSM -------------------------------------------------

async function _expiryAndCloseFsm() {
  var f = _factory();
  await f.surv.defineSurvey({
    slug:    "ces-survey",
    title:   "CES",
    kind:    "ces",
    trigger: "after_support_close",
    questions: [{ id: "effort", kind: "rating", label: "How easy was it?", max: 7 }],
  });

  // Issue an invitation with a 1-hour window.
  var customerId = _uuid();
  var inv = await f.surv.issueInvitation({
    survey_slug:      "ces-survey",
    customer_id:      customerId,
    expires_in_hours: 1,
  });
  check("invitation expires_at > issued_at",     inv.expires_at - inv.issued_at >= 60 * 60 * 1000 - 10);

  // Hand-stamp expires_at into the past so cleanupExpired flips it.
  f.db.prepare("UPDATE survey_invitations SET expires_at = ? WHERE id = ?")
       .run(Date.now() - 1000, inv.invitation_id);

  // submitResponse refused once expired (status still 'issued' but
  // expires_at < now, so the primitive checks the window directly).
  await assert.rejects(
    f.surv.submitResponse({ token: inv.plaintext_token, answers: { effort: 5 } }),
    function (err) { return err && err.code === "SURVEY_INVITATION_EXPIRED"; },
  );

  // cleanupExpired sweeps the row to status=expired.
  var clean = await f.surv.cleanupExpired();
  check("cleanupExpired returns count",          clean.expired_count === 1);
  var after = await f.surv.getInvitation(inv.invitation_id);
  check("invitation now expired",                after.status === "expired");

  // closeInvitation pre-response.
  var inv2 = await f.surv.issueInvitation({ survey_slug: "ces-survey", customer_id: _uuid() });
  var closed = await f.surv.closeInvitation({
    invitation_id: inv2.invitation_id,
    reason:        "Customer opted out of all surveys.",
  });
  check("closeInvitation status closed",         closed.status === "closed");
  check("closeInvitation closed_at set",         typeof closed.closed_at === "number");
  check("closeInvitation closed_reason set",     closed.closed_reason === "Customer opted out of all surveys.");

  // Subsequent submit refused.
  await assert.rejects(
    f.surv.submitResponse({ token: inv2.plaintext_token, answers: { effort: 5 } }),
    function (err) { return err && err.code === "SURVEY_INVITATION_CLOSED"; },
  );

  // closeInvitation on already-closed refused.
  await assert.rejects(
    f.surv.closeInvitation({ invitation_id: inv2.invitation_id, reason: "again" }),
    function (err) { return err && err.code === "SURVEY_INVITATION_NOT_ISSUED"; },
  );

  // closeInvitation on responded refused.
  var inv3 = await f.surv.issueInvitation({ survey_slug: "ces-survey", customer_id: _uuid() });
  await f.surv.submitResponse({ token: inv3.plaintext_token, answers: { effort: 5 } });
  await assert.rejects(
    f.surv.closeInvitation({ invitation_id: inv3.invitation_id, reason: "too late" }),
    function (err) { return err && err.code === "SURVEY_INVITATION_NOT_ISSUED"; },
  );

  // closeInvitation on unknown id returns null.
  var miss = await f.surv.closeInvitation({ invitation_id: _uuid(), reason: "x" });
  check("closeInvitation unknown null",          miss === null);
}

// ---- responsesForSurvey -------------------------------------------------

async function _responsesForSurveyPagination() {
  var f = _factory();
  await f.surv.defineSurvey({
    slug:    "list-survey",
    title:   "List",
    kind:    "custom",
    trigger: "manual",
    questions: [{ id: "r", kind: "rating", label: "Rate", max: 5 }],
  });

  // Submit 5 responses.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var inv = await f.surv.issueInvitation({ survey_slug: "list-survey", customer_id: _uuid() });
    var resp = await f.surv.submitResponse({ token: inv.plaintext_token, answers: { r: (i % 5) + 1 } });
    ids.push(resp.response_id);
  }

  // First page with limit 3.
  var page1 = await f.surv.responsesForSurvey({ slug: "list-survey", limit: 3 });
  check("page1 rows length 3",                   page1.rows.length === 3);
  check("page1 next_cursor set",                 typeof page1.next_cursor === "string");

  // Second page with cursor.
  var page2 = await f.surv.responsesForSurvey({
    slug:   "list-survey",
    limit:  3,
    cursor: page1.next_cursor,
  });
  check("page2 rows length 2",                   page2.rows.length === 2);
  check("page2 next_cursor null",                page2.next_cursor === null);

  // No duplicates across pages.
  var seen = Object.create(null);
  page1.rows.concat(page2.rows).forEach(function (r) { seen[r.id] = (seen[r.id] || 0) + 1; });
  check("pagination no dupes",                   Object.keys(seen).every(function (k) { return seen[k] === 1; }));
}

// ---- validation surface -------------------------------------------------

async function _validationSurface() {
  var f = _factory();

  // defineSurvey
  await assert.rejects(f.surv.defineSurvey(),                                          /input object required/);
  await assert.rejects(f.surv.defineSurvey({}),                                        /slug/);
  await assert.rejects(f.surv.defineSurvey({ slug: "Bad Slug" }),                      /slug/);
  await assert.rejects(f.surv.defineSurvey({ slug: "ok", title: "" }),                 /title/);
  await assert.rejects(f.surv.defineSurvey({ slug: "ok", title: "T", kind: "bogus" }), /kind/);
  await assert.rejects(f.surv.defineSurvey({
    slug: "ok", title: "T", kind: "custom", trigger: "bogus",
  }), /trigger/);
  await assert.rejects(f.surv.defineSurvey({
    slug: "ok", title: "T", kind: "custom", trigger: "manual", questions: [],
  }), /non-empty array/);
  await assert.rejects(f.surv.defineSurvey({
    slug: "ok", title: "T", kind: "custom", trigger: "manual",
    questions: [{ id: "Bad ID", kind: "rating", label: "L" }],
  }), /id must be lowercase/);
  await assert.rejects(f.surv.defineSurvey({
    slug: "ok", title: "T", kind: "custom", trigger: "manual",
    questions: [{ id: "q1", kind: "bogus", label: "L" }],
  }), /kind must be one of/);
  await assert.rejects(f.surv.defineSurvey({
    slug: "ok", title: "T", kind: "custom", trigger: "manual",
    questions: [{ id: "q1", kind: "select", label: "L", options: [] }],
  }), /options must be a non-empty array/);
  await assert.rejects(f.surv.defineSurvey({
    slug: "ok", title: "T", kind: "custom", trigger: "manual",
    questions: [
      { id: "q1", kind: "rating", label: "A", max: 5 },
      { id: "q1", kind: "rating", label: "B", max: 5 },
    ],
  }), /duplicates a previous entry/);

  // Seed a real survey for the entry-point tests.
  await f.surv.defineSurvey({
    slug:    "live",
    title:   "Live",
    kind:    "custom",
    trigger: "manual",
    questions: [{ id: "r", kind: "rating", label: "Rate", max: 5 }],
  });

  // issueInvitation
  await assert.rejects(f.surv.issueInvitation(),                                              /input object required/);
  await assert.rejects(f.surv.issueInvitation({ survey_slug: "Bad" }),                        /survey_slug/);
  await assert.rejects(f.surv.issueInvitation({ survey_slug: "live", customer_id: "x" }),     /customer_id/);
  await assert.rejects(f.surv.issueInvitation({
    survey_slug: "live", customer_id: _uuid(), expires_in_hours: 0,
  }), /expires_in_hours/);
  await assert.rejects(f.surv.issueInvitation({
    survey_slug: "live", customer_id: _uuid(), expires_in_hours: 999999,
  }), /expires_in_hours/);

  // submitResponse
  await assert.rejects(f.surv.submitResponse(),                                               /input object required/);
  await assert.rejects(f.surv.submitResponse({ token: "" }),                                  /token/);
  await assert.rejects(f.surv.submitResponse({ token: "not-a-valid-token-shape-too-short" }), /token/);
  await assert.rejects(f.surv.submitResponse({
    token: "A".repeat(43), answers: { r: 1 },
  }), function (err) { return err && err.code === "SURVEY_INVITATION_NOT_FOUND"; });

  // closeInvitation
  await assert.rejects(f.surv.closeInvitation(),                                              /input object required/);
  await assert.rejects(f.surv.closeInvitation({ invitation_id: "x", reason: "r" }),           /invitation_id/);
  await assert.rejects(f.surv.closeInvitation({ invitation_id: _uuid(), reason: "" }),        /reason/);

  // responsesForSurvey
  await assert.rejects(f.surv.responsesForSurvey(),                                           /input object required/);
  await assert.rejects(f.surv.responsesForSurvey({ slug: "Bad" }),                            /slug/);
  await assert.rejects(f.surv.responsesForSurvey({ slug: "live", limit: 0 }),                 /limit/);
  await assert.rejects(f.surv.responsesForSurvey({ slug: "live", from: 100, to: 50 }),        /from must be <= to/);

  // rollup
  await assert.rejects(f.surv.rollup(),                                                       /input object required/);
  await assert.rejects(f.surv.rollup({ slug: "Bad" }),                                        /slug/);

  // invitationsForCustomer
  await assert.rejects(f.surv.invitationsForCustomer("not-a-uuid"),                           /customer_id/);

  // getSurvey
  await assert.rejects(f.surv.getSurvey("Bad Slug"),                                          /slug/);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("KINDS exported",                  Array.isArray(customerSurveys.KINDS)
                                            && customerSurveys.KINDS.indexOf("nps") !== -1
                                            && customerSurveys.KINDS.indexOf("csat") !== -1
                                            && customerSurveys.KINDS.indexOf("ces") !== -1
                                            && customerSurveys.KINDS.indexOf("custom") !== -1);
  check("TRIGGERS exported",               Array.isArray(customerSurveys.TRIGGERS)
                                            && customerSurveys.TRIGGERS.indexOf("after_delivery") !== -1
                                            && customerSurveys.TRIGGERS.indexOf("manual") !== -1);
  check("QUESTION_KINDS exported",         Array.isArray(customerSurveys.QUESTION_KINDS)
                                            && customerSurveys.QUESTION_KINDS.indexOf("rating") !== -1);
  check("INVITATION_STATUSES exported",    Array.isArray(customerSurveys.INVITATION_STATUSES)
                                            && customerSurveys.INVITATION_STATUSES.indexOf("issued") !== -1);
  check("TOKEN_NAMESPACE exported",        typeof customerSurveys.TOKEN_NAMESPACE === "string"
                                            && customerSurveys.TOKEN_NAMESPACE.length > 0);
  check("TOKEN_PLAINTEXT_LEN 43",          customerSurveys.TOKEN_PLAINTEXT_LEN === 43);

  var inst = customerSurveys.create({ query: _makeQuery().query });
  check("instance exposes KINDS",          inst.KINDS.length === customerSurveys.KINDS.length);
  check("instance exposes TRIGGERS",       inst.TRIGGERS.length === customerSurveys.TRIGGERS.length);
}

async function run() {
  await _defineSurveyShape();
  await _issueInvitationPlaintextOnce();
  await _submitResponseValidates();
  await _rollupNpsAndCsatMath();
  await _expiryAndCloseFsm();
  await _responsesForSurveyPagination();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - customer-surveys (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
