"use strict";
/**
 * gate-contract.js — release gate: assert every preventable bug-class
 * the project has fixed once still maps to a live detector and an
 * enforced gate, and surface new code surfaces that look like they need
 * coverage but don't have it yet.
 *
 * Wired into `node scripts/release.js prepare` (static gates) and
 * `node test/smoke.js`. Three things it verifies, plus an advisory scan:
 *
 *   (a) EVERY detector named in the COVERAGE registry below exists in
 *       the codebase-patterns catalog (KNOWN_ANTIPATTERNS). A typo, a
 *       renamed detector, or a removed detector trips this — the bug
 *       class would no longer be caught.
 *
 *   (b) EVERY detector that flags a shipped-bug class (carries
 *       `bugClassDeclared: true` in the catalog) has a COVERAGE row.
 *       A new shipped-bug detector added without a coverage row trips
 *       this — the registry would silently fall out of date.
 *
 *   (c) EVERY gate the registry depends on is still wired into the
 *       release pipeline. The codebase-patterns + currency gates (and
 *       this gate itself) must still be invoked from release.js
 *       `cmdPrepare`. A refactor that drops a gate trips this.
 *
 *   (d) CANDIDATE-GAP SCAN (advisory) — three cheap heuristics over
 *       lib/ flag a NEW surface that looks like it needs a declared
 *       gate but isn't covered: a new outbound webhook-style URL
 *       validator without an SSRF composition, a new money-binding
 *       currency site without the ISO 4217 catalog check, and a new
 *       admin 5xx response that echoes a raw error message. Each prints
 *       a candidate for human classification; a candidate is only a
 *       hard failure when it is genuinely undeclared (the detectors in
 *       (a)/(b) already cover the known-good tree, so a clean tree
 *       emits no candidates).
 *
 * On a gap the gate exits non-zero and prints, per finding, a
 * paste-ready line naming the missing detector / gate / candidate
 * surface so the fix is copy-paste. Conscious deferral (debt you are
 * not ready to close this cut):
 *
 *   RELEASE_ALLOW_GATE_GAPS=1  — downgrades every gap to a warning and
 *   exits 0. The findings still print so the debt stays visible.
 *
 * Zero npm deps — node builtins only. Exposes a pure `verify()`
 * returning `{ ok, gaps }` so the unit test can assert the known-good
 * tree returns `ok: true` without spawning the process.
 */

var fs   = require("node:fs");
var path = require("node:path");

var ROOT = path.resolve(__dirname, "..");
var ALLOW_GAPS = process.env.RELEASE_ALLOW_GATE_GAPS === "1";

