import { type AccessUser, listUsersWithAccess } from "@valentinkolb/cloud/server";
import { type SQLQuery, sql } from "bun";
import type { RecordMetaQuery, RecordMetaUserKey } from "../contracts";

type RecordActor = {
  id: string;
  label: string;
  subtitle: string | null;
  avatarHash: string | null;
};

const nonEmpty = (ids: string[] | undefined): string[] => [...new Set((ids ?? []).filter(Boolean))];

export const cleanRecordMeta = (meta: RecordMetaQuery | null | undefined): RecordMetaQuery | undefined => {
  if (!meta) return undefined;
  const ids = nonEmpty(meta.ids);
  const finalizationStates = [...new Set(meta.finalizationStates ?? [])];
  const createdBy = nonEmpty(meta.users?.createdBy);
  const updatedBy = nonEmpty(meta.users?.updatedBy);
  const deletedBy = nonEmpty(meta.users?.deletedBy);
  const users =
    createdBy.length || updatedBy.length || deletedBy.length
      ? {
          ...(createdBy.length ? { createdBy } : {}),
          ...(updatedBy.length ? { updatedBy } : {}),
          ...(deletedBy.length ? { deletedBy } : {}),
        }
      : undefined;
  return ids.length || finalizationStates.length || users
    ? { ...(ids.length ? { ids } : {}), ...(finalizationStates.length ? { finalizationStates } : {}), ...(users ? { users } : {}) }
    : undefined;
};

export const recordMetaRequiresDeletedRows = (meta: RecordMetaQuery | null | undefined): boolean => {
  const cleaned = cleanRecordMeta(meta);
  return Boolean(cleaned?.users?.deletedBy?.length);
};

export const compileRecordMetaFilter = (meta: RecordMetaQuery | null | undefined): any => {
  const cleaned = cleanRecordMeta(meta);
  const parts: SQLQuery[] = [];

  const ids = cleaned?.ids ?? [];
  if (ids.length > 0) parts.push(sql`r.id = ANY(${sql.array(ids, "UUID")})`);

  const finalizationStates = cleaned?.finalizationStates ?? [];
  if (finalizationStates.length > 0) {
    const validPending = sql`EXISTS (
      SELECT 1
      FROM grids.record_finalization_requests finalization_request
      JOIN grids.table_finalization_activations finalization_activation
        ON finalization_activation.table_id = finalization_request.table_id
       AND finalization_activation.mode = 'four_eyes'
       AND finalization_activation.policy_revision = finalization_request.policy_revision
      WHERE finalization_request.record_id = r.id
        AND finalization_request.record_version = r.version
        AND finalization_request.status = 'pending'
    )`;
    const finalizationEnabled = sql`EXISTS (
      SELECT 1
      FROM grids.records finalization_record
      JOIN grids.table_finalization_activations finalization_activation
        ON finalization_activation.table_id = finalization_record.table_id
      WHERE finalization_record.id = r.id
    )`;
    const stateParts: SQLQuery[] = [];
    if (finalizationStates.includes("finalized")) stateParts.push(sql`r.finalized_at IS NOT NULL`);
    if (finalizationStates.includes("awaitingReview")) stateParts.push(sql`r.finalized_at IS NULL AND ${validPending}`);
    if (finalizationStates.includes("draft")) {
      stateParts.push(sql`r.finalized_at IS NULL AND ${finalizationEnabled} AND NOT (${validPending})`);
    }
    parts.push(stateParts.slice(1).reduce((acc, cur) => sql`${acc} OR (${cur})`, sql`(${stateParts[0]})`));
  }

  const createdBy = cleaned?.users?.createdBy ?? [];
  if (createdBy.length > 0) parts.push(sql`r.created_by = ANY(${sql.array(createdBy, "UUID")})`);

  const updatedBy = cleaned?.users?.updatedBy ?? [];
  if (updatedBy.length > 0) parts.push(sql`r.updated_by = ANY(${sql.array(updatedBy, "UUID")})`);

  const deletedBy = cleaned?.users?.deletedBy ?? [];
  if (deletedBy.length > 0) parts.push(sql`(r.deleted_at IS NOT NULL AND r.updated_by = ANY(${sql.array(deletedBy, "UUID")}))`);

  return parts.length > 0 ? parts.reduce((acc, cur) => sql`${acc} AND ${cur}`) : sql`TRUE`;
};

const listTableAccessIds = async (tableId: string): Promise<string[]> => {
  const rows = await sql<Array<{ access_id: string }>>`
    SELECT ba.access_id::text AS access_id
    FROM grids.tables t
    JOIN grids.base_access ba ON ba.base_id = t.base_id
    WHERE t.id = ${tableId}::uuid AND t.deleted_at IS NULL
  `;
  return rows.map((row) => row.access_id);
};

const actorSubtitle = (user: AccessUser): string => {
  const source = user.source.type === "direct" ? "direct access" : `via ${user.source.groupName}`;
  return `${user.uid} · ${source}`;
};

export const listRecordActors = async (params: {
  tableId: string;
  kind?: RecordMetaUserKey | "any";
  q?: string;
  ids?: string[];
  limit?: number;
}): Promise<RecordActor[]> => {
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 50);
  const ids = nonEmpty(params.ids);
  const users = await listUsersWithAccess({
    accessIds: await listTableAccessIds(params.tableId),
    search: params.q,
    userIds: ids,
    minimumPermission: "read",
    limit,
  });

  return users.map((user) => ({
    id: user.id,
    label: user.displayName,
    subtitle: actorSubtitle(user),
    avatarHash: user.avatarHash,
  }));
};
