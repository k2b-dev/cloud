import { type AuthContext, getDateConfig, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { chatService, loadChatView } from "../service";
import ChatWorkspace from "./ChatWorkspace.island";

/**
 * `/app/chat`, a chat (`/c/:chat`), one of its threads (`/c/:chat/t/:thread`), each with a message deep link (`/m/:message`),
 * and the phone's thread page (`/c/:chat/threads`): the full view with the authorized snapshot.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = chatMessages.resolve([locale]);
  const accessSubject = c.get("accessSubject");
  if (accessSubject.type !== "user") return ssr.error(c, 403);
  const channelsPage = /\/channels\/?$/.test(c.req.path);
  const channelQuery = (c.req.query("q") ?? "").trim().slice(0, 100);
  const channelResult = channelsPage
    ? await chatService.channels.browse({ actor: c.get("actor"), accessSubject, locale, query: { q: channelQuery } }).catch(() => null)
    : null;
  const chatId = c.req.param("chat") ?? null;
  const thread = c.req.param("thread") ?? "all";
  const view = await loadChatView(
    { actor: c.get("actor"), accessSubject, locale, requestId: c.req.header("x-request-id") },
    { conversationId: chatId ?? undefined, messageId: c.req.param("message"), thread },
  );
  // Without access the page names neither the chat nor whether it exists.
  const title = channelsPage ? t.browseChannels : chatId ? (view.open?.conversation.title ?? t.noAccessTitle) : undefined;
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
      <ChatWorkspace
        channelsPage={channelsPage}
        channelQuery={channelQuery}
        channelPage={channelResult?.ok ? channelResult.data : null}
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
    </Layout>
  );
});
