import { useLocale } from "@k2b/ui";
import { Canvas, Pane, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { AssistantWorkspaceParts } from "../assistant-workspace";
import { assistantV2Messages } from "./assistant-v2-messages";

/** The chat and its tabs scroll inside themselves and fill the Canvas without asking for their own height. */
const drawing = { position: "absolute", inset: "0", display: "flex", "flex-direction": "column", "min-height": "0" } as const;

/**
 * The panel's frame on v2 (`/app/assistant/panel`, `PanelLayout ui="v2"`): the chat and, while one is open, its tabs.
 * The panel is a narrow column beside the app, so it has no sidebar: the place bar, the place's Code, "Neuer Chat" and
 * "Alle Chats" (which opens the app) stand with the chat, as in v1's panel. The chat and those parts are Cloud's shared
 * chat parts and the panel's own, drawn in the Canvas.
 */
export default function AssistantPanelFrameV2(frame: { w: AssistantWorkspaceParts }) {
  const w = frame.w;
  const locale = useLocale();
  const v2 = () => assistantV2Messages.resolve([locale()]).t;
  // The tabs' pane has the one way back; v1's own button above the tabs stays away.
  w.setTabsBackToChat(false);
  const focused = () => w.artifactWorkspace.mobile() === "workspace";
  return (
    <Workspace>
      <Pane.Split>
        <Pane label={v2().chatPane}>
          <Canvas label={v2().chatPane} height="fill">
            {/* The chat's own layout reads its width from this container (`assistant-chat`). */}
            <div class="assistant-chat-pane" style={drawing}>
              <w.MainContent />
            </div>
          </Canvas>
        </Pane>
        <Show when={w.artifactWorkspace.state().tabs.length > 0}>
          {/* k2b-ui gap (Z2, gap a): only the pane in front should stand in a narrow split. */}
          <Pane
            label={v2().tabsPane}
            detail={focused()}
            back={
              focused()
                ? {
                    label: w.activeConversation()?.title ?? w.artifactCopy().chat,
                    onClick: () => {
                      w.artifactWorkspace.setMobile("chat");
                      w.focusComposer();
                    },
                  }
                : undefined
            }
            width={{ min: 320, default: 680 }}
          >
            <Canvas label={v2().tabsPane} height="fill">
              <div style={drawing}>
                <w.TabsContent />
              </div>
            </Canvas>
          </Pane>
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
