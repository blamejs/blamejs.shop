"use strict";
/**
 * @module shop.vendors
 * @title  Vendors primitive — multi-vendor marketplace registry +
 *         per-vendor catalog assignment + payout commission ledger
 *
 * @intro
 *   A vendor is a supplier / brand the operator drop-ships from.
 *   Distinct from `affiliates`: an affiliate is a referrer paid for
 *   driving traffic; a vendor actually ships the goods. The operator
 *   registers each vendor with a stable `slug` handle, contact info,
 *   a payout rule, and a `commission_split_bps` share of every order
 *   the vendor's SKUs appear on. Catalog SKUs are assigned to exactly
 *   one vendor via `assignSku`; the join table's UNIQUE on `sku`
 *   refuses a second vendor claiming the same SKU until the first
 *   `unassignSku`s it.
 *
 *   FSM:
 *
 *     active   <-> paused        (pauseVendor / reinstateVendor)
 *     active|paused -> archived  (archiveVendor — terminal)
 *
 *   Commission math:
 *
 *     commission_minor = floor(gross_minor * commission_split_bps / 10000)
 *
 *   `recordCommission({ vendor_slug, order_id, gross_minor, currency })`
 *   writes a pending commission row at order-completion time.
 *   `payoutsDue({ as_of })` aggregates outstanding pending commissions
 *   per vendor for the finance pipeline to drain. The finance side
 *   stamps the payout reference + status transition via the
 *   commission row's lifecycle (out of scope for this primitive's
 *   v1 surface — that's a downstream operator-driven settlement;
 *   the ledger row is the audit grain).
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — contact-email hashing under the
 *                                  "vendor-contact-email" namespace so
 *                                  the raw address never lands on disk
 *     - `b.guardEmail`           — strict-profile validate + sanitize
 *     - `b.uuid.v7`              — commission row PK (monotonic
 *                                  lexicographic so audit queries sort
 *                                  cleanly without an extra index)
 *
 *   Surface:
 *     registerVendor({ slug, name, contact_email, contact_phone?,
 *                      address?, payout_method, payout_address,
 *                      commission_split_bps, status })
 *     getVendor(slug) / vendorBySlug(slug)
 *     listVendors({ status? })
 *     updateVendor(slug, patch)
 *     pauseVendor(slug) / reinstateVendor(slug) / archiveVendor(slug)
 *     assignSku({ vendor_slug, sku }) /
 *     unassignSku({ vendor_slug, sku })
 *     vendorForSku(sku) / skusForVendor(vendor_slug)
 *     recordCommission({ vendor_slug, order_id, gross_minor, currency,
 *                        occurred_at? })
 *     payoutsDue({ as_of })
 *
 *   Storage: `migrations-d1/0084_vendors.sql` — three tables,
 *   `vendors` + `vendor_skus` + `vendor_commissions`. ON DELETE
 *   CASCADE drops the join + ledger rows when the vendor row is hard-
 *   deleted (the primitive only soft-deletes via `archiveVendor`;
 *   hard delete is an operator-side migration concern).
 *
 * @primitive vendors
 * @related   b.crypto, b.guardEmail, b.uuid, shop.affiliates
 */

var MAX_NAME_LEN            = 200;
var MAX_PAYOUT_ADDRESS_LEN  = 512;
var MAX_ADDRESS_JSON_LEN    = 4096;
var MAX_PHONE_LEN           = 32;
var MAX_SLUG_LEN            = 64;
var MAX_SKU_LEN             = 128;

var EMAIL_NAMESPACE         = "vendor-contact-email";

var PAYOUT_METHODS          = [
  "paypal", "bank_transfer", "stripe_connect", "gift_card", "store_credit",
];
var VENDOR_STATUSES         = ["active", "paused", "archived"];
var COMMISSION_STATUSES     = ["pending", "paid", "voided"];

var BPS_DENOMINATOR         = 10000;
var MAX_BPS                 = 10000;
var MAX_AMOUNT_MINOR        = 100000000000; // 1e11 — sanity cap on a
                                            // single gross_minor /
                                            // commission_minor row.

