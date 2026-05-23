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

export async function listActiveProducts(DB, opts) {
  opts = opts || {};
  var limit  = _clampLimit(opts.limit);
  var offset = _clampOffset(opts.offset);
  var listRes = await DB
    .prepare("SELECT * FROM products WHERE status = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2 OFFSET ?3")
    .bind("active", limit, offset)
    .all();
  var countRes = await DB
    .prepare("SELECT COUNT(*) AS n FROM products WHERE status = ?1")
    .bind("active")
    .first();
  var rows  = (listRes && listRes.results) ? listRes.results : [];
  var total = countRes && countRes.n != null ? Number(countRes.n) : 0;
  return { rows: rows, total: total };
}

export async function getProductBySlug(DB, slug) {
  if (typeof slug !== "string" || slug.length === 0) return null;
  var row = await DB
    .prepare("SELECT * FROM products WHERE slug = ?1 AND status = ?2")
    .bind(slug, "active")
    .first();
  return row || null;
}

export async function searchProducts(DB, opts) {
  opts = opts || {};
  if (typeof opts.q !== "string") return { rows: [] };
  var qTrim = opts.q.trim();
  if (qTrim.length === 0) return { rows: [] };
  var limit = _clampLimit(opts.limit);
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
      "SELECT * FROM products WHERE status = ?1 AND " +
      "(lower(title) LIKE ?2 ESCAPE '\\' OR lower(description) LIKE ?2 ESCAPE '\\') " +
      "ORDER BY updated_at DESC, id DESC LIMIT ?3"
    )
    .bind("active", pattern, limit)
    .all();
  var rows = (res && res.results) ? res.results : [];
  return { rows: rows };
}

export async function listVariantsForProduct(DB, productId) {
  if (typeof productId !== "string" || productId.length === 0) return { rows: [] };
  var res = await DB
    .prepare("SELECT * FROM variants WHERE product_id = ?1 ORDER BY position ASC, created_at ASC")
    .bind(productId)
    .all();
  var rows = (res && res.results) ? res.results : [];
  return { rows: rows };
}

export async function currentPrice(DB, variantId, currency) {
  if (typeof variantId !== "string" || variantId.length === 0) return null;
  if (typeof currency !== "string" || currency.length !== 3) return null;
  var row = await DB
    .prepare("SELECT * FROM prices WHERE variant_id = ?1 AND currency = ?2 AND effective_until IS NULL LIMIT 1")
    .bind(variantId, currency)
    .first();
  return row || null;
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
