import { i18n } from "@k2b/stdlib";

export const helpApiMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unavailable: ({ appId }: { appId: string }) => `Help for ${appId} is not currently available`,
      stale: ({ appId }: { appId: string }) => `Help for ${appId} is being refreshed`,
      notFound: "Help document not found",
    },
  },
});

export type HelpApiMessages = ReturnType<typeof helpApiMessages.resolve>["t"];
