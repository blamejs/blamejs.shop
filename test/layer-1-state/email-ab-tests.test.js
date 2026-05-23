"use strict";
/**
 * email-ab-tests — subject + body experiments with deterministic
 * per-recipient variant assignment + Wilson 95% CI on open + click
 * rates.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0169.
 *
 * Coverage:
 *   - defineTest: persists row, validates variants[] (>=2, weights,
 *     overrides), refuses zero-override tests, refuses duplicate slug
 *   - getVariantForRecipient: deterministic per (test_id,
 *     recipient_id) — same recipient always picks same variant;
 *     hash-bucket distribution tracks declared weights (3000-sample
 *     75/25 split landing within 5pp)
 *   - recordEmailSent: only on running test; refuses sent on
 *     paused/concluded; idempotent on (recipient, variant) replay
 *   - recordOpen / recordClick: refuse on un-sent (recipient, variant);
 *     idempotent on replay
 *   - metricsForTest: Wilson CI bounds present, rate math correct,
 *     per_variant rows seeded for every variant even with zero events
 *   - FSM: draft -> running -> paused -> running -> concluded;
 *     archive terminal
 *   - validation surface: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var emailABTests   = require("../../lib/email-ab-tests");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_AB        = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0169_email_ab_tests.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_AB, "utf8")).forEach(function (s) {
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
    ab:    emailABTests.create({ query: h.query }),
  };
}

function _validVariants() {
  return [
    { id: "a", label: "Short subject", weight: 1, subject: "Welcome!" },
    { id: "b", label: "Long subject",  weight: 1, subject: "Welcome to the shop — let's get you set up" },
  ];
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- defineTest shape --------------------------------------------------

async function _defineTestShape() {
  var f = _factory();
  var defined = await f.ab.defineTest({
    slug:          "welcome-subject-v1",
    title:         "Welcome — short vs long subject",
    template_slug: "welcome-default",
    variants:      _validVariants(),
  });
  check("defineTest returns row",            defined && defined.slug === "welcome-subject-v1");
  check("defineTest status draft",           defined.status === "draft");
  check("defineTest id v7",                  typeof defined.id === "string" && defined.id.length === 36);
  check("defineTest title persisted",        defined.title === "Welcome — short vs long subject");
  check("defineTest variants persisted",     Array.isArray(defined.variants) && defined.variants.length === 2);
  check("defineTest variant a weight 1",     defined.variants[0].weight === 1);
  check("defineTest started_at null",        defined.started_at === null);
  check("defineTest created_at set",         typeof defined.created_at === "number");

  // getTest round-trips.
  var got = await f.ab.getTest("welcome-subject-v1");
  check("getTest round-trip",                got.id === defined.id);

  // Duplicate slug refused.
  await assert.rejects(
    f.ab.defineTest({
      slug:          "welcome-subject-v1",
      title:         "dup",
      template_slug: "welcome-default",
      variants:      _validVariants(),
    }),
    /already exists/,
  );

  // < 2 variants refused.
  await assert.rejects(
    f.ab.defineTest({
      slug:          "bad-1",
      title:         "x",
      template_slug: "welcome-default",
      variants:      [{ id: "only", label: "Only", weight: 1, subject: "x" }],
    }),
    /at least 2 entries/,
  );

  // Duplicate variant id refused.
  await assert.rejects(
    f.ab.defineTest({
      slug:          "bad-2",
      title:         "x",
      template_slug: "welcome-default",
      variants:      [
        { id: "a", label: "A", weight: 1, subject: "a" },
        { id: "a", label: "A again", weight: 1, subject: "a2" },
      ],
    }),
    /duplicates a previous entry/,
  );

  // Zero-override test refused (every variant identical content).
  await assert.rejects(
    f.ab.defineTest({
      slug:          "bad-3",
      title:         "x",
      template_slug: "welcome-default",
      variants:      [
        { id: "a", label: "A", weight: 1 },
        { id: "b", label: "B", weight: 1 },
      ],
    }),
    /at least one variant must override/,
  );

  // Non-positive weight refused.
  await assert.rejects(
    f.ab.defineTest({
      slug:          "bad-4",
      title:         "x",
      template_slug: "welcome-default",
      variants:      [
        { id: "a", label: "A", weight: 0, subject: "a" },
        { id: "b", label: "B", weight: 1, subject: "b" },
      ],
    }),
    /weight must be a positive integer/,
  );
}

// ---- deterministic assignment ------------------------------------------

async function _assignmentDeterministic() {
  var f = _factory();
  await f.ab.defineTest({
    slug:          "det-test",
    title:         "Deterministic",
    template_slug: "x",
    variants:      _validVariants(),
  });
  await f.ab.startTest("det-test");

  // Same recipient -> same variant across repeated calls.
  var recipient = _uuid();
  var first = await f.ab.getVariantForRecipient({
    test_slug: "det-test", recipient_id: recipient,
  });
  for (var i = 0; i < 5; i += 1) {
    var again = await f.ab.getVariantForRecipient({
      test_slug: "det-test", recipient_id: recipient,
    });
    check("recipient lands same variant on repeat",
          again.variant.id === first.variant.id);
  }
  check("assignment carries variant overrides",
        typeof first.variant.subject === "string" && first.variant.subject.length > 0);
  check("first call not sticky (no sent event yet)",
        first.sticky === false);

  // Anchor a 'sent' event; subsequent calls are sticky.
  await f.ab.recordEmailSent({
    test_slug:    "det-test",
    recipient_id: recipient,
    variant_id:   first.variant.id,
  });
  var sticky = await f.ab.getVariantForRecipient({
    test_slug: "det-test", recipient_id: recipient,
  });
  check("post-send is sticky",                  sticky.sticky === true);
  check("post-send same variant",                sticky.variant.id === first.variant.id);

  // Two different recipients can land different variants — sample 50,
  // expect at least one of each at weight 1:1.
  var seen = {};
  for (var k = 0; k < 50; k += 1) {
    var rec = _uuid();
    var a = await f.ab.getVariantForRecipient({ test_slug: "det-test", recipient_id: rec });
    seen[a.variant.id] = (seen[a.variant.id] || 0) + 1;
  }
  check("both variants seen across 50 recipients",
        seen.a > 0 && seen.b > 0);
}

// ---- weight split at scale ---------------------------------------------

async function _weightSplitAtScale() {
  var f = _factory();
  await f.ab.defineTest({
    slug:          "split-3to1",
    title:         "75/25 split",
    template_slug: "x",
    variants: [
      { id: "a", label: "A", weight: 3, subject: "Subject A" },
      { id: "b", label: "B", weight: 1, subject: "Subject B" },
    ],
  });
  await f.ab.startTest("split-3to1");

  var N = 3000;
  var counts = { a: 0, b: 0 };
  for (var i = 0; i < N; i += 1) {
    // Stable, unique-per-iteration recipient_id — using a UUID gives
    // 3000 independent hash inputs without test-level state.
    var rec = _uuid();
    var assignment = await f.ab.getVariantForRecipient({
      test_slug: "split-3to1", recipient_id: rec,
    });
    counts[assignment.variant.id] += 1;
  }
  var pctA = (counts.a / N) * 100;
  var pctB = (counts.b / N) * 100;
  // 5pp tolerance on each side of the declared 75/25.
  check("3000-sample split A ~ 75% (+/-5pp)",
        pctA >= 70 && pctA <= 80);
  check("3000-sample split B ~ 25% (+/-5pp)",
        pctB >= 20 && pctB <= 30);
  check("sample counts sum to N",                counts.a + counts.b === N);
}

// ---- ledger events ------------------------------------------------------

async function _ledgerEvents() {
  var f = _factory();
  await f.ab.defineTest({
    slug:          "ledger-test",
    title:         "Ledger",
    template_slug: "x",
    variants:      _validVariants(),
  });
  await f.ab.startTest("ledger-test");

  var rec     = _uuid();
  var pick    = await f.ab.getVariantForRecipient({ test_slug: "ledger-test", recipient_id: rec });
  var variant = pick.variant.id;

  var sentEv = await f.ab.recordEmailSent({
    test_slug:    "ledger-test",
    recipient_id: rec,
    variant_id:   variant,
  });
  check("recordEmailSent returns event id",      typeof sentEv.event_id === "string" && sentEv.event_id.length === 36);
  check("recordEmailSent kind sent",              sentEv.kind === "sent");
  check("recordEmailSent variant carried",        sentEv.variant_id === variant);
  check("recordEmailSent not duplicate first",    sentEv.duplicate === false);

  // Replay -> duplicate, same event id.
  var dupSent = await f.ab.recordEmailSent({
    test_slug:    "ledger-test",
    recipient_id: rec,
    variant_id:   variant,
  });
  check("recordEmailSent replay is idempotent",   dupSent.duplicate === true);
  check("recordEmailSent replay same event_id",   dupSent.event_id === sentEv.event_id);

  // Open + click against the assigned variant.
  var openEv = await f.ab.recordOpen({
    test_slug:    "ledger-test",
    recipient_id: rec,
    variant_id:   variant,
  });
  check("recordOpen kind opened",                 openEv.kind === "opened");
  var dupOpen = await f.ab.recordOpen({
    test_slug:    "ledger-test",
    recipient_id: rec,
    variant_id:   variant,
  });
  check("recordOpen replay is idempotent",        dupOpen.duplicate === true);

  var clickEv = await f.ab.recordClick({
    test_slug:    "ledger-test",
    recipient_id: rec,
    variant_id:   variant,
  });
  check("recordClick kind clicked",                clickEv.kind === "clicked");

  // Open without a prior sent refused.
  var rec2 = _uuid();
  await assert.rejects(
    f.ab.recordOpen({ test_slug: "ledger-test", recipient_id: rec2, variant_id: variant }),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_SENT"; },
  );
  // Click without a prior sent refused.
  await assert.rejects(
    f.ab.recordClick({ test_slug: "ledger-test", recipient_id: rec2, variant_id: variant }),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_SENT"; },
  );
}

// ---- metricsForTest + Wilson CI ----------------------------------------

async function _metricsAndWilson() {
  var f = _factory();
  await f.ab.defineTest({
    slug:          "metrics-test",
    title:         "Metrics",
    template_slug: "x",
    variants: [
      { id: "a", label: "A", weight: 1, subject: "A" },
      { id: "b", label: "B", weight: 1, subject: "B" },
    ],
  });
  await f.ab.startTest("metrics-test");

  // Force assignment to a specific variant by recording the desired
  // 'sent' row directly: the primitive's sticky-assignment guard then
  // returns that variant for the recipient on subsequent reads. We
  // use this here to seed deterministic metrics — picking 20
  // recipients on variant a (10 opened, 5 clicked) and 20 on
  // variant b (4 opened, 1 clicked).
  async function _sendToVariant(variantId) {
    var rec = _uuid();
    await f.ab.recordEmailSent({
      test_slug: "metrics-test", recipient_id: rec, variant_id: variantId,
    });
    return rec;
  }

  var aRecipients = [];
  for (var i = 0; i < 20; i += 1) aRecipients.push(await _sendToVariant("a"));
  // 10 opens on a, 5 clicks on a (subset of the openers).
  for (var oa = 0; oa < 10; oa += 1) {
    await f.ab.recordOpen({ test_slug: "metrics-test", recipient_id: aRecipients[oa], variant_id: "a" });
  }
  for (var ca = 0; ca < 5; ca += 1) {
    await f.ab.recordClick({ test_slug: "metrics-test", recipient_id: aRecipients[ca], variant_id: "a" });
  }

  var bRecipients = [];
  for (var j = 0; j < 20; j += 1) bRecipients.push(await _sendToVariant("b"));
  for (var ob = 0; ob < 4; ob += 1) {
    await f.ab.recordOpen({ test_slug: "metrics-test", recipient_id: bRecipients[ob], variant_id: "b" });
  }
  for (var cb = 0; cb < 1; cb += 1) {
    await f.ab.recordClick({ test_slug: "metrics-test", recipient_id: bRecipients[cb], variant_id: "b" });
  }

  var m = await f.ab.metricsForTest("metrics-test");
  check("metrics returns per_variant length 2",     m.per_variant.length === 2);
  var aMet = m.per_variant.filter(function (v) { return v.variant_id === "a"; })[0];
  var bMet = m.per_variant.filter(function (v) { return v.variant_id === "b"; })[0];
  check("metrics A sent 20",                         aMet.sent === 20);
  check("metrics A opened 10",                       aMet.opened === 10);
  check("metrics A clicked 5",                       aMet.clicked === 5);
  check("metrics A open_rate 0.5",                   aMet.open_rate.rate === 0.5);
  check("metrics A click_rate 0.25",                 aMet.click_rate.rate === 0.25);
  // Wilson 95% CI bounds present + sensible.
  check("metrics A open_rate lower < rate",          aMet.open_rate.lower < aMet.open_rate.rate);
  check("metrics A open_rate upper > rate",          aMet.open_rate.upper > aMet.open_rate.rate);
  check("metrics A open_rate lower >= 0",            aMet.open_rate.lower >= 0);
  check("metrics A open_rate upper <= 1",            aMet.open_rate.upper <= 1);
  check("metrics A open_rate n=20 k=10",             aMet.open_rate.n === 20 && aMet.open_rate.k === 10);

  check("metrics B sent 20",                         bMet.sent === 20);
  check("metrics B opened 4",                        bMet.opened === 4);
  check("metrics B clicked 1",                       bMet.clicked === 1);
  check("metrics B open_rate 0.2",                   bMet.open_rate.rate === 0.2);

  // Totals across both variants.
  check("metrics totals sent 40",                    m.totals.sent === 40);
  check("metrics totals opened 14",                  m.totals.opened === 14);
  check("metrics totals clicked 6",                  m.totals.clicked === 6);

  // Zero-data test: every per_variant row seeded with 0s.
  await f.ab.defineTest({
    slug:          "empty-test",
    title:         "Empty",
    template_slug: "x",
    variants:      _validVariants(),
  });
  var emptyM = await f.ab.metricsForTest("empty-test");
  check("empty metrics per_variant length 2",        emptyM.per_variant.length === 2);
  check("empty metrics per_variant sent 0",          emptyM.per_variant[0].sent === 0);
  check("empty metrics per_variant open_rate rate 0", emptyM.per_variant[0].open_rate.rate === 0);
  check("empty metrics per_variant open_rate lower 0", emptyM.per_variant[0].open_rate.lower === 0);
  check("empty metrics per_variant open_rate upper 0", emptyM.per_variant[0].open_rate.upper === 0);

  // Unknown slug -> null.
  var miss = await f.ab.metricsForTest("nope");
  check("metricsForTest unknown -> null",            miss === null);
}

// ---- FSM transitions ---------------------------------------------------

async function _fsmTransitions() {
  var f = _factory();
  await f.ab.defineTest({
    slug:          "fsm-test",
    title:         "FSM",
    template_slug: "x",
    variants:      _validVariants(),
  });

  // recordEmailSent refused while draft.
  await assert.rejects(
    f.ab.recordEmailSent({ test_slug: "fsm-test", recipient_id: _uuid(), variant_id: "a" }),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_RUNNING"; },
  );

  // start.
  var started = await f.ab.startTest("fsm-test");
  check("startTest -> running",                  started.status === "running");
  check("startTest started_at set",               typeof started.started_at === "number");

  // double-start refused.
  await assert.rejects(
    f.ab.startTest("fsm-test"),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_DRAFT"; },
  );

  // Send under running.
  var rec = _uuid();
  await f.ab.recordEmailSent({ test_slug: "fsm-test", recipient_id: rec, variant_id: "a" });

  // Pause.
  var paused = await f.ab.pauseTest("fsm-test");
  check("pauseTest -> paused",                   paused.status === "paused");
  check("pauseTest paused_at set",                typeof paused.paused_at === "number");

  // recordEmailSent refused while paused.
  await assert.rejects(
    f.ab.recordEmailSent({ test_slug: "fsm-test", recipient_id: _uuid(), variant_id: "a" }),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_RUNNING"; },
  );

  // Late opens/clicks against an already-sent recipient still allowed
  // while paused — the pixel firing after the customer received the
  // email shouldn't be dropped because the test paused mid-flight.
  var lateOpen = await f.ab.recordOpen({ test_slug: "fsm-test", recipient_id: rec, variant_id: "a" });
  check("recordOpen accepted while paused",      lateOpen.kind === "opened");

  // Resume.
  var resumed = await f.ab.resumeTest("fsm-test");
  check("resumeTest -> running",                 resumed.status === "running");
  check("resumeTest paused_at cleared",          resumed.paused_at === null);

  // Conclude with a winner.
  var concluded = await f.ab.concludeTest("fsm-test", { winner_variant_id: "a" });
  check("concludeTest -> concluded",             concluded.status === "concluded");
  check("concludeTest winner persisted",         concluded.winner_variant_id === "a");
  check("concludeTest concluded_at set",         typeof concluded.concluded_at === "number");

  // recordEmailSent refused while concluded.
  await assert.rejects(
    f.ab.recordEmailSent({ test_slug: "fsm-test", recipient_id: _uuid(), variant_id: "a" }),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_RUNNING"; },
  );

  // Late opens still accepted while concluded (post-test pixel).
  var rec2 = _uuid();
  // First need a sent event during the running phase for the pre-condition.
  // Use the rec we sent during running and record another open.
  // The replay path returns duplicate=true.
  var dup = await f.ab.recordOpen({ test_slug: "fsm-test", recipient_id: rec, variant_id: "a" });
  check("late open replay duplicate",            dup.duplicate === true);
  void rec2;

  // concludeTest with non-existent variant refused.
  await f.ab.defineTest({
    slug:          "fsm-2",
    title:         "FSM2",
    template_slug: "x",
    variants:      _validVariants(),
  });
  await f.ab.startTest("fsm-2");
  await assert.rejects(
    f.ab.concludeTest("fsm-2", { winner_variant_id: "ghost" }),
    /not one of the test's variants/,
  );

  // archiveTest is terminal.
  var arch = await f.ab.archiveTest("fsm-2");
  check("archiveTest -> archived",               arch.status === "archived");
  check("archiveTest archived_at set",           typeof arch.archived_at === "number");
  // re-archive idempotent.
  var arch2 = await f.ab.archiveTest("fsm-2");
  check("archiveTest idempotent",                arch2.status === "archived");
  // recordEmailSent / recordOpen refused on archived.
  await assert.rejects(
    f.ab.recordEmailSent({ test_slug: "fsm-2", recipient_id: _uuid(), variant_id: "a" }),
    function (err) { return err && err.code === "EMAIL_AB_TEST_ARCHIVED"; },
  );
  await assert.rejects(
    f.ab.getVariantForRecipient({ test_slug: "fsm-2", recipient_id: _uuid() }),
    function (err) { return err && err.code === "EMAIL_AB_TEST_ARCHIVED"; },
  );
}

// ---- listTests ----------------------------------------------------------

async function _listTests() {
  var f = _factory();
  await f.ab.defineTest({ slug: "t1", title: "T1", template_slug: "x", variants: _validVariants() });
  await f.ab.defineTest({ slug: "t2", title: "T2", template_slug: "x", variants: _validVariants() });
  await f.ab.startTest("t2");

  var all = await f.ab.listTests();
  check("listTests returns both",                all.length === 2);

  var running = await f.ab.listTests({ status: "running" });
  check("listTests filter running",              running.length === 1 && running[0].slug === "t2");

  var draft = await f.ab.listTests({ status: "draft" });
  check("listTests filter draft",                draft.length === 1 && draft[0].slug === "t1");

  // Unknown status refused.
  await assert.rejects(
    f.ab.listTests({ status: "bogus" }),
    /status must be one of/,
  );
}

// ---- validation surface ------------------------------------------------

async function _validationSurface() {
  var f = _factory();
  await assert.rejects(f.ab.defineTest(),                                              /input object required/);
  await assert.rejects(f.ab.defineTest({}),                                            /slug/);
  await assert.rejects(f.ab.defineTest({ slug: "Bad Slug" }),                           /slug/);
  await assert.rejects(f.ab.defineTest({ slug: "ok", title: "" }),                      /title/);
  await assert.rejects(f.ab.defineTest({ slug: "ok", title: "T" }),                     /template_slug/);
  await assert.rejects(
    f.ab.defineTest({ slug: "ok", title: "T", template_slug: "tpl" }),
    /variants must be an array/,
  );
  await assert.rejects(
    f.ab.defineTest({ slug: "ok", title: "T", template_slug: "tpl", variants: [] }),
    /at least 2 entries/,
  );

  // Seed for entry-point tests.
  await f.ab.defineTest({
    slug:          "live",
    title:         "L",
    template_slug: "tpl",
    variants:      _validVariants(),
  });

  // getVariantForRecipient
  await assert.rejects(f.ab.getVariantForRecipient(),                                   /input object required/);
  await assert.rejects(f.ab.getVariantForRecipient({}),                                 /test_slug/);
  await assert.rejects(f.ab.getVariantForRecipient({ test_slug: "live" }),              /recipient_id/);
  await assert.rejects(
    f.ab.getVariantForRecipient({ test_slug: "live", recipient_id: "" }),
    /recipient_id/,
  );
  // Unknown test
  await assert.rejects(
    f.ab.getVariantForRecipient({ test_slug: "nope", recipient_id: _uuid() }),
    /not found/,
  );

  // recordEmailSent
  await assert.rejects(f.ab.recordEmailSent(),                                          /input object required/);
  await assert.rejects(
    f.ab.recordEmailSent({ test_slug: "live", recipient_id: _uuid() }),
    /variant_id/,
  );
  await assert.rejects(
    f.ab.recordEmailSent({ test_slug: "live", recipient_id: _uuid(), variant_id: "Bad ID" }),
    /variant_id/,
  );

  // metricsForTest unknown
  var miss = await f.ab.metricsForTest("nope");
  check("metricsForTest unknown -> null",                miss === null);

  // FSM error codes
  await assert.rejects(
    f.ab.pauseTest("live"),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_RUNNING"; },
  );
  await assert.rejects(
    f.ab.resumeTest("live"),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_PAUSED"; },
  );
  await assert.rejects(
    f.ab.concludeTest("live"),
    function (err) { return err && err.code === "EMAIL_AB_TEST_NOT_ACTIVE"; },
  );

  // archiveTest unknown -> null (not error)
  var archMiss = await f.ab.archiveTest("nope");
  check("archiveTest unknown -> null",                  archMiss === null);
}

// ---- exported constants ------------------------------------------------

async function _exportedConstants() {
  check("STATUSES exported",                  Array.isArray(emailABTests.STATUSES)
                                                && emailABTests.STATUSES.indexOf("draft") !== -1
                                                && emailABTests.STATUSES.indexOf("concluded") !== -1);
  check("EVENT_KINDS exported",               Array.isArray(emailABTests.EVENT_KINDS)
                                                && emailABTests.EVENT_KINDS.indexOf("sent") !== -1
                                                && emailABTests.EVENT_KINDS.indexOf("opened") !== -1
                                                && emailABTests.EVENT_KINDS.indexOf("clicked") !== -1);
  check("ASSIGNMENT_NAMESPACE exported",      typeof emailABTests.ASSIGNMENT_NAMESPACE === "string"
                                                && emailABTests.ASSIGNMENT_NAMESPACE.length > 0);
  check("ASSIGNMENT_BUCKETS 100k",            emailABTests.ASSIGNMENT_BUCKETS === 100000);
  check("MIN_VARIANTS 2",                     emailABTests.MIN_VARIANTS === 2);
  check("WILSON_Z 1.96",                      emailABTests.WILSON_Z === 1.96);

  var inst = emailABTests.create({ query: _makeQuery().query });
  check("instance exposes STATUSES",          inst.STATUSES.length === emailABTests.STATUSES.length);
}

async function run() {
  await _defineTestShape();
  await _assignmentDeterministic();
  await _weightSplitAtScale();
  await _ledgerEvents();
  await _metricsAndWilson();
  await _fsmTransitions();
  await _listTests();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - email-ab-tests (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
