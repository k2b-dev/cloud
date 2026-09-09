import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { type AccessResourceType, validateAccessPermission } from "../service/access";
import { accessEntryRoutes } from "./access-entry-routes";
import { accessResourceRoutes } from "./access-resource-routes";

export const validateAccessLevelForResource = (resourceType: AccessResourceType, permission: string): string | null =>
  validateAccessPermission(resourceType, permission);

const accessRoutes = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .route("/", accessResourceRoutes)
  .route("/", accessEntryRoutes);

export default accessRoutes;
