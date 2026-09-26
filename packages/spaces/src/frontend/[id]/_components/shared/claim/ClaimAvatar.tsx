import { Avatar, type AvatarSize } from "@k2b/ui";
import { Show } from "solid-js";
import type { SpaceItemClaim } from "@/contracts";
import { useSpaceMessages } from "../../../messages";
import { isOwnClaim } from "./claim";

type Props = {
  claim: SpaceItemClaim;
  currentUserId: string;
  size?: AvatarSize;
  /** Render the holder's name next to the avatar. */
  showName?: boolean;
  class?: string;
};

/** Who is working on a task right now: the holder's avatar with a success ring, identical for people and service accounts. */
export default function ClaimAvatar(props: Props) {
  const t = useSpaceMessages();
  const own = () => isOwnClaim(props.claim, props.currentUserId);
  const label = () => (own() ? t.youAreOnIt : t.onIt({ name: props.claim.displayName }));
  const user = () => props.claim.actor.kind === "user";

  return (
    <span
      data-spaces-claim-badge
      data-own-claim={own() ? "true" : undefined}
      class={`inline-flex min-w-0 shrink-0 items-center gap-1.5 ${props.class ?? ""}`}
      title={label()}
    >
      <Avatar
        name={props.claim.displayName}
        alt={label()}
        src={
          user() && props.claim.avatarHash
            ? `/api/accounts/users/${encodeURIComponent(props.claim.actor.id)}/avatar?rev=${encodeURIComponent(props.claim.avatarHash)}`
            : undefined
        }
        icon={user() ? undefined : "ti ti-api"}
        size={props.size ?? "xs"}
        class="ring-2 ring-[var(--k2b-success-text)] ring-offset-1 ring-offset-[var(--ui-surface)]"
      />
      <Show when={props.showName}>
        <span class="min-w-0 truncate text-sm font-medium">{own() ? t.youAreOnIt : props.claim.displayName}</span>
      </Show>
    </span>
  );
}
