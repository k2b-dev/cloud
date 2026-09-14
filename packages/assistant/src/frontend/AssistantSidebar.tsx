import { ConversationSidebarPreview } from "./ConversationSidebarPreview";
import { useAssistantText } from "./ui-copy";
import { type LinkNavigateEvent, navigate, navigateTo } from "@k2b/ssr/nav";
import {
  AppWorkspace,
  Dropdown,
  IconButton,
  isSpotlightShortcut,
  openSpotlightSearch,
  SPOTLIGHT_SHORTCUT_TITLE,
  toast,
  useLocale,
} from "@k2b/ui";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { type Accessor, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { openAssistantAllChatsDialog } from "./AssistantAllChatsDialog";
import { openAssistantConversationEditor } from "./AssistantConversationEditor";
import { openAssistantPrefsModal } from "./AssistantPrefsModals";
import type { AssistantLiveHub } from "./assistant-live";
import { assistantConversationHref, assistantProjectHref } from "./assistant-navigation";
import { ConversationStatusMeta } from "./conversation-status";
import { assistantMessages } from "./messages";
import { artifactMessages } from "../artifacts/messages";

type AssistantSidebarProps = {
  conversations: Accessor<AiConversation[]>;
  doneCount?: number;
  activeConversationId?: Accessor<string | null>;
  activeView?: "chat" | "all" | "apps";
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
  project?: AiProject;
  update: (conversation: AiConversation) => void;
}) {
  const text = useAssistantText();
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
      description={
        <Show when={!props.conversation.isDone}>
          <Show
            when={props.conversation.runStatus !== "idle" || props.conversation.unreadCompletion || props.conversation.pinnedAt}
            fallback={<span>{text("Ready")}</span>}
          >
            <ConversationStatusMeta conversation={props.conversation} active={props.active} labels />
          </Show>
        </Show>
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
          />
        ),
      }}
    >
      <AppWorkspace.SidebarItemLabel>{props.conversation.title}</AppWorkspace.SidebarItemLabel>
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
      />
    </AppWorkspace.SidebarItem>
  );
}

export default function AssistantSidebar(props: AssistantSidebarProps) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const text = useAssistantText();
  const activeConversations = () => props.conversations().filter((conversation) => !conversation.isDone);
  const doneConversations = () => props.conversations().filter((conversation) => conversation.isDone);
  const activeConversationId = () => props.activeConversationId?.() ?? null;
  const activeView = () => props.activeView ?? "chat";
  const creatingConversation = () => props.creatingConversation?.() ?? false;
  const pinnedConversations = () =>
    activeConversations()
      .filter((conversation) => conversation.pinnedAt)
      .toSorted((left, right) => Date.parse(right.pinnedAt!) - Date.parse(left.pinnedAt!));
  const unpinnedConversations = () => activeConversations().filter((conversation) => !conversation.pinnedAt);
  const generalConversations = () => unpinnedConversations().filter((conversation) => !conversation.projectId);
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
      .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const openProject = async (project: AiProject) => {
    if (props.activeProjectId === project.id) return;
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
  const ProjectsTree = () => (
    <For each={props.projects ?? []}>
      {(project) => (
        <AppWorkspace.SidebarSection
          title={project.name}
          collapsible
          open={expandedProjects().includes(`project:${project.id}`)}
          onOpenChange={(open) =>
            setExpandedProjects((current) =>
              open ? [...current, `project:${project.id}`] : current.filter((id) => id !== `project:${project.id}`),
            )
          }
          actions={
            <IconButton size="xs" label={project.name} onClick={() => void openProject(project)}>
              <i class={project.icon || "ti ti-folder"} aria-hidden="true" />
            </IconButton>
          }
        >
          <For each={projectChats(project)}>
            {(conversation) => (
              <ConversationSidebarItem
                conversation={conversation}
                project={project}
                active={conversation.id === activeConversationId()}
                open={props.onOpenConversation ? (item) => props.onOpenConversation!(item.id) : undefined}
                edit={(item) => void openEditor(item)}
                update={(item) => props.onConversationUpdated?.(item)}
              />
            )}
          </For>
          <Show when={!projectChats(project).length}>
            <p class="px-2 py-1 text-xs text-dimmed">{t().noRecentChats}</p>
          </Show>
        </AppWorkspace.SidebarSection>
      )}
    </For>
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
              project={props.projects?.find((project) => project.id === conversation.projectId)}
              update={(item) => props.onConversationUpdated?.(item)}
            />
          )}
        </For>
      </AppWorkspace.SidebarSection>
    </Show>
  );
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
      class="max-h-[40vh] overflow-y-auto"
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
      <AppWorkspace.SidebarItem onClick={() => openAllChats()}>{t().allChats}</AppWorkspace.SidebarItem>
    </AppWorkspace.SidebarSection>
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
          .map((conversation) => ({
            label: conversation.title,
            action: () => openConversationFromCommand(conversation),
          })),
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
          <AppWorkspace.SidebarItem icon="ti ti-app-window" href="/app/assistant/apps">
            {artifactMessages.resolve([locale()]).t.apps}
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
              <For each={generalConversations()}>
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
          <AppWorkspace.SidebarIconAction
            icon="ti ti-folder-plus"
            label={t().createProject}
            onClick={() => void props.onCreateProject?.()}
          />
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
              <For each={generalConversations()}>
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
          <AppWorkspace.SidebarItem
            sidebarMode="expanded"
            icon="ti ti-app-window"
            href="/app/assistant/apps"
            active={activeView() === "apps"}
          >
            {artifactMessages.resolve([locale()]).t.apps}
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarItem icon="ti ti-user-cog" onClick={() => void openAssistantPrefsModal()}>
            {t().personalize}
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarFooter>
        <AppWorkspace.SidebarFooter sidebarMode="collapsed">
          <AppWorkspace.SidebarIconGrid>
            <AppWorkspace.SidebarIconAction icon="ti ti-check" label={text("Done")} onClick={() => openAllChats(true)} />
            <AppWorkspace.SidebarIconAction
              icon="ti ti-app-window"
              label={artifactMessages.resolve([locale()]).t.apps}
              onClick={() => navigateTo("/app/assistant/apps")}
            />
            <AppWorkspace.SidebarIconAction icon="ti ti-user-cog" label={t().personalize} onClick={() => void openAssistantPrefsModal()} />
          </AppWorkspace.SidebarIconGrid>
        </AppWorkspace.SidebarFooter>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
