import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import {
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
import { createEffect, createSignal, type JSX, onCleanup, onMount } from "solid-js";
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
};

export type ChatConversationProps = {
  chatId: string;
  title: string;
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
  let focused: string | null = null;
  createEffect(() => {
    const key = props.focusKey;
    const controller = feed();
    if (!key || key === focused || !controller || !props.items.some((item) => item.key === key)) return;
    if (controller.scrollToKey(key, { highlight: true })) focused = key;
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
          <IconButtonLink href="/app/chat" navigation="enhanced" onNavigate={props.onBack} label={t().backToChats} tooltip={false}>
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </IconButtonLink>
        </span>
        <PageTitle trail={{ title: props.title, ancestors: [] }} subtitle={t().members({ count: props.memberCount })} />
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
