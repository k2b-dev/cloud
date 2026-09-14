import { parseArgs } from "node:util";
import { SQL } from "bun";

// Explicit data contracts only: arbitrary JSON values (for example workflow results) are excluded.
export const targets = {
  "audit.events": { id: "bigint", columns: { metadata: "object" } },
  "logging.entries": { id: "bigint", columns: { metadata: "object" } },
  "auth.deleted_accounts": { id: "uuid", columns: { meta: "object" } },
  "auth.signing_keys": { id: "uuid", columns: { public_jwk: "object" } },
  "notifications.batches": { id: "uuid", columns: { selection: "object" } },
  "capabilities.executions": { id: "uuid", columns: { input_meta: "object", output_meta: "object" } },
  "ai.conversations": { id: "uuid", columns: { draft_content: "array" } },
  "ai.messages": { id: "uuid", columns: { message: "object", usage: "object", meta: "object" } },
  "gateway.registered_apps": {
    id: "text",
    columns: {
      appearance: "object",
      runtime: "object",
      nav: "object",
      capabilities: "object",
      routes: "array",
      legal_links: "array",
      widgets: "array",
    },
  },
  "gateway.health_webhooks": { id: "uuid", columns: { scope_app_ids: "array", send_on: "array" } },
  "tools.webhook_logs": { id: "uuid", columns: { request_headers: "object", response_headers: "object" } },
  "venue.public_sections": { id: "uuid", columns: { content: "object" } },
} as const;

export function decodeContainer(encoded: string, kind: string): object | null {
  try {
    const value: unknown = JSON.parse(encoded);
    // Inspect every JSON string token, including duplicate keys/values discarded
    // by JSON.parse. Literal backslash-u text and valid surrogate pairs stay valid.
    const unsupportedText = /\u0000|[\uD800-\uDFFF]/u;
    for (const token of encoded.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      if (unsupportedText.test(JSON.parse(token[0]))) return null;
    }
    if (value === null || typeof value !== "object") return null;
    return Array.isArray(value) === (kind === "array") ? value : null;
  } catch {
    return null;
  }
}

export async function repairJsonbContainers(db: SQL, table: keyof typeof targets, apply = false, batchSize = 500) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive integer");
  const target = targets[table];
  const totals = { candidates: 0, repairable: 0, preserved: 0, updated: 0 };
  for (const [column, kind] of Object.entries(target.columns)) {
    let cursor: string | null = null;
    for (;;) {
      const rows: { id: string; encoded: string }[] = await db.unsafe(
        `SELECT source.id::text AS id, source.${column} #>> '{}' AS encoded FROM ${table} AS source
         WHERE jsonb_typeof(source.${column}) = 'string' AND ($1::${target.id} IS NULL OR source.id > $1::${target.id})
         ORDER BY source.id LIMIT $2`,
        [cursor, batchSize],
      );
      if (!rows.length) break;
      const patches = rows.flatMap((row) => {
        const value = decodeContainer(row.encoded, kind);
        return value ? [row] : [];
      });
      totals.candidates += rows.length;
      totals.repairable += patches.length;
      totals.preserved += rows.length - patches.length;
      if (apply && patches.length) {
        const changed = await db.unsafe(
          `UPDATE ${table} AS target SET ${column} = patch.encoded::jsonb
           FROM jsonb_to_recordset($1::text::jsonb) AS patch(id text, encoded text)
           WHERE target.id = patch.id::${target.id} AND jsonb_typeof(target.${column}) = 'string'
             AND target.${column} #>> '{}' = patch.encoded RETURNING target.id`,
          [JSON.stringify(patches)],
        );
        totals.updated += changed.length;
      }
      cursor = rows[rows.length - 1]!.id;
    }
  }
  return totals;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { table: { type: "string" }, apply: { type: "boolean", default: false } },
      strict: true,
    });
    const table = values.table;
    if (!table || !Object.hasOwn(targets, table)) {
      console.error(`Choose --table from: ${Object.keys(targets).join(", ")}`);
      process.exitCode = 1;
    } else if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL must identify the intended database");
      process.exitCode = 1;
    } else {
      const db = new SQL(process.env.DATABASE_URL);
      try {
        // The allowlist check above confines all SQL identifiers to this file.
        const totals = await repairJsonbContainers(db, table as keyof typeof targets, values.apply);
        console.log(JSON.stringify({ table, mode: values.apply ? "apply" : "dry-run", ...totals }));
      } finally {
        await db.close();
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_")) {
      console.error("Invalid arguments. Usage: bun scripts/repair-jsonb-containers.ts --table TABLE [--apply]");
      process.exitCode = 1;
    } else {
      // Database errors may contain credentials or JSON fragments in DETAIL/CONTEXT.
      console.error("JSON metadata repair failed. Check the database connection and selected table; earlier batches may remain committed.");
      process.exitCode = 1;
    }
  }
}
