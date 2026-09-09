import type { PaginationParams } from "@k2b/cloud/contracts";
import { logger, toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { buildNotebookVisibleAccessCondition } from "./access";
import type { Note } from "./notes";

export type SearchFilters = {
  query?: string;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
};

export type SearchHit = {
  note: Note;
  notebook: {
    id: string;
    shortId: string;
    name: string;
    icon: string | null;
  };
  snippet: string | null;
};

type DbSearchHit = {
  id: string;
  short_id: string;
  notebook_id: string;
  parent_id: string | null;
  title: string;
  position: number;
  yjs_snapshot_at: Date | null;
  yjs_history_incomplete: boolean;
  content_md: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  locked_at: Date | null;
  has_children: boolean;
  notebook_short_id: string;
  notebook_name: string;
  notebook_icon: string | null;
  snippet: string | null;
};

type SearchBackend = "native" | "bm25";

const BM25_INDEX = "notebooks.notes_search_bm25_idx";
const HEADLINE_OPTIONS = "StartSel=\uE000, StopSel=\uE001, MaxWords=32, MinWords=12, MaxFragments=2, FragmentDelimiter= … ";
const BM25_CAPABILITY_ERROR_CODES = new Set(["0A000", "42704", "42883", "55000"]);
const log = logger("notebooks:search");

let backendPromise: Promise<SearchBackend> | null = null;

const detectBackend = async (): Promise<SearchBackend> => {
  const [row] = await sql<{ available: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch')
      AND to_regclass(${BM25_INDEX}) IS NOT NULL AS available
  `;
  const backend = row?.available ? "bm25" : "native";
  log.info("Search backend active", { backend });
  return backend;
};

export const getSearchBackend = (): Promise<SearchBackend> => {
  backendPromise ??= detectBackend().catch((error) => {
    log.warn("Search backend detection failed; using native PostgreSQL FTS", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "native";
  });
  return backendPromise;
};

/** Test and migration hook. Runtime callers should use `getSearchBackend()`. */
export const resetSearchBackend = (): void => {
  backendPromise = null;
};

/** Only capability failures may downgrade BM25. Integrity and connection
 * failures must stay visible instead of being hidden by a second query. */
export const isBm25CapabilityError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return BM25_CAPABILITY_ERROR_CODES.has(String(error.code));
};

const normalizeFilters = (filters: SearchFilters) => ({
  query: filters.query?.trim() ?? "",
  tags: [...new Set((filters.tags ?? []).map((tag) => tag.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))],
  createdAfter: filters.createdAfter ?? null,
  createdBefore: filters.createdBefore ?? null,
  updatedAfter: filters.updatedAfter ?? null,
  updatedBefore: filters.updatedBefore ?? null,
});

const mapHit = (row: DbSearchHit): SearchHit => ({
  note: {
    id: row.id,
    shortId: row.short_id,
    notebookId: row.notebook_id,
    parentId: row.parent_id,
    title: row.title,
    position: row.position,
    hasChildren: row.has_children,
    historyIncomplete: row.yjs_history_incomplete,
    yjsSnapshotAt: row.yjs_snapshot_at?.toISOString() ?? null,
    contentMd: row.content_md,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lockedAt: row.locked_at?.toISOString() ?? null,
  },
  notebook: {
    id: row.notebook_id,
    shortId: row.notebook_short_id,
    name: row.notebook_name,
    icon: row.notebook_icon,
  },
  snippet: row.snippet,
});

const searchInNotebookRows = async (params: {
  notebookId: string;
  filters: SearchFilters;
  pagination: PaginationParams;
  backend: SearchBackend;
}): Promise<DbSearchHit[]> => {
  const filters = normalizeFilters(params.filters);
  const { offset, perPage } = params.pagination;

  if (params.backend === "bm25" && filters.query) {
    return sql<DbSearchHit[]>`
      SELECT
        n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
        n.yjs_history_incomplete, n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
        EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = n.id) AS has_children,
        nb.short_id AS notebook_short_id, nb.name AS notebook_name, nb.icon AS notebook_icon,
        LEFT(ts_headline('simple', COALESCE(n.content_md, ''), websearch_to_tsquery('simple', ${filters.query}), ${HEADLINE_OPTIONS}), 360) AS snippet
      FROM notebooks.notes n
      JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
      WHERE n.notebook_id = ${params.notebookId}::uuid
        AND n.search_document @@ websearch_to_tsquery('simple', ${filters.query})
        AND (${filters.createdAfter}::timestamptz IS NULL OR n.created_at >= ${filters.createdAfter}::timestamptz)
        AND (${filters.createdBefore}::timestamptz IS NULL OR n.created_at <= ${filters.createdBefore}::timestamptz)
        AND (${filters.updatedAfter}::timestamptz IS NULL OR n.updated_at >= ${filters.updatedAfter}::timestamptz)
        AND (${filters.updatedBefore}::timestamptz IS NULL OR n.updated_at <= ${filters.updatedBefore}::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${toPgTextArray(filters.tags)}::text[]) wanted(tag)
          WHERE NOT EXISTS (
            SELECT 1 FROM notebooks.note_tags nt
            WHERE nt.note_id = n.id AND nt.tag = wanted.tag
          )
        )
      ORDER BY
        (COALESCE(n.title, '') || ' ' || COALESCE(n.title, '') || ' ' || COALESCE(n.content_md, ''))
          <@> to_bm25query(${filters.query}, ${BM25_INDEX}),
        n.updated_at DESC,
        n.id ASC
      LIMIT ${perPage} OFFSET ${offset}
    `;
  }

  return sql<DbSearchHit[]>`
    SELECT
      n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
      n.yjs_history_incomplete, n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
      EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = n.id) AS has_children,
      nb.short_id AS notebook_short_id, nb.name AS notebook_name, nb.icon AS notebook_icon,
      CASE
        WHEN ${filters.query} = '' THEN NULL
        ELSE LEFT(ts_headline('simple', COALESCE(n.content_md, ''), websearch_to_tsquery('simple', ${filters.query}), ${HEADLINE_OPTIONS}), 360)
      END AS snippet
    FROM notebooks.notes n
    JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
    WHERE n.notebook_id = ${params.notebookId}::uuid
      AND (${filters.query} = '' OR n.search_document @@ websearch_to_tsquery('simple', ${filters.query}))
      AND (${filters.createdAfter}::timestamptz IS NULL OR n.created_at >= ${filters.createdAfter}::timestamptz)
      AND (${filters.createdBefore}::timestamptz IS NULL OR n.created_at <= ${filters.createdBefore}::timestamptz)
      AND (${filters.updatedAfter}::timestamptz IS NULL OR n.updated_at >= ${filters.updatedAfter}::timestamptz)
      AND (${filters.updatedBefore}::timestamptz IS NULL OR n.updated_at <= ${filters.updatedBefore}::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(${toPgTextArray(filters.tags)}::text[]) wanted(tag)
        WHERE NOT EXISTS (
          SELECT 1 FROM notebooks.note_tags nt
          WHERE nt.note_id = n.id AND nt.tag = wanted.tag
        )
      )
    ORDER BY
      CASE WHEN ${filters.query} = '' THEN 0 ELSE ts_rank_cd(n.search_document, websearch_to_tsquery('simple', ${filters.query})) END DESC,
      n.updated_at DESC,
      n.id ASC
    LIMIT ${perPage} OFFSET ${offset}
  `;
};

const countInNotebook = async (params: { notebookId: string; filters: SearchFilters }): Promise<number> => {
  const filters = normalizeFilters(params.filters);
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.notes n
    WHERE n.notebook_id = ${params.notebookId}::uuid
      AND (${filters.query} = '' OR n.search_document @@ websearch_to_tsquery('simple', ${filters.query}))
      AND (${filters.createdAfter}::timestamptz IS NULL OR n.created_at >= ${filters.createdAfter}::timestamptz)
      AND (${filters.createdBefore}::timestamptz IS NULL OR n.created_at <= ${filters.createdBefore}::timestamptz)
      AND (${filters.updatedAfter}::timestamptz IS NULL OR n.updated_at >= ${filters.updatedAfter}::timestamptz)
      AND (${filters.updatedBefore}::timestamptz IS NULL OR n.updated_at <= ${filters.updatedBefore}::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(${toPgTextArray(filters.tags)}::text[]) wanted(tag)
        WHERE NOT EXISTS (
          SELECT 1 FROM notebooks.note_tags nt
          WHERE nt.note_id = n.id AND nt.tag = wanted.tag
        )
      )
  `;
  return row?.count ?? 0;
};

