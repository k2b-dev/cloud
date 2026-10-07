import { sql } from "bun";
import { toPgTextArray } from "../services/postgres";
import { decryptValue, encryptValue } from "../services/settings/crypto";
import {
  AI_REQUEST_HEADERS_PROVIDER_ERROR,
  AiRequestHeadersSchema,
  patchAiRequestHeaders,
  providerSupportsRequestHeaders,
} from "../shared/ai-request-options";
import type { AiModelProfile } from "./types";

type SqlClient = typeof sql;
export type AiRequestHeaderPatch = { profileId: string; patch: unknown };

const decryptHeaders = async (profileId: string, secret: string): Promise<Record<string, string>> => {
  try {
    const parsed = AiRequestHeadersSchema.safeParse(await decryptValue(secret));
    if (parsed.success && Object.values(parsed.data).every((value) => typeof value === "string"))
      return patchAiRequestHeaders({}, parsed.data);
  } catch {}
  console.warn(`[ai] ignoring unreadable request headers for profile ${JSON.stringify(profileId)}`);
  return {};
};

/** Secrets stay server-side, in a separate encrypted row like provider API keys. */
export const getAiRequestHeaders = async (profileId: string, db: SqlClient = sql): Promise<Record<string, string>> => {
  const [row] = await db<{ secret: string }[]>`SELECT secret FROM ai.model_request_headers WHERE profile_id = ${profileId}`;
  return row ? decryptHeaders(profileId, row.secret) : {};
};

export const setAiRequestHeaders = async (profileId: string, headers: Record<string, string>, db: SqlClient = sql): Promise<void> => {
  const normalized = patchAiRequestHeaders({}, headers);
  if (!Object.keys(normalized).length) {
    await db`DELETE FROM ai.model_request_headers WHERE profile_id = ${profileId}`;
    return;
  }
  const encrypted = await encryptValue(normalized);
  await db`INSERT INTO ai.model_request_headers (profile_id, secret) VALUES (${profileId}, ${encrypted})
    ON CONFLICT (profile_id) DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`;
};

/** Admin reads contain names only. Never serialize header values into profiles. */
export const listAiRequestHeaderNames = async (db: SqlClient = sql): Promise<Record<string, string[]>> => {
  const rows = await db<{ profile_id: string; secret: string }[]>`SELECT profile_id, secret FROM ai.model_request_headers`;
  const names: Record<string, string[]> = {};
  for (const row of rows)
    Object.defineProperty(names, row.profile_id, {
      value: Object.keys(await decryptHeaders(row.profile_id, row.secret)).sort(),
      enumerable: true,
    });
  return names;
};

export const pruneAiRequestHeaders = async (keepProfileIds: readonly string[], db: SqlClient = sql): Promise<void> => {
  if (!keepProfileIds.length) await db`DELETE FROM ai.model_request_headers`;
  else await db`DELETE FROM ai.model_request_headers WHERE profile_id <> ALL(${toPgTextArray([...keepProfileIds])}::text[])`;
};

/** Follow credentials: changing provider discards stored secrets; omission preserves them on the same provider. */
export const planAiProfileRequestHeaders = (input: {
  currentProfiles: readonly AiModelProfile[];
  nextProfiles: readonly AiModelProfile[];
  existingNames: Record<string, string[]>;
  submitted: readonly AiRequestHeaderPatch[];
}): { keepHeaderProfileIds: string[]; patches: { profileId: string; patch: Record<string, string | null> }[]; error?: string } => {
  const current = new Map(input.currentProfiles.map((profile) => [profile.id, profile]));
  const keepHeaderProfileIds = input.nextProfiles
    .filter(
      (profile) =>
        providerSupportsRequestHeaders(profile.provider) &&
        current.get(profile.id)?.provider === profile.provider &&
        !profile.capabilities.includes("transcription"),
    )
    .map((profile) => profile.id);
  const patches: { profileId: string; patch: Record<string, string | null> }[] = [];
  for (const submitted of input.submitted) {
    const profile = input.nextProfiles.find((profile) => profile.id === submitted.profileId);
    const parsed = AiRequestHeadersSchema.safeParse(submitted.patch);
    if (!parsed.success)
      return { keepHeaderProfileIds: [], patches: [], error: `requestHeaders: ${zodHeaderMessage(parsed.error.issues)}` };
    if (!profile || !providerSupportsRequestHeaders(profile.provider))
      return { keepHeaderProfileIds: [], patches: [], error: AI_REQUEST_HEADERS_PROVIDER_ERROR };
    if (profile.capabilities.includes("transcription"))
      return {
        keepHeaderProfileIds: [],
        patches: [],
        error: "requestHeaders: Request settings are not supported on transcription profiles.",
      };
    const oldNames =
      keepHeaderProfileIds.includes(profile.id) && Object.hasOwn(input.existingNames, profile.id) ? input.existingNames[profile.id]! : [];
    try {
      patchAiRequestHeaders(Object.fromEntries(oldNames.map((name) => [name, ""])), parsed.data);
    } catch {
      return {
        keepHeaderProfileIds: [],
        patches: [],
        error: "requestHeaders: At most 32 extra headers are allowed after applying the patch.",
      };
    }
    patches.push({ profileId: profile.id, patch: parsed.data });
  }
  return { keepHeaderProfileIds, patches };
};

const zodHeaderMessage = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
  issues.map((issue) => `${issue.path.map(String).join(".") || "headers"}: ${issue.message}`).join("; ");

/** Apply after pruning so a provider change cannot inherit old secrets. Call inside the settings transaction. */
export const storeAiRequestHeaderPlan = async (
  plan: ReturnType<typeof planAiProfileRequestHeaders>,
  db: SqlClient = sql,
): Promise<void> => {
  if (plan.error) throw new Error(plan.error);
  await pruneAiRequestHeaders(plan.keepHeaderProfileIds, db);
  for (const { profileId, patch } of plan.patches)
    await setAiRequestHeaders(profileId, patchAiRequestHeaders(await getAiRequestHeaders(profileId, db), patch), db);
};
