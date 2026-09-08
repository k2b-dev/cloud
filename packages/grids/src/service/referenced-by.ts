import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { mapFieldRow } from "./field-read";
import { parseJsonbRow } from "./jsonb";
import { relationLabelFields } from "./relation-targets";
import type { Field } from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2_000;
const CURSOR_SIGNATURE_DOMAIN = "grids:referenced-by-cursor:v1\0";

const StoredCursorSchema = z
  .object({
    v: z.literal(1),
    f: z.string().length(43),
    field: ShortIdSchema,
    record: ShortIdSchema,
  })
  .strict();

type CursorBoundary = { fieldId: string; recordId: string };

type ReferencedByCursorScope = {
  targetTableId: string;
  targetRecordId: string;
  relationFieldId?: string | null;
};

type ReferencedByItem = {
  sourceTableId: string;
  sourceTableShortId: string;
  sourceTableName: string;
  sourceRecordId: string;
  sourceRecordShortId: string;
  sourceRecordLabel: string;
  relationFieldId: string;
  relationFieldShortId: string;
  relationFieldName: string;
};

export type ReferencedByPage = {
  items: ReferencedByItem[];
  nextCursor: string | null;
};

type LinkRow = {
  source_table_id: string;
  source_table_short_id: string;
  source_table_name: string;
  source_record_id: string;
  source_record_short_id: string;
  source_record_data: unknown;
  relation_field_id: string;
  relation_field_short_id: string;
  relation_field_name: string;
};

const signingKey = (): string => {
  const key = process.env.APP_SECRET?.trim();
  if (!key) throw new Error("APP_SECRET is required for referenced-by pagination");
  return key;
};

const cursorFingerprint = (scope: ReferencedByCursorScope): string =>
  createHash("sha256")
    .update(scope.targetTableId)
    .update("\0")
    .update(scope.targetRecordId)
    .update("\0")
    .update(scope.relationFieldId ?? "")
    .digest("base64url");

const cursorSignature = (payload: string, key: string): string =>
  createHmac("sha256", key).update(CURSOR_SIGNATURE_DOMAIN).update(payload).digest("base64url");

export const encodeReferencedByCursor = (scope: ReferencedByCursorScope, boundary: CursorBoundary, key = signingKey()): string => {
  const stored = {
    v: 1,
    f: cursorFingerprint(scope),
    field: ShortIdSchema.parse(boundary.fieldId),
    record: ShortIdSchema.parse(boundary.recordId),
  } as const;
  const payload = Buffer.from(JSON.stringify(stored), "utf8").toString("base64url");
  return `${payload}.${cursorSignature(payload, key)}`;
};

export const decodeReferencedByCursor = (
  value: string | null | undefined,
  scope: ReferencedByCursorScope,
  key = signingKey(),
): CursorBoundary | null => {
  if (!value || value.length > MAX_CURSOR_LENGTH) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(cursorSignature(payload, key), "utf8");
    const received = Buffer.from(signature, "utf8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const parsed = StoredCursorSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.f !== cursorFingerprint(scope)) return null;
    return { fieldId: parsed.data.field, recordId: parsed.data.record };
  } catch {
    return null;
  }
};

const formatLabelPart = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatLabelPart).filter(Boolean).join(", ");
  if (typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (typeof object.label === "string") return object.label;
  if (typeof object.amount === "string") return object.amount;
  return "";
};

const recordLabel = (data: Record<string, unknown>, fields: Field[]): string => {
  const parts = relationLabelFields(fields)
    .map((field) => formatLabelPart(data[field.id]))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Untitled record";
};

const loadFieldsByTable = async (tableIds: readonly string[], client: SqlClient): Promise<Map<string, Field[]>> => {
  if (tableIds.length === 0) return new Map();
  const rows = await client<Array<Record<string, unknown>>>`
    SELECT field.*
    FROM grids.fields field
    JOIN grids.tables table_ref ON table_ref.id = field.table_id AND table_ref.deleted_at IS NULL
    JOIN grids.bases base ON base.id = table_ref.base_id AND base.deleted_at IS NULL
    WHERE field.table_id = ANY(${client.array([...new Set(tableIds)], "UUID")}::uuid[])
      AND field.deleted_at IS NULL
    ORDER BY field.table_id, field.position, field.created_at
  `;
  const fieldsByTable = new Map<string, Field[]>();
  for (const row of rows) {
    const field = mapFieldRow(row);
    const fields = fieldsByTable.get(field.tableId) ?? [];
    fields.push(field);
    fieldsByTable.set(field.tableId, fields);
  }
  return fieldsByTable;
};

const targetIsReadable = async (targetTableId: string, targetRecordId: string, client: SqlClient): Promise<boolean> => {
  const [target] = await client<Array<{ id: string }>>`
    SELECT target.id::text
    FROM grids.records target
    JOIN grids.tables target_table
      ON target_table.id = target.table_id
     AND target_table.deleted_at IS NULL
     AND target_table.kind = 'stored'
    JOIN grids.bases target_base
      ON target_base.id = target_table.base_id
     AND target_base.deleted_at IS NULL
    WHERE target.id = ${targetRecordId}::uuid
      AND target.table_id = ${targetTableId}::uuid
      AND target.deleted_at IS NULL
  `;
  return Boolean(target);
};

