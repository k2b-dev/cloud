import { describe, expect, test } from "bun:test";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { createSyncOpsService, isListedResource, type SyncResourceRow } from "./service";

const app = (id: string, name = id): AppRegistryEntry => ({
  id,
  name,
  icon: `ti ti-${id}`,
  description: "",
  baseUrl: `http://app-${id}:3000`,
  routes: [],
});

const health = {
  state: "ready",
  connection: "connected",
  pendingResources: 0,
  driftedResources: 0,
  activeWorkers: 1,
  activeHandlers: 0,
  droppedEvents: 0,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; method: string; headers: Headers; body: string | null };

const fakeFetch = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetchImpl = async (input: URL, init: RequestInit) => {
    const request = new Request(input, init);
    const call: Call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? null : await request.text(),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch: fetchImpl };
};

const credentials = { cookie: "session_token=abc", authorization: null, requestId: "req-1" };

describe("sync ops aggregation", () => {
  test("merges dead letters, resources, and schedules across apps and tags rows with the app", async () => {
    const { calls, fetch } = fakeFetch((call) => {
      const url = new URL(call.url);
      const targetAppId = url.pathname.split("/")[4];
      const targetHost = `app-${targetAppId}`;
      if (url.pathname.endsWith("/resources")) {
        return json({
          health,
          resources: [
            {
              namespace: "dev",
              kind: "queue",
              id: `${targetHost}-queue`,
              owner: targetHost,
              state: "ready",
              natsNames: [],
              detail: { deadLetters: 1, messages: 3 },
            },
            { namespace: "dev", kind: "topic", id: "events", owner: targetHost, state: "ready", natsNames: [] },
          ],
        });
      }
      if (url.pathname.endsWith("/dead-letters")) {
        return json({
          stores: [
            {
              name: `${targetHost}-queue`,
              kind: "queue",
              description: null,
              truncated: targetHost === "app-mail",
              entries: [
                {
                  messageId: `${targetHost}-m1`,
                  tenantId: "default",
                  attempts: 5,
                  failedAt: targetHost === "app-mail" ? "2026-09-07T10:00:00.000Z" : "2026-09-07T11:00:00.000Z",
                  reason: "max attempts exhausted",
                  error: null,
                  dataPreview: "{}",
                },
              ],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/schedules")) {
        return json({
          schedules: [
            {
              schedulerId: targetHost,
              id: `${targetHost}:tick`,
              cron: "* * * * *",
              timezone: "UTC",
              misfire: "latest",
              nextRunAt: targetHost === "app-mail" ? "2026-09-07T10:01:00.000Z" : "2026-09-07T10:00:30.000Z",
              runNumber: 1,
              failureCount: 0,
              lastError: null,
              lastRunId: null,
              lastCompletedAt: null,
              handlerAvailable: true,
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
              meta: null,
            },
          ],
        });
      }
      return json({ message: "not found" }, 404);
    });
    const service = createSyncOpsService({
      coreOrigin: async () => "http://core:3000",
      fetch,
      listApps: async () => [app("mail", "Mail"), app("grids", "Grids")],
    });

    const overview = await service.overview(credentials);

    expect(overview.apps.map((row) => [row.appId, row.status, row.health?.state])).toEqual([
      ["mail", "ok", "ready"],
      ["grids", "ok", "ready"],
    ]);
    expect(overview.deadLetters.map((row) => [row.appId, row.store, row.messageId])).toEqual([
      ["mail", "app-mail-queue", "app-mail-m1"],
      ["grids", "app-grids-queue", "app-grids-m1"],
    ]);
    expect(overview.truncatedStores).toEqual(["mail/queue/app-mail-queue"]);
    expect(overview.resources.map((row) => [row.appId, row.kind, row.deadLetters])).toEqual([
      ["mail", "queue", 1],
      ["mail", "topic", null],
      ["grids", "queue", 1],
      ["grids", "topic", null],
    ]);
    expect(overview.schedules.map((row) => [row.appId, row.schedulerId, row.id])).toEqual([
      ["grids", "app-grids", "app-grids:tick"],
      ["mail", "app-mail", "app-mail:tick"],
    ]);

    expect(calls).toHaveLength(6);
    expect(new Set(calls.map((call) => new URL(call.url).origin))).toEqual(new Set(["http://core:3000"]));
    for (const call of calls) {
      expect(call.headers.get("cookie")).toBe("session_token=abc");
      expect(call.headers.get("authorization")).toBeNull();
      expect(call.headers.get("x-request-id")).toBe("req-1");
    }
  });

  test("keeps the other apps when one app is unreachable or has no sync surface", async () => {
    const { fetch } = fakeFetch((call) => {
      const url = new URL(call.url);
      const targetAppId = url.pathname.split("/")[4];
      const targetHost = `app-${targetAppId}`;
      if (targetHost === "app-down") throw new Error("connect ECONNREFUSED");
      if (targetHost === "app-old") return json({ message: "Not Found" }, 404);
      if (url.pathname.endsWith("/resources")) return json({ health, resources: [] });
      if (url.pathname.endsWith("/dead-letters")) return json({ stores: [] });
      return json({ schedules: [] });
    });
    const service = createSyncOpsService({
      coreOrigin: async () => "http://core:3000",
      fetch,
      listApps: async () => [app("ok"), app("down"), app("old")],
    });

    const overview = await service.overview(credentials);

    expect(overview.apps.map((row) => [row.appId, row.status, row.error])).toEqual([
      ["ok", "ok", null],
      ["down", "unavailable", "connect ECONNREFUSED"],
      ["old", "unavailable", "Not Found"],
    ]);
    expect(overview.apps[1]?.health).toBeNull();
  });

  test("routes mutations to the owning app and maps upstream errors", async () => {
    const { calls, fetch } = fakeFetch((call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith("/requeue")) {
        return json({ receipt: { messageId: "m2", streamSequence: 7, duplicate: false }, idempotencyKey: "sync-ops:requeue:x" });
      }
      if (call.method === "DELETE") return json({ message: "Dead letter not found" }, 404);
      if (url.pathname.endsWith("/run-now")) return json({ runId: "run-1", requestId: "given" });
      if (url.pathname.includes("/runs/")) return json({ completed: false, error: null });
      return json({ message: "boom" }, 500);
    });
    const service = createSyncOpsService({ coreOrigin: async () => "http://core:3000", fetch, listApps: async () => [app("mail")] });

    const requeued = await service.requeueDeadLetter(
      { appId: "mail", kind: "queue", store: "mail/deliveries", messageId: "m 1" },
      credentials,
    );
    expect(requeued).toEqual({
      ok: true,
      data: { receipt: { messageId: "m2", streamSequence: 7, duplicate: false }, idempotencyKey: "sync-ops:requeue:x" },
    });
    expect(calls[0]).toMatchObject({
      url: "http://core:3000/api/admin/sync/mail/dead-letters/queue/mail%2Fdeliveries/requeue",
      method: "POST",
      body: JSON.stringify({ messageId: "m 1" }),
    });
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");

    const deleted = await service.deleteDeadLetter({ appId: "mail", kind: "queue", store: "deliveries", messageId: "ghost" }, credentials);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.error).toMatchObject({ status: 404, message: "Dead letter not found" });

    const run = await service.runScheduleNow(
      { appId: "mail", schedulerId: "mail", scheduleId: "mail:sync-due", requestId: "given" },
      credentials,
    );
    expect(run).toEqual({ ok: true, data: { runId: "run-1", requestId: "given" } });
    expect(calls[2]).toMatchObject({
      url: "http://core:3000/api/admin/sync/mail/schedules/mail/mail%3Async-due/run-now",
      body: JSON.stringify({ requestId: "given" }),
    });

    const pending = await service.getScheduleRun(
      { appId: "mail", schedulerId: "mail", scheduleId: "mail:sync-due", runId: "run-1", timeoutMs: 100 },
      credentials,
    );
    expect(pending).toEqual({ ok: true, data: { completed: false, error: null } });
    expect(calls[3]?.url).toBe("http://core:3000/api/admin/sync/mail/schedules/mail/mail%3Async-due/runs/run-1?timeoutMs=100");

    const unknownApp = await service.runScheduleNow({ appId: "nope", schedulerId: "x", scheduleId: "y" }, credentials);
    expect(unknownApp.ok).toBe(false);
    if (!unknownApp.ok) expect(unknownApp.error.status).toBe(404);
    expect(calls).toHaveLength(4);
  });

  test("extends the transport budget of a run poll by the time the app holds the request open", async () => {
    const respondAfter = async (delayMs: number, signal: AbortSignal | null | undefined): Promise<Response> => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
      return json({ completed: true, error: null });
    };
    const fetch = (_input: URL, init: RequestInit) => respondAfter(60, init.signal);
    const service = createSyncOpsService({
      coreOrigin: async () => "http://core:3000",
      fetch,
      listApps: async () => [app("mail")],
      timeoutMs: 20,
    });
    const run = { appId: "mail", schedulerId: "mail", scheduleId: "mail:sync-due", runId: "run-1" };

    const withinBudget = await service.getScheduleRun({ ...run, timeoutMs: 100 }, credentials);
    expect(withinBudget).toEqual({ ok: true, data: { completed: true, error: null } });

    const transportOnly = await service.getScheduleRun(run, credentials);
    expect(transportOnly.ok).toBe(false);
  });

  test("preserves kind when mutating same-name queue and job stores", async () => {
    const { calls, fetch } = fakeFetch(() => json({ deleted: true }));
    const service = createSyncOpsService({ coreOrigin: async () => "http://core:3000", fetch, listApps: async () => [app("mail")] });
    for (const kind of ["queue", "job"] as const) {
      expect((await service.deleteDeadLetter({ appId: "mail", kind, store: "same", messageId: "message" }, credentials)).ok).toBe(true);
    }
    expect(calls.map((call) => call.url)).toEqual([
      "http://core:3000/api/admin/sync/mail/dead-letters/queue/same/message",
      "http://core:3000/api/admin/sync/mail/dead-letters/job/same/message",
    ]);
  });

  test("keeps healthy apps when another broker response is malformed", async () => {
    for (const invalid of ["not-json", "null", "{}", '{"resources":[null],"stores":[],"schedules":[{}]}']) {
      const { fetch } = fakeFetch((call) => {
        if (new URL(call.url).pathname.includes("/bad/")) return new Response(invalid);
        if (call.url.endsWith("/resources")) return json({ health, resources: [] });
        if (call.url.endsWith("/dead-letters")) return json({ stores: [] });
        return json({ schedules: [] });
      });
      const service = createSyncOpsService({
        coreOrigin: async () => "http://core:3000",
        fetch,
        listApps: async () => [app("ok"), app("bad")],
      });
      const overview = await service.overview(credentials);
      expect(overview.apps.map((row) => [row.appId, row.status])).toEqual([
        ["ok", "ok"],
        ["bad", "unavailable"],
      ]);
    }
  });

  test("cancels chunked responses at the byte budget without trusting Content-Length", async () => {
    let cancelled = 0;
    const { fetch } = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-length": "1" } },
        ),
    );
    const service = createSyncOpsService({ coreOrigin: async () => "http://core:3000", fetch, listApps: async () => [app("bad")] });
    const overview = await service.overview(credentials);
    expect(overview.apps[0]).toMatchObject({ status: "unavailable", error: "Response too large" });
    expect(cancelled).toBe(3);
  });

  test("lists work resources always and other kinds only when they need attention", () => {
    const row = (kind: string, state: SyncResourceRow["state"], deadLetters: number | null = null): SyncResourceRow => ({
      namespace: "dev",
      kind,
      id: "x",
      owner: "app",
      state,
      natsNames: [],
      appId: "app",
      appName: "App",
      deadLetters,
    });
    expect(isListedResource(row("queue", "ready"))).toBe(true);
    expect(isListedResource(row("topic", "ready"))).toBe(false);
    expect(isListedResource(row("topic", "drifted"))).toBe(true);
    expect(isListedResource(row("ephemeral", "failed"))).toBe(true);
  });
});

