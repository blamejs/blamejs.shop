"use strict";
/**
 * @module shop.cart
 * @title  Cart primitive — anonymous + authenticated shopping carts
 *
 * @intro
 *   Persistent carts keyed by a `session_id` carried in a sealed
 *   cookie (set by the storefront route layer). Anonymous shoppers
 *   get a cart with `customer_id = NULL`; on customer login the
 *   shop calls `cart.merge(anonId, customerCartId)` so the
 *   shopper's working cart adopts the authenticated identity. The
 *   cart row survives container restarts (D1, not session-memory).
 *
 *   Price snapshots: every line captures the current
 *   `prices.current(variant, currency)` at add time and stores
 *   `unit_amount_minor` + `unit_currency` on the line. A later
 *   `catalog.prices.set()` doesn't silently re-price an in-flight
 *   cart — the storefront can show "price changed" notices by
 *   diffing the line snapshot against the current price.
 *
 *   Lifecycle status:
 *     active     — the shopper's working cart (one per session_id)
 *     abandoned  — expired or explicitly abandoned
 *     converted  — checkout completed; immutable post-conversion
 */

var b = require("./vendor/blamejs");
// Framework constants (C.TIME / C.BYTES duration + byte helpers). The
// index entry point exposes `framework` before the require cascade, so
// resolving this at module-eval is safe.
var C = b.constants;

var CART_STATUSES   = Object.freeze(["active", "abandoned", "converted"]);
var DEFAULT_TTL_MS  = C.TIME.days(30);
var MAX_QTY         = 99999;
var SESSION_ID_RE   = /^[A-Za-z0-9_-]{16,64}$/;   // shape-only; sealed-cookie origin
var CURRENCY_RE     = /^[A-Z]{3}$/;
// Discount-code shape — the string a shopper types on the cart page. Same
// alnum + dot + hyphen + underscore family the autoDiscount unlock_code +
// couponStacking primitives accept, so the three surfaces agree on what a
// "code" is. Refuses whitespace + control bytes; caps length.
var DISCOUNT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var MAX_CODES_PER_CART = 16;

// Abandoned-cart visibility defaults. A cart counts as "abandoned" for the
// operator dashboard when it is still `active`, carries at least one line,
// and has not been touched (no `updated_at` bump) for at least
// `idle_threshold_ms`. This reads the live `carts` table directly — it does
// NOT require the cart-abandonment scanner's detection rows to exist, so an
// operator who never wired the recovery cron still sees their idle carts.
var ABANDONED_DEFAULT_IDLE_MS = C.TIME.hours(24);
var ABANDONED_MIN_IDLE_MS     = C.TIME.minutes(1);   // floor so a 0h window can't list live carts
var ABANDONED_MAX_IDLE_MS     = C.TIME.days(90);     // ceiling — past this the TTL has abandoned it anyway
var ABANDONED_DEFAULT_LIMIT   = 50;
var ABANDONED_MAX_LIMIT       = 200;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("cart: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _sessionId(s) {
  if (typeof s !== "string" || !SESSION_ID_RE.test(s)) {
    throw new TypeError("cart: session_id must be 16-64 chars of [A-Za-z0-9_-]");
  }
}
function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("cart: currency must be a 3-letter ISO 4217 code (uppercase)");
  }
}
function _qty(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTY) {
    throw new TypeError("cart: qty must be a positive integer ≤ " + MAX_QTY);
  }
}
function _status(s) {
  if (CART_STATUSES.indexOf(s) === -1) {
    throw new TypeError("cart: status must be one of " + CART_STATUSES.join(", "));
  }
}
function _discountCode(s) {
  if (typeof s !== "string" || !DISCOUNT_CODE_RE.test(s)) {
    throw new TypeError("cart: discount code must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ 64 chars)");
  }
  return s;
}

function _now() { return Date.now(); }

