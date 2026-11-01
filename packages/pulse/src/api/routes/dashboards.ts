import { type AuthContext, auth, jsonResponse, REQUEST_IDLE_TIMEOUT_SECONDS, type Result, setRequestTimeout, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { DashboardRangeSchema, DashboardSaveSchema } from "../../dashboard-contracts";
import { readDashboardPanel, readPublicDashboard } from "../../service/dashboard-panels";
import { dashboards } from "../../service/dashboards";
import { DashboardPanelResultSchema, DashboardSchema, DashboardsPageSchema, PublicDashboardSchema } from "../dashboard-schemas";

const ErrorBody = z.object({ code: z.string(), message: z.string() });
const metadata = (summary: string, schema: z.ZodType, status: 200 | 201 = 200) =>
  describeRoute({
    tags: ["Pulse"],
    summary,
    responses: {
      [status]: jsonResponse(schema, summary),
      400: jsonResponse(ErrorBody, "Invalid dashboard"),
      403: jsonResponse(ErrorBody, "Base access required"),
      404: jsonResponse(ErrorBody, "Dashboard not found"),
      409: jsonResponse(ErrorBody, "Revision or idempotency conflict"),
      503: jsonResponse(ErrorBody, "Store unavailable"),
    },
  });
const identity = (c: Context<AuthContext>) => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  baseId: c.req.param("baseId")!,
  requestId: c.req.header("x-request-id"),
});
const answer = <T>(c: Context<AuthContext>, result: Result<T>, status: 200 | 201 = 200) =>
  result.ok ? c.json(result.data, status) : c.json(result.error, result.error.status);
const timed = async <T>(c: Context<AuthContext>, work: () => Promise<T>) => {
  setRequestTimeout(c, 55);
  try {
    return await work();
  } finally {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  }
};
const Revision = z.object({ expectedRevision: z.number().int().positive() }).strict();
const routes = new Hono<AuthContext>()
  .get(
    "/bases/:baseId/dashboards",
    metadata("List dashboards in a readable Pulse base", DashboardsPageSchema),
    v(
      "query",
      z.object({ limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().nonnegative().optional() }),
    ),
    async (c) => answer(c, await dashboards.list({ ...identity(c), ...c.req.valid("query") })),
  )
  .get("/bases/:baseId/dashboards/:dashboardId", metadata("Read a Pulse dashboard", DashboardSchema), async (c) =>
    answer(c, await dashboards.get({ ...identity(c), dashboardId: c.req.param("dashboardId")! })),
  )
  .post(
    "/bases/:baseId/dashboards",
    metadata("Create a Pulse dashboard", DashboardSchema, 201),
    v("json", DashboardSaveSchema),
    async (c) =>
      answer(c, await dashboards.save({ ...identity(c), ...c.req.valid("json"), idempotencyKey: c.req.header("idempotency-key") }), 201),
  )
  .patch(
    "/bases/:baseId/dashboards/:dashboardId",
    metadata("Update a Pulse dashboard at its revision", DashboardSchema),
    v("json", DashboardSaveSchema.extend({ expectedRevision: z.number().int().positive() })),
    async (c) =>
      answer(
        c,
        await dashboards.save({
          ...identity(c),
          ...c.req.valid("json"),
          dashboardId: c.req.param("dashboardId")!,
          idempotencyKey: c.req.header("idempotency-key"),
        }),
      ),
  )
  .post(
    "/bases/:baseId/dashboards/:dashboardId/publish",
    metadata("Publish reviewed dashboard output columns", z.object({ href: z.string(), revision: z.number() })),
    v("json", Revision.extend({ columns: z.record(z.string(), z.array(z.string()).min(1).max(32)) })),
    async (c) =>
      answer(
        c,
        await dashboards.publish({
          ...identity(c),
          dashboardId: c.req.param("dashboardId")!,
          ...c.req.valid("json"),
          idempotencyKey: c.req.header("idempotency-key"),
        }),
      ),
  )
  .post(
    "/bases/:baseId/dashboards/:dashboardId/unpublish",
    metadata("Revoke a dashboard publication", z.object({ deleted: z.boolean(), revision: z.number() })),
    v("json", Revision),
    async (c) =>
      answer(
        c,
        await dashboards.remove({
          ...identity(c),
          dashboardId: c.req.param("dashboardId")!,
          ...c.req.valid("json"),
          unpublish: true,
          idempotencyKey: c.req.header("idempotency-key"),
        }),
      ),
  )
  .delete(
    "/bases/:baseId/dashboards/:dashboardId",
    metadata("Delete a Pulse dashboard", z.object({ deleted: z.boolean(), revision: z.number() })),
    v("json", Revision),
    async (c) =>
      answer(
        c,
        await dashboards.remove({
          ...identity(c),
          dashboardId: c.req.param("dashboardId")!,
          ...c.req.valid("json"),
          idempotencyKey: c.req.header("idempotency-key"),
        }),
      ),
  )
  .get(
    "/bases/:baseId/dashboards/:dashboardId/panels/:panelId",
    metadata("Read or refresh a dashboard panel", DashboardPanelResultSchema),
    v("query", DashboardRangeSchema),
    async (c) =>
      timed(c, async () =>
        answer(
          c,
          await readDashboardPanel({
            identity: identity(c),
            baseId: c.req.param("baseId")!,
            dashboardId: c.req.param("dashboardId")!,
            panelId: c.req.param("panelId")!,
            range: c.req.valid("query"),
            signal: c.req.raw.signal,
          }),
        ),
      ),
  );
export default routes;
export const publicDashboardRoutes = new Hono<AuthContext>()
  .use("/public/*", auth.requireRole("*"))
  .use("/public/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  })
  .get("/public/:token", metadata("Read a published dashboard without SQL or parameters", PublicDashboardSchema), async (c) =>
    answer(c, await readPublicDashboard(c.req.param("token")!)),
  )
  .get(
    "/public/:token/panels/:panelId",
    metadata("Read or refresh a published dashboard panel", DashboardPanelResultSchema),
    v("query", DashboardRangeSchema),
    async (c) =>
      timed(c, async () =>
        answer(
          c,
          await readDashboardPanel({
            token: c.req.param("token")!,
            panelId: c.req.param("panelId")!,
            range: c.req.valid("query"),
            signal: c.req.raw.signal,
          }),
        ),
      ),
  );
