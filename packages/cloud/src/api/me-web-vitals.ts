import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { WEB_VITALS_MAX_BYTES, type WebVitalsReport, WebVitalsReportSchema } from "../contracts/web-vitals";
import { type AuthContext, requiresAuth, v } from "../server";
import { logger } from "../services/logging";

const log = logger("web-vitals");

/** Mounted below /me's authentication, user guard and rate limit. Client reports are diagnostics, not audit facts. */
export const createMeWebVitalsRoutes = (record: (report: WebVitalsReport) => void = (report) => log.info(report.name, report)) =>
  new Hono<AuthContext>().post(
    "/web-vitals",
    describeRoute({
      tags: ["Me"],
      summary: "Report browser page performance",
      ...requiresAuth,
      responses: {
        204: { description: "Report accepted" },
        400: { description: "Invalid report" },
        413: { description: "Report too large" },
      },
    }),
    bodyLimit({ maxSize: WEB_VITALS_MAX_BYTES }),
    v("json", WebVitalsReportSchema),
    (c) => {
      if (!c.get("user")) return c.json({ message: "Authentication required" }, 401);
      record(c.req.valid("json"));
      return c.body(null, 204);
    },
  );
