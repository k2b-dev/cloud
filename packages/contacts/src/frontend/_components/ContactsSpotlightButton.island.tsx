import { navigateTo } from "@k2b/ssr/nav";
import { i18n } from "@k2b/stdlib";
import {
  AppWorkspace,
  isSpotlightShortcut,
  openSpotlightSearch,
  SPOTLIGHT_SHORTCUT_TITLE,
  SpotlightButton,
  type SpotlightButtonVariant,
  useLocale,
} from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact } from "../../service";
import { resolveContactName } from "../../shared";

type Props = {
  variant?: SpotlightButtonVariant;
  registerShortcut?: boolean;
};

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

export default function ContactsSpotlightButton(props: Props) {
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

  onMount(() => {
    if (!props.registerShortcut) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpotlightShortcut(event)) return;
      event.preventDefault();
      void openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  if (props.variant === "icon") {
    return (
      <AppWorkspace.SidebarIconAction
        icon="ti ti-search"
        label={t().searchContactsWithShortcut({ shortcut: SPOTLIGHT_SHORTCUT_TITLE })}
        onClick={() => void openSearch()}
      />
    );
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t().searchContactsButton}
      onClick={openSearch}
      title={t().searchContactsWithShortcut({ shortcut: SPOTLIGHT_SHORTCUT_TITLE })}
      ariaLabel={t().searchContacts}
    />
  );
}
