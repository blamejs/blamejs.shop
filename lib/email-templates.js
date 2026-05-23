"use strict";
/**
 * @module shop.emailTemplates
 * @title  Email templates — operator-editable transactional bodies
 *
 * @intro
 *   Where `email` composes a fixed catalog of transactional bodies
 *   the framework ships (order receipt, ship notification, refund,
 *   password reset), this primitive lets operators override those
 *   bodies without forking — per-slug subject + HTML + text +
 *   variable schema + locale variants + a published-version
 *   history. The renderer takes a per-call `variables` object and
 *   returns `{ subject, body_html, body_text }` ready for the
 *   mailer.
 *
 *   Composition:
 *
 *     var templates = bShop.emailTemplates.create({ query: q });
 *
 *     await templates.defineTemplate({
 *       slug:             "order-confirmation-default",
 *       title:            "Default order confirmation",
 *       kind:             "order_confirmation",
 *       subject:          "Order {{order_id}} confirmed",
 *       body_html:        "<h1>Thanks {{customer_name}}</h1>...",
 *       body_text:        "Thanks {{customer_name}}...",
 *       variables_schema: {
 *         required: ["customer_name", "order_id"],
 *         optional: ["grand_total_formatted"],
 *       },
 *       locale: "en",
 *     });
 *
 *     // A fresh defineTemplate creates a v1 row that is NOT yet
 *     // published — operators preview the render, then publish:
 *     await templates.publishVersion("order-confirmation-default", { locale: "en" });
 *
 *     var rendered = await templates.renderTemplate({
 *       slug:    "order-confirmation-default",
 *       locale:  "en",
 *       variables: {
 *         customer_name:         "Alex <tag>",
 *         order_id:              "ord_123",
 *         grand_total_formatted: "$42.00",
 *       },
 *     });
 *     // rendered.body_html contains HTML-escaped customer_name
 *
 *   Variable substitution discipline:
 *
 *     - `{{var_name}}` — the value is rendered through
 *       `b.template.escapeHtml`. This is the safe default; every
 *       customer-bound field (name, address, free-text) uses it.
 *
 *     - `{{var_name|raw}}` — opt-out of escaping. The operator
 *       authored the template and vouches for this slot being a
 *       pre-rendered HTML fragment. The framework refuses to inject
 *       a value into a `|raw` slot if the variable schema did not
 *       declare the name in its `raw` whitelist.
 *
 *   Locale fallback:
 *
 *     `getTemplate({ slug, locale })` and `renderTemplate(...)` look
 *     up the locale variant first; if there is no published version
 *     for that exact locale, they fall back to `en`. Missing both
 *     surfaces the operator-actionable error
 *     `EMAIL_TEMPLATE_NOT_FOUND`.
 *
 *   Versions:
 *
 *     Every `defineTemplate({ slug, locale, ... })` appends a new
 *     version row (`version_number` = max + 1) — operators iterate
 *     the body without losing the prior history. `publishVersion`
 *     flips the active version atomically so the renderer always
 *     reads exactly one published row per (slug, locale).
 *
 *   Storage:
 *     - `email_templates` + `email_template_versions` (migration
 *       `0125_email_templates.sql`).
 *
 * @primitive emailTemplates
 * @related   shop.email, b.template.escapeHtml, b.uuid.v7
 */

// ---- constants ----------------------------------------------------------

var SLUG_RE      = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var VAR_NAME_RE  = /^[a-z_][a-z0-9_]*$/;
var LOCALE_RE    = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
var DEFAULT_LOCALE = "en";

var KINDS = [
  "order_confirmation",
  "order_shipped",
  "order_delivered",
  "order_refunded",
  "password_reset",
  "account_verification",
  "abandoned_cart",
  "wishlist_discount",
  "review_request",
  "welcome",
  "generic",
];

var MAX_TITLE_LEN          = 200;
var MAX_SUBJECT_LEN        = 200;
var MAX_BODY_LEN           = 256 * 1024;   // 256 KiB — wide enough for HTML
var MAX_LIST_LIMIT         = 500;
var MAX_VARIABLE_KEYS      = 100;          // schema sanity bound

