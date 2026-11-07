import { type JSX, Show } from "solid-js";
import { useWorkspaceMessages } from "./workspace-messages";

/**
 * Unread state for the trailing `meta` slot. Every mark keeps a fixed width,
 * so the row keeps its height and the label its start in every state.
 */
export type AppWorkspaceSidebarItemStatusProps = {
  /**
   * A positive number shows a count (above 99 as "99+") and sets the label in
   * a stronger weight; `true` shows a quiet dot for new activity that should
   * not draw attention, such as in a muted conversation.
   */
  unread?: number | boolean;
  /** Marks unread items that mention the person with "@". */
  mention?: boolean;
  /**
   * Shows a muted bell, and the item reads as set aside: its label in the muted ink without unread weight, and a
   * mention count without its fill.
   */
  muted?: boolean;
  /**
   * Items that wait for the person, such as requests to approve, in the unread slot instead of `unread`. `label` is
   * the phrase a screen reader hears, for example "3 waiting". `0` stays as a muted count, for a count that dropped
   * to zero while the row is still shown; leave the prop out when nothing waits.
   */
  waiting?: { count: number; label: string };
};
export const AppWorkspaceSidebarItemStatus = (props: AppWorkspaceSidebarItemStatusProps): JSX.Element => {
  const workspaceMessages = useWorkspaceMessages();
  const waiting = () => (props.waiting && Number.isFinite(props.waiting.count) ? Math.max(0, Math.floor(props.waiting.count)) : null);
  const count = () => waiting() ?? (typeof props.unread === "number" && props.unread >= 1 ? Math.floor(props.unread) : 0);
  const dot = () => waiting() === null && props.unread === true;
  // The marks are decorative; the row's accessible name gets one phrase instead,
  // which says no more than the "99+" a capped count shows.
  const description = () =>
    [
      waiting() !== null
        ? (props.waiting?.label ?? "")
        : count() > 99
          ? workspaceMessages().sidebarUnreadMany
          : count()
            ? workspaceMessages().sidebarUnread({ count: count() })
            : dot()
              ? workspaceMessages().sidebarNewActivity
              : "",
      props.mention ? workspaceMessages().sidebarMentioned : "",
      props.muted ? workspaceMessages().sidebarMuted : "",
    ]
      .filter(Boolean)
      .join(", ");
  // The unread slot stays reserved at the end, and the marks that change most
  // often sit outermost, so new activity or a mention never moves another mark.
  // The element itself stays when there is nothing to show: empty, it takes no
  // space, and it still keeps the row's label on one line, so the first count
  // never re-wraps the label and moves the rows below.
  return (
    <span
      class="k2b-app-workspace__sidebar-status"
      data-unread={waiting() !== null ? undefined : count() ? "count" : dot() ? "dot" : undefined}
      data-waiting={waiting() === null ? undefined : waiting() ? "count" : "zero"}
      data-muted={props.muted ? "true" : undefined}
    >
      <Show when={description()}>
        <Show when={props.mention}>
          <span class="k2b-app-workspace__sidebar-status-mention" aria-hidden="true">
            @
          </span>
        </Show>
        <Show when={props.muted}>
          <span class="k2b-app-workspace__sidebar-status-muted" aria-hidden="true">
            <i class="ti ti-bell-off" />
          </span>
        </Show>
        <span class="k2b-app-workspace__sidebar-status-unread" aria-hidden="true">
          <Show
            when={count() || waiting() === 0}
            fallback={
              <Show when={dot()}>
                <span class="k2b-app-workspace__sidebar-status-dot" />
              </Show>
            }
          >
            <span class="k2b-app-workspace__sidebar-status-count" data-mention={props.mention ? "true" : undefined}>
              {count() > 99 ? "99+" : count()}
            </span>
          </Show>
        </span>
        <span class="k2b-sr-only">, {description()}</span>
      </Show>
    </span>
  );
};
