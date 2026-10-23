import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Dropdown, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationSchema } from "../service/contracts";
import { ThreadRows } from "./ChatThreads";
import { lastMessageLine, listTime } from "./chat-format";
import { chatHasThreads } from "./threads";

type Conversation = z.infer<typeof ConversationSchema>;

export const chatHref = (id: string, message?: string | null) => `/app/chat/c/${id}${message ? `/m/${message}` : ""}`;

/** What a row shows of its unread state: the count, a dot for a chat marked unread without new messages, or nothing. */
const unreadMark = (row: Conversation): number | true | undefined =>
  row.unread > 0 ? row.unread : row.read?.unreadFromSeq != null ? true : undefined;

/**
 * The chats as navigation rows, newest activity first: title, the last message with its sender, the time, and the
 * unread count below it. Every row has the same two lines in every state, also before the first message, so rows never
 * change height and a count that comes or goes moves nothing. The open chat shows no marks while it is being read; after
 * "Mark unread" it shows its count like any other.
 */
export default function ChatList(props: {
  rows: readonly Conversation[];
  basePath?: string;
  activeId: string | null;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  hasMore: boolean;
  onOpen: (id: string, navigation: LinkNavigateEvent) => void | Promise<void>;
  onMore: () => void;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  /** The open chat's threads, shown as rows under it; the chat's own row then shows its members instead of a count. */
  threads?: Omit<Parameters<typeof ThreadRows>[0], "chatId" | "unread">;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const config = () => ({ ...props.dateConfig, locale: locale() });
  return (
    <>
      <For each={props.rows}>
        {(row) => {
          const expanded = () => row.id === props.activeId && props.threads !== undefined && chatHasThreads(row);
          return (
            <>
              <AppWorkspace.SidebarItem
                href={`${props.basePath ?? "/app/chat"}/c/${encodeURIComponent(row.id)}`}
                navigation="enhanced"
                onNavigate={(navigation) => props.onOpen(row.id, navigation)}
                // With its threads shown, the open thread's row carries the selection, not the chat's.
                active={row.id === props.activeId && !expanded()}
                actions={
                  <AppWorkspace.SidebarItemActions visibility="hover">
                    <Dropdown.Root
                      position="bottom-right"
                      items={[
                        unreadMark(row) === undefined
                          ? { label: t().markUnread, icon: "ti ti-mail", action: () => props.onMarkUnread(row.id) }
                          : { label: t().markRead, icon: "ti ti-mail-opened", action: () => props.onMarkRead(row.id) },
                      ]}
                    >
                      <Dropdown.Trigger
                        iconOnly
                        label={t().chatActions({ title: row.title })}
                        tooltip={t().chatActions({ title: row.title })}
                        size="xs"
                      >
                        <i class="ti ti-dots text-xs" />
                      </Dropdown.Trigger>
                    </Dropdown.Root>
                  </AppWorkspace.SidebarItemActions>
                }
                class={expanded() ? "chat-list__open" : undefined}
                description={
                  <>
                    {/* Its rows show below it; from a 1800 px window they move into their own column and the row reads
                    like any other chat again. */}
                    <Show when={expanded()}>
                      <span class="chat-list__preview chat-list__members">{t().members({ count: row.memberCount })}</span>
                    </Show>
                    <span class="chat-list__preview" data-collapsed-only={expanded() ? "" : undefined}>
                      {lastMessageLine(row, props.viewerId, locale())}
                    </span>
                  </>
                }
              >
                <AppWorkspace.SidebarItemIcon icon={row.icon ?? (row.memberCount <= 2 ? "ti ti-user" : "ti ti-users")} />
                <AppWorkspace.SidebarItemLabel marquee={false}>
                  {row.title}
                  {/* A chat with threads has more inside; open it to see them. */}
                  <Show when={chatHasThreads(row) && !expanded()}>
                    <i class="ti ti-chevron-right chat-list__threads-mark" aria-hidden="true" />
                  </Show>
                </AppWorkspace.SidebarItemLabel>
                <AppWorkspace.SidebarItemMeta>
                  <span class="chat-list__meta">
                    <time class="chat-list__time" datetime={row.lastActivityAt}>
                      {listTime(row.lastActivityAt, props.now(), config())}
                    </time>
                    <span class="chat-list__unread">
                      {/* The open chat is being read, so it shows no mark, unless the reader marked it unread on purpose. With its
                      threads shown, each thread carries its own count instead. */}
                      <AppWorkspace.SidebarItemStatus
                        unread={row.id === props.activeId && (expanded() || row.read?.unreadFromSeq == null) ? undefined : unreadMark(row)}
                      />
                    </span>
                  </span>
                </AppWorkspace.SidebarItemMeta>
              </AppWorkspace.SidebarItem>
              <Show when={expanded() ? props.threads : undefined}>
                {(threads) => (
                  <div class="chat-list__threads">
                    <ThreadRows {...threads()} chatId={row.id} basePath={props.basePath} unread={row.unread} />
                  </div>
                )}
              </Show>
            </>
          );
        }}
      </For>
      <Show when={props.hasMore}>
        <AppWorkspace.SidebarItem icon="ti ti-dots" onClick={props.onMore}>
          {t().showMoreChats}
        </AppWorkspace.SidebarItem>
      </Show>
    </>
  );
}
