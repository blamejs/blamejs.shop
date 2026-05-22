/**
 * Wishlist — customers save products (or specific variants) for
 * later. The storefront PDP renders an "Add to wishlist" toggle that
 * resolves through `isWishlisted` + `add` / `remove`; the account
 * page renders the customer's saved items via `listForCustomer`; and
 * the "X people saved this" social-proof counter on the PDP reads
 * `countForProduct`. The home page / category page surfaces a
 * "Most-wishlisted" rail via `popularProducts`.
 *
 * Composes:
 *   - `b.guardUuid` — every customer / product / variant id is
 *     UUID-shape-validated at the entry point. The primitive itself
 *     never trusts an opaque string; the guard refuses on shape and
 *     surfaces a TypeError that the storefront translates to a 400.
 *   - `b.crypto.namespaceHash` — not used for row identity (the row
 *     id is a UUIDv7 from `b.uuid.v7`); reserved for forthcoming
 *     follower / shared-wishlist features that need a deterministic
 *     handle without leaking customer ids.
 *   - `b.uuid.v7` — row id.
 *   - `b.pagination.encodeCursor` / `decodeCursor` — HMAC-tagged
 *     opaque cursor on the `(created_at DESC, id DESC)` tuple so an
 *     operator can't hand-craft a cursor to skip past a hidden row
 *     or replay one across deployments.
 *
 * Surface:
 *   - `add({ customer_id, product_id, variant_id?, notes? })` —
 *     INSERT OR IGNORE on the unique (customer, product, variant)
 *     tuple; returns `{ id, status: "added" | "dedup" }`.
 *   - `remove({ customer_id, product_id, variant_id? })` — DELETE
 *     the matching row; returns `{ removed: boolean }`.
 *   - `listForCustomer(customer_id, { limit?, cursor? })` —
 *     paginated entries scoped to one customer; returns
 *     `{ rows, nextCursor }`.
 *   - `isWishlisted({ customer_id, product_id, variant_id? })` —
 *     boolean lookup used by the PDP toggle.
 *   - `countForProduct(product_id)` — how many customers wishlisted
 *     this product (variant-collapsed — counts distinct customers).
 *   - `popularProducts({ limit? })` — `[ { product_id, count } ]`
 *     sorted by count desc, used for the "Most-wishlisted" rail.
 *
 * Storage:
 *   - `wishlist_entries` (migration `0012_wishlist.sql`).
 *
 * @primitive wishlist
 * @related   b.guardUuid, b.pagination, b.uuid
 */

"use strict";

var MAX_NOTES_LEN  = 280;
var DEFAULT_LIMIT  = 20;
var MAX_LIMIT      = 100;
var POPULAR_LIMIT  = 50;
var WISHLIST_ORDER_KEY = ["created_at:desc", "id:desc"];

// Lazy framework handle — matches the pattern used by the rest of
// the shop primitives; avoids the require cycle that would arise
// from importing `./index` at module-eval time.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("wishlist: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _optUuid(s, label) {
  if (s == null || s === "") return null;
  return _uuid(s, label);
}