// Placeholder shape — `{{var_name}}` or `{{var_name|raw}}`. The
// regex is anchored to the curly-brace pair so an operator's HTML
// containing literal `{ }` won't accidentally match.
var PLACEHOLDER_RE = /\{\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*(raw))?\s*\}\}/gi;

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// Monotonic clock seam — every primitive path that needs a
// `now` reads through this helper so tests can inject a fake
// clock via the per-call `now` opt without monkey-patching
// `Date.now`. The default falls through to `Date.now()`.
function _now() { return Date.now(); }

// ---- validators ---------------------------------------------------------

function _validateSlug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailTemplates: " + label + " must be a non-empty string");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "emailTemplates: " + label + " must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/"
    );
  }
  return s;
}

function _validateTitle(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailTemplates: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("emailTemplates: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("emailTemplates: title must not contain CR / LF / NUL");
  }
  return s;
}

function _validateKind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError(
      "emailTemplates: kind must be one of " + KINDS.join(", ")
    );
  }
  return s;
}

function _validateSubject(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailTemplates: subject must be a non-empty string");
  }
  if (s.length > MAX_SUBJECT_LEN) {
    throw new TypeError("emailTemplates: subject must be <= " + MAX_SUBJECT_LEN + " characters");
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("emailTemplates: subject must not contain CR / LF / NUL");
  }
  return s;
}

function _validateBody(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailTemplates: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("emailTemplates: " + label + " must be <= " + MAX_BODY_LEN + " bytes");
  }
  return s;
}

function _validateLocale(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailTemplates: " + (label || "locale") + " must be a non-empty string");
  }
  if (!LOCALE_RE.test(s)) {
    throw new TypeError(
      "emailTemplates: " + (label || "locale") + " must be BCP-47-ish (e.g. 'en' / 'en-US' / 'pt-BR')"
    );
  }
  // Normalize the language subtag to lowercase so 'EN' / 'en' index
  // the same column — keeps the locale-fallback predicate honest.
  var parts = s.split("-");
  parts[0] = parts[0].toLowerCase();
  return parts.join("-");
}

// Variables schema — operator declares the keys the template
// references. The shape is intentionally minimal:
//
//   { required?: [string], optional?: [string], raw?: [string] }
//
// `required` keys are mandatory at render time. `optional` keys
// pass through when present. `raw` keys MAY appear in the
// template via `{{name|raw}}` and skip HTML-escape; any key not
// listed in `raw` that the template uses with `|raw` is refused
// at definition time (operator-vouched, not caller-vouched).
function _validateVariablesSchema(schema) {
  if (schema == null) return { required: [], optional: [], raw: [] };
  if (typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("emailTemplates: variables_schema must be an object");
  }
  var out = { required: [], optional: [], raw: [] };
  var totalKeys = 0;
  var seen = {};
  var fields = ["required", "optional", "raw"];
  for (var fi = 0; fi < fields.length; fi += 1) {
    var f = fields[fi];
    if (schema[f] == null) continue;
    if (!Array.isArray(schema[f])) {
      throw new TypeError(
        "emailTemplates: variables_schema." + f + " must be an array"
      );
    }
    for (var i = 0; i < schema[f].length; i += 1) {
      var k = schema[f][i];
      if (typeof k !== "string" || !VAR_NAME_RE.test(k)) {
        throw new TypeError(
          "emailTemplates: variables_schema." + f +
          " entries must match /[a-z_][a-z0-9_]*/ — got " + JSON.stringify(k)
        );
      }
      if (seen[k] && f !== "raw") {
        // `raw` may overlap with required/optional — the raw set is a
        // capability flag, not a separate variable name space. The
        // required + optional sets are mutually exclusive though.
        throw new TypeError(
          "emailTemplates: variables_schema key '" + k +
          "' appears in multiple of required/optional"
        );
      }
      if (f !== "raw") seen[k] = true;
      out[f].push(k);
      totalKeys += 1;
      if (totalKeys > MAX_VARIABLE_KEYS) {
        throw new TypeError(
          "emailTemplates: variables_schema must declare <= " + MAX_VARIABLE_KEYS + " keys"
        );
      }
    }
  }
  return out;
}

