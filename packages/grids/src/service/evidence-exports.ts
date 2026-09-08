import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { ScheduleContext, Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger, toPgTextArray } from "@valentinkolb/cloud/services";
import { type SQL, type SQLQuery, sql } from "bun";
import {
  EVIDENCE_EXPORT_SECTIONS,
  type EvidenceExport,
  EvidenceExportManifestSchema,
  type EvidenceExportPreflight,
  type EvidenceExportSection,
  type EvidenceExportStatus,
} from "../evidence-export-contracts";
import { readDocumentArtifact } from "./document-issuance";
import {
  EVIDENCE_EXPORT_MAX_ENTRIES,
  EVIDENCE_EXPORT_MAX_PACKAGE_BYTES,
  EvidenceExportBoundError,
  EvidenceTarWriter,
  safeArchiveSegment,
} from "./evidence-archive";
import { serviceMessagesFor } from "./messages";
import { insertWithShortIdForDb } from "./short-id";

const PAGE_SIZE = 200;
const MAX_SOURCE_ROWS = 10_000;
const MAX_DURATION_MS = 5 * 60_000;
const ASSET_CHUNK_BYTES = 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const JOB_LEASE_MS = 60_000;
const EXPORT_DELIVERY = { ackWaitMs: JOB_LEASE_MS, maxAttempts: 3, backoffMs: [1_000, 2_000] };
/** After this, a `running` row without a lock holder has outlived every transport attempt. */
const STUCK_EXPORT_MS =
  EXPORT_DELIVERY.ackWaitMs * EXPORT_DELIVERY.maxAttempts + EXPORT_DELIVERY.backoffMs.reduce((sum, ms) => sum + ms, 0);
const STUCK_EXPORT_MESSAGE = "The export worker stopped before finishing. Retry, or ask an operator to inspect the Grids logs.";
const log = logger("grids:evidence-exports");
const CLEANUP_BATCH_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DbRow = Record<string, unknown>;
type EvidenceExportRow = DbRow & {
  id: string;
  short_id: string;
  base_id: string;
  base_short_id: string;
  base_name: string;
  table_id: string | null;
  table_short_id: string | null;
  status: EvidenceExportStatus;
  sections: EvidenceExportSection[];
  range_from: Date | string | null;
  range_to: Date | string | null;
  requested_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  expires_at: Date | string | null;
  cut_at: Date | string | null;
  processed_entries: number | string;
  estimated_entries: number | string | null;
  package_filename: string | null;
  package_size_bytes: number | string | null;
  package_sha256: string | null;
  manifest_sha256: string | null;
  last_error: string | null;
  attempt: number;
  requested_by_display_name: string | null;
};

type ExportScope = {
  baseId: string;
  basePublicId: string;
  baseName: string;
  tableId: string | null;
  tablePublicId: string | null;
  from: string | null;
  to: string | null;
  sections: EvidenceExportSection[];
};

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const readSections = (value: unknown): EvidenceExportSection[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is EvidenceExportSection =>
          typeof item === "string" && EVIDENCE_EXPORT_SECTIONS.includes(item as EvidenceExportSection),
      )
    : [];

const mapExport = (row: EvidenceExportRow): EvidenceExport => ({
  id: row.short_id,
  baseId: row.base_short_id,
  tableId: row.table_short_id,
  status: row.status,
  sections: readSections(row.sections),
  from: iso(row.range_from),
  to: iso(row.range_to),
  requestedAt: iso(row.requested_at)!,
  startedAt: iso(row.started_at),
  completedAt: iso(row.completed_at),
  expiresAt: iso(row.expires_at),
  cutAt: iso(row.cut_at),
  progress: {
    processed: Number(row.processed_entries),
    estimated: row.estimated_entries == null ? null : Number(row.estimated_entries),
  },
  package:
    row.status === "completed" && row.package_filename && row.package_sha256 && row.manifest_sha256
      ? {
          filename: row.package_filename,
          mediaType: "application/x-tar",
          sizeBytes: Number(row.package_size_bytes),
          sha256: row.package_sha256,
          manifestSha256: row.manifest_sha256,
          manifestVersion: 1,
        }
      : null,
  error: row.last_error,
});

const exportSelect = (db: SQL, condition: SQLQuery) => db<EvidenceExportRow[]>`
  SELECT export.*, base.short_id AS base_short_id, base.name AS base_name, table_info.short_id AS table_short_id
  FROM grids.evidence_exports export
  JOIN grids.bases base ON base.id = export.base_id
  LEFT JOIN grids.tables table_info ON table_info.id = export.table_id
  WHERE ${condition}
`;

export const getByShortId = async (shortId: string): Promise<EvidenceExport | null> => {
  await expireByShortId(shortId);
  const [row] = await exportSelect(sql, sql`export.short_id = ${shortId}`);
  return row ? mapExport(row) : null;
};

const loadInternal = async (shortId: string): Promise<EvidenceExportRow | null> => {
  const [row] = await exportSelect(sql, sql`export.short_id = ${shortId}`);
  return row ?? null;
};

export const listByBase = async (baseId: string, limit = 50): Promise<EvidenceExport[]> => {
  await expireCompletedExports(baseId);
  const cap = Math.min(Math.max(limit, 1), 100);
  const rows = await sql<EvidenceExportRow[]>`
    SELECT export.*, base.short_id AS base_short_id, base.name AS base_name, table_info.short_id AS table_short_id
    FROM grids.evidence_exports export
    JOIN grids.bases base ON base.id = export.base_id
    LEFT JOIN grids.tables table_info ON table_info.id = export.table_id
    WHERE export.base_id = ${baseId}::uuid
    ORDER BY export.requested_at DESC, export.id DESC
    LIMIT ${cap}
  `;
  return rows.map(mapExport);
};

