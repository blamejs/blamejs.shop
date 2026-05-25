"use strict";
/**
 * @module shop.theme
 * @title  Theme — file-backed templates with fallback resolution
 *
 * @intro
 *   Operators ship a custom storefront look without forking
 *   `lib/storefront.js`. The theme primitive defines a directory
 *   layout under `themes/<name>/` and a fallback chain so a partial
 *   override is enough — any view not present in the active theme
 *   falls back to the bundled `themes/default/` set.
 *
 *   Composition: each theme owns one `b.template` engine instance
 *   bound to its own directory. `render(viewName, data)` tries the
 *   active engine first; a missing-view error transparently falls
 *   back to the default engine. Both engines run with strict HTML
 *   escape on `{{ expr }}` and raw passthrough on `{{{ expr }}}`.
 *
 *   View names + theme names are slug-shaped (`^[a-z0-9][a-z0-9-]{0,63}$`)
 *   so request-derived input that reaches `render()` can't path-
 *   traverse out of `themesDir`. The underlying `b.template` engine
 *   also rejects `..` and NUL inside view names as defense in depth.
 *
 *   Asset URLs: `assetUrl("css/main.css")` resolves to
 *   `/assets/themes/<name>/css/main.css`. Operators upload theme
 *   assets to R2 under the same prefix; the Worker's static asset
 *   pass-through serves them. Theme HTML references assets via this
 *   helper so a theme swap relocates URLs automatically.
 *
 *   When the active theme directory is missing entirely (typo in
 *   `SHOP_THEME`, undeployed theme), `create()` throws `ThemeError`
 *   at boot time — operators don't ship a broken storefront.
 */

var b = require("./index").framework;

// `b.template.create({ viewsDir })` itself validates that the views
// directory exists, refuses `..` / NUL inside view names, and throws
// "template: view not found: <name>" when a render() call lands on a
// missing file. The theme primitive composes on that surface — we
// catch the missing-view throw and walk the fallback chain rather
// than duplicating an `fs.existsSync` check in this layer.
var SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
var MISSING_VIEW_RE = /template: view not found:/;

function ThemeError(message) {
  var e = new Error(message);
  e.name = "ThemeError";
  return e;
}

function _validateSlug(label, value) {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw ThemeError("theme: " + label + " must match /^[a-z0-9][a-z0-9-]{0,63}$/, got " + JSON.stringify(value));
  }
}

function _joinPath(parent, child) {
  // Trim trailing separator on parent so the join yields a single sep.
  var p = parent;
  while (p.length > 0 && (p.charAt(p.length - 1) === "/" || p.charAt(p.length - 1) === "\\")) {
    p = p.slice(0, p.length - 1);
  }
  return p + "/" + child;
}

function _tryCreateEngine(viewsDir) {
  // Wrap b.template.create — when the directory is missing it throws
  // "template: viewsDir does not exist: <path>". We convert that to
  // ThemeError so the caller's contract is one error type.
  try {
    return b.template.create({ viewsDir: viewsDir });
  } catch (e) {
    var msg = e && e.message || "";
    if (msg.indexOf("viewsDir does not exist") !== -1) {
      throw ThemeError("theme.create: theme directory not found: " + viewsDir);
    }
    throw e;
  }
}

/**
 * @primitive shop.theme.create
 * @signature shop.theme.create(opts)
 * @since     0.0.32
 *
 * Builds a theme loader bound to `<themesDir>/<name>` with a fallback
 * engine bound to `<themesDir>/<fallback>` (default "default"). The
 * returned object exposes `render(viewName, data)`, `exists(viewName)`,
 * and `assetUrl(path)`.
 *
 * View lookup walks the active theme first, then the fallback chain.
 * A view present in neither throws `ThemeError`. The fallback theme's
 * directory MUST exist — the bundled `themes/default/` is the
 * baseline reference set the storefront expects to find.
 *
 * @opts
 *   themesDir:   string,   // required — parent directory of theme dirs
 *   name:        string,   // required — active theme slug
 *   fallback:    string,   // optional, default "default"
 *
 * @example
 *   var theme = shop.theme.create({
 *     themesDir: "./themes",
 *     name:      "acme",
 *   });
 *   var html = theme.render("home", { products: [...] });
 *   theme.assetUrl("css/main.css");
 *   // → "/assets/themes/acme/css/main.css"
 */
function create(opts) {
  opts = opts || {};
  if (!opts.themesDir || typeof opts.themesDir !== "string") {
    throw ThemeError("theme.create: opts.themesDir required (string)");
  }
  _validateSlug("name", opts.name);
  var fallbackName = opts.fallback == null ? "default" : opts.fallback;
  _validateSlug("fallback", fallbackName);

  var activeDir   = _joinPath(opts.themesDir, opts.name);
  var fallbackDir = _joinPath(opts.themesDir, fallbackName);

  // _tryCreateEngine surfaces missing-directory as ThemeError; both
  // calls run at create time so an operator with a typo in SHOP_THEME
  // (or an undeployed theme dir) fails the boot rather than the first
  // customer request.
  var activeEngine = _tryCreateEngine(activeDir);
  var fallbackEngine = activeDir === fallbackDir
    ? activeEngine
    : _tryCreateEngine(fallbackDir);

  function _isMissingView(err) {
    return err && err.message && MISSING_VIEW_RE.test(err.message);
  }

  function exists(viewName) {
    _validateSlug("viewName", viewName);
    // Compile through the engine; cache hit on the second call. A
    // missing-view error is converted to "false"; any other error
    // (template syntax) propagates so operators see real bugs.
    try { activeEngine.compile(viewName);   return true; }
    catch (e) { if (!_isMissingView(e)) throw e; }
    if (fallbackEngine === activeEngine) return false;
    try { fallbackEngine.compile(viewName); return true; }
    catch (e) { if (!_isMissingView(e)) throw e; return false; }
  }

  function render(viewName, data) {
    _validateSlug("viewName", viewName);
    try { return activeEngine.render(viewName, data || {}); }
    catch (e) {
      if (!_isMissingView(e)) throw e;
    }
    if (fallbackEngine === activeEngine) {
      throw ThemeError("theme.render: view not found in '" + opts.name + "': " + viewName);
    }
    try { return fallbackEngine.render(viewName, data || {}); }
    catch (e) {
      if (_isMissingView(e)) {
        throw ThemeError("theme.render: view not found in '" + opts.name +
          "' or fallback '" + fallbackName + "': " + viewName);
      }
      throw e;
    }
  }

  function assetUrl(p) {
    if (typeof p !== "string" || p.length === 0) {
      throw ThemeError("theme.assetUrl: path required (non-empty string)");
    }
    if (p.indexOf("..") !== -1 || p.indexOf("\0") !== -1) {
      throw ThemeError("theme.assetUrl: path contains forbidden character: " + JSON.stringify(p));
    }
    var clean = p.charAt(0) === "/" ? p.slice(1) : p;
    return "/assets/themes/" + opts.name + "/" + clean;
  }

  return {
    name:       opts.name,
    fallback:   fallbackName,
    render:     render,
    exists:     exists,
    assetUrl:   assetUrl,
  };
}

module.exports = {
  create:     create,
  ThemeError: ThemeError,
};
