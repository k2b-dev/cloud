import { type AuthContext, getDateConfig, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { PwaLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { loadChatView } from "../service";
import ChatWorkspace from "./ChatWorkspace.island";

/**
 * Chat in the Cloud app below `/pwa/chat`: the same addresses and authorized snapshot as the web's `/app/chat`, with a
 * chat, one of its threads, a message deep link and the phone's thread page.
 */
export default ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  const locale = getLocale(c);
  const { t } = chatMessages.resolve([locale]);
  const accessSubject = c.get("accessSubject");
  if (accessSubject.type !== "user") return ssr.error(c, 403, { layout: "pwa" });
  const chatId = c.req.param("chat") ?? null;
  const thread = c.req.param("thread") ?? "all";
  const view = await loadChatView(
    { actor: c.get("actor"), accessSubject, locale, requestId: c.req.header("x-request-id") },
    { conversationId: chatId ?? undefined, messageId: c.req.param("message"), thread },
  );
  // Without access the page names neither the chat nor whether it exists.
  const title = chatId ? (view.open?.conversation.title ?? t.noAccessTitle) : t.appName;
  return () => (
    <PwaLayout c={c} title={title} bare>
      <ChatWorkspace
        app
        cursor={view.cursor}
        sidebar={view.sidebar}
        open={view.open}
        chatId={chatId}
        view={thread}
        threadsPage={chatId !== null && c.req.path.endsWith("/threads")}
        guest={getUserBackedActor(c)?.profile === "guest"}
        panel={chatId && view.open && c.req.query("panel") === "info" ? "info" : null}
        viewerId={accessSubject.userId}
        dateConfig={getDateConfig(c)}
        now={new Date().toISOString()}
      />
    </PwaLayout>
  );
});
