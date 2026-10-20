import type { ViewTab } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import type { ConversationView } from "../../contracts";
import type { ConversationViewCounts } from "../../service/messages";
import type { SavedConversationView } from "../../service/saved-views";

/** The mailbox's work views as head tabs: All first, as the mailbox opens without a view, then More. */
export const MAILBOX_TAB_VIEWS = ["needs_action", "mine", "waiting", "unassigned", "snoozed", "done", "recently_active", "kept"] as const;
type MailboxTabView = (typeof MAILBOX_TAB_VIEWS)[number];

/**
 * Which tab the mailbox route shows. A folder, Scheduled, and Send problems are places in the sidebar and show no
 * tabs, as folder, view, and saved view exclude each other in the service. A mailbox-wide search shows All.
 */
export const mailboxCurrentTab = (state: {
  scheduledMode: boolean;
  draftsMode: boolean;
  folderId: string | null;
  activeView: ConversationView | null;
  savedViewId: string | null;
}): string | null => {
  if (state.scheduledMode || state.draftsMode || state.folderId || state.activeView === "send_problems") return null;
  if (state.savedViewId) return `saved:${state.savedViewId}`;
  return state.activeView ?? "all";
};

export const mailboxViewTabs = (input: {
  mailboxId: string;
  viewCounts: ConversationViewCounts;
  savedViews: readonly SavedConversationView[];
  /** A person who sees only assigned conversations has no Unassigned view. */
  assignedOnly: boolean;
  labels: { all: string } & Record<MailboxTabView, string>;
  formatCount: (count: number) => string;
}): ViewTab[] => [
  { id: "all", label: input.labels.all, href: `/app/mail/${input.mailboxId}` },
  ...MAILBOX_TAB_VIEWS.filter((view) => !(input.assignedOnly && view === "unassigned")).map((view) => ({
    id: view,
    label: input.labels[view],
    href: `/app/mail/${input.mailboxId}?view=${view}`,
    count: input.formatCount(input.viewCounts[view]),
  })),
  ...input.savedViews.map((view) => ({
    id: `saved:${view.id}`,
    label: view.name,
    icon: view.scope === "private" ? "ti ti-user" : "ti ti-users",
    href: `/app/mail/${input.mailboxId}?savedView=${view.id}`,
  })),
];

/**
 * Tabs are document links, so a modified click, a new tab, and a page before hydration open the URL. A plain click on
 * a tab, in the strip or under More, opens the view in place instead.
 */
export function openViewTabsInPlace(items: () => readonly ViewTab[], open: (href: string) => void) {
  onMount(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const href = anchor?.getAttribute("href");
      if (!href || !items().some((item) => item.href === href)) return;
      event.preventDefault();
      open(href);
    };
    document.addEventListener("click", onClick);
    onCleanup(() => document.removeEventListener("click", onClick));
  });
}
