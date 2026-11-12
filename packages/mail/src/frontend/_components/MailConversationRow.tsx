import { type DateContext, dates } from "@k2b/stdlib";
import { AvatarFaces, ContextMenu, Dropdown, type DropdownItem, type HoverPreviewController, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { MailActionId } from "./mail-actions";
import { useMailCloudId } from "./mail-cloud-id";
import { type MailRespondIntent, mailConversationMenuItems } from "./mail-conversation-menu";
import { MAX_MAIL_CONVERSATION_SELECTION } from "./mail-conversation-selection";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { buildMailAttachmentDownloadHref, buildMailSelectionHref, isMailListItemActive, type MailListItem } from "./mail-navigation";
import { type MailRowAssignee, mailRowAssigneeLabels } from "./mail-row-assignees";

/**
 * The account behind the conversation's single untouched suggestion, which shows in plum until a person takes it
 * over; null for every other draft. A pod from before `suggestedBy` only lists editors, so its rows fall back to them.
 */
export const mailRowSuggestedBy = (drafts: MailListItem["drafts"]): string | null => {
  if (drafts.count !== 1) return null;
  if (drafts.suggestedBy !== undefined) return drafts.suggestedBy;
  return drafts.editors.length > 0 && drafts.editors.every((editor) => editor.kind === "service_account")
    ? drafts.editors[0]!.displayName
    : null;
};

/** Six days ahead or less the snooze names its weekday ("Thu"), later its date. */
export const mailRowSnoozeDay = (until: string, now: Date, locale: string, timeZone?: string): string => {
  const date = new Date(until);
  const soon = date.getTime() - now.getTime() < 6 * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat(locale, soon ? { weekday: "short", timeZone } : { day: "2-digit", month: "2-digit", timeZone }).format(
    date,
  );
};

type MailConversationRowState = {
  selectedConversationId: string | null;
  selectedMessageId: string | null;
  selectedConversationIds: ReadonlySet<string>;
  selectionMode: boolean;
  canWrite: boolean;
  spamAction: "junk" | "not_spam";
  dateConfig: DateContext;
  currentUserId: string | null;
};

type MailConversationRowActions = {
  navigate: (href: string, item: MailListItem, activation: "keyboard" | "pointer") => void | Promise<void>;
  toggleSelection: (item: MailListItem, range: boolean) => void;
  itemAction: (item: MailListItem, actionId: MailActionId) => void | Promise<void>;
  manageTags: (item: MailListItem) => void | Promise<void>;
  /** Absent for a person who sees only assigned conversations. */
  merge?: (item: MailListItem) => void | Promise<void>;
  /** Opens the conversation and answers its latest message there or in a window of its own. */
  respond: (item: MailListItem, intent: MailRespondIntent, options: { window: boolean }) => void;
  /** Absent where nobody can be assigned, as in a personal mailbox. */
  assignToMe?: (item: MailListItem) => void;
  assigneeNames: (userIds: readonly string[]) => string[];
  setCompletion: (item: MailListItem, completion: "done" | "open") => void;
};

/** The list's quick look card; rows anchor it and report mouse rests, with the row and the pointer, and leaves for its request. */
type MailConversationRowQuickLook = Pick<HoverPreviewController<string>, "id" | "anchor" | "active"> & {
  begin: () => void;
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
  /** Who is responsible, in a mailbox where more than one person can be; null where nobody is assigned. */
  assignees?: MailRowAssignee[] | null;
}) {
  // JSX object props are getters: share their derived context across field reads.
  const state = createMemo(() => props.state);
  // A selection or a new controller must not rebuild an unchanged action menu.
  const spamAction = createMemo(() => state().spamAction);
  const canMerge = createMemo(() => Boolean(props.actions.merge));
  const canWrite = createMemo(() => state().canWrite);
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const correspondentLabels = (item: MailListItem): string[] =>
    item.participantLabels.length > 0 ? item.participantLabels : [item.participantSummary || t().unknownSender];
  const selected = () => isMailListItemActive(props.item, state().selectedConversationId, state().selectedMessageId);
  const correspondents = () => correspondentLabels(props.item);
  const primaryCorrespondent = () => correspondents()[0] ?? t().unknownSender;
  const tagLabel = () => props.item.localTags.map((tag) => tag.name).join(", ");
  const bulkSelected = () => Boolean(props.item.conversationId && state().selectedConversationIds.has(props.item.conversationId));
  const attachmentDownloadHref = () => buildMailAttachmentDownloadHref(props.requestUrl, props.item);
  const attachmentLabel = () => t().attachmentCount({ count: props.item.attachmentCount ?? 0 });
  const suggestedBy = () => mailRowSuggestedBy(props.item.drafts);
  const draftLabel = () => {
    const by = suggestedBy();
    if (by !== null) return t().suggestionFrom({ name: by });
    const names = props.item.drafts.editors.map((editor) => editor.displayName).join(", ");
    const label = props.item.drafts.count === 1 ? t().draftOne : t().draftMany({ count: props.item.drafts.count });
    return names ? `${label}: ${names}` : label;
  };
  const assigneeLabels = () => mailRowAssigneeLabels(props.assignees ?? [], state().currentUserId, t().you);
  const assigneeLabel = () =>
    t().responsibleNames({
      names: assigneeLabels()
        .map((assignee) => assignee.name)
        .join(", "),
    });
  const snoozeDay = () =>
    props.item.snoozedUntil && Date.parse(props.item.snoozedUntil) > Date.now()
      ? mailRowSnoozeDay(props.item.snoozedUntil, new Date(), locale(), state().dateConfig.timeZone)
      : null;
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [dropdownOpen, setDropdownOpen] = createSignal(false);
  // While the "…" or right-click menu is open, the row keeps its hover tone and drops its tooltip, which would cover it.
  const menuShown = () => menuOpen() || dropdownOpen();
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

  const cloudId = useMailCloudId();
  // The row's "…" and right-click menus are the reader's menu for this conversation.
  const menuItems = (): DropdownItem[] => {
    const item = props.item;
    const currentUserId = state().currentUserId;
    const assignToMe = props.actions.assignToMe;
    return mailConversationMenuItems({
      t: t(),
      ...(canWrite()
        ? {
            respond: { replyAll: false, run: (intent, options) => props.actions.respond(item, intent, options) },
            ...(assignToMe && currentUserId
              ? {
                  assignToMe: {
                    assigned: item.assigneeUserIds.includes(currentUserId),
                    others: props.actions.assigneeNames(item.assigneeUserIds.filter((userId) => userId !== currentUserId)),
                    run: () => assignToMe(item),
                  },
                }
              : {}),
            ...(item.workStatus
              ? {
                  completion: {
                    done: item.workStatus === "done",
                    run: () => props.actions.setCompletion(item, item.workStatus === "done" ? "open" : "done"),
                  },
                }
              : {}),
            organize: {
              unread: item.unread,
              flagged: item.flagged,
              spamAction: spamAction(),
              kept: item.kept,
              run: (actionId: MailActionId) => props.actions.itemAction(item, actionId),
              manageTags: () => props.actions.manageTags(item),
            },
            ...(canMerge()
              ? { conversation: [{ label: t().mergeWithConversation, icon: "ti ti-git-merge", action: () => props.actions.merge?.(item) }] }
              : {}),
          }
        : {}),
      other: cloudId.actions({ conversationId: item.conversationId }),
    });
  };
  const time = () => (
    <span class="mail-row-time-cell">
      <span class="mail-row-dot" aria-hidden="true" />
      <time
        class="mail-list-time mail-row-time"
        dateTime={props.item.latestMessageAt}
        title={dates.formatDateTime(props.item.latestMessageAt, state().dateConfig)}
      >
        {dates.formatDateTimeRelative(props.item.latestMessageAt, state().dateConfig)}
      </time>
    </span>
  );
  // One row for both densities: the list's own width decides in CSS whether these parts stand in one line or three,
  // so a resize changes no markup, keeps focus and selection, and the server's first frame is already final.
  const rowBody = () => (
    <>
      <a
        ref={link}
        href={buildMailSelectionHref(props.requestUrl, props.item)}
        aria-current={selected() ? "page" : undefined}
        aria-controls={quickLook?.id}
        aria-expanded={quickLook ? peeking() : undefined}
        aria-keyshortcuts={quickLook ? "Space" : undefined}
        class="mail-list-row focus-ui"
        // The open card already names sender and subject; a native tooltip would cover the row.
        title={peeking() || menuShown() ? undefined : `${correspondents().join(", ")}: ${props.item.subject || t().noSubject}`}
        draggable={state().canWrite && Boolean(props.item.conversationId && props.item.activeFolderIds.length > 0)}
        on:keydown={(event) => {
          // Runs on the link before the shared row anchor handles Space. Reopening
          // explicitly may retry a syncing/error answer even while the mouse stays here.
          if (
            event.key === " " &&
            !event.defaultPrevented &&
            !event.repeat &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !peeking()
          )
            quickLook?.begin();
        }}
        onClick={(event) => {
          activation = event.detail === 0 ? "keyboard" : "pointer";
          if (event.defaultPrevented || event.button !== 0 || event.altKey) return;
          if (!state().canWrite && (event.shiftKey || event.metaKey || event.ctrlKey)) return;
          const select = Boolean(
            props.item.conversationId && state().canWrite && (state().selectionMode || event.shiftKey || event.metaKey || event.ctrlKey),
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
        <span class="mail-row-from">
          <span class="mail-row-sender">{primaryCorrespondent()}</span>
          <Show when={props.item.selectionKind === "conversation" && props.item.messageCount > 1}>
            <span class="mail-row-count" role="img" aria-label={t().messageCount({ count: props.item.messageCount })}>
              {props.item.messageCount}
            </span>
          </Show>
          <Show when={props.item.drafts.count > 0}>
            <span
              class="mail-row-draft"
              data-suggestion={suggestedBy() !== null ? "" : undefined}
              data-mail-row-draft
              role="img"
              aria-label={draftLabel()}
              title={draftLabel()}
            >
              <Show when={suggestedBy() !== null} fallback={t().draftMark}>
                <i class="ti ti-sparkles" aria-hidden="true" />
                {t().suggestionMark}
              </Show>
            </span>
          </Show>
        </span>
        <span class="mail-row-subject-line">
          <For each={props.item.localTags.slice(0, 1)}>
            {(tag) => (
              <span class="mail-row-tag" style={{ "--mail-tag": tag.color }} title={t().tagNames({ names: tagLabel() })}>
                {tag.name}
              </span>
            )}
          </For>
          <Show when={props.item.primaryReference}>
            <span class="mail-row-reference">{props.item.primaryReference}</span>
          </Show>
          <span class="mail-row-subject">{props.item.subject || t().noSubject}</span>
        </span>
        <Show when={props.item.attachmentMatch} fallback={<span class="mail-list-preview">{props.item.preview || " "}</span>}>
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
        <span class="mail-row-marks" data-clear-download={attachmentDownloadHref() ? "" : undefined}>
          <Show when={props.item.workStatus === "waiting"}>
            <span class="mail-row-waiting">{t().waitingShort}</span>
          </Show>
          <Show when={snoozeDay()}>
            {(day) => (
              <span class="mail-row-snooze" role="img" aria-label={t().snoozedUntilDay({ day: day() })}>
                <i class="ti ti-clock" aria-hidden="true" />
                {t().snoozedUntilDay({ day: day() })}
              </span>
            )}
          </Show>
          <Show when={props.item.attachmentCount}>
            <Tooltip.Anchor content={attachmentLabel()}>
              <span class="mail-row-mark" role="img" aria-label={attachmentLabel()}>
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
          <Show when={assigneeLabels()[0]}>
            {(first) => (
              <Tooltip.Anchor content={assigneeLabel()}>
                <span class="mail-row-assignee" role="img" aria-label={assigneeLabel()} data-mail-assignees>
                  <AvatarFaces
                    people={[{ name: first().name, src: first().src, tone: first().unknown ? "neutral" : undefined }]}
                    max={1}
                    total={assigneeLabels().length}
                  />
                </span>
              </Tooltip.Anchor>
            )}
          </Show>
        </span>
        {time()}
      </a>
      <Show when={attachmentDownloadHref()}>
        {(href) => (
          <a
            class="k2b-progressive-action focus-ui mail-row-download inline-flex h-7 w-7 items-center justify-center rounded-md text-dimmed hover:text-current"
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
      <Show when={!state().selectionMode && props.item.conversationId}>
        <div class="k2b-progressive-action mail-row-menu">
          <Dropdown.Root lazy position="bottom-left" width="16rem" items={menuItems()} onOpenChange={setDropdownOpen}>
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
    </>
  );

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
      data-flagged={props.item.flagged ? "" : undefined}
      classList={{
        "mail-list-entry-active": selected(),
        "mail-list-entry-unread": props.item.unread,
        "mail-list-entry-selected": bulkSelected(),
        "mail-list-entry-selection-mode": state().selectionMode,
        "mail-list-entry-peek": peeking(),
        "mail-list-entry-menu-open": menuShown(),
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") {
          quickLook?.begin();
          quickLook?.prefetch(props.item, event.currentTarget, event);
        }
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") quickLook?.prefetch(props.item, event.currentTarget, event);
      }}
      onPointerLeave={() => quickLook?.release(props.item)}
      role="listitem"
      data-conversation-id={props.item.conversationId ?? undefined}
      data-message-id={props.item.selectionKind === "message" ? props.item.id : undefined}
    >
      {/* The checkbox always shows, so the first check starts a selection; its column stays for readers too. */}
      <span class="mail-row-check">
        <Show when={state().canWrite && props.item.conversationId}>
          <input
            type="checkbox"
            class="mail-list-checkbox h-4 w-4"
            checked={bulkSelected()}
            disabled={!bulkSelected() && state().selectedConversationIds.size >= MAX_MAIL_CONVERSATION_SELECTION}
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
      </span>
      {/* The star flags the conversation. Wide rows keep it in its own column; three-line rows show it only when set. */}
      <Show
        when={state().canWrite && props.item.conversationId}
        fallback={
          <Show
            when={props.item.flagged}
            fallback={
              <span class="mail-row-star" aria-hidden="true">
                <i class="ti ti-star" />
              </span>
            }
          >
            <span class="mail-row-star" role="img" aria-label={t().flagged}>
              <i class="ti ti-star" aria-hidden="true" />
            </span>
          </Show>
        }
      >
        <button
          type="button"
          class="mail-row-star focus-ui"
          aria-pressed={props.item.flagged}
          aria-label={t().flagNamed({ name: props.item.subject || t().conversation })}
          title={props.item.flagged ? t().unflagConversation : t().flagConversation}
          onClick={(event) => {
            event.stopPropagation();
            void props.actions.itemAction(props.item, props.item.flagged ? "unflag" : "flag");
          }}
        >
          <i class="ti ti-star" aria-hidden="true" />
        </button>
      </Show>
      {/* A right-click on the row, or the context-menu key and Shift+F10 on it, opens its "…" menu. The host draws no
          box of its own and leaves the checkbox out, so it never marks the checkbox or the link unavailable; its entries
          are built only while it is open. */}
      <Show when={props.item.conversationId} fallback={rowBody()}>
        <ContextMenu
          class="contents"
          tabIndex={-1}
          items={menuOpen() ? menuItems() : []}
          label={t().actionsFor({ name: props.item.subject || t().conversation })}
          onOpen={() => setMenuOpen(true)}
          onClose={() => setMenuOpen(false)}
        >
          {rowBody()}
        </ContextMenu>
      </Show>
    </div>
  );
}
