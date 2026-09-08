/** Process-local Sync controls, exposed through Cloud's authenticated invocation boundary. */
import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  ConflictError,
  type DeadLetter,
  NotFoundError,
  type PublishReceipt,
  type ScheduleInfo,
  type Sync,
  SyncUsageError,
} from "@k2b/sync";
import { Hono } from "hono";
import { z } from "zod";
import { respond } from "../server/api/respond";
import type { AuthContext, RequestActor } from "../server/middleware/auth";
import { v } from "../server/middleware/validator";
import { type AuditActor, audit } from "./audit";

export type SyncDeadLetterKind = "queue" | "job" | "topic";

export type SyncDeadLetterEntry = {
  messageId: string;
  tenantId: string;
  attempts: number;
  failedAt: string;
  reason: string;
  error: string | null;
  /** Bounded JSON preview of the payload; the full message stays in the store. */
  dataPreview: string;
  consumer?: string;
  eventId?: string;
  replayAvailable?: boolean;
};

export type SyncDeadLetterStoreView = {
  name: string;
  kind: SyncDeadLetterKind;
  description: string | null;
  entries: SyncDeadLetterEntry[];
  /** True when the store holds more entries than the requested limit. */
  truncated: boolean;
};

export type SyncScheduleView = {
  schedulerId: string;
  id: string;
  cron: string;
  timezone: string;
  misfire: ScheduleInfo["misfire"];
  nextRunAt: string;
  runNumber: number;
  failureCount: number;
  lastError: string | null;
  lastRunId: string | null;
  lastCompletedAt: string | null;
  handlerAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  meta: ScheduleInfo["meta"] | null;
};

export const SYNC_OPS_DEAD_LETTER_LIMIT = { default: 20, max: 100 } as const;
const DATA_PREVIEW_BYTES = 1_024;
const RUN_AWAIT_TIMEOUT = { default: 5_000, max: 30_000 } as const;

const iso = (value: Date): string => value.toISOString();

const previewData = (data: unknown): string => {
  let json: string;
  try {
    json = JSON.stringify(data) ?? "null";
  } catch {
    return "[unserializable]";
  }
  return json.length > DATA_PREVIEW_BYTES ? `${json.slice(0, DATA_PREVIEW_BYTES)}…` : json;
};

const toEntry = (entry: DeadLetter<unknown>): SyncDeadLetterEntry => ({
  messageId: entry.messageId,
  tenantId: entry.tenantId,
  attempts: entry.attempts,
  failedAt: iso(entry.failedAt),
  reason: entry.reason,
  error: entry.error ?? null,
  dataPreview: previewData(entry.data),
});

const toScheduleView = (schedulerId: string, info: ScheduleInfo): SyncScheduleView => ({
  schedulerId,
  id: info.id,
  cron: info.cron,
  timezone: info.timezone,
  misfire: info.misfire,
  nextRunAt: iso(info.nextRunAt),
  runNumber: info.runNumber,
  failureCount: info.failureCount,
  lastError: info.lastError ?? null,
  lastRunId: info.lastRunId ?? null,
  lastCompletedAt: info.lastCompletedAt ? iso(info.lastCompletedAt) : null,
  handlerAvailable: info.handlerAvailable,
  createdAt: iso(info.createdAt),
  updatedAt: iso(info.updatedAt),
  meta: info.meta ?? null,
});

const auditActor = (actor: RequestActor | undefined): AuditActor | null => {
  if (!actor) return null;
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (user) return { userId: user.id, uid: user.uid, provider: user.provider, roles: user.roles };
  return actor.kind === "service_account" ? { uid: actor.serviceAccount.name, roles: [] } : null;
};

const asFailure = <T>(error: unknown, notFoundLabel: string): Result<T> => {
  if (error instanceof NotFoundError) return fail(err.notFound(notFoundLabel));
  if (error instanceof ConflictError) return fail(err.conflict(error.message));
  if (error instanceof SyncUsageError) return fail(err.badInput(error.message));
  return fail(err.internal(error instanceof Error ? error.message : String(error)));
};

const DeadLettersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(SYNC_OPS_DEAD_LETTER_LIMIT.max).default(SYNC_OPS_DEAD_LETTER_LIMIT.default),
});
const DeadLetterNameParamSchema = z.object({ kind: z.enum(["queue", "job", "topic"]), name: z.string().min(1).max(96) });
const DeadLetterEntryParamSchema = DeadLetterNameParamSchema.extend({ messageId: z.string().min(1).max(256) });
const ReplayBodySchema = z.object({
  messageId: z.string().min(1).max(256),
  consumer: z.string().min(1).max(96),
  tenantId: z.string().min(1).max(256),
});
const RequeueBodySchema = z.object({ messageId: z.string().min(1).max(256) });
const ScheduleParamSchema = z.object({ scheduler: z.string().min(1).max(96), id: z.string().min(1).max(96) });
const RunParamSchema = ScheduleParamSchema.extend({ runId: z.string().min(1).max(256) });
const RunNowBodySchema = z.object({ requestId: z.string().min(1).max(128).optional() });
const RunQuerySchema = z.object({
  timeoutMs: z.coerce.number().int().min(0).max(RUN_AWAIT_TIMEOUT.max).default(RUN_AWAIT_TIMEOUT.default),
});

export type SyncOpsRoutesDependencies = {
  audit?: Pick<typeof audit, "recordResultAfterSideEffect">;
};

/**
 * Internal JSON surface for one app process. Mount under `/_internal/sync`
 * behind the admin gate; `getSync` is called lazily per request so the router
 * can be built before the sync runtime exists.
 */
