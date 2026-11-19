function qpayError(code, message, statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function createQpayClient({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  let accessToken = "";
  let expiresAt = 0;
  let tokenRequest;
  const config = () => ({
    baseUrl: (env.QPAY_BASE_URL || "https://merchant.qpay.mn").trim().replace(/\/+$/, ""),
    clientId: (env.QPAY_CLIENT_ID || "").trim(),
    clientSecret: env.QPAY_CLIENT_SECRET || "",
    invoiceCode: (env.QPAY_INVOICE_CODE || "").trim(),
    callbackUrl: (env.QPAY_CALLBACK_URL || "").trim(),
  });
  function isConfigured() {
    const value = config();
    return Boolean(value.clientId && value.clientSecret && value.invoiceCode && value.callbackUrl);
  }
  async function send(path, { body, token } = {}) {
    if (!isConfigured()) throw qpayError("QPAY_NOT_CONFIGURED", "QPay merchant тохиргоо дутуу байна.", 503);
    const value = config();
    const authorization = token ? `Bearer ${token}` : `Basic ${Buffer.from(`${value.clientId}:${value.clientSecret}`).toString("base64")}`;
    let response;
    try {
      response = await fetchImpl(`${value.baseUrl}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", Authorization: authorization, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw qpayError("QPAY_UNAVAILABLE", "QPay сервертэй холбогдсонгүй. Дахин оролдоно уу.");
    }
    const payload = await response.json().catch(() => null);
    return { response, payload };
  }
  async function getAccessToken() {
    if (accessToken && expiresAt > Date.now() + 30_000) return accessToken;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const { response, payload } = await send("/v2/auth/token");
      if (!response.ok) throw qpayError("QPAY_AUTH_ERROR", `QPay нэвтрэлт амжилтгүй (${response.status}).`);
      const expiry = Number(payload?.expires_in) * 1000;
      if (!payload?.access_token || !Number.isFinite(expiry) || expiry <= Date.now()) {
        throw qpayError("QPAY_TOKEN_INVALID", "QPay token эсвэл хүчинтэй хугацаа буруу байна.");
      }
      accessToken = payload.access_token;
      expiresAt = expiry;
      return accessToken;
    })();
    try { return await tokenRequest; } finally { tokenRequest = undefined; }
  }
  async function request(path, body) {
    let result = await send(path, { body, token: await getAccessToken() });
    if ([401, 403].includes(result.response.status)) {
      accessToken = "";
      expiresAt = 0;
      result = await send(path, { body, token: await getAccessToken() });
    }
    if (!result.response.ok || !result.payload) {
      throw qpayError("QPAY_ERROR", `QPay хүсэлт амжилтгүй (${result.response.status}).`);
    }
    return result.payload;
  }
  async function createInvoice({ invoiceNo, amountMnt, description, receiverCode }) {
    if (!Number.isSafeInteger(Number(amountMnt)) || Number(amountMnt) <= 0) {
      throw qpayError("QPAY_AMOUNT_INVALID", "Төлбөрийн дүн буруу байна.", 400);
    }
    if (!isConfigured()) throw qpayError("QPAY_NOT_CONFIGURED", "QPay merchant тохиргоо дутуу байна.", 503);
    const value = config();
    const callback = new URL(value.callbackUrl);
    callback.searchParams.set("sender_invoice_no", invoiceNo);
    const payload = await request("/v2/invoice", {
      invoice_code: value.invoiceCode,
      sender_invoice_no: invoiceNo,
      invoice_receiver_code: receiverCode || invoiceNo,
      invoice_description: description,
      amount: Number(amountMnt),
      callback_url: callback.toString(),
    });
    if (!payload.invoice_id) throw qpayError("QPAY_INVOICE_ID_MISSING", "QPay invoice_id ирсэнгүй.");
    return {
      providerInvoiceId: payload.invoice_id, invoiceNo,
      qrText: payload.qr_text ?? "", qrImage: payload.qr_image ?? "",
      shortUrl: payload.qPay_shortUrl ?? payload.qpay_shorturl ?? payload.short_url ?? "",
      urls: Array.isArray(payload.urls) ? payload.urls : [], raw: payload,
    };
  }
  async function checkInvoice(invoiceId) {
    if (!invoiceId || /^(DEMO-QPAY-|local-)/.test(String(invoiceId))) {
      throw qpayError("QPAY_INVOICE_INVALID", "Бодит QPay invoice шаардлагатай.", 400);
    }
    const payload = await request("/v2/payment/check", {
      object_type: "INVOICE", object_id: invoiceId,
      offset: { page_number: 1, page_limit: 100 },
    });
    const rows = (Array.isArray(payload.rows) ? payload.rows : []).filter((row) => (
      row.payment_status === "PAID" && (!row.payment_currency || row.payment_currency === "MNT")
    ));
    const paidAmount = rows.reduce((sum, row) => sum + Math.max(0, Number(row.payment_amount) || 0), 0);
    return { paid: rows.length > 0 && paidAmount > 0, paidAmount, rows, raw: payload };
  }
  return { isConfigured, getAccessToken, createInvoice, checkInvoice };
}
