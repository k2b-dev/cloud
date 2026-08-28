import { AppWorkspace } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import { contactsService } from "../../service";
import { captureContactEventCursor } from "../../service/events";
import {
  projectBooks,
  projectContacts,
  projectFavoriteKeys,
  projectNotes,
  projectTags,
  resolveBookPublicIds,
  resolvePublicId,
} from "../../service/public-resources";
import ContactBookUnavailable from "../_components/ContactBookUnavailable";
import ContactDetailPanel from "../_components/ContactDetailPanel.island";
import ContactsLiveEvents from "../_components/ContactsLiveEvents.island";
import ContactsSidebar from "../_components/ContactsSidebar";
import ContactsWorkspaceMain from "../_components/ContactsWorkspaceMain";
import DesktopDetailLayoutSync from "../_components/DesktopDetailLayoutSync.island";
import {
  CONTACTS_PER_PAGE,
  loadContactBookPermissions,
  loadFavoriteKeysForContacts,
  parseContactsPage,
  parseContactsQueryOptions,
  permissionForBook,
  resolveSelectedContact,
} from "../page-data";
import { pagesMessages } from "../pages-messages";

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const { t } = pagesMessages.resolve([getLocale(c)]);
  const publicBookId = c.req.param("bookId") ?? "";
  const search = c.req.query("search") ?? "";
  const page = parseContactsPage(c.req.query("page"));
  const queryOptions = parseContactsQueryOptions((name) => c.req.query(name));
  const perPage = CONTACTS_PER_PAGE;
  const selectedContactIdFromUrl = c.req.query("contact") ?? null;
  const activeTagId = c.req.query("tag_id") ?? null;
  // The cursor must precede the snapshot reads or an event can fall between them.
  const initialLiveCursor = await captureContactEventCursor();
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) {
    return () => (
      <Layout c={c} title={t.notFoundTitle}>
        <ContactBookUnavailable title={t.bookNotFoundTitle} description={t.linkInvalidDescription} icon="ti ti-address-book-off" />
      </Layout>
    );
  }
  const [book, booksResult] = await Promise.all([
    contactsService.book.get({ id: bookId }),
    contactsService.book.list({
      subject: { type: "user", userId: user.id },
    }),
  ]);
  if (!book) {
    return () => (
      <Layout c={c} title={t.notFoundTitle}>
        <ContactBookUnavailable
          title={t.bookNotFoundTitle}
          description={t.bookDeletedDescription}
          icon="ti ti-address-book-off"
        />
      </Layout>
    );
  }
  const hasReadAccess = await contactsService.book.permission.canAccess({
    bookId,
    subject: { type: "user", userId: user.id },
    requiredLevel: "read",
  });
  if (!hasReadAccess) {
    return () => (
      <Layout c={c} title={t.accessDeniedTitle}>
        <ContactBookUnavailable
          title={t.bookUnavailableTitle}
          description={t.askAdminDescription}
          icon="ti ti-lock"
        />
      </Layout>
    );
  }
  const internalBooks = booksResult.items;
  const {
    entries: permissionEntries,
    adminBookIds: internalAdminBookIds,
    writableBooks: internalWritableBooks,
  } = await loadContactBookPermissions({ books: internalBooks, user });
  const currentPermission = permissionForBook(permissionEntries, book.id);
  const canWrite = currentPermission === "write" || currentPermission === "admin";
  const [activeTagInternalId] = activeTagId ? ((await resolveBookPublicIds("tags", bookId, [activeTagId])) ?? []) : [];
  const [contactsResult, internalBookTags] = await Promise.all([
    contactsService.contact.list({
      bookId,
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
    contactsService.tag.list({ bookId }),
  ]);
  const internalContacts = contactsResult.items;
  const selectedContact = await resolveSelectedContact({
    contacts: internalContacts,
    contactId: selectedContactIdFromUrl,
    bookId: publicBookId,
    user,
  });
  const [internalNotesPage, internalFavoriteKeys] = await Promise.all([
    selectedContact
      ? contactsService.contact.notes.listPage({
          bookId,
          contactId: selectedContact.id,
          viewerUserId: user.id,
          pagination: { page: 1, perPage: 30 },
        })
      : Promise.resolve({ items: [], page: 1, perPage: 30, total: 0, hasNext: false }),
    loadFavoriteKeysForContacts(user.id, selectedContact ? [...internalContacts, selectedContact] : internalContacts),
  ]);
  const favoriteContacts = selectedContact ? [...internalContacts, selectedContact] : internalContacts;
  const [books, publicBook, contacts, projectedSelected, initialNoteItems, favoriteKeys, bookTags] = await Promise.all([
    projectBooks(internalBooks),
    projectBooks([book]),
    projectContacts(internalContacts),
    selectedContact ? projectContacts([selectedContact]) : Promise.resolve([]),
    projectNotes(internalNotesPage.items),
    projectFavoriteKeys(favoriteContacts, internalFavoriteKeys),
    projectTags(internalBookTags),
  ]);
  const initialNotesPage = { ...internalNotesPage, items: initialNoteItems };
  const selectedPublicContact = projectedSelected[0] ?? null;
  const publicBookIds = new Map(internalBooks.map((entry, index) => [entry.id, books[index]!.id]));
  const adminBookIds = internalAdminBookIds.map((id) => publicBookIds.get(id)!).filter(Boolean);
  const writableBooks = internalWritableBooks
    .map((entry) => ({ ...entry, id: publicBookIds.get(entry.id)! }))
    .filter((entry) => Boolean(entry.id));
  const currentBook = publicBook[0]!;
  const bookNames = Object.fromEntries(books.map((entry) => [entry.id, entry.name]));
  const totalPages = Math.max(1, Math.ceil(contactsResult.total / perPage));
  const requestUrl = new URL(c.req.raw.url);
  const resultHref = `${requestUrl.pathname}${requestUrl.search}`;
  const initialSelectedContactId = selectedPublicContact?.id ?? selectedContactIdFromUrl ?? null;
  const initialSelectedBookId = selectedPublicContact ? publicBookId : selectedContactIdFromUrl ? publicBookId : null;
  const hasDesktopDetailSelection = Boolean(selectedPublicContact);
  return () => (
    <Layout
      c={c}
      fullWidth
      title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbContacts, href: "/app/contacts" }, { title: currentBook.name }]}
    >
      <ContactsLiveEvents scope={{ kind: "book", bookId: publicBookId }} initialCursor={initialLiveCursor} />
      <AppWorkspace>
        <ContactsSidebar books={books} active={currentBook.id} adminBookIds={adminBookIds} />

        <AppWorkspace.Content>
          <ContactsWorkspaceMain
            title={currentBook.name}
            description={currentBook.description ?? t.sharedBookDescription}
            total={contactsResult.total}
            search={search}
            resultHref={resultHref}
            bookId={publicBookId}
            perPage={perPage}
            searchPlaceholder={t.filterBookPlaceholder({ name: currentBook.name })}
            contacts={contacts}
            bookNames={bookNames}
            initialSelectedContactId={initialSelectedContactId}
            initialSelectedBookId={initialSelectedBookId}
            writableBooks={writableBooks}
            defaultCreateBookId={canWrite ? currentBook.id : (writableBooks[0]?.id ?? null)}
            chooseBookOnCreate={!canWrite}
            currentPage={contactsResult.page}
            totalPages={totalPages}
            tags={bookTags}
            activeTagId={activeTagId}
            filtersBasePath={`/app/contacts/${publicBookId}`}
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
