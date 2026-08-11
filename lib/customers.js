"use strict";
/**
 * @module shop.customers
 * @title  Customers primitive — passkey-enrolled accounts
 *
 * @intro
 *   Persistent customer accounts. v1 is passwordless: the only
 *   credential surface is WebAuthn passkeys. Email is never stored
 *   in plaintext — every lookup happens against
 *   `b.crypto.namespaceHash("customer-email", email)`, the
 *   deterministic SHA3-512 derivation that doubles as the UNIQUE
 *   key so two registrations of the same address collide
 *   deterministically.
 *
 *   The primitive owns the customer row + the credentials table.
 *   The full WebAuthn ceremony lives in the storefront route layer
 *   — this primitive accepts already-verified registration /
 *   assertion results and persists them.
 *
 *   Validators:
 *     - email round-trips through `b.guardEmail.validate(input, {
 *       profile: "strict" })` and is then sanitized to a canonical
 *       form before hashing, so two registrations that differ only
 *       in whitespace / control codes collide.
 *     - display_name has a hard length cap (128) and refuses
 *       control bytes / CR / LF.
 *     - credential_id, public_key, transports are operator-supplied
 *       opaque strings; the primitive enforces shape (non-empty,
 *       <= 4 KiB) but never tries to parse them.
 */

// Apple's OAuth client secret must be an ES256 (ECDSA P-256, IEEE-P1363)
// JWT; the PQC-first framework ships no classical ES256 signer and
// b.crypto.sign can't select P1363 encoding. node:crypto is the only way to
// mint it (used solely by mintAppleClientSecret below).
var nodeCrypto = require("node:crypto");                                   // allow:non-shop-require — Apple mandates ES256/P1363; framework has no classical ES256 signer

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

var EMAIL_NAMESPACE = "customer-email";
// Federated identity providers the OIDC sign-in path accepts.
var OAUTH_PROVIDERS = ["google", "apple"];
var MAX_DISPLAY_NAME_LEN  = 128;
var MAX_CRED_FIELD_BYTES  = 4096;
var TRANSPORTS_RE = /^[a-z]+(?:,[a-z]+)*$/;

// Pagination cursor for the operator-facing `list` — newest first by
// (created_at, id), HMAC-tagged via b.pagination so an operator can't
// hand-craft one to skip rows. Same orderKey-mismatch refusal the order
// primitive uses for its customer-scoped history.
var CUSTOMERS_ORDER_KEY = ["created_at:desc", "id:desc"];
var MAX_LIST_LIMIT = 100;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customers: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("customers: email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  // validate -> returns { ok, issues } at the strict profile. Any
  // critical-severity issue (smuggling / header-injection / multi-@
  // / mixed-script) MUST refuse — sanitize re-runs the critical
  // detector and throws when it finds one, but we surface the
  // failure here with a precise error so callers don't have to
  // distinguish "validate said no" from "sanitize said no".
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("customers: email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("customers: email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("customers: email — " + (e && e.message || "refused"));
  }
  // Local-part is case-preserved per RFC 5321 but virtually every
  // operator-facing system folds it; the namespaceHash needs a
  // single canonical form. Lowercase the domain at minimum — the
  // local-part we leave untouched to honor RFC 5321 sensitivity for
  // operators whose mailbox is case-significant.
  var at = canonical.lastIndexOf("@");
  if (at !== -1) {
    canonical = canonical.slice(0, at) + "@" + canonical.slice(at + 1).toLowerCase();
  }
  return canonical;
}

function _displayName(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("customers: display_name must be a non-empty string");
  }
  if (s.length > MAX_DISPLAY_NAME_LEN) {
    throw new TypeError("customers: display_name must be <= " + MAX_DISPLAY_NAME_LEN + " characters");
  }
  textGuard.freeText(s, "customers: display_name", { singleLine: "reject", bidiMarks: "allow" });
  return s;
}

function _opaqueField(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("customers: " + label + " must be a non-empty string");
  }
  if (Buffer.byteLength(s, "utf8") > MAX_CRED_FIELD_BYTES) {
    throw new TypeError("customers: " + label + " exceeds " + MAX_CRED_FIELD_BYTES + " bytes");
  }
  return s;
}

