"use strict";
/**
 * @module shop.packingSlips
 * @title  Packing slips — warehouse pick-verification paperwork
 *
 * @intro
 *   The third post-sale paper artifact, distinct from the other two:
 *
 *     printReceipts     — customer-facing receipt (thermal counter
 *                         slip, email body, A4 PDF receipt). Lives
 *                         outside the box.
 *     invoiceRenderer   — formal accounting invoice with a
 *                         sequential number + tax breakdown + payment
 *                         terms. Travels separately to the buyer's
 *                         AP department.
 *     packingSlips      — warehouse pick-verification slip. Ships
 *                         INSIDE the box. Lists order contents, qty
 *                         per line, an optional gift message +
 *                         recipient name, and a Code-128 barcode of
 *                         the order_id the picker scans against the
 *                         workstation before the seal goes on.
 *
 *   The three surfaces never share render bytes — the slip never
 *   carries the payment intent id, the invoice number, or the
 *   customer's full account history. A gift recipient unboxing the
 *   parcel reads the slip, not the receipt; an operator hardening
 *   gift-order privacy toggles `gift_options.hide_prices` on the
 *   order and the renderer strips every monetary column from the
 *   slip output.
 *
 *   Surface:
 *
 *     renderHtml({ order_id, locale? })
 *       — returns the packing-slip HTML string (self-contained,
 *         inlined CSS, no external assets) suitable for direct
 *         printing or PDF conversion downstream. Locale defaults to
 *         "en"; the catalog ships en / es / de inline with the
 *         standard fallback chain (region falls back to primary
 *         subtag, unknown locales fall back to en).
 *
 *     renderPdfPayload({ order_id, locale?, paper_size? })
 *       — same HTML body as `renderHtml` but wrapped in a `@page`
 *         rule sized for the requested paper. `paper_size` is one of
 *         "letter" (8.5x11in / US warehouse default) or "a4"
 *         (210x297mm / EU + APAC default); defaults to "letter".
 *         Operators with bespoke paper (4x6 thermal labels, A5) wrap
 *         this primitive with their own renderer — the two common
 *         sizes ship here.
 *
 *     recordPrint({ order_id, printer_name, sha3_512, byte_size })
 *       — appends one row to `packing_slip_prints` recording who
 *         printed which slip at which physical printer. The caller
 *         passes pre-computed `sha3_512` + `byte_size` of the bytes
 *         actually handed to the printer (not the renderer output)
 *         so an operator reconciling a "did the right slip print?"
 *         dispute can hash the captured spool and compare against
 *         this row. `printer_name` is required (unlike the receipt
 *         primitive's nullable column) — a slip print without a
 *         named printer is a smoke-test artifact, not a real
 *         warehouse event.
 *
 *     printsForOrder(order_id)
 *       — reads the audit log newest-first. Returns
 *         `[{ id, order_id, printer_name, sha3_512, byte_size,
 *            occurred_at }]`.
 *
 *     enqueueForLocation({ order_id, location_code })
 *       — registers an order as awaiting print at a named
 *         fulfillment location. The pick-list-complete handler is
 *         the natural caller; the row idempotency guard (PRIMARY
 *         KEY on `(order_id, location_code)`) means a double-call
 *         refuses rather than duplicating the slip in the next
 *         batch.
 *
 *     dequeueForLocation({ order_id, location_code })
 *       — removes the queue entry after the warehouse workstation
 *         confirms the slip printed. Returns
 *         `{ dequeued: boolean }`.
 *
 *     bulkRenderForLocation({ location_code, limit? })
 *       — returns up to `limit` (default 50, max 500) oldest-queued
 *         `{ order_id, html }` pairs for the named location. The
 *         queue rows are NOT auto-dequeued — the operator's
 *         workstation calls `dequeueForLocation` after the printer
 *         confirms each slip so a transient printer failure
 *         re-batches the same slips on the next call rather than
 *         dropping them.
 *
 *   Every operator + customer-input field passes through
 *   `b.template.escapeHtml` — operator-input fields (SKU strings,
 *   address lines) and customer-input fields (ship-to, gift
 *   message, recipient name) are equally at risk when the render
 *   surface is HTML; the primitive does not distinguish trust
 *   levels.
 *
 * @related b.template.escapeHtml, b.crypto.sha3Hash, b.guardUuid, b.uuid.v7
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var DEFAULT_PAPER_SIZE = "letter";
var VALID_PAPER_SIZES  = { "letter": true, "a4": true };

var DEFAULT_BULK_LIMIT = 50;
var MAX_BULK_LIMIT     = 500;

// BCP-47 shape: 2-3 alpha primary subtag, optional region/script
// subtags. Mirrors the receipt + invoice surface so the three
// primitives agree on locale shape.
var BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Location code shape mirrors the inventory-locations primitive's
// own CHECK constraint (1..64 chars, free-form text the operator
// assigns to a warehouse / retail / dropship endpoint).
var LOCATION_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// Zero-decimal currencies (rendered as bare integers). Matches the
// receipt + invoice catalogs — the three render surfaces agree.
var ZERO_DECIMAL_CURRENCIES = { "JPY": true, "KRW": true, "VND": true, "CLP": true, "ISK": true };

// Per-locale labels for the warehouse-facing slip header / columns.
// Stable narrow vocabulary; operators wanting a fuller catalog wrap
// this primitive with their own label map.
var LOCALE_LABELS = {
  "en": {
    packing_slip: "Packing slip",
    order:        "Order",
    placed:       "Placed",
    ship_to:      "Ship to",
    item:         "Item",
    sku:          "SKU",
    qty:          "Qty",
    price:        "Price",
    line_total:   "Total",
    subtotal:     "Subtotal",
    discount:     "Discount",
    tax:          "Tax",
    shipping:     "Shipping",
    grand_total:  "Grand total",
    gift_message: "Gift message",
    gift_to:      "To",
    scan_to_verify: "Scan to verify",
  },
  "es": {
    packing_slip: "Albaran",
    order:        "Pedido",
    placed:       "Realizado",
    ship_to:      "Enviar a",
    item:         "Articulo",
    sku:          "SKU",
    qty:          "Cant",
    price:        "Precio",
    line_total:   "Total",
    subtotal:     "Subtotal",
    discount:     "Descuento",
    tax:          "Impuesto",
    shipping:     "Envio",
    grand_total:  "Total general",
    gift_message: "Mensaje de regalo",
    gift_to:      "Para",
    scan_to_verify: "Escanear para verificar",
  },
  "de": {
    packing_slip: "Lieferschein",
    order:        "Bestellung",
    placed:       "Aufgegeben",
    ship_to:      "Versand an",
    item:         "Artikel",
    sku:          "Artikelnr.",
    qty:          "Menge",
    price:        "Preis",
    line_total:   "Summe",
    subtotal:     "Zwischensumme",
    discount:     "Rabatt",
    tax:          "Steuer",
    shipping:     "Versand",
    grand_total:  "Gesamtbetrag",
    gift_message: "Geschenknachricht",
    gift_to:      "An",
    scan_to_verify: "Zur Verifikation scannen",
  },
};

// ---- monotonic clock ---------------------------------------------------
//
// Two `recordPrint` / `enqueueForLocation` calls landing in the same
// millisecond on a fast machine would otherwise share an
// `occurred_at` / `queued_at` value, ambiguating the audit-log sort
// (`printsForOrder`) and the FIFO queue read
// (`bulkRenderForLocation`). Bumping the timestamp by 1ms on a tie
// keeps the timeline strictly increasing so a sort-by-timestamp
// read returns the events in the order they were issued.

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
  catch (e) { throw new TypeError("packingSlips: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _locale(s) {
  if (s == null) return "en";
  if (typeof s !== "string" || !BCP47_RE.test(s)) {
    throw new TypeError("packingSlips: locale must be a BCP-47-shape string (e.g. 'en-US')");
  }
  return s;
}

function _paperSize(s) {
  if (s == null) return DEFAULT_PAPER_SIZE;
  if (typeof s !== "string" || !VALID_PAPER_SIZES[s]) {
    throw new TypeError("packingSlips: paper_size must be one of 'letter', 'a4'");
  }
  return s;
}

function _printerName(s) {
  if (typeof s !== "string" || s.length < 1 || s.length > 256) {
    throw new TypeError("packingSlips: printer_name must be a 1..256 char string");
  }
  return s;
}

function _byteSize(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("packingSlips: byte_size must be a non-negative integer");
  }
  return n;
}

function _sha3(s) {
  if (typeof s !== "string" || s.length !== 128 || !/^[0-9a-f]{128}$/.test(s)) {
    throw new TypeError("packingSlips: sha3_512 must be a 128-char lowercase hex string");
  }
  return s;
}

function _locationCode(s) {
  if (typeof s !== "string" || !LOCATION_CODE_RE.test(s)) {
    throw new TypeError("packingSlips: location_code must match /^[A-Za-z0-9_.-]{1,64}$/");
  }
  return s;
}

function _bulkLimit(n) {
  if (n == null) return DEFAULT_BULK_LIMIT;
  if (!Number.isInteger(n) || n < 1 || n > MAX_BULK_LIMIT) {
    throw new TypeError("packingSlips: limit must be an integer 1.." + MAX_BULK_LIMIT);
  }
  return n;
}

function _resolveLocaleLabels(locale) {
  var lc = locale.toLowerCase();
  if (LOCALE_LABELS[lc]) return LOCALE_LABELS[lc];
  var primary = lc.split("-")[0];
  if (LOCALE_LABELS[primary]) return LOCALE_LABELS[primary];
  return LOCALE_LABELS.en;
}

// ---- shared rendering helpers ------------------------------------------

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
  // YYYY-MM-DD HH:MM UTC — stable across runners, never resorts to
  // locale-aware Date formatting which would shift across host
  // timezones.
  var d = new Date(epochMs);
  function _pad(n) { return n < 10 ? "0" + n : String(n); }
  return d.getUTCFullYear() + "-" + _pad(d.getUTCMonth() + 1) + "-" + _pad(d.getUTCDate()) +
         " " + _pad(d.getUTCHours()) + ":" + _pad(d.getUTCMinutes()) + " UTC";
}

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

// ---- Code-128 barcode renderer -----------------------------------------
//
// Self-contained Code-128 Set B renderer. The slip embeds an inline
// SVG of the order_id so the picker can scan against the workstation
// to verify the right slip joined the right box. Lives here rather
// than reaching into `lib/barcodes.js` because the barcode primitive
// is a SKU registry — assigning + minting barcodes — and the slip
// renders an ad-hoc code over a UUID that never enters that registry.
//
// The SVG is structural-only: no <script>, no <foreignObject>, no
// xlink:href. Safe to embed directly in an HTML / PDF pipeline.

// 0..106 symbol-width patterns. Each pattern is a digit-string of
// alternating bar/space module widths (bar first). Position 106 is
// the STOP symbol (7 widths instead of 6).
var CODE128_PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112",
];

// Code-128 Set B starts at ASCII 0x20 (space → value 0).
function _code128ValueB(ch) { return ch.charCodeAt(0) - 32; }

// Build the module-width bit string for a printable-ASCII payload
// using Set B. Order UUIDs are 36-char [0-9a-f-] strings — well
// inside Set B's printable-ASCII envelope.
function _code128Modules(payload) {
  var symbols = [104];                                          // Start B
  for (var i = 0; i < payload.length; i += 1) {
    symbols.push(_code128ValueB(payload.charAt(i)));
  }
  var sum = symbols[0];
  for (var j = 1; j < symbols.length; j += 1) {
    sum += symbols[j] * j;
  }
  symbols.push(sum % 103);                                      // Check
  symbols.push(106);                                            // Stop
  var modules = "";
  for (var s = 0; s < symbols.length; s += 1) {
    var pat = CODE128_PATTERNS[symbols[s]];
    var bar = true;
    for (var c = 0; c < pat.length; c += 1) {
      var w = parseInt(pat.charAt(c), 10);
      modules += (bar ? "1" : "0").repeat(w);
      bar = !bar;
    }
  }
  return modules;
}

// Paint the module bit-string into an inline <svg>. Pre-escapes the
// human-readable label (the order_id is UUID-shape so no XML metacharacters
// appear, but the escape costs nothing and keeps the renderer composable
// with future payload shapes).
function _renderBarcodeSvg(payload) {
  var modules = _code128Modules(payload);
  var moduleW = 2;
  var heightPx = 60;
  var barH = heightPx - 12;
  var totalW = modules.length * moduleW;
  var bars = "";
  var i = 0;
  while (i < modules.length) {
    if (modules.charAt(i) === "1") {
      var run = 1;
      while (i + run < modules.length && modules.charAt(i + run) === "1") run += 1;
      bars += "<rect x=\"" + (i * moduleW).toFixed(3) + "\" y=\"0\" width=\"" +
              (run * moduleW).toFixed(3) + "\" height=\"" + barH + "\" fill=\"#000\"/>";
      i += run;
    } else {
      i += 1;
    }
  }
  var safe = b.template.escapeHtml(payload);
  var labelXml = "<text x=\"" + (totalW / 2).toFixed(3) + "\" y=\"" + (heightPx - 2) +
                 "\" font-family=\"monospace\" font-size=\"10\" text-anchor=\"middle\" fill=\"#000\">" +
                 safe + "</text>";
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + totalW + "\" height=\"" + heightPx +
         "\" viewBox=\"0 0 " + totalW + " " + heightPx +
         "\" role=\"img\" aria-label=\"barcode\">" +
         "<rect x=\"0\" y=\"0\" width=\"" + totalW + "\" height=\"" + heightPx +
         "\" fill=\"#fff\"/>" + bars + labelXml + "</svg>";
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  if (!opts.order || typeof opts.order.get !== "function") {
    throw new TypeError("packingSlips.create: opts.order primitive is required");
  }
  var orderPrim = opts.order;

  // gift-options is optional — operators without the gift-options
  // primitive wired still get a working slip (no gift message
  // block, no hide-prices toggle). When present, the renderer reads
  // the per-order row via `getForOrder` and applies the toggles.
  var giftOptionsPrim = opts.giftOptions || null;
  if (giftOptionsPrim != null && typeof giftOptionsPrim.getForOrder !== "function") {
    throw new TypeError("packingSlips.create: opts.giftOptions must expose getForOrder when provided");
  }

  async function _loadOrder(orderId) {
    orderId = _uuid(orderId, "order_id");
    var order = await orderPrim.get(orderId);
    if (!order) {
      throw new TypeError("packingSlips: order " + orderId + " not found");
    }
    return order;
  }

  async function _loadGiftOptions(orderId) {
    if (!giftOptionsPrim) return null;
    try {
      var row = await giftOptionsPrim.getForOrder(orderId);
      return row || null;
    } catch (_e) {
      // A wrap_sku referenced by the order may have been archived
      // since the order shipped; the slip render should not break
      // on a stale lookup. Treat any read failure as "no gift
      // options" — the slip degrades to the plain shape.
      return null;
    }
  }

  // ---- render --------------------------------------------------------

  function _renderHtmlBody(order, gift, locale) {
    var labels = _resolveLocaleLabels(locale);
    var escapeHtml = b.template.escapeHtml;
    var hidePrices = !!(gift && gift.hide_prices);

    var shipLinesHtml = _shipToLines(order.ship_to).map(function (line) {
      return "<div>" + escapeHtml(line) + "</div>";
    }).join("");

    // Gift-message block. Customer-authored prose is split on LF so
    // the slip emits one <div> per line; the gift-options primitive
    // already refuses control bytes + zero-width characters at
    // setForOrder time, but the escape pass here is the
    // defense-in-depth layer in case the row was inserted by an
    // operator-side migration that bypassed the validator.
    var giftBlockHtml = "";
    if (gift) {
      var messageLinesHtml = "";
      if (gift.gift_message) {
        var raw = String(gift.gift_message).replace(/\r\n/g, "\n").split("\n");
        while (raw.length && raw[raw.length - 1] === "") raw.pop();
        messageLinesHtml = raw.map(function (line) {
          return "<div>" + escapeHtml(line) + "</div>";
        }).join("");
      }
      var recipientHtml = "";
      if (gift.recipient_name) {
        recipientHtml = "<div><strong>" + escapeHtml(labels.gift_to) + ":</strong> " +
                        escapeHtml(String(gift.recipient_name)) + "</div>";
      }
      if (messageLinesHtml || recipientHtml) {
        giftBlockHtml =
          "<div class=\"gift-block\">\n" +
          "<strong class=\"label\">" + escapeHtml(labels.gift_message) + ":</strong>\n" +
          recipientHtml +
          "<div class=\"gift-message\">" + messageLinesHtml + "</div>\n" +
          "</div>\n";
      }
    }

    // Line items. `hide_prices` strips the Price + Total columns
    // (the gift-receipt pattern); SKU + Item title + Qty always
    // render so the picker can verify against the pick list.
    var rowsHtml = "";
    var orderLines = order.lines || [];
    for (var i = 0; i < orderLines.length; i += 1) {
      var l = orderLines[i];
      var sku = escapeHtml(l.sku || "");
      var qty = escapeHtml(String(l.qty));
      if (hidePrices) {
        rowsHtml +=
          "<tr>" +
          "<td>" + sku + "</td>" +
          "<td class=\"num\">" + qty + "</td>" +
          "</tr>";
      } else {
        var unit = _formatMoney(Number(l.unit_amount_minor || 0), l.unit_currency || order.currency);
        var lineTotal = _formatMoney(Number(l.line_total_minor || 0), l.unit_currency || order.currency);
        rowsHtml +=
          "<tr>" +
          "<td>" + sku + "</td>" +
          "<td class=\"num\">" + qty + "</td>" +
          "<td class=\"num\">" + escapeHtml(unit) + "</td>" +
          "<td class=\"num\">" + escapeHtml(lineTotal) + "</td>" +
          "</tr>";
      }
    }

    var headerCols = hidePrices
      ? ("<th>" + escapeHtml(labels.sku) + "</th>" +
         "<th class=\"num\">" + escapeHtml(labels.qty) + "</th>")
      : ("<th>" + escapeHtml(labels.sku) + "</th>" +
         "<th class=\"num\">" + escapeHtml(labels.qty) + "</th>" +
         "<th class=\"num\">" + escapeHtml(labels.price) + "</th>" +
         "<th class=\"num\">" + escapeHtml(labels.line_total) + "</th>");

    var totalsHtml = "";
    if (!hidePrices) {
      var discountRow = Number(order.discount_minor || 0) > 0
        ? ("<tr><th>" + escapeHtml(labels.discount) + "</th>" +
           "<td class=\"num\">-" + escapeHtml(_formatMoney(Number(order.discount_minor || 0), order.currency)) + "</td></tr>")
        : "";
      totalsHtml =
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
        "</table>\n";
    }

    var barcodeSvg = _renderBarcodeSvg(order.id);

    return "<h1>" + escapeHtml(labels.packing_slip) + "</h1>\n" +
      "<div class=\"meta\">\n" +
      "<div><strong>" + escapeHtml(labels.order) + ":</strong> " + escapeHtml(order.id) + "</div>\n" +
      "<div><strong>" + escapeHtml(labels.placed) + ":</strong> " + escapeHtml(_isoDate(Number(order.created_at))) + "</div>\n" +
      "</div>\n" +
      "<div class=\"ship-to\">\n" +
      "<strong class=\"label\">" + escapeHtml(labels.ship_to) + ":</strong>\n" +
      shipLinesHtml +
      "</div>\n" +
      giftBlockHtml +
      "<table class=\"items\">\n" +
      "<thead><tr>" + headerCols + "</tr></thead>\n" +
      "<tbody>" + rowsHtml + "</tbody>\n" +
      "</table>\n" +
      totalsHtml +
      "<div class=\"barcode\">\n" +
      "<div class=\"barcode-label\">" + escapeHtml(labels.scan_to_verify) + ":</div>\n" +
      barcodeSvg +
      "</div>\n";
  }

  function _wrapDocument(bodyHtml, locale, paperSize) {
    var escapeHtml = b.template.escapeHtml;
    var pageRule = paperSize === "a4"
      ? "@page { size: A4; margin: 18mm; }"
      : "@page { size: letter; margin: 0.75in; }";
    return "<!doctype html>\n" +
      "<html lang=\"" + escapeHtml(locale) + "\">\n" +
      "<head>\n" +
      "<meta charset=\"utf-8\">\n" +
      "<title>" + escapeHtml(_resolveLocaleLabels(locale).packing_slip) + "</title>\n" +
      "<style>\n" +
      pageRule + "\n" +
      "body { font-family: system-ui, sans-serif; color: #111; font-size: 11pt; }\n" +
      "h1 { font-size: 20pt; margin: 0 0 6mm 0; }\n" +
      ".meta { margin-bottom: 6mm; }\n" +
      ".meta div { margin-bottom: 1mm; }\n" +
      ".ship-to { margin-bottom: 6mm; }\n" +
      ".ship-to strong.label { display: block; margin-bottom: 2mm; }\n" +
      ".gift-block { border: 1px dashed #999; padding: 4mm; margin-bottom: 6mm; }\n" +
      ".gift-block strong.label { display: block; margin-bottom: 2mm; }\n" +
      ".gift-message { margin-top: 2mm; font-style: italic; }\n" +
      "table.items { width: 100%; border-collapse: collapse; margin-bottom: 6mm; }\n" +
      "table.items th, table.items td { padding: 2mm 1mm; border-bottom: 1px solid #ddd; text-align: left; }\n" +
      "td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }\n" +
      ".totals { width: auto; margin-left: auto; border-collapse: collapse; margin-bottom: 8mm; }\n" +
      ".totals th { text-align: left; font-weight: normal; padding: 1mm 3mm 1mm 0; }\n" +
      ".totals td { text-align: right; padding: 1mm 0; font-variant-numeric: tabular-nums; }\n" +
      ".totals tr.grand th, .totals tr.grand td { font-weight: bold; border-top: 2px solid #111; }\n" +
      ".barcode { margin-top: 10mm; text-align: center; }\n" +
      ".barcode-label { margin-bottom: 2mm; font-size: 9pt; color: #555; }\n" +
      "</style>\n" +
      "</head>\n" +
      "<body>\n" +
      bodyHtml +
      "</body>\n" +
      "</html>\n";
  }

  // ---- public surface --------------------------------------------------

  return {
    VALID_PAPER_SIZES:   Object.freeze(Object.keys(VALID_PAPER_SIZES)),
    DEFAULT_PAPER_SIZE:  DEFAULT_PAPER_SIZE,
    DEFAULT_BULK_LIMIT:  DEFAULT_BULK_LIMIT,
    MAX_BULK_LIMIT:      MAX_BULK_LIMIT,

    renderHtml: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("packingSlips.renderHtml: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var locale = _locale(input.locale);
      var order = await _loadOrder(orderId);
      var gift = await _loadGiftOptions(orderId);
      var body = _renderHtmlBody(order, gift, locale);
      // Default to letter paper for the bare `renderHtml` call —
      // `renderPdfPayload` is the explicit-paper variant; callers
      // wanting a4 use that surface.
      return _wrapDocument(body, locale, DEFAULT_PAPER_SIZE);
    },

    renderPdfPayload: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("packingSlips.renderPdfPayload: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var locale = _locale(input.locale);
      var paperSize = _paperSize(input.paper_size);
      var order = await _loadOrder(orderId);
      var gift = await _loadGiftOptions(orderId);
      var body = _renderHtmlBody(order, gift, locale);
      return {
        order_id:    orderId,
        paper_size:  paperSize,
        locale:      locale,
        html:        _wrapDocument(body, locale, paperSize),
      };
    },

    recordPrint: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("packingSlips.recordPrint: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var printerName = _printerName(input.printer_name);
      var sha3 = _sha3(input.sha3_512);
      var byteSize = _byteSize(input.byte_size);

      // Verify the order exists upfront — the FK would catch this
      // at INSERT time too, but the upfront read returns a readable
      // error rather than the engine's opaque constraint message.
      await _loadOrder(orderId);

      var id = b.uuid.v7();
      var occurredAt = _now();
      await query(
        "INSERT INTO packing_slip_prints (id, order_id, printer_name, byte_size, " +
        "sha3_512, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, orderId, printerName, byteSize, sha3, occurredAt],
      );
      return {
        id:           id,
        order_id:     orderId,
        printer_name: printerName,
        byte_size:    byteSize,
        sha3_512:     sha3,
        occurred_at:  occurredAt,
      };
    },

    printsForOrder: async function (orderId) {
      orderId = _uuid(orderId, "order_id");
      var rows = (await query(
        "SELECT id, order_id, printer_name, byte_size, sha3_512, occurred_at " +
        "FROM packing_slip_prints WHERE order_id = ?1 " +
        "ORDER BY occurred_at DESC, id DESC",
        [orderId],
      )).rows;
      return rows.map(function (r) {
        return {
          id:           r.id,
          order_id:     r.order_id,
          printer_name: r.printer_name,
          byte_size:    Number(r.byte_size),
          sha3_512:     r.sha3_512,
          occurred_at:  Number(r.occurred_at),
        };
      });
    },

    enqueueForLocation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("packingSlips.enqueueForLocation: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var locationCode = _locationCode(input.location_code);
      await _loadOrder(orderId);
      var queuedAt = _now();
      try {
        await query(
          "INSERT INTO packing_slip_queue (order_id, location_code, queued_at) " +
          "VALUES (?1, ?2, ?3)",
          [orderId, locationCode, queuedAt],
        );
      } catch (e) {
        // Idempotency guard: enqueueing the same (order_id,
        // location_code) twice refuses with a readable message
        // rather than the engine's opaque UNIQUE-violation string.
        if (/UNIQUE|PRIMARY/i.test(String(e && e.message))) {
          throw new TypeError(
            "packingSlips: order " + orderId + " already queued at location " +
            JSON.stringify(locationCode),
          );
        }
        throw e;
      }
      return {
        order_id:      orderId,
        location_code: locationCode,
        queued_at:     queuedAt,
      };
    },

    dequeueForLocation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("packingSlips.dequeueForLocation: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var locationCode = _locationCode(input.location_code);
      var r = await query(
        "DELETE FROM packing_slip_queue WHERE order_id = ?1 AND location_code = ?2",
        [orderId, locationCode],
      );
      return { dequeued: Number(r.rowCount || 0) > 0 };
    },

    bulkRenderForLocation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("packingSlips.bulkRenderForLocation: input object required");
      }
      var locationCode = _locationCode(input.location_code);
      var limit = _bulkLimit(input.limit);

      var rows = (await query(
        "SELECT order_id FROM packing_slip_queue WHERE location_code = ?1 " +
        "ORDER BY queued_at ASC, order_id ASC LIMIT ?2",
        [locationCode, limit],
      )).rows;

      var locale = _locale(input.locale);
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var oid = rows[i].order_id;
        // Defensive: if the order was deleted after the row was
        // queued, skip rather than throw — the operator's batch
        // shouldn't fail on a single orphan. The queue row stays
        // until dequeueForLocation is called so the operator can
        // reconcile.
        var order;
        try { order = await orderPrim.get(oid); }
        catch (_e) { order = null; }
        if (!order) continue;
        var gift = await _loadGiftOptions(oid);
        var body = _renderHtmlBody(order, gift, locale);
        out.push({
          order_id: oid,
          html:     _wrapDocument(body, locale, DEFAULT_PAPER_SIZE),
        });
      }
      return out;
    },

    run: async function () {
      // No-op lifecycle hook. The primitive has no background
      // workers, retries, or sweepers — every surface is request-
      // driven. The async `run()` export exists so a framework-wide
      // boot orchestrator can iterate every primitive uniformly
      // without a per-primitive special case.
      return { ok: true };
    },
  };
}

// Module-level `run()` — same lifecycle hook signature as the
// factory's `run()`. Operators wiring the primitive into a startup
// orchestrator that doesn't yet have a query handle (no DB
// available pre-migrate) can still call this and get a clean
// resolution.
async function run() {
  return { ok: true };
}

module.exports = {
  create:              create,
  run:                 run,
  VALID_PAPER_SIZES:   Object.freeze(Object.keys(VALID_PAPER_SIZES)),
  DEFAULT_PAPER_SIZE:  DEFAULT_PAPER_SIZE,
  DEFAULT_BULK_LIMIT:  DEFAULT_BULK_LIMIT,
  MAX_BULK_LIMIT:      MAX_BULK_LIMIT,
};
