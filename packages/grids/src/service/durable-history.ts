import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { logAudit, type SqlClient } from "./audit";
import { listByTable as listFields } from "./fields";
import { parseJsonbRow } from "./jsonb";
import { serviceMessagesFor } from "./messages";
import { insertWithShortIdForDb } from "./short-id";
import type { Field } from "./types";

const BASELINE_BATCH_SIZE = 100;

type DurableHistoryAction =
  | "baseline"
  | "created"
  | "updated"
  | "deleted"
  | "restored"
  | "finalized"
  | "file.added"
  | "file.replaced"
  | "file.removed";

export type DurableHistoryStatus =
  | { enabled: false }
  | {
      enabled: true;
      status: "activating" | "active";
      activatedAt: string;
      activatedBy: string | null;
      baselineCompletedAt: string | null;
      baseline: { captured: number; total: number };
    };

type RecordRevisionFile = {
  id: string;
  fieldId: string;
  position: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

type HistoricalFileContent = RecordRevisionFile & { bytes: Uint8Array };

export type RecordRevision = {
  id: string;
  shortId: string;
  tableId: string;
  recordId: string;
  revisionNo: number;
  action: DurableHistoryAction;
  recordVersion: number;
  data: Record<string, unknown>;
  relations: Record<string, string[]>;
  files: RecordRevisionFile[];
  changedFieldIds: string[];
  deletedAt: string | null;
  actorId: string | null;
  actorDisplayName: string | null;
  actorAvatarHash: string | null;
  createdAt: string;
  schema: { id: string; fields: Field[] };
};

type ActivationRow = {
  table_id: string;
  baseline_schema_revision_id: string;
  status: "activating" | "active";
  activated_by: string | null;
  activated_at: Date | string;
  baseline_completed_at: Date | string | null;
};

type RevisionRow = Record<string, unknown> & {
  actor_display_name?: string | null;
  actor_avatar_hash?: string | null;
  schema_fields: unknown;
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const parseUuidArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  if (value.startsWith("[")) {
    const parsed = parseJsonbRow<unknown[]>(value, []);
    return parsed.filter((item): item is string => typeof item === "string");
  }
  if (value.startsWith("{") && value.endsWith("}")) return value.slice(1, -1).split(",").filter(Boolean);
  return [];
};

const activation = async (tableId: string, client: SqlClient = sql): Promise<ActivationRow | null> => {
  const [row] = await client<ActivationRow[]>`
    SELECT table_id::text, baseline_schema_revision_id::text, status, activated_by::text,
           activated_at, baseline_completed_at
    FROM grids.durable_history_activations
    WHERE table_id = ${tableId}::uuid
  `;
  return row ?? null;
};

export const lockDurableHistoryMutationBoundary = async (client: SqlClient, tableId: string): Promise<void> => {
  await client`SELECT pg_advisory_xact_lock_shared(hashtextextended(${"grids:durable-history:" + tableId}, 0))`;
};

const lockActivationBoundary = async (client: SqlClient, tableId: string): Promise<void> => {
  await client`SELECT pg_advisory_xact_lock(hashtextextended(${"grids:durable-history:" + tableId}, 0))`;
};

const schemaHash = (fields: readonly Field[]): string => new Bun.CryptoHasher("sha256").update(JSON.stringify(fields)).digest("hex");

const ensureSchemaRevision = async (
  client: SqlClient,
  tableId: string,
  schemaFields?: readonly Field[],
): Promise<{ id: string; fields: Field[] }> => {
  const fields = schemaFields ? [...schemaFields] : await listFields(tableId, true, client);
  const hash = schemaHash(fields);
  const [existing] = await client<Array<{ id: string }>>`
    SELECT id::text AS id
    FROM grids.table_schema_revisions
    WHERE table_id = ${tableId}::uuid AND schema_hash = ${hash}
  `;
  if (existing) return { id: existing.id, fields };
  const [created] = await client<Array<{ id: string }>>`
    INSERT INTO grids.table_schema_revisions (table_id, schema_hash, fields)
    VALUES (${tableId}::uuid, ${hash}, ${fields}::jsonb)
    ON CONFLICT (table_id, schema_hash) DO UPDATE SET schema_hash = EXCLUDED.schema_hash
    RETURNING id::text AS id
  `;
  if (!created) throw new Error("durable history schema revision insert returned no row");
  return { id: created.id, fields };
};

const loadSnapshot = async (
  client: SqlClient,
  tableId: string,
  recordId: string,
): Promise<{
  recordVersion: number;
  data: Record<string, unknown>;
  relations: Record<string, string[]>;
  files: RecordRevisionFile[];
  deletedAt: string | null;
}> => {
  const [record] = await client<Array<{ version: number; data: unknown; deleted_at: Date | string | null }>>`
    SELECT version, data, deleted_at
    FROM grids.records
    WHERE id = ${recordId}::uuid AND table_id = ${tableId}::uuid
  `;
  if (!record) throw new Error("durable history source record is missing");
  const relationRows = await client<Array<{ field_id: string; record_ids: string[] }>>`
    SELECT link.from_field_id::text AS field_id,
           array_agg(link.to_record_id::text ORDER BY link.position, link.to_record_id) AS record_ids
    FROM grids.record_links link
    WHERE link.from_record_id = ${recordId}::uuid
    GROUP BY link.from_field_id
  `;
  const fileRows = await client<
    Array<{
      id: string;
      field_id: string;
      position: number;
      filename: string;
      mime_type: string;
      size_bytes: number | string;
      sha256: string;
    }>
  >`
    SELECT file.id::text AS id, attachment.field_id::text, attachment.position,
           file.filename, file.mime_type, file.size_bytes, file.sha256
    FROM grids.file_attachments attachment
    JOIN grids.files file ON file.id = attachment.file_id
    WHERE attachment.record_id = ${recordId}::uuid
    ORDER BY attachment.field_id, attachment.position, file.id
  `;
  return {
    recordVersion: record.version,
    data: parseJsonbRow(record.data, {}),
    relations: Object.fromEntries(relationRows.map((row) => [row.field_id, row.record_ids])),
    files: fileRows.map((row) => ({
      id: row.id,
      fieldId: row.field_id,
      position: row.position,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
    })),
    deletedAt: record.deleted_at ? iso(record.deleted_at) : null,
  };
};

const insertRevision = async (
  client: SqlClient,
  input: {
    tableId: string;
    recordId: string;
    schemaRevisionId: string;
    action: DurableHistoryAction;
    changedFieldIds: string[];
    actorId: string | null;
  },
): Promise<RecordRevision> => {
  const snapshot = await loadSnapshot(client, input.tableId, input.recordId);
  const [next] = await client<Array<{ revision_no: number }>>`
    SELECT COALESCE(MAX(revision_no) + 1, 1)::int AS revision_no
    FROM grids.record_revisions
    WHERE table_id = ${input.tableId}::uuid AND record_id = ${input.recordId}::uuid
  `;
  const id = Bun.randomUUIDv7();
  const row = await insertWithShortIdForDb(client, "idx_grids_record_revisions_short_id", async (attempt, shortId) => {
    const [created] = await attempt<RevisionRow[]>`
      INSERT INTO grids.record_revisions (
        id, short_id, table_id, record_id, schema_revision_id, revision_no, action,
        record_version, data, relations, files, changed_field_ids, deleted_at, actor_id,
        actor_display_name, actor_avatar_hash
      ) VALUES (
        ${id}::uuid, ${shortId}, ${input.tableId}::uuid, ${input.recordId}::uuid,
        ${input.schemaRevisionId}::uuid, ${next?.revision_no ?? 1}, ${input.action},
        ${snapshot.recordVersion}, ${snapshot.data}::jsonb, ${snapshot.relations}::jsonb,
        ${snapshot.files}::jsonb, ${attempt.array(input.changedFieldIds, "UUID")}::uuid[],
        ${snapshot.deletedAt}::timestamptz, ${input.actorId}::uuid,
        (SELECT COALESCE(actor.display_name, actor.uid) FROM auth.users actor WHERE actor.id = ${input.actorId}::uuid),
        (SELECT actor.avatar_hash FROM auth.users actor WHERE actor.id = ${input.actorId}::uuid)
      )
      RETURNING *
    `;
    if (!created) throw new Error("durable history revision insert returned no row");
    return created;
  });
  const [scope] = await client<Array<{ base_id: string }>>`
    SELECT base_id::text FROM grids.tables WHERE id = ${input.tableId}::uuid
  `;
  if (!scope) throw new Error("durable history table scope is missing");
  for (const file of snapshot.files) {
    const [asset] = await client<Array<{ id: string }>>`
      SELECT id::text AS id FROM grids.files WHERE id = ${file.id}::uuid FOR UPDATE
    `;
    if (!asset) throw new Error("durable history file asset is missing");
    await client`
      INSERT INTO grids.file_protected_references (
        file_id, owner_kind, owner_id, base_id, table_id, record_id, created_by
      ) VALUES (
        ${file.id}::uuid, 'record_revision', ${id}::uuid, ${scope.base_id}::uuid,
        ${input.tableId}::uuid, ${input.recordId}::uuid, ${input.actorId}::uuid
      )
      ON CONFLICT (file_id, owner_kind, owner_id) DO NOTHING
    `;
  }
  const [schema] = await client<Array<{ fields: unknown }>>`
    SELECT fields FROM grids.table_schema_revisions WHERE id = ${input.schemaRevisionId}::uuid
  `;
  return mapRevision({ ...row, schema_fields: schema?.fields ?? [] });
};

const mapRevision = (row: RevisionRow): RecordRevision => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  recordId: row.record_id as string,
  revisionNo: Number(row.revision_no),
  action: row.action as DurableHistoryAction,
  recordVersion: Number(row.record_version),
  data: parseJsonbRow(row.data, {}),
  relations: parseJsonbRow(row.relations, {}),
  files: parseJsonbRow(row.files, []),
  changedFieldIds: parseUuidArray(row.changed_field_ids),
  deletedAt: row.deleted_at ? iso(row.deleted_at as Date | string) : null,
  actorId: (row.actor_id as string | null) ?? null,
  actorDisplayName: row.actor_display_name ?? null,
  actorAvatarHash: row.actor_avatar_hash ?? null,
  createdAt: iso(row.created_at as Date | string),
  schema: { id: row.schema_revision_id as string, fields: parseJsonbRow(row.schema_fields, []) },
});

