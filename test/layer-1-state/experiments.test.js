"use strict";
/**
 * experiments — A/B testing framework for the storefront.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0071_experiments.sql alone — the primitive has no FKs into the
 * rest of the schema, so the test runs against a minimal in-memory
 * database with just the experiments + experiment_events tables.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/experiments.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineExperiment happy path + every required field is persisted
 *   - defineExperiment refuses bad input (variants count, weights,
 *     duplicate variant slugs, bad enum, ends_at <= starts_at,
 *     status "archived" at define time)
 *   - getVariant determinism: same session id → same variant 100x
 *     across all of the experiment's lifetime
 *   - getVariant traffic-split honors the weights at scale (10k
 *     simulated sessions land in proportion within sane tolerance)
 *   - getVariant returns null for draft / paused / outside window
 *   - recordConversion + metricsForExperiment aggregation
 *   - Wilson 95% CI math against known values
 *   - FSM transitions (pause / resume / archive) + invalid-edge
 *     refusals
 *   - update patch + read-only variants_json
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var experiments = require("../../lib/experiments");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0071_experiments.sql");

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

function _setup() {
  var query = _makeQuery();
  return { query: query, ex: experiments.create({ query: query }) };
}

// ---- defineExperiment happy path ---------------------------------------

async function _defineHappy() {
  var ctx = _setup();
  var now = Date.now();
  var e = await ctx.ex.defineExperiment({
    slug:           "hero-cta-2026q2",
    title:          "Hero CTA copy",
    hypothesis:     "A bolder verb on the homepage hero increases checkout starts.",
    variants:       [
      { slug: "control",  weight: 50 },
      { slug: "bold",     weight: 50 },
    ],
    primary_metric: "checkout_started",
    status:         "running",
    starts_at:      now - 60 * 1000,
    ends_at:        now + 30 * 24 * 60 * 60 * 1000,
  });
  check("defineExperiment persists slug",          e.slug === "hero-cta-2026q2");
  check("defineExperiment persists title",         e.title === "Hero CTA copy");
  check("defineExperiment persists hypothesis",    e.hypothesis.indexOf("bolder verb") !== -1);
  check("defineExperiment persists variants",      e.variants.length === 2 && e.variants[0].slug === "control");
  check("defineExperiment persists weights",       e.variants[0].weight === 50 && e.variants[1].weight === 50);
  check("defineExperiment persists primary_metric", e.primary_metric === "checkout_started");
  check("defineExperiment persists status",        e.status === "running");
  check("defineExperiment persists window",        e.starts_at < e.ends_at);
  check("defineExperiment archived_at null",       e.archived_at === null);
  check("defineExperiment paused_at null",         e.paused_at === null);
  check("defineExperiment stamps created_at",      typeof e.created_at === "number" && e.created_at > 0);

  // Draft status — paused_at stays null.
  var d = await ctx.ex.defineExperiment({
    slug:           "draft-only",
    title:          "Draft",
    hypothesis:     "Sketch.",
    variants:       [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "x",
    status:         "draft",
    starts_at:      now,
  });
  check("defineExperiment draft persists",     d.status === "draft");
  check("defineExperiment ends_at optional",   d.ends_at === null);

  // Paused status — paused_at is stamped.
  var p = await ctx.ex.defineExperiment({
    slug:           "paused-init",
    title:          "Paused at define",
    hypothesis:     "Sketch.",
    variants:       [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "x",
    status:         "paused",
    starts_at:      now,
  });
  check("defineExperiment paused stamps paused_at",
    typeof p.paused_at === "number" && p.paused_at > 0);
}

// ---- defineExperiment refusals -----------------------------------------

async function _defineRefusals() {
  var ctx = _setup();
  var now = Date.now();

  // archived at define time refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "bad-arch", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "archived", starts_at: now,
  }), /cannot define.*archived/);

  // Single variant refused (must be >= 2).
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "one-var", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  }), /variants must be an array of at least 2/);

  // Duplicate variant slug refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "dup-var", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "a", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  }), /duplicates an earlier variant slug/);

  // Zero weight refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "zero-weight", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 0 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  }), /weight must be an integer/);

  // Negative weight refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "neg-weight", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: -1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  }), /weight must be an integer/);

  // Bad slug shape refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "-leading-hyphen", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  }), /slug must match/);

  // Bad status enum refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "bad-status", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "live", starts_at: now,
  }), /status must be one of/);

  // ends_at <= starts_at refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "bad-window", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
    ends_at: now,
  }), /ends_at must be strictly greater/);

  // Empty input refused.
  await assert.rejects(ctx.ex.defineExperiment(), /input object required/);

  // Control bytes in title refused.
  await assert.rejects(ctx.ex.defineExperiment({
    slug: "ctrl-t", title: "bad\x00byte", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  }), /title/);
}

// ---- getVariant determinism --------------------------------------------

async function _variantDeterminism() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.ex.defineExperiment({
    slug: "det-test", title: "Determinism test", hypothesis: "A is sticky.",
    variants: [
      { slug: "alpha", weight: 1 },
      { slug: "beta",  weight: 1 },
      { slug: "gamma", weight: 1 },
    ],
    primary_metric: "click",
    status:    "running",
    starts_at: now - 1000,
    ends_at:   now + 60 * 60 * 1000,
  });

  // Same session id → same variant 100 calls in a row.
  var session = "sess-deterministic-123";
  var first = await ctx.ex.getVariant({ experiment_slug: "det-test", session_id: session });
  check("getVariant returns assignment object", first &&
    typeof first.variant_slug === "string" &&
    first.experiment_slug === "det-test");
  check("getVariant session_id_hash present", typeof first.session_id_hash === "string" &&
    /^[0-9a-f]{128}$/.test(first.session_id_hash));
  for (var i = 0; i < 100; i += 1) {
    var again = await ctx.ex.getVariant({ experiment_slug: "det-test", session_id: session });
    check("getVariant deterministic across calls", again.variant_slug === first.variant_slug);
  }

  // Different sessions produce a distribution across all three
  // variants (sanity check that the modulus actually spans the
  // cumulative-weight range — if the assignment were a constant
  // mapping all sessions would land in one bucket).
  var seen = Object.create(null);
  for (var j = 0; j < 300; j += 1) {
    var v = await ctx.ex.getVariant({ experiment_slug: "det-test", session_id: "sess-" + j });
    seen[v.variant_slug] = (seen[v.variant_slug] || 0) + 1;
  }
  check("getVariant spans alpha", seen["alpha"] > 0);
  check("getVariant spans beta",  seen["beta"]  > 0);
  check("getVariant spans gamma", seen["gamma"] > 0);
}

// ---- getVariant traffic split honors weights ---------------------------

async function _trafficSplit() {
  var ctx = _setup();
  var now = Date.now();
  // 75/25 split — at 4000 sessions, control should land around
  // 3000 and treatment around 1000. Wilson-interval-ish tolerance
  // of ±5 percentage points (200 sessions) keeps the test
  // deterministically passing across runs while still detecting a
  // weight bug that ignored the ratio.
  await ctx.ex.defineExperiment({
    slug: "weighted-75-25", title: "Weighted", hypothesis: "y",
    variants: [
      { slug: "control",   weight: 75 },
      { slug: "treatment", weight: 25 },
    ],
    primary_metric: "m",
    status:    "running",
    starts_at: now - 1000,
    ends_at:   now + 60 * 60 * 1000,
  });
  var n = 4000;
  var counts = { control: 0, treatment: 0 };
  for (var i = 0; i < n; i += 1) {
    var v = await ctx.ex.getVariant({
      experiment_slug: "weighted-75-25",
      session_id:      "split-sess-" + i,
    });
    counts[v.variant_slug] += 1;
  }
  var controlPct = counts.control / n;
  var treatmentPct = counts.treatment / n;
  check("weighted split: control near 0.75 (±0.05)",
    controlPct >= 0.70 && controlPct <= 0.80);
  check("weighted split: treatment near 0.25 (±0.05)",
    treatmentPct >= 0.20 && treatmentPct <= 0.30);
}

// ---- getVariant: status + window gating --------------------------------

async function _variantGating() {
  var ctx = _setup();
  var now = Date.now();

  // Draft experiment — no traffic.
  await ctx.ex.defineExperiment({
    slug: "draft-x", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now - 1000,
  });
  check("getVariant null for draft",
    (await ctx.ex.getVariant({ experiment_slug: "draft-x", session_id: "s1" })) === null);

  // Running but starts_at in the future — no traffic yet.
  await ctx.ex.defineExperiment({
    slug: "future-x", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "running",
    starts_at: now + 60 * 1000, ends_at: now + 120 * 1000,
  });
  check("getVariant null before starts_at",
    (await ctx.ex.getVariant({ experiment_slug: "future-x", session_id: "s1" })) === null);

  // Running but ends_at in the past — no traffic anymore.
  await ctx.ex.defineExperiment({
    slug: "past-x", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "running",
    starts_at: now - 120 * 1000, ends_at: now - 60 * 1000,
  });
  check("getVariant null after ends_at",
    (await ctx.ex.getVariant({ experiment_slug: "past-x", session_id: "s1" })) === null);

  // Running, in window — traffic flows.
  await ctx.ex.defineExperiment({
    slug: "live-x", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "running",
    starts_at: now - 1000, ends_at: now + 60 * 1000,
  });
  var live = await ctx.ex.getVariant({ experiment_slug: "live-x", session_id: "s1" });
  check("getVariant returns assignment when live", live && (live.variant_slug === "a" || live.variant_slug === "b"));

  // Unknown experiment slug — returns null (not a throw — the call
  // is hot-path on the storefront, and a stale slug from a cached
  // page shouldn't crash the response).
  check("getVariant null for unknown slug",
    (await ctx.ex.getVariant({ experiment_slug: "never-existed", session_id: "s1" })) === null);

  // Bad input — throws (config-time error).
  await assert.rejects(ctx.ex.getVariant(), /input object required/);
  await assert.rejects(
    ctx.ex.getVariant({ experiment_slug: "live-x", session_id: "" }),
    /session_id must be a non-empty string/
  );
}

// ---- pauseExperiment hides from getVariant -----------------------------

async function _pauseHides() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.ex.defineExperiment({
    slug: "to-pause", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "running",
    starts_at: now - 1000, ends_at: now + 60 * 1000,
  });

  var pre = await ctx.ex.getVariant({ experiment_slug: "to-pause", session_id: "s-pre" });
  check("pre-pause: getVariant returns assignment", pre && pre.variant_slug);

  var paused = await ctx.ex.pauseExperiment("to-pause");
  check("pauseExperiment sets status=paused", paused.status === "paused");
  check("pauseExperiment stamps paused_at",
    typeof paused.paused_at === "number" && paused.paused_at > 0);

  var mid = await ctx.ex.getVariant({ experiment_slug: "to-pause", session_id: "s-mid" });
  check("paused: getVariant returns null", mid === null);
  var midSame = await ctx.ex.getVariant({ experiment_slug: "to-pause", session_id: "s-pre" });
  check("paused: getVariant null even for previously-assigned session", midSame === null);

  var resumed = await ctx.ex.resumeExperiment("to-pause");
  check("resumeExperiment sets status=running", resumed.status === "running");
  check("resumeExperiment clears paused_at",     resumed.paused_at === null);

  // After resume, the previously-seen session lands on the SAME
  // variant it had before pause — assignment is purely a function
  // of (slug, session_id), not of pause/resume history.
  var post = await ctx.ex.getVariant({ experiment_slug: "to-pause", session_id: "s-pre" });
  check("post-resume: same session → same variant as pre-pause",
    post && post.variant_slug === pre.variant_slug);
}

// ---- FSM transitions: invalid edges refused ----------------------------

async function _fsmTransitions() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.ex.defineExperiment({
    slug: "fsm-x", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  });

  // pause from draft refused.
  await assert.rejects(ctx.ex.pauseExperiment("fsm-x"),
    /cannot pause an experiment in status "draft"/);

  // resume from draft → running.
  var running = await ctx.ex.resumeExperiment("fsm-x");
  check("draft → running via resume", running.status === "running");

  // resume from running refused.
  await assert.rejects(ctx.ex.resumeExperiment("fsm-x"),
    /cannot resume an experiment in status "running"/);

  // archive from running.
  var archived = await ctx.ex.archiveExperiment("fsm-x");
  check("running → archived", archived.status === "archived");
  check("archive stamps archived_at",
    typeof archived.archived_at === "number" && archived.archived_at > 0);

  // archived is terminal — every transition refused.
  await assert.rejects(ctx.ex.pauseExperiment("fsm-x"),  /cannot pause.*"archived"/);
  await assert.rejects(ctx.ex.resumeExperiment("fsm-x"), /cannot resume.*"archived"/);
  await assert.rejects(ctx.ex.archiveExperiment("fsm-x"),/cannot archive.*"archived"/);

  // Unknown slug — refused.
  await assert.rejects(ctx.ex.pauseExperiment("never-existed"),   /not found/);
  await assert.rejects(ctx.ex.resumeExperiment("never-existed"),  /not found/);
  await assert.rejects(ctx.ex.archiveExperiment("never-existed"), /not found/);

  // Archive from draft is allowed (cancel before launch).
  await ctx.ex.defineExperiment({
    slug: "draft-cancel", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now,
  });
  var draftArchived = await ctx.ex.archiveExperiment("draft-cancel");
  check("draft → archived allowed", draftArchived.status === "archived");

  // Archive from paused is allowed.
  await ctx.ex.defineExperiment({
    slug: "to-paused-arc", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "running",
    starts_at: now - 1000, ends_at: now + 60 * 1000,
  });
  await ctx.ex.pauseExperiment("to-paused-arc");
  var pa = await ctx.ex.archiveExperiment("to-paused-arc");
  check("paused → archived allowed", pa.status === "archived");
}

// ---- recordConversion + metricsForExperiment ---------------------------

async function _conversionsAndMetrics() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.ex.defineExperiment({
    slug: "conv-x", title: "x", hypothesis: "y",
    variants: [{ slug: "control", weight: 1 }, { slug: "treatment", weight: 1 }],
    primary_metric: "checkout_started",
    status: "running",
    starts_at: now - 1000, ends_at: now + 60 * 60 * 1000,
  });

  // Record some conversions: 30 on control, 50 on treatment.
  for (var i = 0; i < 30; i += 1) {
    var r1 = await ctx.ex.recordConversion({
      experiment_slug: "conv-x",
      variant_slug:    "control",
      session_id:      "c-" + i,
      metric:          "checkout_started",
    });
    check("recordConversion recorded=true on control", r1.recorded === true);
  }
  for (var j = 0; j < 50; j += 1) {
    await ctx.ex.recordConversion({
      experiment_slug: "conv-x",
      variant_slug:    "treatment",
      session_id:      "t-" + j,
      metric:          "checkout_started",
    });
  }

  // Raw counts without assigned_sessions.
  var rawReport = await ctx.ex.metricsForExperiment({ experiment_slug: "conv-x" });
  check("metrics primary_metric echoed",   rawReport.primary_metric === "checkout_started");
  check("metrics variant count = 2",       rawReport.variants.length === 2);
  var control = rawReport.variants.filter(function (v) { return v.variant_slug === "control"; })[0];
  var treatment = rawReport.variants.filter(function (v) { return v.variant_slug === "treatment"; })[0];
  check("metrics control conversions = 30",   control.conversions === 30);
  check("metrics treatment conversions = 50", treatment.conversions === 50);
  check("metrics rate omitted when assigned_sessions omitted", control.rate === undefined);

  // With assigned_sessions, Wilson CI populated.
  var ciReport = await ctx.ex.metricsForExperiment({
    experiment_slug:   "conv-x",
    assigned_sessions: { control: 1000, treatment: 1000 },
  });
  var cCi = ciReport.variants.filter(function (v) { return v.variant_slug === "control"; })[0];
  var tCi = ciReport.variants.filter(function (v) { return v.variant_slug === "treatment"; })[0];
  check("metrics control rate = 0.03", Math.abs(cCi.rate - 0.03) < 1e-9);
  check("metrics treatment rate = 0.05", Math.abs(tCi.rate - 0.05) < 1e-9);
  check("metrics control CI bounded in [0,1]",
    cCi.ci95_lower >= 0 && cCi.ci95_upper <= 1 && cCi.ci95_lower < cCi.ci95_upper);
  check("metrics control CI brackets rate",
    cCi.ci95_lower <= cCi.rate && cCi.rate <= cCi.ci95_upper);
  check("metrics treatment CI brackets rate",
    tCi.ci95_lower <= tCi.rate && tCi.rate <= tCi.ci95_upper);

  // Recording for an unknown variant — drop-silent.
  var bad = await ctx.ex.recordConversion({
    experiment_slug: "conv-x", variant_slug: "ghost",
    session_id: "s", metric: "checkout_started",
  });
  check("recordConversion drop-silent on unknown variant", bad.recorded === false);

  // Recording on an unknown experiment — drop-silent.
  var bad2 = await ctx.ex.recordConversion({
    experiment_slug: "never-existed", variant_slug: "x",
    session_id: "s", metric: "m",
  });
  check("recordConversion drop-silent on unknown experiment", bad2.recorded === false);

  // After archiving, recordConversion is drop-silent — but
  // metricsForExperiment still reports historical conversions.
  await ctx.ex.archiveExperiment("conv-x");
  var afterArc = await ctx.ex.recordConversion({
    experiment_slug: "conv-x", variant_slug: "control",
    session_id: "post-arc", metric: "checkout_started",
  });
  check("recordConversion drop-silent on archived experiment", afterArc.recorded === false);
  var arcReport = await ctx.ex.metricsForExperiment({ experiment_slug: "conv-x" });
  var arcControl = arcReport.variants.filter(function (v) { return v.variant_slug === "control"; })[0];
  check("metrics for archived experiment still reports history", arcControl.conversions === 30);

  // metricsForExperiment for unknown slug — refused.
  await assert.rejects(ctx.ex.metricsForExperiment({ experiment_slug: "never-existed" }),
    /not found/);

  // recordConversion bad-shape inputs — drop-silent (no throw).
  var bs1 = await ctx.ex.recordConversion(null);
  check("recordConversion null input drop-silent", bs1.recorded === false);
  var bs2 = await ctx.ex.recordConversion({});
  check("recordConversion empty input drop-silent", bs2.recorded === false);
  var bs3 = await ctx.ex.recordConversion({
    experiment_slug: "conv-x", variant_slug: "control",
    session_id: "s", metric: "bad\x00metric",
  });
  check("recordConversion control-byte metric drop-silent", bs3.recorded === false);
}

// ---- Wilson CI math against known values -------------------------------

async function _wilsonCiMath() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.ex.defineExperiment({
    slug: "wilson-x", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m",
    status: "running",
    starts_at: now - 1000, ends_at: now + 60 * 60 * 1000,
  });
  // 50 conversions in variant a; we'll query metrics with various
  // assigned_sessions values and verify Wilson outputs.
  for (var i = 0; i < 50; i += 1) {
    await ctx.ex.recordConversion({
      experiment_slug: "wilson-x", variant_slug: "a",
      session_id: "ws-" + i, metric: "m",
    });
  }

  // 50/100 = 0.5 rate. Wilson 95% CI for 50/100 ≈ [0.4038, 0.5962].
  var report = await ctx.ex.metricsForExperiment({
    experiment_slug:   "wilson-x",
    assigned_sessions: { a: 100, b: 100 },
  });
  var a = report.variants.filter(function (v) { return v.variant_slug === "a"; })[0];
  check("Wilson 50/100 rate = 0.5",         Math.abs(a.rate - 0.5) < 1e-9);
  check("Wilson 50/100 lower ≈ 0.4038",     Math.abs(a.ci95_lower - 0.4038269395120203) < 1e-3);
  check("Wilson 50/100 upper ≈ 0.5962",     Math.abs(a.ci95_upper - 0.5961730604879796) < 1e-3);

  // 0/100 = 0 — lower clamps to (essentially) 0, upper > 0.
  // The Wilson formula with p=0 produces center = half mathematically,
  // so center - half lands within machine epsilon of 0 but not exactly
  // zero on IEEE-754. The clamp inside the primitive only fires for
  // strictly-negative values; the assertion tolerates the float-noise
  // residue.
  var b = report.variants.filter(function (v) { return v.variant_slug === "b"; })[0];
  check("Wilson 0/100 rate = 0",          b.rate === 0);
  check("Wilson 0/100 lower ≈ 0",         b.ci95_lower >= 0 && b.ci95_lower < 1e-12);
  check("Wilson 0/100 upper > 0",         b.ci95_upper > 0 && b.ci95_upper < 0.1);

  // 0 trials → both bounds 0.
  var zeroReport = await ctx.ex.metricsForExperiment({
    experiment_slug:   "wilson-x",
    assigned_sessions: { a: 0, b: 0 },
  });
  var az = zeroReport.variants.filter(function (v) { return v.variant_slug === "a"; })[0];
  check("Wilson 0 trials lower = 0", az.ci95_lower === 0);
  check("Wilson 0 trials upper = 0", az.ci95_upper === 0);
}

// ---- update + listExperiments ------------------------------------------

async function _updateAndList() {
  var ctx = _setup();
  var now = Date.now();
  await ctx.ex.defineExperiment({
    slug: "u1", title: "Old title", hypothesis: "Old hypothesis.",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m1",
    status: "draft", starts_at: now, ends_at: now + 60 * 1000,
  });

  // update happy path.
  var u = await ctx.ex.update("u1", {
    title:          "New title",
    hypothesis:     "New hypothesis copy.",
    primary_metric: "m2",
    ends_at:        now + 120 * 1000,
  });
  check("update persists title",          u.title === "New title");
  check("update persists hypothesis",     u.hypothesis === "New hypothesis copy.");
  check("update persists primary_metric", u.primary_metric === "m2");
  check("update persists ends_at",        u.ends_at === now + 120 * 1000);

  // Clear ends_at by passing null.
  var cleared = await ctx.ex.update("u1", { ends_at: null });
  check("update clears ends_at when null passed", cleared.ends_at === null);

  // Unsupported column refused.
  await assert.rejects(ctx.ex.update("u1", { variants_json: "x" }),
    /unsupported column/);
  await assert.rejects(ctx.ex.update("u1", { status: "running" }),
    /unsupported column/);

  // Unknown slug refused.
  await assert.rejects(ctx.ex.update("u-ghost", { title: "x" }),
    /not found/);

  // ends_at <= starts_at refused.
  await assert.rejects(ctx.ex.update("u1", { ends_at: now - 1000 }),
    /ends_at must be strictly greater/);

  // Updating an archived experiment refused.
  await ctx.ex.archiveExperiment("u1");
  await assert.rejects(ctx.ex.update("u1", { title: "x" }),
    /cannot update an archived experiment/);

  // listExperiments + status filter.
  var now2 = Date.now();
  await ctx.ex.defineExperiment({
    slug: "list-draft", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "draft", starts_at: now2,
  });
  await ctx.ex.defineExperiment({
    slug: "list-running", title: "x", hypothesis: "y",
    variants: [{ slug: "a", weight: 1 }, { slug: "b", weight: 1 }],
    primary_metric: "m", status: "running", starts_at: now2,
  });

  var all = await ctx.ex.listExperiments();
  check("listExperiments returns all rows", all.length >= 3);

  var draftsOnly = await ctx.ex.listExperiments({ status: "draft" });
  check("listExperiments status filter narrows",
    draftsOnly.every(function (e) { return e.status === "draft"; }));
  check("listExperiments status filter finds list-draft",
    draftsOnly.some(function (e) { return e.slug === "list-draft"; }));

  var archivedOnly = await ctx.ex.listExperiments({ status: "archived" });
  check("listExperiments status filter finds archived u1",
    archivedOnly.some(function (e) { return e.slug === "u1"; }));

  // Bad status filter refused.
  await assert.rejects(ctx.ex.listExperiments({ status: "bogus" }),
    /status must be one of/);
}

async function run() {
  await _defineHappy();
  await _defineRefusals();
  await _variantDeterminism();
  await _trafficSplit();
  await _variantGating();
  await _pauseHides();
  await _fsmTransitions();
  await _conversionsAndMetrics();
  await _wilsonCiMath();
  await _updateAndList();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/experiments.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("experiments: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
