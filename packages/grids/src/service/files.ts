import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { logAudit, type SqlClient } from "./audit";
import { captureRecordRevision, lockDurableHistoryMutationBoundary, prepareRecordMutation } from "./durable-history";
import { type FederatedRevisionScope, getActive, verifyRevisionScope } from "./federated-tables";
import { assertMutationAllowed, type MutationOrigin } from "./mutation-policy";
import { assertRecordMutable, supersedePendingFinalizationRequest } from "./record-finalization";
import { insertWithShortIdForDb } from "./short-id";
import { get as getTable } from "./tables";
import type { GridFile, GridFileContent, GridFilePreview } from "./types";

type FileFieldConfig = {
  maxFiles?: number;
  accept?: string[];
};

type DbRow = {
  id: string;
  short_id: string;
  record_id: string;
  field_id: string;
  position: number;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  sha256: string;
  created_by: string | null;
  created_at: Date | string;
};

export type FileProtectionOwnerKind = "record_revision" | "document_artifact";

export type ProtectedFileContent = {
  id: string;
  shortId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdBy: string | null;
  createdAt: string;
  bytes: Uint8Array;
};

export type ProtectedFileAsset = Omit<ProtectedFileContent, "bytes">;

const mapRow = (row: DbRow, targetFieldId = row.field_id, exposeCreatedBy = true): GridFile => ({
  id: row.id,
  shortId: row.short_id,
  recordId: row.record_id,
  fieldId: targetFieldId,
  position: row.position,
  filename: row.filename,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
  createdBy: exposeCreatedBy ? row.created_by : null,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
});

