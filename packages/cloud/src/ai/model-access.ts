import { sql } from "bun";
import { z } from "zod";
import { type AccessEntry, type Principal, PrincipalSchema } from "../contracts/shared";
import { type AccessSubject, buildAccessPrincipalCondition, createAccess } from "../server/services/access";
import { toPgTextArray } from "../services/postgres";
import type { AiSettingsError } from "./types";

export type AiModelAccessState = { entries: AccessEntry[]; revision: number };
export type AiModelAccessMap = Record<string, AiModelAccessState>;

const GrantSchema = z
  .object({
    principal: PrincipalSchema.refine((principal) => principal.type !== "public", "Assistant models cannot be public."),
    permission: z.literal("read"),
  })
  .strict();
export const AiModelAccessDraftSchema = z
  .object({
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    sourceProfileId: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
    entries: z.array(GrantSchema),
  })
  .strict();
export type AiModelAccessDraft = z.infer<typeof AiModelAccessDraftSchema>;
export type AiModelAccessChange = AiModelAccessDraft & { profileId: string };

/** Transport-only draft fields never enter the provider setting. */
export const splitAiModelAccess = (profilesJson: string): { profilesJson: string; changes: AiModelAccessChange[] } => {
  const profiles = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(profilesJson));
  const changes: AiModelAccessChange[] = [];
  const stored = profiles.map(({ assistantAccess, ...profile }) => {
    if (assistantAccess !== undefined) {
      const profileId = z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9._-]*$/)
        .parse(profile.id);
      changes.push({ profileId, ...AiModelAccessDraftSchema.parse(assistantAccess) });
    }
    return profile;
  });
  return { profilesJson: JSON.stringify(stored), changes };
};

export class AiModelAccessConflict extends Error {
  constructor() {
    super("Model permissions changed. Reload the settings before saving again.");
  }
}

export class AiModelAccessInvalid extends Error {}

const principalKey = (principal: Principal): string => {
  if (principal.type === "user") return `user:${principal.userId}`;
  if (principal.type === "group") return `group:${principal.groupId}`;
  if (principal.type === "service_account") return `service_account:${principal.serviceAccountId}`;
  return principal.type;
};

const grant = async (profileId: string, principal: Principal, db: typeof sql): Promise<void> => {
  const result = await createAccess({ principal, permission: "read" }, db);
  if (!result.ok) throw new AiModelAccessInvalid(result.error.message);
  await db`INSERT INTO ai.model_access (profile_id, access_id) VALUES (${profileId}, ${result.data.id}::uuid)`;
};

const allowedProfileIds = async (profileIds: string[], subject: AccessSubject | null): Promise<Set<string>> => {
  if (!subject || profileIds.length === 0) return new Set();
  const match = buildAccessPrincipalCondition({
    subject,
    columns: {
      userId: sql`access.user_id`,
      groupId: sql`access.group_id`,
      serviceAccountId: sql`access.service_account_id`,
      authenticatedOnly: sql`access.authenticated_only`,
    },
  });
  const rows = await sql<{ profile_id: string }[]>`
    SELECT DISTINCT model.profile_id FROM ai.model_access model JOIN auth.access access ON access.id = model.access_id
    WHERE model.profile_id = ANY(${toPgTextArray(profileIds)}::text[])
      AND access.permission IN ('read', 'write', 'admin') AND ${match}
  `;
  return new Set(rows.map((row) => row.profile_id));
};

