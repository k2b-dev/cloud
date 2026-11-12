import { Button, Dropdown, IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, type JSX, Show } from "solid-js";
import { getMailAction, type MailActionId } from "./mail-actions";
import { mailRemainingMessages } from "./mail-remaining-messages";

/** Tomorrow at 8:00 and next Monday at 8:00 in the browser's time, as ISO times for "Later". */
export const mailLaterPresets = (now: Date): { tomorrow: string; monday: string } => {
  const at8 = (days: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(8, 0, 0, 0);
    return date.toISOString();
  };
  // Monday of next week: 1 to 7 days ahead, never today.
  const untilMonday = (8 - now.getDay()) % 7 || 7;
  return { tomorrow: at8(1), monday: at8(untilMonday) };
};

/**
 * The bulk actions take the tab row's place with the first selection, at the same height: Done, Archive, Delete ·
 * Unread, Later, Assign · Move, Tags, and "…" with Junk and Flag.
 */
export default function MailBulkActionBar(props: {
  selectedCount: number;
  selectedInJunk: boolean;
  /** Every selected conversation is flagged, so "…" offers to remove the flag. */
  selectedFlagged: boolean;
  busy: boolean;
  onClear: () => void;
  /** Absent for a person who sees only assigned conversations: both reach the whole mailbox. */
  onAddTags?: () => void | Promise<void>;
  onAssign?: () => void | Promise<void>;
  /** Absent where conversations have no work status, as in a folder of sent mail. */
  onDone?: () => void | Promise<void>;
  onLater?: (until: string) => void | Promise<void>;
  onAction: (actionId: MailActionId) => void | Promise<void>;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const actionLabel = (actionId: MailActionId): string => {
    const labels: Record<MailActionId, string> = {
      archive: messages().archive,
      mark_read: messages().markRead,
      flag: messages().flagAction,
      move: messages().move,
      trash: messages().bulkDelete,
      mark_unread: messages().bulkUnread,
      unflag: messages().unflag,
      junk: messages().junk,
      not_spam: messages().notSpam,
    };
    return labels[actionId];
  };
  const button = (label: string, icon: string, run: () => void | Promise<void>, sectionStart = false): JSX.Element => (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={messages().actionOnSelected({ action: label, count: props.selectedCount })}
      disabled={props.busy}
      data-section-start={sectionStart ? "" : undefined}
      onClick={() => void run()}
    >
      <i class={icon} aria-hidden="true" />
      {label}
    </Button>
  );
  const actionButton = (actionId: MailActionId, sectionStart = false) =>
    button(actionLabel(actionId), getMailAction(actionId).icon, () => props.onAction(actionId), sectionStart);
  const menuAction = (actionId: MailActionId) => ({
    label: actionLabel(actionId),
    icon: getMailAction(actionId).icon,
    ...(getMailAction(actionId).destructive ? { variant: "danger" as const } : {}),
    action: () => void props.onAction(actionId),
  });
  return (
    <div class="mail-bulk-bar" role="toolbar" aria-label={messages().selectedConversationActions}>
      <span class="mail-bulk-summary">
        <Tooltip.Anchor content={messages().exitSelection}>
          <IconButton type="button" data-mail-selection-exit label={messages().exitSelection} disabled={props.busy} onClick={props.onClear}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
        <span class="truncate text-sm font-semibold text-primary" aria-live="polite">
          {props.selectedCount > 0 ? messages().selected({ count: props.selectedCount }) : messages().selectConversations}
        </span>
      </span>
      <Show when={props.selectedCount > 0}>
        <div class="mail-bulk-actions">
          <Show when={props.onDone}>{(onDone) => button(messages().bulkDone, "ti ti-check", onDone())}</Show>
          {actionButton("archive")}
          {actionButton("trash")}
          {actionButton("mark_unread", true)}
          <Show when={props.onLater}>
            {(onLater) => (
              <Dropdown.Root
                position="bottom-left"
                width="14rem"
                items={[
                  {
                    label: messages().laterTomorrow,
                    icon: "ti ti-sun",
                    action: () => void onLater()(mailLaterPresets(new Date()).tomorrow),
                  },
                  {
                    label: messages().laterMonday,
                    icon: "ti ti-calendar-week",
                    action: () => void onLater()(mailLaterPresets(new Date()).monday),
                  },
                ]}
              >
                <Dropdown.Trigger
                  type="button"
                  size="sm"
                  variant="ghost"
                  label={messages().actionOnSelected({ action: messages().bulkLater, count: props.selectedCount })}
                  disabled={props.busy}
                >
                  <i class="ti ti-clock" aria-hidden="true" />
                  {messages().bulkLater}
                </Dropdown.Trigger>
              </Dropdown.Root>
            )}
          </Show>
          <Show when={props.onAssign}>{(onAssign) => button(messages().assign, "ti ti-user-plus", onAssign())}</Show>
          {actionButton("move", true)}
          <Show when={props.onAddTags}>
            {(onAddTags) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={messages().addTagsToSelected({ count: props.selectedCount })}
                disabled={props.busy}
                onClick={() => void onAddTags()()}
              >
                <i class="ti ti-tags" aria-hidden="true" /> {messages().addTags}
              </Button>
            )}
          </Show>
          <Dropdown.Root
            position="bottom-right"
            width="16rem"
            items={([props.selectedInJunk ? "not_spam" : "junk", props.selectedFlagged ? "unflag" : "flag", "mark_read"] as const).map(
              menuAction,
            )}
          >
            <Dropdown.Trigger iconOnly type="button" variant="ghost" label={messages().moreSelectedActions} disabled={props.busy}>
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </Show>
    </div>
  );
}
