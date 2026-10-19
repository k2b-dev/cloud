import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ok } from "@k2b/stdlib";
import { AppWorkspace } from "@k2b/ui";
import { ssr } from "../config";
import { contactsService } from "../service";
import { captureContactLiveCursor } from "../service/live";
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
  const initialLiveCursor = await captureContactLiveCursor();
  const activeTagInternalId = activeTagId ? await resolvePublicId("tags", activeTagId) : null;
  const [booksResult, contactsResult] = await Promise.all([
    contactsService.book.list({
      actor: c.get("actor"),
      accessSubject: c.get("accessSubject"),
    }),
    contactsService.contact.search({
      actor: c.get("actor"),
      accessSubject: c.get("accessSubject"),
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
  if (!booksResult.ok) return ssr.error(c, 403);
  if (!contactsResult.ok) return ssr.error(c, 403);
  const internalBooks = booksResult.data.items;
  const internalContacts = contactsResult.data.items;
  const selectedContact = await resolveSelectedContact({
    contacts: internalContacts,
    contactId: selectedContactIdFromUrl,
    bookId: selectedBookIdFromUrl,
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
  });
  const [permissions, notesResult, internalFavoriteKeys, internalGlobalTags] = await Promise.all([
    loadContactBookPermissions({ books: internalBooks, actor: c.get("actor"), accessSubject: c.get("accessSubject") }),
    selectedContact
      ? contactsService.contact.notes.listPage({
          bookId: selectedContact.bookId,
          contactId: selectedContact.id,
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          pagination: { page: 1, perPage: 30 },
        })
      : Promise.resolve(ok({ items: [], page: 1, perPage: 30, total: 0, hasNext: false })),
    loadFavoriteKeysForContacts(c.get("actor"), selectedContact ? [...internalContacts, selectedContact] : internalContacts),
    contactsService.tag.listForBooks({
      actor: c.get("actor"),
      accessSubject: c.get("accessSubject"),
      bookIds: internalBooks.map((book) => book.id),
    }),
  ]);
  if (!notesResult.ok) return ssr.error(c, notesResult.error.code === "NOT_FOUND" ? 404 : 403);
  const internalNotesPage = notesResult.data;
  if (!internalGlobalTags.ok) return ssr.error(c, internalGlobalTags.error.code === "NOT_FOUND" ? 404 : 403);
  const favoriteContacts = selectedContact ? [...internalContacts, selectedContact] : internalContacts;
  const [books, contacts, projectedSelected, initialNoteItems, favoriteKeys, globalTags] = await Promise.all([
    projectBooks(internalBooks),
    projectContacts(internalContacts),
    selectedContact ? projectContacts([selectedContact]) : Promise.resolve([]),
    projectNotes(internalNotesPage.items),
    projectFavoriteKeys(favoriteContacts, internalFavoriteKeys),
    projectTags(internalGlobalTags.data),
  ]);
  const initialNotesPage = { ...internalNotesPage, items: initialNoteItems };
  const selectedPublicContact = projectedSelected[0] ?? null;
  const bookIds = new Map(internalBooks.map((book, index) => [book.id, books[index]!.id]));
  const adminBookIds = permissions.adminBookIds.map((id) => bookIds.get(id)!).filter(Boolean);
  const writableBooks = permissions.writableBooks
    .map((book) => ({ ...book, id: bookIds.get(book.id)! }))
    .filter((book) => Boolean(book.id));
  const scope = books.length === 0 ? "noBooks" : queryOptions.favorites ? "favorites" : "all";
  const bookNames = Object.fromEntries(books.map((book) => [book.id, book.name]));
  const totalPages = Math.max(1, Math.ceil(contactsResult.data.total / perPage));
  const requestUrl = new URL(c.req.raw.url);
  const resultHref = `${requestUrl.pathname}${requestUrl.search}`;
  const initialSelectedContactId = selectedPublicContact?.id ?? selectedContactIdFromUrl;
  const initialSelectedBookId = selectedPublicContact?.bookId ?? selectedBookIdFromUrl;
  const hasDesktopDetailSelection = Boolean(selectedPublicContact);
  return () => (
    <Layout c={c} fullWidth title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbContacts }]}>
      <ContactsLiveEvents scope={{ kind: "all" }} initialCursor={initialLiveCursor} />
      <ContactCreateLauncher writableBooks={writableBooks} />
      <AppWorkspace mobileSurface="flush">
        <ContactsSidebar books={books} active={queryOptions.favorites ? "favorites" : "all"} adminBookIds={adminBookIds} />

        <AppWorkspace.Content>
          <ContactsWorkspaceMain
            scope={scope}
            title={queryOptions.favorites ? t.favoritesTitle : t.allContactsTitle}
            description={queryOptions.favorites ? t.favoritesDescription : t.allContactsDescription}
            total={contactsResult.data.total}
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
            currentPage={contactsResult.data.page}
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
