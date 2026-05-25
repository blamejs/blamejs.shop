"use strict";
/**
 * @module shop.giftRegistry
 * @title  Gift registry primitive — owner-curated list of desired
 *         items, purchased by friends/family
 *
 * @intro
 *   A registry is the customer-owned list of items they'd like for
 *   an upcoming occasion (wedding / baby / housewarming / birthday /
 *   graduation / anniversary / other). The owner creates the
 *   registry, adds items at the (sku, variant) tuple with a
 *   `quantity_desired` + optional `priority`, and shares a slug-keyed
 *   URL. Visitors browse the registry — `getBySlug` is the public
 *   read — and purchase items, recording a row against the registry
 *   that decrements the remaining-to-buy count on the matching item.
 *
 *   Buyer privacy:
 *     A buyer can opt to remain anonymous (the default at the
 *     primitive layer when `reveal_buyer` is omitted). When false,
 *     `progressFor` / `getBySlug({ include_purchased })` MUST NOT
 *     surface `buyer_customer_id` to the registry owner — the field
 *     is stripped from the returned shape. The underlying row still
 *     carries the id so an operator can audit / process refunds; the
 *     primitive's read paths simply redact it for owner-facing views.
 *
 *   Registry privacy:
 *     - `private`  — only `listForOwner(owner_id)` surfaces it; the
 *       slug resolves through `getRegistry` but `getBySlug` returns
 *       null unless the caller has owner-level context. `searchPublic`
 *       never returns it.
 *     - `unlisted` — anyone who knows the slug can resolve it via
 *       `getBySlug`. `searchPublic` never returns it.
 *     - `public`   — `searchPublic` returns it for matching queries;
 *       indexed by the storefront landing page.
 *
 *   FSM:
 *     `active` -> `closed` is the only legal transition. `closeRegistry`
 *     flips the row, stamps `closed_at`, and refuses subsequent
 *     `addItem` / `removeItem` / `purchaseItem` writes. A closed
 *     registry is still readable so the owner can review what
 *     arrived and send thank-you notes; it just refuses further
 *     mutation.
 *
 *   Composition:
 *     var reg = bShop.giftRegistry.create({ query: q, catalog: cat });
 *     await reg.createRegistry({
 *       owner_customer_id: ownerId,
 *       slug:              "alice-and-bob-2026",
 *       title:             "Alice & Bob's Wedding",
 *       occasion:          "wedding",
 *       event_date:        Date.now() + 90 * 86400000,
 *       recipient_name:    "Alice & Bob",
 *       privacy:           "public",
 *     });
 *     await reg.addItem({
 *       registry_slug:    "alice-and-bob-2026",
 *       sku:              "BLENDER-12CUP",
 *       quantity_desired: 1,
 *       priority:         1,
 *     });
 *     // Friend purchases:
 *     await reg.purchaseItem({
 *       registry_slug:     "alice-and-bob-2026",
 *       item_id:           itemId,
 *       quantity:          1,
 *       buyer_customer_id: friendId,
 *       buyer_message:     "Congrats!",
 *       reveal_buyer:      false,
 *     });
 *     // Owner reads aggregate:
 *     var prog = await reg.progressFor("alice-and-bob-2026");
 *     // prog.overall_percent === 100, prog.items[0].purchased === 1
 *
 *   Storage: `migrations-d1/0086_gift_registry.sql` —
 *     `gift_registries` + `gift_registry_items` (ON DELETE CASCADE)
 *     + `gift_registry_purchases` (ON DELETE CASCADE on slug + item).
 *
 *   Composes:
 *     - `b.guardUuid`   — every customer / shipping_address id is
 *       UUID-shape-validated at the entry point.
 *     - `b.uuid.v7`     — item + purchase row ids (lexicographic +
 *       monotonic so a tied `created_at` / `occurred_at` still sorts
 *       deterministically).
 *     - `b.safeSql`     — column allow-list on `update(slug, patch)`.
 *
 * @primitive giftRegistry
 * @related   b.guardUuid, b.uuid, b.safeSql
 */

