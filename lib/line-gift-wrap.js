"use strict";
/**
 * @module shop.lineGiftWrap
 * @title  Per-line gift wrap — distinct wrap_sku per order line
 *
 * @intro
 *   The sibling `giftOptions` primitive carries one wrap_sku at the
 *   ORDER level. That shape collapses when a single order ships gifts
 *   to multiple recipients: "the necklace goes to my sister in floral
 *   paper; the watch goes to my dad in kraft paper" can't be
 *   expressed when there's only one wrap slot for the whole order.
 *
 *   This primitive lets each `(order_id, line_id)` carry its own
 *   wrap_sku + gift_message + recipient_name. The two primitives are
 *   complementary, not competing — `giftOptions` still owns the
 *   order-level concerns (hide_prices on the slip, the per-order
 *   recipient field that survives when no per-line override exists).
 *   Operators who don't need per-line granularity stay on
 *   `giftOptions`; operators who do compose both.
 *
 *   The wrap catalog itself lives on `giftOptions.defineWrap(...)`
 *   — this primitive does NOT duplicate the wrap registry. When a
 *   `giftOptions` handle is provided at create time,
 *   `feeForOrder({ order_id })` sums every per-line wrap fee by
 *   reading `giftOptions.getWrap(wrap_sku).fee_minor`. Absent the
 *   handle, `feeForOrder` refuses (the fee data simply isn't
 *   reachable without it).
 *
 *   Composition:
 *
 *     var lgw = bShop.lineGiftWrap.create({
 *       query:       q,
 *       giftOptions: bShop.giftOptions.create({ query: q, catalog: cat }),
 *     });
 *
 *     await lgw.setLineWrap({
 *       order_id:       "...",
 *       line_id:        "...",
 *       wrap_sku:       "WRAP-FLORAL",
 *       gift_message:   "Happy birthday, sis!",
 *       recipient_name: "Alice",
 *     });
 *
 *   Surface:
 *
 *     - `setLineWrap({ order_id, line_id, wrap_sku, gift_message?,
 *                      recipient_name? })` — UPSERT against
 *                      UNIQUE(order_id, line_id).
 *     - `getLineWrap({ order_id, line_id })` — hydrated row or null.
 *     - `wrapsForOrder({ order_id })` — every per-line wrap on the
 *                      order in stable line_id order.
 *     - `clearLineWrap({ order_id, line_id })` — drop one row.
 *     - `feeForOrder({ order_id })` — sum of fee_minor across every
 *                      per-line wrap on the order. Refuses unless
 *                      `giftOptions` was wired at create time.
 *     - `renderPackingSlipLines({ order_id, locale })` — per-line
 *                      render data with HTML-escaped strings.
 *     - `analytics({ from, to })` — per-wrap-sku usage counts in the
 *                      window.
 *
 *   Storage:
 *     - `line_gift_wraps` (migration `0202_line_gift_wrap.sql`).
 *
 * @primitive lineGiftWrap
 * @related   shop.giftOptions, b.guardUuid, b.uuid.v7,
 *            b.template.escapeHtml
 */

// ---- constants ----------------------------------------------------------

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

var C = b.constants;

var MAX_MESSAGE_LEN   = 500;
var MAX_RECIPIENT_LEN = 120;
var MAX_FROM_TO_SPAN  = C.TIME.days(366); // analytics window cap

// SKU shape mirrors catalog.js + gift-options.js — alnum + . _ -, ≤
// 128 chars, leading char must be alnum so a wrap_sku can never
// start with a hyphen / dot (sidesteps shell-arg-style ambiguity in
// downstream CSV exports + the "looks like a flag" class of operator
// slips).
var SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Refuse C0 control bytes + DEL. The gift message + recipient name
// render onto a packing slip and (potentially) a printer queue;
// embedded control bytes have caused header-injection-class slips in
// adjacent ecosystems. Newlines are allowed in gift_message (people
// write multi-line messages); the recipient name is a single line
// and refuses LF / CR too.

// Zero-width / direction-override family — mirrors the gift-options
// primitive's catalogue: ZWSP/ZWNJ/ZWJ (U+200B-200D), LRM/RLM
// (U+200E/U+200F), the bidi-formatting block (U+202A-U+202E), the
// invisible-math block (U+2060-U+2064), the LRI/RLI/FSI/PDI block
// (U+2066-U+2069), the BOM (U+FEFF), and the Arabic letter mark
// (U+061C). Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.

var BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// ---- monotonic clock ---------------------------------------------------
//
// Per-line wrap UPSERTs frequently arrive in tight bursts (the
// storefront's gift-wrap picker fires a setLineWrap per row when the
// customer hits "save"). Two same-millisecond writes would otherwise
// share a `set_at` timestamp and a sort-by-set_at read would lose
// the operator's actual mutation order. Bumping by 1ms on a tie
// keeps the timeline strictly increasing.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _orderId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("lineGiftWrap: order_id — " + (e && e.message || "invalid UUID"));
  }
}

