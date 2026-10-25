import { type AuthContext, getDateConfig, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { Layout, PanelLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { loadChatView } from "../service";
import ChatWorkspace from "./ChatWorkspace.island";

/**
 * `/app/chat`, a chat (`/c/:chat`), one of its threads (`/c/:chat/t/:thread`), each with a message deep link (`/m/:message`),
 * and the phone's thread page (`/c/:chat/threads`): the full view with the authorized snapshot. The universal panel
 * serves the same addresses below `/app/chat/panel`.
 */
export default ssr<AuthContext>(async (c) => {
  const embedded = c.req.path === "/app/chat/panel" || c.req.path.startsWith("/app/chat/panel/");
  const locale = getLocale(c);
  const { t } = chatMessages.resolve([locale]);
  const accessSubject = c.get("accessSubject");
  if (accessSubject.type !== "user") return ssr.error(c, 403);
  const chatId = c.req.param("chat") ?? null;
  const thread = c.req.param("thread") ?? "all";
  const view = await loadChatView(
    { actor: c.get("actor"), accessSubject, locale, requestId: c.req.header("x-request-id") },
    { conversationId: chatId ?? undefined, messageId: c.req.param("message"), thread },
  );
  // Without access the page names neither the chat nor whether it exists.
  const title = chatId ? (view.open?.conversation.title ?? t.noAccessTitle) : undefined;
  const workspace = () => (
    <ChatWorkspace
      embedded={embedded}
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
  );
  if (embedded)
    return () => (
      <PanelLayout c={c} title={title ?? t.appName}>
        {workspace()}
      </PanelLayout>
    );
  return () => (
    <Layout
      c={c}
      fullPage
      title={[
        { title: t.start, href: "/" },
        title ? { title: t.appName, href: "/app/chat" } : { title: t.appName },
        ...(title ? [{ title }] : []),
      ]}
    >
      {workspace()}
    </Layout>
  );
});