var SLUG_RE                 = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var SKU_RE                  = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var PHONE_RE                = /^\+?[1-9]\d{1,14}$/;

// Control bytes + zero-width / direction-override family. The name +
// payout_address render in operator dashboards; embedded control /
// direction-override bytes are a slipping-class for header injection
// + visual-spoofing attacks downstream. Spelled with \u-escapes so
// ESLint's no-irregular-whitespace stays happy.
var CONTROL_BYTE_STRICT_RE  = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// Mutable columns for `updateVendor(slug, patch)`. Slug is immutable
// — it's the public handle + the join-table key; mutating it would
// orphan vendor_skus + vendor_commissions rows. Contact email is
// immutable — changing it would orphan the email-hash audit trail.
// Status transitions land via pauseVendor / reinstateVendor /
// archiveVendor (each one stamps its own timestamp column).
// The patch keys are the operator-facing names, NOT raw SQL column
// names — `address` is the hydrated object, mapped to the `address_json`
// column at the write site. The friendlier surface keeps the operator
// console + the primitive's hydrated read-shape symmetric.
var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "name", "contact_phone", "address", "payout_method",
  "payout_address", "commission_split_bps",
]);

// Lazy framework handle — matches the pattern used by every other
// shop primitive; avoids the require cycle that would arise from
// importing `./index` at module-eval time.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("vendors: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("vendors: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("vendors: " + label + " must be lowercase alnum + dash, no leading/trailing dash");
  }
  return s;
}

function _sku(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("vendors: sku must be a non-empty string");
  }
  if (s.length > MAX_SKU_LEN) {
    throw new TypeError("vendors: sku must be <= " + MAX_SKU_LEN + " characters");
  }
  if (!SKU_RE.test(s)) {
    throw new TypeError("vendors: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
  }
  return s;
}

function _name(s) {
  if (typeof s !== "string") {
    throw new TypeError("vendors: name must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("vendors: name must be non-empty after trim");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError("vendors: name must be <= " + MAX_NAME_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s)) {
    throw new TypeError("vendors: name contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("vendors: name contains zero-width / direction-override bytes");
  }
  return s;
}

function _payoutMethod(s) {
  if (typeof s !== "string" || PAYOUT_METHODS.indexOf(s) === -1) {
    throw new TypeError("vendors: payout_method must be one of " + PAYOUT_METHODS.join(", "));
  }
  return s;
}

function _payoutAddress(s) {
  if (typeof s !== "string") {
    throw new TypeError("vendors: payout_address must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("vendors: payout_address must be non-empty after trim");
  }
  if (s.length > MAX_PAYOUT_ADDRESS_LEN) {
    throw new TypeError("vendors: payout_address must be <= " + MAX_PAYOUT_ADDRESS_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("vendors: payout_address contains control / zero-width bytes");
  }
  return s;
}

function _phone(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new TypeError("vendors: contact_phone must be a string or null");
  }
  var trimmed = value.trim();
  if (!trimmed.length) return null;
  if (trimmed.length > MAX_PHONE_LEN) {
    throw new TypeError("vendors: contact_phone must be <= " + MAX_PHONE_LEN + " characters");
  }
  if (!PHONE_RE.test(trimmed)) {
    throw new TypeError("vendors: contact_phone must match E.164-ish shape (^\\+?[1-9]\\d{1,14}$)");
  }
  return trimmed;
}

function _addressJson(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("vendors: address must be a plain object or null");
  }
  var encoded;
  try { encoded = JSON.stringify(value); }
  catch (_e) {
    throw new TypeError("vendors: address must be JSON-serialisable");
  }
  if (encoded.length > MAX_ADDRESS_JSON_LEN) {
    throw new TypeError("vendors: address JSON must be <= " + MAX_ADDRESS_JSON_LEN + " characters serialised");
  }
  if (CONTROL_BYTE_STRICT_RE.test(encoded) || ZERO_WIDTH_RE.test(encoded)) {
    throw new TypeError("vendors: address contains control / zero-width bytes");
  }
  return encoded;
}

function _commissionSplit(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_BPS) {
    throw new TypeError("vendors: commission_split_bps must be an integer 0.." + MAX_BPS);
  }
  return n;
}

function _vendorStatus(s) {
  if (typeof s !== "string" || VENDOR_STATUSES.indexOf(s) === -1) {
    throw new TypeError("vendors: status must be one of " + VENDOR_STATUSES.join(", "));
  }
  return s;
}

function _grossMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("vendors: gross_minor must be a non-negative integer");
  }
  if (n > MAX_AMOUNT_MINOR) {
    throw new TypeError("vendors: gross_minor must be <= " + MAX_AMOUNT_MINOR);
  }
  return n;
}