// Counts are estimates for user feedback and early rejection only. The worker
// enforces the authoritative entry/byte/time budgets while reading one cut.
export const preflight = async (params: {
  baseId: string;
  tableId: string | null;
  from: string | null;
  to: string | null;
  sections?: readonly EvidenceExportSection[];
  locale?: string;
}): Promise<EvidenceExportPreflight> => {
  const [base] = await sql<Array<{ short_id: string }>>`SELECT short_id FROM grids.bases WHERE id = ${params.baseId}::uuid`;
  if (!base) throw new Error("Base not found");
  const table = params.tableId
    ? (
        await sql<Array<{ short_id: string }>>`
        SELECT short_id FROM grids.tables WHERE id = ${params.tableId}::uuid AND base_id = ${params.baseId}::uuid
      `
      )[0]
    : null;
  if (params.tableId && !table) throw new Error("Table not found");

  const [counts] = await sql<
    Array<{
      records: number | string;
      revisions: number | string;
      audit_events: number | string;
      files: number | string;
      file_bytes: number | string;
      documents: number | string;
      document_entries: number | string;
      document_bytes: number | string;
      number_series: number | string;
      number_series_versions: number | string;
      number_allocations: number | string;
    }>
  >`
    WITH selected_tables AS (
      SELECT id FROM grids.tables WHERE base_id = ${params.baseId}::uuid AND (${params.tableId}::uuid IS NULL OR id = ${params.tableId}::uuid)
    ), selected_revisions AS (
      SELECT id FROM grids.record_revisions
      WHERE table_id IN (SELECT id FROM selected_tables)
        AND (${params.from}::timestamptz IS NULL OR created_at >= ${params.from}::timestamptz)
        AND (${params.to}::timestamptz IS NULL OR created_at <= ${params.to}::timestamptz)
    ), selected_files AS (
      SELECT attachment.file_id
      FROM grids.file_attachments attachment
      JOIN grids.records record ON record.id = attachment.record_id
      WHERE record.table_id IN (SELECT id FROM selected_tables)
      UNION
      SELECT protection.file_id
      FROM grids.file_protected_references protection
      WHERE protection.owner_kind = 'record_revision' AND protection.owner_id IN (SELECT id FROM selected_revisions)
    ), selected_documents AS (
      SELECT id
      FROM grids.documents
      WHERE table_id IN (SELECT id FROM selected_tables)
        AND (${params.from}::timestamptz IS NULL OR created_at >= ${params.from}::timestamptz)
        AND (${params.to}::timestamptz IS NULL OR created_at <= ${params.to}::timestamptz)
    )
    SELECT
      (SELECT count(*) FROM grids.records WHERE table_id IN (SELECT id FROM selected_tables))::int AS records,
      (SELECT count(*) FROM selected_revisions)::int AS revisions,
      (SELECT count(*) FROM grids.audit_log WHERE base_id = ${params.baseId}::uuid
        AND (${params.tableId}::uuid IS NULL OR table_id = ${params.tableId}::uuid)
        AND (${params.from}::timestamptz IS NULL OR created_at >= ${params.from}::timestamptz)
        AND (${params.to}::timestamptz IS NULL OR created_at <= ${params.to}::timestamptz))::int AS audit_events,
      (SELECT count(*) FROM selected_files)::int AS files,
      COALESCE((SELECT sum(file.size_bytes) FROM grids.files file WHERE file.id IN (SELECT file_id FROM selected_files)), 0)::bigint AS file_bytes,
      (SELECT count(*) FROM selected_documents)::int AS documents,
      ((SELECT count(*) FROM selected_documents)
        + (SELECT count(*) FROM grids.document_artifacts
          WHERE document_id IN (SELECT id FROM selected_documents)))::int AS document_entries,
      COALESCE((SELECT sum(file.size_bytes)
        FROM grids.document_artifacts artifact
        JOIN grids.files file ON file.id = artifact.file_id
        WHERE artifact.document_id IN (SELECT id FROM selected_documents)), 0)::bigint AS document_bytes,
      (SELECT count(DISTINCT series.id) FROM grids.number_series series
        LEFT JOIN grids.fields field ON field.id = series.field_id
        LEFT JOIN grids.document_templates template ON template.id = series.document_template_id
        WHERE COALESCE(field.table_id, template.table_id) IN (SELECT id FROM selected_tables))::int AS number_series,
      (SELECT count(*) FROM grids.number_series_versions version
        JOIN grids.number_series series ON series.id = version.series_id
        LEFT JOIN grids.fields field ON field.id = series.field_id
        LEFT JOIN grids.document_templates template ON template.id = series.document_template_id
        WHERE COALESCE(field.table_id, template.table_id) IN (SELECT id FROM selected_tables))::int AS number_series_versions,
      (SELECT count(*) FROM grids.number_allocations allocation
        JOIN grids.number_series series ON series.id = allocation.series_id
        LEFT JOIN grids.fields field ON field.id = series.field_id
        LEFT JOIN grids.document_templates template ON template.id = series.document_template_id
        WHERE COALESCE(field.table_id, template.table_id) IN (SELECT id FROM selected_tables)
          AND (${params.from}::timestamptz IS NULL OR allocation.allocated_at >= ${params.from}::timestamptz)
          AND (${params.to}::timestamptz IS NULL OR allocation.allocated_at <= ${params.to}::timestamptz))::int AS number_allocations
  `;
  const coverageRows = await sql<
    Array<{
      table_short_id: string;
      table_name: string;
      deleted_at: Date | string | null;
      records: number | string;
      finalized_records: number | string;
      activated_at: Date | string | null;
      status: string | null;
      baseline_completed_at: Date | string | null;
      finalization_enabled_at: Date | string | null;
    }>
  >`
    SELECT table_info.short_id AS table_short_id, table_info.name AS table_name, table_info.deleted_at,
           COUNT(record.id)::int AS records,
           COUNT(record.id) FILTER (WHERE record.finalized_at IS NOT NULL)::int AS finalized_records,
           history.activated_at, history.status, history.baseline_completed_at,
           finalization.enabled_at AS finalization_enabled_at
    FROM grids.tables table_info
    LEFT JOIN grids.records record ON record.table_id = table_info.id
    LEFT JOIN grids.durable_history_activations history ON history.table_id = table_info.id
    LEFT JOIN grids.table_finalization_activations finalization ON finalization.table_id = table_info.id
    WHERE table_info.base_id = ${params.baseId}::uuid AND table_info.kind = 'stored'
      AND (${params.tableId}::uuid IS NULL OR table_info.id = ${params.tableId}::uuid)
    GROUP BY table_info.id, history.activated_at, history.status, history.baseline_completed_at, finalization.enabled_at
    ORDER BY table_info.position, table_info.id
  `;
  const known = {
    records: Number(counts?.records ?? 0),
    revisions: Number(counts?.revisions ?? 0),
    auditEvents: Number(counts?.audit_events ?? 0),
    files: Number(counts?.files ?? 0),
    fileBytes: Number(counts?.file_bytes ?? 0),
    documents: Number(counts?.documents ?? 0),
    documentEntries: Number(counts?.document_entries ?? 0),
    documentBytes: Number(counts?.document_bytes ?? 0),
    numberSeries: Number(counts?.number_series ?? 0),
    numberSeriesVersions: Number(counts?.number_series_versions ?? 0),
    numberAllocations: Number(counts?.number_allocations ?? 0),
  };
  const selected = new Set(params.sections ?? EVIDENCE_EXPORT_SECTIONS);
  const estimatedEntries =
    (selected.has("records") ? known.records : 0) +
    (selected.has("revisions") ? known.revisions : 0) +
    (selected.has("audit") ? known.auditEvents : 0) +
    (selected.has("files") ? known.files * 2 : 0) +
    (selected.has("documents") ? known.documentEntries : 0) +
    (selected.has("numbers") ? known.numberSeries + known.numberSeriesVersions + known.numberAllocations : 0) +
    100;
  const estimatedBytes = (selected.has("files") ? known.fileBytes : 0) + (selected.has("documents") ? known.documentBytes : 0);
  const history = coverageRows.map((row) => ({
    tableId: row.table_short_id,
    enabled: row.activated_at !== null,
    startsAt: iso(row.activated_at),
    baselineComplete: row.status === "active" && row.baseline_completed_at !== null,
  }));
  const tables = coverageRows.map((row) => {
    const records = Number(row.records);
    const baselineComplete = row.status === "active" && row.baseline_completed_at !== null;
    const historyState =
      row.activated_at === null
        ? records > 0
          ? ("legacy" as const)
          : ("unavailable" as const)
        : row.status === "activating"
          ? ("activating" as const)
          : baselineComplete
            ? ("active" as const)
            : ("incomplete" as const);
    return {
      tableId: row.table_short_id,
      name: row.table_name,
      trashed: row.deleted_at !== null,
      records,
      history: { state: historyState, startsAt: iso(row.activated_at), baselineComplete },
      finalization: {
        enabled: row.finalization_enabled_at !== null,
        finalizedRecords: Number(row.finalized_records),
      },
    };
  });
  const t = serviceMessagesFor(params.locale);
  const warnings = selected.has("revisions")
    ? history.flatMap((item) =>
        item.enabled
          ? item.baselineComplete
            ? []
            : [t.evidenceHistoryCapturing({ table: item.tableId })]
          : [t.evidenceHistoryMissing({ table: item.tableId })],
      )
    : [];
  if (estimatedEntries > EVIDENCE_EXPORT_MAX_ENTRIES) warnings.push(t.evidenceEntryWarning);
  if (estimatedBytes > EVIDENCE_EXPORT_MAX_PACKAGE_BYTES) warnings.push(t.evidenceBytesWarning);
  return {
    scope: { baseId: base.short_id, tableId: table?.short_id ?? null },
    known,
    history,
    tables,
    withinKnownBudgets: estimatedEntries <= EVIDENCE_EXPORT_MAX_ENTRIES && estimatedBytes <= EVIDENCE_EXPORT_MAX_PACKAGE_BYTES,
    warnings,
  };
};

