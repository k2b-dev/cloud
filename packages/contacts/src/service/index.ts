import { ok, type PageParams, type Paginated, type Result } from "@k2b/stdlib";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { type AccessSubject, type PermissionLevel, paginate, paginateItems } from "@k2b/cloud/server";
import type { ContactServiceEventData } from "../live-events";
import * as apiKeys from "./api-keys";
import * as books from "./books";
import * as contactLookup from "./contact-lookup";
import * as contacts from "./contacts";
import { publishContactEvent } from "./events";
import * as favorites from "./favorites";
import * as imports from "./imports";
import * as notes from "./notes";
import { projectContactEventIds } from "./public-resources";
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

const withEvent = async <T>(
  operation: Promise<Result<T>>,
  event: ContactServiceEventData | ((data: T) => ContactServiceEventData),
): Promise<Result<T>> => {
  const result = await operation;
  if (result.ok) {
    await publishContactEvent(typeof event === "function" ? event(result.data) : event);
  }
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
    get: (config: { id: string }): Promise<ContactBook | null> => books.get({ id: config.id }),
    create: (config: { data: CreateBookInput; creatorId: string }) =>
      withEvent(books.create(config), (book) => ({ type: "book.created", bookId: book.id })),
    update: (config: { id: string; data: UpdateBookInput }) => withEvent(books.update(config), { type: "book.updated", bookId: config.id }),
    remove: async (config: { id: string }) => {
      const event = { type: "book.deleted" as const, bookId: config.id };
      const publicEvent = await projectContactEventIds({ ...event, at: new Date().toISOString() });
      const result = await books.remove(config);
      if (result.ok) await publishContactEvent(event, publicEvent);
      return result;
    },
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
        withEvent(books.access.grant(config), { type: "access.changed", bookId: config.bookId }),
      update: (config: { bookId: string; accessId: string; permission: PermissionLevel }) =>
        withEvent(books.access.update(config), { type: "access.changed", bookId: config.bookId }),
      remove: (config: { bookId: string; accessId: string }) =>
        withEvent(books.access.remove(config), { type: "access.changed", bookId: config.bookId }),
      add: (config: { bookId: string; accessId: string }) =>
        withEvent(books.access.add(config), { type: "access.changed", bookId: config.bookId }),
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
    create: (config: { bookId: string; data: CreateContactTagInput }) =>
      withEvent(tags.create(config), { type: "tags.changed", bookId: config.bookId }),
    update: (config: { bookId: string; id: string; data: UpdateContactTagInput }) =>
      withEvent(tags.update(config), { type: "tags.changed", bookId: config.bookId }),
    remove: (config: { bookId: string; id: string }) => withEvent(tags.remove(config), { type: "tags.changed", bookId: config.bookId }),
    changeAssignments: (config: Parameters<typeof tags.changeAssignments>[0]) =>
      withEvent(tags.changeAssignments(config), { type: "contact.updated", bookId: config.bookId, contactId: config.contactId }),
  },
  contact: {
    list: (config: { bookId: string; pagination?: PageParams; filter?: import("./types").ContactListFilter }) => contacts.list(config),
    get: (config: { bookId: string; id: string }) => contacts.get(config),
    findBookId: contacts.findBookId,
    getMany: (config: { bookId: string; ids: string[] }) => contacts.getMany(config),
    tree: (config: { bookId: string; id: string }) => contacts.tree(config),
    create: (config: { bookId: string; data: CreateContactInput }) =>
      withEvent(contacts.create(config), (contact) => ({ type: "contact.created", bookId: config.bookId, contactId: contact.id })),
    createIdempotent: async (config: Parameters<typeof contacts.createIdempotent>[0]) => {
      const result = await contacts.createIdempotent(config);
      if (!result.ok) return result;
      if (!result.data.replayed) {
        await publishContactEvent({ type: "contact.created", bookId: config.bookId, contactId: result.data.id });
      }
      return ok(result.data);
    },
    update: (config: { bookId: string; id: string; data: UpdateContactInput; expectedUpdatedAt?: string }) =>
      withEvent(contacts.update(config), { type: "contact.updated", bookId: config.bookId, contactId: config.id }),
    move: (config: { sourceBookId: string; targetBookId: string; id: string; expectedUpdatedAt?: string }) =>
      withEvent(contacts.move(config), {
        type: "contact.moved",
        sourceBookId: config.sourceBookId,
        targetBookId: config.targetBookId,
        contactId: config.id,
      }),
    remove: async (config: { bookId: string; id: string; expectedUpdatedAt?: string }) => {
      const event = { type: "contact.deleted" as const, bookId: config.bookId, contactId: config.id };
      const publicEvent = await projectContactEventIds({ ...event, at: new Date().toISOString() });
      const result = await contacts.remove(config);
      if (result.ok) await publishContactEvent(event, publicEvent);
      return result;
    },
    bulk: {
      addTags: (config: { bookId: string; ids: string[]; tagIds: string[] }) =>
        withEvent(contacts.addTags(config), { type: "contacts.changed", bookId: config.bookId }),
      remove: (config: { bookId: string; ids: string[] }) =>
        withEvent(contacts.removeMany(config), { type: "contacts.changed", bookId: config.bookId }),
      move: async (config: { sourceBookId: string; targetBookId: string; ids: string[] }) => {
        const result = await contacts.moveMany(config);
        if (result.ok) {
          await Promise.all([
            publishContactEvent({ type: "contacts.changed", bookId: config.sourceBookId }),
            publishContactEvent({ type: "contacts.changed", bookId: config.targetBookId }),
          ]);
        }
        return result;
      },
    },
    duplicates: {
      list: (config: { bookId: string; limit?: number }) => contacts.findDuplicates(config),
      merge: (config: { bookId: string; keepId: string; removeId: string; keepUpdatedAt: string; removeUpdatedAt: string }) =>
        withEvent(contacts.mergeDuplicate(config), { type: "contacts.changed", bookId: config.bookId }),
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
      }) => withEvent(notes.create(config), { type: "notes.changed", bookId: config.bookId, contactId: config.contactId }),
      createIdempotent: async (config: Parameters<typeof notes.createIdempotent>[0]) => {
        const result = await notes.createIdempotent(config);
        if (result.ok && !result.data.replayed) {
          await publishContactEvent({ type: "notes.changed", bookId: config.bookId, contactId: config.contactId });
        }
        return result;
      },
      update: (config: { bookId: string; contactId: string; noteId: string; authorUserId: string; data: UpdateContactNoteInput }) =>
        withEvent(notes.update(config), { type: "notes.changed", bookId: config.bookId, contactId: config.contactId }),
      remove: (config: { bookId: string; contactId: string; noteId: string; authorUserId: string }) =>
        withEvent(notes.remove(config), { type: "notes.changed", bookId: config.bookId, contactId: config.contactId }),
    },
  },
  import: {
    ...imports,
    commit: async (config: Parameters<typeof imports.commit>[0]) => {
      const result = await imports.commit(config);
      if (result.created > 0) await publishContactEvent({ type: "contacts.imported", bookId: config.bookId });
      return result;
    },
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
