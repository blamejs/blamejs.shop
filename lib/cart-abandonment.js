"use strict";
/**
 * @module shop.cartAbandonment
 * @title  Cart-abandonment scanner — detect idle carts, schedule reminder fan-out
 *
 * @intro
 *   Operators wire this primitive to a scheduler (Cron Trigger, CF
 *   Workers Cron, a host-level cron, etc.) and call `.scan(...)` on
 *   a recurring interval. Every invocation:
 *
 *     1. Opens a `cart_abandonment_runs` row (`status='running'`)
 *        so a dashboard can see "the scanner is alive."
 *     2. Walks `carts` with `status='active'` and `updated_at <
 *        now - idle_threshold_ms` (default 24h), oldest first,
 *        capped at `max_carts` (default 500).
 *     3. For each cart with at least one line, writes a
 *        `cart_abandonment_detections` row keyed `(id, cart_id,
 *        detected_at)` and tagged `reminder_status='pending'`.
 *        Idempotent: a cart already detected within the current
 *        idle window is skipped (the `idx_cart_abandonment_detections_cart`
 *        index makes the "last detection for this cart" SELECT cheap).
 *     4. Returns the list of candidates so a separate worker can
 *        fan out reminders without re-scanning. The worker calls
 *        `markReminderSent` / `markReminderSkipped` /
 *        `markReminderFailed` to transition the row.
 *     5. Closes the run row with the final counts.
 *
 *   Privacy posture: `session_id` reaches this primitive only when
 *   the scanner is called with a synthetic cart shape; the canonical
 *   path reads `session_id` off the `carts` row and hashes it
 *   through `b.crypto.namespaceHash` before write. The detection
 *   table never stores a raw session id.
 *
 *   `customer_id` is the internal UUID. Customer-email lookup
 *   happens at fan-out time (the worker resolves the customer's
 *   email through the operator's email-delivery layer); the
 *   primitive's job is just to mark the candidate row.
 *
 *   Status FSM for `reminder_status`:
 *     pending             — fresh detection, fan-out has not run
 *     sent                — reminder dispatched
 *     skipped-no-email    — anonymous cart or customer without contact
 *     skipped-suppressed  — recipient on the suppression list
 *     failed              — delivery error
 *
 *   Cleanup: `cleanupOld({ before_ts })` deletes detection rows
 *   older than ts. Operators run this on a slower cadence (weekly /
 *   monthly) so the table doesn't grow unbounded.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var STATUSES = Object.freeze([
  "pending",
  "sent",
  "skipped-no-email",
  "skipped-suppressed",
  "failed",
]);

var SKIP_REASONS = Object.freeze([
  "no-email",
  "suppressed",
  "anonymous",
  "opted-out",
]);

var DEFAULT_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;          // 24h
var DEFAULT_MAX_AGE_MS        = 30 * 24 * 60 * 60 * 1000;     // 30d
var DEFAULT_MAX_CARTS         = 500;
var MAX_MAX_CARTS             = 5000;

var DEFAULT_LIST_LIMIT = 50;
var MAX_LIST_LIMIT     = 200;

var SESSION_NAMESPACE = "cart-abandonment-session";

var RECENT_ORDER_KEY = ["detected_at:desc", "id:desc"];

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError(
      "cart-abandonment: " + label + " — " + (e && e.message || "invalid UUID")
    );
  }
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(
      "cart-abandonment: " + label + " must be a positive integer"
    );
  }
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "cart-abandonment: " + label + " must be a non-negative integer"
    );
  }
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "cart-abandonment: " + label + " must be a non-negative integer (epoch ms)"
    );
  }
}

function _statusFilter(s) {
  if (STATUSES.indexOf(s) === -1) {
    throw new TypeError(
      "cart-abandonment: status must be one of " + STATUSES.join(", ")
    );
  }
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError(
      "cart-abandonment: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]"
    );
  }
  return n;
}

function _skipReason(r) {
  if (typeof r !== "string" || SKIP_REASONS.indexOf(r) === -1) {
    throw new TypeError(
      "cart-abandonment: reason must be one of " + SKIP_REASONS.join(", ")
    );
  }
  return r;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Required dep: the cart primitive. The scanner reads cart rows +
  // line counts through the same surface storefront / checkout use,
  // so a future schema change to `carts` / `cart_lines` flows through
  // one place. Refuse at factory time rather than at first call so a
  // mis-wired deployment fails at boot.
  if (!opts.cart || typeof opts.cart !== "object") {
    throw new TypeError(
      "cart-abandonment.create: opts.cart (cart primitive) is required"
    );
  }
  var cart = opts.cart;

  // Optional dep: the customers primitive. Reserved for callers that
  // want the scanner to attach the customer's display name to the
  // candidate payload. Today the primitive just passes `customer_id`
  // through to the fan-out worker; the customers dep stays optional
  // and shape-validated for the future hook.
  var customers = opts.customers || null;
  if (customers && typeof customers !== "object") {
    throw new TypeError(
      "cart-abandonment.create: opts.customers must be an object exposing the customers primitive"
    );
  }

  // Optional dep: the email-suppressions primitive. Reserved for the
  // forthcoming suppression-list landing. Today the fan-out worker
  // performs the suppression check (because it owns the
  // hash-the-email step); the dep stays optional and shape-validated
  // here so a future scanner-side prefilter can compose with it.
  var emailSuppressions = opts.emailSuppressions || null;
  if (emailSuppressions && typeof emailSuppressions.isSuppressed !== "function") {
    throw new TypeError(
      "cart-abandonment.create: opts.emailSuppressions must expose an isSuppressed(email_hash) method"
    );
  }

  // Pagination cursor secret — same HMAC-tagged shape the rest of
  // the shop primitives use so an operator can't hand-craft one to
  // skip past a hidden detection. Falls back to a dev-only
  // placeholder so the primitive boots in tests; production deploys
  // pass a derived value.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "cart-abandonment.create: opts.cursorSecret is required in production"
      );
    }
    opts.cursorSecret = "cart-abandonment-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // ---- internals --------------------------------------------------------

  function _hashSession(sessionId) {
    return _b().crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
  }

  async function _lastDetectionForCart(cartId) {
    var r = await query(
      "SELECT id, detected_at FROM cart_abandonment_detections " +
      "WHERE cart_id = ?1 ORDER BY detected_at DESC LIMIT 1",
      [cartId],
    );
    return r.rows[0] || null;
  }

  async function _openRun(startedAt) {
    var id = _b().uuid.v7();
    await query(
      "INSERT INTO cart_abandonment_runs " +
      "(id, started_at, status) VALUES (?1, ?2, 'running')",
      [id, startedAt],
    );
    return id;
  }

  async function _closeRunOk(runId, finishedAt, scanned, detected) {
    await query(
      "UPDATE cart_abandonment_runs SET " +
      "finished_at = ?1, carts_scanned = ?2, carts_detected = ?3, " +
      "status = 'completed' WHERE id = ?4",
      [finishedAt, scanned, detected, runId],
    );
  }

  async function _closeRunFail(runId, finishedAt, scanned, detected, err) {
    var msg = err && err.message ? String(err.message) : String(err || "unknown");
    if (msg.length > 1024) msg = msg.slice(0, 1024);
    await query(
      "UPDATE cart_abandonment_runs SET " +
      "finished_at = ?1, carts_scanned = ?2, carts_detected = ?3, " +
      "status = 'failed', error = ?4 WHERE id = ?5",
      [finishedAt, scanned, detected, msg, runId],
    );
  }

  async function _bumpRunReminderSent(detectionId) {
    // Find the most recent run that could plausibly own this
    // detection (started before detection time + idle threshold).
    // Operators that want a stricter mapping wire the detection ->
    // run id explicitly; this loose mapping is fine for the
    // dashboard counter that just shows "reminders dispatched on the
    // last run."
    var det = (await query(
      "SELECT detected_at FROM cart_abandonment_detections WHERE id = ?1",
      [detectionId],
    )).rows[0];
    if (!det) return;
    var run = (await query(
      "SELECT id FROM cart_abandonment_runs " +
      "WHERE started_at <= ?1 ORDER BY started_at DESC LIMIT 1",
      [det.detected_at],
    )).rows[0];
    if (!run) return;
    await query(
      "UPDATE cart_abandonment_runs SET reminders_sent = reminders_sent + 1 WHERE id = ?1",
      [run.id],
    );
  }

  // ---- surface ----------------------------------------------------------

  return {
    STATUSES:                 STATUSES,
    SKIP_REASONS:             SKIP_REASONS,
    DEFAULT_IDLE_THRESHOLD_MS: DEFAULT_IDLE_THRESHOLD_MS,
    DEFAULT_MAX_AGE_MS:        DEFAULT_MAX_AGE_MS,
    DEFAULT_MAX_CARTS:         DEFAULT_MAX_CARTS,

    // One scanner pass. Walks active carts older than the idle
    // threshold, writes a detection row per new candidate, returns
    // the candidate list so the operator's fan-out worker can issue
    // reminders. Idempotent at the cart-window level: a cart already
    // detected after `now - idle_threshold_ms` is skipped.
    //
    // Throws on bad arguments. Internal SELECT / INSERT errors mark
    // the run row `status='failed'` (with the truncated message) and
    // re-throw so the caller's observability sink sees the failure.
    scan: async function (scanOpts) {
      scanOpts = scanOpts || {};
      var idleMs = scanOpts.idle_threshold_ms == null
        ? DEFAULT_IDLE_THRESHOLD_MS
        : scanOpts.idle_threshold_ms;
      var maxAgeMs = scanOpts.max_age_ms == null
        ? DEFAULT_MAX_AGE_MS
        : scanOpts.max_age_ms;
      var maxCarts = scanOpts.max_carts == null
        ? DEFAULT_MAX_CARTS
        : scanOpts.max_carts;
      _positiveInt(idleMs,   "idle_threshold_ms");
      _positiveInt(maxAgeMs, "max_age_ms");
      if (!Number.isInteger(maxCarts) || maxCarts <= 0 || maxCarts > MAX_MAX_CARTS) {
        throw new TypeError(
          "cart-abandonment: max_carts must be an integer in [1, " + MAX_MAX_CARTS + "]"
        );
      }
      if (idleMs >= maxAgeMs) {
        throw new TypeError(
          "cart-abandonment: idle_threshold_ms must be strictly less than max_age_ms"
        );
      }

      var now = _now();
      var idleCutoff = now - idleMs;
      var ageCutoff  = now - maxAgeMs;
      var runId = await _openRun(now);

      var scanned = 0;
      var detected = 0;
      var candidates = [];

      try {
        // Select active carts whose updated_at falls in the
        // (ageCutoff, idleCutoff] window. The ORDER BY oldest-first
        // gives the operator deterministic forward progress on
        // backlogs and matches the run cap semantics ("scan the
        // first N idlest carts this pass").
        var cartRows = (await query(
          "SELECT id, session_id, customer_id, currency, updated_at FROM carts " +
          "WHERE status = 'active' AND updated_at <= ?1 AND updated_at >= ?2 " +
          "ORDER BY updated_at ASC LIMIT ?3",
          [idleCutoff, ageCutoff, maxCarts],
        )).rows;

        for (var i = 0; i < cartRows.length; i += 1) {
          var c = cartRows[i];
          scanned += 1;

          // Idempotency gate: a cart already detected after
          // `idleCutoff` is still in the same idle window — skip.
          // Re-detection only happens when the shopper bumps the
          // cart (updated_at moves forward, the next idle window
          // starts fresh).
          var last = await _lastDetectionForCart(c.id);
          if (last && last.detected_at > idleCutoff) continue;

          // Aggregate line count + subtotal. Carts with zero lines
          // are skipped (no items to remind about — the
          // line_count > 0 CHECK on the detection row also enforces
          // this defensively).
          var agg = (await query(
            "SELECT COUNT(*) AS line_count, " +
            "       COALESCE(SUM(qty * unit_amount_minor), 0) AS subtotal_minor " +
            "FROM cart_lines WHERE cart_id = ?1",
            [c.id],
          )).rows[0];
          var lineCount = Number(agg && agg.line_count || 0);
          if (lineCount === 0) continue;
          var subtotalMinor = Number(agg && agg.subtotal_minor || 0);

          var detectionId = _b().uuid.v7();
          var sessionHash = _hashSession(c.session_id);

          // Race: a concurrent scanner could have written a
          // detection for the same (cart_id, detected_at). The
          // UNIQUE constraint makes the second writer fail; we
          // catch + continue so the pass doesn't abort.
          try {
            await query(
              "INSERT INTO cart_abandonment_detections " +
              "(id, cart_id, session_id_hash, customer_id, line_count, " +
              " subtotal_minor, subtotal_currency, detected_at, cart_idle_since, " +
              " reminder_status) " +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')",
              [
                detectionId, c.id, sessionHash, c.customer_id || null,
                lineCount, subtotalMinor, c.currency,
                now, c.updated_at,
              ],
            );
          } catch (e) {
            // UNIQUE collision → another scanner beat us to it.
            // Treat as "already detected this pass" and move on.
            if (e && /UNIQUE/i.test(String(e.message || ""))) continue;
            throw e;
          }

          detected += 1;
          candidates.push({
            detection_id:      detectionId,
            cart_id:           c.id,
            customer_id:       c.customer_id || null,
            line_count:        lineCount,
            subtotal_minor:    subtotalMinor,
            subtotal_currency: c.currency,
          });
        }

        await _closeRunOk(runId, _now(), scanned, detected);
        return {
          run_id:          runId,
          carts_scanned:   scanned,
          carts_detected:  detected,
          candidates:      candidates,
        };
      } catch (err) {
        try { await _closeRunFail(runId, _now(), scanned, detected, err); }
        catch (_e) { /* drop-silent — the original error is the one the caller needs */ }
        throw err;
      }
    },

    // Fan-out caller stamps "reminder dispatched." Idempotent on the
    // detection row — re-calling with the same detection_id is a
    // no-op (the row is already terminal). Bumps the owning run's
    // `reminders_sent` counter so the dashboard surfaces "K
    // reminders sent during the last run."
    markReminderSent: async function (detectionId, markOpts) {
      _uuid(detectionId, "detection_id");
      markOpts = markOpts || {};
      var sentAt = markOpts.sent_at == null ? _now() : markOpts.sent_at;
      _epochMs(sentAt, "sent_at");
      var r = await query(
        "UPDATE cart_abandonment_detections SET " +
        "reminder_status = 'sent', reminder_sent_at = ?1 " +
        "WHERE id = ?2 AND reminder_status = 'pending'",
        [sentAt, detectionId],
      );
      var changed = Number(r.rowCount || 0) > 0;
      if (changed) {
        try { await _bumpRunReminderSent(detectionId); }
        catch (_e) { /* drop-silent — counter drift is recoverable; the detection row truth is authoritative */ }
      }
      return { detection_id: detectionId, changed: changed };
    },

    // Fan-out caller stamps "skipped — recipient unreachable /
    // suppressed / opted-out." Distinct from `failed` (which is a
    // transient delivery error) so the operator can split the
    // dashboard accordingly.
    markReminderSkipped: async function (detectionId, markOpts) {
      _uuid(detectionId, "detection_id");
      if (!markOpts || typeof markOpts !== "object") {
        throw new TypeError(
          "cart-abandonment.markReminderSkipped: opts.reason is required"
        );
      }
      var reason = _skipReason(markOpts.reason);
      var status = reason === "suppressed" || reason === "opted-out"
        ? "skipped-suppressed"
        : "skipped-no-email";
      var r = await query(
        "UPDATE cart_abandonment_detections SET " +
        "reminder_status = ?1, reminder_skipped_reason = ?2 " +
        "WHERE id = ?3 AND reminder_status = 'pending'",
        [status, reason, detectionId],
      );
      return {
        detection_id: detectionId,
        changed:      Number(r.rowCount || 0) > 0,
        status:       status,
        reason:       reason,
      };
    },

    // Fan-out caller stamps "delivery failed." Truncates the error
    // string so a runaway message can't bloat the row.
    markReminderFailed: async function (detectionId, markOpts) {
      _uuid(detectionId, "detection_id");
      if (!markOpts || typeof markOpts !== "object" || typeof markOpts.error !== "string" || !markOpts.error.length) {
        throw new TypeError(
          "cart-abandonment.markReminderFailed: opts.error must be a non-empty string"
        );
      }
      var msg = markOpts.error;
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(msg)) {
        throw new TypeError(
          "cart-abandonment.markReminderFailed: error must not contain control bytes"
        );
      }
      if (msg.length > 1024) msg = msg.slice(0, 1024);
      var r = await query(
        "UPDATE cart_abandonment_detections SET " +
        "reminder_status = 'failed', reminder_skipped_reason = ?1 " +
        "WHERE id = ?2 AND reminder_status = 'pending'",
        [msg, detectionId],
      );
      return {
        detection_id: detectionId,
        changed:      Number(r.rowCount || 0) > 0,
      };
    },

    // Operator-dashboard surface: recent detections, newest first,
    // HMAC-tagged cursor on `(detected_at DESC, id DESC)`. Optional
    // `status` filter narrows to one reminder-status bucket so the
    // dashboard can render "pending reminders" and "failed
    // reminders" as separate panels backed by the same primitive.
    recentDetections: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = _limit(listOpts.limit, "limit");
      var status = null;
      if (listOpts.status != null) {
        _statusFilter(listOpts.status);
        status = listOpts.status;
      }
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError(
            "cart-abandonment.recentDetections: cursor must be an opaque string"
          );
        }
        try {
          var state = _b().pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(RECENT_ORDER_KEY)) {
            throw new TypeError(
              "cart-abandonment.recentDetections: cursor orderKey mismatch"
            );
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError(
            "cart-abandonment.recentDetections: cursor — " + (e && e.message || "malformed")
          );
        }
      }
      var sql;
      var params;
      if (status != null && cursorVals) {
        sql = "SELECT * FROM cart_abandonment_detections " +
              "WHERE reminder_status = ?1 AND " +
              "(detected_at < ?2 OR (detected_at = ?2 AND id < ?3)) " +
              "ORDER BY detected_at DESC, id DESC LIMIT ?4";
        params = [status, cursorVals[0], cursorVals[1], limit];
      } else if (status != null) {
        sql = "SELECT * FROM cart_abandonment_detections " +
              "WHERE reminder_status = ?1 " +
              "ORDER BY detected_at DESC, id DESC LIMIT ?2";
        params = [status, limit];
      } else if (cursorVals) {
        sql = "SELECT * FROM cart_abandonment_detections WHERE " +
              "(detected_at < ?1 OR (detected_at = ?1 AND id < ?2)) " +
              "ORDER BY detected_at DESC, id DESC LIMIT ?3";
        params = [cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM cart_abandonment_detections " +
              "ORDER BY detected_at DESC, id DESC LIMIT ?1";
        params = [limit];
      }
      var rows = (await query(sql, params)).rows;
      var last = rows[rows.length - 1];
      var nextCursor = null;
      if (last && rows.length === limit) {
        nextCursor = _b().pagination.encodeCursor({
          orderKey: RECENT_ORDER_KEY,
          vals:     [last.detected_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, nextCursor: nextCursor };
    },

    // Per-run dashboard read. Returns the run row + a fresh count of
    // detections that point at this run (loose mapping — the
    // detection table doesn't carry the run id, so the count is
    // "detections whose detected_at falls inside the run window").
    statsForRun: async function (runId) {
      _uuid(runId, "run_id");
      var run = (await query(
        "SELECT * FROM cart_abandonment_runs WHERE id = ?1",
        [runId],
      )).rows[0];
      if (!run) return null;
      var until = run.finished_at == null ? _now() : run.finished_at;
      var detCount = Number(((await query(
        "SELECT COUNT(*) AS n FROM cart_abandonment_detections " +
        "WHERE detected_at >= ?1 AND detected_at <= ?2",
        [run.started_at, until],
      )).rows[0] || {}).n || 0);
      return {
        id:                  run.id,
        started_at:          run.started_at,
        finished_at:         run.finished_at,
        status:              run.status,
        carts_scanned:       Number(run.carts_scanned || 0),
        carts_detected:      Number(run.carts_detected || 0),
        reminders_sent:      Number(run.reminders_sent || 0),
        error:               run.error || null,
        detections_in_window: detCount,
      };
    },

    // Retention cleanup. Deletes detection rows with detected_at <
    // before_ts. Run-row history is kept (small + useful for "did
    // the cron stop?" diagnostics); operators trim it manually if it
    // ever grows beyond their comfort window.
    cleanupOld: async function (cleanupOpts) {
      if (!cleanupOpts || typeof cleanupOpts !== "object") {
        throw new TypeError(
          "cart-abandonment.cleanupOld: opts.before_ts is required"
        );
      }
      _epochMs(cleanupOpts.before_ts, "before_ts");
      var r = await query(
        "DELETE FROM cart_abandonment_detections WHERE detected_at < ?1",
        [cleanupOpts.before_ts],
      );
      return { deleted: Number(r.rowCount || 0) };
    },

    // Internal access for tests / debugging. Lets callers grab a
    // single detection by id without paginating through
    // recentDetections.
    _getDetection: async function (detectionId) {
      _uuid(detectionId, "detection_id");
      var r = await query(
        "SELECT * FROM cart_abandonment_detections WHERE id = ?1",
        [detectionId],
      );
      return r.rows[0] || null;
    },

    // Expose the optional deps so a wiring sanity check can assert
    // they reached the factory. The cart dep is required so the
    // accessor doesn't try to hide it.
    _deps: {
      cart:               cart,
      customers:          customers,
      emailSuppressions:  emailSuppressions,
    },

    // Validators — exported on the surface so adjacent primitives
    // (admin dashboards, observability shims) can re-use the same
    // status / skip-reason allowlists without duplicating the
    // constants.
    _validateStatus:     _statusFilter,
    _validateSkipReason: _skipReason,
  };
}

module.exports = {
  create:                    create,
  STATUSES:                  STATUSES,
  SKIP_REASONS:              SKIP_REASONS,
  DEFAULT_IDLE_THRESHOLD_MS: DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_MAX_AGE_MS:        DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_CARTS:         DEFAULT_MAX_CARTS,
};

// Validator helpers used inside `create()` referenced via closure;
// keep them outside the factory so test code can re-import them
// without spinning up a full factory instance.
void _nonNegInt;
