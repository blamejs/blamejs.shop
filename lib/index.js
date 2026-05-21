"use strict";
/**
 * blamejs.shop entry point.
 *
 * Re-exports the vendored blamejs surface plus the local primitives
 * composed on top of it. Extend by adding new modules under `lib/`
 * that compose blamejs primitives — never by patching
 * `lib/vendor/blamejs/` in place.
 *
 *   var bShop = require("blamejs-shop");
 *   var b     = bShop.framework;        // the vendored blamejs
 *   var d1    = bShop.externaldbD1;     // Cloudflare D1 adapter
 *
 * Future primitives surface as additional fields on the exports
 * object (e.g. `bShop.catalog`, `bShop.cart`, `bShop.checkout`, etc.).
 */

var framework;
try {
  framework = require("./vendor/blamejs");
} catch (e) {
  // The vendored tree is absent on a fresh clone. Direct the
  // operator at the refresh script rather than crashing opaquely.
  if (e && e.code === "MODULE_NOT_FOUND") {
    throw new Error(
      "blamejs is not vendored — run `bash scripts/vendor-update.sh blamejs latest` " +
      "to populate lib/vendor/blamejs/ before requiring this module"
    );
  }
  throw e;
}

module.exports = {
  framework:    framework,
  externaldbD1: require("./externaldb-d1"),
  r2Bridge:     require("./r2-bridge"),
  catalog:      require("./catalog"),
  catalogImport: require("./catalog-import"),
  cart:         require("./cart"),
  pricing:      require("./pricing"),
  tax:          require("./tax"),
  shipping:     require("./shipping"),
  payment:      require("./payment"),
  order:        require("./order"),
  checkout:     require("./checkout"),
  email:        require("./email"),
  storefront:   require("./storefront"),
  admin:        require("./admin"),
  config:       require("./config"),
  webhooks:        require("./webhooks"),
  analytics:       require("./analytics"),
  inventoryAlerts: require("./inventory-alerts"),
};
