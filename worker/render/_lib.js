// Worker render helpers compose blamejs primitives through the
// `worker/b.js` adapter. Single import surface; the adapter is the
// validated bridge between the Worker substrate and the framework's
// leaf modules.
import b from "../b.js";

export function escapeHtml(s) {
  return b.template.escapeHtml(s);
}

export function escapeAttr(s) {
  return b.template.escapeHtml(s);
}

var PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function _isPlainObject(o) {
  if (o == null || typeof o !== "object") return false;
  var proto = Object.getPrototypeOf(o);
  return proto === null || proto === Object.prototype;
}

// Strict `{{name}}` substitution with HTML-escape per substitution
// and refusal of unknown / unused placeholders. The framework's
// `b.template.render` interpreter takes a path + viewsDir (file-
// backed) so doesn't apply to inline-string templates; we use its
// `escapeHtml` per-value escape for byte-identical output.
export function renderTemplate(tpl, vars) {
  if (typeof tpl !== "string") {
    throw new TypeError("renderTemplate: tpl must be a string, got " + (tpl === null ? "null" : typeof tpl));
  }
  if (!_isPlainObject(vars)) {
    throw new TypeError("renderTemplate: vars must be a plain object, got " + (vars === null ? "null" : typeof vars));
  }
  var seen = new Set();
  var out = tpl.replace(PLACEHOLDER_RE, function (_match, key) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new TypeError("renderTemplate: template references unknown variable {{" + key + "}}");
    }
    seen.add(key);
    var v = vars[key];
    if (v == null) return "";
    return b.template.escapeHtml(String(v));
  });
  var keys = Object.keys(vars);
  for (var i = 0; i < keys.length; i += 1) {
    if (!seen.has(keys[i])) {
      throw new TypeError("renderTemplate: template did not reference variable " + JSON.stringify(keys[i]));
    }
  }
  return out;
}

// HTML minifier — collapses inter-tag whitespace runs the templates
// carry for source readability. Preserves text content untouched
// (text never carries `>\s+<` boundaries), and explicitly skips
// `<pre>`, `<script>`, `<style>`, `<textarea>`, `<code>` blocks
// where whitespace IS semantically meaningful.
var WHITESPACE_PRESERVE_TAGS = ["pre", "script", "style", "textarea", "code"];
var PRESERVE_RE = new RegExp(
  "<(" + WHITESPACE_PRESERVE_TAGS.join("|") + ")\\b[^>]*>[\\s\\S]*?</\\1>",
  "gi"
);

export function minifyHtml(html) {
  if (typeof html !== "string") return html;
  // Stash preserve-tag blocks behind sentinel tokens so the collapse
  // pass doesn't touch them. The sentinel uses control-character
  // ranges that can't appear in operator-rendered HTML.
  var stashed = [];
  var stashedSrc = html.replace(PRESERVE_RE, function (m) {
    var idx = stashed.length;
    stashed.push(m);
    return "PRESERVE_" + idx + "";
  });
  // Collapse `> ... <` runs (whitespace between tags) to a single
  // space when the run contains a newline. Single-line indentation
  // shifts (e.g. `<a>...</a>  <b>` inline) stays intact.
  var collapsed = stashedSrc.replace(/>\s*\n\s*</g, "><");
  // Reinstate the preserved blocks.
  return collapsed.replace(/PRESERVE_(\d+)/g, function (_m, i) {
    return stashed[Number(i)];
  });
}

export function formatPrice(minorUnits, currency) {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError("formatPrice: minorUnits must be an integer, got " + JSON.stringify(minorUnits));
  }
  if (typeof currency !== "string") {
    throw new TypeError("formatPrice: currency must be a string, got " + (currency === null ? "null" : typeof currency));
  }
  return b.money.of(BigInt(minorUnits), currency).format("en-US");
}
