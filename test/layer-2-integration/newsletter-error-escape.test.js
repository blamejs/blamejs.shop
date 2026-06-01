"use strict";
/**
 * Newsletter error renderer — the free-text `message` opt must be
 * HTML-escaped at the sink (b.template.escapeHtml), like every sibling
 * renderer in lib/storefront.js.
 *
 * renderNewsletterError interpolated opts.message into the page without
 * escaping. The only current caller passes a fixed literal or null, so
 * it is not reachable today — but it was the lone free-text → HTML sink
 * in the file that bypassed esc(), a latent reflected/stored XSS in a
 * file where escape-at-sink is the sole defense. This locks the escape.
 *
 * Asserts:
 *   - a <script> payload renders ESCAPED (&lt;script&gt;…) and the raw
 *     "<script>alert(1)</script>" payload is ABSENT from the output;
 *   - an attribute-breaking payload's quote/angle-brackets are escaped;
 *   - the exact default message is preserved verbatim when no message
 *     is supplied.
 *
 * Network: zero — pure renderer call.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var DEFAULT_MSG = "Check the address and try again — only RFC-shape email addresses are accepted.";

function _run() {
  // ---- (1) a <script> payload is escaped, not reflected raw ----
  var payload = "<script>alert(1)</script>";
  var html = bShop.storefront.renderNewsletterError({ message: payload, shop_name: "Esc Shop" });

  check("script payload appears in the ESCAPED form",
    html.indexOf("&lt;script&gt;alert(1)&lt;/script&gt;") !== -1);
  check("raw <script> payload is ABSENT from the output",
    html.indexOf(payload) === -1);
  check("no raw '<script>' substring leaks at all",
    html.indexOf("<script>alert") === -1);

  // ---- (2) an attribute-breaking payload's metacharacters are escaped --
  var attrPayload = "\"><img src=x onerror=alert(1)>";
  var html2 = bShop.storefront.renderNewsletterError({ message: attrPayload, shop_name: "Esc Shop" });
  check("attr payload's angle bracket is escaped",
    html2.indexOf("&lt;img") !== -1 && html2.indexOf("<img src=x") === -1);

  // ---- (3) the default message is preserved verbatim ----
  var htmlDefault = bShop.storefront.renderNewsletterError({ shop_name: "Esc Shop" });
  check("default message preserved when no message supplied",
    htmlDefault.indexOf(DEFAULT_MSG) !== -1);

  // A null message also falls back to the default (the original caller
  // passes null on a non-TypeError).
  var htmlNull = bShop.storefront.renderNewsletterError({ message: null, shop_name: "Esc Shop" });
  check("null message falls back to the default",
    htmlNull.indexOf(DEFAULT_MSG) !== -1);
}

module.exports = { run: _run };
