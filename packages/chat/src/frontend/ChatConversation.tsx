import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  Chat,
  EmojiPicker,
  IconButtonLink,
  MessageRow,
  type MessageRowStatus,
  MessageSystemRow,
  PageTitle,
  rememberEmoji,
  startsMessageGroup,
  useLocale,
  VirtualFeed,
  type VirtualFeedController,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { chatMessages } from "../messages";
import { dayLabel, messageTime, sameDay } from "./chat-format";
import { followVisualViewport } from "./follow-viewport";

/** One row of the history: a stored message, or one of the reader's own sends that the history does not hold yet. */
export type ChatFeedItem = {
  /** The send's client ID for the reader's own messages sent from this tab, so a row keeps its key once stored. */
  key: string;
  kind: "text" | "system";
  authorId: string;
  authorName: string;
  body: string;
  at: string;
  own: boolean;
  status?: MessageRowStatus;
  /** Set on a failed send: sends it again with the same client ID. */
  retry?: () => void;
  /** Set on a failed send: removes it, so the sends after it go out. */
  discard?: () => void;
  /** Position and ID of a stored message; a send the history does not hold yet has neither. */
  seq?: number;
  messageId?: string;
};

export type ChatConversationProps = {
  /** The chat's own commands at the end of the header, such as its info. */
  actions?: JSX.Element;
  chatId: string;
  title: string;
  backHref?: string;
  memberCount: number;
  items: readonly ChatFeedItem[];
  hasOlder: boolean;
  hasNewer: boolean;
  onLoadOlder: () => Promise<unknown>;
  onLoadNewer: () => Promise<unknown>;
  onLoadNewest: () => Promise<unknown>;
  /** Key of the message a deep link names; the history scrolls to it and highlights it once. */
  focusKey: string | null;
  canWrite: boolean;
  /** One quiet line above the field, such as why the reader cannot write. */
  hint?: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text: string) => boolean | Promise<boolean>;
  busy: boolean;
  dateConfig: DateContext;
  now: () => Date;
  /** Below 64 rem the chat is a page of its own; its back button returns to the list. */
  onBack: (navigation: LinkNavigateEvent) => void | Promise<void>;
  /** Receives the history's controller, for example to follow the end after a send. */
  controller?: (controller: VirtualFeedController) => void;
  /** Key of the first new message when the chat opened; "New messages" stays above it until the chat closes. */
  markerKey: string | null;
  /** The first and last item fully in view, for reporting what the reader has seen. */
  onVisibleChange: (visible: { first: ChatFeedItem; last: ChatFeedItem } | null) => void;
  onMarkUnreadFrom: (item: ChatFeedItem) => void;
  /** Esc within the chat or with no focused control, unless a field, menu, dialog, tooltip, or light-dismiss popover uses it. */
  onEscape: () => void;
};

const ROW_ESTIMATE = 60;
const SYSTEM_ESTIMATE = 36;

