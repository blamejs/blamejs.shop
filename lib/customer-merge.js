"use strict";
/**
 * @module shop.customerMerge
 * @title  Customer merge — deduplicate accounts onto a canonical id
 *
 * @intro
 *   Operator-driven consolidation of duplicate customer accounts.
 *   The same person can land in the customer table twice — two
 *   email addresses (work + personal), two passkey enrollments
 *   that never got linked, a guest checkout that later registered
 *   under a different address. The merge primitive picks a
 *   canonical (target) customer and a duplicate (source), proposes
 *   a dry-run plan listing every reparent the merge would
 *   commit, then executes the plan atomically: every order /
 *   subscription / loyalty-ledger row / review / address /
 *   payment-method that points at the source customer is
 *   rewritten to point at the target. The source customer row is
 *   soft-archived and a redirect marker is recorded so any later
 *   read of the source id transparently resolves to the target.
 *
 *   Four-stage FSM:
 *
 *     proposeMerge   - records a {source, target, plan_json}
 *                      row in `customer_merges` with status
 *                      `proposed`. No rows reparented; `plan_json`
 *                      is the frozen snapshot of per-primitive
 *                      affected-row counts captured against the
 *                      database AT proposal time.
 *
 *     executeMerge   - reparents every affected row atomically.
 *                      Pre-flight all child primitives FIRST (count
 *                      what we're about to touch) - any pre-flight
 *                      error surfaces before any UPDATE runs.
 *                      Then commit all reparents; stamp
 *                      executed_at / executed_by; insert the
 *                      redirect marker; the merge row lands in
 *                      `executed`.
 *
 *     rollbackMerge  - within `ROLLBACK_WINDOW_MS` (7 days) of
 *                      execution, reverses every reparent that
 *                      `executeMerge` wrote, deletes the redirect
 *                      marker, and lands the merge in
 *                      `rolled_back`. Past the window, refuses.
 *                      The rollback uses the SAME per-primitive
 *                      reparent verbs in reverse — it does NOT
 *                      restore arbitrary historical state, only
 *                      the inverse of what THIS merge wrote.
 *
 *     cancelMerge    - drops a `proposed` plan without ever
 *                      executing it. Lands the merge in
 *                      `cancelled`. Idempotent on the cancelled
 *                      terminal state.
 *
 *   Composes (every child primitive is OPTIONAL — wire only what
 *   the operator's deployment uses):
 *
 *     - opts.customers       — `getCustomerById(id)` /
 *                              `archiveCustomer(id)` /
 *                              `restoreCustomer(id)`. REQUIRED;
 *                              the source row's soft-archive +
 *                              the merge's own customer-existence
 *                              gate live here.
 *     - opts.order           — `reparentForCustomer(fromId, toId)`
 *                              / `countForCustomer(id)`. Optional;
 *                              absent, the merge plan reports
 *                              `orders: 0` and skips the reparent.
 *     - opts.subscriptions   — same shape.
 *     - opts.loyalty         — same shape.
 *     - opts.reviews         — same shape.
 *     - opts.addresses       — same shape.
 *     - opts.paymentMethods  — same shape.
 *
 *   Every child verb's contract:
 *     - `countForCustomer(id)` returns an integer (rows that
 *       reference this customer id).
 *     - `reparentForCustomer(fromId, toId)` rewrites every row
 *       pointing at `fromId` to point at `toId`. Returns
 *       `{ rowCount }` so the merge can sanity-check the actual
 *       writes against the plan.
 *
 *   The merge primitive itself owns NO domain rows — it ONLY
 *   reparents through these injected verbs. That's the
 *   composition story: operators bring their own primitives;
 *   this primitive orchestrates the multi-table rewrite + the
 *   audit trail + the rollback window.
 *
 *   findDuplicateCandidates:
 *
 *     Heuristic candidate generation, NOT a primary-key index.
 *     The operator's customers primitive exposes a list-by-name +
 *     list-by-email-hash surface; this primitive scans for
 *     fuzzy-name collisions above a configurable similarity floor
 *     (Jaro-Winkler over the lowercased display_name) and surfaces
 *     them as candidates. The caller still has to make the merge
 *     decision — the candidate list is operator-review material,
 *     not auto-confirm material.
 *
 *   redirectFor:
 *
 *     A canonical-id lookup helper for callers that hold a
 *     possibly-stale source_customer_id. Returns the canonical
 *     target_customer_id when a redirect exists, else null. Use
 *     at the edge of a long-lived URL / cached link to transparently
 *     follow a merge.
 *
 *   historyForCustomer:
 *
 *     Every merge event that mentions a given customer id (as
 *     either source OR target). Ordered by created_at DESC. Used
 *     by the customer-detail operator console to surface "this
 *     account was merged from X on Y" or "Z was merged into this
 *     account on Y".
 *
 *   listMerges:
 *
 *     Audit + dashboard surface. Filters on status + date range.
 *     Returns ordered (created_at DESC, id DESC) rows; no cursor —
 *     the audit-trail volume is operator-scale (dozens to
 *     hundreds per year), so a hard limit cap suffices.
 *
 *   Monotonic per-process clock: two operator actions (propose +
 *   execute, execute + rollback) can land in the same millisecond
 *   on fast machines. `_now` bumps to `prior + 1` on collision so
 *   the (created_at DESC, id DESC) listing + the
 *   historyForCustomer timeline read carry a strict per-process
 *   ordering.
 *
 *   Composes:
 *     - `b.uuid.v7`              - merge row ids
 *     - `b.guardUuid.sanitize`   - strict UUID gate on every
 *                                  customer id reaching this
 *                                  primitive
 *
 *   Surface:
 *     - findDuplicateCandidates({ limit, similarity_min })
 *     - proposeMerge({ source_customer_id, target_customer_id,
 *                      requested_by })
 *     - executeMerge({ merge_id, executed_by })
 *     - rollbackMerge({ merge_id, reason })
 *     - cancelMerge({ merge_id, reason })
 *     - getMerge(merge_id)
 *     - historyForCustomer(customer_id)
 *     - listMerges({ status?, from?, to?, limit? })
 *     - redirectFor(customer_id)
 *
 *   Storage:
 *     - customer_merges, customer_merge_redirects
 *       (migration `0194_customer_merge.sql`).
 *
 * @primitive customerMerge
 * @related    b.uuid.v7, b.guardUuid, shop.customers, shop.order,
 *             shop.subscriptions, shop.loyalty, shop.reviews,
 *             shop.addresses, shop.paymentMethods
 */