export const create = async (params: {
  baseId: string;
  tableId: string | null;
  from: string | null;
  to: string | null;
  sections: EvidenceExportSection[];
  requestedBy: string | null;
  requestedByDisplayName: string | null;
  locale?: string;
}): Promise<Result<EvidenceExport>> => {
  const preview = await preflight(params);
  if (!preview.withinKnownBudgets) return fail(err.badInput(serviceMessagesFor(params.locale).evidenceScopeTooLarge));
  const selected = new Set(params.sections);
  const estimatedEntries =
    (selected.has("records") ? preview.known.records : 0) +
    (selected.has("revisions") ? preview.known.revisions : 0) +
    (selected.has("audit") ? preview.known.auditEvents : 0) +
    (selected.has("files") ? preview.known.files * 2 : 0) +
    (selected.has("documents") ? preview.known.documentEntries : 0) +
    (selected.has("numbers") ? preview.known.numberSeries + preview.known.numberSeriesVersions + preview.known.numberAllocations : 0) +
    100;
  const row = await sql.begin((tx) =>
    insertWithShortIdForDb(tx, "idx_grids_evidence_exports_short_id", async (attempt, shortId) => {
      const [created] = await attempt<EvidenceExportRow[]>`
        INSERT INTO grids.evidence_exports (
          short_id, base_id, table_id, requested_by, requested_by_display_name, sections,
          range_from, range_to, estimated_entries
        ) VALUES (
          ${shortId}, ${params.baseId}::uuid, ${params.tableId}::uuid, ${params.requestedBy}::uuid,
          ${params.requestedByDisplayName}, ${toPgTextArray(params.sections)}::text[],
          ${params.from}::timestamptz, ${params.to}::timestamptz, ${estimatedEntries}
        )
        RETURNING *, ${preview.scope.baseId}::text AS base_short_id, ${preview.scope.tableId}::text AS table_short_id,
          ${""}::text AS base_name
      `;
      if (!created) throw new Error("Evidence export insert returned no row");
      return created;
    }),
  );
  await queueExport(row.id, row.attempt);
  return ok(mapExport(row));
};

const privateRef = (value: string): string =>
  `private:${createHash("sha256").update(`grids-evidence:${value}`).digest("hex").slice(0, 20)}`;

export const projectEvidenceValue = (value: unknown, publicIds: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") return UUID_PATTERN.test(value) ? (publicIds.get(value) ?? privateRef(value)) : value;
  if (Array.isArray(value)) return value.map((item) => projectEvidenceValue(item, publicIds));
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      UUID_PATTERN.test(key) ? (publicIds.get(key) ?? privateRef(key)) : key,
      projectEvidenceValue(item, publicIds),
    ]),
  );
};

const withoutPrivateColumns = (row: DbRow): DbRow =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== "cursor_id" && key !== "id"));

const loadPublicIds = async (db: SQL, scope: ExportScope): Promise<Map<string, string>> => {
  const rows = await db<Array<{ internal_id: string; public_id: string }>>`
    WITH scoped_tables AS (
      SELECT id FROM grids.tables WHERE base_id = ${scope.baseId}::uuid AND (${scope.tableId}::uuid IS NULL OR id = ${scope.tableId}::uuid)
    ), scoped_records AS (
      SELECT id, short_id FROM grids.records WHERE table_id IN (SELECT id FROM scoped_tables)
      UNION
      SELECT target.id, target.short_id
      FROM grids.record_links link
      JOIN grids.records source ON source.id = link.from_record_id AND source.table_id IN (SELECT id FROM scoped_tables)
      JOIN grids.records target ON target.id = link.to_record_id
    )
    SELECT id::text AS internal_id, short_id AS public_id FROM grids.bases WHERE id = ${scope.baseId}::uuid
    UNION ALL SELECT id::text, short_id FROM grids.tables WHERE id IN (SELECT id FROM scoped_tables)
    UNION ALL SELECT field.id::text, field.short_id FROM grids.fields field WHERE field.table_id IN (SELECT id FROM scoped_tables)
    UNION ALL SELECT id::text, short_id FROM scoped_records
    UNION ALL SELECT revision.id::text, revision.short_id FROM grids.record_revisions revision WHERE revision.table_id IN (SELECT id FROM scoped_tables)
    UNION ALL SELECT file.id::text, file.short_id FROM grids.files file WHERE EXISTS (
      SELECT 1 FROM grids.file_attachments attachment JOIN grids.records record ON record.id = attachment.record_id
      WHERE attachment.file_id = file.id AND record.table_id IN (SELECT id FROM scoped_tables)
    ) OR EXISTS (
      SELECT 1 FROM grids.file_protected_references protection
      WHERE protection.file_id = file.id AND protection.base_id = ${scope.baseId}::uuid
        AND (${scope.tableId}::uuid IS NULL OR protection.table_id = ${scope.tableId}::uuid)
    )
    UNION ALL SELECT template.id::text, template.short_id FROM grids.document_templates template WHERE template.table_id IN (SELECT id FROM scoped_tables)
    UNION ALL SELECT doc.id::text, doc.short_id FROM grids.documents doc
      WHERE doc.table_id IN (SELECT id FROM scoped_tables)
    UNION ALL SELECT snapshot.id::text, snapshot.short_id FROM grids.record_snapshots snapshot WHERE snapshot.table_id IN (SELECT id FROM scoped_tables)
    UNION ALL SELECT series.id::text, series.short_id FROM grids.number_series series
      LEFT JOIN grids.fields field ON field.id = series.field_id
      LEFT JOIN grids.document_templates template ON template.id = series.document_template_id
      WHERE COALESCE(field.table_id, template.table_id) IN (SELECT id FROM scoped_tables)
  `;
  return new Map(rows.map((row) => [row.internal_id, row.public_id]));
};

type BuildContext = {
  db: SQL;
  row: EvidenceExportRow;
  scope: ExportScope;
  writer: EvidenceTarWriter;
  publicIds: Map<string, string>;
  startedAt: number;
  processed: number;
  heartbeat: () => Promise<void>;
};

const checkBudgetAndCancellation = async (ctx: BuildContext, force = false): Promise<void> => {
  if (Date.now() - ctx.startedAt > MAX_DURATION_MS)
    throw new EvidenceExportBoundError(`Evidence export exceeded the ${MAX_DURATION_MS} ms time budget.`);
  if (!force && ctx.processed % 50 !== 0) return;
  const [status] = await sql<
    Array<{ status: EvidenceExportStatus }>
  >`SELECT status FROM grids.evidence_exports WHERE id = ${ctx.row.id}::uuid`;
  if (!status || status.status === "cancel_requested") throw new DOMException("Evidence export canceled", "AbortError");
  await ctx.heartbeat();
};

