import { sql } from "bun";
import { decryptValue, encryptValue } from "../services/settings/crypto";

type SqlClient = typeof sql;

/** Provider keys are encrypted at rest and never returned by an API. */
export const getAiCredential = async (providerId: string, db: SqlClient = sql): Promise<string | null> => {
  const [row] = await db<{ secret: string }[]>`
    SELECT secret FROM ai.provider_credentials WHERE provider_id = ${providerId}
  `;
  if (!row) return null;
  try {
    const value = await decryptValue(row.secret);
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    console.warn(`[ai] ignoring unreadable provider credential for provider ${JSON.stringify(providerId)}`);
    return null;
  }
};

/** Store or replace a provider's key. */
export const setAiCredential = async (providerId: string, secret: string, db: SqlClient = sql): Promise<void> => {
  const encrypted = await encryptValue(secret);
  await db`
    INSERT INTO ai.provider_credentials (provider_id, secret)
    VALUES (${providerId}, ${encrypted})
    ON CONFLICT (provider_id) DO UPDATE
      SET secret = EXCLUDED.secret,
          updated_at = now()
  `;
};

/** Provider IDs whose stored key can currently be decrypted and used. */
export const listAiCredentialProviderIds = async (db: SqlClient = sql): Promise<string[]> => {
  const rows = await db<{ provider_id: string; secret: string }[]>`SELECT provider_id, secret FROM ai.provider_credentials`;
  const usable: string[] = [];
  for (const row of rows) {
    try {
      const value = await decryptValue(row.secret);
      if (typeof value === "string" && value.trim()) usable.push(row.provider_id);
    } catch {
      console.warn(`[ai] ignoring unreadable provider credential for provider ${JSON.stringify(row.provider_id)}`);
    }
  }
  return usable;
};
