import { createApiClient } from "@k2b/cloud/browser";
import type { z } from "zod";
import type { ApiType } from "../api";
import { MessageViewSchema } from "../service/contracts";

export type ChatSend = {
  clientId: string;
  conversationId: string;
  body: string;
  createdAt: string;
  status: "pending" | "sent" | "failed";
  /** The stored message once the server accepted it. */
  message: z.infer<typeof MessageViewSchema> | null;
};
export const createChatSends = (dependencies: {
  post: (conversationId: string, input: { clientId: string; body: string }) => Promise<z.infer<typeof MessageViewSchema>>;
  newClientId?: () => string;
  now?: () => Date;
}) => {
  const entries = new Map<string, ChatSend>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const post = async (entry: ChatSend) => {
    try {
      const message = await dependencies.post(entry.conversationId, { clientId: entry.clientId, body: entry.body });
      if (disposed || entries.get(entry.clientId) !== entry) return;
      entry.status = "sent";
      entry.message = message;
    } catch {
      if (disposed || entries.get(entry.clientId) !== entry) return;
      entry.status = "failed";
    }
    notify();
  };
  return {
    sends: (conversationId: string): readonly ChatSend[] =>
      [...entries.values()].filter((entry) => entry.conversationId === conversationId),
    send: (conversationId: string, body: string): ChatSend => {
      const entry: ChatSend = {
        clientId: dependencies.newClientId?.() ?? crypto.randomUUID(),
        conversationId,
        body,
        createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
        status: "pending",
        message: null,
      };
      if (!disposed) {
        entries.set(entry.clientId, entry);
        notify();
        void post(entry);
      }
      return entry;
    },
    retry: (clientId: string) => {
      const entry = entries.get(clientId);
      if (disposed || !entry || entry.status !== "failed") return;
      entry.status = "pending";
      notify();
      void post(entry);
    },
    forget: (clientId: string) => {
      if (!disposed && entries.delete(clientId)) notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
};

export const createChatSendsApi = () => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  return async (conversationId: string, input: { clientId: string; body: string }) => {
    const response = await client.conversations[":conversation"].messages.$post({ param: { conversation: conversationId }, json: input });
    if (!response.ok) throw new Error(`Chat request failed (${response.status})`);
    return MessageViewSchema.parse(await response.json());
  };
};
