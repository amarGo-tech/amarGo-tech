import { test } from "node:test";
import assert from "node:assert/strict";
import { createQpayClient } from "../src/platform/payments/qpay.js";

const env = {
  QPAY_CLIENT_ID: "test-merchant", QPAY_CLIENT_SECRET: "test-secret",
  QPAY_INVOICE_CODE: "test-invoice", QPAY_CALLBACK_URL: "https://example.test/callback?source=qpay",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const token = (value = "test-token") => json({ access_token: value, expires_in: Math.floor(Date.now() / 1000) + 3600 });
const invoiceArgs = { invoiceNo: "order-a", amountMnt: 1000, description: "Test", receiverCode: "customer-a" };

test("missing merchant configuration fails without demo or network calls", async () => {
  const client = createQpayClient({ env: {}, fetchImpl: () => { throw new Error("Unexpected network"); } });
  await assert.rejects(client.createInvoice(invoiceArgs), { code: "QPAY_NOT_CONFIGURED" });
});

test("invoice uses merchant authentication, callback correlation and original bank links", async () => {
  const calls = [];
  const bankLinks = [{ name: "bank", link: "bank://pay?original=1" }];
  const client = createQpayClient({ env, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("/auth/token") ? token() : json({ invoice_id: "live-invoice", qr_text: "qr", urls: bankLinks });
  } });
  const invoice = await client.createInvoice(invoiceArgs);
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from("test-merchant:test-secret").toString("base64")}`);
  assert.equal(calls[1].init.headers.Authorization, "Bearer test-token");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.amount, 1000);
  assert.equal(body.invoice_code, env.QPAY_INVOICE_CODE);
  assert.equal(new URL(body.callback_url).searchParams.get("sender_invoice_no"), "order-a");
  assert.equal(new URL(body.callback_url).searchParams.get("source"), "qpay");
  assert.deepEqual(invoice.urls, bankLinks);
  assert.equal(invoice.providerInvoiceId, "live-invoice");
});

test("Unix timestamp token expiry is cached and concurrent requests share authentication", async () => {
  let authCalls = 0;
  const client = createQpayClient({ env, fetchImpl: async (url) => {
    if (url.endsWith("/auth/token")) { authCalls++; return token(); }
    return json({ rows: [] });
  } });
  await Promise.all([client.checkInvoice("invoice-a"), client.checkInvoice("invoice-b")]);
  await client.checkInvoice("invoice-c");
  assert.equal(authCalls, 1);
});

test("expired token responses are rejected instead of cached", async () => {
  const client = createQpayClient({ env, fetchImpl: async () => json({ access_token: "expired", expires_in: 1 }) });
  await assert.rejects(client.getAccessToken(), { code: "QPAY_TOKEN_INVALID" });
});

for (const status of [401, 403]) {
  test(`${status} refreshes credentials and retries exactly once`, async () => {
    let authCalls = 0;
    let requestCalls = 0;
    const client = createQpayClient({ env, fetchImpl: async (url) => {
      if (url.endsWith("/auth/token")) { authCalls++; return token(`token-${authCalls}`); }
      requestCalls++;
      return json({}, status);
    } });
    await assert.rejects(client.checkInvoice("invoice-a"), { code: "QPAY_ERROR" });
    assert.equal(authCalls, 2);
    assert.equal(requestCalls, 2);
  });
}

test("provider failure does not create a demo invoice", async () => {
  const client = createQpayClient({ env, fetchImpl: async (url) => url.endsWith("/auth/token") ? token() : json({}, 500) });
  await assert.rejects(client.createInvoice(invoiceArgs), { code: "QPAY_ERROR" });
});

test("demo invoice IDs can never be confirmed paid", async () => {
  const client = createQpayClient({ env });
  await assert.rejects(client.checkInvoice("DEMO-QPAY-order-a"), { code: "QPAY_INVOICE_INVALID" });
  await assert.rejects(client.checkInvoice("local-order-a"), { code: "QPAY_INVOICE_INVALID" });
});

test("payment totals include only paid MNT transactions", async () => {
  const client = createQpayClient({ env, fetchImpl: async (url) => url.endsWith("/auth/token") ? token() : json({
    paid_amount: 999999,
    rows: [
      { payment_status: "PAID", payment_amount: "500", payment_currency: "MNT" },
      { payment_status: "PENDING", payment_amount: 1000 },
      { payment_status: "PAID", payment_amount: 100, payment_currency: "USD" },
    ],
  }) });
  const result = await client.checkInvoice("invoice-a");
  assert.equal(result.paid, true);
  assert.equal(result.paidAmount, 500);
  assert.equal(result.rows.length, 1);
});

test("an aggregate paid_amount alone is insufficient payment evidence", async () => {
  const client = createQpayClient({ env, fetchImpl: async (url) => url.endsWith("/auth/token") ? token() : json({ paid_amount: 1000, rows: [] }) });
  assert.equal((await client.checkInvoice("invoice-a")).paid, false);
});
