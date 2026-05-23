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

export function formatPrice(minorUnits, currency) {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError("formatPrice: minorUnits must be an integer, got " + JSON.stringify(minorUnits));
  }
  if (typeof currency !== "string") {
    throw new TypeError("formatPrice: currency must be a string, got " + (currency === null ? "null" : typeof currency));
  }
  return b.money.of(BigInt(minorUnits), currency).format("en-US");
}
