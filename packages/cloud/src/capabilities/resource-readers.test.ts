import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { appKeyFixture } from "../../../../scripts/fixtures/app-key-fixtures";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import * as registry from "../_internal/registry";
import { CloudResourceReaderViewSchema } from "../contracts/capabilities";
import { listResourceManagers, ResourceReaderRateLimited, readResourcePrincipals } from "./resource-readers";
import * as client from "./server-invoke";
import { compileCapabilityManifest } from "./testing";

const originalKey = process.env.CLOUD_APP_KEY;
const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
const reader = {
  title: "Read item",
  description: "Read the item.",
  input: z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict(),
  data: z.object({ view: CloudResourceReaderViewSchema }),
  openWorld: false,
  run: async () => ({ ok: true as const, data: { data: { view: { title: "Item", permission: "read" as const } } } }),
};
const manifest = compileCapabilityManifest("inventory", {
  protocolVersion: 2,
  queries: { "item.read": reader },
  types: { item: { title: "Item", description: "An inventory item.", reader: "item.read", access: { readable: () => [] } } },
});
const entry = {
  appId: "inventory",
  appName: "Inventory",
  appIcon: "box",
  appDescription: "Inventory",
  endpoint: "http://provider.test",
  manifest,
};
const principal = { type: "service_account" as const, serviceAccountId: "11111111-1111-4111-8111-111111111111" };
const input = { ref: { type: "inventory.item", id: "item-1" }, principals: [principal] };
let lookup: ReturnType<typeof spyOn<typeof registry, "getCapability">>;
let invoke: ReturnType<typeof spyOn<typeof client, "invokeCapabilityWithDataSchema">>;
beforeEach(() => {
  bindProcessApplicationId("consumer", ["resources:readers"]);
  process.env.CLOUD_APP_KEY = appKeyFixture("consumer");
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
  lookup = spyOn(registry, "getCapability").mockResolvedValue(entry);
  invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({ ok: true, data: { data: { readable: [] } } });
});
afterEach(() => {
  lookup.mockRestore();
  invoke.mockRestore();
  clearProcessApplicationId();
  if (originalKey === undefined) delete process.env.CLOUD_APP_KEY;
  else process.env.CLOUD_APP_KEY = originalKey;
  if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
});
test("checks foreign types under app authority and distinguishes a negative answer", async () => {
  expect(await readResourcePrincipals(input)).toEqual({ state: "checked", readable: [] });
  expect(invoke).toHaveBeenCalledWith(
    { appId: "inventory", capabilityId: "item.readable", kind: "query", input: { id: "item-1", principals: [principal] } },
    expect.anything(),
    expect.objectContaining({ workload: { appId: "consumer" } }),
  );
});
test("missing setup is an explicit reason, and temporary failure throws for retry", async () => {
  delete process.env.CLOUD_APP_KEY;
  expect(await readResourcePrincipals(input)).toEqual({ state: "not_configured", reason: "no_credential" });
  expect(invoke).not.toHaveBeenCalled();
  process.env.CLOUD_APP_KEY = appKeyFixture("consumer");
  lookup.mockResolvedValue({ ...entry, manifest: { ...manifest, resourceTypes: [] } });
  expect(await readResourcePrincipals(input)).toEqual({ state: "not_configured", reason: "no_readable" });
  lookup.mockResolvedValue(entry);
  invoke.mockResolvedValue({ ok: false, error: { code: "APP_UNAVAILABLE", message: "Try later", status: 503 } });
  expect(readResourcePrincipals(input)).rejects.toThrow("APP_UNAVAILABLE");
  invoke.mockResolvedValue({ ok: false, error: { code: "APP_QUERY_NOT_ADMITTED", message: "Not admitted", status: 403 } });
  expect(await readResourcePrincipals(input)).toEqual({ state: "not_configured", reason: "not_admitted" });
  invoke.mockResolvedValue({ ok: false, error: { code: "FORBIDDEN", message: "Token unavailable", status: 403 } });
  expect(readResourcePrincipals(input)).rejects.toThrow("FORBIDDEN");
  lookup.mockResolvedValue(null);
  expect(readResourcePrincipals(input)).rejects.toThrow("registry entry unavailable");
});

test("rate admission carries Retry-After and defaults to the 60-second window", async () => {
  for (const delay of [undefined, 90_000]) {
    invoke.mockResolvedValue({ ok: false, error: { code: "RATE_LIMITED", message: "Busy", status: 429, retryAfterMs: delay } });
    await expect(readResourcePrincipals(input)).rejects.toMatchObject({ retryAfterMs: delay ?? 60_000 });
    await expect(readResourcePrincipals(input)).rejects.toBeInstanceOf(ResourceReaderRateLimited);
  }
});
test("a container type without its generated readable query is not configured", async () => {
  const containerManifest = compileCapabilityManifest("inventory", {
    protocolVersion: 2,
    queries: { "item.read": { ...reader, data: z.object({ view: CloudResourceReaderViewSchema.required({ container: true }) }) } },
    types: {
      collection: { title: "Collection", description: "Collection." },
      item: { title: "Item", description: "Item.", container: "collection", reader: "item.read", access: { readable: () => [] } },
    },
  });
  lookup.mockResolvedValue({ ...entry, manifest: containerManifest });
  expect(await readResourcePrincipals({ ...input, ref: { type: "inventory.collection", id: "collection-1" } })).toEqual({
    state: "not_configured",
    reason: "no_readable",
  });
  expect(invoke).not.toHaveBeenCalled();
});

