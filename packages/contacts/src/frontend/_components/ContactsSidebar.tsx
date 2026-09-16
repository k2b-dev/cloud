import ContactsNavigation from "./ContactsNavigation.island";
import { bookMessages } from "./book-messages";
import { i18n } from "@k2b/stdlib";
import { AppWorkspace, useLocale } from "@k2b/ui";
import type { ContactBook } from "../../service";
import BookSettingsButton from "./BookSettingsButton.island";
import ContactsSpotlightButton from "./ContactsSpotlightButton.island";
import CreateBookButton from "./CreateBookButton.island";

type Props = {
  books: ContactBook[];
  active: "all" | "favorites" | string;
  adminBookIds?: string[];
};

export const sidebarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      contacts: "Contacts",
      newBook: "New book",
      allContacts: "All contacts",
      favorites: "Favorites",
      books: "Books",
    },
    de: {
      contacts: "Kontakte",
      newBook: "Neues Kontaktbuch",
      allContacts: "Alle Kontakte",
      favorites: "Favoriten",
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
          {
            id: "favorites",
            label: t().favorites,
            icon: "ti ti-star",
            href: "/app/contacts?favorites=true",
            active: props.active === "favorites",
          },
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
      <AppWorkspace.Sidebar collapsible>
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
              <AppWorkspace.SidebarItem
                href="/app/contacts?favorites=true"
                navigation="document"
                icon="ti ti-star"
                active={props.active === "favorites"}
                title={t().favorites}
                viewTransitionName={vt("favorites-desktop")}
              >
                {t().favorites}
              </AppWorkspace.SidebarItem>
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
