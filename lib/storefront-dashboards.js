"use strict";
/**
 * @module shop.storefrontDashboards
 * @title  Storefront dashboards — operator-curated widget layouts
 *
 * @intro
 *   Operators curate dashboard layouts that compose multiple data
 *   sources into a single read-only view. Each dashboard is a named
 *   arrangement of widgets (revenue chart, top products, recent
 *   orders, inventory low-stock, cart abandonment, etc.) — the
 *   storage holds only the layout + widget descriptors; the live
 *   data is pulled from existing shop primitives at render time.
 *
 *   Each dashboard carries:
 *     - a stable URL-friendly `slug` (PK),
 *     - a `title` shown in the dashboard header,
 *     - a `layout` token from a closed enum
 *       (grid_2col / grid_3col / single_column / freeform),
 *     - an ordered `widgets` array of `{ id, kind, config }`
 *       descriptors — `kind` is one of a closed enum
 *       (revenue_chart, top_products, top_customers,
 *       inventory_low_stock, cart_abandonment, order_status_funnel,
 *       recent_orders, aov_trend, refund_rate),
 *     - optional `owner_type` (operator | tenant) + `owner_id` —
 *       both nullable; nullable owner means "global default",
 *       owner_type = 'operator' + null owner_id means "operator
 *       catalog", owner_type = 'tenant' + owner_id = UUID means
 *       "tenant catalog",
 *     - an `archived_at` instant — archived dashboards stay in the
 *       table so a clone or audit can resolve the slug, but they're
 *       excluded from `listDashboards` unless the caller asks for
 *       them explicitly.
 *
 *   Composes:
 *     - the four injected data sources — `salesReports`, `analytics`,
 *       `cartAbandonment`, `inventoryAlerts` — each optional.
 *       `renderDashboard` walks the widget list and, for each widget,
 *       picks the data source that owns the metric and calls the
 *       matching method. When a widget's data source isn't injected,
 *       the rendered widget carries `data: null` so the dashboard
 *       still renders a slot for the operator to wire later.
 *
 *   Surface:
 *     - `create({ query?, salesReports?, analytics?, cartAbandonment?,
 *                 inventoryAlerts? })` — factory. `query` is optional;
 *       absent it, the primitive talks to `b.externalDb.query`
 *       directly. The four data sources are optional; widgets that
 *       map to a missing source render with `data: null`.
 *     - `defineDashboard({ slug, title, layout, widgets,
 *                         owner_type?, owner_id? })` — insert a
 *       dashboard row. Widgets are validated for shape (each is a
 *       `{ id, kind, config }` with `id` URL-friendly, `kind` from
 *       the enum, `config` an object) before they reach the
 *       database. Duplicate widget ids inside one dashboard refused.
 *     - `getDashboard(slug)` — single row, any archive state.
 *     - `listDashboards({ owner_type?, owner_id? })` — enumerate
 *       active (non-archived) dashboards in the matching ownership
 *       scope. Both owner fields optional; omitting both returns
 *       every active dashboard.
 *     - `updateDashboard(slug, patch)` — patch any of
 *       `title / layout / widgets`. Each call re-validates the
 *       widgets array if it's in the patch.
 *     - `archiveDashboard(slug)` — stamp `archived_at`. Idempotent
 *       once archived (re-archiving is refused). Archived dashboards
 *       drop out of `listDashboards`.
 *     - `cloneDashboard({ source_slug, new_slug, new_title?,
 *                        new_owner? })` — copy a dashboard's layout
 *       + widgets to a new slug. The new dashboard starts un-
 *       archived even if the source was archived. `new_title`
 *       defaults to the source title; `new_owner` is an optional
 *       `{ owner_type, owner_id }` pair — absent, the clone inherits
 *       the source's ownership.
 *     - `renderDashboard({ slug, from, to, locale? })` — async;
 *       reads the dashboard by slug and walks its widgets, calling
 *       each widget's data source against the `{ from, to }` window.
 *       Returns `{ widgets: [{ id, kind, data, locale_strings }] }`.
 *       The `locale_strings` map carries the widget's display
 *       strings (title + axis labels) localized to `locale` (or to
 *       `"en"` if `locale` is omitted). When the widget's data
 *       source isn't injected, `data` is null. The slug must exist
 *       and must not be archived (an archived dashboard refuses to
 *       render — the operator must restore-by-clone first).
 *
 *   Storage:
 *     - `storefront_dashboards` (migration `0091_storefront_dashboards.sql`).
 *
 * @primitive storefrontDashboards
 * @related   b.template.escapeHtml, b.guardUuid
 */

