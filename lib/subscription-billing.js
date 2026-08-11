"use strict";
/**
 * @module shop.subscriptionBilling
 * @title  Subscription billing — invoice + payment + dunning ledger
 *
 * @intro
 *   The money side of recurring revenue. Sibling to
 *   `subscriptionControls` (which owns the customer-side pause /
 *   resume / skip / cancel FSM) — this primitive owns the
 *   processor-side invoice + payment + dunning ledger driven by
 *   Stripe (or any compatible processor) webhook deliveries.
 *
 *   Three append-only tables back the surface:
 *
 *     subscription_invoices         — one row per billing period
 *                                     the processor cuts an invoice
 *                                     for. Mirrors the processor's
 *                                     hosted invoice + the
 *                                     customer-facing receipt URL.
 *     subscription_payment_attempts — one row per processor charge
 *                                     attempt. Keyed by
 *                                     (invoice_id, attempt_number);
 *                                     replay-safe under webhook
 *                                     redelivery.
 *     subscription_dunning_states   — one row per dunning episode.
 *                                     Append-only history; the
 *                                     latest row's `state` is the
 *                                     current standing.
 *
 *   Composition:
 *     var bill = bShop.subscriptionBilling.create({
 *       query:         q,
 *       subscriptions: subs.subscriptions,
 *       payment:       pay,            // optional — reserved for
 *                                      //   processor.refund hooks
 *                                      //   in future minors.
 *     });
 *     await bill.recordInvoice({
 *       subscription_id, period_start, period_end,
 *       amount_minor, currency, invoice_url, processor_invoice_id,
 *     });
 *     await bill.recordPaymentAttempt({
 *       invoice_id, attempt_number: 1, status: "failed",
 *       processor_charge_id: "ch_…", failure_code: "card_declined",
 *     });
 *     await bill.markPaid({ invoice_id, paid_at });
 *     await bill.markFailed({ invoice_id, reason, attempt_number, next_retry_at });
 *     await bill.enterDunning({ subscription_id, reason });
 *     await bill.exitDunning({ subscription_id, outcome: "recovered" });
 *     await bill.invoicesForSubscription(subscription_id);
 *     await bill.failedInvoices({ from, to, limit });
 *     await bill.dunningRoster({ as_of });
 *     await bill.arpu({ from, to });
 *
 *   The invoice FSM is small: pending → paid | failed | voided.
 *   `failed` is not terminal — a subsequent `markPaid` (driven by
 *   the processor's automatic-recovery webhook) flips the row back
 *   to paid; the prior failed attempt rows stay in the ledger.
 *   `voided` is terminal; reserved for operator-issued voids (e.g.
 *   customer dispute upheld).
 *
 *   The `arpu` window query computes
 *   sum(paid_invoice.amount_minor) / distinct(subscription_id) over
 *   the [from, to] window. Currency is reported separately per
 *   bucket — the caller renders single-currency dashboards (the
 *   typical operator surface); cross-currency aggregation requires
 *   an FX layer the caller composes outside.
 *
 *   `invoice_url` runs through `b.safeUrl.parse` with the
 *   `ALLOW_HTTP_TLS` allowlist (https-only) so a hostile webhook
 *   payload can't smuggle a `javascript:` / `data:` / `file:` URL
 *   into a receipt email rendered by the storefront.
 *
 * @related b.safeUrl, b.guardUuid, b.uuid.v7
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- constants ----------------------------------------------------------

var INVOICE_STATUSES = ["pending", "paid", "failed", "voided"];
var ATTEMPT_STATUSES = ["succeeded", "failed"];
var DUNNING_STATES   = ["active", "dunning", "recovered", "cancelled", "written_off"];
var EXIT_OUTCOMES    = ["recovered", "cancelled", "written_off"];

var MAX_INVOICE_URL_LEN     = 2048;
var MAX_REASON_LEN          = 280;
var MAX_PROCESSOR_ID_LEN    = 255;
var MAX_FAILURE_CODE_LEN    = 64;
var MAX_LIST_LIMIT          = 500;
var DEFAULT_LIST_LIMIT      = 100;

// Reuse the same control-byte / zero-width refusal posture as the
// sibling subscription-controls primitive — operator-authored prose
// flows into receipt emails + the operator dashboard, so the same
// "no direction-override / no invisible glyph" floor applies.

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("subscriptionBilling: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _posIntOrZero(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("subscriptionBilling: " + label + " must be a non-negative integer");
  }
  return n;
}

function _posInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("subscriptionBilling: " + label + " must be a positive integer");
  }
  return n;
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("subscriptionBilling: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _epochMsOrNull(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("subscriptionBilling: currency must be 3-letter uppercase ISO 4217");
  }
  return c;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("subscriptionBilling: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("subscriptionBilling: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  textGuard.freeText(s, "subscriptionBilling: reason", { zeroWidth: "reject" });
  return s;
}

function _optReason(s) {
  if (s == null) return null;
  return _reason(s);
}

function _shortText(s, label, max) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("subscriptionBilling: " + label + " must be a non-empty string");
  }
  if (s.length > max) {
    throw new TypeError("subscriptionBilling: " + label + " must be <= " + max + " characters");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("subscriptionBilling: " + label + " contains control bytes");
  }
  return s;
}

function _optShortText(s, label, max) {
  if (s == null) return null;
  return _shortText(s, label, max);
}

// `invoice_url` runs through b.safeUrl so a hostile webhook payload
// can't smuggle a non-https hosted URL into the receipt email. The
// stored value goes straight to the storefront template; the
// safeUrl gate keeps `javascript:` / `data:` / `file:` / userinfo-
// bearing https:// URLs out.
function _invoiceUrl(url) {
  if (url == null) return null;
  if (typeof url !== "string" || !url.length) {
    throw new TypeError("subscriptionBilling: invoice_url must be a non-empty string when provided");
  }
  if (url.length > MAX_INVOICE_URL_LEN) {
    throw new TypeError("subscriptionBilling: invoice_url must be <= " + MAX_INVOICE_URL_LEN + " characters");
  }
  try {
    b.safeUrl.parse(url, { allowedProtocols: b.safeUrl.ALLOW_HTTP_TLS });
  } catch (e) {
    throw new TypeError("subscriptionBilling: invoice_url — " + (e && e.message || "must be a valid https:// URL"));
  }
  return url;
}

function _invoiceStatus(s) {
  if (typeof s !== "string" || INVOICE_STATUSES.indexOf(s) === -1) {
    throw new TypeError("subscriptionBilling: invoice status must be one of " + INVOICE_STATUSES.join(", "));
  }
  return s;
}

function _attemptStatus(s) {
  if (typeof s !== "string" || ATTEMPT_STATUSES.indexOf(s) === -1) {
    throw new TypeError("subscriptionBilling: attempt status must be one of " + ATTEMPT_STATUSES.join(", "));
  }
  return s;
}

function _exitOutcome(s) {
  if (typeof s !== "string" || EXIT_OUTCOMES.indexOf(s) === -1) {
    throw new TypeError("subscriptionBilling: outcome must be one of " + EXIT_OUTCOMES.join(", "));
  }
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("subscriptionBilling: limit must be a positive integer");
  }
  if (n > MAX_LIST_LIMIT) {
    throw new TypeError("subscriptionBilling: limit must be <= " + MAX_LIST_LIMIT);
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var subscriptionsHandle = opts.subscriptions;
  if (!subscriptionsHandle || typeof subscriptionsHandle.get !== "function") {
    throw new TypeError("subscriptionBilling.create: opts.subscriptions handle required");
  }
  // `payment` handle is accepted for forward compatibility (a future
  // minor will surface processor-driven refund + void hooks through
  // it); the current surface composes only the database + the
  // subscriptions handle.
  var paymentHandle = opts.payment || null;

  async function _getInvoice(invoiceId) {
    var r = await query("SELECT * FROM subscription_invoices WHERE id = ?1", [invoiceId]);
    return r.rows[0] || null;
  }

  async function _refetchInvoice(invoiceId) {
    return _getInvoice(invoiceId);
  }

  async function _subscriptionExists(subscriptionId) {
    var r = await query("SELECT id FROM subscriptions WHERE id = ?1", [subscriptionId]);
    return r.rows.length > 0;
  }

  // Latest dunning row for a subscription — `null` when the
  // subscription has never been in dunning. The append-only shape
  // means "current state" === "most-recent row," ordered by
  // (entered_at DESC, id DESC) so simultaneous rows fall back to v7
  // UUID tail.
  async function _latestDunning(subscriptionId) {
    var r = await query(
      "SELECT * FROM subscription_dunning_states WHERE subscription_id = ?1 " +
      "ORDER BY entered_at DESC, id DESC LIMIT 1",
      [subscriptionId],
    );
    return r.rows[0] || null;
  }

  return {
    INVOICE_STATUSES:  INVOICE_STATUSES.slice(),
    ATTEMPT_STATUSES:  ATTEMPT_STATUSES.slice(),
    DUNNING_STATES:    DUNNING_STATES.slice(),
    EXIT_OUTCOMES:     EXIT_OUTCOMES.slice(),
    MAX_INVOICE_URL_LEN: MAX_INVOICE_URL_LEN,
    MAX_REASON_LEN:      MAX_REASON_LEN,
    MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:  DEFAULT_LIST_LIMIT,

    // Reserved hook — surfaced so callers can inspect that the
    // factory wired the payment handle through, useful for tests
    // and for the future processor-driven refund path.
    payment: paymentHandle,

    recordInvoice: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.recordInvoice: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var periodStart    = _epochMs(input.period_start, "period_start");
      var periodEnd      = _epochMs(input.period_end,   "period_end");
      if (periodEnd < periodStart) {
        throw new TypeError("subscriptionBilling.recordInvoice: period_end must be >= period_start");
      }
      var amountMinor    = _posIntOrZero(input.amount_minor, "amount_minor");
      var currency       = _currency(input.currency);
      var invoiceUrl     = _invoiceUrl(input.invoice_url);
      var processorId    = _optShortText(input.processor_invoice_id, "processor_invoice_id", MAX_PROCESSOR_ID_LEN);

      if (!(await _subscriptionExists(subscriptionId))) {
        var notFound = new Error("subscriptionBilling.recordInvoice: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }

      // Webhook idempotency — Stripe redelivers `invoice.created`
      // freely. When the processor_invoice_id is set and matches an
      // existing row, return the existing row instead of inserting a
      // duplicate (the UNIQUE constraint would refuse the second
      // INSERT anyway; this surface gives the caller a clean replay
      // path).
      if (processorId != null) {
        var existing = await query(
          "SELECT * FROM subscription_invoices WHERE processor_invoice_id = ?1",
          [processorId],
        );
        if (existing.rows.length) return existing.rows[0];
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO subscription_invoices " +
        "(id, subscription_id, period_start, period_end, amount_minor, currency, " +
        " invoice_url, processor_invoice_id, status, paid_at, voided_at, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', NULL, NULL, ?9)",
        [id, subscriptionId, periodStart, periodEnd, amountMinor, currency, invoiceUrl, processorId, ts],
      );
      return await _refetchInvoice(id);
    },

    recordPaymentAttempt: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.recordPaymentAttempt: input object required");
      }
      var invoiceId      = _uuid(input.invoice_id, "invoice_id");
      var attemptNumber  = _posInt(input.attempt_number, "attempt_number");
      var status         = _attemptStatus(input.status);
      var processorCharge = _optShortText(input.processor_charge_id, "processor_charge_id", MAX_PROCESSOR_ID_LEN);
      var failureCode    = _optShortText(input.failure_code, "failure_code", MAX_FAILURE_CODE_LEN);

      var invoice = await _getInvoice(invoiceId);
      if (!invoice) {
        var notFound = new Error("subscriptionBilling.recordPaymentAttempt: invoice " + invoiceId + " not found");
        notFound.code = "INVOICE_NOT_FOUND";
        throw notFound;
      }

      // Replay-idempotent: if a row with the same (invoice_id,
      // attempt_number) already exists, return it. The UNIQUE
      // constraint would refuse a duplicate INSERT — this surface
      // surfaces the existing row so webhook redelivery is a no-op.
      var existing = await query(
        "SELECT * FROM subscription_payment_attempts WHERE invoice_id = ?1 AND attempt_number = ?2",
        [invoiceId, attemptNumber],
      );
      if (existing.rows.length) return existing.rows[0];

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO subscription_payment_attempts " +
        "(id, invoice_id, attempt_number, status, processor_charge_id, failure_code, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, invoiceId, attemptNumber, status, processorCharge, failureCode, ts],
      );
      var r = await query("SELECT * FROM subscription_payment_attempts WHERE id = ?1", [id]);
      return r.rows[0];
    },

    markPaid: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.markPaid: input object required");
      }
      var invoiceId = _uuid(input.invoice_id, "invoice_id");
      var paidAt    = _epochMs(input.paid_at, "paid_at");

      var invoice = await _getInvoice(invoiceId);
      if (!invoice) {
        var notFound = new Error("subscriptionBilling.markPaid: invoice " + invoiceId + " not found");
        notFound.code = "INVOICE_NOT_FOUND";
        throw notFound;
      }
      // FSM: paid is reachable from pending OR failed (processor
      // automatic-recovery flow). Refused from `voided` (terminal).
      // Replaying markPaid on an already-paid invoice is a no-op
      // (webhook redelivery idempotency).
      if (invoice.status === "voided") {
        var vErr = new Error("subscriptionBilling.markPaid: refused — invoice is voided (terminal)");
        vErr.code = "INVOICE_STATE_REFUSED";
        throw vErr;
      }
      if (invoice.status === "paid") return invoice;

      await query(
        "UPDATE subscription_invoices SET status = 'paid', paid_at = ?1 WHERE id = ?2",
        [paidAt, invoiceId],
      );
      return await _refetchInvoice(invoiceId);
    },

    markFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.markFailed: input object required");
      }
      var invoiceId     = _uuid(input.invoice_id, "invoice_id");
      var reason        = _reason(input.reason);
      var attemptNumber = _posInt(input.attempt_number, "attempt_number");
      var nextRetryAt   = _epochMsOrNull(input.next_retry_at, "next_retry_at");

      var invoice = await _getInvoice(invoiceId);
      if (!invoice) {
        var notFound = new Error("subscriptionBilling.markFailed: invoice " + invoiceId + " not found");
        notFound.code = "INVOICE_NOT_FOUND";
        throw notFound;
      }
      if (invoice.status === "voided") {
        var vErr = new Error("subscriptionBilling.markFailed: refused — invoice is voided (terminal)");
        vErr.code = "INVOICE_STATE_REFUSED";
        throw vErr;
      }
      if (invoice.status === "paid") {
        var pErr = new Error("subscriptionBilling.markFailed: refused — invoice is already paid");
        pErr.code = "INVOICE_STATE_REFUSED";
        throw pErr;
      }

      // Record the matching failed attempt row when one doesn't
      // already exist for this attempt_number — keeps the attempt
      // ledger + the invoice FSM in lock-step so a markFailed call
      // is a single composed transition the operator can replay.
      var existing = await query(
        "SELECT id FROM subscription_payment_attempts WHERE invoice_id = ?1 AND attempt_number = ?2",
        [invoiceId, attemptNumber],
      );
      if (!existing.rows.length) {
        var attemptId = b.uuid.v7();
        await query(
          "INSERT INTO subscription_payment_attempts " +
          "(id, invoice_id, attempt_number, status, processor_charge_id, failure_code, occurred_at) " +
          "VALUES (?1, ?2, ?3, 'failed', NULL, ?4, ?5)",
          [attemptId, invoiceId, attemptNumber, reason.slice(0, MAX_FAILURE_CODE_LEN), _now()],
        );
      }

      await query(
        "UPDATE subscription_invoices SET status = 'failed' WHERE id = ?1",
        [invoiceId],
      );
      var refreshed = await _refetchInvoice(invoiceId);
      // Surface next_retry_at on the returned row for the caller's
      // scheduler hook without persisting it (the next retry is the
      // processor's responsibility — the row carries it through as
      // a non-stored hint).
      refreshed.next_retry_at = nextRetryAt;
      return refreshed;
    },

    enterDunning: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.enterDunning: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var reason         = _reason(input.reason);

      if (!(await _subscriptionExists(subscriptionId))) {
        var notFound = new Error("subscriptionBilling.enterDunning: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var latest = await _latestDunning(subscriptionId);
      if (latest && latest.state === "dunning" && latest.exited_at == null) {
        var oErr = new Error("subscriptionBilling.enterDunning: refused — subscription is already in dunning");
        oErr.code = "DUNNING_STATE_REFUSED";
        throw oErr;
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO subscription_dunning_states " +
        "(id, subscription_id, state, reason, entered_at, exited_at) " +
        "VALUES (?1, ?2, 'dunning', ?3, ?4, NULL)",
        [id, subscriptionId, reason, ts],
      );
      var r = await query("SELECT * FROM subscription_dunning_states WHERE id = ?1", [id]);
      return r.rows[0];
    },

    exitDunning: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.exitDunning: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var outcome        = _exitOutcome(input.outcome);

      var latest = await _latestDunning(subscriptionId);
      if (!latest || latest.state !== "dunning" || latest.exited_at != null) {
        var sErr = new Error("subscriptionBilling.exitDunning: refused — subscription is not currently in dunning");
        sErr.code = "DUNNING_STATE_REFUSED";
        throw sErr;
      }

      var ts = _now();
      // Two writes: close the open dunning row (stamp exited_at)
      // AND append a fresh row capturing the outcome state. The
      // append-only shape keeps every transition discoverable on
      // replay without an UPDATE-then-SELECT race against a
      // concurrent dunningRoster reader.
      await query(
        "UPDATE subscription_dunning_states SET exited_at = ?1 WHERE id = ?2",
        [ts, latest.id],
      );
      var id = b.uuid.v7();
      await query(
        "INSERT INTO subscription_dunning_states " +
        "(id, subscription_id, state, reason, entered_at, exited_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        [id, subscriptionId, outcome, latest.reason, ts],
      );
      var r = await query("SELECT * FROM subscription_dunning_states WHERE id = ?1", [id]);
      return r.rows[0];
    },

    invoicesForSubscription: async function (subscriptionId) {
      subscriptionId = _uuid(subscriptionId, "subscription_id");
      var r = await query(
        "SELECT * FROM subscription_invoices WHERE subscription_id = ?1 " +
        "ORDER BY created_at DESC, id DESC",
        [subscriptionId],
      );
      return r.rows;
    },

    failedInvoices: async function (input) {
      input = input || {};
      var from  = input.from == null ? 0                  : _epochMs(input.from, "from");
      var to    = input.to   == null ? Number.MAX_SAFE_INTEGER : _epochMs(input.to,   "to");
      if (from > to) {
        throw new TypeError("subscriptionBilling.failedInvoices: from must be <= to");
      }
      var limit = _limit(input.limit);
      var r = await query(
        "SELECT * FROM subscription_invoices WHERE status = 'failed' " +
        "AND created_at >= ?1 AND created_at <= ?2 " +
        "ORDER BY created_at DESC, id DESC LIMIT ?3",
        [from, to, limit],
      );
      return r.rows;
    },

    // Snapshot the subscriptions whose most-recent dunning row is
    // open (`state = 'dunning'`, `exited_at IS NULL`) as of the
    // caller-supplied epoch. Operator dashboards drive this from a
    // per-minute scheduler walk so the working set tracks real-time
    // dunning load.
    dunningRoster: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.dunningRoster: input object required");
      }
      var asOf = _epochMs(input.as_of, "as_of");
      // The partial index on (state, entered_at) WHERE exited_at IS
      // NULL covers this query; the `entered_at <= asOf` clause lets
      // operators "replay yesterday's roster" for trend analysis
      // without a follow-up reporting table.
      var r = await query(
        "SELECT * FROM subscription_dunning_states " +
        "WHERE state = 'dunning' AND exited_at IS NULL AND entered_at <= ?1 " +
        "ORDER BY entered_at ASC, id ASC",
        [asOf],
      );
      return r.rows;
    },

    // Average revenue per user: sum(amount_minor) over paid
    // invoices in [from, to], divided by the distinct subscription
    // count over the same window. Returned as a {currency:
    // {total_minor, subscriptions, arpu_minor}} map so the caller
    // renders single-currency dashboards (cross-currency
    // aggregation requires an FX layer outside this primitive).
    arpu: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionBilling.arpu: input object required");
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from > to) {
        throw new TypeError("subscriptionBilling.arpu: from must be <= to");
      }
      var r = await query(
        "SELECT currency, SUM(amount_minor) AS total_minor, " +
        "       COUNT(DISTINCT subscription_id) AS subs " +
        "FROM subscription_invoices " +
        "WHERE status = 'paid' AND paid_at IS NOT NULL " +
        "AND paid_at >= ?1 AND paid_at <= ?2 " +
        "GROUP BY currency",
        [from, to],
      );
      var out = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var totalMinor = row.total_minor == null ? 0 : Number(row.total_minor);
        var subs       = row.subs == null       ? 0 : Number(row.subs);
        // Integer division (floor) — minor units stay integer-only.
        // A fractional ARPU display is the caller's render-tier
        // concern (locale-aware money formatting); the primitive
        // returns the floor + the raw inputs so the caller can
        // compute the fraction if needed.
        var arpu = subs === 0 ? 0 : Math.floor(totalMinor / subs);
        out[row.currency] = {
          total_minor:    totalMinor,
          subscriptions:  subs,
          arpu_minor:     arpu,
        };
      }
      return out;
    },
  };
}

module.exports = {
  create:              create,
  INVOICE_STATUSES:    INVOICE_STATUSES.slice(),
  ATTEMPT_STATUSES:    ATTEMPT_STATUSES.slice(),
  DUNNING_STATES:      DUNNING_STATES.slice(),
  EXIT_OUTCOMES:       EXIT_OUTCOMES.slice(),
  MAX_INVOICE_URL_LEN: MAX_INVOICE_URL_LEN,
  MAX_REASON_LEN:      MAX_REASON_LEN,
  MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:  DEFAULT_LIST_LIMIT,
};
