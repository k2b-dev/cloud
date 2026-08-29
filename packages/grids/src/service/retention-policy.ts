import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type {
  RetentionFile,
  RetentionFileStatus,
  RetentionPolicyInput,
  RetentionPreview,
  RetentionRecord,
  RetentionRecordStatus,
} from "../retention-policy-contracts";
import { RETENTION_PREVIEW_LIMIT } from "../retention-policy-contracts";
import { logAudit } from "./audit";
import { serviceMessagesFor } from "./messages";

type Policy = { minimumDays: number; updatedAt: string };
type RetentionFileContent = { filename: string; mimeType: string; bytes: Uint8Array };
type RetentionFileList = { items: RetentionFile[]; total: number; observedAt: string };
type RetentionRecordList = { items: RetentionRecord[]; total: number; observedAt: string };

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

export const get = async (baseId: string): Promise<Policy | null> => {
  const [row] = await sql<Array<{ minimum_days: number; updated_at: Date | string }>>`
    SELECT minimum_days, updated_at FROM grids.retention_policies WHERE base_id = ${baseId}::uuid
  `;
  return row ? { minimumDays: Number(row.minimum_days), updatedAt: new Date(row.updated_at).toISOString() } : null;
};

export const update = async (baseId: string, input: RetentionPolicyInput, actorId: string | null): Promise<Policy> =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM grids.bases WHERE id = ${baseId}::uuid FOR UPDATE`;
    const [previous] = await tx<Array<{ minimum_days: number }>>`
      SELECT minimum_days FROM grids.retention_policies WHERE base_id = ${baseId}::uuid FOR UPDATE
    `;
    const [row] = await tx<Array<{ minimum_days: number; updated_at: Date | string }>>`
      INSERT INTO grids.retention_policies (base_id, minimum_days, updated_by)
      VALUES (${baseId}::uuid, ${input.minimumDays}, ${actorId}::uuid)
      ON CONFLICT (base_id) DO UPDATE SET minimum_days = EXCLUDED.minimum_days, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING minimum_days, updated_at
    `;
    if (!row) throw new Error("Retention policy update returned no row");
    await logAudit(
      {
        baseId,
        userId: actorId,
        action: "retention_policy.updated",
        diff: { minimumDays: { old: previous ? Number(previous.minimum_days) : null, new: Number(row.minimum_days) } },
      },
      tx,
    );
    return { minimumDays: Number(row.minimum_days), updatedAt: new Date(row.updated_at).toISOString() };
  });

export const remove = async (baseId: string, actorId: string | null): Promise<boolean> =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM grids.bases WHERE id = ${baseId}::uuid FOR UPDATE`;
    const [removed] = await tx<Array<{ minimum_days: number }>>`
      DELETE FROM grids.retention_policies WHERE base_id = ${baseId}::uuid RETURNING minimum_days
    `;
    if (!removed) return false;
    await logAudit(
      {
        baseId,
        userId: actorId,
        action: "retention_policy.removed",
        diff: { minimumDays: { old: Number(removed.minimum_days), new: null } },
      },
      tx,
    );
    return true;
  });

