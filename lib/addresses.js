"use strict";
/**
 * @module shop.addresses
 * @title  Customer addresses primitive — saved shipping/billing book
 *
 * @intro
 *   Persistent address book attached to a customer account. One row
 *   per saved address; the customer (via the storefront) or the
 *   operator (via admin) curates the list. The primitive owns the
 *   `customer_addresses` table introduced in migration
 *   `0026_customer_addresses.sql`.
 *
 *   Composition:
 *     var addresses = bShop.addresses.create({ query: q });
 *     var row = await addresses.add({
 *       customer_id:    customer.id,
 *       recipient_name: "Jane Doe",
 *       street_line1:   "123 Main St",
 *       city:           "Springfield",
 *       postal_code:    "97001",
 *       country:        "US",
 *       is_default_shipping: true,
 *     });
 *     var ship = await addresses.defaultShipping(customer.id);
 *
 *   Default-flag uniqueness is enforced at write time inside `.add`,
 *   `.update`, `.setDefaultShipping`, and `.setDefaultBilling`. Each
 *   call clears the matching flag on the customer's other
 *   (non-archived) rows before promoting the named row, so the
 *   "is there a default shipping address?" question always resolves
 *   to zero or one row without a partial UNIQUE index.
 *
 *   `country` is ISO 3166-1 alpha-2 — two uppercase letters. The
 *   primitive enforces the character class with `/^[A-Z]{2}$/`;
 *   strict country-list membership (e.g. excluding retired codes or
 *   restricted-jurisdiction subdivisions) is operator policy and
 *   layers on top.
 *
 *   `phone` is optional E.164-ish — leading `+` is permitted, the
 *   first digit must be non-zero, and the digit run is 2-15 long.
 *   Storage is plaintext so the operator can display the number back
 *   to staff during outbound contact.
 *
 *   `is_archived` is the soft-delete flag. Archived rows are excluded
 *   from `listForCustomer` / `defaultShipping` / `defaultBilling` /
 *   `matchByContent` by default — passing `include_archived: true`
 *   to `listForCustomer` opts them back in for an admin audit.
 *   Archived rows can be promoted back via `.unarchive`.
 *
 * @related  customers, checkout
 */

var b = require("./vendor/blamejs");

var MAX_LABEL_LEN          = 64;
var MAX_RECIPIENT_NAME_LEN = 128;
var MAX_COMPANY_LEN        = 128;
var MAX_STREET_LEN         = 256;
var MAX_CITY_LEN           = 128;
var MAX_REGION_LEN         = 128;
var MAX_POSTAL_LEN         = 32;
var MAX_PHONE_LEN          = 32;

var COUNTRY_RE      = /^[A-Z]{2}$/;
var PHONE_RE        = /^\+?[1-9]\d{1,14}$/;
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("addresses: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _str(value, label, max, opts) {
  opts = opts || {};
  var required = opts.required !== false;
  if (value == null) {
    if (required) throw new TypeError("addresses: " + label + " is required");
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError("addresses: " + label + " must be a string");
  }
  var trimmed = value.trim();
  if (required && !trimmed.length) {
    throw new TypeError("addresses: " + label + " must be a non-empty string");
  }
  if (trimmed.length > max) {
    throw new TypeError("addresses: " + label + " must be <= " + max + " characters");
  }
  if (CONTROL_BYTE_RE.test(trimmed)) {
    throw new TypeError("addresses: " + label + " contains control bytes");
  }
  return trimmed;
}

function _country(value) {
  if (typeof value !== "string" || !COUNTRY_RE.test(value)) {
    throw new TypeError("addresses: country must be ISO 3166-1 alpha-2 (two uppercase letters)");
  }
  return value;
}

function _phone(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") {
    throw new TypeError("addresses: phone must be a string");
  }
  var trimmed = value.trim();
  if (!trimmed.length) return "";
  if (trimmed.length > MAX_PHONE_LEN) {
    throw new TypeError("addresses: phone must be <= " + MAX_PHONE_LEN + " characters");
  }
  if (!PHONE_RE.test(trimmed)) {
    throw new TypeError("addresses: phone must match E.164-ish shape (^\\+?[1-9]\\d{1,14}$)");
  }
  return trimmed;
}