var b = require("./vendor/blamejs");

var MAX_SLUG_LEN     = 80;
var MAX_TITLE_LEN    = 200;
var MAX_WIDGET_ID_LEN = 80;
var MAX_WIDGETS_PER_DASHBOARD = 24;
var MAX_LOCALE_LEN   = 35;

var ALLOWED_LAYOUTS = Object.freeze([
  "grid_2col",
  "grid_3col",
  "single_column",
  "freeform",
]);

var ALLOWED_WIDGET_KINDS = Object.freeze([
  "revenue_chart",
  "top_products",
  "top_customers",
  "inventory_low_stock",
  "cart_abandonment",
  "order_status_funnel",
  "recent_orders",
  "aov_trend",
  "refund_rate",
]);

var ALLOWED_OWNER_TYPES = Object.freeze([
  "operator",
  "tenant",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "layout",
  "widgets",
]);

// Slug + widget id shape mirrors the rest of the storefront
// primitives — alnum leading character, alnum + dot + hyphen +
// underscore tail, capped length. The slug reaches operator logs +
// the admin URL `/admin/dashboards/<slug>`, so the shape stays
// narrow.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var WIDGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// BCP-47 locale shape — language (2-3 letters) + optional subtags.
// Lowercase the input before matching against this regex so the
// fallback walker sees a stable canonical form.
var LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

// Refuse C0 control bytes + DEL in operator-authored text fields.
var CONTROL_BYTE_LINE_RE = /[\x00-\x1f\x7f]/;

// Zero-width / direction-override family — mirrors the rest of the
// shop primitives. Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  label = label || "slug";
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError(
      "storefrontDashboards: " + label +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)"
    );
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("storefrontDashboards: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("storefrontDashboards: title contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("storefrontDashboards: title contains zero-width / direction-override characters");
  }
  return s;
}

function _layout(s) {
  if (typeof s !== "string" || ALLOWED_LAYOUTS.indexOf(s) === -1) {
    throw new TypeError("storefrontDashboards: layout must be one of " + JSON.stringify(ALLOWED_LAYOUTS));
  }
  return s;
}

function _widgetKind(s) {
  if (typeof s !== "string" || ALLOWED_WIDGET_KINDS.indexOf(s) === -1) {
    throw new TypeError(
      "storefrontDashboards: widget kind must be one of " +
      JSON.stringify(ALLOWED_WIDGET_KINDS)
    );
  }
  return s;
}

function _widgetId(s) {
  if (typeof s !== "string" || !WIDGET_ID_RE.test(s)) {
    throw new TypeError(
      "storefrontDashboards: widget id must match " +
      "/^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_WIDGET_ID_LEN + " chars)"
    );
  }
  return s;
}

function _widgetConfig(c) {
  if (c == null) return {};
  if (typeof c !== "object" || Array.isArray(c)) {
    throw new TypeError("storefrontDashboards: widget config must be a plain object");
  }
  // Round-trip through JSON to verify the config is JSON-safe
  // (functions / Symbols / undefined-valued keys / BigInt / cycles
  // are all refused). The serialized form is what lands in
  // widgets_json; a value we can't round-trip is not storable.
  var serialized;
  try {
    serialized = JSON.stringify(c);
  } catch (e) {
    throw new TypeError(
      "storefrontDashboards: widget config is not JSON-serializable: " +
      (e && e.message || "unknown")
    );
  }
  if (typeof serialized !== "string") {
    throw new TypeError("storefrontDashboards: widget config did not serialize to a string");
  }
  // Reject configs that JSON.stringify-ed to undefined (raw
  // function / Symbol values would have surfaced before this, but a
  // top-level Symbol slips through). Belt-and-braces.
  return JSON.parse(serialized);
}

