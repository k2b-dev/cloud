import type { WebReaderResult } from "@k2b/cloud/ai";
import { api } from "@k2b/cloud/browser";
import type { ApiType } from ".";

const assistantClient = api.create<ApiType>({ baseUrl: "/api/assistant" });

/**
 * Reads a web page of the chat for the person, as the reading view in a tab shows it. Kept apart from `assistantApi`, so
 * it loads with the tab and not with the chat's first frame.
 */
export const readWebPage = async (
  conversationId: string,
  body: { url: string; confirmed?: boolean },
  signal?: AbortSignal,
): Promise<WebReaderResult> => {
  const response = await assistantClient.workspace.conversations[":conversationId"]["web-reader"].$post(
    { param: { conversationId }, json: body },
    { init: { signal } },
  );
  if (!response.ok) throw new Error("Failed to read web page");
  return response.json();
};
