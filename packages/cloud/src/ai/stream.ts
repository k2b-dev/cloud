import { PayloadTooLargeError } from "@k2b/sync";
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
 * Bytes an SSE reader may leave unread before its stream ends, the live
 * socket's send-buffer limit. The check runs before each event, so the queue
 * can exceed it by the event that crosses it, and a state snapshot or a
 * finished turn with its messages can be larger than one live event. The
 * reconnect starts from a fresh state snapshot, so ending the stream loses
 * nothing durable.
 */
const AI_STREAM_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Interval at which a turn worker saves its live state (ai.turns.live_blocks).
 * The saved state lags the live stream by at most one interval.
 */
export const AI_LIVE_SNAPSHOT_INTERVAL_MS = 1_000;

/**
 * Reads of the saved live state a stream makes while it waits for an event it
 * could not pass on live, one interval apart. The worker saves within one
 * interval; the rest covers a slow database before the stream continues with
 * the state it has.
 */
const AI_STREAM_CATCH_UP_READS = 5;

/**
 * Raw topic events: the wire protocol, plus the marker a publisher sends in
 * place of an event that exceeds the topic's payload limit. Streams never pass
 * the marker on; they send the turn's saved state instead, which holds the
 * event in full.
 */
export type AiLiveTopicEvent =
  | AiWireEvent
  | (Pick<AiWireEvent, "v" | "conversationId" | "turnId" | "attempt" | "seq"> & { type: "oversized"; replaces: AiWireEvent["type"] });

/**
 * Live fanout for wire events. Events carry their full payload so the SSE hot
 * path never touches Postgres; durable state lives in ai.messages plus the
 * throttled ai.turns.live_blocks snapshot.
 */
