import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import { searchAccounts } from "./search";

export const accountsCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    user: { title: "Account", description: "An account in the existing Core directory." },
    group: { title: "Group", description: "A group in the existing Core directory." },
    "service-account": { title: "Service account", description: "A service account in the existing Core directory." },
  },
  queries: {
    search: {
      title: "Search accounts",
      description: "Find accounts and groups whose Accounts pages the caller may open.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "account", title: "Accounts", description: "Find accounts and groups.", aliases: ["accounts"] }] },
      run: async (input, context) => searchAccounts(input, context, (await import("@k2b/cloud/services")).accountsAppService.entity.list),
    },
  },
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        queries: {
          search: {
            title: "Konten durchsuchen",
            description: "Konten und Gruppen finden, deren Kontenseiten du öffnen darfst.",
            searchTags: { account: { title: "Konten", description: "Konten und Gruppen finden." } },
          },
        },
      },
    },
  },
});
