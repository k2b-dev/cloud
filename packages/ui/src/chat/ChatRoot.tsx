import type { JSX } from "solid-js";
import { useChatMessages } from "./chat-messages";

export type ChatRootProps = {
  children: JSX.Element;
  class?: string;
  label?: string;
};

export function ChatRoot(props: ChatRootProps): JSX.Element {
  const chatMessages = useChatMessages();
  return (
    <section class={`k2b-chat ${props.class ?? ""}`} aria-label={props.label ?? chatMessages().chat}>
      {props.children}
    </section>
  );
}
