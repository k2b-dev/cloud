import { Dropdown, IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { getMailAction, type MailActionId } from "./mail-actions";
import { mailRemainingMessages } from "./mail-remaining-messages";

export default function MailBulkActionBar(props: {
  selectedCount: number;
  selectedInJunk: boolean;
  busy: boolean;
  onClear: () => void;
  onAddTags: () => void | Promise<void>;
  onAssign: () => void | Promise<void>;
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
      trash: messages().trash,
      mark_unread: messages().markUnread,
      unflag: messages().unflag,
      junk: messages().junk,
      not_spam: messages().notSpam,
    };
    return labels[actionId];
  };
  const actionButton = (actionId: MailActionId) => {
    const label = actionLabel(actionId);
    return (
      <Tooltip.Anchor content={label}>
        <IconButton
          type="button"
          label={messages().actionOnSelected({ action: label, count: props.selectedCount })}
          disabled={props.busy}
          onClick={() => void props.onAction(actionId)}
        >
          <i class={getMailAction(actionId).icon} aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
    );
  };
  const menuAction = (actionId: MailActionId) => ({
    label: actionLabel(actionId),
    icon: getMailAction(actionId).icon,
    ...(getMailAction(actionId).destructive ? { variant: "danger" as const } : {}),
    action: () => void props.onAction(actionId),
  });
  return (
    <div class="flex min-w-0 items-center gap-1" role="toolbar" aria-label={messages().selectedConversationActions}>
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-primary" aria-live="polite">
        {props.selectedCount > 0 ? messages().selected({ count: props.selectedCount }) : messages().selectConversations}
      </span>
      <Show when={props.selectedCount > 0}>
        <Tooltip.Anchor content={messages().addTags}>
          <IconButton
            type="button"
            label={messages().addTagsToSelected({ count: props.selectedCount })}
            disabled={props.busy}
            onClick={() => void props.onAddTags()}
          >
            <i class="ti ti-tags" aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
        {actionButton("archive")}
        {actionButton("mark_read")}
        <Tooltip.Anchor content={messages().assign}>
          <IconButton
            type="button"
            label={messages().actionOnSelected({ action: messages().assign, count: props.selectedCount })}
            disabled={props.busy}
            onClick={() => void props.onAssign()}
          >
            <i class="ti ti-user-plus" aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
        {actionButton("move")}
        <Dropdown.Root
          position="bottom-left"
          width="16rem"
          items={(["mark_unread", "flag", "unflag", props.selectedInJunk ? "not_spam" : "junk", "trash"] as const).map(menuAction)}
        >
          <Dropdown.Trigger iconOnly type="button" variant="ghost" label={messages().moreSelectedActions} disabled={props.busy}>
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
      <Tooltip.Anchor content={messages().exitSelection}>
        <IconButton type="button" label={messages().exitSelection} disabled={props.busy} onClick={props.onClear}>
          <i class="ti ti-x" aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
    </div>
  );
}
