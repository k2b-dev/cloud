import { lazySync } from "../_internal/process-sync";
import { logger } from "../services/logging";
import { latestTopicCursor } from "../services/topic-cursor";
import {
  type AiStreamEvent,
  type AiTurnSnapshot,
  type AiWireEvent,
  isNewerWireEvent,
  reconcileResolvedTurnActions,
  steerAppliedBlockId,
  steerMessageBlockId,
} from "./protocol";
import { projectPublicAiStoredMessages, publicAiStoredMessages } from "./public-projection";
import { aiConversations } from "./store";
import type { AiConversation } from "./types";

const log = logger("ai:stream");

/**
 * Live fanout for wire events. Events carry their full payload so the SSE hot
 * path never touches Postgres; durable state lives in ai.messages plus the
 * throttled ai.turns.live_blocks snapshot.
 */
export const aiStreamTopic = lazySync((sync) =>
  sync.topic<AiWireEvent>({
    id: "cloud-ai-stream",
    owner: "cloud",
    retention: { maxAgeMs: 15 * 60 * 1000, maxBytes: 256 * 1024 * 1024 },
    maxPayloadBytes: 257 * 1024,
  }),
);

export type AiTurnControlEvent = { type: "abort"; conversationId: string; turnId: string };

export const aiTurnControlsTopic = lazySync((sync) =>
  sync.topic<AiTurnControlEvent>({
    id: "cloud-ai-turn-controls",
    owner: "cloud",
    // Abort signals are rare and tiny (5 KiB cap): 4 MiB keeps ~800 of them
    // across the 15-minute window.
    retention: { maxAgeMs: 15 * 60 * 1000, maxBytes: 4 * 1024 * 1024 },
    maxPayloadBytes: 5 * 1024,
  }),
);

export const publishAiWireEvent = async (event: AiWireEvent): Promise<void> => {
  await aiStreamTopic().publish({
    tenantId: event.conversationId,
    orderingKey: event.turnId,
    data: event,
    idempotencyKey: `wire:${event.turnId}:${event.attempt}:${event.seq}`,
  });
};

export const publishAiTurnAbort = async (input: { conversationId: string; turnId: string }): Promise<void> => {
  await aiTurnControlsTopic().publish({
    tenantId: input.conversationId,
    orderingKey: input.turnId,
    data: { type: "abort", conversationId: input.conversationId, turnId: input.turnId },
    idempotencyKey: `turn-abort:${input.turnId}`,
  });
};

const encoder = new TextEncoder();
const DEFAULT_HEARTBEAT_MS = 5_000;

export const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export const encodeSseEvent = (event: AiStreamEvent): Uint8Array =>
  encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

export const encodeSseHeartbeat = (): Uint8Array => encoder.encode(": heartbeat\n\n");

const turnSnapshotFromActive = (active: NonNullable<Awaited<ReturnType<typeof aiConversations.getActiveTurn>>>): AiTurnSnapshot => ({
  turnId: active.turn.shortId,
  attempt: active.turn.attempt,
  status: active.turn.status,
  seq: active.liveSeq,
  blocks: [...active.liveBlocks],
  modelProfileId: active.turn.modelProfileId,
  createdAt: active.turn.createdAt,
});

/** Initial history window; older messages load on demand while scrolling up. */
export const AI_STREAM_INITIAL_MESSAGE_LIMIT = 100;

export const loadAiStreamState = async (conversation: AiConversation): Promise<Extract<AiStreamEvent, { type: "state" }>> => {
  const [page, active] = await Promise.all([
    aiConversations.listMessagesPage({ conversationId: conversation.id, limit: AI_STREAM_INITIAL_MESSAGE_LIMIT }),
    aiConversations.getActiveTurn({ conversationId: conversation.id }),
  ]);
  const snapshot = active ? turnSnapshotFromActive(active) : null;
  if (snapshot) {
    const [steers, resolvedActions] = await Promise.all([
      aiConversations.listTurnSteers({ conversationId: conversation.id, turnId: active!.turn.id }),
      aiConversations.listResolvedPendingActions({ conversationId: conversation.id, turnId: active!.turn.id }),
    ]);
    snapshot.blocks = reconcileResolvedTurnActions(snapshot.blocks, resolvedActions);
    const known = new Set(snapshot.blocks.map((block) => block.id));
    for (const steer of steers) {
      if (steer.status === "discarded" || known.has(steerMessageBlockId(steer.id))) continue;
      snapshot.blocks.push({
        id: steerMessageBlockId(steer.id),
        kind: "steer_message",
        steerId: steer.id,
        text: steer.text,
        status: steer.status === "pending" ? "pending" : "consumed",
      });
      if (steer.status === "consumed" && !known.has(steerAppliedBlockId(steer.id))) {
        snapshot.blocks.push({ id: steerAppliedBlockId(steer.id), kind: "steer_applied", steerId: steer.id });
      }
    }
  }
  return {
    type: "state",
    conversation: { ...conversation, id: conversation.shortId },
    messages: await publicAiStoredMessages(page.messages, conversation),
    hasMoreMessages: page.hasMore,
    activeTurn: snapshot,
  };
};

type SnapshotTailItem<TSnapshot, TEvent> = { kind: "snapshot"; value: TSnapshot } | { kind: "event"; value: TEvent };

