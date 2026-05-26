var DEFAULT_LIMIT = 24;
var MAX_LIMIT     = 100;

function _clampLimit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function _clampOffset(n) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

// Decoration columns the home + search renderers need on each
// product row: first variant id (ordered by position then created_at),
// the current price for that variant in `currency`, and the first
// media row attached to the product. Window functions pick the first
// variant + first media per product in one round trip; the price is
// joined directly off the hero variant.
var DECORATED_SELECT =
  "SELECT p.*, " +
  "       v.id        AS hero_variant_id, " +
  "       pr.amount_minor AS starting_price_minor, " +
  "       pr.currency     AS starting_price_currency, " +
  "       m.r2_key    AS hero_r2_key, " +
  "       m.alt_text  AS hero_alt_text " +
  "FROM products p " +
  "LEFT JOIN ( " +
  "  SELECT iv.*, " +
  "         ROW_NUMBER() OVER (PARTITION BY iv.product_id ORDER BY iv.position ASC, iv.created_at ASC) AS rn " +
  "  FROM variants iv " +
  ") v ON v.product_id = p.id AND v.rn = 1 " +
  "LEFT JOIN prices pr ON pr.variant_id = v.id AND pr.currency = ?1 AND pr.effective_until IS NULL " +
  "LEFT JOIN ( " +
  "  SELECT im.*, " +
  "         ROW_NUMBER() OVER (PARTITION BY im.product_id ORDER BY im.position ASC, im.created_at ASC) AS rn " +
  "  FROM media im " +
  "  WHERE im.product_id IS NOT NULL " +
  ") m ON m.product_id = p.id AND m.rn = 1 ";

function _shapeDecoratedRow(r) {
  var hero = (r.hero_r2_key != null)
    ? { r2_key: r.hero_r2_key, alt_text: r.hero_alt_text || "" }
    : null;
  return {
    id:                      r.id,
    slug:                    r.slug,
    title:                   r.title,
    description:             r.description,
    status:                  r.status,
    created_at:              r.created_at,
    updated_at:              r.updated_at,
    starting_price_minor:    r.starting_price_minor != null ? r.starting_price_minor : null,
    starting_price_currency: r.starting_price_currency || "USD",
    hero_media:              hero,
  };
}

// One round trip returns every active product with its first
// variant's price and first media row pre-joined. Replaces the
// previous N+1 (1 + 24 × 3 = 73 queries) fan-out with a single
// query. Window functions partition by product so the first
// variant / first media surface without an application-side group.
export async function listActiveProducts(DB, opts) {
  opts = opts || {};
  var limit    = _clampLimit(opts.limit);
  var offset   = _clampOffset(opts.offset);
  var currency = (typeof opts.currency === "string" && opts.currency.length === 3) ? opts.currency : "USD";
  var listRes = await DB
    .prepare(
      DECORATED_SELECT +
      "WHERE p.status = 'active' " +
      "ORDER BY p.updated_at DESC, p.id DESC " +
      "LIMIT ?2 OFFSET ?3"
    )
    .bind(currency, limit, offset)
    .all();
  var rows = (listRes && listRes.results) ? listRes.results.map(_shapeDecoratedRow) : [];
  return { rows: rows };
}

export async function getProductBySlug(DB, slug) {
  if (typeof slug !== "string" || slug.length === 0) return null;
  var row = await DB
    .prepare("SELECT * FROM products WHERE slug = ?1 AND status = ?2")
    .bind(slug, "active")
    .first();
  return row || null;
}

