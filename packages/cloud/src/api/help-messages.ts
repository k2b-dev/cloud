import { i18n } from "@k2b/stdlib";

export const helpApiMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unavailable: ({ appId }: { appId: string }) => `Help for ${appId} is not currently available`,
      stale: ({ appId }: { appId: string }) => `Help for ${appId} is being refreshed`,
      notFound: "Help document not found",
    },
    de: {
      unavailable: ({ appId }) => `Die Hilfe für ${appId} ist derzeit nicht verfügbar`,
      stale: ({ appId }) => `Die Hilfe für ${appId} wird gerade aktualisiert`,
      notFound: "Hilfedokument nicht gefunden",
    },
  },
});

export type HelpApiMessages = ReturnType<typeof helpApiMessages.resolve>["t"];
