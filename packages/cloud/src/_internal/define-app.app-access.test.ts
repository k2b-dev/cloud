import { expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { Hono } from "hono";
import { env } from "../config/env";
import { appAccess } from "../contracts/app-access";
import { defineHelp } from "../server/help";
import * as authMiddleware from "../server/middleware/auth";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { defineApp } from "./define-app";
import { inventory, person } from "./define-app.test-fixture";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import { APP_READINESS_PATH } from "./readiness";
import * as watcher from "./runtime-watcher";

test("the framework gate precedes real CLI/OpenAPI/application mounts while assets and readiness remain independent", async () => {
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "gate-test-only", configurable: true });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  const sync = { ephemeral: () => ({}), ready: async () => {} } as unknown as Sync;
  let authenticated = 0,
    appCalls = 0;
  const spies = [
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(sync);
      return { sync, stop: async () => processSync.unbindProcessSync() };
    }),
    spyOn(heartbeat, "createHeartbeat").mockReturnValue({ start: async () => {}, stop: async () => {} }),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "stopRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
    spyOn(settingsService, "loadCache").mockResolvedValue(undefined),
    spyOn(authMiddleware, "loadAuthenticatedActor").mockImplementation(async (c) => {
      authenticated++;
      c.set("actor", { kind: "user", user: person });
      c.set("accessSubject", { type: "user", userId: person.id });
      c.set("credentialKind", "session");
      return { token: "test-session", user: person, actor: c.get("actor") };
    }),
  ];
  try {
    const app = defineApp({
      ...inventory,
      access: appAccess.roles(["admin"], { publicRoutes: ["/public-route/:token"] }),
      openapi: "/api/inventory/openapi.json",
      cli: { inventory: { module: "src/cli.ts", references: "src/cli-references" } },
    });
    const result = await app.start({
      help: defineHelp({ documents: ["---\nid: start\ntitle: Start\n---\nPrivate help."] }),
      fetch: () => {
        appCalls++;
        return new Response("private app response");
      },
      openapi: new Hono().get("/", (c) => c.json({})),
    });
    for (const path of [
      "/cli/plugins/inventory/manifest.json",
      "/api/inventory/openapi.json",
      "/app/inventory",
      "/api/inventory",
      "/help",
      "/help/start",
    ]) {
      const response = await result.fetch(new Request(`http://inventory${path}`));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "app_access_denied", app: "inventory" });
    }
    expect(appCalls).toBe(0);
    const prior = authenticated;
    expect((await result.fetch(new Request(`http://inventory${APP_READINESS_PATH}`))).status).toBe(200);
    expect((await result.fetch(new Request("http://inventory/_ssr/missing.js"))).status).toBe(404);
    expect((await result.fetch(new Request("http://inventory/public/missing.js"))).status).toBe(404);
    expect(authenticated).toBe(prior);
    expect((await result.fetch(new Request("http://inventory/public-route/token"))).status).toBe(200);
    expect(appCalls).toBe(1);
  } finally {
    for (const [index, signal] of signals.entries())
      for (const listener of process.listeners(signal)) {
        if (!previousListeners[index]!.has(listener)) process.off(signal, listener);
      }
    processSync.unbindProcessSync();
    clearProcessApplicationId();
    for (const spy of spies.toReversed()) spy.mockRestore();
    Object.defineProperty(env, "APP_SECRET", originalSecret);
  }
});
