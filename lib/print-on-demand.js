"use strict";
/**
 * @module shop.printOnDemand
 * @title  Print-on-demand primitive — supplier-agnostic binding +
 *         per-order forward-to-supplier fulfillment record
 *
 * @intro
 *   Operators selling print-on-demand goods (T-shirts, posters,
 *   books) bind each storefront SKU to a third-party supplier's
 *   blank product + variant + artwork. The supplier (Printful /
 *   Printify / Gelato / Lulu / Gooten / Cloudprinter, plus a
 *   `custom` escape hatch) prints and ships the physical good;
 *   the shop's role is to capture the order and forward the
 *   relevant lines to the right supplier.
 *
 *   This primitive is the binding store + the forward record. The
 *   actual HTTP call to the supplier lives in the operator's
 *   worker — each supplier has its own auth shape (API key in a
 *   header / OAuth2 / HMAC-signed request) and endpoint surface,
 *   and pinning a wire-format choice into the framework would
 *   shut out the operator whose preferred supplier isn't yet
 *   wired. The worker reads `pendingFulfillments`, calls the
 *   supplier, then calls back into this primitive to record the
 *   submission / shipment / failure.
 *
 *   Composition:
 *     - b.uuid.v7        — fulfillment row PKs
 *     - b.guardUuid      — strict UUID validation on read verbs
 *     - b.fsm            — pod_fulfillment status FSM (pending →
 *                          submitted → shipped, or → failed / cancelled)
 *     - b.audit          — FSM emits transition events under "fsm"
 *     - b.safeSql        — column allowlist for updateBinding patch
 *     - catalog.variants.bySku — bindSku refuses if the SKU doesn't
 *                          resolve to a real variant
 *
 *   The shop never holds inventory for these SKUs. `costForOrder`
 *   reports the operator's wholesale cost (used for margin
 *   reporting); storefront prices come from `pricing`.
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var SUPPLIERS = Object.freeze([
  "printful", "printify", "gelato", "lulu",
  "gooten", "cloudprinter", "custom",
]);

var FULFILLMENT_STATUSES = Object.freeze([
  "pending", "submitted", "shipped", "failed", "cancelled",
]);

// Columns the operator may patch via updateBinding. `sku` is the PK
// (rebind via unbind + bind, not via patch). `created_at` is
// immutable; `updated_at` is set by the primitive on every patch.
var ALLOWED_BINDING_COLUMNS = Object.freeze([
  "supplier",
  "supplier_product_id",
  "supplier_variant_id",
  "artwork_url",
  "position_json",
  "colorway",
  "cost_minor",
]);

var SKU_RE       = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var MAX_URL_LEN  = 2048;
var MAX_ID_LEN   = 256;
var MAX_COLORWAY_LEN = 64;
var MAX_TRACKING_LEN = 128;
var MAX_CARRIER_LEN  = 64;
var MAX_ERROR_LEN    = 4000;
var MAX_REASON_LEN   = 4000;
var MAX_LIST_LIMIT   = 200;

var BINDING_ORDER_KEY    = ["sku:asc"];
var FULFILLMENT_PENDING_ORDER_KEY = ["created_at:asc", "id:asc"];

// ---- FSM definition -----------------------------------------------------

var _podFsm = null;
function _getPodFsm() {
  if (_podFsm) return _podFsm;
  // b.fsm emits audit events under the 'fsm' namespace — register
  // idempotently so the audit sink keeps the events instead of
  // dropping them with a noisy warning.
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent; ignore */ }
  _podFsm = b.fsm.define({
    name:    "pod_fulfillment",
    initial: "pending",
    states: {
      pending:   {},
      submitted: {},
      shipped:   {},
      failed:    {},
      cancelled: {},
    },
    transitions: [
      { from: "pending",   to: "submitted", on: "submit" },
      { from: "submitted", to: "shipped",   on: "ship" },
      { from: "pending",   to: "failed",    on: "fail" },
      { from: "submitted", to: "failed",    on: "fail" },
      { from: "pending",   to: "cancelled", on: "cancel" },
      { from: "submitted", to: "cancelled", on: "cancel" },
    ],
  });
  return _podFsm;
}

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("print-on-demand: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("print-on-demand: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, <= 128 chars)");
  }
}
function _supplier(s) {
  if (typeof s !== "string" || SUPPLIERS.indexOf(s) === -1) {
    throw new TypeError("print-on-demand: supplier must be one of " + SUPPLIERS.join(", "));
  }
}
function _shortText(s, label, max) {
  if (typeof s !== "string" || !s.length || s.length > max) {
    throw new TypeError("print-on-demand: " + label + " must be a non-empty string <= " + max + " chars");
  }
}
function _optShortText(s, label, max) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > max) {
    throw new TypeError("print-on-demand: " + label + " must be a string <= " + max + " chars when provided");
  }
  return s;
}
function _url(s, label) {
  // Shape-tier validation: non-empty, reasonable length, no control
  // bytes. The supplier downloads the artwork — we don't fetch it
  // here, so a full HEAD-and-mime-sniff is out of scope. The
  // operator is responsible for handing in a URL the supplier can
  // actually reach (signed R2 / S3 / etc.).
  if (typeof s !== "string" || !s.length || s.length > MAX_URL_LEN) {
    throw new TypeError("print-on-demand: " + label + " must be a non-empty URL string <= " + MAX_URL_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("print-on-demand: " + label + " must not contain control characters");
  }
}
function _position(p, label) {
  // Position is an opaque JSON blob — different suppliers want
  // different shapes. The documented shape is {x, y, w, h, dpi};
  // each field, when present, must be a finite non-negative number.
  // Operators handing in supplier-specific extras (rotation, anchor)
  // see them round-trip without inspection.
  if (p == null) return {};
  if (typeof p !== "object" || Array.isArray(p)) {
    throw new TypeError("print-on-demand: " + label + " must be an object when provided");
  }
  var keys = ["x", "y", "w", "h", "dpi"];
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (Object.prototype.hasOwnProperty.call(p, k)) {
      var v = p[k];
      if (typeof v !== "number" || !isFinite(v) || v < 0) {
        throw new TypeError("print-on-demand: " + label + "." + k + " must be a non-negative finite number");
      }
    }
  }
  return p;
}
function _colorway(c) {
  if (c == null) return null;
  if (typeof c !== "string" || !c.length || c.length > MAX_COLORWAY_LEN) {
    throw new TypeError("print-on-demand: colorway must be a non-empty string <= " + MAX_COLORWAY_LEN + " chars when provided");
  }
  return c;
}
function _costMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("print-on-demand: cost_minor must be a non-negative integer (minor units)");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("print-on-demand: " + label + " must be a positive integer");
  }
}
function _shipTo(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    throw new TypeError("print-on-demand: shipping_address must be an object");
  }
  if (typeof s.country !== "string" || !/^[A-Z]{2}$/.test(s.country)) {
    throw new TypeError("print-on-demand: shipping_address.country must be a 2-letter ISO 3166-1 code (uppercase)");
  }
}
function _limit(n, label) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("print-on-demand: " + label + " must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog || !opts.catalog.variants || typeof opts.catalog.variants.bySku !== "function") {
    throw new TypeError("print-on-demand.create: opts.catalog with variants.bySku(sku) required");
  }
  var catalog = opts.catalog;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged via b.pagination so an
  // operator can't hand-craft one to skip past a binding or replay
  // across orderKey changes. The secret must be stable for the
  // deployment; rotating it invalidates outstanding cursors
  // (acceptable). Tests inject a fixed dev string; production must
  // supply an explicit secret.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("print-on-demand.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "print-on-demand-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Validate the line array shape (used by costForOrder +
  // forwardOrder). Returns the normalized lines + a flag for any
  // line whose SKU has no binding (the caller decides what to do).
  function _normalizeLines(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new TypeError("print-on-demand: lines must be a non-empty array");
    }
    var out = [];
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      if (!l || typeof l !== "object") {
        throw new TypeError("print-on-demand: lines[" + i + "] must be an object");
      }
      _sku(l.sku);
      _positiveInt(l.qty, "lines[" + i + "].qty");
      out.push({ sku: l.sku, qty: l.qty });
    }
    return out;
  }

  async function _getBindingRow(sku) {
    var r = await query("SELECT * FROM pod_bindings WHERE sku = ?1", [sku]);
    if (!r.rows.length) return null;
    var row = r.rows[0];
    row.position = row.position_json ? JSON.parse(row.position_json) : {};
    return row;
  }

  async function _getFulfillmentRow(id) {
    var r = await query("SELECT * FROM pod_fulfillments WHERE id = ?1", [id]);
    if (!r.rows.length) return null;
    var row = r.rows[0];
    row.lines    = row.lines_json    ? JSON.parse(row.lines_json)    : [];
    row.shipping = row.shipping_json ? JSON.parse(row.shipping_json) : {};
    return row;
  }

  // Replay the FSM against the row's current status and dispatch
  // the event. Surfaces b.fsm refusal as a typed error with the
  // original cause attached so a worker can distinguish "wrong
  // state" from "unknown row" without string-sniffing.
  async function _transitionFulfillment(fulfillmentId, event, patch) {
    var current = await _getFulfillmentRow(fulfillmentId);
    if (!current) {
      throw new TypeError("print-on-demand: fulfillment " + fulfillmentId + " not found");
    }
    var fsm = _getPodFsm();
    var instance = fsm.restore({
      state:   current.status,
      history: [],
      context: {},
    });
    // Resolve the destination state IN MEMORY, side-effect-free, with
    // `target` — it runs the same edge + guard check `transition` does but
    // emits NO audit and mutates no state (returns null for an illegal edge
    // or a guard-refused one). We must NOT call `transition` here: it emits a
    // "success" `fsm.pod_fulfillment.transition` audit, and emitting before
    // the atomic claim below would record a phantom success for a caller that
    // goes on to LOSE the race (the conditional UPDATE matches zero rows). The
    // real `transition` emit is deferred to the winning branch.
    var toState = instance.target(event);
    if (toState == null) {
      var err = new Error("print-on-demand: fulfillment transition refused — illegal edge '" +
        event + "' from state '" + current.status + "'");
      err.code = "POD_FULFILLMENT_TRANSITION_REFUSED";
      throw err;
    }
    var ts = _now();
    var sets = ["status = ?1", "updated_at = ?2"];
    var params = [toState, ts];
    var p = 3;
    var keys = Object.keys(patch || {});
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      // Each transition writes a known fixed set of columns; the
      // patch keys come from the primitive itself, never from
      // operator-controlled input. safeSql.assertOneOf is the
      // belt-and-braces gate so a future patch can't slip in an
      // operator-controlled column name.
      b.safeSql.assertOneOf(k, [
        "supplier_order_id", "tracking_number", "carrier",
        "error", "submitted_at", "shipped_at",
      ]);
      sets.push(k + " = ?" + p);
      params.push(patch[k]);
      p += 1;
    }
    params.push(fulfillmentId);       // ?p
    params.push(current.status);      // ?(p+1)
    // Cross-instance atomic claim — the transaction substitute on the D1
    // bridge. `target` above only validated the edge IN MEMORY (its lock is
    // per-instance, and each request restores a fresh instance), so two
    // concurrent transitions on the same row both pass it. Gating the write on
    // the row STILL being in the from-state we resolved against
    // (`AND status = <from>`) is the single-statement serialization point:
    // exactly one writer changes the row, the loser changes zero rows and is
    // refused (no last-writer-wins clobber of the winner's state + columns).
    var upd = await query(
      "UPDATE pod_fulfillments SET " + sets.join(", ") +
      " WHERE id = ?" + p + " AND status = ?" + (p + 1),
      params,
    );
    if (!b.sql.casWon(upd).won) {
      var raced = new Error("print-on-demand: fulfillment " + fulfillmentId +
        " changed state concurrently (no longer " + current.status + ") — transition refused");
      raced.code = "POD_FULFILLMENT_TRANSITION_REFUSED";
      throw raced;
    }
    // We won the atomic claim — the row really did advance current.status ->
    // toState. NOW drive the transition through b.fsm so its
    // `fsm.pod_fulfillment.transition=success` audit event fires exactly once
    // and only for the writer that actually changed the row. `target` above
    // already validated this edge, so `transition` cannot refuse; the row is
    // already persisted, so a throw here must never fail the caller.
    try { await instance.transition(event, null); }
    catch (_emitErr) { /* edge pre-validated by target(); audit emit is best-effort */ }
    return await _getFulfillmentRow(fulfillmentId);
  }

  return {
    SUPPLIERS:               SUPPLIERS,
    FULFILLMENT_STATUSES:    FULFILLMENT_STATUSES,
    ALLOWED_BINDING_COLUMNS: ALLOWED_BINDING_COLUMNS,

    bindSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-on-demand.bindSku: input object required");
      }
      _sku(input.sku);
      _supplier(input.supplier);
      _shortText(input.supplier_product_id, "supplier_product_id", MAX_ID_LEN);
      _shortText(input.supplier_variant_id, "supplier_variant_id", MAX_ID_LEN);
      _url(input.artwork_url, "artwork_url");
      var position = _position(input.position, "position");
      var colorway = _colorway(input.colorway);
      var costMinor = input.cost_minor == null ? 0 : input.cost_minor;
      _costMinor(costMinor);

      // Refuse if the SKU doesn't exist in the catalog. The bindSku
      // verb is the operator's commit point — if the catalog row
      // got renamed / deleted between SKU draft and bind, we want
      // the refusal here rather than a dangling binding that fires
      // on a non-existent storefront SKU.
      var variant = await catalog.variants.bySku(input.sku);
      if (!variant) {
        throw new TypeError("print-on-demand.bindSku: sku " + JSON.stringify(input.sku) + " not found in catalog");
      }

      // Refuse rebind via bindSku — use unbindSku + bindSku, or
      // updateBinding. This keeps the create path single-purpose
      // and surfaces the "switching supplier" choice explicitly to
      // the operator.
      var existing = await _getBindingRow(input.sku);
      if (existing) {
        throw new TypeError("print-on-demand.bindSku: sku " + JSON.stringify(input.sku) + " already bound — use updateBinding or unbindSku first");
      }

      var ts = _now();
      await query(
        "INSERT INTO pod_bindings (sku, supplier, supplier_product_id, supplier_variant_id, " +
        "artwork_url, position_json, colorway, cost_minor, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        [
          input.sku, input.supplier, input.supplier_product_id,
          input.supplier_variant_id, input.artwork_url,
          JSON.stringify(position), colorway, costMinor, ts,
        ],
      );
      return await _getBindingRow(input.sku);
    },

    unbindSku: async function (sku) {
      _sku(sku);
      var r = await query("DELETE FROM pod_bindings WHERE sku = ?1", [sku]);
      return r.rowCount > 0;
    },

    getBinding: async function (sku) {
      _sku(sku);
      return await _getBindingRow(sku);
    },

    // Paginated list of bindings, ordered by sku ASC (alphabetical;
    // the admin-list-of-skus shape). Optional `supplier` filter
    // narrows to one integration. Cursor is HMAC-tagged.
    listBindings: async function (listOpts) {
      listOpts = listOpts || {};
      var supplier = null;
      if (listOpts.supplier != null) {
        _supplier(listOpts.supplier);
        supplier = listOpts.supplier;
      }
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit, "limit");

      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("print-on-demand.listBindings: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(BINDING_ORDER_KEY)) {
            throw new TypeError("print-on-demand.listBindings: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("print-on-demand.listBindings: cursor — " + (e && e.message || "malformed"));
        }
      }

      var sql, params;
      if (supplier && cursorVals) {
        sql = "SELECT * FROM pod_bindings WHERE supplier = ?1 AND sku > ?2 " +
              "ORDER BY sku ASC LIMIT ?3";
        params = [supplier, cursorVals[0], limit];
      } else if (supplier) {
        sql = "SELECT * FROM pod_bindings WHERE supplier = ?1 " +
              "ORDER BY sku ASC LIMIT ?2";
        params = [supplier, limit];
      } else if (cursorVals) {
        sql = "SELECT * FROM pod_bindings WHERE sku > ?1 " +
              "ORDER BY sku ASC LIMIT ?2";
        params = [cursorVals[0], limit];
      } else {
        sql = "SELECT * FROM pod_bindings ORDER BY sku ASC LIMIT ?1";
        params = [limit];
      }
      var rows = (await query(sql, params)).rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].position = rows[i].position_json ? JSON.parse(rows[i].position_json) : {};
      }
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: BINDING_ORDER_KEY,
          vals:     [last.sku],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    updateBinding: async function (sku, patch) {
      _sku(sku);
      if (!patch || typeof patch !== "object") {
        throw new TypeError("print-on-demand.updateBinding: patch object required");
      }
      var existing = await _getBindingRow(sku);
      if (!existing) {
        throw new TypeError("print-on-demand.updateBinding: sku " + JSON.stringify(sku) + " not bound");
      }
      var sets = [];
      var params = [];
      var i = 1;
      var keys = Object.keys(patch);
      for (var k = 0; k < keys.length; k += 1) {
        var col = keys[k];
        // safeSql.assertOneOf is the structural gate; the
        // per-column validators below enforce the value shape.
        b.safeSql.assertOneOf(col, ALLOWED_BINDING_COLUMNS);
        var val = patch[col];
        if (col === "supplier")              { _supplier(val); }
        else if (col === "supplier_product_id") { _shortText(val, "supplier_product_id", MAX_ID_LEN); }
        else if (col === "supplier_variant_id") { _shortText(val, "supplier_variant_id", MAX_ID_LEN); }
        else if (col === "artwork_url")      { _url(val, "artwork_url"); }
        else if (col === "position_json")    { val = JSON.stringify(_position(val, "position")); }
        else if (col === "colorway")         { val = _colorway(val); }
        else if (col === "cost_minor")       { _costMinor(val); }
        sets.push(col + " = ?" + i);
        params.push(val);
        i += 1;
      }
      if (!sets.length) {
        throw new TypeError("print-on-demand.updateBinding: patch must contain at least one allowed column (" + ALLOWED_BINDING_COLUMNS.join(", ") + ")");
      }
      sets.push("updated_at = ?" + i);
      params.push(_now());
      i += 1;
      params.push(sku);
      await query(
        "UPDATE pod_bindings SET " + sets.join(", ") + " WHERE sku = ?" + i,
        params,
      );
      return await _getBindingRow(sku);
    },

    // Aggregate the operator's wholesale cost across the lines on
    // an order. SKUs without a binding contribute 0 cost and are
    // reported on `unbound_skus` so the caller can surface the
    // gap. Returns `{ total_cost_minor, by_supplier, unbound_skus }`.
    costForOrder: async function (orderLines) {
      var lines = _normalizeLines(orderLines);
      var totalCost = 0;
      var bySupplier = {};
      var unbound = [];
      for (var i = 0; i < lines.length; i += 1) {
        var l = lines[i];
        var binding = await _getBindingRow(l.sku);
        if (!binding) {
          unbound.push(l.sku);
          continue;
        }
        var lineCost = binding.cost_minor * l.qty;
        totalCost += lineCost;
        if (!bySupplier[binding.supplier]) {
          bySupplier[binding.supplier] = { cost_minor: 0, line_count: 0 };
        }
        bySupplier[binding.supplier].cost_minor += lineCost;
        bySupplier[binding.supplier].line_count += 1;
      }
      return {
        total_cost_minor: totalCost,
        by_supplier:      bySupplier,
        unbound_skus:     unbound,
      };
    },

    // Forward an order's POD lines to the supplier. Writes ONE
    // pod_fulfillments row per supplier present on the order, in
    // `pending` status. Returns the list of row ids the worker
    // should pick up. Lines whose SKU has no binding are returned
    // on `unbound_skus` and do NOT create a fulfillment row (the
    // operator's pre-flight is expected to refuse the checkout in
    // that case; this primitive is defensive in case it slips
    // through).
    forwardOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-on-demand.forwardOrder: input object required");
      }
      _uuid(input.order_id, "order_id");
      _shipTo(input.shipping_address);
      var lines = _normalizeLines(input.lines);

      // Bucket lines per supplier so each supplier gets one
      // fulfillment row (with all its lines bundled). Unbound SKUs
      // are surfaced separately.
      var perSupplier = {};
      var unbound = [];
      for (var i = 0; i < lines.length; i += 1) {
        var l = lines[i];
        var binding = await _getBindingRow(l.sku);
        if (!binding) { unbound.push(l.sku); continue; }
        if (!perSupplier[binding.supplier]) perSupplier[binding.supplier] = [];
        perSupplier[binding.supplier].push({
          sku:                 l.sku,
          qty:                 l.qty,
          supplier_product_id: binding.supplier_product_id,
          supplier_variant_id: binding.supplier_variant_id,
          artwork_url:         binding.artwork_url,
          position:            binding.position,
          colorway:            binding.colorway,
          cost_minor:          binding.cost_minor,
        });
      }

      var ts = _now();
      var fulfillmentIds = [];
      var suppliers = Object.keys(perSupplier);
      for (var s = 0; s < suppliers.length; s += 1) {
        var supplier = suppliers[s];
        var fid = b.uuid.v7();
        await query(
          "INSERT INTO pod_fulfillments (id, order_id, supplier, status, lines_json, " +
          "shipping_json, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?6)",
          [
            fid, input.order_id, supplier,
            JSON.stringify(perSupplier[supplier]),
            JSON.stringify(input.shipping_address),
            ts,
          ],
        );
        fulfillmentIds.push(fid);
      }
      return {
        fulfillment_ids: fulfillmentIds,
        unbound_skus:    unbound,
      };
    },

    markFulfillmentSubmitted: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-on-demand.markFulfillmentSubmitted: input object required");
      }
      _uuid(input.pod_fulfillment_id, "pod_fulfillment_id");
      _shortText(input.supplier_order_id, "supplier_order_id", MAX_ID_LEN);
      return await _transitionFulfillment(input.pod_fulfillment_id, "submit", {
        supplier_order_id: input.supplier_order_id,
        submitted_at:      _now(),
      });
    },

    markFulfillmentShipped: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-on-demand.markFulfillmentShipped: input object required");
      }
      _uuid(input.pod_fulfillment_id, "pod_fulfillment_id");
      _shortText(input.tracking_number, "tracking_number", MAX_TRACKING_LEN);
      _shortText(input.carrier, "carrier", MAX_CARRIER_LEN);
      return await _transitionFulfillment(input.pod_fulfillment_id, "ship", {
        tracking_number: input.tracking_number,
        carrier:         input.carrier,
        shipped_at:      _now(),
      });
    },

    markFulfillmentFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-on-demand.markFulfillmentFailed: input object required");
      }
      _uuid(input.pod_fulfillment_id, "pod_fulfillment_id");
      _shortText(input.error, "error", MAX_ERROR_LEN);
      return await _transitionFulfillment(input.pod_fulfillment_id, "fail", {
        error: input.error,
      });
    },

    markFulfillmentCancelled: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-on-demand.markFulfillmentCancelled: input object required");
      }
      _uuid(input.pod_fulfillment_id, "pod_fulfillment_id");
      var reason = _optShortText(input.reason, "reason", MAX_REASON_LEN);
      var patch = {};
      // Cancellation reason lands in the `error` column so the
      // operator-facing single field carries the "why is this
      // terminal" answer regardless of whether it terminated via
      // fail or cancel. Operators that want a richer audit trail
      // compose on top.
      if (reason != null) patch.error = "[cancelled] " + reason;
      return await _transitionFulfillment(input.pod_fulfillment_id, "cancel", patch);
    },

    getFulfillment: async function (id) {
      _uuid(id, "pod_fulfillment_id");
      return await _getFulfillmentRow(id);
    },

    // All fulfillments for one order, ordered by created_at ASC
    // (the order the supplier rows were written). Operators
    // rendering an order detail page get the supplier-by-supplier
    // breakdown in the order the forward fired.
    fulfillmentsForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var rows = (await query(
        "SELECT * FROM pod_fulfillments WHERE order_id = ?1 ORDER BY created_at ASC, id ASC",
        [orderId],
      )).rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].lines    = rows[i].lines_json    ? JSON.parse(rows[i].lines_json)    : [];
        rows[i].shipping = rows[i].shipping_json ? JSON.parse(rows[i].shipping_json) : {};
      }
      return rows;
    },

    // Worker queue drain: pending rows in FIFO order so the
    // longest-waiting fulfillment goes first. Optional supplier
    // filter narrows to one integration's worker.
    pendingFulfillments: async function (listOpts) {
      listOpts = listOpts || {};
      var supplier = null;
      if (listOpts.supplier != null) {
        _supplier(listOpts.supplier);
        supplier = listOpts.supplier;
      }
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit, "limit");
      var sql, params;
      if (supplier) {
        sql = "SELECT * FROM pod_fulfillments WHERE status = 'pending' AND supplier = ?1 " +
              "ORDER BY created_at ASC, id ASC LIMIT ?2";
        params = [supplier, limit];
      } else {
        sql = "SELECT * FROM pod_fulfillments WHERE status = 'pending' " +
              "ORDER BY created_at ASC, id ASC LIMIT ?1";
        params = [limit];
      }
      var rows = (await query(sql, params)).rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].lines    = rows[i].lines_json    ? JSON.parse(rows[i].lines_json)    : [];
        rows[i].shipping = rows[i].shipping_json ? JSON.parse(rows[i].shipping_json) : {};
      }
      // Worker queue drain doesn't paginate by cursor — the worker
      // re-runs the query after handling the batch. The
      // FULFILLMENT_PENDING_ORDER_KEY constant documents the
      // ordering for callers that need it (see exports).
      void FULFILLMENT_PENDING_ORDER_KEY;
      return rows;
    },
  };
}

module.exports = {
  create:                          create,
  SUPPLIERS:                       SUPPLIERS,
  FULFILLMENT_STATUSES:            FULFILLMENT_STATUSES,
  ALLOWED_BINDING_COLUMNS:         ALLOWED_BINDING_COLUMNS,
  // Exposed so the test suite can assert the FSM shape without
  // re-deriving the definition from the transitions table.
  _getPodFsm:                      _getPodFsm,
};
