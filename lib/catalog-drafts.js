"use strict";
/**
 * @module shop.catalogDrafts
 * @title  Catalog drafts — atomic-publication staging workflow for
 *         multi-change catalog batches with a 7-day rollback window.
 *
 * @intro
 *   The catalog primitive owns single-row mutation (one product, one
 *   variant, one price). The bulk-ops primitive owns filter-based
 *   mass operations. `catalogDrafts` owns the third lane: the
 *   operator is assembling a batch of N changes — new products,
 *   price updates, archives, tag flips — that should land together,
 *   atomically, with a preview review window before publication and
 *   an undo window after.
 *
 *   The lifecycle:
 *
 *     openDraft     — operator names a batch with a stable slug.
 *     stageChange   — append a typed change verb (create_product,
 *                     set_price, archive_variant, ...). Each verb
 *                     carries a payload shaped to the verb. Changes
 *                     are sequence-numbered so the operator authors
 *                     in natural order (create_product first, then
 *                     set_price for the variant of that product).
 *     listChanges   — read the staged changes, cursor-paginated.
 *     removeChange  — drop a single staged change by id.
 *     previewMerged — return the resulting catalog state *as if*
 *                     publishDraft ran, without writing.
 *     publishDraft  — pre-flight every change against the live
 *                     catalog, then apply them all. Pre-flight
 *                     failures refuse the entire publish (no partial
 *                     writes). `dry_run: true` runs the pre-flight
 *                     without writing.
 *     cancelDraft   — abandon a draft (any non-terminal status).
 *     rollbackDraft — within 7 days of publishDraft, restore the
 *                     catalog to the state it was in before publish.
 *                     Records both the original and the abandoned
 *                     state in `catalog_draft_rollback_log` so an
 *                     auditor reconstructs the round-trip.
 *     listDrafts    — operator dashboard feed; filter by status /
 *                     owner.
 *     historyForSku — "every draft that touched this SKU" — for the
 *                     SKU-level history view operators reach for
 *                     when investigating a price / inventory change.
 *
 *   Composition:
 *     var cd = bShop.catalogDrafts.create({
 *       query:   q,
 *       catalog: cat,                                   // catalog handle
 *     });
 *     var draft = await cd.openDraft({ slug: "spring-2026", title: "Spring refresh" });
 *     await cd.stageChange({ draft_slug: "spring-2026", kind: "create_product",
 *                            payload: { slug: "tee-blue", title: "Blue tee", status: "active" } });
 *     await cd.stageChange({ draft_slug: "spring-2026", kind: "set_price",
 *                            payload: { sku: "TEE-BLU-M", currency: "USD", amount_minor: 2500 } });
 *     var preview = await cd.previewMerged({ draft_slug: "spring-2026" });
 *     await cd.publishDraft({ draft_slug: "spring-2026" });
 *     await cd.rollbackDraft({ draft_slug: "spring-2026", reason: "downstream alert" });
 *
 *   `opts.catalog` is the catalog handle the primitive consults +
 *   writes through. It must expose the standard catalog subsurfaces
 *   (`products`, `variants`, `prices`, `inventory`) plus the
 *   tag-level methods (`tags.add(product_id, tag)`,
 *   `tags.remove(product_id, tag)`). The handle is injected so the
 *   tests can pass an in-memory composition and the production code
 *   can pass `bShop.catalog.create(...)` straight through.
 *
 * @related  b.guardUuid, b.uuid.v7, catalog, productBulkOps
 */

// ---- constants ----------------------------------------------------------

var STATUSES = Object.freeze([
  "open", "preview", "published", "cancelled", "rolled_back",
]);

// The change-kind closed enum. Adding a new kind requires:
//   1. extending the CHECK constraint in the migration
//   2. extending KIND_PAYLOAD_VALIDATORS below
//   3. extending the publish + preview switch tables
//   4. extending the test coverage
// All four landings ship in the same release — no half-shipped verb.
var KINDS = Object.freeze([
  "create_product",
  "update_product",
  "archive_product",
  "create_variant",
  "update_variant",
  "archive_variant",
  "set_price",
  "set_inventory",
  "add_tag",
  "remove_tag",
]);

var TERMINAL_STATUSES = Object.freeze(["published", "cancelled", "rolled_back"]);

var MAX_SLUG_LEN     = 80;
var MAX_TITLE_LEN    = 200;
var MAX_DESC_LEN     = 2000;
var MAX_REASON_LEN   = 280;
var MAX_OWNER_LEN    = 200;
var MAX_LIST_LIMIT   = 200;
var MAX_TAG_LEN      = 64;
var MAX_CHANGES_PER_DRAFT = 5000;

// Framework handle (the vendored blamejs); index.js re-exports this as .framework.
var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

var ROLLBACK_WINDOW_MS = b.constants.TIME.days(7);

// Slug shape matches the project's recurring slug convention used
// across coupon-stacking / refund-policy / customer-segments — alnum
// leading char, alnum + . _ - thereafter, capped length.
var SLUG_RE     = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var TAG_RE      = /^[a-z0-9][a-z0-9-]{0,63}$/;
var SKU_RE      = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE = /^[A-Z]{3}$/;
// Product slug shape matches catalog.js (lowercase alnum + hyphen,
// must end in alnum). Mirrored here so stageChange refuses bad
// payloads at stage time rather than at publish time.
var PRODUCT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;

// Reuse the same prose-input refusal posture other primitives apply
// to operator-authored fields — refuse control bytes + zero-width /
// direction-override codepoints so a rollback_reason / cancel_reason
// can't smuggle UI-confusing glyphs into the audit dashboard.


// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("catalogDrafts: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _title(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("catalogDrafts: " + label + " must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("catalogDrafts: " + label + " must not contain control bytes");
  }
  return s;
}

function _description(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_DESC_LEN) {
    throw new TypeError("catalogDrafts: description must be a string <= " + MAX_DESC_LEN + " chars when provided");
  }
  textGuard.freeText(s, "catalogDrafts: description", { bidiMarks: "allow" });
  return s;
}

function _optReason(s, label) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("catalogDrafts: " + label + " must be a non-empty string when provided");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("catalogDrafts: " + label + " must be <= " + MAX_REASON_LEN + " chars");
  }
  if (textGuard.hasCodepointThreat(s, { zeroWidth: "reject" })) {
    throw new TypeError("catalogDrafts: " + label + " contains control / zero-width bytes");
  }
  return s;
}

function _reqReason(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("catalogDrafts: " + label + " must be a non-empty string");
  }
  return _optReason(s, label);
}

function _optOwner(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_OWNER_LEN) {
    throw new TypeError("catalogDrafts: owner_id must be a non-empty string <= " + MAX_OWNER_LEN + " chars when provided");
  }
  textGuard.freeText(s, "catalogDrafts: owner_id");
  return s;
}

function _optEpochMs(n, label) {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("catalogDrafts: " + label + " must be a positive integer (epoch ms) when provided");
  }
  return n;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("catalogDrafts: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("catalogDrafts: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("catalogDrafts: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _productSlug(s, label) {
  if (typeof s !== "string" || !PRODUCT_SLUG_RE.test(s)) {
    throw new TypeError("catalogDrafts: " + label + " must be a lowercase alnum-hyphen slug (<= 200 chars)");
  }
  return s;
}

function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("catalogDrafts: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= 128 chars)");
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("catalogDrafts: currency must be 3-letter uppercase ISO 4217");
  }
  return s;
}

function _amountMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("catalogDrafts: amount_minor must be a non-negative integer");
  }
  return n;
}

function _stockOnHand(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("catalogDrafts: stock_on_hand must be a non-negative integer");
  }
  return n;
}

