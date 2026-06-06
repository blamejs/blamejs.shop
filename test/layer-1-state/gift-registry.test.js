"use strict";
/**
 * gift-registry — owner-curated registry of desired items, with
 * friends/family recording purchases against it.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0086.
 *
 * Coverage:
 *   - createRegistry: persists the row + defaults status=active,
 *     closed_at=NULL, refuses duplicate slug
 *   - addItem: inserts items, refuses duplicate (sku, variant),
 *     refuses on closed registry
 *   - purchaseItem: aggregates into progressFor; refuses over-
 *     purchase past quantity_desired; refuses on closed registry
 *   - searchPublic: only `public` + `active` registries surface;
 *     private + unlisted + closed registries never appear
 *   - reveal_buyer=false redacts buyer_customer_id from the returned
 *     purchase shape; the underlying row still carries it
 *   - closeRegistry: active -> closed is the only legal transition;
 *     idempotent on a closed registry, post-close mutations refused
 *   - removeItem: soft-archives, refuses on closed registry
 *   - update: patches allowed columns; refuses on closed registry
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var giftRegistry = require("../../lib/gift-registry");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG_REGISTRY = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0086_gift_registry.sql");

function _splitSchema(text) {
  // Strip line comments before splitting on `;` so a `--` line
  // doesn't comment out the closing paren of a CREATE TABLE.
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_REGISTRY, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return {
          rows:      [],
          rowCount:  Number(info.changes),
          lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    reg:   giftRegistry.create({ query: h.query }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

async function _createRegistryShape() {
  var f = _factory();
  var ownerId = _uuid();

  var reg = await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "alice-and-bob-2026",
    title:             "Alice & Bob's Wedding",
    occasion:          "wedding",
    event_date:        Date.now() + 90 * 86400000,
    recipient_name:    "Alice & Bob",
    privacy:           "public",
  });
  check("createRegistry returns row",        reg && reg.slug === "alice-and-bob-2026");
  check("createRegistry status active",      reg.status === "active");
  check("createRegistry closed_at null",     reg.closed_at === null);
  check("createRegistry occasion persisted", reg.occasion === "wedding");
  check("createRegistry privacy persisted",  reg.privacy === "public");
  check("createRegistry created_at set",     typeof reg.created_at === "number");
  check("createRegistry updated_at set",     typeof reg.updated_at === "number");
  check("createRegistry owner persisted",    reg.owner_customer_id === ownerId);
  check("createRegistry message defaults",   reg.message === "");
  check("createRegistry shipAddr null",      reg.shipping_address_id === null);

  // getRegistry round-trips.
  var fetched = await f.reg.getRegistry("alice-and-bob-2026");
  check("getRegistry returns row",            fetched && fetched.slug === reg.slug);

  // getRegistry on unknown slug returns null.
  var miss = await f.reg.getRegistry("does-not-exist");
  check("getRegistry unknown null",           miss === null);

  // Duplicate slug refused.
  await assert.rejects(
    f.reg.createRegistry({
      owner_customer_id: ownerId,
      slug:              "alice-and-bob-2026",
      title:             "Another",
      occasion:          "wedding",
      recipient_name:    "Other",
      privacy:           "public",
    }),
    /already exists/,
  );

  // listForOwner returns the registry.
  var owned = await f.reg.listForOwner(ownerId);
  check("listForOwner returns registry",      owned.length === 1 && owned[0].slug === reg.slug);
}

async function _addItemBehaviour() {
  var f = _factory();
  var ownerId = _uuid();
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "baby-shower-2026",
    title:             "Baby Shower",
    occasion:          "baby",
    recipient_name:    "Carla",
    privacy:           "unlisted",
  });

  // Add a couple items.
  var blender = await f.reg.addItem({
    registry_slug:    "baby-shower-2026",
    sku:              "STROLLER-DELUXE",
    quantity_desired: 1,
    priority:         1,
  });
  check("addItem returns id",                 typeof blender.id === "string" && blender.id.length === 36);
  check("addItem qty persisted",              blender.quantity_desired === 1);
  check("addItem priority persisted",         blender.priority === 1);

  var diapers = await f.reg.addItem({
    registry_slug:    "baby-shower-2026",
    sku:              "DIAPERS-NEWBORN",
    quantity_desired: 5,
  });
  check("addItem default priority is 3",      diapers.priority === 3);

  // Duplicate (sku, variant) refused.
  await assert.rejects(
    f.reg.addItem({
      registry_slug:    "baby-shower-2026",
      sku:              "STROLLER-DELUXE",
      quantity_desired: 1,
    }),
    /already on registry/,
  );

  // getBySlug returns items sorted by priority asc.
  var view = await f.reg.getBySlug("baby-shower-2026");
  check("getBySlug returns items",            view && view.items.length === 2);
  check("getBySlug priority sort",            view.items[0].sku === "STROLLER-DELUXE");

  // unknown slug -> null.
  var none = await f.reg.getBySlug("nope-nope-nope");
  check("getBySlug unknown null",             none === null);

  // Items have purchased_quantity zero pre-purchase.
  check("items pre-purchase zero",            view.items[0].purchased_quantity === 0);
}

async function _purchaseAggregatesProgress() {
  var f = _factory();
  var ownerId = _uuid();
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "housewarming-2026",
    title:             "Housewarming",
    occasion:          "housewarming",
    recipient_name:    "Dani",
    privacy:           "public",
  });
  var lamp = await f.reg.addItem({
    registry_slug:    "housewarming-2026",
    sku:              "FLOOR-LAMP",
    quantity_desired: 2,
  });
  var rug = await f.reg.addItem({
    registry_slug:    "housewarming-2026",
    sku:              "AREA-RUG",
    quantity_desired: 1,
  });

  // Pre-purchase: 0% across the board.
  var pre = await f.reg.progressFor("housewarming-2026");
  check("progress pre zero overall",          pre.overall_percent === 0);
  check("progress pre total desired",         pre.total_desired === 3);
  check("progress pre items remaining",        pre.items.every(function (i) { return i.remaining === i.quantity_desired; }));

  // Friend A buys one lamp (anonymously).
  var friendA = _uuid();
  await f.reg.purchaseItem({
    registry_slug:     "housewarming-2026",
    item_id:           lamp.id,
    quantity:          1,
    buyer_customer_id: friendA,
    reveal_buyer:      false,
  });

  // Friend B buys the rug (revealed).
  var friendB = _uuid();
  await f.reg.purchaseItem({
    registry_slug:     "housewarming-2026",
    item_id:           rug.id,
    quantity:          1,
    buyer_customer_id: friendB,
    reveal_buyer:      true,
    buyer_message:     "Welcome to the new place!",
  });

  // Mid-purchase: lamp 50%, rug 100%, overall 2/3 ~= 67%.
  var mid = await f.reg.progressFor("housewarming-2026");
  check("progress mid total purchased",       mid.total_purchased === 2);
  check("progress mid overall percent",       mid.overall_percent === 67);

  // Per-item breakdown.
  var lampProg = mid.items.filter(function (i) { return i.item_id === lamp.id; })[0];
  var rugProg  = mid.items.filter(function (i) { return i.item_id === rug.id;  })[0];
  check("lamp 50%",                            lampProg && lampProg.percent === 50 && lampProg.remaining === 1);
  check("rug 100%",                            rugProg && rugProg.percent === 100 && rugProg.remaining === 0);

  // Friend C tops up the second lamp.
  var friendC = _uuid();
  await f.reg.purchaseItem({
    registry_slug:     "housewarming-2026",
    item_id:           lamp.id,
    quantity:          1,
    buyer_customer_id: friendC,
    reveal_buyer:      false,
  });
  var done = await f.reg.progressFor("housewarming-2026");
  check("progress fully purchased",            done.overall_percent === 100);
  check("progress all remaining zero",         done.items.every(function (i) { return i.remaining === 0; }));

  // Over-purchase refused: lamp is now fully bought (2 of 2).
  await assert.rejects(
    f.reg.purchaseItem({
      registry_slug:     "housewarming-2026",
      item_id:           lamp.id,
      quantity:          1,
      buyer_customer_id: _uuid(),
      reveal_buyer:      false,
    }),
    function (err) {
      return err && err.code === "GIFT_REGISTRY_OVER_PURCHASE";
    },
  );
}

// The over-purchase check and the purchase write are ONE atomic guarded
// INSERT, so concurrent buyers racing for the last unit can't both pass
// the prior-sum check and both insert (the read-then-write race that let
// purchases exceed quantity_desired). The aggregate never overshoots.
async function _concurrentPurchaseDoesNotOversell() {
  var f = _factory();
  await f.reg.createRegistry({
    owner_customer_id: _uuid(),
    slug:              "wedding-race",
    title:             "Wedding",
    occasion:          "wedding",
    recipient_name:    "A and B",
    privacy:           "public",
  });

  // desired = 1, two concurrent qty-1 purchases: exactly one wins.
  var blender = await f.reg.addItem({ registry_slug: "wedding-race", sku: "BLENDER-1", quantity_desired: 1 });
  var settled = await Promise.allSettled([
    f.reg.purchaseItem({ registry_slug: "wedding-race", item_id: blender.id, quantity: 1 }),
    f.reg.purchaseItem({ registry_slug: "wedding-race", item_id: blender.id, quantity: 1 }),
  ]);
  var ok = settled.filter(function (s) { return s.status === "fulfilled"; });
  var no = settled.filter(function (s) { return s.status === "rejected"; });
  check("concurrent purchase desired=1: exactly one wins", ok.length === 1);
  check("concurrent purchase desired=1: one refused", no.length === 1);
  check("concurrent purchase desired=1: refusal coded",
    no[0] && no[0].reason && no[0].reason.code === "GIFT_REGISTRY_OVER_PURCHASE");
  var blenderSum = f.db.prepare(
    "SELECT COALESCE(SUM(quantity), 0) AS s FROM gift_registry_purchases WHERE item_id = ?"
  ).all(blender.id)[0].s;
  check("concurrent purchase desired=1: total never exceeds desired", blenderSum === 1);

  // desired = 3, four concurrent qty-1 purchases: exactly three win.
  var towel = await f.reg.addItem({ registry_slug: "wedding-race", sku: "TOWEL-1", quantity_desired: 3 });
  var settled2 = await Promise.allSettled([0, 1, 2, 3].map(function () {
    return f.reg.purchaseItem({ registry_slug: "wedding-race", item_id: towel.id, quantity: 1 });
  }));
  var ok2 = settled2.filter(function (s) { return s.status === "fulfilled"; });
  check("concurrent purchase desired=3: exactly three win", ok2.length === 3);
  var towelSum = f.db.prepare(
    "SELECT COALESCE(SUM(quantity), 0) AS s FROM gift_registry_purchases WHERE item_id = ?"
  ).all(towel.id)[0].s;
  check("concurrent purchase desired=3: total caps at desired", towelSum === 3);

  // Partial-quantity over: desired = 2, two concurrent qty-2 buyers:
  // exactly one wins (a third blender would be a return).
  var pan = await f.reg.addItem({ registry_slug: "wedding-race", sku: "PAN-1", quantity_desired: 2 });
  var settled3 = await Promise.allSettled([
    f.reg.purchaseItem({ registry_slug: "wedding-race", item_id: pan.id, quantity: 2 }),
    f.reg.purchaseItem({ registry_slug: "wedding-race", item_id: pan.id, quantity: 2 }),
  ]);
  var ok3 = settled3.filter(function (s) { return s.status === "fulfilled"; });
  check("concurrent purchase qty=2 desired=2: exactly one wins", ok3.length === 1);
  var panSum = f.db.prepare(
    "SELECT COALESCE(SUM(quantity), 0) AS s FROM gift_registry_purchases WHERE item_id = ?"
  ).all(pan.id)[0].s;
  check("concurrent purchase qty=2 desired=2: total caps at desired", panSum === 2);
}

async function _searchPublicPrivacyFilter() {
  var f = _factory();
  var ownerId = _uuid();

  // Three registries: one public-active, one unlisted-active, one
  // private-active. Only the public one should surface from searchPublic.
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "public-graduation",
    title:             "Eli's Graduation Party",
    occasion:          "graduation",
    recipient_name:    "Eli",
    privacy:           "public",
  });
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "secret-graduation",
    title:             "Eli's Secret Surprise Graduation Bash",
    occasion:          "graduation",
    recipient_name:    "Eli",
    privacy:           "unlisted",
  });
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "private-graduation",
    title:             "Eli's Private Graduation Plan",
    occasion:          "graduation",
    recipient_name:    "Eli",
    privacy:           "private",
  });

  // Search for "Eli" — the title and recipient_name both contain it.
  // Only public surface.
  var results = await f.reg.searchPublic({ q: "Eli" });
  check("searchPublic returns 1",              results.length === 1);
  check("searchPublic returns public one",      results[0].slug === "public-graduation");

  // Search by title fragment, case-insensitive.
  var party = await f.reg.searchPublic({ q: "graduation party" });
  check("searchPublic case-insensitive",        party.length === 1 && party[0].slug === "public-graduation");

  // No matches -> empty array.
  var none = await f.reg.searchPublic({ q: "nobody-named-this" });
  check("searchPublic empty array",             Array.isArray(none) && none.length === 0);

  // Now close the public one — it should drop out of searchPublic.
  await f.reg.closeRegistry("public-graduation");
  var afterClose = await f.reg.searchPublic({ q: "Eli" });
  check("searchPublic excludes closed",         afterClose.length === 0);

  // getBySlug still works for unlisted (anyone with the slug).
  var unlistedView = await f.reg.getBySlug("secret-graduation");
  check("unlisted resolvable via getBySlug",    unlistedView !== null && unlistedView.registry.slug === "secret-graduation");
}

async function _revealBuyerHidesIdentity() {
  var f = _factory();
  var ownerId = _uuid();
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "anniv-2026",
    title:             "10th Anniversary",
    occasion:          "anniversary",
    recipient_name:    "F & G",
    privacy:           "unlisted",
  });
  var champagne = await f.reg.addItem({
    registry_slug:    "anniv-2026",
    sku:              "CHAMPAGNE-VINTAGE",
    quantity_desired: 3,
  });

  var anonId  = _uuid();
  var openId  = _uuid();

  // Buyer A: anonymous.
  var anonRet = await f.reg.purchaseItem({
    registry_slug:     "anniv-2026",
    item_id:           champagne.id,
    quantity:          1,
    buyer_customer_id: anonId,
    buyer_message:     "Cheers!",
    reveal_buyer:      false,
  });
  check("anonymous purchase: id redacted",      anonRet.buyer_customer_id === null);
  check("anonymous purchase: reveal=false",     anonRet.reveal_buyer === false);
  check("anonymous purchase: message kept",     anonRet.buyer_message === "Cheers!");

  // Buyer B: revealed.
  var openRet = await f.reg.purchaseItem({
    registry_slug:     "anniv-2026",
    item_id:           champagne.id,
    quantity:          1,
    buyer_customer_id: openId,
    buyer_message:     "Congratulations!",
    reveal_buyer:      true,
  });
  check("revealed purchase: id present",        openRet.buyer_customer_id === openId);
  check("revealed purchase: reveal=true",       openRet.reveal_buyer === true);

  // Owner-facing view via include_purchased: anon row redacted,
  // revealed row carries the id.
  var ownerView = await f.reg.getBySlug("anniv-2026", { include_purchased: true });
  check("owner view: 2 purchases",              ownerView.purchases.length === 2);
  var anonRow = ownerView.purchases.filter(function (p) { return p.reveal_buyer === false; })[0];
  var openRow = ownerView.purchases.filter(function (p) { return p.reveal_buyer === true;  })[0];
  check("owner view anon redacted",             anonRow.buyer_customer_id === null);
  check("owner view revealed surfaces id",      openRow.buyer_customer_id === openId);

  // But the underlying storage still has the buyer id — the
  // primitive only redacts the surface. This is the audit-trail
  // / refund-handling guarantee.
  var rawRow = f.db.prepare(
    "SELECT buyer_customer_id FROM gift_registry_purchases " +
    "WHERE registry_slug = ? AND reveal_buyer = 0",
  ).all("anniv-2026")[0];
  check("storage row carries id",               rawRow.buyer_customer_id === anonId);

  // Inconsistent input refused: reveal_buyer=true without buyer id.
  await assert.rejects(
    f.reg.purchaseItem({
      registry_slug: "anniv-2026",
      item_id:       champagne.id,
      quantity:      1,
      reveal_buyer:  true,
    }),
    /reveal_buyer=true requires buyer_customer_id/,
  );

  // Anonymous guest purchase (no buyer_customer_id at all) is allowed
  // when reveal_buyer is false (or omitted).
  var guest = await f.reg.purchaseItem({
    registry_slug: "anniv-2026",
    item_id:       champagne.id,
    quantity:      1,
  });
  check("guest purchase allowed",                guest.buyer_customer_id === null && guest.reveal_buyer === false);
}

async function _closeRegistryFsm() {
  var f = _factory();
  var ownerId = _uuid();
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "birthday-2026",
    title:             "30th Birthday",
    occasion:          "birthday",
    recipient_name:    "Hugo",
    privacy:           "public",
  });
  var cake = await f.reg.addItem({
    registry_slug:    "birthday-2026",
    sku:              "FANCY-CAKE",
    quantity_desired: 1,
  });

  // active -> closed.
  var closed = await f.reg.closeRegistry("birthday-2026");
  check("closeRegistry status closed",         closed.status === "closed");
  check("closeRegistry closed_at set",         typeof closed.closed_at === "number");

  // Idempotent: second close returns the existing closed row,
  // doesn't throw, doesn't push a new closed_at.
  var second = await f.reg.closeRegistry("birthday-2026");
  check("closeRegistry idempotent",             second.status === "closed"
                                                && second.closed_at === closed.closed_at);

  // closeRegistry on unknown slug returns null.
  var nope = await f.reg.closeRegistry("never-existed");
  check("closeRegistry unknown null",           nope === null);

  // Post-close: addItem refused.
  await assert.rejects(
    f.reg.addItem({
      registry_slug:    "birthday-2026",
      sku:              "EXTRA-CAKE",
      quantity_desired: 1,
    }),
    /is closed/,
  );

  // Post-close: removeItem refused.
  await assert.rejects(
    f.reg.removeItem({ registry_slug: "birthday-2026", item_id: cake.id }),
    /is closed/,
  );

  // Post-close: purchaseItem refused.
  await assert.rejects(
    f.reg.purchaseItem({
      registry_slug:     "birthday-2026",
      item_id:           cake.id,
      quantity:          1,
      buyer_customer_id: _uuid(),
      reveal_buyer:      true,
    }),
    /is closed/,
  );

  // Post-close: update refused.
  await assert.rejects(
    f.reg.update("birthday-2026", { title: "30th Birthday Bash!" }),
    /is closed/,
  );

  // But reads still work — owner can review what arrived.
  var view = await f.reg.getBySlug("birthday-2026");
  check("closed registry still readable",       view !== null && view.registry.status === "closed");
}

async function _removeAndUpdate() {
  var f = _factory();
  var ownerId = _uuid();
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "to-edit",
    title:             "Initial",
    occasion:          "other",
    recipient_name:    "Iris",
    privacy:           "private",
  });
  var item = await f.reg.addItem({
    registry_slug:    "to-edit",
    sku:              "SOMETHING",
    quantity_desired: 2,
  });

  // update: change title + privacy.
  var ts = Date.now();
  void ts;
  var updated = await f.reg.update("to-edit", {
    title:   "Renamed Title",
    privacy: "public",
  });
  check("update title",                         updated.title === "Renamed Title");
  check("update privacy",                       updated.privacy === "public");

  // update unknown slug -> null.
  var miss = await f.reg.update("not-a-slug", { title: "x" });
  check("update unknown null",                  miss === null);

  // update with empty patch refused.
  await assert.rejects(
    f.reg.update("to-edit", {}),
    /patch contained no updatable fields/,
  );

  // removeItem soft-archives.
  var rem = await f.reg.removeItem({ registry_slug: "to-edit", item_id: item.id });
  check("removeItem ok",                        rem.removed === true);

  // Subsequent getBySlug omits the archived item.
  var afterRemove = await f.reg.getBySlug("to-edit");
  check("archived item omitted from view",      afterRemove.items.length === 0);

  // The storage row is still there (soft-delete).
  var storageRow = f.db.prepare(
    "SELECT archived_at FROM gift_registry_items WHERE id = ?",
  ).all(item.id)[0];
  check("removed item soft-archived",           storageRow && typeof storageRow.archived_at === "number");

  // Re-remove returns removed:false (nothing to archive).
  var rem2 = await f.reg.removeItem({ registry_slug: "to-edit", item_id: item.id });
  check("re-remove returns false",              rem2.removed === false);

  // After archiving, re-adding the same sku is now permitted (the
  // UNIQUE constraint is keyed off the active row only at the
  // application layer).
  var readd = await f.reg.addItem({
    registry_slug:    "to-edit",
    sku:              "SOMETHING",
    quantity_desired: 1,
  });
  check("re-add after archive ok",              readd.id !== item.id);
}

async function _validation() {
  var f = _factory();
  var ownerId = _uuid();

  // createRegistry
  await assert.rejects(f.reg.createRegistry(),                                         /input object required/);
  await assert.rejects(f.reg.createRegistry({}),                                       /owner_customer_id/);
  await assert.rejects(f.reg.createRegistry({ owner_customer_id: "not-a-uuid" }),      /owner_customer_id/);
  await assert.rejects(f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "Bad Slug With Spaces",
    title:             "x",
    occasion:          "wedding",
    recipient_name:    "x",
    privacy:           "public",
  }), /slug/);
  await assert.rejects(f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "ok-slug",
    title:             "",
    occasion:          "wedding",
    recipient_name:    "x",
    privacy:           "public",
  }), /title/);
  await assert.rejects(f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "ok-slug",
    title:             "x",
    occasion:          "bogus",
    recipient_name:    "x",
    privacy:           "public",
  }), /occasion/);
  await assert.rejects(f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "ok-slug",
    title:             "x",
    occasion:          "wedding",
    recipient_name:    "x",
    privacy:           "open",
  }), /privacy/);
  await assert.rejects(f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "ok-slug",
    title:             "x",
    occasion:          "wedding",
    event_date:        -1,
    recipient_name:    "x",
    privacy:           "public",
  }), /event_date/);
  await assert.rejects(f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "ok-slug",
    title:             "x",
    occasion:          "wedding",
    recipient_name:    "",
    privacy:           "public",
  }), /recipient_name/);

  // Seed a real registry for the entry-point tests.
  await f.reg.createRegistry({
    owner_customer_id: ownerId,
    slug:              "live",
    title:             "Live",
    occasion:          "wedding",
    recipient_name:    "Live",
    privacy:           "public",
  });

  // addItem
  await assert.rejects(f.reg.addItem(),                                                /input object required/);
  await assert.rejects(f.reg.addItem({ registry_slug: "Bad" }),                         /registry_slug/);
  await assert.rejects(f.reg.addItem({ registry_slug: "live", sku: "" }),               /sku/);
  await assert.rejects(f.reg.addItem({ registry_slug: "live", sku: "X", quantity_desired: 0 }), /quantity_desired/);
  await assert.rejects(f.reg.addItem({ registry_slug: "live", sku: "X", quantity_desired: 1, priority: 6 }), /priority/);
  await assert.rejects(f.reg.addItem({ registry_slug: "live", sku: "X", quantity_desired: 1, priority: 0 }), /priority/);
  await assert.rejects(f.reg.addItem({ registry_slug: "nope", sku: "X", quantity_desired: 1 }), /not found/);
  await assert.rejects(f.reg.addItem({ registry_slug: "live", sku: "X", quantity_desired: 1, variant_id: "not-a-uuid" }), /variant_id/);

  // removeItem
  await assert.rejects(f.reg.removeItem(),                                              /input object required/);
  await assert.rejects(f.reg.removeItem({ registry_slug: "live", item_id: "not-uuid" }), /item_id/);
  await assert.rejects(f.reg.removeItem({ registry_slug: "nope", item_id: _uuid() }),    /not found/);

  // purchaseItem
  await assert.rejects(f.reg.purchaseItem(),                                            /input object required/);
  await assert.rejects(f.reg.purchaseItem({ registry_slug: "live", item_id: _uuid(), quantity: 0 }), /quantity/);
  await assert.rejects(f.reg.purchaseItem({ registry_slug: "live", item_id: _uuid(), quantity: 1 }), /not found on registry/);
  await assert.rejects(f.reg.purchaseItem({ registry_slug: "nope", item_id: _uuid(), quantity: 1 }), /not found/);
  await assert.rejects(f.reg.purchaseItem({ registry_slug: "live", item_id: _uuid(), quantity: 1.5 }), /quantity/);

  // closeRegistry
  await assert.rejects(f.reg.closeRegistry("Bad Slug"),                                 /slug/);

  // update
  await assert.rejects(f.reg.update("Bad Slug"),                                        /slug/);
  await assert.rejects(f.reg.update("live"),                                            /patch object required/);
  await assert.rejects(f.reg.update("live", { title: "" }),                             /title/);
  await assert.rejects(f.reg.update("live", { privacy: "open" }),                        /privacy/);

  // searchPublic
  await assert.rejects(f.reg.searchPublic(),                                            /input object required/);
  await assert.rejects(f.reg.searchPublic({ q: 1 }),                                    /q/);
  await assert.rejects(f.reg.searchPublic({ q: "a" }),                                  /q length/);
  await assert.rejects(f.reg.searchPublic({ q: "valid", limit: 0 }),                    /limit/);
  await assert.rejects(f.reg.searchPublic({ q: "valid", limit: 1000 }),                 /limit/);

  // listForOwner
  await assert.rejects(f.reg.listForOwner("not-a-uuid"),                                /customer_id/);

  // getRegistry / getBySlug
  await assert.rejects(f.reg.getRegistry("Bad Slug"),                                   /slug/);
  await assert.rejects(f.reg.getBySlug("Bad Slug"),                                     /slug/);

  // progressFor
  await assert.rejects(f.reg.progressFor("Bad Slug"),                                   /slug/);
}

async function _exportedConstants() {
  check("OCCASIONS exported",                  Array.isArray(giftRegistry.OCCASIONS)
                                                && giftRegistry.OCCASIONS.indexOf("wedding") !== -1
                                                && giftRegistry.OCCASIONS.indexOf("baby") !== -1);
  check("PRIVACIES exported",                  Array.isArray(giftRegistry.PRIVACIES)
                                                && giftRegistry.PRIVACIES.indexOf("public") !== -1
                                                && giftRegistry.PRIVACIES.indexOf("unlisted") !== -1
                                                && giftRegistry.PRIVACIES.indexOf("private") !== -1);
  check("STATUSES exported",                   Array.isArray(giftRegistry.STATUSES)
                                                && giftRegistry.STATUSES.indexOf("active") !== -1
                                                && giftRegistry.STATUSES.indexOf("closed") !== -1);
  var inst = giftRegistry.create({ query: _makeQuery().query });
  check("instance exposes OCCASIONS",          inst.OCCASIONS.length === giftRegistry.OCCASIONS.length);
  check("instance exposes PRIVACIES",          inst.PRIVACIES.length === 3);
  check("instance exposes STATUSES",           inst.STATUSES.length === 2);
}

async function run() {
  await _createRegistryShape();
  await _addItemBehaviour();
  await _purchaseAggregatesProgress();
  await _concurrentPurchaseDoesNotOversell();
  await _searchPublicPrivacyFilter();
  await _revealBuyerHidesIdentity();
  await _closeRegistryFsm();
  await _removeAndUpdate();
  await _validation();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - gift-registry (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
