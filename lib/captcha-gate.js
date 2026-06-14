"use strict";
/**
 * @module shop.captchaGate
 * @title  CAPTCHA gate — provider registry + token verification at
 *         high-risk entry points
 *
 * @intro
 *   Bot pressure on the storefront concentrates on a small set of
 *   entry points: signup (account-creation abuse, coupon scraping),
 *   password reset (account takeover prep), checkout-with-coupon
 *   (carding + coupon-mining), contact form (spam). The CAPTCHA gate
 *   is the primitive operators wire into each of those flows: a
 *   provider is registered once (Cloudflare Turnstile, hCaptcha,
 *   reCAPTCHA v2, or reCAPTCHA v3), the buyer-submitted token is
 *   handed to `verifyToken`, and the outcome is recorded for the
 *   provider's audit log.
 *
 *   The shape:
 *
 *     var cg = bShop.captchaGate.create({ query: q });
 *
 *     await cg.registerProvider({
 *       slug:            "turnstile",
 *       kind:            "turnstile",
 *       public_key:      "0x4AAAAAAA...",
 *       secret_key:      "0x4AAAAAAA...secret",
 *       active:          true,
 *     });
 *
 *     // The verify callback is the operator's worker: it talks HTTPS
 *     // to the provider's siteverify endpoint and returns the parsed
 *     // response. The primitive does not perform the HTTP call itself
 *     // — each provider has a different URL + payload + response
 *     // shape, and the application tier already owns the egress
 *     // policy.
 *     var r = await cg.verifyToken({
 *       provider_slug: "turnstile",
 *       token:         submittedToken,
 *       verify: async function (ctx) {
 *         // ctx: { kind, public_key, secret_key, token, action? }
 *         var body = new URLSearchParams({
 *           secret:   ctx.secret_key,
 *           response: ctx.token,
 *         });
 *         var res = await fetch(
 *           "https://challenges.cloudflare.com/turnstile/v0/siteverify",
 *           { method: "POST", body: body },
 *         );
 *         return await res.json();   // { success, score?, action?, ... }
 *       },
 *     });
 *     // r: { ok, score?, action_match, reasons: [] }
 *
 *     await cg.recordOutcome({
 *       provider_slug: "turnstile",
 *       gate:          "signup",
 *       ok:            r.ok,
 *       score:         r.score,
 *       session_id:    sessionId,
 *     });
 *
 *   reCAPTCHA v3 is the only kind that returns a score; for that kind
 *   `threshold_score` (operator-set, in basis points 0..10000 → 0.0..
 *   1.0) is the floor below which the verification fails even when the
 *   provider's own `success` flag is true. Turnstile / hCaptcha /
 *   reCAPTCHA v2 gate on `success` alone.
 *
 *   The action is checked when `verifyToken({ action })` is supplied:
 *   reCAPTCHA v3 stamps each token with the action the page declared
 *   at challenge time; a token submitted from a page that declared a
 *   different action is rejected with `action_mismatch` (a replay-
 *   prevention discipline — a token minted on the contact-form page
 *   cannot be reused against a password-reset submit). Providers that
 *   don't return an action treat the field as unconstrained.
 *
 *   Secret-key handling. The raw secret NEVER lands in storage. The
 *   primitive runs every operator-supplied secret through
 *   `b.crypto.namespaceHash("captcha-secret", secret)` before any
 *   write; the column carries the hash plus the trimmed-whitespace
 *   normalized form so a re-paste with an extra newline doesn't
 *   create a phantom mismatch. The application tier keeps the raw
 *   secret in operator memory (env var, secret-manager) and re-hands
 *   it to `verifyToken({ verify })` via the callback's `secret_key`
 *   field on every call — the primitive only ever reads the
 *   hash to recognise that the registered row matches the supplied
 *   secret, never returns the raw value from the database.
 *
 *   Session / IP hashing. Both are OPTIONAL on `recordOutcome` — the
 *   caller passes already-hashed values (the primitive does NOT do
 *   the hashing itself for these because the operator's PII policy
 *   chooses the hashing scheme). The expected shape is a hex-encoded
 *   SHA3-512 from `b.crypto.namespaceHash`.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — secret-key hashing.
 *
 *   Surface:
 *     - `registerProvider({ slug, kind, public_key, secret_key,
 *                          threshold_score?, active? })`
 *         → the persisted provider (without the secret).
 *     - `verifyToken({ provider_slug, token, action?,
 *                      expected_score?, verify })`
 *         → `{ ok, score?, action_match, reasons: [] }`.
 *     - `recordOutcome({ provider_slug, gate, ok, score?, action?,
 *                        session_id?, ip_hash? })`
 *         → the persisted verification row.
 *     - `metricsForProvider({ slug, from, to })`
 *         → `{ total, passed, failed, pass_rate_bps, score_avg_bps? }`.
 *     - `listProviders({ active_only? })`
 *         → array of provider rows (without the secret).
 *     - `getProvider(slug)`
 *         → single provider row, or null.
 *     - `archiveProvider(slug)`
 *         → soft-delete (sets `archived_at`, flips `active = 0`).
 *     - `updateProvider(slug, patch)`
 *         → mutate `public_key` / `secret_key` / `threshold_score` /
 *           `active` (slug + kind are immutable; create a new
 *           provider for a different kind).
 *     - `gatesForVerification({ slug, from, to, limit, cursor? })`
 *         → keyset-paginated audit walk over verifications for one
 *           provider. Cursor shape `<occurred_at>:<id>`.
 *
 *   Storage:
 *     - `captcha_providers`
 *     - `captcha_verifications`
 *       (migration `0114_captcha_gate.sql`)
 *
 * @primitive captchaGate
 * @related   b.crypto.namespaceHash
 */

