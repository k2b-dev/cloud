/**
 * Fleet-wide sync operations API. Reads and mutations fan out to the owning
 * app's `/_internal/sync` surface with the caller's credentials, so every
 * mutation is audited by the app that owns the resource.
 */

import { ok } from "@k2b/stdlib";
import { type AuthContext, auth, rateLimit, respond, v } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { z } from "zod";
import { syncOpsService } from "./runtime";
import { syncOpsCredentials } from "./service";

const DeadLetterParamSchema = z.object({
  kind: z.enum(["queue", "job"]),
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

  /** Dead letters, resources, and schedules of every reachable app. */
  .get("/", async (c) => respond(c, ok(await syncOpsService.overview(syncOpsCredentials(c.req.raw)))))

  .post("/dead-letters/:app/:kind/:store/requeue", v("param", DeadLetterParamSchema), v("json", RequeueBodySchema), async (c) => {
    const { app, kind, store } = c.req.valid("param");
    const { messageId } = c.req.valid("json");
    return respond(c, syncOpsService.requeueDeadLetter({ appId: app, kind, store, messageId }, syncOpsCredentials(c.req.raw)));
  })

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
