import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";
import { ChatActivity, ChatMessage } from "./ChatPrimitives";
import { isChatNearBottom, restoredChatScrollTop } from "./chat-behavior";
import type { ChatAction, ChatActivityTone, ChatAttachment, ChatMessageStatus, ChatRole } from "./types";

export type ChatMessageItem = {
  kind: "message";
  id: string;
  role: ChatRole;
  content?: JSX.Element;
  label?: string;
  createdAt?: string | Date;
  timeLabel?: string;
  status?: ChatMessageStatus;
  attachments?: readonly ChatAttachment[];
  actions?: readonly ChatAction[];
  actionDisplay?: "auto" | "inline" | "menu";
  anchorId?: string | number;
  class?: string;
};

export type ChatActivityItem = {
  kind: "activity";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  leading?: JSX.Element;
  accent?: string;
  tone?: ChatActivityTone;
  busy?: boolean;
  trailing?: JSX.Element;
  defaultOpen?: boolean;
  anchorId?: string | number;
  content?: JSX.Element;
  class?: string;
};

export type ChatTimelineItem = ChatMessageItem | ChatActivityItem;

export type ChatTimelineProps = {
  items: readonly ChatTimelineItem[];
  conversationKey?: string | null;
  loading?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => boolean | void | Promise<boolean | void>;
  emptyTitle?: string;
  emptyDescription?: string;
  navigation?: JSX.Element;
  onActionError?: (error: unknown) => void;
  viewportRef?: (element: HTMLDivElement) => void;
  contentRef?: (element: HTMLDivElement) => void;
  label?: string;
  followThreshold?: number;
  class?: string;
};

