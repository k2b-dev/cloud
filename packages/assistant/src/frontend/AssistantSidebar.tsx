import { type LinkNavigateEvent, navigate, navigateTo } from "@k2b/ssr/nav";
import { AppWorkspace, Dropdown, IconButton, isSpotlightShortcut, openSpotlightSearch, SPOTLIGHT_SHORTCUT_TITLE, useLocale } from "@k2b/ui";
import type { AiConversation, AiProject } from "@valentinkolb/cloud/ai";
import { type Accessor, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { openAssistantAllChatsDialog } from "./AssistantAllChatsDialog";
import { openAssistantConversationEditor } from "./AssistantConversationEditor";
import { openAssistantPrefsModal } from "./AssistantPrefsModals";
import type { AssistantLiveHub } from "./assistant-live";
import { assistantConversationHref, assistantProjectHref, shouldOpenProjectConversation } from "./assistant-navigation";
import { ConversationStatusMeta } from "./conversation-status";
import { assistantMessages } from "./messages";

type AssistantSidebarProps = {
  conversations: Accessor<AiConversation[]>;
  activeConversationId?: Accessor<string | null>;
  activeView?: "chat" | "all";
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

const PER_SPOTLIGHT_PAGE = 20;
const SIDEBAR_CHAT_LIMIT = 15;
const SIDEBAR_PINNED_LIMIT = 10;

function AssistantSpotlightButton(props: {
  registerShortcut?: boolean;
  openConversation?: (conversation: AiConversation) => void | Promise<void>;
  variant?: "item" | "icon";
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const openSearch = async () => {
    const selected = await openSpotlightSearch<AiConversation>({
      title: t().searchChats,
      icon: "ti ti-sparkles",
      placeholder: t().searchChatsPlaceholder,
      minQueryLength: 1,
      noResultsText: t().noChatsFound,
      resolve: async ({ query, abortSignal }) => {
        const trimmed = query.trim();
        if (!trimmed) return [];

        const conversations = await assistantApi.listConversations({ q: trimmed, limit: PER_SPOTLIGHT_PAGE, signal: abortSignal });
        return conversations.map((conversation) => ({
          value: conversation,
          label: conversation.title,
          desc: conversation.description || new Date(conversation.updatedAt).toLocaleString(locale()),
        }));
      },
    });

    if (!selected?.value) return;
    if (props.openConversation) await props.openConversation(selected.value);
    else navigateTo(assistantConversationHref("/app/assistant", selected.value.id));
  };

  onMount(() => {
    if (!props.registerShortcut) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpotlightShortcut(event)) return;
      event.preventDefault();
      void openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return props.variant === "icon" ? (
    <AppWorkspace.SidebarIconAction icon="ti ti-search" onClick={openSearch} label={`${t().searchChats} (${SPOTLIGHT_SHORTCUT_TITLE})`} />
  ) : (
    <AppWorkspace.SidebarItem icon="ti ti-search" onClick={openSearch} title={`${t().searchChats} (${SPOTLIGHT_SHORTCUT_TITLE})`}>
      {t().searchChats}
    </AppWorkspace.SidebarItem>
  );
}

function ConversationSidebarItem(props: {
  conversation: AiConversation;
  active: boolean;
  open?: (conversation: AiConversation) => Promise<boolean>;
  edit: (conversation: AiConversation) => void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const href = () => assistantConversationHref("/app/assistant", props.conversation.id);
  const handleNavigate = async (nav: LinkNavigateEvent) => {
    if (props.active || !props.open) return;
    try {
      if (await props.open(props.conversation)) nav.push(undefined, { scroll: "manual" });
    } catch {
      nav.fallback();
    }
  };

  return (
    <AppWorkspace.SidebarItem
      href={href()}
      navigation={props.open ? "enhanced" : "document"}
      scroll="manual"
      onNavigate={props.open ? handleNavigate : undefined}
      active={props.active}
      title={props.conversation.title}
    >
      <AppWorkspace.SidebarItemLabel>{props.conversation.title}</AppWorkspace.SidebarItemLabel>
      <AppWorkspace.SidebarItemMeta>
        <ConversationStatusMeta conversation={props.conversation} />
      </AppWorkspace.SidebarItemMeta>
      <AppWorkspace.SidebarItemAction
        icon="ti ti-settings"
        label={t().editConversation({ title: props.conversation.title })}
        visibility="hover"
        onSelect={() => props.edit(props.conversation)}
      />
    </AppWorkspace.SidebarItem>
  );
}

export default function AssistantSidebar(props: AssistantSidebarProps) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const activeConversationId = () => props.activeConversationId?.() ?? null;
  const activeView = () => props.activeView ?? "chat";
  const creatingConversation = () => props.creatingConversation?.() ?? false;
  const pinnedConversations = () =>
    props
      .conversations()
      .filter((conversation) => conversation.pinnedAt)
      .toSorted((left, right) => Date.parse(right.pinnedAt!) - Date.parse(left.pinnedAt!))
      .slice(0, SIDEBAR_PINNED_LIMIT);
  const unpinnedConversations = () => props.conversations().filter((conversation) => !conversation.pinnedAt);
  const generalConversations = () => unpinnedConversations().filter((conversation) => !conversation.projectId);
  const visibleGeneralConversations = () => generalConversations().slice(0, SIDEBAR_CHAT_LIMIT);
  const [expandedProjects, setExpandedProjects] = createSignal<readonly string[]>(
    (props.projects ?? []).map((project) => `project:${project.id}`),
  );
  const knownProjects = new Set((props.projects ?? []).map((project) => project.id));
  createEffect(() => {
    const added = (props.projects ?? []).filter((project) => !knownProjects.has(project.id));
    if (added.length === 0) return;
    for (const project of added) knownProjects.add(project.id);
    setExpandedProjects((current) => [...current, ...added.map((project) => `project:${project.id}`)]);
  });
  const projectChats = (project: AiProject) =>
    unpinnedConversations()
      .filter((conversation) => conversation.projectId === project.id)
      .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 10);
  const openProject = async (project: AiProject, nav: LinkNavigateEvent) => {
    if (props.activeProjectId === project.id || !props.onOpenProject) return;
    try {
      if (await props.onOpenProject(project.id)) nav.push(undefined, { scroll: "manual" });
    } catch {
      nav.fallback();
    }
  };
  const openProjectChat = async (conversation: AiConversation, nav: LinkNavigateEvent) => {
    if (!props.onOpenConversation || !shouldOpenProjectConversation(props.activeProjectId, activeConversationId(), conversation.id)) return;
    try {
      if (await props.onOpenConversation(conversation.id)) nav.push(undefined, { scroll: "manual" });
    } catch {
      nav.fallback();
    }
  };

  const ProjectsTree = () => (
    <AppWorkspace.NavTree
      ariaLabel={t().projects}
      selectedId={
        props.activeProjectId ? `project:${props.activeProjectId}` : activeConversationId() ? `chat:${activeConversationId()}` : null
      }
      expandedIds={expandedProjects()}
      onExpandedIdsChange={setExpandedProjects}
    >
      <For each={props.projects ?? []}>
        {(project) => (
          <AppWorkspace.NavTree.Item
            id={`project:${project.id}`}
            label={project.name}
            icon={project.icon || "ti ti-folder"}
            expandedIcon="ti ti-folder-open"
            href={assistantProjectHref("/app/assistant", project.id)}
            navigation={props.onOpenProject ? "enhanced" : "document"}
            onNavigate={props.onOpenProject ? (nav) => openProject(project, nav) : undefined}
          >
            <For each={projectChats(project)}>
              {(conversation) => (
                <AppWorkspace.NavTree.Item
                  id={`chat:${conversation.id}`}
                  label={conversation.title}
                  href={assistantConversationHref("/app/assistant", conversation.id)}
                  navigation={props.onOpenConversation ? "enhanced" : "document"}
                  onNavigate={props.onOpenConversation ? (nav) => openProjectChat(conversation, nav) : undefined}
                  actions={
                    <AppWorkspace.SidebarItemActions visibility="hover">
                      <IconButton size="xs" label={t().editConversation({ title: conversation.title })} onClick={() => void openEditor(conversation)}>
                        <i class="ti ti-settings" aria-hidden="true" />
                      </IconButton>
                    </AppWorkspace.SidebarItemActions>
                  }
                />
              )}
            </For>
            <Show when={projectChats(project).length === 0}>
              <AppWorkspace.NavTree.Item id={`project:${project.id}:empty`} label={t().noRecentChats} disabled />
            </Show>
          </AppWorkspace.NavTree.Item>
        )}
      </For>
    </AppWorkspace.NavTree>
  );
  const ProjectsSection = () => (
    <AppWorkspace.SidebarSection
      title={t().projects}
      actions={
        <IconButton size="xs" label={t().createProject} onClick={() => void props.onCreateProject?.()}>
          <i class="ti ti-folder-plus" aria-hidden="true" />
        </IconButton>
      }
    >
      <Show when={(props.projects?.length ?? 0) > 0} fallback={<p class="px-2 py-1 text-xs text-dimmed">{t().noProjects}</p>}>
        <ProjectsTree />
      </Show>
    </AppWorkspace.SidebarSection>
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
  const PinnedSection = () => (
    <Show when={pinnedConversations().length > 0}>
      <AppWorkspace.SidebarSection title={t().pinned}>
        <For each={pinnedConversations()}>
          {(conversation) => (
            <ConversationSidebarItem
              conversation={conversation}
              active={conversation.id === activeConversationId()}
              open={props.onOpenConversation ? (item) => props.onOpenConversation!(item.id) : undefined}
              edit={(item) => void openEditor(item)}
            />
          )}
        </For>
      </AppWorkspace.SidebarSection>
    </Show>
  );
  const openAllChats = () =>
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
    );
  const collapsedChatMenu = () => [
    ...(pinnedConversations().length > 0
      ? [
          {
            sectionLabel: t().pinned,
            items: pinnedConversations().map((conversation) => ({
              label: conversation.title,
              action: () => openConversationFromCommand(conversation),
            })),
          },
        ]
      : []),
    {
      sectionLabel: t().chats,
      items: [
        ...generalConversations()
          .slice(0, 6)
          .map((conversation) => ({
            label: conversation.title,
            action: () => openConversationFromCommand(conversation),
          })),
        { icon: "ti ti-messages", label: t().allChats, action: openAllChats },
      ],
    },
  ];

  return (
    <AppWorkspace.Sidebar collapsible>
      <AppWorkspace.SidebarMobileTrigger label={t().assistant} />

      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems>
          <AppWorkspace.SidebarItem icon="ti ti-plus" disabled={creatingConversation()} onClick={() => void props.onNewConversation?.()}>
            {t().newChat}
          </AppWorkspace.SidebarItem>
          <AssistantSpotlightButton openConversation={openConversationFromCommand} />
          <AppWorkspace.SidebarItem icon="ti ti-folder-plus" onClick={() => void props.onCreateProject?.()}>
            {t().newProject}
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarItem icon="ti ti-user-cog" onClick={() => void openAssistantPrefsModal()}>
            {t().personalize}
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarMobileItems>
        <AppWorkspace.SidebarMobileBody scrollPreserveKey="assistant-sidebar-mobile">
          <PinnedSection />
          <ProjectsSection />
          <AppWorkspace.SidebarSection title={t().chats}>
            <Show when={generalConversations().length > 0} fallback={<p class="px-2 py-1 text-xs text-dimmed">{t().noChats}</p>}>
              <For each={visibleGeneralConversations()}>
                {(conversation) => (
                  <ConversationSidebarItem
                    conversation={conversation}
                    active={conversation.id === activeConversationId()}
                    open={props.onOpenConversation ? (item) => props.onOpenConversation!(item.id) : undefined}
                    edit={(item) => void openEditor(item)}
                  />
                )}
              </For>
            </Show>
            <AppWorkspace.SidebarItem onClick={openAllChats} title={t().seeAllChats}>
              {t().seeAll}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarSection>
        </AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>

      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarIconGrid columns={2} sidebarMode="expanded">
          <AppWorkspace.SidebarIconAction
            icon="ti ti-plus"
            label={t().newChat}
            disabled={creatingConversation()}
            onClick={() => void props.onNewConversation?.()}
          />
          <AssistantSpotlightButton variant="icon" registerShortcut openConversation={openConversationFromCommand} />
        </AppWorkspace.SidebarIconGrid>

        <AppWorkspace.SidebarIconGrid columns={3} sidebarMode="collapsed">
          <AppWorkspace.SidebarIconAction
            icon="ti ti-plus"
            label={t().newChat}
            disabled={creatingConversation()}
            onClick={() => void props.onNewConversation?.()}
          />
          <AssistantSpotlightButton variant="icon" openConversation={openConversationFromCommand} />
          <AppWorkspace.SidebarIconAction icon="ti ti-folder-plus" label={t().createProject} onClick={() => void props.onCreateProject?.()} />
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
          <PinnedSection />
          <ProjectsSection />
          <AppWorkspace.SidebarSection title={t().chats}>
            <Show when={generalConversations().length > 0} fallback={<p class="px-2 py-1 text-xs text-dimmed">{t().noChats}</p>}>
              <For each={visibleGeneralConversations()}>
                {(conversation) => (
                  <ConversationSidebarItem
                    conversation={conversation}
                    active={conversation.id === activeConversationId()}
                    open={props.onOpenConversation ? (item) => props.onOpenConversation!(item.id) : undefined}
                    edit={(item) => void openEditor(item)}
                  />
                )}
              </For>
            </Show>
            <AppWorkspace.SidebarItem onClick={openAllChats} title={t().seeAllChats}>
              {t().seeAll}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarSection>
        </AppWorkspace.SidebarBody>
        <AppWorkspace.SidebarFooter sidebarMode="expanded">
          <AppWorkspace.SidebarItem icon="ti ti-user-cog" onClick={() => void openAssistantPrefsModal()}>
            {t().personalize}
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarFooter>
        <AppWorkspace.SidebarFooter sidebarMode="collapsed">
          <AppWorkspace.SidebarIconGrid>
            <AppWorkspace.SidebarIconAction icon="ti ti-user-cog" label={t().personalize} onClick={() => void openAssistantPrefsModal()} />
          </AppWorkspace.SidebarIconGrid>
        </AppWorkspace.SidebarFooter>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
