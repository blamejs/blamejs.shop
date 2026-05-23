"use strict";
/**
 * wishlist-sharing — share-a-wishlist links + group/family
 * wishlists, layered on top of the existing wishlist primitive.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations 0012
 * (wishlist) + 0150 (sharing).
 *
 * Coverage:
 *   - createShareLink: returns plaintext token exactly once; storage
 *     row carries only the hash; row defaults (view_count=0,
 *     revoked_at=NULL) are set.
 *   - viewShared: resolves an unlisted / public token, surfaces the
 *     owner's wishlist entries; refuses on `friends_only` without
 *     viewer_customer_id; honours expires_at.
 *   - revokeShareLink: revokes a link; subsequent viewShared /
 *     recordView refuse with WISHLIST_SHARE_REVOKED; second revoke
 *     is idempotent.
 *   - recordView: increments the view counter, persists a hashed
 *     session breadcrumb when provided, leaves it NULL otherwise.
 *   - createGroupWishlist: persists the group + owner member row;
 *     returns a plaintext invite token; captures invited_emails;
 *     refuses bad email shape.
 *   - joinGroupWishlist: resolves the token, materialises a member
 *     row; UNIQUE(wishlist_id, customer_id) refuses a double-join.
 *   - leaveGroupWishlist: deletes the member row; owner can't leave
 *     their own group; re-leave returns removed:false.
 *   - listSharesForOwner / groupWishlistsForCustomer: surface the
 *     owner's / member's view.
 *   - validation: every entry point refuses bad input shape.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var wishlistSharing  = require("../../lib/wishlist-sharing");
var wishlistMod      = require("../../lib/wishlist");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG_WISHLIST = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0012_wishlist.sql");
var MIG_SHARING  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0150_wishlist_sharing.sql");

function _splitSchema(text) {
  // Strip line comments before splitting on `;` so a `--` line
  // doesn't comment out the closing paren of a CREATE TABLE.
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_WISHLIST, MIG_SHARING].forEach(function (path) {
    _splitSchema(nodeFs.readFileSync(path, "utf8")).forEach(function (s) {
      db.prepare(s).run();
    });
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return {
          rows:      [],
          rowCount:  Number(info.changes),
          lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _factory() {
  var h = _makeQuery();
  var wishlist = wishlistMod.create({ query: h.query });
  return {
    db:       h.db,
    query:    h.query,
    wishlist: wishlist,
    sharing:  wishlistSharing.create({ query: h.query, wishlist: wishlist }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- tests --------------------------------------------------------------

async function _createShareLinkShape() {
  var f = _factory();
  var ownerId = _uuid();

  var ret = await f.sharing.createShareLink({
    owner_customer_id: ownerId,
    title:             "My birthday wishlist",
    privacy:           "unlisted",
  });

  check("createShareLink returns id",         typeof ret.id === "string" && ret.id.length === 36);
  check("createShareLink owner persisted",    ret.owner_customer_id === ownerId);
  check("createShareLink title persisted",    ret.title === "My birthday wishlist");
  check("createShareLink privacy persisted",  ret.privacy === "unlisted");
  check("createShareLink expires null",       ret.expires_at === null);
  check("createShareLink created_at set",     typeof ret.created_at === "number");
  check("createShareLink plaintext returned",  typeof ret.plaintext_token === "string"
                                                 && /^[A-Za-z0-9_-]{43}$/.test(ret.plaintext_token));

  // Storage row carries only the hash — never the plaintext.
  var rawRow = f.db.prepare("SELECT * FROM wishlist_shares WHERE id = ?").all(ret.id)[0];
  check("storage row exists",                 rawRow && rawRow.id === ret.id);
  check("storage row hashes token",            typeof rawRow.token_hash === "string"
                                                 && rawRow.token_hash.length > 0
                                                 && rawRow.token_hash !== ret.plaintext_token);
  check("storage row view_count zero",         Number(rawRow.view_count) === 0);
  check("storage row revoked_at null",         rawRow.revoked_at === null);
  check("storage row no plaintext column",     rawRow.plaintext_token === undefined);

  // listSharesForOwner surfaces it.
  var owned = await f.sharing.listSharesForOwner(ownerId);
  check("listSharesForOwner returns share",    owned.length === 1 && owned[0].id === ret.id);

  // listSharesForOwner for an unrelated customer returns empty.
  var otherOwned = await f.sharing.listSharesForOwner(_uuid());
  check("listSharesForOwner unrelated empty",  otherOwned.length === 0);
}

async function _viewSharedResolvesPrivacy() {
  var f = _factory();
  var ownerId = _uuid();

  // Seed the owner's wishlist with two entries.
  var prod1 = _uuid();
  var prod2 = _uuid();
  await f.wishlist.add({ customer_id: ownerId, product_id: prod1 });
  await f.wishlist.add({ customer_id: ownerId, product_id: prod2 });

  // Public share.
  var publicShare = await f.sharing.createShareLink({
    owner_customer_id: ownerId,
    title:             "Public list",
    privacy:           "public",
  });
  var publicView = await f.sharing.viewShared({ token: publicShare.plaintext_token });
  check("viewShared public surfaces entries",  Array.isArray(publicView.entries) && publicView.entries.length === 2);
  check("viewShared owner exposed",            publicView.share.owner_customer_id === ownerId);
  check("viewShared title exposed",            publicView.share.title === "Public list");
  check("viewShared privacy exposed",          publicView.share.privacy === "public");

  // Unlisted: same shape, resolves on token possession.
  var unlistedShare = await f.sharing.createShareLink({
    owner_customer_id: ownerId,
    title:             "Unlisted list",
    privacy:           "unlisted",
  });
  var unlistedView = await f.sharing.viewShared({ token: unlistedShare.plaintext_token });
  check("viewShared unlisted resolves",        unlistedView.entries.length === 2);

  // friends_only without viewer_customer_id refuses.
  var friendsShare = await f.sharing.createShareLink({
    owner_customer_id: ownerId,
    title:             "Close friends list",
    privacy:           "friends_only",
  });
  await assert.rejects(
    f.sharing.viewShared({ token: friendsShare.plaintext_token }),
    function (err) {
      return err && err.code === "WISHLIST_SHARE_FRIENDS_ONLY";
    },
  );

  // friends_only with a viewer id resolves.
  var friendView = await f.sharing.viewShared({
    token:               friendsShare.plaintext_token,
    viewer_customer_id:  _uuid(),
  });
  check("viewShared friends_only with id ok",  friendView.entries.length === 2);

  // Unknown token refuses.
  await assert.rejects(
    f.sharing.viewShared({ token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
    function (err) {
      return err && err.code === "WISHLIST_SHARE_NOT_FOUND";
    },
  );

  // Expired share refuses.
  var pastExpiry = Date.now() - 60 * 1000;
  var expiredShare = await f.sharing.createShareLink({
    owner_customer_id: ownerId,
    title:             "Expired",
    privacy:           "public",
    expires_at:        pastExpiry,
  });
  await assert.rejects(
    f.sharing.viewShared({ token: expiredShare.plaintext_token }),
    function (err) {
      return err && err.code === "WISHLIST_SHARE_EXPIRED";
    },
  );
}

async function _revokeBlocksSubsequentViews() {
  var f = _factory();
  var ownerId = _uuid();
  await f.wishlist.add({ customer_id: ownerId, product_id: _uuid() });

  var share = await f.sharing.createShareLink({
    owner_customer_id: ownerId,
    title:             "To revoke",
    privacy:           "public",
  });

  // Pre-revoke: resolves.
  var preView = await f.sharing.viewShared({ token: share.plaintext_token });
  check("pre-revoke view ok",                  preView.entries.length === 1);

  // Revoke.
  var revoked = await f.sharing.revokeShareLink({
    link_id: share.id,
    reason:  "Operator detected leaked link in a public Discord",
  });
  check("revoke sets revoked_at",              typeof revoked.revoked_at === "number");
  check("revoke records reason",                /leaked link/.test(revoked.revoked_reason));

  // Subsequent viewShared refuses.
  await assert.rejects(
    f.sharing.viewShared({ token: share.plaintext_token }),
    function (err) {
      return err && err.code === "WISHLIST_SHARE_REVOKED";
    },
  );

  // Subsequent recordView refuses.
  await assert.rejects(
    f.sharing.recordView({ token: share.plaintext_token }),
    function (err) {
      return err && err.code === "WISHLIST_SHARE_REVOKED";
    },
  );

  // Idempotent second revoke returns the existing row, doesn't push
  // a new revoked_at.
  var second = await f.sharing.revokeShareLink({
    link_id: share.id,
    reason:  "still revoked",
  });
  check("revoke idempotent",                   second.revoked_at === revoked.revoked_at);

  // Unknown link returns null.
  var miss = await f.sharing.revokeShareLink({
    link_id: _uuid(),
    reason:  "never existed",
  });
  check("revoke unknown null",                  miss === null);
}

async function _recordViewIncrementsCounter() {
  var f = _factory();
  var ownerId = _uuid();
  await f.wishlist.add({ customer_id: ownerId, product_id: _uuid() });

  var share = await f.sharing.createShareLink({
    owner_customer_id: ownerId,
    title:             "Tracked",
    privacy:           "public",
  });

  // Three views: two with sessions (same session, then a new
  // session), one anonymous.
  await f.sharing.recordView({ token: share.plaintext_token, viewer_session_id: "session-A" });
  await f.sharing.recordView({ token: share.plaintext_token, viewer_session_id: "session-A" });
  await f.sharing.recordView({ token: share.plaintext_token, viewer_session_id: "session-B" });
  await f.sharing.recordView({ token: share.plaintext_token });

  var rows = f.db.prepare("SELECT * FROM wishlist_share_views WHERE share_id = ? ORDER BY occurred_at ASC").all(share.id);
  check("recordView persisted 4 rows",          rows.length === 4);
  check("recordView session-A hashed",          rows[0].viewer_session_id_hash && rows[0].viewer_session_id_hash !== "session-A");
  check("recordView anon NULL",                 rows[3].viewer_session_id_hash === null);

  var share2 = f.db.prepare("SELECT view_count FROM wishlist_shares WHERE id = ?").all(share.id)[0];
  check("view_count incremented to 4",          Number(share2.view_count) === 4);

  // viewShared exposes the latest view_count.
  var view = await f.sharing.viewShared({ token: share.plaintext_token });
  check("viewShared exposes view_count",        view.share.view_count === 4);

  // recordView on unknown token refuses.
  await assert.rejects(
    f.sharing.recordView({ token: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }),
    function (err) {
      return err && err.code === "WISHLIST_SHARE_NOT_FOUND";
    },
  );
}

async function _groupWishlistFlow() {
  var f = _factory();
  var ownerId  = _uuid();
  var memberA  = _uuid();
  var memberB  = _uuid();

  var group = await f.sharing.createGroupWishlist({
    owner_customer_id: ownerId,
    title:             "Smith Family",
    member_emails:     ["alice@example.com", "bob@example.com"],
  });
  check("createGroupWishlist id",               typeof group.id === "string" && group.id.length === 36);
  check("createGroupWishlist title",            group.title === "Smith Family");
  check("createGroupWishlist invited",          group.invited_emails.length === 2);
  check("createGroupWishlist plaintext token",   /^[A-Za-z0-9_-]{43}$/.test(group.plaintext_token));

  // Owner row materialised.
  var members = await f.sharing.listGroupMembers(group.id);
  check("owner member row exists",              members.length === 1
                                                  && members[0].customer_id === ownerId
                                                  && members[0].role === "owner");

  // Member A joins.
  var joinedA = await f.sharing.joinGroupWishlist({
    token:       group.plaintext_token,
    customer_id: memberA,
  });
  check("memberA joined",                       joinedA.role === "member"
                                                  && joinedA.customer_id === memberA);

  // Member B joins.
  await f.sharing.joinGroupWishlist({
    token:       group.plaintext_token,
    customer_id: memberB,
  });

  // Three members now (owner + A + B).
  var after = await f.sharing.listGroupMembers(group.id);
  check("three member rows",                    after.length === 3);

  // UNIQUE refusal: memberA joining again.
  await assert.rejects(
    f.sharing.joinGroupWishlist({
      token:       group.plaintext_token,
      customer_id: memberA,
    }),
    function (err) {
      return err && err.code === "WISHLIST_GROUP_ALREADY_JOINED";
    },
  );

  // Owner trying to "join" their own group is also refused (already
  // a member with role=owner).
  await assert.rejects(
    f.sharing.joinGroupWishlist({
      token:       group.plaintext_token,
      customer_id: ownerId,
    }),
    function (err) {
      return err && err.code === "WISHLIST_GROUP_ALREADY_JOINED";
    },
  );

  // Unknown token refuses.
  await assert.rejects(
    f.sharing.joinGroupWishlist({
      token:       "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      customer_id: _uuid(),
    }),
    function (err) {
      return err && err.code === "WISHLIST_GROUP_NOT_FOUND";
    },
  );

  // groupWishlistsForCustomer for memberA returns the group with the
  // member's role + joined_at.
  var memberView = await f.sharing.groupWishlistsForCustomer(memberA);
  check("groupWishlistsForCustomer for member", memberView.length === 1
                                                  && memberView[0].id === group.id
                                                  && memberView[0].role === "member"
                                                  && typeof memberView[0].joined_at === "number");

  // groupWishlistsForCustomer for owner returns the same group with
  // role=owner.
  var ownerView = await f.sharing.groupWishlistsForCustomer(ownerId);
  check("groupWishlistsForCustomer for owner",  ownerView.length === 1
                                                  && ownerView[0].role === "owner");
}

async function _leaveGroupWishlist() {
  var f = _factory();
  var ownerId = _uuid();
  var memberA = _uuid();

  var group = await f.sharing.createGroupWishlist({
    owner_customer_id: ownerId,
    title:             "Test Group",
  });
  await f.sharing.joinGroupWishlist({
    token:       group.plaintext_token,
    customer_id: memberA,
  });

  // Member leaves.
  var left = await f.sharing.leaveGroupWishlist({
    wishlist_id: group.id,
    customer_id: memberA,
  });
  check("leaveGroupWishlist removed",           left.removed === true);

  // Membership row gone — groupWishlistsForCustomer no longer
  // returns it for memberA.
  var afterLeave = await f.sharing.groupWishlistsForCustomer(memberA);
  check("memberA no longer in group",           afterLeave.length === 0);

  // Owner row still there.
  var ownerView = await f.sharing.groupWishlistsForCustomer(ownerId);
  check("owner still in group",                 ownerView.length === 1);

  // Re-leave returns removed:false.
  var second = await f.sharing.leaveGroupWishlist({
    wishlist_id: group.id,
    customer_id: memberA,
  });
  check("re-leave removed false",                second.removed === false);

  // Owner can't leave their own group.
  await assert.rejects(
    f.sharing.leaveGroupWishlist({
      wishlist_id: group.id,
      customer_id: ownerId,
    }),
    /owner cannot leave/,
  );

  // Unrelated customer's "leave" is a quiet no-op (no membership
  // row, removed:false).
  var stranger = await f.sharing.leaveGroupWishlist({
    wishlist_id: group.id,
    customer_id: _uuid(),
  });
  check("stranger leave removed false",          stranger.removed === false);
}

async function _validation() {
  var f = _factory();
  var ownerId = _uuid();

  // createShareLink
  await assert.rejects(f.sharing.createShareLink(),                                              /input object required/);
  await assert.rejects(f.sharing.createShareLink({}),                                            /owner_customer_id/);
  await assert.rejects(f.sharing.createShareLink({ owner_customer_id: "not-uuid", privacy: "public" }), /owner_customer_id/);
  await assert.rejects(f.sharing.createShareLink({ owner_customer_id: ownerId, privacy: "bogus" }), /privacy/);
  await assert.rejects(f.sharing.createShareLink({
    owner_customer_id: ownerId,
    privacy:           "public",
    expires_at:        -1,
  }), /expires_at/);
  await assert.rejects(f.sharing.createShareLink({
    owner_customer_id: ownerId,
    privacy:           "public",
    title:             "badtitle",
  }), /title/);

  // revokeShareLink
  await assert.rejects(f.sharing.revokeShareLink(),                                              /input object required/);
  await assert.rejects(f.sharing.revokeShareLink({ link_id: "not-uuid", reason: "x" }),          /link_id/);
  await assert.rejects(f.sharing.revokeShareLink({ link_id: _uuid(), reason: "" }),              /reason/);
  await assert.rejects(f.sharing.revokeShareLink({ link_id: _uuid() }),                          /reason/);

  // viewShared
  await assert.rejects(f.sharing.viewShared(),                                                   /input object required/);
  await assert.rejects(f.sharing.viewShared({ token: "too-short" }),                             /token/);
  await assert.rejects(f.sharing.viewShared({ token: 42 }),                                      /token/);

  // recordView
  await assert.rejects(f.sharing.recordView(),                                                   /input object required/);
  await assert.rejects(f.sharing.recordView({ token: "too-short" }),                             /token/);

  // createGroupWishlist
  await assert.rejects(f.sharing.createGroupWishlist(),                                          /input object required/);
  await assert.rejects(f.sharing.createGroupWishlist({}),                                        /owner_customer_id/);
  await assert.rejects(f.sharing.createGroupWishlist({ owner_customer_id: ownerId }),            /title/);
  await assert.rejects(f.sharing.createGroupWishlist({
    owner_customer_id: ownerId,
    title:             "ok",
    member_emails:     ["not-an-email"],
  }), /member_emails/);
  await assert.rejects(f.sharing.createGroupWishlist({
    owner_customer_id: ownerId,
    title:             "ok",
    member_emails:     ["a@b.com", "a@b.com"],
  }), /duplicates/);

  // joinGroupWishlist
  await assert.rejects(f.sharing.joinGroupWishlist(),                                            /input object required/);
  await assert.rejects(f.sharing.joinGroupWishlist({ token: "too-short", customer_id: ownerId }), /token/);
  await assert.rejects(f.sharing.joinGroupWishlist({
    token:       "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    customer_id: "not-uuid",
  }), /customer_id/);

  // leaveGroupWishlist
  await assert.rejects(f.sharing.leaveGroupWishlist(),                                           /input object required/);
  await assert.rejects(f.sharing.leaveGroupWishlist({ wishlist_id: "not-uuid", customer_id: ownerId }), /wishlist_id/);
  await assert.rejects(f.sharing.leaveGroupWishlist({ wishlist_id: _uuid(), customer_id: "not-uuid" }), /customer_id/);

  // groupWishlistsForCustomer
  await assert.rejects(f.sharing.groupWishlistsForCustomer("not-uuid"),                          /customer_id/);

  // listSharesForOwner
  await assert.rejects(f.sharing.listSharesForOwner("not-uuid"),                                  /customer_id/);

  // listGroupMembers
  await assert.rejects(f.sharing.listGroupMembers("not-uuid"),                                    /wishlist_id/);
}

async function _exportedConstants() {
  check("PRIVACIES exported",                  Array.isArray(wishlistSharing.PRIVACIES)
                                                 && wishlistSharing.PRIVACIES.indexOf("public") !== -1
                                                 && wishlistSharing.PRIVACIES.indexOf("unlisted") !== -1
                                                 && wishlistSharing.PRIVACIES.indexOf("friends_only") !== -1);
  check("ROLES exported",                      Array.isArray(wishlistSharing.ROLES)
                                                 && wishlistSharing.ROLES.indexOf("owner") !== -1
                                                 && wishlistSharing.ROLES.indexOf("member") !== -1);

  var inst = wishlistSharing.create({ query: _makeQuery().query });
  check("instance exposes PRIVACIES",          inst.PRIVACIES.length === 3);
  check("instance exposes ROLES",              inst.ROLES.length === 2);
}

async function run() {
  await _createShareLinkShape();
  await _viewSharedResolvesPrivacy();
  await _revokeBlocksSubsequentViews();
  await _recordViewIncrementsCounter();
  await _groupWishlistFlow();
  await _leaveGroupWishlist();
  await _validation();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - wishlist-sharing (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
