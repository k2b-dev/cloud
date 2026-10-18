import { i18n } from "@k2b/stdlib";

export const composerInsertMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      insertFromCloud: "Insert from Cloud",
      insertFromCloudHint: "Find something in your apps and insert it",
      insertTag: ({ tag }: { tag: string }) => `Insert ${tag}`,
      chooseFrom: ({ app }: { app: string }) => `Choose from ${app}`,
      tagFromApp: ({ tag, app }: { tag: string; app: string }) => `${tag} from ${app}`,
      searchTagFor: ({ tag, query }: { tag: string; query: string }) => `Search ${tag} for “${query}”`,
      searchTag: ({ tag }: { tag: string }) => `Search ${tag}`,
      fromAppWithPreview: ({ app }: { app: string }) => `From ${app}, with preview`,
      searchCloudFor: ({ query }: { query: string }) => `Search Cloud for “${query}”`,
      searchAllApps: "Search all apps for content",
    },
    de: {
      insertFromCloud: "Aus Cloud einfügen",
      insertFromCloudHint: "Etwas aus deinen Apps suchen und einfügen",
      insertTag: ({ tag }) => `${tag} einfügen`,
      chooseFrom: ({ app }) => `Aus ${app} wählen`,
      tagFromApp: ({ tag, app }) => `${tag} aus ${app}`,
      searchTagFor: ({ tag, query }) => `„${query}“ in ${tag} suchen`,
      searchTag: ({ tag }) => `${tag} durchsuchen`,
      fromAppWithPreview: ({ app }) => `Aus ${app}, mit Vorschau`,
      searchCloudFor: ({ query }) => `„${query}“ in Cloud suchen`,
      searchAllApps: "In allen Apps nach Inhalten suchen",
    },
  },
});
