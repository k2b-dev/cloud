import { escapeLikePattern, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { DocumentCatalogSort } from "../api/document-public-contracts";
import type { Document, DocumentFolder, DocumentSummary, DocumentSummaryList } from "../contracts";
import { type DocumentDbRow, hydrateDocumentSummaries } from "./document-mappers";
import { decodeDocumentCursor, encodeDocumentCursor, normalizeDocumentTags } from "./document-values";

const summaryColumns = sql`id, short_id, template_id, workflow_run_id, snapshot_id, base_id, table_id, record_id,
  document_number, filename, primary_artifact_key, tags, profile_id, profile_version, validation_status, created_by, created_at`;

type DocumentPage = {
  items: DocumentSummary[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  nextCursor: string | null;
};

type DocumentBrowsePage = {
  path: string[];
  folders: DocumentFolder[];
  items: DocumentSummary[];
  total?: number;
  limit?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
};

export type DocumentReadAuthorizer = (document: Pick<Document, "baseId" | "tableId" | "templateId">) => Promise<boolean>;

/** Presentation metadata for an already-authorized, bounded document page.
 * Never load rows or re-query the live source to describe a frozen export. */
export const loadDocumentDataSnapshots = async (documentIds: readonly string[]) => {
  if (documentIds.length === 0) return new Map<string, { rowCount: number; capturedAt: string }>();
  const rows = await sql<Array<{ id: string; row_count: number; captured_at: Date }>>`
    SELECT document.id::text, data.row_count, data.captured_at
    FROM grids.documents document
    JOIN grids.workflow_query_data data ON data.id = document.query_data_id
    WHERE document.id = ANY(${toPgUuidArray([...documentIds])}::uuid[])
  `;
  return new Map(
    rows.map((row) => {
      return [row.id, { rowCount: row.row_count, capturedAt: row.captured_at.toISOString() }] as const;
    }),
  );
};

/** Public workflow and run IDs of the runs that generated a bounded page of Documents. */
export const loadDocumentWorkflowOrigins = async (workflowRunIds: readonly string[]) => {
  if (workflowRunIds.length === 0) return new Map<string, { workflowId: string; runId: string }>();
  const rows = await sql<Array<{ run_id: string; run_short_id: string; workflow_short_id: string }>>`
    SELECT run.run_id::text, run.short_id AS run_short_id, workflow.short_id AS workflow_short_id
    FROM grids.workflow_run_profile run
    JOIN grids.workflow_profile workflow ON workflow.id = run.workflow_id
    WHERE run.run_id = ANY(${toPgUuidArray([...new Set(workflowRunIds)])}::uuid[])
  `;
  return new Map(rows.map((row) => [row.run_id, { workflowId: row.workflow_short_id, runId: row.run_short_id }] as const));
};

type WorkflowRunDocumentScope = {
  tableId: string | null;
  templateId: string | null;
};

export const loadReadableWorkflowRunDocumentScopes = async (
  workflowRunId: string,
  canRead: DocumentReadAuthorizer,
): Promise<WorkflowRunDocumentScope[]> => {
  const scopes = await sql<Array<{ base_id: string; table_id: string | null; template_id: string | null }>>`
    SELECT DISTINCT base_id, table_id, template_id
    FROM grids.documents
    WHERE workflow_run_id = ${workflowRunId}::uuid
  `;
  return (
    await Promise.all(
      scopes.map(async (scope) => ({
        tableId: scope.table_id,
        templateId: scope.template_id,
        allowed: await canRead({
          baseId: scope.base_id,
          tableId: scope.table_id,
          templateId: scope.template_id,
        }),
      })),
    )
  )
    .filter((scope) => scope.allowed)
    .map(({ tableId, templateId }) => ({ tableId, templateId }));
};

export const workflowRunDocumentAccessWhere = (allowed: WorkflowRunDocumentScope[]) => {
  if (allowed.length === 0) return sql`FALSE`;
  return allowed
    .map(
      (scope) => sql`(table_id IS NOT DISTINCT FROM ${scope.tableId}::uuid AND template_id IS NOT DISTINCT FROM ${scope.templateId}::uuid)`,
    )
    .reduce((where, scope) => sql`${where} OR ${scope}`);
};

const listDocuments = async (params: {
  baseId: string;
  tableId?: string;
  recordId?: string;
  templateId?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: DocumentSummary[]; nextCursor: string | null; hasMore: boolean }> => {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const cursor = decodeDocumentCursor(params.cursor);
  const scope = params.recordId
    ? sql`id IN (
        SELECT id FROM grids.documents WHERE table_id = ${params.tableId ?? null}::uuid AND record_id = ${params.recordId}::uuid
        UNION
        SELECT document_id FROM grids.document_record_sources
        WHERE table_id = ${params.tableId ?? null}::uuid AND record_id = ${params.recordId}::uuid
      )`
    : sql`(${params.tableId ?? null}::uuid IS NULL OR table_id = ${params.tableId ?? null}::uuid)`;
  const rows = await sql<DocumentDbRow[]>`
    SELECT ${summaryColumns} FROM grids.documents
    WHERE base_id = ${params.baseId}::uuid
      AND ${scope}
      AND (${params.templateId ?? null}::uuid IS NULL OR template_id = ${params.templateId ?? null}::uuid)
      AND (
        ${cursor?.createdAt ?? null}::timestamptz IS NULL
        OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const items = await hydrateDocumentSummaries(rows.slice(0, limit));
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeDocumentCursor(last) : null, hasMore };
};

export const listDocumentsForRecord = (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  templateId?: string;
  limit?: number;
  cursor?: string | null;
}) => listDocuments(params);

export const listDocumentSummariesForRecordByTemplates = async (
  tableId: string,
  recordId: string,
  templateIds: string[],
  limit = 100,
): Promise<DocumentSummary[]> => {
  if (templateIds.length === 0) return [];
  const cap = Math.min(Math.max(limit, 1), 100);
  const rows = await sql<DocumentDbRow[]>`
    SELECT ${summaryColumns}
    FROM grids.documents
    WHERE table_id = ${tableId}::uuid
      AND record_id = ${recordId}::uuid
      AND template_id = ANY(${toPgUuidArray(templateIds)}::uuid[])
    ORDER BY created_at DESC, id DESC
    LIMIT ${cap}
  `;
  return hydrateDocumentSummaries(rows);
};

export const listDocumentsForWorkflow = async (
  workflowRunId: string,
  params: { limit?: number; offset?: number },
  canRead: DocumentReadAuthorizer,
): Promise<DocumentSummaryList> => {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const accessWhere = workflowRunDocumentAccessWhere(await loadReadableWorkflowRunDocumentScopes(workflowRunId, canRead));
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM grids.documents
    WHERE workflow_run_id = ${workflowRunId}::uuid
      AND (${accessWhere})
  `;
  const rows = await sql<DocumentDbRow[]>`
    SELECT ${summaryColumns} FROM grids.documents
    WHERE workflow_run_id = ${workflowRunId}::uuid
      AND (${accessWhere})
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  const nextOffset = offset + rows.length;
  const total = count ?? 0;
  return {
    items: await hydrateDocumentSummaries(rows),
    total,
    limit,
    offset,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
};

/** Public IDs that narrow the Base-wide catalog. Every present filter must match. */
export type DocumentCatalogFilters = {
  /** Every Document generated by a run of this workflow, with or without a template. */
  workflowId?: string | null;
  templateId?: string | null;
  /** Direct association only: the Document's own table, not tables of its source records or archive contents. */
  tableId?: string | null;
  /** Media type of the Document's primary artifact. */
  mediaType?: string | null;
};

const hasCatalogFilters = (filters: DocumentCatalogFilters | undefined): boolean =>
  Boolean(filters?.workflowId || filters?.templateId || filters?.tableId || filters?.mediaType);

type DocumentScope =
  | { templateId: string; baseId?: never; templateShortId?: never; filters?: never }
  | { baseId: string; templateId?: never; templateShortId?: string; filters?: DocumentCatalogFilters };

const catalogFilterConditions = (baseId: string, filters: DocumentCatalogFilters | undefined) => {
  const conditions = [];
  if (filters?.workflowId) {
    conditions.push(sql`workflow_run_id IN (
      SELECT run.run_id FROM grids.workflow_run_profile run
      JOIN grids.workflow_profile workflow ON workflow.id = run.workflow_id
      WHERE workflow.short_id = ${filters.workflowId} AND run.base_id = ${baseId}::uuid
    )`);
  }
  if (filters?.templateId) {
    conditions.push(sql`template_id IN (SELECT id FROM grids.document_templates WHERE short_id = ${filters.templateId})`);
  }
  if (filters?.tableId) {
    conditions.push(sql`table_id IN (SELECT id FROM grids.tables WHERE short_id = ${filters.tableId} AND base_id = ${baseId}::uuid)`);
  }
  if (filters?.mediaType) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM grids.document_artifacts artifact
      JOIN grids.files file ON file.id = artifact.file_id
      WHERE artifact.document_id = grids.documents.id
        AND artifact.artifact_key = grids.documents.primary_artifact_key
        AND file.mime_type = ${filters.mediaType}
    )`);
  }
  return conditions;
};

const documentWhere = (
  params: DocumentScope & {
    q?: string | null;
    tags?: string[];
    year?: number | null;
    month?: number | null;
    timeZone?: string | null;
  },
) => {
  const timeZone = params.timeZone || "UTC";
  const conditions = params.baseId
    ? [sql`base_id = ${params.baseId}::uuid`, ...catalogFilterConditions(params.baseId, params.filters)]
    : [sql`template_id = ${params.templateId}::uuid`];
  if (params.templateShortId?.startsWith("workflow:")) {
    const workflowShortId = params.templateShortId.slice("workflow:".length);
    conditions.push(sql`template_id IS NULL AND workflow_run_id IN (
      SELECT run.run_id FROM grids.workflow_run_profile run
      JOIN grids.workflow_profile workflow ON workflow.id = run.workflow_id AND workflow.base_id = run.base_id
      WHERE workflow.short_id = ${workflowShortId}
    )`);
  } else if (params.templateShortId) {
    conditions.push(sql`template_id IN (SELECT id FROM grids.document_templates WHERE short_id = ${params.templateShortId})`);
  }
  const q = params.q?.trim();
  if (q) {
    const pattern = `%${escapeLikePattern(q)}%`;
    const escape = "\\";
    conditions.push(sql`(
      filename ILIKE ${pattern} ESCAPE ${escape}
      OR document_number ILIKE ${pattern} ESCAPE ${escape}
      OR EXISTS (SELECT 1 FROM unnest(tags) tag WHERE tag ILIKE ${pattern} ESCAPE ${escape})
    )`);
  }
  const tags = normalizeDocumentTags(params.tags);
  if (tags.length > 0) conditions.push(sql`tags @> ${sql.array(tags, "TEXT")}`);
  if (params.year) conditions.push(sql`EXTRACT(YEAR FROM created_at AT TIME ZONE ${timeZone})::int = ${params.year}`);
  if (params.month) conditions.push(sql`EXTRACT(MONTH FROM created_at AT TIME ZONE ${timeZone})::int = ${params.month}`);
  return conditions.reduce((acc, cur) => sql`${acc} AND ${cur}`);
};

/** A cursor from a filename-sorted page carries the filename keyset; other orders use creation time. */
export const documentCursorMatchesSort = (cursor: string | null | undefined, sort: DocumentCatalogSort): boolean => {
  const decoded = decodeDocumentCursor(cursor);
  return decoded === null || (sort === "name") === (decoded.filename !== undefined);
};

const documentOrder = (sort: DocumentCatalogSort) => {
  if (sort === "oldest") return sql`created_at ASC, id ASC`;
  if (sort === "name") return sql`filename ASC, id ASC`;
  return sql`created_at DESC, id DESC`;
};

const afterDocumentCursor = (cursor: NonNullable<ReturnType<typeof decodeDocumentCursor>>, sort: DocumentCatalogSort) => {
  if (sort === "oldest") return sql`(created_at, id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
  if (sort === "name") {
    if (cursor.filename === undefined) throw new Error("Document cursor does not belong to a filename-sorted page");
    return sql`(filename, id) > (${cursor.filename}, ${cursor.id}::uuid)`;
  }
  return sql`(created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
};

const listDocumentPage = async (
  params: DocumentScope & {
    q?: string | null;
    tags?: string[];
    limit?: number;
    offset?: number;
    cursor?: string | null;
    year?: number | null;
    month?: number | null;
    timeZone?: string | null;
    sort?: DocumentCatalogSort;
  },
): Promise<DocumentPage> => {
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const sort = params.sort ?? "newest";
  const cursor = decodeDocumentCursor(params.cursor);
  const baseWhere = documentWhere(params);
  const where = cursor ? sql`${baseWhere} AND ${afterDocumentCursor(cursor, sort)}` : baseWhere;
  const [countRow] = await sql<Array<{ total: number | string }>>`
    SELECT COUNT(*)::int AS total
    FROM grids.documents
    WHERE ${baseWhere}
  `;
  const rows = await sql<DocumentDbRow[]>`
    SELECT ${summaryColumns}
    FROM grids.documents
    WHERE ${where}
    ORDER BY ${documentOrder(sort)}
    LIMIT ${limit + 1}
    OFFSET ${cursor ? 0 : offset}
  `;
  const hasMore = rows.length > limit;
  const items = await hydrateDocumentSummaries(rows.slice(0, limit));
  const total = Number(countRow?.total ?? items.length);
  const nextOffset = offset + items.length;
  const last = items.at(-1);
  return {
    items,
    total,
    limit,
    offset: cursor ? 0 : offset,
    hasMore,
    nextOffset: hasMore && !cursor ? nextOffset : null,
    nextCursor: hasMore && last ? encodeDocumentCursor(last, sort === "name" ? last.filename : undefined) : null,
  };
};

export const listDocumentsForTemplate = (params: Extract<Parameters<typeof listDocumentPage>[0], { templateId: string }>) =>
  listDocumentPage(params);

/**
 * The Base-wide catalog as one flat page: search, combinable filters and sort.
 * Base read permission is checked by API/SSR callers.
 */
export const listDocumentsForBase = (params: {
  baseId: string;
  q?: string | null;
  filters?: DocumentCatalogFilters;
  sort?: DocumentCatalogSort;
  limit?: number;
  cursor?: string | null;
}) => listDocumentPage(params);

/** Browses folders by template/workflow and year until a search, filter, non-default sort or list mode flattens the catalog.
 * Base permission is checked by API/SSR callers. */
export const browseDocumentsForBase = async (params: {
  baseId: string;
  q?: string;
  path?: string[];
  mode?: "list" | "folders";
  filters?: DocumentCatalogFilters;
  sort?: DocumentCatalogSort;
  limit?: number;
  cursor?: string | null;
  timeZone?: string;
}): Promise<DocumentBrowsePage> => {
  const path = params.path ?? [];
  const flat =
    Boolean(params.q?.trim()) || params.mode === "list" || hasCatalogFilters(params.filters) || (params.sort ?? "newest") !== "newest";
  const templateShortId = flat ? undefined : path[0];
  const year = templateShortId && path[1] ? Number(path[1]) : null;
  if (flat || year !== null) {
    const page = await listDocumentPage({ ...params, templateShortId, year });
    return { ...page, path: flat ? [] : path, folders: [] };
  }
  const where = documentWhere({ baseId: params.baseId, templateShortId });
  if (!templateShortId) {
    const rows = await sql<Array<{ kind: "template" | "workflow"; short_id: string; name: string; count: number }>>`
      SELECT 'template' AS kind, t.short_id, t.name, count(*)::int AS count
      FROM grids.documents d JOIN grids.document_templates t ON t.id = d.template_id
      WHERE d.base_id = ${params.baseId}::uuid
      GROUP BY t.id, t.short_id, t.name
      UNION ALL
      SELECT 'workflow' AS kind, 'workflow:' || workflow.short_id, definition.name, count(*)::int AS count
      FROM grids.documents d
      JOIN grids.workflow_run_profile run ON run.run_id = d.workflow_run_id AND run.base_id = d.base_id
      JOIN grids.workflow_profile workflow ON workflow.id = run.workflow_id AND workflow.base_id = run.base_id
      JOIN workflows.workflow definition ON definition.id = workflow.id
      WHERE d.base_id = ${params.baseId}::uuid AND d.template_id IS NULL
      GROUP BY workflow.id, workflow.short_id, definition.name
      ORDER BY name, short_id
    `;
    return {
      path: [],
      items: [],
      folders: rows.map((row) => ({
        kind: row.kind,
        key: row.short_id,
        label: row.name,
        path: [row.short_id],
        count: Number(row.count),
      })),
    };
  }
  const rows = await sql<Array<{ year: number; count: number }>>`
    SELECT EXTRACT(YEAR FROM created_at AT TIME ZONE ${params.timeZone || "UTC"})::int AS year, count(*)::int AS count
    FROM grids.documents WHERE ${where} GROUP BY year ORDER BY year DESC
  `;
  return {
    path,
    items: [],
    folders: rows.map((row) => ({
      kind: "year",
      key: String(row.year),
      label: String(row.year),
      path: [templateShortId, String(row.year)],
      count: Number(row.count),
    })),
  };
};

type CatalogFacetRow = { id: string; name: string };

/**
 * Filter values that occur in a Base's Documents. The value lists grow with the
 * Base's workflows, templates, tables and output formats, not with its Documents.
 * Soft-deleted workflows, templates and tables stay listed while their Documents exist.
 */
export const loadDocumentCatalogFacets = async (baseId: string) => {
  const [workflows, templates, tables, mediaTypes] = await Promise.all([
    sql<CatalogFacetRow[]>`
      SELECT workflow.short_id AS id, definition.name
      FROM grids.workflow_profile workflow
      JOIN workflows.workflow definition ON definition.id = workflow.id
      WHERE workflow.base_id = ${baseId}::uuid
        AND EXISTS (
          SELECT 1 FROM grids.workflow_run_profile run
          JOIN grids.documents document ON document.workflow_run_id = run.run_id
          WHERE run.workflow_id = workflow.id
        )
      ORDER BY definition.name, workflow.short_id
    `,
    sql<CatalogFacetRow[]>`
      SELECT template.short_id AS id, template.name
      FROM grids.document_templates template
      JOIN grids.tables tbl ON tbl.id = template.table_id
      WHERE tbl.base_id = ${baseId}::uuid
        AND EXISTS (SELECT 1 FROM grids.documents document WHERE document.template_id = template.id)
      ORDER BY template.name, template.short_id
    `,
    sql<CatalogFacetRow[]>`
      SELECT tbl.short_id AS id, tbl.name
      FROM grids.tables tbl
      WHERE tbl.base_id = ${baseId}::uuid
        AND EXISTS (SELECT 1 FROM grids.documents document WHERE document.table_id = tbl.id)
      ORDER BY tbl.name, tbl.short_id
    `,
    sql<Array<{ media_type: string }>>`
      SELECT DISTINCT file.mime_type AS media_type
      FROM grids.documents document
      JOIN grids.document_artifacts artifact
        ON artifact.document_id = document.id AND artifact.artifact_key = document.primary_artifact_key
      JOIN grids.files file ON file.id = artifact.file_id
      WHERE document.base_id = ${baseId}::uuid
      ORDER BY media_type
    `,
  ]);
  return {
    workflows: [...workflows],
    templates: [...templates],
    tables: [...tables],
    mediaTypes: mediaTypes.map((row) => row.media_type),
  };
};

/**
 * One page of a ZIP Document's frozen contents: the files it packaged and the
 * Documents they came from. Provenance only; the contained records are not
 * associated with the archive. Other Documents have no contents.
 */
export const listDocumentArchiveContents = async (documentId: string, offset: number, limit: number) => {
  const [archive] = await sql<Array<{ total: number }>>`
    SELECT COALESCE(jsonb_array_length(profile_output->'entries'), 0)::int AS total
    FROM grids.documents
    WHERE id = ${documentId}::uuid AND profile_id = 'grids.zip'
  `;
  const total = archive?.total ?? 0;
  if (offset >= total) return { items: [], total, hasMore: false };
  const rows = await sql<Array<{ path: string; size_bytes: string | number; document_id: string; artifact_key: string }>>`
    SELECT entry->>'path' AS path, (entry->>'sizeBytes')::bigint AS size_bytes,
      entry->>'document' AS document_id, entry->>'key' AS artifact_key
    FROM grids.documents document
    CROSS JOIN LATERAL jsonb_array_elements(document.profile_output->'entries') WITH ORDINALITY AS contents(entry, position)
    WHERE document.id = ${documentId}::uuid
    ORDER BY contents.position
    LIMIT ${limit} OFFSET ${offset}
  `;
  return {
    items: rows.map((row) => ({
      path: row.path,
      sizeBytes: Number(row.size_bytes),
      documentId: row.document_id,
      artifactKey: row.artifact_key,
    })),
    total,
    hasMore: offset + rows.length < total,
  };
};

const runFolderPath = (path: readonly string[] | null | undefined): string[] =>
  (path ?? [])
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);

const monthKey = (month: number): string => String(month).padStart(2, "0");

export const browseDocumentsForTemplate = async (params: {
  templateId: string;
  q?: string | null;
  tags?: string[];
  path?: string[];
  limit?: number;
  cursor?: string | null;
  timeZone?: string | null;
  mode?: "list" | "folders";
}): Promise<DocumentBrowsePage> => {
  const path = runFolderPath(params.path);
  const q = params.q?.trim() ?? "";
  if (params.mode === "list" || q || path.length >= 2) {
    const year = path[0] ? Number(path[0]) : null;
    const month = path[1] ? Number(path[1]) : null;
    const page = await listDocumentsForTemplate({
      templateId: params.templateId,
      q,
      tags: params.tags,
      limit: params.limit,
      cursor: params.cursor,
      year: Number.isInteger(year) ? year : null,
      month: Number.isInteger(month) ? month : null,
      timeZone: params.timeZone,
    });
    return {
      path,
      folders: [],
      items: page.items,
      total: page.total,
      limit: page.limit,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  const timeZone = params.timeZone || "UTC";
  const where = documentWhere({ templateId: params.templateId, tags: params.tags, timeZone });
  if (path.length === 0) {
    const rows = await sql<Array<{ year: number | string; count: number | string }>>`
      SELECT EXTRACT(YEAR FROM created_at AT TIME ZONE ${timeZone})::int AS year, COUNT(*)::int AS count
      FROM grids.documents
      WHERE ${where}
      GROUP BY year
      ORDER BY year DESC
    `;
    return {
      path,
      folders: rows.map((row) => {
        const year = String(row.year);
        return { kind: "year", key: year, label: year, path: [year], count: Number(row.count) };
      }),
      items: [],
    };
  }

  const year = Number(path[0]);
  if (!Number.isInteger(year)) return { path: [], folders: [], items: [] };
  const yearWhere = documentWhere({ templateId: params.templateId, tags: params.tags, year, timeZone });
  const rows = await sql<Array<{ month: number | string; count: number | string }>>`
    SELECT EXTRACT(MONTH FROM created_at AT TIME ZONE ${timeZone})::int AS month, COUNT(*)::int AS count
    FROM grids.documents
    WHERE ${yearWhere}
    GROUP BY month
    ORDER BY month DESC
  `;
  return {
    path: [String(year)],
    folders: rows.map((row) => {
      const key = monthKey(Number(row.month));
      return { kind: "month", key, label: key, path: [String(year), key], count: Number(row.count) };
    }),
    items: [],
  };
};
