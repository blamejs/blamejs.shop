"use strict";
/**
 * storefrontDashboards — operator-curated dashboard layouts that
 * compose widgets at render time over the rest of the shop's data
 * primitives (sales reports, analytics, cart abandonment, inventory
 * alerts).
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0091_storefront_dashboards.sql alone — the primitive has no FKs
 * into the rest of the schema, so the test runs against a minimal
 * in-memory database with just the storefront_dashboards table. The
 * four optional data sources are wired with hand-rolled mock objects
 * so the render path exercises the dispatcher without depending on
 * the full primitive surface those sources carry.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/storefront-dashboards.js` directly so the gate exists ahead
 * of the entry-point edit.
 *
 * Coverage:
 *   - defineDashboard happy path persists every input field, layout
 *     + widgets round-trip through the JSON column, owner pair
 *     stored, archived_at null on insert.
 *   - defineDashboard refusals: bad widget kind, bad layout, missing
 *     input, duplicate widget id, empty widgets, bad widget id
 *     shape, bad owner_type, orphan owner_id (no owner_type),
 *     duplicate slug.
 *   - renderDashboard with mock sources: dispatcher routes each
 *     widget kind to the correct injected source, passes the
 *     window, and emits locale_strings. Missing sources yield
 *     `data: null` widget slots. Archived dashboard refused.
 *   - renderDashboard locale fallback: `fr-ca` walks to `fr`,
 *     unknown `de` falls back to `en`.
 *   - listDashboards owner filter: matches the (owner_type,
 *     owner_id) pair exactly; archived rows excluded; null-owner
 *     query returns global dashboards only.
 *   - updateDashboard: patches title / layout / widgets, refuses
 *     unsupported columns + archived dashboards.
 *   - archiveDashboard: stamps archived_at, idempotent-refusal on
 *     re-archive, drops the row from listDashboards.
 *   - cloneDashboard: copies layout + widgets to a new slug, clone
 *     starts unarchived even when source is archived, new_owner
 *     override + inherited-owner default both work, source_slug
 *     not-found refused, duplicate new_slug refused.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var storefrontDashboards = require("../../lib/storefront-dashboards");
var bShop                = require("../../lib/index");
var helpers              = require("../helpers");
var check                = helpers.check;
var assert               = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0091_storefront_dashboards.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

// Mock data sources — each carries the methods the dispatcher calls
// and records the calls into a per-mock `calls` array so the test
// can assert on the dispatch surface. The mock data shapes mirror
// what the real primitives return at a glance but stay small so the
// assertions are stable.
function _mockSalesReports() {
  var calls = [];
  return {
    calls: calls,
    revenueByDay: function (opts) {
      calls.push({ method: "revenueByDay", opts: opts });
      return [{ bucket_start: "2026-05-01", currency: "USD", gross_revenue_minor: 12345, net_revenue_minor: 11000, refund_total_minor: 1345, order_count: 7 }];
    },
    topProducts: function (opts) {
      calls.push({ method: "topProducts", opts: opts });
      return { rows: [{ sku: "ABC-1", units_sold: 10, gross_revenue_minor: 5000 }] };
    },
    topCustomers: function (opts) {
      calls.push({ method: "topCustomers", opts: opts });
      return { rows: [{ customer_id: "c-1", spend_minor: 99999 }] };
    },
    funnel: function (opts) {
      calls.push({ method: "funnel", opts: opts });
      return [{ status: "paid", n: 12 }, { status: "refunded", n: 1 }];
    },
    aov: function (opts) {
      calls.push({ method: "aov", opts: opts });
      return [{ day: "2026-05-01", aov_minor: 4250 }];
    },
    refundRate: function (opts) {
      calls.push({ method: "refundRate", opts: opts });
      return { total: 100, refunded: 3, rate: 0.03 };
    },
  };
}

function _mockAnalytics() {
  var calls = [];
  return {
    calls: calls,
    recentOrders: function (opts) {
      calls.push({ method: "recentOrders", opts: opts });
      return [{ id: "o-1", status: "paid", grand_total_minor: 5000, currency: "USD", created_at: 1000 }];
    },
  };
}

function _mockCartAbandonment() {
  var calls = [];
  return {
    calls: calls,
    recentDetections: function (opts) {
      calls.push({ method: "recentDetections", opts: opts });
      return { rows: [{ id: "ab-1", reminder_status: "pending", detected_at: 999 }], nextCursor: null };
    },
  };
}

function _mockInventoryAlerts() {
  var calls = [];
  return {
    calls: calls,
    list: function (opts) {
      calls.push({ method: "list", opts: opts });
      return [{ id: "ia-1", sku: "ABC-1", available_at_alert: 2, threshold: 5, fired_at: 999 }];
    },
  };
}

function _setup(sources) {
  sources = sources || {};
  var query = _makeQuery();
  var dashboards = storefrontDashboards.create({
    query:           query,
    salesReports:    sources.salesReports,
    analytics:       sources.analytics,
    cartAbandonment: sources.cartAbandonment,
    inventoryAlerts: sources.inventoryAlerts,
  });
  return { query: query, dashboards: dashboards };
}

// ---- defineDashboard happy path + refusals -----------------------------

async function _defineHappyAndRefusals() {
  var ctx = _setup();

  var d = await ctx.dashboards.defineDashboard({
    slug:   "ops-overview",
    title:  "Operations overview",
    layout: "grid_2col",
    widgets: [
      { id: "rev", kind: "revenue_chart", config: { currency: "USD" } },
      { id: "top", kind: "top_products",  config: { limit: 5 } },
    ],
    owner_type: "operator",
  });
  check("defineDashboard persists slug",          d.slug === "ops-overview");
  check("defineDashboard persists title",         d.title === "Operations overview");
  check("defineDashboard persists layout",        d.layout === "grid_2col");
  check("defineDashboard persists widgets count", d.widgets.length === 2);
  check("defineDashboard widgets round-trip id",   d.widgets[0].id === "rev");
  check("defineDashboard widgets round-trip kind", d.widgets[1].kind === "top_products");
  check("defineDashboard widgets round-trip cfg",  d.widgets[1].config.limit === 5);
  check("defineDashboard persists owner_type",    d.owner_type === "operator");
  check("defineDashboard owner_id null when omitted", d.owner_id === null);
  check("defineDashboard archived_at null",       d.archived_at === null);
  check("defineDashboard created_at numeric",     typeof d.created_at === "number" && d.created_at > 0);
  check("defineDashboard updated_at = created_at", d.updated_at === d.created_at);

  // Tenant-scoped dashboard with owner_id UUID.
  var tenantId = _validUUID();
  var d2 = await ctx.dashboards.defineDashboard({
    slug:   "tenant-default",
    title:  "Tenant overview",
    layout: "single_column",
    widgets: [{ id: "ro", kind: "recent_orders" }],
    owner_type: "tenant",
    owner_id:   tenantId,
  });
  check("defineDashboard tenant owner_type", d2.owner_type === "tenant");
  check("defineDashboard tenant owner_id",   d2.owner_id === tenantId);

  // Refusals — missing input.
  await assert.rejects(ctx.dashboards.defineDashboard(),                     /input object required/);
  await assert.rejects(ctx.dashboards.defineDashboard("not-an-object"),      /input object required/);

  // Bad slug shape.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "-bad", title: "x", layout: "grid_2col",
    widgets: [{ id: "w1", kind: "revenue_chart" }],
  }), /slug/);

  // Bad layout.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "bad-layout", title: "x", layout: "kitchen-sink",
    widgets: [{ id: "w1", kind: "revenue_chart" }],
  }), /layout/);

  // Bad widget kind.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "bad-kind", title: "x", layout: "grid_2col",
    widgets: [{ id: "w1", kind: "magic_widget" }],
  }), /widget kind/);

  // Bad widget id shape.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "bad-wid", title: "x", layout: "grid_2col",
    widgets: [{ id: "-bad id", kind: "revenue_chart" }],
  }), /widget id/);

  // Empty widgets.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "no-widgets", title: "x", layout: "grid_2col", widgets: [],
  }), /widgets/);

  // Missing widgets field.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "no-widgets-2", title: "x", layout: "grid_2col",
  }), /widgets/);

  // Duplicate widget ids inside one dashboard.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "dup-wid", title: "x", layout: "grid_2col",
    widgets: [
      { id: "same", kind: "revenue_chart" },
      { id: "same", kind: "top_products"  },
    ],
  }), /duplicate widget id/);

  // Bad owner_type.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "bad-owner", title: "x", layout: "grid_2col",
    widgets: [{ id: "w1", kind: "revenue_chart" }],
    owner_type: "root",
  }), /owner_type/);

  // Orphan owner_id (no owner_type).
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "orphan-owner", title: "x", layout: "grid_2col",
    widgets: [{ id: "w1", kind: "revenue_chart" }],
    owner_id: _validUUID(),
  }), /owner_id requires owner_type/);

  // Bad title (empty).
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "bad-title", title: "", layout: "grid_2col",
    widgets: [{ id: "w1", kind: "revenue_chart" }],
  }), /title/);

  // Control byte in title.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "ctrl-title", title: "bad\x00byte", layout: "grid_2col",
    widgets: [{ id: "w1", kind: "revenue_chart" }],
  }), /title/);

  // Duplicate slug.
  await assert.rejects(ctx.dashboards.defineDashboard({
    slug: "ops-overview", title: "Different", layout: "single_column",
    widgets: [{ id: "w1", kind: "revenue_chart" }],
  }), /already exists/);
}

// ---- renderDashboard: dispatcher + locale -------------------------------

async function _renderDispatch() {
  var sources = {
    salesReports:    _mockSalesReports(),
    analytics:       _mockAnalytics(),
    cartAbandonment: _mockCartAbandonment(),
    inventoryAlerts: _mockInventoryAlerts(),
  };
  var ctx = _setup(sources);

  await ctx.dashboards.defineDashboard({
    slug:   "full",
    title:  "Full",
    layout: "freeform",
    widgets: [
      { id: "rev",   kind: "revenue_chart",       config: { currency: "USD" } },
      { id: "tp",    kind: "top_products",        config: { limit: 3 } },
      { id: "tc",    kind: "top_customers",       config: { limit: 3 } },
      { id: "fun",   kind: "order_status_funnel"                              },
      { id: "aov",   kind: "aov_trend"                                        },
      { id: "ref",   kind: "refund_rate"                                      },
      { id: "ro",    kind: "recent_orders",       config: { limit: 4 } },
      { id: "ab",    kind: "cart_abandonment",    config: { limit: 5 } },
      { id: "ls",    kind: "inventory_low_stock", config: { limit: 6 } },
    ],
  });

  var rendered = await ctx.dashboards.renderDashboard({
    slug:   "full",
    from:   1000,
    to:     2000,
    locale: "en",
  });
  check("renderDashboard returns slug",      rendered.slug === "full");
  check("renderDashboard returns layout",    rendered.layout === "freeform");
  check("renderDashboard returns locale",    rendered.locale === "en");
  check("renderDashboard widget count",      rendered.widgets.length === 9);

  // Each widget dispatched to the correct source method.
  var srMethods = sources.salesReports.calls.map(function (c) { return c.method; });
  check("dispatch revenueByDay",     srMethods.indexOf("revenueByDay")   !== -1);
  check("dispatch topProducts",      srMethods.indexOf("topProducts")    !== -1);
  check("dispatch topCustomers",     srMethods.indexOf("topCustomers")   !== -1);
  check("dispatch funnel",           srMethods.indexOf("funnel")         !== -1);
  check("dispatch aov",              srMethods.indexOf("aov")            !== -1);
  check("dispatch refundRate",       srMethods.indexOf("refundRate")     !== -1);
  check("dispatch recentOrders",     sources.analytics.calls[0].method === "recentOrders");
  check("dispatch recentDetections", sources.cartAbandonment.calls[0].method === "recentDetections");
  check("dispatch list",             sources.inventoryAlerts.calls[0].method === "list");

  // Window propagated through to the data source.
  var revCall = sources.salesReports.calls.filter(function (c) { return c.method === "revenueByDay"; })[0];
  check("dispatch passes from", revCall.opts.from === 1000);
  check("dispatch passes to",   revCall.opts.to   === 2000);
  check("dispatch passes currency", revCall.opts.currency === "USD");

  // Each widget carries its rendered data + locale strings.
  var revWidget = rendered.widgets.filter(function (w) { return w.id === "rev"; })[0];
  check("revenue widget has data",          revWidget.data && Array.isArray(revWidget.data));
  check("revenue widget locale_strings.en", revWidget.locale_strings.title === "Revenue");

  // Locale fallback: `fr-ca` walks to `fr`.
  var renderedFrCa = await ctx.dashboards.renderDashboard({
    slug:   "full",
    from:   1000,
    to:     2000,
    locale: "fr-ca",
  });
  var revFr = renderedFrCa.widgets.filter(function (w) { return w.id === "rev"; })[0];
  check("locale fr-ca falls back to fr", revFr.locale_strings.title === "Revenu");

  // Unknown locale `de` falls back to `en`.
  var renderedDe = await ctx.dashboards.renderDashboard({
    slug:   "full",
    from:   1000,
    to:     2000,
    locale: "de",
  });
  var revDe = renderedDe.widgets.filter(function (w) { return w.id === "rev"; })[0];
  check("locale de falls back to en", revDe.locale_strings.title === "Revenue");

  // Spanish hits its own bucket.
  var renderedEs = await ctx.dashboards.renderDashboard({
    slug:   "full",
    from:   1000,
    to:     2000,
    locale: "es",
  });
  var revEs = renderedEs.widgets.filter(function (w) { return w.id === "rev"; })[0];
  check("locale es renders es strings", revEs.locale_strings.title === "Ingresos");

  // Bad window refused.
  await assert.rejects(ctx.dashboards.renderDashboard({
    slug: "full", from: 2000, to: 1000,
  }), /to/);
  await assert.rejects(ctx.dashboards.renderDashboard({
    slug: "full", from: -1, to: 2000,
  }), /from/);
  await assert.rejects(ctx.dashboards.renderDashboard(), /input object required/);
  await assert.rejects(ctx.dashboards.renderDashboard({
    slug: "ghost", from: 1000, to: 2000,
  }), /not found/);
}

// ---- renderDashboard: skip injected sources gracefully -----------------

async function _renderMissingSources() {
  // No data sources injected — every widget should render with
  // `data: null` so the dashboard still emits a slot for each.
  var ctx = _setup();
  await ctx.dashboards.defineDashboard({
    slug:   "naked",
    title:  "Naked",
    layout: "grid_2col",
    widgets: [
      { id: "rev", kind: "revenue_chart" },
      { id: "ro",  kind: "recent_orders" },
      { id: "ls",  kind: "inventory_low_stock" },
    ],
  });
  var r = await ctx.dashboards.renderDashboard({
    slug: "naked", from: 1000, to: 2000,
  });
  check("missing source: widget count",       r.widgets.length === 3);
  check("missing source: data is null (rev)", r.widgets[0].data === null);
  check("missing source: data is null (ro)",  r.widgets[1].data === null);
  check("missing source: data is null (ls)",  r.widgets[2].data === null);
  check("missing source: locale_strings still emitted",
    r.widgets[0].locale_strings && r.widgets[0].locale_strings.title === "Revenue");
}

// ---- listDashboards: owner filter --------------------------------------

async function _listOwnerFilter() {
  var ctx = _setup();

  var tenantA = _validUUID();
  var tenantB = _validUUID();

  // Global dashboard (no owner).
  await ctx.dashboards.defineDashboard({
    slug: "global-default", title: "Global default", layout: "grid_2col",
    widgets: [{ id: "rev", kind: "revenue_chart" }],
  });
  // Operator dashboard (owner_type only).
  await ctx.dashboards.defineDashboard({
    slug: "ops-overview", title: "Ops", layout: "grid_2col",
    widgets: [{ id: "rev", kind: "revenue_chart" }],
    owner_type: "operator",
  });
  // Tenant A dashboard.
  await ctx.dashboards.defineDashboard({
    slug: "tenant-a-1", title: "Tenant A 1", layout: "grid_2col",
    widgets: [{ id: "rev", kind: "revenue_chart" }],
    owner_type: "tenant", owner_id: tenantA,
  });
  // Tenant A second dashboard.
  await ctx.dashboards.defineDashboard({
    slug: "tenant-a-2", title: "Tenant A 2", layout: "grid_2col",
    widgets: [{ id: "rev", kind: "revenue_chart" }],
    owner_type: "tenant", owner_id: tenantA,
  });
  // Tenant B dashboard.
  await ctx.dashboards.defineDashboard({
    slug: "tenant-b-1", title: "Tenant B 1", layout: "grid_2col",
    widgets: [{ id: "rev", kind: "revenue_chart" }],
    owner_type: "tenant", owner_id: tenantB,
  });

  // No filter — every active dashboard.
  var all = await ctx.dashboards.listDashboards();
  check("listDashboards no filter returns all 5", all.length === 5);

  // Filter to operator-only (owner_id null inside the operator
  // bucket — the catalog).
  var operatorOnly = await ctx.dashboards.listDashboards({ owner_type: "operator" });
  check("listDashboards operator filter returns 1", operatorOnly.length === 1);
  check("listDashboards operator filter slug",      operatorOnly[0].slug === "ops-overview");

  // Filter to tenant A.
  var tenantADash = await ctx.dashboards.listDashboards({
    owner_type: "tenant", owner_id: tenantA,
  });
  check("listDashboards tenant-A returns 2", tenantADash.length === 2);
  check("listDashboards tenant-A includes a-1",
    tenantADash.some(function (d) { return d.slug === "tenant-a-1"; }));
  check("listDashboards tenant-A includes a-2",
    tenantADash.some(function (d) { return d.slug === "tenant-a-2"; }));
  check("listDashboards tenant-A excludes b-1",
    !tenantADash.some(function (d) { return d.slug === "tenant-b-1"; }));

  // Filter to tenant B.
  var tenantBDash = await ctx.dashboards.listDashboards({
    owner_type: "tenant", owner_id: tenantB,
  });
  check("listDashboards tenant-B returns 1", tenantBDash.length === 1);
  check("listDashboards tenant-B slug",      tenantBDash[0].slug === "tenant-b-1");

  // Filter for global (both owner fields explicitly null).
  var globals = await ctx.dashboards.listDashboards({
    owner_type: null, owner_id: null,
  });
  check("listDashboards global filter returns 1", globals.length === 1);
  check("listDashboards global filter slug",      globals[0].slug === "global-default");

  // Archived dashboards drop out of listDashboards.
  await ctx.dashboards.archiveDashboard("ops-overview");
  var afterArchive = await ctx.dashboards.listDashboards({ owner_type: "operator" });
  check("listDashboards excludes archived", afterArchive.length === 0);
}

// ---- updateDashboard ---------------------------------------------------

async function _updatePatch() {
  var ctx = _setup();
  await ctx.dashboards.defineDashboard({
    slug:   "u",
    title:  "Original",
    layout: "grid_2col",
    widgets: [{ id: "rev", kind: "revenue_chart" }],
  });

  // Patch title.
  var u1 = await ctx.dashboards.updateDashboard("u", { title: "Updated" });
  check("update persists title",  u1.title === "Updated");
  check("update preserves slug",  u1.slug === "u");
  check("update preserves layout", u1.layout === "grid_2col");

  // Patch layout.
  var u2 = await ctx.dashboards.updateDashboard("u", { layout: "single_column" });
  check("update persists layout", u2.layout === "single_column");

  // Patch widgets — full replacement.
  var u3 = await ctx.dashboards.updateDashboard("u", {
    widgets: [
      { id: "rev",  kind: "revenue_chart" },
      { id: "tp",   kind: "top_products" },
    ],
  });
  check("update persists widgets",  u3.widgets.length === 2);
  check("update widgets ids",       u3.widgets[1].id === "tp");

  // Unsupported column refused.
  await assert.rejects(ctx.dashboards.updateDashboard("u", { archived_at: 1 }),
    /unsupported column/);
  await assert.rejects(ctx.dashboards.updateDashboard("u", { slug: "new" }),
    /unsupported column/);
  await assert.rejects(ctx.dashboards.updateDashboard("u", { owner_type: "tenant" }),
    /unsupported column/);

  // Empty patch refused.
  await assert.rejects(ctx.dashboards.updateDashboard("u", {}),
    /at least one column/);

  // Unknown slug refused.
  await assert.rejects(ctx.dashboards.updateDashboard("ghost", { title: "x" }),
    /not found/);

  // Bad widget array on update refused.
  await assert.rejects(ctx.dashboards.updateDashboard("u", {
    widgets: [{ id: "x", kind: "no-such-kind" }],
  }), /widget kind/);

  // Update on an archived dashboard refused.
  await ctx.dashboards.archiveDashboard("u");
  await assert.rejects(ctx.dashboards.updateDashboard("u", { title: "y" }),
    /archived/);
}

// ---- archiveDashboard --------------------------------------------------

async function _archive() {
  var ctx = _setup();
  await ctx.dashboards.defineDashboard({
    slug:   "a",
    title:  "A",
    layout: "grid_2col",
    widgets: [{ id: "rev", kind: "revenue_chart" }],
  });

  var archived = await ctx.dashboards.archiveDashboard("a");
  check("archive stamps archived_at",
    typeof archived.archived_at === "number" && archived.archived_at > 0);

  // Re-archive refused.
  await assert.rejects(ctx.dashboards.archiveDashboard("a"), /already archived/);

  // Unknown slug refused.
  await assert.rejects(ctx.dashboards.archiveDashboard("ghost"), /not found/);

  // Archived dashboard refuses to render.
  await assert.rejects(ctx.dashboards.renderDashboard({
    slug: "a", from: 1000, to: 2000,
  }), /archived/);

  // listDashboards excludes archived.
  var list = await ctx.dashboards.listDashboards();
  check("archive removes from listDashboards", list.length === 0);
}

// ---- cloneDashboard ----------------------------------------------------

async function _clone() {
  var ctx = _setup();

  var tenantA = _validUUID();
  var tenantB = _validUUID();

  await ctx.dashboards.defineDashboard({
    slug:   "source",
    title:  "Source",
    layout: "grid_3col",
    widgets: [
      { id: "rev", kind: "revenue_chart", config: { currency: "USD" } },
      { id: "tp",  kind: "top_products",  config: { limit: 5 } },
    ],
    owner_type: "tenant", owner_id: tenantA,
  });

  // Basic clone — new slug, inherits owner + title.
  var c1 = await ctx.dashboards.cloneDashboard({
    source_slug: "source",
    new_slug:    "source-copy",
  });
  check("clone persists new slug",       c1.slug === "source-copy");
  check("clone inherits title",          c1.title === "Source");
  check("clone inherits layout",         c1.layout === "grid_3col");
  check("clone inherits widgets count",  c1.widgets.length === 2);
  check("clone inherits widget ids",     c1.widgets[0].id === "rev");
  check("clone inherits widget config",  c1.widgets[1].config.limit === 5);
  check("clone inherits owner_type",     c1.owner_type === "tenant");
  check("clone inherits owner_id",       c1.owner_id === tenantA);
  check("clone starts un-archived",      c1.archived_at === null);

  // Clone with new_title override.
  var c2 = await ctx.dashboards.cloneDashboard({
    source_slug: "source",
    new_slug:    "source-renamed",
    new_title:   "Renamed",
  });
  check("clone with new_title", c2.title === "Renamed");

  // Clone with new_owner override.
  var c3 = await ctx.dashboards.cloneDashboard({
    source_slug: "source",
    new_slug:    "source-reowned",
    new_owner:   { owner_type: "tenant", owner_id: tenantB },
  });
  check("clone with new_owner.owner_type", c3.owner_type === "tenant");
  check("clone with new_owner.owner_id",   c3.owner_id === tenantB);

  // Clone an archived dashboard — clone starts un-archived even
  // though source is archived.
  await ctx.dashboards.archiveDashboard("source");
  var c4 = await ctx.dashboards.cloneDashboard({
    source_slug: "source",
    new_slug:    "source-revived",
  });
  check("clone of archived source is un-archived", c4.archived_at === null);
  check("clone of archived source preserves widgets", c4.widgets.length === 2);

  // Source not found refused.
  await assert.rejects(ctx.dashboards.cloneDashboard({
    source_slug: "ghost", new_slug: "x",
  }), /source_slug/);

  // Duplicate new_slug refused (source-copy already exists).
  await assert.rejects(ctx.dashboards.cloneDashboard({
    source_slug: "source", new_slug: "source-copy",
  }), /already exists/);

  // Same slug refused.
  await assert.rejects(ctx.dashboards.cloneDashboard({
    source_slug: "source", new_slug: "source",
  }), /must differ from source_slug/);

  // Bad new_owner shape refused.
  await assert.rejects(ctx.dashboards.cloneDashboard({
    source_slug: "source", new_slug: "bad-clone",
    new_owner: "not-an-object",
  }), /new_owner/);

  // Missing input refused.
  await assert.rejects(ctx.dashboards.cloneDashboard(), /input object required/);
}

async function run() {
  await _defineHappyAndRefusals();
  await _renderDispatch();
  await _renderMissingSources();
  await _listOwnerFilter();
  await _updatePatch();
  await _archive();
  await _clone();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/storefront-dashboards.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("storefront-dashboards: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
