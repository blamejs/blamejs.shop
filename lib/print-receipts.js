"use strict";
/**
 * @module shop.printReceipts
 * @title  Print receipts — three render surfaces for the warehouse + fulfillment console
 *
 * @intro
 *   Operators printing customer-facing paperwork have three target
 *   surfaces, each driven by a different downstream pipeline:
 *
 *     thermal     — 80mm ESC/POS column-formatted text. Sent directly
 *                   to a thermal receipt printer (the warehouse pick
 *                   slip, the in-counter customer copy). Default
 *                   column count is 48 (the standard 80mm/12cpi
 *                   shape); operators with a 58mm printer pass
 *                   `paper_width_mm: 58` and the renderer narrows to
 *                   32 columns.
 *
 *     html_pdf    — A4 HTML emitted as a complete document the
 *                   operator's worker pipes through a headless-Chrome
 *                   PDF conversion. The HTML is self-contained
 *                   (inlined CSS, no external assets) so the
 *                   conversion has no network footprint.
 *
 *     plain_text  — plain-text email receipt body. CRLF line endings
 *                   (RFC 5322 §2.3) so the bytes drop straight into
 *                   an email payload without a downstream rewrap.
 *
 *   Every text/HTML interpolation point passes through
 *   `b.template.escapeHtml` — operator-input fields (notes, sku,
 *   address lines) are equally at risk as customer-input fields when
 *   one of the two render formats is HTML. Plain-text output applies
 *   a stricter scrub: control bytes (U+0000..U+001F except newline +
 *   tab, plus U+007F) are stripped so a hostile note can't smuggle
 *   ANSI escapes into a terminal-rendered email preview.
 *
 *   Surface:
 *
 *     thermal({ order_id, paper_width_mm? })
 *       — returns the formatted ESC/POS text. `paper_width_mm`
 *         defaults to 80 (48 cols). Accepts 58 (32 cols). Other
 *         widths refused — operators with bespoke printers compose
 *         their own renderer; the primitive ships the two common
 *         widths.
 *
 *     htmlPdf({ order_id, locale? })
 *       — returns a complete HTML document string suitable for
 *         headless-Chrome conversion. `locale` defaults to "en";
 *         pass any BCP-47-shape tag to switch the labels (the
 *         catalog ships en / es / de inline — unknown locales fall
 *         back to en).
 *
 *     plainText({ order_id, locale? })
 *       — returns the plain-text email receipt body. CRLF newlines.
 *
 *     previewBuffer({ order_id, format, locale? })
 *       — returns the rendered string without writing a row to
 *         receipt_prints. Operator console uses this for an
 *         on-screen preview before the real print. `format` is one
 *         of "thermal", "html_pdf", "plain_text".
 *
 *     recordPrint({ order_id, format, printer_name?, occurred_at? })
 *       — renders the receipt, hashes the bytes, and appends one row
 *         to receipt_prints. Returns `{ id, byte_size, sha3_512,
 *         occurred_at }`. The render bytes themselves are NOT stored
 *         — the operator already holds them in the spool — only the
 *         integrity record.
 *
 *     printsForOrder(order_id)
 *       — reads the audit log newest-first. Returns
 *         `[{ id, format, printer_name, locale, occurred_at,
 *            byte_size, sha3_512 }]`.
 *
 * @related b.template.escapeHtml, b.crypto.sha3Hash, b.guardUuid, b.uuid.v7
 */

var b = require("./index").framework;

// ---- constants ----------------------------------------------------------

var VALID_FORMATS = { "thermal": true, "html_pdf": true, "plain_text": true };

// 80mm ESC/POS thermal printers ship at 48 columns @ 12cpi font A;
// 58mm narrow rolls ship at 32 columns. Other widths exist on
// bespoke industrial hardware — operators with one of those compose
// their own renderer downstream rather than smuggling a magic
// column-count through this primitive.
var THERMAL_WIDTHS = { 80: 48, 58: 32 };
var DEFAULT_PAPER_WIDTH_MM = 80;