// Search returns the same decorated row shape — one round trip,
// LIKE-escaped against title/description.
export async function searchProducts(DB, opts) {
  opts = opts || {};
  if (typeof opts.q !== "string") return { rows: [] };
  var qTrim = opts.q.trim();
  if (qTrim.length === 0) return { rows: [] };
  var limit    = _clampLimit(opts.limit);
  var currency = (typeof opts.currency === "string" && opts.currency.length === 3) ? opts.currency : "USD";
  var qLower = qTrim.toLowerCase();
  // The `\\` substitution must run first — otherwise the `\` we
  // insert in front of `%` / `_` would be re-escaped on the next
  // pass and the LIKE wildcards would survive un-neutralized.
  var qEscaped = qLower
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  var pattern = "%" + qEscaped + "%";
  var res = await DB
    .prepare(
      DECORATED_SELECT +
      "WHERE p.status = 'active' AND " +
      "(lower(p.title) LIKE ?2 ESCAPE '\\' OR lower(p.description) LIKE ?2 ESCAPE '\\') " +
      "ORDER BY p.updated_at DESC, p.id DESC LIMIT ?3"
    )
    .bind(currency, pattern, limit)
    .all();
  var rows = (res && res.results) ? res.results.map(_shapeDecoratedRow) : [];
  return { rows: rows };
}

// PDP read-side: variants × current price in one query. Each row
// carries the variant columns plus `price_amount_minor` /
// `price_currency` for the active price (NULL when no price is
// configured for the requested currency).
export async function listVariantsWithPrices(DB, productId, currency) {
  if (typeof productId !== "string" || productId.length === 0) return { rows: [] };
  var cur = (typeof currency === "string" && currency.length === 3) ? currency : "USD";
  var res = await DB
    .prepare(
      "SELECT v.*, " +
      "       pr.id           AS price_id, " +
      "       pr.amount_minor AS price_amount_minor, " +
      "       pr.currency     AS price_currency " +
      "FROM variants v " +
      "LEFT JOIN prices pr ON pr.variant_id = v.id AND pr.currency = ?1 AND pr.effective_until IS NULL " +
      "WHERE v.product_id = ?2 " +
      "ORDER BY v.position ASC, v.created_at ASC"
    )
    .bind(cur, productId)
    .all();
  var rows = (res && res.results) ? res.results : [];
  return { rows: rows };
}

// Every active product slug + its last-modified epoch (for sitemap
// `<lastmod>` derivation). Streamed straight off the products table;
// no JOIN. The sitemap protocol caps a single sitemap at 50,000 URLs
// — the LIMIT mirrors that ceiling so a runaway catalog still
// produces a valid response.
export async function listActiveProductSlugs(DB) {
  var res = await DB
    .prepare("SELECT slug, updated_at FROM products WHERE status = 'active' ORDER BY updated_at DESC LIMIT 50000")
    .bind()
    .all();
  var rows = (res && res.results) ? res.results : [];
  return { rows: rows };
}

// Every published blog article slug + its last-modified epoch.
// Same 50k cap as products (independent budget — sitemap protocol's
// limit is per-file, not per-source).
//
// Resilient to a missing `blog_articles` table — operators that
// haven't applied migration `0189` yet (the table ships with the
// blogArticles primitive added in v0.0.75) get an empty result
// set instead of a D1 error propagating to the caller. The
// dependent routes (/feed.xml, /sitemap.xml) then render with the
// product surface only.
export async function listPublishedBlogSlugs(DB) {
  try {
    var res = await DB
      .prepare(
        "SELECT slug, COALESCE(updated_at, published_at) AS updated_at " +
        "FROM blog_articles WHERE status = 'published' AND published_at IS NOT NULL " +
        "ORDER BY updated_at DESC LIMIT 50000"
      )
      .bind()
      .all();
    var rows = (res && res.results) ? res.results : [];
    return { rows: rows };
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return { rows: [] };
    throw e;
  }
}

// Published blog articles for the /blog list page. `limit` defaults
// to 12, `offset` for paging. Newest first. Returns the columns the
// list-page renderer needs (no body — list cards show meta only).
// Missing-table-resilient (see `listPublishedBlogSlugs`).
export async function listBlogArticles(DB, opts) {
  opts = opts || {};
  var limit  = _clampLimit(opts.limit);
  var offset = _clampOffset(opts.offset);
  try {
    var res = await DB
      .prepare(
        "SELECT slug, title, author_id, hero_image_url, meta_description, " +
        "       published_at, updated_at " +
        "FROM blog_articles " +
        "WHERE status = 'published' AND published_at IS NOT NULL " +
        "ORDER BY published_at DESC LIMIT ?1 OFFSET ?2"
      )
      .bind(limit, offset)
      .all();
    var rows = (res && res.results) ? res.results : [];
    return { rows: rows };
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return { rows: [] };
    throw e;
  }
}

