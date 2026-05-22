"use strict";
/**
 * reviews — operator-moderated product ratings.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001_catalog.sql (products FK) + 0011_reviews.sql.
 *
 * Coverage:
 *   - submit: persists pending row for the customer_id branch
 *   - submit: persists pending row for the customer_email branch,
 *             hashes via namespaceHash("review-customer", lowered),
 *             never stores the raw address
 *   - submit: same email at different casing collapses to one hash
 *   - submit: customer_id and customer_email hash to different values
 *             (no namespace collision)
 *   - submit: rejects missing product_id, missing-both-ids, bad rating,
 *             empty title, oversize title, oversize body, control-byte
 *             title, control-byte body
 *   - publish: pending → published, updated_at moves, REVIEW_NOT_FOUND
 *             on miss
 *   - reject: pending → rejected, reason length cap enforced, control
 *             bytes refused, REVIEW_NOT_FOUND on miss
 *   - listForProduct: defaults to published-only, omits pending /
 *                     rejected, returns newest-first
 *   - listForProduct: cursor pagination round-trips; tampered cursor
 *                     refused
 *   - summaryForProduct: 3 published reviews → count, avg_rating,
 *                       distribution all correct; pending excluded
 *   - byCustomer: customer_id_hash lookup recovers every review the
 *                customer authored
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0011_reviews.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _validUUID() { return bShop.framework.uuid.v7(); }

// Seed a single product row so reviews can attach to it without
// dragging in the full catalog primitive surface. The reviews
// primitive validates the product_id shape but doesn't enforce the
// FK at the application layer — the DB does, with foreign_keys=ON.
async function _seedProduct(query, opts) {
  opts = opts || {};
  var id = opts.id || _validUUID();
  var ts = Date.now();
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)",
    [id, opts.slug || "p-" + id.slice(0, 8), opts.title || "Test Product", "", ts],
  );
  return id;
}

async function _setup() {
  var query = _makeQuery();
  var productId = await _seedProduct(query);
  var reviews   = bShop.reviews.create({
    query:        query,
    cursorSecret: "reviews-test-secret",
  });
  return { query: query, productId: productId, reviews: reviews };
}

async function _submitWithCustomerId() {
  var ctx = await _setup();
  var customerId = _validUUID();
  var r = await ctx.reviews.submit({
    product_id:        ctx.productId,
    customer_id:       customerId,
    rating:            5,
    title:             "Excellent",
    body:              "Loved it.",
    verified_purchase: 1,
  });
  check("submit returns id + status pending",     r.id && r.status === "pending");
  check("submit returns 36-char uuid",             r.id.length === 36);

  var row = await ctx.reviews.get(r.id);
  check("submit persists row",                     row && row.id === r.id);
  check("submit stores customer_id alongside hash", row.customer_id === customerId);
  check("submit derives customer_id_hash",          /^[0-9a-f]{128}$/.test(row.customer_id_hash));
  check("submit stamps status pending",             row.status === "pending");
  check("submit stamps verified_purchase",          row.verified_purchase === 1);
  check("submit stamps created_at == updated_at",   row.created_at === row.updated_at);

  // hashCustomerId helper matches the same hash the primitive stored.
  check("hashCustomerId matches stored hash",       ctx.reviews.hashCustomerId(customerId) === row.customer_id_hash);
}

async function _submitWithCustomerEmail() {
  var ctx = await _setup();
  var r = await ctx.reviews.submit({
    product_id:     ctx.productId,
    customer_email: "Alice@Example.COM",
    rating:         4,
    title:          "Nice",
    body:           "",
  });
  var row = await ctx.reviews.get(r.id);
  check("email branch leaves customer_id NULL",    row.customer_id == null);
  check("email branch stores hash, not raw",       row.customer_id_hash && row.customer_id_hash.indexOf("alice") === -1);

  // Casing-variant of the same address collapses to the same hash.
  var r2 = await ctx.reviews.submit({
    product_id:     ctx.productId,
    customer_email: "alice@example.com",
    rating:         3,
    title:          "Also Nice",
  });
  var row2 = await ctx.reviews.get(r2.id);
  check("email casing variants share hash",        row2.customer_id_hash === row.customer_id_hash);

  // hashCustomerEmail helper matches the same hash.
  check("hashCustomerEmail matches stored hash",   ctx.reviews.hashCustomerEmail("alice@example.com") === row.customer_id_hash);

  // customer_id and customer_email branches MUST NOT collide for
  // any given UUID/email pair — same namespace, different inputs.
  var distinctId   = _validUUID();
  var distinctHash = ctx.reviews.hashCustomerId(distinctId);
  check("id-hash != email-hash for distinct inputs", distinctHash !== row.customer_id_hash);
}

async function _submitValidation() {
  var ctx = await _setup();
  await assert.rejects(ctx.reviews.submit(),                                  /input object required/);
  await assert.rejects(ctx.reviews.submit({}),                                 /product_id/);
  await assert.rejects(ctx.reviews.submit({ product_id: "not-a-uuid" }),       /product_id/);
  // Missing both customer_id and customer_email
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, rating: 4, title: "x",
  }), /customer_id or customer_email/);
  // Bad rating shapes
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 0, title: "x",
  }), /rating/);
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 6, title: "x",
  }), /rating/);
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 4.5, title: "x",
  }), /rating/);
  // Empty title
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 4, title: "",
  }), /title/);
  // Oversize title (> 120)
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 4,
    title: "x".repeat(121),
  }), /title/);
  // Control byte in title
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 4,
    title: "ok\x00bad",
  }), /title/);
  // Oversize body (> 4000)
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 4,
    title: "ok", body: "y".repeat(4001),
  }), /body/);
  // Control byte in body
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "a@example.com", rating: 4,
    title: "ok", body: "still\x00bad",
  }), /body/);
  // Bad customer_id shape
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_id: "not-a-uuid", rating: 4, title: "x",
  }), /customer_id/);
  // Bad email shape
  await assert.rejects(ctx.reviews.submit({
    product_id: ctx.productId, customer_email: "not-an-email", rating: 4, title: "x",
  }), /customer_email/);
}

async function _publishAndReject() {
  var ctx = await _setup();
  var submitted = await ctx.reviews.submit({
    product_id:     ctx.productId,
    customer_email: "pub@example.com",
    rating:         5,
    title:          "Top",
  });
  var published = await ctx.reviews.publish(submitted.id);
  check("publish flips status",                published.status === "published");
  check("publish bumps updated_at",            published.updated_at >= published.created_at);

  // reject another row
  var s2 = await ctx.reviews.submit({
    product_id:     ctx.productId,
    customer_email: "rej@example.com",
    rating:         1,
    title:          "Spam",
  });
  var rejected = await ctx.reviews.reject(s2.id, "spam");
  check("reject flips status",                 rejected.status === "rejected");

  // reason length cap + control-byte refusal
  var s3 = await ctx.reviews.submit({
    product_id:     ctx.productId,
    customer_email: "rej2@example.com",
    rating:         1,
    title:          "X",
  });
  await assert.rejects(ctx.reviews.reject(s3.id, "z".repeat(501)),  /reason/);
  await assert.rejects(ctx.reviews.reject(s3.id, "bad\x01reason"),  /reason/);
  await assert.rejects(ctx.reviews.reject(s3.id, 12345),             /reason/);

  // Not-found surface on both publish + reject
  var missingId = _validUUID();
  await assert.rejects(ctx.reviews.publish(missingId),               /not found/);
  await assert.rejects(ctx.reviews.reject(missingId),                /not found/);

  // Bad id shape
  await assert.rejects(ctx.reviews.publish("not-a-uuid"),            /review id/);
  await assert.rejects(ctx.reviews.reject("not-a-uuid"),             /review id/);
}

async function _listAndSummary() {
  var ctx = await _setup();
  // Submit three reviews + publish them.
  var ids = [];
  var ratings = [5, 4, 3];
  for (var i = 0; i < ratings.length; i += 1) {
    var s = await ctx.reviews.submit({
      product_id:     ctx.productId,
      customer_email: "buyer" + i + "@example.com",
      rating:         ratings[i],
      title:          "R" + i,
    });
    await ctx.reviews.publish(s.id);
    ids.push(s.id);
    // Force created_at separation so the (created_at DESC, id DESC)
    // ordering is deterministic for the cursor assertion below.
    await new Promise(function (r) { setTimeout(r, 2); });   // allow:test-promise-settimeout-sleep — minimum-distinct-ts seed, not a sleep-as-wait
  }
  // Plus one pending review — must NOT surface in the default list
  // or the summary.
  await ctx.reviews.submit({
    product_id:     ctx.productId,
    customer_email: "pending@example.com",
    rating:         1,
    title:          "Hold on",
  });

  var listed = await ctx.reviews.listForProduct(ctx.productId);
  check("list returns 3 published rows",          listed.rows.length === 3);
  check("list excludes pending row",              listed.rows.every(function (r) { return r.status === "published"; }));
  // Newest-first ordering — last-submitted lands first.
  check("list newest-first",                      listed.rows[0].id === ids[ids.length - 1]);

  var summary = await ctx.reviews.summaryForProduct(ctx.productId);
  check("summary counts published only",          summary.count === 3);
  check("summary average correct",                Math.abs(summary.avg_rating - 4) < 1e-9);
  check("summary distribution 5-star bucket",     summary.distribution[5] === 1);
  check("summary distribution 4-star bucket",     summary.distribution[4] === 1);
  check("summary distribution 3-star bucket",     summary.distribution[3] === 1);
  check("summary distribution 1-star excluded",   summary.distribution[1] === 0);

  // Cursor pagination — pull page of 2, then resume with the cursor.
  var page1 = await ctx.reviews.listForProduct(ctx.productId, { limit: 2 });
  check("page1 returns 2 rows",                   page1.rows.length === 2);
  check("page1 cursor present",                   typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await ctx.reviews.listForProduct(ctx.productId, { limit: 2, cursor: page1.next_cursor });
  check("page2 returns the remaining row",        page2.rows.length === 1);
  check("page2 no further cursor",                page2.next_cursor === null);
  check("page2 disjoint from page1",              page1.rows.every(function (r) { return r.id !== page2.rows[0].id; }));

  // Tampered cursor refused.
  await assert.rejects(
    ctx.reviews.listForProduct(ctx.productId, { cursor: page1.next_cursor + "x" }),
    /cursor/,
  );
  // Bad status filter refused.
  await assert.rejects(
    ctx.reviews.listForProduct(ctx.productId, { status: "bogus" }),
    /status/,
  );
  // Bad limit refused.
  await assert.rejects(
    ctx.reviews.listForProduct(ctx.productId, { limit: 0 }),
    /limit/,
  );

  // Summary on empty product → count 0, avg 0, distribution all 0.
  var emptyProduct = await _seedProduct(ctx.query, { slug: "empty-p" });
  var emptySum = await ctx.reviews.summaryForProduct(emptyProduct);
  check("empty summary count 0",                  emptySum.count === 0);
  check("empty summary avg 0",                    emptySum.avg_rating === 0);
  check("empty summary all buckets 0",            [1, 2, 3, 4, 5].every(function (k) { return emptySum.distribution[k] === 0; }));
}

async function _byCustomer() {
  var ctx = await _setup();
  var customerId = _validUUID();
  // Customer submits two reviews on the same product (different
  // products would work too — the hash-keyed read doesn't care).
  var second = await _seedProduct(ctx.query, { slug: "p-second" });
  var s1 = await ctx.reviews.submit({
    product_id:  ctx.productId,
    customer_id: customerId,
    rating:      5,
    title:       "First",
  });
  await new Promise(function (r) { setTimeout(r, 2); });   // allow:test-promise-settimeout-sleep — minimum-distinct-ts seed, not a sleep-as-wait
  var s2 = await ctx.reviews.submit({
    product_id:  second,
    customer_id: customerId,
    rating:      4,
    title:       "Second",
  });
  var hash = ctx.reviews.hashCustomerId(customerId);
  var listed = await ctx.reviews.byCustomer(hash);
  check("byCustomer returns both reviews",         listed.rows.length === 2);
  check("byCustomer newest-first",                 listed.rows[0].id === s2.id && listed.rows[1].id === s1.id);

  // Unknown hash → empty rows
  var miss = await ctx.reviews.byCustomer("0".repeat(128));
  check("byCustomer miss returns empty rows",      miss.rows.length === 0);

  // Validation: bad inputs
  await assert.rejects(ctx.reviews.byCustomer(""),       /customer_id_hash/);
  await assert.rejects(ctx.reviews.byCustomer(null),     /customer_id_hash/);
  await assert.rejects(ctx.reviews.byCustomer(hash, { limit: -1 }), /limit/);
}

async function run() {
  await _submitWithCustomerId();
  await _submitWithCustomerEmail();
  await _submitValidation();
  await _publishAndReject();
  await _listAndSummary();
  await _byCustomer();
}

module.exports = { run: run };
