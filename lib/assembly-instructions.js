"use strict";
/**
 * @module shop.assemblyInstructions
 * @title  Per-SKU assembly / care / unboxing instructions
 *
 * @intro
 *   Operator authors per-SKU instructions in one of four shapes
 *   (PDF link / video link / inline Markdown / external link); the
 *   customer accesses them from their order-detail page, the order
 *   confirmation email, or the customer portal. Every view is
 *   stamped to a per-instruction log that feeds support metrics
 *   ("the customer never opened the assembly guide before
 *   opening the ticket — surface the link in the first response")
 *   and the "unviewed orders" nudge ("we shipped you a desk five
 *   days ago and you haven't opened the assembly PDF").
 *
 *   The shape:
 *
 *     var ai = b.shop.assemblyInstructions.create({
 *       query:    q,
 *       catalog:  catalogPrimitive,   // optional — sku existence check
 *     });
 *
 *     // Operator authors a PDF guide for a SKU.
 *     await ai.defineInstruction({
 *       sku:         "DESK-OAK-72IN",
 *       kind:        "pdf",
 *       content_url: "https://cdn.example.com/guides/desk-oak-72in-v3.pdf",
 *       locale:      "en",
 *       version:     1,
 *       published:   true,
 *     });
 *
 *     // Customer hits the order page; the storefront calls:
 *     var inst = await ai.getInstruction({ sku: "DESK-OAK-72IN", locale: "fr" });
 *     // → falls back to the English row when no FR version exists.
 *
 *     await ai.recordView({
 *       instruction_id: inst.id,
 *       order_id:       "<order-uuid>",
 *       customer_id:    "<customer-uuid>",
 *       session_id:     "<opaque-session-cookie>",
 *     });
 *
 *   Verbs:
 *     defineInstruction — append a new (sku, locale, version) row.
 *       Versions per (sku, locale) are operator-numbered so the
 *       operator's CMS can stage v2 alongside v1 and flip the
 *       `published` bit on its own schedule. Same version number
 *       refuses with a typed error so a sloppy CMS doesn't
 *       silently overwrite history.
 *
 *     getInstruction — look up the published row at the requested
 *       locale; fall back to the canonical English row when none
 *       exists. Returns `null` when no published row exists in
 *       any locale.
 *
 *     listForSku — every non-archived row for a SKU. Used by the
 *       operator's CMS to render the version history table.
 *
 *     archiveInstruction — flip `archived_at` so future getInstruction
 *       / listForSku ignore the row. The view log is preserved so
 *       support metrics survive a SKU's retirement.
 *
 *     publishVersion — flip `published = 1` on the supplied row and
 *       `published = 0` on every prior published row in the same
 *       (sku, locale). The operator's "promote v2 to live" verb.
 *
 *     recordView — append a view row. At least one of order_id /
 *       customer_id / session_id must be present; the session id is
 *       namespace-hashed so the raw cookie value never lands in the
 *       audit log.
 *
 *     viewsForCustomer — every view by a customer, ordered newest-
 *       first. Powers the support agent's "did they open the guide?"
 *       lookup.
 *
 *     popularInstructions — top-N most-viewed instructions in a
 *       window. Powers the operator's "which guides are pulling
 *       traffic?" dashboard.
 *
 *     unviewedForCustomer — orders whose line-item SKUs have
 *       published instructions the customer hasn't opened within
 *       `days` of the order. Powers the "you haven't opened the
 *       assembly guide for the desk you ordered last week" nudge.
 *
 *   Composition:
 *     - b.uuid.v7              — instruction + view row ids
 *     - b.guardUuid            — customer / order id sanitization
 *     - b.crypto.namespaceHash — session id hashed before write
 *     - b.safeUrl.parse        — content_url is https-only
 *     - b.template.escapeHtml  — markdown render escapes every text run
 *     - catalog (optional)     — held as a read-only marker so a future
 *       verb can refuse unknown SKUs at definition time without a
 *       factory-shape break
 *
 *   Three-tier input validation: every public verb is a config-time
 *   entry point (defineInstruction / archiveInstruction /
 *   publishVersion) or a defensive request-shape reader
 *   (recordView / getInstruction / listForSku / viewsForCustomer /
 *   popularInstructions / unviewedForCustomer). All shapes throw
 *   on bad input; no drop-silent hot paths.
 *
 * @primitive assemblyInstructions
 * @related   b.uuid, b.guardUuid, b.crypto.namespaceHash, b.safeUrl, b.template.escapeHtml
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SKU_RE            = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var LOCALE_RE         = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
var SESSION_ID_RE     = /^[A-Za-z0-9_-]{16,128}$/;
var ID_RE             = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var KINDS             = Object.freeze(["pdf", "video", "markdown", "external_link"]);
var DEFAULT_LOCALE    = "en";
var MAX_URL_LEN       = 2048;
var MAX_MARKDOWN_LEN  = 64 * 1024;
var MAX_VERSION       = 1000000;
var MAX_LIMIT         = 500;
var DEFAULT_LIMIT     = 50;
var MAX_DAYS          = 3650;
var SESSION_NAMESPACE = "assembly-instructions-session";
var DAY_MS            = C.TIME.days(1);

// ---- monotonic clock ----------------------------------------------------
//
// Two instructions / views written inside the same millisecond would
// otherwise collide on the v7-uuid timestamp prefix and tie on
// (occurred_at, id) ordering. The monotonic step guarantees a strict
// increase so the popularInstructions + viewsForCustomer reads return
// a deterministic order without depending on the v7 sub-ms counter.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("assembly-instructions: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("assembly-instructions: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _locale(s) {
  if (typeof s !== "string" || !LOCALE_RE.test(s)) {
    throw new TypeError("assembly-instructions: locale must be BCP-47-ish (e.g. 'en' / 'en-US' / 'pt-BR')");
  }
  var parts = s.split("-");
  parts[0] = parts[0].toLowerCase();
  return parts.join("-");
}

function _version(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_VERSION) {
    throw new TypeError("assembly-instructions: version must be a positive integer <= " + MAX_VERSION);
  }
  return n;
}

function _id(s, label) {
  if (typeof s !== "string" || !ID_RE.test(s)) {
    throw new TypeError("assembly-instructions: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _uuid(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("assembly-instructions: " + label + " - " + (e && e.message || "invalid UUID"));
  }
}

function _sessionId(s) {
  if (typeof s !== "string" || !SESSION_ID_RE.test(s)) {
    throw new TypeError("assembly-instructions: session_id must be 16-128 chars of [A-Za-z0-9_-]");
  }
  return s;
}

function _hashSession(s) {
  return b.crypto.namespaceHash(SESSION_NAMESPACE, s);
}

// content_url is HTTPS-only - PDFs / videos / external_link rows all
// resolve to public origins, and the operator's CDN policy refuses
// http:// references. Any other protocol (data:, javascript:, mailto:,
// ftp:) is refused by safeUrl's protocol allowlist.
function _contentUrl(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_URL_LEN) {
    throw new TypeError("assembly-instructions: content_url must be a non-empty string <= " + MAX_URL_LEN + " chars");
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("assembly-instructions: content_url - " + (e && e.message || "https-only URL required"));
  }
  return s;
}

function _markdown(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("assembly-instructions: content_markdown must be a non-empty string");
  }
  if (s.length > MAX_MARKDOWN_LEN) {
    throw new TypeError("assembly-instructions: content_markdown must be <= " + MAX_MARKDOWN_LEN + " bytes");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("assembly-instructions: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("assembly-instructions: limit must be an integer in 1.." + MAX_LIMIT);
  }
  return n;
}

function _days(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DAYS) {
    throw new TypeError("assembly-instructions: days must be a positive integer <= " + MAX_DAYS);
  }
  return n;
}

// ---- markdown rendering -------------------------------------------------
//
// Minimal in-process Markdown subset - headings, paragraphs, lists.
// Every text run is HTML-escaped via `b.template.escapeHtml`; raw HTML
// in the body is never passed through. Surfaced so the storefront's
// order-detail page can render the markdown variant without composing
// a separate renderer.
function _esc(s) {
  return b.template.escapeHtml(s);
}

function _renderMarkdown(src) {
  if (typeof src !== "string") return "";
  var lines = src.replace(/\r\n?/g, "\n").split("\n");
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (!line.length) { i += 1; continue; }
    var hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      var level = hm[1].length;
      out.push("<h" + level + ">" + _esc(hm[2]) + "</h" + level + ">");
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      out.push("<ul>");
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        out.push("<li>" + _esc(lines[i].replace(/^[-*]\s+/, "")) + "</li>");
        i += 1;
      }
      out.push("</ul>");
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      out.push("<ol>");
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        out.push("<li>" + _esc(lines[i].replace(/^\d+\.\s+/, "")) + "</li>");
        i += 1;
      }
      out.push("</ol>");
      continue;
    }
    out.push("<p>" + _esc(line) + "</p>");
    i += 1;
  }
  return out.join("\n");
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  // `catalog` is held as an optional read-only marker - an operator
  // that wants the primitive to refuse unknown SKUs at definition
  // time can compose that at the caller, OR a future verb can
  // consume this dep without changing the public factory shape.
  // The primitive never reads from this dep today.
  var catalog = opts.catalog || null;
  if (catalog !== null && typeof catalog !== "object") {
    throw new TypeError("assembly-instructions.create: opts.catalog must be an object or null");
  }
  void catalog;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  function _shapeInstruction(row) {
    if (!row) return null;
    return {
      id:                row.id,
      sku:               row.sku,
      kind:              row.kind,
      content_url:       row.content_url,
      content_markdown:  row.content_markdown,
      locale:            row.locale,
      version:           row.version,
      published:         row.published === 1 || row.published === true,
      archived_at:       row.archived_at,
      created_at:        row.created_at,
      updated_at:        row.updated_at,
    };
  }

  function _shapeView(row) {
    if (!row) return null;
    return {
      id:               row.id,
      instruction_id:   row.instruction_id,
      order_id:         row.order_id,
      customer_id:      row.customer_id,
      session_id_hash:  row.session_id_hash,
      occurred_at:      row.occurred_at,
    };
  }

  async function _getInstructionById(id) {
    var r = await query(
      "SELECT * FROM product_instructions WHERE id = ?1 LIMIT 1",
      [id],
    );
    return r.rows[0] || null;
  }

  async function _getInstructionByVersion(sku, locale, version) {
    var r = await query(
      "SELECT * FROM product_instructions " +
      "WHERE sku = ?1 AND locale = ?2 AND version = ?3 LIMIT 1",
      [sku, locale, version],
    );
    return r.rows[0] || null;
  }

  // Resolve the published row at the requested locale; fall back to
  // the canonical English row if none exists. Archived rows are
  // ignored at every step.
  async function _resolvePublished(sku, locale) {
    var primary = await query(
      "SELECT * FROM product_instructions " +
      "WHERE sku = ?1 AND locale = ?2 AND published = 1 AND archived_at IS NULL " +
      "ORDER BY version DESC LIMIT 1",
      [sku, locale],
    );
    if (primary.rows[0]) return { row: primary.rows[0], locale_used: locale };
    if (locale === DEFAULT_LOCALE) return null;
    var fallback = await query(
      "SELECT * FROM product_instructions " +
      "WHERE sku = ?1 AND locale = ?2 AND published = 1 AND archived_at IS NULL " +
      "ORDER BY version DESC LIMIT 1",
      [sku, DEFAULT_LOCALE],
    );
    if (fallback.rows[0]) return { row: fallback.rows[0], locale_used: DEFAULT_LOCALE };
    return null;
  }

  return {

    KINDS:           KINDS,
    DEFAULT_LOCALE:  DEFAULT_LOCALE,

    // Append a new (sku, locale, version) row. The operator numbers
    // versions - staging v2 alongside v1 lets the CMS preview the
    // next revision before flipping `published`. Same version number
    // refuses with a typed error so a sloppy CMS doesn't silently
    // overwrite history.
    defineInstruction: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("assembly-instructions.defineInstruction: input object required");
      }
      var sku       = _sku(input.sku);
      var kind      = _kind(input.kind);
      var locale    = _locale(input.locale);
      var version   = _version(input.version);
      var published = input.published === true ? 1 : 0;

      var contentUrl = null;
      var contentMarkdown = null;
      if (kind === "markdown") {
        if (input.content_markdown == null) {
          throw new TypeError("assembly-instructions.defineInstruction: kind 'markdown' requires content_markdown");
        }
        contentMarkdown = _markdown(input.content_markdown);
        if (input.content_url != null) {
          throw new TypeError("assembly-instructions.defineInstruction: kind 'markdown' refuses content_url - pick one shape");
        }
      } else {
        if (input.content_url == null) {
          throw new TypeError("assembly-instructions.defineInstruction: kind '" + kind + "' requires content_url");
        }
        contentUrl = _contentUrl(input.content_url);
        if (input.content_markdown != null) {
          throw new TypeError("assembly-instructions.defineInstruction: kind '" + kind + "' refuses content_markdown - pick one shape");
        }
      }

      var existing = await _getInstructionByVersion(sku, locale, version);
      if (existing) {
        throw new TypeError("assembly-instructions.defineInstruction: (sku=" +
          JSON.stringify(sku) + ", locale=" + JSON.stringify(locale) +
          ", version=" + version + ") already exists - bump the version");
      }

      var ts = _now();
      var id = b.uuid.v7({ now: ts });
      await query(
        "INSERT INTO product_instructions " +
        "(id, sku, kind, content_url, content_markdown, locale, version, published, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)",
        [id, sku, kind, contentUrl, contentMarkdown, locale, version, published, ts],
      );

      if (published === 1) {
        await query(
          "UPDATE product_instructions SET published = 0, updated_at = ?1 " +
          "WHERE sku = ?2 AND locale = ?3 AND id != ?4 AND published = 1",
          [_now(), sku, locale, id],
        );
      }
      return _shapeInstruction(await _getInstructionById(id));
    },

    // Look up the published row at the requested locale; fall back to
    // the canonical English row when no row exists in the requested
    // locale. Returns `null` when no published row exists in any
    // locale - the storefront renders a "no instructions yet" panel.
    getInstruction: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("assembly-instructions.getInstruction: input object required");
      }
      var sku    = _sku(input.sku);
      var locale = input.locale == null ? DEFAULT_LOCALE : _locale(input.locale);
      var resolved = await _resolvePublished(sku, locale);
      if (!resolved) return null;
      var shaped = _shapeInstruction(resolved.row);
      shaped.locale_used = resolved.locale_used;
      return shaped;
    },

    // Every non-archived row for a SKU, newest version first. Used
    // by the operator's CMS to render the version history table.
    listForSku: async function (sku) {
      var skuV = _sku(sku);
      var r = await query(
        "SELECT * FROM product_instructions " +
        "WHERE sku = ?1 AND archived_at IS NULL " +
        "ORDER BY locale ASC, version DESC, id ASC",
        [skuV],
      );
      return r.rows.map(_shapeInstruction);
    },

    // Flip `archived_at` so future getInstruction / listForSku ignore
    // the row. The view log is preserved so support metrics survive
    // a SKU's retirement. Idempotent.
    archiveInstruction: async function (id) {
      var idV = _id(id, "id");
      var existing = await _getInstructionById(idV);
      if (!existing) {
        throw new TypeError("assembly-instructions.archiveInstruction: instruction id " +
          JSON.stringify(idV) + " not found");
      }
      if (existing.archived_at != null) {
        return _shapeInstruction(existing);
      }
      var ts = _now();
      await query(
        "UPDATE product_instructions SET archived_at = ?1, updated_at = ?1, published = 0 WHERE id = ?2",
        [ts, idV],
      );
      return _shapeInstruction(await _getInstructionById(idV));
    },

    // Flip `published = 1` on the supplied row and `published = 0` on
    // every prior published row in the same (sku, locale). The
    // operator's "promote v2 to live" verb. Refuses to publish an
    // archived row - operators that want to re-launch an archived
    // version define a new version instead.
    publishVersion: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("assembly-instructions.publishVersion: input object required");
      }
      var instructionId = _id(input.instruction_id, "instruction_id");
      var existing = await _getInstructionById(instructionId);
      if (!existing) {
        throw new TypeError("assembly-instructions.publishVersion: instruction_id " +
          JSON.stringify(instructionId) + " not found");
      }
      if (existing.archived_at != null) {
        throw new TypeError("assembly-instructions.publishVersion: instruction_id " +
          JSON.stringify(instructionId) + " is archived - define a new version instead");
      }
      var ts = _now();
      await query(
        "UPDATE product_instructions SET published = 0, updated_at = ?1 " +
        "WHERE sku = ?2 AND locale = ?3 AND id != ?4 AND published = 1",
        [ts, existing.sku, existing.locale, instructionId],
      );
      await query(
        "UPDATE product_instructions SET published = 1, updated_at = ?1 WHERE id = ?2",
        [_now(), instructionId],
      );
      return _shapeInstruction(await _getInstructionById(instructionId));
    },

    // Append a view row. At least one of order_id / customer_id /
    // session_id must be present; the session id is namespace-hashed
    // so the raw cookie value never lands in the audit log. Refuses
    // to record a view against an archived instruction - the audit
    // log's signal is "did the customer open the LIVE guide", not
    // "did the customer open any historical version".
    recordView: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("assembly-instructions.recordView: input object required");
      }
      var instructionId = _id(input.instruction_id, "instruction_id");
      var hasOrder    = input.order_id    != null;
      var hasCustomer = input.customer_id != null;
      var hasSession  = input.session_id  != null;
      if (!hasOrder && !hasCustomer && !hasSession) {
        throw new TypeError("assembly-instructions.recordView: at least one of order_id / customer_id / session_id required");
      }
      var existing = await _getInstructionById(instructionId);
      if (!existing) {
        throw new TypeError("assembly-instructions.recordView: instruction_id " +
          JSON.stringify(instructionId) + " not found");
      }
      if (existing.archived_at != null) {
        throw new TypeError("assembly-instructions.recordView: instruction_id " +
          JSON.stringify(instructionId) + " is archived");
      }
      var orderId    = hasOrder    ? _uuid(input.order_id,    "order_id")    : null;
      var customerId = hasCustomer ? _uuid(input.customer_id, "customer_id") : null;
      var sessionHash = hasSession  ? _hashSession(_sessionId(input.session_id)) : null;
      var occurredAt = input.occurred_at == null ? _now() : _epochMs(input.occurred_at, "occurred_at");
      var id = b.uuid.v7({ now: _now() });
      await query(
        "INSERT INTO product_instruction_views " +
        "(id, instruction_id, order_id, customer_id, session_id_hash, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, instructionId, orderId, customerId, sessionHash, occurredAt],
      );
      var r = await query(
        "SELECT * FROM product_instruction_views WHERE id = ?1 LIMIT 1",
        [id],
      );
      return _shapeView(r.rows[0]);
    },

    // Every view by a customer, newest-first. Powers the support
    // agent's "did they open the guide?" lookup.
    viewsForCustomer: async function (customerId, listOpts) {
      var cid = _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("assembly-instructions.viewsForCustomer: opts must be an object");
      }
      var limit = _limit(listOpts.limit);
      var r = await query(
        "SELECT * FROM product_instruction_views " +
        "WHERE customer_id = ?1 " +
        "ORDER BY occurred_at DESC, id DESC LIMIT ?2",
        [cid, limit],
      );
      return r.rows.map(_shapeView);
    },

    // Top-N most-viewed instructions in a window. Powers the
    // operator's "which guides are pulling traffic?" dashboard.
    popularInstructions: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("assembly-instructions.popularInstructions: input object required");
      }
      var from  = _epochMs(input.from, "from");
      var to    = _epochMs(input.to,   "to");
      if (to < from) {
        throw new TypeError("assembly-instructions.popularInstructions: to (" + to +
          ") must be >= from (" + from + ")");
      }
      var limit = _limit(input.limit);
      var r = await query(
        "SELECT v.instruction_id AS instruction_id, COUNT(*) AS view_count, " +
        "i.sku AS sku, i.locale AS locale, i.kind AS kind " +
        "FROM product_instruction_views v " +
        "JOIN product_instructions i ON i.id = v.instruction_id " +
        "WHERE v.occurred_at >= ?1 AND v.occurred_at <= ?2 " +
        "GROUP BY v.instruction_id " +
        "ORDER BY view_count DESC, v.instruction_id ASC LIMIT ?3",
        [from, to, limit],
      );
      return r.rows.map(function (row) {
        return {
          instruction_id: row.instruction_id,
          sku:            row.sku,
          locale:         row.locale,
          kind:           row.kind,
          view_count:     Number(row.view_count) || 0,
        };
      });
    },

    // Orders whose line-item SKUs have published instructions the
    // customer hasn't opened. Window is `days` days from now into the
    // past - operators tune the window per the product class. Returns
    // the order rows plus the list of (sku, instruction_id) pairs the
    // customer hasn't viewed.
    unviewedForCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("assembly-instructions.unviewedForCustomer: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var days       = _days(input.days);
      var nowMs      = input.now == null ? _now() : _epochMs(input.now, "now");
      var cutoff     = nowMs - days * DAY_MS;

      var lines = await query(
        "SELECT o.id AS order_id, o.created_at AS order_created_at, " +
        "l.sku AS sku " +
        "FROM orders o " +
        "JOIN order_lines l ON l.order_id = o.id " +
        "WHERE o.customer_id = ?1 AND o.created_at >= ?2 " +
        "ORDER BY o.created_at DESC, o.id ASC, l.sku ASC",
        [customerId, cutoff],
      );

      var byOrder = {};
      var orderOrder = [];
      var resolved = {};
      for (var i = 0; i < lines.rows.length; i += 1) {
        var ln = lines.rows[i];
        var orderId = ln.order_id;
        if (!byOrder[orderId]) {
          byOrder[orderId] = {
            order_id:        orderId,
            order_created_at: ln.order_created_at,
            unviewed:         [],
            seenSkus:         {},
          };
          orderOrder.push(orderId);
        }
        if (byOrder[orderId].seenSkus[ln.sku]) continue;
        byOrder[orderId].seenSkus[ln.sku] = true;

        var skuRes;
        if (Object.prototype.hasOwnProperty.call(resolved, ln.sku)) {
          skuRes = resolved[ln.sku];
        } else {
          skuRes = await _resolvePublished(ln.sku, DEFAULT_LOCALE);
          resolved[ln.sku] = skuRes;
        }
        if (!skuRes) continue;

        var v = await query(
          "SELECT id FROM product_instruction_views " +
          "WHERE instruction_id = ?1 AND customer_id = ?2 AND occurred_at >= ?3 LIMIT 1",
          [skuRes.row.id, customerId, ln.order_created_at],
        );
        if (v.rows[0]) continue;
        byOrder[orderId].unviewed.push({
          sku:            ln.sku,
          instruction_id: skuRes.row.id,
          locale:         skuRes.row.locale,
          kind:           skuRes.row.kind,
        });
      }

      var out = [];
      for (var j = 0; j < orderOrder.length; j += 1) {
        var entry = byOrder[orderOrder[j]];
        if (!entry.unviewed.length) continue;
        out.push({
          order_id:         entry.order_id,
          order_created_at: entry.order_created_at,
          unviewed:         entry.unviewed,
        });
      }
      return out;
    },

    // Render a markdown-kind instruction's body to escaped HTML.
    // Surfaced so the storefront's order-detail page can render the
    // markdown variant without composing a separate renderer. Every
    // text run passes through `b.template.escapeHtml`.
    renderMarkdown: function (markdown) {
      return _renderMarkdown(markdown);
    },
  };
}

// Top-level `run()` for direct invocation - exercises the primitive's
// factory shape against an in-memory query stub so the smoke caller
// can confirm the module loads + the factory composes without touching
// a remote D1 or a migration file.
async function run() {
  var rows = [];
  var q = async function (sql, params) {
    params = params || [];
    var verb = sql.replace(/^\s+/, "").split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" && /product_instructions/.test(sql)) {
      rows.push({
        id: params[0], sku: params[1], kind: params[2],
        content_url: params[3], content_markdown: params[4],
        locale: params[5], version: params[6], published: params[7],
        archived_at: null, created_at: params[8], updated_at: params[8],
      });
      return { rows: [], rowCount: 1 };
    }
    if (verb === "SELECT" && /FROM product_instructions/.test(sql) && /id = \?1/.test(sql)) {
      var id = params[0];
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].id === id) return { rows: [rows[i]], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (verb === "SELECT" && /FROM product_instructions/.test(sql) &&
        /sku = \?1 AND locale = \?2 AND version = \?3/.test(sql)) {
      for (var j = 0; j < rows.length; j += 1) {
        if (rows[j].sku === params[0] && rows[j].locale === params[1] &&
            rows[j].version === params[2]) {
          return { rows: [rows[j]], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (verb === "UPDATE") return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  var ai = create({ query: q });
  await ai.defineInstruction({
    sku:         "DESK-OAK-72IN",
    kind:        "pdf",
    content_url: "https://cdn.example.com/guides/desk-oak-72in-v1.pdf",
    locale:      "en",
    version:     1,
    published:   true,
  });
  return { ok: true };
}

module.exports = {
  create:         create,
  run:            run,
  KINDS:          KINDS,
  DEFAULT_LOCALE: DEFAULT_LOCALE,
};
