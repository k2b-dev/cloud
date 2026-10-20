import { arg, type CliInputFlagValue, type CloudCliContext, command, flag, readCliInput } from "@k2b/cloud/cli";
import { SqlInputError, validateSqlInput } from "../sql-params";
import type { SqlResult } from "../service/sql-service";
import { requireDefaultBaseRef } from "./context";
import { baseFlag } from "./flags";
import { jsonRequest } from "./shared";

export const sqlInputFlags = {
  file: flag.string({ aliases: ["f"], valueLabel: "path", description: "Read SQL from a file; use - for stdin" }),
  param: flag.stringList({ separator: "\u0000", description: "Bind name=value; repeat for each parameter" }),
};

export const parseSqlParameters = (values: string[]): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const value of values) {
    const split = value.indexOf("=");
    const name = value.slice(0, split);
    if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Use --param name=value.");
    if (Object.hasOwn(params, name)) throw new Error("Each parameter may be supplied only once.");
    Object.defineProperty(params, name, { value: value.slice(split + 1), enumerable: true });
  }
  return params;
};

export const readSqlInput = async (positional: string | undefined, file: string | undefined): Promise<string> => {
  if (positional !== undefined && file !== undefined) throw new Error("Pass SQL or --file, not both.");
  const source = file ?? positional;
  if (source === undefined) throw new Error("Pass SQL, --file <path>, or - for stdin.");
  const input: CliInputFlagValue =
    source === "-"
      ? { source: "stdin", provided: true }
      : file !== undefined
        ? { source: "file", file, provided: true }
        : { source: "value", value: source, provided: true };
  return (await readCliInput(input, { label: "SQL", required: true }))!;
};

export const sqlExitCode = (code: string): number => {
  if (["INPUT_TOO_LARGE", "PARAMETER_MISSING", "BAD_INPUT"].includes(code)) return 2;
  if (code === "SQL_ERROR") return 3;
  if (["TIME_LIMIT", "MEMORY_LIMIT", "RESULT_TOO_LARGE"].includes(code)) return 4;
  if (["BUSY", "QUEUE_FULL", "QUOTA"].includes(code)) return 5;
  if (["NO_READ_ACCESS", "FORBIDDEN", "ACCESS_DENIED"].includes(code)) return 6;
  if (code === "CANCELLED") return 130;
  return 7;
};

const csvCell = (value: unknown): string => {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const printSqlResult = (ctx: CloudCliContext, result: SqlResult, format?: "table" | "json" | "csv") => {
  if (format === "json" || (!format && ctx.options.output === "json")) ctx.json(result);
  else if (!format && ctx.options.output === "jsonl") for (const row of result.rows) ctx.jsonLine(row);
  else if (format === "csv") {
    ctx.print(result.columns.map((column) => csvCell(column.name)).join(","));
    for (const row of result.rows) ctx.print(row.map(csvCell).join(","));
  } else {
    // Index keys preserve duplicate SQL column names.
    ctx.table(
      result.rows.map((row) => Object.fromEntries(row.map((cell, index) => [String(index), cell]))),
      result.columns.map((column, index) => ({ key: String(index), label: column.name })),
    );
  }
  if (result.truncated) ctx.error("The 10,000-row limit was reached; there may be more rows.");
};

export const sqlCommand = command("sql", {
  summary: "Run read-only SQL in one Pulse base",
  description: "SQL is limited to 16 KiB and 32 parameters. Ctrl-C cancels the run. See the sql reference for exit codes.",
  args: { sql: arg.optional({ valueLabel: "sql-or--", description: "SQL text or - to read stdin" }) },
  flags: { ...baseFlag, ...sqlInputFlags, format: flag.enum(["table", "json", "csv"], { description: "Result format" }) },
  examples: [
    "cld pulse sql --base Base01 'SELECT count() FROM events'",
    "cld pulse sql --base Base01 --file query.sql --param from=2026-10-20",
  ],
  async run({ ctx, args, flags }) {
    let sql: string;
    let params: Record<string, string>;
    let base: string;
    try {
      sql = await readSqlInput(args.sql, flags.file);
      params = parseSqlParameters(flags.param);
      validateSqlInput(sql, params);
      base = flags.base ?? (await requireDefaultBaseRef(ctx));
    } catch (error) {
      const code = error instanceof SqlInputError ? error.code : "BAD_INPUT";
      ctx.error(`${code}: ${error instanceof Error ? error.message : "Invalid SQL input."}`);
      return sqlExitCode(code);
    }
    const runId = crypto.randomUUID();
    const path = `/api/pulse/bases/${encodeURIComponent(base)}/sql`;
    const controller = new AbortController();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (cancellation) return;
      cancellation = ctx
        .fetch(`${path}/cancel`, { ...jsonRequest("POST", { runId }), signal: AbortSignal.timeout(3000) })
        .then((response) => {
          if (!response.ok) ctx.error("CANCELLED: The cancellation request failed; the connection was closed.");
        })
        .catch(() => ctx.error("CANCELLED: The cancellation request failed; the connection was closed."));
      controller.abort();
    };
    process.once("SIGINT", cancel);
    try {
      const response = await ctx.fetch(path, { ...jsonRequest("POST", { sql, params, runId }), signal: controller.signal });
      if (controller.signal.aborted) {
        ctx.error("CANCELLED: Query cancelled.");
        return 130;
      }
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "STORE_UNAVAILABLE";
        // Only Pulse's fixed error classes may supply a message. Never reflect arbitrary upstream bodies.
        const known = [
          "SQL_ERROR",
          "TIME_LIMIT",
          "MEMORY_LIMIT",
          "RESULT_TOO_LARGE",
          "INPUT_TOO_LARGE",
          "PARAMETER_MISSING",
          "BUSY",
          "QUEUE_FULL",
          "QUOTA",
          "STORE_UNAVAILABLE",
          "NO_READ_ACCESS",
          "CANCELLED",
        ];
        const message =
          known.includes(code) && body && typeof body === "object" && "message" in body && typeof body.message === "string"
            ? body.message
            : "Pulse SQL request failed.";
        ctx.error(`${code}: ${message}`);
        return sqlExitCode(code);
      }
      printSqlResult(ctx, (await response.json()) as SqlResult, flags.format);
      return 0;
    } catch {
      const code = controller.signal.aborted ? "CANCELLED" : "STORE_UNAVAILABLE";
      ctx.error(`${code}: ${controller.signal.aborted ? "Query cancelled." : "Pulse SQL request failed."}`);
      return sqlExitCode(code);
    } finally {
      process.removeListener("SIGINT", cancel);
      await cancellation;
    }
  },
});
