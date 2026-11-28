import { getLiveDictationStatus } from "@k2b/cloud/ai";
import { type AuthContext, getDateConfig, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { Layout, PanelLayout } from "@k2b/cloud/ssr";
import { getCookie } from "hono/cookie";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { chatRequestContext, oauthAllowsWrites } from "../request-context";
import { chatService, loadChatView } from "../service";

import ChatWorkspace, { type ChatWorkspaceProps } from "./ChatWorkspace.island";
import ChatWorkspaceV2 from "./ChatWorkspaceV2.island";
import { chatTitle } from "./chat-title";
import { CHAT_DEVICE_NOTICE_COOKIE, parseDeviceNotice } from "./device-notice";
import { panelResourceChat } from "./panel-resource";

/**
 * `/app/chat`, a chat (`/c/:chat`), one of its threads (`/c/:chat/t/:thread`), each with a message deep link (`/m/:message`),
 * and the phone's thread page (`/c/:chat/threads`): the full view with the authorized snapshot. The universal panel
 * serves the same addresses below `/app/chat/panel`. There it starts in the discussion about the host page's resource
 * when the page shares a scope that a discussion provider declares as its container.
 */
export default ssr<AuthContext>(async (c) => {
  const embedded = c.req.path === "/app/chat/panel" || c.req.path.startsWith("/app/chat/panel/");
  const locale = getLocale(c);
  const { t } = chatMessages.resolve([locale]);
  const accessSubject = c.get("accessSubject");
  if (accessSubject.type !== "user") return ssr.error(c, 403);
  const { resourceChat, redirect, scope } = embedded
    ? await panelResourceChat(c, async (ref) => {
        const found = await chatService.systemChats.locate({ ...chatRequestContext(c), ref, credentialWrites: oauthAllowsWrites(c) });
        if (!found.ok) return null;
        const { conversation, ...location } = found.data;
        return { ...location, id: conversation };
      })
    : { resourceChat: null, redirect: null, scope: null };
  if (redirect) return c.redirect(redirect, 302);
  const archived = c.req.path.endsWith("/archive") || c.req.query("list") === "archive";
  let unread = (c.req.query("listFilter") ?? c.req.query("filter")) === "unread";
  const channelsPage = /\/channels\/?$/.test(c.req.path);
  const channelQuery = (c.req.query("q") ?? "").trim().slice(0, 100);
  const channelResult = channelsPage
    ? await chatService.channels.browse({ actor: c.get("actor"), accessSubject, locale, query: { q: channelQuery } }).catch(() => null)
    : null;
  const forYouPage = /\/for-you\/?$/.test(c.req.path);
  // The panel's ready start in a resource's discussion while nobody has written there.
  const resourcePage = embedded && resourceChat !== null && /\/resource\/?$/.test(c.req.path);
  const forYouResult = forYouPage ? await chatService.forYou.list({ ...chatRequestContext(c), query: {} }).catch(() => null) : null;
  const chatId = c.req.param("chat") ?? null;
  const thread = c.req.param("thread") ?? "all";
  const view = await loadChatView(chatRequestContext(c), {
    conversationId: chatId ?? undefined,
    messageId: c.req.param("message"),
    thread,
    archived,
    unread,
  });
  // A place opens on its "General" stream with its discussions as cards in it (v2; Valentin, v8: no column of its
  // own). Its old addresses, all threads and the directory, lead there; the list and Chat's own links already do.
  if (
    !embedded &&
    view.open?.conversation.kind === "system" &&
    chatId &&
    !c.req.param("message") &&
    (thread === "all" || /\/threads\/?$/.test(c.req.path))
  )
    return c.redirect(`/app/chat/c/${encodeURIComponent(chatId)}/t/general${c.req.query("panel") === "info" ? "?panel=info" : ""}`, 302);
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
  const liveDictation = (await getLiveDictationStatus(accessSubject)).available;
  // Without access the page names neither the chat nor whether it exists.
  const title =
    resourcePage && resourceChat
      ? t.aboutResource({ title: resourceChat.title })
      : channelsPage
        ? t.browseChannels
        : forYouPage
          ? t.forYou
          : chatId
            ? (view.open?.conversation.title ?? t.noAccessTitle)
            : undefined;
  const now = new Date();
  const workspace: ChatWorkspaceProps = {
    embedded,
    resourceChat,
    resourcePage,
    panelScope: scope,
    archived,
    filter: unread ? "unread" : "all",
    collapsed,
    channelsPage,
    channelQuery,
    channelPage: channelResult?.ok ? channelResult.data : null,
    forYouPage,
    forYouInitial: forYouResult?.ok ? forYouResult.data : null,
    cursor: view.cursor,
    sidebar: view.sidebar,
    open: view.open,
    chatId,
    view: thread,
    threadsPage: chatId !== null && c.req.path.endsWith("/threads"),
    guest: getUserBackedActor(c)?.profile === "guest",
    panel: chatId && view.open && c.req.query("panel") === "info" ? "info" : null,
    viewerId: accessSubject.userId,
    liveDictation,
    dateConfig: getDateConfig(c),
    now: now.toISOString(),
    deviceNotice: parseDeviceNotice(getCookie(c, CHAT_DEVICE_NOTICE_COOKIE), now),
  };
  if (embedded)
    return () => (
      <PanelLayout c={c} title={title ?? t.appName}>
        <ChatWorkspace {...workspace} />
      </PanelLayout>
    );
  return () => (
    <Layout
      c={c}
      fullPage
      ui="v2"
      title={chatTitle({ start: t.start, appName: t.appName, title, listHref, ownBack: channelsPage || forYouPage })}
    >
      <ChatWorkspaceV2 {...workspace} />
    </Layout>
  );
});
