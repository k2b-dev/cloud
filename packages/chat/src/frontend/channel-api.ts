import { createApiClient } from "@k2b/cloud/browser";
import { z } from "zod";
import type { ApiType } from "../api";
import { chatMessages } from "../messages";
import {
  ConversationPageSchema,
  ConversationSchema,
  type DiscoveryEntriesSchema,
  DiscoveryOptionsSchema,
  DiscoveryPreviewSchema,
  DiscoveryStateSchema,
  type DiscoveryUpdateSchema,
} from "../service/contracts";
import { ChatRequestError } from "./chat-store";
export const createChannelApi = () => {
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
    options: async () => read(await client.channels.options.$get(), DiscoveryOptionsSchema),
    browse: async (q?: string, cursor?: string, signal?: AbortSignal) =>
      read(await client.channels.$get({ query: { q, cursor } }, { init: { signal } }), ConversationPageSchema),
    preview: async (entries: z.infer<typeof DiscoveryEntriesSchema>, conversation?: string) =>
      read(await client.channels.preview.$post({ query: { conversation }, json: entries }), DiscoveryPreviewSchema),
    get: async (id: string) =>
      read(await client.conversations[":conversation"].discovery.$get({ param: { conversation: id } }), DiscoveryStateSchema),
    update: async (id: string, input: z.infer<typeof DiscoveryUpdateSchema>) =>
      read(await client.conversations[":conversation"].discovery.$put({ param: { conversation: id }, json: input }), ConversationSchema),
    join: async (id: string) =>
      read(await client.conversations[":conversation"].join.$post({ param: { conversation: id } }), ConversationSchema),
  };
};
export type ChannelApi = ReturnType<typeof createChannelApi>;
