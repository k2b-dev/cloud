import { mergeProps } from "solid-js";
import AssistantPanelFrame from "./AssistantPanelFrame";
import { AssistantLiveProvider } from "./assistant-live";
import type { AssistantWorkspaceProps } from "./assistant-workspace";
import { createAssistantWorkspace } from "./assistant-workspace";

/** The Assistant in the side panel (`/app/assistant/panel`): the shared workspace in the panel's v1 frame. */
export default function AssistantPanel(props: AssistantWorkspaceProps) {
  const w = createAssistantWorkspace(mergeProps(props, { embedded: true }));
  return (
    <AssistantLiveProvider value={w.liveHub}>
      <AssistantPanelFrame w={w} />
    </AssistantLiveProvider>
  );
}
