import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { defineCapabilities } from "@valentinkolb/cloud";
import type { CapabilityCaller } from "@valentinkolb/cloud/capabilities/server";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import { z } from "zod";
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
    protocolVersion: 1,
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

  const result = await resolveReferenceViews(references, caller, {
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

  const result = await resolveReferenceViews(references, caller, {
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

  const result = await resolveReferenceViews(references, caller, {
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
  const [result] = await resolveReferenceViews([item], caller, {
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
