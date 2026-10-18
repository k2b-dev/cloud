import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessSubject, RequestActor } from "@k2b/cloud/server";
import { type ContactBook, contactsService } from "../service";
import * as access from "../service/access";
import * as booksService from "../service/books";
import * as contacts from "../service/contacts";
import * as publicResources from "../service/public-resources";
import { loadContactBookPermissions, parseContactsPage, parseContactsQueryOptions, resolveSelectedContact } from "./page-data";

describe("contacts page state", () => {
  test("normalizes invalid page values", () => {
    expect(parseContactsPage(undefined)).toBe(1);
    expect(parseContactsPage("0")).toBe(1);
    expect(parseContactsPage("2.5")).toBe(1);
    expect(parseContactsPage("3")).toBe(3);
  });

  test("normalizes list filters for SSR", () => {
    const values = { sort: "company", email: "no", phone: "invalid", favorites: "true" } as Record<string, string>;
    expect(parseContactsQueryOptions((name) => values[name])).toEqual({ sort: "company", email: "no", phone: "all", favorites: true });
  });
});

const actor: RequestActor = {
  kind: "service_account",
  serviceAccount: {
    id: "77777777-7777-4777-8777-777777777777",
    name: "Contacts reader",
    kind: "standalone",
    status: "active",
    delegatedUserId: null,
    appId: null,
    resourceType: null,
    resourceId: null,
    createdBy: null,
    createdAt: "2026-10-17T00:00:00.000Z",
  },
  delegatedUser: null,
  scopes: ["read"],
};
const accessSubject: AccessSubject = { type: "service_account", serviceAccountId: actor.serviceAccount.id };
const books: ContactBook[] = ["read", "write", "admin"].map((id) => ({
  id,
  name: id,
  description: null,
  createdAt: null,
  updatedAt: null,
}));

afterEach(() => mock.restore());

test("SSR forwards actor and accessSubject and preserves book order and permission groups", async () => {
  const permission = spyOn(contactsService.book.permission, "forActor").mockImplementation(async ({ bookId }) => {
    if (bookId === "admin") return "admin";
    if (bookId === "write") return "write";
    return "read";
  });
  const result = await loadContactBookPermissions({ books, actor, accessSubject });
  expect(permission.mock.calls).toEqual(books.map((book) => [{ bookId: book.id, actor, accessSubject }]));
  expect(result).toEqual({
    entries: [
      { book: books[0]!, permission: "read" },
      { book: books[1]!, permission: "write" },
      { book: books[2]!, permission: "admin" },
    ],
    adminBookIds: ["admin"],
    writableBooks: [
      { id: "write", name: "write" },
      { id: "admin", name: "admin" },
    ],
  });
});

test("SSR selection checks the shared permission before loading a contact outside the page", async () => {
  spyOn(publicResources, "resolvePublicId").mockResolvedValue("internal-book");
  spyOn(publicResources, "resolveBookPublicIds").mockResolvedValue(["internal-contact"]);
  spyOn(booksService, "get").mockResolvedValue(books[0]!);
  const permission = spyOn(access, "getActorBookPermission").mockResolvedValue("none");
  const get = spyOn(contacts, "get").mockResolvedValue(null);
  const selection = { contacts: [], contactId: "Cont01", bookId: "Book01", actor, accessSubject };
  expect(await resolveSelectedContact(selection)).toBeNull();
  expect(permission).toHaveBeenCalledWith({ bookId: "internal-book", actor, accessSubject });
  expect(get).not.toHaveBeenCalled();
  permission.mockResolvedValue("read");
  expect(await resolveSelectedContact(selection)).toBeNull();
  expect(get).toHaveBeenCalledWith({ bookId: "internal-book", id: "internal-contact" });
});
