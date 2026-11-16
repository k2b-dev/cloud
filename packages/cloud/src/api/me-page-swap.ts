import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { PAGE_SWAP_FALLBACK_MAX_BYTES, type PageSwapFallbackReport, PageSwapFallbackReportSchema } from "../contracts/page-swap-fallback";
import { type AuthContext, requiresAuth, v } from "../server";
import { logger } from "../services/logging";

const log = logger("page-swap");

/** Mounted below /me's authentication, user guard and rate limit. Each report is one diagnostic log entry. */
export const createMePageSwapRoutes = (record: (report: PageSwapFallbackReport) => void = (report) => log.warn("fallback", report)) =>
  new Hono<AuthContext>().post(
    "/page-swap-fallbacks",
    describeRoute({
      tags: ["Me"],
      summary: "Report a page change that loaded the whole page",
      ...requiresAuth,
      responses: {
        204: { description: "Report recorded" },
        400: { description: "Invalid report" },
        413: { description: "Report too large" },
      },
    }),
    bodyLimit({ maxSize: PAGE_SWAP_FALLBACK_MAX_BYTES }),
    v("json", PageSwapFallbackReportSchema),
    async (c) => {
      if (!c.get("user")) return c.json({ message: "Authentication required" }, 401);
      record(c.req.valid("json"));
      return c.body(null, 204);
    },
  );
