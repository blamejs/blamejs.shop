"use strict";
/**
 * category-navigation — storefront category tree + mega-menu config.
 * Hierarchical (parent / child) categories with breadcrumbs +
 * sub-menu rendering data + cycle-safe re-parenting.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0201_category_navigation.sql`. The primitive isn't wired through
 * `bShop` yet — the test requires `lib/category-navigation.js`
 * directly so the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - defineCategory parent_slug validation (unknown parent refused,
 *     archived parent refused, self-parent refused, hero_image_url
 *     gate refuses javascript:)
 *   - tree({ depth }) nested shape with `children` arrays + depth cap
 *   - breadcrumbsFor returns root -> leaf chain
 *   - move cycle detection: A -> B -> A and deeper cycles refused
 *   - reorderSiblings re-stamps positions; incomplete list refused;
 *     unknown slug refused; duplicate refused
 *   - archive cascade vs orphan-refusal
 *   - update refuses parent_slug + immutable slug + archived rows
 *   - categoriesByParent + descendantsOf
 *   - productCount with + without catalog handle
 *   - popularCategories window + limit + sort
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var categoryNavigation = require("../../lib/category-navigation");
var helpers            = require("../helpers");
var check              = helpers.check;
var assert             = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0201_category_navigation.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        changes:   Number(info.changes),
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _setup(catalog) {
  var query = _makeQuery();
  var nav = categoryNavigation.create({ query: query, catalog: catalog || null });
  return { query: query, nav: nav };
}

async function _defineCategoryValidation() {
  var ctx = _setup();
  // Top-level category.
  var outdoors = await ctx.nav.defineCategory({
    slug:           "outdoors",
    title:          "Outdoors",
    description:    "Tents, hiking, camping.",
    hero_image_url: "https://example.com/hero/outdoors.jpg",
    active:         true,
  });
  check("defineCategory returns slug",         outdoors.slug === "outdoors");
  check("defineCategory parent_slug is null",  outdoors.parent_slug === null);
  check("defineCategory active default true",  outdoors.active === true);
  check("defineCategory position assigned",    outdoors.position === 0);
  check("defineCategory hero https accepted",  outdoors.hero_image_url === "https://example.com/hero/outdoors.jpg");

  // Child category.
  var tents = await ctx.nav.defineCategory({
    slug:        "tents",
    parent_slug: "outdoors",
    title:       "Tents",
  });
  check("defineCategory child parent_slug",    tents.parent_slug === "outdoors");
  check("defineCategory child position 0",     tents.position === 0);

  // Second sibling auto-positions at 1.
  var hiking = await ctx.nav.defineCategory({
    slug: "hiking", parent_slug: "outdoors", title: "Hiking",
  });
  check("auto-position next sibling",          hiking.position === 1);

  // Idempotent re-define patches in place.
  var outdoorsPrime = await ctx.nav.defineCategory({
    slug: "outdoors", title: "Outdoors (updated)",
  });
  check("defineCategory idempotent on slug",   outdoorsPrime.title === "Outdoors (updated)");
  check("defineCategory preserves created_at", outdoorsPrime.created_at === outdoors.created_at);
  check("defineCategory bumps updated_at",     outdoorsPrime.updated_at >= outdoors.updated_at);

  // /-rooted absolute path accepted as hero.
  var pathHero = await ctx.nav.defineCategory({
    slug: "slash-hero", title: "T", hero_image_url: "/img/x.jpg",
  });
  check("defineCategory /-rooted hero accepted", pathHero.hero_image_url === "/img/x.jpg");

  // Unknown parent refused.
  await assert.rejects(ctx.nav.defineCategory({
    slug: "lost", parent_slug: "no-such", title: "X",
  }), /parent_slug 'no-such' not found/);

  // Self-parent refused.
  await assert.rejects(ctx.nav.defineCategory({
    slug: "self", parent_slug: "self", title: "X",
  }), /parent_slug must differ from slug/);

  // Archived parent refused.
  await ctx.nav.defineCategory({ slug: "doomed", title: "X" });
  await ctx.nav.archive({ slug: "doomed" });
  await assert.rejects(ctx.nav.defineCategory({
    slug: "ophan", parent_slug: "doomed", title: "X",
  }), /parent_slug 'doomed' is archived/);

  // hero_image_url protocol gate.
  await assert.rejects(ctx.nav.defineCategory({
    slug: "evil", title: "T", hero_image_url: "javascript:alert(1)",
  }), /hero_image_url/);
  await assert.rejects(ctx.nav.defineCategory({
    slug: "evil2", title: "T", hero_image_url: "//evil.example/x.jpg",
  }), /hero_image_url/);
  await assert.rejects(ctx.nav.defineCategory({
    slug: "evil3", title: "T", hero_image_url: "http://insecure.example/x.jpg",
  }), /hero_image_url/);

  // Generic refusals.
  await assert.rejects(ctx.nav.defineCategory(),                                     /input object required/);
  await assert.rejects(ctx.nav.defineCategory({ slug: "BAD CAPS", title: "T" }),     /slug/);
  await assert.rejects(ctx.nav.defineCategory({ slug: "ok", title: "" }),            /title/);
  await assert.rejects(ctx.nav.defineCategory({ slug: "ok", title: "bad\ntitle" }),  /title/);
  await assert.rejects(ctx.nav.defineCategory({ slug: "ok", title: "T", position: -1 }), /position/);
  await assert.rejects(ctx.nav.defineCategory({ slug: "ok", title: "T", active: "yes" }), /active/);
}

async function _treeShape() {
  var ctx = _setup();
  await ctx.nav.defineCategory({ slug: "outdoors",     title: "Outdoors" });
  await ctx.nav.defineCategory({ slug: "indoors",      title: "Indoors", position: 1 });
  await ctx.nav.defineCategory({ slug: "tents",        parent_slug: "outdoors", title: "Tents" });
  await ctx.nav.defineCategory({ slug: "family-tents", parent_slug: "tents",    title: "Family Tents" });
  await ctx.nav.defineCategory({ slug: "solo-tents",   parent_slug: "tents",    title: "Solo Tents", position: 1 });
  await ctx.nav.defineCategory({ slug: "hiking",       parent_slug: "outdoors", title: "Hiking", position: 1 });

  // Full tree rooted at top-level.
  var full = await ctx.nav.tree({ depth: 16 });
  check("tree returns array of root categories", Array.isArray(full) && full.length === 2);
  check("tree root[0] is outdoors (position 0)", full[0].slug === "outdoors");
  check("tree root[1] is indoors (position 1)",  full[1].slug === "indoors");
  check("tree outdoors has 2 children",          full[0].children.length === 2);
  check("tree outdoors.children[0] is tents",    full[0].children[0].slug === "tents");
  check("tree tents has 2 children",             full[0].children[0].children.length === 2);
  check("tree family-tents is leaf",             full[0].children[0].children[0].children.length === 0);
  check("tree sibling order respects position",  full[0].children[0].children[0].slug === "family-tents" && full[0].children[0].children[1].slug === "solo-tents");
  check("tree indoors has no children",          full[1].children.length === 0);

  // Depth cap.
  var depth1 = await ctx.nav.tree({ depth: 1 });
  check("tree depth=1 keeps roots",              depth1.length === 2);
  check("tree depth=1 children empty",           depth1[0].children.length === 0 && depth1[1].children.length === 0);

  var depth2 = await ctx.nav.tree({ depth: 2 });
  check("tree depth=2 fills 1 level",            depth2[0].children.length === 2);
  check("tree depth=2 grandchildren empty",      depth2[0].children[0].children.length === 0);

  // Rooted at a specific slug returns a single node with children.
  var rooted = await ctx.nav.tree({ root_slug: "tents" });
  check("tree root_slug returns single node",    rooted.slug === "tents");
  check("tree root_slug node has children",      Array.isArray(rooted.children) && rooted.children.length === 2);

  // Unknown root_slug refused.
  await assert.rejects(ctx.nav.tree({ root_slug: "no-such" }), /not found/);

  // categoriesByParent direct children.
  var directKids = await ctx.nav.categoriesByParent({ parent_slug: "outdoors" });
  check("categoriesByParent returns direct kids", directKids.length === 2);
  check("categoriesByParent ordered by position", directKids[0].slug === "tents" && directKids[1].slug === "hiking");

  // Top-level.
  var roots = await ctx.nav.categoriesByParent({});
  check("categoriesByParent top-level returns roots", roots.length === 2);

  // Unknown parent refused.
  await assert.rejects(ctx.nav.categoriesByParent({ parent_slug: "no-such" }), /not found/);

  // descendantsOf flat list w/ depth field.
  var desc = await ctx.nav.descendantsOf({ slug: "outdoors" });
  var descSlugs = desc.map(function (d) { return d.slug; }).sort();
  check("descendantsOf returns 4 descendants",   desc.length === 4);
  check("descendantsOf includes hiking",         descSlugs.indexOf("hiking") !== -1);
  check("descendantsOf includes family-tents",   descSlugs.indexOf("family-tents") !== -1);
  check("descendantsOf carries depth field",     desc.every(function (d) { return typeof d.depth === "number" && d.depth >= 1 && d.depth <= 2; }));

  var descDepth1 = await ctx.nav.descendantsOf({ slug: "outdoors", depth: 1 });
  check("descendantsOf depth=1 stops at level 1", descDepth1.length === 2);

  // Refusals.
  await assert.rejects(ctx.nav.tree({ depth: 0 }),         /depth/);
  await assert.rejects(ctx.nav.tree({ depth: 999 }),       /depth/);
  await assert.rejects(ctx.nav.descendantsOf(),            /input object required/);
  await assert.rejects(ctx.nav.descendantsOf({ slug: "no-such" }), /not found/);
}

async function _breadcrumbs() {
  var ctx = _setup();
  await ctx.nav.defineCategory({ slug: "outdoors",     title: "Outdoors" });
  await ctx.nav.defineCategory({ slug: "tents",        parent_slug: "outdoors", title: "Tents" });
  await ctx.nav.defineCategory({ slug: "family-tents", parent_slug: "tents",    title: "Family Tents" });

  var crumbs = await ctx.nav.breadcrumbsFor({ slug: "family-tents" });
  check("breadcrumbsFor returns 3 levels",       crumbs.length === 3);
  check("breadcrumbsFor[0] is root (outdoors)",  crumbs[0].slug === "outdoors");
  check("breadcrumbsFor[1] is parent (tents)",   crumbs[1].slug === "tents");
  check("breadcrumbsFor[2] is leaf (family-tents)", crumbs[2].slug === "family-tents");
  check("breadcrumbsFor entries hydrated",       crumbs[1].title === "Tents");

  // Root has a one-entry breadcrumb (just itself).
  var rootCrumb = await ctx.nav.breadcrumbsFor({ slug: "outdoors" });
  check("breadcrumbsFor root is single entry",   rootCrumb.length === 1 && rootCrumb[0].slug === "outdoors");

  // Refusals.
  await assert.rejects(ctx.nav.breadcrumbsFor(),                          /input object required/);
  await assert.rejects(ctx.nav.breadcrumbsFor({ slug: "no-such" }),        /not found/);
  await assert.rejects(ctx.nav.breadcrumbsFor({ slug: "BAD CAPS" }),       /slug/);
}

async function _moveCycleDetection() {
  var ctx = _setup();
  await ctx.nav.defineCategory({ slug: "a", title: "A" });
  await ctx.nav.defineCategory({ slug: "b", parent_slug: "a", title: "B" });
  await ctx.nav.defineCategory({ slug: "c", parent_slug: "b", title: "C" });
  await ctx.nav.defineCategory({ slug: "d", parent_slug: "c", title: "D" });

  // Move D under A — legal (no cycle).
  var moved = await ctx.nav.move({ slug: "d", new_parent_slug: "a" });
  check("move re-parents successfully",          moved.parent_slug === "a");

  // Move D back under C — legal again.
  await ctx.nav.move({ slug: "d", new_parent_slug: "c" });

  // Cycle: move A under D (D is a descendant of A) — refused.
  await assert.rejects(ctx.nav.move({
    slug: "a", new_parent_slug: "d",
  }), /cycle/);

  // Self-parent refused.
  await assert.rejects(ctx.nav.move({
    slug: "a", new_parent_slug: "a",
  }), /new_parent_slug must differ from slug/);

  // Cycle through defineCategory on an existing slug refused.
  await assert.rejects(ctx.nav.defineCategory({
    slug: "a", parent_slug: "d", title: "A",
  }), /cycle/);

  // Promote to top-level (new_parent_slug = null).
  var promoted = await ctx.nav.move({ slug: "c", new_parent_slug: null });
  check("move to top-level (null parent)",       promoted.parent_slug === null);

  // Unknown slug refused.
  await assert.rejects(ctx.nav.move({
    slug: "no-such", new_parent_slug: "a",
  }), /not found/);

  // Unknown new parent refused.
  await assert.rejects(ctx.nav.move({
    slug: "a", new_parent_slug: "no-such",
  }), /not found/);

  // new_position respected.
  var positioned = await ctx.nav.move({
    slug: "b", new_parent_slug: null, new_position: 5,
  });
  check("move new_position respected",           positioned.position === 5);
}

async function _reorderSiblings() {
  var ctx = _setup();
  await ctx.nav.defineCategory({ slug: "parent", title: "Parent" });
  await ctx.nav.defineCategory({ slug: "alpha", parent_slug: "parent", title: "Alpha" });
  await ctx.nav.defineCategory({ slug: "beta",  parent_slug: "parent", title: "Beta" });
  await ctx.nav.defineCategory({ slug: "gamma", parent_slug: "parent", title: "Gamma" });

  // Re-stamp order.
  var reordered = await ctx.nav.reorderSiblings({
    parent_slug:   "parent",
    ordered_slugs: ["gamma", "alpha", "beta"],
  });
  check("reorderSiblings returns 3 rows",        reordered.length === 3);
  check("reorderSiblings position 0 = gamma",    reordered[0].slug === "gamma" && reordered[0].position === 0);
  check("reorderSiblings position 1 = alpha",    reordered[1].slug === "alpha" && reordered[1].position === 1);
  check("reorderSiblings position 2 = beta",     reordered[2].slug === "beta" && reordered[2].position === 2);

  // Incomplete list refused (missing slug).
  await assert.rejects(ctx.nav.reorderSiblings({
    parent_slug: "parent", ordered_slugs: ["gamma", "alpha"],
  }), /complete list/);

  // Unknown slug under that parent refused.
  await assert.rejects(ctx.nav.reorderSiblings({
    parent_slug: "parent", ordered_slugs: ["gamma", "alpha", "beta", "outsider"],
  }), /direct children/);

  // Duplicate slug refused.
  await assert.rejects(ctx.nav.reorderSiblings({
    parent_slug: "parent", ordered_slugs: ["gamma", "alpha", "gamma"],
  }), /duplicate/);

  // Top-level reorder.
  await ctx.nav.defineCategory({ slug: "root-a", title: "RA" });
  await ctx.nav.defineCategory({ slug: "root-b", title: "RB" });
  var topReordered = await ctx.nav.reorderSiblings({
    ordered_slugs: ["root-b", "root-a", "parent"],
  });
  check("reorderSiblings top-level (null parent)", topReordered.length === 3);
  check("reorderSiblings top order respected",     topReordered[0].slug === "root-b" && topReordered[0].position === 0);

  // Refusals.
  await assert.rejects(ctx.nav.reorderSiblings(),                                            /input object required/);
  await assert.rejects(ctx.nav.reorderSiblings({ parent_slug: "parent" }),                    /ordered_slugs/);
  await assert.rejects(ctx.nav.reorderSiblings({ parent_slug: "no-such", ordered_slugs: [] }), /not found/);
  await assert.rejects(ctx.nav.reorderSiblings({ parent_slug: "parent", ordered_slugs: ["BAD CAPS"] }), /slug/);
}

async function _archiveCascade() {
  var ctx = _setup();
  await ctx.nav.defineCategory({ slug: "outdoors",     title: "Outdoors" });
  await ctx.nav.defineCategory({ slug: "tents",        parent_slug: "outdoors", title: "Tents" });
  await ctx.nav.defineCategory({ slug: "family-tents", parent_slug: "tents",    title: "Family Tents" });

  // Archive without cascade refused (descendants exist).
  await assert.rejects(ctx.nav.archive({ slug: "outdoors" }), /descendant/);

  // Cascade archives every descendant.
  var archived = await ctx.nav.archive({ slug: "outdoors", cascade: true });
  check("archive cascade sets archived_at",      typeof archived.archived_at === "number");
  check("archive cascade clears active",         archived.active === false);

  // Every descendant hidden from getCategory.
  check("archived descendant hidden (tents)",        (await ctx.nav.getCategory("tents")) === null);
  check("archived descendant hidden (family-tents)", (await ctx.nav.getCategory("family-tents")) === null);

  // Re-defining the slug revives it (archived_at clears).
  var revived = await ctx.nav.defineCategory({ slug: "outdoors", title: "Outdoors" });
  check("defineCategory revives archived slug",  revived.archived_at === null);
  check("defineCategory revives active=true",    revived.active === true);

  // Leaf archive (no descendants).
  await ctx.nav.defineCategory({ slug: "solo-leaf", title: "Solo" });
  var leafArch = await ctx.nav.archive({ slug: "solo-leaf" });
  check("archive leaf w/o cascade works",        leafArch.archived_at != null);

  // Re-archive is idempotent.
  var rearch = await ctx.nav.archive({ slug: "solo-leaf" });
  check("archive idempotent on already-archived", rearch.archived_at === leafArch.archived_at);

  // Refusals.
  await assert.rejects(ctx.nav.archive(),                          /input object required/);
  await assert.rejects(ctx.nav.archive({ slug: "no-such" }),        /not found/);

  // move refuses on archived row.
  await assert.rejects(ctx.nav.move({
    slug: "solo-leaf", new_parent_slug: "outdoors",
  }), /not found/);
}

async function _updateSurface() {
  var ctx = _setup();
  await ctx.nav.defineCategory({ slug: "outdoors", title: "Outdoors" });
  await ctx.nav.defineCategory({ slug: "tents", parent_slug: "outdoors", title: "Tents" });

  // Patch title + description.
  var p1 = await ctx.nav.update({
    slug: "tents",
    patch: { title: "Camping tents", description: "Family + solo + festival." },
  });
  check("update patches title",                  p1.title === "Camping tents");
  check("update patches description",            p1.description === "Family + solo + festival.");

  // Patch hero_image_url.
  var p2 = await ctx.nav.update({
    slug: "tents",
    patch: { hero_image_url: "https://example.com/new-hero.png" },
  });
  check("update patches hero_image_url",         p2.hero_image_url === "https://example.com/new-hero.png");

  // Clear hero_image_url with null.
  var p3 = await ctx.nav.update({ slug: "tents", patch: { hero_image_url: null } });
  check("update clears hero_image_url to null",  p3.hero_image_url === null);

  // Flip active.
  var p4 = await ctx.nav.update({ slug: "tents", patch: { active: false } });
  check("update flips active=false",             p4.active === false);

  // parent_slug rejected (use move instead).
  await assert.rejects(ctx.nav.update({
    slug: "tents", patch: { parent_slug: "outdoors" },
  }), /move\(\), not update\(\)/);

  // slug rejected (immutable).
  await assert.rejects(ctx.nav.update({
    slug: "tents", patch: { slug: "other" },
  }), /slug is immutable/);

  // Archived row refused.
  await ctx.nav.archive({ slug: "tents" });
  await assert.rejects(ctx.nav.update({
    slug: "tents", patch: { title: "X" },
  }), /archived/);

  // Refusals.
  await assert.rejects(ctx.nav.update(),                                       /input object required/);
  await assert.rejects(ctx.nav.update({ slug: "outdoors" }),                    /patch object required/);
  await assert.rejects(ctx.nav.update({ slug: "no-such", patch: { title: "T" } }), /not found/);
  await assert.rejects(ctx.nav.update({ slug: "outdoors", patch: { title: "" } }), /title/);
  await assert.rejects(ctx.nav.update({
    slug: "outdoors", patch: { hero_image_url: "javascript:1" },
  }), /hero_image_url/);
}

async function _productCountAndPopular() {
  // Stub catalog handle with deterministic counts.
  var counts = { outdoors: 5, tents: 12, hiking: 3, indoors: 8 };
  var catalog = {
    products: {
      countByCategory: function (slug) {
        return counts[slug] == null ? 0 : counts[slug];
      },
    },
  };
  var ctx = _setup(catalog);
  var start = Date.now() - 1000;

  await ctx.nav.defineCategory({ slug: "outdoors", title: "Outdoors" });
  await ctx.nav.defineCategory({ slug: "tents",    parent_slug: "outdoors", title: "Tents" });
  await ctx.nav.defineCategory({ slug: "hiking",   parent_slug: "outdoors", title: "Hiking" });
  await ctx.nav.defineCategory({ slug: "indoors",  title: "Indoors" });

  // Without descendants: just the slug's own count.
  var ownOnly = await ctx.nav.productCount({ slug: "outdoors" });
  check("productCount own only",                 ownOnly.count === 5 && ownOnly.includes_descendants === false);

  // With descendants: sums own + every descendant.
  var withDesc = await ctx.nav.productCount({ slug: "outdoors", include_descendants: true });
  check("productCount with descendants sums",    withDesc.count === 5 + 12 + 3);
  check("productCount carries flag",             withDesc.includes_descendants === true);

  // No-catalog handle yields 0.
  var ctxNoCat = _setup();
  await ctxNoCat.nav.defineCategory({ slug: "outdoors", title: "Outdoors" });
  var zero = await ctxNoCat.nav.productCount({ slug: "outdoors" });
  check("productCount without catalog is 0",     zero.count === 0);

  // popularCategories sorts by count DESC, slug ASC on tie.
  var end = Date.now() + 1000;
  var pop = await ctx.nav.popularCategories({ from: start, to: end, limit: 10 });
  check("popularCategories returns all 4",       pop.length === 4);
  check("popularCategories top is tents (12)",   pop[0].slug === "tents" && pop[0].count === 12);
  check("popularCategories #2 is indoors (8)",   pop[1].slug === "indoors" && pop[1].count === 8);

  // Limit cap honored.
  var top2 = await ctx.nav.popularCategories({ from: start, to: end, limit: 2 });
  check("popularCategories limit=2",             top2.length === 2);

  // Empty window returns [].
  var empty = await ctx.nav.popularCategories({ from: 1, to: 2 });
  check("popularCategories empty window []",     empty.length === 0);

  // Refusals.
  await assert.rejects(ctx.nav.productCount(),                                /input object required/);
  await assert.rejects(ctx.nav.productCount({ slug: "no-such" }),              /not found/);
  await assert.rejects(ctx.nav.popularCategories(),                            /input object required/);
  await assert.rejects(ctx.nav.popularCategories({ from: "x", to: 0 }),        /from/);
  await assert.rejects(ctx.nav.popularCategories({ from: 10, to: 5 }),         /from must be <= to/);
  await assert.rejects(ctx.nav.popularCategories({ from: 0, to: 1, limit: 0 }), /limit/);
}

async function _factoryRefusals() {
  await assert.rejects(async function () {
    categoryNavigation.create({ catalog: "not an object" });
  }, /opts\.catalog/);
}

async function run() {
  await _defineCategoryValidation();
  await _treeShape();
  await _breadcrumbs();
  await _moveCycleDetection();
  await _reorderSiblings();
  await _archiveCascade();
  await _updateSurface();
  await _productCountAndPopular();
  await _factoryRefusals();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/category-navigation.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — category-navigation (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — category-navigation: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
