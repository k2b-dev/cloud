import { type ThreadView, threadHref } from "./threads";

/**
 * The address of the full view. `view` is the open part of a chat with threads ("all" without one in the address);
 * `threads` is the phone's page with the chat's threads, which a wider window shows as "All threads". Inside the
 * universal panel the same addresses start with `/app/chat/panel`.
 */
export type Route = { chatId: string | null; view: ThreadView; threads: boolean; messageId: string | null; panel: "info" | null };

export const panelHref = (
  chatId: string,
  panel: "info" | null,
  messageId?: string | null,
  view: ThreadView = "all",
  basePath = "/app/chat",
): string => `${threadHref(chatId, view, messageId, basePath)}${panel === "info" ? "?panel=info" : ""}`;

/** Unread messages in all of the reader's chats; the Cloud app's sidebar and its way back to the list count them. */
export const UNREAD_COUNT_PATH = "/api/chat/conversations/unread-count";

/** The phone's page with the chat's threads. */
export const threadsPageHref = (chatId: string, basePath = "/app/chat") => `${basePath}/c/${encodeURIComponent(chatId)}/threads`;

/** The address of a whole route, so the phone's thread page keeps its place when Info opens or closes on it. */
export const routeAddress = (route: Route, basePath = "/app/chat"): string => {
  if (!route.chatId) return basePath;
  if (route.threads) return `${threadsPageHref(route.chatId, basePath)}${route.panel === "info" ? "?panel=info" : ""}`;
  return panelHref(route.chatId, route.panel, route.messageId, route.view, basePath);
};

export const parseRoute = (url: URL): Route | null => {
  const match = /^\/(?:app\/chat(?:\/panel)?|pwa\/chat)(?:\/c\/([^/]+)(?:(\/threads)|\/t\/([^/]+))?(?:\/m\/([^/]+))?)?\/?$/.exec(
    url.pathname,
  );
  if (!match || (match[2] && match[4])) return null;
  const chatId = match[1] ? decodeURIComponent(match[1]) : null;
  return {
    chatId,
    view: match[3] ? decodeURIComponent(match[3]) : "all",
    threads: Boolean(match[2]),
    messageId: match[4] ? decodeURIComponent(match[4]) : null,
    panel: chatId && url.searchParams.get("panel") === "info" ? "info" : null,
  };
};