const normalizeFilename = (name: string): string => {
  const trimmed = name.trim().replace(/[\\/]/g, "_");
  return trimmed.length > 0 ? trimmed.slice(0, 255) : "untitled";
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const auditMetadata = (file: GridFile) => ({
  id: file.shortId,
  filename: file.filename,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
});

const lockMutationTarget = async (client: SqlClient, recordId: string, fieldId: string): Promise<void> => {
  await client`SELECT pg_advisory_xact_lock(hashtext(${recordId}), hashtext(${fieldId}))`;
};

const settleUnreferenced = async (client: SqlClient, fileId: string, owner?: { baseId: string; tableId?: string }): Promise<boolean> => {
  const [state] = await client<Array<{ attached: boolean; protected: boolean; candidate_base_id: string | null }>>`
    SELECT
      EXISTS (SELECT 1 FROM grids.file_attachments attachment WHERE attachment.file_id = file.id) AS attached,
      EXISTS (SELECT 1 FROM grids.file_protected_references protected WHERE protected.file_id = file.id) AS protected,
      candidate.base_id::text AS candidate_base_id
    FROM grids.files file
    LEFT JOIN grids.file_retention_candidates candidate ON candidate.file_id = file.id
    WHERE file.id = ${fileId}::uuid
  `;
  if (!state) return false;
  if (state.attached || state.protected) {
    await client`DELETE FROM grids.file_retention_candidates WHERE file_id = ${fileId}::uuid`;
    return false;
  }

  const baseId = owner?.baseId ?? state.candidate_base_id;
  if (baseId) {
    const [policy] = await client<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM grids.retention_policies WHERE base_id = ${baseId}::uuid) AS exists
    `;
    if (policy?.exists) {
      await client`
        INSERT INTO grids.file_retention_candidates (file_id, base_id, table_id, table_short_id, table_name)
        SELECT ${fileId}::uuid, ${baseId}::uuid, table_info.id, table_info.short_id, table_info.name
        FROM (VALUES (1)) seed(value)
        LEFT JOIN grids.tables table_info
          ON table_info.id = ${owner?.tableId ?? null}::uuid AND table_info.base_id = ${baseId}::uuid
        ON CONFLICT (file_id) DO UPDATE SET
          base_id = EXCLUDED.base_id,
          table_id = COALESCE(grids.file_retention_candidates.table_id, EXCLUDED.table_id),
          table_short_id = COALESCE(grids.file_retention_candidates.table_short_id, EXCLUDED.table_short_id),
          table_name = COALESCE(grids.file_retention_candidates.table_name, EXCLUDED.table_name)
      `;
      return false;
    }
  }

  await client`DELETE FROM grids.file_retention_candidates WHERE file_id = ${fileId}::uuid`;
  const rows = await client<{ id: string }[]>`
    DELETE FROM grids.files file
    WHERE file.id = ${fileId}::uuid
      AND NOT EXISTS (SELECT 1 FROM grids.file_attachments attachment WHERE attachment.file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM grids.file_protected_references protected WHERE protected.file_id = file.id)
    RETURNING file.id::text AS id
  `;
  return rows.length > 0;
};

const verifyTarget = async (
  tableId: string,
  recordId: string,
  fieldId: string,
): Promise<Result<{ baseId: string; config: FileFieldConfig }>> => {
  const table = await getTable(tableId);
  if (!table) return fail(err.notFound("Table"));
  if (table.kind === "federated") return fail(err.badInput("combined tables are read-only"));
  const [row] = await sql<{ record_ok: boolean; field_ok: boolean; config: unknown }[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM grids.records r
        JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE r.id = ${recordId}::uuid
          AND r.table_id = ${tableId}::uuid
          AND r.deleted_at IS NULL
      ) AS record_ok,
      COALESCE((
        SELECT TRUE
        FROM grids.fields f
        WHERE f.id = ${fieldId}::uuid
          AND f.table_id = ${tableId}::uuid
          AND f.type = 'file'
          AND f.deleted_at IS NULL
      ), FALSE) AS field_ok,
      (
        SELECT f.config
        FROM grids.fields f
        WHERE f.id = ${fieldId}::uuid
          AND f.table_id = ${tableId}::uuid
          AND f.type = 'file'
          AND f.deleted_at IS NULL
      ) AS config
  `;
  if (!row?.record_ok) return fail(err.notFound("Record"));
  if (!row.field_ok) return fail(err.badInput("field is not a live file field on this table"));
  return ok({ baseId: table.baseId, config: (row.config && typeof row.config === "object" ? row.config : {}) as FileFieldConfig });
};

type ReadTarget = {
  sourceTableId: string;
  sourceFieldId: string | null;
  targetFieldId: string;
  publication: { tableId: string; revisionId: string; revisionToken: string; sourceCount: number } | null;
};

const resolveReadTargets = async (params: {
  tableId: string;
  recordId: string;
  fieldIds: string[];
}): Promise<Result<Map<string, ReadTarget>>> => {
  const table = await getTable(params.tableId);
  if (!table) return fail(err.notFound("Table"));
  if (table.kind === "stored") {
    const [record] = await sql<Array<{ record_ok: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM grids.records record
        JOIN grids.tables table_row ON table_row.id = record.table_id AND table_row.deleted_at IS NULL
        JOIN grids.bases base ON base.id = table_row.base_id AND base.deleted_at IS NULL
        WHERE record.id = ${params.recordId}::uuid
          AND record.table_id = ${params.tableId}::uuid
          AND record.deleted_at IS NULL
      ) AS record_ok
    `;
    if (!record?.record_ok) return fail(err.notFound("Record"));
    const fields = await sql<Array<{ id: string }>>`
      SELECT id::text
      FROM grids.fields
      WHERE table_id = ${params.tableId}::uuid
        AND id = ANY(${sql.array(params.fieldIds, "UUID")}::uuid[])
        AND type = 'file'
        AND deleted_at IS NULL
    `;
    return ok(
      new Map(
        fields.map((field) => [
          field.id,
          {
            sourceTableId: params.tableId,
            sourceFieldId: field.id,
            targetFieldId: field.id,
            publication: null,
          },
        ]),
      ),
    );
  }

  const active = await getActive(params.tableId);
  if (!active.ok) return fail(active.error);
  const sourceTableIds = active.data.sources.map((source) => source.sourceTableId);
  const [record] = await sql<Array<{ table_id: string }>>`
    SELECT table_id::text
    FROM grids.records
    WHERE id = ${params.recordId}::uuid
      AND table_id = ANY(${sql.array(sourceTableIds, "UUID")}::uuid[])
      AND deleted_at IS NULL
  `;
  if (!record) return fail(err.notFound("Record"));
  const targetFields = await sql<Array<{ id: string }>>`
    SELECT id::text
    FROM grids.fields
    WHERE id = ANY(${sql.array(params.fieldIds, "UUID")}::uuid[])
      AND table_id = ${params.tableId}::uuid
      AND type = 'file'
      AND deleted_at IS NULL
  `;
  const targetFieldIds = new Set(targetFields.map((field) => field.id));
  const mappings = active.data.mappings.filter(
    (candidate) => candidate.sourceTableId === record.table_id && targetFieldIds.has(candidate.targetFieldId),
  );
  const mappingByTarget = new Map(mappings.map((mapping) => [mapping.targetFieldId, mapping.sourceFieldId]));
  return ok(
    new Map(
      targetFields.map((field) => [
        field.id,
        {
          sourceTableId: record.table_id,
          sourceFieldId: mappingByTarget.get(field.id) ?? null,
          targetFieldId: field.id,
          publication: {
            tableId: params.tableId,
            revisionId: active.data.id,
            revisionToken: active.data.revisionToken,
            sourceCount: active.data.sources.length,
          },
        },
      ]),
    ),
  );
};

const resolveReadTarget = async (params: { tableId: string; recordId: string; fieldId: string }): Promise<Result<ReadTarget>> => {
  const targets = await resolveReadTargets({ ...params, fieldIds: [params.fieldId] });
  if (!targets.ok) return targets;
  const target = targets.data.get(params.fieldId);
  return target ? ok(target) : fail(err.badInput("field is not a live file field on this table"));
};

const publicationGuard = (target: ReadTarget): unknown =>
  target.publication
    ? sql`grids.assert_federated_revision(
        ${target.publication.tableId}::uuid,
        ${target.publication.revisionId}::uuid,
        ${target.publication.revisionToken}::text,
        ${target.publication.sourceCount}::int
      )`
    : sql`TRUE`;

const matchesAccept = (filename: string, mimeType: string, accept: string[] | undefined): boolean => {
  if (!accept || accept.length === 0) return true;
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return accept.some((raw) => {
    const token = raw.trim().toLowerCase();
    if (token.length === 0) return false;
    if (token.startsWith(".")) return lowerName.endsWith(token);
    if (token.endsWith("/*")) return lowerMime.startsWith(token.slice(0, -1));
    return lowerMime === token;
  });
};

export const listForRecordField = async (params: { tableId: string; recordId: string; fieldId: string }): Promise<Result<GridFile[]>> => {
  const target = await resolveReadTarget(params);
  if (!target.ok) return target;
  if (!target.data.sourceFieldId) return ok([]);
  const rows = await sql<DbRow[]>`
    SELECT file.id::text AS id, file.short_id, attachment.record_id::text AS record_id, attachment.field_id::text AS field_id,
           attachment.position, file.filename, file.mime_type, file.size_bytes, file.sha256,
           file.created_by::text AS created_by, file.created_at
    FROM grids.file_attachments attachment
    JOIN grids.files file ON file.id = attachment.file_id
    WHERE attachment.record_id = ${params.recordId}::uuid AND attachment.field_id = ${target.data.sourceFieldId}::uuid
      AND ${publicationGuard(target.data)}
    ORDER BY attachment.position, file.created_at, file.id
  `;
  return ok(rows.map((row) => mapRow(row, target.data.targetFieldId, target.data.publication === null)));
};

export const listForRecord = async (params: {
  tableId: string;
  recordId: string;
  fieldIds: string[];
}): Promise<Record<string, GridFile[]>> => {
  const fieldIds = [...new Set(params.fieldIds)].filter(Boolean);
  const filesByField = Object.fromEntries(fieldIds.map((fieldId) => [fieldId, [] as GridFile[]]));
  if (fieldIds.length === 0) return filesByField;
  const resolved = await resolveReadTargets({ ...params, fieldIds });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const mapped = [...resolved.data.values()].filter(
    (target): target is ReadTarget & { sourceFieldId: string } => target.sourceFieldId !== null,
  );
  if (mapped.length === 0) return filesByField;
  const guard = publicationGuard(mapped[0]!);
  const rows = await sql<Array<DbRow & { target_field_id: string }>>`
    SELECT file.id::text AS id, file.short_id, attachment.record_id::text AS record_id, attachment.field_id::text AS field_id,
           mapping.target_field_id::text, attachment.position, file.filename, file.mime_type,
           file.size_bytes, file.sha256, file.created_by::text AS created_by, file.created_at
    FROM jsonb_to_recordset(${mapped.map((item) => ({
      target_field_id: item.targetFieldId,
      source_field_id: item.sourceFieldId,
    }))}::jsonb) AS mapping(target_field_id uuid, source_field_id uuid)
    JOIN grids.file_attachments attachment
      ON attachment.record_id = ${params.recordId}::uuid
     AND attachment.field_id = mapping.source_field_id
    JOIN grids.files file ON file.id = attachment.file_id
    WHERE ${guard}
    ORDER BY mapping.target_field_id, attachment.position, file.created_at, file.id
  `;
  for (const row of rows) filesByField[row.target_field_id]?.push(mapRow(row, row.target_field_id, mapped[0]?.publication === null));
  return filesByField;
};

export const listFirstImagePreviews = async (params: {
  tableId: string;
  recordIds: string[];
  fieldIds: string[];
  expectedFederatedRevisionScope?: FederatedRevisionScope;
}): Promise<Record<string, Record<string, GridFilePreview>>> => {
  if (params.expectedFederatedRevisionScope) {
    const current = await verifyRevisionScope(params.expectedFederatedRevisionScope);
    if (!current.ok) throw current.error;
  }
  const recordIds = [...new Set(params.recordIds)].filter(Boolean);
  const fieldIds = [...new Set(params.fieldIds)].filter(Boolean);
  if (recordIds.length === 0 || fieldIds.length === 0) return {};

  const table = await getTable(params.tableId);
  if (!table) return {};
  let mappings: Array<{ record_id: string; target_field_id: string; source_field_id: string }> = [];
  let guard: unknown = sql`TRUE`;
  if (table.kind === "stored") {
    mappings = recordIds.flatMap((recordId) =>
      fieldIds.map((fieldId) => ({ record_id: recordId, target_field_id: fieldId, source_field_id: fieldId })),
    );
  } else {
    const active = await getActive(params.tableId);
    if (!active.ok) throw new Error(active.error.message);
    const expected = params.expectedFederatedRevisionScope?.find((entry) => entry.tableId === params.tableId);
    if (expected && (expected.revisionId !== active.data.id || expected.revisionToken !== active.data.revisionToken)) {
      throw err.conflict("combined table publication changed while file previews were loading; retry the query");
    }
    const sourceTableIds = active.data.sources.map((source) => source.sourceTableId);
    const records = await sql<Array<{ id: string; table_id: string }>>`
      SELECT id::text, table_id::text
      FROM grids.records
      WHERE id = ANY(${sql.array(recordIds, "UUID")}::uuid[])
        AND table_id = ANY(${sql.array(sourceTableIds, "UUID")}::uuid[])
        AND deleted_at IS NULL
    `;
    const mappingBySourceAndTarget = new Map(
      active.data.mappings.map((mapping) => [`${mapping.sourceTableId}:${mapping.targetFieldId}`, mapping.sourceFieldId]),
    );
    mappings = records.flatMap((record) =>
      fieldIds.flatMap((targetFieldId) => {
        const sourceFieldId = mappingBySourceAndTarget.get(`${record.table_id}:${targetFieldId}`);
        return sourceFieldId ? [{ record_id: record.id, target_field_id: targetFieldId, source_field_id: sourceFieldId }] : [];
      }),
    );
    guard = sql`grids.assert_federated_revision(
      ${params.tableId}::uuid,
      ${active.data.id}::uuid,
      ${active.data.revisionToken}::text,
      ${active.data.sources.length}::int
    )`;
  }
  if (mappings.length === 0) return {};

  const rows = await sql<
    Array<{
      id: string;
      record_id: string;
      target_field_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number | string;
    }>
  >`
    SELECT DISTINCT ON (mapping.record_id, mapping.target_field_id)
      file.id::text AS id,
      attachment.record_id::text AS record_id,
      mapping.target_field_id::text,
      file.filename,
      file.mime_type,
      file.size_bytes
    FROM jsonb_to_recordset(${mappings}::jsonb)
      AS mapping(record_id uuid, target_field_id uuid, source_field_id uuid)
    JOIN grids.file_attachments attachment
      ON attachment.record_id = mapping.record_id
     AND attachment.field_id = mapping.source_field_id
    JOIN grids.files file
      ON file.id = attachment.file_id
     AND file.mime_type LIKE 'image/%'
    WHERE ${guard}
    ORDER BY mapping.record_id, mapping.target_field_id, attachment.position, file.created_at, file.id
  `;

  const out: Record<string, Record<string, GridFilePreview>> = {};
  for (const row of rows) {
    out[row.record_id] ??= {};
    out[row.record_id]![row.target_field_id] = {
      fileId: row.id,
      recordId: row.record_id,
      fieldId: row.target_field_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
    };
  }
  return out;
};

export const upload = async (params: {
  tableId: string;
  recordId: string;
  fieldId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  userId: string | null;
  origin: MutationOrigin;
}): Promise<Result<GridFile>> => {
  const target = await verifyTarget(params.tableId, params.recordId, params.fieldId);
  if (!target.ok) return target;
  const filename = normalizeFilename(params.filename);
  if (!matchesAccept(filename, params.mimeType || "application/octet-stream", target.data.config.accept)) {
    return fail(err.badInput("file type is not accepted by this field"));
  }
  const maxFiles = target.data.config.maxFiles;

  return sql.begin(async (tx) => {
    const allowed = await assertMutationAllowed(tx, params.tableId, params.origin);
    if (!allowed.ok) return allowed;
    await lockDurableHistoryMutationBoundary(tx, params.tableId);
    await lockMutationTarget(tx, params.recordId, params.fieldId);
    await prepareRecordMutation(tx, params.tableId, params.recordId);
    const mutable = await assertRecordMutable(tx, params.tableId, params.recordId);
    if (!mutable.ok) return mutable;

    if (typeof maxFiles === "number" && Number.isInteger(maxFiles) && maxFiles > 0) {
      const [countRow] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM grids.file_attachments
        WHERE record_id = ${params.recordId}::uuid AND field_id = ${params.fieldId}::uuid
      `;
      if ((countRow?.count ?? 0) >= maxFiles) {
        return fail(err.badInput(`file field already has the maximum of ${maxFiles} file(s)`));
      }
    }

    const [pos] = await tx<{ position: number }[]>`
      SELECT COALESCE(MAX(position) + 1, 0)::int AS position
      FROM grids.file_attachments
      WHERE record_id = ${params.recordId}::uuid AND field_id = ${params.fieldId}::uuid
    `;
    const row = await insertWithShortIdForDb(tx, "idx_grids_files_short_id", async (attempt, shortId) => {
      const [created] = await attempt<DbRow[]>`
        INSERT INTO grids.files (
          short_id, filename, mime_type, size_bytes, sha256, bytes, created_by
        )
        VALUES (
          ${shortId},
          ${filename},
          ${params.mimeType || "application/octet-stream"},
          ${params.bytes.byteLength},
          ${sha256Hex(params.bytes)},
          ${params.bytes},
          ${params.userId}::uuid
        )
        RETURNING id::text AS id, short_id, filename, mime_type, size_bytes, sha256,
                  created_by::text AS created_by, created_at
      `;
      if (!created) throw new Error("insert returned no row");
      return {
        ...created,
        record_id: params.recordId,
        field_id: params.fieldId,
        position: pos?.position ?? 0,
      } as DbRow;
    });
    if (!row) throw new Error("insert returned no row");
    await tx`
      INSERT INTO grids.file_attachments (file_id, record_id, field_id, position, attached_by)
      VALUES (${row.id}::uuid, ${params.recordId}::uuid, ${params.fieldId}::uuid, ${row.position}, ${params.userId}::uuid)
    `;
    await supersedePendingFinalizationRequest(tx, params.tableId, params.recordId, params.userId);
    const file = mapRow(row);
    await captureRecordRevision(tx, {
      tableId: params.tableId,
      recordId: params.recordId,
      action: "file.added",
      changedFieldIds: [params.fieldId],
      actorId: params.userId,
    });
    await logAudit(
      {
        tableId: params.tableId,
        recordId: params.recordId,
        userId: params.userId,
        action: "file.added",
        diff: { [params.fieldId]: { old: null, new: auditMetadata(file) } },
      },
      tx,
    );
    return ok(file);
  });
};

