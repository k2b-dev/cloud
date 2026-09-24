import { sql } from "bun";
import type { BaseGroup, UserProvider } from "../../contracts/shared";

type DbRow = Record<string, unknown>;

/**
 * Joins the owner of a personal Linux group (the group stored as a user's
 * `auth.user_posix.primary_group_id`) onto `auth.groups g` as
 * `personal_owner_id`, `personal_owner_uid`, and `personal_owner_display_name`.
 */
export const personalOwnerJoin = sql`
  LEFT JOIN LATERAL (
    SELECT
      owner.id AS personal_owner_id,
      owner.uid AS personal_owner_uid,
      COALESCE(NULLIF(owner.display_name, ''), NULLIF(owner.mail, ''), owner.uid) AS personal_owner_display_name
    FROM auth.user_posix owner_posix
    JOIN auth.users owner ON owner.id = owner_posix.user_id
    WHERE owner_posix.primary_group_id = g.id
    ORDER BY owner.id
    LIMIT 1
  ) personal_owner ON TRUE
`;

export const buildBaseGroup = (row: DbRow): BaseGroup => ({
  id: row.id as string,
  provider: row.provider as UserProvider,
  name: row.name as string,
  description: (row.description as string | null | undefined) ?? null,
  gidnumber: (row.gid_number as number | null | undefined) ?? null,
  personalOwner:
    typeof row.personal_owner_id === "string"
      ? {
          id: row.personal_owner_id,
          uid: String(row.personal_owner_uid),
          displayName: String(row.personal_owner_display_name),
        }
      : null,
});
