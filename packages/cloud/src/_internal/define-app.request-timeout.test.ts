import { expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { Hono } from "hono";
import { env } from "../config/env";
import { REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "../server/request-timeout";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import * as registry from "./registry";
import * as watcher from "./runtime-watcher";

test("passes the original Request and Bun server to application fetch with the default idle timeout", async () => {
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
  const spies = [
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
    const started = await app.start({ fetch: router.fetch });
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
  } finally {
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
