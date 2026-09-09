import type { User } from "@k2b/cloud/contracts";
import type { PermissionLevel } from "@k2b/cloud/server";
import { type Contact, type ContactBook, contactsService } from "../service";
import { resolveBookPublicIds, resolvePublicId } from "../service/public-resources";

export { parseContactsQueryOptions } from "./contacts-query";

export const CONTACTS_PER_PAGE = 100;

export const parseContactsPage = (value: string | undefined): number => {
  const parsed = Number(value ?? "1");
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return parsed;
};

export const loadFavoriteKeysForContacts = (userId: string, contacts: Contact[]): Promise<string[]> =>
  contactsService.favorite.listKeysForContacts({ userId, contacts });

export const loadContactBookPermissions = async (config: { books: ContactBook[]; user: User }) => {
  const entries = await Promise.all(
    config.books.map(async (book) => ({
      book,
      permission: await contactsService.book.permission.get({
        bookId: book.id,
        subject: { type: "user", userId: config.user.id },
      }),
    })),
  );

  return {
    entries,
    adminBookIds: entries.filter((entry) => entry.permission === "admin").map((entry) => entry.book.id),
    writableBooks: entries
      .filter((entry) => entry.permission === "write" || entry.permission === "admin")
      .map((entry) => ({ id: entry.book.id, name: entry.book.name })),
  };
};

export const permissionForBook = (entries: Array<{ book: ContactBook; permission: PermissionLevel }>, bookId: string): PermissionLevel =>
  entries.find((entry) => entry.book.id === bookId)?.permission ?? "read";

export const resolveSelectedContact = async (config: {
  contacts: Contact[];
  contactId: string | null;
  bookId: string | null;
  user: User;
}): Promise<Contact | null> => {
  if (!config.contactId || !config.bookId) return null;

  const internalBookId = await resolvePublicId("books", config.bookId);
  if (!internalBookId) return null;
  const [internalContactId] = (await resolveBookPublicIds("contacts", internalBookId, [config.contactId])) ?? [];
  if (!internalContactId) return null;

  const selectedFromPage = config.contacts.find((contact) => contact.id === internalContactId && contact.bookId === internalBookId) ?? null;
  if (selectedFromPage) return selectedFromPage;

  const hasReadAccess = await contactsService.book.permission.canAccess({
    bookId: internalBookId,
    subject: { type: "user", userId: config.user.id },
    requiredLevel: "read",
  });
  if (!hasReadAccess) return null;

  return contactsService.contact.get({ bookId: internalBookId, id: internalContactId });
};
