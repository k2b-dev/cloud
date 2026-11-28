import type { MenuEntry, MenuItem, OnNavigate } from "@k2b/ui/v2";
import type { chatMessages } from "../../messages";
import { viewIcon } from "../ChatThreads";
import {
  activeThreads,
  archivedThreads,
  systemThreadRows,
  type ThreadList,
  type ThreadView,
  threadHref,
  viewName,
  viewUnread,
} from "../threads";
import { iconName } from "./ChatListV2";

type Messages = ReturnType<typeof chatMessages.resolve>["t"];

/**
 * The parts of a chat to switch between, as v1's thread picker offers them: all threads, the general thread, the open
 * threads with their unread counts, the archived ones under their heading, the overview of a place's discussions, and
 * a new thread for whoever may start one. One choice: the open part carries the tick.
 */
export const threadMenu = (options: {
  t: Messages;
  chatId: string;
  basePath: string;
  view: ThreadView;
  threads: ThreadList | null;
  unread: number;
  system: boolean;
  canAdmin: boolean;
  creating: boolean;
  total: number | undefined;
  onSelect: (view: ThreadView) => OnNavigate;
  onOverview: OnNavigate;
  onCreate: () => void;
}): MenuEntry[] => {
  const { t } = options;
  const entry = (view: ThreadView): MenuItem => {
    const unread = view === "all" ? options.unread : viewUnread(view, null, options.threads);
    return {
      label: viewName(view, options.threads, t),
      icon: iconName(viewIcon(view, options.threads)),
      value: view,
      meta: unread > 0 && view !== options.view ? unread.toLocaleString() : undefined,
      href: threadHref(options.chatId, view, null, options.basePath),
      onNavigate: options.onSelect(view),
    };
  };
  const open = [
    entry("all"),
    ...(options.system ? [] : [entry("general")]),
    ...(options.system ? systemThreadRows(options.threads, options.view) : activeThreads(options.threads)).map((thread) =>
      entry(thread.id),
    ),
  ];
  const archived = options.system ? [] : archivedThreads(options.threads).map((thread) => entry(thread.id));
  return [
    { title: t.threadsIn({ title: viewName(options.view, options.threads, t) }), items: open, choice: options.view },
    ...(archived.length
      ? [{ title: t.archivedThreads({ count: archived.length }), items: archived, choice: options.view } satisfies MenuEntry]
      : []),
    ...(options.system
      ? [
          {
            label: options.total === undefined ? t.browseAllThreads : t.allThreadCount({ count: options.total }),
            icon: "list",
            href: `${options.basePath}/c/${encodeURIComponent(options.chatId)}/threads`,
            onNavigate: options.onOverview,
          } satisfies MenuEntry,
        ]
      : []),
    ...(options.canAdmin
      ? [
          {
            label: options.system ? t.discussElement : t.newThread,
            icon: "plus",
            disabled: options.creating,
            onClick: options.onCreate,
          } satisfies MenuEntry,
        ]
      : []),
  ];
};
