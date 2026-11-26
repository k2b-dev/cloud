import { Combobox, type ComboboxOption, useLocale } from "@k2b/ui";
import { createSignal, type JSX } from "solid-js";
import type { CloudResourceRef } from "../contracts/capabilities";
import type { Principal, ServiceAccountKind, ServiceAccountStatus } from "../contracts/shared";
import { accessMessages } from "./messages";
import { principalKey } from "./principal-key";
import { principalLabel } from "./principal-label";
import { type PrincipalSearchEntry, searchPrincipals } from "./principal-search";

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
/** A service account found by its handle, ready to become a row. */
export type FoundServiceAccount = {
  principal: Principal;
  display: { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind };
  /** The server's line under the name, such as "Service account of a mailbox". */
  description?: string;
};
/** The service-account facts a consumer can check before offering an account. */
export type PrincipalPickerServiceAccount = Extract<Entity, { kind: "service_account" }>["serviceAccount"];
/** Shared identity selector; the consumer owns the meaning of the assignment. */
export default function PrincipalPicker(props: {
  existing?: Principal[];
  /** Resource being shared; Core verifies Manage before resolving a Code handle. */
  target?: CloudResourceRef;
  allowPublic?: boolean;
  allowAuthenticated?: boolean;
  /** Defaults to true; disable only for a documented user-backed workflow. */
  allowServiceAccounts?: boolean;
  /** Directory kinds on offer, such as only groups for a group rule; defaults to people and groups. */
  kinds?: readonly ("user" | "group")[];
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
  empty?: JSX.Element | ((query: string) => JSX.Element);
  /**
   * Looks up an exact Code handle (`code-` and 10 characters) with the resource as the target, as the consumer's
   * own handle field does. Such a query asks only this lookup, never the directory, so names never find these
   * accounts; the hit carries the "Service account" badge.
   */
  findServiceAccount?: (handle: string, signal: AbortSignal) => Promise<FoundServiceAccount | null>;
  /** `serviceAccountKind` is set for service accounts so a new row can show the same kind as the result. */
  onSelect: (
    principal: Principal,
    display: { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind },
  ) => void;
}) {
  const locale = useLocale(),
    t = () => accessMessages.resolve([locale()]).t;
  type Entry = PrincipalSearchEntry;
  let selectable = new Map<string, Entry>();
  const [lastQuery, setLastQuery] = createSignal("");
  const load = async (search: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
    setLastQuery(search.trim());
    const entries = await searchPrincipals(search, props, signal, locale());
    const existing = new Set(props.existing?.map(principalKey));
    const taken = (e: Entry) => (existing.has(principalKey(e.principal)) ? (props.takenReason?.(e.principal) ?? null) : undefined);
    // A principal on the list stays visible when a reason is given, so the search never looks like it missed someone.
    // A search lists only what it finds, so "everyone" does not answer a name and hide that nobody matched.
    const query = search.trim().toLowerCase();
    const found = (e: Entry) =>
      search.length < 2 || (e.principal.type !== "authenticated" && e.principal.type !== "public") || e.label.toLowerCase().includes(query);
    const shown = entries.filter((e) => taken(e) !== null && found(e));
    if (signal.aborted) return [];
    selectable = new Map(shown.filter((e) => taken(e) === undefined).map((e) => [principalKey(e.principal), e]));
    return shown.map((e): ComboboxOption => {
      const reason = taken(e);
      return typeof reason === "string"
        ? { id: principalKey(e.principal), label: e.label, icon: e.icon, description: reason, disabled: true }
        : { id: principalKey(e.principal), label: e.label, icon: e.icon, description: e.description, badge: e.badge };
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
      empty={typeof props.empty === "function" ? props.empty(lastQuery()) : props.empty}
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
