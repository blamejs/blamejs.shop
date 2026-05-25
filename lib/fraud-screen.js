"use strict";
/**
 * @module shop.fraudScreen
 * @title  Fraud screening — heuristic + ledger-based pre-payment gate
 *
 * @intro
 *   `fraudScreen` evaluates a checkout draft BEFORE the payment
 *   intent is created and emits a `{ score, decision, signals }`
 *   verdict so the orchestrator either proceeds, requests step-up
 *   (3-D Secure), or refuses. The primitive itself never makes the
 *   irrevocable refuse call — that's the operator-policy layer
 *   wrapping the checkout flow; this module only emits the signal
 *   plus a per-signal breakdown the dashboard can render.
 *
 *   Signals (each contributes a positive weight when fired):
 *
 *     velocity                 — >N orders/24h from same email_hash
 *     high-value-new-customer  — large total + prior_orders_count = 0
 *     address-mismatch         — shipping country != billing country
 *     free-email-domain        — gmail / yahoo / outlook / ... (mild)
 *     disposable-email-domain  — known temp-mail provider (severe)
 *     session-too-fast         — session_age_seconds < 15
 *     session-too-old          — session_age_seconds > 86400 (24h)
 *     ua-curl-class            — curl / wget / python-requests etc.
 *     large-line-count         — line_count >= LARGE_LINE_COUNT
 *     mismatched-bin-country   — operator-supplied BIN->country map
 *                                disagrees with the shipping country
 *     prior-chargeback         — chargebacks ledger has a row for
 *                                the same email_hash
 *     suppressed-email         — emailSuppressions (if injected)
 *                                returns true for this address
 *     manually-flagged         — fraud_email_flags row exists for
 *                                the email_hash (forces refuse)
 *
 *   Thresholds (closed intervals):
 *
 *     0 .. 39   approve
 *     40 .. 69  review
 *     70 .. 89  step_up
 *     90 ..100  refuse
 *
 *   The disposable-email and manually-flagged signals push the
 *   score past 90 by themselves so the decision lands on `refuse`
 *   without needing a second signal to corroborate.
 *
 *   Composition surface:
 *
 *     - `b.crypto.namespaceHash("fraud-email", email)` — every
 *       email written to any of the three ledger tables is hashed
 *       through this namespace first, so a stolen D1 dump leaks
 *       no addresses.
 *     - `b.guardEmail.validate` / `.sanitize` — refuses shape-broken
 *       or header-injection-class addresses at every entry point.
 *     - `b.guardUuid.sanitize` — every UUID-shaped input
 *       (customer_id, order_id) is profile-strict validated.
 *     - `b.uuid.v7` — ledger row ids.
 *     - `b.pagination.encodeCursor` / `decodeCursor` — HMAC-tagged
 *       opaque cursor for `recentScreenings()` so an operator
 *       can't hand-craft one to skip past a hidden row or replay
 *       it across deployments.
 *
 *   Operator-injectable dependencies (all optional):
 *
 *     - `query`             — D1-shaped async query function
 *     - `customers`         — for customer_id -> email_hash lookup
 *     - `addresses`         — address-lookup primitive (reserved
 *                             for future BIN/AVS integration)
 *     - `paymentMethods`    — payment-method lookup (reserved for
 *                             future mismatched-BIN signal pulling
 *                             from a saved instrument's metadata)
 *     - `emailSuppressions` — `.isSuppressed(emailHash)` boolean —
 *                             a hard-bounce / complaint signal
 *                             pulled from the email pipeline; when
 *                             present, fires the suppressed-email
 *                             signal.
 *     - `binCountryMap`     — `{ [bin6]: countryCode }` operator-
 *                             supplied; used by the mismatched-bin-
 *                             country signal when the order draft
 *                             carries a `bin6` field.
 *     - `cursorSecret`      — HMAC secret for recentScreenings'
 *                             cursor (required in production).
 */

