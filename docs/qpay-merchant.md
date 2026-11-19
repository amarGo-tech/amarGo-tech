# QPay Merchant V2

Official reference: https://developer.qpay.mn/mn/docs/merchant?version=2.0.0

Customer checkout configuration belongs in Render's `amar-go-customer` service:

```dotenv
QPAY_BASE_URL=https://merchant.qpay.mn
QPAY_CLIENT_ID=<issued by QPay>
QPAY_CLIENT_SECRET=<issued by QPay>
QPAY_INVOICE_CODE=<issued by QPay>
QPAY_CALLBACK_URL=https://amar-go-gateway.onrender.com/api/customer/payments/qpay/callback
```

Never put merchant credentials in Vercel or `VITE_*` variables.
The callback URL is generated with an order correlation query parameter and
supports GET and POST. Callback data alone never proves payment; the backend
checks the merchant invoice with QPay and requires the full invoice amount.

The shared client caches tokens using QPay's absolute `expires_in` Unix timestamp,
coalesces concurrent token requests, and retries a 401/403 once with a new token.
QR and bank deeplinks are passed through from the provider.
Missing credentials and provider errors fail explicitly; no demo invoice or fake
payment confirmation is available. Older demo invoice IDs must be replaced by new invoices.

`npm run test:qpay` uses simulated provider responses. No live merchant request,
invoice creation or real payment has been performed by these tests.

Store subscription billing uses the same Merchant V2 client but is a separate flow.
Its pending invoices are still held in process memory, and it has no subscription
callback route. Persistent invoices, restart recovery and a subscription callback
must be implemented before enabling live store subscription billing.

Customer checkout's product/price source and duplicate callback handling also need
an end-to-end review before accepting live customer payments. Adding merchant
credentials alone does not certify the full checkout flow for production.
