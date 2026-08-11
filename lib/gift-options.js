"use strict";
/**
 * @module shop.giftOptions
 * @title  Gift options — per-order wrap / message / recipient / hide-prices
 *
 * @intro
 *   Three independent concerns folded into one primitive because
 *   they all live on the same packing slip and clear together when
 *   the order is cancelled:
 *
 *     wrap            — operator pre-defines a catalog SKU as a
 *                       wrap option with a wrap fee. wrap_sku is a
 *                       real catalog SKU so inventory + cost flow
 *                       through the normal channels.
 *     gift_message    — short customer-authored prose (≤ 500 chars,
 *                       control-byte + zero-width-char free)
 *                       rendered on the packing slip.
 *     recipient_name  — for gift-to-someone-else orders (≤ 120
 *                       chars, same hygiene as gift_message).
 *     hide_prices     — toggle that suppresses prices on the slip
 *                       (the "gift receipt" pattern).
 *
 *   Composes:
 *     - `b.guardUuid` — order_id is UUID-shape-validated at every
 *       entry point; bad shape throws TypeError the calling route
 *       handler translates to HTTP 400.
 *     - `b.template.escapeHtml` — `renderPackingSlipLine` returns
 *       HTML-escaped strings ready for inline insertion into the
 *       packing-slip template.
 *
 *   Surface:
 *     - `defineWrap({ wrap_sku, title, fee_minor, image_url?,
 *                     max_per_order?, active })` — register a wrap
 *       option. Refuses unless wrap_sku is a real catalog variant.
 *     - `listWraps({ active_only? })` / `getWrap(wrap_sku)` /
 *       `updateWrap(wrap_sku, patch)` / `archiveWrap(wrap_sku)`.
 *     - `setForOrder({ order_id, wrap_sku?, gift_message?,
 *                      recipient_name?, hide_prices? })` — UPSERT.
 *     - `getForOrder(order_id)` / `clearForOrder(order_id)`.
 *     - `feeForOrder(order_id)` — wrap fee_minor or 0.
 *     - `renderPackingSlipLine({ order_id, locale })` — returns
 *       `{ message_lines, recipient_name, hide_prices }` with
 *       HTML-escaped strings.
 *     - `analytics({ from, to })` — count of orders with options,
 *       top wrap_skus, gift-message rate.
 *
 *   Storage:
 *     - `gift_wraps` + `gift_options` (migration
 *       `0046_gift_options.sql`).
 *
 * @primitive giftOptions
 * @related   b.guardUuid, b.template.escapeHtml
 */

var MAX_TITLE_LEN      = 200;
var MAX_IMAGE_URL_LEN  = 2048;
var MAX_MESSAGE_LEN    = 500;
var MAX_RECIPIENT_LEN  = 120;

// SKU shape mirrors catalog.js — alnum + . _ -, ≤ 128 chars,
// leading char must be alnum so a wrap_sku can never start with a
// hyphen / dot (sidesteps shell-arg-style ambiguity in downstream
// CSV exports + the "looks like a flag" class of operator slips).
var SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Refuse C0 control bytes + DEL. The gift message + recipient name
// render onto a packing slip and (potentially) a printer queue;
// embedded control bytes have caused header-injection-class slips
// in adjacent ecosystems. Newlines are allowed in gift_message
// (people write multi-line messages); the recipient name is a
// single line and refuses LF / CR too.

// Zero-width / direction-override family — mirrors the order-notes
// primitive's catalogue: ZWSP/ZWNJ/ZWJ (U+200B-200D), LRM/RLM
// (U+200E/U+200F), the bidi-formatting block (U+202A-U+202E), the
// invisible-math block (U+2060-U+2064), the LRI/RLI/FSI/PDI block
// (U+2066-U+2069), the BOM (U+FEFF), and the Arabic letter mark
// (U+061C). Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.

