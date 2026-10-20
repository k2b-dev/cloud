import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { type LinkNavigateEvent, navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations, query as queries } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, createNavigation, IconButton, type NavigationItem, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, getOwner, on, onCleanup, runWithOwner, Show, untrack } from "solid-js";
import { apiClient } from "../../api/client";
import { mailCommandMessages } from "../../command-messages";
import type { ConversationView, DeletedMailbox, DeletedMailboxPage, Mailbox } from "../../contracts";
import type { MailFolderTreeNode } from "../../folder-tree";
import type { ConversationViewCounts, MailFolderView } from "../../service/messages";
import { mailOverviewMessages } from "../mail-overview-messages";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import type { MailboxCreationContext } from "./create-mailbox-dialog";
import { type MailboxMenu, MailboxMenuButton, type MailboxMenuSection } from "./MailboxMenu";
import { buildVisibleMailFolderTree, excludeMailFolderTreeRoles, flattenMailFolderTree, setsOnlyInFolder } from "./mail-folder-tree";
import { mailboxHealthPresentation, mailboxOverviewSubtitle } from "./mail-health-presentation";
import { type MailboxPreferences, orderMailboxes } from "./mail-mailbox-preferences";
import { mailSidebarMessages } from "./mail-sidebar-messages";

/** A mailbox as the sidebar lists it. */
export type MailSidebarMailbox = Pick<Mailbox, "id" | "name" | "health" | "healthReason"> & { receivingAddress: string | null };
export type MailSidebarMailboxCounts = { mailboxId: string; unread: number; needsAction: number };

/** The mailbox the page shows; only it expands to its folders. */
export type MailSidebarOpenMailbox = {
  mailboxId: string;
  mailboxName: string;
  canWrite: boolean;
  /**
   * The person may see only the conversations assigned to them: no composing, mailbox details, tools, settings, or
   * Unassigned view, which all need mailbox-wide access.
   */
  assignedOnly: boolean;
  /** The mailbox's current state from the page, which can change while it is open. */
  mailbox: Pick<MailSidebarMailbox, "health" | "healthReason" | "receivingAddress">;
  folders: MailFolderView[];
  scheduledMode: boolean;
  scheduledCount: number;
  activeFolderId: string | null;
  activeView: ConversationView | null;
  viewCounts: ConversationViewCounts;
  menu: MailboxMenu;
  /** Starts a new message from this mailbox; `fallback` opens the compose page instead. */
  onCompose: (options: { fallback: () => void; progressToast: boolean }) => void;
  /** Moves the conversation of the dragged list row, identified by the row's item ID. */
  onMoveConversation: (input: { itemId: string; destinationFolderId: string }) => void | Promise<void>;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
};

const PRIMARY_FOLDER_ROLES = new Set(["inbox", "drafts", "sent"]);
const SECONDARY_FOLDER_ROLES = new Set(["archive", "trash", "junk"]);
const SYSTEM_FOLDER_ROLES = new Set([...PRIMARY_FOLDER_ROLES, ...SECONDARY_FOLDER_ROLES]);

const folderBranchIds = (nodes: readonly MailFolderTreeNode[]): string[] =>
  nodes.flatMap((node) => [...(node.children.length > 0 ? [node.folder.id] : []), ...folderBranchIds(node.children)]);

const folderIcon = (role: string): string =>
  role === "inbox"
    ? "ti ti-inbox"
    : role === "sent"
      ? "ti ti-send"
      : role === "drafts"
        ? "ti ti-file-pencil"
        : role === "trash"
          ? "ti ti-trash"
          : role === "junk"
            ? "ti ti-alert-octagon"
            : role === "archive"
              ? "ti ti-archive"
              : "ti ti-folder";

/**
 * Mail's one sidebar, the same on Focus and in every mailbox: Focus, then the mailboxes. The open mailbox expands to
 * its folders; another mailbox is one link away.
 */