test("manager notices use workload authority and bounded recipient pages without impersonating a person", async () => {
  const managersManifest = compileCapabilityManifest("inventory", {
    protocolVersion: 2,
    queries: { "item.read": reader },
    types: { item: { title: "Item", description: "An item.", reader: "item.read", access: { managers: () => [] } } },
  });
  lookup.mockResolvedValue({ ...entry, manifest: managersManifest });
  const userId = "22222222-2222-4222-8222-222222222222";
  invoke.mockResolvedValue({ ok: true, data: { data: { userIds: [userId] } } });
  expect(await listResourceManagers({ ref: input.ref, userId, limit: 1 })).toEqual([userId]);
  expect(invoke.mock.calls[0]?.[0]).toEqual({
    appId: "inventory",
    capabilityId: "item.managers",
    kind: "query",
    input: { id: "item-1", userId, limit: 1 },
  });
  expect(invoke.mock.calls[0]?.[2]).toMatchObject({ workload: { appId: "consumer" } });
  expect(invoke.mock.calls[0]?.[2]?.authorization).toBeUndefined();
  expect(invoke.mock.calls[0]?.[2]?.authority).toBeUndefined();
  await expect(listResourceManagers({ ref: input.ref, limit: 51 })).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValue({ ok: false, error: { code: "APP_UNAVAILABLE", message: "Retry", status: 503 } });
  await expect(listResourceManagers({ ref: input.ref })).rejects.toThrow("APP_UNAVAILABLE");
  lookup.mockResolvedValue(entry);
  expect(await listResourceManagers({ ref: input.ref })).toEqual([]);
  lookup.mockResolvedValue(null);
  await expect(listResourceManagers({ ref: input.ref })).rejects.toThrow("registry entry unavailable");
});

describe("the Code event-place exception (#3539)", () => {
  const events = {
    created: { title: "Created", description: "Created.", version: 1, subject: "item", place: "item", schema: z.strictObject({}) },
  };
  const contained = (access?: { readable: () => [] }) =>
    compileCapabilityManifest("inventory", {
      protocolVersion: 2,
      queries: { "item.read": reader },
      events,
      types: {
        collection: { title: "Collection", description: "Collection." },
        item: { title: "Item", description: "Item.", container: "collection", reader: "item.read", ...(access ? { access } : {}) },
      },
    });

  test("only the event-place check asks a contained place without a container; every other caller still fails", async () => {
    lookup.mockResolvedValue({ ...entry, manifest: contained({ readable: () => [] }) });
    await expect(readResourcePrincipals(input)).rejects.toThrow("requires a reference to the declared container type");
    await expect(readResourcePrincipals({ ...input, container: { type: "inventory.other", id: "collection-1" } })).rejects.toThrow(
      "requires a reference to the declared container type",
    );
    // A derived reader cannot check a container: callers that name one, even the right one, find no reader as before.
    lookup.mockResolvedValue({ ...entry, manifest: contained() });
    for (const container of [undefined, { type: "inventory.other", id: "c" }, { type: "inventory.collection", id: "collection-1" }])
      expect(await readResourcePrincipals({ ...input, container })).toEqual({ state: "not_configured", reason: "no_readable" });
    expect(invoke).not.toHaveBeenCalled();
    expect(await readResourcePrincipals({ ...input, eventPlace: true })).toEqual({ state: "checked", readable: [] });
    expect(invoke).toHaveBeenCalledWith(
      { appId: "inventory", capabilityId: "item.readable", kind: "query", input: { id: "item-1", principals: [principal] } },
      expect.anything(),
      expect.objectContaining({ workload: { appId: "consumer" } }),
    );
  });

  test("a hook on a contained type keeps answering callers with the right container", async () => {
    lookup.mockResolvedValue({ ...entry, manifest: contained({ readable: () => [] }) });
    const container = { type: "inventory.collection", id: "collection-1" };
    expect(await readResourcePrincipals({ ...input, container })).toEqual({ state: "checked", readable: [] });
    expect(invoke.mock.calls[0]?.[0].input).toEqual({ id: "item-1", container, principals: [principal] });
  });

  test("a readable query whose input schema has no readable properties answers neither check", async () => {
    const derived = contained();
    for (const properties of [undefined, null, [], "container"]) {
      const queries = derived.queries.map((query) =>
        query.localId === "item.readable" ? { ...query, inputSchema: { ...query.inputSchema, properties } } : query,
      );
      lookup.mockResolvedValue({ ...entry, manifest: { ...derived, queries } });
      expect(await readResourcePrincipals({ ...input, eventPlace: true })).toEqual({ state: "not_configured", reason: "no_readable" });
      expect(await readResourcePrincipals({ ...input, container: { type: "inventory.collection", id: "collection-1" } })).toEqual({
        state: "not_configured",
        reason: "no_readable",
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  test("an explicit hook that expects a container, a missing reader, or an unknown type refuses the event-place check", async () => {
    lookup.mockResolvedValue({ ...entry, manifest: contained({ readable: () => [] }) });
    expect(await readResourcePrincipals({ ...input, eventPlace: true })).toEqual({ state: "not_configured", reason: "no_readable" });
    const derived = contained();
    const withoutReader = { ...derived, queries: derived.queries.filter((query) => query.localId !== "item.readable") };
    lookup.mockResolvedValue({ ...entry, manifest: withoutReader });
    expect(await readResourcePrincipals({ ...input, eventPlace: true })).toEqual({ state: "not_configured", reason: "no_readable" });
    lookup.mockResolvedValue({ ...entry, manifest: contained() });
    expect(await readResourcePrincipals({ ...input, ref: { type: "inventory.unknown", id: "x" }, eventPlace: true })).toEqual({
      state: "not_configured",
      reason: "no_readable",
    });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ ok: false, error: { code: "APP_UNAVAILABLE", message: "Try later", status: 503 } });
    await expect(readResourcePrincipals({ ...input, eventPlace: true })).rejects.toThrow("APP_UNAVAILABLE");
  });
});
