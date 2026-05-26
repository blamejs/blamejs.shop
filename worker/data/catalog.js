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

