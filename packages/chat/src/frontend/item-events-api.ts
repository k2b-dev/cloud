import { createApiClient } from "@k2b/cloud/browser";
import type { z } from "zod";
import type { ApiType } from "../api";
import { chatMessages } from "../messages";
import { ItemEventsPageSchema, type ItemEventsQuerySchema } from "../service/contracts";
import { ChatRequestError } from "./chat-store";

export const createItemEventsApi = () => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  return {
    list: async (conversation: string, query: z.output<typeof ItemEventsQuerySchema>, signal?: AbortSignal) => {
      const response = await client.conversations[":conversation"].events.$get(
        { param: { conversation }, query: { ...query, limit: String(query.limit) } },
        { init: { signal } },
      );
      if (!response.ok)
        throw new ChatRequestError(chatMessages.resolve([document.documentElement.lang]).t.requestFailed, undefined, response.status);
      return ItemEventsPageSchema.parse(await response.json());
    },
  };
};
export type ItemEventsApi = ReturnType<typeof createItemEventsApi>;