export const replace = async (params: {
  tableId: string;
  recordId: string;
  fieldId: string;
  fileId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  userId: string | null;
  origin: MutationOrigin;
}): Promise<Result<GridFile>> => {
  const target = await verifyTarget(params.tableId, params.recordId, params.fieldId);
  if (!target.ok) return target;
  const filename = normalizeFilename(params.filename);
  const mimeType = params.mimeType || "application/octet-stream";
  if (!matchesAccept(filename, mimeType, target.data.config.accept)) {
    return fail(err.badInput("file type is not accepted by this field"));
  }

  return sql.begin(async (tx): Promise<Result<GridFile>> => {
    const allowed = await assertMutationAllowed(tx, params.tableId, params.origin);
    if (!allowed.ok) return allowed;
    await lockDurableHistoryMutationBoundary(tx, params.tableId);
    await lockMutationTarget(tx, params.recordId, params.fieldId);
    await prepareRecordMutation(tx, params.tableId, params.recordId);
    const mutable = await assertRecordMutable(tx, params.tableId, params.recordId);
    if (!mutable.ok) return mutable;
    const [existingRow] = await tx<DbRow[]>`
      SELECT file.id::text AS id, file.short_id, attachment.record_id::text AS record_id,
             attachment.field_id::text AS field_id, attachment.position, file.filename, file.mime_type,
             file.size_bytes, file.sha256, file.created_by::text AS created_by, file.created_at
      FROM grids.file_attachments attachment
      JOIN grids.files file ON file.id = attachment.file_id
      WHERE file.id = ${params.fileId}::uuid
        AND attachment.record_id = ${params.recordId}::uuid
        AND attachment.field_id = ${params.fieldId}::uuid
      FOR UPDATE OF file, attachment
    `;
    if (!existingRow) return fail(err.notFound("File"));

    const createdRow = await insertWithShortIdForDb(tx, "idx_grids_files_short_id", async (attempt, shortId) => {
      const [created] = await attempt<Omit<DbRow, "record_id" | "field_id" | "position">[]>`
        INSERT INTO grids.files (short_id, filename, mime_type, size_bytes, sha256, bytes, created_by)
        VALUES (
          ${shortId}, ${filename}, ${mimeType}, ${params.bytes.byteLength},
          ${sha256Hex(params.bytes)}, ${params.bytes}, ${params.userId}::uuid
        )
        RETURNING id::text AS id, short_id, filename, mime_type, size_bytes, sha256,
                  created_by::text AS created_by, created_at
      `;
      if (!created) throw new Error("insert returned no row");
      return created;
    });
    const nextRow: DbRow = {
      ...createdRow,
      record_id: params.recordId,
      field_id: params.fieldId,
      position: existingRow.position,
    };
    await tx`
      UPDATE grids.file_attachments
      SET file_id = ${nextRow.id}::uuid, attached_by = ${params.userId}::uuid, attached_at = now()
      WHERE file_id = ${params.fileId}::uuid
    `;
    await supersedePendingFinalizationRequest(tx, params.tableId, params.recordId, params.userId);
    const previous = mapRow(existingRow);
    const next = mapRow(nextRow);
    await captureRecordRevision(tx, {
      tableId: params.tableId,
      recordId: params.recordId,
      action: "file.replaced",
      changedFieldIds: [params.fieldId],
      actorId: params.userId,
    });
    await logAudit(
      {
        tableId: params.tableId,
        recordId: params.recordId,
        userId: params.userId,
        action: "file.replaced",
        diff: { [params.fieldId]: { old: auditMetadata(previous), new: auditMetadata(next) } },
      },
      tx,
    );
    await settleUnreferenced(tx, params.fileId, { baseId: target.data.baseId, tableId: params.tableId });
    return ok(next);
  });
};

