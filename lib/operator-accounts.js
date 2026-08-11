"use strict";
/**
 * @module shop.operatorAccounts
 * @title  Operator accounts — the staff person who signs in to the
 *         admin console, holding their OWN credential
 *
 * @intro
 *   Today a single shared `ADMIN_API_KEY` guards the whole admin
 *   console. This primitive adds per-operator identity: several humans
 *   can run the shop with distinct logins and distinct roles, and the
 *   audit trail names WHO did each thing. `ADMIN_API_KEY` keeps working
 *   as the bootstrap / break-glass credential mapped to the owner role,
 *   so an upgrade never locks the operator out — and with zero rows in
 *   `operator_accounts` the console behaves byte-for-byte as it did
 *   before.
 *
 *   An operator account holds:
 *
 *     - `email` (display) + `email_hash` (login lookup key). The hash
 *       is `namespaceHash("operator-email", canonical-email)` so a
 *       database dump never carries a plaintext login index.
 *     - `password_hash` — an Argon2id PHC string from the vendored
 *       `b.auth.password.hash`. The plaintext never reaches storage;
 *       `b.auth.password.verify` does the constant-time check.
 *     - `api_key_hash` (optional) — the namespaceHash of a per-operator
 *       bearer token (32-byte CSPRNG draw, base64url). The plaintext is
 *       returned ONCE at mint time and never stored. The verify path
 *       runs `b.crypto.timingSafeEqual` so a wrong key and an unknown
 *       operator are indistinguishable on the wire.
 *     - `role` — one of `owner` | `manager` | `viewer` (the v1
 *       built-in role set; see `lib/operator-roles.js` for the
 *       operator-authored custom-role surface that layers on top).
 *     - `status` — `active` | `disabled`. A disabled operator's
 *       password + API key stop authenticating immediately.
 *
 *   Surface:
 *
 *     - createAccount({ email, display_name, password, role,
 *                       created_by, mint_api_key? })
 *         Hash the password (Argon2id), optionally mint a per-operator
 *         API key, insert the row. Returns the public account shape;
 *         when `mint_api_key` is set the freshly-minted plaintext key
 *         rides back as `api_key` (the ONLY time it is ever visible).
 *
 *     - verifyPassword({ email, password })
 *         Resolve the account by email hash, refuse non-active rows,
 *         and run `b.auth.password.verify`. Returns the public account on a
 *         match, `null` on every refuse path (unknown email, disabled,
 *         wrong password) — no oracle distinguishing the three.
 *
 *     - verifyApiKey(plaintext)
 *         Resolve the account by the bearer token's namespaceHash, run
 *         a timing-safe compare against the stored hash, refuse
 *         non-active rows. Returns the public account on a match,
 *         `null` otherwise. Burns the same compare work on a miss as a
 *         hit so the latency profile matches.
 *
 *     - getById(id) / getByEmail(email)
 *         Read the public account shape (never the hashes).
 *
 *     - listAccounts({ status?, limit? })
 *         Enumerate accounts, newest-first.
 *
 *     - setStatus({ id, status, actor_id })
 *         Flip `active` <-> `disabled`. Disabling is the v1 way to
 *         revoke an operator's access (the row + its audit grain
 *         survive). Idempotent.
 *
 *     - setRole({ id, role, actor_id })
 *         Change an operator's built-in role.
 *
 *     - rotateApiKey({ id, actor_id })
 *         Mint a fresh per-operator bearer token, replacing any prior
 *         one. Returns the new plaintext once.
 *
 *   Composition:
 *     - `b.auth.password.hash` / `b.auth.password.verify` — Argon2id, OWASP-2026
 *       floor params. The single password primitive; never hand-rolled.
 *     - `b.crypto.generateBytes` / `b.crypto.toBase64Url` — API-key
 *       plaintext (32-byte CSPRNG draw).
 *     - `b.crypto.namespaceHash` — email-hash + api-key-hash keying.
 *     - `b.crypto.timingSafeEqual` — constant-time API-key compare.
 *     - `b.guardEmail` — strict email validation + canonicalization.
 *     - `b.uuid.v7` — account id (sorts by creation time).
 *     - `operatorAuditLog` (opt) — chained-hash audit of every account
 *       mutation when wired.
 *
 *   Storage: `migrations-d1/0213_operator_accounts.sql`.
 *
 *   Dual-control (two-operator approval) — evaluated, deliberately NOT
 *   wired in v1:
 *
 *     `b.dualControl` raises a destructive op to "two distinct named
 *     operators must approve before it runs." It is the right control for
 *     a store run by a TEAM, but it is structurally a two-actor M-of-N
 *     gate — `create()` hard-validates `minApprovers >= 2`, and there is
 *     no auto-satisfy-on-single-operator path. The dominant deployment of
 *     this storefront is a SINGLE owner; on such a store a dual-control
 *     gate would DEADLOCK the destructive op forever — there is no second
 *     operator to approve, so the op can never consume its grant. Wiring
 *     it unconditionally is therefore a worse failure than the
 *     single-operator risk it would close. It is also a two-request async
 *     workflow (request → a different actor approves → consume), which
 *     does not fit the synchronous single-POST shape these admin actions
 *     have today.
 *
 *     Per destructive op, the v1 stance:
 *
 *       - gift-card void (POST /admin/gift-cards/:id/void): recoverable —
 *         void is a status flip that PRESERVES the balance (it burns no
 *         value), so re-issuing or restoring the card's status makes a
 *         mistaken void recoverable, and the giftcard ledger records the
 *         acting operator. The cost of a deadlock-on-single-owner
 *         outweighs the benefit. Stance: role-gate (`orders.write`) +
 *         audit, no dual-control.
 *
 *       - refunds (POST /admin/orders/:id/refund, /admin/returns/:id/
 *         refund): real money out, but bounded by the order's captured
 *         amount (the payment primitive refuses to over-refund a PI), and
 *         every refund is idempotency-keyed + audited with the operator
 *         id. The damage ceiling is one order's total, not the whole
 *         book. Stance: role-gate (`orders.write`) + audit, no
 *         dual-control.
 *
 *       - operator disable (POST /admin/operators/:id/disable): the
 *         highest-blast-radius op (it can revoke a co-owner), but it is
 *         REVERSIBLE in one click (`/enable`), gated on `operators.manage`
 *         (owner-only), and audited. A malicious self-lockout still leaves
 *         the `ADMIN_API_KEY` break-glass owner credential working.
 *         Stance: role-gate + audit, no dual-control.
 *
 *     Re-open condition: when a store carries TWO OR MORE active `owner`/
 *     `manager` operators, dual-control becomes wire-able WITHOUT the
 *     deadlock risk — gate the approval flow on `listAccounts({ status:
 *     "active" })` length >= 2, auto-satisfy below that, and move the
 *     destructive POST to a request/approve/consume sequence keyed off a
 *     b.cache grant. That is the natural follow-up the moment a real
 *     multi-operator store exists; it is not defensible to ship a control
 *     that bricks the single-operator common case to pre-empt it.
 *
 * @primitive operatorAccounts
 * @related   operatorRoles, operatorSessions, operatorAuditLog,
 *            b.password, b.crypto, b.guardEmail, b.uuid, b.dualControl
 */

