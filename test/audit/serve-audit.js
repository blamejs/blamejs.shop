"use strict";
/**
 * Local UI/UX audit harness — boots the FULL blamejs.shop app (storefront +
 * admin console + authenticated customer account) over an in-memory
 * node:sqlite backend with the production middleware stack, then seeds broadly
 * so every admin screen and account page has real data to render. The point is
 * to exercise screens that are otherwise gated behind production secrets
 * (Stripe / D1 bridge / OAuth) on a local machine a human + Playwright can drive.
 *
 *   node test/audit/serve-audit.js          # boots on AUDIT_PORT (default 8123)
 *
 * This is a DEV/TEST harness, NOT production code. It composes lib/ + the
 * vendored framework exactly as server.js does, but stands the dependency
 * graph up over a local SQLite handle with a FIXED admin key and a plaintext
 * vault so an operator can sign in and forge a customer session.
 *
 * On `listening` it prints, on stdout, exactly one machine-readable line:
 *
 *   AUDIT_READY <port> admin_key=<key> product=<slug> order=<id>
 *
 * followed by an authenticated-customer forged-cookie line (name=value) and a
 * short operator how-to. Paste the admin key as the Bearer token (or POST it
 * to /admin/login), and set the printed shop_auth cookie in the browser to
 * browse /account/*.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

// A fixed, known admin key — set BEFORE createApp / admin.mount so the admin
// login + every bearer-gated /admin route accepts it. admin.mount reads
// deps.token (which we source from this env var) and requires it be >= 16
// chars; this value is 21 chars.
if (!process.env.ADMIN_API_KEY) process.env.ADMIN_API_KEY = "audit-admin-key-0001";

// The harness runs on loopback http with no TLS-terminating proxy in front,
// but the production security middleware keeps trustProxy on and reconstructs
// the expected CSRF origin as https. With no proxy the browser sends an http
// loopback Origin, which would be refused as cross-origin. Allowlist the
// loopback origin (127.0.0.1 + localhost, on this port) so browser-driven
// POSTs — admin login, admin mutations, account changes — pass the origin
// check. Set BEFORE lib is required: the middleware's PUBLIC_ORIGINS is a
// module-top constant read at require time.
var _AUDIT_PORT = parseInt(process.env.AUDIT_PORT || "8123", 10);
if (!process.env.SHOP_PUBLIC_ORIGINS) {
  process.env.SHOP_PUBLIC_ORIGINS =
    "http://127.0.0.1:" + _AUDIT_PORT + ",http://localhost:" + _AUDIT_PORT;
}

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop = require("../../lib");
var b     = bShop.framework;

var PORT       = _AUDIT_PORT;
var ADMIN_KEY  = process.env.ADMIN_API_KEY;
var MIG_DIR    = nodePath.resolve(__dirname, "..", "..", "migrations-d1");

// ---- in-memory SQLite query fn -----------------------------------------
//
// Cloned from test/e2e/serve.js _makeQuery, but loads EVERY migration in
// migrations-d1/ (numeric order) rather than the four storefront-core ones —
// the full admin console + checkout engines each back their own table. Each
// migration file is applied statement-by-statement inside a try/catch: a
// node:sqlite parse failure on a single D1-flavoured statement (or a table a
// later engine doesn't need) is logged to stderr and skipped, so one bad table
// can never wedge the boot. The verb-dispatch return shape matches the D1
// bridge adapter the engines expect.

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n")
    .split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function _allMigrations() {
  return nodeFs.readdirSync(MIG_DIR)
    .filter(function (n) { return /^\d+.*\.sql$/.test(n); })
    .sort()
    .map(function (n) { return nodePath.join(MIG_DIR, n); });
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  var migs = _allMigrations();
  var loaded = 0, skippedFiles = 0, skippedStmts = 0;
  migs.forEach(function (p) {
    var text;
    try { text = nodeFs.readFileSync(p, "utf8"); }
    catch (e) { skippedFiles += 1; process.stderr.write("[audit] migration read failed " + nodePath.basename(p) + ": " + (e && e.message) + "\n"); return; }
    var fileHadError = false;
    _splitSchema(text).forEach(function (s) {
      try { db.prepare(s).run(); }
      catch (e) {
        skippedStmts += 1;
        if (!fileHadError) {
          fileHadError = true;
          process.stderr.write("[audit] migration stmt skipped in " + nodePath.basename(p) + ": " + (e && e.message) + "\n");
        }
      }
    });
    loaded += 1;
  });
  process.stderr.write("[audit] migrations: " + loaded + " files applied, " +
    skippedStmts + " statements skipped, " + skippedFiles + " files unreadable\n");

  var query = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  query._db = db;   // exposed for the direct-SQL order seed (the tax-filings pattern)
  return query;
}

// ---- broad seed --------------------------------------------------------
//
// Each step is wrapped so a single engine's schema gap degrades to a logged
// warning rather than killing the boot — the harness must come up even if one
// table didn't migrate cleanly. Returns a record of what landed so the
// AUDIT_READY line can name a real product slug + order id.

async function _seed(engines) {
  var seeded = [];
  var refs = { product_slug: null, order_id: null, customer_id: null };

  function _note(label) { seeded.push(label); }
  async function _try(label, fn) {
    try { await fn(); }
    catch (e) { process.stderr.write("[audit] seed step '" + label + "' skipped: " + (e && e.message) + "\n"); }
  }

  var catalog = engines.catalog;
  var cart    = engines.cart;

  // --- products + variants + prices + inventory + media ----------------
  // Three sellable products so the catalog grid + every product-scoped admin
  // screen has something to show. Slugs are stable so Playwright can deep-link.
  var products = [
    { slug: "audit-widget",  title: "Audit Widget",  sku: "AUD-WID-1", price: 2500, weight: 250, stock: 120 },
    { slug: "audit-gadget",  title: "Audit Gadget",  sku: "AUD-GAD-1", price: 5000, weight: 400, stock: 80  },
    { slug: "audit-gizmo",   title: "Audit Gizmo",   sku: "AUD-GIZ-1", price: 1500, weight: 120, stock: 200 },
  ];
  var seededProducts = [];
  for (var pi = 0; pi < products.length; pi += 1) {
    var spec = products[pi];
    await _try("product " + spec.slug, async function () {
      var p = await catalog.products.create({ slug: spec.slug, title: spec.title, description: spec.title + " — seeded for the UI/UX audit.", status: "active" });
      var v = await catalog.variants.create(p.id, { sku: spec.sku, title: "Default", weight_grams: spec.weight, requires_shipping: true, options: { size: "M" } });
      await catalog.prices.set(v.id, { currency: "USD", amount_minor: spec.price });
      await catalog.inventory.create(spec.sku, { stock_on_hand: spec.stock });
      try { await catalog.media.attach({ product_id: p.id, r2_key: "products/" + spec.slug + ".svg", content_type: "image/svg+xml", width: 800, height: 800, alt_text: spec.title, position: 0 }); }
      catch (_e) { /* media table optional */ }
      seededProducts.push({ product: p, variant: v, spec: spec });
      if (!refs.product_slug) refs.product_slug = spec.slug;
    });
  }
  _note(seededProducts.length + " products (with variant/price/inventory/media)");

  var primary = seededProducts[0];
  var secondary = seededProducts[1];

  // --- quantity-break tier set -----------------------------------------
  if (engines.quantityDiscounts && primary) {
    await _try("quantity discount tier set", async function () {
      await engines.quantityDiscounts.defineTier({
        scope: "sku", scope_id: primary.spec.sku, exclusive: false,
        tiers: [
          { min_quantity: 5,  discount_kind: "percent_off",     value: 1000 },  // 10% off at 5+
          { min_quantity: 10, discount_kind: "amount_off_each",  value: 150  },  // $1.50 off each at 10+
        ],
      });
      _note("quantity-break tier set (5+/10+) on " + primary.spec.sku);
    });
  }

  // --- shipping zone with a rate ---------------------------------------
  if (engines.shippingZones) {
    await _try("shipping zone", async function () {
      await engines.shippingZones.defineZone({
        slug: "domestic-us", title: "Domestic US",
        regions: [{ country: "US" }],
        rates: [
          { rate_minor: 695,  currency: "USD", service_label: "Standard" },
          { rate_minor: 1295, currency: "USD", service_label: "Express" },
        ],
        active: true,
      });
      _note("shipping zone 'domestic-us' with 2 rates");
    });
  }

  // --- tax rate ---------------------------------------------------------
  if (engines.taxRates) {
    await _try("tax rate", async function () {
      await engines.taxRates.defineRate({ jurisdiction: "US-CA", rate_bps: 725, source: "manual", effective_from: Date.UTC(2025, 0, 1) });
      _note("tax rate US-CA 7.25%");
    });
  }

  // --- auto-discount rule ----------------------------------------------
  if (engines.autoDiscount) {
    await _try("auto-discount rule", async function () {
      await engines.autoDiscount.defineRule({
        slug: "five-off-forty", title: "Five off orders over forty",
        trigger: { kind: "cart_total_min", min_minor: 4000 },
        value:   { kind: "amount_off_total", minor: 500 },
      });
      _note("auto-discount 'five-off-forty' ($5 off carts over $40)");
    });
  }

  // --- coupon-stacking policy ------------------------------------------
  if (engines.couponStacking) {
    await _try("coupon-stacking policy", async function () {
      await engines.couponStacking.definePolicy({
        slug: "one-code-per-order", title: "One code per order",
        max_codes_per_order: 1,
      });
      _note("coupon-stacking policy 'one-code-per-order'");
    });
  }

  // --- a confirmed order carrying an auto-discount, via the checkout API -
  // Confirming through engines.checkout exercises the real auto-discount +
  // discount-allocation post-commit recording, so a /admin/discount-allocation
  // row exists. The payment is the local stub the checkout was built with.
  if (engines.checkout && primary && secondary) {
    await _try("confirmed discounted order (via checkout)", async function () {
      var sid = b.uuid.v7();
      var c = await cart.create(sid, { currency: "USD" });
      await cart.addLine(c.id, { variant_id: primary.variant.id, qty: 2 });
      await cart.addLine(c.id, { variant_id: secondary.variant.id, qty: 1 });
      var shipTo = { line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103" };
      var confirmed = await engines.checkout.confirm({
        cart_id: c.id, ship_to: shipTo, selected_shipping_id: "std",
        customer: { email: "auditbuyer@example.com", name: "Audit Buyer" },
        idempotency_key: "audit-confirm-key-0001",
      });
      if (confirmed && confirmed.order && confirmed.order.id) {
        refs.order_id = confirmed.order.id;
        _note("confirmed order " + confirmed.order.id + " (carried the auto-discount)");
      }
    });
  }

  // A direct-SQL fallback order so /admin/orders + the tax-filing window are
  // never empty even if the checkout confirm above declined (e.g. no Stripe
  // stub path). Mirrors the tax-filings test's _seedOrder direct insert.
  await _try("direct-SQL completed orders (filing window)", async function () {
    var db = engines.query._db;
    if (!db) return;
    function _seedOrderRow(o) {
      db.prepare(
        "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'converted', ?5, ?5, ?5)"
      ).run(o.cart_id, o.session_id, o.customer_id == null ? null : o.customer_id, o.currency, o.created_at);
      db.prepare(
        "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
        "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
        "ship_to_json, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 0, ?9, ?10, ?11, ?11)"
      ).run(o.id, o.cart_id, o.customer_id == null ? null : o.customer_id, o.session_id, o.status,
        o.currency, o.subtotal_minor, o.tax_minor, o.subtotal_minor + o.tax_minor,
        JSON.stringify(o.ship_to), o.created_at);
    }
    var WIN = Date.UTC(2026, 1, 10);
    _seedOrderRow({ id: "audit-ord-1", cart_id: "audit-c1", customer_id: null, session_id: "audit-s1",
      status: "paid", currency: "USD", subtotal_minor: 10000, tax_minor: 725, created_at: WIN, ship_to: { country: "US", region: "CA" } });
    _seedOrderRow({ id: "audit-ord-2", cart_id: "audit-c2", customer_id: null, session_id: "audit-s2",
      status: "delivered", currency: "USD", subtotal_minor: 20000, tax_minor: 1450, created_at: WIN, ship_to: { country: "US", region: "CA" } });
    if (!refs.order_id) refs.order_id = "audit-ord-1";
    _note("2 completed in-window orders (US-CA) for tax filing");
  });

  // --- a sales-tax filing over the in-window orders ---------------------
  if (engines.salesTaxFilings) {
    await _try("sales-tax filing", async function () {
      var filing = await engines.salesTaxFilings.defineFilingPeriod({
        jurisdiction: "US-CA", kind: "quarterly",
        period_start: Date.UTC(2026, 0, 1), period_end: Date.UTC(2026, 3, 1), due_date: Date.UTC(2026, 3, 20),
      });
      if (filing && filing.id) {
        try { await engines.salesTaxFilings.computeFiling(filing.id); } catch (_e) { /* compute optional */ }
      }
      _note("sales-tax filing (US-CA quarterly, computed over the in-window orders)");
    });
  }

  // --- shipping labels on an order/shipment ----------------------------
  if (engines.shippingLabels && engines.orderTracking && refs.order_id) {
    await _try("shipping labels", async function () {
      var shipment = await engines.orderTracking.createShipment({ order_id: refs.order_id, carrier: "ups", tracking_number: "1Z999AA10123456784" });
      var pending = await engines.shippingLabels.requestLabel({
        shipment_id: shipment.id, carrier: "ups", service_level: "Ground",
        weight_grams: 500, length_mm: 200, width_mm: 150, height_mm: 100, package_type: "parcel",
      });
      await engines.shippingLabels.markPurchased({
        label_id: pending.id, tracking_number: "1Z999AA10123456784",
        label_url: "https://labels.example.com/a.pdf", cost_minor: 650, currency: "USD", purchased_via: "easypost",
      });
      // A second pending label so the mint queue isn't empty.
      await engines.shippingLabels.requestLabel({
        shipment_id: shipment.id, carrier: "fedex", service_level: "Express",
        weight_grams: 300, length_mm: 180, width_mm: 120, height_mm: 90, package_type: "envelope",
      });
      _note("shipment + 1 purchased label + 1 pending label on " + refs.order_id);
    });
  }

  // --- a collection ----------------------------------------------------
  if (engines.collections && primary) {
    await _try("collection", async function () {
      var coll = await engines.collections.defineManual({ slug: "featured", title: "Featured" });
      try { await engines.collections.addProduct(coll.slug || "featured", primary.product.id); } catch (_e) { /* member API variant */ }
      _note("collection 'featured' (with a member)");
    });
  }

  // --- a gift card -----------------------------------------------------
  if (engines.giftcards) {
    await _try("gift card", async function () {
      await engines.giftcards.issue({ amount_minor: 5000, currency: "USD" });
      _note("gift card ($50 USD)");
    });
  }

  // --- a customer + passkey (for the authenticated account flow) -------
  if (engines.customers) {
    await _try("customer + passkey", async function () {
      var cust = await engines.customers.register({ email: "auditcustomer@example.com", display_name: "Audit Customer" });
      refs.customer_id = cust.id;
      try { await engines.customers.addPasskey(cust.id, { credential_id: "audit-cred-1", public_key: "k1", transports: "internal" }); } catch (_e) { /* passkey table optional */ }
      try { await engines.customers.addPasskey(cust.id, { credential_id: "audit-cred-2", public_key: "k2", transports: "usb" }); } catch (_e) { /* */ }
      _note("customer auditcustomer@example.com (+2 passkeys)");
    });
    // Per-customer satellites so the /admin/customers/:id detail screen
    // renders with real store-credit, a CRM note, and a loyalty balance.
    if (engines.storeCredit && refs.customer_id) {
      await _try("customer store credit", async function () {
        await engines.storeCredit.credit({
          customer_id: refs.customer_id, amount_minor: 2500,
          source: "goodwill", source_ref: "welcome credit",
        });
        _note("$25.00 store credit for the customer");
      });
    }
    if (engines.customerNotes && refs.customer_id) {
      await _try("customer note", async function () {
        await engines.customerNotes.addNote({
          customer_id: refs.customer_id, author: "operator",
          body: "VIP — comp shipping where possible.", kind: "preference",
        });
        _note("1 CRM note for the customer");
      });
    }
    // A saved address for /account/addresses.
    if (engines.addresses && refs.customer_id) {
      await _try("customer saved address", async function () {
        await engines.addresses.add({
          customer_id: refs.customer_id, label: "Home", recipient_name: "Audit Customer",
          street_line1: "1 Main St", city: "San Francisco", region: "CA",
          postal_code: "94103", country: "US", phone: "+14155550100",
          is_default_shipping: true, is_default_billing: true,
        });
        _note("1 saved address for the customer");
      });
    }
  }

  return { seeded: seeded, refs: refs };
}

