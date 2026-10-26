import { Combobox, type ComboboxOption, useLocale } from "@k2b/ui";
import type { Principal, ServiceAccountKind } from "../contracts/shared";
import { accessMessages } from "./messages";
import { principalLabel } from "./principal-label";
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
  | { kind: "user"; user: { id: string; displayName: string; uid: string; mail: string | null; avatarHash?: string | null } }
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
        status: "active" | "disabled";
      };
    };
/** The service-account facts a consumer can check before offering an account. */
export type PrincipalPickerServiceAccount = Extract<Entity, { kind: "service_account" }>["serviceAccount"];
/** Shared identity selector; the consumer owns the meaning of the assignment. */
export default function PrincipalPicker(props: {
  existing?: Principal[];
  allowPublic?: boolean;
  allowAuthenticated?: boolean;
  allowServiceAccounts?: boolean;
  /** Offers only the service accounts this returns `true` for, such as active accounts the resource can accept. */
  serviceAccountFilter?: (account: PrincipalPickerServiceAccount) => boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** Replaces the default placeholder, which lists the principal kinds on offer. */
  placeholder?: string;
  /** The consumer's name and description for every signed-in person. */
  signedIn?: { label: string; description: string };
  /** `serviceAccountKind` is set for service accounts so a new row can show the same kind as the result. */
  onSelect: (
    principal: Principal,
    display: { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind },
  ) => void;
}) {
  const locale = useLocale(),
    t = () => accessMessages.resolve([locale()]).t;
  type Entry = {
    principal: Principal;
    label: string;
    icon: string;
    description?: string;
    avatarHash?: string | null;
    serviceAccountKind?: ServiceAccountKind;
  };
  let selectable = new Map<string, Entry>();
  const load = async (search: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
    const entries: Entry[] = [];
    if (props.allowAuthenticated !== false)
      entries.push({
        principal: { type: "authenticated" },
        label: props.signedIn?.label ?? principalLabel({ principal: { type: "authenticated" } }, locale()),
        icon: "ti ti-lock-open-2",
        description: props.signedIn?.description,
      });
    if (props.allowPublic)
      entries.push({
        principal: { type: "public" },
        label: principalLabel({ principal: { type: "public" } }, locale()),
        icon: "ti ti-world",
      });
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
            label: principalLabel(
              { principal: { type: "user", userId: e.user.id }, displayName: e.user.displayName || e.user.uid },
              locale(),
            ),
            avatarHash: e.user.avatarHash,
            icon: "ti ti-user",
            description: e.user.mail ?? e.user.uid,
          });
        else if (e.kind === "group")
          entries.push({
            principal: { type: "group", groupId: e.group.id },
            label: principalLabel({ principal: { type: "group", groupId: e.group.id }, displayName: e.group.name }, locale()),
            icon: "ti ti-users-group",
            description: e.group.description ?? undefined,
          });
        else if (!props.serviceAccountFilter || props.serviceAccountFilter(e.serviceAccount)) {
          const account = e.serviceAccount;
          const kind = serviceAccountKindDisplay(account.kind, t());
          entries.push({
            principal: { type: "service_account", serviceAccountId: account.id },
            label: principalLabel(
              {
                principal: { type: "service_account", serviceAccountId: account.id },
                displayName: account.name,
                serviceAccountKind: account.kind,
              },
              locale(),
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
    const existing = new Set(props.existing?.map(principalKey));
    const filtered = entries.filter((e) => !existing.has(principalKey(e.principal)));
    if (signal.aborted) return [];
    selectable = new Map(filtered.map((e) => [principalKey(e.principal), e]));
    return filtered.map((e) => ({ id: principalKey(e.principal), label: e.label, icon: e.icon, description: e.description }));
  };
  return (
    <Combobox
      disabled={props.disabled}
      readOnly={props.readOnly}
      placeholder={
        props.placeholder ??
        (props.allowAuthenticated !== false || props.allowPublic
          ? props.allowServiceAccounts
            ? t().addAll
            : t().addAudience
          : props.allowServiceAccounts
            ? t().addService
            : t().addBasic)
      }
      fetchData={load}
      onSelect={(option) => {
        const entry = selectable.get(option.id);
        if (entry)
          props.onSelect(entry.principal, {
            displayName: entry.label,
            avatarHash: entry.avatarHash,
            serviceAccountKind: entry.serviceAccountKind,
          });
      }}
    />
  );
}
