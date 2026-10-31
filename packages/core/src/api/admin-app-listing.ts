import { CapabilityAppIdSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, middleware, respond, v } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { removeAppListing } from "../app-listing";

export const createAdminAppListingRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  remove: typeof removeAppListing = removeAppListing,
) =>
  new Hono<AuthContext>().delete(
    "/:appId/listing",
    middleware.noTransform(),
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      return next();
    },
    authenticate,
    auth.requireOAuthScope("write", "admin"),
    middleware.openapi({ tags: ["Apps"], summary: "Remove an offline app from the administration listing without deleting its data" }),
    v("param", z.object({ appId: CapabilityAppIdSchema })),
    (c) =>
      respond(c, () =>
        remove({ appId: c.req.valid("param").appId, authority: auth.getAuthority(c), locale: getLocale(c), signal: c.req.raw.signal }),
      ),
  );
