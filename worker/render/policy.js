// Static policy pages (privacy, terms). Composed off a minimal
// layout that doesn't carry the storefront hero / marquee / catalog
// chrome — these are read-once legal docs, not a commerce surface.
import { renderTemplate, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag, spliceRaw } from "./_lib.js";
import b from "../b.js";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{description}}\">\n" +
  "  <link rel=\"canonical\" href=\"{{canonical_url}}\">\n" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <meta name=\"theme-color\" content=\"#08080a\">\n" +
  "  <link rel=\"stylesheet\" href=\"{{theme_css}}\"RAW_CSS_INTEGRITY>\n" +
  "  <meta name=\"robots\" content=\"index, follow\">\n" +
  "</head>\n" +
  "<body>\n" +
  "  <a class=\"skip-link\" href=\"#main\">Skip to content</a>\n" +
  "RAW_ANNOUNCEMENT_BAR" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\" aria-label=\"{{shop_name}}\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\"></a>\n" +
  "      <nav class=\"site-nav\" aria-label=\"Primary\">\n" +
  "        <div class=\"site-nav__links\">\n" +
  "          <a class=\"site-nav__link\" href=\"/\">Shop</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/collections\">Collections</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/categories\">Categories</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/cart\">Cart</a>\n" +
  "        </div>\n" +
  "        <details class=\"site-nav__menu\">\n" +
  "          <summary class=\"site-nav__menu-toggle\" aria-label=\"Menu\"><svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\"><path d=\"M4 7h16M4 12h16M4 17h16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg><span class=\"site-nav__menu-label\">Menu</span></summary>\n" +
  "          <div class=\"site-nav__drawer\">\n" +
  "            <a class=\"site-nav__link\" href=\"/\">Shop</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/collections\">Collections</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/categories\">Categories</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/cart\">Cart</a>\n" +
  "          </div>\n" +
  "        </details>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <main id=\"main\" class=\"policy-page\">\n" +
  "    <div class=\"policy-page__inner\">\n" +
  "      <p class=\"eyebrow\">{{eyebrow}}</p>\n" +
  "      <h1>{{title_h1}}</h1>\n" +
  "      <p class=\"policy-page__lede\">{{lede}}</p>\n" +
  "      <p class=\"policy-page__updated\">Last updated: {{updated}}</p>\n" +
  "      RAW_BODY_PLACEHOLDER\n" +
  "    </div>\n" +
  "  </main>\n" +
  "  <footer class=\"site-footer site-footer--minimal\">\n" +
  "    <div class=\"site-footer__inner\">\n" +
  "      <p>&copy; {{year}} {{shop_name_footer}}</p>\n" +
  "      <ul>\n" +
  "        <li><a href=\"/privacy\">Privacy</a></li>\n" +
  "        <li><a href=\"/terms\">Terms</a></li>\n" +
  "        <li><a href=\"/cookies\">Manage cookies</a></li>\n" +
  "        <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">Source</a></li>\n" +
  "      </ul>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  CONSENT_BANNER +
  "RAW_CONSENT_SCRIPT" +
  "RAW_CART_COUNT_SCRIPT" +
  "RAW_ANNOUNCEMENT_SCRIPT" +
  "</body>\n" +
  "</html>\n";

function _wrap(opts, bodyHtml) {
  var shopName = opts.shopName || "blamejs.shop";
  var themeCss = opts.themeCss  || assetUrl("css/main.css");
  var assembled = renderTemplate(LAYOUT, {
    title:            opts.title,
    title_h1:         opts.title,
    shop_name:        shopName,
    shop_name_footer: shopName,
    description:      opts.description,
    theme_css:        themeCss,
    eyebrow:          opts.eyebrow,
    lede:             opts.lede,
    updated:          opts.updated,
    canonical_url:    opts.canonicalUrl || "",
    year:             String(new Date().getUTCFullYear()),
  }).replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(themeCss))
    .replace("RAW_CONSENT_SCRIPT", consentScriptTag())
    .replace("RAW_CART_COUNT_SCRIPT", cartCountScriptTag())
    .replace("RAW_ANNOUNCEMENT_SCRIPT", (opts.announcement && opts.announcement.dismissible) ? announcementScriptTag() : "");
  // The announcement bar carries operator-supplied message text (HTML-
  // escaped, but `$` is not an escaped character), so splice it via the
  // replacer-function helper — a `$&` / `` $` `` / `$N` in the message must
  // land literally, not trigger `String.replace`'s dollar substitution.
  // Same for the body below. See `spliceRaw`.
  assembled = spliceRaw(assembled, "RAW_ANNOUNCEMENT_BAR", announcementBar(opts.announcement || null));
  return spliceRaw(assembled, "RAW_BODY_PLACEHOLDER", bodyHtml);
}

