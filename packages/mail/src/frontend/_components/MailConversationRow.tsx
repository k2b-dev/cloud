import { type DateContext, dates } from "@k2b/stdlib";
import { Dropdown, type HoverPreviewController, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, For, Show } from "solid-js";
import { getMailAction, type MailActionId } from "./mail-actions";
import { MAX_MAIL_CONVERSATION_SELECTION } from "./mail-conversation-selection";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { buildMailAttachmentDownloadHref, buildMailSelectionHref, isMailListItemActive, type MailListItem } from "./mail-navigation";

/** Tags shown as pills on a row's fourth line; the rest are counted. */
const MAX_ROW_TAGS = 3;

/** A row has a fourth line only for its tags or for "Waiting"; every other row has the same three-line height. */
export const mailRowHasFourthLine = (item: Pick<MailListItem, "localTags" | "workStatus">): boolean =>
  item.localTags.length > 0 || item.workStatus === "waiting";

type MailConversationRowState = {
  selectedConversationId: string | null;
  selectedMessageId: string | null;
  selectedConversationIds: ReadonlySet<string>;
  selectionMode: boolean;
  canWrite: boolean;
  spamAction: "junk" | "not_spam";
  dateConfig: DateContext;
};

type MailConversationRowActions = {
  navigate: (href: string, item: MailListItem, activation: "keyboard" | "pointer") => void | Promise<void>;
  toggleSelection: (item: MailListItem, range: boolean) => void;
  itemAction: (item: MailListItem, actionId: MailActionId) => void | Promise<void>;
  manageTags: (item: MailListItem) => void | Promise<void>;
  /** Absent for a person who sees only assigned conversations. */
  merge?: (item: MailListItem) => void | Promise<void>;
};

/** The list's quick look card; rows anchor it and report mouse rests, with the row and the pointer, and leaves for its request. */
type MailConversationRowQuickLook = Pick<HoverPreviewController<string>, "id" | "anchor" | "active"> & {
  prefetch: (item: MailListItem, row: HTMLElement, pointer: PointerEvent) => void;
  release: (item: MailListItem) => void;
};

