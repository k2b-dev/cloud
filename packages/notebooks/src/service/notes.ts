import { type DateContext, dates, fromBase64Strict } from "@k2b/stdlib";
import type { RetentionGapError } from "@k2b/sync";
import type { MutationResult, PaginationParams } from "@valentinkolb/cloud/contracts";
import { logger, get as settingsGet, toPgTextArray, toPgUuidArray, trace } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import * as Y from "yjs";
import {
  applyNoteEdits,
  NoteEditError,
  type NoteEditOperation,
  type NoteEditPreconditions,
  type NoteEditResult,
  noteContentHash,
  summarizeNoteEditBlocks,
} from "../lib/note-edit";
import { createInitialNoteMarkdown, deriveNoteTitle, hasUsableNoteTitle } from "../lib/note-title";
import { buildNoteTitleTemplateContext, renderNoteTitleTemplate } from "../lib/note-title-template";
import { generateUniqueShortId } from "../lib/short-id";
import { buildNotebookVisibleAccessCondition } from "./access";
import * as activity from "./activity";
import { dataPropertiesForContent } from "./note-properties";
import { reindexNoteRefsSafe } from "./note-refs";
import { noteCreated, noteDeleted, noteUpdated } from "./workspace-events";
import { compareStreamCursor, createYjsTopic, NODE_ID, replayYjsTopicToCursor, toBase64 } from "./yjs-sync";

// ==========================
// Types
// ==========================

export type Note = {
  id: string;
  shortId: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  position: number;
  hasChildren: boolean;
  yjsSnapshotAt: string | null;
  contentMd: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

export type NoteWithContent = Note & {
  /** Yjs snapshot as base64 (null if no content yet) */
  yjsSnapshot: string | null;
};

export type NoteTreeNode = Note & {
  children: NoteTreeNode[];
};

export type NoteTreeEntry = Pick<Note, "id" | "shortId" | "parentId" | "title" | "position" | "hasChildren">;

export type CreateNote = {
  notebookId: string;
  parentId?: string;
  position?: number;
  contentMd?: string;
};

export type UpdateNote = {
  parentId?: string | null;
  position?: number;
};

export type NoteVersion = {
  id: string;
  noteId: string;
  createdBy: string | null;
  createdAt: string;
  contributors: Array<{
    kind: "user" | "service_account";
    id: string;
    displayName: string;
    avatarHash: string | null;
  }>;
};

export type NoteVersionContributorInput = {
  kind: "user" | "service_account";
  id: string;
  lastContributedAt: Date;
};

export type EditNoteContent = {
  operations: NoteEditOperation[];
  ifUpdatedAt?: string;
  ifContentHash?: string;
  ifBlockHash?: string;
};

export type EditNoteContentResult = NoteEditResult & {
  note: Note;
};

type DbNote = {
  id: string;
  short_id: string;
  notebook_id: string;
  parent_id: string | null;
  title: string;
  position: number;
  yjs_snapshot: Buffer | null;
  yjs_stream_cursor?: string | null;
  yjs_snapshot_at: Date | null;
  content_md: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  has_children?: boolean;
  locked_at: Date | null;
};

type DbYjsState = {
  yjs_restore_revision: string;
  yjs_snapshot: Buffer | null;
  yjs_stream_cursor: string | null;
  content_md: string | null;
};

type DbNoteVersion = {
  id: string;
  note_id: string;
  created_by: string | null;
  created_at: Date;
  contributors:
    | Array<{
        kind: "user" | "service_account";
        id: string;
        displayName: string;
        avatarHash: string | null;
      }>
    | string;
};

type DbNotebookTitleTemplate = {
  id: string;
  short_id: string;
  name: string;
  default_note_title_template: string;
};

type DbParentTitleContext = {
  id: string;
  short_id: string;
  title: string;
  depth: number;
};

const VERSION_MIN_INTERVAL = "5 minutes";
const log = logger("notebooks:notes");

// ==========================
// Helpers
// ==========================

/**
 * Converts one note row into the base note DTO used by list/get endpoints.
 */
const mapToNote = (row: DbNote): Note => ({
  id: row.id,
  shortId: row.short_id,
  notebookId: row.notebook_id,
  parentId: row.parent_id,
  title: row.title,
  position: row.position,
  hasChildren: row.has_children ?? false,
  yjsSnapshotAt: row.yjs_snapshot_at?.toISOString() ?? null,
  contentMd: row.content_md ?? null,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lockedAt: row.locked_at?.toISOString() ?? null,
});

/**
 * Extends `mapToNote` by serializing the optional Yjs snapshot buffer as base64.
 */
const mapToNoteWithContent = (row: DbNote): NoteWithContent => ({
  ...mapToNote(row),
  yjsSnapshot: row.yjs_snapshot ? row.yjs_snapshot.toString("base64") : null,
});

const parentExistsInNotebook = async (parentId: string, notebookId: string): Promise<boolean> => {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1
      FROM notebooks.notes
      WHERE id = ${parentId}::uuid
        AND notebook_id = ${notebookId}::uuid
    ) AS exists
  `;
  return row?.exists ?? false;
};

const cleanupFailedCreate = async (noteId: string): Promise<void> => {
  try {
    await sql`DELETE FROM notebooks.notes WHERE id = ${noteId}::uuid`;
  } catch (error) {
    log.error("Failed to remove partially created note", {
      noteId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Converts one version row into the lightweight note-version DTO for history views.
 */
const mapToNoteVersion = (row: DbNoteVersion): NoteVersion => ({
  id: row.id,
  noteId: row.note_id,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  contributors: typeof row.contributors === "string" ? JSON.parse(row.contributors) : row.contributors,
});

const defaultDateConfig = async (): Promise<DateContext> => {
  const [timeZone, locale] = await Promise.all([settingsGet<string>("app.timezone"), settingsGet<string>("app.locale")]);
  return {
    timeZone: dates.normalizeTimeZone(String(timeZone || "").trim(), "UTC"),
    locale: String(locale || "").trim() || "en",
    firstDayOfWeek: 1,
  };
};

const initialContentForNote = async (params: {
  notebookId: string;
  parentId?: string;
  noteShortId: string;
  contentMd?: string;
  dateConfig?: DateContext;
}): Promise<string> => {
  if (hasUsableNoteTitle(params.contentMd)) return params.contentMd!;

  const [notebook] = await sql<DbNotebookTitleTemplate[]>`
    SELECT id, short_id, name, default_note_title_template
    FROM notebooks.notebooks
    WHERE id = ${params.notebookId}::uuid
  `;
  if (!notebook) throw new Error("Notebook not found");

  const ancestors = params.parentId
    ? await sql<DbParentTitleContext[]>`
        WITH RECURSIVE chain AS (
          SELECT id, short_id, parent_id, title, 0 AS depth
          FROM notebooks.notes
          WHERE id = ${params.parentId}::uuid
            AND notebook_id = ${params.notebookId}::uuid
          UNION ALL
          SELECT parent.id, parent.short_id, parent.parent_id, parent.title, chain.depth + 1
          FROM notebooks.notes parent
          INNER JOIN chain ON parent.id = chain.parent_id
        )
        SELECT id, short_id, title, depth
        FROM chain
        ORDER BY depth ASC
      `
    : [];
  const parent = ancestors[0];
  const context = buildNoteTitleTemplateContext({
    notebook: { id: notebook.short_id, name: notebook.name },
    note: { id: params.noteShortId, depth: ancestors.length },
    parent: parent
      ? {
          exists: true,
          id: parent.short_id,
          title: parent.title,
          path: [...ancestors]
            .reverse()
            .map((ancestor) => ancestor.title)
            .join(" / "),
        }
      : undefined,
    dateConfig: params.dateConfig ?? (await defaultDateConfig()),
  });
  return createInitialNoteMarkdown(renderNoteTitleTemplate(notebook.default_note_title_template, context), params.contentMd);
};

const compareTreeNodes = (left: NoteTreeNode, right: NoteTreeNode): number => {
  const leftTitle = left.title.trim().toLocaleLowerCase();
  const rightTitle = right.title.trim().toLocaleLowerCase();
  if (leftTitle !== rightTitle) return leftTitle.localeCompare(rightTitle);
  return left.id.localeCompare(right.id);
};

const sortTreeNodes = (nodes: NoteTreeNode[]): void => {
  nodes.sort(compareTreeNodes);
  for (const node of nodes) {
    if (node.children.length > 0) sortTreeNodes(node.children);
  }
};

const NOTE_TEXT_NAME = "codemirror";

const createDocFromState = (state: Uint8Array | null, fallbackContent: string | null | undefined): Y.Doc => {
  const doc = new Y.Doc({ gc: true });
  if (state) {
    Y.applyUpdate(doc, state, "snapshot");
    return doc;
  }
  const content = fallbackContent ?? "";
  if (content.length > 0) doc.getText(NOTE_TEXT_NAME).insert(0, content);
  return doc;
};

// ==========================
// Lock Helpers
// ==========================

/**
 * Check if a note is locked.
 */
export const isLocked = async (params: { id: string }): Promise<boolean> => {
  const [row] = await sql<{ locked_at: Date | null }[]>`
    SELECT locked_at FROM notebooks.notes WHERE id = ${params.id}::uuid
  `;
  return row != null && row.locked_at !== null;
};

/**
 * Lock a note permanently. Once locked, the note cannot be edited or restored.
 */
export const lock = async (params: { id: string }): Promise<MutationResult<Note>> => {
  const { id } = params;

  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Note not found", status: 404 };
  }

  if (existing.lockedAt) {
    return { ok: false, error: "Note is already locked", status: 400 };
  }

  const [row] = await sql<DbNote[]>`
    UPDATE notebooks.notes
    SET locked_at = now(), updated_at = now()
    WHERE id = ${id}::uuid
      AND locked_at IS NULL
    RETURNING id, short_id, notebook_id, parent_id, title, position,
              yjs_snapshot_at, content_md, created_by, created_at, updated_at, locked_at
  `;

  if (!row) {
    const current = await get({ id });
    if (!current) return { ok: false, error: "Note not found", status: 404 };
    if (current.lockedAt) return { ok: false, error: "Note is already locked", status: 400 };
    return { ok: false, error: "Failed to lock note", status: 500 };
  }

  const note = mapToNote({ ...row, has_children: existing.hasChildren });
  await noteUpdated(note);
  return {
    ok: true,
    data: note,
  };
};

// ==========================
// Service
// ==========================

/**
 * Recent notes accessible to a user, joined with their parent notebook's
 * icon. Used by the dashboard widget. Limited to a small N — a peek, not
 * a full list. Same access semantics as `notebooks.list`.
 */
export type RecentNote = {
  id: string;
  shortId: string;
  notebookId: string;
  notebookShortId: string;
  title: string;
  updatedAt: string;
  notebookIcon: string | null;
  notebookName: string;
};

export const recentForUser = async (params: { userId: string; limit: number }): Promise<RecentNote[]> => {
  const principalMatch = buildNotebookVisibleAccessCondition({ userId: params.userId });
  const rows = await sql<
    {
      id: string;
      short_id: string;
      notebook_id: string;
      notebook_short_id: string;
      title: string;
      updated_at: string;
      notebook_icon: string | null;
      notebook_name: string;
    }[]
  >`
    SELECT
      nt.id, nt.short_id, nt.notebook_id, nt.title, nt.updated_at,
      nb.short_id AS notebook_short_id, nb.icon AS notebook_icon, nb.name AS notebook_name
    FROM notebooks.notes nt
    JOIN notebooks.notebooks nb ON nb.id = nt.notebook_id
    WHERE EXISTS (
      SELECT 1
      FROM notebooks.notebook_access na
      JOIN auth.access a ON a.id = na.access_id
      WHERE na.notebook_id = nt.notebook_id
        AND ${principalMatch}
    )
    ORDER BY nt.updated_at DESC
    LIMIT ${params.limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    shortId: r.short_id,
    notebookId: r.notebook_id,
    notebookShortId: r.notebook_short_id,
    title: r.title,
    updatedAt: r.updated_at,
    notebookIcon: r.notebook_icon,
    notebookName: r.notebook_name,
  }));
};

