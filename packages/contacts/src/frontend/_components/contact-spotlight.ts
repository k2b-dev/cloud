import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const spotlightMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      contacts: "Contacts",
      searchContacts: "Search all contacts",
      searchDescription: "Find names, email addresses and phone numbers in your address books.",
      searchContactsButton: "Search Contacts",
      searchContactsWithShortcut: ({ shortcut }: { shortcut: string }) => `Search contacts (${shortcut})`,
    },
    de: {
      contacts: "Kontakte",
      searchContacts: "Alle Kontakte durchsuchen",
      searchDescription: "Namen, E-Mail-Adressen und Telefonnummern in deinen Adressbüchern finden.",
      searchContactsButton: "Kontakte suchen",
      searchContactsWithShortcut: ({ shortcut }) => `Kontakte suchen (${shortcut})`,
    },
  },
});

export const contactsSearchOptions = (locale: string) => ({
  scope: { appId: "contacts", label: spotlightMessages.resolve([locale]).t.contacts, icon: "ti ti-address-book" },
});

export function createContactsSearch() {
  const locale = useLocale();
  return () => openGlobalSearch(contactsSearchOptions(locale()));
}
