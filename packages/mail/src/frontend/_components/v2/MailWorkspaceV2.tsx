import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { announce, type DropdownItem, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Input,
  Menu,
  type MenuEntry,
  Nav,
  type NavGroup,
  type NavItem,
  type OnNavigate,
  Pane,
  StatusRow,
  type Tab,
  Tabs,
  Workspace,
} from "@k2b/ui/v2";
import { type Accessor, createComputed, createMemo, createSignal, Show } from "solid-js";
import { mailFolderNames } from "../../../folder-names";
import type { MailListItem } from "../../../service/workspace";
import { mailOverviewMessages } from "../../mail-overview-messages";
import type { MailboxController, MailWorkspaceDom } from "../../mail-workspace";
import type { MailSidebarMailbox } from "../MailSidebar";
import { createMailSearchFilterMenu } from "../MailWorkspaceHead";
import { useMailContactDirectory } from "../mail-contact-directory-context";
import { buildVisibleMailFolderTree, flattenMailFolderTree } from "../mail-folder-tree";
import { mailListRowKey } from "../mail-list-projection";
import { createMailboxManagement } from "../mail-mailbox-management";
import type { MailboxPreferences } from "../mail-mailbox-preferences";
import { orderMailboxes } from "../mail-mailbox-preferences";
import { buildMailListHref, buildMailSearchHref, buildMailSelectionHref, mailRouteUrl } from "../mail-navigation";
import MailListV2 from "./MailListV2";
import MailReaderV2 from "./MailReaderV2";
import type { MailV2Session } from "./MailReplyV2";
import { mailV2MenuEntries } from "./mail-v2-menu";
import { mailV2Messages } from "./mail-v2-messages";

/** The head shows these views as tabs; the others wait under "More". */
const HEAD_TABS = new Set(["all", "needs_action", "mine", "waiting"]);
const PRIMARY_ROLES = ["inbox", "drafts", "sent"] as const;
const SECONDARY_ROLES = new Set(["archive", "trash", "junk"]);

const folderIcon = (role: string): string =>
  ({ inbox: "inbox", drafts: "file-pencil", sent: "send", archive: "archive", trash: "trash", junk: "alert-octagon" })[role] ?? "folder";

/**
 * Where the v2 rows stand in the DOM, for the controller's focus and keys. A row opens its conversation through its
 * own link, so that link's href names it; the list registers the href of each row key while it renders. The link
 * takes the focus; the whole row holds it.
 */
export const createMailV2Dom = (): { dom: MailWorkspaceDom; rows: Map<string, string> } => {
  const rows = new Map<string, string>();
  const link = (href: string | undefined) =>
    href ? document.querySelector<HTMLElement>(`[data-k2-workspace] [data-k2-part="Row"] a[href="${CSS.escape(href)}"]`) : null;
  return {
    rows,
    dom: {
      row: (rowKey) => link(rows.get(rowKey)),
      entry: (item) => link(rows.get(mailListRowKey(item)))?.closest<HTMLElement>('[data-k2-part="Row"]') ?? null,
      // The reader's head has no focusable title; its first action takes the focus.
      readerHeading: () =>
        document.querySelector<HTMLElement>(
          '[data-k2-workspace] [data-k2-part="Pane"][data-detail] > [data-slot="head"] :is(a[href], button:not([disabled]))',
        ),
      listHeading: () => document.querySelector<HTMLElement>('[data-k2-workspace] [data-k2-part="StatusRow"] input'),
      selectionTrigger: () => document.querySelector<HTMLElement>('[data-k2-workspace] [data-k2-part="StatusRow"] input'),
      listScroller: () => document.querySelector<HTMLElement>("[data-k2-workspace] [data-scroll-preserve^='mail-list-']"),
      sideBySide: () => window.matchMedia("(min-width: 768px)").matches,
    },
  };
};

export type MailV2Shell = {
  mailboxes: MailSidebarMailbox[];
  preferences: MailboxPreferences;
  rows: Map<string, string>;
  /** Opens a mailbox in place (the shown one again at its start); a failed switch loads its page. */
  openMailbox: OnNavigate;
};

/**
 * Mail's mailbox on @k2b/ui v2 (pilot): the same controller as v1, drawn only from v2 primitives. No class, no style,
 * no CSS of its own; the message text keeps its sandboxed frame inside a `Canvas`.
 */
