import { createApiClient } from "@k2b/cloud/browser";
import type { z } from "zod";
import type { ApiType } from "../api";
import {
  ConversationSchema,
  type ForResourceSchema,
  SystemChatPageSchema,
  type SystemChatParamSchema,
  ThreadListSchema,
  type ThreadQuerySchema,
  ThreadSchema,
  UNREAD_CAP,
} from "../service/contracts";

export type SystemChatPage = z.infer<typeof SystemChatPageSchema>;
export type ThreadQuery = z.input<typeof ThreadQuerySchema>;
export const containerIcon = (type: string | undefined) => (type === "notebooks.notebook" ? "ti ti-notebook" : "ti ti-layout-kanban");

const client = () => createApiClient<ApiType>({ baseUrl: "/api/chat" });
const response = async <T>(result: Pick<Response, "ok" | "status" | "json">, schema: z.ZodType<T>): Promise<T> => {
  if (!result.ok) throw new Error(`Chat request failed: ${result.status}`);
  return schema.parse(await result.json());
};

/** Each summary is bounded by the server's reader budget. Accumulate its cursor pages before displaying totals. */
export const completeSystemSummary = async (first: z.infer<typeof ConversationSchema>, signal: AbortSignal) => {
  let result = first;
  let cursor = first.summaryCursor;
  const seen = new Set<string>();
  while (cursor != null) {
    if (seen.has(cursor)) throw new Error("Repeated chat summary cursor");
    seen.add(cursor);
    const page = await response(
      await client().conversations[":conversation"].$get(
        { param: { conversation: first.id }, query: { summaryCursor: cursor } },
        { init: { signal } },
      ),
      ConversationSchema,
    );
    const newer = page.lastMessage && (!result.lastMessage || page.lastMessage.createdAt > result.lastMessage.createdAt);
    result = {
      ...result,
      threads: result.threads + page.threads,
      unread: Math.min(UNREAD_CAP, result.unread + page.unread),
      ...(newer ? { lastMessage: page.lastMessage, lastActivityAt: page.lastActivityAt } : {}),
      summaryCursor: page.summaryCursor,
    };
    cursor = page.summaryCursor;
  }
  return result;
};
export const loadSystemChats = async (query: { spacesCursor?: string; notebooksCursor?: string }, signal: AbortSignal) => {
  const page = await response(await client()["system-chats"].$get({ query }, { init: { signal } }), SystemChatPageSchema);
  // One request at a time keeps the server's reader budget effective even for a long sidebar.
  for (const item of page.items) if (item.conversation) item.conversation = await completeSystemSummary(item.conversation, signal);
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
