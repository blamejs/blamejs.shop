"use strict";
/**
 * @module shop.creditLimits
 * @title  Credit-limits primitive — B2B credit accounts with
 *         outstanding-balance accounting + aging reports
 *
 * @intro
 *   B2B customers buy on terms: an operator-defined credit_limit +
 *   payment_terms_days (net-15 / net-30 / net-60) + billing_cycle
 *   (weekly / biweekly / monthly). Orders charge against the
 *   account up to the limit; an invoice is rendered at end-of-cycle;
 *   the customer pays the invoice and the outstanding balance
 *   reduces.
 *
 *   Distinct from `storeCredit` (a prepaid wallet drained by
 *   debits). Here the customer is borrowing against the operator's
 *   credit line — `outstanding_balance` grows when orders charge,
 *   shrinks when payments arrive. `available_credit` is
 *   `credit_limit - outstanding`.
 *
 *   Composition:
 *     var credit = bShop.creditLimits.create({ query: q });
 *     await credit.defineAccount({
 *       customer_id:        custId,
 *       credit_limit_minor: 500000,           // $5,000
 *       currency:           "USD",
 *       payment_terms_days: 30,
 *       billing_cycle:      "monthly",
 *     });
 *     await credit.chargeOrder({
 *       customer_id:  custId,
 *       order_id:     orderId,
 *       amount_minor: 12500,
 *     });
 *     var avail = await credit.availableCredit(custId);
 *     // { credit_limit_minor: 500000, outstanding_minor: 12500,
 *     //   available_minor: 487500 }
 *
 *   FSM (`credit_accounts.status`):
 *
 *       defineAccount → active
 *       active        → suspended (via suspendAccount, requires reason)
 *       suspended     → active    (via reinstateAccount, clears reason)
 *       any           → closed    (terminal — no transition out)
 *
 *   `chargeOrder` refuses with code `CREDIT_LIMIT_EXCEEDED` when the
 *   pending balance after the charge would exceed the limit, and
 *   refuses with code `CREDIT_ACCOUNT_NOT_ACTIVE` when the account
 *   is suspended or closed. Refusals write no transaction row.
 *
 *   `releaseHold` reverses a prior charge/hold for the same
 *   order_id — credits the customer back. Refuses if the order_id
 *   never charged.
 *
 *   `agingReport` answers the AR question "how old is each slice of
 *   the outstanding balance?" — bucketed by charge age into
 *   `current` (within payment_terms_days), `30d`, `60d`, `90d_plus`.
 *   Payments are applied FIFO against the oldest outstanding
 *   charges; what's left in each charge after FIFO settlement is
 *   what the report bucketizes.
 *
 *   Monotonic per-customer `occurred_at`: two writes in the same
 *   millisecond would tie and make the "latest row" ambiguous for
 *   the denormalized balance read. Every ledger append bumps the
 *   requested timestamp to `prior + 1` on collision (in-statement,
 *   atomically with the write), guaranteeing strict monotonicity in
 *   the `(customer_id, occurred_at DESC)` index.
 *
 *   Surface:
 *     - defineAccount({ customer_id, credit_limit_minor, currency,
 *                       payment_terms_days, billing_cycle })
 *     - getAccount(customer_id)
 *     - listAccounts({ status? })
 *     - updateAccount(customer_id, patch)
 *     - suspendAccount({ customer_id, reason })
 *     - reinstateAccount(customer_id)
 *     - chargeOrder({ customer_id, order_id, amount_minor, occurred_at? })
 *     - releaseHold({ customer_id, order_id, occurred_at? })
 *     - recordPayment({ customer_id, amount_minor, payment_ref,
 *                       occurred_at? })
 *     - availableCredit(customer_id)
 *     - outstandingBalance(customer_id)
 *     - agingReport({ customer_id, now? })
 *
 *   Storage:
 *     - credit_accounts      (migration 0122)
 *     - credit_transactions  (migration 0122)
 *
 * @primitive creditLimits
 * @related   b.uuid.v7, b.guardUuid, shop.storeCredit, shop.invoiceRenderer
 */