export default function MailWorkspaceV2(props: {
  controller: Accessor<MailboxController>;
  shell: MailV2Shell;
  dateConfig: DateContext;
  session: MailV2Session;
}) {
  const locale = useLocale();
  const text = createMemo(() => mailV2Messages.resolve([locale()]).t);
  const c = () => props.controller();
  const formatCount = (count: number) => count.toLocaleString(locale());
  const requestUrl = () => mailRouteUrl(c().requestPath());
  const [search, setSearch] = createSignal(c().data.query);

  // ── Links open in place ────────────────────────────────────────────────────────────────────────────────────────
  // Rows, tabs and sidebar entries are real links (a new tab, a page before hydration); a plain click opens them in
  // place through the same controller paths as v1's rows, tabs and sidebar.
  const openView: OnNavigate = (nav) => c().navigateWorkspace(nav);
  const openRow = (nav: LinkNavigateEvent, item: MailListItem) =>
    c().navigateConversation(nav.href, item, nav.event.detail === 0 ? "keyboard" : "pointer");
  // The head's "…": the open mailbox's rare deeds, v1's mailbox menu (settings, health, details, …), led by pinning and
  // hiding it, as v1's open sidebar row offers them.
  const overviewText = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const mailboxMenu = () => {
    const id = c().data.mailbox.id;
    const name = c().data.mailbox.name;
    const preferences = props.shell.preferences;
    const pinned = preferences.isPinned(id);
    const own: DropdownItem[] = [
      {
        items: preferences.isHidden(id)
          ? [{ label: overviewText().showMailbox({ name }), icon: "ti ti-eye", action: () => preferences.change(id, "hidden", false) }]
          : [
              {
                label: pinned ? overviewText().unpinMailbox({ name }) : overviewText().pinMailbox({ name }),
                icon: pinned ? "ti ti-flag-off" : "ti ti-flag",
                action: () => preferences.change(id, "pinned", !pinned),
              },
              { label: overviewText().hideMailbox({ name }), icon: "ti ti-eye-off", action: () => preferences.change(id, "hidden", true) },
            ],
      },
    ];
    return mailV2MenuEntries([...own, ...c().mailboxMenu.sections()]);
  };
  // The filter menu at the search field, v1's (F9): what narrows the list, all in the URL.
  const filter = createMailSearchFilterMenu({
    get requestUrl() {
      return c().requestPath();
    },
    get search() {
      return c().data.search;
    },
    get folderId() {
      return c().data.folderId;
    },
    get folders() {
      return c().data.folders;
    },
    get localTags() {
      return c().data.localTags;
    },
    get quickSearch() {
      return c().searchControls;
    },
    onEditSearch: (state, source) => {
      c().searchControls.cancelPending();
      c().searchControls.edit(state, source);
    },
    onOpenHref: (href) => {
      c().searchControls.cancelPending();
      void c().openWorkspaceHref(href);
    },
  });
  // Enter in the head's search field searches the mailbox, as v1's search field does.
  const searchKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const query = search().trim();
    void c().openWorkspaceHref(query ? buildMailSearchHref(requestUrl(), { q: query }) : buildMailListHref(requestUrl(), true));
  };

  // ── Sidebar ────────────────────────────────────────────────────────────────────────────────────────────────────
  // Each mailbox's own deeds at its row's "…", as v1's sidebar rows offer them: pin or release it, hide or show it.
  const rowMenu = (id: string, name: string): MenuEntry[] => {
    const preferences = props.shell.preferences;
    if (preferences.isHidden(id))
      return [{ label: overviewText().showMailbox({ name }), icon: "eye", onClick: () => preferences.change(id, "hidden", false) }];
    const pinned = preferences.isPinned(id);
    return [
      {
        label: pinned ? overviewText().unpinMailbox({ name }) : overviewText().pinMailbox({ name }),
        icon: pinned ? "flag-off" : "flag",
        onClick: () => preferences.change(id, "pinned", !pinned),
      },
      { label: overviewText().hideMailbox({ name }), icon: "eye-off", onClick: () => preferences.change(id, "hidden", true) },
    ];
  };
  // The group's "…": a new mailbox and the deleted ones, v1's deeds of the mailbox list.
  const contactDirectory = useMailContactDirectory();
  const canCreate = () => Boolean(props.session.currentUserId);
  const management = createMailboxManagement({
    get canCreate() {
      return canCreate();
    },
    get currentUserEmail() {
      return props.session.currentUserEmail;
    },
    contactDirectory,
  });
  const navItems = createMemo((): NavItem[] => {
    const data = c().data;
    const openId = data.mailbox.id;
    const folders = c().listCounts().folders;
    const atRoot = !data.folderId && !data.scheduledMode && !data.query && !data.activeView;
    const folderItem = (folder: (typeof folders)[number]): NavItem => ({
      label: mailFolderNames(locale())(folder),
      icon: folderIcon(folder.role),
      href: folder.selectable ? `/app/mail/${openId}?folder=${folder.id}` : undefined,
      onNavigate: openView,
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
            onNavigate: openView,
            nested: true,
            current: data.scheduledMode,
            count: data.scheduledCount > 0 ? formatCount(data.scheduledCount) : undefined,
          },
        ]
      : [];
    const secondary = tree.filter((folder) => SECONDARY_ROLES.has(folder.role)).map(folderItem);
    const own = tree.filter((folder) => !SECONDARY_ROLES.has(folder.role) && !(PRIMARY_ROLES as readonly string[]).includes(folder.role));
    // Archive, bin and spam fold under "Mehr", as in v1's sidebar; the fold opens by itself while one of them is open.
    const more: NavItem[] = secondary.length > 0 ? [{ label: c().sidebarText().more, nested: true, items: secondary }] : [];
    const opened: NavItem[] = [
      {
        label: data.mailbox.name,
        icon: "mail",
        href: `/app/mail/${openId}`,
        onNavigate: props.shell.openMailbox,
        current: atRoot,
        menu: rowMenu(data.mailbox.id, data.mailbox.name),
      },
      ...primary.slice(0, 2),
      ...outbox,
      ...primary.slice(2),
      ...own.map(folderItem),
      ...more,
    ];
    const ordered = orderMailboxes(props.shell.mailboxes, props.shell.preferences.pinnedMailboxIds());
    const visible = ordered.filter((mailbox) => mailbox.id === openId || !props.shell.preferences.isHidden(mailbox.id));
    if (!visible.some((mailbox) => mailbox.id === openId)) return opened;
    return visible.flatMap((mailbox) =>
      mailbox.id === openId
        ? opened
        : [
            {
              label: mailbox.name,
              icon: "mail",
              href: `/app/mail/${mailbox.id}`,
              onNavigate: props.shell.openMailbox,
              menu: rowMenu(mailbox.id, mailbox.name),
            } satisfies NavItem,
          ],
    );
  });
  const hiddenCount = () => props.shell.mailboxes.filter((mailbox) => props.shell.preferences.isHidden(mailbox.id)).length;
  // The sidebar's entries, also in the shell's phone menu ("Mail ⌄"), where the sidebar gives way.
  const navGroups = createMemo((): NavGroup[] => [
    {
      label: text().mailboxes,
      action: {
        label: overviewText().mailboxActions,
        items: [
          ...(canCreate()
            ? [
                {
                  label: c().sidebarText().newMailbox,
                  icon: "mail-plus",
                  disabled: management.creating(),
                  onClick: () => void management.createMailbox(),
                },
              ]
            : []),
          {
            label: overviewText().deletedMailboxes,
            icon: "trash",
            disabled: management.restoring(),
            onClick: () => void management.openDeletedMailboxes(),
          },
        ],
      },
      items: navItems(),
    },
  ]);
  // Hidden mailboxes fold into one quiet entry at the foot, as in v1's sidebar: it opens them below itself.
  const [hiddenOpen, setHiddenOpen] = createSignal(false);
  const navFoot = createMemo((): NavItem[] | undefined => {
    if (hiddenCount() === 0) return undefined;
    const hidden = orderMailboxes(props.shell.mailboxes, props.shell.preferences.pinnedMailboxIds()).filter(
      (mailbox) => mailbox.id !== c().data.mailbox.id && props.shell.preferences.isHidden(mailbox.id),
    );
    return [
      {
        label: text().hidden({ count: hiddenCount() }),
        icon: hiddenOpen() ? "chevron-down" : "chevron-right",
        onClick: () => setHiddenOpen((open) => !open),
      },
      ...(hiddenOpen()
        ? hidden.map(
            (mailbox): NavItem => ({
              label: mailbox.name,
              icon: "mail",
              href: `/app/mail/${mailbox.id}`,
              onNavigate: props.shell.openMailbox,
              nested: true,
              menu: rowMenu(mailbox.id, mailbox.name),
            }),
          )
        : []),
    ];
  });

  // ── Head ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const tabs = createMemo((): Tab[] => {
    const current = c().currentTab();
    const all = c().viewTabs();
    const shown = all.filter((tab) => HEAD_TABS.has(tab.id));
    const further = all.filter((tab) => !HEAD_TABS.has(tab.id));
    const openFurther = further.find((tab) => tab.id === current);
    return [
      ...shown.map((tab) => ({ label: tab.label, count: tab.count, href: tab.href, onNavigate: openView, current: tab.id === current })),
      ...(openFurther
        ? [{ label: openFurther.label, count: openFurther.count, href: openFurther.href, onNavigate: openView, current: true }]
        : []),
      // "Weitere +N": the views that wait behind it, each opening in place like a tab.
      ...(further.length > 0
        ? [
            {
              label: text().moreViews,
              count: `+${further.length}`,
              menu: further.map((tab) => ({
                label: tab.label,
                meta: tab.count === undefined ? undefined : String(tab.count),
                onClick: () => void c().openWorkspaceHref(tab.href),
              })),
            },
          ]
        : []),
    ];
  });
  const composeHref = () => `/app/mail/compose?mailbox=${c().data.mailbox.id}&autostart=1`;
  const compose = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!c().composeStarting()) announce(c().t().preparingMessage);
    void c().startCompose({ fallback: () => window.location.assign(composeHref()), progressToast: false });
  };

  // ── List ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const items = () => c().listView().items;
  // Where each row's link points, for the controller's focus (createMailV2Dom); kept current before the rows render.
  createComputed(() => {
    props.shell.rows.clear();
    for (const item of items()) props.shell.rows.set(mailListRowKey(item), buildMailSelectionHref(requestUrl(), item));
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

  return (
    <>
      <V2WorkspaceNavigation label={c().data.mailbox.name} groups={navGroups()} foot={navFoot()} />
      <Workspace
        sidebarLabel={text().sidebarWidth}
        // The reader opens beside the list: the workspace keeps room for it, open or not, so opening a mail never
        // moves the sidebar between column and drawer, and its place says so while none is open (#4123).
        detail
        detailEmpty={{ icon: "mail", text: text().noneOpen }}
        primary={c().canWrite() && !c().assignedOnly() ? { label: text().newShort, icon: "pencil", href: composeHref() } : undefined}
        sidebar={<Nav title="Mail" icon="mail" groups={navGroups()} foot={navFoot()} />}
        head={
          <Bar
            start={<Tabs label={text().views} items={tabs()} />}
            end={
              <>
                <Input
                  type="search"
                  icon="search"
                  label={text().search}
                  placeholder={text().search}
                  value={search()}
                  onInput={setSearch}
                  onKeyDown={searchKey}
                  end={<Menu icon="adjustments-horizontal" label={filter.label()} items={mailV2MenuEntries(filter.items())} />}
                />
                <Menu items={mailboxMenu()} />
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
            // The list keeps its width, open mail or not: the reader's empty place holds the rest.
            width={{ min: 320, default: 432 }}
            scrollKey={`mail-list-${c().data.mailbox.id}`}
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
              onOpen={openRow}
              selection={
                selecting()
                  ? {
                      selected: (item) => Boolean(item.conversationId && c().selectedConversationIds().has(item.conversationId)),
                      toggle: (item) => c().toggleConversationSelection(item, false),
                    }
                  : undefined
              }
              onRetry={() => void c().refreshList()}
              onLoadMore={() => void c().loadMoreConversations(c().requestPath())}
            />
          </Pane>
          <Show when={c().readerOpen()}>
            <MailReaderV2 controller={c()} dateConfig={props.dateConfig} text={text()} session={props.session} />
          </Show>
        </Pane.Split>
      </Workspace>
    </>
  );
}
