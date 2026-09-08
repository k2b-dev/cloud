import type { RecordQuery } from "../contracts";
import { recordMetaRequiresDeletedRows } from "../service/record-metadata";
import type { DslTableSource } from "./resolver-context";
import type { DslResolvedSqlQueryPlan } from "./resolver-plan-types";

/** Structured queries already carry bound internal IDs. Authorization and field
 * validation belong to the caller; execution uses the same plan as parsed GQL.
 * Group order belongs to groupBy/groupSort. An ordinary row sort can remain in
 * editor state but does not change group order, just as in the records service. */
export const recordQueryPlan = (params: {
  source: DslTableSource;
  query: RecordQuery;
  readableTableIds: readonly string[];
}): DslResolvedSqlQueryPlan => ({
  source: params.source,
  tableId: params.source.id,
  readableTableIds: [...params.readableTableIds],
  query: recordMetaRequiresDeletedRows(params.query.recordMeta) ? { ...params.query, deletedOnly: true } : params.query,
});