function _lineId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("lineGiftWrap: line_id — " + (e && e.message || "invalid UUID"));
  }
}

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("lineGiftWrap: wrap_sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _giftMessage(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("lineGiftWrap: gift_message must be a string");
  }
  if (s.length > MAX_MESSAGE_LEN) {
    throw new TypeError("lineGiftWrap: gift_message must be ≤ " + MAX_MESSAGE_LEN + " chars");
  }
  textGuard.freeText(s, "lineGiftWrap: gift_message", { zeroWidth: "reject" });
  return s;
}

function _recipientName(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("lineGiftWrap: recipient_name must be a string");
  }
  if (s.length > MAX_RECIPIENT_LEN) {
    throw new TypeError("lineGiftWrap: recipient_name must be ≤ " + MAX_RECIPIENT_LEN + " chars");
  }
  textGuard.freeText(s, "lineGiftWrap: recipient_name", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("lineGiftWrap: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _locale(s) {
  if (typeof s !== "string" || !BCP47_RE.test(s)) {
    throw new TypeError("lineGiftWrap: locale must be a BCP-47-shape string (e.g. 'en-US')");
  }
  return s;
}

function _hydrateRow(r) {
  if (!r) return null;
  return {
    id:             r.id,
    order_id:       r.order_id,
    line_id:        r.line_id,
    wrap_sku:       r.wrap_sku,
    gift_message:   r.gift_message == null ? null : String(r.gift_message),
    recipient_name: r.recipient_name == null ? null : String(r.recipient_name),
    set_at:         Number(r.set_at),
    updated_at:     Number(r.updated_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // giftOptions is optional — when wired, `feeForOrder` sums per-line
  // wrap fees by calling `giftOptions.getWrap(wrap_sku)`. Absent the
  // handle, `feeForOrder` refuses loudly (the fee data simply isn't
  // reachable without the wrap catalog). The factory verifies the
  // shape at boot so a typo in the wiring fails loud, not when
  // `feeForOrder` is first invoked.
  var giftOpts = opts.giftOptions || null;
  if (giftOpts && typeof giftOpts.getWrap !== "function") {
    throw new TypeError("lineGiftWrap.create: opts.giftOptions must expose a getWrap(wrap_sku) method");
  }

  async function _getRow(orderId, lineId) {
    var r = await query(
      "SELECT * FROM line_gift_wraps WHERE order_id = ?1 AND line_id = ?2 LIMIT 1",
      [orderId, lineId],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  async function setLineWrap(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("lineGiftWrap.setLineWrap: input object required");
    }
    var orderId      = _orderId(input.order_id);
    var lineId       = _lineId(input.line_id);
    var wrapSku      = _sku(input.wrap_sku);
    var giftMessage  = _giftMessage(input.gift_message);
    var recipientName = _recipientName(input.recipient_name);

    var ts = _now();
    var existing = await _getRow(orderId, lineId);
    if (existing) {
      // UPSERT against UNIQUE(order_id, line_id). Re-running with
      // different inputs replaces every column (the storefront UI
      // re-submits the full state when the customer edits a line's
      // wrap, so a partial update would silently retain stale
      // gift_message / recipient_name fields).
      await query(
        "UPDATE line_gift_wraps SET wrap_sku = ?1, gift_message = ?2, " +
        "recipient_name = ?3, updated_at = ?4 WHERE order_id = ?5 AND line_id = ?6",
        [wrapSku, giftMessage, recipientName, ts, orderId, lineId],
      );
    } else {
      await query(
        "INSERT INTO line_gift_wraps (id, order_id, line_id, wrap_sku, " +
        "gift_message, recipient_name, set_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        [b.uuid.v7(), orderId, lineId, wrapSku, giftMessage, recipientName, ts],
      );
    }
    return _hydrateRow(await _getRow(orderId, lineId));
  }

  async function getLineWrap(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("lineGiftWrap.getLineWrap: input object required");
    }
    var orderId = _orderId(input.order_id);
    var lineId  = _lineId(input.line_id);
    return _hydrateRow(await _getRow(orderId, lineId));
  }

  async function wrapsForOrder(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("lineGiftWrap.wrapsForOrder: input object required");
    }
    var orderId = _orderId(input.order_id);
    var rows = (await query(
      "SELECT * FROM line_gift_wraps WHERE order_id = ?1 ORDER BY line_id ASC",
      [orderId],
    )).rows;
    return rows.map(_hydrateRow);
  }

  async function clearLineWrap(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("lineGiftWrap.clearLineWrap: input object required");
    }
    var orderId = _orderId(input.order_id);
    var lineId  = _lineId(input.line_id);
    var r = await query(
      "DELETE FROM line_gift_wraps WHERE order_id = ?1 AND line_id = ?2",
      [orderId, lineId],
    );
    return { cleared: Number(r.rowCount || 0) > 0 };
  }

  async function feeForOrder(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("lineGiftWrap.feeForOrder: input object required");
    }
    if (!giftOpts) {
      throw new TypeError("lineGiftWrap.feeForOrder: opts.giftOptions must be wired (the wrap catalog + fee_minor live on the giftOptions primitive)");
    }
    var orderId = _orderId(input.order_id);
    var rows = (await query(
      "SELECT wrap_sku FROM line_gift_wraps WHERE order_id = ?1",
      [orderId],
    )).rows;
    var total = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var wrap = await giftOpts.getWrap(rows[i].wrap_sku);
      if (wrap && Number.isFinite(Number(wrap.fee_minor))) {
        total += Number(wrap.fee_minor);
      }
    }
    return total;
  }

  async function renderPackingSlipLines(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("lineGiftWrap.renderPackingSlipLines: input object required");
    }
    var orderId = _orderId(input.order_id);
    var locale  = _locale(input.locale);

    var rows = (await query(
      "SELECT * FROM line_gift_wraps WHERE order_id = ?1 ORDER BY line_id ASC",
      [orderId],
    )).rows;

    var escapeHtml = b.template.escapeHtml;

    // Per-line render shape:
    //   { line_id, wrap_sku, message_lines: [<html-escaped>],
    //     recipient_name: <html-escaped|null>, locale }
    // The wrap_sku passes through verbatim (it's already shape-
    // constrained at write time), but every customer-authored string
    // (gift_message, recipient_name) is HTML-escaped before reaching
    // the slip template. Multi-line gift_message values split on LF
    // (handling rare CRLF) and trailing empty lines are dropped so
    // the slip doesn't grow a stray blank row when the customer
    // typed an extra newline.
    return rows.map(function (r) {
      var messageLines = [];
      if (r.gift_message) {
        var raw = String(r.gift_message).replace(/\r\n/g, "\n").split("\n");
        while (raw.length && raw[raw.length - 1] === "") raw.pop();
        messageLines = raw.map(function (line) { return escapeHtml(line); });
      }
      return {
        line_id:        r.line_id,
        wrap_sku:       r.wrap_sku,
        message_lines:  messageLines,
        recipient_name: r.recipient_name ? escapeHtml(String(r.recipient_name)) : null,
        locale:         locale,
      };
    });
  }

  async function analytics(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("lineGiftWrap.analytics: input object required");
    }
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (to < from) {
      throw new TypeError("lineGiftWrap.analytics: to must be >= from");
    }
    if (to - from > MAX_FROM_TO_SPAN) {
      throw new TypeError("lineGiftWrap.analytics: window must be ≤ 366d (the operator dashboard pages by year)");
    }

    // Top wrap_skus by usage count. Capped at 50 because the operator
    // dashboard doesn't need an unbounded list; the wrap catalog
    // itself is rarely more than a handful of SKUs.
    var rows = (await query(
      "SELECT wrap_sku, COUNT(*) AS n FROM line_gift_wraps " +
      "WHERE set_at >= ?1 AND set_at < ?2 " +
      "GROUP BY wrap_sku ORDER BY n DESC, wrap_sku ASC LIMIT 50",
      [from, to],
    )).rows;

    var totalRow = (await query(
      "SELECT COUNT(*) AS n FROM line_gift_wraps WHERE set_at >= ?1 AND set_at < ?2",
      [from, to],
    )).rows[0];
    var totalLines = Number((totalRow || {}).n || 0);

    return {
      from:        from,
      to:          to,
      total_lines: totalLines,
      by_wrap_sku: rows.map(function (r) {
        return { wrap_sku: r.wrap_sku, count: Number(r.n) };
      }),
    };
  }

  return {
    MAX_MESSAGE_LEN:   MAX_MESSAGE_LEN,
    MAX_RECIPIENT_LEN: MAX_RECIPIENT_LEN,

    setLineWrap:             setLineWrap,
    getLineWrap:             getLineWrap,
    wrapsForOrder:           wrapsForOrder,
    clearLineWrap:           clearLineWrap,
    feeForOrder:             feeForOrder,
    renderPackingSlipLines:  renderPackingSlipLines,
    analytics:               analytics,
  };
}

module.exports = {
  create:            create,
  MAX_MESSAGE_LEN:   MAX_MESSAGE_LEN,
  MAX_RECIPIENT_LEN: MAX_RECIPIENT_LEN,
};
