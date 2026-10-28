import { createApiClient } from "@k2b/cloud/browser";
import type { z } from "zod";
import type { ApiType } from "../api";
import type { chatMessages } from "../messages";
import {
  ConversationSchema,
  type ForResourceSchema,
  SystemChatPageSchema,
  type SystemChatParamSchema,
  ThreadListSchema,
  type ThreadQuerySchema,
  ThreadSchema,
} from "../service/contracts";

export type SystemChatPage = z.infer<typeof SystemChatPageSchema>;
export type ThreadQuery = z.input<typeof ThreadQuerySchema>;
export const containerIcon = (type: string | undefined) => (type === "notebooks.notebook" ? "ti ti-notebook" : "ti ti-layout-kanban");

export const systemMembers = (type: string | undefined, t: ReturnType<typeof chatMessages.resolve>["t"]) =>
  type === "notebooks.notebook" ? t.systemNotebookMembers : t.systemSpaceMembers;

const client = () => createApiClient<ApiType>({ baseUrl: "/api/chat" });
const response = async <T>(result: Pick<Response, "ok" | "status" | "json">, schema: z.ZodType<T>): Promise<T> => {
  if (!result.ok) throw new Error(`Chat request failed: ${result.status}`);
  return schema.parse(await result.json());
};

export const loadSystemChats = async (query: { spacesCursor?: string; notebooksCursor?: string }, signal: AbortSignal) => {
  const page = await response(await client()["system-chats"].$get({ query }, { init: { signal } }), SystemChatPageSchema);
  return page;
};
export const openSystemChat = async (param: z.infer<typeof SystemChatParamSchema>) =>
  response(await client()["system-chats"][":resourceType"][":resourceId"].open.$post({ param }), ConversationSchema);
export const loadSystemThreads = async (id: string, query: ThreadQuery, signal: AbortSignal) =>
  response(
    await client().conversations[":conversation"].threads.$get({ param: { conversation: id }, query }, { init: { signal } }),
    ThreadListSchema,
  );
export const openResourceThread = async (id: string, input: z.infer<typeof ForResourceSchema>) =>
  response(
    await client().conversations[":conversation"].threads["for-resource"].$post({ param: { conversation: id }, json: input }),
    ThreadSchema,
  );
