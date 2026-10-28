import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { dnd } from "@k2b/stdlib/solid";
import { AppWorkspace, Avatar, Dropdown, IconButton, StatusBadge, useLocale } from "@k2b/ui";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationSchema, PersonalConversationSchema } from "../service/contracts";
import { ThreadRows } from "./ChatThreads";
import { lastMessageLine, listTime } from "./chat-format";
import { containerIcon, systemMembers } from "./system-chats";
import { chatHasThreads } from "./threads";

type Conversation = z.infer<typeof ConversationSchema>;

/**
 * A chat's face in the list: its initials in its own tint, a channel's sign in a circle, and a Space's or notebook's
 * sign in a square, so a long list reads at a glance. A chosen icon replaces the initials. The tint follows the name, so a chat keeps it everywhere.
 */
export function ChatAvatar(props: { row: Pick<Conversation, "title" | "kind" | "channel" | "icon" | "resource"> }): JSX.Element {
  return (
    <Avatar
      name={props.row.title}
      size="sm"
      shape={props.row.kind === "system" ? "square" : "circle"}
      icon={
        props.row.kind === "system"
          ? containerIcon(props.row.resource?.type)
          : (props.row.icon ?? (props.row.channel ? "ti ti-speakerphone" : undefined))
      }
    />
  );
}

/** A channel's line under its name: what it is for and how many subscribe. */
export const channelLine = (row: Pick<Conversation, "purpose" | "memberCount">, t: ReturnType<typeof chatMessages.resolve>["t"]) =>
  [row.purpose, t.subscribers({ count: row.memberCount })].filter(Boolean).join(" · ");

export const chatHref = (id: string, message?: string | null) => `/app/chat/c/${id}${message ? `/m/${message}` : ""}`;

/** What a row shows of its unread state: the count, a dot for a chat marked unread without new messages, or nothing. */
const unreadMark = (row: Conversation): number | true | undefined =>
  row.unread > 0 ? row.unread : row.read?.unreadFromSeq != null ? true : undefined;

/** A partial authorized summary is a lower bound, even when its inspected page has no unread messages. */
export function IncompleteUnread(props: { count: number }) {
  const locale = useLocale();
  const label = () => chatMessages.resolve([locale()]).t.unreadIncomplete;
  return (
    <StatusBadge
      tone="neutral"
      icon={null}
      variant="text"
      title={label()}
      label={
        <>
          <span aria-hidden="true">{props.count > 0 ? `${props.count}+` : "…"}</span>
          <span class="k2b-sr-only">{label()}</span>
        </>
      }
    />
  );
}

/**
 * The chats as navigation rows, newest activity first: title, the last message with its sender, the time, and the
 * unread count below it. Every row has the same two lines in every state, also before the first message, so rows never
 * change height and a count that comes or goes moves nothing. The open chat shows no marks while it is being read; after
 * "Mark unread" it shows its count like any other.
 */