export const prepareRecordMutation = async (client: SqlClient, tableId: string, recordId: string): Promise<boolean> => {
  const enabled = await activation(tableId, client);
  if (!enabled) return false;
  const [record] = await client<Array<{ existed_at_boundary: boolean }>>`
    SELECT (
      record.created_at <= activation.activated_at
      AND (record.deleted_at IS NULL OR record.deleted_at > activation.activated_at)
    ) AS existed_at_boundary
    FROM grids.records record
    JOIN grids.durable_history_activations activation ON activation.table_id = record.table_id
    WHERE record.id = ${recordId}::uuid AND record.table_id = ${tableId}::uuid
    FOR UPDATE OF record
  `;
  if (!record) throw new Error("durable history mutation record is missing");
  if (record.existed_at_boundary) {
    const [baseline] = await client<Array<{ id: string }>>`
      SELECT id::text AS id
      FROM grids.record_revisions
      WHERE table_id = ${tableId}::uuid AND record_id = ${recordId}::uuid AND action = 'baseline'
    `;
    if (!baseline) {
      await insertRevision(client, {
        tableId,
        recordId,
        schemaRevisionId: enabled.baseline_schema_revision_id,
        action: "baseline",
        changedFieldIds: [],
        actorId: enabled.activated_by,
      });
    }
  }
  return true;
};

