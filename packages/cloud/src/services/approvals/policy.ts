import type { SQL } from "bun";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { getFreeIpaAdminGroups } from "../freeipa-config";
import { toPgTextArray } from "../postgres";

/** Current active human admin, only when there is exactly one. Machines never enter this population. */
export const soleCodeAdmin = async (db: SQL): Promise<string | null> => {
  const local = await isAccountCategoryAllowed({ provider: "local", profile: "user" }, db);
  const ipa = await isAccountCategoryAllowed({ provider: "ipa", profile: "user" }, db);
  const groups = await getFreeIpaAdminGroups(db);
  const [row] = await db<{ id: string | null }[]>`SELECT CASE WHEN count(*)=1 THEN min(u.id::text) END AS id
    FROM auth.users u WHERE u.profile='user'
      AND (u.account_expires IS NULL OR u.account_expires > statement_timestamp())
      AND ((u.provider='local' AND ${local} AND u.admin)
        OR (u.provider='ipa' AND ${ipa} AND EXISTS (SELECT 1 FROM auth.ipa_user_effective_groups eg
          WHERE eg.user_id=u.id AND eg.group_name=ANY(${toPgTextArray(groups)}::text[]))))`;
  return row?.id ?? null;
};

/**
 * Retain the sole-admin population through the decision. An in-flight account, category or IPA writer wins:
 * fail closed instead of waiting or approving against its previous state. The savepoint keeps a denied decision usable.
 * Self-approvals serialize here as well, preventing handler lock upgrades from deadlocking each other.
 * Repeatable-read/serializable callers can retain a pre-lock population snapshot, so self-approval requires READ COMMITTED.
 */
export const lockCodeAdminPopulation = async (tx: SQL, userId: string): Promise<"locked" | "busy" | "unsupported_isolation"> => {
  const [isolation] = await tx<{ level: string }[]>`SELECT current_setting('transaction_isolation') AS level`;
  if (isolation?.level !== "read committed") return "unsupported_isolation";
  await tx`SAVEPOINT approval_admin_population`;
  try {
    await tx`LOCK TABLE auth.users, settings.entries, auth.ipa_user_effective_groups IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
    await tx`SELECT id FROM auth.users WHERE id=${userId}::uuid FOR SHARE NOWAIT`;
    return "locked";
  } catch (error) {
    await tx`ROLLBACK TO SAVEPOINT approval_admin_population`;
    if (error && typeof error === "object" && "errno" in error && error.errno === "55P03") return "busy";
    throw error;
  } finally {
    await tx`RELEASE SAVEPOINT approval_admin_population`;
  }
};
