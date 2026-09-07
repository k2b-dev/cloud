import { describe, expect, test } from "bun:test";
import type { AppRegistryEntry } from "@valentinkolb/cloud/contracts";
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
      ["grids", "app-grids-queue", "app-grids-m1"],
      ["mail", "app-mail-queue", "app-mail-m1"],
    ]);
    expect(overview.truncatedStores).toEqual(["mail/app-mail-queue"]);
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

    const requeued = await service.requeueDeadLetter({ appId: "mail", store: "mail/deliveries", messageId: "m 1" }, credentials);
    expect(requeued).toEqual({
      ok: true,
      data: { receipt: { messageId: "m2", streamSequence: 7, duplicate: false }, idempotencyKey: "sync-ops:requeue:x" },
    });
    expect(calls[0]).toMatchObject({
      url: "http://core:3000/api/admin/sync/mail/dead-letters/mail%2Fdeliveries/requeue",
      method: "POST",
      body: JSON.stringify({ messageId: "m 1" }),
    });
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");

    const deleted = await service.deleteDeadLetter({ appId: "mail", store: "deliveries", messageId: "ghost" }, credentials);
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
