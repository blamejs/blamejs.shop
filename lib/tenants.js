"use strict";
/**
 * @module shop.tenants
 * @title  Tenants primitive — multi-store directory + host routing
 *
 * @intro
 *   One deployment hosts N branded shops. Each shop is a "tenant"
 *   with its own primary domain, optional alt domains (apex / www,
 *   legacy hostnames during migration), a default currency + locale,
 *   a theme slug, and a lifecycle status (active / paused / archived).
 *
 *   The Worker's request entry-point consults `resolveByHost(host)`
 *   on every inbound request: returns the tenant row whose
 *   `tenant_domains` set contains the host (lowercased, exact-match —
 *   the operator owns DNS so wildcard routing is out of scope), or
 *   null when no match exists. Archived tenants do not resolve
 *   (decommissioned shop's URL goes to 404 / not-found); paused
 *   tenants do resolve so the Worker can render a "store temporarily
 *   unavailable" page without losing the lookup.
 *
 *   Lifecycle FSM:
 *     active   <-> paused        (pauseTenant / resumeTenant)
 *     active|paused -> archived  (archiveTenant, terminal)
 *
 *   Composes:
 *     - `b.guardUuid`            — UUID-shape validation for ids
 *     - `b.uuid.v7`              — row ids
 *
 *   Surface:
 *     defineTenant({ slug, name, primary_domain, alt_domains?,
 *                    default_currency, default_locale, theme_slug,
 *                    status? })
 *     addDomain(tenant_slug, domain)
 *     removeDomain(tenant_slug, domain)
 *     setPrimaryDomain(tenant_slug, domain)
 *     pauseTenant(tenant_slug, { reason? })  // reason is operator-
 *                                             // facing log breadcrumb,
 *                                             // not persisted (the
 *                                             // tenants row carries
 *                                             // the FSM, audit lives
 *                                             // in the order/admin
 *                                             // timelines)
 *     resumeTenant(tenant_slug)
 *     archiveTenant(tenant_slug)
 *     get(slug) / getById(id)
 *     resolveByHost(host)
 *     listTenants({ status? })
 *     update(slug, patch)
 *     stats()
 *
 *   Storage:
 *     - `tenants` + `tenant_domains` (migration `0063_tenants.sql`).
 *
 * @primitive tenants
 * @related   b.guardUuid, b.uuid
 */

var b = require("./vendor/blamejs");

var MAX_SLUG_LEN     = 64;
var MAX_NAME_LEN     = 200;
var MAX_DOMAIN_LEN   = 255;
var MAX_LOCALE_LEN   = 35;     // BCP-47 caps well below this
var MAX_ALT_DOMAINS  = 32;     // sanity cap on a single defineTenant call

var STATUSES = ["active", "paused", "archived"];

// Slug: lowercase alphanumerics + dash/underscore; first and last
// chars must be alphanumeric so the slug round-trips cleanly in URLs
// and log lines. Empty slug + a single character ("x") are both
// allowed by the spec — the regex makes the single-char case the
// edge.
var SLUG_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;

// Domain: lowercase host name. First char alphanumeric so leading
// dots / dashes don't slip through; trailing TLD must be at least two
// ASCII letters so a bare `localhost` style is refused as a tenant
// domain (use the operator console for that).
var DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

// Locale: BCP-47-ish — letters/digits separated by single hyphens.
// Generous enough for `en`, `en-US`, `zh-Hant-HK`, refused for
// embedded whitespace / underscores.
var LOCALE_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

// Currency: ISO 4217 (uppercase 3-letter).
var CURRENCY_RE = /^[A-Z]{3}$/;

