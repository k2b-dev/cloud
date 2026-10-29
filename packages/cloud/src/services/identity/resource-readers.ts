import { sql } from "bun";
import { z } from "zod";
import { accountCategory } from "../../contracts/account-categories";
import { type ResourcePrincipal, ResourcePrincipalSchema } from "../../contracts/capabilities";
import type { AccessSubject, User } from "../../contracts/shared";
import { readAccountCategoryPolicy } from "../account-category-policy";
import { toPgUuidArray } from "../postgres";
import type { ServiceAccount } from "../service-accounts";

/** Account authority only: no session, credential scopes, or content authority. */
export type ResourceReader = {
  principal: ResourcePrincipal;
  subject: AccessSubject;
  binding: Pick<ServiceAccount, "appId" | "resourceType" | "resourceId"> | null;
};

type UserRow = Pick<User, "id" | "provider" | "profile">;
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
    SELECT id, provider, profile FROM auth.users
    WHERE id = ANY(${toPgUuidArray([...userIds, ...accounts.flatMap((account) => (account.delegated_user_id ? [account.delegated_user_id] : []))])}::uuid[])
      AND (account_expires IS NULL OR account_expires > now())
  `;
  const policy = await readAccountCategoryPolicy();
  const allowedUsers = new Set(users.filter((user) => policy[accountCategory(user)].enabled).map((user) => user.id));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  return input.flatMap((principal): ResourceReader[] => {
    if (principal.type === "user")
      return allowedUsers.has(principal.userId) ? [{ principal, subject: { type: "user", userId: principal.userId }, binding: null }] : [];
    const account = accountsById.get(principal.serviceAccountId);
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
