import type { AiStreamEvent } from "../protocol";

export type AiStreamHandle = { close: () => void };
export type AiStreamFetch = (url: string, init: RequestInit) => Promise<Response>;
export type AiStreamConnectionStatus = "connecting" | "open" | "reconnecting";
export type AiConversationStreamTransport = {
  subscribe: (input: {
    conversationId: string;
    url: string;
    onEvent: (event: AiStreamEvent) => void;
    onStatus?: (status: AiStreamConnectionStatus) => void;
    onError?: (error: Error) => void;
  }) => AiStreamHandle;
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** Parse an SSE byte stream into decoded data payloads. */
export async function* parseAiSse(response: Response, signal: AbortSignal): AsyncGenerator<AiStreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as AiStreamEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Subscribe to a conversation's SSE stream with automatic reconnect. Each
 * (re)connect starts with a fresh `state` event, so the projection self-heals on
 * every reconnect without cursor bookkeeping.
 */
export const subscribeAiStream = (input: {
  url: string;
  onEvent: (event: AiStreamEvent) => void;
  onStatus?: (status: AiStreamConnectionStatus) => void;
  fetch?: AiStreamFetch;
}): AiStreamHandle => {
  const fetchStream: AiStreamFetch = input.fetch ?? fetch;
  let reconnectDelay = RECONNECT_BASE_MS;
  let stopped = false;
  let activeAttempt: AbortController | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearConnectTimer = () => {
    if (connectTimer !== null) clearTimeout(connectTimer);
    connectTimer = null;
  };

  const loop = async () => {
    while (!stopped) {
      const attempt = new AbortController();
      activeAttempt = attempt;
      connectTimer = setTimeout(() => attempt.abort(), CONNECT_TIMEOUT_MS);
      try {
        input.onStatus?.(reconnectDelay === RECONNECT_BASE_MS ? "connecting" : "reconnecting");
        const response = await fetchStream(input.url, { signal: attempt.signal, headers: { Accept: "text/event-stream" } });
        clearConnectTimer();
        if (stopped) return;
        if (!response.ok || !response.body) throw new Error(`AI stream failed: ${response.status}`);
        input.onStatus?.("open");
        reconnectDelay = RECONNECT_BASE_MS;
        for await (const event of parseAiSse(response, attempt.signal)) {
          if (stopped) break;
          input.onEvent(event);
        }
      } catch {
        if (stopped) return;
      } finally {
        clearConnectTimer();
        if (activeAttempt === attempt) activeAttempt = null;
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }
  };

  void loop();
  return {
    close: () => {
      stopped = true;
      clearConnectTimer();
      activeAttempt?.abort();
      activeAttempt = null;
    },
  };
};

export const aiSseConversationStreamTransport: AiConversationStreamTransport = {
  subscribe: ({ url, onEvent, onStatus }) => subscribeAiStream({ url, onEvent, onStatus }),
};
