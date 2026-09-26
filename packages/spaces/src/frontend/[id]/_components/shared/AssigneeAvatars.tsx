import { Avatar, type AvatarSize } from "@k2b/ui";
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { SpaceItemAssignee, SpaceItemClaim } from "@/contracts";
import ClaimAvatar from "./claim/ClaimAvatar";

type Props = {
  assignees: SpaceItemAssignee[];
  /** The claim holder leads the stack with its success ring, appears once, and never folds into the overflow. */
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

export default function AssigneeAvatars(props: Props) {
  const max = () => props.max ?? 3;
  const size = () => props.size ?? "xs";
  const holderId = () => (props.claim?.actor.kind === "user" ? props.claim.actor.id : null);
  const others = () => props.assignees.filter((assignee) => assignee.id !== holderId());
  const visible = () => others().slice(0, Math.max(max() - (props.claim ? 1 : 0), 0));
  const hiddenCount = () => others().length - visible().length;
  const names = () => props.assignees.map((assignee) => assignee.displayName).join(", ");

  return (
    <Show when={props.assignees.length > 0 || props.claim} fallback={props.empty ?? null}>
      <div class={`flex min-w-0 items-center gap-2 ${props.class ?? ""}`} title={names() || undefined}>
        {/* `isolate` keeps the holder's layer inside the stack; the holder paints above the next avatar so its ring stays whole. */}
        <div class="isolate flex shrink-0 -space-x-1">
          <Show when={props.claim}>
            {(claim) => <ClaimAvatar claim={claim()} currentUserId={props.currentUserId ?? ""} size={size()} class="relative z-[1]" />}
          </Show>
          <For each={visible()}>
            {(assignee) => (
              <Avatar
                name={assignee.displayName}
                fallback={(assignee.displayName.trim() || "?").slice(0, 2).toUpperCase()}
                src={
                  assignee.avatarHash
                    ? `/api/accounts/users/${encodeURIComponent(assignee.id)}/avatar?rev=${encodeURIComponent(assignee.avatarHash)}`
                    : undefined
                }
                size={size()}
                class={`border-2 border-[var(--ui-surface)] ${props.avatarClass ?? ""}`}
              />
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
