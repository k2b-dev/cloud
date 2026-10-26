import { type AuthContext, getDateConfig, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { PwaLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { chatRequestContext } from "../request-context";
import { chatService, loadChatView } from "../service";
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
  const context = chatRequestContext(c);
  const archived = c.req.path.endsWith("/archive") || c.req.query("list") === "archive";
  let unread = (c.req.query("listFilter") ?? c.req.query("filter")) === "unread";
  const channelsPage = /\/channels\/?$/.test(c.req.path);
  const channelQuery = (c.req.query("q") ?? "").trim().slice(0, 100);
  const channelResult = channelsPage
    ? await chatService.channels.browse({ ...context, query: { q: channelQuery } }).catch(() => null)
    : null;
  const chatId = c.req.param("chat") ?? null;
  const thread = c.req.param("thread") ?? "all";
  const view = await loadChatView(context, {
    conversationId: chatId ?? undefined,
    messageId: c.req.param("message"),
    thread,
    archived,
    unread,
  });
  // System thread filters and personal list filters retain the web route's separate URL state.
  if (view.open?.conversation.kind === "system" && !c.req.query("listFilter") && unread) {
    unread = false;
    const sidebar = await chatService.conversations.list({ ...context, query: { archived: archived ? "true" : "false" } });
    if (!sidebar.ok) throw new Error(sidebar.error.message);
    view.sidebar = sidebar.data;
  }
  const preferences = await chatService.personal.preferences(context);
  if (!preferences.ok) throw new Error("Chat preferences could not be loaded");
  // Without access the page names neither the chat nor whether it exists.
  const title = channelsPage ? t.browseChannels : chatId ? (view.open?.conversation.title ?? t.noAccessTitle) : t.appName;
  return () => (
    <PwaLayout c={c} title={title} bare>
      <ChatWorkspace
        app
        archived={archived}
        filter={unread ? "unread" : "all"}
        collapsed={preferences.data.collapsed}
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
    </PwaLayout>
  );
});