// Theme slug: same shape as the theme primitive's own gate
// (`^[a-z0-9][a-z0-9-]{0,63}$`). Re-derive locally rather than
// importing so the tenants module stays leaf-level.
var THEME_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Control bytes + zero-width / direction-override family. The name
// renders in operator dashboards; embedded control / direction-
// override bytes are a slipping-class for visual-spoofing attacks
// downstream.
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "name", "default_currency", "default_locale", "theme_slug",
]);

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  label = label || "slug";
  if (typeof s !== "string") {
    throw new TypeError("tenants: " + label + " must be a string");
  }
  if (s.length === 0 || s.length > MAX_SLUG_LEN) {
    throw new TypeError("tenants: " + label + " must be 1.." + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("tenants: " + label + " must match /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/ (single-char alphanumerics also allowed)");
  }
  return s;
}

function _name(s) {
  if (typeof s !== "string") {
    throw new TypeError("tenants: name must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("tenants: name must be non-empty after trim");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError("tenants: name must be <= " + MAX_NAME_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("tenants: name contains control / zero-width bytes");
  }
  return s;
}

function _domain(s, label) {
  label = label || "domain";
  if (typeof s !== "string") {
    throw new TypeError("tenants: " + label + " must be a string");
  }
  if (!s.length || s.length > MAX_DOMAIN_LEN) {
    throw new TypeError("tenants: " + label + " must be 1.." + MAX_DOMAIN_LEN + " characters");
  }
  var lowered = s.toLowerCase();
  if (!DOMAIN_RE.test(lowered)) {
    throw new TypeError("tenants: " + label + " must match /^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$/");
  }
  return lowered;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("tenants: default_currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _locale(s) {
  if (typeof s !== "string") {
    throw new TypeError("tenants: default_locale must be a string");
  }
  if (!s.length || s.length > MAX_LOCALE_LEN) {
    throw new TypeError("tenants: default_locale must be 1.." + MAX_LOCALE_LEN + " characters");
  }
  if (!LOCALE_RE.test(s)) {
    throw new TypeError("tenants: default_locale must be a BCP-47-shaped tag (letters/digits separated by single hyphens)");
  }
  return s;
}

function _themeSlug(s) {
  if (typeof s !== "string" || !THEME_SLUG_RE.test(s)) {
    throw new TypeError("tenants: theme_slug must match /^[a-z0-9][a-z0-9-]{0,63}$/");
  }
  return s;
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("tenants: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("tenants: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _tenantBySlug(slug) {
    var r = await query("SELECT * FROM tenants WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _tenantById(id) {
    var r = await query("SELECT * FROM tenants WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _domainsFor(tenantId) {
    var r = await query(
      "SELECT * FROM tenant_domains WHERE tenant_id = ?1 ORDER BY is_primary DESC, added_at ASC, domain ASC",
      [tenantId]
    );
    return r.rows;
  }

  async function _hydrate(row) {
    if (!row) return null;
    var domains = await _domainsFor(row.id);
    var primary = null;
    var alt = [];
    for (var i = 0; i < domains.length; i += 1) {
      if (Number(domains[i].is_primary) === 1) {
        primary = domains[i].domain;
      } else {
        alt.push(domains[i].domain);
      }
    }
    return {
      id:               row.id,
      slug:             row.slug,
      name:             row.name,
      default_currency: row.default_currency,
      default_locale:   row.default_locale,
      theme_slug:       row.theme_slug,
      status:           row.status,
      paused_at:        row.paused_at == null ? null : Number(row.paused_at),
      archived_at:      row.archived_at == null ? null : Number(row.archived_at),
      created_at:       Number(row.created_at),
      updated_at:       Number(row.updated_at),
      primary_domain:   primary,
      alt_domains:      alt,
      domains:          domains.map(function (d) {
        return {
          domain:     d.domain,
          is_primary: Number(d.is_primary) === 1,
          added_at:   Number(d.added_at),
        };
      }),
    };
  }

  async function _insertDomain(tenantId, domain, isPrimary, ts) {
    var id = b.uuid.v7();
    try {
      await query(
        "INSERT INTO tenant_domains (id, tenant_id, domain, is_primary, added_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, tenantId, domain, isPrimary ? 1 : 0, ts]
      );
    } catch (e) {
      // State-agnostic collision detection: the production D1 service
      // binding redacts the SQLite "UNIQUE constraint failed" text to a
      // generic "HTTP 500", so a message regex is blind in prod. Re-read
      // by the UNIQUE key (tenant_domains.domain is globally UNIQUE) — if
      // the row now exists, the insert lost a duplicate-domain race; if
      // not, the insert failed for another reason, so re-throw.
      var clash = await query(
        "SELECT 1 FROM tenant_domains WHERE domain = ?1 LIMIT 1",
        [domain]
      );
      if (clash.rows.length) {
        var dupe = new Error("tenants: domain '" + domain + "' is already registered");
        dupe.code = "TENANT_DOMAIN_DUPLICATE";
        throw dupe;
      }
      throw e;
    }
    return id;
  }

  return {
    STATUSES:           STATUSES.slice(),
    SLUG_RE:            SLUG_RE,
    DOMAIN_RE:          DOMAIN_RE,
    MAX_SLUG_LEN:       MAX_SLUG_LEN,
    MAX_NAME_LEN:       MAX_NAME_LEN,
    MAX_DOMAIN_LEN:     MAX_DOMAIN_LEN,
    MAX_LOCALE_LEN:     MAX_LOCALE_LEN,
    MAX_ALT_DOMAINS:    MAX_ALT_DOMAINS,

    defineTenant: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("tenants.defineTenant: input object required");
      }
      var slug           = _slug(input.slug, "slug");
      var name           = _name(input.name);
      var primaryDomain  = _domain(input.primary_domain, "primary_domain");
      var defaultCurrency = _currency(input.default_currency);
      var defaultLocale  = _locale(input.default_locale);
      var themeSlug      = _themeSlug(input.theme_slug);
      var status         = input.status == null ? "active" : _status(input.status);

      var altDomains = [];
      if (input.alt_domains != null) {
        if (!Array.isArray(input.alt_domains)) {
          throw new TypeError("tenants.defineTenant: alt_domains must be an array or null");
        }
        if (input.alt_domains.length > MAX_ALT_DOMAINS) {
          throw new TypeError("tenants.defineTenant: alt_domains must be <= " + MAX_ALT_DOMAINS + " entries");
        }
        for (var i = 0; i < input.alt_domains.length; i += 1) {
          var d = _domain(input.alt_domains[i], "alt_domains[" + i + "]");
          if (d === primaryDomain) {
            throw new TypeError("tenants.defineTenant: alt_domains[" + i + "] duplicates primary_domain");
          }
          if (altDomains.indexOf(d) !== -1) {
            throw new TypeError("tenants.defineTenant: alt_domains[" + i + "] is duplicated within alt_domains");
          }
          altDomains.push(d);
        }
      }

      // Slug + primary domain uniqueness enforced by the SQL layer.
      // Surface a typed error instead of leaking the SQL message.
      var existing = await _tenantBySlug(slug);
      if (existing) {
        var dupe = new Error("tenants.defineTenant: slug '" + slug + "' is already registered");
        dupe.code = "TENANT_SLUG_DUPLICATE";
        throw dupe;
      }

      var id = b.uuid.v7();
      var ts = _now();
      try {
        await query(
          "INSERT INTO tenants " +
          "(id, slug, name, default_currency, default_locale, theme_slug, " +
          " status, paused_at, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?8)",
          [id, slug, name, defaultCurrency, defaultLocale, themeSlug, status, ts]
        );
      } catch (e) {
        // State-agnostic collision detection: prod D1 redacts the SQLite
        // "UNIQUE constraint failed" message to a generic "HTTP 500", so a
        // message regex is blind there. Re-read by the UNIQUE key
        // (tenants.slug) — if the row now exists, a concurrent define won
        // the slug; otherwise the insert failed for another reason, so
        // re-throw.
        var clash = await _tenantBySlug(slug);
        if (clash) {
          var slugDupe = new Error("tenants.defineTenant: slug '" + slug + "' is already registered");
          slugDupe.code = "TENANT_SLUG_DUPLICATE";
          throw slugDupe;
        }
        throw e;
      }

      await _insertDomain(id, primaryDomain, true, ts);
      for (var j = 0; j < altDomains.length; j += 1) {
        await _insertDomain(id, altDomains[j], false, ts);
      }
      return await _hydrate(await _tenantById(id));
    },

    addDomain: async function (tenantSlug, domain) {
      var slug   = _slug(tenantSlug, "tenant_slug");
      var lowered = _domain(domain, "domain");
      var row = await _tenantBySlug(slug);
      if (!row) {
        var miss = new Error("tenants.addDomain: tenant '" + slug + "' not found");
        miss.code = "TENANT_NOT_FOUND";
        throw miss;
      }
      if (row.status === "archived") {
        var arch = new Error("tenants.addDomain: tenant '" + slug + "' is archived");
        arch.code = "TENANT_ARCHIVED";
        throw arch;
      }
      await _insertDomain(row.id, lowered, false, _now());
      await query("UPDATE tenants SET updated_at = ?1 WHERE id = ?2", [_now(), row.id]);
      return await _hydrate(await _tenantById(row.id));
    },

    removeDomain: async function (tenantSlug, domain) {
      var slug   = _slug(tenantSlug, "tenant_slug");
      var lowered = _domain(domain, "domain");
      var row = await _tenantBySlug(slug);
      if (!row) {
        var miss = new Error("tenants.removeDomain: tenant '" + slug + "' not found");
        miss.code = "TENANT_NOT_FOUND";
        throw miss;
      }
      var d = await query(
        "SELECT * FROM tenant_domains WHERE tenant_id = ?1 AND domain = ?2",
        [row.id, lowered]
      );
      if (!d.rows.length) {
        var dm = new Error("tenants.removeDomain: domain '" + lowered + "' is not registered to tenant '" + slug + "'");
        dm.code = "TENANT_DOMAIN_NOT_FOUND";
        throw dm;
      }
      if (Number(d.rows[0].is_primary) === 1) {
        var pri = new Error("tenants.removeDomain: refused — '" + lowered + "' is the primary domain; setPrimaryDomain to another first");
        pri.code = "TENANT_DOMAIN_PRIMARY_REFUSED";
        throw pri;
      }
      await query("DELETE FROM tenant_domains WHERE id = ?1", [d.rows[0].id]);
      await query("UPDATE tenants SET updated_at = ?1 WHERE id = ?2", [_now(), row.id]);
      return await _hydrate(await _tenantById(row.id));
    },

    setPrimaryDomain: async function (tenantSlug, domain) {
      var slug   = _slug(tenantSlug, "tenant_slug");
      var lowered = _domain(domain, "domain");
      var row = await _tenantBySlug(slug);
      if (!row) {
        var miss = new Error("tenants.setPrimaryDomain: tenant '" + slug + "' not found");
        miss.code = "TENANT_NOT_FOUND";
        throw miss;
      }
      var d = await query(
        "SELECT * FROM tenant_domains WHERE tenant_id = ?1 AND domain = ?2",
        [row.id, lowered]
      );
      if (!d.rows.length) {
        var dm = new Error("tenants.setPrimaryDomain: domain '" + lowered + "' is not registered to tenant '" + slug + "'");
        dm.code = "TENANT_DOMAIN_NOT_FOUND";
        throw dm;
      }
      // Demote every other domain on this tenant before promoting the
      // target. Two writes inside the same query stream keeps the
      // invariant (exactly one primary per tenant) regardless of
      // whether the underlying engine batches.
      await query(
        "UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?1 AND domain != ?2",
        [row.id, lowered]
      );
      await query(
        "UPDATE tenant_domains SET is_primary = 1 WHERE tenant_id = ?1 AND domain = ?2",
        [row.id, lowered]
      );
      await query("UPDATE tenants SET updated_at = ?1 WHERE id = ?2", [_now(), row.id]);
      return await _hydrate(await _tenantById(row.id));
    },

    pauseTenant: async function (tenantSlug) {
      var slug = _slug(tenantSlug, "tenant_slug");
      var row = await _tenantBySlug(slug);
      if (!row) return null;
      if (row.status === "archived") {
        var arch = new Error("tenants.pauseTenant: refused — tenant '" + slug + "' is archived");
        arch.code = "TENANT_TRANSITION_REFUSED";
        throw arch;
      }
      if (row.status === "paused") {
        return await _hydrate(row);
      }
      var ts = _now();
      await query(
        "UPDATE tenants SET status = 'paused', paused_at = ?1, updated_at = ?1 WHERE id = ?2",
        [ts, row.id]
      );
      return await _hydrate(await _tenantById(row.id));
    },

    resumeTenant: async function (tenantSlug) {
      var slug = _slug(tenantSlug, "tenant_slug");
      var row = await _tenantBySlug(slug);
      if (!row) return null;
      if (row.status === "archived") {
        var arch = new Error("tenants.resumeTenant: refused — tenant '" + slug + "' is archived");
        arch.code = "TENANT_TRANSITION_REFUSED";
        throw arch;
      }
      if (row.status === "active") {
        return await _hydrate(row);
      }
      var ts = _now();
      await query(
        "UPDATE tenants SET status = 'active', paused_at = NULL, updated_at = ?1 WHERE id = ?2",
        [ts, row.id]
      );
      return await _hydrate(await _tenantById(row.id));
    },

    archiveTenant: async function (tenantSlug) {
      var slug = _slug(tenantSlug, "tenant_slug");
      var row = await _tenantBySlug(slug);
      if (!row) return null;
      if (row.status === "archived") {
        return await _hydrate(row);
      }
      var ts = _now();
      await query(
        "UPDATE tenants SET status = 'archived', archived_at = ?1, updated_at = ?1 WHERE id = ?2",
        [ts, row.id]
      );
      return await _hydrate(await _tenantById(row.id));
    },

    get: async function (tenantSlug) {
      var slug = _slug(tenantSlug, "tenant_slug");
      return await _hydrate(await _tenantBySlug(slug));
    },

    getById: async function (tenantId) {
      var id = _uuid(tenantId, "tenant_id");
      return await _hydrate(await _tenantById(id));
    },

    // Nearest-domain match: case-insensitive exact match against the
    // tenant_domains set. Archived tenants do NOT resolve — their
    // domains stop serving once archived. Paused tenants DO resolve
    // so the Worker can render a "store temporarily unavailable" page
    // and keep the lookup deterministic.
    resolveByHost: async function (host) {
      if (typeof host !== "string" || !host.length) {
        return null;
      }
      // Strip an optional port suffix (":443", ":8787") — operator-
      // facing log lines sometimes carry it; the tenant_domains table
      // never does.
      var stripped = host;
      var colon = stripped.indexOf(":");
      if (colon !== -1) stripped = stripped.slice(0, colon);
      var lowered = stripped.toLowerCase();
      if (!DOMAIN_RE.test(lowered)) {
        // resolveByHost is on the request hot path — return null
        // instead of throwing so a junk Host header on a bot probe
        // doesn't surface as a stack trace.
        return null;
      }
      var r = await query(
        "SELECT t.* FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id " +
        "WHERE d.domain = ?1 AND t.status != 'archived' LIMIT 1",
        [lowered]
      );
      if (!r.rows.length) return null;
      return await _hydrate(r.rows[0]);
    },

    listTenants: async function (listOpts) {
      listOpts = listOpts || {};
      var sql, params;
      if (listOpts.status != null) {
        var s = _status(listOpts.status);
        sql = "SELECT * FROM tenants WHERE status = ?1 ORDER BY created_at DESC, slug ASC";
        params = [s];
      } else {
        sql = "SELECT * FROM tenants ORDER BY created_at DESC, slug ASC";
        params = [];
      }
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        out.push(await _hydrate(r.rows[i]));
      }
      return out;
    },

    update: async function (tenantSlug, patch) {
      var slug = _slug(tenantSlug, "tenant_slug");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("tenants.update: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("tenants.update: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError("tenants.update: column '" + keys[i] + "' not updatable");
        }
      }
      var row = await _tenantBySlug(slug);
      if (!row) return null;
      if (row.status === "archived") {
        var arch = new Error("tenants.update: refused — tenant '" + slug + "' is archived");
        arch.code = "TENANT_ARCHIVED";
        throw arch;
      }

      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (patch.name != null)             _set("name",             _name(patch.name));
      if (patch.default_currency != null) _set("default_currency", _currency(patch.default_currency));
      if (patch.default_locale != null)   _set("default_locale",   _locale(patch.default_locale));
      if (patch.theme_slug != null)       _set("theme_slug",       _themeSlug(patch.theme_slug));

      var ts = _now();
      _set("updated_at", ts);
      params.push(row.id);
      var sql = "UPDATE tenants SET " + sets.join(", ") + " WHERE id = ?" + idx;
      await query(sql, params);
      return await _hydrate(await _tenantById(row.id));
    },

    // Operator dashboard — shape:
    //   {
    //     active_count, paused_count, archived_count,
    //     total_domains,
    //     per_tenant: [{ tenant_id, slug, status, domain_count }, ...],
    //   }
    //
    // `per_tenant` is the per-shop rollup hint the order / customer
    // primitives join against for "orders by tenant" / "customers by
    // tenant" pages. The order + customer rollups themselves live in
    // those primitives (this primitive's stats() only carries what
    // the tenants directory knows — the domain count + status).
    stats: async function () {
      var counts = await query(
        "SELECT status, COUNT(*) AS n FROM tenants GROUP BY status",
        []
      );
      var summary = { active: 0, paused: 0, archived: 0 };
      for (var i = 0; i < counts.rows.length; i += 1) {
        var row = counts.rows[i];
        if (summary[row.status] != null) {
          summary[row.status] = Number(row.n);
        }
      }
      var totalDomains = await query(
        "SELECT COUNT(*) AS n FROM tenant_domains",
        []
      );
      var perTenant = await query(
        "SELECT t.id AS tenant_id, t.slug AS slug, t.status AS status, " +
        "       COUNT(d.id) AS domain_count " +
        "FROM tenants t LEFT JOIN tenant_domains d ON d.tenant_id = t.id " +
        "GROUP BY t.id, t.slug, t.status " +
        "ORDER BY t.created_at DESC, t.slug ASC",
        []
      );
      return {
        active_count:   summary.active,
        paused_count:   summary.paused,
        archived_count: summary.archived,
        total_domains:  Number((totalDomains.rows[0] && totalDomains.rows[0].n) || 0),
        per_tenant:     perTenant.rows.map(function (r) {
          return {
            tenant_id:    r.tenant_id,
            slug:         r.slug,
            status:       r.status,
            domain_count: Number(r.domain_count || 0),
          };
        }),
      };
    },
  };
}

module.exports = {
  create:          create,
  STATUSES:        STATUSES.slice(),
  SLUG_RE:         SLUG_RE,
  DOMAIN_RE:       DOMAIN_RE,
  MAX_SLUG_LEN:    MAX_SLUG_LEN,
  MAX_NAME_LEN:    MAX_NAME_LEN,
  MAX_DOMAIN_LEN:  MAX_DOMAIN_LEN,
  MAX_LOCALE_LEN:  MAX_LOCALE_LEN,
  MAX_ALT_DOMAINS: MAX_ALT_DOMAINS,
};
