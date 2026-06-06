"use strict";
/**
 * blamejs.shop application entry point.
 *
 *   node server.js
 *
 * On a fresh clone, run `bash scripts/vendor-update.sh blamejs latest`
 * once to populate `lib/vendor/blamejs/` before starting the server.
 *
 * Default boot is minimal: framework + healthcheck + placeholder home
 * route. When the deployment supplies D1_BRIDGE_URL + D1_BRIDGE_SECRET
 * (the Cloudflare Containers topology), the externalDb D1 backend is
 * wired so commerce primitives that land later can read/write
 * application data without further configuration.
 *
 * Required env (single-node defaults):
 *   PORT                       (default 8080)
 *   DATA_DIR                   (default ./data)
 *   VAULT_PASSPHRASE           (vault unlock — required by b.vault)
 *
 * Optional env (Cloudflare deploy):
 *   D1_BRIDGE_URL              Worker bridge URL (e.g. http://shop-worker)
 *   D1_BRIDGE_SECRET           shared secret matching the Worker's
 *                              D1_BRIDGE_SECRET binding
 *   D1_BRIDGE_PATH             override (default /_/db/query)
 */

var bShop = require("./lib");
var b     = bShop.framework;

var PORT     = parseInt(process.env.PORT || "8080", 10);
var DATA_DIR = process.env.DATA_DIR || "./data";

// ISO 3166-2 subdivision codes the shippingZones engine accepts (the
// country prefix stripped). The checkout ship_to.state field is wider
// (up to 5 chars) than a zone region (1-3), so a too-long / off-shape
// state is passed as a region-less lookup — country-only zones still
// match, and the engine never throws on an out-of-shape region.
var ZONE_REGION_RE = /^[A-Z0-9]{1,3}$/;

// Translate a checkout shipping ctx into shippingZones.rateFor params,
// run the lookup, and map any matching zone rows into the same
// { id, label, amount_minor } service shape the config-services
// adapter returns. Returns [] (so the caller falls back to the flat
// config-services table) when no zone covers the destination, no rate
// row matches, the cart currency can't be read, or the lookup throws.
//
// Pure read of operator-defined rate tables — it never reaches the
// order-total / tax / discount / payment math; it only sources the
// list of shipping services the shopper picks from. Any failure
// degrades to the fallback rather than surfacing a 5xx at the till.
async function _zoneShippingRates(shippingZones, ctx) {
  if (!shippingZones || !ctx || typeof ctx !== "object") return [];
  var shipTo = ctx.shipTo;
  if (!shipTo || typeof shipTo !== "object") return [];
  if (typeof shipTo.country !== "string") return [];

  // Currency rides on the cart lines (unit_currency), not on the ctx
  // root. Read it off the first line; absent a usable currency there's
  // nothing to match a zone rate against, so fall back.
  var lines = Array.isArray(ctx.lines) ? ctx.lines : [];

  // Mirror the flat adapter's digital-only gate (lib/shipping.js): a cart with
  // no shipping-requiring line must NOT be quoted physical zone rates. Return
  // empty so the fallback applies its digital-only (no-charge) path instead.
  var anyShippable = lines.some(function (l) {
    return l && (l.requires_shipping === undefined ? true : !!l.requires_shipping);
  });
  if (!anyShippable) return [];

  var currency = "";
  for (var ci = 0; ci < lines.length; ci += 1) {
    if (lines[ci] && typeof lines[ci].unit_currency === "string" && lines[ci].unit_currency) {
      currency = lines[ci].unit_currency.toUpperCase();
      break;
    }
  }
  if (!currency) return [];

  // Total parcel weight = sum of (per-variant weight * qty) over the
  // shipping-requiring lines. A line missing a weight contributes 0,
  // matching the flat-rate adapter's own weight accounting.
  var weightGrams = 0;
  for (var wi = 0; wi < lines.length; wi += 1) {
    var line = lines[wi];
    if (!line || line.requires_shipping === false) continue;
    var w = Number(line.weight_grams);
    var q = Number(line.qty);
    if (!isFinite(w) || w < 0) w = 0;
    if (!isFinite(q) || q < 1) q = 1;   // missing/degenerate qty defaults to 1, matching the flat adapter (l.qty || 1)
    weightGrams += Math.round(w) * Math.round(q);
  }

  var orderMinor = Number(ctx.subtotal_minor);
  if (!isFinite(orderMinor) || orderMinor < 0) orderMinor = 0;

  var region = (typeof shipTo.state === "string" && ZONE_REGION_RE.test(shipTo.state))
    ? shipTo.state
    : undefined;

  var rows;
  try {
    rows = await shippingZones.rateFor({
      destination_country: shipTo.country,
      destination_region:  region,
      weight_grams:        weightGrams,
      order_minor:         orderMinor,
      currency:            currency,
    });
  } catch (_e) {
    // Bad destination shape, out-of-range weight, or any engine error —
    // degrade to the config-services fallback, never a 5xx.
    return [];
  }
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Map each zone rate row onto the checkout service shape. The id is
  // deterministic (zone slug + position in the already-sorted result)
  // so the same lookup re-run at confirm time resolves the shopper's
  // selected_shipping_id to the same rate.
  var out = [];
  for (var ri = 0; ri < rows.length; ri += 1) {
    var r = rows[ri];
    out.push({
      id:           "zone-" + r.zone_slug + "-" + ri,
      label:        r.service_label,
      amount_minor: r.rate_minor,
      free:         r.rate_minor === 0,
      jurisdiction: shipTo.country,
    });
  }
  return out;
}

// Convert a thrown error from the PUBLIC, UNAUTHENTICATED catalog API
// (GET /api/catalog/products[/:slug]) to an RFC 9457 problem document
// and send it. A TypeError is a client-shape (validation) error whose
// message is operator-safe — surface it as a 400 with its detail intact.
// Any OTHER error is a 500: its raw message can carry storage-engine /
// parser internals (the D1 layer wraps the upstream string, e.g.
// "query failed — UNIQUE constraint failed: products.slug"), so the
// anonymous caller must NOT see it. The 5xx body carries a GENERIC
// detail; the raw message is recorded server-side via the framework
// audit (drop-silent, outcome:"failure") so an operator can correlate.
// Mirrors lib/admin.js _safeNotice.
function _problemFromError(res, e, ctx) {
  if (e instanceof TypeError) {
    return b.problemDetails.respond(res, b.problemDetails.fromError(e, { status: 400 }));
  }
  var msg = (e && e.message) || String(e);
  b.audit.safeEmit({
    action:   "shop_catalog_api.request.error",
    outcome:  "failure",
    metadata: { message: msg },
  });
  // ALSO record the scrubbed message into the operator-readable error
  // log (lib/error-log.js) so this 500's detail is reachable from the
  // admin console + the admin JSON API, not just the container's local
  // audit sink. Drop-silent + fire-and-forget — captureServerError can
  // never throw, and a 500 response must not wait on (or be undone by)
  // an error-log write. `ctx` is optional so the existing two-arg
  // callers and the unit test keep working unchanged.
  if (ctx && ctx.errorLog && ctx.route) {
    ctx.errorLog.captureServerError({ route: ctx.route, message: msg, status: 500 });
  }
  b.problemDetails.send(res, {
    type:   "/problems/internal-error",
    title:  "Internal Server Error",
    status: 500,
    detail: "Something went wrong — please try again.",
  });
}

