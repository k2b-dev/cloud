import type { JSX } from "solid-js";
import { useUiMessages } from "../intl/messages";

export type ChatRootProps = {
  children: JSX.Element;
  class?: string;
  label?: string;
};

export function ChatRoot(props: ChatRootProps): JSX.Element {
  const messages = useUiMessages();
  return (
    <section class={`k2b-chat ${props.class ?? ""}`} aria-label={props.label ?? messages().chat}>
      {props.children}
    </section>
  );
}
