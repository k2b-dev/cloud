import { z } from "zod";
import { LIMITS } from "./contracts";
export const DbName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .max(63)
  .describe("Table or column identifier; letters, digits and underscores, starting with a letter.");
export const DbColumn = z
  .object({
    name: DbName.refine(name => !["id", "created_at", "updated_at"].includes(name.toLowerCase()), { message: "id, created_at and updated_at are managed by rsql; omit them." }).describe("Custom column name; id, created_at and updated_at are automatic and must be omitted."),
    type: z
      .enum(["text", "integer", "real", "boolean", "json", "date", "datetime"])
      .describe("Column value type; integer for exact minor currency units."),
    not_null: z.boolean().optional().describe("Whether null values are rejected."),
    unique: z.boolean().optional().describe("Whether values must be unique."),
    index: z.boolean().optional().describe("Whether to index this column."),
  })
  .strict();
export const DbRow = z
  .record(z.string().max(63), z.json())
  .describe("Column values; do not supply managed id, created_at or updated_at columns.");
const filterValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const DbQuery = z
  .record(z.string().max(200), z.union([filterValue, z.array(filterValue).max(LIMITS.rows)]))
  .describe("rsql row filters, projection, order and pagination; limit at most 1000.");
export const DatabaseSql = z.object({
    sql: z.string().trim().min(1).max(LIMITS.text).describe("A bounded SELECT using supported functions; no writes, CTEs, comments or internal objects."),
    params: z.array(z.json()).max(LIMITS.rows).default([]).describe("Values bound to SQL placeholders, in order."),
}).strict();
export const DatabaseRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("tables.list").describe("Database operation: tables.list.") }),
  z.object({
    operation: z.literal("tables.create").describe("Database operation: tables.create."),
    name: DbName,
    columns: z.array(DbColumn).min(1).max(LIMITS.rows).describe("Custom columns only. rsql automatically adds id, created_at and updated_at; never declare them."),
  }),
  z.object({
    operation: z.literal("tables.update").describe("Database operation: tables.update."),
    table: DbName,
    changes: z
      .object({
        rename: DbName.optional(),
        add_columns: z.array(DbColumn).optional().describe("New column definitions."),
        drop_columns: z.array(DbName).optional().describe("Existing columns to remove."),
        rename_columns: z.record(DbName, DbName).optional().describe("Mapping from existing column names to new names."),
      })
      .strict()
      .describe("Explicit schema changes; existing columns are preserved unless listed."),
  }),
  z.object({ operation: z.literal("tables.delete").describe("Database operation: tables.delete."), table: DbName }),
  z.object({ operation: z.literal("schema.get").describe("Database operation: schema.get."), table: DbName }),
  z.object({ operation: z.literal("rows.list").describe("Database operation: rows.list."), table: DbName, query: DbQuery.default({}) }),
  z.object({
    operation: z.literal("rows.get").describe("Database operation: rows.get."),
    table: DbName,
    id: z.number().int().positive().describe("Positive record id returned by rsql."),
  }),
  z.object({
    operation: z.literal("rows.insert").describe("Database operation: rows.insert."),
    table: DbName,
    rows: z.union([DbRow, z.array(DbRow).min(1).max(LIMITS.rows)]).describe("One record or an atomic batch of up to 1000 records."),
  }),
  z.object({
    operation: z.literal("rows.update").describe("Database operation: rows.update."),
    table: DbName,
    id: z.number().int().positive().describe("Positive record id returned by rsql."),
    row: DbRow,
  }),
  z.object({
    operation: z.literal("rows.delete").describe("Database operation: rows.delete."),
    table: DbName,
    id: z.number().int().positive().describe("Positive record id returned by rsql."),
  }),
  DatabaseSql.extend({ operation: z.literal("query").describe("Database operation: query.") }),
]);
export type DatabaseRequest = z.infer<typeof DatabaseRequest>;
export const DatabaseCall = z
  .object({
    generation: z.number().int().positive().describe("Exact generation from database.status; never guess or increment it."),
    request: DatabaseRequest.describe("One database operation bound to this app."),
  })
  .strict();
export const DatabaseSettings = z
  .object({ enabled: z.boolean(), url: z.string().max(2048), token: z.string().max(4096).optional() })
  .strict();
