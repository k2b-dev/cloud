import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Button, IconButtonLink, PageTitle, useLocale } from "@k2b/ui";
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
 * The phone's page between the chats and one thread: "All threads", "General", the threads by last activity with their
 * last message, and the archived ones collapsed at the end. Admins create a thread here as the page's main action.
 */
export default function ChatThreadsPage(props: {
  conversation: Conversation;
  basePath?: string;
  threads: ThreadList | null;
  status: "loading" | "ready" | "failed";
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  info: JSX.Element;
  onBack: (navigation: LinkNavigateEvent) => void | Promise<void>;
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
  const preview = (message: LastMessage, fallback: string) => {
    if (!message) return fallback;
    const name = message.author.id === props.viewerId ? t().you : (message.author.name.trim().split(/\s+/u)[0] ?? "");
    return `${name}: ${message.preview}`;
  };
  const row = (view: ThreadView, name: string, unread: number, last: LastMessage, fallback: string) => (
    <AppWorkspace.SidebarItem
      href={threadHref(props.conversation.id, view, null, props.basePath)}
      navigation="enhanced"
      onNavigate={(navigation) => props.onOpen(view, navigation)}
      description={<span class="chat-list__preview">{preview(last, fallback)}</span>}
    >
      <AppWorkspace.SidebarItemIcon icon={viewIcon(view)} />
      <AppWorkspace.SidebarItemLabel marquee={false}>{name}</AppWorkspace.SidebarItemLabel>
      <AppWorkspace.SidebarItemMeta>
        <span class="chat-list__meta">
          <Show when={last} fallback={<span class="chat-list__time" />}>
            {(message) => (
              <time class="chat-list__time" datetime={message().createdAt}>
                {listTime(message().createdAt, props.now(), config())}
              </time>
            )}
          </Show>
          <span class="chat-list__unread">
            <AppWorkspace.SidebarItemStatus unread={unread > 0 ? unread : undefined} />
          </span>
        </span>
      </AppWorkspace.SidebarItemMeta>
    </AppWorkspace.SidebarItem>
  );
  const thread = (entry: Thread) => row(entry.id, entry.name, entry.unread, entry.lastMessage, entry.description ?? t().noMessagesYet);
  return (
    <section class="chat-threads-page" aria-label={t().threadsIn({ title: props.conversation.title })}>
      <header class="chat-conversation__header" classList={{ "chat-threads-page__header--system": props.conversation.kind === "system" }}>
        <span class="chat-conversation__back">
          <IconButtonLink
            href={props.basePath ?? "/app/chat"}
            navigation="enhanced"
            onNavigate={props.onBack}
            label={t().backToChats}
            tooltip={false}
          >
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </IconButtonLink>
        </span>
        <PageTitle
          trail={{ title: props.conversation.title, ancestors: [] }}
          subtitle={t().members({ count: props.conversation.memberCount })}
        />
        <div class="chat-conversation__actions">
          <Show when={props.canCreate}>
            <Button size="sm" disabled={props.creating} onClick={() => props.onCreate()}>
              <i class="ti ti-plus" aria-hidden="true" />
              {props.conversation.kind === "system" ? t().discussElement : t().newThread}
            </Button>
          </Show>
          {props.info}
        </div>
      </header>
      <nav class="chat-threads-page__list" aria-label={t().threadsIn({ title: props.conversation.title })}>
        <Show
          when={props.conversation.kind === "system"}
          fallback={
            <>
              <Show
                when={props.status !== "failed"}
                fallback={<ThreadsFailed message={t().threadsLoadFailed} retry={t().retry} onRetry={props.onRetry} />}
              >
                {row("all", t().allThreads, props.conversation.unread, props.conversation.lastMessage, t().allThreadsHint)}
                {row(
                  "general",
                  t().general,
                  props.threads?.general.unread ?? 0,
                  props.threads?.general.lastMessage ?? null,
                  t().generalHint,
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
            revision={props.revision ?? 0}
            onOpen={props.onOpen}
          />
        </Show>
      </nav>
    </section>
  );
}

const ThreadsFailed = (props: { message: string; retry: string; onRetry: () => void }) => (
  <div class="chat-threads__error" role="status">
    <span>{props.message}</span>
    <Button size="xs" variant="ghost" onClick={() => props.onRetry()}>
      {props.retry}
    </Button>
  </div>
);
