-- PayPal capture id on orders, for refunds against the capture.
--
-- PayPal refunds run against /v2/payments/captures/<capture-id>/refund —
-- the CAPTURE id, not the PayPal order id the order row links via
-- payment_intent_id. The capture id is known only once the order is
-- captured (capturePaypalOrder, or the PAYMENT.CAPTURE.COMPLETED webhook
-- backstop); this column persists it so refund surfaces don't have to
-- re-dial PayPal to discover it. Nullable — Stripe / uncaptured / pre-paid
-- rows stay NULL; pre-existing PayPal orders recover it from the mark_paid
-- transition metadata (or a getOrder read) and heal the column on first
-- refund.

ALTER TABLE orders ADD COLUMN paypal_capture_id TEXT;
