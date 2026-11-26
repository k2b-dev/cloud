import { AvatarStack, type AvatarStackPerson, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { cloudAvatarImage } from "../account/Avatar";
import { type AccessSummaryProps, createAccessSummary } from "./access-summary";
import { principalLabel } from "./principal-label";
import { serviceAccountKindDisplay } from "./service-account-kind";

/** Faces before "+n", as in the approved mockup. */
const FACES = 5;

/**
 * Who has access to a resource, in one line under a few faces: the entry point to the access dialog in an app's
 * settings. The faces open the full list with each level, so nobody has to open the editor only to read it.
 */
export function AccessSummary(props: AccessSummaryProps) {
  const locale = useLocale();
  const { t, access, levelOf, members, line } = createAccessSummary(props, locale);
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
