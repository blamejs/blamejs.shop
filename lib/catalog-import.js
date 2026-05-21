"use strict";
/**
 * @module shop.catalogImport
 * @title  Catalog bulk-import — CSV → products + variants + prices + inventory
 *
 * @intro
 *   Operators upload a CSV via the admin API to bulk-create catalog
 *   entries. The importer parses through `b.csv`, content-safety-
 *   filters every cell through `b.guardCsv` (formula-injection /
 *   bidi / control / homoglyph), validates the header row exactly,
 *   then walks rows sequentially. Multiple rows that share a
 *   `product_slug` collapse to one parent product (first occurrence
 *   wins for title / status / description); each row's variant +
 *   price + inventory get attached.
 *
 *   Expected header (exact order):
 *
 *       product_slug,product_title,product_status,product_description,
 *       variant_sku,variant_title,variant_weight_grams,
 *       price_currency,price_amount_minor,inventory_qty
 *
 *   Per-row errors don't abort the import — they're collected as
 *   `{ row_index, message }` and returned alongside the success
 *   counts. Header errors and size-limit refusals throw before any
 *   write happens.
 *
 *   ATOMICITY: D1 doesn't expose multi-row transactions cleanly
 *   across the HTTP bridge, so inserts run sequentially and rely on
 *   the catalog primitive's existing slug + SKU uniqueness for
 *   idempotency. A partial failure leaves partial state — the
 *   operator re-uploads the same CSV to fill in the gaps (rows
 *   already persisted surface as "duplicate slug / SKU" row-errors
 *   on the retry, which is the expected behavior).
 *
 *       var imp = bShop.catalogImport.create({ catalog: catalog });
 *       var result = await imp.importCsv({ csv: csvBytes, dry_run: false });
 *       result.created;   // { products, variants, prices, inventory_rows }
 *       result.errors;    // [{ row_index, message }, ...]
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var EXPECTED_HEADERS = Object.freeze([
  "product_slug",
  "product_title",
  "product_status",
  "product_description",
  "variant_sku",
  "variant_title",
  "variant_weight_grams",
  "price_currency",
  "price_amount_minor",
  "inventory_qty",
]);

var DEFAULT_MAX_BYTES = 1024 * 1024;     // 1 MiB
var DEFAULT_MAX_ROWS  = 10000;

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog) throw new TypeError("catalog-import.create: opts.catalog required");
  var catalog = opts.catalog;

  return {
    importCsv: function (input) { return _importCsv(catalog, input || {}); },
    EXPECTED_HEADERS: EXPECTED_HEADERS,
  };
}

// ---- import driver ------------------------------------------------------

async function _importCsv(catalog, input) {
  var csvInput = input.csv;
  if (csvInput == null) {
    throw new TypeError("catalog-import.importCsv: input.csv required (string, Buffer, or Uint8Array)");
  }
  var maxBytes = input.maxBytes == null ? DEFAULT_MAX_BYTES : input.maxBytes;
  var maxRows  = input.maxRows  == null ? DEFAULT_MAX_ROWS  : input.maxRows;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("catalog-import.importCsv: maxBytes must be a positive integer");
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new TypeError("catalog-import.importCsv: maxRows must be a positive integer");
  }
  var dryRun = input.dry_run === true;

  // Byte-size gate runs against the raw input first — a wrong-file
  // upload (an OS image, a database dump) should refuse before we
  // spend cycles parsing. Buffer.byteLength gives an honest UTF-8
  // length for strings; for Buffer / Uint8Array the .length is the
  // byte count.
  var byteLen;
  if (typeof csvInput === "string") {
    byteLen = Buffer.byteLength(csvInput, "utf8");
  } else if (Buffer.isBuffer(csvInput) || csvInput instanceof Uint8Array) {
    byteLen = csvInput.length;
  } else {
    throw new TypeError("catalog-import.importCsv: input.csv must be string, Buffer, or Uint8Array");
  }
  if (byteLen > maxBytes) {
    throw new TypeError("catalog-import.importCsv: csv exceeds maxBytes (" + maxBytes + " bytes)");
  }

  // Content-safety gate: refuse formula-injection cells, bidi
  // overrides, control bytes, null bytes, dangerous spreadsheet
  // functions. Strict profile rejects rather than sanitizing — the
  // importer is operator-facing infrastructure, and silently
  // mutating a cell value would corrupt the catalog write. The
  // operator fixes the source CSV and re-uploads.
  var guardRv = _b().guardCsv.validate(csvInput, { profile: "strict" });
  if (!guardRv.ok) {
    var kinds = guardRv.issues.map(function (i) { return i.kind; });
    throw new TypeError("catalog-import.importCsv: csv refused by content-safety guard — " + kinds.join(", "));
  }

  // Header-only parse path: header is the first record (header:
  // false so we see the literal first row as an array). Validating
  // the header before any row processes means a typo'd column name
  // refuses before we write the first product.
  var rows;
  try {
    rows = _b().csv.parse(csvInput, {
      header:   false,
      maxBytes: maxBytes,
      maxRows:  maxRows + 1,   // +1 because rows includes the header
      trim:     false,
    });
  } catch (e) {
    throw new TypeError("catalog-import.importCsv: csv parse failed — " + (e && e.message || "malformed"));
  }
  if (!rows.length) {
    throw new TypeError("catalog-import.importCsv: csv contained no rows (header required)");
  }
  var header = rows[0];
  _validateHeader(header);

  var dataRows = rows.slice(1);
  if (dataRows.length > maxRows) {
    throw new TypeError("catalog-import.importCsv: csv exceeds maxRows (" + maxRows + ")");
  }

  // ---- row processing -------------------------------------------------

  var created = { products: 0, variants: 0, prices: 0, inventory_rows: 0 };
  var errors  = [];
  var slugToProductId = Object.create(null);   // slug → product id (created this run OR pre-existing)

  for (var i = 0; i < dataRows.length; i += 1) {
    var rowIndex = i + 2;   // 1-based + header row = first data row at index 2
    var row = dataRows[i];
    try {
      await _processRow(catalog, row, slugToProductId, created, dryRun);
    } catch (e) {
      errors.push({ row_index: rowIndex, message: (e && e.message) || String(e) });
    }
  }

  return {
    created:  created,
    errors:   errors,
    dry_run:  dryRun,
    rows:     dataRows.length,
  };
}

function _validateHeader(header) {
  if (!Array.isArray(header) || header.length !== EXPECTED_HEADERS.length) {
    throw new TypeError(
      "catalog-import.importCsv: header row must have " + EXPECTED_HEADERS.length +
      " columns: " + EXPECTED_HEADERS.join(", ")
    );
  }
  for (var i = 0; i < EXPECTED_HEADERS.length; i += 1) {
    if (header[i] !== EXPECTED_HEADERS[i]) {
      throw new TypeError(
        "catalog-import.importCsv: header column " + (i + 1) +
        " must be " + JSON.stringify(EXPECTED_HEADERS[i]) +
        ", got " + JSON.stringify(header[i])
      );
    }
  }
}

async function _processRow(catalog, row, slugToProductId, created, dryRun) {
  if (!Array.isArray(row) || row.length !== EXPECTED_HEADERS.length) {
    throw new TypeError("row must have " + EXPECTED_HEADERS.length + " columns, got " + (Array.isArray(row) ? row.length : "non-array"));
  }
  var cells = {
    product_slug:         row[0],
    product_title:        row[1],
    product_status:       row[2],
    product_description:  row[3],
    variant_sku:          row[4],
    variant_title:        row[5],
    variant_weight_grams: row[6],
    price_currency:       row[7],
    price_amount_minor:   row[8],
    inventory_qty:        row[9],
  };

  // Numeric parses use parseInt(_, 10). parseInt accepts trailing
  // garbage ("100abc" → 100) so we re-check with Number.isInteger
  // on a strict re-parse to refuse "100abc" outright.
  var weight = _parseIntStrict(cells.variant_weight_grams, "variant_weight_grams");
  var amount = _parseIntStrict(cells.price_amount_minor,   "price_amount_minor");
  var qty    = _parseIntStrict(cells.inventory_qty,        "inventory_qty");

  // Resolve (or create) the parent product.
  var productId = slugToProductId[cells.product_slug];
  if (!productId) {
    // First row for this slug — check if the product already exists
    // (re-upload scenario) before attempting create. bySlug validates
    // the slug shape; a bad slug throws here and surfaces as a row-
    // error.
    var existing = await catalog.products.bySlug(cells.product_slug);
    if (existing) {
      productId = existing.id;
      slugToProductId[cells.product_slug] = productId;
    } else if (dryRun) {
      // Dry-run: validate the product input shape so the operator
      // sees the same row-errors they'd see on a real run, but
      // don't write. Allocate a sentinel slot so subsequent rows
      // sharing this slug don't re-validate the same product.
      _validateProductShape({
        slug:        cells.product_slug,
        title:       cells.product_title,
        status:      cells.product_status,
        description: cells.product_description,
      });
      slugToProductId[cells.product_slug] = "<dry-run>";
      productId = "<dry-run>";
      created.products += 1;
    } else {
      var p = await catalog.products.create({
        slug:        cells.product_slug,
        title:       cells.product_title,
        status:      cells.product_status,
        description: cells.product_description,
      });
      productId = p.id;
      slugToProductId[cells.product_slug] = productId;
      created.products += 1;
    }
  }

  // Variant. The catalog primitive validates sku shape + refuses
  // duplicate SKU at the DB layer.
  if (dryRun) {
    _validateVariantShape({ sku: cells.variant_sku, title: cells.variant_title, weight_grams: weight });
    _validatePriceShape({ currency: cells.price_currency, amount_minor: amount });
    _validateInventoryShape({ sku: cells.variant_sku, stock_on_hand: qty });
    created.variants += 1;
    created.prices += 1;
    created.inventory_rows += 1;
    return;
  }

  var v = await catalog.variants.create(productId, {
    sku:          cells.variant_sku,
    title:        cells.variant_title,
    weight_grams: weight,
  });
  created.variants += 1;

  await catalog.prices.set(v.id, {
    currency:     cells.price_currency,
    amount_minor: amount,
  });
  created.prices += 1;

  await catalog.inventory.create(cells.variant_sku, { stock_on_hand: qty });
  created.inventory_rows += 1;
}

// ---- helpers ------------------------------------------------------------

function _parseIntStrict(s, label) {
  if (typeof s !== "string") {
    throw new TypeError(label + " must be a string-encoded non-negative integer");
  }
  if (!/^\d+$/.test(s)) {
    throw new TypeError(label + " must be a non-negative integer, got " + JSON.stringify(s));
  }
  var n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(label + " must be a non-negative integer, got " + JSON.stringify(s));
  }
  return n;
}

// Dry-run validators mirror the catalog primitive's input shape
// checks without touching the DB. They throw the same TypeError
// shape so the row-error message reads identically to a wet run.
function _validateProductShape(input) {
  if (typeof input.slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/.test(input.slug)) {
    throw new TypeError("catalog: slug must match /^[a-z0-9][a-z0-9-]*[a-z0-9]?$/ (lowercase alnum + hyphen, ≤ 200 chars)");
  }
  if (typeof input.title !== "string" || !input.title.length || input.title.length > 500) {
    throw new TypeError("catalog: title must be a non-empty string ≤ 500 chars");
  }
  if (["draft", "active", "archived"].indexOf(input.status) === -1) {
    throw new TypeError("catalog: status must be one of draft, active, archived, got " + JSON.stringify(input.status));
  }
}
function _validateVariantShape(input) {
  if (typeof input.sku !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.sku)) {
    throw new TypeError("catalog: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
  if (typeof input.title !== "string" || input.title.length > 500) {
    throw new TypeError("catalog.variants.create: title must be a string ≤ 500 chars");
  }
  if (!Number.isInteger(input.weight_grams) || input.weight_grams < 0) {
    throw new TypeError("catalog: weight_grams must be a non-negative integer");
  }
}
function _validatePriceShape(input) {
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new TypeError("catalog: currency must be a 3-letter ISO 4217 code (uppercase), got " + JSON.stringify(input.currency));
  }
  if (!Number.isInteger(input.amount_minor) || input.amount_minor < 0) {
    throw new TypeError("catalog: amount_minor must be a non-negative integer");
  }
}
function _validateInventoryShape(input) {
  if (typeof input.sku !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.sku)) {
    throw new TypeError("catalog: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
  if (!Number.isInteger(input.stock_on_hand) || input.stock_on_hand < 0) {
    throw new TypeError("catalog: stock_on_hand must be a non-negative integer");
  }
}

module.exports = {
  create:           create,
  EXPECTED_HEADERS: EXPECTED_HEADERS,
  DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS:  DEFAULT_MAX_ROWS,
};