// Single published blog article by slug. Returns the full row
// (including body + tags JSON) for the article-detail render.
// Missing-table-resilient (see `listPublishedBlogSlugs`).
export async function getBlogArticleBySlug(DB, slug) {
  if (typeof slug !== "string" || slug.length === 0) return null;
  var row = null;
  try {
    row = await DB
      .prepare(
        "SELECT * FROM blog_articles " +
        "WHERE slug = ?1 AND status = 'published' AND published_at IS NOT NULL"
      )
      .bind(slug)
      .first();
  } catch (e) {
    if (!(e && /no such table/i.test(e.message || ""))) throw e;
  }
  return row || null;
}

// Recent published blog articles, newest first. Used by the edge
// /feed.xml renderer. `limit` defaults to 20 (RSS-reader convention).
// Missing-table-resilient (see `listPublishedBlogSlugs`).
export async function recentBlogArticles(DB, opts) {
  opts = opts || {};
  var limit = _clampLimit(opts.limit);
  try {
    var res = await DB
      .prepare(
        "SELECT slug, title, body, author_id, hero_image_url, meta_description, " +
        "       published_at, updated_at " +
        "FROM blog_articles " +
        "WHERE status = 'published' AND published_at IS NOT NULL " +
        "ORDER BY published_at DESC LIMIT ?1"
      )
      .bind(limit)
      .all();
    var rows = (res && res.results) ? res.results : [];
    return { rows: rows };
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return { rows: [] };
    throw e;
  }
}

export async function listMediaForProduct(DB, productId) {
  if (typeof productId !== "string" || productId.length === 0) return { rows: [] };
  var res = await DB
    .prepare("SELECT * FROM media WHERE product_id = ?1 ORDER BY position ASC, created_at ASC")
    .bind(productId)
    .all();
  var rows = (res && res.results) ? res.results : [];
  return { rows: rows };
}

// Published review aggregate for a product's PDP — count, mean rating,
// and the per-star distribution in one grouped round trip. Mirrors
// `lib/reviews.js#summaryForProduct` but reads D1 directly (the edge
// can't require the container's primitives). Published-only by
// construction so pending / rejected rows never reach the storefront.
//
// Missing-table-resilient: operators who haven't applied migration
// `0011_reviews.sql` get a zeroed summary instead of a D1 error
// propagating into the PDP render (see `listPublishedBlogSlugs`).
export async function getReviewSummary(DB, productId) {
  var empty = { count: 0, avg_rating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  if (typeof productId !== "string" || productId.length === 0) return empty;
  try {
    var res = await DB
      .prepare(
        "SELECT rating, COUNT(*) AS n FROM reviews " +
        "WHERE product_id = ?1 AND status = 'published' GROUP BY rating"
      )
      .bind(productId)
      .all();
    var rows = (res && res.results) ? res.results : [];
    var distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    var count = 0;
    var sum   = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var rating = Number(rows[i].rating);
      var n      = Number(rows[i].n);
      if (rating >= 1 && rating <= 5) {
        distribution[rating] = n;
        count += n;
        sum   += rating * n;
      }
    }
    return { count: count, avg_rating: count === 0 ? 0 : sum / count, distribution: distribution };
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return empty;
    throw e;
  }
}

// How many distinct customers have wishlisted a product — the PDP's
// "N saved" social-proof counter. Mirrors `lib/wishlist.js#countForProduct`
// but reads D1 directly (the edge can't require the container's
// primitives). Missing-table-resilient: operators who haven't applied
// migration `0012_wishlist.sql` get 0 instead of a D1 error reaching
// the PDP render (see `getReviewSummary`).
export async function getWishlistCount(DB, productId) {
  if (typeof productId !== "string" || productId.length === 0) return 0;
  try {
    var res = await DB
      .prepare("SELECT COUNT(DISTINCT customer_id) AS n FROM wishlist_entries WHERE product_id = ?1")
      .bind(productId)
      .first();
    return res && Number.isFinite(Number(res.n)) ? Number(res.n) : 0;
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return 0;
    throw e;
  }
}

