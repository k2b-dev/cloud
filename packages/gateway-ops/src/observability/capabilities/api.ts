/**
 * Capability execution history API.
 *
 * The same rows the admin page renders, so a script or agent can answer "what
 * did the assistant actually do" without scraping HTML. Read-only: the
 * dispatcher owns every write to this history.
 */

import { listCapabilityExecutions, summarizeCapabilityExecutions } from "@k2b/cloud/capabilities/store";
import { type AuthContext, auth, rateLimit, respond, v } from "@k2b/cloud/server";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import { ORIGIN_FILTERS, STATUS_FILTERS, WINDOWS, type WindowFilter } from "./filters";

const WINDOW_MS: Record<WindowFilter, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

const FilterQuerySchema = z.object({
  app: z.string().trim().min(1).max(200).optional(),
  capability: z.string().trim().min(1).max(200).optional(),
  origin: z.enum(ORIGIN_FILTERS).default("all"),
  status: z.enum(STATUS_FILTERS).default("all"),
  user: z.string().uuid().optional(),
  destructive: z.coerce.boolean().default(false),
  window: z.enum(WINDOWS).default("24h"),
});

const ListQuerySchema = FilterQuerySchema.extend({
  cursor: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type FilterQuery = z.infer<typeof FilterQuerySchema>;

const storeFilter = (query: FilterQuery) => ({
  ...(query.app ? { appId: query.app } : {}),
  ...(query.capability ? { capability: query.capability } : {}),
  ...(query.origin === "all" ? {} : { origin: query.origin }),
  ...(query.status === "all" ? {} : { status: query.status }),
  ...(query.user ? { userId: query.user } : {}),
  ...(query.destructive ? { destructive: true } : {}),
  since: new Date(Date.now() - WINDOW_MS[query.window]),
});

const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))

  /** Counts and latency for one range — the call that answers "is anything failing". */
  .get("/", v("query", FilterQuerySchema), async (c) =>
    respond(c, ok(await summarizeCapabilityExecutions(storeFilter(c.req.valid("query"))))),
  )

  .get("/executions", v("query", ListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const page = await listCapabilityExecutions({
      ...storeFilter(query),
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return respond(c, ok(page));
  })

  /**
   * One correlated call. The request ID is the correlation key shared with the
   * app audit row and the request logs, so it is the identifier an operator
   * already has; a request that dispatched several capabilities returns each.
   */
  .get("/executions/:requestId", v("param", z.object({ requestId: z.string().trim().min(1).max(200) })), async (c) => {
    const { items } = await listCapabilityExecutions({ requestId: c.req.valid("param").requestId, limit: 50 });
    return respond(c, items.length > 0 ? ok({ items }) : fail(err.notFound("Capability execution")));
  });

export default app;
export type ApiType = typeof app;
