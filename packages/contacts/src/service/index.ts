import type { AccessEntry } from "@k2b/cloud/contracts";
import { type AccessSubject, type PermissionLevel, paginate, paginateItems } from "@k2b/cloud/server";
import type { PageParams, Paginated } from "@k2b/stdlib";
import * as apiKeys from "./api-keys";
import * as books from "./books";
import * as contactLookup from "./contact-lookup";
import * as contacts from "./contacts";
import * as favorites from "./favorites";
import * as imports from "./imports";
import { contactsLive } from "./live";
import * as notes from "./notes";
import * as tags from "./tags";
import type {
  ContactBook,
  ContactBookAdminListItem,
  CreateBookInput,
  CreateContactInput,
  CreateContactNoteInput,
  CreateContactTagInput,
  UpdateBookInput,
  UpdateContactInput,
  UpdateContactNoteInput,
  UpdateContactTagInput,
} from "./types";

/** Domain writes publish their live update in their own transaction; this only skips the dispatcher's next poll. */
const wake = async <T>(operation: Promise<T>): Promise<T> => {
  const result = await operation;
  contactsLive.wake();
  return result;
};

/**
 * Main Contacts app service facade.
 *
 * The service is stateless and grouped by domain (`book`, `contact`).
 */
export const contactsService = {
  lookup: contactLookup,
  favorite: favorites,
  book: {
    readableIds: async (config: { subject: AccessSubject; boundBookId?: string | null }): Promise<string[]> =>
      (await books.list(config)).map((book) => book.id),
    list: async (config: {
      subject: AccessSubject;
      boundBookId?: string | null;
      pagination?: PageParams;
      filter?: { query?: string };
    }): Promise<Paginated<ContactBook>> => {
      const booksForSubject = await books.list({
        subject: config.subject,
        boundBookId: config.boundBookId,
      });

      const allBooks = booksForSubject;
      const query = config.filter?.query?.trim().toLowerCase();
      const filtered =
        query && query.length > 0
          ? allBooks.filter((book) => {
              const name = book.name.toLowerCase();
              const description = (book.description ?? "").toLowerCase();
              return name.includes(query) || description.includes(query);
            })
          : allBooks;

      return paginateItems(filtered, config.pagination);
    },
    listPage: books.listPage,
    findReadableByName: books.findReadableByName,
    get: (config: { id: string }): Promise<ContactBook | null> => books.get({ id: config.id }),
    create: (config: { data: CreateBookInput; creatorId: string }) => wake(books.create(config)),
    update: (config: { id: string; data: UpdateBookInput }) => wake(books.update(config)),
    remove: (config: { id: string }) => wake(books.remove(config)),
    admin: {
      list: async (config: { pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<ContactBookAdminListItem>> => {
        const { page, perPage, offset } = paginate(config.pagination);
        const result = await books.listAdmin({
          search: config.filter?.query,
          pagination: { limit: perPage, offset },
        });
        return {
          items: result.items,
          page,
          perPage,
          total: result.total,
          hasNext: page * perPage < result.total,
        };
      },
      summary: async (config: { filter?: { query?: string } }) => books.adminSummary({ search: config.filter?.query }),
    },
    permission: {
      get: (config: { bookId: string; subject: AccessSubject }): Promise<PermissionLevel> => books.getPermission(config),
      canAccess: (config: { bookId: string; subject: AccessSubject; requiredLevel?: PermissionLevel }): Promise<boolean> =>
        books.canAccess(config),
    },
    access: {
      list: async (config: {
        bookId: string;
        pagination?: PageParams;
        filter?: {
          query?: string;
          principalType?: AccessEntry["principal"]["type"];
        };
      }): Promise<Paginated<AccessEntry>> => books.access.list(config),
      grant: (config: { bookId: string; principal: AccessEntry["principal"]; permission: PermissionLevel }) =>
        wake(books.access.grant(config)),
      update: (config: { bookId: string; accessId: string; permission: PermissionLevel }) => wake(books.access.update(config)),
      remove: (config: { bookId: string; accessId: string }) => wake(books.access.remove(config)),
      add: (config: { bookId: string; accessId: string }) => wake(books.access.add(config)),
      count: (config: { bookId: string }) => books.access.count(config),
      guard: (config: { bookId: string; accessId: string }) => books.access.guard(config),
      apiKeys: {
        list: apiKeys.list,
        create: apiKeys.create,
        revoke: apiKeys.revoke,
      },
    },
  },
  tag: {
    list: (config: { bookId: string }) => tags.list(config),
    get: tags.get,
    listPage: tags.listPage,
    listForBooks: (config: { bookIds: string[] }) => tags.listForBooks(config),
    create: (config: { bookId: string; data: CreateContactTagInput }) => wake(tags.create(config)),
    update: (config: { bookId: string; id: string; data: UpdateContactTagInput }) => wake(tags.update(config)),
    remove: (config: { bookId: string; id: string }) => wake(tags.remove(config)),
    changeAssignments: (config: Parameters<typeof tags.changeAssignments>[0]) => wake(tags.changeAssignments(config)),
  },
  contact: {
    list: (config: { bookId: string; pagination?: PageParams; filter?: import("./types").ContactListFilter }) => contacts.list(config),
    get: (config: { bookId: string; id: string }) => contacts.get(config),
    findBookId: contacts.findBookId,
    findByDisplayName: contacts.findByDisplayName,
    getMany: (config: { bookId: string; ids: string[] }) => contacts.getMany(config),
    tree: (config: { bookId: string; id: string }) => contacts.tree(config),
    create: (config: { bookId: string; data: CreateContactInput }) => wake(contacts.create(config)),
    createIdempotent: (config: Parameters<typeof contacts.createIdempotent>[0]) => wake(contacts.createIdempotent(config)),
    update: (config: { bookId: string; id: string; data: UpdateContactInput; expectedUpdatedAt?: string }) => wake(contacts.update(config)),
    move: (config: { sourceBookId: string; targetBookId: string; id: string; expectedUpdatedAt?: string }) => wake(contacts.move(config)),
    remove: (config: { bookId: string; id: string; expectedUpdatedAt?: string }) => wake(contacts.remove(config)),
    bulk: {
      addTags: (config: { bookId: string; ids: string[]; tagIds: string[] }) => wake(contacts.addTags(config)),
      remove: (config: { bookId: string; ids: string[] }) => wake(contacts.removeMany(config)),
      move: (config: { sourceBookId: string; targetBookId: string; ids: string[] }) => wake(contacts.moveMany(config)),
    },
    duplicates: {
      list: (config: { bookId: string; limit?: number }) => contacts.findDuplicates(config),
      merge: (config: { bookId: string; keepId: string; removeId: string; keepUpdatedAt: string; removeUpdatedAt: string }) =>
        wake(contacts.mergeDuplicate(config)),
    },
    search: (config: {
      subject: AccessSubject;
      boundBookId?: string | null;
      bypassAccess?: boolean;
      pagination?: PageParams;
      filter?: import("./types").ContactListFilter;
    }) => contacts.search(config),
    notes: {
      list: (config: { bookId: string; contactId: string; viewerUserId?: string | null }) => notes.list(config),
      get: notes.get,
      listPage: notes.listPage,
      create: (config: {
        bookId: string;
        contactId: string;
        authorUserId: string;
        authorDisplayName: string;
        data: CreateContactNoteInput;
      }) => wake(notes.create(config)),
      createIdempotent: (config: Parameters<typeof notes.createIdempotent>[0]) => wake(notes.createIdempotent(config)),
      update: (config: { bookId: string; contactId: string; noteId: string; authorUserId: string; data: UpdateContactNoteInput }) =>
        wake(notes.update(config)),
      remove: (config: { bookId: string; contactId: string; noteId: string; authorUserId: string }) => wake(notes.remove(config)),
    },
  },
  import: {
    ...imports,
    commit: (config: Parameters<typeof imports.commit>[0]) => wake(imports.commit(config)),
  },
};

export type {
  Contact,
  ContactBankAccount,
  ContactBankAccountInput,
  ContactBook,
  ContactBookAdminListItem,
  ContactDuplicateMatch,
  ContactDuplicateReason,
  ContactFavorite,
  ContactListFilter,
  ContactNote,
  ContactPresenceFilter,
  ContactRef,
  ContactSort,
  ContactTag,
  ContactTree,
  ContactTreeNode,
  ContactWebsite,
  CreateBookInput,
  CreateContactInput,
  CreateContactNoteInput,
  CreateContactTagInput,
  UpdateBookInput,
  UpdateContactInput,
  UpdateContactNoteInput,
  UpdateContactTagInput,
} from "./types";
