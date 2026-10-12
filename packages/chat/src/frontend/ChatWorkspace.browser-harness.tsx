import { LocaleProvider, setPageTrail } from "@k2b/ui";
import { render } from "solid-js/web";
import ChatWorkspace, { type ChatWorkspaceProps } from "./ChatWorkspace.island";

declare global {
  interface Window {
    mountChat: (props: ChatWorkspaceProps, locale: string) => void;
  }
}

window.mountChat = (props, locale) => {
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
