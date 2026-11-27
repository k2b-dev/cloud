import { AssistantLiveProvider } from "./assistant-live";
import type { AssistantWorkspaceProps } from "./assistant-workspace";
import { createAssistantWorkspace } from "./assistant-workspace";
import AssistantPageFrame from "./v2/AssistantPageFrame";

/** The Assistant page (`/app/assistant`) on v2: the shared workspace in the v2 frame. The panel has its own island. */
export default function AssistantWorkspace(props: AssistantWorkspaceProps) {
  const w = createAssistantWorkspace(props);
  return (
    <AssistantLiveProvider value={w.liveHub}>
      <AssistantPageFrame w={w} />
    </AssistantLiveProvider>
  );
}