var PRIVACY_BODY =
  "<section><h2>What we collect</h2>" +
  "<p>blamejs.shop is an open-source ecommerce framework reference deployment. Every visitor request is processed through Cloudflare's edge network and a Cloudflare Worker we operate. The Worker logs the minimum required for operating the service: timestamp, request method, path, response status, and Cloudflare-assigned ray ID. We do not set any tracking pixel, fingerprinting beacon, or third-party analytics tag on the site.</p>" +
  "<p>If you submit the newsletter form, we store the email address you provide so we can send release notes. The address sits in a sealed-storage record encrypted with XChaCha20-Poly1305. We do not share it with anyone.</p>" +
  "<p>If you create a cart or place an order, we persist a session identifier (<code>shop_sid</code>) in a sealed HTTP-only cookie scoped to this domain. The cookie carries no profiling data — it is the lookup key for your in-progress cart row.</p></section>" +
  "<section><h2>What we share</h2>" +
  "<p>Order payments are processed through Stripe. The Stripe SDK runs on the checkout page; Stripe sees the card number, billing address, and amount. We never see the raw PAN. Order metadata (line items, shipping address, fulfilment status) lives in our database and is shared with no third party except as required to ship the order.</p></section>" +
  "<section><h2>What you can ask us to do</h2>" +
  "<p>You can request export or deletion of every personal record we hold about you by emailing <a href=\"mailto:privacy@blamejs.shop\">privacy@blamejs.shop</a>. The framework's compliance-export primitive produces the same shape an EU data-subject access request expects. We honour deletion requests within the timelines mandated by GDPR (one month), the California CCPA, and equivalent statutes in your jurisdiction where applicable.</p></section>" +
  "<section><h2>Changes to this policy</h2>" +
  "<p>This policy is versioned in source control alongside the framework code. Material changes ship with a release note and the &quot;Last updated&quot; date above moves forward. The full revision history lives in the project's git log.</p></section>";

var TERMS_BODY =
  "<section><h2>What this site is</h2>" +
  "<p>blamejs.shop is the reference deployment of the open-source <code>@blamejs/blamejs-shop</code> ecommerce framework. The framework is licensed under Apache 2.0; the source for everything you see is at <a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">github.com/blamejs/blamejs.shop</a>. The deployment shows what the framework produces out of the box; the products listed are real and orderable when the operator chooses to run the deployment as a real shop.</p></section>" +
  "<section><h2>Use of the site</h2>" +
  "<p>The framework is provided AS IS, without warranty of any kind. The reference deployment is operated on best-effort hardware; we make no SLA promise about availability. If you intend to depend on the framework for a production shop you operate, fork the source and run your own deployment.</p></section>" +
  "<section><h2>Orders, payments, returns</h2>" +
  "<p>If you place an order on this deployment, the operator will fulfil it according to the policies listed at the product page. Returns are handled through the customer portal at <a href=\"/account\">/account</a>; the framework's returns primitive enforces the operator's published return window and refund-method rules.</p></section>" +
  "<section><h2>Limitation of liability</h2>" +
  "<p>To the maximum extent permitted by law, the operator's liability for any claim arising from use of this site is limited to the amount paid for the specific order to which the claim relates. The framework's authors disclaim any liability for damages arising from third-party deployments of the framework.</p></section>" +
  "<section><h2>Governing law</h2>" +
  "<p>This deployment is operated from the United States. Any dispute will be resolved under the laws of the operator's jurisdiction, unless your local consumer-protection law mandates otherwise.</p></section>";

export function renderPrivacy(opts) {
  opts = opts || {};
  return _wrap({
    title:       "Privacy",
    eyebrow:     "Legal",
    lede:        "What blamejs.shop collects, how it's stored, and what you can ask us to do.",
    description: "Privacy policy for blamejs.shop — what data we collect, how it's stored, and your rights.",
    updated:     "2026-05-23",
    shopName:    opts.shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
    canonicalUrl: opts.canonicalUrl,
  }, PRIVACY_BODY);
}