export const preview = async (baseId: string, input: RetentionPolicyInput): Promise<RetentionPreview> => {
  const [observed] = await sql<Array<{ observed_at: Date }>>`SELECT now() AS observed_at`;
  if (!observed) throw new Error("Could not establish retention preview time");
  const observedAt = observed.observed_at.toISOString();
  const [counts] = await sql<Array<{ trashed: number; reached: number; later: number; finalized: number }>>`
    SELECT count(*)::int AS trashed,
      count(*) FILTER (WHERE record.finalized_at IS NULL AND record.deleted_at + (${input.minimumDays} * interval '1 day') <= ${observedAt}::timestamptz)::int AS reached,
      count(*) FILTER (WHERE record.finalized_at IS NULL AND record.deleted_at + (${input.minimumDays} * interval '1 day') > ${observedAt}::timestamptz)::int AS later,
      count(*) FILTER (WHERE record.finalized_at IS NOT NULL)::int AS finalized
    FROM grids.records record JOIN grids.tables table_info ON table_info.id = record.table_id
    WHERE table_info.base_id = ${baseId}::uuid AND record.deleted_at IS NOT NULL
  `;
  const examples = await sql<Array<{ record_id: string; table_id: string; deleted_at: Date; not_before: Date }>>`
    SELECT record.short_id AS record_id, table_info.short_id AS table_id, record.deleted_at,
      record.deleted_at + (${input.minimumDays} * interval '1 day') AS not_before
    FROM grids.records record JOIN grids.tables table_info ON table_info.id = record.table_id
    WHERE table_info.base_id = ${baseId}::uuid AND record.deleted_at IS NOT NULL AND record.finalized_at IS NULL
    ORDER BY not_before, record.id LIMIT ${RETENTION_PREVIEW_LIMIT}
  `;
  const [fileCounts] = await sql<Array<{ unreferenced: number; reached: number; later: number; size_bytes: number | string }>>`
    SELECT count(*)::int AS unreferenced,
      count(*) FILTER (WHERE candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') <= ${observedAt}::timestamptz)::int AS reached,
      count(*) FILTER (WHERE candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') > ${observedAt}::timestamptz)::int AS later,
      COALESCE(sum(file.size_bytes), 0)::bigint AS size_bytes
    FROM grids.file_retention_candidates candidate
    JOIN grids.files file ON file.id = candidate.file_id
    WHERE candidate.base_id = ${baseId}::uuid
  `;
  const fileExamples = await sql<
    Array<{ file_id: string; filename: string; size_bytes: number | string; unreferenced_at: Date; not_before: Date }>
  >`
    SELECT file.short_id AS file_id, file.filename, file.size_bytes, candidate.unreferenced_at,
      candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') AS not_before
    FROM grids.file_retention_candidates candidate
    JOIN grids.files file ON file.id = candidate.file_id
    WHERE candidate.base_id = ${baseId}::uuid
    ORDER BY not_before, file.id LIMIT ${RETENTION_PREVIEW_LIMIT}
  `;
  const values = counts ?? { trashed: 0, reached: 0, later: 0, finalized: 0 };
  const fileValues = fileCounts ?? { unreferenced: 0, reached: 0, later: 0, size_bytes: 0 };
  return {
    observedAt,
    minimumDays: input.minimumDays,
    counts: {
      trashedRecords: Number(values.trashed),
      floorReached: Number(values.reached),
      retainedUntilLater: Number(values.later),
      protectedFinalized: Number(values.finalized),
    },
    examples: examples.map((row) => ({
      recordId: row.record_id,
      tableId: row.table_id,
      deletedAt: row.deleted_at.toISOString(),
      notBefore: row.not_before.toISOString(),
    })),
    truncated: Number(values.reached) + Number(values.later) > examples.length,
    files: {
      counts: {
        unreferenced: Number(fileValues.unreferenced),
        floorReached: Number(fileValues.reached),
        retainedUntilLater: Number(fileValues.later),
        sizeBytes: Number(fileValues.size_bytes),
      },
      examples: fileExamples.map((row) => ({
        fileId: row.file_id,
        filename: row.filename,
        sizeBytes: Number(row.size_bytes),
        unreferencedAt: row.unreferenced_at.toISOString(),
        notBefore: row.not_before.toISOString(),
      })),
      truncated: Number(fileValues.unreferenced) > fileExamples.length,
    },
  };
};

export const listFiles = async (
  baseId: string,
  input: { minimumDays: number; search: string; status: RetentionFileStatus; perPage: number; offset: number },
): Promise<RetentionFileList> => {
  const [observed] = await sql<Array<{ observed_at: Date }>>`SELECT now() AS observed_at`;
  if (!observed) throw new Error("Could not establish retention file observation time");
  const observedAt = observed.observed_at.toISOString();
  const searchPattern = `%${escapeLikePattern(input.search)}%`;
  const [countRow] = await sql<Array<{ total: number }>>`
    SELECT count(*)::int AS total
    FROM grids.file_retention_candidates candidate
    JOIN grids.files file ON file.id = candidate.file_id
    WHERE candidate.base_id = ${baseId}::uuid
      AND (${input.search} = '' OR file.filename ILIKE ${searchPattern} ESCAPE '\\' OR file.short_id ILIKE ${searchPattern} ESCAPE '\\')
      AND (
        ${input.status} = 'all'
        OR (${input.status} = 'retained' AND candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') > ${observedAt}::timestamptz)
        OR (${input.status} = 'reached' AND candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') <= ${observedAt}::timestamptz)
      )
  `;
  const rows = await sql<
    Array<{ file_id: string; filename: string; mime_type: string; size_bytes: number; unreferenced_at: Date; not_before: Date }>
  >`
    SELECT file.short_id AS file_id, file.filename, file.mime_type, file.size_bytes, candidate.unreferenced_at,
      candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') AS not_before
    FROM grids.file_retention_candidates candidate
    JOIN grids.files file ON file.id = candidate.file_id
    WHERE candidate.base_id = ${baseId}::uuid
      AND (${input.search} = '' OR file.filename ILIKE ${searchPattern} ESCAPE '\\' OR file.short_id ILIKE ${searchPattern} ESCAPE '\\')
      AND (
        ${input.status} = 'all'
        OR (${input.status} = 'retained' AND candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') > ${observedAt}::timestamptz)
        OR (${input.status} = 'reached' AND candidate.unreferenced_at + (${input.minimumDays} * interval '1 day') <= ${observedAt}::timestamptz)
      )
    ORDER BY not_before, file.id
    LIMIT ${input.perPage} OFFSET ${input.offset}
  `;
  return {
    observedAt,
    total: Number(countRow?.total ?? 0),
    items: rows.map((row) => ({
      fileId: row.file_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      unreferencedAt: row.unreferenced_at.toISOString(),
      notBefore: row.not_before.toISOString(),
      status: row.not_before.toISOString() > observedAt ? "retained" : "reached",
    })),
  };
};

