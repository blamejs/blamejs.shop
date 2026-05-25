"use strict";
/**
 * @module shop.storefrontForms
 * @title  Storefront forms — operator-defined contact / lead-capture
 *
 * @intro
 *   Operator-defined contact / lead-capture / "request a quote" /
 *   "wholesale application" forms. The operator declares the field
 *   shape + a submit destination; customers submit values; the
 *   primitive validates each field against its declared kind,
 *   refuses missing required fields, and dispatches the captured
 *   values through the injected `notifications` (email) or
 *   `webhooks` (webhook) dep.
 *
 *   Each form carries:
 *     - a stable URL-friendly `slug` (the PK + the storefront route
 *       fragment under `/forms/<slug>`),
 *     - a `title` shown in the page header,
 *     - an optional `description` (one paragraph of operator copy),
 *     - a `fields` array — each `{ name, kind, required, label,
 *       options? }` — drawing `kind` from a closed enum
 *       (`text / email / phone / textarea / select / checkbox /
 *       number`),
 *     - a `submit_to` target `{ kind, value }` — `kind` is `email`
 *       or `webhook`, `value` is the recipient address or the
 *       webhook event name,
 *     - a `success_message` rendered after a successful submit,
 *     - an optional `throttle_per_minute_per_session` rate limit
 *       (defaults to 5; 0 disables the throttle).
 *
 *   Field-validation surface (per-kind):
 *     text       — non-empty string ≤ 1024 chars, no control bytes
 *     email      — `b.guardEmail.validate(..., profile: "strict")`
 *     phone      — digits / spaces / dashes / `+` / `(` / `)`,
 *                  ≤ 32 chars
 *     textarea   — non-empty string ≤ 8192 chars, LF allowed,
 *                  no NUL / DEL
 *     select     — string that appears verbatim in the field's
 *                  declared `options` list
 *     checkbox   — strict boolean (`true` / `false`)
 *     number     — finite number (integer or decimal); rejects
 *                  NaN / Infinity / non-numeric strings
 *
 *   Throttle behavior — `throttleCheck(...)` counts rows in
 *   `storefront_form_submissions` over the last 60s for the same
 *   `(form_slug, session_id_hash)` tuple. `submit(...)` calls
 *   `throttleCheck(...)` before persisting; over-limit submits are
 *   refused with `{ ok: false, error: "throttled" }` and no row is
 *   written.
 *
 *   Session-id privacy — the raw session id never lands in the
 *   table. The primitive hashes it through
 *   `b.crypto.namespaceHash("storefront-form-session", ...)` before
 *   it reaches `session_id_hash`, so a DB compromise can't unmask
 *   visitor session ids. Callers that already pre-hashed the
 *   session id can pass `session_id_hash` directly instead of
 *   `session_id` (the throttle window still works either way).
 *
 *   Dispatch — `submit(...)` validates first, persists the
 *   submission row, THEN dispatches. A dispatch failure is recorded
 *   in `dispatch_error` on the submission row (drop-silent — the
 *   submission still landed; the operator reviews failed-dispatch
 *   rows offline). If no dispatch dep is injected, the row is
 *   written with `dispatched_at = NULL` and the call returns
 *   `{ ok: true, id, dispatched: false }`.
 *
 *   Composes:
 *     - `b.guardEmail.validate`   — email field validation
 *     - `b.crypto.namespaceHash`  — session-id hashing
 *     - `b.uuid.v7`               — submission row ids
 *
 * @primitive storefrontForms
 * @related   notifications, webhooks, b.guardEmail, b.crypto
 */

