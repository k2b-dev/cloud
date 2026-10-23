import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server";
import type { AiSkillSummary } from "./skills";

export const recentTestApp: CapabilityRegistryEntry = {
  appId: "demo",
  appName: "Demo",
  appIcon: "ti ti-apps",
  appDescription: "Test application",
  endpoint: "/api/demo/capabilities",
  appPresentation: { baseLocale: "en", translations: { de: { name: "Beispiel" } } },
  presentation: { baseLocale: "en", translations: { de: { types: { item: { title: "Eintrag" } } } } },
  manifest: compileCapabilities(
    "demo",
    defineCapabilities({
      protocolVersion: 2,
      types: {
        item: { title: "Item", description: "An item.", icon: "ti ti-note", reader: "item.read" },
        other: { title: "Other", description: "No reader." },
      },
      queries: {
        "item.read": {
          title: "Read item",
          description: "Read one item.",
          input: z.object({ id: z.string().describe("Resource ID.") }).strict(),
          data: z.unknown(),
          openWorld: false,
          run: async () => ok({ data: {} }),
        },
      },
      actions: {},
    }),
  ).manifest,
};

export const recentTestAuthority: RequestAuthority = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Caller",
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
  credentialKind: "api_key",
  scopes: ["read"],
};

export const recentTestSkill = (shortId: string, enabled = true): AiSkillSummary => ({
  source: null,
  id: shortId,
  shortId,
  name: `Current ${shortId}`,
  description: "Current description\nPrivate second line",
  permission: "read",
  enabled,
  manualOnly: false,
  revision: 1,
  referenceCount: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

export const recentTestRegistryApp: AppRegistryEntry = {
  id: recentTestApp.appId,
  name: recentTestApp.appName,
  icon: recentTestApp.appIcon,
  description: recentTestApp.appDescription,
  routes: [],
  baseUrl: "http://test.invalid",
};