// ---- the declared coverage registry ------------------------------------
//
// One row per preventable bug-class the project has fixed once and
// wants locked. `detector` names a codebase-patterns id (asserted to
// exist); `gate` names the pipeline stage that runs it. Adding a new
// shipped-bug detector (one carrying `bugClassDeclared: true`) without
// a row here trips assertion (b).
var COVERAGE = [
  {
    bugClass: "admin 5xx leaks raw error text to the client",
    detector: "admin-5xx-echoes-raw-error-message",
    gate:     "codebase-patterns",
    note:     "5xx problem-details must carry no error-derived detail; record server-side, return a generic code",
  },
  {
    bugClass: "admin cookie/HTML error banner leaks raw error text to the operator's browser",
    detector: "admin-html-error-banner-echoes-raw-error-message",
    gate:     "codebase-patterns",
    note:     "every admin HTML notice/banner built from a thrown error routes through _safeNotice; the cookie path can never diverge from the bearer path on what it reveals",
  },
  {
    bugClass: "public catalog API 5xx leaks raw DB/error text to an anonymous caller — _problemFromError (server.js) passes a non-TypeError's e.message into a status:500 problemDetails.fromError, which copies it verbatim into the body, and the D1 layer wraps the upstream constraint/SQL string into err.message",
    detector: "public-api-5xx-echoes-raw-error-message",
    gate:     "codebase-patterns",
    note:     "_problemFromError surfaces a TypeError's validation message as a 400 but scrubs every other error to a generic 500 detail, recording the raw message server-side via b.audit.safeEmit(action:\"shop_catalog_api.request.error\", outcome:\"failure\"); the unauthenticated GET /api/catalog/products[/:slug] routes never echo storage-engine internals (mirrors admin _safeNotice)",
  },
  {
    bugClass: "operator-supplied outbound webhook URL enables SSRF",
    detector: "outbound-webhook-url-without-ssrf-guard",
    gate:     "codebase-patterns",
    note:     "an outbound webhook endpoint URL must compose the SSRF guard (textGuard.hostLabel / ssrfGuard.classify)",
  },
  {
    bugClass: "gift card issued in a non-ISO-4217 currency",
    detector: "giftcard-issue-without-iso4217-currency-check",
    gate:     "codebase-patterns",
    note:     "validate the currency against b.money.CURRENCIES (or textGuard.currencyCode) before giftcards.issue",
  },
  {
    bugClass: "any money-binding issue/grant/credit in a non-ISO-4217 currency",
    detector: "money-binding-currency-without-catalog-check",
    gate:     "codebase-patterns",
    note:     "generalizes the giftcard check to every balance-binding primitive",
  },
  {
    bugClass: "unguarded JSON.parse of a request-body field 500s on bad paste",
    detector: "admin-unguarded-json-parse-request-field",
    gate:     "codebase-patterns",
    note:     "wrap the parse and throw a TypeError so the bad paste degrades to a clean 400",
  },
  {
    bugClass: "returns-refund maps a malformed-id TypeError to a wrong 404",
    detector: "returns-refund-typeerror-mapped-to-404",
    gate:     "codebase-patterns",
    note:     "a malformed id is a 400 bad-request like its sibling actions; only a well-formed missing id is a 404",
  },
  {
    bugClass: "Document-Policy header asserts a legacy feature token current browsers don't recognize (inert header + console noise)",
    detector: "document-policy-unrecognized-feature-token",
    gate:     "codebase-patterns",
    note:     "suppress the vendored default's inert Document-Policy (securityHeadersOpts → documentPolicy:false) and emit none at the edge; the recognized feature set is force-load-at-top / js-profiling / include-js-call-stacks-in-crash-reports / expect-no-linked-resources / network-efficiency-guardrails — assert one of those or send no header",
  },
  {
    bugClass: "PDP image gallery is decorative-only — aria-hidden thumbnail strip with non-interactive tiles padded to fixed empty slots",
    detector: "pdp-gallery-inert-thumbnail-strip",
    gate:     "codebase-patterns",
    note:     "render the thumbnail strip as a focusable <ul.pdp__thumbs> of <label for> controls bound to hidden radios (no aria-hidden, no empty-<li> padding) so the gallery is a working no-JS CSS-:checked picker — exactly N thumbnails, no strip for a lone image",
  },
  {
    bugClass: "product media reorder/set-primary repositions another product's gallery row via an unscoped position UPDATE (cross-product display-order IDOR)",
    detector: "media-reorder-unscoped-position-update",
    gate:     "codebase-patterns",
    note:     "scope every UPDATE media SET position by product_id (WHERE id = ? AND product_id = ?) so a crafted ordered_media_ids / media id can't renumber another product's hero/order",
  },
  {
    bugClass: "storefront search result-count rendered from the page-slice length instead of the real match total (count lies + surplus products unreachable)",
    detector: "search-count-from-page-length",
    gate:     "codebase-patterns",
    note:     "drive the \"Showing N matches\" copy off the real total (searchFacets previewQuery total / the full narrowed-set length), not the rendered page slice's .length; window only the painted cards by ?page=N",
  },
  {
    bugClass: "blog admin create auto-publishes a new post, pushing it to the storefront before review (skips the draft-stays-hidden gate)",
    detector: "blog-create-auto-publishes-draft",
    gate:     "codebase-patterns",
    note:     "the create handler calls blog.createDraft and stops; publishing is a separate operator-invoked action (POST /admin/blog/:slug/publish) so a post is reviewable as a draft before it goes live on /blog",
  },
  {
    bugClass: "admin discount edit coercion drops the trigger/value terms columns updateRule accepts (operator can reprioritise/pause but not change the discount terms from the console — a write-but-no-edit dormant gap)",
    detector: "discount-patch-drops-trigger-or-value",
    gate:     "codebase-patterns",
    note:     "_discountPatch must forward patch.trigger = _discountTrigger(body) and patch.value = _discountValue(body) so the browser edit path reaches the same terms columns (amount/percentage/threshold/BOGO) as the bearer PATCH; both reuse the create form's validating vocabulary so a bad terms edit is a clean 400",
  },
  {
    bugClass: "R2-served media asset response carries no protective headers — a mis-typed operator upload can be MIME-sniffed into an executable type, embedded cross-origin, or (for a directly-navigated SVG) run script in the site's origin",
    detector: "r2-asset-response-without-nosniff-hardening",
    gate:     "codebase-patterns",
    note:     "stamp the asset Response via _hardenAssetResponse(headers) before new Response(obj.body, { headers }) — X-Content-Type-Options: nosniff + Cross-Origin-Resource-Policy: same-origin on every asset, plus a default-src 'none'; style-src 'unsafe-inline'; sandbox CSP on image/svg+xml",
  },
  {
    bugClass: "admin /admin/products/:id/media/:mid/primary route ignores its :id path segment — setPrimary scopes by the media row's own product, so a request can name product A in the path while acting on product B's media (path/contract honesty gap)",
    detector: "admin-media-mid-route-ignores-id-segment",
    gate:     "codebase-patterns",
    note:     "assert _mediaBelongsToProduct(req.params.mid, req.params.id) (clean 404 on a mismatch, 400 on a malformed id) before catalog.media.setPrimary(req.params.mid) so the path is self-consistent about which product it touched",
  },
  {
    bugClass: "storefront order-cancel route fires the order FSM's cancel event by id without first asserting the order belongs to the session customer (any signed-in shopper could cancel any order by id — IDOR)",
    detector: "storefront-order-cancel-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "compare order.customer_id against the session customer's id (clean 404 on a mismatch / guest-owned order) before deps.order.transition(id, \"cancel\"); the order primitive transitions by id alone, so the route owns the ownership decision",
  },
  {
    bugClass: "edge storefront page read serves a draft/archived CMS page — a SELECT from storefront_pages by slug with no status='published' predicate pushes staged or retired copy live (unreviewed-content leak)",
    detector: "storefront-page-read-without-published-filter",
    gate:     "codebase-patterns",
    note:     "scope the /pages/:slug edge read (getPublishedPageBySlug) by status='published' so a draft / archived / unknown slug all return null and 404 alike; only published pages reach a visitor",
  },
  {
    bugClass: "a dynamic page body (blog post / CMS page / reflected search query) spliced into the HTML via String.replace with the body as the replacement STRING — a `$`-bearing body triggers replacement-string dollar substitution ($&, $`, $', $N), leaking the page head into the body or corrupting the output",
    detector: "raw-body-replace-string-dollar-injection",
    gate:     "codebase-patterns",
    note:     "splice the body with a replacer function via the shared spliceRaw / _spliceRaw helper, never html.replace(\"RAW_BODY…\", bodyHtml) — applied to both the edge (worker/render) and the container (lib/storefront.js) so the dual-render stays byte-consistent",
  },
  {
    bugClass: "admin loyalty points-adjustment route grants/deducts a customer balance without a required reason — writes an unattributed balance change the ledger can't explain",
    detector: "loyalty-adjust-route-without-reason",
    gate:     "codebase-patterns",
    note:     "the POST /admin/loyalty/adjust route validates a required reason via _loyaltyReason(body.reason) and forwards it as the notes of loyalty.adjust({ customer_id, points, source, notes }); the primitive records the signed delta + reason in loyalty_transactions, so every grant/deduct is attributed",
  },
  {
    bugClass: "admin per-customer store-credit route grants/deducts a customer's account-bound balance without a required reason — writes an unattributed balance change the ledger can't explain",
    detector: "customer-store-credit-route-without-reason",
    gate:     "codebase-patterns",
    note:     "the POST /admin/customers/:id/store-credit route validates a required reason via _storeCreditReason(body.reason) and forwards it into the store-credit ledger (source_ref on storeCredit.credit for a grant, the reason column of storeCredit.expire for a deduct); the route is scoped to the :id customer and refuses an over-deduction as a clean 409 before any write, so every grant/deduct is attributed and bounded by the available balance",
  },
  {
    bugClass: "storefront customer support route (thread view / reply) acts on a path-named ticket without first asserting the ticket belongs to the session customer (any signed-in shopper could read or reply to another customer's ticket by id — IDOR)",
    detector: "storefront-support-reply-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "every per-ticket route (/account/support/:id and /account/support/:id/reply) funnels through _ownedTicket, which loads the ticket via supportTickets.get and refuses it (clean 404 on a malformed id, an unknown ticket, or a ticket owned by someone else) unless ticket.customer_id === auth.customer_id; the support primitive moves a ticket by id alone, so the route owns the ownership decision",
  },
  {
    bugClass: "storefront customer exchange route (request POST / status view) acts on a path-named order/exchange without first asserting the parent order belongs to the session customer (any signed-in shopper could open or read an exchange against another customer's order by id — IDOR)",
    detector: "storefront-exchange-request-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "the request form + POST under /account/orders/:order_id/exchange funnel through _ownedOrderForExchange and the /account/exchanges/:id status view through _ownedExchange — both load the parent order via deps.order.get and refuse (clean 404 on a malformed id, an unknown order/exchange, or a foreign-owned one) unless order.customer_id === auth.customer_id; the order-exchanges row carries no customer_id, so ownership is asserted transitively through the order and the route owns the decision",
  },
  {
    bugClass: "storefront customer return-label route (status detail / label download) resolves an already-issued return label + its tracking by a return/label path id without first asserting the return belongs to the session customer (any signed-in shopper could read or download another customer's return label by id — IDOR)",
    detector: "storefront-return-label-route-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "the /account/returns/:id status view and the /account/returns/:id/label download both funnel through _ownedReturn(req, res, auth), which loads the return via deps.returns.get and refuses it (clean 404 on a malformed / unknown / cross-customer id) unless return.customer_id === auth.customer_id, BEFORE resolving labelForReturn / eventsForLabel or redirecting to label_url; the return-labels primitive reads a label + timeline by id alone and a return label belongs to a return which belongs to a customer, so the route owns the ownership decision",
  },
  {
    bugClass: "storefront og:image / twitter:image / Product+Article JSON-LD image emitted as a relative `/assets/...` URL — social-share crawlers (Facebook / Slack / Twitter / iMessage) and Google's rich result fetch it from a different origin, so the share preview renders no image",
    detector: "og-image-relative-without-absolutize",
    gate:     "codebase-patterns",
    note:     "absolutize every og-image-class value against the page origin via absolutizeOgImage (edge worker/render/_lib.js) / _absolutizeOgImage (container lib/storefront.js) before it reaches the <head> or the structured data; the helper prefixes the canonical origin onto a /-rooted path and leaves an already-absolute http(s):// value unchanged, applied in both substrates so the dual-render stays byte-consistent",
  },
  {
    bugClass: "a worker/render head builder splices an operator-supplied head fragment (CMS meta_keywords, the announcement-bar message) via html.replace(\"RAW_…\", value) with the value as the replacement STRING — a `$`-bearing value triggers replacement-string dollar substitution ($&, $`, $', $N), corrupting the <head> or leaking it into the body (the same class the body splice was fixed for)",
    detector: "head-raw-replace-string-dollar-injection",
    gate:     "codebase-patterns",
    note:     "splice the RAW_META_KEYWORDS + RAW_ANNOUNCEMENT_BAR head placeholders through the replacer-function helper spliceRaw / _spliceRaw, never html.replace(\"RAW_META_KEYWORDS\"|\"RAW_ANNOUNCEMENT_BAR\", value) — applied to both the edge (worker/render) and the container (lib/storefront.js) so the dual-render stays byte-consistent; framework-fixed head placeholders (SRI, island scripts, robots meta) carry no `$` and stay plain .replace",
  },
  {
    bugClass: "storefront store-credit wallet route reads an account-bound balance/ledger from a request-supplied id instead of the session customer (any signed-in shopper could read another customer's balance by id — IDOR)",
    detector: "storefront-store-credit-route-without-session-scope",
    gate:     "codebase-patterns",
    note:     "the read-only GET /account/credit route resolves the balance + ledger from the session customer id (storeCredit.balance(auth.customer_id) / .history({ customer_id: auth.customer_id }) / .expiringWithin({ customer_id: auth.customer_id }), auth from _currentCustomer(req)); there is no :id path segment and the route never reads a customer id from the query/body, so a shopper only ever sees their own wallet",
  },
  {
    bugClass: "storefront wishlist-share revoke route flips a share link's revoked_at by path id without first asserting the link belongs to the session customer (any signed-in shopper could revoke another customer's share link by id — IDOR)",
    detector: "storefront-wishlist-share-revoke-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "the POST /wishlist/share/:share_id/revoke route loads the session customer's links via wishlistSharing.listSharesForOwner(auth.customer_id) and refuses a share_id that isn't among them (clean 404 on an unknown / malformed / cross-customer id) before revokeShareLink({ link_id }); the sharing primitive revokes by id alone, so the route owns the ownership decision. The public GET /wishlist/shared/:token view resolves the wishlist only through viewShared(token) — never by a guessable wishlist/customer id — and renders product cards only, redacting the owner identity + private notes",
  },
  {
    bugClass: "storefront gift-registry owner write route (add item / remove item / edit / close) mutates a registry by path slug without first asserting it belongs to the session customer (any signed-in shopper could add to / strip / edit / close another customer's registry by slug — IDOR)",
    detector: "storefront-registry-owner-route-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "every owner write route under /account/registry/:slug (items, items/:item_id/remove, edit, close) funnels through _ownedRegistry(slug, auth.customer_id), which loads via deps.giftRegistry.getRegistry and returns null unless reg.owner_customer_id === auth.customer_id (clean 404 on a foreign / unknown / malformed slug) before addItem / removeItem / update / closeRegistry; the gift-registry primitive mutates by slug alone, so the route owns the ownership decision. The create route keys the new owner on auth.customer_id directly (no :slug), and the public GET /registry/:slug giver view resolves only through getBySlug (never a guessable id), enforces the privacy gate in the route (a private registry 404s like an unknown slug), and surfaces items + aggregate counts only, never the owner identity / shipping address / per-buyer purchase rows",
  },
  {
    bugClass: "admin auto-discount value translator silently coerces an unrecognized value_kind to free_shipping instead of erroring — a typo'd value_kind from a JSON API client creates a store-wide free-shipping rule (the most generous kind) with no operator signal",
    detector: "admin-discount-value-kind-silent-default",
    gate:     "codebase-patterns",
    note:     "_discountValue(body) throws a TypeError (\"autoDiscount: value_kind must be one of …\") on any value_kind outside percent_off / amount_off_total / amount_off_each / bogo / free_shipping, which the create + edit routes map to a clean 400 — matching the sibling _rewardValueJson / _earnDefineInput translators that pass the kind through for the backend validator; the browser select is constrained to the five valid kinds, so only the JSON API path could reach the old free_shipping fall-through",
  },
  {
    bugClass: "public help-center /help/:slug route serves a draft/archived knowledge-base article — knowledgeBase.getArticle returns an unpublished row (its publishedOnly arg is hard-coded false), so reading by slug alone pushes staged or retired help content live (unreviewed-content leak)",
    detector: "help-article-route-without-published-filter",
    gate:     "codebase-patterns",
    note:     "the /help/:slug reader + the /help/:slug/vote POST gate the article read on _kbPublishedArticle (loads via knowledgeBase.getArticle, returns null unless published === true && archived_at == null) so a draft / archived / unknown slug all 404 alike, and the view/vote recorders only run for a publicly-visible article; the admin authoring routes under /admin/help read every state on purpose and aren't in scope",
  },
  {
    bugClass: "storefront collection page renders only the first 24 members and threads no cursor — a collection with more than 24 products silently loses everything past the 24th, with no shopper-reachable path to the rest",
    detector: "collection-route-without-cursor-pagination",
    gate:     "codebase-patterns",
    note:     "the GET /collections/:slug route threads a ?cursor= trail through collections.productsIn({ slug, limit, cursor }) and surfaces the lib's opaque forward next_cursor into renderCollection, which paints a prev/next nav reusing the search-pagination shell (rel=prev/next + disabled-state spans, no new CSS); productsIn returns at most one page with no total, so an un-cursored call caps the grid at the limit — a bad / stale cursor falls back to page 1 rather than 404/500, matching how /search clamps a bad ?page=, and the canonical stays the bare collection URL on every page",
  },
  {
    bugClass: "edge /blog index fetches a fixed 12-post page with no offset and renders no pager — a blog with more than 12 published posts silently loses on-site reachability to every post past the 12th (it stays in sitemap.xml so Google-discoverable, but a human browsing /blog dead-ends)",
    detector: "blog-list-route-without-pagination",
    gate:     "codebase-patterns",
    note:     "the _edgeBlogList route reads ?page=N, threads offset = (page-1)*BLOG_PAGE_SIZE into listBlogArticles({ limit: BLOG_PAGE_SIZE + 1, offset }), peeks one row past the page (hasNext = result.rows.length > BLOG_PAGE_SIZE), slices the peeked row off, and surfaces hasNext into renderBlogList, which paints a prev/next nav reusing the search-pagination shell (rel=prev/next + disabled-state spans, no new CSS); listBlogArticles exposes no total, so the peek prevents a phantom Next link, a garbage ?page degrades to page 1, and the canonical stays the bare /blog URL",
  },
  {
    bugClass: "edge blog renderers surface the internal author_id (an operator/user id, not a public display name) straight into the byline + the Article JSON-LD author Google reads — the blog model carries no author display-name column, so the id leaks on the public storefront and in structured data",
    detector: "blog-byline-from-raw-author-id",
    gate:     "codebase-patterns",
    note:     "render the list-card byline, the article byline, and the Article JSON-LD author.name from a byline derived from shopName (the cleanest non-leaking source — there is no blog_authors table or author display-name column to resolve), never the raw article.author_id; the JSON-LD author is typed Organization since the shop is the publisher",
  },
  {
    bugClass: "edge 404 (missing blog post / product) returns a full rendered body on a HEAD request — a spec violation that wastes bytes on every crawler HEAD probe of a dead link",
    detector: "edge-404-response-body-on-head",
    gate:     "codebase-patterns",
    note:     "every edge 404 Response guards its body with request.method === \"HEAD\" ? null : html (matching the page-404 + empty-cart paths), keeping the 404 status + short-TTL cache headers; the unconditional new Response(html, { status: 404 }) form is the regression shape",
  },
  {
    bugClass: "admin customer-segments create/edit form translator builds the segment rules from the request body and persists them without composing the primitive's validator — a JSON API client could land an unknown rule key, a non-integer value, or an empty rule set in customer_segments (a silently-empty segment or a 500 on a later evaluate)",
    detector: "segment-rules-form-without-primitive-validation",
    gate:     "codebase-patterns",
    note:     "_segmentRules(body) coerces each numeric RFM field via _strictMinorInt(body[k], \"customerSegments\", k) and hands the typed rules object to customerSegments.defineSegment / update, which validate every rule key + value (known keys only, non-negative integers, the 10000-bps cap, min ≤ max coherence, the at-least-one-rule floor) and throw a TypeError the create + edit routes map to a clean 400; the form never assembles a rules_json string and writes it straight, so the primitive owns validation",
  },
  {
    bugClass: "admin per-note write route (edit/pin/archive) mutates a customer note by id alone without first asserting it belongs to the path :id customer — an operator on one customer's screen could edit/pin/retire another customer's note by id (cross-customer note IDOR)",
    detector: "customer-note-write-route-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "every /admin/customers/:id/notes/:noteId/{edit,pin,unpin,archive,unarchive} route funnels through _noteBelongsToCustomer(req.params.noteId, c.id) (loads via customerNotes.getNote, returns false unless note.customer_id === c.id → clean 404 on a missing/cross-customer note, 400 on a malformed id) before customerNotes.updateNote/pinNote/archiveNote; the note primitive mutates by id alone, so the route owns the ownership decision",
  },
  {
    bugClass: "storefront pre-order reserve route writes a reservation owned by a request-body/query customer_id instead of the session customer — any signed-in shopper (or forged guest POST) could reserve a unit, and at launch land an order, as another customer (cross-account write)",
    detector: "preorder-reserve-route-without-session-customer-pin",
    gate:     "codebase-patterns",
    note:     "the POST /products/:slug/preorder route resolves the reserving customer from the session via _currentCustomer(req) and forwards preorder.reserve({ campaign_slug, customer_id: auth.customer_id, quantity }) — the owner is the session id, never a body/query field; the campaign is resolved from the product's lead SKU (not a client slug), and the cancel route is independently ownership-scoped via _ownedReservation (404 on a foreign/unknown/malformed reservation before cancelReservation)",
  },
  {
    bugClass: "a share / public URL is built by trimming the route path off the canonical URL with a path-stripping .replace, instead of from the request origin — a POST that handles a share action lands on a different path than the link points at, so the trim mangles the link",
    detector: "share-url-from-canonical-path-trim",
    gate:     "codebase-patterns",
    note:     "build the base from new URL(_requestUrls(req).canonical_url).origin (scheme + host, path-independent) rather than canonical_url.replace(/\\/<path>...$/, \"\"); the wishlist share link and the gift-registry share link both took the origin form after the path-trim broke each",
  },
  {
    bugClass: "release tooling calls spawn/spawnSync with an args ARRAY together with shell:true (Node DEP0190) — with a shell the args array is concatenated onto the command line unescaped, so a token with a space/metacharacter is mis-split or injected",
    detector: "spawn-shell-true-with-args-array",
    gate:     "codebase-patterns",
    note:     "when a shell is needed (a Windows .cmd shim — npm/npx/bash) build one per-token-quoted command STRING and pass NO args array; native executables spawn directly with the args array + shell:false",
  },
  {
    bugClass: "order.listForCustomer emits next_cursor keyed off rows.length === limit without peeking one row past the page — the storefront \"Load more orders\" link then advertises a next page that renders empty when the order count is an exact multiple of the limit",
    detector: "order-listforcustomer-cursor-without-peek",
    gate:     "codebase-patterns",
    note:     "fetch limit + 1, set hasMore = fetched.length > limit, slice the page back to limit (so the peeked row is never hydrated), and emit next_cursor only when hasMore — the cursor surfaces in a rendered Next/More control, so a phantom page is shopper-visible",
  },
  {
    bugClass: "customers.list emits next_cursor keyed off rows.length === limit without peeking one row past the page — the admin customer-roster \"Next page\" link then advertises a next page that renders an empty table when the roster size is an exact multiple of the limit",
    detector: "customers-list-cursor-without-peek",
    gate:     "codebase-patterns",
    note:     "fetch limit + 1, set hasMore = fetched.length > limit, slice the page back to limit, and emit next_cursor only when hasMore — the cursor drives the console's rendered \"Next page\" link, so a phantom page is operator-visible",
  },
  {
    bugClass: "loyalty.history emits next_cursor keyed off rows.length === limit without peeking one row past the page — the storefront \"Older activity\" link then advertises a next page that renders empty when the transaction count is an exact multiple of the limit",
    detector: "loyalty-history-cursor-without-peek",
    gate:     "codebase-patterns",
    note:     "fetch limit + 1, set hasMore = r.rows.length > limit, slice the page back to limit, and emit next_cursor only when hasMore — the cursor drives the /account/loyalty \"Older activity\" link, so a phantom page is shopper-visible",
  },
  {
    bugClass: "storeCredit.history emits next_cursor keyed off rows.length === limit without peeking one row past the page — the storefront \"Older activity\" link then advertises a next page that renders empty when the ledger length is an exact multiple of the limit",
    detector: "store-credit-history-cursor-without-peek",
    gate:     "codebase-patterns",
    note:     "fetch limit + 1, set hasMore = r.rows.length > limit, slice the page back to limit, and emit next_cursor only when hasMore — the cursor drives the /account/credit \"Older activity\" link, so a phantom page is shopper-visible",
  },
  {
    bugClass: "admin return-label issuance route hand-rolls an INSERT INTO return_labels instead of composing returnLabels.issueLabel — bypassing the primitive's HTTPS-only label_url gate (b.safeUrl) + approved-only RMA-status refusal, so an unvalidated label_url lands in the column the customer download redirects at (scheme-injection / open-redirect) and a label can be funded against an un-triaged claim",
    detector: "admin-return-label-issue-without-primitive",
    gate:     "codebase-patterns",
    note:     "the POST /admin/returns/:id/label route composes returnLabels.issueLabel({ return_id, carrier, service_level, weight_grams, label_url, tracking_number, cost_minor, currency }) — the primitive owns the carrier/service/tracking bounds, the weight/cost integer shapes, the ISO-4217 currency check, the approved-only refusal, and the HTTPS-only label_url validation (b.safeUrl); the storefront GET /account/returns/:id/label download redirects the shopper at the stored label_url, so the column is a redirect target the route must never populate with a hand-rolled insert. The tracking-update routes (/label/shipped|in-transit|delivered|exception) compose the matching mark-* methods",
  },
];

