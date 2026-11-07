import { createApiClient } from "@k2b/cloud/browser";
import { z } from "zod";
import type { ApiType } from "../api";
import { chatMessages } from "../messages";
import { SearchQuerySchema, SearchResultSchema } from "../service/search-contracts";
import { ChatRequestError } from "./chat-store";

export type { SearchHit, SearchResult } from "../service/search-contracts";
export const createSearchApi = () => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  return {
    search: async (q: string, signal?: AbortSignal) => {
      const response = await client.search.$get({ query: SearchQuerySchema.parse({ q }) }, { init: { signal } });
      if (!response.ok) {
        const body = z.object({ message: z.string(), code: z.string().optional() }).safeParse(await response.json().catch(() => null));
        throw new ChatRequestError(
          body.success ? body.data.message : chatMessages.resolve([document.documentElement.lang]).t.requestFailed,
          body.success ? body.data.code : undefined,
          response.status,
        );
      }
      return SearchResultSchema.parse(await response.json());
    },
  };
};
export type SearchApi = ReturnType<typeof createSearchApi>;
