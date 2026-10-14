import { type AuthContext, loadPendingApprovals } from "@k2b/cloud/server";
import type { Context } from "hono";

export const loadInventoryApprovals = (c: Context<AuthContext>) => loadPendingApprovals(c, { app: "inventory" });