function _transports(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string") {
    throw new TypeError("customers: transports must be a string (comma-separated tokens)");
  }
  if (!TRANSPORTS_RE.test(s)) {
    throw new TypeError("customers: transports must be lowercase letters with comma separators");
  }
  return s;
}

function _counter(n) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("customers: counter must be a non-negative integer");
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
  // Pagination cursors for `list` are HMAC-tagged via b.pagination so an
  // operator can't hand-craft one to skip past a row or replay across
  // deployments. The secret defaults to a dev-only placeholder so the
  // primitive boots in tests; the deployment supplies a derived value
  // (typically b.crypto.namespaceHash("customers-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("customers.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "customers-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _hashEmail(email) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, email);
  }

  // Monotonic upsert of the per-customer session-revocation boundary. The
  // INSERT-OR-conflict keeps the LATER of the existing and incoming value
  // so two concurrent revokes (erasure + a passkey-revoke firing together)
  // can never roll the boundary backwards and resurrect a cookie one of
  // them meant to kill. `MAX(...)` on the conflict path is the conservation
  // guard; `excluded` references the row the INSERT tried to add.
  async function _bumpSessionRevocation(id, at) {
    await query(
      "INSERT INTO customer_session_revocations (customer_id, sessions_valid_from, updated_at) " +
      "VALUES (?1, ?2, ?2) " +
      "ON CONFLICT(customer_id) DO UPDATE SET " +
      "sessions_valid_from = MAX(customer_session_revocations.sessions_valid_from, excluded.sessions_valid_from), " +
      "updated_at = excluded.updated_at",
      [id, at],
    );
  }

  var api = {
    EMAIL_NAMESPACE: EMAIL_NAMESPACE,

    // Hash an email without writing — useful for login lookups
    // where the caller already validated the address against the
    // storefront's input contract and just needs the lookup key.
    hashEmail: function (email) {
      return _hashEmail(_normalizeEmail(email));
    },

    register: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customers.register: input object required");
      }
      var canonicalEmail = _normalizeEmail(input.email);
      var displayName    = _displayName(input.display_name);
      var emailHash      = _hashEmail(canonicalEmail);

      var existing = (await query(
        "SELECT id FROM customers WHERE email_hash = ?1 LIMIT 1",
        [emailHash],
      )).rows[0];
      if (existing) {
        var err = new Error("customers.register: address already registered");
        err.code = "CUSTOMER_DUPLICATE";
        throw err;
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?4)",
        [id, emailHash, displayName, ts],
      );
      return {
        id:           id,
        email_hash:   emailHash,
        display_name: displayName,
        created_at:   ts,
        updated_at:   ts,
      };
    },

    // Create an account AND enroll its first passkey as one logical unit.
    // The passwordless register-finish flow defers account creation to a
    // verified WebAuthn ceremony; creating the customer and the credential
    // must not split, or a passkey-insert failure (transient write error, a
    // duplicate credential id) would leave an empty, credential-less account
    // behind — re-creating the very email-squat the deferred flow prevents.
    // D1 has no interactive transaction, so this composes register +
    // addPasskey and COMPENSATES by deleting the just-created row when the
    // enroll fails. The new row has no related data yet (no passkey, oauth,
    // cart, or order), so the delete is clean and frees the email again.
    registerWithPasskey: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customers.registerWithPasskey: input object required");
      }
      if (!input.passkey || typeof input.passkey !== "object") {
        throw new TypeError("customers.registerWithPasskey: passkey object required");
      }
      var customer = await api.register({ email: input.email, display_name: input.display_name });
      var passkey;
      try {
        passkey = await api.addPasskey(customer.id, input.passkey);
      } catch (e) {
        try {
          await query("DELETE FROM customers WHERE id = ?1", [customer.id]);
        } catch (_eDel) { /* best-effort compensation — rethrow the real cause below */ }
        throw e;
      }
      return { customer: customer, passkey: passkey };
    },

    get: async function (id) {
      _uuid(id, "customer id");
      var r = await query("SELECT * FROM customers WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    byEmailHash: async function (hash) {
      if (typeof hash !== "string" || !hash.length) {
        throw new TypeError("customers.byEmailHash: hash must be a non-empty string");
      }
      var r = await query("SELECT * FROM customers WHERE email_hash = ?1 LIMIT 1", [hash]);
      return r.rows[0] || null;
    },

    // Operator-facing paginated list of customers, newest first by
    // (created_at, id). Tuple cursor (created_at, id) ordered DESC —
    // mirrors order.listForCustomer's HMAC-tagged cursor shape (same
    // b.pagination tag, same orderKey mismatch-on-tamper refusal). The
    // raw email is never stored, so rows carry only the displayable
    // columns (id, email_hash, display_name, created_at, updated_at).
    // Returns { rows, next_cursor }.
    list: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("customers.list: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("customers.list: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(CUSTOMERS_ORDER_KEY)) {
            throw new TypeError("customers.list: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("customers.list: cursor — " + (e && e.message || "malformed"));
        }
      }
      var sql, params;
      // Fetch one row beyond the page so the next cursor is emitted ONLY
      // when a customer past this page actually exists. Keying the cursor
      // off a full page alone (rows.length === limit) advertises a
      // phantom next page when the roster size is an exact multiple of
      // the limit — the console's "Next page" link then lands empty.
      if (cursorVals) {
        sql = "SELECT id, email_hash, display_name, created_at, updated_at FROM customers " +
              "WHERE (created_at < ?1 OR (created_at = ?1 AND id < ?2)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?3";
        params = [cursorVals[0], cursorVals[1], limit + 1];
      } else {
        sql = "SELECT id, email_hash, display_name, created_at, updated_at FROM customers " +
              "ORDER BY created_at DESC, id DESC LIMIT ?1";
        params = [limit + 1];
      }
      var fetched = (await query(sql, params)).rows;
      var hasMore = fetched.length > limit;
      var rows    = hasMore ? fetched.slice(0, limit) : fetched;
      var last = rows[rows.length - 1];
      var next = null;
      if (last && hasMore) {
        next = b.pagination.encodeCursor({
          orderKey: CUSTOMERS_ORDER_KEY,
          vals:     [last.created_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    // Per-customer sign-in method counts WITHOUT an N+1: two bounded
    // `IN (...)` aggregates over the passkey + oauth tables, returning
    // { passkeys: {customer_id: count}, oauth: {customer_id: [provider,...]} }.
    // Callers pass the (already-paginated) page's customer ids; an empty
    // list short-circuits to empty maps so the SQL never sees `IN ()`.
    signInMethodsByCustomer: async function (customerIds) {
      if (!Array.isArray(customerIds)) {
        throw new TypeError("customers.signInMethodsByCustomer: customerIds must be an array");
      }
      var passkeys = {}, oauth = {};
      if (customerIds.length === 0) return { passkeys: passkeys, oauth: oauth };
      var placeholders = customerIds.map(function (_id, i) { return "?" + (i + 1); }).join(", ");
      var pk = (await query(
        "SELECT customer_id, COUNT(*) AS n FROM customer_passkeys " +
        "WHERE customer_id IN (" + placeholders + ") GROUP BY customer_id",
        customerIds,
      )).rows;
      for (var i = 0; i < pk.length; i += 1) passkeys[pk[i].customer_id] = Number(pk[i].n);
      var oa = (await query(
        "SELECT customer_id, provider FROM customer_oauth_identities " +
        "WHERE customer_id IN (" + placeholders + ") ORDER BY provider ASC",
        customerIds,
      )).rows;
      for (var j = 0; j < oa.length; j += 1) {
        if (!oauth[oa[j].customer_id]) oauth[oa[j].customer_id] = [];
        oauth[oa[j].customer_id].push(oa[j].provider);
      }
      return { passkeys: passkeys, oauth: oauth };
    },

    // ---- federated (OAuth / OIDC) sign-in -------------------------------

    // The customer linked to an external (provider, subject) identity, or
    // null. `subject` is the IdP `sub` claim — the durable account key.
    byOAuthIdentity: async function (provider, subject) {
      if (OAUTH_PROVIDERS.indexOf(provider) === -1) {
        throw new TypeError("customers.byOAuthIdentity: unknown provider " + JSON.stringify(provider));
      }
      if (typeof subject !== "string" || !subject.length || subject.length > 255) {
        throw new TypeError("customers.byOAuthIdentity: subject must be a non-empty string ≤ 255 chars");
      }
      var r = await query(
        "SELECT c.* FROM customers c " +
        "JOIN customer_oauth_identities i ON i.customer_id = c.id " +
        "WHERE i.provider = ?1 AND i.subject = ?2 LIMIT 1",
        [provider, subject],
      );
      return r.rows[0] || null;
    },

    // True when the account has proven control of its email — i.e. it carries
    // at least one OAuth identity the IdP marked email_verified. This is the
    // ONLY account-creation path that proves the email: register /
    // registerWithPasskey store whatever address was typed with no ownership
    // proof, so a passkey-registered (or otherwise unverified) account returns
    // false here. Used to gate the OIDC email-hash merge against account
    // pre-hijacking (see signInWithOIDC step 2).
    hasVerifiedOAuthEmail: async function (customerId) {
      _uuid(customerId, "customer id");
      var r = await query(
        "SELECT 1 FROM customer_oauth_identities " +
        "WHERE customer_id = ?1 AND email_verified = 1 LIMIT 1",
        [customerId],
      );
      return r.rows.length > 0;
    },

    // Resolve (or create) the customer for a verified OIDC sign-in.
    // Resolution order, per standard federated-identity discipline:
    //   1. an existing (provider, subject) link → that customer (the
    //      durable key; email changes don't break it);
    //   2. else, ONLY when the IdP verified the email, an existing
    //      customer with that email_hash → link the identity to it;
    //   3. else register a new customer + link.
    // Never links to an existing account on an UNVERIFIED email (that
    // would be account takeover). Returns { customer, created,
    // linked_via }.
    signInWithOIDC: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customers.signInWithOIDC: input object required");
      }
      var provider = input.provider;
      if (OAUTH_PROVIDERS.indexOf(provider) === -1) {
        throw new TypeError("customers.signInWithOIDC: unknown provider " + JSON.stringify(provider));
      }
      var subject = input.subject;
      if (typeof subject !== "string" || !subject.length || subject.length > 255) {
        throw new TypeError("customers.signInWithOIDC: subject must be a non-empty string ≤ 255 chars");
      }
      var emailVerified  = input.email_verified === true;
      var canonicalEmail = input.email ? _normalizeEmail(input.email) : null;
      var ts = _now();

      // (1) Existing federated link — refresh the captured email + flag.
      var existing = await api.byOAuthIdentity(provider, subject);
      if (existing) {
        await query(
          "UPDATE customer_oauth_identities SET email = ?1, email_verified = ?2, updated_at = ?3 " +
          "WHERE provider = ?4 AND subject = ?5",
          [canonicalEmail, emailVerified ? 1 : 0, ts, provider, subject],
        );
        return { customer: existing, created: false, linked_via: "oauth-subject" };
      }

      // (2) Link to an existing customer — verified email only, AND only when
      // that pre-existing account has ITSELF proven control of the email (it
      // already carries a verified OAuth identity). Checking that the INCOMING
      // IdP email is verified is not enough: register / registerWithPasskey
      // store whatever address was typed with no ownership proof, so an
      // attacker can pre-seed a passkey account under the victim's email and
      // then capture the victim's later Google/Apple sign-in when it auto-
      // merged into that account. An unverified pre-existing account falls
      // through to the duplicate-email conflict in step (3) instead — the
      // victim signs in with their existing method and links the provider from
      // account settings.
      var customer = null, linkedVia = null, created = false;
      if (emailVerified && canonicalEmail) {
        var candidate = await api.byEmailHash(_hashEmail(canonicalEmail));
        if (candidate && await api.hasVerifiedOAuthEmail(candidate.id)) {
          customer  = candidate;
          linkedVia = "verified-email";
        }
      }

      // (3) New account. Reaching here with a duplicate email means the
      // address already belongs to an account but step (2) declined to
      // link it — i.e. the IdP did NOT verify the email. Refuse rather
      // than link (account takeover) or create a colliding row.
      if (!customer) {
        if (!canonicalEmail) {
          throw new TypeError("customers.signInWithOIDC: an email is required to create a new account");
        }
        var displayName = input.display_name || canonicalEmail.split("@")[0] || "Customer";
        try {
          customer = await api.register({ email: canonicalEmail, display_name: displayName });
        } catch (e) {
          if (e && e.code === "CUSTOMER_DUPLICATE") {
            var conflict = new Error("customers.signInWithOIDC: that email is registered to another account and " + provider + " has not verified it — sign in with your existing method or verify the email first");
            conflict.code = "OAUTH_EMAIL_UNVERIFIED_CONFLICT";
            throw conflict;
          }
          throw e;
        }
        linkedVia = "new";
        created   = true;
      }

      await query(
        "INSERT INTO customer_oauth_identities " +
        "(id, customer_id, provider, subject, email, email_verified, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        [b.uuid.v7(), customer.id, provider, subject, canonicalEmail, emailVerified ? 1 : 0, ts],
      );
      return { customer: customer, created: created, linked_via: linkedVia };
    },

    listPasskeys: async function (customerId) {
      _uuid(customerId, "customer id");
      var r = await query(
        "SELECT * FROM customer_passkeys WHERE customer_id = ?1 ORDER BY created_at ASC",
        [customerId],
      );
      return r.rows;
    },

    addPasskey: async function (customerId, input) {
      _uuid(customerId, "customer id");
      if (!input || typeof input !== "object") {
        throw new TypeError("customers.addPasskey: input object required");
      }
      var credentialId = _opaqueField(input.credential_id, "credential_id");
      var publicKey    = _opaqueField(input.public_key,    "public_key");
      var counter      = _counter(input.counter);
      var transports   = _transports(input.transports);

      // Refuse duplicate credential_id (matches the table's UNIQUE
      // index — surface a typed error before D1 raises).
      var existing = (await query(
        "SELECT id FROM customer_passkeys WHERE credential_id = ?1 LIMIT 1",
        [credentialId],
      )).rows[0];
      if (existing) {
        var err = new Error("customers.addPasskey: credential already registered");
        err.code = "PASSKEY_DUPLICATE";
        throw err;
      }

      var owner = (await query("SELECT id FROM customers WHERE id = ?1", [customerId])).rows[0];
      if (!owner) {
        throw new TypeError("customers.addPasskey: customer " + customerId + " not found");
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO customer_passkeys (id, customer_id, credential_id, public_key, counter, transports, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, customerId, credentialId, publicKey, counter, transports, ts],
      );
      await query("UPDATE customers SET updated_at = ?1 WHERE id = ?2", [ts, customerId]);
      return {
        id:            id,
        customer_id:   customerId,
        credential_id: credentialId,
        public_key:    publicKey,
        counter:       counter,
        transports:    transports,
        created_at:    ts,
      };
    },

    getPasskeyByCredentialId: async function (credentialId) {
      if (typeof credentialId !== "string" || !credentialId.length) {
        throw new TypeError("customers.getPasskeyByCredentialId: credential_id must be a non-empty string");
      }
      var r = await query(
        "SELECT * FROM customer_passkeys WHERE credential_id = ?1 LIMIT 1",
        [credentialId],
      );
      return r.rows[0] || null;
    },

    // Update the WebAuthn signature counter after a successful
    // assertion. Refuses non-monotonic updates (the counter must
    // strictly increase per WebAuthn L3 §6.1.1; equal-or-decreasing
    // values indicate a cloned credential).
    updatePasskeyCounter: async function (passkeyId, newCounter) {
      _uuid(passkeyId, "passkey id");
      if (!Number.isInteger(newCounter) || newCounter < 0) {
        throw new TypeError("customers.updatePasskeyCounter: counter must be a non-negative integer");
      }
      var existing = (await query(
        "SELECT counter FROM customer_passkeys WHERE id = ?1",
        [passkeyId],
      )).rows[0];
      if (!existing) return null;
      if (newCounter === 0) {
        // WebAuthn L3 §6.1.1 — sign-count of 0 is the
        // authenticator-doesn't-implement-a-counter signal. Skip
        // the monotonic check AND skip the write so the previously
        // observed counter (if any) is retained.
        var row0 = (await query("SELECT * FROM customer_passkeys WHERE id = ?1", [passkeyId])).rows[0];
        return row0;
      }
      if (newCounter <= existing.counter) {
        var err = new Error("customers.updatePasskeyCounter: counter regression (possible clone)");
        err.code = "PASSKEY_COUNTER_REGRESSION";
        throw err;
      }
      await query(
        "UPDATE customer_passkeys SET counter = ?1 WHERE id = ?2",
        [newCounter, passkeyId],
      );
      var row = (await query("SELECT * FROM customer_passkeys WHERE id = ?1", [passkeyId])).rows[0];
      return row;
    },

    // Revoke an enrolled credential, scoped to its owner. The customer
    // id is part of the WHERE clause (not just the lookup) so a forged or
    // guessed passkey id belonging to ANOTHER customer is a silent no-op
    // rather than a cross-customer deletion — the route layer hands us the
    // authed customer id, and a credential only disappears when both keys
    // agree. Idempotent: returns true when a row was removed, false when
    // nothing matched (already-removed id, or an id owned by someone else).
    removePasskey: async function (customerId, passkeyId) {
      _uuid(customerId, "customer id");
      _uuid(passkeyId, "passkey id");
      var row = (await query(
        "SELECT id FROM customer_passkeys WHERE id = ?1 AND customer_id = ?2",
        [passkeyId, customerId],
      )).rows[0];
      if (!row) return false;
      await query(
        "DELETE FROM customer_passkeys WHERE id = ?1 AND customer_id = ?2",
        [passkeyId, customerId],
      );
      await query("UPDATE customers SET updated_at = ?1 WHERE id = ?2", [_now(), customerId]);
      return true;
    },

    // Right-to-erasure auth revocation. A subject-access deletion must
    // leave the customer UNABLE TO SIGN BACK IN — anonymizing the profile
    // row alone is not erasure if every login credential still resolves.
    // This deletes the THREE durable sign-in credentials keyed to the
    // customer and severs the magic-link lookup key in ONE call:
    //
    //   * customer_passkeys           — every enrolled WebAuthn authenticator
    //                                    (passkey sign-in resolves a credential
    //                                    to this id; gone, the assertion misses).
    //   * customer_oauth_identities   — every federated link (Google / Apple
    //                                    OIDC resolves byOAuthIdentity to this
    //                                    id; gone, the federated sign-in creates
    //                                    a fresh unrelated account instead).
    //   * email_hash -> tombstone     — the magic-link / guest-order-claim path
    //                                    resolves byEmailHash; overwriting the
    //                                    hash with a per-id, non-reversible
    //                                    tombstone means no future link for the
    //                                    erased address can ever resolve this row
    //                                    (the address itself is never stored, so
    //                                    there is no plaintext to scrub — only
    //                                    the lookup key to break).
    //
    // The sealed 14-day auth cookie is stateless (no server session row to
    // kill), but with no credential left to re-mint it and no lookup key to
    // re-issue a magic link, the account cannot be re-entered after the
    // cookie expires; the live customer-portal sessions are revoked
    // separately by the caller (customerPortal.revokeAllForCustomer). Each
    // step is idempotent — re-running on an already-erased row deletes
    // nothing more and returns zero counts. dry_run reports the counts the
    // wet run WOULD remove without mutating, so the operator preview shows
    // the blast radius. Returns `{ passkeys, oauth_identities, email_hash_cleared }`.
    eraseAuthForCustomer: async function (id, opts) {
      _uuid(id, "customer id");
      var dryRun = !!(opts && opts.dry_run);
      var pkRows = (await query(
        "SELECT COUNT(*) AS n FROM customer_passkeys WHERE customer_id = ?1", [id],
      )).rows[0];
      var oaRows = (await query(
        "SELECT COUNT(*) AS n FROM customer_oauth_identities WHERE customer_id = ?1", [id],
      )).rows[0];
      var existing = (await query("SELECT email_hash FROM customers WHERE id = ?1", [id])).rows[0];
      var emailHashSet = !!(existing && existing.email_hash && String(existing.email_hash).indexOf("erased:") !== 0);
      if (dryRun) {
        return {
          passkeys:            pkRows ? Number(pkRows.n) : 0,
          oauth_identities:    oaRows ? Number(oaRows.n) : 0,
          email_hash_cleared:  emailHashSet ? 1 : 0,
        };
      }
      var ts = _now();
      var pkDel = await query("DELETE FROM customer_passkeys WHERE customer_id = ?1", [id]);
      var oaDel = await query("DELETE FROM customer_oauth_identities WHERE customer_id = ?1", [id]);
      // Tombstone the lookup key with a per-id, non-reversible value that
      // can never collide with a real namespaceHash digest (those are hex)
      // and can never be re-derived from any email address. Only rewrite a
      // live (non-tombstoned) hash so a re-run is a no-op.
      var emailHashCleared = 0;
      if (emailHashSet) {
        var tombstone = "erased:" + b.crypto.namespaceHash("customer-erased-email", id);
        var upd = await query(
          "UPDATE customers SET email_hash = ?1, updated_at = ?2 WHERE id = ?3 AND email_hash = ?4",
          [tombstone, ts, id, existing.email_hash],
        );
        emailHashCleared = Number((upd && upd.rowCount) || 0);
      }
      // Terminate every live sealed auth cookie for the erased account.
      // Deleting the durable credentials stops a NEW session from being
      // minted, but a cookie issued before erasure is stateless and stays
      // valid for its 14-day TTL — so the anonymized account remains usable
      // until then unless we move the revocation boundary forward now.
      await _bumpSessionRevocation(id, ts);
      return {
        passkeys:            Number((pkDel && pkDel.rowCount) || 0),
        oauth_identities:    Number((oaDel && oaDel.rowCount) || 0),
        email_hash_cleared:  emailHashCleared,
      };
    },

    // Move the customer's session-revocation boundary to `at` (default
    // now). Every sealed auth cookie whose `iat` predates the boundary —
    // and every pre-`iat` cookie once a boundary exists — fails the
    // revocation check on its next authenticated request and signs out.
    // Idempotent and monotonic: a later bump only ever moves the boundary
    // forward, so two concurrent revokes can't roll it backwards. Called by
    // the storefront's explicit sign-out (POST /account/logout) so a sealed
    // cookie copied before sign-out can't outlive it. Erasure moves the same
    // boundary forward directly via _bumpSessionRevocation
    // (eraseAuthForCustomer), so an erased account's live cookies die too.
    revokeSessionsForCustomer: async function (id, at) {
      _uuid(id, "customer id");
      var boundary = (at == null) ? _now() : at;
      if (!Number.isInteger(boundary) || boundary < 0) {
        throw new TypeError("customers.revokeSessionsForCustomer: at must be a non-negative integer epoch-ms or null");
      }
      await _bumpSessionRevocation(id, boundary);
      return { customer_id: id, sessions_valid_from: boundary };
    },

    // The customer's session-revocation boundary (epoch-ms), or 0 when no
    // revocation has ever been recorded (the default-allow state). The
    // auth-cookie reader compares the cookie's `iat` against this: a cookie
    // is live when the boundary is 0, or when its `iat` is >= the boundary.
    sessionsValidFrom: async function (id) {
      _uuid(id, "customer id");
      var row = (await query(
        "SELECT sessions_valid_from FROM customer_session_revocations WHERE customer_id = ?1 LIMIT 1",
        [id],
      )).rows[0];
      return row ? Number(row.sessions_valid_from) : 0;
    },

    // Mutate a customer's editable profile fields. v1 covers display_name
    // only — the one field a customer can safely change without a
    // verification round trip.
    //
    // Email is deliberately NOT updatable here. The address is stored
    // hash-only (raw never lands in D1) AND it's the OAuth account-linking
    // key: signInWithOIDC links a federated identity to an existing
    // customer ONLY on a provider-verified email match, so silently
    // re-pointing email_hash would let a customer claim a federated login
    // that belongs to a different address — an account-takeover vector.
    // A correct email change needs a proof-of-control ceremony (mail a
    // one-time code to the NEW address, confirm, only then re-derive the
    // hash). No transactional-mail surface is wired into the storefront
    // yet, so shipping an unverified email change would be the
    // half-measure the no-MVP rule forbids. Re-open when an outbound-mail
    // primitive lands: add `verifyEmailChange` (issue + confirm token) and
    // let `update` accept `email` only behind a confirmed token. A caller
    // that passes `email` today is refused with a typed error so the gap
    // is loud, never silent.
    update: async function (id, patch) {
      _uuid(id, "customer id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("customers.update: patch object required");
      }
      if (Object.prototype.hasOwnProperty.call(patch, "email")) {
        var emailErr = new Error("customers.update: email cannot be changed without a verification ceremony — not supported in this build");
        emailErr.code = "EMAIL_CHANGE_UNSUPPORTED";
        throw emailErr;
      }
      var sets = [];
      var params = [];
      var p = 1;
      if (Object.prototype.hasOwnProperty.call(patch, "display_name")) {
        var displayName = _displayName(patch.display_name);
        sets.push("display_name = ?" + p); params.push(displayName); p += 1;
      }
      if (sets.length === 0) {
        throw new TypeError("customers.update: nothing to update (display_name is the only mutable field)");
      }
      var owner = (await query("SELECT id FROM customers WHERE id = ?1", [id])).rows[0];
      if (!owner) {
        throw new TypeError("customers.update: customer " + id + " not found");
      }
      var ts = _now();
      sets.push("updated_at = ?" + p); params.push(ts); p += 1;
      params.push(id);
      await query(
        "UPDATE customers SET " + sets.join(", ") + " WHERE id = ?" + p,
        params,
      );
      return (await query("SELECT * FROM customers WHERE id = ?1", [id])).rows[0];
    },
  };
  return api;
}

// "Sign in with Apple" requires the OAuth client secret to be an
// ES256-signed JWT — Apple's protocol mandates ECDSA P-256, the one
// signature in this codebase that is NOT the PQC default (the framework
// ships no ES256 signer by design). It's an external-protocol constraint,
// not an application default, exactly like a Stripe/PayPal webhook
// signature: the remote party dictates the algorithm. Minted from the
// team's `.p8` EC private key:
//   header  { alg:"ES256", kid:<key_id> }
//   payload { iss:<team_id>, iat, exp, aud:"https://appleid.apple.com", sub:<client_id> }
// Returns the compact JWS to hand to `b.auth.oauth.create({ clientSecret })`.
// `ttl_seconds` defaults to 150 days (inside Apple's 180-day ceiling); the
// secret is re-minted on the next process start, so a normal deploy
// cadence refreshes it well within the window. A config-time / entry-point
// helper — THROWS on bad input so a misconfigured `.p8` fails at boot.
function mintAppleClientSecret(opts) {
  opts = opts || {};
  var teamId        = opts.team_id;
  var keyId         = opts.key_id;
  var clientId      = opts.client_id;
  var privateKeyPem = opts.private_key;   // .p8 contents (PKCS#8 PEM)
  if (!teamId || !keyId || !clientId || !privateKeyPem) {
    throw new TypeError("mintAppleClientSecret: team_id, key_id, client_id, private_key are all required");
  }
  // Apple's exp/iat are unix SECONDS, so derive the default from C.TIME
  // (the single duration source of truth, in ms) rather than a hand-rolled
  // literal: 150 days, inside Apple's 180-day ceiling.
  var ttl = opts.ttl_seconds == null ? b.constants.TIME.days(150) / 1000 : opts.ttl_seconds;
  if (typeof ttl !== "number" || !isFinite(ttl) || ttl <= 0 || ttl > 15777000) {
    throw new TypeError("mintAppleClientSecret: ttl_seconds must be 1..15777000 (Apple's 6-month maximum)");
  }
  var key;
  try { key = nodeCrypto.createPrivateKey(privateKeyPem); }
  catch (e) { throw new TypeError("mintAppleClientSecret: private_key is not a valid PEM key — " + (e && e.message || e)); }
  if (key.asymmetricKeyType !== "ec") {
    throw new TypeError("mintAppleClientSecret: private_key must be an EC P-256 (.p8) key, got " + key.asymmetricKeyType);
  }
  var now     = Math.floor(Date.now() / 1000);
  var header  = { alg: "ES256", kid: keyId };
  var payload = { iss: teamId, iat: now, exp: now + ttl, aud: "https://appleid.apple.com", sub: clientId };
  var b64u = b.crypto.toBase64Url;
  var signingInput = b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload));
  // ES256 = ECDSA P-256 over SHA-256, JOSE-encoded as raw r||s (IEEE
  // P1363), not the DER node emits by default — `dsaEncoding` selects it.
  var sig = nodeCrypto.sign("sha256", Buffer.from(signingInput), { key: key, dsaEncoding: "ieee-p1363" });
  return signingInput + "." + b64u(sig);
}

module.exports = {
  create:                  create,
  mintAppleClientSecret:   mintAppleClientSecret,
  EMAIL_NAMESPACE:         EMAIL_NAMESPACE,
  MAX_DISPLAY_NAME_LEN:    MAX_DISPLAY_NAME_LEN,
  MAX_CRED_FIELD_BYTES:    MAX_CRED_FIELD_BYTES,
};