var SECRET_HASH_NAMESPACE = "captcha-secret";

var KINDS = Object.freeze([
  "turnstile",
  "hcaptcha",
  "recaptcha_v2",
  "recaptcha_v3",
]);

// Only reCAPTCHA v3 returns a score. The other kinds gate on the
// provider's boolean `success` field; supplying `threshold_score`
// against any kind other than recaptcha_v3 is refused at registration
// time so an operator misconfiguration shows up at boot rather than
// silently letting every Turnstile token through.
var KINDS_WITH_SCORE = Object.freeze(["recaptcha_v3"]);

var GATES = Object.freeze([
  "signup",
  "password_reset",
  "checkout_coupon",
  "contact_form",
  "other",
]);

var SLUG_MAX_LEN          = 64;
var PUBLIC_KEY_MAX_LEN    = 512;
var SECRET_KEY_MAX_LEN    = 1024;
var TOKEN_MAX_LEN         = 4096;
var ACTION_MAX_LEN        = 128;
var HASH_MAX_LEN          = 256;
var SESSION_ID_MAX_LEN    = 1024;
var SCORE_BPS_MAX         = 10000;     // 1.00 in basis points
var DEFAULT_LIST_LIMIT    = 100;
var MAX_LIST_LIMIT        = 500;

var SLUG_RE         = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ACTION_RE       = /^[A-Za-z0-9_./-]+$/;

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "public_key",
  "secret_key",
  "threshold_score",
  "active",
]);

// Framework handle (the vendored blamejs); index.js re-exports this as .framework.
var b = require("./vendor/blamejs");

