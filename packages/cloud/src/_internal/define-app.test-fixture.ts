import { spyOn } from "bun:test";
import type { Sync } from "@k2b/sync";
import type { AppRegistryEntry } from "../contracts/registry";
import type { User } from "../contracts/shared";
import { stubConnections } from "../runtime/connections.test-fixture";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import * as applicationPackage from "./application-package";
import { type AppDefinition, type AppOptions, defineApp, type StartOptions, type StartResult } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import * as watcher from "./runtime-watcher";
import * as workload from "./workload-credential";

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
export const publishedEntry = async (
  options: AppOptions,
  inspect?: (server: StartResult) => Promise<void>,
  configure?: (app: AppDefinition) => void,
  startOptions?: Partial<StartOptions>,
): Promise<AppRegistryEntry> => {
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  const entries: unknown[] = [];
  // Only the methods used by startup are implemented; heartbeat transport is stubbed.
  const sync = { ephemeral: () => ({}), ready: async () => {} } as unknown as Sync;
  const spies = [
    stubConnections(),
    spyOn(applicationPackage, "registerApplicationPackage").mockResolvedValue(undefined),
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(sync);
      return { sync, stop: async () => processSync.unbindProcessSync() };
    }),
    // Startup registers the instance and obtains its workload credential before lifecycle work.
    spyOn(heartbeat, "createRegistryMembership").mockReturnValue({
      instanceId: "0123456789abcdef",
      register: async () => {},
      leave: async () => {},
      join: async () => {},
      publish: async () => {},
      adopt: async () => {},
      renew: async () => {},
    }),
    spyOn(workload, "createAppWorkloadCredential").mockReturnValue({
      start: async () => {},
      refresh: async () => {},
      stop: async () => {},
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
    const app = defineApp(options);
    configure?.(app);
    const server = await app.start({ fetch: () => new Response("application"), ...startOptions });
    await inspect?.(server);
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
  }
};