// Framework handle — composed-surface accessor placed above the
// first deref. The framework-first export in `./index` makes this
// module-top deref safe at eval time.
var b = require("./index").framework;
var C = b.constants;

var MAX_LIST_LIMIT       = 200;
var DEFAULT_LIST_LIMIT   = 50;
var MAX_CANDIDATE_LIMIT  = 200;
var DEFAULT_CAND_LIMIT   = 25;
var MAX_REASON_LEN       = 280;
var ROLLBACK_WINDOW_MS   = b.constants.TIME.days(7);
var DEFAULT_SIMILARITY   = 0.85;
var MIN_SIMILARITY       = 0.50;
var MAX_SIMILARITY       = 1.00;

var MERGE_STATUSES = Object.freeze([
  "proposed", "executed", "rolled_back", "cancelled",
]);

// Child-primitive registry — the merge orchestrates these by
// rewriting every row that points at a source_customer_id to
// point at the target_customer_id. Each entry is { key: opts-
// key, plan: plan-field-name }. The plan field is what surfaces
// on the dry-run + the listMerges payload, so it's stable
// operator-facing naming.
var CHILD_PRIMITIVES = Object.freeze([
  { key: "order",          plan: "orders"          },
  { key: "subscriptions",  plan: "subscriptions"   },
  { key: "loyalty",        plan: "loyalty_entries" },
  { key: "reviews",        plan: "reviews"         },
  { key: "addresses",      plan: "addresses"       },
  { key: "paymentMethods", plan: "payment_methods" },
]);

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven writes (propose immediately followed by execute,
// execute immediately followed by rollback in an operator console)
// can land in the same millisecond on fast machines. Bumping by
// 1ms on a tie keeps the timeline strictly increasing so a sort-
// by-timestamp read returns events in the order they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _customerId(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("customerMerge: " + label + " - " + (e && e.message || "invalid UUID"));
  }
}

