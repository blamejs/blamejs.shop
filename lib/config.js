"use strict";
/**
 * @module shop.config
 * @title  Shop config — operator-tunable runtime configuration
 *
 * @intro
 *   Generic key/JSON-value store backed by `shop_config` in D1.
 *   Operators set values via the admin API; the storefront /
 *   checkout primitives read them at request time. Every value
 *   round-trips through `JSON.parse` at write so a corrupted blob
 *   surfaces at admin-write time rather than at customer-checkout
 *   time.
 *
 *   Conventional keys (operator-shaped, not enforced by the
 *   primitive — the storefront reads what it expects and ignores
 *   the rest):
 *
 *     tax.rules               Array<{country, state?, postal_prefix?, rate_bps}>
 *     shipping.services       Array<{id, label, zones[], free_over_minor?, digital_only?}>
 *     shipping.default_id     string
 *     shop.name               string
 *     shop.support_email      string
 *
 *   Bounded caching: each get caches the row in-memory for 30s so
 *   the checkout hot-path doesn't re-query D1 on every line item.
 *   Admin writes invalidate the cache key on success.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var KEY_RE         = /^[a-z][a-z0-9._]{0,63}$/;
var CACHE_TTL_MS   = 30 * 1000;
var MAX_VALUE_LEN  = 64 * 1024;       // 64 KiB — fits even a long jurisdiction table

function _validateKey(k) {
  if (typeof k !== "string" || !KEY_RE.test(k)) {
    throw new TypeError("config: key must match /^[a-z][a-z0-9._]{0,63}$/, got " + JSON.stringify(k));
  }
}

function _validateValue(v) {
  if (v === undefined) throw new TypeError("config: value cannot be undefined");
  var json;
  try { json = JSON.stringify(v); }
  catch (e) { throw new TypeError("config: value must be JSON-serializable — " + (e && e.message || "circular?")); }
  if (json.length > MAX_VALUE_LEN) {
    throw new TypeError("config: value JSON exceeds " + MAX_VALUE_LEN + " bytes");
  }
  // Round-trip to confirm — JSON.stringify accepts symbol-valued
  // properties by dropping them silently, etc. Re-parse to assert
  // the canonical shape the reader will see.
  try { JSON.parse(json); }
  catch (_e) { throw new TypeError("config: value did not survive round-trip through JSON.parse"); }
  return json;
}

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  var cache = new Map();  // key → { value, ts }

  return {
    get: async function (key, defaultValue) {
      _validateKey(key);
      var cached = cache.get(key);
      if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return cached.value;
      }
      var r = await query("SELECT value_json FROM shop_config WHERE key = ?1", [key]);
      if (!r.rows.length) {
        return defaultValue === undefined ? null : defaultValue;
      }
      var parsed;
      try { parsed = JSON.parse(r.rows[0].value_json); }
      catch (_e) {
        throw new Error("config: row for key " + JSON.stringify(key) + " is not valid JSON (corrupted at rest)");
      }
      cache.set(key, { value: parsed, ts: Date.now() });
      return parsed;
    },

    // get() with bounded cache bypassed — used by admin reads where
    // the operator wants to see the current persisted value.
    getFresh: async function (key, defaultValue) {
      _validateKey(key);
      cache.delete(key);
      return await this.get(key, defaultValue);
    },

    put: async function (key, value) {
      _validateKey(key);
      var json = _validateValue(value);
      var ts = Date.now();
      // UPSERT — SQLite syntax (D1 is SQLite). On conflict the
      // existing row gets bumped version + updated_at.
      await query(
        "INSERT INTO shop_config (key, value_json, version, updated_at) " +
        "VALUES (?1, ?2, 1, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "  value_json = excluded.value_json, " +
        "  version    = shop_config.version + 1, " +
        "  updated_at = excluded.updated_at",
        [key, json, ts],
      );
      cache.delete(key);
      return { key: key, updated_at: ts };
    },

    delete: async function (key) {
      _validateKey(key);
      var r = await query("DELETE FROM shop_config WHERE key = ?1", [key]);
      cache.delete(key);
      return r.rowCount > 0;
    },

    list: async function (prefix) {
      if (prefix !== undefined && prefix !== null) {
        if (typeof prefix !== "string") throw new TypeError("config.list: prefix must be a string or null");
        if (prefix.length > 64)         throw new TypeError("config.list: prefix exceeds 64 chars");
      }
      var sql, params;
      if (prefix) {
        sql = "SELECT key, value_json, version, updated_at FROM shop_config WHERE key LIKE ?1 ORDER BY key ASC";
        params = [prefix.replace(/[\\%_]/g, "\\$&") + "%"];
      } else {
        sql = "SELECT key, value_json, version, updated_at FROM shop_config ORDER BY key ASC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows.map(function (row) {
        var v;
        try { v = JSON.parse(row.value_json); } catch (_e) { v = null; }
        return { key: row.key, value: v, version: row.version, updated_at: row.updated_at };
      });
    },

    _resetCacheForTest: function () { cache.clear(); },
  };
}

module.exports = {
  create:        create,
  MAX_VALUE_LEN: MAX_VALUE_LEN,
};
