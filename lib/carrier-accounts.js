"use strict";
/**
 * @module shop.carrierAccounts
 * @title  Carrier accounts — per-operator API credentials for shipping
 *         carriers (UPS, FedEx, USPS, DHL, Canada Post, Royal Mail,
 *         Australia Post)
 *
 * @intro
 *   Every operator who prints a real shipping label needs a credentialed
 *   account on a carrier's API. This primitive holds those credentials
 *   at rest — but never in plaintext. On `defineAccount` the framework
 *   namespace-hashes every secret column
 *   (`account_number` / `api_key` / `api_secret` / `meter_number`)
 *   via `b.crypto.namespaceHash("carrier-account-<field>", raw)` and
 *   returns the plaintext bundle to the caller exactly once. The
 *   operator stores those plaintext values in their downstream label
 *   worker's secret store; subsequent reads of the row only ever see
 *   the hashes. The non-secret `ship_from_address_json` round-trips
 *   intact.
 *
 *   Rotation:
 *
 *     `rotateCredentials({ account_id })` mints a fresh `api_key` +
 *     `api_secret`, returns them to the caller exactly once, and slides
 *     the old `api_key_hash` into `api_key_previous_hash`. The row's
 *     status flips to `rotating` so `verifyCredentials` accepts EITHER
 *     hash for the next 24h (`ROTATION_GRACE_MS`). After that window
 *     the operator's worker is expected to have reloaded; the previous
 *     hash is no longer accepted and any caller still holding it gets
 *     a verify miss. Operators flip the row back to `active` by
 *     calling `defineAccount` again with the new label / address (a
 *     no-op semantic) — or simply leave it in `rotating`, since the
 *     primitive's verify accepts either hash during the grace and only
 *     the live hash after.
 *
 *   Verification:
 *
 *     `verifyCredentials({ account_id, plaintext_key })` hashes the
 *     supplied value under the `carrier-account-api-key` namespace and
 *     routes the hex digest through `b.crypto.timingSafeEqual` against
 *     `api_key_hash` (always) and `api_key_previous_hash` (only when
 *     the row is `rotating` AND `now - rotated_at` is within the 24h
 *     grace). The compare is constant-time so an attacker who can time
 *     the verify can't distinguish "wrong key" from "key matches
 *     previous but grace expired."
 *
 *   Usage telemetry:
 *
 *     `recordUsage({ account_id, operation, success, ms_elapsed })`
 *     appends to `carrier_usage_log`; `metricsForAccount({ account_id,
 *     from, to })` aggregates the window into
 *     `{ requests, successes, failures, success_rate, p50_ms, p95_ms,
 *       avg_ms }`. The percentile is computed against the sorted
 *     `ms_elapsed` column of the matched rows; the operator's
 *     observability surface reads from this without joining a separate
 *     event log.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash`   — per-field SHA3-512 of every
 *                                    plaintext credential before
 *                                    storage.
 *     - `b.crypto.generateBytes`   — 32-byte uniform draw rendered as
 *                                    URL-safe base64 (no padding) for
 *                                    the fresh api_key / api_secret on
 *                                    rotation.
 *     - `b.crypto.timingSafeEqual` — constant-time hex compare on
 *                                    verifyCredentials.
 *     - `b.guardUuid`              — UUID-shape gate on every
 *                                    account_id at the entry point.
 *     - `b.uuid.v7`                — row ids (lexicographic + monotonic
 *                                    so ties on created_at still sort
 *                                    deterministically).
 *
 *   Surface:
 *     defineAccount({ carrier, account_number, api_key, api_secret?,
 *                     meter_number?, account_label?, ship_from_address })
 *     getAccount(account_id)
 *     accountByCarrier({ carrier, label? })
 *     listAccounts({ carrier?, active_only? })
 *     rotateCredentials({ account_id })
 *     disableAccount({ account_id, reason })
 *     enableAccount({ account_id })
 *     verifyCredentials({ account_id, plaintext_key })
 *     recordUsage({ account_id, operation, success, ms_elapsed })
 *     metricsForAccount({ account_id, from, to })
 *
 *   Storage:
 *     - `carrier_accounts` + `carrier_usage_log` (migration
 *       `0191_carrier_accounts.sql`).
 *
 * @primitive carrierAccounts
 * @related   b.crypto, b.guardUuid, b.uuid
 */

