import { sql } from "bun";
import { toPgTextArray } from "../services/postgres";
import { decryptValue, encryptValue } from "../services/settings/crypto";
import type { AiRequestHeaderPatch } from "./request-headers";

type SqlClient = typeof sql;

/**
 * Provider API keys, one per model profile.
 *
 * They used to live on the profile inside the `ai.model_profiles_json` setting.
 * Settings are encrypted at rest but a `text` setting is handed to the admin UI
 * in full, so every key travelled to the browser in the page payload — and the
 * form had to send them back to avoid dropping them while editing a label.
 * Only `kind: "secret"` settings are redacted, and the registry is static, so
 * one setting per profile was never an option.
 *
 * These rows are the answer: encrypted with the same `APP_SECRET` helper the
 * settings store uses, addressed by profile id, and never serialised into
 * anything the client receives.
 */

/** The key for a profile, or null when none is stored. */
export const getAiCredential = async (profileId: string, db: SqlClient = sql): Promise<string | null> => {
  const [row] = await db<{ secret: string }[]>`
    SELECT secret FROM ai.model_credentials WHERE profile_id = ${profileId}
  `;
  if (!row) return null;
  try {
    const value = await decryptValue(row.secret);
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    console.warn(`[ai] ignoring unreadable provider credential for profile ${JSON.stringify(profileId)}`);
    return null;
  }
};

/** Store or replace a profile's key. */
export const setAiCredential = async (profileId: string, secret: string, db: SqlClient = sql): Promise<void> => {
  const encrypted = await encryptValue(secret);
  await db`
    INSERT INTO ai.model_credentials (profile_id, secret)
    VALUES (${profileId}, ${encrypted})
    ON CONFLICT (profile_id) DO UPDATE
      SET secret = EXCLUDED.secret,
          updated_at = now()
  `;
};

/** Profile ids whose stored key can currently be decrypted and used. */
export const listAiCredentialProfileIds = async (db: SqlClient = sql): Promise<string[]> => {
  const rows = await db<{ profile_id: string; secret: string }[]>`SELECT profile_id, secret FROM ai.model_credentials`;
  const usable: string[] = [];
  for (const row of rows) {
    try {
      const value = await decryptValue(row.secret);
      if (typeof value === "string" && value.trim()) usable.push(row.profile_id);
    } catch {
      console.warn(`[ai] ignoring unreadable provider credential for profile ${JSON.stringify(row.profile_id)}`);
    }
  }
  return usable;
};

/**
 * Drop keys for profiles that no longer exist.
 *
 * Profiles live in a JSON setting rather than a table, so there is no foreign
 * key to cascade from. Pruning on save keeps a deleted profile from leaving its
 * key behind, and makes recreating an id a clean slate rather than a silent
 * inheritance.
 */
export const pruneAiCredentials = async (keepProfileIds: readonly string[], db: SqlClient = sql): Promise<void> => {
  if (keepProfileIds.length === 0) {
    await db`DELETE FROM ai.model_credentials`;
    return;
  }
  await db`DELETE FROM ai.model_credentials WHERE profile_id <> ALL(${toPgTextArray([...keepProfileIds])}::text[])`;
};

/**
 * Separate provider keys from the profiles blob.
 *
 * Pure on purpose: the admin route and the one-time migration both need the
 * exact same split, and getting it wrong either leaks a key into a setting or
 * drops one on save. `profilesJson` is what may be stored; `credentials` is
 * what must go into the table; `profileIds` is what survives pruning.
 *
 * Unparseable input is handed back untouched — the settings validator owns that
 * error, and rewriting it here would replace the admin's parse message.
 */
export const splitAiProfileCredentials = (
  rawValue: unknown,
): {
  profilesJson: string;
  credentials: Array<{ profileId: string; secret: string }>;
  profileIds: string[];
  requestHeaders: AiRequestHeaderPatch[];
} | null => {
  if (typeof rawValue !== "string") return null;
  const text = rawValue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const profiles: unknown[] = [];
  const credentials: Array<{ profileId: string; secret: string }> = [];
  const profileIds: string[] = [];
  const requestHeaders: AiRequestHeaderPatch[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      profiles.push(entry);
      continue;
    }
    const {
      apiKey,
      requestHeaders: headerPatch,
      requestHeaderNames: _headerNames,
      credentialSetting: _legacy,
      ...profile
    } = entry as Record<string, unknown>;
    const profileId = typeof profile.id === "string" ? profile.id.trim() : "";
    if (profileId) {
      profile.id = profileId;
      profileIds.push(profileId);
      if (headerPatch !== undefined) requestHeaders.push({ profileId, patch: headerPatch });
      if (typeof apiKey === "string" && apiKey.trim()) credentials.push({ profileId, secret: apiKey.trim() });
    }
    profiles.push(profile);
  }

  return { profilesJson: JSON.stringify(profiles), credentials, profileIds, requestHeaders };
};
