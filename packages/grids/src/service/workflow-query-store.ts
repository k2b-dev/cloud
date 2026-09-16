import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import { z } from "zod";
import { type WorkflowDocumentDataCapture, WorkflowDocumentDataPayloadSchema } from "../workflows/query-contracts";
import { canonicalDocumentJson, MAX_DOCUMENT_PROFILE_INPUT_BYTES } from "./document-json";
import { documentServiceText } from "./document-messages";
export const WorkflowQueryReferenceSchema = z
  .object({
    kind: z.literal("queryResult"),
    id: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rowCount: z.number().int().nonnegative(),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export const WorkflowDocumentDataReferenceSchema = z.union([
  WorkflowQueryReferenceSchema,
  WorkflowQueryReferenceSchema.extend({ kind: z.literal("workflowValues") }),
  WorkflowQueryReferenceSchema.extend({ kind: z.literal("documentSnapshots") }),
  WorkflowQueryReferenceSchema.extend({ kind: z.literal("recordSnapshots") }),
]);
type WorkflowDocumentDataReference = z.infer<typeof WorkflowDocumentDataReferenceSchema>;
type QueryRow = { id: string; payload: Record<string, unknown>; sha256: string; row_count: number; captured_at: Date };

/** Public capture handles are scoped to their run and use the authored step key. */
export const projectWorkflowCaptureSteps = async (ids: readonly string[], db: SQL = sql): Promise<Map<string, string>> => {
  if (ids.length === 0) return new Map();
  const rows = await db<Array<{ id: string; step_key: string }>>`
    SELECT id::text, step_key FROM grids.workflow_query_data WHERE id = ANY(${db.array([...new Set(ids)], "UUID")})
  `;
  return new Map(rows.map((row) => [row.id, row.step_key]));
};

const validateCapture = (
  input: { payload: Record<string, unknown>; sha256: string; rowCount: number; capturedAt: string },
  locale?: string,
): Result<WorkflowDocumentDataCapture> => {
  const t = documentServiceText(locale);
  try {
    const canonical = canonicalDocumentJson(input.payload, locale);
    const parsed = WorkflowDocumentDataPayloadSchema.safeParse(canonical.value);
    if (
      !parsed.success ||
      canonical.sha256 !== input.sha256 ||
      input.payload.complete !== true ||
      input.payload.rowCount !== input.rowCount ||
      input.payload.capturedAt !== input.capturedAt ||
      !Array.isArray(input.payload.rows) ||
      input.payload.rows.length !== input.rowCount ||
      !Number.isSafeInteger(input.rowCount) ||
      input.rowCount < 0 ||
      new Date(input.capturedAt).toISOString() !== input.capturedAt
    )
      return fail(err.internal(t.workflowQueryIntegrityFailed));
    return ok({ ...input, payload: parsed.data });
  } catch {
    return fail(err.internal(t.workflowQueryIntegrityFailed));
  }
};

const decode = (row: QueryRow, locale?: string) => {
  const capture = validateCapture(
    {
      payload: row.payload,
      sha256: row.sha256,
      rowCount: row.row_count,
      capturedAt: row.captured_at.toISOString(),
    },
    locale,
  );
  if (!capture.ok) return capture;
  const reference: WorkflowDocumentDataReference = {
    kind:
      capture.data.payload.version === 1
        ? "queryResult"
        : capture.data.payload.version === 2
          ? "workflowValues"
          : capture.data.payload.version === 3
            ? "documentSnapshots"
            : "recordSnapshots",
    id: row.id,
    sha256: row.sha256,
    rowCount: row.row_count,
    capturedAt: capture.data.capturedAt,
  };
  return ok({ reference, payload: capture.data.payload });
};

/** Internal only: callers reauthorize the run and the payload's tables before
 * use. Both run and Base are mandatory so a reference cannot cross scopes. */
export const loadWorkflowQueryData = async (
  input: { baseId: string; runId: string; id: string; sha256: string; locale?: string },
  db: SQL,
) => {
  const [row] = await db<QueryRow[]>`
    SELECT data.id::text, data.payload, data.sha256, data.row_count, data.captured_at
    FROM grids.workflow_query_data data
    JOIN grids.workflow_run_profile profile ON profile.run_id = data.run_id
    WHERE data.id = ${input.id}::uuid AND data.run_id = ${input.runId}::uuid AND profile.base_id = ${input.baseId}::uuid
  `;
  if (!row) return fail(err.notFound(documentServiceText(input.locale).workflowQueryNotFound));
  if (row.sha256 !== input.sha256) return fail(err.conflict(documentServiceText(input.locale).workflowQueryIntegrityFailed));
  return decode(row, input.locale);
};

/** Reuse an already captured step without reevaluating its workflow values. */
export const findWorkflowDocumentDataForStep = async (
  input: { baseId: string; runId: string; stepKey: string; locale?: string },
  db: SQL,
) => {
  const [row] = await db<QueryRow[]>`
    SELECT data.id::text, data.payload, data.sha256, data.row_count, data.captured_at
    FROM grids.workflow_query_data data JOIN grids.workflow_run_profile profile ON profile.run_id = data.run_id
    WHERE data.run_id = ${input.runId}::uuid AND data.step_key = ${input.stepKey} AND profile.base_id = ${input.baseId}::uuid
  `;
  return row ? decode(row, input.locale) : ok(null);
};

/** Commit in the kernel step's transaction, alongside the small outcome.
 * No update/upsert can replace a successful capture on retry. */
export const persistWorkflowQueryDataInTransaction = async (
  input: { baseId: string; runId: string; stepKey: string; capture: WorkflowDocumentDataCapture; locale?: string },
  db: SQL,
): Promise<Result<WorkflowDocumentDataReference>> => {
  const t = documentServiceText(input.locale);
  const checked = validateCapture(input.capture, input.locale);
  if (!checked.ok) return checked;
  // One input budget for the run, not a fresh budget for every loop iteration.
  // Lock the profile before replay checks so concurrent writers share a budget.
  const [profile] = await db<Array<{ run_id: string }>>`
    SELECT run_id::text FROM grids.workflow_run_profile profile
    WHERE profile.run_id = ${input.runId}::uuid AND profile.base_id = ${input.baseId}::uuid
    FOR UPDATE
  `;
  if (!profile) return fail(err.notFound(t.workflowQueryNotFound));
  const existing = await findWorkflowDocumentDataForStep(input, db);
  if (!existing.ok) return existing;
  if (existing.data) {
    return existing.data.reference.sha256 === input.capture.sha256
      ? ok(existing.data.reference)
      : fail(err.conflict(t.idempotencyConflict));
  }
  const bytes = new TextEncoder().encode(JSON.stringify(checked.data.payload)).byteLength;
  const [reserved] = await db<Array<{ run_id: string }>>`
    UPDATE grids.workflow_run_profile
    SET captured_bytes = captured_bytes + ${bytes}
    WHERE run_id = ${input.runId}::uuid AND captured_bytes + ${bytes} <= ${MAX_DOCUMENT_PROFILE_INPUT_BYTES}
    RETURNING run_id::text
  `;
  if (!reserved) return fail(err.badInput(t.workflowCaptureBudget));
  await db`
    INSERT INTO grids.workflow_query_data (run_id, step_key, payload, sha256, row_count, captured_at)
    SELECT profile.run_id, ${input.stepKey}, ${checked.data.payload}::jsonb, ${input.capture.sha256},
      ${input.capture.rowCount}, ${input.capture.capturedAt}::timestamptz
    FROM grids.workflow_run_profile profile
    WHERE profile.run_id = ${input.runId}::uuid AND profile.base_id = ${input.baseId}::uuid
    ON CONFLICT (run_id, step_key) DO NOTHING
  `;
  const [row] = await db<QueryRow[]>`
    SELECT data.id::text, data.payload, data.sha256, data.row_count, data.captured_at
    FROM grids.workflow_query_data data
    JOIN grids.workflow_run_profile profile ON profile.run_id = data.run_id
    WHERE data.run_id = ${input.runId}::uuid AND data.step_key = ${input.stepKey} AND profile.base_id = ${input.baseId}::uuid
  `;
  if (!row) return fail(err.notFound(t.workflowQueryNotFound));
  if (row.sha256 !== input.capture.sha256) return fail(err.conflict(t.idempotencyConflict));
  const decoded = decode(row, input.locale);
  return decoded.ok ? ok(decoded.data.reference) : decoded;
};
