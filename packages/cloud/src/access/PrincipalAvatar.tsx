import { Avatar } from "@k2b/ui";
import { Show } from "solid-js";
import { CloudAvatar } from "../account/Avatar";
import type { AccessEntry } from "../contracts/shared";

// One hue per principal kind from the avatar palette, so a group and all signed-in people read apart at a glance.
// People use a neutral background; a service account shows its robot or photo, and the account of an object its code
// icon unless it has a photo.
const hues = { group: "#22c55e", authenticated: "#3b82f6" } as const;
/** Every account that runs code shares one hue, so code reads as code rather than as a person with a tinted name. */
const codeHue = "#0369a1";

/**
 * Code's own service accounts show the code icon; they keep their kind `code` where the code lane adds it, so the
 * dialog can still refuse them Manage. The account behind an object's API keys shows the key icon.
 */
const kindIcons: Readonly<Record<string, string>> = { code: "ti ti-code", resource_bound: "ti ti-key" };
const kindIcon = (kind: string | undefined) => (kind === undefined ? undefined : kindIcons[kind]);

/** The 32px avatar of an access entry in the expanded editor and on the denial page. */
export default function PrincipalAvatar(props: {
  entry: Pick<AccessEntry, "principal" | "avatarHash" | "serviceAccountKind">;
  label: string;
}) {
  const icon = () => {
    switch (props.entry.principal.type) {
      case "group":
        return "ti-users-group";
      case "authenticated":
        return "ti-world";
      default:
        return "ti-world";
    }
  };
  const hue = () => {
    const type = props.entry.principal.type;
    return type === "group" || type === "authenticated" ? hues[type] : undefined;
  };
  return (
    <Show
      when={props.entry.principal.type === "user" ? props.entry.principal : undefined}
      fallback={
        // A Code account or an API key shows its icon in the square of service accounts unless it has a picture.
        props.entry.principal.type === "service_account" && kindIcon(props.entry.serviceAccountKind) && !props.entry.avatarHash ? (
          <Avatar
            name={props.label}
            icon={kindIcon(props.entry.serviceAccountKind)}
            shape="square"
            size="sm"
            class="h-8 w-8"
            style={props.entry.serviceAccountKind === "code" ? { "--k2b-avatar-hue": codeHue } : undefined}
          />
        ) : props.entry.principal.type === "service_account" ? (
          <CloudAvatar
            username={props.label}
            userId={props.entry.principal.serviceAccountId}
            avatarHash={props.entry.avatarHash}
            kind="service_account"
            size="sm"
            class="h-8 w-8"
          />
        ) : (
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
        )
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
