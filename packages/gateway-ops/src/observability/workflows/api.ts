/**
 * Workflow run operations API.
 *
 * The same data the admin page renders, so scripts and agents can answer "is
 * any workflow broken" without scraping HTML. The two writes mirror the
 * kernel's safe controls: cancellation and an explicit effect decision.
 */
import { type AuthContext, auth, rateLimit, respond, v } from "@k2b/cloud/server";
import {
  getWorkflowRun,
  listStrandedWorkflowEffects,
  listUndispatchedWorkflowEvents,
  listWorkflowRuns,
  requestWorkflowRunCancel,
  resolveWorkflowRunAttention,
  type WorkflowAttentionResolution,
  workflowHealth,
} from "@k2b/cloud/workflows/store";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";

const WindowSchema = z.enum(["1h", "24h", "7d", "30d"]).default("24h");
const StateSchema = z.enum(["all", "queued", "running", "waiting", "succeeded", "failed", "canceled", "needs_attention"]).default("all");
const ModeSchema = z.enum(["all", "execute", "dryRun"]).default("all");
const FindingsQuerySchema = z.object({
  app: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const WINDOW_MS: Record<z.infer<typeof WindowSchema>, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const RunsQuerySchema = z.object({
  app: z.string().optional(),
  scope: z.string().optional(),
  workflow: z.string().uuid().optional(),
  parent: z.string().uuid().optional(),
  state: StateSchema,
  mode: ModeSchema,
  /** Children are noise until you are looking at their parent. */
  children: z.coerce.boolean().default(false),
  window: WindowSchema,
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))

  /** Per-app health — the one call that answers "is anything broken right now". */
  .get("/", v("query", z.object({ window: WindowSchema })), async (c) => {
    const { window } = c.req.valid("query");
    return respond(c, ok({ items: await workflowHealth({ since: new Date(Date.now() - WINDOW_MS[window]) }) }));
  })

  .get("/runs", v("query", RunsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const items = await listWorkflowRuns({
      appId: query.app,
      scopeId: query.scope,
      workflowId: query.workflow,
      parentRunId: query.parent,
      state: query.state === "all" ? undefined : query.state,
      mode: query.mode === "all" ? undefined : query.mode,
      includeChildren: query.children,
      since: new Date(Date.now() - WINDOW_MS[query.window]),
      limit: query.per_page,
      offset: (query.page - 1) * query.per_page,
    });
    return respond(c, ok({ items }));
  })

  /** One run with its steps, its cause and what it spent. */
  .get("/runs/:id", v("param", z.object({ id: z.string().uuid() })), async (c) => {
    const run = await getWorkflowRun(c.req.valid("param").id);
    return respond(c, run ? ok(run) : fail(err.notFound("Workflow run")));
  })

  .post("/runs/:id/cancel", v("param", z.object({ id: z.string().uuid() })), async (c) => {
    const canceled = await requestWorkflowRunCancel(c.req.valid("param").id);
    return respond(
      c,
      canceled
        ? ok({ canceled: true as const })
        : fail({
            code: "CONFLICT",
            message: "Workflow run is already terminal or does not exist",
            status: 409,
          }),
    );
  })

  .post(
    "/runs/:id/attention/:step",
    v("param", z.object({ id: z.string().uuid(), step: z.string().min(1).max(1000) })),
    v(
      "json",
      z.discriminatedUnion("state", [
        z.object({ state: z.literal("succeeded"), output: z.unknown().optional() }),
        z.object({ state: z.literal("failed"), message: z.string().min(1).max(2000), code: z.string().min(1).max(200).optional() }),
      ]),
    ),
    async (c) => {
      const { id, step } = c.req.valid("param");
      try {
        await resolveWorkflowRunAttention({
          runId: id,
          stepKey: step,
          resolution: c.req.valid("json") as WorkflowAttentionResolution,
        });
        return respond(c, ok({ resolved: true as const }));
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "workflow run is not awaiting resolution for that step") throw error;
        return respond(
          c,
          fail({
            code: "CONFLICT",
            message: error.message,
            status: 409,
          }),
        );
      }
    },
  )

  /** Effects that left the process and never reported back. */
  .get("/effects", v("query", FindingsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    return respond(
      c,
      ok({
        items: await listStrandedWorkflowEffects({
          appId: query.app,
          limit: query.limit,
          offset: (query.page - 1) * query.limit,
        }),
      }),
    );
  })

  /** Events that never turned into runs — the silent failure mode. */
  .get("/events", v("query", FindingsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    return respond(
      c,
      ok({
        items: await listUndispatchedWorkflowEvents({
          appId: query.app,
          limit: query.limit,
          offset: (query.page - 1) * query.limit,
        }),
      }),
    );
  });

export default app;
export type ApiType = typeof app;