export const createSyncOpsRoutes = (getSync: () => Sync, dependencies: SyncOpsRoutesDependencies = {}) => {
  const auditLog = dependencies.audit ?? audit;

  const stores = () =>
    getSync()
      .controls()
      .filter((entry) => entry.kind !== "scheduler");
  const schedulers = () =>
    getSync()
      .controls()
      .filter((entry) => entry.kind === "scheduler");
  const findStore = (kind: SyncDeadLetterKind, name: string) => stores().find((entry) => entry.kind === kind && entry.id === name) ?? null;
  const findScheduler = (name: string) => schedulers().find((entry) => entry.id === name) ?? null;

  return (
    new Hono<AuthContext>()
      /** Declared resources with their provisioning state plus the local runtime health. */
      .get("/resources", async (c) => {
        const sync = getSync();
        const resources = await sync.resources();
        return respond(c, ok({ health: sync.health(), resources }));
      })

      /** Every declared dead-letter store with a bounded page of entries. */
      .get("/dead-letters", v("query", DeadLettersQuerySchema), async (c) => {
        const { limit } = c.req.valid("query");
        const entries = await Promise.all(
          stores().map(async (registration): Promise<SyncDeadLetterStoreView> => {
            const page: SyncDeadLetterEntry[] =
              registration.kind === "topic"
                ? (await registration.deadLetters.list({ limit: limit + 1 })).map((entry) => ({
                    ...toEntry(entry),
                    consumer: entry.consumer,
                    eventId: entry.eventId,
                    replayAvailable: entry.replayAvailable,
                  }))
                : (await registration.deadLetters.list({ limit: limit + 1 })).map(toEntry);
            return {
              name: registration.id,
              kind: registration.kind,
              description: null,
              entries: page.slice(0, limit),
              truncated: page.length > limit,
            };
          }),
        );
        return respond(c, ok({ stores: entries }));
      })

      /** Re-enqueue one dead letter with a fresh idempotency key; removes the DLQ entry. */
      .post("/dead-letters/:kind/:name/requeue", v("param", DeadLetterNameParamSchema), v("json", RequeueBodySchema), async (c) => {
        const { kind, name } = c.req.valid("param");
        const { messageId } = c.req.valid("json");
        const store = findStore(kind, name);
        if (!store) return respond(c, fail(err.notFound("Dead-letter store")));
        if (store.kind === "topic") return respond(c, fail(err.badInput("Topic dead letters must be replayed to their original consumer")));
        const idempotencyKey = `sync-ops:requeue:${crypto.randomUUID()}`;
        const result = await store.deadLetters
          .requeue({ messageId, idempotencyKey })
          .then((receipt) => ok({ receipt, idempotencyKey }))
          .catch((error: unknown) => asFailure<{ receipt: PublishReceipt; idempotencyKey: string }>(error, "Dead letter"));
        await auditLog.recordResultAfterSideEffect({
          action: "sync.dead_letter.requeue",
          actor: auditActor(c.get("actor")),
          target: { type: "sync_dead_letter", id: messageId, label: name },
          metadata: { kind: store.kind, idempotencyKey },
          requestId: c.req.header("x-request-id") ?? null,
          result,
        });
        return respond(c, result);
      })

      /** Retry the original consumer with the same event identity; never publish a new event. */
      .post(
        "/dead-letters/topic/:name/replay",
        v("param", z.object({ name: z.string().min(1).max(96) })),
        v("json", ReplayBodySchema),
        async (c) => {
          const { name } = c.req.valid("param");
          const input = c.req.valid("json");
          const store = findStore("topic", name);
          if (!store || store.kind !== "topic") return respond(c, fail(err.notFound("Topic dead-letter store")));
          const result = await store.deadLetters
            .replay({ ...input, timeoutMs: 30_000, signal: c.req.raw.signal })
            .then((receipt) => ok(receipt))
            .catch((error: unknown) =>
              asFailure<{ messageId: string; eventId: string; consumer: string; completed: true }>(error, "Dead letter"),
            );
          await auditLog.recordResultAfterSideEffect({
            action: "sync.dead_letter.replay",
            actor: auditActor(c.get("actor")),
            target: { type: "sync_dead_letter", id: input.messageId, label: name },
            metadata: { kind: "topic", consumer: input.consumer, tenantId: input.tenantId },
            requestId: c.req.header("x-request-id") ?? null,
            result,
          });
          return respond(c, result);
        },
      )

      /** Drop one dead letter permanently. */
      .delete("/dead-letters/:kind/:name/:messageId", v("param", DeadLetterEntryParamSchema), async (c) => {
        const { kind, name, messageId } = c.req.valid("param");
        const store = findStore(kind, name);
        if (!store) return respond(c, fail(err.notFound("Dead-letter store")));
        const result = await store.deadLetters
          .delete({ messageId })
          .then((deleted) => (deleted ? ok({ deleted: true }) : fail(err.notFound("Dead letter"))))
          .catch((error: unknown) => asFailure<{ deleted: boolean }>(error, "Dead letter"));
        await auditLog.recordResultAfterSideEffect({
          action: "sync.dead_letter.delete",
          actor: auditActor(c.get("actor")),
          target: { type: "sync_dead_letter", id: messageId, label: name },
          metadata: { kind: store.kind },
          requestId: c.req.header("x-request-id") ?? null,
          result,
        });
        return respond(c, result);
      })

      /** Schedules of every declared scheduler, each row tagged with its scheduler id. */
      .get("/schedules", async (c) => {
        const schedules = (
          await Promise.all(
            schedulers().map(async (registration) =>
              (await registration.scheduler.list()).map((info) => toScheduleView(registration.id, info)),
            ),
          )
        ).flat();
        return respond(c, ok({ schedules }));
      })

      /** Durably accept a manual run; the requestId dedupes repeats within the broker window. */
      .post("/schedules/:scheduler/:id/run-now", v("param", ScheduleParamSchema), v("json", RunNowBodySchema), async (c) => {
        const { scheduler: schedulerId, id } = c.req.valid("param");
        const requestId = c.req.valid("json").requestId ?? `sync-ops:run-now:${crypto.randomUUID()}`;
        const registration = findScheduler(schedulerId);
        if (!registration) return respond(c, fail(err.notFound("Scheduler")));
        const result = await registration.scheduler
          .runNow({ id, requestId })
          .then(({ runId }) => ok({ runId, requestId }))
          .catch((error: unknown) => asFailure<{ runId: string; requestId: string }>(error, "Schedule"));
        await auditLog.recordResultAfterSideEffect({
          action: "sync.schedule.run_now",
          actor: auditActor(c.get("actor")),
          target: { type: "sync_schedule", id, label: schedulerId },
          metadata: { requestId, runId: result.ok ? result.data.runId : null },
          requestId: c.req.header("x-request-id") ?? null,
          result,
        });
        return respond(c, result);
      })

      /** Wait briefly for a manual run to settle; `completed: false` means it is still pending. */
      .get("/schedules/:scheduler/:id/runs/:runId", v("param", RunParamSchema), v("query", RunQuerySchema), async (c) => {
        const { scheduler: schedulerId, id, runId } = c.req.valid("param");
        const { timeoutMs } = c.req.valid("query");
        const registration = findScheduler(schedulerId);
        if (!registration) return respond(c, fail(err.notFound("Scheduler")));
        const result = await registration.scheduler
          .awaitRun({ id, runId, timeoutMs })
          .then((run) => ok({ completed: run.completed, error: run.error ?? null }))
          .catch((error: unknown) => asFailure<{ completed: boolean; error: string | null }>(error, "Schedule"));
        return respond(c, result);
      })
  );
};

export type SyncOpsRoutes = ReturnType<typeof createSyncOpsRoutes>;
