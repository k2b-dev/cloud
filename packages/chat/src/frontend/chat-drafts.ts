/** Text drafts belong to one signed-in reader and chat in this browser tab, including its panel iframe. */
export const chatDrafts = (viewerId: string, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) => {
  const key = (conversationId: string) => `cloud.chat.draft:${viewerId}:${conversationId}`;
  const selectionKey = `cloud.chat.panel:${viewerId}`;
  return {
    selection: (): string | null => {
      const id = storage.getItem(selectionKey);
      return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
    },
    select: (id: string | null): void => {
      if (id) storage.setItem(selectionKey, id);
      else storage.removeItem(selectionKey);
    },
    read: (conversationId: string): string => storage.getItem(key(conversationId)) ?? "",
    write: (conversationId: string, text: string): void => {
      if (text) storage.setItem(key(conversationId), text);
      else storage.removeItem(key(conversationId));
    },
  };
};
