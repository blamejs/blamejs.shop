"use strict";
/**
 * @module shop.productImport
 * @title  Product bulk-import — operator-managed loader for products
 *         + variants + prices + media across CSV / Shopify-JSON /
 *         native shapes.
 *
 * @intro
 *   Operators upload a CSV, a Shopify products-export JSON file, or
 *   the canonical native shape this primitive emits back from
 *   `lastReport()`. The driver parses → validates → dedupes by SKU →
 *   resolves the on-conflict policy → writes through the catalog
 *   primitive → records a run row in `product_imports` and one row
 *   per refused input in `product_import_errors`.
 *
 *   Distinct from the existing `catalogImport` primitive — that one
 *   is a thin synchronous CSV → catalog.products adapter intended
 *   for the admin "paste a small CSV" path. `productImport` is the
 *   long-running, operator-managed bulk loader: persistent state in
 *   the DB across the lifetime of the run, structured per-row error
 *   reporting, multi-format input, and cancel-mid-run support.
 *
 *   Surfaces:
 *
 *     create({ query?, catalog }) — factory. `query` defaults to
 *       `b.externalDb.query` at runtime; tests inject a query bound
 *       to an in-memory SQLite. `catalog` is the catalog primitive
 *       instance the importer writes through (so the importer
 *       inherits every input validation the catalog enforces).
 *
 *     dryRun({ rows, format })
 *       Validates the input without writing anything to the catalog.
 *       Returns the same outcome report shape `importRows` produces,
 *       with every counter incremented as if the write happened.
 *       The run row + per-row errors are still recorded so the
 *       operator console can inspect a dry-run before committing.
 *
 *     importRows({ rows, format, on_conflict })
 *       The driver. `rows` is the in-memory row collection
 *       (parsed CSV array-of-arrays, Shopify-JSON product objects,
 *       or native product objects). `format` ∈ flat_csv /
 *       shopify_json / blamejs_native. `on_conflict` ∈ update /
 *       skip / error — controls the duplicate-SKU policy.
 *
 *     importFromCsv(stream, opts)
 *     importFromJson(stream, opts)
 *       Stream wrappers — fully consume the stream (string,
 *       Buffer, Uint8Array, or Node Readable) and route through
 *       `importRows`. The stream is bounded by `maxBytes`
 *       (default 16 MiB); larger inputs throw before any write.
 *
 *     lastReport()
 *       The outcome of the most recent run on this factory
 *       instance. Survives until the next driver call.
 *
 *     cancelInflight()
 *       Signals the running driver to stop after the current row.
 *       Already-persisted rows stay; the run row transitions to
 *       `cancelled`; remaining rows are counted in `rows_skipped`.
 *
 *     listImports({ status?, from?, to? })
 *     errorsForImport(import_id)
 *       Operator-console reads against the persisted run + error
 *       state.
 *
 *   Per-row errors don't abort the import. They're collected in
 *   `product_import_errors` and counted against `rows_errored`. The
 *   driver only aborts (status = `failed`) when the input itself
 *   refuses parse / shape validation before any row processes.
 *
 *   Atomicity: D1 doesn't expose multi-row transactions across the
 *   HTTP bridge, so the driver inserts sequentially. A partial
 *   failure leaves partial state; the operator re-uploads with
 *   `on_conflict: update` to reconcile.
 *
 *   Composes:
 *     - b.csv         — RFC-4180 parse of flat_csv inputs.
 *     - b.guardCsv    — formula-injection / bidi / control-byte
 *                       refusal applied to every CSV cell.
 *     - b.guardJson   — depth + size + duplicate-key refusal applied
 *                       to JSON inputs.
 *     - b.uuid.v7     — run id + error row id.
 *     - b.guardUuid   — strict UUID validation for errorsForImport.
 */

var b = require("./vendor/blamejs");

var FORMATS       = Object.freeze(["flat_csv", "shopify_json", "blamejs_native"]);
var ON_CONFLICTS  = Object.freeze(["update", "skip", "error"]);
var STATUSES      = Object.freeze(["running", "complete", "failed", "cancelled"]);

var DEFAULT_MAX_BYTES = 16 * 1024 * 1024;   // 16 MiB
var DEFAULT_MAX_ROWS  = 100000;
var MAX_ERROR_DETAIL  = 4000;