test("aggregates topic recovery metadata and routes replay through Core without republishing", async () => {
  const { calls, fetch } = fakeFetch((call) => {
    if (call.url.endsWith("/resources")) return json({ health, resources: [] });
    if (call.url.endsWith("/schedules")) return json({ schedules: [] });
    if (call.url.endsWith("/dead-letters"))
      return json({
        stores: [
          {
            name: "telemetry",
            kind: "topic",
            description: null,
            truncated: false,
            entries: [
              {
                messageId: "42",
                eventId: "original",
                consumer: "postgres-writer",
                tenantId: "ops",
                replayAvailable: false,
                dataPreview: "{}",
                attempts: 5,
                failedAt: "2026-09-08T00:00:00Z",
                reason: "failed",
                error: null,
              },
            ],
          },
        ],
      });
    return json({ messageId: "42", eventId: "original", consumer: "postgres-writer", completed: true });
  });
  const service = createSyncOpsService({ listApps: async () => [app("gateway")], fetch, coreOrigin: async () => "http://core:3000" });
  const overview = await service.overview(credentials);
  expect(overview.apps[0]?.status).toBe("ok");
  expect(overview.deadLetters[0]).toMatchObject({
    kind: "topic",
    consumer: "postgres-writer",
    eventId: "original",
    replayAvailable: false,
  });
  const result = await service.replayDeadLetter(
    { appId: "gateway", store: "telemetry", messageId: "42", consumer: "postgres-writer", tenantId: "ops" },
    credentials,
  );
  expect(result.ok).toBe(true);
  expect(calls.at(-1)).toMatchObject({
    url: "http://core:3000/api/admin/sync/gateway/dead-letters/topic/telemetry/replay",
    method: "POST",
    body: JSON.stringify({ messageId: "42", consumer: "postgres-writer", tenantId: "ops" }),
  });
});