// ---- validators --------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("captchaGate: slug must be a non-empty string");
  }
  if (s.length > SLUG_MAX_LEN) {
    throw new TypeError("captchaGate: slug must be <= " + SLUG_MAX_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "captchaGate: slug must match /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/"
    );
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError(
      "captchaGate: kind must be one of " + KINDS.join(", ") + ", got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _gate(s) {
  if (typeof s !== "string" || GATES.indexOf(s) === -1) {
    throw new TypeError(
      "captchaGate: gate must be one of " + GATES.join(", ") + ", got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _publicKey(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("captchaGate: public_key must be a non-empty string");
  }
  if (s.length > PUBLIC_KEY_MAX_LEN) {
    throw new TypeError(
      "captchaGate: public_key must be <= " + PUBLIC_KEY_MAX_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("captchaGate: public_key contains control bytes");
  }
  return s;
}

function _secretKeyRaw(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("captchaGate: secret_key must be a non-empty string");
  }
  // Normalize trailing whitespace before length-checking so a paste
  // with a stray newline doesn't trip the length gate.
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("captchaGate: secret_key must contain non-whitespace");
  }
  if (trimmed.length > SECRET_KEY_MAX_LEN) {
    throw new TypeError(
      "captchaGate: secret_key must be <= " + SECRET_KEY_MAX_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(trimmed)) {
    throw new TypeError("captchaGate: secret_key contains control bytes");
  }
  return trimmed;
}

function _hashSecret(normalizedSecret) {
  return b.crypto.namespaceHash(SECRET_HASH_NAMESPACE, normalizedSecret);
}

function _thresholdScore(n, kind) {
  if (n == null) {
    return null;
  }
  if (!Number.isInteger(n) || n < 0 || n > SCORE_BPS_MAX) {
    throw new TypeError(
      "captchaGate: threshold_score must be an integer in [0, " +
      SCORE_BPS_MAX + "] (basis points, 10000 = 1.00)"
    );
  }
  if (KINDS_WITH_SCORE.indexOf(kind) === -1) {
    throw new TypeError(
      "captchaGate: threshold_score is only meaningful for kinds " +
      KINDS_WITH_SCORE.join(", ") + " — got kind " + JSON.stringify(kind)
    );
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("captchaGate: " + label + " must be a boolean");
  }
  return v;
}

function _token(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("captchaGate: token must be a non-empty string");
  }
  if (s.length > TOKEN_MAX_LEN) {
    throw new TypeError(
      "captchaGate: token must be <= " + TOKEN_MAX_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("captchaGate: token contains control bytes");
  }
  return s;
}

function _action(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(
      "captchaGate: action must be a non-empty string when provided"
    );
  }
  if (s.length > ACTION_MAX_LEN) {
    throw new TypeError(
      "captchaGate: action must be <= " + ACTION_MAX_LEN + " characters"
    );
  }
  if (!ACTION_RE.test(s)) {
    throw new TypeError(
      "captchaGate: action must match /^[A-Za-z0-9_./-]+$/"
    );
  }
  return s;
}

function _expectedScore(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0 || n > SCORE_BPS_MAX) {
    throw new TypeError(
      "captchaGate: expected_score must be an integer in [0, " +
      SCORE_BPS_MAX + "] (basis points)"
    );
  }
  return n;
}

function _optionalHash(s, label) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("captchaGate: " + label + " must be a string");
  }
  if (s.length > HASH_MAX_LEN) {
    throw new TypeError(
      "captchaGate: " + label + " must be <= " + HASH_MAX_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError(
      "captchaGate: " + label + " contains control bytes"
    );
  }
  return s;
}

function _optionalSessionId(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("captchaGate: session_id must be a string");
  }
  if (s.length > SESSION_ID_MAX_LEN) {
    throw new TypeError(
      "captchaGate: session_id must be <= " + SESSION_ID_MAX_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("captchaGate: session_id contains control bytes");
  }
  return s;
}

function _hashSession(rawSessionId) {
  return b.crypto.namespaceHash("captcha-session", rawSessionId);
}

function _tsBound(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "captchaGate: " + label + " must be a non-negative integer (ms epoch)"
    );
  }
  return n;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError(
      "captchaGate: " + label + " must be an integer in [1, " +
      MAX_LIST_LIMIT + "]"
    );
  }
  return n;
}

// Monotonically-non-decreasing now() — same discipline as
// sms-dispatcher / order primitives. Two writes in the same
// millisecond would otherwise collide on the (occurred_at, id) keyset
// cursor.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- row hydration -----------------------------------------------------

