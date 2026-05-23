"use strict";
/**
 * @module shop.promoBundles
 * @title  Time-limited promotional bundles — windowed, single-price
 *         multi-component offers distinct from kit-product bundles.
 *
 * @intro
 *   A promo bundle is a marketing campaign, not a virtual SKU. The
 *   operator stages a bundle ("Holiday 3-Pack: $99 for skus A+B+C —
 *   save 25% vs. individual"), the bundle exists only during a
 *   [starts_at, expires_at) wall-clock window, and cart-resolution
 *   recognizes the bundle when all components are present in the cart
 *   at the required quantities and swaps the matching line totals for
 *   the bundle's single fixed price.
 *
 *   Distinct from the `bundles` primitive:
 *
 *     - `bundles` ships a virtual SKU the customer adds as a single
 *       line — a kit product. The line resolves to N child SKUs at
 *       expand-time. The bundle price is derived from the children's
 *       prices plus an optional basis-points discount.
 *
 *     - `promoBundles` is detected, not added. The customer adds the
 *       individual components; the cart-resolution layer scans active
 *       promo bundles for ones whose component set is satisfied by the
 *       current cart and offers the operator-chosen `bundle_price_minor`
 *       in place of the sum of individual line prices. Outside the
 *       window the bundle does not exist for the resolver.
 *
 *   Lifecycle:
 *
 *     - `defineBundle({ slug, title, components, bundle_price_minor,
 *                       currency, starts_at, expires_at,
 *                       max_redemptions_total?, max_per_customer? })`
 *       — operator-authored campaign. Components are an array of
 *       `{ sku, quantity }` rows; duplicates and non-positive
 *       quantities are refused. `starts_at < expires_at` is required;
 *       a zero-length or inverted window is refused at define time.
 *
 *     - `detectInCart({ cart })` — pure read. Returns every active,
 *       not-yet-capped promo bundle whose every component sku appears
 *       in the cart at >= the required quantity, plus the
 *       `savings_minor` delta the bundle would apply (sum of the
 *       matched lines' `unit_amount_minor * quantity_consumed` minus
 *       the bundle's `bundle_price_minor`). Bundles whose savings are
 *       <= 0 are still returned; the caller decides whether to surface
 *       them.
 *
 *     - `applyBundleToCart({ cart, bundle_slug })` — pure transform.
 *       Returns a NEW cart object with the matched lines consumed
 *       (their quantities reduced by the consumed amount; lines that
 *       hit zero are dropped) and a synthetic `bundle:<slug>` line
 *       added carrying the bundle's price + currency. Does NOT
 *       mutate the input cart and does NOT write a redemption row —
 *       the caller composes `recordRedemption` from the checkout /
 *       order finalize path so the redemption count only ticks when
 *       the cart actually converts.
 *
 *     - `recordRedemption({ slug, order_id, customer_id?,
 *                           savings_minor })` — writes the audit row
 *       and increments `redemptions_used`. Refuses past
 *       `max_redemptions_total` (the cap is checked under the same
 *       statement that increments the counter via a guarded UPDATE so
 *       two simultaneous checkouts cannot both succeed on the final
 *       slot). UNIQUE(slug, order_id) gives idempotency — replaying a
 *       redemption for the same order is a no-op that returns the
 *       existing row.
 *
 *     - `updateBundle(slug, patch)` — operator can extend the window,
 *       relax caps, edit title; the component set and bundle price are
 *       immutable once defined (changing them mid-campaign would
 *       silently alter what past detect-but-not-yet-converted carts
 *       see). Operators rename + redefine if they need a structural
 *       change.
 *
 *     - `archiveBundle(slug)` — soft retire. Archived bundles do not
 *       appear in `activeBundles` or `detectInCart`; historical
 *       redemption rows stay intact for reporting.
 *
 *     - `activeBundles({ now })` — windowed read. Returns every
 *       defined, non-archived bundle where
 *       `starts_at <= now < expires_at`. Caller passes the clock so
 *       tests can drive the window deterministically and so the
 *       storefront-render path can pin a single "now" across a render
 *       sweep.
 *
 *     - `metricsForBundle(slug)` — operator-facing rollup:
 *       `{ redemptions_used, total_savings_minor, distinct_customers,
 *          first_redeemed_at, last_redeemed_at }`.
 *
 *   Storage: `promo_bundles` + `promo_bundle_redemptions`
 *   (migration 0140).
 *
 *   Composition:
 *     - b.guardUuid — every customer_id / order_id is UUID-shape
 *       validated at the entry point (strict profile).
 *     - b.uuid.v7   — promo_bundle_redemptions.id (sortable so
 *       audit-listing ORDER BY id matches chronological order without
 *       a secondary index when occurred_at ties on the millisecond).
 *
 * @primitive promoBundles
 * @related   shop.bundles, shop.cart, shop.autoDiscount
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var SLUG_RE     = /^[a-z0-9][a-z0-9._-]{0,79}$/;
var SKU_RE      = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE = /^[A-Z]{3}$/;

var MAX_TITLE_LEN       = 200;
var MAX_COMPONENTS      = 50;
var MAX_LIST_LIMIT      = 500;
var MAX_REDEMPTIONS_CAP = 1000000000;
var MAX_PRICE_MINOR     = 1000000000000;   // 1e12 minor units — same envelope b.money accepts

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "starts_at",
  "expires_at",
  "max_redemptions_total",
  "max_per_customer",
]);

// ---- monotonic clock ----------------------------------------------------
//
// Two redemptions recorded inside the same millisecond would otherwise
// collide on the v7-uuid timestamp prefix and tie on (occurred_at, id)
// keyset reads. The monotonic step guarantees strict-increase so the
// audit-listing sort is deterministic without depending on the v7
// sub-millisecond counter.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("promoBundles: slug must match /^[a-z0-9][a-z0-9._-]*$/ (<= 80 chars)");
  }
  return s;
}

function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("promoBundles: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= 128 chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("promoBundles: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("promoBundles: title must not contain control bytes");
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("promoBundles: currency must be a 3-letter uppercase ISO 4217 code");
  }
  return s;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("promoBundles: " + label + " must be a positive integer");
  }
  return n;
}

function _priceMinor(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRICE_MINOR) {
    throw new TypeError("promoBundles: bundle_price_minor must be a non-negative integer <= " + MAX_PRICE_MINOR);
  }
  return n;
}

function _savingsMinor(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRICE_MINOR) {
    throw new TypeError("promoBundles: savings_minor must be a non-negative integer <= " + MAX_PRICE_MINOR);
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("promoBundles: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _capOrNull(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_REDEMPTIONS_CAP) {
    throw new TypeError("promoBundles: " + label + " must be a positive integer <= " + MAX_REDEMPTIONS_CAP + " (or null)");
  }
  return n;
}

function _uuid(s, label) {
  try {
    return _b().guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("promoBundles: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

// ---- row hydration ------------------------------------------------------

function _safeParseArray(s, fallback) {
  if (s == null) return fallback;
  try {
    var parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return fallback;
  } catch (_e) {
    return fallback;
  }
}

function _hydrateBundle(r) {
  if (!r) return null;
  return {
    slug:                   r.slug,
    title:                  r.title,
    components:             _safeParseArray(r.components_json, []),
    bundle_price_minor:     Number(r.bundle_price_minor),
    currency:               r.currency,
    starts_at:              Number(r.starts_at),
    expires_at:             Number(r.expires_at),
    max_redemptions_total:  r.max_redemptions_total == null ? null : Number(r.max_redemptions_total),
    max_per_customer:       r.max_per_customer == null ? null : Number(r.max_per_customer),
    redemptions_used:       Number(r.redemptions_used || 0),
    archived_at:            r.archived_at == null ? null : Number(r.archived_at),
    created_at:             Number(r.created_at),
    updated_at:             Number(r.updated_at),
  };
}

function _hydrateRedemption(r) {
  if (!r) return null;
  return {
    id:             r.id,
    slug:           r.slug,
    order_id:       r.order_id,
    customer_id:    r.customer_id == null ? null : r.customer_id,
    savings_minor:  Number(r.savings_minor),
    occurred_at:    Number(r.occurred_at),
  };
}

// ---- component validation ----------------------------------------------

// Returns a normalized, dedup-checked component list `[{ sku, quantity }]`.
// Refuses empty input, duplicate skus, non-positive quantities, and
// arrays longer than MAX_COMPONENTS.
function _normalizeComponents(components) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new TypeError("promoBundles: components must be a non-empty array of { sku, quantity }");
  }
  if (components.length > MAX_COMPONENTS) {
    throw new TypeError("promoBundles: components cap is " + MAX_COMPONENTS + " entries per bundle");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < components.length; i += 1) {
    var c = components[i];
    if (!c || typeof c !== "object") {
      throw new TypeError("promoBundles: components[" + i + "] must be an object");
    }
    _sku(c.sku, "components[" + i + "].sku");
    _positiveInt(c.quantity, "components[" + i + "].quantity");
    if (seen[c.sku]) {
      throw new TypeError("promoBundles: duplicate component sku " + JSON.stringify(c.sku));
    }
    seen[c.sku] = true;
    out.push({ sku: c.sku, quantity: c.quantity });
  }
  // Stable sort by sku so the stored components_json is canonical —
  // operator edits that re-order their input array don't perturb the
  // persisted row (and downstream JSON diff of the bundle row stays
  // meaningful).
  out.sort(function (a, b) { return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0; });
  return out;
}

// ---- cart shape validation ---------------------------------------------

// detectInCart / applyBundleToCart accept a duck-typed cart:
//   { currency: "USD", lines: [{ sku, quantity, unit_amount_minor, ... }] }
// Anything else is refused at the entry point so a typo doesn't
// silently return an empty match list.
function _validateCart(cart, fn) {
  if (!cart || typeof cart !== "object") {
    throw new TypeError("promoBundles." + fn + ": cart object required");
  }
  if (!Array.isArray(cart.lines)) {
    throw new TypeError("promoBundles." + fn + ": cart.lines must be an array");
  }
  if (typeof cart.currency !== "string" || !CURRENCY_RE.test(cart.currency)) {
    throw new TypeError("promoBundles." + fn + ": cart.currency must be a 3-letter uppercase ISO 4217 code");
  }
  for (var i = 0; i < cart.lines.length; i += 1) {
    var ln = cart.lines[i];
    if (!ln || typeof ln !== "object") {
      throw new TypeError("promoBundles." + fn + ": cart.lines[" + i + "] must be an object");
    }
    if (typeof ln.sku !== "string" || !ln.sku.length) {
      throw new TypeError("promoBundles." + fn + ": cart.lines[" + i + "].sku must be a non-empty string");
    }
    if (!Number.isInteger(ln.quantity) || ln.quantity <= 0) {
      throw new TypeError("promoBundles." + fn + ": cart.lines[" + i + "].quantity must be a positive integer");
    }
    if (!Number.isInteger(ln.unit_amount_minor) || ln.unit_amount_minor < 0) {
      throw new TypeError("promoBundles." + fn + ": cart.lines[" + i + "].unit_amount_minor must be a non-negative integer");
    }
  }
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Optional catalog handle — when injected, defineBundle verifies
  // every component sku exists in the catalog so a typo doesn't ship
  // a bundle nobody can ever match. Absent the handle, the primitive
  // accepts any well-shaped sku string and trusts the operator (the
  // common case for headless operators driving the storefront with
  // their own product feed).
  var catalog = null;
  if (opts.catalog != null) {
    if (!opts.catalog.variants || typeof opts.catalog.variants.bySku !== "function") {
      throw new TypeError("promoBundles.create: opts.catalog must expose variants.bySku(sku) when provided");
    }
    catalog = opts.catalog;
  }

  // ---- defineBundle --------------------------------------------------

  async function defineBundle(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("promoBundles.defineBundle: input object required");
    }
    var slug      = _slug(input.slug);
    var title     = _title(input.title);
    var price     = _priceMinor(input.bundle_price_minor);
    var currency  = _currency(input.currency);
    var startsAt  = _epochMs(input.starts_at, "starts_at");
    var expiresAt = _epochMs(input.expires_at, "expires_at");
    if (startsAt >= expiresAt) {
      throw new TypeError("promoBundles.defineBundle: starts_at must be strictly less than expires_at");
    }
    var maxTotal      = _capOrNull(input.max_redemptions_total, "max_redemptions_total");
    var maxPerCust    = _capOrNull(input.max_per_customer, "max_per_customer");
    var components    = _normalizeComponents(input.components);

    // Optional catalog gate — refuse component skus that don't exist
    // in the operator's catalog. The check is per-sku so the error
    // surfaces the first missing one.
    if (catalog) {
      for (var i = 0; i < components.length; i += 1) {
        var found = await catalog.variants.bySku(components[i].sku);
        if (!found) {
          throw new TypeError("promoBundles.defineBundle: component sku " + JSON.stringify(components[i].sku) + " not found in catalog");
        }
      }
    }

    // Refuse re-define of an existing slug — operators `updateBundle`
    // to extend a window or relax caps; structural changes require a
    // new slug.
    var existing = (await query(
      "SELECT slug FROM promo_bundles WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("promoBundles.defineBundle: slug " + JSON.stringify(slug) + " already exists — use updateBundle / archiveBundle");
    }

    var ts = _now();
    await query(
      "INSERT INTO promo_bundles (slug, title, components_json, bundle_price_minor, currency, " +
      "starts_at, expires_at, max_redemptions_total, max_per_customer, redemptions_used, " +
      "archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, ?10, ?10)",
      [
        slug, title, JSON.stringify(components), price, currency,
        startsAt, expiresAt, maxTotal, maxPerCust, ts,
      ],
    );
    return await getBundle(slug);
  }

  // ---- getBundle / activeBundles -------------------------------------

  async function getBundle(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM promo_bundles WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateBundle(r);
  }

  async function activeBundles(input) {
    input = input || {};
    var now = _epochMs(input.now, "now");
    var limit = input.limit == null ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("promoBundles.activeBundles: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    // Window-only — archived bundles never appear here.
    var rows = (await query(
      "SELECT * FROM promo_bundles " +
      "WHERE archived_at IS NULL AND starts_at <= ?1 AND expires_at > ?1 " +
      "ORDER BY starts_at ASC, slug ASC LIMIT ?2",
      [now, limit],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var b = _hydrateBundle(rows[i]);
      // Skip bundles that already hit their total redemption cap —
      // they're in-window but no longer redeemable, so the resolver
      // shouldn't surface them.
      if (b.max_redemptions_total != null && b.redemptions_used >= b.max_redemptions_total) continue;
      out.push(b);
    }
    return out;
  }

  // ---- detectInCart --------------------------------------------------

  async function detectInCart(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("promoBundles.detectInCart: input object required");
    }
    _validateCart(input.cart, "detectInCart");
    var now = input.now == null ? _now() : _epochMs(input.now, "now");
    var cart = input.cart;

    // Index the cart by sku → { quantity, unit_amount_minor } for
    // O(C * K) match — C = active bundles, K = components per bundle.
    var byMatchSku = Object.create(null);
    for (var i = 0; i < cart.lines.length; i += 1) {
      var ln = cart.lines[i];
      // Merge same-sku lines (rare in practice — the cart primitive
      // collapses them — but the resolver must not silently miss a
      // match because two lines split the required quantity).
      if (!byMatchSku[ln.sku]) {
        byMatchSku[ln.sku] = { quantity: 0, unit_amount_minor: ln.unit_amount_minor };
      }
      byMatchSku[ln.sku].quantity += ln.quantity;
      // Keep the lowest unit price seen for this sku — the conservative
      // choice for savings math (we never claim more savings than the
      // cheapest line could give us).
      if (ln.unit_amount_minor < byMatchSku[ln.sku].unit_amount_minor) {
        byMatchSku[ln.sku].unit_amount_minor = ln.unit_amount_minor;
      }
    }

    var actives = await activeBundles({ now: now, limit: MAX_LIST_LIMIT });
    var matches = [];
    for (var k = 0; k < actives.length; k += 1) {
      var bundle = actives[k];
      if (bundle.currency !== cart.currency) continue;        // mixed-currency carts never match
      var ok = true;
      var componentTotal = 0;
      for (var c = 0; c < bundle.components.length; c += 1) {
        var comp = bundle.components[c];
        var have = byMatchSku[comp.sku];
        if (!have || have.quantity < comp.quantity) { ok = false; break; }
        componentTotal += have.unit_amount_minor * comp.quantity;
      }
      if (!ok) continue;
      var savings = componentTotal - bundle.bundle_price_minor;
      if (savings < 0) savings = 0;
      matches.push({
        slug:                bundle.slug,
        title:               bundle.title,
        bundle_price_minor:  bundle.bundle_price_minor,
        currency:            bundle.currency,
        components:          bundle.components,
        component_total_minor: componentTotal,
        savings_minor:       savings,
      });
    }
    // Sort by savings descending so the caller's "best deal first"
    // surface is the natural order; ties broken by slug for stability.
    matches.sort(function (a, b) {
      if (a.savings_minor !== b.savings_minor) return b.savings_minor - a.savings_minor;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    return matches;
  }

  // ---- applyBundleToCart ---------------------------------------------

  async function applyBundleToCart(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("promoBundles.applyBundleToCart: input object required");
    }
    _validateCart(input.cart, "applyBundleToCart");
    var slug = _slug(input.bundle_slug);
    var now = input.now == null ? _now() : _epochMs(input.now, "now");
    var cart = input.cart;

    var bundle = await getBundle(slug);
    if (!bundle) {
      throw new TypeError("promoBundles.applyBundleToCart: bundle slug " + JSON.stringify(slug) + " not found");
    }
    if (bundle.archived_at != null) {
      var arErr = new Error("promoBundles.applyBundleToCart: bundle " + JSON.stringify(slug) + " is archived");
      arErr.code = "BUNDLE_NOT_REDEEMABLE";
      throw arErr;
    }
    if (now < bundle.starts_at || now >= bundle.expires_at) {
      var winErr = new Error("promoBundles.applyBundleToCart: bundle " + JSON.stringify(slug) + " is outside its active window");
      winErr.code = "BUNDLE_NOT_REDEEMABLE";
      throw winErr;
    }
    if (bundle.max_redemptions_total != null && bundle.redemptions_used >= bundle.max_redemptions_total) {
      var capErr = new Error("promoBundles.applyBundleToCart: bundle " + JSON.stringify(slug) + " has hit max_redemptions_total");
      capErr.code = "BUNDLE_CAP_REACHED";
      throw capErr;
    }
    if (bundle.currency !== cart.currency) {
      throw new TypeError("promoBundles.applyBundleToCart: bundle currency " + JSON.stringify(bundle.currency) +
                          " does not match cart currency " + JSON.stringify(cart.currency));
    }

    // Walk the components; for each one, find a cart line (or set of
    // same-sku lines) that supplies the required quantity. Refuse if
    // the cart doesn't contain enough — the caller should have called
    // detectInCart first.
    //
    // Deep-clone the cart line array so we never mutate the input.
    var newLines = [];
    for (var i = 0; i < cart.lines.length; i += 1) {
      var src = cart.lines[i];
      var clone = {};
      for (var key in src) {
        if (Object.prototype.hasOwnProperty.call(src, key)) clone[key] = src[key];
      }
      newLines.push(clone);
    }

    var componentTotal = 0;
    for (var c = 0; c < bundle.components.length; c += 1) {
      var comp = bundle.components[c];
      var remaining = comp.quantity;
      for (var n = 0; n < newLines.length && remaining > 0; n += 1) {
        var line = newLines[n];
        if (line.sku !== comp.sku) continue;
        if (line.quantity <= 0) continue;
        var take = Math.min(line.quantity, remaining);
        componentTotal += line.unit_amount_minor * take;
        line.quantity -= take;
        remaining     -= take;
      }
      if (remaining > 0) {
        var missErr = new Error("promoBundles.applyBundleToCart: cart does not contain enough of component sku " +
                                JSON.stringify(comp.sku) + " (short " + remaining + ")");
        missErr.code = "BUNDLE_COMPONENTS_MISSING";
        throw missErr;
      }
    }

    // Drop zero-quantity lines, then push a synthetic bundle line.
    var keptLines = [];
    for (var d = 0; d < newLines.length; d += 1) {
      if (newLines[d].quantity > 0) keptLines.push(newLines[d]);
    }
    var savings = componentTotal - bundle.bundle_price_minor;
    if (savings < 0) savings = 0;
    keptLines.push({
      sku:                "bundle:" + bundle.slug,
      quantity:           1,
      unit_amount_minor:  bundle.bundle_price_minor,
      currency:           bundle.currency,
      is_promo_bundle:    true,
      promo_bundle_slug:  bundle.slug,
      promo_bundle_title: bundle.title,
      savings_minor:      savings,
    });

    // Return a new cart object with the same top-level identity
    // fields plus the rewritten lines. The caller (cart-resolution
    // layer) is responsible for re-totalling.
    var out = {};
    for (var ck in cart) {
      if (Object.prototype.hasOwnProperty.call(cart, ck)) out[ck] = cart[ck];
    }
    out.lines = keptLines;
    out.applied_promo_bundle = {
      slug:           bundle.slug,
      title:          bundle.title,
      savings_minor:  savings,
      currency:       bundle.currency,
    };
    return out;
  }

  // ---- recordRedemption ----------------------------------------------

  async function recordRedemption(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("promoBundles.recordRedemption: input object required");
    }
    var slug         = _slug(input.slug);
    var orderId      = _uuid(input.order_id, "order_id");
    var customerId   = input.customer_id == null ? null : _uuid(input.customer_id, "customer_id");
    var savingsMinor = _savingsMinor(input.savings_minor);

    var bundle = await getBundle(slug);
    if (!bundle) {
      throw new TypeError("promoBundles.recordRedemption: bundle slug " + JSON.stringify(slug) + " not found");
    }

    // Idempotency: a redemption for the same (slug, order_id) replays
    // as a no-op returning the existing row. The UNIQUE constraint on
    // the table backs this — but we check first so the caller doesn't
    // see a misleading "cap reached" error when the cap was reached
    // by THIS same order on a previous attempt.
    var existing = (await query(
      "SELECT * FROM promo_bundle_redemptions WHERE slug = ?1 AND order_id = ?2 LIMIT 1",
      [slug, orderId],
    )).rows[0];
    if (existing) return _hydrateRedemption(existing);

    // Cap check + increment in one guarded UPDATE so two concurrent
    // checkouts cannot both claim the last slot. SQLite's statement
    // atomicity guarantees the row update is all-or-nothing; the
    // WHERE filters out a slot-exhausted race losing-side.
    var ts = _now();
    var redemptionId = _b().uuid.v7({ now: ts });

    var updateSql, updateParams;
    if (bundle.max_redemptions_total == null) {
      updateSql = "UPDATE promo_bundles SET redemptions_used = redemptions_used + 1, updated_at = ?1 WHERE slug = ?2";
      updateParams = [ts, slug];
    } else {
      updateSql = "UPDATE promo_bundles SET redemptions_used = redemptions_used + 1, updated_at = ?1 " +
                  "WHERE slug = ?2 AND redemptions_used < ?3";
      updateParams = [ts, slug, bundle.max_redemptions_total];
    }
    var updateRes = await query(updateSql, updateParams);
    if (Number(updateRes.rowCount || 0) === 0) {
      // Lost the race for the last slot — re-read to confirm and
      // surface the cap error with the row's actual state.
      var after = await getBundle(slug);
      if (after && after.max_redemptions_total != null && after.redemptions_used >= after.max_redemptions_total) {
        var capErr = new Error("promoBundles.recordRedemption: bundle " + JSON.stringify(slug) + " has hit max_redemptions_total");
        capErr.code = "BUNDLE_CAP_REACHED";
        throw capErr;
      }
      // Anything else is an unexpected post-condition — re-raise so
      // the caller sees it rather than silently dropping the row.
      throw new Error("promoBundles.recordRedemption: failed to claim a redemption slot for " + JSON.stringify(slug));
    }

    await query(
      "INSERT INTO promo_bundle_redemptions (id, slug, order_id, customer_id, savings_minor, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [redemptionId, slug, orderId, customerId, savingsMinor, ts],
    );

    return {
      id:            redemptionId,
      slug:          slug,
      order_id:      orderId,
      customer_id:   customerId,
      savings_minor: savingsMinor,
      occurred_at:   ts,
    };
  }

  // ---- updateBundle --------------------------------------------------

  async function updateBundle(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("promoBundles.updateBundle: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("promoBundles.updateBundle: patch must include at least one column");
    }
    var current = await getBundle(slug);
    if (!current) {
      throw new TypeError("promoBundles.updateBundle: slug " + JSON.stringify(slug) + " not found");
    }

    var sets = [];
    var params = [];
    var idx = 1;
    var nextStartsAt  = current.starts_at;
    var nextExpiresAt = current.expires_at;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("promoBundles.updateBundle: unsupported patch column " + JSON.stringify(col) +
                            " — components + bundle_price_minor + currency are immutable; redefine under a new slug");
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
      } else if (col === "starts_at") {
        nextStartsAt = _epochMs(patch[col], "starts_at");
        sets.push("starts_at = ?" + idx);
        params.push(nextStartsAt);
      } else if (col === "expires_at") {
        nextExpiresAt = _epochMs(patch[col], "expires_at");
        sets.push("expires_at = ?" + idx);
        params.push(nextExpiresAt);
      } else if (col === "max_redemptions_total") {
        var cap = _capOrNull(patch[col], "max_redemptions_total");
        // Refuse a cap that's already been exceeded — the
        // operator-visible state would be incoherent (used > cap).
        if (cap != null && cap < current.redemptions_used) {
          throw new TypeError("promoBundles.updateBundle: max_redemptions_total " + cap +
                              " is below redemptions_used " + current.redemptions_used);
        }
        sets.push("max_redemptions_total = ?" + idx);
        params.push(cap);
      } else /* max_per_customer */ {
        sets.push("max_per_customer = ?" + idx);
        params.push(_capOrNull(patch[col], "max_per_customer"));
      }
      idx += 1;
    }
    if (nextStartsAt >= nextExpiresAt) {
      throw new TypeError("promoBundles.updateBundle: starts_at must remain strictly less than expires_at after patch");
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE promo_bundles SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("promoBundles.updateBundle: slug " + JSON.stringify(slug) + " not found");
    }
    return await getBundle(slug);
  }

  // ---- archiveBundle -------------------------------------------------

  async function archiveBundle(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE promo_bundles SET archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getBundle(slug);
      if (!existing) {
        throw new TypeError("promoBundles.archiveBundle: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — idempotent return.
      return existing;
    }
    return await getBundle(slug);
  }

  // ---- metricsForBundle ----------------------------------------------

  async function metricsForBundle(slug) {
    _slug(slug);
    var bundle = await getBundle(slug);
    if (!bundle) {
      throw new TypeError("promoBundles.metricsForBundle: slug " + JSON.stringify(slug) + " not found");
    }
    var rollup = (await query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(savings_minor), 0) AS total_savings, " +
      "COUNT(DISTINCT customer_id) AS distinct_customers, " +
      "MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at " +
      "FROM promo_bundle_redemptions WHERE slug = ?1",
      [slug],
    )).rows[0] || {};
    var n = Number(rollup.n || rollup.N || 0);
    return {
      slug:                 slug,
      redemptions_used:     n,
      total_savings_minor:  Number(rollup.total_savings || 0),
      distinct_customers:   Number(rollup.distinct_customers || 0),
      first_redeemed_at:    rollup.first_at == null ? null : Number(rollup.first_at),
      last_redeemed_at:     rollup.last_at  == null ? null : Number(rollup.last_at),
    };
  }

  return {
    defineBundle:       defineBundle,
    getBundle:          getBundle,
    activeBundles:      activeBundles,
    detectInCart:       detectInCart,
    applyBundleToCart:  applyBundleToCart,
    recordRedemption:   recordRedemption,
    updateBundle:       updateBundle,
    archiveBundle:      archiveBundle,
    metricsForBundle:   metricsForBundle,
  };
}

module.exports = {
  create:               create,
  MAX_COMPONENTS:       MAX_COMPONENTS,
  ALLOWED_PATCH_COLUMNS: ALLOWED_PATCH_COLUMNS,
};
