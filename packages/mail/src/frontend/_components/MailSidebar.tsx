import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { documentNavigate, type LinkNavigateEvent, navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  createNavigation,
  Dropdown,
  type DropdownSection,
  IconButton,
  type NavigationItem,
  prompts,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { mailCommandMessages } from "../../commands";
import type { ConversationView } from "../../contracts";
import type { MailFolderTreeNode } from "../../folder-tree";
import { serializeMailSearchState } from "../../search-state";
import type { LocalTag } from "../../service/local-tags";
import type { ConversationViewCounts, MailFolderView } from "../../service/messages";
import type { SavedConversationView } from "../../service/saved-views";
import { readApiError } from "./api-response";
import { registerMailtoHandler } from "./mail-compose-route";
import { buildVisibleMailFolderTree, excludeMailFolderTreeRoles, flattenMailFolderTree, setsOnlyInFolder } from "./mail-folder-tree";
import { mailSidebarMessages } from "./mail-sidebar-messages";

type MailViewItem = {
  id: ConversationView;
  label: string;
  icon: string;
  description?: string;
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

export default function MailSidebar(props: {
  mailboxId: string;
  mailboxName: string;
  syncEnabled: boolean;
  needsConnection: boolean;
  folders: MailFolderView[];
  localTags: LocalTag[];
  savedViews: SavedConversationView[];
  scheduledMode: boolean;
  scheduledCount: number;
  activeFolderId: string | null;
  activeView: ConversationView | null;
  activeSavedViewId: string | null;
  activeTagId: string | null;
  searchActive: boolean;
  viewCounts: ConversationViewCounts;
  canWrite: boolean;
  canAdmin: boolean;
  /**
   * The person may see only the conversations assigned to them: no composing, mailbox details, tools,
   * settings, or Unassigned view, which all need mailbox-wide access.
   */
  assignedOnly: boolean;
  managementOpening: "health" | "links" | "remote-content" | "subscriptions" | null;
  settingsOpening: boolean;
  /** The mailbox details are loading; the details button keeps its place and shows progress. */
  detailsOpening: boolean;
  onOpenDetails: () => void;
  onOpenHealth: () => void;
  onOpenSharedLinks: () => void;
  onOpenRemoteContent: () => void;
  onOpenSubscriptions: () => void;
  onOpenSettings: () => void;
  /** Moves the conversation of the dragged list row, identified by the row's item ID. */
  onMoveConversation: (input: { itemId: string; destinationFolderId: string }) => void | Promise<void>;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  createEffect(() => {
    const copy = mailCommandMessages.resolve([locale()]).t;
    onCleanup(
      registerContextAwareCommand({
        id: "mail.search",
        title: copy.searchTitle,
        description: copy.searchDescription({ name: props.mailboxName }),
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: {
          search: { scope: { ref: { type: "mail.mailbox", id: props.mailboxId }, label: props.mailboxName, icon: "ti ti-inbox" } },
        },
      }),
    );
    if (!props.canWrite || props.assignedOnly) return;
    const mailboxId = props.mailboxId;
    onCleanup(
      registerContextAwareCommand({
        id: "mail.compose",
        title: copy.composeTitle,
        description: copy.composeDescription({ name: props.mailboxName }),
        icon: "ti ti-mail-plus",
        shortcut: "mod+alt+n",
        action: () => navigateTo(`/app/mail/compose?mailbox=${mailboxId}&autostart=1`),
      }),
    );
  });
  const followUpViewItems = createMemo<MailViewItem[]>(() => [
    { id: "needs_action", label: messages().needsAction, icon: "ti ti-message-reply" },
    { id: "waiting", label: messages().waitingForReply, icon: "ti ti-hourglass", description: messages().waitingDescription },
    { id: "snoozed", label: messages().snoozed, icon: "ti ti-alarm-snooze", description: messages().snoozedDescription },
    { id: "done", label: messages().done, icon: "ti ti-checkbox" },
  ]);
  const assignmentViewItems = createMemo<MailViewItem[]>(() => [
    { id: "mine", label: messages().assignedToMe, icon: "ti ti-user-check" },
    // Everything such a person sees is assigned to them.
    ...(props.assignedOnly ? [] : [{ id: "unassigned" as const, label: messages().unassigned, icon: "ti ti-user-question" }]),
  ]);
  const secondaryViewItems = createMemo<MailViewItem[]>(() => [
    { id: "recently_active", label: messages().recentActivity, icon: "ti ti-activity" },
  ]);
  const sendProblemView = createMemo<MailViewItem>(() => ({
    id: "send_problems",
    label: messages().sendProblems,
    icon: "ti ti-alert-circle",
    description: messages().sendProblemsDescription,
  }));
  const [dropFolderId, setDropFolderId] = createSignal<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = createSignal<Set<string>>(new Set());
  const [moreExpanded, setMoreExpanded] = createSignal(false);
  const folderTree = createMemo(() => buildVisibleMailFolderTree(props.folders));
  const flatFolders = createMemo(() => flattenMailFolderTree(folderTree()).map(({ folder }) => folder));
  const primaryFolders = createMemo(() => flatFolders().filter((folder) => PRIMARY_FOLDER_ROLES.has(folder.role)));
  const secondaryFolders = createMemo(() => flatFolders().filter((folder) => SECONDARY_FOLDER_ROLES.has(folder.role)));
  const customFolderTree = createMemo(() => excludeMailFolderTreeRoles(folderTree(), SYSTEM_FOLDER_ROLES));
  const customFolderBranchIds = createMemo(() => folderBranchIds(customFolderTree()));
  const allMailActive = () =>
    !props.scheduledMode && !props.activeFolderId && !props.activeView && !props.activeSavedViewId && !props.searchActive;
  const moreOpen = () =>
    moreExpanded() ||
    allMailActive() ||
    secondaryViewItems().some((view) => props.activeView === view.id) ||
    secondaryFolders().some((folder) => props.activeFolderId === folder.id);
  const sync = mutations.create<void, void, { idempotencyKey: string }>({
    onBefore: () => ({ idempotencyKey: crypto.randomUUID() }),
    mutation: async (_input, { abortSignal, idempotencyKey }) => {
      const response = await apiClient.mailboxes[":mailboxId"].commands.$post(
        {
          param: { mailboxId: props.mailboxId },
          json: { kind: "sync_mailbox", idempotencyKey },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedStartSync));
    },
    onSuccess: () => {
      toast.success(messages().syncQueued);
      refreshCurrentPath();
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => sync.abort());

  const registerEmailLinks = async () => {
    const result = registerMailtoHandler(navigator, window.location.origin);
    if (result.kind === "requested") {
      await prompts.alert(messages().browserHandlerInstructions, { title: messages().checkBrowser });
      return;
    }
    if (result.kind === "unsupported") {
      await prompts.alert(messages().handlerUnsupported, { title: messages().emailLinksUnsupported });
      return;
    }
    await prompts.error(messages().emailLinkRegistrationFailed, { title: messages().couldNotRegisterEmailLinks });
  };

  const dropConversation = (event: DragEvent, destinationFolderId: string) => {
    event.preventDefault();
    setDropFolderId(null);
    try {
      const value = JSON.parse(event.dataTransfer?.getData("application/x-cloud-mail-conversation") ?? "") as {
        itemId?: unknown;
      };
      if (typeof value.itemId !== "string") return;
      void props.onMoveConversation({ itemId: value.itemId, destinationFolderId });
    } catch {
      // Ignore unrelated drags; only Mail conversation payloads are accepted.
    }
  };

  const viewItems = (items: MailViewItem[], suffix: string) => (
    <>
      <For each={items}>
        {(view) => (
          <AppWorkspace.SidebarItem
            href={`/app/mail/${props.mailboxId}?view=${view.id}`}
            icon={view.icon}
            active={!props.scheduledMode && props.activeView === view.id}
            meta={<span class="tabular-nums">{props.viewCounts[view.id]}</span>}
            title={view.description}
            viewTransitionName={`mail-view-${view.id}-${suffix}`}
            navigation="enhanced"
            onNavigate={props.onNavigate}
            scroll="preserve"
          >
            {view.label}
          </AppWorkspace.SidebarItem>
        )}
      </For>
    </>
  );

  const scheduledItem = (suffix: string) => (
    <AppWorkspace.SidebarItem
      href={`/app/mail/${props.mailboxId}?scheduled=1`}
      icon="ti ti-calendar-time"
      active={props.scheduledMode}
      meta={<span class="tabular-nums">{props.scheduledCount}</span>}
      viewTransitionName={`mail-scheduled-${suffix}`}
      navigation="enhanced"
      onNavigate={props.onNavigate}
      scroll="preserve"
    >
      {messages().scheduled}
    </AppWorkspace.SidebarItem>
  );

  const mailboxToolSections = (): Array<
    Omit<DropdownSection, "items"> & { items: Array<DropdownSection["items"][number] & { id: string }> }
  > => [
    {
      sectionLabel: messages().mailbox,
      items: [
        ...(props.canAdmin
          ? [
              {
                id: "sync",
                label: props.syncEnabled ? messages().syncMailbox : messages().mailboxPaused,
                icon: props.syncEnabled ? "ti ti-refresh" : "ti ti-player-play",
                action: props.syncEnabled ? () => sync.mutate() : props.onOpenHealth,
                // The mailbox banner names the missing connection; a sync request would queue nothing.
                disabled: props.syncEnabled && props.needsConnection,
              },
              { id: "health", label: messages().mailboxHealth, icon: "ti ti-heartbeat", action: props.onOpenHealth },
            ]
          : []),
        {
          id: "automations",
          label: messages().automations,
          icon: "ti ti-route",
          action: () => documentNavigate(`/app/mail/${props.mailboxId}/automations`),
        },
      ],
    },
    {
      sectionLabel: messages().manage,
      items: [
        { id: "mailing-lists", label: messages().mailingLists, icon: "ti ti-news", action: props.onOpenSubscriptions },
        { id: "remote-images", label: messages().remoteImages, icon: "ti ti-photo-shield", action: props.onOpenRemoteContent },
        ...(props.canAdmin
          ? [{ id: "shared-links", label: messages().sharedLinks, icon: "ti ti-link", action: props.onOpenSharedLinks }]
          : []),
      ],
    },
    {
      sectionLabel: messages().thisBrowser,
      items: [{ id: "email-links", label: messages().emailLinkSetup, icon: "ti ti-link", action: () => void registerEmailLinks() }],
    },
  ];

  const mailboxTools = () => (
    <Dropdown.Root items={mailboxToolSections()} position="top-right">
      <Dropdown.Trigger
        appearance="plain"
        class="k2b-app-workspace__sidebar-item"
        label={messages().mailboxTools}
        // A dialog's code can still be loading: the trigger keeps focus so the dialog can return it, and the opener
        // ignores another choice until then.
        disabled={sync.loading()}
        aria-busy={props.managementOpening ? "true" : undefined}
      >
        <span class="k2b-app-workspace__sidebar-item-icon" aria-hidden="true">
          <i class={props.managementOpening || sync.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-tool"} />
        </span>
        <span class="k2b-app-workspace__sidebar-item-label">
          <span class="k2b-app-workspace__sidebar-item-label-text">{messages().mailboxTools}</span>
        </span>
      </Dropdown.Trigger>
    </Dropdown.Root>
  );

  const expandedFolderIds = () => customFolderBranchIds().filter((id) => !collapsedFolders().has(id));
  const setExpandedFolderIds = (expandedIds: readonly string[]) => {
    const expanded = new Set(expandedIds);
    setCollapsedFolders(new Set(customFolderBranchIds().filter((id) => !expanded.has(id))));
  };

  const folderNode = (node: MailFolderTreeNode<MailFolderView>, suffix: string, count: number | null = node.folder.unread) => {
    const folder = node.folder;
    const hasChildren = node.children.length > 0;
    // Marks where "Only in the folder" is set, not each subfolder that inherits it, like the folder settings.
    const onlyInFolder = setsOnlyInFolder(folder);
    const unread = count !== null && count > 0;
    return (
      <AppWorkspace.NavTree.Item
        id={folder.id}
        label={folder.name}
        href={folder.selectable ? `/app/mail/${props.mailboxId}?folder=${folder.id}` : undefined}
        icon={hasChildren ? "ti ti-folder-plus" : folderIcon(folder.role)}
        expandedIcon={hasChildren ? "ti ti-folder-open" : undefined}
        meta={
          onlyInFolder || unread ? (
            <span class="inline-flex items-center gap-1 tabular-nums">
              <Show when={onlyInFolder}>
                <i class="ti ti-folder-pin" data-mail-folder-only aria-hidden="true" />
                <span class="sr-only">{messages().onlyInFolder}</span>
              </Show>
              <Show when={unread}>{count}</Show>
            </span>
          ) : undefined
        }
        title={onlyInFolder ? messages().onlyInFolderTitle({ name: folder.name }) : folder.name}
        viewTransitionName={`mail-folder-${folder.id}-${suffix}`}
        navigation="enhanced"
        onNavigate={folder.selectable ? props.onNavigate : undefined}
        scroll="preserve"
        class={dropFolderId() === folder.id ? "bg-[var(--ui-selected)]" : undefined}
        onDragEnter={(event) => {
          event.stopPropagation();
          if (!props.canWrite || !folder.selectable) return;
          event.preventDefault();
          setDropFolderId(folder.id);
        }}
        onDragOver={(event) => {
          event.stopPropagation();
          if (!props.canWrite || !folder.selectable) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        }}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId(null);
        }}
        onDrop={(event) => {
          event.stopPropagation();
          if (props.canWrite && folder.selectable) dropConversation(event, folder.id);
        }}
      >
        <For each={node.children}>{(child) => folderNode(child, suffix)}</For>
      </AppWorkspace.NavTree.Item>
    );
  };

  const folderTreeItems = (nodes: readonly MailFolderTreeNode<MailFolderView>[], suffix: string) => (
    <For each={nodes}>{(node) => folderNode(node, suffix)}</For>
  );
  const folderNavigation = (nodes: readonly MailFolderTreeNode<MailFolderView>[], suffix: string, ariaLabel: string) => (
    <AppWorkspace.NavTree
      ariaLabel={ariaLabel}
      selectedId={props.activeFolderId}
      expandedIds={expandedFolderIds()}
      onExpandedIdsChange={setExpandedFolderIds}
    >
      {folderTreeItems(nodes, suffix)}
    </AppWorkspace.NavTree>
  );

  const customFolderItems = (suffix: string) => folderNavigation(customFolderTree(), suffix, messages().mailboxFolders);
  const primaryFolderItems = (role: "inbox" | "drafts" | "sent", suffix: string) => (
    <AppWorkspace.NavTree
      ariaLabel={role === "inbox" ? messages().inboxFolders : role === "drafts" ? messages().draftFolders : messages().sentFolders}
      selectedId={props.activeFolderId}
    >
      <For each={primaryFolders().filter((folder) => folder.role === role)}>
        {(folder) =>
          folderNode({ folder, children: [] }, suffix, role === "drafts" ? folder.total : role === "sent" ? null : folder.unread)
        }
      </For>
    </AppWorkspace.NavTree>
  );

  const allMail = () => (
    <AppWorkspace.SidebarItem
      href={`/app/mail/${props.mailboxId}`}
      icon="ti ti-mail"
      active={allMailActive()}
      navigation="enhanced"
      onNavigate={props.onNavigate}
      scroll="preserve"
    >
      {messages().allMail}
    </AppWorkspace.SidebarItem>
  );

  const mailItems = (suffix: string) => (
    <>
      {primaryFolderItems("inbox", suffix)}
      {primaryFolderItems("drafts", suffix)}
      {scheduledItem(suffix)}
      {viewItems([sendProblemView()], `${suffix}-delivery`)}
      {primaryFolderItems("sent", suffix)}
    </>
  );

  const moreItems = (suffix: string) => (
    <>
      <AppWorkspace.SidebarItem
        icon={`ti ${moreOpen() ? "ti-chevron-down" : "ti-chevron-right"}`}
        onClick={() => setMoreExpanded((current) => !current)}
        data={{ expanded: moreOpen() }}
      >
        {messages().more}
      </AppWorkspace.SidebarItem>
      <Show when={moreOpen()}>
        {allMail()}
        {viewItems(secondaryViewItems(), `${suffix}-more`)}
        <AppWorkspace.NavTree ariaLabel={messages().additionalFolders} selectedId={props.activeFolderId}>
          <For each={secondaryFolders()}>{(folder) => folderNode({ folder, children: [] }, suffix)}</For>
        </AppWorkspace.NavTree>
      </Show>
    </>
  );

  const savedViewItems = (suffix: string) => (
    <For each={props.savedViews}>
      {(view) => (
        <AppWorkspace.SidebarItem
          href={`/app/mail/${props.mailboxId}?savedView=${view.id}`}
          icon={view.scope === "private" ? "ti ti-user" : "ti ti-users"}
          active={props.activeSavedViewId === view.id}
          viewTransitionName={`mail-saved-view-${view.id}-${suffix}`}
          navigation="enhanced"
          onNavigate={props.onNavigate}
          scroll="preserve"
        >
          {view.name}
        </AppWorkspace.SidebarItem>
      )}
    </For>
  );

  const tagItems = (suffix: string) => (
    <For each={props.localTags}>
      {(tag) => {
        const search = serializeMailSearchState({ expression: { type: "local_tag_id", tagId: tag.id }, sort: "newest" });
        return (
          <AppWorkspace.SidebarItem
            href={`/app/mail/${props.mailboxId}?search=${encodeURIComponent(search.ok ? search.value : "")}`}
            icon="ti ti-tag"
            active={props.activeTagId === tag.id}
            meta={<span class="size-2 rounded-full" style={{ "background-color": tag.color }} aria-hidden="true" />}
            title={tag.name}
            viewTransitionName={`mail-tag-${tag.id}-${suffix}`}
            navigation="enhanced"
            onNavigate={props.onNavigate}
            scroll="preserve"
          >
            {tag.name}
          </AppWorkspace.SidebarItem>
        );
      }}
    </For>
  );

  const link = (id: string, label: string, href: string, icon: string, active = false, badge?: number): NavigationItem => ({
    id,
    label,
    href,
    icon,
    active,
    badge,
    navigation: "enhanced",
    scroll: "preserve",
  });
  const views = (items: MailViewItem[]) =>
    items.map((view) =>
      link(
        `view:${view.id}`,
        view.label,
        `/app/mail/${props.mailboxId}?view=${view.id}`,
        view.icon,
        !props.scheduledMode && props.activeView === view.id,
        props.viewCounts[view.id],
      ),
    );
  const folderEntry = (node: MailFolderTreeNode<MailFolderView>): NavigationItem => {
    const folder = node.folder;
    const common = {
      id: `folder:${folder.id}`,
      label: folder.name,
      icon: folderIcon(folder.role),
      active: props.activeFolderId === folder.id,
      badge: folder.role === "sent" ? undefined : (folder.role === "drafts" ? folder.total : folder.unread) || undefined,
      // The phone navigation names where "Only in the folder" is set, like the mark in the desktop sidebar.
      description: setsOnlyInFolder(folder) ? messages().onlyInFolder : undefined,
      children: node.children.map(folderEntry),
    };
    return folder.selectable
      ? { ...common, href: `/app/mail/${props.mailboxId}?folder=${folder.id}`, navigation: "enhanced", scroll: "preserve" }
      : common;
  };
  // Used as a row and as an inline action, so its type stays inferred and fits both.
  const details = (label: string) => ({
    id: "details",
    label,
    icon: "ti ti-info-circle",
    action: "details",
    disabled: props.detailsOpening,
  });
  const navigation = createNavigation({
    items: () => [
      // Like the desktop sidebar, the details sit beside Compose; readers, who cannot compose, get them as their own row,
      // named like the button that takes Compose's place on desktop.
      ...(props.assignedOnly
        ? []
        : [
            props.canWrite
              ? {
                  id: "compose",
                  label: messages().compose,
                  icon: "ti ti-pencil",
                  href: `/app/mail/compose?mailbox=${props.mailboxId}&autostart=1`,
                  inlineActions: [details(messages().mailboxDetails)],
                }
              : details(messages().aboutMailbox),
          ]),
      { id: "mailboxes", label: messages().allMailboxes, icon: "ti ti-switch-horizontal", href: "/app/mail" },
      { id: "follow-up", label: messages().followUp, children: views(followUpViewItems()) },
      { id: "assignment", label: messages().assignment, children: views(assignmentViewItems()) },
      {
        id: "mail",
        label: messages().mail,
        children: [
          ...primaryFolders()
            .filter((folder) => folder.role === "inbox" || folder.role === "drafts")
            .map((folder) => folderEntry({ folder, children: [] })),
          link(
            "scheduled",
            messages().scheduled,
            `/app/mail/${props.mailboxId}?scheduled=1`,
            "ti ti-calendar-time",
            props.scheduledMode,
            props.scheduledCount,
          ),
          ...views([sendProblemView()]),
          ...primaryFolders()
            .filter((folder) => folder.role === "sent")
            .map((folder) => folderEntry({ folder, children: [] })),
          {
            id: "more",
            label: messages().more,
            children: [
              link("all", messages().allMail, `/app/mail/${props.mailboxId}`, "ti ti-mail", allMailActive()),
              ...views(secondaryViewItems()),
              ...secondaryFolders().map((folder) => folderEntry({ folder, children: [] })),
            ],
          },
        ],
      },
      ...(customFolderTree().length ? [{ id: "folders", label: messages().folders, children: customFolderTree().map(folderEntry) }] : []),
      ...(props.localTags.length
        ? [
            {
              id: "tags",
              label: messages().tags,
              children: props.localTags.map((tag) => {
                const search = serializeMailSearchState({ expression: { type: "local_tag_id", tagId: tag.id }, sort: "newest" });
                return {
                  ...link(
                    `tag:${tag.id}`,
                    tag.name,
                    `/app/mail/${props.mailboxId}?search=${encodeURIComponent(search.ok ? search.value : "")}`,
                    "ti ti-tag",
                    props.activeTagId === tag.id,
                  ),
                  color: tag.color,
                };
              }),
            },
          ]
        : []),
      ...(props.savedViews.length
        ? [
            {
              id: "saved",
              label: messages().savedViews,
              children: props.savedViews.map((view) =>
                link(
                  `saved:${view.id}`,
                  view.name,
                  `/app/mail/${props.mailboxId}?savedView=${view.id}`,
                  view.scope === "private" ? "ti ti-user" : "ti ti-users",
                  props.activeSavedViewId === view.id,
                ),
              ),
            },
          ]
        : []),
      ...(props.assignedOnly
        ? []
        : [
            {
              id: "tools",
              label: messages().mailboxTools,
              icon: "ti ti-tool",
              disabled: props.managementOpening !== null || sync.loading(),
              children: mailboxToolSections().map((group, index) => ({
                id: `tools:${index}`,
                label: group.sectionLabel ?? messages().mailboxTools,
                children: group.items.map((item) => ({
                  id: `tool:${item.id}`,
                  action: `tool:${item.id}`,
                  label: item.label,
                  icon: item.icon,
                  disabled: item.disabled,
                })),
              })),
            },
            { id: "settings", label: messages().settings, icon: "ti ti-settings", action: "settings", disabled: props.settingsOpening },
          ]),
    ],
    onNavigate: props.onNavigate,
    onAction: (action) => {
      if (action === "settings") return props.onOpenSettings();
      if (action === "details") return props.onOpenDetails();
      const item = mailboxToolSections()
        .flatMap((group) => group.items)
        .find((item) => `tool:${item.id}` === action);
      if (item && !item.disabled) item.action?.();
    },
  });

  const detailsIcon = () => (props.detailsOpening ? "ti ti-loader-2 animate-spin" : "ti ti-info-circle");

  return (
    <>
      <WorkspaceNavigationProvider navigation={navigation} label={props.mailboxName} />
      <AppWorkspace.Sidebar class="mail-workspace-navigation">
        <AppWorkspace.SidebarDesktop>
          <div class="mail-sidebar-actions mx-2 mt-2 flex items-center gap-2">
            {/* SSR knows the permission, so this slot never changes shape after hydration. While the details load, only
                the icon changes: the button keeps its size and focus. */}
            {props.assignedOnly ? (
              // Nothing here needs the whole mailbox: the slot says why the lists are short instead.
              <p class="mail-assigned-only flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 text-xs text-dimmed">
                <i class="ti ti-user-check shrink-0" aria-hidden="true" />
                <span class="min-w-0 truncate">{messages().assignedOnly}</span>
              </p>
            ) : props.canWrite ? (
              <>
                <ButtonLink
                  size="sm"
                  href={`/app/mail/compose?mailbox=${props.mailboxId}&autostart=1`}
                  class="mail-compose-action min-w-0 flex-1"
                >
                  <i class="ti ti-pencil" aria-hidden="true" />
                  <span>{messages().compose}</span>
                </ButtonLink>
                <IconButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  class="mail-details-action shrink-0"
                  label={messages().mailboxDetails}
                  aria-busy={props.detailsOpening ? "true" : undefined}
                  onClick={() => props.onOpenDetails()}
                >
                  <i class={detailsIcon()} aria-hidden="true" />
                </IconButton>
              </>
            ) : (
              // Readers cannot compose: the details take Compose's place at its full width, so no row stands half empty.
              <Button
                type="button"
                size="sm"
                variant="secondary"
                class="mail-details-action min-w-0 flex-1"
                aria-busy={props.detailsOpening ? "true" : undefined}
                onClick={() => props.onOpenDetails()}
              >
                <i class={detailsIcon()} aria-hidden="true" />
                <span>{messages().aboutMailbox}</span>
              </Button>
            )}
          </div>
          <AppWorkspace.SidebarBody scrollPreserveKey={`mail-sidebar-${props.mailboxId}`}>
            <AppWorkspace.SidebarSection title={messages().followUp}>
              {viewItems(followUpViewItems(), "desktop")}
            </AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarSection title={messages().assignment}>
              {viewItems(assignmentViewItems(), "desktop")}
            </AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarSection title={messages().mail}>
              {mailItems("desktop")}
              {moreItems("desktop")}
            </AppWorkspace.SidebarSection>
            <Show when={flattenMailFolderTree(customFolderTree()).length > 0}>
              <AppWorkspace.SidebarSection title={messages().folders}>{customFolderItems("desktop")}</AppWorkspace.SidebarSection>
            </Show>
            {props.localTags.length > 0 && (
              <AppWorkspace.SidebarSection title={messages().tags}>{tagItems("desktop")}</AppWorkspace.SidebarSection>
            )}
            {props.savedViews.length > 0 && (
              <AppWorkspace.SidebarSection title={messages().savedViews}>{savedViewItems("desktop")}</AppWorkspace.SidebarSection>
            )}
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter class="flex flex-col gap-1">
            <AppWorkspace.SidebarItem href="/app/mail" icon="ti ti-switch-horizontal" navigation="document">
              {messages().allMailboxes}
            </AppWorkspace.SidebarItem>
            <Show when={!props.assignedOnly}>
              {mailboxTools()}
              <AppWorkspace.SidebarItem
                // Stays enabled while the dialog's code loads, so the dialog can return focus to it.
                icon={props.settingsOpening ? "ti ti-loader-2 animate-spin" : "ti ti-settings"}
                onClick={props.onOpenSettings}
              >
                {messages().settings}
              </AppWorkspace.SidebarItem>
            </Show>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