var CARRIERS = Object.freeze([
  "ups", "fedex", "usps", "dhl",
  "canada_post", "royal_mail", "australia_post",
]);

var STATUSES = Object.freeze(["active", "disabled", "rotating"]);

// Framework handle (the vendored blamejs); index.js re-exports this as .framework.
var b = require("./vendor/blamejs");

var ROTATION_GRACE_MS = b.constants.TIME.days(1);

var NS_ACCOUNT_NUMBER = "carrier-account-account-number";
var NS_API_KEY        = "carrier-account-api-key";
var NS_API_SECRET     = "carrier-account-api-secret";
var NS_METER_NUMBER   = "carrier-account-meter-number";

var SECRET_BYTE_LEN   = 32;

var MAX_LABEL_LEN     = 120;
var MAX_REASON_LEN    = 280;
var MAX_OPERATION_LEN = 64;
var MAX_NORMALISED    = 12;
var MIN_ACCOUNT_LEN   = 1;
var MAX_ACCOUNT_LEN   = 64;
var MIN_KEY_LEN       = 8;
var MAX_KEY_LEN       = 512;

// Control-byte / zero-width sweep on every operator-supplied label /
// reason / operation string. These columns surface on operator
// dashboards and inline into log lines — embedded control bytes are a
// slipping-class for header injection + visual spoofing.
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE   = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// account_number alphabet — operators occasionally space-pad or
// hyphenate the printed form; we accept alnum + dash + space + dot and
// strip whitespace / dashes for the normalised display column. The
// alphabet is conservative so a typo'd punctuation byte is loud at the
// boundary rather than persisting silently.
var ACCOUNT_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/;

// api_key / api_secret alphabet — carrier API keys are routinely
// base64 / base64url / hex / dot-segmented JWTs. Conservative gate:
// printable ASCII excluding whitespace; the column itself never
// surfaces (only the hash does) so we don't lose much by being strict.
var API_KEY_RE = /^[\x21-\x7e]+$/;

var OPERATION_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven rotations + disables can land in the same millisecond
// on fast machines (rotate immediately followed by recordUsage in a
// test, for instance). Bumping by 1ms on a tie keeps the timeline
// strictly increasing so a sort-by-timestamp read returns the events in
// the order they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("carrier-accounts: " + label + " — " +
      (e && e.message || "invalid UUID"));
  }
}

function _carrier(s) {
  if (typeof s !== "string" || CARRIERS.indexOf(s) === -1) {
    throw new TypeError("carrier-accounts: carrier must be one of " +
      CARRIERS.join(", ") + ", got " + JSON.stringify(s));
  }
  return s;
}

function _accountNumber(s) {
  if (typeof s !== "string") {
    throw new TypeError("carrier-accounts: account_number must be a string");
  }
  if (s.length < MIN_ACCOUNT_LEN || s.length > MAX_ACCOUNT_LEN) {
    throw new TypeError("carrier-accounts: account_number must be " +
      MIN_ACCOUNT_LEN + ".." + MAX_ACCOUNT_LEN + " characters");
  }
  if (!ACCOUNT_NUMBER_RE.test(s)) {
    throw new TypeError("carrier-accounts: account_number must match alnum + space/dot/dash");
  }
  return s;
}

function _normaliseAccountNumber(s) {
  // Strip whitespace + dashes + dots so the on-disk display column is
  // a stable visible-digits string. CHECK(length <= 12) on storage
  // refuses leaking more than the longest known carrier format.
  var stripped = s.replace(/[\s.-]/g, "");
  if (stripped.length === 0) {
    throw new TypeError("carrier-accounts: account_number normalises to empty (only punctuation?)");
  }
  if (stripped.length > MAX_NORMALISED) {
    // Visible display column caps at the longest known carrier format
    // (DHL/USPS 9-10 digit). We keep the trailing N chars so the
    // operator's UI shows the suffix they recognise.
    stripped = stripped.slice(stripped.length - MAX_NORMALISED);
  }
  return stripped;
}

