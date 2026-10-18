import { hasRole } from "@k2b/cloud/contracts";
import {
  type AccessEntry,
  type AccessSubject,
  createAccess,
  deleteAccess,
  ensureManagerRemains,
  getEffectivePermission,
  getEffectivePermissions,
  hasPermission,
  type PermissionLevel,
  type Principal,
  paginateItems,
  type RequestActor,
  resolveDisplayNames,
} from "@k2b/cloud/server";
import { isStandaloneServiceAccountKind, type ServiceAccountCredential, serviceAccountCredentials } from "@k2b/cloud/services";
import { err, fail, ok, type PageParams, type Paginated, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import { publishContactChange } from "./live";
import { conflictError, contactsMessages, notFoundError } from "./messages";
import { isUuid } from "./shared";

type DbBookAccess = {
  access_id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
  created_at: Date;
};

export const CONTACTS_APP_ID = "contacts";
export const CONTACT_BOOK_RESOURCE_TYPE = "contact_book";

export type ContactBookApiKey = ServiceAccountCredential & {
  permission: PermissionLevel;
};

/** How far one caller reads across books. */
export const readableBookScope = (caller: {
  actor: RequestActor;
  accessSubject: AccessSubject;
}): Result<{ boundBookId: string | null }> => {
  if (caller.accessSubject.type !== "service_account") return ok({ boundBookId: null });
  if (caller.actor.kind !== "service_account") return fail(err.forbidden("Access denied"));
  const { serviceAccount: account, scopes } = caller.actor;
  if (isStandaloneServiceAccountKind(account.kind)) {
    return account.id === caller.accessSubject.serviceAccountId && hasPermission(permissionFromScopes(scopes), "read")
      ? ok({ boundBookId: null })
      : fail(err.forbidden("Access denied"));
  }
  return account.kind === "resource_bound" &&
    account.appId === CONTACTS_APP_ID &&
    account.resourceType === CONTACT_BOOK_RESOURCE_TYPE &&
    isUuid(account.resourceId ?? "") &&
    hasPermission(permissionFromScopes(scopes), "read")
    ? ok({ boundBookId: account.resourceId })
    : fail(err.forbidden("Access denied"));
};

/**
 * Links one `auth.access` entry to one contact book.
 */
export const addBookAccess = async (bookId: string, accessId: string, locale?: string): Promise<Result<void>> => {
  const t = contactsMessages(locale);
  if (!isUuid(bookId) || !isUuid(accessId)) {
    return fail(notFoundError(t.bookOrAccessEntryNotFound));
  }

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO contacts.book_access (book_id, access_id)
        VALUES (${bookId}::uuid, ${accessId}::uuid)
      `;
      await publishContactChange(tx, { type: "access.changed", bookId });
    });
    return ok();
  } catch (error: unknown) {
    const dbError = error as { code?: string };
    if (dbError.code === "23505") {
      return fail(conflictError(t.bookAccessEntryExists));
    }
    if (dbError.code === "23503") {
      return fail(notFoundError(t.bookOrAccessEntryNotFound));
    }
    throw error;
  }
};

/**
 * Lists all access entries for a contact book with resolved display names.
 */
const listBookAccess = async (bookId: string): Promise<AccessEntry[]> => {
  if (!isUuid(bookId)) return [];

  const rows = await sql<DbBookAccess[]>`
    SELECT
      a.id AS access_id,
      a.user_id,
      a.group_id,
      a.service_account_id,
      a.authenticated_only,
      a.permission,
      a.created_at
    FROM contacts.book_access ba
    JOIN auth.access a ON ba.access_id = a.id
    WHERE ba.book_id = ${bookId}::uuid
    ORDER BY
      CASE
        WHEN a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL AND a.authenticated_only = false THEN 4
        WHEN a.authenticated_only THEN 3
        WHEN a.group_id IS NOT NULL THEN 2
        WHEN a.service_account_id IS NOT NULL THEN 2
        ELSE 1
      END,
      a.created_at
  `;

  const entries: AccessEntry[] = rows.map((row) => ({
    id: row.access_id,
    principal: row.user_id
      ? { type: "user" as const, userId: row.user_id }
      : row.group_id
        ? { type: "group" as const, groupId: row.group_id }
        : row.service_account_id
          ? { type: "service_account" as const, serviceAccountId: row.service_account_id }
          : row.authenticated_only
            ? { type: "authenticated" as const }
            : { type: "public" as const },
    permission: row.permission,
    createdAt: row.created_at.toISOString(),
  }));

  return resolveDisplayNames(entries);
};

/**
 * Paginates and filters access entries for one contact book.
 */
export const listBookAccessPaginated = async (config: {
  bookId: string;
  pagination?: PageParams;
  filter?: {
    query?: string;
    principalType?: AccessEntry["principal"]["type"];
  };
}): Promise<Paginated<AccessEntry>> => {
  const items = await listBookAccess(config.bookId);
  const query = config.filter?.query?.trim().toLowerCase();
  const principalType = config.filter?.principalType;

  const filtered = items.filter((entry) => {
    if (principalType && entry.principal.type !== principalType) return false;
    if (!query) return true;

    const displayName = (entry.displayName ?? "").toLowerCase();
    if (displayName.includes(query)) return true;

    if (entry.principal.type === "user") {
      return entry.principal.userId.toLowerCase().includes(query);
    }
    if (entry.principal.type === "group") {
      return entry.principal.groupId.toLowerCase().includes(query);
    }
    if (entry.principal.type === "service_account") {
      return entry.principal.serviceAccountId.toLowerCase().includes(query);
    }
    if (entry.principal.type === "authenticated") {
      return "all signed-in users authenticated".includes(query);
    }

    return "public".includes(query);
  });

  return paginateItems(filtered, config.pagination);
};

/**
 * Creates a new principal permission and binds it to one book.
 */
export const grantBookAccess = async (config: {
  bookId: string;
  principal: Principal;
  permission: PermissionLevel;
  locale?: string;
}): Promise<Result<AccessEntry>> => {
  const t = contactsMessages(config.locale);
  if (!isUuid(config.bookId)) {
    return fail(notFoundError(t.bookNotFound));
  }

  const existing = await listBookAccess(config.bookId);
  const duplicate = existing.find((entry) => {
    if (config.principal.type === "public" && entry.principal.type === "public") {
      return true;
    }
    if (config.principal.type === "authenticated" && entry.principal.type === "authenticated") {
      return true;
    }
    if (config.principal.type === "user" && entry.principal.type === "user" && config.principal.userId === entry.principal.userId) {
      return true;
    }
    if (config.principal.type === "group" && entry.principal.type === "group" && config.principal.groupId === entry.principal.groupId) {
      return true;
    }
    if (
      config.principal.type === "service_account" &&
      entry.principal.type === "service_account" &&
      config.principal.serviceAccountId === entry.principal.serviceAccountId
    ) {
      return true;
    }
    return false;
  });
  if (duplicate) {
    return fail(conflictError(t.principalAlreadyHasAccess));
  }

  const created = await createAccess({
    principal: config.principal,
    permission: config.permission,
  });
  if (!created.ok) return created;

  const linked = await addBookAccess(config.bookId, created.data.id);
  if (!linked.ok) {
    await deleteAccess({ id: created.data.id });
    return linked;
  }

  const entries = await listBookAccess(config.bookId);
  const createdEntry = entries.find((entry) => entry.id === created.data.id);
  if (!createdEntry) {
    return fail(err.internal("Failed to retrieve created access entry"));
  }

  return ok(createdEntry);
};

/** Reads manager candidates in the transaction holding the book lock. */
const readBookManagerEntries = async (bookId: string, db: SQL) => {
  const rows = await db<(Omit<DbBookAccess, "created_at"> & { service_account_kind: AccessEntry["serviceAccountKind"] | null })[]>`
    SELECT a.id AS access_id, a.user_id, a.group_id, a.service_account_id,
      a.authenticated_only, a.permission, sa.kind AS service_account_kind
    FROM contacts.book_access ba
    JOIN auth.access a ON a.id = ba.access_id
    LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
    WHERE ba.book_id = ${bookId}::uuid
  `;
  return rows.map((row) => ({
    id: row.access_id,
    principal: row.user_id
      ? { type: "user" as const, userId: row.user_id }
      : row.group_id
        ? { type: "group" as const, groupId: row.group_id }
        : row.service_account_id
          ? { type: "service_account" as const, serviceAccountId: row.service_account_id }
          : row.authenticated_only
            ? { type: "authenticated" as const }
            : { type: "public" as const },
    permission: row.permission,
    serviceAccountKind: row.service_account_kind ?? undefined,
  }));
};

/**
 * Locks the book first so authorization and manager checks see preceding grant changes.
 */
export const removeBookAccess = async (config: {
  bookId: string;
  accessId: string;
  actor: RequestActor;
  accessSubject: AccessSubject;
  authority: "grant" | "administration";
  locale?: string;
}): Promise<Result<void>> => {
  const { bookId, accessId, actor, accessSubject, locale } = config;
  if (!isUuid(bookId) || !isUuid(accessId)) {
    return fail(err.notFound("Book or access entry"));
  }

  return sql.begin(async (tx): Promise<Result<void>> => {
    const [book] = await tx`SELECT id FROM contacts.books WHERE id = ${bookId}::uuid FOR UPDATE`;
    if (!book) return fail(err.notFound("Book"));
    const before = await readBookManagerEntries(bookId, tx);
    if (
      config.authority === "administration"
        ? !isContactsAdministrator(actor)
        : (await getActorBookPermission({ bookId, actor, accessSubject }, tx)) !== "admin"
    ) {
      return fail(err.forbidden("Access denied"));
    }
    if (!before.some((entry) => entry.id === accessId)) {
      return fail(err.notFound("Access entry for this book"));
    }
    if (before.length <= 1) {
      return fail(err.badInput("Cannot remove the last access entry"));
    }
    const after = before.filter((entry) => entry.id !== accessId);
    const guarded = ensureManagerRemains({ before, after, locale });
    if (!guarded.ok) return guarded;

    const result = await tx`
      DELETE FROM auth.access
      WHERE id = ${accessId}::uuid
    `;
    if (result.count === 0) {
      return fail(err.notFound("Access entry for this book"));
    }

    await publishContactChange(tx, { type: "access.changed", bookId });
    return ok();
  });
};

/**
 * Locks the book first so authorization and manager checks see preceding grant changes.
 */
export const updateBookAccessPermission = async (config: {
  bookId: string;
  accessId: string;
  permission: PermissionLevel;
  actor: RequestActor;
  accessSubject: AccessSubject;
  authority: "grant" | "administration";
  locale?: string;
}): Promise<Result<void>> => {
  const { bookId, accessId, permission, actor, accessSubject, locale } = config;
  if (!isUuid(bookId) || !isUuid(accessId)) {
    return fail(err.notFound("Book or access entry"));
  }

  return sql.begin(async (tx): Promise<Result<void>> => {
    const [book] = await tx`SELECT id FROM contacts.books WHERE id = ${bookId}::uuid FOR UPDATE`;
    if (!book) return fail(err.notFound("Book"));
    const before = await readBookManagerEntries(bookId, tx);
    if (
      config.authority === "administration"
        ? !isContactsAdministrator(actor)
        : (await getActorBookPermission({ bookId, actor, accessSubject }, tx)) !== "admin"
    ) {
      return fail(err.forbidden("Access denied"));
    }
    if (!before.some((entry) => entry.id === accessId)) {
      return fail(err.notFound("Access entry for this book"));
    }
    const after = before.map((entry) => (entry.id === accessId ? { ...entry, permission } : entry));
    const guarded = ensureManagerRemains({ before, after, locale });
    if (!guarded.ok) return guarded;

    const result = await tx`
      UPDATE auth.access
      SET permission = ${permission}::auth.permission_level
      WHERE id = ${accessId}::uuid
    `;
    if (result.count === 0) {
      return fail(err.notFound("Access entry for this book"));
    }

    await publishContactChange(tx, { type: "access.changed", bookId });
    return ok();
  });
};

/**
 * Counts access entries for one contact book.
 */
export const countBookAccess = async (bookId: string): Promise<number> => {
  if (!isUuid(bookId)) return 0;

  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM contacts.book_access
    WHERE book_id = ${bookId}::uuid
  `;

  return row?.count ?? 0;
};

/**
 * Resolves the effective permission of a user for one manual book.
 */
const getBookPermission = async (config: { bookId: string; subject: AccessSubject }, db: SQL = sql): Promise<PermissionLevel> => {
  if (!isUuid(config.bookId)) return "none";

  const accessRows = await db<{ access_id: string }[]>`
    SELECT access_id
    FROM contacts.book_access
    WHERE book_id = ${config.bookId}::uuid
  `;

  const accessIds = accessRows.map((row) => row.access_id);
  if (accessIds.length === 0) return "none";

  return getEffectivePermission({ accessIds, subject: config.subject }, db);
};

const PERMISSION_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

export const permissionFromScopes = (scopes: readonly string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

export const minPermission = (a: PermissionLevel, b: PermissionLevel): PermissionLevel =>
  PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b;

/**
 * A resource-bound key holds nothing outside its exact Contacts book binding.
 * `null` leaves the decision to the grants.
 */
const fixedBookPermission = (actor: RequestActor, bookId: string): PermissionLevel | null => {
  const account = actor.kind === "service_account" ? actor.serviceAccount : null;
  if (
    account?.kind === "resource_bound" &&
    (account.appId !== CONTACTS_APP_ID || account.resourceType !== CONTACT_BOOK_RESOURCE_TYPE || account.resourceId !== bookId)
  ) {
    return "none";
  }
  return null;
};

/** The administration authority used only by the /admin group. */
export const isContactsAdministrator = (actor: RequestActor): boolean => {
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  return Boolean(user && hasRole(user, "admin"));
};

/** Only a user-delegated credential acts as its user; every other service account is capped by its scopes. */
const capByCredential = (actor: RequestActor, permission: PermissionLevel): PermissionLevel =>
  actor.kind === "service_account" && actor.serviceAccount.kind !== "user_delegated"
    ? minPermission(permission, permissionFromScopes(actor.scopes))
    : permission;

/**
 * Resolves one existing book through the actor's exact resource binding and
 * accessSubject grants, capped by credential scopes for every service account
 * that is not user-delegated. API, capabilities, SSR, and live channels share this decision.
 */
export const getActorBookPermission = async (
  config: {
    bookId: string;
    actor: RequestActor;
    accessSubject: AccessSubject;
  },
  db: SQL = sql,
): Promise<PermissionLevel> =>
  fixedBookPermission(config.actor, config.bookId) ??
  capByCredential(config.actor, await getBookPermission({ bookId: config.bookId, subject: config.accessSubject }, db));

/** `getActorBookPermission` for many actors on one existing book, with one query for all their grants. */
export const getActorsBookPermissions = async (
  bookId: string,
  readers: readonly { actor: RequestActor; accessSubject: AccessSubject }[],
): Promise<PermissionLevel[]> => {
  const fixed = readers.map((reader) => fixedBookPermission(reader.actor, bookId));
  const open = readers.filter((_, position) => fixed[position] === null);
  if (open.length === 0 || !isUuid(bookId)) return fixed.map((permission) => permission ?? "none");
  const accessRows = await sql<{ access_id: string }[]>`
    SELECT access_id FROM contacts.book_access WHERE book_id = ${bookId}::uuid
  `;
  const granted = await getEffectivePermissions({
    accessIds: accessRows.map((row) => row.access_id),
    subjects: open.map((reader) => reader.accessSubject),
  });
  let next = 0;
  return readers.map((reader, position) => fixed[position] ?? capByCredential(reader.actor, granted[next++] ?? "none"));
};

export const listContactBookApiKeys = async (bookId: string): Promise<ContactBookApiKey[]> => {
  const [keys, accessEntries] = await Promise.all([
    serviceAccountCredentials.listOverview({
      pagination: { page: 1, perPage: 500 },
      filter: {
        serviceAccountKind: "resource_bound",
        credentialStatus: "active",
        appId: CONTACTS_APP_ID,
        resourceType: CONTACT_BOOK_RESOURCE_TYPE,
        resourceId: bookId,
      },
    }),
    listBookAccess(bookId),
  ]);

  const permissionByServiceAccountId = new Map(
    accessEntries
      .filter((entry) => entry.principal.type === "service_account")
      .map((entry) => [(entry.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId, entry.permission]),
  );

  return keys.items.map((item) => {
    const permission = permissionByServiceAccountId.get(item.serviceAccount.id) ?? "none";
    const { serviceAccount: _serviceAccount, owner: _owner, ...credential } = item;
    return { ...credential, permission };
  });
};
