/* Search-suggest island.
 *
 * The header search box is server-rendered on every storefront chrome page
 * as a plain GET form to /search — it works with JS off and on every page.
 * This island upgrades it: as the shopper types, it fetches the endpoint
 * named in the input's `data-suggest` attribute (/search/suggestions) and
 * renders an autocomplete dropdown under the input with up to three labeled
 * groups — product matches, popular searches, and operator-curated featured
 * suggestions. Picking a product or featured row navigates; picking a
 * popular query fills the box and submits the existing form.
 *
 * The endpoint returns plain data (no per-session content), so its 30s
 * shared cache is safe. When the endpoint isn't mounted the fetch 404s and
 * the island stays dormant — the box remains a normal search form.
 *
 * Trust + CSP: this is an external `'self'` script (the strict
 * `script-src 'self'` blocks inline). EVERY node is built with
 * createElement + textContent — never innerHTML — because the data carries
 * user-typed query strings (the popular-search group) that must never reach
 * an HTML sink. Hrefs are checked for a safe scheme before they're set.
 */
(function () {
  "use strict";

  var MIN_CHARS    = 2;     // hide the dropdown below this many typed chars
  var DEBOUNCE_MS  = 200;   // wait this long after the last keystroke to fetch
  var LISTBOX_ID   = "site-search-suggest";

  var input = document.getElementById("site-search-q");
  if (!input) return;
  var endpoint = input.getAttribute("data-suggest");
  if (!endpoint) return;
  var form = input.form;

  // The dropdown panel — a listbox positioned under the input. Built once,
  // appended next to the input, populated/cleared as the shopper types.
  var box = document.createElement("div");
  box.id = LISTBOX_ID;
  box.className = "search-suggest";
  box.setAttribute("role", "listbox");
  box.hidden = true;
  // Anchor the panel on the search FORM (`.site-search`, a positioned
  // wrapper) rather than the inner pill — the pill clips overflow, which
  // would hide the dropdown. Fall back to the input's immediate parent.
  var anchor = form || input.parentNode;
  if (anchor) anchor.appendChild(box);
  else return;

  var debounceTimer = null;
  var inflight       = null;   // AbortController for the current request
  var items          = [];     // flat list of selectable option elements
  var activeIndex    = -1;     // aria-activedescendant pointer, -1 = none
  var optionSeq      = 0;      // unique id suffix for option elements

  function setExpanded(on) {
    input.setAttribute("aria-expanded", on ? "true" : "false");
  }

  function close() {
    box.hidden = true;
    while (box.firstChild) box.removeChild(box.firstChild);
    items = [];
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    setExpanded(false);
  }

  function abortInflight() {
    if (inflight) { try { inflight.abort(); } catch (_e) { /* ignore — an already-settled fetch has nothing to abort */ } inflight = null; }
  }

  // Only same-origin absolute paths and http(s) URLs are followed. A
  // javascript:/data: href (or anything that isn't a plain navigable link)
  // is dropped — the row renders as plain, non-linking text. The featured
  // link_url is operator-curated and the primitive already refuses unsafe
  // schemes at write time; this is defense in depth on the render side.
  function safeHref(url) {
    if (typeof url !== "string" || !url.length) return null;
    if (url.charAt(0) === "/" && url.charAt(1) !== "/") return url; // rooted path
    if (/^https?:\/\//i.test(url)) return url;
    return null;
  }

  function makeGroupHeading(label) {
    var h = document.createElement("div");
    h.className = "search-suggest__heading";
    h.setAttribute("role", "presentation");
    h.textContent = label;
    return h;
  }

  // Build one selectable option. `onChoose` runs when it's clicked or
  // chosen via Enter. `href`, when present, also makes the row a real
  // anchor so middle-click / open-in-new-tab works.
  function makeOption(text, href, onChoose) {
    var el;
    if (href) {
      el = document.createElement("a");
      el.setAttribute("href", href);
    } else {
      el = document.createElement("div");
    }
    el.className = "search-suggest__option";
    el.id = "search-suggest-opt-" + (optionSeq++);
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", "false");
    el.textContent = text;
    el.addEventListener("mousedown", function (ev) {
      // mousedown (not click) so the choice registers before the input's
      // blur tears the panel down.
      ev.preventDefault();
      onChoose();
    });
    return el;
  }

  function highlight(index) {
    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].setAttribute("aria-selected", "false");
      items[activeIndex].classList.remove("search-suggest__option--active");
    }
    activeIndex = index;
    if (activeIndex >= 0 && items[activeIndex]) {
      var el = items[activeIndex];
      el.setAttribute("aria-selected", "true");
      el.classList.add("search-suggest__option--active");
      input.setAttribute("aria-activedescendant", el.id);
      if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function render(data) {
    while (box.firstChild) box.removeChild(box.firstChild);
    items = [];
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");

    var products = (data && Array.isArray(data.products)) ? data.products : [];
    var queries  = (data && Array.isArray(data.queries))  ? data.queries  : [];
    var featured = (data && Array.isArray(data.featured)) ? data.featured : [];

    var i, opt;

    if (products.length) {
      box.appendChild(makeGroupHeading("Products"));
      for (i = 0; i < products.length; i += 1) {
        (function (p) {
          var title = (p && typeof p.title === "string") ? p.title : (p && p.name) || "";
          var slug  = p && (p.slug || p.handle);
          var href  = slug ? safeHref("/products/" + encodeURIComponent(slug)) : null;
          if (!title) return;
          opt = makeOption(title, href, function () {
            if (href) window.location.assign(href);
          });
          box.appendChild(opt);
          items.push(opt);
        })(products[i]);
      }
    }

    if (queries.length) {
      box.appendChild(makeGroupHeading("Popular searches"));
      for (i = 0; i < queries.length; i += 1) {
        (function (qrow) {
          var term = qrow && (qrow.query_normalized || qrow.query);
          if (typeof term !== "string" || !term.length) return;
          opt = makeOption(term, null, function () {
            input.value = term;
            if (form) {
              if (typeof form.requestSubmit === "function") form.requestSubmit();
              else form.submit();
            }
          });
          box.appendChild(opt);
          items.push(opt);
        })(queries[i]);
      }
    }

    if (featured.length) {
      box.appendChild(makeGroupHeading("Featured"));
      for (i = 0; i < featured.length; i += 1) {
        (function (f) {
          var label = f && (f.display_text || f.prefix);
          if (typeof label !== "string" || !label.length) return;
          var href = safeHref(f && f.link_url);
          opt = makeOption(label, href, function () {
            if (href) window.location.assign(href);
          });
          box.appendChild(opt);
          items.push(opt);
        })(featured[i]);
      }
    }

    if (items.length) {
      box.hidden = false;
      setExpanded(true);
    } else {
      close();
    }
  }

  function fetchSuggestions(q) {
    abortInflight();
    var controller = (typeof AbortController === "function") ? new AbortController() : null;
    inflight = controller;
    var url = endpoint + "?q=" + encodeURIComponent(q);
    fetch(url, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller ? controller.signal : undefined,
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        inflight = null;
        // The shopper may have cleared / shortened the box while the
        // request was in flight — only render if the query still qualifies.
        if (input.value.trim().length < MIN_CHARS) { close(); return; }
        if (!data) { close(); return; }
        render(data);
      })
      .catch(function () { /* aborted or network error — leave the box as-is */ });
  }

  function onInput() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    var q = input.value.trim();
    if (q.length < MIN_CHARS) { abortInflight(); close(); return; }
    debounceTimer = setTimeout(function () { fetchSuggestions(q); }, DEBOUNCE_MS);
  }

  input.addEventListener("input", onInput);

  input.addEventListener("keydown", function (ev) {
    if (box.hidden || !items.length) {
      // Esc with the box already closed does nothing special; let other
      // keys through (Enter submits the form normally).
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      highlight(activeIndex + 1 >= items.length ? 0 : activeIndex + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      highlight(activeIndex - 1 < 0 ? items.length - 1 : activeIndex - 1);
    } else if (ev.key === "Enter") {
      if (activeIndex >= 0 && items[activeIndex]) {
        ev.preventDefault();
        // Re-dispatch the active option's choose handler via a synthetic
        // mousedown so a keyboard pick and a pointer pick share one path.
        var el = items[activeIndex];
        var md = document.createEvent ? document.createEvent("MouseEvents") : null;
        if (md && md.initEvent) { md.initEvent("mousedown", true, true); el.dispatchEvent(md); }
        else { el.click(); }
      }
      // No active option: let the form submit normally with the typed query.
    } else if (ev.key === "Escape") {
      close();
    }
  });

  // Dismiss on outside click and on blur (the blur is deferred a tick so a
  // mousedown on an option lands first).
  input.addEventListener("blur", function () {
    setTimeout(close, 120);
  });
  document.addEventListener("click", function (ev) {
    if (ev.target !== input && !box.contains(ev.target)) close();
  });
})();
