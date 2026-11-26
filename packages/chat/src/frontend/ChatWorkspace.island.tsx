import type { JSX } from "solid-js";
import { type ChatWorkspaceProps, ChatWorkspaceView } from "./chat-workspace";

export type { ChatWorkspaceProps } from "./chat-workspace";

/** Chat in v1's frame: the universal panel and the Cloud app below `/pwa/chat`. */
export default function ChatWorkspace(props: ChatWorkspaceProps): JSX.Element {
  return <ChatWorkspaceView {...props} />;
}