function _currency(s) {
  if (typeof s !== "string" || !/^[A-Z]{3}$/.test(s)) {
    throw new TypeError("vendors: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _orderId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("vendors: order_id must be a non-empty string");
  }
  if (s.length > 256) {
    throw new TypeError("vendors: order_id must be <= 256 characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("vendors: order_id contains control / zero-width bytes");
  }
  return s;
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("vendors: contact_email must be a non-empty string");
  }
  var guardEmail = _b().guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("vendors: contact_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("vendors: contact_email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e2) {
    throw new TypeError("vendors: contact_email — " + (e2 && e2.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _now() { return Date.now(); }

// ---- commission math ----------------------------------------------------

function _computeCommissionMinor(grossMinor, splitBps) {
  // Floor division on integers keeps the rounding consistent across
  // platforms; the operator absorbs the sub-cent dust (alternative is
  // rounding up, which lets a vendor over-claim by splitting orders).
  return Math.floor((grossMinor * splitBps) / BPS_DENOMINATOR);
}

// ---- row hydration ------------------------------------------------------

function _hydrateVendor(row) {
  if (!row) return null;
  return {
    slug:                      row.slug,
    name:                      row.name,
    contact_email_hash:        row.contact_email_hash,
    contact_email_normalised:  row.contact_email_normalised,
    contact_phone:             row.contact_phone == null ? null : row.contact_phone,
    address:                   row.address_json == null ? null : JSON.parse(row.address_json),
    payout_method:             row.payout_method,
    payout_address:            row.payout_address,
    commission_split_bps:      Number(row.commission_split_bps),
    status:                    row.status,
    paused_at:                 row.paused_at == null ? null : Number(row.paused_at),
    archived_at:               row.archived_at == null ? null : Number(row.archived_at),
    created_at:                Number(row.created_at),
    updated_at:                Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  function _hashEmail(canonicalEmail) {
    return _b().crypto.namespaceHash(EMAIL_NAMESPACE, canonicalEmail);
  }

  async function _getVendorRaw(slug) {
    var r = await query("SELECT * FROM vendors WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _getCommissionRaw(id) {
    var r = await query("SELECT * FROM vendor_commissions WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  return {
    EMAIL_NAMESPACE:         EMAIL_NAMESPACE,
    PAYOUT_METHODS:          PAYOUT_METHODS.slice(),
    VENDOR_STATUSES:         VENDOR_STATUSES.slice(),
    COMMISSION_STATUSES:     COMMISSION_STATUSES.slice(),
    MAX_NAME_LEN:            MAX_NAME_LEN,
    MAX_PAYOUT_ADDRESS_LEN:  MAX_PAYOUT_ADDRESS_LEN,
    MAX_ADDRESS_JSON_LEN:    MAX_ADDRESS_JSON_LEN,
    MAX_PHONE_LEN:           MAX_PHONE_LEN,
    MAX_SLUG_LEN:            MAX_SLUG_LEN,
    MAX_SKU_LEN:             MAX_SKU_LEN,
    BPS_DENOMINATOR:         BPS_DENOMINATOR,
    MAX_BPS:                 MAX_BPS,

    registerVendor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("vendors.registerVendor: input object required");
      }
      var slug          = _slug(input.slug, "slug");
      var name          = _name(input.name);
      var emailNorm     = _normalizeEmail(input.contact_email);
      var emailHash     = _hashEmail(emailNorm);
      var phone         = _phone(input.contact_phone);
      var addressJson   = _addressJson(input.address);
      var payoutMethod  = _payoutMethod(input.payout_method);
      var payoutAddr    = _payoutAddress(input.payout_address);
      var splitBps      = _commissionSplit(input.commission_split_bps);
      var status        = _vendorStatus(input.status);
      if (status === "archived") {
        // Refuse opening a vendor in the terminal state — archive
        // is the operator-driven soft-delete, never a registration
        // outcome. Operators register active|paused and transition
        // later via archiveVendor.
        throw new TypeError("vendors.registerVendor: status must be 'active' or 'paused' at registration");
      }

      // Slug uniqueness — PRIMARY KEY enforces it at SQL too, but
      // surfacing the refusal as a typed error is friendlier than
      // letting SQLITE_CONSTRAINT leak.
      var existing = await _getVendorRaw(slug);
      if (existing) {
        var dupe = new Error("vendors.registerVendor: slug " + JSON.stringify(slug) + " already registered");
        dupe.code = "VENDOR_SLUG_TAKEN";
        throw dupe;
      }

      var ts = _now();
      await query(
        "INSERT INTO vendors " +
        "(slug, name, contact_email_hash, contact_email_normalised, " +
        " contact_phone, address_json, payout_method, payout_address, " +
        " commission_split_bps, status, paused_at, archived_at, " +
        " created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?12)",
        [
          slug, name, emailHash, emailNorm, phone, addressJson,
          payoutMethod, payoutAddr, splitBps, status,
          status === "paused" ? ts : null, ts,
        ],
      );
      return _hydrateVendor(await _getVendorRaw(slug));
    },

    getVendor: async function (slug) {
      _slug(slug, "slug");
      return _hydrateVendor(await _getVendorRaw(slug));
    },

    // Alias — operator vocabulary keeps both names; the slug IS the
    // identifier so there's no other lookup path to disambiguate
    // against. `getVendor` and `vendorBySlug` resolve identically.
    vendorBySlug: async function (slug) {
      _slug(slug, "slug");
      return _hydrateVendor(await _getVendorRaw(slug));
    },

    listVendors: async function (listOpts) {
      listOpts = listOpts || {};
      var sql, params;
      if (listOpts.status != null) {
        var status = _vendorStatus(listOpts.status);
        sql = "SELECT * FROM vendors WHERE status = ?1 ORDER BY created_at DESC, slug ASC";
        params = [status];
      } else {
        sql = "SELECT * FROM vendors ORDER BY created_at DESC, slug ASC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows.map(_hydrateVendor);
    },

    // Patch-style update — only ALLOWED_UPDATE_COLUMNS can be set.
    // Slug + contact_email are immutable post-registration (changing
    // the slug would orphan vendor_skus + vendor_commissions; changing
    // the email would orphan the email-hash audit trail). Archived
    // vendors refuse mutation — the terminal state preserves the row
    // as-shipped for audit; operators register a successor.
    updateVendor: async function (slug, patch) {
      _slug(slug, "slug");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("vendors.updateVendor: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("vendors.updateVendor: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError("vendors.updateVendor: column '" + keys[i] + "' not updatable");
        }
      }

      var current = await _getVendorRaw(slug);
      if (!current) return null;
      if (current.status === "archived") {
        var refused = new Error("vendors.updateVendor: refused — vendor is archived");
        refused.code = "VENDOR_ARCHIVED";
        throw refused;
      }

      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (patch.name != null)                 _set("name",                 _name(patch.name));
      if (Object.prototype.hasOwnProperty.call(patch, "contact_phone")) _set("contact_phone",       _phone(patch.contact_phone));
      if (Object.prototype.hasOwnProperty.call(patch, "address"))       _set("address_json",         _addressJson(patch.address));
      if (patch.payout_method != null)        _set("payout_method",        _payoutMethod(patch.payout_method));
      if (patch.payout_address != null)       _set("payout_address",       _payoutAddress(patch.payout_address));
      if (patch.commission_split_bps != null) _set("commission_split_bps", _commissionSplit(patch.commission_split_bps));

      var ts = _now();
      _set("updated_at", ts);
      params.push(slug);
      var sql = "UPDATE vendors SET " + sets.join(", ") + " WHERE slug = ?" + idx;
      await query(sql, params);
      return _hydrateVendor(await _getVendorRaw(slug));
    },

    // FSM: active -> paused. Refuses if already paused (idempotency
    // hazard — second call would overwrite paused_at and lose the
    // original pause timestamp) or archived (terminal).
    pauseVendor: async function (slug) {
      _slug(slug, "slug");
      var current = await _getVendorRaw(slug);
      if (!current) return null;
      if (current.status === "paused") {
        var already = new Error("vendors.pauseVendor: refused — vendor is already paused");
        already.code = "VENDOR_TRANSITION_REFUSED";
        throw already;
      }
      if (current.status === "archived") {
        var arch = new Error("vendors.pauseVendor: refused — vendor is archived");
        arch.code = "VENDOR_TRANSITION_REFUSED";
        throw arch;
      }
      var ts = _now();
      await query(
        "UPDATE vendors SET status = 'paused', paused_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return _hydrateVendor(await _getVendorRaw(slug));
    },

    // FSM: paused -> active. Refuses if active (no-op) or archived
    // (terminal). Clears paused_at so the audit trail records the
    // most recent pause window only — operator can rebuild full
    // history from the operator-audit-log primitive if needed.
    reinstateVendor: async function (slug) {
      _slug(slug, "slug");
      var current = await _getVendorRaw(slug);
      if (!current) return null;
      if (current.status === "active") {
        var already = new Error("vendors.reinstateVendor: refused — vendor is already active");
        already.code = "VENDOR_TRANSITION_REFUSED";
        throw already;
      }
      if (current.status === "archived") {
        var arch = new Error("vendors.reinstateVendor: refused — vendor is archived");
        arch.code = "VENDOR_TRANSITION_REFUSED";
        throw arch;
      }
      var ts = _now();
      await query(
        "UPDATE vendors SET status = 'active', paused_at = NULL, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return _hydrateVendor(await _getVendorRaw(slug));
    },

    // FSM: active|paused -> archived (terminal). Refuses if already
    // archived. Historical vendor_skus + vendor_commissions rows are
    // preserved — the FK constraint cascades only on hard-delete,
    // which this primitive never performs.
    archiveVendor: async function (slug) {
      _slug(slug, "slug");
      var current = await _getVendorRaw(slug);
      if (!current) return null;
      if (current.status === "archived") {
        var already = new Error("vendors.archiveVendor: refused — vendor is already archived");
        already.code = "VENDOR_TRANSITION_REFUSED";
        throw already;
      }
      var ts = _now();
      await query(
        "UPDATE vendors SET status = 'archived', archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return _hydrateVendor(await _getVendorRaw(slug));
    },

    // Assign a SKU to a vendor. The join table's UNIQUE on `sku`
    // enforces single-vendor ownership — a second `assignSku` for the
    // same SKU (whether to the same or a different vendor) refuses.
    // Operators must `unassignSku` first. Archived vendors refuse new
    // assignments; paused vendors are allowed (a pause is a temporary
    // halt, not an inventory unhook — the operator may be onboarding
    // SKUs while KYC clears).
    assignSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("vendors.assignSku: input object required");
      }
      var vendorSlug = _slug(input.vendor_slug, "vendor_slug");
      var sku        = _sku(input.sku);

      var vendor = await _getVendorRaw(vendorSlug);
      if (!vendor) {
        var miss = new Error("vendors.assignSku: vendor not found");
        miss.code = "VENDOR_NOT_FOUND";
        throw miss;
      }
      if (vendor.status === "archived") {
        var arch = new Error("vendors.assignSku: refused — vendor is archived");
        arch.code = "VENDOR_ARCHIVED";
        throw arch;
      }

      // Surface the UNIQUE refusal as a typed error rather than
      // leaking SQLITE_CONSTRAINT. The check-then-insert is racy on
      // a real D1; the SQL UNIQUE is the actual enforcement and the
      // caller catches both code paths via the typed error below.
      var existing = await query(
        "SELECT vendor_slug FROM vendor_skus WHERE sku = ?1", [sku],
      );
      if (existing.rows.length) {
        var taken = new Error(
          "vendors.assignSku: sku " + JSON.stringify(sku) +
          " is already assigned to vendor " + JSON.stringify(existing.rows[0].vendor_slug)
        );
        taken.code = "VENDOR_SKU_TAKEN";
        throw taken;
      }

      var ts = _now();
      try {
        await query(
          "INSERT INTO vendor_skus (vendor_slug, sku, assigned_at) VALUES (?1, ?2, ?3)",
          [vendorSlug, sku, ts],
        );
      } catch (e) {
        if (e && e.message && e.message.indexOf("UNIQUE") !== -1) {
          var raced = new Error("vendors.assignSku: sku " + JSON.stringify(sku) + " is already assigned");
          raced.code = "VENDOR_SKU_TAKEN";
          throw raced;
        }
        throw e;
      }
      return {
        vendor_slug: vendorSlug,
        sku:         sku,
        assigned_at: ts,
      };
    },

    // Remove the (vendor, sku) assignment. Returns true when a row
    // was removed; false when no such assignment existed (idempotent
    // — unassigning twice is a no-op rather than a refusal). The
    // vendor_slug guard ensures an operator can't unassign someone
    // else's SKU by SKU alone — the call must match the owning
    // vendor.
    unassignSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("vendors.unassignSku: input object required");
      }
      var vendorSlug = _slug(input.vendor_slug, "vendor_slug");
      var sku        = _sku(input.sku);
      var r = await query(
        "DELETE FROM vendor_skus WHERE vendor_slug = ?1 AND sku = ?2",
        [vendorSlug, sku],
      );
      return Number(r.rowCount || 0) > 0;
    },

    // Lookup which vendor (if any) owns a given SKU. Returns the
    // hydrated vendor row, or null when the SKU is unassigned. The
    // join hits the UNIQUE index on `sku` so this is O(log n).
    vendorForSku: async function (sku) {
      _sku(sku);
      var r = await query(
        "SELECT v.* FROM vendor_skus s JOIN vendors v ON v.slug = s.vendor_slug WHERE s.sku = ?1",
        [sku],
      );
      return _hydrateVendor(r.rows[0]);
    },

    // List every SKU assigned to a vendor, newest assignment first.
    // Returns the raw `{ sku, assigned_at }` rows rather than
    // joining the catalog — the operator console will hydrate
    // product titles on its own page.
    skusForVendor: async function (vendorSlug) {
      _slug(vendorSlug, "vendor_slug");
      var r = await query(
        "SELECT sku, assigned_at FROM vendor_skus WHERE vendor_slug = ?1 " +
        "ORDER BY assigned_at DESC, sku ASC",
        [vendorSlug],
      );
      return r.rows.map(function (row) {
        return { sku: row.sku, assigned_at: Number(row.assigned_at) };
      });
    },

    // Write a commission row at order-completion time. The
    // commission_minor is computed at write time from the vendor's
    // *current* commission_split_bps; the row preserves the resolved
    // amount so a later operator-side rate change doesn't
    // retroactively alter historical payouts. Idempotent on
    // (vendor_slug, order_id) — a second call returns the existing
    // row's snapshot. Archived vendors refuse new commission writes
    // — the historical ledger is closed.
    recordCommission: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("vendors.recordCommission: input object required");
      }
      var vendorSlug = _slug(input.vendor_slug, "vendor_slug");
      var orderId    = _orderId(input.order_id);
      var grossMinor = _grossMinor(input.gross_minor);
      var currency   = _currency(input.currency);
      var occurredAt;
      if (input.occurred_at != null) {
        if (!Number.isInteger(input.occurred_at) || input.occurred_at < 0) {
          throw new TypeError("vendors.recordCommission: occurred_at must be a non-negative integer (ms epoch)");
        }
        occurredAt = input.occurred_at;
      } else {
        occurredAt = _now();
      }

      var vendor = await _getVendorRaw(vendorSlug);
      if (!vendor) {
        var miss = new Error("vendors.recordCommission: vendor not found");
        miss.code = "VENDOR_NOT_FOUND";
        throw miss;
      }
      if (vendor.status === "archived") {
        var arch = new Error("vendors.recordCommission: refused — vendor is archived");
        arch.code = "VENDOR_ARCHIVED";
        throw arch;
      }

      // Idempotency on (vendor_slug, order_id) — surfaced via the
      // UNIQUE index. A retried checkout finalisation lands on the
      // same row.
      var dupe = await query(
        "SELECT * FROM vendor_commissions WHERE vendor_slug = ?1 AND order_id = ?2",
        [vendorSlug, orderId],
      );
      if (dupe.rows.length) {
        return dupe.rows[0];
      }

      var commissionMinor = _computeCommissionMinor(
        grossMinor, Number(vendor.commission_split_bps)
      );

      var id = _b().uuid.v7();
      await query(
        "INSERT INTO vendor_commissions " +
        "(id, vendor_slug, order_id, gross_minor, commission_minor, " +
        " currency, status, occurred_at, paid_at, payout_reference) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, NULL, NULL)",
        [id, vendorSlug, orderId, grossMinor, commissionMinor, currency, occurredAt],
      );
      return await _getCommissionRaw(id);
    },

    // Operator finance dashboard — which vendors are owed as of
    // `as_of`. Returns one row per vendor whose sum-of-pending
    // commissions (occurred_at <= as_of) is > 0, with `pending_minor`
    // total + commission count. Sorted by pending_minor DESC so the
    // largest payout lands at the top. Archived vendors still appear
    // if they have outstanding pending rows — the operator must drain
    // the ledger before considering the relationship fully closed.
    payoutsDue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("vendors.payoutsDue: input object required");
      }
      if (!Number.isInteger(input.as_of) || input.as_of < 0) {
        throw new TypeError("vendors.payoutsDue: as_of must be a non-negative integer (ms epoch)");
      }
      var r = await query(
        "SELECT vendor_slug, SUM(commission_minor) AS pending_minor, COUNT(*) AS commission_count " +
        "FROM vendor_commissions " +
        "WHERE status = 'pending' AND occurred_at <= ?1 " +
        "GROUP BY vendor_slug " +
        "HAVING SUM(commission_minor) > 0 " +
        "ORDER BY pending_minor DESC, vendor_slug ASC",
        [input.as_of],
      );
      return r.rows.map(function (row) {
        return {
          vendor_slug:      row.vendor_slug,
          pending_minor:    Number(row.pending_minor || 0),
          commission_count: Number(row.commission_count || 0),
        };
      });
    },
  };
}

module.exports = {
  create:                  create,
  EMAIL_NAMESPACE:         EMAIL_NAMESPACE,
  PAYOUT_METHODS:          PAYOUT_METHODS.slice(),
  VENDOR_STATUSES:         VENDOR_STATUSES.slice(),
  COMMISSION_STATUSES:     COMMISSION_STATUSES.slice(),
  MAX_NAME_LEN:            MAX_NAME_LEN,
  MAX_PAYOUT_ADDRESS_LEN:  MAX_PAYOUT_ADDRESS_LEN,
  MAX_ADDRESS_JSON_LEN:    MAX_ADDRESS_JSON_LEN,
  MAX_PHONE_LEN:           MAX_PHONE_LEN,
  MAX_SLUG_LEN:            MAX_SLUG_LEN,
  MAX_SKU_LEN:             MAX_SKU_LEN,
  BPS_DENOMINATOR:         BPS_DENOMINATOR,
  MAX_BPS:                 MAX_BPS,
};
