"use strict";
/**
 * @module shop.paymentMethods
 * @title  Payment methods primitive — per-customer saved processor tokens
 *
 * @intro
 *   Customers save a reference to a payment instrument so they don't
 *   re-enter card details on every order. The shop NEVER touches the
 *   raw PAN or CVV — those stay inside the payment processor's
 *   PCI-DSS scope. What we hold is the processor's opaque token
 *   (Stripe `pm_…`, PayPal billing-agreement id, Square card id,
 *   Braintree payment-method nonce, Authorize.Net customer-payment
 *   profile id) plus the display fields a UI needs to render the
 *   "ending in 4242 expires 04/27" line.
 *
 *   Safety floor: every `add()` input is screened for PAN-shaped
 *   strings (13-19 consecutive digits) and CVV-shaped fields, so an
 *   operator who accidentally wires the raw card form into this
 *   primitive gets a TypeError instead of a silent leak into the
 *   shop's database.
 *
 *   Default-uniqueness is enforced two ways:
 *     - write-side, in the primitive: `setDefault` clears the
 *       previous default in the same call before flipping the new
 *       row's `is_default = 1`.
 *     - schema-side: a partial UNIQUE index over
 *       `(customer_id) WHERE is_default = 1 AND archived_at IS NULL`
 *       refuses a second simultaneous default at the SQL tier.
 *
 *   Archive is one-way. The audit ledger records every state change
 *   (added / default_set / default_cleared / archived) so a GDPR
 *   data-subject access request can reconstruct the full lifecycle
 *   of the row.
 *
 *   Composition:
 *     var pm = bShop.paymentMethods.create({ query: q });
 *     var saved = await pm.add({
 *       customer_id:     cust.id,
 *       processor:       "stripe",
 *       processor_token: "pm_1ABC…",
 *       brand:           "visa",
 *       last4:           "4242",
 *       exp_month:       4,
 *       exp_year:        2027,
 *     });
 *     await pm.setDefault(saved.id);
 *     var def = await pm.defaultForCustomer(cust.id);
 *     await pm.archive({ payment_method_id: saved.id, reason: "customer_request" });
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var PROCESSORS = ["stripe", "paypal", "square", "braintree", "authorize_net"];
var ARCHIVE_REASONS = ["customer_request", "expired", "replaced", "fraud", "operator"];
var AUDIT_EVENTS = ["added", "default_set", "default_cleared", "archived"];

var MAX_TOKEN_LEN = 512;
var MAX_BRAND_LEN = 32;
var MAX_LABEL_LEN = 64;
var MAX_ACTOR_LEN = 128;

// Brand is a free-form short string. We refuse control bytes / CR /
// LF but otherwise let operators pass "visa" / "mc" / "paypal" /
// whatever their UI surfaces; this is a display field, not a
// branch-on-this dispatch key.
var BRAND_RE = /^[A-Za-z0-9 _.\-]{1,32}$/;
var LAST4_RE = /^[0-9]{4}$/;
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

// PAN screen: any field whose value is a string carrying 13-19
// consecutive ASCII digits (with or without space/dash separators
// that don't break the run) is refused outright. The regex matches
// the un-separated run — operators who pre-process a PAN with
// hyphens still trip the screen because we also collapse common
// separators before re-scanning.
var PAN_RUN_RE = /\d{13,19}/;

// UUID-shape fields are already validated as opaque identifiers by
// the `_uuid` guard. They share the digit/hyphen vocabulary the PAN
// regex screens against, so we skip the screen on a value that
// matches the canonical UUID shape — the dedicated UUID validator
// is the authoritative gate for those fields.
var UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CVV-shaped field name screen. We refuse any input key that smells
// like a CVV/CVC/CV2/CID even if its value is empty. Defensive
// against an operator passing `Object.assign({}, formData)` where
// the form had a `cvv` input.
var CVV_KEY_RE = /^(?:cvv|cvc|cv2|cid|card_security_code|security_code)$/i;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("paymentMethods: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _processor(p) {
  if (typeof p !== "string" || PROCESSORS.indexOf(p) === -1) {
    throw new TypeError("paymentMethods: processor must be one of " + PROCESSORS.join(", "));
  }
  return p;
}

function _archiveReason(r) {
  if (typeof r !== "string" || ARCHIVE_REASONS.indexOf(r) === -1) {
    throw new TypeError("paymentMethods: reason must be one of " + ARCHIVE_REASONS.join(", "));
  }
  return r;
}

function _last4(s) {
  if (typeof s !== "string" || !LAST4_RE.test(s)) {
    throw new TypeError("paymentMethods: last4 must be exactly 4 ASCII digits");
  }
  return s;
}

function _brand(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("paymentMethods: brand must be a non-empty string");
  }
  if (s.length > MAX_BRAND_LEN) {
    throw new TypeError("paymentMethods: brand must be <= " + MAX_BRAND_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("paymentMethods: brand contains control bytes");
  }
  if (!BRAND_RE.test(s)) {
    throw new TypeError("paymentMethods: brand contains characters outside [A-Za-z0-9 _.-]");
  }
  return s;
}

function _label(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("paymentMethods: label must be a non-empty string when provided");
  }
  if (s.length > MAX_LABEL_LEN) {
    throw new TypeError("paymentMethods: label must be <= " + MAX_LABEL_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("paymentMethods: label contains control bytes");
  }
  return s;
}

function _token(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("paymentMethods: processor_token must be a non-empty string");
  }
  if (s.length > MAX_TOKEN_LEN) {
    throw new TypeError("paymentMethods: processor_token must be <= " + MAX_TOKEN_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("paymentMethods: processor_token contains control bytes");
  }
  return s;
}

function _expMonth(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 12) {
    throw new TypeError("paymentMethods: exp_month must be an integer in 1..12");
  }
  return n;
}

function _expYear(n) {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new TypeError("paymentMethods: exp_year must be an integer");
  }
  var nowYear = new Date().getUTCFullYear();
  if (n < nowYear) {
    throw new TypeError("paymentMethods: exp_year must be >= current year (" + nowYear + ")");
  }
  return n;
}

function _actor(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("paymentMethods: actor must be a non-empty string when provided");
  }
  if (s.length > MAX_ACTOR_LEN) {
    throw new TypeError("paymentMethods: actor must be <= " + MAX_ACTOR_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("paymentMethods: actor contains control bytes");
  }
  return s;
}

// Walk every (key, value) on the operator-supplied input and refuse
// anything that smells like a raw PAN or a CVV. The walk is
// shallow — only top-level string values on a plain object are
// inspected, which is the entire shape `add()` accepts. We collapse
// runs of spaces / hyphens before re-checking so a "4242-4242-4242-
// 4242" entry still trips the screen.
function _screenForRawCard(input) {
  if (!input || typeof input !== "object") return;
  var keys = Object.keys(input);
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (CVV_KEY_RE.test(k)) {
      throw new TypeError("paymentMethods: refused CVV-shaped field '" + k + "' — raw card data must never reach this primitive");
    }
    var v = input[k];
    if (typeof v !== "string") continue;
    // UUID-shape values are screened by `_uuid` further down; skip
    // the PAN regex on them so a UUIDv7 whose hex happens to hold
    // a long numeric run doesn't trip the operator-error refusal.
    if (UUID_SHAPE_RE.test(v)) continue;
    if (PAN_RUN_RE.test(v)) {
      throw new TypeError("paymentMethods: refused PAN-shaped digit run in field '" + k + "' — raw card data must never reach this primitive");
    }
    var collapsed = v.replace(/[\s\-]/g, "");
    if (collapsed !== v && PAN_RUN_RE.test(collapsed)) {
      throw new TypeError("paymentMethods: refused PAN-shaped digit run in field '" + k + "' — raw card data must never reach this primitive");
    }
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  async function _audit(paymentMethodId, event, ts, actor, reason) {
    var auditId = _b().uuid.v7();
    await query(
      "INSERT INTO payment_method_audit (id, payment_method_id, event, occurred_at, actor, reason) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [auditId, paymentMethodId, event, ts, actor || null, reason || null],
    );
    return auditId;
  }

  return {
    PROCESSORS:      PROCESSORS,
    ARCHIVE_REASONS: ARCHIVE_REASONS,
    AUDIT_EVENTS:    AUDIT_EVENTS,

    add: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentMethods.add: input object required");
      }
      // PAN / CVV screen runs FIRST so a misuse is refused before
      // we touch any of the validated fields.
      _screenForRawCard(input);

      var customerId = _uuid(input.customer_id, "customer_id");
      var processor  = _processor(input.processor);
      var token      = _token(input.processor_token);
      var brand      = _brand(input.brand);
      var last4      = _last4(input.last4);
      var expMonth   = _expMonth(input.exp_month);
      var expYear    = _expYear(input.exp_year);
      var label      = _label(input.label);
      var actor      = _actor(input.actor);

      var billingAddressId = null;
      if (input.billing_address_id != null) {
        billingAddressId = _uuid(input.billing_address_id, "billing_address_id");
      }

      var id = _b().uuid.v7();
      var ts = _now();

      try {
        await query(
          "INSERT INTO payment_methods (id, customer_id, processor, processor_token, brand, last4, " +
          "exp_month, exp_year, billing_address_id, label, is_default, archived_at, archive_reason, " +
          "created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, NULL, NULL, ?11, ?11)",
          [id, customerId, processor, token, brand, last4, expMonth, expYear, billingAddressId, label, ts],
        );
      } catch (e) {
        // Unique-violation on (processor, processor_token) — the
        // same processor token cannot be saved twice. Surface as a
        // typed error so the caller can present an idempotent
        // "already on file" message instead of a generic 500.
        var msg = (e && e.message) || "";
        if (/UNIQUE|unique/.test(msg) && /processor_token|processor,/.test(msg + "")) {
          var dup = new Error("paymentMethods.add: processor_token already saved for this processor");
          dup.code = "PAYMENT_METHOD_DUPLICATE_TOKEN";
          throw dup;
        }
        throw e;
      }

      await _audit(id, "added", ts, actor, null);

      return {
        id:                 id,
        customer_id:        customerId,
        processor:          processor,
        brand:              brand,
        last4:              last4,
        exp_month:          expMonth,
        exp_year:           expYear,
        billing_address_id: billingAddressId,
        label:              label,
        is_default:         false,
        archived_at:        null,
        archive_reason:     null,
        created_at:         ts,
        updated_at:         ts,
      };
    },

    get: async function (paymentMethodId) {
      _uuid(paymentMethodId, "payment_method_id");
      var r = await query(
        "SELECT * FROM payment_methods WHERE id = ?1",
        [paymentMethodId],
      );
      if (!r.rows.length) return null;
      return r.rows[0];
    },

    listForCustomer: async function (customerId, opts2) {
      _uuid(customerId, "customer_id");
      opts2 = opts2 || {};
      var sql;
      if (opts2.include_archived) {
        sql = "SELECT * FROM payment_methods WHERE customer_id = ?1 " +
              "ORDER BY is_default DESC, created_at DESC";
      } else {
        sql = "SELECT * FROM payment_methods WHERE customer_id = ?1 AND archived_at IS NULL " +
              "ORDER BY is_default DESC, created_at DESC";
      }
      var r = await query(sql, [customerId]);
      return r.rows;
    },

    setDefault: async function (paymentMethodId, opts3) {
      _uuid(paymentMethodId, "payment_method_id");
      opts3 = opts3 || {};
      var actor = _actor(opts3.actor);

      var r = await query(
        "SELECT id, customer_id, archived_at, is_default FROM payment_methods WHERE id = ?1",
        [paymentMethodId],
      );
      if (!r.rows.length) {
        var miss = new Error("paymentMethods.setDefault: payment method not found");
        miss.code = "PAYMENT_METHOD_NOT_FOUND";
        throw miss;
      }
      var row = r.rows[0];
      if (row.archived_at != null) {
        var arch = new Error("paymentMethods.setDefault: payment method is archived");
        arch.code = "PAYMENT_METHOD_ARCHIVED";
        throw arch;
      }
      if (row.is_default === 1) {
        // Already default — no-op, no audit churn.
        return { id: row.id, customer_id: row.customer_id, is_default: true, changed: false };
      }

      var ts = _now();

      // Two-step write-side default movement. The partial UNIQUE
      // index forbids two live defaults so we must clear the
      // sibling FIRST, then set the new one. We capture the sibling
      // id (if any) for the audit ledger before clearing it.
      var sib = await query(
        "SELECT id FROM payment_methods WHERE customer_id = ?1 AND is_default = 1 AND archived_at IS NULL AND id <> ?2",
        [row.customer_id, paymentMethodId],
      );

      if (sib.rows.length) {
        await query(
          "UPDATE payment_methods SET is_default = 0, updated_at = ?1 " +
          "WHERE customer_id = ?2 AND is_default = 1 AND archived_at IS NULL AND id <> ?3",
          [ts, row.customer_id, paymentMethodId],
        );
        for (var i = 0; i < sib.rows.length; i += 1) {
          await _audit(sib.rows[i].id, "default_cleared", ts, actor, null);
        }
      }

      await query(
        "UPDATE payment_methods SET is_default = 1, updated_at = ?1 WHERE id = ?2",
        [ts, paymentMethodId],
      );
      await _audit(paymentMethodId, "default_set", ts, actor, null);

      return { id: paymentMethodId, customer_id: row.customer_id, is_default: true, changed: true };
    },

    archive: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentMethods.archive: input object required");
      }
      _uuid(input.payment_method_id, "payment_method_id");
      var reason = _archiveReason(input.reason);
      var actor  = _actor(input.actor);

      var r = await query(
        "SELECT id, archived_at, is_default FROM payment_methods WHERE id = ?1",
        [input.payment_method_id],
      );
      if (!r.rows.length) {
        var miss = new Error("paymentMethods.archive: payment method not found");
        miss.code = "PAYMENT_METHOD_NOT_FOUND";
        throw miss;
      }
      var row = r.rows[0];
      if (row.archived_at != null) {
        // Idempotent — already archived; return the row as-is.
        var existing = await query(
          "SELECT * FROM payment_methods WHERE id = ?1",
          [input.payment_method_id],
        );
        return existing.rows[0] || null;
      }

      var ts = _now();
      // Drop the default flag in the same UPDATE so the partial
      // UNIQUE index never sees a "default + archived" row state
      // that would block a future setDefault on a sibling.
      await query(
        "UPDATE payment_methods SET archived_at = ?1, archive_reason = ?2, is_default = 0, updated_at = ?1 " +
        "WHERE id = ?3",
        [ts, reason, input.payment_method_id],
      );
      await _audit(input.payment_method_id, "archived", ts, actor, reason);

      var after = await query(
        "SELECT * FROM payment_methods WHERE id = ?1",
        [input.payment_method_id],
      );
      return after.rows[0] || null;
    },

    markExpired: async function (opts4) {
      opts4 = opts4 || {};
      var actor = _actor(opts4.actor);

      var now = new Date();
      var nowYear  = now.getUTCFullYear();
      var nowMonth = now.getUTCMonth() + 1;
      var ts = _now();

      // SELECT first so we can write per-row audit entries —
      // markExpired is scheduler-callable and runs at low rate, so
      // the SELECT-then-UPDATE pair is acceptable; archive flow
      // through the same primitive surface guarantees a partial
      // crash leaves no orphan row state (a row archived without
      // its audit entry is still safe — the next sweep skips it
      // because archived_at IS NULL filter).
      var stale = await query(
        "SELECT id FROM payment_methods " +
        "WHERE archived_at IS NULL AND (exp_year < ?1 OR (exp_year = ?1 AND exp_month < ?2))",
        [nowYear, nowMonth],
      );

      var ids = stale.rows.map(function (r2) { return r2.id; });
      for (var i = 0; i < ids.length; i += 1) {
        await query(
          "UPDATE payment_methods SET archived_at = ?1, archive_reason = 'expired', is_default = 0, updated_at = ?1 " +
          "WHERE id = ?2 AND archived_at IS NULL",
          [ts, ids[i]],
        );
        await _audit(ids[i], "archived", ts, actor, "expired");
      }

      return { archived_count: ids.length, archived_ids: ids };
    },

    defaultForCustomer: async function (customerId) {
      _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT * FROM payment_methods WHERE customer_id = ?1 AND is_default = 1 AND archived_at IS NULL",
        [customerId],
      );
      return r.rows[0] || null;
    },

    byProcessorToken: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentMethods.byProcessorToken: input object required");
      }
      var processor = _processor(input.processor);
      var token     = _token(input.processor_token);
      var r = await query(
        "SELECT * FROM payment_methods WHERE processor = ?1 AND processor_token = ?2",
        [processor, token],
      );
      return r.rows[0] || null;
    },

    audit: async function (paymentMethodId) {
      _uuid(paymentMethodId, "payment_method_id");
      var r = await query(
        "SELECT * FROM payment_method_audit WHERE payment_method_id = ?1 ORDER BY occurred_at ASC, id ASC",
        [paymentMethodId],
      );
      return r.rows;
    },
  };
}

module.exports = {
  create:          create,
  PROCESSORS:      PROCESSORS,
  ARCHIVE_REASONS: ARCHIVE_REASONS,
  AUDIT_EVENTS:    AUDIT_EVENTS,
};