var MAX_SLUG_LEN              = 80;
var MAX_TITLE_LEN              = 200;
var MAX_DESCRIPTION_LEN        = 2000;
var MAX_FIELD_NAME_LEN         = 64;
var MAX_FIELD_LABEL_LEN        = 200;
var MAX_FIELDS                 = 32;
var MAX_OPTIONS_PER_FIELD      = 64;
var MAX_OPTION_LEN             = 200;
var MAX_SUBMIT_TO_VALUE_LEN    = 320;
var MAX_SUCCESS_MESSAGE_LEN    = 1000;
var MAX_TEXT_VALUE_LEN         = 1024;
var MAX_TEXTAREA_VALUE_LEN     = 8192;
var MAX_PHONE_VALUE_LEN        = 32;
var MAX_LIST_LIMIT             = 200;
var DEFAULT_LIST_LIMIT         = 50;
var DEFAULT_THROTTLE_LIMIT     = 5;
var MAX_THROTTLE_LIMIT         = 1000;
var THROTTLE_WINDOW_MS         = _b().constants.TIME.minutes(1);

var SESSION_NAMESPACE = "storefront-form-session";

var FIELD_KINDS = Object.freeze([
  "text",
  "email",
  "phone",
  "textarea",
  "select",
  "checkbox",
  "number",
]);

var SUBMIT_TO_KINDS = Object.freeze([
  "email",
  "webhook",
]);

var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "title",
  "description",
  "fields",
  "submit_to",
  "success_message",
  "throttle_per_minute_per_session",
]);

// Slug shape mirrors the rest of the storefront primitives — alnum
// leading char, alnum + dot + hyphen + underscore tail.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Field name shape — operator-authored identifier reused as the key
// in the submitted `values` object. Tight ASCII shape so a
// surprising character can't smuggle a JSON-pointer / SQL-fragment
// shape through the submission row.
var FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

// Phone validator — digits / spaces / dashes / plus / parens. Loose
// on purpose; the operator's downstream CRM normalizes to E.164,
// the primitive just refuses obvious garbage.
var PHONE_VALUE_RE = /^[0-9+()\-\s]{1,32}$/;

// Webhook event name shape — `domain.action[.qualifier]` segments.
// Mirrors the webhook-subscriptions event-name shape so an operator
// can route a form submission through the same dispatch pipeline as
// any other event.
var WEBHOOK_EVENT_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