export const searchInNotebook = async (params: {
  notebookId: string;
  filters: SearchFilters;
  pagination: PaginationParams;
}): Promise<{ hits: SearchHit[]; total: number }> => {
  const backend = await getSearchBackend();
  const rowsPromise = searchInNotebookRows({ ...params, backend }).catch((error) => {
    if (backend !== "bm25" || !isBm25CapabilityError(error)) throw error;
    log.warn("BM25 query failed; falling back to native PostgreSQL FTS", {
      error: error instanceof Error ? error.message : String(error),
    });
    backendPromise = Promise.resolve("native");
    return searchInNotebookRows({ ...params, backend: "native" });
  });
  const [rows, total] = await Promise.all([rowsPromise, countInNotebook({ notebookId: params.notebookId, filters: params.filters })]);
  return { hits: rows.map(mapHit), total };
};

export const searchAcross = async (params: {
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  notebookId?: string;
  filters: SearchFilters;
  pagination: PaginationParams;
}): Promise<{ hits: SearchHit[]; total: number }> => {
  if (params.serviceAccountId && !params.boundNotebookId) return { hits: [], total: 0 };
  if (params.boundNotebookId && params.notebookId && params.boundNotebookId !== params.notebookId) {
    return { hits: [], total: 0 };
  }
  const filters = normalizeFilters(params.filters);
  const principalMatch = buildNotebookVisibleAccessCondition({
    userId: params.userId,
    serviceAccountId: params.serviceAccountId,
  });
  const notebookId = params.notebookId ?? params.boundNotebookId ?? null;
  const { offset, perPage } = params.pagination;
  const backend = await getSearchBackend();

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.notes n
    JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
    WHERE (${notebookId}::uuid IS NULL OR nb.id = ${notebookId}::uuid)
      AND EXISTS (
        SELECT 1
        FROM notebooks.notebook_access na
        JOIN auth.access a ON a.id = na.access_id
        WHERE na.notebook_id = nb.id
          AND ${principalMatch}
      )
      AND (${filters.query} = '' OR n.search_document @@ websearch_to_tsquery('simple', ${filters.query}))
      AND (${filters.createdAfter}::timestamptz IS NULL OR n.created_at >= ${filters.createdAfter}::timestamptz)
      AND (${filters.createdBefore}::timestamptz IS NULL OR n.created_at <= ${filters.createdBefore}::timestamptz)
      AND (${filters.updatedAfter}::timestamptz IS NULL OR n.updated_at >= ${filters.updatedAfter}::timestamptz)
      AND (${filters.updatedBefore}::timestamptz IS NULL OR n.updated_at <= ${filters.updatedBefore}::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(${toPgTextArray(filters.tags)}::text[]) wanted(tag)
        WHERE NOT EXISTS (
          SELECT 1 FROM notebooks.note_tags nt
          WHERE nt.note_id = n.id AND nt.tag = wanted.tag
        )
      )
  `;

  const select =
    backend === "bm25" && filters.query
      ? sql<DbSearchHit[]>`
        SELECT
          n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
          n.yjs_history_incomplete, n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
          EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = n.id) AS has_children,
          nb.short_id AS notebook_short_id, nb.name AS notebook_name, nb.icon AS notebook_icon,
          LEFT(ts_headline('simple', COALESCE(n.content_md, ''), websearch_to_tsquery('simple', ${filters.query}), ${HEADLINE_OPTIONS}), 360) AS snippet
        FROM notebooks.notes n
        JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
        WHERE (${notebookId}::uuid IS NULL OR nb.id = ${notebookId}::uuid)
          AND EXISTS (
            SELECT 1 FROM notebooks.notebook_access na JOIN auth.access a ON a.id = na.access_id
            WHERE na.notebook_id = nb.id AND ${principalMatch}
          )
          AND n.search_document @@ websearch_to_tsquery('simple', ${filters.query})
          AND (${filters.createdAfter}::timestamptz IS NULL OR n.created_at >= ${filters.createdAfter}::timestamptz)
          AND (${filters.createdBefore}::timestamptz IS NULL OR n.created_at <= ${filters.createdBefore}::timestamptz)
          AND (${filters.updatedAfter}::timestamptz IS NULL OR n.updated_at >= ${filters.updatedAfter}::timestamptz)
          AND (${filters.updatedBefore}::timestamptz IS NULL OR n.updated_at <= ${filters.updatedBefore}::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM unnest(${toPgTextArray(filters.tags)}::text[]) wanted(tag)
            WHERE NOT EXISTS (SELECT 1 FROM notebooks.note_tags nt WHERE nt.note_id = n.id AND nt.tag = wanted.tag)
          )
        ORDER BY
          (COALESCE(n.title, '') || ' ' || COALESCE(n.title, '') || ' ' || COALESCE(n.content_md, ''))
            <@> to_bm25query(${filters.query}, ${BM25_INDEX}),
          n.updated_at DESC,
          n.id ASC
        LIMIT ${perPage} OFFSET ${offset}
      `
      : sql<DbSearchHit[]>`
        SELECT
          n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
          n.yjs_history_incomplete, n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
          EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = n.id) AS has_children,
          nb.short_id AS notebook_short_id, nb.name AS notebook_name, nb.icon AS notebook_icon,
          CASE WHEN ${filters.query} = '' THEN NULL
            ELSE LEFT(ts_headline('simple', COALESCE(n.content_md, ''), websearch_to_tsquery('simple', ${filters.query}), ${HEADLINE_OPTIONS}), 360)
          END AS snippet
        FROM notebooks.notes n
        JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
        WHERE (${notebookId}::uuid IS NULL OR nb.id = ${notebookId}::uuid)
          AND EXISTS (
            SELECT 1 FROM notebooks.notebook_access na JOIN auth.access a ON a.id = na.access_id
            WHERE na.notebook_id = nb.id AND ${principalMatch}
          )
          AND (${filters.query} = '' OR n.search_document @@ websearch_to_tsquery('simple', ${filters.query}))
          AND (${filters.createdAfter}::timestamptz IS NULL OR n.created_at >= ${filters.createdAfter}::timestamptz)
          AND (${filters.createdBefore}::timestamptz IS NULL OR n.created_at <= ${filters.createdBefore}::timestamptz)
          AND (${filters.updatedAfter}::timestamptz IS NULL OR n.updated_at >= ${filters.updatedAfter}::timestamptz)
          AND (${filters.updatedBefore}::timestamptz IS NULL OR n.updated_at <= ${filters.updatedBefore}::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM unnest(${toPgTextArray(filters.tags)}::text[]) wanted(tag)
            WHERE NOT EXISTS (SELECT 1 FROM notebooks.note_tags nt WHERE nt.note_id = n.id AND nt.tag = wanted.tag)
          )
        ORDER BY
          CASE WHEN ${filters.query} = '' THEN 0 ELSE ts_rank_cd(n.search_document, websearch_to_tsquery('simple', ${filters.query})) END DESC,
          n.updated_at DESC,
          n.id ASC
        LIMIT ${perPage} OFFSET ${offset}
      `;

  let rows: DbSearchHit[];
  try {
    rows = await select;
  } catch (error) {
    if (backend !== "bm25" || !isBm25CapabilityError(error)) throw error;
    log.warn("BM25 query failed; falling back to native PostgreSQL FTS", {
      error: error instanceof Error ? error.message : String(error),
    });
    backendPromise = Promise.resolve("native");
    return searchAcross(params);
  }
  return { hits: rows.map(mapHit), total: countRow?.count ?? 0 };
};
