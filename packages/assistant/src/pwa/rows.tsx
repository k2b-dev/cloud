import type { AiConversation, AiOpenQuestion } from "@k2b/cloud/ai";
import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { Skeleton, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { calendarDaysBefore } from "../frontend/chat-sidebar-model";
import { ConversationStatusMeta } from "../frontend/conversation-status";
import { pwaMessages } from "./messages";
import { chatHref } from "./paths";

/** When a chat was last used, as a list says it: the time today, then "Yesterday", a weekday, or a date. */
export const rowTime = (iso: string, now: string, timeZone: string, locale: string): string => {
  const days = calendarDaysBefore(iso, now, timeZone);
  const date = new Date(iso);
  if (days === 0) return new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  if (days === 1) {
    const yesterday = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return yesterday.charAt(0).toLocaleUpperCase(locale) + yesterday.slice(1);
  }
  if (days < 7) return new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" }).format(date);
};

/**
 * The second line of a chat: what it does now, what it waits for, why it failed, or what it is about. A finished
 * answer the person has not read shows as the dot at the end instead.
 */
const preview = (chat: AiConversation, question: AiOpenQuestion | undefined, t: ReturnType<typeof pwaMessages.resolve>["t"]) => {
  if (chat.runStatus === "needs_attention" && question) return t.waitingForYes({ short: question.short });
  if ((chat.runStatus === "running" || chat.runStatus === "queued") && chat.activity?.step) return chat.activity.step;
  if (chat.runStatus === "failed" && chat.runError) return chat.runError;
  return chat.description;
};

export function ChatRows(props: {
  chats: readonly AiConversation[];
  questions: readonly AiOpenQuestion[];
  selected?: string | null;
  now: string;
  timeZone: string;
  onOpen: (chat: AiConversation, event: LinkNavigateEvent) => void;
}) {
  const locale = useLocale();
  const t = () => pwaMessages.resolve([locale()]).t;
  return (
    <ul class="assistant-pwa-rows">
      <For each={props.chats}>
        {(chat) => {
          const unread = () => chat.unreadCompletion && chat.runStatus === "idle";
          return (
            <li>
              <Link
                class="assistant-pwa-row"
                href={chatHref(chat.id)}
                aria-current={chat.id === props.selected ? "page" : undefined}
                data-unread={unread() ? "" : undefined}
                onNavigate={(event) => props.onOpen(chat, event)}
              >
                <span class="assistant-pwa-row__title k2b-truncate-fade">{chat.title}</span>
                <time class="assistant-pwa-row__when" dateTime={chat.lastUsedAt}>
                  {rowTime(chat.lastUsedAt, props.now, props.timeZone, locale())}
                </time>
                <span class="assistant-pwa-row__meta">
                  <ConversationStatusMeta conversation={chat} hideStatus={unread()} hidePin />
                  <Show when={chat.pinnedAt}>
                    <i class="ti ti-pin assistant-pwa-row__pin" role="img" aria-label={t().pinned} />
                  </Show>
                  <span class="assistant-pwa-row__preview">
                    {preview(
                      chat,
                      props.questions.find((question) => question.conversationId === chat.id),
                      t(),
                    )}
                  </span>
                </span>
                <Show when={unread()}>
                  <span class="assistant-pwa-row__dot" role="img" aria-label={t().newAnswer} />
                </Show>
              </Link>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

/** Rows of the list's height while it loads, so nothing moves when the chats arrive. */
export function SkeletonRows(props: { count: number; label: string }) {
  return (
    <ul class="assistant-pwa-rows" aria-busy="true" aria-label={props.label}>
      <For each={Array.from({ length: props.count }, (_, index) => index)}>
        {(index) => (
          <li>
            <span class="assistant-pwa-row assistant-pwa-row--skeleton">
              <Skeleton class="assistant-pwa-skeleton" />
              <Skeleton class="assistant-pwa-skeleton assistant-pwa-skeleton--when" />
              <span class="assistant-pwa-row__meta">
                <Skeleton class="assistant-pwa-skeleton assistant-pwa-skeleton--line" />
              </span>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}
