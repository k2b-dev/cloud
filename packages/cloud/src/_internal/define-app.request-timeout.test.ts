import { expect, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { Sync } from "@k2b/sync";
import { Hono } from "hono";
import { z } from "zod";
import { env } from "../config/env";
import { defineCapabilities } from "../contracts/capabilities";
import * as invocationMiddleware from "../server/middleware/invocation";
import { REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "../server/request-timeout";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { compileCapabilities } from "./capabilities";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import * as registry from "./registry";
import * as watcher from "./runtime-watcher";

test("forwards the Bun server and owns capability JSON timeouts until success or failure", async () => {
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "request-timeout-test-only", configurable: true });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  const unused = (): never => {
    throw new Error("Unexpected Sync operation in request timeout test");
  };
  const sync: Sync = {
    ready: async () => {},
    drain: unused,
    health: unused,
    resources: unused,
    controls: unused,
    events: unused,
    topic: unused,
    listTopics: unused,
    queue: unused,
    job: unused,
    ephemeral: unused,
    objectStore: unused,
    mutex: unused,
    pump: unused,
    scheduler: unused,
  };
  const subjectId = "11111111-1111-4111-8111-111111111111";
  let entered = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  let fail = false;
  let runStarts = 0;
  const run = async () => {
    runStarts += 1;
    entered.resolve();
    await release.promise;
    if (fail) throw new Error("app failed");
    return ok({ data: {} });
  };
  const capabilities = defineCapabilities({
    protocolVersion: 2,
    queries: {
      read: {
        title: "Read",
        description: "Read a result.",
        input: z.object({}).strict(),
        data: z.object({}).strict(),
        openWorld: false,
        run,
      },
    },
    actions: {
      update: {
        title: "Update",
        description: "Update an item.",
        input: z.object({}).strict(),
        data: z.object({}).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "none",
        run,
        review: async () => {
          await run();
          return ok({ message: "Update item?" });
        },
      },
    },
  });
  const manifest = compileCapabilities("timeout-test", capabilities).manifest;
  const spies = [
    spyOn(invocationMiddleware, "requireInvocation").mockImplementation(() => async (c, next) => {
      c.set("actor", {
        kind: "service_account",
        serviceAccount: {
          id: subjectId,
          name: "Test",
          kind: "standalone",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-10-20T00:00:00Z",
        },
        delegatedUser: null,
        scopes: [],
        credentialId: subjectId,
      });
      c.set("accessSubject", { type: "service_account", serviceAccountId: subjectId });
      c.set("credentialKind", "invocation");
      return next();
    }),
    spyOn(settingsService, "get").mockResolvedValue("en"),
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(sync);
      return { sync, stop: async () => processSync.unbindProcessSync() };
    }),
    spyOn(registry, "appRegistry").mockReturnValue({
      ready: unused,
      upsert: unused,
      touch: unused,
      delete: unused,
      snapshot: unused,
      watch: unused,
    }),
    spyOn(registry, "capabilityRegistry").mockReturnValue({
      ready: unused,
      upsert: unused,
      touch: unused,
      delete: unused,
      snapshot: unused,
      watch: unused,
    }),
    spyOn(heartbeat, "createHeartbeat").mockReturnValue({ start: async () => {}, stop: async () => {} }),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "stopRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
    spyOn(settingsService, "loadCache").mockResolvedValue(undefined),
  ];
  try {
    const router = new Hono().get("/api/timeout-test", (c) => {
      setRequestTimeout(c, 42);
      return c.text("ok");
    });
    const app = defineApp({
      id: "timeout-test",
      name: "Timeout test",
      icon: "ti ti-clock",
      description: "Request timeout forwarding",
      baseUrl: "http://timeout-test:3000",
      routes: ["/api/timeout-test"],
    });
    const started = await app.start({ fetch: router.fetch, capabilities });
    const calls: { request: Request; seconds: number }[] = [];
    const fakeServer = {
      timeout(request: Request, seconds: number) {
        calls.push({ request, seconds });
      },
    };
    const request = new Request("http://timeout-test/api/timeout-test");
    const response = await started.fetch(request, fakeServer);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toBe(request);
    expect(calls[0]?.seconds).toBe(42);
    expect(started.idleTimeout).toBe(REQUEST_IDLE_TIMEOUT_SECONDS);
    for (const [path, seconds, hash] of [
      ["queries/read", 55, manifest.queries[0]!.schemaHash],
      ["actions/update", 40, manifest.actions[0]!.schemaHash],
      ["actions/update/review", 25, manifest.actions[0]!.schemaHash],
    ] as const) {
      for (fail of [false, true]) {
        calls.length = 0;
        entered = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        const invocationRequest = new Request(`http://timeout-test/api/_internal/capabilities/v1/${path}`, {
          method: "POST",
          headers: { "x-cloud-capability-schema-hash": hash },
          body: '{"input":{}}',
        });
        const pending = started.fetch(invocationRequest, fakeServer);
        try {
          await entered.promise;
          expect(calls.map((call) => call.seconds)).toEqual([seconds]);
        } finally {
          release.resolve();
        }
        expect((await pending).status).toBe(fail ? 500 : 200);
        expect(calls.map((call) => call.seconds)).toEqual([seconds, 10]);
        expect(calls.every((call) => call.request === invocationRequest)).toBe(true);
      }
    }
    const beforeAbort = runStarts;
    const releaseBody = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    const delayedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        preparing.resolve();
        await releaseBody.promise;
        controller.enqueue(new TextEncoder().encode('{"input":{}}'));
        controller.close();
      },
    });
    const controller = new AbortController();
    try {
      const pending = started.fetch(
        new Request("http://timeout-test/api/_internal/capabilities/v1/queries/read", {
          method: "POST",
          signal: controller.signal,
          headers: { "x-cloud-capability-schema-hash": manifest.queries[0]!.schemaHash },
          body: delayedBody,
        }),
        fakeServer,
      );
      await preparing.promise;
      controller.abort();
      releaseBody.resolve();
      expect((await pending).status).toBe(499);
      expect(runStarts).toBe(beforeAbort);
    } finally {
      releaseBody.resolve();
    }
  } finally {
    release.resolve();
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!previousListeners[index]!.has(listener)) process.off(signal, listener);
      }
    }
    processSync.unbindProcessSync();
    clearProcessApplicationId();
    for (const spy of spies.toReversed()) spy.mockRestore();
    Object.defineProperty(env, "APP_SECRET", originalSecret);
  }
});