/**
 * List all notes in a notebook (flat list with hasChildren flag).
 */
export const list = async (params: { notebookId: string }): Promise<Note[]> => {
  const rows = await sql<DbNote[]>`
    SELECT
      n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
      n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
      EXISTS(SELECT 1 FROM notebooks.notes c WHERE c.parent_id = n.id) as has_children
    FROM notebooks.notes n
    WHERE n.notebook_id = ${params.notebookId}::uuid
    ORDER BY n.parent_id NULLS FIRST, n.position, n.title
  `;

  return rows.map(mapToNote);
};

/**
 * List notes with SQL-side filtering and pagination.
 */
export const listPaged = async (params: {
  notebookId: string;
  query?: string;
  parentId?: string | null;
  pagination?: { limit: number; offset: number };
}): Promise<{ items: Note[]; total: number }> => {
  const query = params.query?.trim();
  const pattern = query && query.length > 0 ? `%${query}%` : null;
  const parentId = params.parentId;
  const parentCondition =
    parentId === undefined ? sql`true` : parentId === null ? sql`n.parent_id IS NULL` : sql`n.parent_id = ${parentId}::uuid`;

  const rows =
    params.pagination === undefined
      ? await sql<DbNote[]>`
          SELECT
            n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
            n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
            EXISTS(SELECT 1 FROM notebooks.notes c WHERE c.parent_id = n.id) as has_children
          FROM notebooks.notes n
          WHERE n.notebook_id = ${params.notebookId}::uuid
            AND ${parentCondition}
            AND (
              ${pattern}::text IS NULL
              OR n.title ILIKE ${pattern}
              OR COALESCE(n.content_md, '') ILIKE ${pattern}
            )
          ORDER BY
            CASE WHEN ${pattern}::text IS NULL THEN 0 WHEN n.title ILIKE ${pattern} THEN 0 ELSE 1 END,
            n.position ASC,
            n.updated_at DESC
        `
      : await sql<DbNote[]>`
          SELECT
            n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
            n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
            EXISTS(SELECT 1 FROM notebooks.notes c WHERE c.parent_id = n.id) as has_children
          FROM notebooks.notes n
          WHERE n.notebook_id = ${params.notebookId}::uuid
            AND ${parentCondition}
            AND (
              ${pattern}::text IS NULL
              OR n.title ILIKE ${pattern}
              OR COALESCE(n.content_md, '') ILIKE ${pattern}
            )
          ORDER BY
            CASE WHEN ${pattern}::text IS NULL THEN 0 WHEN n.title ILIKE ${pattern} THEN 0 ELSE 1 END,
            n.position ASC,
            n.updated_at DESC
          LIMIT ${params.pagination.limit}
          OFFSET ${params.pagination.offset}
        `;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.notes n
    WHERE n.notebook_id = ${params.notebookId}::uuid
      AND ${parentCondition}
      AND (
        ${pattern}::text IS NULL
        OR n.title ILIKE ${pattern}
        OR COALESCE(n.content_md, '') ILIKE ${pattern}
      )
  `;

  return {
    items: rows.map(mapToNote),
    total: countRow?.count ?? 0,
  };
};

/**
 * Build the complete note tree for a notebook.
 */
export const getTree = async (params: { notebookId: string }): Promise<NoteTreeNode[]> => {
  const notes = await list(params);

  const nodeMap = new Map<string, NoteTreeNode>();
  const roots: NoteTreeNode[] = [];

  // Create nodes
  for (const note of notes) {
    nodeMap.set(note.id, { ...note, children: [] });
  }

  // Build tree
  for (const note of notes) {
    const node = nodeMap.get(note.id)!;
    if (note.parentId && nodeMap.has(note.parentId)) {
      nodeMap.get(note.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sortTreeNodes(roots);

  return roots;
};

/**
 * Read a stable, lightweight page of the note adjacency index. Unlike
 * `getTree`, this never loads Markdown or constructs recursive objects.
 */
export const listTreePage = async (params: {
  notebookId: string;
  afterId?: string;
  limit: number;
  parentId?: string | null;
}): Promise<NoteTreeEntry[]> => {
  const afterId = params.afterId ?? null;
  const rows = await sql<
    {
      id: string;
      short_id: string;
      parent_id: string | null;
      title: string;
      position: number;
      has_children: boolean;
    }[]
  >`
    SELECT
      n.id,
      n.short_id,
      n.parent_id,
      n.title,
      n.position,
      EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = n.id) AS has_children
    FROM notebooks.notes n
    WHERE n.notebook_id = ${params.notebookId}::uuid
      AND (${params.parentId === undefined} OR n.parent_id IS NOT DISTINCT FROM ${params.parentId ?? null}::uuid)
      AND (${afterId}::uuid IS NULL OR n.id > ${afterId}::uuid)
    ORDER BY n.id ASC
    LIMIT ${params.limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    shortId: row.short_id,
    parentId: row.parent_id,
    title: row.title,
    position: row.position,
    hasChildren: row.has_children,
  }));
};

