import { LocaleProvider, PageTrailProvider } from "@k2b/ui";
import type { Contact, ContactBook, ContactTag } from "../../service";
import ContactCreateLauncher from "./ContactCreateLauncher.island";
import DesktopDetailLayoutSync from "./DesktopDetailLayoutSync.island";
import ContactsWorkspace, { type ContactsWorkspaceProps } from "./ContactsWorkspace";

export const TIME = "2026-10-20T10:00:00.000Z";
export const books: ContactBook[] = [
  { id: "kunden", name: "Kunden", description: "Auftraggeber der Druckerei", createdAt: TIME, updatedAt: TIME },
  { id: "lieferanten", name: "Lieferanten", description: "Papier und Druckfarben", createdAt: TIME, updatedAt: TIME },
  { id: "presse", name: "Presse und Medien", description: "Redaktionen und Verlage", createdAt: TIME, updatedAt: TIME },
];
export const tags: ContactTag[] = [
  { id: "stammkunde", bookId: "kunden", name: "Stammkunde", color: "#0ea5e9", createdAt: TIME, updatedAt: TIME },
  { id: "messe", bookId: "kunden", name: "Messe 2026", color: "#f59e0b", createdAt: TIME, updatedAt: TIME },
  { id: "rueckruf", bookId: "kunden", name: "Rückruf", color: "#a3e635", createdAt: TIME, updatedAt: TIME },
];
const names = [
  "Alina Brandt",
  "Benedikt Sommer",
  "Carla Fuchs",
  "David Reuter",
  "Elena Weiß",
  "Felix König",
  "Greta Wolf",
  "Hannes Vogel",
  "Ida Neumann",
  "Jonas Busch",
  "Klara Seidel",
  "Lukas Frank",
  "Maximiliane Hoffmann-Bergsträßer von Lindenau",
  "Nora Winter",
  "Oskar Stein",
  "Paula Berger",
  "Romy Krause",
  "Theo Schulz",
];
// Entirely invented people at a small print shop; no external services or personal data.
export const contacts: Contact[] = names.map((name, index) => {
  const id = `person${index + 1}`;
  return {
    id,
    bookId: index < 14 ? "kunden" : index < 16 ? "lieferanten" : "presse",
    label: null,
    firstName: name.split(" ")[0]!,
    lastName: name.slice(name.indexOf(" ") + 1),
    companyName: index < 14 ? "Druckatelier Morgenrot" : "Papierwerk Beispiel",
    department: null,
    jobTitle: "Ansprechperson",
    vatId: null,
    birthday: null,
    salutation: null,
    pronouns: null,
    preferredLanguage: null,
    source: null,
    createdAt: TIME,
    updatedAt: TIME,
    emails:
      index % 3 === 0
        ? []
        : [
            {
              id: `email${index}`,
              contactId: id,
              label: "Arbeit",
              email: `person${index + 1}@example.test`,
              position: 0,
              createdAt: TIME,
              updatedAt: TIME,
            },
          ],
    phones:
      index % 4 === 0
        ? []
        : [
            {
              id: `phone${index}`,
              contactId: id,
              label: "Arbeit",
              phone: `+493055500${index}`,
              position: 0,
              createdAt: TIME,
              updatedAt: TIME,
            },
          ],
    addresses: [],
    websites: [],
    bankAccounts: [],
    parentContactId: null,
    parent: null,
    members: [],
    tags: index < 14 ? [tags[index % tags.length]!] : [],
  };
});
export const favoriteKeys = ["kunden:person1", "kunden:person3", "kunden:person9", "lieferanten:person15"];
export const notesPage = { items: [], page: 1, perPage: 30, total: 0, hasNext: false };

