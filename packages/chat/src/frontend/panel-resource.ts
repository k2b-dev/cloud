import { readPanelContext } from "@k2b/cloud/ssr";

/**
 * The discussion about the host page's resource: `id` and `thread` stay null until someone writes there; `item` says
 * whether the resource is an item, whose discussion is its thread in its container's chat.
 */
export type ResourceChat = {
  ref: { type: string; id: string };
  title: string;
  id: string | null;
  thread: string | null;
  item: boolean;
  canWrite: boolean;
};
type Request = { req: { path: string; raw: { url: string } } };

/** The discussion already exists: the container's chat, or for an item its thread there. */
export const resourceChatExists = (chat: ResourceChat): chat is ResourceChat & { id: string } =>
  chat.id !== null && (!chat.item || chat.thread !== null);
/** The panel's address for the discussion: the chat or thread, or the ready start page while nobody has written. */
export const resourceChatPath = (chat: ResourceChat, basePath = "/app/chat/panel") =>
  resourceChatExists(chat)
    ? `${basePath}/c/${encodeURIComponent(chat.id)}${chat.thread ? `/t/${encodeURIComponent(chat.thread)}` : ""}`
    : `${basePath}/resource`;

/**
 * The panel starts in the discussion about the host page's resource. The shared scope is an untrusted selector:
 * `locate` reads it as the signed-in reader, creates nothing, and answers null where the reader may not read it, so
 * the panel stays at the chat list. The panel's start, and the start page once its discussion exists, move to the
 * discussion, keeping the shared context; the start page without one returns to the list.
 */
export async function panelResourceChat(
  c: Request,
  locate: (ref: ResourceChat["ref"]) => Promise<Omit<ResourceChat, "ref"> | null>,
): Promise<{ resourceChat: ResourceChat | null; redirect: string | null; scope: ResourceChat["ref"] | null }> {
  const scope = readPanelContext(c)?.scope ?? null;
  const found = scope ? await locate(scope).catch(() => null) : null;
  const resourceChat = scope && found ? { ...found, ref: scope } : null;
  const search = new URL(c.req.raw.url).search;
  const start = /^\/app\/chat\/panel\/?$/.test(c.req.path);
  const startPage = /^\/app\/chat\/panel\/resource\/?$/.test(c.req.path);
  let redirect: string | null = null;
  if (resourceChat && (start || (startPage && resourceChatExists(resourceChat)))) redirect = `${resourceChatPath(resourceChat)}${search}`;
  else if (startPage && !resourceChat) redirect = "/app/chat/panel";
  return { resourceChat, redirect, scope };
}
