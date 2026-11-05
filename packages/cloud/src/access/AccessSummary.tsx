import { AvatarStack, type AvatarStackPerson, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { cloudAvatarImage } from "../account/Avatar";
import type { AccessEntry } from "../contracts/shared";
import { accessDialogMessages } from "./access-dialog-messages";
import { accessMessages } from "./messages";
import { type AllowedLevel, levelKey, resolveAllowedLevels } from "./PermissionEditor";
import { principalLabel } from "./principal-label";
import { serviceAccountKindDisplay } from "./service-account-kind";

/** Faces before "+n", as in the approved mockup. */
const FACES = 5;

/**
 * Who has access to a resource, in one line under a few faces: the entry point to the access dialog in an app's
 * settings. The faces open the full list with each level, so nobody has to open the editor only to read it.
 */
export function AccessSummary(props: {
  entries: readonly AccessEntry[];
  /** The resource's own level names, as given to the access dialog. */
  allowedLevels?: AllowedLevel[];
  /** The grants that take effect, such as without those a denial hides; defaults to all of them. */
  effectiveEntries?: (entries: readonly AccessEntry[]) => readonly AccessEntry[];
}) {
  const locale = useLocale();
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const access = () => accessMessages.resolve([locale()]).t;
  const active = () => (props.effectiveEntries ?? ((entries) => entries))(props.entries).filter((entry) => entry.permission !== "none");
  const levelOf = (entry: AccessEntry) =>
    resolveAllowedLevels(props.allowedLevels, access()).find((level) => level.key === levelKey(entry.permission, entry.scope))?.label ??
    entry.permission;
  const general = (type: "authenticated" | "public") => active().find((entry) => entry.principal.type === type);
  // Code's own service accounts carry the kind `code` where the code lane adds it; an object's account is its API key.
  const kind = (entry: AccessEntry): string | undefined => entry.serviceAccountKind;
  const serviceAccounts = () => active().filter((entry) => kind(entry) === "code");
  const apiKeys = () => active().filter((entry) => kind(entry) === "resource_bound");
  const members = () =>
    active().filter(
      (entry) =>
        entry.principal.type !== "authenticated" &&
        entry.principal.type !== "public" &&
        kind(entry) !== "code" &&
        kind(entry) !== "resource_bound",
    );
  const people = (): AvatarStackPerson[] =>
    members().map((entry) => {
      const name = principalLabel(entry, locale());
      const principal = entry.principal;
      return {
        id: entry.id,
        name,
        detail: levelOf(entry),
        ...(principal.type === "user"
          ? { src: cloudAvatarImage({ kind: "user", userId: principal.userId, avatarHash: entry.avatarHash }) }
          : principal.type === "group"
            ? { icon: "ti ti-users-group" }
            : principal.type === "service_account"
              ? (() => {
                  const display = entry.serviceAccountKind ? serviceAccountKindDisplay(entry.serviceAccountKind, access()) : undefined;
                  return {
                    src: cloudAvatarImage({ kind: "service_account", userId: principal.serviceAccountId, avatarHash: entry.avatarHash }),
                    icon: `ti ${display?.icon ?? "ti-key"}`,
                    shape: "square" as const,
                    badge: display?.label,
                  };
                })()
              : {}),
      };
    });
  const line = () => {
    const signedIn = general("authenticated");
    const visitors = general("public");
    return [
      t().summaryMembers({ count: members().length }),
      `${t().signedInLabel}: ${signedIn ? levelOf(signedIn) : t().summaryOff}`,
      ...(visitors ? [`${principalLabel(visitors, locale())}: ${levelOf(visitors)}`] : []),
      ...(serviceAccounts().length > 0 ? [t().summaryServiceAccounts({ count: serviceAccounts().length })] : []),
      ...(apiKeys().length > 0 ? [t().summaryApiKeys({ count: apiKeys().length })] : []),
    ].join(" · ");
  };
  return (
    <div class="flex min-w-0 flex-col gap-1.5">
      <Show when={people().length > 0}>
        <AvatarStack
          people={people()}
          max={FACES}
          title={t().summaryTitle}
          label={t().summaryStackLabel({ name: people()[0]!.name, more: people().length - 1 })}
        />
      </Show>
      <p class="text-[13px] text-dimmed">{line()}</p>
    </div>
  );
}

export default AccessSummary;