var ALLOWED_WRAP_COLUMNS = Object.freeze([
  "title", "fee_minor", "image_url", "max_per_order", "active",
]);

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("giftOptions: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("giftOptions: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("giftOptions: title must be a non-empty string ≤ " + MAX_TITLE_LEN + " chars");
  }
  textGuard.freeText(s, "giftOptions: title", { singleLine: "reject", zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _feeMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("giftOptions: fee_minor must be a non-negative integer");
  }
  return n;
}

function _imageUrl(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_IMAGE_URL_LEN) {
    throw new TypeError("giftOptions: image_url must be a non-empty string ≤ " + MAX_IMAGE_URL_LEN + " chars");
  }
  // Restrict to https:// or // (protocol-relative) — http:// is a
  // mixed-content liability on a storefront served over https, and
  // javascript: / data: must never reach an <img src> on the
  // checkout page. The browser-side CSP catches these too; this
  // gate is defense-in-depth at the persistence layer.
  if (!(/^https:\/\//.test(s) || /^\/\//.test(s) || /^\//.test(s))) {
    throw new TypeError("giftOptions: image_url must be https://, // (protocol-relative), or / (absolute path)");
  }
  textGuard.freeText(s, "giftOptions: image_url", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

function _maxPerOrder(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("giftOptions: max_per_order must be a positive integer or null");
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("giftOptions: " + label + " must be a boolean");
  }
  return v ? 1 : 0;
}

function _giftMessage(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("giftOptions: gift_message must be a string");
  }
  if (s.length > MAX_MESSAGE_LEN) {
    throw new TypeError("giftOptions: gift_message must be ≤ " + MAX_MESSAGE_LEN + " chars");
  }
  textGuard.freeText(s, "giftOptions: gift_message", { zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _recipientName(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("giftOptions: recipient_name must be a string");
  }
  if (s.length > MAX_RECIPIENT_LEN) {
    throw new TypeError("giftOptions: recipient_name must be ≤ " + MAX_RECIPIENT_LEN + " chars");
  }
  textGuard.freeText(s, "giftOptions: recipient_name", { singleLine: "reject", zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("giftOptions: " + label + " must be a non-negative integer (epoch ms)");
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
  // The catalog handle is required so `defineWrap` can verify that
  // wrap_sku resolves to a real variant before persisting. Operators
  // who'd run without a catalog handle would silently get wraps that
  // point at no inventory row — refuse at factory time.
  if (!opts.catalog) {
    throw new TypeError("giftOptions.create: opts.catalog required (composes catalog.variants.bySku for wrap_sku resolution)");
  }
  var catalog = opts.catalog;

  // -- gift_wraps surface -------------------------------------------------

  async function defineWrap(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftOptions.defineWrap: input object required");
    }
    var wrapSku       = _sku(input.wrap_sku, "wrap_sku");
    var title         = _title(input.title);
    var feeMinor      = _feeMinor(input.fee_minor);
    var imageUrl      = _imageUrl(input.image_url);
    var maxPerOrder   = _maxPerOrder(input.max_per_order);
    var active        = _bool(input.active, "active");

    // wrap_sku must resolve to a real catalog variant so inventory
    // + cost can flow through normal channels. Look it up via the
    // catalog handle the factory was given.
    var variant = await catalog.variants.bySku(wrapSku);
    if (!variant) {
      throw new TypeError("giftOptions.defineWrap: wrap_sku " + JSON.stringify(wrapSku) + " is not a known catalog variant");
    }

    var ts = _now();
    await query(
      "INSERT INTO gift_wraps (wrap_sku, title, fee_minor, image_url, max_per_order, active, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
      [wrapSku, title, feeMinor, imageUrl, maxPerOrder, active, ts],
    );
    return {
      wrap_sku:      wrapSku,
      title:         title,
      fee_minor:     feeMinor,
      image_url:     imageUrl,
      max_per_order: maxPerOrder,
      active:        Boolean(active),
      archived_at:   null,
      created_at:    ts,
      updated_at:    ts,
    };
  }

  function _hydrateWrapRow(r) {
    if (!r) return null;
    return {
      wrap_sku:      r.wrap_sku,
      title:         r.title,
      fee_minor:     Number(r.fee_minor),
      image_url:     r.image_url,
      max_per_order: r.max_per_order == null ? null : Number(r.max_per_order),
      active:        Number(r.active) === 1,
      archived_at:   r.archived_at == null ? null : Number(r.archived_at),
      created_at:    Number(r.created_at),
      updated_at:    Number(r.updated_at),
    };
  }

  async function listWraps(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("giftOptions.listWraps: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var sql, params;
    if (activeOnly) {
      sql    = "SELECT * FROM gift_wraps WHERE active = 1 AND archived_at IS NULL ORDER BY created_at ASC, wrap_sku ASC";
      params = [];
    } else {
      sql    = "SELECT * FROM gift_wraps ORDER BY created_at ASC, wrap_sku ASC";
      params = [];
    }
    var rows = (await query(sql, params)).rows;
    return rows.map(_hydrateWrapRow);
  }

  async function getWrap(wrapSku) {
    _sku(wrapSku, "wrap_sku");
    var r = (await query(
      "SELECT * FROM gift_wraps WHERE wrap_sku = ?1 LIMIT 1",
      [wrapSku],
    )).rows[0];
    return _hydrateWrapRow(r);
  }

  async function updateWrap(wrapSku, patch) {
    _sku(wrapSku, "wrap_sku");
    if (!patch || typeof patch !== "object") {
      throw new TypeError("giftOptions.updateWrap: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("giftOptions.updateWrap: patch must include at least one column");
    }
    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      // Lock the patch surface to a known column set — composing
      // b.safeSql.assertOneOf would be the canonical path, but the
      // primitive's column count is tiny enough that an explicit
      // Object.freeze list is just as defensible and keeps the
      // detector greps for unsafe column-name concatenation green.
      if (ALLOWED_WRAP_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("giftOptions.updateWrap: unsupported column " + JSON.stringify(col));
      }
      var v;
      if (col === "title")              v = _title(patch[col]);
      else if (col === "fee_minor")     v = _feeMinor(patch[col]);
      else if (col === "image_url")     v = _imageUrl(patch[col]);
      else if (col === "max_per_order") v = _maxPerOrder(patch[col]);
      else /* active */                 v = _bool(patch[col], "active");
      sets.push(col + " = ?" + idx);
      params.push(v);
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(wrapSku);
    var r = await query(
      "UPDATE gift_wraps SET " + sets.join(", ") + " WHERE wrap_sku = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("giftOptions.updateWrap: wrap_sku " + JSON.stringify(wrapSku) + " not found");
    }
    return await getWrap(wrapSku);
  }

  async function archiveWrap(wrapSku) {
    _sku(wrapSku, "wrap_sku");
    var ts = _now();
    var r = await query(
      "UPDATE gift_wraps SET active = 0, archived_at = ?1, updated_at = ?1 WHERE wrap_sku = ?2",
      [ts, wrapSku],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("giftOptions.archiveWrap: wrap_sku " + JSON.stringify(wrapSku) + " not found");
    }
    return await getWrap(wrapSku);
  }

  // -- gift_options surface ----------------------------------------------

  function _hydrateOptionsRow(r) {
    if (!r) return null;
    return {
      order_id:        r.order_id,
      wrap_sku:        r.wrap_sku,
      gift_message:    r.gift_message,
      recipient_name:  r.recipient_name,
      hide_prices:     Number(r.hide_prices) === 1,
      set_at:          Number(r.set_at),
      updated_at:      Number(r.updated_at),
    };
  }

  async function setForOrder(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftOptions.setForOrder: input object required");
    }
    var orderId = _uuid(input.order_id, "order_id");

    var wrapSku = null;
    if (input.wrap_sku != null) {
      _sku(input.wrap_sku, "wrap_sku");
      // Refuse if the wrap_sku isn't a defined, active, non-archived
      // wrap. Archived wraps stay reachable via getForOrder for
      // older orders, but setForOrder can't attach a new order to a
      // wrap the operator has retired.
      var wrap = (await query(
        "SELECT * FROM gift_wraps WHERE wrap_sku = ?1 LIMIT 1",
        [input.wrap_sku],
      )).rows[0];
      if (!wrap) {
        throw new TypeError("giftOptions.setForOrder: wrap_sku " + JSON.stringify(input.wrap_sku) + " is not a defined wrap");
      }
      if (Number(wrap.active) !== 1 || wrap.archived_at != null) {
        throw new TypeError("giftOptions.setForOrder: wrap_sku " + JSON.stringify(input.wrap_sku) + " is archived / inactive");
      }
      wrapSku = input.wrap_sku;
    }

    var giftMessage   = _giftMessage(input.gift_message);
    var recipientName = _recipientName(input.recipient_name);

    var hidePrices = 0;
    if (input.hide_prices != null) {
      hidePrices = _bool(input.hide_prices, "hide_prices");
    }

    var ts = _now();
    // UPSERT — one gift_options row per order. Re-running with
    // different inputs replaces every column (the operator UI
    // re-submits the full state each time the customer edits gift
    // options, so a partial UPSERT would silently retain stale
    // fields).
    await query(
      "INSERT INTO gift_options (order_id, wrap_sku, gift_message, recipient_name, hide_prices, set_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) " +
      "ON CONFLICT (order_id) DO UPDATE SET " +
      "  wrap_sku        = excluded.wrap_sku, " +
      "  gift_message    = excluded.gift_message, " +
      "  recipient_name  = excluded.recipient_name, " +
      "  hide_prices     = excluded.hide_prices, " +
      "  updated_at      = excluded.updated_at",
      [orderId, wrapSku, giftMessage, recipientName, hidePrices, ts],
    );
    return await getForOrder(orderId);
  }

  async function getForOrder(orderId) {
    var oid = _uuid(orderId, "order_id");
    var r = (await query(
      "SELECT * FROM gift_options WHERE order_id = ?1 LIMIT 1",
      [oid],
    )).rows[0];
    return _hydrateOptionsRow(r);
  }

  async function clearForOrder(orderId) {
    var oid = _uuid(orderId, "order_id");
    var r = await query(
      "DELETE FROM gift_options WHERE order_id = ?1",
      [oid],
    );
    return { cleared: Number(r.rowCount || 0) > 0 };
  }

  async function feeForOrder(orderId) {
    var oid = _uuid(orderId, "order_id");
    // Single JOIN read — pulls the wrap fee in one round-trip
    // rather than two reads (gift_options then gift_wraps).
    var r = (await query(
      "SELECT gw.fee_minor AS fee_minor " +
      "FROM gift_options go " +
      "JOIN gift_wraps gw ON gw.wrap_sku = go.wrap_sku " +
      "WHERE go.order_id = ?1 LIMIT 1",
      [oid],
    )).rows[0];
    return r ? Number(r.fee_minor) : 0;
  }

  // -- packing-slip render ------------------------------------------------

  async function renderPackingSlipLine(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftOptions.renderPackingSlipLine: input object required");
    }
    var oid = _uuid(input.order_id, "order_id");
    // Locale is captured for future per-locale renderers — today
    // the message itself is operator-authored prose and isn't
    // translated, but the renderer surfaces the locale so a
    // downstream slip template can pick a language-appropriate
    // header. Refuse anything that isn't a BCP-47-shape string.
    var locale = input.locale;
    if (locale == null || typeof locale !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) {
      throw new TypeError("giftOptions.renderPackingSlipLine: locale must be a BCP-47-shape string (e.g. 'en-US')");
    }

    var row = (await query(
      "SELECT * FROM gift_options WHERE order_id = ?1 LIMIT 1",
      [oid],
    )).rows[0];
    if (!row) {
      return {
        message_lines:  [],
        recipient_name: null,
        hide_prices:    false,
      };
    }

    var escapeHtml = b.template.escapeHtml;

    // Split the message on LF (and the rare CRLF) so the packing-
    // slip template can emit one <div> per line without parsing
    // raw newlines downstream. Trailing empty lines are dropped to
    // keep the slip tidy when the customer typed an extra newline
    // at the end.
    var messageLines = [];
    if (row.gift_message) {
      var raw = String(row.gift_message).replace(/\r\n/g, "\n").split("\n");
      while (raw.length && raw[raw.length - 1] === "") raw.pop();
      messageLines = raw.map(function (line) { return escapeHtml(line); });
    }

    return {
      message_lines:  messageLines,
      recipient_name: row.recipient_name ? escapeHtml(row.recipient_name) : null,
      hide_prices:    Number(row.hide_prices) === 1,
      locale:         locale,
    };
  }

  // -- analytics ----------------------------------------------------------

  async function analytics(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftOptions.analytics: input object required");
    }
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (to < from) {
      throw new TypeError("giftOptions.analytics: to must be >= from");
    }

    // Total orders with any gift option in the window — counts
    // every row regardless of which field(s) are set.
    var totalRow = (await query(
      "SELECT COUNT(*) AS n FROM gift_options WHERE set_at >= ?1 AND set_at < ?2",
      [from, to],
    )).rows[0];
    var totalOrders = Number((totalRow || {}).n || 0);

    // Top wrap_skus — orders with a non-NULL wrap_sku grouped by
    // the wrap. Capped at 10 because the operator dashboard
    // doesn't need an unbounded list.
    var topWraps = (await query(
      "SELECT wrap_sku, COUNT(*) AS n FROM gift_options " +
      "WHERE set_at >= ?1 AND set_at < ?2 AND wrap_sku IS NOT NULL " +
      "GROUP BY wrap_sku ORDER BY n DESC, wrap_sku ASC LIMIT 10",
      [from, to],
    )).rows.map(function (r) {
      return { wrap_sku: r.wrap_sku, count: Number(r.n) };
    });

    // Gift-message rate — fraction of gift_options rows in the
    // window that carry a non-NULL message. Returned as a float in
    // [0, 1] so the dashboard can render as a percentage without
    // worrying about division-by-zero.
    var messageRow = (await query(
      "SELECT COUNT(*) AS n FROM gift_options " +
      "WHERE set_at >= ?1 AND set_at < ?2 AND gift_message IS NOT NULL AND gift_message != ''",
      [from, to],
    )).rows[0];
    var messageCount = Number((messageRow || {}).n || 0);
    var messageRate  = totalOrders > 0 ? messageCount / totalOrders : 0;

    return {
      from:               from,
      to:                 to,
      orders_with_gift:   totalOrders,
      top_wrap_skus:      topWraps,
      gift_message_count: messageCount,
      gift_message_rate:  messageRate,
    };
  }

  return {
    MAX_TITLE_LEN:     MAX_TITLE_LEN,
    MAX_MESSAGE_LEN:   MAX_MESSAGE_LEN,
    MAX_RECIPIENT_LEN: MAX_RECIPIENT_LEN,

    defineWrap:             defineWrap,
    listWraps:              listWraps,
    getWrap:                getWrap,
    updateWrap:             updateWrap,
    archiveWrap:            archiveWrap,

    setForOrder:            setForOrder,
    getForOrder:            getForOrder,
    clearForOrder:          clearForOrder,
    feeForOrder:            feeForOrder,
    renderPackingSlipLine:  renderPackingSlipLine,
    analytics:              analytics,
  };
}

module.exports = {
  create:            create,
  MAX_TITLE_LEN:     MAX_TITLE_LEN,
  MAX_MESSAGE_LEN:   MAX_MESSAGE_LEN,
  MAX_RECIPIENT_LEN: MAX_RECIPIENT_LEN,
};