/**
 * Get a note by ID.
 */
export const get = async (params: { id: string }): Promise<Note | null> => {
  const [row] = await sql<DbNote[]>`
    SELECT
      n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
      n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
      EXISTS(SELECT 1 FROM notebooks.notes c WHERE c.parent_id = n.id) as has_children
    FROM notebooks.notes n
    WHERE n.id = ${params.id}::uuid
  `;

  return row ? mapToNote(row) : null;
};

/** Resolve the public note identity to its internal UUID-backed model. */
export const getByShortId = async (params: { shortId: string }): Promise<Note | null> => {
  const [row] = await sql<DbNote[]>`
    SELECT
      n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
      n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
      EXISTS(SELECT 1 FROM notebooks.notes c WHERE c.parent_id = n.id) as has_children
    FROM notebooks.notes n
    WHERE n.short_id = ${params.shortId}
  `;
  return row ? mapToNote(row) : null;
};

/** Resolve internal note UUIDs for projection at a public app boundary. */
export const resolveIdsToShortIds = async (params: { ids: string[] }): Promise<Map<string, string>> => {
  const ids = [...new Set(params.ids.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; short_id: string }[]>`
    SELECT id, short_id
    FROM notebooks.notes
    WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id, row.short_id]));
};

/**
 * Get a note with its Yjs content.
 */
const getWithContentRow = async (id: string): Promise<DbNote | null> => {
  const [row] = await sql<DbNote[]>`
    SELECT
      n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
      n.yjs_snapshot, n.yjs_stream_cursor, n.yjs_snapshot_at,
      n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
      EXISTS(SELECT 1 FROM notebooks.notes c WHERE c.parent_id = n.id) as has_children
    FROM notebooks.notes n
    WHERE n.id = ${id}::uuid
  `;

  return row ?? null;
};

export const getWithContent = async (params: { id: string }): Promise<NoteWithContent | null> => {
  const row = await getWithContentRow(params.id);

  return row ? mapToNoteWithContent(row) : null;
};

/**
 * Read a note after replaying every collaborative update published before the
 * returned snapshot marker. This is the authoritative read for consumers that
 * must act on current content rather than the latest persisted snapshot.
 */
export const getCurrentWithContent = async (params: { id: string }): Promise<NoteWithContent | null> => {
  const row = await getWithContentRow(params.id);
  if (!row) return null;

  const streamCursor = row.yjs_stream_cursor ?? null;
  const noteTopic = createYjsTopic(params.id);
  const targetCursor = await noteTopic.latestCursor();
  if (!targetCursor || (streamCursor && compareStreamCursor(targetCursor, streamCursor) <= 0)) return mapToNoteWithContent(row);

  const doc = createDocFromState(row.yjs_snapshot ? new Uint8Array(row.yjs_snapshot) : null, row.content_md);
  try {
    await replayYjsTopicToCursor({
      noteId: params.id,
      after: streamCursor,
      targetCursor,
      doc,
    });
    return {
      ...mapToNote(row),
      contentMd: doc.getText(NOTE_TEXT_NAME).toString(),
      yjsSnapshot: toBase64(Y.encodeStateAsUpdate(doc)),
    };
  } finally {
    doc.destroy();
  }
};

/**
 * Batch-resolve note short-ids to `(noteShortId → notebookShortId)`
 * pairs. Used by the read-mode renderer to build the
 * `noteShortIdToHref` map handed to `transformNoteLinks` in one SQL
 * roundtrip — avoids an N+1 lookup per `note://` link in a body.
 *
 * Notes / notebooks the caller can't see (cross-notebook references)
 * are simply omitted; the renderer marks unresolved short-ids as
 * "broken" links so dangling references stay visible.
 */
export const resolveShortIdsToNotebookShortIds = async (params: {
  shortIds: string[];
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  bypassAccess?: boolean;
}): Promise<Map<string, { notebookShortId: string; noteShortId: string }>> => {
  if (params.shortIds.length === 0) return new Map();
  if (params.serviceAccountId && !params.boundNotebookId) return new Map();
  const arr = toPgTextArray(params.shortIds);
  const principalMatch = buildNotebookVisibleAccessCondition({
    userId: params.userId,
    serviceAccountId: params.serviceAccountId,
  });
  const boundNotebookId = params.boundNotebookId ?? null;
  const rows = params.bypassAccess
    ? await sql<{ note_short_id: string; notebook_short_id: string }[]>`
      SELECT n.short_id AS note_short_id, nb.short_id AS notebook_short_id
      FROM notebooks.notes n
      JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
      WHERE n.short_id = ANY(${arr}::text[])
    `
    : await sql<{ note_short_id: string; notebook_short_id: string }[]>`
      SELECT n.short_id AS note_short_id, nb.short_id AS notebook_short_id
      FROM notebooks.notes n
      JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
      WHERE n.short_id = ANY(${arr}::text[])
        AND EXISTS (
          SELECT 1
          FROM notebooks.notebook_access na
          JOIN auth.access a ON a.id = na.access_id
          WHERE na.notebook_id = n.notebook_id
            AND ${principalMatch}
            AND (${boundNotebookId}::text IS NULL OR n.notebook_id::text = ${boundNotebookId})
        )
    `;
  const map = new Map<string, { notebookShortId: string; noteShortId: string }>();
  for (const r of rows) {
    map.set(r.note_short_id, { notebookShortId: r.notebook_short_id, noteShortId: r.note_short_id });
  }
  return map;
};

/** Resolve the public note identity and include its collaborative content. */
export const getWithContentByShortId = async (params: { shortId: string }): Promise<NoteWithContent | null> => {
  const [row] = await sql<DbNote[]>`
    SELECT
      n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
      n.yjs_snapshot, n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
      EXISTS(SELECT 1 FROM notebooks.notes c WHERE c.parent_id = n.id) as has_children
    FROM notebooks.notes n
    WHERE n.short_id = ${params.shortId}
  `;
  return row ? mapToNoteWithContent(row) : null;
};

/**
 * Create a new note.
 */
export const create = async (params: {
  data: CreateNote;
  creatorId: string | null;
  actor?: activity.NotebookActivityIdentity;
  dateConfig?: DateContext;
}): Promise<MutationResult<Note>> => {
  const { data, creatorId } = params;
  let createdNoteId: string | null = null;

  if (data.parentId && !(await parentExistsInNotebook(data.parentId, data.notebookId))) {
    return { ok: false, error: "Parent note not found in notebook", status: 404 };
  }

  // Get next position if not provided
  let position = data.position;
  if (position === undefined) {
    const [maxPos] = await sql<{ max: number | null }[]>`
      SELECT MAX(position) as max
      FROM notebooks.notes
      WHERE notebook_id = ${data.notebookId}::uuid
        AND ${data.parentId ? sql`parent_id = ${data.parentId}::uuid` : sql`parent_id IS NULL`}
    `;
    position = (maxPos?.max ?? -1) + 1;
  }

  try {
    const shortId = await generateUniqueShortId("note");
    const contentMd = await initialContentForNote({
      notebookId: data.notebookId,
      parentId: data.parentId,
      noteShortId: shortId,
      contentMd: data.contentMd,
      dateConfig: params.dateConfig,
    });
    const title = deriveNoteTitle(contentMd);
    const dataProperties = dataPropertiesForContent(contentMd);
    const doc = createDocFromState(null, contentMd);
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    const [row] = await sql<DbNote[]>`
      INSERT INTO notebooks.notes (
        short_id, notebook_id, parent_id, title, title_projection_version, position,
        yjs_snapshot, yjs_snapshot_at, content_md, data_properties, created_by
      )
      VALUES (
        ${shortId},
        ${data.notebookId}::uuid,
        ${data.parentId ?? null}::uuid,
        ${title},
        1,
        ${position},
        ${snapshot},
        now(),
        ${contentMd},
        ${dataProperties}::jsonb,
        ${creatorId}::uuid
      )
      RETURNING id, short_id, notebook_id, parent_id, title, position,
                yjs_snapshot_at, content_md, created_by, created_at, updated_at, locked_at
    `;

    if (!row) {
      return { ok: false, error: "Failed to create note", status: 500 };
    }
    createdNoteId = row.id;
    await reindexNoteRefsSafe({ noteId: row.id, notebookId: data.notebookId, contentMd });
    const note = (await get({ id: row.id })) ?? mapToNote({ ...row, has_children: false });
    await activity.record({
      notebookId: data.notebookId,
      noteId: row.id,
      actor: params.actor ?? (creatorId ? { kind: "user", id: creatorId } : { kind: "system", id: null }),
      action: "note.created",
    });
    await noteCreated(note);
    return { ok: true, data: note };
  } catch (e: unknown) {
    if (createdNoteId) await cleanupFailedCreate(createdNoteId);
    const error = e as { code?: string };
    if (error.code === "23503") {
      return {
        ok: false,
        error: "Notebook or parent note not found",
        status: 404,
      };
    }
    throw e;
  }
};

/**
 * Update a note.
 */
export const update = async (params: { id: string; data: UpdateNote }): Promise<MutationResult<Note>> => {
  const { id, data } = params;

  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Note not found", status: 404 };
  }

  // Check if note is locked
  if (existing.lockedAt) {
    return { ok: false, error: "Cannot modify locked note", status: 403 };
  }

  const parentId = data.parentId === undefined ? existing.parentId : data.parentId;
  const position = data.position ?? existing.position;

  // Prevent moving note to be its own descendant
  if (parentId !== existing.parentId && parentId !== null) {
    if (!(await parentExistsInNotebook(parentId, existing.notebookId))) {
      return { ok: false, error: "Parent note not found in notebook", status: 404 };
    }

    const isDescendant = await checkIsDescendant(id, parentId);
    if (isDescendant) {
      return {
        ok: false,
        error: "Cannot move note to be a child of itself",
        status: 400,
      };
    }
  }

  const [row] = await sql<DbNote[]>`
    UPDATE notebooks.notes
    SET parent_id = ${parentId}::uuid, position = ${position}, updated_at = now()
    WHERE id = ${id}::uuid
      AND locked_at IS NULL
    RETURNING id, notebook_id, parent_id, title, position,
              yjs_snapshot_at, content_md, created_by, created_at, updated_at
  `;

  if (!row) {
    const current = await get({ id });
    if (!current) return { ok: false, error: "Note not found", status: 404 };
    if (current.lockedAt) return { ok: false, error: "Cannot modify locked note", status: 403 };
    return { ok: false, error: "Failed to update note", status: 500 };
  }

  // Get hasChildren for the updated note
  const note = await get({ id });
  await noteUpdated(note!);
  return { ok: true, data: note! };
};

/**
 * Check if a note is a descendant of another note.
 */
const checkIsDescendant = async (ancestorId: string, descendantId: string): Promise<boolean> => {
  const [result] = await sql<{ is_descendant: boolean }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM notebooks.notes WHERE id = ${descendantId}::uuid
      UNION ALL
      SELECT n.id, n.parent_id FROM notebooks.notes n
      INNER JOIN ancestors a ON n.id = a.parent_id
    )
    SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ${ancestorId}::uuid) as is_descendant
  `;
  return result?.is_descendant ?? false;
};

/**
 * Delete a note and all its children.
 */
export const remove = async (params: { id: string }): Promise<MutationResult<void>> => {
  const existing = await get({ id: params.id });
  const result = await sql`
    DELETE FROM notebooks.notes
    WHERE id = ${params.id}::uuid
  `;

  if (result.count === 0) {
    return { ok: false, error: "Note not found", status: 404 };
  }

  if (existing) {
    await noteDeleted({ notebookId: existing.notebookId, noteId: existing.id, shortId: existing.shortId });
  }
  return { ok: true, data: undefined };
};

/**
 * Move a note to a new position.
 */
export const move = async (params: { id: string; parentId: string | null; position: number }): Promise<MutationResult<Note>> => {
  return update({
    id: params.id,
    data: { parentId: params.parentId, position: params.position },
  });
};

/**
 * Save a note's Yjs state and markdown content.
 * Optionally creates a version entry (skipped if content_md is unchanged).
 */
export const save = async (params: {
  noteId: string;
  yjsState: Uint8Array;
  contentMd: string;
  createdBy: string | null;
  createVersion?: boolean;
  streamCursor?: string | null;
  /** Revision of the DB snapshot used for replay; a restore invalidates older bases. */
  restoreRevision?: string;
  requestedAt?: number;
  contributors?: NoteVersionContributorInput[];
}): Promise<MutationResult<void>> => {
  const { noteId, yjsState, contentMd, createdBy, createVersion = false, streamCursor = null, requestedAt } = params;
  const contributors =
    params.contributors ??
    (createdBy ? [{ kind: "user" as const, id: createdBy, lastContributedAt: new Date(requestedAt ?? Date.now()) }] : []);

  const existing = await get({ id: noteId });
  if (!existing) return { ok: false, error: "Note not found", status: 404 };
  if (existing.lockedAt) return { ok: false, error: "Cannot modify locked note", status: 403 };

  const yjsBuffer = Buffer.from(yjsState);
  const title = deriveNoteTitle(contentMd);
  const dataProperties = dataPropertiesForContent(contentMd);

  const parsedCursor = streamCursor ? { seq: createYjsTopic(noteId).cursorSequence(streamCursor) } : null;
  const requestedAtSeconds = (requestedAt ?? Date.now()) / 1000;

  const result = parsedCursor
    ? await sql`
        UPDATE notebooks.notes
        SET yjs_snapshot = ${yjsBuffer},
            yjs_stream_cursor = ${streamCursor},
            yjs_stream_seq = ${parsedCursor.seq},
            yjs_snapshot_at = now(),
            content_md = ${contentMd},
            data_properties = ${dataProperties}::jsonb,
            title = ${title},
            title_projection_version = 1,
            updated_at = now()
        WHERE id = ${noteId}::uuid
          AND locked_at IS NULL
          AND yjs_restore_revision = ${params.restoreRevision ?? "0"}::bigint
          AND (
            (yjs_stream_cursor IS NULL AND COALESCE(yjs_snapshot_at, created_at) <= to_timestamp(${requestedAtSeconds}))
            OR (yjs_stream_cursor IS NOT NULL AND yjs_stream_seq < ${parsedCursor.seq})
          )
      `
    : await sql`
        UPDATE notebooks.notes
        SET yjs_snapshot = ${yjsBuffer},
            yjs_snapshot_at = now(),
            content_md = ${contentMd},
            data_properties = ${dataProperties}::jsonb,
            title = ${title},
            title_projection_version = 1,
            updated_at = now()
        WHERE id = ${noteId}::uuid
          AND locked_at IS NULL
      `;

  if (result.count === 0) {
    const [status] = await sql<{ exists: boolean; locked: boolean }[]>`
      SELECT
        EXISTS(SELECT 1 FROM notebooks.notes WHERE id = ${noteId}::uuid) AS exists,
        EXISTS(SELECT 1 FROM notebooks.notes WHERE id = ${noteId}::uuid AND locked_at IS NOT NULL) AS locked
    `;
    if (!status?.exists) {
      return { ok: false, error: "Note not found", status: 404 };
    }
    if (status.locked) {
      return { ok: false, error: "Cannot modify locked note", status: 403 };
    }
    if (streamCursor) {
      const current = await getYjsStateWithCursor({ noteId });
      // Only ACK work already covered by the current snapshot. A restore can
      // invalidate our base while leaving later accepted edits unsnapshotted.
      if (!current?.streamCursor || compareStreamCursor(current.streamCursor, streamCursor) < 0) {
        return { ok: false, error: "Note snapshot changed during replay; retry from its current state", status: 409 };
      }
    }
    return { ok: true, data: undefined };
  }

  // Optionally create a version entry.
  // This decision is global and DB-backed, so it works consistently across nodes.
  if (createVersion) {
    const [insertedVersion] = await sql<{ id: string }[]>`
      WITH latest AS (
        SELECT content_md, created_at
        FROM notebooks.note_versions
        WHERE note_id = ${noteId}::uuid
        ORDER BY created_at DESC
        LIMIT 1
      )
      INSERT INTO notebooks.note_versions (note_id, yjs_snapshot, content_md, created_by)
      SELECT ${noteId}::uuid, ${yjsBuffer}, ${contentMd}, ${createdBy}::uuid
      FROM notebooks.notes n
      WHERE n.id = ${noteId}::uuid
        AND (
          NOT EXISTS (SELECT 1 FROM latest)
          OR (
            (SELECT content_md FROM latest) IS DISTINCT FROM ${contentMd}
            AND (SELECT created_at FROM latest) <= now() - ${VERSION_MIN_INTERVAL}::interval
          )
        )
      RETURNING id
    `;
    if (insertedVersion) {
      await sql`
        INSERT INTO notebooks.note_version_contributors (version_id, actor_kind, actor_id)
        SELECT DISTINCT ${insertedVersion.id}::uuid, event.actor_kind, event.actor_id
        FROM notebooks.activity_events event
        WHERE event.note_id = ${noteId}::uuid
          AND event.action = 'note.edited'
          AND event.actor_kind IN ('user', 'service_account')
          AND event.actor_id IS NOT NULL
          AND event.last_occurred_at > COALESCE(
            (
              SELECT previous.created_at
              FROM notebooks.note_versions previous
              WHERE previous.note_id = ${noteId}::uuid
                AND previous.id <> ${insertedVersion.id}::uuid
              ORDER BY previous.created_at DESC
              LIMIT 1
            ),
            '-infinity'::timestamptz
          )
        ON CONFLICT DO NOTHING
      `;
      for (const contributor of contributors) {
        await sql`
          INSERT INTO notebooks.note_version_contributors (version_id, actor_kind, actor_id)
          VALUES (${insertedVersion.id}::uuid, ${contributor.kind}, ${contributor.id}::uuid)
          ON CONFLICT DO NOTHING
        `;
      }
      // Compact old versions using retention policy:
      // - Keep all versions from last 24 hours
      // - Keep max 1 per hour for days 1-7
      // - Keep max 1 per day for days 7-30
      // - Keep max 1 per week for older
      // - Never exceed 100 total versions
      await sql`
        DELETE FROM notebooks.note_versions
        WHERE note_id = ${noteId}::uuid
          AND id NOT IN (
            SELECT id FROM (
              -- All versions from last 24 hours
              SELECT id, created_at, 1 as priority
              FROM notebooks.note_versions
              WHERE note_id = ${noteId}::uuid
                AND created_at > now() - interval '24 hours'

              UNION ALL

              -- 1 per hour for days 1-7 (newest per hour)
              (SELECT DISTINCT ON (date_trunc('hour', created_at))
                id, created_at, 2 as priority
              FROM notebooks.note_versions
              WHERE note_id = ${noteId}::uuid
                AND created_at <= now() - interval '24 hours'
                AND created_at > now() - interval '7 days'
              ORDER BY date_trunc('hour', created_at), created_at DESC)

              UNION ALL

              -- 1 per day for days 7-30 (newest per day)
              (SELECT DISTINCT ON (date_trunc('day', created_at))
                id, created_at, 3 as priority
              FROM notebooks.note_versions
              WHERE note_id = ${noteId}::uuid
                AND created_at <= now() - interval '7 days'
                AND created_at > now() - interval '30 days'
              ORDER BY date_trunc('day', created_at), created_at DESC)

              UNION ALL

              -- 1 per week for older than 30 days (newest per week)
              (SELECT DISTINCT ON (date_trunc('week', created_at))
                id, created_at, 4 as priority
              FROM notebooks.note_versions
              WHERE note_id = ${noteId}::uuid
                AND created_at <= now() - interval '30 days'
              ORDER BY date_trunc('week', created_at), created_at DESC)
            ) AS kept
            ORDER BY priority, created_at DESC
            LIMIT 100
          )
      `;
    }

    for (const contributor of contributors) {
      const bucketStartedAt = new Date(contributor.lastContributedAt);
      bucketStartedAt.setUTCMinutes(0, 0, 0);
      await activity.record({
        notebookId: existing.notebookId,
        noteId,
        noteVersionId: insertedVersion?.id ?? null,
        actor: { kind: contributor.kind, id: contributor.id },
        action: "note.edited",
        bucketStartedAt,
        occurredAt: contributor.lastContributedAt,
      });
    }
  }

  // Refresh the three note-ref indexes (links, tags, attachments) after
  // every successful content write. Cheap and best-effort — a failure
  // here never aborts the save (the periodic scheduler reconciles drift).
  const note = await get({ id: noteId });
  if (note) {
    await reindexNoteRefsSafe({ noteId, notebookId: note.notebookId, contentMd });
    if (existing.title !== note.title || existing.contentMd !== note.contentMd) await noteUpdated(note);
  }

  return { ok: true, data: undefined };
};

export const editContent = async (params: {
  noteId: string;
  data: EditNoteContent;
  createdBy: string | null;
  actor?: { kind: "user" | "service_account"; id: string };
}): Promise<MutationResult<EditNoteContentResult>> => {
  const existing = await getWithContent({ id: params.noteId });
  if (!existing) return { ok: false, error: "Note not found", status: 404 };
  if (existing.lockedAt) return { ok: false, error: "Cannot modify locked note", status: 403 };
  if (params.data.ifUpdatedAt && params.data.ifUpdatedAt !== existing.updatedAt) {
    return {
      ok: false,
      error: `Note updatedAt mismatch. Expected ${params.data.ifUpdatedAt}, got ${existing.updatedAt}.`,
      status: 409,
    };
  }

  const requestedAt = Date.now();
  const initialState = await getYjsStateWithCursor({ noteId: params.noteId });
  if (!initialState) return { ok: false, error: "Note not found", status: 404 };

  const noteTopic = createYjsTopic(params.noteId);
  const targetCursor = await noteTopic.latestCursor();

  const editDoc = createDocFromState(initialState.yjsState, existing.contentMd);
  try {
    if (targetCursor)
      await replayYjsTopicToCursor({
        noteId: params.noteId,
        after: initialState.streamCursor,
        targetCursor,
        doc: editDoc,
      });
  } catch (error) {
    editDoc.destroy();
    return {
      ok: false,
      error: `Failed to synchronize note stream before editing: ${error instanceof Error ? error.message : String(error)}`,
      status: 409,
    };
  }

  const ytext = editDoc.getText(NOTE_TEXT_NAME);
  let editResult: NoteEditResult;
  try {
    const preconditions: NoteEditPreconditions = {
      ifContentHash: params.data.ifContentHash,
      ifBlockHash: params.data.ifBlockHash,
    };
    editResult = applyNoteEdits(ytext.toString(), params.data.operations, preconditions);
  } catch (error) {
    editDoc.destroy();
    if (error instanceof NoteEditError) return { ok: false, error: error.message, status: error.status };
    throw error;
  }

  if (!editResult.changed) {
    const note = await get({ id: params.noteId });
    editDoc.destroy();
    return note ? { ok: true, data: { ...editResult, note } } : { ok: false, error: "Note not found", status: 404 };
  }

  const beforeEditState = Y.encodeStateVector(editDoc);
  editDoc.transact(() => {
    if (ytext.length > 0) ytext.delete(0, ytext.length);
    if (editResult.content.length > 0) ytext.insert(0, editResult.content);
  }, "cli-edit");
  const editUpdate = Y.encodeStateAsUpdate(editDoc, beforeEditState);
  const published = await noteTopic.publish({
    data: {
      kind: "sync",
      payload: toBase64(editUpdate),
      originNodeId: NODE_ID,
      originPeerId: null,
      ...(params.actor ? { actor: params.actor } : params.createdBy ? { actor: { kind: "user" as const, id: params.createdBy } } : {}),
    },
  });
  editDoc.destroy();

  const persistedDoc = createDocFromState(initialState.yjsState, existing.contentMd);
  let persistedContent = editResult.content;
  try {
    await replayYjsTopicToCursor({
      noteId: params.noteId,
      after: initialState.streamCursor,
      targetCursor: published.cursor,
      doc: persistedDoc,
    });
    persistedContent = persistedDoc.getText(NOTE_TEXT_NAME).toString();
    const saveResult = await save({
      noteId: params.noteId,
      yjsState: Y.encodeStateAsUpdate(persistedDoc),
      contentMd: persistedContent,
      createdBy: params.createdBy,
      createVersion: true,
      streamCursor: published.cursor,
      restoreRevision: initialState.restoreRevision,
      requestedAt,
      contributors: params.actor
        ? [{ ...params.actor, lastContributedAt: new Date(requestedAt) }]
        : params.createdBy === null
          ? []
          : [{ kind: "user", id: params.createdBy, lastContributedAt: new Date(requestedAt) }],
    });
    if (!saveResult.ok) return { ok: false, error: saveResult.error, status: saveResult.status };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to persist note edit: ${error instanceof Error ? error.message : String(error)}`,
      status: 500,
    };
  } finally {
    persistedDoc.destroy();
  }

  const note = await get({ id: params.noteId });
  if (!note) return { ok: false, error: "Note not found", status: 404 };
  return {
    ok: true,
    data: {
      ...editResult,
      content: persistedContent,
      afterHash: noteContentHash(persistedContent),
      blocks: summarizeNoteEditBlocks(persistedContent),
      note,
    },
  };
};

