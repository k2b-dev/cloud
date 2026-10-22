import { expect, spyOn, test } from "bun:test";
import { defineCapabilities } from "@k2b/cloud";
import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";
import * as capabilityServer from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { RequestAuthority } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import * as registry from "../../../cloud/src/_internal/registry";
import type { SpaceItemResourceReference } from "../contracts";
import { resolveReferenceViews } from "./resource-reference-views";

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

test("resolves current readers with the caller and loads each provider manifest once", async () => {
  const catalogCalls: string[] = [];
  const readerCalls: Array<{ input: { appId: string; capabilityId: string; id: string }; caller: CapabilityCaller }> = [];
  const references = [reference("First1"), reference("Second")];

  const result = await resolveReferenceViews(references, caller, null, {
    getCatalogApp: async (appId) => {
      catalogCalls.push(appId);
      return { appId, manifest };
    },
    invokeReader: async (input, currentCaller) => {
      readerCalls.push({ input, caller: currentCaller });
      return {
        refs: [
          {
            type: "provider.item",
            id: input.id,
            title: `Current ${input.id}`,
            preview: "Current preview",
            icon: "ti ti-current",
          },
        ],
        links: [{ rel: "open", href: `/app/provider/${input.id}` }],
      };
    },
  });

  expect(catalogCalls).toEqual(["provider"]);
  expect(readerCalls).toEqual([
    { input: { appId: "provider", capabilityId: "item.read", id: "First1" }, caller },
    { input: { appId: "provider", capabilityId: "item.read", id: "Second" }, caller },
  ]);
  expect(result).toEqual([
    {
      ...references[0]!,
      resource: {
        ref: references[0]!.ref,
        title: "Current First1",
        preview: "Current preview",
        icon: "ti ti-current",
        links: [{ rel: "open", href: "/app/provider/First1" }],
      },
    },
    {
      ...references[1]!,
      resource: {
        ref: references[1]!.ref,
        title: "Current Second",
        preview: "Current preview",
        icon: "ti ti-current",
        links: [{ rel: "open", href: "/app/provider/Second" }],
      },
    },
  ]);
});

test("preserves snapshots when a provider, reader, permission, or link is unavailable", async () => {
  const references = [
    reference("NoApp1", "missing.item"),
    reference("NoRead", "provider.navigation"),
    reference("Denied"),
    reference("NoLink"),
  ];

  const result = await resolveReferenceViews(references, caller, null, {
    getCatalogApp: async (appId) => (appId === "provider" ? { appId, manifest } : null),
    invokeReader: async ({ id }) =>
      id === "Denied" || id === "NoLink" ? null : { refs: [], links: [{ rel: "open", href: `/app/provider/${id}` }] },
  });

  expect(result).toEqual(references.map((item) => ({ ...item, resource: null })));
});

test("bounds concurrent reader calls while preserving reference order", async () => {
  const references = Array.from({ length: 17 }, (_, index) => reference(`Item${index}`));
  let active = 0;
  let maximumActive = 0;

  const result = await resolveReferenceViews(references, caller, null, {
    getCatalogApp: async (appId) => ({ appId, manifest }),
    invokeReader: async ({ id }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active -= 1;
      return { refs: [], links: [{ rel: "open", href: `/app/provider/${id}` }] };
    },
  });

  expect(maximumActive).toBe(8);
  expect(result.map((item) => item.ref.id)).toEqual(references.map((item) => item.ref.id));
});

test("falls back to stored labels and Type icons when readers return bare refs", async () => {
  const item = reference("Bare1");
  const [result] = await resolveReferenceViews([item], caller, null, {
    getCatalogApp: async (appId) => ({ appId, manifest }),
    invokeReader: async () => ({ refs: [{ type: "provider.item", id: item.ref.id }], links: [{ rel: "open", href: "/item" }] }),
  });

  expect(result?.resource).toEqual({
    ref: item.ref,
    title: item.label,
    icon: "ti ti-box",
    links: [{ rel: "open", href: "/item" }],
  });
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