function _widgets(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError("storefrontDashboards: widgets must be an array");
  }
  if (!arr.length) {
    throw new TypeError("storefrontDashboards: widgets must contain at least one entry");
  }
  if (arr.length > MAX_WIDGETS_PER_DASHBOARD) {
    throw new TypeError(
      "storefrontDashboards: widgets array exceeds " +
      MAX_WIDGETS_PER_DASHBOARD + "-entry cap"
    );
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var w = arr[i];
    if (!w || typeof w !== "object" || Array.isArray(w)) {
      throw new TypeError(
        "storefrontDashboards: widgets[" + i + "] must be a plain object"
      );
    }
    var id     = _widgetId(w.id);
    var kind   = _widgetKind(w.kind);
    var config = _widgetConfig(w.config);
    if (seen[id]) {
      throw new TypeError(
        "storefrontDashboards: duplicate widget id " + JSON.stringify(id) +
        " inside dashboard"
      );
    }
    seen[id] = true;
    out.push({ id: id, kind: kind, config: config });
  }
  return out;
}

function _ownerType(s) {
  if (s == null) return null;
  if (typeof s !== "string" || ALLOWED_OWNER_TYPES.indexOf(s) === -1) {
    throw new TypeError(
      "storefrontDashboards: owner_type must be one of " +
      JSON.stringify(ALLOWED_OWNER_TYPES) + " (or null)"
    );
  }
  return s;
}

function _ownerId(s) {
  if (s == null) return null;
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError(
      "storefrontDashboards: owner_id — " + (e && e.message || "invalid UUID")
    );
  }
}

function _locale(s) {
  if (s == null) return "en";
  if (typeof s !== "string" || !s.length || s.length > MAX_LOCALE_LEN) {
    throw new TypeError(
      "storefrontDashboards: locale must be a non-empty BCP-47 string <= " +
      MAX_LOCALE_LEN + " chars"
    );
  }
  var canonical = s.toLowerCase();
  if (!LOCALE_RE.test(canonical)) {
    throw new TypeError(
      "storefrontDashboards: locale " + JSON.stringify(s) +
      " is not a valid BCP-47 shape"
    );
  }
  return canonical;
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new TypeError(
      "storefrontDashboards: " + label +
      " must be a non-negative integer epoch-ms"
    );
  }
  return n;
}

function _window(from, to) {
  _epochMs(from, "from");
  _epochMs(to,   "to");
  if (to <= from) {
    throw new TypeError(
      "storefrontDashboards: to (" + to + ") must be > from (" + from + ")"
    );
  }
  return { from: from, to: to };
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  // widgets_json was written by us via JSON.stringify of a validated
  // widgets array; parsing it back can't realistically fail, but a
  // SQL-layer corruption would land as a noisy error here. That's
  // the right tier (config-tier — a corrupted dashboard row is an
  // operator bug worth surfacing).
  var widgets;
  try {
    widgets = JSON.parse(r.widgets_json);
  } catch (e) {
    throw new TypeError(
      "storefrontDashboards: dashboard " + JSON.stringify(r.slug) +
      " has corrupt widgets_json — " + (e && e.message || "parse failed")
    );
  }
  return {
    slug:         r.slug,
    title:        r.title,
    layout:       r.layout,
    widgets:      widgets,
    owner_type:   r.owner_type == null ? null : r.owner_type,
    owner_id:     r.owner_id   == null ? null : r.owner_id,
    archived_at:  r.archived_at == null ? null : Number(r.archived_at),
    created_at:   Number(r.created_at),
    updated_at:   Number(r.updated_at),
  };
}

// ---- widget localization ------------------------------------------------
//
// Each widget kind ships a tiny set of display strings that the
// dashboard admin UI renders alongside the data. These are not
// operator-authored — they're framework-authored chrome, and the
// primitive carries an English baseline plus a small "es" / "fr"
// catalogue so the multi-locale tenant case isn't a v1-deferred
// stub. The catalogue is keyed on the canonical BCP-47 locale and
// walks the fallback chain right-to-left until it lands on a key
// that exists — e.g. `fr-ca` → `fr-ca` → `fr` → `en`.

