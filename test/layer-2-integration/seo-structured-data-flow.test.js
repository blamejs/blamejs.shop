"use strict";
/**
 * PDP QAPage structured data (SEO-5).
 *
 * The product page emits a `QAPage` JSON-LD block built from the published
 * Q&A threads — the question + its answers — surfacing them in Google's Q&A
 * rich result. Both render substrates (container `lib/storefront.js` and the
 * edge `worker/render/product.js`) emit byte-identical QAPage JSON-LD for
 * the same question set, going through the `_jsonLdScript` / `jsonLdScript`
 * serializer (JSON.stringify + `</script` rewrite), NOT manual HTML concat.
 *
 * Contracts:
 *   - a product with ≥1 answered question emits one QAPage block whose parse
 *     carries Question + acceptedAnswer;
 *   - a product with zero answered questions emits NO QAPage block (Google
 *     rejects an answerless QAPage);
 *   - a question body weaponising `</script>` is neutralised by the
 *     serializer (the rendered block contains the escaped `<\/script`, never
 *     a raw `</script>` that would break out);
 *   - the edge QAPage JSON-LD is byte-identical to the container's.
 *
 * Pure render functions — no DB, no HTTP. The edge ESM module loads via
 * dynamic import behind an `fs.existsSync` guard preceding the import.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var path       = require("node:path");
var fs         = require("node:fs");
var nodeModule = require("node:module");
var nodeUrl    = require("node:url");

var bShop    = require("../../lib");
var helpers  = require("../helpers");
var check    = helpers.check;
var manifest = require("../../lib/asset-manifest.json");

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

// Extract the single `<script type="application/ld+json">…</script>` block
// whose payload parses to the given @type, returning the parsed object (or
// null if none matches).
function _jsonLdOfType(html, type) {
  var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var raw = m[1].replace(/<\\\/script/g, "</script");
    var obj;
    try { obj = JSON.parse(raw); } catch (_e) { continue; }
    if (obj && obj["@type"] === type) return obj;
  }
  return null;
}

// The raw JSON-LD source bytes for a given @type (un-parsed), so the
// breakout + parity assertions can compare the on-the-wire text.
function _jsonLdRawOfType(html, type) {
  var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var raw = m[1];
    var parsed;
    try { parsed = JSON.parse(raw.replace(/<\\\/script/g, "</script")); } catch (_e) { continue; }
    if (parsed && parsed["@type"] === type) return raw;
  }
  return null;
}

var QA_ANSWERED = [
  { body: "Does it ship internationally?", answers: [
    { body: "Yes — worldwide, tracked.", is_operator: 1, pinned: 1 },
    { body: "I got mine in Berlin in 3 days.", author: "customer" },
  ] },
  { body: "Is it machine washable?", answers: [
    { body: "Cold wash, hang dry.", is_operator: 1 },
  ] },
];

var QA_UNANSWERED = [
  { body: "Any plans for a larger size?", answers: [] },
];

// A question body that tries to break out of the <script> block.
var QA_BREAKOUT = [
  { body: "</script><img src=x onerror=alert(1)>", answers: [
    { body: "Nice try </script> still safe", is_operator: 1 },
  ] },
];

function _renderContainer(qa) {
  return bShop.storefront.renderProduct({
    product:  { slug: "widget-pro", title: "Widget Pro", description: "desc" },
    variants: [{ id: "v1", sku: "WDG-1", title: "Default", options: {} }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
    shop_name: "Acme",
    qa_questions: qa,
  });
}

async function _run() {
  // ---- container: answered Q&A → QAPage with acceptedAnswer ------------
  var cAnswered = _renderContainer(QA_ANSWERED);
  var cQa = _jsonLdOfType(cAnswered, "QAPage");
  check("container QAPage present",            cQa !== null);
  check("container QAPage mainEntity is Question",
    cQa && Array.isArray(cQa.mainEntity) && cQa.mainEntity[0]["@type"] === "Question");
  check("container QAPage acceptedAnswer text",
    cQa && cQa.mainEntity[0].acceptedAnswer && cQa.mainEntity[0].acceptedAnswer.text === "Yes — worldwide, tracked.");
  check("container QAPage suggestedAnswer (2nd answer)",
    cQa && Array.isArray(cQa.mainEntity[0].suggestedAnswer) &&
    cQa.mainEntity[0].suggestedAnswer[0].text === "I got mine in Berlin in 3 days.");
  check("container QAPage answerCount",        cQa && cQa.mainEntity[0].answerCount === 2);
  // Single-answer question → acceptedAnswer, no suggestedAnswer.
  check("container QAPage single-answer no suggested",
    cQa && cQa.mainEntity[1].acceptedAnswer.text === "Cold wash, hang dry." &&
    cQa.mainEntity[1].suggestedAnswer === undefined);

  // ---- container: zero answered questions → NO QAPage ------------------
  var cUnanswered = _renderContainer(QA_UNANSWERED);
  check("container no QAPage when no answers", _jsonLdOfType(cUnanswered, "QAPage") === null);
  var cNoQa = _renderContainer([]);
  check("container no QAPage when no questions", _jsonLdOfType(cNoQa, "QAPage") === null);

  // ---- container: </script> breakout payload neutralised --------------
  var cBreakout = _renderContainer(QA_BREAKOUT);
  var cBreakoutRaw = _jsonLdRawOfType(cBreakout, "QAPage");
  check("container breakout QAPage present",   cBreakoutRaw !== null);
  check("container breakout escaped </script", cBreakoutRaw.indexOf("<\\/script") !== -1);
  check("container breakout no raw </script>",  cBreakoutRaw.indexOf("</script>") === -1);
  // The payload survives as data (parses back to the original string).
  var cBreakoutObj = _jsonLdOfType(cBreakout, "QAPage");
  check("container breakout payload preserved as data",
    cBreakoutObj && cBreakoutObj.mainEntity[0].name === "</script><img src=x onerror=alert(1)>");

  // ---- edge half (worker/) — guarded by fs.existsSync -----------------
  var productPath = path.resolve(__dirname, "..", "..", "worker", "render", "product.js");
  if (!fs.existsSync(productPath)) {
    // worker/ excluded from the container build context — the container
    // assertions above still pin the contract in the in-image smoke.
    return;
  }
  _registerJsonHook();
  var edgeProduct = await import(nodeUrl.pathToFileURL(productPath).href);

  function _renderEdge(qa) {
    return edgeProduct.renderProduct({
      product:  { slug: "widget-pro", title: "Widget Pro", description: "desc" },
      variants: [{ id: "v1", sku: "WDG-1", title: "Default", options: {} }],
      prices:   { v1: { amount_minor: 2999, currency: "USD" } },
      shopName: "Acme",
      version:  manifest.version,
      qaQuestions: qa,
    });
  }

  var eAnswered = _renderEdge(QA_ANSWERED);
  var eQa = _jsonLdOfType(eAnswered, "QAPage");
  check("edge QAPage present",                 eQa !== null);
  check("edge QAPage acceptedAnswer text",
    eQa && eQa.mainEntity[0].acceptedAnswer && eQa.mainEntity[0].acceptedAnswer.text === "Yes — worldwide, tracked.");
  check("edge no QAPage when no answers",      _jsonLdOfType(_renderEdge(QA_UNANSWERED), "QAPage") === null);

  // breakout neutralised at the edge too
  var eBreakoutRaw = _jsonLdRawOfType(_renderEdge(QA_BREAKOUT), "QAPage");
  check("edge breakout escaped </script",      eBreakoutRaw.indexOf("<\\/script") !== -1);
  check("edge breakout no raw </script>",        eBreakoutRaw.indexOf("</script>") === -1);

  // ---- parity: edge QAPage JSON-LD byte-identical to container ---------
  check("QAPage JSON-LD byte-identical across substrates",
    _jsonLdRawOfType(cAnswered, "QAPage") === _jsonLdRawOfType(eAnswered, "QAPage"));
}

module.exports = { run: _run };