// flat_csv header. Operator's CSV must match this exact column order
// — anything else refuses with a header-shape error before any row
// processes.
var FLAT_CSV_HEADER = Object.freeze([
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
  "media_r2_key",
  "media_content_type",
  "media_alt_text",
]);

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog) {
    throw new TypeError("product-import.create: opts.catalog required");
  }
  var catalog = opts.catalog;
  var query;
  if (opts.query) {
    query = opts.query;
  } else {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Per-factory mutable state. `lastReport()` returns the most-
  // recently-completed run; `cancelInflight()` flips a flag the
  // driver re-reads between rows.
  var state = {
    lastReport:    null,
    cancelFlag:    false,
    inflightId:    null,
  };

  return {
    dryRun: function (input) {
      return _drive(query, catalog, state, input || {}, { dryRun: true });
    },
    importRows: function (input) {
      return _drive(query, catalog, state, input || {}, { dryRun: false });
    },
    importFromCsv: function (stream, csvOpts) {
      return _importFromCsv(query, catalog, state, stream, csvOpts || {});
    },
    importFromJson: function (stream, jsonOpts) {
      return _importFromJson(query, catalog, state, stream, jsonOpts || {});
    },
    lastReport: function () { return state.lastReport; },
    cancelInflight: function () {
      // Drop-silent when nothing is inflight — the operator console
      // races cancel against natural completion; refusing here would
      // surface a transient race as a hard error.
      if (state.inflightId) state.cancelFlag = true;
      return state.inflightId;
    },
    listImports: function (listOpts) {
      return _listImports(query, listOpts || {});
    },
    errorsForImport: function (importId) {
      return _errorsForImport(query, importId);
    },
    FORMATS:        FORMATS,
    ON_CONFLICTS:   ON_CONFLICTS,
    FLAT_CSV_HEADER: FLAT_CSV_HEADER,
  };
}

// ---- stream wrappers ----------------------------------------------------

async function _importFromCsv(query, catalog, state, stream, csvOpts) {
  var bytes = await _consumeStream(stream, csvOpts.maxBytes);
  // Content-safety gate runs against the raw bytes before parse —
  // formula-injection / bidi / control-byte refusal applies to
  // every cell, refusing the upload outright rather than mutating.
  var guardRv = b.guardCsv.validate(bytes, { profile: "strict" });
  if (!guardRv.ok) {
    var kinds = guardRv.issues.map(function (i) { return i.kind; });
    throw new TypeError(
      "product-import.importFromCsv: csv refused by content-safety guard — " +
      kinds.join(", ")
    );
  }
  var maxRows = csvOpts.maxRows == null ? DEFAULT_MAX_ROWS : csvOpts.maxRows;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new TypeError("product-import.importFromCsv: maxRows must be a positive integer");
  }
  var parsed;
  try {
    parsed = b.csv.parse(bytes, {
      header:   false,
      maxBytes: bytes.length + 1,
      maxRows:  maxRows + 1,
      trim:     false,
    });
  } catch (e) {
    throw new TypeError(
      "product-import.importFromCsv: csv parse failed — " +
      ((e && e.message) || "malformed")
    );
  }
  return _drive(query, catalog, state, {
    rows:        parsed,
    format:      "flat_csv",
    on_conflict: csvOpts.on_conflict,
  }, { dryRun: csvOpts.dry_run === true, inputByteCount: bytes.length });
}

async function _importFromJson(query, catalog, state, stream, jsonOpts) {
  var bytes = await _consumeStream(stream, jsonOpts.maxBytes);
  var text  = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  // guardJson refuses depth / size / duplicate-key shapes; the
  // operator CSV-equivalent for JSON inputs. Returns the parsed
  // tree on success.
  var parsed;
  try {
    parsed = b.guardJson.parse(text, { profile: "strict" });
  } catch (e) {
    throw new TypeError(
      "product-import.importFromJson: json refused — " +
      ((e && e.message) || "malformed")
    );
  }
  var format = jsonOpts.format == null ? "blamejs_native" : jsonOpts.format;
  if (FORMATS.indexOf(format) === -1 || format === "flat_csv") {
    throw new TypeError(
      "product-import.importFromJson: format must be one of " +
      "shopify_json, blamejs_native — got " + JSON.stringify(format)
    );
  }
  var rows;
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && Array.isArray(parsed.products)) {
    rows = parsed.products;
  } else {
    throw new TypeError(
      "product-import.importFromJson: json must be an array of products " +
      "or an object with a `products` array"
    );
  }
  return _drive(query, catalog, state, {
    rows:        rows,
    format:      format,
    on_conflict: jsonOpts.on_conflict,
  }, { dryRun: jsonOpts.dry_run === true, inputByteCount: bytes.length });
}