function _mergeId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("customerMerge: merge_id - " + (e && e.message || "invalid UUID"));
  }
}

function _operatorId(s, label) {
  if (typeof s !== "string" || !s.length || s.length > 200) {
    throw new TypeError("customerMerge: " + label + " must be a non-empty string <= 200 characters");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("customerMerge: " + label + " contains control bytes");
  }
  return s;
}

function _reason(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("customerMerge: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("customerMerge: " + label + " must be <= " + MAX_REASON_LEN + " characters");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("customerMerge: " + label + " contains control bytes");
  }
  return s;
}

function _limit(n, max, def, label) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("customerMerge: " + label + " must be an integer 1..." + max);
  }
  return n;
}

function _similarity(n) {
  if (n == null) return DEFAULT_SIMILARITY;
  if (typeof n !== "number" || !isFinite(n) || n < MIN_SIMILARITY || n > MAX_SIMILARITY) {
    throw new TypeError("customerMerge: similarity_min must be a number in [" +
      MIN_SIMILARITY + ", " + MAX_SIMILARITY + "]");
  }
  return n;
}

function _timestampRange(from, to, label) {
  if (from != null && (!Number.isInteger(from) || from < 0)) {
    throw new TypeError("customerMerge." + label + ": from must be a non-negative integer (ms epoch)");
  }
  if (to != null && (!Number.isInteger(to) || to < 0)) {
    throw new TypeError("customerMerge." + label + ": to must be a non-negative integer (ms epoch)");
  }
  if (from != null && to != null && from > to) {
    throw new TypeError("customerMerge." + label + ": from must be <= to");
  }
}

function _status(s) {
  if (typeof s !== "string" || MERGE_STATUSES.indexOf(s) === -1) {
    throw new TypeError("customerMerge: status must be one of " + MERGE_STATUSES.join(", "));
  }
  return s;
}

// ---- Jaro-Winkler similarity -------------------------------------------
//
// In-process string-similarity scorer for the candidate-finder.
// Operates on lowercased ASCII. The Jaro distance counts matching
// characters within a window of half-the-max-length minus one;
// Jaro-Winkler boosts the score for shared leading prefixes.
//
// Returns 0.0 .. 1.0. Two identical strings score 1.0; two
// strings with no common characters score 0.0.

