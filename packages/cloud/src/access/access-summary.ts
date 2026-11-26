import { createMemo } from "solid-js";
import type { AccessEntry, ServiceAccountKind } from "../contracts/shared";
import { accessDialogMessages } from "./access-dialog-messages";
import { accessMessages } from "./messages";
import { type AllowedLevel, levelKey, resolveAllowedLevels } from "./PermissionEditor";
import { principalKey } from "./principal-key";
import { principalLabel } from "./principal-label";

const rank = { none: 0, read: 1, write: 2, admin: 3 } as const;

export type AccessSummaryProps = {
  entries: readonly AccessEntry[];
  /** The resource's own level names, as given to the access dialog. */
  allowedLevels?: AllowedLevel[];
  /** The grants that take effect, such as without those a denial hides; defaults to all of them. */
  effectiveEntries?: (entries: readonly AccessEntry[]) => readonly AccessEntry[];
  /**
   * Whether the resource offers "All signed-in people", as given to the access dialog. Defaults to true. Without it the
   * line names General only while a stored entry for it remains, denials included, as the dialog keeps that row.
   */
  allowAuthenticated?: boolean;
};

/**
 * What the summary of a resource's access says, shared by its v1 and v2 looks: the members with their strongest
 * level (one per principal, an unscoped grant winning a tie), and the one line under the faces.
 */
export function createAccessSummary(props: AccessSummaryProps, locale: () => string) {
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const access = () => accessMessages.resolve([locale()]).t;
  const levelOf = (entry: AccessEntry) =>
    resolveAllowedLevels(props.allowedLevels, access()).find((level) => level.key === levelKey(entry.permission, entry.scope))?.label ??
    entry.permission;
  // One row per principal with its strongest grant, as the service resolves it; an unscoped grant wins a tie.
  const strongest = createMemo(() => {
    const byPrincipal = new Map<string, AccessEntry>();
    for (const entry of (props.effectiveEntries ?? ((entries) => entries))(props.entries)) {
      if (entry.permission === "none") continue;
      const key = principalKey(entry.principal);
      const kept = byPrincipal.get(key);
      const stronger =
        !kept ||
        rank[entry.permission] > rank[kept.permission] ||
        (rank[entry.permission] === rank[kept.permission] && !entry.scope && kept.scope);
      if (stronger) byPrincipal.set(key, entry);
    }
    return [...byPrincipal.values()];
  });
  const general = (type: "authenticated" | "public") => strongest().find((entry) => entry.principal.type === type);
  // Code's own service accounts carry the kind `code`. An object's account belongs to its API keys, which the app
  // shows in their own section.
  const kind = (entry: AccessEntry): ServiceAccountKind | undefined => entry.serviceAccountKind;
  const serviceAccounts = () => strongest().filter((entry) => kind(entry) === "code");
  const members = () =>
    strongest().filter(
      (entry) =>
        entry.principal.type !== "authenticated" &&
        entry.principal.type !== "public" &&
        kind(entry) !== "code" &&
        kind(entry) !== "resource_bound",
    );
  const line = () => {
    const signedIn = general("authenticated");
    const visitors = general("public");
    return [
      t().summaryMembers({ count: members().length }),
      ...(props.allowAuthenticated !== false || props.entries.some((entry) => entry.principal.type === "authenticated")
        ? [`${t().signedInLabel}: ${signedIn ? levelOf(signedIn) : t().summaryOff}`]
        : []),
      ...(visitors ? [`${principalLabel(visitors, locale())}: ${levelOf(visitors)}`] : []),
      ...(serviceAccounts().length > 0 ? [t().summaryServiceAccounts({ count: serviceAccounts().length })] : []),
    ].join(" · ");
  };
  return { t, access, levelOf, members, line };
}
