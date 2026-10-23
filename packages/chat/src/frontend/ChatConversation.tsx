import { type CloudResourceRef, CloudResourceRefSchema } from "@k2b/cloud/contracts";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  Chat,
  type ChatAttachment,
  type ChatComposerReply,
  EmojiPicker,
  IconButtonLink,
  MessageRow,
  type MessageRowOrigin,
  type MessageRowQuote,
  type MessageRowStatus,
  MessageSystemRow,
  PageTitle,
  rememberEmoji,
  startsMessageGroup,
  toast,
  useLocale,
  VirtualFeed,
  type VirtualFeedController,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { chatMessages } from "../messages";
import { MAX_MESSAGE_REFS } from "../service/contracts";
import ChatResourceCards, { type ResourceCards } from "./ChatResourceCards";
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
  /** Its thread's ID, or null for General; a send the history does not hold yet has its target. */
  thread?: string | null;
  /** The message it answers. */
  quote?: MessageRowQuote;
  /** The Cloud elements it shares, shown as cards. */
  refs?: readonly CloudResourceRef[];
  /** Its thread, shown under it where several threads mix. */
  origin?: MessageRowOrigin;
};

export type ChatConversationProps = {
  /** The chat's own commands at the end of the header, such as its info. */
  actions?: JSX.Element;
  chatId: string;
  title: string;
  memberCount: number;
  /** The line under the title; the member count by default. */
  subtitle?: string;
  /** Beside the title, such as the thread picker. */
  titleExtra?: JSX.Element;
  /**
   * The head from a 1800 px window, where the threads stand in their own column: the open thread as the title and its
   * description below, instead of the chat's title and the picker.
   */
  wideTitle?: { title: string; subtitle: string };
  /** Where the back button leads below 64 rem; the list by default. */
  backHref?: string;
  /** Each part of a chat keeps its own draft. */
  draftKey?: string;
  /** Replaces the composer, for example where the reader cannot write. */
  notice?: JSX.Element;
  placeholder?: string;
  /** Who the composer writes to, such as a thread; the chat's title by default. */
  target?: string;
  /** The message the draft answers, above the field. */
  reply?: ChatComposerReply;
  /** "Reply" in a message's menu, with `r` and a swipe to the right; without it, messages offer no reply. */
  onReply?: (item: ChatFeedItem) => void;
  /** The sentence under "Reply" and "Mark unread from here", which names the message's thread. */
  replyHint?: (item: ChatFeedItem) => string;
  unreadHint?: (item: ChatFeedItem) => string;
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
  onSend: (text: string, refs: readonly CloudResourceRef[]) => boolean | Promise<boolean>;
  /** Reads shared elements for their cards; missing on the server, where cards show their placeholder. */
  cards?: ResourceCards;
  /** "Share a Cloud element" in the composer's add menu: picks one, or null when the reader cancels. */
  onPickResource?: () => Promise<{ ref: CloudResourceRef; title: string; icon?: string } | null>;
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
  /** "Copy text" in a message's menu. */
  onCopy: (item: ChatFeedItem) => void;
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
  // Elements picked for the next message; they belong to the draft they were picked for.
  const [shared, setShared] = createSignal<readonly ChatAttachment[]>([]);
  createEffect(
    on(
      () => props.draftKey ?? props.chatId,
      () => setShared([]),
      { defer: true },
    ),
  );
  const pickResource = async () => {
    // The server takes at most this many elements per message; the reader learns it before picking more.
    if (shared().length >= MAX_MESSAGE_REFS) {
      toast(t().tooManyResources({ count: MAX_MESSAGE_REFS }), { iconClass: "ti ti-info-circle" });
      return;
    }
    const picked = await props.onPickResource?.();
    if (!picked) return;
    const id = `${picked.ref.type}:${picked.ref.id}`;
    if (shared().some((attachment) => attachment.id === id)) return;
    setShared((current) => [...current, { id, name: picked.title, kind: "resource", icon: picked.icon, data: picked.ref }]);
  };
  const refsOf = (attachments: readonly ChatAttachment[]) =>
    attachments.flatMap((attachment) => {
      const ref = attachment.kind === "resource" ? CloudResourceRefSchema.safeParse(attachment.data) : null;
      return ref?.success ? [ref.data] : [];
    });
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
    <section
      ref={frame}
      class="chat-conversation"
      data-wide-title={props.wideTitle ? "" : undefined}
      aria-label={props.title}
      onKeyDown={(event) => {
        if (event.key !== "r" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
        const article = event.target instanceof HTMLElement && event.target.matches(".k2b-virtual-feed__item") ? event.target : null;
        const item = article && props.items.find((entry) => entry.key === article.dataset.key);
        if (!item?.messageId || item.kind !== "text" || !props.onReply) return;
        event.preventDefault();
        props.onReply(item);
      }}
    >
      <header class="chat-conversation__header">
        <span class="chat-conversation__back">
          <IconButtonLink
            href={props.backHref ?? "/app/chat"}
            navigation="enhanced"
            onNavigate={props.onBack}
            label={props.backHref ? t().backToThreads : t().backToChats}
            tooltip={false}
          >
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </IconButtonLink>
        </span>
        <PageTitle trail={{ title: props.title, ancestors: [] }} subtitle={props.subtitle ?? t().members({ count: props.memberCount })} />
        {props.titleExtra}
        <Show when={props.wideTitle}>
          {(wide) => (
            <div class="chat-conversation__wide-title">
              <h1 class="chat-conversation__wide-name">{wide().title}</h1>
              <p class="chat-conversation__wide-subtitle">{wide().subtitle}</p>
            </div>
          )}
        </Show>
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
              quote={item.quote}
              origin={item.origin}
              card={item.refs?.length ? <ChatResourceCards refs={item.refs} cards={props.cards} /> : undefined}
              onRetry={item.retry}
              onDiscard={item.discard}
              actions={
                item.messageId
                  ? [
                      ...(props.onReply
                        ? [
                            {
                              id: "reply",
                              label: t().reply,
                              description: props.replyHint?.(item),
                              icon: "ti ti-arrow-back-up",
                              shortcut: "r",
                              gesture: "swipe-right" as const,
                              onSelect: () => props.onReply?.(item),
                            },
                          ]
                        : []),
                      { id: "copy", label: t().copyText, icon: "ti ti-copy", immediate: true, onSelect: () => props.onCopy(item) },
                      // The reader's own messages never count as unread.
                      ...(item.own
                        ? []
                        : [
                            {
                              id: "unread",
                              label: t().markUnreadFromHere,
                              description: props.unreadHint?.(item) ?? t().markUnreadFromHereHint,
                              icon: "ti ti-mail",
                              altClick: true,
                              onSelect: () => props.onMarkUnreadFrom(item),
                            },
                          ]),
                    ]
                  : item.discard
                    ? [
                        {
                          id: "discard",
                          label: t().discardMessage,
                          icon: "ti ti-trash",
                          variant: "danger" as const,
                          onSelect: item.discard,
                        },
                      ]
                    : undefined
              }
            />
          )
        }
      </VirtualFeed>
      <Show
        when={!props.notice}
        fallback={
          <div class="chat-conversation__notice" role="status">
            {props.notice}
          </div>
        }
      >
        <div class="chat-conversation__composer">
          <Chat.Composer
            variant="conversation"
            value={props.draft}
            onValueChange={props.onDraftChange}
            onSubmit={async ({ text, attachments }) => {
              const sent = await props.onSend(text, refsOf(attachments));
              if (sent) setShared([]);
              return sent;
            }}
            attachments={shared()}
            onAttachmentsChange={setShared}
            menuActions={
              props.onPickResource
                ? [{ id: "share-resource", label: t().shareResource, icon: "ti ti-share", onSelect: () => pickResource() }]
                : undefined
            }
            draftKey={props.draftKey ?? props.chatId}
            reply={props.reply}
            formatting
            emoji={{ onOpen: setEmojiTarget, onPick: remember }}
            placeholder={props.placeholder ?? t().composerPlaceholder({ title: props.title })}
            inputLabel={t().composerLabel({ title: props.target ?? props.title })}
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
      </Show>
    </section>
  );
}