const addRow = async (ctx: BuildContext, category: string, name: string, value: unknown): Promise<void> => {
  ctx.processed += 1;
  await checkBudgetAndCancellation(ctx);
  await ctx.writer.addJson(`${category}/${safeArchiveSegment(name)}.json`, category, projectEvidenceValue(value, ctx.publicIds));
};

const exportPaged = async (
  ctx: BuildContext,
  category: string,
  load: (cursor: string | null) => Promise<DbRow[]>,
  name: (row: DbRow) => string,
): Promise<number> => {
  let cursor: string | null = null;
  let count = 0;
  for (;;) {
    const rows = await load(cursor);
    for (const row of rows) {
      if (count >= MAX_SOURCE_ROWS) {
        throw new EvidenceExportBoundError(`Evidence export exceeds the ${MAX_SOURCE_ROWS} row budget for ${category}.`);
      }
      cursor = String(row.cursor_id);
      await addRow(ctx, category, name(row), withoutPrivateColumns(row));
      count += 1;
    }
    if (rows.length < PAGE_SIZE) return count;
  }
};

const timeRangeSql = (scope: ExportScope, column: SQLQuery) => sql`
  (${scope.from}::timestamptz IS NULL OR ${column} >= ${scope.from}::timestamptz)
  AND (${scope.to}::timestamptz IS NULL OR ${column} <= ${scope.to}::timestamptz)
`;

const addSchema = async (ctx: BuildContext): Promise<number> => {
  let count = 0;
  const baseRows = await ctx.db<DbRow[]>`
    SELECT short_id AS public_id, name, description, document_defaults, deleted_at, created_at, updated_at
    FROM grids.bases WHERE id = ${ctx.scope.baseId}::uuid
  `;
  for (const row of baseRows) {
    await addRow(ctx, "schema/bases", String(row.public_id), row);
    count += 1;
  }
  const tables = await ctx.db<DbRow[]>`
    SELECT short_id AS public_id, kind, name, description, icon, columns, display_config, audit_policy, mutation_policy,
           position, disable_direct_insert, deleted_at, created_at, updated_at
    FROM grids.tables
    WHERE base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR id = ${ctx.scope.tableId}::uuid)
    ORDER BY position, id
  `;
  for (const row of tables) {
    await addRow(ctx, "schema/tables", String(row.public_id), row);
    count += 1;
  }
  const fields = await ctx.db<DbRow[]>`
    SELECT field.short_id AS public_id, table_info.short_id AS table_public_id, field.name, field.description, field.icon,
           field.type, field.config, field.position, field.required, field.default_value, field.indexed, field.unique_constraint,
           field.presentable, field.hide_in_table, field.deleted_at, field.created_at, field.updated_at
    FROM grids.fields field
    JOIN grids.tables table_info ON table_info.id = field.table_id
    WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
    ORDER BY table_info.position, field.position, field.id
  `;
  for (const row of fields) {
    await addRow(ctx, "schema/fields", `${row.table_public_id}-${row.public_id}`, row);
    count += 1;
  }
  const snapshots = await ctx.db<DbRow[]>`
    SELECT schema_revision.schema_hash, table_info.short_id AS table_public_id, schema_revision.fields, schema_revision.created_at
    FROM grids.table_schema_revisions schema_revision
    JOIN grids.tables table_info ON table_info.id = schema_revision.table_id
    WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
    ORDER BY table_info.short_id, schema_revision.created_at, schema_revision.id
  `;
  for (const row of snapshots) {
    await addRow(ctx, "schema/revisions", `${row.table_public_id}-${String(row.schema_hash).slice(0, 16)}`, row);
    count += 1;
  }
  const finalization = await ctx.db<DbRow[]>`
    SELECT table_info.short_id AS table_public_id, activation.enabled_at, activation.enabled_by
    FROM grids.table_finalization_activations activation
    JOIN grids.tables table_info ON table_info.id = activation.table_id
    WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
    ORDER BY table_info.position, table_info.id
  `;
  for (const row of finalization) {
    await addRow(ctx, "schema/finalization", String(row.table_public_id), row);
    count += 1;
  }
  const templates = await ctx.db<DbRow[]>`
    SELECT template.short_id AS public_id, table_info.short_id AS table_public_id, template.name, template.description,
           template.source, template.html, template.header_html, template.footer_html, template.page_css, template.number_template,
           template.filename_template, template.enabled, template.position, template.deleted_at, template.created_at, template.updated_at
    FROM grids.document_templates template
    JOIN grids.tables table_info ON table_info.id = template.table_id
    WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
    ORDER BY table_info.short_id, template.position, template.id
  `;
  for (const row of templates) {
    await addRow(ctx, "schema/document-templates", String(row.public_id), row);
    count += 1;
  }
  return count;
};

const addRecords = (ctx: BuildContext): Promise<number> =>
  exportPaged(
    ctx,
    "records",
    (cursor) => ctx.db<DbRow[]>`
      SELECT record.id::text AS cursor_id, record.short_id AS public_id, table_info.short_id AS table_public_id,
             record.data, record.version, record.deleted_at, record.finalized_at, record.created_at, record.updated_at
      FROM grids.records record
      JOIN grids.tables table_info ON table_info.id = record.table_id
      WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
        AND (${cursor}::uuid IS NULL OR record.id > ${cursor}::uuid)
      ORDER BY record.id
      LIMIT ${PAGE_SIZE}
    `,
    (row) => String(row.public_id),
  );

const addRevisions = (ctx: BuildContext): Promise<number> =>
  exportPaged(
    ctx,
    "revisions",
    (cursor) => ctx.db<DbRow[]>`
      SELECT revision.id::text AS cursor_id, revision.short_id AS public_id, table_info.short_id AS table_public_id,
             record.short_id AS record_public_id, schema_revision.schema_hash, revision.revision_no, revision.action,
             revision.record_version, revision.data, revision.relations, revision.files,
             to_json(revision.changed_field_ids) AS changed_field_ids,
             revision.deleted_at, revision.actor_display_name, revision.actor_avatar_hash, revision.created_at
      FROM grids.record_revisions revision
      JOIN grids.tables table_info ON table_info.id = revision.table_id
      LEFT JOIN grids.records record ON record.id = revision.record_id
      JOIN grids.table_schema_revisions schema_revision ON schema_revision.id = revision.schema_revision_id
      WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
        AND ${timeRangeSql(ctx.scope, sql`revision.created_at`)}
        AND (${cursor}::uuid IS NULL OR revision.id > ${cursor}::uuid)
      ORDER BY revision.id
      LIMIT ${PAGE_SIZE}
    `,
    (row) => String(row.public_id),
  );

const addAudit = (ctx: BuildContext): Promise<number> =>
  exportPaged(
    ctx,
    "audit",
    (cursor) => ctx.db<DbRow[]>`
      SELECT audit.id::text AS cursor_id, base.short_id AS base_public_id, table_info.short_id AS table_public_id,
             record.short_id AS record_public_id, audit.action, audit.diff, audit.context, audit.ip, audit.user_agent,
             COALESCE(actor.display_name, actor.uid) AS actor_display_name, audit.created_at
      FROM grids.audit_log audit
      JOIN grids.bases base ON base.id = audit.base_id
      LEFT JOIN grids.tables table_info ON table_info.id = audit.table_id
      LEFT JOIN grids.records record ON record.id = audit.record_id
      LEFT JOIN auth.users actor ON actor.id = audit.user_id
      WHERE audit.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR audit.table_id = ${ctx.scope.tableId}::uuid)
        AND ${timeRangeSql(ctx.scope, sql`audit.created_at`)}
        AND (${cursor}::uuid IS NULL OR audit.id > ${cursor}::uuid)
      ORDER BY audit.id
      LIMIT ${PAGE_SIZE}
    `,
    (row) => `${new Date(row.created_at as Date | string).toISOString()}-${privateRef(String(row.cursor_id))}`,
  );