export const aiStreamTopic = lazySync((sync) =>
  sync.topic<AiLiveTopicEvent>({
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

const publishLiveTopicEvent = async (event: AiLiveTopicEvent): Promise<void> => {
  await aiStreamTopic().publish({
    tenantId: event.conversationId,
    orderingKey: event.turnId,
    data: event,
    // A turn ends once. A stop or the sweep numbers the end from the saved state, which can lag the live events, so
    // its position may repeat one of theirs and must not count as a duplicate of it.
    idempotencyKey: event.type === "turn_finished" ? `wire:${event.turnId}:finished` : `wire:${event.turnId}:${event.attempt}:${event.seq}`,
  });
};

/**
 * Publish a wire event. An event over the topic's payload limit, such as a
 * tool block with a large result, goes out as an `oversized` marker with the
 * same position; streams then send the saved state, which holds it in full.
 */
export const publishAiWireEvent = async (event: AiWireEvent): Promise<void> => {
  try {
    await publishLiveTopicEvent(event);
  } catch (error) {
    if (!(error instanceof PayloadTooLargeError)) throw error;
    const { v, conversationId, turnId, attempt, seq } = event;
    await publishLiveTopicEvent({ v, conversationId, turnId, attempt, seq, type: "oversized", replaces: event.type });
  }
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
  actionWaitMs: active.actionWaitMs,
  waitingSince: active.waitingSince,
});

/** Initial history window; older messages load on demand while scrolling up. */
export const AI_STREAM_INITIAL_MESSAGE_LIMIT = 100;

type AiStreamSnapshot = {
  state: Extract<AiStreamEvent, { type: "state" }>;
  /** Internal id of the active turn in `state`. */
  activeTurnId: string | null;
};

export const loadAiStreamState = async (conversation: AiConversation): Promise<Extract<AiStreamEvent, { type: "state" }>> =>
  (await loadStreamSnapshot(conversation)).state;

const loadStreamSnapshot = async (conversation: AiConversation): Promise<AiStreamSnapshot> => {
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
    state: {
      type: "state",
      conversation: { ...conversation, id: conversation.shortId },
      messages: await publicAiStoredMessages(page.messages, conversation),
      hasMoreMessages: page.hasMore,
      activeTurn: snapshot,
    },
    activeTurnId: snapshot ? active!.turn.id : null,
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

/** Position of the turn a stream follows: internal id, public id, and the newest event it passed on. */
type StreamPosition = { turnId: string; publicTurnId: string; attempt: number; seq: number; finished: boolean };

const positionOf = (snapshot: AiStreamSnapshot): StreamPosition | null => {
  const active = snapshot.state.activeTurn;
  if (!active || !snapshot.activeTurnId) return null;
  return { turnId: snapshot.activeTurnId, publicTurnId: active.turnId, attempt: active.attempt, seq: active.seq, finished: false };
};

/**
 * Whether the stream has to send the saved state before `event`: the event
 * was too large for the live topic, events of the turn went missing, or the
 * turn's start or the previous turn's end did not arrive. Each attempt numbers
 * its events without holes, starts with `turn_started`, and a turn ends with
 * `turn_finished` before the next one starts.
 */
const needsSavedState = (event: AiLiveTopicEvent, current: StreamPosition | null, reloadedTurns: ReadonlySet<string>): boolean => {
  if (current?.turnId === event.turnId) {
    if (current.finished || event.type === "turn_finished" || !isNewerWireEvent(event, current)) return false;
    if (event.type === "oversized") return true;
    if (event.type === "turn_started") return false;
    return event.attempt > current.attempt || event.seq > current.seq + 1;
  }
  if (event.type === "turn_started") return Boolean(current && !current.finished);
  return !reloadedTurns.has(event.turnId);
};

/** Whether a saved state at `saved` already holds `event`: its turn ended, another turn runs, or the state reached it. */
const holdsEvent = (saved: { turnId: string; attempt: number; seq: number } | null, event: AiLiveTopicEvent): boolean =>
  !saved || saved.turnId !== event.turnId || !isNewerWireEvent(event, saved);

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * The saved state once it holds `event`, or the newest one after a bounded wait. The stream may have opened long
 * ago, so the conversation is read again: its draft and run status have moved on since. Null once the conversation
 * is archived or deleted.
 */
const loadStreamSnapshotWith = async (
  conversation: AiConversation,
  event: AiLiveTopicEvent,
  signal: AbortSignal,
): Promise<AiStreamSnapshot | null> => {
  for (let read = 1; read < AI_STREAM_CATCH_UP_READS && !signal.aborted; read++) {
    const active = await aiConversations.getActiveTurn({ conversationId: conversation.id });
    if (holdsEvent(active && { turnId: active.turn.id, attempt: active.turn.attempt, seq: active.liveSeq }, event)) break;
    await pause(AI_LIVE_SNAPSHOT_INTERVAL_MS, signal);
  }
  const current = await aiConversations.getConversation({ conversationId: conversation.id });
  if (!current) return null;
  const snapshot = await loadStreamSnapshot(current);
  if (!signal.aborted && !holdsEvent(positionOf(snapshot), event)) {
    // Readers miss this turn's events up to the event until it ends.
    log.warn("AI conversation stream continues without an event the saved state does not hold", {
      conversationId: conversation.id,
      turnId: event.turnId,
      attempt: event.attempt,
      seq: event.seq,
    });
  }
  return snapshot;
};

/**
 * Transport-neutral conversation stream: one `state` snapshot, then the live
 * tail. SSE and WebSocket adapters must both consume this feed.
 *
 * The topic cursor is grabbed before the snapshot is loaded, so every event
 * that races the snapshot is replayed from the tail and deduplicated via
 * (attempt, seq). The saved snapshot can lag the live stream by one save
 * interval, and a live event can be too large for the topic or get lost. The
 * feed therefore checks that each turn's events follow without holes. When
 * one is missing, it sends a fresh `state` once the saved state holds the
 * event, and continues after it, so readers never see a hole. A memoized
 * per-conversation hub preserves this snapshot race guarantee. While a
 * conversation has subscribers it costs one full-topic follower per process
 * (Sync filters tenants locally); the hub retires when the last subscriber
 * leaves. live() has no subscription-ready barrier.
 */
export async function* streamAiConversationEvents(input: {
  conversation: AiConversation;
  signal: AbortSignal;
}): AsyncGenerator<AiStreamEvent> {
  let current: StreamPosition | null = null;
  // Turns the stream reloaded the state for, once each; later events of one the state does not show are stale.
  const reloadedTurns = new Set<string>();
  for await (const item of streamSnapshotThenTail({
    captureCursor: () => latestTopicCursor({ topic: aiStreamTopic(), resourceId: "cloud-ai-stream", tenantId: input.conversation.id }),
    loadSnapshot: () => loadStreamSnapshot(input.conversation),
    tail: (after) => aiStreamTopic().hub({ tenantId: input.conversation.id }).subscribe({ after, signal: input.signal }),
  })) {
    if (item.kind === "snapshot") {
      yield item.value.state;
      current = positionOf(item.value);
      continue;
    }

    const event = item.value.data;
    if (needsSavedState(event, current, reloadedTurns)) {
      reloadedTurns.add(event.turnId);
      const snapshot = await loadStreamSnapshotWith(input.conversation, event, input.signal);
      // A conversation that was archived or deleted ends the stream; the reader's reconnect gets the route's answer.
      if (input.signal.aborted || !snapshot) return;
      yield snapshot.state;
      current = positionOf(snapshot);
    }

    if (current?.turnId === event.turnId) {
      if (current.finished) continue;
      // A turn ends once; the sweep and a stop number its end from the saved state, which can lag the live events.
      if (event.type !== "turn_finished" && !isNewerWireEvent(event, current)) continue;
    } else if (reloadedTurns.has(event.turnId)) {
      // The stream reloaded the state for this turn, and the newest state does not show it: the turn has ended, and that
      // state holds its outcome, so nothing of it is replayed. Its end still goes out while no other turn runs, so a
      // reader that waits for it sees the turn end.
      if (event.type !== "turn_finished" || current) continue;
    } else if (event.type !== "turn_started") {
      continue;
    }
    const publicTurnId =
      current?.turnId === event.turnId
        ? current.publicTurnId
        : (await aiConversations.getTurn({ conversationId: input.conversation.id, turnId: event.turnId }))?.shortId;
    if (!publicTurnId) continue;
    // A turn end numbered behind the passed events leaves the position where it was.
    const position = current?.turnId === event.turnId && !isNewerWireEvent(event, current) ? current : event;
    current = {
      turnId: event.turnId,
      publicTurnId,
      attempt: position.attempt,
      seq: position.seq,
      finished: event.type === "turn_finished",
    };
    // The saved state sent above holds what the marker replaced. Should the wait have run out, the stream still
    // continues after this position instead of waiting for the same event again.
    if (event.type === "oversized") continue;
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

    if (event.type === "message_saved") {
      const [message] = projectPublicAiStoredMessages([event.message], input.conversation.shortId, new Map([[event.turnId, publicTurnId]]));
      if (message) yield { ...event, conversationId: input.conversation.shortId, turnId: publicTurnId, message };
      continue;
    }
    yield { ...event, conversationId: input.conversation.shortId, turnId: publicTurnId };
  }
}

export const __aiStreamTest = { needsSavedState, streamSnapshotThenTail };

/** Conversation-scoped SSE adapter for the shared event feed. */
export const createAiConversationStreamResponse = (input: {
  conversation: AiConversation;
  signal?: AbortSignal;
  heartbeatMs?: number;
  /**
   * Re-checked on every heartbeat. A stream can outlive the credential and the
   * grant that opened it by hours, and authorizing once at connect time means
   * a revoked session or withdrawn grant keeps delivering model output until
   * the client happens to disconnect. Returning false closes the stream; the
   * client's reconnect then meets the ordinary 401, 403, or 404.
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

  const stream = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const enqueue = (chunk: Uint8Array): boolean => {
          if (closed) return false;
          // desiredSize is the budget left after what the reader has not taken
          // yet. A reader that falls this far behind gets a fresh snapshot on
          // reconnect instead of an ever-growing queue on the server.
          if ((controller.desiredSize ?? 0) <= 0) {
            log.warn("AI conversation stream closed: the reader fell behind", {
              conversationId: input.conversation.id,
              maxBufferedBytes: AI_STREAM_MAX_BUFFERED_BYTES,
            });
            close();
            return false;
          }
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
    },
    new ByteLengthQueuingStrategy({ highWaterMark: AI_STREAM_MAX_BUFFERED_BYTES }),
  );

  return new Response(stream, { headers: sseHeaders });
};
