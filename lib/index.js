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
  order:         require("./order"),
  subscriptions: require("./subscriptions"),
  customers:     require("./customers"),
  checkout:      require("./checkout"),
  email:        require("./email"),
  newsletter:   require("./newsletter"),
  storefront:   require("./storefront"),
  theme:        require("./theme"),
  admin:        require("./admin"),
  config:       require("./config"),
  webhooks:        require("./webhooks"),
  analytics:       require("./analytics"),
  inventoryAlerts: require("./inventory-alerts"),
  giftcards:       require("./giftcards"),
  reviews:         require("./reviews"),
  wishlist:        require("./wishlist"),
  inventoryReceive:  require("./inventory-receive"),
  orderTracking:     require("./order-tracking"),
  loyalty:           require("./loyalty"),
  returns:           require("./returns"),
  notifications:     require("./notifications"),
  referrals:         require("./referrals"),
  addresses:         require("./addresses"),
  taxExempt:         require("./tax-exempt"),
  emailSuppressions: require("./email-suppressions"),
  currencyDisplay:   require("./currency-display"),
  searchSuggestions: require("./search-suggestions"),
  cartAbandonment:   require("./cart-abandonment"),
  bundles:           require("./bundles"),
  variants:          require("./variants"),
  inventoryLocations: require("./inventory-locations"),
  backorder:         require("./backorder"),
  paymentMethods:    require("./payment-methods"),
  orderNotes:        require("./order-notes"),
  fraudScreen:       require("./fraud-screen"),
  orderExport:       require("./order-export"),
  printOnDemand:     require("./print-on-demand"),
  saveForLater:      require("./save-for-later"),
  salesReports:        require("./sales-reports"),
  quantityDiscounts:   require("./quantity-discounts"),
  subscriptionControls: require("./subscription-controls"),
  giftOptions:         require("./gift-options"),
  supportTickets:      require("./support-tickets"),
  collections:         require("./collections"),
  customerSegments:    require("./customer-segments"),
  recentlyViewed:      require("./recently-viewed"),
  stockAlerts:         require("./stock-alerts"),
  shippingLabels:      require("./shipping-labels"),
  returnLabels:        require("./return-labels"),
  promoBanners:        require("./promo-banners"),
  searchSynonyms:      require("./search-synonyms"),
  affiliates:          require("./affiliates"),
  mailingAudiences:    require("./mailing-audiences"),
  orderTimeline:       require("./order-timeline"),
};
