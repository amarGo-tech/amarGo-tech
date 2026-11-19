import { createQpayClient } from "../../../src/platform/payments/qpay.js";

const qpay = createQpayClient();
export const isQpayConfigured = qpay.isConfigured;
export const qpayAccessToken = qpay.getAccessToken;
export const checkQpayInvoice = qpay.checkInvoice;

export async function createQpayInvoice({ orderId, amountMnt, description, customerCode }) {
  const invoice = await qpay.createInvoice({ invoiceNo: orderId, amountMnt, description, receiverCode: customerCode });
  return { ...invoice, senderInvoiceNo: orderId, mode: "live", degraded: false, warning: "" };
}