function _apiKey(s, label) {
  label = label || "api_key";
  if (typeof s !== "string") {
    throw new TypeError("carrier-accounts: " + label + " must be a string");
  }
  if (s.length < MIN_KEY_LEN || s.length > MAX_KEY_LEN) {
    throw new TypeError("carrier-accounts: " + label + " must be " +
      MIN_KEY_LEN + ".." + MAX_KEY_LEN + " characters");
  }
  if (!API_KEY_RE.test(s)) {
    throw new TypeError("carrier-accounts: " + label +
      " must contain only printable ASCII excluding whitespace");
  }
  return s;
}

function _label(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("carrier-accounts: account_label must be a string or null");
  }
  if (s.length === 0 || s.length > MAX_LABEL_LEN) {
    throw new TypeError("carrier-accounts: account_label must be 1.." + MAX_LABEL_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("carrier-accounts: account_label contains control / zero-width bytes");
  }
  return s;
}

function _reason(s) {
  if (typeof s !== "string") {
    throw new TypeError("carrier-accounts: reason must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("carrier-accounts: reason must be non-empty after trim");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("carrier-accounts: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("carrier-accounts: reason contains control / zero-width bytes");
  }
  return s;
}

function _operation(s) {
  if (typeof s !== "string") {
    throw new TypeError("carrier-accounts: operation must be a string");
  }
  if (s.length === 0 || s.length > MAX_OPERATION_LEN) {
    throw new TypeError("carrier-accounts: operation must be 1.." +
      MAX_OPERATION_LEN + " characters");
  }
  if (!OPERATION_RE.test(s)) {
    throw new TypeError("carrier-accounts: operation must match /^[a-z0-9][a-z0-9._:-]*$/");
  }
  return s;
}

function _msEpoch(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("carrier-accounts: " + label +
      " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("carrier-accounts: " + label +
      " must be a non-negative integer");
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("carrier-accounts: " + label + " must be a boolean");
  }
  return v;
}

function _shipFromAddress(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    throw new TypeError("carrier-accounts: ship_from_address must be an object");
  }
  if (typeof a.line1 !== "string" || a.line1.length === 0 || a.line1.length > 200) {
    throw new TypeError("carrier-accounts: ship_from_address.line1 must be a non-empty string ≤ 200 chars");
  }
  if (typeof a.city !== "string" || a.city.length === 0 || a.city.length > 100) {
    throw new TypeError("carrier-accounts: ship_from_address.city must be a non-empty string ≤ 100 chars");
  }
  if (typeof a.country !== "string" || a.country.length !== 2) {
    throw new TypeError("carrier-accounts: ship_from_address.country must be a 2-letter ISO code");
  }
  // JSON round-trip check — operator may add region / postal /
  // company / phone. We don't enforce shape beyond the three required
  // bits; the address_json contract is "round-trips cleanly through
  // JSON.parse(JSON.stringify(...))".
  try { JSON.parse(JSON.stringify(a)); }
  catch (_e) { throw new TypeError("carrier-accounts: ship_from_address must be JSON-serialisable"); }
  return a;
}

// ---- secret generation + hashing ---------------------------------------

// 32 bytes -> 43 chars base64url (no padding). Used for rotated api_key
// / api_secret. Routes through `b.crypto.toBase64Url` (linear-time
// Node built-in `base64url` encoding) instead of the polynomial-
// ReDoS-shaped `.replace(/=+$/, "")` strip.
function _generateSecret() {
  var buf = b.crypto.generateBytes(SECRET_BYTE_LEN);
  return b.crypto.toBase64Url(buf);
}

