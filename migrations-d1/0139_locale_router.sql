-- Storefront locale routing.
--
-- The shop renders one storefront in many languages. An incoming
-- request to the homepage of a multi-locale storefront answers a
-- single question first: *which locale do I render this page in*.
-- The operator declares a routing policy (one of five strategies)
-- and the primitive walks the request hints in a documented
-- precedence to land on a locale tag, with a fallback chain when
-- the picked locale isn't in the policy's supported list.
--
-- Schema decisions:
--
--   * `locales_defined` is the catalog of locales the operator has
--     declared. The primary key is the BCP-47 tag (e.g. "en",
--     "en-US", "de-DE", "fr-CA"). `kind` is a CHECK-bounded enum:
--       primary  — a stand-alone locale (e.g. "en", "de")
--       regional — a country-narrowed locale (e.g. "en-US", "fr-CA")
--       variant  — a script / orthography variant (e.g. "sr-Latn",
--                  "zh-Hans")
--     `fallback` is nullable; when set it MUST reference another
--     `locales_defined.tag`. The application layer enforces the FK
--     (D1 does not run foreign-key checks in the workflow we ship
--     under) and ALSO refuses fallback chains that loop. `currency`
--     is the ISO 4217 default for the locale (operators routinely
--     want a "the locale picker also flips currency" semantic).
--     `active` is a 0/1 flag so archived locales survive for audit
--     replay; `archived_at` is non-NULL iff `active = 0`.
--
--   * `locale_policies` is the operator's routing-strategy catalog.
--     A storefront can carry multiple policies (one per surface —
--     marketing site, app, help center) but at most one is active at
--     a time. `strategy` is a CHECK-bounded enum:
--       url_prefix              — /en/, /de/, /fr-ca/
--       subdomain               — de.example.com, en.example.com
--       cookie                  — operator-set cookie (the cookie
--                                 name comes from the application
--                                 layer; the primitive only consumes
--                                 the value as a request hint)
--       accept_language_only    — no URL / cookie hint; honor only
--                                 the browser's Accept-Language
--       customer_preference     — logged-in buyer's pref wins over
--                                 every other signal
--     `default_locale` references `locales_defined.tag` (FK enforced
--     at the application layer) and is the policy's fallback when
--     none of the resolution sources land on a supported locale.
--     `supported_locales_json` is a JSON array of `locales_defined.
--     tag` values; the resolver refuses to return a locale outside
--     this list. `is_active` is a 0/1 flag with a partial-unique
--     index — at most one policy may carry `is_active = 1` at a
--     time. `archived_at` is non-NULL iff the policy was archived.
--
--   * `customer_locale_prefs` carries one row per opted-in customer.
--     `customer_id` is the primary key (one pref per customer). The
--     `locale` value must be in `locales_defined`. `set_at` is the
--     epoch-ms of the original write; `updated_at` is bumped on
--     every overwrite so the audit trail tells "when did this
--     buyer flip from de-DE to en-US?".
--
--   * `locale_resolutions_log` is the append-only audit trail. The
--     primitive writes a row every time `resolveLocale` returns a
--     non-null answer. Operators reconcile a buyer-reported "I got
--     the wrong language" complaint against this log. The log is
--     append-only by convention — no UPDATE/DELETE path is exposed
--     by the primitive.

CREATE TABLE IF NOT EXISTS locales_defined (
  tag              TEXT NOT NULL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('primary', 'regional', 'variant')),
  fallback         TEXT,
  currency         TEXT NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locales_defined_active
  ON locales_defined(active) WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_locales_defined_kind
  ON locales_defined(kind);

CREATE TABLE IF NOT EXISTS locale_policies (
  slug                    TEXT NOT NULL PRIMARY KEY,
  strategy                TEXT NOT NULL CHECK (strategy IN (
                            'url_prefix',
                            'subdomain',
                            'cookie',
                            'accept_language_only',
                            'customer_preference'
                          )),
  default_locale          TEXT NOT NULL,
  supported_locales_json  TEXT NOT NULL,
  is_active               INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  archived_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

-- At most one policy carries is_active = 1 at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locale_policies_one_active
  ON locale_policies(is_active) WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_locale_policies_archived
  ON locale_policies(archived_at);

CREATE TABLE IF NOT EXISTS customer_locale_prefs (
  customer_id   TEXT NOT NULL PRIMARY KEY,
  locale        TEXT NOT NULL,
  set_at        INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_locale_prefs_locale
  ON customer_locale_prefs(locale);

CREATE TABLE IF NOT EXISTS locale_resolutions_log (
  id            TEXT NOT NULL PRIMARY KEY,
  locale        TEXT NOT NULL,
  source        TEXT NOT NULL,
  host          TEXT,
  path          TEXT,
  occurred_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locale_resolutions_log_locale
  ON locale_resolutions_log(locale, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_locale_resolutions_log_occurred
  ON locale_resolutions_log(occurred_at DESC);
