"use strict";
/**
 * vendors — multi-vendor marketplace registry + per-vendor catalog
 * assignment + payout commission ledger.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0084.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/vendors.js` directly so the gate exists ahead of the entry-
 * point edit.
 *
 * Coverage:
 *   - registerVendor happy path (slug PK / email hashing / status
 *     opens active|paused / phone + address normalisation) +
 *     refusal classes (missing input, bad enums, bad slug shape,
 *     bad bps, terminal status at registration, duplicate slug,
 *     control / zero-width bytes in name / payout_address)
 *   - assignSku UNIQUE — a SKU can be assigned to ONE vendor only;
 *     a second assignment refuses regardless of which vendor is
 *     claiming it. unassign + reassign works.
 *   - vendorForSku reverse lookup + skusForVendor enumeration
 *   - FSM transitions: active <-> paused, active|paused -> archived,
 *     terminal refusal on archived -> *, idempotency refusal on
 *     same-state re-transitions
 *   - recordCommission math (split_bps floor) + idempotency on
 *     (vendor_slug, order_id) + refusal on archived vendor
 *   - payoutsDue aggregation: sum per vendor, sort DESC by amount,
 *     paid + voided exclusion, as_of cutoff respect
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var vendors = require("../../lib/vendors");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0084_vendors.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
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

function _setup() {
  var query = _makeQuery();
  var v     = vendors.create({ query: query });
  return { query: query, vendors: v };
}

function _validRegister(overrides) {
  return Object.assign({
    slug:                 "acme-supply",
    name:                 "Acme Supply Co",
    contact_email:        "ops@acme.example",
    contact_phone:        "+14155550111",
    address:              { street_line1: "1 Market St", city: "SF", country: "US" },
    payout_method:        "bank_transfer",
    payout_address:       "GB29 NWBK 6016 1331 9268 19",
    commission_split_bps: 7000,    // 70% to vendor, 30% to operator
    status:               "active",
  }, overrides || {});
}

async function _registerHappyAndRefusals() {
  var ctx = _setup();
  var v = await ctx.vendors.registerVendor(_validRegister());

  check("registerVendor returns slug PK",            v.slug === "acme-supply");
  check("registerVendor stores name",                v.name === "Acme Supply Co");
  check("registerVendor hashes email (hex sha3-512)",
    typeof v.contact_email_hash === "string" && /^[0-9a-f]{128}$/.test(v.contact_email_hash));
  check("registerVendor does NOT store raw email",   Object.keys(v).indexOf("contact_email") === -1);
  check("registerVendor stores normalised email",    v.contact_email_normalised === "ops@acme.example");
  check("registerVendor stores phone",               v.contact_phone === "+14155550111");
  check("registerVendor hydrates address object",
    v.address && v.address.city === "SF" && v.address.country === "US");
  check("registerVendor stores payout_method",       v.payout_method === "bank_transfer");
  check("registerVendor stores split_bps",           v.commission_split_bps === 7000);
  check("registerVendor opens active",               v.status === "active");
  check("registerVendor opens with paused_at=null",  v.paused_at == null);
  check("registerVendor opens with archived_at=null", v.archived_at == null);
  check("registerVendor stamps created_at",          typeof v.created_at === "number");

  // status='paused' at registration is allowed (operator may want
  // to stage a vendor before activating).
  var pStaged = await ctx.vendors.registerVendor(_validRegister({
    slug:          "staged-vendor",
    contact_email: "staged@acme.example",
    status:        "paused",
  }));
  check("registerVendor opens paused when requested", pStaged.status === "paused");
  check("registerVendor stamps paused_at on paused open",
    typeof pStaged.paused_at === "number");

  // optional phone + address — null when absent.
  var noPhone = await ctx.vendors.registerVendor(_validRegister({
    slug:          "no-phone",
    contact_email: "np@acme.example",
    contact_phone: null,
    address:       null,
  }));
  check("registerVendor allows null phone",          noPhone.contact_phone === null);
  check("registerVendor allows null address",        noPhone.address === null);

  // Email casing normalised on hash key.
  var cased = await ctx.vendors.registerVendor(_validRegister({
    slug:          "cased-email",
    contact_email: "MIXED@Example.COM",
  }));
  check("registerVendor normalises email casing",
    cased.contact_email_normalised === "mixed@example.com");

  // getVendor / vendorBySlug resolve.
  var got = await ctx.vendors.getVendor("acme-supply");
  check("getVendor resolves by slug",                got && got.slug === "acme-supply");
  var alias = await ctx.vendors.vendorBySlug("acme-supply");
  check("vendorBySlug resolves identically",         alias && alias.slug === "acme-supply");
  var miss = await ctx.vendors.getVendor("never-existed");
  check("getVendor unknown -> null",                 miss === null);

  // listVendors default returns all four registered above.
  var listed = await ctx.vendors.listVendors();
  check("listVendors returns all four",              listed.length === 4);
  var listedActive = await ctx.vendors.listVendors({ status: "active" });
  check("listVendors status='active' narrows",
    listedActive.length === 3 && listedActive.every(function (r) { return r.status === "active"; }));
  var listedPaused = await ctx.vendors.listVendors({ status: "paused" });
  check("listVendors status='paused' narrows",
    listedPaused.length === 1 && listedPaused[0].slug === "staged-vendor");

  // ---- refusal classes ----
  await assert.rejects(ctx.vendors.registerVendor(),                                                 /input object required/);
  // duplicate slug
  await assert.rejects(ctx.vendors.registerVendor(_validRegister()),                                 /already registered/);
  // bad slug shape
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({ slug: "Bad_Slug" })),             /slug/);
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({ slug: "-leading-dash" })),        /slug/);
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({ slug: "" })),                     /slug/);
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({ slug: "x".repeat(70) })),          /slug/);
  // bad email
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({ slug: "e1", contact_email: "" })),       /contact_email/);
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({ slug: "e2", contact_email: "not-email" })), /contact_email/);
  // bad payout_method
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "pm1", contact_email: "pm@a.example", payout_method: "btc",
  })), /payout_method/);
  // missing payout_address
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "pa1", contact_email: "pa@a.example", payout_address: "",
  })), /payout_address/);
  // bad split bps
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "bps1", contact_email: "bps1@a.example", commission_split_bps: -1,
  })), /commission_split_bps/);
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "bps2", contact_email: "bps2@a.example", commission_split_bps: 10001,
  })), /commission_split_bps/);
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "bps3", contact_email: "bps3@a.example", commission_split_bps: 1.5,
  })), /commission_split_bps/);
  // status='archived' at registration refused (archive is terminal)
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "arch1", contact_email: "arch@a.example", status: "archived",
  })), /status/);
  // bad status enum
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "s1", contact_email: "s1@a.example", status: "weird",
  })), /status/);
  // control byte in name
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "cb1", contact_email: "cb1@a.example", name: "bad\x01name",
  })), /name/);
  // zero-width in name
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "zw1", contact_email: "zw1@a.example",
    name: "bad" + String.fromCharCode(0x200B) + "name",
  })), /zero-width/);
  // oversize name
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "on1", contact_email: "on1@a.example", name: "x".repeat(201),
  })), /name/);
  // bad phone shape
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "ph1", contact_email: "ph1@a.example", contact_phone: "letters",
  })), /contact_phone/);
  // address must be a plain object, not array
  await assert.rejects(ctx.vendors.registerVendor(_validRegister({
    slug: "ad1", contact_email: "ad1@a.example", address: [1, 2, 3],
  })), /address/);
  // getVendor with bad slug shape refused
  await assert.rejects(ctx.vendors.getVendor(""),                                                    /slug/);
  await assert.rejects(ctx.vendors.getVendor("Bad_Slug"),                                            /slug/);
}

async function _assignSkuUniqueAndLookup() {
  var ctx = _setup();
  var alpha = await ctx.vendors.registerVendor(_validRegister({
    slug: "alpha", contact_email: "alpha@a.example",
  }));
  var beta  = await ctx.vendors.registerVendor(_validRegister({
    slug: "beta", contact_email: "beta@b.example",
  }));

  var assigned = await ctx.vendors.assignSku({
    vendor_slug: alpha.slug, sku: "WDG-PRO-BLK-L",
  });
  check("assignSku returns vendor + sku",           assigned.vendor_slug === alpha.slug && assigned.sku === "WDG-PRO-BLK-L");
  check("assignSku stamps assigned_at",             typeof assigned.assigned_at === "number");

  // Second assign for the SAME (vendor, sku) refuses.
  await assert.rejects(ctx.vendors.assignSku({
    vendor_slug: alpha.slug, sku: "WDG-PRO-BLK-L",
  }), /already assigned/);

  // A DIFFERENT vendor claiming the same SKU also refuses — UNIQUE
  // on `sku` is the operator-marketplace invariant.
  await assert.rejects(ctx.vendors.assignSku({
    vendor_slug: beta.slug, sku: "WDG-PRO-BLK-L",
  }), /already assigned/);

  // vendorForSku resolves the assignment.
  var owner = await ctx.vendors.vendorForSku("WDG-PRO-BLK-L");
  check("vendorForSku resolves owner",              owner && owner.slug === alpha.slug);

  // Unassigned SKU -> null.
  var noOwner = await ctx.vendors.vendorForSku("UNASSIGNED-SKU");
  check("vendorForSku unassigned -> null",          noOwner === null);

  // skusForVendor returns the alpha list, empty for beta.
  await ctx.vendors.assignSku({ vendor_slug: alpha.slug, sku: "WDG-PRO-RED-L" });
  var alphaSkus = await ctx.vendors.skusForVendor(alpha.slug);
  check("skusForVendor returns alpha's two SKUs",   alphaSkus.length === 2);
  // Both assigns land in the same millisecond, so the secondary
  // (sku ASC) sort decides order; assert both SKUs are present
  // rather than depending on assigned_at micro-ordering.
  var alphaSkuNames = alphaSkus.map(function (r) { return r.sku; }).sort();
  check("skusForVendor enumerates both",
    alphaSkuNames[0] === "WDG-PRO-BLK-L" && alphaSkuNames[1] === "WDG-PRO-RED-L");
  var betaSkus  = await ctx.vendors.skusForVendor(beta.slug);
  check("skusForVendor empty for unassigned vendor", betaSkus.length === 0);

  // Unassign + reassign to a different vendor works.
  var removed = await ctx.vendors.unassignSku({
    vendor_slug: alpha.slug, sku: "WDG-PRO-BLK-L",
  });
  check("unassignSku returns true on hit",          removed === true);
  var orphan = await ctx.vendors.vendorForSku("WDG-PRO-BLK-L");
  check("vendorForSku after unassign -> null",      orphan === null);
  var reassigned = await ctx.vendors.assignSku({
    vendor_slug: beta.slug, sku: "WDG-PRO-BLK-L",
  });
  check("reassign after unassign works",            reassigned.vendor_slug === beta.slug);

  // Unassign a SKU that doesn't belong to this vendor — false, no
  // mutation. (alpha still owns WDG-PRO-RED-L; beta tries to
  // unassign it and gets false back.)
  var noop = await ctx.vendors.unassignSku({
    vendor_slug: beta.slug, sku: "WDG-PRO-RED-L",
  });
  check("unassignSku wrong owner -> false",         noop === false);
  // Confirm alpha still owns the SKU.
  var still = await ctx.vendors.vendorForSku("WDG-PRO-RED-L");
  check("wrong-owner unassign left assignment alone", still && still.slug === alpha.slug);

  // Unassign a never-assigned SKU -> false (idempotent no-op).
  var nullUnassign = await ctx.vendors.unassignSku({
    vendor_slug: alpha.slug, sku: "NEVER-EXISTED",
  });
  check("unassignSku unknown sku -> false",         nullUnassign === false);

  // Refusal classes.
  await assert.rejects(ctx.vendors.assignSku(),                                       /input object required/);
  await assert.rejects(ctx.vendors.assignSku({
    vendor_slug: "ghost-vendor", sku: "ANY-SKU",
  }), /vendor not found/);
  await assert.rejects(ctx.vendors.assignSku({
    vendor_slug: alpha.slug, sku: "",
  }), /sku/);
  await assert.rejects(ctx.vendors.assignSku({
    vendor_slug: alpha.slug, sku: "bad sku with space",
  }), /sku/);
  await assert.rejects(ctx.vendors.unassignSku(),                                     /input object required/);
  await assert.rejects(ctx.vendors.vendorForSku(""),                                  /sku/);
}

async function _fsmTransitions() {
  var ctx = _setup();
  var v = await ctx.vendors.registerVendor(_validRegister({
    slug: "fsm", contact_email: "fsm@a.example",
  }));
  check("fsm opens active",                          v.status === "active");

  // active -> paused
  var paused = await ctx.vendors.pauseVendor("fsm");
  check("pauseVendor sets status=paused",           paused.status === "paused");
  check("pauseVendor stamps paused_at",             typeof paused.paused_at === "number");

  // paused -> paused refused (idempotency hazard)
  await assert.rejects(ctx.vendors.pauseVendor("fsm"), /already paused/);

  // paused -> active
  var reinstated = await ctx.vendors.reinstateVendor("fsm");
  check("reinstateVendor sets status=active",       reinstated.status === "active");
  check("reinstateVendor clears paused_at",         reinstated.paused_at == null);

  // active -> active refused
  await assert.rejects(ctx.vendors.reinstateVendor("fsm"), /already active/);

  // active -> archived (terminal)
  var archived = await ctx.vendors.archiveVendor("fsm");
  check("archiveVendor sets status=archived",       archived.status === "archived");
  check("archiveVendor stamps archived_at",         typeof archived.archived_at === "number");

  // archived -> * all refused
  await assert.rejects(ctx.vendors.archiveVendor("fsm"),     /already archived/);
  await assert.rejects(ctx.vendors.pauseVendor("fsm"),       /archived/);
  await assert.rejects(ctx.vendors.reinstateVendor("fsm"),   /archived/);
  await assert.rejects(ctx.vendors.updateVendor("fsm", { name: "Renamed" }), /archived/);
  await assert.rejects(ctx.vendors.assignSku({
    vendor_slug: "fsm", sku: "NEW-SKU",
  }), /archived/);
  await assert.rejects(ctx.vendors.recordCommission({
    vendor_slug: "fsm", order_id: "order-1", gross_minor: 1000, currency: "USD",
  }), /archived/);

  // Pause/reinstate/archive on unknown -> null (no throw).
  var nullPause = await ctx.vendors.pauseVendor("never-existed");
  check("pauseVendor unknown -> null",              nullPause === null);
  var nullReinstate = await ctx.vendors.reinstateVendor("never-existed");
  check("reinstateVendor unknown -> null",          nullReinstate === null);
  var nullArchive = await ctx.vendors.archiveVendor("never-existed");
  check("archiveVendor unknown -> null",            nullArchive === null);

  // Direct path: register a vendor in 'paused' status and archive
  // it directly (paused -> archived legal).
  await ctx.vendors.registerVendor(_validRegister({
    slug: "paused-then-archived", contact_email: "pa@a.example", status: "paused",
  }));
  var archP = await ctx.vendors.archiveVendor("paused-then-archived");
  check("paused -> archived works",                 archP.status === "archived");
}

async function _updateAndImmutability() {
  var ctx = _setup();
  var v = await ctx.vendors.registerVendor(_validRegister({
    slug: "upd", contact_email: "upd@a.example",
  }));

  var patched = await ctx.vendors.updateVendor("upd", {
    name:                  "Renamed Co",
    commission_split_bps:  5000,
    contact_phone:         "+12025550199",
  });
  check("updateVendor patches name",                patched.name === "Renamed Co");
  check("updateVendor patches split_bps",           patched.commission_split_bps === 5000);
  check("updateVendor patches phone",               patched.contact_phone === "+12025550199");
  check("updateVendor preserves slug",              patched.slug === v.slug);
  check("updateVendor preserves email_hash",        patched.contact_email_hash === v.contact_email_hash);
  check("updateVendor bumps updated_at",            patched.updated_at >= v.updated_at);

  // Patch address to null.
  var nulled = await ctx.vendors.updateVendor("upd", { address: null });
  check("updateVendor clears address",              nulled.address === null);

  // Unknown columns refused.
  await assert.rejects(ctx.vendors.updateVendor("upd", { slug: "newslug" }),                    /not updatable/);
  await assert.rejects(ctx.vendors.updateVendor("upd", { contact_email: "new@a.example" }),     /not updatable/);
  await assert.rejects(ctx.vendors.updateVendor("upd", { contact_email_hash: "xxx" }),          /not updatable/);
  await assert.rejects(ctx.vendors.updateVendor("upd", { status: "archived" }),                 /not updatable/);

  // Empty patch refused.
  await assert.rejects(ctx.vendors.updateVendor("upd", {}),                                     /at least one column/);

  // Unknown slug -> null.
  var noop = await ctx.vendors.updateVendor("never-existed", { name: "x" });
  check("updateVendor unknown -> null",             noop === null);

  // Bad input.
  await assert.rejects(ctx.vendors.updateVendor("upd"),                                         /patch object required/);
  await assert.rejects(ctx.vendors.updateVendor("upd", { commission_split_bps: -1 }),           /commission_split_bps/);
}

async function _recordCommissionMath() {
  var ctx = _setup();
  // Two vendors, different splits.
  var v70 = await ctx.vendors.registerVendor(_validRegister({
    slug: "v70", contact_email: "v70@a.example", commission_split_bps: 7000,
  }));
  var v100 = await ctx.vendors.registerVendor(_validRegister({
    slug: "v100", contact_email: "v100@a.example", commission_split_bps: 10000,
  }));
  var v0 = await ctx.vendors.registerVendor(_validRegister({
    slug: "v0", contact_email: "v0@a.example", commission_split_bps: 0,
  }));

  // 70% of 10000 = 7000.
  var c1 = await ctx.vendors.recordCommission({
    vendor_slug: v70.slug, order_id: "order-1", gross_minor: 10000, currency: "USD",
  });
  check("recordCommission split=70% exact",         Number(c1.commission_minor) === 7000);
  check("recordCommission preserves gross",         Number(c1.gross_minor) === 10000);
  check("recordCommission status starts pending",   c1.status === "pending");
  check("recordCommission stores currency",         c1.currency === "USD");
  check("recordCommission stamps vendor_slug",      c1.vendor_slug === v70.slug);

  // Floor — 7000 bps * 12345 / 10000 = 8641.5 -> 8641.
  var c2 = await ctx.vendors.recordCommission({
    vendor_slug: v70.slug, order_id: "order-2", gross_minor: 12345, currency: "USD",
  });
  check("recordCommission floors sub-cent dust",    Number(c2.commission_minor) === 8641);

  // 100% pays full gross.
  var c3 = await ctx.vendors.recordCommission({
    vendor_slug: v100.slug, order_id: "order-3", gross_minor: 1500, currency: "USD",
  });
  check("recordCommission split=100% pays full",    Number(c3.commission_minor) === 1500);

  // 0% pays nothing (legal — operator keeps everything).
  var c4 = await ctx.vendors.recordCommission({
    vendor_slug: v0.slug, order_id: "order-4", gross_minor: 9999, currency: "USD",
  });
  check("recordCommission split=0% pays zero",      Number(c4.commission_minor) === 0);

  // gross_minor=0 -> commission_minor=0 even at 100%.
  var c5 = await ctx.vendors.recordCommission({
    vendor_slug: v100.slug, order_id: "order-5", gross_minor: 0, currency: "USD",
  });
  check("recordCommission zero-gross -> zero",      Number(c5.commission_minor) === 0);

  // Idempotency: second call for (vendor, order) returns existing row.
  var dup = await ctx.vendors.recordCommission({
    vendor_slug: v70.slug, order_id: "order-1", gross_minor: 99999, currency: "EUR",
  });
  check("recordCommission idempotent (vendor, order)", dup.id === c1.id);
  check("recordCommission idempotent preserves first values",
    Number(dup.gross_minor) === 10000 && dup.currency === "USD");

  // Same order_id on a DIFFERENT vendor is allowed — the UNIQUE
  // index is on (vendor_slug, order_id), so two vendors can each
  // claim a commission against the same multi-vendor order.
  var multi = await ctx.vendors.recordCommission({
    vendor_slug: v100.slug, order_id: "order-1", gross_minor: 5000, currency: "USD",
  });
  check("recordCommission per-vendor on shared order",
    multi.vendor_slug === v100.slug && Number(multi.commission_minor) === 5000);

  // Refusals.
  await assert.rejects(ctx.vendors.recordCommission(),                                                            /input object required/);
  await assert.rejects(ctx.vendors.recordCommission({
    vendor_slug: "ghost-vendor", order_id: "o", gross_minor: 100, currency: "USD",
  }), /vendor not found/);
  await assert.rejects(ctx.vendors.recordCommission({
    vendor_slug: v70.slug, order_id: "", gross_minor: 100, currency: "USD",
  }), /order_id/);
  await assert.rejects(ctx.vendors.recordCommission({
    vendor_slug: v70.slug, order_id: "ok", gross_minor: -1, currency: "USD",
  }), /gross_minor/);
  await assert.rejects(ctx.vendors.recordCommission({
    vendor_slug: v70.slug, order_id: "ok", gross_minor: 100, currency: "usd",
  }), /currency/);
  await assert.rejects(ctx.vendors.recordCommission({
    vendor_slug: v70.slug, order_id: "ok", gross_minor: 100, currency: "USD", occurred_at: -1,
  }), /occurred_at/);
}

async function _payoutsDueAggregation() {
  var ctx = _setup();
  // a (big), b (small), c (paid only), d (voided only — but we
  // can't transition to 'voided' through the v1 surface here, so
  // mutate the row directly via the query handle for test
  // purposes only).
  var a = await ctx.vendors.registerVendor(_validRegister({
    slug: "a-vendor", contact_email: "a@a.example", commission_split_bps: 10000,
  }));
  var b = await ctx.vendors.registerVendor(_validRegister({
    slug: "b-vendor", contact_email: "b@a.example", commission_split_bps: 10000,
  }));
  var c = await ctx.vendors.registerVendor(_validRegister({
    slug: "c-vendor", contact_email: "c@a.example", commission_split_bps: 10000,
  }));

  var now = Date.now();
  // a: 3 pending commissions of 500 each = 1500.
  for (var i = 0; i < 3; i += 1) {
    await ctx.vendors.recordCommission({
      vendor_slug: a.slug, order_id: "a-order-" + i, gross_minor: 500, currency: "USD",
      occurred_at: now - 10000,
    });
  }
  // b: 1 pending commission of 100.
  await ctx.vendors.recordCommission({
    vendor_slug: b.slug, order_id: "b-order-0", gross_minor: 100, currency: "USD",
    occurred_at: now - 10000,
  });
  // c: 1 commission marked paid out-of-band (the operator-side
  // settlement pipeline owns the pending -> paid transition; this
  // test exercises payoutsDue's filter, not the transition itself).
  await ctx.vendors.recordCommission({
    vendor_slug: c.slug, order_id: "c-order-0", gross_minor: 700, currency: "USD",
    occurred_at: now - 10000,
  });
  await ctx.query(
    "UPDATE vendor_commissions SET status = 'paid', paid_at = ?1, payout_reference = ?2 " +
    "WHERE vendor_slug = ?3 AND order_id = ?4",
    [now, "wire-c-0", c.slug, "c-order-0"],
  );
  // c also has a voided row.
  await ctx.vendors.recordCommission({
    vendor_slug: c.slug, order_id: "c-order-1", gross_minor: 600, currency: "USD",
    occurred_at: now - 10000,
  });
  await ctx.query(
    "UPDATE vendor_commissions SET status = 'voided' WHERE vendor_slug = ?1 AND order_id = ?2",
    [c.slug, "c-order-1"],
  );
  // a: one commission AFTER as_of — excluded from the bucket.
  await ctx.vendors.recordCommission({
    vendor_slug: a.slug, order_id: "a-future", gross_minor: 9999, currency: "USD",
    occurred_at: now + 100000,
  });

  var due = await ctx.vendors.payoutsDue({ as_of: now });
  check("payoutsDue returns 2 vendors (a + b)",     due.length === 2);
  check("payoutsDue sorted by pending_minor DESC",  due[0].vendor_slug === a.slug && due[1].vendor_slug === b.slug);
  check("payoutsDue sums a correctly",              due[0].pending_minor === 1500);
  check("payoutsDue counts a's rows",               due[0].commission_count === 3);
  check("payoutsDue sums b correctly",              due[1].pending_minor === 100);
  check("payoutsDue excludes paid + voided",
    due.every(function (r) { return r.vendor_slug !== c.slug; }));

  // as_of in the deep past -> empty.
  var empty = await ctx.vendors.payoutsDue({ as_of: 0 });
  check("payoutsDue past-only as_of -> empty",      empty.length === 0);

  // as_of in the future picks up the future row too.
  var future = await ctx.vendors.payoutsDue({ as_of: now + 200000 });
  check("payoutsDue future as_of picks up future row",
    future[0].vendor_slug === a.slug && future[0].pending_minor === 1500 + 9999);

  // Refusals.
  await assert.rejects(ctx.vendors.payoutsDue(),                              /input object required/);
  await assert.rejects(ctx.vendors.payoutsDue({ as_of: "x" }),                /as_of/);
  await assert.rejects(ctx.vendors.payoutsDue({ as_of: -1 }),                 /as_of/);
}

async function _bShopHandleNotYetWired() {
  // The primitive isn't surfaced on the entry-point yet — this test
  // file is the gate that exists BEFORE the lib/index.js edit. The
  // assertion is a smoke that the framework handle the primitive
  // composes against IS available (so the primitive's lazy require
  // resolves at runtime).
  check("bShop.framework exposes namespaceHash",
    typeof bShop.framework.crypto.namespaceHash === "function");
  check("bShop.framework exposes guardEmail",
    bShop.framework.guardEmail && typeof bShop.framework.guardEmail.validate === "function");
  check("bShop.framework exposes uuid.v7",
    typeof bShop.framework.uuid.v7 === "function");
}

// Prod-redaction race regression: registerVendor's pre-check can MISS a
// concurrent registration of the same slug, so the INSERT collides on the slug
// PRIMARY KEY. Production redacts that to a bare "HTTP 500", so a message regex
// would be blind — the wrapped INSERT re-reads by slug and surfaces the typed
// VENDOR_SLUG_TAKEN instead of leaking the 500. Simulate the race: the first
// slug pre-check returns empty (the competing insert hadn't landed when we
// probed), the INSERT then collides and is redacted, and the post-error
// re-read finds the winning row.
async function _registerVendorRaceUnderRedactedError() {
  var base = _makeQuery();
  // The winning concurrent registration (already in the table).
  await vendors.create({ query: base }).registerVendor(_validRegister());

  var precheckMissed = false;
  var racing = async function (sql, params) {
    if (/SELECT[\s\S]*FROM vendors WHERE slug/i.test(sql) && !precheckMissed) {
      precheckMissed = true;                 // pre-check probes before the race resolves → miss
      return { rows: [], rowCount: 0 };
    }
    try { return await base(sql, params); }
    catch (_e) { throw new Error("HTTP 500"); }   // redact the slug-PK collision, like prod
  };
  var v = vendors.create({ query: racing });
  await assert.rejects(
    v.registerVendor(_validRegister({ name: "Acme Two" })),
    function (e) { return e && e.code === "VENDOR_SLUG_TAKEN"; });
}

// Prod-redaction regression — assignSku. assignSku PRE-CHECKS the sku and
// throws VENDOR_SKU_TAKEN before the INSERT, so to reach the INSERT/catch path
// (where the fix lives) the pre-check must MISS — the concurrent-assign race.
// Force the SECOND assign's sku pre-check to miss, redact the INSERT collision,
// and let the catch's re-read surface the typed duplicate.
async function _assignSkuDuplicateUnderRedactedError() {
  var base = _makeQuery();
  var skuSelects = 0;
  var q = async function (sql, params) {
    if (/SELECT vendor_slug FROM vendor_skus WHERE sku/i.test(sql)) {
      skuSelects += 1;
      if (skuSelects === 2) return { rows: [], rowCount: 0 };   // 2nd assign's pre-check → forced race miss
      return base(sql, params);
    }
    try { return await base(sql, params); }
    catch (_e) { throw new Error("HTTP 500"); }                 // redact the sku-UNIQUE collision, like prod
  };
  var v = vendors.create({ query: q });
  await v.registerVendor(_validRegister({ slug: "alpha", contact_email: "alpha@a.example" }));
  await v.assignSku({ vendor_slug: "alpha", sku: "SKU-RACE-1" });
  await assert.rejects(
    v.assignSku({ vendor_slug: "alpha", sku: "SKU-RACE-1" }),
    function (e) { return e && e.code === "VENDOR_SKU_TAKEN"; });
  check("redacted sku-dup: the pre-check miss + INSERT + catch re-read all ran", skuSelects === 3);
}

async function run() {
  await _registerHappyAndRefusals();
  await _registerVendorRaceUnderRedactedError();
  await _assignSkuUniqueAndLookup();
  await _assignSkuDuplicateUnderRedactedError();
  await _fsmTransitions();
  await _updateAndImmutability();
  await _recordCommissionMath();
  await _payoutsDueAggregation();
  await _bShopHandleNotYetWired();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/vendors.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - vendors (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
