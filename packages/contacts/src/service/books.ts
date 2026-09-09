import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { type AccessSubject, buildAccessPrincipalCondition, type PermissionLevel } from "@k2b/cloud/server";
import { serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { withShortId } from "../lib/short-id";
import {
  addBookAccess,
  CONTACT_BOOK_RESOURCE_TYPE,
  CONTACTS_APP_ID,
  canAccessBook,
  countBookAccess,
  getBookAccessGuard,
  getBookPermission,
  grantBookAccess,
  listBookAccessPaginated,
  listContactBookApiKeys,
  removeBookAccess,
  updateBookAccessPermission,
} from "./access";
import { isUuid } from "./shared";
import type { ContactBook, ContactBookAdminListItem, CreateBookInput, UpdateBookInput } from "./types";

type DbBook = {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbAdminBook = DbBook & {
  permission_count: number;
  contact_count: number;
};

type DbReadableBook = DbBook & {
  permission_rank: number;
};

type ReadableContactBook = ContactBook & {
  permission: PermissionLevel;
};

/**
 * Maps one manual book row into the public service model.
 */
const mapBook = (row: DbBook): ContactBook => ({
  id: row.id,
  name: row.name,
  description: row.description,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapAdminBook = (row: DbAdminBook): ContactBookAdminListItem => ({
  ...mapBook(row),
  permissionCount: row.permission_count,
  contactCount: row.contact_count,
});

/**
 * Lists manual books readable by one authoritative access subject.
 * Resource service accounts fail closed unless their exact book binding is supplied.
 */
export const list = async (config: { subject: AccessSubject; boundBookId?: string | null }): Promise<ContactBook[]> => {
  if (config.subject.type === "service_account" && !isUuid(config.boundBookId ?? "")) return [];

  const principalMatch = buildAccessPrincipalCondition({
    subject: config.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const bindingMatch = config.subject.type === "service_account" ? sql`b.id = ${config.boundBookId}::uuid` : sql`true`;

  const rows = await sql<DbBook[]>`
    SELECT DISTINCT b.id, b.name, b.description, b.created_at, b.updated_at
    FROM contacts.books b
    JOIN contacts.book_access ba ON ba.book_id = b.id
    JOIN auth.access a ON a.id = ba.access_id
    WHERE
      a.permission IN ('read'::auth.permission_level, 'write'::auth.permission_level, 'admin'::auth.permission_level)
      AND ${principalMatch}
      AND ${bindingMatch}
    ORDER BY b.name ASC
  `;

  return rows.map(mapBook);
};

/**
 * Lists readable manual books with database-side filtering and pagination.
 * The effective permission is computed in the same query so capability
 * callers do not need one permission lookup per row.
 */
export const listPage = async (config: {
  subject: AccessSubject;
  boundBookId?: string | null;
  pagination?: PageParams;
  filter?: { query?: string; minimumPermission?: PermissionLevel };
}): Promise<Paginated<ReadableContactBook>> => {
  const { page, perPage, offset } = paginate(config.pagination);
  if (config.subject.type === "service_account" && !isUuid(config.boundBookId ?? "")) {
    return { items: [], page, perPage, total: 0, hasNext: false };
  }

  const principalMatch = buildAccessPrincipalCondition({
    subject: config.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const bindingMatch = config.subject.type === "service_account" ? sql`b.id = ${config.boundBookId}::uuid` : sql`true`;
  const query = config.filter?.query?.trim().toLowerCase() ?? "";
  const queryMatch =
    query.length > 0
      ? sql`(
          POSITION(${query} IN LOWER(b.name)) > 0
          OR POSITION(${query} IN LOWER(COALESCE(b.description, ''))) > 0
        )`
      : sql`true`;
  const permissionMatch =
    config.filter?.minimumPermission === "admin"
      ? sql`a.permission = 'admin'::auth.permission_level`
      : config.filter?.minimumPermission === "write"
        ? sql`a.permission IN ('write'::auth.permission_level, 'admin'::auth.permission_level)`
        : sql`a.permission IN ('read'::auth.permission_level, 'write'::auth.permission_level, 'admin'::auth.permission_level)`;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT b.id)::int AS count
    FROM contacts.books b
    JOIN contacts.book_access ba ON ba.book_id = b.id
    JOIN auth.access a ON a.id = ba.access_id
    WHERE ${principalMatch}
      AND ${bindingMatch}
      AND ${queryMatch}
      AND ${permissionMatch}
  `;

  const rows = await sql<DbReadableBook[]>`
    SELECT
      b.id,
      b.name,
      b.description,
      b.created_at,
      b.updated_at,
      MAX(CASE a.permission
        WHEN 'admin'::auth.permission_level THEN 3
        WHEN 'write'::auth.permission_level THEN 2
        WHEN 'read'::auth.permission_level THEN 1
        ELSE 0
      END)::int AS permission_rank
    FROM contacts.books b
    JOIN contacts.book_access ba ON ba.book_id = b.id
    JOIN auth.access a ON a.id = ba.access_id
    WHERE ${principalMatch}
      AND ${bindingMatch}
      AND ${queryMatch}
      AND ${permissionMatch}
    GROUP BY b.id, b.name, b.description, b.created_at, b.updated_at
    ORDER BY LOWER(b.name) ASC, b.id ASC
    LIMIT ${perPage}
    OFFSET ${offset}
  `;

  const total = countRow?.count ?? 0;
  return {
    items: rows.map((row) => ({
      ...mapBook(row),
      permission: row.permission_rank >= 3 ? "admin" : row.permission_rank >= 2 ? "write" : "read",
    })),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

/**
 * Lists all manual books for admin pages with permission and contact counts.
 */
export const listAdmin = async (params: {
  search?: string;
  pagination: { limit: number; offset: number };
}): Promise<{ items: ContactBookAdminListItem[]; total: number }> => {
  const query = params.search?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;

  const rows = await sql<DbAdminBook[]>`
    SELECT
      b.id,
      b.name,
      b.description,
      b.created_at,
      b.updated_at,
      COUNT(DISTINCT ba.access_id)::int AS permission_count,
      COUNT(DISTINCT c.id)::int AS contact_count
    FROM contacts.books b
    LEFT JOIN contacts.book_access ba ON ba.book_id = b.id
    LEFT JOIN contacts.contacts c ON c.book_id = b.id
    WHERE (
      ${pattern}::text IS NULL
      OR LOWER(b.name) LIKE ${pattern}
      OR LOWER(COALESCE(b.description, '')) LIKE ${pattern}
    )
    GROUP BY b.id, b.name, b.description, b.created_at, b.updated_at
    ORDER BY LOWER(b.name) ASC, b.created_at ASC
    LIMIT ${params.pagination.limit}
    OFFSET ${params.pagination.offset}
  `;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM contacts.books b
    WHERE (
      ${pattern}::text IS NULL
      OR LOWER(b.name) LIKE ${pattern}
      OR LOWER(COALESCE(b.description, '')) LIKE ${pattern}
    )
  `;

  return {
    items: rows.map(mapAdminBook),
    total: countRow?.count ?? 0,
  };
};

/**
 * Aggregated admin stats for manual contact books.
 */
export const adminSummary = async (params: {
  search?: string;
}): Promise<{
  total: number;
  orphaned: number;
  totalPermissions: number;
  totalContacts: number;
}> => {
  const query = params.search?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;

  const [row] = await sql<{ total: number; orphaned: number; total_permissions: number; total_contacts: number }[]>`
    WITH filtered AS (
      SELECT
        b.id,
        COUNT(DISTINCT ba.access_id)::int AS permission_count,
        COUNT(DISTINCT c.id)::int AS contact_count
      FROM contacts.books b
      LEFT JOIN contacts.book_access ba ON ba.book_id = b.id
      LEFT JOIN contacts.contacts c ON c.book_id = b.id
      WHERE (
        ${pattern}::text IS NULL
        OR LOWER(b.name) LIKE ${pattern}
        OR LOWER(COALESCE(b.description, '')) LIKE ${pattern}
      )
      GROUP BY b.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE permission_count = 0)::int AS orphaned,
      COALESCE(SUM(permission_count), 0)::int AS total_permissions,
      COALESCE(SUM(contact_count), 0)::int AS total_contacts
    FROM filtered
  `;

  return {
    total: row?.total ?? 0,
    orphaned: row?.orphaned ?? 0,
    totalPermissions: row?.total_permissions ?? 0,
    totalContacts: row?.total_contacts ?? 0,
  };
};

/**
 * Loads one manual book by ID.
 */
export const get = async (config: { id: string }): Promise<ContactBook | null> => {
  if (!isUuid(config.id)) return null;

  const [row] = await sql<DbBook[]>`
    SELECT id, name, description, created_at, updated_at
    FROM contacts.books
    WHERE id = ${config.id}::uuid
  `;

  return row ? mapBook(row) : null;
};

/**
 * Creates a manual book and grants admin access to the creator.
 */
export const create = async (config: { data: CreateBookInput; creatorId: string }): Promise<Result<ContactBook>> => {
  const row = await withShortId("book", async (shortId) => {
    const [created] = await sql<DbBook[]>`
      INSERT INTO contacts.books (short_id, name, description)
      VALUES (${shortId}, ${config.data.name}, ${config.data.description ?? null})
      RETURNING id, name, description, created_at, updated_at
    `;
    return created;
  });

  if (!row) return fail(err.internal("Failed to create book"));

  const accessResult = await grantBookAccess({
    bookId: row.id,
    principal: { type: "user", userId: config.creatorId },
    permission: "admin",
  });

  if (!accessResult.ok) {
    await sql`
      DELETE FROM contacts.books
      WHERE id = ${row.id}::uuid
    `;
    return fail(accessResult.error);
  }
  return ok(mapBook(row));
};

/**
 * Updates mutable metadata of one manual book.
 */
export const update = async (config: { id: string; data: UpdateBookInput }): Promise<Result<ContactBook>> => {
  if (!isUuid(config.id)) return fail(err.notFound("Book"));

  const existing = await get({ id: config.id });
  if (!existing) return fail(err.notFound("Book"));

  const name = config.data.name ?? existing.name;
  const description = config.data.description === undefined ? existing.description : config.data.description;

  const [row] = await sql<DbBook[]>`
    UPDATE contacts.books
    SET
      name = ${name},
      description = ${description},
      updated_at = now()
    WHERE id = ${config.id}::uuid
    RETURNING id, name, description, created_at, updated_at
  `;

  if (!row) return fail(err.internal("Failed to update book"));
  return ok(mapBook(row));
};

/**
 * Deletes one manual book and all linked contacts/access junction rows.
 */
export const remove = async (config: { id: string }): Promise<Result<void>> => {
  if (!isUuid(config.id)) return fail(err.notFound("Book"));

  const result = await sql.begin(async (tx) => {
    await tx`DELETE FROM contacts.contact_favorites WHERE book_id = ${config.id}`;
    return tx`
      DELETE FROM contacts.books
      WHERE id = ${config.id}::uuid
    `;
  });

  if (result.count === 0) return fail(err.notFound("Book"));
  await serviceAccounts.deleteForResource({
    appId: CONTACTS_APP_ID,
    resourceType: CONTACT_BOOK_RESOURCE_TYPE,
    resourceId: config.id,
  });
  return ok();
};

/**
 * Returns effective permission for one manual book.
 */
export const getPermission = async (config: { bookId: string; subject: AccessSubject }): Promise<PermissionLevel> =>
  getBookPermission({
    bookId: config.bookId,
    subject: config.subject,
  });

/**
 * Checks whether user/groups can access one manual book for the requested level.
 */
export const canAccess = async (config: { bookId: string; subject: AccessSubject; requiredLevel?: PermissionLevel }): Promise<boolean> =>
  canAccessBook({
    bookId: config.bookId,
    subject: config.subject,
    requiredLevel: config.requiredLevel,
  });

/**
 * Access helpers scoped to manual contact books.
 */
export const access = {
  list: listBookAccessPaginated,
  grant: grantBookAccess,
  update: updateBookAccessPermission,
  remove: (config: { bookId: string; accessId: string }) => removeBookAccess(config.bookId, config.accessId),
  add: (config: { bookId: string; accessId: string }) => addBookAccess(config.bookId, config.accessId),
  count: (config: { bookId: string }) => countBookAccess(config.bookId),
  guard: getBookAccessGuard,
  apiKeys: {
    list: (config: { bookId: string }) => listContactBookApiKeys(config.bookId),
  },
};