// ---- boot --------------------------------------------------------------

async function main() {
  var query = _makeQuery();

  // The full engine graph server.js wires that has an admin screen or a
  // checkout role, each built over the one shared in-memory query handle so a
  // write from one surface is visible to every other.
  var catalog            = bShop.catalog.create({ query: query });
  var cart               = bShop.cart.create({ query: query, catalog: catalog });
  var order              = bShop.order.create({ query: query, cursorSecret: "audit-order" });
  var config             = bShop.config.create({ query: query });
  var orderTracking      = bShop.orderTracking.create({ query: query, order: order });
  var shippingLabels     = bShop.shippingLabels.create({ query: query });
  var customers          = bShop.customers.create({ query: query });
  var storeCredit        = bShop.storeCredit.create({ query: query });
  var customerNotes      = bShop.customerNotes.create({ query: query, cursorSecret: "audit-customer-notes" });
  var customerSegments   = bShop.customerSegments.create({ query: query, cursorSecret: "audit-customer-segments" });
  var reviews            = bShop.reviews.create({ query: query, cursorSecret: "audit-reviews" });
  var returns            = bShop.returns.create({ query: query, cursorSecret: "audit-returns" });
  var giftcards          = bShop.giftcards.create({ query: query });
  var giftCardLedger     = bShop.giftCardLedger.create({ query: query });
  var webhooks           = bShop.webhooks.create({ query: query });
  var collections        = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "audit-collections" });
  var blog               = bShop.blogArticles.create({ query: query, cursorSecret: "audit-blog" });
  var storefrontPages    = bShop.storefrontPages.create({ query: query });
  var quantityDiscounts  = bShop.quantityDiscounts.create({ query: query, catalog: catalog });
  var loyalty            = bShop.loyalty.create({ query: query });
  var loyaltyEarnRules   = bShop.loyaltyEarnRules.create({ query: query, loyalty: loyalty });
  var loyaltyRedemption  = bShop.loyaltyRedemption.create({ query: query, loyalty: loyalty });
  var taxRates           = bShop.taxRates.create({ query: query });
  var shippingZones      = bShop.shippingZones.create({ query: query });
  var autoDiscount       = bShop.autoDiscount.create({ query: query });
  var couponStacking     = bShop.couponStacking.create({ query: query });
  var discountAllocation = bShop.discountAllocation.create({ query: query });
  var salesTaxFilings    = bShop.salesTaxFilings.create({ query: query, taxRates: taxRates });
  var addresses          = bShop.addresses.create({ query: query });

  // Tax + shipping checkout adapters. Tax: the configured US-CA rate via the
  // tax engine's rules; shipping: zone rates first, flat $6.95 fallback —
  // mirrors server.js's configured wrappers but without the per-request config
  // re-read (the audit harness keeps it simple).
  var tax = {
    name: "configured",
    calculate: async function (ctx) {
      var adapter = bShop.tax.create({ rules: [{ country: "US", rate_bps: 725 }] });
      return await adapter.calculate(ctx);
    },
  };
  var FALLBACK_SERVICES = [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] }];
  var shipping = {
    name: "configured",
    rates: async function (ctx) {
      var adapter = bShop.shipping.create({ services: FALLBACK_SERVICES });
      return await adapter.rates(ctx);
    },
  };

  // A local payment stub so checkout.confirm works WITHOUT a real Stripe key —
  // this is the whole reason the harness exists (production gates checkout on
  // STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET).
  var payment = {
    name: "audit-stub-stripe",
    createPaymentIntent: async function (input) {
      return { id: "pi_audit_" + b.uuid.v7(), client_secret: "pi_audit_secret", status: "requires_payment_method", _amount: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "audit-stub" }; },
  };

  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
    customers: customers, giftcards: giftcards, giftCardLedger: giftCardLedger,
    quantityDiscounts: quantityDiscounts, autoDiscount: autoDiscount,
    discountAllocation: discountAllocation,
  });

  // Seed before listen — so the AUDIT_READY line names real entities.
  var seedResult = await _seed({
    query: query, catalog: catalog, cart: cart, order: order, checkout: checkout,
    quantityDiscounts: quantityDiscounts, shippingZones: shippingZones, taxRates: taxRates,
    autoDiscount: autoDiscount, couponStacking: couponStacking, salesTaxFilings: salesTaxFilings,
    shippingLabels: shippingLabels, orderTracking: orderTracking, collections: collections,
    giftcards: giftcards, customers: customers, addresses: addresses,
    storeCredit: storeCredit, customerNotes: customerNotes,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-audit-"));

  // ---- static theme + media assets ---------------------------------------
  // In production the edge Worker serves /assets/* from R2; this container-only
  // harness has no asset server, so without this the admin/storefront CSS,
  // fonts, and JS 404 (served as the HTML 404 page → MIME-refused) and every
  // page renders UNSTYLED. Map the fingerprinted /assets URL back onto the
  // theme source tree (URL /assets/themes/default/css/admin.<hash>.css → disk
  // themes/default/assets/css/admin.css), stripping the content-hash. The
  // bytes are the exact source the asset manifest hashed, so Subresource
  // Integrity still verifies. Mounted before the route guards — public static
  // GETs aren't csrf-/bot-guarded (the Worker serves them outside the
  // container in prod too). The router has no splat, so this is a r.use()
  // middleware that self-filters on the /assets/ prefix.
  var REPO_ROOT       = nodePath.resolve(__dirname, "..", "..");
  var THEME_ASSET_DIR = nodePath.join(REPO_ROOT, "themes", "default", "assets");
  var PRODUCT_IMG_DIR = nodePath.join(REPO_ROOT, "scripts", "sample-product-images");
  var ASSET_MIME = {
    ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
  };
  function _deFingerprint(name) {
    // css/admin.72c808274ebcefd9.css → css/admin.css ; un-hashed names pass through.
    return name.replace(/\.[0-9a-f]{8,}(\.[a-z0-9]+)$/i, "$1");
  }
  function _auditStaticAssets(req, res, next) {
    if (req.method !== "GET") return next();
    var p = req.pathname || "";
    if (p.indexOf("/assets/") !== 0) return next();
    var rel = p.slice("/assets/".length);
    if (rel.indexOf("..") !== -1 || rel.indexOf("\0") !== -1) { res.writeHead(400); return res.end("bad path"); }
    var abs = null;
    if (rel.indexOf("themes/default/") === 0) {
      abs = nodePath.join(THEME_ASSET_DIR, _deFingerprint(rel.slice("themes/default/".length)));
    } else if (rel.indexOf("products/") === 0) {
      abs = nodePath.join(PRODUCT_IMG_DIR, _deFingerprint(rel.slice("products/".length)));
    } else if (rel.indexOf("brand/") === 0) {
      abs = nodePath.join(THEME_ASSET_DIR, "brand", _deFingerprint(rel.slice("brand/".length)));
    }
    if (!abs) return next();
    abs = nodePath.resolve(abs);
    if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + nodePath.sep)) return next();
    if (!nodeFs.existsSync(abs) || nodeFs.statSync(abs).isDirectory()) return next();
    var ext = nodePath.extname(abs).toLowerCase();
    res.writeHead(200, {
      "content-type":  ASSET_MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    nodeFs.createReadStream(abs).pipe(res);
  }

  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Same composition discipline as test/e2e/serve.js: the shop mounts its
    // OWN body parser + route guards inside routes(), so disable createApp's
    // app-level duplicates. The GLOBAL per-client-IP rate limit stays on (it
    // never blocks loopback browsing at audit volumes); CSRF is mounted scoped
    // via mountRouteGuards.
    middleware: {
      securityHeaders: bShop.securityMiddleware.securityHeadersOpts(),
      rateLimit:       bShop.securityMiddleware.globalRateLimitOpts(),
      csrf:            false,
      bodyParser:      false,
      fetchMetadata:   false,
      cspNonce:        false,
    },
    routes: function (r) {
      // Public static assets first — before bodyParser/guards (mirrors prod,
      // where the edge Worker serves /assets/* outside the container).
      r.use(_auditStaticAssets);
      r.use(b.middleware.bodyParser({
        text: { limit: b.constants.BYTES.mib(2), contentTypes: ["text/plain", "text/csv"] },
      }));
      bShop.securityMiddleware.mountRouteGuards(r);

      r.get("/_/health", function (_req, res) { res.json({ ok: true, audit: true }); });

      // Admin console — bearer-token-gated, FIXED key (set at the top of this
      // file before createApp). Every engine with an admin screen is wired.
      bShop.admin.mount(r, {
        token:              ADMIN_KEY,
        shop_name:          "Audit Shop",
        catalog:            catalog,
        order:              order,
        orderTracking:      orderTracking,
        shippingLabels:     shippingLabels,
        salesReports:       bShop.salesReports.create({ query: query, cursorSecret: "audit-sales-reports" }),
        printReceipts:      bShop.printReceipts.create({ query: query, order: order }),
        packingSlips:       bShop.packingSlips.create({ query: query, order: order }),
        config:             config,
        reviews:            reviews,
        returns:            returns,
        customers:          customers,
        storeCredit:        storeCredit,
        customerNotes:      customerNotes,
        customerSegments:   customerSegments,
        giftcards:          giftcards,
        giftCardLedger:     giftCardLedger,
        webhooks:           webhooks,
        collections:        collections,
        blog:               blog,
        storefrontPages:    storefrontPages,
        taxRates:           taxRates,
        shippingZones:      shippingZones,
        autoDiscount:       autoDiscount,
        couponStacking:     couponStacking,
        discountAllocation: discountAllocation,
        salesTaxFilings:    salesTaxFilings,
        quantityDiscounts:  quantityDiscounts,
        loyalty:            loyalty,
        loyaltyEarnRules:   loyaltyEarnRules,
        loyaltyRedemption:  loyaltyRedemption,
        integrations: {
          stripe: "off", express_checkout: "off", google_signin: "off", apple_signin: "off", paypal: "off",
        },
      });

      // Storefront — the full customer surface, including the authenticated
      // /account/* routes (customers dep) and a working checkout (the local
      // payment stub above means checkout mounts even with no Stripe key).
      var sfDeps = {
        catalog:            catalog,
        cart:               cart,
        order:              order,
        config:             { shop_name: "Audit Shop" },
        customers:          customers,
        addresses:          addresses,
        orderTracking:      orderTracking,
        reviews:            reviews,
        returns:            returns,
        collections:        collections,
        giftcards:          giftcards,
        quantityDiscounts:  quantityDiscounts,
        loyalty:            loyalty,
        loyaltyEarnRules:   loyaltyEarnRules,
        loyaltyRedemption:  loyaltyRedemption,
        checkout:           checkout,
        payment:            payment,
        default_shipping_id: async function () { return "std"; },
        stripe_publishable_key: "",
      };
      bShop.storefront.mount(r, sfDeps);
    },
  });

  var bound = await app.listen({ port: PORT, host: "127.0.0.1" });

  // The forged authenticated-customer cookie — the vault is now initialized
  // (createApp seals/unlocks it), so b.vault.seal works. This is the exact
  // shape the storefront reads back via readSealed for /account/*. Loopback is
  // plain http so the cookie name is the bare `shop_auth` (no __Host- prefix).
  var forgedCookie = null;
  if (seedResult.refs.customer_id) {
    try { forgedCookie = require("../helpers").authCookie(b, seedResult.refs.customer_id); }
    catch (e) { process.stderr.write("[audit] forged cookie mint failed: " + (e && e.message) + "\n"); }
  }

  // The single machine-readable readiness line.
  process.stdout.write(
    "AUDIT_READY " + bound.port +
    " admin_key=" + ADMIN_KEY +
    " product=" + (seedResult.refs.product_slug || "(none)") +
    " order=" + (seedResult.refs.order_id || "(none)") + "\n"
  );

  // Operator how-to (stdout, human-readable).
  process.stdout.write("[audit] storefront:  http://127.0.0.1:" + bound.port + "/\n");
  process.stdout.write("[audit] admin login: http://127.0.0.1:" + bound.port + "/admin  (paste admin key, or POST token=" + ADMIN_KEY + " to /admin/login)\n");
  process.stdout.write("[audit] admin bearer: Authorization: Bearer " + ADMIN_KEY + "\n");
  if (forgedCookie) {
    process.stdout.write("[audit] customer session cookie (set in the browser, then browse /account/*):\n");
    process.stdout.write("[audit]   " + forgedCookie + "\n");
    process.stdout.write("[audit]   cookie name=shop_auth  customer_id=" + seedResult.refs.customer_id + "\n");
  } else {
    process.stdout.write("[audit] no customer seeded — /account/* forged-cookie unavailable\n");
  }
  process.stdout.write("[audit] seeded: " + seedResult.seeded.join("; ") + "\n");

  function _stop() {
    app.shutdown().then(function () {
      try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
      process.exit(0);
    }, function () { process.exit(1); });
  }
  process.on("SIGINT", _stop);
  process.on("SIGTERM", _stop);
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write("[audit] failed to start: " + (err && err.message || err) + "\n");
    if (err && err.stack) process.stderr.write(err.stack + "\n");
    process.exit(1);
  });
}

module.exports = { main: main };
