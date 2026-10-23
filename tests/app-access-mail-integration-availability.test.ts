import { expect, spyOn, test } from "bun:test";
import * as registry from "../packages/cloud/src/_internal/registry";
import { type AppRegistryEntry, CapabilityManifestSchema } from "../packages/cloud/src/contracts/index.ts";
import type { RequestAuthority } from "../packages/cloud/src/server/index.ts";
import { isMailInvitationIntegrationAvailable } from "../packages/spaces/src/service/mail-integration";

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

const manifest = CapabilityManifestSchema.parse(await Bun.file(new URL("./fixtures/capabilities/v2/mail.json", import.meta.url)).json());

test("spaces integration discovery uses request authority and preserves credential caps", async () => {
  let app: AppRegistryEntry = {
    id: "mail",
    name: "Mail",
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
      endpoint: "/api/mail/capabilities",
      manifest,
    }),
  ];
  try {
    expect(await isMailInvitationIntegrationAvailable(authority)).toEqual(true);
    expect(await isMailInvitationIntegrationAvailable(null)).toEqual(false);
    // The actor is unchanged; only the actual credential scope narrows.
    expect(await isMailInvitationIntegrationAvailable({ ...authority, scopes: ["other:read"] })).toEqual(false);
    app = { ...app, access: { kind: "roles", roles: ["admin"] } };
    expect(await isMailInvitationIntegrationAvailable(authority)).toEqual(false);
    app = { ...app, access: undefined };
    expect(await isMailInvitationIntegrationAvailable(null)).toEqual(true);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