export default function MailSidebar(
  props: MailboxCreationContext & {
    mailboxes: MailSidebarMailbox[];
    preferences: MailboxPreferences;
    counts: MailSidebarMailboxCounts[];
    canCreate: boolean;
    /** Focus, or the mailbox the page shows. */
    open: MailSidebarOpenMailbox | null;
    /** Focus lists its mailboxes as chips on small screens; in a mailbox the phone opens them from the title. */
    mobile?: "stacked" | "hidden";
    /** Runs after the person hid a mailbox from the sidebar. */
    onMailboxHidden?: (mailboxId: string) => void;
    /** Opt in to island-owned mailbox navigation; Focus keeps ordinary document links. */
    onOpenMailbox?: (nav: LinkNavigateEvent) => void | Promise<void>;
    /** Whether the person collapsed what holds the open place's row: Hidden mailboxes or a folder branch. */
    onOpenPlaceRowHiddenChange?: (hidden: boolean) => void;
  },
) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  const overviewText = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const formatCount = (count: number) => count.toLocaleString(locale());

  // Only the open mailbox's ID decides the rows: live counts and a rename update the row in place, so a focused row
  // keeps its focus.
  const openMailboxId = createMemo(() => props.open?.mailboxId ?? null);
  // The open mailbox stays listed even when the readable-mailbox list leaves it out.
  const listed = createMemo<MailSidebarMailbox[]>(() => {
    const openId = openMailboxId();
    if (!openId || props.mailboxes.some((mailbox) => mailbox.id === openId)) return props.mailboxes;
    const name = untrack(() => props.open?.mailboxName ?? "");
    return [{ id: openId, name, health: "active", healthReason: null, receivingAddress: null }, ...props.mailboxes];
  });
  /** The open mailbox's name follows the page, so a rename shows at once. */
  const mailboxName = (mailbox: MailSidebarMailbox) => (isOpen(mailbox.id) ? (props.open?.mailboxName ?? mailbox.name) : mailbox.name);
  const ordered = createMemo(() => orderMailboxes(listed(), props.preferences.pinnedMailboxIds()));
  const visibleMailboxes = createMemo(() => ordered().filter((mailbox) => !props.preferences.isHidden(mailbox.id)));
  const hiddenMailboxes = createMemo(() => ordered().filter((mailbox) => props.preferences.isHidden(mailbox.id)));
  // A hidden mailbox that is open stays in view with its folders: the section opens with it, also when the person
  // hides the open mailbox while the section is closed.
  const openIsHidden = createMemo(() => hiddenMailboxes().some((mailbox) => mailbox.id === openMailboxId()));
  const [hiddenOpen, setHiddenOpen] = createSignal(untrack(openIsHidden));
  createEffect(on(openIsHidden, (hidden) => hidden && setHiddenOpen(true), { defer: true }));
  const countsById = createMemo(() => new Map(props.counts.map((entry) => [entry.mailboxId, entry])));
  const isOpen = (mailboxId: string) => openMailboxId() === mailboxId;
  const stats = (mailboxId: string) => {
    const counted = countsById().get(mailboxId) ?? { unread: 0, needsAction: 0 };
    // The open mailbox follows the page: its Needs action count is the tab's live count, and its folders below show
    // their live unread counts, so the row draws no unread dot that would only be as old as the page.
    const open = props.open;
    return open?.mailboxId === mailboxId ? { unread: 0, needsAction: open.viewCounts.needs_action } : counted;
  };

  // The open mailbox's commands, for the command palette.
  const commandMailbox = createMemo(
    () => {
      const open = props.open;
      return open ? { mailboxId: open.mailboxId, mailboxName: open.mailboxName, canCompose: open.canWrite && !open.assignedOnly } : null;
    },
    undefined,
    {
      equals: (previous, next) =>
        previous?.mailboxId === next?.mailboxId && previous?.mailboxName === next?.mailboxName && previous?.canCompose === next?.canCompose,
    },
  );
  createEffect(() => {
    const open = commandMailbox();
    if (!open) return;
    const copy = mailCommandMessages.resolve([locale()]).t;
    onCleanup(
      registerContextAwareCommand({
        id: "mail.search",
        title: copy.searchTitle,
        description: copy.searchDescription({ name: open.mailboxName }),
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: {
          search: { scope: { ref: { type: "mail.mailbox", id: open.mailboxId }, label: open.mailboxName, icon: "ti ti-inbox" } },
        },
      }),
    );
    if (!open.canCompose) return;
    const href = `/app/mail/compose?mailbox=${open.mailboxId}&autostart=1`;
    onCleanup(
      registerContextAwareCommand({
        id: "mail.compose",
        title: copy.composeTitle,
        description: copy.composeDescription({ name: open.mailboxName }),
        icon: "ti ti-mail-plus",
        shortcut: "mod+alt+n",
        action: () => untrack(() => props.open)?.onCompose({ fallback: () => navigateTo(href), progressToast: true }),
      }),
    );
  });

  // Pins and hidden mailboxes ------------------------------------------------------------------------------------------
  const [announcement, setAnnouncement] = createSignal("");
  // Below 64 rem a stacked sidebar renders twice, as chips and in the All sheet: rows are looked up in the copy that
  // has focus, read before a change moves the row.
  const rowScope = (): ParentNode => document.activeElement?.closest(".k2b-app-workspace__sidebar-sheet") ?? document;
  const rowLink = (mailboxId: string | undefined, scope: ParentNode) =>
    mailboxId ? scope.querySelector<HTMLElement>(`.mail-sidebar-mailbox[data-mailbox="${mailboxId}"] a`) : null;
  const rowHasFocus = (mailboxId: string, scope: ParentNode) =>
    scope.querySelector(`.mail-sidebar-mailbox[data-mailbox="${mailboxId}"]`)?.contains(document.activeElement) ?? false;
  // Pinning, hiding, and showing move a row or recreate it in the other section, and the browser then drops keyboard
  // focus on the page body. Put it on the given target instead.
  const restoreFocus = (hadFocus: boolean, target: HTMLElement | null) => {
    if (hadFocus && (!document.activeElement || document.activeElement === document.body)) target?.focus();
  };
  const togglePin = (mailbox: MailSidebarMailbox) => {
    const pin = !props.preferences.isPinned(mailbox.id);
    const scope = rowScope();
    const hadFocus = rowHasFocus(mailbox.id, scope);
    if (!props.preferences.change(mailbox.id, "pinned", pin)) return;
    setAnnouncement(pin ? overviewText().pinned({ name: mailboxName(mailbox) }) : overviewText().unpinned({ name: mailboxName(mailbox) }));
    restoreFocus(hadFocus, rowLink(mailbox.id, scope));
  };
  const toggleHidden = (mailbox: MailSidebarMailbox) => {
    const hide = !props.preferences.isHidden(mailbox.id);
    const scope = rowScope();
    const hadFocus = rowHasFocus(mailbox.id, scope);
    const visible = visibleMailboxes();
    const position = visible.findIndex((item) => item.id === mailbox.id);
    const neighborId = (visible[position + 1] ?? visible[position - 1])?.id;
    if (!props.preferences.change(mailbox.id, "hidden", hide)) return;
    setAnnouncement(
      hide ? overviewText().mailboxHidden({ name: mailboxName(mailbox) }) : overviewText().mailboxShown({ name: mailboxName(mailbox) }),
    );
    if (hide) props.onMailboxHidden?.(mailbox.id);
    // A hidden row lands in the collapsed Hidden section: focus the row that took its place, or that section once the
    // list is empty. A shown row stays reachable, so focus follows it.
    restoreFocus(
      hadFocus,
      hide
        ? (rowLink(neighborId, scope) ?? scope.querySelector<HTMLElement>(".mail-sidebar-hidden-mailboxes button[aria-expanded]"))
        : rowLink(mailbox.id, scope),
    );
  };

  // New and recently deleted mailboxes ----------------------------------------------------------------------------------
  const owner = getOwner();
  const [creating, setCreating] = createSignal(false);
  let creation: ReturnType<typeof import("./create-mailbox-dialog").createMailboxCreation> | undefined;
  const createMailbox = async () => {
    if (!props.canCreate || creating()) return;
    setCreating(true);
    try {
      // The dialog loads with the action that opens it, not with the page.
      const dialog = await importOnDemand(() => import("./create-mailbox-dialog"));
      if (!dialog) return;
      creation ??= runWithOwner(owner, () => dialog.createMailboxCreation(props, overviewText));
      await creation?.mutate();
    } finally {
      setCreating(false);
    }
  };
  const [deletedOpen, setDeletedOpen] = createSignal(false);
  const deletedResults = queries.createInfinite<string, DeletedMailboxPage, string>({
    source: () => "deleted-mailboxes",
    enabled: deletedOpen,
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes.deleted.$get({ query: { limit: "100", cursor } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, overviewText().failedLoadDeletedMailboxes));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "deleted-mailbox");
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const deletedMailboxes = createMemo(() => {
    const merged = new Map<string, DeletedMailbox>();
    for (const page of deletedResults.pages()) for (const mailbox of page.items) merged.set(mailbox.id, mailbox);
    return [...merged.values()];
  });
  type HealthDialog = typeof import("./MailboxHealthDialog");
  const restoreMailbox = mutations.create<{ mailbox: Mailbox; health?: HealthDialog } | null, string>({
    mutation: async (mailboxId, { abortSignal }) => {
      const confirmed = await prompts.confirm(overviewText().restoreWarning, {
        title: overviewText().restoreMailbox,
        confirmText: overviewText().restoreMailbox,
      });
      if (!confirmed || abortSignal.aborted) return null;
      // As for a new mailbox: the health dialog loads during the request, and without it the mailbox still opens.
      const health = import("./MailboxHealthDialog").catch(() => undefined);
      const response = await apiClient.mailboxes[":mailboxId"].restore.$post({ param: { mailboxId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, overviewText().failedRestoreMailbox));
      return { mailbox: await response.json(), health: await health };
    },
    onSuccess: (restored) => {
      if (!restored) return;
      const { mailbox, health } = restored;
      void deletedResults.refresh();
      toast.success(overviewText().mailboxRestored);
      if (!health) return navigateTo(`/app/mail/${mailbox.id}`);
      void health.openMailboxHealthDialog({ mailboxId: mailbox.id }).then(() => navigateTo(`/app/mail/${mailbox.id}`));
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => restoreMailbox.abort());

  // The open mailbox's folders ---------------------------------------------------------------------------------------------
  const [dropFolderId, setDropFolderId] = createSignal<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = createSignal<Set<string>>(new Set());
  const [moreExpanded, setMoreExpanded] = createSignal(false);
  const folderTree = createMemo(() => buildVisibleMailFolderTree(props.open?.folders ?? []));
  const flatFolders = createMemo(() => flattenMailFolderTree(folderTree()).map(({ folder }) => folder));
  const primaryFolders = createMemo(() => flatFolders().filter((folder) => PRIMARY_FOLDER_ROLES.has(folder.role)));
  const secondaryFolders = createMemo(() => flatFolders().filter((folder) => SECONDARY_FOLDER_ROLES.has(folder.role)));
  const customFolderTree = createMemo(() => excludeMailFolderTreeRoles(folderTree(), SYSTEM_FOLDER_ROLES));
  const customFolderBranchIds = createMemo(() => folderBranchIds(customFolderTree()));
  const activeFolderId = () => props.open?.activeFolderId ?? null;
  const openPlaceRowHidden = createMemo(() => {
    if (openIsHidden() && !hiddenOpen()) return true;
    const activeId = activeFolderId();
    const collapsed = collapsedFolders();
    const hidden = (nodes: readonly MailFolderTreeNode[], hiddenByParent = false): boolean =>
      nodes.some(
        (node) => (node.folder.id === activeId && hiddenByParent) || hidden(node.children, hiddenByParent || collapsed.has(node.folder.id)),
      );
    return hidden(customFolderTree());
  });
  createEffect(on(openPlaceRowHidden, (hidden) => props.onOpenPlaceRowHiddenChange?.(hidden)));
  const sendProblemsActive = () => !props.open?.scheduledMode && props.open?.activeView === "send_problems";
  /** A folder, Scheduled, or Send problems is open: the sidebar marks that row instead of the mailbox. */
  const placeActive = () => Boolean(props.open && (props.open.scheduledMode || activeFolderId() || sendProblemsActive()));
  const moreOpen = () => moreExpanded() || secondaryFolders().some((folder) => activeFolderId() === folder.id);
  const expandedFolderIds = () => customFolderBranchIds().filter((id) => !collapsedFolders().has(id));
  const setExpandedFolderIds = (expandedIds: readonly string[]) => {
    const expanded = new Set(expandedIds);
    setCollapsedFolders(new Set(customFolderBranchIds().filter((id) => !expanded.has(id))));
  };

  const dropConversation = (event: DragEvent, destinationFolderId: string) => {
    event.preventDefault();
    setDropFolderId(null);
    try {
      const value = JSON.parse(event.dataTransfer?.getData("application/x-cloud-mail-conversation") ?? "") as { itemId?: unknown };
      if (typeof value.itemId !== "string") return;
      void props.open?.onMoveConversation({ itemId: value.itemId, destinationFolderId });
    } catch {
      // Ignore unrelated drags; only Mail conversation payloads are accepted.
    }
  };

  // These parts render only while a mailbox is open. They read it through `open()`, so live counts and a renamed
  // mailbox show without recreating the rows.
  const open = () => props.open!;
  // `count` is the folder's unread count; Drafts pass their total and Sent nothing.
  const folderNode = (
    node: MailFolderTreeNode<MailFolderView>,
    count: { unread: number } | { total: number } | null = { unread: node.folder.unread },
  ) => {
    const folder = node.folder;
    const hasChildren = node.children.length > 0;
    // Marks where "Only in the folder" is set, not each subfolder that inherits it, like the folder settings.
    const onlyInFolder = setsOnlyInFolder(folder);
    const total = count && "total" in count && count.total > 0 ? count.total : null;
    const pin = (
      <Show when={onlyInFolder}>
        <i class="ti ti-folder-pin me-1" data-mail-folder-only aria-hidden="true" />
        <span class="sr-only">{messages().onlyInFolder}</span>
      </Show>
    );
    return (
      <AppWorkspace.NavTree.Item
        id={folder.id}
        label={folder.name}
        href={folder.selectable ? `/app/mail/${open().mailboxId}?folder=${folder.id}` : undefined}
        icon={hasChildren ? "ti ti-folder-plus" : folderIcon(folder.role)}
        expandedIcon={hasChildren ? "ti ti-folder-open" : undefined}
        // Unread counts change while the folder is on screen, so they use the shared status from the first paint,
        // which keeps a long folder name on one line.
        meta={
          count && "unread" in count ? (
            <>
              {pin}
              <AppWorkspace.SidebarItemStatus unread={count.unread} />
            </>
          ) : onlyInFolder || total !== null ? (
            <span class="inline-flex items-center tabular-nums">
              {pin}
              <Show when={total !== null}>{total}</Show>
            </span>
          ) : undefined
        }
        title={onlyInFolder ? messages().onlyInFolderTitle({ name: folder.name }) : folder.name}
        viewTransitionName={`mail-folder-${folder.id}`}
        navigation="enhanced"
        onNavigate={folder.selectable ? open().onNavigate : undefined}
        scroll="preserve"
        class={dropFolderId() === folder.id ? "bg-[var(--ui-selected)]" : undefined}
        onDragEnter={(event) => {
          event.stopPropagation();
          if (!open().canWrite || !folder.selectable) return;
          event.preventDefault();
          setDropFolderId(folder.id);
        }}
        onDragOver={(event) => {
          event.stopPropagation();
          if (!open().canWrite || !folder.selectable) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        }}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId(null);
        }}
        onDrop={(event) => {
          event.stopPropagation();
          if (open().canWrite && folder.selectable) dropConversation(event, folder.id);
        }}
      >
        <For each={node.children}>{(child) => folderNode(child)}</For>
      </AppWorkspace.NavTree.Item>
    );
  };

  const primaryFolderItems = (role: "inbox" | "drafts" | "sent") => (
    <AppWorkspace.NavTree
      ariaLabel={role === "inbox" ? messages().inboxFolders : role === "drafts" ? messages().draftFolders : messages().sentFolders}
      selectedId={activeFolderId()}
    >
      <For each={primaryFolders().filter((folder) => folder.role === role)}>
        {(folder) =>
          folderNode(
            { folder, children: [] },
            role === "drafts" ? { total: folder.total } : role === "sent" ? null : { unread: folder.unread },
          )
        }
      </For>
    </AppWorkspace.NavTree>
  );

  const folderGroup = () => (
    <div class="mail-sidebar-folders" role="group" aria-label={messages().mailboxFoldersOf({ name: open().mailboxName })}>
      <Show when={open().assignedOnly}>
        {/* Nothing here needs the whole mailbox: the line says why the lists are short. */}
        <p class="mail-assigned-only">
          <i class="ti ti-user-check shrink-0" aria-hidden="true" />
          <span class="min-w-0 k2b-truncate-fade">{messages().assignedOnly}</span>
        </p>
      </Show>
      {primaryFolderItems("inbox")}
      {primaryFolderItems("drafts")}
      <AppWorkspace.SidebarItem
        href={`/app/mail/${open().mailboxId}?scheduled=1`}
        icon="ti ti-calendar-time"
        active={open().scheduledMode}
        meta={<span class="tabular-nums">{open().scheduledCount || ""}</span>}
        viewTransitionName="mail-scheduled"
        navigation="enhanced"
        onNavigate={open().onNavigate}
        scroll="preserve"
      >
        {messages().scheduled}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarItem
        href={`/app/mail/${open().mailboxId}?view=send_problems`}
        icon="ti ti-alert-circle"
        active={sendProblemsActive()}
        meta={<span class="tabular-nums">{open().viewCounts.send_problems || ""}</span>}
        title={messages().sendProblemsDescription}
        viewTransitionName="mail-view-send_problems"
        navigation="enhanced"
        onNavigate={open().onNavigate}
        scroll="preserve"
      >
        {messages().sendProblems}
      </AppWorkspace.SidebarItem>
      {primaryFolderItems("sent")}
      <Show when={secondaryFolders().length > 0}>
        <AppWorkspace.SidebarItem
          icon={`ti ${moreOpen() ? "ti-chevron-down" : "ti-chevron-right"}`}
          onClick={() => setMoreExpanded((current) => !current)}
          data={{ expanded: moreOpen() }}
        >
          {messages().more}
        </AppWorkspace.SidebarItem>
        <Show when={moreOpen()}>
          <AppWorkspace.NavTree ariaLabel={messages().additionalFolders} selectedId={activeFolderId()}>
            <For each={secondaryFolders()}>{(folder) => folderNode({ folder, children: [] })}</For>
          </AppWorkspace.NavTree>
        </Show>
      </Show>
      <Show when={customFolderTree().length > 0}>
        <p class="mail-sidebar-folders-heading" aria-hidden="true">
          {messages().folders}
        </p>
        <AppWorkspace.NavTree
          ariaLabel={messages().mailboxFolders}
          selectedId={activeFolderId()}
          expandedIds={expandedFolderIds()}
          onExpandedIdsChange={setExpandedFolderIds}
        >
          <For each={customFolderTree()}>{(node) => folderNode(node)}</For>
        </AppWorkspace.NavTree>
      </Show>
    </div>
  );

  // Rows ----------------------------------------------------------------------------------------------------------------
  /** Pin and hide of the open row, the same actions the other rows show as buttons. */
  const rowSections = (mailbox: MailSidebarMailbox): MailboxMenuSection[] => {
    const name = mailboxName(mailbox);
    if (props.preferences.isHidden(mailbox.id))
      return [
        { items: [{ id: "show", label: overviewText().showMailbox({ name }), icon: "ti ti-eye", action: () => toggleHidden(mailbox) }] },
      ];
    const pinned = props.preferences.isPinned(mailbox.id);
    return [
      {
        items: [
          {
            id: "pin",
            label: pinned ? overviewText().unpinMailbox({ name }) : overviewText().pinMailbox({ name }),
            icon: pinned ? "ti ti-flag-off" : "ti ti-flag",
            action: () => togglePin(mailbox),
          },
          { id: "hide", label: overviewText().hideMailbox({ name }), icon: "ti ti-eye-off", action: () => toggleHidden(mailbox) },
        ],
      },
    ];
  };
  const mailboxRow = (mailbox: MailSidebarMailbox) => {
    const pinned = () => props.preferences.isPinned(mailbox.id);
    const hidden = () => props.preferences.isHidden(mailbox.id);
    const counts = () => stats(mailbox.id);
    // The open mailbox's health follows the page, so a resumed or reconnected mailbox clears its warning at once.
    const current = () => (isOpen(mailbox.id) && props.open ? { ...mailbox, ...props.open.mailbox } : mailbox);
    const health = () => mailboxHealthPresentation(current(), locale());
    const rowOpen = () => (isOpen(mailbox.id) ? props.open : null);
    // One number per row: needs action. Unread is a dot; both exact counts live in the tooltip and sr-only text.
    const countLabels = () => [
      ...(counts().needsAction > 0 ? [overviewText().needsActionCount({ count: counts().needsAction })] : []),
      ...(counts().unread > 0 ? [overviewText().unreadCount({ count: counts().unread })] : []),
    ];
    return (
      <>
        <AppWorkspace.SidebarItem
          href={`/app/mail/${mailbox.id}`}
          navigation={props.onOpenMailbox ? "enhanced" : undefined}
          scroll={props.onOpenMailbox ? "preserve" : undefined}
          onNavigate={props.onOpenMailbox}
          title={[mailboxName(mailbox), mailboxOverviewSubtitle(current(), locale()), ...countLabels()].join(" · ")}
          active={Boolean(rowOpen()) && !placeActive()}
          class="mail-sidebar-mailbox"
          data={{
            mailbox: mailbox.id,
            open: rowOpen() ? "true" : undefined,
            pinned: pinned() && !hidden() ? "true" : undefined,
            hidden: hidden() ? "true" : undefined,
          }}
          actions={
            <AppWorkspace.SidebarItemActions visibility="hover">
              {/* The open row always shows its actions, over its name: one "…" with pin and hide first leaves the
                  name readable, which is the only place the open mailbox is named. */}
              <Show
                when={rowOpen()}
                fallback={
                  <Show
                    when={!hidden()}
                    fallback={
                      <IconButton
                        label={overviewText().showMailbox({ name: mailboxName(mailbox) })}
                        size="xs"
                        variant="text"
                        onClick={() => toggleHidden(mailbox)}
                      >
                        <i class="ti ti-eye" aria-hidden="true" />
                      </IconButton>
                    }
                  >
                    <IconButton
                      label={
                        pinned()
                          ? overviewText().unpinMailbox({ name: mailboxName(mailbox) })
                          : overviewText().pinMailbox({ name: mailboxName(mailbox) })
                      }
                      size="xs"
                      variant="text"
                      aria-pressed={pinned()}
                      onClick={() => togglePin(mailbox)}
                    >
                      <i class={`ti ${pinned() ? "ti-flag-off" : "ti-flag"}`} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={overviewText().hideMailbox({ name: mailboxName(mailbox) })}
                      size="xs"
                      variant="text"
                      onClick={() => toggleHidden(mailbox)}
                    >
                      <i class="ti ti-eye-off" aria-hidden="true" />
                    </IconButton>
                  </Show>
                }
              >
                {(current) => (
                  <MailboxMenuButton
                    menu={current().menu}
                    leading={rowSections(mailbox)}
                    size="xs"
                    label={messages().mailboxMenu({ name: mailboxName(mailbox) })}
                  />
                )}
              </Show>
            </AppWorkspace.SidebarItemActions>
          }
        >
          <AppWorkspace.SidebarItemIcon>
            <i class={hidden() ? "ti ti-eye-off" : pinned() ? "ti ti-flag" : "ti ti-mail"} />
            <Show when={counts().unread > 0}>
              <span class="mail-sidebar-unread-dot" />
            </Show>
          </AppWorkspace.SidebarItemIcon>
          <AppWorkspace.SidebarItemLabel marquee={false}>{mailboxName(mailbox)}</AppWorkspace.SidebarItemLabel>
          <AppWorkspace.SidebarItemMeta>
            <Show when={health()}>
              {(problem) => (
                <i class="ti ti-alert-triangle mail-sidebar-health" data-tone={problem().tone} aria-hidden="true" title={problem().title} />
              )}
            </Show>
            <span class="mail-sidebar-needs-action" aria-hidden="true">
              {counts().needsAction > 0 ? formatCount(counts().needsAction) : ""}
            </span>
            <Show when={countLabels().length > 0 || health()}>
              <span class="sr-only">{[health()?.title, ...countLabels()].filter(Boolean).join(", ")}</span>
            </Show>
          </AppWorkspace.SidebarItemMeta>
        </AppWorkspace.SidebarItem>
        <Show when={rowOpen()}>{folderGroup()}</Show>
      </>
    );
  };

  // Phone: the title "Mailbox ⌄" opens Focus, the mailboxes, and the open mailbox's folders ----------------------------------
  const folderEntry = (open: MailSidebarOpenMailbox, node: MailFolderTreeNode<MailFolderView>): NavigationItem => {
    const folder = node.folder;
    const common = {
      id: `folder:${folder.id}`,
      label: folder.name,
      icon: folderIcon(folder.role),
      active: activeFolderId() === folder.id,
      badge: folder.role === "sent" ? undefined : (folder.role === "drafts" ? folder.total : folder.unread) || undefined,
      // The phone navigation names where "Only in the folder" is set, like the mark in the desktop sidebar.
      description: setsOnlyInFolder(folder) ? messages().onlyInFolder : undefined,
      children: node.children.map((child) => folderEntry(open, child)),
    };
    return folder.selectable
      ? { ...common, href: `/app/mail/${open.mailboxId}?folder=${folder.id}`, navigation: "enhanced", scroll: "preserve" }
      : common;
  };
  const folderEntries = (open: MailSidebarOpenMailbox): NavigationItem[] => {
    const primary = (role: string) => primaryFolders().filter((folder) => folder.role === role);
    return [
      ...[...primary("inbox"), ...primary("drafts")].map((folder) => folderEntry(open, { folder, children: [] })),
      {
        id: "scheduled",
        label: messages().scheduled,
        href: `/app/mail/${open.mailboxId}?scheduled=1`,
        icon: "ti ti-calendar-time",
        active: open.scheduledMode,
        badge: open.scheduledCount || undefined,
        navigation: "enhanced",
        scroll: "preserve",
      },
      {
        id: "view:send_problems",
        label: messages().sendProblems,
        href: `/app/mail/${open.mailboxId}?view=send_problems`,
        icon: "ti ti-alert-circle",
        active: sendProblemsActive(),
        badge: open.viewCounts.send_problems || undefined,
        navigation: "enhanced",
        scroll: "preserve",
      },
      ...primary("sent").map((folder) => folderEntry(open, { folder, children: [] })),
      ...(secondaryFolders().length > 0
        ? [
            {
              id: "more",
              label: messages().more,
              children: secondaryFolders().map((folder) => folderEntry(open, { folder, children: [] })),
            },
          ]
        : []),
      ...customFolderTree().map((node) => folderEntry(open, node)),
    ];
  };
  const mailboxEntry = (mailbox: MailSidebarMailbox): NavigationItem => {
    const open = isOpen(mailbox.id) ? props.open : null;
    return {
      id: `mailbox:${mailbox.id}`,
      label: mailboxName(mailbox),
      icon: props.preferences.isPinned(mailbox.id) ? "ti ti-flag" : "ti ti-mail",
      href: `/app/mail/${mailbox.id}`,
      navigation: props.onOpenMailbox ? "enhanced" : undefined,
      scroll: props.onOpenMailbox ? "preserve" : undefined,
      active: Boolean(open) && !placeActive(),
      context: Boolean(open),
      badge: stats(mailbox.id).needsAction || undefined,
      ...(open ? { children: folderEntries(open), defaultExpanded: true } : {}),
    };
  };
  const navigation = createNavigation({
    items: () => [
      { id: "focus", label: overviewText().focus, icon: "ti ti-focus-2", href: "/app/mail", active: !props.open },
      { id: "mailboxes", label: overviewText().mailboxes, section: true, children: visibleMailboxes().map(mailboxEntry) },
      ...(hiddenMailboxes().length > 0
        ? [{ id: "hidden", label: messages().hiddenMailboxes, children: hiddenMailboxes().map(mailboxEntry) }]
        : []),
      ...(props.canCreate
        ? [{ id: "new-mailbox", label: messages().newMailbox, icon: "ti ti-mail-plus", action: "new-mailbox", disabled: creating() }]
        : []),
    ],
    onNavigate: (event) => {
      const url = new URL(event.href, window.location.origin);
      const mailboxRow =
        props.mailboxes.some((mailbox) => url.pathname === `/app/mail/${mailbox.id}`) &&
        (url.pathname !== `/app/mail/${props.open?.mailboxId}` || !url.search);
      return mailboxRow && props.onOpenMailbox ? props.onOpenMailbox(event) : props.open?.onNavigate(event);
    },
    onAction: (action) => {
      if (action === "new-mailbox") void createMailbox();
    },
  });

  return (
    <>
      <Show when={props.open}>{(open) => <WorkspaceNavigationProvider navigation={navigation} label={open().mailboxName} />}</Show>
      <AppWorkspace.Sidebar label={overviewText().mailboxes} mobile={props.mobile ?? "hidden"} class="mail-sidebar">
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey={props.open ? `mail-sidebar-${props.open.mailboxId}` : false}>
            <AppWorkspace.SidebarSection>
              <AppWorkspace.SidebarItem href="/app/mail" icon="ti ti-focus-2" title={overviewText().focus} active={!props.open}>
                <AppWorkspace.SidebarItemLabel marquee={false}>{overviewText().focus}</AppWorkspace.SidebarItemLabel>
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarSection title={overviewText().mailboxes}>
              <For each={visibleMailboxes()}>{mailboxRow}</For>
            </AppWorkspace.SidebarSection>
            <Show when={hiddenMailboxes().length > 0}>
              <AppWorkspace.SidebarSection
                class="mail-sidebar-hidden-mailboxes"
                title={messages().hiddenMailboxes}
                count={hiddenMailboxes().length}
                collapsible
                open={hiddenOpen()}
                onOpenChange={setHiddenOpen}
              >
                <For each={hiddenMailboxes()}>{mailboxRow}</For>
              </AppWorkspace.SidebarSection>
            </Show>
            <span class="sr-only" aria-live="polite">
              {announcement()}
            </span>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter>
            <Show when={props.canCreate}>
              <AppWorkspace.SidebarItem
                icon={creating() ? "ti ti-loader-2 animate-spin" : "ti ti-mail-plus"}
                title={messages().newMailbox}
                onClick={() => void createMailbox()}
              >
                {creating() ? overviewText().creatingMailbox : messages().newMailbox}
              </AppWorkspace.SidebarItem>
            </Show>
            <AppWorkspace.SidebarItem
              icon="ti ti-trash"
              title={overviewText().recentlyDeletedMailboxes}
              onClick={() => setDeletedOpen((open) => !open)}
            >
              <AppWorkspace.SidebarItemLabel>{overviewText().recentlyDeletedMailboxes}</AppWorkspace.SidebarItemLabel>
              <AppWorkspace.SidebarItemMeta>
                <i class={deletedOpen() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
              </AppWorkspace.SidebarItemMeta>
            </AppWorkspace.SidebarItem>
            <Show when={deletedOpen()}>
              <div class="mail-sidebar-deleted" role="group" aria-label={overviewText().recentlyDeletedMailboxes}>
                <Show when={deletedResults.error()}>
                  {(error) => (
                    <Placeholder
                      state="error"
                      title={overviewText().failedLoadDeletedMailboxes}
                      description={error().message}
                      action={
                        <Button variant="secondary" size="sm" onClick={() => void deletedResults.refresh()}>
                          {overviewText().retry}
                        </Button>
                      }
                    />
                  )}
                </Show>
                <Show when={!deletedResults.error() && deletedMailboxes().length === 0}>
                  <Placeholder
                    state={deletedResults.loading() ? "loading" : "empty"}
                    title={deletedResults.loading() ? overviewText().loadingDeletedMailboxes : overviewText().noDeletedMailboxes}
                  />
                </Show>
                <For each={deletedMailboxes()}>
                  {(mailbox) => (
                    <Button
                      variant="ghost"
                      size="xs"
                      loading={restoreMailbox.loading()}
                      loadingLabel={overviewText().restoringMailbox({ name: mailbox.name })}
                      onClick={() => restoreMailbox.mutate(mailbox.id)}
                    >
                      <i class="ti ti-restore" aria-hidden="true" /> {overviewText().restoreNamedMailbox({ name: mailbox.name })}
                    </Button>
                  )}
                </For>
                <Show when={deletedResults.hasMore()}>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={deletedResults.loadingMore()}
                    onClick={() => void deletedResults.loadMore()}
                  >
                    {overviewText().loadMore}
                  </Button>
                </Show>
              </div>
            </Show>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
