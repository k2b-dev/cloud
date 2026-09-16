import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const spotlightMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      contacts: "Contacts",
      searchContacts: "Search contacts",
      searchContactsButton: "Search Contacts",
      searchContactsWithShortcut: ({ shortcut }: { shortcut: string }) => `Search contacts (${shortcut})`,
    },
    de: {
      contacts: "Kontakte",
      searchContacts: "Kontakte suchen",
      searchContactsButton: "Kontakte suchen",
      searchContactsWithShortcut: ({ shortcut }) => `Kontakte suchen (${shortcut})`,
    },
  },
});

export function createContactsSearch() {
  const locale = useLocale();
  return () =>
    openGlobalSearch({ scope: { appId: "contacts", label: spotlightMessages.resolve([locale()]).t.contacts, icon: "ti ti-address-book" } });
}