// Per-domain reader adapters for the subject-access-request primitive
// (lib/compliance-export.js). The primitive expects each injected handle
// to expose `forCustomerExport(customer_id)` (returns that domain's data)
// and/or `forCustomerDeletion(customer_id, { dry_run })` (executes/counts
// the per-domain erasure and returns `{ table, deleted }`). NONE of the
// per-domain primitives (customers / addresses / order / subscriptions /
// support-tickets / loyalty) implement that contract, so passing the raw
// handles ships an empty bundle (every section lands in `sections_absent`)
// and every deletion is a no-op. These shims map each handle's EXISTING
// read / soft-delete surface onto the contract, so the per-domain modules
// stay unchanged.
//
// Resilience (drop-silent, hot-path): an export adapter that fails (one
// unmigrated table, a read error) returns null/[]/{} rather than throwing —
// the primitive treats a thrown reader as a hard error, so we never throw
// out of an adapter. A deletion adapter that fails returns
// `{ table, deleted: 0 }`. One missing domain never fails the whole bundle.
//
// Retention (PD-2): orders, the loyalty ledger, and support tickets are
// accounting / financial / operator records a controller may retain under a
// legal-obligation basis — their deletion adapters retain (`deleted: 0` +
// note). Addresses + subscriptions are archived; the customer row is
// anonymized in place (PD-1) so FK children (orders, tickets) don't orphan.
var _dsrReader = {
  // customers: export reads the row + the customer's passkeys + their
  // OAuth sign-in providers. deletion anonymizes-in-place via update() —
  // overwrite display_name to a tombstone, keep the row so FKs hold
  // (a hard delete would orphan orders / tickets). The raw email is never
  // stored (email_hash only), so the row carries no plaintext PII to scrub
  // beyond the display name.
  customers: function (handle) {
    return {
      forCustomerExport: async function (id) {
        try {
          var row      = await handle.get(id);
          var passkeys = [];
          try { passkeys = await handle.listPasskeys(id); } catch (_e) { passkeys = []; }
          var methods = null;
          try { methods = await handle.signInMethodsByCustomer([id]); } catch (_e) { methods = null; }
          return {
            customer:        row || null,
            passkeys:        passkeys || [],
            sign_in_methods: methods || null,
          };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          var existing = await handle.get(id);
          if (!existing) return { table: "customers", deleted: 0 };
          if (dryRun) return { table: "customers", deleted: 1 };
          await handle.update(id, { display_name: "[erased customer " + String(id).slice(0, 8) + "]" });
          return { table: "customers", deleted: 1 };
        } catch (_e) { return { table: "customers", deleted: 0 }; }
      },
    };
  },

  // addresses: export lists every address (including archived for the
  // audit). deletion archives each via the existing soft-delete; dry-run
  // counts without archiving.
  addresses: function (handle) {
    return {
      forCustomerExport: async function (id) {
        try { return await handle.listForCustomer(id, { include_archived: true }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          var rows = await handle.listForCustomer(id, {});
          if (dryRun) return { table: "customer_addresses", deleted: rows.length };
          var n = 0;
          for (var i = 0; i < rows.length; i += 1) {
            var ok = await handle.archive(rows[i].id);
            if (ok) n += 1;
          }
          return { table: "customer_addresses", deleted: n };
        } catch (_e) { return { table: "customer_addresses", deleted: 0 }; }
      },
    };
  },

  // order: export lists the customer's orders (hydrated rows). deletion
  // RETAINS — orders are a legal / accounting record (PD-2). The customer
  // linkage stays so the controller can answer a tax / chargeback audit;
  // the customer-identity scrub rides the anonymized customers row.
  order: function (handle) {
    return {
      forCustomerExport: async function (id) {
        // order.listForCustomer caps limit at 100 (lib/order.js MAX_LIST_LIMIT);
        // a higher value throws and would silently empty the section.
        try { return (await handle.listForCustomer(id, { limit: 100 })).rows; }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (_id, _opts) {
        return { table: "orders", deleted: 0, note: "retained-for-accounting" };
      },
    };
  },

  // subscriptions: the handle is the nested { plans, subscriptions } object.
  // export lists the customer's subscription rows. deletion soft-cancels the
  // customer's non-terminal subscriptions (status -> 'canceled'); the
  // subscriptions handle exposes no Stripe-free soft-delete (its `cancel`
  // posts to Stripe, `archive` lives on `plans`, not on a subscription), so
  // the adapter marks status directly over the same externalDb query the
  // primitive itself uses. dry-run counts the rows it WOULD cancel without
  // mutating. `query` is the composition-root D1 handle.
  subscriptions: function (handle, query) {
    var TERMINAL = ["canceled", "incomplete_expired"];
    return {
      forCustomerExport: async function (id) {
        try { return await handle.subscriptions.list({ customer_id: id }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          var rows = await handle.subscriptions.list({ customer_id: id });
          var live = rows.filter(function (r) { return TERMINAL.indexOf(r.status) === -1; });
          if (dryRun) return { table: "subscriptions", deleted: live.length };
          var n = 0;
          var ts = Date.now();
          for (var i = 0; i < live.length; i += 1) {
            var res = await query(
              "UPDATE subscriptions SET status = 'canceled', updated_at = ?1 WHERE id = ?2",
              [ts, live[i].id],
            );
            if (res && res.rowCount) n += Number(res.rowCount);
          }
          return { table: "subscriptions", deleted: n };
        } catch (_e) { return { table: "subscriptions", deleted: 0 }; }
      },
    };
  },

  // supportTickets: export lists the customer's tickets. deletion RETAINS
  // (PD-2) — tickets are operator-facing service records and store the
  // requester email hash-only (no plaintext PII). Their bodies stay out of
  // hard-delete scope in v1; the slot exists for a later opt-in.
  supportTickets: function (handle) {
    return {
      forCustomerExport: async function (id) {
        // listByCustomerId caps limit at 100 (support-tickets MAX_LIST_LIMIT);
        // a higher value throws and would silently empty the section.
        try { return await handle.listByCustomerId(id, { limit: 100 }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (_id, _opts) {
        return { table: "support_tickets", deleted: 0, note: "retained" };
      },
    };
  },

  // orderNotes: lib/order-notes.js is keyed by order_id and exposes no
  // customer-scoped query, so even though the composition root now constructs a
  // live instance (wired into the admin order-detail panel), there is no
  // per-customer order-note read to surface here — the customer-visible content
  // (operator replies on the customer's orders) already rides the `order`
  // section. This adapter keeps the section PRESENT-but-empty rather than absent
  // (an absent section reads as "we hid something"; an explicit empty array
  // reads as "nothing held here").
  orderNotes: function () {
    return { forCustomerExport: async function () { return []; } };
  },

  // paymentMethods: lib/saved-payment-methods.js is Stripe-gated and unwired
  // in prod (Stripe unconfigured). When a handle is supplied, export lists
  // the customer's saved methods (card metadata only — never raw PAN, which
  // lives at Stripe); absent a handle it reports the section present-but-empty
  // so the `full` bundle never reads as incomplete. The slot lights up with
  // real data the moment an operator wires Stripe (defer-with-condition).
  paymentMethods: function (handle) {
    return {
      forCustomerExport: async function (id) {
        if (!handle || typeof handle.listForCustomer !== "function") return [];
        try { return await handle.listForCustomer(id); } catch (_e) { return []; }
      },
    };
  },

  // loyalty: export carries the balance + the points ledger. deletion
  // RETAINS — the ledger is a financial record (PD-2).
  loyalty: function (handle) {
    return {
      forCustomerExport: async function (id) {
        try {
          var balance = await handle.balance(id);
          var history = [];
          try { history = (await handle.history(id, { limit: 200 })).rows; } catch (_e) { history = []; }
          return { balance: balance, history: history };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function (_id, _opts) {
        return { table: "loyalty", deleted: 0, note: "retained-ledger" };
      },
    };
  },
};

// orderNotes is intentionally NOT a per-customer reader: lib/order-notes.js
// is keyed by order_id (no customer-scoped query), so although the live
// instance now backs the admin order-detail panel, its customer-visible
// content (operator replies on the customer's orders) reaches a DSR export
// through the `order` export section, not a dedicated order-notes read.
//
// paymentMethods is Stripe-gated (lib/saved-payment-methods.js) and unwired
// in prod (Stripe unconfigured) — a real defer-with-condition: the
// reader-map slot lights up only when that handle exists, so the primitive
// reports it absent until an operator wires Stripe.

// Assemble the per-domain export bundle for a fulfilled DSR row, writing it
// to the response header-first / section-by-section so the process holds the
// bundle plus one section's serialization at a time — never a second giant
// JSON string alongside the assembled bundle (download-route-stream-not-buffer).
// fulfillRequest is the assembler that flips status + re-walks the readers;
// the download must NOT re-run it (a download shouldn't re-fulfill), so it
// re-reads the SAME reader set directly and streams. Status + ownership are
// validated by the caller BEFORE the first write (can't change status
// mid-stream). `sections` is the scope's section list (SCOPE_SECTIONS[scope]).
async function _streamDsrBundle(res, readers, sections, row) {
  res.status(200);
  if (res.setHeader) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader(
      "content-disposition",
      "attachment; filename=\"dsr-export-" + String(row.id).replace(/[^A-Za-z0-9._-]/g, "") + ".json\"",
    );
    res.setHeader("x-content-type-options", "nosniff");
  }
  var canWrite = typeof res.write === "function" && typeof res.end === "function";
  var buf = "";
  function emit(s) { if (canWrite) res.write(s); else buf += s; }
  emit("{\"request_id\":" + JSON.stringify(row.id) +
       ",\"customer_id\":" + JSON.stringify(row.customer_id) +
       ",\"jurisdiction\":" + JSON.stringify(row.jurisdiction) +
       ",\"scope\":" + JSON.stringify(row.scope) +
       ",\"data\":{");
  var first = true;
  for (var i = 0; i < sections.length; i += 1) {
    var name   = sections[i];
    var reader = readers[name];
    if (!reader || typeof reader.forCustomerExport !== "function") continue;
    var section;
    try { section = await reader.forCustomerExport(row.customer_id); }
    catch (_e) { section = null; }
    emit((first ? "" : ",") + JSON.stringify(name) + ":" + JSON.stringify(section == null ? null : section));
    first = false;
  }
  emit("}}");
  if (canWrite) res.end(); else (res.end ? res.end(buf) : res.send(buf));
}

async function main() {
  // createApp's secure defaults unlock TWO wrapped components at boot — the
  // vault AND the audit-signing keypair — and the framework reads their
  // passphrases from BLAMEJS_VAULT_PASSPHRASE / BLAMEJS_AUDIT_SIGNING_PASSPHRASE.
  // The deploy contract (docs/deploy-cloudflare.md + the header above)
  // documents a single operator secret, VAULT_PASSPHRASE. Without bridging it,
  // an operator who follows the docs sets a name the framework never reads;
  // the wrapped components have no passphrase source in a container (no TTY);
  // createApp throws — crash-looping the container so every write route
  // (add-to-cart, checkout, account, admin) is unreachable while edge-rendered
  // reads still work. Bridge the one documented secret onto both: the vault
  // passphrase is the secret as-is; the audit-signing passphrase is derived
  // from it, domain-separated via namespaceHash, so one operator secret
  // unlocks both with distinct key material. An explicitly-set BLAMEJS_*
  // always wins; the _FILE variant is honored for the vault path.
  if (process.env.VAULT_PASSPHRASE) {
    if (!process.env.BLAMEJS_VAULT_PASSPHRASE) {
      process.env.BLAMEJS_VAULT_PASSPHRASE = process.env.VAULT_PASSPHRASE;
    }
    if (!process.env.BLAMEJS_AUDIT_SIGNING_PASSPHRASE) {
      process.env.BLAMEJS_AUDIT_SIGNING_PASSPHRASE =
        b.crypto.namespaceHash("shop-audit-signing-passphrase", process.env.VAULT_PASSPHRASE);
    }
  }
  if (process.env.VAULT_PASSPHRASE_FILE && !process.env.BLAMEJS_VAULT_PASSPHRASE_FILE) {
    process.env.BLAMEJS_VAULT_PASSPHRASE_FILE = process.env.VAULT_PASSPHRASE_FILE;
  }

  // Optional: wire a Cloudflare D1 backend when the deploy provides
  // bridge credentials. Initializes externalDb before createApp so
  // the framework's cluster-mode boot picks it up automatically.
  var catalog = null;
  var cart    = null;
  // Stock observer slot — the inventory module fires it after every
  // stock-mutating op (hold / release / decrement / restock). It points
  // at the low-stock alerts engine, which composes the shared webhooks
  // dispatcher built inside the routes composition below — so the
  // catalog construction takes a late-bound indirection and the routes
  // block assigns the real handler once the alerts instance exists.
  // Null until then (and on any boot where alerts aren't composed); the
  // inventory module wraps the call drop-silent, so an alert-side
  // failure can never roll back the stock op that triggered it.
  var lowStockObserver = null;
  // Operator-readable error log — captures server-side 5xx-class
  // failure messages into D1 (lib/error-log.js) so they're reachable
  // from the admin console + the admin JSON API, not just the
  // container's local audit sink. Wired only when D1 is present (it
  // defaults to b.externalDb.query, valid after externalDb.init below).
  var errorLog = null;
  if (process.env.D1_BRIDGE_URL && process.env.D1_BRIDGE_SECRET) {
    // Entropy floor on the bridge secret. The Worker route POST
    // /_/db/query is a single-statement SQL oracle on the live D1, and
    // the same secret authorizes /_/r2/put + /_/low-stock-alert, so a
    // weak/guessable secret hands an attacker the whole backend. Flag
    // anything shorter than 32 characters — the deploy recipe generates
    // `randomBytes(32).toString("base64url")` (43 chars), so a documented
    // deploy clears this comfortably. This is a loud boot WARNING rather
    // than a hard refusal: the live secret's length can't be verified out
    // of band at deploy time, so failing the boot on this check would risk
    // wedging an otherwise-healthy deploy. The warning keeps a weak secret
    // visible in the boot log; regenerate it to clear the warning.
    // Enforced only in production: local/e2e boot over http with short
    // test secrets and must keep working.
    if (process.env.NODE_ENV === "production" && process.env.D1_BRIDGE_SECRET.length < 32) {
      process.stderr.write(
        "[server] WARNING: D1_BRIDGE_SECRET is too short (" + process.env.D1_BRIDGE_SECRET.length +
        " chars) — it authorizes the worker DB/R2 bridge and should be at least 32 characters. " +
        "Regenerate with: node -e \"process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))\"\n",
      );
    }
    var d1 = bShop.externaldbD1.create({
      mode:         "service-binding",
      bridgeUrl:    process.env.D1_BRIDGE_URL,
      bridgeSecret: process.env.D1_BRIDGE_SECRET,
      bridgePath:   process.env.D1_BRIDGE_PATH || "/_/db/query",
    });
    b.externalDb.init({ backends: { main: d1 } });
    // Now that externalDb is initialized, the error-log factory's
    // default query handle (b.externalDb.query) is live.
    errorLog = bShop.errorLog.create({});
    // Cursor HMAC key — derived from the deployment-scoped bridge
    // secret via b.crypto.namespaceHash, which domain-separates the
    // derived value by the "catalog-cursor" prefix so a leak in one
    // namespace doesn't expose the other. Stable across container
    // restarts; rotating D1_BRIDGE_SECRET also rotates cursors.
    var cursorSecret = b.crypto.namespaceHash("catalog-cursor", process.env.D1_BRIDGE_SECRET);
    catalog = bShop.catalog.create({
      cursorSecret: cursorSecret,
      // The trigger half of the low-stock alert chain: every stock
      // mutation reports its SKU through the observer slot above, and
      // the alerts engine decides whether available crossed the
      // configured threshold (no threshold / still above → no-op).
      onStockChange: function (sku) {
        return lowStockObserver ? lowStockObserver(sku) : null;
      },
    });
    cart    = bShop.cart.create({ catalog: catalog });
  }

  // The operator-configured shop name (set via the admin setup wizard,
  // persisted to shop_config) drives the storefront header / page
  // titles + the admin header. Read once at boot — edits apply on the
  // next deploy. Falls back to the framework default when unconfigured.
  var bootShopName = "blamejs.shop";
  if (catalog && cart) {
    try { bootShopName = await bShop.config.create({}).get("shop.name", "blamejs.shop"); }
    catch (_e) { /* unconfigured — default */ }
  }

  // Delivery-estimate origin — the inventory-location slug the "Get it by
  // <date>" math ships from. The deliveryEstimate primitive REFUSES to guess
  // an origin, so without this the storefront renders no date (by design).
  // Resolved here at boot (SHOP_ESTIMATE_ORIGIN env, else the shop_config
  // `shop.estimate_origin` row) because the storefront's sfDeps.config is a
  // bare { shop_name } stub with no live .get(). Threaded as a plain slug into
  // sfDeps below; an unconfigured deploy leaves it null and no estimate shows.
  var deliveryEstimateOrigin = process.env.SHOP_ESTIMATE_ORIGIN || null;
  if (!deliveryEstimateOrigin && catalog && cart) {
    try {
      var _eo = await bShop.config.create({}).get("shop.estimate_origin", null);
      if (typeof _eo === "string" && _eo) deliveryEstimateOrigin = _eo;
    } catch (_e) { /* unconfigured — no estimate origin */ }
  }

  // i18n / locale routing — localises the storefront UI chrome (nav,
  // footer, search controls, newsletter band) + mounts the footer locale
  // switcher. The locale-router owns resolution (cookie / ?lang= /
  // Accept-Language / policy default); the translations primitive supplies
  // the chrome strings via b.i18n. Resolved here (before createApp, where
  // top-level await is available) and threaded into the storefront deps.
  // Wired only when the operator has seeded an active locale policy
  // (localeRouter.setActivePolicy) — absent that the storefront renders
  // the English baseline with no switcher, so a fresh deploy keeps working
  // with no extra configuration. Every read is best-effort: an unmigrated
  // locale / translations table degrades to English rather than blocking
  // boot. Resolution order matches the edge Worker (cookie → ?lang= →
  // Accept-Language → default) so both substrates agree.
  var localeWiring = null;
  if (catalog && cart) {
    try {
      var localeRouter = bShop.localeRouter.create({});
      var activePolicy = await localeRouter.activePolicy();
      if (activePolicy) {
        var defaultLocale = activePolicy.default_locale;
        var supportedLocales = activePolicy.supported_locales || [defaultLocale];
        // The switcher options: each supported tag + its display label
        // (the locale's autonym via Intl.DisplayNames, falling back to
        // the tag itself for an unrecognised tag).
        var localeList = supportedLocales.map(function (tag) {
          var label = tag;
          try {
            var dn = new Intl.DisplayNames([tag], { type: "language" });
            label = dn.of(tag) || tag;
          } catch (_e) { /* unknown tag — keep the tag as the label */ }
          return { tag: tag, label: label };
        });
        // Operator `ui`/`chrome` overrides for every supported locale,
        // layered over the shipped English baseline by b.i18n.
        var chromeOverrides = await bShop.translations.readChromeOverrides(
          function (sql, params) { return b.externalDb.query(sql, params); },
          supportedLocales
        );
        localeWiring = {
          localeRouter: localeRouter,
          chromeI18n:   bShop.translations.createChromeI18n({
            defaultLocale: defaultLocale,
            locales:       supportedLocales,
            overrides:     chromeOverrides,
          }),
          localeOptions: { defaultLocale: defaultLocale, locales: localeList, strategy: activePolicy.strategy },
        };
      }
    } catch (_e) { /* no locale policy / unmigrated table — English baseline */ }
  }

  // CAPTCHA gate wiring — resolved here (where `await` is allowed) so the
  // synchronous `routes(r)` callback below can attach the already-resolved
  // provider to sfDeps. Active ONLY when the operator has registered an
  // active provider AND named it in CAPTCHA_PROVIDER_SLUG; absent that this
  // stays null and every high-risk flow behaves exactly as an unconfigured
  // store (the graceful no-op, mirroring the Stripe / PayPal / OAuth blocks).
  // The siteverify HTTPS call is the operator's egress, run through
  // b.httpClient (SSRF-guarded); the primitive owns only the local decision.
  var captchaWiring = null;
  if (catalog && cart && process.env.CAPTCHA_PROVIDER_SLUG) {
    try {
      var captchaSlug = process.env.CAPTCHA_PROVIDER_SLUG;
      var cg = bShop.captchaGate.create({});   // defaults to b.externalDb.query
      // Resolve the active provider row once at boot (public key + kind,
      // never the secret). A missing / inactive / unknown slug leaves the
      // gate inert so the flows are unchanged.
      var capProvider = await cg.getProvider(captchaSlug);
      if (capProvider && capProvider.active && !capProvider.archived_at) {
        // Per-kind siteverify endpoint (public, fixed). The verify callback
        // POSTs the operator's secret + the buyer's token form-encoded and
        // returns the parsed JSON the primitive scores.
        var CAPTCHA_VERIFY_URL = {
          turnstile:    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          hcaptcha:     "https://api.hcaptcha.com/siteverify",
          recaptcha_v2: "https://www.google.com/recaptcha/api/siteverify",
          recaptcha_v3: "https://www.google.com/recaptcha/api/siteverify",
        };
        captchaWiring = {
          captchaGate:         cg,
          captchaProviderSlug: captchaSlug,
          captchaKind:         capProvider.kind,
          captchaPublicKey:    capProvider.public_key,
          // Signup + checkout challenge whenever a provider is active; login
          // is behind CAPTCHA_GATE_LOGIN (passkey login is already phishing-
          // resistant — defensible to default off).
          captchaLoginEnabled: process.env.CAPTCHA_GATE_LOGIN === "1",
          captchaVerify: async function (ctx) {
            var url = CAPTCHA_VERIFY_URL[ctx.kind];
            if (!url) throw new TypeError("captcha: no siteverify URL for kind " + ctx.kind);
            var form = "secret=" + encodeURIComponent(ctx.secret_key) +
                       "&response=" + encodeURIComponent(ctx.token);
            var resp = await b.httpClient.request({
              url:     url,
              method:  "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body:    form,
            });
            var text = resp && resp.body ? resp.body.toString("utf8") : "{}";
            return JSON.parse(text);   // { success, score?, action?, ... }
          },
        };
      }
    } catch (_ce) { /* misconfigured / unmigrated table — leave captcha disabled */ }
  }

  var app = await b.createApp({
    dataDir: DATA_DIR,
    // Generous GLOBAL per-client-IP rate limit — the backstop against
    // credential / passkey spraying, gift-card balance brute-force,
    // checkout hammering, and unauthenticated row-flood writes. Keyed on
    // the real client IP (Cloudflare's cf-connecting-ip behind the
    // Worker, socket address for direct dev connections), NOT the socket
    // peer — behind the fabric every visitor shares the fabric's address,
    // so a socket-keyed global limit would throttle the whole store. The
    // tight per-route limiters + fetch-metadata gate mount inside routes()
    // below. createApp mounts this at the app level, ahead of routes().
    // createApp (v0.13.46+) wires several security middlewares ON by
    // default — cookies, CSP nonce, fetch-metadata, body parser, and CSRF.
    // The shop already mounts its OWN body parser (with the `text/csv`
    // sub-parser the admin CSV import needs) and fetch-metadata (configured
    // `allowMissing` + webhook exemptions), and mounts CSRF, inside routes()
    // below via `mountRouteGuards` — scoped so the edge-rendered, cookie-
    // less, dual-rendered forms are exempt. So disable createApp's app-level
    // duplicates and keep the shop's configured copies as the single source
    // of truth; `cspNonce` stays off to leave the existing strict-`'self'`
    // CSP unchanged. The cookie parser stays on (the scoped CSRF reads the
    // double-submit cookie through it). securityHeaders stays ON but drops
    // the inert Document-Policy header (the vendored default's legacy
    // feature tokens are unrecognized by current browsers — see
    // securityHeadersOpts); this also keeps the container header-consistent
    // with the edge, which sends no Document-Policy.
    middleware: {
      securityHeaders: bShop.securityMiddleware.securityHeadersOpts(),
      rateLimit:       bShop.securityMiddleware.globalRateLimitOpts(),
      // Bot-guard keeps the vendored block-mode defaults but skips the
      // worker→container internal endpoints: those calls carry no browser
      // fingerprint (no User-Agent / Accept-Language), so the default
      // heuristics 403 them before each handler's constant-time
      // D1_BRIDGE_SECRET gate — the stronger check — ever runs. See
      // INTERNAL_BRIDGE_PATHS in lib/security-middleware.js.
      botGuard:        bShop.securityMiddleware.botGuardOpts(),
      csrf:            false,
      bodyParser:      false,
      fetchMetadata:   false,
      cspNonce:        false,
    },
    routes: function (r) {
      // Capture the raw body for payment webhooks BEFORE the JSON parser
      // consumes it — Stripe (and PayPal) verify the signature over the
      // exact bytes. Must precede bodyParser; the webhook handlers read
      // req.rawBody. Harmless for every other path (it only matches POSTs
      // to the listed webhook routes).
      r.use(bShop.storefront.webhookRawBodyCapture(["/api/webhooks/stripe", "/api/webhooks/paypal"]));

      // Body parser — populates req.body from form-encoded + JSON
      // request bodies. Mounted before any POST handler so the
      // storefront cart-write routes can read form fields without
      // re-parsing. The text sub-parser opts in `text/csv` so the
      // admin bulk-import route reads the raw CSV bytes as a string
      // — bumped limit covers the 1 MiB import cap with headroom.
      r.use(b.middleware.bodyParser({
        text: {
          limit:        b.constants.BYTES.mib(2),
          contentTypes: ["text/plain", "text/csv"],
        },
      }));

      // Request-lifecycle security guards — fetch-metadata (refuses
      // cross-site state-changing requests via Sec-Fetch-* without a
      // per-form token, the CSRF defense-in-depth on top of the
      // storefront's SameSite session cookie) + the tight per-client-IP
      // rate limiters on the abusable auth / POST endpoints (login,
      // passkey register, checkout, gift-card balance, register,
      // newsletter, review / question submit, survey). Both exempt the
      // payment webhook paths (cross-site by nature, HMAC-authenticated).
      // Mounted after bodyParser so the gate reads a fully-shaped request
      // and before any storefront / admin route.
      bShop.securityMiddleware.mountRouteGuards(r);

      // Liveness + readiness — the Worker short-circuits /_/health
      // at the edge, but the container also responds so the
      // container's own Docker HEALTHCHECK probe lights up before
      // the Worker is in the picture (local dev, smoke).
      r.get("/_/health", function (_req, res) {
        res.json({ ok: true, container: true });
      });

      // Abandoned-cart recovery — a scheduled pass that scans for carts
      // left idle past `shop.cart_recovery_after_hours` (default 4h),
      // enrolls the eligible ones (known customer + deliverable address
      // + no marketing-opt-out) into a multi-step nurture sequence, and
      // dispatches every step that has come due. The Worker cron POSTs
      // `/_/cart-recovery-tick` (below) once a minute; that handler runs
      // one bounded, drop-silent pass.
      //
      // Delivery is gated: the pass is INERT unless a mailer is wired
      // (SMTP_HOST + MAIL_FROM) AND a `resolveEmail` hook can turn a
      // cart's customer_id into a plaintext address. The customer record
      // stores only an email_hash (never the plaintext) and the carts
      // table carries no email column, so without an operator-supplied
      // resolver there is no deliverable address to recover — the pass
      // no-ops cleanly rather than scanning or sending. A guest cart
      // (no customer_id) likewise carries no address anywhere in the
      // schema and is skipped; guest-cart recovery re-opens the day a
      // guest checkout-email is persisted on the cart and fed through
      // the resolver.
      // Order-access token signing key. Gates guest-order confirmation pages:
      // the storefront verifies the emailed ?k=<token> against this key, and
      // the email factory mints the link with it. Domain-separated from the
      // operator's app secret (VAULT_PASSPHRASE), falling back to the bridge
      // secret, then a dev-only constant — the same derivation chain every
      // other shop secret uses, so one operator secret drives all of them and
      // rotating it rotates the order-access links too.
      var _orderAccessSecret = b.crypto.namespaceHash(
        "order-access-token",
        process.env.VAULT_PASSPHRASE || process.env.D1_BRIDGE_SECRET || "order-access-secret-dev-only",
      );

      // Shared transactional mailer — one b.mail/email instance per boot,
      // null unless the operator configured SMTP. Reused by cart-recovery
      // AND the back-in-stock sweep so both transactional surfaces share the
      // same transport rather than each building its own.
      var txEmail = null;
      // The raw b.mail.create mailer (the `.send(msg)` surface). The shop
      // email factory wraps it with templated methods (orderReceipt, …);
      // the broadcast campaign path needs the raw mailer to compose its
      // own marketing message + RFC 8058 headers, so capture it at
      // function scope (null when SMTP isn't configured).
      var campaignMailer = null;
      if (process.env.SMTP_HOST && process.env.MAIL_FROM) {
        var txMailer = b.mail.create({
          transport: b.mail.transports.smtp({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587,
            user: process.env.SMTP_USER || undefined,
            pass: process.env.SMTP_PASS || undefined,
          }),
          defaults: { from: process.env.MAIL_FROM },
        });
        campaignMailer = txMailer;
        txEmail = bShop.email.create({
          mailer: txMailer,
          // Order-confirmation deep-link signing. Derived (domain-separated)
          // from the operator's app secret so the receipt / resend mail can
          // carry a tokenized "view your order" link that opens a guest's
          // receipt on any device. Falls back to the bridge secret, then a
          // dev-only constant, mirroring every other shop secret derivation.
          // Absent an origin the link is simply omitted.
          orderAccessSecret: _orderAccessSecret,
          shopOrigin:        process.env.SHOP_ORIGIN || "",
        });
      }

      var cartRecoveryPass = null;
      if (catalog && cart) {
        // Cart-recovery reuses the shared transactional mailer (built above).
        // Absent SMTP it's null and the pass gate keeps the cron quiet.
        var recoveryEmail = txEmail;

        // Operator-owned resolver: cart customer_id → deliverable
        // plaintext address. The default deploy has no plaintext-email
        // store (customers persist only the hash), so the stock resolver
        // returns null — which keeps the pass inert until an operator
        // wires their own address lookup here. Returning null is the
        // honest no-deliverable-address signal, not a silent failure.
        var recoveryResolveEmail = function (_candidate) {
          return Promise.resolve(null);
        };

        var recoveryEmailSuppressions = bShop.emailSuppressions.create({
          cursorSecret: process.env.D1_BRIDGE_SECRET
            ? b.crypto.namespaceHash("email-suppressions-cursor", process.env.D1_BRIDGE_SECRET)
            : "email-suppressions-cursor-dev-only",
        });

        // cart-abandonment's recentDetections paginates with an
        // HMAC-tagged cursor, so the primitive demands a cursorSecret in
        // production (it throws at boot otherwise). Derive it from the
        // bridge secret like every other shop cursor; the dev fallback
        // keeps local boots working.
        var abandonmentCursorSecret = process.env.D1_BRIDGE_SECRET
          ? b.crypto.namespaceHash("cart-abandonment-cursor", process.env.D1_BRIDGE_SECRET)
          : "cart-abandonment-cursor-secret-dev-only";

        cartRecoveryPass = bShop.cartRecoveryPass.create({
          cartAbandonment: bShop.cartAbandonment.create({
            cart:         cart,
            cursorSecret: abandonmentCursorSecret,
          }),
          cartRecovery:    bShop.cartRecovery.create({
            email:             recoveryEmail,
            emailSuppressions: recoveryEmailSuppressions,
          }),
          config:        bShop.config.create({}),
          consentLedger: bShop.consentLedger.create({}),
          cartUrlBase:   process.env.SHOP_ORIGIN
            ? process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/cart"
            : null,
          resolveEmail:  recoveryResolveEmail,
        });
      }

      // Internal cron endpoint — the Worker's scheduled() handler POSTs
      // here once a minute over the SHOP service binding. Gated by the
      // shared D1_BRIDGE_SECRET header (same trust root as the SQL / R2
      // bridges) so a publicly-reachable URL can't drive the pass. The
      // pass itself is drop-silent (never throws); a failure surfaces as
      // `{ ok: false }` in the JSON body, not a 5xx that would mark the
      // cron run failed.
      r.post("/_/cart-recovery-tick", async function (req, res) {
        var got = req.headers && req.headers["x-d1-bridge-secret"];
        var want = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want ||
          typeof got !== "string" ||
          got.length !== want.length ||
          !b.crypto.timingSafeEqual(got, want)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!cartRecoveryPass) {
          res.json({ ok: true, enabled: false, reason: "cart recovery not composed (no catalog/cart)" });
          return;
        }
        var summary = await cartRecoveryPass.runPass();
        res.json(summary);
      });

      // Back-in-stock sweep — the Worker's scheduled() handler POSTs here over
      // the SHOP service binding once a minute (a SECOND, independent
      // ctx.waitUntil so a slow stock sweep never blocks cart recovery). Same
      // D1_BRIDGE_SECRET timing-safe gate, same drop-silent / never-5xx shape
      // as /_/cart-recovery-tick. The sweep self-gates cadence below so it
      // doesn't actually scan every minute on an empty/quiet table.
      //
      // Cadence gate: the cron fires every minute, but scanning the table +
      // emailing on every fire is wasteful when stock rarely changes. Gate to
      // one real sweep per STOCK_ALERT_SWEEP_INTERVAL_MS; a minute-fire inside
      // the window returns `{ ok:true, skipped:true }` cheaply.
      var STOCK_ALERT_SWEEP_INTERVAL_MS = process.env.STOCK_ALERT_SWEEP_INTERVAL_MS
        ? parseInt(process.env.STOCK_ALERT_SWEEP_INTERVAL_MS, 10)
        : b.constants.TIME.minutes(15); // default: one real sweep every 15 minutes
      var _lastStockAlertSweepAt = 0;

      r.post("/_/stock-alert-sweep", async function (req, res) {
        var got = req.headers && req.headers["x-d1-bridge-secret"];
        var want = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want ||
          typeof got !== "string" ||
          got.length !== want.length ||
          !b.crypto.timingSafeEqual(got, want)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!stockAlerts) {
          res.json({ ok: true, enabled: false, reason: "stock alerts not composed (no catalog/cart)" });
          return;
        }
        var now = Date.now();
        if (now - _lastStockAlertSweepAt < STOCK_ALERT_SWEEP_INTERVAL_MS) {
          res.json({ ok: true, enabled: true, skipped: true, next_in_ms: STOCK_ALERT_SWEEP_INTERVAL_MS - (now - _lastStockAlertSweepAt) });
          return;
        }
        _lastStockAlertSweepAt = now;
        var summary = { scanned: 0, notified: 0, emailed: 0, cleaned: 0 };
        try {
          var swept = await stockAlerts.scanAndNotify({ now: now });
          summary.scanned = swept.scanned;
          summary.notified = swept.notified;
          // Email each fired row best-effort (drop-silent per row) when SMTP
          // is configured. A single bad address must not poison the sweep.
          if (txEmail) {
            var originBase = (process.env.SHOP_ORIGIN || "").replace(/\/$/, "");
            for (var i = 0; i < swept.rows.length; i += 1) {
              var row = swept.rows[i];
              try {
                // Rows carry sku, not the product slug. Resolve the slug via a
                // cheap indexed read (drop-silent → fall back to /search?q=).
                var productUrl;
                var unsubscribeUrl;
                var titleForSku = row.sku;
                var prodForSku = null;
                try {
                  if (catalog && catalog.products && typeof catalog.products.bySku === "function") {
                    prodForSku = await catalog.products.bySku(row.sku);
                  }
                } catch (_lookupErr) { prodForSku = null; }
                if (prodForSku && prodForSku.slug) {
                  productUrl = originBase + "/products/" + encodeURIComponent(prodForSku.slug);
                  if (prodForSku.title) titleForSku = prodForSku.title;
                } else {
                  productUrl = originBase + "/search?q=" + encodeURIComponent(row.sku);
                }
                // The per-row bearer token scanAndNotify minted for this
                // fired row IS the unsubscribe authorization — no email/sku
                // tuple in the URL to guess.
                unsubscribeUrl = originBase + "/stock-alert/unsubscribe?token=" + encodeURIComponent(row.unsubscribe_token);
                await txEmail.sendBackInStock({
                  to:              row.email_normalised,
                  product_title:   titleForSku,
                  sku:             row.sku,
                  product_url:     productUrl,
                  unsubscribe_url: unsubscribeUrl,
                });
                summary.emailed += 1;
              } catch (_e) { /* drop-silent — a single bad address must not poison the sweep */ }
            }
          }
          var cleaned = await stockAlerts.cleanupExpired({ now: now });
          summary.cleaned = cleaned.removed;
          res.json(Object.assign({ ok: true, enabled: true }, summary));
        } catch (e) {
          // Never 5xx — a thrown sweep would mark the cron run failed.
          res.json({ ok: false, error: (e && e.message) || String(e) });
        }
      });

      // Low-stock alert intake — the InventoryLock DO POSTs here (over the
      // worker's service-binding forward) the moment a checkout decrement
      // crosses a SKU's low_stock_threshold. The DO computed available /
      // threshold under its write lock, so the posted values are
      // authoritative for that instant; the handler validates shape and
      // fires the alerts primitive (inventory_alerts row + the
      // inventory.low_stock webhook + the warn log line). Same
      // D1_BRIDGE_SECRET timing-safe gate as the other internal endpoints,
      // and the same never-5xx shape: alert delivery is best-effort and a
      // handler failure must not fail the DO's decrement caller.
      r.post("/_/low-stock-alert", async function (req, res) {
        var got = req.headers && req.headers["x-d1-bridge-secret"];
        var want = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want ||
          typeof got !== "string" ||
          got.length !== want.length ||
          !b.crypto.timingSafeEqual(got, want)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!inventoryAlerts) {
          res.json({ ok: true, enabled: false, reason: "inventory alerts not composed (no catalog/cart)" });
          return;
        }
        var body = req.body || {};
        try {
          var fired = await inventoryAlerts.fire(body.sku, body.available, body.threshold);
          res.json({ ok: true, enabled: true, id: fired.id });
        } catch (e) {
          // The primitive throws TypeError on a malformed sku/available/
          // threshold — that's a caller bug, answer 400. Anything else
          // (e.g. a transient bridge failure on the INSERT) stays
          // never-5xx: the JSON body carries the error, the DO's
          // fire-and-forget caller is already gone either way.
          if (e instanceof TypeError) {
            res.status(400).json({ ok: false, error: "INVALID_REQUEST" });
            return;
          }
          res.json({ ok: false, error: (e && e.message) || String(e) });
        }
      });

      // Shared config primitive — operator-tunable runtime
      // configuration (tax rules, shipping services, brand name).
      // Built once at boot so the admin write-path and the storefront
      // read-path share the same 30s in-memory cache; admin writes
      // invalidate the entry for the read side.
      var config = catalog && cart ? bShop.config.create({}) : null;

      // Cursor HMAC key for order.listForCustomer — same derivation
      // pattern as catalog's cursor secret. Required in production
      // since v0.0.28 wired customer-account-scoped pagination.
      var orderCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("order-cursor", process.env.D1_BRIDGE_SECRET)
        : "order-cursor-secret-dev-only";

      // Reviews — opts in the storefront review display + submit routes
      // and the admin moderation routes. Single instance shared by both
      // surfaces. Cursor HMAC key derived like the others. The primitive
      // only needs the externalDb query handle.
      var reviewCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("review-cursor", process.env.D1_BRIDGE_SECRET)
        : "review-cursor-secret-dev-only";
      var reviews = (catalog && cart)
        ? bShop.reviews.create({ cursorSecret: reviewCursorSecret })
        : null;

      // Wishlist — opts in the storefront save toggle + /account/wishlist
      // page. Per-customer; cursor HMAC key derived like the others.
      var wishlistCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("wishlist-cursor", process.env.D1_BRIDGE_SECRET)
        : "wishlist-cursor-secret-dev-only";
      var wishlist = (catalog && cart)
        ? bShop.wishlist.create({ cursorSecret: wishlistCursorSecret })
        : null;

      // Wishlist sharing — owner-minted share links on /account/wishlist +
      // the public /wishlist/shared/:token view a giver opens. Composes the
      // wishlist instance above so the shared view reads the owner's entries
      // through the same handle.
      var wishlistSharing = wishlist
        ? bShop.wishlistSharing.create({ wishlist: wishlist })
        : null;

      // Save for later — move cart lines into a per-customer holding
      // list and back. Cursor HMAC key derived like the others.
      var saveForLaterCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("save-for-later-cursor", process.env.D1_BRIDGE_SECRET)
        : "save-for-later-cursor-secret-dev-only";
      var saveForLater = (catalog && cart)
        ? bShop.saveForLater.create({ cursorSecret: saveForLaterCursorSecret, catalog: catalog })
        : null;

      // Gift registry — owner-managed list of desired items (wedding / baby /
      // birthday / …) on /account/registry, plus the public, slug-keyed giver
      // view at /registry/:slug. Composes the catalog so a registry item's sku
      // resolves to a product card + a buyable variant for the giver's cart.
      var giftRegistry = (catalog && cart)
        ? bShop.giftRegistry.create({ catalog: catalog })
        : null;

      // Multi-currency display — converts the catalog's base-currency
      // prices into the visitor's chosen currency for DISPLAY ONLY (the
      // cart / order / payment currency is unchanged). The FX-rate cache +
      // the per-currency display-rounding rule are read from D1 via the
      // externalDb handle this deploy already binds. Both primitives stay
      // resilient when their tables aren't migrated (degrade to base
      // display), so wiring them on a fresh deploy never breaks a priced
      // page. The operator's allow-list of display currencies (base first)
      // comes from `shop.currencies` config; absent it, no switcher
      // renders and every price stays in the base currency.
      var currencyDisplay  = (catalog && cart) ? bShop.currencyDisplay.create({}) : null;
      var currencyRounding = (catalog && cart) ? bShop.currencyRounding.create({}) : null;

      // Address book — per-customer saved addresses on /account/addresses.
      var addresses = (catalog && cart) ? bShop.addresses.create({}) : null;

      // Cookie consent — backs the GDPR / ePrivacy opt-in banner that
      // ships in the chrome of every storefront page, plus the /cookies
      // preference center and the POST /consent handler. The primitive is
      // the durable per-session audit ledger (hashed session id, per-
      // category decision, DNT / GPC honored); the storefront writes a
      // sealed first-party cookie as the runtime gate and records each
      // decision here for the audit trail. Only the externalDb query
      // handle is needed.
      var cookieConsent = (catalog && cart) ? bShop.cookieConsent.create({}) : null;

      // Returns — customer self-serve RMA requests (/account/returns) +
      // operator moderation (/admin/returns). Cursor HMAC key like the
      // others. Single instance shared by both surfaces.
      var returnsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("returns-cursor", process.env.D1_BRIDGE_SECRET)
        : "returns-cursor-secret-dev-only";
      var returns = (catalog && cart)
        ? bShop.returns.create({ cursorSecret: returnsCursorSecret })
        : null;

      // Return-shipping labels — the operator-funded prepaid return label +
      // its carrier-scan timeline, keyed to an approved return. Issuance is
      // an operator action; the storefront surfaces an already-issued label
      // (download + tracking) read-only on the customer's returns detail.
      // The `returns` handle lets a delivered carrier scan flip the RMA to
      // received without the two primitives duplicating state.
      var returnLabels = returns
        ? bShop.returnLabels.create({ returns: returns })
        : null;

      // Support tickets — the customer-service ticketing surface. Opts in
      // the customer intake (/account/support) + the operator queue
      // (/admin/support). One instance shared by both surfaces. The
      // listForCustomer pagination cursor is HMAC-tagged, so the primitive
      // demands a cursorSecret in production (it throws at boot otherwise);
      // derive it from the bridge secret like every other shop cursor.
      var supportCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("support-tickets-cursor", process.env.D1_BRIDGE_SECRET)
        : "support-tickets-cursor-secret-dev-only";
      var supportTickets = (catalog && cart)
        ? bShop.supportTickets.create({ cursorSecret: supportCursorSecret })
        : null;

      // Loyalty — customer points balance + tier, the earn rules that
      // mint points on order events, and the reward catalog customers
      // redeem against. Three composed instances sharing one ledger:
      //   * `loyalty` owns the balance + the audited transaction trail.
      //   * `loyaltyEarnRules` composes `loyalty` so awardForEvent posts
      //     earned points straight to the balance; the order primitive
      //     fans the paid transition into it (earn-on-purchase).
      //   * `loyaltyRedemption` composes `loyalty` so redeeming a reward
      //     debits points + records the redemption.
      // No cursor secret — loyalty pagination cursors are opaque
      // epoch-ms offsets, not HMAC-tagged tuples.
      var loyalty = (catalog && cart) ? bShop.loyalty.create({}) : null;
      var loyaltyEarnRules = (catalog && cart)
        ? bShop.loyaltyEarnRules.create({ loyalty: loyalty })
        : null;
      var loyaltyRedemption = (catalog && cart)
        ? bShop.loyaltyRedemption.create({ loyalty: loyalty })
        : null;

      // Referrals — refer-a-friend with two-sided rewards. `referrals`
      // owns the per-customer code + the invitation funnel; the reward-
      // on-first-order credit rides the order primitive's paid transition
      // (wired below, like the loyalty earn fan-out). `referralLeaderboard`
      // sits on top to surface top-referrer rankings + tiered bonuses.
      // The shareable link points at the container-served /r/<code>
      // landing, which sets the attribution cookie and redirects home —
      // derived from SHOP_ORIGIN so the link is absolute when the operator
      // has set their origin (otherwise the primitive's default base is
      // overridden per request from the Host header inside the route).
      var referralLinkBase = process.env.SHOP_ORIGIN
        ? process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/r/"
        : null;
      var referrals = (catalog && cart)
        ? bShop.referrals.create(referralLinkBase ? { linkBase: referralLinkBase } : {})
        : null;
      var referralLeaderboard = (catalog && cart)
        ? bShop.referralLeaderboard.create({})
        : null;

      // Customers — passkey / OIDC accounts. Opts the storefront /account/*
      // routes in AND the read-only /admin/customers roster. Single instance
      // shared by both surfaces. Cursor HMAC key for the admin list derived
      // like the others. The primitive only needs the externalDb query handle.
      var customersCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("customers-cursor", process.env.D1_BRIDGE_SECRET)
        : "customers-cursor-secret-dev-only";
      var customers = (catalog && cart)
        ? bShop.customers.create({ cursorSecret: customersCursorSecret })
        : null;

      // Per-customer operator satellites surfaced on the customer detail
      // screen (/admin/customers/:id): the account-bound store-credit wallet
      // (grant / deduct, audited ledger), the operator-side CRM notes, and
      // the RFM segment membership (read-only — membership is rule-derived,
      // recomputed by the scheduler, not hand-assigned). Each defaults to the
      // externalDb bridge for its query handle; the two paginating primitives
      // derive an HMAC cursor key like the roster does.
      var storeCredit = (catalog && cart) ? bShop.storeCredit.create({}) : null;
      var customerNotesCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("customer-notes-cursor", process.env.D1_BRIDGE_SECRET)
        : "customer-notes-cursor-secret-dev-only";
      var customerNotes = (catalog && cart)
        ? bShop.customerNotes.create({ cursorSecret: customerNotesCursorSecret })
        : null;
      var customerSegmentsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("customer-segments-cursor", process.env.D1_BRIDGE_SECRET)
        : "customer-segments-cursor-secret-dev-only";
      var customerSegments = (catalog && cart)
        ? bShop.customerSegments.create({ cursorSecret: customerSegmentsCursorSecret })
        : null;

      // ---- email campaigns (consent-gated broadcast) ------------------
      //
      // Marketing broadcast: an operator authors a campaign, targets a
      // mailing audience, and sends — but ONLY to marketing-consented,
      // reachable subscribers, resolved at send time, every message
      // carrying a one-click unsubscribe. Customer email is stored
      // hash-only in this store, so the ONLY deliverable-address source
      // is the newsletter subscriber list (which persists the plaintext
      // address alongside the hash + the opt-out flag). The campaign
      // composition wires that newsletter list as the reachability +
      // consent source. Without SMTP configured (no campaignMailer) the
      // console still mounts (draft / preview) but Send refuses cleanly.
      var newsletter = (catalog && cart) ? bShop.newsletter.create({}) : null;
      var campaignSuppressions = (catalog && cart)
        ? bShop.emailSuppressions.create({
            cursorSecret: process.env.D1_BRIDGE_SECRET
              ? b.crypto.namespaceHash("email-suppressions-cursor", process.env.D1_BRIDGE_SECRET)
              : "email-suppressions-cursor-dev-only",
          })
        : null;
      var mailingAudiencesCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("mailing-audiences-cursor", process.env.D1_BRIDGE_SECRET)
        : "mailing-audiences-cursor-dev-only";
      var mailingAudiences = (catalog && cart)
        ? bShop.mailingAudiences.create({
            newsletter:        newsletter,
            emailSuppressions: campaignSuppressions,
            cursorSecret:      mailingAudiencesCursorSecret,
          })
        : null;
      // The broadcast needs an https origin for the one-click unsubscribe
      // link; the RFC 8058 guard refuses anything else. Absent SHOP_ORIGIN
      // the broadcast path stays unavailable (canBroadcast() === false) and
      // the console says so — never a silent no-op.
      var campaignUnsubBase = process.env.SHOP_ORIGIN
        ? process.env.SHOP_ORIGIN.replace(/\/+$/, "")
        : null;
      var emailCampaigns = (catalog && cart && campaignMailer && mailingAudiences)
        ? bShop.emailCampaigns.create({
            mailingAudiences:   mailingAudiences,
            email:              campaignMailer,
            emailSuppressions:  campaignSuppressions,
            newsletter:         newsletter,
            unsubscribeBaseUrl: campaignUnsubBase,
            listId:             process.env.SHOP_ORIGIN
              ? "marketing." + (function () { try { return new URL(process.env.SHOP_ORIGIN).host; } catch (_e) { return "shop.local"; } })()
              : undefined,
          })
        : null;
      // Customer activity — the read-only chronological per-customer timeline
      // surfaced on the customer-detail screen. It WRITES no event rows of its
      // own: it composes the source primitives that already own each event
      // class (order transitions, wishlist saves, loyalty ledger, support
      // tickets, reviews) and flattens them into one feed. The peer markers are
      // passed below once those instances exist (after `order` is built); each
      // collector switches on only for the peers wired. The listForCustomer
      // pagination cursor is HMAC-tagged, so it demands a cursorSecret in
      // production — derive it from the bridge secret like every other cursor.
      var customerActivityCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("customer-activity-cursor", process.env.D1_BRIDGE_SECRET)
        : "customer-activity-cursor-secret-dev-only";

      // Product Q&A — opts in the storefront published-Q&A display + the
      // ask-a-question route, plus the admin moderation console. Single
      // instance shared by both surfaces. The primitive paginates with
      // opaque (occurred_at:id) cursors rather than HMAC-tagged tuples,
      // so it needs no cursor secret — only the externalDb query handle.
      // Wired with the live `customers` instance so an authenticated
      // questioner's customer_id is verified to exist before the row is
      // stamped.
      var productQa = (catalog && cart)
        ? bShop.productQA.create({ customers: customers })
        : null;

      // Outbound webhooks — operator-registered endpoints receive signed
      // (HMAC-SHA3-512) deliveries on order lifecycle events. One shared
      // instance: the order instances fan out transitions through it
      // (order.create({ webhooks })), and the admin console manages
      // endpoints + monitors deliveries. No external credentials — the
      // signing secret is generated per endpoint on create.
      var webhooks = (catalog && cart) ? bShop.webhooks.create({}) : null;

      // Inventory low-stock alerts — the fan-out half of the InventoryLock
      // DO's threshold check. The DO detects the crossing at decrement time
      // and POSTs /_/low-stock-alert (the internal endpoint above); this
      // instance writes the inventory_alerts row, fans the
      // inventory.low_stock event out through the shared webhooks
      // dispatcher, and emits the warn log line. The same instance backs
      // the /admin/inventory/alerts history screen.
      var inventoryAlerts = (catalog && cart)
        ? bShop.inventoryAlerts.create({ webhooks: webhooks })
        : null;
      // Connect the catalog's stock observer (late-bound at catalog
      // construction) to the alerts engine: a checkout hold, a release,
      // a decrement, or an admin restock that leaves a SKU under its
      // threshold now writes the inventory_alerts row, fans out
      // inventory.low_stock, and emits the warn line — the same
      // checkAndFire the /_/low-stock-alert intake serves for the
      // worker-side path.
      if (inventoryAlerts) {
        lowStockObserver = function (sku) { return inventoryAlerts.checkAndFire(sku); };
      }

      // Inventory-ops back-office — per-location stock, audited moves.
      //
      // `inventoryLocations` owns the (sku, location_code) ledger
      // (`inventory_stock`) and the append-only `inventory_adjustments`
      // audit trail. It is the SOLE owner of per-location stock mutation;
      // every move runs through an atomic conditional-UPDATE guard
      // (`quantity >= need`) so a transfer racing a checkout debit for the
      // last unit can't oversell — the same serialization the catalog
      // hold/decrement guards give the single-bucket aggregate.
      //
      // The catalog `inventory.stock_on_hand` stays the storefront source
      // of truth. A store that never defines a location keeps using the
      // existing /admin/inventory restock unchanged — the default location
      // is implicit, zero config. The inventory-ops admin screens drive
      // BOTH ledgers in step (receive credits the location AND the catalog
      // aggregate; a write-off debits both; a transfer touches only the
      // per-location detail because the aggregate total is unchanged), so
      // the storefront count never diverges from the warehouse breakdown
      // and a receive/transfer that crosses a SKU's threshold still fires
      // the shared low-stock observer through the catalog mutation.
      var inventoryLocations = (catalog && cart)
        ? bShop.inventoryLocations.create({ catalog: catalog })
        : null;

      var inventoryReceiveCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("inventory-receive-cursor", process.env.D1_BRIDGE_SECRET)
        : "inventory-receive-cursor-secret-dev-only";
      var inventoryReceive = (catalog && cart)
        ? bShop.inventoryReceive.create({ catalog: catalog, cursorSecret: inventoryReceiveCursorSecret })
        : null;

      var stockTransfersCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("stock-transfers-cursor", process.env.D1_BRIDGE_SECRET)
        : "stock-transfers-cursor-secret-dev-only";
      var stockTransfers = inventoryLocations
        ? bShop.stockTransfers.create({ inventoryLocations: inventoryLocations, cursorSecret: stockTransfersCursorSecret })
        : null;

      var inventoryWriteoffsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("inventory-writeoffs-cursor", process.env.D1_BRIDGE_SECRET)
        : "inventory-writeoffs-cursor-secret-dev-only";
      var inventoryWriteoffs = inventoryLocations
        ? bShop.inventoryWriteoffs.create({ inventoryLocations: inventoryLocations, cursorSecret: inventoryWriteoffsCursorSecret })
        : null;

      // Order — the FSM-driven post-checkout record. ONE shared instance
      // drives the storefront account/order pages, the storefront checkout
      // confirm, and the admin console — so a transition fired from one
      // surface fans webhooks + loyalty + referrals identically regardless
      // of which surface triggered it. Built here (after webhooks /
      // loyaltyEarnRules / referrals exist) so both the admin block and the
      // storefront block reuse it instead of each standing up its own.
      var order = (catalog && cart)
        ? bShop.order.create({ cursorSecret: orderCursorSecret, webhooks: webhooks, loyaltyEarnRules: loyaltyEarnRules, referrals: referrals, inventory: catalog.inventory, errorLog: errorLog })
        : null;

      // Quotes — the B2B request-for-quote negotiation surface. ONE shared
      // instance backs the customer storefront pages (request from cart, the
      // tokened /quote/:token review + accept/decline, the account quote list)
      // AND the admin console (response queue, detail, respond, withdraw). The
      // `cart` handle lets a customer's request derive its lines from their
      // active cart; the `order` + `inventory` handles let an accepted quote
      // convert into a pending order that reserves shelf stock at conversion
      // (the same hold checkout takes), so a quote can't oversell against a
      // concurrent cart checkout — the pending order owns the holds and settles
      // them on its own paid/cancel edge.
      var quotes = (catalog && cart && order)
        ? bShop.quotes.create({ cart: cart, order: order, inventory: catalog.inventory })
        : null;

      // Convert an accepted quote into a pending order. Resolves the
      // customer's default shipping address for the order ship_to (the order
      // primitive requires only the country, which every saved address
      // carries); a customer with no saved address yet leaves conversion to
      // the operator from the console. Used by the storefront accept routes so
      // the inventory holds land at acceptance. Returns the converted quote,
      // or null when conversion isn't possible (no address / no handles).
      var convertQuoteToOrder = (quotes && addresses && cart)
        ? async function (quoteId) {
            var q = await quotes.getQuote(quoteId);
            if (!q || q.status !== "accepted") return null;
            var shipAddr = await addresses.defaultShipping(q.customer_id);
            if (!shipAddr || !shipAddr.country) return null;
            var shipTo = {
              name:         shipAddr.recipient_name || null,
              street_line1: shipAddr.street_line1 || "",
              street_line2: shipAddr.street_line2 || null,
              city:         shipAddr.city || "",
              region:       shipAddr.region || "",
              postal_code:  shipAddr.postal_code || "",
              country:      shipAddr.country,
            };
            // The orders.cart_id column is FK-constrained to carts(id), so a
            // quote-driven order needs a real backing cart row. Mint a fresh
            // converted-status cart pinned to the customer (the quote already
            // snapshotted the lines + prices; this cart is the order's stable
            // pointer back to the negotiation, not a live shopping cart).
            var convSession = "quote_" + quoteId.replace(/-/g, "").slice(0, 24);
            var convCart = await cart.create(convSession, { currency: q.currency || "USD" });
            try { await cart.setCustomer(convCart.id, q.customer_id); } catch (_e) { /* best-effort pin */ }
            try { await cart.setStatus(convCart.id, "converted"); } catch (_e) { /* best-effort */ }
            return await quotes.convertToOrder({
              quote_id:   quoteId,
              ship_to:    shipTo,
              cart_id:    convCart.id,
              session_id: convCart.id,
            });
          }
        : null;

      // Notify a customer that their quote was priced. Resolves the quote's
      // owner + a fresh single-use view token, formats the quoted total
      // through pricing, and sends the quote-responded email via the shared
      // transactional mailer. Drop-silent + best-effort — a mail hiccup must
      // never fail the operator's respond action. Null (no-op) when SMTP /
      // a shop origin isn't configured, since the email needs an absolute
      // link the customer can open.
      var notifyQuoteResponded = (quotes && txEmail && customers && process.env.SHOP_ORIGIN)
        ? async function (quoteId) {
            var q = await quotes.getQuote(quoteId);
            if (!q || q.status !== "responded") return;
            var customer = await customers.get(q.customer_id);
            // The default deploy persists only the email HASH, so there is no
            // deliverable plaintext address unless the operator wired a lookup.
            // Absent a deliverable address the notify is a silent no-op (the
            // customer still finds the quote in their account).
            var toEmail = customer && customer.email ? customer.email : null;
            if (!toEmail) return;
            var issued = await quotes.issueViewToken(quoteId);
            if (!issued) return;
            var base = process.env.SHOP_ORIGIN.replace(/\/+$/, "");
            var quoteUrl = base + "/quote/" + encodeURIComponent(issued.plaintext_token);
            var validUntil = q.valid_until ? new Date(Number(q.valid_until)).toUTCString() : "—";
            await txEmail.quoteResponded({
              customer_email:  toEmail,
              customer_name:   (customer && customer.display_name) || "there",
              total_formatted: bShop.pricing.format(q.total_minor || 0, q.currency || "USD"),
              valid_until:     validUntil,
              quote_url:       quoteUrl,
            });
          }
        : null;

      // Order notes — threaded customer-service notes attached to an order,
      // surfaced as a panel on the admin order-detail screen. ONE shared
      // instance backs the console add/list/lifecycle. The listForOrder
      // pagination cursor is HMAC-tagged, so the primitive demands a
      // cursorSecret in production — derive it from the bridge secret like
      // every other shop cursor.
      var orderNotesCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("order-notes-cursor", process.env.D1_BRIDGE_SECRET)
        : "order-notes-cursor-secret-dev-only";
      var orderNotes = (catalog && cart)
        ? bShop.orderNotes.create({ cursorSecret: orderNotesCursorSecret })
        : null;

      // Customer activity — read-only aggregator over the source primitives.
      // The peer markers flip each collector on; absent a peer that source is
      // skipped silently. order_transitions (via the shared `order` FSM),
      // wishlist_entries, loyalty_transactions, support_tickets, and reviews
      // are all populated by the instances already built above, so the timeline
      // is fed by the existing write paths — no new recording call is needed.
      var customerActivity = (catalog && cart)
        ? bShop.customerActivity.create({
            cursorSecret:   customerActivityCursorSecret,
            order:          order,
            wishlist:       wishlist,
            loyalty:        loyalty,
            supportTickets: supportTickets,
            reviews:        reviews,
          })
        : null;

      // Pre-orders — reservations against a SKU that isn't released yet. ONE
      // shared instance backs the storefront PDP reserve CTA + the customer
      // /account/preorders surface AND the admin campaign console. The shared
      // `order` handle is wired in so launchCampaign's convertReservationToOrder
      // lands a real order (the customer then pays it through normal checkout —
      // the reservation itself never charges). Boot stays resilient: every
      // route that reads it degrades gracefully if the preorder tables haven't
      // been migrated.
      //
      // The preorder primitive calls `orderHandle.createFromCart({ customer_id,
      // lines: [{ sku, variant_id, quantity, unit_price_minor, currency }],
      // preorder_reservation_id, preorder_campaign_slug })` — a per-line shape
      // the order primitive's own createFromCart (which expects cart_id /
      // session_id / totals / ship_to / lines[].qty+unit_amount_minor) doesn't
      // accept directly. This thin adapter bridges the two: it computes the
      // order totals from the reserved line(s), synthesizes a cart/session id
      // for the converted-at-launch order, and forwards a valid createFromCart
      // input — composition over patching either primitive. The order lands in
      // `pending` (unpaid); the customer pays it through normal Stripe-gated
      // checkout, so the reservation→order conversion never charges.
      var preorderOrderAdapter = (order && cart && catalog) ? {
        createFromCart: async function (input) {
          var lines = (input && input.lines) || [];
          var currency = (lines[0] && lines[0].currency) || "USD";
          var subtotal = 0;
          var orderLines = [];
          for (var li = 0; li < lines.length; li += 1) {
            var l = lines[li];
            var qty = Number(l.quantity) || 0;
            var unit = Number(l.unit_price_minor) || 0;
            subtotal += qty * unit;
            // order_lines.variant_id is NOT NULL; the campaign may carry no
            // variant_id (it pivots on SKU). Resolve the variant from the SKU
            // so the converted order line references a real variant row.
            var variantId = l.variant_id;
            if (variantId == null) {
              var vrow = await catalog.variants.bySku(l.sku);
              variantId = vrow ? vrow.id : null;
            }
            orderLines.push({ variant_id: variantId, sku: l.sku, qty: qty, unit_amount_minor: unit, unit_currency: l.currency || currency });
          }
          // The orders row carries a NOT NULL cart_id with a FK to carts — mint
          // a fresh cart bound to a synthesized session for the converted order
          // so the FK holds (a launch conversion has no live shopper session;
          // the reservation pre-dates the cart).
          var sessionId = b.uuid.v7();
          var madeCart = await cart.create(sessionId, { currency: currency });
          return await order.createFromCart({
            cart_id:           madeCart.id,
            session_id:        sessionId,
            customer_id:       input.customer_id,
            currency:          currency,
            lines:             orderLines,
            subtotal_minor:    subtotal,
            discount_minor:    0,
            tax_minor:         0,
            shipping_minor:    0,
            grand_total_minor: subtotal,
            ship_to:           { country: "US" },
            reason:            "preorder-launch:" + (input.preorder_campaign_slug || ""),
          });
        },
      } : null;
      var preorder = (catalog && cart)
        ? bShop.preorder.create({ order: preorderOrderAdapter || undefined })
        : null;

      // Order tracking — the post-handoff shipment + carrier-event ledger.
      // Wired with the shared `order` instance so marking a shipment
      // delivered also drives the parent order's FSM to `delivered` without a
      // second operator call. Surfaced read-only on the customer order page
      // (status timeline + tracking link) and managed from the admin order
      // detail (attach a shipment, record carrier events). Boot stays
      // resilient: the instance is constructed unconditionally here, but
      // every route that reads it degrades to "no tracking yet" if the
      // shipments table hasn't been migrated.
      var orderTracking = (catalog && cart)
        ? bShop.orderTracking.create({ order: order })
        : null;

      // Order exchanges — the customer-requested same-value item SWAP
      // lifecycle (distinct from refund-only returns). One shared instance
      // backs both the customer request surface (/account/orders/:id/exchange
      // + /account/exchanges) and the operator queue (/admin/exchanges). The
      // `order` handle resolves the customer→order linkage so exchangesForCustomer
      // is scoped to the requesting shopper's own orders.
      var orderExchanges = (catalog && cart)
        ? bShop.orderExchanges.create({ order: order })
        : null;

      // Order ratings — per-order shipping/packaging/recommend feedback. One
      // shared instance backs both the customer surface (the rating form +
      // display on /orders/:id) and the operator moderation queue
      // (/admin/ratings). Reads/writes the order_ratings table via the shared
      // externalDb query handle; every route that reads it degrades to "no
      // rating panel" if the table hasn't been migrated.
      var orderRatings = (catalog && cart)
        ? bShop.orderRatings.create({})
        : null;

      // Click-and-collect (BOPIS) — pickup-location CRUD + the front-counter
      // pickup queue (admin) and a checkout "pick up in store" option +
      // per-order pickup status (storefront). The shared `order` handle lets
      // markPickedUp drive the parent order to delivered and customerSchedules
      // resolve the customer→order linkage. `notifications` / `inventoryLocations`
      // are intentionally NOT passed — the factory throws at boot if a handle
      // is supplied that lacks enqueue / stockForSku, and neither surface is
      // wired here; absent them the FSM transition still lands. Every route
      // that reads it degrades gracefully if the pickup tables aren't migrated.
      var clickAndCollect = (catalog && cart)
        ? bShop.clickAndCollect.create({ order: order })
        : null;

      // Gift options — operator-defined gift-wrap catalog (admin) + a cart/
      // checkout gift UI (wrap + message + recipient + hide-prices). `catalog`
      // is REQUIRED by the factory so defineWrap can verify wrap_sku resolves
      // to a real variant. The wrap fee rides as a real cart LINE so it flows
      // through pricing.totals and is charged correctly (never a post-commit
      // hook). Container-only.
      var giftOptions = (catalog && cart)
        ? bShop.giftOptions.create({ catalog: catalog })
        : null;

      // Saved payment methods — per-customer vaulted processor tokens. Built
      // unconditionally where the data layer exists (it needs only the
      // externalDb query handle); the add-card SetupIntent flow + checkout
      // surfacing only EXPOSE inside the Stripe-configured block below. The
      // shop stores only the opaque pm_… token — never the PAN/CVV.
      var paymentMethods = (catalog && cart)
        ? bShop.paymentMethods.create({})
        : null;

      // Back-in-stock alerts — double-opt-in "notify me" subscriptions + the
      // scan-and-notify sweeper. catalog.inventory.get(sku) drives the sweep;
      // `notifications` is intentionally omitted (no in-app notifications
      // surface is wired) so scanAndNotify stamps notified_at + returns the
      // fired rows, which the cron handler emails via the shared transactional
      // mailer. Gate on catalog (subscribe/confirm need no inventory; the
      // sweep does) AND cart (the storefront mount gate).
      var stockAlerts = (catalog && cart)
        ? bShop.stockAlerts.create({ catalog: catalog })
        : null;

      // Wishlist alert + digest crons. wishlistAlerts fires event-driven
      // "this saved item just dropped / restocked" emails; wishlistDigest
      // sends the periodic rollup. Both compose the wishlist + catalog
      // instances above plus the SHARED transactional mailer + email
      // resolver the cart-recovery block built (recoveryEmail /
      // recoveryResolveEmail / recoveryEmailSuppressions) so the three
      // mailer-backed surfaces share one transport instead of each
      // building its own (audit-existing-code). Both are gated on
      // recoveryEmail being non-null: the factories throw if the email
      // handle lacks sendWishlistDiscount / sendWishlistDigest, and an
      // unconfigured deploy (no SMTP) has no mailer — so the instances are
      // null and the cron ticks report enabled:false.
      //
      // INERT BY DEFAULT even WITH a mailer: the customers table stores
      // only an email_hash (never plaintext), so recoveryResolveEmail
      // returns null exactly like cart-recovery — every otherwise-firing
      // candidate is accounted `no_email` and nothing sends. The re-open
      // condition is the same as cart-recovery: an operator wires an
      // emailForCustomer resolver against their own plaintext-address
      // store.
      var wishlistAlerts = (wishlist && catalog && recoveryEmail)
        ? bShop.wishlistAlerts.create({
            wishlist:         wishlist,
            catalog:          catalog,
            email:            recoveryEmail,
            stockAlerts:      stockAlerts || null,
            emailForCustomer: recoveryResolveEmail,
            cursorSecret:     process.env.D1_BRIDGE_SECRET
              ? b.crypto.namespaceHash("wishlist-alerts-cursor", process.env.D1_BRIDGE_SECRET)
              : "wishlist-alerts-cursor-secret-dev-only",
          })
        : null;
      var wishlistDigest = (wishlist && catalog && recoveryEmail)
        ? bShop.wishlistDigest.create({
            wishlist:          wishlist,
            catalog:           catalog,
            email:             recoveryEmail,
            emailSuppressions: recoveryEmailSuppressions,
            emailForCustomer:  recoveryResolveEmail,
          })
        : null;

      // Customer-portal magic-link — a passwordless entry for shoppers
      // without a passkey or a social login. The primitive mints a
      // single-use, hashed-at-rest, 15-min-default session token; the
      // storefront emails the link and redeems it into the sealed
      // shop_auth cookie. INERT without a mailer: the storefront's
      // /account/login/link surface degrades to the enumeration-safe
      // "if an account exists we've emailed a link" with no actual send,
      // and passkey / OAuth login are unchanged. Built unconditionally
      // where the data layer exists (it needs only the externalDb query
      // handle); the magic-link ROUTES gate on the mailer (wired into
      // sfDeps below only when recoveryEmail is non-null).
      var customerPortal = (catalog && cart)
        ? bShop.customerPortal.create({})
        : null;

      // Cadence gate for the wishlist-alerts sweep. The Worker cron fires
      // every minute, but a full alerts sweep walks every wishlist entry ×
      // every live policy (price/inventory reads each) — expensive and
      // pointless at minute granularity. Run at most one real sweep per
      // interval; a minute-fire inside the window returns cheaply. The
      // digest sweep needs NO process-local gate: dispatchTick self-limits
      // via next_dispatch_at <= now, so a minute-fire only picks up due
      // enrollments.
      var WISHLIST_ALERTS_SWEEP_INTERVAL_MS = process.env.WISHLIST_ALERTS_SWEEP_INTERVAL_MS
        ? parseInt(process.env.WISHLIST_ALERTS_SWEEP_INTERVAL_MS, 10)
        : b.constants.TIME.hours(6);
      var _lastWishlistAlertsSweepAt = 0;

      // Internal cron-tick endpoints — the Worker's scheduled() POSTs here
      // over the SHOP service binding once a minute, gated by the shared
      // D1_BRIDGE_SECRET header (same trust root as the SQL / R2 bridges).
      // Both are drop-silent at the row level inside the primitives (every
      // catch in scanAndDispatch / dispatchTick accounts into skipped_by,
      // never throws), so a flapping mailer can't 5xx the tick and mark the
      // cron run failed.
      r.post("/_/wishlist-alerts-sweep", async function (req, res) {
        var got = req.headers && req.headers["x-d1-bridge-secret"];
        var want = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want ||
          typeof got !== "string" ||
          got.length !== want.length ||
          !b.crypto.timingSafeEqual(got, want)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!wishlistAlerts) {
          res.json({ ok: true, enabled: false, reason: "wishlist alerts not composed (no mailer)" });
          return;
        }
        var nowMs = Date.now();
        if (nowMs - _lastWishlistAlertsSweepAt < WISHLIST_ALERTS_SWEEP_INTERVAL_MS) {
          res.json({ ok: true, enabled: true, skipped: "cadence", next_in_ms: WISHLIST_ALERTS_SWEEP_INTERVAL_MS - (nowMs - _lastWishlistAlertsSweepAt) });
          return;
        }
        _lastWishlistAlertsSweepAt = nowMs;
        var summary = await wishlistAlerts.scanAndDispatch({ now: nowMs });
        res.json({ ok: true, enabled: true, summary: summary });
      });

      r.post("/_/wishlist-digest-sweep", async function (req, res) {
        var got2 = req.headers && req.headers["x-d1-bridge-secret"];
        var want2 = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want2 ||
          typeof got2 !== "string" ||
          got2.length !== want2.length ||
          !b.crypto.timingSafeEqual(got2, want2)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!wishlistDigest) {
          res.json({ ok: true, enabled: false, reason: "wishlist digest not composed (no mailer)" });
          return;
        }
        var summary = await wishlistDigest.dispatchTick({ now: Date.now() });
        res.json({ ok: true, enabled: true, summary: summary });
      });

      // Email-campaign broadcast tick — the Worker's scheduled() POSTs here
      // over the SHOP service binding. Drains campaigns due for send
      // (scheduled with schedule_at <= now) plus any parked in `sending` by
      // a prior pass's rate-budget pause, sending each as a consent-gated,
      // RFC 8058-unsubscribable broadcast against the deliverable plaintext
      // address source. Same shared-secret timing-safe gate + never-5xx
      // shape as the other ticks. Inert (enabled:false) on a deploy with no
      // SMTP / no deliverable-address source.
      r.post("/_/campaign-send-tick", async function (req, res) {
        var got = req.headers && req.headers["x-d1-bridge-secret"];
        var want = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want ||
          typeof got !== "string" ||
          got.length !== want.length ||
          !b.crypto.timingSafeEqual(got, want)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!emailCampaigns) {
          res.json({ ok: true, enabled: false, reason: "email campaigns not composed (no mailer / no address source)" });
          return;
        }
        try {
          var summary = await emailCampaigns.broadcastTick({ now: Date.now() });
          res.json({ ok: true, enabled: summary.enabled, dispatched: summary.dispatched });
        } catch (e) {
          // Never 5xx — a thrown tick would mark the cron run failed.
          res.json({ ok: false, error: (e && e.message) || String(e) });
        }
      });

      // Customer-portal session-expiry tick — flips stale `issued`
      // magic-link rows to `expired` so the FSM column stays durable for
      // audit. Cheap (one bounded UPDATE) every minute; no cadence gate.
      // Inert (no-op count) until the magic-link surface mints tokens.
      r.post("/_/customer-portal-expire", async function (req, res) {
        var got3 = req.headers && req.headers["x-d1-bridge-secret"];
        var want3 = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want3 ||
          typeof got3 !== "string" ||
          got3.length !== want3.length ||
          !b.crypto.timingSafeEqual(got3, want3)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!customerPortal) {
          res.json({ ok: true, enabled: false, reason: "customer portal not composed" });
          return;
        }
        // Expire sessions whose TTL elapsed more than a day ago (the
        // verify path always re-checks expiry; this just durably stamps
        // the FSM). C.TIME returns ms; expireOlderThan takes seconds.
        var summary;
        try {
          summary = await customerPortal.expireOlderThan(b.constants.TIME.days(1) / 1000);
        } catch (e) {
          res.json({ ok: false, error: (e && e.message) || String(e) });
          return;
        }
        res.json({ ok: true, enabled: true, summary: summary });
      });

      // Search ranking — operator-tunable weight sets + per-query pins. The
      // /search container handler reranks its candidate universe through
      // applyToResults; the admin console authors weight sets + pins. The
      // catalog binding is OPTIONAL (only rankQuery needs it; the route uses
      // applyToResults with its own roster), so construct without catalog.
      var searchRanking = (catalog && cart) ? bShop.searchRanking.create({}) : null;

      // Trust badges — operator-authored trust/certification badges rendered
      // at the container-only checkout + order-confirmation placements (the
      // edge-cached header/footer/pdp/cart_review placements are deferred —
      // they'd need worker/render twins). SVG sanitized at define time via
      // b.guardSvg; URLs through b.safeUrl. Only the externalDb query handle.
      var trustBadges = (catalog && cart) ? bShop.trustBadges.create({}) : null;

      // Fulfillment ops — the warehouse-side surfaces over the order +
      // shipment data. Pick lists consolidate open orders into an aisle-
      // sequenced picker route (composing order.get + orderTracking for
      // the on-complete shipment fan-out); shipping labels record a
      // carrier-minted label against a shipment; split shipments plan +
      // execute multi-parcel fulfillment (one orderTracking shipment per
      // parcel). All three only need the externalDb query handle plus the
      // shared order / orderTracking instances. Every admin route that
      // reads them degrades gracefully if the backing table is missing.
      var pickLists      = (catalog && cart && orderTracking)
        ? bShop.pickLists.create({ order: order, orderTracking: orderTracking })
        : null;
      var shippingLabels = (catalog && cart) ? bShop.shippingLabels.create({}) : null;
      var splitShipments = (catalog && cart && orderTracking)
        ? bShop.splitShipments.create({ order: order, orderTracking: orderTracking })
        : null;

      // Reporting + printable order documents — operator surfaces over the
      // existing order data. salesReports aggregates pure read-only SQL over
      // orders/order_lines for the /admin/reports screen; printReceipts +
      // packingSlips render print-optimized HTML documents for an order.
      // All three only need the externalDb query handle (+ the shared order
      // instance for the document renderers). The cursor HMAC key is derived
      // like the other primitives so production never falls back to the
      // dev-only placeholder.
      var salesReportsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("sales-reports-cursor", process.env.D1_BRIDGE_SECRET)
        : "sales-reports-cursor-secret-dev-only";
      var salesReports  = (catalog && cart) ? bShop.salesReports.create({ cursorSecret: salesReportsCursorSecret }) : null;

      // Analytics — pure read-only aggregate queries over orders/order_lines
      // (units-ranked SKU performance, revenue-by-day trend) plus the
      // pre-purchase event stream (browse→buy funnel, most-viewed products,
      // top search terms) for the /admin/analytics screen. Like salesReports
      // it needs only the externalDb query handle (create() falls back to
      // `b.externalDb.query`); the screen is read-only and the primitive
      // bounds every window/limit itself.
      var analytics     = (catalog && cart) ? bShop.analytics.create({}) : null;

      // Order export — bulk date-range CSV / NDJSON dump of the orders
      // table for the admin /admin/exports screen, plus the scheduled-
      // export job queue a background worker drains. Reads the orders
      // table via the shared externalDb query handle; the cursor HMAC key
      // for the resumable stream + the scheduled-export pagination is
      // derived like the other primitives so production never falls back
      // to the dev-only placeholder.
      var orderExportCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("order-export-cursor", process.env.D1_BRIDGE_SECRET)
        : "order-export-cursor-secret-dev-only";
      var orderExport   = (catalog && cart)
        ? bShop.orderExport.create({ order: order, cursorSecret: orderExportCursorSecret })
        : null;
      var printReceipts = (catalog && cart) ? bShop.printReceipts.create({ order: order }) : null;
      var packingSlips  = (catalog && cart) ? bShop.packingSlips.create({ order: order }) : null;

      // Gift cards — prepaid bearer balance redeemable at checkout, plus
      // the append-only ledger of credit/debit/expire events. The card
      // primitive owns the code + the balance snapshot; the ledger is
      // the audit trail surfaced in the admin console. Both only need
      // the externalDb query handle.
      var giftcards      = (catalog && cart) ? bShop.giftcards.create({}) : null;
      var giftCardLedger = (catalog && cart) ? bShop.giftCardLedger.create({}) : null;

      // Announcement bar — sitewide operator promo/notice strip. The
      // primitive resolves the highest-priority active announcement for a
      // viewer (theme rank urgency>promo>info>success) after audience +
      // dismissal gating; the storefront renders it as page-top chrome and
      // the admin console manages it. The console exposes the all / guest /
      // logged_in audiences; the primitive's segment audience needs an
      // isMember(customer_id, segment_slug) handle (the segments primitive
      // exposes segmentsForCustomer, not isMember) so it stays unexposed
      // until that adapter is wired — segment rows are simply not offered.
      var announcementBar = (catalog && cart) ? bShop.announcementBar.create({}) : null;

      // Promo banners — operator-authored marketing at six fixed storefront
      // placements (top_strip / homepage_hero / pdp_side / cart_side /
      // search_empty / footer). The storefront resolves + renders the active
      // banner per placement per request and counts impressions/clicks; the
      // admin console manages the rows. The console exposes the all / guest /
      // logged_in audiences; the primitive's segment audience needs an
      // isMember(customer_id, segment_slug) handle (the segments primitive
      // exposes segmentsForCustomer, not isMember), so segment rows stay
      // unexposed until that adapter is wired — exactly like the announcement
      // bar.
      var promoBanners = (catalog && cart) ? bShop.promoBanners.create({}) : null;

      // Customer surveys — token-gated NPS/CSAT/CES/custom feedback. The
      // storefront serves the token survey page (/survey/:token) + records
      // responses; the admin console defines surveys, issues invitations,
      // and reads the rollup. The invitation token is the access (no login).
      var customerSurveys = (catalog && cart) ? bShop.customerSurveys.create({}) : null;

      // Blog — operator-published editorial posts. The edge Worker serves
      // the customer-facing /blog index, /blog/:slug posts, the RSS feed,
      // and the sitemap entries, reading only published rows. The admin
      // console authors the posts: create as draft, edit, publish /
      // unpublish, archive / restore. A draft is invisible to the
      // storefront until it's published. Needs a cursor secret for the
      // published-list pagination, derived like the other primitives so
      // production never falls back to the dev-only placeholder.
      var blogCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("blog-articles-cursor", process.env.D1_BRIDGE_SECRET)
        : "blog-articles-cursor-secret-dev-only";
      var blog = (catalog && cart)
        ? bShop.blogArticles.create({ cursorSecret: blogCursorSecret })
        : null;

      // Knowledge base — the self-serve help center. The container serves
      // the customer-facing /help index + /help/:slug reader (reading only
      // published rows) and records the "was this helpful?" votes; the admin
      // console authors the articles: create as draft, edit, publish /
      // unpublish, archive. A draft / archived article is invisible to the
      // storefront. Needs a cursor secret for the article-list pagination,
      // derived like the other primitives so production never falls back to
      // the dev-only placeholder.
      var kbCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("knowledge-base-cursor", process.env.D1_BRIDGE_SECRET)
        : "knowledge-base-cursor-secret-dev-only";
      var knowledgeBase = (catalog && cart)
        ? bShop.knowledgeBase.create({ cursorSecret: kbCursorSecret })
        : null;

      // Storefront content pages — operator-authored Markdown documents
      // (About, Shipping, Returns, Privacy, Terms, the long tail every
      // shop needs) served at /pages/:slug. The edge Worker serves the
      // customer-facing page, reading only published rows; the admin
      // console authors them: create as draft, edit, publish / unpublish,
      // archive / restore. A draft is invisible to the storefront until
      // it's published.
      var storefrontPages = (catalog && cart) ? bShop.storefrontPages.create({}) : null;

      // robots.txt crawl policy — operator-defined per-bot Allow / Disallow
      // stanzas + sitemap declarations, served on the public /robots.txt
      // route. Absent any defined rules the storefront keeps its hardcoded
      // Disallow set (the route falls back), so a fresh deploy still ships a
      // safe robots.txt.
      var robotsConfig = (catalog && cart) ? bShop.robotsConfig.create({}) : null;

      // PWA manifest + service worker — the operator override for the
      // installable-app chrome served at /manifest.webmanifest + /sw.js.
      // Absent an active row the storefront serves a shipped default (the
      // route falls back), so the `<link rel="manifest">` in every layout
      // never 404s. Cursor secret derived like the other paginated lists.
      var pwaManifestCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("pwa-manifest-cursor", process.env.D1_BRIDGE_SECRET)
        : "pwa-manifest-cursor-secret-dev-only";
      var pwaManifest = (catalog && cart)
        ? bShop.pwaManifest.create({ cursorSecret: pwaManifestCursorSecret })
        : null;

      // Business hours — operator-defined open/close schedules surfaced on a
      // public /hours page (week grid + live open/closed) and managed from
      // the admin console. Timezone-aware; holidays + one-off exceptions
      // override the weekly base.
      var businessHours = (catalog && cart) ? bShop.businessHours.create({}) : null;

      // Recommendations — operator-curated overrides + co-purchase /
      // category-popular / in-stock signals. Composes the catalog handle;
      // powers the post-purchase "Customers also bought" rail.
      var recommendations = (catalog && cart) ? bShop.recommendations.create({ catalog: catalog }) : null;

      // Bundles — virtual kit SKUs surfaced on the PDP as a "Bundle &
      // save" rail with an atomic add-all-members action. Composes the
      // catalog handle (component SKUs resolve through it) + a cursor
      // secret for the operator-facing list. The storefront prices each
      // bundle server-side from the live catalog.
      var bundlesCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("bundles-cursor", process.env.D1_BRIDGE_SECRET)
        : "bundles-cursor-secret-dev-only";
      var bundles = (catalog && cart)
        ? bShop.bundles.create({ catalog: catalog, cursorSecret: bundlesCursorSecret })
        : null;

      // Quantity discounts — automatic per-line price breaks ("buy 5,
      // save 10%"). Surfaced on the PDP as a quantity-break table and
      // applied server-side at cart render + checkout so the line +
      // cart totals reflect the break. Composes the catalog handle for
      // the sku-scope referential check.
      var quantityDiscounts = (catalog && cart)
        ? bShop.quantityDiscounts.create({ catalog: catalog })
        : null;

      // Collections — operator-curated + smart product lists, surfaced
      // as public /collections browse pages. Needs the catalog handle
      // (smart collections walk the catalog) + a cursor secret.
      var collectionsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("collections-cursor", process.env.D1_BRIDGE_SECRET)
        : "collections-cursor-secret-dev-only";
      var collections = (catalog && cart)
        ? bShop.collections.create({ catalog: catalog, cursorSecret: collectionsCursorSecret })
        : null;

      // Category navigation — the hierarchical category tree surfaced as
      // public /categories browse pages (index + per-category breadcrumb
      // + sub-category grid). Composes the catalog handle (held for the
      // product-count adjacency); the browse pages read only the tree.
      var categoryNavigation = (catalog && cart)
        ? bShop.categoryNavigation.create({ catalog: catalog })
        : null;

      // Recently viewed — the signed-in customer's browse history.
      // Views are recorded on the PDP and surfaced at
      // /account/recently-viewed. Composes the catalog handle for
      // product resolution.
      var recentlyViewed = (catalog && cart)
        ? bShop.recentlyViewed.create({ catalog: catalog })
        : null;

      // Product compare — the side-by-side comparison basket behind the
      // PDP "Add to compare" toggle + the /compare table. The basket is
      // keyed on the storefront session cookie (namespace-hashed by the
      // primitive before it touches the database); a logged-in shopper's
      // customer_id rides alongside. compareTable resolves the attribute
      // matrix through this `catalog` adapter — `getProduct` returns the
      // product enriched with a `variants` array (the primitive's
      // variant-sourced attributes read `price_minor` / `weight` / `sku`
      // off the first variant) plus the current USD price, so the baked-in
      // price / sku / weight attributes resolve against this catalog's
      // column shape. A per-resolve failure degrades to a null product
      // (the table renders "—" / "no longer available"), never throws.
      var productCompare = (catalog && cart)
        ? bShop.productCompare.create({
            catalog: {
              getProduct: async function (productId) {
                var product = await catalog.products.get(productId);
                if (!product || product.status !== "active") return null;
                var variants = await catalog.variants.listForProduct(productId);
                var enrichedVariants = [];
                for (var vi = 0; vi < variants.length; vi += 1) {
                  var v = variants[vi];
                  var priceMinor = null;
                  var pr = await catalog.prices.current(v.id, "USD");
                  if (pr) priceMinor = pr.amount_minor;
                  enrichedVariants.push({
                    sku:         v.sku,
                    weight:      v.weight_grams,
                    price_minor: priceMinor,
                  });
                }
                return Object.assign({}, product, { variants: enrichedVariants });
              },
            },
          })
        : null;

      // Search synonyms — query rewriting (stopwords + typo correction
      // + stemming) and synonym expansion on the storefront search box.
      // One shared instance; the primitive caches the operator-curated
      // groups / typos / stopwords in memory and only needs the
      // externalDb query handle.
      var searchSynonyms = (catalog && cart) ? bShop.searchSynonyms.create({}) : null;

      // Search facets — filterable search-result chrome. The primitive
      // reads its facet registry off the DB (default externalDb query
      // handle) and computes counts in-memory against a per-request
      // product universe, so it's wired as a factory the storefront's
      // /search route calls with that request's catalog snapshot. This
      // keeps concurrent searches from sharing one catalog binding.
      var searchFacets = (catalog && cart)
        ? function (perRequestCatalog) { return bShop.searchFacets.create({ catalog: perRequestCatalog }); }
        : null;

      // Search suggestions — the header autocomplete dropdown data + the
      // query log behind the admin "Popular searches" view. One shared
      // instance: product matches delegate to the catalog primitive's
      // products.search, popular/featured rows read this primitive's own
      // tables (default externalDb query handle). Backs the storefront
      // GET /search/suggestions JSON route + the admin curation screen.
      var searchSuggestions = (catalog && cart)
        ? bShop.searchSuggestions.create({ catalog: catalog })
        : null;

      // Stripe payment handle — shared by the admin refund + subscription
      // routes and the storefront subscription-cancel route, so there's
      // one Stripe client per boot. Wired only when both the API key and
      // webhook secret are present.
      var payment = (process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET)
        ? bShop.payment.create({
            apiKey:        process.env.STRIPE_API_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          })
        : null;

      // Stale-pending-order reaper — cancels pending orders older than the
      // TTL so their reserved stock holds release. A pending order whose
      // buyer abandoned the payment sheet (or whose PaymentIntent expired)
      // otherwise holds its stock forever: confirm places the holds + creates
      // the pending order, but the only hold-freeing FSM edges are
      // pending→paid and pending→cancelled, and nothing fires the cancel
      // automatically. The reaper composes the shared `order` + `payment`
      // handles only — it needs no quote/confirm machinery, so it stands up
      // a thin checkout instance over default (stateless) tax/shipping
      // adapters rather than the per-request config-wrapped ones.
      //
      // TTL is operator-tunable via CHECKOUT_PENDING_TTL_MINUTES (default
      // 120). Config-time validation: a present value MUST parse to an
      // integer >= 5, else throw at boot so a typo surfaces immediately
      // (entry-point tier).
      var STALE_ORDER_TTL_MINUTES = 120;
      if (process.env.CHECKOUT_PENDING_TTL_MINUTES != null && process.env.CHECKOUT_PENDING_TTL_MINUTES !== "") {
        var _ttlParsed = Number(process.env.CHECKOUT_PENDING_TTL_MINUTES);
        if (!Number.isInteger(_ttlParsed) || _ttlParsed < 5) {
          throw new Error("CHECKOUT_PENDING_TTL_MINUTES must be an integer >= 5 (minutes); got " +
            JSON.stringify(process.env.CHECKOUT_PENDING_TTL_MINUTES));
        }
        STALE_ORDER_TTL_MINUTES = _ttlParsed;
      }
      var staleOrderReaper = (catalog && cart && order)
        ? bShop.checkout.create({
            catalog: catalog, cart: cart, pricing: bShop.pricing,
            tax:      bShop.tax.create({ rules: [] }),
            // The reaper never quotes shipping; the adapter just satisfies
            // checkout.create's required-deps gate with a valid no-op table.
            shipping: bShop.shipping.create({ services: [{ id: "noop", label: "noop", zones: [{ country: "US", flat_amount_minor: 0 }] }] }),
            payment:  payment || { name: "no-stripe" },
            order:    order,
          })
        : null;

      // Internal cron endpoint — the Worker's scheduled() handler POSTs here
      // over the SHOP service binding once a minute. Same D1_BRIDGE_SECRET
      // timing-safe gate + never-5xx (drop-silent, JSON summary) shape as the
      // other ticks. One bounded reap pass per fire (batch-capped in the
      // primitive); a quiet table is a cheap read.
      r.post("/_/stale-order-reap", async function (req, res) {
        var gotR = req.headers && req.headers["x-d1-bridge-secret"];
        var wantR = process.env.D1_BRIDGE_SECRET || "";
        if (
          !wantR ||
          typeof gotR !== "string" ||
          gotR.length !== wantR.length ||
          !b.crypto.timingSafeEqual(gotR, wantR)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!staleOrderReaper) {
          res.json({ ok: true, enabled: false, reason: "checkout not composed (no catalog/cart/order)" });
          return;
        }
        try {
          var reapSummary = await staleOrderReaper.reapStalePending({ ttl_minutes: STALE_ORDER_TTL_MINUTES });
          res.json(Object.assign({ enabled: true }, reapSummary));
        } catch (e) {
          // Never 5xx — a thrown reap would mark the cron run failed.
          res.json({ ok: false, enabled: true, error: (e && e.message) || String(e) });
        }
      });

      // Subscriptions — the recurring-offer catalog (/admin/subscription-
      // plans) plus the customer self-management surface
      // (/account/subscriptions). One instance shared by both: plan CRUD
      // + reads need only the DB; binding/canceling subscriptions composes
      // Stripe, so the shared payment handle is passed when it's wired.
      var subscriptions = (catalog && cart)
        ? bShop.subscriptions.create({ payment: payment })
        : null;
      // Customer + operator subscription lifecycle (pause / resume / skip /
      // change-quantity / change-frequency / reactivate) layered on the
      // shared `subscriptions` instance via its `.subscriptions` handle.
      // Self-management routes mount on /account/subscriptions; a missing /
      // unmigrated control table only surfaces when a route runs (degrades
      // to a notice), never at boot.
      var subscriptionControls = subscriptions
        ? bShop.subscriptionControls.create({ subscriptions: subscriptions.subscriptions })
        : null;

      // Tax + shipping default tables — kick in when the operator
      // hasn't seeded `tax.rules` / `shipping.services` in config.
      // Zero-rate tax + a single $0 standard shipping service keeps
      // the storefront browsable on a fresh deploy.
      var DEFAULT_TAX_RULES = [];
      var DEFAULT_SHIPPING_SERVICES = [
        { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 0 }] },
      ];
      var DEFAULT_SHIPPING_ID = "std";

      // Commerce-config primitives surfaced through the admin console:
      // the per-jurisdiction tax rate table, operator-defined shipping
      // zones, automatic (no-code) cart discounts, and the coupon-
      // stacking policies that gate code combination. All four compose
      // the default externalDb query handle (no cursor secret) and back
      // their own migrated tables; a missing / unmigrated table only
      // surfaces when the console route reads it (degrades to an empty
      // list / notice), never at boot.
      var taxRates       = (catalog && cart) ? bShop.taxRates.create({})       : null;
      var shippingZones  = (catalog && cart) ? bShop.shippingZones.create({})  : null;
      var autoDiscount   = (catalog && cart) ? bShop.autoDiscount.create({})   : null;
      // Delivery-estimate — the PDP + cart "Get it by <date>" window from the
      // operator's carrier-transit / cutoff / holiday / postal-zone tables.
      // `shippingZones` is wired so a destination that misses the postal-prefix
      // table can still resolve a zone via the country/region zone router.
      // inventoryLocations is intentionally NOT passed: the shared catalog
      // location handle lacks the defaultLocation()/regionFor() resolvers the
      // primitive expects, so the origin must come from an explicit
      // origin_location — without a configured cutoff for that origin the
      // storefront simply renders no estimate (drop-silent). A missing /
      // unmigrated table only surfaces when a console route reads it (degrades
      // to an empty list / notice), never at boot.
      var deliveryEstimate = (catalog && cart)
        ? bShop.deliveryEstimate.create({ shippingZones: shippingZones })
        : null;
      var couponStacking = (catalog && cart) ? bShop.couponStacking.create({}) : null;
      // Per-line allocation of cart-level order discounts — back-office
      // bookkeeping that records how an order's discount split across its
      // lines, so a later partial refund knows each line's discounted
      // share. checkout writes a row post-commit (drop-silent) when an
      // order carried a discount; the admin console reads it back. A
      // missing / unmigrated table only surfaces when the console route
      // reads it (degrades to an empty list / notice), never at boot.
      var discountAllocation = (catalog && cart) ? bShop.discountAllocation.create({}) : null;

      // Sales tax filings — periodic remittance bookkeeping over completed
      // orders. Post-checkout reporting only: it reads orders that landed in
      // a filing window and re-derives the per-rate breakdown from the same
      // `taxRates` table the checkout reads, so the operator can reconcile
      // collected vs. owed tax and record the submission + payment to each
      // authority. Composes `taxRates` for the per-rate breakdown; a missing
      // sales_tax_filings table only surfaces when a console route reads it
      // (degrades to an empty list / notice), never at boot.
      var salesTaxFilings = (catalog && cart)
        ? bShop.salesTaxFilings.create({ taxRates: taxRates })
        : null;

      // Subject-access-request lifecycle (GDPR / CCPA / LGPD). Backs the
      // operator DSR queue (/admin/dsr) + the customer privacy surface
      // (/account/privacy, /account/delete). The primitive owns the request
      // row + walks the injected per-domain readers to assemble the export
      // bundle (or execute the erasure). The readers are the adapter shims
      // (`_dsrReader`, defined at module scope) over the existing customers /
      // addresses / order / subscriptions / support-tickets / loyalty
      // handles, so the per-domain modules stay unchanged. The same reader
      // map streams the download (the routes re-read the readers rather than
      // re-running fulfillRequest, which would flip status on every download).
      var complianceExportReaders = null;
      var complianceExport = null;
      if (catalog && cart && customers) {
        complianceExportReaders = {
          customers:      _dsrReader.customers(customers),
          addresses:      addresses ? _dsrReader.addresses(addresses) : null,
          order:          order ? _dsrReader.order(order) : null,
          orderNotes:     _dsrReader.orderNotes(),
          subscriptions:  subscriptions ? _dsrReader.subscriptions(subscriptions, b.externalDb.query) : null,
          // The vault stores only opaque processor tokens + display
          // metadata (brand/last4/expiry) — personal data that belongs in
          // a subject-access export, so the reader gets the live handle
          // whether or not Stripe is configured for NEW card adds.
          paymentMethods: _dsrReader.paymentMethods(paymentMethods),
          supportTickets: supportTickets ? _dsrReader.supportTickets(supportTickets) : null,
          loyalty:        loyalty ? _dsrReader.loyalty(loyalty) : null,
        };
        complianceExport = bShop.complianceExport.create({
          customers:      complianceExportReaders.customers,
          addresses:      complianceExportReaders.addresses,
          order:          complianceExportReaders.order,
          orderNotes:     complianceExportReaders.orderNotes,
          subscriptions:  complianceExportReaders.subscriptions,
          paymentMethods: complianceExportReaders.paymentMethods,
          supportTickets: complianceExportReaders.supportTickets,
          loyalty:        complianceExportReaders.loyalty,
        });
      }

      // Admin API — bearer-token-gated CRUD over catalog + orders +
      // refunds. Only mounts when ADMIN_API_KEY is present (operator
      // opts in by setting the secret). Stripe-backed refund routes
      // only mount when STRIPE_API_KEY is also present.
      if (catalog && cart && process.env.ADMIN_API_KEY) {
        // `order` is the shared FSM-driven record built at the top of the
        // routes function — reused here so an admin transition fans the same
        // webhooks / loyalty / referrals as a storefront-driven one.
        // `payment` is the shared Stripe handle built at the top of the
        // routes function (null when Stripe isn't configured) — the
        // admin refund + subscription-cancel routes gate on it.
        // config is already constructed at the top of the routes
        // function (line 87) when catalog && cart are present; the
        // admin block reuses that handle.
        // R2 upload bridge — the admin /admin/media/upload route uses
        // this to push fetched image bytes through the Worker into the
        // bound R2 bucket. Wired only when the operator has set the
        // bridge credentials (same auth as the D1 bridge).
        var r2_bridge = null;
        if (process.env.D1_BRIDGE_URL && process.env.D1_BRIDGE_SECRET) {
          r2_bridge = bShop.r2Bridge.create({
            bridgeUrl:    process.env.D1_BRIDGE_URL,
            bridgeSecret: process.env.D1_BRIDGE_SECRET,
            bridgePath:   process.env.R2_BRIDGE_PATH || "/_/r2/put",
          });
        }
        var catalogImport = bShop.catalogImport.create({ catalog: catalog });
        // `subscriptions` is the shared instance built at the top of the
        // routes function — reused here for /admin/subscription-plans +
        // the admin cancel route, and by the storefront below.
        bShop.admin.mount(r, {
          token:         process.env.ADMIN_API_KEY,
          shop_name:     bootShopName,
          catalog:       catalog,
          order:         order,
          // Abandoned-cart visibility console (/admin/carts) — reads live
          // carts directly (no scanner cron needed). Present whenever the
          // cart primitive is wired.
          cart:          cart,
          // Operator-readable error feed at /admin/errors (+ the
          // /admin/errors JSON API). Present whenever D1 is wired.
          errorLog:      errorLog,
          orderTracking: orderTracking,
          pickLists:      pickLists,
          shippingLabels: shippingLabels,
          splitShipments: splitShipments,
          salesReports:  salesReports,
          analytics:     analytics,
          orderExport:   orderExport,
          printReceipts: printReceipts,
          packingSlips:  packingSlips,
          payment:       payment,
          // Transactional mailer (lib/email.js) — enables the order
          // detail's "Resend confirmation" action. Null without SMTP
          // configured, in which case the panel renders a disabled note.
          mailer:        txEmail,
          config:        config,
          r2_bridge:     r2_bridge,
          catalogImport: catalogImport,
          reviews:       reviews,
          productQa:     productQa,
          returns:       returns,
          returnLabels:  returnLabels,
          supportTickets: supportTickets,
          // Subject-access-request queue (/admin/dsr) — the primitive plus
          // the reader map + scope-section table + the streaming helper, so
          // the export download streams the bundle without re-running
          // fulfillRequest (which would flip status on every download).
          complianceExport:        complianceExport,
          complianceExportReaders: complianceExportReaders,
          complianceExportSections: bShop.complianceExport.SCOPE_SECTIONS,
          streamDsrBundle:         _streamDsrBundle,
          orderExchanges: orderExchanges,
          orderRatings:  orderRatings,
          clickAndCollect: clickAndCollect,
          giftOptions:   giftOptions,
          searchRanking: searchRanking,
          searchSuggestions: searchSuggestions,
          trustBadges:   trustBadges,
          preorder:      preorder,
          customers:     customers,
          storeCredit:      storeCredit,
          customerNotes:    customerNotes,
          customerSegments: customerSegments,
          customerActivity: customerActivity,
          // Threaded customer-service notes panel on the order-detail screen.
          orderNotes:       orderNotes,
          subscriptions: subscriptions,
          giftcards:     giftcards,
          giftCardLedger: giftCardLedger,
          webhooks:      webhooks,
          // Low-stock alert history (/admin/inventory/alerts) — the same
          // instance the /_/low-stock-alert intake fires through.
          inventoryAlerts: inventoryAlerts,
          // Inventory-ops back-office — stock-location CRUD + per-location
          // levels (/admin/inventory/locations), audited receive
          // (/admin/inventory/receive), location→location transfers with a
          // dispatch/receive state machine (/admin/inventory/transfers),
          // and reason-coded write-offs (/admin/inventory/writeoffs). The
          // catalog handle lets the receive/write-off screens keep the
          // storefront aggregate in step with the per-location detail.
          inventoryLocations: inventoryLocations,
          inventoryReceive:   inventoryReceive,
          stockTransfers:     stockTransfers,
          inventoryWriteoffs: inventoryWriteoffs,
          // Consent-gated broadcast/campaign console (/admin/campaigns) —
          // the emailCampaigns instance plus the mailingAudiences handle
          // the new-campaign form reads to populate its audience picker.
          emailCampaigns:   emailCampaigns,
          mailingAudiences: mailingAudiences,
          collections:   collections,
          // Quotes console — the RFQ response queue + detail (respond /
          // withdraw). The notifier sends the quote-responded email when the
          // operator prices a quote (drop-silent without SMTP / a shop origin).
          quotes:          quotes,
          notifyQuoteResponded: notifyQuoteResponded,
          announcementBar: announcementBar,
          promoBanners:    promoBanners,
          customerSurveys: customerSurveys,
          blog:            blog,
          knowledgeBase:   knowledgeBase,
          storefrontPages: storefrontPages,
          businessHours:   businessHours,
          taxRates:        taxRates,
          shippingZones:   shippingZones,
          deliveryEstimate: deliveryEstimate,
          autoDiscount:    autoDiscount,
          couponStacking:  couponStacking,
          discountAllocation: discountAllocation,
          salesTaxFilings: salesTaxFilings,
          quantityDiscounts: quantityDiscounts,
          loyalty:           loyalty,
          loyaltyEarnRules:  loyaltyEarnRules,
          loyaltyRedemption: loyaltyRedemption,
          wishlistAlerts:    wishlistAlerts,
          wishlistDigest:    wishlistDigest,
          // Integration state map for /admin/integrations — "enabled" |
          // "action" (credentials present, a one-time operator action
          // still required) | "off". admin.js never reads process.env.
          // Stripe needs the publishable key too (the pay route hard-
          // fails without it). Wallets need Stripe AND a domain
          // registered with Stripe, which env can't attest — so they're
          // "action" (register your domain) once Stripe is ready, never
          // auto-"enabled".
          integrations: (function () {
            var stripeReady = !!(process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_PUBLISHABLE_KEY);
            var googleReady = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.SHOP_ORIGIN);
            var appleReady  = !!(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID &&
                                 process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY && process.env.SHOP_ORIGIN);
            // PayPal needs the credentials AND Stripe-backed checkout to be
            // live (checkout mounts under Stripe today), AND a webhook id +
            // the storefront button — so "action" once configured, not auto-on.
            var paypalReady = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET && stripeReady);
            return {
              stripe:           stripeReady ? "enabled" : "off",
              express_checkout: stripeReady ? "action"  : "off",
              google_signin:    googleReady ? "enabled" : "off",
              apple_signin:     appleReady  ? "enabled" : "off",
              paypal:           paypalReady ? "action"  : "off",
            };
          })(),
        });
      }

      // Storefront — HTML pages for end customers. Mounts the
      // home / product / cart routes when the data layer is wired.
      // Falls back to a JSON identity ping when there's no D1
      // (local dev without a Worker bridge).
      if (catalog && cart) {
        // Optional file-backed theme. When SHOP_THEME is set, every
        // storefront page renders through `<themes>/<name>/*.html`
        // with the bundled `default` theme as the fallback chain.
        // Operators upload theme assets (CSS, fonts, images) to R2
        // under `themes/<name>/...`; the Worker's `/assets/themes/<name>/*`
        // pass-through serves them.
        var sfTheme = null;
        if (process.env.SHOP_THEME) {
          sfTheme = bShop.theme.create({
            themesDir: process.env.SHOP_THEMES_DIR || "./themes",
            name:      process.env.SHOP_THEME,
            fallback:  process.env.SHOP_THEME_FALLBACK || "default",
          });
        }
        // Build the optional checkout + payment + order deps when
        // Stripe is configured. Without these the storefront stays
        // browsable but checkout-routes don't mount.
        var sfDeps = { catalog: catalog, cart: cart, config: { shop_name: bootShopName } };
        if (sfTheme) sfDeps.theme = sfTheme;
        // Customer accounts — opts the /account/* routes in. Reuses the
        // single `customers` instance built above (also wired into the
        // admin roster), so both surfaces share one handle.
        sfDeps.customers = customers;
        // CAPTCHA gate — wired from the boot-time resolution (captchaWiring,
        // resolved before createApp where await is allowed). Present only when
        // the operator has an active provider named in CAPTCHA_PROVIDER_SLUG;
        // absent it, signup / login / checkout behave EXACTLY as today (the
        // graceful no-op, mirroring the Stripe / PayPal / OAuth blocks).
        if (captchaWiring) {
          sfDeps.captchaGate         = captchaWiring.captchaGate;
          sfDeps.captchaProviderSlug = captchaWiring.captchaProviderSlug;
          sfDeps.captchaKind         = captchaWiring.captchaKind;
          sfDeps.captchaPublicKey    = captchaWiring.captchaPublicKey;
          sfDeps.captchaLoginEnabled = captchaWiring.captchaLoginEnabled;
          sfDeps.captchaVerify       = captchaWiring.captchaVerify;
        }
        // Sign in with Google (OIDC). Mounts the /account/login/google
        // routes only when the operator supplies the OAuth client +
        // SHOP_ORIGIN (for the exact redirect URI). The framework
        // adapter owns discovery + PKCE + ID-token verification.
        if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.SHOP_ORIGIN) {
          try {
            sfDeps.oauthGoogle = b.auth.oauth.create({
              provider:     "google",
              clientId:     process.env.GOOGLE_OAUTH_CLIENT_ID,
              clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
              redirectUri:  process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/account/auth/google/callback",
            });
          } catch (_e) { /* misconfigured — leave Google sign-in disabled */ }
        }
        // Sign in with Apple (OIDC). Apple's OAuth client secret is itself
        // an ES256 JWT signed with the team's .p8 key — minted here at
        // boot from APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_CLIENT_ID (the
        // Services ID) / APPLE_PRIVATE_KEY (.p8 PEM). The minted secret
        // lasts 150 days; a redeploy re-mints it well inside Apple's
        // 6-month ceiling. Apple posts the callback back (form_post), which
        // the storefront's POST /account/auth/apple/callback handles.
        if (process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID &&
            process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY && process.env.SHOP_ORIGIN) {
          try {
            sfDeps.oauthApple = b.auth.oauth.create({
              provider:     "apple",
              clientId:     process.env.APPLE_CLIENT_ID,
              clientSecret: bShop.customers.mintAppleClientSecret({
                team_id:     process.env.APPLE_TEAM_ID,
                key_id:      process.env.APPLE_KEY_ID,
                client_id:   process.env.APPLE_CLIENT_ID,
                // The .p8 is multi-line PEM; allow \n-escaped single-line
                // env values (common in CI secret stores) too.
                private_key: process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
              }),
              redirectUri:  process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/account/auth/apple/callback",
            });
          } catch (_e) { /* misconfigured .p8 / IDs — leave Apple sign-in disabled */ }
        }
        // Newsletter signups — opts the /newsletter route in. The
        // primitive only needs the externalDb query handle (which
        // ships with this deploy via D1_BRIDGE_URL).
        sfDeps.newsletter = bShop.newsletter.create({});

        // Operator-readable error log — the storefront's server-side
        // catches (checkout confirm 500, etc.) capture their scrubbed
        // message here so it's reachable from the admin console + JSON
        // API. Present whenever D1 is wired; absent it, the storefront
        // catches behave exactly as before (audit-emit only).
        if (errorLog) sfDeps.errorLog = errorLog;

        // i18n / locale routing — wired from the boot-time resolution
        // (`localeWiring`, built before createApp where `await` is
        // allowed). Present only when the operator has seeded an active
        // locale policy; absent that, the storefront renders the English
        // baseline with no switcher.
        if (localeWiring) {
          sfDeps.chromeI18n    = localeWiring.chromeI18n;
          sfDeps.localeRouter  = localeWiring.localeRouter;
          sfDeps.localeOptions = localeWiring.localeOptions;
        }
        // Reviews display + submit. The submit route gates on a verified
        // purchase, which needs order reads — wire an order handle here
        // regardless of Stripe (order reads don't touch the payment SDK).
        // The checkout block below reuses this same handle.
        if (reviews) sfDeps.reviews = reviews;
        if (productQa) sfDeps.productQa = productQa;
        if (wishlist) sfDeps.wishlist = wishlist;
        // Wishlist sharing — owner share links + the public shared view.
        if (wishlistSharing) sfDeps.wishlistSharing = wishlistSharing;
        // Wishlist alerts + digest opt-in toggles on /account/wishlist.
        // Present only on a mailer-configured deploy (the instances are
        // null otherwise); absent them the toggles simply don't render.
        if (wishlistAlerts) sfDeps.wishlistAlerts = wishlistAlerts;
        if (wishlistDigest) sfDeps.wishlistDigest = wishlistDigest;
        // Customer-portal magic-link sign-in — the /account/login/link +
        // /account/portal/:token routes mount only when BOTH the portal
        // primitive AND the shared transactional mailer are wired (no
        // mailer = no deliverable link, so the surface stays inert and
        // passkey / OAuth login are unchanged). The email handle + the
        // origin for the absolute link ride alongside.
        if (customerPortal && recoveryEmail) {
          sfDeps.customerPortal      = customerPortal;
          sfDeps.customerPortalEmail = recoveryEmail;
        }
        if (saveForLater) sfDeps.saveForLater = saveForLater;
        if (giftRegistry) sfDeps.giftRegistry = giftRegistry;
        if (addresses) sfDeps.addresses = addresses;
        if (cookieConsent) sfDeps.cookieConsent = cookieConsent;
        // Analytics event stream — threads the same read-only/recordEvent
        // handle the admin /admin/analytics screen uses so the storefront
        // can record browse→buy funnel events. Every recordEvent in the
        // storefront is gated on the visitor's `analytics` consent category
        // (default-deny, DNT/GPC honoured) and is container-served only
        // (anonymous PDP/search GETs are edge-cached and never record).
        if (analytics) sfDeps.analytics = analytics;
        if (returns) sfDeps.returns = returns;
        if (returnLabels) sfDeps.returnLabels = returnLabels;
        // Support tickets — the customer intake + thread (/account/support).
        if (supportTickets) sfDeps.supportTickets = supportTickets;
        // Privacy & data (/account/privacy, /account/delete) — the customer
        // self-service surface over the DSR primitive. Self-service FILES an
        // export or deletion request; the operator fulfils/executes it from
        // the admin queue. The reader map + scope-section table + streaming
        // helper back the ownership-scoped export download.
        if (complianceExport) {
          sfDeps.complianceExport         = complianceExport;
          sfDeps.complianceExportReaders  = complianceExportReaders;
          sfDeps.complianceExportSections = bShop.complianceExport.SCOPE_SECTIONS;
          sfDeps.streamDsrBundle          = _streamDsrBundle;
        }
        // Order exchanges — the customer request + status surface
        // (/account/orders/:id/exchange + /account/exchanges). Wired with
        // the shared order instance (sfDeps.order set below) for the
        // ownership scope; the admin queue actions the FSM.
        if (orderExchanges) sfDeps.orderExchanges = orderExchanges;
        // Order ratings — the post-purchase rating form + display on the
        // customer's own order page (/orders/:id). The SAME instance the
        // admin moderation queue acts on, so a flagged comment is suppressed
        // for the customer and an operator reply appears on their order page.
        if (orderRatings) sfDeps.orderRatings = orderRatings;
        // Click-and-collect — the customer-facing pickup status on /orders/:id
        // + /account/pickups list, and the checkout "pick up in store" option
        // (scheduled post-commit, drop-silent). Container-only.
        if (clickAndCollect) sfDeps.clickAndCollect = clickAndCollect;
        // Gift options — the cart/checkout gift UI (wrap select + message +
        // recipient + hide-prices) and the order/account gift display. The
        // wrap fee rides as a real cart line so it's charged through the quote.
        if (giftOptions) sfDeps.giftOptions = giftOptions;
        if (collections) sfDeps.collections = collections;
        if (categoryNavigation) sfDeps.categoryNavigation = categoryNavigation;
        if (recentlyViewed) sfDeps.recentlyViewed = recentlyViewed;
        if (productCompare) sfDeps.productCompare = productCompare;
        if (recommendations) sfDeps.recommendations = recommendations;
        // Announcement bar — sitewide promo/notice chrome. The storefront
        // resolves + renders the active bar per request (page-top) and
        // mounts the dismiss route; the admin console manages the rows.
        if (announcementBar) sfDeps.announcementBar = announcementBar;
        // Promo banners — sitewide + placement-specific marketing blocks. The
        // storefront resolves the active banner per placement per request and
        // splices it into the matching render (top_strip/footer through the
        // LAYOUT, the rest into home/product/cart/search).
        if (promoBanners) sfDeps.promoBanners = promoBanners;
        // Customer surveys — the token survey page + response submit.
        if (customerSurveys) sfDeps.customerSurveys = customerSurveys;
        // Quotes — the customer RFQ surface: request from cart, the tokened
        // /quote/:token review + accept/decline, and the account quote list.
        // `convertQuoteToOrder` lets an accepted quote land a pending order
        // (reserving stock) at acceptance; absent it (no saved address /
        // handles) the operator converts from the console.
        if (quotes) sfDeps.quotes = quotes;
        if (convertQuoteToOrder) sfDeps.convertQuoteToOrder = convertQuoteToOrder;
        // Knowledge base — the public /help reader (index + article + vote).
        if (knowledgeBase) sfDeps.knowledgeBase = knowledgeBase;
        // Storefront CMS pages — the sitemap reads published page slugs from
        // here (the /pages/:slug render is edge-served). Without this dep the
        // sitemap simply omits CMS pages.
        if (storefrontPages) sfDeps.storefrontPages = storefrontPages;
        // robots.txt crawl policy — drives /robots.txt when the operator has
        // defined per-bot rules (else the route keeps its hardcoded Disallow
        // set). pwaManifest — the operator override for /manifest.webmanifest
        // + /sw.js (else the route serves the shipped default).
        if (robotsConfig) sfDeps.robotsConfig = robotsConfig;
        if (pwaManifest) sfDeps.pwaManifest = pwaManifest;
        // Business hours — the public /hours page.
        if (businessHours) sfDeps.businessHours = businessHours;
        // Bundles + quantity discounts — the PDP "Bundle & save" rail +
        // atomic bundle add, and the quantity-break table + cart/checkout
        // repricing. Both price server-side from the live catalog.
        if (bundles) sfDeps.bundles = bundles;
        if (quantityDiscounts) sfDeps.quantityDiscounts = quantityDiscounts;
        // Auto-discount engine — backs the cart-page coupon entry. The
        // storefront renders the "Have a discount code?" block and mounts
        // POST /cart/coupon[/remove] only when this dep is wired; the cart
        // already exposes addDiscountCode/listDiscountCodes/removeDiscountCode,
        // and the checkout path (which holds the same instance) honours the
        // applied code at confirm. The admin console manages the rules; this
        // is the shopper-facing redemption surface.
        if (autoDiscount) sfDeps.autoDiscount = autoDiscount;
        // Search synonyms + facets — opt the /search route into query
        // expansion + filterable facet chrome. Synonyms is the shared
        // rewrite instance; facets is the per-request factory.
        if (searchSynonyms) sfDeps.searchSynonyms = searchSynonyms;
        if (searchFacets) sfDeps.searchFacets = searchFacets;
        // Search suggestions — opt the layout search box into the
        // autocomplete island (GET /search/suggestions JSON) and log each
        // /search query for the admin "Popular searches" view. Same shared
        // instance the admin curation screen manages.
        if (searchSuggestions) sfDeps.searchSuggestions = searchSuggestions;
        // Search ranking — the /search container handler reranks its candidate
        // universe through applyToResults using the active weight set + query
        // pins (never reranks the edge — container-only enhancement). Drop-
        // silent fallback to un-ranked order on any failure.
        if (searchRanking) sfDeps.searchRanking = searchRanking;
        // Back-in-stock alerts — the PDP "Notify me" subscribe/confirm/
        // unsubscribe routes. The shared transactional mailer is threaded as
        // sfDeps.email so the subscribe route can send the confirmation email
        // (drop-silent on a mailer hiccup). The cron sweep emails the fired
        // rows from the server-level handler, not here.
        if (stockAlerts) sfDeps.stockAlerts = stockAlerts;
        // Delivery estimate — the PDP + cart "Get it by <date>" line. The date
        // is destination-specific, so it renders CONTAINER-ONLY for a signed-in
        // customer with a saved shipping address (the edge serves a shared cache
        // across anonymous visitors and never bakes a per-visitor date). Absent
        // a configured origin cutoff for the resolved origin the route catches
        // the primitive's config-state throw and renders no estimate.
        if (deliveryEstimate) sfDeps.deliveryEstimate = deliveryEstimate;
        if (deliveryEstimate && deliveryEstimateOrigin) sfDeps.delivery_estimate_origin = deliveryEstimateOrigin;
        if (txEmail) sfDeps.email = txEmail;
        // Trust badges — rendered at the container-only checkout + order-
        // confirmation placements; drop-silent on any read failure.
        if (trustBadges) sfDeps.trustBadges = trustBadges;
        // Subscription self-management (/account/subscriptions) — the
        // shared instance. The list renders read-only without payment;
        // the cancel route mounts only when `sfDeps.payment` is wired
        // (set in the Stripe block below).
        if (subscriptions) sfDeps.subscriptions = subscriptions;
        if (subscriptionControls) sfDeps.subscriptionControls = subscriptionControls;
        // Pre-orders — the PDP reserve CTA + the /account/preorders surface.
        // The shared instance also backs the admin campaign console.
        if (preorder) sfDeps.preorder = preorder;
        // Gift cards — the customer balance-check page (/gift-cards) and
        // the redeem-at-checkout credit. Wired regardless of Stripe; the
        // balance page needs only the card primitive.
        if (giftcards) sfDeps.giftcards = giftcards;
        // Loyalty — the /account/loyalty page (balance + ledger + earn
        // rules + reward catalog), the redeem-a-reward action, and the
        // redeem-points-at-checkout credit. The earn-on-purchase award
        // is wired into the order primitive below (it fans the paid
        // transition into the earn rules), not into the storefront.
        if (loyalty) sfDeps.loyalty = loyalty;
        if (loyaltyEarnRules) sfDeps.loyaltyEarnRules = loyaltyEarnRules;
        if (loyaltyRedemption) sfDeps.loyaltyRedemption = loyaltyRedemption;
        // Store credit — the read-only /account/credit wallet (balance +
        // expiring-soon callout + the credit/debit/expire ledger). The
        // SAME instance the admin customer-detail screen grants/deducts
        // against, so a customer sees exactly the balance the operator set.
        // The customer surface writes nothing; granting/deducting stays
        // operator-only on the admin console.
        if (storeCredit) sfDeps.storeCredit = storeCredit;
        // Referrals — the /account/referrals page (the customer's code +
        // shareable link, the friends they've referred + status, and the
        // rewards funnel), the /r/<code> attribution landing, and the
        // in-account top-referrer leaderboard. The reward-on-first-order
        // credit is wired into the order primitive below (it fans the paid
        // transition into referrals.trackPurchase), not into the storefront.
        // SHOP_ORIGIN gives the absolute shareable link; absent it, the
        // route falls back to the request Host header.
        if (referrals) sfDeps.referrals = referrals;
        if (referralLeaderboard) sfDeps.referralLeaderboard = referralLeaderboard;
        if (process.env.SHOP_ORIGIN) sfDeps.shop_origin = process.env.SHOP_ORIGIN;
        // Reuse the shared order instance (also wired into the admin console)
        // so a transition fans webhooks / loyalty / referrals once, not twice.
        sfDeps.order = order;
        // Order-access token signing key — the storefront verifies the emailed
        // ?k=<token> guest-order access link against it. Same key the email
        // factory mints links with, so a link minted in a receipt validates at
        // the gate. (The placing-browser sealed cookie + signed-in owner paths
        // work without it; this only enables the cross-device emailed link.)
        sfDeps.order_access_secret = _orderAccessSecret;
        // Order tracking — the customer order page reads it for the shipment
        // status timeline + carrier tracking link. Optional: absent it (or
        // its table unmigrated), the order page renders without the panel.
        if (orderTracking) sfDeps.orderTracking = orderTracking;
        if (process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
          var sfOrder = sfDeps.order;
          // Reuse the shared Stripe handle (built at the top of the routes
          // function under the same gate) so the storefront checkout +
          // subscription-cancel routes and the admin routes drive one
          // Stripe client per boot.
          var sfPayment = payment;
          // Tax + shipping wrappers that re-read the operator's
          // config on each call. The wrapped adapter is rebuilt per
          // request from the latest `tax.rules` / `shipping.services`
          // rows, so an operator PUT against `/admin/config/:key`
          // takes effect on the next checkout (modulo the config
          // primitive's 30s read cache). When the operator hasn't
          // seeded a value, the documented zero-rate defaults apply.
          var sfTax = {
            name: "configured",
            calculate: async function (ctx) {
              var rules = await config.get("tax.rules", DEFAULT_TAX_RULES);
              var adapter = bShop.tax.create({ rules: rules });
              return await adapter.calculate(ctx);
            },
          };
          var sfShipping = {
            name: "configured",
            rates: async function (ctx) {
              // Operator-defined shipping zones take precedence over the
              // flat config-services table WHEN a zone covers the
              // destination AND a rate row matches the (weight, order
              // value, currency) tuple. Anything else — no zones
              // defined, destination outside every zone, no matching
              // rate row, or any lookup error — falls through to the
              // config-services adapter unchanged, so a store with no
              // zones configured keeps its existing shipping quote.
              if (shippingZones) {
                var zoneServices = await _zoneShippingRates(shippingZones, ctx);
                if (zoneServices && zoneServices.length) {
                  return { services: zoneServices };
                }
              }
              var services = await config.get("shipping.services", DEFAULT_SHIPPING_SERVICES);
              var adapter = bShop.shipping.create({ services: services });
              return await adapter.rates(ctx);
            },
          };
          // PayPal (Orders v2) adapter — wired when the operator supplies a
          // PayPal app's credentials. Distinct from Stripe; checkout exposes
          // create/capture/webhook PayPal methods only when this is present.
          // PAYPAL_ENV=live uses the production API; anything else is sandbox.
          var sfPaypal = null;
          if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
            try {
              sfPaypal = bShop.payment.create({
                adapter:   "paypal",
                clientId:  process.env.PAYPAL_CLIENT_ID,
                secret:    process.env.PAYPAL_SECRET,
                sandbox:   process.env.PAYPAL_ENV !== "live",
                webhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
              });
            } catch (_e) { sfPaypal = null; } // misconfigured — leave PayPal disabled
          }
          var sfCheckout = bShop.checkout.create({
            catalog: catalog, cart: cart, pricing: bShop.pricing,
            tax: sfTax, shipping: sfShipping, payment: sfPayment, order: sfOrder,
            customers: sfDeps.customers, paypal: sfPaypal,
            giftcards: giftcards, giftCardLedger: giftCardLedger,
            loyalty: loyalty, quantityDiscounts: quantityDiscounts,
            autoDiscount: autoDiscount,
            discountAllocation: discountAllocation,
            // Pre-order SKUs sell beyond the shelf by design — exempt their
            // lines from the confirm-time stock hold. (backorder is not
            // mounted on the buy path today; the checkout hook accepts it
            // when it is.)
            preorder: preorder,
          });
          sfDeps.payment           = sfPayment;
          sfDeps.paypal            = sfPaypal;
          sfDeps.paypal_client_id  = sfPaypal ? process.env.PAYPAL_CLIENT_ID : "";
          sfDeps.checkout          = sfCheckout;
          // Resolve the storefront's selected_shipping_id fallback
          // from config; the resolver re-reads per checkout POST so
          // operator changes don't need a container restart.
          sfDeps.default_shipping_id = async function () {
            return await config.get("shipping.default_id", DEFAULT_SHIPPING_ID);
          };
          sfDeps.stripe_publishable_key = process.env.STRIPE_PUBLISHABLE_KEY || "";
          // Saved payment methods — exposed only inside the Stripe-configured
          // block: the /account/payment-methods routes (list / set-default /
          // archive / add-via-SetupIntent) need the shared `payment` handle
          // for the SetupIntent + payment-method reads, and the add page needs
          // the publishable key. The list/set-default/archive surfaces need no
          // external JS; add-card uses the route-scoped CSP + the saved-card.js
          // island (mirroring the pay page).
          if (paymentMethods) sfDeps.paymentMethods = paymentMethods;
        }
        // Multi-currency display wiring. The operator's display-currency
        // allow-list lives in `shop.currencies` config (base first); the
        // base settlement currency in `shop.base_currency` (default USD).
        // Resolved per request from the config primitive (30s read cache),
        // so an operator config change takes effect without a restart. The
        // switcher + display conversion only render when the allow-list
        // names >1 currency. SHOP_BASE_CURRENCY / SHOP_CURRENCIES env vars
        // seed the defaults when the operator hasn't written config rows.
        if (currencyDisplay) {
          var envBase = (process.env.SHOP_BASE_CURRENCY || "USD").toUpperCase();
          var envList = (process.env.SHOP_CURRENCIES || envBase)
            .split(",").map(function (s) { return s.trim().toUpperCase(); })
            .filter(function (s) { return /^[A-Z]{3}$/.test(s); });
          if (!envList.length) envList = [envBase];
          sfDeps.currencyDisplay          = currencyDisplay;
          sfDeps.currencyRounding         = currencyRounding;
          sfDeps.currency_base            = envBase;
          sfDeps.currency_display_options = envList;
          // Override per request from config rows when present (falls back
          // to the env-seeded defaults on a read miss / failure).
          sfDeps.currency_config = async function () {
            try {
              var base = await config.get("shop.base_currency", envBase);
              var list = await config.get("shop.currencies", envList);
              return {
                base:    (base || envBase).toUpperCase(),
                options: (Array.isArray(list) && list.length ? list : envList)
                  .map(function (c) { return String(c).toUpperCase(); }),
              };
            } catch (_e) {
              return { base: envBase, options: envList };
            }
          };
        }
        bShop.storefront.mount(r, sfDeps);
      } else {
        r.get("/", function (_req, res) {
          res.json({
            name:    "blamejs-shop",
            version: require("./package.json").version,
            framework: {
              blamejs: require("./lib/vendor/MANIFEST.json").packages.blamejs.version,
            },
          });
        });
      }

      // Read-only public catalog API. Admin writes live behind
      // `lib/admin.js` (passkey + step-up) once that primitive
      // lands — until then writes are operator-only via direct
      // D1 access or the wrangler CLI.
      if (catalog) {
        // Audit namespace for the read-only catalog API. Registered once
        // so the 5xx error-recording path below files under a registered
        // namespace; safeEmit is drop-silent so a missing registration
        // would degrade gracefully, but registering keeps the audit chain
        // explicit.
        try { b.audit.registerNamespace("shop_catalog_api"); } catch (_e) { /* idempotent */ }

        r.get("/api/catalog/products", async function (req, res) {
          try {
            var url    = new URL(req.url, "http://localhost");
            var limitS = url.searchParams.get("limit");
            var cursor = url.searchParams.get("cursor");
            var status = url.searchParams.get("status") || "active";
            var limit  = limitS == null ? 20 : parseInt(limitS, 10);
            var page   = await catalog.products.list({ status: status, limit: limit, cursor: cursor });
            res.json(page);
          } catch (e) { _problemFromError(res, e, { errorLog: errorLog, route: "/api/catalog/products" }); }
        });

        r.get("/api/catalog/products/:slug", async function (req, res) {
          try {
            var product = await catalog.products.bySlug(req.params.slug);
            if (!product) {
              return b.problemDetails.send(res, {
                type:   "/problems/product-not-found",
                title:  "Product not found",
                status: 404,
                detail: "No product with slug " + JSON.stringify(req.params.slug),
              });
            }
            var variants = await catalog.variants.listForProduct(product.id);
            var media    = await catalog.media.listForProduct(product.id);
            res.json({ product: product, variants: variants, media: media });
          } catch (e) { _problemFromError(res, e, { errorLog: errorLog, route: "/api/catalog/products/:slug" }); }
        });
      }
    },
  });

  // 0.0.0.0 so Cloudflare's container fabric can reach Node on
  // 10.0.0.1:PORT. Defaulting host omits inter-fabric reachability.
  var bound = await app.listen({ port: PORT, host: "0.0.0.0" });
  process.stderr.write("[server] listening on :" + bound.port + "\n");

  // Graceful shutdown — Cloudflare Containers sends SIGTERM with a
  // 10s grace period. Drain via b.appShutdown so in-flight requests
  // finish and any wired primitives (db, vault) flush before exit.
  var draining = false;
  function _drain(signal) {
    if (draining) return;
    draining = true;
    process.stderr.write("[server] " + signal + " received — draining\n");
    if (b.appShutdown && typeof b.appShutdown.drain === "function") {
      b.appShutdown.drain().then(function () { process.exit(0); }, function () { process.exit(1); });
    } else {
      bound.server.close(function () { process.exit(0); });
    }
  }
  process.on("SIGTERM", function () { _drain("SIGTERM"); });
  process.on("SIGINT",  function () { _drain("SIGINT");  });
}

// Boot only when run as the entry point (`node server.js`). Requiring
// this file (the shipping-zone rate mapper is exercised in tests) must
// not start the listener.
if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write("[server] failed to start: " + (err && err.message || err) + "\n");
    if (err && err.stack) process.stderr.write(err.stack + "\n");
    process.exit(1);
  });
}

module.exports = { _zoneShippingRates: _zoneShippingRates, _problemFromError: _problemFromError };