var EMAIL_NAMESPACE   = "operator-email";
var API_KEY_NAMESPACE = "operator-api-key";
var API_KEY_BYTES     = 32;

var MAX_EMAIL_LEN        = 320;
var MAX_DISPLAY_NAME_LEN = 128;
var MIN_PASSWORD_LEN     = 12;
var MAX_PASSWORD_BYTES   = 4096;   // Argon2id plaintext ceiling
var MAX_LIST_LIMIT       = 200;

var ROLES  = Object.freeze(["owner", "manager", "viewer"]);
var STATUS = Object.freeze(["active", "disabled"]);


var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("operatorAccounts: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _actorId(s, label) {
  // The bootstrap / break-glass actor is the sentinel "owner" string
  // (ADMIN_API_KEY-authed, not a UUID); operator actors are UUIDs.
  // Accept either shape so the bootstrap path can record itself.
  if (typeof s !== "string" || !s.length || s.length > 128) {
    throw new TypeError("operatorAccounts: " + (label || "actor_id") + " must be a non-empty string (<= 128 chars)");
  }
  if (textGuard.hasCodepointThreat(s, { singleLine: "reject" })) {
    throw new TypeError("operatorAccounts: " + (label || "actor_id") + " must not contain control bytes");
  }
  return s;
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length || input.length > MAX_EMAIL_LEN) {
    throw new TypeError("operatorAccounts: email must be a non-empty string (<= " + MAX_EMAIL_LEN + " chars)");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("operatorAccounts: email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("operatorAccounts: email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("operatorAccounts: email — " + (e && e.message || "refused"));
  }
  var at = canonical.lastIndexOf("@");
  if (at !== -1) {
    canonical = canonical.slice(0, at) + "@" + canonical.slice(at + 1).toLowerCase();
  }
  return canonical;
}

