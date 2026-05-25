"use strict";
/**
 * @module shop.experiments
 * @title  Experiments — A/B testing framework for the storefront
 *
 * @intro
 *   Operators define experiments with N variants + per-variant
 *   traffic weights. Each visitor's session id deterministically
 *   maps to one variant for the experiment's life — re-visits in the
 *   same session always see the same variant, so the visitor never
 *   experiences a within-session UI flip mid-funnel. Conversion
 *   events feed a per-variant success counter, and the operator
 *   dashboard reads back per-variant counts + Wilson 95% confidence
 *   intervals for the conversion rate.
 *
 *   Surface:
 *     - defineExperiment({ slug, title, hypothesis, variants,
 *                          primary_metric, status, starts_at,
 *                          ends_at? })
 *         Create the experiment. Variants are an ordered array of
 *         { slug, weight } records — weights are positive integers,
 *         the cumulative total is the modulus for assignment.
 *         Variants are write-once: changing them after defineExperiment
 *         would corrupt assignments for sessions already seen.
 *
 *     - getVariant({ experiment_slug, session_id })
 *         Returns the assigned variant for the session, or null if
 *         the experiment is not currently reading traffic (status
 *         not "running", or `now` is outside [starts_at, ends_at]).
 *         The session id is namespace-hashed (`experiments-session`)
 *         before any storage / hashing-for-assignment work. The
 *         assignment is deterministic: same session id + same
 *         experiment slug → same variant 100% of the time, for the
 *         lifetime of the experiment.
 *
 *     - recordConversion({ experiment_slug, variant_slug,
 *                          session_id, metric, value? })
 *         Append a conversion event. Drop-silent on
 *         unknown / archived experiment (this is a hot-path
 *         observability sink; throwing here would crash the request
 *         that observed the conversion).
 *
 *     - metricsForExperiment({ experiment_slug, until? })
 *         Returns per-variant counts + Wilson 95% CI for the
 *         conversion rate. `until` defaults to `now`. The denominator
 *         is the number of sessions that were assigned to the
 *         variant via `getVariant` — but assignment is implicit
 *         (never persisted), so the dashboard approximates the
 *         denominator using the cumulative-weight share of the
 *         total assigned-session population, which the operator
 *         supplies as `assigned_sessions`. When `assigned_sessions`
 *         is omitted, the report returns raw counts only without a
 *         rate / CI.
 *
 *     - listExperiments({ status? })
 *         Enumerate experiments, optionally filtered by status.
 *
 *     - pauseExperiment(slug) / resumeExperiment(slug) /
 *       archiveExperiment(slug)
 *         FSM transitions. Refuse invalid edges (e.g. resuming an
 *         archived experiment, archiving twice).
 *
 *     - update(slug, patch)
 *         Mutate metadata fields (title / hypothesis /
 *         primary_metric / ends_at). The variants_json column is
 *         read-only — operators archive + redefine to change the
 *         variant catalogue.
 *
 *   Composition:
 *     - b.crypto.namespaceHash — session id is hashed with
 *       namespace "experiments-session" before any storage or
 *       assignment-hashing work. Assignment uses
 *       `namespaceHash("experiments-assign", slug + ":" +
 *       sessionHash)` to derive a 64-bit integer modulo the
 *       cumulative weight.
 *     - b.uuid.v7 — every experiment_events row carries a v7 id so
 *       rows sort lexicographically by insertion time.
 *
 *   Storage:
 *     - experiments + experiment_events
 *       (migration 0071_experiments.sql).
 *
 * @primitive experiments
 * @related   b.crypto.namespaceHash, b.uuid.v7
 */

var MAX_SLUG_LEN          = 80;
var MAX_TITLE_LEN         = 200;
var MAX_HYPOTHESIS_LEN    = 2000;
var MAX_METRIC_LEN        = 80;
var MAX_VARIANTS          = 32;
var MAX_WEIGHT            = 1000000;

var SESSION_NAMESPACE     = "experiments-session";
var ASSIGN_NAMESPACE      = "experiments-assign";

var ALLOWED_STATUSES = Object.freeze([
  "draft",
  "running",
  "paused",
  "archived",
]);

// FSM transition graph. Mirrors the migration header comment.
// Archived is terminal — no outbound edges.
var TRANSITIONS = Object.freeze({
  draft:    { pause: null,      resume: "running",  archive: "archived" },
  running:  { pause: "paused",  resume: null,       archive: "archived" },
  paused:   { pause: null,      resume: "running",  archive: "archived" },
  archived: { pause: null,      resume: null,       archive: null      },
});

