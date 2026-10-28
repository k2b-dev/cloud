import { createApiClient } from "@k2b/cloud/browser";
import { z } from "zod";
import type { ApiType } from "../api";
import { chatMessages } from "../messages";
import { ForYouPageSchema, MentionCandidatesSchema } from "../service/contracts";
import { ChatRequestError } from "./chat-store";

/** Typed transport shared by the For you page and composer; state stays with their existing owners. */
export const createForYouApi = () => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  const read = async <T>(response: Pick<Response, "status" | "ok" | "json">, schema: z.ZodType<T>): Promise<T> => {
    if (!response.ok) {
      const body = z.object({ message: z.string(), code: z.string().optional() }).safeParse(await response.json().catch(() => null));
      throw new ChatRequestError(
        body.success ? body.data.message : chatMessages.resolve([document.documentElement.lang]).t.requestFailed,
        body.success ? body.data.code : undefined,
        response.status,
      );
    }
    return schema.parse(await response.json());
  };
  return {
    list: async (cursor?: string, signal?: AbortSignal) =>
      read(await client["for-you"].$get({ query: { cursor } }, { init: { signal } }), ForYouPageSchema),
    candidates: async (conversation: string, q = "", thread = "general", signal?: AbortSignal) =>
      read(
        await client.conversations[":conversation"]["mention-candidates"].$get(
          {
            param: { conversation },
            query: { q, thread },
          },
          { init: { signal } },
        ),
        MentionCandidatesSchema,
      ),
  };
};
export type ForYouApi = ReturnType<typeof createForYouApi>;