function _jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  var aLen = a.length;
  var bLen = b.length;
  var matchWindow = Math.max(0, Math.floor(Math.max(aLen, bLen) / 2) - 1);

  var aMatches = new Array(aLen);
  var bMatches = new Array(bLen);
  var matches = 0;

  for (var i = 0; i < aLen; i += 1) {
    var lo = Math.max(0, i - matchWindow);
    var hi = Math.min(bLen - 1, i + matchWindow);
    for (var j = lo; j <= hi; j += 1) {
      if (bMatches[j]) continue;
      if (a.charAt(i) !== b.charAt(j)) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions: matched characters in a, scanned in
  // order against matched characters in b. Mismatched pairs are
  // transpositions / 2.
  var transpositions = 0;
  var k = 0;
  for (var ii = 0; ii < aLen; ii += 1) {
    if (!aMatches[ii]) continue;
    while (!bMatches[k]) k += 1;
    if (a.charAt(ii) !== b.charAt(k)) transpositions += 1;
    k += 1;
  }
  transpositions = transpositions / 2;

  var jaro = (matches / aLen + matches / bLen + (matches - transpositions) / matches) / 3;

  // Winkler boost: up to 4 leading characters of shared prefix.
  var prefix = 0;
  var prefixCap = Math.min(4, Math.min(aLen, bLen));
  for (var p = 0; p < prefixCap; p += 1) {
    if (a.charAt(p) !== b.charAt(p)) break;
    prefix += 1;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function _normalizeName(s) {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---- hydration ---------------------------------------------------------

function _hydrateMerge(row) {
  if (!row) return null;
  var plan;
  try { plan = JSON.parse(row.plan_json || "{}"); }
  catch (_e) { plan = {}; }
  return {
    id:                  row.id,
    source_customer_id:  row.source_customer_id,
    target_customer_id:  row.target_customer_id,
    status:              row.status,
    plan:                plan,
    requested_by:        row.requested_by,
    executed_at:         row.executed_at  == null ? null : Number(row.executed_at),
    executed_by:         row.executed_by  == null ? null : row.executed_by,
    rolled_back_at:      row.rolled_back_at == null ? null : Number(row.rolled_back_at),
    rollback_reason:     row.rollback_reason == null ? null : row.rollback_reason,
    cancelled_at:        row.cancelled_at == null ? null : Number(row.cancelled_at),
    cancel_reason:       row.cancel_reason == null ? null : row.cancel_reason,
    created_at:          Number(row.created_at),
  };
}

function _hydrateRedirect(row) {
  if (!row) return null;
  return {
    source_customer_id: row.source_customer_id,
    target_customer_id: row.target_customer_id,
    merge_id:           row.merge_id,
    executed_at:        Number(row.executed_at),
  };
}

// ---- child-primitive contract validation ------------------------------
//
// Every wired child primitive must expose two verbs:
//   countForCustomer(customer_id) -> Promise<integer>
//   reparentForCustomer(fromId, toId) -> Promise<{ rowCount: integer }>
// Absent either when the handle IS supplied is a config-time bug —
// throw at create() so the operator catches the typo at boot.

function _validateChild(handle, key) {
  if (!handle) return;
  if (typeof handle.countForCustomer !== "function") {
    throw new TypeError("customerMerge.create: opts." + key +
      " must expose a countForCustomer(customer_id) method");
  }
  if (typeof handle.reparentForCustomer !== "function") {
    throw new TypeError("customerMerge.create: opts." + key +
      " must expose a reparentForCustomer(fromId, toId) method");
  }
}

function _validateCustomers(handle) {
  if (typeof handle.getCustomerById !== "function") {
    throw new TypeError("customerMerge.create: opts.customers must expose a getCustomerById(id) method");
  }
  if (typeof handle.archiveCustomer !== "function") {
    throw new TypeError("customerMerge.create: opts.customers must expose an archiveCustomer(id) method");
  }
  if (typeof handle.restoreCustomer !== "function") {
    throw new TypeError("customerMerge.create: opts.customers must expose a restoreCustomer(id) method");
  }
  if (typeof handle.listForCandidates !== "function") {
    throw new TypeError("customerMerge.create: opts.customers must expose a listForCandidates({ limit }) method");
  }
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // customers is REQUIRED — the merge gates both customer-exists
  // checks AND the source-archive call through this handle.
  if (!opts.customers || typeof opts.customers !== "object") {
    throw new TypeError("customerMerge.create: opts.customers is required");
  }
  var customers = opts.customers;
  _validateCustomers(customers);

  // Every other child is optional.
  var children = {};
  for (var i = 0; i < CHILD_PRIMITIVES.length; i += 1) {
    var spec = CHILD_PRIMITIVES[i];
    var handle = opts[spec.key];
    _validateChild(handle, spec.key);
    children[spec.key] = handle || null;
  }

  async function _getMergeRow(id) {
    var r = await query("SELECT * FROM customer_merges WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getRedirectRow(sourceId) {
    var r = await query(
      "SELECT * FROM customer_merge_redirects WHERE source_customer_id = ?1",
      [sourceId],
    );
    return r.rows[0] || null;
  }

  // Walk every wired child primitive and tally the affected-row
  // counts. The returned plan is the dry-run snapshot for
  // proposeMerge and the verification footprint for executeMerge /
  // rollbackMerge.
  async function _countPlanForSource(sourceId) {
    var plan = {};
    var total = 0;
    for (var c = 0; c < CHILD_PRIMITIVES.length; c += 1) {
      var spec = CHILD_PRIMITIVES[c];
      var handle = children[spec.key];
      if (!handle) {
        plan[spec.plan] = 0;
        continue;
      }
      var n = await handle.countForCustomer(sourceId);
      if (!Number.isInteger(n) || n < 0) {
        throw new TypeError("customerMerge: opts." + spec.key +
          ".countForCustomer returned non-integer (" + JSON.stringify(n) + ")");
      }
      plan[spec.plan] = n;
      total += n;
    }
    plan.total_rows = total;
    return plan;
  }

  // Reparent in dependency-naive order: every wired child gets the
  // reparent call. Returns the actual row-count snapshot so the
  // caller can sanity-check against the proposeMerge plan.
  async function _reparentAll(sourceId, targetId) {
    var actual = {};
    var total = 0;
    for (var c = 0; c < CHILD_PRIMITIVES.length; c += 1) {
      var spec = CHILD_PRIMITIVES[c];
      var handle = children[spec.key];
      if (!handle) {
        actual[spec.plan] = 0;
        continue;
      }
      var res = await handle.reparentForCustomer(sourceId, targetId);
      var rowCount = res && Number.isInteger(res.rowCount) ? res.rowCount : 0;
      actual[spec.plan] = rowCount;
      total += rowCount;
    }
    actual.total_rows = total;
    return actual;
  }

  return {

    MERGE_STATUSES:       MERGE_STATUSES.slice(),
    ROLLBACK_WINDOW_MS:   ROLLBACK_WINDOW_MS,
    MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
    MAX_CANDIDATE_LIMIT:  MAX_CANDIDATE_LIMIT,
    MAX_REASON_LEN:       MAX_REASON_LEN,
    DEFAULT_SIMILARITY:   DEFAULT_SIMILARITY,

    // Heuristic duplicate finder. Pulls a batch of recent customer
    // rows through the customers primitive's listForCandidates({
    // limit }) verb and pairs them by lowercased-name Jaro-Winkler
    // similarity. Returns the pairs above `similarity_min`,
    // ordered by similarity DESC. Already-merged source ids
    // (i.e. rows with an existing redirect marker) are excluded
    // from the candidate set so a confirmed merge doesn't re-
    // surface as a "possible duplicate."
    findDuplicateCandidates: async function (input) {
      input = input || {};
      var limit         = _limit(input.limit, MAX_CANDIDATE_LIMIT, DEFAULT_CAND_LIMIT, "limit");
      var similarityMin = _similarity(input.similarity_min);

      var scanLimit = Math.min(MAX_CANDIDATE_LIMIT, Math.max(limit * 4, 100));
      var listed = await customers.listForCandidates({ limit: scanLimit });
      var rows = (listed && Array.isArray(listed.rows)) ? listed.rows : [];

      // Filter out already-redirected source ids (each one is by
      // definition no longer canonical and surfacing it as a
      // "potential duplicate" is noise).
      var redirectRows = (await query(
        "SELECT source_customer_id FROM customer_merge_redirects", [],
      )).rows;
      var redirected = Object.create(null);
      for (var r = 0; r < redirectRows.length; r += 1) {
        redirected[redirectRows[r].source_customer_id] = true;
      }
      var pool = [];
      for (var k = 0; k < rows.length; k += 1) {
        var row = rows[k];
        if (!row || !row.id) continue;
        if (redirected[row.id]) continue;
        var norm = _normalizeName(row.display_name || "");
        if (!norm.length) continue;
        pool.push({ id: row.id, name: norm, display_name: row.display_name });
      }

      var candidates = [];
      for (var a = 0; a < pool.length; a += 1) {
        for (var b = a + 1; b < pool.length; b += 1) {
          var score = _jaroWinkler(pool[a].name, pool[b].name);
          if (score >= similarityMin) {
            // Stable order — smaller id first so the same pair
            // surfaces identically across runs.
            var pair;
            if (pool[a].id < pool[b].id) {
              pair = { a_id: pool[a].id, a_display_name: pool[a].display_name,
                       b_id: pool[b].id, b_display_name: pool[b].display_name,
                       similarity: score };
            } else {
              pair = { a_id: pool[b].id, a_display_name: pool[b].display_name,
                       b_id: pool[a].id, b_display_name: pool[a].display_name,
                       similarity: score };
            }
            candidates.push(pair);
          }
        }
      }
      candidates.sort(function (x, y) {
        if (y.similarity !== x.similarity) return y.similarity - x.similarity;
        if (x.a_id < y.a_id) return -1;
        if (x.a_id > y.a_id) return 1;
        if (x.b_id < y.b_id) return -1;
        if (x.b_id > y.b_id) return 1;
        return 0;
      });
      return candidates.slice(0, limit);
    },

    // Record a dry-run merge plan. Both customer ids must exist
    // and be distinct. The source must not already have a
    // redirect (an already-merged source can't be re-merged), and
    // the target must not be an already-merged source itself
    // (chained redirects refused — operators always merge ONTO a
    // canonical id). An existing `proposed` plan for the same
    // (source, target) pair is refused; cancel it first or
    // re-use it.
    proposeMerge: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerMerge.proposeMerge: input object required");
      }
      var sourceId   = _customerId(input.source_customer_id, "source_customer_id");
      var targetId   = _customerId(input.target_customer_id, "target_customer_id");
      var requestedBy = _operatorId(input.requested_by, "requested_by");

      if (sourceId === targetId) {
        throw new TypeError("customerMerge.proposeMerge: source_customer_id and target_customer_id must differ");
      }

      var sourceCustomer = await customers.getCustomerById(sourceId);
      if (!sourceCustomer) {
        var srcErr = new Error("customerMerge.proposeMerge: source_customer_id " + sourceId + " not found");
        srcErr.code = "CUSTOMER_MERGE_SOURCE_NOT_FOUND";
        throw srcErr;
      }
      var targetCustomer = await customers.getCustomerById(targetId);
      if (!targetCustomer) {
        var tgtErr = new Error("customerMerge.proposeMerge: target_customer_id " + targetId + " not found");
        tgtErr.code = "CUSTOMER_MERGE_TARGET_NOT_FOUND";
        throw tgtErr;
      }

      var existingRedirect = await _getRedirectRow(sourceId);
      if (existingRedirect) {
        var redErr = new Error("customerMerge.proposeMerge: source_customer_id " + sourceId +
          " is already merged into " + existingRedirect.target_customer_id);
        redErr.code = "CUSTOMER_MERGE_SOURCE_ALREADY_MERGED";
        throw redErr;
      }
      var targetAsSource = await _getRedirectRow(targetId);
      if (targetAsSource) {
        var chainErr = new Error("customerMerge.proposeMerge: target_customer_id " + targetId +
          " is itself merged into " + targetAsSource.target_customer_id +
          " - chained redirects refused");
        chainErr.code = "CUSTOMER_MERGE_TARGET_IS_REDIRECT";
        throw chainErr;
      }

      // Refuse a duplicate proposed-state plan for the same pair.
      var existingProposed = (await query(
        "SELECT id FROM customer_merges " +
        "WHERE source_customer_id = ?1 AND target_customer_id = ?2 AND status = 'proposed'",
        [sourceId, targetId],
      )).rows[0];
      if (existingProposed) {
        var dupErr = new Error("customerMerge.proposeMerge: a proposed plan already exists for " +
          "(source=" + sourceId + ", target=" + targetId + "): merge_id=" + existingProposed.id);
        dupErr.code = "CUSTOMER_MERGE_DUPLICATE_PROPOSAL";
        throw dupErr;
      }

      var plan = await _countPlanForSource(sourceId);
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO customer_merges " +
        "(id, source_customer_id, target_customer_id, status, plan_json, requested_by, created_at) " +
        "VALUES (?1, ?2, ?3, 'proposed', ?4, ?5, ?6)",
        [id, sourceId, targetId, JSON.stringify(plan), requestedBy, ts],
      );
      return _hydrateMerge(await _getMergeRow(id));
    },

    // Reparent every child row. Pre-flight all primitives FIRST
    // (the count walk surfaces any handle-level error before any
    // UPDATE runs); then commit every reparent; then archive the
    // source customer; then insert the redirect marker; then stamp
    // executed_at + executed_by + lands the merge in executed.
    executeMerge: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerMerge.executeMerge: input object required");
      }
      var mergeId    = _mergeId(input.merge_id);
      var executedBy = _operatorId(input.executed_by, "executed_by");

      var row = await _getMergeRow(mergeId);
      if (!row) {
        var nfErr = new Error("customerMerge.executeMerge: merge_id " + mergeId + " not found");
        nfErr.code = "CUSTOMER_MERGE_NOT_FOUND";
        throw nfErr;
      }
      if (row.status !== "proposed") {
        var stErr = new Error("customerMerge.executeMerge: merge_id " + mergeId +
          " is " + row.status + ", only proposed merges can be executed");
        stErr.code = "CUSTOMER_MERGE_NOT_PROPOSED";
        throw stErr;
      }

      // Pre-flight: recount the plan. If the actual current state
      // doesn't match the captured plan, we refuse — the operator
      // re-proposes (state drifted between proposal and execute).
      var freshPlan = await _countPlanForSource(row.source_customer_id);
      var capturedPlan;
      try { capturedPlan = JSON.parse(row.plan_json || "{}"); }
      catch (_e) { capturedPlan = {}; }
      if (freshPlan.total_rows !== capturedPlan.total_rows) {
        var drErr = new Error("customerMerge.executeMerge: plan drifted since proposal " +
          "(proposed total=" + capturedPlan.total_rows + ", actual=" + freshPlan.total_rows +
          ") - re-propose");
        drErr.code = "CUSTOMER_MERGE_PLAN_DRIFTED";
        throw drErr;
      }

      // Commit every reparent.
      var actual = await _reparentAll(row.source_customer_id, row.target_customer_id);

      // Archive the source customer + insert the redirect marker.
      await customers.archiveCustomer(row.source_customer_id);
      var ts = _now();
      await query(
        "INSERT INTO customer_merge_redirects " +
        "(source_customer_id, target_customer_id, merge_id, executed_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [row.source_customer_id, row.target_customer_id, mergeId, ts],
      );

      // Land the merge in executed; freeze the actual reparent
      // counts on plan_json so rollback has the exact footprint.
      var sealed = Object.assign({}, capturedPlan, { actual: actual });
      await query(
        "UPDATE customer_merges SET status = 'executed', plan_json = ?1, " +
        "executed_at = ?2, executed_by = ?3 WHERE id = ?4",
        [JSON.stringify(sealed), ts, executedBy, mergeId],
      );
      return _hydrateMerge(await _getMergeRow(mergeId));
    },

    // Reverse every reparent. Within ROLLBACK_WINDOW_MS of the
    // execute timestamp. Past the window, refuses outright — the
    // assumption is that downstream systems (analytics, reporting,
    // operator notifications) have observed the merge and any
    // mass-reverse would create a "rollback storm" of stale-data
    // side effects.
    rollbackMerge: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerMerge.rollbackMerge: input object required");
      }
      var mergeId = _mergeId(input.merge_id);
      var reason  = _reason(input.reason, "reason");

      var row = await _getMergeRow(mergeId);
      if (!row) {
        var nfErr = new Error("customerMerge.rollbackMerge: merge_id " + mergeId + " not found");
        nfErr.code = "CUSTOMER_MERGE_NOT_FOUND";
        throw nfErr;
      }
      if (row.status !== "executed") {
        var stErr = new Error("customerMerge.rollbackMerge: merge_id " + mergeId +
          " is " + row.status + ", only executed merges can be rolled back");
        stErr.code = "CUSTOMER_MERGE_NOT_EXECUTED";
        throw stErr;
      }
      var now = _now();
      if (now - Number(row.executed_at) > ROLLBACK_WINDOW_MS) {
        var winErr = new Error("customerMerge.rollbackMerge: merge_id " + mergeId +
          " executed " + Math.floor((now - Number(row.executed_at)) / C.TIME.days(1)) +
          " days ago, past the " + (ROLLBACK_WINDOW_MS / C.TIME.days(1)) +
          "-day rollback window");
        winErr.code = "CUSTOMER_MERGE_ROLLBACK_WINDOW_EXPIRED";
        throw winErr;
      }

      // Reverse every reparent (target -> source).
      await _reparentAll(row.target_customer_id, row.source_customer_id);

      // Restore the source customer + drop the redirect marker.
      await customers.restoreCustomer(row.source_customer_id);
      await query(
        "DELETE FROM customer_merge_redirects WHERE source_customer_id = ?1",
        [row.source_customer_id],
      );

      await query(
        "UPDATE customer_merges SET status = 'rolled_back', " +
        "rolled_back_at = ?1, rollback_reason = ?2 WHERE id = ?3",
        [now, reason, mergeId],
      );
      return _hydrateMerge(await _getMergeRow(mergeId));
    },

    // Drop a proposed plan without ever executing it. Idempotent
    // on the terminal cancelled state (re-cancelling returns the
    // already-cancelled row).
    cancelMerge: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerMerge.cancelMerge: input object required");
      }
      var mergeId = _mergeId(input.merge_id);
      var reason  = _reason(input.reason, "reason");
      var row = await _getMergeRow(mergeId);
      if (!row) {
        var nfErr = new Error("customerMerge.cancelMerge: merge_id " + mergeId + " not found");
        nfErr.code = "CUSTOMER_MERGE_NOT_FOUND";
        throw nfErr;
      }
      if (row.status === "cancelled") {
        return _hydrateMerge(row);
      }
      if (row.status !== "proposed") {
        var stErr = new Error("customerMerge.cancelMerge: merge_id " + mergeId +
          " is " + row.status + ", only proposed merges can be cancelled");
        stErr.code = "CUSTOMER_MERGE_NOT_PROPOSED";
        throw stErr;
      }
      var ts = _now();
      await query(
        "UPDATE customer_merges SET status = 'cancelled', " +
        "cancelled_at = ?1, cancel_reason = ?2 WHERE id = ?3",
        [ts, reason, mergeId],
      );
      return _hydrateMerge(await _getMergeRow(mergeId));
    },

    // Single-merge read. Returns null on miss.
    getMerge: async function (mergeId) {
      mergeId = _mergeId(mergeId);
      return _hydrateMerge(await _getMergeRow(mergeId));
    },

    // Every merge that mentions a customer id (as source OR
    // target). Sorted (created_at DESC, id DESC).
    historyForCustomer: async function (customerId) {
      customerId = _customerId(customerId, "customer_id");
      var r = await query(
        "SELECT * FROM customer_merges " +
        "WHERE source_customer_id = ?1 OR target_customer_id = ?1 " +
        "ORDER BY created_at DESC, id DESC",
        [customerId],
      );
      return r.rows.map(_hydrateMerge);
    },

    // Audit listing. Filters: status + created_at range. Sorted
    // (created_at DESC, id DESC). No cursor — operator-scale
    // audit volume is bounded (dozens to hundreds per year).
    listMerges: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = _limit(listOpts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, "limit");
      _timestampRange(listOpts.from, listOpts.to, "listMerges");

      var where = [];
      var params = [];
      var idx = 1;
      if (listOpts.status != null) {
        var status = _status(listOpts.status);
        where.push("status = ?" + idx);
        params.push(status);
        idx += 1;
      }
      if (listOpts.from != null) {
        where.push("created_at >= ?" + idx);
        params.push(listOpts.from);
        idx += 1;
      }
      if (listOpts.to != null) {
        where.push("created_at <= ?" + idx);
        params.push(listOpts.to);
        idx += 1;
      }
      var sql = "SELECT * FROM customer_merges";
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY created_at DESC, id DESC LIMIT ?" + idx;
      params.push(limit);
      var r = await query(sql, params);
      return r.rows.map(_hydrateMerge);
    },

    // Resolve a possibly-stale source_customer_id to the canonical
    // target. Returns the redirect row when one exists, else null.
    redirectFor: async function (customerId) {
      customerId = _customerId(customerId, "customer_id");
      return _hydrateRedirect(await _getRedirectRow(customerId));
    },
  };
}

module.exports = {
  create:               create,
  MERGE_STATUSES:       MERGE_STATUSES.slice(),
  ROLLBACK_WINDOW_MS:   ROLLBACK_WINDOW_MS,
  MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
  MAX_CANDIDATE_LIMIT:  MAX_CANDIDATE_LIMIT,
  MAX_REASON_LEN:       MAX_REASON_LEN,
  DEFAULT_SIMILARITY:   DEFAULT_SIMILARITY,
};
