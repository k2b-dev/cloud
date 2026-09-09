import {
  type AccessEntry,
  type AccessSubject,
  createAccess,
  deleteAccess,
  getEffectivePermission,
  hasPermission,
  type PermissionLevel,
  type Principal,
  paginateItems,
  resolveDisplayNames,
} from "@k2b/cloud/server";
import { type ServiceAccountCredential, serviceAccountCredentials } from "@k2b/cloud/services";
import { err, fail, ok, type PageParams, type Paginated, type Result } from "@k2b/stdlib";
import { sql } from "bun";
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

/**
 * Links one `auth.access` entry to one contact book.
 */
export const addBookAccess = async (bookId: string, accessId: string, locale?: string): Promise<Result<void>> => {
  const t = contactsMessages(locale);
  if (!isUuid(bookId) || !isUuid(accessId)) {
    return fail(notFoundError(t.bookOrAccessEntryNotFound));
  }

  try {
    await sql`
      INSERT INTO contacts.book_access (book_id, access_id)
      VALUES (${bookId}::uuid, ${accessId}::uuid)
    `;
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

/**
 * Removes one access entry from a contact book after relation validation.
 */
export const removeBookAccess = async (bookId: string, accessId: string): Promise<Result<void>> => {
  if (!isUuid(bookId) || !isUuid(accessId)) {
    return fail(err.notFound("Book or access entry"));
  }

  return sql.begin(async (tx) => {
    const [guard] = await tx<
      {
        total: number;
        other_admins: number;
        current_permission: PermissionLevel | null;
      }[]
    >`
      WITH locked AS (
        SELECT a.id, a.permission
        FROM contacts.book_access ba
        JOIN auth.access a ON ba.access_id = a.id
        WHERE ba.book_id = ${bookId}::uuid
        FOR UPDATE OF ba, a
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE permission = 'admin'::auth.permission_level
            AND id <> ${accessId}::uuid
        )::int AS other_admins,
        MAX(CASE WHEN id = ${accessId}::uuid THEN permission END) AS current_permission
      FROM locked
    `;

    if (!guard?.current_permission) {
      return fail(err.notFound("Access entry for this book"));
    }
    if (guard.total <= 1) {
      return fail(err.badInput("Cannot remove the last access entry"));
    }
    if (guard.current_permission === "admin" && guard.other_admins <= 0) {
      return fail(err.badInput("Cannot remove the last admin"));
    }

    const result = await tx`
      DELETE FROM auth.access
      WHERE id = ${accessId}::uuid
    `;
    if (result.count === 0) {
      return fail(err.notFound("Access entry for this book"));
    }

    return ok();
  });
};

/**
 * Updates one access entry permission while holding the book ACL rows locked.
 */
export const updateBookAccessPermission = async (config: {
  bookId: string;
  accessId: string;
  permission: PermissionLevel;
}): Promise<Result<void>> => {
  if (!isUuid(config.bookId) || !isUuid(config.accessId)) {
    return fail(err.notFound("Book or access entry"));
  }

  return sql.begin(async (tx) => {
    const [guard] = await tx<
      {
        other_admins: number;
        current_permission: PermissionLevel | null;
      }[]
    >`
      WITH locked AS (
        SELECT a.id, a.permission
        FROM contacts.book_access ba
        JOIN auth.access a ON ba.access_id = a.id
        WHERE ba.book_id = ${config.bookId}::uuid
        FOR UPDATE OF ba, a
      )
      SELECT
        COUNT(*) FILTER (
          WHERE permission = 'admin'::auth.permission_level
            AND id <> ${config.accessId}::uuid
        )::int AS other_admins,
        MAX(CASE WHEN id = ${config.accessId}::uuid THEN permission END) AS current_permission
      FROM locked
    `;

    if (!guard?.current_permission) {
      return fail(err.notFound("Access entry for this book"));
    }
    if (guard.current_permission === "admin" && config.permission !== "admin" && guard.other_admins <= 0) {
      return fail(err.badInput("Cannot remove the last admin"));
    }

    const result = await tx`
      UPDATE auth.access
      SET permission = ${config.permission}::auth.permission_level
      WHERE id = ${config.accessId}::uuid
    `;
    if (result.count === 0) {
      return fail(err.notFound("Access entry for this book"));
    }

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
 * Returns guard values for safe ACL update/removal operations.
 */
export const getBookAccessGuard = async (config: {
  bookId: string;
  accessId: string;
}): Promise<{
  total: number;
  otherAdmins: number;
  currentPermission: PermissionLevel | null;
}> => {
  if (!isUuid(config.bookId) || !isUuid(config.accessId)) {
    return { total: 0, otherAdmins: 0, currentPermission: null };
  }

  const [row] = await sql<
    {
      total: number;
      other_admins: number;
      current_permission: PermissionLevel | null;
    }[]
  >`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE a.permission = 'admin'::auth.permission_level
          AND a.id <> ${config.accessId}::uuid
      )::int AS other_admins,
      MAX(CASE WHEN a.id = ${config.accessId}::uuid THEN a.permission END) AS current_permission
    FROM contacts.book_access ba
    JOIN auth.access a ON ba.access_id = a.id
    WHERE ba.book_id = ${config.bookId}::uuid
  `;

  return {
    total: row?.total ?? 0,
    otherAdmins: row?.other_admins ?? 0,
    currentPermission: row?.current_permission ?? null,
  };
};

/**
 * Resolves the effective permission of a user for one manual book.
 */
export const getBookPermission = async (config: { bookId: string; subject: AccessSubject }): Promise<PermissionLevel> => {
  if (!isUuid(config.bookId)) return "none";

  const accessRows = await sql<{ access_id: string }[]>`
    SELECT access_id
    FROM contacts.book_access
    WHERE book_id = ${config.bookId}::uuid
  `;

  const accessIds = accessRows.map((row) => row.access_id);
  if (accessIds.length === 0) return "none";

  return getEffectivePermission({
    accessIds,
    subject: config.subject,
  });
};

/**
 * Checks whether the user satisfies the required permission for one manual book.
 */
export const canAccessBook = async (config: {
  bookId: string;
  subject: AccessSubject;
  requiredLevel?: PermissionLevel;
}): Promise<boolean> => {
  const permission = await getBookPermission({
    bookId: config.bookId,
    subject: config.subject,
  });

  return hasPermission(permission, config.requiredLevel ?? "read");
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