export default function MailConversationRow(props: {
  item: MailListItem;
  leaving?: boolean;
  requestUrl: URL;
  state: MailConversationRowState;
  actions: MailConversationRowActions;
  quickLook?: MailConversationRowQuickLook;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const actionLabel = (actionId: MailActionId): string => {
    if (actionId === "mark_read") return t().markRead;
    if (actionId === "mark_unread") return t().markUnread;
    if (actionId === "flag") return t().flag;
    if (actionId === "unflag") return t().unflag;
    if (actionId === "archive") return t().archive;
    if (actionId === "move") return t().moveToFolder;
    if (actionId === "not_spam") return t().notSpam;
    if (actionId === "junk") return t().junk;
    return t().trash;
  };
  const correspondentLabels = (item: MailListItem): string[] =>
    item.participantLabels.length > 0 ? item.participantLabels : [item.participantSummary || t().unknownSender];
  const selected = () => isMailListItemActive(props.item, props.state.selectedConversationId, props.state.selectedMessageId);
  const fourthLine = () => mailRowHasFourthLine(props.item);
  const correspondents = () => correspondentLabels(props.item);
  const primaryCorrespondent = () => correspondents()[0] ?? t().unknownSender;
  const additionalCorrespondents = () => Math.max(0, correspondents().length - 1);
  const tagLabel = () => props.item.localTags.map((tag) => tag.name).join(", ");
  const bulkSelected = () => Boolean(props.item.conversationId && props.state.selectedConversationIds.has(props.item.conversationId));
  const attachmentDownloadHref = () => buildMailAttachmentDownloadHref(props.requestUrl, props.item);
  let activation: "keyboard" | "pointer" = "keyboard";
  let selectRange = false;
  let link: HTMLAnchorElement | undefined;
  // Message rows of the message view have no conversation quick look.
  const quickLookId = props.item.selectionKind === "conversation" ? props.item.conversationId : null;
  const quickLook = quickLookId ? props.quickLook : undefined;
  const peeking = () => Boolean(quickLook && quickLook.active() === quickLookId);
  let entry: HTMLDivElement | undefined;
  // The collapse starts from the row's own height; a fixed value would make taller rows jump first.
  createEffect(() => {
    if (props.leaving && entry) entry.style.setProperty("--mail-row-height", `${entry.offsetHeight}px`);
  });

  return (
    <div
      ref={(element) => {
        entry = element;
        if (quickLook && quickLookId) quickLook.anchor(quickLookId, () => link)(element);
      }}
      data-leaving={props.leaving ? "true" : undefined}
      inert={props.leaving}
      aria-hidden={props.leaving ? "true" : undefined}
      class="mail-list-entry k2b-progressive-row relative"
      data-lines={fourthLine() ? "4" : "3"}
      classList={{
        "mail-list-entry-active": selected(),
        "mail-list-entry-unread": props.item.unread,
        "mail-list-entry-selected": bulkSelected(),
        "mail-list-entry-selection-mode": props.state.selectionMode,
        "mail-list-entry-peek": peeking(),
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") quickLook?.prefetch(props.item, event.currentTarget, event);
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") quickLook?.prefetch(props.item, event.currentTarget, event);
      }}
      onPointerLeave={() => quickLook?.release(props.item)}
      role="listitem"
      data-conversation-id={props.item.conversationId ?? undefined}
      data-message-id={props.item.selectionKind === "message" ? props.item.id : undefined}
    >
      <Show when={props.state.canWrite && props.state.selectionMode && props.item.conversationId}>
        <input
          type="checkbox"
          class="mail-list-checkbox h-4 w-4"
          checked={bulkSelected()}
          disabled={!bulkSelected() && props.state.selectedConversationIds.size >= MAX_MAIL_CONVERSATION_SELECTION}
          aria-label={(bulkSelected() ? t().deselectNamed : t().selectNamed)({ name: props.item.subject || t().conversation })}
          onClick={(event) => {
            event.stopPropagation();
            selectRange = event.shiftKey;
          }}
          onChange={() => {
            props.actions.toggleSelection(props.item, selectRange);
            selectRange = false;
          }}
        />
      </Show>
      <a
        ref={link}
        href={buildMailSelectionHref(props.requestUrl, props.item)}
        aria-current={selected() ? "page" : undefined}
        aria-controls={quickLook?.id}
        aria-expanded={quickLook ? peeking() : undefined}
        aria-keyshortcuts={quickLook ? "Space" : undefined}
        class="mail-list-row focus-ui"
        // The open card already names sender and subject; a native tooltip would cover the row.
        title={peeking() ? undefined : `${correspondents().join(", ")}: ${props.item.subject || t().noSubject}`}
        draggable={props.state.canWrite && Boolean(props.item.conversationId && props.item.activeFolderIds.length > 0)}
        onClick={(event) => {
          activation = event.detail === 0 ? "keyboard" : "pointer";
          if (event.defaultPrevented || event.button !== 0 || event.altKey) return;
          if (!props.state.canWrite && (event.shiftKey || event.metaKey || event.ctrlKey)) return;
          const select = Boolean(
            props.item.conversationId &&
              props.state.canWrite &&
              (props.state.selectionMode || event.shiftKey || event.metaKey || event.ctrlKey),
          );
          event.preventDefault();
          if (select) props.actions.toggleSelection(props.item, event.shiftKey);
          else void props.actions.navigate(event.currentTarget.href, props.item, activation);
        }}
        onDragStart={(event) => {
          const transfer = event.dataTransfer;
          if (!props.item.conversationId || props.item.activeFolderIds.length === 0 || !transfer) return event.preventDefault();
          transfer.effectAllowed = "move";
          // The drop resolves this row's source folders the same way the Move action does.
          transfer.setData("application/x-cloud-mail-conversation", JSON.stringify({ itemId: props.item.id }));
        }}
      >
        <span class="sr-only">
          {props.item.unread ? `${t().unreadItem({ kind: props.item.selectionKind === "message" ? t().message : t().conversation })} ` : ""}
          {!props.item.unread ? `${t().readItem({ kind: props.item.selectionKind === "message" ? t().message : t().conversation })} ` : ""}
          {props.item.flagged
            ? `${t().flaggedItem({ kind: props.item.selectionKind === "message" ? t().message : t().conversation })} `
            : ""}
        </span>
        <span class="mail-row-dot" aria-hidden="true" />
        <span class="mail-row-lines">
          <span class="mail-row-from">
            <span class="mail-row-sender">{primaryCorrespondent()}</span>
            <Show when={additionalCorrespondents() > 0}>
              <Tooltip.Anchor content={correspondents().join(", ")}>
                <span
                  class="mail-row-more"
                  role="img"
                  aria-label={t().additionalCorrespondents({
                    count: additionalCorrespondents(),
                    names: correspondents().slice(1).join(", "),
                  })}
                >
                  +{additionalCorrespondents()}
                </span>
              </Tooltip.Anchor>
            </Show>
            <time
              class="mail-list-time mail-row-time"
              dateTime={props.item.latestMessageAt}
              title={dates.formatDateTime(props.item.latestMessageAt, props.state.dateConfig)}
            >
              {dates.formatDateTimeRelative(props.item.latestMessageAt, props.state.dateConfig)}
            </time>
          </span>
          <span class="mail-row-subject-line">
            <Show when={props.item.primaryReference}>
              <span class="mail-row-reference">{props.item.primaryReference}</span>
            </Show>
            <span class="mail-row-subject">{props.item.subject || t().noSubject}</span>
            <Show when={props.item.selectionKind === "conversation" && props.item.messageCount > 1}>
              <span class="mail-row-count" role="img" aria-label={t().messageCount({ count: props.item.messageCount })}>
                {props.item.messageCount}
              </span>
            </Show>
            <span class="mail-row-marks">
              <Show when={props.item.hasAttachments}>
                <Tooltip.Anchor content={t().hasAttachments}>
                  <span class="mail-row-mark" role="img" aria-label={t().hasAttachments}>
                    <i class="ti ti-paperclip" aria-hidden="true" />
                  </span>
                </Tooltip.Anchor>
              </Show>
              <Show when={props.item.kept}>
                <Tooltip.Anchor content={t().kept}>
                  <span class="mail-row-mark" role="img" aria-label={t().keptConversation} data-mail-kept-indicator>
                    <i class="ti ti-lock" aria-hidden="true" />
                  </span>
                </Tooltip.Anchor>
              </Show>
              <Show when={props.item.flagged}>
                <Tooltip.Anchor content={t().flagged}>
                  <span class="mail-row-mark mail-row-flag" role="img" aria-label={t().flaggedConversation}>
                    <i class={getMailAction("flag").icon} aria-hidden="true" />
                  </span>
                </Tooltip.Anchor>
              </Show>
              <Show when={props.item.assigneeUserIds.length > 0}>
                <Tooltip.Anchor content={t().assigned}>
                  <span class="mail-row-mark" role="img" aria-label={t().status({ value: t().assigned })}>
                    <i class="ti ti-user-check" aria-hidden="true" />
                  </span>
                </Tooltip.Anchor>
              </Show>
            </span>
          </span>
          <Show when={props.item.attachmentMatch} fallback={<span class="mail-list-preview">{props.item.preview || "\u00a0"}</span>}>
            {(match) => (
              <span
                class="mail-list-preview mail-row-match"
                title={t().matchedAttachmentTitle({ name: match().filename ?? t().untitledAttachment })}
              >
                <i class="ti ti-paperclip" aria-hidden="true" />
                <span class="mail-row-match-text">
                  {t().matchedAttachment({ name: match().filename?.trim() || t().attachment, snippet: match().snippet })}
                </span>
              </span>
            )}
          </Show>
          <Show when={fourthLine()}>
            <span class="mail-row-extra">
              <Show when={props.item.localTags.length > 0}>
                {/* Long tag names shorten; the group's tooltip keeps every full name. */}
                <Tooltip.Anchor class="mail-row-tags" content={t().tagNames({ names: tagLabel() })}>
                  <For each={props.item.localTags.slice(0, MAX_ROW_TAGS)}>
                    {(tag) => (
                      <span class="mail-row-tag" style={{ "--mail-tag": tag.color }}>
                        {tag.name}
                      </span>
                    )}
                  </For>
                </Tooltip.Anchor>
              </Show>
              <Show when={props.item.localTags.length > MAX_ROW_TAGS}>
                <Tooltip.Anchor content={t().tagNames({ names: tagLabel() })}>
                  <span class="mail-row-tag-more" role="img" aria-label={t().tagNames({ names: tagLabel() })}>
                    +{props.item.localTags.length - MAX_ROW_TAGS}
                  </span>
                </Tooltip.Anchor>
              </Show>
              <Show when={props.item.workStatus === "waiting"}>
                <span class="mail-row-waiting">
                  <i class="ti ti-hourglass" aria-hidden="true" />
                  {t().waitingShort}
                </span>
              </Show>
            </span>
          </Show>
        </span>
      </a>
      <Show when={attachmentDownloadHref()}>
        {(href) => (
          <a
            class="k2b-progressive-action focus-ui absolute bottom-1.5 right-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-dimmed hover:text-current"
            href={href()}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t().downloadMatched({ name: props.item.attachmentMatch?.filename?.trim() || t().attachment })}
            title={t().downloadMatchedAttachment}
            onClick={(event) => event.stopPropagation()}
          >
            <i class="ti ti-download" aria-hidden="true" />
            <span class="sr-only">{t().downloadMatched({ name: props.item.attachmentMatch?.filename?.trim() || t().attachment })}</span>
          </a>
        )}
      </Show>
      <Show when={props.state.canWrite && !props.state.selectionMode && props.item.conversationId}>
        <div class="k2b-progressive-action absolute right-3 top-2 z-10">
          <Dropdown.Root
            position="bottom-left"
            width="13rem"
            items={[
              {
                label: actionLabel(props.item.unread ? "mark_read" : "mark_unread"),
                icon: getMailAction(props.item.unread ? "mark_read" : "mark_unread").icon,
                action: () => props.actions.itemAction(props.item, props.item.unread ? "mark_read" : "mark_unread"),
              },
              {
                label: actionLabel(props.item.flagged ? "unflag" : "flag"),
                icon: getMailAction(props.item.flagged ? "unflag" : "flag").icon,
                action: () => props.actions.itemAction(props.item, props.item.flagged ? "unflag" : "flag"),
              },
              {
                label: t().manageTags,
                icon: "ti ti-tags",
                action: () => props.actions.manageTags(props.item),
              },
              ...(["archive", "move", props.state.spamAction, "trash"] as const).map((actionId) => {
                // Cloud refuses to delete a kept conversation or move it to Junk; the menu says why.
                const blocked = props.item.kept
                  ? actionId === "trash"
                    ? t().keptCannotDelete
                    : actionId === "junk"
                      ? t().keptCannotJunk
                      : null
                  : null;
                return blocked
                  ? { label: actionLabel(actionId), icon: getMailAction(actionId).icon, description: blocked, disabled: true as const }
                  : {
                      label: actionLabel(actionId),
                      icon: getMailAction(actionId).icon,
                      action: () => props.actions.itemAction(props.item, actionId),
                    };
              }),
              ...(props.actions.merge
                ? [
                    {
                      label: t().mergeWithConversation,
                      icon: "ti ti-git-merge",
                      action: () => props.actions.merge?.(props.item),
                    },
                  ]
                : []),
            ]}
          >
            <Dropdown.Trigger
              iconOnly
              size="sm"
              type="button"
              variant="ghost"
              label={t().actionsFor({ name: props.item.subject || t().conversation })}
            >
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </Show>
    </div>
  );
}