var WIDGET_STRINGS = Object.freeze({
  en: {
    revenue_chart:        { title: "Revenue",            x_axis: "Day",      y_axis: "Revenue" },
    top_products:         { title: "Top products",       column_label: "Product" },
    top_customers:        { title: "Top customers",      column_label: "Customer" },
    inventory_low_stock:  { title: "Low stock",          column_label: "SKU" },
    cart_abandonment:     { title: "Cart abandonment",   column_label: "Cart" },
    order_status_funnel:  { title: "Order funnel",       column_label: "Status" },
    recent_orders:        { title: "Recent orders",      column_label: "Order" },
    aov_trend:            { title: "Average order value", x_axis: "Day",     y_axis: "AOV" },
    refund_rate:          { title: "Refund rate",        x_axis: "Day",      y_axis: "Refunds" },
  },
  es: {
    revenue_chart:        { title: "Ingresos",                x_axis: "Día",   y_axis: "Ingresos" },
    top_products:         { title: "Productos principales",   column_label: "Producto" },
    top_customers:        { title: "Clientes principales",    column_label: "Cliente" },
    inventory_low_stock:  { title: "Inventario bajo",         column_label: "SKU" },
    cart_abandonment:     { title: "Carritos abandonados",    column_label: "Carrito" },
    order_status_funnel:  { title: "Embudo de pedidos",       column_label: "Estado" },
    recent_orders:        { title: "Pedidos recientes",       column_label: "Pedido" },
    aov_trend:            { title: "Valor medio del pedido",  x_axis: "Día",   y_axis: "VMP" },
    refund_rate:          { title: "Tasa de reembolsos",      x_axis: "Día",   y_axis: "Reembolsos" },
  },
  fr: {
    revenue_chart:        { title: "Revenu",                x_axis: "Jour",  y_axis: "Revenu" },
    top_products:         { title: "Meilleurs produits",    column_label: "Produit" },
    top_customers:        { title: "Meilleurs clients",     column_label: "Client" },
    inventory_low_stock:  { title: "Stock faible",          column_label: "SKU" },
    cart_abandonment:     { title: "Paniers abandonnés",    column_label: "Panier" },
    order_status_funnel:  { title: "Entonnoir de commandes", column_label: "Statut" },
    recent_orders:        { title: "Commandes récentes",    column_label: "Commande" },
    aov_trend:            { title: "Valeur moyenne",        x_axis: "Jour",  y_axis: "VM" },
    refund_rate:          { title: "Taux de remboursement", x_axis: "Jour",  y_axis: "Remboursements" },
  },
});

function _localeFallbackChain(locale) {
  var chain = [];
  var cur = locale;
  while (cur && cur.length) {
    chain.push(cur);
    var dash = cur.lastIndexOf("-");
    if (dash === -1) break;
    cur = cur.slice(0, dash);
  }
  if (chain.indexOf("en") === -1) chain.push("en");
  return chain;
}

