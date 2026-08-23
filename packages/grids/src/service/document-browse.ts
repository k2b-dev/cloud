import { escapeLikePattern, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { Document, DocumentFolder, DocumentSummary, DocumentSummaryList } from "../contracts";
import { type DocumentDbRow, hydrateDocuments, summarizeDocument } from "./document-mappers";
import { decodeDocumentCursor, encodeDocumentCursor, normalizeDocumentTags } from "./document-values";

type DocumentPage = {
  items: Document[];
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
  items: Document[];
  total?: number;
  limit?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
};

export type DocumentReadAuthorizer = (document: Pick<Document, "baseId" | "tableId" | "templateId">) => Promise<boolean>;

type WorkflowRunDocumentScope = {
  tableId: string;
  templateId: string;
};

export const loadReadableWorkflowRunDocumentScopes = async (
  workflowRunId: string,
  canRead: DocumentReadAuthorizer,
): Promise<WorkflowRunDocumentScope[]> => {
  const scopes = await sql<Array<{ base_id: string; table_id: string; template_id: string }>>`
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
    .map((scope) => sql`(table_id = ${scope.tableId}::uuid AND template_id = ${scope.templateId}::uuid)`)
    .reduce((where, scope) => sql`${where} OR ${scope}`);
};

export const listDocuments = async (params: {
  baseId: string;
  tableId?: string;
  recordId?: string;
  templateId?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: Document[]; nextCursor: string | null; hasMore: boolean }> => {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const cursor = decodeDocumentCursor(params.cursor);
  const rows = await sql<DocumentDbRow[]>`
    SELECT * FROM grids.documents
    WHERE base_id = ${params.baseId}::uuid
      AND (${params.tableId ?? null}::uuid IS NULL OR table_id = ${params.tableId ?? null}::uuid)
      AND (${params.recordId ?? null}::uuid IS NULL OR record_id = ${params.recordId ?? null}::uuid)
      AND (${params.templateId ?? null}::uuid IS NULL OR template_id = ${params.templateId ?? null}::uuid)
      AND (
        ${cursor?.createdAt ?? null}::timestamptz IS NULL
        OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const items = await hydrateDocuments(rows.slice(0, limit));
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeDocumentCursor(last) : null, hasMore };
};

export const listDocumentsForBase = (params: { baseId: string; limit?: number; cursor?: string | null }) => listDocuments(params);

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
    SELECT *
    FROM grids.documents
    WHERE table_id = ${tableId}::uuid
      AND record_id = ${recordId}::uuid
      AND template_id = ANY(${toPgUuidArray(templateIds)}::uuid[])
    ORDER BY created_at DESC, id DESC
    LIMIT ${cap}
  `;
  return (await hydrateDocuments(rows)).map(summarizeDocument);
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
    SELECT * FROM grids.documents
    WHERE workflow_run_id = ${workflowRunId}::uuid
      AND (${accessWhere})
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  const nextOffset = offset + rows.length;
  const total = count ?? 0;
  return {
    items: (await hydrateDocuments(rows)).map(summarizeDocument),
    total,
    limit,
    offset,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
};

const documentWhere = (params: {
  templateId: string;
  q?: string | null;
  tags?: string[];
  year?: number | null;
  month?: number | null;
  timeZone?: string | null;
}) => {
  const timeZone = params.timeZone || "UTC";
  const conditions = [sql`template_id = ${params.templateId}::uuid`];
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

export const listDocumentsForTemplate = async (params: {
  templateId: string;
  q?: string | null;
  tags?: string[];
  limit?: number;
  offset?: number;
  cursor?: string | null;
  year?: number | null;
  month?: number | null;
  timeZone?: string | null;
}): Promise<DocumentPage> => {
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const cursor = decodeDocumentCursor(params.cursor);
  const baseWhere = documentWhere(params);
  const where = cursor ? sql`${baseWhere} AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : baseWhere;
  const [countRow] = await sql<Array<{ total: number | string }>>`
    SELECT COUNT(*)::int AS total
    FROM grids.documents
    WHERE ${baseWhere}
  `;
  const rows = await sql<DocumentDbRow[]>`
    SELECT *
    FROM grids.documents
    WHERE ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
    OFFSET ${cursor ? 0 : offset}
  `;
  const hasMore = rows.length > limit;
  const items = await hydrateDocuments(rows.slice(0, limit));
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
    nextCursor: hasMore && last ? encodeDocumentCursor(last) : null,
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
