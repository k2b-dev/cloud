import { sql } from "bun";
import { decryptValue, encryptValue } from "../services/settings/crypto";
import { AiRequestHeadersSchema, patchAiRequestHeaders } from "../shared/ai-request-options";

type SqlClient = typeof sql;

const decryptHeaders = async (providerId: string, secret: string): Promise<Record<string, string>> => {
  try {
    const parsed = AiRequestHeadersSchema.safeParse(await decryptValue(secret));
    if (parsed.success && Object.values(parsed.data).every((value) => typeof value === "string"))
      return patchAiRequestHeaders({}, parsed.data);
  } catch {}
  console.warn(`[ai] ignoring unreadable request headers for provider ${JSON.stringify(providerId)}`);
  return {};
};

/** Secrets stay server-side, in a separate encrypted row like provider API keys. */
export const getAiRequestHeaders = async (providerId: string, db: SqlClient = sql): Promise<Record<string, string>> => {
  const [row] = await db<{ secret: string }[]>`SELECT secret FROM ai.provider_request_headers WHERE provider_id = ${providerId}`;
  return row ? decryptHeaders(providerId, row.secret) : {};
};

export const setAiRequestHeaders = async (providerId: string, headers: Record<string, string>, db: SqlClient = sql): Promise<void> => {
  const normalized = patchAiRequestHeaders({}, headers);
  if (!Object.keys(normalized).length) {
    await db`DELETE FROM ai.provider_request_headers WHERE provider_id = ${providerId}`;
    return;
  }
  const encrypted = await encryptValue(normalized);
  await db`INSERT INTO ai.provider_request_headers (provider_id, secret) VALUES (${providerId}, ${encrypted})
    ON CONFLICT (provider_id) DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`;
};

/** Admin reads contain names only. Never serialize header values into providers. */
export const listAiRequestHeaderNames = async (db: SqlClient = sql): Promise<Record<string, string[]>> => {
  const rows = await db<{ provider_id: string; secret: string }[]>`SELECT provider_id, secret FROM ai.provider_request_headers`;
  const names: Record<string, string[]> = {};
  for (const row of rows)
    Object.defineProperty(names, row.provider_id, {
      value: Object.keys(await decryptHeaders(row.provider_id, row.secret)).sort(),
      enumerable: true,
    });
  return names;
};
