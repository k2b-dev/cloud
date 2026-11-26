import { mergeProps } from "solid-js";
import { AssistantLiveProvider } from "./assistant-live";
import type { AssistantWorkspaceProps } from "./assistant-workspace";
import { createAssistantWorkspace } from "./assistant-workspace";
import AssistantPanelFrameV2 from "./v2/AssistantPanelFrameV2";

/** The Assistant in the side panel (`/app/assistant/panel`, `PanelLayout ui="v2"`): the shared workspace in the panel's v2 frame. */
export default function AssistantPanel(props: AssistantWorkspaceProps) {
  const w = createAssistantWorkspace(mergeProps(props, { embedded: true }));
  return (
    <AssistantLiveProvider value={w.liveHub}>
      <AssistantPanelFrameV2 w={w} />
    </AssistantLiveProvider>
  );
}
