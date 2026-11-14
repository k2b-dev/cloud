import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { ChatWorkspaceSnapshot, SaveChatWorkspaceInput } from "../chat-workspace";
import { AssistantLiveProvider, createAssistantLiveHub } from "../frontend/assistant-live";
import { ArtifactWorkspace, createArtifactWorkspace } from "./Workspace";
import { contextTab, fileTab } from "./workspace-state";

/**
 * The chat with its tabs as the Assistant island lays them out, for browser tests and screenshots: a fake chat on the
 * left (at least 360 px) and the workspace from `Panes` beside it. The server's tab store is in memory on `window.tabs`.
 */
type Harness = { saved: SaveChatWorkspaceInput[]; stored: ChatWorkspaceSnapshot | null };
const harness: Harness = { saved: [], stored: JSON.parse(sessionStorage.getItem("stored") ?? "null") };
(window as unknown as { tabs: Harness }).tabs = harness;
const chatId = "chat01";
const controller = createArtifactWorkspace(location.href, {
  initial: harness.stored
    ? { chatId, snapshot: harness.stored }
    : { chatId, snapshot: { state: { tabs: [], layout: null, front: null }, revision: 0 } },
  store: {
    load: async () => harness.stored ?? { state: { tabs: [], layout: null, front: null }, revision: 0 },
    save: async (_chat, input) => {
      harness.saved.push(input);
      harness.stored = { state: input.state, revision: input.revision + 1 };
      sessionStorage.setItem("stored", JSON.stringify(harness.stored));
      return { conflict: false, revision: input.revision + 1 };
    },
  },
});
(window as unknown as { controller: typeof controller }).controller = controller;
(window as unknown as { open: Record<string, () => void> }).open = {
  report: () => controller.open(fileTab(chatId, "/Lieferavis Kern 11-2026.txt")),
  table: () => controller.open(fileTab(chatId, "/Offene Rückfragen Kern.csv")),
  sources: () => controller.open(contextTab(chatId, "sources", "Quellen")),
};
const locale = new URL(location.href).searchParams.get("lang") ?? "de";

render(
  () => (
    <LocaleProvider locale={locale}>
      <AssistantLiveProvider value={createAssistantLiveHub()}>
        <AppWorkspace class="tabs-harness" mobileSurface="flush">
          <AppWorkspace.Content>
            <AppWorkspace.Main scroll={false} mobilePane={controller.mobile()}>
              <AppWorkspace.MainPane id="chat" label="Chat" scroll={false} minSize={360} class="assistant-chat-pane">
                <div class="harness-chat" style={{ padding: "1.5rem", height: "100%" }}>
                  <p>Leg zu jedem Lieferavis den Lieferschein aus dem Anhang im Ordner „Lieferscheine 2026“ ab.</p>
                  <p>Mache ich. Ich erweitere die Automation des Postfachs.</p>
                </div>
              </AppWorkspace.MainPane>
              <AppWorkspace.MainPane
                id="workspace"
                label="Arbeitsbereich"
                open={controller.state().tabs.length > 0}
                defaultSize={680}
                minSize={320}
                scroll={false}
              >
                <ArtifactWorkspace
                  controller={controller}
                  userId="user123"
                  refreshKey="initial"
                  onEditTask={() => {}}
                  conversationId={chatId}
                  onJump={() => {}}
                  onAsk={(title) => ((window as unknown as { asked?: string }).asked = title)}
                  onAdd={() => controller.open(contextTab(chatId, "files", "In diesem Chat"))}
                  arrangeHint={{ open: false, onDismiss: () => {} }}
                />
              </AppWorkspace.MainPane>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </AssistantLiveProvider>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
