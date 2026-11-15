import type { SQL } from "bun";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { getFreeIpaAdminGroups } from "../freeipa-config";
import { toPgTextArray } from "../postgres";

/** Active human administrators, resolved from the same local/IPA policy as deciding. Never exposed to ordinary users. */
export const listApprovalAdminRecipients = async (
  db: SQL,
  page: { after?: string; userId?: string; limit?: number } = {},
): Promise<string[]> => {
  const local = await isAccountCategoryAllowed({ provider: "local", profile: "user" }, db);
  const ipa = await isAccountCategoryAllowed({ provider: "ipa", profile: "user" }, db);
  const groups = await getFreeIpaAdminGroups(db);
  const rows = await db<{ id: string }[]>`SELECT u.id
    FROM auth.users u WHERE u.profile='user' AND (${page.after ?? null}::uuid IS NULL OR u.id>${page.after ?? null}::uuid)
      AND (${page.userId ?? null}::uuid IS NULL OR u.id=${page.userId ?? null}::uuid)
      AND (u.account_expires IS NULL OR u.account_expires > statement_timestamp())
      AND ((u.provider='local' AND ${local} AND u.admin)
        OR (u.provider='ipa' AND ${ipa} AND EXISTS (SELECT 1 FROM auth.ipa_user_effective_groups eg
          WHERE eg.user_id=u.id AND eg.group_name=ANY(${toPgTextArray(groups)}::text[]))))
      ORDER BY u.id LIMIT ${Math.max(1, Math.min(page.limit ?? 50, 50))}`;
  return rows.map((row) => row.id);
};
/** Current active human admin, only when there is exactly one. Machines never enter this population. */
export const soleCodeAdmin = async (db: SQL): Promise<string | null> => {
  const ids = await listApprovalAdminRecipients(db, { limit: 2 });
  return ids.length === 1 ? ids[0]! : null;
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
