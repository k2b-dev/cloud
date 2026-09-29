import { expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { env } from "../config/env";
import { jsonResponse } from "../server/middleware/openapi";
import { v } from "../server/middleware/validator";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import * as watcher from "./runtime-watcher";

type Operation = { responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }> };

test("the published OpenAPI spec describes the validation error body Cloud sends", async () => {
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "openapi-test-only", configurable: true });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  // Only the methods used by startup are implemented; heartbeat transport is stubbed.
  const sync = { ephemeral: () => ({}), ready: async () => {} } as unknown as Sync;
  const spies = [
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(sync);
      return { sync, stop: async () => processSync.unbindProcessSync() };
    }),
    spyOn(heartbeat, "createHeartbeat").mockImplementation(() => ({ start: async () => {}, stop: async () => {} })),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "stopRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
    spyOn(settingsService, "loadCache").mockResolvedValue(undefined),
  ];
  try {
    const api = new Hono()
      .post("/items", describeRoute({ summary: "Create an item" }), v("json", z.object({ name: z.string() })), (c) => c.json({}, 201))
      .post(
        "/items/:id/move",
        describeRoute({
          summary: "Move an item",
          responses: { 400: jsonResponse(z.object({ reason: z.string() }), "Move rejected") },
        }),
        v("json", z.object({ to: z.string() })),
        (c) => c.json({}),
      );
    const app = defineApp({
      id: "inventory",
      name: "Inventory",
      icon: "ti ti-box",
      description: "Stock",
      baseUrl: "http://inventory:3000",
      routes: ["/api/inventory"],
      openapi: "/api/inventory/openapi.json",
    });
    const server = await app.start({ fetch: (request) => api.fetch(request), openapi: api });

    const spec = (await (await server.fetch(new Request("http://inventory/api/inventory/openapi.json"))).json()) as {
      paths: Record<string, Record<string, Operation>>;
    };
    expect(spec.paths["/items"]?.post?.responses?.["400"]).toEqual({
      description: "Validation failed",
      content: {
        "application/json": {
          schema: { type: "object", properties: { message: { type: "string" }, code: { type: "string" } }, required: ["message"] },
        },
      },
    });
    // A route that documents its own 400 keeps it.
    expect(spec.paths["/items/{id}/move"]?.post?.responses?.["400"]?.description).toBe("Move rejected");

    // The described body is the one the validator sends.
    const invalid = await api.fetch(
      new Request("http://inventory/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ message: expect.stringContaining("name:") });
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
