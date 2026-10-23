import { afterAll, beforeAll, spyOn } from "bun:test";
import * as registry from "../../packages/cloud/src/_internal/registry";
import { appAccess } from "../../packages/cloud/src/contracts/app-access";
import type { AppRegistryEntry } from "../../packages/cloud/src/contracts/registry";

/** Supply finite live-app metadata without NATS; identity, entry and resource checks stay real. */
export const useTestAppRegistry = (appIds: readonly string[]): void => {
  const apps: AppRegistryEntry[] = appIds.map((id) => ({
    id,
    name: id,
    icon: "ti ti-test-pipe",
    description: "Integration fixture",
    baseUrl: `http://${id}.test:3000`,
    routes: [`/api/${id}`],
    access: appAccess.signedIn(),
  }));
  let getApp: ReturnType<typeof spyOn<typeof registry, "getApp">> | undefined;
  let listApps: ReturnType<typeof spyOn<typeof registry, "listApps">> | undefined;
  beforeAll(() => {
    getApp = spyOn(registry, "getApp").mockImplementation(async (id) => apps.find((app) => app.id === id) ?? null);
    listApps = spyOn(registry, "listApps").mockImplementation(async () => apps);
  });
  afterAll(() => {
    listApps?.mockRestore();
    getApp?.mockRestore();
  });
};
