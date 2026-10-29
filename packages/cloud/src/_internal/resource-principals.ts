import { sql } from "bun";
import type { ResourcePrincipal } from "../contracts/capabilities";
import { decodeAccountCategoryEnabled } from "../services/account-category-policy";
import { toPgTextArray } from "../services/postgres";

/** One bounded identity lookup before any provider-owned readability check. */
export const activeResourcePrincipals = async (principals: ResourcePrincipal[]): Promise<ResourcePrincipal[]> => {
  if (!principals.length) return [];
  const users = principals.flatMap((principal) => (principal.type === "user" ? [principal.userId] : []));
  const accounts = principals.flatMap((principal) => (principal.type === "service_account" ? [principal.serviceAccountId] : []));
  const rows = await sql<{ type: ResourcePrincipal["type"]; id: string; category_enabled: string | null }[]>`
    SELECT 'user' AS type, u.id, category.value AS category_enabled
    FROM auth.users u
    LEFT JOIN settings.entries category ON category.key = 'user.category.' ||
      CASE WHEN u.provider = 'ipa' THEN 'freeipa' WHEN u.profile = 'guest' THEN 'guest' ELSE 'login' END || '.enabled'
    WHERE u.id = ANY(${toPgTextArray(users)}::uuid[])
      AND (u.account_expires IS NULL OR u.account_expires > clock_timestamp())
    UNION ALL
    SELECT 'service_account', sa.id, category.value
    FROM auth.service_accounts sa
    LEFT JOIN auth.users du ON du.id = sa.delegated_user_id
    LEFT JOIN settings.entries category ON sa.kind = 'user_delegated' AND category.key = 'user.category.' ||
      CASE WHEN du.provider = 'ipa' THEN 'freeipa' WHEN du.profile = 'guest' THEN 'guest' ELSE 'login' END || '.enabled'
    WHERE sa.id = ANY(${toPgTextArray(accounts)}::uuid[]) AND sa.status = 'active'
      AND (sa.kind <> 'user_delegated' OR (du.id IS NOT NULL AND (du.account_expires IS NULL OR du.account_expires > clock_timestamp())))
  `;
  const enabled = new Map<string | null, boolean>();
  const active = new Set<string>();
  for (const row of rows) {
    if (!enabled.has(row.category_enabled)) enabled.set(row.category_enabled, await decodeAccountCategoryEnabled(row.category_enabled));
    if (enabled.get(row.category_enabled)) active.add(`${row.type}:${row.id}`);
  }
  return principals.filter((principal) =>
    active.has(`${principal.type}:${(principal.type === "user" ? principal.userId : principal.serviceAccountId).toLowerCase()}`),
  );
};
