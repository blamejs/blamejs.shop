"use strict";
/**
 * RSS feed render — worker/render/feed.js.
 *
 * The blog feed is edge-served: worker/index.js paints /feed.xml via
 * worker/render/feed.js#renderFeed. Two hazards this pins:
 *
 *   1. Items are spliced into the channel template at a literal
 *      RAW_ITEMS_PLACEHOLDER token. `String.replace(token, string)` gives
 *      the replacement string's `$` sequences special meaning — `$&`,
 *      `` $` ``, `$'`, `$1` — so a published post whose title or body
 *      carries a `$`-sequence corrupts the feed (and `` $` `` splices the
 *      channel head into the item). The renderer must splice the items
 *      LITERALLY (replacer-function form / spliceRaw).
 *
 *   2. The internal `author_id` (an operator/user id) must never reach
 *      the public `<author>` element — the blog page renderers
 *      deliberately suppress it in favour of the shop name.
 *
 * DEPLOY-BRICKER: this test imports worker/render/feed.js, which is
 * EXCLUDED from the container build context (.dockerignore). The
 * fs.existsSync guard + early return BEFORE the import() is mandatory — an
 * unguarded worker import fails the in-image `RUN node test/smoke.js`,
 * fails the Docker build, and bricks every container deploy. Copied from
 * blog-render-parity.test.js.
 */

var nodePath   = require("node:path");
var nodeFs     = require("node:fs");
var nodeUrl    = require("node:url");
var nodeModule = require("node:module");

var helpers = require("../helpers");
var check   = helpers.check;

var _jsonHookRegistered = false;
function _registerJsonHook() {
  if (_jsonHookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _jsonHookRegistered = true;
}

async function _run() {
  // worker/ is excluded from the container build context, so the edge
  // renderer isn't present in the in-image smoke gate. Skip there; the
  // full-tree CI run (worker/ present) covers it.
  var edgePath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "feed.js");
  if (!nodeFs.existsSync(edgePath)) return;
  _registerJsonHook();
  var feed = await import(nodeUrl.pathToFileURL(edgePath).href);

  // ---- P2-F: a `$`-bearing title / body must not corrupt the feed ------
  var hostileXml = feed.renderFeed({
    shopName: "Acme",
    origin:   "https://shop.example",
    articles: [{
      slug:             "dollars",
      // Every special replace sequence: $&, $`, $', $1, $$.
      title:            "Save $& on $` deals — $' price $1 and $$5 off",
      body:             "A body with a $` dollar-backtick and a $& ampersand-dollar.",
      meta_description: "",
      published_at:     1700000000000,
      author_id:        "11111111-1111-4111-8111-111111111111",
    }],
  });

  // The channel head appears exactly once — a `` $` `` splice would have
  // duplicated the whole <channel> block inside the item title.
  var channelOpens = (hostileXml.match(/<channel>/g) || []).length;
  check("feed: single <channel> block (no $`-splice of the head)", channelOpens === 1);
  check("feed: placeholder token fully consumed", hostileXml.indexOf("RAW_ITEMS_PLACEHOLDER") === -1);
  check("feed: exactly one <item>", (hostileXml.match(/<item>/g) || []).length === 1);
  // The literal `$&`/`$'`/`$1`/`$$` sequences survive (escaped where the
  // char is special to XML — `&` → `&amp;`, `'` → `&#x27;`).
  check("feed: $& survives literally (escaped &)", hostileXml.indexOf("Save $&amp; on") !== -1);
  check("feed: $` survives literally",             hostileXml.indexOf("on $` deals") !== -1);
  check("feed: $1 survives literally",             hostileXml.indexOf("price $1") !== -1);
  check("feed: $$ survives literally",             hostileXml.indexOf("and $$5 off") !== -1);
  // Well-formed: the title closes properly (the corruption put a raw
  // `<?xml ...` and an unclosed tag inside the title).
  check("feed: title not corrupted by a nested xml prolog",
    hostileXml.indexOf("<title>Save $&amp; on $` deals — $&#x27; price $1 and $$5 off</title>") !== -1);

  // ---- P3-G: author_id must not leak; shop name is the byline ----------
  check("feed: internal author_id not in output",
    hostileXml.indexOf("11111111-1111-4111-8111-111111111111") === -1);
  check("feed: <author> is the shop name", hostileXml.indexOf("<author>Acme</author>") !== -1);

  // ---- baseline: a clean multi-item feed renders well-formed -----------
  var cleanXml = feed.renderFeed({
    shopName: "Test Shop",
    origin:   "https://test.example",
    articles: [
      { slug: "a", title: "First post", body: "Body A", meta_description: "Lede A", published_at: 1700000000000, author_id: "op-1" },
      { slug: "b", title: "Second post", body: "Body B", meta_description: "", published_at: 1699000000000, author_id: "op-2" },
    ],
  });
  check("feed: two items render", (cleanXml.match(/<item>/g) || []).length === 2);
  check("feed: both authors are the shop name",
    (cleanXml.match(/<author>Test Shop<\/author>/g) || []).length === 2);
  check("feed: neither op id leaks", cleanXml.indexOf("op-1") === -1 && cleanXml.indexOf("op-2") === -1);
  check("feed: item links resolve against origin", /<link>https:\/\/test\.example\/blog\/a<\/link>/.test(cleanXml));
  check("feed: meta_description used when present", cleanXml.indexOf("Lede A") !== -1);
  check("feed: body slice used when meta_description empty", cleanXml.indexOf("Body B") !== -1);
  check("feed: prolog appears exactly once", (cleanXml.match(/<\?xml /g) || []).length === 1);

  console.log("ok - feed-render (" + helpers.getChecks() + " checks)");
}

module.exports = { run: _run };