export default function ChatList(props: {
  rows: readonly Conversation[];
  system?: boolean;
  channelsActive?: boolean;
  chatsActions?: JSX.Element;
  onDiscover?: (navigation: LinkNavigateEvent) => Promise<void>;
  basePath?: string;
  activeId: string | null;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  hasMore: boolean;
  href: (id: string) => string;
  onOpen: (id: string, navigation: LinkNavigateEvent) => void | Promise<void>;
  onMore: () => void;
  onPersonal: (id: string, patch: z.infer<typeof PersonalConversationSchema>) => void;
  pending: boolean;
  onReorder?: (id: string, direction: "up" | "down") => void;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  /** The open chat's threads, shown as rows under it; the chat's own row then shows its members instead of a count. */
  threads?: Omit<Parameters<typeof ThreadRows>[0], "chatId" | "unread">;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const config = () => ({ ...props.dateConfig, locale: locale() });
  const drag = dnd.create<{ title: string }, { title: string }, "before" | "after">({
    buildIntent: ({ over, pointer }) => (over && pointer.y > over.center.y ? "after" : "before"),
    onDrop: ({ active, over, intent, mode }) => {
      if (!over || active.id === over.id) return;
      const target = props.rows.findIndex((row) => row.id === over.id);
      const after = mode === "keyboard" ? target > props.rows.findIndex((row) => row.id === active.id) : intent === "after";
      props.onPersonal(active.id, { pinned: true, ...(after ? { after: over.id } : { before: over.id }) });
    },
    announcements: {
      dragStart: (active) => t().pinPickedUp({ title: active.meta.title }),
      dragOver: (_active, over) => (over ? t().pinMoveTarget({ title: over.meta.title }) : t().pinMoveCancelled),
      drop: (active, over) => (over && active.id !== over.id ? t().pinMoved : t().pinMoveCancelled),
      cancel: () => t().pinMoveCancelled,
    },
  });
  const rowsById = createMemo(() => new Map(props.rows.map((row) => [row.id, row])));
  const rows = () => (
    <For each={props.rows.map((row) => row.id)}>
      {(id) => {
        const row = createMemo<Conversation>((previous) => rowsById().get(id) ?? previous, rowsById().get(id)!);
        const expanded = () => row().id === props.activeId && props.threads !== undefined && chatHasThreads(row());
        return (
          <div
            ref={(element) => {
              drag.draggable(element, () => ({
                id: row().id,
                meta: { title: row().title },
                disabled: row().pinnedRank === null || props.pending,
                focusable: false,
                keyboard: true,
                handleSelector: "[data-pin-handle]",
              }));
              drag.droppable(element, () => ({
                id: row().id,
                meta: { title: row().title },
                disabled: row().pinnedRank === null || props.pending,
              }));
            }}
          >
            <AppWorkspace.SidebarItem
              href={props.href(row().id)}
              navigation="enhanced"
              onNavigate={(navigation) => props.onOpen(row().id, navigation)}
              // With its threads shown, the open thread's row carries the selection, not the chat's.
              active={row().id === props.activeId && !expanded()}
              actions={
                <AppWorkspace.SidebarItemActions visibility="hover">
                  <Show when={props.onReorder}>
                    <IconButton
                      label={t().movePinnedChat({ title: row().title })}
                      size="xs"
                      variant="ghost"
                      data-pin-handle
                      style={{ "touch-action": "none" }}
                      aria-disabled={props.pending}
                    >
                      <i class="ti ti-grip-vertical" aria-hidden="true" />
                    </IconButton>
                  </Show>
                  <Dropdown.Root
                    position="bottom-right"
                    items={[
                      ...(row().kind === "system"
                        ? []
                        : [
                            {
                              label: row().archived ? t().restoreChat : t().archiveChat,
                              icon: "ti ti-archive",
                              disabled: props.pending,
                              action: () => props.onPersonal(row().id, { archived: !row().archived }),
                            },
                            {
                              label: row().pinnedRank === null ? t().pinChat : t().unpinChat,
                              icon: "ti ti-pin",
                              disabled: props.pending,
                              action: () => props.onPersonal(row().id, { pinned: row().pinnedRank === null }),
                            },
                            ...(props.onReorder
                              ? [
                                  {
                                    label: t().moveUp,
                                    icon: "ti ti-arrow-up",
                                    disabled: props.pending || props.rows[0]?.id === row().id,
                                    action: () => props.onReorder?.(row().id, "up"),
                                  },
                                  {
                                    label: t().moveDown,
                                    icon: "ti ti-arrow-down",
                                    disabled: props.pending || props.rows.at(-1)?.id === row().id,
                                    action: () => props.onReorder?.(row().id, "down"),
                                  },
                                ]
                              : []),
                          ]),
                      unreadMark(row()) === undefined
                        ? { label: t().markUnread, icon: "ti ti-mail", action: () => props.onMarkUnread(row().id) }
                        : { label: t().markRead, icon: "ti ti-mail-opened", action: () => props.onMarkRead(row().id) },
                    ]}
                  >
                    <Dropdown.Trigger
                      iconOnly
                      label={t().chatActions({ title: row().title })}
                      tooltip={t().chatActions({ title: row().title })}
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
                    <span class="chat-list__preview chat-list__members">
                      {row().kind === "system" ? systemMembers(row().resource?.type, t()) : t().members({ count: row().memberCount })}
                    </span>
                  </Show>
                  <span class="chat-list__preview" data-collapsed-only={expanded() ? "" : undefined}>
                    {row().kind === "system" && !row().lastMessage
                      ? systemMembers(row().resource?.type, t())
                      : row().channel
                        ? channelLine(row(), t())
                        : lastMessageLine(row(), props.viewerId, locale())}
                  </span>
                </>
              }
            >
              <AppWorkspace.SidebarItemIcon>
                <ChatAvatar row={row()} />
              </AppWorkspace.SidebarItemIcon>
              <AppWorkspace.SidebarItemLabel marquee={false}>
                {row().title}
                {/* A chat with threads has more inside; open it to see them. */}
                <Show when={chatHasThreads(row()) && !expanded()}>
                  <i class="ti ti-chevron-right chat-list__threads-mark" aria-hidden="true" />
                </Show>
              </AppWorkspace.SidebarItemLabel>
              <AppWorkspace.SidebarItemMeta>
                <span class="chat-list__meta">
                  <time class="chat-list__time" datetime={row().lastActivityAt}>
                    {listTime(row().lastActivityAt, props.now(), config())}
                  </time>
                  <span class="chat-list__unread">
                    {/* The open chat is being read, so it shows no mark, unless the reader marked it unread on purpose. With its
                      threads shown, each thread carries its own count instead. */}
                    <Show
                      when={row().summaryCursor != null}
                      fallback={
                        <AppWorkspace.SidebarItemStatus
                          unread={
                            row().id === props.activeId && (expanded() || row().read?.unreadFromSeq == null) ? undefined : unreadMark(row())
                          }
                        />
                      }
                    >
                      <IncompleteUnread count={row().unread} />
                    </Show>
                  </span>
                </span>
              </AppWorkspace.SidebarItemMeta>
            </AppWorkspace.SidebarItem>
            <Show when={expanded() ? props.threads : undefined}>
              {(threads) => (
                <div class="chat-list__threads">
                  <ThreadRows {...threads()} chatId={row().id} basePath={props.basePath} unread={row().unread} />
                </div>
              )}
            </Show>
          </div>
        );
      }}
    </For>
  );
  return (
    <>
      {rows()}
      <Show when={props.hasMore}>
        <AppWorkspace.SidebarItem icon="ti ti-dots" onClick={props.onMore}>
          {t().showMoreChats}
        </AppWorkspace.SidebarItem>
      </Show>
    </>
  );
}