function _tag(s) {
  if (typeof s !== "string" || !TAG_RE.test(s)) {
    throw new TypeError("catalogDrafts: tag must match /^[a-z0-9][a-z0-9-]*$/ (<= " + MAX_TAG_LEN + " chars)");
  }
  return s;
}

function _now() { return Date.now(); }

// ---- payload validators -------------------------------------------------

// Each verb owns a payload shape. The validator runs at stageChange
// time so a malformed payload refuses early rather than blowing up
// pre-flight at publishDraft time, when the operator already
// believes the draft is reviewable.
//
// Returns the normalized payload (with any defaults filled). The
// stageChange writer JSON-encodes the result and the publish path
// re-reads it.
var KIND_PAYLOAD_VALIDATORS = {
  create_product: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: create_product payload must be an object");
    _productSlug(p.slug, "create_product.slug");
    _title(p.title, "create_product.title");
    var description = _description(p.description);
    var status = p.status == null ? "draft" : p.status;
    if (typeof status !== "string" || ["draft", "active", "archived"].indexOf(status) === -1) {
      throw new TypeError("catalogDrafts: create_product.status must be one of draft, active, archived");
    }
    return { slug: p.slug, title: p.title, description: description, status: status };
  },
  update_product: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: update_product payload must be an object");
    // The product is addressed by slug (operator-stable handle); the
    // catalog primitive's products.bySlug -> products.update bridge
    // resolves the id at publish time. Patch keys must each be a
    // known column.
    _productSlug(p.slug, "update_product.slug");
    if (!p.patch || typeof p.patch !== "object") {
      throw new TypeError("catalogDrafts: update_product.patch must be an object");
    }
    var out = { slug: p.slug, patch: {} };
    var keys = Object.keys(p.patch);
    if (keys.length === 0) {
      throw new TypeError("catalogDrafts: update_product.patch must include at least one column");
    }
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (k === "slug")             { _productSlug(p.patch[k], "update_product.patch.slug"); out.patch.slug = p.patch[k]; }
      else if (k === "title")       { _title(p.patch[k], "update_product.patch.title"); out.patch.title = p.patch[k]; }
      else if (k === "description") { out.patch.description = _description(p.patch[k]); }
      else if (k === "status") {
        if (["draft", "active", "archived"].indexOf(p.patch[k]) === -1) {
          throw new TypeError("catalogDrafts: update_product.patch.status invalid");
        }
        out.patch.status = p.patch[k];
      } else {
        throw new TypeError("catalogDrafts: update_product.patch — unsupported column " + JSON.stringify(k));
      }
    }
    return out;
  },
  archive_product: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: archive_product payload must be an object");
    _productSlug(p.slug, "archive_product.slug");
    return { slug: p.slug };
  },
  create_variant: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: create_variant payload must be an object");
    _productSlug(p.product_slug, "create_variant.product_slug");
    _sku(p.sku, "create_variant.sku");
    var out = { product_slug: p.product_slug, sku: p.sku };
    if (p.title != null) {
      if (typeof p.title !== "string" || p.title.length > MAX_TITLE_LEN) {
        throw new TypeError("catalogDrafts: create_variant.title must be a string <= " + MAX_TITLE_LEN + " chars");
      }
      out.title = p.title;
    }
    if (p.options != null) {
      if (typeof p.options !== "object" || Array.isArray(p.options)) {
        throw new TypeError("catalogDrafts: create_variant.options must be a plain object");
      }
      out.options = p.options;
    }
    if (p.weight_grams != null) {
      if (!Number.isInteger(p.weight_grams) || p.weight_grams < 0) {
        throw new TypeError("catalogDrafts: create_variant.weight_grams must be a non-negative integer");
      }
      out.weight_grams = p.weight_grams;
    }
    if (p.requires_shipping != null) {
      if (typeof p.requires_shipping !== "boolean") {
        throw new TypeError("catalogDrafts: create_variant.requires_shipping must be a boolean");
      }
      out.requires_shipping = p.requires_shipping;
    }
    return out;
  },
  update_variant: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: update_variant payload must be an object");
    _sku(p.sku, "update_variant.sku");
    if (!p.patch || typeof p.patch !== "object") {
      throw new TypeError("catalogDrafts: update_variant.patch must be an object");
    }
    var keys = Object.keys(p.patch);
    if (keys.length === 0) {
      throw new TypeError("catalogDrafts: update_variant.patch must include at least one column");
    }
    var ALLOWED = ["sku", "title", "options", "weight_grams", "requires_shipping", "position"];
    var out = { sku: p.sku, patch: {} };
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (ALLOWED.indexOf(k) === -1) {
        throw new TypeError("catalogDrafts: update_variant.patch — unsupported column " + JSON.stringify(k));
      }
      if (k === "sku")            { _sku(p.patch[k], "update_variant.patch.sku"); out.patch.sku = p.patch[k]; }
      else if (k === "title") {
        if (typeof p.patch[k] !== "string" || p.patch[k].length > MAX_TITLE_LEN) {
          throw new TypeError("catalogDrafts: update_variant.patch.title invalid");
        }
        out.patch.title = p.patch[k];
      } else if (k === "options") {
        if (typeof p.patch[k] !== "object" || Array.isArray(p.patch[k])) {
          throw new TypeError("catalogDrafts: update_variant.patch.options must be a plain object");
        }
        out.patch.options = p.patch[k];
      } else if (k === "weight_grams") {
        if (!Number.isInteger(p.patch[k]) || p.patch[k] < 0) {
          throw new TypeError("catalogDrafts: update_variant.patch.weight_grams must be a non-negative integer");
        }
        out.patch.weight_grams = p.patch[k];
      } else if (k === "requires_shipping") {
        if (typeof p.patch[k] !== "boolean") {
          throw new TypeError("catalogDrafts: update_variant.patch.requires_shipping must be a boolean");
        }
        out.patch.requires_shipping = p.patch[k];
      } else /* position */ {
        if (!Number.isInteger(p.patch[k]) || p.patch[k] < 0) {
          throw new TypeError("catalogDrafts: update_variant.patch.position must be a non-negative integer");
        }
        out.patch.position = p.patch[k];
      }
    }
    return out;
  },
  archive_variant: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: archive_variant payload must be an object");
    _sku(p.sku, "archive_variant.sku");
    return { sku: p.sku };
  },
  set_price: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: set_price payload must be an object");
    _sku(p.sku, "set_price.sku");
    _currency(p.currency);
    _amountMinor(p.amount_minor);
    return { sku: p.sku, currency: p.currency, amount_minor: p.amount_minor };
  },
  set_inventory: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: set_inventory payload must be an object");
    _sku(p.sku, "set_inventory.sku");
    _stockOnHand(p.stock_on_hand);
    return { sku: p.sku, stock_on_hand: p.stock_on_hand };
  },
  add_tag: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: add_tag payload must be an object");
    _productSlug(p.product_slug, "add_tag.product_slug");
    _tag(p.tag);
    return { product_slug: p.product_slug, tag: p.tag };
  },
  remove_tag: function (p) {
    if (!p || typeof p !== "object") throw new TypeError("catalogDrafts: remove_tag payload must be an object");
    _productSlug(p.product_slug, "remove_tag.product_slug");
    _tag(p.tag);
    return { product_slug: p.product_slug, tag: p.tag };
  },
};

// ---- SKU extraction (for historyForSku) --------------------------------

// Each verb either carries a SKU directly or doesn't. The list helps
// historyForSku build a "every draft that touched this sku" feed by
// scanning catalog_draft_changes for matching payloads — composed
// via the payload_json text-contains search the SQLite/D1 dialect
// can express portably.
function _payloadSkuOf(kind, payload) {
  switch (kind) {
    case "create_variant":
    case "update_variant":
    case "archive_variant":
    case "set_price":
    case "set_inventory":
      return payload && payload.sku ? String(payload.sku) : null;
    default:
      return null;
  }
}