function _bool(value, label) {
  if (value == null) return 0;
  if (value === true || value === 1)  return 1;
  if (value === false || value === 0) return 0;
  throw new TypeError("addresses: " + label + " must be a boolean");
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Clear the named default flag on every non-archived row for this
  // customer EXCEPT the optionally-excluded id. Used before promoting
  // a new default so the table's one-default-per-role invariant holds
  // without a partial UNIQUE index.
  async function _clearDefault(customerId, column, exceptId) {
    var sql =
      "UPDATE customer_addresses SET " + column + " = 0, updated_at = ?1 " +
      "WHERE customer_id = ?2 AND " + column + " = 1 AND is_archived = 0";
    var params = [_now(), customerId];
    if (exceptId) {
      sql += " AND id != ?3";
      params.push(exceptId);
    }
    await query(sql, params);
  }

  async function _getRow(id) {
    var r = await query("SELECT * FROM customer_addresses WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  return {
    add: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("addresses.add: input object required");
      }
      var customerId    = _uuid(input.customer_id, "customer_id");
      var label         = _str(input.label,         "label",         MAX_LABEL_LEN,          { required: false });
      var recipientName = _str(input.recipient_name, "recipient_name", MAX_RECIPIENT_NAME_LEN);
      var company       = _str(input.company,       "company",       MAX_COMPANY_LEN,        { required: false });
      var streetLine1   = _str(input.street_line1,  "street_line1",  MAX_STREET_LEN);
      var streetLine2   = _str(input.street_line2,  "street_line2",  MAX_STREET_LEN,         { required: false });
      var city          = _str(input.city,          "city",          MAX_CITY_LEN);
      var region        = _str(input.region,        "region",        MAX_REGION_LEN,         { required: false });
      var postalCode    = _str(input.postal_code,   "postal_code",   MAX_POSTAL_LEN);
      var country       = _country(input.country);
      var phone         = _phone(input.phone);
      var defShipping   = _bool(input.is_default_shipping, "is_default_shipping");
      var defBilling    = _bool(input.is_default_billing,  "is_default_billing");

      var id = b.uuid.v7();
      var ts = _now();

      // Clear sibling defaults FIRST so the promotion lands cleanly.
      if (defShipping) await _clearDefault(customerId, "is_default_shipping", null);
      if (defBilling)  await _clearDefault(customerId, "is_default_billing",  null);

      await query(
        "INSERT INTO customer_addresses (" +
        "  id, customer_id, label, recipient_name, company," +
        "  street_line1, street_line2, city, region, postal_code, country, phone," +
        "  is_default_shipping, is_default_billing, is_archived," +
        "  created_at, updated_at" +
        ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, ?15, ?15)",
        [
          id, customerId, label, recipientName, company,
          streetLine1, streetLine2, city, region, postalCode, country, phone,
          defShipping, defBilling, ts,
        ],
      );
      return await _getRow(id);
    },

    update: async function (addressId, patch) {
      _uuid(addressId, "address_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("addresses.update: patch object required");
      }
      var existing = await _getRow(addressId);
      if (!existing) {
        throw new TypeError("addresses.update: address " + addressId + " not found");
      }

      // Build the column list from whichever keys are actually
      // present in the patch. Each branch validates the new value
      // against the same rules `.add` applies. Keys absent from the
      // patch are left untouched.
      var sets = [];
      var params = [];
      function _push(col, val) {
        params.push(val);
        sets.push(col + " = ?" + params.length);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "label")) {
        _push("label", _str(patch.label, "label", MAX_LABEL_LEN, { required: false }));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "recipient_name")) {
        _push("recipient_name", _str(patch.recipient_name, "recipient_name", MAX_RECIPIENT_NAME_LEN));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "company")) {
        _push("company", _str(patch.company, "company", MAX_COMPANY_LEN, { required: false }));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "street_line1")) {
        _push("street_line1", _str(patch.street_line1, "street_line1", MAX_STREET_LEN));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "street_line2")) {
        _push("street_line2", _str(patch.street_line2, "street_line2", MAX_STREET_LEN, { required: false }));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "city")) {
        _push("city", _str(patch.city, "city", MAX_CITY_LEN));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "region")) {
        _push("region", _str(patch.region, "region", MAX_REGION_LEN, { required: false }));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "postal_code")) {
        _push("postal_code", _str(patch.postal_code, "postal_code", MAX_POSTAL_LEN));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "country")) {
        _push("country", _country(patch.country));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "phone")) {
        _push("phone", _phone(patch.phone));
      }

      var promoteShipping = false;
      var promoteBilling  = false;
      if (Object.prototype.hasOwnProperty.call(patch, "is_default_shipping")) {
        var ds = _bool(patch.is_default_shipping, "is_default_shipping");
        _push("is_default_shipping", ds);
        promoteShipping = ds === 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "is_default_billing")) {
        var db = _bool(patch.is_default_billing, "is_default_billing");
        _push("is_default_billing", db);
        promoteBilling = db === 1;
      }

      if (!sets.length) return existing;

      // Clear sibling defaults BEFORE the row's own update so we
      // don't accidentally clear the freshly-promoted row.
      if (promoteShipping) await _clearDefault(existing.customer_id, "is_default_shipping", addressId);
      if (promoteBilling)  await _clearDefault(existing.customer_id, "is_default_billing",  addressId);

      _push("updated_at", _now());
      params.push(addressId);
      await query(
        "UPDATE customer_addresses SET " + sets.join(", ") + " WHERE id = ?" + params.length,
        params,
      );
      return await _getRow(addressId);
    },

    get: async function (addressId) {
      _uuid(addressId, "address_id");
      return await _getRow(addressId);
    },

    // Default ordering: default-shipping rows first, then
    // default-billing, then by created_at DESC. The operator-facing
    // contract is "the customer's most recent / most-blessed
    // addresses surface at the top of an account-page render".
    listForCustomer: async function (customerId, listOpts) {
      _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      var includeArchived = listOpts.include_archived === true;
      var sql =
        "SELECT * FROM customer_addresses " +
        "WHERE customer_id = ?1" +
        (includeArchived ? "" : " AND is_archived = 0") +
        " ORDER BY is_default_shipping DESC, is_default_billing DESC, created_at DESC";
      var r = await query(sql, [customerId]);
      return r.rows;
    },

    defaultShipping: async function (customerId) {
      _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT * FROM customer_addresses " +
        "WHERE customer_id = ?1 AND is_default_shipping = 1 AND is_archived = 0 " +
        "LIMIT 1",
        [customerId],
      );
      return r.rows[0] || null;
    },

    defaultBilling: async function (customerId) {
      _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT * FROM customer_addresses " +
        "WHERE customer_id = ?1 AND is_default_billing = 1 AND is_archived = 0 " +
        "LIMIT 1",
        [customerId],
      );
      return r.rows[0] || null;
    },

    archive: async function (addressId) {
      _uuid(addressId, "address_id");
      var existing = await _getRow(addressId);
      if (!existing) return false;
      // Archiving the current default for a role also drops the flag
      // — leaving an archived row as the "default" would let the
      // listForCustomer / defaultShipping pair disagree on whether a
      // default exists.
      await query(
        "UPDATE customer_addresses SET is_archived = 1, " +
        "is_default_shipping = 0, is_default_billing = 0, updated_at = ?1 " +
        "WHERE id = ?2",
        [_now(), addressId],
      );
      return true;
    },

    unarchive: async function (addressId) {
      _uuid(addressId, "address_id");
      var existing = await _getRow(addressId);
      if (!existing) return false;
      await query(
        "UPDATE customer_addresses SET is_archived = 0, updated_at = ?1 WHERE id = ?2",
        [_now(), addressId],
      );
      return true;
    },

    setDefaultShipping: async function (addressId) {
      _uuid(addressId, "address_id");
      var existing = await _getRow(addressId);
      if (!existing) {
        throw new TypeError("addresses.setDefaultShipping: address " + addressId + " not found");
      }
      if (existing.is_archived === 1) {
        throw new TypeError("addresses.setDefaultShipping: address is archived — unarchive first");
      }
      await _clearDefault(existing.customer_id, "is_default_shipping", addressId);
      await query(
        "UPDATE customer_addresses SET is_default_shipping = 1, updated_at = ?1 WHERE id = ?2",
        [_now(), addressId],
      );
      return await _getRow(addressId);
    },

    setDefaultBilling: async function (addressId) {
      _uuid(addressId, "address_id");
      var existing = await _getRow(addressId);
      if (!existing) {
        throw new TypeError("addresses.setDefaultBilling: address " + addressId + " not found");
      }
      if (existing.is_archived === 1) {
        throw new TypeError("addresses.setDefaultBilling: address is archived — unarchive first");
      }
      await _clearDefault(existing.customer_id, "is_default_billing", addressId);
      await query(
        "UPDATE customer_addresses SET is_default_billing = 1, updated_at = ?1 WHERE id = ?2",
        [_now(), addressId],
      );
      return await _getRow(addressId);
    },

    // Operator-side dedup helper. The address book grows quickly when
    // a customer types a slight variation of an address they already
    // have saved (extra apartment number, different casing on city,
    // etc.); the storefront uses this to surface "you already have an
    // address with this postal_code + country" before the customer
    // confirms the save. Returns every non-archived row that matches
    // the customer + postal_code + country triple — the caller
    // decides whether the recipient_name / street_line1 are close
    // enough to merge.
    matchByContent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("addresses.matchByContent: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var postal     = _str(input.postal_code,  "postal_code", MAX_POSTAL_LEN);
      var country    = _country(input.country);
      var r = await query(
        "SELECT * FROM customer_addresses " +
        "WHERE customer_id = ?1 AND postal_code = ?2 AND country = ?3 AND is_archived = 0 " +
        "ORDER BY created_at DESC",
        [customerId, postal, country],
      );
      return r.rows;
    },
  };
}

module.exports = {
  create:                  create,
  MAX_LABEL_LEN:           MAX_LABEL_LEN,
  MAX_RECIPIENT_NAME_LEN:  MAX_RECIPIENT_NAME_LEN,
  MAX_COMPANY_LEN:         MAX_COMPANY_LEN,
  MAX_STREET_LEN:          MAX_STREET_LEN,
  MAX_CITY_LEN:            MAX_CITY_LEN,
  MAX_REGION_LEN:          MAX_REGION_LEN,
  MAX_POSTAL_LEN:          MAX_POSTAL_LEN,
  MAX_PHONE_LEN:           MAX_PHONE_LEN,
};
