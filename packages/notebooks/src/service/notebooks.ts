import type { DateContext } from "@k2b/stdlib";
import type { MutationResult } from "@valentinkolb/cloud/contracts";
import { deleteAccess, hasPermission, type PermissionLevel } from "@valentinkolb/cloud/server";
import { logger, serviceAccounts } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { buildNoteTitleTemplateContext, renderNoteTitleTemplate, validateNoteTitleTemplate } from "../lib/note-title-template";
import { generateUniqueShortId } from "../lib/short-id";
import {
  buildNotebookVisibleAccessCondition,
  getNotebookPermission,
  grantNotebookAccess,
  listNotebookAccess,
  NOTEBOOK_RESOURCE_TYPE,
  NOTEBOOKS_APP_ID,
} from "./access";
import * as activity from "./activity";
import helloMd from "./hello.md" with { type: "text" };
import * as notes from "./notes";
import { invalidated, notebookUpdated } from "./workspace-events";

// ==========================
// Types
// ==========================

export type Notebook = {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  icon: string | null;
  homepageNoteId: string | null;
  homepageNoteShortId: string | null;
  /** Per-notebook opt-in for the JS scripting feature. Default false.
   *  Only notebook admins can flip this; the editor consults this flag
   *  before evaluating any `\`\`\`script` blocks. */
  scriptsEnabled: boolean;
  defaultNoteTitleTemplate: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateNotebook = {
  name: string;
  description?: string;
  icon?: string;
};

export type UpdateNotebook = {
  name?: string;
  description?: string | null;
  icon?: string | null;
  homepageNoteId?: string | null;
  scriptsEnabled?: boolean;
  defaultNoteTitleTemplate?: string;
};

type DbNotebook = {
  id: string;
  short_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  homepage_note_id: string | null;
  homepage_note_short_id: string | null;
  scripts_enabled: boolean;
  default_note_title_template: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbNotebookAdmin = DbNotebook & {
  permission_count: number;
};

const log = logger("notebooks:notebooks");

export type NotebookAdminListItem = Notebook & {
  permissionCount: number;
};

export type NotebookWithPermission = Notebook & {
  permission: Exclude<PermissionLevel, "none">;
};

type DbNotebookWithPermission = DbNotebook & {
  permission_rank: number;
};

// ==========================
// Helpers
// ==========================

/**
 * Converts one `notebooks.notebooks` row into the API-facing `Notebook` model.
 */
const mapToNotebook = (row: DbNotebook): Notebook => ({
  id: row.id,
  shortId: row.short_id,
  name: row.name,
  description: row.description,
  icon: row.icon,
  homepageNoteId: row.homepage_note_id,
  homepageNoteShortId: row.homepage_note_short_id,
  scriptsEnabled: row.scripts_enabled,
  defaultNoteTitleTemplate: row.default_note_title_template,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapToNotebookAdminItem = (row: DbNotebookAdmin): NotebookAdminListItem => ({
  ...mapToNotebook(row),
  permissionCount: row.permission_count,
});

const permissionFromRank = (rank: number): Exclude<PermissionLevel, "none"> => (rank >= 3 ? "admin" : rank >= 2 ? "write" : "read");

const mapToNotebookWithPermission = (row: DbNotebookWithPermission): NotebookWithPermission => ({
  ...mapToNotebook(row),
  permission: permissionFromRank(row.permission_rank),
});

const noteExistsInNotebook = async (noteId: string, notebookId: string): Promise<boolean> => {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM notebooks.notes
      WHERE id = ${noteId}::uuid
        AND notebook_id = ${notebookId}::uuid
    ) AS exists
  `;
  return row?.exists ?? false;
};

const cleanupFailedCreate = async (notebookId: string, accessId?: string): Promise<void> => {
  try {
    await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
    if (accessId) await deleteAccess({ id: accessId });
  } catch (error) {
    log.error("Failed to remove partially created notebook", {
      notebookId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ==========================
// Service
// ==========================

/**
 * Check if an actor has access to a notebook.
 */
export const canAccess = async (params: {
  notebookId: string;
  userId?: string | null;
  serviceAccountId?: string | null;
  requiredLevel?: PermissionLevel;
}): Promise<boolean> => {
  const { notebookId, requiredLevel = "read" } = params;
  const permission = await getNotebookPermission({
    notebookId,
    userId: params.userId ?? null,
    serviceAccountId: params.serviceAccountId ?? null,
  });
  return hasPermission(permission, requiredLevel);
};

/**
 * Get the effective permission level for an actor on a notebook.
 */
export const getPermission = async (params: {
  notebookId: string;
  userId?: string | null;
  serviceAccountId?: string | null;
}): Promise<PermissionLevel> => {
  return getNotebookPermission(params);
};

/**
 * List all notebooks accessible to a user.
 */
export type ListNotebooksParams = {
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  requiredLevel?: PermissionLevel;
  query?: string;
  pagination?: { limit: number; offset: number };
};

export const listWithPermission = async (params: ListNotebooksParams): Promise<{ items: NotebookWithPermission[]; total: number }> => {
  const { userId } = params;
  if (params.serviceAccountId && !params.boundNotebookId) return { items: [], total: 0 };
  const principalMatch = buildNotebookVisibleAccessCondition({ userId, serviceAccountId: params.serviceAccountId });
  const boundNotebookId = params.boundNotebookId ?? null;
  const requiredRank = params.requiredLevel === "admin" ? 3 : params.requiredLevel === "write" ? 2 : 1;
  const query = params.query?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;

  const rows =
    params.pagination === undefined
      ? await sql<DbNotebookWithPermission[]>`
          SELECT
            n.id,
            n.short_id,
            n.name,
            n.description,
            n.icon,
            n.homepage_note_id,
            h.short_id AS homepage_note_short_id,
            n.scripts_enabled,
            n.default_note_title_template,
            n.created_by,
            n.created_at,
            n.updated_at,
            visible.permission_rank
          FROM notebooks.notebooks n
          LEFT JOIN notebooks.notes h ON h.id = n.homepage_note_id
          JOIN LATERAL (
            SELECT MAX(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END)::int AS permission_rank
            FROM notebooks.notebook_access na
            JOIN auth.access a ON a.id = na.access_id
            WHERE na.notebook_id = n.id
              AND ${principalMatch}
          ) visible ON visible.permission_rank >= ${requiredRank}
          WHERE (${boundNotebookId}::text IS NULL OR n.id::text = ${boundNotebookId})
            AND (
              ${pattern}::text IS NULL
              OR LOWER(n.name) LIKE ${pattern}
              OR LOWER(COALESCE(n.description, '')) LIKE ${pattern}
            )
          ORDER BY LOWER(n.name) ASC, n.created_at ASC
        `
      : await sql<DbNotebookWithPermission[]>`
          SELECT
            n.id,
            n.short_id,
            n.name,
            n.description,
            n.icon,
            n.homepage_note_id,
            h.short_id AS homepage_note_short_id,
            n.scripts_enabled,
            n.default_note_title_template,
            n.created_by,
            n.created_at,
            n.updated_at,
            visible.permission_rank
          FROM notebooks.notebooks n
          LEFT JOIN notebooks.notes h ON h.id = n.homepage_note_id
          JOIN LATERAL (
            SELECT MAX(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END)::int AS permission_rank
            FROM notebooks.notebook_access na
            JOIN auth.access a ON a.id = na.access_id
            WHERE na.notebook_id = n.id
              AND ${principalMatch}
          ) visible ON visible.permission_rank >= ${requiredRank}
          WHERE (${boundNotebookId}::text IS NULL OR n.id::text = ${boundNotebookId})
            AND (
              ${pattern}::text IS NULL
              OR LOWER(n.name) LIKE ${pattern}
              OR LOWER(COALESCE(n.description, '')) LIKE ${pattern}
            )
          ORDER BY LOWER(n.name) ASC, n.created_at ASC
          LIMIT ${params.pagination.limit}
          OFFSET ${params.pagination.offset}
        `;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.notebooks n
    JOIN LATERAL (
      SELECT MAX(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END)::int AS permission_rank
      FROM notebooks.notebook_access na
      JOIN auth.access a ON a.id = na.access_id
      WHERE na.notebook_id = n.id
        AND ${principalMatch}
    ) visible ON visible.permission_rank >= ${requiredRank}
    WHERE (${boundNotebookId}::text IS NULL OR n.id::text = ${boundNotebookId})
      AND (
        ${pattern}::text IS NULL
        OR LOWER(n.name) LIKE ${pattern}
        OR LOWER(COALESCE(n.description, '')) LIKE ${pattern}
      )
  `;

  return {
    items: rows.map(mapToNotebookWithPermission),
    total: countRow?.count ?? 0,
  };
};

/** Existing list contract without the capability-only permission projection. */
export const list = async (params: ListNotebooksParams): Promise<{ items: Notebook[]; total: number }> => {
  const result = await listWithPermission(params);
  return {
    items: result.items.map(({ permission: _permission, ...notebook }) => notebook),
    total: result.total,
  };
};

/**
 * List all notebooks for admin pages with a permission-entry count.
 */
export const listAdmin = async (params: {
  search?: string;
  pagination: { limit: number; offset: number };
}): Promise<{ items: NotebookAdminListItem[]; total: number }> => {
  const query = params.search?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;

  const rows = await sql<DbNotebookAdmin[]>`
    SELECT
      n.id,
      n.short_id,
      n.name,
      n.description,
      n.icon,
      n.homepage_note_id,
      h.short_id AS homepage_note_short_id,
      n.scripts_enabled,
      n.default_note_title_template,
      n.created_by,
      n.created_at,
      n.updated_at,
      COUNT(na.access_id)::int AS permission_count
    FROM notebooks.notebooks n
    LEFT JOIN notebooks.notebook_access na ON na.notebook_id = n.id
    LEFT JOIN notebooks.notes h ON h.id = n.homepage_note_id
    WHERE (
      ${pattern}::text IS NULL
      OR LOWER(n.name) LIKE ${pattern}
    )
    GROUP BY n.id, n.short_id, n.name, n.description, n.icon, n.homepage_note_id, h.short_id, n.scripts_enabled,
             n.default_note_title_template, n.created_by, n.created_at, n.updated_at
    ORDER BY LOWER(n.name) ASC, n.created_at ASC
    LIMIT ${params.pagination.limit}
    OFFSET ${params.pagination.offset}
  `;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.notebooks n
    WHERE (
      ${pattern}::text IS NULL
      OR LOWER(n.name) LIKE ${pattern}
    )
  `;

  return {
    items: rows.map(mapToNotebookAdminItem),
    total: countRow?.count ?? 0,
  };
};

/**
 * Aggregated admin stats — single SQL roundtrip. Filtered by `search` so the
 * numbers match what the admin sees in the table. Counted in the DB, NOT in
 * the page-bound items array (which only sees the visible page).
 */
export const adminSummary = async (params: {
  search?: string;
}): Promise<{
  total: number;
  orphaned: number;
  totalPermissions: number;
}> => {
  const query = params.search?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;

  const [row] = await sql<{ total: number; orphaned: number; total_permissions: number }[]>`
    WITH filtered AS (
      SELECT n.id, COUNT(na.access_id)::int AS permission_count
      FROM notebooks.notebooks n
      LEFT JOIN notebooks.notebook_access na ON na.notebook_id = n.id
      WHERE (${pattern}::text IS NULL OR LOWER(n.name) LIKE ${pattern})
      GROUP BY n.id
    )
    SELECT
      COUNT(*)::int                                             AS total,
      COUNT(*) FILTER (WHERE permission_count = 0)::int         AS orphaned,
      COALESCE(SUM(permission_count), 0)::int                   AS total_permissions
    FROM filtered
  `;
  return {
    total: row?.total ?? 0,
    orphaned: row?.orphaned ?? 0,
    totalPermissions: row?.total_permissions ?? 0,
  };
};

/**
 * Get a notebook by ID.
 */
export const get = async (params: { id: string }): Promise<Notebook | null> => {
  const [row] = await sql<DbNotebook[]>`
    SELECT
      n.id,
      n.short_id,
      n.name,
      n.description,
      n.icon,
      n.homepage_note_id,
      h.short_id AS homepage_note_short_id,
      n.scripts_enabled,
      n.default_note_title_template,
      n.created_by,
      n.created_at,
      n.updated_at
    FROM notebooks.notebooks n
    LEFT JOIN notebooks.notes h ON h.id = n.homepage_note_id
    WHERE n.id = ${params.id}::uuid
  `;
  return row ? mapToNotebook(row) : null;
};

/** Resolve the public notebook identity to its internal UUID-backed model. */
export const getByShortId = async (params: { shortId: string }): Promise<Notebook | null> => {
  const [row] = await sql<DbNotebook[]>`
    SELECT
      n.id,
      n.short_id,
      n.name,
      n.description,
      n.icon,
      n.homepage_note_id,
      h.short_id AS homepage_note_short_id,
      n.scripts_enabled,
      n.default_note_title_template,
      n.created_by,
      n.created_at,
      n.updated_at
    FROM notebooks.notebooks n
    LEFT JOIN notebooks.notes h ON h.id = n.homepage_note_id
    WHERE n.short_id = ${params.shortId}
  `;
  return row ? mapToNotebook(row) : null;
};

/**
 * Create a new notebook.
 * Automatically grants admin access to the creator.
 */
export const create = async (params: {
  data: CreateNotebook;
  creatorId: string;
  seedWelcome?: boolean;
}): Promise<MutationResult<Notebook>> => {
  const { data, creatorId } = params;
  const seedWelcome = params.seedWelcome ?? true;

  const shortId = await generateUniqueShortId("notebook");
  const [row] = await sql<DbNotebook[]>`
    INSERT INTO notebooks.notebooks (short_id, name, description, icon, created_by)
    VALUES (${shortId}, ${data.name}, ${data.description ?? null}, ${data.icon ?? null}, ${creatorId}::uuid)
    RETURNING
      id,
      short_id,
      name,
      description,
      icon,
      homepage_note_id,
      NULL::text AS homepage_note_short_id,
      scripts_enabled,
      default_note_title_template,
      created_by,
      created_at,
      updated_at
  `;

  if (!row) {
    return { ok: false, error: "Failed to create notebook", status: 500 };
  }

  const accessResult = await grantNotebookAccess({
    notebookId: row.id,
    principal: { type: "user", userId: creatorId },
    permission: "admin",
  });
  if (!accessResult.ok) {
    await cleanupFailedCreate(row.id);
    return { ok: false, error: accessResult.error.message, status: accessResult.error.status };
  }

  try {
    await activity.record({
      notebookId: row.id,
      actor: { kind: "user", id: creatorId },
      action: "notebook.created",
    });
  } catch (error) {
    await cleanupFailedCreate(row.id, accessResult.data.id);
    throw error;
  }

  if (seedWelcome) {
    const noteResult = await notes.create({
      data: {
        notebookId: row.id,
        contentMd: helloMd,
      },
      creatorId,
    });
    if (!noteResult.ok) {
      await cleanupFailedCreate(row.id, accessResult.data.id);
      return noteResult;
    }
  }

  const notebook = mapToNotebook(row);
  await notebookUpdated(notebook);
  return { ok: true, data: notebook };
};

/**
 * Update a notebook.
 */
export const update = async (params: { id: string; data: UpdateNotebook; dateConfig?: DateContext }): Promise<MutationResult<Notebook>> => {
  const { id, data } = params;

  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Notebook not found", status: 404 };
  }

  const name = data.name ?? existing.name;
  const description = data.description === undefined ? existing.description : data.description;
  const icon = data.icon === undefined ? existing.icon : data.icon;
  const homepageNoteId = data.homepageNoteId === undefined ? existing.homepageNoteId : data.homepageNoteId;
  const scriptsEnabled = data.scriptsEnabled ?? existing.scriptsEnabled;
  const defaultNoteTitleTemplate = data.defaultNoteTitleTemplate ?? existing.defaultNoteTitleTemplate;

  const syntax = validateNoteTitleTemplate(defaultNoteTitleTemplate);
  if (!syntax.ok) return { ok: false, error: syntax.error, status: 400 };
  try {
    renderNoteTitleTemplate(
      defaultNoteTitleTemplate,
      buildNoteTitleTemplateContext({
        notebook: { id: existing.shortId, name },
        note: { id: "preview", depth: 0 },
        dateConfig: params.dateConfig ?? { timeZone: "UTC", locale: "en", firstDayOfWeek: 1 },
      }),
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid default note title template", status: 400 };
  }

  if (homepageNoteId && !(await noteExistsInNotebook(homepageNoteId, id))) {
    return { ok: false, error: "Homepage note not found", status: 404 };
  }

  const [row] = await sql<DbNotebook[]>`
    UPDATE notebooks.notebooks
    SET name = ${name},
        description = ${description},
        icon = ${icon},
        homepage_note_id = ${homepageNoteId}::uuid,
        scripts_enabled = ${scriptsEnabled},
        default_note_title_template = ${defaultNoteTitleTemplate},
        updated_at = now()
    WHERE id = ${id}::uuid
    RETURNING
      id,
      short_id,
      name,
      description,
      icon,
      homepage_note_id,
      NULL::text AS homepage_note_short_id,
      scripts_enabled,
      default_note_title_template,
      created_by,
      created_at,
      updated_at
  `;

  if (!row) {
    return { ok: false, error: "Failed to update notebook", status: 500 };
  }

  const notebook = (await get({ id: row.id })) ?? mapToNotebook(row);
  await notebookUpdated(notebook);
  return { ok: true, data: notebook };
};

/**
 * Delete a notebook.
 */
export const remove = async (params: { id: string }): Promise<MutationResult<void>> => {
  const accessEntries = await listNotebookAccess(params.id);
  const result = await sql`
    DELETE FROM notebooks.notebooks
    WHERE id = ${params.id}::uuid
  `;

  if (result.count === 0) {
    return { ok: false, error: "Notebook not found", status: 404 };
  }

  for (const entry of accessEntries) {
    const deleted = await deleteAccess({ id: entry.id });
    if (!deleted.ok && deleted.error.status !== 404) {
      log.error("Failed to remove notebook access entry", {
        notebookId: params.id,
        accessId: entry.id,
        error: deleted.error.message,
      });
    }
  }

  await serviceAccounts.deleteForResource({
    appId: NOTEBOOKS_APP_ID,
    resourceType: NOTEBOOK_RESOURCE_TYPE,
    resourceId: params.id,
  });

  await invalidated({ notebookId: params.id, reason: "bulk", scopes: ["notebook", "tree", "tags", "references", "permissions"] });
  return { ok: true, data: undefined };
};