function _displayName(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_DISPLAY_NAME_LEN) {
    throw new TypeError("operatorAccounts: display_name must be a non-empty string (<= " + MAX_DISPLAY_NAME_LEN + " chars)");
  }
  textGuard.freeText(s, "operatorAccounts: display_name", { singleLine: "reject", bidiMarks: "allow" });
  return s;
}

function _password(s) {
  if (typeof s !== "string" || s.length < MIN_PASSWORD_LEN) {
    throw new TypeError("operatorAccounts: password must be a string of at least " + MIN_PASSWORD_LEN + " characters");
  }
  if (Buffer.byteLength(s, "utf8") > MAX_PASSWORD_BYTES) {
    throw new TypeError("operatorAccounts: password exceeds " + MAX_PASSWORD_BYTES + " bytes");
  }
  return s;
}

function _role(s) {
  if (typeof s !== "string" || ROLES.indexOf(s) === -1) {
    throw new TypeError("operatorAccounts: role must be one of " + ROLES.join(", "));
  }
  return s;
}

function _statusValue(s) {
  if (typeof s !== "string" || STATUS.indexOf(s) === -1) {
    throw new TypeError("operatorAccounts: status must be one of " + STATUS.join(", "));
  }
  return s;
}

function _bool(v, label) {
  if (v == null) return false;
  if (v === true || v === false) return v;
  throw new TypeError("operatorAccounts: " + label + " must be a boolean");
}

