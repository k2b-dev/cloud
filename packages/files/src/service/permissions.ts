import { sql } from "bun";
import { toPgTextArray } from "@k2b/cloud/services";
import { getEffectiveGroupIds } from "@k2b/cloud/server";
import type { User, FileBase, FileBaseInfo, MutationResult } from "@/contracts";

type DbRow = Record<string, unknown>;

/**
 * Check if a user can access a file base (home directory or group directory).
 *
 * Group membership is compared by id, never by label. `auth.groups.name` is
 * only unique per provider, so a local group may carry the same name as an
 * FreeIPA one — matching on it would let a member of the local group reach
 * the FreeIPA group's share. `getEffectiveGroupIds` resolves direct and
 * nested memberships from the authoritative mirror.
 */
export const canAccess = async (user: User, base: FileBase): Promise<MutationResult<void>> => {
  if (base.type === "home") {
    if (base.uid !== user.uid) {
      return {
        ok: false,
        error: "Access denied: not your home directory",
        status: 403,
      };
    }
    return { ok: true, data: undefined };
  }

  const groupIds = await getEffectiveGroupIds({ userId: user.id });
  if (!groupIds.includes(base.groupId)) {
    return {
      ok: false,
      error: "Access denied: not a member of this group",
      status: 403,
    };
  }
  return { ok: true, data: undefined };
};

/**
 * List all file bases accessible to a user (with numeric IDs for ownership).
 * Includes bases from indirect group memberships (group hierarchy).
 */
export const listBases = async (user: User): Promise<FileBase[]> => {
  const bases: FileBase[] = [];
  const uidNumber = user.ipa?.uidNumber ?? null;

  bases.push({
    type: "home",
    uid: user.uid,
    uidNumber: uidNumber ?? undefined,
    gidNumber: uidNumber ?? undefined, // Home dirs: user's uid as gid
  });

  // Get all groups (direct + indirect) and their gidNumbers
  const groupIds = await getEffectiveGroupIds({ userId: user.id });
  if (groupIds.length > 0) {
    const groupRows: DbRow[] = await sql`
      SELECT id, cn, gid_number FROM auth.groups
      WHERE id = ANY(${toPgTextArray(groupIds)}::uuid[])
      AND gid_number IS NOT NULL
    `;

    for (const row of groupRows) {
      bases.push({
        type: "group",
        groupId: row.id as string,
        name: row.cn as string,
        gidNumber: row.gid_number as number,
      });
    }
  }

  return bases;
};

/**
 * Convert FileBase to FileBaseInfo for API response
 */
export const toBaseInfo = (base: FileBase): FileBaseInfo => {
  if (base.type === "home") {
    return {
      type: "home",
      id: base.uid,
      name: "Home",
    };
  }
  return {
    type: "group",
    id: base.name,
    name: base.name,
  };
};