// Walk the template body + subject + collect every `{{name}}` /
// `{{name|raw}}` reference. Refuse a template whose `|raw` slots
// reference a variable the schema didn't list in `raw` — the
// operator vouches for raw at definition time, never at render
// time.
function _scanPlaceholders(text) {
  var refs = [];
  var m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    refs.push({ name: m[1], raw: m[2] === "raw" });
  }
  return refs;
}

function _validateTemplateBodyVsSchema(parts, schema) {
  var refs = [];
  for (var pi = 0; pi < parts.length; pi += 1) {
    var list = _scanPlaceholders(parts[pi]);
    for (var i = 0; i < list.length; i += 1) refs.push(list[i]);
  }
  var declared = {};
  for (var r = 0; r < schema.required.length; r += 1) declared[schema.required[r]] = true;
  for (var o = 0; o < schema.optional.length; o += 1) declared[schema.optional[o]] = true;
  var rawDeclared = {};
  for (var rd = 0; rd < schema.raw.length; rd += 1) rawDeclared[schema.raw[rd]] = true;
  for (var k = 0; k < refs.length; k += 1) {
    var name = refs[k].name;
    if (!declared[name]) {
      throw new TypeError(
        "emailTemplates: template references variable '{{" + name +
        "}}' not declared in variables_schema.required / .optional"
      );
    }
    if (refs[k].raw && !rawDeclared[name]) {
      throw new TypeError(
        "emailTemplates: template uses '{{" + name +
        "|raw}}' but variables_schema.raw does not list it — " +
        "operator must vouch for the raw slot at definition time"
      );
    }
  }
}

// Validate the per-render `variables` payload against the schema.
// Refuses unknown keys (typos would silently render as empty),
// refuses missing required keys (the renderer can't ship a half-
// rendered email), accepts every declared optional key.
function _validateRenderVariables(schema, variables) {
  if (variables == null || typeof variables !== "object" || Array.isArray(variables)) {
    throw new TypeError("emailTemplates: variables must be an object");
  }
  var allowed = {};
  for (var r = 0; r < schema.required.length; r += 1) allowed[schema.required[r]] = "required";
  for (var o = 0; o < schema.optional.length; o += 1) allowed[schema.optional[o]] = "optional";
  var keys = Object.keys(variables);
  for (var i = 0; i < keys.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(allowed, keys[i])) {
      throw new TypeError(
        "emailTemplates: unknown variable '" + keys[i] +
        "' — schema declares " + (Object.keys(allowed).join(", ") || "(none)")
      );
    }
  }
  for (var k = 0; k < schema.required.length; k += 1) {
    if (!Object.prototype.hasOwnProperty.call(variables, schema.required[k])) {
      throw new TypeError(
        "emailTemplates: required variable '" + schema.required[k] + "' missing"
      );
    }
  }
  return true;
}

// Substitute `{{name}}` / `{{name|raw}}` against `variables`. Every
// non-raw slot runs through `b.template.escapeHtml`; `|raw` slots
// pass through verbatim. Optional variables that are not supplied
// render as the empty string (the operator declared the slot
// optional + the schema check already accepted the missing key).
function _renderBody(template, schema, variables) {
  var rawSet = {};
  for (var i = 0; i < schema.raw.length; i += 1) rawSet[schema.raw[i]] = true;
  var escapeHtml = _b().template.escapeHtml;
  return template.replace(PLACEHOLDER_RE, function (_match, name, suffix) {
    var raw = suffix === "raw";
    var val = Object.prototype.hasOwnProperty.call(variables, name)
      ? variables[name]
      : "";
    if (val == null) val = "";
    // Belt-and-braces: even when a slot is `{{name|raw}}`, the
    // schema must have whitelisted `name` in `raw`. The definition-
    // time check already refused mismatched templates; this guard
    // covers a schema that drifted post-definition (operator edited
    // the schema after a publish).
    if (raw && rawSet[name]) return String(val);
    return escapeHtml(val);
  });
}

