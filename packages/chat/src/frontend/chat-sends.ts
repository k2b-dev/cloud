import { createApiClient } from "@k2b/cloud/browser";
import { REQUEST_IDLE_TIMEOUT_MAX_SECONDS } from "@k2b/cloud/server/request-timeout.ts";
import type { z } from "zod";
import type { ApiType } from "../api";
import { MessageViewSchema } from "../service/contracts";

export type ChatSendReply = { id: string; author: string; text: string };
export type ChatSendInput = { clientId: string; body: string; thread?: string; replyTo?: string };
export type ChatSend = {
  clientId: string;
  conversationId: string;
  body: string;
  /** The thread the message goes to: a thread's ID, or "general". */
  thread: string;
  /** The answered message, shown as its quote until the stored message replaces the send. */
  replyTo: ChatSendReply | null;
  createdAt: string;
  status: "pending" | "sent" | "failed";
  /** The stored message once the server accepted it. */
  message: z.infer<typeof MessageViewSchema> | null;
};
export const createChatSends = (dependencies: {
  post: (conversationId: string, input: ChatSendInput) => Promise<z.infer<typeof MessageViewSchema>>;
  newClientId?: () => string;
  now?: () => Date;
}) => {
  const entries = new Map<string, ChatSend>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  // The server orders messages by arrival, so each conversation posts one send at a time in the order typed.
  // A failed send holds back the later ones until it is retried or forgotten.
  const posting = new Set<string>();
  const next = (conversationId: string) => {
    if (disposed || posting.has(conversationId)) return;
    const head = [...entries.values()].find((entry) => entry.conversationId === conversationId && entry.status !== "sent");
    if (head?.status !== "pending") return;
    posting.add(conversationId);
    void post(head);
  };
  const post = async (entry: ChatSend) => {
    try {
      const message = await dependencies.post(entry.conversationId, {
        clientId: entry.clientId,
        body: entry.body,
        // A reply goes into its original's thread on the server; General needs no thread.
        ...(entry.replyTo ? { replyTo: entry.replyTo.id } : entry.thread !== "general" ? { thread: entry.thread } : {}),
      });
      if (disposed || entries.get(entry.clientId) !== entry) return;
      entry.status = "sent";
      entry.message = message;
    } catch {
      if (disposed || entries.get(entry.clientId) !== entry) return;
      entry.status = "failed";
    } finally {
      posting.delete(entry.conversationId);
      if (!disposed && entries.get(entry.clientId) === entry) notify();
      next(entry.conversationId);
    }
  };
  return {
    // True while a send of any conversation is not sent yet, so leaving the page would lose it.
    unsent: (): boolean => [...entries.values()].some((entry) => entry.status !== "sent"),
    sends: (conversationId: string): readonly ChatSend[] =>
      [...entries.values()].filter((entry) => entry.conversationId === conversationId),
    send: (conversationId: string, body: string, target: { thread?: string; replyTo?: ChatSendReply | null } = {}): ChatSend => {
      const entry: ChatSend = {
        clientId: dependencies.newClientId?.() ?? crypto.randomUUID(),
        conversationId,
        body,
        thread: target.thread ?? "general",
        replyTo: target.replyTo ?? null,
        createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
        status: "pending",
        message: null,
      };
      if (!disposed) {
        entries.set(entry.clientId, entry);
        notify();
        next(conversationId);
      }
      return entry;
    },
    retry: (clientId: string) => {
      const entry = entries.get(clientId);
      if (disposed || !entry || entry.status !== "failed") return;
      entry.status = "pending";
      notify();
      next(entry.conversationId);
    },
    forget: (clientId: string) => {
      const entry = entries.get(clientId);
      if (disposed || !entry) return;
      entries.delete(clientId);
      notify();
      next(entry.conversationId);
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
  return async (conversationId: string, input: ChatSendInput) => {
    // The gateway gives up on an app answer after this long, so a request still open then never gets one. Ending it
    // marks the send failed, so it can be retried and the later sends of its chat are not held back forever.
    const signal = AbortSignal.timeout(REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000);
    const response = await client.conversations[":conversation"].messages.$post(
      { param: { conversation: conversationId }, json: input },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(`Chat request failed (${response.status})`);
    return MessageViewSchema.parse(await response.json());
  };
};
