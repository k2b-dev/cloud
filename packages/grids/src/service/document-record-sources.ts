import { err } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import type { WorkflowDocumentDataCapture } from "../workflows/query-contracts";
import { documentServiceText } from "./document-messages";
import { DocumentSourceVersionsSchema } from "./document-source-versions";
import type { ExpansionViewer } from "./relation-access";
import { buildRelationLabelCacheForIds } from "./relation-labels";

/** Only row-preserving, single-table captures imply membership. A joined
 * address or an aggregate result is not an implicit document recipient. */
export const capturedDocumentRecords = (payload: WorkflowDocumentDataCapture["payload"]) => {
  if (payload.version !== 1) return null;
  const query = parseGridsQueryDsl(payload.source);
  if (
    !query.ok ||
    query.ast.source?.kind !== "table" ||
    query.ast.joins.length ||
    query.ast.groupBy.length ||
    query.ast.aggregations.length
  )
    return null;
  if (payload.rowOrigins.length === 0) return [];
  const unique = new Map(payload.rowOrigins.map((row) => [`${row.tableId}:${row.recordId}`, row]));
  if (payload.rowOrigins.some((row) => unique.get(`${row.tableId}:${row.recordId}`)?.version !== row.version)) return null;
  const parsed = DocumentSourceVersionsSchema.safeParse([...unique.values()]);
  return parsed.success ? parsed.data : null;
};

export const loadDocumentRecordCounts = async (ids: string[]) => {
  if (!ids.length) return new Map<string, number>();
  const rows = await sql<Array<{ id: string; count: number }>>`
    SELECT d.id::text AS id, count(source.record_id)::int AS count FROM grids.documents d
    LEFT JOIN grids.document_record_sources source ON source.document_id = d.id
    WHERE d.id = ANY(${sql.array(ids, "UUID")}::uuid[]) AND d.record_sources_complete
    GROUP BY d.id
  `;
  return new Map(rows.map((row) => [row.id, row.count]));
};

export const resolveCapturedDocumentRecords = async (payload: WorkflowDocumentDataCapture["payload"], baseId: string, tx: SQL) => {
  if (payload.version === 1 || payload.version === 2) return capturedDocumentRecords(payload);
  const ids = tx.array(payload.source.ids, "TEXT");
  const relation = payload.version === 3 ? tx`grids.documents` : tx`grids.record_snapshots`;
  const [present] = await tx<Array<{ count: number }>>`SELECT count(*)::int AS count FROM ${relation}
    WHERE base_id = ${baseId}::uuid AND short_id = ANY(${ids}::text[])`;
  if (present?.count !== new Set(payload.source.ids).size) return null;
  if (payload.version === 3) {
    const [incomplete] = await tx`SELECT 1 FROM grids.documents
      WHERE base_id = ${baseId}::uuid AND short_id = ANY(${ids}::text[])
        AND NOT record_sources_complete AND record_id IS NULL LIMIT 1`;
    if (incomplete) return null;
  }
  const rows =
    payload.version === 4
      ? await tx<Array<{ tableId: string; recordId: string; version: number }>>`
      SELECT t.short_id AS "tableId", r.short_id AS "recordId", (s.root->>'version')::bigint AS version
      FROM grids.record_snapshots s JOIN grids.tables t ON t.id = s.table_id JOIN grids.records r ON r.id = s.record_id
      WHERE s.base_id = ${baseId}::uuid AND s.short_id = ANY(${ids}::text[])`
      : await tx<Array<{ tableId: string; recordId: string; version: number }>>`
      SELECT t.short_id AS "tableId", r.short_id AS "recordId", source.version
      FROM grids.documents d JOIN grids.document_record_sources source ON source.document_id = d.id
      JOIN grids.tables t ON t.id = source.table_id JOIN grids.records r ON r.id = source.record_id
      WHERE d.base_id = ${baseId}::uuid AND d.short_id = ANY(${ids}::text[])
      UNION
      SELECT t.short_id, r.short_id, (s.root->>'version')::bigint
      FROM grids.documents d JOIN grids.record_snapshots s ON s.id = d.snapshot_id
      JOIN grids.tables t ON t.id = d.table_id JOIN grids.records r ON r.id = d.record_id
      WHERE d.base_id = ${baseId}::uuid AND d.short_id = ANY(${ids}::text[])`;
  if (!rows.length) return [];
  const unique = new Map(rows.map((row) => [`${row.tableId}:${row.recordId}`, { ...row, version: Number(row.version) }]));
  if (rows.some((row) => unique.get(`${row.tableId}:${row.recordId}`)?.version !== Number(row.version))) return null;
  const parsed = DocumentSourceVersionsSchema.safeParse([...unique.values()]);
  return parsed.success ? parsed.data : null;
};

