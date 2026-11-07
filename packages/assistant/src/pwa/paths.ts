const BASE = "/pwa/assistant";

/**
 * What an address of the Assistant part shows: its start, every chat or the archive with an optional search, a new
 * chat, or one chat.
 */
export type PwaAddress =
  | { level: "start" }
  | { level: "all"; archived: boolean; query: string }
  | { level: "new" }
  | { level: "chat"; id: string };

export const startHref = BASE;
export const newChatHref = `${BASE}/new`;
export const allChatsHref = `${BASE}/chats`;
export const archiveHref = `${BASE}/archive`;
export const chatHref = (id: string): string => `${BASE}/c/${encodeURIComponent(id)}`;

export const addressHref = (address: PwaAddress): string => {
  if (address.level === "chat") return chatHref(address.id);
  if (address.level === "new") return newChatHref;
  if (address.level === "all") {
    const base = address.archived ? archiveHref : allChatsHref;
    return address.query ? `${base}?q=${encodeURIComponent(address.query)}` : base;
  }
  return startHref;
};

/** The address a URL names, or null outside the part. */
export const pwaAddress = (url: URL): PwaAddress | null => {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === BASE) return { level: "start" };
  if (path === newChatHref) return { level: "new" };
  if (path === allChatsHref || path === archiveHref)
    return { level: "all", archived: path === archiveHref, query: (url.searchParams.get("q") ?? "").trim().slice(0, 200) };
  const match = /^\/pwa\/assistant\/c\/([^/]+)$/.exec(path);
  return match ? { level: "chat", id: decodeURIComponent(match[1]!) } : null;
};