var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Refuse C0 control bytes + DEL in operator-authored strings. The
// title + hypothesis fields land into the operator dashboard, not the
// storefront, but the discipline is the same — strings reach the
// operator UI as inert text, never as live markup.
var CONTROL_BYTE_LINE_RE  = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_BLOCK_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Zero-width / direction-override family — mirrors the promo-banners
// + gift-options catalogues. Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "hypothesis",
  "primary_metric",
  "ends_at",
]);

var b = require("./vendor/blamejs");

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("experiments: " + (label || "slug") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _line(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("experiments: " + label + " must be a non-empty string ≤ " + maxLen + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("experiments: " + label + " contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("experiments: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _block(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("experiments: " + label + " must be a non-empty string ≤ " + maxLen + " chars");
  }
  if (CONTROL_BYTE_BLOCK_RE.test(s)) {
    throw new TypeError("experiments: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("experiments: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _status(s) {
  if (typeof s !== "string" || ALLOWED_STATUSES.indexOf(s) === -1) {
    throw new TypeError("experiments: status must be one of " + JSON.stringify(ALLOWED_STATUSES));
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("experiments: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("experiments: " + label + " must be a non-negative integer");
  }
  return n;
}

function _variants(arr) {
  if (!Array.isArray(arr) || arr.length < 2) {
    throw new TypeError("experiments: variants must be an array of at least 2 { slug, weight } records");
  }
  if (arr.length > MAX_VARIANTS) {
    throw new TypeError("experiments: variants must be ≤ " + MAX_VARIANTS + " records");
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var v = arr[i];
    if (!v || typeof v !== "object") {
      throw new TypeError("experiments: variants[" + i + "] must be an object");
    }
    var vs = _slug(v.slug, "variants[" + i + "].slug");
    if (seen[vs]) {
      throw new TypeError("experiments: variants[" + i + "].slug duplicates an earlier variant slug");
    }
    seen[vs] = true;
    if (!Number.isInteger(v.weight) || v.weight < 1 || v.weight > MAX_WEIGHT) {
      throw new TypeError("experiments: variants[" + i + "].weight must be an integer in [1, " + MAX_WEIGHT + "]");
    }
    out.push({ slug: vs, weight: v.weight });
  }
  return out;
}

function _now() { return Date.now(); }

// ---- assignment math ----------------------------------------------------
//
// The 64-bit modulus is computed from the first 16 hex chars (64
// bits) of the SHA3-512 hex output. JavaScript numbers are 53-bit
// safe, so the modulus is taken in two 32-bit halves to stay inside
// integer-arithmetic territory. Mathematically this is identical to
// taking the modulus of the full 64-bit unsigned integer.

function _modCumulativeWeight(sessionHashHex, cumulativeWeight) {
  // Take the first 8 hex bytes (32 bits) as the high half, next 8 as
  // the low half. Combine with: (high * 2^32 + low) mod CW =
  // ((high mod CW) * (2^32 mod CW) + low) mod CW.
  var high = parseInt(sessionHashHex.slice(0, 8), 16);
  var low  = parseInt(sessionHashHex.slice(8, 16), 16);
  var cw   = cumulativeWeight;
  var twoToThe32ModCw = 4294967296 % cw;
  return ((high % cw) * twoToThe32ModCw + low) % cw;
}

// ---- Wilson score interval ---------------------------------------------
//
// Two-sided 95% confidence interval for a Bernoulli proportion. The
// Wilson interval is well-behaved at the extremes (0% / 100%) and
// for small sample sizes — strictly preferable to the normal-
// approximation interval that newcomers reach for. Returns
// { lower, upper } with both bounds clamped into [0, 1].

var Z_95 = 1.959963984540054;  // two-sided 95% z-score

function _wilsonCi(successes, trials) {
  if (trials <= 0) return { lower: 0, upper: 0 };
  var z   = Z_95;
  var n   = trials;
  var p   = successes / n;
  var z2  = z * z;
  var denom = 1 + z2 / n;
  var center = (p + z2 / (2 * n)) / denom;
  var half   = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  var lower = center - half;
  var upper = center + half;
  if (lower < 0) lower = 0;
  if (upper > 1) upper = 1;
  return { lower: lower, upper: upper };
}

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  var variants;
  try {
    variants = JSON.parse(r.variants_json);
  } catch (_e) {
    variants = [];
  }
  return {
    slug:           r.slug,
    title:          r.title,
    hypothesis:     r.hypothesis,
    variants:       variants,
    primary_metric: r.primary_metric,
    status:         r.status,
    starts_at:      Number(r.starts_at),
    ends_at:        r.ends_at     == null ? null : Number(r.ends_at),
    paused_at:      r.paused_at   == null ? null : Number(r.paused_at),
    archived_at:    r.archived_at == null ? null : Number(r.archived_at),
    created_at:     Number(r.created_at),
    updated_at:     Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  function _hashSession(sessionId) {
    return b.crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
  }

  function _assignVariant(experimentSlug, sessionHash, variants) {
    var cw = 0;
    for (var i = 0; i < variants.length; i += 1) cw += variants[i].weight;
    var keyHash = b.crypto.namespaceHash(ASSIGN_NAMESPACE, experimentSlug + ":" + sessionHash);
    var bucket  = _modCumulativeWeight(keyHash, cw);
    var acc = 0;
    for (var j = 0; j < variants.length; j += 1) {
      acc += variants[j].weight;
      if (bucket < acc) return variants[j];
    }
    // Defensive fallback — should be unreachable since
    // bucket < cw = sum(weights). The fallback prevents an off-by-
    // one in floating-point summation (cumulative weights are ints,
    // so summation is exact) from returning undefined and crashing
    // the request.
    return variants[variants.length - 1];
  }

  // -- defineExperiment ---------------------------------------------------

  async function defineExperiment(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("experiments.defineExperiment: input object required");
    }
    var slug          = _slug(input.slug);
    var title         = _line(input.title, "title", MAX_TITLE_LEN);
    var hypothesis    = _block(input.hypothesis, "hypothesis", MAX_HYPOTHESIS_LEN);
    var variants      = _variants(input.variants);
    var primaryMetric = _line(input.primary_metric, "primary_metric", MAX_METRIC_LEN);
    var status        = _status(input.status);
    if (status === "archived") {
      throw new TypeError("experiments.defineExperiment: cannot define an experiment in 'archived' status");
    }
    var startsAt      = _epochMs(input.starts_at, "starts_at");
    var endsAt        = null;
    if (input.ends_at != null) {
      endsAt = _epochMs(input.ends_at, "ends_at");
      if (endsAt <= startsAt) {
        throw new TypeError("experiments.defineExperiment: ends_at must be strictly greater than starts_at");
      }
    }

    var ts = _now();
    var pausedAt = status === "paused" ? ts : null;
    await query(
      "INSERT INTO experiments (slug, title, hypothesis, variants_json, primary_metric, " +
      "status, starts_at, ends_at, paused_at, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?10)",
      [slug, title, hypothesis, JSON.stringify(variants), primaryMetric,
       status, startsAt, endsAt, pausedAt, ts],
    );
    return await getExperiment(slug);
  }

  // -- getExperiment / listExperiments -----------------------------------

  async function getExperiment(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM experiments WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function listExperiments(listOpts) {
    listOpts = listOpts || {};
    var sql, params;
    if (listOpts.status != null) {
      _status(listOpts.status);
      sql = "SELECT * FROM experiments WHERE status = ?1 ORDER BY starts_at DESC, slug ASC";
      params = [listOpts.status];
    } else {
      sql = "SELECT * FROM experiments ORDER BY starts_at DESC, slug ASC";
      params = [];
    }
    var rows = (await query(sql, params)).rows;
    return rows.map(_hydrateRow);
  }

  // -- getVariant --------------------------------------------------------

  async function getVariant(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("experiments.getVariant: input object required");
    }
    _slug(input.experiment_slug, "experiment_slug");
    if (typeof input.session_id !== "string" || !input.session_id.length) {
      throw new TypeError("experiments.getVariant: session_id must be a non-empty string");
    }
    var sessionHash = _hashSession(input.session_id);

    var exp = await getExperiment(input.experiment_slug);
    if (!exp) return null;
    if (exp.status !== "running") return null;

    var nowTs = _now();
    if (nowTs < exp.starts_at) return null;
    if (exp.ends_at != null && nowTs >= exp.ends_at) return null;

    var v = _assignVariant(exp.slug, sessionHash, exp.variants);
    return {
      experiment_slug: exp.slug,
      variant_slug:    v.slug,
      session_id_hash: sessionHash,
    };
  }

  // -- recordConversion --------------------------------------------------

  // Drop-silent on unknown / archived experiment + unknown variant.
  // This runs on the hot conversion path (checkout-started, add-to-
  // cart, etc.); throwing here would crash the request that observed
  // the conversion. The validation layer at defineExperiment has
  // already verified that legitimate slugs exist; a request that
  // arrives with a stale slug after the experiment was archived
  // simply doesn't record, which is the correct observability
  // behavior.
  async function recordConversion(input) {
    if (!input || typeof input !== "object") return { recorded: false };
    if (typeof input.experiment_slug !== "string" || !SLUG_RE.test(input.experiment_slug)) {
      return { recorded: false };
    }
    if (typeof input.variant_slug !== "string" || !SLUG_RE.test(input.variant_slug)) {
      return { recorded: false };
    }
    if (typeof input.session_id !== "string" || !input.session_id.length) {
      return { recorded: false };
    }
    if (typeof input.metric !== "string" || !input.metric.length || input.metric.length > MAX_METRIC_LEN) {
      return { recorded: false };
    }
    if (CONTROL_BYTE_LINE_RE.test(input.metric) || ZERO_WIDTH_RE.test(input.metric)) {
      return { recorded: false };
    }
    var value = 1;
    if (input.value != null) {
      if (!Number.isInteger(input.value) || input.value < 0) return { recorded: false };
      value = input.value;
    }
    try {
      var exp = await getExperiment(input.experiment_slug);
      if (!exp) return { recorded: false };
      if (exp.status === "archived") return { recorded: false };
      // Variant must exist in the experiment's variant catalogue.
      var ok = false;
      for (var i = 0; i < exp.variants.length; i += 1) {
        if (exp.variants[i].slug === input.variant_slug) { ok = true; break; }
      }
      if (!ok) return { recorded: false };

      var sessionHash = _hashSession(input.session_id);
      var ts = _now();
      var id = b.uuid.v7();
      await query(
        "INSERT INTO experiment_events (id, experiment_slug, variant_slug, session_id_hash, metric, value, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, input.experiment_slug, input.variant_slug, sessionHash, input.metric, value, ts],
      );
      return { recorded: true, id: id };
    } catch (_e) {
      return { recorded: false };
    }
  }

  // -- metricsForExperiment ----------------------------------------------

  async function metricsForExperiment(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("experiments.metricsForExperiment: input object required");
    }
    _slug(input.experiment_slug, "experiment_slug");
    var until = _now();
    if (input.until != null) until = _epochMs(input.until, "until");

    var exp = await getExperiment(input.experiment_slug);
    if (!exp) {
      throw new TypeError("experiments.metricsForExperiment: experiment " +
        JSON.stringify(input.experiment_slug) + " not found");
    }

    // Operator-supplied per-variant assigned-session counts for the
    // Wilson CI denominator. Optional — when omitted, the report
    // returns raw counts only. The shape is { variant_slug:
    // assigned_count }.
    var assignedSessions = null;
    if (input.assigned_sessions != null) {
      if (typeof input.assigned_sessions !== "object") {
        throw new TypeError("experiments.metricsForExperiment: assigned_sessions must be a plain object");
      }
      assignedSessions = {};
      var keys = Object.keys(input.assigned_sessions);
      for (var i = 0; i < keys.length; i += 1) {
        assignedSessions[keys[i]] = _nonNegInt(
          input.assigned_sessions[keys[i]],
          "assigned_sessions[" + JSON.stringify(keys[i]) + "]"
        );
      }
    }

    // Per-variant raw counts of the primary metric in [exp.starts_at,
    // until]. The rollup is in SQL so the metrics report stays
    // efficient as the events table grows.
    var rows = (await query(
      "SELECT variant_slug, COUNT(*) AS conversions, COALESCE(SUM(value), 0) AS value_sum " +
      "FROM experiment_events " +
      "WHERE experiment_slug = ?1 AND metric = ?2 AND occurred_at <= ?3 " +
      "GROUP BY variant_slug",
      [exp.slug, exp.primary_metric, until],
    )).rows;
    var byVariant = Object.create(null);
    for (var r = 0; r < rows.length; r += 1) {
      byVariant[rows[r].variant_slug] = {
        conversions: Number(rows[r].conversions),
        value_sum:   Number(rows[r].value_sum),
      };
    }

    var out = [];
    for (var v = 0; v < exp.variants.length; v += 1) {
      var variant = exp.variants[v];
      var stats   = byVariant[variant.slug] || { conversions: 0, value_sum: 0 };
      var entry   = {
        variant_slug: variant.slug,
        weight:       variant.weight,
        conversions:  stats.conversions,
        value_sum:    stats.value_sum,
      };
      if (assignedSessions) {
        var assigned = assignedSessions[variant.slug] || 0;
        entry.assigned = assigned;
        if (assigned > 0) {
          entry.rate = stats.conversions / assigned;
          var ci = _wilsonCi(stats.conversions, assigned);
          entry.ci95_lower = ci.lower;
          entry.ci95_upper = ci.upper;
        } else {
          entry.rate = 0;
          entry.ci95_lower = 0;
          entry.ci95_upper = 0;
        }
      }
      out.push(entry);
    }

    return {
      experiment_slug: exp.slug,
      primary_metric:  exp.primary_metric,
      until:           until,
      variants:        out,
    };
  }

  // -- FSM transitions ---------------------------------------------------

  async function _transition(slug, event) {
    _slug(slug);
    var existing = await getExperiment(slug);
    if (!existing) {
      throw new TypeError("experiments." + event + ": slug " + JSON.stringify(slug) + " not found");
    }
    var allowed = TRANSITIONS[existing.status];
    var next    = allowed && allowed[event];
    if (!next) {
      throw new TypeError("experiments." + event + ": cannot " + event +
        " an experiment in status " + JSON.stringify(existing.status));
    }
    var ts = _now();
    var sets   = ["status = ?1", "updated_at = ?2"];
    var params = [next, ts];
    var idx    = 3;
    if (next === "paused") {
      sets.push("paused_at = ?" + idx);
      params.push(ts);
      idx += 1;
    } else if (next === "running") {
      // Clear paused_at on resume so the column reflects the most
      // recent pause window only.
      sets.push("paused_at = NULL");
    } else if (next === "archived") {
      sets.push("archived_at = ?" + idx);
      params.push(ts);
      idx += 1;
    }
    params.push(slug);
    await query(
      "UPDATE experiments SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    return await getExperiment(slug);
  }

  function pauseExperiment(slug)   { return _transition(slug, "pause"); }
  function resumeExperiment(slug)  { return _transition(slug, "resume"); }
  function archiveExperiment(slug) { return _transition(slug, "archive"); }

  // -- update ------------------------------------------------------------

  async function update(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("experiments.update: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("experiments.update: patch must include at least one column");
    }
    var existing = await getExperiment(slug);
    if (!existing) {
      throw new TypeError("experiments.update: slug " + JSON.stringify(slug) + " not found");
    }
    if (existing.status === "archived") {
      throw new TypeError("experiments.update: cannot update an archived experiment");
    }

    var sets    = [];
    var params  = [];
    var idx     = 1;
    var postEndsAt = existing.ends_at;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("experiments.update: unsupported column " + JSON.stringify(col));
      }
      var v;
      if      (col === "title")          { v = _line(patch[col], "title", MAX_TITLE_LEN); }
      else if (col === "hypothesis")     { v = _block(patch[col], "hypothesis", MAX_HYPOTHESIS_LEN); }
      else if (col === "primary_metric") { v = _line(patch[col], "primary_metric", MAX_METRIC_LEN); }
      else /* ends_at */ {
        if (patch[col] == null) { v = null; postEndsAt = null; }
        else { v = _epochMs(patch[col], "ends_at"); postEndsAt = v; }
      }
      sets.push(col + " = ?" + idx);
      params.push(v);
      idx += 1;
    }
    if (postEndsAt != null && postEndsAt <= existing.starts_at) {
      throw new TypeError("experiments.update: ends_at must be strictly greater than starts_at");
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    await query(
      "UPDATE experiments SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    return await getExperiment(slug);
  }

  return {
    MAX_SLUG_LEN:       MAX_SLUG_LEN,
    MAX_TITLE_LEN:      MAX_TITLE_LEN,
    MAX_HYPOTHESIS_LEN: MAX_HYPOTHESIS_LEN,
    MAX_METRIC_LEN:     MAX_METRIC_LEN,
    MAX_VARIANTS:       MAX_VARIANTS,
    MAX_WEIGHT:         MAX_WEIGHT,
    ALLOWED_STATUSES:   ALLOWED_STATUSES,
    TRANSITIONS:        TRANSITIONS,

    defineExperiment:       defineExperiment,
    getExperiment:          getExperiment,
    listExperiments:        listExperiments,
    getVariant:             getVariant,
    recordConversion:       recordConversion,
    metricsForExperiment:   metricsForExperiment,
    pauseExperiment:        pauseExperiment,
    resumeExperiment:       resumeExperiment,
    archiveExperiment:      archiveExperiment,
    update:                 update,
  };
}

module.exports = {
  create:             create,
  MAX_SLUG_LEN:       MAX_SLUG_LEN,
  MAX_TITLE_LEN:      MAX_TITLE_LEN,
  MAX_HYPOTHESIS_LEN: MAX_HYPOTHESIS_LEN,
  MAX_METRIC_LEN:     MAX_METRIC_LEN,
  MAX_VARIANTS:       MAX_VARIANTS,
  MAX_WEIGHT:         MAX_WEIGHT,
  ALLOWED_STATUSES:   ALLOWED_STATUSES,
  TRANSITIONS:        TRANSITIONS,
};
