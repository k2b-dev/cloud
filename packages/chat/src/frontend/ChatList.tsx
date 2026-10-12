import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationSchema } from "../service/contracts";
import { lastMessageLine, listTime } from "./chat-format";

type Conversation = z.infer<typeof ConversationSchema>;

export const chatHref = (id: string, message?: string | null) => `/app/chat/c/${id}${message ? `/m/${message}` : ""}`;

/**
 * The chats as navigation rows, newest activity first: title, the last message with its sender, and the time. Every row
 * has the same two lines, also before the first message, so rows never change height.
 */
export default function ChatList(props: {
  rows: readonly Conversation[];
  activeId: string | null;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  hasMore: boolean;
  onOpen: (id: string, navigation: LinkNavigateEvent) => void | Promise<void>;
  onMore: () => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const config = () => ({ ...props.dateConfig, locale: locale() });
  return (
    <>
      <For each={props.rows}>
        {(row) => (
          <AppWorkspace.SidebarItem
            href={chatHref(row.id)}
            navigation="enhanced"
            onNavigate={(navigation) => props.onOpen(row.id, navigation)}
            active={row.id === props.activeId}
            description={<span class="chat-list__preview">{lastMessageLine(row, props.viewerId, locale())}</span>}
          >
            <AppWorkspace.SidebarItemIcon icon={row.icon ?? (row.memberCount <= 2 ? "ti ti-user" : "ti ti-users")} />
            <AppWorkspace.SidebarItemLabel marquee={false}>{row.title}</AppWorkspace.SidebarItemLabel>
            <AppWorkspace.SidebarItemMeta>
              <time class="chat-list__time" datetime={row.lastActivityAt}>
                {listTime(row.lastActivityAt, props.now(), config())}
              </time>
            </AppWorkspace.SidebarItemMeta>
          </AppWorkspace.SidebarItem>
        )}
      </For>
      <Show when={props.hasMore}>
        <AppWorkspace.SidebarItem icon="ti ti-dots" onClick={props.onMore}>
          {t().showMoreChats}
        </AppWorkspace.SidebarItem>
      </Show>
    </>
  );
}
