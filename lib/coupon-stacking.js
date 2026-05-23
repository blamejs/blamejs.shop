"use strict";
/**
 * @module shop.couponStacking
 * @title  Coupon-stacking policies — operator-authored rules that gate
 *         which codes (and which `quantityDiscounts`) may combine on a cart.
 *
 * @intro
 *   A stacking policy answers a single question:
 *
 *     "This cart is presenting codes [A, B, C], may have an automatic
 *      quantity discount already attached to its lines, and belongs to
 *      customer X. Which of those discounts are allowed to apply
 *      together?"
 *
 *   The primitive does not validate the codes themselves (the
 *   `coupons` surface owns expiry, per-code discount math, redemption
 *   counters). Codes reach this primitive as opaque strings; the
 *   policy decides combination, not redemption.
 *
 *   Surface:
 *
 *     - `definePolicy({ slug, title, allow_combine, max_codes_per_order,
 *                       exclusive_codes?, order_min_minor?,
 *                       customer_segment_in? })`
 *         Create a new policy.
 *         `allow_combine` is `{ with_quantity_discounts?: bool,
 *                               with_other_codes?: bool }`. Both default
 *         to `false` — strict refusal is the safe default. Unknown
 *         keys are refused at define time so a typo can't silently
 *         widen the surface.
 *         `max_codes_per_order` (>=1) caps the codes the policy
 *         accepts; over-cap codes are refused in cart-order with
 *         reason `max_codes_per_order_exceeded`.
 *         `exclusive_codes` lists codes that, when present on a cart,
 *         block every other code on the same order — useful for "this
 *         loyalty-tier code never stacks with anything else".
 *         `order_min_minor` is the subtotal floor (in minor units)
 *         the policy requires; carts below the floor fall through to
 *         the next-priority policy.
 *         `customer_segment_in` is a list of segment slugs the
 *         customer must intersect with for the policy to apply; carts
 *         without a `customer_id` never satisfy this gate.
 *
 *     - `evaluate({ codes, cart, customer_id? })`
 *         Walks active policies in (priority DESC, created_at ASC)
 *         order. The first policy whose preconditions
 *         (`order_min_minor`, `customer_segment_in`) match the cart
 *         is the governing policy; its rules decide every refusal.
 *         When no policy matches, the cart's first code is allowed
 *         and every subsequent code is refused with
 *         `no_policy_allows_stacking` — the conservative default
 *         is "one code, no stacking" until the operator authors a
 *         policy.
 *         Returns `{ allowed, applied: [code], refused: [{ code, reason }] }`.
 *         `allowed` is the AND of "applied is non-empty" and "the
 *         cart's quantity-discount stack is not in violation" (a
 *         q-discount line in a `with_quantity_discounts=false` policy
 *         when codes are also presented is refused at the cart level,
 *         surfacing as `allowed=false` with reason
 *         `quantity_discount_stack_refused`).
 *
 *     - `activePoliciesForCart({ cart, customer_id? })`
 *         Operator dashboard hint — returns every active, non-archived
 *         policy whose `order_min_minor` is met by the cart subtotal
 *         and whose `customer_segment_in` matches the customer (or
 *         is empty). Ordered by priority DESC. Lets the admin UI
 *         render "these policies would govern this cart".
 *
 *     - `getPolicy(slug)` / `listPolicies({ active_only? })` /
 *       `updatePolicy(slug, patch)` / `archivePolicy(slug)`.
 *
 *   Composition:
 *
 *     - `customerSegments` (optional handle, shape: `isMember(customer_id,
 *       segment_slug) -> Promise<bool>`). Required only when at least
 *       one policy has a non-empty `customer_segment_in`; absent that,
 *       `evaluate` runs without consulting any external handle.
 *
 *     - The `cart` argument is the storefront-shaped cart object the
 *       framework already passes between cart / checkout primitives:
 *       `{ subtotal_minor, has_quantity_discount?, lines? }`.
 *       Only `subtotal_minor` and `has_quantity_discount` are read by
 *       this primitive; the rest rides through unread.
 *
 *   Storage:
 *
 *     - `coupon_stacking_policies` (migration
 *       `0067_coupon_stacking.sql`).
 *
 * @primitive couponStacking
 * @related   customerSegments, quantityDiscounts
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN          = 80;
var MAX_TITLE_LEN         = 200;
var MAX_CODE_LEN          = 64;
var MAX_EXCLUSIVE_CODES   = 64;
var MAX_SEGMENT_SLUGS     = 32;
var MAX_SEGMENT_SLUG_LEN  = 64;
var MAX_MAX_CODES         = 32;
var MAX_PRIORITY          = 1000000;
var MAX_LIST_LIMIT        = 200;

// Slug shape matches the catalog / promo-banners convention — alnum +
// hyphen + underscore + dot, leading char alnum, capped length.
var SLUG_RE         = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var SEGMENT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Code shape — operator codes typed by shoppers are case-sensitive
// strings, alnum + hyphen + underscore. Tight enough to refuse
// control bytes / whitespace, loose enough that any reasonable
// coupons-primitive shape passes.
var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

var ALLOWED_COMBINE_KEYS = Object.freeze([
  "with_quantity_discounts",
  "with_other_codes",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "allow_combine",
  "max_codes_per_order",
  "exclusive_codes",
  "order_min_minor",
  "customer_segment_in",
  "active",
  "priority",
]);

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("couponStacking: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("couponStacking: title must be a non-empty string ≤ " + MAX_TITLE_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("couponStacking: title must not contain control bytes");
  }
  return s;
}

function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("couponStacking: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_CODE_LEN + " chars)");
  }
  return s;
}

function _segmentSlug(s) {
  if (typeof s !== "string" || !SEGMENT_SLUG_RE.test(s)) {
    throw new TypeError("couponStacking: customer_segment_in entries must match /^[a-z0-9][a-z0-9_-]*$/ (≤ " + MAX_SEGMENT_SLUG_LEN + " chars)");
  }
  return s;
}

function _maxCodes(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_CODES) {
    throw new TypeError("couponStacking: max_codes_per_order must be an integer in [1, " + MAX_MAX_CODES + "]");
  }
  return n;
}

function _orderMin(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("couponStacking: order_min_minor must be a non-negative integer");
  }
  return n;
}

function _priority(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) {
    throw new TypeError("couponStacking: priority must be an integer in [0, " + MAX_PRIORITY + "]");
  }
  return n;
}

function _allowCombine(v) {
  if (v == null) return { with_quantity_discounts: false, with_other_codes: false };
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("couponStacking: allow_combine must be an object");
  }
  var out = { with_quantity_discounts: false, with_other_codes: false };
  var keys = Object.keys(v);
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (ALLOWED_COMBINE_KEYS.indexOf(k) === -1) {
      throw new TypeError("couponStacking: allow_combine unknown key " + JSON.stringify(k) +
                          " (allowed: " + JSON.stringify(ALLOWED_COMBINE_KEYS) + ")");
    }
    if (typeof v[k] !== "boolean") {
      throw new TypeError("couponStacking: allow_combine." + k + " must be a boolean");
    }
    out[k] = v[k];
  }
  return out;
}

function _exclusiveCodes(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    throw new TypeError("couponStacking: exclusive_codes must be an array of code strings");
  }
  if (v.length > MAX_EXCLUSIVE_CODES) {
    throw new TypeError("couponStacking: exclusive_codes length " + v.length + " exceeds cap " + MAX_EXCLUSIVE_CODES);
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < v.length; i += 1) {
    var c = _code(v[i], "exclusive_codes[" + i + "]");
    if (seen[c]) {
      throw new TypeError("couponStacking: exclusive_codes contains duplicate " + JSON.stringify(c));
    }
    seen[c] = true;
    out.push(c);
  }
  return out;
}

function _customerSegmentIn(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    throw new TypeError("couponStacking: customer_segment_in must be an array of segment slugs");
  }
  if (v.length > MAX_SEGMENT_SLUGS) {
    throw new TypeError("couponStacking: customer_segment_in length " + v.length + " exceeds cap " + MAX_SEGMENT_SLUGS);
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < v.length; i += 1) {
    var s = _segmentSlug(v[i]);
    if (seen[s]) {
      throw new TypeError("couponStacking: customer_segment_in contains duplicate " + JSON.stringify(s));
    }
    seen[s] = true;
    out.push(s);
  }
  return out;
}

function _active(v) {
  if (typeof v !== "boolean") {
    throw new TypeError("couponStacking: active must be a boolean");
  }
  return v;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _safeParseObject(s, fallback) {
  if (s == null) return fallback;
  try {
    var parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch (_e) {
    return fallback;
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
  var allowCombineRaw = _safeParseObject(r.allow_combine_json, {});
  return {
    slug:                  r.slug,
    title:                 r.title,
    allow_combine: {
      with_quantity_discounts: allowCombineRaw.with_quantity_discounts === true,
      with_other_codes:        allowCombineRaw.with_other_codes === true,
    },
    max_codes_per_order:   Number(r.max_codes_per_order),
    exclusive_codes:       _safeParseArray(r.exclusive_codes_json),
    order_min_minor:       Number(r.order_min_minor),
    customer_segment_in:   _safeParseArray(r.customer_segment_in_json),
    active:                r.active === 1 || r.active === true,
    archived_at:           r.archived_at == null ? null : Number(r.archived_at),
    priority:              Number(r.priority),
    created_at:            Number(r.created_at),
    updated_at:            Number(r.updated_at),
  };
}

// ---- cart-shape reader (defensive) --------------------------------------

// The cart object travels through several primitives; the stacking
// primitive only ever reads two fields. A missing cart is refused;
// missing optional fields default to safe values.
function _readCart(cart) {
  if (!cart || typeof cart !== "object") {
    throw new TypeError("couponStacking: cart object required");
  }
  var subtotal = cart.subtotal_minor;
  if (subtotal == null) subtotal = 0;
  if (!Number.isInteger(subtotal) || subtotal < 0) {
    throw new TypeError("couponStacking: cart.subtotal_minor must be a non-negative integer when present");
  }
  var hasQd = cart.has_quantity_discount === true;
  return { subtotal_minor: subtotal, has_quantity_discount: hasQd };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional segments handle. Required only when at least one policy
  // has a non-empty `customer_segment_in`; the evaluator enforces
  // this lazily so a deployment with no segment-gated policies can
  // skip wiring it.
  var customerSegments = opts.customerSegments || null;

  // ---- definePolicy --------------------------------------------------

  async function definePolicy(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("couponStacking.definePolicy: input object required");
    }
    var slug              = _slug(input.slug);
    var title             = _title(input.title);
    var allowCombine      = _allowCombine(input.allow_combine);
    var maxCodes          = _maxCodes(input.max_codes_per_order);
    var exclusiveCodes    = _exclusiveCodes(input.exclusive_codes);
    var orderMin          = input.order_min_minor == null ? 0 : _orderMin(input.order_min_minor);
    var customerSegmentIn = _customerSegmentIn(input.customer_segment_in);
    var priority          = input.priority == null ? 0 : _priority(input.priority);

    // Refuse a redefine — operators should `updatePolicy` to mutate
    // an existing slug. A blind INSERT would clobber the policy's
    // created_at timestamp and is rarely what the operator wants.
    var existing = (await query(
      "SELECT slug FROM coupon_stacking_policies WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("couponStacking.definePolicy: slug " + JSON.stringify(slug) + " already exists — use updatePolicy");
    }

    var ts = _now();
    await query(
      "INSERT INTO coupon_stacking_policies (slug, title, allow_combine_json, max_codes_per_order, " +
      "exclusive_codes_json, order_min_minor, customer_segment_in_json, active, archived_at, " +
      "priority, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, ?8, ?9, ?9)",
      [
        slug,
        title,
        JSON.stringify(allowCombine),
        maxCodes,
        JSON.stringify(exclusiveCodes),
        orderMin,
        JSON.stringify(customerSegmentIn),
        priority,
        ts,
      ],
    );
    return await getPolicy(slug);
  }

  // ---- getPolicy / listPolicies --------------------------------------

  async function getPolicy(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM coupon_stacking_policies WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function listPolicies(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("couponStacking.listPolicies: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("couponStacking.listPolicies: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql, params;
    if (activeOnly) {
      sql    = "SELECT * FROM coupon_stacking_policies WHERE active = 1 AND archived_at IS NULL " +
               "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql    = "SELECT * FROM coupon_stacking_policies " +
               "ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRow(rows[i]));
    return out;
  }

  // ---- updatePolicy --------------------------------------------------

  async function updatePolicy(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("couponStacking.updatePolicy: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("couponStacking.updatePolicy: patch must include at least one column");
    }
    var current = await getPolicy(slug);
    if (!current) {
      throw new TypeError("couponStacking.updatePolicy: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("couponStacking.updatePolicy: unsupported column " + JSON.stringify(col));
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
      } else if (col === "allow_combine") {
        sets.push("allow_combine_json = ?" + idx);
        params.push(JSON.stringify(_allowCombine(patch[col])));
      } else if (col === "max_codes_per_order") {
        sets.push("max_codes_per_order = ?" + idx);
        params.push(_maxCodes(patch[col]));
      } else if (col === "exclusive_codes") {
        sets.push("exclusive_codes_json = ?" + idx);
        params.push(JSON.stringify(_exclusiveCodes(patch[col])));
      } else if (col === "order_min_minor") {
        sets.push("order_min_minor = ?" + idx);
        params.push(_orderMin(patch[col]));
      } else if (col === "customer_segment_in") {
        sets.push("customer_segment_in_json = ?" + idx);
        params.push(JSON.stringify(_customerSegmentIn(patch[col])));
      } else if (col === "active") {
        sets.push("active = ?" + idx);
        params.push(_active(patch[col]) ? 1 : 0);
      } else /* priority */ {
        sets.push("priority = ?" + idx);
        params.push(_priority(patch[col]));
      }
      idx += 1;
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE coupon_stacking_policies SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("couponStacking.updatePolicy: slug " + JSON.stringify(slug) + " not found");
    }
    return await getPolicy(slug);
  }

  // ---- archivePolicy -------------------------------------------------

  async function archivePolicy(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE coupon_stacking_policies SET archived_at = ?1, active = 0, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getPolicy(slug);
      if (!existing) {
        throw new TypeError("couponStacking.archivePolicy: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — return the existing row idempotently so
      // an "archive everything" sweep doesn't have to special-case
      // a policy a coworker archived first.
      return existing;
    }
    return await getPolicy(slug);
  }

  // ---- _activePoliciesForCart (shared between public + evaluate) -----

  // Walks active, non-archived policies in (priority DESC, created_at
  // ASC, slug ASC) order, applying the `order_min_minor` and
  // `customer_segment_in` preconditions against the cart + customer.
  // Returns the surviving policies in priority order.
  async function _activePoliciesFor(cart, customerId) {
    var read = _readCart(cart);
    var rows = (await query(
      "SELECT * FROM coupon_stacking_policies " +
      "WHERE active = 1 AND archived_at IS NULL " +
      "ORDER BY priority DESC, created_at ASC, slug ASC",
      [],
    )).rows;

    var customerIdNorm = customerId == null ? null : customerId;
    if (customerIdNorm != null && (typeof customerIdNorm !== "string" || !customerIdNorm.length)) {
      throw new TypeError("couponStacking: customer_id must be a non-empty string when provided");
    }

    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var p = _hydrateRow(rows[i]);
      if (read.subtotal_minor < p.order_min_minor) continue;
      if (p.customer_segment_in.length > 0) {
        if (customerIdNorm == null) continue;
        if (!customerSegments) {
          throw new TypeError("couponStacking: policy " + JSON.stringify(p.slug) +
            " has a customer_segment_in gate but no customerSegments handle was wired into create()");
        }
        if (typeof customerSegments.isMember !== "function") {
          throw new TypeError("couponStacking: customerSegments handle must expose isMember(customer_id, segment_slug)");
        }
        var matched = false;
        for (var j = 0; j < p.customer_segment_in.length; j += 1) {
          if (await customerSegments.isMember(customerIdNorm, p.customer_segment_in[j])) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;
      }
      out.push(p);
    }
    return out;
  }

  async function activePoliciesForCart(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("couponStacking.activePoliciesForCart: input object required");
    }
    return await _activePoliciesFor(input.cart, input.customer_id);
  }

  // ---- evaluate ------------------------------------------------------

  async function evaluate(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("couponStacking.evaluate: input object required");
    }
    if (!Array.isArray(input.codes)) {
      throw new TypeError("couponStacking.evaluate: codes must be an array of code strings");
    }
    var read = _readCart(input.cart);

    // Validate every code shape up front. Duplicates inside the
    // incoming code list are refused as a separate, application-level
    // mistake (not a stacking-policy concern) so the operator surface
    // sees the right error.
    var codes = [];
    var seenCode = Object.create(null);
    for (var i = 0; i < input.codes.length; i += 1) {
      var c = _code(input.codes[i], "codes[" + i + "]");
      if (seenCode[c]) {
        throw new TypeError("couponStacking.evaluate: codes array contains duplicate " + JSON.stringify(c));
      }
      seenCode[c] = true;
      codes.push(c);
    }

    // No codes presented — nothing to refuse, nothing to apply. The
    // quantity-discount stack travels through unchallenged in this
    // case (the cart code path didn't ask about it because no code
    // was offered).
    if (codes.length === 0) {
      return { allowed: true, applied: [], refused: [] };
    }

    var policies = await _activePoliciesFor(input.cart, input.customer_id);

    // No governing policy — conservative default. Allow the first
    // code, refuse the rest with `no_policy_allows_stacking`. The
    // quantity-discount stack is left untouched (a missing policy
    // can't make a stacking decision about it).
    if (policies.length === 0) {
      var applied0 = [codes[0]];
      var refused0 = [];
      for (var k = 1; k < codes.length; k += 1) {
        refused0.push({ code: codes[k], reason: "no_policy_allows_stacking" });
      }
      return { allowed: true, applied: applied0, refused: refused0 };
    }

    // The highest-priority surviving policy is the governing one.
    var gov = policies[0];

    var applied = [];
    var refused = [];

    // Exclusive-codes short-circuit. When any code in the cart
    // appears on the governing policy's exclusive list, that code
    // wins outright and every other code is refused with
    // `exclusive_code_present`. Multiple exclusive codes in one cart
    // collapse to "the first one wins" — the remaining exclusives
    // are also refused (you can't stack two exclusives any more than
    // an exclusive + a regular code).
    var exclusiveSet = Object.create(null);
    for (var e = 0; e < gov.exclusive_codes.length; e += 1) exclusiveSet[gov.exclusive_codes[e]] = true;

    var presentedExclusives = codes.filter(function (cc) { return exclusiveSet[cc]; });
    if (presentedExclusives.length > 0) {
      applied.push(presentedExclusives[0]);
      for (var m = 0; m < codes.length; m += 1) {
        if (codes[m] === presentedExclusives[0]) continue;
        refused.push({ code: codes[m], reason: "exclusive_code_present" });
      }
      // Quantity-discount stack also refused in the exclusive case
      // regardless of the policy's `with_quantity_discounts` flag —
      // "exclusive" means exclusive of everything, including
      // automatic discounts. Surface that as the cart-level
      // `allowed=false` only when a q-discount is actually present;
      // otherwise the result still allows.
      if (read.has_quantity_discount) {
        return {
          allowed: false,
          applied: applied,
          refused: refused.concat([{ code: "__quantity_discount__", reason: "quantity_discount_stack_refused" }]),
        };
      }
      return { allowed: true, applied: applied, refused: refused };
    }

    // No exclusive code presented — apply the with_other_codes +
    // max_codes_per_order rules.
    if (codes.length === 1) {
      applied.push(codes[0]);
    } else if (gov.allow_combine.with_other_codes) {
      // Multiple codes allowed up to the cap. Codes are taken in the
      // order they were presented; over-cap codes are refused with
      // `max_codes_per_order_exceeded`.
      for (var p2 = 0; p2 < codes.length; p2 += 1) {
        if (applied.length < gov.max_codes_per_order) {
          applied.push(codes[p2]);
        } else {
          refused.push({ code: codes[p2], reason: "max_codes_per_order_exceeded" });
        }
      }
    } else {
      // Single-code policy — first code applies, rest refused.
      applied.push(codes[0]);
      for (var p3 = 1; p3 < codes.length; p3 += 1) {
        refused.push({ code: codes[p3], reason: "other_codes_not_allowed_to_stack" });
      }
    }

    // Quantity-discount stack rule. When a q-discount is already on
    // the cart and the governing policy refuses
    // `with_quantity_discounts`, the cart-level allowed flag flips
    // off — the cart layer must drop either the codes or the
    // q-discounts (operator UI decides which).
    var allowed = applied.length > 0;
    if (read.has_quantity_discount && !gov.allow_combine.with_quantity_discounts) {
      refused.push({ code: "__quantity_discount__", reason: "quantity_discount_stack_refused" });
      allowed = false;
    }
    return { allowed: allowed, applied: applied, refused: refused };
  }

  return {
    definePolicy:           definePolicy,
    getPolicy:              getPolicy,
    listPolicies:           listPolicies,
    updatePolicy:           updatePolicy,
    archivePolicy:          archivePolicy,
    evaluate:               evaluate,
    activePoliciesForCart:  activePoliciesForCart,
  };
}

module.exports = {
  create:                  create,
  ALLOWED_COMBINE_KEYS:    ALLOWED_COMBINE_KEYS,
  ALLOWED_PATCH_COLUMNS:   ALLOWED_PATCH_COLUMNS,
  MAX_EXCLUSIVE_CODES:     MAX_EXCLUSIVE_CODES,
  MAX_SEGMENT_SLUGS:       MAX_SEGMENT_SLUGS,
  MAX_MAX_CODES:           MAX_MAX_CODES,
};
