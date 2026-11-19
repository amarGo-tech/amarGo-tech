import { verifyJwt } from "./jwt.js";

function authError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

export function createRoleAuth(role, { tenantRequired = false } = {}) {
  function optionalAuth(request, _response, next) {
    const [scheme, token] = (request.header("authorization") ?? "").split(" ");
    request.auth = { userId: "", tenantId: "", token: "", roles: [], strategy: "anonymous" };
    if (scheme?.toLowerCase() === "bearer" && token) {
      try {
        const payload = verifyJwt(token);
        request.auth = {
          userId: typeof payload.sub === "string" ? payload.sub : "",
          tenantId: typeof payload.tenantId === "string" ? payload.tenantId : "",
          roles: Array.isArray(payload.roles) ? payload.roles.filter((value) => typeof value === "string") : [],
          token, strategy: "jwt", payload,
        };
      } catch (error) {
        return next(error);
      }
    } else if (process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_AUTH_HEADERS === "true") {
      request.auth = {
        userId: request.header("x-user-id") ?? "",
        tenantId: request.header("x-tenant-id") ?? "",
        roles: (request.header("x-role") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
        token: "", strategy: "dev-headers",
      };
    }
    next();
  }

  function requireAuth(request, response, next) {
    if (!request.auth) {
      return optionalAuth(request, response, (error) => error ? next(error) : requireAuth(request, response, next));
    }
    if (!request.auth.userId) return next(authError(401, "UNAUTHENTICATED", "Нэвтрэх шаардлагатай."));
    if (!request.auth.roles.includes(role)) return next(authError(403, "FORBIDDEN", "Энэ үйлдлийг хийх эрхгүй байна."));
    if (tenantRequired && !request.auth.tenantId) return next(authError(403, "TENANT_REQUIRED", "Дэлгүүрийн эрх шаардлагатай."));
    next();
  }

  return { optionalAuth, requireAuth };
}