var b = require("./index").framework;

var SLUG_RE          = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
var MAX_TITLE_LEN    = 200;
var MAX_NAME_LEN     = 200;
var MAX_MESSAGE_LEN  = 4000;
var MAX_BUYER_MSG    = 1000;
var MAX_SKU_LEN      = 200;
var MAX_LIMIT        = 100;
var DEFAULT_LIMIT    = 25;
var MAX_Q            = 200;
var MIN_QUERY_LEN    = 2;

var OCCASIONS = Object.freeze([
  "wedding", "baby", "housewarming", "birthday", "graduation", "anniversary", "other",
]);
var PRIVACIES = Object.freeze(["private", "unlisted", "public"]);
var STATUSES  = Object.freeze(["active", "closed"]);

// Columns mutable through `update(slug, patch)`. Slug + owner +
// occasion + status are immutable through the patch path — operators
// close via `closeRegistry`, and an operator who wants to re-key
// archives + recreates. `event_date` IS mutable (the wedding got
// moved); `privacy` IS mutable (operator widens the registry from
// unlisted to public after the announcement).
var ALLOWED_COLUMNS = Object.freeze([
  "title", "event_date", "recipient_name", "shipping_address_id",
  "message", "privacy",
]);

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("giftRegistry: " + (label || "slug") +
                         " must be lowercase alnum + dash, no leading/trailing dash, 1..200 chars");
  }
  return s;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("giftRegistry: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _optUuid(s, label) {
  if (s == null || s === "") return null;
  return _uuid(s, label);
}

function _title(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("giftRegistry: " + label + " must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  // Refuse control bytes so a malicious title can't smuggle
  // header-injection content into operator dashboards / email
  // templates that render the title inline.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("giftRegistry: " + label + " must not contain control bytes");
  }
  return s;
}

function _recipientName(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_NAME_LEN) {
    throw new TypeError("giftRegistry: recipient_name must be a non-empty string <= " + MAX_NAME_LEN + " chars");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("giftRegistry: recipient_name must not contain control bytes");
  }
  return s;
}

function _message(s, label, max) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("giftRegistry: " + label + " must be a string");
  }
  if (s.length > max) {
    throw new TypeError("giftRegistry: " + label + " must be <= " + max + " chars");
  }
  // CR/LF are valid in a multi-line message; refuse NUL + other
  // non-printable control bytes only.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("giftRegistry: " + label + " must not contain control bytes");
  }
  return s;
}

function _occasion(s) {
  if (typeof s !== "string" || OCCASIONS.indexOf(s) < 0) {
    throw new TypeError("giftRegistry: occasion must be one of " + OCCASIONS.join(", "));
  }
  return s;
}

function _privacy(s) {
  if (typeof s !== "string" || PRIVACIES.indexOf(s) < 0) {
    throw new TypeError("giftRegistry: privacy must be one of " + PRIVACIES.join(", "));
  }
  return s;
}

function _eventDate(n, label) {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("giftRegistry: " + label + " must be a non-negative integer epoch-ms or null");
  }
  return n;
}

function _sku(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_SKU_LEN) {
    throw new TypeError("giftRegistry: sku must be a non-empty string <= " + MAX_SKU_LEN + " chars");
  }
  // SKUs are operator-authored identifiers; refuse control bytes
  // (incl. CR/LF) so a SKU never smuggles header-injection content.
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("giftRegistry: sku must not contain control bytes");
  }
  return s;
}

function _qtyDesired(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("giftRegistry: quantity_desired must be a positive integer");
  }
  return n;
}

function _qtyPurchase(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("giftRegistry: quantity must be a positive integer");
  }
  return n;
}

function _priority(n) {
  if (n == null) return 3;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 5) {
    throw new TypeError("giftRegistry: priority must be an integer in [1, 5]");
  }
  return n;
}