export const getContent = async (params: {
  tableId: string;
  recordId: string;
  fieldId: string;
  fileId: string;
}): Promise<Result<GridFileContent>> => {
  const target = await resolveReadTarget(params);
  if (!target.ok) return target;
  if (!target.data.sourceFieldId) return fail(err.notFound("File"));
  const [row] = await sql<(DbRow & { bytes: Uint8Array })[]>`
    SELECT file.id::text AS id, file.short_id, attachment.record_id::text AS record_id,
           attachment.field_id::text AS field_id, attachment.position, file.filename, file.mime_type,
           file.size_bytes, file.sha256, file.created_by::text AS created_by, file.created_at, file.bytes
    FROM grids.file_attachments attachment
    JOIN grids.files file ON file.id = attachment.file_id
    WHERE file.id = ${params.fileId}::uuid
      AND attachment.record_id = ${params.recordId}::uuid
      AND attachment.field_id = ${target.data.sourceFieldId}::uuid
      AND ${publicationGuard(target.data)}
  `;
  if (!row) return fail(err.notFound("File"));
  return ok({ ...mapRow(row, target.data.targetFieldId, target.data.publication === null), bytes: row.bytes });
};

/** Resolves the only public file identifier to a live internal file. */
export const getByShortId = async (shortId: string): Promise<GridFile | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT file.id::text AS id, file.short_id, attachment.record_id::text AS record_id,
           attachment.field_id::text AS field_id, attachment.position, file.filename, file.mime_type,
           file.size_bytes, file.sha256, file.created_by::text AS created_by, file.created_at
    FROM grids.files file
    JOIN grids.file_attachments attachment ON attachment.file_id = file.id
    JOIN grids.records record ON record.id = attachment.record_id AND record.deleted_at IS NULL
    JOIN grids.tables table_ref ON table_ref.id = record.table_id AND table_ref.deleted_at IS NULL
    JOIN grids.bases base ON base.id = table_ref.base_id AND base.deleted_at IS NULL
    WHERE file.short_id = ${shortId}
  `;
  return row ? mapRow(row) : null;
};

export const remove = async (params: {
  tableId: string;
  recordId: string;
  fieldId: string;
  fileId: string;
  userId?: string | null;
  origin: MutationOrigin;
}): Promise<Result<void>> => {
  const target = await verifyTarget(params.tableId, params.recordId, params.fieldId);
  if (!target.ok) return target;
  return sql.begin(async (tx): Promise<Result<void>> => {
    const allowed = await assertMutationAllowed(tx, params.tableId, params.origin);
    if (!allowed.ok) return allowed;
    await lockDurableHistoryMutationBoundary(tx, params.tableId);
    await lockMutationTarget(tx, params.recordId, params.fieldId);
    await prepareRecordMutation(tx, params.tableId, params.recordId);
    const mutable = await assertRecordMutable(tx, params.tableId, params.recordId);
    if (!mutable.ok) return mutable;
    const [row] = await tx<DbRow[]>`
      SELECT file.id::text AS id, file.short_id, attachment.record_id::text AS record_id,
             attachment.field_id::text AS field_id, attachment.position, file.filename, file.mime_type,
             file.size_bytes, file.sha256, file.created_by::text AS created_by, file.created_at
      FROM grids.file_attachments attachment
      JOIN grids.files file ON file.id = attachment.file_id
      WHERE file.id = ${params.fileId}::uuid
        AND attachment.record_id = ${params.recordId}::uuid
        AND attachment.field_id = ${params.fieldId}::uuid
      FOR UPDATE OF file, attachment
    `;
    if (!row) return fail(err.notFound("File"));
    const file = mapRow(row);
    await tx`DELETE FROM grids.file_attachments WHERE file_id = ${params.fileId}::uuid`;
    await supersedePendingFinalizationRequest(tx, params.tableId, params.recordId, params.userId ?? null);
    await captureRecordRevision(tx, {
      tableId: params.tableId,
      recordId: params.recordId,
      action: "file.removed",
      changedFieldIds: [params.fieldId],
      actorId: params.userId ?? null,
    });
    await logAudit(
      {
        tableId: params.tableId,
        recordId: params.recordId,
        userId: params.userId ?? null,
        action: "file.removed",
        diff: { [params.fieldId]: { old: auditMetadata(file), new: null } },
      },
      tx,
    );
    await settleUnreferenced(tx, params.fileId, { baseId: target.data.baseId, tableId: params.tableId });
    return ok();
  });
};

type ProtectParams = {
  fileId: string;
  ownerKind: FileProtectionOwnerKind;
  ownerId: string;
  baseId: string;
  tableId: string;
  recordId: string;
  userId: string | null;
};

const protectWithClient = async (params: ProtectParams, client: SqlClient): Promise<Result<void>> => {
  const [asset] = await client<{ id: string }[]>`
    SELECT id::text AS id FROM grids.files WHERE id = ${params.fileId}::uuid FOR UPDATE
  `;
  if (!asset) return fail(err.notFound("File"));
  await client`
    INSERT INTO grids.file_protected_references (
      file_id, owner_kind, owner_id, base_id, table_id, record_id, created_by
    )
    VALUES (
      ${params.fileId}::uuid, ${params.ownerKind}, ${params.ownerId}::uuid,
      ${params.baseId}::uuid, ${params.tableId}::uuid, ${params.recordId}::uuid, ${params.userId}::uuid
    )
    ON CONFLICT (file_id, owner_kind, owner_id) DO NOTHING
  `;
  await client`DELETE FROM grids.file_retention_candidates WHERE file_id = ${params.fileId}::uuid`;
  return ok();
};

export const protect = async (params: ProtectParams, client?: SqlClient): Promise<Result<void>> =>
  client ? protectWithClient(params, client) : sql.begin((tx) => protectWithClient(params, tx));

export const createProtected = async (
  params: Omit<ProtectParams, "fileId"> & { filename: string; mimeType: string; bytes: Uint8Array },
  client: SqlClient,
): Promise<Result<ProtectedFileAsset>> => {
  const filename = normalizeFilename(params.filename);
  const mimeType = params.mimeType || "application/octet-stream";
  const sha256 = sha256Hex(params.bytes);
  const row = await insertWithShortIdForDb(client, "idx_grids_files_short_id", async (attempt, shortId) => {
    const [created] = await attempt<
      Array<{
        id: string;
        short_id: string;
        filename: string;
        mime_type: string;
        size_bytes: number | string;
        sha256: string;
        created_by: string | null;
        created_at: Date | string;
      }>
    >`
      INSERT INTO grids.files (short_id, filename, mime_type, size_bytes, sha256, bytes, created_by)
      VALUES (${shortId}, ${filename}, ${mimeType}, ${params.bytes.byteLength}, ${sha256}, ${params.bytes}, ${params.userId}::uuid)
      RETURNING id::text AS id, short_id, filename, mime_type, size_bytes, sha256,
                created_by::text AS created_by, created_at
    `;
    if (!created) throw new Error("insert returned no row");
    return created;
  });
  const protectedResult = await protectWithClient({ ...params, fileId: row.id }, client);
  if (!protectedResult.ok) return protectedResult;
  return ok({
    id: row.id,
    shortId: row.short_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  });
};

type ProtectionIdentity = Pick<ProtectParams, "fileId" | "ownerKind" | "ownerId">;

const releaseProtectionWithClient = async (params: ProtectionIdentity, client: SqlClient): Promise<Result<void>> => {
  const [asset] = await client<{ id: string }[]>`
    SELECT id::text AS id FROM grids.files WHERE id = ${params.fileId}::uuid FOR UPDATE
  `;
  if (!asset) return ok();
  const [released] = await client<Array<{ base_id: string; table_id: string | null }>>`
    DELETE FROM grids.file_protected_references
    WHERE file_id = ${params.fileId}::uuid
      AND owner_kind = ${params.ownerKind}
      AND owner_id = ${params.ownerId}::uuid
    RETURNING base_id::text AS base_id, table_id::text AS table_id
  `;
  if (released) {
    await settleUnreferenced(client, params.fileId, { baseId: released.base_id, tableId: released.table_id ?? undefined });
  }
  return ok();
};

export const releaseProtection = async (params: ProtectionIdentity, client?: SqlClient): Promise<Result<void>> =>
  client ? releaseProtectionWithClient(params, client) : sql.begin((tx) => releaseProtectionWithClient(params, tx));

export const getProtectedContent = async (params: ProtectionIdentity): Promise<Result<ProtectedFileContent>> => {
  const [row] = await sql<
    Array<{
      id: string;
      short_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number | string;
      sha256: string;
      created_by: string | null;
      created_at: Date | string;
      bytes: Uint8Array;
    }>
  >`
    SELECT file.id::text AS id, file.short_id, file.filename, file.mime_type, file.size_bytes,
           file.sha256, file.created_by::text AS created_by, file.created_at, file.bytes
    FROM grids.file_protected_references protected
    JOIN grids.files file ON file.id = protected.file_id
    WHERE protected.file_id = ${params.fileId}::uuid
      AND protected.owner_kind = ${params.ownerKind}
      AND protected.owner_id = ${params.ownerId}::uuid
  `;
  if (!row) return fail(err.notFound("File"));
  return ok({
    id: row.id,
    shortId: row.short_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    bytes: row.bytes,
  });
};

const cleanupWithClient = async (fileId: string, client: SqlClient): Promise<Result<boolean>> => {
  const [asset] = await client<{ id: string }[]>`
    SELECT id::text AS id FROM grids.files WHERE id = ${fileId}::uuid FOR UPDATE
  `;
  if (!asset) return ok(false);
  return ok(await settleUnreferenced(client, fileId));
};

export const cleanup = async (fileId: string, client?: SqlClient): Promise<Result<boolean>> =>
  client ? cleanupWithClient(fileId, client) : sql.begin((tx) => cleanupWithClient(fileId, tx));