// Refuse C0 control bytes + DEL in single-line strings. Textarea
// values permit LF (the customer's free-text response is line-
// oriented).
var CONTROL_BYTE_LINE_RE  = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_BLOCK_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Zero-width / direction-override family. Spelled with \u-escapes
// so ESLint's no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("storefrontForms: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _line(s, label, maxLen, optional) {
  if (s == null) {
    if (optional) return null;
    throw new TypeError("storefrontForms: " + label + " is required");
  }
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("storefrontForms: " + label + " must be a non-empty string ≤ " + maxLen + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("storefrontForms: " + label + " contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("storefrontForms: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _description(s) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > MAX_DESCRIPTION_LEN) {
    throw new TypeError("storefrontForms: description must be a string ≤ " + MAX_DESCRIPTION_LEN + " chars");
  }
  if (CONTROL_BYTE_BLOCK_RE.test(s)) {
    throw new TypeError("storefrontForms: description contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("storefrontForms: description contains zero-width / direction-override characters");
  }
  return s;
}

function _fieldName(s) {
  if (typeof s !== "string" || !FIELD_NAME_RE.test(s)) {
    throw new TypeError("storefrontForms: field name must match /^[a-z][a-z0-9_]*$/ (≤ " + MAX_FIELD_NAME_LEN + " chars)");
  }
  return s;
}

function _fieldKind(s) {
  if (typeof s !== "string" || FIELD_KINDS.indexOf(s) === -1) {
    throw new TypeError("storefrontForms: field kind must be one of " + JSON.stringify(FIELD_KINDS));
  }
  return s;
}

function _fields(input) {
  if (!Array.isArray(input) || !input.length) {
    throw new TypeError("storefrontForms: fields must be a non-empty array");
  }
  if (input.length > MAX_FIELDS) {
    throw new TypeError("storefrontForms: fields must contain ≤ " + MAX_FIELDS + " entries");
  }
  var seenNames = {};
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    var f = input[i];
    if (!f || typeof f !== "object") {
      throw new TypeError("storefrontForms: fields[" + i + "] must be an object");
    }
    var name = _fieldName(f.name);
    if (Object.prototype.hasOwnProperty.call(seenNames, name)) {
      throw new TypeError("storefrontForms: duplicate field name " + JSON.stringify(name));
    }
    seenNames[name] = true;
    var kind = _fieldKind(f.kind);
    if (typeof f.required !== "boolean") {
      throw new TypeError("storefrontForms: fields[" + i + "].required must be a boolean");
    }
    var label = _line(f.label, "fields[" + i + "].label", MAX_FIELD_LABEL_LEN);
    var options = null;
    if (kind === "select") {
      if (!Array.isArray(f.options) || !f.options.length) {
        throw new TypeError("storefrontForms: fields[" + i + "] (select) must declare a non-empty options array");
      }
      if (f.options.length > MAX_OPTIONS_PER_FIELD) {
        throw new TypeError("storefrontForms: fields[" + i + "] (select) options must contain ≤ " + MAX_OPTIONS_PER_FIELD + " entries");
      }
      var seenOpts = {};
      options = [];
      for (var j = 0; j < f.options.length; j += 1) {
        var opt = f.options[j];
        if (typeof opt !== "string" || !opt.length || opt.length > MAX_OPTION_LEN) {
          throw new TypeError("storefrontForms: fields[" + i + "].options[" + j + "] must be a non-empty string ≤ " + MAX_OPTION_LEN + " chars");
        }
        if (CONTROL_BYTE_LINE_RE.test(opt) || ZERO_WIDTH_RE.test(opt)) {
          throw new TypeError("storefrontForms: fields[" + i + "].options[" + j + "] contains control / zero-width characters");
        }
        if (Object.prototype.hasOwnProperty.call(seenOpts, opt)) {
          throw new TypeError("storefrontForms: fields[" + i + "].options has duplicate " + JSON.stringify(opt));
        }
        seenOpts[opt] = true;
        options.push(opt);
      }
    } else if (f.options != null) {
      throw new TypeError("storefrontForms: fields[" + i + "].options only valid on kind=select");
    }
    var entry = { name: name, kind: kind, required: f.required, label: label };
    if (options) entry.options = options;
    out.push(entry);
  }
  return out;
}

function _submitTo(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("storefrontForms: submit_to must be an object { kind, value }");
  }
  if (typeof input.kind !== "string" || SUBMIT_TO_KINDS.indexOf(input.kind) === -1) {
    throw new TypeError("storefrontForms: submit_to.kind must be one of " + JSON.stringify(SUBMIT_TO_KINDS));
  }
  if (typeof input.value !== "string" || !input.value.length || input.value.length > MAX_SUBMIT_TO_VALUE_LEN) {
    throw new TypeError("storefrontForms: submit_to.value must be a non-empty string ≤ " + MAX_SUBMIT_TO_VALUE_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(input.value) || ZERO_WIDTH_RE.test(input.value)) {
    throw new TypeError("storefrontForms: submit_to.value contains control / zero-width characters");
  }
  if (input.kind === "email") {
    var v = _b().guardEmail.validate(input.value, { profile: "strict" });
    if (!v.ok) {
      var ruleId = v.issues && v.issues[0] && v.issues[0].ruleId || "shape";
      throw new TypeError("storefrontForms: submit_to.value (email) rejected (" + ruleId + ")");
    }
    return { kind: "email", value: _b().guardEmail.sanitize(input.value, { profile: "strict" }) };
  }
  // webhook
  if (!WEBHOOK_EVENT_RE.test(input.value)) {
    throw new TypeError("storefrontForms: submit_to.value (webhook) must match /^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$/");
  }
  return { kind: "webhook", value: input.value };
}

function _successMessage(s) {
  return _line(s, "success_message", MAX_SUCCESS_MESSAGE_LEN);
}

function _throttle(n) {
  if (n == null) return DEFAULT_THROTTLE_LIMIT;
  if (!Number.isInteger(n) || n < 0 || n > MAX_THROTTLE_LIMIT) {
    throw new TypeError("storefrontForms: throttle_per_minute_per_session must be a non-negative integer ≤ " + MAX_THROTTLE_LIMIT);
  }
  return n;
}

