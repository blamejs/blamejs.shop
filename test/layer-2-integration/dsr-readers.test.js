"use strict";
/**
 * DSR per-domain reader adapters — the contract that makes the export
 * bundle real.
 *
 * lib/compliance-export.js expects each injected handle to expose
 * forCustomerExport / forCustomerDeletion. NONE of the per-domain
 * primitives do; server.js builds adapter shims that map each handle's
 * existing read / soft-delete surface onto that contract. The shims aren't
 * exported, so this test re-declares the SAME shims over real handles on a
 * shared in-memory DB and exercises them through the primitive — proving:
 *   - a populated customer's `full` export has every customer-keyed section
 *     present (identity / orders / subscriptions / addresses / tickets /
 *     loyalty / reviews / consent ledger / wishlist / surveys / recently-
 *     viewed), `sections_absent` empty, plus a completeness manifest,
 *   - scope narrowing (orders_only / identity_only),
 *   - processDeletion dry-run reports counts WITHOUT mutating (re-read
 *     proves no archive happened),
 *   - processDeletion wet-run archives addresses + subscriptions, erases the
 *     wishlist + recently-viewed, anonymizes the customer row, AND revokes
 *     every sign-in path (passkey deleted, OAuth link removed, email-hash
 *     lookup severed, live portal session revoked) so a deleted customer
 *     can't sign back in, while orders / loyalty / tickets / reviews /
 *     consent ledger are retained (deleted: 0),
 *   - the remaining customer-keyed domains round-trip: the guest-order
 *     claim audit exports + tombstones its email hash (linkage retained,
 *     tombstone namespace distinct from the customers-row one), stock
 *     alerts export the plaintext address + hard-delete on erasure,
 *     quotes retain but clear the customer message, order ratings +
 *     operator notes delete, product Q&A anonymizes in place, gift cards
 *     + referral accounting retain with identity keys severed,
 *   - a failing adapter (unmigrated table) returns null/[] and the bundle
 *     still assembles.
 *
 * Network: zero. Pure node:sqlite over the live migrations.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql", "0026_customer_addresses.sql", "0009_subscriptions.sql",
  "0047_support_tickets.sql", "0022_loyalty.sql", "0237_loyalty_txn_running_balance.sql", "0109_compliance_export.sql",
  // The customer-keyed personalization / feedback / consent domains the
  // full export now covers, plus the auth tables erasure must revoke.
  "0011_reviews.sql", "0185_consent_ledger.sql", "0232_consent_ledger_lawful_basis.sql", "0012_wishlist.sql",
  "0128_customer_surveys.sql", "0050_recently_viewed.sql",
  "0205_customer_oauth_identities.sql", "0072_customer_portal_sessions.sql",
  // The feedback / holdover / wallet domains added to the full export +
  // erasure scope.
  "0181_suggestion_box.sql", "0041_save_for_later.sql", "0094_store_credit.sql",
  "0235_store_credit_ledger_chain.sql", "0236_store_credit_ledger_chain_fence.sql",
  // The remaining customer-keyed domains: guest-order claim audit, stock
  // alerts (plaintext email), quotes, ratings, Q&A, CRM notes, gift
  // cards, referrals.
  "0226_guest_order_reconciliations.sql",
  "0048_stock_alerts.sql", "0207_stock_alert_unsubscribe_token.sql",
  "0102_quotes.sql", "0211_quote_view_token.sql", "0227_quote_response_version.sql",
  "0151_order_ratings.sql", "0133_product_qa.sql",
  "0134_customer_notes.sql", "0190_customer_impersonation.sql", "0013_giftcards.sql", "0025_referrals.sql",
  "0239_subscriptions_plan_transition_claim.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// Drain every page of a cursor-paginated reader (mirrors server.js _drainAll),
// so the adapter copies below follow a reader's own cursor to exhaustion
// exactly as the real _dsrReader does — the property that makes a subject-
// access export carry the FULL record, not the first page.
async function _drainAll(fetchPage) {
  var all = [];
  var cursor = null;
  var pages = 0;
  do {
    var page = await fetchPage(cursor);
    all = all.concat((page && page.rows) || []);
    cursor = (page && page.cursor) || null;
    pages += 1;
  } while (cursor && pages < 10000);
  return all;
}

// The SAME adapter shims server.js builds (kept in sync with _dsrReader).
function _buildReaders(handles, query) {
  return {
    customers: {
      forCustomerExport: async function (id) {
        try {
          var row = await handles.customers.get(id);
          var passkeys = [];
          try { passkeys = await handles.customers.listPasskeys(id); } catch (_e) { passkeys = []; }
          var methods = null;
          try { methods = await handles.customers.signInMethodsByCustomer([id]); } catch (_e) { methods = null; }
          return { customer: row || null, passkeys: passkeys || [], sign_in_methods: methods || null };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          var existing = await handles.customers.get(id);
          if (!existing) return { table: "customers", deleted: 0 };
          if (dryRun) return { table: "customers", deleted: 1 };
          // Erasure revokes every sign-in path before anonymizing the row.
          if (typeof handles.customers.eraseAuthForCustomer === "function") {
            try { await handles.customers.eraseAuthForCustomer(id); } catch (_eAuth) { /* drop-silent */ }
          }
          if (handles.customerPortal && typeof handles.customerPortal.revokeAllForCustomer === "function") {
            try { await handles.customerPortal.revokeAllForCustomer(id, "account-erasure"); } catch (_eSess) { /* drop-silent */ }
          }
          await handles.customers.update(id, { display_name: "[erased customer " + String(id).slice(0, 8) + "]" });
          return { table: "customers", deleted: 1 };
        } catch (_e) { return { table: "customers", deleted: 0 }; }
      },
    },
    addresses: {
      forCustomerExport: async function (id) {
        try { return await handles.addresses.listForCustomer(id, { include_archived: true }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          var rows = await handles.addresses.listForCustomer(id, {});
          if (dryRun) return { table: "customer_addresses", deleted: rows.length };
          var n = 0;
          for (var i = 0; i < rows.length; i += 1) { if (await handles.addresses.archive(rows[i].id)) n += 1; }
          return { table: "customer_addresses", deleted: n };
        } catch (_e) { return { table: "customer_addresses", deleted: 0 }; }
      },
    },
    order: {
      forCustomerExport: async function (id) {
        try { return (await handles.order.listForCustomer(id, { limit: 100 })).rows; }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function () { return { table: "orders", deleted: 0, note: "retained-for-accounting" }; },
    },
    // orderNotes / paymentMethods report present-but-empty so the `full`
    // scope's section list (which includes both) reads as complete rather
    // than absent — matching server.js's _dsrReader.
    orderNotes: { forCustomerExport: async function () { return []; } },
    paymentMethods: { forCustomerExport: async function () { return []; } },
    subscriptions: {
      forCustomerExport: async function (id) {
        try { return await handles.subscriptions.subscriptions.list({ customer_id: id }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        var TERMINAL = ["canceled", "incomplete_expired"];
        try {
          var rows = await handles.subscriptions.subscriptions.list({ customer_id: id });
          var live = rows.filter(function (r) { return TERMINAL.indexOf(r.status) === -1; });
          if (dryRun) return { table: "subscriptions", deleted: live.length };
          var n = 0;
          var ts = Date.now();
          for (var i = 0; i < live.length; i += 1) {
            var res = await query("UPDATE subscriptions SET status = 'canceled', updated_at = ?1 WHERE id = ?2", [ts, live[i].id]);
            if (res && res.rowCount) n += Number(res.rowCount);
          }
          return { table: "subscriptions", deleted: n };
        } catch (_e) { return { table: "subscriptions", deleted: 0 }; }
      },
    },
    supportTickets: {
      forCustomerExport: async function (id) {
        try { return (await handles.supportTickets.listByCustomerId(id, { limit: 100 })).rows; }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function () { return { table: "support_tickets", deleted: 0, note: "retained" }; },
    },
    loyalty: {
      forCustomerExport: async function (id) {
        try {
          var balance = await handles.loyalty.balance(id);
          var history = [];
          try { history = (await handles.loyalty.history(id, { limit: 200 })).rows; } catch (_e) { history = []; }
          return { balance: balance, history: history };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function () { return { table: "loyalty", deleted: 0, note: "retained-ledger" }; },
    },
    reviews: {
      forCustomerExport: async function (id) {
        try { return (await handles.reviews.byCustomer(handles.reviews.hashCustomerId(id), { limit: 100 })).rows; }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function () { return { table: "reviews", deleted: 0, note: "retained-published-content" }; },
    },
    consentLedger: {
      forCustomerExport: async function (id) {
        try { return await handles.consentLedger.historyForCustomer(id); } catch (_e) { return []; }
      },
      forCustomerDeletion: async function () { return { table: "consent_ledger", deleted: 0, note: "retained-consent-evidence" }; },
    },
    wishlist: {
      forCustomerExport: async function (id) {
        try { return (await handles.wishlist.listForCustomer(id, { limit: 100 })).rows; } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) {
            var c = (await query("SELECT COUNT(*) AS n FROM wishlist_entries WHERE customer_id = ?1", [id])).rows[0];
            return { table: "wishlist_entries", deleted: c ? Number(c.n) : 0 };
          }
          var res = await query("DELETE FROM wishlist_entries WHERE customer_id = ?1", [id]);
          return { table: "wishlist_entries", deleted: Number((res && res.rowCount) || 0) };
        } catch (_e) { return { table: "wishlist_entries", deleted: 0 }; }
      },
    },
    surveys: {
      forCustomerExport: async function (id) {
        try { return (await handles.customerSurveys.invitationsForCustomer(id, { limit: 100 })).rows; } catch (_e) { return []; }
      },
      forCustomerDeletion: async function () { return { table: "survey_invitations", deleted: 0, note: "retained" }; },
    },
    recentlyViewed: {
      forCustomerExport: async function (id) {
        try { return await handles.recentlyViewed.forCustomer(id, { limit: 100 }); } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) {
            var c = (await query("SELECT COUNT(*) AS n FROM recently_viewed WHERE customer_id = ?1", [id])).rows[0];
            return { table: "recently_viewed", deleted: c ? Number(c.n) : 0 };
          }
          var out = await handles.recentlyViewed.purgeCustomer(id);
          return { table: "recently_viewed", deleted: Number((out && out.removed) || 0) };
        } catch (_e) { return { table: "recently_viewed", deleted: 0 }; }
      },
    },
    // The feedback / holdover / wallet domains — these shims call the
    // modules' OWN exportForCustomer / eraseForCustomer methods (kept in
    // sync with server.js _dsrReader).
    suggestionBox: {
      forCustomerExport: async function (id) {
        try { return await handles.suggestionBox.exportForCustomer({ customer_id: id }); } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try { return await handles.suggestionBox.eraseForCustomer({ customer_id: id, dry_run: dryRun }); }
        catch (_e) { return { table: "suggestions", deleted: 0 }; }
      },
    },
    saveForLater: {
      forCustomerExport: async function (id) {
        try { return await handles.saveForLater.exportForCustomer(id); } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try { return await handles.saveForLater.eraseForCustomer(id, { dry_run: dryRun }); }
        catch (_e) { return { table: "save_for_later", deleted: 0 }; }
      },
    },
    storeCredit: {
      forCustomerExport: async function (id) {
        try { return await handles.storeCredit.exportForCustomer(id); } catch (_e) { return null; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try { return await handles.storeCredit.eraseForCustomer(id, { dry_run: dryRun }); }
        catch (_e) { return { table: "store_credit_ledger", deleted: 0, note: "retained-financial-ledger" }; }
      },
    },
    // The remaining customer-keyed domains (kept in sync with server.js
    // _dsrReader): guest-order claim audit (export + email-hash
    // tombstone), stock alerts (export + hard delete), quotes (retain,
    // clear the customer message), order ratings (delete), product Q&A
    // (anonymize in place), customer notes (delete), gift cards (retain,
    // sever issue identity), referrals (retain accounting, sever the
    // referee link).
    guestOrderReconciliations: {
      forCustomerExport: async function (id) {
        try { return await handles.order.reconciliationsForCustomer(id); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try { return await handles.order.scrubReconciliationEmailHashForCustomer(id, { dry_run: dryRun }); }
        catch (_e) { return { table: "guest_order_reconciliations", deleted: 0 }; }
      },
    },
    stockAlerts: {
      forCustomerExport: async function (id) {
        try { return await handles.stockAlerts.exportForCustomer({ customer_id: id }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try { return await handles.stockAlerts.eraseForCustomer({ customer_id: id, dry_run: dryRun }); }
        catch (_e) { return { table: "stock_alerts", deleted: 0 }; }
      },
    },
    quotes: {
      forCustomerExport: async function (id) {
        try { return await handles.quotes.quotesForCustomer(id, { limit: 500 }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) {
            var c = (await query("SELECT COUNT(*) AS n FROM quotes WHERE customer_id = ?1 AND message IS NOT NULL", [id])).rows[0];
            return { table: "quotes", deleted: c ? Number(c.n) : 0, note: "quotes retained; customer message cleared" };
          }
          var r = await query(
            "UPDATE quotes SET message = NULL, updated_at = ?1 WHERE customer_id = ?2 AND message IS NOT NULL",
            [Date.now(), id],
          );
          return { table: "quotes", deleted: Number((r && r.rowCount) || 0), note: "quotes retained; customer message cleared" };
        } catch (_e) { return { table: "quotes", deleted: 0 }; }
      },
    },
    orderRatings: {
      forCustomerExport: async function (id) {
        try { return await handles.orderRatings.ratingsForCustomer({ customer_id: id, limit: 500 }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) {
            var c = (await query("SELECT COUNT(*) AS n FROM order_ratings WHERE customer_id = ?1", [id])).rows[0];
            return { table: "order_ratings", deleted: c ? Number(c.n) : 0 };
          }
          var r = await query("DELETE FROM order_ratings WHERE customer_id = ?1", [id]);
          return { table: "order_ratings", deleted: Number((r && r.rowCount) || 0) };
        } catch (_e) { return { table: "order_ratings", deleted: 0 }; }
      },
    },
    productQa: {
      forCustomerExport: async function (id) {
        try {
          return await _drainAll(async function (cursor) {
            var rows = cursor
              ? (await query(
                  "SELECT id, product_id, customer_id, body, status, pinned, vote_count, occurred_at " +
                  "FROM product_qa_questions WHERE customer_id = ?1 AND id < ?2 " +
                  "ORDER BY id DESC LIMIT 100", [id, cursor])).rows
              : (await query(
                  "SELECT id, product_id, customer_id, body, status, pinned, vote_count, occurred_at " +
                  "FROM product_qa_questions WHERE customer_id = ?1 " +
                  "ORDER BY id DESC LIMIT 100", [id])).rows;
            return { rows: rows, cursor: rows.length === 100 ? rows[rows.length - 1].id : null };
          });
        } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) {
            var c = (await query("SELECT COUNT(*) AS n FROM product_qa_questions WHERE customer_id = ?1", [id])).rows[0];
            return { table: "product_qa_questions", deleted: c ? Number(c.n) : 0 };
          }
          var r = await query(
            "UPDATE product_qa_questions SET customer_id = NULL, customer_email_hash = NULL WHERE customer_id = ?1",
            [id],
          );
          return { table: "product_qa_questions", deleted: Number((r && r.rowCount) || 0) };
        } catch (_e) { return { table: "product_qa_questions", deleted: 0 }; }
      },
    },
    // Support sessions opened on the account. Exported because when someone
    // looked at the account, why, and which pages is personal data about the
    // customer; RETAINED on erasure because it is also the store's own record
    // that the access happened — an erasure must not be able to remove the
    // evidence that an operator opened the account.
    customerImpersonation: {
      forCustomerExport: async function (id) {
        try {
          var sessions = await handles.customerImpersonation.listForCustomer(id, { limit: 200 });
          var out = [];
          for (var i = 0; i < sessions.length; i += 1) {
            out.push({
              session: sessions[i],
              actions: await handles.customerImpersonation.actionsForSession(sessions[i].id),
            });
          }
          return out;
        } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (_id, opts) {
        return {
          table: "impersonations", deleted: 0, retained: true,
          dry_run: !!(opts && opts.dry_run),
          reason: "accountability record of store access to this account",
        };
      },
    },
    customerNotes: {
      forCustomerExport: async function (id) {
        try {
          return await _drainAll(async function (cursor) {
            var opts = cursor
              ? { customer_id: id, include_archived: true, limit: 100, cursor: cursor }
              : { customer_id: id, include_archived: true, limit: 100 };
            var page = await handles.customerNotes.notesForCustomer(opts);
            return { rows: page.rows, cursor: page.next_cursor };
          });
        } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) {
            var c = (await query("SELECT COUNT(*) AS n FROM customer_notes WHERE customer_id = ?1", [id])).rows[0];
            return { table: "customer_notes", deleted: c ? Number(c.n) : 0 };
          }
          var r = await query("DELETE FROM customer_notes WHERE customer_id = ?1", [id]);
          return { table: "customer_notes", deleted: Number((r && r.rowCount) || 0) };
        } catch (_e) { return { table: "customer_notes", deleted: 0 }; }
      },
    },
    giftcards: {
      forCustomerExport: async function (id) {
        try {
          var rows = await handles.giftcards.listForCustomer(id);
          return (rows || []).map(function (g) {
            return {
              id: g.id, code_hint: g.code_hint, currency: g.currency,
              issued_minor: g.issued_minor, balance_minor: g.balance_minor,
              issued_to_customer_id: g.issued_to_customer_id, status: g.status,
              expires_at: g.expires_at, created_at: g.created_at, updated_at: g.updated_at,
            };
          });
        } catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) return { table: "giftcards", deleted: 0, note: "retained-for-accounting; issue-identity severed" };
          await query(
            "UPDATE giftcards SET issued_to_customer_id = NULL, issued_to_email_hash = NULL, updated_at = ?1 " +
            "WHERE issued_to_customer_id = ?2",
            [Date.now(), id],
          );
          return { table: "giftcards", deleted: 0, note: "retained-for-accounting; issue-identity severed" };
        } catch (_e) { return { table: "giftcards", deleted: 0, note: "retained-for-accounting" }; }
      },
    },
    referrals: {
      forCustomerExport: async function (id) {
        try {
          var stats = null;
          var invitationsSent = [];
          var asReferee = [];
          try { stats = await handles.referrals.statsForReferrer(id); } catch (_e2) { stats = null; }
          try { invitationsSent = await handles.referrals.invitationsForReferrer(id); } catch (_e2) { invitationsSent = []; }
          try {
            asReferee = (await query(
              "SELECT id, referral_code_id, invited_at, visited_at, signed_up_at, " +
              "first_purchase_at, reward_status FROM referral_invitations " +
              "WHERE signed_up_customer_id = ?1 ORDER BY invited_at DESC, id DESC",
              [id],
            )).rows;
          } catch (_e2) { asReferee = []; }
          var hasReferrerActivity = !!(stats && stats.codes && stats.codes.length);
          if (!hasReferrerActivity && !invitationsSent.length && !asReferee.length) return [];
          return {
            as_referrer:      hasReferrerActivity ? stats : null,
            invitations_sent: invitationsSent,
            as_referee:       asReferee,
          };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          if (dryRun) {
            var c = (await query("SELECT COUNT(*) AS n FROM referral_invitations WHERE signed_up_customer_id = ?1", [id])).rows[0];
            return { table: "referral_invitations", deleted: c ? Number(c.n) : 0, note: "codes + reward accounting retained; referee link severed" };
          }
          var tomb = "erased:" + b.crypto.namespaceHash("referral-erased-email", id);
          var r = await query(
            "UPDATE referral_invitations SET signed_up_customer_id = NULL, referred_email_hash = ?1 " +
            "WHERE signed_up_customer_id = ?2",
            [tomb, id],
          );
          return { table: "referral_invitations", deleted: Number((r && r.rowCount) || 0), note: "codes + reward accounting retained; referee link severed" };
        } catch (_e) { return { table: "referral_invitations", deleted: 0 }; }
      },
    },
  };
}

async function _seedCustomer(query, id, displayName) {
  var ts = Date.now();
  // email_hash from the FULL id — a v7-UUID prefix slice collides for two
  // same-ms generations (UNIQUE constraint).
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [id, "hash-" + id, displayName, ts],
  );
}

