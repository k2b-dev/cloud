import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { SqlClient } from "./audit";
import { runBoundedQuery } from "./bounded-query";
import { liveRecordParentJoinSql } from "./parent-checks";
import { accessibleRecordIdsByTable, type ExpansionViewer } from "./relation-access";
import type { Field, GridRecord } from "./types";

type DbRow = Record<string, unknown>;

export const validateRelationTargets = async (
  targetTableId: string,
  targetIds: string[],
  client: SqlClient = sql,
): Promise<{ ok: true } | { ok: false; missing: string[] }> => {
  if (targetIds.length === 0) return { ok: true };
  const rows = await client<{ id: string }[]>`
    SELECT r.id::text AS id
    FROM grids.records r
    ${liveRecordParentJoinSql("r", "rt", "rb")}
    WHERE r.id = ANY(${client.array(targetIds, "UUID")})
      AND r.table_id = ${targetTableId}::uuid
      AND r.deleted_at IS NULL
  `;
  const found = new Set(rows.map((row) => row.id));
  const missing = targetIds.filter((id) => !found.has(id));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
};

const replaceRecordLinks = async (client: SqlClient, fromRecordId: string, fromFieldId: string, toRecordIds: string[]): Promise<void> => {
  await client`
    DELETE FROM grids.record_links
    WHERE from_record_id = ${fromRecordId}::uuid
      AND from_field_id = ${fromFieldId}::uuid
  `;
  if (toRecordIds.length === 0) return;
  const values = toRecordIds
    .map((id, index) => client`(${fromRecordId}::uuid, ${fromFieldId}::uuid, ${id}::uuid, ${index})`)
    .reduce((accumulator, current) => client`${accumulator}, ${current}`);
  await client`
    INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
    VALUES ${values}
    ON CONFLICT (from_record_id, from_field_id, to_record_id) DO UPDATE
      SET position = EXCLUDED.position
  `;
};

export const writeRecordLinks = async (
  fromRecordId: string,
  fromFieldId: string,
  toRecordIds: string[],
  client?: SqlClient,
): Promise<void> => {
  if (client) {
    await replaceRecordLinks(client, fromRecordId, fromFieldId, toRecordIds);
    return;
  }
  await sql.begin((tx) => replaceRecordLinks(tx, fromRecordId, fromFieldId, toRecordIds));
};

type RelationReadOptions = { signal?: AbortSignal; queryTimeoutMs?: number; client?: SqlClient };

export const readRecordLinksBatch = async (
  recordIds: string[],
  fieldIds: string[],
  options: RelationReadOptions = {},
): Promise<Map<string, Map<string, string[]>>> => {
  const links = new Map<string, Map<string, string[]>>();
  const client = options.client ?? sql;
  if (recordIds.length === 0 || fieldIds.length === 0) return links;
  const query = client<DbRow[]>`
    SELECT from_record_id, from_field_id, to_record_id, position
    FROM grids.record_links
    WHERE from_record_id = ANY(${toPgUuidArray(recordIds)}::uuid[])
      AND from_field_id = ANY(${toPgUuidArray(fieldIds)}::uuid[])
    ORDER BY from_record_id, from_field_id, position
  `;
  const rows =
    options.queryTimeoutMs !== undefined || options.signal
      ? await runBoundedQuery<DbRow>(query, options.queryTimeoutMs ?? 5_000, options.signal, undefined, options.client)
      : await query;
  for (const row of rows) {
    const recordId = row.from_record_id as string;
    const fieldId = row.from_field_id as string;
    const targetId = row.to_record_id as string;
    let recordLinks = links.get(recordId);
    if (!recordLinks) {
      recordLinks = new Map();
      links.set(recordId, recordLinks);
    }
    const targets = recordLinks.get(fieldId) ?? [];
    targets.push(targetId);
    recordLinks.set(fieldId, targets);
  }
  return links;
};

export const hydrateRelationsFromLinks = async (
  records: GridRecord[],
  fields: Field[],
  viewer?: ExpansionViewer,
  options: RelationReadOptions = {},
): Promise<void> => {
  if (records.length === 0) return;
  const relationFields = fields.filter((field) => field.type === "relation" && !field.deletedAt);
  if (relationFields.length === 0) return;
  const links = await readRecordLinksBatch(
    records.map((record) => record.id),
    relationFields.map((field) => field.id),
    options,
  );
  options.signal?.throwIfAborted();
  let accessibleByTableId: Map<string, Set<string>> | undefined;
  if (viewer) {
    const idsByTableId = new Map<string, Set<string>>();
    for (const field of relationFields) {
      const targetTableId = typeof field.config.targetTableId === "string" ? field.config.targetTableId : null;
      if (!targetTableId) continue;
      const ids = idsByTableId.get(targetTableId) ?? new Set<string>();
      for (const record of records) for (const id of links.get(record.id)?.get(field.id) ?? []) ids.add(id);
      idsByTableId.set(targetTableId, ids);
    }
    accessibleByTableId = await accessibleRecordIdsByTable(idsByTableId, viewer, options.client ?? sql, options);
  }
  for (const record of records) {
    const recordLinks = links.get(record.id);
    for (const field of relationFields) {
      const linkedIds = recordLinks?.get(field.id) ?? [];
      if (!accessibleByTableId) {
        record.data[field.id] = linkedIds;
        continue;
      }
      const targetTableId = typeof field.config.targetTableId === "string" ? field.config.targetTableId : null;
      const accessibleIds = targetTableId ? accessibleByTableId.get(targetTableId) : undefined;
      record.data[field.id] = accessibleIds ? linkedIds.filter((id) => accessibleIds.has(id)) : [];
    }
  }
};
