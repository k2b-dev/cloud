import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ok } from "@k2b/stdlib";
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
import ContactsLiveEvents from "./_components/ContactsLiveEvents.island";
import ContactsWorkspace from "./_components/ContactsWorkspace";
import DesktopDetailLayoutSync from "./_components/DesktopDetailLayoutSync.island";
import { contactsFavoritesHintOpen } from "./contacts-hints";
import { contactsFiltered } from "./contacts-query";
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
  const scope = books.length === 0 ? "noBooks" : "all";
  const bookNames = Object.fromEntries(books.map((book) => [book.id, book.name]));
  const totalPages = Math.max(1, Math.ceil(contactsResult.data.total / perPage));
  const requestUrl = new URL(c.req.raw.url);
  const resultHref = `${requestUrl.pathname}${requestUrl.search}`;
  const initialSelectedContactId = selectedPublicContact?.id ?? selectedContactIdFromUrl;
  const initialSelectedBookId = selectedPublicContact?.bookId ?? selectedBookIdFromUrl;
  const favoritesHintOpen = contactsFavoritesHintOpen(c, books.length);
  // Reuse the current unfiltered total. Each other view is one bounded count read.
  const countView = async (favorites: boolean) => {
    if (!contactsFiltered(resultHref) && favorites === queryOptions.favorites) return contactsResult.data.total;
    const result = await contactsService.contact.search({
      actor: c.get("actor"),
      accessSubject: c.get("accessSubject"),
      pagination: { page: 1, perPage: 1 },
      filter: { favoriteUserId: favorites ? user.id : undefined },
    });
    return result.ok ? result.data.total : null;
  };
  const [allCount, favoritesCount] = await Promise.all([countView(false), countView(true)]);
  if (allCount === null || favoritesCount === null) return ssr.error(c, 403);
  return () => (
    <Layout c={c} fullWidth title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbContacts }]}>
      <ContactsLiveEvents scope={{ kind: "all" }} initialCursor={initialLiveCursor} />
      <ContactCreateLauncher writableBooks={writableBooks} />
      <ContactsWorkspace
        scope={scope}
        total={contactsResult.data.total}
        resultHref={resultHref}
        perPage={perPage}
        searchPlaceholder={t.searchPlaceholder}
        contacts={contacts}
        bookNames={bookNames}
        showBookNames
        initialSelectedContactId={initialSelectedContactId}
        initialSelectedBookId={initialSelectedBookId}
        writableBooks={writableBooks}
        currentPage={contactsResult.data.page}
        totalPages={totalPages}
        tags={globalTags}
        initialFavoriteKeys={favoriteKeys}
        books={books}
        adminBookIds={adminBookIds}
        currentUserId={user.id}
        initialContact={selectedPublicContact}
        initialNotesPage={initialNotesPage}
        allCount={allCount}
        favoritesCount={favoritesCount}
        favoritesHintOpen={favoritesHintOpen}
      />
      <DesktopDetailLayoutSync detailPanelId="contacts-detail-panel" />
    </Layout>
  );
});
