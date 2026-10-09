import { spyOn } from "bun:test";
import type { Sync } from "@k2b/sync";
import { env } from "../config/env";
import type { AppRegistryEntry } from "../contracts/registry";
import type { User } from "../contracts/shared";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { type AppOptions, defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import * as watcher from "./runtime-watcher";

export const inventory = {
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Count what is on the shelf",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory", "/app/inventory"],
} satisfies AppOptions;

/** Invented demo account. */
export const person = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
} satisfies User;

/** Starts the app with registry, sync and settings stubbed and returns the registry entry it publishes. */
export const publishedEntry = async (options: AppOptions): Promise<AppRegistryEntry> => {
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "define-app-test-only", configurable: true });
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
    await defineApp(options).start({ fetch: () => new Response("application") });
    const entry = entries.find((value): value is AppRegistryEntry => (value as AppRegistryEntry).id === options.id);
    if (!entry) throw new Error("The app published no registry entry");
    // The registry stores JSON; read it back the way other processes do.
    return JSON.parse(JSON.stringify(entry));
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
};