export const captureRecordRevision = async (
  client: SqlClient,
  input: {
    tableId: string;
    recordId: string;
    action: Exclude<DurableHistoryAction, "baseline">;
    changedFieldIds?: string[];
    actorId: string | null;
    schemaFields?: readonly Field[];
  },
): Promise<RecordRevision | null> => {
  if (!(await activation(input.tableId, client))) return null;
  const schema = await ensureSchemaRevision(client, input.tableId, input.schemaFields);
  return insertRevision(client, {
    tableId: input.tableId,
    recordId: input.recordId,
    action: input.action,
    actorId: input.actorId,
    schemaRevisionId: schema.id,
    changedFieldIds: input.changedFieldIds ?? [],
  });
};

const statusFor = async (tableId: string, client: SqlClient = sql): Promise<DurableHistoryStatus> => {
  const enabled = await activation(tableId, client);
  if (!enabled) return { enabled: false };
  const [counts] = await client<Array<{ total: number; captured: number }>>`
    SELECT
      COUNT(*) FILTER (
        WHERE record.created_at <= activation.activated_at
          AND (record.deleted_at IS NULL OR record.deleted_at > activation.activated_at)
      )::int AS total,
      COUNT(revision.id) FILTER (
        WHERE record.created_at <= activation.activated_at
          AND (record.deleted_at IS NULL OR record.deleted_at > activation.activated_at)
      )::int AS captured
    FROM grids.records record
    JOIN grids.durable_history_activations activation ON activation.table_id = record.table_id
    LEFT JOIN grids.record_revisions revision
      ON revision.table_id = record.table_id AND revision.record_id = record.id AND revision.action = 'baseline'
    WHERE record.table_id = ${tableId}::uuid
  `;
  return {
    enabled: true,
    status: enabled.status,
    activatedAt: iso(enabled.activated_at),
    activatedBy: enabled.activated_by,
    baselineCompletedAt: enabled.baseline_completed_at ? iso(enabled.baseline_completed_at) : null,
    baseline: { captured: counts?.captured ?? 0, total: counts?.total ?? 0 },
  };
};