async function* streamSnapshotThenTail<TCursor, TSnapshot, TEvent>(input: {
  captureCursor: () => Promise<TCursor>;
  loadSnapshot: () => Promise<TSnapshot>;
  tail: (cursor: TCursor) => AsyncIterable<TEvent>;
}): AsyncGenerator<SnapshotTailItem<TSnapshot, TEvent>> {
  const cursor = await input.captureCursor();
  yield { kind: "snapshot", value: await input.loadSnapshot() };
  for await (const event of input.tail(cursor)) yield { kind: "event", value: event };
}

/**
 * Transport-neutral conversation stream: one `state` snapshot, then the live
 * tail. SSE and WebSocket adapters must both consume this feed.
 *
 * The topic cursor is grabbed before the snapshot is loaded, so every event
 * that races the snapshot is replayed from the tail and deduplicated via
 * (attempt, seq). Events of unknown turns are dropped until their
 * `turn_started` arrives, which makes stale retention entries harmless.
 * A memoized per-conversation hub preserves this snapshot race guarantee. While
 * a conversation has subscribers it costs one full-topic follower per process
 * (Sync filters tenants locally); the hub retires when the last subscriber
 * leaves. live() has no subscription-ready barrier.
 */
export async function* streamAiConversationEvents(input: {
  conversation: AiConversation;
  signal: AbortSignal;
}): AsyncGenerator<AiStreamEvent> {
  let current: { turnId: string; publicTurnId: string; attempt: number; seq: number } | null = null;
  for await (const item of streamSnapshotThenTail({
    captureCursor: () => latestTopicCursor({ topic: aiStreamTopic(), resourceId: "cloud-ai-stream", tenantId: input.conversation.id }),
    loadSnapshot: () => loadAiStreamState(input.conversation),
    tail: (after) => aiStreamTopic().hub({ tenantId: input.conversation.id }).subscribe({ after, signal: input.signal }),
  })) {
    if (item.kind === "snapshot") {
      const state = item.value;
      yield state;
      const activeTurn = state.activeTurn
        ? await aiConversations.getTurnByShortId({
            conversationId: input.conversation.id,
            shortId: state.activeTurn.turnId,
          })
        : null;
      current =
        state.activeTurn && activeTurn
          ? {
              turnId: activeTurn.id,
              publicTurnId: state.activeTurn.turnId,
              attempt: state.activeTurn.attempt,
              seq: state.activeTurn.seq,
            }
          : null;
      continue;
    }

    const received = item.value;
    const event = received.data;
    if (current?.turnId === event.turnId) {
      if (!isNewerWireEvent(event, current)) continue;
    } else if (event.type !== "turn_started") {
      continue;
    }
    const publicTurnId =
      current?.turnId === event.turnId
        ? current.publicTurnId
        : (await aiConversations.getTurn({ conversationId: input.conversation.id, turnId: event.turnId }))?.shortId;
    if (!publicTurnId) continue;
    current = { turnId: event.turnId, publicTurnId, attempt: event.attempt, seq: event.seq };
    if (event.type === "turn_finished") {
      const messages = await aiConversations
        .listTurnMessages({ conversationId: event.conversationId, loopId: event.turnId })
        .catch(() => []);
      yield {
        ...event,
        conversationId: input.conversation.shortId,
        turnId: publicTurnId,
        messages: projectPublicAiStoredMessages(messages, input.conversation.shortId, new Map([[event.turnId, publicTurnId]])),
      };
      continue;
    }

    yield { ...event, conversationId: input.conversation.shortId, turnId: publicTurnId };
  }
}

export const __aiStreamTest = { streamSnapshotThenTail };

/** Conversation-scoped SSE adapter for the shared event feed. */
export const createAiConversationStreamResponse = (input: {
  conversation: AiConversation;
  signal?: AbortSignal;
  heartbeatMs?: number;
  /**
   * Re-checked on every heartbeat. A stream can outlive the grant that opened
   * it by hours, and authorizing once at connect time means a withdrawn grant
   * keeps delivering model output until the client happens to disconnect.
   * Returning false closes the stream; the client's reconnect then meets the
   * ordinary 403.
   */
  revalidate?: () => Promise<boolean>;
}): Response => {
  const heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const liveAbort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const abortLive = () => liveAbort.abort();
  if (input.signal?.aborted) abortLive();
  else input.signal?.addEventListener("abort", abortLive, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          close();
          return false;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        input.signal?.removeEventListener("abort", abortLive);
        abortLive();
        try {
          controller.close();
        } catch {
          // The client may already have cancelled the stream.
        }
      };

      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (!enqueue(encodeSseHeartbeat())) return;
          if (!input.revalidate) return;
          // Fail closed: a revalidation that throws is not a pass.
          void input
            .revalidate()
            .catch((error) => {
              log.warn("AI conversation stream revalidation failed", {
                conversationId: input.conversation.id,
                error: error instanceof Error ? error.message : "revalidation failed",
              });
              return false;
            })
            .then((allowed) => {
              if (!allowed) close();
            });
        }, heartbeatMs);
      }

      try {
        for await (const event of streamAiConversationEvents({ conversation: input.conversation, signal: liveAbort.signal })) {
          if (!enqueue(encodeSseEvent(event))) return;
        }
      } catch (error) {
        if (!liveAbort.signal.aborted) {
          log.warn("AI conversation stream failed", {
            conversationId: input.conversation.id,
            error: error instanceof Error ? error.message : "AI conversation stream failed",
          });
        }
      } finally {
        close();
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      abortLive();
    },
  });

  return new Response(stream, { headers: sseHeaders });
};
