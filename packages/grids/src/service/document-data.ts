import { err, fail, ok } from "@k2b/stdlib";
import type { SQL } from "bun";
import { type WorkflowDocumentDataCapture, WorkflowDocumentDataPayloadSchema } from "../workflows/query-contracts";
import { canonicalDocumentJson } from "./document-json";
import { documentServiceText } from "./document-messages";
import { insertWithShortIdForDb } from "./short-id";
import { WorkflowDocumentDataReferenceSchema } from "./workflow-query-store";

/** Domain-owned immutable data. It has no executable workflow or run parent. */
export const persistDocumentData = async (
  input: { baseId: string; capture: WorkflowDocumentDataCapture; actor: unknown; requestId: string; operationKey: string },
  db: SQL,
) => {
  const parsed = WorkflowDocumentDataPayloadSchema.safeParse(input.capture.payload);
  if (!parsed.success) return fail(err.badInput("Invalid document data."));
  const canonical = canonicalDocumentJson(parsed.data);
  if (canonical.sha256 !== input.capture.sha256) return fail(err.conflict("Document data changed."));
  const [row] = await insertWithShortIdForDb(
    db,
    "document_data_short_id_key",
    (client, shortId) => client<Array<{ id: string; short_id: string; sha256: string }>>`
    INSERT INTO grids.document_data (short_id, base_id, operation_key, payload, sha256, actor, request_id)
    VALUES (${shortId}, ${input.baseId}::uuid, ${input.operationKey}, ${canonical.value}::jsonb, ${canonical.sha256}, ${input.actor}::jsonb, ${input.requestId})
    ON CONFLICT (base_id, operation_key) DO UPDATE SET operation_key = EXCLUDED.operation_key
    RETURNING id::text, short_id, sha256
  `,
  );
  if (!row || row.sha256 !== canonical.sha256) return fail(err.conflict("Document capture idempotency conflict."));
  return ok({
    shortId: row.short_id,
    reference: WorkflowDocumentDataReferenceSchema.parse({
      kind:
        parsed.data.version === 1
          ? "queryResult"
          : parsed.data.version === 2
            ? "workflowValues"
            : parsed.data.version === 3
              ? "documentSnapshots"
              : "recordSnapshots",
      id: row.id,
      sha256: canonical.sha256,
      rowCount: parsed.data.rowCount,
      capturedAt: parsed.data.capturedAt,
    }),
  });
};
export const loadDocumentData = async (input: { baseId: string; id: string; sha256: string; locale?: string }, db: SQL) => {
  const [row] = await db<
    Array<{ id: string; sha256: string; payload: unknown }>
  >`SELECT id::text, sha256, payload FROM grids.document_data WHERE id = ${input.id}::uuid AND base_id = ${input.baseId}::uuid`;
  const t = documentServiceText(input.locale);
  if (!row) return fail(err.notFound(t.workflowQueryNotFound));
  const parsed = WorkflowDocumentDataPayloadSchema.safeParse(row.payload);
  if (!parsed.success || input.sha256 !== row.sha256 || canonicalDocumentJson(parsed.data, input.locale).sha256 !== row.sha256)
    return fail(err.conflict(t.workflowQueryIntegrityFailed));
  const payload = parsed.data;
  const reference = WorkflowDocumentDataReferenceSchema.parse({
    kind:
      payload.version === 1
        ? "queryResult"
        : payload.version === 2
          ? "workflowValues"
          : payload.version === 3
            ? "documentSnapshots"
            : "recordSnapshots",
    id: row.id,
    sha256: row.sha256,
    rowCount: payload.rowCount,
    capturedAt: payload.capturedAt,
  });
  return ok({ reference, payload });
};

export const resolveDocumentData = async (baseId: string, shortId: string, sha256: string, locale: string | undefined, db: SQL) => {
  const [row] = await db<
    Array<{ id: string }>
  >`SELECT id::text FROM grids.document_data WHERE base_id = ${baseId}::uuid AND short_id = ${shortId}`;
  return row
    ? loadDocumentData({ baseId, id: row.id, sha256, locale }, db)
    : fail(err.notFound(documentServiceText(locale).workflowQueryNotFound));
};
