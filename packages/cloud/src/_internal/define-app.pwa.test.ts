import { describe, expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { env } from "../config/env";
import type { AppRegistryEntry } from "../contracts/registry";
import type { User } from "../contracts/shared";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { visiblePwaParts } from "../ssr/app-navigation";
import { type AppOptions, defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import { validateAppRegistryEntry } from "./registry-validation";
import { buildRuntimeFromRegistry } from "./runtime-context";
import * as watcher from "./runtime-watcher";

const inventory = {
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Count what is on the shelf",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory", "/app/inventory"],
} satisfies AppOptions;

/** Invented demo account. */
const person = {
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
const publishedEntry = async (options: AppOptions): Promise<AppRegistryEntry> => {
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "pwa-test-only", configurable: true });
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

describe("defineApp({ pwa })", () => {
  test("adds /pwa/<id> to the routes and publishes the part for the mobile app's Start", async () => {
    const app = defineApp({ ...inventory, pwa: {} });
    expect(app.meta.routes).toEqual(["/api/inventory", "/app/inventory", "/pwa/inventory"]);
    expect(app.meta.pwa).toEqual({ href: "/pwa/inventory", requiresRoles: undefined });

    const entry = await publishedEntry({ ...inventory, pwa: {} });
    expect(entry.routes).toEqual(["/api/inventory", "/app/inventory", "/pwa/inventory"]);
    expect(entry.pwa).toEqual({ href: "/pwa/inventory" });
    expect(validateAppRegistryEntry(entry)).toBeNull();
    const { apps } = buildRuntimeFromRegistry([entry]);
    expect(visiblePwaParts(apps, person, "en").map((part) => [part.id, part.name, part.pwa.href])).toEqual([
      ["inventory", "Inventory", "/pwa/inventory"],
    ]);
  });

  test("places the part after CLI plugin routes and carries its roles", async () => {
    const options = {
      ...inventory,
      cli: { inventory: { module: "src/cli.ts", references: "src/cli-references" } },
      pwa: { requiresRoles: ["admin"] },
    } satisfies AppOptions;
    expect(defineApp(options).meta.routes).toEqual(["/api/inventory", "/app/inventory", "/cli/plugins/inventory", "/pwa/inventory"]);
    const entry = await publishedEntry(options);
    expect(entry.pwa).toEqual({ href: "/pwa/inventory", requiresRoles: ["admin"] });
    expect(validateAppRegistryEntry(entry)).toBeNull();
    expect(visiblePwaParts(buildRuntimeFromRegistry([entry]).apps, person, "en")).toEqual([]);
  });

  test("an app without pwa has no part", () => {
    const app = defineApp(inventory);
    expect(app.meta.pwa).toBeUndefined();
    expect(app.meta.routes).toEqual(inventory.routes);
  });

  test("routes below /pwa fail at declaration, except the shell's and Core's", () => {
    for (const route of [
      "/pwa/inventory",
      "/pwa/inventory/",
      "/pwa",
      "/pwa/",
      "/pwa/_auth",
      "/pwa/settings",
      "/pwa/spaces/tasks",
      "//pwa/_auth/session",
      "//pwa/settings",
      "//pwa",
      "/pwa//inventory",
      " //pwa/x/ ",
    ]) {
      expect(() => defineApp({ ...inventory, routes: [route] })).toThrow(`App "inventory" lists route "${route}"`);
    }
    expect(() => defineApp({ ...inventory, routes: ["/pwa/_auth"], pwa: {} })).toThrow("/pwa is reserved for the mobile app");
    expect(() => defineApp({ ...inventory, id: "pwa", routes: ["/pwa/_auth"] })).toThrow('App "pwa" lists route "/pwa/_auth"');
    expect(() => defineApp({ ...inventory, id: "core", routes: ["/pwa"] })).toThrow('App "core" lists route "/pwa"');
    // Prefixes outside the segment stay free.
    expect(defineApp({ ...inventory, routes: ["/pwax"] }).meta.routes).toEqual(["/pwax"]);
    expect(defineApp({ ...inventory, id: "pwa", routes: ["/pwa", "/public/pwa"] }).meta.routes).toEqual(["/pwa", "/public/pwa"]);
    expect(defineApp({ ...inventory, id: "core", routes: ["/", "/pwa/_auth"] }).meta.routes).toEqual(["/", "/pwa/_auth"]);
  });

  test("the shell's own ids and ids that are not plain path segments cannot declare a part", () => {
    for (const id of ["pwa", "settings", "offline", "_auth", "spaces/tasks", "Inventory"]) {
      expect(() => defineApp({ ...inventory, id, routes: [], pwa: {} })).toThrow(`App "${id}" cannot declare pwa`);
    }
  });
});
