import { documentNavigate, type LinkNavigateEvent, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { AppWorkspace, ButtonLink, Dropdown, prompts, toast } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConversationView } from "../../contracts";
import { serializeMailSearchState } from "../../search-state";
import type { LocalTag } from "../../service/local-tags";
import type { ConversationViewCounts, MailFolderView } from "../../service/messages";
import type { SavedConversationView } from "../../service/saved-views";
import { readApiError } from "./api-response";
import { registerMailtoHandler } from "./mail-compose-route";
import { buildVisibleMailFolderTree, excludeMailFolderTreeRoles, flattenMailFolderTree, type MailFolderTreeNode } from "./mail-folder-tree";

type MailViewItem = {
  id: ConversationView;
  label: string;
  icon: string;
  description?: string;
};

const FOLLOW_UP_VIEW_ITEMS: MailViewItem[] = [
  { id: "needs_action", label: "Needs action", icon: "ti ti-message-reply" },
  {
    id: "waiting",
    label: "Waiting for reply",
    icon: "ti ti-hourglass",
    description: "Waiting for someone else. New mail moves the conversation to Needs action.",
  },
  {
    id: "snoozed",
    label: "Snoozed",
    icon: "ti ti-alarm-snooze",
    description: "Hidden until its snooze time. New mail returns the conversation sooner.",
  },
  { id: "done", label: "Done", icon: "ti ti-checkbox" },
];

const ASSIGNMENT_VIEW_ITEMS: MailViewItem[] = [
  { id: "mine", label: "Assigned to me", icon: "ti ti-user-check" },
  { id: "unassigned", label: "Unassigned", icon: "ti ti-user-question" },
];

const SECONDARY_VIEW_ITEMS: MailViewItem[] = [{ id: "recently_active", label: "Recent activity", icon: "ti ti-activity" }];

