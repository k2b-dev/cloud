import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { FieldColumnSpecSchema, RecordDisplayConfigSchema, TableAuditPolicySchema, TableMutationPolicySchema } from "../contracts";
import { normalizeRefKey } from "../ref-syntax";
import { logAudit, type SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { degradeForTableSchemaChange, refreshForTableSchemaChange } from "./federated-tables";
import { emitMetadataEvent } from "./metadata-events";
import { writeNamedResource } from "./named-resource-conflict";
import { insertWithShortId } from "./short-id";
import type { CreateTableInput, Table, UpdateTableInput } from "./types";

type DbRow = Record<string, unknown>;

const COLS = sql`id, short_id, base_id, kind, name, description, icon, columns, display_config, audit_policy, mutation_policy, position, disable_direct_insert, deleted_at, created_at, updated_at`;

const parseColumns = (raw: unknown) => {
  const parsed = FieldColumnSpecSchema.array().safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
};

const parseDisplayConfig = (raw: unknown) => {
  const parsed = RecordDisplayConfigSchema.safeParse(raw ?? { mode: "table" });
  return parsed.success ? parsed.data : { mode: "table" as const };
};

const parseAuditPolicy = (raw: unknown) => TableAuditPolicySchema.parse(raw ?? {});
const parseMutationPolicy = (raw: unknown) => TableMutationPolicySchema.parse(raw);

const tableFieldReferences = (
  columns: ReturnType<typeof parseColumns>,
  displayConfig: ReturnType<typeof parseDisplayConfig>,
  auditPolicy: ReturnType<typeof parseAuditPolicy>,
): string[] => [
  ...columns.map((column) => column.fieldId),
  ...(displayConfig.cards?.imageFieldId ? [displayConfig.cards.imageFieldId] : []),
  ...(displayConfig.cards?.fieldIds ?? []),
  ...(displayConfig.calendar?.dateFieldId ? [displayConfig.calendar.dateFieldId] : []),
  ...(auditPolicy.update?.enabled ? (auditPolicy.update.fieldIds ?? []) : []),
];

const mapRow = (row: DbRow): Table => ({
  id: row.id as string,
  shortId: row.short_id as string,
  baseId: row.base_id as string,
  kind: row.kind === "federated" ? "federated" : "stored",
  name: row.name as string,
  description: (row.description as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  columns: parseColumns(row.columns),
  displayConfig: parseDisplayConfig(row.display_config),
  auditPolicy: parseAuditPolicy(row.audit_policy),
  mutationPolicy: parseMutationPolicy(row.mutation_policy),
  position: row.position as number,
  disableDirectInsert: (row.disable_direct_insert as boolean | null) ?? false,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

/**
 * Lists active tables of a base. Pass `includeDeleted` to include
 * trashed tables (used by the trash UI).
 */
export const listByBase = async (
  baseId: string,
  opts: { includeDeleted?: boolean; search?: string; limit?: number; client?: SqlClient } = {},
): Promise<Table[]> => {
  const client = opts.client ?? sql;
  const search = opts.search?.trim() ?? "";
  const searchPattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const limit = opts.limit ?? 2_147_483_647;
  // Live-parent invariant: tables of a trashed base never list (the trash
  // flow operates top-down — restore the base first to access its tables).
  // SELECT t.* (not the bare COLS list) — both `tables.id` and `bases.id`
  // exist after the JOIN, so unqualified column names raise 42702. mapRow
  // picks the columns it cares about by name; extras are ignored.
  const rows = opts.includeDeleted
    ? await client<DbRow[]>`
        SELECT t.*
        FROM grids.tables t
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE t.base_id = ${baseId}::uuid
          AND (${search} = '' OR t.name ILIKE ${searchPattern} ESCAPE '\\' OR t.short_id ILIKE ${searchPattern} ESCAPE '\\')
        ORDER BY CASE WHEN lower(t.name) = lower(${search}) OR t.short_id = ${search} THEN 0 ELSE 1 END,
          t.position, t.created_at, t.id
        LIMIT ${limit}
      `
    : await client<DbRow[]>`
        SELECT t.*
        FROM grids.tables t
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE t.base_id = ${baseId}::uuid AND t.deleted_at IS NULL
          AND (${search} = '' OR t.name ILIKE ${searchPattern} ESCAPE '\\' OR t.short_id ILIKE ${searchPattern} ESCAPE '\\')
        ORDER BY CASE WHEN lower(t.name) = lower(${search}) OR t.short_id = ${search} THEN 0 ELSE 1 END,
          t.position, t.created_at, t.id
        LIMIT ${limit}
      `;
  return rows.map(mapRow);
};

/**
 * Soft-deleted tables for a base, newest-deletion first. Used by
 * the base-settings trash view to surface restorable resources. Returns
 * empty if the parent base itself is trashed (top-down restore: act on
 * the base first).
 */
export const listTrashedByBase = async (baseId: string): Promise<Table[]> => {
  // SELECT t.* (not bare COLS) — see listByBase for rationale: both
  // `tables.id` and `bases.id` exist after the JOIN, so unqualified
  // column names in the projection raise 42702.
  const rows = await sql<DbRow[]>`
    SELECT t.*
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.base_id = ${baseId}::uuid AND t.deleted_at IS NOT NULL
    ORDER BY t.deleted_at DESC
  `;
  return rows.map(mapRow);
};

/**
 * Reads a single table. Live-parent invariant: the parent base must be
 * alive (b.deleted_at IS NULL); a leaked UUID under a trashed base never
 * resolves outside the trash flow. Pass `includeDeleted: true` to allow
 * trashed *table* rows (used by the trash listing's restore path); the
 * parent base must still be alive — restore is top-down only.
 */
export const get = async (id: string, opts: { includeDeleted?: boolean } = {}): Promise<Table | null> => {
  // SELECT t.* — see listByBase. Bare COLS would be ambiguous after
  // the JOIN to grids.bases (both carry `id`).
  const [row] = opts.includeDeleted
    ? await sql<DbRow[]>`
        SELECT t.*
        FROM grids.tables t
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE t.id = ${id}::uuid
      `
    : await sql<DbRow[]>`
        SELECT t.*
        FROM grids.tables t
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE t.id = ${id}::uuid AND t.deleted_at IS NULL
      `;
  return row ? mapRow(row) : null;
};

/**
 * Look up a table by (baseId, slug). Used at the SSR-route boundary
 * to resolve URL slugs to UUIDs. Returns null for soft-deleted tables
 * AND for any table whose parent base is trashed (live-parent invariant).
 */
export const getByShortIdForBase = async (baseId: string, shortId: string): Promise<Table | null> => {
  // SELECT t.* — see listByBase for rationale.
  const [row] = await sql<DbRow[]>`
    SELECT t.*
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.base_id = ${baseId}::uuid AND t.short_id = ${shortId} AND t.deleted_at IS NULL
  `;
  return row ? mapRow(row) : null;
};

/** Resolves the only public table identifier to the internal resource. */
export const getByShortId = async (shortId: string): Promise<Table | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT t.*
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.short_id = ${shortId} AND t.deleted_at IS NULL
  `;
  return row ? mapRow(row) : null;
};

const ensureUniqueTableName = async (
  baseId: string,
  name: string,
  exceptTableId: string | null = null,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM grids.tables
    WHERE base_id = ${baseId}::uuid
      AND deleted_at IS NULL
      AND lower(trim(name)) = ${normalizeRefKey(name)}
      AND (${exceptTableId}::uuid IS NULL OR id <> ${exceptTableId}::uuid)
  `;
  return (row?.count ?? 0) === 0 ? ok() : fail(err.conflict(messages.tableNameUnique));
};

export const create = async (input: CreateTableInput, actorId: string | null, locale?: string): Promise<Result<Table>> => {
  const messages = getGridsCrudMessages(locale);
  const name = input.name.trim();
  if (name.length === 0) return fail(err.badInput(messages.nameRequired));
  const uniqueName = await ensureUniqueTableName(input.baseId, name, null, locale);
  if (!uniqueName.ok) return uniqueName;
  const columnsParsed = FieldColumnSpecSchema.array().safeParse(input.columns ?? []);
  if (!columnsParsed.success) return fail(err.badInput(messages.invalidTableColumns));
  const displayConfigParsed = RecordDisplayConfigSchema.safeParse(input.displayConfig ?? { mode: "table" });
  if (!displayConfigParsed.success) return fail(err.badInput(messages.invalidTableDisplayConfig));
  if (tableFieldReferences(columnsParsed.data, displayConfigParsed.data, {}).length > 0) {
    return fail(err.badInput(messages.newTableFieldReference));
  }

  const kind = input.kind ?? "stored";
  const inserted = await writeNamedResource(
    () =>
      sql.begin(async (tx) => {
        const row = await insertWithShortId<DbRow>(async (shortId) => {
          const [created] = await tx<DbRow[]>`
            INSERT INTO grids.tables (
              short_id, base_id, kind, name, description, icon, columns, display_config, position, disable_direct_insert
            )
            VALUES (
              ${shortId},
              ${input.baseId}::uuid,
              ${kind},
              ${name},
              ${input.description ?? null},
              ${input.icon ?? null},
              ${columnsParsed.data}::jsonb,
              ${displayConfigParsed.data}::jsonb,
              COALESCE((SELECT MAX(position) + 1 FROM grids.tables WHERE base_id = ${input.baseId}::uuid AND deleted_at IS NULL), 0),
              ${kind === "federated"}
            )
            RETURNING ${COLS}
          `;
          if (!created) throw new Error("insert returned no row");
          return created;
        }, "idx_grids_tables_short_id");
        if (kind === "federated") {
          await tx`
            INSERT INTO grids.federated_table_revisions (table_id, revision, status, created_by)
            VALUES (${row.id as string}::uuid, 1, 'draft', ${actorId}::uuid)
          `;
        }
        return row;
      }),
    "idx_grids_tables_live_name",
    messages.tableNameUnique,
  );
  if (!inserted.ok) return inserted;
  const table = mapRow(inserted.data);
  await logAudit({ baseId: input.baseId, tableId: table.id, userId: actorId, action: "created" });
  await emitMetadataEvent({
    type: "table.created",
    baseId: input.baseId,
    resource: { kind: "table", id: table.id, tableId: table.id },
    actorId,
  });
  return ok(table);
};

export const update = async (id: string, input: UpdateTableInput, actorId: string | null, locale?: string): Promise<Result<Table>> => {
  const messages = getGridsCrudMessages(locale);
  const result = await sql.begin(async (tx): Promise<Result<{ table: Table; changed: boolean }>> => {
    // Field deletion takes the same lock before checking policy dependents.
    // Validation therefore always sees a stable table/field combination.
    const [lockedRow] = await tx<DbRow[]>`
      SELECT t.*
      FROM grids.tables t
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE t.id = ${id}::uuid AND t.deleted_at IS NULL
      FOR UPDATE OF t
    `;
    if (!lockedRow) return fail(err.notFound(messages.table));
    const existing = mapRow(lockedRow);

    const name = input.name?.trim();
    if (name !== undefined && name.length === 0) return fail(err.badInput(messages.nameEmpty));
    const next = {
      name: name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      icon: input.icon !== undefined ? input.icon : existing.icon,
      columns: input.columns !== undefined ? input.columns : existing.columns,
      displayConfig: input.displayConfig !== undefined ? input.displayConfig : existing.displayConfig,
      auditPolicy: existing.kind === "federated" ? {} : input.auditPolicy !== undefined ? input.auditPolicy : existing.auditPolicy,
      disableDirectInsert:
        existing.kind === "federated"
          ? true
          : input.disableDirectInsert !== undefined
            ? input.disableDirectInsert
            : existing.disableDirectInsert,
    };
    const columnsParsed = FieldColumnSpecSchema.array().safeParse(next.columns);
    if (!columnsParsed.success) return fail(err.badInput(messages.invalidTableColumns));
    const displayConfigParsed = RecordDisplayConfigSchema.safeParse(next.displayConfig);
    if (!displayConfigParsed.success) return fail(err.badInput(messages.invalidTableDisplayConfig));
    const auditPolicyParsed = TableAuditPolicySchema.safeParse(next.auditPolicy);
    if (!auditPolicyParsed.success) {
      return fail(err.badInput(auditPolicyParsed.error.issues[0]?.message ?? messages.invalidTableAuditPolicy));
    }
    const fieldRows = await tx<{ id: string }[]>`
      SELECT id::text AS id
      FROM grids.fields
      WHERE table_id = ${id}::uuid AND deleted_at IS NULL
    `;
    const liveFieldIds = new Set(fieldRows.map((field) => field.id));
    const staleFieldId = tableFieldReferences(columnsParsed.data, displayConfigParsed.data, auditPolicyParsed.data).find(
      (fieldId) => !liveFieldIds.has(fieldId),
    );
    if (staleFieldId) return fail(err.badInput(messages.tableUnknownField));

    const updated = await writeNamedResource(
      () =>
        tx.savepoint(async (sp) => {
          const [row] = await sp<DbRow[]>`
            UPDATE grids.tables
            SET name = ${next.name},
                description = ${next.description},
                icon = ${next.icon},
                columns = ${columnsParsed.data}::jsonb,
                display_config = ${displayConfigParsed.data}::jsonb,
                audit_policy = ${auditPolicyParsed.data}::jsonb,
                disable_direct_insert = ${next.disableDirectInsert},
                updated_at = now()
            WHERE id = ${id}::uuid AND deleted_at IS NULL
            RETURNING ${COLS}
          `;
          return row;
        }),
      "idx_grids_tables_live_name",
      messages.tableNameUnique,
    );
    if (!updated.ok) return updated;
    if (!updated.data) return fail(err.internal(messages.updateFailed));
    const table = mapRow(updated.data);

    const diff: Record<string, { old: unknown; new: unknown }> = {};
    if (next.name !== existing.name) diff.name = { old: existing.name, new: next.name };
    if (next.description !== existing.description) {
      diff.description = { old: existing.description, new: next.description };
    }
    if (next.icon !== existing.icon) diff.icon = { old: existing.icon, new: next.icon };
    if (JSON.stringify(columnsParsed.data) !== JSON.stringify(existing.columns)) {
      diff.columns = { old: existing.columns, new: columnsParsed.data };
    }
    if (JSON.stringify(displayConfigParsed.data) !== JSON.stringify(existing.displayConfig)) {
      diff.displayConfig = { old: existing.displayConfig, new: displayConfigParsed.data };
    }
    if (JSON.stringify(auditPolicyParsed.data) !== JSON.stringify(existing.auditPolicy)) {
      diff.auditPolicy = { old: existing.auditPolicy, new: auditPolicyParsed.data };
    }
    if (next.disableDirectInsert !== existing.disableDirectInsert) {
      diff.disableDirectInsert = { old: existing.disableDirectInsert, new: next.disableDirectInsert };
    }
    const changed = Object.keys(diff).length > 0;
    if (changed) {
      await logAudit({ baseId: table.baseId, tableId: id, userId: actorId, action: "updated", diff }, tx);
    }
    return ok({ table, changed });
  });
  if (!result.ok) return result;

  if (result.data.changed) {
    await emitMetadataEvent({
      type: "table.updated",
      baseId: result.data.table.baseId,
      resource: { kind: "table", id, tableId: id },
      actorId,
    });
  }
  return ok(result.data.table);
};

/**
 * Soft-deletes the table. The row stays in the DB; child entities
 * (fields/records/views/forms) are *not* automatically tombstoned —
 * they simply become unreachable through the API while the parent
 * table is hidden. Restore brings them all back.
 */
export const remove = async (id: string, actorId: string | null, locale?: string): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const existing = await get(id);
  if (!existing) return fail(err.notFound(messages.table));
  await sql.begin(async (tx) => {
    await degradeForTableSchemaChange(id, actorId, tx);
    await tx`UPDATE grids.tables SET deleted_at = now() WHERE id = ${id}::uuid AND deleted_at IS NULL`;
    await logAudit({ baseId: existing.baseId, tableId: id, userId: actorId, action: "deleted" }, tx);
  });
  await emitMetadataEvent({
    type: "table.deleted",
    baseId: existing.baseId,
    resource: { kind: "table", id, tableId: id },
    actorId,
  });
  await refreshForTableSchemaChange(id, actorId);
  return ok();
};

export const restore = async (id: string, actorId: string | null, locale?: string): Promise<Result<Table>> => {
  const messages = getGridsCrudMessages(locale);
  const existing = await get(id, { includeDeleted: true });
  if (!existing) return fail(err.notFound(messages.table));
  if (existing.deletedAt === null) return ok(existing);
  const restored = await sql.begin(async (tx) => {
    await degradeForTableSchemaChange(id, actorId, tx);
    const result = await writeNamedResource(
      async () => {
        const [row] = await tx<DbRow[]>`
          UPDATE grids.tables SET deleted_at = NULL, updated_at = now()
          WHERE id = ${id}::uuid
          RETURNING ${COLS}
        `;
        return row;
      },
      "idx_grids_tables_live_name",
      messages.tableNameUnique,
    );
    if (!result.ok) return result;
    await logAudit({ baseId: existing.baseId, tableId: id, userId: actorId, action: "restored" }, tx);
    return result;
  });
  if (!restored.ok) return restored;
  const row = restored.data;
  if (!row) return fail(err.internal(messages.restoreFailed));
  const table = mapRow(row);
  await emitMetadataEvent({
    type: "table.restored",
    baseId: existing.baseId,
    resource: { kind: "table", id, tableId: id },
    actorId,
  });
  await refreshForTableSchemaChange(id, actorId);
  return ok(table);
};