function _hashAccountNumber(plain) {
  return b.crypto.namespaceHash(NS_ACCOUNT_NUMBER, plain);
}
function _hashApiKey(plain) {
  return b.crypto.namespaceHash(NS_API_KEY, plain);
}
function _hashApiSecret(plain) {
  return b.crypto.namespaceHash(NS_API_SECRET, plain);
}
function _hashMeterNumber(plain) {
  return b.crypto.namespaceHash(NS_METER_NUMBER, plain);
}

// ---- percentile --------------------------------------------------------

function _percentile(sorted, p) {
  if (!sorted.length) return 0;
  // Nearest-rank percentile against the sorted array. p in [0..1].
  var idx = Math.ceil(p * sorted.length) - 1;
  if (idx < 0) idx = 0;
  if (idx >= sorted.length) idx = sorted.length - 1;
  return sorted[idx];
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM carrier_accounts WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  function _project(row) {
    if (!row) return null;
    return {
      id:                        row.id,
      carrier:                   row.carrier,
      account_label:             row.account_label,
      account_number_hash:       row.account_number_hash,
      account_number_normalised: row.account_number_normalised,
      api_key_hash:              row.api_key_hash,
      api_key_previous_hash:     row.api_key_previous_hash,
      api_secret_hash:           row.api_secret_hash,
      meter_number_hash:         row.meter_number_hash,
      ship_from_address:         _parseAddressJSON(row.ship_from_address_json),
      status:                    row.status,
      disabled_reason:           row.disabled_reason,
      disabled_at:               row.disabled_at != null ? Number(row.disabled_at) : null,
      rotated_at:                row.rotated_at  != null ? Number(row.rotated_at)  : null,
      created_at:                Number(row.created_at),
      updated_at:                Number(row.updated_at),
      active:                    row.status === "active",
    };
  }

  function _parseAddressJSON(raw) {
    if (raw == null) return null;
    try {
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : null;
    } catch (_e) {
      // Drop-silent — the write path always serialises a validated
      // object, so a parse failure means the row was hand-edited.
      // Surfacing as null keeps the caller's downstream code from
      // crashing on a corrupted row.
      return null;
    }
  }

  return {

    CARRIERS:          CARRIERS,
    STATUSES:          STATUSES,
    ROTATION_GRACE_MS: ROTATION_GRACE_MS,
    NS_ACCOUNT_NUMBER: NS_ACCOUNT_NUMBER,
    NS_API_KEY:        NS_API_KEY,
    NS_API_SECRET:     NS_API_SECRET,
    NS_METER_NUMBER:   NS_METER_NUMBER,

    // Register a carrier account. Hashes every secret column at the
    // boundary; the plaintext returns to the caller exactly once on
    // the return value (the operator hands it to their label worker's
    // secret store). Subsequent reads only see the hash. The
    // (carrier, account_label) tuple is the natural lookup key —
    // re-defining the same pair updates the row in place.
    defineAccount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.defineAccount: input object required");
      }
      var carrier   = _carrier(input.carrier);
      var rawAcct   = _accountNumber(input.account_number);
      var normAcct  = _normaliseAccountNumber(rawAcct);
      var apiKey    = _apiKey(input.api_key, "api_key");
      var apiSecret = null;
      if (input.api_secret != null) apiSecret = _apiKey(input.api_secret, "api_secret");
      var meter = null;
      if (input.meter_number != null) {
        // meter numbers are short alnum strings — reuse the
        // account-number alphabet so a typo'd char is loud.
        meter = _accountNumber(input.meter_number);
      }
      var label = _label(input.account_label);
      _shipFromAddress(input.ship_from_address);

      var now    = _now();
      var hashAN = _hashAccountNumber(rawAcct);
      var hashAK = _hashApiKey(apiKey);
      var hashAS = apiSecret != null ? _hashApiSecret(apiSecret) : null;
      var hashMN = meter     != null ? _hashMeterNumber(meter)   : null;
      var addrJson = JSON.stringify(input.ship_from_address);

      // Upsert on (carrier, account_label). The label may be NULL,
      // which collapses every unlabelled row for a given carrier into
      // a single "primary" account — operators with multiple
      // production accounts must label them. SQLite's UNIQUE doesn't
      // enforce equality on NULL, so we do the lookup manually.
      var lookup = await query(
        label == null
          ? "SELECT * FROM carrier_accounts WHERE carrier = ?1 AND account_label IS NULL"
          : "SELECT * FROM carrier_accounts WHERE carrier = ?1 AND account_label = ?2",
        label == null ? [carrier] : [carrier, label],
      );
      var existing = lookup.rows[0] || null;

      var id;
      if (existing) {
        id = existing.id;
        await query(
          "UPDATE carrier_accounts SET account_number_hash = ?1, " +
          "account_number_normalised = ?2, api_key_hash = ?3, " +
          "api_key_previous_hash = NULL, api_secret_hash = ?4, " +
          "meter_number_hash = ?5, ship_from_address_json = ?6, " +
          "status = 'active', disabled_reason = NULL, disabled_at = NULL, " +
          "rotated_at = NULL, updated_at = ?7 WHERE id = ?8",
          [hashAN, normAcct, hashAK, hashAS, hashMN, addrJson, now, id],
        );
      } else {
        id = b.uuid.v7();
        await query(
          "INSERT INTO carrier_accounts " +
          "(id, carrier, account_label, account_number_hash, " +
          " account_number_normalised, api_key_hash, api_key_previous_hash, " +
          " api_secret_hash, meter_number_hash, ship_from_address_json, " +
          " status, disabled_reason, disabled_at, rotated_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, 'active', NULL, " +
          " NULL, NULL, ?10, ?11)",
          [id, carrier, label, hashAN, normAcct, hashAK, hashAS, hashMN,
            addrJson, now, now],
        );
      }

      var projected = _project(await _getRaw(id));
      // The plaintext bundle is returned ONCE alongside the projected
      // row. Subsequent reads via getAccount / listAccounts return
      // only the hashes — the operator hands the plaintext directly
      // to their downstream label worker's secret store.
      projected.plaintext = {
        account_number: rawAcct,
        api_key:        apiKey,
        api_secret:     apiSecret,
        meter_number:   meter,
      };
      return projected;
    },

    getAccount: async function (accountId) {
      var id = _uuid(accountId, "account_id");
      return _project(await _getRaw(id));
    },

    // Lookup by (carrier, label?). When label is omitted, returns the
    // unlabelled "primary" row for the carrier — operators with
    // multiple labelled accounts must pass `label`.
    accountByCarrier: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.accountByCarrier: input object required");
      }
      var carrier = _carrier(input.carrier);
      var label   = _label(input.label);
      var r = await query(
        label == null
          ? "SELECT * FROM carrier_accounts WHERE carrier = ?1 AND account_label IS NULL"
          : "SELECT * FROM carrier_accounts WHERE carrier = ?1 AND account_label = ?2",
        label == null ? [carrier] : [carrier, label],
      );
      return _project(r.rows[0] || null);
    },

    listAccounts: async function (listOpts) {
      listOpts = listOpts || {};
      var clauses = [];
      var params  = [];
      var idx     = 1;
      if (listOpts.carrier != null) {
        clauses.push("carrier = ?" + idx);
        params.push(_carrier(listOpts.carrier));
        idx += 1;
      }
      if (listOpts.active_only != null) {
        _bool(listOpts.active_only, "active_only");
        if (listOpts.active_only) {
          clauses.push("status = ?" + idx);
          params.push("active");
          idx += 1;
        }
      }
      var sql = "SELECT * FROM carrier_accounts";
      if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
      sql += " ORDER BY carrier ASC, account_label ASC, id ASC";
      var r = await query(sql, params);
      return r.rows.map(_project);
    },

    // Rotate api_key + api_secret. Returns the fresh plaintext pair
    // exactly once; slides the old api_key_hash into
    // api_key_previous_hash so deployed workers running the old key
    // keep verifying for the 24h grace. The row's status flips to
    // `rotating` to advertise the grace window. A disabled row
    // refuses to rotate — re-enable it first.
    rotateCredentials: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.rotateCredentials: input object required");
      }
      var id = _uuid(input.account_id, "account_id");
      var current = await _getRaw(id);
      if (!current) {
        var miss = new Error("carrier-accounts.rotateCredentials: account not found");
        miss.code = "CARRIER_ACCOUNT_NOT_FOUND";
        throw miss;
      }
      if (current.status === "disabled") {
        var refused = new Error(
          "carrier-accounts.rotateCredentials: refused — account is disabled"
        );
        refused.code = "CARRIER_ACCOUNT_DISABLED";
        throw refused;
      }

      var newKey    = _generateSecret();
      var newSecret = _generateSecret();
      var hashKey   = _hashApiKey(newKey);
      var hashSec   = _hashApiSecret(newSecret);
      var prevHash  = current.api_key_hash;
      var now       = _now();

      await query(
        "UPDATE carrier_accounts SET api_key_hash = ?1, " +
        "api_key_previous_hash = ?2, api_secret_hash = ?3, " +
        "status = 'rotating', rotated_at = ?4, updated_at = ?5 " +
        "WHERE id = ?6",
        [hashKey, prevHash, hashSec, now, now, id],
      );

      var projected = _project(await _getRaw(id));
      projected.plaintext = {
        api_key:           newKey,
        api_secret:        newSecret,
      };
      projected.rotation_grace_ms = ROTATION_GRACE_MS;
      return projected;
    },

    disableAccount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.disableAccount: input object required");
      }
      var id  = _uuid(input.account_id, "account_id");
      var why = _reason(input.reason);
      var current = await _getRaw(id);
      if (!current) {
        var miss = new Error("carrier-accounts.disableAccount: account not found");
        miss.code = "CARRIER_ACCOUNT_NOT_FOUND";
        throw miss;
      }
      if (current.status === "disabled") {
        // Idempotent — re-disable returns the existing row.
        return _project(current);
      }
      var now = _now();
      await query(
        "UPDATE carrier_accounts SET status = 'disabled', " +
        "disabled_reason = ?1, disabled_at = ?2, " +
        "api_key_previous_hash = NULL, rotated_at = NULL, updated_at = ?3 " +
        "WHERE id = ?4",
        [why, now, now, id],
      );
      return _project(await _getRaw(id));
    },

    enableAccount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.enableAccount: input object required");
      }
      var id = _uuid(input.account_id, "account_id");
      var current = await _getRaw(id);
      if (!current) {
        var miss = new Error("carrier-accounts.enableAccount: account not found");
        miss.code = "CARRIER_ACCOUNT_NOT_FOUND";
        throw miss;
      }
      if (current.status === "active") {
        return _project(current);
      }
      var now = _now();
      await query(
        "UPDATE carrier_accounts SET status = 'active', " +
        "disabled_reason = NULL, disabled_at = NULL, updated_at = ?1 " +
        "WHERE id = ?2",
        [now, id],
      );
      return _project(await _getRaw(id));
    },

    // Constant-time hex compare. Match against `api_key_hash` always;
    // additionally match against `api_key_previous_hash` when the row
    // is `rotating` AND `now - rotated_at` is within the 24h grace.
    // Disabled rows refuse immediately.
    verifyCredentials: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.verifyCredentials: input object required");
      }
      var id = _uuid(input.account_id, "account_id");
      _apiKey(input.plaintext_key, "plaintext_key");

      var current = await _getRaw(id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.status === "disabled") return { ok: false, reason: "disabled" };

      var supplied = _hashApiKey(input.plaintext_key);
      var live     = b.crypto.timingSafeEqual(current.api_key_hash, supplied);
      if (live) {
        return { ok: true, matched: "live", account_id: id };
      }

      // Previous-hash branch only kicks in for rotating rows within
      // the grace window. The branch reads `rotated_at` and the
      // previous hash before deciding to call `timingSafeEqual` —
      // the live-hash compare above always runs first, so a verify
      // miss on a non-rotating row takes the same path regardless of
      // status.
      var prev = current.api_key_previous_hash;
      var now;
      if (input.now != null) now = _msEpoch(input.now, "now");
      else                   now = _now();

      var rotatedAt = current.rotated_at != null ? Number(current.rotated_at) : 0;
      var withinGrace = current.status === "rotating" &&
                        rotatedAt > 0 &&
                        (now - rotatedAt) <= ROTATION_GRACE_MS;

      if (prev != null && withinGrace) {
        var matchedPrev = b.crypto.timingSafeEqual(prev, supplied);
        if (matchedPrev) {
          return { ok: true, matched: "previous", account_id: id,
            grace_expires_at: rotatedAt + ROTATION_GRACE_MS };
        }
      }
      return { ok: false, reason: "mismatch" };
    },

    // Append-only usage row. The route layer calls this on every
    // carrier API request — success / failure / latency feed the
    // metricsForAccount aggregation downstream.
    recordUsage: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.recordUsage: input object required");
      }
      var id = _uuid(input.account_id, "account_id");
      _operation(input.operation);
      if (typeof input.success !== "boolean") {
        throw new TypeError("carrier-accounts.recordUsage: success must be a boolean");
      }
      _nonNegInt(input.ms_elapsed, "ms_elapsed");

      var current = await _getRaw(id);
      if (!current) {
        var miss = new Error("carrier-accounts.recordUsage: account not found");
        miss.code = "CARRIER_ACCOUNT_NOT_FOUND";
        throw miss;
      }
      var ts    = _now();
      var rowId = b.uuid.v7();
      await query(
        "INSERT INTO carrier_usage_log (id, account_id, operation, " +
        "success, ms_elapsed, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [rowId, id, input.operation, input.success ? 1 : 0, input.ms_elapsed, ts],
      );
      return {
        id:          rowId,
        account_id:  id,
        operation:   input.operation,
        success:     input.success,
        ms_elapsed:  input.ms_elapsed,
        occurred_at: ts,
      };
    },

    // Aggregate the usage log for an account over a closed window.
    // Returns request / success / failure counts, success rate, and
    // p50 / p95 / avg latency. An empty window returns zero counts
    // and zero latencies rather than NaN so the operator's
    // observability surface can render a stable shape.
    metricsForAccount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrier-accounts.metricsForAccount: input object required");
      }
      var id   = _uuid(input.account_id, "account_id");
      var from = _msEpoch(input.from, "from");
      var to   = _msEpoch(input.to, "to");
      if (from > to) {
        throw new TypeError("carrier-accounts.metricsForAccount: from must be <= to");
      }
      var r = await query(
        "SELECT success, ms_elapsed FROM carrier_usage_log " +
        "WHERE account_id = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
        "ORDER BY ms_elapsed ASC",
        [id, from, to],
      );
      var rows      = r.rows;
      var requests  = rows.length;
      var successes = 0;
      var sumMs     = 0;
      var latencies = [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (Number(row.success) === 1) successes += 1;
        var ms = Number(row.ms_elapsed);
        sumMs += ms;
        latencies.push(ms);
      }
      // The SELECT already sorted ASC on ms_elapsed, so the same
      // array is the percentile source — no second sort needed.
      var failures   = requests - successes;
      var successRate = requests > 0 ? successes / requests : 0;
      var avgMs      = requests > 0 ? sumMs / requests : 0;
      var p50        = _percentile(latencies, 0.50);
      var p95        = _percentile(latencies, 0.95);
      return {
        account_id:    id,
        from:          from,
        to:            to,
        requests:      requests,
        successes:     successes,
        failures:      failures,
        success_rate:  successRate,
        avg_ms:        avgMs,
        p50_ms:        p50,
        p95_ms:        p95,
      };
    },
  };
}

module.exports = {
  create:            create,
  CARRIERS:          CARRIERS,
  STATUSES:          STATUSES,
  ROTATION_GRACE_MS: ROTATION_GRACE_MS,
  NS_ACCOUNT_NUMBER: NS_ACCOUNT_NUMBER,
  NS_API_KEY:        NS_API_KEY,
  NS_API_SECRET:     NS_API_SECRET,
  NS_METER_NUMBER:   NS_METER_NUMBER,
};
