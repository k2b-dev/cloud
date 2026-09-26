import { Avatar, type AvatarSize } from "@k2b/ui";
import { Show } from "solid-js";
import type { SpaceItemClaim } from "@/contracts";
import { useSpaceMessages } from "../../../messages";
import { isOwnClaim } from "./claim";

type Props = {
  claim: SpaceItemClaim;
  currentUserId: string;
  size?: AvatarSize;
  /** Render the holder's name next to the avatar, in the same row layout as the assignees. */
  showName?: boolean;
  class?: string;
};

/**
 * Who is working on a task right now: the holder's avatar with a success ring, identical for people and service accounts.
 * The ring is a border inside the avatar's footprint, so the holder keeps the size of the assignee avatars.
 */
export default function ClaimAvatar(props: Props) {
  const t = useSpaceMessages();
  const own = () => isOwnClaim(props.claim, props.currentUserId);
  const label = () => (own() ? t.youAreOnIt : t.onIt({ name: props.claim.displayName }));
  const user = () => props.claim.actor.kind === "user";

  return (
    <span
      data-spaces-claim-badge
      data-own-claim={own() ? "true" : undefined}
      class={`inline-flex min-w-0 shrink-0 items-center gap-2 ${props.class ?? ""}`}
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
        class="border-2 border-[var(--k2b-success-text)]"
      />
      <Show when={props.showName}>
        <span class="min-w-0 flex-1 truncate text-sm">{own() ? t.youAreOnIt : props.claim.displayName}</span>
      </Show>
    </span>
  );
}