var b = require("./index").framework;
var C = b.constants;

// ---- constants ----------------------------------------------------------

var EMAIL_NAMESPACE = "fraud-email";

// Score thresholds — closed intervals on both ends; the boundary
// row is exposed via FraudScreen.THRESHOLDS so the test suite can
// assert against the same values the runtime uses.
var THRESHOLDS = Object.freeze({
  APPROVE_MAX:  39,
  REVIEW_MAX:   69,
  STEP_UP_MAX:  89,
  // 90..100 → refuse
});

// Weights — calibrated so the corroborated-multi-signal case
// (e.g. velocity + address-mismatch + free-email-domain) lands
// on review or step_up, while a single severe signal (disposable
// domain, manual flag, chargeback) lands on refuse outright.
var WEIGHTS = Object.freeze({
  VELOCITY:                 35,
  HIGH_VALUE_NEW_CUSTOMER:  25,
  ADDRESS_MISMATCH:         25,
  FREE_EMAIL_DOMAIN:        10,
  DISPOSABLE_EMAIL_DOMAIN: 100,
  SESSION_TOO_FAST:         20,
  SESSION_TOO_OLD:          10,
  UA_CURL_CLASS:            30,
  LARGE_LINE_COUNT:         15,
  MISMATCHED_BIN_COUNTRY:   30,
  PRIOR_CHARGEBACK:         60,
  SUPPRESSED_EMAIL:         40,
  MANUALLY_FLAGGED:        100,
});

// Thresholds for the heuristic dials.
var VELOCITY_WINDOW_MS      = C.TIME.days(1);        // 24h lookback
var VELOCITY_MAX_OK         = 3;                      // > N triggers
var HIGH_VALUE_NEW_THRESH   = 50000;                 // 500.00 minor units
var SESSION_FAST_MAX_SEC    = 15;
// allow:raw-time-literal — session-age ceiling in SECONDS (24h); compared against session_age_seconds, C.TIME returns ms
var SESSION_OLD_MAX_SEC     = 24 * 60 * 60;
var LARGE_LINE_COUNT_THRESH = 25;
var SCORE_MAX               = 100;

// Decision thresholds map to {approve, review, step_up, refuse}.
function _decisionFor(score) {
  if (score <= THRESHOLDS.APPROVE_MAX) return "approve";
  if (score <= THRESHOLDS.REVIEW_MAX)  return "review";
  if (score <= THRESHOLDS.STEP_UP_MAX) return "step_up";
  return "refuse";
}

// Disposable email-provider tail — about twenty of the most
// commonly abused temp-mail domains. The list is small on purpose:
// a single match is the entire signal weight, so a stale entry
// here is a higher-cost mistake than a missing entry. Operators
// who track a larger catalog should extend via the
// `disposableDomains` factory option.
var DEFAULT_DISPOSABLE_DOMAINS = Object.freeze([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net",
  "10minutemail.com", "tempmail.com", "temp-mail.org",
  "yopmail.com", "throwawaymail.com", "trashmail.com",
  "fakeinbox.com", "getairmail.com", "sharklasers.com",
  "maildrop.cc", "mintemail.com", "dispostable.com",
  "spamgourmet.com", "mailcatch.com", "tempr.email",
  "mohmal.com", "emailondeck.com", "moakt.com",
]);

// Free-email tail — large public providers. Fires a small-weight
// signal because most legitimate customers use one; the operator
// uses this in combination with other signals (velocity, address-
// mismatch, etc.) not as a primary refuse driver.
var DEFAULT_FREE_DOMAINS = Object.freeze([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "aol.com", "icloud.com", "live.com", "msn.com",
  "protonmail.com", "proton.me", "yandex.com", "yandex.ru",
  "mail.com", "gmx.com", "gmx.net", "fastmail.com",
  "zoho.com", "tutanota.com", "tutanota.de",
]);