export function ChatTimeline(props: ChatTimelineProps): JSX.Element {
  const messages = useUiMessages();
  const [pinned, setPinned] = createSignal(true);
  const [loadingOlderInternally, setLoadingOlderInternally] = createSignal(false);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  let viewportRef: HTMLDivElement | undefined;
  let contentRef: HTMLDivElement | undefined;
  let topSentinelRef: HTMLDivElement | undefined;
  let followFrame: number | undefined;
  let userScrollFrame: number | undefined;
  let userScrollingAway = false;
  let touchY: number | undefined;
  let lastConversationKey: string | null | undefined;

  const loadingOlder = () => Boolean(props.loadingOlder || loadingOlderInternally());
  const canLoadOlder = () => Boolean(props.onLoadOlder && props.hasMore && !loadingOlder());
  const hasHistoryControls = () => loadingOlder() || historyError() !== null || canLoadOlder();
  const hasContent = () => props.items.length > 0;
  const threshold = () => Math.max(0, props.followThreshold ?? 96);

  const cancelFollow = () => {
    if (followFrame !== undefined) cancelAnimationFrame(followFrame);
    followFrame = undefined;
  };

  const noteUserScrollAway = () => {
    userScrollingAway = true;
    if (userScrollFrame !== undefined) cancelAnimationFrame(userScrollFrame);
    userScrollFrame = requestAnimationFrame(() => {
      userScrollFrame = undefined;
      userScrollingAway = false;
    });
  };

  const scrollToLatest = () => {
    if (!viewportRef) return;
    setPinned(true);
    viewportRef.scrollTop = viewportRef.scrollHeight;
  };

  const scheduleFollow = () => {
    if (!pinned() || followFrame !== undefined) return;
    followFrame = requestAnimationFrame(() => {
      followFrame = undefined;
      if (pinned()) scrollToLatest();
    });
  };

  const loadOlder = async () => {
    if (!props.onLoadOlder || !props.hasMore || loadingOlder()) return;
    const viewport = viewportRef;
    if (!viewport) return;
    const previousScrollTop = viewport.scrollTop;
    const previousScrollHeight = viewport.scrollHeight;
    setHistoryError(null);
    setLoadingOlderInternally(true);
    let prepended = false;
    try {
      prepended = (await props.onLoadOlder()) !== false;
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : messages().couldNotLoadOlderMessages);
    } finally {
      setLoadingOlderInternally(false);
    }
    if (!prepended || viewportRef !== viewport) return;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        if (viewportRef !== viewport) return;
        viewport.scrollTop = restoredChatScrollTop(previousScrollTop, previousScrollHeight, viewport.scrollHeight);
      });
    });
  };

  const updatePinned = () => {
    if (!viewportRef) return;
    const nearBottom = isChatNearBottom(viewportRef.scrollHeight, viewportRef.scrollTop, viewportRef.clientHeight, threshold());
    if (nearBottom) setPinned(true);
    else if (userScrollingAway || followFrame === undefined) {
      if (userScrollingAway) cancelFollow();
      setPinned(false);
    }
    if (viewportRef.scrollTop <= threshold()) void loadOlder();
  };

  onMount(() => {
    // Switch from CSS-only SSR anchoring to normal scroll coordinates before paint.
    viewportRef?.removeAttribute("data-initializing");
    scrollToLatest();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => scheduleFollow());
    if (contentRef) resizeObserver?.observe(contentRef);
    if (viewportRef) resizeObserver?.observe(viewportRef);

    const historyObserver =
      typeof IntersectionObserver === "undefined" || !topSentinelRef
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
            },
            { root: viewportRef, rootMargin: "160px 0px 0px" },
          );
    if (topSentinelRef) historyObserver?.observe(topSentinelRef);

    onCleanup(() => {
      cancelFollow();
      if (userScrollFrame !== undefined) cancelAnimationFrame(userScrollFrame);
      resizeObserver?.disconnect();
      historyObserver?.disconnect();
    });
  });

  createEffect(() => {
    const key = props.conversationKey;
    if (key === lastConversationKey) return;
    lastConversationKey = key;
    setHistoryError(null);
    setPinned(true);
    queueMicrotask(scrollToLatest);
  });

  createEffect(() => {
    props.items.length;
    props.items.at(-1)?.id;
    untrack(scheduleFollow);
  });

  return (
    <section class={`k2b-chat-timeline ${props.class ?? ""}`} aria-label={props.label ?? messages().conversation}>
      <div
        ref={(element) => {
          viewportRef = element;
          props.viewportRef?.(element);
        }}
        class="k2b-chat-timeline__viewport"
        data-initializing=""
        role="region"
        aria-label={messages().conversationMessages({ label: props.label ?? messages().conversation })}
        tabIndex={0}
        onWheel={(event) => {
          if (event.deltaY < 0) noteUserScrollAway();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey)) {
            noteUserScrollAway();
          }
        }}
        onTouchStart={(event) => {
          touchY = event.touches[0]?.clientY;
        }}
        onTouchMove={(event) => {
          const nextY = event.touches[0]?.clientY;
          if (nextY !== undefined && touchY !== undefined && nextY > touchY) noteUserScrollAway();
          touchY = nextY;
        }}
        onTouchEnd={() => {
          touchY = undefined;
        }}
        onScroll={updatePinned}
      >
        <Show when={props.navigation}>
          <div class="k2b-chat-timeline__navigation" aria-live="off">
            {props.navigation}
          </div>
        </Show>
        <div
          ref={(element) => {
            contentRef = element;
            props.contentRef?.(element);
          }}
          class="k2b-chat-timeline__content"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={props.loading ? "true" : undefined}
        >
          <div ref={topSentinelRef} class="k2b-chat-timeline__sentinel" aria-hidden="true" />
          <Show when={hasHistoryControls()}>
            <div class="k2b-chat-timeline__history" aria-live="off">
              <Show when={canLoadOlder()}>
                <button type="button" class="k2b-chat-timeline__older" onClick={() => void loadOlder()}>
                  <i class="ti ti-history" aria-hidden="true" />
                  {messages().loadOlderMessages}
                </button>
              </Show>
              <Show when={loadingOlder()}>
                <ChatActivity
                  label={messages().loadingOlderMessages}
                  icon="ti ti-history"
                  trailing={<i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />}
                />
              </Show>
              <Show when={historyError()}>
                {(message) => (
                  <ChatActivity
                    label={messages().couldNotLoadOlderMessages}
                    description={message()}
                    icon="ti ti-alert-circle"
                    tone="danger"
                    trailing={
                      <button
                        type="button"
                        class="k2b-chat-timeline__retry"
                        aria-label={messages().retryOlderMessages}
                        onClick={() => void loadOlder()}
                      >
                        <i class="ti ti-refresh" aria-hidden="true" />
                      </button>
                    }
                  />
                )}
              </Show>
            </div>
          </Show>
          <Show
            when={!props.loading && hasContent()}
            fallback={
              <Placeholder
                class="k2b-chat-timeline__placeholder"
                state={props.loading ? "loading" : "empty"}
                icon={props.loading ? undefined : "ti ti-sparkles"}
                title={props.loading ? messages().loadingConversation : (props.emptyTitle ?? messages().startConversation)}
                description={!props.loading ? props.emptyDescription : undefined}
              />
            }
          >
            <For each={props.items}>
              {(item) => (
                <Show
                  when={item.kind === "message"}
                  fallback={
                    <ChatActivity
                      label={(item as ChatActivityItem).label}
                      description={(item as ChatActivityItem).description}
                      icon={(item as ChatActivityItem).icon}
                      leading={(item as ChatActivityItem).leading}
                      accent={(item as ChatActivityItem).accent}
                      tone={(item as ChatActivityItem).tone}
                      busy={(item as ChatActivityItem).busy}
                      trailing={(item as ChatActivityItem).trailing}
                      defaultOpen={(item as ChatActivityItem).defaultOpen}
                      anchorId={(item as ChatActivityItem).anchorId}
                      class={(item as ChatActivityItem).class}
                    >
                      {(item as ChatActivityItem).content}
                    </ChatActivity>
                  }
                >
                  <ChatMessage
                    role={(item as ChatMessageItem).role}
                    label={(item as ChatMessageItem).label}
                    createdAt={(item as ChatMessageItem).createdAt}
                    timeLabel={(item as ChatMessageItem).timeLabel}
                    status={(item as ChatMessageItem).status}
                    attachments={(item as ChatMessageItem).attachments}
                    actions={(item as ChatMessageItem).actions}
                    actionDisplay={(item as ChatMessageItem).actionDisplay}
                    anchorId={(item as ChatMessageItem).anchorId}
                    onActionError={props.onActionError}
                    class={(item as ChatMessageItem).class}
                  >
                    {(item as ChatMessageItem).content}
                  </ChatMessage>
                </Show>
              )}
            </For>
          </Show>
        </div>
      </div>
      <Show when={!pinned() && hasContent()}>
        <button type="button" class="k2b-chat-timeline__latest" onClick={scrollToLatest}>
          <i class="ti ti-arrow-down" aria-hidden="true" />
          Jump to latest
        </button>
      </Show>
    </section>
  );
}
