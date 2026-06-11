"use strict";
/**
 * customerSegments — RFM-style operator-defined customer groupings.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations 0003
 * (orders) + 0023 (returns, referenced by the orders FK shape) + 0049
 * (customer_segments). Every CHECK / UNIQUE in the shipped schema is
 * exercised against seeded orders.
 *
 * Coverage:
 *   - defineSegment: persists slug + title + description + rules,
 *     rejects unknown rule keys, rejects duplicate slug
 *   - rule composition: ANDed predicates — VIP (recency_days_max +
 *     monetary_minor_min + frequency_orders_min), lapsed (recency
 *     min), high-refund (refund_rate_bps_min), country-gated
 *   - evaluate: returns matching customer_ids from the membership
 *     cache; archived segments return empty
 *   - evaluate cursor: HMAC-tagged pagination, tamper-refused
 *   - recompute: rewrites cache, handles repeated runs idempotently,
 *     honors slug filter, archived segments skipped
 *   - segmentsForCustomer: returns the active segments a customer
 *     sits in, omits archived
 *   - update: rule replacement re-evaluates on next recompute; title
 *     / description partial patches
 *   - archive / unarchive: clears + restores cache; evaluate empty
 *     while archived
 *   - stats: member_count + avg_lifetime_minor + last_recomputed_at
 *   - refusals: missing input, bad slug shape, unknown rule key, bad
 *     country / status enum, min > max coherence
 *   - production guards cursorSecret
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var customerSegments = require("../../lib/customer-segments");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG_CART      = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");
var MIG_ORDER     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0003_order.sql");
var MIG_ORDER_PROVIDER = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0950_orders_payment_provider.sql");
var MIG_ORDER_CAPTURE  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0951_orders_paypal_capture_id.sql");
var MIG_CUSTOMERS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0006_customers.sql");
var MIG_SEGMENTS  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0049_customer_segments.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  // Cart migration first — orders FKs cart_id back to carts. Customers
  // table is needed by the members-CSV export (LEFT JOIN for display_name).
  [MIG_CART, MIG_ORDER, MIG_ORDER_PROVIDER, MIG_ORDER_CAPTURE, MIG_CUSTOMERS, MIG_SEGMENTS].forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
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

function _uuid() { return bShop.framework.uuid.v7(); }

// Seed a cart row so an orders.cart_id FK has a target. Status
// 'converted' since the order moves the cart to that terminal state;
// expires_at far in the future is fine for test fixtures.
async function _seedCart(query, sessionId) {
  var id = _uuid();
  var ts = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, 'USD', 'converted', ?3, ?3, ?4)",
    [id, sessionId, ts, ts + 365 * 24 * 60 * 60 * 1000],
  );
  return id;
}

// Insert an orders row with explicit overrides. The shape mirrors
// what the order primitive would write — every NOT NULL column gets
// a value; minor amounts default to 0 unless the caller overrides.
async function _seedOrder(query, opts) {
  var cartId = await _seedCart(query, "sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x"));        // allow:math-random — test fixture session id
  var id = _uuid();
  var status   = opts.status   || "paid";
  var currency = opts.currency || "USD";
  var grand    = opts.grand_total_minor == null ? 10000 : opts.grand_total_minor;
  var country  = opts.country  || "US";
  var createdAt = opts.created_at == null ? Date.now() : opts.created_at;
  var shipTo = JSON.stringify({ country: country });
  await query(
    "INSERT INTO orders " +
    "(id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    " discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    " payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, ?8, NULL, ?9, ?10, ?10)",
    [id, cartId, opts.customer_id, "sess_" + id.slice(0, 8), status, currency, grand, grand, shipTo, createdAt],
  );
  return id;
}

var DAY_MS = 24 * 60 * 60 * 1000;

// ---- tests --------------------------------------------------------------

async function _defineAndDuplicate() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query });

  var s = await seg.defineSegment({
    slug:        "vip",
    title:       "VIP buyers",
    description: "Frequent + high-value",
    rules: { recency_days_max: 30, monetary_minor_min: 50000, frequency_orders_min: 3 },
  });
  check("defineSegment: returns slug",         s.slug === "vip");
  check("defineSegment: returns title",        s.title === "VIP buyers");
  check("defineSegment: description preserved", s.description === "Frequent + high-value");
  check("defineSegment: rules hydrated",       s.rules.monetary_minor_min === 50000);
  check("defineSegment: not archived",         s.archived_at == null);
  check("defineSegment: zero members at define", s.last_member_count === 0);

  // Duplicate slug refused.
  await assert.rejects(
    seg.defineSegment({ slug: "vip", title: "another", rules: { recency_days_max: 7 } }),
    /already defined/,
  );

  // Unknown rule key.
  await assert.rejects(
    seg.defineSegment({ slug: "bad-rule", title: "x", rules: { totally_made_up: 1 } }),
    /unknown rule key/,
  );

  // Empty rules.
  await assert.rejects(
    seg.defineSegment({ slug: "empty", title: "x", rules: {} }),
    /at least one predicate/,
  );

  // Bad slug.
  await assert.rejects(
    seg.defineSegment({ slug: "Bad Slug!", title: "x", rules: { recency_days_max: 7 } }),
    /slug/,
  );

  // Min/max coherence.
  await assert.rejects(
    seg.defineSegment({
      slug:  "incoherent",
      title: "x",
      rules: { lifetime_orders_min: 10, lifetime_orders_max: 5 },
    }),
    /lifetime_orders_min/,
  );

  // Bad country code.
  await assert.rejects(
    seg.defineSegment({
      slug:  "bad-country",
      title: "x",
      rules: { country_in: ["us"] },
    }),
    /country/,
  );

  // Bad status enum.
  await assert.rejects(
    seg.defineSegment({
      slug:  "bad-status",
      title: "x",
      rules: { last_order_status_in: ["whatever"] },
    }),
    /last_order_status_in/,
  );
}

async function _recomputeAndEvaluateVIP() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query });

  var vip  = _uuid();
  var oneOff = _uuid();
  var lapsed = _uuid();

  var now = Date.now();
  // VIP: 3 paid orders within last 30 days, total $750.
  await _seedOrder(query, { customer_id: vip, status: "paid", grand_total_minor: 25000, created_at: now - 5 * DAY_MS });
  await _seedOrder(query, { customer_id: vip, status: "paid", grand_total_minor: 25000, created_at: now - 10 * DAY_MS });
  await _seedOrder(query, { customer_id: vip, status: "paid", grand_total_minor: 25000, created_at: now - 20 * DAY_MS });
  // One-off: 1 paid order, $200.
  await _seedOrder(query, { customer_id: oneOff, status: "paid", grand_total_minor: 20000, created_at: now - 7 * DAY_MS });
  // Lapsed: 4 paid orders, total $400, last 200d ago.
  await _seedOrder(query, { customer_id: lapsed, status: "paid", grand_total_minor: 10000, created_at: now - 200 * DAY_MS });
  await _seedOrder(query, { customer_id: lapsed, status: "paid", grand_total_minor: 10000, created_at: now - 220 * DAY_MS });
  await _seedOrder(query, { customer_id: lapsed, status: "paid", grand_total_minor: 10000, created_at: now - 240 * DAY_MS });
  await _seedOrder(query, { customer_id: lapsed, status: "paid", grand_total_minor: 10000, created_at: now - 260 * DAY_MS });

  await seg.defineSegment({
    slug:  "vip",
    title: "VIPs",
    rules: { recency_days_max: 30, monetary_minor_min: 50000, frequency_orders_min: 3 },
  });
  await seg.defineSegment({
    slug:  "lapsed",
    title: "Lapsed",
    rules: { recency_days_min: 90 },
  });

  var report = await seg.recompute();
  check("recompute: 2 segments evaluated",       report.segments_evaluated === 2);
  check("recompute: vip has 1 member",           report.per_segment.vip === 1);
  check("recompute: lapsed has 1 member",        report.per_segment.lapsed === 1);
  check("recompute: total_members aggregated",   report.total_members === 2);

  var vipEval = await seg.evaluate("vip");
  check("evaluate vip: 1 id",                    vipEval.customer_ids.length === 1);
  check("evaluate vip: correct id",              vipEval.customer_ids[0] === vip);
  check("evaluate vip: no next_cursor",          vipEval.next_cursor === null);

  var lapsedEval = await seg.evaluate("lapsed");
  check("evaluate lapsed: 1 id",                 lapsedEval.customer_ids.length === 1);
  check("evaluate lapsed: correct id",           lapsedEval.customer_ids[0] === lapsed);

  // Stats reports live count + avg lifetime.
  var st = await seg.stats("vip");
  check("stats: member_count = 1",               st.member_count === 1);
  check("stats: last_recomputed_at set",         typeof st.last_recomputed_at === "number");
  // avg lifetime: 3 orders × 25000 → avg per order 25000 (the SQL
  // aggregates per-order grand_total_minor).
  check("stats: avg_lifetime_minor = 25000",     st.avg_lifetime_minor === 25000);

  // Recompute is idempotent — second run yields the same membership.
  var rerun = await seg.recompute();
  check("recompute: rerun same vip count",       rerun.per_segment.vip === 1);
  var vipEval2 = await seg.evaluate("vip");
  check("evaluate: rerun same id list",          vipEval2.customer_ids.length === 1 && vipEval2.customer_ids[0] === vip);

  // Unknown slug refused.
  await assert.rejects(seg.evaluate("does-not-exist"), /unknown slug/);
}

async function _refundRateAndCountry() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query });

  var refunder = _uuid();
  var clean    = _uuid();
  var caCust   = _uuid();
  var now = Date.now();
  // refunder: 4 paid, 2 refunded → refund_rate 2/4 = 5000 bps.
  // Note refunded counts apply to status='refunded' orders, which
  // ALSO contribute to order_count (the aggregate filters only
  // 'cancelled'). So order_count = 4 (2 paid + 2 refunded).
  await _seedOrder(query, { customer_id: refunder, status: "paid",     grand_total_minor: 10000, created_at: now - 1 * DAY_MS });
  await _seedOrder(query, { customer_id: refunder, status: "paid",     grand_total_minor: 10000, created_at: now - 2 * DAY_MS });
  await _seedOrder(query, { customer_id: refunder, status: "refunded", grand_total_minor: 10000, created_at: now - 3 * DAY_MS });
  await _seedOrder(query, { customer_id: refunder, status: "refunded", grand_total_minor: 10000, created_at: now - 4 * DAY_MS });
  // clean: 3 paid only.
  await _seedOrder(query, { customer_id: clean, status: "paid", grand_total_minor: 10000, created_at: now - 1 * DAY_MS });
  await _seedOrder(query, { customer_id: clean, status: "paid", grand_total_minor: 10000, created_at: now - 2 * DAY_MS });
  await _seedOrder(query, { customer_id: clean, status: "paid", grand_total_minor: 10000, created_at: now - 3 * DAY_MS });
  // CA customer: 1 paid Canadian order.
  await _seedOrder(query, { customer_id: caCust, status: "paid", grand_total_minor: 10000, country: "CA", created_at: now - 1 * DAY_MS });

  await seg.defineSegment({
    slug:  "high-refund",
    title: "High refund rate",
    rules: { refund_rate_bps_min: 4000 },
  });
  await seg.defineSegment({
    slug:  "ca-buyers",
    title: "Canada last-shipped",
    rules: { country_in: ["CA"] },
  });

  await seg.recompute();

  var hr = await seg.evaluate("high-refund");
  check("evaluate high-refund: 1 match",            hr.customer_ids.length === 1);
  check("evaluate high-refund: refunder selected",  hr.customer_ids[0] === refunder);

  var ca = await seg.evaluate("ca-buyers");
  check("evaluate ca-buyers: 1 match",              ca.customer_ids.length === 1);
  check("evaluate ca-buyers: CA customer selected", ca.customer_ids[0] === caCust);
}

async function _evaluateCursorPagination() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query });

  // Seed 5 customers all matching the same loose segment.
  var ids = [];
  var now = Date.now();
  for (var i = 0; i < 5; i += 1) {
    var cid = _uuid();
    ids.push(cid);
    await _seedOrder(query, { customer_id: cid, status: "paid", grand_total_minor: 10000, created_at: now - i * DAY_MS });
  }

  await seg.defineSegment({
    slug:  "all-buyers",
    title: "Anyone",
    rules: { lifetime_orders_min: 1 },
  });
  var report = await seg.recompute();
  check("recompute all-buyers: 5 matched",        report.per_segment["all-buyers"] === 5);

  var page1 = await seg.evaluate("all-buyers", { limit: 2 });
  check("evaluate page1: 2 ids",                  page1.customer_ids.length === 2);
  check("evaluate page1: cursor present",         typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);

  var page2 = await seg.evaluate("all-buyers", { limit: 2, cursor: page1.next_cursor });
  check("evaluate page2: 2 ids",                  page2.customer_ids.length === 2);
  check("evaluate page2: strictly after page1",   page2.customer_ids[0] > page1.customer_ids[1]);

  var page3 = await seg.evaluate("all-buyers", { limit: 2, cursor: page2.next_cursor });
  check("evaluate page3: 1 id (tail)",            page3.customer_ids.length === 1);
  check("evaluate page3: no further cursor",      page3.next_cursor === null);

  // Cumulative coverage equals the seeded set (sorted ASC).
  var combined = page1.customer_ids.concat(page2.customer_ids).concat(page3.customer_ids);
  var expected = ids.slice().sort();
  check("evaluate: combined ids = sorted seed",
        combined.length === expected.length
        && combined.every(function (id, ix) { return id === expected[ix]; }));

  // Tampered cursor refused.
  await assert.rejects(seg.evaluate("all-buyers", { cursor: "not-a-real-cursor" }), /cursor/);
  await assert.rejects(seg.evaluate("all-buyers", { cursor: 42 }), /cursor/);

  // Cursor minted under a different secret is refused.
  var other = customerSegments.create({ query: _makeQuery(), cursorSecret: "different-secret" });
  await other.defineSegment({ slug: "x", title: "x", rules: { lifetime_orders_min: 1 } });
  var crossSeg = customerSegments.create({ query: query, cursorSecret: "yet-another-secret" });
  await assert.rejects(crossSeg.evaluate("all-buyers", { cursor: page1.next_cursor }), /cursor/);
}

async function _segmentsForCustomerAndArchive() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query });

  var person = _uuid();
  var now = Date.now();
  await _seedOrder(query, { customer_id: person, status: "paid", grand_total_minor: 60000, created_at: now - 5 * DAY_MS });
  await _seedOrder(query, { customer_id: person, status: "paid", grand_total_minor: 60000, created_at: now - 6 * DAY_MS });
  await _seedOrder(query, { customer_id: person, status: "paid", grand_total_minor: 60000, created_at: now - 7 * DAY_MS });

  await seg.defineSegment({
    slug:  "vip",
    title: "VIP",
    rules: { recency_days_max: 30, monetary_minor_min: 100000, frequency_orders_min: 3 },
  });
  await seg.defineSegment({
    slug:  "recent",
    title: "Recent",
    rules: { recency_days_max: 30 },
  });
  await seg.defineSegment({
    slug:  "lapsed-y2k",
    title: "Last ordered before Y2K",
    rules: { recency_days_min: 9000 },
  });

  await seg.recompute();

  var memberships = await seg.segmentsForCustomer(person);
  check("segmentsForCustomer: 2 active matches",
        memberships.length === 2);
  var slugs = memberships.map(function (m) { return m.slug; }).sort();
  check("segmentsForCustomer: slugs sorted asc",
        slugs[0] === "recent" && slugs[1] === "vip");
  check("segmentsForCustomer: title hydrated",
        memberships[0].title === "Recent" || memberships[1].title === "Recent");
  check("segmentsForCustomer: rules hydrated",
        memberships.some(function (m) { return m.rules && m.rules.recency_days_max === 30; }));

  // Archive vip → segmentsForCustomer drops it; evaluate returns empty.
  await seg.archive("vip");
  var after = await seg.segmentsForCustomer(person);
  check("segmentsForCustomer: archived hidden",   after.length === 1 && after[0].slug === "recent");
  var vipPostArchive = await seg.evaluate("vip");
  check("evaluate: archived returns []",          vipPostArchive.customer_ids.length === 0);

  // Unarchive + recompute restores membership.
  await seg.unarchive("vip");
  await seg.recompute();
  var restored = await seg.segmentsForCustomer(person);
  check("segmentsForCustomer: unarchive restores", restored.length === 2);

  // Unknown customer → empty list (not an error).
  var unknownCust = _uuid();
  var empty = await seg.segmentsForCustomer(unknownCust);
  check("segmentsForCustomer: unknown → []",      empty.length === 0);

  // Bad shape refused.
  await assert.rejects(seg.segmentsForCustomer("not-a-uuid"), /customer_id/);
}

async function _updateAndListSegments() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query });

  await seg.defineSegment({
    slug:  "vip",
    title: "VIP",
    description: "v1",
    rules: { recency_days_max: 30, monetary_minor_min: 50000 },
  });

  // Patch title only.
  var t = await seg.update("vip", { title: "VIP buyers" });
  check("update: title patched",                  t.title === "VIP buyers");
  check("update: description preserved",          t.description === "v1");
  check("update: rules preserved",                t.rules.monetary_minor_min === 50000);

  // Patch description only.
  var d = await seg.update("vip", { description: "Top tier" });
  check("update: description patched",            d.description === "Top tier");
  check("update: title preserved on desc patch",  d.title === "VIP buyers");

  // Patch rules — replaces full bag.
  var r = await seg.update("vip", { rules: { frequency_orders_min: 5 } });
  check("update: rules replaced",                 r.rules.frequency_orders_min === 5);
  check("update: rules.monetary_minor_min gone",  r.rules.monetary_minor_min == null);

  // Bad patch refused.
  await assert.rejects(seg.update("vip", { rules: { bogus_rule: 1 } }), /unknown rule key/);
  await assert.rejects(seg.update("unknown-slug", { title: "x" }),       /unknown slug/);

  // listSegments shows the active one; not the archived one by default.
  await seg.defineSegment({ slug: "lapsed", title: "L", rules: { recency_days_min: 90 } });
  await seg.archive("lapsed");

  var active = await seg.listSegments();
  check("listSegments default: active only",      active.length === 1 && active[0].slug === "vip");

  var all = await seg.listSegments({ include_archived: true });
  check("listSegments include_archived: both",    all.length === 2);
  // Slug sort asc — lapsed before vip.
  check("listSegments: slug asc",                 all[0].slug === "lapsed" && all[1].slug === "vip");
}

async function _recomputeSlugFilter() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query });

  var c1 = _uuid();
  var now = Date.now();
  await _seedOrder(query, { customer_id: c1, status: "paid", grand_total_minor: 10000, created_at: now - 1 * DAY_MS });

  await seg.defineSegment({ slug: "a", title: "A", rules: { lifetime_orders_min: 1 } });
  await seg.defineSegment({ slug: "b", title: "B", rules: { lifetime_orders_min: 1 } });

  // First, recompute only "a" — "b" stays empty.
  var first = await seg.recompute({ slugs: ["a"] });
  check("recompute filter: only a evaluated",     first.segments_evaluated === 1);
  check("recompute filter: a has 1",              first.per_segment.a === 1);
  check("recompute filter: b not touched",        first.per_segment.b == null);

  var aPre = await seg.evaluate("a");
  var bPre = await seg.evaluate("b");
  check("evaluate filter: a has member",          aPre.customer_ids.length === 1);
  check("evaluate filter: b empty",               bPre.customer_ids.length === 0);

  // Now full recompute fills b.
  var full = await seg.recompute();
  check("recompute full: both evaluated",         full.segments_evaluated === 2);
  check("recompute full: b filled",               full.per_segment.b === 1);

  // Bad slug filter shape.
  await assert.rejects(seg.recompute({ slugs: "a" }), /slugs/);
  await assert.rejects(seg.recompute({ slugs: ["Not A Valid Slug"] }), /slug/);
}

async function _productionRequiresCursorSecret() {
  var prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    var threw = false;
    try {
      customerSegments.create({ query: _makeQuery() });
    } catch (e) {
      threw = /cursorSecret/.test(e.message);
    }
    check("create: throws in production without cursorSecret", threw === true);

    var seg = customerSegments.create({ query: _makeQuery(), cursorSecret: "test-secret" });
    check("create: accepts cursorSecret in production",        typeof seg.defineSegment === "function");
  } finally {
    process.env.NODE_ENV = prev;
  }
}

// Drain a CSV async-iterable into a single string, counting the chunks
// so a batched stream can be asserted to yield more than one chunk.
async function _drainCsv(iter) {
  var body = "";
  var chunks = 0;
  for await (var c of iter) { if (c != null) { body += c; chunks += 1; } }
  return { body: body, chunks: chunks };
}

// Seed a customers row so the export's display_name LEFT JOIN resolves.
async function _seedCustomer(query, displayName) {
  var id = _uuid();
  var ts = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?4)",
    [id, "hash_" + id, displayName, ts],
  );
  return id;
}

async function _membersCsvExport() {
  var query = _makeQuery();
  var seg = customerSegments.create({ query: query, cursorSecret: "members-csv-test" });

  // Two members: one ordinary, one whose display_name is a CSV-injection
  // payload (leading "="). Each has one paid order so the segment matches.
  var c1 = await _seedCustomer(query, "Bob Buyer");
  var c2 = await _seedCustomer(query, "=cmd()|' /C calc'");
  await _seedOrder(query, { customer_id: c1 });
  await _seedOrder(query, { customer_id: c2 });

  await seg.defineSegment({ slug: "buyers", title: "Buyers", rules: { frequency_orders_min: 1 } });
  await seg.recompute({ slugs: ["buyers"] });
  check("export: two members recomputed", (await seg.stats("buyers")).member_count === 2);

  var out = await _drainCsv(seg.membersCsvForSegment("buyers"));
  var body = out.body;
  check("export: header has the four columns",
    body.indexOf("\"customer_id\",\"display_name\",\"joined_segment_at\",\"order_count\"") !== -1);
  check("export: leading comment row present", body.indexOf("email addresses are omitted") !== -1);
  check("export: NO email column", body.toLowerCase().indexOf("\"email\"") === -1);
  check("export: carries both member ids", body.indexOf(c1) !== -1 && body.indexOf(c2) !== -1);
  check("export: carries the ordinary display name", body.indexOf("Bob Buyer") !== -1);
  check("export: order_count column populated", body.indexOf("\"1\"") !== -1);
  // CSV-injection neutralization — the "=cmd()" display_name is prefixed
  // with a TAB (the shared b.guardCsv.escapeCell, OWASP prefix-tab) so a
  // spreadsheet treats it as text, never a formula.
  check("export: neutralizes the formula-injection name", body.indexOf("\"\t=cmd()") !== -1);
  check("export: no raw leading-= cell", body.indexOf(",\"=cmd()") === -1);

  // Unit-level injection neutralizer — now the shared vendored primitive,
  // which prefixes a leading TAB for ANY formula-trigger char (= + - @ plus
  // the tab / CR / LF / pipe / full-width variants an `= + - @`-only check
  // missed). Signed numerics are prefixed too (the safe OWASP posture).
  check("neutralize: leading = escaped",  customerSegments._neutralizeInjection("=SUM(A1)") === "\t=SUM(A1)");
  check("neutralize: leading @ escaped",  customerSegments._neutralizeInjection("@foo") === "\t@foo");
  check("neutralize: leading pipe escaped", customerSegments._neutralizeInjection("|calc") === "\t|calc");
  check("neutralize: signed number escaped", customerSegments._neutralizeInjection("-3.50") === "\t-3.50");
  check("neutralize: plain text passes",  customerSegments._neutralizeInjection("Bob") === "Bob");

  // Batched streaming — with a tiny seed set the stream still yields the
  // prelude chunk + at least one data chunk (more than one chunk total),
  // proving it streams rather than buffering the whole body into one blob.
  check("export: streams in multiple chunks", out.chunks >= 2);

  // An unknown slug throws on first iteration (clean 404 mapping upstream),
  // never a partial/empty stream that looks like a real export.
  var threw = false;
  try { await _drainCsv(seg.membersCsvForSegment("no-such")); }
  catch (e) { threw = /unknown slug/.test(e.message); }
  check("export: unknown slug throws", threw === true);

  // A bad slug shape is rejected before any read.
  var badSlug = false;
  try { seg.membersCsvForSegment("Bad Slug!"); }
  catch (e) { badSlug = /slug/.test(e.message); }
  check("export: bad slug shape rejected", badSlug === true);

  // An archived segment streams a well-formed (header-only) file, not a 404.
  await seg.archive("buyers");
  var archived = await _drainCsv(seg.membersCsvForSegment("buyers"));
  check("export: archived yields the header", archived.body.indexOf("\"customer_id\"") !== -1);
  check("export: archived has no member rows", archived.body.indexOf(c1) === -1 && archived.body.indexOf(c2) === -1);
}

async function run() {
  await _defineAndDuplicate();
  await _membersCsvExport();
  await _recomputeAndEvaluateVIP();
  await _refundRateAndCountry();
  await _evaluateCursorPagination();
  await _segmentsForCustomerAndArchive();
  await _updateAndListSegments();
  await _recomputeSlugFilter();
  await _productionRequiresCursorSecret();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK customer-segments (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL customer-segments:", err && err.stack || err);
    process.exit(1);
  });
}
