-- Wishlist sharing: share-a-wishlist links + group / family
-- wishlists. Distinct from gift registry (which is event-bound and
-- carries occasion + purchase aggregation). The sharing primitive
-- layers on top of the existing `wishlist_entries` table — every
-- entry remains keyed to one customer_id; sharing surfaces an
-- owner's entries to a viewer or a group of co-owners without
-- duplicating row identity.
--
-- Four tables:
--
--   * `wishlist_shares` — one row per share link the owner has
--     minted. `token_hash` is the SHA3-512 of the 32-byte base64url
--     plaintext token (under the `wishlist-share-token` namespace),
--     stored UNIQUE. The plaintext is shown EXACTLY ONCE at
--     `createShareLink` time and never persisted — `viewShared` /
--     `recordView` re-hash and look up. `privacy` is the share-time
--     visibility (public / unlisted / friends_only); `expires_at`
--     and `revoked_at` are independent reasons the link stops
--     resolving. `view_count` is the running aggregate so the owner
--     sees "n views" without scanning the per-view table.
--
--   * `wishlist_groups` — one row per group / family wishlist the
--     owner has created. Co-owners share write access to the
--     underlying wishlist entries via the `wishlist_group_members`
--     join. `archived_at` soft-retires a group so historical reads
--     still resolve but new joins refuse.
--
--   * `wishlist_group_members` — owner + invited customers who can
--     read / write the group wishlist. `role` is owner / member —
--     exactly one owner per group (the creator); members join via
--     the group's plaintext invite token. UNIQUE (wishlist_id,
--     customer_id) refuses a double-join.
--
--   * `wishlist_share_views` — append-only audit trail of who viewed
--     a share link. `viewer_session_id_hash` is the SHA3-512 of the
--     viewer's session id (under a per-share namespace) so the
--     owner's analytics don't carry a raw session identifier. NULL
--     when the viewer has no session (logged-out direct hit).

CREATE TABLE IF NOT EXISTS wishlist_shares (
  id                 TEXT    NOT NULL PRIMARY KEY,
  owner_customer_id  TEXT    NOT NULL,
  token_hash         TEXT    NOT NULL UNIQUE,
  title              TEXT    NOT NULL DEFAULT '',
  privacy            TEXT    NOT NULL CHECK (privacy IN ('public', 'unlisted', 'friends_only')),
  expires_at         INTEGER,
  view_count         INTEGER NOT NULL DEFAULT 0,
  revoked_at         INTEGER,
  revoked_reason     TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wishlist_shares_owner   ON wishlist_shares(owner_customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wishlist_shares_active  ON wishlist_shares(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS wishlist_groups (
  id                 TEXT    NOT NULL PRIMARY KEY,
  owner_customer_id  TEXT    NOT NULL,
  title              TEXT    NOT NULL,
  token_hash         TEXT    NOT NULL UNIQUE,
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wishlist_groups_owner   ON wishlist_groups(owner_customer_id, created_at);

CREATE TABLE IF NOT EXISTS wishlist_group_members (
  id            TEXT    NOT NULL PRIMARY KEY,
  wishlist_id   TEXT    NOT NULL,
  customer_id   TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('owner', 'member')),
  invite_email  TEXT,
  joined_at     INTEGER NOT NULL,
  FOREIGN KEY (wishlist_id) REFERENCES wishlist_groups(id) ON DELETE CASCADE,
  UNIQUE (wishlist_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_group_members_wishlist ON wishlist_group_members(wishlist_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_group_members_customer ON wishlist_group_members(customer_id);

CREATE TABLE IF NOT EXISTS wishlist_share_views (
  id                       TEXT    NOT NULL PRIMARY KEY,
  share_id                 TEXT    NOT NULL,
  viewer_session_id_hash   TEXT,
  occurred_at              INTEGER NOT NULL,
  FOREIGN KEY (share_id) REFERENCES wishlist_shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wishlist_share_views_share ON wishlist_share_views(share_id, occurred_at);
