export type Route = { chatId: string | null; messageId: string | null; panel: "info" | null };

export const panelHref = (chatId: string, panel: "info" | null, messageId?: string | null, basePath = "/app/chat"): string =>
  `${basePath}/c/${encodeURIComponent(chatId)}${messageId ? `/m/${encodeURIComponent(messageId)}` : ""}${panel === "info" ? "?panel=info" : ""}`;

export const parseRoute = (url: URL): Route | null => {
  const match = /^\/app\/chat(?:\/panel)?(?:\/c\/([^/]+)(?:\/m\/([^/]+))?)?\/?$/.exec(url.pathname);
  return match
    ? { chatId: match[1] ?? null, messageId: match[2] ?? null, panel: match[1] && url.searchParams.get("panel") === "info" ? "info" : null }
    : null;
};
