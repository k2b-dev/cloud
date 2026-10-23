import { expect, spyOn, test } from "bun:test";
import * as registry from "../packages/cloud/src/_internal/registry";
import { type AppRegistryEntry, CapabilityManifestSchema } from "../packages/cloud/src/contracts/index.ts";
import type { RequestAuthority } from "../packages/cloud/src/server/index.ts";
import { getSpacesMailIntegrationAvailability } from "../packages/mail/src/service/app-integrations";

const authority: RequestAuthority = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Catalog reader",
      kind: "standalone",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["read"],
  },
  accessSubject: { type: "service_account", serviceAccountId: "11111111-1111-4111-8111-111111111111" },
  credentialKind: "oauth",
  scopes: ["read"],
};

const manifest = CapabilityManifestSchema.parse(await Bun.file(new URL("./fixtures/capabilities/v2/spaces.json", import.meta.url)).json());

test("mail integration discovery uses request authority and preserves credential caps", async () => {
  let app: AppRegistryEntry = {
    id: "spaces",
    name: "Spaces",
    icon: "ti ti-apps",
    description: "Catalog fixture",
    routes: [],
    baseUrl: "http://test.invalid",
    access: { kind: "signedIn" },
  };
  const spies = [
    spyOn(registry, "getApp").mockImplementation(async () => app),
    spyOn(registry, "getCapability").mockResolvedValue({
      appId: app.id,
      appName: app.name,
      appIcon: app.icon,
      appDescription: app.description,
      endpoint: "/api/spaces/capabilities",
      manifest,
    }),
  ];
  try {
    expect(await getSpacesMailIntegrationAvailability(authority)).toEqual({
      invitations: true,
      settings: true,
      composer: true,
      context: true,
    });
    expect(await getSpacesMailIntegrationAvailability(null)).toEqual({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    });
    // The actor is unchanged; only the actual credential scope narrows.
    expect(await getSpacesMailIntegrationAvailability({ ...authority, scopes: ["other:read"] })).toEqual({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    });
    app = { ...app, access: { kind: "roles", roles: ["admin"] } };
    expect(await getSpacesMailIntegrationAvailability(authority)).toEqual({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    });
    app = { ...app, access: undefined };
    expect(await getSpacesMailIntegrationAvailability(null)).toEqual({ invitations: true, settings: true, composer: true, context: true });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
