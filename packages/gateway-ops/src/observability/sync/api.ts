/**
 * Fleet-wide sync operations API. Reads and mutations fan out to the owning
 * app's `/_internal/sync` surface with the caller's credentials, so every
 * mutation is audited by the app that owns the resource.
 */

import { ok } from "@k2b/stdlib";
import { type AuthContext, auth, rateLimit, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { syncOpsService } from "./runtime";
import { syncOpsCredentials } from "./service";

const OverviewQuerySchema = z.object({
  app: z.string().min(1).max(200).optional(),
  resource: z.string().min(1).max(96).optional(),
  problems: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .max(16)
    .optional(),
});
const DetailQuerySchema = z.object({ sequence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
const DeadLetterParamSchema = z.object({
  kind: z.enum(["queue", "job", "topic"]),
  app: z.string().min(1).max(200),
  store: z.string().min(1).max(96),
});
const DeadLetterEntryParamSchema = DeadLetterParamSchema.extend({ messageId: z.string().min(1).max(256) });
const RequeueBodySchema = z.object({ messageId: z.string().min(1).max(256) });
const ScheduleParamSchema = z.object({
  app: z.string().min(1).max(200),
  scheduler: z.string().min(1).max(96),
  id: z.string().min(1).max(96),
});
const RunParamSchema = ScheduleParamSchema.extend({ runId: z.string().min(1).max(256) });
const RunNowBodySchema = z.object({ requestId: z.string().min(1).max(128).optional() });
const RunQuerySchema = z.object({ timeoutMs: z.coerce.number().int().min(0).max(30_000).optional() });

const syncApiRoutes = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))
  .use(auth.requireOAuthScope("admin"))

  /** Dead letters, resources, and schedules of every reachable app. */
  .get(
    "/",
    describeRoute({
      tags: ["Sync"],
      summary: "Inspect Sync app health, resources, schedules and bounded dead-letter previews",
      description:
        "Optional app, resource and problems filters. sampledAt identifies this snapshot; dead-letter previews are bounded per store, oldest first.",
    }),
    v("query", OverviewQuerySchema),
    async (c) => respond(c, ok(await syncOpsService.overview(syncOpsCredentials(c.req.raw), c.req.valid("query")))),
  )

  .get(
    "/dead-letters/:app/:kind/:store",
    describeRoute({
      tags: ["Sync"],
      summary: "Page through one dead-letter store",
      description: "Oldest-first bounded broker page. Pass nextCursor unchanged to continue; cursors survive deletion of previous entries.",
    }),
    v("param", DeadLetterParamSchema),
    v("query", PageQuerySchema),
    async (c) => {
      const { app, kind, store } = c.req.valid("param");
      return respond(
        c,
        syncOpsService.listDeadLetters({ appId: app, kind, store, ...c.req.valid("query") }, syncOpsCredentials(c.req.raw)),
      );
    },
  )
  .get(
    "/dead-letters/:app/:kind/:store/:messageId",
    describeRoute({
      tags: ["Sync"],
      summary: "Inspect a dead letter",
      description:
        "Returns original error, tenant and consumer context plus an explicitly bounded UTF-8 payload preview. Queue and job details require the streamSequence from the list as the sequence query parameter. Missing or deleted entries return 404.",
    }),
    v("param", DeadLetterEntryParamSchema),
    v("query", DetailQuerySchema),
    async (c) => {
      const { app, kind, store, messageId } = c.req.valid("param");
      return respond(
        c,
        syncOpsService.getDeadLetter({ appId: app, kind, store, messageId, ...c.req.valid("query") }, syncOpsCredentials(c.req.raw)),
      );
    },
  )

  .post("/dead-letters/:app/:kind/:store/requeue", v("param", DeadLetterParamSchema), v("json", RequeueBodySchema), async (c) => {
    const { app, kind, store } = c.req.valid("param");
    const { messageId } = c.req.valid("json");
    return respond(c, syncOpsService.requeueDeadLetter({ appId: app, kind, store, messageId }, syncOpsCredentials(c.req.raw)));
  })

  .post(
    "/dead-letters/:app/topic/:store/replay",
    v("param", DeadLetterParamSchema.omit({ kind: true })),
    v(
      "json",
      z.object({
        messageId: z.string().min(1).max(256),
        consumer: z.string().min(1).max(96),
        tenantId: z.string().min(1).max(256),
      }),
    ),
    async (c) => {
      const { app, store } = c.req.valid("param");
      return respond(c, syncOpsService.replayDeadLetter({ appId: app, store, ...c.req.valid("json") }, syncOpsCredentials(c.req.raw)));
    },
  )

  .delete("/dead-letters/:app/:kind/:store/:messageId", v("param", DeadLetterEntryParamSchema), async (c) => {
    const { app, kind, store, messageId } = c.req.valid("param");
    return respond(c, syncOpsService.deleteDeadLetter({ appId: app, kind, store, messageId }, syncOpsCredentials(c.req.raw)));
  })

  .post("/schedules/:app/:scheduler/:id/run-now", v("param", ScheduleParamSchema), v("json", RunNowBodySchema), async (c) => {
    const { app, scheduler, id } = c.req.valid("param");
    const { requestId } = c.req.valid("json");
    return respond(
      c,
      syncOpsService.runScheduleNow({ appId: app, schedulerId: scheduler, scheduleId: id, requestId }, syncOpsCredentials(c.req.raw)),
    );
  })

  .get("/schedules/:app/:scheduler/:id/runs/:runId", v("param", RunParamSchema), v("query", RunQuerySchema), async (c) => {
    const { app, scheduler, id, runId } = c.req.valid("param");
    const { timeoutMs } = c.req.valid("query");
    return respond(
      c,
      syncOpsService.getScheduleRun(
        { appId: app, schedulerId: scheduler, scheduleId: id, runId, timeoutMs },
        syncOpsCredentials(c.req.raw),
      ),
    );
  });

export type SyncApiType = typeof syncApiRoutes;

export default syncApiRoutes;
