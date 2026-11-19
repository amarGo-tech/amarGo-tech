import { createQpayClient } from "../../../src/platform/payments/qpay.js";

const qpay = createQpayClient();
export const isQpayConfigured = qpay.isConfigured;
export const qpayAccessToken = qpay.getAccessToken;
export const createQpayInvoice = qpay.createInvoice;
export const checkQpayInvoice = qpay.checkInvoice;