/** Assistant chat authorization only. Global/background model resolution does not call this service. */
export const aiModelAccess = {
  filterModels: async <T extends { id: string }>(models: T[], subject: AccessSubject | null): Promise<T[]> => {
    const allowed = await allowedProfileIds(
      models.map((model) => model.id),
      subject,
    );
    return models.filter((model) => allowed.has(model.id));
  },
  assertAllowed: async (profileId: string, subject: AccessSubject | null): Promise<void> => {
    if ((await allowedProfileIds([profileId], subject)).has(profileId)) return;
    const message = "You do not have permission to use this model in Assistant. Choose another model.";
    throw Object.assign(new Error(message), {
      aiError: { code: "model_access_denied", message, fields: { modelProfileId: message } } satisfies AiSettingsError,
    });
  },
  listForAdmin: async (): Promise<AiModelAccessMap> => {
    const rows = await sql<
      {
        profile_id: string;
        revision: number | string;
        id: string | null;
        created_at: Date | null;
        user_id: string | null;
        group_id: string | null;
        service_account_id: string | null;
        authenticated_only: boolean | null;
        display_name: string | null;
      }[]
    >`
      SELECT resource.profile_id, resource.revision, access.id, access.created_at,
        access.user_id, access.group_id, access.service_account_id, access.authenticated_only,
        COALESCE(users.display_name, groups.name, service_accounts.name) AS display_name
      FROM ai.model_access_resources resource LEFT JOIN ai.model_access model ON model.profile_id = resource.profile_id
      LEFT JOIN auth.access access ON access.id = model.access_id
      LEFT JOIN auth.users users ON users.id = access.user_id
      LEFT JOIN auth.groups groups ON groups.id = access.group_id
      LEFT JOIN auth.service_accounts service_accounts ON service_accounts.id = access.service_account_id
      ORDER BY resource.profile_id, access.created_at, access.id
    `;
    const result = new Map<string, AiModelAccessState>();
    for (const row of rows) {
      const state = result.get(row.profile_id) ?? { entries: [], revision: Number(row.revision) };
      result.set(row.profile_id, state);
      if (!row.id || !row.created_at) continue;
      const principal: Principal = row.user_id
        ? { type: "user", userId: row.user_id }
        : row.group_id
          ? { type: "group", groupId: row.group_id }
          : row.service_account_id
            ? { type: "service_account", serviceAccountId: row.service_account_id }
            : row.authenticated_only
              ? { type: "authenticated" }
              : { type: "public" };
      state.entries.push({
        id: row.id,
        principal,
        permission: "read",
        createdAt: row.created_at.toISOString(),
        ...(row.display_name ? { displayName: row.display_name } : {}),
      });
    }
    return Object.fromEntries(result);
  },

  /** Called in the settings transaction. Existing grants survive edits that omit the ACL draft. */
  syncProfiles: async (profileIds: readonly string[], changes: readonly AiModelAccessChange[], db: typeof sql): Promise<void> => {
    // Serialize lifecycle changes (including a previously absent profile) with saves and migration seeding.
    await db`LOCK TABLE ai.model_access_resources IN SHARE ROW EXCLUSIVE MODE`;
    const current = await db<
      { profile_id: string; revision: number | string }[]
    >`SELECT profile_id, revision FROM ai.model_access_resources`;
    const revisions = new Map(current.map((row) => [row.profile_id, Number(row.revision)]));
    const keep = new Set(profileIds);
    for (const change of changes) {
      if (!keep.has(change.profileId)) throw new Error("Permissions reference an unknown model profile.");
      const sourceId = change.sourceProfileId ?? change.profileId;
      if ((revisions.get(sourceId) ?? null) !== change.expectedRevision) throw new AiModelAccessConflict();
      if (change.sourceProfileId && change.sourceProfileId !== change.profileId && revisions.has(change.profileId)) {
        throw new AiModelAccessConflict();
      }
    }
    for (const profileId of keep) {
      if (revisions.has(profileId)) continue;
      await db`INSERT INTO ai.model_access_resources (profile_id) VALUES (${profileId})`;
      await grant(profileId, { type: "authenticated" }, db);
    }
    for (const change of changes) {
      await db`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM ai.model_access WHERE profile_id = ${change.profileId})`;
      const seen = new Set<string>();
      for (const entry of change.entries) {
        const key = principalKey(entry.principal);
        if (seen.has(key)) continue;
        seen.add(key);
        await grant(change.profileId, entry.principal, db);
      }
      await db`UPDATE ai.model_access_resources SET revision = nextval('ai.model_access_revision') WHERE profile_id = ${change.profileId}`;
    }
    const ids = toPgTextArray([...keep]);
    await db`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM ai.model_access WHERE profile_id <> ALL(${ids}::text[]))`;
    await db`DELETE FROM ai.model_access_resources WHERE profile_id <> ALL(${ids}::text[])`;
  },
};
