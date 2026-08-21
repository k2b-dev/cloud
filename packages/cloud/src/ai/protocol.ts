import type { CompactResult, InboundEvent, Message } from "@k2b/nessi";
import type { CapabilityActionReview } from "../contracts/capabilities";
import type { AiConversation, AiFrontendToolMode, AiStoredMessage, AiToolPresentation, AiTurnStatus } from "./types";

/**
 * Cloud AI wire protocol.
 *
 * The versioned, Cloud-owned contract between the turn executor, the live
 * fanout topic, the SSE stream, and the client projection. Nessi events are
 * translated into this protocol at the runtime boundary and never leave it.
 *
 * Ordering: every event carries (attempt, seq). The lease owner of a turn is
 * the single writer and allocates seq in-process; attempt increments on every
 * claim, so events of a re-claimed turn always supersede older ones. Each
 * attempt starts with `turn_started`, whose ordered `blocks` snapshot makes
 * the transition atomic. A full `block_set` prefix follows for compatibility
 * with older clients and idempotent replay.
 */

export const AI_WIRE_VERSION = 1;

export type AiToolBlockStatus = "running" | "awaiting_approval" | "awaiting_client" | "completed" | "failed" | "rejected";

export type AiTurnBlock =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "steer_message"; steerId: string; text: string; status: "pending" | "consumed" | "failed" }
  | { id: string; kind: "steer_applied"; steerId: string }
  | {
      id: string;
      kind: "tool";
      callId: string;
      name: string;
      args?: unknown;
      status: AiToolBlockStatus;
      result?: unknown;
      isError?: boolean;
      /** Present while status is awaiting_approval. */
      approval?: { message?: string; review?: CapabilityActionReview; allowAlways: boolean };
      /** Present for frontend tools. */
      frontendMode?: AiFrontendToolMode;
      /** Saved Cloud-owned display snapshot for capability calls. */
      presentation?: AiToolPresentation;
    }
  | { id: string; kind: "compaction"; status: "running" | "completed" | "skipped" | "failed"; result?: CompactResult };

type AiWireEventBase = {
  v: typeof AI_WIRE_VERSION;
  conversationId: string;
  turnId: string;
  attempt: number;
  seq: number;
};

export type AiTurnFinishedStatus = "completed" | "failed" | "aborted";

export type AiWireEvent =
  | (AiWireEventBase & {
      type: "turn_started";
      modelProfileId: string;
      providerModel: string;
      /** Authoritative ordered baseline for this attempt. Optional for older senders. */
      blocks?: AiTurnBlock[];
    })
  | (AiWireEventBase & { type: "block_set"; block: AiTurnBlock })
  | (AiWireEventBase & { type: "block_delta"; blockId: string; blockKind: "text" | "thinking"; delta: string })
  | (AiWireEventBase & {
      type: "turn_finished";
      status: AiTurnFinishedStatus;
      error: string | null;
      /** Messages persisted by this turn. Attached by the SSE layer; absent on the raw topic. */
      messages?: AiStoredMessage[];
    });

/** Snapshot of the active turn, sent in `state` events and kept in ai.turns.live_blocks. */
export type AiTurnSnapshot = {
  turnId: string;
  attempt: number;
  status: AiTurnStatus;
  /** Last wire seq reflected in `blocks` (attempt-scoped). */
  seq: number;
  blocks: AiTurnBlock[];
  modelProfileId: string | null;
  createdAt: string;
};

/** Full projection seed sent as the first SSE event on every (re)connect. */
export type AiStreamState = {
  type: "state";
  conversation: AiConversation;
  /** Newest window of the history — older messages load on demand while scrolling up. */
  messages: AiStoredMessage[];
  /** Whether messages older than this window exist. */
  hasMoreMessages?: boolean;
  activeTurn: AiTurnSnapshot | null;
};

export type AiStreamSseEvent = AiStreamState | AiWireEvent;

export const isNewerWireEvent = (event: { attempt: number; seq: number }, current: { attempt: number; seq: number }): boolean =>
  event.attempt > current.attempt || (event.attempt === current.attempt && event.seq > current.seq);

/**
 * Apply a wire event to a block list. Pure and total — unknown ids create
 * blocks, unknown event types are ignored. Shared by the executor (authoritative
 * state for snapshots) and the client projection so both converge on identical
 * block lists for identical event streams.
 */
export const applyWireEventToBlocks = (blocks: AiTurnBlock[], event: AiWireEvent): AiTurnBlock[] => {
  if (event.type === "block_set") {
    const index = blocks.findIndex((block) => block.id === event.block.id);
    if (index < 0) return [...blocks, event.block];
    return [...blocks.slice(0, index), event.block, ...blocks.slice(index + 1)];
  }

  if (event.type === "block_delta") {
    const index = blocks.findIndex((block) => block.id === event.blockId);
    if (index < 0) {
      return [...blocks, { id: event.blockId, kind: event.blockKind, text: event.delta }];
    }
    const existing = blocks[index]!;
    if (existing.kind !== "text" && existing.kind !== "thinking") return blocks;
    return [...blocks.slice(0, index), { ...existing, text: existing.text + event.delta }, ...blocks.slice(index + 1)];
  }

  return blocks;
};

/**
 * Reconcile a durable action response with a possibly stale live snapshot.
 *
 * Action responses and live block snapshots are persisted separately. A
 * reconnect can therefore observe the response before the resumed worker has
 * replaced the awaiting block. Only awaiting blocks are changed so historical
 * completed calls remain authoritative.
 */
