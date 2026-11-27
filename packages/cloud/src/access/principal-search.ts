import type { CloudResourceRef } from "../contracts/capabilities";
import { CODE_ACCOUNT_HANDLE_PATTERN, type Principal, type ServiceAccountKind, type ServiceAccountStatus } from "../contracts/shared";
import { accessMessages } from "./messages";
import type { FoundServiceAccount, PrincipalPickerServiceAccount } from "./PrincipalPicker";
import { principalLabel } from "./principal-label";
import { serviceAccountKindDisplay } from "./service-account-kind";
import { findTargetServiceAccount } from "./service-account-lookup";

type Entity =
  | { kind: "user"; user: { id: string; displayName: string; uid: string; mail: string | null; avatarHash?: string | null } }
  | { kind: "group"; group: { id: string; name: string; description: string | null } }
  | { kind: "service_account"; serviceAccount: PrincipalPickerServiceAccount };

/** One principal a search found, with what its row shows. */
export type PrincipalSearchEntry = {
  principal: Principal;
  label: string;
  /** A v1 icon class, such as `ti ti-user`. */
  icon: string;
  description?: string;
  avatarHash?: string | null;
  serviceAccountKind?: ServiceAccountKind;
  badge?: string;
};

/** What a search offers: the same choices as `PrincipalPicker`. */
export type PrincipalSearchOptions = {
  existing?: Principal[];
  target?: CloudResourceRef;
  allowPublic?: boolean;
  allowAuthenticated?: boolean;
  allowServiceAccounts?: boolean;
  kinds?: readonly ("user" | "group")[];
  serviceAccountKinds?: ServiceAccountKind[];
  serviceAccountStatus?: ServiceAccountStatus;
  serviceAccountFilter?: (account: PrincipalPickerServiceAccount) => boolean;
  signedIn?: { label: string; description: string };
  takenReason?: (principal: Principal) => string | undefined;
  findServiceAccount?: (handle: string, signal: AbortSignal) => Promise<FoundServiceAccount | null>;
};

/**
 * Searches the directory as the viewer may see it (`/api/accounts/entities`, 10 per search), or one exact Code handle
 * against the resource. The audiences come first where offered. Used by `PrincipalPicker` and the v2 access dialog.
 */
export async function searchPrincipals(
  search: string,
  options: PrincipalSearchOptions,
  signal: AbortSignal,
  locale: string,
): Promise<PrincipalSearchEntry[]> {
  const t = accessMessages.resolve([locale]).t;
  const entries: PrincipalSearchEntry[] = [];
  if (options.allowAuthenticated !== false)
    entries.push({
      principal: { type: "authenticated" },
      label: options.signedIn?.label ?? principalLabel({ principal: { type: "authenticated" } }, locale),
      icon: "ti ti-lock-open-2",
      description: options.signedIn?.description,
    });
  if (options.allowPublic)
    entries.push({
      principal: { type: "public" },
      label: principalLabel({ principal: { type: "public" } }, locale),
      icon: "ti ti-world",
    });
  const handle = search.trim();
  const target = options.target;
  // Explicit lookup owns its accepted accounts; directory filters apply to the default lookup only.
  const acceptsCode =
    options.allowServiceAccounts !== false && (!options.serviceAccountKinds?.length || options.serviceAccountKinds.includes("code"));
  const find =
    options.findServiceAccount ??
    (target && acceptsCode ? (value: string, abort: AbortSignal) => findTargetServiceAccount(target, value, abort) : undefined);
  if (find && CODE_ACCOUNT_HANDLE_PATTERN.test(handle)) {
    const found = await find(handle, signal);
    if (found) {
      const kind = found.display.serviceAccountKind ?? "code";
      const display = serviceAccountKindDisplay(kind, t);
      entries.push({
        principal: found.principal,
        label: found.display.displayName,
        icon: `ti ${display.icon}`,
        description: found.description ?? display.label,
        avatarHash: found.display.avatarHash,
        serviceAccountKind: kind,
        badge: t.codeServiceAccount,
      });
    }
  } else if (search.length >= 2) {
    const url = new URL("/api/accounts/entities", window.location.origin);
    url.searchParams.set("search", search);
    const kinds = (options.kinds ?? ["user", "group"]).join(",");
    url.searchParams.set("kinds", options.allowServiceAccounts !== false ? `${kinds},service_account` : kinds);
    if (options.allowServiceAccounts !== false && options.serviceAccountKinds?.length) {
      url.searchParams.set("service_account_kinds", options.serviceAccountKinds.join(","));
    }
    if (options.allowServiceAccounts !== false && options.serviceAccountStatus) {
      url.searchParams.set("service_account_status", options.serviceAccountStatus);
    }
    url.searchParams.set("per_page", "10");
    // With a reason for listed principals, the server must return them too, so they can show greyed.
    const excluded = options.takenReason ? [] : (options.existing ?? []);
    const users = excluded.flatMap((p) => (p.type === "user" ? [p.userId] : []));
    const groups = excluded.flatMap((p) => (p.type === "group" ? [p.groupId] : []));
    const services = excluded.flatMap((p) => (p.type === "service_account" ? [p.serviceAccountId] : []));
    if (users.length) url.searchParams.set("exclude_user_ids", users.join(","));
    if (groups.length) url.searchParams.set("exclude_group_ids", groups.join(","));
    if (services.length) url.searchParams.set("exclude_service_account_ids", services.join(","));
    const response = await fetch(url, { signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(response.statusText);
    const data: { items: Entity[] } = await response.json();
    for (const e of data.items) {
      if (e.kind === "user")
        entries.push({
          principal: { type: "user", userId: e.user.id },
          label: principalLabel({ principal: { type: "user", userId: e.user.id }, displayName: e.user.displayName || e.user.uid }, locale),
          avatarHash: e.user.avatarHash,
          icon: "ti ti-user",
          description: e.user.mail ?? e.user.uid,
        });
      else if (e.kind === "group")
        entries.push({
          principal: { type: "group", groupId: e.group.id },
          label: principalLabel({ principal: { type: "group", groupId: e.group.id }, displayName: e.group.name }, locale),
          icon: "ti ti-users-group",
          description: e.group.description ?? undefined,
        });
      else if (!options.serviceAccountFilter || options.serviceAccountFilter(e.serviceAccount)) {
        const account = e.serviceAccount;
        const kind = serviceAccountKindDisplay(account.kind, t);
        entries.push({
          principal: { type: "service_account", serviceAccountId: account.id },
          label: principalLabel(
            {
              principal: { type: "service_account", serviceAccountId: account.id },
              displayName: account.name,
              serviceAccountKind: account.kind,
            },
            locale,
          ),
          // Resource-bound accounts often share a name; their binding tells them apart.
          description:
            account.kind === "resource_bound"
              ? [account.appId, account.resourceType, account.resourceId].filter(Boolean).join(" · ")
              : kind.label,
          icon: `ti ${kind.icon}`,
          serviceAccountKind: account.kind,
        });
      }
    }
  }
  return entries;
}
