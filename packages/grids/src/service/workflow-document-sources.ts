import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { SQL } from "bun";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import {
  MAX_WORKFLOW_QUERY_ROWS,
  type WorkflowDocumentDataCapture,
  WorkflowDocumentSnapshotPayloadSchema,
  WorkflowRecordSnapshotPayloadSchema,
} from "../workflows/query-contracts";
import { canonicalDocumentJson, MAX_DOCUMENT_PROFILE_INPUT_BYTES } from "./document-json";
import { type DocumentDbRow, mapRecordSnapshot } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { projectRecordSnapshot } from "./document-snapshot-projection";
import { filterSnapshotRelatedRecords, type SnapshotTableReadAuthorizer } from "./document-snapshots";
import { captureWorkflowDocumentValues, WorkflowDocumentValuesSchema } from "./workflow-document-values";

export const WorkflowDocumentSourceSchema = z
  .object({
    documents: z.array(ShortIdSchema).min(1).max(MAX_WORKFLOW_QUERY_ROWS),
    columns: z.array(WorkflowDocumentValuesSchema.shape.columns.element.extend({ path: z.array(z.string().min(1)).min(1) })).min(1),
  })
  .strict()
  .refine((value) => new Set(value.documents).size === value.documents.length, "Duplicate documents");

export const WorkflowRecordSourceSchema = z
  .object({
    snapshots: WorkflowDocumentSourceSchema.shape.documents,
    columns: WorkflowDocumentSourceSchema.shape.columns,
  })
  .strict()
  .refine((value) => new Set(value.snapshots).size === value.snapshots.length, "Duplicate snapshots");

/** Only own JSON properties are readable. No expression evaluator, live
 * Record lookup, implicit array expansion, or missing-value fallback. */
const projectSnapshotValues = (
  columns: z.infer<typeof WorkflowDocumentSourceSchema>["columns"],
  documents: readonly Record<string, unknown>[],
  capturedAt: string,
  locale?: string,
): Result<WorkflowDocumentDataCapture> => {
  const t = documentServiceText(locale);
  try {
    const rows = documents.map((document) =>
      Object.fromEntries(
        columns.map((column) => {
          let value: unknown = document;
          for (const key of column.path) {
            if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key))
              throw err.badInput(t.tableOutputDataInvalid);
            value = Reflect.get(value, key);
          }
          return [column.key, value];
        }),
      ),
    );
    return captureWorkflowDocumentValues({ columns: columns.map(({ path: _path, ...column }) => column), rows }, capturedAt, locale);
  } catch {
    return fail(err.badInput(t.tableOutputDataInvalid));
  }
};

export const projectDocumentSnapshotRows = (
  source: z.infer<typeof WorkflowDocumentSourceSchema>,
  documents: readonly Record<string, unknown>[],
  capturedAt: string,
  locale?: string,
): Result<WorkflowDocumentDataCapture> => {
  const values = projectSnapshotValues(source.columns, documents, capturedAt, locale);
  if (!values.ok) return values;
  try {
    const payload = WorkflowDocumentSnapshotPayloadSchema.parse({
      ...values.data.payload,
      version: 3,
      source: { kind: "documents", ids: source.documents },
    });
    return ok({ ...values.data, payload, sha256: canonicalDocumentJson(payload, locale, 2).sha256 });
  } catch {
    return fail(err.badInput(documentServiceText(locale).tableOutputDataInvalid));
  }
};

/** Snapshots use the same projection and related-record redaction as the API.
 * No live field values are read. Current existence and table access still apply. */
export const captureWorkflowRecordSource = async (
  input: { source: unknown; baseId: string; capturedAt: string; locale?: string; canReadTable: SnapshotTableReadAuthorizer },
  db: SQL,
): Promise<Result<WorkflowDocumentDataCapture>> => {
  const t = documentServiceText(input.locale);
  const parsed = WorkflowRecordSourceSchema.safeParse(input.source);
  if (!parsed.success) return fail(err.badInput(t.tableOutputDataInvalid));
  const [budget] = await db<Array<{ count: number; bytes: string }>>`
    SELECT count(*)::int AS count, COALESCE(sum(octet_length(s.root::text) + octet_length(s.graph::text)), 0)::text AS bytes
    FROM grids.record_snapshots s JOIN grids.records r ON r.id = s.record_id AND r.table_id = s.table_id
    WHERE s.base_id = ${input.baseId}::uuid AND s.short_id = ANY(${db.array(parsed.data.snapshots, "TEXT")}::text[])
  `;
  if (budget?.count !== parsed.data.snapshots.length) return fail(err.notFound(t.recordNotFound));
  if (BigInt(budget.bytes) > BigInt(MAX_DOCUMENT_PROFILE_INPUT_BYTES))
    return fail(err.badInput(t.documentJsonTooLarge({ limit: MAX_DOCUMENT_PROFILE_INPUT_BYTES })));
  const stored = await db<DocumentDbRow[]>`SELECT s.* FROM grids.record_snapshots s
    JOIN grids.records r ON r.id = s.record_id AND r.table_id = s.table_id
    WHERE s.base_id = ${input.baseId}::uuid AND s.short_id = ANY(${db.array(parsed.data.snapshots, "TEXT")}::text[])`;
  const snapshots = new Map(
    stored.map((row) => {
      const snapshot = mapRecordSnapshot(row);
      return [snapshot.shortId, snapshot] as const;
    }),
  );
  const roots: Record<string, unknown>[] = [];
  const tables = new Set<string>();
  const authorize: SnapshotTableReadAuthorizer = async (target, client) => {
    const allowed = target.baseId === input.baseId && (await input.canReadTable(target, client));
    if (allowed) tables.add(target.tableId);
    return allowed;
  };
  for (const id of parsed.data.snapshots) {
    const snapshot = snapshots.get(id);
    if (!snapshot) return fail(err.notFound(t.recordNotFound));
    if (!(await authorize({ baseId: snapshot.baseId, tableId: snapshot.tableId }, db))) return fail(err.forbidden());
    roots.push(await projectRecordSnapshot(await filterSnapshotRelatedRecords(snapshot, authorize)));
  }
  const values = projectSnapshotValues(parsed.data.columns, roots, input.capturedAt, input.locale);
  if (!values.ok) return values;
  const payload = WorkflowRecordSnapshotPayloadSchema.parse({
    ...values.data.payload,
    version: 4,
    source: { kind: "recordSnapshots", ids: parsed.data.snapshots },
    tableIds: [...tables].sort(),
  });
  return ok({ ...values.data, payload, sha256: canonicalDocumentJson(payload, input.locale, 2).sha256 });
};