var b = require("./vendor/blamejs");
var C = b.constants;

var BILLING_CYCLES = ["weekly", "biweekly", "monthly"];
var STATUSES       = ["active", "suspended", "closed"];
var KINDS          = ["charge", "payment", "hold", "release", "adjustment"];

var MAX_REF_LEN = 128;
// payment_ref / suspended_reason / currency are short correlation
// fields. Refuse all control bytes (including CR/LF and tab) — log-
// injection cover has no legitimate place in a one-line column.
var PRINTABLE_RE = /^[^\x00-\x1f\x7f]*$/;

var MS_PER_DAY = C.TIME.days(1);

// Aging buckets. The boundary days are reported as part of the
// agingReport return shape so downstream invoice rendering doesn't
// re-derive the constants.
var AGE_BUCKETS = {
  CURRENT: "current",        // age <= payment_terms_days
  D30:     "d30",             // age in (payment_terms_days, 30]
  D60:     "d60",             // age in (30, 60]
  D90:     "d90_plus",        // age > 60
};

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("creditLimits: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _amountMinor(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("creditLimits: " + label + " must be a positive integer (minor units)");
  }
  return n;
}

function _limitMinor(n, label) {
  // Credit limit accepts zero — a freshly-defined account at zero
  // limit blocks every charge until the operator raises it. Treated
  // distinct from "positive amount" because amount_minor is always
  // an event delta (must be > 0) while limits are stateful (can be
  // legitimately zero or raised/lowered).
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("creditLimits: " + label + " must be a non-negative integer (minor units)");
  }
  return n;
}

function _termsDays(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("creditLimits: " + label + " must be a positive integer (days)");
  }
  return n;
}

