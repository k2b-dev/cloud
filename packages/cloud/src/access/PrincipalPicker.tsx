import { Combobox, type ComboboxOption, useLocale } from "@k2b/ui";
import type { Principal, ServiceAccountKind } from "../contracts/shared";
import { groupDisplayName } from "../shared/account-display";
import { accessMessages } from "./messages";
import { serviceAccountKindDisplay } from "./service-account-kind";

export const principalKey = (p: Principal) =>
  p.type === "user"
    ? `u:${p.userId}`
    : p.type === "group"
      ? `g:${p.groupId}`
      : p.type === "service_account"
        ? `s:${p.serviceAccountId}`
        : p.type;
type Entity =
  | { kind: "user"; user: { id: string; displayName: string; uid: string; mail: string | null } }
  | { kind: "group"; group: { id: string; name: string; description: string | null } }
  | {
      kind: "service_account";
      serviceAccount: {
        id: string;
        name: string;
        kind: ServiceAccountKind;
        appId: string | null;
        resourceType: string | null;
        resourceId: string | null;
      };
    };
/** Shared identity selector; the consumer owns the meaning of the assignment. */
export default function PrincipalPicker(props: {
  existing?: Principal[];
  allowPublic?: boolean;
  allowAuthenticated?: boolean;
  allowServiceAccounts?: boolean;
  disabled?: boolean;
  /** `serviceAccountKind` is set for service accounts so a new row can show the same kind as the result. */
  onSelect: (principal: Principal, display: { displayName: string; serviceAccountKind?: ServiceAccountKind }) => void;
}) {
  const locale = useLocale(),
    t = () => accessMessages.resolve([locale()]).t;
  type Entry = { principal: Principal; label: string; icon: string; description?: string; serviceAccountKind?: ServiceAccountKind };
  let selectable = new Map<string, Entry>();
  const load = async (search: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
    const entries: Entry[] = [];
    if (props.allowAuthenticated !== false)
      entries.push({ principal: { type: "authenticated" }, label: t().allUsers, icon: "ti ti-lock-open-2" });
    if (props.allowPublic) entries.push({ principal: { type: "public" }, label: t().public, icon: "ti ti-world" });
    if (search.length >= 2) {
      const url = new URL("/api/accounts/entities", window.location.origin);
      url.searchParams.set("search", search);
      url.searchParams.set("kinds", props.allowServiceAccounts ? "user,group,service_account" : "user,group");
      url.searchParams.set("per_page", "10");
      const users = props.existing?.flatMap((p) => (p.type === "user" ? [p.userId] : [])) ?? [];
      const groups = props.existing?.flatMap((p) => (p.type === "group" ? [p.groupId] : [])) ?? [];
      const services = props.existing?.flatMap((p) => (p.type === "service_account" ? [p.serviceAccountId] : [])) ?? [];
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
            label: e.user.displayName || e.user.uid,
            icon: "ti ti-user",
            description: e.user.mail ?? e.user.uid,
          });
        else if (e.kind === "group")
          entries.push({
            principal: { type: "group", groupId: e.group.id },
            label: groupDisplayName(e.group.name, locale()),
            icon: "ti ti-users-group",
            description: e.group.description ?? undefined,
          });
        else {
          const account = e.serviceAccount;
          const kind = serviceAccountKindDisplay(account.kind, t());
          entries.push({
            principal: { type: "service_account", serviceAccountId: account.id },
            label: account.name,
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
    const existing = new Set(props.existing?.map(principalKey));
    const filtered = entries.filter((e) => !existing.has(principalKey(e.principal)));
    if (signal.aborted) return [];
    selectable = new Map(filtered.map((e) => [principalKey(e.principal), e]));
    return filtered.map((e) => ({ id: principalKey(e.principal), label: e.label, icon: e.icon, description: e.description }));
  };
  return (
    <Combobox
      disabled={props.disabled}
      placeholder={
        props.allowAuthenticated !== false || props.allowPublic
          ? props.allowServiceAccounts
            ? t().addAll
            : t().addAudience
          : props.allowServiceAccounts
            ? t().addService
            : t().addBasic
      }
      fetchData={load}
      onSelect={(option) => {
        const entry = selectable.get(option.id);
        if (entry) props.onSelect(entry.principal, { displayName: entry.label, serviceAccountKind: entry.serviceAccountKind });
      }}
    />
  );
}