const addRelations = (ctx: BuildContext): Promise<number> =>
  exportPaged(
    ctx,
    "relations/live",
    (cursor) => ctx.db<DbRow[]>`
      SELECT concat(link.from_record_id, ':', link.from_field_id, ':', link.to_record_id) AS cursor_id,
             source.short_id AS source_record_id, source_table.short_id AS source_table_id, field.short_id AS field_id,
             target.short_id AS target_record_id, target_table.short_id AS target_table_id, link.position, link.created_at
      FROM grids.record_links link
      JOIN grids.records source ON source.id = link.from_record_id
      JOIN grids.tables source_table ON source_table.id = source.table_id
      JOIN grids.fields field ON field.id = link.from_field_id
      JOIN grids.records target ON target.id = link.to_record_id
      JOIN grids.tables target_table ON target_table.id = target.table_id
      WHERE source_table.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR source_table.id = ${ctx.scope.tableId}::uuid)
        AND (${cursor}::text IS NULL OR concat(link.from_record_id, ':', link.from_field_id, ':', link.to_record_id) > ${cursor})
      ORDER BY concat(link.from_record_id, ':', link.from_field_id, ':', link.to_record_id)
      LIMIT ${PAGE_SIZE}
    `,
    (row) => `${row.source_record_id}-${row.field_id}-${row.target_record_id}`,
  );

const assetBytes = async function* (db: SQL, fileId: string, sizeBytes: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < sizeBytes; offset += ASSET_CHUNK_BYTES) {
    const [row] = await db<Array<{ bytes: Uint8Array }>>`
      SELECT substring(bytes FROM ${offset + 1} FOR ${Math.min(ASSET_CHUNK_BYTES, sizeBytes - offset)}) AS bytes
      FROM grids.files WHERE id = ${fileId}::uuid
    `;
    if (!row) throw new Error("Evidence file disappeared during the export cut.");
    yield row.bytes;
  }
};

type EvidenceFileRow = DbRow & { id: string; public_id: string; size_bytes: number | string };
type EvidenceDocumentRow = DbRow & {
  id: string;
  public_id: string;
};

type EvidenceDocumentArtifactRow = DbRow & {
  artifact_key: string;
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  sha256: string;
};

const addFiles = async (ctx: BuildContext): Promise<number> => {
  let cursor: string | null = null;
  let count = 0;
  for (;;) {
    const rows: EvidenceFileRow[] = await ctx.db<EvidenceFileRow[]>`
      WITH selected_revisions AS (
        SELECT revision.id
        FROM grids.record_revisions revision
        JOIN grids.tables table_info ON table_info.id = revision.table_id
        WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
          AND ${timeRangeSql(ctx.scope, sql`revision.created_at`)}
      ), selected_files AS (
        SELECT attachment.file_id
        FROM grids.file_attachments attachment
        JOIN grids.records record ON record.id = attachment.record_id
        JOIN grids.tables table_info ON table_info.id = record.table_id
        WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
        UNION
        SELECT protection.file_id FROM grids.file_protected_references protection
        WHERE protection.owner_kind = 'record_revision' AND protection.owner_id IN (SELECT id FROM selected_revisions)
      )
      SELECT file.id::text AS id, file.short_id AS public_id, file.filename, file.mime_type, file.size_bytes, file.sha256, file.created_at,
             attachment_record.short_id AS attached_record_id, attachment_field.short_id AS attached_field_id, attachment.position
      FROM grids.files file
      JOIN selected_files selected ON selected.file_id = file.id
      LEFT JOIN grids.file_attachments attachment ON attachment.file_id = file.id
      LEFT JOIN grids.records attachment_record ON attachment_record.id = attachment.record_id
      LEFT JOIN grids.fields attachment_field ON attachment_field.id = attachment.field_id
      WHERE (${cursor}::uuid IS NULL OR file.id > ${cursor}::uuid)
      ORDER BY file.id
      LIMIT ${PAGE_SIZE}
    `;
    for (const row of rows) {
      if (count >= MAX_SOURCE_ROWS) throw new EvidenceExportBoundError(`Evidence export exceeds the ${MAX_SOURCE_ROWS} file-row budget.`);
      cursor = row.id;
      const filename = safeArchiveSegment(String(row.filename), "file");
      const path = `files/${row.public_id}/${filename}`;
      await addRow(ctx, "files/metadata", String(row.public_id), { ...withoutPrivateColumns(row), path });
      await ctx.writer.add(
        path,
        "files",
        String(row.mime_type),
        Number(row.size_bytes),
        assetBytes(ctx.db, row.id, Number(row.size_bytes)),
      );
      count += 1;
    }
    if (rows.length < PAGE_SIZE) return count;
  }
};

const addDocuments = async (ctx: BuildContext): Promise<number> => {
  let cursor: string | null = null;
  let count = 0;
  for (;;) {
    const rows: EvidenceDocumentRow[] = await ctx.db<EvidenceDocumentRow[]>`
      SELECT doc.id::text AS id, doc.short_id AS public_id, template.short_id AS template_public_id,
             snapshot.short_id AS snapshot_public_id, record.short_id AS record_public_id, table_info.short_id AS table_public_id,
             doc.document_number, doc.filename, doc.tags, doc.template_snapshot, doc.render_data,
             doc.renderer_kind, doc.renderer_version, doc.template_revision, doc.profile_id, doc.profile_version,
             doc.profile_snapshot, doc.snapshot_sha256,
             doc.validator_version, doc.validation_status, doc.validation_report, doc.issued_actor,
             doc.created_at, snapshot.root AS record_snapshot_root, snapshot.graph AS record_snapshot_graph, snapshot.created_at AS snapshot_created_at
      FROM grids.documents doc
      JOIN grids.tables table_info ON table_info.id = doc.table_id
      LEFT JOIN grids.document_templates template ON template.id = doc.template_id
      JOIN grids.record_snapshots snapshot ON snapshot.id = doc.snapshot_id
      LEFT JOIN grids.records record ON record.id = doc.record_id
      WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
        AND ${timeRangeSql(ctx.scope, sql`doc.created_at`)}
        AND (${cursor}::uuid IS NULL OR doc.id > ${cursor}::uuid)
      ORDER BY doc.id
      LIMIT ${PAGE_SIZE}
    `;
    for (const row of rows) {
      if (count >= MAX_SOURCE_ROWS)
        throw new EvidenceExportBoundError(`Evidence export exceeds the ${MAX_SOURCE_ROWS} Document-row budget.`);
      cursor = row.id;
      const artifacts = await ctx.db<EvidenceDocumentArtifactRow[]>`
        SELECT artifact.artifact_key, artifact.file_id::text, file.filename, file.mime_type, file.size_bytes, file.sha256
        FROM grids.document_artifacts artifact
        JOIN grids.files file ON file.id = artifact.file_id
        WHERE artifact.document_id = ${row.id}::uuid
        ORDER BY artifact.artifact_key
      `;
      await addRow(ctx, "documents/metadata", row.public_id, {
        ...withoutPrivateColumns(row),
        artifacts: artifacts.map(({ file_id: _fileId, ...artifact }) => artifact),
      });
      for (const artifact of artifacts) {
        ctx.processed += 1;
        await checkBudgetAndCancellation(ctx);
        const content = await readDocumentArtifact(row.id, String(artifact.artifact_key), ctx.db);
        if (!content.ok) throw content.error;
        const filename = safeArchiveSegment(String(artifact.filename), String(artifact.artifact_key));
        await ctx.writer.add(
          `documents/${row.public_id}/${filename}`,
          "documents",
          content.data.mimeType,
          content.data.sizeBytes,
          (async function* () {
            yield content.data.bytes;
          })(),
        );
      }
      count += 1;
    }
    if (rows.length < PAGE_SIZE) return count;
  }
};