export const getStatus = async (tableId: string, locale?: string): Promise<Result<DurableHistoryStatus>> => {
  const t = serviceMessagesFor(locale);
  const [table] = await sql<Array<{ kind: string }>>`
    SELECT kind FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL
  `;
  if (!table) return fail(err.notFound(t.table));
  if (table.kind !== "stored") return fail(err.badInput(t.durableStoredOnly));
  return ok(await statusFor(tableId));
};

export const continueActivation = async (tableId: string, locale?: string): Promise<Result<DurableHistoryStatus>> =>
  sql.begin(async (tx) => {
    const t = serviceMessagesFor(locale);
    const enabled = await activation(tableId, tx);
    if (!enabled) return fail(err.badInput(t.durableNotEnabled));
    if (enabled.status === "active") return ok(await statusFor(tableId, tx));
    const records = await tx<Array<{ id: string }>>`
      SELECT record.id::text AS id
      FROM grids.records record
      JOIN grids.durable_history_activations activation ON activation.table_id = record.table_id
      WHERE record.table_id = ${tableId}::uuid
        AND record.created_at <= activation.activated_at
        AND (record.deleted_at IS NULL OR record.deleted_at > activation.activated_at)
        AND NOT EXISTS (
          SELECT 1 FROM grids.record_revisions revision
          WHERE revision.table_id = record.table_id AND revision.record_id = record.id AND revision.action = 'baseline'
        )
      ORDER BY record.id
      LIMIT ${BASELINE_BATCH_SIZE}
      FOR UPDATE OF record SKIP LOCKED
    `;
    for (const record of records) await prepareRecordMutation(tx, tableId, record.id);
    const [remaining] = await tx<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM grids.records record
        JOIN grids.durable_history_activations activation ON activation.table_id = record.table_id
        WHERE record.table_id = ${tableId}::uuid
          AND record.created_at <= activation.activated_at
          AND (record.deleted_at IS NULL OR record.deleted_at > activation.activated_at)
          AND NOT EXISTS (
            SELECT 1 FROM grids.record_revisions revision
            WHERE revision.table_id = record.table_id AND revision.record_id = record.id AND revision.action = 'baseline'
          )
      ) AS exists
    `;
    if (!remaining?.exists) {
      await tx`
        UPDATE grids.durable_history_activations
        SET status = 'active', baseline_completed_at = COALESCE(baseline_completed_at, now())
        WHERE table_id = ${tableId}::uuid
      `;
    }
    return ok(await statusFor(tableId, tx));
  });

export const enable = async (tableId: string, actorId: string | null, locale?: string): Promise<Result<DurableHistoryStatus>> => {
  const t = serviceMessagesFor(locale);
  const started = await sql.begin(async (tx): Promise<Result<void>> => {
    await lockActivationBoundary(tx, tableId);
    const [table] = await tx<Array<{ base_id: string; kind: string }>>`
      SELECT base_id::text AS base_id, kind
      FROM grids.tables
      WHERE id = ${tableId}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!table) return fail(err.notFound(t.table));
    if (table.kind !== "stored") return fail(err.badInput(t.durableStoredOnly));
    if (await activation(tableId, tx)) return ok();
    const schema = await ensureSchemaRevision(tx, tableId);
    const [created] = await tx<Array<{ activated_at: Date | string }>>`
      INSERT INTO grids.durable_history_activations (
        table_id, baseline_schema_revision_id, status, activated_by, activated_at
      ) VALUES (${tableId}::uuid, ${schema.id}::uuid, 'activating', ${actorId}::uuid, now())
      RETURNING activated_at
    `;
    if (!created) throw new Error("durable history activation insert returned no row");
    await logAudit(
      {
        baseId: table.base_id,
        tableId,
        userId: actorId,
        action: "durable_history.enabled",
        diff: { durableHistory: { old: false, new: { enabled: true, startsAt: iso(created.activated_at) } } },
      },
      tx,
    );
    return ok();
  });
  return started.ok ? continueActivation(tableId, locale) : started;
};