// The release-pipeline stages each declared gate maps to, plus the
// invocation token the static-gates block in release.js must still
// contain. Assertion (c) reads release.js and checks each token.
var PIPELINE_GATES = {
  "codebase-patterns": "test/layer-0-primitives/codebase-patterns.test.js",
  "currency":          "scripts/check-currency.js",
  "gate-contract":     "scripts/gate-contract.js",
};

// ---- helpers ------------------------------------------------------------

function _readLib() {
  var out = [];
  (function walk(dir) {
    if (path.basename(dir) === "vendor") return;
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    entries.forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".js")) {
        var rel = path.relative(ROOT, p).replace(/\\/g, "/");
        var content = "";
        try { content = fs.readFileSync(p, "utf8"); } catch (_e2) { content = ""; }
        out.push({ rel: rel, content: content });
      }
    });
  })(path.join(ROOT, "lib"));
  return out;
}

// Line number of the first byte offset where `re` matches `content`,
// 1-based, for a paste-ready `file:line` finding. Returns 1 on no match.
function _lineOf(content, re) {
  var m = re.exec(content);
  if (!m) return 1;
  return content.slice(0, m.index).split(/\r?\n/).length;
}

// Every 1-based line at which `re` matches `content`. Walks each
// non-overlapping match so a marked site doesn't mask a later unmarked
// one in the same file (the advisory scan reports each occurrence).
function _matchLines(content, re) {
  var lines = [];
  var flags = re.flags.indexOf("g") === -1 ? re.flags + "g" : re.flags;
  var globalRe = new RegExp(re.source, flags);
  var m;
  while ((m = globalRe.exec(content)) !== null) {
    lines.push(content.slice(0, m.index).split(/\r?\n/).length);
    if (m.index === globalRe.lastIndex) globalRe.lastIndex += 1;   // zero-width guard
  }
  return lines;
}