// Published reviews for a product's PDP, newest first. Returns only the
// display columns — never the customer identity (the schema stores a
// `customer_id_hash`, never raw email; the storefront shows
// "Verified buyer" / "Customer" from `verified_purchase`, not a name).
// `limit` defaults to 10 and is clamped to MAX_LIMIT. Missing-table-
// resilient (see `getReviewSummary`).
export async function listPublishedReviews(DB, productId, limit) {
  if (typeof productId !== "string" || productId.length === 0) return { rows: [] };
  var lim = _clampLimit(limit == null ? 10 : limit);
  try {
    var res = await DB
      .prepare(
        "SELECT rating, title, body, verified_purchase, created_at FROM reviews " +
        "WHERE product_id = ?1 AND status = 'published' " +
        "ORDER BY created_at DESC, id DESC LIMIT ?2"
      )
      .bind(productId, lim)
      .all();
    var rows = (res && res.results) ? res.results : [];
    return { rows: rows };
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return { rows: [] };
    throw e;
  }
}

// Approved Q&A threads for a product's PDP — each approved question
// with its approved answers attached (pinned answer first, then by
// vote_count, then oldest-first). Mirrors
// `lib/product-qa.js#questionsForProduct` + `#answersForQuestion` but
// reads D1 directly (the edge can't require the container's
// primitives). Approved-only by construction so pending / rejected rows
// never reach the storefront — never returns customer identity (the
// schema stores `customer_id` / `customer_email_hash`, never a name).
// `limit` caps the question count (clamped to MAX_LIMIT). Missing-table-
// resilient (see `getReviewSummary`).
export async function listProductQaThreads(DB, productId, limit) {
  if (typeof productId !== "string" || productId.length === 0) return { rows: [] };
  var lim = _clampLimit(limit == null ? 20 : limit);
  try {
    var qRes = await DB
      .prepare(
        "SELECT id, body, pinned, vote_count, occurred_at FROM product_qa_questions " +
        "WHERE product_id = ?1 AND status = 'approved' " +
        "ORDER BY occurred_at DESC, id DESC LIMIT ?2"
      )
      .bind(productId, lim)
      .all();
    var questions = (qRes && qRes.results) ? qRes.results : [];
    for (var i = 0; i < questions.length; i += 1) {
      var aRes = await DB
        .prepare(
          "SELECT author, body, is_operator, pinned, vote_count FROM product_qa_answers " +
          "WHERE question_id = ?1 AND status = 'approved' " +
          "ORDER BY pinned DESC, vote_count DESC, occurred_at ASC, id ASC LIMIT ?2"
        )
        .bind(questions[i].id, MAX_LIMIT)
        .all();
      questions[i].answers = (aRes && aRes.results) ? aRes.results : [];
    }
    return { rows: questions };
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return { rows: [] };
    throw e;
  }
}

// Current price (minor units) for a SKU in `currency`, or null. The
// edge has no catalog primitive; this reads the variant → price join
// directly. Used by the bundle pricer + the quantity-break sampler.
async function _skuPriceMinor(DB, sku, currency) {
  var row = await DB
    .prepare(
      "SELECT pr.amount_minor AS amount_minor, pr.currency AS currency " +
      "FROM variants v " +
      "JOIN prices pr ON pr.variant_id = v.id AND pr.currency = ?2 AND pr.effective_until IS NULL " +
      "WHERE v.sku = ?1 LIMIT 1"
    )
    .bind(sku, currency)
    .first();
  return row && Number.isInteger(Number(row.amount_minor))
    ? { amount_minor: Number(row.amount_minor), currency: row.currency }
    : null;
}

