import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import * as registry from "../_internal/registry";
import { readResourcePrincipals } from "./resource-readers";
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
