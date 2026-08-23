import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import type { RecordSnapshot, RecordSnapshotSummary } from "../contracts";
import { logAudit } from "./audit";
import { type DocumentDbRow, mapRecordSnapshot, mapRecordSnapshotSummary } from "./document-mappers";
import type { AuthorizedRecordAccess } from "./record-access";
import { recordAccessPredicate } from "./record-access";
import { createReader, type RecordReader } from "./record-read";
import type { ExpansionViewer } from "./relation-access";
import { insertWithShortIdForDb } from "./short-id";
import { get as getTable } from "./tables";
import type { Field, GridRecord, Table } from "./types";

const SNAPSHOT_MAX_DEPTH = 4;
const SNAPSHOT_MAX_RECORDS = 500;

type SnapshotRelatedTableTarget = {
  baseId: string;
  tableId: string;
};

export type SnapshotRecordAccessResolver = (target: SnapshotRelatedTableTarget) => Promise<AuthorizedRecordAccess | null>;

export type SnapshotRecord = {
  id: string;
  table: Pick<Table, "id" | "shortId" | "name">;
  fields: Array<
    Pick<
      Field,
      | "id"
      | "shortId"
      | "name"
      | "description"
      | "icon"
      | "type"
      | "config"
      | "position"
      | "required"
      | "presentable"
      | "hideInTable"
      | "defaultValue"
      | "indexed"
      | "uniqueConstraint"
      | "deletedAt"
      | "createdAt"
      | "updatedAt"
    >
  >;
  data: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

const relationIds = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};

const snapshotRecord = (table: Table, fields: Field[], record: GridRecord): SnapshotRecord => ({
  id: record.id,
  table: { id: table.id, shortId: table.shortId, name: table.name },
  fields: fields.map((field) => ({
    id: field.id,
    shortId: field.shortId,
    name: field.name,
    description: field.description,
    icon: field.icon,
    type: field.type,
    config: field.config,
    position: field.position,
    required: field.required,
    presentable: field.presentable,
    hideInTable: field.hideInTable,
    defaultValue: field.defaultValue,
    indexed: field.indexed,
    uniqueConstraint: field.uniqueConstraint,
    deletedAt: field.deletedAt,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
  })),
  data: record.data,
  version: record.version,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt,
});

const buildRecordSnapshotGraph = async (
  tableId: string,
  recordId: string,
  options: {
    baseId: string;
    resolveRecordAccess: SnapshotRecordAccessResolver;
    viewer?: ExpansionViewer;
    dateConfig?: DateContext;
    maxDepth?: number;
    maxRecords?: number;
  },
): Promise<Result<{ root: SnapshotRecord; graph: { rootId: string; records: Record<string, SnapshotRecord> } }>> => {
  const maxDepth = options.maxDepth ?? SNAPSHOT_MAX_DEPTH;
  const maxRecords = options.maxRecords ?? SNAPSHOT_MAX_RECORDS;
  const records: Record<string, SnapshotRecord> = {};
  const seen = new Set<string>();
  const tables = new Map<string, Table>();
  const readers = new Map<string, RecordReader>();
  const recordAccessByTableId = new Map<string, AuthorizedRecordAccess | null>();

  const loadTable = async (tableId: string): Promise<Table | null> => {
    const cached = tables.get(tableId);
    if (cached) return cached;
    const table = await getTable(tableId);
    if (table) tables.set(tableId, table);
    return table;
  };

  const loadRecordAccess = async (table: Table): Promise<AuthorizedRecordAccess | null> => {
    if (recordAccessByTableId.has(table.id)) return recordAccessByTableId.get(table.id) ?? null;
    const access = await options.resolveRecordAccess({ baseId: table.baseId, tableId: table.id });
    recordAccessByTableId.set(table.id, access);
    if (options.viewer) {
      options.viewer.recordAccessByTableId ??= new Map();
      options.viewer.recordAccessByTableId.set(table.id, access);
    }
    return access;
  };

  const loadReader = async (table: Table): Promise<RecordReader | null> => {
    const tableId = table.id;
    const cached = readers.get(tableId);
    if (cached) return cached;
    const recordAccess = await loadRecordAccess(table);
    if (!recordAccess) return null;
    const reader = await createReader(tableId, {
      dateConfig: options.dateConfig,
      recordAccess,
      viewer: options.viewer,
    });
    readers.set(tableId, reader);
    return reader;
  };

  let frontier = [{ tableId, recordId }];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const pendingByTable = new Map<string, Set<string>>();
    for (const item of frontier) {
      const key = `${item.tableId}:${item.recordId}`;
      if (seen.has(key)) continue;
      const pending = pendingByTable.get(item.tableId) ?? new Set<string>();
      pending.add(item.recordId);
      pendingByTable.set(item.tableId, pending);
    }

    const capturedAtDepth: Array<{ record: GridRecord; reader: RecordReader }> = [];
    for (const [currentTableId, recordIds] of pendingByTable) {
      const table = await loadTable(currentTableId);
      if (!table) {
        if (depth === 0) return fail(err.notFound("Table"));
        continue;
      }
      if (depth === 0 && table.baseId !== options.baseId) return fail(err.badInput("record does not belong to base"));

      const ids = [...recordIds];
      const reader = await loadReader(table);
      if (!reader) {
        if (depth === 0) return fail(err.notFound("Record"));
        continue;
      }
      const loaded = await reader.getMany(ids);
      if (seen.size + loaded.length > maxRecords) return fail(err.badInput(`snapshot exceeds ${maxRecords} records`));
      const loadedById = new Map(loaded.map((record) => [record.id, record]));
      for (const id of ids) {
        const record = loadedById.get(id);
        if (!record) {
          if (depth === 0) return fail(err.notFound("Record"));
          continue;
        }
        seen.add(`${currentTableId}:${id}`);
        records[`${currentTableId}:${id}`] = snapshotRecord(table, reader.fields, record);
        capturedAtDepth.push({ record, reader });
      }
    }

    if (depth === maxDepth) break;
    const next: typeof frontier = [];
    for (const { record, reader } of capturedAtDepth) {
      for (const field of reader.fields) {
        if (field.type !== "relation") continue;
        const targetTableId = typeof field.config.targetTableId === "string" ? field.config.targetTableId : null;
        if (!targetTableId) continue;
        for (const targetRecordId of relationIds(record.data[field.id])) next.push({ tableId: targetTableId, recordId: targetRecordId });
      }
    }
    frontier = next;
  }

  const rootId = `${tableId}:${recordId}`;
  const root = records[rootId];
  if (!root) return fail(err.internal("Snapshot root was not captured"));
  for (const captured of Object.values(records)) {
    for (const field of captured.fields) {
      if (field.type !== "relation") continue;
      const targetTableId = typeof field.config.targetTableId === "string" ? field.config.targetTableId : null;
      if (!targetTableId) continue;
      captured.data[field.id] = relationIds(captured.data[field.id]).filter((id) => records[`${targetTableId}:${id}`] !== undefined);
    }
  }
  return ok({ root, graph: { rootId, records } });
};

