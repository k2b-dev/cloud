import { Dropdown, IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { getMailAction, type MailActionId } from "./mail-actions";
import { mailRemainingMessages } from "./mail-remaining-messages";

const primaryActions: readonly MailActionId[] = ["archive", "mark_read", "flag", "move", "trash"];
export default function MailBulkActionBar(props: {
  selectedCount: number;
  selectedInJunk: boolean;
  busy: boolean;
  onClear: () => void;
  onAddTags: () => void | Promise<void>;
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
        {primaryActions.map((actionId) => {
          const action = getMailAction(actionId);
          const label = actionLabel(actionId);
          return (
            <Tooltip.Anchor content={label}>
              <IconButton
                type="button"
                label={messages().actionOnSelected({ action: label, count: props.selectedCount })}
                disabled={props.busy}
                onClick={() => void props.onAction(actionId)}
              >
                <i class={action.icon} aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          );
        })}
        <Dropdown.Root
          position="bottom-left"
          width="14rem"
          items={[
            ...(["mark_unread", "unflag", props.selectedInJunk ? "not_spam" : "junk"] as const).map((actionId) => {
              const action = getMailAction(actionId);
              return {
                label: actionLabel(actionId),
                icon: action.icon,
                action: () => props.onAction(actionId),
              };
            }),
          ]}
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