// ESC/POS initialize + line-feed paper-cut. The thermal renderer
// emits these around the body so the printer reset state stays
// predictable across consecutive jobs and the paper auto-cuts at
// the end of each receipt.
//
// Sequences are the standard Epson TM-series mnemonic shapes (no
// vendor extension): ESC @ for init, GS V 1 for full-paper cut. A
// printer that doesn't speak the cut sequence simply prints the
// literal byte at the end of the spool; no firmware harm done.
var ESCPOS_INIT = "\x1B\x40";          // ESC @ — initialize printer
var ESCPOS_CUT  = "\x1D\x56\x01";      // GS V 1 — partial paper cut

// BCP-47 shape: 2-3 alpha primary subtag, optional region/script
// subtags. Mirrors the gift-options / order-timeline shape.
var BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Plain-text scrub. Strip C0 control bytes (U+0000..U+001F) except
// LF (U+000A) + CR (U+000D) + TAB (U+0009), plus the lone DEL
// (U+007F). A hostile gift note carrying an ANSI escape sequence
// (`\x1B[2J`) would otherwise clear an operator's terminal when
// previewed via `less` / `more` on a CUPS spool capture.
var CONTROL_BYTES_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Per-locale labels for the operator-facing receipt header /
// totals. Shipped inline because the receipt vocabulary is tiny
// and stable; operators wanting a fuller catalog wrap this
// primitive with their own label map.
var LOCALE_LABELS = {
  "en": {
    receipt:      "Receipt",
    order:        "Order",
    placed:       "Placed",
    ship_to:      "Ship to",
    item:         "Item",
    qty:          "Qty",
    price:        "Price",
    line_total:   "Total",
    subtotal:     "Subtotal",
    discount:     "Discount",
    tax:          "Tax",
    shipping:     "Shipping",
    grand_total:  "Grand total",
    thanks:       "Thank you for your order.",
  },
  "es": {
    receipt:      "Recibo",
    order:        "Pedido",
    placed:       "Realizado",
    ship_to:      "Enviar a",
    item:         "Articulo",
    qty:          "Cant",
    price:        "Precio",
    line_total:   "Total",
    subtotal:     "Subtotal",
    discount:     "Descuento",
    tax:          "Impuesto",
    shipping:     "Envio",
    grand_total:  "Total general",
    thanks:       "Gracias por su pedido.",
  },
  "de": {
    receipt:      "Quittung",
    order:        "Bestellung",
    placed:       "Aufgegeben",
    ship_to:      "Versand an",
    item:         "Artikel",
    qty:          "Menge",
    price:        "Preis",
    line_total:   "Summe",
    subtotal:     "Zwischensumme",
    discount:     "Rabatt",
    tax:          "Steuer",
    shipping:     "Versand",
    grand_total:  "Gesamtbetrag",
    thanks:       "Vielen Dank fuer Ihre Bestellung.",
  },
};

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("printReceipts: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _locale(s) {
  if (s == null) return "en";
  if (typeof s !== "string" || !BCP47_RE.test(s)) {
    throw new TypeError("printReceipts: locale must be a BCP-47-shape string (e.g. 'en-US')");
  }
  return s;
}

function _paperWidth(n) {
  if (n == null) return DEFAULT_PAPER_WIDTH_MM;
  if (!Number.isInteger(n) || !Object.prototype.hasOwnProperty.call(THERMAL_WIDTHS, String(n))) {
    throw new TypeError("printReceipts: paper_width_mm must be one of 80, 58");
  }
  return n;
}

function _format(s) {
  if (typeof s !== "string" || !VALID_FORMATS[s]) {
    throw new TypeError("printReceipts: format must be one of 'thermal', 'html_pdf', 'plain_text'");
  }
  return s;
}

function _occurredAt(n) {
  if (n == null) return Date.now();
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("printReceipts: occurred_at must be a non-negative integer epoch-ms");
  }
  return n;
}