type CreateRecordSnapshotParams = {
  baseId: string;
  tableId: string;
  recordId: string;
  actorId: string | null;
  resolveRecordAccess: SnapshotRecordAccessResolver;
  viewer?: ExpansionViewer;
  dateConfig?: DateContext;
};

export type RecordSnapshotDraft = Omit<RecordSnapshot, "shortId">;

export const createRecordSnapshotDraft = async (params: CreateRecordSnapshotParams): Promise<Result<RecordSnapshotDraft>> => {
  const graph = await buildRecordSnapshotGraph(params.tableId, params.recordId, {
    baseId: params.baseId,
    resolveRecordAccess: params.resolveRecordAccess,
    viewer: params.viewer,
    dateConfig: params.dateConfig,
  });
  if (!graph.ok) return graph;
  return ok({
    id: Bun.randomUUIDv7(),
    baseId: params.baseId,
    tableId: params.tableId,
    recordId: params.recordId,
    root: graph.data.root,
    graph: graph.data.graph,
    createdBy: params.actorId,
    createdAt: new Date().toISOString(),
  });
};

export const persistRecordSnapshot = async (snapshot: RecordSnapshotDraft, executor: SQL): Promise<Result<RecordSnapshot>> => {
  const row = await insertWithShortIdForDb(executor, "idx_grids_record_snapshots_short_id", async (attempt, shortId) => {
    const [created] = await attempt<DocumentDbRow[]>`
        INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph, created_by, created_at)
        VALUES (${snapshot.id}::uuid, ${shortId}, ${snapshot.baseId}::uuid, ${snapshot.tableId}::uuid, ${snapshot.recordId}::uuid, ${snapshot.root}::jsonb, ${snapshot.graph}::jsonb, ${snapshot.createdBy}::uuid, ${snapshot.createdAt})
        RETURNING *
      `;
    if (!created) throw new Error("insert returned no row");
    return created;
  });
  if (!row) return fail(err.internal("Could not create record snapshot"));
  const persisted = mapRecordSnapshot(row);
  const rootVersion = typeof snapshot.root.version === "number" ? snapshot.root.version : null;
  await logAudit(
    {
      baseId: snapshot.baseId,
      tableId: snapshot.tableId,
      recordId: snapshot.recordId,
      userId: snapshot.createdBy,
      action: "record_snapshot.created",
      diff: {
        snapshotId: { old: null, new: snapshot.id },
        recordVersion: { old: null, new: rootVersion },
      },
    },
    executor,
  );
  return ok(persisted);
};

export const createRecordSnapshot = async (params: CreateRecordSnapshotParams): Promise<Result<RecordSnapshot>> => {
  const draft = await createRecordSnapshotDraft(params);
  if (!draft.ok) return draft;
  return sql.begin((tx) => persistRecordSnapshot(draft.data, tx));
};