function _listLimit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("storefrontForms: limit must be an integer 1.." + MAX_LIST_LIMIT);
  }
  return n;
}

function _uaClass(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > 64) {
    throw new TypeError("storefrontForms: ua_class must be a non-empty string ≤ 64 chars");
  }
  if (!/^[a-z0-9_-]+$/.test(s)) {
    throw new TypeError("storefrontForms: ua_class must match /^[a-z0-9_-]+$/");
  }
  return s;
}

function _ipHash(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > 256) {
    throw new TypeError("storefrontForms: ip_hash must be a non-empty string ≤ 256 chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("storefrontForms: ip_hash contains control bytes");
  }
  return s;
}

function _now() { return Date.now(); }

// ---- per-field value validator -----------------------------------------
//
// Returns `{ ok: true, value }` on success or `{ ok: false, error }`
// on failure. The caller aggregates the per-field results into a
// single submission outcome so the customer sees every failed field
// at once, not one-at-a-time.

function _validateValue(field, raw) {
  // Missing / empty handling. `undefined`, `null`, and `""` are
  // all "missing"; the required gate fires when missing AND
  // required. Checkbox unchecked maps to `false`, not "missing".
  var isMissing = raw == null || raw === "";
  if (isMissing && field.kind !== "checkbox") {
    if (field.required) return { ok: false, error: "required" };
    return { ok: true, value: null };
  }

  if (field.kind === "text") {
    if (typeof raw !== "string" || raw.length > MAX_TEXT_VALUE_LEN) {
      return { ok: false, error: "text value must be a string ≤ " + MAX_TEXT_VALUE_LEN + " chars" };
    }
    if (CONTROL_BYTE_LINE_RE.test(raw) || ZERO_WIDTH_RE.test(raw)) {
      return { ok: false, error: "text value contains control / zero-width characters" };
    }
    return { ok: true, value: raw };
  }

  if (field.kind === "email") {
    if (typeof raw !== "string" || !raw.length || raw.length > 320) {
      return { ok: false, error: "email value must be a string 1..320 chars" };
    }
    var v = _b().guardEmail.validate(raw, { profile: "strict" });
    if (!v.ok) {
      var ruleId = v.issues && v.issues[0] && v.issues[0].ruleId || "shape";
      return { ok: false, error: "email rejected (" + ruleId + ")" };
    }
    return { ok: true, value: _b().guardEmail.sanitize(raw, { profile: "strict" }) };
  }

  if (field.kind === "phone") {
    if (typeof raw !== "string" || !PHONE_VALUE_RE.test(raw)) {
      return { ok: false, error: "phone value must match /^[0-9+()\\-\\s]{1," + MAX_PHONE_VALUE_LEN + "}$/" };
    }
    return { ok: true, value: raw };
  }

  if (field.kind === "textarea") {
    if (typeof raw !== "string" || !raw.length || raw.length > MAX_TEXTAREA_VALUE_LEN) {
      return { ok: false, error: "textarea value must be a non-empty string ≤ " + MAX_TEXTAREA_VALUE_LEN + " chars" };
    }
    if (CONTROL_BYTE_BLOCK_RE.test(raw) || ZERO_WIDTH_RE.test(raw)) {
      return { ok: false, error: "textarea value contains control / zero-width characters" };
    }
    return { ok: true, value: raw };
  }

  if (field.kind === "select") {
    if (typeof raw !== "string") {
      return { ok: false, error: "select value must be a string drawn from the declared options" };
    }
    if (!field.options || field.options.indexOf(raw) === -1) {
      return { ok: false, error: "select value must be one of " + JSON.stringify(field.options || []) };
    }
    return { ok: true, value: raw };
  }

  if (field.kind === "checkbox") {
    if (raw === true || raw === false) {
      if (field.required && raw === false) return { ok: false, error: "required" };
      return { ok: true, value: raw };
    }
    return { ok: false, error: "checkbox value must be a strict boolean" };
  }

  if (field.kind === "number") {
    var n;
    if (typeof raw === "number") {
      n = raw;
    } else if (typeof raw === "string" && raw.length && raw.length <= 64) {
      // Strict numeric-string shape so something like "1e9999" or
      // "  3" or "" or "0x1f" doesn't slip through. Accept a
      // signed integer or decimal.
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
        return { ok: false, error: "number value must be a finite numeric string" };
      }
      n = Number(raw);
    } else {
      return { ok: false, error: "number value must be a finite number or numeric string" };
    }
    if (!Number.isFinite(n)) {
      return { ok: false, error: "number value must be finite (no NaN / Infinity)" };
    }
    return { ok: true, value: n };
  }

  // Unreachable — _fields() refuses unknown kinds at define time.
  return { ok: false, error: "unsupported field kind " + JSON.stringify(field.kind) };
}

