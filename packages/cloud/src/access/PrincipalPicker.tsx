import { Combobox, type ComboboxOption, useLocale } from "@k2b/ui";
import { createSignal, type JSX } from "solid-js";
import type { Principal, ServiceAccountKind, ServiceAccountStatus } from "../contracts/shared";
import { accessMessages } from "./messages";
import { principalKey } from "./principal-key";
import { principalLabel } from "./principal-label";
import { serviceAccountKindDisplay } from "./service-account-kind";

export { principalKey };

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
  /** Defaults to true; disable only for a documented user-backed workflow. */
  allowServiceAccounts?: boolean;
  /** Optional directory filters for the resource's accepted credential kinds. */
  serviceAccountKinds?: ServiceAccountKind[];
  serviceAccountStatus?: ServiceAccountStatus;
  /** Offers only the service accounts this returns `true` for, such as active accounts the resource can accept. */
  serviceAccountFilter?: (account: PrincipalPickerServiceAccount) => boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** Replaces the default placeholder, which lists the principal kinds on offer. */
  placeholder?: string;
  /** The consumer's name and description for every signed-in person. */
  signedIn?: { label: string; description: string };
  /**
   * Keeps a principal that is already on the list in the results, shown but not pickable, with this reason such as
   * "already has Edit". Without it, such principals are left out of the results.
   */
  takenReason?: (principal: Principal) => string | undefined;
  /** Shown instead of the default text when a search finds nothing, with the typed search. */
  empty?: (query: string) => JSX.Element;
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
  const [lastQuery, setLastQuery] = createSignal("");
  const load = async (search: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
    setLastQuery(search.trim());
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
      url.searchParams.set("kinds", props.allowServiceAccounts !== false ? "user,group,service_account" : "user,group");
      if (props.allowServiceAccounts !== false && props.serviceAccountKinds?.length) {
        url.searchParams.set("service_account_kinds", props.serviceAccountKinds.join(","));
      }
      if (props.allowServiceAccounts !== false && props.serviceAccountStatus) {
        url.searchParams.set("service_account_status", props.serviceAccountStatus);
      }
      url.searchParams.set("per_page", "10");
      // With a reason for listed principals, the server must return them too, so they can show greyed.
      const excluded = props.takenReason ? [] : (props.existing ?? []);
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
    const taken = (e: Entry) => (existing.has(principalKey(e.principal)) ? (props.takenReason?.(e.principal) ?? null) : undefined);
    // A principal on the list stays visible when a reason is given, so the search never looks like it missed someone.
    const shown = entries.filter((e) => taken(e) !== null);
    if (signal.aborted) return [];
    selectable = new Map(shown.filter((e) => taken(e) === undefined).map((e) => [principalKey(e.principal), e]));
    return shown.map((e): ComboboxOption => {
      const reason = taken(e);
      return typeof reason === "string"
        ? { id: principalKey(e.principal), label: e.label, icon: e.icon, description: reason, disabled: true }
        : { id: principalKey(e.principal), label: e.label, icon: e.icon, description: e.description };
    });
  };
  return (
    <Combobox
      disabled={props.disabled}
      readOnly={props.readOnly}
      placeholder={
        props.placeholder ??
        (props.allowAuthenticated !== false || props.allowPublic
          ? props.allowServiceAccounts !== false
            ? t().addAll
            : t().addAudience
          : props.allowServiceAccounts !== false
            ? t().addService
            : t().addBasic)
      }
      fetchData={load}
      empty={props.empty ? props.empty(lastQuery()) : undefined}
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
