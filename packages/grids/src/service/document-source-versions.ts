import { err } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { MAX_WORKFLOW_QUERY_ROWS, type WorkflowDocumentDataCapture } from "../workflows/query-contracts";
import { documentServiceText } from "./document-messages";

export const DocumentSourceVersionsSchema = z
  .array(
    z
      .object({
        tableId: ShortIdSchema,
        recordId: ShortIdSchema,
        version: z.number().int().positive().safe(),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_WORKFLOW_QUERY_ROWS)
  .refine((rows) => new Set(rows.map((row) => `${row.tableId}:${row.recordId}`)).size === rows.length, "Duplicate source records");

export const DocumentSourceVersionsInputSchema = z.union([z.literal("data"), DocumentSourceVersionsSchema]);

export const sourceVersionsFromData = (payload: WorkflowDocumentDataCapture["payload"], locale?: string) => {
  // Single-source row identity is the limit of this shorthand. It cannot cover
  // arbitrary joins, aggregates, or historic captures without version metadata.
  if (payload.version !== 1 || payload.tableIds.length !== 1) throw err.badInput(documentServiceText(locale).sourceVersionsUnavailable);
  const parsed = parseGridsQueryDsl(payload.source);
  if (!parsed.ok || parsed.ast.source?.kind !== "table" || parsed.ast.joins.length > 0)
    throw err.badInput(documentServiceText(locale).sourceVersionsUnavailable);
  if (payload.rows.length === 0) throw err.badInput(documentServiceText(locale).sourceVersionsEmpty);
  const versions = DocumentSourceVersionsSchema.safeParse(payload.rowOrigins);
  if (!versions.success) throw err.badInput(documentServiceText(locale).sourceVersionsUnavailable);
  return versions.data;
};

/** Explicit author-selected versions, not an inferred freshness proof for joins
 * or aggregates. Caller owns the transaction through confirmation/issuance. */
export const requireDocumentSourceVersions = async (
  input: {
    baseId: string;
    sourceVersions?: z.infer<typeof DocumentSourceVersionsSchema>;
    locale?: string;
    /** Inspection/planning uses a snapshot; confirmation and issuance lock. */
    lock?: boolean;
    authorize: (tableIds: readonly string[], client: SQL) => Promise<void>;
  },
  tx: SQL,
): Promise<void> => {
  if (!input.sourceVersions) return;
  const selected = DocumentSourceVersionsSchema.parse(input.sourceVersions);
  const tables = await tx<Array<{ id: string }>>`
    SELECT t.id::text FROM grids.tables t JOIN grids.bases b ON b.id = t.base_id
    WHERE t.base_id = ${input.baseId}::uuid AND b.deleted_at IS NULL AND t.deleted_at IS NULL
      AND t.short_id = ANY(${tx.array([...new Set(selected.map((row) => row.tableId))], "TEXT")}::text[])
  `;
  await input.authorize(
    tables.map((table) => table.id),
    tx,
  );
  const rows = await tx<Array<{ table_id: string; record_id: string; version: number }>>`
    SELECT t.short_id AS table_id, r.short_id AS record_id, r.version
    FROM jsonb_to_recordset(${selected}::jsonb) AS expected("tableId" text, "recordId" text, version bigint)
    JOIN grids.tables t ON t.short_id = expected."tableId" AND t.base_id = ${input.baseId}::uuid AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    JOIN grids.records r ON r.table_id = t.id AND r.short_id = expected."recordId" AND r.deleted_at IS NULL
    ORDER BY t.id, r.id ${input.lock === false ? tx`` : tx`FOR UPDATE OF r`}
  `;
  const versions = new Map(rows.map((row) => [`${row.table_id}:${row.record_id}`, row.version]));
  if (selected.some((row) => versions.get(`${row.tableId}:${row.recordId}`) !== row.version))
    throw err.conflict(documentServiceText(input.locale).sourceVersionChanged);
};
