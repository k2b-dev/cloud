import { i18n } from "@k2b/stdlib";
import { AppWorkspace, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { ContactBook } from "../../service";
import BookSettingsButton from "./BookSettingsButton.island";
import { bookMessages } from "./book-messages";
import ContactsFavoritesHint from "./ContactsFavoritesHint.island";
import ContactsNavigation from "./ContactsNavigation.island";
import ContactsSpotlightButton from "./ContactsSpotlightButton.island";
import CreateBookButton from "./CreateBookButton.island";

type Props = {
  books: ContactBook[];
  active: "all" | string;
  favoritesHref: string;
  hintOpen?: boolean;
  adminBookIds?: string[];
};

export const sidebarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      contacts: "Contacts",
      newBook: "New book",
      allContacts: "All contacts",
      books: "Books",
    },
    de: {
      contacts: "Kontakte",
      newBook: "Neues Kontaktbuch",
      allContacts: "Alle Kontakte",
      books: "Kontaktbücher",
    },
  },
});

/**
 * Contacts sidebar with books and quick create actions.
 */
export default function ContactsSidebar(props: Props) {
  const locale = useLocale();
  const t = () => sidebarMessages.resolve([locale()]).t;
  const adminBookIds = props.adminBookIds ?? [];
  const vt = (key: string) => `contacts-sidebar-${key}`;
  const renderBookItem = (book: ContactBook, mode: "mobile" | "desktop") => {
    const href = `/app/contacts/${book.id}`;
    const isActive = props.active === book.id;
    const canManage = adminBookIds.includes(book.id);

    return (
      <AppWorkspace.SidebarItem
        href={href}
        navigation="document"
        active={isActive}
        title={book.name}
        viewTransitionName={vt(`book-${book.id}-${mode}`)}
        class="w-full"
        actions={
          canManage ? (
            <AppWorkspace.SidebarItemActions visibility={mode === "desktop" ? "hover" : "always"}>
              <BookSettingsButton bookId={book.id} bookName={book.name} />
            </AppWorkspace.SidebarItemActions>
          ) : undefined
        }
      >
        <AppWorkspace.SidebarItemIcon icon="ti ti-address-book" />
        <AppWorkspace.SidebarItemLabel>{book.name}</AppWorkspace.SidebarItemLabel>
      </AppWorkspace.SidebarItem>
    );
  };

  return (
    <>
      <ContactsNavigation
        label={t().contacts}
        items={[
          { id: "all", label: t().allContacts, icon: "ti ti-users", href: "/app/contacts", active: props.active === "all" },
          ...props.books.map((book) => ({
            id: book.id,
            label: book.name,
            icon: "ti ti-address-book",
            href: `/app/contacts/${book.id}`,
            active: props.active === book.id,
            actions: adminBookIds.includes(book.id)
              ? [
                  {
                    id: `settings:${book.id}`,
                    action: `settings:${book.id}`,
                    label: bookMessages.resolve([locale()]).t.openSettingsFor({ name: book.name }),
                    icon: "ti ti-settings",
                  },
                ]
              : [],
          })),
        ]}
      />
      <AppWorkspace.Sidebar label={t().contacts} collapsible mobile="stacked" class="contacts-sidebar">
        <AppWorkspace.SidebarDesktop>
          <div data-sidebar-mode="expanded" style={`view-transition-name:${vt("primary-actions-desktop")}`}>
            <ContactsSpotlightButton variant="sidebar" registerCommand />
          </div>
          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <ContactsSpotlightButton variant="icon" />
            <CreateBookButton variant="icon" label={t().newBook} />
          </AppWorkspace.SidebarIconGrid>

          <AppWorkspace.SidebarBody scrollPreserveKey="contacts-sidebar">
            <AppWorkspace.SidebarSection>
              <AppWorkspace.SidebarItem
                href="/app/contacts"
                navigation="document"
                icon="ti ti-users"
                active={props.active === "all"}
                title={t().allContacts}
                viewTransitionName={vt("all-desktop")}
              >
                {t().allContacts}
              </AppWorkspace.SidebarItem>
              <Show when={props.hintOpen}>
                <ContactsFavoritesHint favoritesHref={props.favoritesHref} open />
              </Show>
            </AppWorkspace.SidebarSection>

            <AppWorkspace.SidebarSection title={t().books}>
              {props.books.map((book) => renderBookItem(book, "desktop"))}
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>

          <AppWorkspace.SidebarFooter sidebarMode="expanded">
            <CreateBookButton buttonVariant="ghost" class="w-full justify-start" label={t().newBook} />
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