// Compose subject + html + text in one pass so the renderer's
// single failure surface is the schema check at the top, not a
// per-part inconsistency.
function _renderAll(row, variables) {
  return {
    subject:   _renderBody(row.subject,   row._schema, variables),
    body_html: _renderBody(row.body_html, row._schema, variables),
    body_text: _renderBody(row.body_text, row._schema, variables),
  };
}

// ---- row → public shape -------------------------------------------------

function _rowToTemplate(row) {
  if (!row) return null;
  return {
    slug:        row.slug,
    title:       row.title,
    kind:        row.kind,
    archived_at: row.archived_at == null ? null : Number(row.archived_at),
    created_at:  Number(row.created_at),
    updated_at:  Number(row.updated_at),
  };
}

function _rowToVersion(row) {
  if (!row) return null;
  var schema;
  try {
    schema = JSON.parse(row.variables_schema_json);
  } catch (_e) {
    // drop-silent — a malformed JSON column would be a write-side
    // corruption we surface as the operator-readable empty shape.
    // The audit ledger is the source of truth for "did we write
    // garbage?"; the renderer prefers an empty schema over a hard
    // crash when reading historical rows.
    schema = { required: [], optional: [], raw: [] };
  }
  return {
    id:               row.id,
    template_slug:    row.template_slug,
    locale:           row.locale,
    subject:          row.subject,
    body_html:        row.body_html,
    body_text:        row.body_text,
    variables_schema: schema,
    version_number:   Number(row.version_number),
    published:        Number(row.published) === 1,
    created_at:       Number(row.created_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  async function _getTemplateRow(slug) {
    var r = await query(
      "SELECT * FROM email_templates WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  // Read the published version row at `locale`; if none, fall back
  // to `en`; if still none, return null. The renderer surfaces a
  // structured `EMAIL_TEMPLATE_NOT_FOUND` so an operator missing a
  // locale on the canonical English template can spot the gap.
  async function _getPublishedVersionRow(slug, locale) {
    var primary = await query(
      "SELECT * FROM email_template_versions " +
      "WHERE template_slug = ?1 AND locale = ?2 AND published = 1 LIMIT 1",
      [slug, locale],
    );
    if (primary.rows[0]) return { row: primary.rows[0], locale_used: locale };
    if (locale === DEFAULT_LOCALE) return null;
    var fallback = await query(
      "SELECT * FROM email_template_versions " +
      "WHERE template_slug = ?1 AND locale = ?2 AND published = 1 LIMIT 1",
      [slug, DEFAULT_LOCALE],
    );
    if (fallback.rows[0]) return { row: fallback.rows[0], locale_used: DEFAULT_LOCALE };
    return null;
  }

  async function _maxVersionNumber(slug, locale) {
    var r = await query(
      "SELECT MAX(version_number) AS mx FROM email_template_versions " +
      "WHERE template_slug = ?1 AND locale = ?2",
      [slug, locale],
    );
    var mx = r.rows[0] && r.rows[0].mx;
    return mx == null ? 0 : Number(mx);
  }

  return {
    KINDS:           KINDS,
    DEFAULT_LOCALE:  DEFAULT_LOCALE,

    // Define a template + append a new version row at the
    // requested locale. The first call for a slug creates the
    // `email_templates` row in addition to v1; subsequent calls
    // append v2 / v3 / etc. Versions are NOT auto-published —
    // operators preview a render, then call `publishVersion`.
    defineTemplate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailTemplates.defineTemplate: input object required");
      }
      var slug      = _validateSlug(input.slug, "slug");
      var title     = _validateTitle(input.title);
      var kind      = _validateKind(input.kind);
      var subject   = _validateSubject(input.subject);
      var bodyHtml  = _validateBody(input.body_html, "body_html");
      var bodyText  = _validateBody(input.body_text, "body_text");
      var schema    = _validateVariablesSchema(input.variables_schema);
      var locale    = _validateLocale(input.locale != null ? input.locale : DEFAULT_LOCALE);
      _validateTemplateBodyVsSchema([subject, bodyHtml, bodyText], schema);

      var now = input.now == null ? _now() : input.now;
      if (typeof now !== "number" || !Number.isInteger(now) || now < 0) {
        throw new TypeError("emailTemplates.defineTemplate: now must be a non-negative integer epoch-ms");
      }

      var existing = await _getTemplateRow(slug);
      if (existing && existing.archived_at != null) {
        throw new TypeError(
          "emailTemplates.defineTemplate: template '" + slug +
          "' is archived — pick a fresh slug or restore the row"
        );
      }
      if (!existing) {
        await query(
          "INSERT INTO email_templates (slug, title, kind, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
          [slug, title, kind, now],
        );
      } else {
        if (existing.kind !== kind) {
          throw new TypeError(
            "emailTemplates.defineTemplate: template '" + slug +
            "' is kind '" + existing.kind + "' — cannot redefine as '" + kind + "'"
          );
        }
        await query(
          "UPDATE email_templates SET title = ?1, updated_at = ?2 WHERE slug = ?3",
          [title, now, slug],
        );
      }

      var versionNumber = (await _maxVersionNumber(slug, locale)) + 1;
      var id = _b().uuid.v7();
      await query(
        "INSERT INTO email_template_versions " +
        "(id, template_slug, locale, subject, body_html, body_text, " +
        "variables_schema_json, version_number, published, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
        [id, slug, locale, subject, bodyHtml, bodyText, JSON.stringify(schema), versionNumber, now],
      );

      return {
        template: _rowToTemplate(await _getTemplateRow(slug)),
        version:  _rowToVersion((await query(
          "SELECT * FROM email_template_versions WHERE id = ?1 LIMIT 1",
          [id],
        )).rows[0]),
      };
    },

    // Read the published version for (slug, locale), with `en`
    // fallback. Returns `null` when the slug doesn't exist or has
    // no published version at either locale.
    getTemplate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailTemplates.getTemplate: input object required");
      }
      var slug   = _validateSlug(input.slug, "slug");
      var locale = _validateLocale(input.locale != null ? input.locale : DEFAULT_LOCALE);
      var t = await _getTemplateRow(slug);
      if (!t || t.archived_at != null) return null;
      var hit = await _getPublishedVersionRow(slug, locale);
      if (!hit) return null;
      return {
        template:    _rowToTemplate(t),
        version:     _rowToVersion(hit.row),
        locale_used: hit.locale_used,
      };
    },

    // List templates with optional `kind` filter + active-only
    // toggle. The default surfaces every non-archived template so
    // the operator dashboard shows the catalog without a separate
    // archive panel.
    listTemplates: async function (listOpts) {
      listOpts = listOpts || {};
      var kind = null;
      if (listOpts.kind != null) kind = _validateKind(listOpts.kind);
      var activeOnly = listOpts.active_only !== false;   // default true
      var limit = listOpts.limit == null ? MAX_LIST_LIMIT : Number(listOpts.limit);
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("emailTemplates.listTemplates: limit must be 1..." + MAX_LIST_LIMIT);
      }

      var sql = "SELECT * FROM email_templates";
      var params = [];
      var clauses = [];
      if (kind) {
        clauses.push("kind = ?" + (params.length + 1));
        params.push(kind);
      }
      if (activeOnly) {
        clauses.push("archived_at IS NULL");
      }
      if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
      sql += " ORDER BY created_at DESC, slug ASC LIMIT ?" + (params.length + 1);
      params.push(limit);
      var rows = (await query(sql, params)).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_rowToTemplate(rows[i]));
      return out;
    },

    // Patch the template-level row (`title` only — the body lives
    // on versions). Refuses unknown patch keys so a caller can't
    // accidentally route a body update through here and bypass the
    // version-history discipline.
    updateTemplate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailTemplates.updateTemplate: input object required");
      }
      var slug = _validateSlug(input.slug, "slug");
      var patch = input.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("emailTemplates.updateTemplate: patch must be an object");
      }
      var allowed = { title: true };
      var keys = Object.keys(patch);
      for (var i = 0; i < keys.length; i += 1) {
        if (!allowed[keys[i]]) {
          throw new TypeError(
            "emailTemplates.updateTemplate: patch key '" + keys[i] +
            "' is not patchable — body edits go through defineTemplate (new version)"
          );
        }
      }
      var row = await _getTemplateRow(slug);
      if (!row) {
        throw new TypeError("emailTemplates.updateTemplate: template '" + slug + "' not found");
      }
      if (row.archived_at != null) {
        throw new TypeError("emailTemplates.updateTemplate: template '" + slug + "' is archived");
      }
      var now = input.now == null ? _now() : input.now;
      if (typeof now !== "number" || !Number.isInteger(now) || now < 0) {
        throw new TypeError("emailTemplates.updateTemplate: now must be a non-negative integer epoch-ms");
      }
      if (patch.title != null) {
        var title = _validateTitle(patch.title);
        await query(
          "UPDATE email_templates SET title = ?1, updated_at = ?2 WHERE slug = ?3",
          [title, now, slug],
        );
      }
      return _rowToTemplate(await _getTemplateRow(slug));
    },

    // Flip a version to `published = 1` for (slug, locale). The
    // prior published row drops to 0 in the same statement pair
    // so the renderer never reads two active rows for one (slug,
    // locale). When no `version_id` is supplied, publishes the
    // most recently created version at that locale.
    publishVersion: async function (slug, publishOpts) {
      _validateSlug(slug, "slug");
      publishOpts = publishOpts || {};
      var locale = _validateLocale(publishOpts.locale != null ? publishOpts.locale : DEFAULT_LOCALE);

      var t = await _getTemplateRow(slug);
      if (!t) {
        throw new TypeError("emailTemplates.publishVersion: template '" + slug + "' not found");
      }
      if (t.archived_at != null) {
        throw new TypeError("emailTemplates.publishVersion: template '" + slug + "' is archived");
      }

      var targetRow;
      if (publishOpts.version_id != null) {
        var got = await query(
          "SELECT * FROM email_template_versions WHERE id = ?1 AND template_slug = ?2 AND locale = ?3 LIMIT 1",
          [publishOpts.version_id, slug, locale],
        );
        targetRow = got.rows[0];
        if (!targetRow) {
          throw new TypeError(
            "emailTemplates.publishVersion: version_id '" + publishOpts.version_id +
            "' not found for (" + slug + ", " + locale + ")"
          );
        }
      } else {
        var latest = await query(
          "SELECT * FROM email_template_versions " +
          "WHERE template_slug = ?1 AND locale = ?2 " +
          "ORDER BY version_number DESC LIMIT 1",
          [slug, locale],
        );
        targetRow = latest.rows[0];
        if (!targetRow) {
          throw new TypeError(
            "emailTemplates.publishVersion: no versions exist for (" + slug + ", " + locale + ")"
          );
        }
      }

      // Demote the currently-published row (if any) for this
      // (slug, locale) — the renderer's invariant is one published
      // row per (slug, locale).
      await query(
        "UPDATE email_template_versions SET published = 0 " +
        "WHERE template_slug = ?1 AND locale = ?2 AND published = 1 AND id <> ?3",
        [slug, locale, targetRow.id],
      );
      await query(
        "UPDATE email_template_versions SET published = 1 WHERE id = ?1",
        [targetRow.id],
      );
      var now = publishOpts.now == null ? _now() : publishOpts.now;
      if (typeof now !== "number" || !Number.isInteger(now) || now < 0) {
        throw new TypeError("emailTemplates.publishVersion: now must be a non-negative integer epoch-ms");
      }
      await query(
        "UPDATE email_templates SET updated_at = ?1 WHERE slug = ?2",
        [now, slug],
      );

      var post = await query(
        "SELECT * FROM email_template_versions WHERE id = ?1 LIMIT 1",
        [targetRow.id],
      );
      return _rowToVersion(post.rows[0]);
    },

    // Soft-delete. The row stays so the audit ledger that points
    // at the slug still resolves; every published version goes
    // inactive (`getTemplate` returns null for an archived
    // template).
    archiveTemplate: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getTemplateRow(slug);
      if (!row) {
        throw new TypeError("emailTemplates.archiveTemplate: template '" + slug + "' not found");
      }
      if (row.archived_at != null) {
        // Idempotent — re-archiving is a no-op so a retry path
        // doesn't double-flip the row's timestamp.
        return _rowToTemplate(row);
      }
      var now = _now();
      await query(
        "UPDATE email_templates SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [now, slug],
      );
      // Also drop the published flag everywhere — an archived
      // template should render via `getTemplate` as "not found".
      await query(
        "UPDATE email_template_versions SET published = 0 WHERE template_slug = ?1",
        [slug],
      );
      return _rowToTemplate(await _getTemplateRow(slug));
    },

    // Render the active version's subject + html + text against
    // the supplied variables. The locale fallback + schema check +
    // HTML-escape + raw-slot vouch all run before the return.
    renderTemplate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailTemplates.renderTemplate: input object required");
      }
      var slug      = _validateSlug(input.slug, "slug");
      var locale    = _validateLocale(input.locale != null ? input.locale : DEFAULT_LOCALE);
      var variables = input.variables == null ? {} : input.variables;
      if (typeof variables !== "object" || Array.isArray(variables)) {
        throw new TypeError("emailTemplates.renderTemplate: variables must be an object");
      }

      var t = await _getTemplateRow(slug);
      if (!t || t.archived_at != null) {
        var notFound = new Error(
          "emailTemplates.renderTemplate: template '" + slug + "' not found"
        );
        notFound.code = "EMAIL_TEMPLATE_NOT_FOUND";
        throw notFound;
      }
      var hit = await _getPublishedVersionRow(slug, locale);
      if (!hit) {
        var noVer = new Error(
          "emailTemplates.renderTemplate: no published version for ('" +
          slug + "', '" + locale + "') or fallback '" + DEFAULT_LOCALE + "'"
        );
        noVer.code = "EMAIL_TEMPLATE_NOT_FOUND";
        throw noVer;
      }
      var v = _rowToVersion(hit.row);
      _validateRenderVariables(v.variables_schema, variables);

      var rendered = _renderAll({
        subject:   v.subject,
        body_html: v.body_html,
        body_text: v.body_text,
        _schema:   v.variables_schema,
      }, variables);
      return {
        subject:        rendered.subject,
        body_html:      rendered.body_html,
        body_text:      rendered.body_text,
        version_id:     v.id,
        version_number: v.version_number,
        locale_used:    hit.locale_used,
      };
    },

    // Page through every version for (slug, locale), newest first.
    // Operators audit the body history through this surface; the
    // version_number is the stable handle for `publishVersion`.
    versionsFor: async function (slug, locale) {
      _validateSlug(slug, "slug");
      var loc = _validateLocale(locale != null ? locale : DEFAULT_LOCALE);
      var rows = (await query(
        "SELECT * FROM email_template_versions " +
        "WHERE template_slug = ?1 AND locale = ?2 " +
        "ORDER BY version_number DESC",
        [slug, loc],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_rowToVersion(rows[i]));
      return out;
    },

    // Standalone schema-vs-variables check. Useful as a preview
    // gate in the operator dashboard before they commit a render.
    validateVariables: function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailTemplates.validateVariables: input object required");
      }
      var schema = _validateVariablesSchema(input.schema);
      _validateRenderVariables(schema, input.variables == null ? {} : input.variables);
      return { ok: true };
    },
  };
}

module.exports = {
  create:         create,
  KINDS:          KINDS,
  DEFAULT_LOCALE: DEFAULT_LOCALE,
};
