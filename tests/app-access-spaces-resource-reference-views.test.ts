import { expect, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import * as registry from "../packages/cloud/src/_internal/registry";
import type { CapabilityCaller } from "../packages/cloud/src/capabilities/server.ts";
import * as capabilityServer from "../packages/cloud/src/capabilities/server.ts";
import { compileCapabilityManifest } from "../packages/cloud/src/capabilities/testing.ts";
import { defineCapabilities } from "../packages/cloud/src/index.ts";
import type { RequestAuthority } from "../packages/cloud/src/server/index.ts";
import type { SpaceItemResourceReference } from "../packages/spaces/src/contracts";
import { resolveReferenceViews } from "../packages/spaces/src/service/resource-reference-views";

const caller: CapabilityCaller = {
  cookie: "session=test",
  authorization: "Bearer test",
  requestId: "request-1",
};

const manifest = compileCapabilityManifest(
  "provider",
  defineCapabilities({
    protocolVersion: 2,
    types: {
      item: { title: "Item", description: "One readable item.", icon: "ti ti-box", reader: "item.read" },
      navigation: { title: "Navigation", description: "One navigation-only item." },
    },
    queries: {
      "item.read": {
        title: "Read item",
        description: "Read one visible item.",
        input: z.object({ id: z.string().describe("Stable item ID.") }).strict(),
        data: z.object({ id: z.string() }).strict(),
        openWorld: false,
        run: async ({ id }) => ok({ data: { id } }),
      },
    },
  }),
);

const reference = (id: string, type = "provider.item"): SpaceItemResourceReference => ({
  ref: { type, id },
  label: `Snapshot ${id}`,
  createdAt: "2026-08-15T12:00:00.000Z",
});

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

test("default reference discovery retains scope caps and leaves denied snapshots without invoking a reader", async () => {
  const spies: Array<{ mockRestore(): void }> = [
    spyOn(registry, "getApp").mockResolvedValue({
      id: "provider",
      name: "Provider",
      icon: "ti ti-apps",
      description: "Fixture",
      routes: [],
      baseUrl: "http://test.invalid",
      access: { kind: "signedIn" },
    }),
    spyOn(registry, "getCapability").mockResolvedValue({
      appId: "provider",
      appName: "Provider",
      appIcon: "ti ti-apps",
      appDescription: "Fixture",
      endpoint: "/api/provider/capabilities",
      manifest,
    }),
  ];
  const invoke = spyOn(capabilityServer, "invokeCapabilityWithDataSchema").mockResolvedValue({
    ok: true,
    data: { data: {}, links: [{ rel: "open", href: "/app/provider/Item01" }] },
  });
  spies.push(invoke);
  try {
    const item = reference("Item01");
    expect((await resolveReferenceViews([item], caller, authority))[0]?.resource).toMatchObject({
      title: item.label,
      links: [{ rel: "open", href: "/app/provider/Item01" }],
    });
    expect(invoke.mock.calls[0]?.[2]).toBe(caller);
    invoke.mockClear();
    expect(await resolveReferenceViews([item], caller, { ...authority, scopes: ["other:read"] })).toEqual([{ ...item, resource: null }]);
    expect(await resolveReferenceViews([item], caller, null)).toEqual([{ ...item, resource: null }]);
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
