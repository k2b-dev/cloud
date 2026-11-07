import { spyOn } from "bun:test";
import type { CapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import * as registry from "../../../cloud/src/_internal/registry";

/** Real catalog readers with only their live registry replaced. */
export const contactDirectoryCatalogFixture = (catalog: CapabilityCatalogApp) => {
  const entry = {
    id: catalog.appId,
    name: catalog.appName,
    icon: catalog.appIcon,
    description: catalog.appDescription,
    baseUrl: "http://directory.test",
    routes: [],
    access: { kind: "roles" as const, roles: ["user" as const] },
    capabilities: { protocolVersion: 2 as const, manifestHash: catalog.manifest.manifestHash },
  };
  return [
    spyOn(registry, "getApp").mockResolvedValue(entry),
    spyOn(registry, "listApps").mockResolvedValue([entry]),
    spyOn(registry, "getCapability").mockResolvedValue({ ...catalog, endpoint: "http://directory.test/capabilities" }),
  ];
};
