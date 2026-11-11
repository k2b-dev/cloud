import { sql } from "@k2b/cloud";
import { CodeBridgeRefusal } from "@k2b/cloud/api";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { readCodeDatabaseConfig } from "./database";
import { createCodeDatabaseClient } from "./database-client";
import { readCode } from "./store";

/** Browser and CLI export the same authorized snapshot; the caller never chooses an upstream namespace. */
export async function exportCodeDatabase(
  codeId: string,
  context: CodeContext,
  factory: typeof createCodeDatabaseClient = createCodeDatabaseClient,
): Promise<Response> {
  const { permission } = await readCode(codeId, context);
  if (permission !== "editor" && !codePerson(context).roles.includes("admin"))
    throw new CodeDataError("NOT_FOUND", "Code database not found.");
  const [mapping] = await sql<{ namespace: string; server_url: string; connected: boolean; reserved_bytes: string }[]>`
    SELECT namespace,server_url,connected,reserved_bytes::text FROM code.databases WHERE code_id=${codeId}`;
  if (!mapping?.connected) throw new CodeDataError("NOT_FOUND", "No database has been created for this Code.");
  const config = await readCodeDatabaseConfig();
  if (config.url !== mapping.server_url) throw new CodeBridgeRefusal("code_db_unavailable", 503);
  const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(context.signal ? [context.signal] : [])]);
  const response = await factory(config, signal).export(mapping.namespace, Number(mapping.reserved_bytes));
  await sql`UPDATE code.databases SET last_access_at=clock_timestamp() WHERE code_id=${codeId} AND namespace=${mapping.namespace}`.catch(
    () => {},
  );
  response.headers.set("content-disposition", `attachment; filename="${codeId}.sqlite"`);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}
