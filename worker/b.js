// blamejs adapter for the Cloudflare Worker substrate.
//
// The framework's main entry (`lib/vendor/blamejs/index.js`) sets
// `node:tls.DEFAULT_MIN_VERSION = "TLSv1.3"` at module load, which has
// no Worker analogue (V8 isolates have no TCP). Instead of importing
// the entry, we import the Worker-safe leaf modules directly and
// re-export them under the canonical `b.<namespace>` shape so Worker
// code reads identically to server code.
//
// Surface re-exported:
//   b.template    — escapeHtml + the strict {{name}} interpreter
//   b.money       — Money / of / fromMinorUnits / format
//   b.crypto      — timingSafeEqual, sha3Hash, hmac, generateBytes,
//                   namespaceHash (anything that doesn't reach for
//                   node:tls or noble-ciphers' worker-incompatible
//                   parts; tested via worker-b-loadable smoke)
//   b.uuid        — v4 / v7 / guard
//   b.safeUrl     — build / parse / validate
//   b.safeSql     — validateIdentifier / quoteIdentifier
//   b.fsm         — define / transition
//   b.webhook     — verify (Stripe HMAC-SHA256 inbound signature).
//                   The webhook module resolves its outbound HTTP
//                   client + delivery dispatcher lazily (send path
//                   only), so importing it for inbound verification
//                   pulls no Node networking at load — Worker-safe.
//
// This file is the single point of validation: if a vendor refresh
// breaks a leaf-module's Worker compatibility, the worker-b-loadable
// smoke test catches it before deploy.
//
// New Worker code MUST import from here (`import b from "./b.js"`)
// rather than reaching for leaf modules under `lib/vendor/blamejs/lib/`
// directly — the codebase-patterns detector
// `worker-direct-vendor-import` enforces it.

import bCrypto     from "../lib/vendor/blamejs/lib/crypto.js";
import bTemplate   from "../lib/vendor/blamejs/lib/template.js";
import bMoney      from "../lib/vendor/blamejs/lib/money.js";
import bUuid       from "../lib/vendor/blamejs/lib/uuid.js";
import bSafeUrl    from "../lib/vendor/blamejs/lib/safe-url.js";
import bSafeSql    from "../lib/vendor/blamejs/lib/safe-sql.js";
import bFsm        from "../lib/vendor/blamejs/lib/fsm.js";
import bGuardEmail from "../lib/vendor/blamejs/lib/guard-email.js";
import bRedact     from "../lib/vendor/blamejs/lib/redact.js";
import bCookies    from "../lib/vendor/blamejs/lib/cookies.js";
import bConstants  from "../lib/vendor/blamejs/lib/constants.js";
import bValidateOpts from "../lib/vendor/blamejs/lib/validate-opts.js";
// webhook: inbound Stripe-signature verification only. The module's
// outbound HTTP client + delivery dispatcher are lazyRequire'd (send
// path), so this import loads no node:net / node:tls / node:http at
// module init — verified Worker-safe by the worker-b-loadable smoke.
import bWebhook    from "../lib/vendor/blamejs/lib/webhook.js";

var b = {
  crypto:     bCrypto,
  template:   bTemplate,
  money:      bMoney,
  uuid:       bUuid,
  safeUrl:    bSafeUrl,
  safeSql:    bSafeSql,
  fsm:        bFsm,
  guardEmail: bGuardEmail,
  redact:     bRedact,
  cookies:    bCookies,
  constants:  bConstants,
  validateOpts: bValidateOpts,
  webhook:    bWebhook,
};

export default b;
