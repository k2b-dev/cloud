import { openStudioDialog, StudioSidebarItem } from "../artifacts/StudioSidebarItem";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { assistantSearchOptions, assistantProjectSearchOptions, assistantProjectsSearchOptions } from "./assistant-search";
import { assistantCommandMessages } from "../commands";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { ConversationSidebarPreview } from "./ConversationSidebarPreview";
import { useAssistantText } from "./ui-copy";
import { navigate, navigateTo } from "@k2b/ssr/nav";
import {
  AppWorkspace,
  createNavigation,
  type NavigationItem,
  dialogCore,
  PanelDialog,
  panelDialogOptions,
  Dropdown,
  Format,
  IconButton,
  toast,
  useLocale,
} from "@k2b/ui";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { type Accessor, createSignal, For, createEffect, onCleanup, onMount, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { openAssistantAllChatsDialog } from "./AssistantAllChatsDialog";
import { openAssistantConversationEditor } from "./AssistantConversationEditor";
import { openAssistantPrefsModal } from "./AssistantPrefsModals";
import type { AssistantLiveHub } from "./assistant-live";
import { assistantConversationHref, assistantProjectHref } from "./assistant-navigation";
import { ConversationStatusMeta } from "./conversation-status";
import { conversationStatusPresentation } from "./conversation-view";
import { assistantMessages } from "./messages";
import { artifactMessages } from "../artifacts/messages";

type AssistantSidebarProps = {
  conversations: Accessor<AiConversation[]>;
  doneCount?: number;
  activeConversationId?: Accessor<string | null>;
  activeView?: "chat" | "all" | "apps";
  activeAppId?: string;
  projects?: AiProject[];
  activeProjectId?: string | null;
  creatingConversation?: Accessor<boolean>;
  onNewConversation?: () => void | Promise<void>;
  onCreateProject?: () => void | Promise<void>;
  onOpenProject?: (projectId: string) => Promise<boolean>;
  onOpenConversation?: (conversationId: string) => Promise<boolean>;
  canArchiveConversation?: (conversation: AiConversation) => boolean;
  onConversationUpdated?: (conversation: AiConversation) => void;
  onConversationArchived?: (conversation: AiConversation) => void;
  live: AssistantLiveHub;
};

function AssistantSearchButton(props: { project?: AiProject; currentChat?: boolean; registerCommand?: boolean; variant?: "item" | "icon" }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const options = () => props.project ? assistantProjectSearchOptions(props.project) : assistantSearchOptions(locale());
  const title = () => props.project ? assistantCommandMessages.resolve([locale()]).t.searchProject : t().searchChats;
  const openSearch = () => openGlobalSearch(options());

  createEffect(() => {
    if (!props.registerCommand) return;
    onCleanup(registerContextAwareCommand({
      id: "assistant.search", title: title(), description: props.project
        ? assistantCommandMessages.resolve([locale()]).t.searchProjectDescription({ name: props.project.name })
        : assistantCommandMessages.resolve([locale()]).t.searchChatsDescription,
      icon: "ti ti-search", shortcut: props.currentChat ? undefined : "mod+shift+k", action: { search: options() },
    }));
  });

  return props.variant === "icon" ? (
    <AppWorkspace.SidebarIconAction icon="ti ti-search" onClick={openSearch} label={title()} />
  ) : (
    <AppWorkspace.SidebarItem icon="ti ti-search" onClick={openSearch} title={title()}>
      {title()}
    </AppWorkspace.SidebarItem>
  );
}

function ConversationSidebarItem(props: {
  conversation: AiConversation;
  active: boolean;
  open?: (conversation: AiConversation) => Promise<boolean>;
  edit: (conversation: AiConversation) => void;
  project?: AiProject;
  update: (conversation: AiConversation) => void;
}) {
  const text = useAssistantText();
  const locale = useLocale();
  const [previewOpen, setPreviewOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const busy = () => ["queued", "running", "needs_attention", "waiting_for_browser"].includes(props.conversation.runStatus);
  const toggleDone = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      props.update(await assistantApi.setConversationDone(props.conversation.id, !props.conversation.isDone));
    } catch {
      toast.error(text("Could not update chat. Stop the response first or try again."));
    } finally {
      setSaving(false);
    }
  };
  const href = () => assistantConversationHref("/app/assistant", props.conversation.id);
  const handleClick = (event: MouseEvent) => {
    // Keep modified clicks native. Plain clicks must not put the network request
    // inside Link's view transition, which freezes rendering until it resolves.
    if (!props.open || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    if (props.active) return;
    const target = href();
    void props
      .open(props.conversation)
      .then((opened) => {
        if (opened) navigate(target, { scroll: "manual", viewTransition: false });
      })
      .catch(() => navigateTo(target));
  };

  return (
    <AppWorkspace.SidebarItem
      href={href()}
      class={`assistant-chat-sidebar-item${!props.conversation.isDone && !props.conversation.pinnedAt ? " assistant-chat-sidebar-item--done-action" : ""}`}
      variant={props.conversation.isDone ? "row" : "card"}
      context={
        !props.conversation.isDone ? (
          <span>
            <Show when={props.conversation.pinnedAt} fallback={<i class={props.project?.icon || "ti ti-message"} aria-hidden="true" />}>
              <i class="ti ti-pin text-accent" role="img" aria-label={assistantMessages.resolve([locale()]).t.pinnedLabel} />
            </Show> {props.project?.name ?? text("Chat")}
          </span>
        ) : undefined
      }
      contextMeta={
        !props.conversation.isDone ? (
          <span class="inline-flex items-center gap-1.5">
            <Format.RelativeTime value={props.conversation.lastUsedAt} />
          </span>
        ) : undefined
      }
      onClick={handleClick}
      active={props.active}
      description={
        !props.conversation.isDone && conversationStatusPresentation(props.conversation, locale(), props.active) ? (
          <ConversationStatusMeta conversation={props.conversation} active={props.active} labels hidePin />
        ) : undefined
      }
      preview={{
        label: text("Chat details"),
        onOpenChange: setPreviewOpen,
        content: (
          <ConversationSidebarPreview
            conversation={props.conversation}
            project={props.project}
            open={previewOpen()}
            edit={() => props.edit(props.conversation)}
            update={props.update}
          />
        ),
      }}
    >
      <AppWorkspace.SidebarItemLabel marquee={false}>{props.conversation.title}</AppWorkspace.SidebarItemLabel>
      <Show when={!props.conversation.pinnedAt}>
        <AppWorkspace.SidebarItemAction
          icon={props.conversation.isDone ? "ti ti-arrow-back-up" : "ti ti-check"}
          label={
            props.conversation.isDone
              ? text("Reopen chat")
              : busy()
                ? text("Stop the response before marking it done")
                : text("Mark chat done")
          }
          disabled={saving() || (!props.conversation.isDone && busy())}
          visibility="hover"
          onSelect={() => void toggleDone()}
        >
          <Show when={!props.conversation.isDone} fallback={<i class="ti ti-arrow-back-up" aria-hidden="true" />}>
            <i class="ti ti-check" aria-hidden="true" /><span>{text("Done")}</span>
          </Show>
        </AppWorkspace.SidebarItemAction>
      </Show>
    </AppWorkspace.SidebarItem>
  );
}

export default function AssistantSidebar(props: AssistantSidebarProps) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const text = useAssistantText();
  const activeConversations = () => props.conversations().filter((conversation) => !conversation.isDone);
  const doneConversations = () => props.conversations().filter((conversation) => conversation.isDone);
  const activeView = () => props.activeView ?? "chat";
  const activeProjectId = () => (activeView() === "chat" ? (props.activeProjectId ?? null) : null);
  const activeConversationId = () => (activeView() === "chat" && !activeProjectId() ? (props.activeConversationId?.() ?? null) : null);
  const creatingConversation = () => props.creatingConversation?.() ?? false;
  const pinnedConversations = () =>
    activeConversations()
      .filter((conversation) => conversation.pinnedAt)
      .toSorted((left, right) => Date.parse(right.pinnedAt!) - Date.parse(left.pinnedAt!));
  const unpinnedConversations = () => activeConversations().filter((conversation) => !conversation.pinnedAt);
  const chatConversations = () => [...pinnedConversations(), ...unpinnedConversations()];
  const openProject = async (project: AiProject) => {
    if (activeProjectId() === project.id) return;
    const href = assistantProjectHref("/app/assistant", project.id);
    if (!props.onOpenProject) {
      navigateTo(href);
      return;
    }
    try {
      if (await props.onOpenProject(project.id)) navigate(href, { scroll: "manual" });
      else navigateTo(href);
    } catch {
      navigateTo(href);
    }
  };
  const openProjectSearch = () => openGlobalSearch(assistantProjectsSearchOptions(locale()));
  const ProjectsItem = () => (
    <AppWorkspace.SidebarItem
      icon="ti ti-folders"
      title={t().projects}
      active={Boolean(activeProjectId())}
      preview={{
        label: t().projects,
        viewportSize: "compact",
        align: "end",
        trigger: "row",
        content: (close) => (
          <div class="assistant-project-catalog flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <strong>{t().projects}</strong>
              <div class="flex items-center gap-1">
                <IconButton size="xs" label={t().searchProjects} onClick={() => { close(); openProjectSearch(); }}>
                  <i class="ti ti-search" aria-hidden="true" />
                </IconButton>
                <IconButton size="xs" label={t().createProject} onClick={() => { close(); void props.onCreateProject?.(); }}>
                  <i class="ti ti-plus" aria-hidden="true" />
                </IconButton>
              </div>
            </div>
            <For each={props.projects ?? []} fallback={<p class="px-2 py-1 text-xs text-dimmed">{t().noProjects}</p>}>
              {(project) => (
                <AppWorkspace.SidebarItem
                  icon={project.icon || "ti ti-folder"}
                  active={activeProjectId() === project.id}
                  onClick={() => { close(); void openProject(project); }}
                >
                  <AppWorkspace.SidebarItemLabel marquee={false}>{project.name}</AppWorkspace.SidebarItemLabel>
                </AppWorkspace.SidebarItem>
              )}
            </For>
          </div>
        ),
      }}
    >
      {t().projects}
    </AppWorkspace.SidebarItem>
  );

  const openConversationFromCommand = async (conversation: AiConversation) => {
    if (conversation.id === activeConversationId()) return;
    const href = assistantConversationHref("/app/assistant", conversation.id);
    if (props.onOpenConversation) {
      if (await props.onOpenConversation(conversation.id)) navigate(href, { scroll: "manual" });
      return;
    }
    navigateTo(href);
  };

  const openEditor = async (conversation: AiConversation) => {
    const canArchive = props.canArchiveConversation?.(conversation) ?? true;
    const result = await openAssistantConversationEditor(conversation, {
      archiveDisabled: !canArchive,
      archiveDisabledReason: canArchive ? undefined : t().stopBeforeArchive,
    });
    if (!result) return;
    if (result.action === "save") props.onConversationUpdated?.(result.conversation);
    else props.onConversationArchived?.(result.conversation);
  };
  const openAllChats = (done = false) =>
    void openAssistantAllChatsDialog(
      async (conversation) => {
        if (conversation.id === activeConversationId()) return "unchanged";
        if (!props.onOpenConversation) {
          navigateTo(assistantConversationHref("/app/assistant", conversation.id));
          return "stale";
        }
        return (await props.onOpenConversation(conversation.id)) ? "opened" : "stale";
      },
      props.live,
      () => props.projects ?? [],
      done ? "done" : "all",
    );
  const DoneSection = () => (
    <AppWorkspace.SidebarSection
      title={text("Done")}
      icon="ti ti-check"
      count={props.doneCount ?? doneConversations().length}
      collapsible
      defaultOpen={false}
    >
      <For each={doneConversations()}>
        {(conversation) => (
          <ConversationSidebarItem
            conversation={conversation}
            active={conversation.id === activeConversationId()}
            project={props.projects?.find((project) => project.id === conversation.projectId)}
            open={props.onOpenConversation ? (item) => props.onOpenConversation!(item.id) : undefined}
            edit={(item) => void openEditor(item)}
            update={(item) => props.onConversationUpdated?.(item)}
          />
        )}
      </For>
      <Show when={!doneConversations().length}>
        <p class="px-2 py-1 text-xs text-dimmed">{text("No done chats.")}</p>
      </Show>
      <AppWorkspace.SidebarItem icon="ti ti-eye" onClick={() => openAllChats()}>{t().allChats}</AppWorkspace.SidebarItem>
    </AppWorkspace.SidebarSection>
  );
  const collapsedChatMenu = () => chatConversations().map((conversation) => ({
    label: conversation.title,
    icon: conversation.pinnedAt ? "ti ti-pin text-accent" : "ti ti-message",
    action: () => openConversationFromCommand(conversation),
  }));

  const searchProject = () => props.projects?.find((project) => project.id === activeProjectId());
  const openSearch = () => {
    const project = searchProject();
    openGlobalSearch(project ? assistantProjectSearchOptions(project) : assistantSearchOptions(locale()));
  };
  const [savingIds, setSavingIds] = createSignal<ReadonlySet<string>>(new Set());
  const chatItem = (conversation: AiConversation): NavigationItem => {
    const busy = ["queued", "running", "needs_attention", "waiting_for_browser"].includes(conversation.runStatus);
    return {
      id: `chat:${conversation.id}`,
      label: conversation.title,
      icon: conversation.pinnedAt ? "ti ti-pin text-accent" : "ti ti-message",
      href: assistantConversationHref("/app/assistant", conversation.id),
      action: `chat:${conversation.id}`,
      active: activeConversationId() === conversation.id,
      description: conversationStatusPresentation(conversation, locale(), activeConversationId() === conversation.id)?.label,
      actions: [
        { id: `details:${conversation.id}`, action: `details:${conversation.id}`, label: text("Chat details"), icon: "ti ti-info-circle" },
        ...(!conversation.pinnedAt
          ? [
              {
                id: `done:${conversation.id}`,
                action: `done:${conversation.id}`,
                label: conversation.isDone
                  ? text("Reopen chat")
                  : busy
                    ? text("Stop the response before marking it done")
                    : text("Mark chat done"),
                icon: conversation.isDone ? "ti ti-arrow-back-up" : "ti ti-check",
                disabled: savingIds().has(conversation.id) || (!conversation.isDone && busy),
              },
            ]
          : []),
      ],
    };
  };
  const studioLifetime = new AbortController();
  onCleanup(() => studioLifetime.abort());
  let studioOpen = false;
  const openStudio = async () => {
    if (studioOpen) return;
    studioOpen = true;
    try { await openStudioDialog({ activeAppId: props.activeAppId, signal: studioLifetime.signal }); }
    finally { studioOpen = false; }
  };
  onMount(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("studio") !== "1") return;
    url.searchParams.delete("studio");
    window.history.replaceState(window.history.state, "", url);
    void openStudio();
  });
  const mobileNavigation = createNavigation({
    items: () => [
      { id: "new", action: "new", label: t().newChat, icon: "ti ti-plus", disabled: creatingConversation() },
      { id: "search", action: "search", label: t().searchChats, icon: "ti ti-search" },
      ...chatConversations().map(chatItem),
      {
        id: "done-chats",
        label: text("Done"),
        badge: props.doneCount ?? doneConversations().length,
        children: [...doneConversations().map(chatItem), { id: "all", action: "all", label: t().allChats, icon: "ti ti-eye" }],
      },
      {
        id: "apps",
        action: "apps",
        label: artifactMessages.resolve([locale()]).t.apps,
        icon: "ti ti-app-window",
        active: activeView() === "apps",
      },
      {
        id: "projects",
        label: t().projects,
        defaultExpanded: false,
        icon: "ti ti-folders",
        active: Boolean(activeProjectId()),
        children: [
          { id: "search-projects", action: "search-projects", label: t().searchProjects, icon: "ti ti-search" },
          { id: "new-project", action: "new-project", label: t().newProject, icon: "ti ti-plus" },
          ...(props.projects ?? []).map((project) => ({
            id: `project:${project.id}`,
            action: `project:${project.id}`,
            href: assistantProjectHref("/app/assistant", project.id),
            label: project.name,
            icon: project.icon || "ti ti-folder",
            active: activeProjectId() === project.id,
          })),
        ],
      },
      { id: "preferences", action: "preferences", label: t().personalize, icon: "ti ti-user-cog" },
    ],
    onAction: async (action) => {
      if (action === "new") {
        await props.onNewConversation?.();
        return;
      }
      if (action === "new-project") {
        await props.onCreateProject?.();
        return;
      }
      if (action === "apps") {
        void openStudio();
        return;
      }
      if (action === "search-projects") {
        openProjectSearch();
        return;
      }
      if (action === "search") {
        await openSearch();
        return;
      }
      if (action === "preferences") {
        await openAssistantPrefsModal();
        return;
      }
      if (action === "all") {
        openAllChats();
        return;
      }
      const [kind, id] = action.split(":");
      if (kind === "project") {
        const project = props.projects?.find((item) => item.id === id);
        if (project) await openProject(project);
        return;
      }
      const conversation = props.conversations().find((item) => item.id === id);
      if (!conversation) return;
      if (kind === "chat") {
        try {
          await openConversationFromCommand(conversation);
        } catch {
          navigateTo(assistantConversationHref("/app/assistant", conversation.id));
        }
      } else if (kind === "details") {
        await dialogCore.open<void>(
          (close) => (
            <PanelDialog>
              <PanelDialog.Header title={text("Chat details")} close={() => close()} />
              <PanelDialog.Body>
                <ConversationSidebarPreview
                  conversation={props.conversations().find((item) => item.id === id) ?? conversation}
                  project={props.projects?.find((item) => item.id === conversation.projectId)}
                  open
                  edit={() => {
                    const latest = props.conversations().find((item) => item.id === id);
                    close();
                    if (latest) void openEditor(latest);
                  }}
                  update={(item) => props.onConversationUpdated?.(item)}
                />
              </PanelDialog.Body>
            </PanelDialog>
          ),
          panelDialogOptions,
        );
      } else if (kind === "done" && !savingIds().has(conversation.id)) {
        setSavingIds((ids) => new Set([...ids, conversation.id]));
        try {
          props.onConversationUpdated?.(await assistantApi.setConversationDone(conversation.id, !conversation.isDone));
        } catch {
          toast.error(text("Could not update chat. Stop the response first or try again."));
        } finally {
          setSavingIds((ids) => new Set([...ids].filter((id) => id !== conversation.id)));
        }
      }
    },
  });

  return (
    <>
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={t().assistant} />
      <AppWorkspace.Sidebar collapsible>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarIconGrid columns={2} sidebarMode="expanded">
            <AppWorkspace.SidebarIconAction
              icon="ti ti-plus"
              label={t().newChat}
              disabled={creatingConversation()}
              onClick={() => void props.onNewConversation?.()}
            />
            <AssistantSearchButton project={searchProject()} variant="icon" registerCommand currentChat={!!activeConversationId()} />
          </AppWorkspace.SidebarIconGrid>

          <AppWorkspace.SidebarIconGrid columns={2} sidebarMode="collapsed">
            <AppWorkspace.SidebarIconAction
              icon="ti ti-plus"
              label={t().newChat}
              disabled={creatingConversation()}
              onClick={() => void props.onNewConversation?.()}
            />
            <AssistantSearchButton project={searchProject()} variant="icon" />
          </AppWorkspace.SidebarIconGrid>

          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <Dropdown.Root items={collapsedChatMenu()} position="right-start" width="16rem">
              <Dropdown.Trigger
                appearance="plain"
                iconOnly
                label={t().recentAllChats}
                class={`k2b-app-workspace__sidebar-icon-action ${activeView() === "all" ? "is-active" : ""}`}
              >
                <i class="ti ti-messages" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </AppWorkspace.SidebarIconGrid>

          <AppWorkspace.SidebarBody scrollPreserveKey="assistant-sidebar" sidebarMode="expanded">
            <AppWorkspace.SidebarSection>
              <Show when={chatConversations().length > 0} fallback={<p class="px-2 py-1 text-xs text-dimmed">{t().noChats}</p>}>
                <For each={chatConversations()}>
                  {(conversation) => (
                    <ConversationSidebarItem
                      conversation={conversation}
                      active={conversation.id === activeConversationId()}
                      open={props.onOpenConversation ? (item) => props.onOpenConversation!(item.id) : undefined}
                      edit={(item) => void openEditor(item)}
                      project={props.projects?.find((project) => project.id === conversation.projectId)}
                      update={(item) => props.onConversationUpdated?.(item)}
                    />
                  )}
                </For>
              </Show>
            </AppWorkspace.SidebarSection>
            <DoneSection />
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter sidebarMode="expanded">
            <StudioSidebarItem active={activeView() === "apps"} activeAppId={props.activeAppId} />
            <ProjectsItem />
            <AppWorkspace.SidebarItem icon="ti ti-user-cog" onClick={() => void openAssistantPrefsModal()}>
              {t().personalize}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
          <AppWorkspace.SidebarFooter sidebarMode="collapsed">
            <AppWorkspace.SidebarItem icon="ti ti-check" title={text("Done")} onClick={() => openAllChats(true)}>{text("Done")}</AppWorkspace.SidebarItem>
            <StudioSidebarItem active={activeView() === "apps"} activeAppId={props.activeAppId} />
            <ProjectsItem />
            <AppWorkspace.SidebarItem icon="ti ti-user-cog" title={t().personalize} onClick={() => void openAssistantPrefsModal()}>{t().personalize}</AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
