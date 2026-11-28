import type { JSX } from "solid-js";
import { type ChatWorkspaceProps, ChatWorkspaceView } from "./chat-workspace";
import { chatV2Parts } from "./v2/chat-v2-parts";

/** Chat's full page (`/app/chat`) on @k2b/ui v2: the same controller as the panel and the app, in v2's frame. */
export default function ChatWorkspaceV2(props: ChatWorkspaceProps): JSX.Element {
  return <ChatWorkspaceView {...props} v2={chatV2Parts} />;
}