// Honor the same exception convention the codebase-patterns detectors
// use, so the candidate-gap scan doesn't re-flag a site that already
// carries a documented allow marker for the matching detector class:
//   - file-level header in the first 50 lines:
//       // codebase-patterns:allow-file <class> — <reason>
//   - per-line marker on the match line or up to 2 lines above:
//       ... // allow:<class> — <reason>
// `lineNum` is the 1-based line of the candidate hit.
function _hasAllowMarker(content, lineNum, allowClass) {
  var lines = content.split(/\r?\n/);
  var fileRe = new RegExp("codebase-patterns:allow-file\\s+" + allowClass + "\\b");
  for (var i = 0; i < Math.min(lines.length, 50); i += 1) {
    if (fileRe.test(lines[i])) return true;
  }
  var lineRe = new RegExp("allow:" + allowClass + "\\b");
  var here   = lines[lineNum - 1] || "";
  var above1 = lines[lineNum - 2] || "";
  var above2 = lines[lineNum - 3] || "";
  return lineRe.test(here) || lineRe.test(above1) || lineRe.test(above2);
}

// ---- candidate-gap heuristics ------------------------------------------
//
// Each returns an array of { file, line, why } candidates. A clean tree
// emits none — every known site already names its catalog/SSRF check, so
// the heuristics only fire on a NEW surface that forgot it.

