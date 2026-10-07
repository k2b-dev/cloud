import { AppWorkspace, Dropdown } from "@k2b/ui";
import { render } from "solid-js/web";
import { assistantChatSidebarActions, type ContextView, createAssistantChatContextState } from "../frontend/AssistantChatContext";
import { AssistantChatSidebarPanel } from "../frontend/AssistantChatSidebar";
import { AssistantLiveProvider, createAssistantLiveHub } from "../frontend/assistant-live";
import { ArtifactWorkspace, createArtifactWorkspace } from "./Workspace";
import { appTab, contextTab, fileTab } from "./workspace-state";

const live = createAssistantLiveHub();

function ChatSidebar(props: { open: (view: ContextView) => void; openApp: (id: string, title: string) => void }) {
  const state = createAssistantChatContextState({ chatId: "chat-one" });
  return (
    <AssistantChatSidebarPanel
      id="assistant-chat-context"
      state={state}
      runCount={state.snapshot()?.runCount}
      onClose={() => undefined}
      actions={assistantChatSidebarActions({
        chatId: "chat-one",
        project: null,
        copy: { files: "Files", apps: "Studio", knowledge: "Project knowledge", sources: "Sources" },
        onOpenView: props.open,
        onOpenApp: props.openApp,
        onJump: () => undefined,
      })}
    />
  );
}
render(() => {
  const controller = createArtifactWorkspace();
  const open = (view: ContextView) =>
    controller.open(
      view.context
        ? contextTab(view.context.conversationId, view.context.category, view.title)
        : view.file
          ? fileTab(view.file.conversationId, view.file.path)
          : { ...view, kind: "view" },
    );
  const menuItems = [
    { label: "Studio", action: () => controller.open(contextTab("chat-one", "apps", "Studio")) },
    { label: "Files", action: () => controller.open(contextTab("chat-one", "files", "Files")) },
  ];
  return (
    <AssistantLiveProvider value={live}>
      <AppWorkspace>
        <AppWorkspace.Content>
          <AppWorkspace.Main>
            <AppWorkspace.MainPane id="chat" label="Chat" class="assistant-chat-pane">
              <div class="assistant-chat-shell" style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
                <div class="assistant-context-open">
                  <Dropdown.Root items={menuItems}>
                    <Dropdown.Trigger iconOnly label="Open">
                      +
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                </div>
                <div class="assistant-chat-layout" data-context="auto">
                  <div class="assistant-chat-messages">
                    <div class="k2b-chat-timeline__viewport">Messages</div>
                  </div>
                  <div class="assistant-chat-composer">
                    <input aria-label="Message" />
                  </div>
                  <ChatSidebar open={open} openApp={(id, title) => controller.open(appTab(id, title))} />
                </div>
              </div>
            </AppWorkspace.MainPane>
            <AppWorkspace.MainPane id="workspace" label="Workspace" open={controller.state().tabs.length > 0} defaultSize={620}>
              <ArtifactWorkspace
                onEditTask={() => {}}
                controller={controller}
                userId="test"
                refreshKey="initial"
                onOpenView={open}
                conversationId="chat-one"
                menuItems={menuItems}
              />
            </AppWorkspace.MainPane>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </AssistantLiveProvider>
  );
}, document.getElementById("root")!);