function _billingCycle(s) {
  if (typeof s !== "string" || BILLING_CYCLES.indexOf(s) === -1) {
    throw new TypeError("creditLimits: billing_cycle must be one of " + BILLING_CYCLES.join(", "));
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || s.length === 0) {
    throw new TypeError("creditLimits: currency must be a non-empty string");
  }
  if (s.length > 16) {
    throw new TypeError("creditLimits: currency must be <= 16 chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("creditLimits: currency must not contain control bytes");
  }
  return s;
}

function _ref(s, label, required) {
  if (s == null) {
    if (required) {
      throw new TypeError("creditLimits: " + label + " is required");
    }
    return null;
  }
  if (typeof s !== "string") {
    throw new TypeError("creditLimits: " + label + " must be a string");
  }
  if (!s.length) {
    throw new TypeError("creditLimits: " + label + " must be a non-empty string when provided");
  }
  if (s.length > MAX_REF_LEN) {
    throw new TypeError("creditLimits: " + label + " must be <= " + MAX_REF_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("creditLimits: " + label + " must not contain control bytes");
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("creditLimits: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("creditLimits: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional handle to the customers primitive. When provided,
  // defineAccount confirms the customer row exists before writing.
  // Tests pass a stub that satisfies `.get(id)`; production wires
  // the real `bShop.customers.create(...)` instance.
  var customers = opts.customers || null;

  async function _requireCustomer(id, label) {
    if (!customers) return;
    var row = await customers.get(id);
    if (!row) {
      throw new TypeError("creditLimits: " + label + " " + JSON.stringify(id) + " not found in customers");
    }
  }

  async function _readAccount(customerId) {
    var r = await query(
      "SELECT customer_id, credit_limit_minor, currency, payment_terms_days, billing_cycle, " +
      "status, suspended_reason, suspended_at, created_at, updated_at " +
      "FROM credit_accounts WHERE customer_id = ?1 LIMIT 1",
      [customerId],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  async function _readLatestTxn(customerId) {
    var r = await query(
      "SELECT balance_after_minor, occurred_at FROM credit_transactions " +
      "WHERE customer_id = ?1 ORDER BY occurred_at DESC LIMIT 1",
      [customerId],
    );
    if (!r.rows.length) return { balance: 0, occurred_at: null };
    return { balance: r.rows[0].balance_after_minor, occurred_at: r.rows[0].occurred_at };
  }

  // Shared subquery for the customer's current outstanding balance —
  // the denormalized `balance_after_minor` of their latest transaction.
  // References ?2 (customer_id), so every _appendTxnAtomic call binds
  // customer_id as the second parameter.
  var _BAL_SUB = "COALESCE((SELECT balance_after_minor FROM credit_transactions " +
                 "WHERE customer_id = ?2 ORDER BY occurred_at DESC LIMIT 1), 0)";

  // Append a ledger transaction ATOMICALLY. The new balance, the
  // strictly-monotonic occurred_at, and the operation's invariant
  // (credit limit / sufficient balance / outstanding charge) are all
  // evaluated inside one INSERT ... SELECT ... WHERE statement, so the
  // read of the latest balance can't be separated from the write that
  // depends on it. SQLite serializes writers, so a second concurrent
  // append sees the first's committed row: the denormalized running
  // balance chains correctly and an invariant can't be bypassed by
  // interleaving. (The racy read-check-write this replaced let two
  // concurrent charges both pass the limit check, exceed the limit,
  // and stamp the same balance_after — permanently under-stating
  // exposure.) `guardExpr` false -> zero rows inserted -> returns
  // null, and the caller raises its own typed refusal after a re-read.
  //
  // Fixed params: ?1 id, ?2 customer_id, ?3 kind, ?4 order_id,
  // ?5 requested occurred_at, ?6 payment_ref. amountExpr / afterExpr /
  // guardExpr may reference _BAL_SUB and bind extra params from ?7 up.
  async function _appendTxnAtomic(customerId, kind, orderId, paymentRef, requestedTs,
                                  amountExpr, afterExpr, guardExpr, extraParams) {
    var id = b.uuid.v7();
    var tsSub = "COALESCE((SELECT occurred_at FROM credit_transactions " +
                "WHERE customer_id = ?2 ORDER BY occurred_at DESC LIMIT 1), 0)";
    // Strictly-monotonic per-customer occurred_at: bump to prior + 1 on
    // a same-ms collision so the "latest row" stays unambiguous for the
    // denormalized-balance reads.
    var tsExpr = "CASE WHEN ?5 > " + tsSub + " THEN ?5 ELSE " + tsSub + " + 1 END";
    var params = [id, customerId, kind, orderId, requestedTs, paymentRef].concat(extraParams || []);
    var res = await query(
      "INSERT INTO credit_transactions " +
      "(id, customer_id, kind, order_id, amount_minor, balance_after_minor, payment_ref, occurred_at) " +
      "SELECT ?1, ?2, ?3, ?4, " + amountExpr + ", " + afterExpr + ", ?6, " + tsExpr + " " +
      "WHERE " + guardExpr,
      params,
    );
    if (Number(res.rowCount || 0) === 0) return null;
    var row = (await query(
      "SELECT amount_minor, balance_after_minor, occurred_at FROM credit_transactions WHERE id = ?1",
      [id],
    )).rows[0];
    return {
      id:                  id,
      amount_minor:        row.amount_minor,
      balance_after_minor: row.balance_after_minor,
      occurred_at:         row.occurred_at,
    };
  }

  async function _requireActive(customerId, op) {
    var acct = await _readAccount(customerId);
    if (!acct) {
      var notFound = new Error("creditLimits." + op + ": no account for customer " + JSON.stringify(customerId));
      notFound.code = "CREDIT_ACCOUNT_NOT_FOUND";
      throw notFound;
    }
    if (acct.status !== "active") {
      var notActive = new Error("creditLimits." + op + ": account status is " + acct.status + " — operation refused");
      notActive.code = "CREDIT_ACCOUNT_NOT_ACTIVE";
      throw notActive;
    }
    return acct;
  }

  return {
    BILLING_CYCLES: BILLING_CYCLES.slice(),
    STATUSES:       STATUSES.slice(),
    KINDS:          KINDS.slice(),
    AGE_BUCKETS:    { CURRENT: AGE_BUCKETS.CURRENT, D30: AGE_BUCKETS.D30, D60: AGE_BUCKETS.D60, D90: AGE_BUCKETS.D90 },

    defineAccount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("creditLimits.defineAccount: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var limit      = _limitMinor(input.credit_limit_minor, "credit_limit_minor");
      var currency   = _currency(input.currency);
      var terms      = _termsDays(input.payment_terms_days, "payment_terms_days");
      var cycle      = _billingCycle(input.billing_cycle);

      await _requireCustomer(customerId, "customer_id");

      var existing = await _readAccount(customerId);
      if (existing) {
        throw new TypeError("creditLimits.defineAccount: account for customer " +
          JSON.stringify(customerId) + " already exists — use updateAccount");
      }

      var ts = _now();
      await query(
        "INSERT INTO credit_accounts " +
        "(customer_id, credit_limit_minor, currency, payment_terms_days, billing_cycle, " +
        " status, suspended_reason, suspended_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'active', NULL, NULL, ?6, ?7)",
        [customerId, limit, currency, terms, cycle, ts, ts],
      );
      return {
        customer_id:         customerId,
        credit_limit_minor:  limit,
        currency:            currency,
        payment_terms_days:  terms,
        billing_cycle:       cycle,
        status:              "active",
        suspended_reason:    null,
        suspended_at:        null,
        created_at:          ts,
        updated_at:          ts,
      };
    },

    getAccount: async function (customerId) {
      _uuid(customerId, "customer_id");
      return _readAccount(customerId);
    },

    listAccounts: async function (input) {
      input = input || {};
      var sql = "SELECT customer_id, credit_limit_minor, currency, payment_terms_days, billing_cycle, " +
                "status, suspended_reason, suspended_at, created_at, updated_at " +
                "FROM credit_accounts";
      var params = [];
      if (input.status != null) {
        var s = _status(input.status);
        sql += " WHERE status = ?1";
        params.push(s);
      }
      sql += " ORDER BY created_at ASC, customer_id ASC";
      var r = await query(sql, params);
      return r.rows;
    },

    updateAccount: async function (customerId, patch) {
      _uuid(customerId, "customer_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("creditLimits.updateAccount: patch object required");
      }
      var acct = await _readAccount(customerId);
      if (!acct) {
        throw new TypeError("creditLimits.updateAccount: no account for customer " + JSON.stringify(customerId));
      }
      if (acct.status === "closed") {
        throw new TypeError("creditLimits.updateAccount: account is closed — no further updates");
      }

      // Whitelist patchable columns. `status` transitions go through
      // suspend/reinstate; `customer_id` is the primary key; the
      // audit columns (`created_at`, `suspended_*`) are derived. The
      // operator can change pricing/cadence shape here.
      var sets   = [];
      var params = [];
      var idx    = 1;

      if (Object.prototype.hasOwnProperty.call(patch, "credit_limit_minor")) {
        var newLimit = _limitMinor(patch.credit_limit_minor, "credit_limit_minor");
        sets.push("credit_limit_minor = ?" + idx); params.push(newLimit); idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "currency")) {
        sets.push("currency = ?" + idx); params.push(_currency(patch.currency)); idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "payment_terms_days")) {
        sets.push("payment_terms_days = ?" + idx); params.push(_termsDays(patch.payment_terms_days, "payment_terms_days")); idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "billing_cycle")) {
        sets.push("billing_cycle = ?" + idx); params.push(_billingCycle(patch.billing_cycle)); idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "status")) {
        // Status transitions through suspend/reinstate only — the
        // FSM lives there. The only direct transition we accept on
        // update is `closed` (terminal); anything else is rejected
        // so callers don't bypass the suspension reason audit-trail.
        var nextStatus = _status(patch.status);
        if (nextStatus !== "closed") {
          throw new TypeError("creditLimits.updateAccount: status transition via update is restricted to 'closed' — use suspendAccount / reinstateAccount otherwise");
        }
        sets.push("status = ?" + idx); params.push("closed"); idx += 1;
        // If the account was suspended, closing clears the
        // suspension metadata — it's no longer relevant.
        sets.push("suspended_reason = NULL");
        sets.push("suspended_at = NULL");
      }

      if (sets.length === 0) {
        throw new TypeError("creditLimits.updateAccount: patch must contain at least one updatable field");
      }
      var ts = _now();
      sets.push("updated_at = ?" + idx); params.push(ts); idx += 1;
      params.push(customerId);

      await query(
        "UPDATE credit_accounts SET " + sets.join(", ") + " WHERE customer_id = ?" + idx,
        params,
      );
      return _readAccount(customerId);
    },

    suspendAccount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("creditLimits.suspendAccount: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var reason     = _ref(input.reason, "reason", true);

      var acct = await _readAccount(customerId);
      if (!acct) {
        throw new TypeError("creditLimits.suspendAccount: no account for customer " + JSON.stringify(customerId));
      }
      if (acct.status === "closed") {
        throw new TypeError("creditLimits.suspendAccount: account is closed — cannot suspend");
      }
      if (acct.status === "suspended") {
        throw new TypeError("creditLimits.suspendAccount: account already suspended");
      }
      var ts = _now();
      await query(
        "UPDATE credit_accounts SET status = 'suspended', suspended_reason = ?1, suspended_at = ?2, updated_at = ?3 " +
        "WHERE customer_id = ?4",
        [reason, ts, ts, customerId],
      );
      return _readAccount(customerId);
    },

    reinstateAccount: async function (customerId) {
      _uuid(customerId, "customer_id");
      var acct = await _readAccount(customerId);
      if (!acct) {
        throw new TypeError("creditLimits.reinstateAccount: no account for customer " + JSON.stringify(customerId));
      }
      if (acct.status === "closed") {
        throw new TypeError("creditLimits.reinstateAccount: account is closed — cannot reinstate");
      }
      if (acct.status === "active") {
        throw new TypeError("creditLimits.reinstateAccount: account is already active");
      }
      var ts = _now();
      await query(
        "UPDATE credit_accounts SET status = 'active', suspended_reason = NULL, suspended_at = NULL, updated_at = ?1 " +
        "WHERE customer_id = ?2",
        [ts, customerId],
      );
      return _readAccount(customerId);
    },

    chargeOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("creditLimits.chargeOrder: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var orderId    = _uuid(input.order_id, "order_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      // Fast pre-check for a clean NOT_FOUND / NOT_ACTIVE error; the
      // credit-limit invariant itself is enforced atomically in the
      // INSERT guard below (re-checking status = 'active' there too),
      // so a charge can't slip past the limit by racing another charge.
      await _requireActive(customerId, "chargeOrder");
      var written = await _appendTxnAtomic(
        customerId, "charge", orderId, null, requested,
        "?7",                                    // amount_minor: the charge
        _BAL_SUB + " + ?7",                      // balance_after = outstanding + amount
        // Cap check AND per-order dedup in one atomic guard: refuse a second
        // charge for the same order so the same order_id can't be charged
        // twice against the line (the bridge serializes statements, so the
        // NOT EXISTS sees a prior committed charge).
        "(" + _BAL_SUB + " + ?7) <= COALESCE((SELECT credit_limit_minor " +
          "FROM credit_accounts WHERE customer_id = ?2 AND status = 'active'), -1) " +
          "AND NOT EXISTS (SELECT 1 FROM credit_transactions " +
          "WHERE customer_id = ?2 AND order_id = ?4 AND kind = 'charge')",
        [amount],
      );
      if (!written) {
        // Idempotent: if a charge for this order already landed, the NOT
        // EXISTS guard (not the cap) refused this one. Return the original
        // charge so a retry is a safe no-op rather than a double-charge or a
        // misleading limit error.
        var prior = (await query(
          "SELECT id, amount_minor, balance_after_minor, occurred_at FROM credit_transactions " +
          "WHERE customer_id = ?1 AND order_id = ?2 AND kind = 'charge' ORDER BY occurred_at ASC, id ASC LIMIT 1",
          [customerId, orderId],
        )).rows[0];
        if (prior) {
          return {
            id:                  prior.id,
            customer_id:         customerId,
            kind:                "charge",
            order_id:            orderId,
            amount_minor:        Number(prior.amount_minor),
            balance_after_minor: Number(prior.balance_after_minor),
            occurred_at:         Number(prior.occurred_at),
            idempotent:          true,
          };
        }
        // Guard refused for the cap. Re-read to report precisely: a status
        // change since the pre-check (rare race with suspend/close) vs the
        // limit being exceeded.
        var acctNow = await _readAccount(customerId);
        if (!acctNow || acctNow.status !== "active") {
          var na = new Error("creditLimits.chargeOrder: account status is " +
            (acctNow ? acctNow.status : "missing") + " — operation refused");
          na.code = acctNow ? "CREDIT_ACCOUNT_NOT_ACTIVE" : "CREDIT_ACCOUNT_NOT_FOUND";
          throw na;
        }
        var curBal = (await _readLatestTxn(customerId)).balance;
        var over = new Error("creditLimits.chargeOrder: amount " + amount +
          " would exceed credit limit (outstanding " + curBal +
          " + amount " + amount + " > limit " + acctNow.credit_limit_minor + ")");
        over.code = "CREDIT_LIMIT_EXCEEDED";
        over.outstanding_minor   = curBal;
        over.credit_limit_minor  = acctNow.credit_limit_minor;
        over.attempted_minor     = amount;
        throw over;
      }
      return {
        id:                  written.id,
        customer_id:         customerId,
        kind:                "charge",
        order_id:            orderId,
        amount_minor:        amount,
        balance_after_minor: written.balance_after_minor,
        occurred_at:         written.occurred_at,
      };
    },

    releaseHold: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("creditLimits.releaseHold: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var orderId    = _uuid(input.order_id, "order_id");
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      // releaseHold acts on the same FSM as chargeOrder — closed/
      // suspended accounts could refuse here, but the operator-
      // facing case is "we suspended this customer; release their
      // pending order so they aren't carrying the balance." Refuse
      // only when the account doesn't exist; allow on suspended.
      var acct = await _readAccount(customerId);
      if (!acct) {
        var notFound = new Error("creditLimits.releaseHold: no account for customer " + JSON.stringify(customerId));
        notFound.code = "CREDIT_ACCOUNT_NOT_FOUND";
        throw notFound;
      }
      if (acct.status === "closed") {
        var closed = new Error("creditLimits.releaseHold: account is closed");
        closed.code = "CREDIT_ACCOUNT_NOT_ACTIVE";
        throw closed;
      }

      // Net exposure to this order — charge + hold sums minus prior
      // release sums — capped at the live balance, computed and written
      // in ONE atomic statement. The racy read-sum-then-write this
      // replaced let two concurrent releases (or a release racing a
      // payment) both read the same remaining/balance and both write,
      // double-releasing the order and corrupting the running balance.
      // The guard refuses when nothing is outstanding (never charged /
      // already fully released) or the balance is drained, so a release
      // can't drive the ledger negative. Capping at _BAL_SUB stays
      // defensive against operator-induced ledger drift.
      var remainingSub = "COALESCE((SELECT SUM(CASE " +
        "WHEN kind IN ('charge', 'hold') THEN amount_minor " +
        "WHEN kind = 'release' THEN -amount_minor ELSE 0 END) " +
        "FROM credit_transactions WHERE customer_id = ?2 AND order_id = ?4), 0)";
      var toReleaseExpr = "CASE WHEN " + remainingSub + " < " + _BAL_SUB +
        " THEN " + remainingSub + " ELSE " + _BAL_SUB + " END";
      var written = await _appendTxnAtomic(
        customerId, "release", orderId, null, requested,
        toReleaseExpr,                                   // amount actually released
        _BAL_SUB + " - (" + toReleaseExpr + ")",         // new balance
        remainingSub + " > 0 AND " + _BAL_SUB + " > 0",  // nothing outstanding / drained -> refuse
        [],
      );
      if (!written) {
        var nothing = new Error("creditLimits.releaseHold: no outstanding charge for order " + JSON.stringify(orderId));
        nothing.code = "CREDIT_RELEASE_NOT_FOUND";
        throw nothing;
      }
      return {
        id:                  written.id,
        customer_id:         customerId,
        kind:                "release",
        order_id:            orderId,
        amount_minor:        written.amount_minor,
        balance_after_minor: written.balance_after_minor,
        occurred_at:         written.occurred_at,
      };
    },

    recordPayment: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("creditLimits.recordPayment: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var amount     = _amountMinor(input.amount_minor, "amount_minor");
      var paymentRef = _ref(input.payment_ref, "payment_ref", true);
      var requested  = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var acct = await _readAccount(customerId);
      if (!acct) {
        var notFound = new Error("creditLimits.recordPayment: no account for customer " + JSON.stringify(customerId));
        notFound.code = "CREDIT_ACCOUNT_NOT_FOUND";
        throw notFound;
      }
      // Payments accepted even on suspended/closed accounts — a
      // customer with a closed account paying down their balance is
      // a legitimate AR workflow.

      // Refuse a payment that exceeds the outstanding balance —
      // credit-on-account-from-overpayment is a separate primitive
      // (store-credit) and the operator must route the overage there
      // explicitly rather than implicitly inflating the outstanding
      // into negative territory. Enforced in the atomic INSERT guard so
      // two concurrent payments can't both pass an outdated balance
      // read and over-apply (driving the ledger negative).
      var written = await _appendTxnAtomic(
        customerId, "payment", null, paymentRef, requested,
        "?7",                   // amount paid
        _BAL_SUB + " - ?7",     // new balance
        "?7 <= " + _BAL_SUB,    // amount <= outstanding, else refuse
        [amount],
      );
      if (!written) {
        var curBal = (await _readLatestTxn(customerId)).balance;
        var over = new Error("creditLimits.recordPayment: amount " + amount +
          " exceeds outstanding balance " + curBal);
        over.code = "CREDIT_PAYMENT_EXCEEDS_OUTSTANDING";
        over.outstanding_minor = curBal;
        over.attempted_minor   = amount;
        throw over;
      }
      return {
        id:                  written.id,
        customer_id:         customerId,
        kind:                "payment",
        amount_minor:        amount,
        payment_ref:         paymentRef,
        balance_after_minor: written.balance_after_minor,
        occurred_at:         written.occurred_at,
      };
    },

    availableCredit: async function (customerId) {
      _uuid(customerId, "customer_id");
      var acct = await _readAccount(customerId);
      if (!acct) {
        throw new TypeError("creditLimits.availableCredit: no account for customer " + JSON.stringify(customerId));
      }
      var latest = await _readLatestTxn(customerId);
      var avail  = acct.credit_limit_minor - latest.balance;
      // Suspended accounts surface zero available — the limit is
      // still stored but no new charges can flow.
      if (acct.status !== "active") avail = 0;
      if (avail < 0) avail = 0;
      return {
        customer_id:        customerId,
        credit_limit_minor: acct.credit_limit_minor,
        outstanding_minor:  latest.balance,
        available_minor:    avail,
        status:             acct.status,
        currency:           acct.currency,
      };
    },

    outstandingBalance: async function (customerId) {
      _uuid(customerId, "customer_id");
      var acct = await _readAccount(customerId);
      if (!acct) {
        throw new TypeError("creditLimits.outstandingBalance: no account for customer " + JSON.stringify(customerId));
      }
      var latest = await _readLatestTxn(customerId);
      return {
        customer_id:        customerId,
        outstanding_minor:  latest.balance,
        currency:           acct.currency,
      };
    },

    agingReport: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("creditLimits.agingReport: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var now = _epochMs(input.now, "now");
      if (now == null) now = _now();

      var acct = await _readAccount(customerId);
      if (!acct) {
        throw new TypeError("creditLimits.agingReport: no account for customer " + JSON.stringify(customerId));
      }
      var terms = acct.payment_terms_days;

      // Walk all charge/hold rows oldest-first. Apply payments +
      // releases FIFO against the oldest outstanding amounts. What
      // remains in each charge row after settlement is the
      // outstanding slice for that age bucket.
      var chargeRows = (await query(
        "SELECT amount_minor, occurred_at, order_id FROM credit_transactions " +
        "WHERE customer_id = ?1 AND kind IN ('charge', 'hold') " +
        "ORDER BY occurred_at ASC",
        [customerId],
      )).rows;

      var settleRow = (await query(
        "SELECT COALESCE(SUM(amount_minor), 0) AS total FROM credit_transactions " +
        "WHERE customer_id = ?1 AND kind IN ('payment', 'release')",
        [customerId],
      )).rows[0];
      var toSettle = settleRow ? settleRow.total : 0;

      var buckets = {};
      buckets[AGE_BUCKETS.CURRENT] = 0;
      buckets[AGE_BUCKETS.D30]     = 0;
      buckets[AGE_BUCKETS.D60]     = 0;
      buckets[AGE_BUCKETS.D90]     = 0;

      var total = 0;
      for (var i = 0; i < chargeRows.length; i += 1) {
        var row = chargeRows[i];
        var remaining = row.amount_minor;
        if (toSettle > 0) {
          var settled = toSettle > remaining ? remaining : toSettle;
          remaining -= settled;
          toSettle  -= settled;
        }
        if (remaining <= 0) continue;
        var ageMs   = now - row.occurred_at;
        var ageDays = Math.floor(ageMs / MS_PER_DAY);
        // Bucket by days-past-due so the report reads the same
        // regardless of the account's payment terms — a net-15 and
        // a net-60 account both report `current` against not-yet-
        // due charges, then advance through 30 / 60 / 90+ buckets
        // measured from the due date.
        var pastDue = ageDays - terms;
        var bucket;
        if (pastDue <= 0)        bucket = AGE_BUCKETS.CURRENT;
        else if (pastDue <= 30)  bucket = AGE_BUCKETS.D30;
        else if (pastDue <= 60)  bucket = AGE_BUCKETS.D60;
        else                     bucket = AGE_BUCKETS.D90;
        buckets[bucket] += remaining;
        total          += remaining;
      }

      return {
        customer_id:         customerId,
        currency:            acct.currency,
        payment_terms_days:  terms,
        total_outstanding_minor: total,
        buckets: {
          current:  buckets[AGE_BUCKETS.CURRENT],
          d30:      buckets[AGE_BUCKETS.D30],
          d60:      buckets[AGE_BUCKETS.D60],
          d90_plus: buckets[AGE_BUCKETS.D90],
        },
        as_of: now,
      };
    },
  };
}

module.exports = {
  create:         create,
  BILLING_CYCLES: BILLING_CYCLES,
  STATUSES:       STATUSES,
  KINDS:          KINDS,
  AGE_BUCKETS:    AGE_BUCKETS,
};
