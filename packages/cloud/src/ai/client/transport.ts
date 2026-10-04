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

/**
 * Why a conversation stream ended for good. The codes match the live
 * WebSocket's turn errors and revocations.
 */
export type AiStreamErrorCode = "login_required" | "access_denied" | "not_found";

/** A stream that will not recover by reconnecting; `message` comes from the server when it sent one. */
export class AiStreamError extends Error {
  readonly code: AiStreamErrorCode;

  constructor(code: AiStreamErrorCode, message: string) {
    super(message);
    this.name = "AiStreamError";
    this.code = code;
  }
}

const TERMINAL_STATUS_CODES: Readonly<Record<number, AiStreamErrorCode>> = {
  401: "login_required",
  403: "access_denied",
  404: "not_found",
};

const terminalStreamError = async (response: Response, code: AiStreamErrorCode): Promise<AiStreamError> => {
  const body: unknown = await response.json().catch(() => null);
  const message =
    body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message
      ? body.message
      : `AI stream failed: ${response.status}`;
  return new AiStreamError(code, message);
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** Parse an SSE byte stream into decoded data payloads. */
export async function* parseAiSse(response: Response, signal: AbortSignal): AsyncGenerator<AiStreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
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
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Subscribe to a conversation's SSE stream with automatic reconnect. Each
 * (re)connect starts with a fresh `state` event, so the projection self-heals on
 * every reconnect without cursor bookkeeping. A 401, 403, or 404 cannot heal
 * that way: the subscription stops and reports an `AiStreamError` once.
 */
export const subscribeAiStream = (input: {
  url: string;
  onEvent: (event: AiStreamEvent) => void;
  onStatus?: (status: AiStreamConnectionStatus) => void;
  onError?: (error: AiStreamError) => void;
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
        if (stopped) return;
        const terminalCode = TERMINAL_STATUS_CODES[response.status];
        if (terminalCode) {
          // The connect timeout still bounds reading the error body.
          const error = await terminalStreamError(response, terminalCode);
          if (stopped) return;
          stopped = true;
          input.onError?.(error);
          return;
        }
        clearConnectTimer();
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
  subscribe: ({ url, onEvent, onStatus, onError }) => subscribeAiStream({ url, onEvent, onStatus, onError }),
};