// Is a SKU buyable at the edge — a real variant that isn't sold out?
// A SKU with no inventory row is treated as available (the operator
// hasn't opted into stock tracking), matching the container.
async function _skuBuyableEdge(DB, sku) {
  var v = await DB.prepare("SELECT id, product_id, title FROM variants WHERE sku = ?1 LIMIT 1").bind(sku).first();
  if (!v) return null;
  var inv = await DB.prepare("SELECT stock_on_hand, stock_held FROM inventory WHERE sku = ?1 LIMIT 1").bind(sku).first();
  if (inv && (Number(inv.stock_on_hand) - Number(inv.stock_held)) <= 0) return false;
  return v;
}

// Display title for a member SKU — the owning product's title, falling
// back to the variant title, then the raw SKU.
async function _memberTitle(DB, sku) {
  var v = await DB.prepare("SELECT product_id, title FROM variants WHERE sku = ?1 LIMIT 1").bind(sku).first();
  if (!v) return sku;
  var p = await DB.prepare("SELECT title FROM products WHERE id = ?1 LIMIT 1").bind(v.product_id).first();
  return (p && p.title) || v.title || sku;
}

// Bundle offers for a product's variant SKUs — the edge mirror of
// `lib/storefront.js#_resolveBundleOffers`. Finds every bundle that
// lists one of `variantSkus` as a direct component, prices it from the
// live catalog (sum-of-parts vs the stored basis-point discount,
// integer-floor — matching `lib/bundles.js#priceBundle`), checks every
// member is buyable, and returns minor-unit offers the edge renderer
// formats. Missing-table-resilient: returns [] so the PDP renders
// without the rail.
export async function getBundlesForProduct(DB, variantSkus, currency) {
  var cur = (typeof currency === "string" && currency.length === 3) ? currency : "USD";
  if (!Array.isArray(variantSkus) || variantSkus.length === 0) return [];
  var seen = Object.create(null);
  var offers = [];
  try {
    for (var s = 0; s < variantSkus.length; s += 1) {
      var bRes = await DB
        .prepare(
          "SELECT DISTINCT bc.bundle_sku FROM bundle_components bc " +
          "JOIN bundles bn ON bn.bundle_sku = bc.bundle_sku " +
          "WHERE bc.sku = ?1 ORDER BY bn.updated_at DESC, bn.bundle_sku DESC"
        )
        .bind(variantSkus[s])
        .all();
      var bundleSkus = (bRes && bRes.results) ? bRes.results : [];
      for (var i = 0; i < bundleSkus.length; i += 1) {
        var bundleSku = bundleSkus[i].bundle_sku;
        if (seen[bundleSku]) continue;
        seen[bundleSku] = true;

        var bundleRow = await DB.prepare("SELECT * FROM bundles WHERE bundle_sku = ?1 LIMIT 1").bind(bundleSku).first();
        if (!bundleRow) continue;
        var compRes = await DB
          .prepare(
            "SELECT sku, quantity FROM bundle_components WHERE bundle_sku = ?1 ORDER BY sort_order ASC, sku ASC"
          )
          .bind(bundleSku)
          .all();
        var comps = (compRes && compRes.results) ? compRes.results : [];

        var componentsOut = [];
        var allBuyable = true;
        var priceable = true;
        var listMinor = 0;
        var priceCurrency = cur;
        for (var j = 0; j < comps.length; j += 1) {
          var comp = comps[j];
          var qty = Number(comp.quantity);
          var buyable = await _skuBuyableEdge(DB, comp.sku);
          if (!buyable) allBuyable = false;
          componentsOut.push({ sku: comp.sku, quantity: qty, title: await _memberTitle(DB, comp.sku) });
          var price = await _skuPriceMinor(DB, comp.sku, cur);
          if (!price) { priceable = false; continue; }
          priceCurrency = price.currency;
          listMinor += price.amount_minor * qty;
        }

        var discountBps = bundleRow.bundle_discount_bps;
        var discountMinor = 0;
        if (priceable && discountBps != null && Number(discountBps) > 0) {
          discountMinor = Math.floor((listMinor * Number(discountBps)) / 10000);
        }
        var amountMinor = listMinor - discountMinor;
        var available = allBuyable && priceable;

        offers.push({
          bundle_sku:         bundleSku,
          title:              bundleRow.title,
          components:         componentsOut,
          list_total_minor:   listMinor,
          amount_minor:       amountMinor,
          discount_minor:     priceable ? discountMinor : 0,
          currency:           priceCurrency,
          available:          available,
          unavailable_reason: available
            ? null
            : (!priceable
                ? "Pricing for this bundle isn't available right now."
                : "One or more items in this bundle are out of stock."),
        });
      }
    }
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return [];
    throw e;
  }
  return offers;
}

