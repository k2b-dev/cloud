import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import * as registry from "../_internal/registry";
import { formatAppKey } from "../app-key";
import { env } from "../config/env";
import { ResourceReaderRateLimited, readResourcePrincipals } from "./resource-readers";
import * as client from "./server-invoke";
import { compileCapabilityManifest } from "./testing";

const originalCredential = process.env.CLOUD_APP_CREDENTIAL;
const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
const manifest = compileCapabilityManifest("inventory", {
  protocolVersion: 2,
  types: { item: { title: "Item", description: "An inventory item.", access: { readable: () => [] } } },
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
  process.env.CLOUD_APP_CREDENTIAL = "fixture-workload";
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
  lookup = spyOn(registry, "getCapability").mockResolvedValue(entry);
  invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({ ok: true, data: { data: { readable: [] } } });
});
afterEach(() => {
  lookup.mockRestore();
  invoke.mockRestore();
  clearProcessApplicationId();
  if (originalCredential === undefined) delete process.env.CLOUD_APP_CREDENTIAL;
  else process.env.CLOUD_APP_CREDENTIAL = originalCredential;
  if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
});
test("checks foreign types under app authority and distinguishes a negative answer", async () => {
  expect(await readResourcePrincipals(input)).toEqual({ state: "checked", readable: [] });
  expect(invoke).toHaveBeenCalledWith(
    { appId: "inventory", capabilityId: "item.readable", kind: "query", input: { id: "item-1", principals: [principal] } },
    expect.anything(),
    expect.objectContaining({ workload: { appId: "consumer" }, authorization: "Bearer fixture-workload" }),
  );
});
test("missing setup is an explicit reason, and temporary failure throws for retry", async () => {
  delete process.env.CLOUD_APP_CREDENTIAL;
  expect(await readResourcePrincipals(input)).toEqual({ state: "not_configured", reason: "no_credential" });
  expect(invoke).not.toHaveBeenCalled();
  process.env.CLOUD_APP_CREDENTIAL = "fixture-workload";
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
    types: {
      collection: { title: "Collection", description: "Collection." },
      item: { title: "Item", description: "Item.", container: "collection", access: { readable: () => [] } },
    },
  });
  lookup.mockResolvedValue({ ...entry, manifest: containerManifest });
  expect(await readResourcePrincipals({ ...input, ref: { type: "inventory.collection", id: "collection-1" } })).toEqual({
    state: "not_configured",
    reason: "no_readable",
  });
  expect(invoke).not.toHaveBeenCalled();
});

test("an app key enables resource checks without a reusable workload credential", async () => {
  const originalKey = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
  delete process.env.CLOUD_APP_CREDENTIAL;
  Object.defineProperty(env, "CLOUD_APP_KEY", {
    value: formatAppKey({
      appId: "consumer",
      installationId: "11111111-1111-4111-8111-111111111111",
      keyId: "22222222-2222-4222-8222-222222222222",
      seed: APP_KEY_FIXTURES[0].seed,
    }),
    configurable: true,
  });
  try {
    expect(await readResourcePrincipals(input)).toEqual({ state: "checked", readable: [] });
    const caller = invoke.mock.calls[0]?.[2];
    expect(caller?.workload).toEqual({ appId: "consumer" });
    expect(caller?.authorization).toBeUndefined();
  } finally {
    Object.defineProperty(env, "CLOUD_APP_KEY", originalKey);
  }
});
