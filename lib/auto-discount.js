"use strict";
/**
 * @module shop.autoDiscount
 * @title  Automatic discounts — operator-authored rules that apply to a
 *         cart without a coupon code
 *
 * @intro
 *   An automatic discount answers a single question during cart
 *   resolution:
 *
 *     "Given this cart (and optionally this customer), which rules
 *      should the cart-resolution layer apply, and what is each
 *      rule's monetary effect on this cart?"
 *
 *   Distinct from `couponStacking` (which decides per-code
 *   combination) and from `quantityDiscounts` (which decides per-line
 *   price breaks against the catalog scope graph). An autoDiscount
 *   rule is a CART-LEVEL automatic — "free shipping over $50", "10%
 *   off when you buy 3 items from category X", "BOGO on tag SALE" —
 *   that the shopper never types.
 *
 *   Surface:
 *
 *     - `defineRule({ slug, title, trigger, value, applies_to?,
 *                     customer_segment_in?, exclusions?,
 *                     priority?, starts_at?, expires_at?,
 *                     max_redemptions_total?,
 *                     max_redemptions_per_customer? })`
 *         Create a new rule. The primitive enforces a tight slug
 *         shape and validates `trigger` / `value` / `applies_to` /
 *         `exclusions` at define time against the open-ended JSON
 *         vocabularies described below.
 *
 *     - `evaluate({ cart, customer_id? })`
 *         Walks every active, non-archived, in-window rule in
 *         priority DESC order. For each rule whose trigger matches
 *         the cart, whose exclusions do not fire, whose segment
 *         (when specified) intersects the customer, and whose
 *         redemption caps are not exhausted, computes the rule's
 *         monetary effect and appends it to the result list.
 *         Returns `{ applied: [{ rule_slug, title, value_kind,
 *         savings_minor, free_shipping?, bogo_eligible? }],
 *         skipped: [{ rule_slug, reason }] }`. Multiple rules across
 *         different value kinds may apply on the same cart (an
 *         `amount_off_total` AND a `free_shipping` can coexist).
 *
 *     - `recordApplication({ rule_slug, order_id, savings_minor,
 *                            customer_id? })`
 *         Atomically increments the rule's denormalized
 *         `redemptions_used` counter and inserts a row into the
 *         `auto_discount_applications` event log. The cart-
 *         resolution layer calls this after the order commits so
 *         the cap check on subsequent `evaluate` calls sees the
 *         applied use.
 *
 *     - `metricsForRule({ rule_slug, from?, to? })`
 *         Returns `{ rule_slug, applications, gross_savings_minor,
 *         unique_customers }` aggregated across the requested time
 *         window. NULL `from` / `to` default to "all time".
 *
 *     - `listRules({ active_only?, limit? })` /
 *       `updateRule(slug, patch)` / `archiveRule(slug)`.
 *
 *   Trigger kinds (`trigger.kind`):
 *
 *     - `cart_total_min` — fires when `cart.subtotal_minor >=
 *       trigger.min_minor`. `min_minor` is a non-negative integer.
 *
 *     - `item_count_min` — fires when the sum of cart line
 *       quantities is `>= trigger.min_count`. `min_count` is a
 *       positive integer.
 *
 *     - `sku_purchase` — fires when the cart contains at least
 *       `trigger.min_quantity` units of any sku in `trigger.skus[]`.
 *       `min_quantity` defaults to 1; `skus` is a non-empty array
 *       of sku strings.
 *
 *   Value kinds (`value.kind`):
 *
 *     - `percent_off` — `value.basis_points` (0..10000) off the
 *       subtotal (or off the lines matched by `applies_to` when
 *       provided). Rounded half-away-from-zero to integer minor.
 *
 *     - `amount_off_total` — `value.minor` (positive integer) off
 *       the cart subtotal, clamped to the subtotal floor.
 *
 *     - `amount_off_each` — `value.minor` off each matched line
 *       unit (matched via `applies_to`, or every line when
 *       `applies_to` is null). Clamped at zero per unit.
 *
 *     - `free_shipping` — flags the cart as eligible for free
 *       shipping; the shipping primitive consults the flag.
 *       `savings_minor` reports the shipping cost the cart would
 *       have paid (cart provides `shipping_cost_minor` when known;
 *       0 otherwise — the storefront fills it after rate quotes).
 *
 *     - `bogo` — for every `value.buy_qty` units of an eligible
 *       line in the cart, the next `value.get_qty` units of that
 *       same line are free. `applies_to` (when provided) restricts
 *       eligibility; without it, every line is eligible
 *       independently. Returns `bogo_eligible: [{ sku, free_qty,
 *       savings_minor }]` so the cart layer renders the per-line
 *       BOGO breakdown.
 *
 *   Applies-to filter (`applies_to`, optional):
 *
 *     - `{ kind: "sku", values: [<sku>, ...] }` — match lines whose
 *       sku appears in the list.
 *
 *     - `{ kind: "category", values: [<cat>, ...] }` — match lines
 *       whose `category` field appears in the list, OR whose `tags`
 *       array contains any list entry. The line shape the cart
 *       provides may carry either form.
 *
 *     - NULL = "whole cart" (the value kind decides the surface
 *       — `percent_off` discounts the subtotal, `amount_off_each`
 *       discounts every line, etc.).
 *
 *   Exclusions:
 *
 *     - `{ kind: "sku", value: <sku> }` — if the cart contains the
 *       sku, the rule is skipped with `reason:
 *       "excluded_sku_present"`.
 *
 *     - `{ kind: "category", value: <cat> }` — if any line is
 *       tagged with the category, the rule is skipped with
 *       `reason: "excluded_category_present"`.
 *
 *   Composition:
 *
 *     - `catalog` (optional handle, shape:
 *       `getLineMeta(sku) -> Promise<{ category?, tags? }>`).
 *       Consulted ONLY when a rule's `applies_to.kind === "category"`
 *       or an exclusion's `kind === "category"` and the cart line
 *       did not embed the metadata directly. Most carts already
 *       carry `category` / `tags` on each line because they came
 *       from the catalog primitive in the same request; the handle
 *       is the fallback for line shapes that didn't.
 *
 *     - `customerSegments` (optional handle, shape:
 *       `isMember(customer_id, segment_slug) -> Promise<bool>`).
 *       Required only when at least one rule has a non-empty
 *       `customer_segment_in`; absent that, evaluate runs without
 *       consulting any segments handle.
 *
 *     - The `cart` argument is the storefront cart shape:
 *       `{ subtotal_minor, shipping_cost_minor?, lines: [{ sku,
 *       quantity, unit_price_minor, category?, tags? }] }`.
 *
 *   Storage:
 *
 *     - `auto_discount_rules` and `auto_discount_applications`
 *       (migration `0107_auto_discount.sql`).
 *
 * @primitive autoDiscount
 * @related   couponStacking, quantityDiscounts, customerSegments
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN              = 80;
var MAX_TITLE_LEN             = 200;
var MAX_SKU_LEN               = 128;
var MAX_CATEGORY_LEN          = 128;
var MAX_APPLIES_TO_VALUES     = 256;
var MAX_EXCLUSIONS            = 64;
var MAX_SEGMENT_SLUGS         = 32;
var MAX_SEGMENT_SLUG_LEN      = 64;
var MAX_TRIGGER_SKUS          = 256;
var MAX_PRIORITY              = 1000000;
var MAX_LIST_LIMIT            = 500;
var MAX_BASIS_POINTS          = 10000;
var MAX_MINOR_VALUE           = 1e12;
var MAX_BOGO_QTY              = 1000;
var MAX_UNLOCK_CODE_LEN       = 64;

// Slug shape — alnum + dot + hyphen + underscore, alnum leading.
var SLUG_RE         = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// Unlock-code shape — the string a shopper types on the cart page to
// unlock a code-gated rule. Same alnum + dot + hyphen + underscore family
// the couponStacking primitive accepts so the two surfaces agree on what a
// "code" is; refuses whitespace + control bytes.
var UNLOCK_CODE_RE  = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Sku shape — same family the catalog primitive uses (alnum + dot +
// hyphen + underscore + slash + colon), tight enough to refuse
// whitespace + control bytes.
var SKU_RE          = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// Category / tag — lowercase alnum + hyphen + underscore.
var CATEGORY_RE     = /^[a-z0-9][a-z0-9_-]{0,127}$/;
var SEGMENT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

var VALID_TRIGGER_KINDS = Object.freeze([
  "cart_total_min",
  "item_count_min",
  "sku_purchase",
]);

var VALID_VALUE_KINDS = Object.freeze([
  "percent_off",
  "amount_off_total",
  "amount_off_each",
  "free_shipping",
  "bogo",
]);

var VALID_APPLIES_TO_KINDS = Object.freeze(["sku", "category"]);

var VALID_EXCLUSION_KINDS = Object.freeze(["sku", "category"]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "trigger",
  "value",
  "applies_to",
  "customer_segment_in",
  "exclusions",
  "priority",
  "starts_at",
  "expires_at",
  "max_redemptions_total",
  "max_redemptions_per_customer",
  "active",
  "unlock_code",
]);

var b = require("./vendor/blamejs");

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("autoDiscount: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

// Optional shopper-typed code that gates a rule. null/"" clears it (the
// rule reverts to a pure automatic). A non-empty value must match the
// code shape; stored as authored, matched case-insensitively at evaluate.
function _unlockCode(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string" || !UNLOCK_CODE_RE.test(s)) {
    throw new TypeError("autoDiscount: unlock_code must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_UNLOCK_CODE_LEN + " chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("autoDiscount: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("autoDiscount: title must not contain control bytes");
  }
  return s;
}

function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("autoDiscount: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/ (<= " + MAX_SKU_LEN + " chars)");
  }
  return s;
}

function _category(s, label) {
  if (typeof s !== "string" || !CATEGORY_RE.test(s)) {
    throw new TypeError("autoDiscount: " + label + " must match /^[a-z0-9][a-z0-9_-]*$/ (<= " + MAX_CATEGORY_LEN + " chars)");
  }
  return s;
}

function _segmentSlug(s) {
  if (typeof s !== "string" || !SEGMENT_SLUG_RE.test(s)) {
    throw new TypeError("autoDiscount: customer_segment_in entries must match /^[a-z0-9][a-z0-9_-]*$/ (<= " + MAX_SEGMENT_SLUG_LEN + " chars)");
  }
  return s;
}

function _posInt(n, label, max) {
  if (!Number.isInteger(n) || n < 1 || n > (max || MAX_MINOR_VALUE)) {
    throw new TypeError("autoDiscount: " + label + " must be a positive integer (<= " + (max || MAX_MINOR_VALUE) + ")");
  }
  return n;
}

function _nonNegInt(n, label, max) {
  if (!Number.isInteger(n) || n < 0 || n > (max || MAX_MINOR_VALUE)) {
    throw new TypeError("autoDiscount: " + label + " must be a non-negative integer (<= " + (max || MAX_MINOR_VALUE) + ")");
  }
  return n;
}

function _priority(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) {
    throw new TypeError("autoDiscount: priority must be an integer in [0, " + MAX_PRIORITY + "]");
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("autoDiscount: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("autoDiscount: " + label + " must be a boolean");
  }
  return v;
}

function _trigger(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("autoDiscount: trigger must be an object");
  }
  if (VALID_TRIGGER_KINDS.indexOf(v.kind) === -1) {
    throw new TypeError("autoDiscount: trigger.kind must be one of " + JSON.stringify(VALID_TRIGGER_KINDS));
  }
  if (v.kind === "cart_total_min") {
    var minMinor = v.min_minor;
    if (minMinor == null) {
      throw new TypeError("autoDiscount: trigger.min_minor required for cart_total_min");
    }
    _nonNegInt(minMinor, "trigger.min_minor");
    return { kind: "cart_total_min", min_minor: minMinor };
  }
  if (v.kind === "item_count_min") {
    var minCount = v.min_count;
    if (minCount == null) {
      throw new TypeError("autoDiscount: trigger.min_count required for item_count_min");
    }
    _posInt(minCount, "trigger.min_count", 100000);
    return { kind: "item_count_min", min_count: minCount };
  }
  // sku_purchase
  if (!Array.isArray(v.skus) || v.skus.length === 0) {
    throw new TypeError("autoDiscount: trigger.skus must be a non-empty array");
  }
  if (v.skus.length > MAX_TRIGGER_SKUS) {
    throw new TypeError("autoDiscount: trigger.skus length " + v.skus.length + " exceeds cap " + MAX_TRIGGER_SKUS);
  }
  var seenSku = Object.create(null);
  var skus = [];
  for (var i = 0; i < v.skus.length; i += 1) {
    var s = _sku(v.skus[i], "trigger.skus[" + i + "]");
    if (seenSku[s]) {
      throw new TypeError("autoDiscount: trigger.skus contains duplicate " + JSON.stringify(s));
    }
    seenSku[s] = true;
    skus.push(s);
  }
  var minQty = v.min_quantity == null ? 1 : v.min_quantity;
  _posInt(minQty, "trigger.min_quantity", 100000);
  return { kind: "sku_purchase", skus: skus, min_quantity: minQty };
}

function _value(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("autoDiscount: value must be an object");
  }
  if (VALID_VALUE_KINDS.indexOf(v.kind) === -1) {
    throw new TypeError("autoDiscount: value.kind must be one of " + JSON.stringify(VALID_VALUE_KINDS));
  }
  if (v.kind === "percent_off") {
    var bp = v.basis_points;
    if (!Number.isInteger(bp) || bp < 1 || bp > MAX_BASIS_POINTS) {
      throw new TypeError("autoDiscount: value.basis_points must be an integer in [1, " + MAX_BASIS_POINTS + "]");
    }
    return { kind: "percent_off", basis_points: bp };
  }
  if (v.kind === "amount_off_total" || v.kind === "amount_off_each") {
    var minor = v.minor;
    if (!Number.isInteger(minor) || minor < 1 || minor > MAX_MINOR_VALUE) {
      throw new TypeError("autoDiscount: value.minor must be a positive integer (<= " + MAX_MINOR_VALUE + ")");
    }
    return { kind: v.kind, minor: minor };
  }
  if (v.kind === "free_shipping") {
    return { kind: "free_shipping" };
  }
  // bogo
  var buyQty = v.buy_qty;
  var getQty = v.get_qty;
  if (!Number.isInteger(buyQty) || buyQty < 1 || buyQty > MAX_BOGO_QTY) {
    throw new TypeError("autoDiscount: value.buy_qty must be a positive integer (<= " + MAX_BOGO_QTY + ")");
  }
  if (!Number.isInteger(getQty) || getQty < 1 || getQty > MAX_BOGO_QTY) {
    throw new TypeError("autoDiscount: value.get_qty must be a positive integer (<= " + MAX_BOGO_QTY + ")");
  }
  return { kind: "bogo", buy_qty: buyQty, get_qty: getQty };
}

function _appliesTo(v) {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("autoDiscount: applies_to must be an object or null");
  }
  if (VALID_APPLIES_TO_KINDS.indexOf(v.kind) === -1) {
    throw new TypeError("autoDiscount: applies_to.kind must be one of " + JSON.stringify(VALID_APPLIES_TO_KINDS));
  }
  if (!Array.isArray(v.values) || v.values.length === 0) {
    throw new TypeError("autoDiscount: applies_to.values must be a non-empty array");
  }
  if (v.values.length > MAX_APPLIES_TO_VALUES) {
    throw new TypeError("autoDiscount: applies_to.values length " + v.values.length + " exceeds cap " + MAX_APPLIES_TO_VALUES);
  }
  var seen = Object.create(null);
  var values = [];
  for (var i = 0; i < v.values.length; i += 1) {
    var entry = v.kind === "sku"
      ? _sku(v.values[i], "applies_to.values[" + i + "]")
      : _category(v.values[i], "applies_to.values[" + i + "]");
    if (seen[entry]) {
      throw new TypeError("autoDiscount: applies_to.values contains duplicate " + JSON.stringify(entry));
    }
    seen[entry] = true;
    values.push(entry);
  }
  return { kind: v.kind, values: values };
}

function _exclusions(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    throw new TypeError("autoDiscount: exclusions must be an array");
  }
  if (v.length > MAX_EXCLUSIONS) {
    throw new TypeError("autoDiscount: exclusions length " + v.length + " exceeds cap " + MAX_EXCLUSIONS);
  }
  var out = [];
  for (var i = 0; i < v.length; i += 1) {
    var e = v[i];
    if (!e || typeof e !== "object") {
      throw new TypeError("autoDiscount: exclusions[" + i + "] must be an object");
    }
    if (VALID_EXCLUSION_KINDS.indexOf(e.kind) === -1) {
      throw new TypeError("autoDiscount: exclusions[" + i + "].kind must be one of " + JSON.stringify(VALID_EXCLUSION_KINDS));
    }
    var val = e.kind === "sku"
      ? _sku(e.value, "exclusions[" + i + "].value")
      : _category(e.value, "exclusions[" + i + "].value");
    out.push({ kind: e.kind, value: val });
  }
  return out;
}

function _customerSegmentIn(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    throw new TypeError("autoDiscount: customer_segment_in must be an array of segment slugs");
  }
  if (v.length > MAX_SEGMENT_SLUGS) {
    throw new TypeError("autoDiscount: customer_segment_in length " + v.length + " exceeds cap " + MAX_SEGMENT_SLUGS);
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < v.length; i += 1) {
    var s = _segmentSlug(v[i]);
    if (seen[s]) {
      throw new TypeError("autoDiscount: customer_segment_in contains duplicate " + JSON.stringify(s));
    }
    seen[s] = true;
    out.push(s);
  }
  return out;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _safeParseObject(s) {
  if (s == null) return null;
  try {
    var parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (_e) {
    return null;
  }
}

function _safeParseArray(s) {
  if (s == null) return [];
  try {
    var parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (_e) {
    return [];
  }
}

function _hydrateRow(r) {
  if (!r) return null;
  return {
    slug:                          r.slug,
    title:                         r.title,
    trigger:                       _safeParseObject(r.trigger_json) || {},
    value:                         _safeParseObject(r.value_json)   || {},
    applies_to:                    _safeParseObject(r.applies_to_json),
    customer_segment_in:           _safeParseArray(r.customer_segment_in_json),
    exclusions:                    _safeParseArray(r.exclusions_json),
    priority:                      Number(r.priority),
    starts_at:                     r.starts_at  == null ? null : Number(r.starts_at),
    expires_at:                    r.expires_at == null ? null : Number(r.expires_at),
    max_redemptions_total:         r.max_redemptions_total == null ? null : Number(r.max_redemptions_total),
    max_redemptions_per_customer:  r.max_redemptions_per_customer == null ? null : Number(r.max_redemptions_per_customer),
    active:                        r.active === 1 || r.active === true,
    archived_at:                   r.archived_at == null ? null : Number(r.archived_at),
    redemptions_used:              Number(r.redemptions_used) || 0,
    unlock_code:                   r.unlock_code == null ? null : String(r.unlock_code),
    created_at:                    Number(r.created_at),
    updated_at:                    Number(r.updated_at),
  };
}

// ---- cart-shape reader (defensive) --------------------------------------

function _readCart(cart) {
  if (!cart || typeof cart !== "object") {
    throw new TypeError("autoDiscount: cart object required");
  }
  var subtotal = cart.subtotal_minor;
  if (subtotal == null) subtotal = 0;
  if (!Number.isInteger(subtotal) || subtotal < 0) {
    throw new TypeError("autoDiscount: cart.subtotal_minor must be a non-negative integer when present");
  }
  var shipping = cart.shipping_cost_minor;
  if (shipping == null) shipping = 0;
  if (!Number.isInteger(shipping) || shipping < 0) {
    throw new TypeError("autoDiscount: cart.shipping_cost_minor must be a non-negative integer when present");
  }
  var lines = cart.lines;
  if (lines == null) lines = [];
  if (!Array.isArray(lines)) {
    throw new TypeError("autoDiscount: cart.lines must be an array when present");
  }
  var normLines = [];
  for (var i = 0; i < lines.length; i += 1) {
    var L = lines[i];
    if (!L || typeof L !== "object") {
      throw new TypeError("autoDiscount: cart.lines[" + i + "] must be an object");
    }
    if (typeof L.sku !== "string" || !L.sku.length) {
      throw new TypeError("autoDiscount: cart.lines[" + i + "].sku required");
    }
    if (!Number.isInteger(L.quantity) || L.quantity < 1) {
      throw new TypeError("autoDiscount: cart.lines[" + i + "].quantity must be a positive integer");
    }
    if (!Number.isInteger(L.unit_price_minor) || L.unit_price_minor < 0) {
      throw new TypeError("autoDiscount: cart.lines[" + i + "].unit_price_minor must be a non-negative integer");
    }
    var tags = Array.isArray(L.tags) ? L.tags.slice() : [];
    normLines.push({
      sku:              L.sku,
      quantity:         L.quantity,
      unit_price_minor: L.unit_price_minor,
      category:         typeof L.category === "string" ? L.category : null,
      tags:             tags,
    });
  }
  return {
    subtotal_minor:      subtotal,
    shipping_cost_minor: shipping,
    lines:               normLines,
  };
}

// ---- line metadata resolver --------------------------------------------

// Returns the (category, tags) for a line. Prefers the line's
// embedded metadata; falls back to the catalog handle when wired and
// the line shape is sparse.
async function _resolveLineMeta(line, catalog) {
  var category = line.category;
  var tags     = Array.isArray(line.tags) ? line.tags : [];
  if (category != null || tags.length > 0) return { category: category, tags: tags };
  if (!catalog || typeof catalog.getLineMeta !== "function") return { category: null, tags: [] };
  try {
    var meta = await catalog.getLineMeta(line.sku);
    if (meta && typeof meta === "object") {
      return {
        category: typeof meta.category === "string" ? meta.category : null,
        tags:     Array.isArray(meta.tags) ? meta.tags : [],
      };
    }
  } catch (_e) {                                                              // drop-silent — best-effort enrichment; missing metadata collapses to "no match" which is the safe default
    return { category: null, tags: [] };
  }
  return { category: null, tags: [] };
}

function _lineMatches(lineMeta, sku, appliesTo) {
  if (!appliesTo) return true;
  if (appliesTo.kind === "sku") return appliesTo.values.indexOf(sku) !== -1;
  // category — match either L.category OR any tag in L.tags
  if (lineMeta.category != null && appliesTo.values.indexOf(lineMeta.category) !== -1) return true;
  for (var i = 0; i < lineMeta.tags.length; i += 1) {
    if (appliesTo.values.indexOf(lineMeta.tags[i]) !== -1) return true;
  }
  return false;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var catalog          = opts.catalog          || null;
  var customerSegments = opts.customerSegments || null;

  // ---- defineRule ----------------------------------------------------

  async function defineRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("autoDiscount.defineRule: input object required");
    }
    var slug                = _slug(input.slug);
    var title               = _title(input.title);
    var trigger             = _trigger(input.trigger);
    var value               = _value(input.value);
    var appliesTo           = _appliesTo(input.applies_to);
    var customerSegmentIn   = _customerSegmentIn(input.customer_segment_in);
    var exclusions          = _exclusions(input.exclusions);
    var priority            = input.priority == null ? 0 : _priority(input.priority);
    var startsAt            = input.starts_at  == null ? null : _epochMs(input.starts_at, "starts_at");
    var expiresAt           = input.expires_at == null ? null : _epochMs(input.expires_at, "expires_at");
    if (startsAt != null && expiresAt != null && expiresAt <= startsAt) {
      throw new TypeError("autoDiscount.defineRule: expires_at must be greater than starts_at");
    }
    var maxTotal            = input.max_redemptions_total        == null ? null : _nonNegInt(input.max_redemptions_total,        "max_redemptions_total");
    var maxPerCustomer      = input.max_redemptions_per_customer == null ? null : _nonNegInt(input.max_redemptions_per_customer, "max_redemptions_per_customer");
    var unlockCode          = _unlockCode(input.unlock_code);

    var existing = (await query(
      "SELECT slug FROM auto_discount_rules WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("autoDiscount.defineRule: slug " + JSON.stringify(slug) + " already exists -- use updateRule");
    }
    // Reject a duplicate active code up front so the caller gets a clean
    // TypeError rather than a raw UNIQUE-constraint bubble. The partial
    // unique index is the authoritative guard; this is the friendly check.
    if (unlockCode != null) {
      var clash = (await query(
        "SELECT slug FROM auto_discount_rules " +
        "WHERE lower(unlock_code) = lower(?1) AND archived_at IS NULL LIMIT 1",
        [unlockCode],
      )).rows[0];
      if (clash) {
        throw new TypeError("autoDiscount.defineRule: unlock_code " + JSON.stringify(unlockCode) +
          " already claimed by an active rule");
      }
    }

    var ts = _now();
    await query(
      "INSERT INTO auto_discount_rules (slug, title, trigger_json, value_json, applies_to_json, " +
      "customer_segment_in_json, exclusions_json, priority, starts_at, expires_at, " +
      "max_redemptions_total, max_redemptions_per_customer, active, archived_at, " +
      "redemptions_used, unlock_code, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, NULL, 0, ?13, ?14, ?14)",
      [
        slug,
        title,
        JSON.stringify(trigger),
        JSON.stringify(value),
        appliesTo == null ? null : JSON.stringify(appliesTo),
        JSON.stringify(customerSegmentIn),
        JSON.stringify(exclusions),
        priority,
        startsAt,
        expiresAt,
        maxTotal,
        maxPerCustomer,
        unlockCode,
        ts,
      ],
    );
    return await getRule(slug);
  }

  // ---- getRule / listRules -------------------------------------------

  async function getRule(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM auto_discount_rules WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function listRules(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      activeOnly = _bool(listOpts.active_only, "active_only");
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("autoDiscount.listRules: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql;
    if (activeOnly) {
      sql = "SELECT * FROM auto_discount_rules WHERE active = 1 AND archived_at IS NULL " +
            "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
    } else {
      sql = "SELECT * FROM auto_discount_rules " +
            "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
    }
    var rows = (await query(sql, [limit])).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRow(rows[i]));
    return out;
  }

  // ---- updateRule ----------------------------------------------------

  async function updateRule(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("autoDiscount.updateRule: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("autoDiscount.updateRule: patch must include at least one column");
    }
    var current = await getRule(slug);
    if (!current) {
      throw new TypeError("autoDiscount.updateRule: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("autoDiscount.updateRule: unsupported column " + JSON.stringify(col));
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
      } else if (col === "trigger") {
        sets.push("trigger_json = ?" + idx);
        params.push(JSON.stringify(_trigger(patch[col])));
      } else if (col === "value") {
        sets.push("value_json = ?" + idx);
        params.push(JSON.stringify(_value(patch[col])));
      } else if (col === "applies_to") {
        var at = _appliesTo(patch[col]);
        sets.push("applies_to_json = ?" + idx);
        params.push(at == null ? null : JSON.stringify(at));
      } else if (col === "customer_segment_in") {
        sets.push("customer_segment_in_json = ?" + idx);
        params.push(JSON.stringify(_customerSegmentIn(patch[col])));
      } else if (col === "exclusions") {
        sets.push("exclusions_json = ?" + idx);
        params.push(JSON.stringify(_exclusions(patch[col])));
      } else if (col === "priority") {
        sets.push("priority = ?" + idx);
        params.push(_priority(patch[col]));
      } else if (col === "starts_at") {
        sets.push("starts_at = ?" + idx);
        params.push(patch[col] == null ? null : _epochMs(patch[col], "starts_at"));
      } else if (col === "expires_at") {
        sets.push("expires_at = ?" + idx);
        params.push(patch[col] == null ? null : _epochMs(patch[col], "expires_at"));
      } else if (col === "max_redemptions_total") {
        sets.push("max_redemptions_total = ?" + idx);
        params.push(patch[col] == null ? null : _nonNegInt(patch[col], "max_redemptions_total"));
      } else if (col === "max_redemptions_per_customer") {
        sets.push("max_redemptions_per_customer = ?" + idx);
        params.push(patch[col] == null ? null : _nonNegInt(patch[col], "max_redemptions_per_customer"));
      } else if (col === "unlock_code") {
        var nextCode = _unlockCode(patch[col]);
        if (nextCode != null) {
          // Don't let an update steal another active rule's code. A
          // re-assert of THIS rule's own code is fine (the clash row is
          // itself).
          var codeClash = (await query(
            "SELECT slug FROM auto_discount_rules " +
            "WHERE lower(unlock_code) = lower(?1) AND archived_at IS NULL AND slug != ?2 LIMIT 1",
            [nextCode, slug],
          )).rows[0];
          if (codeClash) {
            throw new TypeError("autoDiscount.updateRule: unlock_code " + JSON.stringify(nextCode) +
              " already claimed by an active rule");
          }
        }
        sets.push("unlock_code = ?" + idx);
        params.push(nextCode);
      } else /* active */ {
        sets.push("active = ?" + idx);
        params.push(_bool(patch[col], "active") ? 1 : 0);
      }
      idx += 1;
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE auto_discount_rules SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("autoDiscount.updateRule: slug " + JSON.stringify(slug) + " not found");
    }
    return await getRule(slug);
  }

  // ---- archiveRule ---------------------------------------------------

  async function archiveRule(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE auto_discount_rules SET archived_at = ?1, active = 0, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getRule(slug);
      if (!existing) {
        throw new TypeError("autoDiscount.archiveRule: slug " + JSON.stringify(slug) + " not found");
      }
      // Idempotent — already archived.
      return existing;
    }
    return await getRule(slug);
  }

  // ---- ruleForCode ---------------------------------------------------

  // Resolve a shopper-typed code to its active, code-gated rule (the row
  // whose unlock_code matches case-insensitively, not archived). Returns
  // the hydrated rule or null when no active rule claims the code. The
  // cart-page coupon entry calls this to validate a typed code before
  // persisting it — a non-empty result means "this is a real code"; null
  // is the uniform "unknown code" answer. A malformed code (whitespace /
  // control bytes / over-length) returns null rather than throwing, so the
  // cart route gives one message for "doesn't match a rule" regardless of
  // whether the input was garbage or simply unknown (no code-shape oracle).
  async function ruleForCode(code) {
    if (typeof code !== "string" || !UNLOCK_CODE_RE.test(code)) return null;
    var r = (await query(
      "SELECT * FROM auto_discount_rules " +
      "WHERE lower(unlock_code) = lower(?1) AND active = 1 AND archived_at IS NULL " +
      "  AND (starts_at IS NULL OR starts_at <= ?2) " +
      "  AND (expires_at IS NULL OR expires_at > ?2) " +
      "LIMIT 1",
      [code, _now()],
    )).rows[0];
    return _hydrateRow(r);
  }

  // ---- evaluate ------------------------------------------------------

  async function evaluate(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("autoDiscount.evaluate: input object required");
    }
    var cart = _readCart(input.cart);
    var customerId = input.customer_id == null ? null : input.customer_id;
    if (customerId != null && (typeof customerId !== "string" || !customerId.length)) {
      throw new TypeError("autoDiscount.evaluate: customer_id must be a non-empty string when provided");
    }
    // Shopper-presented codes that unlock code-gated rules. A defensive
    // request-shape reader: any non-string / malformed entry is dropped
    // (never throws on the buy path), each kept entry is lower-cased into a
    // lookup set so the code gate is a case-insensitive membership test. A
    // pure-automatic rule (unlock_code IS NULL) ignores this set entirely.
    var presentedCodes = Object.create(null);
    if (input.codes != null) {
      if (!Array.isArray(input.codes)) {
        throw new TypeError("autoDiscount.evaluate: codes must be an array when provided");
      }
      for (var pc = 0; pc < input.codes.length; pc += 1) {
        var raw = input.codes[pc];
        if (typeof raw === "string" && raw.length) presentedCodes[raw.toLowerCase()] = true;
      }
    }

    var ts = _now();
    var rows = (await query(
      "SELECT * FROM auto_discount_rules " +
      "WHERE active = 1 AND archived_at IS NULL " +
      "  AND (starts_at  IS NULL OR starts_at  <= ?1) " +
      "  AND (expires_at IS NULL OR expires_at >  ?1) " +
      "ORDER BY priority DESC, created_at ASC, slug ASC",
      [ts],
    )).rows;

    // Build a sku -> total-quantity index once per evaluate call.
    var skuTotals = Object.create(null);
    var itemCount = 0;
    for (var li = 0; li < cart.lines.length; li += 1) {
      var L = cart.lines[li];
      skuTotals[L.sku] = (skuTotals[L.sku] || 0) + L.quantity;
      itemCount += L.quantity;
    }

    // Eager line-meta resolution — only consulted when the catalog
    // handle is wired and a rule needs category data. Cached across
    // rules in this evaluate call.
    var lineMetaCache = {};
    async function _metaFor(line) {
      if (Object.prototype.hasOwnProperty.call(lineMetaCache, line.sku)) {
        return lineMetaCache[line.sku];
      }
      var m = await _resolveLineMeta(line, catalog);
      lineMetaCache[line.sku] = m;
      return m;
    }

    var applied = [];
    var skipped = [];

    for (var ri = 0; ri < rows.length; ri += 1) {
      var rule = _hydrateRow(rows[ri]);

      // 0. Code gate — a rule with an unlock_code is dormant until the
      // shopper presents that code (case-insensitive). A pure-automatic
      // rule (unlock_code IS NULL) skips this gate and fires on shape alone,
      // so the legacy code-less behaviour is unchanged.
      if (rule.unlock_code != null && !presentedCodes[rule.unlock_code.toLowerCase()]) {
        skipped.push({ rule_slug: rule.slug, reason: "unlock_code_not_presented" });
        continue;
      }

      // 1. Total-redemption cap
      if (rule.max_redemptions_total != null && rule.redemptions_used >= rule.max_redemptions_total) {
        skipped.push({ rule_slug: rule.slug, reason: "max_redemptions_total_reached" });
        continue;
      }

      // 2. Per-customer redemption cap — only evaluable when customer_id present.
      if (rule.max_redemptions_per_customer != null) {
        if (customerId == null) {
          skipped.push({ rule_slug: rule.slug, reason: "per_customer_cap_requires_customer" });
          continue;
        }
        var capRow = (await query(
          "SELECT COUNT(*) AS used FROM auto_discount_applications " +
          "WHERE rule_slug = ?1 AND customer_id = ?2",
          [rule.slug, customerId],
        )).rows[0] || {};
        var usedByCustomer = Number(capRow.used) || 0;
        if (usedByCustomer >= rule.max_redemptions_per_customer) {
          skipped.push({ rule_slug: rule.slug, reason: "max_redemptions_per_customer_reached" });
          continue;
        }
      }

      // 3. Segment gate
      if (rule.customer_segment_in.length > 0) {
        if (customerId == null) {
          skipped.push({ rule_slug: rule.slug, reason: "segment_gate_requires_customer" });
          continue;
        }
        if (!customerSegments) {
          throw new TypeError("autoDiscount: rule " + JSON.stringify(rule.slug) +
            " has a customer_segment_in gate but no customerSegments handle was wired into create()");
        }
        if (typeof customerSegments.isMember !== "function") {
          throw new TypeError("autoDiscount: customerSegments handle must expose isMember(customer_id, segment_slug)");
        }
        var matched = false;
        for (var sj = 0; sj < rule.customer_segment_in.length; sj += 1) {
          if (await customerSegments.isMember(customerId, rule.customer_segment_in[sj])) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          skipped.push({ rule_slug: rule.slug, reason: "customer_not_in_segment" });
          continue;
        }
      }

      // 4. Exclusions
      var excluded = false;
      var excludeReason = null;
      for (var xi = 0; xi < rule.exclusions.length; xi += 1) {
        var ex = rule.exclusions[xi];
        if (ex.kind === "sku") {
          if (skuTotals[ex.value] > 0) {
            excluded = true;
            excludeReason = "excluded_sku_present";
            break;
          }
        } else /* category */ {
          for (var ci = 0; ci < cart.lines.length; ci += 1) {
            var cmeta = await _metaFor(cart.lines[ci]);
            if (cmeta.category === ex.value || cmeta.tags.indexOf(ex.value) !== -1) {
              excluded = true;
              excludeReason = "excluded_category_present";
              break;
            }
          }
          if (excluded) break;
        }
      }
      if (excluded) {
        skipped.push({ rule_slug: rule.slug, reason: excludeReason });
        continue;
      }

      // 5. Trigger
      var triggered = false;
      if (rule.trigger.kind === "cart_total_min") {
        triggered = cart.subtotal_minor >= (rule.trigger.min_minor || 0);
      } else if (rule.trigger.kind === "item_count_min") {
        triggered = itemCount >= (rule.trigger.min_count || 1);
      } else /* sku_purchase */ {
        var needed = rule.trigger.min_quantity || 1;
        var skus = rule.trigger.skus || [];
        for (var ti = 0; ti < skus.length; ti += 1) {
          if ((skuTotals[skus[ti]] || 0) >= needed) { triggered = true; break; }
        }
      }
      if (!triggered) {
        skipped.push({ rule_slug: rule.slug, reason: "trigger_not_met" });
        continue;
      }

      // 6. Compute monetary effect
      var savingsMinor = 0;
      var freeShipping = false;
      var bogoEligible = null;

      if (rule.value.kind === "percent_off") {
        // applies_to restricts the base; default base is subtotal.
        var base = 0;
        if (!rule.applies_to) {
          base = cart.subtotal_minor;
        } else {
          for (var pi = 0; pi < cart.lines.length; pi += 1) {
            var pLine = cart.lines[pi];
            var pMeta = await _metaFor(pLine);
            if (_lineMatches(pMeta, pLine.sku, rule.applies_to)) {
              base += pLine.unit_price_minor * pLine.quantity;
            }
          }
        }
        // Half-away-from-zero round to integer minor. Exact BigInt
        // math — base and basis_points are integers, so a JS float
        // multiply would drift on large carts; the round happens once
        // on the integer numerator. base is non-negative here (subtotal
        // or a sum of unit_price*qty), so half-away equals half-up:
        // floor((base*bps + 5000) / 10000).
        var num = BigInt(base) * BigInt(rule.value.basis_points);
        savingsMinor = num >= 0n
          ? Number((num + 5000n) / 10000n)
          : -Number((-num + 5000n) / 10000n);
        if (savingsMinor > base) savingsMinor = base;
      } else if (rule.value.kind === "amount_off_total") {
        savingsMinor = rule.value.minor;
        if (savingsMinor > cart.subtotal_minor) savingsMinor = cart.subtotal_minor;
      } else if (rule.value.kind === "amount_off_each") {
        for (var ei = 0; ei < cart.lines.length; ei += 1) {
          var eLine = cart.lines[ei];
          var eMeta = await _metaFor(eLine);
          if (!_lineMatches(eMeta, eLine.sku, rule.applies_to)) continue;
          var perUnit = rule.value.minor;
          if (perUnit > eLine.unit_price_minor) perUnit = eLine.unit_price_minor;
          savingsMinor += perUnit * eLine.quantity;
        }
      } else if (rule.value.kind === "free_shipping") {
        freeShipping = true;
        savingsMinor = cart.shipping_cost_minor;
      } else /* bogo */ {
        bogoEligible = [];
        for (var bi = 0; bi < cart.lines.length; bi += 1) {
          var bLine = cart.lines[bi];
          var bMeta = await _metaFor(bLine);
          if (!_lineMatches(bMeta, bLine.sku, rule.applies_to)) continue;
          var groupSize = rule.value.buy_qty + rule.value.get_qty;
          var fullGroups = Math.floor(bLine.quantity / groupSize);
          var freeUnits  = fullGroups * rule.value.get_qty;
          if (freeUnits === 0) continue;
          var lineSavings = freeUnits * bLine.unit_price_minor;
          savingsMinor += lineSavings;
          bogoEligible.push({
            sku:            bLine.sku,
            free_qty:       freeUnits,
            savings_minor:  lineSavings,
          });
        }
        if (bogoEligible.length === 0) {
          // BOGO triggered (e.g. total-min) but no eligible line had a
          // full buy+get group — surface as skipped rather than
          // appending a zero-savings entry.
          skipped.push({ rule_slug: rule.slug, reason: "bogo_no_eligible_group" });
          continue;
        }
      }

      // Zero-savings rules (percent_off on a $0 matched base, etc.)
      // don't earn a slot — they would noise the cart layer with
      // entries that do nothing. The free_shipping flag is an
      // exception: a rule that switches shipping off still ships
      // even if shipping_cost_minor is zero, because downstream rate
      // quotes may re-resolve.
      if (savingsMinor <= 0 && !freeShipping) {
        skipped.push({ rule_slug: rule.slug, reason: "zero_savings" });
        continue;
      }

      var entry = {
        rule_slug:      rule.slug,
        title:          rule.title,
        value_kind:     rule.value.kind,
        savings_minor:  savingsMinor,
      };
      if (freeShipping) entry.free_shipping = true;
      if (bogoEligible) entry.bogo_eligible = bogoEligible;
      applied.push(entry);
    }

    return { applied: applied, skipped: skipped };
  }

  // ---- recordApplication --------------------------------------------

  async function recordApplication(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("autoDiscount.recordApplication: input object required");
    }
    var slug    = _slug(input.rule_slug);
    var orderId = input.order_id;
    if (typeof orderId !== "string" || !orderId.length || orderId.length > 128) {
      throw new TypeError("autoDiscount.recordApplication: order_id must be a non-empty string (<= 128 chars)");
    }
    var savings = input.savings_minor;
    _nonNegInt(savings, "savings_minor");
    var customerId = input.customer_id == null ? null : input.customer_id;
    if (customerId != null && (typeof customerId !== "string" || !customerId.length)) {
      throw new TypeError("autoDiscount.recordApplication: customer_id must be a non-empty string when provided");
    }
    var appliedAt = input.applied_at == null ? _now() : _epochMs(input.applied_at, "applied_at");

    // Confirm the rule exists. Inserting against a non-existent slug
    // would be refused by the FK anyway; we want the typed error.
    var rule = await getRule(slug);
    if (!rule) {
      throw new TypeError("autoDiscount.recordApplication: rule_slug " + JSON.stringify(slug) + " not found");
    }

    // Idempotent per (rule, order): the unique index (migration 0231)
    // makes a re-delivered record a no-op, and the redemption counter
    // only advances when this call actually created the row — a retry
    // can never double-count a cap.
    var id = b.uuid.v7();
    var ins = await query(
      "INSERT INTO auto_discount_applications (id, rule_slug, order_id, customer_id, savings_minor, applied_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
      "ON CONFLICT(rule_slug, order_id) DO NOTHING",
      [id, slug, orderId, customerId, savings, appliedAt],
    );
    if (Number(ins.rowCount || 0) === 1) {
      await query(
        "UPDATE auto_discount_rules SET redemptions_used = redemptions_used + 1, updated_at = ?1 WHERE slug = ?2",
        [_now(), slug],
      );
    }
    return {
      id:             id,
      rule_slug:      slug,
      order_id:       orderId,
      customer_id:    customerId,
      savings_minor:  savings,
      applied_at:     appliedAt,
    };
  }

  // ---- pre-charge redemption claims -----------------------------------
  //
  // A capped rule is a finite resource, so checkout RESERVES it before any
  // money moves — the same reserve-then-settle discipline inventory holds
  // follow — instead of best-effort recording after the fact (which let a
  // single-use code apply to every concurrent order: the cap was only ever
  // read at quote time and incremented unconditionally post-commit).
  //
  //   claimRedemption  — atomically reserve one redemption under BOTH caps,
  //                      writing the application row up front keyed by a
  //                      caller-supplied claim ref (the order doesn't exist
  //                      yet). Fails CLOSED: { claimed: false, reason }.
  //   linkClaimToOrder — re-key the claim row to the real order id once the
  //                      order exists.
  //   releaseClaim     — compensation for a checkout that died before its
  //                      order existed: delete the claim row and return the
  //                      reservation to the counter (floored at 0).
  //
  // The per-customer cap is enforced INSIDE the claim INSERT (a correlated
  // COUNT in the WHERE), and the total cap inside a guarded UPDATE — both
  // single statements, so concurrent claims serialize at the database and
  // the loser is refused rather than both passing a stale read. A re-claim
  // with the SAME (rule, claim_ref) — a checkout retry whose earlier
  // rollback didn't complete — reuses the existing claim instead of
  // double-reserving.

  async function claimRedemption(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("autoDiscount.claimRedemption: input object required");
    }
    var slug     = _slug(input.rule_slug);
    var claimRef = input.claim_ref;
    if (typeof claimRef !== "string" || !claimRef.length || claimRef.length > 128) {
      throw new TypeError("autoDiscount.claimRedemption: claim_ref must be a non-empty string (<= 128 chars)");
    }
    var savings = input.savings_minor == null ? 0 : input.savings_minor;
    _nonNegInt(savings, "savings_minor");
    var customerId = input.customer_id == null ? null : input.customer_id;
    if (customerId != null && (typeof customerId !== "string" || !customerId.length)) {
      throw new TypeError("autoDiscount.claimRedemption: customer_id must be a non-empty string when provided");
    }
    var rule = await getRule(slug);
    if (!rule) {
      throw new TypeError("autoDiscount.claimRedemption: rule_slug " + JSON.stringify(slug) + " not found");
    }
    var ts = _now();

    // A claim this checkout already holds (a retry whose earlier rollback
    // didn't complete) is reused, not re-reserved — its counter increment
    // was already paid and its row already passed the caps.
    var existing = (await query(
      "SELECT id FROM auto_discount_applications WHERE rule_slug = ?1 AND order_id = ?2",
      [slug, claimRef],
    )).rows[0];
    if (existing) {
      return { claimed: true, id: existing.id, reused: true };
    }

    // Reserve against the TOTAL cap first — one guarded atomic increment;
    // a refused update means the cap is exhausted (or was won by a
    // concurrent claim, which is the same answer).
    var counter = await query(
      "UPDATE auto_discount_rules SET redemptions_used = redemptions_used + 1, updated_at = ?1 " +
      "WHERE slug = ?2 AND (max_redemptions_total IS NULL OR redemptions_used < max_redemptions_total)",
      [ts, slug],
    );
    if (Number(counter.rowCount || 0) === 0) {
      return { claimed: false, reason: "total-cap" };
    }

    // Write the claim row gated on the PER-CUSTOMER cap — the COUNT runs
    // inside the INSERT's WHERE, so two concurrent claims for the same
    // customer serialize at the database and the loser is refused. A guest
    // claim (no customer id) has no per-customer bound to enforce.
    var id = b.uuid.v7();
    var ins;
    try {
      ins = await query(
        "INSERT INTO auto_discount_applications (id, rule_slug, order_id, customer_id, savings_minor, applied_at) " +
        "SELECT ?1, ?2, ?3, ?4, ?5, ?6 " +
        "WHERE ?4 IS NULL OR ?7 IS NULL OR " +
        "(SELECT COUNT(*) FROM auto_discount_applications WHERE rule_slug = ?2 AND customer_id = ?4) < ?7",
        [id, slug, claimRef, customerId, savings, ts, rule.max_redemptions_per_customer],
      );
    } catch (e) {
      // UNIQUE(rule_slug, order_id) collision: this checkout already holds
      // a claim from a prior attempt whose rollback didn't complete —
      // reuse it (its counter reservation was already paid), after
      // returning the increment this call just took.
      //
      // State-agnostic collision detection — never error-message matching.
      // The production D1 service-binding redacts the SQLite "UNIQUE
      // constraint failed" text to a generic "HTTP 500", so a message regex
      // is blind in prod (it only matches under node:sqlite). Re-read by the
      // colliding UNIQUE key (rule_slug, order_id): if a row now exists the
      // failure WAS the collision, so reuse it; otherwise the insert failed
      // for another reason, so re-throw (without returning the increment).
      var held = (await query(
        "SELECT id FROM auto_discount_applications WHERE rule_slug = ?1 AND order_id = ?2",
        [slug, claimRef],
      )).rows[0];
      if (held) {
        await query(
          "UPDATE auto_discount_rules SET redemptions_used = " +
          "CASE WHEN redemptions_used > 0 THEN redemptions_used - 1 ELSE 0 END, updated_at = ?1 WHERE slug = ?2",
          [_now(), slug],
        );
        return { claimed: true, id: held.id, reused: true };
      }
      throw e;
    }
    if (Number(ins.rowCount || 0) === 0) {
      // Per-customer cap refused — return the total-cap reservation.
      await query(
        "UPDATE auto_discount_rules SET redemptions_used = " +
        "CASE WHEN redemptions_used > 0 THEN redemptions_used - 1 ELSE 0 END, updated_at = ?1 WHERE slug = ?2",
        [_now(), slug],
      );
      return { claimed: false, reason: "customer-cap" };
    }
    return { claimed: true, id: id };
  }

  async function linkClaimToOrder(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("autoDiscount.linkClaimToOrder: input object required");
    }
    var slug     = _slug(input.rule_slug);
    var claimRef = input.claim_ref;
    var orderId  = input.order_id;
    if (typeof claimRef !== "string" || !claimRef.length) {
      throw new TypeError("autoDiscount.linkClaimToOrder: claim_ref must be a non-empty string");
    }
    if (typeof orderId !== "string" || !orderId.length || orderId.length > 128) {
      throw new TypeError("autoDiscount.linkClaimToOrder: order_id must be a non-empty string (<= 128 chars)");
    }
    var res = await query(
      "UPDATE auto_discount_applications SET order_id = ?1 WHERE rule_slug = ?2 AND order_id = ?3",
      [orderId, slug, claimRef],
    );
    return Number(res.rowCount || 0) === 1;
  }

  async function releaseClaim(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("autoDiscount.releaseClaim: input object required");
    }
    var slug     = _slug(input.rule_slug);
    var claimRef = input.claim_ref;
    if (typeof claimRef !== "string" || !claimRef.length) {
      throw new TypeError("autoDiscount.releaseClaim: claim_ref must be a non-empty string");
    }
    // Delete-then-decrement, each guarded: the delete's rowCount is the
    // claim's existence check (a double release finds no row and stops),
    // and the decrement floors at zero so a release can never drive the
    // counter negative.
    var del = await query(
      "DELETE FROM auto_discount_applications WHERE rule_slug = ?1 AND order_id = ?2",
      [slug, claimRef],
    );
    if (Number(del.rowCount || 0) === 0) return false;
    await query(
      "UPDATE auto_discount_rules SET redemptions_used = " +
      "CASE WHEN redemptions_used > 0 THEN redemptions_used - 1 ELSE 0 END, updated_at = ?1 WHERE slug = ?2",
      [_now(), slug],
    );
    return true;
  }

  // ---- metricsForRule ------------------------------------------------

  async function metricsForRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("autoDiscount.metricsForRule: input object required");
    }
    var slug = _slug(input.rule_slug);
    var from = input.from == null ? null : _epochMs(input.from, "from");
    var to   = input.to   == null ? null : _epochMs(input.to,   "to");
    if (from != null && to != null && to <= from) {
      throw new TypeError("autoDiscount.metricsForRule: to must be greater than from");
    }
    var rule = await getRule(slug);
    if (!rule) {
      throw new TypeError("autoDiscount.metricsForRule: rule_slug " + JSON.stringify(slug) + " not found");
    }
    var sql = "SELECT COUNT(*) AS applications, " +
              "       COALESCE(SUM(savings_minor), 0) AS gross_savings_minor, " +
              "       COUNT(DISTINCT customer_id) AS unique_customers " +
              "  FROM auto_discount_applications " +
              " WHERE rule_slug = ?1";
    var params = [slug];
    var idx = 2;
    if (from != null) { sql += " AND applied_at >= ?" + idx; params.push(from); idx += 1; }
    if (to   != null) { sql += " AND applied_at <  ?" + idx; params.push(to);   idx += 1; }
    var row = (await query(sql, params)).rows[0] || {};
    return {
      rule_slug:            slug,
      applications:         Number(row.applications)        || 0,
      gross_savings_minor:  Number(row.gross_savings_minor) || 0,
      unique_customers:     Number(row.unique_customers)    || 0,
    };
  }

  return {
    defineRule:         defineRule,
    getRule:            getRule,
    listRules:          listRules,
    updateRule:         updateRule,
    archiveRule:        archiveRule,
    ruleForCode:        ruleForCode,
    evaluate:           evaluate,
    recordApplication:  recordApplication,
    claimRedemption:    claimRedemption,
    linkClaimToOrder:   linkClaimToOrder,
    releaseClaim:       releaseClaim,
    metricsForRule:     metricsForRule,
  };
}

module.exports = {
  create:                  create,
  VALID_TRIGGER_KINDS:     VALID_TRIGGER_KINDS,
  VALID_VALUE_KINDS:       VALID_VALUE_KINDS,
  VALID_APPLIES_TO_KINDS:  VALID_APPLIES_TO_KINDS,
  VALID_EXCLUSION_KINDS:   VALID_EXCLUSION_KINDS,
  ALLOWED_PATCH_COLUMNS:   ALLOWED_PATCH_COLUMNS,
  MAX_APPLIES_TO_VALUES:   MAX_APPLIES_TO_VALUES,
  MAX_TRIGGER_SKUS:        MAX_TRIGGER_SKUS,
};