function _printerName(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > 256) {
    throw new TypeError("printReceipts: printer_name must be a 1..256 char string when provided");
  }
  return s;
}

function _resolveLocaleLabels(locale) {
  var lc = locale.toLowerCase();
  if (LOCALE_LABELS[lc]) return LOCALE_LABELS[lc];
  var primary = lc.split("-")[0];
  if (LOCALE_LABELS[primary]) return LOCALE_LABELS[primary];
  return LOCALE_LABELS.en;
}

// ---- shared rendering helpers ------------------------------------------

// Format a (minor-units, ISO-4217-code) pair as a display string.
// Two-decimal currencies cover the vast majority of operator-facing
// receipts; zero-decimal currencies (JPY, KRW, etc.) get the raw
// integer. The split is by the operator's currency code — a future
// per-currency catalog can refine this without changing the
// primitive's surface.
var ZERO_DECIMAL_CURRENCIES = { "JPY": true, "KRW": true, "VND": true, "CLP": true, "ISK": true };

function _formatMoney(minor, currency) {
  if (ZERO_DECIMAL_CURRENCIES[currency]) {
    return String(minor) + " " + currency;
  }
  var major = Math.floor(minor / 100);
  var cents = Math.abs(minor % 100);
  var centsStr = cents < 10 ? "0" + cents : String(cents);
  return major + "." + centsStr + " " + currency;
}

function _isoDate(epochMs) {
  // YYYY-MM-DD HH:MM UTC. Stable across runners — never resorts to
  // locale-aware Date formatting which would shift across host
  // timezones.
  var d = new Date(epochMs);
  function _pad(n) { return n < 10 ? "0" + n : String(n); }
  return d.getUTCFullYear() + "-" + _pad(d.getUTCMonth() + 1) + "-" + _pad(d.getUTCDate()) +
         " " + _pad(d.getUTCHours()) + ":" + _pad(d.getUTCMinutes()) + " UTC";
}

function _scrubPlain(s) {
  if (s == null) return "";
  return String(s).replace(CONTROL_BYTES_RE, "");
}

// Pad a string to exactly `width` cols (right-pad with spaces, or
// truncate if too long). Used by the thermal renderer to align
// columns inside the fixed-width receipt.
function _padRight(s, width) {
  var str = String(s == null ? "" : s);
  if (str.length >= width) return str.slice(0, width);
  var pad = width - str.length;
  return str + " ".repeat(pad);
}

function _padLeft(s, width) {
  var str = String(s == null ? "" : s);
  if (str.length >= width) return str.slice(str.length - width);
  var pad = width - str.length;
  return " ".repeat(pad) + str;
}

// Center a string within `width`. Truncates if the input is already
// wider than the target.
function _center(s, width) {
  var str = String(s == null ? "" : s);
  if (str.length >= width) return str.slice(0, width);
  var left = Math.floor((width - str.length) / 2);
  var right = width - str.length - left;
  return " ".repeat(left) + str + " ".repeat(right);
}

