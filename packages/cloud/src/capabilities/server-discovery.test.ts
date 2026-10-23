import { expect, spyOn, test } from "bun:test";
import * as registry from "../_internal/registry";
import { recentTestApp, recentTestAuthority, recentTestRegistryApp } from "../ai/recent-resources.test-fixture";
import type { AppRegistryEntry } from "../contracts/registry";
import { getCapabilityActionWording, getCapabilityCatalogApp, listCapabilityCatalog } from "./server";

test("server catalog readers hide declared apps without usable authority and preserve legacy readers", async () => {
  let app: AppRegistryEntry = {
    ...recentTestRegistryApp,
    access: { kind: "roles", roles: ["admin"] },
    capabilities: { protocolVersion: 2, manifestHash: recentTestApp.manifest.manifestHash },
  };
  const spies = [
    spyOn(registry, "getApp").mockImplementation(async () => app),
    spyOn(registry, "listApps").mockImplementation(async () => [app]),
    spyOn(registry, "getCapability").mockResolvedValue(recentTestApp),
  ];
  try {
    expect(await getCapabilityCatalogApp(app.id, "en", recentTestAuthority)).toEqual({ ok: true, data: null });
    expect(await getCapabilityCatalogApp(app.id)).toEqual({ ok: true, data: null });
    expect(await listCapabilityCatalog({ authority: recentTestAuthority })).toMatchObject({
      ok: true,
      data: { apps: [], page: { hasMore: false } },
    });
    expect(await getCapabilityActionWording(app.id, "secret", "en", recentTestAuthority)).toBeNull();
    app = { ...app, access: undefined };
    expect(await getCapabilityCatalogApp(app.id)).toMatchObject({ ok: true, data: { appId: app.id } });
    expect(await listCapabilityCatalog()).toMatchObject({ ok: true, data: { apps: [{ appId: app.id }] } });
    app = { ...app, access: { kind: "signedIn" } };
    expect(await getCapabilityCatalogApp(app.id, "en", recentTestAuthority)).toMatchObject({ ok: true, data: { appId: app.id } });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
