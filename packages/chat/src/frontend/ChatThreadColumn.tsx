import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Button, IconButton, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationSchema } from "../service/contracts";
import { viewIcon } from "./ChatThreads";
import { listTime } from "./chat-format";
import SystemThreadDirectory from "./SystemThreadDirectory";
import { activeThreads, archivedThreads, type Thread, type ThreadList, type ThreadView, threadHref } from "./threads";

type Conversation = z.infer<typeof ConversationSchema>;
type LastMessage = Thread["lastMessage"];

/**
 * From a 1800 px window, a chat with threads shows them in a column of their own between the list and the messages:
 * every row with its name, time, description, last message, and unread count, like the message list in Mail.
 */
export default function ChatThreadColumn(props: {
  conversation: Conversation;
  basePath?: string;
  threads: ThreadList | null;
  status: "loading" | "ready" | "failed";
  view: ThreadView;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  onOpen: (view: ThreadView, navigation: LinkNavigateEvent) => void | Promise<void>;
  onCreate: () => void;
  canCreate: boolean;
  creating?: boolean;
  revision?: number;
  onRetry: () => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const config = () => ({ ...props.dateConfig, locale: locale() });
  const [archiveOpen, setArchiveOpen] = createSignal(false);
  const preview = (message: LastMessage) => {
    if (!message) return t().noMessagesYet;
    const name = message.author.id === props.viewerId ? t().you : (message.author.name.trim().split(/\s+/u)[0] ?? "");
    return `${name}: ${message.preview}`;
  };
  const row = (view: ThreadView, name: string, description: string | null, unread: number, last: LastMessage, marked = false) => {
    const current = () => props.view === view;
    // The open thread is being read, so it shows no count, unless the reader marked it unread on purpose.
    const count = () => (unread > 0 && (!current() || marked) ? unread : 0);
    return (
      <Link
        href={threadHref(props.conversation.id, view, null, props.basePath)}
        onNavigate={(navigation) => props.onOpen(view, navigation)}
        class="chat-thread-column__row"
        aria-current={current() ? "page" : undefined}
        data-unread={count() > 0 ? "" : undefined}
        data-thread={view}
      >
        <i class={`${viewIcon(view, props.threads)} chat-thread-column__icon`} aria-hidden="true" />
        <span class="chat-thread-column__copy">
          <span class="chat-thread-column__line">
            <span class="chat-thread-column__name">{name}</span>
            <Show when={last}>
              {(message) => (
                <time class="chat-thread-column__time" datetime={message().createdAt}>
                  {listTime(message().createdAt, props.now(), config())}
                </time>
              )}
            </Show>
          </span>
          <Show when={description}>
            <span class="chat-thread-column__description">{description}</span>
          </Show>
          <span class="chat-thread-column__line">
            <span class="chat-thread-column__preview">{preview(last)}</span>
            {/* The count's place is always there, so a count that comes or goes moves nothing. */}
            <span class="chat-thread-column__count" aria-hidden={count() > 0 ? undefined : "true"}>
              {count() > 0 ? (count() > 99 ? "99+" : count()) : ""}
            </span>
          </span>
        </span>
      </Link>
    );
  };
  const thread = (entry: Thread) =>
    row(entry.id, entry.name, entry.description, entry.unread, entry.lastMessage, entry.read?.unreadFromSeq != null);
  return (
    <section class="chat-thread-column" aria-label={t().threadsIn({ title: props.conversation.title })}>
      <header class="chat-thread-column__head">
        <span class="chat-thread-column__title">
          <span class="chat-thread-column__chat">{props.conversation.title}</span>
          <span class="chat-thread-column__members">{t().members({ count: props.conversation.memberCount })}</span>
        </span>
        <Show when={props.canCreate}>
          <IconButton
            label={props.conversation.kind === "system" ? t().discussElement : t().newThread}
            variant="ghost"
            disabled={props.creating}
            onClick={() => props.onCreate()}
          >
            <i class="ti ti-plus" aria-hidden="true" />
          </IconButton>
        </Show>
      </header>
      <nav class="chat-thread-column__list" aria-label={t().threadsIn({ title: props.conversation.title })}>
        <Show
          when={props.conversation.kind === "system"}
          fallback={
            <>
              <Show
                when={props.status !== "failed"}
                fallback={
                  <div class="chat-threads__error" role="status">
                    <span>{t().threadsLoadFailed}</span>
                    <Button size="xs" variant="ghost" onClick={() => props.onRetry()}>
                      {t().retry}
                    </Button>
                  </div>
                }
              >
                {row("all", t().allThreads, t().allThreadsHint, props.conversation.unread, props.conversation.lastMessage)}
                {row(
                  "general",
                  t().general,
                  t().generalHint,
                  props.threads?.general.unread ?? 0,
                  props.threads?.general.lastMessage ?? null,
                )}
                <For each={activeThreads(props.threads)}>{thread}</For>
                <Show when={props.status === "ready" && activeThreads(props.threads).length === 0}>
                  <p class="chat-threads-page__empty">
                    {(
                      props.conversation.kind === "system"
                        ? props.conversation.permission !== "read"
                        : props.conversation.permission === "admin"
                    )
                      ? t().noThreadsYetAdmin
                      : t().noThreadsYet}
                  </p>
                </Show>
                <Show when={archivedThreads(props.threads).length > 0}>
                  <AppWorkspace.SidebarItem
                    icon={archiveOpen() ? "ti ti-chevron-down" : "ti ti-chevron-right"}
                    onClick={() => setArchiveOpen((open) => !open)}
                  >
                    {t().archivedThreads({ count: archivedThreads(props.threads).length })}
                  </AppWorkspace.SidebarItem>
                  <Show when={archiveOpen()}>
                    <For each={archivedThreads(props.threads)}>{thread}</For>
                  </Show>
                </Show>
              </Show>
            </>
          }
        >
          <SystemThreadDirectory
            basePath={props.basePath}
            viewerId={props.viewerId}
            dateConfig={props.dateConfig}
            now={props.now}
            conversation={props.conversation}
            view={props.view}
            revision={props.revision ?? 0}
            onOpen={props.onOpen}
          />
        </Show>
      </nav>
    </section>
  );
}
