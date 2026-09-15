import { navigateTo } from "@k2b/ssr/nav";
import { i18n } from "@k2b/stdlib";
import { openSpotlightSearch, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { Contact } from "../../service";
import { resolveContactName } from "../../shared";

const PER_PAGE = 20;

export const spotlightMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      searchContacts: "Search contacts",
      searchContactsButton: "Search Contacts",
      searchContactsPlaceholder: "Search contacts...",
      searchContactsWithShortcut: ({ shortcut }: { shortcut: string }) => `Search contacts (${shortcut})`,
      noContactsFound: "No contacts found.",
      unnamedContact: "Unnamed contact",
    },
    de: {
      searchContacts: "Kontakte suchen",
      searchContactsButton: "Kontakte suchen",
      searchContactsPlaceholder: "Kontakte suchen…",
      searchContactsWithShortcut: ({ shortcut }) => `Kontakte suchen (${shortcut})`,
      noContactsFound: "Keine Kontakte gefunden.",
      unnamedContact: "Kontakt ohne Namen",
    },
  },
});

const primaryDetail = (contact: Contact): string | undefined => {
  const email = contact.emails[0]?.email;
  if (email) return email;
  const phone = contact.phones[0]?.phone;
  if (phone) return phone;
  return [contact.companyName, contact.jobTitle].filter(Boolean).join(" · ") || undefined;
};

const contactHref = (contact: Contact): string => `/app/contacts/${contact.bookId}?contact=${contact.id}&contactBook=${contact.bookId}`;

export function createContactsSearch() {
  const locale = useLocale();
  const t = () => spotlightMessages.resolve([locale()]).t;
  const openSearch = async () => {
    const selected = await openSpotlightSearch<Contact>({
      title: t().searchContacts,
      icon: "ti ti-address-book",
      placeholder: t().searchContactsPlaceholder,
      minQueryLength: 1,
      noResultsText: t().noContactsFound,
      resolve: async ({ query, abortSignal }) => {
        const trimmed = query.trim();
        if (!trimmed) return [];

        const response = await apiClient.search.$get(
          {
            query: {
              q: trimmed,
              page: "1",
              per_page: String(PER_PAGE),
            },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) return [];

        const payload = await response.json();
        return payload.data.map((contact) => ({
          value: contact,
          label: resolveContactName(contact, t().unnamedContact),
          desc: primaryDetail(contact),
          icon: "ti ti-address-book",
        }));
      },
    });

    if (selected?.value) navigateTo(contactHref(selected.value));
  };

  return openSearch;
}
