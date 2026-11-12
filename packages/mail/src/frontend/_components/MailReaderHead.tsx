import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import {
  Avatar,
  Button,
  Dropdown,
  type DropdownAction,
  type DropdownItem,
  IconButton,
  IconButtonLink,
  MovedHint,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { MailCollaborator } from "../../service/collaboration";
import type { ConversationKeep } from "../../service/conversation-keeps";
import type { LocalTag } from "../../service/local-tags";
import type { ConversationPresenceParticipant } from "../../service/presence";
import { getMailAction } from "./mail-actions";
import type { MailLinkedItem } from "./mail-conversation-links";
import { mailReaderMessages } from "./mail-reader-messages";

// Local on purpose: `@k2b/cloud/account/ui` would pull Zod into the mailbox's first load (mailbox-first-load.test.ts).
export const cloudAvatarSource = (userId: string | null | undefined, avatarHash: string | null | undefined): string | undefined =>
  userId && avatarHash ? `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}` : undefined;

/** One chip of the row under the subject: a state, a tag, or the linked items. */
type HeadChip = {
  id: string;
  label: string;
  icon?: string;
  /** A tag's own color as its dot. */
  color?: string;
  ariaLabel?: string;
  title?: string;
  kind: "state" | "tag" | "linked";
  /** A click changes the value: one action, or a small menu of choices. */
  action?: () => void;
  menu?: () => DropdownItem[];
};

export type MailReaderHint = "toolbar-moved" | "reader-head-moved";

/**
 * The head of an open conversation (Mail v5): close, the subject on one line, the five fixed actions and "…", and a
 * row of chips with the conversation's state, tags, and links. Every action also stays in "…", so a narrow head
 * hides actions without losing them.
 */
export default function MailReaderHead(props: {
  subject: string;
  noSubject: string;
  flagged: boolean;
  flaggedLabel: string;
  closeHref: string;
  onClose: (event: LinkNavigateEvent) => void | Promise<void>;
  canWrite: boolean;
  dateConfig: DateContext;
  /** Null for a conversation without a status, such as a single message. */
  workStatus: "needs_action" | "waiting" | "done" | null;
  completionPending: boolean;
  onToggleCompletion: () => void;
  actionPending: boolean;
  /** Why Cloud refuses Delete for a kept conversation; null when it allows it. */
  deleteBlocked: string | null;
  onArchive: () => void;
  onDelete: () => void;
  snoozedUntil: string | null;
  reminderDueAt: string | null;
  /** Null where nobody can be assigned. */
  assignees: MailCollaborator[] | null;
  onAssign: () => void;
  keep: ConversationKeep | null;
  /** Who kept the conversation and since when, and who may stop keeping it. */
  keptTitle: string | null;
  /** Stops keeping; only for a Cloud administrator. */
  onStopKeeping: (() => void) | null;
  tags: readonly LocalTag[];
  onManageTags: (() => void) | null;
  linked: { items: readonly MailLinkedItem[]; state: "loading" | "error" | "ready"; retry: () => void; enabled: boolean };
  senderLabel: string;
  messageCount: number;
  presence: readonly ConversationPresenceParticipant[];
  currentUserId?: string;
  /** The "Later" menu: show later, show now, and the personal reminder. */
  laterItems: () => DropdownItem[];
  menuItems: () => DropdownItem[];
  menuLabel: string;
  /** The one-time hint this head shows, if any; the owner decides it from what the person has seen. */
  hint: MailReaderHint | null;
  onHintSeen: (hint: MailReaderHint) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailReaderMessages.resolve([locale()]).t);
  const [moreTrigger, setMoreTrigger] = createSignal<HTMLElement>();
  const [chipRow, setChipRow] = createSignal<HTMLElement>();

  const formatWhen = (iso: string) => dates.formatDateTimeRelative(iso, props.dateConfig);
  const snoozed = () => {
    const until = props.snoozedUntil;
    return until && Date.parse(until) > Date.now() ? until : null;
  };

  const chips = createMemo<HeadChip[]>(() => {
    const list: HeadChip[] = [];
    if (props.workStatus === "waiting")
      list.push({
        id: "waiting",
        kind: "state",
        label: t().waiting,
        icon: "ti ti-hourglass",
        action: props.canWrite && !props.completionPending ? props.onToggleCompletion : undefined,
        title: props.canWrite ? t().done : undefined,
      });
    const until = snoozed();
    if (until)
      list.push({
        id: "later",
        kind: "state",
        label: t().laterUntil({ date: formatWhen(until) }),
        icon: "ti ti-clock",
        menu: props.canWrite ? props.laterItems : undefined,
      });
    if (props.reminderDueAt)
      list.push({
        id: "reminder",
        kind: "state",
        label: t().reminderAt({ date: formatWhen(props.reminderDueAt) }),
        icon: "ti ti-bell",
        title: t().reminderOnlyForYou,
        menu: props.laterItems,
      });
    if (props.keep)
      list.push({
        id: "kept",
        kind: "state",
        label: t().kept,
        icon: "ti ti-lock",
        title: props.keptTitle ?? undefined,
        action: props.onStopKeeping ?? undefined,
      });
    if (!props.canWrite) list.push({ id: "read-only", kind: "state", label: t().readOnly, icon: "ti ti-eye", title: t().readOnlyReason });
    for (const tag of props.tags)
      list.push({
        id: `tag:${tag.id}`,
        kind: "tag",
        label: tag.name,
        color: tag.color,
        ariaLabel: props.onManageTags ? t().tagChipLabel({ name: tag.name }) : undefined,
        action: props.onManageTags ?? undefined,
      });
    if (props.linked.enabled) {
      if (props.linked.state === "error")
        list.push({ id: "linked", kind: "linked", label: t().linkedUnavailable, icon: "ti ti-link-off", action: props.linked.retry });
      else if (props.linked.items.length > 0)
        list.push({
          id: "linked",
          kind: "linked",
          label: t().linkedCount({ count: props.linked.items.length }),
          icon: "ti ti-link",
          menu: () =>
            props.linked.items.map((item) => ({
              label: item.title,
              icon: item.icon,
              description: item.detail,
              href: item.href,
              external: true,
            })),
        });
    }
    return list;
  });

  // The row never wraps: chips that do not fit wait behind "+n", which opens them as a menu.
  const [visibleCount, setVisibleCount] = createSignal(Number.POSITIVE_INFINITY);
  const hiddenChips = () => chips().slice(Math.min(visibleCount(), chips().length));
  let chipList: HTMLDivElement | undefined;
  const measure = () => {
    const list = chipList;
    if (!list) return;
    const items = [...list.querySelectorAll<HTMLElement>("[data-mail-head-chip]")];
    for (const item of items) item.removeAttribute("data-overflow");
    const available = list.clientWidth;
    const reserve = 56;
    let used = 0;
    let fit = items.length;
    for (const [index, item] of items.entries()) {
      used += item.offsetWidth + 6;
      const room = index === items.length - 1 ? available : available - reserve;
      if (used > room) {
        fit = index;
        break;
      }
    }
    for (const item of items.slice(fit)) item.setAttribute("data-overflow", "hidden");
    setVisibleCount(fit);
  };
  onMount(() => {
    measure();
    if (typeof ResizeObserver === "undefined" || !chipList) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(chipList);
    onCleanup(() => observer.disconnect());
  });
  createMemo(() => {
    chips();
    queueMicrotask(measure);
  });

  const chipMenuItems = (chip: HeadChip): DropdownItem[] => {
    if (chip.menu) return [{ sectionLabel: chip.label, items: chip.menu().filter((item): item is DropdownAction => !("items" in item)) }];
    if (chip.action) return [{ label: chip.label, icon: chip.icon ?? "ti ti-tag", action: chip.action }];
    return [{ label: chip.label, icon: chip.icon ?? "ti ti-tag", description: chip.title, disabled: true }];
  };

  const chipContent = (chip: HeadChip): JSX.Element => (
    <>
      <Show when={chip.color} fallback={<Show when={chip.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}>
        {(color) => <span class="mail-reader-chip-dot" style={{ "--mail-tag": color() }} aria-hidden="true" />}
      </Show>
      <span class="mail-reader-chip-label">{chip.label}</span>
    </>
  );

  const renderChip = (chip: HeadChip): JSX.Element => {
    const common = { class: "mail-reader-chip", "data-mail-head-chip": chip.id, "data-kind": chip.kind } as const;
    if (chip.menu)
      return (
        <Dropdown.Root position="bottom-left" width="18rem" items={chip.menu()}>
          <Dropdown.Trigger appearance="plain" {...common} label={chip.ariaLabel ?? chip.label} tooltip={false}>
            {chipContent(chip)}
          </Dropdown.Trigger>
        </Dropdown.Root>
      );
    if (chip.action)
      return (
        <button type="button" {...common} aria-label={chip.ariaLabel} title={chip.title} onClick={chip.action}>
          {chipContent(chip)}
        </button>
      );
    return (
      <span {...common} data-static="" title={chip.title}>
        {chipContent(chip)}
      </span>
    );
  };

  const others = createMemo(() => props.presence.filter((person) => person.userId !== props.currentUserId));
  const presenceText = () => {
    const people = others();
    if (people.length === 0) return null;
    const writer = people.find((person) => person.mode === "composing");
    const first = (name: string) => name.split(/\s+/)[0] || name;
    if (writer && people.length === 1) return t().writing({ name: first(writer.displayName) });
    if (people.length === 1) return t().reading({ name: first(people[0]!.displayName) });
    if (people.length === 2) return t().readingTwo({ first: first(people[0]!.displayName), second: first(people[1]!.displayName) });
    return t().readingMany({ count: people.length });
  };

  const done = () => props.workStatus === "done";
  const assigneeNames = () => (props.assignees ?? []).map((person) => person.displayName).join(", ");

  return (
    <div class="mail-reader-head" data-mail-reader-toolbar>
      <div class="mail-reader-head-line" role="group" aria-label={props.menuLabel}>
        <IconButtonLink
          href={props.closeHref}
          class="mail-reader-close"
          label={t().closeConversation}
          navigation="enhanced"
          onNavigate={props.onClose}
          scroll="preserve"
          data-mail-reader-close
        >
          <i class="ti ti-x" aria-hidden="true" />
        </IconButtonLink>
        <h1 class="mail-reader-title" data-mail-reader-heading tabIndex={-1} title={props.subject || props.noSubject}>
          {props.subject || props.noSubject}
        </h1>
        <Show when={props.flagged}>
          <span class="mail-reader-flag" role="img" aria-label={props.flaggedLabel} title={props.flaggedLabel}>
            <i class={getMailAction("flag").icon} aria-hidden="true" />
          </span>
        </Show>
        <div class="mail-reader-actions">
          <Show when={props.canWrite && props.workStatus}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              class="mail-reader-done"
              data-mail-toolbar-action="done"
              aria-pressed={done()}
              disabled={props.completionPending}
              onClick={props.onToggleCompletion}
            >
              <i class={done() ? "ti ti-arrow-back-up" : "ti ti-check"} aria-hidden="true" />
              {done() ? t().reopen : t().done}
            </Button>
          </Show>
          <Show when={props.canWrite}>
            <Tooltip.Anchor content={t().archive}>
              <IconButton
                type="button"
                variant="ghost"
                label={t().archive}
                data-mail-toolbar-action="archive"
                disabled={props.actionPending}
                onClick={props.onArchive}
              >
                <i class={getMailAction("archive").icon} aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
            <Tooltip.Anchor content={props.deleteBlocked ?? t().delete}>
              <IconButton
                type="button"
                variant="ghost"
                label={props.deleteBlocked ? `${t().delete}: ${props.deleteBlocked}` : t().delete}
                data-mail-toolbar-action="trash"
                disabled={props.actionPending || props.deleteBlocked !== null}
                onClick={props.onDelete}
              >
                <i class={getMailAction("trash").icon} aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </Show>
          <Dropdown.Root position="bottom-left" width="17rem" items={props.laterItems()}>
            <Dropdown.Trigger iconOnly type="button" variant="ghost" label={t().later} data-mail-toolbar-action="later">
              <i class="ti ti-clock" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
          <Show when={props.canWrite && props.assignees}>
            {(assignees) => (
              <Tooltip.Anchor content={assignees().length > 0 ? t().assignedTo({ names: assigneeNames() }) : t().assign}>
                <IconButton
                  type="button"
                  variant="ghost"
                  class="mail-reader-assign"
                  label={assignees().length > 0 ? `${t().assign}. ${t().assignedTo({ names: assigneeNames() })}` : t().assign}
                  data-mail-toolbar-action="assign"
                  disabled={props.actionPending}
                  onClick={props.onAssign}
                >
                  <Show when={assignees()[0]} fallback={<i class="ti ti-user-plus" aria-hidden="true" />}>
                    {(first) => <Avatar name={first().displayName} src={cloudAvatarSource(first().id, first().avatarHash)} size="xs" />}
                  </Show>
                </IconButton>
              </Tooltip.Anchor>
            )}
          </Show>
          <Dropdown.Root position="bottom-left" width="16rem" items={props.menuItems()}>
            <Dropdown.Trigger iconOnly type="button" variant="ghost" label={props.menuLabel} ref={setMoreTrigger} data-mail-reader-more>
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </div>
      <div class="mail-reader-chips" ref={setChipRow} data-mail-reader-chips>
        <span class="mail-reader-meta" title={props.senderLabel}>
          {t().senderAndCount({ sender: props.senderLabel, count: props.messageCount })}
        </span>
        <div class="mail-reader-chip-list" ref={chipList}>
          <For each={chips()}>{renderChip}</For>
          <Show when={hiddenChips().length > 0}>
            <Dropdown.Root position="bottom-left" width="18rem" items={hiddenChips().flatMap(chipMenuItems)}>
              <Dropdown.Trigger
                appearance="plain"
                class="mail-reader-chip"
                data-mail-head-more-chips
                label={t().moreChips({ count: hiddenChips().length })}
                tooltip={false}
              >
                <span class="mail-reader-chip-label">+{hiddenChips().length}</span>
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
          <Show when={props.onManageTags}>
            {(manage) => (
              <button type="button" class="mail-reader-chip" data-kind="add" aria-label={t().addTagLabel} onClick={manage()}>
                <i class="ti ti-plus" aria-hidden="true" />
                <span class="mail-reader-chip-label">{t().addTag}</span>
              </button>
            )}
          </Show>
        </div>
        <Show when={presenceText()}>
          {(text) => (
            <span class="mail-reader-presence" data-mail-reader-presence role="status">
              <Show when={others()[0]}>
                {(person) => <Avatar name={person().displayName} src={cloudAvatarSource(person().userId, person().avatarHash)} size="xs" />}
              </Show>
              <span>{text()}</span>
            </span>
          )}
        </Show>
      </div>
      <MovedHint
        open={props.hint === "toolbar-moved"}
        target={moreTrigger}
        placement="bottom"
        action={{ label: t().openMenu, onClick: () => moreTrigger()?.click() }}
        onDismiss={() => props.onHintSeen("toolbar-moved")}
      >
        {t().toolbarMoved}
      </MovedHint>
      <MovedHint
        open={props.hint === "reader-head-moved"}
        target={chipRow}
        placement="bottom"
        action={{ label: t().learnMore, href: "/app/mail/help/mail-collaboration" }}
        onDismiss={() => props.onHintSeen("reader-head-moved")}
      >
        {t().readerHeadMoved}
      </MovedHint>
    </div>
  );
}