// ---- row hydration -----------------------------------------------------

function _hydrateDraftRow(r) {
  if (!r) return null;
  return {
    slug:                 r.slug,
    title:                r.title,
    description:          r.description == null ? "" : r.description,
    status:               r.status,
    scheduled_publish_at: r.scheduled_publish_at == null ? null : Number(r.scheduled_publish_at),
    published_at:         r.published_at == null ? null : Number(r.published_at),
    cancelled_at:         r.cancelled_at == null ? null : Number(r.cancelled_at),
    rolled_back_at:       r.rolled_back_at == null ? null : Number(r.rolled_back_at),
    rollback_reason:      r.rollback_reason == null ? null : r.rollback_reason,
    cancel_reason:        r.cancel_reason == null ? null : r.cancel_reason,
    owner_id:             r.owner_id == null ? null : r.owner_id,
    created_at:           Number(r.created_at),
    updated_at:           Number(r.updated_at),
  };
}

function _hydrateChangeRow(r) {
  if (!r) return null;
  var payload;
  try { payload = JSON.parse(r.payload_json); }
  catch (_e) { payload = null; }
  return {
    id:             r.id,
    draft_slug:     r.draft_slug,
    kind:           r.kind,
    payload:        payload,
    sequence_order: Number(r.sequence_order),
    created_at:     Number(r.created_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var catalog = opts.catalog;
  if (!catalog || typeof catalog !== "object") {
    throw new TypeError("catalogDrafts.create: opts.catalog handle required");
  }
  if (!catalog.products || !catalog.variants || !catalog.prices || !catalog.inventory) {
    throw new TypeError("catalogDrafts.create: opts.catalog must expose products, variants, prices, inventory subsurfaces");
  }
  // Tags surface is optional only when no draft uses add_tag/remove_tag.
  // Refuse here so the misconfiguration surfaces at boot rather than
  // at publishDraft for the first draft that includes a tag verb.
  if (!catalog.tags || typeof catalog.tags.add !== "function" || typeof catalog.tags.remove !== "function") {
    throw new TypeError("catalogDrafts.create: opts.catalog.tags{add,remove} required");
  }

  // ---- internal helpers --------------------------------------------

  async function _getDraft(slug) {
    var r = await query("SELECT * FROM catalog_drafts WHERE slug = ?1 LIMIT 1", [slug]);
    return _hydrateDraftRow(r.rows[0] || null);
  }

  async function _assertDraftExists(slug) {
    var d = await _getDraft(slug);
    if (!d) {
      var nf = new Error("catalogDrafts: draft " + JSON.stringify(slug) + " not found");
      nf.code = "DRAFT_NOT_FOUND";
      throw nf;
    }
    return d;
  }

  async function _assertDraftMutable(slug) {
    var d = await _assertDraftExists(slug);
    if (TERMINAL_STATUSES.indexOf(d.status) !== -1) {
      var err = new Error(
        "catalogDrafts: draft " + JSON.stringify(slug) +
        " is " + d.status + " (terminal — refuse mutation)"
      );
      err.code = "DRAFT_TERMINAL";
      throw err;
    }
    return d;
  }

  async function _nextSequenceFor(slug) {
    var r = await query(
      "SELECT COALESCE(MAX(sequence_order), 0) AS max_seq FROM catalog_draft_changes WHERE draft_slug = ?1",
      [slug],
    );
    var row = r.rows[0] || { max_seq: 0 };
    return Number(row.max_seq) + 1;
  }

  async function _countChangesFor(slug) {
    var r = await query(
      "SELECT COUNT(1) AS n FROM catalog_draft_changes WHERE draft_slug = ?1",
      [slug],
    );
    var row = r.rows[0] || { n: 0 };
    return Number(row.n);
  }

  async function _listChangesAll(slug) {
    var r = await query(
      "SELECT * FROM catalog_draft_changes WHERE draft_slug = ?1 " +
      "ORDER BY sequence_order ASC, id ASC",
      [slug],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateChangeRow(r.rows[i]));
    return out;
  }

  // ---- openDraft ---------------------------------------------------

  async function openDraft(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("catalogDrafts.openDraft: input object required");
    }
    var slug         = _slug(input.slug, "slug");
    var title        = _title(input.title, "title");
    var description  = _description(input.description);
    var scheduledAt  = _optEpochMs(input.scheduled_publish_at, "scheduled_publish_at");
    var ownerId      = _optOwner(input.owner_id);

    var existing = await _getDraft(slug);
    if (existing) {
      throw new TypeError("catalogDrafts.openDraft: slug " + JSON.stringify(slug) + " already exists");
    }
    var ts = _now();
    await query(
      "INSERT INTO catalog_drafts " +
      "(slug, title, description, status, scheduled_publish_at, published_at, cancelled_at, " +
      " rolled_back_at, rollback_reason, cancel_reason, owner_id, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, 'open', ?4, NULL, NULL, NULL, NULL, NULL, ?5, ?6, ?6)",
      [slug, title, description, scheduledAt, ownerId, ts],
    );
    return await _getDraft(slug);
  }

  // ---- stageChange -------------------------------------------------

  async function stageChange(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("catalogDrafts.stageChange: input object required");
    }
    var draftSlug = _slug(input.draft_slug, "draft_slug");
    var kind      = _kind(input.kind);
    var validator = KIND_PAYLOAD_VALIDATORS[kind];
    // Defensive: every entry in KINDS has a matching validator. The
    // refuse here protects against a future KINDS addition that lands
    // without its validator.
    if (typeof validator !== "function") {
      throw new TypeError("catalogDrafts.stageChange: no payload validator registered for kind " + kind);
    }
    var payload = validator(input.payload);

    await _assertDraftMutable(draftSlug);
    var existing = await _countChangesFor(draftSlug);
    if (existing >= MAX_CHANGES_PER_DRAFT) {
      throw new TypeError(
        "catalogDrafts.stageChange: draft " + JSON.stringify(draftSlug) +
        " has reached the change cap of " + MAX_CHANGES_PER_DRAFT
      );
    }
    var seq = await _nextSequenceFor(draftSlug);
    var id  = b.uuid.v7();
    var ts  = _now();
    await query(
      "INSERT INTO catalog_draft_changes " +
      "(id, draft_slug, kind, payload_json, sequence_order, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, draftSlug, kind, JSON.stringify(payload), seq, ts],
    );
    // updated_at on the parent advances so listDrafts(updated_at DESC)
    // surfaces actively-edited drafts first.
    await query(
      "UPDATE catalog_drafts SET updated_at = ?1 WHERE slug = ?2",
      [ts, draftSlug],
    );
    var rowR = await query("SELECT * FROM catalog_draft_changes WHERE id = ?1", [id]);
    return _hydrateChangeRow(rowR.rows[0] || null);
  }

  // ---- listChanges -------------------------------------------------

  async function listChanges(draftSlug, listOpts) {
    _slug(draftSlug, "draft_slug");
    listOpts = listOpts || {};
    await _assertDraftExists(draftSlug);
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("catalogDrafts.listChanges: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    // Cursor is the last seen sequence_order — opaque to the caller
    // but a simple non-negative integer string. The keyset shape
    // matches the natural sequence-order index so pagination scales
    // without an OFFSET scan.
    var afterSeq = null;
    if (listOpts.cursor != null) {
      if (typeof listOpts.cursor !== "string" || !/^\d+$/.test(listOpts.cursor)) {
        throw new TypeError("catalogDrafts.listChanges: cursor must be an opaque integer-string when provided");
      }
      afterSeq = parseInt(listOpts.cursor, 10);
    }
    var sql, params;
    if (afterSeq == null) {
      sql    = "SELECT * FROM catalog_draft_changes WHERE draft_slug = ?1 " +
               "ORDER BY sequence_order ASC, id ASC LIMIT ?2";
      params = [draftSlug, limit];
    } else {
      sql    = "SELECT * FROM catalog_draft_changes WHERE draft_slug = ?1 AND sequence_order > ?2 " +
               "ORDER BY sequence_order ASC, id ASC LIMIT ?3";
      params = [draftSlug, afterSeq, limit];
    }
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateChangeRow(r.rows[i]));
    var nextCursor = null;
    if (out.length === limit) {
      nextCursor = String(out[out.length - 1].sequence_order);
    }
    return { rows: out, next_cursor: nextCursor };
  }

  // ---- removeChange ------------------------------------------------

  async function removeChange(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("catalogDrafts.removeChange: input object required");
    }
    var draftSlug = _slug(input.draft_slug, "draft_slug");
    if (typeof input.change_id !== "string" || !input.change_id.length) {
      throw new TypeError("catalogDrafts.removeChange: change_id must be a non-empty string");
    }
    await _assertDraftMutable(draftSlug);
    var r = await query(
      "DELETE FROM catalog_draft_changes WHERE draft_slug = ?1 AND id = ?2",
      [draftSlug, input.change_id],
    );
    if (Number(r.rowCount || 0) === 0) {
      var nf = new Error(
        "catalogDrafts.removeChange: change " + JSON.stringify(input.change_id) +
        " not found in draft " + JSON.stringify(draftSlug)
      );
      nf.code = "CHANGE_NOT_FOUND";
      throw nf;
    }
    var ts = _now();
    await query("UPDATE catalog_drafts SET updated_at = ?1 WHERE slug = ?2", [ts, draftSlug]);
    return { removed: true, change_id: input.change_id, draft_slug: draftSlug };
  }

  // ---- catalog snapshot helpers ------------------------------------

  // Capture the live state of every product / variant / price /
  // inventory / tag row a draft's changes will touch. The snapshot
  // is used by publishDraft to record the pre-publish state for
  // potential rollback, and by previewMerged to compose the simulated
  // post-publish state.
  async function _captureSnapshot(changes) {
    var productSlugs = Object.create(null);
    var skus         = Object.create(null);
    for (var i = 0; i < changes.length; i += 1) {
      var c = changes[i];
      var p = c.payload || {};
      if (p.slug)         productSlugs[p.slug] = true;
      if (p.product_slug) productSlugs[p.product_slug] = true;
      if (p.sku)          skus[p.sku] = true;
    }
    var snap = { products: {}, variants: {}, prices: {}, inventory: {}, tags: {} };
    var slugList = Object.keys(productSlugs);
    for (var j = 0; j < slugList.length; j += 1) {
      var slug = slugList[j];
      var prod = null;
      try { prod = await catalog.products.bySlug(slug); }
      catch (_e) { prod = null; }
      snap.products[slug] = prod || null;
      if (prod && catalog.tags && typeof catalog.tags.listForProduct === "function") {
        var tlist = [];
        try { tlist = await catalog.tags.listForProduct(prod.id); }
        catch (_e) { tlist = []; }
        snap.tags[slug] = tlist.slice();
      } else {
        snap.tags[slug] = [];
      }
    }
    var skuList = Object.keys(skus);
    for (var k = 0; k < skuList.length; k += 1) {
      var sku = skuList[k];
      var variant = null;
      try { variant = await catalog.variants.bySku(sku); }
      catch (_e) { variant = null; }
      snap.variants[sku] = variant || null;
      // Capture price + inventory keyed by sku. Prices snapshot per
      // currency captured at publish time as a flat map; only the
      // currencies the draft touches matter for rollback, so the map
      // is sparse on purpose.
      var pricesByCurrency = {};
      if (variant) {
        // Compose the set of currencies this draft touches for this sku.
        var ccyForSku = Object.create(null);
        for (var m = 0; m < changes.length; m += 1) {
          var cm = changes[m];
          if (cm.kind === "set_price" && cm.payload && cm.payload.sku === sku && cm.payload.currency) {
            ccyForSku[cm.payload.currency] = true;
          }
        }
        var ccyList = Object.keys(ccyForSku);
        for (var n = 0; n < ccyList.length; n += 1) {
          var ccy = ccyList[n];
          var cur = null;
          try { cur = await catalog.prices.current(variant.id, ccy); }
          catch (_e) { cur = null; }
          pricesByCurrency[ccy] = cur;
        }
      }
      snap.prices[sku] = pricesByCurrency;
      var inv = null;
      try { inv = await catalog.inventory.get(sku); }
      catch (_e) { inv = null; }
      snap.inventory[sku] = inv || null;
    }
    return snap;
  }

  // ---- preview / publish: pre-flight reasoning ---------------------

  // Walk a change list against the live catalog (or the simulated
  // state for previewMerged) and return either a list of problems or
  // a normalized plan that the writer phase replays without
  // re-validating against the world.
  //
  // `mode = 'preflight'` returns the planned writes as objects but
  // doesn't apply them. The publishDraft writer phase iterates the
  // plan and dispatches each entry to the catalog handle.
  //
  // `mode = 'simulate'` builds an in-memory merged catalog snapshot
  // and returns it as the previewMerged payload.
  async function _planChanges(draftSlug, changes, mode) {
    var problems = [];
    // Simulated state for previewMerged. Keyed by slug / sku so
    // intra-draft references resolve (create_product followed by
    // add_tag against the same slug).
    var sim = { products: {}, variants: {}, prices: {}, inventory: {}, tags: {} };

    async function _resolveProduct(slug) {
      if (Object.prototype.hasOwnProperty.call(sim.products, slug)) {
        return sim.products[slug];
      }
      var p = null;
      try { p = await catalog.products.bySlug(slug); }
      catch (_e) { p = null; }
      sim.products[slug] = p;
      if (!sim.tags[slug]) {
        var tags = [];
        if (p && catalog.tags && typeof catalog.tags.listForProduct === "function") {
          try { tags = await catalog.tags.listForProduct(p.id); }
          catch (_e) { tags = []; }
        }
        sim.tags[slug] = tags;
      }
      return sim.products[slug];
    }

    async function _resolveVariant(sku) {
      if (Object.prototype.hasOwnProperty.call(sim.variants, sku)) {
        return sim.variants[sku];
      }
      var v = null;
      try { v = await catalog.variants.bySku(sku); }
      catch (_e) { v = null; }
      sim.variants[sku] = v;
      return v;
    }

    var plan = [];

    for (var i = 0; i < changes.length; i += 1) {
      var c = changes[i];
      var p = c.payload || {};
      if (c.kind === "create_product") {
        var existing = await _resolveProduct(p.slug);
        if (existing) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "product_already_exists", slug: p.slug });
          continue;
        }
        // Simulated id for previewMerged; the writer phase issues a
        // real id from b.uuid.v7 at publish time.
        var simId = "sim-" + p.slug;
        sim.products[p.slug] = {
          id: simId, slug: p.slug, title: p.title,
          description: p.description, status: p.status,
        };
        sim.tags[p.slug] = [];
        plan.push({ kind: c.kind, payload: p });
      } else if (c.kind === "update_product") {
        var prod = await _resolveProduct(p.slug);
        if (!prod) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "product_not_found", slug: p.slug });
          continue;
        }
        var merged = {};
        var pkeys = Object.keys(prod);
        for (var pi = 0; pi < pkeys.length; pi += 1) merged[pkeys[pi]] = prod[pkeys[pi]];
        var patchKeys = Object.keys(p.patch);
        for (var pk = 0; pk < patchKeys.length; pk += 1) merged[patchKeys[pk]] = p.patch[patchKeys[pk]];
        // Slug rename — preserve the tag list across the rename so
        // the simulated snapshot stays consistent.
        if (p.patch.slug && p.patch.slug !== p.slug) {
          sim.products[p.patch.slug] = merged;
          sim.tags[p.patch.slug]     = (sim.tags[p.slug] || []).slice();
          delete sim.products[p.slug];
          delete sim.tags[p.slug];
        } else {
          sim.products[p.slug] = merged;
        }
        plan.push({ kind: c.kind, payload: p, resolved_product_id: prod.id });
      } else if (c.kind === "archive_product") {
        var pa = await _resolveProduct(p.slug);
        if (!pa) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "product_not_found", slug: p.slug });
          continue;
        }
        var archived = {};
        var akeys = Object.keys(pa);
        for (var ai = 0; ai < akeys.length; ai += 1) archived[akeys[ai]] = pa[akeys[ai]];
        archived.status = "archived";
        sim.products[p.slug] = archived;
        plan.push({ kind: c.kind, payload: p, resolved_product_id: pa.id });
      } else if (c.kind === "create_variant") {
        var parent = await _resolveProduct(p.product_slug);
        if (!parent) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "product_not_found", slug: p.product_slug });
          continue;
        }
        var skuExisting = await _resolveVariant(p.sku);
        if (skuExisting) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "sku_already_exists", sku: p.sku });
          continue;
        }
        sim.variants[p.sku] = {
          id: "sim-var-" + p.sku, product_id: parent.id, sku: p.sku,
          title: p.title || "",
          options: p.options || {},
          weight_grams: p.weight_grams == null ? 0 : p.weight_grams,
          requires_shipping: p.requires_shipping == null ? true : p.requires_shipping,
        };
        plan.push({ kind: c.kind, payload: p, resolved_product_id: parent.id });
      } else if (c.kind === "update_variant") {
        var vu = await _resolveVariant(p.sku);
        if (!vu) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "sku_not_found", sku: p.sku });
          continue;
        }
        var vmerged = {};
        var vkeys = Object.keys(vu);
        for (var vi = 0; vi < vkeys.length; vi += 1) vmerged[vkeys[vi]] = vu[vkeys[vi]];
        var vpKeys = Object.keys(p.patch);
        for (var vpi = 0; vpi < vpKeys.length; vpi += 1) vmerged[vpKeys[vpi]] = p.patch[vpKeys[vpi]];
        if (p.patch.sku && p.patch.sku !== p.sku) {
          sim.variants[p.patch.sku] = vmerged;
          delete sim.variants[p.sku];
        } else {
          sim.variants[p.sku] = vmerged;
        }
        plan.push({ kind: c.kind, payload: p, resolved_variant_id: vu.id });
      } else if (c.kind === "archive_variant") {
        var va = await _resolveVariant(p.sku);
        if (!va) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "sku_not_found", sku: p.sku });
          continue;
        }
        // Archiving a variant means deleting it via the catalog
        // primitive's variants.delete surface (no archived-variant
        // status in the catalog schema; the variant is removed, the
        // SKU frees up). Mirror in the simulation.
        delete sim.variants[p.sku];
        plan.push({ kind: c.kind, payload: p, resolved_variant_id: va.id });
      } else if (c.kind === "set_price") {
        var vp = await _resolveVariant(p.sku);
        if (!vp) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "sku_not_found", sku: p.sku });
          continue;
        }
        if (!sim.prices[p.sku]) sim.prices[p.sku] = {};
        sim.prices[p.sku][p.currency] = {
          variant_id: vp.id, currency: p.currency, amount_minor: p.amount_minor,
        };
        plan.push({ kind: c.kind, payload: p, resolved_variant_id: vp.id });
      } else if (c.kind === "set_inventory") {
        var vi2 = await _resolveVariant(p.sku);
        if (!vi2) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "sku_not_found", sku: p.sku });
          continue;
        }
        sim.inventory[p.sku] = { sku: p.sku, stock_on_hand: p.stock_on_hand };
        plan.push({ kind: c.kind, payload: p });
      } else if (c.kind === "add_tag") {
        var ta = await _resolveProduct(p.product_slug);
        if (!ta) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "product_not_found", slug: p.product_slug });
          continue;
        }
        var existingTags = sim.tags[p.product_slug] || [];
        if (existingTags.indexOf(p.tag) === -1) {
          sim.tags[p.product_slug] = existingTags.concat([p.tag]);
        }
        plan.push({ kind: c.kind, payload: p, resolved_product_id: ta.id });
      } else if (c.kind === "remove_tag") {
        var tr = await _resolveProduct(p.product_slug);
        if (!tr) {
          problems.push({ change_id: c.id, kind: c.kind, reason: "product_not_found", slug: p.product_slug });
          continue;
        }
        var prior = sim.tags[p.product_slug] || [];
        sim.tags[p.product_slug] = prior.filter(function (t) { return t !== p.tag; });
        plan.push({ kind: c.kind, payload: p, resolved_product_id: tr.id });
      } else {
        // Unreachable through the public surface — stageChange refuses
        // any kind not in KINDS. Defensive belt-and-braces.
        problems.push({ change_id: c.id, kind: c.kind, reason: "unknown_kind" });
      }
    }
    if (mode === "simulate") {
      return { problems: problems, simulated: sim };
    }
    return { problems: problems, plan: plan };
  }

  // ---- previewMerged ------------------------------------------------

  async function previewMerged(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("catalogDrafts.previewMerged: input object required");
    }
    var draftSlug = _slug(input.draft_slug, "draft_slug");
    await _assertDraftExists(draftSlug);
    var changes = await _listChangesAll(draftSlug);
    var result  = await _planChanges(draftSlug, changes, "simulate");
    // Flip the draft into `preview` status when it was `open` — this
    // is the operator's "I've seen the preview" gesture. Skip the
    // transition for terminal-status drafts (published / cancelled /
    // rolled_back) so previewing a historical draft doesn't mutate
    // its row.
    var d = await _getDraft(draftSlug);
    if (d && d.status === "open") {
      var ts = _now();
      await query(
        "UPDATE catalog_drafts SET status = 'preview', updated_at = ?1 WHERE slug = ?2",
        [ts, draftSlug],
      );
    }
    return {
      draft_slug: draftSlug,
      problems:   result.problems,
      merged:     result.simulated,
      change_count: changes.length,
    };
  }

  // ---- publishDraft -------------------------------------------------

  // Writer phase. Iterates the validated plan and dispatches each
  // entry to the catalog handle. Wrapped in a try/catch that, on
  // first failure, attempts to surface the failure to the caller
  // (the row stays at `preview` status; the writes that landed
  // before the failure are NOT auto-reverted — partial-write
  // recovery is the operator's gesture via rollbackDraft, which
  // requires the published_at stamp anyway).
  //
  // The publish path's atomicity guarantee is "pre-flight everything
  // before writing anything" — once pre-flight passes, the writer
  // dispatches with confidence the live catalog matches the
  // simulation. A writer-phase failure during dispatch is a
  // best-effort scenario; the operator's escape hatch is to inspect
  // what landed (the catalog surface is the source of truth) and
  // either roll forward with a follow-up draft or open a support
  // ticket.
  async function _applyPlan(plan) {
    var applied = [];
    // Resolve product_id by slug and variant_id by sku at apply time.
    // The pre-flight stage stored simulated ids for products /
    // variants created earlier in the same batch; the writer phase
    // ignores those and re-resolves against the live catalog so
    // every dispatched call addresses real row ids.
    var productIdBySlug = Object.create(null);
    var variantIdBySku  = Object.create(null);

    async function _liveProductId(slug) {
      if (productIdBySlug[slug]) return productIdBySlug[slug];
      var p = null;
      try { p = await catalog.products.bySlug(slug); }
      catch (_e) { p = null; }
      if (p) productIdBySlug[slug] = p.id;
      return p ? p.id : null;
    }

    async function _liveVariantId(sku) {
      if (variantIdBySku[sku]) return variantIdBySku[sku];
      var v = null;
      try { v = await catalog.variants.bySku(sku); }
      catch (_e) { v = null; }
      if (v) variantIdBySku[sku] = v.id;
      return v ? v.id : null;
    }

    for (var i = 0; i < plan.length; i += 1) {
      var step = plan[i];
      var p = step.payload;
      if (step.kind === "create_product") {
        var newP = await catalog.products.create({
          slug: p.slug, title: p.title, description: p.description, status: p.status,
        });
        productIdBySlug[p.slug] = newP.id;
        applied.push({ kind: step.kind, result: newP });
      } else if (step.kind === "update_product") {
        var upid = await _liveProductId(p.slug);
        var upd  = await catalog.products.update(upid, p.patch);
        // Slug rename: update the lookup table so a later step in
        // the same batch addressing the product by the new slug
        // resolves correctly.
        if (p.patch.slug && p.patch.slug !== p.slug) {
          productIdBySlug[p.patch.slug] = upid;
          delete productIdBySlug[p.slug];
        }
        applied.push({ kind: step.kind, result: upd });
      } else if (step.kind === "archive_product") {
        var apid = await _liveProductId(p.slug);
        var arch = await catalog.products.archive(apid);
        applied.push({ kind: step.kind, result: arch });
      } else if (step.kind === "create_variant") {
        var parentId = await _liveProductId(p.product_slug);
        var variantInput = { sku: p.sku };
        if (p.title != null)             variantInput.title             = p.title;
        if (p.options != null)           variantInput.options           = p.options;
        if (p.weight_grams != null)      variantInput.weight_grams      = p.weight_grams;
        if (p.requires_shipping != null) variantInput.requires_shipping = p.requires_shipping;
        var newV = await catalog.variants.create(parentId, variantInput);
        variantIdBySku[p.sku] = newV.id;
        applied.push({ kind: step.kind, result: newV });
      } else if (step.kind === "update_variant") {
        var uvid = await _liveVariantId(p.sku);
        var updV = await catalog.variants.update(uvid, p.patch);
        if (p.patch.sku && p.patch.sku !== p.sku) {
          variantIdBySku[p.patch.sku] = uvid;
          delete variantIdBySku[p.sku];
        }
        applied.push({ kind: step.kind, result: updV });
      } else if (step.kind === "archive_variant") {
        var avid = await _liveVariantId(p.sku);
        var del  = await catalog.variants.delete(avid);
        delete variantIdBySku[p.sku];
        applied.push({ kind: step.kind, result: { deleted: del } });
      } else if (step.kind === "set_price") {
        var spvid = await _liveVariantId(p.sku);
        var pr = await catalog.prices.set(spvid, {
          currency: p.currency, amount_minor: p.amount_minor,
        });
        applied.push({ kind: step.kind, result: pr });
      } else if (step.kind === "set_inventory") {
        // The catalog inventory surface owns create + restock +
        // release; "set_inventory" semantically maps to "make stock
        // equal N". When the row exists, compute the delta; when it
        // doesn't, create. The catalog primitive doesn't ship a
        // direct set-stock op so the draft writer composes the
        // available verbs.
        var inv = null;
        try { inv = await catalog.inventory.get(p.sku); }
        catch (_e) { inv = null; }
        if (!inv) {
          var made = await catalog.inventory.create(p.sku, { stock_on_hand: p.stock_on_hand });
          applied.push({ kind: step.kind, result: made });
        } else {
          var delta = p.stock_on_hand - Number(inv.stock_on_hand);
          if (delta > 0 && typeof catalog.inventory.restock === "function") {
            var r1 = await catalog.inventory.restock(p.sku, delta);
            applied.push({ kind: step.kind, result: r1 });
          } else if (delta < 0 && typeof catalog.inventory.release === "function") {
            var r2 = await catalog.inventory.release(p.sku, -delta);
            applied.push({ kind: step.kind, result: r2 });
          } else {
            // delta === 0 — no write needed.
            applied.push({ kind: step.kind, result: inv });
          }
        }
      } else if (step.kind === "add_tag") {
        var atid = await _liveProductId(p.product_slug);
        var ta = await catalog.tags.add(atid, p.tag);
        applied.push({ kind: step.kind, result: ta });
      } else if (step.kind === "remove_tag") {
        var rtid = await _liveProductId(p.product_slug);
        var tr = await catalog.tags.remove(rtid, p.tag);
        applied.push({ kind: step.kind, result: tr });
      }
    }
    return applied;
  }

  async function publishDraft(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("catalogDrafts.publishDraft: input object required");
    }
    var draftSlug = _slug(input.draft_slug, "draft_slug");
    var dryRun    = false;
    if (input.dry_run != null) {
      if (typeof input.dry_run !== "boolean") {
        throw new TypeError("catalogDrafts.publishDraft: dry_run must be a boolean when provided");
      }
      dryRun = input.dry_run;
    }
    var d = await _assertDraftExists(draftSlug);
    if (TERMINAL_STATUSES.indexOf(d.status) !== -1) {
      var sErr = new Error(
        "catalogDrafts.publishDraft: draft " + JSON.stringify(draftSlug) +
        " is " + d.status + " (terminal — refuse publish)"
      );
      sErr.code = "DRAFT_TERMINAL";
      throw sErr;
    }
    var changes = await _listChangesAll(draftSlug);
    if (changes.length === 0) {
      throw new TypeError("catalogDrafts.publishDraft: draft " + JSON.stringify(draftSlug) + " has no staged changes");
    }
    var preflight = await _planChanges(draftSlug, changes, "preflight");
    if (preflight.problems.length > 0) {
      var pErr = new Error(
        "catalogDrafts.publishDraft: pre-flight refused " + preflight.problems.length +
        " change(s) — see .problems"
      );
      pErr.code     = "PREFLIGHT_FAILED";
      pErr.problems = preflight.problems;
      throw pErr;
    }
    if (dryRun) {
      return {
        dry_run:       true,
        draft_slug:    draftSlug,
        plan_count:    preflight.plan.length,
        problems:      [],
      };
    }
    // Capture the pre-publish snapshot BEFORE applying the plan so
    // rollbackDraft has the original state to restore.
    var preSnapshot = await _captureSnapshot(changes);
    var applied = await _applyPlan(preflight.plan);
    var ts = _now();
    await query(
      "UPDATE catalog_drafts SET status = 'published', published_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2",
      [ts, draftSlug],
    );
    // Store the pre-publish snapshot in the rollback-log table under
    // the SAME row id used at rollback time? No — the rollback log
    // is a separate write per rollback gesture. Persist the
    // pre-publish snapshot under a sentinel row keyed by draft_slug
    // with a NULL rollback_state_json so rollbackDraft can read it
    // out. The sentinel row stays for the 7-day window; rollback
    // overwrites it with the round-trip.
    var sentinelId = b.uuid.v7();
    await query(
      "INSERT INTO catalog_draft_rollback_log " +
      "(id, draft_slug, original_state_json, rollback_state_json, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [sentinelId, draftSlug, JSON.stringify(preSnapshot), JSON.stringify({ pending: true }), ts],
    );
    return {
      draft_slug:  draftSlug,
      status:      "published",
      applied:     applied.length,
      published_at: ts,
    };
  }

  // ---- cancelDraft --------------------------------------------------

  async function cancelDraft(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("catalogDrafts.cancelDraft: input object required");
    }
    var draftSlug = _slug(input.draft_slug, "draft_slug");
    var reason    = _reqReason(input.reason, "reason");
    var d = await _assertDraftExists(draftSlug);
    if (TERMINAL_STATUSES.indexOf(d.status) !== -1) {
      var err = new Error(
        "catalogDrafts.cancelDraft: draft " + JSON.stringify(draftSlug) +
        " is " + d.status + " (terminal — refuse cancel)"
      );
      err.code = "DRAFT_TERMINAL";
      throw err;
    }
    var ts = _now();
    await query(
      "UPDATE catalog_drafts SET status = 'cancelled', cancelled_at = ?1, cancel_reason = ?2, updated_at = ?1 " +
      "WHERE slug = ?3",
      [ts, reason, draftSlug],
    );
    return await _getDraft(draftSlug);
  }

  // ---- rollbackDraft ------------------------------------------------

  async function rollbackDraft(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("catalogDrafts.rollbackDraft: input object required");
    }
    var draftSlug = _slug(input.draft_slug, "draft_slug");
    var reason    = _reqReason(input.reason, "reason");
    var d = await _assertDraftExists(draftSlug);
    if (d.status !== "published") {
      var sErr = new Error(
        "catalogDrafts.rollbackDraft: only published drafts can be rolled back (" +
        JSON.stringify(draftSlug) + " is " + d.status + ")"
      );
      sErr.code = "DRAFT_NOT_PUBLISHED";
      throw sErr;
    }
    if (d.published_at == null) {
      throw new TypeError("catalogDrafts.rollbackDraft: published_at unexpectedly null for draft " + JSON.stringify(draftSlug));
    }
    var now = _now();
    if (now - d.published_at > ROLLBACK_WINDOW_MS) {
      var wErr = new Error(
        "catalogDrafts.rollbackDraft: 7-day rollback window has elapsed for draft " +
        JSON.stringify(draftSlug)
      );
      wErr.code = "ROLLBACK_WINDOW_ELAPSED";
      throw wErr;
    }

    // Read the pre-publish snapshot from the sentinel rollback-log row.
    var sentinelR = await query(
      "SELECT * FROM catalog_draft_rollback_log WHERE draft_slug = ?1 " +
      "ORDER BY occurred_at ASC LIMIT 1",
      [draftSlug],
    );
    var sentinel = sentinelR.rows[0];
    if (!sentinel) {
      throw new Error("catalogDrafts.rollbackDraft: no snapshot recorded for draft " + JSON.stringify(draftSlug));
    }
    var original;
    try { original = JSON.parse(sentinel.original_state_json); }
    catch (_e) {
      throw new Error("catalogDrafts.rollbackDraft: snapshot is unreadable for draft " + JSON.stringify(draftSlug));
    }

    // Capture the current (post-publish) catalog state for the same
    // set of slugs / skus the original snapshot covered. This is the
    // "state being abandoned" — the auditor sees both sides of the
    // round-trip.
    var changes = await _listChangesAll(draftSlug);
    var postSnapshot = await _captureSnapshot(changes);

    // Restore the original state. For each captured product / variant
    // / price / inventory row, write back the values from the
    // original snapshot. Created-during-publish rows are torn down;
    // archived-during-publish rows are restored.
    await _restoreSnapshot(original);

    var ts = _now();
    // Persist the round-trip on the existing sentinel row (preserve
    // the original snapshot, fill in the rollback-state).
    await query(
      "UPDATE catalog_draft_rollback_log SET rollback_state_json = ?1, occurred_at = ?2 WHERE id = ?3",
      [JSON.stringify(postSnapshot), ts, sentinel.id],
    );
    await query(
      "UPDATE catalog_drafts SET status = 'rolled_back', rolled_back_at = ?1, rollback_reason = ?2, updated_at = ?1 " +
      "WHERE slug = ?3",
      [ts, reason, draftSlug],
    );
    return await _getDraft(draftSlug);
  }

  // Restore the catalog state from a snapshot. Best-effort: each
  // row's restore is wrapped so a single failure (e.g. a downstream
  // FK preventing a tag removal) doesn't strand the rest of the
  // restore. The post-restore catalog still has the snapshot recorded
  // in the rollback log so the operator can reconcile by hand if
  // the automated pass missed a row.
  async function _restoreSnapshot(snap) {
    // Restore products + tags first (tags depend on the product row).
    var productSlugs = Object.keys(snap.products || {});
    for (var i = 0; i < productSlugs.length; i += 1) {
      var slug = productSlugs[i];
      var originalProd = snap.products[slug];
      var current = null;
      try { current = await catalog.products.bySlug(slug); }
      catch (_e) { current = null; }
      if (!originalProd && current) {
        // Created-by-this-draft. Archive in lieu of hard-delete so
        // any audit trail referencing the product id stays
        // referentially intact.
        try { await catalog.products.archive(current.id); }
        catch (_e) { /* drop-silent — see _restoreSnapshot intro */ }
      } else if (originalProd && current) {
        // Pre-existing — restore mutable fields.
        var patch = {};
        if (originalProd.slug        != null && originalProd.slug        !== current.slug)        patch.slug        = originalProd.slug;
        if (originalProd.title       != null && originalProd.title       !== current.title)       patch.title       = originalProd.title;
        if (originalProd.description != null && originalProd.description !== current.description) patch.description = originalProd.description;
        if (originalProd.status      != null && originalProd.status      !== current.status)      patch.status      = originalProd.status;
        if (Object.keys(patch).length > 0) {
          try { await catalog.products.update(current.id, patch); }
          catch (_e) { /* drop-silent */ }
        }
      } else if (originalProd && !current) {
        // Existed in snapshot, gone now (archive-then-delete by a
        // separate path) — re-create with the original payload.
        try {
          await catalog.products.create({
            slug: originalProd.slug, title: originalProd.title,
            description: originalProd.description, status: originalProd.status,
          });
        } catch (_e) { /* drop-silent */ }
      }
    }

    // Restore variants.
    var skus = Object.keys(snap.variants || {});
    for (var j = 0; j < skus.length; j += 1) {
      var sku = skus[j];
      var origV = snap.variants[sku];
      var curV  = null;
      try { curV = await catalog.variants.bySku(sku); }
      catch (_e) { curV = null; }
      if (!origV && curV) {
        try { await catalog.variants.delete(curV.id); }
        catch (_e) { /* drop-silent */ }
      } else if (origV && !curV) {
        // Need a product to attach to — resolve via the snapshot's
        // product id mapping.
        var parentId = origV.product_id;
        if (parentId) {
          try {
            await catalog.variants.create(parentId, {
              sku: origV.sku,
              title: origV.title || "",
              options: origV.options || {},
              weight_grams: origV.weight_grams == null ? 0 : origV.weight_grams,
              requires_shipping: origV.requires_shipping == null ? true : origV.requires_shipping,
            });
          } catch (_e) { /* drop-silent */ }
        }
      }
    }

    // Restore prices.
    var priceSkus = Object.keys(snap.prices || {});
    for (var pk = 0; pk < priceSkus.length; pk += 1) {
      var psku = priceSkus[pk];
      var byCurrency = snap.prices[psku] || {};
      var curV2 = null;
      try { curV2 = await catalog.variants.bySku(psku); }
      catch (_e) { curV2 = null; }
      if (!curV2) continue;                       // variant gone; skip
      var ccyList = Object.keys(byCurrency);
      for (var c = 0; c < ccyList.length; c += 1) {
        var ccy = ccyList[c];
        var origPrice = byCurrency[ccy];
        if (origPrice && origPrice.amount_minor != null) {
          try {
            await catalog.prices.set(curV2.id, {
              currency: ccy, amount_minor: origPrice.amount_minor,
            });
          } catch (_e) { /* drop-silent */ }
        }
      }
    }

    // Restore inventory.
    var invSkus = Object.keys(snap.inventory || {});
    for (var ik = 0; ik < invSkus.length; ik += 1) {
      var isku  = invSkus[ik];
      var origI = snap.inventory[isku];
      if (!origI) continue;
      var curI = null;
      try { curI = await catalog.inventory.get(isku); }
      catch (_e) { curI = null; }
      if (!curI) continue;
      var origStock = Number(origI.stock_on_hand || 0);
      var curStock  = Number(curI.stock_on_hand || 0);
      if (origStock === curStock) continue;
      var diff = origStock - curStock;
      if (diff > 0 && typeof catalog.inventory.restock === "function") {
        try { await catalog.inventory.restock(isku, diff); }
        catch (_e) { /* drop-silent */ }
      } else if (diff < 0 && typeof catalog.inventory.release === "function") {
        try { await catalog.inventory.release(isku, -diff); }
        catch (_e) { /* drop-silent */ }
      }
    }

    // Restore tags. For each product, compute the symmetric diff
    // (set-of-original \ set-of-current and vice versa) and apply
    // add / remove.
    if (catalog.tags) {
      var tagSlugs = Object.keys(snap.tags || {});
      for (var ts = 0; ts < tagSlugs.length; ts += 1) {
        var tslug = tagSlugs[ts];
        var origTags = (snap.tags[tslug] || []).slice();
        var prod = null;
        try { prod = await catalog.products.bySlug(tslug); }
        catch (_e) { prod = null; }
        if (!prod) continue;
        var liveTags = [];
        if (typeof catalog.tags.listForProduct === "function") {
          try { liveTags = await catalog.tags.listForProduct(prod.id); }
          catch (_e) { liveTags = []; }
        }
        var origSet = Object.create(null);
        var liveSet = Object.create(null);
        for (var oi = 0; oi < origTags.length; oi += 1) origSet[origTags[oi]] = true;
        for (var li = 0; li < liveTags.length; li += 1) liveSet[liveTags[li]] = true;
        // To restore: add anything in origSet missing from liveSet;
        // remove anything in liveSet missing from origSet.
        for (var oj = 0; oj < origTags.length; oj += 1) {
          if (!liveSet[origTags[oj]]) {
            try { await catalog.tags.add(prod.id, origTags[oj]); }
            catch (_e) { /* drop-silent */ }
          }
        }
        for (var lj = 0; lj < liveTags.length; lj += 1) {
          if (!origSet[liveTags[lj]]) {
            try { await catalog.tags.remove(prod.id, liveTags[lj]); }
            catch (_e) { /* drop-silent */ }
          }
        }
      }
    }
  }

  // ---- listDrafts ---------------------------------------------------

  async function listDrafts(listOpts) {
    listOpts = listOpts || {};
    var statusFilter = null;
    if (listOpts.status != null) {
      statusFilter = _status(listOpts.status);
    }
    var ownerFilter = null;
    if (listOpts.owner != null) {
      ownerFilter = _optOwner(listOpts.owner);
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("catalogDrafts.listDrafts: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql, params;
    if (statusFilter && ownerFilter) {
      sql    = "SELECT * FROM catalog_drafts WHERE status = ?1 AND owner_id = ?2 " +
               "ORDER BY updated_at DESC, slug ASC LIMIT ?3";
      params = [statusFilter, ownerFilter, limit];
    } else if (statusFilter) {
      sql    = "SELECT * FROM catalog_drafts WHERE status = ?1 ORDER BY updated_at DESC, slug ASC LIMIT ?2";
      params = [statusFilter, limit];
    } else if (ownerFilter) {
      sql    = "SELECT * FROM catalog_drafts WHERE owner_id = ?1 ORDER BY updated_at DESC, slug ASC LIMIT ?2";
      params = [ownerFilter, limit];
    } else {
      sql    = "SELECT * FROM catalog_drafts ORDER BY updated_at DESC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateDraftRow(r.rows[i]));
    return out;
  }

  // ---- historyForSku ------------------------------------------------

  async function historyForSku(sku) {
    _sku(sku, "sku");
    // SQLite / D1 dialect supports JSON1 functions but the project's
    // portable surface uses LIKE-on-payload_json to find every change
    // whose payload references the SKU. The payload writer guarantees
    // every sku field is stored as `"sku":"<value>"` so the LIKE
    // pattern is unambiguous (no false matches against a product_slug
    // that happens to share the substring).
    var needle = '"sku":"' + sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    var r = await query(
      "SELECT c.*, d.title AS draft_title, d.status AS draft_status, " +
      "       d.published_at AS draft_published_at, d.rolled_back_at AS draft_rolled_back_at " +
      "FROM catalog_draft_changes c " +
      "JOIN catalog_drafts d ON d.slug = c.draft_slug " +
      "WHERE c.payload_json LIKE ?1 " +
      "ORDER BY c.created_at DESC, c.id DESC",
      ["%" + needle + "%"],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var ch  = _hydrateChangeRow({
        id:             row.id,
        draft_slug:     row.draft_slug,
        kind:           row.kind,
        payload_json:   row.payload_json,
        sequence_order: row.sequence_order,
        created_at:     row.created_at,
      });
      // Filter LIKE false-positives by exact-matching the payload's
      // sku field through the parsed object. The LIKE pre-filter
      // narrows the scan; this loop guarantees correctness.
      if (_payloadSkuOf(ch.kind, ch.payload) !== sku) continue;
      ch.draft = {
        title:          row.draft_title,
        status:         row.draft_status,
        published_at:   row.draft_published_at == null ? null : Number(row.draft_published_at),
        rolled_back_at: row.draft_rolled_back_at == null ? null : Number(row.draft_rolled_back_at),
      };
      out.push(ch);
    }
    return out;
  }

  // ---- getDraft -----------------------------------------------------

  // Exposed for ergonomic reads — many callers want the draft row
  // and the staged-change list together. listChanges separately is
  // for cursor pagination over large drafts.
  async function getDraft(slug) {
    _slug(slug, "slug");
    return await _getDraft(slug);
  }

  return {
    STATUSES:                STATUSES.slice(),
    KINDS:                   KINDS.slice(),
    TERMINAL_STATUSES:       TERMINAL_STATUSES.slice(),
    ROLLBACK_WINDOW_MS:      ROLLBACK_WINDOW_MS,
    MAX_CHANGES_PER_DRAFT:   MAX_CHANGES_PER_DRAFT,

    openDraft:      openDraft,
    stageChange:    stageChange,
    listChanges:    listChanges,
    removeChange:   removeChange,
    previewMerged:  previewMerged,
    publishDraft:   publishDraft,
    cancelDraft:    cancelDraft,
    rollbackDraft:  rollbackDraft,
    listDrafts:     listDrafts,
    historyForSku:  historyForSku,
    getDraft:       getDraft,
  };
}

module.exports = {
  create:                  create,
  STATUSES:                STATUSES,
  KINDS:                   KINDS,
  TERMINAL_STATUSES:       TERMINAL_STATUSES,
  ROLLBACK_WINDOW_MS:      ROLLBACK_WINDOW_MS,
  MAX_CHANGES_PER_DRAFT:   MAX_CHANGES_PER_DRAFT,
};
