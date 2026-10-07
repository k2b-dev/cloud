import { z } from "zod";
import { DatabaseSql, DbName, DbRow } from "./database-contracts";
import { CloudError } from "./runtime/errors";

const Id = z.number().int().positive();
const Table = z.object({ table: DbName });
export const FlatDatabaseRequest = z.discriminatedUnion("operation", [
  Table.extend({
    operation: z.literal("list"),
    where: z.record(DbName, z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).default({}),
    order: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().nonnegative().default(0),
  }).strict(),
  Table.extend({ operation: z.literal("get"), id: Id }).strict(),
  Table.extend({ operation: z.literal("insert"), rows: z.union([DbRow, z.array(DbRow).min(1).max(1000)]) }).strict(),
  Table.extend({ operation: z.literal("update"), id: Id, values: DbRow }).strict(),
  Table.extend({ operation: z.literal("delete"), id: Id }).strict(),
  DatabaseSql.extend({ operation: z.literal("query") }),
]);
export type FlatDatabaseRequest = z.infer<typeof FlatDatabaseRequest>;
export const TableSchema = z
  .object({ columns: z.array(z.object({ name: z.string(), type: z.string() })), metadata: z.record(z.string(), z.unknown()).nullish() })
  .passthrough();
export type TableSchema = z.infer<typeof TableSchema>;
export const managedColumns = ["id", "created_at", "updated_at", "created_by", "updated_by"];
export const tableWrite = (schema: TableSchema) => z.enum(["everyone", "own", "managers"]).parse(schema.metadata?.write ?? "everyone");
export function checkRowWrite(
  rule: "everyone" | "own" | "managers",
  requester: string | null,
  manager: boolean,
  operation: "insert" | "update" | "delete",
  row?: Record<string, unknown> | null,
) {
  if (!requester || (rule === "managers" && !manager) || (rule === "own" && operation !== "insert" && row && row.created_by !== requester))
    throw new CloudError("denied", "You do not have permission to write this table.");
}
export function checkColumns(schema: TableSchema, names: string[], writing = false) {
  const columns = schema.columns.map((column) => column.name);
  for (const name of names) {
    if (!columns.includes(name)) throw new CloudError("invalid", `Unknown column "${name}"; existing columns: ${columns.join(", ")}.`);
    if (writing && managedColumns.includes(name.toLowerCase()))
      throw new CloudError("invalid", `Cloud manages ${name}; omit it from the values.`);
  }
}
export function listSql(req: Extract<FlatDatabaseRequest, { operation: "list" }>, schema: TableSchema) {
  checkColumns(schema, Object.keys(req.where));
  const params: (string | number | boolean | null)[] = [];
  const where = Object.entries(req.where).map(([name, value]) => {
    if (value === null) return `"${name}" IS NULL`;
    params.push(typeof value === "boolean" ? Number(value) : value);
    return `"${name}" = ?`;
  });
  let order = '"id" ASC';
  if (req.order) {
    const match = /^(-?)([A-Za-z][A-Za-z0-9_]*)(?: (asc|desc))?$/i.exec(req.order);
    if (!match) throw new CloudError("invalid", 'Use order "name", "-updated_at" or "name desc".');
    const [, minus, name, direction] = match;
    checkColumns(schema, [name!]);
    order = `"${name}" ${minus ? "DESC" : (direction?.toUpperCase() ?? "ASC")}`;
  }
  return {
    sql: `SELECT "id" FROM "${req.table}"${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ${req.limit ?? 1001} OFFSET ${req.offset}`,
    params,
  };
}
export function typedRow(row: Record<string, unknown>, schema: TableSchema) {
  const output = { ...row };
  for (const column of schema.columns) {
    const value = row[column.name];
    if (value === null || value === undefined) continue;
    if (column.type === "boolean") output[column.name] = value === true || value === 1 || value === "1";
    if (column.type === "json" && typeof value === "string") output[column.name] = JSON.parse(value);
  }
  return output;
}
export function pageRows(data: unknown) {
  return z.object({ data: z.array(z.record(z.string(), z.unknown())).nullish() }).parse(data).data ?? [];
}
export function boundedRows(rows: Record<string, unknown>[]) {
  if (rows.length > 1000) throw new CloudError("limit", "More than 1,000 rows match; set limit and offset to page through the results.");
  return rows;
}
export async function listRows(
  req: Extract<FlatDatabaseRequest, { operation: "list" }>,
  schema: TableSchema,
  query: (input: ReturnType<typeof listSql>) => Promise<unknown>,
  list: (input: { id: string; limit: number }) => Promise<unknown>,
) {
  const selected = boundedRows(pageRows(await query(listSql(req, schema))));
  if (!selected.length) return [];
  // tables.get exposes SQLite storage types (integer/text), not rsql's
  // logical boolean/json types. Only row endpoints apply the stored schema.
  const ids = selected.map((row) => Id.parse(row.id));
  const typed = pageRows(await list({ id: `in.(${ids.join(",")})`, limit: ids.length }));
  const byId = new Map(typed.map((row) => [Id.parse(row.id), row]));
  // Keep the SQL selection's order; rows.list has its own default ordering.
  // A row deleted between the two reads is omitted.
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
