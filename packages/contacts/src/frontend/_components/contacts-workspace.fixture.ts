import type { ContactsWorkspaceProps } from "./ContactsWorkspace";

const date = "2026-10-17T12:00:00.000Z";
export const workspaceFixture = {
  scope: "all",
  books: [{ id: "team", name: "Team", description: "Book description only in settings", createdAt: date, updatedAt: date }],
  adminBookIds: [],
  writableBooks: [],
  currentUserId: "reader",
  contacts: [],
  bookNames: { team: "Team" },
  initialSelectedContactId: null,
  initialSelectedBookId: null,
  initialContact: null,
  initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
  initialFavoriteKeys: [],
  total: 2,
  allCount: 8,
  favoritesCount: 2,
  resultHref: "/app/contacts?favorites=true",
  currentPage: 1,
  totalPages: 1,
  perPage: 100,
  searchPlaceholder: "Search contacts",
  tags: [
    { id: "vip", bookId: "team", name: "VIP", color: "#ffff80", createdAt: date, updatedAt: date },
    { id: "client", bookId: "team", name: "Client", color: "#123456", createdAt: date, updatedAt: date },
  ],
} satisfies ContactsWorkspaceProps;