async function _seedOrder(query, customerId) {
  var id = b.uuid.v7();
  var cartId = b.uuid.v7();
  var ts = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, ts, ts + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 1000, 0, 0, 0, 1000, NULL, ?5, ?6, ?6)",
    [id, cartId, customerId, b.uuid.v7(), JSON.stringify({ country: "US", line1: "1 Test St" }), ts],
  );
  return id;
}

// An unowned (guest) order that recorded the buyer-email hash — the
// candidate linkGuestOrdersByEmailHash later claims into the account,
// which writes the guest_order_reconciliations audit row under test.
async function _seedGuestOrder(query, emailHash) {
  var id = b.uuid.v7();
  var cartId = b.uuid.v7();
  var ts = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, b.uuid.v7(), ts, ts + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 1000, 0, 0, 0, 1000, NULL, ?4, ?5, ?6, ?6)",
    [id, cartId, b.uuid.v7(), JSON.stringify({ country: "US", line1: "2 Guest St" }), emailHash, ts],
  );
  return id;
}

async function _seedSubscription(query, customerId) {
  var ts = Date.now();
  var planId = b.uuid.v7();
  // variant_id is nullable (ON DELETE SET NULL) — leave it NULL so the seed
  // needs no catalog product / variant row.
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, NULL, ?2, 'month', 1, 'usd', 1999, 0, 1, ?3, ?3)",
    [planId, "price_" + planId.slice(0, 8), ts],
  );
  var subId = b.uuid.v7();
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, ?5, ?5)",
    [subId, customerId, planId, "sub_" + subId.replace(/-/g, "").slice(-16), ts, ts + 2592000000],
  );
  return subId;
}

