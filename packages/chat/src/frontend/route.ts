import { type ThreadView, threadHref } from "./threads";

/**
 * The address of the full view. `view` is the open part of a chat with threads ("all" without one in the address);
 * `threads` is the phone's page with the chat's threads, which a wider window shows as "All threads".
 */
export type Route = {
  channels?: boolean;
  query?: string;
  chatId: string | null;
  view: ThreadView;
  threads: boolean;
  messageId: string | null;
  panel: "info" | null;
};

export const panelHref = (chatId: string, panel: "info" | null, messageId?: string | null, view: ThreadView = "all"): string =>
  `${threadHref(chatId, view, messageId)}${panel === "info" ? "?panel=info" : ""}`;

/** The phone's page with the chat's threads. */
export const threadsPageHref = (chatId: string) => `/app/chat/c/${encodeURIComponent(chatId)}/threads`;

export const parseRoute = (url: URL): Route | null => {
  if (/^\/app\/chat\/channels\/?$/.test(url.pathname))
    return {
      chatId: null,
      view: "all",
      threads: false,
      messageId: null,
      panel: null,
      channels: true,
      query: (url.searchParams.get("q") ?? "").trim().slice(0, 100),
    };
  const match = /^\/app\/chat(?:\/c\/([^/]+)(?:(\/threads)|\/t\/([^/]+))?(?:\/m\/([^/]+))?)?\/?$/.exec(url.pathname);
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
