import { sql } from "bun";
import type { FilterTree } from "../contracts";
import { compileFilter, renderClause } from "./filter-compiler";
import { listByTable } from "./field-read";
import { actionError } from "./workflow-action-scope";
import type { SqlClient } from "./audit";

export type AtomicRecordRef = { tableId: string; recordId: string; required: "read" | "write" };
export type AtomicQueryPredicate = {
  fieldId: string;
  op: string;
  value?: unknown;
  caseInsensitive?: boolean;
};

export const requireAtomicTable = async (client: SqlClient, baseId: string, tableId: string): Promise<void> => {
  const [table] = await client<Array<{ id: string }>>`
    SELECT t.id::text AS id
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.id = ${tableId}::uuid
      AND t.base_id = ${baseId}::uuid
      AND t.deleted_at IS NULL
  `;
  if (!table) throw actionError("NOT_FOUND", "Atomic record table is no longer available");
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
  for (const record of ordered) {
    await requireAccess(record);
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
  client?: SqlClient;
  tableId: string;
  predicates: AtomicQueryPredicate[];
  timeZone: string;
}): Promise<boolean> => {
  const client = params.client ?? sql;
  const fields = await listByTable(params.tableId, false, client);
  const filter: FilterTree = {
    op: "AND",
    filters: params.predicates.map((predicate) => ({
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