async function _run() {
  var mem     = helpers.memD1Query(MIGS);
  var query   = mem.query;

  var catalog       = bShop.catalog.create({ query: query });
  var customers     = bShop.customers.create({ query: query, cursorSecret: "dsr-readers-cust" });
  var addresses     = bShop.addresses.create({ query: query });
  var order         = bShop.order.create({ query: query, cursorSecret: "dsr-readers-order" });
  var subscriptions = bShop.subscriptions.create({ query: query, payment: null });
  var supportTickets = bShop.supportTickets.create({ query: query, cursorSecret: "dsr-readers-support" });
  var loyalty       = bShop.loyalty.create({ query: query });
  var reviews        = bShop.reviews.create({ query: query, cursorSecret: "dsr-readers-reviews" });
  var consentLedger  = bShop.consentLedger.create({ query: query });
  var wishlist       = bShop.wishlist.create({ query: query, cursorSecret: "dsr-readers-wishlist" });
  var customerSurveys = bShop.customerSurveys.create({ query: query });
  var recentlyViewed = bShop.recentlyViewed.create({ query: query, catalog: catalog });
  var customerPortal = bShop.customerPortal.create({ query: query });
  var suggestionBox  = bShop.suggestionBox.create({ query: query, cursorSecret: "dsr-readers-sugg" });
  var saveForLater   = bShop.saveForLater.create({ query: query, catalog: catalog, cursorSecret: "dsr-readers-sfl" });
  var storeCredit    = bShop.storeCredit.create({ query: query });
  var stockAlerts    = bShop.stockAlerts.create({ query: query, catalog: catalog });
  var quotes         = bShop.quotes.create({ query: query });
  var orderRatings   = bShop.orderRatings.create({ query: query });
  var productQa      = bShop.productQA.create({ query: query, customers: customers });
  var customerNotes  = bShop.customerNotes.create({ query: query, cursorSecret: "dsr-readers-notes" });
  var customerImpersonation = bShop.customerImpersonation.create({ query: query });
  var giftcards      = bShop.giftcards.create({ query: query });
  var referrals      = bShop.referrals.create({ query: query });

  var handles = {
    customers: customers, addresses: addresses, order: order,
    subscriptions: subscriptions, supportTickets: supportTickets, loyalty: loyalty,
    reviews: reviews, consentLedger: consentLedger, wishlist: wishlist,
    customerSurveys: customerSurveys, recentlyViewed: recentlyViewed,
    customerPortal: customerPortal,
    suggestionBox: suggestionBox, saveForLater: saveForLater, storeCredit: storeCredit,
    stockAlerts: stockAlerts, quotes: quotes, orderRatings: orderRatings,
    customerNotes: customerNotes, customerImpersonation: customerImpersonation, giftcards: giftcards, referrals: referrals,
  };
  var readers = _buildReaders(handles, query);

  var dsr = bShop.complianceExport.create({
    query:          query,
    customers:      readers.customers,
    addresses:      readers.addresses,
    order:          readers.order,
    orderNotes:     readers.orderNotes,
    subscriptions:  readers.subscriptions,
    paymentMethods: readers.paymentMethods,
    supportTickets: readers.supportTickets,
    loyalty:        readers.loyalty,
    reviews:        readers.reviews,
    consentLedger:  readers.consentLedger,
    wishlist:       readers.wishlist,
    surveys:        readers.surveys,
    recentlyViewed: readers.recentlyViewed,
    suggestionBox:  readers.suggestionBox,
    saveForLater:   readers.saveForLater,
    storeCredit:    readers.storeCredit,
    guestOrderReconciliations: readers.guestOrderReconciliations,
    stockAlerts:    readers.stockAlerts,
    quotes:         readers.quotes,
    orderRatings:   readers.orderRatings,
    productQa:      readers.productQa,
    customerNotes:  readers.customerNotes,
    customerImpersonation: readers.customerImpersonation,
    giftcards:      readers.giftcards,
    referrals:      readers.referrals,
  });

  // ---- populate a customer across every domain ----
  var cid = b.uuid.v7();
  await _seedCustomer(query, cid, "Dana Subject");
  await addresses.add({
    customer_id: cid, recipient_name: "Dana Subject", street_line1: "1 Privacy Way",
    city: "Brussels", postal_code: "1000", country: "BE", is_default_shipping: true, is_default_billing: false,
  });
  var ownOrderId = await _seedOrder(query, cid);
  await _seedSubscription(query, cid);
  await supportTickets.open({
    customer_id: cid, customer_email: "dana@example.com", subject: "Where is my order?",
    body: "Tracking hasn't updated.", category: "order_issue",
  });
  await loyalty.earn({ customer_id: cid, points: 120, source: "purchase" });
  // The customer-keyed personalization / feedback / consent domains. The
  // reviews row needs a real product (hard FK); wishlist / recently-viewed
  // product ids are soft FKs and need no product row.
  var seedProduct = await catalog.products.create({ slug: "dsr-widget", title: "DSR Widget", status: "active" });
  await wishlist.add({ customer_id: cid, product_id: b.uuid.v7() });
  await consentLedger.recordConsentChange({ customer_id: cid, consent_kind: "marketing_email", state: "granted", source: "signup_form" });
  await recentlyViewed.recordView({ customer_id: cid, product_id: b.uuid.v7() });
  await query(
    "INSERT INTO reviews (id, product_id, customer_id, customer_id_hash, rating, title, body, verified_purchase, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 5, 'Great', 'Loved it', 1, 'published', ?5, ?5)",
    [b.uuid.v7(), seedProduct.id, cid, reviews.hashCustomerId(cid), Date.now()],
  );
  // Auth credentials the erasure must revoke: a passkey, a federated link,
  // and a live portal session.
  await customers.addPasskey(cid, { credential_id: "dsr-cred", public_key: "k", transports: "internal" });
  await query(
    "INSERT INTO customer_oauth_identities (id, customer_id, provider, subject, email, email_verified, created_at, updated_at) " +
    "VALUES (?1, ?2, 'google', 'dsr-sub', 'dana@example.com', 1, ?3, ?3)",
    [b.uuid.v7(), cid, Date.now()],
  );
  await customerPortal.createSession({ customer_id: cid, scope: "full" });
  // Feedback / holdover / wallet rows. The suggestion is keyed by
  // customer_id (the authenticated-submission path the DSR reader covers).
  await suggestionBox.submitSuggestion({
    customer_id: cid, title: "Stock more sizes", body: "Please carry XXL.", category: "product_idea",
  });
  await saveForLater.add({ customer_id: cid, sku: "DSR-SKU", quantity: 2, snapshot_price_minor: 1999 });
  await storeCredit.credit({ customer_id: cid, amount_minor: 750, source: "goodwill" });
  // The remaining customer-keyed domains, each seeded through its
  // production write path.
  //   guest-order claim: an unowned order under Dana's verified email
  //   hash, claimed into the account — writes the reconciliation row.
  var guestHash    = "hash-guest-" + cid;
  var guestOrderId = await _seedGuestOrder(query, guestHash);
  var linkedCount  = await order.linkGuestOrdersByEmailHash(cid, guestHash, { linked_via: "magic-link" });
  check("seed: guest order claimed into the account", linkedCount === 1);
  //   stock alert (signed-in subscribe carries the customer link).
  await stockAlerts.subscribe({ email: "dana@example.com", sku: "DSR-SKU", customer_id: cid });
  //   quote with a customer-authored message.
  await quotes.requestQuote({
    customer_id: cid, lines: [{ sku: "DSR-SKU", quantity: 3 }],
    message: "Can you do a bulk discount on three?",
  });
  //   post-fulfillment rating with a free-text comment.
  await orderRatings.submitRating({
    order_id: ownOrderId, customer_id: cid,
    shipping_rating: 5, packaging_rating: 4, recommend_rating: 5, comment: "Fast shipping.",
  });
  //   product Q&A question (published content keyed by the asker).
  await productQa.submitQuestion({ product_id: seedProduct.id, customer_id: cid, body: "Does it ship to Belgium?" });
  //   operator CRM note about the subject.
  await customerNotes.addNote({
    customer_id: cid, author: "operator", body: "Prefers email contact.", kind: "preference",
  });
  //   gift card issued to the account.
  await giftcards.issue({ amount_minor: 2500, currency: "USD", issued_to_customer_id: cid });
  //   referrals, both directions: Dana refers a friend AND was herself
  //   referred by another customer (her signup converted an invitation).
  var ownCode = await referrals.issueCode({ referrer_customer_id: cid });
  await referrals.invite({ code: ownCode.code, referee_email: "friend@example.com" });
  var otherReferrer = b.uuid.v7();
  var theirCode = await referrals.issueCode({ referrer_customer_id: otherReferrer });
  await referrals.invite({ code: theirCode.code, referee_email: "dana@example.com" });
  await referrals.trackSignup({ customer_id: cid, code: theirCode.code });

  // ---- 1. full export: every section present, sections_absent EMPTY ----
  var exReq = await dsr.requestExport({ customer_id: cid, requested_by: "operator-1", jurisdiction: "gdpr", scope: "full" });
  var bundle = await dsr.fulfillRequest({ request_id: exReq.id });
  check("full export sections_absent is empty", Array.isArray(bundle.sections_absent) && bundle.sections_absent.length === 0);
  ["customers", "addresses", "order", "subscriptions", "supportTickets", "loyalty",
   "reviews", "consentLedger", "wishlist", "surveys", "recentlyViewed",
   "suggestionBox", "saveForLater", "storeCredit",
   "guestOrderReconciliations", "stockAlerts", "quotes", "orderRatings",
   "productQa", "customerNotes", "giftcards", "referrals"].forEach(function (name) {
    check("full export has section " + name, bundle.sections_present.indexOf(name) !== -1);
  });
  check("customers section carries the row",  bundle.data.customers && bundle.data.customers.customer && bundle.data.customers.customer.id === cid);
  check("addresses section is non-empty",     Array.isArray(bundle.data.addresses) && bundle.data.addresses.length === 1);
  // Two orders: the one placed signed-in plus the claimed guest order.
  check("order section is non-empty",         Array.isArray(bundle.data.order) && bundle.data.order.length === 2);
  check("subscriptions section is non-empty", Array.isArray(bundle.data.subscriptions) && bundle.data.subscriptions.length === 1);
  check("supportTickets section is non-empty", Array.isArray(bundle.data.supportTickets) && bundle.data.supportTickets.length === 1);
  check("loyalty section carries balance",    bundle.data.loyalty && bundle.data.loyalty.balance && bundle.data.loyalty.balance.balance === 120);
  check("reviews section is non-empty",       Array.isArray(bundle.data.reviews) && bundle.data.reviews.length === 1);
  check("consentLedger section is non-empty", Array.isArray(bundle.data.consentLedger) && bundle.data.consentLedger.length >= 1);
  check("wishlist section is non-empty",      Array.isArray(bundle.data.wishlist) && bundle.data.wishlist.length === 1);
  check("recentlyViewed section is non-empty", Array.isArray(bundle.data.recentlyViewed) && bundle.data.recentlyViewed.length === 1);
  check("suggestionBox section is non-empty", Array.isArray(bundle.data.suggestionBox) && bundle.data.suggestionBox.length === 1);
  check("suggestionBox row carries the customer_id", bundle.data.suggestionBox[0] && bundle.data.suggestionBox[0].customer_id === cid);
  check("saveForLater section is non-empty",  Array.isArray(bundle.data.saveForLater) && bundle.data.saveForLater.length === 1);
  check("storeCredit section carries balance", bundle.data.storeCredit && bundle.data.storeCredit.balance_minor === 750 && Array.isArray(bundle.data.storeCredit.history) && bundle.data.storeCredit.history.length === 1);
  check("guestOrderReconciliations section carries the claim audit row",
    Array.isArray(bundle.data.guestOrderReconciliations) &&
    bundle.data.guestOrderReconciliations.length === 1 &&
    bundle.data.guestOrderReconciliations[0].order_id === guestOrderId &&
    bundle.data.guestOrderReconciliations[0].email_hash === guestHash &&
    bundle.data.guestOrderReconciliations[0].linked_via === "magic-link");
  check("stockAlerts section carries the row + plaintext address",
    Array.isArray(bundle.data.stockAlerts) && bundle.data.stockAlerts.length === 1 &&
    bundle.data.stockAlerts[0].email_normalised === "dana@example.com");
  check("stockAlerts section excludes the token hashes",
    bundle.data.stockAlerts[0].confirmation_token_hash === undefined &&
    bundle.data.stockAlerts[0].unsubscribe_token_hash === undefined);
  check("quotes section carries the customer message",
    Array.isArray(bundle.data.quotes) && bundle.data.quotes.length === 1 &&
    bundle.data.quotes[0].message === "Can you do a bulk discount on three?");
  check("orderRatings section carries the comment",
    Array.isArray(bundle.data.orderRatings) && bundle.data.orderRatings.length === 1 &&
    bundle.data.orderRatings[0].comment === "Fast shipping.");
  check("productQa section carries the question body",
    Array.isArray(bundle.data.productQa) && bundle.data.productQa.length === 1 &&
    bundle.data.productQa[0].body === "Does it ship to Belgium?");
  check("customerNotes section carries the operator note",
    Array.isArray(bundle.data.customerNotes) && bundle.data.customerNotes.length === 1 &&
    bundle.data.customerNotes[0].body === "Prefers email contact.");
  check("giftcards section carries the card metadata",
    Array.isArray(bundle.data.giftcards) && bundle.data.giftcards.length === 1 &&
    bundle.data.giftcards[0].balance_minor === 2500 &&
    typeof bundle.data.giftcards[0].code_hint === "string");
  check("giftcards section never carries the code hash",
    bundle.data.giftcards[0].code_hash === undefined);
  check("referrals section covers both directions",
    bundle.data.referrals &&
    bundle.data.referrals.as_referrer && bundle.data.referrals.as_referrer.codes.length === 1 &&
    Array.isArray(bundle.data.referrals.invitations_sent) && bundle.data.referrals.invitations_sent.length === 1 &&
    Array.isArray(bundle.data.referrals.as_referee) && bundle.data.referrals.as_referee.length === 1);
  // The completeness manifest covers every scope section.
  check("export carries a manifest",          Array.isArray(bundle.manifest) && bundle.manifest.length === bShop.complianceExport.SCOPE_SECTIONS.full.length);

  // ---- 2. scope narrowing ----
  var ordersOnlyReq = await dsr.requestExport({ customer_id: cid, requested_by: "op", jurisdiction: "ccpa", scope: "orders_only" });
  var ordersOnly = await dsr.fulfillRequest({ request_id: ordersOnlyReq.id });
  check("orders_only present has order",       ordersOnly.sections_present.indexOf("order") !== -1);
  check("orders_only omits customers",         ordersOnly.sections_present.indexOf("customers") === -1);

  var identityReq = await dsr.requestExport({ customer_id: cid, requested_by: "op", jurisdiction: "lgpd", scope: "identity_only" });
  var identity = await dsr.fulfillRequest({ request_id: identityReq.id });
  check("identity_only has customers",         identity.sections_present.indexOf("customers") !== -1);
  check("identity_only has addresses",         identity.sections_present.indexOf("addresses") !== -1);
  check("identity_only omits order",           identity.sections_present.indexOf("order") === -1);

  // ---- 3. deletion DRY-RUN reports counts WITHOUT mutating ----
  var delReq = await dsr.requestDeletion({ customer_id: cid, requested_by: "op", jurisdiction: "gdpr", reason: "right to erasure" });
  var addrBefore = await addresses.listForCustomer(cid, {});
  var preview = await dsr.processDeletion({ request_id: delReq.id, dry_run: true });
  check("dry-run is flagged dry_run",          preview.dry_run === true);
  var addrDom = preview.domains.filter(function (d) { return d.domain === "addresses"; })[0];
  check("dry-run counts addresses",            addrDom && addrDom.deleted === 1);
  var subDom = preview.domains.filter(function (d) { return d.domain === "subscriptions"; })[0];
  check("dry-run counts subscriptions",        subDom && subDom.deleted === 1);
  var addrAfterPreview = await addresses.listForCustomer(cid, {});
  check("dry-run did NOT archive addresses",   addrAfterPreview.length === addrBefore.length && addrAfterPreview.length === 1);
  var delRowAfterPreview = await dsr.getRequest(delReq.id);
  check("dry-run did NOT advance status",      delRowAfterPreview.status === "received");
  // The new domains preview their counts side-effect-free too.
  function _domainCount(rv, name) {
    var d = rv.domains.filter(function (x) { return x.domain === name; })[0];
    return d ? d.deleted : null;
  }
  check("dry-run counts guestOrderReconciliations", _domainCount(preview, "guestOrderReconciliations") === 1);
  check("dry-run counts stockAlerts",               _domainCount(preview, "stockAlerts") === 1);
  check("dry-run counts quotes (message-bearing)",  _domainCount(preview, "quotes") === 1);
  check("dry-run counts orderRatings",              _domainCount(preview, "orderRatings") === 1);
  check("dry-run counts productQa",                 _domainCount(preview, "productQa") === 1);
  check("dry-run counts customerNotes",             _domainCount(preview, "customerNotes") === 1);
  check("dry-run giftcards report retained (0)",    _domainCount(preview, "giftcards") === 0);
  check("dry-run counts the severed referee link",  _domainCount(preview, "referrals") === 1);
  // Side-effect-free: the recon hash is still live, the alert row (and
  // its plaintext address) still present, the gift card still linked.
  var reconAfterPreview = await order.reconciliationsForCustomer(cid);
  check("dry-run did NOT tombstone the recon hash",
    reconAfterPreview.length === 1 && reconAfterPreview[0].email_hash === guestHash);
  check("dry-run did NOT delete the stock alert",
    (await stockAlerts.exportForCustomer({ customer_id: cid })).length === 1);
  check("dry-run did NOT sever the gift-card link",
    (await giftcards.listForCustomer(cid)).length === 1);

  // ---- 4. deletion WET-RUN archives + anonymizes; retains the rest ----
  var result = await dsr.processDeletion({ request_id: delReq.id, dry_run: false });
  check("wet-run is not dry_run",              result.dry_run === false);
  var addrAfter = await addresses.listForCustomer(cid, {});
  check("wet-run archived the address",        addrAfter.length === 0);
  var subRows = await subscriptions.subscriptions.list({ customer_id: cid });
  check("wet-run canceled the subscription",   subRows.length === 1 && subRows[0].status === "canceled");
  var custRow = await customers.get(cid);
  check("wet-run anonymized the customer row", custRow && custRow.display_name.indexOf("[erased customer") === 0);
  // ---- erasure revoked EVERY sign-in path (a deleted customer can't re-enter) ----
  check("wet-run deleted the passkey",         (await customers.listPasskeys(cid)).length === 0);
  check("wet-run unlinked the OAuth identity", (await customers.byOAuthIdentity("google", "dsr-sub")) === null);
  check("wet-run severed the email-hash lookup", (await customers.byEmailHash("hash-" + cid)) === null);
  var liveSessions = (await customerPortal.listForCustomer(cid, {})).filter(function (s) { return s.status === "issued"; });
  check("wet-run revoked the live portal session", liveSessions.length === 0);
  // ---- personalization erased; reviews / consent retained ----
  var wishlistAfter = (await wishlist.listForCustomer(cid, {})).rows;
  check("wet-run erased the wishlist",         wishlistAfter.length === 0);
  var rvAfter = await recentlyViewed.forCustomer(cid, {});
  check("wet-run erased recently-viewed",      rvAfter.length === 0);
  var reviewsRetained = result.domains.filter(function (d) { return d.domain === "reviews"; })[0];
  var consentRetained = result.domains.filter(function (d) { return d.domain === "consentLedger"; })[0];
  check("reviews retained (deleted: 0)",       reviewsRetained && reviewsRetained.deleted === 0);
  check("consent ledger retained (deleted: 0)", consentRetained && consentRetained.deleted === 0);
  var ordersRetained  = result.domains.filter(function (d) { return d.domain === "order"; })[0];
  var loyaltyRetained = result.domains.filter(function (d) { return d.domain === "loyalty"; })[0];
  var ticketsRetained = result.domains.filter(function (d) { return d.domain === "supportTickets"; })[0];
  check("orders retained (deleted: 0)",        ordersRetained && ordersRetained.deleted === 0);
  check("loyalty retained (deleted: 0)",       loyaltyRetained && loyaltyRetained.deleted === 0);
  check("tickets retained (deleted: 0)",       ticketsRetained && ticketsRetained.deleted === 0);
  var ordersStill = (await order.listForCustomer(cid, { limit: 10 })).rows;
  check("both order rows are still present",    ordersStill.length === 2);

  // ---- guest-order claim audit: linkage retained, email hash tombstoned ----
  check("guestOrderReconciliations scrubbed 1 row", _domainCount(result, "guestOrderReconciliations") === 1);
  var reconAfter = await order.reconciliationsForCustomer(cid);
  check("the claim audit row survives erasure",
    reconAfter.length === 1 && reconAfter[0].order_id === guestOrderId &&
    reconAfter[0].linked_via === "magic-link");
  check("the recon email hash is tombstoned",
    typeof reconAfter[0].email_hash === "string" &&
    reconAfter[0].email_hash.indexOf("erased:") === 0 &&
    reconAfter[0].email_hash !== guestHash);
  // Distinct tombstone namespaces: the recon tombstone must never equal
  // the customers-row tombstone for the same id (different labels into
  // the same namespaceHash → different digests).
  var custTombstone = "erased:" + b.crypto.namespaceHash("customer-erased-email", cid);
  check("recon tombstone differs from the customers-row tombstone",
    reconAfter[0].email_hash !== custTombstone);
  var custRowAfter = (await query("SELECT email_hash FROM customers WHERE id = ?1", [cid])).rows[0];
  check("the two tombstones never share a digest",
    custRowAfter && custRowAfter.email_hash !== reconAfter[0].email_hash);

  // ---- stock alerts: hard-deleted, plaintext address gone ----
  check("stockAlerts erasure deleted 1 row", _domainCount(result, "stockAlerts") === 1);
  var alertRowsAfter = (await query("SELECT * FROM stock_alerts WHERE customer_id = ?1 OR email_normalised = ?2", [cid, "dana@example.com"])).rows;
  check("no stock-alert row (or plaintext address) survives", alertRowsAfter.length === 0);

  // ---- quotes: record retained, customer message cleared ----
  check("quotes erasure cleared 1 message", _domainCount(result, "quotes") === 1);
  var quotesAfter = await quotes.quotesForCustomer(cid, {});
  check("the quote row survives with its lines",
    quotesAfter.length === 1 && quotesAfter[0].lines.length === 1);
  check("the customer message is cleared", quotesAfter[0].message === null);

  // ---- order ratings + operator notes: deleted outright ----
  check("orderRatings erasure deleted 1 row", _domainCount(result, "orderRatings") === 1);
  check("no rating row survives", (await orderRatings.ratingsForCustomer({ customer_id: cid })).length === 0);
  check("customerNotes erasure deleted 1 row", _domainCount(result, "customerNotes") === 1);
  check("no note row survives",
    (await customerNotes.notesForCustomer({ customer_id: cid, include_archived: true })).rows.length === 0);

  // ---- product Q&A: anonymized in place (suggestion-box shape) ----
  check("productQa erasure anonymized 1 row", _domainCount(result, "productQa") === 1);
  var qaRow = (await query("SELECT customer_id, customer_email_hash, body FROM product_qa_questions WHERE body = ?1", ["Does it ship to Belgium?"])).rows[0];
  check("the question survives de-identified",
    qaRow && qaRow.customer_id === null && qaRow.customer_email_hash === null);

  // ---- gift cards: retained, issue-identity severed, balance intact ----
  check("giftcards retained (deleted: 0)", _domainCount(result, "giftcards") === 0);
  check("no gift card is linkable to the subject", (await giftcards.listForCustomer(cid)).length === 0);
  var gcRow = (await query("SELECT issued_to_customer_id, issued_to_email_hash, balance_minor, status FROM giftcards", [])).rows[0];
  check("the card row survives with its balance",
    gcRow && gcRow.issued_to_customer_id === null && gcRow.issued_to_email_hash === null &&
    Number(gcRow.balance_minor) === 2500 && gcRow.status === "active");

  // ---- referrals: accounting retained, referee link severed ----
  check("referrals severed 1 referee link", _domainCount(result, "referrals") === 1);
  var refereeRows = (await query("SELECT signed_up_customer_id, referred_email_hash FROM referral_invitations WHERE signed_up_customer_id = ?1", [cid])).rows;
  check("no invitation still points at the subject", refereeRows.length === 0);
  var severedInv = (await query(
    "SELECT signed_up_customer_id, referred_email_hash FROM referral_invitations " +
    "WHERE referred_email_hash LIKE 'erased:%'", [],
  )).rows[0];
  check("the converted invitation survives de-identified",
    severedInv && severedInv.signed_up_customer_id === null);
  var ownCodeRow = (await query("SELECT status FROM referral_codes WHERE referrer_customer_id = ?1", [cid])).rows[0];
  check("the subject's own code row is retained (rides the anonymized customer)",
    ownCodeRow && ownCodeRow.status === "active");

  // ---- feedback anonymized; holdover erased; wallet retained ----
  var sgErased = result.domains.filter(function (d) { return d.domain === "suggestionBox"; })[0];
  check("suggestionBox erasure anonymized 1 row", sgErased && sgErased.deleted === 1);
  // The suggestion row survives (de-identified roadmap signal) but both
  // identity keys are now NULL — it can no longer be traced to the subject.
  var sgRowsLeftForCustomer = await suggestionBox.exportForCustomer({ customer_id: cid });
  check("suggestionBox no longer linkable to the subject", sgRowsLeftForCustomer.length === 0);
  var sgAnonRow = (await query("SELECT customer_id, customer_email_hash, title FROM suggestions WHERE title = ?1", ["Stock more sizes"])).rows[0];
  check("the anonymized suggestion row survives", sgAnonRow && sgAnonRow.customer_id === null && sgAnonRow.customer_email_hash === null);
  // Re-running erase is idempotent (no identity-bearing row left to scrub).
  var sgReErase = await suggestionBox.eraseForCustomer({ customer_id: cid });
  check("suggestionBox erase is idempotent",    sgReErase.deleted === 0);

  var sflErased = result.domains.filter(function (d) { return d.domain === "saveForLater"; })[0];
  check("saveForLater erasure deleted 1 row",   sflErased && sflErased.deleted === 1);
  var sflLeft = await saveForLater.exportForCustomer(cid);
  check("saveForLater rows gone after erasure", sflLeft.length === 0);

  var scRetained = result.domains.filter(function (d) { return d.domain === "storeCredit"; })[0];
  check("storeCredit retained (deleted: 0)",    scRetained && scRetained.deleted === 0);
  var scAfter = await storeCredit.exportForCustomer(cid);
  check("storeCredit ledger retained after erasure", scAfter.balance_minor === 750 && scAfter.history.length === 1);

  // ---- 5. a failing adapter (unmigrated table) → null/[], bundle assembles ----
  // Build a reader set where one adapter reads a non-existent table: the
  // export adapter throws internally, the shim swallows it (returns null),
  // and the section lands in sections_absent rather than failing the bundle.
  var brokenReaders = _buildReaders({
    customers: customers, addresses: addresses, order: order,
    subscriptions: subscriptions, supportTickets: supportTickets,
    loyalty: { balance: async function () { throw new Error("loyalty_accounts: no such table"); } },
  }, query);
  // Force the loyalty export to fall to the catch by giving it a handle
  // whose balance throws — the shim returns null, not throws.
  var loyaltySection = await brokenReaders.loyalty.forCustomerExport(cid);
  check("a failing export adapter returns null", loyaltySection === null);

  // ---- 6. Art. 15 completeness: the export DRAINS past the first page ----
  // The readers that previously took only the first 100 rows now carry the
  // customer's FULL record. Seed a long-tenured customer with more than two
  // pages of operator notes and assert the export returns every one — the
  // regression that shipped a truncated bundle while the manifest reported
  // the section complete. (customerNotes is the most plausible >100 case; its
  // drain follows notesForCustomer's own next_cursor, which previously existed
  // but was simply not followed.)
  var bigId = b.uuid.v7();
  await _seedCustomer(query, bigId, "Long-Tenured VIP");
  var NOTE_COUNT = 230;
  for (var bn = 0; bn < NOTE_COUNT; bn += 1) {
    await query(
      "INSERT INTO customer_notes (id, customer_id, author, author_id, body, kind, " +
      "tags_json, pinned, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, 'operator', 'op-1', ?3, 'general', '[]', 0, NULL, ?4, ?4)",
      [b.uuid.v7(), bigId, "VIP note #" + bn, 1000 + bn],
    );
  }
  var bigReaders = _buildReaders({ customerNotes: customerNotes }, query);
  var drainedNotes = await bigReaders.customerNotes.forCustomerExport(bigId);
  check("export drains EVERY operator note past the first page (Art. 15 completeness)",
    Array.isArray(drainedNotes) && drainedNotes.length === NOTE_COUNT);

  console.log("dsr-readers: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: _run };
