import { CloudAvatar } from "@k2b/cloud/account/ui";
import { Avatar, type AvatarSize } from "@k2b/ui";
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { SpaceItemAssignee, SpaceItemClaim } from "@/contracts";
import ClaimAvatar from "./claim/ClaimAvatar";
import { isClaimHolder } from "./claim/claim";

type Props = {
  assignees: SpaceItemAssignee[];
  /**
   * Who works on the task. That person leads the stack with the success ring, appears once, and never folds into the
   * overflow: an assignee who holds the claim is drawn as the holder, and a holder outside the assignees still leads.
   */
  claim?: SpaceItemClaim | null;
  currentUserId?: string;
  /** Visible avatars including the claim holder; the rest collapse into `+N`. */
  max?: number;
  size?: AvatarSize;
  showNames?: boolean;
  class?: string;
  avatarClass?: string;
  overflowClass?: string;
  empty?: JSX.Element;
};

const SIZE_CLASS: Record<AvatarSize, string> = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-16 w-16 text-lg",
  xl: "h-20 w-20 text-xl",
};

/** One assignee: a person with their picture or initials, a service account with its robot in a square, like its claim. */
export function AssigneeAvatar(props: { assignee: SpaceItemAssignee; size?: AvatarSize; class?: string }) {
  return (
    <CloudAvatar
      username={props.assignee.displayName}
      userId={props.assignee.id}
      avatarHash={props.assignee.avatarHash}
      kind={props.assignee.kind === "user" ? "user" : "service_account"}
      size={props.size ?? "xs"}
      class={props.class}
    />
  );
}

export default function AssigneeAvatars(props: Props) {
  const max = () => props.max ?? 3;
  const size = () => props.size ?? "xs";
  const others = () => props.assignees.filter((assignee) => !isClaimHolder(props.claim, assignee));
  const visible = () => others().slice(0, Math.max(max() - (props.claim ? 1 : 0), 0));
  const hiddenCount = () => others().length - visible().length;
  /** Names in stack order: the working person first. */
  const names = () => [...(props.claim ? [props.claim.displayName] : []), ...others().map((assignee) => assignee.displayName)].join(", ");

  return (
    <Show when={props.assignees.length > 0 || props.claim} fallback={props.empty ?? null}>
      <div class={`flex min-w-0 items-center gap-2 ${props.class ?? ""}`} title={names() || undefined}>
        {/* The holder does not tuck under the next avatar, so its whole ring stays visible and touches the next one. */}
        <div class="flex shrink-0 -space-x-1">
          <Show when={props.claim}>
            {(claim) => <ClaimAvatar claim={claim()} currentUserId={props.currentUserId ?? ""} size={size()} class="me-0" />}
          </Show>
          <For each={visible()}>
            {(assignee) => (
              <AssigneeAvatar assignee={assignee} size={size()} class={`border-2 border-[var(--ui-surface)] ${props.avatarClass ?? ""}`} />
            )}
          </For>
          <Show when={hiddenCount() > 0}>
            <span
              class={`flex shrink-0 items-center justify-center rounded-full border-2 border-[var(--ui-surface)] bg-[var(--ui-surface-muted)] font-medium text-secondary ${SIZE_CLASS[size()]} ${props.overflowClass ?? ""}`}
            >
              +{hiddenCount()}
            </span>
          </Show>
        </div>
        <Show when={props.showNames}>
          <span class="min-w-0 truncate text-secondary">{names()}</span>
        </Show>
      </div>
    </Show>
  );
}