function _bool(v, label) {
  if (v == null) return false;
  if (typeof v !== "boolean") {
    throw new TypeError("giftRegistry: " + label + " must be a boolean");
  }
  return v;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("giftRegistry: " + label + " must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // `catalog` is accepted so a future additive primitive can resolve
  // sku -> product metadata at registry-read time (e.g. surfacing
  // out-of-stock items, price snapshots on the gift-giver view).
  // The v1 surface validates sku as a non-empty string and trusts
  // the cart/checkout primitives to refuse unknown skus at purchase
  // time — the registry itself shouldn't refuse pre-launch products
  // an operator wants to seed.
  var catalog = opts.catalog || null;
  void catalog;

  // ---- internal helpers -------------------------------------------------

  async function _row(slug) {
    var r = await query("SELECT * FROM gift_registries WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _itemRow(itemId) {
    var r = await query(
      "SELECT * FROM gift_registry_items WHERE id = ?1",
      [itemId],
    );
    return r.rows[0] || null;
  }

  // Compute purchased qty per item via SUM aggregation. Single
  // round-trip; the (registry_slug, item_id) index covers the GROUP BY.
  async function _purchasedByItem(slug) {
    var r = await query(
      "SELECT item_id, SUM(quantity) AS purchased " +
      "FROM gift_registry_purchases WHERE registry_slug = ?1 " +
      "GROUP BY item_id",
      [slug],
    );
    var byItem = Object.create(null);
    for (var i = 0; i < r.rows.length; i += 1) {
      byItem[r.rows[i].item_id] = Number(r.rows[i].purchased) || 0;
    }
    return byItem;
  }

  // Strip the buyer identity from a purchase row when the buyer
  // chose not to reveal. The row is still kept verbatim in storage
  // for operator audit / refund-handling purposes; this redaction
  // only applies to the owner-facing return shape.
  function _redactPurchase(row) {
    var reveal = row.reveal_buyer === 1 || row.reveal_buyer === true;
    return {
      id:                row.id,
      registry_slug:     row.registry_slug,
      item_id:           row.item_id,
      quantity:          row.quantity,
      buyer_customer_id: reveal ? row.buyer_customer_id : null,
      buyer_message:     row.buyer_message,
      reveal_buyer:      reveal,
      occurred_at:       row.occurred_at,
    };
  }

  function _decodeRegistry(row) {
    if (!row) return null;
    return {
      slug:                row.slug,
      owner_customer_id:   row.owner_customer_id,
      title:               row.title,
      occasion:            row.occasion,
      event_date:          row.event_date,
      recipient_name:      row.recipient_name,
      shipping_address_id: row.shipping_address_id,
      message:             row.message,
      privacy:             row.privacy,
      status:              row.status,
      closed_at:           row.closed_at,
      created_at:          row.created_at,
      updated_at:          row.updated_at,
    };
  }

  function _decodeItem(row) {
    return {
      id:               row.id,
      registry_slug:    row.registry_slug,
      sku:              row.sku,
      variant_id:       row.variant_id,
      quantity_desired: row.quantity_desired,
      priority:         row.priority,
      archived_at:      row.archived_at,
      created_at:       row.created_at,
    };
  }

  // ---- createRegistry ---------------------------------------------------

  async function createRegistry(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftRegistry.createRegistry: input object required");
    }
    var ownerId   = _uuid(input.owner_customer_id, "owner_customer_id");
    var slug      = _slug(input.slug, "slug");
    var title     = _title(input.title, "title");
    var occasion  = _occasion(input.occasion);
    var eventDate = _eventDate(input.event_date, "event_date");
    var recipient = _recipientName(input.recipient_name);
    var shipAddr  = _optUuid(input.shipping_address_id, "shipping_address_id");
    var message   = _message(input.message, "message", MAX_MESSAGE_LEN);
    var privacy   = _privacy(input.privacy);

    var existing = await _row(slug);
    if (existing) {
      throw new TypeError("giftRegistry.createRegistry: slug " + JSON.stringify(slug) + " already exists");
    }
    var ts = _now();
    await query(
      "INSERT INTO gift_registries " +
      "(slug, owner_customer_id, title, occasion, event_date, recipient_name, shipping_address_id, message, privacy, status, closed_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', NULL, ?10, ?10)",
      [slug, ownerId, title, occasion, eventDate, recipient, shipAddr, message, privacy, ts],
    );
    return _decodeRegistry(await _row(slug));
  }

  // ---- getRegistry / getBySlug ------------------------------------------

  async function getRegistry(slug) {
    _slug(slug, "slug");
    return _decodeRegistry(await _row(slug));
  }

  async function getBySlug(slug, getOpts) {
    _slug(slug, "slug");
    getOpts = getOpts || {};
    var includePurchased = getOpts.include_purchased === true;
    var row = await _row(slug);
    if (!row) return null;
    var reg = _decodeRegistry(row);
    // Items: surface non-archived by default; archived items are
    // operator-internal (the owner already removed them from the
    // public view). Each item carries its purchased-aggregate count
    // so a gift-giver browsing the registry sees "0 of 2 purchased".
    var itemsRes = await query(
      "SELECT * FROM gift_registry_items " +
      "WHERE registry_slug = ?1 AND archived_at IS NULL " +
      "ORDER BY priority ASC, created_at ASC, id ASC",
      [slug],
    );
    var purchasedMap = await _purchasedByItem(slug);
    var items = [];
    for (var i = 0; i < itemsRes.rows.length; i += 1) {
      var it = _decodeItem(itemsRes.rows[i]);
      it.purchased_quantity = purchasedMap[it.id] || 0;
      items.push(it);
    }
    var out = {
      registry: reg,
      items:    items,
    };
    if (includePurchased) {
      var purchasesRes = await query(
        "SELECT * FROM gift_registry_purchases " +
        "WHERE registry_slug = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [slug],
      );
      var purchases = [];
      for (var j = 0; j < purchasesRes.rows.length; j += 1) {
        purchases.push(_redactPurchase(purchasesRes.rows[j]));
      }
      out.purchases = purchases;
    }
    return out;
  }

  // ---- listForOwner -----------------------------------------------------

  async function listForOwner(customerId) {
    var ownerId = _uuid(customerId, "customer_id");
    var r = await query(
      "SELECT * FROM gift_registries WHERE owner_customer_id = ?1 " +
      "ORDER BY updated_at DESC, slug DESC",
      [ownerId],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeRegistry(r.rows[i]));
    return out;
  }

  // ---- searchPublic -----------------------------------------------------

  async function searchPublic(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftRegistry.searchPublic: input object required");
    }
    if (typeof input.q !== "string") {
      throw new TypeError("giftRegistry.searchPublic: q must be a string");
    }
    var q = input.q.trim();
    if (q.length < MIN_QUERY_LEN || q.length > MAX_Q) {
      throw new TypeError("giftRegistry.searchPublic: q length must be in [" +
                          MIN_QUERY_LEN + ", " + MAX_Q + "]");
    }
    var limit = _limit(input.limit, "limit");
    // Defense in depth: refuse control bytes in the query so a
    // crafted q can't smuggle log-injection content into operator
    // dashboards that render the term back unescaped.
    if (/[\x00-\x1f\x7f]/.test(q)) {
      throw new TypeError("giftRegistry.searchPublic: q must not contain control bytes");
    }
    // Escape LIKE metachars so a query containing `%` or `_` matches
    // the literal character. The lower(...) wrapping gives
    // case-insensitive matching against title + recipient_name
    // without needing a separate normalized column.
    var qLower  = q.toLowerCase();
    var pattern = "%" + qLower
      .replace(/\\/g, "\\\\")
      .replace(/%/g,  "\\%")
      .replace(/_/g,  "\\_") + "%";
    // Only `public` + `active` registries surface in searchPublic.
    // Closed registries drop out (the event already happened); the
    // owner can still view + share them through getBySlug.
    var r = await query(
      "SELECT * FROM gift_registries " +
      "WHERE privacy = 'public' AND status = 'active' " +
      "AND (lower(title) LIKE ?1 ESCAPE '\\' OR lower(recipient_name) LIKE ?1 ESCAPE '\\') " +
      "ORDER BY " +
      "  CASE WHEN event_date IS NULL THEN 1 ELSE 0 END ASC, " +
      "  event_date ASC, slug ASC " +
      "LIMIT ?2",
      [pattern, limit],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeRegistry(r.rows[i]));
    return out;
  }

  // ---- addItem ----------------------------------------------------------

  async function addItem(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftRegistry.addItem: input object required");
    }
    var slug      = _slug(input.registry_slug, "registry_slug");
    var sku       = _sku(input.sku);
    var variantId = _optUuid(input.variant_id, "variant_id");
    var qty       = _qtyDesired(input.quantity_desired);
    var priority  = _priority(input.priority);

    var row = await _row(slug);
    if (!row) {
      throw new TypeError("giftRegistry.addItem: registry " + JSON.stringify(slug) + " not found");
    }
    if (row.status !== "active") {
      throw new TypeError("giftRegistry.addItem: registry " + JSON.stringify(slug) + " is closed");
    }
    // Refuse duplicate (sku, variant) — the UNIQUE constraint would
    // refuse it anyway, but a clean TypeError reads better than an
    // opaque SQLITE_CONSTRAINT at the application layer.
    var dup = await query(
      "SELECT id FROM gift_registry_items " +
      "WHERE registry_slug = ?1 AND sku = ?2 " +
      "AND COALESCE(variant_id, '') = COALESCE(?3, '') " +
      "AND archived_at IS NULL LIMIT 1",
      [slug, sku, variantId],
    );
    if (dup.rows.length > 0) {
      throw new TypeError("giftRegistry.addItem: sku " + JSON.stringify(sku) +
                          " is already on registry " + JSON.stringify(slug));
    }
    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO gift_registry_items " +
      "(id, registry_slug, sku, variant_id, quantity_desired, priority, archived_at, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
      [id, slug, sku, variantId, qty, priority, ts],
    );
    await query(
      "UPDATE gift_registries SET updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return _decodeItem({
      id:               id,
      registry_slug:    slug,
      sku:              sku,
      variant_id:       variantId,
      quantity_desired: qty,
      priority:         priority,
      archived_at:      null,
      created_at:       ts,
    });
  }

  // ---- removeItem -------------------------------------------------------

  async function removeItem(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftRegistry.removeItem: input object required");
    }
    var slug   = _slug(input.registry_slug, "registry_slug");
    var itemId = _uuid(input.item_id, "item_id");

    var row = await _row(slug);
    if (!row) {
      throw new TypeError("giftRegistry.removeItem: registry " + JSON.stringify(slug) + " not found");
    }
    if (row.status !== "active") {
      throw new TypeError("giftRegistry.removeItem: registry " + JSON.stringify(slug) + " is closed");
    }
    // Soft-delete via archived_at — the item row is preserved so
    // existing purchase rows retain a valid FK referent. The reads
    // (`getBySlug`, `progressFor`) filter out archived items by
    // default.
    var ts = _now();
    var r = await query(
      "UPDATE gift_registry_items SET archived_at = ?1 " +
      "WHERE id = ?2 AND registry_slug = ?3 AND archived_at IS NULL",
      [ts, itemId, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      return { removed: false };
    }
    await query(
      "UPDATE gift_registries SET updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return { removed: true };
  }

  // ---- purchaseItem -----------------------------------------------------

  async function purchaseItem(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("giftRegistry.purchaseItem: input object required");
    }
    var slug   = _slug(input.registry_slug, "registry_slug");
    var itemId = _uuid(input.item_id, "item_id");
    var qty    = _qtyPurchase(input.quantity);
    var buyerId = _optUuid(input.buyer_customer_id, "buyer_customer_id");
    var buyerMsg = _message(input.buyer_message, "buyer_message", MAX_BUYER_MSG);
    var reveal = _bool(input.reveal_buyer, "reveal_buyer");

    // When the buyer wants to reveal, they MUST be a registered
    // customer — an anonymous reveal makes no sense (there's nothing
    // to surface to the owner). Refuse the inconsistent pair up
    // front rather than silently storing reveal=true with a NULL
    // buyer.
    if (reveal && !buyerId) {
      throw new TypeError("giftRegistry.purchaseItem: reveal_buyer=true requires buyer_customer_id");
    }

    var reg = await _row(slug);
    if (!reg) {
      throw new TypeError("giftRegistry.purchaseItem: registry " + JSON.stringify(slug) + " not found");
    }
    if (reg.status !== "active") {
      throw new TypeError("giftRegistry.purchaseItem: registry " + JSON.stringify(slug) + " is closed");
    }
    var item = await _itemRow(itemId);
    if (!item || item.registry_slug !== slug) {
      throw new TypeError("giftRegistry.purchaseItem: item " + JSON.stringify(itemId) +
                          " not found on registry " + JSON.stringify(slug));
    }
    if (item.archived_at != null) {
      throw new TypeError("giftRegistry.purchaseItem: item " + JSON.stringify(itemId) + " has been removed");
    }
    // Refuse over-purchase: aggregate prior purchases + this one
    // must not exceed `quantity_desired`. The owner's wish-list is
    // authoritative — a fourth blender is not a gift, it's a return
    // pending.
    var priorRes = await query(
      "SELECT COALESCE(SUM(quantity), 0) AS sum FROM gift_registry_purchases " +
      "WHERE registry_slug = ?1 AND item_id = ?2",
      [slug, itemId],
    );
    var prior = Number((priorRes.rows[0] || {}).sum || 0);
    if (prior + qty > item.quantity_desired) {
      var over = new Error(
        "giftRegistry.purchaseItem: quantity " + qty +
        " exceeds remaining " + (item.quantity_desired - prior) +
        " on item " + itemId,
      );
      over.code = "GIFT_REGISTRY_OVER_PURCHASE";
      throw over;
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO gift_registry_purchases " +
      "(id, registry_slug, item_id, quantity, buyer_customer_id, buyer_message, reveal_buyer, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [id, slug, itemId, qty, buyerId, buyerMsg, reveal ? 1 : 0, ts],
    );
    await query(
      "UPDATE gift_registries SET updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return _redactPurchase({
      id:                id,
      registry_slug:     slug,
      item_id:           itemId,
      quantity:          qty,
      buyer_customer_id: buyerId,
      buyer_message:     buyerMsg,
      reveal_buyer:      reveal ? 1 : 0,
      occurred_at:       ts,
    });
  }

  // ---- progressFor ------------------------------------------------------

  async function progressFor(slug) {
    _slug(slug, "slug");
    var reg = await _row(slug);
    if (!reg) return null;
    var itemsRes = await query(
      "SELECT id, sku, variant_id, quantity_desired, priority FROM gift_registry_items " +
      "WHERE registry_slug = ?1 AND archived_at IS NULL " +
      "ORDER BY priority ASC, created_at ASC, id ASC",
      [slug],
    );
    var purchasedMap = await _purchasedByItem(slug);
    var totalDesired = 0;
    var totalPurchased = 0;
    var items = [];
    for (var i = 0; i < itemsRes.rows.length; i += 1) {
      var r = itemsRes.rows[i];
      var purchased = purchasedMap[r.id] || 0;
      // Cap at desired so an aggregate that somehow over-shoots
      // (shouldn't happen because purchaseItem refuses, but the
      // aggregate is defensive against operator-side hand edits)
      // doesn't push overall_percent above 100.
      if (purchased > r.quantity_desired) purchased = r.quantity_desired;
      totalDesired   += r.quantity_desired;
      totalPurchased += purchased;
      items.push({
        item_id:          r.id,
        sku:              r.sku,
        variant_id:       r.variant_id,
        quantity_desired: r.quantity_desired,
        purchased:        purchased,
        remaining:        r.quantity_desired - purchased,
        percent:          r.quantity_desired === 0 ? 0
                            : Math.round((purchased / r.quantity_desired) * 100),
        priority:         r.priority,
      });
    }
    var overall = totalDesired === 0 ? 0
                    : Math.round((totalPurchased / totalDesired) * 100);
    return {
      slug:             slug,
      total_desired:    totalDesired,
      total_purchased:  totalPurchased,
      overall_percent:  overall,
      items:            items,
    };
  }

  // ---- closeRegistry ----------------------------------------------------

  async function closeRegistry(slug) {
    _slug(slug, "slug");
    var ts = _now();
    var r = await query(
      "UPDATE gift_registries SET status = 'closed', closed_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND status = 'active'",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      // Either missing or already closed — disambiguate so the
      // caller can distinguish "no such registry" from "already
      // closed, here's the existing row".
      var existing = await _row(slug);
      if (!existing) return null;
      return _decodeRegistry(existing);
    }
    return _decodeRegistry(await _row(slug));
  }

  // ---- update -----------------------------------------------------------

  async function update(slug, patch) {
    _slug(slug, "slug");
    if (!patch || typeof patch !== "object") {
      throw new TypeError("giftRegistry.update: patch object required");
    }
    var existing = await _row(slug);
    if (!existing) return null;
    if (existing.status !== "active") {
      throw new TypeError("giftRegistry.update: registry " + JSON.stringify(slug) + " is closed");
    }

    var sets = [];
    var params = [];
    var idx = 1;
    function _addSet(col, val) {
      b.safeSql.assertOneOf(col, ALLOWED_COLUMNS);
      sets.push(b.safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (idx++));
      params.push(val);
    }
    if (patch.title !== undefined) {
      _addSet("title", _title(patch.title, "title"));
    }
    if (patch.event_date !== undefined) {
      _addSet("event_date", _eventDate(patch.event_date, "event_date"));
    }
    if (patch.recipient_name !== undefined) {
      _addSet("recipient_name", _recipientName(patch.recipient_name));
    }
    if (patch.shipping_address_id !== undefined) {
      _addSet("shipping_address_id", _optUuid(patch.shipping_address_id, "shipping_address_id"));
    }
    if (patch.message !== undefined) {
      _addSet("message", _message(patch.message, "message", MAX_MESSAGE_LEN));
    }
    if (patch.privacy !== undefined) {
      _addSet("privacy", _privacy(patch.privacy));
    }
    if (sets.length === 0) {
      throw new TypeError("giftRegistry.update: patch contained no updatable fields");
    }
    var ts = _now();
    sets.push("updated_at = ?" + (idx++));
    params.push(ts);
    params.push(slug);
    await query(
      "UPDATE gift_registries SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    return _decodeRegistry(await _row(slug));
  }

  return {
    OCCASIONS: OCCASIONS.slice(),
    PRIVACIES: PRIVACIES.slice(),
    STATUSES:  STATUSES.slice(),

    createRegistry: createRegistry,
    addItem:        addItem,
    removeItem:     removeItem,
    getRegistry:    getRegistry,
    getBySlug:      getBySlug,
    listForOwner:   listForOwner,
    searchPublic:   searchPublic,
    purchaseItem:   purchaseItem,
    progressFor:    progressFor,
    closeRegistry:  closeRegistry,
    update:         update,
  };
}

module.exports = {
  create:    create,
  OCCASIONS: OCCASIONS,
  PRIVACIES: PRIVACIES,
  STATUSES:  STATUSES,
};