// Stream consumer — accepts string / Buffer / Uint8Array / Node
// Readable. Bounds at `maxBytes` so a runaway stream can't OOM the
// process. The byte cap is the only defense; the input shape is
// validated downstream.
async function _consumeStream(stream, maxBytes) {
  var cap = maxBytes == null ? DEFAULT_MAX_BYTES : maxBytes;
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new TypeError("product-import: maxBytes must be a positive integer");
  }
  if (typeof stream === "string") {
    var buf = Buffer.from(stream, "utf8");
    if (buf.length > cap) {
      throw new TypeError("product-import: input exceeds maxBytes (" + cap + " bytes)");
    }
    return buf;
  }
  if (Buffer.isBuffer(stream)) {
    if (stream.length > cap) {
      throw new TypeError("product-import: input exceeds maxBytes (" + cap + " bytes)");
    }
    return stream;
  }
  if (stream instanceof Uint8Array) {
    if (stream.length > cap) {
      throw new TypeError("product-import: input exceeds maxBytes (" + cap + " bytes)");
    }
    return Buffer.from(stream);
  }
  if (stream && typeof stream.on === "function") {
    return await new Promise(function (resolve, reject) {
      var chunks = [];
      var size = 0;
      stream.on("data", function (c) {
        var chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
        size += chunk.length;
        if (size > cap) {
          reject(new TypeError("product-import: input exceeds maxBytes (" + cap + " bytes)"));
          stream.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end",   function () { resolve(Buffer.concat(chunks, size)); });
      stream.on("error", reject);
    });
  }
  throw new TypeError(
    "product-import: stream must be a string, Buffer, Uint8Array, or Node Readable"
  );
}

// ---- driver -------------------------------------------------------------

async function _drive(query, catalog, state, input, driveOpts) {
  var dryRun = driveOpts.dryRun === true;
  var format = input.format;
  if (FORMATS.indexOf(format) === -1) {
    throw new TypeError(
      "product-import: format must be one of " + FORMATS.join(", ") +
      " — got " + JSON.stringify(format)
    );
  }
  var onConflict = input.on_conflict == null ? "error" : input.on_conflict;
  if (ON_CONFLICTS.indexOf(onConflict) === -1) {
    throw new TypeError(
      "product-import: on_conflict must be one of " + ON_CONFLICTS.join(", ") +
      " — got " + JSON.stringify(onConflict)
    );
  }
  if (!Array.isArray(input.rows)) {
    throw new TypeError("product-import: rows must be an array");
  }

  // Normalize the input rows into the canonical `{ slug, title,
  // status, description, variants: [...], media: [...] }` shape.
  // Per-row normalization errors land in the error list at the
  // matching row_index; the row is skipped for catalog writes but
  // still counted in `rows_processed`.
  // Reserve the single in-flight slot SYNCHRONOUSLY — before the INSERT await —
  // so two concurrent runs (an operator double-submitting) can't both open. A
  // second run is refused rather than overwriting the first's inflight id,
  // which would leave `cancelInflight` targeting the wrong import. The check +
  // set have no await between them, so the reservation is race-free.
  if (state.inflightId) {
    var busy = new Error("product-import: an import is already in progress");
    busy.code = "IMPORT_IN_PROGRESS";
    throw busy;
  }
  var importId = b.uuid.v7();
  var startedAt = Date.now();
  var inputByteCount = driveOpts.inputByteCount == null ? 0 : driveOpts.inputByteCount;
  state.inflightId = importId;
  state.cancelFlag = false;

  // Run row goes in at `running`. The driver updates the counters +
  // status at the end. The error rows go in as they're encountered
  // — operators tailing `errorsForImport` see progress mid-run.
  try {
    await query(
      "INSERT INTO product_imports (id, format, on_conflict, started_at, status, input_byte_count) " +
      "VALUES (?1, ?2, ?3, ?4, 'running', ?5)",
      [importId, format, onConflict, startedAt, inputByteCount],
    );
  } catch (e) {
    state.inflightId = null;   // release the reservation if the open failed
    throw e;
  }

  var counters = {
    rows_processed:   0,
    products_created: 0,
    products_updated: 0,
    variants_created: 0,
    variants_updated: 0,
    rows_skipped:     0,
    rows_errored:     0,
  };
  var errors = [];

  try {
    var normalized;
    try {
      normalized = _normalizeRows(input.rows, format);
    } catch (e) {
      // Header / shape refusal — record the failure and rethrow so
      // the caller sees the throw shape, matching the customer-
      // import "status = failed" path.
      await _recordError(query, importId, 0, "", "import_aborted",
        (e && e.message) || String(e));
      counters.rows_errored = 1;
      await _finalize(query, importId, "failed", counters);
      state.lastReport = _report(importId, format, onConflict, "failed", counters, errors, dryRun);
      state.inflightId = null;
      throw e;
    }

    // Within-import SKU dedupe. The same SKU appearing twice in
    // one upload is always a row-error regardless of `on_conflict`
    // — the operator's CSV is malformed, not the catalog's state.
    var seenSkus = Object.create(null);

    for (var i = 0; i < normalized.length; i += 1) {
      if (state.cancelFlag) {
        counters.rows_skipped += (normalized.length - i);
        break;
      }
      counters.rows_processed += 1;
      var rec = normalized[i];
      if (rec.error) {
        counters.rows_errored += 1;
        var errA = {
          row_index:    rec.row_index,
          sku:          rec.sku || "",
          error_code:   rec.error.code,
          error_detail: rec.error.detail,
        };
        errors.push(errA);
        await _recordError(query, importId, errA.row_index, errA.sku, errA.error_code, errA.error_detail);
        continue;
      }
      // Walk variants — each row in the source produced one product
      // entry containing one or more variants. The dedupe is across
      // all variants in the whole import.
      var rowHadError = false;
      for (var v = 0; v < rec.variants.length; v += 1) {
        var variant = rec.variants[v];
        if (seenSkus[variant.sku]) {
          counters.rows_errored += 1;
          rowHadError = true;
          var errB = {
            row_index:    rec.row_index,
            sku:          variant.sku,
            error_code:   "duplicate_sku_in_import",
            error_detail: "sku " + JSON.stringify(variant.sku) +
              " appears more than once in this import (first at row_index " +
              seenSkus[variant.sku] + ")",
          };
          errors.push(errB);
          await _recordError(query, importId, errB.row_index, errB.sku, errB.error_code, errB.error_detail);
          continue;
        }
        seenSkus[variant.sku] = rec.row_index;
      }
      if (rowHadError) continue;

      try {
        await _processRow(catalog, rec, onConflict, counters, dryRun);
      } catch (e) {
        counters.rows_errored += 1;
        var sku = rec.variants && rec.variants[0] ? rec.variants[0].sku : "";
        var errC = {
          row_index:    rec.row_index,
          sku:          sku,
          error_code:   (e && e.code) || "row_failed",
          error_detail: ((e && e.message) || String(e)).slice(0, MAX_ERROR_DETAIL),
        };
        errors.push(errC);
        await _recordError(query, importId, errC.row_index, errC.sku, errC.error_code, errC.error_detail);
      }
    }

    var finalStatus = state.cancelFlag ? "cancelled" : "complete";
    await _finalize(query, importId, finalStatus, counters);
    state.lastReport = _report(importId, format, onConflict, finalStatus, counters, errors, dryRun);
    state.inflightId = null;
    state.cancelFlag = false;
    return state.lastReport;
  } catch (e) {
    state.inflightId = null;
    state.cancelFlag = false;
    throw e;
  }
}

function _report(importId, format, onConflict, status, counters, errors, dryRun) {
  return {
    import_id:        importId,
    format:           format,
    on_conflict:      onConflict,
    status:           status,
    dry_run:          dryRun,
    rows_processed:   counters.rows_processed,
    products_created: counters.products_created,
    products_updated: counters.products_updated,
    variants_created: counters.variants_created,
    variants_updated: counters.variants_updated,
    rows_skipped:     counters.rows_skipped,
    rows_errored:     counters.rows_errored,
    errors:           errors,
  };
}

async function _finalize(query, importId, status, counters) {
  var ts = Date.now();
  await query(
    "UPDATE product_imports SET status = ?1, completed_at = ?2, " +
    "rows_processed = ?3, products_created = ?4, products_updated = ?5, " +
    "variants_created = ?6, variants_updated = ?7, rows_skipped = ?8, " +
    "rows_errored = ?9 WHERE id = ?10",
    [
      status, ts,
      counters.rows_processed, counters.products_created, counters.products_updated,
      counters.variants_created, counters.variants_updated,
      counters.rows_skipped, counters.rows_errored,
      importId,
    ],
  );
}

async function _recordError(query, importId, rowIndex, sku, code, detail) {
  var id = b.uuid.v7();
  var truncated = (detail || "").length > MAX_ERROR_DETAIL
    ? detail.slice(0, MAX_ERROR_DETAIL) : (detail || "");
  await query(
    "INSERT INTO product_import_errors (id, import_id, row_index, sku, error_code, error_detail) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [id, importId, rowIndex, sku || "", code, truncated],
  );
}

// ---- per-row processing -------------------------------------------------

async function _processRow(catalog, rec, onConflict, counters, dryRun) {
  // Resolve (or create) the parent product by slug.
  var existing = null;
  try {
    existing = await catalog.products.bySlug(rec.slug);
  } catch (e) {
    // Bad slug shape — surfaces as a per-row error rather than
    // crashing the driver.
    throw _wrap(e, "invalid_slug");
  }

  var productId;
  if (existing) {
    if (onConflict === "skip") {
      // Operator opted out of touching existing products. Count
      // the variants as skipped — they're not getting written.
      counters.rows_skipped += rec.variants.length;
      return;
    }
    productId = existing.id;
    if (onConflict === "update") {
      var patch = {};
      if (rec.title       != null) patch.title       = rec.title;
      if (rec.description != null) patch.description = rec.description;
      if (rec.status      != null) patch.status      = rec.status;
      if (Object.keys(patch).length && !dryRun) {
        await catalog.products.update(productId, patch);
      }
      counters.products_updated += 1;
    }
    // onConflict === "error" — fall through; per-variant SKU
    // collision lands in the catalog UNIQUE refusal below.
  } else {
    if (dryRun) {
      productId = "<dry-run-product>";
    } else {
      var p = await catalog.products.create({
        slug:        rec.slug,
        title:       rec.title,
        status:      rec.status || "draft",
        description: rec.description == null ? "" : rec.description,
      });
      productId = p.id;
    }
    counters.products_created += 1;
  }

  for (var i = 0; i < rec.variants.length; i += 1) {
    var v = rec.variants[i];
    var variantExisting = null;
    if (!dryRun) {
      try { variantExisting = await catalog.variants.bySku(v.sku); }
      catch (_e) { variantExisting = null; }
    }
    if (variantExisting) {
      if (onConflict === "skip") {
        counters.rows_skipped += 1;
        continue;
      }
      if (onConflict === "error") {
        throw _err("duplicate_sku", "sku " + JSON.stringify(v.sku) +
          " already exists in the catalog");
      }
      // update
      var vPatch = {};
      if (v.title        != null) vPatch.title        = v.title;
      if (v.weight_grams != null) vPatch.weight_grams = v.weight_grams;
      if (Object.keys(vPatch).length) {
        await catalog.variants.update(variantExisting.id, vPatch);
      }
      if (v.price) {
        await catalog.prices.set(variantExisting.id, {
          currency:     v.price.currency,
          amount_minor: v.price.amount_minor,
        });
      }
      counters.variants_updated += 1;
      if (v.inventory_qty != null && !dryRun) {
        // Inventory.create refuses on duplicate SKU; in update
        // mode we ignore the conflict (existing row's quantity
        // is operator-managed, not import-managed).
        try {
          await catalog.inventory.create(v.sku, { stock_on_hand: v.inventory_qty });
        } catch (_e) { /* drop-silent — operator opted into update, not stock reset */ }
      }
      // Media on update: append, not replace. Operator-curated
      // images aren't clobbered by a re-import.
      if (v.media && v.media.length && !dryRun) {
        for (var m = 0; m < v.media.length; m += 1) {
          await catalog.media.attach({
            variant_id:   variantExisting.id,
            r2_key:       v.media[m].r2_key,
            content_type: v.media[m].content_type,
            alt_text:     v.media[m].alt_text || "",
          });
        }
      }
    } else {
      if (dryRun) {
        counters.variants_created += 1;
        continue;
      }
      var created = await catalog.variants.create(productId, {
        sku:          v.sku,
        title:        v.title || "",
        weight_grams: v.weight_grams == null ? 0 : v.weight_grams,
      });
      counters.variants_created += 1;
      if (v.price) {
        await catalog.prices.set(created.id, {
          currency:     v.price.currency,
          amount_minor: v.price.amount_minor,
        });
      }
      if (v.inventory_qty != null) {
        await catalog.inventory.create(v.sku, { stock_on_hand: v.inventory_qty });
      }
      if (v.media && v.media.length) {
        for (var m2 = 0; m2 < v.media.length; m2 += 1) {
          await catalog.media.attach({
            variant_id:   created.id,
            r2_key:       v.media[m2].r2_key,
            content_type: v.media[m2].content_type,
            alt_text:     v.media[m2].alt_text || "",
          });
        }
      }
    }
  }

  // Product-level media (attached to product_id, not variant_id).
  if (rec.media && rec.media.length && !dryRun && productId !== "<dry-run-product>") {
    for (var pm = 0; pm < rec.media.length; pm += 1) {
      await catalog.media.attach({
        product_id:   productId,
        r2_key:       rec.media[pm].r2_key,
        content_type: rec.media[pm].content_type,
        alt_text:     rec.media[pm].alt_text || "",
      });
    }
  }
}

function _err(code, detail) {
  var e = new Error(detail);
  e.code = code;
  return e;
}
function _wrap(e, code) {
  var wrapped = new Error((e && e.message) || String(e));
  wrapped.code = code;
  wrapped.cause = e;
  return wrapped;
}

// ---- normalization ------------------------------------------------------
//
// Each input format collapses to the same canonical shape:
//
//   {
//     row_index: <0-based source-row index>,
//     slug, title, status, description,
//     variants: [
//       { sku, title, weight_grams, price: { currency, amount_minor },
//         inventory_qty, media: [...] },
//       ...
//     ],
//     media:    [{ r2_key, content_type, alt_text }, ...],
//   }
//
// Multiple flat_csv rows that share `product_slug` collapse to a
// single normalized record with the first row's product fields and
// every row's variant block appended to the variants array. For
// shopify_json + blamejs_native the input is already nested, so each
// element of the input array becomes one normalized record.

function _normalizeRows(rows, format) {
  if (format === "flat_csv") return _normalizeFlatCsv(rows);
  if (format === "shopify_json") return _normalizeShopify(rows);
  return _normalizeNative(rows);
}

function _normalizeFlatCsv(rows) {
  if (rows.length === 0) {
    throw new TypeError("product-import: csv contained no rows (header required)");
  }
  var header = rows[0];
  if (!Array.isArray(header) || header.length !== FLAT_CSV_HEADER.length) {
    throw new TypeError(
      "product-import: header row must have " + FLAT_CSV_HEADER.length +
      " columns: " + FLAT_CSV_HEADER.join(", ")
    );
  }
  for (var h = 0; h < FLAT_CSV_HEADER.length; h += 1) {
    if (header[h] !== FLAT_CSV_HEADER[h]) {
      throw new TypeError(
        "product-import: header column " + (h + 1) +
        " must be " + JSON.stringify(FLAT_CSV_HEADER[h]) +
        ", got " + JSON.stringify(header[h])
      );
    }
  }
  var data = rows.slice(1);
  var bySlug = Object.create(null);
  var order = [];
  for (var i = 0; i < data.length; i += 1) {
    var rowIndex = i + 1;   // 0-based on the input array; the
                            // header is row 0, first data row is 1.
    var row = data[i];
    if (!Array.isArray(row) || row.length !== FLAT_CSV_HEADER.length) {
      // Per-row shape error — preserved as an error record rather
      // than throwing. The driver will count + record it.
      order.push({
        row_index: rowIndex,
        sku:       "",
        error:     {
          code:   "row_shape",
          detail: "row must have " + FLAT_CSV_HEADER.length +
            " columns, got " + (Array.isArray(row) ? row.length : "non-array"),
        },
      });
      continue;
    }
    var slug = row[0];
    var weightStr = row[6];
    var amountStr = row[8];
    var qtyStr    = row[9];
    var weight    = _strInt(weightStr, "variant_weight_grams");
    var amount    = _strInt(amountStr, "price_amount_minor");
    var qty       = _strInt(qtyStr,    "inventory_qty");
    if (weight.error || amount.error || qty.error) {
      var detail = (weight.error || amount.error || qty.error);
      order.push({
        row_index: rowIndex,
        sku:       row[4] || "",
        error:     { code: "invalid_number", detail: detail },
      });
      continue;
    }
    var variant = {
      sku:          row[4],
      title:        row[5],
      weight_grams: weight.value,
      price:        { currency: row[7], amount_minor: amount.value },
      inventory_qty: qty.value,
      media:        [],
    };
    if (row[10]) {
      variant.media.push({
        r2_key:       row[10],
        content_type: row[11] || "image/jpeg",
        alt_text:     row[12] || "",
      });
    }
    if (bySlug[slug]) {
      bySlug[slug].variants.push(variant);
    } else {
      var rec = {
        row_index:   rowIndex,
        slug:        slug,
        title:       row[1],
        status:      row[2],
        description: row[3],
        variants:    [variant],
        media:       [],
      };
      bySlug[slug] = rec;
      order.push(rec);
    }
  }
  return order;
}

function _strInt(s, label) {
  if (typeof s !== "string") {
    return { error: label + " must be a string-encoded non-negative integer" };
  }
  if (!/^\d+$/.test(s)) {
    return { error: label + " must be a non-negative integer, got " + JSON.stringify(s) };
  }
  var n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < 0) {
    return { error: label + " must be a non-negative integer, got " + JSON.stringify(s) };
  }
  return { value: n };
}

function _normalizeShopify(products) {
  if (!Array.isArray(products)) {
    throw new TypeError("product-import: shopify_json must be an array of product objects");
  }
  var out = [];
  for (var i = 0; i < products.length; i += 1) {
    var p = products[i];
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      out.push({
        row_index: i, sku: "",
        error: { code: "row_shape", detail: "product entry must be an object" },
      });
      continue;
    }
    if (typeof p.handle !== "string" || !p.handle.length) {
      out.push({
        row_index: i, sku: "",
        error: { code: "row_shape", detail: "shopify product missing `handle` (slug)" },
      });
      continue;
    }
    var status = p.status === "active" ? "active"
               : p.status === "draft" ? "draft"
               : p.status === "archived" ? "archived"
               : "draft";
    if (!Array.isArray(p.variants) || p.variants.length === 0) {
      out.push({
        row_index: i, sku: "",
        error: { code: "row_shape", detail: "shopify product missing `variants` array" },
      });
      continue;
    }
    var variants = [];
    var rowError = null;
    for (var v = 0; v < p.variants.length; v += 1) {
      var sv = p.variants[v];
      if (!sv || typeof sv !== "object" || typeof sv.sku !== "string") {
        rowError = {
          code:   "row_shape",
          detail: "shopify variant " + v + " missing `sku`",
        };
        break;
      }
      // Shopify ships price as a decimal string ("19.99"); the
      // catalog stores minor units. Convert by stripping the
      // decimal and padding to two decimals. No currency conversion;
      // operator-provided `currency` (default USD) is recorded as-is.
      var amount = _shopifyMinor(sv.price);
      if (amount.error) { rowError = { code: "invalid_number", detail: amount.error }; break; }
      var weight = sv.grams == null ? 0 : sv.grams;
      if (!Number.isInteger(weight) || weight < 0) {
        rowError = { code: "invalid_number", detail: "variant.grams must be a non-negative integer" };
        break;
      }
      variants.push({
        sku:           sv.sku,
        title:         sv.title || "",
        weight_grams:  weight,
        price:         { currency: sv.currency || "USD", amount_minor: amount.value },
        inventory_qty: Number.isInteger(sv.inventory_quantity) && sv.inventory_quantity >= 0
                         ? sv.inventory_quantity : 0,
        media:         [],
      });
    }
    if (rowError) {
      out.push({ row_index: i, sku: "", error: rowError });
      continue;
    }
    var media = [];
    if (Array.isArray(p.images)) {
      for (var m = 0; m < p.images.length; m += 1) {
        var img = p.images[m];
        if (img && typeof img === "object" && typeof img.src === "string") {
          media.push({
            r2_key:       img.src,
            content_type: img.content_type || "image/jpeg",
            alt_text:     img.alt || "",
          });
        }
      }
    }
    out.push({
      row_index:   i,
      slug:        p.handle,
      title:       p.title || p.handle,
      status:      status,
      description: p.body_html || "",
      variants:    variants,
      media:       media,
    });
  }
  return out;
}