export const listRecords = async (
  baseId: string,
  input: { minimumDays: number; search: string; status: RetentionRecordStatus; perPage: number; offset: number },
): Promise<RetentionRecordList> => {
  const [observed] = await sql<Array<{ observed_at: Date }>>`SELECT now() AS observed_at`;
  if (!observed) throw new Error("Could not establish retention record observation time");
  const observedAt = observed.observed_at.toISOString();
  const searchPattern = `%${escapeLikePattern(input.search)}%`;
  const [countRow] = await sql<Array<{ total: number }>>`
    SELECT count(*)::int AS total
    FROM grids.records record
    JOIN grids.tables table_info ON table_info.id = record.table_id
    WHERE table_info.base_id = ${baseId}::uuid
      AND record.deleted_at IS NOT NULL
      AND (
        ${input.search} = ''
        OR record.short_id ILIKE ${searchPattern} ESCAPE '\\'
        OR table_info.short_id ILIKE ${searchPattern} ESCAPE '\\'
        OR table_info.name ILIKE ${searchPattern} ESCAPE '\\'
      )
      AND (
        ${input.status} = 'all'
        OR (${input.status} = 'protected' AND record.finalized_at IS NOT NULL)
        OR (${input.status} = 'retained' AND record.finalized_at IS NULL AND record.deleted_at + (${input.minimumDays} * interval '1 day') > ${observedAt}::timestamptz)
        OR (${input.status} = 'reached' AND record.finalized_at IS NULL AND record.deleted_at + (${input.minimumDays} * interval '1 day') <= ${observedAt}::timestamptz)
      )
  `;
  const rows = await sql<
    Array<{
      record_id: string;
      table_id: string;
      table_name: string;
      deleted_at: Date;
      finalized_at: Date | null;
      not_before: Date | null;
    }>
  >`
    SELECT record.short_id AS record_id, table_info.short_id AS table_id, table_info.name AS table_name,
      record.deleted_at, record.finalized_at,
      CASE WHEN record.finalized_at IS NULL
        THEN record.deleted_at + (${input.minimumDays} * interval '1 day')
        ELSE NULL
      END AS not_before
    FROM grids.records record
    JOIN grids.tables table_info ON table_info.id = record.table_id
    WHERE table_info.base_id = ${baseId}::uuid
      AND record.deleted_at IS NOT NULL
      AND (
        ${input.search} = ''
        OR record.short_id ILIKE ${searchPattern} ESCAPE '\\'
        OR table_info.short_id ILIKE ${searchPattern} ESCAPE '\\'
        OR table_info.name ILIKE ${searchPattern} ESCAPE '\\'
      )
      AND (
        ${input.status} = 'all'
        OR (${input.status} = 'protected' AND record.finalized_at IS NOT NULL)
        OR (${input.status} = 'retained' AND record.finalized_at IS NULL AND record.deleted_at + (${input.minimumDays} * interval '1 day') > ${observedAt}::timestamptz)
        OR (${input.status} = 'reached' AND record.finalized_at IS NULL AND record.deleted_at + (${input.minimumDays} * interval '1 day') <= ${observedAt}::timestamptz)
      )
    ORDER BY record.deleted_at DESC, record.id
    LIMIT ${input.perPage} OFFSET ${input.offset}
  `;
  return {
    observedAt,
    total: Number(countRow?.total ?? 0),
    items: rows.map((row) => ({
      recordId: row.record_id,
      tableId: row.table_id,
      tableName: row.table_name,
      deletedAt: row.deleted_at.toISOString(),
      notBefore: row.not_before?.toISOString() ?? null,
      status: row.finalized_at !== null ? "protected" : row.not_before!.toISOString() > observedAt ? "retained" : "reached",
    })),
  };
};

export const getFileContent = async (baseId: string, fileId: string, locale?: string): Promise<Result<RetentionFileContent>> => {
  const [row] = await sql<Array<{ filename: string; mime_type: string; bytes: Uint8Array }>>`
    SELECT file.filename, file.mime_type, file.bytes
    FROM grids.file_retention_candidates candidate
    JOIN grids.files file ON file.id = candidate.file_id
    WHERE candidate.base_id = ${baseId}::uuid AND candidate.file_id = ${fileId}::uuid
  `;
  return row
    ? ok({ filename: row.filename, mimeType: row.mime_type, bytes: row.bytes })
    : fail(err.notFound(serviceMessagesFor(locale).retainedFile));
};