test("DLQ pages and details preserve encoded store identity, cursor and payload bounds", async () => {
  const entry = {
    messageId: "message:id",
    tenantId: "tenant",
    attempts: 3,
    failedAt: "2026-09-08T12:00:00.000Z",
    reason: "failed",
    error: "complete error",
    dataPreview: "{}",
    streamSequence: 42,
    dataPreviewTruncated: false,
    dataPreviewLimitBytes: 16384,
  };
  const { calls, fetch } = fakeFetch((call) =>
    new URL(call.url).pathname.endsWith("message%3Aid")
      ? json({ entry, sampledAt: "2026-09-08T12:00:00.000Z" })
      : json({
          store: { name: "mail:hydrate", kind: "job", description: null, entries: [entry], truncated: true },
          nextCursor: "42",
          sampledAt: "2026-09-08T12:00:00.000Z",
        }),
  );
  const service = createSyncOpsService({ listApps: async () => [app("mail")], fetch, coreOrigin: async () => "http://core:3000" });
  const page = await service.listDeadLetters({ appId: "mail", kind: "job", store: "mail:hydrate", limit: 10, cursor: "30" }, credentials);
  expect(page).toMatchObject({ ok: true, data: { nextCursor: "42", store: { entries: [entry] } } });
  expect(calls[0]?.url).toBe("http://core:3000/api/admin/sync/mail/dead-letters/job/mail%3Ahydrate?limit=10&cursor=30");
  const detail = await service.getDeadLetter(
    { appId: "mail", kind: "job", store: "mail:hydrate", messageId: "message:id", sequence: 42 },
    credentials,
  );
  expect(detail).toMatchObject({ ok: true, data: { entry } });
  expect(calls[1]?.url).toContain("/mail%3Ahydrate/message%3Aid?sequence=42");
  expect(calls.every((call) => call.method === "GET" && call.headers.get("cookie") === credentials.cookie)).toBe(true);
});

test("overview filters target apps before dispatch and retains only affected resources", async () => {
  const { calls, fetch } = fakeFetch((call) => {
    if (call.url.endsWith("/resources"))
      return json({
        health,
        resources: [
          { namespace: "dev", kind: "queue", id: "broken", owner: "mail", state: "failed", natsNames: [] },
          { namespace: "dev", kind: "queue", id: "healthy", owner: "mail", state: "ready", natsNames: [] },
        ],
      });
    return json(call.url.endsWith("/schedules") ? { schedules: [] } : { stores: [] });
  });
  const service = createSyncOpsService({
    listApps: async () => [app("mail"), app("pulse")],
    fetch,
    coreOrigin: async () => "http://core:3000",
  });
  const result = await service.overview(credentials, { app: "mail", resource: "broken", problems: true });
  expect(result.resources.map((entry) => entry.id)).toEqual(["broken"]);
  expect(result.apps.map((entry) => entry.appId)).toEqual(["mail"]);
  expect(Number.isFinite(Date.parse(result.sampledAt))).toBe(true);
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.url.includes("/sync/mail/"))).toBe(true);
});