function _hydrateProvider(row) {
  if (!row) return null;
  return {
    slug:                  row.slug,
    kind:                  row.kind,
    public_key:            row.public_key,
    secret_key_hash:       row.secret_key_hash,
    threshold_score:       row.threshold_score == null
                             ? null : Number(row.threshold_score),
    active:                Number(row.active) === 1,
    archived_at:           row.archived_at == null
                             ? null : Number(row.archived_at),
    created_at:            Number(row.created_at),
    updated_at:            Number(row.updated_at),
  };
}

function _hydrateVerification(row) {
  if (!row) return null;
  return {
    id:               Number(row.id),
    provider_slug:    row.provider_slug,
    gate:             row.gate,
    ok:               Number(row.ok) === 1,
    score:            row.score == null  ? null : Number(row.score),
    action:           row.action == null ? null : row.action,
    session_id_hash:  row.session_id_hash == null ? null : row.session_id_hash,
    ip_hash:          row.ip_hash == null         ? null : row.ip_hash,
    occurred_at:      Number(row.occurred_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getProviderRow(slug) {
    var r = await query(
      "SELECT * FROM captcha_providers WHERE slug = ?1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function getProvider(slug) {
    return _hydrateProvider(await _getProviderRow(_slug(slug)));
  }

  async function registerProvider(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError(
        "captchaGate.registerProvider: input object required"
      );
    }
    var slug      = _slug(input.slug);
    var kind      = _kind(input.kind);
    var publicKey = _publicKey(input.public_key);
    var secret    = _secretKeyRaw(input.secret_key);
    var threshold = _thresholdScore(
      input.threshold_score == null ? null : input.threshold_score,
      kind,
    );
    var active    = input.active == null ? true : _bool(input.active, "active");

    var existing = await _getProviderRow(slug);
    if (existing) {
      throw new TypeError(
        "captchaGate.registerProvider: slug " + JSON.stringify(slug) +
        " already exists — use updateProvider"
      );
    }

    var secretHash = _hashSecret(secret);
    var now        = _now();

    await query(
      "INSERT INTO captcha_providers " +
      "(slug, kind, public_key, secret_key_hash, secret_key_normalized, " +
      " threshold_score, active, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
      [slug, kind, publicKey, secretHash, secret,
       threshold, active ? 1 : 0, now],
    );
    return _hydrateProvider(await _getProviderRow(slug));
  }

  async function listProviders(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      activeOnly = _bool(listOpts.active_only, "active_only");
    }
    var sql, params;
    if (activeOnly) {
      sql    = "SELECT * FROM captcha_providers " +
               "WHERE active = 1 AND archived_at IS NULL " +
               "ORDER BY created_at ASC, slug ASC";
      params = [];
    } else {
      sql    = "SELECT * FROM captcha_providers " +
               "ORDER BY created_at ASC, slug ASC";
      params = [];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      out.push(_hydrateProvider(rows[i]));
    }
    return out;
  }

  async function archiveProvider(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE captcha_providers SET archived_at = ?1, active = 0, " +
      "updated_at = ?1 WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await _getProviderRow(slug);
      if (!existing) {
        throw new TypeError(
          "captchaGate.archiveProvider: slug " + JSON.stringify(slug) +
          " not found"
        );
      }
      // Already archived — idempotent return so a second archive
      // sweep doesn't have to special-case the slug.
      return _hydrateProvider(existing);
    }
    return _hydrateProvider(await _getProviderRow(slug));
  }

  async function updateProvider(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError(
        "captchaGate.updateProvider: patch object required"
      );
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError(
        "captchaGate.updateProvider: patch must include at least one column"
      );
    }
    var current = await _getProviderRow(slug);
    if (!current) {
      throw new TypeError(
        "captchaGate.updateProvider: slug " + JSON.stringify(slug) +
        " not found"
      );
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    var i;

    for (i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError(
          "captchaGate.updateProvider: unsupported column " +
          JSON.stringify(col)
        );
      }
      if (col === "public_key") {
        sets.push("public_key = ?" + idx);
        params.push(_publicKey(patch[col]));
      } else if (col === "secret_key") {
        var sec = _secretKeyRaw(patch[col]);
        sets.push("secret_key_hash = ?" + idx);
        params.push(_hashSecret(sec));
        idx += 1;
        sets.push("secret_key_normalized = ?" + idx);
        params.push(sec);
      } else if (col === "threshold_score") {
        var resolved = _thresholdScore(
          patch[col] == null ? null : patch[col],
          current.kind,
        );
        sets.push("threshold_score = ?" + idx);
        params.push(resolved);
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
      "UPDATE captcha_providers SET " + sets.join(", ") +
      " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError(
        "captchaGate.updateProvider: slug " + JSON.stringify(slug) +
        " not found"
      );
    }
    return _hydrateProvider(await _getProviderRow(slug));
  }

  // verifyToken — local-side decision wrapping the operator's worker
  // callback. The callback talks HTTPS to the provider's siteverify
  // endpoint and returns the parsed response; the primitive computes
  // the local-side `ok` (provider `success` AND score-threshold AND
  // action-equality) and returns `reasons` enumerating every gate
  // that contributed to the decision.
  async function verifyToken(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError(
        "captchaGate.verifyToken: input object required"
      );
    }
    var slug      = _slug(input.provider_slug);
    var token     = _token(input.token);
    var action    = _action(input.action);
    var expScore  = _expectedScore(input.expected_score);
    var verify    = input.verify;
    if (typeof verify !== "function") {
      throw new TypeError(
        "captchaGate.verifyToken: verify must be a function (operator's worker)"
      );
    }

    var row = await _getProviderRow(slug);
    if (!row) {
      throw new TypeError(
        "captchaGate.verifyToken: provider " + JSON.stringify(slug) +
        " not found"
      );
    }
    if (Number(row.active) !== 1 || row.archived_at != null) {
      return {
        ok:           false,
        score:        null,
        action_match: false,
        reasons:      ["provider_inactive"],
      };
    }

    var ctx = {
      kind:       row.kind,
      public_key: row.public_key,
      secret_key: row.secret_key_normalized,
      token:      token,
      action:     action,
    };

    var provResponse;
    try {
      provResponse = await verify(ctx);
    } catch (_e) {
      return {
        ok:           false,
        score:        null,
        action_match: false,
        reasons:      ["verify_callback_threw"],
      };
    }
    if (!provResponse || typeof provResponse !== "object") {
      return {
        ok:           false,
        score:        null,
        action_match: false,
        reasons:      ["verify_callback_returned_non_object"],
      };
    }

    var reasons = [];

    // Provider boolean. Every provider's siteverify response carries a
    // `success` boolean; refusing on anything but `true` is the floor
    // gate the rest of the decision composes on top of.
    var provOk = provResponse.success === true;
    if (!provOk) {
      reasons.push("provider_rejected");
    }

    // Score (reCAPTCHA v3 only). Provider returns 0.0..1.0 as a JSON
    // number; convert to basis points so the audit log column stays
    // integer. Operators register a threshold (in basis points) at the
    // provider; an optional `expected_score` on the call overrides the
    // registered threshold for the single verification (e.g. a higher
    // bar on password reset than on signup).
    var scoreBps = null;
    if (row.kind === "recaptcha_v3") {
      if (typeof provResponse.score === "number" && isFinite(provResponse.score)) {
        // Floor to keep the integer audit column comparable across
        // requests; provider scores are 0.1 granularity in practice.
        scoreBps = Math.max(0, Math.min(SCORE_BPS_MAX, Math.floor(provResponse.score * 10000)));
      }
      var threshold = expScore != null ? expScore
                    : row.threshold_score == null ? null : Number(row.threshold_score);
      if (threshold != null) {
        if (scoreBps == null) {
          reasons.push("score_missing");
        } else if (scoreBps < threshold) {
          reasons.push("score_below_threshold");
        }
      }
    }

    // Action equality. reCAPTCHA v3 stamps each token with the action
    // the page declared; a token submitted from a page that declared a
    // different action is a replay candidate. `action_match` is the
    // boolean the caller surfaces; `reasons` carries the mismatch
    // when the verifyToken caller supplied an expected action.
    var actionMatch = true;
    if (action != null) {
      var provAction = typeof provResponse.action === "string"
        ? provResponse.action : null;
      if (provAction == null || provAction !== action) {
        actionMatch = false;
        reasons.push("action_mismatch");
      }
    }

    var ok = provOk && actionMatch;
    if (ok && reasons.length > 0) {
      // Score-below-threshold pushed an entry into reasons; that
      // collapses ok to false even when provOk + actionMatch held.
      ok = false;
    }
    if (ok) {
      reasons.push("verified");
    }

    return {
      ok:           ok,
      score:        scoreBps,
      action_match: actionMatch,
      reasons:      reasons,
    };
  }

  async function recordOutcome(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError(
        "captchaGate.recordOutcome: input object required"
      );
    }
    var slug    = _slug(input.provider_slug);
    var gate    = _gate(input.gate);
    var ok      = _bool(input.ok, "ok");
    var score   = input.score == null ? null : _expectedScore(input.score);
    var action  = _action(input.action);
    var ipHash  = _optionalHash(input.ip_hash, "ip_hash");

    // session_id is the raw cookie value; primitive runs it through
    // namespaceHash before any storage touch (same discipline as
    // cookie-consent / sms-dispatcher).
    var sessHash = null;
    if (input.session_id != null && input.session_id !== "") {
      var rawSess = _optionalSessionId(input.session_id);
      sessHash = _hashSession(rawSess);
    }

    var prov = await _getProviderRow(slug);
    if (!prov) {
      throw new TypeError(
        "captchaGate.recordOutcome: provider " + JSON.stringify(slug) +
        " not found"
      );
    }

    var now = _now();
    var r = await query(
      "INSERT INTO captcha_verifications " +
      "(provider_slug, gate, ok, score, action, session_id_hash, ip_hash, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [slug, gate, ok ? 1 : 0, score, action, sessHash, ipHash, now],
    );
    var id = r.lastRowId;
    var fetched = await query(
      "SELECT * FROM captcha_verifications WHERE id = ?1",
      [id],
    );
    return _hydrateVerification(fetched.rows[0] || null);
  }

  async function metricsForProvider(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError(
        "captchaGate.metricsForProvider: input object required"
      );
    }
    var slug = _slug(input.slug);
    var from = _tsBound(input.from, "from");
    var to   = _tsBound(input.to, "to");
    if (to <= from) {
      throw new TypeError(
        "captchaGate.metricsForProvider: to must be > from"
      );
    }

    var prov = await _getProviderRow(slug);
    if (!prov) {
      throw new TypeError(
        "captchaGate.metricsForProvider: provider " + JSON.stringify(slug) +
        " not found"
      );
    }

    var r = await query(
      "SELECT ok, score FROM captcha_verifications " +
      "WHERE provider_slug = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
      [slug, from, to],
    );

    var total    = r.rows.length;
    var passed   = 0;
    var failed   = 0;
    var scoreSum = 0;
    var scoreN   = 0;
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      if (Number(row.ok) === 1) passed += 1;
      else                       failed += 1;
      if (row.score != null) {
        scoreSum += Number(row.score);
        scoreN   += 1;
      }
    }
    var passRateBps = total === 0 ? 0
      : Math.floor((passed * 10000) / total);
    var scoreAvgBps = scoreN === 0 ? null
      : Math.floor(scoreSum / scoreN);

    return {
      total:           total,
      passed:          passed,
      failed:          failed,
      pass_rate_bps:   passRateBps,
      score_avg_bps:   scoreAvgBps,
    };
  }

  async function gatesForVerification(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError(
        "captchaGate.gatesForVerification: input object required"
      );
    }
    var slug  = _slug(input.slug);
    var from  = _tsBound(input.from, "from");
    var to    = _tsBound(input.to, "to");
    if (to <= from) {
      throw new TypeError(
        "captchaGate.gatesForVerification: to must be > from"
      );
    }
    var limit = _limit(input.limit, "limit");

    var cursorAt = null;
    var cursorId = null;
    if (input.cursor != null) {
      if (typeof input.cursor !== "string" || input.cursor.indexOf(":") === -1) {
        throw new TypeError(
          "captchaGate.gatesForVerification: cursor must be of the form '<occurred_at>:<id>'"
        );
      }
      var ci = input.cursor.indexOf(":");
      var at = parseInt(input.cursor.slice(0, ci), 10);
      var id = parseInt(input.cursor.slice(ci + 1), 10);
      if (!Number.isInteger(at) || at < 0 ||
          !Number.isInteger(id) || id <= 0) {
        throw new TypeError(
          "captchaGate.gatesForVerification: cursor parses to garbage"
        );
      }
      cursorAt = at;
      cursorId = id;
    }

    var sql, params;
    if (cursorAt == null) {
      sql =
        "SELECT * FROM captcha_verifications " +
        "WHERE provider_slug = ?1 " +
        "  AND occurred_at >= ?2 AND occurred_at < ?3 " +
        "ORDER BY occurred_at DESC, id DESC " +
        "LIMIT ?4";
      params = [slug, from, to, limit + 1];
    } else {
      sql =
        "SELECT * FROM captcha_verifications " +
        "WHERE provider_slug = ?1 " +
        "  AND occurred_at >= ?2 AND occurred_at < ?3 " +
        "  AND (occurred_at < ?4 OR (occurred_at = ?4 AND id < ?5)) " +
        "ORDER BY occurred_at DESC, id DESC " +
        "LIMIT ?6";
      params = [slug, from, to, cursorAt, cursorId, limit + 1];
    }
    var r = await query(sql, params);

    var rows = [];
    var take = Math.min(limit, r.rows.length);
    for (var i = 0; i < take; i += 1) {
      rows.push(_hydrateVerification(r.rows[i]));
    }
    var nextCursor = null;
    if (r.rows.length > limit) {
      var last = rows[rows.length - 1];
      nextCursor = last.occurred_at + ":" + last.id;
    }
    return { rows: rows, next_cursor: nextCursor };
  }

  return {
    // Constants the operator's authoring code consults.
    KINDS:                 KINDS.slice(),
    KINDS_WITH_SCORE:      KINDS_WITH_SCORE.slice(),
    GATES:                 GATES.slice(),
    SECRET_HASH_NAMESPACE: SECRET_HASH_NAMESPACE,
    SCORE_BPS_MAX:         SCORE_BPS_MAX,
    SLUG_MAX_LEN:          SLUG_MAX_LEN,
    DEFAULT_LIST_LIMIT:    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT:        MAX_LIST_LIMIT,

    registerProvider:       registerProvider,
    getProvider:            getProvider,
    listProviders:          listProviders,
    archiveProvider:        archiveProvider,
    updateProvider:         updateProvider,
    verifyToken:            verifyToken,
    recordOutcome:          recordOutcome,
    metricsForProvider:     metricsForProvider,
    gatesForVerification:   gatesForVerification,
  };
}

module.exports = {
  create:                 create,
  KINDS:                  KINDS,
  KINDS_WITH_SCORE:       KINDS_WITH_SCORE,
  GATES:                  GATES,
  SECRET_HASH_NAMESPACE:  SECRET_HASH_NAMESPACE,
  SCORE_BPS_MAX:          SCORE_BPS_MAX,
};
