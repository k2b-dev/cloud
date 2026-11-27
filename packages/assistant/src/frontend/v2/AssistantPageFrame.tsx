import { navigateTo } from "@k2b/ssr/nav";
import { Button } from "@k2b/ui/v2";
import { createSignal, lazy, Show, Suspense } from "solid-js";
import { AssistantLiveProvider } from "../assistant-live";
import { assistantProjectHref } from "../assistant-navigation";
import type { AssistantWorkspaceParts } from "../assistant-workspace";
import { codeViewMessages } from "../code-view-messages";
import { lazyAction } from "../lazy-action";
import { useAssistantText } from "../ui-copy";
// The page's own views come with its island, so each draws the server's data on the first picture, without a loader.
import AssistantAppsV2 from "./AssistantAppsV2";
import AssistantFrameV2 from "./AssistantFrameV2";
import AssistantPrefsV2 from "./AssistantPrefsV2";
import AssistantProjectSettingsV2 from "./AssistantProjectSettingsV2";
import AssistantProjectV2 from "./AssistantProjectV2";
import AssistantWaitingV2 from "./AssistantWaitingV2";
import { createAssistantChatDeeds } from "./assistant-chat-deeds";

/** Loaded when someone opens All chats. */
const AllChats = lazy(() => import("./AssistantAllChatsDialogV2"));
/** Loaded when someone creates a project: the form stays out of the page's bundle. */
const createProjectForm = lazyAction(() => import("../AssistantProjectsDialog"));

/**
 * The page's frame on v2 (`/app/assistant`): the sidebar, the head, the chat and its tabs, and Waiting for you,
 * around the parts the workspace shares with the panel. Only the page's island loads it.
 */
export default function AssistantPageFrame(frame: { w: AssistantWorkspaceParts }) {
  const w = frame.w;
  const text = useAssistantText();
  // The chat's title and "In diesem Chat" stand in this frame's head, not in a row above the timeline.
  w.setContextHead(false);
  // The tabs' pane has the one way back on the phone; v1's own button above the tabs stays away.
  w.setTabsBackToChat(false);
  // The tabs say each title once (on the chip) and show the chat's context in v2's rows.
  w.setV2Tabs(true);
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
  // All chats is a v2 dialog of this page, loaded when someone opens it.
  const [allChats, setAllChats] = createSignal<"all" | "done" | null>(null);
  const headPath = () => {
    if (w.mainView() === "approvals") return [{ label: w.t().waitingForYou }];
    if (w.mainView() === "code") return [{ label: w.t().myCode, href: w.codeHref }];
    if (w.mainView() === "prefs") return [{ label: w.t().personalize }];
    const project = w.activeProject();
    if (project && w.projectSettings())
      return [{ label: project.name, href: assistantProjectHref(w.basePath, project.id) }, { label: text("Project settings") }];
    if (project) return [{ label: project.name }];
    const open = w.activeConversation();
    // A new chat has no name yet; "Neuer Chat" stands once, as the head's action.
    if (!open) return [];
    const own = w.projects().find((entry) => entry.id === open.projectId);
    return [...(own ? [{ label: own.name, href: assistantProjectHref(w.basePath, own.id) }] : []), { label: open.title }];
  };
  return (
    <>
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
          retryPlaceChats: () => void w.sidebar.refresh(),
          anyChats: () => {
            const counts = w.sidebar.data()?.counts ?? w.props.initialCounts;
            const places = w.sidebar.data()?.placeChats ?? w.props.initialPlaceChats;
            return (
              w.conversations().length > 0 ||
              (w.sidebar.data()?.doneCount ?? w.props.initialDoneCount) > 0 ||
              (places?.total ?? 0) > 0 ||
              Boolean(counts?.hasArchived)
            );
          },
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
          openAllChats: (view = "all") => setAllChats(view),
          openPreferences: () => w.openPrefs("personalization"),
          onConversationUpdated: w.updateConversation,
        }}
        openContext={(title) => w.openChatContext(title)}
        openChat={() => (w.mainView() || w.activeProject() ? null : (w.activeConversation() ?? null))}
        path={headPath}
        pagePrimary={() => w.projectSettings() && w.activeProject()?.permission === "admin"}
        // Only My apps floats New chat on the phone: a Project has its composer, which starts its new chat (look rules).
        fab={() => w.mainView() === "code"}
        // My apps' own way to create, in the head at every width (the phone hides a status row's end).
        viewActions={() =>
          w.mainView() === "code" && !w.codeDetailShown() ? (
            <Button icon="sparkles" onClick={() => void w.createFromCodeView()}>
              {codeViewMessages.resolve([w.locale()]).t.codeCreateInChat}
            </Button>
          ) : undefined
        }
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
            : w.mainView() === "code" && !w.codeDetailShown()
              ? () => (
                  <AssistantAppsV2
                    userId={w.props.userId}
                    timeZone={w.props.timeZone}
                    initial={w.codeRendered() ? w.props.code?.page : undefined}
                    onCreateInChat={w.createFromCodeView}
                  />
                )
              : w.mainView() === "prefs"
                ? () => <AssistantPrefsV2 basePath={w.basePath} tab={w.prefsTab()} onTab={w.openPrefs} initial={w.prefsSeed()} />
                : w.projectView()
                  ? () => (
                      // The open Project as its own panes: its chats and composer, its context beside them.
                      <Show when={w.projectView()} keyed>
                        {(view) => (
                          <Show
                            when={w.projectSettings() && w.activeProject()?.permission === "admin" ? w.activeProject() : null}
                            fallback={
                              <w.ProjectContent
                                view={view}
                                v2={(parts) => <AssistantProjectV2 {...parts} settings={w.openProjectSettings} />}
                              />
                            }
                          >
                            {(project) => (
                              <AssistantProjectSettingsV2
                                project={project()}
                                onDone={w.closeProjectSettings}
                                initial={w.projectSettingsSeed()}
                              />
                            )}
                          </Show>
                        )}
                      </Show>
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
            // Back to the chat, and the focus with it: into the composer, never left on the page's body.
            onClick: () => {
              w.artifactWorkspace.setMobile("chat");
              w.focusComposer();
            },
          }),
          content: <w.TabsContent />,
        }}
      />
      <Show when={allChats()} keyed>
        {(view) => (
          <Suspense>
            <AssistantLiveProvider value={w.liveHub}>
              <AllChats
                basePath={w.basePath}
                initialView={view}
                projects={w.projects}
                openConversation={async (conversation) => {
                  if (conversation.id === w.chat.activeConversationId()) return "unchanged";
                  return (await w.openAndFocusConversation(conversation.id)) ? "opened" : "stale";
                }}
                onClose={() => setAllChats(null)}
              />
            </AssistantLiveProvider>
          </Suspense>
        )}
      </Show>
    </>
  );
}
