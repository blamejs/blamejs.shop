"use strict";
/**
 * blamejs.shop entry point.
 *
 * Re-exports the vendored blamejs surface. Extend by adding new
 * modules under `lib/` that compose blamejs primitives — never by
 * patching `lib/vendor/blamejs/` in place.
 *
 * Operators consume this module:
 *
 *   var bShop = require("blamejs-shop");
 *   var b     = bShop.framework;           // the vendored blamejs
 *
 * Future primitives surface as additional fields on the exports
 * object (e.g. `bShop.commerce`, `bShop.storefront`, etc.).
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
  framework: framework,
};