export const listReferencedBy = async (params: {
  targetTableId: string;
  targetRecordId: string;
  relationFieldId?: string | null;
  cursor?: string | null;
  limit?: number;
  client?: SqlClient;
  cursorSigningKey?: string;
  locale?: string;
}): Promise<Result<ReferencedByPage>> => {
  const messages = getGridsCrudMessages(params.locale);
  const client = params.client ?? sql;
  const relationFieldId = params.relationFieldId ?? null;
  if (relationFieldId && !ShortIdSchema.safeParse(relationFieldId).success) {
    return fail(err.badInput(messages.invalidReferencedByField));
  }
  if (!(await targetIsReadable(params.targetTableId, params.targetRecordId, client))) {
    return fail(err.notFound(messages.record));
  }

  const scope: ReferencedByCursorScope = {
    targetTableId: params.targetTableId,
    targetRecordId: params.targetRecordId,
    relationFieldId,
  };
  const cursor = params.cursor ? decodeReferencedByCursor(params.cursor, scope, params.cursorSigningKey ?? signingKey()) : null;
  if (params.cursor && !cursor) return fail(err.badInput(messages.invalidReferencedByCursor));
  if (cursor) {
    const [boundary] = await client<Array<{ valid: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM grids.fields WHERE short_id = ${cursor.fieldId})
         AND EXISTS (SELECT 1 FROM grids.records WHERE short_id = ${cursor.recordId}) AS valid
    `;
    if (!boundary?.valid) return fail(err.badInput(messages.invalidReferencedByCursor));
  }

  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await client<LinkRow[]>`
    WITH target AS (
      SELECT target.id, target.table_id, target_table.base_id
      FROM grids.records target
      JOIN grids.tables target_table
        ON target_table.id = target.table_id
       AND target_table.deleted_at IS NULL
       AND target_table.kind = 'stored'
      JOIN grids.bases target_base
        ON target_base.id = target_table.base_id
       AND target_base.deleted_at IS NULL
      WHERE target.id = ${params.targetRecordId}::uuid
        AND target.table_id = ${params.targetTableId}::uuid
        AND target.deleted_at IS NULL
    ), requested_field AS (
      SELECT relation_field.id
      FROM target
      JOIN grids.tables source_table
        ON source_table.base_id = target.base_id
       AND source_table.deleted_at IS NULL
       AND source_table.kind = 'stored'
      JOIN grids.fields relation_field
        ON relation_field.table_id = source_table.id
       AND relation_field.deleted_at IS NULL
       AND relation_field.type = 'relation'
      WHERE relation_field.short_id = ${relationFieldId}
        AND relation_field.config->>'targetTableId' = target.table_id::text
    ), cursor_boundary AS (
      SELECT boundary_field.id AS field_id, boundary_record.id AS record_id
      FROM grids.fields boundary_field
      CROSS JOIN grids.records boundary_record
      WHERE boundary_field.short_id = ${cursor?.fieldId ?? null}
        AND boundary_record.short_id = ${cursor?.recordId ?? null}
    )
    SELECT source_table.id::text AS source_table_id,
           source_table.short_id AS source_table_short_id,
           source_table.name AS source_table_name,
           source_record.id::text AS source_record_id,
           source_record.short_id AS source_record_short_id,
           source_record.data AS source_record_data,
           relation_field.id::text AS relation_field_id,
           relation_field.short_id AS relation_field_short_id,
           relation_field.name AS relation_field_name
    FROM target
    JOIN grids.record_links link ON link.to_record_id = target.id
    JOIN grids.fields relation_field
      ON relation_field.id = link.from_field_id
     AND relation_field.deleted_at IS NULL
     AND relation_field.type = 'relation'
     AND relation_field.config->>'targetTableId' = target.table_id::text
    JOIN grids.records source_record
      ON source_record.id = link.from_record_id
     AND source_record.table_id = relation_field.table_id
     AND source_record.deleted_at IS NULL
    JOIN grids.tables source_table
      ON source_table.id = source_record.table_id
     AND source_table.base_id = target.base_id
     AND source_table.deleted_at IS NULL
     AND source_table.kind = 'stored'
    JOIN grids.bases source_base
      ON source_base.id = source_table.base_id
     AND source_base.deleted_at IS NULL
    WHERE (${relationFieldId}::text IS NULL OR link.from_field_id = (SELECT id FROM requested_field))
      AND (
        ${cursor?.fieldId ?? null}::text IS NULL
        OR (link.from_field_id, link.from_record_id) > (
          (SELECT field_id FROM cursor_boundary),
          (SELECT record_id FROM cursor_boundary)
        )
      )
    ORDER BY link.from_field_id, link.from_record_id
    LIMIT ${limit + 1}
  `;

  const pageRows = rows.slice(0, limit);
  const fieldsByTable = await loadFieldsByTable(
    pageRows.map((row) => row.source_table_id),
    client,
  );
  const items = pageRows.map(
    (row): ReferencedByItem => ({
      sourceTableId: row.source_table_id,
      sourceTableShortId: row.source_table_short_id,
      sourceTableName: row.source_table_name,
      sourceRecordId: row.source_record_id,
      sourceRecordShortId: row.source_record_short_id,
      sourceRecordLabel: recordLabel(
        parseJsonbRow<Record<string, unknown>>(row.source_record_data, {}),
        fieldsByTable.get(row.source_table_id) ?? [],
      ),
      relationFieldId: row.relation_field_id,
      relationFieldShortId: row.relation_field_short_id,
      relationFieldName: row.relation_field_name,
    }),
  );
  const last = items[items.length - 1];
  return ok({
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeReferencedByCursor(
            scope,
            { fieldId: last.relationFieldShortId, recordId: last.sourceRecordShortId },
            params.cursorSigningKey ?? signingKey(),
          )
        : null,
  });
};
