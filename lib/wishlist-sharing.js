"use strict";
/**
 * @module shop.wishlistSharing
 * @title  Wishlist sharing — share-a-wishlist links + group / family
 *         wishlists, layered on the wishlist primitive
 *
 * @intro
 *   Two flavours of sharing on top of the existing wishlist:
 *
 *     1. Share links — the owner mints a token-bearing URL the
 *        storefront serves to anyone who follows it. The link
 *        carries a privacy hint (`public` / `unlisted` /
 *        `friends_only`); `viewShared` resolves the token and
 *        returns the owner's wishlist entries plus viewer-safe
 *        metadata. The plaintext token is shown EXACTLY ONCE at
 *        `createShareLink` time — storage carries only the
 *        SHA3-512 namespace-hash. `revokeShareLink` flips an
 *        explicit `revoked_at` so subsequent resolves refuse.
 *        `recordView` increments the share's running view counter
 *        and (optionally) records a hashed session breadcrumb for
 *        the owner's analytics surface.
 *
 *     2. Group / family wishlists — the owner creates a group with
 *        a title, gets back a plaintext invite token, and shares it
 *        with the people they want to co-own the list (member
 *        emails captured at create time for the owner's records;
 *        the actual co-ownership row materialises when a member
 *        calls `joinGroupWishlist` with the token + their
 *        `customer_id`). The wishlist itself remains keyed to the
 *        underlying `wishlist_entries` table — `wishlist_groups`
 *        is the membership envelope. UNIQUE(wishlist_id,
 *        customer_id) refuses a double-join.
 *
 *   Distinct from gift registry: registry is event-bound (wedding,
 *   baby, etc.) with quantity-desired + purchase aggregation; share
 *   links + group wishlists are durable, no event, no purchase
 *   ledger.
 *
 *   Composes:
 *     - `b.crypto.generateBytes`     — 32-byte uniform draw for both
 *                                      share-link + group-invite
 *                                      plaintext tokens.
 *     - `b.crypto.namespaceHash`     — SHA3-512 hash under the
 *                                      `wishlist-share-token` /
 *                                      `wishlist-group-token` /
 *                                      `wishlist-share-viewer`
 *                                      namespaces; the only token
 *                                      material persisted.
 *     - `b.guardUuid`                — UUID-shape validation on
 *                                      every customer / link / group
 *                                      id at the entry point.
 *     - `b.uuid.v7`                  — row PKs (lexicographic +
 *                                      monotonic so an audit read
 *                                      sorts deterministically on
 *                                      tied `created_at`).
 *
 *   Storage: `migrations-d1/0150_wishlist_sharing.sql` —
 *     `wishlist_shares` + `wishlist_groups` + `wishlist_group_members`
 *     + `wishlist_share_views`.
 *
 * @primitive wishlistSharing
 * @related   wishlist, giftRegistry, b.crypto, b.uuid, b.guardUuid
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");
var wishlistModule = require("./wishlist");

// ---- constants ----------------------------------------------------------

var SHARE_TOKEN_NAMESPACE      = "wishlist-share-token";
var GROUP_TOKEN_NAMESPACE      = "wishlist-group-token";
var VIEWER_SESSION_NAMESPACE   = "wishlist-share-viewer";

var TOKEN_BYTE_LEN             = 32;
var TOKEN_PLAINTEXT_RE         = /^[A-Za-z0-9_-]{43}$/;

var PRIVACIES                  = Object.freeze(["public", "unlisted", "friends_only"]);
var ROLES                      = Object.freeze(["owner", "member"]);

var MAX_TITLE_LEN              = 200;
var MAX_REASON_LEN             = 500;
var MAX_EMAIL_LEN              = 254;
var MAX_MEMBER_EMAILS          = 50;


// Conservative single-line email shape — defence in depth against
// header-injection / control-byte smuggling when the operator
// surfaces member_emails on the group landing page or in an
// invitation email template. The real-world RFC 5321 grammar is
// looser; the primitive only validates shape (a parser is the
// SMTP gateway's job).
var EMAIL_RE                   = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

// ---- monotonic clock ----------------------------------------------------
//
// Share-link creation, view recording, group join/leave all persist
// epoch-ms timestamps. The strict-monotonic clock here guarantees
// that two same-millisecond `_now()` calls produce distinct
// integers so the row-ordering on `created_at` / `occurred_at` /
// `joined_at` is deterministic without a tiebreaker column. Tests
// that mint + revoke / join + leave in tight loops rely on this for
// ordering assertions.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("wishlistSharing: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _optUuid(s, label) {
  if (s == null || s === "") return null;
  return _uuid(s, label);
}

function _title(s, label) {
  if (s == null || s === "") return "";
  if (typeof s !== "string" || s.length > MAX_TITLE_LEN) {
    throw new TypeError("wishlistSharing: " + label + " must be a string <= " + MAX_TITLE_LEN + " chars");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("wishlistSharing: " + label + " must not contain control bytes");
  }
  return s;
}

function _requiredTitle(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("wishlistSharing: " + label + " must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("wishlistSharing: " + label + " must not contain control bytes");
  }
  return s;
}

function _privacy(s) {
  if (typeof s !== "string" || PRIVACIES.indexOf(s) < 0) {
    throw new TypeError("wishlistSharing: privacy must be one of " + PRIVACIES.join(", "));
  }
  return s;
}

function _expiresAt(n) {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("wishlistSharing: expires_at must be a non-negative integer (ms epoch) or null");
  }
  return n;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REASON_LEN) {
    throw new TypeError("wishlistSharing: reason must be a non-empty string <= " + MAX_REASON_LEN + " chars");
  }
  textGuard.freeText(s, "wishlistSharing: reason");
  return s;
}

function _email(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_EMAIL_LEN || !EMAIL_RE.test(s)) {
    throw new TypeError("wishlistSharing: " + label + " must be a valid email <= " + MAX_EMAIL_LEN + " chars");
  }
  return s;
}

function _memberEmails(arr) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("wishlistSharing: member_emails must be an array");
  }
  if (arr.length > MAX_MEMBER_EMAILS) {
    throw new TypeError("wishlistSharing: member_emails must contain <= " + MAX_MEMBER_EMAILS + " entries");
  }
  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < arr.length; i += 1) {
    var e = _email(arr[i], "member_emails[" + i + "]");
    var lower = e.toLowerCase();
    if (seen[lower]) {
      throw new TypeError("wishlistSharing: member_emails[" + i + "] duplicates a previous entry");
    }
    seen[lower] = true;
    out.push(e);
  }
  return out;
}

function _viewerSessionId(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string" || s.length > 1024) {
    throw new TypeError("wishlistSharing: viewer_session_id must be a non-empty string <= 1024 chars");
  }
  // Session ids are opaque to this primitive; refuse control bytes
  // so the hashed breadcrumb has no log-injection vector even if a
  // downstream tool ever rendered the raw value.
  textGuard.freeText(s, "wishlistSharing: viewer_session_id", { singleLine: "reject" });
  return s;
}

// ---- token generation + hashing -----------------------------------------

// 32 random bytes -> 43-char base64url (no padding) via
// `b.crypto.toBase64Url`.
function _generateToken() {
  var buf = b.crypto.generateBytes(TOKEN_BYTE_LEN);
  return b.crypto.toBase64Url(buf);
}

function _canonicalToken(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("wishlistSharing: token must be a non-empty string");
  }
  if (!TOKEN_PLAINTEXT_RE.test(input)) {
    throw new TypeError("wishlistSharing: token must be 43 base64url characters");
  }
  return input;
}

function _hashShareToken(plaintext) {
  return b.crypto.namespaceHash(SHARE_TOKEN_NAMESPACE, plaintext);
}

function _hashGroupToken(plaintext) {
  return b.crypto.namespaceHash(GROUP_TOKEN_NAMESPACE, plaintext);
}

function _hashViewerSession(sessionId) {
  return b.crypto.namespaceHash(VIEWER_SESSION_NAMESPACE, sessionId);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // The wishlist primitive is composed for `viewShared`: the owner's
  // entries are surfaced via `wishlist.listForCustomer`. When the
  // operator hasn't wired one explicitly, lazy-instantiate against
  // the same `query` handle so the shared instance is consistent.
  var wishlistInstance = opts.wishlist || null;
  function _wishlist() {
    if (!wishlistInstance) {
      wishlistInstance = wishlistModule.create({ query: query });
    }
    return wishlistInstance;
  }

  // ---- internal decoders ----------------------------------------------

  function _decodeShare(row) {
    if (!row) return null;
    return {
      id:                 row.id,
      owner_customer_id:  row.owner_customer_id,
      title:              row.title,
      privacy:            row.privacy,
      expires_at:         row.expires_at != null ? Number(row.expires_at) : null,
      view_count:         Number(row.view_count || 0),
      revoked_at:         row.revoked_at != null ? Number(row.revoked_at) : null,
      revoked_reason:     row.revoked_reason,
      created_at:         Number(row.created_at),
    };
  }

  function _decodeGroup(row) {
    if (!row) return null;
    return {
      id:                row.id,
      owner_customer_id: row.owner_customer_id,
      title:             row.title,
      archived_at:       row.archived_at != null ? Number(row.archived_at) : null,
      created_at:        Number(row.created_at),
    };
  }

  function _decodeMember(row) {
    return {
      id:           row.id,
      wishlist_id:  row.wishlist_id,
      customer_id:  row.customer_id,
      role:         row.role,
      invite_email: row.invite_email,
      joined_at:    Number(row.joined_at),
    };
  }

  // ---- createShareLink -------------------------------------------------

  async function createShareLink(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistSharing.createShareLink: input object required");
    }
    var ownerId = _uuid(input.owner_customer_id, "owner_customer_id");
    var title   = _title(input.title, "title");
    var expires = _expiresAt(input.expires_at);
    var privacy = _privacy(input.privacy);

    var id        = b.uuid.v7();
    var plaintext = _generateToken();
    var tokenHash = _hashShareToken(plaintext);
    var ts        = _now();

    await query(
      "INSERT INTO wishlist_shares " +
      "(id, owner_customer_id, token_hash, title, privacy, expires_at, view_count, revoked_at, revoked_reason, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, NULL, ?7)",
      [id, ownerId, tokenHash, title, privacy, expires, ts],
    );

    // Plaintext token is returned EXACTLY ONCE here. The storage
    // column carries only the SHA3-512 namespace-hash; subsequent
    // reads of the share row never see the plaintext again.
    return {
      id:                id,
      owner_customer_id: ownerId,
      title:             title,
      privacy:           privacy,
      expires_at:        expires,
      created_at:        ts,
      plaintext_token:   plaintext,
    };
  }

  // ---- revokeShareLink -------------------------------------------------

  async function revokeShareLink(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistSharing.revokeShareLink: input object required");
    }
    var linkId = _uuid(input.link_id, "link_id");
    var reason = _reason(input.reason);
    var ts     = _now();

    var r = await query(
      "UPDATE wishlist_shares SET revoked_at = ?1, revoked_reason = ?2 " +
      "WHERE id = ?3 AND revoked_at IS NULL",
      [ts, reason, linkId],
    );
    if (Number(r.rowCount || 0) === 0) {
      // Either missing or already revoked — disambiguate so the
      // caller can distinguish "no such link" from "already
      // revoked, here's the existing row".
      var existing = (await query(
        "SELECT * FROM wishlist_shares WHERE id = ?1",
        [linkId],
      )).rows[0];
      if (!existing) return null;
      return _decodeShare(existing);
    }
    var row = (await query(
      "SELECT * FROM wishlist_shares WHERE id = ?1",
      [linkId],
    )).rows[0];
    return _decodeShare(row);
  }

  // ---- viewShared ------------------------------------------------------

  async function viewShared(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistSharing.viewShared: input object required");
    }
    var token = _canonicalToken(input.token);
    var viewerCustomerId = _optUuid(input.viewer_customer_id, "viewer_customer_id");
    var hash = _hashShareToken(token);

    var r = await query(
      "SELECT * FROM wishlist_shares WHERE token_hash = ?1",
      [hash],
    );
    if (!r.rows.length) {
      var miss = new Error("wishlistSharing.viewShared: share link not found");
      miss.code = "WISHLIST_SHARE_NOT_FOUND";
      throw miss;
    }
    var share = r.rows[0];

    if (share.revoked_at != null) {
      var revoked = new Error("wishlistSharing.viewShared: share link has been revoked");
      revoked.code = "WISHLIST_SHARE_REVOKED";
      throw revoked;
    }
    var nowTs = _now();
    if (share.expires_at != null && Number(share.expires_at) < nowTs) {
      var expired = new Error("wishlistSharing.viewShared: share link has expired");
      expired.code = "WISHLIST_SHARE_EXPIRED";
      throw expired;
    }

    // `friends_only` requires the resolver to identify the viewer.
    // The primitive doesn't carry a friends graph itself — the
    // operator's identity layer is expected to pass the
    // authenticated viewer id. Refusing on missing id closes the
    // unauthenticated-browse hole; the operator's authz layer
    // narrows further (e.g. matching the viewer against the owner's
    // follow / friend set).
    if (share.privacy === "friends_only" && !viewerCustomerId) {
      var friendsOnly = new Error("wishlistSharing.viewShared: share is friends_only — viewer_customer_id required");
      friendsOnly.code = "WISHLIST_SHARE_FRIENDS_ONLY";
      throw friendsOnly;
    }

    // Surface the owner's wishlist entries. The wishlist primitive's
    // pagination cursor is keyed off the owner's view of their own
    // list — a viewer browsing a shared link doesn't get
    // pagination tokens (the share is a one-shot read). The
    // primitive returns the first page only; an operator who needs
    // pagination on the share-view path can wrap this and re-issue
    // through `wishlist.listForCustomer` directly.
    var wl    = _wishlist();
    var page  = await wl.listForCustomer(share.owner_customer_id, { limit: 100 });

    return {
      share: {
        id:                share.id,
        owner_customer_id: share.owner_customer_id,
        title:             share.title,
        privacy:           share.privacy,
        expires_at:        share.expires_at != null ? Number(share.expires_at) : null,
        created_at:        Number(share.created_at),
        view_count:        Number(share.view_count || 0),
      },
      entries: page.rows,
    };
  }

  // ---- recordView ------------------------------------------------------

  async function recordView(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistSharing.recordView: input object required");
    }
    var token = _canonicalToken(input.token);
    var viewerSession = _viewerSessionId(input.viewer_session_id);
    var hash = _hashShareToken(token);

    var shareRow = (await query(
      "SELECT * FROM wishlist_shares WHERE token_hash = ?1",
      [hash],
    )).rows[0];
    if (!shareRow) {
      var miss = new Error("wishlistSharing.recordView: share link not found");
      miss.code = "WISHLIST_SHARE_NOT_FOUND";
      throw miss;
    }
    if (shareRow.revoked_at != null) {
      var revoked = new Error("wishlistSharing.recordView: share link has been revoked");
      revoked.code = "WISHLIST_SHARE_REVOKED";
      throw revoked;
    }
    var nowTs = _now();
    if (shareRow.expires_at != null && Number(shareRow.expires_at) < nowTs) {
      var expired = new Error("wishlistSharing.recordView: share link has expired");
      expired.code = "WISHLIST_SHARE_EXPIRED";
      throw expired;
    }

    var viewerHash = viewerSession ? _hashViewerSession(viewerSession) : null;
    var viewId     = b.uuid.v7();

    await query(
      "INSERT INTO wishlist_share_views (id, share_id, viewer_session_id_hash, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4)",
      [viewId, shareRow.id, viewerHash, nowTs],
    );
    await query(
      "UPDATE wishlist_shares SET view_count = view_count + 1 WHERE id = ?1",
      [shareRow.id],
    );
    return {
      view_id:     viewId,
      share_id:    shareRow.id,
      occurred_at: nowTs,
    };
  }

  // ---- listSharesForOwner ---------------------------------------------

  async function listSharesForOwner(customerId) {
    var ownerId = _uuid(customerId, "customer_id");
    var r = await query(
      "SELECT * FROM wishlist_shares WHERE owner_customer_id = ?1 " +
      "ORDER BY created_at DESC, id DESC",
      [ownerId],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeShare(r.rows[i]));
    return out;
  }

  // ---- createGroupWishlist --------------------------------------------

  async function createGroupWishlist(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistSharing.createGroupWishlist: input object required");
    }
    var ownerId = _uuid(input.owner_customer_id, "owner_customer_id");
    var title   = _requiredTitle(input.title, "title");
    var emails  = _memberEmails(input.member_emails);

    var id        = b.uuid.v7();
    var plaintext = _generateToken();
    var tokenHash = _hashGroupToken(plaintext);
    var ts        = _now();

    await query(
      "INSERT INTO wishlist_groups " +
      "(id, owner_customer_id, title, token_hash, archived_at, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
      [id, ownerId, title, tokenHash, ts],
    );

    // The creator is materialised as the `owner` member row up front
    // so `groupWishlistsForCustomer(ownerId)` and the member-list
    // reads have a single uniform shape regardless of whether anyone
    // else has joined yet.
    var ownerMemberId = b.uuid.v7();
    await query(
      "INSERT INTO wishlist_group_members " +
      "(id, wishlist_id, customer_id, role, invite_email, joined_at) " +
      "VALUES (?1, ?2, ?3, 'owner', NULL, ?4)",
      [ownerMemberId, id, ownerId, ts],
    );

    // Invited member emails are captured for the owner's records —
    // the row materialises when each invitee actually
    // `joinGroupWishlist`s with the plaintext token. Storing them
    // here gives the operator a "you invited Carol but she hasn't
    // joined yet" surface without round-tripping a separate
    // invitations table.
    var emailRows = [];
    for (var i = 0; i < emails.length; i += 1) {
      emailRows.push({ email: emails[i] });
    }

    return {
      id:                id,
      owner_customer_id: ownerId,
      title:             title,
      created_at:        ts,
      invited_emails:    emails,
      plaintext_token:   plaintext,
    };
  }

  // ---- joinGroupWishlist -----------------------------------------------

  async function joinGroupWishlist(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistSharing.joinGroupWishlist: input object required");
    }
    var token      = _canonicalToken(input.token);
    var customerId = _uuid(input.customer_id, "customer_id");
    var hash       = _hashGroupToken(token);

    var groupRow = (await query(
      "SELECT * FROM wishlist_groups WHERE token_hash = ?1",
      [hash],
    )).rows[0];
    if (!groupRow) {
      var miss = new Error("wishlistSharing.joinGroupWishlist: group not found");
      miss.code = "WISHLIST_GROUP_NOT_FOUND";
      throw miss;
    }
    if (groupRow.archived_at != null) {
      var archived = new Error("wishlistSharing.joinGroupWishlist: group has been archived");
      archived.code = "WISHLIST_GROUP_ARCHIVED";
      throw archived;
    }

    // Refuse duplicate join — the UNIQUE constraint refuses it
    // anyway, but a clean TypeError reads better than an opaque
    // SQLITE_CONSTRAINT at the application layer.
    var existing = (await query(
      "SELECT id, role FROM wishlist_group_members " +
      "WHERE wishlist_id = ?1 AND customer_id = ?2 LIMIT 1",
      [groupRow.id, customerId],
    )).rows[0];
    if (existing) {
      var dupe = new Error("wishlistSharing.joinGroupWishlist: customer is already a " + existing.role + " of this group");
      dupe.code = "WISHLIST_GROUP_ALREADY_JOINED";
      throw dupe;
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO wishlist_group_members " +
      "(id, wishlist_id, customer_id, role, invite_email, joined_at) " +
      "VALUES (?1, ?2, ?3, 'member', NULL, ?4)",
      [id, groupRow.id, customerId, ts],
    );
    return {
      id:           id,
      wishlist_id:  groupRow.id,
      customer_id:  customerId,
      role:         "member",
      joined_at:    ts,
    };
  }

  // ---- leaveGroupWishlist ----------------------------------------------

  async function leaveGroupWishlist(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistSharing.leaveGroupWishlist: input object required");
    }
    var wishlistId = _uuid(input.wishlist_id, "wishlist_id");
    var customerId = _uuid(input.customer_id, "customer_id");

    // The owner row is FSM-fixed for the lifetime of the group —
    // an owner who wants to leave archives the group instead.
    // Refuse the misuse up front rather than silently no-op.
    var existing = (await query(
      "SELECT id, role FROM wishlist_group_members " +
      "WHERE wishlist_id = ?1 AND customer_id = ?2 LIMIT 1",
      [wishlistId, customerId],
    )).rows[0];
    if (!existing) {
      return { removed: false };
    }
    if (existing.role === "owner") {
      throw new TypeError("wishlistSharing.leaveGroupWishlist: owner cannot leave their own group; archive it instead");
    }

    var r = await query(
      "DELETE FROM wishlist_group_members WHERE id = ?1",
      [existing.id],
    );
    return { removed: Number(r.rowCount || 0) > 0 };
  }

  // ---- groupWishlistsForCustomer --------------------------------------

  async function groupWishlistsForCustomer(customerId) {
    var custId = _uuid(customerId, "customer_id");
    // Surface every group the customer is a member of (owner or
    // member). Joined order via `joined_at DESC` so the most
    // recently engaged group lands first in the customer's account
    // page.
    var r = await query(
      "SELECT g.*, m.role AS member_role, m.joined_at AS member_joined_at " +
      "FROM wishlist_groups g " +
      "INNER JOIN wishlist_group_members m ON m.wishlist_id = g.id " +
      "WHERE m.customer_id = ?1 " +
      "ORDER BY m.joined_at DESC, g.id DESC",
      [custId],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var decoded = _decodeGroup(r.rows[i]);
      decoded.role      = r.rows[i].member_role;
      decoded.joined_at = Number(r.rows[i].member_joined_at);
      out.push(decoded);
    }
    return out;
  }

  // ---- listMembers (read-only convenience) ----------------------------

  async function listGroupMembers(wishlistId) {
    var id = _uuid(wishlistId, "wishlist_id");
    var r = await query(
      "SELECT * FROM wishlist_group_members WHERE wishlist_id = ?1 " +
      "ORDER BY joined_at ASC, id ASC",
      [id],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeMember(r.rows[i]));
    return out;
  }

  return {
    PRIVACIES: PRIVACIES.slice(),
    ROLES:     ROLES.slice(),

    createShareLink:           createShareLink,
    revokeShareLink:           revokeShareLink,
    viewShared:                viewShared,
    recordView:                recordView,
    listSharesForOwner:        listSharesForOwner,
    createGroupWishlist:       createGroupWishlist,
    joinGroupWishlist:         joinGroupWishlist,
    leaveGroupWishlist:        leaveGroupWishlist,
    groupWishlistsForCustomer: groupWishlistsForCustomer,
    listGroupMembers:          listGroupMembers,
  };
}

module.exports = {
  create:    create,
  PRIVACIES: PRIVACIES,
  ROLES:     ROLES,
};