const addNumbers = async (ctx: BuildContext): Promise<number> => {
  let count = 0;
  const series = await ctx.db<DbRow[]>`
    SELECT series.short_id AS public_id, series.owner_kind, field.short_id AS field_public_id,
           template.short_id AS document_template_public_id, series.assignment, series.current_version,
           series.baseline_floor, series.migration_status, series.migration_note, series.archived_at, series.created_at, series.updated_at
    FROM grids.number_series series
    LEFT JOIN grids.fields field ON field.id = series.field_id
    LEFT JOIN grids.document_templates template ON template.id = series.document_template_id
    JOIN grids.tables table_info ON table_info.id = COALESCE(field.table_id, template.table_id)
    WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
    ORDER BY series.short_id
  `;
  for (const row of series) {
    await addRow(ctx, "numbers/series", String(row.public_id), row);
    count += 1;
  }
  const versions = await ctx.db<DbRow[]>`
    SELECT series.short_id AS series_public_id, version.version, version.strategy, version.prefix, version.padding,
           version.period, version.number_template, version.created_at
    FROM grids.number_series_versions version
    JOIN grids.number_series series ON series.id = version.series_id
    LEFT JOIN grids.fields field ON field.id = series.field_id
    LEFT JOIN grids.document_templates template ON template.id = series.document_template_id
    JOIN grids.tables table_info ON table_info.id = COALESCE(field.table_id, template.table_id)
    WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
    ORDER BY series.short_id, version.version
  `;
  for (const row of versions) {
    await addRow(ctx, "numbers/versions", `${row.series_public_id}-v${row.version}`, row);
    count += 1;
  }
  count += await exportPaged(
    ctx,
    "numbers/allocations",
    (cursor) => ctx.db<DbRow[]>`
      SELECT allocation.id::text AS cursor_id, series.short_id AS series_public_id, allocation.version, allocation.scope,
             allocation.value, allocation.rendered_value, allocation.consumer_kind,
             COALESCE(record.short_id, doc.short_id) AS consumer_public_id, allocation.allocated_at
      FROM grids.number_allocations allocation
      JOIN grids.number_series series ON series.id = allocation.series_id
      LEFT JOIN grids.fields field ON field.id = series.field_id
      LEFT JOIN grids.document_templates template ON template.id = series.document_template_id
      JOIN grids.tables table_info ON table_info.id = COALESCE(field.table_id, template.table_id)
      LEFT JOIN grids.records record ON allocation.consumer_kind = 'record' AND record.id = allocation.consumer_id
      LEFT JOIN grids.documents doc ON allocation.consumer_kind = 'document' AND doc.id = allocation.consumer_id
      WHERE table_info.base_id = ${ctx.scope.baseId}::uuid AND (${ctx.scope.tableId}::uuid IS NULL OR table_info.id = ${ctx.scope.tableId}::uuid)
        AND ${timeRangeSql(ctx.scope, sql`allocation.allocated_at`)}
        AND (${cursor}::uuid IS NULL OR allocation.id > ${cursor}::uuid)
      ORDER BY allocation.id
      LIMIT ${PAGE_SIZE}
    `,
    (row) => `${row.series_public_id}-${row.scope}-${row.value}`,
  );
  return count;
};

const loadHistoryCoverage = async (db: SQL, scope: ExportScope) => {
  const rows = await db<
    Array<{
      table_public_id: string;
      activated_at: Date | string | null;
      status: string | null;
      baseline_completed_at: Date | string | null;
    }>
  >`
    SELECT table_info.short_id AS table_public_id, activation.activated_at, activation.status, activation.baseline_completed_at
    FROM grids.tables table_info
    LEFT JOIN grids.durable_history_activations activation ON activation.table_id = table_info.id
    WHERE table_info.base_id = ${scope.baseId}::uuid AND (${scope.tableId}::uuid IS NULL OR table_info.id = ${scope.tableId}::uuid)
    ORDER BY table_info.position, table_info.id
  `;
  return rows.map((row) => ({
    tableId: row.table_public_id,
    available: row.activated_at !== null,
    startsAt: iso(row.activated_at),
    baselineComplete: row.status === "active" && row.baseline_completed_at !== null,
  }));
};

const sourceCoverage = (scope: ExportScope, cutAt: Date) =>
  scope.sections.map((section) => {
    const range = { from: scope.from, to: scope.to };
    switch (section) {
      case "records":
        return { section, currentAt: cutAt.toISOString(), from: null, to: null, note: "Current and deleted stored Records at the cut." };
      case "revisions":
        return { section, currentAt: null, ...range, note: "Available Durable History revisions in the requested period." };
      case "audit":
        return { section, currentAt: null, ...range, note: "Saved audit events in the requested period." };
      case "schema":
        return {
          section,
          currentAt: cutAt.toISOString(),
          from: null,
          to: null,
          note: "Current schema and configuration plus every available schema snapshot.",
        };
      case "relations":
        return {
          section,
          currentAt: cutAt.toISOString(),
          from: null,
          to: null,
          note: scope.sections.includes("revisions")
            ? "Live Relations at the cut; historical relation state is stored in the selected revisions."
            : "Live Relations at the cut; Durable History revisions were not selected.",
        };
      case "files":
        return {
          section,
          currentAt: cutAt.toISOString(),
          ...range,
          note: "Current attachments at the cut plus files protected by revisions in the requested period.",
        };
      case "documents":
        return {
          section,
          currentAt: null,
          ...range,
          note: scope.tableId
            ? "Exact stored Documents bound to the table and created in the requested period."
            : "Exact stored Documents created in the requested period, including profile artifacts and validation evidence.",
        };
      case "numbers":
        return {
          section,
          currentAt: cutAt.toISOString(),
          ...range,
          note: "Current Number Series and versions plus allocations in the requested period.",
        };
    }
  });