function _shopifyMinor(price) {
  if (price == null) return { error: "variant.price required" };
  var s = String(price);
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) {
    return { error: "variant.price must be a decimal string with ≤ 2 decimals, got " + JSON.stringify(price) };
  }
  var parts = s.split(".");
  var whole = parts[0];
  var dec   = (parts[1] || "").padEnd(2, "0").slice(0, 2);
  var minor = parseInt(whole, 10) * 100 + parseInt(dec, 10);
  if (!Number.isInteger(minor) || minor < 0) {
    return { error: "variant.price overflow" };
  }
  return { value: minor };
}

function _normalizeNative(products) {
  if (!Array.isArray(products)) {
    throw new TypeError("product-import: blamejs_native must be an array of product objects");
  }
  var out = [];
  for (var i = 0; i < products.length; i += 1) {
    var p = products[i];
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      out.push({
        row_index: i, sku: "",
        error: { code: "row_shape", detail: "product entry must be an object" },
      });
      continue;
    }
    if (typeof p.slug !== "string" || !p.slug.length) {
      out.push({
        row_index: i, sku: "",
        error: { code: "row_shape", detail: "native product missing `slug`" },
      });
      continue;
    }
    if (!Array.isArray(p.variants) || p.variants.length === 0) {
      out.push({
        row_index: i, sku: "",
        error: { code: "row_shape", detail: "native product missing `variants` array" },
      });
      continue;
    }
    var variants = [];
    var rowError = null;
    for (var v = 0; v < p.variants.length; v += 1) {
      var nv = p.variants[v];
      if (!nv || typeof nv !== "object" || typeof nv.sku !== "string") {
        rowError = { code: "row_shape", detail: "native variant " + v + " missing `sku`" };
        break;
      }
      var weight = nv.weight_grams == null ? 0 : nv.weight_grams;
      if (!Number.isInteger(weight) || weight < 0) {
        rowError = { code: "invalid_number", detail: "variant.weight_grams must be a non-negative integer" };
        break;
      }
      var price = nv.price;
      if (price && (typeof price !== "object" || typeof price.currency !== "string" ||
                    !Number.isInteger(price.amount_minor))) {
        rowError = { code: "row_shape", detail: "variant.price must be { currency, amount_minor }" };
        break;
      }
      variants.push({
        sku:           nv.sku,
        title:         nv.title || "",
        weight_grams:  weight,
        price:         price ? { currency: price.currency, amount_minor: price.amount_minor } : null,
        inventory_qty: Number.isInteger(nv.inventory_qty) && nv.inventory_qty >= 0
                         ? nv.inventory_qty : 0,
        media:         Array.isArray(nv.media) ? nv.media.slice() : [],
      });
    }
    if (rowError) {
      out.push({ row_index: i, sku: "", error: rowError });
      continue;
    }
    out.push({
      row_index:   i,
      slug:        p.slug,
      title:       p.title || p.slug,
      status:      p.status || "draft",
      description: p.description == null ? "" : p.description,
      variants:    variants,
      media:       Array.isArray(p.media) ? p.media.slice() : [],
    });
  }
  return out;
}

