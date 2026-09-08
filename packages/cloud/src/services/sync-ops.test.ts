import { describe, expect, test } from "bun:test";
import {
  ConflictError,
  type DeadLetter,
  type DeadLetterStore,
  NotFoundError,
  type ScheduleInfo,
  type Sync,
  type SyncControl,
  SyncUsageError,
} from "@k2b/sync";
import { Hono } from "hono";
import type { AuthContext } from "../server/middleware/auth";
import { createSyncOpsRoutes, type SyncOpsRoutesDependencies } from "./sync-ops";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const admin = { id: ADMIN_ID, uid: "admin", provider: "local", roles: ["admin"] } as AuthContext["Variables"]["user"];

type AuditCall = Parameters<NonNullable<SyncOpsRoutesDependencies["audit"]>["recordResultAfterSideEffect"]>[0];

const fakeStore = (entries: DeadLetter<unknown>[]) => {
  const items = [...entries];
  const calls: Array<{ op: "requeue" | "delete"; messageId: string; idempotencyKey?: string }> = [];
  const store: DeadLetterStore<unknown> = {
    list: async ({ limit } = {}) => items.slice(0, limit ?? items.length),
    requeue: async ({ messageId, idempotencyKey }) => {
      calls.push({ op: "requeue", messageId, idempotencyKey });
      const index = items.findIndex((item) => item.messageId === messageId);
      if (index < 0) throw new NotFoundError(`dead letter ${messageId}`);
      items.splice(index, 1);
      return { messageId: `re-${messageId}`, streamSequence: 42, duplicate: false };
    },
    delete: async ({ messageId }) => {
      calls.push({ op: "delete", messageId });
      const index = items.findIndex((item) => item.messageId === messageId);
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    },
  };
  return { store, calls, items };
};

const deadLetter = (messageId: string, data: unknown = { key: messageId }): DeadLetter<unknown> => ({
  messageId,
  data,
  tenantId: "default",
  attempts: 5,
  failedAt: new Date("2026-09-07T10:00:00.000Z"),
  reason: "max attempts exhausted",
  error: "boom",
});

const scheduleInfo = (id: string): ScheduleInfo => ({
  id,
  cron: "*/5 * * * *",
  timezone: "UTC",
  misfire: "latest",
  nextRunAt: new Date("2026-09-07T10:05:00.000Z"),
  runNumber: 3,
  failureCount: 0,
  handlerAvailable: true,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-07T09:00:00.000Z"),
  meta: { source: "test" },
});

const fakeSync = (controls: SyncControl[]) =>
  ({
    controls: () => controls,
    health: () => ({
      state: "ready",
      connection: "connected",
      pendingResources: 0,
      driftedResources: 0,
      activeWorkers: 1,
      activeHandlers: 0,
      droppedEvents: 0,
    }),
    resources: async () => [
      { namespace: "test", kind: "queue", id: "mail", owner: "mail", state: "ready", natsNames: ["x"], detail: { deadLetters: 2 } },
    ],
  }) as unknown as Sync;

