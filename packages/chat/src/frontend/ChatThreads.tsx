import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, Dropdown, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { chatMessages } from "../messages";
import { activeThreads, archivedThreads, type ThreadList, type ThreadView, threadHref, threadOf, viewName, viewUnread } from "./threads";

/** The icon of a view, the same in the list, the head, the badges, and the phone's thread page. */
export const viewIcon = (view: ThreadView) =>
  view === "all" ? "ti ti-list-details" : view === "general" ? "ti ti-messages" : "ti ti-hash";

type RowsProps = {
  chatId: string;
  /** "/app/chat", or "/app/chat/panel" inside the universal panel. */
  basePath?: string;
  threads: ThreadList | null;
  status: "loading" | "ready" | "failed";
  /** The chat's whole unread count, shown at "All threads". */
  unread: number;
  /** The open view, or null when another chat or page is open. */
  view: ThreadView | null;
  canAdmin: boolean;
  /** Shows archived threads collapsed at the end, where they can be opened and restored. */
  archived?: boolean;
  onNavigate: (view: ThreadView, navigation: LinkNavigateEvent) => void | Promise<void>;
  onCreate: () => void;
  onRetry: () => void;
};

/**
 * The views of a chat with threads as list rows: "All threads", "General", the active threads by last activity, and
 * "New thread" for admins. A row is bold with its count while it has unread messages; the space for the count is
 * always there, so a count that comes or goes moves nothing.
 */
export function ThreadRows(props: RowsProps): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [archiveOpen, setArchiveOpen] = createSignal(false);
  const row = (view: ThreadView, depth = 1) => {
    const unread = () => (view === "all" ? props.unread : viewUnread(view, null, props.threads));
    // The open thread is being read; after "Mark unread from here" it shows its count again.
    const marked = () => view !== "all" && view !== "general" && threadOf(props.threads, view)?.read?.unreadFromSeq != null;
    return (
      <AppWorkspace.SidebarItem
        depth={depth}
        href={threadHref(props.chatId, view, null, props.basePath)}
        navigation="enhanced"
        onNavigate={(navigation) => props.onNavigate(view, navigation)}
        active={props.view === view}
        data={{ thread: view }}
      >
        <AppWorkspace.SidebarItemIcon icon={viewIcon(view)} />
        <AppWorkspace.SidebarItemLabel marquee={false}>{viewName(view, props.threads, t())}</AppWorkspace.SidebarItemLabel>
        <AppWorkspace.SidebarItemMeta>
          <AppWorkspace.SidebarItemStatus unread={(props.view === view && !marked()) || unread() === 0 ? undefined : unread()} />
        </AppWorkspace.SidebarItemMeta>
      </AppWorkspace.SidebarItem>
    );
  };
  return (
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
      <Show
        when={props.status === "ready"}
        fallback={
          <div class="chat-threads__loading" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        }
      >
        {row("all")}
        {row("general")}
        <For each={activeThreads(props.threads)}>{(thread) => row(thread.id)}</For>
        <Show when={props.archived && archivedThreads(props.threads).length > 0}>
          <AppWorkspace.SidebarItem
            depth={1}
            icon={archiveOpen() ? "ti ti-chevron-down" : "ti ti-chevron-right"}
            onClick={() => setArchiveOpen((open) => !open)}
          >
            {t().archivedThreads({ count: archivedThreads(props.threads).length })}
          </AppWorkspace.SidebarItem>
          <Show when={archiveOpen()}>
            <For each={archivedThreads(props.threads)}>{(thread) => row(thread.id, 2)}</For>
          </Show>
        </Show>
        <Show when={props.canAdmin}>
          <AppWorkspace.SidebarItem depth={1} icon="ti ti-plus" class="chat-threads__new" onClick={() => props.onCreate()}>
            {t().newThread}
          </AppWorkspace.SidebarItem>
        </Show>
      </Show>
    </Show>
  );
}

/**
 * The open view as a button next to the chat's title. It shows a dot while other views have unread messages and opens
 * the same views as the list, then the archived threads and, for admins, "New thread".
 */
export function ThreadPicker(
  props: Omit<RowsProps, "view" | "archived" | "status" | "onRetry" | "onNavigate"> & {
    view: ThreadView;
    /** A plain click on a view; the entry stays a link for a new tab. */
    onSelect: (view: ThreadView) => void;
  },
): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const othersUnread = () =>
    props.view !== "all" &&
    ((props.view !== "general" && (props.threads?.general.unread ?? 0) > 0) ||
      (props.threads?.items ?? []).some((thread) => thread.id !== props.view && thread.unread > 0));
  const name = () => viewName(props.view, props.threads, t());
  const entry = (view: ThreadView) => {
    const unread = view === "all" ? props.unread : viewUnread(view, null, props.threads);
    return {
      label: viewName(view, props.threads, t()),
      icon: viewIcon(view),
      class: unread > 0 && view !== props.view ? "chat-thread-picker__unread" : undefined,
      trailing: unread > 0 && view !== props.view ? <span class="chat-thread-count">{unread > 99 ? "99+" : unread}</span> : undefined,
      href: threadHref(props.chatId, view, null, props.basePath),
      action: () => props.onSelect(view),
    };
  };
  return (
    <Dropdown.Root
      position="bottom-left"
      label={t().threadsIn({ title: name() })}
      items={[
        { items: [entry("all"), entry("general"), ...activeThreads(props.threads).map((thread) => entry(thread.id))] },
        ...(archivedThreads(props.threads).length
          ? [
              {
                sectionLabel: t().archivedThreads({ count: archivedThreads(props.threads).length }),
                items: archivedThreads(props.threads).map((thread) => entry(thread.id)),
              },
            ]
          : []),
        ...(props.canAdmin ? [{ items: [{ label: t().newThread, icon: "ti ti-plus", action: () => props.onCreate() }] }] : []),
      ]}
    >
      <Dropdown.Trigger appearance="plain" class="chat-thread-picker" label={t().switchThread({ name: name() })} tooltip={false}>
        <i class={viewIcon(props.view)} aria-hidden="true" />
        <span class="chat-thread-picker__name">{name()}</span>
        <span class="chat-thread-picker__dot" data-on={othersUnread() ? "" : undefined} aria-hidden="true" />
        <Show when={othersUnread()}>
          <span class="k2b-sr-only">{t().unreadElsewhere}</span>
        </Show>
        <i class="ti ti-chevron-down" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}

/** Rename and archive for admins, in "…" at the end of the head. */
export function ThreadMenu(props: { onRename: () => void; onArchive: () => void }): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  return (
    <Dropdown.Root
      position="bottom-right"
      label={t().threadActions}
      items={[
        { label: t().renameThread, icon: "ti ti-pencil", action: () => props.onRename() },
        { label: t().archiveThread, icon: "ti ti-archive", description: t().archiveThreadHint, action: () => props.onArchive() },
      ]}
    >
      <Dropdown.Trigger iconOnly variant="ghost" label={t().threadActions}>
        <i class="ti ti-dots" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
