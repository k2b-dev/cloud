import { downloadFileFromContent } from "@k2b/stdlib/browser";
import { apiClient } from "../../api/client";
import { readApiError } from "./api-response";

export type KeptConversationRef = { mailboxId: string; conversationId: string };

/** The server names the file; a missing header still saves a JSON file. */
const filenameOf = (response: { headers: Headers }, fallback: string): string =>
  /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallback;

/**
 * Downloads the documented JSON export of kept conversations, one or a selection. The request goes through
 * `fetch` instead of a plain link, so a refusal or a broken connection ends in a visible error.
 */
export const downloadKeptConversations = async (refs: readonly KeptConversationRef[], fallbackError: string, signal?: AbortSignal) => {
  // Only the two IDs travel; callers may pass richer rows.
  const items = refs.map(({ mailboxId, conversationId }) => ({ mailboxId, conversationId }));
  const [single] = items;
  if (!single) return;
  const response =
    items.length === 1
      ? await apiClient.admin.kept[":mailboxId"][":conversationId"].export.$get({ param: single }, { init: { signal } })
      : await apiClient.admin.kept.export.$post({ json: { items } }, { init: { signal } });
  if (!response.ok) throw new Error(await readApiError(response, fallbackError));
  const blob = await response.blob();
  downloadFileFromContent(
    blob,
    filenameOf(response, items.length === 1 ? `kept-conversation-${single.conversationId}.json` : "kept-conversations.json"),
    "application/json",
  );
};
