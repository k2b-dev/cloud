const BASE = "/pwa/assistant";

/** What an address of the Assistant part shows: its start, a new chat, or one chat. */
export type PwaAddress = { level: "start" } | { level: "new" } | { level: "chat"; id: string };

export const startHref = BASE;
export const newChatHref = `${BASE}/new`;
export const chatHref = (id: string): string => `${BASE}/c/${encodeURIComponent(id)}`;

export const addressHref = (address: PwaAddress): string =>
  address.level === "chat" ? chatHref(address.id) : address.level === "new" ? newChatHref : startHref;

/** The address a path names, or null outside the part. */
export const pwaAddress = (pathname: string): PwaAddress | null => {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === BASE) return { level: "start" };
  if (path === newChatHref) return { level: "new" };
  const match = /^\/pwa\/assistant\/c\/([^/]+)$/.exec(path);
  return match ? { level: "chat", id: decodeURIComponent(match[1]!) } : null;
};