export const getSnapshot = async (snapshotId: string): Promise<RecordSnapshot | null> => {
  const [row] = await sql<DocumentDbRow[]>`SELECT * FROM grids.record_snapshots WHERE id = ${snapshotId}::uuid`;
  return row ? mapRecordSnapshot(row) : null;
};

export const getSnapshotByShortId = async (shortId: string): Promise<RecordSnapshot | null> => {
  const [row] = await sql<DocumentDbRow[]>`SELECT * FROM grids.record_snapshots WHERE short_id = ${shortId}`;
  return row ? mapRecordSnapshot(row) : null;
};

const snapshotGraphParts = (snapshot: RecordSnapshot): { rootId: string; records: Record<string, unknown> } => {
  const source =
    snapshot.graph && typeof snapshot.graph === "object" && !Array.isArray(snapshot.graph)
      ? (snapshot.graph as Record<string, unknown>)
      : {};
  const rootId = `${snapshot.tableId}:${snapshot.recordId}`;
  const records =
    source.records && typeof source.records === "object" && !Array.isArray(source.records)
      ? (source.records as Record<string, unknown>)
      : {};
  return { rootId, records };
};

export const filterSnapshotRelatedRecords = async (
  snapshot: RecordSnapshot,
  resolveRecordAccess: SnapshotRecordAccessResolver,
): Promise<RecordSnapshot> => {
  const { rootId, records } = snapshotGraphParts(snapshot);
  const filteredRecords: Record<string, unknown> = { [rootId]: snapshot.root };
  const accessByTableId = new Map<string, AuthorizedRecordAccess | null>();
  const idsByTableId = new Map<string, Set<string>>();

  for (const [key, value] of Object.entries(records)) {
    if (key === rootId || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const tableValue = (value as { table?: unknown }).table;
    if (!tableValue || typeof tableValue !== "object" || Array.isArray(tableValue)) continue;
    const tableId = (tableValue as { id?: unknown }).id;
    if (typeof tableId !== "string") continue;

    const recordId = key.startsWith(`${tableId}:`) ? key.slice(tableId.length + 1) : null;
    if (!recordId) continue;
    const ids = idsByTableId.get(tableId) ?? new Set<string>();
    ids.add(recordId);
    idsByTableId.set(tableId, ids);
  }

  for (const tableId of idsByTableId.keys()) {
    const table = await getTable(tableId);
    accessByTableId.set(tableId, table ? await resolveRecordAccess({ baseId: table.baseId, tableId }) : null);
  }
  const clauses = [...idsByTableId].flatMap(([tableId, ids]) => {
    const access = accessByTableId.get(tableId);
    if (!access) return [];
    return [
      sql`(r.table_id = ${tableId}::uuid AND r.id = ANY(${sql.array([...ids], "UUID")}::uuid[]) AND ${recordAccessPredicate(access, "r")})`,
    ];
  });
  if (clauses.length > 0) {
    const where = clauses.slice(1).reduce((combined, clause) => sql`${combined} OR ${clause}`, clauses[0]!);
    const rows = await sql<Array<{ id: string; table_id: string }>>`
      SELECT r.id::text, r.table_id::text
      FROM grids.records r
      WHERE (${where})
    `;
    for (const row of rows) {
      const key = `${row.table_id}:${row.id}`;
      const value = records[key];
      if (value !== undefined) filteredRecords[key] = value;
    }
  }

  const sanitizedRecords = Object.fromEntries(
    Object.entries(filteredRecords).map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [key, value];
      const record = value as SnapshotRecord;
      const data = { ...record.data };
      for (const field of record.fields ?? []) {
        if (field.type !== "relation") continue;
        const targetTableId = typeof field.config.targetTableId === "string" ? field.config.targetTableId : null;
        if (!targetTableId) continue;
        data[field.id] = relationIds(data[field.id]).filter((id) => filteredRecords[`${targetTableId}:${id}`] !== undefined);
      }
      return [key, { ...record, data }];
    }),
  );
  const root = (sanitizedRecords[rootId] ?? snapshot.root) as Record<string, unknown>;
  return { ...snapshot, root, graph: { rootId, records: sanitizedRecords } };
};

export const listSnapshotsForRecord = async (tableId: string, recordId: string, limit = 100): Promise<RecordSnapshotSummary[]> => {
  const cap = Math.min(Math.max(limit, 1), 500);
  const rows = await sql<DocumentDbRow[]>`
    SELECT snapshot.id, snapshot.base_id, snapshot.table_id, snapshot.record_id, snapshot.created_by, snapshot.created_at
    FROM grids.record_snapshots snapshot
    WHERE snapshot.table_id = ${tableId}::uuid
      AND snapshot.record_id = ${recordId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM grids.documents run
        WHERE run.snapshot_id = snapshot.id
      )
    ORDER BY snapshot.created_at DESC
    LIMIT ${cap}
  `;
  return rows.map(mapRecordSnapshotSummary);
};
