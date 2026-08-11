"use strict";
/**
 * catalogDrafts — staging workflow for catalog changes. Operator
 * stages N changes (new products, price updates, archives, tag
 * flips); they preview in a draft view; they publish atomically;
 * within the 7-day window they can roll back.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0112_catalog_drafts.sql` PLUS the catalog migration
 * `0001_catalog.sql` (the publish path writes through the catalog
 * primitive's products / variants / prices / inventory surfaces).
 *
 * Coverage:
 *   - openDraft returns the row with status `open`; duplicate slug
 *     refuses
 *   - stageChange appends a typed change with monotonic
 *     sequence_order; payload shape is validated per kind
 *   - listChanges paginates by sequence; removeChange drops a single
 *     change
 *   - previewMerged returns the resulting catalog state without
 *     writing; flips status to `preview`
 *   - publishDraft pre-flights every change; pre-flight failure
 *     refuses the entire publish; on success the catalog state
 *     matches the simulation
 *   - publishDraft dry_run runs the pre-flight without writing
 *   - cancelDraft on a non-terminal draft transitions to `cancelled`
 *     and refuses subsequent stageChange
 *   - rollbackDraft within the 7-day window restores the pre-publish
 *     state; outside the window refuses with ROLLBACK_WINDOW_ELAPSED
 *   - listDrafts filters by status / owner; historyForSku surfaces
 *     every draft that touched a sku
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var catalogDrafts = require("../../lib/catalog-drafts");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_DRAFTS  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0112_catalog_drafts.sql");
var MIG_CATALOG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQueryAndCatalog() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  // Catalog migration first (the drafts test exercises both layers).
  _splitSchema(nodeFs.readFileSync(MIG_CATALOG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  _splitSchema(nodeFs.readFileSync(MIG_DRAFTS,  "utf8")).forEach(function (s) { db.prepare(s).run(); });
  // Add a product_tags table for tag verb coverage. The drafts
  // primitive uses the catalog handle's tags surface; the in-memory
  // catalog mock backs the surface with this side table so the test
  // doesn't depend on the bulk-ops migration being part of the
  // drafts test scope.
  db.prepare(
    "CREATE TABLE IF NOT EXISTS product_tags (" +
    "  product_id TEXT NOT NULL," +
    "  tag        TEXT NOT NULL," +
    "  added_at   INTEGER NOT NULL," +
    "  PRIMARY KEY (product_id, tag)" +
    ")"
  ).run();

  function query(sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return Promise.resolve({
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      });
    }
    var rows = stmt.all.apply(stmt, params || []);
    return Promise.resolve({ rows: rows, rowCount: rows.length });
  }

  // Minimal in-memory catalog handle. Backs each catalog subsurface
  // with the canonical catalog tables loaded above. Mirrors the
  // public surface catalogDrafts requires (products, variants,
  // prices, inventory, tags). Returns plain objects shaped to the
  // table columns so the drafts primitive's hydration matches.
  var _nextId = 0;
  function _id(prefix) { _nextId += 1; return prefix + "-" + _nextId.toString(36).padStart(8, "0"); }
  function _now() { return Date.now() + _nextId; }       // monotonic-bump to keep updated_at deterministic across tight loops

  var catalog = {
    products: {
      create: async function (input) {
        var id = _id("p");
        var ts = _now();
        await query(
          "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
          [id, input.slug, input.title, input.description || "", input.status || "draft", ts],
        );
        return { id: id, slug: input.slug, title: input.title, description: input.description || "", status: input.status || "draft", created_at: ts, updated_at: ts };
      },
      bySlug: async function (slug) {
        var r = await query("SELECT * FROM products WHERE slug = ?1 LIMIT 1", [slug]);
        return r.rows[0] || null;
      },
      get: async function (id) {
        var r = await query("SELECT * FROM products WHERE id = ?1 LIMIT 1", [id]);
        return r.rows[0] || null;
      },
      update: async function (id, patch) {
        var sets = [];
        var params = [];
        var i = 1;
        if (patch.slug != null)        { sets.push("slug = ?" + i++);        params.push(patch.slug); }
        if (patch.title != null)       { sets.push("title = ?" + i++);       params.push(patch.title); }
        if (patch.description != null) { sets.push("description = ?" + i++); params.push(patch.description); }
        if (patch.status != null)      { sets.push("status = ?" + i++);      params.push(patch.status); }
        sets.push("updated_at = ?" + i++);
        params.push(_now());
        params.push(id);
        await query("UPDATE products SET " + sets.join(", ") + " WHERE id = ?" + i, params);
        return await this.get(id);
      },
      archive: async function (id) { return await this.update(id, { status: "archived" }); },
    },
    variants: {
      create: async function (productId, input) {
        var id = _id("v");
        var ts = _now();
        await query(
          "INSERT INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
          [
            id, productId, input.sku, input.title || "",
            JSON.stringify(input.options || {}),
            input.weight_grams == null ? 0 : input.weight_grams,
            input.requires_shipping == null ? 1 : (input.requires_shipping ? 1 : 0),
            0, ts,
          ],
        );
        return await this.get(id);
      },
      get: async function (id) {
        var r = await query("SELECT * FROM variants WHERE id = ?1 LIMIT 1", [id]);
        var row = r.rows[0] || null;
        if (row) row.options = JSON.parse(row.options_json);
        return row;
      },
      bySku: async function (sku) {
        var r = await query("SELECT * FROM variants WHERE sku = ?1 LIMIT 1", [sku]);
        var row = r.rows[0] || null;
        if (row) row.options = JSON.parse(row.options_json);
        return row;
      },
      update: async function (id, patch) {
        var sets = [];
        var params = [];
        var i = 1;
        if (patch.sku != null)               { sets.push("sku = ?" + i++);               params.push(patch.sku); }
        if (patch.title != null)             { sets.push("title = ?" + i++);             params.push(patch.title); }
        if (patch.options != null)           { sets.push("options_json = ?" + i++);      params.push(JSON.stringify(patch.options)); }
        if (patch.weight_grams != null)      { sets.push("weight_grams = ?" + i++);      params.push(patch.weight_grams); }
        if (patch.requires_shipping != null) { sets.push("requires_shipping = ?" + i++); params.push(patch.requires_shipping ? 1 : 0); }
        if (patch.position != null)          { sets.push("position = ?" + i++);          params.push(patch.position); }
        sets.push("updated_at = ?" + i++);
        params.push(_now());
        params.push(id);
        await query("UPDATE variants SET " + sets.join(", ") + " WHERE id = ?" + i, params);
        return await this.get(id);
      },
      delete: async function (id) {
        var r = await query("DELETE FROM variants WHERE id = ?1", [id]);
        return Number(r.rowCount || 0) > 0;
      },
    },
    prices: {
      set: async function (variantId, input) {
        var ts = _now();
        await query(
          "UPDATE prices SET effective_until = ?1 WHERE variant_id = ?2 AND currency = ?3 AND effective_until IS NULL",
          [ts, variantId, input.currency],
        );
        var id = _id("pr");
        await query(
          "INSERT INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?5)",
          [id, variantId, input.currency, input.amount_minor, ts],
        );
        return { id: id, variant_id: variantId, currency: input.currency, amount_minor: input.amount_minor, effective_from: ts, effective_until: null, created_at: ts };
      },
      current: async function (variantId, currency) {
        var r = await query(
          "SELECT * FROM prices WHERE variant_id = ?1 AND currency = ?2 AND effective_until IS NULL LIMIT 1",
          [variantId, currency],
        );
        return r.rows[0] || null;
      },
    },
    inventory: {
      create: async function (sku, input) {
        var ts = _now();
        await query(
          "INSERT INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES (?1, ?2, 0, ?3)",
          [sku, input.stock_on_hand == null ? 0 : input.stock_on_hand, ts],
        );
        return { sku: sku, stock_on_hand: input.stock_on_hand == null ? 0 : input.stock_on_hand, stock_held: 0, updated_at: ts };
      },
      get: async function (sku) {
        var r = await query("SELECT * FROM inventory WHERE sku = ?1 LIMIT 1", [sku]);
        return r.rows[0] || null;
      },
      restock: async function (sku, qty) {
        var ts = _now();
        await query(
          "UPDATE inventory SET stock_on_hand = stock_on_hand + ?1, updated_at = ?2 WHERE sku = ?3",
          [qty, ts, sku],
        );
        return await this.get(sku);
      },
      release: async function (sku, qty) {
        var ts = _now();
        await query(
          "UPDATE inventory SET stock_on_hand = stock_on_hand - ?1, updated_at = ?2 WHERE sku = ?3 AND stock_on_hand >= ?1",
          [qty, ts, sku],
        );
        return await this.get(sku);
      },
    },
    tags: {
      add: async function (productId, tag) {
        var ts = _now();
        await query(
          "INSERT OR IGNORE INTO product_tags (product_id, tag, added_at) VALUES (?1, ?2, ?3)",
          [productId, tag, ts],
        );
        return { product_id: productId, tag: tag, added_at: ts };
      },
      remove: async function (productId, tag) {
        var r = await query(
          "DELETE FROM product_tags WHERE product_id = ?1 AND tag = ?2",
          [productId, tag],
        );
        return { removed: Number(r.rowCount || 0) > 0, product_id: productId, tag: tag };
      },
      listForProduct: async function (productId) {
        var r = await query(
          "SELECT tag FROM product_tags WHERE product_id = ?1 ORDER BY added_at ASC, tag ASC",
          [productId],
        );
        return r.rows.map(function (row) { return row.tag; });
      },
    },
  };

  return { query: query, catalog: catalog };
}

// ---- openDraft ----------------------------------------------------------

async function _openDraftHappy() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  var d = await cd.openDraft({
    slug: "spring-2026", title: "Spring 2026 refresh",
    description: "Adds blue tee SKUs + bumps prices on legacy SKUs.",
    owner_id: "operator-rob",
  });
  check("openDraft slug",                d.slug === "spring-2026");
  check("openDraft title",               d.title === "Spring 2026 refresh");
  check("openDraft description",         d.description === "Adds blue tee SKUs + bumps prices on legacy SKUs.");
  check("openDraft status open",         d.status === "open");
  check("openDraft scheduled null",      d.scheduled_publish_at === null);
  check("openDraft published_at null",   d.published_at === null);
  check("openDraft cancelled_at null",   d.cancelled_at === null);
  check("openDraft rolled_back_at null", d.rolled_back_at === null);
  check("openDraft owner_id",            d.owner_id === "operator-rob");
  check("openDraft created_at integer",  Number.isInteger(d.created_at));

  await assert.rejects(cd.openDraft({ slug: "spring-2026", title: "dup" }), /already exists/);

  // Validation refusals.
  await assert.rejects(cd.openDraft(), /input object required/);
  await assert.rejects(cd.openDraft({ slug: "has space", title: "x" }), /slug/);
  await assert.rejects(cd.openDraft({ slug: "ok", title: "" }), /title/);
  await assert.rejects(cd.openDraft({ slug: "ok", title: "x", description: "y\x00z" }), /null byte/);

  var got = await cd.getDraft("spring-2026");
  check("getDraft round-trips", got.slug === "spring-2026" && got.status === "open");
}

// ---- stageChange + listChanges + removeChange --------------------------

async function _stageChangeHappy() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  await cd.openDraft({ slug: "draft-a", title: "Draft A" });

  var c1 = await cd.stageChange({
    draft_slug: "draft-a", kind: "create_product",
    payload: { slug: "tee-blue", title: "Blue tee", status: "active" },
  });
  check("stageChange c1 kind",  c1.kind === "create_product");
  check("stageChange c1 seq 1", c1.sequence_order === 1);
  check("stageChange c1 payload.slug", c1.payload.slug === "tee-blue");

  var c2 = await cd.stageChange({
    draft_slug: "draft-a", kind: "create_variant",
    payload: { product_slug: "tee-blue", sku: "TEE-BLU-M", title: "Medium" },
  });
  check("stageChange c2 seq 2", c2.sequence_order === 2);

  var c3 = await cd.stageChange({
    draft_slug: "draft-a", kind: "set_price",
    payload: { sku: "TEE-BLU-M", currency: "USD", amount_minor: 2500 },
  });
  check("stageChange c3 seq 3", c3.sequence_order === 3);

  // Refusal: bad kind.
  await assert.rejects(cd.stageChange({
    draft_slug: "draft-a", kind: "nope", payload: {},
  }), /kind/);
  // Refusal: missing required field.
  await assert.rejects(cd.stageChange({
    draft_slug: "draft-a", kind: "set_price",
    payload: { sku: "TEE-BLU-M", currency: "usd", amount_minor: 100 },
  }), /currency/);
  // Refusal: invalid sku.
  await assert.rejects(cd.stageChange({
    draft_slug: "draft-a", kind: "set_price",
    payload: { sku: "bad sku", currency: "USD", amount_minor: 100 },
  }), /sku/);
  // Refusal: amount_minor negative.
  await assert.rejects(cd.stageChange({
    draft_slug: "draft-a", kind: "set_price",
    payload: { sku: "TEE-BLU-M", currency: "USD", amount_minor: -1 },
  }), /amount_minor/);
  // Refusal: bad tag shape.
  await assert.rejects(cd.stageChange({
    draft_slug: "draft-a", kind: "add_tag",
    payload: { product_slug: "tee-blue", tag: "UPPER" },
  }), /tag/);

  // listChanges returns them in sequence order.
  var list = await cd.listChanges("draft-a");
  check("listChanges count",       list.rows.length === 3);
  check("listChanges seq ordering", list.rows[0].sequence_order === 1 && list.rows[1].sequence_order === 2 && list.rows[2].sequence_order === 3);
  check("listChanges no next",     list.next_cursor === null);

  // Cursor pagination.
  var p1 = await cd.listChanges("draft-a", { limit: 2 });
  check("listChanges page 1 count", p1.rows.length === 2);
  check("listChanges page 1 cursor", p1.next_cursor === "2");
  var p2 = await cd.listChanges("draft-a", { limit: 2, cursor: p1.next_cursor });
  check("listChanges page 2 count", p2.rows.length === 1 && p2.rows[0].sequence_order === 3);
  check("listChanges page 2 cursor null", p2.next_cursor === null);

  // removeChange drops a single staged change.
  var removed = await cd.removeChange({ draft_slug: "draft-a", change_id: c2.id });
  check("removeChange returns removed:true", removed.removed === true);
  var after = await cd.listChanges("draft-a");
  check("removeChange dropped c2", after.rows.length === 2);
  // The remaining changes preserve their original sequence_order.
  check("removeChange preserves seq", after.rows[0].sequence_order === 1 && after.rows[1].sequence_order === 3);

  // removeChange unknown id refuses.
  await assert.rejects(cd.removeChange({ draft_slug: "draft-a", change_id: "no-such" }), /not found/);
}

// ---- previewMerged ------------------------------------------------------

async function _previewMerged() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  // Seed a pre-existing product so update_product / archive_product /
  // set_price paths have something to address.
  var seed = await ctx.catalog.products.create({ slug: "legacy-mug", title: "Legacy mug", status: "active" });
  var seedV = await ctx.catalog.variants.create(seed.id, { sku: "MUG-LEGACY", title: "Default" });
  await ctx.catalog.prices.set(seedV.id, { currency: "USD", amount_minor: 1000 });

  await cd.openDraft({ slug: "spring", title: "Spring" });
  await cd.stageChange({
    draft_slug: "spring", kind: "create_product",
    payload: { slug: "tee-blue", title: "Blue tee", status: "active" },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "create_variant",
    payload: { product_slug: "tee-blue", sku: "TEE-BLU-M" },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "set_price",
    payload: { sku: "TEE-BLU-M", currency: "USD", amount_minor: 2500 },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "set_price",
    payload: { sku: "MUG-LEGACY", currency: "USD", amount_minor: 1200 },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "add_tag",
    payload: { product_slug: "tee-blue", tag: "new" },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "archive_product",
    payload: { slug: "legacy-mug" },
  });

  var preview = await cd.previewMerged({ draft_slug: "spring" });
  check("preview change_count",         preview.change_count === 6);
  check("preview problems empty",       preview.problems.length === 0);
  check("preview merged.products tee-blue exists", preview.merged.products["tee-blue"] != null);
  check("preview merged.products tee-blue title",  preview.merged.products["tee-blue"].title === "Blue tee");
  check("preview merged.variants TEE-BLU-M exists", preview.merged.variants["TEE-BLU-M"] != null);
  check("preview merged.prices TEE-BLU-M USD 2500", preview.merged.prices["TEE-BLU-M"].USD.amount_minor === 2500);
  check("preview merged.prices MUG-LEGACY updated", preview.merged.prices["MUG-LEGACY"].USD.amount_minor === 1200);
  check("preview merged.tags tee-blue includes new", preview.merged.tags["tee-blue"].indexOf("new") !== -1);
  check("preview merged.products legacy-mug archived", preview.merged.products["legacy-mug"].status === "archived");

  // previewMerged didn't write anything to the live catalog.
  var liveLegacy = await ctx.catalog.products.bySlug("legacy-mug");
  check("preview didn't mutate live legacy-mug status", liveLegacy.status === "active");
  var liveTee = await ctx.catalog.products.bySlug("tee-blue");
  check("preview didn't create live tee-blue",          liveTee === null);

  // Draft status flipped to preview.
  var d = await cd.getDraft("spring");
  check("preview flipped status",       d.status === "preview");
}

// ---- publishDraft -------------------------------------------------------

async function _publishDraftAtomic() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  // Seed: a legacy product whose price we'll update.
  var seed  = await ctx.catalog.products.create({ slug: "legacy-mug", title: "Legacy mug", status: "active" });
  var seedV = await ctx.catalog.variants.create(seed.id, { sku: "MUG-LEGACY" });
  await ctx.catalog.prices.set(seedV.id, { currency: "USD", amount_minor: 1000 });
  await ctx.catalog.inventory.create("MUG-LEGACY", { stock_on_hand: 50 });

  await cd.openDraft({ slug: "spring", title: "Spring" });
  await cd.stageChange({
    draft_slug: "spring", kind: "create_product",
    payload: { slug: "tee-blue", title: "Blue tee", status: "active" },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "create_variant",
    payload: { product_slug: "tee-blue", sku: "TEE-BLU-M" },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "set_price",
    payload: { sku: "TEE-BLU-M", currency: "USD", amount_minor: 2500 },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "set_price",
    payload: { sku: "MUG-LEGACY", currency: "USD", amount_minor: 1200 },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "set_inventory",
    payload: { sku: "MUG-LEGACY", stock_on_hand: 75 },
  });
  await cd.stageChange({
    draft_slug: "spring", kind: "add_tag",
    payload: { product_slug: "tee-blue", tag: "new" },
  });

  // dry_run.
  var dry = await cd.publishDraft({ draft_slug: "spring", dry_run: true });
  check("publishDraft dry_run flag",   dry.dry_run === true);
  check("publishDraft dry_run count",  dry.plan_count === 6);
  // dry_run didn't write.
  check("publishDraft dry_run no write", (await ctx.catalog.products.bySlug("tee-blue")) === null);
  var dStill = await cd.getDraft("spring");
  check("publishDraft dry_run keeps status non-published", dStill.status !== "published");

  // Real publish.
  var res = await cd.publishDraft({ draft_slug: "spring" });
  check("publishDraft status published", res.status === "published");
  check("publishDraft applied count",    res.applied === 6);
  check("publishDraft published_at integer", Number.isInteger(res.published_at));

  // Verify the live catalog matches the staged plan.
  var teeBlue = await ctx.catalog.products.bySlug("tee-blue");
  check("publish wrote tee-blue product", teeBlue != null && teeBlue.title === "Blue tee");
  var teeV = await ctx.catalog.variants.bySku("TEE-BLU-M");
  check("publish wrote TEE-BLU-M variant", teeV != null && teeV.product_id === teeBlue.id);
  var teePrice = await ctx.catalog.prices.current(teeV.id, "USD");
  check("publish wrote TEE-BLU-M price",   teePrice != null && teePrice.amount_minor === 2500);
  var legacyPrice = await ctx.catalog.prices.current(seedV.id, "USD");
  check("publish updated MUG-LEGACY price", legacyPrice.amount_minor === 1200);
  var legacyInv = await ctx.catalog.inventory.get("MUG-LEGACY");
  check("publish set MUG-LEGACY inventory", Number(legacyInv.stock_on_hand) === 75);
  var teeTags = await ctx.catalog.tags.listForProduct(teeBlue.id);
  check("publish added tee-blue tag",       teeTags.indexOf("new") !== -1);

  // Re-publishing a terminal draft refuses.
  await assert.rejects(cd.publishDraft({ draft_slug: "spring" }), /terminal/);

  // Re-staging on a terminal draft refuses.
  await assert.rejects(cd.stageChange({
    draft_slug: "spring", kind: "add_tag",
    payload: { product_slug: "tee-blue", tag: "another" },
  }), /terminal/);
}

// ---- publishDraft pre-flight refusal -----------------------------------

async function _publishPreflightRefusal() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  // No seed: the draft references a non-existent product slug for an
  // update — pre-flight must catch it.
  await cd.openDraft({ slug: "bad", title: "Bad" });
  await cd.stageChange({
    draft_slug: "bad", kind: "update_product",
    payload: { slug: "nope", patch: { title: "won't land" } },
  });
  await cd.stageChange({
    draft_slug: "bad", kind: "create_product",
    payload: { slug: "ok", title: "OK" },
  });

  var threw = null;
  try { await cd.publishDraft({ draft_slug: "bad" }); }
  catch (e) { threw = e; }
  check("preflight refusal threw",          threw != null);
  check("preflight refusal code",           threw && threw.code === "PREFLIGHT_FAILED");
  check("preflight refusal problems shape", threw && Array.isArray(threw.problems) && threw.problems.length >= 1);
  check("preflight refusal reason",         threw.problems[0].reason === "product_not_found");

  // The "ok" create that would have succeeded didn't land either —
  // pre-flight refused the whole batch.
  var ok = await ctx.catalog.products.bySlug("ok");
  check("preflight atomicity: no partial writes", ok === null);

  // The draft is still mutable so the operator can fix and re-publish.
  var d = await cd.getDraft("bad");
  check("preflight failure keeps draft non-terminal", d.status !== "published" && d.status !== "cancelled" && d.status !== "rolled_back");

  // Empty draft refuses.
  await cd.openDraft({ slug: "empty", title: "Empty" });
  await assert.rejects(cd.publishDraft({ draft_slug: "empty" }), /no staged changes/);
}

// ---- rollbackDraft within window ---------------------------------------

async function _rollbackWithinWindow() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  // Seed.
  var seed  = await ctx.catalog.products.create({ slug: "legacy-mug", title: "Legacy mug", status: "active" });
  var seedV = await ctx.catalog.variants.create(seed.id, { sku: "MUG-LEGACY" });
  await ctx.catalog.prices.set(seedV.id, { currency: "USD", amount_minor: 1000 });

  await cd.openDraft({ slug: "draft-x", title: "Draft X" });
  await cd.stageChange({
    draft_slug: "draft-x", kind: "create_product",
    payload: { slug: "tee-new", title: "Brand new tee", status: "active" },
  });
  await cd.stageChange({
    draft_slug: "draft-x", kind: "set_price",
    payload: { sku: "MUG-LEGACY", currency: "USD", amount_minor: 1500 },
  });
  await cd.publishDraft({ draft_slug: "draft-x" });

  // Pre-rollback: the published changes are live.
  var teeNew = await ctx.catalog.products.bySlug("tee-new");
  check("rollback pre: tee-new created",          teeNew != null && teeNew.status === "active");
  var legacyPriceAfterPublish = await ctx.catalog.prices.current(seedV.id, "USD");
  check("rollback pre: legacy price bumped",      legacyPriceAfterPublish.amount_minor === 1500);

  // Roll back inside the 7-day window.
  var rolled = await cd.rollbackDraft({ draft_slug: "draft-x", reason: "downstream alert" });
  check("rollback status rolled_back",     rolled.status === "rolled_back");
  check("rollback rollback_reason",        rolled.rollback_reason === "downstream alert");
  check("rollback rolled_back_at integer", Number.isInteger(rolled.rolled_back_at));

  // Post-rollback: the created product is archived; the price is
  // restored to its pre-publish value.
  var teeAfter = await ctx.catalog.products.bySlug("tee-new");
  check("rollback archived tee-new",       teeAfter != null && teeAfter.status === "archived");
  var legacyPriceAfter = await ctx.catalog.prices.current(seedV.id, "USD");
  check("rollback restored legacy price",  legacyPriceAfter.amount_minor === 1000);

  // Second rollback refuses (status is rolled_back, not published).
  await assert.rejects(cd.rollbackDraft({ draft_slug: "draft-x", reason: "again" }), /not_published|published|rolled/);

  // Rollback validation refusals.
  await assert.rejects(cd.rollbackDraft({ draft_slug: "no-such", reason: "x" }), /not found/);
  await assert.rejects(cd.rollbackDraft({ draft_slug: "draft-x" }), /reason/);
}

// ---- rollbackDraft outside window --------------------------------------

async function _rollbackOutsideWindow() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  await cd.openDraft({ slug: "draft-old", title: "Old draft" });
  await cd.stageChange({
    draft_slug: "draft-old", kind: "create_product",
    payload: { slug: "old-prod", title: "Old", status: "active" },
  });
  await cd.publishDraft({ draft_slug: "draft-old" });

  // Backdate the published_at to >7 days ago.
  var stale = Date.now() - (catalogDrafts.ROLLBACK_WINDOW_MS + (60 * 1000));
  await ctx.query(
    "UPDATE catalog_drafts SET published_at = ?1 WHERE slug = ?2",
    [stale, "draft-old"],
  );

  var threw = null;
  try { await cd.rollbackDraft({ draft_slug: "draft-old", reason: "too late" }); }
  catch (e) { threw = e; }
  check("rollback outside window threw",  threw != null);
  check("rollback outside window code",   threw && threw.code === "ROLLBACK_WINDOW_ELAPSED");

  // The draft stays published (no half-rolled-back state).
  var d = await cd.getDraft("draft-old");
  check("rollback outside window keeps published", d.status === "published");
}

// ---- cancelDraft + listDrafts ------------------------------------------

async function _cancelAndList() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  await cd.openDraft({ slug: "d1", title: "D1", owner_id: "op-a" });
  await cd.openDraft({ slug: "d2", title: "D2", owner_id: "op-b" });
  await cd.openDraft({ slug: "d3", title: "D3", owner_id: "op-a" });

  var cancelled = await cd.cancelDraft({ draft_slug: "d2", reason: "scope shrank" });
  check("cancelDraft status",            cancelled.status === "cancelled");
  check("cancelDraft cancel_reason",     cancelled.cancel_reason === "scope shrank");
  check("cancelDraft cancelled_at int",  Number.isInteger(cancelled.cancelled_at));

  // Subsequent stageChange refuses.
  await assert.rejects(cd.stageChange({
    draft_slug: "d2", kind: "create_product",
    payload: { slug: "x", title: "x", status: "draft" },
  }), /terminal/);

  // listDrafts default returns all 3.
  var all = await cd.listDrafts();
  check("listDrafts default count", all.length === 3);

  // Filter by status.
  var open = await cd.listDrafts({ status: "open" });
  check("listDrafts open count",  open.length === 2);
  check("listDrafts open slugs",  open.map(function (d) { return d.slug; }).sort().join(",") === "d1,d3");

  var cancelledList = await cd.listDrafts({ status: "cancelled" });
  check("listDrafts cancelled count", cancelledList.length === 1 && cancelledList[0].slug === "d2");

  // Filter by owner.
  var opA = await cd.listDrafts({ owner: "op-a" });
  check("listDrafts owner op-a count", opA.length === 2);

  // Combined.
  var opAOpen = await cd.listDrafts({ owner: "op-a", status: "open" });
  check("listDrafts owner+status",     opAOpen.length === 2);

  // cancelDraft refusals.
  await assert.rejects(cd.cancelDraft({ draft_slug: "no-such", reason: "x" }), /not found/);
  await assert.rejects(cd.cancelDraft({ draft_slug: "d2", reason: "double" }), /terminal/);
  await assert.rejects(cd.cancelDraft({ draft_slug: "d1" }), /reason/);
}

// ---- historyForSku ------------------------------------------------------

async function _historyForSku() {
  var ctx = _makeQueryAndCatalog();
  var cd  = catalogDrafts.create({ query: ctx.query, catalog: ctx.catalog });

  // Seed so set_price has a variant to address.
  var seed  = await ctx.catalog.products.create({ slug: "legacy", title: "Legacy", status: "active" });
  await ctx.catalog.variants.create(seed.id, { sku: "TARGET-SKU" });

  await cd.openDraft({ slug: "first", title: "First" });
  await cd.stageChange({
    draft_slug: "first", kind: "set_price",
    payload: { sku: "TARGET-SKU", currency: "USD", amount_minor: 500 },
  });
  await cd.stageChange({
    draft_slug: "first", kind: "set_inventory",
    payload: { sku: "TARGET-SKU", stock_on_hand: 10 },
  });
  await cd.stageChange({
    draft_slug: "first", kind: "set_price",
    payload: { sku: "OTHER-SKU", currency: "USD", amount_minor: 999 },
  });

  await cd.openDraft({ slug: "second", title: "Second" });
  await cd.stageChange({
    draft_slug: "second", kind: "set_price",
    payload: { sku: "TARGET-SKU", currency: "EUR", amount_minor: 600 },
  });

  var hist = await cd.historyForSku("TARGET-SKU");
  check("historyForSku count",            hist.length === 3);
  // All entries reference TARGET-SKU.
  var allMatch = hist.every(function (h) {
    return (h.payload && h.payload.sku === "TARGET-SKU");
  });
  check("historyForSku all match",        allMatch);
  // OTHER-SKU isn't in the result.
  var hasOther = hist.some(function (h) { return h.payload && h.payload.sku === "OTHER-SKU"; });
  check("historyForSku excludes OTHER",   hasOther === false);
  // Each entry carries the parent draft summary.
  check("historyForSku draft attached",   hist[0].draft != null && typeof hist[0].draft.title === "string");

  // Unknown SKU returns an empty list.
  var none = await cd.historyForSku("UNUSED-SKU");
  check("historyForSku unknown empty",    none.length === 0);
}

// ---- factory refusals + constants ---------------------------------------

async function _factoryRefusalsAndConstants() {
  // catalog handle required.
  assert.throws(function () { catalogDrafts.create({ query: function () {} }); }, /catalog/);
  // tags subsurface required.
  assert.throws(function () {
    catalogDrafts.create({
      query: function () {},
      catalog: { products: {}, variants: {}, prices: {}, inventory: {} },
    });
  }, /tags/);
  // Missing subsurface.
  assert.throws(function () {
    catalogDrafts.create({
      query: function () {},
      catalog: { products: {}, variants: {}, prices: {} },
    });
  }, /inventory/);

  check("STATUSES export",       catalogDrafts.STATUSES.indexOf("open") !== -1);
  check("KINDS includes set_price", catalogDrafts.KINDS.indexOf("set_price") !== -1);
  check("ROLLBACK_WINDOW_MS = 7d", catalogDrafts.ROLLBACK_WINDOW_MS === 7 * 24 * 60 * 60 * 1000);
  check("MAX_CHANGES_PER_DRAFT", catalogDrafts.MAX_CHANGES_PER_DRAFT > 0);
}

// ---- runner -------------------------------------------------------------

async function run() {
  await _openDraftHappy();
  await _stageChangeHappy();
  await _previewMerged();
  await _publishDraftAtomic();
  await _publishPreflightRefusal();
  await _rollbackWithinWindow();
  await _rollbackOutsideWindow();
  await _cancelAndList();
  await _historyForSku();
  await _factoryRefusalsAndConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - catalog-drafts (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - catalog-drafts: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