// Render the ship-to block as plain text lines. Recognises the
// common address-shape keys (name, line1, line2, city, region,
// postal_code, country) but tolerates a partial shape — the order
// primitive's `_shipTo` validator only requires `country`, so a
// minimal order on the test path renders with just that one line.
function _shipToLines(shipTo) {
  if (!shipTo || typeof shipTo !== "object") return [];
  var lines = [];
  if (shipTo.name)        lines.push(String(shipTo.name));
  if (shipTo.line1)       lines.push(String(shipTo.line1));
  if (shipTo.line2)       lines.push(String(shipTo.line2));
  var cityLine = [];
  if (shipTo.city)        cityLine.push(String(shipTo.city));
  if (shipTo.region)      cityLine.push(String(shipTo.region));
  if (shipTo.postal_code) cityLine.push(String(shipTo.postal_code));
  if (cityLine.length)    lines.push(cityLine.join(", "));
  if (shipTo.country)     lines.push(String(shipTo.country));
  return lines;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  if (!opts.order || typeof opts.order.get !== "function") {
    throw new TypeError("printReceipts.create: opts.order primitive is required");
  }
  var orderPrim = opts.order;

  // Load + validate an order. Throws when the order_id is malformed
  // (caller bug); throws when the row is missing (operator error —
  // the print queue should never reach a deleted order).
  async function _loadOrder(orderId) {
    orderId = _uuid(orderId, "order_id");
    var order = await orderPrim.get(orderId);
    if (!order) {
      throw new TypeError("printReceipts: order " + orderId + " not found");
    }
    return order;
  }

  // ---- format renderers ------------------------------------------------

  function _renderThermal(order, paperWidthMm) {
    var cols = THERMAL_WIDTHS[paperWidthMm];
    var labels = LOCALE_LABELS.en;                                         // thermal stays English — operator hardware reflects shop config
    var lines = [];

    lines.push(_center(labels.receipt.toUpperCase(), cols));
    lines.push("=".repeat(cols));
    lines.push(labels.order + ": " + String(order.id).slice(0, cols - labels.order.length - 2));
    lines.push(labels.placed + ": " + _isoDate(Number(order.created_at)));
    lines.push("");

    // Ship-to block.
    var shipLines = _shipToLines(order.ship_to);
    if (shipLines.length) {
      lines.push(labels.ship_to + ":");
      for (var s = 0; s < shipLines.length; s += 1) {
        lines.push("  " + shipLines[s]);
      }
      lines.push("");
    }

    // Line items. Layout (48-col): SKU (padded 18) | QTY (3) |
    // PRICE (right-padded 12) | TOTAL (right-padded remainder).
    // 32-col layout drops to: SKU (14) | QTY (3) | TOTAL (15).
    lines.push("-".repeat(cols));
    var skuW, qtyW, priceW, totalW;
    if (cols === 48) {
      skuW = 18; qtyW = 3; priceW = 12; totalW = cols - skuW - qtyW - priceW - 3;
      lines.push(
        _padRight(labels.item, skuW) + " " +
        _padLeft(labels.qty, qtyW) + " " +
        _padLeft(labels.price, priceW) + " " +
        _padLeft(labels.line_total, totalW),
      );
    } else {
      skuW = 14; qtyW = 3; totalW = cols - skuW - qtyW - 2;
      lines.push(
        _padRight(labels.item, skuW) + " " +
        _padLeft(labels.qty, qtyW) + " " +
        _padLeft(labels.line_total, totalW),
      );
    }
    lines.push("-".repeat(cols));

    var orderLines = order.lines || [];
    for (var i = 0; i < orderLines.length; i += 1) {
      var l = orderLines[i];
      var sku = _scrubPlain(l.sku || "");
      var qty = String(l.qty);
      var lineTotal = _formatMoney(Number(l.line_total_minor || 0), l.unit_currency || order.currency);
      if (cols === 48) {
        var unit = _formatMoney(Number(l.unit_amount_minor || 0), l.unit_currency || order.currency);
        lines.push(
          _padRight(sku, skuW) + " " +
          _padLeft(qty, qtyW) + " " +
          _padLeft(unit, priceW) + " " +
          _padLeft(lineTotal, totalW),
        );
      } else {
        lines.push(
          _padRight(sku, skuW) + " " +
          _padLeft(qty, qtyW) + " " +
          _padLeft(lineTotal, totalW),
        );
      }
    }
    lines.push("-".repeat(cols));

    // Totals block. Each line: label left-padded, amount right-aligned.
    function _totalLine(label, minor) {
      var amount = _formatMoney(minor, order.currency);
      var avail = cols - amount.length - 1;
      return _padRight(label + ":", avail) + " " + amount;
    }
    lines.push(_totalLine(labels.subtotal,    Number(order.subtotal_minor || 0)));
    if (Number(order.discount_minor || 0) > 0) {
      lines.push(_totalLine(labels.discount,  -Number(order.discount_minor || 0)));
    }
    lines.push(_totalLine(labels.tax,         Number(order.tax_minor || 0)));
    lines.push(_totalLine(labels.shipping,    Number(order.shipping_minor || 0)));
    lines.push("=".repeat(cols));
    lines.push(_totalLine(labels.grand_total, Number(order.grand_total_minor || 0)));
    lines.push("");
    lines.push(_center(labels.thanks, cols));

    var body = lines.join("\n") + "\n";
    return ESCPOS_INIT + body + "\n\n\n" + ESCPOS_CUT;
  }

  function _renderHtmlPdf(order, locale) {
    var labels = _resolveLocaleLabels(locale);
    var escapeHtml = b.template.escapeHtml;

    var shipLinesHtml = _shipToLines(order.ship_to).map(function (line) {
      return "<div>" + escapeHtml(line) + "</div>";
    }).join("");

    var rowsHtml = "";
    var orderLines = order.lines || [];
    for (var i = 0; i < orderLines.length; i += 1) {
      var l = orderLines[i];
      var unit = _formatMoney(Number(l.unit_amount_minor || 0), l.unit_currency || order.currency);
      var lineTotal = _formatMoney(Number(l.line_total_minor || 0), l.unit_currency || order.currency);
      rowsHtml +=
        "<tr>" +
        "<td>" + escapeHtml(l.sku || "") + "</td>" +
        "<td class=\"num\">" + escapeHtml(String(l.qty)) + "</td>" +
        "<td class=\"num\">" + escapeHtml(unit) + "</td>" +
        "<td class=\"num\">" + escapeHtml(lineTotal) + "</td>" +
        "</tr>";
    }

    var discountRow = Number(order.discount_minor || 0) > 0
      ? ("<tr><th>" + escapeHtml(labels.discount) + "</th>" +
         "<td class=\"num\">-" + escapeHtml(_formatMoney(Number(order.discount_minor || 0), order.currency)) + "</td></tr>")
      : "";

    return "<!doctype html>\n" +
      "<html lang=\"" + escapeHtml(locale) + "\">\n" +
      "<head>\n" +
      "<meta charset=\"utf-8\">\n" +
      "<title>" + escapeHtml(labels.receipt) + " " + escapeHtml(order.id) + "</title>\n" +
      "<style>\n" +
      "@page { size: A4; margin: 18mm; }\n" +
      "body { font-family: system-ui, sans-serif; color: #111; font-size: 11pt; }\n" +
      "h1 { font-size: 18pt; margin: 0 0 8mm 0; }\n" +
      ".meta { margin-bottom: 6mm; }\n" +
      ".meta div { margin-bottom: 1mm; }\n" +
      ".ship-to { margin-bottom: 6mm; }\n" +
      "table { width: 100%; border-collapse: collapse; }\n" +
      "th, td { padding: 2mm 1mm; border-bottom: 1px solid #ddd; text-align: left; }\n" +
      "td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }\n" +
      ".totals { margin-top: 6mm; }\n" +
      ".totals th { text-align: left; font-weight: normal; }\n" +
      ".totals tr.grand th, .totals tr.grand td { font-weight: bold; border-top: 2px solid #111; }\n" +
      ".thanks { margin-top: 10mm; font-style: italic; }\n" +
      "</style>\n" +
      "</head>\n" +
      "<body>\n" +
      "<h1>" + escapeHtml(labels.receipt) + "</h1>\n" +
      "<div class=\"meta\">\n" +
      "<div><strong>" + escapeHtml(labels.order) + ":</strong> " + escapeHtml(order.id) + "</div>\n" +
      "<div><strong>" + escapeHtml(labels.placed) + ":</strong> " + escapeHtml(_isoDate(Number(order.created_at))) + "</div>\n" +
      "</div>\n" +
      "<div class=\"ship-to\">\n" +
      "<strong>" + escapeHtml(labels.ship_to) + ":</strong>\n" +
      shipLinesHtml +
      "</div>\n" +
      "<table>\n" +
      "<thead><tr>" +
      "<th>" + escapeHtml(labels.item) + "</th>" +
      "<th class=\"num\">" + escapeHtml(labels.qty) + "</th>" +
      "<th class=\"num\">" + escapeHtml(labels.price) + "</th>" +
      "<th class=\"num\">" + escapeHtml(labels.line_total) + "</th>" +
      "</tr></thead>\n" +
      "<tbody>" + rowsHtml + "</tbody>\n" +
      "</table>\n" +
      "<table class=\"totals\">\n" +
      "<tr><th>" + escapeHtml(labels.subtotal) + "</th>" +
      "<td class=\"num\">" + escapeHtml(_formatMoney(Number(order.subtotal_minor || 0), order.currency)) + "</td></tr>\n" +
      discountRow +
      "<tr><th>" + escapeHtml(labels.tax) + "</th>" +
      "<td class=\"num\">" + escapeHtml(_formatMoney(Number(order.tax_minor || 0), order.currency)) + "</td></tr>\n" +
      "<tr><th>" + escapeHtml(labels.shipping) + "</th>" +
      "<td class=\"num\">" + escapeHtml(_formatMoney(Number(order.shipping_minor || 0), order.currency)) + "</td></tr>\n" +
      "<tr class=\"grand\"><th>" + escapeHtml(labels.grand_total) + "</th>" +
      "<td class=\"num\">" + escapeHtml(_formatMoney(Number(order.grand_total_minor || 0), order.currency)) + "</td></tr>\n" +
      "</table>\n" +
      "<div class=\"thanks\">" + escapeHtml(labels.thanks) + "</div>\n" +
      "</body>\n" +
      "</html>\n";
  }

  function _renderPlainText(order, locale) {
    var labels = _resolveLocaleLabels(locale);
    var lines = [];
    lines.push(labels.receipt.toUpperCase());
    lines.push("=".repeat(labels.receipt.length));
    lines.push("");
    lines.push(labels.order + ": " + _scrubPlain(order.id));
    lines.push(labels.placed + ": " + _isoDate(Number(order.created_at)));
    lines.push("");

    var shipLines = _shipToLines(order.ship_to);
    if (shipLines.length) {
      lines.push(labels.ship_to + ":");
      for (var s = 0; s < shipLines.length; s += 1) {
        lines.push("  " + _scrubPlain(shipLines[s]));
      }
      lines.push("");
    }

    // Items: "<qty>x <sku> @ <unit> = <line_total>"
    var orderLines = order.lines || [];
    for (var i = 0; i < orderLines.length; i += 1) {
      var l = orderLines[i];
      var unit = _formatMoney(Number(l.unit_amount_minor || 0), l.unit_currency || order.currency);
      var lineTotal = _formatMoney(Number(l.line_total_minor || 0), l.unit_currency || order.currency);
      lines.push(String(l.qty) + "x " + _scrubPlain(l.sku || "") + "  @ " + unit + "  = " + lineTotal);
    }
    lines.push("");
    lines.push(labels.subtotal + ":     " + _formatMoney(Number(order.subtotal_minor || 0), order.currency));
    if (Number(order.discount_minor || 0) > 0) {
      lines.push(labels.discount + ":   -" + _formatMoney(Number(order.discount_minor || 0), order.currency));
    }
    lines.push(labels.tax + ":          " + _formatMoney(Number(order.tax_minor || 0), order.currency));
    lines.push(labels.shipping + ":     " + _formatMoney(Number(order.shipping_minor || 0), order.currency));
    lines.push(labels.grand_total + ":  " + _formatMoney(Number(order.grand_total_minor || 0), order.currency));
    lines.push("");
    lines.push(labels.thanks);

    // CRLF line endings per RFC 5322 §2.3 — the bytes drop into an
    // email payload directly without a downstream rewrap pass.
    return lines.join("\r\n") + "\r\n";
  }

  // ---- dispatcher (shared by previewBuffer + recordPrint) --------------

  async function _renderFor(order, format, locale, paperWidthMm) {
    if (format === "thermal")    return _renderThermal(order, paperWidthMm);
    if (format === "html_pdf")   return _renderHtmlPdf(order, locale);
    if (format === "plain_text") return _renderPlainText(order, locale);
    // _format() validator gates this — defensive throw retained so
    // a hand-rolled caller bypassing the validator still gets a
    // clear refusal.
    throw new TypeError("printReceipts: unsupported format " + format);
  }

  // ---- public surface --------------------------------------------------

  return {
    VALID_FORMATS:           Object.freeze(Object.keys(VALID_FORMATS)),
    DEFAULT_PAPER_WIDTH_MM:  DEFAULT_PAPER_WIDTH_MM,

    thermal: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("printReceipts.thermal: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var paperWidthMm = _paperWidth(input.paper_width_mm);
      var order = await _loadOrder(orderId);
      return _renderThermal(order, paperWidthMm);
    },

    htmlPdf: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("printReceipts.htmlPdf: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var locale = _locale(input.locale);
      var order = await _loadOrder(orderId);
      return _renderHtmlPdf(order, locale);
    },

    plainText: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("printReceipts.plainText: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var locale = _locale(input.locale);
      var order = await _loadOrder(orderId);
      return _renderPlainText(order, locale);
    },

    previewBuffer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("printReceipts.previewBuffer: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var format = _format(input.format);
      var locale = _locale(input.locale);
      var paperWidthMm = format === "thermal" ? _paperWidth(input.paper_width_mm) : DEFAULT_PAPER_WIDTH_MM;
      var order = await _loadOrder(orderId);
      return _renderFor(order, format, locale, paperWidthMm);
    },

    recordPrint: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("printReceipts.recordPrint: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var format = _format(input.format);
      var printerName = _printerName(input.printer_name);
      var occurredAt = _occurredAt(input.occurred_at);
      var locale = _locale(input.locale);
      var paperWidthMm = format === "thermal" ? _paperWidth(input.paper_width_mm) : DEFAULT_PAPER_WIDTH_MM;

      var order = await _loadOrder(orderId);
      var rendered = await _renderFor(order, format, locale, paperWidthMm);
      var bytes = Buffer.from(rendered, "utf8");
      var byteSize = bytes.length;
      var sha = b.crypto.sha3Hash(bytes);

      var id = b.uuid.v7();
      await query(
        "INSERT INTO receipt_prints (id, order_id, format, printer_name, locale, " +
        "occurred_at, byte_size, sha3_512) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        [id, orderId, format, printerName, locale, occurredAt, byteSize, sha],
      );

      return {
        id:          id,
        order_id:    orderId,
        format:      format,
        printer_name: printerName,
        locale:      locale,
        occurred_at: occurredAt,
        byte_size:   byteSize,
        sha3_512:    sha,
      };
    },

    printsForOrder: async function (orderId) {
      orderId = _uuid(orderId, "order_id");
      var rows = (await query(
        "SELECT id, order_id, format, printer_name, locale, occurred_at, " +
        "byte_size, sha3_512 FROM receipt_prints WHERE order_id = ?1 " +
        "ORDER BY occurred_at DESC, id DESC",
        [orderId],
      )).rows;
      return rows.map(function (r) {
        return {
          id:           r.id,
          order_id:     r.order_id,
          format:       r.format,
          printer_name: r.printer_name == null ? null : r.printer_name,
          locale:       r.locale,
          occurred_at:  Number(r.occurred_at),
          byte_size:    Number(r.byte_size),
          sha3_512:     r.sha3_512,
        };
      });
    },
  };
}

module.exports = {
  create:                 create,
  VALID_FORMATS:          Object.freeze(Object.keys(VALID_FORMATS)),
  DEFAULT_PAPER_WIDTH_MM: DEFAULT_PAPER_WIDTH_MM,
};