/** Internal: caller must authorize the current workflow's Base before calling.
 * Read only issued immutable data and scope every requested ID to that Base. */
export const captureWorkflowDocumentSource = async (
  input: { source: unknown; baseId: string; capturedAt: string; locale?: string },
  db: SQL,
) => {
  const parsed = WorkflowDocumentSourceSchema.safeParse(input.source);
  const t = documentServiceText(input.locale);
  if (!parsed.success) return fail(err.badInput(t.tableOutputDataInvalid));
  // Bound reads before transferring potentially many large immutable snapshots.
  const [budget] = await db<Array<{ count: number; bytes: string }>>`
    SELECT count(*)::int AS count,
      COALESCE(sum(octet_length(render_data::text) + COALESCE(octet_length(profile_snapshot::text), 4)
        + COALESCE(octet_length(profile_output::text), 4)), 0)::text AS bytes
    FROM grids.documents WHERE base_id = ${input.baseId}::uuid AND short_id = ANY(${db.array(parsed.data.documents, "TEXT")}::text[])
  `;
  if (budget?.count !== parsed.data.documents.length) return fail(err.notFound(t.documentNotFound));
  if (BigInt(budget.bytes) > BigInt(MAX_DOCUMENT_PROFILE_INPUT_BYTES))
    return fail(err.badInput(t.documentJsonTooLarge({ limit: MAX_DOCUMENT_PROFILE_INPUT_BYTES })));
  const rows = await db<
    Array<{
      short_id: string;
      document_number: string;
      created_at: Date;
      render_data: Record<string, unknown>;
      profile_snapshot: Record<string, unknown> | null;
      profile_output: Record<string, unknown> | null;
    }>
  >`
    SELECT short_id, document_number, created_at, render_data, profile_snapshot, profile_output
    FROM grids.documents WHERE base_id = ${input.baseId}::uuid AND short_id = ANY(${db.array(parsed.data.documents, "TEXT")}::text[])
  `;
  const byId = new Map(rows.map((row) => [row.short_id, row]));
  if (byId.size !== parsed.data.documents.length) return fail(err.notFound(t.documentNotFound));
  const documents = parsed.data.documents.map((id) => {
    const row = byId.get(id)!;
    return {
      id,
      number: row.document_number,
      createdAt: row.created_at.toISOString(),
      data: row.render_data,
      profile: row.profile_snapshot,
      output: row.profile_output,
    };
  });
  return projectDocumentSnapshotRows(parsed.data, documents, input.capturedAt, input.locale);
};

/** Planning validates existing Documents but never queries placeholders from
 * earlier planned steps. Their content does not exist until real execution. */
export const planWorkflowDocumentSource = async (input: { source: unknown; baseId: string; locale?: string }, db: SQL) => {
  const parsed = z
    .object({
      ...WorkflowDocumentSourceSchema.shape,
      documents: z
        .array(z.union([ShortIdSchema, z.string().startsWith("dry-run:").min(9)]))
        .min(1)
        .max(MAX_WORKFLOW_QUERY_ROWS),
    })
    .strict()
    .safeParse(input.source);
  const t = documentServiceText(input.locale);
  if (!parsed.success || new Set(parsed.data.documents).size !== parsed.data.documents.length)
    return fail(err.badInput(t.tableOutputDataInvalid));
  const columns = captureWorkflowDocumentValues(
    { columns: parsed.data.columns.map(({ path: _path, ...column }) => column), rows: [] },
    new Date().toISOString(),
    input.locale,
  );
  if (!columns.ok) return columns;
  const existing = parsed.data.documents.filter((id) => !id.startsWith("dry-run:"));
  if (existing.length) {
    const checked = await captureWorkflowDocumentSource(
      { ...input, source: { ...parsed.data, documents: existing }, capturedAt: new Date().toISOString() },
      db,
    );
    if (!checked.ok) return checked;
  }
  return ok({ plannedDocuments: parsed.data.documents.length - existing.length });
};
