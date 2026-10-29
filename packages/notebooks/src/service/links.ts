import { logger, toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { buildNotebookVisibleAccessCondition, mayReadAcrossNotebooks } from "./access";

const log = logger("notebooks:links");

// ==========================
// Types
// ==========================

export type NoteLink = {
  sourceNoteId: string;
  targetNoteId: string;
};

export type Backlink = {
  noteId: string;
  title: string;
  notebookId: string;
  notebookName: string;
  updatedAt: string;
};

export type NoteRelation = {
  direction: "incoming" | "outgoing";
  noteId: string;
  title: string;
  notebookId: string;
  notebookName: string;
  updatedAt: string;
};

// Graph view payload — nodes + edges scoped to a single notebook. The shape
// is intentionally tight (only what the visualisation needs) so we can stream
// hundreds of notes without ballooning the SSR/JSON payload.
export type GraphNode = {
  id: string;
  title: string;
  /** Number of incoming links from inside this notebook — drives node size
   *  in the visualisation (more linked = bigger). */
  inDegree: number;
  /** Parent note's public id, or null at the top level. */
  parentId: string | null;
  /** Manual order within the parent level. */
  position: number;
  /** Last change as an ISO timestamp. */
  updatedAt: string;
};

export type GraphEdge = {
  source: string;
  target: string;
};

export type NoteGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Present when the notebook is too large to draw whole: the graph then holds the pages around one page, and `total`
   * is the number of pages in the notebook.
   */
  scope?: { around: string; total: number };
};

/** A notebook up to this size draws whole; a larger one draws the pages around one page. */
export const GRAPH_WHOLE_NOTES = 500;
/** The most pages the graph around one page holds, their places in the tree included. */
export const GRAPH_AROUND_NOTES = 400;

// ==========================
// Link extraction
// ==========================

/**
 * Matches internal note references of the form `note://<shortId>`
 * inside a markdown body. Public IDs have six readable characters.
 */
export const NOTE_LINK_REGEX = /note:\/\/([0-9a-zA-Z]{6})/g;

/**
 * Pull every distinct referenced-note short-id out of a markdown body.
 * Returns the short-id form (deduped); the caller resolves to UUIDs
 * before persisting into `note_links` (see `reindexLinks` below).
 */
