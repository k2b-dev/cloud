import { CapabilityAppIdSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, err, fail, getDateConfig, getLocale, middleware, ok, respond, v } from "@k2b/cloud/server";
import { canReadAppAdministration } from "@k2b/cloud/services";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { createAppStatusReader } from "../../../app-status";
import { appsFormat, providerValues } from "./format";
import { appsPageMessages } from "./page-messages";

/**
 * "Try again" on the app page: the app's provider values once more, rendered in the request's locale exactly as the page
 * renders them, so the refreshed row reads the same as after a reload.
 */
export const createAdminAppStatusRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>().get(
    "/:appId/status",
    middleware.noTransform(),
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      return next();
    },
    authenticate,
    middleware.openapi({ tags: ["Apps"], summary: "Read an app's traffic and error values for the Apps page" }),
    v("param", z.object({ appId: CapabilityAppIdSchema })),
    (c) =>
      respond(c, async () => {
        const authority = auth.getAuthority(c);
        if (!canReadAppAdministration(authority)) return fail(err.forbidden("Cloud administration authority is required."));
        const locale = getLocale(c);
        const { appId } = c.req.valid("param");
        const summaries = await createAppStatusReader().readAppStatusSummaries({
          authority,
          appIds: [appId],
          window: "24h",
          locale,
          signal: c.req.raw.signal,
        });
        const t = appsPageMessages.resolve([locale]).t;
        return ok(providerValues(t, appsFormat(getDateConfig(c)), summaries.byApp.get(appId) ?? [], summaries.failures.length > 0));
      }),
  );
