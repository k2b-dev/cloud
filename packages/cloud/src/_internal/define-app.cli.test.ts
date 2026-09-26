import { expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { env } from "../config/env";
import type { AppRegistryEntry } from "../contracts/registry";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import * as watcher from "./runtime-watcher";

test("declared CLI modules are advertised, routed, and served behind authentication", async () => {
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "cli-test-only", configurable: true });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  const entries: unknown[] = [];
  // Only the methods used by startup are implemented; heartbeat transport is stubbed.
  const sync = { ephemeral: () => ({}), ready: async () => {} } as unknown as Sync;
  const spies = [
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(sync);
      return { sync, stop: async () => processSync.unbindProcessSync() };
    }),
    spyOn(heartbeat, "createHeartbeat").mockImplementation((_id, entry) => {
      entries.push(entry);
      return { start: async () => {}, stop: async () => {} };
    }),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "stopRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
    spyOn(settingsService, "loadCache").mockResolvedValue(undefined),
  ];
  try {
    const app = defineApp({
      id: "inventory",
      name: "Inventory",
      icon: "ti ti-box",
      description: "Stock",
      baseUrl: "http://inventory:3000",
      routes: ["/api/inventory"],
      cli: { inventory: { module: "src/cli.ts", references: "src/cli-references" } },
    });
    expect(app.meta.routes).toEqual(["/api/inventory", "/cli/plugins/inventory"]);
    const server = await app.start({ fetch: () => new Response("application") });
    const entry = entries.find((value): value is AppRegistryEntry => (value as AppRegistryEntry).id === "inventory")!;
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
    Object.defineProperty(env, "APP_SECRET", originalSecret);
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