// (1) New outbound webhook-style URL validator without an SSRF compose.
//     The canonical outbound-delivery throw shape is `<ns>: url must be`
//     / `<ns>: endpoint_url must be`. A file carrying that shape AND
//     b.safeUrl.parse, but NOT naming an SSRF composition, is a
//     candidate. Content/canonical URL validators don't carry the
//     outbound throw shape, so they're not flagged.
var WEBHOOK_OUTBOUND_RE = /["'](?:webhooks: url|webhookSubscriptions: endpoint_url) must be /;
var SAFEURL_PARSE_RE = /\bsafeUrl\.parse\s*\(/;
var SSRF_COMPOSE_RE = /textGuard\.hostLabel|ssrfGuard\.classify|ssrfGuard\.checkUrl/;
function _candOutboundUrl(files) {
  var cands = [];
  files.forEach(function (f) {
    // Only the webhook-style outbound delivery validators are in scope:
    // they name an operator/customer-supplied fan-out target. Tie to the
    // webhook canonical throw shape so content-URL validators (which also
    // say "url must be") aren't swept in.
    if (!WEBHOOK_OUTBOUND_RE.test(f.content)) return;
    if (!SAFEURL_PARSE_RE.test(f.content)) return;
    if (SSRF_COMPOSE_RE.test(f.content)) return;        // composes the guard anywhere — covered
    var line = _lineOf(f.content, WEBHOOK_OUTBOUND_RE);
    if (_hasAllowMarker(f.content, line, "outbound-webhook-url-without-ssrf-guard")) return;
    cands.push({
      file: f.rel,
      line: line,
      why:  "outbound webhook-style URL validator without an SSRF composition (textGuard.hostLabel / ssrfGuard.classify)",
    });
  });
  return cands;
}

// (2) New money-binding currency site without the ISO 4217 catalog
//     check. A file that calls a balance-binding issue/grant/credit but
//     names neither money.CURRENCIES nor textGuard.currencyCode is a
//     candidate (the same condition Detector B enforces, surfaced as an
//     advisory the moment a new site appears).
var MONEY_BIND_RE = /\b(?:giftcards\.issue|storeCredit\.(?:issue|grant|adjust)|giftCardLedger\.(?:issue|credit))\s*\(/;
var CATALOG_CHECK_RE = /money\.CURRENCIES|textGuard\.currencyCode/;
function _candMoneyBinding(files) {
  var cands = [];
  files.forEach(function (f) {
    if (!MONEY_BIND_RE.test(f.content)) return;
    if (CATALOG_CHECK_RE.test(f.content)) return;       // composes the catalog check — covered
    var line = _lineOf(f.content, MONEY_BIND_RE);
    if (_hasAllowMarker(f.content, line, "money-binding-currency-without-catalog-check")) return;
    cands.push({
      file: f.rel,
      line: line,
      why:  "money-binding issue/grant/credit without an ISO 4217 catalog check (b.money.CURRENCIES / textGuard.currencyCode)",
    });
  });
  return cands;
}

// (3) New admin 5xx response echoing a raw error message. Mirrors the
//     admin-5xx-echoes-raw-error-message detector shape; surfaced here so
//     a fresh occurrence is flagged for classification even before the
//     detector itself is taught the new file.
var ADMIN_5XX_RAW_RE = /_problem\s*\(\s*res\s*,\s*5\d\d\s*,\s*["'][^"']+["']\s*,\s*(?:\(?\s*e\s*&&\s*e\.message|e\.message|String\s*\(\s*e\s*\))/;
function _candAdmin5xxRaw(files) {
  var cands = [];
  files.forEach(function (f) {
    if (!ADMIN_5XX_RAW_RE.test(f.content)) return;
    _matchLines(f.content, ADMIN_5XX_RAW_RE).forEach(function (line) {
      if (_hasAllowMarker(f.content, line, "admin-5xx-echoes-raw-error-message")) return;
      cands.push({
        file: f.rel,
        line: line,
        why:  "admin 5xx problem-details echoes a raw error message (record server-side; return a generic code)",
      });
    });
  });
  return cands;
}

// ---- the verifier -------------------------------------------------------
//
// Pure: reads the tree, returns { ok, gaps } where each gap is
// { kind, message } with a paste-ready message. No process exit, no
// stdout — the script body below applies the exit-contract.
function verify() {
  var gaps = [];

  // Load the detector catalog. Requiring the test module is
  // side-effect-free off its entry point (no self-spawn, no run()).
  var catalog;
  try {
    catalog = require("../test/layer-0-primitives/codebase-patterns.test.js").KNOWN_ANTIPATTERNS;
  } catch (e) {
    gaps.push({
      kind: "registry-unreadable",
      message: "REGISTRY UNREADABLE  could not load KNOWN_ANTIPATTERNS from codebase-patterns.test.js (" + (e && e.message) + ")",
    });
    return { ok: false, gaps: gaps };
  }
  if (!Array.isArray(catalog)) {
    gaps.push({
      kind: "registry-unreadable",
      message: "REGISTRY UNREADABLE  codebase-patterns.test.js did not export a KNOWN_ANTIPATTERNS array",
    });
    return { ok: false, gaps: gaps };
  }

  var idSet = {};
  var declaredDetectorIds = {};
  catalog.forEach(function (ap) {
    if (ap && ap.id) idSet[ap.id] = ap;
    if (ap && ap.id && ap.bugClassDeclared) declaredDetectorIds[ap.id] = true;
  });

  // (a) every declared detector exists.
  COVERAGE.forEach(function (row) {
    if (!idSet[row.detector]) {
      gaps.push({
        kind: "missing-detector",
        message: "MISSING DETECTOR  " + row.detector +
          "  (declared in gate-contract COVERAGE for \"" + row.bugClass +
          "\", absent from KNOWN_ANTIPATTERNS)",
      });
    }
  });

  // (b) every bugClassDeclared detector has a COVERAGE row.
  var coveredDetectors = {};
  COVERAGE.forEach(function (row) { coveredDetectors[row.detector] = true; });
  Object.keys(declaredDetectorIds).forEach(function (id) {
    if (!coveredDetectors[id]) {
      gaps.push({
        kind: "undeclared-detector",
        message: "UNDECLARED DETECTOR  " + id +
          "  (carries bugClassDeclared:true in KNOWN_ANTIPATTERNS but has no COVERAGE row in gate-contract) " +
          "— add a COVERAGE row naming its bug-class + gate",
      });
    }
  });

  // (c) every gate the registry depends on is still wired into the
  //     release pipeline static-gates block.
  var releaseSrc = "";
  try {
    releaseSrc = fs.readFileSync(path.join(ROOT, "scripts", "release.js"), "utf8");
  } catch (e) {
    gaps.push({
      kind: "release-unreadable",
      message: "PIPELINE UNREADABLE  could not read scripts/release.js (" + (e && e.message) + ")",
    });
  }
  if (releaseSrc) {
    var neededGateNames = {};
    COVERAGE.forEach(function (row) { neededGateNames[row.gate] = true; });
    neededGateNames["gate-contract"] = true;            // this gate must wire itself in
    Object.keys(neededGateNames).forEach(function (gateName) {
      var token = PIPELINE_GATES[gateName];
      if (!token) {
        gaps.push({
          kind: "unknown-gate",
          message: "UNKNOWN GATE  \"" + gateName + "\"  (named in a COVERAGE row but not in gate-contract's PIPELINE_GATES map) " +
            "— add it to PIPELINE_GATES with the release.js invocation token",
        });
        return;
      }
      if (releaseSrc.indexOf(token) === -1) {
        gaps.push({
          kind: "gate-not-wired",
          message: "GATE NOT WIRED  " + gateName + " (\"" + token + "\")  is not invoked in scripts/release.js " +
            "— re-add the `_run(\"node\", [\"" + token + "\"])` line to cmdPrepare's static-gates block",
        });
      }
    });
  }

  // (d) candidate-gap scan over lib/ — advisory, hard-fail only when a
  //     candidate is genuinely undeclared (a clean tree emits none).
  var files = _readLib();
  var candidates = []
    .concat(_candOutboundUrl(files))
    .concat(_candMoneyBinding(files))
    .concat(_candAdmin5xxRaw(files));
  candidates.forEach(function (c) {
    gaps.push({
      kind: "candidate",
      message: "CANDIDATE GAP  " + c.file + ":" + c.line + "  " + c.why +
        "  -> add a detector + a COVERAGE row, or compose the named guard",
    });
  });

  return { ok: gaps.length === 0, gaps: gaps };
}

module.exports = { verify: verify, COVERAGE: COVERAGE, PIPELINE_GATES: PIPELINE_GATES };

// ---- run ----------------------------------------------------------------
if (require.main === module) {
  var result = verify();
  var n = COVERAGE.length;
  process.stdout.write("[gate-contract] verified " + n + " declared bug-class coverage row(s)\n");
  if (result.ok) {
    process.stdout.write("[gate-contract] OK — every declared bug-class maps to a live detector + an enforced gate; no candidate gaps\n");
    process.exit(0);
  }
  process.stderr.write("\n");
  result.gaps.forEach(function (g) { process.stderr.write(g.message + "\n"); });
  process.stderr.write("\n");
  if (ALLOW_GAPS) {
    process.stderr.write("[gate-contract] " + result.gaps.length + " gap(s) — RELEASE_ALLOW_GATE_GAPS=1 set, continuing (deferred).\n");
    process.exit(0);
  }
  process.stderr.write("[gate-contract] FAIL — " + result.gaps.length + " gap(s). Fix the line(s) above, or set RELEASE_ALLOW_GATE_GAPS=1 to consciously defer.\n");
  process.exit(1);
}