export const listRecordRevisions = async (params: {
  tableId: string;
  recordId: string;
  limit?: number;
  cursor?: string | null;
  locale?: string;
}): Promise<Result<{ status: DurableHistoryStatus; items: RecordRevision[]; nextCursor: string | null }>> => {
  const historyStatus = await statusFor(params.tableId);
  if (!historyStatus.enabled) return ok({ status: historyStatus, items: [], nextCursor: null });
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  if (params.cursor) {
    const [row] = await sql<Array<{ exists: boolean }>>`
      SELECT TRUE AS exists
      FROM grids.record_revisions
      WHERE short_id = ${params.cursor}
        AND table_id = ${params.tableId}::uuid
        AND record_id = ${params.recordId}::uuid
    `;
    if (!row) return fail(err.badInput(serviceMessagesFor(params.locale).invalidHistoryCursor));
  }
  const rows = await sql<RevisionRow[]>`
    SELECT revision.*, schema_revision.fields AS schema_fields
    FROM grids.record_revisions revision
    JOIN grids.table_schema_revisions schema_revision ON schema_revision.id = revision.schema_revision_id
    WHERE revision.table_id = ${params.tableId}::uuid
      AND revision.record_id = ${params.recordId}::uuid
      AND (
        ${params.cursor ?? null}::text IS NULL
        OR revision.revision_no < (
          SELECT cursor.revision_no
          FROM grids.record_revisions cursor
          WHERE cursor.short_id = ${params.cursor ?? null}
            AND cursor.table_id = ${params.tableId}::uuid
            AND cursor.record_id = ${params.recordId}::uuid
        )
      )
    ORDER BY revision.revision_no DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return ok({
    status: historyStatus,
    items: pageRows.map(mapRevision),
    nextCursor: hasMore ? ((pageRows.at(-1)?.short_id as string | undefined) ?? null) : null,
  });
};

export const getRevision = async (tableId: string, recordId: string, revisionShortId: string): Promise<RecordRevision | null> => {
  const [row] = await sql<RevisionRow[]>`
    SELECT revision.*, schema_revision.fields AS schema_fields
    FROM grids.record_revisions revision
    JOIN grids.table_schema_revisions schema_revision ON schema_revision.id = revision.schema_revision_id
    WHERE revision.short_id = ${revisionShortId}
      AND revision.table_id = ${tableId}::uuid
      AND revision.record_id = ${recordId}::uuid
  `;
  return row ? mapRevision(row) : null;
};

export const getRevisionFileContent = async (params: {
  tableId: string;
  recordId: string;
  revisionShortId: string;
  fileId: string;
  locale?: string;
}): Promise<Result<HistoricalFileContent>> => {
  const revision = await getRevision(params.tableId, params.recordId, params.revisionShortId);
  const snapshotFile = revision?.files.find((file) => file.id === params.fileId);
  if (!revision || !snapshotFile) return fail(err.notFound(serviceMessagesFor(params.locale).historicalFile));
  const [row] = await sql<
    Array<{
      id: string;
      filename: string;
      mime_type: string;
      size_bytes: number | string;
      sha256: string;
      bytes: Uint8Array;
    }>
  >`
    SELECT file.id::text AS id, file.filename, file.mime_type, file.size_bytes, file.sha256, file.bytes
    FROM grids.file_protected_references protection
    JOIN grids.files file ON file.id = protection.file_id
    WHERE protection.file_id = ${params.fileId}::uuid
      AND protection.owner_kind = 'record_revision'
      AND protection.owner_id = ${revision.id}::uuid
  `;
  if (!row) return fail(err.notFound(serviceMessagesFor(params.locale).historicalFile));
  return ok({
    id: row.id,
    fieldId: snapshotFile.fieldId,
    position: snapshotFile.position,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    bytes: row.bytes,
  });
};
