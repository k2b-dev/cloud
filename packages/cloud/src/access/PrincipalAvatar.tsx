import { Show } from "solid-js";
import { CloudAvatar } from "../account/Avatar";
import type { AccessEntry } from "../contracts/shared";

// One hue per principal kind from the avatar palette, so a group, a service account and all signed-in people
// read apart at a glance. People use a neutral background.
const hues = { group: "#22c55e", service_account: "#8b5cf6", authenticated: "#3b82f6" } as const;

/** The 32px avatar of an access entry in the expanded editor and on the denial page. */
export default function PrincipalAvatar(props: {
  entry: Pick<AccessEntry, "principal" | "avatarHash" | "serviceAccountKind">;
  label: string;
}) {
  const icon = () => {
    switch (props.entry.principal.type) {
      case "group":
        return "ti-users-group";
      case "service_account":
        return "ti-robot";
      case "authenticated":
        return "ti-world";
      default:
        return "ti-world";
    }
  };
  const hue = () => {
    const type = props.entry.principal.type;
    return type === "group" || type === "service_account" || type === "authenticated" ? hues[type] : undefined;
  };
  return (
    <Show
      when={props.entry.principal.type === "user" ? props.entry.principal : undefined}
      fallback={
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ui-surface-muted)] text-secondary"
          // The avatar formula: a light share of the hue on the surface, a dark share on the text, in both themes.
          style={
            hue()
              ? {
                  background: `color-mix(in srgb, ${hue()} 18%, var(--k2b-surface))`,
                  color: `color-mix(in srgb, ${hue()} 55%, var(--k2b-text))`,
                }
              : undefined
          }
          aria-hidden="true"
        >
          <i class={`ti ${icon()} text-xs`} />
        </span>
      }
    >
      {(user) => (
        <CloudAvatar
          username={props.label}
          userId={user().userId}
          avatarHash={props.entry.avatarHash}
          size="sm"
          class="h-8 w-8"
          style={{ background: "var(--k2b-surface-muted)", color: "var(--k2b-text-secondary)" }}
        />
      )}
    </Show>
  );
}
