import { i18n } from "@k2b/stdlib";
export const accountsSearchMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Accounts",
      description: "Find users, groups, agents and service accounts you can open.",
      groups: "Find groups you can open.",
      unavailable: "Account search requires a full user account.",
    },
    de: {
      title: "Zugänge",
      description: "Nutzer, Gruppen, Agenten und Dienstkonten finden, die du öffnen kannst.",
      groups: "Gruppen finden, die du öffnen kannst.",
      unavailable: "Die Suche unter Zugänge benötigt ein vollwertiges Benutzerkonto.",
    },
  },
});
