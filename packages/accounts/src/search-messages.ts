import { i18n } from "@k2b/stdlib";
export const accountsSearchMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Accounts",
      description: "Find users, groups and service accounts you can open.",
      groups: "Find groups you can open.",
      unavailable: "Account search requires a full user account.",
    },
    de: {
      title: "Konten",
      description: "Nutzer, Gruppen und Service Accounts finden, die du öffnen kannst.",
      groups: "Gruppen finden, die du öffnen kannst.",
      unavailable: "Die Kontensuche benötigt ein vollwertiges Benutzerkonto.",
    },
  },
});