const processExportLocked = async (exportId: string, heartbeat: () => Promise<void>): Promise<void> => {
  const [claimed] = await sql<EvidenceExportRow[]>`
    UPDATE grids.evidence_exports
    SET status = 'running', started_at = now(), cut_at = now(), processed_entries = 0, last_error = NULL,
        package_filename = NULL, package_size_bytes = NULL, package_sha256 = NULL, manifest_sha256 = NULL, manifest = NULL,
        completed_at = NULL, expires_at = NULL
    WHERE id = ${exportId}::uuid AND status IN ('queued', 'running')
    RETURNING *, ''::text AS base_short_id, ''::text AS base_name, NULL::text AS table_short_id
  `;
  if (!claimed) return;
  const loaded = await loadInternal(claimed.short_id);
  if (!loaded) return;
  const scope: ExportScope = {
    baseId: loaded.base_id,
    basePublicId: loaded.base_short_id,
    baseName: loaded.base_name,
    tableId: loaded.table_id,
    tablePublicId: loaded.table_short_id,
    from: iso(loaded.range_from),
    to: iso(loaded.range_to),
    sections: readSections(loaded.sections),
  };
  await sql.begin("isolation level repeatable read", async (tx) => {
    await tx`DELETE FROM grids.evidence_export_chunks WHERE export_id = ${exportId}::uuid`;
    let chunkSequence = 0;
    const cutAt = new Date(loaded.cut_at ?? Date.now());
    const writer = new EvidenceTarWriter(cutAt, async (bytes) => {
      await tx`
        INSERT INTO grids.evidence_export_chunks (export_id, sequence, bytes)
        VALUES (${exportId}::uuid, ${chunkSequence++}, ${bytes})
      `;
    });
    const ctx: BuildContext = {
      db: tx,
      row: loaded,
      scope,
      writer,
      publicIds: await loadPublicIds(tx, scope),
      startedAt: Date.now(),
      processed: 0,
      heartbeat,
    };
    await checkBudgetAndCancellation(ctx, true);
    const counts: Partial<Record<EvidenceExportSection, number>> = {};
    if (scope.sections.includes("schema")) counts.schema = await addSchema(ctx);
    if (scope.sections.includes("records")) counts.records = await addRecords(ctx);
    if (scope.sections.includes("revisions")) counts.revisions = await addRevisions(ctx);
    if (scope.sections.includes("audit")) counts.audit = await addAudit(ctx);
    if (scope.sections.includes("relations")) counts.relations = await addRelations(ctx);
    if (scope.sections.includes("files")) counts.files = await addFiles(ctx);
    if (scope.sections.includes("documents")) counts.documents = await addDocuments(ctx);
    if (scope.sections.includes("numbers")) counts.numbers = await addNumbers(ctx);
    await checkBudgetAndCancellation(ctx, true);
    const history = await loadHistoryCoverage(tx, scope);
    const manifest = EvidenceExportManifestSchema.parse({
      schema: "cloud.grids.evidence-export",
      version: 1,
      generatedAt: cutAt.toISOString(),
      request: {
        id: loaded.short_id,
        requestedAt: iso(loaded.requested_at)!,
        requestedByDisplayName: loaded.requested_by_display_name,
      },
      consistency: { kind: "postgres-repeatable-read", cutAt: cutAt.toISOString() },
      scope: {
        baseId: scope.basePublicId,
        tableId: scope.tablePublicId,
        from: scope.from,
        to: scope.to,
        sections: scope.sections,
      },
      coverage: {
        completeWithinAvailableCoverage: true,
        history,
        sources: sourceCoverage(scope, cutAt),
        note: !scope.sections.includes("revisions")
          ? "Durable History was not selected for this package."
          : history.some((item) => !item.available)
            ? "Tables without Durable History include current state and available audit only; no earlier record states were reconstructed."
            : history.some((item) => !item.baselineComplete)
              ? "Durable History is included as currently captured; at least one activation baseline is still incomplete."
              : "Durable History is included from each stated activation baseline.",
      },
      counts,
      limits: {
        maxRowsPerPagedSource: MAX_SOURCE_ROWS,
        maxEntries: EVIDENCE_EXPORT_MAX_ENTRIES,
        maxPackageBytes: EVIDENCE_EXPORT_MAX_PACKAGE_BYTES,
        maxDurationMs: MAX_DURATION_MS,
      },
      identity:
        "Grids resources use Public IDs. UUID-shaped values without a scoped Grids Public ID are represented by stable private references.",
      entries: [...writer.entries],
    });
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    await writer.addBytes("manifest.json", "manifest", "application/json", manifestBytes);
    const packageResult = await writer.finish();
    const filename = `${safeArchiveSegment(scope.baseName, "grids")}-evidence-${cutAt.toISOString().slice(0, 10)}.tar`;
    const completedRows = await tx`
      UPDATE grids.evidence_exports
      SET status = 'completed', processed_entries = ${ctx.processed}, completed_at = now(),
          expires_at = now() + interval '7 days', package_filename = ${filename},
          package_size_bytes = ${packageResult.sizeBytes}, package_sha256 = ${packageResult.sha256},
          manifest_sha256 = ${manifestSha256}, manifest = ${JSON.stringify(manifest)}::jsonb, last_error = NULL
      WHERE id = ${exportId}::uuid AND status = 'running'
      RETURNING id
    `;
    if (completedRows.length === 0) throw new DOMException("Evidence export canceled", "AbortError");
  });
};