// Quantity-break rows for a SKU against `unitMinor` — the edge mirror
// of `lib/storefront.js#_resolveQtyBreaks`. Reads the active sku-scoped
// tier sets + their tiers and replays the kind-specific unit-price math
// (`lib/quantity-discounts.js#_applyRule`) so the displayed "price
// each" matches what the cart charges at that quantity. Returns
// ascending range rows ("1–4", "5–9", "10+") in minor units (the edge
// renderer formats); [] when no active sku-scoped schedule exists. The
// `money` arg is the `worker/b.js` handle (the data layer takes no
// import so it stays format-agnostic). Missing-table-resilient.
export async function getQtyBreaksForSku(DB, sku, unitMinor, currency, money) {
  var cur = (typeof currency === "string" && currency.length === 3) ? currency : "USD";
  if (typeof sku !== "string" || !sku.length || !Number.isInteger(unitMinor)) return [];
  var tiers = [];
  try {
    var setsRes = await DB
      .prepare("SELECT id FROM qd_tier_sets WHERE scope = 'sku' AND scope_id = ?1 AND archived_at IS NULL")
      .bind(sku)
      .all();
    var sets = (setsRes && setsRes.results) ? setsRes.results : [];
    for (var i = 0; i < sets.length; i += 1) {
      var tRes = await DB
        .prepare(
          "SELECT min_quantity, discount_kind, value FROM qd_tiers WHERE tier_set_id = ?1 ORDER BY min_quantity ASC"
        )
        .bind(sets[i].id)
        .all();
      var rows = (tRes && tRes.results) ? tRes.results : [];
      for (var j = 0; j < rows.length; j += 1) tiers.push(rows[j]);
    }
  } catch (e) {
    if (e && /no such table/i.test(e.message || "")) return [];
    throw e;
  }
  if (tiers.length === 0) return [];
  tiers.sort(function (a, b2) { return Number(a.min_quantity) - Number(b2.min_quantity); });

  function _discountedUnit(kind, value, minQty) {
    var v = Number(value);
    if (kind === "percent_off") {
      var keepBps = 10000 - v;
      if (keepBps < 0) keepBps = 0;
      var priced = money.of(BigInt(unitMinor), cur).multiply([BigInt(keepBps), BigInt(10000)]);
      var u = Number(priced.toMinorUnits());
      return u < 0 ? 0 : u;
    }
    if (kind === "amount_off_each") {
      var u2 = unitMinor - v;
      return u2 < 0 ? 0 : u2;
    }
    if (kind === "amount_off_total") {
      var listLine = unitMinor * minQty;
      var sub = listLine - v;
      if (sub < 0) sub = 0;
      var eff = money.of(BigInt(sub), cur).multiply([1n, BigInt(minQty)]);
      return Number(eff.toMinorUnits());
    }
    if (kind === "fixed_each_price") {
      return v < 0 ? 0 : v;
    }
    return unitMinor;
  }

  var out = [];
  if (Number(tiers[0].min_quantity) > 1) {
    out.push({ label: "1–" + (Number(tiers[0].min_quantity) - 1), unit_minor: unitMinor, currency: cur });
  }
  for (var k = 0; k < tiers.length; k += 1) {
    var t = tiers[k];
    var next = tiers[k + 1];
    var minQ = Number(t.min_quantity);
    var label = next ? (minQ + "–" + (Number(next.min_quantity) - 1)) : (minQ + "+");
    var unit = _discountedUnit(t.discount_kind, t.value, minQ);
    out.push({ label: label, unit_minor: unit, currency: cur });
  }
  return out;
}

