import type { SQL } from "bun";
import { sql } from "../../runtime/clients";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { accountLockedSql } from "../account-lock";
import { emergencyIdentitySql } from "../accounts/identity";
import { getFreeIpaAdminGroups } from "../freeipa-config";
import { toPgTextArray } from "../postgres";

/** Active admin recipients/readers, including the emergency identity unless selecting independent reviewers. Never exposed to ordinary users. */
export const listApprovalAdminRecipients = async (
  db: SQL,
  page: { after?: string; userId?: string; excludeUserId?: string; limit?: number; independentReviewer?: boolean } = {},
): Promise<string[]> => {
  const local = await isAccountCategoryAllowed({ provider: "local", profile: "user" }, db);
  const ipa = await isAccountCategoryAllowed({ provider: "ipa", profile: "user" }, db);
  const groups = await getFreeIpaAdminGroups(db);
  const rows = await db<{ id: string }[]>`SELECT u.id
    FROM auth.users u WHERE u.profile='user' AND (${page.after ?? null}::uuid IS NULL OR u.id>${page.after ?? null}::uuid)
      AND (NOT ${page.independentReviewer ?? false} OR NOT ${emergencyIdentitySql("u")})
      AND NOT ${accountLockedSql(sql`u.id`)}
      AND (${page.excludeUserId ?? null}::uuid IS NULL OR u.id<>${page.excludeUserId ?? null}::uuid)
      AND (${page.userId ?? null}::uuid IS NULL OR u.id=${page.userId ?? null}::uuid)
      AND (u.account_expires IS NULL OR u.account_expires > statement_timestamp())
      AND ((u.provider='local' AND ${local} AND u.admin)
        OR (u.provider='ipa' AND ${ipa} AND EXISTS (SELECT 1 FROM auth.ipa_user_effective_groups eg
          WHERE eg.user_id=u.id AND eg.group_name=ANY(${toPgTextArray(groups)}::text[]))))
      ORDER BY u.id LIMIT ${Math.max(1, Math.min(page.limit ?? 50, 50))}`;
  return rows.map((row) => row.id);
};
/** The caller's admin authority is checked separately; the emergency identity never counts as another reviewer. */
export const hasOtherApprovalAdmin = async (db: SQL, authorUserId: string): Promise<boolean> =>
  (await listApprovalAdminRecipients(db, { excludeUserId: authorUserId, limit: 1, independentReviewer: true })).length > 0;

/**
 * Retain the sole-admin population through the decision. An in-flight account, category or IPA writer wins:
 * wait briefly for maintenance, then fail closed rather than approve against a writer's previous state.
 * The savepoint keeps a denied decision usable and restores its original timeout on failure.
 * Self-approvals serialize here as well, preventing handler lock upgrades from deadlocking each other.
 * Repeatable-read/serializable callers can retain a pre-lock population snapshot, so self-approval requires READ COMMITTED.
 */
export const lockCodeAdminPopulation = async (tx: SQL, userId: string): Promise<"locked" | "busy" | "unsupported_isolation"> => {
  const [isolation] = await tx<{ level: string; lockTimeout: string }[]>`SELECT
    current_setting('transaction_isolation') AS level, current_setting('lock_timeout') AS "lockTimeout"`;
  if (isolation?.level !== "read committed") return "unsupported_isolation";
  await tx`SAVEPOINT approval_admin_population`;
  try {
    // Above PostgreSQL's default deadlock_timeout (1 s), so it can cancel a blocking autovacuum.
    // Account writers queue behind this request for at most 2 s; retain the locks only through this decision.
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`LOCK TABLE auth.users, settings.entries, auth.ipa_user_effective_groups, auth.user_ipa_data IN SHARE ROW EXCLUSIVE MODE`;
    await tx`SELECT id FROM auth.users WHERE id=${userId}::uuid FOR SHARE`;
    await tx`SELECT set_config('lock_timeout', ${isolation.lockTimeout}, true)`;
    return "locked";
  } catch (error) {
    await tx`ROLLBACK TO SAVEPOINT approval_admin_population`;
    if (error && typeof error === "object" && "errno" in error && (error.errno === "55P03" || error.errno === "57014")) return "busy";
    throw error;
  } finally {
    await tx`RELEASE SAVEPOINT approval_admin_population`;
  }
};