function _normalizeNotes(s) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("wishlist: notes must be a string");
  }
  // Refuse control bytes (incl. CR/LF) so a malicious note can't
  // smuggle header-injection-class content into operator dashboards
  // or downstream email templates that render the note inline.
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("wishlist: notes must not contain control bytes");
  }
  if (s.length > MAX_NOTES_LEN) {
    throw new TypeError("wishlist: notes must be <= " + MAX_NOTES_LEN + " chars");
  }
  return s;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("wishlist: " + label + " must be 1..." + MAX_LIMIT);
  }
  return n;
}

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Pagination cursors for listForCustomer are HMAC-tagged via
  // b.pagination so an operator can't hand-craft one to skip past a
  // hidden entry or replay across deployments. The secret defaults
  // to a dev-only placeholder so the primitive boots in tests; the
  // deployment is expected to supply a derived value (typically
  // b.crypto.namespaceHash("wishlist-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("wishlist.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "wishlist-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  return {
    MAX_NOTES_LEN: MAX_NOTES_LEN,

    add: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("wishlist.add: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var productId  = _uuid(input.product_id,  "product_id");
      var variantId  = _optUuid(input.variant_id, "variant_id");
      var notes      = _normalizeNotes(input.notes);
      var now        = Date.now();
      var id         = _b().uuid.v7();

      // Idempotent insert — re-running with the same
      // (customer, product, variant) tuple is a no-op on the storage
      // side. The SELECT after the INSERT-OR-IGNORE tells us which
      // one happened so the caller can distinguish "this just got
      // added" from "we already had this entry" for UI copy.
      await query(
        "INSERT OR IGNORE INTO wishlist_entries " +
        "(id, customer_id, product_id, variant_id, notes, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, customerId, productId, variantId, notes, now],
      );
      var existing = (await query(
        "SELECT id FROM wishlist_entries " +
        "WHERE customer_id = ?1 AND product_id = ?2 " +
        "AND COALESCE(variant_id, '') = COALESCE(?3, '') LIMIT 1",
        [customerId, productId, variantId],
      )).rows[0];
      var status = existing && existing.id === id ? "added" : "dedup";
      return {
        id:     existing ? existing.id : id,
        status: status,
      };
    },

    remove: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("wishlist.remove: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var productId  = _uuid(input.product_id,  "product_id");
      var variantId  = _optUuid(input.variant_id, "variant_id");
      var r = await query(
        "DELETE FROM wishlist_entries " +
        "WHERE customer_id = ?1 AND product_id = ?2 " +
        "AND COALESCE(variant_id, '') = COALESCE(?3, '')",
        [customerId, productId, variantId],
      );
      return { removed: Number(r.rowCount || 0) > 0 };
    },

    listForCustomer: async function (customerId, listOpts) {
      var cid = _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      var limit = _limit(listOpts.limit, "limit");
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("wishlist.listForCustomer: cursor must be an opaque string or null");
        }
        try {
          var state = _b().pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(WISHLIST_ORDER_KEY)) {
            throw new TypeError("wishlist.listForCustomer: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("wishlist.listForCustomer: cursor — " + (e && e.message || "malformed"));
        }
      }
      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM wishlist_entries WHERE customer_id = ?1 AND " +
              "(created_at < ?2 OR (created_at = ?2 AND id < ?3)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?4";
        params = [cid, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM wishlist_entries WHERE customer_id = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [cid, limit];
      }
      var rows = (await query(sql, params)).rows;
      var last = rows[rows.length - 1];
      var nextCursor = null;
      if (last && rows.length === limit) {
        nextCursor = _b().pagination.encodeCursor({
          orderKey: WISHLIST_ORDER_KEY,
          vals:     [last.created_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, nextCursor: nextCursor };
    },

    isWishlisted: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("wishlist.isWishlisted: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var productId  = _uuid(input.product_id,  "product_id");
      var variantId  = _optUuid(input.variant_id, "variant_id");
      var r = await query(
        "SELECT id FROM wishlist_entries " +
        "WHERE customer_id = ?1 AND product_id = ?2 " +
        "AND COALESCE(variant_id, '') = COALESCE(?3, '') LIMIT 1",
        [customerId, productId, variantId],
      );
      return r.rows.length > 0;
    },

    countForProduct: async function (productId) {
      var pid = _uuid(productId, "product_id");
      var r = await query(
        "SELECT COUNT(DISTINCT customer_id) AS n FROM wishlist_entries WHERE product_id = ?1",
        [pid],
      );
      return Number((r.rows[0] || {}).n || 0);
    },

    popularProducts: async function (popOpts) {
      popOpts = popOpts || {};
      var limit = popOpts.limit == null ? POPULAR_LIMIT
                                        : _limit(popOpts.limit, "limit");
      var rows = (await query(
        "SELECT product_id, COUNT(DISTINCT customer_id) AS count " +
        "FROM wishlist_entries " +
        "GROUP BY product_id " +
        "ORDER BY count DESC, product_id ASC " +
        "LIMIT ?1",
        [limit],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({
          product_id: rows[i].product_id,
          count:      Number(rows[i].count),
        });
      }
      return out;
    },
  };
}

module.exports = {
  create: create,
};
