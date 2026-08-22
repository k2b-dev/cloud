import {
  createLiveWebSocket,
  type LiveWebSocket,
  type LiveWebSocketClose,
  type LiveWebSocketError,
  type LiveWebSocketStatus,
} from "../../browser/live-websocket";
import { AI_LIVE_WS_TYPE, type AiLiveServerMessage, parseAiLiveServerMessage } from "../live-events";
import type { AiConversationStreamTransport, AiStreamConnectionStatus } from "./transport";

type TurnSubscription = {
  conversationId: string;
  generation: number;
  onEvent: Parameters<AiConversationStreamTransport["subscribe"]>[0]["onEvent"];
  onStatus?: Parameters<AiConversationStreamTransport["subscribe"]>[0]["onStatus"];
  onError?: Parameters<AiConversationStreamTransport["subscribe"]>[0]["onError"];
};

export type AiLiveConnection = {
  connect: () => void;
  markApplied: (cursor: string | null | undefined) => void;
  streamTransport: AiConversationStreamTransport;
  dispose: () => void;
};

export type CreateAiLiveConnectionOptions = {
  url?: string;
  initialCursor: string;
  onLiveMessage: (message: AiLiveServerMessage) => void;
  onLiveStatus?: (status: LiveWebSocketStatus) => void;
  onFatal?: (error: LiveWebSocketError) => void;
};

const reconnectableAiClose = (close: LiveWebSocketClose): LiveWebSocketError | null =>
  close.code === 1008 ? { code: close.reason || "access_denied", message: "Live access changed or expired." } : null;

const streamStatus = (status: LiveWebSocketStatus): AiStreamConnectionStatus | null => {
  if (status === "connecting" || status === "reconnecting") return status;
  if (status === "paused") return "reconnecting";
  return null;
};

/** One browser connection for AI invalidations and the currently visible turn. */
export const createAiLiveConnection = (options: CreateAiLiveConnectionOptions): AiLiveConnection => {
  let socket: LiveWebSocket;
  let turn: TurnSubscription | null = null;
  let turnGeneration = 0;
  let connected = false;
  let disposed = false;
  let liveSubscribeCount = 0;

  const sendTurnSubscription = () => {
    if (!connected || !turn) return;
    if (
      !socket.send({
        type: AI_LIVE_WS_TYPE.turnSubscribe,
        payload: { conversationId: turn.conversationId },
      })
    ) {
      turn.onStatus?.("reconnecting");
    }
  };

  socket = createLiveWebSocket<AiLiveServerMessage>({
    url: options.url ?? "/api/ai/live",
    initialCursor: options.initialCursor,
    subscribe: (cursor) => ({
      type: AI_LIVE_WS_TYPE.subscribe,
      payload: { fromCursor: cursor, recover: liveSubscribeCount++ > 0 },
    }),
    parse: parseAiLiveServerMessage,
    classifyClose: reconnectableAiClose,
    onOpen: sendTurnSubscription,
    onStatus: (status) => {
      connected = status === "open";
      options.onLiveStatus?.(status);
      const next = streamStatus(status);
      if (next) turn?.onStatus?.(next);
    },
    onMessage: (message) => {
      if (message.type === AI_LIVE_WS_TYPE.turnEvent) {
        if (!turn || turn.conversationId !== message.payload.conversationId) return;
        if (message.payload.event.type === "state") turn.onStatus?.("open");
        turn.onEvent(message.payload.event);
        return;
      }
      if (message.type === AI_LIVE_WS_TYPE.turnError) {
        if (!turn || turn.conversationId !== message.payload.conversationId) return;
        const current = turn;
        turn = null;
        current.onError?.(new Error(message.payload.message));
        return;
      }
      options.onLiveMessage(message);
    },
    onFatal: (error) => {
      connected = false;
      const current = turn;
      turn = null;
      current?.onError?.(new Error(error.message));
      options.onFatal?.(error);
    },
  });

  const streamTransport: AiConversationStreamTransport = {
    subscribe: ({ conversationId, onEvent, onStatus, onError }) => {
      const generation = ++turnGeneration;
      const subscription: TurnSubscription = { conversationId, generation, onEvent, onStatus, onError };
      turn = subscription;
      onStatus?.("connecting");
      sendTurnSubscription();
      return {
        close: () => {
          if (turn?.generation !== generation) return;
          turn = null;
          if (connected) {
            socket.send({
              type: AI_LIVE_WS_TYPE.turnUnsubscribe,
              payload: { conversationId },
            });
          }
        },
      };
    },
  };

  return {
    connect: () => {
      if (!disposed) socket.connect();
    },
    markApplied: (cursor) => socket.markApplied(cursor),
    streamTransport,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      turn = null;
      socket.dispose();
    },
  };
};
