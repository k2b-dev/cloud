import {
  captureScroll,
  documentNavigate,
  type EnhancedNavigateOptions,
  type LinkNavigateEvent,
  navigate,
  restoreScroll,
} from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { announce, useLocale } from "@k2b/ui";
import { Bar, Button, Input, Nav, type NavItem, Pane, StatusRow, Tabs, Workspace } from "@k2b/ui/v2";
import { type Accessor, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { mailFolderNames } from "../../../folder-names";
import type { MailListItem } from "../../../service/workspace";
import type { MailboxController, MailWorkspaceDom } from "../../MailWorkspace.island";
import type { MailSidebarMailbox } from "../MailSidebar";
import { buildVisibleMailFolderTree, flattenMailFolderTree } from "../mail-folder-tree";
import { mailListRowKey } from "../mail-list-projection";
import type { MailboxPreferences } from "../mail-mailbox-preferences";
import { orderMailboxes } from "../mail-mailbox-preferences";
import {
  buildMailListHref,
  buildMailSearchHref,
  buildMailSelectionHref,
  isMailWorkspaceUrl,
  mailRouteUrl,
  resolveMailWorkspaceUrl,
} from "../mail-navigation";
import MailListV2 from "./MailListV2";
import MailReaderV2 from "./MailReaderV2";
import { mailV2Messages } from "./mail-v2-messages";

/** The head shows these views as tabs; the others wait under "More". */
const HEAD_TABS = new Set(["all", "needs_action", "mine", "waiting"]);
const PRIMARY_ROLES = ["inbox", "drafts", "sent"] as const;
const SECONDARY_ROLES = new Set(["archive", "trash", "junk"]);

const folderIcon = (role: string): string =>
  ({ inbox: "inbox", drafts: "file-pencil", sent: "send", archive: "archive", trash: "trash", junk: "alert-octagon" })[role] ?? "folder";

/**
 * Where the v2 rows stand in the DOM, for the controller's focus and keys. A row is a link to its conversation, so its
 * href names it; the list registers the href of each row key while it renders.
 */
export const createMailV2Dom = (): { dom: MailWorkspaceDom; rows: Map<string, string> } => {
  const rows = new Map<string, string>();
  const byHref = (href: string | undefined) =>
    href ? document.querySelector<HTMLElement>(`[data-k2-workspace] [data-k2-part="Row"][href="${CSS.escape(href)}"]`) : null;
  return {
    rows,
    dom: {
      row: (rowKey) => byHref(rows.get(rowKey)),
      entry: (item) => byHref(rows.get(mailListRowKey(item))),
      // The reader's head has no focusable title; its first action takes the focus.
      readerHeading: () =>
        document.querySelector<HTMLElement>(
          '[data-k2-workspace] [data-k2-part="Pane"][data-detail] > [data-slot="head"] :is(a[href], button:not([disabled]))',
        ),
      listHeading: () => document.querySelector<HTMLElement>('[data-k2-workspace] [data-k2-part="StatusRow"] input'),
      selectionTrigger: () => document.querySelector<HTMLElement>('[data-k2-workspace] [data-k2-part="StatusRow"] input'),
      sideBySide: () => window.matchMedia("(min-width: 768px)").matches,
    },
  };
};

export type MailV2Shell = {
  mailboxes: MailSidebarMailbox[];
  preferences: MailboxPreferences;
  rows: Map<string, string>;
  /** Opens another mailbox in place; a failed switch loads its page. */
  openMailbox: (url: URL, event: MouseEvent) => void | Promise<void>;
};

/**
 * A plain click on a link that the island opens in place, in the shape `@k2b/ssr/nav`'s `Link` hands its handler:
 * history moves only when the island commits, and a failure loads the page. Temporary with the delegated clicks.
 */
export const linkNavigation = (url: URL, event: MouseEvent): LinkNavigateEvent => {
  const scrollSnapshot = captureScroll();
  const move = (href: string, options: EnhancedNavigateOptions, replace: boolean) =>
    navigate(href, {
      ...options,
      replace,
      scroll: options.scroll ?? "preserve",
      scrollSnapshot: options.scrollSnapshot ?? scrollSnapshot,
      viewTransition: false,
    });
  return {
    event,
    href: `${url.pathname}${url.search}`,
    url,
    replace: false,
    scroll: "preserve",
    push: (href = url.href, options = {}) => move(href, options, false),
    replaceWith: (href = url.href, options = {}) => move(href, options, true),
    fallback: (href = url.href) => documentNavigate(href),
    scrollSnapshot,
    captureScroll,
    restoreScroll,
  };
};

/**
 * Mail's mailbox on @k2b/ui v2 (pilot): the same controller as v1, drawn only from v2 primitives. No class, no style,
 * no CSS of its own; the message text keeps its sandboxed frame inside a `Canvas`.
 */
export default function MailWorkspaceV2(props: {
  controller: Accessor<MailboxController>;
  shell: MailV2Shell;
  dateConfig: DateContext;
  reply?: () => import("solid-js").JSX.Element;
}) {
  const locale = useLocale();
  const text = createMemo(() => mailV2Messages.resolve([locale()]).t);
  const c = () => props.controller();
  const formatCount = (count: number) => count.toLocaleString(locale());
  const requestUrl = () => mailRouteUrl(c().requestPath());

  // ── Sidebar ────────────────────────────────────────────────────────────────────────────────────────────────────
  const navItems = createMemo((): NavItem[] => {
    const data = c().data;
    const openId = data.mailbox.id;
    const folders = c().listCounts().folders;
    const atRoot = !data.folderId && !data.scheduledMode && !data.query && !data.activeView;
    const folderItem = (folder: (typeof folders)[number]): NavItem => ({
      label: mailFolderNames(locale())(folder),
      icon: folderIcon(folder.role),
      href: folder.selectable ? `/app/mail/${openId}?folder=${folder.id}` : undefined,
      nested: true,
      current: data.folderId === folder.id,
      count:
        folder.role === "drafts"
          ? folder.total > 0
            ? formatCount(folder.total)
            : undefined
          : folder.unread > 0
            ? formatCount(folder.unread)
            : undefined,
    });
    const tree = flattenMailFolderTree(buildVisibleMailFolderTree(folders))
      .filter((entry) => !entry.hiddenByParent)
      .map((entry) => entry.folder);
    const primary = PRIMARY_ROLES.flatMap((role) => tree.filter((folder) => folder.role === role)).map(folderItem);
    const outbox: NavItem[] = c().canWrite()
      ? [
          {
            label: c().sidebarText().scheduled,
            icon: "calendar-time",
            href: `/app/mail/${openId}?scheduled=1`,
            nested: true,
            current: data.scheduledMode,
            count: data.scheduledCount > 0 ? formatCount(data.scheduledCount) : undefined,
          },
        ]
      : [];
    const secondary = tree.filter((folder) => SECONDARY_ROLES.has(folder.role)).map(folderItem);
    const own = tree.filter((folder) => !SECONDARY_ROLES.has(folder.role) && !(PRIMARY_ROLES as readonly string[]).includes(folder.role));
    const opened: NavItem[] = [
      { label: data.mailbox.name, icon: "mail", href: `/app/mail/${openId}`, current: atRoot },
      ...primary.slice(0, 2),
      ...outbox,
      ...primary.slice(2),
      ...secondary,
      ...own.map(folderItem),
    ];
    const ordered = orderMailboxes(props.shell.mailboxes, props.shell.preferences.pinnedMailboxIds());
    const visible = ordered.filter((mailbox) => mailbox.id === openId || !props.shell.preferences.isHidden(mailbox.id));
    if (!visible.some((mailbox) => mailbox.id === openId)) return opened;
    return visible.flatMap((mailbox) =>
      mailbox.id === openId ? opened : [{ label: mailbox.name, icon: "mail", href: `/app/mail/${mailbox.id}` } satisfies NavItem],
    );
  });
  const hiddenCount = () => props.shell.mailboxes.filter((mailbox) => props.shell.preferences.isHidden(mailbox.id)).length;

  // ── Head ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const tabs = createMemo(() => {
    const current = c().currentTab();
    const all = c().viewTabs();
    const shown = all.filter((tab) => HEAD_TABS.has(tab.id));
    const further = all.filter((tab) => !HEAD_TABS.has(tab.id));
    const openFurther = further.find((tab) => tab.id === current);
    return [
      ...shown.map((tab) => ({ label: tab.label, count: tab.count, href: tab.href, current: tab.id === current })),
      ...(openFurther ? [{ label: openFurther.label, count: openFurther.count, href: openFurther.href, current: true }] : []),
      ...(further.length > 0 ? [{ label: text().moreViews, count: `+${further.length}`, menu: true }] : []),
    ];
  });
  const composeHref = () => `/app/mail/compose?mailbox=${c().data.mailbox.id}&autostart=1`;
  const compose = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!c().composeStarting()) announce(c().t().preparingMessage);
    void c().startCompose({ fallback: () => window.location.assign(composeHref()), progressToast: false });
  };
  const [search, setSearch] = createSignal(c().data.query);

  // ── List ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const items = () => c().listView().items;
  const rowItems = createMemo(() => {
    const byHref = new Map<string, MailListItem>();
    props.shell.rows.clear();
    for (const item of items()) {
      const href = buildMailSelectionHref(requestUrl(), item);
      byHref.set(href, item);
      props.shell.rows.set(mailListRowKey(item), href);
    }
    return byHref;
  });
  const unreadCount = () => {
    const data = c().data;
    const folders = c().listCounts().folders;
    const folder = folders.find((entry) => entry.id === data.folderId) ?? folders.find((entry) => entry.role === "inbox");
    return folder?.unread ?? 0;
  };
  const selectionCount = () => c().selectedConversationIds().size;
  const selecting = () => c().canWrite() && c().selectionMode() && selectionCount() > 0;
  const runOnSelection = (actionId: "archive" | "trash") => void c().runAction(actionId);

  // ── Links open in place ────────────────────────────────────────────────────────────────────────────────────────
  // Rows, tabs and sidebar entries are real links (a new tab, a page before hydration). A plain click opens them in
  // place, as v1's rows and tabs do. Temporary: the v2 primitives take no navigation handler yet (gap reported).
  onMount(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target || !anchor.closest("[data-k2-workspace]")) return;
      const href = anchor.getAttribute("href") ?? "";
      const controller = c();
      if (resolveMailWorkspaceUrl(href, controller.data.mailbox.id, window.location.origin)) {
        event.preventDefault();
        const item = rowItems().get(href);
        if (item) void controller.navigateConversation(href, item, event.detail === 0 ? "keyboard" : "pointer");
        else if (controller.hasSelection() && href === buildMailListHref(requestUrl()))
          void controller.closeConversationAt(href, (options) => navigate(href, options));
        else void controller.openWorkspaceHref(href);
        return;
      }
      const url = new URL(href, window.location.origin);
      if (props.shell.mailboxes.some((mailbox) => isMailWorkspaceUrl(url, mailbox.id, window.location.origin))) {
        event.preventDefault();
        void props.shell.openMailbox(url, event);
      }
    };
    // Enter in the head's search field searches the mailbox, as v1's search field does.
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing || !(event.target instanceof HTMLInputElement)) return;
      if (event.target.type !== "search" || !event.target.closest('[data-k2-workspace] [data-slot="head"]')) return;
      event.preventDefault();
      const query = event.target.value.trim();
      void c().openWorkspaceHref(query ? buildMailSearchHref(requestUrl(), { q: query }) : buildMailListHref(requestUrl(), true));
    };
    document.addEventListener("click", click);
    document.addEventListener("keydown", keydown);
    onCleanup(() => {
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", keydown);
    });
  });

  return (
    <Workspace
      sidebarLabel={text().sidebarWidth}
      primary={c().canWrite() && !c().assignedOnly() ? { label: text().newShort, icon: "pencil", href: composeHref() } : undefined}
      sidebar={
        <Nav
          title="Mail"
          icon="mail"
          groups={[{ label: text().mailboxes, items: navItems() }]}
          foot={hiddenCount() > 0 ? [{ label: text().hidden({ count: hiddenCount() }), icon: "eye-off" }] : undefined}
        />
      }
      head={
        <Bar
          start={<Tabs label={text().views} items={tabs()} />}
          end={
            <>
              <Input type="search" icon="search" label={text().search} placeholder={text().search} value={search()} onInput={setSearch} />
              <Button variant="ghost" icon="dots" label={text().moreActions} disabled />
              <Show when={c().canWrite() && !c().assignedOnly()}>
                <Button variant="primary" icon="pencil" href={composeHref()} onClick={compose}>
                  {c().sidebarText().compose}
                </Button>
              </Show>
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={text().listWidth}
          width={c().readerOpen() ? { min: 320, default: 432 } : undefined}
          status={
            <StatusRow
              select={
                c().canWrite() && items().some((item) => item.conversationId)
                  ? {
                      label: c().t().selectAllConversations,
                      checked: selectionCount() === 0 ? false : selectionCount() >= items().length ? true : "mixed",
                      onChange: () => c().toggleAllConversations(),
                    }
                  : undefined
              }
              lead={text().unread({ count: formatCount(unreadCount()) })}
              facts={
                c().data.listMode === "conversations"
                  ? [
                      {
                        before: text().today,
                        value: c().data.doneTodayCounts.doneToday,
                        after: text().done({ automated: c().data.doneTodayCounts.doneByAutomation }),
                      },
                    ]
                  : undefined
              }
              selection={
                selecting()
                  ? {
                      count: text().selected({ count: formatCount(selectionCount()) }),
                      actions: [
                        { label: text().done_, icon: "check", onClick: () => void c().completeSelection() },
                        { label: text().archive, icon: "archive", onClick: () => runOnSelection("archive") },
                        { label: text().delete, icon: "trash", onClick: () => runOnSelection("trash") },
                      ],
                      clear: { label: text().clearSelection, onClick: () => c().exitHeadSelection() },
                    }
                  : undefined
              }
            />
          }
        >
          <MailListV2
            items={items()}
            requestPath={c().requestPath()}
            selectedConversationId={c().data.selectedConversationId}
            selectedMessageId={c().data.selectedMessageId}
            dateConfig={props.dateConfig}
            error={c().data.listError}
            nextCursor={c().data.nextListCursor}
            assigneeNames={c().assigneeNames}
            text={text()}
            label={c().t().conversationList}
            onRetry={() => void c().refreshList()}
            onLoadMore={() => void c().loadMoreConversations(c().requestPath())}
          />
        </Pane>
        <Show when={c().readerOpen()}>
          <MailReaderV2 controller={c()} dateConfig={props.dateConfig} text={text()} reply={props.reply?.()} />
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