/** Shared by SSR and the two real typed-client collection routes. */
export function results(url: URL, bookId?: string) {
  const query = url.searchParams;
  const search = (query.get("q") ?? query.get("search") ?? "").trim().toLocaleLowerCase("de");
  let data = contacts.filter(
    (contact) =>
      (!bookId || contact.bookId === bookId) &&
      (!search ||
        [contact.firstName, contact.lastName, contact.companyName, ...contact.emails.map((email) => email.email)]
          .join(" ")
          .toLocaleLowerCase("de")
          .includes(search)) &&
      (!query.get("tag_id") || contact.tags.some((tag) => tag.id === query.get("tag_id"))) &&
      (query.get("favorites") !== "true" || favoriteKeys.includes(`${contact.bookId}:${contact.id}`)) &&
      ["email", "phone"].every((key) => {
        const present = key === "email" ? contact.emails.length > 0 : contact.phones.length > 0;
        return (query.get(key) !== "yes" && query.get(key) !== "no") || present === (query.get(key) === "yes");
      }),
  );
  if (query.get("fixtureEmpty") === "book" || query.has("noBooks")) data = [];
  const sort = query.get("sort");
  data = data.toSorted((a, b) =>
    sort === "created" || sort === "updated"
      ? b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
      : `${sort === "company" ? a.companyName : ""} ${a.firstName} ${a.lastName}`.localeCompare(
          `${sort === "company" ? b.companyName : ""} ${b.firstName} ${b.lastName}`,
          "de",
        ),
  );
  const page = Number(query.get("page") ?? 1);
  const perPage = Number(query.get("per_page") ?? 100);
  return {
    data: data.slice((page - 1) * perPage, page * perPage),
    favoriteKeys: favoriteKeys.filter((key) => data.some((contact) => `${contact.bookId}:${contact.id}` === key)),
    pagination: { page, per_page: perPage, total: data.length, total_pages: Math.ceil(data.length / perPage) },
  };
}

export default function ContactsShellFixture(props: { source: string; hintOpen: boolean }) {
  const url = new URL(props.source, "http://contacts.local");
  const bookId = url.pathname.split("/")[3];
  const readableBooks = url.searchParams.has("noBooks") ? [] : books;
  const writableBooks = readableBooks.filter((book) => book.id !== "presse");
  const payload = results(url, bookId);
  const unfiltered = new URL(url.pathname, url);
  if (url.searchParams.has("noBooks")) unfiltered.searchParams.set("noBooks", "1");
  if (url.searchParams.has("fixtureEmpty")) unfiltered.searchParams.set("fixtureEmpty", "book");
  const allCount = results(unfiltered, bookId).pagination.total;
  unfiltered.searchParams.set("favorites", "true");
  const initialContact =
    contacts.find((contact) => contact.id === url.searchParams.get("contact") && contact.bookId === url.searchParams.get("contactBook")) ??
    null;
  const workspace: ContactsWorkspaceProps = {
    scope: bookId ? "book" : "all",
    bookId,
    books: readableBooks,
    writableBooks,
    adminBookIds: ["kunden"],
    currentUserId: "printshop-reader",
    contacts: payload.data,
    bookNames: Object.fromEntries(readableBooks.map((book) => [book.id, book.name])),
    showBookNames: !bookId,
    initialContact,
    initialSelectedContactId: initialContact?.id ?? null,
    initialSelectedBookId: initialContact?.bookId ?? null,
    initialNotesPage: notesPage,
    initialFavoriteKeys: payload.favoriteKeys,
    total: payload.pagination.total,
    allCount,
    favoritesCount: results(unfiltered, bookId).pagination.total,
    resultHref: props.source,
    currentPage: 1,
    totalPages: Math.max(1, payload.pagination.total_pages),
    perPage: 100,
    searchPlaceholder: "Kontakte suchen",
    tags: bookId ? tags.filter((tag) => tag.bookId === bookId) : tags,
    favoritesHintOpen: props.hintOpen,
  };
  return (
    <LocaleProvider locale="de">
      <PageTrailProvider
        trail={{
          title: books.find((book) => book.id === bookId)?.name ?? "Kontakte",
          ancestors: [{ title: "Start", href: "/" }, ...(bookId ? [{ title: "Kontakte", href: "/app/contacts" }] : [])],
        }}
      >
        {!bookId && <ContactCreateLauncher writableBooks={writableBooks} />}
        <ContactsWorkspace
          {...workspace}
          detailLauncher={
            bookId ? (
              <ContactCreateLauncher
                writableBooks={writableBooks}
                defaultBookId={writableBooks.some((book) => book.id === bookId) ? bookId : undefined}
              />
            ) : undefined
          }
        />
        <DesktopDetailLayoutSync detailPanelId="contacts-detail-panel" />
      </PageTrailProvider>
    </LocaleProvider>
  );
}