const harness = () => {
  const controls: SyncControl[] = [];
  const audits: AuditCall[] = [];
  const routes = createSyncOpsRoutes(() => fakeSync(controls), {
    audit: {
      recordResultAfterSideEffect: async (params) => {
        audits.push(params as AuditCall);
        return params.result;
      },
    },
  });
  const app = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("user", admin);
      c.set("actor", { kind: "user", user: admin });
      await next();
    })
    .route("/", routes);
  const json = async (path: string, init?: RequestInit) => {
    const response = await app.request(path, init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { controls, audits, json };
};

describe("sync ops routes", () => {
  test("reports declared resources with local health", async () => {
    const { json } = harness();
    const { status, body } = await json("/resources");
    expect(status).toBe(200);
    expect(body.health).toMatchObject({ state: "ready" });
    expect(body.resources).toEqual([expect.objectContaining({ kind: "queue", id: "mail", detail: { deadLetters: 2 } })]);
  });

  test("lists every declared store with a bounded page and truncation flag", async () => {
    const { controls, json } = harness();
    const mail = fakeStore([deadLetter("a"), deadLetter("b"), deadLetter("c")]);
    const jobs = fakeStore([]);
    controls.push({ namespace: "test", owner: "test", id: "mail", kind: "queue", deadLetters: mail.store });
    controls.push({ namespace: "test", owner: "test", id: "reindex", kind: "job", deadLetters: jobs.store });

    const { status, body } = await json("/dead-letters?limit=2");
    expect(status).toBe(200);
    expect(body.stores).toEqual([
      {
        name: "mail",
        kind: "queue",
        description: null,
        truncated: true,
        entries: [
          {
            messageId: "a",
            tenantId: "default",
            attempts: 5,
            failedAt: "2026-09-07T10:00:00.000Z",
            reason: "max attempts exhausted",
            error: "boom",
            dataPreview: '{"key":"a"}',
          },
          expect.objectContaining({ messageId: "b" }),
        ],
      },
      { name: "reindex", kind: "job", description: null, truncated: false, entries: [] },
    ]);
    expect((await json("/dead-letters?limit=500")).status).toBe(400);
  });

  test("bounds the payload preview", async () => {
    const { controls, json } = harness();
    controls.push({
      namespace: "test",
      owner: "test",
      id: "big",
      kind: "queue",
      deadLetters: fakeStore([deadLetter("x", "y".repeat(5_000))]).store,
    });
    const { body } = await json("/dead-letters");
    const stores = body.stores as Array<{ entries: Array<{ dataPreview: string }> }>;
    expect(stores[0]?.entries[0]?.dataPreview.length).toBeLessThanOrEqual(1_025);
  });

  test("requeues with a generated idempotency key and audits the actor", async () => {
    const { controls, audits, json } = harness();
    const mail = fakeStore([deadLetter("a")]);
    controls.push({ namespace: "test", owner: "test", id: "mail", kind: "queue", deadLetters: mail.store });

    const { status, body } = await json("/dead-letters/queue/mail/requeue", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
      body: JSON.stringify({ messageId: "a" }),
    });
    expect(status).toBe(200);
    expect(body.receipt).toEqual({ messageId: "re-a", streamSequence: 42, duplicate: false });
    expect(body.idempotencyKey).toMatch(/^sync-ops:requeue:/);
    expect(mail.calls).toEqual([{ op: "requeue", messageId: "a", idempotencyKey: String(body.idempotencyKey) }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "sync.dead_letter.requeue",
      actor: { userId: ADMIN_ID, uid: "admin", roles: ["admin"] },
      target: { type: "sync_dead_letter", id: "a", label: "mail" },
      metadata: { kind: "queue", idempotencyKey: body.idempotencyKey },
      requestId: "req-1",
      result: { ok: true },
    });
  });

  test("maps missing stores and entries to 404 and still audits failed mutations", async () => {
    const { controls, audits, json } = harness();
    controls.push({ namespace: "test", owner: "test", id: "mail", kind: "queue", deadLetters: fakeStore([]).store });

    expect(
      (
        await json("/dead-letters/queue/nope/requeue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"messageId":"a"}',
        })
      ).status,
    ).toBe(404);
    const missing = await json("/dead-letters/queue/mail/requeue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "ghost" }),
    });
    expect(missing.status).toBe(404);
    expect((await json("/dead-letters/queue/mail/ghost", { method: "DELETE" })).status).toBe(404);
    expect(audits.map((entry) => [entry.action, entry.result.ok])).toEqual([
      ["sync.dead_letter.requeue", false],
      ["sync.dead_letter.delete", false],
    ]);
  });

  test("deletes a dead letter and audits it", async () => {
    const { controls, audits, json } = harness();
    const mail = fakeStore([deadLetter("a")]);
    controls.push({ namespace: "test", owner: "test", id: "mail", kind: "queue", deadLetters: mail.store });

    const { status, body } = await json("/dead-letters/queue/mail/a", { method: "DELETE" });
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: true });
    expect(mail.items).toEqual([]);
    expect(audits[0]).toMatchObject({ action: "sync.dead_letter.delete", target: { id: "a", label: "mail" } });
  });

  test("lists schedules tagged with their scheduler id", async () => {
    const { controls, json } = harness();
    controls.push({
      namespace: "test",
      owner: "test",
      kind: "scheduler",
      id: "mail",
      scheduler: {
        list: async () => [scheduleInfo("mail:sync-due")],
        runNow: async () => ({ runId: "r" }),
        awaitRun: async () => ({ completed: true }),
      },
    });
    controls.push({
      namespace: "test",
      owner: "test",
      kind: "scheduler",
      id: "core",
      scheduler: {
        list: async () => [scheduleInfo("core:cleanup")],
        runNow: async () => ({ runId: "r" }),
        awaitRun: async () => ({ completed: true }),
      },
    });

    const { status, body } = await json("/schedules");
    expect(status).toBe(200);
    expect(body.schedules).toEqual([
      {
        schedulerId: "mail",
        id: "mail:sync-due",
        cron: "*/5 * * * *",
        timezone: "UTC",
        misfire: "latest",
        nextRunAt: "2026-09-07T10:05:00.000Z",
        runNumber: 3,
        failureCount: 0,
        lastError: null,
        lastRunId: null,
        lastCompletedAt: null,
        handlerAvailable: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-07T09:00:00.000Z",
        meta: { source: "test" },
      },
      expect.objectContaining({ schedulerId: "core", id: "core:cleanup" }),
    ]);
  });

  test("runs a schedule now with a generated request id, then awaits the run", async () => {
    const { controls, audits, json } = harness();
    const runNowCalls: Array<{ id: string; requestId: string }> = [];
    const awaitCalls: Array<{ id: string; runId: string; timeoutMs?: number }> = [];
    controls.push({
      namespace: "test",
      owner: "test",
      kind: "scheduler",
      id: "mail",
      scheduler: {
        list: async () => [],
        runNow: async (input) => {
          runNowCalls.push(input);
          if (input.id === "missing") throw new NotFoundError("schedule");
          return { runId: "run-1" };
        },
        awaitRun: async (input) => {
          awaitCalls.push(input);
          return { completed: true, error: "handler failed" };
        },
      },
    });

    const accepted = await json("/schedules/mail/mail:sync-due/run-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.runId).toBe("run-1");
    expect(accepted.body.requestId).toMatch(/^sync-ops:run-now:/);
    expect(runNowCalls).toEqual([{ id: "mail:sync-due", requestId: String(accepted.body.requestId) }]);
    expect(audits[0]).toMatchObject({
      action: "sync.schedule.run_now",
      target: { type: "sync_schedule", id: "mail:sync-due", label: "mail" },
      metadata: { requestId: accepted.body.requestId, runId: "run-1" },
    });

    const explicit = await json("/schedules/mail/mail:sync-due/run-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "my-request" }),
    });
    expect(explicit.body.requestId).toBe("my-request");

    expect(
      (await json("/schedules/mail/missing/run-now", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(404);
    expect(
      (await json("/schedules/other/x/run-now", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(404);

    const run = await json("/schedules/mail/mail:sync-due/runs/run-1?timeoutMs=100");
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ completed: true, error: "handler failed" });
    expect(awaitCalls).toEqual([{ id: "mail:sync-due", runId: "run-1", timeoutMs: 100 }]);
  });

  test("distinguishes queue and job controls with the same id for list and mutations", async () => {
    const { controls, audits, json } = harness();
    const queue = fakeStore([deadLetter("shared")]);
    const job = fakeStore([deadLetter("shared")]);
    controls.push(
      { namespace: "test", owner: "test", id: "same", kind: "queue", deadLetters: queue.store },
      { namespace: "test", owner: "test", id: "same", kind: "job", deadLetters: job.store },
    );
    const listed = await json("/dead-letters");
    expect(listed.body.stores).toEqual([
      expect.objectContaining({ name: "same", kind: "queue" }),
      expect.objectContaining({ name: "same", kind: "job" }),
    ]);
    const requeued = await json("/dead-letters/job/same/requeue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "shared" }),
    });
    expect(requeued.status).toBe(200);
    expect(job.calls).toEqual([{ op: "requeue", messageId: "shared", idempotencyKey: String(requeued.body.idempotencyKey) }]);
    expect(queue.calls).toEqual([]);
    expect((await json("/dead-letters/queue/same/shared", { method: "DELETE" })).status).toBe(200);
    expect(queue.calls).toEqual([{ op: "delete", messageId: "shared" }]);
    expect(audits.map((entry) => entry.metadata?.kind)).toEqual(["job", "queue"]);
  });
});

test("topic dead letters retain consumer identity, replay without requeue, and audit failures", async () => {
  const { controls, audits, json } = harness();
  const calls: unknown[] = [];
  const entry = { ...deadLetter("42"), consumer: "postgres-writer", eventId: "original-event", replayAvailable: true };
  let failure: Error | undefined;
  controls.push({
    namespace: "test",
    owner: "gateway-ops",
    id: "telemetry",
    kind: "topic",
    deadLetters: {
      list: async () => [entry],
      get: async () => entry,
      delete: async () => true,
      replay: async (input) => {
        calls.push(input);
        if (failure) throw failure;
        return { messageId: input.messageId, eventId: entry.eventId, consumer: input.consumer, completed: true };
      },
    },
  });
  const listed = await json("/dead-letters");
  expect(listed.body.stores).toEqual([
    expect.objectContaining({
      kind: "topic",
      entries: [expect.objectContaining({ consumer: "postgres-writer", eventId: "original-event", replayAvailable: true })],
    }),
  ]);
  const request = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const input = { messageId: "42", consumer: "postgres-writer", tenantId: "default" };
  expect((await json("/dead-letters/topic/telemetry/requeue", request(input))).status).toBe(400);
  expect((await json("/dead-letters/topic/telemetry/replay", request({ messageId: "42" }))).status).toBe(400);
  expect(calls).toHaveLength(0);
  const replayed = await json("/dead-letters/topic/telemetry/replay", request(input));
  expect(replayed.body).toEqual({ messageId: "42", eventId: "original-event", consumer: "postgres-writer", completed: true });
  expect(calls[0]).toMatchObject({ ...input, timeoutMs: 30_000 });
  expect(audits[0]).toMatchObject({
    action: "sync.dead_letter.replay",
    actor: { userId: ADMIN_ID },
    metadata: { kind: "topic", consumer: "postgres-writer", tenantId: "default" },
    result: { ok: true },
  });
  failure = new Error("writer unavailable");
  expect((await json("/dead-letters/topic/telemetry/replay", request(input))).status).toBe(500);
  expect(audits[1]).toMatchObject({ action: "sync.dead_letter.replay", result: { ok: false } });
  failure = new ConflictError("The original consumer is already recovering this entry");
  expect((await json("/dead-letters/topic/telemetry/replay", request(input))).status).toBe(409);
  failure = new SyncUsageError("Historical entry has no original event context");
  expect((await json("/dead-letters/topic/telemetry/replay", request(input))).status).toBe(400);
  expect((await json("/dead-letters/topic/telemetry/42", { method: "DELETE" })).status).toBe(200);
});
