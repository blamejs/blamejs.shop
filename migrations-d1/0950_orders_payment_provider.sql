-- Payment provider on orders, for provider-routed refunds.
--
-- An order's payment_intent_id is provider-opaque: the Stripe flow stores a
-- `pi_...` PaymentIntent id, the PayPal flow stores the PayPal order id.
-- Refund surfaces must dial the provider that actually captured the money —
-- a PayPal order id sent to Stripe's refund API is a guaranteed upstream
-- 4xx. This column records which provider the checkout charged
-- ('stripe' | 'paypal'), written at order creation. Nullable — gift-card /
-- loyalty fully-covered orders carry no provider charge, and pre-existing
-- rows stay NULL (refund routing falls back to the payment_intent_id
-- `pi_` prefix for those).

ALTER TABLE orders ADD COLUMN payment_provider TEXT;
