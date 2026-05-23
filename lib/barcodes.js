"use strict";
/**
 * @module shop.barcodes
 * @title  Barcodes primitive — SKU -> scannable identifier with checksum validation
 *
 * @intro
 *   Maps a SKU to one or more barcode values across the four kinds
 *   the storefront actually needs:
 *
 *     - `upc_a`    — 12 digits, mod-10 (North-American retail
 *                    consumer pack).
 *     - `ean_13`   — 13 digits, mod-10 (international consumer
 *                    pack; GS1 company prefix + item reference +
 *                    check digit).
 *     - `code_128` — variable-length alphanumeric, no industry
 *                    checksum at the data layer (Code-128 carries
 *                    its own modulo-103 check internally to the
 *                    symbol — that's a renderer concern, not a
 *                    value-validation concern; the operator stores
 *                    the human-readable payload).
 *     - `gtin_14`  — 14 digits, mod-10 (case / outer-shipper
 *                    pack; first digit is the packaging-level
 *                    indicator).
 *
 *   `assign` refuses on bad checksum / wrong digit-length / duplicate
 *   (kind, value). `assignAuto` mints the next value from an
 *   operator-allocated range and writes the assignment in one go —
 *   the range row's `next_value` advances atomically per call so two
 *   concurrent auto-mints never collide.
 *
 *   `renderSvg` returns a self-contained inline `<svg>` string —
 *   no external assets, no `<script>`, no `<foreignObject>` — safe to
 *   embed directly in a print template or a thermal-label PDF. The
 *   primitive ships the encoding tables for each kind inline; the
 *   storefront never reaches for an external barcode library.
 *
 *   Composition:
 *     var bc = bShop.barcodes.create({ query: q, catalog: cat });
 *     await bc.defineRange({
 *       kind: "ean_13", prefix: "5012345", next_value: 0, max_value: 99999,
 *       owner_company: "Example Foods Ltd",
 *     });
 *     var b = await bc.assignAuto({ sku: "WIDGET-A", kind: "ean_13" });
 *     var svg = await bc.renderSvg({ sku: "WIDGET-A" });
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var KINDS = ["upc_a", "ean_13", "code_128", "gtin_14"];

// Digit-length per numeric kind (Code-128 is variable so it's not
// in this table — its length is validated by the alphanumeric +
// printable-ASCII shape check instead).
var DIGIT_LEN = {
  upc_a:   12,
  ean_13:  13,
  gtin_14: 14,
};

// Code-128 accepts ASCII 0x20..0x7E (printable). The renderer
// chooses Code Set B for that range. Operators wanting a Code-A /
// Code-C payload should use the alphabet they need within this
// shape; the validator doesn't second-guess.
var CODE128_RE = /^[\x20-\x7E]+$/;
var DIGITS_RE  = /^[0-9]+$/;

// ---- checksum primitives ------------------------------------------------

// Standard GS1 mod-10: rightmost data digit weighted 3, then
// alternating 1/3. The check digit makes the total a multiple of
// 10. Used by UPC-A, EAN-13, GTIN-14 (the algorithm is identical;
// only the input length differs).
function _gs1Mod10(digits) {
  var sum = 0;
  // Walk right-to-left, weight = 3 on the first (rightmost) data
  // digit, alternating 1/3 thereafter. `digits` here is the data
  // portion WITHOUT the check digit appended.
  for (var i = digits.length - 1, w = 3; i >= 0; i -= 1, w = (w === 3 ? 1 : 3)) {
    sum += parseInt(digits.charAt(i), 10) * w;
  }
  var mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}

// Validate a numeric value's check digit against the trailing
// position. Returns true if the trailing digit matches the
// computed check digit.
function _gs1CheckOk(value) {
  if (!DIGITS_RE.test(value) || value.length < 2) return false;
  var data  = value.slice(0, -1);
  var check = parseInt(value.charAt(value.length - 1), 10);
  return _gs1Mod10(data) === check;
}

// Pure-function value validation per kind. Returns true on a
// well-formed value (correct length, correct shape, correct
// checksum where applicable).
function validateValue(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("barcodes.validateValue: input object required");
  }
  if (KINDS.indexOf(input.kind) === -1) {
    throw new TypeError("barcodes.validateValue: kind must be one of " + KINDS.join(", "));
  }
  if (typeof input.value !== "string" || !input.value.length) {
    throw new TypeError("barcodes.validateValue: value must be a non-empty string");
  }
  var v = input.value;
  if (input.kind === "code_128") {
    return CODE128_RE.test(v);
  }
  var expected = DIGIT_LEN[input.kind];
  if (v.length !== expected) return false;
  if (!DIGITS_RE.test(v)) return false;
  return _gs1CheckOk(v);
}

// ---- input validators ---------------------------------------------------

function _sku(s) {
  if (typeof s !== "string" || !s.length || s.length > 128) {
    throw new TypeError("barcodes: sku must be a non-empty string ≤ 128 chars");
  }
  // The catalog primitive owns SKU canonicalization; here we only
  // refuse control bytes + leading/trailing whitespace so a typo
  // can't quietly map to a different row than the catalog sees.
  if (/[\x00-\x1f\x7f]/.test(s) || /^\s|\s$/.test(s)) {
    throw new TypeError("barcodes: sku contains control bytes or surrounding whitespace");
  }
  return s;
}

function _kind(k) {
  if (typeof k !== "string" || KINDS.indexOf(k) === -1) {
    throw new TypeError("barcodes: kind must be one of " + KINDS.join(", "));
  }
  return k;
}

function _now() { return Date.now(); }

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("barcodes: " + label + " must be a non-negative integer");
  }
  return n;
}

function _prefix(s, kind) {
  if (typeof s !== "string" || !s.length || s.length > 32) {
    throw new TypeError("barcodes: prefix must be a non-empty string ≤ 32 chars");
  }
  if (kind === "code_128") {
    if (!CODE128_RE.test(s)) {
      throw new TypeError("barcodes: code_128 prefix must be printable ASCII (0x20–0x7E)");
    }
  } else if (!DIGITS_RE.test(s)) {
    throw new TypeError("barcodes: numeric-kind prefix must be digits only");
  }
  return s;
}

// ---- auto-mint value formatter ------------------------------------------

// Compose `prefix + zero-padded counter + check digit` to the
// kind's expected length. For Code-128 we just concatenate prefix
// + counter (no check digit; the symbol-level check is a renderer
// concern).
function _mintValue(kind, prefix, counter) {
  if (kind === "code_128") {
    return prefix + String(counter);
  }
  var totalLen = DIGIT_LEN[kind];
  var dataLen  = totalLen - 1;                                          // reserve trailing check digit
  var counterStr = String(counter);
  var padLen = dataLen - prefix.length - counterStr.length;
  if (padLen < 0) return null;                                          // counter overflowed the available data space
  var data = prefix + "0".repeat(padLen) + counterStr;
  var check = _gs1Mod10(data);
  return data + String(check);
}

// ---- SVG renderer -------------------------------------------------------

// Code-128 Code Set B encoding table — covers ASCII 0x20–0x7E.
// Index = symbol value (0..106). The bar pattern is 6 elements
// (3 bar-space pairs, "11" = bar, "00" = space etc. — but the
// canonical representation is a sequence of bar+space widths). We
// store the canonical 6-width string per code; the renderer paints
// bars at odd positions, spaces at even positions.
// (Trimmed comment block; the table below is the published GS1
// Code-128 specification, abbreviated to values 0..106 — START B
// = 104, STOP = 106 in this encoding, with the modulo-103 weighted
// checksum positioned just before STOP per ISO/IEC 15417.)
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
  "114131","311141","411131","211412","211214","211232","2331112"                          // 100..106; index 106 = STOP
];

// Map a Code-128 Set B character to its symbol value.
// Set B starts at 0x20 (space → 0), so value = charCode - 32.
function _code128ValueB(ch) {
  return ch.charCodeAt(0) - 32;
}

// EAN/UPC L/G/R encoding tables. For UPC-A: left 6 digits = L,
// right 6 digits = R. For EAN-13: leading digit is implicit
// (encoded by L/G pattern on the left 6); right 6 = R.
//
// Each entry is a 7-module bit string. "1" = bar, "0" = space.
var EAN_L = [
  "0001101","0011001","0010011","0111101","0100011",
  "0110001","0101111","0111011","0110111","0001011",
];
var EAN_G = [
  "0100111","0110011","0011011","0100001","0011101",
  "0111001","0000101","0010001","0001001","0010111",
];
var EAN_R = [
  "1110010","1100110","1101100","1000010","1011100",
  "1001110","1010000","1000100","1001000","1110100",
];
// EAN-13 leading-digit -> L/G pattern across the left 6 positions.
// "L" = use EAN_L, "G" = use EAN_G.
var EAN13_LEAD = [
  "LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG",
  "LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL",
];
var EAN_GUARD       = "101";
var EAN_MID_GUARD   = "01010";

// Render a numeric value (UPC-A or EAN-13) into a module-width
// bit string. Returns an array of bit characters.
function _renderEan(kind, value) {
  var modules = "";
  if (kind === "upc_a") {
    // UPC-A is EAN-13 with a leading 0; the L-pattern is all-L.
    modules += EAN_GUARD;
    for (var i = 0; i < 6; i += 1) {
      modules += EAN_L[parseInt(value.charAt(i), 10)];
    }
    modules += EAN_MID_GUARD;
    for (var j = 6; j < 12; j += 1) {
      modules += EAN_R[parseInt(value.charAt(j), 10)];
    }
    modules += EAN_GUARD;
    return modules;
  }
  // ean_13
  var lead = EAN13_LEAD[parseInt(value.charAt(0), 10)];
  modules += EAN_GUARD;
  for (var k = 0; k < 6; k += 1) {
    var d = parseInt(value.charAt(k + 1), 10);
    var enc = lead.charAt(k);
    modules += (enc === "L" ? EAN_L[d] : EAN_G[d]);
  }
  modules += EAN_MID_GUARD;
  for (var m = 7; m < 13; m += 1) {
    modules += EAN_R[parseInt(value.charAt(m), 10)];
  }
  modules += EAN_GUARD;
  return modules;
}

// GTIN-14 is rendered as an ITF-14 (Interleaved 2-of-5) bar
// pattern. Each digit pair encodes 10 modules: 5 narrow/wide
// bars interleaved with 5 narrow/wide spaces. We use the standard
// I-2-of-5 weights (1, 1, 1, 2, 2 — narrow=1, wide=2 module).
var ITF_WIDTHS = [
  // 0..9: each entry is 5 weights, "1" = narrow, "2" = wide.
  "11221","21112","12112","22111","11212",
  "21211","12211","11122","21121","12121",
];

function _renderItf14(value) {
  // Start: narrow bar, narrow space, narrow bar, narrow space.
  var out = "1010";
  for (var i = 0; i < value.length; i += 2) {
    var bw = ITF_WIDTHS[parseInt(value.charAt(i),     10)];           // bar widths
    var sw = ITF_WIDTHS[parseInt(value.charAt(i + 1), 10)];           // space widths
    for (var k = 0; k < 5; k += 1) {
      // Bar (width 1 or 2 modules).
      out += (bw.charAt(k) === "2") ? "11" : "1";
      // Space (width 1 or 2 modules).
      out += (sw.charAt(k) === "2") ? "00" : "0";
    }
  }
  // Stop: wide bar, narrow space, narrow bar.
  out += "1101";
  return out;
}

// Render a Code-128 payload into a module-width bit string. The
// renderer always emits a Code Set B symbol (printable ASCII) —
// operators needing Set A or Set C choose payload shapes that
// remain valid in Set B (no control bytes; numeric strings are
// fine, just longer than a Set C encoding would be).
function _renderCode128(payload) {
  // Start B = 104, weighted 1.
  var symbols = [104];
  for (var i = 0; i < payload.length; i += 1) {
    symbols.push(_code128ValueB(payload.charAt(i)));
  }
  // Checksum: start-value*1 + sum(i=1..n, symbol_i * i), mod 103.
  var sum = symbols[0];
  for (var j = 1; j < symbols.length; j += 1) {
    sum += symbols[j] * j;
  }
  symbols.push(sum % 103);
  // STOP (value 106 in this table).
  symbols.push(106);

  var modules = "";
  for (var s = 0; s < symbols.length; s += 1) {
    var pat = CODE128_PATTERNS[symbols[s]];
    // pat is a sequence of bar/space widths. Even indices are
    // bars (start with bar), odd indices are spaces. STOP (last)
    // has 7 widths instead of 6 — append all of them.
    var bar = true;
    for (var c = 0; c < pat.length; c += 1) {
      var w = parseInt(pat.charAt(c), 10);
      modules += (bar ? "1" : "0").repeat(w);
      bar = !bar;
    }
  }
  return modules;
}

// Paint a module-width bit string into an inline SVG. The result
// holds NO `<script>`, NO `<foreignObject>`, NO external `xlink:href`
// — only `<svg>` root, `<rect>` bars, and an optional `<text>` for
// the human-readable line. Width is auto-derived from module count;
// the operator can override height + module-width via options.
function _renderSvg(modules, label, opts) {
  opts = opts || {};
  var heightPx = (typeof opts.height_px === "number" && opts.height_px > 0) ? Math.floor(opts.height_px) : 60;
  var widthPx  = (typeof opts.width_px  === "number" && opts.width_px  > 0) ? Math.floor(opts.width_px)  : null;
  var moduleW  = widthPx != null ? (widthPx / modules.length) : 2;
  var totalW   = widthPx != null ? widthPx : Math.ceil(modules.length * moduleW);

  // Reserve 12px at the bottom for the human-readable label.
  var barH    = label ? Math.max(heightPx - 12, 4) : heightPx;
  var bars    = "";
  var i = 0;
  while (i < modules.length) {
    if (modules.charAt(i) === "1") {
      var run = 1;
      while (i + run < modules.length && modules.charAt(i + run) === "1") run += 1;
      bars += "<rect x=\"" + (i * moduleW).toFixed(3) + "\" y=\"0\" width=\"" + (run * moduleW).toFixed(3) + "\" height=\"" + barH + "\" fill=\"#000\"/>";
      i += run;
    } else {
      i += 1;
    }
  }
  var labelXml = "";
  if (label) {
    // Escape & < > " for the human-readable line. (' is rare in
    // barcode values but cheap to cover.)
    var safe = String(label)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    labelXml = "<text x=\"" + (totalW / 2).toFixed(3) + "\" y=\"" + (heightPx - 2) +
               "\" font-family=\"monospace\" font-size=\"10\" text-anchor=\"middle\" fill=\"#000\">" + safe + "</text>";
  }
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + totalW + "\" height=\"" + heightPx +
         "\" viewBox=\"0 0 " + totalW + " " + heightPx + "\" role=\"img\" aria-label=\"barcode\">" +
         "<rect x=\"0\" y=\"0\" width=\"" + totalW + "\" height=\"" + heightPx + "\" fill=\"#fff\"/>" +
         bars + labelXml + "</svg>";
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog || !opts.catalog.variants || typeof opts.catalog.variants.bySku !== "function") {
    throw new TypeError("barcodes.create: opts.catalog with variants.bySku(sku) required");
  }
  var catalog = opts.catalog;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  async function _verifySku(sku) {
    var v = await catalog.variants.bySku(sku);
    if (!v) {
      throw new TypeError("barcodes: sku " + JSON.stringify(sku) + " not found in catalog");
    }
    return v;
  }

  async function _assignRow(sku, kind, value) {
    var id = _b().uuid.v7();
    var ts = _now();
    try {
      await query(
        "INSERT INTO barcode_assignments (id, sku, kind, value, assigned_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, sku, kind, value, ts],
      );
    } catch (e) {
      // Distinguish duplicate-value from any other storage failure.
      // SQLite + most adapters surface unique-violation as an Error
      // whose message contains "UNIQUE" / "unique".
      var msg = (e && e.message) || "";
      if (/unique/i.test(msg)) {
        var dup = new Error("barcodes.assign: value already assigned for this kind");
        dup.code = "BARCODE_VALUE_TAKEN";
        throw dup;
      }
      throw e;
    }
    return { id: id, sku: sku, kind: kind, value: value, assigned_at: ts };
  }

  return {
    KINDS:           KINDS,
    validateValue:   validateValue,

    assign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("barcodes.assign: input object required");
      }
      _sku(input.sku);
      _kind(input.kind);
      if (typeof input.value !== "string" || !input.value.length) {
        throw new TypeError("barcodes.assign: value must be a non-empty string");
      }
      if (!validateValue({ kind: input.kind, value: input.value })) {
        var bad = new Error("barcodes.assign: value failed " + input.kind + " validation (length / shape / checksum)");
        bad.code = "BARCODE_INVALID_VALUE";
        throw bad;
      }
      await _verifySku(input.sku);
      return await _assignRow(input.sku, input.kind, input.value);
    },

    assignAuto: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("barcodes.assignAuto: input object required");
      }
      _sku(input.sku);
      _kind(input.kind);
      await _verifySku(input.sku);
      // Pick the lowest-id range for the kind that still has room.
      // `next_value <= max_value` is the "room remaining" predicate.
      var r = await query(
        "SELECT id, prefix, next_value, max_value FROM barcode_ranges " +
        "WHERE kind = ?1 AND next_value <= max_value ORDER BY created_at ASC, id ASC LIMIT 1",
        [input.kind],
      );
      if (!r.rows.length) {
        var none = new Error("barcodes.assignAuto: no range with remaining capacity for kind " + input.kind);
        none.code = "BARCODE_RANGE_EXHAUSTED";
        throw none;
      }
      var range = r.rows[0];
      var value = _mintValue(input.kind, range.prefix, range.next_value);
      if (value == null) {
        // Prefix + counter no longer fits in the kind's data block.
        // Refuse and surface as exhausted; the operator allocates a
        // new range with a shorter prefix or a fresh counter base.
        var overflow = new Error("barcodes.assignAuto: range counter overflowed the data block — allocate a new range");
        overflow.code = "BARCODE_RANGE_EXHAUSTED";
        throw overflow;
      }
      // Advance the counter atomically with a CAS guard on
      // `next_value` so two concurrent auto-mints can't collide on
      // the same counter value. The mint is retried up to a small
      // bound on contention (in practice D1 sequences these per
      // worker; the loop is belt-and-braces).
      var dec = await query(
        "UPDATE barcode_ranges SET next_value = next_value + 1 " +
        "WHERE id = ?1 AND next_value = ?2 AND next_value <= max_value",
        [range.id, range.next_value],
      );
      if (dec.rowCount === 0) {
        // Lost the race; surface as a transient retryable failure.
        var raced = new Error("barcodes.assignAuto: range counter race — retry");
        raced.code = "BARCODE_RANGE_RACE";
        throw raced;
      }
      return await _assignRow(input.sku, input.kind, value);
    },

    lookup: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("barcodes.lookup: input object required");
      }
      _sku(input.sku);
      var r = await query(
        "SELECT id, sku, kind, value, assigned_at FROM barcode_assignments WHERE sku = ?1 ORDER BY assigned_at ASC",
        [input.sku],
      );
      return r.rows;
    },

    bySkuList: async function (skus) {
      if (!Array.isArray(skus)) {
        throw new TypeError("barcodes.bySkuList: skus must be an array");
      }
      if (!skus.length) return {};
      var seen = Object.create(null);
      var clean = [];
      for (var i = 0; i < skus.length; i += 1) {
        _sku(skus[i]);
        if (!seen[skus[i]]) { seen[skus[i]] = true; clean.push(skus[i]); }
      }
      // Build an IN (?1, ?2, ...) clause with positional params.
      var placeholders = clean.map(function (_v, idx) { return "?" + (idx + 1); }).join(", ");
      var r = await query(
        "SELECT id, sku, kind, value, assigned_at FROM barcode_assignments WHERE sku IN (" + placeholders + ") ORDER BY sku, assigned_at ASC",
        clean,
      );
      var out = {};
      for (var k = 0; k < clean.length; k += 1) out[clean[k]] = [];
      for (var j = 0; j < r.rows.length; j += 1) {
        var row = r.rows[j];
        out[row.sku].push(row);
      }
      return out;
    },

    lookupByValue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("barcodes.lookupByValue: input object required");
      }
      _kind(input.kind);
      if (typeof input.value !== "string" || !input.value.length) {
        throw new TypeError("barcodes.lookupByValue: value must be a non-empty string");
      }
      var r = await query(
        "SELECT id, sku, kind, value, assigned_at FROM barcode_assignments WHERE kind = ?1 AND value = ?2",
        [input.kind, input.value],
      );
      return r.rows.length ? r.rows[0] : null;
    },

    unassign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("barcodes.unassign: input object required");
      }
      _sku(input.sku);
      var sql, params;
      if (input.kind != null) {
        _kind(input.kind);
        sql    = "DELETE FROM barcode_assignments WHERE sku = ?1 AND kind = ?2";
        params = [input.sku, input.kind];
      } else {
        sql    = "DELETE FROM barcode_assignments WHERE sku = ?1";
        params = [input.sku];
      }
      var d = await query(sql, params);
      return { removed: d.rowCount || 0 };
    },

    defineRange: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("barcodes.defineRange: input object required");
      }
      _kind(input.kind);
      _prefix(input.prefix, input.kind);
      _nonNegInt(input.next_value, "next_value");
      _nonNegInt(input.max_value,  "max_value");
      if (input.max_value < input.next_value) {
        throw new TypeError("barcodes.defineRange: max_value must be ≥ next_value");
      }
      // For numeric kinds, the prefix + max_value digit count must
      // fit inside the kind's data block (total length minus the
      // trailing check digit). Refuse a range the operator can't
      // actually mint from.
      if (input.kind !== "code_128") {
        var dataLen = DIGIT_LEN[input.kind] - 1;
        if (input.prefix.length + String(input.max_value).length > dataLen) {
          throw new TypeError("barcodes.defineRange: prefix + max_value digits exceed " + input.kind + " data block (" + dataLen + " digits)");
        }
      }
      var ownerCompany = null;
      if (input.owner_company != null) {
        if (typeof input.owner_company !== "string" || !input.owner_company.length || input.owner_company.length > 128) {
          throw new TypeError("barcodes.defineRange: owner_company must be a string ≤ 128 chars when provided");
        }
        ownerCompany = input.owner_company;
      }
      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO barcode_ranges (id, kind, prefix, next_value, max_value, owner_company, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, input.kind, input.prefix, input.next_value, input.max_value, ownerCompany, ts],
      );
      return {
        id:            id,
        kind:          input.kind,
        prefix:        input.prefix,
        next_value:    input.next_value,
        max_value:     input.max_value,
        owner_company: ownerCompany,
        created_at:    ts,
      };
    },

    listRanges: async function (opts2) {
      opts2 = opts2 || {};
      if (opts2.kind != null) _kind(opts2.kind);
      var sql, params;
      if (opts2.kind != null) {
        sql    = "SELECT id, kind, prefix, next_value, max_value, owner_company, created_at FROM barcode_ranges WHERE kind = ?1 ORDER BY created_at ASC, id ASC";
        params = [opts2.kind];
      } else {
        sql    = "SELECT id, kind, prefix, next_value, max_value, owner_company, created_at FROM barcode_ranges ORDER BY created_at ASC, id ASC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    renderSvg: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("barcodes.renderSvg: input object required");
      }
      _sku(input.sku);
      if (input.kind != null) _kind(input.kind);
      var sql, params;
      if (input.kind != null) {
        sql    = "SELECT kind, value FROM barcode_assignments WHERE sku = ?1 AND kind = ?2 ORDER BY assigned_at ASC LIMIT 1";
        params = [input.sku, input.kind];
      } else {
        sql    = "SELECT kind, value FROM barcode_assignments WHERE sku = ?1 ORDER BY assigned_at ASC LIMIT 1";
        params = [input.sku];
      }
      var r = await query(sql, params);
      if (!r.rows.length) {
        var miss = new Error("barcodes.renderSvg: sku has no assigned barcode" + (input.kind ? " for kind " + input.kind : ""));
        miss.code = "BARCODE_NOT_FOUND";
        throw miss;
      }
      var row = r.rows[0];
      var modules;
      if (row.kind === "upc_a" || row.kind === "ean_13") {
        modules = _renderEan(row.kind, row.value);
      } else if (row.kind === "gtin_14") {
        modules = _renderItf14(row.value);
      } else {
        modules = _renderCode128(row.value);
      }
      return _renderSvg(modules, row.value, { height_px: input.height_px, width_px: input.width_px });
    },
  };
}

module.exports = {
  create:        create,
  validateValue: validateValue,
  KINDS:         KINDS,
};