const SEND_PROBLEM_VIEW: MailViewItem = {
  id: "send_problems",
  label: "Send problems",
  icon: "ti ti-alert-circle",
  description: "Messages that need attention or will be retried.",
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
  managementOpening: "health" | "links" | "remote-content" | "subscriptions" | null;
  settingsOpening: boolean;
  onOpenHealth: () => void;
  onOpenSharedLinks: () => void;
  onOpenRemoteContent: () => void;
  onOpenSubscriptions: () => void;
  onOpenSettings: () => void;
  onMoveConversation: (input: { conversationId: string; sourceFolderId: string; destinationFolderId: string }) => void | Promise<void>;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
}) {
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
    SECONDARY_VIEW_ITEMS.some((view) => props.activeView === view.id) ||
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
      if (!response.ok) throw new Error(await readApiError(response, "Failed to start synchronization"));
    },
    onSuccess: () => {
      toast.success("Mailbox synchronization started");
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => sync.abort());

  const registerEmailLinks = async () => {
    const result = registerMailtoHandler(navigator, window.location.origin);
    if (result.kind === "requested") {
      await prompts.alert(
        "Confirm the browser prompt if it appears. No prompt? Open the site controls next to the address, go to Site settings, reset Protocol handlers for this site, then choose Email link setup again.",
        { title: "Check your browser" },
      );
      return;
    }
    if (result.kind === "unsupported") {
      await prompts.alert(
        "This browser cannot register Cloud Mail for email links from the page. You can still open Cloud Mail and compose normally, or choose Cloud Mail through your browser or operating-system app settings when available.",
        { title: "Email links are not supported here" },
      );
      return;
    }
    await prompts.error(result.message, { title: "Could not register email links" });
  };

  const dropConversation = (event: DragEvent, destinationFolderId: string) => {
    event.preventDefault();
    setDropFolderId(null);
    try {
      const value = JSON.parse(event.dataTransfer?.getData("application/x-cloud-mail-conversation") ?? "") as {
        conversationId?: unknown;
        sourceFolderId?: unknown;
      };
      if (typeof value.conversationId !== "string" || typeof value.sourceFolderId !== "string") return;
      void props.onMoveConversation({
        conversationId: value.conversationId,
        sourceFolderId: value.sourceFolderId,
        destinationFolderId,
      });
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
      Scheduled
    </AppWorkspace.SidebarItem>
  );

  const mailboxTools = () => (
    <Dropdown.Root
      items={[
        {
          sectionLabel: "Mailbox",
          items: [
            ...(props.canAdmin
              ? [
                  {
                    label: props.syncEnabled ? "Sync mailbox" : "Mailbox paused",
                    icon: props.syncEnabled ? "ti ti-refresh" : "ti ti-player-play",
                    action: props.syncEnabled ? () => sync.mutate() : props.onOpenHealth,
                  },
                  { label: "Mailbox health", icon: "ti ti-heartbeat", action: props.onOpenHealth },
                ]
              : []),
            {
              label: "Automations",
              icon: "ti ti-route",
              action: () => documentNavigate(`/app/mail/${props.mailboxId}/automations`),
            },
          ],
        },
        {
          sectionLabel: "Manage",
          items: [
            { label: "Mailing lists", icon: "ti ti-news", action: props.onOpenSubscriptions },
            { label: "Remote images", icon: "ti ti-photo-shield", action: props.onOpenRemoteContent },
            ...(props.canAdmin ? [{ label: "Shared links", icon: "ti ti-link", action: props.onOpenSharedLinks }] : []),
          ],
        },
        {
          sectionLabel: "This browser",
          items: [{ label: "Email link setup", icon: "ti ti-link", action: () => void registerEmailLinks() }],
        },
      ]}
      position="top-right"
    >
      <Dropdown.Trigger
        appearance="plain"
        class="k2b-app-workspace__sidebar-item"
        label="Mailbox tools"
        disabled={props.managementOpening !== null || sync.loading()}
      >
        <span class="k2b-app-workspace__sidebar-item-icon" aria-hidden="true">
          <i class={props.managementOpening || sync.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-tool"} />
        </span>
        <span class="k2b-app-workspace__sidebar-item-label">
          <span class="k2b-app-workspace__sidebar-item-label-text">Mailbox tools</span>
        </span>
      </Dropdown.Trigger>
    </Dropdown.Root>
  );

  const expandedFolderIds = () => customFolderBranchIds().filter((id) => !collapsedFolders().has(id));
  const setExpandedFolderIds = (expandedIds: readonly string[]) => {
    const expanded = new Set(expandedIds);
    setCollapsedFolders(new Set(customFolderBranchIds().filter((id) => !expanded.has(id))));
  };

  const folderNode = (node: MailFolderTreeNode, suffix: string, count: number | null = node.folder.unread) => {
    const folder = node.folder;
    const hasChildren = node.children.length > 0;
    return (
      <AppWorkspace.NavTree.Item
        id={folder.id}
        label={folder.name}
        href={folder.selectable ? `/app/mail/${props.mailboxId}?folder=${folder.id}` : undefined}
        icon={hasChildren ? "ti ti-folder-plus" : folderIcon(folder.role)}
        expandedIcon={hasChildren ? "ti ti-folder-open" : undefined}
        meta={count !== null && count > 0 ? <span class="tabular-nums">{count}</span> : undefined}
        title={folder.name}
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

  const folderTreeItems = (nodes: readonly MailFolderTreeNode[], suffix: string) => (
    <For each={nodes}>{(node) => folderNode(node, suffix)}</For>
  );
  const folderNavigation = (nodes: readonly MailFolderTreeNode[], suffix: string, ariaLabel: string) => (
    <AppWorkspace.NavTree
      ariaLabel={ariaLabel}
      selectedId={props.activeFolderId}
      expandedIds={expandedFolderIds()}
      onExpandedIdsChange={setExpandedFolderIds}
    >
      {folderTreeItems(nodes, suffix)}
    </AppWorkspace.NavTree>
  );

  const customFolderItems = (suffix: string) => folderNavigation(customFolderTree(), suffix, "Mailbox folders");
  const primaryFolderItems = (role: "inbox" | "drafts" | "sent", suffix: string) => (
    <AppWorkspace.NavTree
      ariaLabel={`${role === "inbox" ? "Inbox" : role === "drafts" ? "Draft" : "Sent"} folders`}
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
      All mail
    </AppWorkspace.SidebarItem>
  );

  const mailItems = (suffix: string) => (
    <>
      {primaryFolderItems("inbox", suffix)}
      {primaryFolderItems("drafts", suffix)}
      {scheduledItem(suffix)}
      {viewItems([SEND_PROBLEM_VIEW], `${suffix}-delivery`)}
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
        More
      </AppWorkspace.SidebarItem>
      <Show when={moreOpen()}>
        {allMail()}
        {viewItems(SECONDARY_VIEW_ITEMS, `${suffix}-more`)}
        <AppWorkspace.NavTree ariaLabel="Additional mailbox folders" selectedId={props.activeFolderId}>
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

  return (
    <AppWorkspace.Sidebar class="mail-workspace-navigation">
      <AppWorkspace.SidebarMobileTrigger label={props.mailboxName} />
      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems>
          {props.canWrite && (
            <AppWorkspace.SidebarItem
              href={`/app/mail/compose?mailbox=${props.mailboxId}&autostart=1`}
              icon="ti ti-pencil"
              navigation="document"
            >
              Compose
            </AppWorkspace.SidebarItem>
          )}
          <AppWorkspace.SidebarItem href="/app/mail" icon="ti ti-switch-horizontal" navigation="document">
            All mailboxes
          </AppWorkspace.SidebarItem>
          {mailboxTools()}
          <AppWorkspace.SidebarItem icon="ti ti-settings" disabled={props.settingsOpening} onClick={props.onOpenSettings}>
            Settings
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarMobileItems>
        <AppWorkspace.SidebarMobileBody scrollPreserveKey={`mail-sidebar-mobile-${props.mailboxId}`}>
          <AppWorkspace.SidebarSection title="Follow-up">{viewItems(FOLLOW_UP_VIEW_ITEMS, "mobile")}</AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarSection title="Assignment">{viewItems(ASSIGNMENT_VIEW_ITEMS, "mobile")}</AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarSection title="Mail">
            {mailItems("mobile")}
            {moreItems("mobile")}
          </AppWorkspace.SidebarSection>
          <Show when={flattenMailFolderTree(customFolderTree()).length > 0}>
            <AppWorkspace.SidebarSection title="Folders">{customFolderItems("mobile")}</AppWorkspace.SidebarSection>
          </Show>
          {props.localTags.length > 0 && <AppWorkspace.SidebarSection title="Tags">{tagItems("mobile")}</AppWorkspace.SidebarSection>}
          {props.savedViews.length > 0 && (
            <AppWorkspace.SidebarSection title="Saved views">{savedViewItems("mobile")}</AppWorkspace.SidebarSection>
          )}
        </AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>
      <AppWorkspace.SidebarDesktop>
        {props.canWrite && (
          <ButtonLink size="sm" href={`/app/mail/compose?mailbox=${props.mailboxId}&autostart=1`} class="mail-compose-action mx-2 mt-2">
            <i class="ti ti-pencil" aria-hidden="true" />
            <span>Compose</span>
          </ButtonLink>
        )}
        <AppWorkspace.SidebarBody scrollPreserveKey={`mail-sidebar-${props.mailboxId}`}>
          <AppWorkspace.SidebarSection title="Follow-up">{viewItems(FOLLOW_UP_VIEW_ITEMS, "desktop")}</AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarSection title="Assignment">{viewItems(ASSIGNMENT_VIEW_ITEMS, "desktop")}</AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarSection title="Mail">
            {mailItems("desktop")}
            {moreItems("desktop")}
          </AppWorkspace.SidebarSection>
          <Show when={flattenMailFolderTree(customFolderTree()).length > 0}>
            <AppWorkspace.SidebarSection title="Folders">{customFolderItems("desktop")}</AppWorkspace.SidebarSection>
          </Show>
          {props.localTags.length > 0 && <AppWorkspace.SidebarSection title="Tags">{tagItems("desktop")}</AppWorkspace.SidebarSection>}
          {props.savedViews.length > 0 && (
            <AppWorkspace.SidebarSection title="Saved views">{savedViewItems("desktop")}</AppWorkspace.SidebarSection>
          )}
        </AppWorkspace.SidebarBody>
        <AppWorkspace.SidebarFooter class="flex flex-col gap-1">
          <AppWorkspace.SidebarItem href="/app/mail" icon="ti ti-switch-horizontal" navigation="document">
            All mailboxes
          </AppWorkspace.SidebarItem>
          {mailboxTools()}
          <AppWorkspace.SidebarItem
            icon={props.settingsOpening ? "ti ti-loader-2 animate-spin" : "ti ti-settings"}
            disabled={props.settingsOpening}
            onClick={props.onOpenSettings}
          >
            Settings
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarFooter>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
