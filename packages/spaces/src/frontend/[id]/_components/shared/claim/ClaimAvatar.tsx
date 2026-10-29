import { CloudAvatar } from "@k2b/cloud/account/ui";
import { Avatar, type AvatarSize } from "@k2b/ui";
import type { SpaceItemClaim } from "@/contracts";
import { useSpaceMessages } from "../../../messages";
import { isOwnClaim } from "./claim";

type Props = {
  claim: SpaceItemClaim;
  currentUserId: string;
  size?: AvatarSize;
  class?: string;
};

/**
 * Who is working on a task right now: the holder's avatar with a success ring, identical for people and service accounts.
 * The ring lies inside the avatar, so the holder keeps the size and place of the assignee avatars on cards and in the
 * panel, and no panel edge cuts it off.
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
      <CloudAvatar
        username={props.claim.displayName}
        alt={label()}
        userId={props.claim.actor.id}
        avatarHash={props.claim.avatarHash}
        kind={user() ? "user" : "service_account"}
        size={props.size ?? "xs"}
        ring="success"
      />
    </span>
  );
}
