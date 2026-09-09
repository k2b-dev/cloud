/**
 * Attachments service — file blobs stored in Postgres bytea, FK-bound to a
 * notebook (cascades on notebook delete).
 *
 * Markdown encodes attachment references as `attach://<shortId>` (6-char
 * readable ID). Resolution to the real download URL happens at render
 * time (see `transformAttachments`) and inside CodeMirror image/file
 * widgets (client-side). The scheme is `attach://` (not `attachment://`
 * or `file://`) — the latter clashes with RFC 8089 filesystem URIs that
 * some markdown sanitizers / mail clients block.
 *
 * All primitives here are permission-blind. The API/page layer is
 * responsible for `notebook.permission.get(...)` checks before calling.
 */

import { fileIcons } from "@k2b/stdlib";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { generateUniqueShortId } from "../lib/short-id";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type AttachmentKind = "image" | "file";

export type Attachment = {
  id: string;
  shortId: string;
  notebookId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  createdBy: string | null;
  createdAt: string;
};

export type AttachmentContent = Attachment & { content: Uint8Array };

type DbRow = {
  id: string;
  short_id: string;
  notebook_id: string;
  filename: string;
  mime_type: string;
  size_bytes: string | number; // BIGINT may serialize as string
  kind: AttachmentKind;
  created_by: string | null;
  created_at: string;
};

const mapRow = (r: DbRow): Attachment => ({
  id: r.id,
  shortId: r.short_id,
  notebookId: r.notebook_id,
  filename: r.filename,
  mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes),
  kind: r.kind,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** Map a MIME type / filename to our binary `kind`. Image-vs-everything-else. */
export const detectKind = (filename: string, mimeType: string): AttachmentKind =>
  fileIcons.getFileCategory({ name: filename, type: "file", mimeType }) === "image" ? "image" : "file";

// =============================================================================
// CRUD
// =============================================================================

export const upload = async (params: {
  notebookId: string;
  filename: string;
  mimeType: string;
  content: Uint8Array;
  userId: string | null;
}): Promise<Attachment> => {
  const kind = detectKind(params.filename, params.mimeType);
  const shortId = await generateUniqueShortId("attachment");
  const [row] = await sql<DbRow[]>`
    INSERT INTO notebooks.attachments
      (short_id, notebook_id, filename, mime_type, size_bytes, kind, content, created_by)
    VALUES
      (${shortId}, ${params.notebookId}, ${params.filename}, ${params.mimeType},
       ${params.content.byteLength}, ${kind}, ${params.content}, ${params.userId}::uuid)
    RETURNING id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at
  `;
  return mapRow(row!);
};

export const get = async (params: { id: string }): Promise<Attachment | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at
    FROM notebooks.attachments WHERE id = ${params.id}
  `;
  return row ? mapRow(row) : null;
};

/** Resolve the public attachment identity to its internal UUID-backed model. */
export const getByShortId = async (params: { shortId: string }): Promise<Attachment | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at
    FROM notebooks.attachments WHERE short_id = ${params.shortId}
  `;
  return row ? mapRow(row) : null;
};

