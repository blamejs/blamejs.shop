"use strict";
/**
 * banner-ab-tests — split-test promo-banner variants with
 * deterministic per-session assignment and an impression / click /
 * conversion ledger.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0174.
 *
 * Coverage:
 *   - defineTest persists row + variants, refuses duplicate slug,
 *     refuses non-existent banner when promoBanners is wired in,
 *     refuses bad shape (single-variant, bad weight, bad slug, etc.)
 *   - getVariantForSession deterministic across repeated calls and
 *     across recreated factory instances on the same backing store;
 *     respects weight splits in a statistical sense over many sessions
 *   - recordImpression / recordClick / recordConversion append the
 *     ledger row at the assigned variant + drop-silent on archived /
 *     concluded / paused / out-of-window / unknown
 *   - metricsForTest computes Wilson 95% CI bounds correctly
 *     (sanity-checked vs. hand-computed proportion math), and lower
 *     <= rate <= upper at every variant
 *   - FSM: running -> paused -> running -> concluded -> archived;
 *     invalid edges refused with code
 *     BANNER_AB_TEST_INVALID_TRANSITION
 *   - concludeTest records winner when supplied + refuses winner
 *     outside the variant catalogue
 *   - listTests filters by status + paginates by slug cursor
 *   - validation surface: every operator entry point refuses bad
 *     input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var bannerABTests  = require("../../lib/banner-ab-tests");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0174_banner_ab_tests.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _stubPromoBanners(map) {
  // Minimal promoBanners shim — only `getBanner` is needed at
  // defineTest. Map keys are banner slugs; values are either a
  // banner row stub (with optional `archived_at`) or null/undefined
  // meaning the banner doesn't exist.
  return {
    getBanner: async function (slug) {
      if (!Object.prototype.hasOwnProperty.call(map, slug)) return null;
      var entry = map[slug];
      if (entry == null) return null;
      return { slug: slug, archived_at: entry.archived_at != null ? entry.archived_at : null };
    },
  };
}

function _factory(promoStub) {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    ab:    bannerABTests.create({ query: h.query, promoBanners: promoStub || null }),
  };
}

function _sessionId() { return "sess-" + bShop.framework.uuid.v7(); }

// ---- defineTest shape ---------------------------------------------------

async function _defineTestShape() {
  var promo = _stubPromoBanners({
    "banner-control":   {},
    "banner-treatment": {},
    "banner-archived":  { archived_at: Date.now() - 1000 },
  });
  var f = _factory(promo);
  var now = Date.now();

  var test = await f.ab.defineTest({
    slug:       "homepage-hero-split",
    title:      "Homepage hero split test",
    hypothesis: "Treatment hero copy lifts CTR by 10%.",
    variants: [
      { banner_slug: "banner-control",   weight: 1 },
      { banner_slug: "banner-treatment", weight: 1 },
    ],
    starts_at: now,
  });
  check("defineTest returns row",                test && test.slug === "homepage-hero-split");
  check("defineTest status running",              test.status === "running");
  check("defineTest variants persisted",         Array.isArray(test.variants) && test.variants.length === 2);
  check("defineTest weight persisted",            test.variants[0].weight === 1);
  check("defineTest created_at set",              typeof test.created_at === "number");
  check("defineTest archived_at null",            test.archived_at === null);
  check("defineTest paused_at null",              test.paused_at === null);

  // getTest round-trip.
  var fetched = await f.ab.getTest("homepage-hero-split");
  check("getTest round-trip",                     fetched.slug === test.slug);

  // Duplicate slug refused.
  await assert.rejects(
    f.ab.defineTest({
      slug:       "homepage-hero-split",
      title:      "Dup",
      hypothesis: "Won't define",
      variants: [
        { banner_slug: "banner-control",   weight: 1 },
        { banner_slug: "banner-treatment", weight: 1 },
      ],
      starts_at: now,
    }),
    /already defined/,
  );

  // Unknown banner slug refused when promoBanners handle is wired.
  await assert.rejects(
    f.ab.defineTest({
      slug:       "bad-banner",
      title:      "Bad banner",
      hypothesis: "References ghost banner",
      variants: [
        { banner_slug: "banner-control",  weight: 1 },
        { banner_slug: "banner-doesnt-exist", weight: 1 },
      ],
      starts_at: now,
    }),
    /not found/,
  );

  // Archived banner refused.
  await assert.rejects(
    f.ab.defineTest({
      slug:       "archived-banner",
      title:      "Archived",
      hypothesis: "References archived banner",
      variants: [
        { banner_slug: "banner-control",  weight: 1 },
        { banner_slug: "banner-archived", weight: 1 },
      ],
      starts_at: now,
    }),
    /is archived/,
  );

  // Without the promoBanners handle the primitive trusts the operator.
  var f2 = _factory(null);
  var loose = await f2.ab.defineTest({
    slug:       "loose-mode",
    title:      "No banner verification",
    hypothesis: "Opaque slugs allowed.",
    variants: [
      { banner_slug: "any-slug-a", weight: 3 },
      { banner_slug: "any-slug-b", weight: 1 },
    ],
    starts_at: now,
  });
  check("defineTest loose mode allows opaque slugs", loose && loose.variants.length === 2);
  check("defineTest preserves variant order",        loose.variants[0].banner_slug === "any-slug-a"
                                                      && loose.variants[1].banner_slug === "any-slug-b");

  // ends_at after starts_at is allowed, before is refused.
  var withEnd = await f2.ab.defineTest({
    slug:       "with-end",
    title:      "With end window",
    hypothesis: "Schedule",
    variants: [
      { banner_slug: "any-slug-c", weight: 1 },
      { banner_slug: "any-slug-d", weight: 1 },
    ],
    starts_at: now,
    ends_at:   now + 1000 * 60 * 60,
  });
  check("defineTest ends_at persisted", withEnd.ends_at === now + 1000 * 60 * 60);

  await assert.rejects(
    f2.ab.defineTest({
      slug:       "bad-window",
      title:      "Bad window",
      hypothesis: "ends_at before starts_at",
      variants: [
        { banner_slug: "any-slug-e", weight: 1 },
        { banner_slug: "any-slug-f", weight: 1 },
      ],
      starts_at: now,
      ends_at:   now - 1000,
    }),
    /strictly greater/,
  );

  // Variant shape refusals.
  await assert.rejects(
    f2.ab.defineTest({
      slug: "single-variant", title: "T", hypothesis: "H",
      variants: [{ banner_slug: "only", weight: 1 }],
      starts_at: now,
    }),
    /at least 2/,
  );
  await assert.rejects(
    f2.ab.defineTest({
      slug: "dup-variant", title: "T", hypothesis: "H",
      variants: [
        { banner_slug: "same", weight: 1 },
        { banner_slug: "same", weight: 1 },
      ],
      starts_at: now,
    }),
    /duplicates/,
  );
  await assert.rejects(
    f2.ab.defineTest({
      slug: "bad-weight", title: "T", hypothesis: "H",
      variants: [
        { banner_slug: "a", weight: 0 },
        { banner_slug: "b", weight: 1 },
      ],
      starts_at: now,
    }),
    /weight/,
  );
}

// ---- getVariantForSession determinism + weight split --------------------

async function _variantAssignmentDeterministic() {
  var f = _factory(null);
  var now = Date.now();
  await f.ab.defineTest({
    slug:       "det-test",
    title:      "Determinism",
    hypothesis: "Same session -> same variant for the test's life.",
    variants: [
      { banner_slug: "ctrl",  weight: 1 },
      { banner_slug: "treat", weight: 1 },
    ],
    starts_at: now,
  });

  // Pick a session that lands on each variant once, then re-query
  // and ensure assignment never flips.
  var sessions = [];
  for (var i = 0; i < 50; i += 1) sessions.push(_sessionId());

  var first = {};
  for (var s = 0; s < sessions.length; s += 1) {
    var v = await f.ab.getVariantForSession({ test_slug: "det-test", session_id: sessions[s] });
    check("variant assigned for every session", v && (v.variant_slug === "ctrl" || v.variant_slug === "treat"));
    first[sessions[s]] = v.variant_slug;
  }

  // Re-query 10 times — must match first[].
  for (var rep = 0; rep < 10; rep += 1) {
    for (var t = 0; t < sessions.length; t += 1) {
      var v2 = await f.ab.getVariantForSession({ test_slug: "det-test", session_id: sessions[t] });
      check("re-query returns same variant",     v2.variant_slug === first[sessions[t]]);
      check("session_id_hash never exposes plaintext", v2.session_id_hash !== sessions[t]
                                                       && typeof v2.session_id_hash === "string"
                                                       && v2.session_id_hash.length >= 32);
    }
  }

  // banner_slug aliases variant_slug for ergonomic storefront code.
  var aliasCheck = await f.ab.getVariantForSession({ test_slug: "det-test", session_id: sessions[0] });
  check("banner_slug == variant_slug",          aliasCheck.banner_slug === aliasCheck.variant_slug);

  // Determinism survives a fresh factory instance on the SAME
  // backing store. The hash is content-addressed, not memoized.
  var f2 = bannerABTests.create({ query: f.query });
  for (var u = 0; u < sessions.length; u += 1) {
    var v3 = await f2.getVariantForSession({ test_slug: "det-test", session_id: sessions[u] });
    check("variant stable across factory instances", v3.variant_slug === first[sessions[u]]);
  }
}

async function _variantWeightSplit() {
  var f = _factory(null);
  var now = Date.now();
  // 90 / 10 split — over a large enough N the realized split sits
  // within a tolerance of the expected proportion. With N = 2000 the
  // expected stddev of the proportion is sqrt(0.9 * 0.1 / 2000) ~=
  // 0.0067, so a 3-sigma tolerance of 0.025 (2.5 percentage points)
  // is safely inside the realistic-runner envelope.
  await f.ab.defineTest({
    slug:       "ninety-ten",
    title:      "90/10",
    hypothesis: "Weight-proportional traffic allocation.",
    variants: [
      { banner_slug: "ninety", weight: 9 },
      { banner_slug: "ten",    weight: 1 },
    ],
    starts_at: now,
  });
  var N = 2000;
  var ninetyN = 0;
  for (var i = 0; i < N; i += 1) {
    var v = await f.ab.getVariantForSession({
      test_slug:  "ninety-ten",
      session_id: _sessionId(),
    });
    if (v.variant_slug === "ninety") ninetyN += 1;
  }
  var pct = ninetyN / N;
  check("weight split within tolerance",        pct >= 0.875 && pct <= 0.925);
  // ten variant got at least SOME sessions — not zero.
  check("low-weight variant still served",      (N - ninetyN) > 0);

  // Outside time window -> null.
  await f.ab.defineTest({
    slug:       "future-test",
    title:      "Future",
    hypothesis: "starts_at not yet reached",
    variants: [
      { banner_slug: "a", weight: 1 },
      { banner_slug: "b", weight: 1 },
    ],
    starts_at: now + 1000 * 60 * 60 * 24,
  });
  var future = await f.ab.getVariantForSession({
    test_slug:  "future-test",
    session_id: _sessionId(),
  });
  check("future test returns null",             future === null);

  // Past-window test -> null.
  await f.ab.defineTest({
    slug:       "past-test",
    title:      "Past",
    hypothesis: "ends_at already passed",
    variants: [
      { banner_slug: "a", weight: 1 },
      { banner_slug: "b", weight: 1 },
    ],
    starts_at: now - 1000 * 60 * 60 * 24,
    ends_at:   now - 1000 * 60 * 60,
  });
  var past = await f.ab.getVariantForSession({
    test_slug:  "past-test",
    session_id: _sessionId(),
  });
  check("past-window test returns null",        past === null);

  // Unknown test -> null.
  var unknown = await f.ab.getVariantForSession({
    test_slug:  "doesnt-exist",
    session_id: _sessionId(),
  });
  check("unknown test returns null",            unknown === null);
}

// ---- ledger append + drop-silent ----------------------------------------

async function _ledgerImpressionClickConversion() {
  var f = _factory(null);
  var now = Date.now();
  await f.ab.defineTest({
    slug:       "funnel-test",
    title:      "Funnel",
    hypothesis: "Click + conversion ledger.",
    variants: [
      { banner_slug: "a", weight: 1 },
      { banner_slug: "b", weight: 1 },
    ],
    starts_at: now - 1000,
  });

  var sess = _sessionId();
  var imp = await f.ab.recordImpression({ test_slug: "funnel-test", session_id: sess });
  check("recordImpression recorded",            imp.recorded === true);
  check("recordImpression returns id",          typeof imp.id === "string" && imp.id.length === 36);
  check("recordImpression returns variant",     imp.variant_slug === "a" || imp.variant_slug === "b");
  check("recordImpression occurred_at set",     typeof imp.occurred_at === "number");

  var clk = await f.ab.recordClick({ test_slug: "funnel-test", session_id: sess });
  check("recordClick recorded",                  clk.recorded === true);
  check("click assigned to same variant as impression", clk.variant_slug === imp.variant_slug);

  var conv = await f.ab.recordConversion({
    test_slug: "funnel-test",
    session_id: sess,
    value:     2500,
  });
  check("recordConversion recorded",             conv.recorded === true);
  check("conversion assigned to same variant",   conv.variant_slug === imp.variant_slug);

  // Ledger row matches what we just inserted.
  var ledger = await f.ab.eventsForTest({ test_slug: "funnel-test" });
  check("ledger contains all three events",      ledger.rows.length === 3);
  var byKind = {};
  for (var i = 0; i < ledger.rows.length; i += 1) {
    byKind[ledger.rows[i].event_kind] = ledger.rows[i];
  }
  check("impression in ledger",                  byKind.impression && byKind.impression.value === 0);
  check("click in ledger",                       byKind.click && byKind.click.value === 0);
  check("conversion value persisted",            byKind.conversion && byKind.conversion.value === 2500);
  check("session_id_hash never exposes plaintext in ledger",
                                                  byKind.impression.session_id_hash !== sess
                                                  && byKind.impression.session_id_hash.length >= 32);

  // Drop-silent: unknown test.
  var ghost = await f.ab.recordImpression({ test_slug: "no-such-test", session_id: sess });
  check("unknown test drops silent",             ghost.recorded === false);

  // Drop-silent: bad input shapes.
  check("bad session drops silent",              (await f.ab.recordImpression({ test_slug: "funnel-test", session_id: "" })).recorded === false);
  check("bad slug drops silent",                 (await f.ab.recordImpression({ test_slug: "Bad Slug!", session_id: sess })).recorded === false);
  check("non-int value drops silent",            (await f.ab.recordConversion({ test_slug: "funnel-test", session_id: sess, value: 3.5 })).recorded === false);
  check("negative value drops silent",           (await f.ab.recordConversion({ test_slug: "funnel-test", session_id: sess, value: -1 })).recorded === false);
  check("null input drops silent",               (await f.ab.recordImpression(null)).recorded === false);

  // Drop-silent: paused test doesn't record.
  await f.ab.pauseTest("funnel-test");
  var paused = await f.ab.recordImpression({ test_slug: "funnel-test", session_id: sess });
  check("paused test drops silent",              paused.recorded === false);

  // Resume + record again works.
  await f.ab.resumeTest("funnel-test");
  var resumed = await f.ab.recordImpression({ test_slug: "funnel-test", session_id: sess });
  check("resumed test records",                  resumed.recorded === true);

  // Conclude + record drops silent.
  await f.ab.concludeTest("funnel-test");
  var conc = await f.ab.recordImpression({ test_slug: "funnel-test", session_id: sess });
  check("concluded test drops silent",           conc.recorded === false);

  // Archive + record drops silent.
  await f.ab.archiveTest("funnel-test");
  var arch = await f.ab.recordImpression({ test_slug: "funnel-test", session_id: sess });
  check("archived test drops silent",            arch.recorded === false);
}

// ---- metricsForTest CI math --------------------------------------------

async function _metricsCiMath() {
  var f = _factory(null);
  var now = Date.now() - 1000;
  await f.ab.defineTest({
    slug:       "metrics-test",
    title:      "Metrics",
    hypothesis: "Wilson CI",
    variants: [
      { banner_slug: "ctrl",  weight: 1 },
      { banner_slug: "treat", weight: 1 },
    ],
    starts_at: now,
  });

  // Force a known split by picking sessions that bucket to each
  // variant. We probe sessions until we have enough on each side,
  // then drive a known event mix: ctrl gets 100 impressions + 5
  // clicks + 2 conversions; treat gets 100 impressions + 15 clicks
  // + 8 conversions.
  var TARGET = 100;
  var ctrlSessions  = [];
  var treatSessions = [];
  // probe up to 5000 candidates — at 50/50 weight, 200 sessions per
  // side fits comfortably inside the 5000 candidate budget.
  for (var probe = 0; probe < 5000; probe += 1) {
    if (ctrlSessions.length >= TARGET && treatSessions.length >= TARGET) break;
    var sid = _sessionId();
    var assignment = await f.ab.getVariantForSession({
      test_slug:  "metrics-test",
      session_id: sid,
    });
    if (assignment.variant_slug === "ctrl"  && ctrlSessions.length  < TARGET) ctrlSessions.push(sid);
    if (assignment.variant_slug === "treat" && treatSessions.length < TARGET) treatSessions.push(sid);
  }
  check("found enough ctrl sessions",            ctrlSessions.length === TARGET);
  check("found enough treat sessions",           treatSessions.length === TARGET);

  // Drive impressions for every session, clicks + conversions
  // against a known subset.
  for (var i = 0; i < TARGET; i += 1) {
    await f.ab.recordImpression({ test_slug: "metrics-test", session_id: ctrlSessions[i] });
    await f.ab.recordImpression({ test_slug: "metrics-test", session_id: treatSessions[i] });
  }
  for (var c = 0; c < 5; c += 1) {
    await f.ab.recordClick({ test_slug: "metrics-test", session_id: ctrlSessions[c] });
  }
  for (var t = 0; t < 15; t += 1) {
    await f.ab.recordClick({ test_slug: "metrics-test", session_id: treatSessions[t] });
  }
  for (var c2 = 0; c2 < 2; c2 += 1) {
    await f.ab.recordConversion({ test_slug: "metrics-test", session_id: ctrlSessions[c2], value: 100 });
  }
  for (var t2 = 0; t2 < 8; t2 += 1) {
    await f.ab.recordConversion({ test_slug: "metrics-test", session_id: treatSessions[t2], value: 200 });
  }

  var metrics = await f.ab.metricsForTest({ test_slug: "metrics-test" });
  check("metrics returns variants",              Array.isArray(metrics.variants) && metrics.variants.length === 2);
  var ctrl  = metrics.variants[0];
  var treat = metrics.variants[1];
  check("ctrl impressions count",                ctrl.impressions === TARGET);
  check("ctrl clicks count",                     ctrl.clicks === 5);
  check("ctrl conversions count",                ctrl.conversions === 2);
  check("ctrl conversion_value sum",             ctrl.conversion_value === 200);
  check("ctrl distinct impression sessions",     ctrl.distinct_impression_sessions === TARGET);

  check("treat impressions count",               treat.impressions === TARGET);
  check("treat clicks count",                    treat.clicks === 15);
  check("treat conversions count",               treat.conversions === 8);
  check("treat conversion_value sum",            treat.conversion_value === 1600);

  // CTR + conversion rate basic math.
  check("ctrl ctr 0.05",                          Math.abs(ctrl.ctr - 0.05) < 1e-9);
  check("ctrl conversion_rate 0.02",              Math.abs(ctrl.conversion_rate - 0.02) < 1e-9);
  check("treat ctr 0.15",                         Math.abs(treat.ctr - 0.15) < 1e-9);
  check("treat conversion_rate 0.08",             Math.abs(treat.conversion_rate - 0.08) < 1e-9);

  // Wilson CI sanity: lower <= rate <= upper, both in [0,1], width > 0.
  check("ctrl CTR CI bounds ordered",             ctrl.ctr_ci95_lower <= ctrl.ctr && ctrl.ctr <= ctrl.ctr_ci95_upper);
  check("ctrl conv CI bounds ordered",            ctrl.conversion_ci95_lower <= ctrl.conversion_rate
                                                  && ctrl.conversion_rate <= ctrl.conversion_ci95_upper);
  check("treat CTR CI bounds ordered",            treat.ctr_ci95_lower <= treat.ctr && treat.ctr <= treat.ctr_ci95_upper);
  check("CTR CI in [0,1]",                        ctrl.ctr_ci95_lower >= 0 && ctrl.ctr_ci95_upper <= 1
                                                  && treat.ctr_ci95_lower >= 0 && treat.ctr_ci95_upper <= 1);
  check("CTR CI has positive width",              (ctrl.ctr_ci95_upper - ctrl.ctr_ci95_lower) > 0);

  // Wilson 95% CI for 5/100: lower ~0.0216, upper ~0.1116 (computed
  // analytically). Both bounds should fall within a tight tolerance.
  check("ctrl CTR CI lower ~0.0216",              Math.abs(ctrl.ctr_ci95_lower - 0.0216) < 0.002);
  check("ctrl CTR CI upper ~0.1116",              Math.abs(ctrl.ctr_ci95_upper - 0.1116) < 0.002);

  // Treat CTR (15/100): lower ~0.0928, upper ~0.2334
  check("treat CTR CI lower ~0.0928",             Math.abs(treat.ctr_ci95_lower - 0.0928) < 0.002);
  check("treat CTR CI upper ~0.2334",             Math.abs(treat.ctr_ci95_upper - 0.2334) < 0.002);

  // Treat CTR upper < Ctrl CTR? No — treat is the winner here. But
  // treat's lower bound (0.093) > ctrl's upper bound (0.112)? They
  // narrowly overlap at this N — the test exists to confirm the CI
  // shape, not to assert a winner via overlapping intervals.

  // until=0 returns zero counts for everyone (no events <= 0).
  var empty = await f.ab.metricsForTest({ test_slug: "metrics-test", until: 0 });
  check("metrics until=0 zero impressions",       empty.variants[0].impressions === 0);

  // Unknown test slug refused.
  await assert.rejects(
    f.ab.metricsForTest({ test_slug: "no-such-test" }),
    /not found/,
  );

  // Variant order preserved.
  check("variant order preserved",                metrics.variants[0].variant_slug === "ctrl"
                                                  && metrics.variants[1].variant_slug === "treat");
}

// ---- FSM transitions ----------------------------------------------------

async function _fsmTransitions() {
  var f = _factory(null);
  var now = Date.now();
  await f.ab.defineTest({
    slug:       "fsm-test",
    title:      "FSM",
    hypothesis: "Transition graph",
    variants: [
      { banner_slug: "a", weight: 1 },
      { banner_slug: "b", weight: 1 },
    ],
    starts_at: now,
  });

  // Initial status is running.
  var t0 = await f.ab.getTest("fsm-test");
  check("initial status running",                 t0.status === "running");

  // Pause from running.
  var paused = await f.ab.pauseTest("fsm-test");
  check("status paused after pauseTest",          paused.status === "paused");
  check("paused_at set",                          typeof paused.paused_at === "number");

  // Pause again: refused.
  await assert.rejects(
    f.ab.pauseTest("fsm-test"),
    function (err) { return err && err.code === "BANNER_AB_TEST_INVALID_TRANSITION"; },
  );

  // Resume.
  var resumed = await f.ab.resumeTest("fsm-test");
  check("status running after resume",            resumed.status === "running");
  check("paused_at cleared after resume",         resumed.paused_at === null);

  // Conclude with declared winner.
  var concluded = await f.ab.concludeTest("fsm-test", { winner: "a" });
  check("status concluded",                       concluded.status === "concluded");
  check("concluded_at set",                       typeof concluded.concluded_at === "number");
  check("winner recorded",                        concluded.concluded_variant_slug === "a");

  // Cannot resume after conclude.
  await assert.rejects(
    f.ab.resumeTest("fsm-test"),
    function (err) { return err && err.code === "BANNER_AB_TEST_INVALID_TRANSITION"; },
  );

  // Cannot conclude again.
  await assert.rejects(
    f.ab.concludeTest("fsm-test"),
    function (err) { return err && err.code === "BANNER_AB_TEST_INVALID_TRANSITION"; },
  );

  // Archive from concluded.
  var archived = await f.ab.archiveTest("fsm-test");
  check("status archived",                        archived.status === "archived");
  check("archived_at set",                        typeof archived.archived_at === "number");

  // Cannot archive twice.
  await assert.rejects(
    f.ab.archiveTest("fsm-test"),
    function (err) { return err && err.code === "BANNER_AB_TEST_INVALID_TRANSITION"; },
  );

  // Cannot archive from running directly.
  await f.ab.defineTest({
    slug:       "direct-archive",
    title:      "Direct archive",
    hypothesis: "running -> archive refused",
    variants: [
      { banner_slug: "a", weight: 1 },
      { banner_slug: "b", weight: 1 },
    ],
    starts_at: now,
  });
  await assert.rejects(
    f.ab.archiveTest("direct-archive"),
    function (err) { return err && err.code === "BANNER_AB_TEST_INVALID_TRANSITION"; },
  );

  // Conclude with bogus winner.
  await assert.rejects(
    f.ab.concludeTest("direct-archive", { winner: "bogus-slug" }),
    /not one of/,
  );

  // Conclude with no winner is fine (concluded_variant_slug stays null).
  var concNoWin = await f.ab.concludeTest("direct-archive");
  check("conclude with no winner",                concNoWin.status === "concluded"
                                                   && concNoWin.concluded_variant_slug === null);

  // Unknown slug -> not found.
  await assert.rejects(
    f.ab.pauseTest("nope"),
    /not found/,
  );

  // concludeTest opts must be an object when provided.
  await assert.rejects(
    f.ab.concludeTest("direct-archive", "winner-a"),
    /opts must be an object/,
  );
}

// ---- listTests filter + pagination -------------------------------------

async function _listTestsFilter() {
  var f = _factory(null);
  var now = Date.now();
  for (var i = 0; i < 7; i += 1) {
    await f.ab.defineTest({
      slug:       "list-test-" + i,
      title:      "List " + i,
      hypothesis: "Listing",
      variants: [
        { banner_slug: "a", weight: 1 },
        { banner_slug: "b", weight: 1 },
      ],
      starts_at: now + i,
    });
  }

  // Conclude + archive a couple.
  await f.ab.concludeTest("list-test-0");
  await f.ab.archiveTest("list-test-0");
  await f.ab.pauseTest("list-test-1");

  var all = await f.ab.listTests();
  check("listTests all rows",                     all.rows.length === 7);

  var running = await f.ab.listTests({ status: "running" });
  check("listTests filter running",               running.rows.length === 5
                                                   && running.rows.every(function (r) { return r.status === "running"; }));

  var paused = await f.ab.listTests({ status: "paused" });
  check("listTests filter paused",                paused.rows.length === 1
                                                   && paused.rows[0].slug === "list-test-1");

  var archived = await f.ab.listTests({ status: "archived" });
  check("listTests filter archived",              archived.rows.length === 1
                                                   && archived.rows[0].slug === "list-test-0");

  // Pagination by limit + cursor.
  var page1 = await f.ab.listTests({ limit: 3 });
  check("listTests page1 length 3",               page1.rows.length === 3);
  check("listTests page1 next_cursor set",        typeof page1.next_cursor === "string");

  var page2 = await f.ab.listTests({ limit: 3, cursor: page1.next_cursor });
  check("listTests page2 length 3",               page2.rows.length === 3);

  var page3 = await f.ab.listTests({ limit: 3, cursor: page2.next_cursor });
  check("listTests page3 length 1",               page3.rows.length === 1);
  check("listTests page3 next_cursor null",       page3.next_cursor === null);

  // No duplicates across pages.
  var seen = Object.create(null);
  page1.rows.concat(page2.rows).concat(page3.rows).forEach(function (r) {
    seen[r.slug] = (seen[r.slug] || 0) + 1;
  });
  check("pagination no duplicates",               Object.keys(seen).every(function (k) { return seen[k] === 1; }));
}

// ---- validation surface -------------------------------------------------

async function _validationSurface() {
  var f = _factory(null);
  var now = Date.now();

  // defineTest
  await assert.rejects(f.ab.defineTest(),                                                /input object required/);
  await assert.rejects(f.ab.defineTest({}),                                              /slug/);
  await assert.rejects(f.ab.defineTest({ slug: "Has Space" }),                           /slug/);
  await assert.rejects(f.ab.defineTest({ slug: "ok-slug" }),                             /title/);
  await assert.rejects(f.ab.defineTest({ slug: "ok-slug", title: "" }),                  /title/);
  await assert.rejects(f.ab.defineTest({
    slug: "ok-slug", title: "T",
  }), /hypothesis/);
  await assert.rejects(f.ab.defineTest({
    slug: "ok-slug", title: "T", hypothesis: "H",
  }), /at least 2/);
  await assert.rejects(f.ab.defineTest({
    slug: "ok-slug", title: "T", hypothesis: "H",
    variants: [{ banner_slug: "a", weight: 1 }, { banner_slug: "b", weight: 1 }],
  }), /starts_at/);

  // Seed a real test for entry-point validation.
  await f.ab.defineTest({
    slug:       "valid",
    title:      "Valid",
    hypothesis: "Seed",
    variants: [
      { banner_slug: "a", weight: 1 },
      { banner_slug: "b", weight: 1 },
    ],
    starts_at: now,
  });

  // getTest
  await assert.rejects(f.ab.getTest("Has Space"),                                        /slug/);
  // Non-string also refused.
  await assert.rejects(f.ab.getTest(42),                                                 /slug/);

  // getVariantForSession
  await assert.rejects(f.ab.getVariantForSession(),                                      /input object required/);
  await assert.rejects(f.ab.getVariantForSession({ test_slug: "Bad Slug!" }),            /test_slug/);
  await assert.rejects(f.ab.getVariantForSession({ test_slug: "valid", session_id: "" }), /session_id/);
  await assert.rejects(f.ab.getVariantForSession({ test_slug: "valid", session_id: "s", now: -1 }), /now/);

  // metricsForTest
  await assert.rejects(f.ab.metricsForTest(),                                            /input object required/);
  await assert.rejects(f.ab.metricsForTest({ test_slug: "Bad Slug!" }),                  /test_slug/);
  await assert.rejects(f.ab.metricsForTest({ test_slug: "no-such" }),                    /not found/);
  await assert.rejects(f.ab.metricsForTest({ test_slug: "valid", until: -1 }),           /until/);

  // pauseTest / resumeTest / concludeTest / archiveTest
  await assert.rejects(f.ab.pauseTest("Bad Slug!"),                                      /slug/);
  await assert.rejects(f.ab.resumeTest("valid"),
    function (err) { return err && err.code === "BANNER_AB_TEST_INVALID_TRANSITION"; });
  await assert.rejects(f.ab.archiveTest("valid"),
    function (err) { return err && err.code === "BANNER_AB_TEST_INVALID_TRANSITION"; });

  // listTests
  await assert.rejects(f.ab.listTests({ status: "bogus" }),                              /status/);
  await assert.rejects(f.ab.listTests({ limit: 0 }),                                     /limit/);
  await assert.rejects(f.ab.listTests({ limit: 10000 }),                                 /limit/);
  await assert.rejects(f.ab.listTests({ cursor: "" }),                                   /cursor/);

  // eventsForTest
  await assert.rejects(f.ab.eventsForTest(),                                             /input object required/);
  await assert.rejects(f.ab.eventsForTest({ test_slug: "Bad Slug!" }),                   /test_slug/);
  await assert.rejects(f.ab.eventsForTest({ test_slug: "valid", from: 100, to: 50 }),    /from must be <= to/);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("MAX_SLUG_LEN exported",                  typeof bannerABTests.MAX_SLUG_LEN === "number"
                                                   && bannerABTests.MAX_SLUG_LEN === 80);
  check("MAX_TITLE_LEN exported",                 bannerABTests.MAX_TITLE_LEN === 200);
  check("MAX_HYPOTHESIS_LEN exported",            bannerABTests.MAX_HYPOTHESIS_LEN === 2000);
  check("MAX_VARIANTS exported",                  bannerABTests.MAX_VARIANTS === 16);
  check("MAX_WEIGHT exported",                    bannerABTests.MAX_WEIGHT === 1000000);
  check("ALLOWED_STATUSES exported",              Array.isArray(bannerABTests.ALLOWED_STATUSES)
                                                   && bannerABTests.ALLOWED_STATUSES.indexOf("running") !== -1
                                                   && bannerABTests.ALLOWED_STATUSES.indexOf("paused") !== -1
                                                   && bannerABTests.ALLOWED_STATUSES.indexOf("concluded") !== -1
                                                   && bannerABTests.ALLOWED_STATUSES.indexOf("archived") !== -1);
  check("ALLOWED_EVENT_KINDS exported",           Array.isArray(bannerABTests.ALLOWED_EVENT_KINDS)
                                                   && bannerABTests.ALLOWED_EVENT_KINDS.indexOf("impression") !== -1
                                                   && bannerABTests.ALLOWED_EVENT_KINDS.indexOf("click") !== -1
                                                   && bannerABTests.ALLOWED_EVENT_KINDS.indexOf("conversion") !== -1);
  check("TRANSITIONS exported",                   bannerABTests.TRANSITIONS
                                                   && bannerABTests.TRANSITIONS.running.pause === "paused"
                                                   && bannerABTests.TRANSITIONS.archived.archive === null);

  var inst = bannerABTests.create({ query: _makeQuery().query });
  check("instance exposes ALLOWED_STATUSES",      Array.isArray(inst.ALLOWED_STATUSES)
                                                   && inst.ALLOWED_STATUSES.length === bannerABTests.ALLOWED_STATUSES.length);
  check("instance exposes ALLOWED_EVENT_KINDS",   Array.isArray(inst.ALLOWED_EVENT_KINDS));
  check("instance exposes defineTest",            typeof inst.defineTest === "function");
  check("instance exposes getVariantForSession",  typeof inst.getVariantForSession === "function");
  check("instance exposes recordImpression",      typeof inst.recordImpression === "function");
  check("instance exposes recordClick",           typeof inst.recordClick === "function");
  check("instance exposes recordConversion",      typeof inst.recordConversion === "function");
  check("instance exposes metricsForTest",        typeof inst.metricsForTest === "function");
  check("instance exposes pauseTest",             typeof inst.pauseTest === "function");
  check("instance exposes resumeTest",            typeof inst.resumeTest === "function");
  check("instance exposes concludeTest",          typeof inst.concludeTest === "function");
  check("instance exposes archiveTest",           typeof inst.archiveTest === "function");
  check("instance exposes listTests",             typeof inst.listTests === "function");
}

async function run() {
  await _defineTestShape();
  await _variantAssignmentDeterministic();
  await _variantWeightSplit();
  await _ledgerImpressionClickConversion();
  await _metricsCiMath();
  await _fsmTransitions();
  await _listTestsFilter();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - banner-ab-tests (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    },
  );
}