// ---- read surfaces ------------------------------------------------------

async function _listImports(query, listOpts) {
  var status = listOpts.status;
  if (status != null) {
    if (STATUSES.indexOf(status) === -1) {
      throw new TypeError(
        "product-import.listImports: status must be one of " + STATUSES.join(", ")
      );
    }
  }
  var from = listOpts.from;
  var to   = listOpts.to;
  if (from != null && !Number.isInteger(from)) {
    throw new TypeError("product-import.listImports: from must be an integer epoch-ms");
  }
  if (to != null && !Number.isInteger(to)) {
    throw new TypeError("product-import.listImports: to must be an integer epoch-ms");
  }

  var clauses = [];
  var params  = [];
  var idx = 1;
  if (status != null) { clauses.push("status = ?" + idx); params.push(status); idx += 1; }
  if (from   != null) { clauses.push("started_at >= ?" + idx); params.push(from); idx += 1; }
  if (to     != null) { clauses.push("started_at <= ?" + idx); params.push(to);   idx += 1; }
  var sql = "SELECT * FROM product_imports";
  if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
  sql += " ORDER BY started_at DESC, id DESC LIMIT 500";
  var r = await query(sql, params);
  return { rows: r.rows };
}

async function _errorsForImport(query, importId) {
  // Strict UUID gate keeps a hand-crafted id from reaching the SQL
  // layer; matches the catalog.products.get pattern.
  try {
    b.guardUuid.sanitize(importId, { profile: "strict" });
  } catch (e) {
    throw new TypeError(
      "product-import.errorsForImport: import_id — " +
      ((e && e.message) || "invalid UUID")
    );
  }
  var r = await query(
    "SELECT id, import_id, row_index, sku, error_code, error_detail " +
    "FROM product_import_errors WHERE import_id = ?1 " +
    "ORDER BY row_index ASC, id ASC",
    [importId],
  );
  return { rows: r.rows };
}

module.exports = {
  create:           create,
  FORMATS:          FORMATS,
  ON_CONFLICTS:     ON_CONFLICTS,
  FLAT_CSV_HEADER:  FLAT_CSV_HEADER,
  DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS:  DEFAULT_MAX_ROWS,
};
