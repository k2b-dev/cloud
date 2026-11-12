import { type DateContext, dates } from "@k2b/stdlib";
import { AvatarFaces, ContextMenu, Dropdown, type DropdownItem, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { DraftFolderItem } from "../../contracts";
import { mailConversationMenuItems } from "./mail-conversation-menu";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

/** Who receives the draft, in the order the composer lists them: To, then Cc, then Bcc. */
const draftRecipientLabels = (item: Pick<DraftFolderItem, "to" | "cc" | "bcc">): string[] =>
  [...item.to, ...item.cc, ...item.bcc].map((recipient) => recipient.name || recipient.address);

/**
 * One draft of the Drafts folder, drawn as a conversation row: the recipients stand where the sender does, "Draft"
 * follows them in the draft colour, and preview, marks and time keep their places; who started the draft stands among
 * the marks. Like a conversation row, the list's width decides between one line and three.
 */
export default function MailDraftRow(props: {
  item: DraftFolderItem;
  /** The composer for this draft; absent for readers, who see the draft without opening it. */
  href: string | null;
  dateConfig: DateContext;
  /** The delete request runs; the row stays until it succeeds. */
  pending?: boolean;
  leaving?: boolean;
  /** Absent for readers, who may not delete drafts. */
  onDelete?: (item: DraftFolderItem) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const recipients = createMemo(() => draftRecipientLabels(props.item));
  const primaryRecipient = () => recipients()[0] ?? t().noRecipients;
  const additionalRecipients = () => Math.max(0, recipients().length - 1);
  const subject = () => props.item.subject || t().noSubject;
  const startedBy = () => t().draftStartedBy({ name: props.item.createdByDisplayName });
  const attachmentLabel = () => t().attachmentCount({ count: props.item.attachmentCount });
  const [menuOpen, setMenuOpen] = createSignal(false);
  let entry: HTMLDivElement | undefined;
  // The collapse starts from the row's own height, as for a conversation that leaves the list.
  createEffect(() => {
    if (props.leaving && entry) entry.style.setProperty("--mail-row-height", `${entry.offsetHeight}px`);
  });

  const remove = () => {
    if (!props.pending && !props.leaving) props.onDelete?.(props.item);
  };
  const menuItems = (): DropdownItem[] =>
    props.href && props.onDelete
      ? mailConversationMenuItems({ t: t(), draft: { href: props.href, discard: { disabled: props.pending, run: remove } } })
      : [];
  const content = () => (
    <>
      <span class="mail-row-from">
        <span class="mail-row-sender">{primaryRecipient()}</span>
        <Show when={additionalRecipients() > 0}>
          <Tooltip.Anchor content={recipients().join(", ")}>
            <span
              class="mail-row-more"
              role="img"
              aria-label={t().additionalCorrespondents({ count: additionalRecipients(), names: recipients().slice(1).join(", ") })}
            >
              +{additionalRecipients()}
            </span>
          </Tooltip.Anchor>
        </Show>
        <span class="mail-row-draft">{t().draftTag}</span>
      </span>
      <span class="mail-row-subject-line">
        <span class="mail-row-subject">{subject()}</span>
      </span>
      <span class="mail-list-preview">{props.item.bodyPreview || "\u00a0"}</span>
      <span class="mail-row-marks">
        <Show when={props.item.attachmentCount > 0}>
          <Tooltip.Anchor content={attachmentLabel()}>
            <span class="mail-row-mark" role="img" aria-label={attachmentLabel()}>
              <i class="ti ti-paperclip" aria-hidden="true" />
            </span>
          </Tooltip.Anchor>
        </Show>
        <Tooltip.Anchor content={startedBy()}>
          <span class="mail-row-assignee" role="img" aria-label={startedBy()}>
            <AvatarFaces people={[{ name: props.item.createdByDisplayName }]} max={1} />
          </span>
        </Tooltip.Anchor>
      </span>
      <span class="mail-row-time-cell">
        <span class="mail-row-dot" aria-hidden="true" />
        <time
          class="mail-list-time mail-row-time"
          dateTime={props.item.updatedAt}
          title={dates.formatDateTime(props.item.updatedAt, props.dateConfig)}
        >
          {dates.formatDateTimeRelative(props.item.updatedAt, props.dateConfig)}
        </time>
      </span>
    </>
  );
  const rowBody = () => (
    <>
      <Show when={props.href} fallback={<div class="mail-list-row">{content()}</div>}>
        {(href) => (
          <a
            href={href()}
            class="mail-list-row focus-ui"
            title={`${recipients().join(", ") || t().noRecipients}: ${subject()}`}
            aria-keyshortcuts={props.onDelete ? "Delete" : undefined}
            on:keydown={(event) => {
              if (event.key !== "Delete" && event.key !== "Backspace") return;
              if (event.defaultPrevented || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
              if (!props.onDelete) return;
              event.preventDefault();
              remove();
            }}
          >
            {content()}
          </a>
        )}
      </Show>
      <Show when={props.href && props.onDelete}>
        <div class="k2b-progressive-action mail-row-menu">
          <Dropdown.Root lazy position="bottom-left" width="16rem" items={menuItems()}>
            <Dropdown.Trigger iconOnly size="sm" type="button" variant="ghost" label={t().actionsFor({ name: subject() })}>
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </Show>
    </>
  );

  return (
    <div
      ref={entry}
      data-leaving={props.leaving ? "true" : undefined}
      inert={props.leaving}
      aria-hidden={props.leaving ? "true" : undefined}
      aria-busy={props.pending ? "true" : undefined}
      class="mail-list-entry k2b-progressive-row relative"
      classList={{ "mail-list-entry-pending": Boolean(props.pending) }}
      role="listitem"
      data-draft-id={props.item.id}
    >
      <span class="mail-row-check" aria-hidden="true" />
      {/* As on a conversation row, a right-click, the context-menu key or Shift+F10 opens the "…" menu. */}
      <Show when={props.href && props.onDelete} fallback={rowBody()}>
        <ContextMenu
          class="contents"
          tabIndex={-1}
          items={menuOpen() ? menuItems() : []}
          label={t().actionsFor({ name: subject() })}
          onOpen={() => setMenuOpen(true)}
          onClose={() => setMenuOpen(false)}
        >
          {rowBody()}
        </ContextMenu>
      </Show>
    </div>
  );
}
