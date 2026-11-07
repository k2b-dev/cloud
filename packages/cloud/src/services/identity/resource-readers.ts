import { z } from "zod";
import { type ResourcePrincipal, ResourcePrincipalSchema } from "../../contracts/capabilities";
import type { AccessSubject } from "../../contracts/shared";
import { sql } from "../../runtime/clients";
import { decodeAccountCategoryEnabled } from "../account-category-policy";
import { toPgUuidArray } from "../postgres";
import type { ServiceAccount } from "../service-accounts";

/** Account authority only: no session, credential scopes, or content authority. */
export type ResourceReader = {
  principal: ResourcePrincipal;
  subject: AccessSubject;
  binding: Pick<ServiceAccount, "appId" | "resourceType" | "resourceId"> | null;
};

type UserRow = { id: string; category_enabled: string | null };
type AccountRow = {
  id: string;
  kind: ServiceAccount["kind"];
  delegated_user_id: string | null;
  app_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
};

/** Resolve at most 500 current accounts, including delegated users and account-category policy.
 * Grants and resource bindings remain the resource provider's responsibility.
 */
export const resolveResourceReaders = async (principals: readonly ResourcePrincipal[]): Promise<ResourceReader[]> => {
  const input = z.array(ResourcePrincipalSchema).max(500).parse(principals);
  if (!input.length) return [];
  const userIds = input.flatMap((principal) => (principal.type === "user" ? [principal.userId] : []));
  const accountIds = input.flatMap((principal) => (principal.type === "service_account" ? [principal.serviceAccountId] : []));
  const accounts = await sql<AccountRow[]>`
    SELECT id, kind, delegated_user_id, app_id, resource_type, resource_id
    FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(accountIds)}::uuid[]) AND status = 'active'
  `;
  const users = await sql<UserRow[]>`
    SELECT u.id, category.value AS category_enabled FROM auth.users u
    LEFT JOIN settings.entries category ON category.key = 'user.category.' ||
      CASE WHEN u.provider = 'ipa' THEN 'freeipa' WHEN u.profile = 'guest' THEN 'guest' ELSE 'login' END || '.enabled'
    WHERE u.id = ANY(${toPgUuidArray([...userIds, ...accounts.flatMap((account) => (account.delegated_user_id ? [account.delegated_user_id] : []))])}::uuid[])
      AND (u.account_expires IS NULL OR u.account_expires > clock_timestamp())
  `;
  const enabled = new Map<string | null, boolean>();
  const allowedUsers = new Set<string>();
  for (const user of users) {
    if (!enabled.has(user.category_enabled)) enabled.set(user.category_enabled, await decodeAccountCategoryEnabled(user.category_enabled));
    if (enabled.get(user.category_enabled)) allowedUsers.add(user.id);
  }
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  return input.flatMap((principal): ResourceReader[] => {
    if (principal.type === "user") {
      const userId = principal.userId.toLowerCase();
      return allowedUsers.has(userId) ? [{ principal, subject: { type: "user", userId }, binding: null }] : [];
    }
    const account = accountsById.get(principal.serviceAccountId.toLowerCase());
    if (!account) return [];
    if (account.kind === "user_delegated")
      return account.delegated_user_id && allowedUsers.has(account.delegated_user_id)
        ? [
            {
              principal,
              subject: { type: "user", userId: account.delegated_user_id, delegatedByServiceAccountId: account.id },
              binding: null,
            },
          ]
        : [];
    return [
      {
        principal,
        subject: { type: "service_account", serviceAccountId: account.id },
        binding:
          account.kind === "resource_bound"
            ? { appId: account.app_id, resourceType: account.resource_type, resourceId: account.resource_id }
            : null,
      },
    ];
  });
};
