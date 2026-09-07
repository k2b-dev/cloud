import { describe, expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { env } from "../config/env";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import * as processSync from "./process-sync";
import * as watcher from "./runtime-watcher";

describe("application startup readiness", () => {
  for (const failure of ["setup", "start", "ready", "advertise", null] as const) {
    test(`advertises only ready resources and cleans up ${failure ?? "successful startup"}`, async () => {
      const events: string[] = [];
      const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
      Object.defineProperty(env, "APP_SECRET", { value: "startup-test-only", configurable: true });
      const signals = ["SIGTERM", "SIGINT"] as const;
      const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
      const step = async (name: string) => {
        events.push(name);
        if (name === failure) throw new Error(`failed:${name}`);
      };
      // Only the methods used by startup are implemented; heartbeat transport is stubbed.
      const sync = { ephemeral: () => ({}), ready: () => step("ready") } as unknown as Sync;
      const spies = [
        spyOn(processSync, "startProcessSync").mockImplementation(async () => {
          processSync.bindProcessSync(sync);
          events.push("connect");
          return {
            sync,
            stop: async () => {
              events.push("disconnect");
              processSync.unbindProcessSync();
            },
          };
        }),
        spyOn(heartbeat, "createHeartbeat").mockReturnValue({
          start: () => step("advertise"),
          stop: async () => {
            events.push("unregister");
          },
        }),
        spyOn(watcher, "ensureRuntimeWatcher").mockImplementation(() => step("watch")),
        spyOn(watcher, "stopRuntimeWatcher").mockImplementation(() => step("stop-watch")),
        spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
        spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockImplementation(async () => {
          events.push("notifications");
          return () => {
            events.push("stop-notifications");
          };
        }),
        spyOn(settingsService, "loadCache").mockImplementation(() => step("settings")),
      ];
      try {
        const app = defineApp({
          id: "startup-test",
          name: "Startup test",
          icon: "box",
          description: "Startup regression",
          baseUrl: "http://startup-test:3000",
          routes: ["/api/startup-test"],
        });
        const started = app.start({
          fetch: () => new Response("application"),
          lifecycle: {
            setup: () => step("setup"),
            start: () => step("start"),
            stop: async () => {
              events.push("stop-lifecycle");
              // Cleanup must continue even when one dependency cannot stop cleanly.
              if (failure === "start") throw new Error("cleanup error");
            },
          },
        });
        if (failure) {
          await expect(started).rejects.toThrow(`failed:${failure}`);
          expect(events.at(-1)).toBe("disconnect");
          expect(events).toContain("stop-lifecycle");
          expect(events).toContain("stop-watch");
          expect(events).toContain("unregister");
          if (failure !== "setup") expect(events).toContain("stop-notifications");
          if (failure !== "advertise") expect(events).not.toContain("advertise");
          expect(() => processSync.getProcessSync()).toThrow("not available");
        } else {
          const server = await started;
          expect(events.indexOf("advertise")).toBeGreaterThan(events.indexOf("start"));
          expect(events.indexOf("advertise")).toBeGreaterThan(events.indexOf("ready"));
          expect(await (await server.fetch(new Request("http://startup-test/_cloud/ready"))).json()).toEqual({
            status: "ready",
            appId: "startup-test",
          });
        }
      } finally {
        for (const [index, signal] of signals.entries()) {
          for (const listener of process.listeners(signal)) {
            if (!previousListeners[index]!.has(listener)) process.off(signal, listener);
          }
        }
        processSync.unbindProcessSync();
        for (const spy of spies.toReversed()) spy.mockRestore();
        Object.defineProperty(env, "APP_SECRET", originalSecret);
      }
    });
  }
});
