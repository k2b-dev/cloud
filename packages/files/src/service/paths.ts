import { sql } from "bun";
import { get } from "@k2b/cloud/services";
import type { FileBase, MutationResult } from "@/contracts";
import path from "node:path";

type DbRow = Record<string, unknown>;

/**
 * Resolve a FileBase to the absolute path on the file server.
 * Reads `files.base_homes` / `files.base_groups` from settings via the
 * Redis cache-aside layer (always within Redis-TTL fresh).
 */
export const resolveBase = async (base: FileBase): Promise<string> => {
  if (base.type === "home") {
    return path.join(await get<string>("files.base_homes"), base.uid);
  }
  return path.join(await get<string>("files.base_groups"), base.name);
};

/**
 * Validate and resolve a relative path within a base directory.
 * Returns the full path on the file server or an error if path traversal is detected.
 *
 * Containment is checked via `path.relative` (NOT `startsWith`): a naive
 * `fullPath.startsWith(basePath)` matches any sibling base whose name shares
 * the prefix — e.g. `/data/homes/alice` would consider `/data/homes/alice2`
 * "inside". `path.relative` from the resolved base must produce a result
 * that doesn't start with `..` (and isn't an absolute path) to be considered
 * contained.
 */
export const resolvePath = async (
  base: FileBase,
  relativePath: string,
): Promise<MutationResult<{ fullPath: string; relativePath: string }>> => {
  const basePath = path.resolve(await resolveBase(base));

  // Normalize the path and remove leading slashes
  const normalized = path.normalize(relativePath).replace(/^\/+/, "");
  const fullPath = path.resolve(basePath, normalized);

  // Containment check: rel must be empty, ".", or a forward path (no "..").
  const rel = path.relative(basePath, fullPath);
  const isContained = rel === "" || rel === "." || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!isContained) {
    return {
      ok: false,
      error: "Invalid path: traversal not allowed",
      status: 400,
    };
  }

  return {
    ok: true,
    data: {
      fullPath,
      relativePath: normalized || "/",
    },
  };
};

/**
 * Parse route parameters into a FileBase with numeric IDs for ownership.
 * Fetches uidNumber/gidNumber from the database.
 */
export const parseBase = async (baseType: string, baseId: string): Promise<MutationResult<FileBase>> => {
  if (baseType === "home") {
    // Fetch user's uidNumber
    const rows: DbRow[] = await sql`
      SELECT d.uid_number
      FROM auth.users u
      LEFT JOIN auth.user_ipa_data d ON d.user_id = u.id
      WHERE u.uid = ${baseId}
    `;

    if (rows.length === 0) {
      return { ok: false, error: "User not found", status: 404 };
    }

    const uidNumber = rows[0]!.uid_number as number | null;
    // For home dirs, use user's uidNumber as both uid and gid
    // This matches the nfsctl pattern: chown user:user (user's personal group)

    return {
      ok: true,
      data: {
        type: "home",
        uid: baseId,
        uidNumber: uidNumber ?? undefined,
        gidNumber: uidNumber ?? undefined, // Same as UID for home directories
      },
    };
  }

  if (baseType === "group") {
    // Resolve by cn — it is globally unique, unlike `name`, which is only
    // unique per provider. The group's id travels with the base so that
    // access checks compare identities rather than labels.
    const rows: DbRow[] = await sql`
      SELECT id, cn, gid_number FROM auth.groups WHERE cn = ${baseId}
    `;

    if (rows.length === 0) {
      return { ok: false, error: "Group not found", status: 404 };
    }

    const gidNumber = rows[0]!.gid_number as number | null;

    return {
      ok: true,
      data: {
        type: "group",
        groupId: rows[0]!.id as string,
        name: rows[0]!.cn as string,
        gidNumber: gidNumber ?? undefined,
      },
    };
  }

  return {
    ok: false,
    error: "Invalid base type: must be 'home' or 'group'",
    status: 400,
  };
};
