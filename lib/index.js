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
  taxRates:              require("./tax-rates"),
  webhookSubscriptions:  require("./webhook-subscriptions"),
  storefrontPages:       require("./storefront-pages"),
  tenants:               require("./tenants"),
  apiKeys:               require("./api-keys"),
  barcodes:              require("./barcodes"),
  customerPortal:        require("./customer-portal"),
  subscriptionBilling:   require("./subscription-billing"),
  translations:          require("./translations"),
  couponStacking:        require("./coupon-stacking"),
  experiments:           require("./experiments"),
  printReceipts:         require("./print-receipts"),
  inventorySnapshots:    require("./inventory-snapshots"),
  productImport:         require("./product-import"),
  customerImport:        require("./customer-import"),
  codeMinter:            require("./code-minter"),
  storefrontForms:       require("./storefront-forms"),
  cartBulkOps:           require("./cart-bulk-ops"),
  carrierRates:          require("./carrier-rates"),
  operatorAuditLog:      require("./operator-audit-log"),
  cmsBlocks:             require("./cms-blocks"),
  giftCardLedger:        require("./gift-card-ledger"),
  discountAnalytics:     require("./discount-analytics"),
  searchFacets:          require("./search-facets"),
  dunning:               require("./dunning"),
  planChanges:           require("./plan-changes"),
  vendors:               require("./vendors"),
  loyaltyRedemption:     require("./loyalty-redemption"),
  giftRegistry:          require("./gift-registry"),
  geolocation:           require("./geolocation"),
  stockTransfers:        require("./stock-transfers"),
  smsDispatcher:         require("./sms-dispatcher"),
  emailCampaigns:        require("./email-campaigns"),
  storefrontDashboards:  require("./storefront-dashboards"),
  refundPolicy:          require("./refund-policy"),
  invoiceRenderer:       require("./invoice-renderer"),
  storeCredit:           require("./store-credit"),
  errorLog:              require("./error-log"),
  complianceExport:      require("./compliance-export"),
  liveChat:              require("./live-chat"),
  addressValidation:     require("./address-validation"),
  autoDiscount:          require("./auto-discount"),
  captchaGate:           require("./captcha-gate"),
  catalogDrafts:         require("./catalog-drafts"),
  cookieConsent:         require("./cookie-consent"),
  customerRoles:         require("./customer-roles"),
  cycleCounting:         require("./cycle-counting"),
  deliveryEstimate:      require("./delivery-estimate"),
  emailWarmup:           require("./email-warmup"),
  meteredUsage:          require("./metered-usage"),
  priceDisplay:          require("./price-display"),
  productBulkOps:        require("./product-bulk-ops"),
  purchaseOrders:        require("./purchase-orders"),
  quotes:                require("./quotes"),
  recommendations:       require("./recommendations"),
  reorderThresholds:     require("./reorder-thresholds"),
  shippingZones:         require("./shipping-zones"),
  splitShipments:        require("./split-shipments"),
  trustBadges:           require("./trust-badges"),
  webhookReceiver:       require("./webhook-receiver"),
  siteRedirects:         require("./site-redirects"),
  costLayers:            require("./cost-layers"),
  paymentRetries:        require("./payment-retries"),
  pickLists:             require("./pick-lists"),
  preorder:              require("./preorder"),
  discountAllocation:    require("./discount-allocation"),
  currencyRounding:      require("./currency-rounding"),
  creditLimits:          require("./credit-limits"),
  themeAssets:           require("./theme-assets"),
  businessHours:         require("./business-hours"),
};