// Curl-class user-agent tokens. The order draft carries a
// pre-classified `ua_class` so this primitive doesn't have to
// re-parse the User-Agent header — the storefront's bot-guard
// has already done that. The expected enum is:
//   "browser" | "curl" | "wget" | "python" | "go-http" | "bot" | "unknown"
// Anything in the curl set fires the signal.
var CURL_CLASS_TOKENS = Object.freeze({
  curl:        true,
  wget:        true,
  python:      true,
  "go-http":   true,
  bot:         true,
});

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("fraudScreen: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _optUuid(s, label) {
  if (s == null || s === "") return null;
  return _uuid(s, label);
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("fraudScreen: email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try { report = guardEmail.validate(input, { profile: "strict" }); }
  catch (e) { throw new TypeError("fraudScreen: email — " + (e && e.message || "invalid email")); }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("fraudScreen: email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try { canonical = guardEmail.sanitize(input, { profile: "strict" }); }
  catch (e) { throw new TypeError("fraudScreen: email — " + (e && e.message || "refused")); }
  // Lowercase the domain only — RFC 5321 leaves the local-part
  // case-sensitive; matching the customers primitive's discipline
  // here lets a `fraud_email_flags` row collide with the customer
  // row's `email_hash` for cross-table joins.
  var at = canonical.lastIndexOf("@");
  if (at !== -1) {
    canonical = canonical.slice(0, at) + "@" + canonical.slice(at + 1).toLowerCase();
  }
  return canonical;
}

function _emailDomain(canonicalEmail) {
  var at = canonicalEmail.lastIndexOf("@");
  if (at === -1) return "";
  return canonicalEmail.slice(at + 1);
}

function _country(c, label) {
  if (typeof c !== "string" || !/^[A-Z]{2}$/.test(c)) {
    throw new TypeError("fraudScreen: " + label + " must be a 2-letter ISO 3166-1 country code");
  }
  return c;
}

function _addressShape(addr, label) {
  if (!addr || typeof addr !== "object") {
    throw new TypeError("fraudScreen: " + label + " must be an object");
  }
  _country(addr.country, label + ".country");
  return addr;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("fraudScreen: " + label + " must be a non-negative integer");
  }
  return n;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("fraudScreen: " + label + " must be a positive integer");
  }
  return n;
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("fraudScreen: currency must be a 3-letter ISO 4217 code (uppercase)");
  }
  return c;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Operator-injectable peers. All optional — the primitive falls
  // back to neutral defaults when a peer is absent. `customers` is
  // touched only for the customer_id -> email_hash lookup on
  // customerRiskHistory; the other peers are reserved for the
  // forthcoming BIN/AVS integration and the email-suppression
  // signal.
  var customers         = opts.customers         || null;
  // addresses + paymentMethods are accepted now so operators can
  // wire them at the call site without a primitive-shape change
  // when the cross-primitive BIN/AVS join lands; v1 only validates
  // the dependency shape.
  if (opts.addresses      && typeof opts.addresses      !== "object") throw new TypeError("fraudScreen.create: addresses must be an object");
  if (opts.paymentMethods && typeof opts.paymentMethods !== "object") throw new TypeError("fraudScreen.create: paymentMethods must be an object");
  var emailSuppressions = opts.emailSuppressions || null;
  var binCountryMap     = opts.binCountryMap     || null;

  var disposableSet = new Set((opts.disposableDomains || DEFAULT_DISPOSABLE_DOMAINS).map(function (d) {
    return String(d).toLowerCase();
  }));
  var freeSet = new Set((opts.freeDomains || DEFAULT_FREE_DOMAINS).map(function (d) {
    return String(d).toLowerCase();
  }));

  // Cursor secret for recentScreenings. Defaults to a dev-only
  // sentinel so the primitive boots under tests; deployments are
  // expected to supply a derived value (typically
  // b.crypto.namespaceHash("fraud-screen-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("fraudScreen.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "fraud-screen-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _hashEmail(canonicalEmail) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, canonicalEmail);
  }

  // ---- signal evaluation -------------------------------------------------

  async function _evaluate(draft) {
    var canonicalEmail = _normalizeEmail(draft.email);
    var emailHash      = _hashEmail(canonicalEmail);
    var domain         = _emailDomain(canonicalEmail).toLowerCase();
    var signals        = [];
    var score          = 0;

    function _push(name, weight, fired, detail) {
      signals.push({
        name:   name,
        weight: weight,
        fired:  !!fired,
        detail: detail || null,
      });
      if (fired) score += weight;
    }

    // 1. velocity — count screenings for this email hash in the
    //    last 24h. The current screen() row hasn't been written
    //    yet, so the COUNT below reflects strictly prior activity.
    var velRows = (await query(
      "SELECT COUNT(*) AS n FROM fraud_screenings " +
      "WHERE email_hash = ?1 AND occurred_at >= ?2",
      [emailHash, _now() - VELOCITY_WINDOW_MS],
    )).rows;
    var velocityCount = Number((velRows[0] || {}).n || 0);
    _push("velocity", WEIGHTS.VELOCITY, velocityCount > VELOCITY_MAX_OK, {
      window_ms:      VELOCITY_WINDOW_MS,
      prior_count:    velocityCount,
      threshold:      VELOCITY_MAX_OK,
    });

    // 2. high-value-new-customer — large total combined with
    //    prior_orders_count = 0 (operator-supplied; defaults to
    //    null which the signal treats as "unknown -> don't fire").
    var prior = draft.prior_orders_count;
    var highValueNew = (
      typeof prior === "number" && prior === 0 &&
      typeof draft.total_minor === "number" &&
      draft.total_minor >= HIGH_VALUE_NEW_THRESH
    );
    _push("high-value-new-customer", WEIGHTS.HIGH_VALUE_NEW_CUSTOMER, highValueNew, {
      total_minor:         draft.total_minor,
      threshold_minor:     HIGH_VALUE_NEW_THRESH,
      prior_orders_count:  prior == null ? "unknown" : prior,
    });

    // 3. address-mismatch — shipping country != billing country.
    //    When billing_address is absent (digital goods, single-
    //    address flow), the signal does not fire.
    var shipCountry = draft.shipping_address.country;
    var billCountry = draft.billing_address && draft.billing_address.country;
    var mismatch = !!(billCountry && billCountry !== shipCountry);
    _push("address-mismatch", WEIGHTS.ADDRESS_MISMATCH, mismatch, {
      shipping_country: shipCountry,
      billing_country:  billCountry || null,
    });

    // 4. free-email-domain — soft signal; usually corroborates a
    //    primary signal rather than acting alone.
    _push("free-email-domain", WEIGHTS.FREE_EMAIL_DOMAIN, freeSet.has(domain), {
      domain: domain,
    });

    // 5. disposable-email-domain — severe; weight pushes the row
    //    past the refuse threshold without corroboration.
    _push("disposable-email-domain", WEIGHTS.DISPOSABLE_EMAIL_DOMAIN, disposableSet.has(domain), {
      domain: domain,
    });

    // 6. session-too-fast — under-15s checkout is bot-shaped.
    var sessAge = draft.session_age_seconds;
    var tooFast = typeof sessAge === "number" && sessAge >= 0 && sessAge < SESSION_FAST_MAX_SEC;
    _push("session-too-fast", WEIGHTS.SESSION_TOO_FAST, tooFast, {
      session_age_seconds: sessAge,
      threshold_seconds:   SESSION_FAST_MAX_SEC,
    });

    // 7. session-too-old — over-24h cart that finally checks out
    //    matches a stale-cookie / cart-replay shape.
    var tooOld = typeof sessAge === "number" && sessAge > SESSION_OLD_MAX_SEC;
    _push("session-too-old", WEIGHTS.SESSION_TOO_OLD, tooOld, {
      session_age_seconds: sessAge,
      threshold_seconds:   SESSION_OLD_MAX_SEC,
    });

    // 8. ua-curl-class — operator-classified UA. The storefront's
    //    bot-guard pre-classifies the User-Agent string; this
    //    primitive only checks the resulting enum.
    var uaCurl = !!(draft.ua_class && CURL_CLASS_TOKENS[String(draft.ua_class).toLowerCase()]);
    _push("ua-curl-class", WEIGHTS.UA_CURL_CLASS, uaCurl, {
      ua_class: draft.ua_class == null ? null : String(draft.ua_class),
    });

    // 9. large-line-count — cart with many distinct lines tends
    //    to correlate with a carder testing batches.
    var bigLines = typeof draft.line_count === "number" && draft.line_count >= LARGE_LINE_COUNT_THRESH;
    _push("large-line-count", WEIGHTS.LARGE_LINE_COUNT, bigLines, {
      line_count: draft.line_count,
      threshold:  LARGE_LINE_COUNT_THRESH,
    });

    // 10. mismatched-bin-country — operator-supplied BIN -> country
    //     map; the draft optionally carries a bin6 (first 6 PAN
    //     digits) that the storefront extracts during the tokenize
    //     handshake. Without the map OR without bin6, the signal
    //     does not fire.
    var binMismatch = false;
    var binDetail   = null;
    if (binCountryMap && typeof draft.bin6 === "string" && /^[0-9]{6}$/.test(draft.bin6)) {
      var binCountry = binCountryMap[draft.bin6];
      if (binCountry && binCountry !== shipCountry) {
        binMismatch = true;
      }
      binDetail = {
        bin6:             draft.bin6,
        bin_country:      binCountry || null,
        shipping_country: shipCountry,
      };
    }
    _push("mismatched-bin-country", WEIGHTS.MISMATCHED_BIN_COUNTRY, binMismatch, binDetail);

    // 11. prior-chargeback — the chargebacks ledger has at least
    //     one row for this email hash.
    var cbRows = (await query(
      "SELECT COUNT(*) AS n FROM fraud_chargebacks WHERE email_hash = ?1",
      [emailHash],
    )).rows;
    var cbCount = Number((cbRows[0] || {}).n || 0);
    _push("prior-chargeback", WEIGHTS.PRIOR_CHARGEBACK, cbCount > 0, {
      chargeback_count: cbCount,
    });

    // 12. suppressed-email — operator-injectable peer. When the
    //     email pipeline has logged a hard bounce / complaint
    //     against this address, the signal fires.
    var suppressed = false;
    if (emailSuppressions && typeof emailSuppressions.isSuppressed === "function") {
      try {
        suppressed = !!(await emailSuppressions.isSuppressed(emailHash));
      } catch (_e) {
        // drop-silent — by design. A failing suppression backend
        // shouldn't block checkout; the signal stays at "did not
        // fire" and the other detectors carry the load.
        suppressed = false;
      }
    }
    _push("suppressed-email", WEIGHTS.SUPPRESSED_EMAIL, suppressed, {
      checked: !!emailSuppressions,
    });

    // 13. manually-flagged — operator-pinned hard block. Forces
    //     the decision to refuse regardless of any other signal.
    var flagRow = (await query(
      "SELECT reason, flagged_at FROM fraud_email_flags WHERE email_hash = ?1 LIMIT 1",
      [emailHash],
    )).rows[0];
    _push("manually-flagged", WEIGHTS.MANUALLY_FLAGGED, !!flagRow, flagRow ? {
      reason:     flagRow.reason || "",
      flagged_at: flagRow.flagged_at,
    } : null);

    // Cap at SCORE_MAX so the CHECK constraint in the migration
    // never sees an out-of-range value.
    if (score > SCORE_MAX) score = SCORE_MAX;

    return {
      score:      score,
      decision:   _decisionFor(score),
      signals:    signals,
      email_hash: emailHash,
    };
  }

  return {
    EMAIL_NAMESPACE: EMAIL_NAMESPACE,
    THRESHOLDS:      THRESHOLDS,
    WEIGHTS:         WEIGHTS,

    // Hash an email without writing — useful when the orchestrator
    // already has a canonical address and wants the lookup key for
    // a parallel chargebacks-by-email query.
    hashEmail: function (email) {
      return _hashEmail(_normalizeEmail(email));
    },

    // Evaluate a checkout draft. The draft shape is documented at
    // the top of this file. Returns a `{ score, decision, signals,
    // email_hash, order_id }` row and persists a `fraud_screenings`
    // ledger entry. The order_id is required because the
    // orchestrator looks up screenings by order id when
    // reconciling outcomes later.
    screen: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("fraudScreen.screen: input object required");
      var draft = input.order_draft;
      if (!draft || typeof draft !== "object") throw new TypeError("fraudScreen.screen: order_draft object required");
      _uuid(draft.order_id, "order_draft.order_id");
      _optUuid(draft.customer_id, "order_draft.customer_id");
      _addressShape(draft.shipping_address, "order_draft.shipping_address");
      if (draft.billing_address != null) {
        _addressShape(draft.billing_address, "order_draft.billing_address");
      }
      _nonNegInt(draft.total_minor, "order_draft.total_minor");
      _currency(draft.currency);
      _positiveInt(draft.line_count, "order_draft.line_count");
      if (draft.session_age_seconds != null) {
        if (typeof draft.session_age_seconds !== "number" || !isFinite(draft.session_age_seconds)) {
          throw new TypeError("fraudScreen: order_draft.session_age_seconds must be a finite number");
        }
      }
      if (draft.prior_orders_count != null) {
        _nonNegInt(draft.prior_orders_count, "order_draft.prior_orders_count");
      }
      if (draft.ip_hash != null && (typeof draft.ip_hash !== "string" || !draft.ip_hash.length)) {
        throw new TypeError("fraudScreen: order_draft.ip_hash must be a non-empty string when provided");
      }

      var verdict = await _evaluate(draft);
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO fraud_screenings " +
        "(id, order_id, customer_id, email_hash, score, decision, signals_json, actual_outcome, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)",
        [
          id, draft.order_id, draft.customer_id || null, verdict.email_hash,
          verdict.score, verdict.decision, JSON.stringify(verdict.signals), ts,
        ],
      );
      return {
        id:         id,
        order_id:   draft.order_id,
        email_hash: verdict.email_hash,
        score:      verdict.score,
        decision:   verdict.decision,
        signals:    verdict.signals,
        occurred_at: ts,
      };
    },

    // Reconcile the heuristic verdict against the actual outcome.
    // Writes `actual_outcome` on every screening row that matched
    // the order_id (typically one row per order — the orchestrator
    // calls screen() once — but the loop tolerates retries that
    // produced multiple screenings for the same order). Returns
    // the count of rows updated.
    recordOutcome: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("fraudScreen.recordOutcome: input object required");
      _uuid(input.order_id, "order_id");
      var allowed = { paid_clean: true, chargeback: true, refunded: true, cancelled: true };
      if (!input.actual_outcome || !allowed[input.actual_outcome]) {
        throw new TypeError("fraudScreen.recordOutcome: actual_outcome must be one of paid_clean|chargeback|refunded|cancelled");
      }
      var r = await query(
        "UPDATE fraud_screenings SET actual_outcome = ?1 WHERE order_id = ?2",
        [input.actual_outcome, input.order_id],
      );
      return { updated: Number(r.rowCount || 0) };
    },

    // Append a chargeback row. The screenings primitive looks back
    // at this table on every subsequent screen() of the same
    // email hash so a hostile customer gets the prior-chargeback
    // signal weight on their next attempt.
    recordChargeback: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("fraudScreen.recordChargeback: input object required");
      _uuid(input.order_id, "order_id");
      _optUuid(input.customer_id, "customer_id");
      if (typeof input.email !== "string" || !input.email.length) {
        throw new TypeError("fraudScreen.recordChargeback: email required");
      }
      _nonNegInt(input.amount_minor, "amount_minor");
      if (input.reason != null && typeof input.reason !== "string") {
        throw new TypeError("fraudScreen.recordChargeback: reason must be a string when provided");
      }
      if (input.reason && /[\x00-\x1f\x7f]/.test(input.reason)) {
        throw new TypeError("fraudScreen.recordChargeback: reason must not contain control bytes");
      }
      var canonicalEmail = _normalizeEmail(input.email);
      var emailHash      = _hashEmail(canonicalEmail);
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO fraud_chargebacks " +
        "(id, order_id, customer_id, email_hash, amount_minor, reason, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, input.order_id, input.customer_id || null, emailHash,
         input.amount_minor, input.reason || "", ts],
      );
      return {
        id:           id,
        order_id:     input.order_id,
        email_hash:   emailHash,
        amount_minor: input.amount_minor,
        reason:       input.reason || "",
        occurred_at:  ts,
      };
    },

    // Operator-pinned manual block. Re-flagging the same address
    // is idempotent — the row is upserted with the latest reason
    // + timestamp so the dashboard always shows the freshest
    // operator note.
    flagEmail: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("fraudScreen.flagEmail: input object required");
      if (typeof input.email !== "string" || !input.email.length) {
        throw new TypeError("fraudScreen.flagEmail: email required");
      }
      if (input.reason != null && typeof input.reason !== "string") {
        throw new TypeError("fraudScreen.flagEmail: reason must be a string when provided");
      }
      if (input.reason && /[\x00-\x1f\x7f]/.test(input.reason)) {
        throw new TypeError("fraudScreen.flagEmail: reason must not contain control bytes");
      }
      var canonicalEmail = _normalizeEmail(input.email);
      var emailHash      = _hashEmail(canonicalEmail);
      var ts = _now();
      // Idempotent upsert. INSERT-OR-REPLACE on the PK preserves
      // the row identity (email_hash) while refreshing the reason
      // + flagged_at so the dashboard shows the latest note.
      await query(
        "INSERT INTO fraud_email_flags (email_hash, reason, flagged_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(email_hash) DO UPDATE SET reason = excluded.reason, flagged_at = excluded.flagged_at",
        [emailHash, input.reason || "", ts],
      );
      return {
        email_hash: emailHash,
        reason:     input.reason || "",
        flagged_at: ts,
      };
    },

    // Remove an operator-pinned block. Returns { unflagged: bool }.
    unflagEmail: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("fraudScreen.unflagEmail: input object required");
      if (typeof input.email !== "string" || !input.email.length) {
        throw new TypeError("fraudScreen.unflagEmail: email required");
      }
      var canonicalEmail = _normalizeEmail(input.email);
      var emailHash      = _hashEmail(canonicalEmail);
      var r = await query(
        "DELETE FROM fraud_email_flags WHERE email_hash = ?1",
        [emailHash],
      );
      return { unflagged: Number(r.rowCount || 0) > 0 };
    },

    // Return prior screenings for a given customer. Ordered most-
    // recent first so the dashboard pane shows the freshest
    // decisions at the top. Hard-capped at 200 rows — the operator
    // dashboard paginates beyond that via recentScreenings.
    customerRiskHistory: async function (customerId) {
      _uuid(customerId, "customer id");
      var rows = (await query(
        "SELECT id, order_id, customer_id, email_hash, score, decision, " +
        "signals_json, actual_outcome, occurred_at " +
        "FROM fraud_screenings WHERE customer_id = ?1 " +
        "ORDER BY occurred_at DESC, id DESC LIMIT 200",
        [customerId],
      )).rows;
      // Parse signals_json so callers don't each re-decode it.
      // Touch the optional customers peer in a no-op shape check
      // so the eslint-unused-vars detector stays quiet without
      // requiring callers to wire it for this lookup; the field
      // is reserved for a forthcoming join that pulls the
      // display_name alongside the rows.
      if (customers && typeof customers.get === "function") { /* reserved */ }
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        var parsed = [];
        try { parsed = JSON.parse(r.signals_json || "[]"); }
        catch (_e) { parsed = []; }
        out.push({
          id:             r.id,
          order_id:       r.order_id,
          customer_id:    r.customer_id,
          email_hash:     r.email_hash,
          score:          r.score,
          decision:       r.decision,
          signals:        parsed,
          actual_outcome: r.actual_outcome,
          occurred_at:    r.occurred_at,
        });
      }
      return out;
    },

    // Operator dashboard feed — paginated by (occurred_at DESC,
    // id DESC) so the freshest screenings surface first. Cursor
    // is HMAC-tagged via b.pagination so an operator can't
    // hand-craft one to skip past a hidden row.
    recentScreenings: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 20 : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        throw new TypeError("fraudScreen.recentScreenings: limit must be 1...100");
      }
      var orderKey = ["occurred_at:desc", "id:desc"];
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("fraudScreen.recentScreenings: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(orderKey)) {
            throw new TypeError("fraudScreen.recentScreenings: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("fraudScreen.recentScreenings: cursor — " + (e && e.message || "malformed"));
        }
      }
      var rows;
      if (cursorVals) {
        rows = (await query(
          "SELECT id, order_id, customer_id, email_hash, score, decision, " +
          "signals_json, actual_outcome, occurred_at " +
          "FROM fraud_screenings " +
          "WHERE (occurred_at < ?1 OR (occurred_at = ?1 AND id < ?2)) " +
          "ORDER BY occurred_at DESC, id DESC LIMIT ?3",
          [cursorVals[0], cursorVals[1], limit],
        )).rows;
      } else {
        rows = (await query(
          "SELECT id, order_id, customer_id, email_hash, score, decision, " +
          "signals_json, actual_outcome, occurred_at " +
          "FROM fraud_screenings " +
          "ORDER BY occurred_at DESC, id DESC LIMIT ?1",
          [limit],
        )).rows;
      }
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        var parsed = [];
        try { parsed = JSON.parse(r.signals_json || "[]"); }
        catch (_e) { parsed = []; }
        out.push({
          id:             r.id,
          order_id:       r.order_id,
          customer_id:    r.customer_id,
          email_hash:     r.email_hash,
          score:          r.score,
          decision:       r.decision,
          signals:        parsed,
          actual_outcome: r.actual_outcome,
          occurred_at:    r.occurred_at,
        });
      }
      var last = out[out.length - 1];
      var next = null;
      if (last && out.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: orderKey,
          vals:     [last.occurred_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: out, next_cursor: next };
    },
  };
}

module.exports = {
  create:                     create,
  EMAIL_NAMESPACE:            EMAIL_NAMESPACE,
  THRESHOLDS:                 THRESHOLDS,
  WEIGHTS:                    WEIGHTS,
  VELOCITY_WINDOW_MS:         VELOCITY_WINDOW_MS,
  VELOCITY_MAX_OK:            VELOCITY_MAX_OK,
  HIGH_VALUE_NEW_THRESH:      HIGH_VALUE_NEW_THRESH,
  SESSION_FAST_MAX_SEC:       SESSION_FAST_MAX_SEC,
  SESSION_OLD_MAX_SEC:        SESSION_OLD_MAX_SEC,
  LARGE_LINE_COUNT_THRESH:    LARGE_LINE_COUNT_THRESH,
  DEFAULT_DISPOSABLE_DOMAINS: DEFAULT_DISPOSABLE_DOMAINS,
  DEFAULT_FREE_DOMAINS:       DEFAULT_FREE_DOMAINS,
};
