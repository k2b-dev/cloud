import { sql } from "bun";
import type { FilterTree } from "../contracts";
import type { SqlClient } from "./audit";
import { listByTable } from "./field-read";
import { compileFilter, renderClause } from "./filter-compiler";
import { fromPublicRelationValues } from "./public-resources";
import { validateRelationTargets } from "./relation-links";
import type { Field } from "./types";
import {
  actionError,
  type GridsWorkflowActionScope,
  requireOk,
  requireTableAccess,
  type WorkflowEffectAccess,
} from "./workflow-action-scope";

export type AtomicRecordRef = { tableId: string; recordId: string; required: "read" | "write" };
export type AtomicQueryPredicate = {
  fieldId: string;
  op: string;
  value?: unknown;
  caseInsensitive?: boolean;
};

export const requireWorkflowTable = async (client: SqlClient, baseId: string, tableId: string): Promise<void> => {
  const [table] = await client<Array<{ id: string }>>`
    SELECT t.id::text AS id
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.id = ${tableId}::uuid
      AND t.base_id = ${baseId}::uuid
      AND t.deleted_at IS NULL
  `;
  if (!table) throw actionError("NOT_FOUND", "Workflow record table is no longer available");
};

/** Workflow payloads use public relation IDs, even though field bindings are internal. */
export const resolveWorkflowRecordValues = async (
  scope: GridsWorkflowActionScope,
  fields: readonly Field[],
  values: Record<string, unknown>,
  client: SqlClient = sql,
  effectAccess?: WorkflowEffectAccess,
): Promise<Record<string, unknown>> => {
  const relations = fields.filter((field) => {
    const value = values[field.id];
    return field.type === "relation" && field.id in values && value !== null && !(Array.isArray(value) && value.length === 0);
  });
  for (const field of relations) {
    const targetTableId = field.config.targetTableId;
    if (typeof targetTableId !== "string") throw actionError("WORKFLOW_VALUE_INVALID", "Relation target table is missing");
    if (effectAccess) await effectAccess.requireTable(targetTableId);
    else {
      await requireWorkflowTable(client, scope.baseId, targetTableId);
      await requireTableAccess(scope, targetTableId, "read", client);
    }
  }
  const resolved = requireOk(await fromPublicRelationValues(fields, values, {}, client));
  for (const field of relations) {
    const value = resolved[field.id];
    const ids =
      typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    const targetTableId = field.config.targetTableId;
    if (typeof targetTableId !== "string") throw actionError("WORKFLOW_VALUE_INVALID", "Relation target table is missing");
    if (!(await validateRelationTargets(targetTableId, ids, client)).ok) {
      throw actionError("WORKFLOW_VALUE_INVALID", "Related records are unavailable in the relation target table");
    }
  }
  return resolved;
};

/**
 * Lock every coordination and update target in one stable order before any
 * assertion is evaluated. A check that currently matches no rows cannot lock
 * the absence itself; the explicit coordination record closes that race.
 */
export const lockAtomicRecords = async (
  client: SqlClient,
  records: AtomicRecordRef[],
  requireAccess: (record: AtomicRecordRef) => Promise<void>,
  additionalTableIds: readonly string[] = [],
): Promise<void> => {
  const requiredByRecord = new Map<string, AtomicRecordRef>();
  for (const record of records) {
    const key = `${record.tableId}:${record.recordId}`;
    const existing = requiredByRecord.get(key);
    if (!existing || record.required === "write") requiredByRecord.set(key, record);
  }

  const ordered = [...requiredByRecord.values()].sort((left, right) =>
    left.tableId === right.tableId ? left.recordId.localeCompare(right.recordId) : left.tableId.localeCompare(right.tableId),
  );
  for (const record of ordered) await requireAccess(record);
  // Match ordinary writers: parent locks precede row locks. Acquire every
  // table in one order, including create-only targets, before any change runs.
  const tableIds = [...new Set([...ordered.map((record) => record.tableId), ...additionalTableIds])].sort();
  const baseIds = new Set<string>();
  for (const tableId of tableIds) {
    const [table] = await client<Array<{ base_id: string }>>`
      SELECT base_id::text FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL
    `;
    if (!table) throw actionError("ATOMIC_LOCK_UNAVAILABLE", "A table required by the atomic change is no longer available");
    baseIds.add(table.base_id);
  }
  for (const baseId of [...baseIds].sort()) {
    const [base] = await client<Array<{ id: string }>>`
      SELECT id::text FROM grids.bases WHERE id = ${baseId}::uuid AND deleted_at IS NULL FOR SHARE
    `;
    if (!base) throw actionError("ATOMIC_LOCK_UNAVAILABLE", "The base required by the atomic change is no longer available");
  }
  for (const tableId of tableIds) {
    const [table] = await client<Array<{ id: string }>>`
      SELECT id::text FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL FOR SHARE
    `;
    if (!table) throw actionError("ATOMIC_LOCK_UNAVAILABLE", "A table required by the atomic change is no longer available");
  }
  for (const record of ordered) {
    const [locked] = await client<Array<{ id: string }>>`
      SELECT r.id::text AS id
      FROM grids.records r
      WHERE r.table_id = ${record.tableId}::uuid
        AND r.id = ${record.recordId}::uuid
        AND r.deleted_at IS NULL
      FOR UPDATE OF r
    `;
    if (!locked) throw actionError("ATOMIC_LOCK_UNAVAILABLE", "A record required by the atomic change is no longer available");
  }
};

export const atomicQueryMatches = async (params: {
  scope: GridsWorkflowActionScope;
  client?: SqlClient;
  tableId: string;
  predicates: AtomicQueryPredicate[];
  timeZone: string;
  effectAccess?: WorkflowEffectAccess;
}): Promise<boolean> => {
  const client = params.client ?? sql;
  const fields = await listByTable(params.tableId, false, client);
  const predicates: AtomicQueryPredicate[] = [];
  for (const predicate of params.predicates) {
    if (predicate.value === undefined) {
      predicates.push(predicate);
      continue;
    }
    const values = await resolveWorkflowRecordValues(
      params.scope,
      fields,
      { [predicate.fieldId]: predicate.value },
      client,
      params.effectAccess,
    );
    predicates.push({ ...predicate, value: values[predicate.fieldId] });
  }
  const filter: FilterTree = {
    op: "AND",
    filters: predicates.map((predicate) => ({
      fieldId: predicate.fieldId,
      op: predicate.op,
      ...(predicate.value === undefined ? {} : { value: predicate.value }),
      ...(predicate.caseInsensitive === undefined ? {} : { caseInsensitive: predicate.caseInsensitive }),
    })),
  };
  const compiled = compileFilter(filter, fields, { timeZone: params.timeZone });
  if (!compiled.ok) throw actionError("WORKFLOW_VALUE_INVALID", `Atomic check is invalid: ${compiled.error}`);

  const [row] = await client<Array<{ matches: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM grids.records r
      WHERE r.table_id = ${params.tableId}::uuid
        AND r.deleted_at IS NULL
        AND ${renderClause(compiled.clause, { recordAlias: "r" })}
      LIMIT 1
    ) AS matches
  `;
  return row?.matches === true;
};
