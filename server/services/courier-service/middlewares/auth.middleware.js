import { createRoleAuth } from "../../../src/platform/http/role-auth.js";

export const { optionalAuth, requireAuth } = createRoleAuth("DELIVERY_EMPLOYEE");
