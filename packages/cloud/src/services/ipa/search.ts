import { sql } from "bun";
import type { BaseGroup, BaseUser, UserProfile, UserProvider } from "../../contracts/shared";
import { freeipa } from "../../server/services";
import { buildRoles } from "../account-model";
import { getFreeIpaConfig } from "../freeipa-config";
import { toPgTextArray, toPgUuidArray } from "../postgres";

// ==========================
// Search Options
// ==========================

export type SearchOptions = {
  /** Search users */
  users?: boolean;
  /** Search groups */
  groups?: boolean;
  /** User UUIDs to exclude from results */
  excludeUserIds?: string[];
  /** Group IDs to exclude from results */
  excludeGroups?: string[];
  /** Only return groups the user is a member of */
  onlyUserGroups?: string[];
  /** Only return POSIX groups (have gid_number) */
  onlyPosixGroups?: boolean;
  /** Only return users that are members of these groups */
  usersInGroups?: string[];
};

// ==========================
// Search (autocomplete for member/manager add dialogs)
// Returns BaseUser/BaseGroup (no relations needed for autocomplete)
// ==========================

/**
 * Executes a filtered lookup query and returns normalized matches.
 */
export const search = async (query: string, options: SearchOptions): Promise<{ users: BaseUser[]; groups: BaseGroup[] }> => {
  const q = `%${freeipa.util.escapeLike(query.toLowerCase())}%`;
  let users: BaseUser[] = [];
  let groups: BaseGroup[] = [];

  // ========== Search Users ==========
  if (options.users) {
    const excludeIds = options.excludeUserIds ?? [];
    const inGroups = options.usersInGroups ?? [];
    const groupsAdmin = (await getFreeIpaConfig()).groupsAdmin;

    // Build optional WHERE fragments
    const excludeFilter = excludeIds.length > 0 ? sql`AND u.id <> ALL(${toPgUuidArray(excludeIds)}::uuid[])` : sql``;
    const groupFilter =
      inGroups.length > 0
        ? sql`AND EXISTS (
            SELECT 1
            FROM auth.user_groups_v2 ug
            JOIN auth.groups g ON g.id = ug.group_id
            WHERE ug.user_id = u.id
              AND g.provider = 'ipa'
              AND ug.group_id = ANY(${toPgUuidArray(inGroups)}::uuid[])
          )`
        : sql``;

    const rows = await sql`
      SELECT u.id, u.uid, u.provider, u.profile, u.given_name, u.sn, u.display_name, u.mail, u.avatar_hash,
        EXISTS(
          SELECT 1
          FROM auth.ipa_user_effective_groups eg
          WHERE eg.user_id = u.id
            AND eg.group_name = ANY(${toPgTextArray(groupsAdmin)}::text[])
        ) AS effective_admin
      FROM auth.users u
      WHERE u.provider = 'ipa'
        AND (
          LOWER(u.uid) LIKE ${q} ESCAPE '\\' OR LOWER(u.display_name) LIKE ${q} ESCAPE '\\' OR
          LOWER(u.given_name) LIKE ${q} ESCAPE '\\' OR LOWER(u.sn) LIKE ${q} ESCAPE '\\' OR LOWER(u.mail) LIKE ${q} ESCAPE '\\'
        )
        ${excludeFilter}
        ${groupFilter}
      ORDER BY u.uid
      LIMIT 10
    `;

    type UserRow = {
      id: string;
      uid: string;
      provider: UserProvider;
      profile: UserProfile;
      effective_admin: boolean | null;
      given_name: string | null;
      sn: string | null;
      display_name: string | null;
      mail: string | null;
      avatar_hash: string | null;
    };
    users = (rows as UserRow[]).map((row) => ({
      id: row.id,
      uid: row.uid,
      roles: buildRoles({
        provider: row.provider,
        profile: row.profile,
        memberofGroup: [],
        manages: [],
        admin: Boolean(row.effective_admin),
      }),
      provider: row.provider,
      profile: row.profile,
      givenname: row.given_name ?? "",
      sn: row.sn ?? "",
      displayName: row.display_name ?? "",
      mail: row.mail ?? null,
      avatarHash: row.avatar_hash,
    }));
  }

  // ========== Search Groups ==========
  if (options.groups) {
    const excludeIds = options.excludeGroups ?? [];
    const onlyUserGroups = options.onlyUserGroups ?? [];
    const onlyPosix = options.onlyPosixGroups ?? false;

    // Build optional WHERE fragments
    const excludeFilter = excludeIds.length > 0 ? sql`AND id <> ALL(${toPgUuidArray(excludeIds)}::uuid[])` : sql``;
    const userGroupsFilter = onlyUserGroups.length > 0 ? sql`AND id = ANY(${toPgUuidArray(onlyUserGroups)}::uuid[])` : sql``;
    const posixFilter = onlyPosix ? sql`AND gid_number IS NOT NULL` : sql``;

    const rows = await sql`
      SELECT id, provider, name, description, gid_number
      FROM auth.groups
      WHERE provider = 'ipa'
        AND (LOWER(name) LIKE ${q} ESCAPE '\\' OR LOWER(description) LIKE ${q} ESCAPE '\\')
        ${excludeFilter}
        ${userGroupsFilter}
        ${posixFilter}
      ORDER BY name
      LIMIT 10
    `;

    type GroupRow = {
      id: string;
      provider: UserProvider;
      name: string;
      description: string | null;
      gid_number: number | null;
    };
    groups = (rows as GroupRow[]).map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      description: row.description ?? null,
      gidnumber: row.gid_number ?? null,
      personalOwner: null,
    }));
  }

  return { users, groups };
};
