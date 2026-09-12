import type { DslQueryPreviewResponse } from "../contracts";
import { projectPublicIds } from "./public-resource-ids";

const requiredPublicId = (ids: ReadonlyMap<string, string>, internalId: string, resource: string): string => {
  const id = ids.get(internalId);
  if (!id) throw new Error(`Missing public ID for ${resource}`);
  return id;
};

export const toPublicGqlResponse = async (response: DslQueryPreviewResponse, deps: { projectIds?: typeof projectPublicIds } = {}) => {
  if (!response.ok) return response;
  const tableIds = [
    ...response.rows.flatMap((row) => (row.tableId ? [row.tableId] : [])),
    ...response.columns.flatMap((column) => (column.tableId ? [column.tableId] : [])),
  ];
  const fieldIds = response.columns.flatMap((column) => (column.fieldId ? [column.fieldId] : []));
  const recordIds = response.rows.flatMap((row) => (row.recordId ? [row.recordId] : []));
  const relationRecordIds = response.rows.flatMap((row) =>
    response.columns.flatMap((column) => {
      if (column.type !== "relation" || (column.sqlType !== "uuid" && column.sqlType !== "uuid[]")) return [];
      const value = row.values[column.key];
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string"
          ? [value]
          : [];
    }),
  );
  const projectIds = deps.projectIds ?? projectPublicIds;
  // A workflow capture supplies one transaction connection. Keep its batched
  // queries ordered rather than concurrently pipelining them on that connection.
  const tables = await projectIds("table", tableIds);
  const fields = await projectIds("field", fieldIds);
  const records = await projectIds("record", [...recordIds, ...relationRecordIds]);
  const columns = response.columns.map((column) => {
    const fieldId = column.fieldId ? requiredPublicId(fields, column.fieldId, "field") : undefined;
    const tableId = column.tableId ? requiredPublicId(tables, column.tableId, "table") : undefined;
    const key =
      column.fieldId && fieldId && (column.key === column.fieldId || column.key.startsWith(`${column.fieldId}__`))
        ? `${fieldId}${column.key.slice(column.fieldId.length)}`
        : column.key;
    return { ...column, key, ...(tableId ? { tableId } : {}), ...(fieldId ? { fieldId } : {}) };
  });
  return {
    ...response,
    columns,
    rows: response.rows.map((row) => ({
      ...row,
      ...(row.recordId ? { recordId: requiredPublicId(records, row.recordId, "record") } : {}),
      ...(row.tableId ? { tableId: requiredPublicId(tables, row.tableId, "table") } : {}),
      values: Object.fromEntries(
        response.columns.map((column, index) => {
          const value = row.values[column.key];
          const projected =
            column.type === "relation" && (column.sqlType === "uuid" || column.sqlType === "uuid[]")
              ? Array.isArray(value)
                ? value.map((item) => (typeof item === "string" ? requiredPublicId(records, item, "record") : item))
                : typeof value === "string"
                  ? requiredPublicId(records, value, "record")
                  : value
              : value;
          return [columns[index]!.key, projected];
        }),
      ),
    })),
  };
};
