import { sql } from "bun";
import { LOOKUP_TARGET_META_KEY, type LookupTargetMeta } from "../lookup-display";
import type { SqlClient } from "./audit";
import { parseJsonbRow } from "./jsonb";
import type { Field } from "./types";

type DbFieldRow = {
  id: string;
  name: string;
  type: string;
  config: unknown;
  icon: string | null;
  deleted_at: Date | null;
};

type TargetField = Pick<Field, "id" | "name" | "type" | "config" | "icon" | "deletedAt">;

const targetMeta = (field: TargetField): LookupTargetMeta => ({
  fieldId: field.id,
  name: field.name,
  type: field.type,
  config: field.config,
  icon: field.icon ?? null,
});

const mapTargetField = (row: DbFieldRow): TargetField => ({
  id: row.id,
  name: row.name,
  type: row.type,
  config: parseJsonbRow<Record<string, unknown>>(row.config, {}),
  icon: row.icon,
  deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
});

export const withLookupTargetMetadata = async (fields: Field[], client: SqlClient = sql): Promise<Field[]> => {
  const targetIds = fields
    .filter((field) => field.type === "lookup" && !field.deletedAt)
    .map((field) => (field.config as { targetFieldId?: unknown }).targetFieldId)
    .filter((id): id is string => typeof id === "string");

  const uniqueTargetIds = [...new Set(targetIds)];
  const lookupTargets = new Map<string, TargetField>();
  if (uniqueTargetIds.length > 0) {
    const rows = await client<DbFieldRow[]>`
      SELECT id::text AS id, name, type, config, icon, deleted_at
      FROM grids.fields
      WHERE id = ANY(${sql.array(uniqueTargetIds, "UUID")})
    `;
    for (const row of rows) lookupTargets.set(row.id, mapTargetField(row));
  }

  return fields.map((field) => {
    if (field.type !== "lookup" || field.deletedAt) return field;
    const targetId = (field.config as { targetFieldId?: unknown }).targetFieldId;
    const target = typeof targetId === "string" ? lookupTargets.get(targetId) : null;
    if (!target || target.deletedAt) return field;
    return {
      ...field,
      config: {
        ...field.config,
        [LOOKUP_TARGET_META_KEY]: targetMeta(target),
      },
    };
  });
};