export const reconcileResolvedTurnActions = (
  blocks: AiTurnBlock[],
  actions: readonly { callId: string; resolvedEvent: InboundEvent | null }[],
): AiTurnBlock[] => {
  const resolvedByCallId = new Map(actions.map((action) => [action.callId, action.resolvedEvent]));
  return blocks.map((block) => {
    if (block.kind !== "tool" || (block.status !== "awaiting_approval" && block.status !== "awaiting_client")) return block;
    const event = resolvedByCallId.get(block.callId);
    if (!event || event.callId !== block.callId) return block;
    if (block.status === "awaiting_approval" && event.type === "approval_response") {
      return { ...block, status: event.approved ? "running" : "rejected", approval: undefined };
    }
    if (block.status === "awaiting_client" && event.type === "tool_result") {
      return { ...block, status: "completed", result: event.result, isError: false };
    }
    return block;
  });
};

/**
 * Convert persisted loop messages into the block model. Shared by the executor
 * (baseline rebuild on claim) and the client (rendering finished turns), so a
 * live turn and its persisted form render through exactly the same block list.
 */
export const buildBlocksFromMessages = (
  messages: {
    seq: number;
    message: Message;
    meta?: {
      steerId?: string;
      toolPresentations?: Record<string, AiToolPresentation>;
      toolOutcomes?: Record<string, "rejected">;
    } | null;
  }[],
): AiTurnBlock[] => {
  const blocks: AiTurnBlock[] = [];
  const toolIndex = new Map<string, number>();

  for (const { seq, message, meta } of messages) {
    if (message.role === "assistant") {
      message.content.forEach((block, index) => {
        if (block.type === "text") {
          if (block.text.trim().length > 0) blocks.push({ id: messageBlockId(seq, index), kind: "text", text: block.text });
        } else if (block.type === "thinking") {
          blocks.push({ id: messageBlockId(seq, index), kind: "thinking", text: block.thinking });
        } else if (block.type === "tool_call") {
          toolIndex.set(block.id, blocks.length);
          blocks.push({
            id: toolBlockId(block.id),
            kind: "tool",
            callId: block.id,
            name: block.name,
            args: block.args,
            status: "running",
            presentation: meta?.toolPresentations?.[block.id],
          });
        }
      });
    } else if (message.role === "user" && meta?.steerId) {
      blocks.push({
        id: steerMessageBlockId(meta.steerId),
        kind: "steer_message",
        steerId: meta.steerId,
        text: userMessageText(message),
        status: "consumed",
      });
      blocks.push({ id: steerAppliedBlockId(meta.steerId), kind: "steer_applied", steerId: meta.steerId });
    } else if (message.role === "tool_result") {
      const at = toolIndex.get(message.callId);
      const existing = at !== undefined ? blocks[at] : undefined;
      if (existing?.kind === "tool") {
        const rejected = meta?.toolOutcomes?.[message.callId] === "rejected";
        blocks[at!] = {
          ...existing,
          status: rejected ? "rejected" : message.isError ? "failed" : "completed",
          result: message.result,
          isError: message.isError,
        };
      }
    }
  }

  return blocks;
};

/**
 * Whether a block renders visible content. Whitespace-only text blocks (think-tag
 * separators the model emits between rounds) must not occupy layout space — the
 * live view and the persisted view share this rule so they space identically.
 */
export const isRenderableTurnBlock = (block: AiTurnBlock): boolean => !(block.kind === "text" && block.text.trim().length === 0);

/** Stable block id for a tool call — keyed by callId so tool blocks survive attempt bumps. */
export const toolBlockId = (callId: string): string => `tool-${callId}`;

/**
 * Block id for streamed text/thinking content. nessi block ids are only unique
 * within one provider turn, so they are scoped by (attempt, turnIndex).
 */
export const streamBlockId = (attempt: number, turnIndex: number, nessiBlockId: string): string =>
  `a${attempt}-t${turnIndex}-${nessiBlockId}`;

/** Block id for text/thinking blocks rebuilt from a persisted message. */
export const messageBlockId = (messageSeq: number, blockIndex: number): string => `m${messageSeq}-${blockIndex}`;

export const steerMessageBlockId = (steerId: string): string => `steer-message-${steerId}`;
export const steerAppliedBlockId = (steerId: string): string => `steer-applied-${steerId}`;

export type AiActiveTurnSegment =
  | { type: "assistant"; id: string; blocks: AiTurnBlock[] }
  | { type: "steer"; id: string; block: Extract<AiTurnBlock, { kind: "steer_message" }> };

export const splitActiveTurnBlocks = (blocks: AiTurnBlock[]): AiActiveTurnSegment[] => {
  const segments: AiActiveTurnSegment[] = [];
  let assistant: AiTurnBlock[] = [];
  const flush = () => {
    if (assistant.length === 0) return;
    segments.push({ type: "assistant", id: `assistant-${segments.length}-${assistant[0]!.id}`, blocks: assistant });
    assistant = [];
  };
  for (const block of blocks) {
    if (block.kind === "steer_message") {
      flush();
      segments.push({ type: "steer", id: block.id, block });
    } else {
      assistant.push(block);
    }
  }
  flush();
  return segments;
};

const userMessageText = (message: Extract<Message, { role: "user" }>): string =>
  message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => typeof part !== "string" && part.type === "text")
    .map((part) => part.text)
    .join("\n");

export const compactionBlockId = "compaction";
