import { type AuthContext, getDateConfig, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { Layout, PanelLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { chatRequestContext } from "../request-context";
import { chatService, loadChatView } from "../service";

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
  const archived = c.req.path.endsWith("/archive") || c.req.query("list") === "archive";
  let unread = (c.req.query("listFilter") ?? c.req.query("filter")) === "unread";
  const channelsPage = /\/channels\/?$/.test(c.req.path);
  const channelQuery = (c.req.query("q") ?? "").trim().slice(0, 100);
  const channelResult = channelsPage
    ? await chatService.channels.browse({ actor: c.get("actor"), accessSubject, locale, query: { q: channelQuery } }).catch(() => null)
    : null;
  const chatId = c.req.param("chat") ?? null;
  const thread = c.req.param("thread") ?? "all";
  const view = await loadChatView(chatRequestContext(c), {
    conversationId: chatId ?? undefined,
    messageId: c.req.param("message"),
    thread,
    archived,
    unread,
  });
  // `filter` belongs to the system thread directory. Direct v12 URLs without personal state keep the ordinary list.
  if (view.open?.conversation.kind === "system" && !c.req.query("listFilter") && unread) {
    unread = false;
    const sidebar = await chatService.conversations.list({ ...chatRequestContext(c), query: { archived: archived ? "true" : "false" } });
    if (!sidebar.ok) throw new Error(sidebar.error.message);
    view.sidebar = sidebar.data;
  }
  const listHref = `${archived ? "/app/chat/archive" : "/app/chat"}${unread ? "?filter=unread" : ""}`;
  const preferences = await chatService.personal.preferences({
    actor: c.get("actor"),
    accessSubject,
    locale,
    requestId: c.req.header("x-request-id"),
  });
  if (!preferences.ok) throw new Error("Chat preferences could not be loaded");
  const collapsed = preferences.data.collapsed;
  // Without access the page names neither the chat nor whether it exists.
  const title = channelsPage ? t.browseChannels : chatId ? (view.open?.conversation.title ?? t.noAccessTitle) : undefined;
  const workspace = () => (
    <ChatWorkspace
      embedded={embedded}
      archived={archived}
      filter={unread ? "unread" : "all"}
      collapsed={collapsed}
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
        title ? { title: t.appName, href: listHref } : { title: t.appName },
        ...(title ? [{ title }] : []),
      ]}
    >
      {workspace()}
    </Layout>
  );
});
