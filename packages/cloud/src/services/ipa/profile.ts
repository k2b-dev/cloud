import { sql } from "../../runtime/clients";
/**
 * Centralized profile calculation for IPA-backed users.
 *
 * Full sync writes `auth.ipa_user_effective_groups` from FreeIPA group_find.
 * Local group mutations keep that projection as source of truth; the local
 * display mirror is only a bootstrap fallback before the first full sync.
 */

import { calculateIpaProfileFromGroupNames } from "../account-model";
import { getFreeIpaConfig } from "../freeipa-config";

type DbRow = Record<string, unknown>;

/**
 * Get all IPA group names a user belongs to (direct + inherited via parent groups).
 */
export const getAllUserGroups = async (userId: string): Promise<string[]> => {
  const rows: DbRow[] = await sql`
    WITH RECURSIVE all_groups AS (
      SELECT ug.group_id
      FROM auth.user_groups_v2 ug
      JOIN auth.groups g ON g.id = ug.group_id
      WHERE ug.user_id = ${userId} AND g.provider = 'ipa'
      UNION
      SELECT gg.parent_group_id
      FROM auth.group_groups_v2 gg
      JOIN auth.groups g ON g.id = gg.parent_group_id
      JOIN all_groups ag ON gg.child_group_id = ag.group_id
      WHERE g.provider = 'ipa'
    )
    SELECT DISTINCT g.name
    FROM all_groups ag
    JOIN auth.groups g ON g.id = ag.group_id
    ORDER BY g.name
  `;

  return rows.map((row) => row.name as string);
};

export const getEffectiveUserGroups = async (userId: string): Promise<string[]> => {
  const rows: DbRow[] = await sql`
    SELECT group_name
    FROM auth.ipa_user_effective_groups
    WHERE user_id = ${userId}::uuid
    ORDER BY group_name
  `;

  return rows.map((row) => row.group_name as string);
};

/**
 * Calculate canonical IPA profile from effective group names. Reads
 * `freeipa.groups.base_ipa_realm` from settings (cache-aside).
 */
export const calculateIpaProfile = async (memberOfGroups: string[]): Promise<"user" | "guest"> => {
  const config = await getFreeIpaConfig();
  return calculateIpaProfileFromGroupNames(memberOfGroups, config.groupsBaseIpaRealm);
};

/**
 * Calculate canonical IPA profile for a user from the local DB mirror.
 */
export const calculateIpaProfileFromLocalDb = async (userId: string): Promise<"user" | "guest"> => {
  const groups = await getAllUserGroups(userId);
  return calculateIpaProfile(groups);
};

export const calculateIpaProfileFromEffectiveProjection = async (userId: string): Promise<"user" | "guest"> => {
  const groups = await getEffectiveUserGroups(userId);
  return calculateIpaProfile(groups);
};

const rebuildEffectiveProjectionFromLocalMirror = async (userId: string): Promise<string[]> => {
  const groups = await getAllUserGroups(userId);
  await sql`
    DELETE FROM auth.ipa_user_effective_groups
    WHERE user_id = ${userId}::uuid
  `;

  for (const group of groups) {
    await sql`
      INSERT INTO auth.ipa_user_effective_groups (user_id, group_name)
      VALUES (${userId}::uuid, ${group})
      ON CONFLICT DO NOTHING
    `;
  }

  return groups;
};

const getEffectiveUserGroupsWithMirrorFallback = async (userId: string): Promise<string[]> => {
  const projectedGroups = await getEffectiveUserGroups(userId);
  if (projectedGroups.length > 0) return projectedGroups;
  return rebuildEffectiveProjectionFromLocalMirror(userId);
};

/**
 * Update one IPA-backed user's canonical profile projection.
 */
export const updateUserIpaProfile = async (userId: string): Promise<void> => {
  const groups = await getEffectiveUserGroupsWithMirrorFallback(userId);
  const profile = await calculateIpaProfile(groups);
  await sql`
    UPDATE auth.users
    SET provider = 'ipa',
        profile = ${profile}
    WHERE id = ${userId} AND provider = 'ipa'
  `;
};

/**
 * Update all IPA-backed users affected by a group hierarchy change.
 */
export const updateProfileForAffectedUsers = async (groupId: string): Promise<void> => {
  const affectedUsers: DbRow[] = await sql`
    WITH RECURSIVE affected_groups AS (
      SELECT ${groupId}::uuid AS group_id
      UNION
      SELECT gg.child_group_id
      FROM auth.group_groups_v2 gg
      JOIN affected_groups ag ON gg.parent_group_id = ag.group_id
    )
    SELECT DISTINCT ug.user_id
    FROM auth.user_groups_v2 ug
    JOIN affected_groups ag ON ug.group_id = ag.group_id
  `;

  for (const row of affectedUsers) {
    await updateUserIpaProfile(row.user_id as string);
  }
};
