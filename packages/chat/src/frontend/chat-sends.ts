import { createApiClient } from "@k2b/cloud/browser";
import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { REQUEST_IDLE_TIMEOUT_MAX_SECONDS } from "@k2b/cloud/server/request-timeout.ts";
import type { z } from "zod";
import type { ApiType } from "../api";
import { type AttachmentView, AttachmentViewSchema, type Mention, MessageViewSchema, type SendMessageSchema } from "../service/contracts";

export type ChatSendReply = { id: string; author: string; text: string };
/** A quoted passage of the message `id`, shown until the stored message replaces the send. */
export type ChatSendQuote = { id: string; author: string; text: string };
export type ChatSendInput = z.input<typeof SendMessageSchema>;
/** A send the server answered with an error status. */
export class ChatSendError extends Error {
  constructor(readonly status: number) {
    super(`Chat request failed (${status})`);
  }
}
export type ChatSend = {
  clientId: string;
  conversationId: string;
  body: string;
  mentions: readonly Mention[];
  /** The thread the message goes to: a thread's ID, or "general". */
  thread: string;
  /** The answered message, shown as its quote until the stored message replaces the send. */
  replyTo: ChatSendReply | null;
  /** Quoted passages, in the order they were added. */
  quotes: readonly ChatSendQuote[];
  /** Shared Cloud elements, shown as cards from the first frame. */
  refs: readonly CloudResourceRef[];
  /** Uploaded images and documents, shown from the first frame; the message takes them when it is stored. */
  attachments: readonly AttachmentView[];
  createdAt: string;
  status: "pending" | "sent" | "failed";
  /** Shown as pending but not posted yet: its quotes are still on their way, so it and the later sends wait for `release`. */
  held?: boolean;
  /** The server refused its quotes for good: it stays failed without Try again and holds back no later send. */
  refused?: boolean;
  /** The stored message once the server accepted it. */
  message: z.infer<typeof MessageViewSchema> | null;
};
export const createChatSends = (dependencies: {
  post: (conversationId: string, input: ChatSendInput) => Promise<z.infer<typeof MessageViewSchema>>;
  /**
   * The server refused a send with quotes for good, such as because a quoted message was changed or deleted. The send
   * stays failed without Try again and the later ones go out; the application may give its text back and forget it.
   */
  onRejected?: (send: ChatSend) => void;
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
    const head = [...entries.values()].find(
      (entry) => entry.conversationId === conversationId && entry.status !== "sent" && !entry.refused,
    );
    if (head?.status !== "pending" || head.held) return;
    posting.add(conversationId);
    void post(head);
  };
  const post = async (entry: ChatSend) => {
    try {
      const message = await dependencies.post(entry.conversationId, {
        clientId: entry.clientId,
        body: entry.body,
        ...(entry.mentions.length
          ? { mentions: entry.mentions.map((mention) => ({ ...mention, principal: { ...mention.principal } })) }
          : {}),
        ...(entry.refs.length ? { refs: [...entry.refs] } : {}),
        ...(entry.attachments.length ? { attachments: entry.attachments.map((attachment) => attachment.id) } : {}),
        ...(entry.quotes.length ? { quotes: entry.quotes.map((quote) => ({ message: quote.id, text: quote.text })) } : {}),
        // A reply or a quote goes into its original's thread on the server; General needs no thread.
        ...(entry.replyTo
          ? { replyTo: entry.replyTo.id }
          : entry.quotes.length === 0 && entry.thread !== "general"
            ? { thread: entry.thread }
            : {}),
      });
      if (disposed || entries.get(entry.clientId) !== entry) return;
      entry.status = "sent";
      entry.message = message;
    } catch (error) {
      if (disposed || entries.get(entry.clientId) !== entry) return;
      // Trying again cannot help a send whose quotes the server refused; a busy or slow server stays retryable.
      const refused =
        error instanceof ChatSendError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      entry.status = "failed";
      if (refused && entry.quotes.length) {
        entry.refused = true;
        // After notify in finally: the application then sees it failed and may forget it.
        queueMicrotask(() => {
          if (!disposed && entries.get(entry.clientId) === entry) dependencies.onRejected?.(entry);
        });
      }
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
    send: (
      conversationId: string,
      body: string,
      target: {
        thread?: string;
        replyTo?: ChatSendReply | null;
        quotes?: readonly ChatSendQuote[];
        refs?: readonly CloudResourceRef[];
        attachments?: readonly AttachmentView[];
        mentions?: readonly Mention[];
        /** Show the send at once but post it only on `release`. */
        hold?: boolean;
      } = {},
    ): ChatSend => {
      const entry: ChatSend = {
        clientId: dependencies.newClientId?.() ?? crypto.randomUUID(),
        conversationId,
        body,
        mentions: (target.mentions ?? []).map((mention) => ({ ...mention, principal: { ...mention.principal } })),
        thread: target.thread ?? "general",
        replyTo: target.replyTo ?? null,
        quotes: target.quotes ?? [],
        refs: target.refs ?? [],
        attachments: target.attachments ?? [],
        createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
        status: "pending",
        ...(target.hold ? { held: true } : {}),
        message: null,
      };
      if (!disposed) {
        entries.set(entry.clientId, entry);
        notify();
        next(conversationId);
      }
      return entry;
    },
    /** Posts a held send with where it goes and what it quotes as known now. */
    release: (clientId: string, target: { thread: string; replyTo: ChatSendReply | null; quotes: readonly ChatSendQuote[] }) => {
      const entry = entries.get(clientId);
      if (disposed || !entry?.held) return;
      entry.held = false;
      entry.thread = target.thread;
      entry.replyTo = target.replyTo;
      entry.quotes = target.quotes;
      notify();
      next(entry.conversationId);
    },
    retry: (clientId: string) => {
      const entry = entries.get(clientId);
      if (disposed || !entry || entry.status !== "failed" || entry.refused) return;
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
    if (!response.ok) throw new ChatSendError(response.status);
    return MessageViewSchema.parse(await response.json());
  };
};

/** Uploads one file for the next message of a chat, into its open thread when it has one, and discards one removed. */
export const createAttachmentUpload = () => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  const discard = async (conversationId: string, attachmentId: string) => {
    await client.conversations[":conversation"].attachments[":attachment"].$delete({
      param: { conversation: conversationId, attachment: attachmentId },
    });
  };
  const upload = async (conversationId: string, thread: string | null, file: File, signal: AbortSignal): Promise<AttachmentView> => {
    const response = await client.conversations[":conversation"].attachments.$post(
      { param: { conversation: conversationId }, form: { file, ...(thread ? { thread } : {}) } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(`Chat upload failed (${response.status})`);
    return AttachmentViewSchema.parse(await response.json());
  };
  return { upload, discard };
};
