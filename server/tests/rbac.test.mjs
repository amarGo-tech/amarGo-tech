import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { EventEmitter } from "node:events";
import { createRealtimeSocket } from "../src/platform/realtime/websocket.js";
import { signJwt } from "../src/platform/http/jwt.js";
import { createRoleAuth } from "../src/platform/http/role-auth.js";
import { notificationWhere } from "../src/platform/notifications/notification-center.js";
import { createStoreServiceApp } from "../services/store-service/app/store.app.js";
import { createCourierServiceApp } from "../services/courier-service/app/courier.app.js";
import { createCustomerServiceApp } from "../services/customer-service/app/customer.app.js";
import { createAdminServiceApp } from "../services/admin-service/app/admin.app.js";

// Isolated HTTP servers and signed synthetic identities; no real accounts or DB writes.
process.env.ALLOW_DEV_AUTH_HEADERS = "false";
const roles = ["PLATFORM_ADMIN", "STORE_ADMIN", "DELIVERY_EMPLOYEE", "CUSTOMER"];
const token = (role, extra = {}) => signJwt({ sub: "rbac-test-user", roles: [role], tenantId: "rbac-test-tenant", ...extra });

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const [name, role, createApp] of [
  ["store", "STORE_ADMIN", createStoreServiceApp],
  ["courier", "DELIVERY_EMPLOYEE", createCourierServiceApp],
  ["customer", "CUSTOMER", createCustomerServiceApp],
]) {
  test(`${name}: every protected route rejects anonymous and other roles`, async (t) => {
    const app = createApp();
    const base = await serve(t, app);
    const routes = app.router.stack.filter((layer) => layer.route).map((layer) => layer.route)
      .filter((route) => route.stack.some((layer) => layer.handle.name === "requireAuth"));
    assert.ok(routes.length > 5, "Protected routes must be discovered");
    for (const route of routes) {
      const path = route.path.replace(/:[^/]+/g, "rbac-test-resource");
      const method = Object.keys(route.methods)[0].toUpperCase();
      const anonymous = await fetch(`${base}${path}`, { method });
      assert.equal(anonymous.status, 401, `${method} ${path}: anonymous`);
      for (const otherRole of roles.filter((value) => value !== role)) {
        const result = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token(otherRole)}` } });
        assert.equal(result.status, 403, `${method} ${path}: ${otherRole}`);
      }
    }
  });
  test(`${name}: correct role passes, invalid identity and tokens fail`, async (t) => {
    const app = express();
    const { requireAuth } = createRoleAuth(role, { tenantRequired: name === "store" });
    app.get("/probe", requireAuth, (_request, response) => response.sendStatus(204));
    app.use((error, _request, response, _next) => response.status(error.statusCode ?? 500).json({ code: error.code }));
    const base = await serve(t, app);
    for (const [value, status] of [
      [token(role), 204],
      [token(role, { sub: "" }), 401],
      [token(role, { roles: [] }), 403],
      [signJwt({ sub: "test", roles: [role] }, { expiresInSeconds: -1 }), 401],
      ["invalid-token", 401],
      [token(role, { tenantId: "" }), name === "store" ? 403 : 204],
    ]) {
      assert.equal((await fetch(`${base}/probe`, { headers: { Authorization: `Bearer ${value}` } })).status, status);
    }
    const spoofed = await fetch(`${base}/probe`, { headers: { "x-user-id": "test", "x-role": role, "x-tenant-id": "other" } });
    assert.equal(spoofed.status, 401);
  });
}

test("admin: all management routes require an admin session", async (t) => {
  const app = createAdminServiceApp();
  const base = await serve(t, app);
  const routes = app.router.stack.filter((layer) => layer.route).map((layer) => layer.route)
    .filter((route) => !route.path.includes("/auth/") && route.path.startsWith("/api/admin"));
  assert.ok(routes.length > 10);
  for (const route of routes) {
    const path = route.path.replace(/:[^/]+/g, "rbac-test-resource");
    const result = await fetch(`${base}${path}`, { method: Object.keys(route.methods)[0].toUpperCase() });
    assert.equal(result.status, 401, path);
  }
});

test("notification audiences fail closed and isolate accounts/tenants", () => {
  assert.deepEqual(notificationWhere("customer", { userId: "customer-a" }), { channel: "CUSTOMER", userId: "customer-a" });
  assert.deepEqual(notificationWhere("courier", { userId: "employee-a" }), { channel: "EMPLOYEE", userId: "employee-a" });
  assert.deepEqual(notificationWhere("store", { tenantId: "tenant-a", storeIds: ["store-a"] }), {
    channel: "STORE", OR: [{ tenantId: "tenant-a" }, { userId: { in: ["store-a"] } }],
  });
  for (const role of ["store", "courier", "customer"]) assert.throws(() => notificationWhere(role), { statusCode: 403 });
});

test("public realtime frames contain no order, identity, OTP, or location payloads", () => {
  const realtime = createRealtimeSocket({ serviceName: "test", heartbeatEvent: "refresh" });
  const socket = new EventEmitter();
  const frames = [];
  socket.write = (value) => frames.push(value);
  realtime.handleUpgrade({ url: "/realtime", headers: { "sec-websocket-key": "test-key" } }, socket);
  realtime.broadcast("store.dashboard.refresh", {
    userId: "private-user", orderId: "private-order", otp: "123456", lat: 47.9, address: "private-address",
  });
  const frame = frames.at(-1);
  const headerLength = (frame[1] & 0x7f) === 126 ? 4 : 2;
  const message = JSON.parse(frame.subarray(headerLength).toString());
  assert.equal(message.event, "store.dashboard.refresh");
  assert.deepEqual(message.data, { reason: "refresh" });
  socket.emit("close");
});

test("production ignores development auth headers even when enabled", async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  process.env.ALLOW_DEV_AUTH_HEADERS = "true";
  try {
    const { requireAuth } = createRoleAuth("CUSTOMER");
    let error;
    requireAuth({ header: (name) => ({ "x-user-id": "test", "x-role": "CUSTOMER" })[name] }, {}, (value) => { error = value; });
    assert.equal(error.statusCode, 401);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    process.env.ALLOW_DEV_AUTH_HEADERS = "false";
  }
});
