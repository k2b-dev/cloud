export type LiveWebSocketActivity = "always" | "visible";
export type LiveWebSocketStatus = "connecting" | "open" | "reconnecting" | "paused" | "closed";

export type LiveWebSocketError = {
  code: string;
  message: string;
};

export type LiveWebSocketClose = {
  code: number;
  reason: string;
};

export type LiveWebSocketControls = {
  markApplied: (cursor: string | null | undefined) => void;
  /** Forget an expired cursor before resubscribing from a fresh snapshot. */
  resetCursor: () => void;
  send: (message: unknown) => boolean;
  terminate: (error: LiveWebSocketError, close?: LiveWebSocketClose) => void;
};

export type LiveWebSocketOptions<TMessage> = {
  url: string | (() => string);
  initialCursor?: string | null;
  activity?: LiveWebSocketActivity;
  subscribe: (cursor: string | null) => unknown;
  parse: (raw: string) => TMessage | null;
  onOpen?: (controls: LiveWebSocketControls) => void;
  onMessage: (message: TMessage, controls: LiveWebSocketControls) => void;
  onStatus?: (status: LiveWebSocketStatus) => void;
  onFatal?: (error: LiveWebSocketError) => void;
  classifyClose?: (close: LiveWebSocketClose) => LiveWebSocketError | null;
  reconnect?: Partial<{
    baseDelayMs: number;
    maxDelayMs: number;
    jitterMs: number;
  }>;
};

export type LiveWebSocket = {
  connect: () => void;
  markApplied: (cursor: string | null | undefined) => void;
  /** Forget an expired cursor before resubscribing from a fresh snapshot. */
  resetCursor: () => void;
  send: (message: unknown) => boolean;
  dispose: () => void;
};

const DEFAULT_RECONNECT = {
  baseDelayMs: 750,
  maxDelayMs: 10_000,
  jitterMs: 250,
} as const;

const defaultCloseError = ({ code, reason }: LiveWebSocketClose): LiveWebSocketError | null => {
  if (code === 1008) return { code: reason || "access_denied", message: "Live access changed or expired." };
  if (code === 1011) return { code: reason || "internal_error", message: "Live updates failed." };
  if (code === 1013) return { code: reason || "backpressure", message: "Live updates are overloaded." };
  return null;
};

const socketUrl = (raw: string): string => {
  const url = new URL(raw, window.location.origin);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Live WebSocket URL must use HTTP(S) or WS(S)");
  return url.href;
};

/**
 * Runs a cursor-backed, server-to-browser WebSocket subscription.
 *
 * The app owns its wire protocol, validation, permissions, and domain updates.
 * This helper owns only browser transport lifecycle: one socket, visibility,
 * reconnect backoff, applied-cursor resume, terminal closes, and disposal.
 */
export const createLiveWebSocket = <TMessage>(options: LiveWebSocketOptions<TMessage>): LiveWebSocket => {
  const activity = options.activity ?? "visible";
  const reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
  const classifyClose = options.classifyClose ?? defaultCloseError;

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let lastAppliedCursor = options.initialCursor ?? null;
  let started = false;
  let disposed = false;
  let terminated = false;
  let fatalSent = false;
  let status: LiveWebSocketStatus | null = null;

  const setStatus = (next: LiveWebSocketStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const clearReconnect = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const markApplied = (cursor: string | null | undefined) => {
    if (cursor) lastAppliedCursor = cursor;
  };

  const resetCursor = () => {
    lastAppliedCursor = null;
  };

  const send = (message: unknown): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN || disposed || terminated) return false;
    try {
      const payload = JSON.stringify(message);
      if (payload === undefined) return false;
      socket.send(payload);
      return true;
    } catch {
      return false;
    }
  };

  const closeSocket = (code = 1000, reason = "") => {
    const current = socket;
    socket = null;
    if (!current || current.readyState > WebSocket.OPEN) return;
    try {
      current.close(code, reason);
    } catch {
      // The browser already discarded the connection.
    }
  };

  const fatal = (error: LiveWebSocketError, close: LiveWebSocketClose = { code: 1008, reason: error.code }) => {
    if (terminated) return;
    terminated = true;
    clearReconnect();
    closeSocket(close.code, close.reason);
    setStatus("closed");
    if (!fatalSent) {
      fatalSent = true;
      options.onFatal?.(error);
    }
  };

  const controls: LiveWebSocketControls = {
    markApplied,
    resetCursor,
    send,
    terminate: fatal,
  };

  const browserAvailable = () => typeof window !== "undefined" && typeof document !== "undefined" && typeof WebSocket !== "undefined";
  const isActive = () => browserAvailable() && (activity === "always" || document.visibilityState === "visible");

  const scheduleReconnect = () => {
    if (disposed || terminated || !started || !isActive() || reconnectTimer) return;
    setStatus("reconnecting");
    const exponential = Math.min(reconnect.maxDelayMs, reconnect.baseDelayMs * 2 ** reconnectAttempt);
    const delay = exponential + Math.floor(Math.random() * reconnect.jitterMs);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  };

  const openSocket = () => {
    if (disposed || terminated || !started || socket) return;
    if (!browserAvailable()) {
      fatal({ code: "unsupported", message: "Live WebSockets are not available in this browser" });
      return;
    }
    if (!isActive()) return;

    let next: WebSocket;
    setStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");
    try {
      next = new WebSocket(socketUrl(typeof options.url === "function" ? options.url() : options.url));
    } catch (error) {
      fatal({ code: "invalid_url", message: error instanceof Error ? error.message : "Invalid live WebSocket URL" });
      return;
    }
    socket = next;

    next.onopen = () => {
      if (socket !== next || disposed || terminated) return;
      try {
        if (!send(options.subscribe(lastAppliedCursor))) throw new Error("Live WebSocket subscription could not be sent");
        setStatus("open");
        options.onOpen?.(controls);
      } catch (error) {
        fatal({ code: "subscribe_failed", message: error instanceof Error ? error.message : "Live subscription failed" });
      }
    };

    next.onmessage = (event) => {
      if (socket !== next || typeof event.data !== "string" || disposed || terminated) return;
      try {
        const message = options.parse(event.data);
        if (message) {
          options.onMessage(message, controls);
          reconnectAttempt = 0;
        }
      } catch (error) {
        fatal(
          { code: "client_handler_failed", message: error instanceof Error ? error.message : "Live update handling failed" },
          { code: 1011, reason: "client_handler_failed" },
        );
      }
    };

    next.onclose = (event) => {
      if (socket !== next) return;
      socket = null;
      if (disposed || terminated) return;
      const closeError = classifyClose({ code: event.code, reason: event.reason.trim() });
      if (closeError) fatal(closeError, { code: event.code, reason: event.reason });
      else scheduleReconnect();
    };

    next.onerror = () => {
      try {
        next.close();
      } catch {
        if (socket === next) {
          socket = null;
          scheduleReconnect();
        }
      }
    };
  };

  const syncVisibility = () => {
    if (isActive()) openSocket();
    else {
      clearReconnect();
      closeSocket(1000, "inactive");
      setStatus("paused");
    }
  };

  return {
    connect: () => {
      if (started || disposed || terminated) return;
      started = true;
      if (!browserAvailable()) {
        fatal({ code: "unsupported", message: "Live WebSockets are not available in this browser" });
        return;
      }
      if (activity === "visible") document.addEventListener("visibilitychange", syncVisibility);
      openSocket();
    },
    markApplied,
    resetCursor,
    send,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearReconnect();
      if (activity === "visible" && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", syncVisibility);
      }
      closeSocket();
      setStatus("closed");
    },
  };
};