function _limit(n) {
  if (n == null) return 100;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("operatorAccounts: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

// ---- row hydration ------------------------------------------------------
//
// The public shape NEVER carries password_hash / api_key_hash / the raw
// email_hash — only the fields a console screen or the auth resolver
// needs.

function _hydrate(r) {
  if (!r) return null;
  return {
    id:           r.id,
    email:        r.email,
    display_name: r.display_name,
    role:         r.role,
    status:       r.status,
    has_api_key:  r.api_key_hash != null,
    created_by:   r.created_by,
    created_at:   Number(r.created_at),
    updated_at:   Number(r.updated_at),
    disabled_at:  r.disabled_at == null ? null : Number(r.disabled_at),
    disabled_by:  r.disabled_by == null ? null : r.disabled_by,
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional chained-audit peer. Duck-typed `.record(...)` so the tests
  // can stub it without importing the full primitive.
  var operatorAuditLog = opts.operatorAuditLog || null;

  // Per-factory monotonic clock — two account mutations in the same
  // wall-clock millisecond still carry strictly-increasing timestamps so
  // the audit timeline sorts deterministically.
  var _lastTs = 0;
  function _now() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // A real Argon2id PHC hash burned against a presented password when no
  // account matches the email, so the unknown-email path pays the same
  // memory-hard cost as a known-email-wrong-password path — closing the
  // timing oracle on account existence. Computed once, lazily, on the
  // first unknown-email verify and memoized thereafter.
  var _dummyHashPromise = null;
  function _dummyHash() {
    if (!_dummyHashPromise) {
      _dummyHashPromise = b.auth.password.hash("operator-accounts-timing-equalizer");
    }
    return _dummyHashPromise;
  }

  function _hashEmail(email) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, email);
  }
  function _hashApiKey(plaintext) {
    return b.crypto.namespaceHash(API_KEY_NAMESPACE, plaintext);
  }
  function _mintApiKey() {
    var plaintext = b.crypto.toBase64Url(b.crypto.generateBytes(API_KEY_BYTES));
    return { plaintext: plaintext, hash: _hashApiKey(plaintext) };
  }

  async function _audit(action, actorId, accountId, before, after) {
    if (!operatorAuditLog || typeof operatorAuditLog.record !== "function") return;
    await operatorAuditLog.record({
      actor_type:    "operator",
      actor_id:      actorId,
      action:        "operator_account." + action,
      resource_kind: "operator_account",
      resource_id:   accountId,
      before:        before,
      after:         after,
    });
  }

  async function _rowById(id) {
    return (await query(
      "SELECT * FROM operator_accounts WHERE id = ?1 LIMIT 1",
      [id],
    )).rows[0] || null;
  }

  // ---- createAccount -------------------------------------------------

  async function createAccount(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorAccounts.createAccount: input object required");
    }
    var email       = _normalizeEmail(input.email);
    var displayName = _displayName(input.display_name);
    var password    = _password(input.password);
    var role        = _role(input.role);
    var createdBy   = _actorId(input.created_by, "created_by");
    var mintApiKey  = _bool(input.mint_api_key, "mint_api_key");

    var emailHash = _hashEmail(email);
    var existing = (await query(
      "SELECT id FROM operator_accounts WHERE email_hash = ?1 LIMIT 1",
      [emailHash],
    )).rows[0];
    if (existing) {
      throw new TypeError("operatorAccounts.createAccount: an operator with that email already exists");
    }

    var passwordHash = await b.auth.password.hash(password);
    var apiKey = null;
    var apiKeyHash = null;
    if (mintApiKey) {
      var minted = _mintApiKey();
      apiKey = minted.plaintext;
      apiKeyHash = minted.hash;
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO operator_accounts " +
      "(id, email, email_hash, display_name, password_hash, api_key_hash, " +
      " role, status, created_by, created_at, updated_at, disabled_at, disabled_by) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, ?9, NULL, NULL)",
      [id, email, emailHash, displayName, passwordHash, apiKeyHash, role, createdBy, ts],
    );

    await _audit("create", createdBy, id, null, { role: role, status: "active", has_api_key: !!apiKeyHash });

    var account = _hydrate(await _rowById(id));
    if (apiKey) account.api_key = apiKey;
    return account;
  }

  // ---- verifyPassword ------------------------------------------------

  async function verifyPassword(input) {
    if (!input || typeof input !== "object") return null;
    var email;
    try { email = _normalizeEmail(input.email); }
    catch (_e) { return null; }
    if (typeof input.password !== "string" || !input.password.length) return null;

    var row = (await query(
      "SELECT * FROM operator_accounts WHERE email_hash = ?1 LIMIT 1",
      [_hashEmail(email)],
    )).rows[0];
    if (!row) {
      // Burn a real Argon2id verify against a memoized dummy hash so an
      // unknown email pays the same memory-hard cost as a known one — no
      // timing oracle on account existence. The result is discarded.
      try { await b.auth.password.verify(await _dummyHash(), input.password); }
      catch (_e) { /* drop — verify tolerates malformed input */ }
      return null;
    }
    var ok = false;
    try { ok = await b.auth.password.verify(row.password_hash, input.password); }
    catch (_e) { ok = false; }
    if (!ok) return null;
    if (row.status !== "active") return null;
    return _hydrate(row);
  }

  // ---- verifyApiKey --------------------------------------------------

  async function verifyApiKey(plaintext) {
    if (typeof plaintext !== "string" || !plaintext.length) return null;
    var hash = _hashApiKey(plaintext);
    var row = (await query(
      "SELECT * FROM operator_accounts WHERE api_key_hash = ?1 LIMIT 1",
      [hash],
    )).rows[0];
    if (!row || row.api_key_hash == null) {
      // Burn the same compare work as the hit path so the latency
      // profile matches between miss and hit.
      b.crypto.timingSafeEqual(hash, hash);
      return null;
    }
    var matched = b.crypto.timingSafeEqual(row.api_key_hash, hash);
    if (!matched) return null;
    if (row.status !== "active") return null;
    return _hydrate(row);
  }

  // ---- getById / getByEmail ------------------------------------------

  async function getById(id) {
    var clean = _uuid(id, "id");
    return _hydrate(await _rowById(clean));
  }

  async function getByEmail(email) {
    var canonical = _normalizeEmail(email);
    var row = (await query(
      "SELECT * FROM operator_accounts WHERE email_hash = ?1 LIMIT 1",
      [_hashEmail(canonical)],
    )).rows[0];
    return _hydrate(row);
  }

  // ---- listAccounts --------------------------------------------------

  async function listAccounts(listOpts) {
    listOpts = listOpts || {};
    if (typeof listOpts !== "object") {
      throw new TypeError("operatorAccounts.listAccounts: opts must be an object");
    }
    var status = listOpts.status == null ? null : _statusValue(listOpts.status);
    var limit  = _limit(listOpts.limit);
    var sql, params;
    if (status != null) {
      sql    = "SELECT * FROM operator_accounts WHERE status = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2";
      params = [status, limit];
    } else {
      sql    = "SELECT * FROM operator_accounts ORDER BY created_at DESC, id DESC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrate(rows[i]));
    return out;
  }

  // ---- setStatus -----------------------------------------------------

  async function setStatus(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorAccounts.setStatus: input object required");
    }
    var id      = _uuid(input.id, "id");
    var status  = _statusValue(input.status);
    var actorId = _actorId(input.actor_id, "actor_id");

    var current = await _rowById(id);
    if (!current) {
      throw new TypeError("operatorAccounts.setStatus: operator not found");
    }
    if (current.status === status) {
      return _hydrate(current);   // idempotent
    }
    var ts = _now();
    if (status === "disabled") {
      await query(
        "UPDATE operator_accounts SET status = 'disabled', disabled_at = ?1, disabled_by = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, actorId, id],
      );
    } else {
      await query(
        "UPDATE operator_accounts SET status = 'active', disabled_at = NULL, disabled_by = NULL, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
    }
    await _audit("set_status", actorId, id, { status: current.status }, { status: status });
    return _hydrate(await _rowById(id));
  }

  // ---- setRole -------------------------------------------------------

  async function setRole(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorAccounts.setRole: input object required");
    }
    var id      = _uuid(input.id, "id");
    var role    = _role(input.role);
    var actorId = _actorId(input.actor_id, "actor_id");

    var current = await _rowById(id);
    if (!current) {
      throw new TypeError("operatorAccounts.setRole: operator not found");
    }
    if (current.role === role) {
      return _hydrate(current);
    }
    var ts = _now();
    await query(
      "UPDATE operator_accounts SET role = ?1, updated_at = ?2 WHERE id = ?3",
      [role, ts, id],
    );
    await _audit("set_role", actorId, id, { role: current.role }, { role: role });
    return _hydrate(await _rowById(id));
  }

  // ---- rotateApiKey --------------------------------------------------

  async function rotateApiKey(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorAccounts.rotateApiKey: input object required");
    }
    var id      = _uuid(input.id, "id");
    var actorId = _actorId(input.actor_id, "actor_id");

    var current = await _rowById(id);
    if (!current) {
      throw new TypeError("operatorAccounts.rotateApiKey: operator not found");
    }
    var minted = _mintApiKey();
    var ts = _now();
    await query(
      "UPDATE operator_accounts SET api_key_hash = ?1, updated_at = ?2 WHERE id = ?3",
      [minted.hash, ts, id],
    );
    await _audit("rotate_api_key", actorId, id,
      { has_api_key: current.api_key_hash != null }, { has_api_key: true });
    var account = _hydrate(await _rowById(id));
    account.api_key = minted.plaintext;
    return account;
  }

  return {
    ROLES:          ROLES,
    STATUS:         STATUS,
    createAccount:  createAccount,
    verifyPassword: verifyPassword,
    verifyApiKey:   verifyApiKey,
    getById:        getById,
    getByEmail:     getByEmail,
    listAccounts:   listAccounts,
    setStatus:      setStatus,
    setRole:        setRole,
    rotateApiKey:   rotateApiKey,
  };
}

module.exports = {
  create:               create,
  ROLES:                ROLES,
  STATUS:               STATUS,
  MIN_PASSWORD_LEN:     MIN_PASSWORD_LEN,
  MAX_DISPLAY_NAME_LEN: MAX_DISPLAY_NAME_LEN,
  EMAIL_NAMESPACE:      EMAIL_NAMESPACE,
  API_KEY_NAMESPACE:    API_KEY_NAMESPACE,
};