function _localeStringsFor(kind, locale) {
  var chain = _localeFallbackChain(locale);
  for (var i = 0; i < chain.length; i += 1) {
    var bucket = WIDGET_STRINGS[chain[i]];
    if (bucket && bucket[kind]) return bucket[kind];
  }
  return WIDGET_STRINGS.en[kind];
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var salesReports    = opts.salesReports    || null;
  var analytics       = opts.analytics       || null;
  var cartAbandonment = opts.cartAbandonment || null;
  var inventoryAlerts = opts.inventoryAlerts || null;

  // -- defineDashboard --------------------------------------------------

  async function defineDashboard(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontDashboards.defineDashboard: input object required");
    }
    var slug       = _slug(input.slug);
    var title      = _title(input.title);
    var layout     = _layout(input.layout);
    var widgets    = _widgets(input.widgets);
    var ownerType  = _ownerType(input.owner_type);
    var ownerId    = _ownerId(input.owner_id);

    // owner_id without owner_type is refused — an orphaned owner_id
    // can't be filtered consistently by the catalog list.
    if (ownerId != null && ownerType == null) {
      throw new TypeError(
        "storefrontDashboards.defineDashboard: owner_id requires owner_type"
      );
    }

    var ts = _now();
    try {
      await query(
        "INSERT INTO storefront_dashboards " +
        "(slug, title, layout, widgets_json, owner_type, owner_id, " +
        " archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
        [slug, title, layout, JSON.stringify(widgets), ownerType, ownerId, ts],
      );
    } catch (e) {
      // Surface a duplicate-slug collision with a clear message;
      // anything else propagates as-is.
      var msg = (e && e.message || "").toLowerCase();
      if (msg.indexOf("unique") !== -1 || msg.indexOf("primary key") !== -1) {
        throw new TypeError(
          "storefrontDashboards.defineDashboard: slug " + JSON.stringify(slug) +
          " already exists"
        );
      }
      throw e;
    }
    return await getDashboard(slug);
  }

  // -- getDashboard / listDashboards -----------------------------------

  async function getDashboard(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM storefront_dashboards WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function listDashboards(listOpts) {
    listOpts = listOpts || {};
    var hasOwnerType = listOpts.owner_type !== undefined;
    var hasOwnerId   = listOpts.owner_id   !== undefined;
    var ownerType    = hasOwnerType ? _ownerType(listOpts.owner_type) : undefined;
    var ownerId      = hasOwnerId   ? _ownerId(listOpts.owner_id)     : undefined;

    var clauses = ["archived_at IS NULL"];
    var params  = [];
    var idx     = 1;
    if (hasOwnerType) {
      if (ownerType == null) {
        clauses.push("owner_type IS NULL");
      } else {
        clauses.push("owner_type = ?" + idx);
        params.push(ownerType);
        idx += 1;
      }
    }
    if (hasOwnerId) {
      if (ownerId == null) {
        clauses.push("owner_id IS NULL");
      } else {
        clauses.push("owner_id = ?" + idx);
        params.push(ownerId);
        idx += 1;
      }
    }
    var sql = "SELECT * FROM storefront_dashboards WHERE " +
              clauses.join(" AND ") +
              " ORDER BY created_at ASC, slug ASC";
    var rows = (await query(sql, params)).rows;
    return rows.map(_hydrateRow);
  }

  // -- updateDashboard --------------------------------------------------

  async function updateDashboard(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("storefrontDashboards.updateDashboard: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError(
        "storefrontDashboards.updateDashboard: patch must include at least one column"
      );
    }

    var current = await getDashboard(slug);
    if (!current) {
      throw new TypeError(
        "storefrontDashboards.updateDashboard: slug " + JSON.stringify(slug) + " not found"
      );
    }
    if (current.archived_at != null) {
      throw new TypeError(
        "storefrontDashboards.updateDashboard: slug " + JSON.stringify(slug) +
        " is archived — clone it to a new slug to edit"
      );
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError(
          "storefrontDashboards.updateDashboard: unsupported column " + JSON.stringify(col)
        );
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
        idx += 1;
      } else if (col === "layout") {
        sets.push("layout = ?" + idx);
        params.push(_layout(patch[col]));
        idx += 1;
      } else /* widgets */ {
        sets.push("widgets_json = ?" + idx);
        params.push(JSON.stringify(_widgets(patch[col])));
        idx += 1;
      }
    }
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;

    params.push(slug);
    var r = await query(
      "UPDATE storefront_dashboards SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError(
        "storefrontDashboards.updateDashboard: slug " + JSON.stringify(slug) + " not found"
      );
    }
    return await getDashboard(slug);
  }

  // -- archiveDashboard -------------------------------------------------

  async function archiveDashboard(slug) {
    _slug(slug);
    var current = await getDashboard(slug);
    if (!current) {
      throw new TypeError(
        "storefrontDashboards.archiveDashboard: slug " + JSON.stringify(slug) + " not found"
      );
    }
    if (current.archived_at != null) {
      throw new TypeError(
        "storefrontDashboards.archiveDashboard: slug " + JSON.stringify(slug) +
        " is already archived"
      );
    }
    var ts = _now();
    var r = await query(
      "UPDATE storefront_dashboards SET archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError(
        "storefrontDashboards.archiveDashboard: slug " + JSON.stringify(slug) + " transition race"
      );
    }
    return await getDashboard(slug);
  }

  // -- cloneDashboard ---------------------------------------------------
  //
  // Copy a dashboard's layout + widgets to a new slug. The clone
  // starts un-archived even if the source was archived (the clone
  // path is how an operator brings an archived dashboard back into
  // the active catalog without touching the original). `new_title`
  // defaults to the source title; `new_owner` is an optional
  // `{ owner_type, owner_id }` override.

  async function cloneDashboard(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontDashboards.cloneDashboard: input object required");
    }
    var sourceSlug = _slug(input.source_slug, "source_slug");
    var newSlug    = _slug(input.new_slug,    "new_slug");
    if (sourceSlug === newSlug) {
      throw new TypeError(
        "storefrontDashboards.cloneDashboard: new_slug must differ from source_slug"
      );
    }

    var source = await getDashboard(sourceSlug);
    if (!source) {
      throw new TypeError(
        "storefrontDashboards.cloneDashboard: source_slug " +
        JSON.stringify(sourceSlug) + " not found"
      );
    }

    var newTitle = input.new_title == null ? source.title : _title(input.new_title);

    var ownerType;
    var ownerId;
    if (input.new_owner === undefined || input.new_owner === null) {
      ownerType = source.owner_type;
      ownerId   = source.owner_id;
    } else {
      if (typeof input.new_owner !== "object" || Array.isArray(input.new_owner)) {
        throw new TypeError(
          "storefrontDashboards.cloneDashboard: new_owner must be an object " +
          "with { owner_type, owner_id } (or null)"
        );
      }
      ownerType = _ownerType(input.new_owner.owner_type);
      ownerId   = _ownerId(input.new_owner.owner_id);
      if (ownerId != null && ownerType == null) {
        throw new TypeError(
          "storefrontDashboards.cloneDashboard: new_owner.owner_id requires owner_type"
        );
      }
    }

    var ts = _now();
    try {
      await query(
        "INSERT INTO storefront_dashboards " +
        "(slug, title, layout, widgets_json, owner_type, owner_id, " +
        " archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
        [
          newSlug, newTitle, source.layout,
          JSON.stringify(source.widgets),
          ownerType, ownerId, ts,
        ],
      );
    } catch (e) {
      var msg = (e && e.message || "").toLowerCase();
      if (msg.indexOf("unique") !== -1 || msg.indexOf("primary key") !== -1) {
        throw new TypeError(
          "storefrontDashboards.cloneDashboard: new_slug " + JSON.stringify(newSlug) +
          " already exists"
        );
      }
      throw e;
    }
    return await getDashboard(newSlug);
  }

  // -- renderDashboard --------------------------------------------------
  //
  // Walk the dashboard's widget list and, for each widget, pick the
  // data source that owns the metric and call the matching method.
  // When a widget's data source isn't injected, the rendered widget
  // carries `data: null` so the dashboard still renders a slot.

  async function _renderWidget(widget, window, locale) {
    var kind = widget.kind;
    var cfg  = widget.config || {};
    var localeStrings = _localeStringsFor(kind, locale);
    var out = {
      id:             widget.id,
      kind:           kind,
      data:           null,
      locale_strings: localeStrings,
    };
    if (kind === "revenue_chart") {
      if (salesReports && typeof salesReports.revenueByDay === "function") {
        out.data = await salesReports.revenueByDay({
          from:     window.from,
          to:       window.to,
          currency: cfg.currency,
        });
      }
    } else if (kind === "top_products") {
      if (salesReports && typeof salesReports.topProducts === "function") {
        out.data = await salesReports.topProducts({
          from:     window.from,
          to:       window.to,
          currency: cfg.currency,
          limit:    cfg.limit,
        });
      }
    } else if (kind === "top_customers") {
      if (salesReports && typeof salesReports.topCustomers === "function") {
        out.data = await salesReports.topCustomers({
          from:     window.from,
          to:       window.to,
          currency: cfg.currency,
          limit:    cfg.limit,
        });
      }
    } else if (kind === "order_status_funnel") {
      if (salesReports && typeof salesReports.funnel === "function") {
        out.data = await salesReports.funnel({
          from: window.from,
          to:   window.to,
        });
      }
    } else if (kind === "aov_trend") {
      if (salesReports && typeof salesReports.aov === "function") {
        out.data = await salesReports.aov({
          from: window.from,
          to:   window.to,
        });
      }
    } else if (kind === "refund_rate") {
      if (salesReports && typeof salesReports.refundRate === "function") {
        out.data = await salesReports.refundRate({
          from: window.from,
          to:   window.to,
        });
      }
    } else if (kind === "recent_orders") {
      if (analytics && typeof analytics.recentOrders === "function") {
        out.data = await analytics.recentOrders({ limit: cfg.limit });
      }
    } else if (kind === "cart_abandonment") {
      if (cartAbandonment && typeof cartAbandonment.recentDetections === "function") {
        out.data = await cartAbandonment.recentDetections({
          limit:  cfg.limit,
          status: cfg.status,
        });
      }
    } else if (kind === "inventory_low_stock") {
      if (inventoryAlerts && typeof inventoryAlerts.list === "function") {
        out.data = await inventoryAlerts.list({
          limit: cfg.limit,
        });
      }
    }
    return out;
  }

  async function renderDashboard(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontDashboards.renderDashboard: input object required");
    }
    var slug   = _slug(input.slug);
    var window = _window(input.from, input.to);
    var locale = _locale(input.locale);

    var dashboard = await getDashboard(slug);
    if (!dashboard) {
      throw new TypeError(
        "storefrontDashboards.renderDashboard: slug " + JSON.stringify(slug) + " not found"
      );
    }
    if (dashboard.archived_at != null) {
      throw new TypeError(
        "storefrontDashboards.renderDashboard: slug " + JSON.stringify(slug) +
        " is archived — clone it to render"
      );
    }

    var rendered = [];
    for (var i = 0; i < dashboard.widgets.length; i += 1) {
      rendered.push(await _renderWidget(dashboard.widgets[i], window, locale));
    }
    return {
      slug:    dashboard.slug,
      title:   dashboard.title,
      layout:  dashboard.layout,
      locale:  locale,
      widgets: rendered,
    };
  }

  return {
    MAX_SLUG_LEN:                MAX_SLUG_LEN,
    MAX_TITLE_LEN:               MAX_TITLE_LEN,
    MAX_WIDGET_ID_LEN:           MAX_WIDGET_ID_LEN,
    MAX_WIDGETS_PER_DASHBOARD:   MAX_WIDGETS_PER_DASHBOARD,
    ALLOWED_LAYOUTS:             ALLOWED_LAYOUTS,
    ALLOWED_WIDGET_KINDS:        ALLOWED_WIDGET_KINDS,
    ALLOWED_OWNER_TYPES:         ALLOWED_OWNER_TYPES,

    defineDashboard:  defineDashboard,
    getDashboard:     getDashboard,
    listDashboards:   listDashboards,
    updateDashboard:  updateDashboard,
    archiveDashboard: archiveDashboard,
    cloneDashboard:   cloneDashboard,
    renderDashboard:  renderDashboard,
  };
}

module.exports = {
  create:                      create,
  MAX_SLUG_LEN:                MAX_SLUG_LEN,
  MAX_TITLE_LEN:               MAX_TITLE_LEN,
  MAX_WIDGET_ID_LEN:           MAX_WIDGET_ID_LEN,
  MAX_WIDGETS_PER_DASHBOARD:   MAX_WIDGETS_PER_DASHBOARD,
  ALLOWED_LAYOUTS:             ALLOWED_LAYOUTS,
  ALLOWED_WIDGET_KINDS:        ALLOWED_WIDGET_KINDS,
  ALLOWED_OWNER_TYPES:         ALLOWED_OWNER_TYPES,
};
