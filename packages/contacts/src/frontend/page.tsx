import { AppWorkspace } from "@k2b/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { contactsService } from "../service";
import { captureContactEventCursor } from "../service/events";
import {
  projectBooks,
  projectContacts,
  projectFavoriteKeys,
  projectNotes,
  projectTags,
  resolvePublicId,
} from "../service/public-resources";
import ContactCreateLauncher from "./_components/ContactCreateLauncher.island";
import ContactDetailPanel from "./_components/ContactDetailPanel.island";
import ContactsLiveEvents from "./_components/ContactsLiveEvents.island";
import ContactsSidebar from "./_components/ContactsSidebar";
import ContactsWorkspaceMain from "./_components/ContactsWorkspaceMain";
import DesktopDetailLayoutSync from "./_components/DesktopDetailLayoutSync.island";
import {
  CONTACTS_PER_PAGE,
  loadContactBookPermissions,
  loadFavoriteKeysForContacts,
  parseContactsPage,
  parseContactsQueryOptions,
  resolveSelectedContact,
} from "./page-data";
import { pagesMessages } from "./pages-messages";

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const { t } = pagesMessages.resolve([getLocale(c)]);
  const search = c.req.query("search") ?? "";
  const activeTagId = c.req.query("tag_id") ?? null;
  const page = parseContactsPage(c.req.query("page"));
  const queryOptions = parseContactsQueryOptions((name) => c.req.query(name));
  const perPage = CONTACTS_PER_PAGE;
  const selectedContactIdFromUrl = c.req.query("contact") ?? null;
  const selectedBookIdFromUrl = c.req.query("contactBook") ?? null;
  // The cursor must precede the snapshot reads or an event can fall between them.
  const initialLiveCursor = await captureContactEventCursor();
  const activeTagInternalId = activeTagId ? await resolvePublicId("tags", activeTagId) : null;
  const [booksResult, contactsResult] = await Promise.all([
    contactsService.book.list({
      subject: { type: "user", userId: user.id },
    }),
    contactsService.contact.search({
      subject: { type: "user", userId: user.id },
      pagination: { page, perPage },
      filter: {
        query: search.trim() || undefined,
        tagIds: activeTagInternalId ? [activeTagInternalId] : undefined,
        sort: queryOptions.sort,
        email: queryOptions.email,
        phone: queryOptions.phone,
        favoriteUserId: queryOptions.favorites ? user.id : undefined,
      },
    }),
  ]);
  const internalBooks = booksResult.items;
  const internalContacts = contactsResult.items;
  const selectedContact = await resolveSelectedContact({
    contacts: internalContacts,
    contactId: selectedContactIdFromUrl,
    bookId: selectedBookIdFromUrl,
    user,
  });
  const [permissions, internalNotesPage, internalFavoriteKeys, internalGlobalTags] = await Promise.all([
    loadContactBookPermissions({ books: internalBooks, user }),
    selectedContact
      ? contactsService.contact.notes.listPage({
          bookId: selectedContact.bookId,
          contactId: selectedContact.id,
          viewerUserId: user.id,
          pagination: { page: 1, perPage: 30 },
        })
      : Promise.resolve({ items: [], page: 1, perPage: 30, total: 0, hasNext: false }),
    loadFavoriteKeysForContacts(user.id, selectedContact ? [...internalContacts, selectedContact] : internalContacts),
    contactsService.tag.listForBooks({ bookIds: internalBooks.map((book) => book.id) }),
  ]);
  const favoriteContacts = selectedContact ? [...internalContacts, selectedContact] : internalContacts;
  const [books, contacts, projectedSelected, initialNoteItems, favoriteKeys, globalTags] = await Promise.all([
    projectBooks(internalBooks),
    projectContacts(internalContacts),
    selectedContact ? projectContacts([selectedContact]) : Promise.resolve([]),
    projectNotes(internalNotesPage.items),
    projectFavoriteKeys(favoriteContacts, internalFavoriteKeys),
    projectTags(internalGlobalTags),
  ]);
  const initialNotesPage = { ...internalNotesPage, items: initialNoteItems };
  const selectedPublicContact = projectedSelected[0] ?? null;
  const bookIds = new Map(internalBooks.map((book, index) => [book.id, books[index]!.id]));
  const adminBookIds = permissions.adminBookIds.map((id) => bookIds.get(id)!).filter(Boolean);
  const writableBooks = permissions.writableBooks
    .map((book) => ({ ...book, id: bookIds.get(book.id)! }))
    .filter((book) => Boolean(book.id));
  const bookNames = Object.fromEntries(books.map((book) => [book.id, book.name]));
  const totalPages = Math.max(1, Math.ceil(contactsResult.total / perPage));
  const requestUrl = new URL(c.req.raw.url);
  const resultHref = `${requestUrl.pathname}${requestUrl.search}`;
  const initialSelectedContactId = selectedPublicContact?.id ?? selectedContactIdFromUrl;
  const initialSelectedBookId = selectedPublicContact?.bookId ?? selectedBookIdFromUrl;
  const hasDesktopDetailSelection = Boolean(selectedPublicContact);
  return () => (
    <Layout c={c} fullWidth title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbContacts }]}>
      <ContactsLiveEvents scope={{ kind: "all" }} initialCursor={initialLiveCursor} />
      <ContactCreateLauncher writableBooks={writableBooks} />
      <AppWorkspace>
        <ContactsSidebar books={books} active={queryOptions.favorites ? "favorites" : "all"} adminBookIds={adminBookIds} />

        <AppWorkspace.Content>
          <ContactsWorkspaceMain
            title={queryOptions.favorites ? t.favoritesTitle : t.allContactsTitle}
            description={queryOptions.favorites ? t.favoritesDescription : t.allContactsDescription}
            total={contactsResult.total}
            search={search}
            resultHref={resultHref}
            perPage={perPage}
            searchPlaceholder={t.searchPlaceholder}
            contacts={contacts}
            bookNames={bookNames}
            showBookNames
            initialSelectedContactId={initialSelectedContactId}
            initialSelectedBookId={initialSelectedBookId}
            writableBooks={writableBooks}
            defaultCreateBookId={writableBooks[0]?.id ?? null}
            chooseBookOnCreate
            currentPage={contactsResult.page}
            totalPages={totalPages}
            tags={globalTags}
            activeTagId={activeTagId}
            filtersBasePath="/app/contacts"
            initialFavoriteKeys={favoriteKeys}
          />

          <AppWorkspace.Detail
            id="contacts-detail-panel"
            open={hasDesktopDetailSelection}
            width="lg"
            viewTransitionName="contacts-detail-panel-shell"
          >
            <ContactDetailPanel
              initialContact={selectedPublicContact}
              initialContactId={initialSelectedContactId}
              initialBookId={initialSelectedBookId}
              initialNotesPage={initialNotesPage}
              contacts={contacts}
              bookNames={bookNames}
              writableBooks={writableBooks}
              adminBookIds={adminBookIds}
              currentUserId={user.id}
              showEmpty={false}
              initialFavoriteKeys={favoriteKeys}
            />
          </AppWorkspace.Detail>
        </AppWorkspace.Content>
      </AppWorkspace>
      <DesktopDetailLayoutSync detailPanelId="contacts-detail-panel" />
    </Layout>
  );
});