/** Header, history, and composer of one open chat. Below 48 rem it covers the visible part of the screen. */
export default function ChatConversation(props: ChatConversationProps): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const config = () => ({ ...props.dateConfig, locale: locale() });
  const [emojiTarget, setEmojiTarget] = createSignal<{ anchor: HTMLElement; insert: (text: string) => void }>();
  const [recent, setRecent] = createSignal<readonly string[]>([]);
  let frame!: HTMLElement;
  const [feed, setFeed] = createSignal<VirtualFeedController>();

  onMount(() => onCleanup(followVisualViewport(frame)));

  // A deep link highlights its message once the history holds it; a later page or a live message does not repeat it.
  // An address without a message ends that link, so returning to it in the same chat highlights the message again.
  let focused: string | null = null;
  createEffect(() => {
    const key = props.focusKey;
    const controller = feed();
    if (!key) focused = null;
    if (!key || key === focused || !controller || !props.items.some((item) => item.key === key)) return;
    if (controller.scrollToKey(key, { highlight: true })) focused = key;
  });

  // Where "New messages" is while it is out of view, so its button points there. Without a marker or with the marker
  // in view there is no button.
  const [visible, setVisible] = createSignal<{ first: ChatFeedItem; last: ChatFeedItem } | null>(null);
  const markerAway = createMemo(() => {
    const range = visible();
    const marker = props.markerKey ? props.items.findIndex((item) => item.key === props.markerKey) : -1;
    if (!range || marker < 0) return null;
    return marker < props.items.indexOf(range.first) ? "above" : marker > props.items.indexOf(range.last) ? "below" : null;
  });
  // When the chat opens without showing the marker, it moves there once, unless a deep link leads.
  let placed = false;
  createEffect(() => {
    const controller = feed();
    const away = markerAway();
    if (placed || !controller || !visible()) return;
    placed = true;
    if (away && props.markerKey && !props.focusKey) controller.scrollToKey(props.markerKey, { align: "start" });
  });

  onMount(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target !== document.body && target !== document.documentElement && (!target || !frame.contains(target))) return;
      if (target?.closest('dialog, [role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (document.querySelector(".k2b-tooltip:popover-open, :is([popover=''], [popover='auto' i]):popover-open")) return;
      props.onEscape();
    };
    document.addEventListener("keydown", escape);
    onCleanup(() => document.removeEventListener("keydown", escape));
  });

  const startsGroup = (item: ChatFeedItem, previous: ChatFeedItem | undefined) =>
    !previous ||
    !sameDay(item.at, previous.at, config()) ||
    startsMessageGroup(
      { author: item.authorId, at: item.at, system: item.kind === "system" },
      { author: previous.authorId, at: previous.at, system: previous.kind === "system" },
    );
  const remember = (emoji: string) => setRecent((current) => rememberEmoji(current, emoji));

  return (
    <section ref={frame} class="chat-conversation" aria-label={props.title}>
      <header class="chat-conversation__header">
        <span class="chat-conversation__back">
          <IconButtonLink href={props.backHref ?? "/app/chat"} navigation="enhanced" onNavigate={props.onBack} label={t().backToChats} tooltip={false}>
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </IconButtonLink>
        </span>
        <PageTitle trail={{ title: props.title, ancestors: [] }} subtitle={t().members({ count: props.memberCount })} />
        <Show when={markerAway()}>
          {(direction) => (
            <Button
              size="sm"
              variant="ghost"
              tooltip={t().jumpToNewLabel}
              onClick={() => props.markerKey && feed()?.scrollToKey(props.markerKey, { align: "start" })}
            >
              <i class={direction() === "above" ? "ti ti-arrow-up" : "ti ti-arrow-down"} aria-hidden="true" />
              {t().jumpToNew}
            </Button>
          )}
        </Show>
        <div class="chat-conversation__actions">{props.actions}</div>
      </header>
      <VirtualFeed
        class="chat-conversation__feed"
        items={props.items}
        getKey={(item) => item.key}
        estimateSize={(item) => (item.kind === "system" ? SYSTEM_ESTIMATE : ROW_ESTIMATE)}
        label={t().history({ title: props.title })}
        itemLabel={(item) =>
          item.kind === "system" ? undefined : `${item.own ? t().you : item.authorName}, ${messageTime(item.at, config())}`
        }
        separator={(item, previous) =>
          previous && sameDay(item.at, previous.at, config()) ? undefined : dayLabel(item.at, props.now(), config())
        }
        hasOlder={props.hasOlder}
        hasNewer={props.hasNewer}
        onLoadOlder={props.onLoadOlder}
        onLoadNewer={props.onLoadNewer}
        onLoadNewest={props.onLoadNewest}
        markerKey={props.markerKey}
        markerLabel={t().newMarker}
        onVisibleChange={(range) => {
          setVisible(range);
          props.onVisibleChange(range);
        }}
        busy={props.busy}
        announce={(added) => {
          const count = added.filter((item) => !item.own && item.kind === "text").length;
          return count ? t().newMessages({ count }) : undefined;
        }}
        controller={(controller) => {
          setFeed(() => controller);
          props.controller?.(controller);
        }}
      >
        {(item, index) =>
          item.kind === "system" ? (
            <MessageSystemRow time={messageTime(item.at, config())} dateTime={item.at}>
              {item.body}
            </MessageSystemRow>
          ) : (
            <MessageRow
              author={{ name: item.authorName }}
              text={item.body}
              time={messageTime(item.at, config())}
              dateTime={item.at}
              own={item.own}
              groupStart={startsGroup(item, props.items[index() - 1])}
              status={item.status}
              onRetry={item.retry}
              actions={
                item.messageId
                  ? [{ id: "unread", label: t().markUnreadFromHere, icon: "ti ti-mail", onSelect: () => props.onMarkUnreadFrom(item) }]
                  : item.discard
                    ? [{ id: "discard", label: t().discardMessage, icon: "ti ti-trash", onSelect: item.discard }]
                    : undefined
              }
            />
          )
        }
      </VirtualFeed>
      <div class="chat-conversation__composer">
        <Chat.Composer
          variant="conversation"
          value={props.draft}
          onValueChange={props.onDraftChange}
          onSubmit={({ text }) => props.onSend(text)}
          draftKey={props.chatId}
          formatting
          emoji={{ onOpen: setEmojiTarget, onPick: remember }}
          placeholder={t().composerPlaceholder({ title: props.title })}
          inputLabel={t().composerLabel({ title: props.title })}
          disabled={!props.canWrite}
          hint={props.hint}
        />
        <EmojiPicker.Popover
          anchor={emojiTarget()?.anchor}
          recent={recent()}
          onPick={(emoji) => {
            emojiTarget()?.insert(emoji);
            remember(emoji);
          }}
          onClose={() => setEmojiTarget(undefined)}
        />
      </div>
    </section>
  );
}