// Defensive request-shape readers for the abandoned-cart dashboard window.
// A garbage / out-of-range value (a hand-typed `?hours=` query param) clamps
// to a sane default rather than throwing — the console must never 500 on a
// fat-fingered filter. The bounds also stop a caller widening the scan past
// the ceiling (idle floor keeps live carts out; limit ceiling keeps the
// payload bounded).
function _abandonedIdleMs(v) {
  if (v == null) return ABANDONED_DEFAULT_IDLE_MS;
  var n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !isFinite(n)) return ABANDONED_DEFAULT_IDLE_MS;
  n = Math.floor(n);
  if (n < ABANDONED_MIN_IDLE_MS) return ABANDONED_MIN_IDLE_MS;
  if (n > ABANDONED_MAX_IDLE_MS) return ABANDONED_MAX_IDLE_MS;
  return n;
}
function _abandonedLimit(v) {
  if (v == null) return ABANDONED_DEFAULT_LIMIT;
  var n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !isFinite(n)) return ABANDONED_DEFAULT_LIMIT;
  n = Math.floor(n);
  if (n < 1) return ABANDONED_DEFAULT_LIMIT;
  if (n > ABANDONED_MAX_LIMIT) return ABANDONED_MAX_LIMIT;
  return n;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional catalog handle — when present, addLine looks up the
  // current price for the variant + currency to snapshot onto the
  // line. Callers may also pass an explicit price snapshot in
  // `addLine(...)` for testing or for off-catalog items.
  var catalog = opts.catalog || null;
  var ttlMs   = opts.ttlMs   || DEFAULT_TTL_MS;

  return {
    create: async function (sessionId, input) {
      _sessionId(sessionId);
      input = input || {};
      _currency(input.currency);
      var id = b.uuid.v7();
      var ts = _now();
      var expires = ts + ttlMs;
      await query(
        "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
        "VALUES (?1, ?2, NULL, ?3, 'active', ?4, ?4, ?5)",
        [id, sessionId, input.currency, ts, expires],
      );
      return { id: id, session_id: sessionId, customer_id: null, currency: input.currency, status: "active", created_at: ts, updated_at: ts, expires_at: expires };
    },

    get: async function (id) {
      _uuid(id, "cart id");
      var r = await query("SELECT * FROM carts WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    bySession: async function (sessionId) {
      _sessionId(sessionId);
      // Active row per session is unique via the partial UNIQUE
      // index in the migration, so LIMIT 1 is safe.
      var r = await query(
        "SELECT * FROM carts WHERE session_id = ?1 AND status = 'active' LIMIT 1",
        [sessionId],
      );
      return r.rows[0] || null;
    },

    listLines: async function (cartId) {
      _uuid(cartId, "cart_id");
      var r = await query(
        "SELECT * FROM cart_lines WHERE cart_id = ?1 ORDER BY added_at ASC",
        [cartId],
      );
      return r.rows;
    },

    // Adds qty to an existing variant line if present, else inserts
    // a new line. Price snapshot resolution order:
    //   1. input.unit_amount_minor + input.unit_currency (explicit)
    //   2. catalog.prices.current(variant_id, cart.currency) (implicit)
    // If neither yields a price, the call throws.
    addLine: async function (cartId, input) {
      _uuid(cartId, "cart_id");
      if (!input || typeof input !== "object") throw new TypeError("cart.addLine: input object required");
      _uuid(input.variant_id, "variant_id");
      _qty(input.qty);
      // Pull the parent cart for currency + status + variant SKU.
      var cartRow = (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0];
      if (!cartRow) throw new TypeError("cart.addLine: cart " + cartId + " not found");
      if (cartRow.status !== "active") throw new TypeError("cart.addLine: cart status is " + cartRow.status + ", cannot modify");
      // Resolve price snapshot.
      var unitAmount = null;
      var unitCurrency = null;
      if (input.unit_amount_minor != null && input.unit_currency != null) {
        if (!Number.isInteger(input.unit_amount_minor) || input.unit_amount_minor < 0) {
          throw new TypeError("cart.addLine: unit_amount_minor must be a non-negative integer");
        }
        if (typeof input.unit_currency !== "string" || !CURRENCY_RE.test(input.unit_currency)) {
          throw new TypeError("cart.addLine: unit_currency must be a 3-letter ISO 4217 code");
        }
        unitAmount = input.unit_amount_minor;
        unitCurrency = input.unit_currency;
      } else {
        if (!catalog) throw new Error("cart.addLine: no catalog handle and no explicit price snapshot — cannot resolve unit price");
        var price = await catalog.prices.current(input.variant_id, cartRow.currency);
        if (!price) throw new TypeError("cart.addLine: no current price for variant " + input.variant_id + " in " + cartRow.currency);
        unitAmount = price.amount_minor;
        unitCurrency = price.currency;
      }
      // Fetch variant SKU for the line snapshot.
      var variantRow = (await query("SELECT sku FROM variants WHERE id = ?1", [input.variant_id])).rows[0];
      if (!variantRow) throw new TypeError("cart.addLine: variant " + input.variant_id + " not found");
      // Upsert: if a line for this (cart, variant) exists, bump qty.
      var existing = (await query(
        "SELECT * FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2 LIMIT 1",
        [cartId, input.variant_id],
      )).rows[0];
      var ts = _now();
      if (existing) {
        var newQty = existing.qty + input.qty;
        _qty(newQty);
        await query(
          "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3",
          [newQty, ts, existing.id],
        );
        await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
        return Object.assign({}, existing, { qty: newQty, updated_at: ts });
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        [id, cartId, input.variant_id, variantRow.sku, input.qty, unitAmount, unitCurrency, ts],
      );
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
      return { id: id, cart_id: cartId, variant_id: input.variant_id, sku: variantRow.sku, qty: input.qty, unit_amount_minor: unitAmount, unit_currency: unitCurrency, added_at: ts, updated_at: ts };
    },

    // Price-authoritative bundle upsert. addLine is a qty-bump that KEEPS the
    // existing line's price; a bundle member must instead land at the bundle's
    // allocated per-unit price even when the variant is already in the cart
    // standalone, or the realized cart subtotal drifts above the advertised
    // bundle price (the standalone line's list price is charged for the bundle
    // unit). setBundleLine SETS the line's qty, unit price, and currency to the
    // bundle's values (overwrite, not add): a pre-existing line is re-stated at
    // the bundle's terms and re-adding the same bundle is idempotent. The price
    // snapshot is REQUIRED — the bundle pricer is authoritative, there is no
    // catalog fallback.
    setBundleLine: async function (cartId, input) {
      _uuid(cartId, "cart_id");
      if (!input || typeof input !== "object") throw new TypeError("cart.setBundleLine: input object required");
      _uuid(input.variant_id, "variant_id");
      _qty(input.qty);
      if (!Number.isInteger(input.unit_amount_minor) || input.unit_amount_minor < 0) {
        throw new TypeError("cart.setBundleLine: unit_amount_minor must be a non-negative integer");
      }
      if (typeof input.unit_currency !== "string" || !CURRENCY_RE.test(input.unit_currency)) {
        throw new TypeError("cart.setBundleLine: unit_currency must be a 3-letter ISO 4217 code");
      }
      var cartRow = (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0];
      if (!cartRow) throw new TypeError("cart.setBundleLine: cart " + cartId + " not found");
      if (cartRow.status !== "active") throw new TypeError("cart.setBundleLine: cart status is " + cartRow.status + ", cannot modify");
      var variantRow = (await query("SELECT sku FROM variants WHERE id = ?1", [input.variant_id])).rows[0];
      if (!variantRow) throw new TypeError("cart.setBundleLine: variant " + input.variant_id + " not found");
      var existing = (await query(
        "SELECT * FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2 LIMIT 1",
        [cartId, input.variant_id],
      )).rows[0];
      var ts = _now();
      if (existing) {
        await query(
          "UPDATE cart_lines SET qty = ?1, unit_amount_minor = ?2, unit_currency = ?3, updated_at = ?4 WHERE id = ?5",
          [input.qty, input.unit_amount_minor, input.unit_currency, ts, existing.id],
        );
        await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
        return Object.assign({}, existing, {
          qty: input.qty, unit_amount_minor: input.unit_amount_minor,
          unit_currency: input.unit_currency, updated_at: ts,
        });
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        [id, cartId, input.variant_id, variantRow.sku, input.qty, input.unit_amount_minor, input.unit_currency, ts],
      );
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
      return {
        id: id, cart_id: cartId, variant_id: input.variant_id, sku: variantRow.sku,
        qty: input.qty, unit_amount_minor: input.unit_amount_minor,
        unit_currency: input.unit_currency, added_at: ts, updated_at: ts,
      };
    },

    // Scope the mutation to (lineId, cartId): a caller who learns
    // another visitor's cart_lines.id (it's rendered in their own cart
    // HTML as the update/remove form action) can't mutate it because
    // the row only matches when it also belongs to the caller's session
    // cart. A cross-cart id matches zero rows and becomes a no-op
    // (returns null), never a mutation. cartId is required — every
    // caller resolves the session cart first.
    updateLine: async function (lineId, cartId, patch) {
      _uuid(lineId, "line id");
      _uuid(cartId, "cart_id");
      if (!patch || typeof patch !== "object") throw new TypeError("cart.updateLine: patch object required");
      if (patch.qty == null) throw new TypeError("cart.updateLine: qty is the only updatable field");
      _qty(patch.qty);
      var ts = _now();
      var r = await query(
        "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3 AND cart_id = ?4",
        [patch.qty, ts, lineId, cartId],
      );
      if (r.rowCount === 0) return null;
      var row = (await query("SELECT * FROM cart_lines WHERE id = ?1 AND cart_id = ?2", [lineId, cartId])).rows[0];
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
      return row;
    },

    // Same cart-scoping as updateLine: a row only deletes when it
    // belongs to the caller's session cart, so a cross-cart id is a
    // no-op (returns false) rather than deleting another visitor's line.
    removeLine: async function (lineId, cartId) {
      _uuid(lineId, "line id");
      _uuid(cartId, "cart_id");
      var row = (await query(
        "SELECT cart_id FROM cart_lines WHERE id = ?1 AND cart_id = ?2",
        [lineId, cartId],
      )).rows[0];
      if (!row) return false;
      await query("DELETE FROM cart_lines WHERE id = ?1 AND cart_id = ?2", [lineId, cartId]);
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [_now(), cartId]);
      return true;
    },

    // Customer login flow: merge an anonymous cart's lines into the
    // customer's existing active cart, then mark the anonymous cart
    // abandoned. Lines that collide on variant_id sum qty. The
    // returned cart is the surviving (customer's) cart.
    merge: async function (fromCartId, toCartId) {
      _uuid(fromCartId, "from cart_id");
      _uuid(toCartId,   "to cart_id");
      if (fromCartId === toCartId) throw new TypeError("cart.merge: fromCartId === toCartId");
      var fromLines = (await query("SELECT * FROM cart_lines WHERE cart_id = ?1", [fromCartId])).rows;
      var ts = _now();
      for (var i = 0; i < fromLines.length; i += 1) {
        var l = fromLines[i];
        var existing = (await query(
          "SELECT * FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2",
          [toCartId, l.variant_id],
        )).rows[0];
        if (existing) {
          var newQty = Math.min(existing.qty + l.qty, MAX_QTY);
          await query(
            "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3",
            [newQty, ts, existing.id],
          );
        } else {
          var newId = b.uuid.v7();
          await query(
            "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            [newId, toCartId, l.variant_id, l.sku, l.qty, l.unit_amount_minor, l.unit_currency, ts],
          );
        }
      }
      // Carry the anonymous cart's applied discount codes onto the
      // surviving cart so a code typed before sign-in isn't silently
      // dropped on login. A code already on the destination cart wins
      // (INSERT OR IGNORE against the UNIQUE (cart_id, code_lower)).
      // Best-effort: the cart_discount_codes table may not be migrated on a
      // given deploy (the coupon feature is additive), so a missing table
      // degrades to "codes not carried" rather than failing the whole login
      // merge — the line merge is the load-bearing part.
      try {
        var fromCodes = (await query(
          "SELECT * FROM cart_discount_codes WHERE cart_id = ?1", [fromCartId],
        )).rows;
        for (var ci = 0; ci < fromCodes.length; ci += 1) {
          var fc = fromCodes[ci];
          await query(
            "INSERT OR IGNORE INTO cart_discount_codes (id, cart_id, code, code_lower, rule_slug, applied_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            [b.uuid.v7(), toCartId, fc.code, fc.code_lower, fc.rule_slug, ts],
          );
        }
      } catch (_e) { /* cart_discount_codes unmigrated — codes simply don't carry */ }
      await query("UPDATE carts SET status = 'abandoned', updated_at = ?1 WHERE id = ?2", [ts, fromCartId]);
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, toCartId]);
      return (await query("SELECT * FROM carts WHERE id = ?1", [toCartId])).rows[0];
    },

    setCustomer: async function (cartId, customerId) {
      _uuid(cartId,    "cart_id");
      _uuid(customerId, "customer_id");
      var ts = _now();
      var r = await query(
        "UPDATE carts SET customer_id = ?1, updated_at = ?2 WHERE id = ?3",
        [customerId, ts, cartId],
      );
      if (r.rowCount === 0) return null;
      return (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0];
    },

    setStatus: async function (cartId, status) {
      _uuid(cartId, "cart_id");
      _status(status);
      var ts = _now();
      var r = await query(
        "UPDATE carts SET status = ?1, updated_at = ?2 WHERE id = ?3",
        [status, ts, cartId],
      );
      if (r.rowCount === 0) return null;
      return (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0];
    },

    // Atomically claim an ACTIVE cart for checkout. The `AND status =
    // 'active'` predicate is the serialization point: on D1 a single UPDATE
    // is atomic, so when two concurrent POST /checkout requests race the same
    // cart (a double-click, two tabs) exactly ONE flips it to 'converted' and
    // matches the row; the other matches zero rows and loses. The winner runs
    // the (single) charge + order; the loser is told the checkout is already
    // in progress and never creates a second PaymentIntent or order.
    //
    // Returns `{ claimed: true, cart }` for the winner, `{ claimed: false,
    // cart }` for the loser (cart is the post-claim row so the caller can
    // redirect to its order), or `{ claimed: false, cart: null }` when the
    // cart id doesn't exist at all. A non-active cart (already converted /
    // abandoned) loses the claim — the existing checkout owns it.
    claimForCheckout: async function (cartId) {
      _uuid(cartId, "cart_id");
      var ts = _now();
      var r = await query(
        "UPDATE carts SET status = 'converted', updated_at = ?1 WHERE id = ?2 AND status = 'active'",
        [ts, cartId],
      );
      var cart = (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0] || null;
      return { claimed: Number(r.rowCount || 0) === 1, cart: cart };
    },

    // Release a checkout claim back to 'active' so the buyer can retry. The
    // checkout flow claims the cart (claimForCheckout) BEFORE the charge so a
    // concurrent racer is locked out; if the charge / order creation then
    // throws BEFORE the order exists, the claimer releases the cart so the
    // shopper isn't stranded on a permanently-'converted' cart with no order
    // to show. Atomic + self-targeting: `AND status = 'converted'` makes a
    // double-release a no-op, and only the claimer (which set 'converted')
    // ever calls this, so it can't resurrect a cart a DIFFERENT completed
    // checkout legitimately converted. Returns true when the cart was
    // released, false when there was nothing to release.
    releaseCheckoutClaim: async function (cartId) {
      _uuid(cartId, "cart_id");
      var ts = _now();
      var r = await query(
        "UPDATE carts SET status = 'active', updated_at = ?1 WHERE id = ?2 AND status = 'converted'",
        [ts, cartId],
      );
      return Number(r.rowCount || 0) === 1;
    },

    // ---- abandoned-cart visibility (operator dashboard) ---------------
    //
    // A cart is "abandoned" for dashboard purposes when it is still
    // `active`, has at least one line, and hasn't been touched for
    // `idle_threshold_ms` (default 24h, operator-tunable). This reads the
    // live `carts` / `cart_lines` tables — it needs NO scanner detection
    // rows and NO schema change, so an operator who never wired the
    // recovery cron still sees their idle carts.
    //
    // Defensive request-shape reader tier: a missing / garbage option
    // falls back to a sane default rather than throwing, so a hand-typed
    // `?hours=` query param can't 500 the console. The window is clamped
    // to [1min, 90d] and the limit to [1, 200] — a caller can't widen the
    // scan past the bounded ceiling.

    // List abandoned carts, most-recent-activity-first, each enriched with
    // its line count + subtotal-in-minor-units + age. Bounded by `limit`
    // (default 50, max 200). The `idle_threshold_ms` option sets the
    // untouched-for window; carts updated more recently than that are still
    // "live" and excluded. Carts with zero lines are excluded (an empty
    // cart has nothing to recover).
    listAbandoned: async function (listOpts) {
      listOpts = listOpts || {};
      var idleMs = _abandonedIdleMs(listOpts.idle_threshold_ms);
      var limit  = _abandonedLimit(listOpts.limit);
      var now    = listOpts.now == null ? _now() : listOpts.now;
      var cutoff = now - idleMs;
      // INNER JOIN onto an aggregate of cart_lines so the zero-line carts
      // drop out (a cart with no lines produces no group row) and we read
      // the line count + subtotal in one pass. ORDER BY updated_at DESC =
      // freshest-abandonment first (the operator's most-actionable carts).
      var rows = (await query(
        "SELECT c.id AS id, c.session_id AS session_id, c.customer_id AS customer_id, " +
        "       c.currency AS currency, c.created_at AS created_at, c.updated_at AS updated_at, " +
        "       agg.line_count AS line_count, agg.subtotal_minor AS subtotal_minor " +
        "FROM carts c " +
        "JOIN (SELECT cart_id, COUNT(*) AS line_count, " +
        "             SUM(qty * unit_amount_minor) AS subtotal_minor " +
        "      FROM cart_lines GROUP BY cart_id) agg ON agg.cart_id = c.id " +
        "WHERE c.status = 'active' AND c.updated_at <= ?1 " +
        "ORDER BY c.updated_at DESC, c.id DESC LIMIT ?2",
        [cutoff, limit],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        out.push({
          id:             r.id,
          // session_id is sealed-cookie material — never surface it raw to
          // the operator screen; a short opaque tag of the cart id is the
          // dashboard handle. customer_id passes through so the console can
          // link signed-in carts to /admin/customers/<id>.
          customer_id:    r.customer_id || null,
          currency:       r.currency,
          line_count:     Number(r.line_count || 0),
          subtotal_minor: Number(r.subtotal_minor || 0),
          created_at:     Number(r.created_at),
          updated_at:     Number(r.updated_at),
          idle_ms:        Math.max(0, now - Number(r.updated_at)),
        });
      }
      return out;
    },

    // Summary stats for the same abandoned-cart window: how many carts are
    // at risk + the total value (sum of subtotals) across them, per
    // currency. The console renders this as the headline "N carts, X at
    // risk" line. Unbounded COUNT/SUM (cheap aggregate, no row payload).
    abandonedSummary: async function (sumOpts) {
      sumOpts = sumOpts || {};
      var idleMs = _abandonedIdleMs(sumOpts.idle_threshold_ms);
      var now    = sumOpts.now == null ? _now() : sumOpts.now;
      var cutoff = now - idleMs;
      var rows = (await query(
        "SELECT c.currency AS currency, COUNT(*) AS cart_count, " +
        "       SUM(agg.subtotal_minor) AS value_minor " +
        "FROM carts c " +
        "JOIN (SELECT cart_id, SUM(qty * unit_amount_minor) AS subtotal_minor " +
        "      FROM cart_lines GROUP BY cart_id) agg ON agg.cart_id = c.id " +
        "WHERE c.status = 'active' AND c.updated_at <= ?1 " +
        "GROUP BY c.currency",
        [cutoff],
      )).rows;
      var byCurrency = [];
      var totalCarts = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var n = Number(rows[i].cart_count || 0);
        totalCarts += n;
        byCurrency.push({
          currency:    rows[i].currency,
          cart_count:  n,
          value_minor: Number(rows[i].value_minor || 0),
        });
      }
      return {
        idle_threshold_ms: idleMs,
        cart_count:        totalCarts,
        by_currency:       byCurrency,
      };
    },

    // ---- applied discount codes ---------------------------------------
    //
    // A cart carries the discount codes a shopper applied on the cart page.
    // The codes are stored as typed; `code_lower` is the case-insensitive
    // key the UNIQUE (cart_id, code_lower) constraint + the rule lookup
    // both use, so applying the same code twice is idempotent rather than
    // stacking duplicate rows. These methods own ONLY the storage; the
    // caller validates a code against the discount engine before applying
    // (the cart never decides a code is valid — it persists what the
    // storefront route accepted).

    // Persist an accepted code on the cart. `rule_slug` snapshots which
    // discount rule the code resolved to at apply time (audit convenience).
    // Idempotent on (cart_id, code_lower): re-applying refreshes the
    // snapshot + timestamp rather than erroring. Returns the stored row.
    addDiscountCode: async function (cartId, code, ruleSlug) {
      _uuid(cartId, "cart_id");
      _discountCode(code);
      var lower = code.toLowerCase();
      var ts = _now();
      var existing = (await query(
        "SELECT id FROM cart_discount_codes WHERE cart_id = ?1 AND code_lower = ?2 LIMIT 1",
        [cartId, lower],
      )).rows[0];
      if (existing) {
        await query(
          "UPDATE cart_discount_codes SET code = ?1, rule_slug = ?2, applied_at = ?3 WHERE id = ?4",
          [code, ruleSlug == null ? null : String(ruleSlug), ts, existing.id],
        );
        return { id: existing.id, cart_id: cartId, code: code, code_lower: lower, rule_slug: ruleSlug == null ? null : String(ruleSlug), applied_at: ts };
      }
      // Cap the codes a single cart can carry so a scripted apply loop can't
      // grow the row set unbounded.
      var countRow = (await query(
        "SELECT COUNT(*) AS n FROM cart_discount_codes WHERE cart_id = ?1",
        [cartId],
      )).rows[0] || {};
      if ((Number(countRow.n) || 0) >= MAX_CODES_PER_CART) {
        throw new TypeError("cart.addDiscountCode: cart already carries the maximum of " + MAX_CODES_PER_CART + " codes");
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO cart_discount_codes (id, cart_id, code, code_lower, rule_slug, applied_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, cartId, code, lower, ruleSlug == null ? null : String(ruleSlug), ts],
      );
      return { id: id, cart_id: cartId, code: code, code_lower: lower, rule_slug: ruleSlug == null ? null : String(ruleSlug), applied_at: ts };
    },

    // The cart's applied codes, apply order. Returns the stored rows.
    listDiscountCodes: async function (cartId) {
      _uuid(cartId, "cart_id");
      var r = await query(
        "SELECT * FROM cart_discount_codes WHERE cart_id = ?1 ORDER BY applied_at ASC, id ASC",
        [cartId],
      );
      return r.rows;
    },

    // Remove one applied code (case-insensitive). Returns true when a row
    // was removed, false when the code wasn't on the cart.
    removeDiscountCode: async function (cartId, code) {
      _uuid(cartId, "cart_id");
      _discountCode(code);
      var r = await query(
        "DELETE FROM cart_discount_codes WHERE cart_id = ?1 AND code_lower = ?2",
        [cartId, code.toLowerCase()],
      );
      return Number(r.rowCount || 0) > 0;
    },
  };
}

module.exports = {
  create:                    create,
  DEFAULT_TTL_MS:            DEFAULT_TTL_MS,
  MAX_QTY:                   MAX_QTY,
  CART_STATUSES:             CART_STATUSES,
  ABANDONED_DEFAULT_IDLE_MS: ABANDONED_DEFAULT_IDLE_MS,
  ABANDONED_MAX_LIMIT:       ABANDONED_MAX_LIMIT,
};