/** Runs `run` while holding the export's session lock; `false` when another session holds it. */
const withExportLock = async (exportId: string, run: () => Promise<void>): Promise<boolean> => {
  const connection = await sql.reserve();
  const lockName = `grids:evidence-export:${exportId}`;
  let locked = false;
  let reusable = true;
  try {
    const [lock] = await connection<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(hashtextextended(${lockName}, 0)) AS acquired
    `;
    if (!lock?.acquired) return false;
    locked = true;
    await run();
    return true;
  } finally {
    if (locked) {
      try {
        const [unlock] = await connection<Array<{ released: boolean }>>`
          SELECT pg_advisory_unlock(hashtextextended(${lockName}, 0)) AS released
        `;
        if (!unlock?.released) throw new Error("Evidence export lock was not held");
      } catch (error) {
        reusable = false;
        await connection.close({ timeout: 0 }).catch(() => undefined);
        throw error;
      }
    }
    if (reusable) connection.release();
  }
};

export const processExport = async (exportId: string, heartbeat: () => Promise<void> = async () => undefined): Promise<void> => {
  await withExportLock(exportId, () => processExportLocked(exportId, heartbeat));
};

const markFailed = async (exportId: string, error: Error): Promise<void> => {
  const canceled = error.name === "AbortError";
  const message = canceled
    ? "Canceled by an administrator."
    : error instanceof EvidenceExportBoundError
      ? error.message
      : "Evidence export failed. Retry, or ask an operator to inspect the Grids logs.";
  await sql`
    UPDATE grids.evidence_exports
    SET status = ${canceled ? "canceled" : "failed"}, completed_at = now(), last_error = ${message},
        package_filename = NULL, package_size_bytes = NULL, package_sha256 = NULL, manifest_sha256 = NULL, manifest = NULL, expires_at = NULL
    WHERE id = ${exportId}::uuid AND status IN ('running', 'cancel_requested')
  `;
  await sql`DELETE FROM grids.evidence_export_chunks WHERE export_id = ${exportId}::uuid`;
};

/**
 * One job attempt. Cancellation and bound violations are outcomes of the
 * export itself: they end in the row, not in the transport dead-letter store.
 * Anything else propagates so the job retries and, exhausted, dead-letters.
 */
export const runEvidenceExportJob = async (
  exportId: string,
  heartbeat: () => Promise<void>,
  run: typeof processExport = processExport,
): Promise<void> => {
  try {
    await run(exportId, heartbeat);
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== "AbortError" && !(error instanceof EvidenceExportBoundError))) throw error;
    await markFailed(exportId, error);
  }
};

/**
 * A process killed on its last attempt dead-letters without `onError`, leaving
 * the row `running` forever. Rows older than the whole transport budget whose
 * session lock nobody holds are terminal; oldest first, one bounded batch.
 */
export const reconcileStuckEvidenceExports = async (context?: CleanupContext): Promise<number> => {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id::text FROM grids.evidence_exports
    WHERE status IN ('running', 'cancel_requested') AND started_at < now() - (${STUCK_EXPORT_MS} * interval '1 millisecond')
    ORDER BY started_at, id
    LIMIT ${CLEANUP_BATCH_SIZE}
  `;
  let reconciled = 0;
  for (const row of rows) {
    context?.signal.throwIfAborted();
    await withExportLock(row.id, async () => {
      const updated = await sql`
        UPDATE grids.evidence_exports
        SET status = CASE WHEN status = 'cancel_requested' THEN 'canceled' ELSE 'failed' END,
            completed_at = now(),
            last_error = CASE WHEN status = 'cancel_requested' THEN 'Canceled by an administrator.' ELSE ${STUCK_EXPORT_MESSAGE} END,
            package_filename = NULL, package_size_bytes = NULL, package_sha256 = NULL, manifest_sha256 = NULL, manifest = NULL, expires_at = NULL
        WHERE id = ${row.id}::uuid AND status IN ('running', 'cancel_requested')
          AND started_at < now() - (${STUCK_EXPORT_MS} * interval '1 millisecond')
        RETURNING id
      `;
      if (updated.length === 0) return;
      await sql`DELETE FROM grids.evidence_export_chunks WHERE export_id = ${row.id}::uuid`;
      reconciled += 1;
    });
    await context?.heartbeat();
  }
  if (reconciled > 0) log.warn("Marked abandoned evidence exports as failed", { count: reconciled });
  return reconciled;
};

const exportJob = lazySync((sync) =>
  sync.job<{ exportId: string; attempt: number }>({ id: "grids:evidence-export", delivery: EXPORT_DELIVERY }),
);
let exportWorker: Worker | undefined;
export const startEvidenceExportJobs = async (): Promise<void> => {
  if (exportWorker) return;
  await reconcileStuckEvidenceExports().catch((error) => {
    log.warn("Evidence export boot reconcile failed", { error: error instanceof Error ? error.message : String(error) });
  });
  exportWorker = await exportJob().process(
    {
      onError: async ({ context, error }) => {
        if (context.attempt < EXPORT_DELIVERY.maxAttempts) return { action: "retry" };
        await markFailed(context.input.exportId, error);
        return { action: "dead_letter", reason: error.message };
      },
    },
    (context) => runEvidenceExportJob(context.input.exportId, () => context.heartbeat()),
  );
};

const submitExport = (exportId: string, attempt: number) =>
  exportJob().submit({ key: `export:${exportId}:${attempt}`, input: { exportId, attempt } });

const queueExport = async (exportId: string, attempt: number): Promise<void> => {
  try {
    await submitExport(exportId, attempt);
  } catch (error) {
    await sql`
      UPDATE grids.evidence_exports
      SET status = 'failed', completed_at = now(), last_error = 'The evidence export could not be queued. Retry when background jobs are available.'
      WHERE id = ${exportId}::uuid AND status = 'queued' AND attempt = ${attempt}
    `;
    throw error;
  }
};

const expireOne = async (exportId: string): Promise<void> => {
  await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE grids.evidence_exports
      SET status = 'expired', package_filename = NULL, package_size_bytes = NULL, package_sha256 = NULL,
          manifest_sha256 = NULL, manifest = NULL
      WHERE id = ${exportId}::uuid AND status = 'completed' AND expires_at <= now()
      RETURNING id
    `;
    if (rows.length > 0) await tx`DELETE FROM grids.evidence_export_chunks WHERE export_id = ${exportId}::uuid`;
  });
};

const expireByShortId = async (shortId: string): Promise<void> => {
  const [row] = await sql<Array<{ id: string }>>`
    SELECT id::text FROM grids.evidence_exports
    WHERE short_id = ${shortId} AND status = 'completed' AND expires_at <= now()
  `;
  if (row) await expireOne(row.id);
};

type CleanupContext = Pick<ScheduleContext, "signal" | "heartbeat">;

const expireCompletedExportBatch = async (baseId: string | null, context?: CleanupContext): Promise<number> => {
  context?.signal.throwIfAborted();
  const rows = await sql<Array<{ id: string }>>`
    SELECT id::text FROM grids.evidence_exports
    WHERE status = 'completed' AND expires_at <= now() AND (${baseId}::uuid IS NULL OR base_id = ${baseId}::uuid)
    ORDER BY expires_at, id
    LIMIT ${CLEANUP_BATCH_SIZE}
  `;
  for (const row of rows) {
    context?.signal.throwIfAborted();
    await expireOne(row.id);
    await context?.heartbeat();
  }
  return rows.length;
};

export const expireCompletedExports = async (baseId: string | null = null): Promise<void> => {
  await expireCompletedExportBatch(baseId);
};

export const cleanupExpiredEvidenceExports = async (context: CleanupContext): Promise<void> => {
  await reconcileStuckEvidenceExports(context);
  while (true) {
    const count = await expireCompletedExportBatch(null, context);
    if (count < CLEANUP_BATCH_SIZE) return;
  }
};

export const retry = async (shortId: string, locale?: string): Promise<Result<EvidenceExport>> => {
  const [updated] = await sql<Array<{ id: string; attempt: number }>>`
    UPDATE grids.evidence_exports
    SET status = 'queued', attempt = attempt + 1, processed_entries = 0, started_at = NULL, completed_at = NULL,
        cut_at = NULL, last_error = NULL, expires_at = NULL
    WHERE short_id = ${shortId} AND status IN ('failed', 'canceled')
    RETURNING id::text, attempt
  `;
  if (!updated) return fail(err.conflict(serviceMessagesFor(locale).evidenceRetryState));
  const row = await loadInternal(shortId);
  if (!row) throw new Error("Retried evidence export disappeared");
  await queueExport(updated.id, updated.attempt);
  return ok(mapExport(row));
};

export const cancel = async (shortId: string, locale?: string): Promise<Result<EvidenceExport>> => {
  const [updated] = await sql<Array<{ id: string }>>`
    UPDATE grids.evidence_exports
    SET status = CASE WHEN status = 'queued' THEN 'canceled' ELSE 'cancel_requested' END,
        completed_at = CASE WHEN status = 'queued' THEN now() ELSE completed_at END,
        last_error = CASE WHEN status = 'queued' THEN 'Canceled by an administrator.' ELSE NULL END
    WHERE short_id = ${shortId} AND status IN ('queued', 'running')
    RETURNING id::text
  `;
  if (!updated) return fail(err.conflict(serviceMessagesFor(locale).evidenceCancelState));
  const row = await loadInternal(shortId);
  if (!row) throw new Error("Canceled evidence export disappeared");
  return ok(mapExport(row));
};

export const download = async (
  shortId: string,
  locale?: string,
): Promise<Result<{ filename: string; sizeBytes: number; sha256: string; body: ReadableStream<Uint8Array> }>> => {
  await expireByShortId(shortId);
  const row = await loadInternal(shortId);
  if (!row || row.status !== "completed" || !row.package_filename || !row.package_sha256)
    return fail(err.notFound(serviceMessagesFor(locale).evidencePackage));
  let sequence = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const [chunk] = await sql<Array<{ bytes: Uint8Array }>>`
        SELECT bytes FROM grids.evidence_export_chunks WHERE export_id = ${row.id}::uuid AND sequence = ${sequence++}
      `;
      if (!chunk) controller.close();
      else controller.enqueue(chunk.bytes);
    },
  });
  return ok({ filename: row.package_filename, sizeBytes: Number(row.package_size_bytes), sha256: row.package_sha256, body });
};

export const stopEvidenceExportJobs = async (): Promise<void> => {
  await exportWorker?.drain({ timeoutMs: JOB_LEASE_MS });
  exportWorker = undefined;
};

export const evidenceExportLimits = {
  maxSourceRows: MAX_SOURCE_ROWS,
  maxEntries: EVIDENCE_EXPORT_MAX_ENTRIES,
  maxPackageBytes: EVIDENCE_EXPORT_MAX_PACKAGE_BYTES,
  maxDurationMs: MAX_DURATION_MS,
  retentionMs: RETENTION_MS,
} as const;