/**
 * Get the stored Yjs state for a note.
 */
export const getYjsStateWithCursor = async (params: {
  noteId: string;
}): Promise<{ yjsState: Uint8Array | null; streamCursor: string | null; restoreRevision: string; contentMd: string | null } | null> => {
  const [row] = await sql<DbYjsState[]>`
    SELECT yjs_snapshot, yjs_stream_cursor, content_md, yjs_restore_revision::text
    FROM notebooks.notes
    WHERE id = ${params.noteId}::uuid
  `;
  if (!row) return null;
  return {
    yjsState: row.yjs_snapshot ? new Uint8Array(row.yjs_snapshot) : null,
    streamCursor: row.yjs_stream_cursor,
    restoreRevision: row.yjs_restore_revision,
    contentMd: row.content_md,
  };
};

/**
 * Re-anchor the stored snapshot at the topic head after its cursor fell below
 * retention. Every update between the stored cursor and the first retained
 * event is gone. The retained remainder is skipped as well: it may depend on
 * the lost updates and must not be presented as authoritative. This is a
 * data-loss event, so it is logged at error level and recorded as a failed
 * trace span. It is terminal: afterwards the stored state covers the head and
 * replay resumes from retained history.
 */
export const adoptSnapshotAtHead = async (params: { noteId: string; gap: RetentionGapError }): Promise<{ cursor: string } | null> => {
  const { noteId, gap } = params;
  const stored = await getYjsStateWithCursor({ noteId });
  if (!stored) return null;
  const head = await createYjsTopic(noteId).head();
  const startedAt = new Date();
  const doc = createDocFromState(stored.yjsState, stored.contentMd);
  let result: MutationResult<void>;
  try {
    result = await save({
      noteId,
      yjsState: Y.encodeStateAsUpdate(doc),
      contentMd: doc.getText(NOTE_TEXT_NAME).toString(),
      createdBy: null,
      streamCursor: head,
      restoreRevision: stored.restoreRevision,
      requestedAt: startedAt.getTime(),
    });
  } finally {
    doc.destroy();
  }
  const detail = {
    noteId,
    storedCursor: stored.streamCursor,
    firstRetainedCursor: gap.firstAvailable,
    headCursor: head,
    outcome: result.ok ? "adopted" : `rejected: ${result.error}`,
  };
  log.error("Yjs history gap: stored snapshot re-anchored at the topic head; updates after the stored cursor are lost", detail);
  // The stored row is already re-anchored; a failing trace write must not undo that outcome.
  await trace
    .complete({
      name: "Notebook Yjs history gap",
      source: "notebooks:yjs-history-gap",
      appId: "notebooks",
      category: "sync",
      kind: "internal",
      startedAt,
      endedAt: new Date(),
      status: "error",
      statusMessage: "Retained document history no longer covers the stored snapshot; updates were lost",
      attributes: { "cloud.notebooks.note_id": noteId },
      summary: detail,
    })
    .catch((error: unknown) => {
      log.warn("Could not record the Yjs history gap trace", { noteId, error: error instanceof Error ? error.message : String(error) });
    });
  return result.ok ? { cursor: head } : null;
};

