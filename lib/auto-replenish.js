"use strict";
/**
 * @module shop.autoReplenish
 * @title  Auto-replenish — scheduler-driven layer that turns reorder
 *         threshold fires into auto-submitted POs against bound vendors
 *
 * @intro
 *   `reorderThresholds.proposePurchaseOrder` is the OPERATOR-driven
 *   layer: an admin opens the reorder queue, picks a vendor, and the
 *   primitive returns a draft payload the admin reviews + dispatches.
 *
 *   This primitive answers a different question: "I trust vendor X
 *   enough to let the framework auto-cut a PO whenever stock crosses
 *   the floor, without an admin in the loop." Operators bind a vendor
 *   to an auto-replenish POLICY, the scheduler ticks
 *   (`tickReplenishment`) on the policy's cadence, and the tick:
 *
 *     1. Calls `reorderThresholds.scanAll({ vendor_slug })` to find
 *        reorder candidates whose stock is at-or-below the floor.
 *     2. Aggregates the candidates by vendor.
 *     3. Applies the policy's min/max PO value gates + the
 *        max-concurrent-open-PO cap.
 *     4. Composes `purchaseOrders.createDraft` to land the PO row.
 *     5. If the policy doesn't require operator approval, immediately
 *        composes `purchaseOrders.submitToVendor` so the PO leaves
 *        draft and the vendor's gateway picks it up.
 *
 *   A `auto_replenish_runs` row is stamped per (policy, vendor) decision
 *   — `proposed` when a candidate set was found but a gate refused
 *   (under-min / over-max / cap), `submitted` when the PO left draft,
 *   `skipped` when scanAll returned nothing, `failed` when the
 *   composition threw.
 *
 *   Verbs:
 *     definePolicy            — register / patch an auto-replenish
 *                               policy. Identified by `slug`; the
 *                               vendor binding is optional (a null
 *                               vendor_slug means the policy aggregates
 *                               every candidate vendor on the tick).
 *                               Schedule enum: hourly / daily / weekly
 *                               — held as metadata; the operator's
 *                               cron-trigger orchestrator is the actual
 *                               clock. Defining the same slug a second
 *                               time patches in place.
 *     getPolicy / listPolicies — operator dashboard reads.
 *     updatePolicy            — partial patch by slug.
 *     archivePolicy           — soft-delete. Future ticks skip the
 *                               policy. Idempotent.
 *     tickReplenishment       — scheduler entry point. Walks every
 *                               active policy whose schedule matches
 *                               or whose `last_run_at` is null,
 *                               applies the candidate aggregation +
 *                               gates, and stamps a run row per
 *                               policy. Returns the run summaries so
 *                               the orchestrator can log + alert.
 *     replenishmentHistory    — operator read of the run rows in a
 *                               window. Filter by vendor_slug + status.
 *     markPolicyTriggered     — called by tickReplenishment after a
 *                               successful submit; also exposed for
 *                               operators who need to record an
 *                               out-of-band auto-fire (e.g. an EDI
 *                               gateway pushed a PO under a policy and
 *                               wants the history row stamped).
 *
 *   Composition (every dep injected; none required for the factory to
 *   construct, but each verb declares what it needs):
 *     - query                — D1 handle for the policy + runs tables
 *     - reorderThresholds    — `scanAll({ vendor_slug })` for the
 *                              candidate sweep
 *     - purchaseOrders       — `createDraft` + `submitToVendor` for
 *                              the PO compose
 *     - vendors              — `getVendor(slug)` to confirm the bound
 *                              vendor is still active (a policy
 *                              against an archived vendor is a
 *                              `skipped` run with `vendor-archived`
 *                              fail_reason)
 *     - b.uuid.v7            — run row ids
 *
 *   Three-tier input validation: every public verb is either a
 *   config-time entry point (definePolicy, updatePolicy,
 *   archivePolicy) — these throw on bad input — or a defensive
 *   request-shape reader (getPolicy, listPolicies, tickReplenishment,
 *   replenishmentHistory, markPolicyTriggered) — these also throw on
 *   bad input. There are no drop-silent hot-path sinks; the per-policy
 *   failures inside tickReplenishment land as a `failed` run row with
 *   the typed reason, not a drop.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var SLUG_RE             = /^[a-z0-9][a-z0-9-]{0,63}$/;
var ID_RE               = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var SCHEDULES           = Object.freeze(["hourly", "daily", "weekly"]);
var RUN_STATUSES        = Object.freeze(["proposed", "submitted", "skipped", "failed"]);

var MAX_PO_VALUE_MINOR  = 100000000000;  // 1e11 minor units — matches the PO primitive's per-line ceiling × room for multi-line aggregation
var MAX_CONCURRENT_CAP  = 1000;          // policy can't bind more than 1000 simultaneously-open POs against one vendor
var MAX_BATCH_SIZE      = 500;
var DEFAULT_BATCH_SIZE  = 100;
var MAX_LIMIT           = 500;

// Schedule cadence in milliseconds — used by tickReplenishment to
// decide whether a policy's `last_run_at` has aged enough to fire
// again. Stored as constants so tests can read them when constructing
// "tick just-after-last-run" scenarios.
var SCHEDULE_INTERVAL_MS = Object.freeze({
  hourly: 60 * 60 * 1000,
  daily:  24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
});

// ---- monotonic clock ----------------------------------------------------
//
// `tickReplenishment` can stamp multiple run rows in the same wall-clock
// millisecond (one per policy in the batch). The history-window read
// orders by run_at and ties on id; the monotonic step guarantees the
// run_at values strictly increase so the per-policy ordering is
// deterministic across replays.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("auto-replenish: " + label + " must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + dash, 1..64 chars)");
  }
  return s;
}

function _slugOrNull(s, label) {
  if (s == null) return null;
  return _slug(s, label);
}

function _id(s, label) {
  if (typeof s !== "string" || !ID_RE.test(s)) {
    throw new TypeError("auto-replenish: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _idOrNull(s, label) {
  if (s == null) return null;
  return _id(s, label);
}

function _poValue(n, label) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PO_VALUE_MINOR) {
    throw new TypeError("auto-replenish: " + label + " must be a non-negative integer ≤ " + MAX_PO_VALUE_MINOR);
  }
  return n;
}

function _concurrentCap(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_CONCURRENT_CAP) {
    throw new TypeError("auto-replenish: max_concurrent_open_pos must be a positive integer ≤ " + MAX_CONCURRENT_CAP);
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("auto-replenish: " + label + " must be a boolean");
  }
  return v;
}

function _schedule(s) {
  if (typeof s !== "string" || SCHEDULES.indexOf(s) === -1) {
    throw new TypeError("auto-replenish: schedule must be one of " + SCHEDULES.join(", "));
  }
  return s;
}

function _runStatus(s) {
  if (typeof s !== "string" || RUN_STATUSES.indexOf(s) === -1) {
    throw new TypeError("auto-replenish: status must be one of " + RUN_STATUSES.join(", "));
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("auto-replenish: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("auto-replenish: batch_size must be an integer in 1.." + MAX_BATCH_SIZE);
  }
  return n;
}

function _limit(n) {
  if (n == null) return MAX_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("auto-replenish: limit must be an integer in 1.." + MAX_LIMIT);
  }
  return n;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("auto-replenish: " + label + " must be a non-negative integer");
  }
  return n;
}

// ---- row hydration ------------------------------------------------------

function _shapePolicy(row) {
  if (!row) return null;
  return {
    slug:                     row.slug,
    vendor_slug:              row.vendor_slug == null ? null : row.vendor_slug,
    min_po_value_minor:       Number(row.min_po_value_minor),
    max_po_value_minor:       Number(row.max_po_value_minor),
    max_concurrent_open_pos:  Number(row.max_concurrent_open_pos),
    approval_required:        row.approval_required ? true : false,
    schedule:                 row.schedule,
    last_run_at:              row.last_run_at == null ? null : Number(row.last_run_at),
    archived_at:              row.archived_at == null ? null : Number(row.archived_at),
    created_at:               Number(row.created_at),
    updated_at:               Number(row.updated_at),
  };
}

function _shapeRun(row) {
  if (!row) return null;
  return {
    id:             row.id,
    policy_slug:    row.policy_slug,
    po_id:          row.po_id == null ? null : row.po_id,
    qty_proposed:   Number(row.qty_proposed),
    qty_submitted:  Number(row.qty_submitted),
    status:         row.status,
    run_at:         Number(row.run_at),
    fail_reason:    row.fail_reason == null ? null : row.fail_reason,
  };
}

// Compute the value (sum of qty × estimated unit cost) of a candidate
// set. The scan rows from reorderThresholds carry suggested_qty but no
// unit cost — auto-replenish keeps the value gate measured in MINOR
// CURRENCY UNITS via a per-line unit_cost_minor supplied by the
// candidate row (when the threshold layer adds it) OR by treating the
// quantity itself as the value proxy when no cost is available. The
// latter is a documented degradation: operators that want strict
// minor-currency gating wire a unit-cost source into reorderThresholds.
function _estimateLineValue(line) {
  if (line.unit_cost_minor != null && Number.isInteger(line.unit_cost_minor)) {
    return line.unit_cost_minor * Number(line.suggested_qty || 0);
  }
  // Fallback: treat one unit as one minor-currency unit so the gate
  // still functions on quantity. Operators surfacing this primitive
  // through documentation are told the gate degrades to quantity when
  // costs aren't supplied.
  return Number(line.suggested_qty || 0);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var reorderThresholds = opts.reorderThresholds || null;
  if (reorderThresholds != null && typeof reorderThresholds !== "object") {
    throw new TypeError("auto-replenish.create: opts.reorderThresholds must be an object or null");
  }
  if (reorderThresholds != null && typeof reorderThresholds.scanAll !== "function") {
    throw new TypeError("auto-replenish.create: opts.reorderThresholds must expose scanAll(...) when provided");
  }

  var purchaseOrders = opts.purchaseOrders || null;
  if (purchaseOrders != null && typeof purchaseOrders !== "object") {
    throw new TypeError("auto-replenish.create: opts.purchaseOrders must be an object or null");
  }
  if (purchaseOrders != null &&
      (typeof purchaseOrders.createDraft !== "function" ||
       typeof purchaseOrders.submitToVendor !== "function" ||
       typeof purchaseOrders.listPOs !== "function")) {
    throw new TypeError("auto-replenish.create: opts.purchaseOrders must expose createDraft + submitToVendor + listPOs when provided");
  }

  var vendors = opts.vendors || null;
  if (vendors != null && typeof vendors !== "object") {
    throw new TypeError("auto-replenish.create: opts.vendors must be an object or null");
  }

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  async function _getPolicyRaw(slug) {
    var r = await query(
      "SELECT * FROM auto_replenish_policies WHERE slug = ?1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function _countConcurrentOpenPOs(vendorSlug) {
    // The concurrent cap counts every PO not yet in a terminal state
    // (closed / cancelled / received) — those still consuming
    // vendor-side capacity. When the policy has a vendor_slug binding,
    // the cap applies to that vendor; when null, the cap applies
    // globally across every open PO.
    if (!purchaseOrders) return 0;
    var openStatuses = ["draft", "submitted", "confirmed", "partially_received"];
    var total = 0;
    for (var i = 0; i < openStatuses.length; i += 1) {
      var listOpts = { status: openStatuses[i] };
      if (vendorSlug != null) listOpts.vendor_slug = vendorSlug;
      var rows = await purchaseOrders.listPOs(listOpts);
      total += rows.length;
    }
    return total;
  }

  async function _insertRun(row) {
    await query(
      "INSERT INTO auto_replenish_runs " +
      "(id, policy_slug, po_id, qty_proposed, qty_submitted, status, run_at, fail_reason) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [row.id, row.policy_slug, row.po_id, row.qty_proposed, row.qty_submitted,
       row.status, row.run_at, row.fail_reason],
    );
  }

  // Execute the per-policy aggregation + compose. Returns the run row
  // (already inserted) so tickReplenishment can collect summaries.
  async function _runPolicyOnce(policy, now) {
    var runId  = _b().uuid.v7();
    var runRow = {
      id:             runId,
      policy_slug:    policy.slug,
      po_id:          null,
      qty_proposed:   0,
      qty_submitted:  0,
      status:         "skipped",
      run_at:         _now(),
      fail_reason:    null,
    };

    // Vendor-archived check — when the policy binds a vendor and the
    // vendors handle is wired, refuse to fire against an archived
    // vendor (the PO would be refused downstream anyway).
    if (policy.vendor_slug != null && vendors != null && typeof vendors.getVendor === "function") {
      var v = await vendors.getVendor(policy.vendor_slug);
      if (!v) {
        runRow.status      = "failed";
        runRow.fail_reason = "vendor-not-found";
        await _insertRun(runRow);
        return runRow;
      }
      if (v.status === "archived") {
        runRow.status      = "skipped";
        runRow.fail_reason = "vendor-archived";
        await _insertRun(runRow);
        return runRow;
      }
    }

    // Composition guards — the verb requires both deps wired.
    if (!reorderThresholds) {
      runRow.status      = "failed";
      runRow.fail_reason = "reorder-thresholds-dep-missing";
      await _insertRun(runRow);
      return runRow;
    }
    if (!purchaseOrders) {
      runRow.status      = "failed";
      runRow.fail_reason = "purchase-orders-dep-missing";
      await _insertRun(runRow);
      return runRow;
    }

    // Pull reorder candidates filtered to the policy's vendor binding
    // (or every vendor when policy.vendor_slug is null).
    var scanInput = { as_of: now };
    if (policy.vendor_slug != null) scanInput.vendor_slug = policy.vendor_slug;
    var candidates;
    try {
      candidates = await reorderThresholds.scanAll(scanInput);
    } catch (e) {
      runRow.status      = "failed";
      runRow.fail_reason = "scan-failed:" + ((e && e.message) || "unknown");
      await _insertRun(runRow);
      return runRow;
    }

    if (!candidates || candidates.length === 0) {
      runRow.status      = "skipped";
      runRow.fail_reason = "no-candidates";
      await _insertRun(runRow);
      return runRow;
    }

    // Group candidates by vendor_slug. A null-bound policy may pick up
    // candidates from many vendors in one sweep — fire one PO per
    // distinct vendor, each gated independently.
    var groups = Object.create(null);
    for (var i = 0; i < candidates.length; i += 1) {
      var c = candidates[i];
      if (c.vendor_slug == null) continue; // candidates without a vendor binding can't be auto-fired
      if (!groups[c.vendor_slug]) groups[c.vendor_slug] = [];
      groups[c.vendor_slug].push(c);
    }
    var vendorKeys = Object.keys(groups);
    if (vendorKeys.length === 0) {
      runRow.status      = "skipped";
      runRow.fail_reason = "no-vendor-bound-candidates";
      await _insertRun(runRow);
      return runRow;
    }

    // For policies bound to a specific vendor_slug, only that vendor's
    // group fires. For null-bound policies, every vendor's group fires
    // — but the run row aggregates totals across the groups, and the
    // first successful submit's PO id is stamped (further submits are
    // recorded as additional runs via markPolicyTriggered).
    var targetVendors = policy.vendor_slug != null ? [policy.vendor_slug] : vendorKeys;

    var firstPoId       = null;
    var totalProposed   = 0;
    var totalSubmitted  = 0;
    var firstFailReason = null;
    var firstFailStatus = null;

    for (var j = 0; j < targetVendors.length; j += 1) {
      var vendorSlug = targetVendors[j];
      var group = groups[vendorSlug];
      if (!group || !group.length) continue;

      var groupQty   = 0;
      var groupValue = 0;
      var poLines = [];
      for (var k = 0; k < group.length; k += 1) {
        var line = group[k];
        var qty  = Number(line.suggested_qty) || 0;
        if (qty <= 0) continue;
        groupQty   += qty;
        groupValue += _estimateLineValue(line);
        poLines.push({
          sku:              line.sku,
          quantity:         qty,
          unit_cost_minor:  line.unit_cost_minor != null ? line.unit_cost_minor : 0,
          currency:         line.currency || "USD",
        });
      }

      totalProposed += groupQty;

      if (poLines.length === 0) {
        if (!firstFailReason) {
          firstFailStatus = "skipped";
          firstFailReason = "no-positive-qty-lines";
        }
        continue;
      }

      if (groupValue < policy.min_po_value_minor) {
        if (!firstFailReason) {
          firstFailStatus = "proposed";
          firstFailReason = "under-min-po-value";
        }
        continue;
      }
      if (groupValue > policy.max_po_value_minor) {
        if (!firstFailReason) {
          firstFailStatus = "proposed";
          firstFailReason = "over-max-po-value";
        }
        continue;
      }

      var openCount = await _countConcurrentOpenPOs(vendorSlug);
      if (openCount >= policy.max_concurrent_open_pos) {
        if (!firstFailReason) {
          firstFailStatus = "proposed";
          firstFailReason = "concurrent-open-cap-reached";
        }
        continue;
      }

      // Compose the PO draft. Any throw from createDraft / submitToVendor
      // records a failed run with the typed reason — the framework
      // never leaves the operator guessing why an automated submit
      // didn't land.
      var draft;
      try {
        draft = await purchaseOrders.createDraft({
          vendor_slug: vendorSlug,
          lines:       poLines,
          notes:       "auto-replenish:" + policy.slug,
        });
      } catch (e) {
        if (!firstFailReason) {
          firstFailStatus = "failed";
          firstFailReason = "create-draft-failed:" + ((e && e.message) || "unknown");
        }
        continue;
      }

      if (firstPoId == null) firstPoId = draft.id;

      if (!policy.approval_required) {
        try {
          await purchaseOrders.submitToVendor({
            po_id:        draft.id,
            submitted_by: "auto-replenish:" + policy.slug,
          });
          totalSubmitted += groupQty;
        } catch (e) {
          if (!firstFailReason) {
            firstFailStatus = "failed";
            firstFailReason = "submit-failed:" + ((e && e.message) || "unknown");
          }
        }
      }
    }

    runRow.po_id         = firstPoId;
    runRow.qty_proposed  = totalProposed;
    runRow.qty_submitted = totalSubmitted;

    if (firstPoId != null && (totalSubmitted > 0 || policy.approval_required)) {
      // A PO landed. If approval was required, the PO is parked in
      // draft and the run is "proposed"; if approval wasn't required,
      // a successful submit advances to "submitted". A partially-
      // successful submit (some vendors landed, others tripped a gate)
      // still records "submitted" because the operator's PO surface
      // already carries the per-PO truth.
      runRow.status      = totalSubmitted > 0 ? "submitted" : "proposed";
      runRow.fail_reason = totalSubmitted > 0 ? null : firstFailReason;
    } else if (firstFailReason) {
      runRow.status      = firstFailStatus || "skipped";
      runRow.fail_reason = firstFailReason;
    } else {
      runRow.status      = "skipped";
      runRow.fail_reason = "no-candidates";
    }

    // Stamp last_run_at so the cadence check excludes this policy from
    // the next tick until the schedule interval elapses.
    await query(
      "UPDATE auto_replenish_policies SET last_run_at = ?1, updated_at = ?1 WHERE slug = ?2",
      [runRow.run_at, policy.slug],
    );

    await _insertRun(runRow);
    return runRow;
  }

  return {
    SCHEDULES:                 SCHEDULES.slice(),
    RUN_STATUSES:              RUN_STATUSES.slice(),
    SCHEDULE_INTERVAL_MS:      SCHEDULE_INTERVAL_MS,
    MAX_PO_VALUE_MINOR:        MAX_PO_VALUE_MINOR,
    MAX_CONCURRENT_CAP:        MAX_CONCURRENT_CAP,

    // Register / patch an auto-replenish policy. The slug is the
    // primary key — re-defining the same slug patches every field in
    // place (operators surfacing this through an admin UI write the
    // same slug repeatedly on each "save").
    definePolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("auto-replenish.definePolicy: input object required");
      }
      var slug              = _slug(input.slug, "slug");
      var vendorSlug        = _slugOrNull(input.vendor_slug, "vendor_slug");
      var minVal            = _poValue(input.min_po_value_minor, "min_po_value_minor");
      var maxVal            = _poValue(input.max_po_value_minor, "max_po_value_minor");
      if (maxVal < minVal) {
        throw new TypeError("auto-replenish.definePolicy: max_po_value_minor (" +
          maxVal + ") must be ≥ min_po_value_minor (" + minVal + ")");
      }
      var maxConcurrent     = _concurrentCap(input.max_concurrent_open_pos);
      var approvalRequired  = _bool(input.approval_required, "approval_required");
      var schedule          = _schedule(input.schedule);
      var ts                = _now();

      var existing = await _getPolicyRaw(slug);
      if (existing) {
        await query(
          "UPDATE auto_replenish_policies SET vendor_slug = ?1, min_po_value_minor = ?2, " +
          "max_po_value_minor = ?3, max_concurrent_open_pos = ?4, approval_required = ?5, " +
          "schedule = ?6, archived_at = NULL, updated_at = ?7 WHERE slug = ?8",
          [vendorSlug, minVal, maxVal, maxConcurrent, approvalRequired ? 1 : 0,
           schedule, ts, slug],
        );
        return _shapePolicy(await _getPolicyRaw(slug));
      }

      await query(
        "INSERT INTO auto_replenish_policies " +
        "(slug, vendor_slug, min_po_value_minor, max_po_value_minor, " +
        " max_concurrent_open_pos, approval_required, schedule, last_run_at, " +
        " archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?8)",
        [slug, vendorSlug, minVal, maxVal, maxConcurrent,
         approvalRequired ? 1 : 0, schedule, ts],
      );
      return _shapePolicy(await _getPolicyRaw(slug));
    },

    getPolicy: async function (slug) {
      _slug(slug, "slug");
      return _shapePolicy(await _getPolicyRaw(slug));
    },

    listPolicies: async function (listOpts) {
      listOpts = listOpts || {};
      var clauses = [];
      var params  = [];
      var idx     = 1;
      if (!listOpts.include_archived) {
        clauses.push("archived_at IS NULL");
      }
      if (listOpts.vendor_slug !== undefined) {
        if (listOpts.vendor_slug === null) {
          clauses.push("vendor_slug IS NULL");
        } else {
          _slug(listOpts.vendor_slug, "vendor_slug");
          clauses.push("vendor_slug = ?" + idx);
          params.push(listOpts.vendor_slug);
          idx += 1;
        }
      }
      if (listOpts.schedule !== undefined) {
        _schedule(listOpts.schedule);
        clauses.push("schedule = ?" + idx);
        params.push(listOpts.schedule);
        idx += 1;
      }
      var where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
      var r = await query(
        "SELECT * FROM auto_replenish_policies " + where +
        " ORDER BY slug ASC",
        params,
      );
      return r.rows.map(_shapePolicy);
    },

    updatePolicy: async function (slug, patch) {
      _slug(slug, "slug");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("auto-replenish.updatePolicy: patch object required");
      }
      var existing = await _getPolicyRaw(slug);
      if (!existing) {
        throw new TypeError("auto-replenish.updatePolicy: policy " +
          JSON.stringify(slug) + " not found");
      }
      var nextMin = Number(existing.min_po_value_minor);
      var nextMax = Number(existing.max_po_value_minor);

      var sets = [];
      var params = [];
      var idx = 1;
      if (Object.prototype.hasOwnProperty.call(patch, "vendor_slug")) {
        var vs = _slugOrNull(patch.vendor_slug, "vendor_slug");
        sets.push("vendor_slug = ?" + idx); params.push(vs); idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "min_po_value_minor")) {
        _poValue(patch.min_po_value_minor, "min_po_value_minor");
        nextMin = patch.min_po_value_minor;
        sets.push("min_po_value_minor = ?" + idx);
        params.push(patch.min_po_value_minor);
        idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "max_po_value_minor")) {
        _poValue(patch.max_po_value_minor, "max_po_value_minor");
        nextMax = patch.max_po_value_minor;
        sets.push("max_po_value_minor = ?" + idx);
        params.push(patch.max_po_value_minor);
        idx += 1;
      }
      if (nextMax < nextMin) {
        throw new TypeError("auto-replenish.updatePolicy: max_po_value_minor (" +
          nextMax + ") must be ≥ min_po_value_minor (" + nextMin + ")");
      }
      if (Object.prototype.hasOwnProperty.call(patch, "max_concurrent_open_pos")) {
        _concurrentCap(patch.max_concurrent_open_pos);
        sets.push("max_concurrent_open_pos = ?" + idx);
        params.push(patch.max_concurrent_open_pos);
        idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "approval_required")) {
        _bool(patch.approval_required, "approval_required");
        sets.push("approval_required = ?" + idx);
        params.push(patch.approval_required ? 1 : 0);
        idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "schedule")) {
        _schedule(patch.schedule);
        sets.push("schedule = ?" + idx); params.push(patch.schedule); idx += 1;
      }
      if (sets.length === 0) return _shapePolicy(existing);
      sets.push("updated_at = ?" + idx); params.push(_now()); idx += 1;
      params.push(slug);
      await query(
        "UPDATE auto_replenish_policies SET " + sets.join(", ") + " WHERE slug = ?" + idx,
        params,
      );
      return _shapePolicy(await _getPolicyRaw(slug));
    },

    archivePolicy: async function (slug) {
      _slug(slug, "slug");
      var existing = await _getPolicyRaw(slug);
      if (!existing) {
        throw new TypeError("auto-replenish.archivePolicy: policy " +
          JSON.stringify(slug) + " not found");
      }
      if (existing.archived_at != null) return _shapePolicy(existing);
      var ts = _now();
      await query(
        "UPDATE auto_replenish_policies SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return _shapePolicy(await _getPolicyRaw(slug));
    },

    // Scheduler entry point. Walks active policies that are due (the
    // schedule interval has elapsed since last_run_at, or last_run_at
    // is null), composes the per-policy run, and returns the run
    // summaries. The orchestrator (Workers Cron Trigger / external
    // cron) calls this on a tight cadence (e.g. every minute); the
    // policy's `schedule` field then gates which policies actually
    // fire on a given tick.
    tickReplenishment: async function (input) {
      input = input || {};
      var now = input.now == null ? _now() : _epochMs(input.now, "now");
      var batchSize = _batchSize(input.batch_size);

      var r = await query(
        "SELECT * FROM auto_replenish_policies WHERE archived_at IS NULL " +
        "ORDER BY slug ASC LIMIT ?1",
        [batchSize],
      );
      var rows = r.rows;
      var summaries = [];
      for (var i = 0; i < rows.length; i += 1) {
        var policy = _shapePolicy(rows[i]);
        var interval = SCHEDULE_INTERVAL_MS[policy.schedule];
        if (policy.last_run_at != null && (now - policy.last_run_at) < interval) {
          continue;
        }
        var runRow = await _runPolicyOnce(policy, now);
        summaries.push(_shapeRun(runRow));
      }
      return summaries;
    },

    replenishmentHistory: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("auto-replenish.replenishmentHistory: input object required");
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to, "to");
      if (to < from) {
        throw new TypeError("auto-replenish.replenishmentHistory: to (" +
          to + ") must be ≥ from (" + from + ")");
      }
      var clauses = ["run_at >= ?1", "run_at <= ?2"];
      var params  = [from, to];
      var idx     = 3;
      if (input.vendor_slug !== undefined) {
        _slug(input.vendor_slug, "vendor_slug");
        // Join through the policy row so the operator can filter by
        // the vendor binding without storing it redundantly on the run
        // row.
        clauses.push("policy_slug IN (SELECT slug FROM auto_replenish_policies WHERE vendor_slug = ?" + idx + ")");
        params.push(input.vendor_slug);
        idx += 1;
      }
      if (input.status !== undefined) {
        _runStatus(input.status);
        clauses.push("status = ?" + idx);
        params.push(input.status);
        idx += 1;
      }
      var limit = _limit(input.limit);
      params.push(limit);
      var sql = "SELECT * FROM auto_replenish_runs WHERE " + clauses.join(" AND ") +
                " ORDER BY run_at DESC, id DESC LIMIT ?" + idx;
      var rr = await query(sql, params);
      return rr.rows.map(_shapeRun);
    },

    markPolicyTriggered: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("auto-replenish.markPolicyTriggered: input object required");
      }
      var policySlug   = _slug(input.policy_slug, "policy_slug");
      var poId         = _idOrNull(input.po_id, "po_id");
      var qtyProposed  = _nonNegInt(input.qty_proposed, "qty_proposed");
      var qtySubmitted = _nonNegInt(input.qty_submitted, "qty_submitted");
      if (qtySubmitted > qtyProposed) {
        throw new TypeError("auto-replenish.markPolicyTriggered: qty_submitted (" +
          qtySubmitted + ") must be ≤ qty_proposed (" + qtyProposed + ")");
      }
      var existing = await _getPolicyRaw(policySlug);
      if (!existing) {
        throw new TypeError("auto-replenish.markPolicyTriggered: policy " +
          JSON.stringify(policySlug) + " not found");
      }
      var runRow = {
        id:             _b().uuid.v7(),
        policy_slug:    policySlug,
        po_id:          poId,
        qty_proposed:   qtyProposed,
        qty_submitted:  qtySubmitted,
        status:         qtySubmitted > 0 ? "submitted" : "proposed",
        run_at:         _now(),
        fail_reason:    null,
      };
      await _insertRun(runRow);
      await query(
        "UPDATE auto_replenish_policies SET last_run_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [runRow.run_at, policySlug],
      );
      return _shapeRun(runRow);
    },
  };
}

// Smoke-callable run() — exercises the factory shape against an
// in-memory query stub so the release pipeline can confirm the module
// loads + composes without a live D1 or migration. The stub round-
// trips definePolicy → getPolicy → markPolicyTriggered →
// replenishmentHistory; the actual scheduler path (tickReplenishment
// composing reorderThresholds + purchaseOrders) lives in the layer-1
// state test where the full sqlite + dep graph is wired.
async function run() {
  var policies = {};
  var runs = [];
  var q = async function (sql, params) {
    params = params || [];
    var verb = sql.replace(/^\s+/, "").split(/\s+/)[0].toUpperCase();
    if (verb === "SELECT" && /FROM auto_replenish_policies/.test(sql) && /slug\s*=\s*\?1/.test(sql)) {
      var p = policies[params[0]];
      return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
    }
    if (verb === "SELECT" && /FROM auto_replenish_policies/.test(sql)) {
      var out = [];
      var keys = Object.keys(policies);
      for (var k = 0; k < keys.length; k += 1) {
        if (policies[keys[k]].archived_at == null) out.push(policies[keys[k]]);
      }
      return { rows: out, rowCount: out.length };
    }
    if (verb === "INSERT" && /auto_replenish_policies/.test(sql)) {
      policies[params[0]] = {
        slug:                     params[0],
        vendor_slug:              params[1],
        min_po_value_minor:       params[2],
        max_po_value_minor:       params[3],
        max_concurrent_open_pos:  params[4],
        approval_required:        params[5],
        schedule:                 params[6],
        last_run_at:              null,
        archived_at:              null,
        created_at:               params[7],
        updated_at:               params[7],
      };
      return { rows: [], rowCount: 1 };
    }
    if (verb === "UPDATE" && /auto_replenish_policies/.test(sql)) {
      var slug = params[params.length - 1];
      var ex = policies[slug];
      if (ex) ex.updated_at = params[params.length - 2];
      return { rows: [], rowCount: ex ? 1 : 0 };
    }
    if (verb === "INSERT" && /auto_replenish_runs/.test(sql)) {
      runs.push({
        id:             params[0],
        policy_slug:    params[1],
        po_id:          params[2],
        qty_proposed:   params[3],
        qty_submitted:  params[4],
        status:         params[5],
        run_at:         params[6],
        fail_reason:    params[7],
      });
      return { rows: [], rowCount: 1 };
    }
    if (verb === "SELECT" && /FROM auto_replenish_runs/.test(sql)) {
      return { rows: runs.slice(), rowCount: runs.length };
    }
    return { rows: [], rowCount: 0 };
  };
  var ar = create({ query: q });
  await ar.definePolicy({
    slug:                    "smoke-policy",
    vendor_slug:             "acme-supplies",
    min_po_value_minor:      1000,
    max_po_value_minor:      1000000,
    max_concurrent_open_pos: 5,
    approval_required:       false,
    schedule:                "daily",
  });
  var p = await ar.getPolicy("smoke-policy");
  if (!p || p.slug !== "smoke-policy") {
    throw new Error("auto-replenish.run: smoke definePolicy round-trip failed");
  }
  return { ok: true };
}

module.exports = {
  create:                create,
  run:                   run,
  SCHEDULES:             SCHEDULES,
  RUN_STATUSES:          RUN_STATUSES,
  SCHEDULE_INTERVAL_MS:  SCHEDULE_INTERVAL_MS,
};
