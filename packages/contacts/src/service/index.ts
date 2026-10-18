import type { AccessEntry } from "@k2b/cloud/contracts";
import { type AccessSubject, hasPermission, type PermissionLevel, paginate, paginateItems, type RequestActor } from "@k2b/cloud/server";
import { err, fail, ok, type PageParams, type Paginated, type Result } from "@k2b/stdlib";
import { getActorBookPermission, isContactsAdministrator, readableBookScope } from "./access";
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

export type BookCaller = { actor: RequestActor; accessSubject: AccessSubject };

const authorizeBook = async (
  bookId: string,
  caller: BookCaller,
  level: PermissionLevel,
): Promise<Result<{ book: ContactBook; permission: PermissionLevel }>> => {
  const book = await books.get({ id: bookId });
  if (!book) return fail(err.notFound("Book"));
  const permission = await getActorBookPermission({ bookId, actor: caller.actor, accessSubject: caller.accessSubject });
  return hasPermission(permission, level) ? ok({ book, permission }) : fail(err.forbidden("Access denied"));
};

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
  lookup: {
    resolveContactsByEmail: async (config: BookCaller & { input: Parameters<typeof contactLookup.resolveContactsByEmail>[0]["input"] }) => {
      const scope = readableBookScope(config);
      if (!scope.ok) return scope;
      return contactLookup.resolveContactsByEmail({ input: config.input, subject: config.accessSubject, ...scope.data });
    },
  },
  favorite: favorites,
  book: {
    authorize: (config: BookCaller & { bookId: string; level: PermissionLevel }) => authorizeBook(config.bookId, config, config.level),
    readableIds: async (caller: BookCaller): Promise<Result<string[]>> => {
      const scope = readableBookScope(caller);
      if (!scope.ok) return scope;
      return ok((await books.list({ subject: caller.accessSubject, ...scope.data })).map((book) => book.id));
    },
    list: async (
      config: BookCaller & {
        pagination?: PageParams;
        filter?: { query?: string };
      },
    ): Promise<Result<Paginated<ContactBook>>> => {
      const scope = readableBookScope(config);
      if (!scope.ok) return scope;
      const allBooks = await books.list({ subject: config.accessSubject, ...scope.data });
      const query = config.filter?.query?.trim().toLowerCase();
      const filtered =
        query && query.length > 0
          ? allBooks.filter((book) => {
              const name = book.name.toLowerCase();
              const description = (book.description ?? "").toLowerCase();
              return name.includes(query) || description.includes(query);
            })
          : allBooks;
      return ok(paginateItems(filtered, config.pagination));
    },
    listPage: async (config: BookCaller & Omit<Parameters<typeof books.listPage>[0], "subject" | "boundBookId">) => {
      const scope = readableBookScope(config);
      if (!scope.ok) return scope;
      return ok(await books.listPage({ ...config, subject: config.accessSubject, ...scope.data }));
    },
    findReadableByName: async (config: BookCaller & { name: string; limit: number }) => {
      const scope = readableBookScope(config);
      if (!scope.ok) return scope;
      return ok(await books.findReadableByName({ ...config, subject: config.accessSubject, ...scope.data }));
    },
    get: (config: BookCaller & { id: string }) => authorizeBook(config.id, config, "read"),
    create: (config: { data: CreateBookInput; creatorId: string }) => wake(books.create(config)),
    update: async (config: BookCaller & { id: string; data: UpdateBookInput }) => {
      const access = await authorizeBook(config.id, config, "admin");
      if (!access.ok) return access;
      return wake(books.update(config));
    },
    remove: async (config: BookCaller & { id: string }) => {
      const access = await authorizeBook(config.id, config, "admin");
      if (!access.ok) return access;
      return wake(books.remove(config));
    },
    admin: {
      get: async (config: { id: string; actor: RequestActor }): Promise<Result<ContactBook>> => {
        if (!isContactsAdministrator(config.actor)) return fail(err.forbidden("Access denied"));
        const book = await books.get({ id: config.id });
        return book ? ok(book) : fail(err.notFound("Book"));
      },
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
      access: {
        list: async (config: Parameters<typeof books.access.list>[0] & { actor: RequestActor }) => {
          if (!isContactsAdministrator(config.actor)) return fail(err.forbidden("Access denied"));
          return ok(await books.access.list(config));
        },
        grant: async (config: Parameters<typeof books.access.grant>[0] & { actor: RequestActor }) => {
          if (!isContactsAdministrator(config.actor)) return fail(err.forbidden("Access denied"));
          return wake(books.access.grant(config));
        },
        update: (config: Omit<Parameters<typeof books.access.update>[0], "authority">) =>
          wake(books.access.update({ ...config, authority: "administration" })),
        remove: (config: Omit<Parameters<typeof books.access.remove>[0], "authority">) =>
          wake(books.access.remove({ ...config, authority: "administration" })),
      },
    },
    permission: {
      forActor: (config: { bookId: string; actor: RequestActor; accessSubject: AccessSubject }): Promise<PermissionLevel> =>
        getActorBookPermission(config),
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
      update: (config: {
        bookId: string;
        accessId: string;
        permission: PermissionLevel;
        actor: RequestActor;
        accessSubject: AccessSubject;
        locale?: string;
      }) => wake(books.access.update({ ...config, authority: "grant" })),
      remove: (config: { bookId: string; accessId: string; actor: RequestActor; accessSubject: AccessSubject; locale?: string }) =>
        wake(books.access.remove({ ...config, authority: "grant" })),
      add: (config: { bookId: string; accessId: string }) => wake(books.access.add(config)),
      count: (config: { bookId: string }) => books.access.count(config),
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
    exportPages: async (config: BookCaller & { bookId: string }) => {
      const access = await authorizeBook(config.bookId, config, "admin");
      if (!access.ok) return access;
      return ok({ book: access.data.book, pages: (signal: AbortSignal) => contacts.exportPages({ bookId: config.bookId, signal }) });
    },
    list: async (config: BookCaller & Parameters<typeof contacts.list>[0]) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      return ok(await contacts.list(config));
    },
    get: async (config: BookCaller & Parameters<typeof contacts.get>[0]) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      return ok(await contacts.get({ bookId: config.bookId, id: config.id }));
    },
    getMany: async (config: BookCaller & Parameters<typeof contacts.getMany>[0]) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      return contacts.getMany(config);
    },
    tree: async (config: BookCaller & Parameters<typeof contacts.tree>[0]) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      return ok(await contacts.tree(config));
    },
    create: async (config: BookCaller & { bookId: string; data: CreateContactInput }) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(contacts.create(config));
    },
    createIdempotent: async (config: BookCaller & Parameters<typeof contacts.createIdempotent>[0]) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(contacts.createIdempotent(config));
    },
    update: async (config: BookCaller & { bookId: string; id: string; data: UpdateContactInput; expectedUpdatedAt?: string }) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(contacts.update(config));
    },
    move: async (config: BookCaller & Parameters<typeof contacts.move>[0]) => {
      const access = await authorizeBook(config.sourceBookId, config, "write");
      if (!access.ok) return access;
      const target = await authorizeBook(config.targetBookId, config, "write");
      if (!target.ok) return target;
      return wake(contacts.move(config));
    },
    remove: async (config: BookCaller & Parameters<typeof contacts.remove>[0]) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(contacts.remove(config));
    },
    findBookId: contacts.findBookId,
    findByDisplayName: contacts.findByDisplayName,
    bulk: {
      addTags: async (config: BookCaller & Parameters<typeof contacts.addTags>[0]) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        return wake(contacts.addTags(config));
      },
      remove: async (config: BookCaller & Parameters<typeof contacts.removeMany>[0]) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        return wake(contacts.removeMany(config));
      },
      move: async (config: BookCaller & Parameters<typeof contacts.moveMany>[0]) => {
        const access = await authorizeBook(config.sourceBookId, config, "write");
        if (!access.ok) return access;
        const target = await authorizeBook(config.targetBookId, config, "write");
        if (!target.ok) return target;
        return wake(contacts.moveMany(config));
      },
    },
    duplicates: {
      list: async (config: BookCaller & Parameters<typeof contacts.findDuplicates>[0]) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        return ok(await contacts.findDuplicates(config));
      },
      merge: async (config: BookCaller & Parameters<typeof contacts.mergeDuplicate>[0]) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        return wake(contacts.mergeDuplicate(config));
      },
    },
    search: async (config: BookCaller & Omit<Parameters<typeof contacts.search>[0], "subject" | "boundBookId">) => {
      const scope = readableBookScope(config);
      if (!scope.ok) return scope;
      return ok(await contacts.search({ ...config, subject: config.accessSubject, ...scope.data }));
    },
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
