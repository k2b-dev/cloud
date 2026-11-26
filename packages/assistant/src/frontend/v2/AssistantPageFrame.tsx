import { navigateTo } from "@k2b/ssr/nav";
import { assistantProjectHref } from "../assistant-navigation";
import type { AssistantWorkspaceParts } from "../assistant-workspace";
import { lazyAction } from "../lazy-action";
import { openAssistantPrefsModal } from "../rare-dialogs";
import AssistantFrameV2 from "./AssistantFrameV2";
import AssistantWaitingV2 from "./AssistantWaitingV2";
import { createAssistantChatDeeds } from "./assistant-chat-deeds";

/** Loaded when someone creates a project: the form stays out of the page's bundle. */
const createProjectForm = lazyAction(() => import("../AssistantProjectsDialog"));

/**
 * The page's frame on v2 (`/app/assistant`): the sidebar, the head, the chat and its tabs, and Waiting for you,
 * around the parts the workspace shares with the panel. Only the page's island loads it.
 */
export default function AssistantPageFrame(frame: { w: AssistantWorkspaceParts }) {
  const w = frame.w;
  const deeds = createAssistantChatDeeds({
    basePath: w.basePath,
    locale: w.locale,
    live: w.liveHub,
    projects: w.projects,
    conversations: w.conversations,
    activeConversationId: w.chat.activeConversationId,
    archiveBlocker: w.archiveBlocker,
    queuedMessageCount: (conversation) =>
      conversation.id === w.chat.activeConversationId() &&
      !w.queuedMessages.loading() &&
      !w.queuedMessages.stale() &&
      !w.queuedMessages.error()
        ? w.queuedMessages.data()?.length
        : undefined,
    openConversation: w.openAndFocusConversation,
    onUpdated: w.updateConversation,
    onArchived: w.archiveConversation,
  });
  const headPath = () => {
    if (w.mainView() === "approvals") return [{ label: w.t().waitingForYou }];
    if (w.mainView() === "code") return [{ label: w.t().myCode, href: w.codeHref }];
    const project = w.activeProject();
    if (project) return [{ label: project.name }];
    const open = w.activeConversation();
    // A new chat has no name yet; "Neuer Chat" stands once, as the head's action.
    if (!open) return [];
    const own = w.projects().find((entry) => entry.id === open.projectId);
    return [...(own ? [{ label: own.name, href: assistantProjectHref(w.basePath, own.id) }] : []), { label: open.title }];
  };
  return (
    <AssistantFrameV2
      nav={{
        basePath: w.basePath,
        conversations: w.conversations,
        doneCount: () => w.sidebar.data()?.doneCount ?? w.props.initialDoneCount,
        timeZone: w.props.timeZone,
        renderedAt: w.props.renderedAt,
        activeConversationId: w.chat.activeConversationId,
        activeView: () => w.mainView() ?? "chat",
        activeProjectId: () => w.activeProject()?.id ?? null,
        projects: w.projects,
        waitingCount: () => w.waiting().total,
        hasPersonalCode: () => Boolean(w.props.code?.has),
        placeChats: () => w.sidebar.data()?.placeChats ?? w.props.initialPlaceChats ?? null,
        moreConversations: () => w.sidebar.data()?.moreConversations ?? w.props.initialMoreConversations ?? false,
        openConversation: w.openAndFocusConversation,
        openProject: w.openProject,
        openApprovals: w.openApprovals,
        openCode: w.openCode,
        createProject: async () => {
          // Loaded when someone creates a project: the form stays out of the workspace bundle.
          const project = await createProjectForm(w.locale(), (module) => module.openAssistantCreateProjectDialog());
          if (project) navigateTo(assistantProjectHref(w.basePath, project.id));
        },
        editConversation: deeds.edit,
        archiveConversation: deeds.archive,
        archiveBlocker: w.archiveBlocker,
        openAllChats: deeds.openAll,
        openPreferences: () => void openAssistantPrefsModal(),
        onConversationUpdated: w.updateConversation,
      }}
      openChat={() => (w.mainView() || w.activeProject() ? null : (w.activeConversation() ?? null))}
      path={headPath}
      newChat={() => ({
        label: w.t().newChat,
        icon: "plus",
        disabled: w.newConversation.loading() || w.composerPicking() > 0,
        onClick: () => void w.createAndFocusConversation(),
      })}
      main={<w.MainContent />}
      view={() =>
        w.mainView() === "approvals"
          ? () => (
              <AssistantWaitingV2
                initial={w.approvalsRendered() ? w.props.approvals.page : undefined}
                questions={() => w.waiting().entries}
                questionsPage={w.openQuestions}
                onJump={(question) => void w.jumpToQuestion(question)}
                initialAutomations={w.approvalsRendered() ? w.props.initialAutomations : undefined}
                timeZone={w.props.timeZone}
                total={() => w.waiting().total}
              />
            )
          : null
      }
      tabs={{
        open: () => w.artifactWorkspace.state().tabs.length > 0,
        // The tabs are the open thing (the detail, the page on the phone) only while the controller shows them; the
        // server and the first render read the same state, so nothing jumps.
        focused: () => w.artifactWorkspace.mobile() === "workspace",
        back: () => ({
          label: w.activeConversation()?.title ?? w.artifactCopy().chat,
          onClick: () => w.artifactWorkspace.setMobile("chat"),
        }),
        content: <w.TabsContent />,
      }}
    />
  );
}
