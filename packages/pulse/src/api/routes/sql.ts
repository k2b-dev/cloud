import { type AuthContext, jsonResponse, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout, v } from "@k2b/cloud/server";
import { Hono, type Context } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { savedQueries } from "../../service/saved-queries";
import { baseSqlLimits, cancelBaseSql, runBaseSql } from "../../service/sql-service";

import { SavedQueriesPageSchema, SavedQuerySchema, SqlLimitsSchema, SqlResultSchema } from "../sql-schemas";

const Params = z.record(z.string(), z.string());
const Run = z.object({ sql: z.string(), params: Params.optional(), runId: z.uuid().optional() }).strict();
const Save = z.object({ name: z.string(), sql: z.string(), params: Params.optional() }).strict();
const Patch = Save.extend({ expectedRevision: z.number().int().positive() }).strict();
const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  retryAfter: z.number().optional(),
  resetAt: z.string().optional(),
});
const responses = {
  400: jsonResponse(ErrorBody, "Invalid SQL or parameters"),
  403: jsonResponse(ErrorBody, "Read or write access required"),
  409: jsonResponse(ErrorBody, "Saved query revision or idempotency conflict"),
  422: jsonResponse(ErrorBody, "Query time, memory or result limit reached"),
  429: jsonResponse(ErrorBody, "Hourly quota reached; Retry-After indicates reset"),
  503: jsonResponse(ErrorBody, "Pulse busy or store unavailable"),
};
const metadata = (summary: string, schema: z.ZodType, status: 200 | 201 = 200) =>
  describeRoute({ tags: ["Pulse"], summary, responses: { ...responses, [status]: jsonResponse(schema, summary) } });
const identity = (c: Context<AuthContext>) => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  baseId: c.req.param("baseId")!,
});
const answer = <T>(
  c: Context<AuthContext>,
  result:
    | { ok: true; data: T }
    | {
        ok: false;
        error: {
          code: string;
          message: string;
          status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
          line?: number;
          column?: number;
          retryAfter?: number;
          resetAt?: string;
        };
      },
  successStatus: 200 | 201 = 200,
) => {
  if (!result.ok) {
    const error = result.error;
    const extras: Record<string, unknown> = {};
    for (const key of ["line", "column", "retryAfter", "resetAt"] as const) if (key in error) extras[key] = error[key];
    if ("retryAfter" in error) c.header("Retry-After", String(error.retryAfter));
    return c.json({ code: error.code, message: error.message, ...extras }, error.status);
  }
  return c.json(result.data, successStatus);
};
const routes = new Hono<AuthContext>()
  .post("/bases/:baseId/sql", metadata("Run read-only SQL in one Pulse base", SqlResultSchema), v("json", Run), async (c) => {
    // 5 s queue + largest profile 30 s + 2 s HTTP + 5 s KILL + replies.
    setRequestTimeout(c, 45);
    try {
      return answer(c, await runBaseSql({ ...identity(c), ...c.req.valid("json"), signal: c.req.raw.signal, via: "api" }));
    } finally {
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
    }
  })
  .post(
    "/bases/:baseId/sql/cancel",
    metadata("Cancel this actor's Pulse SQL run", z.object({ cancelled: z.boolean() })),
    v("json", z.object({ runId: z.uuid() }).strict()),
    async (c) => answer(c, await cancelBaseSql({ ...identity(c), ...c.req.valid("json") })),
  )
  .get("/bases/:baseId/sql/limits", metadata("Read Pulse SQL limits and hourly quota", SqlLimitsSchema), async (c) =>
    answer(c, await baseSqlLimits(identity(c))),
  )
  .get(
    "/bases/:baseId/queries",
    metadata("List saved queries in one Pulse base", SavedQueriesPageSchema),
    v(
      "query",
      z.object({ limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().nonnegative().optional() }),
    ),
    async (c) => answer(c, await savedQueries.list({ ...identity(c), ...c.req.valid("query") })),
  )
  .get("/bases/:baseId/queries/:queryId", metadata("Read a saved Pulse query", SavedQuerySchema), async (c) =>
    answer(c, await savedQueries.get({ ...identity(c), queryId: c.req.param("queryId") })),
  )
  .post("/bases/:baseId/queries", metadata("Save a Pulse SQL query", SavedQuerySchema, 201), v("json", Save), async (c) =>
    answer(c, await savedQueries.save({ ...identity(c), ...c.req.valid("json"), idempotencyKey: c.req.header("idempotency-key") }), 201),
  )
  .patch(
    "/bases/:baseId/queries/:queryId",
    metadata("Update a saved Pulse query at an expected revision", SavedQuerySchema),
    v("json", Patch),
    async (c) => {
      const input = { ...identity(c), queryId: c.req.param("queryId")! };
      return answer(c, await savedQueries.save({ ...input, ...c.req.valid("json"), idempotencyKey: c.req.header("idempotency-key") }));
    },
  )
  .delete("/bases/:baseId/queries/:queryId", metadata("Delete a saved Pulse query", z.object({ deleted: z.boolean() })), async (c) => {
    const result = await savedQueries.remove({ ...identity(c), queryId: c.req.param("queryId") });
    return result.ok ? c.json({ deleted: true }) : answer(c, result);
  });
export default routes;
