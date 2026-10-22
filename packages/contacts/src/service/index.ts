import type { AccessEntry } from "@k2b/cloud/contracts";
import {
  type AccessSubject,
  hasPermission,
  type PermissionLevel,
  paginate,
  paginateItems,
  type RequestActor,
  userFromActor,
} from "@k2b/cloud/server";
import { err, fail, ok, type PageParams, type Paginated, type Result } from "@k2b/stdlib";
import { capByCredential, credentialPermission, getActorBookPermission, isContactsAdministrator, readableBookScope } from "./access";
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
  UpdateBookInput,
  UpdateContactInput,
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

const readableIds = async (caller: BookCaller): Promise<Result<string[]>> => {
  const scope = readableBookScope(caller);
  if (!scope.ok) return scope;
  return ok((await books.list({ subject: caller.accessSubject, ...scope.data })).map((book) => book.id));
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
  favorite: {
    list: async (caller: BookCaller) => {
      const user = userFromActor(caller.actor);
      if (!user) return fail(err.forbidden("This endpoint requires a user-backed actor"));
      const ids = await readableIds(caller);
      if (!ids.ok) return ids;
      const readable = new Set(ids.data);
      return ok((await favorites.list(user.id)).filter((favorite) => readable.has(favorite.bookId)));
    },
    listKeysForContacts: (config: {
      actor: RequestActor;
      contacts: Parameters<typeof favorites.listKeysForContacts>[0]["contacts"];
    }): Promise<string[]> => {
      const user = userFromActor(config.actor);
      return user ? favorites.listKeysForContacts({ userId: user.id, contacts: config.contacts }) : Promise.resolve([]);
    },
    has: async (config: BookCaller & { bookId: string; contactId: string }) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      const user = userFromActor(config.actor);
      if (!user) return fail(err.forbidden("This endpoint requires a user-backed actor"));
      return ok(await favorites.has({ ...config, userId: user.id }));
    },
    set: async (config: BookCaller & { bookId: string; contactId: string; favorite: boolean }) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      const user = userFromActor(config.actor);
      if (!user) return fail(err.forbidden("This endpoint requires a user-backed actor"));
      if (config.favorite && !(await contacts.get({ bookId: config.bookId, id: config.contactId }))) return fail(err.notFound("Contact"));
      await favorites.set({ ...config, userId: user.id });
      return ok(undefined);
    },
  },
  book: {
    readableIds,
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
      const ceiling = credentialPermission(config.actor);
      const minimumPermission = config.filter?.minimumPermission;
      if (minimumPermission && !hasPermission(ceiling, minimumPermission)) {
        return fail(err.forbidden(`The Contacts credential does not grant ${minimumPermission} access`));
      }
      const page = await books.listPage({ ...config, subject: config.accessSubject, ...scope.data });
      return ok({ ...page, items: page.items.map((book) => ({ ...book, permission: capByCredential(config.actor, book.permission) })) });
    },
    findReadableByName: async (config: BookCaller & { name: string; limit: number }) => {
      const scope = readableBookScope(config);
      if (!scope.ok) return scope;
      return ok(await books.findReadableByName({ ...config, subject: config.accessSubject, ...scope.data }));
    },
    /** `level` is the intent the caller loads the book for, such as an action review; it is the same single decision. */
    get: (config: BookCaller & { id: string; level?: PermissionLevel }) => authorizeBook(config.id, config, config.level ?? "read"),
    settingsContext: async (config: BookCaller & { id: string }) => {
      const access = await authorizeBook(config.id, config, "admin");
      if (!access.ok) return access;
      const [accessEntries, keys, bookTags] = await Promise.all([
        books.access.list({ bookId: config.id }),
        apiKeys.list({ bookId: config.id }),
        tags.list({ bookId: config.id }),
      ]);
      return ok({ book: access.data.book, accessEntries: accessEntries.items, apiKeys: keys, tags: bookTags });
    },
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
      list: async (config: {
        actor: RequestActor;
        pagination?: PageParams;
        filter?: { query?: string };
      }): Promise<Result<Paginated<ContactBookAdminListItem>>> => {
        if (!isContactsAdministrator(config.actor)) return fail(err.forbidden("Access denied"));
        const { page, perPage, offset } = paginate(config.pagination);
        const result = await books.listAdmin({
          search: config.filter?.query,
          pagination: { limit: perPage, offset },
        });
        return ok({
          items: result.items,
          page,
          perPage,
          total: result.total,
          hasNext: page * perPage < result.total,
        });
      },
      summary: async (config: { actor: RequestActor; filter?: { query?: string } }) => {
        if (!isContactsAdministrator(config.actor)) return fail(err.forbidden("Access denied"));
        return ok(await books.adminSummary({ search: config.filter?.query }));
      },
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
      list: async (
        config: BookCaller & {
          bookId: string;
          pagination?: PageParams;
          filter?: {
            query?: string;
            principalType?: AccessEntry["principal"]["type"];
          };
        },
      ) => {
        const access = await authorizeBook(config.bookId, config, "admin");
        if (!access.ok) return access;
        return ok(await books.access.list(config));
      },
      grant: async (config: BookCaller & { bookId: string; principal: AccessEntry["principal"]; permission: PermissionLevel }) => {
        const access = await authorizeBook(config.bookId, config, "admin");
        if (!access.ok) return access;
        return wake(books.access.grant(config));
      },
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
      apiKeys: {
        list: async (config: BookCaller & { bookId: string }) => {
          const access = await authorizeBook(config.bookId, config, "admin");
          if (!access.ok) return access;
          return ok(await apiKeys.list(config));
        },
        create: async (config: BookCaller & { bookId: string; data: Parameters<typeof apiKeys.create>[0]["data"] }) => {
          const access = await authorizeBook(config.bookId, config, "admin");
          if (!access.ok) return access;
          const user = userFromActor(config.actor);
          if (!user) return fail(err.forbidden("This endpoint requires a user-backed actor"));
          return apiKeys.create({ ...config, bookName: access.data.book.name, actor: user });
        },
        revoke: async (config: BookCaller & { bookId: string; credentialId: string }) => {
          const access = await authorizeBook(config.bookId, config, "admin");
          if (!access.ok) return access;
          const user = userFromActor(config.actor);
          if (!user) return fail(err.forbidden("This endpoint requires a user-backed actor"));
          return apiKeys.revoke({ ...config, actor: user });
        },
      },
    },
  },
  tag: {
    list: async (config: BookCaller & Parameters<typeof tags.list>[0]) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      return ok(await tags.list(config));
    },
    listPage: async (config: BookCaller & Parameters<typeof tags.listPage>[0]) => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      return ok(await tags.listPage(config));
    },
    create: async (config: BookCaller & Parameters<typeof tags.create>[0]) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(tags.create(config));
    },
    update: async (config: BookCaller & Parameters<typeof tags.update>[0]) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(tags.update(config));
    },
    remove: async (config: BookCaller & Parameters<typeof tags.remove>[0]) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(tags.remove(config));
    },
    changeAssignments: async (config: BookCaller & Parameters<typeof tags.changeAssignments>[0]) => {
      const access = await authorizeBook(config.bookId, config, "write");
      if (!access.ok) return access;
      return wake(tags.changeAssignments(config));
    },
    get: async (config: BookCaller & { id: string }) => {
      const tag = await tags.get({ id: config.id });
      if (!tag) return fail(err.notFound("Tag"));
      const access = await authorizeBook(tag.bookId, config, "read");
      return access.ok ? ok(tag) : access;
    },
    listForBooks: async (config: BookCaller & { bookIds: string[] }) => {
      const ids = await readableIds(config);
      if (!ids.ok) return ids;
      const readable = new Set(ids.data);
      return ok(await tags.listForBooks({ bookIds: config.bookIds.filter((id) => readable.has(id)) }));
    },
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
    get: async (config: BookCaller & Parameters<typeof contacts.get>[0] & { level?: PermissionLevel }) => {
      const access = await authorizeBook(config.bookId, config, config.level ?? "read");
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
    findBookId: (config: Parameters<typeof contacts.findBookId>[0]) => contacts.findBookId(config),
    findByDisplayName: async (config: BookCaller & Parameters<typeof contacts.findByDisplayName>[0]): Promise<Result<string[]>> => {
      const access = await authorizeBook(config.bookId, config, "read");
      if (!access.ok) return access;
      const { bookId, name, limit } = config;
      return ok(await contacts.findByDisplayName({ bookId, name, limit }));
    },
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
      list: async (config: BookCaller & Omit<Parameters<typeof notes.list>[0], "viewerUserId">) => {
        const access = await authorizeBook(config.bookId, config, "read");
        if (!access.ok) return access;
        return ok(await notes.list({ ...config, viewerUserId: userFromActor(config.actor)?.id ?? null }));
      },
      listPage: async (config: BookCaller & Omit<Parameters<typeof notes.listPage>[0], "viewerUserId">) => {
        const access = await authorizeBook(config.bookId, config, "read");
        if (!access.ok) return access;
        return ok(await notes.listPage({ ...config, viewerUserId: userFromActor(config.actor)?.id ?? null }));
      },
      get: async (config: BookCaller & { id: string }) => {
        const note = await notes.get({ id: config.id, viewerUserId: userFromActor(config.actor)?.id ?? null });
        if (!note) return fail(err.notFound("Note"));
        const bookId = await contacts.findBookId({ id: note.contactId });
        if (!bookId) return fail(err.notFound("Contact"));
        const access = await authorizeBook(bookId, config, "read");
        return access.ok ? ok(note) : access;
      },
      create: async (config: BookCaller & Omit<Parameters<typeof notes.create>[0], "authorUserId" | "authorDisplayName">) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        const user = userFromActor(config.actor);
        if (!user) return fail(err.forbidden("A user identity is required to create notes"));
        return wake(notes.create({ ...config, authorUserId: user.id, authorDisplayName: user.displayName ?? user.uid }));
      },
      createIdempotent: async (
        config: BookCaller & Omit<Parameters<typeof notes.createIdempotent>[0], "authorUserId" | "authorDisplayName">,
      ) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        const user = userFromActor(config.actor);
        if (!user) return fail(err.forbidden("A user identity is required to create notes"));
        return wake(notes.createIdempotent({ ...config, authorUserId: user.id, authorDisplayName: user.displayName ?? user.uid }));
      },
      update: async (config: BookCaller & Omit<Parameters<typeof notes.update>[0], "authorUserId">) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        const user = userFromActor(config.actor);
        if (!user) return fail(err.forbidden("Only the author may edit this note"));
        return wake(notes.update({ ...config, authorUserId: user.id }));
      },
      remove: async (config: BookCaller & Omit<Parameters<typeof notes.remove>[0], "authorUserId">) => {
        const access = await authorizeBook(config.bookId, config, "write");
        if (!access.ok) return access;
        const user = userFromActor(config.actor);
        if (!user) return fail(err.forbidden("Only the author may delete this note"));
        return wake(notes.remove({ ...config, authorUserId: user.id }));
      },
    },
  },
  import: {
    MAX_IMPORT_CONTACTS: imports.MAX_IMPORT_CONTACTS,
    MAX_IMPORT_CONTENT_CHARS: imports.MAX_IMPORT_CONTENT_CHARS,
    MAX_IMPORT_BODY_BYTES: imports.MAX_IMPORT_BODY_BYTES,
    preview: async (config: BookCaller & Parameters<typeof imports.preview>[0]) => {
      const access = await authorizeBook(config.bookId, config, "admin");
      if (!access.ok) return access;
      return imports.preview(config);
    },
    commit: async (config: BookCaller & Parameters<typeof imports.commit>[0]) => {
      const access = await authorizeBook(config.bookId, config, "admin");
      if (!access.ok) return access;
      return ok(await wake(imports.commit(config)));
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
