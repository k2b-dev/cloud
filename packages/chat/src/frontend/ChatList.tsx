import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { dnd } from "@k2b/stdlib/solid";
import { AppWorkspace, Dropdown, IconButton, useLocale } from "@k2b/ui";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationSchema, PersonalConversationSchema } from "../service/contracts";
import { lastMessageLine, listTime } from "./chat-format";

type Conversation = z.infer<typeof ConversationSchema>;

export const chatHref = (id: string, message?: string | null) => `/app/chat/c/${id}${message ? `/m/${message}` : ""}`;

/** What a row shows of its unread state: the count, a dot for a chat marked unread without new messages, or nothing. */
const unreadMark = (row: Conversation): number | true | undefined =>
  row.unread > 0 ? row.unread : row.read?.unreadFromSeq != null ? true : undefined;

/**
 * The chats as navigation rows, newest activity first: title, the last message with its sender, the time, and the
 * unread count below it. Every row has the same two lines in every state, also before the first message, so rows never
 * change height and a count that comes or goes moves nothing. The open chat shows no marks: it is being read.
 */
export default function ChatList(props: {
  rows: readonly Conversation[];
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
      drop: () => t().pinMoved,
      cancel: () => t().pinMoveCancelled,
    },
  });
  const rowsById = createMemo(() => new Map(props.rows.map((row) => [row.id, row])));
  return (
    <>
      <For each={props.rows.map((row) => row.id)}>
        {(id) => {
          // Personal/read updates replace projections; keep the row and its keyboard focus by conversation ID.
          const row = createMemo<Conversation>((previous) => rowsById().get(id) ?? previous, rowsById().get(id)!);
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
                active={row().id === props.activeId}
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
                description={<span class="chat-list__preview">{lastMessageLine(row(), props.viewerId, locale())}</span>}
              >
                <AppWorkspace.SidebarItemIcon
                  icon={row().icon ?? (row().memberCount <= 2 ? "ti ti-user" : "ti ti-users")}
                />
                <AppWorkspace.SidebarItemLabel marquee={false}>
                  {row().title}
                </AppWorkspace.SidebarItemLabel>
                <AppWorkspace.SidebarItemMeta>
                  <span class="chat-list__meta">
                    <time class="chat-list__time" datetime={row().lastActivityAt}>
                      {listTime(row().lastActivityAt, props.now(), config())}
                    </time>
                    <span class="chat-list__unread">
                      <AppWorkspace.SidebarItemStatus unread={row().id === props.activeId ? undefined : unreadMark(row())} />
                    </span>
                  </span>
                </AppWorkspace.SidebarItemMeta>
              </AppWorkspace.SidebarItem>
            </div>
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
