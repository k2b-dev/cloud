import { AppWorkspace, Dropdown } from "@k2b/ui";
import { render } from "solid-js/web";
import { AssistantChatContextContent, AssistantChatContextPanel, type ContextView } from "../frontend/AssistantChatContext";
import { AssistantLiveProvider, createAssistantLiveInvalidationHub } from "../frontend/assistant-live";
import { ArtifactWorkspace, createArtifactWorkspace } from "./Workspace";
import { appTab, contextTab, fileTab } from "./workspace-state";
const live = createAssistantLiveInvalidationHub({ onApplied: () => {} });
render(() => {
  const controller = createArtifactWorkspace();
  const open = (view: ContextView) => controller.open(view.context ? contextTab(view.context.conversationId, view.context.category, view.title) : view.file ? fileTab(view.file.conversationId, view.file.path) : { ...view, kind: "view" });
  const menuItems = [
    { label: "Apps", action: () => controller.open(contextTab("chat-one", "apps", "Apps")) },
    { label: "Files", action: () => controller.open(contextTab("chat-one", "files", "Files")) },
  ];
  return <AssistantLiveProvider value={live}>
    <AppWorkspace><AppWorkspace.Content><AppWorkspace.Main>
      <AppWorkspace.MainPane id="chat" label="Chat" class="assistant-chat-pane">
        <div class="assistant-chat-shell" style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
          <div class="assistant-context-open"><Dropdown.Root items={menuItems}><Dropdown.Trigger iconOnly label="Open">+</Dropdown.Trigger></Dropdown.Root></div>
          <div class="assistant-chat-layout">
            <div class="assistant-chat-messages"><div class="k2b-chat-timeline__viewport">Messages</div></div>
            <div class="assistant-chat-composer"><input aria-label="Message" /></div>
            <AssistantChatContextPanel chatId="chat-one" onOpenView={open} onOpenApp={(id,title) => controller.open(appTab(id,title))} />
          </div>
        </div>
      </AppWorkspace.MainPane>
      <AppWorkspace.MainPane id="workspace" label="Workspace" open={controller.state().tabs.length > 0} defaultSize={620}>
        <ArtifactWorkspace controller={controller} userId="test" refreshKey="initial" onOpenView={open} conversationId="chat-one" menuItems={menuItems} />
      </AppWorkspace.MainPane>
    </AppWorkspace.Main></AppWorkspace.Content></AppWorkspace>
  </AssistantLiveProvider>;
}, document.getElementById("root")!);
