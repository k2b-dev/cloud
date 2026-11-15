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
/** The discussion already exists: the container's chat, or for an item its thread there. */
export const resourceChatExists = (chat: ResourceChat): chat is ResourceChat & { id: string } =>
  chat.id !== null && (!chat.item || chat.thread !== null);
/** The panel's address for the discussion: the chat or thread, or the ready start page while nobody has written. */
export const resourceChatPath = (chat: ResourceChat, basePath = "/app/chat/panel") =>
  resourceChatExists(chat)
    ? `${basePath}/c/${encodeURIComponent(chat.id)}${chat.thread ? `/t/${encodeURIComponent(chat.thread)}` : ""}`
    : `${basePath}/resource`;