export const persistDocumentRecordSources = async (
  input: { documentId: string; baseId: string; sources: ReturnType<typeof capturedDocumentRecords>; locale?: string },
  tx: SQL,
) => {
  if (!input.sources?.length) return;
  const rows = await tx<Array<{ table_id: string; record_id: string; version: number }>>`
    SELECT r.table_id::text, r.id::text AS record_id, requested.version
    FROM jsonb_to_recordset(${input.sources}::jsonb)
      AS requested("tableId" text, "recordId" text, version bigint)
    JOIN grids.tables t ON t.short_id = requested."tableId" AND t.base_id = ${input.baseId}::uuid
    JOIN grids.records r ON r.table_id = t.id AND r.short_id = requested."recordId"
  `;
  if (rows.length !== input.sources.length) throw err.badInput(documentServiceText(input.locale).associatedRecordUnavailable);
  await tx`INSERT INTO grids.document_record_sources ${tx(rows.map((row) => ({ document_id: input.documentId, ...row })))}`;
};

/** Call only after authorizing the complete document, not one member record. */
export const listDocumentRecordSources = async (documentId: string, offset = 0, limit = 50, db: SQL = sql, viewer?: ExpansionViewer) => {
  const rows = await db<
    Array<{
      internalTableId: string;
      internalRecordId: string;
      tableId: string;
      recordId: string;
      tableName: string;
      version: number | null;
      deleted: boolean;
    }>
  >`
    WITH sources AS (
      SELECT table_id, record_id, version FROM grids.document_record_sources WHERE document_id = ${documentId}::uuid
      UNION
      SELECT d.table_id, d.record_id, (s.root->>'version')::bigint FROM grids.documents d
        JOIN grids.record_snapshots s ON s.id = d.snapshot_id WHERE d.id = ${documentId}::uuid
          AND NOT EXISTS (SELECT 1 FROM grids.document_record_sources WHERE document_id = d.id)
    )
    SELECT t.id::text AS "internalTableId", r.id::text AS "internalRecordId", t.short_id AS "tableId", r.short_id AS "recordId", t.name AS "tableName",
      source.version AS version, (r.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL) AS deleted
    FROM sources source
    JOIN grids.records r ON r.id = source.record_id
    JOIN grids.tables t ON t.id = source.table_id
    ORDER BY t.short_id, r.short_id
    LIMIT ${limit + 1} OFFSET ${offset}
  `;
  const page = rows.slice(0, limit);
  const ids = new Map<string, Set<string>>();
  for (const row of page) {
    if (row.deleted) continue;
    const records = ids.get(row.internalTableId) ?? new Set<string>();
    records.add(row.internalRecordId);
    ids.set(row.internalTableId, records);
  }
  const labels = viewer ? await buildRelationLabelCacheForIds(ids, viewer, db) : {};
  return {
    items: page.map(({ internalTableId: _table, internalRecordId, ...row }) => ({
      ...row,
      label: labels[internalRecordId] ?? row.recordId,
      version: row.version == null ? null : Number(row.version),
    })),
    hasMore: rows.length > limit,
  };
};
