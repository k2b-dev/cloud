import { expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import type { AppRegistryEntry } from "../contracts/registry";
import * as appEventDelivery from "../events/app-event-delivery";
import * as live from "../events/live";
import { stubConnections } from "../runtime/connections.test-fixture";
import * as linksRuntime from "../services/links/runtime";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import * as applicationPackage from "./application-package";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId, getProcessPlatformPermissions } from "./process-identity";
import * as processSync from "./process-sync";
import * as watcher from "./runtime-watcher";

test.each(["core", "inventory"])("%s enforces the cookie boundary and serves declared CLI modules behind authentication", async (appId) => {
  const secretStub = stubConnections({ appSecret: { current: "cli-test-only" } });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  const entries: unknown[] = [];
  // Only the methods used by startup are implemented; heartbeat transport is stubbed.
  const sync = { ephemeral: () => ({}), ready: async () => {} } as unknown as Sync;
  const spies = [
    spyOn(linksRuntime, "startLinksRuntime").mockResolvedValue(async () => {}),
    spyOn(applicationPackage, "registerApplicationPackage").mockResolvedValue(undefined),
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(sync);
      return { sync, stop: async () => processSync.unbindProcessSync() };
    }),
    spyOn(heartbeat, "createRegistryMembership").mockReturnValue({
      instanceId: "0123456789abcdef",
      register: async () => {},
      leave: async () => {},
      join: async () => {},
      publish: async () => {},
      adopt: async () => {},
      renew: async () => {},
    }),
    spyOn(heartbeat, "createHeartbeat").mockImplementation((_id, entry) => {
      entries.push(entry);
      return { start: async () => {}, stop: async () => {} };
    }),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "stopRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
    spyOn(appEventDelivery, "startAppEventDelivery").mockResolvedValue(null),
    spyOn(live, "startLiveOutbox").mockResolvedValue(null),
    spyOn(settingsService, "loadCache").mockResolvedValue(undefined),
    spyOn(settingsService, "get").mockResolvedValue("https://cloud.example.test"),
  ];
  try {
    const app = defineApp({
      id: appId,
      platformPermissions: ["mail:send"],
      name: "Inventory",
      icon: "ti ti-box",
      description: "Stock",
      baseUrl: "http://inventory:3000",
      routes: ["/api/inventory"],
      sessionlessRoutes: ["/api/inventory/hooks/:token"],
      cli: { inventory: { module: "src/cli.ts", references: "src/cli-references" } },
    });
    expect(app.meta.platformPermissions).toEqual(["mail:send"]);
    expect(app.meta.routes).toEqual(["/api/inventory", "/cli/plugins/inventory"]);
    const dispatched: { cookie: string | null } = { cookie: null };
    let dispatches = 0;
    const server = await app.start({
      fetch: (request) => {
        dispatches++;
        dispatched.cookie = request.headers.get("cookie");
        return new Response("application");
      },
    });
    const cookies = { Cookie: "session_token=fixture; pwa_session=phone" };
    // The app supplies a plain fetch handler with no auth or guard opt-in.
    for (const path of ["/api/inventory/write", "/app/inventory/action"]) {
      const before = dispatches;
      expect((await server.fetch(new Request(`http://inventory${path}`, { method: "POST", headers: cookies }))).status).toBe(403);
      expect(dispatches).toBe(before);
      expect(
        (
          await server.fetch(
            new Request(`http://inventory${path}`, { method: "POST", headers: { ...cookies, Origin: "https://cloud.example.test" } }),
          )
        ).status,
      ).toBe(200);
      expect(dispatched.cookie).toBe(cookies.Cookie);
    }
    expect(
      (await server.fetch(new Request("http://inventory/api/inventory/hooks/own-token", { method: "POST", headers: cookies }))).status,
    ).toBe(200);
    expect(dispatched.cookie).toBeNull();
    expect(settingsService.get).toHaveBeenCalledWith("app.url");
    expect(spies.at(-1)!.mock.calls.every(([key]) => key === "app.url")).toBe(true);
    const entry = entries.find((value): value is AppRegistryEntry => (value as AppRegistryEntry).id === appId)!;
    expect(entry.platformPermissions).toEqual(["mail:send"]);
    expect(getProcessPlatformPermissions()).toEqual(["mail:send"]);
    expect(entry.cliModules).toEqual(["inventory"]);
    expect(entry.routes).toEqual(["/api/inventory", "/cli/plugins/inventory"]);

    const plugin = await server.fetch(
      new Request("http://inventory/cli/plugins/inventory/manifest.json", { headers: { Accept: "application/json" } }),
    );
    expect(plugin.status).toBe(401);
    // Paths outside a declared module stay with the application.
    expect(await (await server.fetch(new Request("http://inventory/cli/plugins"))).text()).toBe("application");
  } finally {
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!previousListeners[index]!.has(listener)) process.off(signal, listener);
      }
    }
    processSync.unbindProcessSync();
    clearProcessApplicationId();
    for (const spy of spies.toReversed()) spy.mockRestore();
    secretStub.mockRestore();
  }
});

test("invalid CLI declarations fail at definition", () => {
  expect(() =>
    defineApp({
      id: "inventory",
      name: "Inventory",
      icon: "ti ti-box",
      description: "Stock",
      baseUrl: "http://inventory:3000",
      routes: [],
      cli: { "Bad Name": { module: "src/cli.ts", references: "src/cli-references" } },
    }),
  ).toThrow('App "inventory" declares CLI module "Bad Name"');
});
