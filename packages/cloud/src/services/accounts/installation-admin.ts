import type { RequestActor, UserProfile, UserProvider } from "../../contracts/shared";
import type { sql } from "../../runtime/clients";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { getFreeIpaAdminGroups } from "../freeipa-config";
import { toPgTextArray } from "../postgres";

/**
 * Revalidate installation authority and retain it until the caller commits.
 * Lock users before grant/membership or mandate/profile locks, matching user
 * deletion and provider sync. Projection and settings locks also cover rows
 * inserted or replaced while lock acquisition was waiting.
 */
export const hasInstallationAdminInTransaction = async (actor: RequestActor, db: typeof sql): Promise<boolean> => {
  if (actor.kind !== "user" || actor.sessionKind === "app" || !actor.user.roles.includes("admin")) return false;
  const [user] = await db<{ provider: UserProvider; profile: UserProfile; expired: boolean }[]>`
    SELECT provider, profile, (account_expires IS NOT NULL AND account_expires <= statement_timestamp()) AS expired
    FROM auth.users WHERE id=${actor.user.id}::uuid FOR SHARE`;
  if (!user || user.expired || user.profile !== "user") return false;
  await db`LOCK TABLE settings.entries IN SHARE MODE`;
  if (!(await isAccountCategoryAllowed(user, db))) return false;
  if (user.provider === "ipa") {
    await db`LOCK TABLE auth.ipa_user_effective_groups IN SHARE MODE`;
  }
  const groupsAdmin = await getFreeIpaAdminGroups(db);
  const [row] = await db<{ effective_admin: boolean }[]>`
    SELECT CASE WHEN u.provider = 'local' THEN u.admin ELSE EXISTS (
      SELECT 1 FROM auth.ipa_user_effective_groups eg WHERE eg.user_id = u.id
        AND eg.group_name = ANY(${toPgTextArray(groupsAdmin)}::text[])
    ) END AS effective_admin
    FROM auth.users u WHERE u.id = ${actor.user.id}::uuid`;
  // The locked row is an active full user; only the admin role is needed here.
  return Boolean(row?.effective_admin);
};