export function renderTerms(opts) {
  opts = opts || {};
  return _wrap({
    title:       "Terms of use",
    eyebrow:     "Legal",
    lede:        "The terms under which blamejs.shop is operated and what you agree to by using the site.",
    description: "Terms of use for blamejs.shop — the rules under which the reference deployment is operated.",
    updated:     "2026-05-23",
    shopName:    opts.shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
    canonicalUrl: opts.canonicalUrl,
  }, TERMS_BODY);
}

// Edge-served 500 — no container hop, no D1 read. Renders when an
// edge handler hits an unexpected exception (render error, D1 read
// failure that exhausted retries). The page apologises without
// revealing internals and points the visitor at the home page so a
// crawler doesn't get stuck on a permanent 5xx URL.
export function renderInternalError(opts) {
  opts = opts || {};
  var body =
    "<section><h2>Something went wrong on our end.</h2>" +
    "<p>The storefront couldn't render this page right now. The error has been logged to our observability sink and we'll investigate. The rest of the site is still up — head back to <a href=\"/\">the shop</a> and try again in a moment.</p>" +
    "<p><a class=\"btn-primary\" href=\"/\">Back to the shop</a></p></section>";
  return _wrap({
    title:       "Server error",
    eyebrow:     "500",
    lede:        "An unexpected error occurred rendering this page.",
    description: "An error rendering this page — blamejs.shop",
    updated:     "—",
    shopName:    opts.shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
  }, body);
}

// Newsletter signup result — `result === "new"` means the address
// landed; `result === "existing"` means the idempotent insert hit a
// conflict (already enrolled). Both are success cases; the message
// differs slightly so a returning visitor sees the right tone.
export function renderNewsletterThanks(opts) {
  opts = opts || {};
  var existing = opts.result === "existing";
  var body =
    "<section><h2>" + (existing ? "You're already on the list." : "Thanks — you're on the list.") + "</h2>" +
    "<p>" + (existing
      ? "We already had your address. You'll get the next release note when it ships."
      : "We added your address. You'll get the next release note when it ships, and nothing else.") +
    "</p><p><a class=\"btn-primary\" href=\"/\">Back to the shop</a></p></section>";
  return _wrap({
    title:       existing ? "Already subscribed" : "Subscribed",
    eyebrow:     "Newsletter",
    lede:        existing
      ? "Your address was already on the list."
      : "Your address has been added to the release-notes list.",
    description: "Newsletter signup confirmation — blamejs.shop",
    updated:     "—",
    shopName:    opts.shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
  }, body);
}

// Newsletter signup refused — invalid email shape. `message` is the
// operator-facing reason; never leak the internal validator error.
export function renderNewsletterError(opts) {
  opts = opts || {};
  var msg = opts.message || "That doesn't look like a valid email address. Check the format and try again.";
  var body =
    "<section><h2>We couldn't add that address.</h2>" +
    "<p>" + b.template.escapeHtml(msg) + "</p>" +
    "<p><a class=\"btn-primary\" href=\"/\">Back to the shop</a></p></section>";
  return _wrap({
    title:       "Signup refused",
    eyebrow:     "Newsletter",
    lede:        "The address you submitted didn't validate.",
    description: "Newsletter signup refused — blamejs.shop",
    updated:     "—",
    shopName:    opts.shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
  }, body);
}

// Edge-served 404 — no container hop, no D1 read. Renders when an
// edge route resolves to a missing resource (an `/products/:slug`
// that returned null, a `/blog/:slug` that's draft / archived /
// unknown). The same minimal layout the policy pages use keeps the
// chrome consistent without dragging in the full storefront hero.
export function renderNotFound(opts) {
  opts = opts || {};
  var what = (typeof opts.what === "string" && opts.what.length) ? opts.what : "page";
  var body =
    "<section><h2>We can't find that " + what + ".</h2>" +
    "<p>The link you followed may be stale, the slug may have been renamed, or the resource may have been archived. The catalog and the rest of the storefront are still up — head back to <a href=\"/\">the shop</a> or use the search box to find what you were looking for.</p>" +
    "<p><a class=\"btn-primary\" href=\"/\">Back to the shop</a></p></section>";
  return _wrap({
    title:       "Not found",
    eyebrow:     "404",
    lede:        "The resource you asked for doesn't exist at that URL.",
    description: "Not found — blamejs.shop",
    updated:     "—",
    shopName:    opts.shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
  }, body);
}