/** Notes whose stored snapshot may lag their topic, oldest snapshot first; locked notes cannot be saved. */
export const listSnapshotCursors = async (params: { limit: number }): Promise<Array<{ noteId: string; streamCursor: string }>> => {
  const rows = await sql<{ id: string; yjs_stream_cursor: string }[]>`
    SELECT id, yjs_stream_cursor
    FROM notebooks.notes
    WHERE yjs_stream_cursor IS NOT NULL AND locked_at IS NULL
    ORDER BY yjs_snapshot_at ASC NULLS FIRST, id ASC
    LIMIT ${params.limit}
  `;
  return rows.map((row) => ({ noteId: row.id, streamCursor: row.yjs_stream_cursor }));
};

/**
 * List versions of a note with pagination.
 */
export const listVersions = async (params: {
  noteId: string;
  pagination: PaginationParams;
}): Promise<{ versions: NoteVersion[]; total: number }> => {
  const { noteId, pagination } = params;
  const { offset, perPage } = pagination;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int as count
    FROM notebooks.note_versions
    WHERE note_id = ${noteId}::uuid
  `;

  const rows = await sql<DbNoteVersion[]>`
    SELECT
      version.id,
      version.note_id,
      version.created_by,
      version.created_at,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'kind', contributor.actor_kind,
            'id', contributor.actor_id,
            'displayName', COALESCE(
              NULLIF(actor_user.display_name, ''),
              actor_user.uid,
              actor_service.name,
              CASE contributor.actor_kind WHEN 'user' THEN 'Former user' ELSE 'Former service account' END
            ),
            'avatarHash', actor_user.avatar_hash
          ) ORDER BY contributor.actor_kind, contributor.actor_id
        ) FILTER (WHERE contributor.actor_id IS NOT NULL),
        '[]'::jsonb
      ) AS contributors
    FROM notebooks.note_versions version
    LEFT JOIN notebooks.note_version_contributors contributor ON contributor.version_id = version.id
    LEFT JOIN auth.users actor_user ON contributor.actor_kind = 'user' AND actor_user.id = contributor.actor_id
    LEFT JOIN auth.service_accounts actor_service
      ON contributor.actor_kind = 'service_account' AND actor_service.id = contributor.actor_id
    WHERE version.note_id = ${noteId}::uuid
    GROUP BY version.id
    ORDER BY version.created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `;

  return {
    versions: rows.map(mapToNoteVersion),
    total: countRow?.count ?? 0,
  };
};

/**
 * Get a specific version's snapshot. Scoped by `noteId` so a versionId leaked
 * from another note can't be fetched through any caller-readable note.
 */
export const getVersionSnapshot = async (params: { noteId: string; versionId: string }): Promise<Uint8Array | null> => {
  const [row] = await sql<{ yjs_snapshot: Buffer }[]>`
    SELECT yjs_snapshot FROM notebooks.note_versions
    WHERE id = ${params.versionId}::uuid AND note_id = ${params.noteId}::uuid
  `;

  return row ? new Uint8Array(row.yjs_snapshot) : null;
};

/**
 * Restore a note from a Yjs snapshot (base64).
 * Intended for restoring into a newly created empty note.
 */
export const restoreFromSnapshot = async (params: {
  noteId: string;
  yjsSnapshot: string; // base64
  createdBy: string | null;
}): Promise<MutationResult<Note>> => {
  const { noteId, yjsSnapshot, createdBy } = params;

  const existing = await getWithContent({ id: noteId });
  if (!existing) {
    return { ok: false, error: "Note not found", status: 404 };
  }

  // Check if note is locked
  if (existing.lockedAt) {
    return { ok: false, error: "Cannot restore locked note", status: 403 };
  }

  const currentContent = existing.contentMd ?? "";
  let hasContent = currentContent.trim().length > 0;
  if (!hasContent && existing.yjsSnapshot) {
    const currentDoc = new Y.Doc();
    try {
      Y.applyUpdate(currentDoc, Buffer.from(existing.yjsSnapshot, "base64"));
      hasContent = currentDoc.getText("codemirror").toString().trim().length > 0;
    } catch {
      hasContent = true;
    } finally {
      currentDoc.destroy();
    }
  }
  if (hasContent) {
    return {
      ok: false,
      error: "Restore only supports new empty notes. Create a new note and restore there.",
      status: 400,
    };
  }

  // Decode new snapshot and extract markdown for note row + version history.
  let snapshotBuffer: Buffer;
  let restoredContentMd: string;
  const restoredDoc = new Y.Doc();
  try {
    snapshotBuffer = Buffer.from(fromBase64Strict(yjsSnapshot));
    Y.applyUpdate(restoredDoc, new Uint8Array(snapshotBuffer));
    restoredContentMd = restoredDoc.getText(NOTE_TEXT_NAME).toString();
  } catch {
    return { ok: false, error: "Invalid Yjs snapshot", status: 400 };
  } finally {
    restoredDoc.destroy();
  }
  const restoredTitle = deriveNoteTitle(restoredContentMd);
  const restoredDataProperties = dataPropertiesForContent(restoredContentMd);
  // The restored snapshot replaces everything up to this real stream boundary.
  // Preserve the zero boundary too: absence of retained events is not a new log.
  const restoreTopic = createYjsTopic(noteId);
  const restoreCursor =
    (await restoreTopic.latestCursor()) ?? (await getYjsStateWithCursor({ noteId }))?.streamCursor ?? restoreTopic.cursorAt(0);
  const restoreSequence = restoreTopic.cursorSequence(restoreCursor);

  const restored = await sql.begin(async (tx): Promise<{ versionId: string } | null> => {
    const result = await tx`
      UPDATE notebooks.notes
      SET yjs_snapshot = ${snapshotBuffer},
          yjs_stream_cursor = ${restoreCursor},
          yjs_stream_seq = ${restoreSequence},
          yjs_restore_revision = yjs_restore_revision + 1,
          yjs_snapshot_at = now(),
          content_md = ${restoredContentMd},
          data_properties = ${restoredDataProperties}::jsonb,
          title = ${restoredTitle},
          title_projection_version = 1,
          updated_at = now()
      WHERE id = ${noteId}::uuid
        AND locked_at IS NULL
    `;
    if (result.count === 0) return null;

    // Keep the restored row and its history entry atomic.
    const [version] = await tx<{ id: string }[]>`
      INSERT INTO notebooks.note_versions (note_id, yjs_snapshot, content_md, created_by)
      VALUES (${noteId}::uuid, ${snapshotBuffer}, ${restoredContentMd}, ${createdBy}::uuid)
      RETURNING id
    `;
    if (!version) throw new Error("Failed to create restored note version");
    if (createdBy) {
      await tx`
        INSERT INTO notebooks.note_version_contributors (version_id, actor_kind, actor_id)
        VALUES (${version.id}::uuid, 'user', ${createdBy}::uuid)
      `;
    }
    return { versionId: version.id };
  });

  if (!restored) {
    const current = await get({ id: noteId });
    if (!current) return { ok: false, error: "Note not found", status: 404 };
    if (current.lockedAt) return { ok: false, error: "Cannot restore locked note", status: 403 };
    return { ok: false, error: "Failed to restore snapshot", status: 500 };
  }

  // Restored content can carry a different set of refs (links, tags,
  // attachments) than was previously indexed — refresh all three.
  await reindexNoteRefsSafe({ noteId, notebookId: existing.notebookId, contentMd: restoredContentMd });
  await activity.record({
    notebookId: existing.notebookId,
    noteId,
    noteVersionId: restored.versionId,
    actor: createdBy ? { kind: "user", id: createdBy } : { kind: "system", id: null },
    action: "note.restored",
  });

  const updated = await get({ id: noteId });
  if (updated) await noteUpdated(updated);
  return { ok: true, data: updated! };
};

/**
 * Get a version's snapshot with content_md. Scoped by `noteId` (see
 * `getVersionSnapshot`).
 */
export const getVersionWithContent = async (params: {
  noteId: string;
  versionId: string;
}): Promise<{ yjsSnapshot: Uint8Array; contentMd: string | null } | null> => {
  const [row] = await sql<{ yjs_snapshot: Buffer; content_md: string | null }[]>`
    SELECT yjs_snapshot, content_md FROM notebooks.note_versions
    WHERE id = ${params.versionId}::uuid AND note_id = ${params.noteId}::uuid
  `;

  return row
    ? {
        yjsSnapshot: new Uint8Array(row.yjs_snapshot),
        contentMd: row.content_md,
      }
    : null;
};

/**
 * Copy a note to another notebook.
 */
export const copyToNotebook = async (params: {
  noteId: string;
  targetNotebookId: string;
  targetParentId?: string | null;
  creatorId: string | null;
}): Promise<MutationResult<Note>> => {
  const { noteId, targetNotebookId, targetParentId, creatorId } = params;

  const source = await getWithContent({ id: noteId });
  if (!source) {
    return { ok: false, error: "Source note not found", status: 404 };
  }

  let contentMd = source.contentMd;
  try {
    if (contentMd === null && source.yjsSnapshot) {
      const doc = createDocFromState(fromBase64Strict(source.yjsSnapshot), null);
      contentMd = doc.getText(NOTE_TEXT_NAME).toString();
      doc.destroy();
    }
  } catch (error) {
    log.error("Failed to decode copied note content", {
      sourceNoteId: noteId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Failed to copy note content", status: 500 };
  }
  return create({
    data: {
      notebookId: targetNotebookId,
      parentId: targetParentId ?? undefined,
      contentMd: contentMd ?? undefined,
    },
    creatorId,
  });
};
