import { type AuthContext, jsonResponse, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { OverviewSchema } from "../../overview-contracts";
import { readOverview } from "../../service/overview";

const ErrorBody = z.object({ code: z.string(), message: z.string() });
const routes = new Hono<AuthContext>().get(
  "/bases/:baseId/overview",
  describeRoute({
    tags: ["Pulse"],
    summary: "Read a base overview and its bounded cached key numbers",
    responses: {
      200: jsonResponse(OverviewSchema, "Authorized overview with original measurement timestamps"),
      400: jsonResponse(ErrorBody, "Invalid pagination"),
      403: jsonResponse(ErrorBody, "Base read access required"),
      404: jsonResponse(ErrorBody, "Base not found"),
      503: jsonResponse(ErrorBody, "Overview unavailable"),
    },
  }),
  v(
    "query",
    z.object({
      attentionLimit: z.coerce.number().int().min(1).max(1000).optional(),
      attentionOffset: z.coerce.number().int().nonnegative().optional(),
      activityLimit: z.coerce.number().int().min(1).max(1000).optional(),
      activityCursor: z.string().max(200).optional(),
    }),
  ),
  async (c) => {
    setRequestTimeout(c, 60);
    try {
      const result = await readOverview({
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
        baseId: c.req.param("baseId")!,
        signal: c.req.raw.signal,
        ...c.req.valid("query"),
      });
      return result.ok ? c.json(result.data) : c.json(result.error, result.error.status);
    } finally {
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
    }
  },
);
export default routes;