export const getContent = async (params: { id: string }): Promise<AttachmentContent | null> => {
  const [row] = await sql<(DbRow & { content: Uint8Array })[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at, content
    FROM notebooks.attachments WHERE id = ${params.id}
  `;
  return row ? { ...mapRow(row), content: row.content } : null;
};

/** Load attachment content by its public short ID. */
export const getContentByShortId = async (params: { shortId: string }): Promise<AttachmentContent | null> => {
  const [row] = await sql<(DbRow & { content: Uint8Array })[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at, content
    FROM notebooks.attachments WHERE short_id = ${params.shortId}
  `;
  return row ? { ...mapRow(row), content: row.content } : null;
};

export const list = async (params: { notebookId: string }): Promise<Attachment[]> => {
  const rows = await sql<DbRow[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at
    FROM notebooks.attachments
    WHERE notebook_id = ${params.notebookId}
    ORDER BY created_at DESC
  `;
  return rows.map(mapRow);
};

/** Hydrate metadata for a specific set of ids — used by detail panel
 *  when only `attach://` ids referenced in the current note matter. */
export const listByIds = async (params: { ids: string[] }): Promise<Attachment[]> => {
  if (params.ids.length === 0) return [];
  const idArray = toPgUuidArray(params.ids);
  const rows = await sql<DbRow[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at
    FROM notebooks.attachments
    WHERE id = ANY(${idArray}::uuid[])
  `;
  return rows.map(mapRow);
};

/** Hydrate metadata by short-id — used by the read-mode renderer when
 *  it has just extracted `attach://<shortId>` refs from a markdown body
 *  and needs filenames for the file-pill rendering. Single batched
 *  query, served from the unique `short_id` index. */
export const listByShortIds = async (params: { shortIds: string[]; notebookId?: string }): Promise<Attachment[]> => {
  if (params.shortIds.length === 0) return [];
  const arr = toPgTextArray(params.shortIds);
  const rows = await sql<DbRow[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at
    FROM notebooks.attachments
    WHERE short_id = ANY(${arr}::text[])
      AND (${params.notebookId ?? null}::uuid IS NULL OR notebook_id = ${params.notebookId ?? null}::uuid)
  `;
  return rows.map(mapRow);
};

export const remove = async (params: { id: string }): Promise<void> => {
  await sql`DELETE FROM notebooks.attachments WHERE id = ${params.id}`;
};

/** Cheap COUNT — used by the sidebar to gate the "Attachments" link. */
export const count = async (params: { notebookId: string }): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM notebooks.attachments WHERE notebook_id = ${params.notebookId}
  `;
  return row?.count ?? 0;
};

/**
 * Paginated + filterable list — drives the overview page. Search is a
 * case-insensitive substring match against `filename` (KISS — mime_type
 * is internal noise that wouldn't help users find a file by name).
 */
export const searchPaginated = async (params: {
  notebookId: string;
  search?: string;
  pagination: { limit: number; offset: number };
}): Promise<{ items: Attachment[]; total: number }> => {
  const q = params.search?.trim().toLowerCase();
  const pattern = q && q.length > 0 ? `%${q}%` : null;

  const rows = await sql<DbRow[]>`
    SELECT id, short_id, notebook_id, filename, mime_type, size_bytes, kind, created_by, created_at
    FROM notebooks.attachments
    WHERE notebook_id = ${params.notebookId}
      AND (${pattern}::text IS NULL OR LOWER(filename) LIKE ${pattern})
    ORDER BY created_at DESC
    LIMIT ${params.pagination.limit}
    OFFSET ${params.pagination.offset}
  `;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.attachments
    WHERE notebook_id = ${params.notebookId}
      AND (${pattern}::text IS NULL OR LOWER(filename) LIKE ${pattern})
  `;

  return { items: rows.map(mapRow), total: countRow?.count ?? 0 };
};

// =============================================================================
// Markdown helpers (used by editor / detail panel / read-mode renderer)
// =============================================================================

const ATTACHMENT_REF_REGEX = /attach:\/\/([0-9a-zA-Z]{6})/g;

/** Extract every unique attachment short-id referenced from a markdown body.
 *  Returns the short-id form — callers resolve to UUIDs via the `attachments`
 *  table when they need to query (e.g. `reindexAttachmentRefs`). */
export const extractIds = (md: string | null): string[] => {
  if (!md) return [];
  const ids = new Set<string>();
  for (const match of md.matchAll(ATTACHMENT_REF_REGEX)) ids.add(match[1]!);
  return Array.from(ids);
};

/**
 * Count notes within a notebook that reference a given attachment id —
 * served from the `notebooks.note_attachments` index table (O(log N)
 * lookup instead of a `LIKE '%...'%` content_md scan). The index is kept
 * in sync via the per-save `reindexAttachmentRefs` and the periodic
 * scheduler reindex.
 */
export const usageCount = async (params: { notebookId: string; attachmentId: string }): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.note_attachments
    WHERE notebook_id = ${params.notebookId}
      AND attachment_id = ${params.attachmentId}
  `;
  return row?.count ?? 0;
};

/** Reindex which attachment ids the given note references. Mirrors
 *  `reindexLinks` / `reindexTags` shape for the unified `reindexNoteRefs`
 *  orchestrator. Drops rows that point at attachments which have been
 *  deleted in the meantime (FK CASCADE handles that, but we ANTI JOIN
 *  upfront to avoid inserting them). */
export const reindexAttachmentRefs = async (params: { noteId: string; notebookId: string; contentMd: string | null }): Promise<void> => {
  const shortIds = extractIds(params.contentMd);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM notebooks.note_attachments WHERE note_id = ${params.noteId}`;
    if (shortIds.length === 0) return;
    // Filter to attachments that actually exist + belong to the same
    // notebook — defensive against cross-notebook copy/paste of an
    // `attach://` URL whose blob isn't visible from here. Lookup by
    // short_id since that's the form carried in markdown bodies.
    const arr = toPgTextArray(shortIds);
    const valid = await tx<{ id: string }[]>`
      SELECT id FROM notebooks.attachments
      WHERE notebook_id = ${params.notebookId}
        AND short_id = ANY(${arr}::text[])
    `;
    if (valid.length === 0) return;
    await tx`
      INSERT INTO notebooks.note_attachments ${tx(valid.map((row) => ({ note_id: params.noteId, notebook_id: params.notebookId, attachment_id: row.id })))}
      ON CONFLICT DO NOTHING
    `;
  });
};

// =============================================================================
// HTML post-processor — analogous to `transformNoteLinks`. Run AFTER
// `markdown.render(...)` to swap `attach://<shortId>` references for real
// download URLs and render non-image links as file pills.
// =============================================================================

/**
 * Notebook-scoped content URL using the public notebook and attachment IDs.
 */
const buildContentUrl = (notebookId: string, attachmentId: string) =>
  `/api/notebooks/${notebookId}/attachments/${attachmentId}/content?v=1`;

export const transformAttachments = (html: string, params: { notebookId: string; shortIdToFilename?: Map<string, string> }): string => {
  const { notebookId, shortIdToFilename } = params;

  // 1) <img src="attach://<shortId>"> → rewrite src to API content URL
  let out = html.replace(/(<img[^>]*\bsrc=")attach:\/\/([0-9a-zA-Z]{6})("[^>]*>)/g, (_m, head: string, shortId: string, tail: string) => {
    return `${head}${buildContentUrl(notebookId, shortId)}${tail}`;
  });

  // 2) <a href="attach://<shortId>">label</a> → render as file pill
  out = out.replace(/<a[^>]*\bhref="attach:\/\/([0-9a-zA-Z]{6})"[^>]*>([^<]*)<\/a>/g, (_m, shortId: string, label: string) => {
    const filename = shortIdToFilename?.get(shortId) ?? label;
    const icon = fileIcons.getFileIcon({ name: filename, type: "file" });
    const href = buildContentUrl(notebookId, shortId);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="cm-attachment-pill inline-flex items-center gap-1 rounded-md bg-zinc-100/80 px-1.5 py-0.5 text-zinc-700 no-underline shadow-[var(--ui-shadow-surface)] hover:bg-zinc-200/80 dark:bg-zinc-800/80 dark:text-zinc-300 dark:hover:bg-zinc-700/80" title="${escapeHtml(filename)}"><i class="ti ${icon} text-xs"></i><span>${escapeHtml(label)}</span></a>`;
  });

  return out;
};
