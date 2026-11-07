import { LocaleProvider, setPageTrail } from "@k2b/ui";
import { render } from "solid-js/web";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

declare global {
  interface Window {
    mountChat: (props: ChatWorkspaceProps, locale: string) => Promise<void>;
  }
}

window.mountChat = async (props, locale) => {
  const { default: ChatWorkspace } = await import("./ChatWorkspace.island");
  // Cloud's Layout publishes the page trail; the chat header reads its way up from it.
  const start = { title: "Start", href: "/" };
  setPageTrail(
    props.chatId
      ? { title: props.open?.conversation.title ?? "No access", ancestors: [start, { title: "Chat", href: "/app/chat" }] }
      : { title: "Chat", ancestors: [start] },
  );
  render(
    () => (
      <LocaleProvider locale={locale}>
        <ChatWorkspace {...props} />
      </LocaleProvider>
    ),
    document.getElementById("root")!,
  );
};