export const extractNoteLinks = (contentMd: string | null): string[] => {
  if (!contentMd) return [];
  const ids = new Set<string>();
  for (const match of contentMd.matchAll(NOTE_LINK_REGEX)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
};

// ==========================
// Index maintenance
// ==========================

/**
 * Replace the outgoing links for a single source note.
 *
 * Body refs come in as `note://<shortId>` — we resolve those short-ids
 * to canonical UUIDs against `notebooks.notes` and persist UUIDs in
 * `note_links` (which has UUID FKs both directions). Stale or
 * cross-notebook short-ids that don't resolve are silently dropped.
 * Self-links are filtered both in JS and in the SQL `<>` guard.
 */
export const reindexLinks = async (sourceNoteId: string, contentMd: string | null): Promise<void> => {
  const targetShortIds = extractNoteLinks(contentMd);

  await sql`
    DELETE FROM notebooks.note_links
    WHERE source_note_id = ${sourceNoteId}::uuid
  `;

  if (targetShortIds.length === 0) return;

  const arr = toPgTextArray(targetShortIds);
  await sql`
    INSERT INTO notebooks.note_links (source_note_id, target_note_id)
    SELECT ${sourceNoteId}::uuid, n.id
    FROM notebooks.notes n
    WHERE n.short_id = ANY(${arr}::text[])
      AND n.id <> ${sourceNoteId}::uuid
    ON CONFLICT DO NOTHING
  `;
};

/**
 * Best-effort wrapper used by save paths. An indexing failure must never
 * roll back the underlying save — we log and move on; the next save (or a
 * backfill) will reconcile.
 */
export const reindexLinksSafe = async (sourceNoteId: string, contentMd: string | null): Promise<void> => {
  try {
    await reindexLinks(sourceNoteId, contentMd);
  } catch (error) {
    log.warn("Failed to reindex note links", {
      sourceNoteId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ==========================
// Backlinks query
// ==========================

type BacklinkRow = {
  note_id: string;
  note_short_id: string;
  title: string;
  notebook_id: string;
  notebook_short_id: string;
  notebook_name: string;
  updated_at: Date;
};

/**
 * List notes that link to `noteId`, filtered by access on the *source*
 * notebook so a backlink only appears if the requester can read where it's
 * coming from.
 *
 * `bypassAccess: true` skips the access filter — used for global admins so
 * the backlinks panel reflects the full link graph for them.
 */
export const listBacklinks = async (params: {
  noteId: string;
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  bypassAccess?: boolean;
}): Promise<Backlink[]> => {
  const { noteId, userId, bypassAccess = false } = params;
  if (!(await mayReadAcrossNotebooks(params))) return [];
  const principalMatch = buildNotebookVisibleAccessCondition({ userId, serviceAccountId: params.serviceAccountId });
  const boundNotebookId = params.boundNotebookId ?? null;

  const rows = bypassAccess
    ? await sql<BacklinkRow[]>`
        SELECT DISTINCT
          src.id AS note_id,
          src.short_id AS note_short_id,
          src.title,
          src.notebook_id,
          nb.short_id AS notebook_short_id,
          nb.name AS notebook_name,
          src.updated_at
        FROM notebooks.note_links nl
        JOIN notebooks.notes src ON src.id = nl.source_note_id
        JOIN notebooks.notebooks nb ON nb.id = src.notebook_id
        WHERE nl.target_note_id = ${noteId}::uuid
        ORDER BY src.updated_at DESC
      `
    : await sql<BacklinkRow[]>`
        SELECT DISTINCT
          src.id AS note_id,
          src.short_id AS note_short_id,
          src.title,
          src.notebook_id,
          nb.short_id AS notebook_short_id,
          nb.name AS notebook_name,
          src.updated_at
        FROM notebooks.note_links nl
        JOIN notebooks.notes src ON src.id = nl.source_note_id
        JOIN notebooks.notebooks nb ON nb.id = src.notebook_id
        WHERE nl.target_note_id = ${noteId}::uuid
          AND EXISTS (
            SELECT 1
            FROM notebooks.notebook_access na
            JOIN auth.access a ON a.id = na.access_id
            WHERE na.notebook_id = src.notebook_id
              AND ${principalMatch}
              AND (${boundNotebookId}::text IS NULL OR src.notebook_id::text = ${boundNotebookId})
          )
        ORDER BY src.updated_at DESC
      `;

  return rows.map((r) => ({
    noteId: r.note_short_id,
    title: r.title,
    notebookId: r.notebook_short_id,
    notebookName: r.notebook_name,
    updatedAt: r.updated_at.toISOString(),
  }));
};

/**
 * List a bounded page of readable notes connected to one note. Access is
 * checked on the related note's notebook so links never reveal hidden titles.
 */
export const listNoteRelations = async (params: {
  noteId: string;
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  direction: "incoming" | "outgoing" | "all";
  pagination: { limit: number; offset: number };
}): Promise<NoteRelation[]> => {
  if (!(await mayReadAcrossNotebooks(params))) return [];
  const principalMatch = buildNotebookVisibleAccessCondition({
    userId: params.userId,
    serviceAccountId: params.serviceAccountId,
  });
  const boundNotebookId = params.boundNotebookId ?? null;
  const rows = await sql<
    {
      direction: "incoming" | "outgoing";
      note_id: string;
      note_short_id: string;
      title: string;
      notebook_id: string;
      notebook_short_id: string;
      notebook_name: string;
      updated_at: Date;
    }[]
  >`
    WITH related AS (
      SELECT
        'incoming'::text AS direction,
        src.id AS note_id,
        src.short_id AS note_short_id,
        src.title,
        src.notebook_id,
        src.updated_at
      FROM notebooks.note_links nl
      JOIN notebooks.notes src ON src.id = nl.source_note_id
      WHERE nl.target_note_id = ${params.noteId}::uuid
        AND ${params.direction !== "outgoing"}

      UNION ALL

      SELECT
        'outgoing'::text AS direction,
        target.id AS note_id,
        target.short_id AS note_short_id,
        target.title,
        target.notebook_id,
        target.updated_at
      FROM notebooks.note_links nl
      JOIN notebooks.notes target ON target.id = nl.target_note_id
      WHERE nl.source_note_id = ${params.noteId}::uuid
        AND ${params.direction !== "incoming"}
    )
    SELECT
      related.direction,
      related.note_id,
      related.note_short_id,
      related.title,
      related.notebook_id,
      nb.short_id AS notebook_short_id,
      nb.name AS notebook_name,
      related.updated_at
    FROM related
    JOIN notebooks.notebooks nb ON nb.id = related.notebook_id
    WHERE (${boundNotebookId}::uuid IS NULL OR related.notebook_id = ${boundNotebookId}::uuid)
      AND EXISTS (
        SELECT 1
        FROM notebooks.notebook_access na
        JOIN auth.access a ON a.id = na.access_id
        WHERE na.notebook_id = related.notebook_id
          AND ${principalMatch}
      )
    ORDER BY related.direction ASC, related.updated_at DESC, related.note_id ASC
    LIMIT ${params.pagination.limit}
    OFFSET ${params.pagination.offset}
  `;
  return rows.map((row) => ({
    direction: row.direction,
    noteId: row.note_short_id,
    title: row.title,
    notebookId: row.notebook_short_id,
    notebookName: row.notebook_name,
    updatedAt: row.updated_at.toISOString(),
  }));
};

// ==========================
// Graph view
// ==========================

/**
 * Build the per-notebook link graph: every note in the notebook becomes a
 * node, every `note_links` row whose source AND target are both inside the
 * notebook becomes an edge.
 * Nodes include the parent's public id, manual position, and last change as ISO.
 *
 * Edges that point outside the notebook (cross-notebook links) are
 * intentionally dropped from the graph payload — the visualisation is
 * scoped to one notebook at a time. Cross-notebook visualisation is a
 * separate (larger) feature.
 *
 * `inDegree` counts only *internal* incoming links so node size in the
 * graph reflects connectedness within the same notebook.
 *
 * Access control is performed at the route layer (the caller already
 * passed `checkNotebookAccess`); this function trusts that gate and does
 * not re-filter.
 */
export const buildNotebookGraph = async (params: { notebookId: string }): Promise<NoteGraph> => {
  const { notebookId } = params;

  const noteRows = await sql<
    { id: string; short_id: string; title: string; parent_short_id: string | null; position: number; updated_at: Date }[]
  >`
    SELECT n.id, n.short_id, n.title, p.short_id AS parent_short_id, n.position, n.updated_at
    FROM notebooks.notes n
    LEFT JOIN notebooks.notes p ON p.id = n.parent_id AND p.notebook_id = n.notebook_id
    WHERE n.notebook_id = ${notebookId}::uuid
    ORDER BY n.created_at ASC, n.short_id ASC
  `;

  const edgeRows = await sql<{ source_note_id: string; target_note_id: string; source_short_id: string; target_short_id: string }[]>`
    SELECT nl.source_note_id, nl.target_note_id, src.short_id AS source_short_id, tgt.short_id AS target_short_id
    FROM notebooks.note_links nl
    JOIN notebooks.notes src ON src.id = nl.source_note_id
    JOIN notebooks.notes tgt ON tgt.id = nl.target_note_id
    WHERE src.notebook_id = ${notebookId}::uuid
      AND tgt.notebook_id = ${notebookId}::uuid
    ORDER BY src.short_id, tgt.short_id
  `;

  const inDegree = new Map<string, number>();
  for (const edge of edgeRows) {
    inDegree.set(edge.target_note_id, (inDegree.get(edge.target_note_id) ?? 0) + 1);
  }

  return {
    nodes: noteRows.map((n) => ({
      id: n.short_id,
      title: n.title,
      inDegree: inDegree.get(n.id) ?? 0,
      parentId: n.parent_short_id,
      position: n.position,
      updatedAt: n.updated_at.toISOString(),
    })),
    edges: edgeRows.map((e) => ({ source: e.source_short_id, target: e.target_short_id })),
  };
};

type GraphNoteRow = { id: string; short_id: string; title: string; parent_short_id: string | null; position: number; updated_at: Date };

/** Pages linked with these pages, in either direction, inside the notebook, other than `except`. Bounded by `limit`. */
const linkedWith = async (notebookId: string, ids: string[], except: Iterable<string>, limit: number): Promise<string[]> => {
  if (ids.length === 0 || limit <= 0) return [];
  const rows = await sql<{ id: string }[]>`
    SELECT DISTINCT other.id
    FROM (
      SELECT target_note_id AS id FROM notebooks.note_links WHERE source_note_id = ANY(${sql.array(ids, "UUID")})
      UNION ALL
      SELECT source_note_id AS id FROM notebooks.note_links WHERE target_note_id = ANY(${sql.array(ids, "UUID")})
    ) linked
    JOIN notebooks.notes other ON other.id = linked.id AND other.notebook_id = ${notebookId}::uuid
    WHERE other.id <> ALL(${sql.array([...except], "UUID")})
    ORDER BY other.id
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
};

/**
 * The graph around one page of a large notebook: the page, the pages linked with it and with those, its own
 * sub-pages, and the places of all of them in the tree, so areas and depths read as in the whole graph. A page joins
 * only with its whole way up, and the ways up count toward the bound, so no tree shape makes the graph larger. Every
 * query starts from these pages, so the cost does not grow with the notebook.
 */
export const buildNotebookGraphAround = async (params: { notebookId: string; noteId: string; total: number }): Promise<NoteGraph> => {
  const { notebookId } = params;
  const first = await linkedWith(notebookId, [params.noteId], [params.noteId], GRAPH_AROUND_NOTES);
  const children = await sql<{ id: string }[]>`
    SELECT id FROM notebooks.notes
    WHERE notebook_id = ${notebookId}::uuid AND parent_id = ${params.noteId}::uuid
    ORDER BY position, title, short_id
    LIMIT ${GRAPH_AROUND_NOTES}
  `;
  const nearer = new Set([params.noteId, ...first, ...children.map((row) => row.id)]);
  const second = await linkedWith(notebookId, first, nearer, GRAPH_AROUND_NOTES);
  const candidates = [...nearer, ...second];
  // Each candidate's way up. UNION ends the walk even if a broken tree loops.
  const ways = await sql<{ start: string; id: string }[]>`
    WITH RECURSIVE up(start, id) AS (
      SELECT id, parent_id FROM notebooks.notes WHERE id = ANY(${sql.array(candidates, "UUID")}) AND parent_id IS NOT NULL
      UNION
      SELECT up.start, n.parent_id FROM notebooks.notes n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL
    )
    SELECT start, id FROM up
  `;
  const wayUp = new Map<string, string[]>();
  for (const row of ways) wayUp.set(row.start, [...(wayUp.get(row.start) ?? []), row.id]);
  // Nearest first; the open page and its way up always belong.
  const included = new Set<string>();
  for (const id of candidates) {
    const missing = [id, ...(wayUp.get(id) ?? [])].filter((entry) => !included.has(entry));
    if (id !== params.noteId && included.size + missing.length > GRAPH_AROUND_NOTES) continue;
    for (const entry of missing) included.add(entry);
  }
  const idArray = sql.array([...included], "UUID");
  const [noteRows, edgeRows, inRows] = await Promise.all([
    sql<GraphNoteRow[]>`
      SELECT n.id, n.short_id, n.title, p.short_id AS parent_short_id, n.position, n.updated_at
      FROM notebooks.notes n
      LEFT JOIN notebooks.notes p ON p.id = n.parent_id AND p.notebook_id = n.notebook_id
      WHERE n.id = ANY(${idArray}) AND n.notebook_id = ${notebookId}::uuid
      ORDER BY n.created_at ASC, n.short_id ASC
    `,
    sql<{ source_short_id: string; target_short_id: string }[]>`
      SELECT src.short_id AS source_short_id, tgt.short_id AS target_short_id
      FROM notebooks.note_links nl
      JOIN notebooks.notes src ON src.id = nl.source_note_id
      JOIN notebooks.notes tgt ON tgt.id = nl.target_note_id
      WHERE nl.source_note_id = ANY(${idArray}) AND nl.target_note_id = ANY(${idArray})
      ORDER BY src.short_id, tgt.short_id
    `,
    // A page keeps the size its links in the whole notebook give it.
    sql<{ id: string; count: number }[]>`
      SELECT nl.target_note_id AS id, COUNT(*)::int AS count
      FROM notebooks.note_links nl
      JOIN notebooks.notes src ON src.id = nl.source_note_id AND src.notebook_id = ${notebookId}::uuid
      WHERE nl.target_note_id = ANY(${idArray})
      GROUP BY nl.target_note_id
    `,
  ]);
  const inDegree = new Map(inRows.map((row) => [row.id, row.count]));
  const around = noteRows.find((row) => row.id === params.noteId)?.short_id ?? "";
  return {
    nodes: noteRows.map((n) => ({
      id: n.short_id,
      title: n.title,
      inDegree: inDegree.get(n.id) ?? 0,
      parentId: n.parent_short_id,
      position: n.position,
      updatedAt: n.updated_at.toISOString(),
    })),
    edges: edgeRows.map((e) => ({ source: e.source_short_id, target: e.target_short_id })),
    scope: { around, total: params.total },
  };
};

/** The graph the Links page draws: the whole notebook while it is small, otherwise the pages around one page. */
export const buildNotebookGraphView = async (params: { notebookId: string; noteId: string | null }): Promise<NoteGraph> => {
  const [count] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM notebooks.notes WHERE notebook_id = ${params.notebookId}::uuid
  `;
  const total = count?.total ?? 0;
  if (total <= GRAPH_WHOLE_NOTES) return buildNotebookGraph(params);
  const noteId =
    params.noteId ??
    (
      await sql<{ id: string }[]>`
        SELECT id FROM notebooks.notes WHERE notebook_id = ${params.notebookId}::uuid AND parent_id IS NULL
        ORDER BY position, title, short_id LIMIT 1
      `
    )[0]?.id;
  return noteId ? buildNotebookGraphAround({ notebookId: params.notebookId, noteId, total }) : { nodes: [], edges: [] };
};
