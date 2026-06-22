"use strict";
/**
 * @module shop.shippingInsurance
 * @title  Shipping insurance — per-shipment third-party parcel insurance
 *
 * @intro
 *   Per-shipment insurance via Shipsurance / Loop / U-PIC / Route.
 *   The customer opts in for high-value packages at checkout; the
 *   storefront calls `quoteInsurance` against the operator-registered
 *   provider to get the premium, then `purchaseInsurance` to mint the
 *   row + snapshot the premium. The carrier never sees the
 *   insurance — it's a parallel agreement between the customer, the
 *   operator, and the insurer.
 *
 *   The framework does NOT call Shipsurance / Loop / U-PIC / Route
 *   APIs directly. Each insurer has its own auth + endpoint + claim
 *   portal; the operator's worker drives the integration and calls
 *   back into this primitive (`purchaseInsurance` with the minted
 *   external_policy_id; `markClaimApproved` / `markClaimDenied`
 *   with the insurer's decision). The primitive owns the lifecycle
 *   bookkeeping, the premium-quote math, and the claim FSM.
 *
 *   Premium math: `premium = max(premium_min_minor,
 *   ceil(declared_value_minor * premium_rate_bps / 10000))`. Basis
 *   points (1/100ths of a percent) carry zero floating-point
 *   surprise — the calculation is integer-only and rounds up on
 *   half-cent so the insurer is never short. The provider's floor
 *   (`premium_min_minor`) prevents a $1 declared parcel from
 *   computing a 0-cent premium.
 *
 *   Insurance FSM:
 *
 *     active --cancelInsurance--> cancelled   (terminal)
 *     active --(post claim_window)--> expired (terminal)
 *
 *   Claim FSM:
 *
 *     filed --markClaimApproved--> approved   (terminal)
 *     filed --markClaimDenied--> denied       (terminal)
 *
 *   Filing a claim requires the parent insurance to be `active` AND
 *   the current monotonic clock to be on/before
 *   `claim_window_ends_at`. Once the window elapses the insurance is
 *   `expired` and no new claims may be filed; existing `filed` claims
 *   are still resolvable (the insurer's review may take longer than
 *   the customer's filing window).
 *
 *   Composes:
 *     - `b.guardUuid`         — strict UUID gate on every order_id /
 *                                shipment_id / customer_id / insurance_id /
 *                                claim_id at the entry point.
 *     - `b.uuid.v7`           — row ids (lexicographic + monotonic so
 *                                ties on created_at still sort
 *                                deterministically).
 *     - `shippingLabels` (optional) — when wired, `quoteInsurance({
 *                                shipment_id })` uses `labelsForShipment`
 *                                to verify the shipment has a label
 *                                before quoting. Absent, callers may
 *                                quote against any shipment_id (the
 *                                operator's storefront is responsible
 *                                for the existence check).
 *
 *   Surface:
 *     - defineProvider({ code, name, premium_rate_bps,
 *                        premium_min_minor, min_declared_value_minor,
 *                        max_declared_value_minor, claim_window_days,
 *                        currency, active? })
 *     - quoteInsurance({ provider_code, declared_value_minor,
 *                        currency, shipment_id? })
 *     - purchaseInsurance({ provider_code, shipment_id, order_id,
 *                           customer_id, declared_value_minor, currency,
 *                           external_policy_id? })
 *     - fileClaim({ insurance_id, claim_type, claimed_amount_minor,
 *                   evidence? })
 *     - markClaimApproved({ claim_id, payout_minor })
 *     - markClaimDenied({ claim_id, denial_reason })
 *     - getInsurance(insurance_id)
 *     - insurancesForOrder(order_id)
 *     - claimsForInsurance(insurance_id)
 *     - metricsForProvider({ provider_code, from, to })
 *
 *   Storage:
 *     - insurance_providers, shipping_insurances, insurance_claims
 *       (migration `0166_shipping_insurance.sql`).
 *
 *   Monotonic clock: operator-driven FSM transitions can land in the
 *   same millisecond on fast machines (markClaimApproved on a freshly
 *   filed claim in a test, for instance). Bumping by 1ms on a tie
 *   keeps the timeline strictly increasing so a sort-by-timestamp
 *   read returns the events in the order they were issued.
 *
 * @primitive shippingInsurance
 * @related   b.guardUuid, b.uuid, shippingLabels, orderTracking, payment
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ---------------------------------------------------------

var CODE_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var CURRENCY_RE      = /^[A-Z]{3}$/;
var EXTERNAL_ID_RE   = /^[A-Za-z0-9][A-Za-z0-9._\-:/]{0,127}$/;
var DENIAL_REASON_RE = /^[A-Za-z0-9][A-Za-z0-9 _.,'\-]{0,279}$/;
var MAX_NAME_LEN     = 200;
var MAX_AMOUNT_MINOR = 1000000000;   // $10,000,000.00 — sane upper cap
var MAX_RATE_BPS     = 10000;        // 100% — exclusive ceiling
var MAX_CLAIM_DAYS   = 3650;         // 10 years — sane upper cap
var DAY_MS           = C.TIME.days(1);

var CLAIM_TYPES = Object.freeze(["lost", "damaged", "stolen", "not_delivered"]);
var INSURANCE_STATUSES = Object.freeze(["active", "cancelled", "expired"]);
var CLAIM_STATUSES     = Object.freeze(["filed", "approved", "denied"]);

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven FSM transitions can land in the same millisecond on
// fast machines (markClaimApproved on a freshly filed claim in a test,
// for instance). Bumping by 1ms on a tie keeps the timeline strictly
// increasing so a sort-by-timestamp read returns the events in the
// order they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("shippingInsurance: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("shippingInsurance: " + (label || "code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
  return s;
}
function _name(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_NAME_LEN) {
    throw new TypeError("shippingInsurance: name must be a non-empty string <= " + MAX_NAME_LEN + " chars");
  }
  return s;
}
function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("shippingInsurance: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}
function _amountMinor(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_AMOUNT_MINOR) {
    throw new TypeError("shippingInsurance: " + label + " must be a positive integer in [1, " + MAX_AMOUNT_MINOR + "]");
  }
  return n;
}
function _amountMinorNonNeg(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_AMOUNT_MINOR) {
    throw new TypeError("shippingInsurance: " + label + " must be a non-negative integer in [0, " + MAX_AMOUNT_MINOR + "]");
  }
  return n;
}
function _rateBps(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_RATE_BPS) {
    throw new TypeError("shippingInsurance: premium_rate_bps must be an integer in [0, " + MAX_RATE_BPS + "] (basis points)");
  }
  return n;
}
function _claimDays(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_CLAIM_DAYS) {
    throw new TypeError("shippingInsurance: claim_window_days must be an integer in [1, " + MAX_CLAIM_DAYS + "]");
  }
  return n;
}
function _claimType(s) {
  if (typeof s !== "string" || CLAIM_TYPES.indexOf(s) === -1) {
    throw new TypeError("shippingInsurance: claim_type must be one of " + CLAIM_TYPES.join(", "));
  }
  return s;
}
function _externalPolicyId(s) {
  if (typeof s !== "string" || !EXTERNAL_ID_RE.test(s)) {
    throw new TypeError("shippingInsurance: external_policy_id must match /^[A-Za-z0-9][A-Za-z0-9._\\-:/]{0,127}$/");
  }
  return s;
}
function _denialReason(s) {
  if (typeof s !== "string" || !DENIAL_REASON_RE.test(s)) {
    throw new TypeError("shippingInsurance: denial_reason must match /^[A-Za-z0-9][A-Za-z0-9 _.,'\\-]{0,279}$/");
  }
  return s;
}
function _evidence(obj) {
  if (obj == null) return {};
  if (typeof obj !== "object" || Array.isArray(obj)) {
    throw new TypeError("shippingInsurance: evidence must be a JSON-serialisable object");
  }
  try { JSON.parse(JSON.stringify(obj)); }
  catch (_e) { throw new TypeError("shippingInsurance: evidence must be JSON-serialisable"); }
  return obj;
}
function _epochMs(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("shippingInsurance: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

// ---- premium math -------------------------------------------------------
//
// premium = max(premium_min_minor,
//               ceil(declared_value_minor * premium_rate_bps / 10000))
// Integer-only; rounds up on half-cent so the insurer is never short.

function _computePremium(declaredValueMinor, premiumRateBps, premiumMinMinor) {
  // Exact BigInt ceil — declaredValueMinor and premiumRateBps are
  // integers, so a JS Number multiply would lose precision once the
  // product exceeds 2^53 (a large declared value at a high rate).
  // ceil(product / 10000) = floor((product + 9999) / 10000) for the
  // non-negative inputs here.
  var product = BigInt(declaredValueMinor) * BigInt(premiumRateBps);
  var quotient = Number((product + 9999n) / 10000n);
  if (quotient < premiumMinMinor) { quotient = premiumMinMinor; }
  return quotient;
}

// ---- hydration ---------------------------------------------------------

function _hydrateProvider(row) {
  if (!row) return null;
  return {
    code:                     row.code,
    name:                     row.name,
    premium_rate_bps:         Number(row.premium_rate_bps),
    premium_min_minor:        Number(row.premium_min_minor),
    min_declared_value_minor: Number(row.min_declared_value_minor),
    max_declared_value_minor: Number(row.max_declared_value_minor),
    claim_window_days:        Number(row.claim_window_days),
    currency:                 row.currency,
    active:                   Number(row.active) === 1,
    archived_at:              row.archived_at == null ? null : Number(row.archived_at),
    created_at:               Number(row.created_at),
    updated_at:               Number(row.updated_at),
  };
}

function _hydrateInsurance(row) {
  if (!row) return null;
  return {
    id:                    row.id,
    provider_code:         row.provider_code,
    shipment_id:           row.shipment_id,
    order_id:              row.order_id,
    customer_id:           row.customer_id,
    declared_value_minor:  Number(row.declared_value_minor),
    premium_minor:         Number(row.premium_minor),
    currency:              row.currency,
    external_policy_id:    row.external_policy_id == null ? null : row.external_policy_id,
    status:                row.status,
    claim_window_ends_at:  Number(row.claim_window_ends_at),
    cancelled_at:          row.cancelled_at == null ? null : Number(row.cancelled_at),
    expired_at:            row.expired_at == null ? null : Number(row.expired_at),
    created_at:             Number(row.created_at),
    updated_at:             Number(row.updated_at),
  };
}

function _hydrateClaim(row) {
  if (!row) return null;
  var evidence;
  try { evidence = JSON.parse(row.evidence_json || "{}"); }
  catch (_e) { evidence = {}; }
  return {
    id:                   row.id,
    insurance_id:         row.insurance_id,
    claim_type:           row.claim_type,
    status:               row.status,
    claimed_amount_minor: Number(row.claimed_amount_minor),
    payout_minor:         row.payout_minor == null ? null : Number(row.payout_minor),
    denial_reason:        row.denial_reason == null ? null : row.denial_reason,
    evidence:             evidence,
    filed_at:             Number(row.filed_at),
    resolved_at:          row.resolved_at == null ? null : Number(row.resolved_at),
    updated_at:           Number(row.updated_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // shippingLabels is optional — when wired, `quoteInsurance({
  // shipment_id })` uses `labelsForShipment` to verify the shipment
  // has a label before quoting. Refuses at boot when the handle is
  // supplied without the expected verb so a typo doesn't degrade
  // silently to "no shipment-existence check."
  var shippingLabelsHandle = opts.shippingLabels || null;
  if (shippingLabelsHandle && typeof shippingLabelsHandle.labelsForShipment !== "function") {
    throw new TypeError("shippingInsurance.create: opts.shippingLabels must expose a labelsForShipment(shipment_id) method");
  }

  async function _getProviderRow(code) {
    var r = await query("SELECT * FROM insurance_providers WHERE code = ?1", [code]);
    return r.rows.length ? r.rows[0] : null;
  }

  async function _getInsuranceRow(id) {
    var r = await query("SELECT * FROM shipping_insurances WHERE id = ?1", [id]);
    return r.rows.length ? r.rows[0] : null;
  }

  async function _getClaimRow(id) {
    var r = await query("SELECT * FROM insurance_claims WHERE id = ?1", [id]);
    return r.rows.length ? r.rows[0] : null;
  }

  async function _getInsuranceByProviderShipment(providerCode, shipmentId) {
    var r = await query(
      "SELECT * FROM shipping_insurances WHERE provider_code = ?1 AND shipment_id = ?2",
      [providerCode, shipmentId],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  // Register a third-party insurer. Upsert semantics on `code` — re-
  // defining the same code updates the row in place (operator
  // changes premium rate / window without invalidating prior
  // insurances; existing insurances carry the snapshotted premium
  // from purchase time so the customer's rate doesn't shift under
  // them). Reactivates an archived provider by clearing archived_at.
  async function defineProvider(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("shippingInsurance.defineProvider: input object required");
    }
    var code = _code(input.code, "code");
    _name(input.name);
    _rateBps(input.premium_rate_bps);
    _amountMinorNonNeg(input.premium_min_minor, "premium_min_minor");
    _amountMinorNonNeg(input.min_declared_value_minor, "min_declared_value_minor");
    _amountMinor(input.max_declared_value_minor, "max_declared_value_minor");
    if (input.max_declared_value_minor < input.min_declared_value_minor) {
      throw new TypeError("shippingInsurance.defineProvider: max_declared_value_minor must be >= min_declared_value_minor");
    }
    _claimDays(input.claim_window_days);
    _currency(input.currency);
    var active = input.active === false ? 0 : 1;

    var now = _now();
    var existing = await _getProviderRow(code);
    if (existing) {
      await query(
        "UPDATE insurance_providers SET name = ?1, premium_rate_bps = ?2, " +
        "premium_min_minor = ?3, min_declared_value_minor = ?4, " +
        "max_declared_value_minor = ?5, claim_window_days = ?6, currency = ?7, " +
        "active = ?8, archived_at = NULL, updated_at = ?9 WHERE code = ?10",
        [
          input.name, input.premium_rate_bps, input.premium_min_minor,
          input.min_declared_value_minor, input.max_declared_value_minor,
          input.claim_window_days, input.currency, active, now, code,
        ],
      );
    } else {
      await query(
        "INSERT INTO insurance_providers (code, name, premium_rate_bps, " +
        "premium_min_minor, min_declared_value_minor, max_declared_value_minor, " +
        "claim_window_days, currency, active, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        [
          code, input.name, input.premium_rate_bps, input.premium_min_minor,
          input.min_declared_value_minor, input.max_declared_value_minor,
          input.claim_window_days, input.currency, active, now,
        ],
      );
    }
    return _hydrateProvider(await _getProviderRow(code));
  }

  // Quote a premium against a provider's published rate. Pure
  // function over the provider row + declared value — does not
  // write. Refuses on archived / inactive providers, currency
  // mismatch, declared-value floor/ceiling violation. When
  // shippingLabels is wired and `shipment_id` is supplied, also
  // verifies the shipment has at least one label (the storefront's
  // checkout flow always has minted a label before offering
  // insurance; the gate catches stray callers).
  async function quoteInsurance(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("shippingInsurance.quoteInsurance: input object required");
    }
    var providerCode = _code(input.provider_code, "provider_code");
    _amountMinor(input.declared_value_minor, "declared_value_minor");
    var currency = _currency(input.currency);

    var prov = await _getProviderRow(providerCode);
    if (!prov) {
      throw new TypeError("shippingInsurance.quoteInsurance: provider_code " +
        JSON.stringify(providerCode) + " not found");
    }
    if (!Number(prov.active) || prov.archived_at != null) {
      throw new TypeError("shippingInsurance.quoteInsurance: provider_code " +
        JSON.stringify(providerCode) + " is not active");
    }
    if (prov.currency !== currency) {
      throw new TypeError("shippingInsurance.quoteInsurance: currency " + currency +
        " does not match provider currency " + prov.currency);
    }
    if (input.declared_value_minor < Number(prov.min_declared_value_minor)) {
      throw new TypeError("shippingInsurance.quoteInsurance: declared_value_minor " +
        input.declared_value_minor + " is below provider floor " + prov.min_declared_value_minor);
    }
    if (input.declared_value_minor > Number(prov.max_declared_value_minor)) {
      throw new TypeError("shippingInsurance.quoteInsurance: declared_value_minor " +
        input.declared_value_minor + " exceeds provider ceiling " + prov.max_declared_value_minor);
    }

    if (input.shipment_id != null) {
      var shipmentId = _uuid(input.shipment_id, "shipment_id");
      if (shippingLabelsHandle) {
        var labels = await shippingLabelsHandle.labelsForShipment(shipmentId);
        if (!labels || !labels.length) {
          throw new TypeError("shippingInsurance.quoteInsurance: shipment " +
            shipmentId + " has no shipping label — mint a label before quoting insurance");
        }
      }
    }

    var premium = _computePremium(
      input.declared_value_minor,
      Number(prov.premium_rate_bps),
      Number(prov.premium_min_minor),
    );
    return {
      provider_code:         providerCode,
      declared_value_minor:  input.declared_value_minor,
      premium_minor:         premium,
      currency:              currency,
      claim_window_days:     Number(prov.claim_window_days),
    };
  }

  // Mint a per-shipment insurance row. Snapshots the premium at
  // purchase time so a later provider-rate shift doesn't change
  // what the customer pays. Refuses when an insurance for the same
  // (provider, shipment) already exists (the UNIQUE constraint would
  // also catch this; the app-layer check produces a friendlier error
  // shape). external_policy_id is optional at purchase — the
  // operator's worker may call back to attach it after the
  // provider's API returns.
  async function purchaseInsurance(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("shippingInsurance.purchaseInsurance: input object required");
    }
    var providerCode = _code(input.provider_code, "provider_code");
    var shipmentId   = _uuid(input.shipment_id, "shipment_id");
    var orderId      = _uuid(input.order_id, "order_id");
    var customerId   = _uuid(input.customer_id, "customer_id");
    _amountMinor(input.declared_value_minor, "declared_value_minor");
    var currency = _currency(input.currency);
    var externalPolicyId = null;
    if (input.external_policy_id != null) {
      externalPolicyId = _externalPolicyId(input.external_policy_id);
    }

    var prov = await _getProviderRow(providerCode);
    if (!prov) {
      throw new TypeError("shippingInsurance.purchaseInsurance: provider_code " +
        JSON.stringify(providerCode) + " not found");
    }
    if (!Number(prov.active) || prov.archived_at != null) {
      throw new TypeError("shippingInsurance.purchaseInsurance: provider_code " +
        JSON.stringify(providerCode) + " is not active");
    }
    if (prov.currency !== currency) {
      throw new TypeError("shippingInsurance.purchaseInsurance: currency " + currency +
        " does not match provider currency " + prov.currency);
    }
    if (input.declared_value_minor < Number(prov.min_declared_value_minor)) {
      throw new TypeError("shippingInsurance.purchaseInsurance: declared_value_minor " +
        input.declared_value_minor + " is below provider floor " + prov.min_declared_value_minor);
    }
    if (input.declared_value_minor > Number(prov.max_declared_value_minor)) {
      throw new TypeError("shippingInsurance.purchaseInsurance: declared_value_minor " +
        input.declared_value_minor + " exceeds provider ceiling " + prov.max_declared_value_minor);
    }

    var existing = await _getInsuranceByProviderShipment(providerCode, shipmentId);
    if (existing) {
      throw new TypeError("shippingInsurance.purchaseInsurance: shipment " + shipmentId +
        " is already insured through " + providerCode +
        " (insurance_id=" + existing.id + ")");
    }

    var premium = _computePremium(
      input.declared_value_minor,
      Number(prov.premium_rate_bps),
      Number(prov.premium_min_minor),
    );
    var now = _now();
    var windowEnds = now + Number(prov.claim_window_days) * DAY_MS;
    var id = b.uuid.v7();
    await query(
      "INSERT INTO shipping_insurances (id, provider_code, shipment_id, order_id, " +
      "customer_id, declared_value_minor, premium_minor, currency, external_policy_id, " +
      "status, claim_window_ends_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?11, ?11)",
      [
        id, providerCode, shipmentId, orderId, customerId,
        input.declared_value_minor, premium, currency, externalPolicyId,
        windowEnds, now,
      ],
    );
    return _hydrateInsurance(await _getInsuranceRow(id));
  }

  // File a claim against an active insurance. Refuses on cancelled /
  // expired insurances, on a claim_window that has elapsed, and on
  // any claim_type outside the closed set. `evidence` is a JSON
  // object captured at filing time — typically photo URLs, carrier
  // scan reports, signature attestations; the primitive only gates
  // JSON round-trip, not the body shape (insurers vary).
  async function fileClaim(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("shippingInsurance.fileClaim: input object required");
    }
    var insuranceId = _uuid(input.insurance_id, "insurance_id");
    var claimType   = _claimType(input.claim_type);
    _amountMinor(input.claimed_amount_minor, "claimed_amount_minor");
    var evidence = _evidence(input.evidence);

    var ins = await _getInsuranceRow(insuranceId);
    if (!ins) {
      throw new TypeError("shippingInsurance.fileClaim: insurance " + insuranceId + " not found");
    }
    var now = _now();
    // Auto-expire on read — a claim_window that elapsed without any
    // operator activity should land as `expired` rather than silently
    // accept a stale claim. We flip the status here so the refusal
    // message is accurate; the (terminal) expired status is the same
    // a separate sweeper would produce.
    if (ins.status === "active" && now > Number(ins.claim_window_ends_at)) {
      await query(
        "UPDATE shipping_insurances SET status = 'expired', expired_at = ?1, updated_at = ?1 WHERE id = ?2",
        [now, insuranceId],
      );
      ins = await _getInsuranceRow(insuranceId);
    }
    if (ins.status !== "active") {
      throw new TypeError("shippingInsurance.fileClaim: insurance " + insuranceId +
        " is " + ins.status + ", only active insurances accept new claims");
    }
    if (input.claimed_amount_minor > Number(ins.declared_value_minor)) {
      throw new TypeError("shippingInsurance.fileClaim: claimed_amount_minor " +
        input.claimed_amount_minor + " exceeds declared_value_minor " +
        ins.declared_value_minor);
    }

    var id = b.uuid.v7();
    await query(
      "INSERT INTO insurance_claims (id, insurance_id, claim_type, status, " +
      "claimed_amount_minor, evidence_json, filed_at, updated_at) " +
      "VALUES (?1, ?2, ?3, 'filed', ?4, ?5, ?6, ?6)",
      [id, insuranceId, claimType, input.claimed_amount_minor, JSON.stringify(evidence), now],
    );
    return _hydrateClaim(await _getClaimRow(id));
  }

  // filed -> approved. Stamps payout_minor (which may differ from
  // the customer's claimed_amount_minor — the insurer's adjuster may
  // pay less than the requested amount per the provider's depreciation
  // schedule). Refuses on already-terminal rows.
  async function markClaimApproved(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("shippingInsurance.markClaimApproved: input object required");
    }
    var claimId = _uuid(input.claim_id, "claim_id");
    _amountMinor(input.payout_minor, "payout_minor");

    var claim = await _getClaimRow(claimId);
    if (!claim) {
      throw new TypeError("shippingInsurance.markClaimApproved: claim " + claimId + " not found");
    }
    if (claim.status !== "filed") {
      throw new TypeError("shippingInsurance.markClaimApproved: claim " + claimId +
        " is " + claim.status + ", only filed claims can move to approved");
    }
    var ins = await _getInsuranceRow(claim.insurance_id);
    if (!ins) {
      throw new TypeError("shippingInsurance.markClaimApproved: parent insurance " +
        claim.insurance_id + " not found for claim " + claimId);
    }
    if (input.payout_minor > Number(ins.declared_value_minor)) {
      throw new TypeError("shippingInsurance.markClaimApproved: payout_minor " +
        input.payout_minor + " exceeds declared_value_minor " +
        ins.declared_value_minor + " on the parent insurance");
    }
    var now = _now();
    // Atomic claim: the `AND status = 'filed'` predicate is the
    // serialization point. The JS check above only refuses a SEQUENTIAL
    // re-adjudication; two concurrent approve calls (a double-clicked
    // operator action, a retried insurer callback) would both read
    // 'filed' and both stamp a payout last-write-wins — two different
    // payout_minor amounts could each be recorded as THE approved payout,
    // or an approve could clobber a deny. Gating the UPDATE on the status
    // means exactly one caller transitions the row; the loser sees zero
    // rows and is refused, so one adjudication outcome sticks.
    var approvedUpd = await query(
      "UPDATE insurance_claims SET status = 'approved', payout_minor = ?1, " +
      "resolved_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'filed'",
      [input.payout_minor, now, claimId],
    );
    if (Number(approvedUpd.rowCount || 0) !== 1) {
      var racedApprove = await _getClaimRow(claimId);
      throw new TypeError("shippingInsurance.markClaimApproved: claim " + claimId +
        " is " + (racedApprove ? racedApprove.status : "gone") +
        ", only filed claims can move to approved");
    }
    return _hydrateClaim(await _getClaimRow(claimId));
  }

  // filed -> denied. Captures the operator-supplied denial_reason
  // (insurer-facing prose the customer reads on the resolution
  // notice). Refuses on already-terminal rows.
  async function markClaimDenied(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("shippingInsurance.markClaimDenied: input object required");
    }
    var claimId = _uuid(input.claim_id, "claim_id");
    var denialReason = _denialReason(input.denial_reason);

    var claim = await _getClaimRow(claimId);
    if (!claim) {
      throw new TypeError("shippingInsurance.markClaimDenied: claim " + claimId + " not found");
    }
    if (claim.status !== "filed") {
      throw new TypeError("shippingInsurance.markClaimDenied: claim " + claimId +
        " is " + claim.status + ", only filed claims can move to denied");
    }
    var now = _now();
    // Atomic claim — same race, same guard as markClaimApproved: the
    // `AND status = 'filed'` predicate serializes the two concurrent
    // callers so exactly one adjudication outcome (approve XOR deny)
    // transitions the row; the loser is refused.
    var deniedUpd = await query(
      "UPDATE insurance_claims SET status = 'denied', denial_reason = ?1, " +
      "resolved_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'filed'",
      [denialReason, now, claimId],
    );
    if (Number(deniedUpd.rowCount || 0) !== 1) {
      var racedDeny = await _getClaimRow(claimId);
      throw new TypeError("shippingInsurance.markClaimDenied: claim " + claimId +
        " is " + (racedDeny ? racedDeny.status : "gone") +
        ", only filed claims can move to denied");
    }
    return _hydrateClaim(await _getClaimRow(claimId));
  }

  async function getInsurance(insuranceId) {
    var id = _uuid(insuranceId, "insurance_id");
    return _hydrateInsurance(await _getInsuranceRow(id));
  }

  // Per-order list. An order may fan out to multiple shipments and
  // multiple insurances per shipment (belt-and-braces overlays
  // through different providers), so this read is naturally a list.
  // Ordered by created_at ASC, id ASC for deterministic iteration.
  async function insurancesForOrder(orderId) {
    var id = _uuid(orderId, "order_id");
    var rows = (await query(
      "SELECT * FROM shipping_insurances WHERE order_id = ?1 ORDER BY created_at ASC, id ASC",
      [id],
    )).rows;
    return rows.map(_hydrateInsurance);
  }

  async function claimsForInsurance(insuranceId) {
    var id = _uuid(insuranceId, "insurance_id");
    var rows = (await query(
      "SELECT * FROM insurance_claims WHERE insurance_id = ?1 ORDER BY filed_at ASC, id ASC",
      [id],
    )).rows;
    return rows.map(_hydrateClaim);
  }

  // Provider-level rollup over [from, to]. Counts active /
  // cancelled / expired insurances, total premium collected, claim
  // counts by status, and total approved payout. Operator dashboard
  // "Shipsurance performance this month" reads from here.
  async function metricsForProvider(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("shippingInsurance.metricsForProvider: input object required");
    }
    var providerCode = _code(input.provider_code, "provider_code");
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to, "to");
    if (from > to) {
      throw new TypeError("shippingInsurance.metricsForProvider: from must be <= to");
    }
    var insRows = (await query(
      "SELECT status, premium_minor FROM shipping_insurances " +
      "WHERE provider_code = ?1 AND created_at >= ?2 AND created_at <= ?3",
      [providerCode, from, to],
    )).rows;
    var activeCount = 0;
    var cancelledCount = 0;
    var expiredCount = 0;
    var totalPremium = 0;
    for (var i = 0; i < insRows.length; i += 1) {
      var r = insRows[i];
      totalPremium += Number(r.premium_minor) || 0;
      if (r.status === "active")         { activeCount += 1; }
      else if (r.status === "cancelled") { cancelledCount += 1; }
      else if (r.status === "expired")   { expiredCount += 1; }
    }

    var claimRows = (await query(
      "SELECT c.status AS status, c.payout_minor AS payout_minor " +
      "FROM insurance_claims c " +
      "JOIN shipping_insurances i ON i.id = c.insurance_id " +
      "WHERE i.provider_code = ?1 AND c.filed_at >= ?2 AND c.filed_at <= ?3",
      [providerCode, from, to],
    )).rows;
    var filedCount = 0;
    var approvedCount = 0;
    var deniedCount = 0;
    var totalPayout = 0;
    for (var j = 0; j < claimRows.length; j += 1) {
      var c = claimRows[j];
      if (c.status === "filed")         { filedCount += 1; }
      else if (c.status === "approved") { approvedCount += 1; totalPayout += Number(c.payout_minor) || 0; }
      else if (c.status === "denied")   { deniedCount += 1; }
    }

    return {
      provider_code:           providerCode,
      from:                    from,
      to:                      to,
      active_count:            activeCount,
      cancelled_count:         cancelledCount,
      expired_count:           expiredCount,
      total_premium_minor:     totalPremium,
      claims_filed_count:      filedCount,
      claims_approved_count:   approvedCount,
      claims_denied_count:     deniedCount,
      total_payout_minor:      totalPayout,
    };
  }

  return {
    CLAIM_TYPES:            CLAIM_TYPES,
    INSURANCE_STATUSES:     INSURANCE_STATUSES,
    CLAIM_STATUSES:         CLAIM_STATUSES,

    defineProvider:         defineProvider,
    quoteInsurance:         quoteInsurance,
    purchaseInsurance:      purchaseInsurance,
    fileClaim:              fileClaim,
    markClaimApproved:      markClaimApproved,
    markClaimDenied:        markClaimDenied,
    getInsurance:           getInsurance,
    insurancesForOrder:     insurancesForOrder,
    claimsForInsurance:     claimsForInsurance,
    metricsForProvider:     metricsForProvider,
  };
}

module.exports = {
  create:             create,
  CLAIM_TYPES:        CLAIM_TYPES,
  INSURANCE_STATUSES: INSURANCE_STATUSES,
  CLAIM_STATUSES:     CLAIM_STATUSES,
  MAX_AMOUNT_MINOR:   MAX_AMOUNT_MINOR,
  MAX_RATE_BPS:       MAX_RATE_BPS,
  MAX_CLAIM_DAYS:     MAX_CLAIM_DAYS,
};
