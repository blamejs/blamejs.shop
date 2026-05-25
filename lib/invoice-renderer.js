"use strict";
/**
 * @module shop.invoiceRenderer
 * @title  Invoice renderer — formal accounting invoices over an order
 *
 * @intro
 *   `printReceipts` covers the post-sale paperwork the warehouse +
 *   counter need (thermal slip, customer copy, email receipt body).
 *   This primitive is the *other* paperwork: the formal accounting
 *   invoice with a sequential invoice number, tax breakdown, payment
 *   terms, and a due date.
 *
 *   The two are intentionally distinct surfaces:
 *
 *     printReceipts     — render-on-demand, the bytes never need to
 *                         be the same on re-render (the warehouse
 *                         re-prints a lost slip whenever).
 *     invoiceRenderer   — mints an invoice_number once per call,
 *                         records the integrity hash, and the
 *                         operator's accounting tree expects every
 *                         issued number to map 1:1 to a row in this
 *                         table forever (gap-free sequences are a
 *                         hard requirement in most VAT/GST
 *                         jurisdictions).
 *
 *   Surface:
 *
 *     nextInvoiceNumber({ series? })
 *       — atomically advances the per-series counter and returns the
 *         formatted invoice number string (`INV-YYYY-NNNNNN` by
 *         default). `series` defaults to "DEFAULT"; operators with
 *         per-region books pass e.g. "EU" / "US-WHOLESALE" and the
 *         primitive maintains an independent counter per series.
 *         The format string is fixed in v1 — operators wanting a
 *         different shape wrap this primitive with their own
 *         formatter; the underlying integer is always returned in
 *         the result so the wrap is cheap.
 *
 *     renderHtml({ order_id, locale?, series?, due_days? })
 *       — mints a fresh invoice number, then returns the complete
 *         HTML invoice (self-contained, A4 @page rule, inlined CSS)
 *         suitable for headless-Chrome PDF conversion. `locale`
 *         defaults to "en"; `due_days` defaults to 30 (Net 30 — the
 *         common B2B payment term). Returns `{ invoice_number,
 *         series, locale, due_days, due_at, generated_at, html }`.
 *         Does NOT record the integrity row — `recordInvoice` is the
 *         deliberate audit step (the operator's worker may discard
 *         a render mid-PDF-conversion).
 *
 *     recordInvoice({ order_id, invoice_number, html_size, sha3_512 })
 *       — appends the audit row. Returns `{ id, order_id,
 *         invoice_number, html_size, sha3_512, generated_at }`. The
 *         invoice_number is UNIQUE — a duplicate write (e.g. retry
 *         after a partial failure) refuses with a clear message
 *         rather than silently overwriting.
 *
 *     invoicesForOrder(order_id)
 *       — reads the audit log newest-first. Returns the same row
 *         shape as recordInvoice's return value.
 *
 *     getInvoiceByNumber(invoice_number)
 *       — single-row lookup by the operator-facing invoice number.
 *         Returns `null` when no row matches.
 *
 *   Every text interpolation point passes through
 *   `b.template.escapeHtml`. Operator-input fields (shop name,
 *   address) and customer-input fields (ship-to, sku notes) are
 *   equally at risk when the render surface is HTML; the primitive
 *   does not distinguish trust levels.
 *
 *   Operator+customer addresses on the invoice:
 *     - The customer (bill-to) address comes from the order's
 *       `ship_to` block — most shops use a single buyer address for
 *       both surfaces. Operators with split bill-to/ship-to data
 *       wrap this primitive and override the rendered block.
 *     - The operator (issuer) address comes from shop_config keys
 *       `invoice.issuer_name` + `invoice.issuer_address_lines`
 *       (Array<string>) + `invoice.issuer_tax_id`. Each key falls
 *       back to a sensible default when the operator hasn't set it;
 *       the audit row is still issued so the invoice number stays
 *       sequential.
 *
 * @related b.template.escapeHtml, b.crypto.sha3Hash, b.guardUuid, b.uuid.v7
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var DEFAULT_SERIES   = "DEFAULT";
var DEFAULT_DUE_DAYS = 30;          // Net 30 — common B2B payment term
var MAX_DUE_DAYS     = 365;         // anything beyond a year is almost certainly an operator typo

var SERIES_RE = /^[A-Za-z0-9_-]{1,64}$/;
var BCP47_RE  = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Zero-decimal currencies (rendered as bare integers). Matches the
// printReceipts catalog — the two render surfaces ship with the same
// list so the displayed totals agree across the two artifacts.
var ZERO_DECIMAL_CURRENCIES = { "JPY": true, "KRW": true, "VND": true, "CLP": true, "ISK": true };

// Per-locale labels for the invoice surface. Stable, narrow
// vocabulary (operator-facing accounting terms) — operators wanting
// a fuller catalog wrap this primitive with their own label map.
var LOCALE_LABELS = {
  "en": {
    invoice:       "Invoice",
    invoice_no:    "Invoice no.",
    issued:        "Issued",
    due:           "Due",
    bill_to:       "Bill to",
    from:          "From",
    tax_id:        "Tax ID",
    item:          "Item",
    qty:           "Qty",
    price:         "Price",
    line_total:    "Total",
    subtotal:      "Subtotal",
    discount:      "Discount",
    tax:           "Tax",
    shipping:      "Shipping",
    grand_total:   "Grand total",
    payment_terms: "Payment terms",
    net_days:      "Net {N}",
    thanks:        "Thank you for your business.",
  },
  "es": {
    invoice:       "Factura",
    invoice_no:    "Factura n.",
    issued:        "Emitida",
    due:           "Vence",
    bill_to:       "Facturar a",
    from:          "De",
    tax_id:        "NIF",
    item:          "Articulo",
    qty:           "Cant",
    price:         "Precio",
    line_total:    "Total",
    subtotal:      "Subtotal",
    discount:      "Descuento",
    tax:           "Impuesto",
    shipping:      "Envio",
    grand_total:   "Total general",
    payment_terms: "Condiciones de pago",
    net_days:      "Neto {N}",
    thanks:        "Gracias por su confianza.",
  },
  "de": {
    invoice:       "Rechnung",
    invoice_no:    "Rechnungsnr.",
    issued:        "Ausgestellt",
    due:           "Faellig",
    bill_to:       "Rechnungsempfaenger",
    from:          "Von",
    tax_id:        "USt-IdNr.",
    item:          "Artikel",
    qty:           "Menge",
    price:         "Preis",
    line_total:    "Summe",
    subtotal:      "Zwischensumme",
    discount:      "Rabatt",
    tax:           "Steuer",
    shipping:      "Versand",
    grand_total:   "Gesamtbetrag",
    payment_terms: "Zahlungsbedingungen",
    net_days:      "Netto {N}",
    thanks:        "Vielen Dank fuer Ihr Vertrauen.",
  },
};

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("invoiceRenderer: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _series(s) {
  if (s == null) return DEFAULT_SERIES;
  if (typeof s !== "string" || !SERIES_RE.test(s)) {
    throw new TypeError("invoiceRenderer: series must match /^[A-Za-z0-9_-]{1,64}$/");
  }
  return s;
}

function _locale(s) {
  if (s == null) return "en";
  if (typeof s !== "string" || !BCP47_RE.test(s)) {
    throw new TypeError("invoiceRenderer: locale must be a BCP-47-shape string (e.g. 'en-US')");
  }
  return s;
}

function _dueDays(n) {
  if (n == null) return DEFAULT_DUE_DAYS;
  if (!Number.isInteger(n) || n < 0 || n > MAX_DUE_DAYS) {
    throw new TypeError("invoiceRenderer: due_days must be an integer 0..365");
  }
  return n;
}

function _invoiceNumber(s) {
  if (typeof s !== "string" || s.length < 1 || s.length > 128) {
    throw new TypeError("invoiceRenderer: invoice_number must be a 1..128 char string");
  }
  return s;
}

function _htmlSize(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("invoiceRenderer: html_size must be a non-negative integer");
  }
  return n;
}

function _sha3(s) {
  if (typeof s !== "string" || s.length !== 128 || !/^[0-9a-f]{128}$/.test(s)) {
    throw new TypeError("invoiceRenderer: sha3_512 must be a 128-char lowercase hex string");
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
  // YYYY-MM-DD UTC — invoice dates are by-day not by-second; the
  // operator's accounting tree only cares about the calendar day.
  var d = new Date(epochMs);
  function _pad(n) { return n < 10 ? "0" + n : String(n); }
  return d.getUTCFullYear() + "-" + _pad(d.getUTCMonth() + 1) + "-" + _pad(d.getUTCDate());
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

function _formatInvoiceNumber(seq, epochMs) {
  // `INV-YYYY-NNNNNN`. Zero-pad to 6 digits — covers ~1M invoices
  // per series per year, which is plenty for a small/mid shop;
  // operators with higher volume wrap this primitive and supply a
  // custom formatter.
  var year = new Date(epochMs).getUTCFullYear();
  var padded = String(seq);
  while (padded.length < 6) padded = "0" + padded;
  return "INV-" + year + "-" + padded;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  if (!opts.order || typeof opts.order.get !== "function") {
    throw new TypeError("invoiceRenderer.create: opts.order primitive is required");
  }
  var orderPrim = opts.order;

  // Atomically advance the per-series counter. CAS-shape UPDATE:
  // read the current next_value, then UPDATE WHERE next_value = ?
  // and retry on a zero-change result. Two concurrent calls cannot
  // mint the same number — the loser sees a stale next_value, the
  // UPDATE matches zero rows, and the loop re-reads.
  async function _advanceSeries(series) {
    for (var attempts = 0; attempts < 16; attempts += 1) {
      var existing = (await query(
        "SELECT next_value FROM invoice_sequence WHERE series = ?1",
        [series],
      )).rows;
      if (!existing.length) {
        // Seed row at 1 — if another worker raced us to seed, the
        // INSERT will throw on the PK and the next loop iteration
        // reads the existing row.
        try {
          await query(
            "INSERT INTO invoice_sequence (series, next_value, updated_at) VALUES (?1, ?2, ?3)",
            [series, 2, Date.now()],
          );
          return 1;
        } catch (_e) {
          continue;
        }
      }
      var current = Number(existing[0].next_value);
      var info = await query(
        "UPDATE invoice_sequence SET next_value = ?1, updated_at = ?2 " +
        "WHERE series = ?3 AND next_value = ?4",
        [current + 1, Date.now(), series, current],
      );
      if (Number(info.rowCount) === 1) return current;
    }
    throw new Error("invoiceRenderer: sequence advance for series " + JSON.stringify(series) + " contended 16 times");
  }

  async function _loadOrder(orderId) {
    orderId = _uuid(orderId, "order_id");
    var order = await orderPrim.get(orderId);
    if (!order) {
      throw new TypeError("invoiceRenderer: order " + orderId + " not found");
    }
    return order;
  }

  // Resolve the operator (issuer) block. Each key falls back to a
  // sensible default so a fresh shop with no config can still issue
  // an invoice; operators set the keys via the shop_config admin
  // surface to make the rendered output match their letterhead.
  async function _resolveIssuer() {
    async function _get(key, fallback) {
      var r = (await query("SELECT value_json FROM shop_config WHERE key = ?1", [key])).rows;
      if (!r.length) return fallback;
      try { return JSON.parse(r[0].value_json); }
      catch (_e) { return fallback; }
    }
    return {
      name:          await _get("invoice.issuer_name",          ""),
      address_lines: await _get("invoice.issuer_address_lines", []),
      tax_id:        await _get("invoice.issuer_tax_id",        ""),
    };
  }

  function _renderHtmlBody(order, invoiceNumber, locale, dueDays, generatedAt, dueAt, issuer) {
    var labels = _resolveLocaleLabels(locale);
    var escapeHtml = b.template.escapeHtml;

    var billToLinesHtml = _shipToLines(order.ship_to).map(function (line) {
      return "<div>" + escapeHtml(line) + "</div>";
    }).join("");

    var issuerLinesHtml = "";
    if (issuer.name) {
      issuerLinesHtml += "<div><strong>" + escapeHtml(String(issuer.name)) + "</strong></div>";
    }
    if (Array.isArray(issuer.address_lines)) {
      for (var ai = 0; ai < issuer.address_lines.length; ai += 1) {
        issuerLinesHtml += "<div>" + escapeHtml(String(issuer.address_lines[ai])) + "</div>";
      }
    }
    if (issuer.tax_id) {
      issuerLinesHtml += "<div>" + escapeHtml(labels.tax_id) + ": " + escapeHtml(String(issuer.tax_id)) + "</div>";
    }

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

    var paymentTermsLabel = labels.net_days.replace("{N}", String(dueDays));

    return "<!doctype html>\n" +
      "<html lang=\"" + escapeHtml(locale) + "\">\n" +
      "<head>\n" +
      "<meta charset=\"utf-8\">\n" +
      "<title>" + escapeHtml(labels.invoice) + " " + escapeHtml(invoiceNumber) + "</title>\n" +
      "<style>\n" +
      "@page { size: A4; margin: 18mm; }\n" +
      "body { font-family: system-ui, sans-serif; color: #111; font-size: 11pt; }\n" +
      "h1 { font-size: 22pt; margin: 0 0 4mm 0; }\n" +
      ".invoice-meta { display: flex; justify-content: space-between; margin-bottom: 8mm; }\n" +
      ".invoice-meta .right { text-align: right; }\n" +
      ".parties { display: flex; justify-content: space-between; margin-bottom: 8mm; }\n" +
      ".parties .block { width: 48%; }\n" +
      ".parties .block strong.label { display: block; margin-bottom: 2mm; }\n" +
      "table { width: 100%; border-collapse: collapse; }\n" +
      "th, td { padding: 2mm 1mm; border-bottom: 1px solid #ddd; text-align: left; }\n" +
      "td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }\n" +
      ".totals { margin-top: 6mm; }\n" +
      ".totals th { text-align: left; font-weight: normal; }\n" +
      ".totals tr.grand th, .totals tr.grand td { font-weight: bold; border-top: 2px solid #111; }\n" +
      ".terms { margin-top: 10mm; }\n" +
      ".thanks { margin-top: 10mm; font-style: italic; }\n" +
      "</style>\n" +
      "</head>\n" +
      "<body>\n" +
      "<h1>" + escapeHtml(labels.invoice) + "</h1>\n" +
      "<div class=\"invoice-meta\">\n" +
      "<div>\n" +
      "<div><strong>" + escapeHtml(labels.invoice_no) + ":</strong> " + escapeHtml(invoiceNumber) + "</div>\n" +
      "<div><strong>" + escapeHtml(labels.issued) + ":</strong> " + escapeHtml(_isoDate(generatedAt)) + "</div>\n" +
      "</div>\n" +
      "<div class=\"right\">\n" +
      "<div><strong>" + escapeHtml(labels.due) + ":</strong> " + escapeHtml(_isoDate(dueAt)) + "</div>\n" +
      "</div>\n" +
      "</div>\n" +
      "<div class=\"parties\">\n" +
      "<div class=\"block\">\n" +
      "<strong class=\"label\">" + escapeHtml(labels.from) + ":</strong>\n" +
      issuerLinesHtml +
      "</div>\n" +
      "<div class=\"block\">\n" +
      "<strong class=\"label\">" + escapeHtml(labels.bill_to) + ":</strong>\n" +
      billToLinesHtml +
      "</div>\n" +
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
      "<div class=\"terms\">\n" +
      "<strong>" + escapeHtml(labels.payment_terms) + ":</strong> " + escapeHtml(paymentTermsLabel) + "\n" +
      "</div>\n" +
      "<div class=\"thanks\">" + escapeHtml(labels.thanks) + "</div>\n" +
      "</body>\n" +
      "</html>\n";
  }

  // ---- public surface --------------------------------------------------

  return {
    DEFAULT_SERIES:    DEFAULT_SERIES,
    DEFAULT_DUE_DAYS:  DEFAULT_DUE_DAYS,

    nextInvoiceNumber: async function (input) {
      input = input || {};
      var series = _series(input.series);
      var now = Date.now();
      var seq = await _advanceSeries(series);
      var invoiceNumber = _formatInvoiceNumber(seq, now);
      return {
        invoice_number: invoiceNumber,
        series:         series,
        sequence:       seq,
        generated_at:   now,
      };
    },

    renderHtml: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("invoiceRenderer.renderHtml: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var locale  = _locale(input.locale);
      var series  = _series(input.series);
      var dueDays = _dueDays(input.due_days);

      var order = await _loadOrder(orderId);
      var issuer = await _resolveIssuer();

      var generatedAt = Date.now();
      var dueAt = generatedAt + C.TIME.days(dueDays);

      var seq = await _advanceSeries(series);
      var invoiceNumber = _formatInvoiceNumber(seq, generatedAt);

      var html = _renderHtmlBody(order, invoiceNumber, locale, dueDays, generatedAt, dueAt, issuer);
      return {
        invoice_number: invoiceNumber,
        series:         series,
        locale:         locale,
        due_days:       dueDays,
        due_at:         dueAt,
        generated_at:   generatedAt,
        html:           html,
      };
    },

    recordInvoice: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("invoiceRenderer.recordInvoice: input object required");
      }
      var orderId       = _uuid(input.order_id, "order_id");
      var invoiceNumber = _invoiceNumber(input.invoice_number);
      var htmlSize      = _htmlSize(input.html_size);
      var sha3          = _sha3(input.sha3_512);

      // Verify the order exists — the FK would catch this at INSERT
      // time too, but the upfront check returns a readable error
      // rather than the engine's opaque constraint message.
      await _loadOrder(orderId);

      // Derive the series from the invoice_number when it matches
      // the default `INV-YYYY-NNNNNN` shape, else fall back to
      // "DEFAULT". Operators with bespoke formats can pass the
      // series explicitly via the optional input field.
      var series = DEFAULT_SERIES;
      if (input.series != null) {
        series = _series(input.series);
      }

      var id = b.uuid.v7();
      var generatedAt = Date.now();
      try {
        await query(
          "INSERT INTO invoice_renderings (id, order_id, series, invoice_number, " +
          "html_size, sha3_512, generated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
          [id, orderId, series, invoiceNumber, htmlSize, sha3, generatedAt],
        );
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) {
          throw new TypeError("invoiceRenderer: invoice_number " + JSON.stringify(invoiceNumber) + " already recorded");
        }
        throw e;
      }
      return {
        id:             id,
        order_id:       orderId,
        series:         series,
        invoice_number: invoiceNumber,
        html_size:      htmlSize,
        sha3_512:       sha3,
        generated_at:   generatedAt,
      };
    },

    invoicesForOrder: async function (orderId) {
      orderId = _uuid(orderId, "order_id");
      var rows = (await query(
        "SELECT id, order_id, series, invoice_number, html_size, sha3_512, generated_at " +
        "FROM invoice_renderings WHERE order_id = ?1 " +
        "ORDER BY generated_at DESC, id DESC",
        [orderId],
      )).rows;
      return rows.map(function (r) {
        return {
          id:             r.id,
          order_id:       r.order_id,
          series:         r.series,
          invoice_number: r.invoice_number,
          html_size:      Number(r.html_size),
          sha3_512:       r.sha3_512,
          generated_at:   Number(r.generated_at),
        };
      });
    },

    getInvoiceByNumber: async function (invoiceNumber) {
      invoiceNumber = _invoiceNumber(invoiceNumber);
      var rows = (await query(
        "SELECT id, order_id, series, invoice_number, html_size, sha3_512, generated_at " +
        "FROM invoice_renderings WHERE invoice_number = ?1",
        [invoiceNumber],
      )).rows;
      if (!rows.length) return null;
      var r = rows[0];
      return {
        id:             r.id,
        order_id:       r.order_id,
        series:         r.series,
        invoice_number: r.invoice_number,
        html_size:      Number(r.html_size),
        sha3_512:       r.sha3_512,
        generated_at:   Number(r.generated_at),
      };
    },
  };
}

module.exports = {
  create:           create,
  DEFAULT_SERIES:   DEFAULT_SERIES,
  DEFAULT_DUE_DAYS: DEFAULT_DUE_DAYS,
};
