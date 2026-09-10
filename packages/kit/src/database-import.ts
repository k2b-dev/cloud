import { timing } from "@k2b/stdlib";
import { z } from "zod";
import { LIMITS } from "./contracts";
import { DbColumn, DbName, DbRow, type DatabaseRequest } from "./database-contracts";
export const ImportOptions = z
  .object({ createTable: z.boolean().default(false), columns: z.array(DbColumn).optional(), notify: z.boolean().default(true) })
  .strict();
export type ImportProgress = { confirmedRows: number; totalRows: number; phase: "validating" | "writing" };
export type ImportResult = {
  confirmedRows: number;
  totalRows: number;
  status: "complete" | "cancelled" | "failed" | "unknown";
  error?: string;
};
export type DatabaseExecutor = (request: DatabaseRequest) => Promise<unknown>;
export class ImportInputError extends Error {
  constructor(
    public column = "",
    public row?: number,
  ) {
    super("DB_IMPORT_INVALID");
  }
}
const reserved = new Set(["id", "created_at", "updated_at"]);
const encodeSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
// Leave room for the operation envelope within the existing API body budget.
export const IMPORT_BATCH_BYTES = LIMITS.sourceBytes - 1024;
export async function importData(
  table: string,
  input: unknown,
  options: unknown,
  execute: DatabaseExecutor,
  progress: (p: ImportProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<ImportResult> {
  DbName.parse(table);
  const settings = ImportOptions.parse(options ?? {});
  const rows = z.array(DbRow).parse(input);
  if (encodeSize(rows) > LIMITS.rpcBytes) throw new Error("DB_LIMIT");
  const totalRows = rows.length;
  let confirmedRows = 0;
  progress({ confirmedRows, totalRows, phase: "validating" });
  if (!totalRows) return { confirmedRows, totalRows, status: "complete" };
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  for (const key of keys) {
    DbName.parse(key);
    if (reserved.has(key)) throw new ImportInputError(key);
  }
  const inferred = keys.map((name) => {
    const values = rows.map((row) => row[name]).filter((value) => value != null);
    let type: z.infer<typeof DbColumn>["type"] = "text";
    if (values.length) {
      if (values.every((v) => typeof v === "number" && Number.isFinite(v)))
        type = values.every((v) => Number.isSafeInteger(v)) ? "integer" : "real";
      else if (values.every((v) => typeof v === "boolean")) type = "boolean";
      else if (values.every((v) => typeof v === "object")) type = "json";
      else if (!values.every((v) => typeof v === "string")) throw new ImportInputError(name);
    }
    return { name, type };
  });
  const tables = z.array(z.object({ name: z.string() }).passthrough()).parse(await execute({ operation: "tables.list" }));
  const exists = tables.some((t) => t.name === table);
  if (!exists && !settings.createTable) throw new ImportInputError(table);
  const schema = exists
    ? z
        .object({
          columns: z.array(
            z
              .object({
                name: z.string(),
                type: z.string(),
                not_null: z.boolean().optional(),
                read_only: z.boolean().optional(),
                max_length: z.number().optional(),
                min: z.number().optional(),
                max: z.number().optional(),
                pattern: z.string().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(await execute({ operation: "schema.get", table })).columns
    : (settings.columns ?? inferred);
  if (!schema.length) throw new ImportInputError(table);
  const byName = new Map(schema.map((c) => [c.name, c]));
  for (const key of keys) if (!byName.has(key)) throw new ImportInputError(key);
  for (let index = 0; index < rows.length; index++) {
    if (index % LIMITS.rows === 0) await timing.sleep(0);
    signal?.throwIfAborted();
    for (const column of schema) {
      if (reserved.has(column.name)) continue;
      const value = rows[index]![column.name];
      let valid = true;
      if (value == null) valid = !("not_null" in column && column.not_null);
      else if (column.type === "integer")
        valid = (typeof value === "number" && Number.isSafeInteger(value)) || (exists && typeof value === "boolean");
      else if (column.type === "real") valid = typeof value === "number" && Number.isFinite(value);
      else if (column.type === "boolean") valid = typeof value === "boolean";
      else if (column.type === "json") valid = true;
      else valid = typeof value === "string" || (exists && typeof value === "object");
      if (!valid) throw new ImportInputError(column.name, index + 1);
    }
    if (encodeSize(rows[index]) > IMPORT_BATCH_BYTES) throw new ImportInputError("", index + 1);
  }
  if (!exists) await execute({ operation: "tables.create", name: table, columns: settings.columns ?? inferred });
  let offset = 0;
  while (offset < rows.length) {
    if (signal?.aborted) return { confirmedRows, totalRows, status: "cancelled" };
    const batch: typeof rows = [];
    let bytes = 2;
    while (offset < rows.length && batch.length < LIMITS.rows) {
      const row = rows[offset]!,
        size = encodeSize(row) + 1;
      if (batch.length && bytes + size > IMPORT_BATCH_BYTES) break;
      batch.push(row);
      bytes += size;
      offset++;
    }
    try {
      await execute({ operation: "rows.insert", table, rows: batch });
    } catch (error) {
      return { confirmedRows, totalRows, status: "unknown", error: error instanceof Error ? error.message : "Import failed" };
    }
    confirmedRows += batch.length;
    progress({ confirmedRows, totalRows, phase: "writing" });
  }
  return { confirmedRows, totalRows, status: "complete" };
}
