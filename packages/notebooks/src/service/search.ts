import type { PaginationParams } from "@k2b/cloud/contracts";
import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import { buildNotebookVisibleAccessCondition, mayReadAcrossNotebooks } from "./access";
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
// Matches global Cloud search's two-character minimum, keeping one-letter keystrokes on exact lexemes instead of a near-full prefix scan.
const MIN_PREFIX_LENGTH = 2;
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

export const normalizeFilters = (filters: SearchFilters) => ({
  query: filters.query?.trim() ?? "",
  tags: [...new Set((filters.tags ?? []).map((tag) => tag.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))],
  createdAfter: filters.createdAfter ?? null,
  createdBefore: filters.createdBefore ?? null,
  updatedAfter: filters.updatedAfter ?? null,
  updatedBefore: filters.updatedBefore ?? null,
});

/** Only a plain last word of at least two letters/digits gets a prefix; anything else keeps websearch semantics. */
export const splitPrefixQuery = (query: string): { rest: string; prefix: string | null } => {
  const tokens = query.split(/\s+/);
  const token = tokens.at(-1) ?? "";
  const word = token.normalize("NFC").replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
  if (
    !query ||
    (query.match(/"/g)?.length ?? 0) % 2 !== 0 ||
    token.includes('"') ||
    token.startsWith("-") ||
    /^-+$/.test(tokens.at(-2) ?? "") ||
    tokens.some((part) => part.toLowerCase() === "or") ||
    !/^[\p{L}\p{M}\p{N}]+$/u.test(word) ||
    [...word].length < MIN_PREFIX_LENGTH
  ) {
    return { rest: query, prefix: null };
  }
  return { rest: query.slice(0, -token.length).trim(), prefix: `${word}:*` };
};

export const buildTextQuery = (query: string) => {
  const { rest, prefix } = splitPrefixQuery(query);
  // Union with the original websearch query so prefix matching keeps every old match.
  return prefix === null
    ? sql`websearch_to_tsquery('simple', ${query})`
    : sql`(websearch_to_tsquery('simple', ${query}) || (websearch_to_tsquery('simple', ${rest}) && to_tsquery('simple', ${prefix})))`;
};

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

export const searchCondition = (filters: ReturnType<typeof normalizeFilters>, notebookId?: string) => {
  let condition = sql`
    ${filters.query ? sql`n.search_document @@ ${buildTextQuery(filters.query)}` : sql`true`}
    AND ${filters.createdAfter ? sql`n.created_at >= ${filters.createdAfter}::timestamptz` : sql`true`}
    AND ${filters.createdBefore ? sql`n.created_at <= ${filters.createdBefore}::timestamptz` : sql`true`}
    AND ${filters.updatedAfter ? sql`n.updated_at >= ${filters.updatedAfter}::timestamptz` : sql`true`}
    AND ${filters.updatedBefore ? sql`n.updated_at <= ${filters.updatedBefore}::timestamptz` : sql`true`}
  `;
  for (const tag of filters.tags) {
    condition = sql`${condition} AND n.id IN (
      SELECT nt.note_id FROM notebooks.note_tags nt
      WHERE nt.tag = ${tag} AND ${notebookId ? sql`nt.notebook_id = ${notebookId}::uuid` : sql`true`}
    )`;
  }
  return condition;
};

export const searchPageQuery = (params: {
  filters: ReturnType<typeof normalizeFilters>;
  condition: ReturnType<typeof searchCondition>;
  pagination: PaginationParams;
  backend: SearchBackend;
}) => {
  const { filters } = params;
  const textQuery = buildTextQuery(filters.query);
  const bm25 = params.backend === "bm25" && Boolean(filters.query);
  const ranking = filters.query
    ? sql`lower(n.title) = lower(${filters.query}) AS sort_exact,
        starts_with(lower(n.title), lower(${filters.query})) AS sort_prefix,
        ${
          bm25
            ? sql`(COALESCE(n.title, '') || ' ' || COALESCE(n.title, '') || ' ' || COALESCE(n.content_md, ''))
                <@> to_bm25query(${filters.query}, ${BM25_INDEX})`
            : sql`0`
        } AS sort_bm25,
        ts_rank_cd(n.search_document, ${textQuery}) AS sort_rank,`
    : sql``;
  const order = filters.query
    ? sql`sort_exact DESC, sort_prefix DESC, sort_bm25, sort_rank DESC, sort_updated_at DESC, sort_id ASC`
    : sql`sort_updated_at DESC, sort_id ASC`;

  // The materialized page is the boundary for content reads, child lookups and headlines.
  // Empty searches have no rank expressions, so the updated_at index supplies their order.
  return sql<DbSearchHit[]>`
    WITH page AS MATERIALIZED (
      SELECT n.id AS sort_id, n.updated_at AS sort_updated_at, ${ranking} n.notebook_id
      FROM notebooks.notes n
      WHERE ${params.condition}
      ORDER BY ${order}
      LIMIT ${params.pagination.perPage} OFFSET ${params.pagination.offset}
    )
    SELECT
      n.id, n.short_id, n.notebook_id, n.parent_id, n.title, n.position,
      n.yjs_history_incomplete, n.yjs_snapshot_at, n.content_md, n.created_by, n.created_at, n.updated_at, n.locked_at,
      EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = n.id) AS has_children,
      nb.short_id AS notebook_short_id, nb.name AS notebook_name, nb.icon AS notebook_icon,
      ${
        filters.query
          ? sql`LEFT(ts_headline('simple', COALESCE(n.content_md, ''), ${textQuery}, ${HEADLINE_OPTIONS}), 360)`
          : sql`NULL::text`
      } AS snippet
    FROM page
    JOIN notebooks.notes n ON n.id = page.sort_id
    JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
    ORDER BY ${order}
  `;
};

const searchWithCondition = async (params: {
  notebookId?: string;
  filters: SearchFilters;
  condition: ReturnType<typeof searchCondition>;
  pagination: PaginationParams;
}): Promise<{ hits: SearchHit[]; total: number }> => {
  const filters = normalizeFilters(params.filters);
  const condition = sql`(${params.condition}) AND ${searchCondition(filters, params.notebookId)}`;
  const backend = await getSearchBackend();
  const rowsPromise = searchPageQuery({ ...params, filters, condition, backend }).catch((error) => {
    if (backend !== "bm25" || !isBm25CapabilityError(error)) throw error;
    log.warn("BM25 query failed; falling back to native PostgreSQL FTS", {
      error: error instanceof Error ? error.message : String(error),
    });
    backendPromise = Promise.resolve("native");
    return searchPageQuery({ ...params, filters, condition, backend: "native" });
  });
  const [rows, counts] = await Promise.all([
    rowsPromise,
    sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM notebooks.notes n WHERE ${condition}`,
  ]);
  return { hits: rows.map(mapHit), total: counts[0]?.count ?? 0 };
};

export const searchInNotebook = async (params: {
  notebookId: string;
  filters: SearchFilters;
  pagination: PaginationParams;
}): Promise<{ hits: SearchHit[]; total: number }> =>
  searchWithCondition({ ...params, condition: sql`n.notebook_id = ${params.notebookId}::uuid` });

export const searchAcross = async (params: {
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  notebookId?: string;
  filters: SearchFilters;
  pagination: PaginationParams;
}): Promise<{ hits: SearchHit[]; total: number }> => {
  if (!(await mayReadAcrossNotebooks(params))) return { hits: [], total: 0 };
  if (params.boundNotebookId && params.notebookId && params.boundNotebookId !== params.notebookId) {
    return { hits: [], total: 0 };
  }
  const principalMatch = buildNotebookVisibleAccessCondition({
    userId: params.userId,
    serviceAccountId: params.serviceAccountId,
  });
  const notebookId = params.notebookId ?? params.boundNotebookId ?? undefined;
  return searchWithCondition({
    ...params,
    notebookId,
    condition: sql`
      ${notebookId ? sql`n.notebook_id = ${notebookId}::uuid` : sql`true`}
      AND EXISTS (
        SELECT 1 FROM notebooks.notebook_access na JOIN auth.access a ON a.id = na.access_id
        WHERE na.notebook_id = n.notebook_id AND ${principalMatch}
      )
    `,
  });
};
