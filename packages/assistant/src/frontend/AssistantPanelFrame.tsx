import { navigateTo } from "@k2b/ssr/nav";
import { AppWorkspace } from "@k2b/ui";
import AssistantSidebar from "./AssistantSidebar";
import { assistantArchiveBlocker } from "./archive-blocker";
import { assistantProjectHref } from "./assistant-navigation";
import type { AssistantWorkspaceParts } from "./assistant-workspace";
import { lazyAction } from "./lazy-action";

/** Loaded when someone creates a project: the form stays out of the panel's bundle. */
const createProjectForm = lazyAction(() => import("./AssistantProjectsDialog"));

/**
 * The panel's frame (`/app/assistant/panel`), still v1: the sidebar beside the chat and its tabs.
 * k2b-ui gap: #4311: PanelLayout has no `ui: "v2"`; until it has, the panel keeps this frame.
 */
export default function AssistantPanelFrame(frame: { w: AssistantWorkspaceParts }) {
  const w = frame.w;
  return (
    <AppWorkspace mobileSurface="flush" class="flex-1 min-h-0">
      <AssistantSidebar
        basePath={w.basePath}
        conversations={w.conversations}
        timeZone={w.props.timeZone}
        renderedAt={w.props.renderedAt}
        doneCount={w.sidebar.data()?.doneCount ?? w.props.initialDoneCount}
        activeConversationId={w.chat.activeConversationId}
        activeView={((view) => (view === "prefs" || !view ? "chat" : view))(w.mainView())}
        projects={w.projects()}
        activeProjectId={w.activeProject()?.id ?? null}
        creatingConversation={() => w.newConversation.loading() || w.composerPicking() > 0}
        onNewConversation={() => void w.createAndFocusConversation()}
        onCreateProject={async () => {
          // Loaded when someone creates a project: the form stays out of the workspace bundle.
          const project = await createProjectForm(w.locale(), (module) => module.openAssistantCreateProjectDialog());
          if (project) navigateTo(assistantProjectHref(w.basePath, project.id));
        }}
        onOpenProject={w.openProject}
        onOpenConversation={w.openAndFocusConversation}
        archiveBlocker={(conversation) =>
          assistantArchiveBlocker(conversation, conversation.id === w.chat.activeConversationId() ? w.chat.activeTurn() : null)
        }
        queuedMessageCount={(conversation) =>
          conversation.id === w.chat.activeConversationId() &&
          !w.queuedMessages.loading() &&
          !w.queuedMessages.stale() &&
          !w.queuedMessages.error()
            ? w.queuedMessages.data()?.length
            : undefined
        }
        onConversationUpdated={w.updateConversation}
        onConversationArchived={w.archiveConversation}
        waitingCount={() => w.waiting().total}
        onOpenApprovals={w.openApprovals}
        hasPersonalCode={() => Boolean(w.props.code?.has)}
        onOpenCode={w.openCode}
        live={w.liveHub}
        placeChats={() => w.sidebar.data()?.placeChats ?? null}
        initialPlacesFilter={w.props.initialPlacesFilter}
      />
      <AppWorkspace.Content>
        <AppWorkspace.Main scroll={false} mobilePane={w.artifactWorkspace.mobile()}>
          <AppWorkspace.MainPane
            id="chat"
            label={w.artifactCopy().chat}
            scroll={false}
            minSize={360}
            class="assistant-chat-pane flex min-h-0 flex-col"
          >
            <w.MainContent />
          </AppWorkspace.MainPane>
          <AppWorkspace.MainPane
            id="workspace"
            label={w.artifactCopy().workspace}
            open={w.artifactWorkspace.state().tabs.length > 0}
            defaultSize={680}
            minSize={320}
            scroll={false}
          >
            <w.TabsContent />
          </AppWorkspace.MainPane>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
