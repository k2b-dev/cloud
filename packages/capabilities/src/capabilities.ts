import { defineCapabilities, UniversalSearchInputSchema, UniversalSearchDataSchema } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { filterSearchCatalog, loadSearchCatalog } from "./search";
export const catalogCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    app: { title: "Capability app", description: "An application in the capability inspector." },
    operation: { title: "Capability operation", description: "A Query or Action in the inspector; opening never executes it." },
  },
  queries: {
    search: {
      title: "Search capability catalog",
      description: "Find apps, Queries and Actions to inspect, without executing them.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          {
            tag: "capability",
            title: "Capabilities",
            description: "Find apps, Queries and Actions in the inspector.",
            aliases: ["capabilities"],
          },
        ],
      },
      run: async (input, context) => {
        if (context.actor.kind !== "user") return fail(err.forbidden("Catalog search requires a user account"));
        if (input.scope) return fail(err.badInput("Unsupported catalog search context"));
        return ok({ data: filterSearchCatalog(await loadSearchCatalog(context.locale), input) });
      },
    },
  },
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        queries: {
          search: {
            title: "Capability-Katalog durchsuchen",
            description: "Apps, Queries und Actions zum Ansehen finden, ohne sie auszuführen.",
            searchTags: { capability: { title: "Capabilities", description: "Apps, Queries und Actions im Inspector finden." } },
          },
        },
      },
    },
  },
});
