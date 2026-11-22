import { type AuthContext, auth, getLocale, middleware, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { CodeUsageForbidden, CodeUsageUnavailable, readCodeUsage } from "../code/usage";
import { codeUsageRoute } from "../code/usage-contracts";

/**
 * `GET /api/code/usage` (`codeUsageRoute`): which Code pages and automations read one resource. Members in their own
 * browser session ask; `readCodeUsage` checks the resource with its reader as the person before it reads any call.
 */
export const createCodeUsageRoutes = (deps = { read: readCodeUsage }) =>
  new Hono<AuthContext>().use("*", middleware.noTransform(), auth.requireRole("authenticated")).get(
    "/",
    middleware.openapi({ tags: ["Code"], summary: "List the Code pages and automations that read a resource this person may read" }),
    v("query", codeUsageRoute.input, () => ({ code: "BAD_INPUT", message: "Invalid Code usage request." })),
    async (c) => {
      c.header("Cache-Control", "no-store");
      try {
        const data = await deps.read(
          { ref: c.req.valid("query") },
          { authority: auth.getAuthority(c), locale: getLocale(c), signal: c.req.raw.signal },
        );
        return c.json({ data: codeUsageRoute.data.parse(data) });
      } catch (error) {
        if (error instanceof CodeUsageForbidden) return c.json({ code: "code_usage_forbidden" }, 403);
        if (error instanceof CodeUsageUnavailable) return c.json({ code: "code_usage_unavailable" }, 503);
        throw error;
      }
    },
  );
