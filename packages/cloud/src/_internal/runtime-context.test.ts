import { describe, expect, it } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "../contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import { compileCapabilities } from "./capabilities";
import { buildRuntimeFromRegistry } from "./runtime-context";

const entry = (appearance?: AppRegistryEntry["appearance"]): AppRegistryEntry => ({
  id: "example",
  name: "Example",
  icon: "ti ti-example",
  description: "Example app",
  appearance,
  baseUrl: "http://app-example:3000",
  routes: ["/app/example"],
});

describe("buildRuntimeFromRegistry", () => {
  it("preserves optional app appearance", () => {
    const appearance = {
      accent: "#14b8a6" as const,
      background: {
        from: "#14b8a6" as const,
        to: "#3b82f6" as const,
        angle: 135,
      },
    };

    expect(buildRuntimeFromRegistry([entry(appearance)]).apps[0]?.appearance).toEqual(appearance);
    expect(buildRuntimeFromRegistry([entry()]).apps[0]?.appearance).toBeUndefined();
  });

  it("preserves app-declared admin navigation", () => {
    const app = entry();
    app.adminNav = [
      {
        label: "Operations",
        links: [{ href: "/admin/example/jobs", icon: "ti-activity", label: "Jobs" }],
      },
    ];

    expect(buildRuntimeFromRegistry([app]).apps[0]?.adminNav).toEqual(app.adminNav);
  });

  it("projects the registered Help manifest", () => {
    const app = entry();
    app.help = {
      manifestHash: "sha256",
      pageBase: "/app/example/help",
      baseLocale: "en",
      documentsByLocale: {
        de: [
          {
            id: "getting-started",
            title: "Erste Schritte",
            order: 10,
            searchUrl: "/api/help/v1/example/search",
            url: "/api/help/v1/example/documents/getting-started",
          },
        ],
      },
      documents: [
        {
          id: "getting-started",
          title: "Getting started",
          order: 10,
          searchUrl: "/api/help/v1/example/search",
          url: "/api/help/v1/example/documents/getting-started",
        },
      ],
    };

    const projected = buildRuntimeFromRegistry([app]).apps[0]?.help;
    expect(projected).toEqual(app.help);
    expect(projected).not.toBe(app.help);
    expect(projected?.documents).not.toBe(app.help.documents);
    expect(projected?.documentsByLocale?.de).not.toBe(app.help.documentsByLocale?.de);
  });

  it("projects Universal Search tags and aliases from the live capability manifest", () => {
    const app = entry();
    const manifest = compileCapabilities(
      "example",
      defineCapabilities({
        protocolVersion: 1,
        queries: {
          search: {
            title: "Search examples",
            description: "Find visible examples.",
            input: UniversalSearchInputSchema,
            data: UniversalSearchDataSchema,
            openWorld: false,
            universalSearch: {
              tags: [
                {
                  tag: "example",
                  title: "Examples",
                  description: "Show examples.",
                  aliases: ["sample"],
                },
              ],
            },
            run: async () => ok({ data: [] }),
          },
          get: {
            title: "Get example",
            description: "Read one example outside Universal Search.",
            input: z.object({ id: z.string().describe("Stable example id.") }).strict(),
            data: z.object({ id: z.string() }).strict(),
            openWorld: false,
            run: async ({ id }) => ok({ data: { id } }),
          },
        },
      }),
    ).manifest;
    const capability: CapabilityRegistryEntry = {
      appId: app.id,
      appName: app.name,
      appIcon: app.icon,
      appDescription: app.description,
      endpoint: "http://app-example:3000/api/_internal/capabilities/v1",
      manifest,
    };

    expect(buildRuntimeFromRegistry([app], [capability]).apps[0]).toMatchObject({
      searchTags: ["example", "sample"],
      searchHelp: "Find visible examples.",
      searchTagHelp: [
        { tag: "example", help: "Show examples." },
        { tag: "sample", help: "Show examples. (alias of #example)" },
      ],
    });
  });
});
