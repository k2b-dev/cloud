import type { AiStreamSseEvent, AiTurnBlock, AiTurnSnapshot, AiWireEvent } from "../protocol";
import { applyWireEventToBlocks, isNewerWireEvent, reconcileResolvedTurnActions, toolBlockId } from "../protocol";
import type { AiConversation, AiStoredMessage } from "../types";

export type AiActiveTurn = {
  turnId: string;
  attempt: number;
  seq: number;
  status: "running" | "waiting_for_action";
  blocks: AiTurnBlock[];
  modelProfileId: string | null;
};

export type AiChatProjection = {
  conversation: AiConversation | null;
  messages: AiStoredMessage[];
  activeTurn: AiActiveTurn | null;
};

export const emptyProjection = (conversation: AiConversation | null = null): AiChatProjection => ({
  conversation,
  messages: [],
  activeTurn: null,
});

const mergeMessages = (existing: AiStoredMessage[], incoming: AiStoredMessage[]): AiStoredMessage[] => {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
};

/** A turn is "waiting" when any of its tool blocks is awaiting a user action. */
const deriveStatus = (blocks: AiTurnBlock[]): "running" | "waiting_for_action" =>
  blocks.some((block) => block.kind === "tool" && (block.status === "awaiting_approval" || block.status === "awaiting_client"))
    ? "waiting_for_action"
    : "running";

const overlayBlocks = (base: AiTurnBlock[], overlay: AiTurnBlock[]): AiTurnBlock[] => {
  const next = [...base];
  const indexById = new Map(next.map((block, index) => [block.id, index]));
  for (const block of overlay) {
    const index = indexById.get(block.id);
    if (index === undefined) {
      indexById.set(block.id, next.length);
      next.push(block);
    } else {
      next[index] = block;
    }
  }
  return next;
};

const normalizeCustomApprovalBlocks = (blocks: AiTurnBlock[]): AiTurnBlock[] => {
  const normalized: AiTurnBlock[] = [];
  const indexById = new Map<string, number>();
  for (const block of blocks) {
    const parentCallId =
      block.kind === "tool" && block.status === "awaiting_approval" ? /^(.*)-approval-\d+$/.exec(block.callId)?.[1] : undefined;
    const next = parentCallId ? { ...block, id: toolBlockId(parentCallId) } : block;
    const index = indexById.get(next.id);
    if (index === undefined) {
      indexById.set(next.id, normalized.length);
      normalized.push(next);
    } else {
      normalized[index] = next;
    }
  }
  return normalized;
};

/** Never let a same-turn DB/SSE snapshot remove blocks the browser already observed. */
export const mergeActiveTurn = (previous: AiActiveTurn | null, incoming: AiActiveTurn | null): AiActiveTurn | null => {
  if (!previous || !incoming || previous.turnId !== incoming.turnId) return incoming;
  if (previous.attempt !== incoming.attempt) return incoming.attempt > previous.attempt ? incoming : previous;

  const incomingIsNewer = incoming.seq >= previous.seq;
  const blocks = incomingIsNewer ? overlayBlocks(previous.blocks, incoming.blocks) : overlayBlocks(incoming.blocks, previous.blocks);
  return {
    ...(incomingIsNewer ? incoming : previous),
    seq: Math.max(previous.seq, incoming.seq),
    blocks,
    status: deriveStatus(blocks),
  };
};

export const reconcileActiveTurnActions = (
  turn: AiActiveTurn,
  actions: Parameters<typeof reconcileResolvedTurnActions>[1],
): AiActiveTurn => {
  const blocks = reconcileResolvedTurnActions(turn.blocks, actions);
  return blocks === turn.blocks ? turn : { ...turn, blocks, status: deriveStatus(blocks) };
};

/** Convert a server turn snapshot into a live active-turn (queued turns count as running). */
export const activeTurnFromSnapshot = (snapshot: AiTurnSnapshot | null): AiActiveTurn | null => {
  if (!snapshot) return null;
  if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "aborted") return null;
  return {
    turnId: snapshot.turnId,
    attempt: snapshot.attempt,
    seq: snapshot.seq,
    status: snapshot.status === "waiting_for_action" ? "waiting_for_action" : "running",
    blocks: normalizeCustomApprovalBlocks(snapshot.blocks),
    modelProfileId: snapshot.modelProfileId,
  };
};

/**
 * Fold one stream event into the projection. Pure and total: the client and any
 * test converge on the same state for the same ordered event sequence.
 *
 * Rules:
 * - `state` replaces everything (reconnect baseline).
 * - `turn_started` atomically installs the attempt's ordered block baseline;
 *   stale attempts are ignored. Older senders without a baseline reset to only
 *   locally pending steering blocks.
 * - block events apply only when strictly newer than the active turn's cursor.
 * - `turn_finished` folds the turn's persisted messages in and clears the active turn.
 */
export const reduceProjection = (state: AiChatProjection, event: AiStreamSseEvent): AiChatProjection => {
  if (event.type === "state") {
    // The snapshot only carries the newest window. History the client already
    // paged in (older than the window) must survive a reconnect — losing the
    // scrollback under the reader would be unpredictable.
    const windowOldest = event.messages[0]?.seq;
    const sameConversation = state.conversation?.id === event.conversation.id;
    const preservedOlder =
      sameConversation && windowOldest !== undefined ? state.messages.filter((message) => message.seq < windowOldest) : [];
    return {
      conversation: event.conversation,
      messages: [...preservedOlder, ...event.messages],
      activeTurn: mergeActiveTurn(sameConversation ? state.activeTurn : null, activeTurnFromSnapshot(event.activeTurn)),
    };
  }

  return reduceWireEvent(state, event);
};

export const reduceWireEvent = (state: AiChatProjection, event: AiWireEvent): AiChatProjection => {
  const active = state.activeTurn;

  if (event.type === "turn_started") {
    if (active && active.turnId === event.turnId && event.attempt < active.attempt) return state;
    const pendingSteers =
      active?.turnId === event.turnId ? active.blocks.filter((block) => block.kind === "steer_message" && block.status !== "consumed") : [];
    const blocks = event.blocks ? overlayBlocks(normalizeCustomApprovalBlocks(event.blocks), pendingSteers) : pendingSteers;
    return {
      ...state,
      activeTurn: {
        turnId: event.turnId,
        attempt: event.attempt,
        seq: event.seq,
        status: deriveStatus(blocks),
        blocks,
        modelProfileId: event.modelProfileId,
      },
    };
  }

  if (event.type === "turn_finished") {
    if (!active || active.turnId !== event.turnId) return state;
    return { ...state, messages: mergeMessages(state.messages, event.messages ?? []), activeTurn: null };
  }

  // block_set / block_delta
  if (!active || active.turnId !== event.turnId) return state;
  if (!isNewerWireEvent(event, active)) return state;
  const blocks = applyWireEventToBlocks(active.blocks, event);
  return { ...state, activeTurn: { ...active, attempt: event.attempt, seq: event.seq, blocks, status: deriveStatus(blocks) } };
};

/** Assistant/tool messages of the active turn are represented by live blocks; hide them. */
export const visibleMessages = (state: AiChatProjection): AiStoredMessage[] => {
  const activeTurnId = state.activeTurn?.turnId;
  if (!activeTurnId) return state.messages;
  return state.messages.filter((message) => message.loopId !== activeTurnId || (message.message.role === "user" && !message.meta?.steerId));
};