// ---- row hydration ------------------------------------------------------

function _hydrateFormRow(r) {
  if (!r) return null;
  var fields, submitTo;
  try { fields   = JSON.parse(r.fields_json); }
  catch (_e) { fields = []; }
  try { submitTo = JSON.parse(r.submit_to_json); }
  catch (_e2) { submitTo = null; }
  return {
    slug:                            r.slug,
    title:                           r.title,
    description:                     r.description,
    fields:                          fields,
    submit_to:                       submitTo,
    success_message:                 r.success_message,
    throttle_per_minute_per_session: Number(r.throttle_per_minute_per_session),
    archived_at:                     r.archived_at == null ? null : Number(r.archived_at),
    created_at:                      Number(r.created_at),
    updated_at:                      Number(r.updated_at),
  };
}

function _hydrateSubmissionRow(r) {
  if (!r) return null;
  var values;
  try { values = JSON.parse(r.values_json); }
  catch (_e) { values = {}; }
  return {
    id:               r.id,
    form_slug:        r.form_slug,
    values:           values,
    session_id_hash:  r.session_id_hash == null ? null : r.session_id_hash,
    ip_hash:          r.ip_hash         == null ? null : r.ip_hash,
    ua_class:         r.ua_class        == null ? null : r.ua_class,
    dispatched_at:    r.dispatched_at   == null ? null : Number(r.dispatched_at),
    dispatch_error:   r.dispatch_error  == null ? null : r.dispatch_error,
    created_at:       Number(r.created_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional dispatch deps. Both are duck-typed (we only check for
  // the call we make) so a test collector can stand in for the real
  // primitive without implementing the whole surface.
  var notifications = opts.notifications || null;
  var webhooks      = opts.webhooks      || null;

  function _hashSession(sessionId) {
    return _b().crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
  }

  // -- defineForm -------------------------------------------------------

  async function defineForm(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontForms.defineForm: input object required");
    }
    var slug           = _slug(input.slug);
    var title          = _line(input.title, "title", MAX_TITLE_LEN);
    var description    = _description(input.description);
    var fields         = _fields(input.fields);
    var submitTo       = _submitTo(input.submit_to);
    var successMessage = _successMessage(input.success_message);
    var throttle       = _throttle(input.throttle_per_minute_per_session);

    var ts = _now();
    await query(
      "INSERT INTO storefront_forms (slug, title, description, fields_json, submit_to_json, " +
      "success_message, throttle_per_minute_per_session, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
      [slug, title, description, JSON.stringify(fields), JSON.stringify(submitTo), successMessage, throttle, ts],
    );
    return await getForm(slug);
  }

  // -- getForm / listForms ---------------------------------------------

  async function getForm(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM storefront_forms WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateFormRow(r);
  }

  async function listForms() {
    var rows = (await query(
      "SELECT * FROM storefront_forms WHERE archived_at IS NULL " +
      "ORDER BY created_at ASC, slug ASC",
      [],
    )).rows;
    return rows.map(_hydrateFormRow);
  }

  // -- updateForm ------------------------------------------------------

  async function updateForm(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("storefrontForms.updateForm: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("storefrontForms.updateForm: patch must include at least one column");
    }
    var current = await getForm(slug);
    if (!current) {
      throw new TypeError("storefrontForms.updateForm: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_UPDATE_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("storefrontForms.updateForm: unsupported column " + JSON.stringify(col));
      }
      var v;
      if      (col === "title")          { v = _line(patch[col], "title", MAX_TITLE_LEN); sets.push("title = ?" + idx); }
      else if (col === "description")    { v = _description(patch[col]); sets.push("description = ?" + idx); }
      else if (col === "fields")         { v = JSON.stringify(_fields(patch[col])); sets.push("fields_json = ?" + idx); }
      else if (col === "submit_to")      { v = JSON.stringify(_submitTo(patch[col])); sets.push("submit_to_json = ?" + idx); }
      else if (col === "success_message"){ v = _successMessage(patch[col]); sets.push("success_message = ?" + idx); }
      else /* throttle */                { v = _throttle(patch[col]); sets.push("throttle_per_minute_per_session = ?" + idx); }
      params.push(v);
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE storefront_forms SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("storefrontForms.updateForm: slug " + JSON.stringify(slug) + " not found");
    }
    return await getForm(slug);
  }

  // -- archiveForm -----------------------------------------------------

  async function archiveForm(slug) {
    _slug(slug);
    var current = await getForm(slug);
    if (!current) {
      throw new TypeError("storefrontForms.archiveForm: slug " + JSON.stringify(slug) + " not found");
    }
    if (current.archived_at != null) {
      // Already archived — idempotent. Return the current row.
      return current;
    }
    var ts = _now();
    await query(
      "UPDATE storefront_forms SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return await getForm(slug);
  }

  // -- throttleCheck ---------------------------------------------------
  //
  // Counts recent submissions for a (form_slug, session_id_hash) tuple
  // over the last `THROTTLE_WINDOW_MS`. Returns `{ ok: true }` when
  // under the limit, `{ ok: false, error: "throttled", count }` when
  // over. Forms with `throttle_per_minute_per_session = 0` skip the
  // check entirely. A missing session id falls back to "no throttle"
  // because there's no key to bucket the submissions against.

  async function throttleCheck(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontForms.throttleCheck: input object required");
    }
    var slug = _slug(input.form_slug);
    var form = await getForm(slug);
    if (!form) {
      throw new TypeError("storefrontForms.throttleCheck: form " + JSON.stringify(slug) + " not found");
    }
    if (form.throttle_per_minute_per_session === 0) {
      return { ok: true, limit: 0, count: 0 };
    }
    var sessionHash;
    if (input.session_id_hash != null) {
      sessionHash = String(input.session_id_hash);
    } else if (input.session_id != null) {
      sessionHash = _hashSession(String(input.session_id));
    } else {
      // No session key — operator-side caller chose not to bucket.
      // Throttle is effectively disabled for this submission.
      return { ok: true, limit: form.throttle_per_minute_per_session, count: 0 };
    }
    var windowStart = _now() - THROTTLE_WINDOW_MS;
    var r = await query(
      "SELECT COUNT(*) AS n FROM storefront_form_submissions " +
      "WHERE form_slug = ?1 AND session_id_hash = ?2 AND created_at >= ?3",
      [slug, sessionHash, windowStart],
    );
    var count = Number(r.rows[0] && r.rows[0].n || 0);
    if (count >= form.throttle_per_minute_per_session) {
      return { ok: false, error: "throttled", limit: form.throttle_per_minute_per_session, count: count };
    }
    return { ok: true, limit: form.throttle_per_minute_per_session, count: count };
  }

  // -- submit ----------------------------------------------------------

  async function submit(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontForms.submit: input object required");
    }
    var slug = _slug(input.form_slug);
    var form = await getForm(slug);
    if (!form) {
      throw new TypeError("storefrontForms.submit: form " + JSON.stringify(slug) + " not found");
    }
    if (form.archived_at != null) {
      return { ok: false, error: "archived" };
    }
    if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
      throw new TypeError("storefrontForms.submit: values must be a plain object");
    }

    // Refuse unknown field names so a hostile submitter can't smuggle
    // an arbitrary key into the stored JSON. The set of allowed
    // names is the form's declared fields list.
    var allowed = {};
    for (var ai = 0; ai < form.fields.length; ai += 1) allowed[form.fields[ai].name] = true;
    var inputKeys = Object.keys(input.values);
    for (var ki = 0; ki < inputKeys.length; ki += 1) {
      if (!Object.prototype.hasOwnProperty.call(allowed, inputKeys[ki])) {
        return { ok: false, error: "unknown field " + JSON.stringify(inputKeys[ki]) };
      }
    }

    // Per-field validation. Aggregate every failure so the caller
    // can render all of them at once.
    var cleanedValues = {};
    var fieldErrors = {};
    for (var i = 0; i < form.fields.length; i += 1) {
      var f   = form.fields[i];
      var raw = Object.prototype.hasOwnProperty.call(input.values, f.name) ? input.values[f.name] : null;
      var res = _validateValue(f, raw);
      if (!res.ok) {
        fieldErrors[f.name] = res.error;
        continue;
      }
      if (res.value !== null) cleanedValues[f.name] = res.value;
    }
    var errorNames = Object.keys(fieldErrors);
    if (errorNames.length) {
      return { ok: false, error: "field_validation", field_errors: fieldErrors };
    }

    // Resolve session id hash for throttle bucketing + persistence.
    var sessionHash = null;
    if (input.session_id_hash != null) {
      sessionHash = String(input.session_id_hash);
    } else if (input.session_id != null) {
      sessionHash = _hashSession(String(input.session_id));
    }

    // Throttle check — only enforced when both a session key + a
    // non-zero per-form limit exist.
    if (sessionHash && form.throttle_per_minute_per_session > 0) {
      var windowStart = _now() - THROTTLE_WINDOW_MS;
      var rt = await query(
        "SELECT COUNT(*) AS n FROM storefront_form_submissions " +
        "WHERE form_slug = ?1 AND session_id_hash = ?2 AND created_at >= ?3",
        [slug, sessionHash, windowStart],
      );
      var count = Number(rt.rows[0] && rt.rows[0].n || 0);
      if (count >= form.throttle_per_minute_per_session) {
        return { ok: false, error: "throttled", limit: form.throttle_per_minute_per_session, count: count };
      }
    }

    var ipHash  = _ipHash(input.ip_hash == null ? null : input.ip_hash);
    var uaClass = _uaClass(input.ua_class == null ? null : input.ua_class);

    // Persist FIRST so a dispatch failure can't lose the submission.
    // The dispatch outcome (success/failure) is stamped via UPDATE
    // after the dep call returns.
    var id = _b().uuid.v7();
    var now = _now();
    await query(
      "INSERT INTO storefront_form_submissions " +
      "(id, form_slug, values_json, session_id_hash, ip_hash, ua_class, dispatched_at, dispatch_error, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7)",
      [id, slug, JSON.stringify(cleanedValues), sessionHash, ipHash, uaClass, now],
    );

    // Dispatch via the matching injected dep. Both branches stamp
    // `dispatched_at` on success or `dispatch_error` on failure. A
    // missing dep means the submission lands but stays
    // un-dispatched — operator review surfaces the row with
    // `dispatched_at IS NULL`.
    var dispatched = false;
    var dispatchError = null;
    var target = form.submit_to;
    try {
      if (target.kind === "email" && notifications && typeof notifications.enqueue === "function") {
        var enq = await notifications.enqueue({
          recipient_id: target.value,
          channel:      "email",
          event_type:   "storefront.form_submission",
          title:        form.title,
          body:         "Form " + form.slug + " received a new submission.",
          payload:      { form_slug: form.slug, submission_id: id, values: cleanedValues },
        });
        if (enq && enq.ok === false) {
          dispatchError = "notifications: " + (enq.error || "rejected");
        } else {
          dispatched = true;
        }
      } else if (target.kind === "webhook" && webhooks && typeof webhooks.send === "function") {
        await webhooks.send(target.value, {
          form_slug:     form.slug,
          submission_id: id,
          values:        cleanedValues,
          occurred_at:   now,
        });
        dispatched = true;
      }
    } catch (e) {
      dispatchError = String((e && e.message) || e).slice(0, 1024);
    }

    if (dispatched) {
      await query(
        "UPDATE storefront_form_submissions SET dispatched_at = ?1 WHERE id = ?2",
        [_now(), id],
      );
    } else if (dispatchError) {
      await query(
        "UPDATE storefront_form_submissions SET dispatch_error = ?1 WHERE id = ?2",
        [dispatchError, id],
      );
    }

    return {
      ok:               true,
      id:               id,
      dispatched:       dispatched,
      dispatch_error:   dispatchError,
      success_message:  form.success_message,
    };
  }

  // -- submissionsForForm ---------------------------------------------

  async function submissionsForForm(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontForms.submissionsForForm: input object required");
    }
    var slug  = _slug(input.form_slug);
    var limit = _listLimit(input.limit);
    var rows;
    if (input.cursor != null) {
      if (typeof input.cursor !== "string" || !input.cursor.length || input.cursor.length > 256) {
        throw new TypeError("storefrontForms.submissionsForForm: cursor must be a non-empty string ≤ 256 chars");
      }
      // The cursor is a `<created_at>:<id>` pair encoded by the
      // previous call. The encoding is the simplest stable form
      // that lets the next page resume at the strict (<,<=)
      // boundary without an HMAC step — the cursor surface is
      // operator-internal and the tuple-comparison is total
      // (created_at DESC, id DESC).
      var sep = input.cursor.indexOf(":");
      if (sep <= 0) {
        throw new TypeError("storefrontForms.submissionsForForm: cursor malformed");
      }
      var cAt = Number(input.cursor.slice(0, sep));
      var cId = input.cursor.slice(sep + 1);
      if (!Number.isFinite(cAt)) {
        throw new TypeError("storefrontForms.submissionsForForm: cursor malformed");
      }
      rows = (await query(
        "SELECT * FROM storefront_form_submissions " +
        "WHERE form_slug = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) " +
        "ORDER BY created_at DESC, id DESC LIMIT ?4",
        [slug, cAt, cId, limit],
      )).rows;
    } else {
      rows = (await query(
        "SELECT * FROM storefront_form_submissions WHERE form_slug = ?1 " +
        "ORDER BY created_at DESC, id DESC LIMIT ?2",
        [slug, limit],
      )).rows;
    }
    var items = rows.map(_hydrateSubmissionRow);
    var next  = null;
    if (items.length === limit) {
      var last = items[items.length - 1];
      next = last.created_at + ":" + last.id;
    }
    return { items: items, next_cursor: next };
  }

  return {
    SESSION_NAMESPACE:    SESSION_NAMESPACE,
    FIELD_KINDS:          FIELD_KINDS,
    SUBMIT_TO_KINDS:      SUBMIT_TO_KINDS,
    THROTTLE_WINDOW_MS:   THROTTLE_WINDOW_MS,

    hashSession:        function (sessionId) {
      if (typeof sessionId !== "string" || !sessionId.length) {
        throw new TypeError("storefrontForms.hashSession: sessionId must be a non-empty string");
      }
      return _hashSession(sessionId);
    },

    defineForm:         defineForm,
    getForm:            getForm,
    listForms:          listForms,
    updateForm:         updateForm,
    archiveForm:        archiveForm,
    submit:             submit,
    submissionsForForm: submissionsForForm,
    throttleCheck:      throttleCheck,
  };
}

module.exports = {
  create:               create,
  SESSION_NAMESPACE:    SESSION_NAMESPACE,
  FIELD_KINDS:          FIELD_KINDS,
  SUBMIT_TO_KINDS:      SUBMIT_TO_KINDS,
  THROTTLE_WINDOW_MS:   THROTTLE_WINDOW_MS,
};
