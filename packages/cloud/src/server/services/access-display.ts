import { sql } from "../../runtime/clients";
import { toPgUuidArray } from "../../services/postgres";
import type { ServiceAccountKind } from "../../services/service-accounts";
import type { Principal } from "./access";
import { type CodeAccountDisplayContext, codeAccountPresenter } from "./code-account-display";

/**
 * Resolve display names for access entries.
 * Missing principals and audiences have no displayName; render with principalLabel.
 * Includes serviceAccountKind for existing service-account principals.
 */
export const resolveDisplayNames = async <
  T extends {
    principal: Principal;
    displayName?: string;
    avatarHash?: string | null;
    serviceAccountKind?: ServiceAccountKind;
    serviceAccountHandle?: string;
    serviceAccountDescription?: string;
    serviceAccountHref?: string;
  },
>(
  entries: T[],
  context: CodeAccountDisplayContext = {},
): Promise<
  (Omit<
    T,
    "displayName" | "avatarHash" | "serviceAccountKind" | "serviceAccountHandle" | "serviceAccountDescription" | "serviceAccountHref"
  > & {
    displayName?: string;
    avatarHash?: string | null;
    serviceAccountKind?: ServiceAccountKind;
    serviceAccountHandle?: string;
    serviceAccountDescription?: string;
    serviceAccountHref?: string;
  })[]
> => {
  const userIds = entries.filter((e) => e.principal.type === "user").map((e) => (e.principal as { type: "user"; userId: string }).userId);

  const groupIds = entries
    .filter((e) => e.principal.type === "group")
    .map((e) => (e.principal as { type: "group"; groupId: string }).groupId);

  const serviceAccountIds = entries
    .filter((e) => e.principal.type === "service_account")
    .map((e) => (e.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId);

  // Fetch user display names
  const userNames = new Map<string, { displayName: string; avatarHash: string | null }>();
  if (userIds.length > 0) {
    const users = await sql<{ id: string; display_name: string; uid: string; avatar_hash: string | null }[]>`
      SELECT id, display_name, uid, avatar_hash
      FROM auth.users
      WHERE id = ANY(${toPgUuidArray(userIds)}::uuid[])
    `;
    for (const u of users) {
      userNames.set(u.id, { displayName: u.display_name || u.uid, avatarHash: u.avatar_hash });
    }
  }

  const groupNames = new Map<string, string>();
  if (groupIds.length > 0) {
    const groups = await sql<{ id: string; name: string }[]>`
      SELECT id, name
      FROM auth.groups
      WHERE id = ANY(${toPgUuidArray(groupIds)}::uuid[])
    `;
    for (const group of groups) {
      groupNames.set(group.id, group.name);
    }
  }

  const serviceAccountsById = new Map<
    string,
    { id: string; name: string; kind: ServiceAccountKind; title: string | null; handle: string | null; status: string }
  >();
  if (serviceAccountIds.length > 0) {
    const serviceAccounts = await sql<
      { id: string; name: string; kind: ServiceAccountKind; title: string | null; handle: string | null; status: string }[]
    >`
      SELECT id, name, kind, title, handle, status
      FROM auth.service_accounts
      WHERE id = ANY(${toPgUuidArray(serviceAccountIds)}::uuid[])
    `;
    for (const serviceAccount of serviceAccounts) {
      serviceAccountsById.set(serviceAccount.id, serviceAccount);
    }
  }

  const presentCode = codeAccountPresenter(context);
  return Promise.all(
    entries.map(async (entry) => {
      const {
        displayName: _name,
        avatarHash: _avatar,
        serviceAccountKind: _kind,
        serviceAccountHandle: _handle,
        serviceAccountHref: _href,
        serviceAccountDescription: _description,
        ...rest
      } = entry;
      let displayName: string | undefined;
      let avatarHash: string | null | undefined;
      let serviceAccountKind: ServiceAccountKind | undefined;
      switch (entry.principal.type) {
        case "user": {
          const user = userNames.get(entry.principal.userId);
          displayName = user?.displayName;
          avatarHash = user?.avatarHash ?? null;
          break;
        }
        case "group":
          displayName = groupNames.get(entry.principal.groupId);
          break;
        case "service_account": {
          const serviceAccount = serviceAccountsById.get(entry.principal.serviceAccountId);
          if (serviceAccount?.kind === "code") {
            // Never preserve caller-supplied owner metadata across a change of viewer authority.
            return {
              ...rest,
              ...(await presentCode(serviceAccount)),
              serviceAccountKind: serviceAccount.kind,
            };
          }
          displayName = serviceAccount?.name;
          serviceAccountKind = serviceAccount?.kind;
          break;
        }
        case "authenticated":
          break;
        case "public":
          break;
      }
      return { ...rest, displayName, avatarHash, serviceAccountKind };
    }),
  );
};
